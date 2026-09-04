#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从慧运营拉取全量巡检数据，生成静态 JSON 快照，供 GitHub Pages 前端直接读取。

设计要点：
- 完全无服务端：所有 /api/* 接口在构建期预先算好，落成静态 JSON。
- 凭据从环境变量读取（GitHub Actions 里由 Secrets 注入），绝不写进代码。
- 每个数据集独立 try/except：单个模块失败不影响其他模块，已生成的文件照常可用。

输出（相对仓库根目录）：
  data/data.json                        主看板数据（默认区间）
  data/unqualified.json                 不合格明细
  data/trends_{period}_{groupBy}.json   自检趋势（4 period × 2 groupBy）
  data/rankings_{type}_{period}.json    区域排名（4 type × 4 period）
  data/meta.json                        本次生成元信息（时间、区间、各模块成败）
"""
import datetime
import json
import os
import sys
import traceback

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

# fix58：server / hhy_api 统一在模块顶层导入。
# 原实现把 `import server` 放在 main() 函数体内部，reportDetails 模块
# （collect_report_details 在 main() 内被调用）在 Actions 里报
# `NameError: name 'server' is not defined`，导致 data/reportDetails.json
# 一直未能生成（meta.json modules.reportDetails.ok=false）。
# server 只依赖 hhy_api/hhy_config/requests/flask，顶层导入无循环风险。
import server  # noqa: E402
import hhy_api as api  # noqa: E402
import hhy_config as cfg  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(BASE_DIR), "data")

# 主数据默认统计区间：当年 7 月 1 日 ~ 今天（与前端 initDates 保持一致）
DEFAULT_START_MONTH = 7
DEFAULT_START_DAY = 1

TREND_PERIODS = ["7", "30", "month", "range"]
TREND_GROUP_BYS = ["region", "position"]
RANK_TYPES = ["all", "regular", "self", "video"]
RANK_PERIODS = ["thisWeek", "lastWeek", "thisMonth", "lastMonth"]


def log(msg):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def beijing_today():
    """Actions runner 默认使用 UTC；业务日期必须按北京时间计算。"""
    tz = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz).date()


def default_range():
    today = beijing_today()
    start = datetime.date(today.year, DEFAULT_START_MONTH, DEFAULT_START_DAY)
    return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")


def period_range(period, start_date, end_date):
    """把前端的 period 参数翻译成具体日期区间。"""
    today = beijing_today()
    if period == "7":
        return (today - datetime.timedelta(days=6)).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    if period == "30":
        return (today - datetime.timedelta(days=29)).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    if period == "month":
        return today.replace(day=1).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    if period == "range":
        return start_date, end_date
    return (today - datetime.timedelta(days=6)).strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")


# 脱敏开关：默认开启。设 ANONYMIZE=0 可关闭（仅建议在私有仓库使用）。
ANONYMIZE = os.environ.get("ANONYMIZE", "1") not in ("0", "false", "no")

# 需要抹掉的字段名（精确匹配，不区分大小写）。
# 这些是自然人姓名/身份信息，与运营整改无关，公开仓库必须去掉。
ANONYMIZE_FIELDS = {
    "franchiseename",   # 加盟商姓名，如「林龙」
    "franchiseephone",  # 加盟商电话
    "phone", "mobile", "tel",
    "idcard", "idno",
}

# 这些字段只保留结构、清空内容（避免误伤同名业务字段时丢失列）
ANONYMIZE_MASK = "***"


def anonymize(obj):
    """递归遍历 dict/list，抹掉敏感字段。

    只处理字段名精确命中 ANONYMIZE_FIELDS 的键，门店名/区域名/分数等业务字段
    一律保留 —— 抹掉它们看板就失去「定位到具体门店去整改」的核心价值。
    """
    if not ANONYMIZE:
        return obj
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if isinstance(k, str) and k.lower() in ANONYMIZE_FIELDS:
                out[k] = ANONYMIZE_MASK if v else v
            else:
                out[k] = anonymize(v)
        return out
    if isinstance(obj, list):
        return [anonymize(x) for x in obj]
    return obj


def collect_item_photos(unq, start_date, end_date, top_n=40, per_item=4):
    """
    fix28：采集「问题高发」板块的现场照片。
    对 unq.byItem 按不合格次数取前 top_n 项，逐项调慧运营 pictureList 接口，
    把照片完整 URL 列表写入 unq["itemPhotos"] = {"<contentId>": [url, ...]}。
    单项失败不影响其他项；接口整体失败时返回空 dict（前端显示「无照片」占位）。
    """
    import time as _time
    import hhy_config as cfg
    import server  # 本地导入（sys.path 已在模块头加入 scripts 目录）

    items = sorted(unq.get("byItem", []), key=lambda x: -x.get("unqCount", 0))[:top_n]
    if not items:
        return {}

    login_res = server.api.login()
    token = (login_res.get("data") or {}).get("token") or login_res.get("token")

    result = {}
    for idx, it in enumerate(items):
        cid = it.get("contentId")
        if not cid:
            continue
        row = {"contentId": cid, "title": it.get("title", ""),
               "categoryName": it.get("category", "")}
        for attempt in (1, 2):  # token 过期重试一次
            try:
                raw = server.api.fetch_cg_item_pictures(token, row, start_date, end_date, per_item)
                urls = []
                for p in raw:
                    for u in (p.get("urls") or []):
                        full = u if str(u).startswith("http") else cfg.IMG_BASE + str(u)
                        if full not in urls:
                            urls.append(full)
                        if len(urls) >= per_item:
                            break
                    if len(urls) >= per_item:
                        break
                if urls:
                    result[str(cid)] = urls
                break
            except Exception as e:
                msg = str(e)
                token_expired = "重新登录" in msg or "10006" in msg
                transient = token_expired or "504" in msg or "502" in msg or \
                    "Timeout" in msg or "timeout" in msg or "timed out" in msg
                if attempt == 1 and transient:
                    _time.sleep(2)
                    if token_expired:
                        try:
                            login_res = server.api.login()
                            token = (login_res.get("data") or {}).get("token") or login_res.get("token")
                        except Exception:
                            pass
                    continue
                log(f"  照片采集失败 {cid}: {msg[:120]}")
                break
        if idx % 10 == 9:
            log(f"  照片采集进度 {idx + 1}/{len(items)}")
            _time.sleep(0.3)  # 轻微限速，避免触发风控
    return result


def collect_report_details(data_obj, start_date, end_date):
    """
    fix53：抓取每份报告的明细，存 data/reportDetails.json，供前端免登录查看。

    从已生成的 data.json 收集所有带 reportId 的门店记录（常规 CG / 自检 ZJ / 视频 VIDEO），
    按 planType:reportId 去重后逐份抓取明细。已抓过的（reportDetails.json 中已有）跳过，
    避免每次重跑都打全量接口。调用间节流 0.5s，避免触发慧运营风控。
    """
    import time as _time
    import hhy_api as api

    d = data_obj or {}
    buckets = {"CG": [], "ZJ": [], "VIDEO": [], "AI": []}

    def add(recs, pt):
        for r in (recs or []):
            rid = r.get("reportId")
            if rid:
                buckets.setdefault(pt, []).append((str(rid), r.get("signId")))

    # 常规巡检：排名列表 + 区域汇总里的门店
    add(d.get("stores"), "CG")
    for reg in (d.get("regions") or []):
        add(reg.get("stores"), "CG")
    # 自检
    zi = d.get("selfInspection") or {}
    zj_stores = []
    for reg in (zi.get("regions") or []):
        zj_stores.extend(reg.get("stores") or [])
    zj_stores.extend(zi.get("rankStores") or [])
    add(zj_stores, "ZJ")
    # 视频巡检
    vi = d.get("videoInspection") or {}
    sp_stores = []
    for reg in (vi.get("regions") or []):
        sp_stores.extend(reg.get("stores") or [])
    add(sp_stores, "VIDEO")

    # AI 慧检（fix54）
    ai = d.get("aiInspection") or {}
    ai_stores = []
    for reg in (ai.get("regions") or []):
        ai_stores.extend(reg.get("stores") or [])
    ai_stores.extend(ai.get("rankStores") or [])
    add(ai_stores, "AI")

    uniq = {}
    for pt, lst in buckets.items():
        for rid, sid in lst:
            key = f"{pt}:{rid}"
            if key not in uniq:
                uniq[key] = (pt, rid, sid)
    if not uniq:
        log("  报告明细：未找到任何 reportId，跳过")
        return {}

    # 读取已有缓存（云端每次运行从仓库拉取，已抓过的跳过）
    cache_path = os.path.join(OUT_DIR, "reportDetails.json")
    cache = {}
    if os.path.exists(cache_path):
        try:
            cache = (json.load(open(cache_path, encoding="utf-8")) or {}).get("details", {}) or {}
        except Exception:
            cache = {}
    log(f"  报告明细：唯一报告 {len(uniq)} 份，缓存命中 {sum(1 for k in uniq if k in cache)} 份")

    # 自行登录拿 token（本函数已 import hhy_api as api；hhy_api.login 返回 data 层，含 token 字段）
    login_res = api.login()
    token = login_res.get("token") or (login_res.get("data") or {}).get("token")
    details = dict(cache)
    fetched = 0
    for key, (pt, rid, sid) in uniq.items():
        if key in details:
            continue
        try:
            det = api.fetch_report_detail(token, rid, pt, sid)
        except Exception as e:
            det = None
            log(f"  明细抓取异常 {key}: {str(e)[:120]}")
        if det and det.get("raw"):
            details[key] = {"planType": pt, "reportId": rid, "signId": sid,
                            "endpoint": det.get("endpoint"), "raw": det.get("raw")}
            fetched += 1
        else:
            details[key] = {"planType": pt, "reportId": rid, "signId": sid,
                            "endpoint": (det or {}).get("endpoint"), "raw": None,
                            "error": "no_data_or_endpoint"}
        # 整改单（fix53 弹窗整合）：该报告关联的所有待整改条目
        try:
            rects = api.fetch_rectifications(token, report_id=rid, plan_type=pt)
            # 防御：若接口忽略 reportId 返回全量（单份>200 视为异常），不落库避免膨胀
            if isinstance(rects, list) and len(rects) <= 200:
                details[key]["rectifications"] = rects
            else:
                details[key]["rectifications"] = []
                details[key]["rectificationsNote"] = "filtered_out_too_many_or_unfiltered"
        except Exception as e:
            details[key]["rectifications"] = []
            log(f"  整改单异常 {key}: {str(e)[:100]}")
        if fetched % 20 == 0:
            log(f"  报告明细进度 已抓 {fetched}（累计 {len(details)}）")
        _time.sleep(0.5)  # 节流，避免触发风控
    log(f"  报告明细：本次新抓 {fetched} 份")
    return details


def probe_report_endpoints(data_obj):
    """
    fix65：端点探测（一次性，结果落 data/_probe_result.json）。

    背景：CG/ZJ/SP 三类报告的明细接口一直抓不到（425 份里只有 7 份 AI 成功）。
    AI 成功用的是 /statRi/web/ai/audit/report/detail —— 带 /statRi/ 前缀；
    而 CG/ZJ/SP 的候选全写在 /web/ri/ 下，前缀可能就错了。

    本函数用 1 个真实 reportId × 每种 planType，穷举
      (前缀 × 路径 × 参数传递方式)
    全部组合，把每组的响应 code / 是否拿到非空 data / 响应片段记下来，
    落到 data/_probe_result.json。Actions 会自动把它 commit 回仓库，
    我们直接读文件就能确定正确端点，无需下载 Actions 日志。

    只在 _probe_result.json 不存在时跑（跑过一次就停，不拖慢日常抓取）。
    """
    import time as _time

    probe_path = os.path.join(OUT_DIR, "_probe_result.json")
    if os.path.exists(probe_path):
        log("  端点探测：已有结果，跳过")
        return

    d = data_obj or {}
    # 每种 planType 取 1 个真实 reportId（含 signId，CG 用得上）
    samples = {}
    for r in (d.get("stores") or []):
        if r.get("reportId") and "CG" not in samples:
            samples["CG"] = (str(r["reportId"]), r.get("signId"))
            break
    zi = d.get("selfInspection") or {}
    for r in (zi.get("rankStores") or []):
        if r.get("reportId") and "ZJ" not in samples:
            samples["ZJ"] = (str(r["reportId"]), r.get("signId"))
            break
    vi = d.get("videoInspection") or {}
    for reg in (vi.get("regions") or []):
        for r in (reg.get("stores") or []):
            if r.get("reportId") and "SP" not in samples:
                samples["SP"] = (str(r["reportId"]), r.get("signId"))
                break
        if "SP" in samples:
            break

    if not samples:
        log("  端点探测：未取到样本 reportId，跳过")
        return

    # 前缀 × 路径 × 参数方式 的全组合
    # 只取最可能的 3 个前缀 × 2 种参数方式（json/query），共 3×6×2×3=108 组，
    # 约 1.5-2 分钟跑完，不至于拖垮 Actions（form 方式罕见，留作后续补充）。
    PREFIXES = ["/web/ri", "/statRi/web/ri", "/web"]
    PATHS = {
        "CG": ["/cg/report/info", "/report/info", "/cg/report/detail",
               "/report/detail", "/cg/report/get", "/polling/report/info"],
        "ZJ": ["/report/info", "/zj/report/info", "/selfTest/report/info",
               "/report/detail", "/selfTestReport/info", "/zj/report/detail"],
        "SP": ["/video/report/info", "/sp/report/info", "/report/info",
               "/videoReport/info", "/report/detail", "/video/report/detail"],
    }
    # 参数传递方式：json=JSON body；query=URL query + form 空 body
    MODES = ["json", "query"]

    try:
        login_res = api.login()
        token = login_res.get("token") or (login_res.get("data") or {}).get("token")
    except Exception as e:
        log(f"  端点探测：登录失败 {str(e)[:120]}")
        return

    results = []
    for pt, (rid, sid) in samples.items():
        for prefix in PREFIXES:
            for path in PATHS[pt]:
                for mode in MODES:
                    full = f"{prefix}{path}?version=1"
                    body = {"reportId": rid, "planType": pt}
                    if pt == "CG" and sid:
                        body["signId"] = sid
                    rec = {"planType": pt, "prefix": prefix, "path": path,
                           "mode": mode, "endpoint": full, "ok": False}
                    try:
                        if mode == "json":
                            data = api.post_json(token, full, body)
                        elif mode == "query":
                            data = api.post_query(token, full, body)
                        else:
                            data = api.post_form(token, full, body)
                        if data:
                            rec["ok"] = True
                            rec["dataType"] = type(data).__name__
                            rec["dataLen"] = len(data) if hasattr(data, "__len__") else -1
                            rec["sample"] = json.dumps(
                                data, ensure_ascii=False)[:400]
                        else:
                            rec["err"] = "empty_data"
                    except Exception as e:
                        rec["err"] = str(e)[:180]
                    results.append(rec)
                    _time.sleep(0.15)  # 轻节流，避免触发风控

    hits = [r for r in results if r.get("ok")]
    log(f"  端点探测：共试 {len(results)} 组合，成功 {len(hits)} 组")
    for h in hits[:10]:
        log(f"    ✅ {h['planType']} {h['endpoint']} mode={h['mode']} "
            f"len={h.get('dataLen')}")

    try:
        with open(probe_path, "w", encoding="utf-8") as f:
            json.dump({"probedAt": datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                       "samples": {k: v[0] for k, v in samples.items()},
                       "total": len(results), "hits": len(hits),
                       "results": results}, f, ensure_ascii=False, indent=1)
        log(f"  端点探测：结果已写 {probe_path}")
    except Exception as e:
        log(f"  端点探测：写文件失败 {e}")


def write_json(rel_name, payload):
    # meta.json 只是构建元信息，不含业务数据，无需脱敏
    if rel_name != "meta.json":
        payload = anonymize(payload)
    path = os.path.join(OUT_DIR, rel_name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    size_kb = os.path.getsize(path) / 1024
    log(f"  写入 {rel_name} ({size_kb:.0f} KB)")
    return size_kb


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # 凭据校验：缺任何一个都没法登录，直接快速失败，避免在 Actions 里空跑几十分钟
    missing = [k for k in ("HY_USERNAME", "HY_PASSWORD") if not os.environ.get(k)]
    if missing:
        log(f"错误：缺少环境变量 {missing}，请在仓库 Settings → Secrets 中配置")
        return 1

    log("导入后端模块 ...")
    import server  # noqa: E402  （依赖 flask + requests，见 scripts/requirements.txt）
    # 注：fix58 后 server/hhy_api/hhy_config 已在模块顶部导入，此处保留兼容旧结构。

    start_date, end_date = default_range()
    log(f"主数据区间：{start_date} ~ {end_date}")

    meta = {
        # 生成 UTC 时间（GitHub Actions runner 默认 UTC），前端 toBeijing() 会转换为北京时间显示
        "generatedAt": datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "startDate": start_date,
        "endDate": end_date,
        "modules": {},
    }

    # ---------- 1. 主看板数据 ----------
    log("拉取主看板数据 ...")
    data = None
    try:
        data = server.build_dashboard_data(start_date, end_date)
        meta["modules"]["data"] = {"ok": True, "stores": (data or {}).get("totalStores")}
        write_json("data.json", {
            "success": True, "data": data, "error": None,
            "cachedAt": meta["generatedAt"],
        })
    except Exception as e:
        traceback.print_exc()
        meta["modules"]["data"] = {"ok": False, "error": str(e)}
        log(f"  主数据失败：{e}")

    # ---------- 1.5 报告明细（免登录查看）----------
    if data:
        log("拉取报告明细（免登录查看）...")
        # fix65：先做一次端点探测（只跑一次），确定 CG/ZJ/SP 明细接口真实路径
        try:
            probe_report_endpoints(data)
        except Exception as e:
            traceback.print_exc()
            log(f"  端点探测异常：{e}")
        try:
            details = collect_report_details(data, start_date, end_date)
            write_json("reportDetails.json", {
                "success": True, "details": details, "error": None,
                "cachedAt": meta["generatedAt"],
            })
            meta["modules"]["reportDetails"] = {"ok": True, "count": len(details)}
        except Exception as e:
            traceback.print_exc()
            meta["modules"]["reportDetails"] = {"ok": False, "error": str(e)}
            log(f"  报告明细失败：{e}")

    # ---------- 2. 不合格明细 ----------
    log("拉取不合格明细 ...")
    try:
        unq = server._get_or_build_unqualified(start_date, end_date, force=True)
        # fix28：采集问题项现场照片，写入 itemPhotos（前端「问题高发」板块用）
        try:
            item_photos = collect_item_photos(unq, start_date, end_date)
            unq["itemPhotos"] = item_photos
            meta["modules"]["unqPhotos"] = {"ok": True, "items": len(item_photos)}
            log(f"  问题项照片：{len(item_photos)} 项有照片")
        except Exception as e:
            unq.setdefault("itemPhotos", {})
            meta["modules"]["unqPhotos"] = {"ok": False, "error": str(e)}
            log(f"  问题项照片采集失败：{e}")
        write_json("unqualified.json", {
            "success": True, "data": unq, "error": None,
            "cachedAt": meta["generatedAt"],
        })
        meta["modules"]["unqualified"] = {"ok": True}
    except Exception as e:
        traceback.print_exc()
        meta["modules"]["unqualified"] = {"ok": False, "error": str(e)}
        log(f"  不合格明细失败：{e}")

    # ---------- 3. 自检趋势 ----------
    log("拉取自检趋势 ...")
    for period in TREND_PERIODS:
        p_start, p_end = period_range(period, start_date, end_date)
        for group_by in TREND_GROUP_BYS:
            name = f"trends_{period}_{group_by}.json"
            try:
                trends = server._fetch_self_trends(p_start, p_end, group_by=group_by)
                write_json(name, {"success": True, "data": trends, "error": None})
                meta["modules"].setdefault("trends", {})[name] = True
            except Exception as e:
                traceback.print_exc()
                meta["modules"].setdefault("trends", {})[name] = str(e)
                log(f"  {name} 失败：{e}")

    # ---------- 3.5 视频巡检趋势 ----------
    log("拉取视频巡检趋势 ...")
    for period in TREND_PERIODS:
        p_start, p_end = period_range(period, start_date, end_date)
        for group_by in TREND_GROUP_BYS:
            name = f"trends_video_{period}_{group_by}.json"
            try:
                trends = server._fetch_video_trends(p_start, p_end, group_by=group_by)
                write_json(name, {"success": True, "data": trends, "error": None})
                meta["modules"].setdefault("trends_video", {})[name] = True
            except Exception as e:
                traceback.print_exc()
                meta["modules"].setdefault("trends_video", {})[name] = str(e)
                log(f"  {name} 失败：{e}")

    # ---------- 4. 区域排名 ----------
    log("拉取区域排名 ...")
    for type_name in RANK_TYPES:
        for period in RANK_PERIODS:
            name = f"rankings_{type_name}_{period}.json"
            try:
                if type_name == "all":
                    reg = server._get_or_build_region_ranking("regular", period)
                    slf = server._get_or_build_region_ranking("self", period)
                    rows = server._merge_region_rankings(reg, slf)
                else:
                    rows = server._get_or_build_region_ranking(type_name, period)
                write_json(name, {"success": True, "data": rows, "error": None})
                meta["modules"].setdefault("rankings", {})[name] = True
            except Exception as e:
                traceback.print_exc()
                meta["modules"].setdefault("rankings", {})[name] = str(e)
                log(f"  {name} 失败：{e}")

    write_json("meta.json", meta)

    failed = [k for k, v in meta["modules"].items()
              if (isinstance(v, dict) and v.get("ok") is False)]
    log("完成。" + (f"失败模块：{failed}" if failed else "全部成功"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
