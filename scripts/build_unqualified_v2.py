#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
重建 data/unqualified_v2.json（「巡检问题汇总及整改跟进」板块唯一数据源）。

数据来源（全部本地，无需登录）：
  data/details/<TYP>_<rid>.json   逐份报告明细（raw.notcategoryList = 不合格项）
  data/unqualified_v2.json        旧文件 —— 仅用于继承 AI 条目与 skippedAiTest（AI 报告无本地明细管线）

输出 schema 与 v2/app.js 前端完全对齐：
  types.CG/ZJ/SP/AI.entries[]  {rid,sn,sc,d,cat,t,desc,img:[{u,ts}],rg,ps}
  cgCompare[]                  {sn,rg,ps,pd,cd,pu,cu,delta,verdict,repeated,regressed,improved}
  rectify[]                    {typ,rid,sn,rg,ps,d,total,done}

要点：
  - fix148：commitImgUploadTime 按逗号拆分与 commitImgurl 逐张配对
  - fix123：剥离照片 URL 的 OSS 压缩参数，保留原始图
  - fix205：cgCompare 对比链剔除自检报告（手动标记 + 直营自检表模板），只对比真实巡检
  - 每次运行全量重建（脚本幂等），由每日管线在 collect_raw 之后调用
"""
import glob
import json
import os
import re
import sys
from datetime import datetime, timedelta

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根
DETAIL_DIR = os.path.join(BASE, "data", "details")
OUT_PATH = os.path.join(BASE, "data", "unqualified_v2.json")

# fix187：无单判定需要整改单实时接口，登录态注入方式与 2b2（refresh_rectify_details）一致
PIPE = os.path.join(os.path.dirname(BASE), "慧运营看板自动更新")
sys.path.insert(0, PIPE)
import auto_update_daily  # noqa: F401,E402  模块层注入 HY_* 凭证
import requests  # noqa: E402
import hhy_api  # noqa: E402

TYPES = ("CG", "ZJ", "SP")

# fix205：巡检变化对比只串「真实巡检」——自检报告不入对比链（口径与前端 fix195/fix203 一致）：
#   ① 手动标记：data/selfCheckMarks.json marks 键「rid:<rid>」（key=888 页面勾选）
#   ② 直营自检表模板：明细 raw.templateId == 10000001677588（QSC常规巡检·直营自检表）
# 自检是门店日常行为，串进链里会产出「自检→自检」「同日 9/22→9/22」等无效对比。
SELF_CHECK_TPL_ID = "10000001677588"

RAW_SN_MAP = {}  # rid -> 门店名（从 raw 月度汇总反查，兜底历史明细文件缺 storeName）
RAW_NL_MAP = {}  # rid -> 组织路径（raw 月度汇总 nl 字段，fix182 区域兜底）


def load_raw_maps():
    """扫 raw 月度汇总建两张反查表：
    ① rid->sn：部分历史明细文件（如 9/06 一次性脚本所抓的 21 份）顶层无 storeName，
       导致板块按门店分组时出现「-」卡片，反查兜底。
    ② rid->nl：明细 raw.nameLink 对 ZJ（门店自检）恒为 '总部'，无区域信息（fix182），
       用月度汇总的 nl（检查人组织路径，如 '总经办/加盟服务部/新店运营组/陈晓君区域'）兜底。"""
    RAW_SN_MAP.clear()
    RAW_NL_MAP.clear()
    raw_dir = os.path.join(BASE, "data", "raw")
    if not os.path.isdir(raw_dir):
        return
    for fp in glob.glob(os.path.join(raw_dir, "*.json")):
        if os.path.basename(fp) == "index.json":
            continue
        try:
            j = json.load(open(fp, encoding="utf-8"))
        except Exception:
            continue
        for g in (j.get("positions") or {}).values():
            for t in ("cg", "zj", "sp"):
                for r in g.get(t, []) or []:
                    rid = str(r.get("rid") or "")
                    if not rid:
                        continue
                    sn = (r.get("sn") or "").strip()
                    if sn and rid not in RAW_SN_MAP:
                        RAW_SN_MAP[rid] = sn
                    nl = (r.get("nl") or "").strip()
                    if nl and rid not in RAW_NL_MAP:
                        RAW_NL_MAP[rid] = nl


def parse_nl(nl):
    """组织路径 → (区域rg, 组别ps)。'总经办/加盟服务部/加盟营运组/赖先晓区域' → ('赖先晓区域','加盟营运组')"""
    if not nl or not isinstance(nl, str):
        return "", ""
    # fix182：多检查人路径会用「、」拼接（'.../超级加盟商、.../谢艺坤区域'），先取首段再解析
    nl = nl.split("、")[0]
    parts = [p for p in nl.split("/") if p]
    if not parts:
        return "", ""
    rg = parts[-1]
    ps = parts[-2] if len(parts) >= 2 else ""
    return rg, ps


def norm_img_url(u):
    """fix123/fix151：剥 OSS 签名参数（防 GitHub Push Protection），保留 x-oss-process 缩略参数
    并确保首参数用 '?' 分隔。fix151 修复：旧版 split('?')[0] 对已被坏剥离的 URL
    （xxx.jpg&x-oss-process=... 缺问号）无能为力，坏 URL 直接入库致全站图片 404。"""
    if not isinstance(u, str):
        return ""
    import re as _re
    u = u.strip()
    for pat in (_re.compile(r'[?&]Expires=\d+'),
                _re.compile(r'[?&]OSSAccessKeyId=[^&"\' ]+'),
                _re.compile(r'[?&]Signature=[^&"\' ]+')):
        u = pat.sub('', u)
    return _re.compile(r'(?<!\?)&x-oss-process=').sub('?x-oss-process=', u)


def item_photos(it):
    """commitImgurl 与 commitImgUploadTime 逐张配对（fix148）。"""
    urls = it.get("commitImgurl") or []
    if isinstance(urls, str):
        urls = [urls] if urls else []
    times = it.get("commitImgUploadTime") or ""
    tlist = [t.strip() for t in str(times).split(",")] if times else []
    photos = []
    for i, u in enumerate(urls):
        nu = norm_img_url(u)
        if not nu:
            continue
        photos.append({"u": nu, "ts": tlist[i] if i < len(tlist) else ""})
    return photos


def to_date(s):
    if not s:
        return ""
    return str(s)[:10]


ORDER_API = "https://hyygrayapi.ruipos.com/web/ri/item/list"


def fetch_order_rids(days=95):
    """fix187：整改单实时接口全量翻页 → 有整改单的 reportId 集合。
    背景（正佳 9/1 实锤）：明细 isCorrected=0 ≠ 存在整改单——慧运营不为部分
    不合格项生成整改单，此类项在看板显示「待整改」永远无法闭环，且后台根本查不到。
    失败返回 (set(), False)：调用方必须跳过无单判定，绝不因本功能挂掉整条重建。"""
    try:
        tok = hhy_api.login()
        if isinstance(tok, dict):
            tok = tok.get("token") or (tok.get("data") or {}).get("token")
        S = requests.Session()
        S.headers.update({
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Origin": "https://hyygray.ruipos.com",
            "Referer": "https://hyygray.ruipos.com/rectificationList",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
            "accept-language": "zh-CN,zh;q=0.9",
            "ent": "cjss",
            "timeZone": "Asia/Shanghai",
            "token": tok,
        })
        start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        end = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        rids, page = set(), 1
        while True:
            j = S.post(ORDER_API + "?version=1", json={
                "pageNumber": page, "pageSize": 200, "sortField": "createTime",
                "sortOrder": "desc", "startDate": start, "endDate": end}, timeout=30).json()
            lst = j.get("data") or []
            for it in lst:
                rid = str(it.get("reportId") or "")
                if rid:
                    rids.add(rid)
            if j.get("isLastPage") or not lst or page > 100:
                break
            page += 1
        print(f"[fix187] 整改单接口拉取成功：{page} 页，{len(rids)} 份报告有整改单")
        return rids, True
    except Exception as e:
        print(f"[fix187][WARN] 整改单接口拉取失败，本轮跳过无单判定: {e}")
        return set(), False


def extract_report(fp):
    """读取一份明细文件 → (report_meta, unq_items) ；无不合格项时 items 为空。"""
    try:
        j = json.load(open(fp, encoding="utf-8"))
    except Exception as e:
        print(f"[skip] {os.path.basename(fp)}: {e}")
        return None, []
    det = j.get("detail") or {}
    raw = det.get("raw") or {}
    typ = (det.get("planType") or os.path.basename(fp).split("_")[0]).upper()
    rid = str(raw.get("reportId") or det.get("reportId") or "")
    if not rid:
        return None, []
    sn = raw.get("storeName") or det.get("storeName") or RAW_SN_MAP.get(rid, "")
    d = to_date(raw.get("reportDate") or det.get("reportDate"))
    # fix182：ZJ（门店自检）明细 raw.nameLink 恒为 '总部'（报告归属部门，无区域信息），
    # 曾致整改追踪表区域列 325 行全显示「总部」。三层取值：
    #   nameLink(≥2段) → creatorNameLink → raw月度汇总 nl 反查。
    # CG 两字段一致不受影响；SP 的 nameLink 为 3 段（…/加盟营运组）保持原判。
    nl1 = raw.get("nameLink") or ""
    rg, ps = parse_nl(nl1)
    if len([p for p in nl1.split("/") if p]) < 2:
        rg2, ps2 = parse_nl(raw.get("creatorNameLink") or "")
        if rg2:
            rg, ps = rg2, ps2
    if (not rg or rg == "总部") and rid in RAW_NL_MAP:
        rg2, ps2 = parse_nl(RAW_NL_MAP[rid])
        if rg2 and rg2 != "总部":
            rg, ps = rg2, ps2
    sc = str(raw.get("storeCode") or "")
    meta = {"typ": typ, "rid": rid, "sn": sn, "sc": sc, "d": d, "rg": rg, "ps": ps,
            "tid": str(raw.get("templateId") or "")}  # fix205：模板 id 随 meta 透出供对比链剔除自检
    items = []
    for cat in raw.get("notcategoryList") or []:
        cname = cat.get("categoryName") or ""
        for it in cat.get("itemList") or []:
            if it.get("isQualified"):
                continue  # 只要不合格项
            items.append({
                "cat": cname or (it.get("categoryName") or ""),
                "t": it.get("title") or "",
                "desc": it.get("disQualifiedDesc") or "",
                "img": item_photos(it),
                "st": it.get("isCorrected"),  # fix186：整改状态随条目透出（0未整改/1已整改/2待审核）
                "corrected": it.get("isCorrected") == 1,  # fix185：isCorrected 三态 0未整改/1已整改/2待审核，仅1算已整改
            })
    # fix179：部分明细（尤其 ZJ 打烊/开店检查新模板）notcategoryList 为空，
    # 不合格项只存在 categoryList.itemList（isQualified=False）。兜底提取，避免整份报告漏条目。
    if not items:
        for cat in raw.get("categoryList") or []:
            cname = cat.get("categoryName") or ""
            for it in cat.get("itemList") or []:
                q = it.get("isQualified")
                if q is not False and str(q).strip().lower() != "false":
                    continue  # 只取明确不合格；未点评(None)不算
                items.append({
                    "cat": cname or (it.get("categoryName") or ""),
                    "t": it.get("title") or "",
                    "desc": it.get("disQualifiedDesc") or "",
                    "img": item_photos(it),
                    "st": it.get("isCorrected"),  # fix186：整改状态随条目透出（0未整改/1已整改/2待审核）
                    "corrected": it.get("isCorrected") == 1,  # fix185：isCorrected 三态 0未整改/1已整改/2待审核，仅1算已整改
                })
    return meta, items


def load_selfcheck_marks():
    """fix205：读 fix195 手动自检标记（键格式 rid:<rid>）。文件缺失/损坏返回空集（不阻断重建）。"""
    try:
        j = json.load(open(os.path.join(BASE, "data", "selfCheckMarks.json"), encoding="utf-8"))
        return set((j.get("marks") or {}).keys())
    except Exception:
        return set()


def main():
    load_raw_maps()
    files = sorted(glob.glob(os.path.join(DETAIL_DIR, "*.json")))
    reports = {}
    for fp in files:
        meta, items = extract_report(fp)
        if not meta:
            continue
        reports[(meta["typ"], meta["rid"])] = (meta, items)

    # ---- fix190：报告归属统一按门店组织 ----
    # 背景（9/18 用户实测）：SP 视频巡检由总部督导执行，fix182 三层取到的是督导组织
    # （rg=加盟营运组 ps=加盟服务部），致同一家店的行散落到督导组——黄圃（直营组·培训组）
    # 的视频巡检未完成项，在整改追踪筛「培训组/直营组」都看不到，与门店清单（按门店
    # 组织分组）对不上，用户质疑两边数据矛盾。
    # 规则：以库内 CG/ZJ 行（店长提交=门店组织）的众数为该店归属，覆盖 SP 行 rg/ps；
    # 库内无该店 CG/ZJ 行的（极少）保持原值。entries/rectify/cgCompare 均继承 meta，自动生效。
    from collections import Counter as _Counter
    sn_org_cnt = {}
    for (_t, _rid), (meta, _items) in reports.items():
        if meta["typ"] in ("CG", "ZJ") and meta["sn"] and meta["rg"]:
            sn_org_cnt.setdefault(meta["sn"], _Counter())[(meta["rg"], meta["ps"])] += 1
    sn_org = {sn: c.most_common(1)[0][0] for sn, c in sn_org_cnt.items()}
    n_fix190 = 0
    for (_t, _rid), (meta, _items) in reports.items():
        if meta["typ"] == "SP" and meta["sn"] in sn_org and (meta["rg"], meta["ps"]) != sn_org[meta["sn"]]:
            meta["rg"], meta["ps"] = sn_org[meta["sn"]]
            n_fix190 += 1
    print(f"[fix190] 门店归属统一：{len(sn_org)} 家店有 CG/ZJ 基准，SP 行改判 {n_fix190} 份")

    # ---- fix187：整改单存在性核验 ----
    # 报告日 ≤ 今天-2（出单最长约 1 天，留 2 天窗口）且整改单接口无此报告的 rid
    # → 该报告内 st=0 的项改标 st=3（无整改单）。st=1/st=2 不动（待审核预期不出单）。
    order_rids, order_ok = fetch_order_rids()
    n_st3 = 0
    if order_ok:
        cutoff = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")
        for (_t, _rid), (meta, items) in reports.items():
            if not items or not meta["d"] or meta["d"] > cutoff:
                continue
            if meta["rid"] in order_rids:
                continue
            for it in items:
                if it.get("st") == 0:
                    it["st"] = 3
                    n_st3 += 1
        n_rep3 = sum(1 for _m, its in reports.values() if any(x.get("st") == 3 for x in its))
        print(f"[fix187] 无整改单项标 st=3：{n_st3} 条，涉及 {n_rep3} 份报告")

    # ---- 继承旧文件的 AI 条目（AI 无本地明细管线，保持原样） ----
    old = {}
    if os.path.exists(OUT_PATH):
        try:
            old = json.load(open(OUT_PATH, encoding="utf-8"))
        except Exception:
            old = {}
    ai_entries = ((old.get("types") or {}).get("AI") or {}).get("entries") or []
    skipped_ai_test = old.get("skippedAiTest", 0)

    # ---- entries ----
    types = {}
    for typ in TYPES:
        ents = []
        for (t, _rid), (meta, items) in reports.items():
            if t != typ:
                continue
            for it in items:
                ents.append({
                    "rid": meta["rid"], "sn": meta["sn"], "sc": meta["sc"],
                    "d": meta["d"], "cat": it["cat"], "t": it["t"],
                    "desc": it["desc"], "img": it["img"],
                    "st": it.get("st"),  # fix186：整改状态随条目透出（0未整改/1已整改/2待审核）
                    "rg": meta["rg"], "ps": meta["ps"],
                })
        ents.sort(key=lambda x: (x["d"], x["rid"]))
        types[typ] = {"entries": ents}
    types["AI"] = {"entries": ai_entries}

    # ---- rectify：每份有不合格项的报告一行 {typ,rid,sn,rg,ps,d,total,done} ----
    rectify = []
    for (t, _rid), (meta, items) in sorted(reports.items(), key=lambda kv: (kv[1][0]["d"], kv[0][0])):
        if not items:
            continue
        n3 = sum(1 for it in items if it.get("st") == 3)  # fix187：无整改单项不计入应整改/待整改
        total_n = len(items) - n3
        if total_n <= 0:
            continue  # 整份报告无整改单（如正佳 9/1），整改追踪不显示该行
        rectify.append({
            "typ": t, "rid": meta["rid"], "sn": meta["sn"],
            "rg": meta["rg"], "ps": meta["ps"], "d": meta["d"],
            "total": total_n,
            "done": sum(1 for it in items if it["corrected"]),
            "open": sum(1 for it in items if it.get("st") == 0),  # fix186：待整改数
            "rev": sum(1 for it in items if it.get("st") == 2),   # fix186：待审核数（门店已提交待督导审核，与待整改同计未完成）
        })

    # ---- cgCompare：同店相邻两次常规巡检对比 ----
    # fix205：自检报告不入对比链（①手动标记 ②直营自检表模板）——对比只反映真实巡检变化
    # fix207：每店只输出最新一次配对（lst[-2]→lst[-1]），并按本次日期倒序——
    #   此前输出全部历史相邻配对且按旧→新排序，最新巡检的对比卡被压在旧卡后面，
    #   被误读为「对比没更新」（9/24 用户反馈 9/22 五家直营店复巡看不到变化）
    sc_marks = load_selfcheck_marks()
    cg = []
    n_sc_skip = 0
    for (t, _rid), (meta, items) in reports.items():
        if t != "CG" or not meta["d"]:
            continue
        if ("rid:" + meta["rid"]) in sc_marks or meta.get("tid") == SELF_CHECK_TPL_ID:
            n_sc_skip += 1
            continue
        cg.append((meta, {it["t"]: it for it in items}))
    if n_sc_skip:
        print(f"[fix205] cgCompare 自检剔除：{n_sc_skip} 份自检报告不入对比链")
    by_store = {}
    for meta, itemmap in cg:
        by_store.setdefault(meta["sn"], []).append((meta, itemmap))
    cg_compare = []
    for sn, lst in by_store.items():
        if len(lst) < 2:
            continue
        lst.sort(key=lambda x: x[0]["d"])
        # fix207：只取最新一次配对；rep30 的 30 天复发回看仍用完整 lst（不含自检）
        for prev, cur in [(lst[-2], lst[-1])]:
            pm, pmap = prev
            cm, cmap = cur
            pu, cu = len(pmap), len(cmap)
            if pu == 0 and cu == 0:
                continue
            repeated, regressed, improved = [], [], []
            for title, it in cmap.items():
                photos = it["img"]
                if title in pmap:
                    repeated.append({"t": title, "desc": it["desc"], "photos": photos, "rep30": False})
                else:
                    regressed.append({"t": title, "desc": it["desc"], "photos": photos})
            for title, it in pmap.items():
                if title not in cmap:
                    improved.append({"t": title, "pdesc": it["desc"]})
            # rep30：本次往前30天内（不含对比的上一份），该问题是否还出现在其他报告
            try:
                cd_dt = datetime.strptime(cm["d"], "%Y-%m-%d")
            except Exception:
                cd_dt = None
            if cd_dt is not None and repeated:
                lo = (cd_dt - timedelta(days=30)).strftime("%Y-%m-%d")
                hi = (cd_dt - timedelta(days=1)).strftime("%Y-%m-%d")
                others = [x for x in lst if x is not prev and x is not cur and lo <= x[0]["d"] <= hi]
                other_titles = set()
                for _m, im in others:
                    other_titles |= set(im.keys())
                for r0 in repeated:
                    r0["rep30"] = r0["t"] in other_titles
            delta = cu - pu
            verdict = "差了" if delta > 0 else ("好了" if delta < 0 else "持平")
            cg_compare.append({
                "sn": sn, "rg": cm["rg"] or pm["rg"], "ps": cm["ps"] or pm["ps"],
                "pd": pm["d"], "cd": cm["d"], "pu": pu, "cu": cu,
                "delta": delta, "verdict": verdict,
                "repeated": repeated, "regressed": regressed, "improved": improved,
            })
    # fix207：按本次日期倒序（最新巡检的对比排最前），同日按店名升序
    cg_compare.sort(key=lambda x: x["sn"])
    cg_compare.sort(key=lambda x: x["cd"], reverse=True)

    out = {
        "success": True,
        "generatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "note": "问题高发v2：按报告类型分组的逐条不合格项；时间区间由前端过滤",
        "skippedAiTest": skipped_ai_test,
        "types": types,
        "cgCompare": cg_compare,
        "rectify": rectify,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    # ---- 校验输出 ----
    print(f"生成 {os.path.relpath(OUT_PATH, BASE)}  generatedAt={out['generatedAt']}")
    for typ in ("CG", "ZJ", "SP", "AI"):
        ents = types[typ]["entries"]
        ds = [e["d"] for e in ents if e["d"]]
        sep_cg = sum(1 for e in ents if e["d"] >= "2026-09-01") if typ == "CG" else None
        extra = f"  9月条目={sep_cg}" if sep_cg is not None else ""
        print(f"  {typ}: {len(ents)} 条  {min(ds) if ds else '-'} ~ {max(ds) if ds else '-'}{extra}")
    print(f"  rectify: {len(rectify)} 行（其中 9 月 {sum(1 for r in rectify if r['d']>='2026-09-01')} 行；无整改单剔除 {n_st3 if order_ok else 0} 条/{'已' if order_ok else '未'}判定）")
    print(f"  cgCompare: {len(cg_compare)} 行（fix207 每店仅最新一次配对；本次巡检在 9 月的 {sum(1 for r in cg_compare if r['cd']>='2026-09-01')} 行）")


if __name__ == "__main__":
    main()
