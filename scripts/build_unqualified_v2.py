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
  - 每次运行全量重建（脚本幂等），由每日管线在 collect_raw 之后调用
"""
import glob
import json
import os
import re
from datetime import datetime, timedelta

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根
DETAIL_DIR = os.path.join(BASE, "data", "details")
OUT_PATH = os.path.join(BASE, "data", "unqualified_v2.json")

TYPES = ("CG", "ZJ", "SP")

RAW_SN_MAP = {}  # rid -> 门店名（从 raw 月度汇总反查，兜底历史明细文件缺 storeName）


def load_raw_sn_map():
    """部分历史明细文件（如 9/06 一次性脚本所抓的 21 份）顶层无 storeName、API raw 里也没有，
    导致板块按门店分组时出现「-」卡片。raw 月度汇总里每份报告都带 sn，反查兜底。"""
    m = {}
    raw_dir = os.path.join(BASE, "data", "raw")
    if not os.path.isdir(raw_dir):
        return m
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
                    sn = (r.get("sn") or "").strip()
                    if rid and sn and rid not in m:
                        m[rid] = sn
    return m


def parse_nl(nl):
    """组织路径 → (区域rg, 组别ps)。'总经办/加盟服务部/加盟营运组/赖先晓区域' → ('赖先晓区域','加盟营运组')"""
    if not nl or not isinstance(nl, str):
        return "", ""
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
    rg, ps = parse_nl(raw.get("nameLink") or raw.get("creatorNameLink") or "")
    sc = str(raw.get("storeCode") or "")
    meta = {"typ": typ, "rid": rid, "sn": sn, "sc": sc, "d": d, "rg": rg, "ps": ps}
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
                "corrected": bool(it.get("isCorrected")),
            })
    return meta, items


def main():
    global RAW_SN_MAP
    RAW_SN_MAP = load_raw_sn_map()
    files = sorted(glob.glob(os.path.join(DETAIL_DIR, "*.json")))
    reports = {}
    for fp in files:
        meta, items = extract_report(fp)
        if not meta:
            continue
        reports[(meta["typ"], meta["rid"])] = (meta, items)

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
        rectify.append({
            "typ": t, "rid": meta["rid"], "sn": meta["sn"],
            "rg": meta["rg"], "ps": meta["ps"], "d": meta["d"],
            "total": len(items),
            "done": sum(1 for it in items if it["corrected"]),
        })

    # ---- cgCompare：同店相邻两次常规巡检对比 ----
    cg = []
    for (t, _rid), (meta, items) in reports.items():
        if t == "CG" and meta["d"]:
            cg.append((meta, {it["t"]: it for it in items}))
    by_store = {}
    for meta, itemmap in cg:
        by_store.setdefault(meta["sn"], []).append((meta, itemmap))
    cg_compare = []
    for sn, lst in by_store.items():
        if len(lst) < 2:
            continue
        lst.sort(key=lambda x: x[0]["d"])
        for prev, cur in zip(lst, lst[1:]):
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
    cg_compare.sort(key=lambda x: x["cd"])

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
    print(f"  rectify: {len(rectify)} 行（其中 9 月 {sum(1 for r in rectify if r['d']>='2026-09-01')} 行）")
    print(f"  cgCompare: {len(cg_compare)} 行（本次巡检在 9 月的 {sum(1 for r in cg_compare if r['cd']>='2026-09-01')} 行）")


if __name__ == "__main__":
    main()
