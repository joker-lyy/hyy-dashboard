"""
慧运营实时数据看板后端
- 后台定期拉取三个岗位数据并聚合
- 提供 /api/data 给前端
- 提供 /api/regionRankings 给区域排名模块
- 提供静态文件服务
"""
import datetime
import json
import os
import sys
import threading
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple

try:
    from flask import Flask, jsonify, request, send_from_directory
except ImportError:
    # 静态生成场景（GitHub Actions / 本地跑 fetch_data.py）不需要 Web 框架。
    # 这里用轻量 stub 顶替，让 build_dashboard_data 等纯数据函数可以脱离 Flask 运行。
    class Flask:  # noqa: D101
        def __init__(self, *args, **kwargs):
            pass

        def route(self, *args, **kwargs):
            def decorator(fn):
                return fn
            return decorator

        def after_request(self, fn):
            return fn

        def before_request(self, fn):
            return fn

        def run(self, *args, **kwargs):
            raise RuntimeError("静态生成模式不支持启动 Web 服务，请运行 scripts/fetch_data.py")

    def jsonify(*args, **kwargs):
        return None

    request = None

    def send_from_directory(*args, **kwargs):
        return None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hhy_api as api
import hhy_config as cfg

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=None)

# 开发看板：禁用浏览器/代理缓存，避免反复出现「改了 app.js 却还是旧行为」的缓存陷阱。
@app.after_request
def _cors_and_cache(resp):
    # 云端部署时允许前端跨域调用（即使后端与前端同域，带上也无害）
    origin = request.headers.get("Origin")
    allow = os.environ.get("ALLOWED_ORIGIN", "*")
    resp.headers["Access-Control-Allow-Origin"] = allow if allow != "*" else (origin or "*")
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, token"
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    # 腾讯云 SCF 平台层(openresty)会给所有响应强制加 Content-Disposition: attachment，
    # 导致浏览器把 HTML/JS 当文件下载而不是渲染页面。这里显式声明 inline 覆盖它。
    resp.headers["Content-Disposition"] = 'inline; filename="index.html"'
    resp.headers["X-Inline-Fix"] = "v2-applied"
    return resp


@app.before_request
def _preflight():
    if request.method == "OPTIONS":
        return ("", 204)

# 全局缓存
cache: Dict[str, Any] = {
    "data": None,
    "last_update": None,
    "error": None,
    "updating": False,
}
cache_lock = threading.Lock()

# 区域排名独立缓存（按需计算）
region_ranking_cache: Dict[str, Any] = {
    "regular": {},
    "self": {},
}
region_ranking_lock = threading.Lock()


def default_range():
    """默认统计区间：本年7月1日到今天。"""
    today = datetime.date.today()
    start = today.replace(month=7, day=1)
    return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")


def current_month_range():
    today = datetime.date.today()
    start = today.replace(day=1)
    return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")


def last_month_range():
    today = datetime.date.today()
    first_this = today.replace(day=1)
    last_month_end = first_this - datetime.timedelta(days=1)
    last_month_start = last_month_end.replace(day=1)
    return last_month_start.strftime("%Y-%m-%d"), last_month_end.strftime("%Y-%m-%d")


def this_week_range():
    today = datetime.date.today()
    start = today - datetime.timedelta(days=today.weekday())
    return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")


def last_week_range():
    today = datetime.date.today()
    this_week_start = today - datetime.timedelta(days=today.weekday())
    last_week_end = this_week_start - datetime.timedelta(days=1)
    last_week_start = last_week_end - datetime.timedelta(days=6)
    return last_week_start.strftime("%Y-%m-%d"), last_week_end.strftime("%Y-%m-%d")


def parse_range(mode: str, custom_start: str = "", custom_end: str = ""):
    if mode == "last_month":
        return last_month_range()
    if mode == "this_week":
        return this_week_range()
    if mode == "last_week":
        return last_week_range()
    if mode == "custom" and custom_start and custom_end:
        return custom_start, custom_end
    return default_range()


def extract_region(org_name_link: str) -> str:
    """从 nameLink 取最后一级作为区域名"""
    if not org_name_link:
        return "未分配区域"
    parts = [p for p in org_name_link.split("/") if p]
    return parts[-1] if parts else "未分配区域"


def match_region(org_name_link: str, region_names) -> str:
    """
    从 nameLink 中匹配出真实的区域名。

    nameLink 形如 "苍井寿司/加盟营运组/付鹏区域/某某门店"，直接取最后一段
    可能拿到门店层级或区域层级，导致区域名与组织树（慧运营真实区域名）不一致。
    这里改为：优先返回「出现在组织树叶子区域名集合里」的那一段，从右往左找；
    找不到才回退到最后一段。
    """
    if not org_name_link:
        return "未分配区域"
    parts = [p.strip() for p in str(org_name_link).split("/") if p and p.strip()]
    if not parts:
        return "未分配区域"
    if region_names:
        for p in reversed(parts):
            if p in region_names:
                return p
    return parts[-1]


def is_test_store(name: str) -> bool:
    """过滤测试/已删除门店"""
    if not name:
        return False
    name_lower = name.lower()
    return any(k in name_lower for k in ["测试", "删除"])


def safe_float(v, default=0.0):
    try:
        if v is None:
            return default
        return float(v)
    except (ValueError, TypeError):
        return default


def safe_int(v, default=0):
    try:
        if v is None:
            return default
        return int(v)
    except (ValueError, TypeError):
        return default


def days_between(start_date: str, end_date: str) -> int:
    try:
        s = datetime.datetime.strptime(start_date, "%Y-%m-%d").date()
        e = datetime.datetime.strptime(end_date, "%Y-%m-%d").date()
        return max(1, (e - s).days + 1)
    except Exception:
        return 1


def normalize_report_id(report_id: Any) -> str:
    """取最新一份 reportId（逗号分隔时取最后一段）。"""
    if not report_id:
        return ""
    rid = str(report_id).strip()
    if "," in rid:
        parts = [p.strip() for p in rid.split(",") if p.strip()]
        return parts[-1] if parts else ""
    return rid


def _latest_report_for_store(cg_rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    按 storeCode 聚合 CG 报告列表，返回每个门店最新一份报告的 reportId/signId。
    优先用 reportDate 排序，无 reportDate 时保留遇到的第一条。
    """
    by_store: Dict[str, List[Dict[str, Any]]] = {}
    for r in cg_rows:
        sc = str(r.get("storeCode", "")).strip()
        if not sc:
            continue
        by_store.setdefault(sc, []).append(r)
    out = {}
    for sc, rows in by_store.items():
        rows_sorted = sorted(
            rows,
            key=lambda x: str(x.get("reportDate", "") or x.get("created", "") or ""),
            reverse=True,
        )
        latest = rows_sorted[0]
        out[sc] = {
            "reportId": str(latest.get("reportId", "")),
            "signId": str(latest.get("signId", "") or latest.get("reportId", "")),
            "reportDate": str(latest.get("reportDate", "") or latest.get("created", ""))[:10],
        }
    return out


def _aggregate_cat_rows(cat_rows: List[Dict[str, Any]], pos_label: str) -> List[Dict[str, Any]]:
    """把品类不合格行按 categoryName 聚合。"""
    agg: Dict[str, int] = {}
    for r in cat_rows:
        cname = r.get("categoryName", "")
        if not cname:
            continue
        if cname in ("全部",):
            continue
        cnt = safe_int(r.get("bxjcs")) + safe_int(r.get("bxjxs")) + safe_int(r.get("bxjmds"))
        if cnt <= 0:
            continue
        agg[cname] = agg.get(cname, 0) + cnt
    return [{"position": pos_label, "category": k, "count": v} for k, v in agg.items()]


def _aggregate_item_rows(item_rows: List[Dict[str, Any]], pos_label: str) -> List[Dict[str, Any]]:
    """
    把问题项级别（categoryUnqualifiedInfo）的行按 title 聚合。
    优先取 bxjcsBhg（不合格次数）；没有该字段时回退到 bxjcs+bxjxs+bxjmds。
    """
    agg: Dict[str, int] = {}
    for r in item_rows:
        name = (r.get("title") or r.get("itemName") or r.get("categoryName") or "").strip()
        if not name or name == "全部":
            continue
        # bxjcsBhg = 不合格次数。字段存在时严格取它（0 就是 0 次不合格，不能回退成巡检次数）；
        # 仅当该字段完全不存在时才回退到汇总口径。
        raw = r.get("bxjcsBhg")
        cnt = safe_int(raw) if raw is not None else (
            safe_int(r.get("bxjcs")) + safe_int(r.get("bxjxs")) + safe_int(r.get("bxjmds"))
        )
        if cnt <= 0:
            continue
        agg[name] = agg.get(name, 0) + cnt
    return [{"position": pos_label, "category": k, "count": v} for k, v in agg.items()]


def _aggregate_regular_regions(
    rows: List[Dict[str, Any]],
    leaves: List[Dict[str, Any]],
    pos_label: str,
    cg_reports: Optional[List[Dict[str, Any]]] = None,
    rect_rows: Optional[List[Dict[str, Any]]] = None,
    tpl_item_count: Optional[Dict[Any, int]] = None,
    region_store_counts: Optional[Dict[str, int]] = None,
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, int], List[Dict[str, Any]]]:
    """
    聚合常规巡检区域数据。
    返回 (region_stats, test_region_counts, store_records)

    【口径说明】三个数据源各司其职，不要混用：

    1) /web/ri/report/list（cg_reports）—— 门店清单、分数、报告链接的唯一来源。
       与「报告中心 → 层级检核 → 常规巡检」页面一致，可返回全部门店。

    2) /web/ri/cg/stat/storeInspectionReport（rows）—— 门店维度「不合格项数」。
       注意：该接口的 pageNumber/pageSize 必须作为 URL query 参数发送，
       放进 form body 会被后端忽略并退回默认 20 行（曾因此误判成后端硬限制）。
       修复后可拿到组织下全部门店（加盟营运组实测 341 行）。
       其 sumCount 语义是「不合格项数 / 被辅导项数」而非「巡检项数」，
       已与 /web/ri/cg/stat/categoryUnqualifiedInfo 对账确认：
         Σ门店 sumCount == Σ问题项 bxjcsBhg（培训组 49、新店运营组 101、加盟营运组 913）
       normalCount 与 sumCount 恒等，不能当「合格项」用，前端不再直接展示。

    3) /statRi/web/ri/item/storeRectificationSummary（rect_rows）—— 门店维度整改进度。
       sumNum=整改项总数、yzg=已整改、dzg=待整改、yqzs=逾期、dsh=待审核。

    4) 巡检项数 = 该门店报告数 × 该门店所用巡检模板的检查项数。
       模板项数来自 categoryUnqualifiedInfo?templateId=xxx 的返回行数
       （QSC巡检表（直营）=59 项、QSC巡检表（加盟）最新版=57 项）。
       实测 Σ(报告数 × 模板项数) == Σ问题项 bxjcs，可精确还原，无需估算。

       → 合格项 = 巡检项 − 不合格项（两者天然不同，满足看板展示要求）
    """
    pos_region_stats: Dict[str, Dict[str, Any]] = {}
    for leaf in leaves:
        rname = leaf.get("organizeName", "")
        if not rname:
            continue
        pos_region_stats[rname] = {
            "store_count": (region_store_counts or {}).get(rname, safe_int(leaf.get("currentStoreCount"))),
            "inspected_count": 0,
            "sum_score": 0.0,
            "score_count": 0,
            "total_items": 0,
            "normal_items": 0,
            "need_rectify": 0,
            "rectified": 0,
            "expired": 0,
        }

    # 组织树真实区域名，保证区域名与慧运营一致
    region_names = set(pos_region_stats.keys())

    # 门店整改汇总（未整改 / 已整改 / 逾期 / 待审核，项为「项数」口径）
    rect_map: Dict[str, Dict[str, Any]] = {}
    for row in (rect_rows or []):
        sname = (row.get("organizeName") or row.get("fullName") or "").strip()
        if sname:
            rect_map[sname] = row

    # 1) storeInspectionReport 补充数据（不合格项数 / 得分 / 合格状态）
    supplement: Dict[str, Dict[str, Any]] = {}
    test_region_counts: Dict[str, int] = {}
    for row in rows:
        region = match_region(row.get("orgName", ""), region_names)
        store_name = (row.get("fullName") or "").strip()
        if not store_name:
            continue
        if is_test_store(store_name):
            test_region_counts[region] = test_region_counts.get(region, 0) + 1
            continue
        supplement[store_name] = {
            "region": region,
            "storeCode": row.get("storeCode", ""),
            "orgPath": row.get("orgName", ""),
            "score": safe_float(row.get("avgScore")),
            "sumCount": safe_int(row.get("sumCount")),
            "normalCount": safe_int(row.get("normalCount")),
            "needRectify": safe_int(row.get("xuCorrectedReport")),
            "rectified": safe_int(row.get("isCorrectedCount")),
            "expired": safe_int(row.get("expiredCorrectReport")),
            "isPass": row.get("isPass"),
            "storeStatus": row.get("storeStatus"),
            "franchiseeName": row.get("franchiseeName", ""),
        }

    # 2) 以完整的 report/list 为主，聚合门店与区域
    store_records = []
    cg_store_map: Dict[str, Dict[str, Any]] = {}
    for rep in (cg_reports or []):
        sname = (rep.get("fullName") or "").strip()
        if not sname or is_test_store(sname):
            continue
        region = match_region(rep.get("nameLink", ""), region_names)
        bucket = cg_store_map.setdefault(sname, {
            "position": pos_label,
            "region": region,
            "storeCode": rep.get("storeCode", ""),
            "storeName": sname,
            "orgPath": rep.get("nameLink", ""),
            "scoreSum": 0.0,
            "scoreCount": 0,
            "needRectify": 0,
            "rectified": 0,
            "expired": 0,
            "unqReports": 0,
            "lastDate": "",
            "reportId": rep.get("reportId"),
            "signId": rep.get("signId"),
            "isPass": None,
            "latestScore": None,   # 最新一份报告的分数（慧运营 storeInspectionReport 的 avgScore 口径）
            "scoreSum": 0.0,       # 区间内所有报告分数之和（回退用）
            "scoreCount": 0,
            "reportCount": 0,      # 区间内报告份数（用于换算巡检项数）
            "tplCounts": {},       # templateId -> 该模板下的报告份数
        })
        sc = safe_float(rep.get("score"), None)
        if sc is not None:
            bucket["scoreSum"] += sc
            bucket["scoreCount"] += 1
        bucket["reportCount"] += 1
        tid = rep.get("templateId")
        if tid not in (None, ""):
            bucket["tplCounts"][tid] = bucket["tplCounts"].get(tid, 0) + 1
        bucket["needRectify"] += safe_int(rep.get("unRectifyNum"))
        if rep.get("isCorrected"):
            bucket["rectified"] += 1
        if rep.get("isExpiredCorrect"):
            bucket["expired"] += 1
        if str(rep.get("isPassString") or "") == "不合格":
            bucket["unqReports"] += 1
        rdate = str(rep.get("reportDate") or "")
        if rdate > bucket["lastDate"]:
            bucket["lastDate"] = rdate
            bucket["reportId"] = rep.get("reportId")
            bucket["signId"] = rep.get("signId")
            # 最新一份报告的分数与合格状态
            bucket["latestScore"] = sc
            bucket["isPass"] = bool(rep.get("isPass"))

    for sname, bucket in cg_store_map.items():
        sup = supplement.get(sname, {})
        region = sup.get("region") or bucket["region"]
        # 分数口径：慧运营 storeInspectionReport 的 avgScore 实为「该门店最新一份报告的分数」
        # （已逐店核对：7 家店的 avgScore 与 report/list 最新一份报告分数完全一致）。
        # 因此这里优先取最新一份报告分数，与慧运营保持一致；
        # 最新一份无分时回退到区间平均分，再回退到 storeInspectionReport。
        latest = bucket.get("latestScore")
        if latest is not None and latest > 0:
            score = latest
        elif bucket["scoreCount"] > 0:
            score = round(bucket["scoreSum"] / bucket["scoreCount"], 2)
        elif sup:
            score = safe_float(sup.get("score"))
        else:
            score = 0.0
        # ---- 巡检项 / 不合格项 / 合格项 ----
        # 巡检项 = Σ(该模板下报告份数 × 该模板检查项数)
        # 不合格项 = storeInspectionReport.sumCount（与慧运营问题项明细 ΣbxjcsBhg 对账一致）
        # 合格项   = 巡检项 − 不合格项
        tpl_counts = bucket.get("tplCounts") or {}
        inspected_items = 0
        for tid, n in tpl_counts.items():
            inspected_items += n * safe_int((tpl_item_count or {}).get(tid))
        if inspected_items == 0:  # 拿不到模板项数时退回报告份数，至少不为 0
            inspected_items = bucket.get("reportCount", 0)
        unq_items = safe_int(sup.get("sumCount")) if sup else 0
        normal_items = max(0, inspected_items - unq_items)

        rect = rect_map.get(sname, {})
        store_records.append({
            "position": pos_label,
            "region": region,
            "storeCode": sup.get("storeCode") or bucket["storeCode"],
            "storeName": sname,
            "orgPath": sup.get("orgPath") or bucket["orgPath"],
            "score": score,
            "reportCount": bucket.get("reportCount", 0),
            # 巡检项 / 合格项 / 不合格项（项数口径，三者互不相等）
            "sumCount": inspected_items,
            "normalCount": normal_items,
            "unqualifiedItems": unq_items,
            # 整改进度：优先取「门店整改汇总」（项数口径），拿不到再退回报告级计数
            "needRectify": safe_int(rect.get("dzg")) if rect else bucket["needRectify"],
            "rectified": safe_int(rect.get("yzg")) if rect else bucket["rectified"],
            "expired": safe_int(rect.get("yqzs")) if rect else bucket["expired"],
            "pendingAudit": safe_int(rect.get("dsh")) if rect else 0,
            "rectifyTotal": safe_int(rect.get("sumNum")) if rect else 0,
            "reportId": bucket["reportId"],
            "signId": bucket["signId"],
            "isPass": sup.get("isPass") if sup and sup.get("isPass") is not None else bucket.get("isPass"),
            "storeStatus": sup.get("storeStatus"),
            "franchiseeName": sup.get("franchiseeName", ""),
        })

        if region not in pos_region_stats:
            pos_region_stats[region] = {
                "store_count": 0,
                "inspected_count": 0,
                "sum_score": 0.0,
                "score_count": 0,
                "total_items": 0,
                "normal_items": 0,
                "need_rectify": 0,
                "rectified": 0,
                "expired": 0,
            }

        pos_region_stats[region]["inspected_count"] += 1
        pos_region_stats[region]["total_items"] += inspected_items
        pos_region_stats[region]["normal_items"] += normal_items
        pos_region_stats[region]["unq_items"] = pos_region_stats[region].get("unq_items", 0) + unq_items
        pos_region_stats[region]["need_rectify"] += (
            safe_int(rect.get("dzg")) if rect else bucket["needRectify"])
        pos_region_stats[region]["rectified"] += (
            safe_int(rect.get("yzg")) if rect else bucket["rectified"])
        pos_region_stats[region]["expired"] += (
            safe_int(rect.get("yqzs")) if rect else bucket["expired"])
        if score > 0:
            pos_region_stats[region]["sum_score"] += score
            pos_region_stats[region]["score_count"] += 1

    return pos_region_stats, test_region_counts, store_records


def _build_region_summary(
    pos_region_stats: Dict[str, Dict[str, Any]],
    test_region_counts: Dict[str, int],
    pos_label: str,
) -> Dict[str, Dict[str, Any]]:
    """把区域统计整理为最终 region_map 条目。"""
    region_map: Dict[str, Dict[str, Any]] = {}
    for rname, stats in pos_region_stats.items():
        avg_score = round(stats["sum_score"] / stats["score_count"], 2) if stats["score_count"] > 0 else 0.0
        adjusted_store_count = max(0, stats["store_count"] - test_region_counts.get(rname, 0))
        # 巡检项 / 合格项 / 不合格项全部来自门店级真实值汇总，不再有 fallback 估算。
        unqualified = stats.get("unq_items", stats["total_items"] - stats["normal_items"])
        region_map[rname] = {
            "region": rname,
            "position": pos_label,
            "storeCount": adjusted_store_count,
            "inspectedCount": stats["inspected_count"],
            "avgScore": avg_score,
            "totalItems": stats["total_items"],
            "normalItems": stats["normal_items"],
            "unqualifiedItems": unqualified,
            "needRectify": stats["need_rectify"],
            "rectified": stats["rectified"],
            "expired": stats["expired"],
            "submitRate": round(stats["inspected_count"] / adjusted_store_count * 100, 1)
                          if adjusted_store_count > 0 else 0.0,
            "qualifiedRate": round(stats["normal_items"] / stats["total_items"] * 100, 1)
                             if stats["total_items"] > 0 else 0.0,
        }
    return region_map


def _aggregate_video_regions(
    video_rows: List[Dict[str, Any]],
    leaves: List[Dict[str, Any]],
    pos_label: str,
    sp_store_rows: Optional[List[Dict[str, Any]]] = None,
    sp_item_count: int = 0,
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    """
    聚合视频稽核（/web/ri/video/list）报告数据。

    每行是一份视频巡检报告：score / isPass / unRectifyNum / isCorrected / isExpiredCorrect。
    按门店去重（同门店取最新一份报告），再按区域汇总。
    返回 (region_map, store_records)。

    巡检项口径与常规巡检保持一致：
      巡检项   = 该门店报告份数 × 视频巡检模板检查项数（sp_item_count）
      不合格项 = /statRi/web/ri/sp/stat/storeInspectionReport 的 sumCount（门店维度）
      合格项   = 巡检项 − 不合格项
    """
    pos_region_stats: Dict[str, Dict[str, Any]] = {}
    for leaf in leaves:
        rname = leaf.get("organizeName", "")
        if not rname:
            continue
        pos_region_stats[rname] = {
            "store_count": safe_int(leaf.get("currentStoreCount")),
            "inspected_count": 0,
            "sum_score": 0.0,
            "score_count": 0,
            "total_items": 0,
            "normal_items": 0,
            "need_rectify": 0,
            "rectified": 0,
            "expired": 0,
        }

    region_names = set(pos_region_stats.keys())
    store_map: Dict[str, Dict[str, Any]] = {}
    test_region_counts: Dict[str, int] = {}

    # 视频稽核门店巡检汇总：门店维度「不合格项数」
    sp_store_map: Dict[str, Dict[str, Any]] = {}
    for r in (sp_store_rows or []):
        nm = (r.get("fullName") or "").strip()
        if nm:
            sp_store_map[nm] = r

    for r in video_rows:
        sname = (r.get("fullName") or "").strip()
        if not sname:
            continue
        if is_test_store(sname):
            region = match_region(r.get("nameLink", ""), region_names)
            test_region_counts[region] = test_region_counts.get(region, 0) + 1
            continue
        region = match_region(r.get("nameLink", ""), region_names)
        sc = str(r.get("storeCode", "")).strip()
        if not sc:
            continue

        score = safe_float(r.get("score"), None)
        is_pass = bool(r.get("isPass"))
        unq = safe_int(r.get("unRectifyNum"))
        is_corrected = bool(r.get("isCorrected"))
        is_expired = bool(r.get("isExpiredCorrect"))
        rd = str(r.get("reportDate") or r.get("created") or "")

        key = f"{pos_label}|{sc}"
        if key not in store_map:
            store_map[key] = {
                "position": pos_label,
                "region": region,
                "storeCode": sc,
                "storeName": sname,
                "orgPath": r.get("nameLink", ""),
                "score": score,
                "sumCount": 0,
                "normalCount": 0,
                "reportCount": 0,
                "unqualifiedItems": 0,
                "needRectify": 0,
                "rectified": 0,
                "expired": 0,
                "reportId": r.get("reportId", ""),
                "signId": "",
                "isPass": is_pass,
                "planType": "VIDEO",
                "reportDate": rd[:10],
                "_date": "",
            }

        prev = store_map[key]
        if rd >= prev.get("_date", ""):
            prev["_date"] = rd
            prev["score"] = score
            prev["isPass"] = is_pass
            prev["reportId"] = r.get("reportId", "")
            prev["reportDate"] = rd[:10]
        prev["reportCount"] = prev.get("reportCount", 0) + 1
        prev["normalCount"] += 1 if is_pass else 0
        prev["needRectify"] += unq
        prev["rectified"] += 1 if is_corrected else 0
        prev["expired"] += 1 if is_expired else 0

    # 换算巡检项 / 不合格项 / 合格项
    for s in store_map.values():
        sp = sp_store_map.get(s["storeName"], {})
        unq_items = safe_int(sp.get("sumCount"))
        inspected_items = safe_int(s.get("reportCount")) * safe_int(sp_item_count)
        if inspected_items <= 0:
            inspected_items = safe_int(s.get("reportCount"))
        s["sumCount"] = inspected_items
        s["unqualifiedItems"] = unq_items
        s["normalCount"] = max(0, inspected_items - unq_items)

    # 区域统计必须按「门店」聚合，不能按「报告」累加：
    # 同一家门店在一个区间内可能有多份视频报告（培训组 7 家店 44 份报告），
    # 按报告累加会让「已巡检门店数」被放大成报告份数。
    for s in store_map.values():
        region = s["region"]
        if region not in pos_region_stats:
            pos_region_stats[region] = {
                "store_count": 0,
                "inspected_count": 0,
                "sum_score": 0.0,
                "score_count": 0,
                "total_items": 0,
                "normal_items": 0,
                "need_rectify": 0,
                "rectified": 0,
                "expired": 0,
            }
        stats = pos_region_stats[region]
        stats["inspected_count"] += 1                  # 门店数
        stats["total_items"] += s["sumCount"]           # 巡检项
        stats["normal_items"] += s["normalCount"]       # 合格项
        stats["unq_items"] = stats.get("unq_items", 0) + s.get("unqualifiedItems", 0)
        stats["need_rectify"] += s["needRectify"]
        stats["rectified"] += s["rectified"]
        stats["expired"] += s["expired"]
        if s.get("score") is not None and s["score"] > 0:
            stats["sum_score"] += s["score"]
            stats["score_count"] += 1

    region_map = _build_region_summary(pos_region_stats, test_region_counts, pos_label)
    # 清理内部字段，避免污染 JSON 输出
    store_records = []
    for s in store_map.values():
        s.pop("_date", None)
        store_records.append(s)
    return region_map, store_records


def _aggregate_self_regions(
    self_rows: List[Dict[str, Any]],
    leaves: List[Dict[str, Any]],
    pos_label: str,
    days: int,
    region_store_counts: Optional[Dict[str, int]] = None,
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """
    聚合每日自检区域和门店数据。
    返回 (self_region_map, self_store_map)
    注：整改单数注入见 _inject_self_rectification（fix60，在完成率合并之后统一做）。
    """
    self_pos_region_stats: Dict[str, Dict[str, Any]] = {}
    for leaf in leaves:
        rname = leaf.get("organizeName", "")
        if not rname:
            continue
        self_pos_region_stats[rname] = {
            "store_count": (region_store_counts or {}).get(rname, safe_int(leaf.get("currentStoreCount"))),
            "completed": 0,
            "kaidian": 0,
            "dayan": 0,
            "qualified": 0,
            "unqualified": 0,
            "expired": 0,
        }

    self_store_map: Dict[str, Dict[str, Any]] = {}
    # 每个门店最新一份自检报告（用于构造报告详情页跳转）
    latest_report: Dict[str, Dict[str, Any]] = {}
    # 自然月（用于回答「这个月巡检了没有」）
    cur_month = datetime.datetime.now().strftime("%Y%m")

    # 组织树真实区域名，保证区域名与慧运营一致
    region_names = set(self_pos_region_stats.keys())

    # 统计各区域测试门店数（按 storeCode 去重），从组织树门店数中剔除
    test_store_codes_by_region: Dict[str, set] = {}
    for r in self_rows:
        if is_test_store(r.get("fullName", "")):
            region = match_region(r.get("nameLink", ""), region_names)
            sc = str(r.get("storeCode", "")).strip()
            if sc:
                test_store_codes_by_region.setdefault(region, set()).add(sc)
    for rname in self_pos_region_stats:
        test_cnt = len(test_store_codes_by_region.get(rname, set()))
        self_pos_region_stats[rname]["store_count"] = max(
            0, self_pos_region_stats[rname]["store_count"] - test_cnt
        )

    for r in self_rows:
        store_name = r.get("fullName", "")
        if is_test_store(store_name):
            continue
        region = match_region(r.get("nameLink", ""), region_names)

        sc = str(r.get("storeCode", "")).strip()
        if sc and r.get("reportId"):
            rd = str(r.get("reportDate", "") or r.get("created", "") or "")
            prev = latest_report.get(sc)
            if prev is None or rd >= prev.get("_date", ""):
                latest_report[sc] = {
                    "_date": rd,
                    "reportId": str(r.get("reportId", "")),
                    "signId": str(r.get("signId") or r.get("reportId") or ""),
                    "reportDate": rd[:10],
                }
        template = r.get("templateName", "")
        is_pass = r.get("isPass")
        expired_status = r.get("expiredStatus", "")

        if region not in self_pos_region_stats:
            self_pos_region_stats[region] = {
                "store_count": 0,
                "completed": 0,
                "kaidian": 0,
                "dayan": 0,
                "qualified": 0,
                "unqualified": 0,
                "expired": 0,
            }

        self_pos_region_stats[region]["completed"] += 1
        if "开店" in template:
            self_pos_region_stats[region]["kaidian"] += 1
        elif "打烊" in template:
            self_pos_region_stats[region]["dayan"] += 1

        if is_pass is True:
            self_pos_region_stats[region]["qualified"] += 1
        elif is_pass is False:
            self_pos_region_stats[region]["unqualified"] += 1

        if expired_status and expired_status != "正常":
            self_pos_region_stats[region]["expired"] += 1

        sc = r.get("storeCode", "") or r.get("fullName", "")
        key = f"{pos_label}|{sc}"
        if key not in self_store_map:
            self_store_map[key] = {
                "position": pos_label,
                "region": region,
                "storeCode": r.get("storeCode", ""),
                "storeName": r.get("fullName", ""),
                "completed": 0,
                "kaidian": 0,
                "dayan": 0,
                "qualified": 0,
                "unqualified": 0,
                "totalScore": 0.0,
                "scoreCount": 0,
                "avgScore": 0.0,
                "reportId": "",
                "signId": "",
                "planType": "ZJ",
                "reportDate": "",
                "monthCompleted": 0,
                "reviewedReports": 0,   # 已被点评的报告数（score ≠ 「未点评」）
                "submittedReports": 0,  # 已提交的报告数
            }
        self_store_map[key]["completed"] += 1
        self_store_map[key]["submittedReports"] = self_store_map[key].get("submittedReports", 0) + 1
        _raw = r.get("score")
        if _raw is not None and str(_raw).strip() != cfg.UNREVIEWED_MARK:
            self_store_map[key]["reviewedReports"] = self_store_map[key].get("reviewedReports", 0) + 1
        if str(r.get("statMonth") or "") == cur_month or \
           str(r.get("reportDate") or "")[:7] == f"{cur_month[:4]}-{cur_month[4:]}":
            self_store_map[key]["monthCompleted"] += 1
        if "开店" in template:
            self_store_map[key]["kaidian"] += 1
        elif "打烊" in template:
            self_store_map[key]["dayan"] += 1
        if is_pass is True:
            self_store_map[key]["qualified"] += 1
        elif is_pass is False:
            self_store_map[key]["unqualified"] += 1

        raw_score = r.get("score")
        s_score = safe_float(raw_score, None)
        if s_score is None:
            s_score = safe_float(r.get("zjScore"), 0.0)
        if s_score is not None and s_score > 0:
            self_store_map[key]["totalScore"] += s_score
            self_store_map[key]["scoreCount"] += 1

    # 回填每个门店的最新报告信息
    for s in self_store_map.values():
        rep = latest_report.get(str(s.get("storeCode", "")).strip(), {})
        s["reportId"] = rep.get("reportId", "")
        s["signId"] = rep.get("signId", "")
        s["reportDate"] = rep.get("reportDate", "")

    # 按区域预汇总「平均分 / 提交率 / 点评率」，供区域明细表展示
    # 提交率 = 有提交报告的门店数 / 门店数
    # 点评率 = 已被点评的报告数 / 已提交的报告数（「未点评」是字符串标记，打 0 分也算已点评）
    region_score_sum: Dict[str, float] = {}
    region_score_cnt: Dict[str, int] = {}
    region_reviewed: Dict[str, int] = {}
    region_submitted: Dict[str, int] = {}
    region_stores: Dict[str, int] = {}
    for s in self_store_map.values():
        rn = s.get("region", "")
        region_stores[rn] = region_stores.get(rn, 0) + 1
        region_submitted[rn] = region_submitted.get(rn, 0) + s.get("submittedReports", 0)
        region_reviewed[rn] = region_reviewed.get(rn, 0) + s.get("reviewedReports", 0)
        if s.get("totalScore") and s.get("scoreCount"):
            region_score_sum[rn] = region_score_sum.get(rn, 0.0) + s["totalScore"]
            region_score_cnt[rn] = region_score_cnt.get(rn, 0) + s["scoreCount"]

    self_region_map: Dict[str, Dict[str, Any]] = {}
    for rname, stats in self_pos_region_stats.items():
        store_count = stats["store_count"]
        expected = store_count * days * 2
        completion_rate = round(stats["completed"] / expected * 100, 1) if expected > 0 else 0.0
        qualified_rate = round(stats["qualified"] / stats["completed"] * 100, 1) if stats["completed"] > 0 else 0.0
        submitted = region_submitted.get(rname, 0)
        avg_score = round(region_score_sum[rname] / region_score_cnt[rname], 2) \
            if region_score_cnt.get(rname) else 0.0
        enrolled = region_stores.get(rname, 0)
        submit_rate = round(enrolled / store_count * 100, 1) if store_count > 0 else 0.0
        review_rate = round(region_reviewed.get(rname, 0) / submitted * 100, 1) if submitted > 0 else 0.0
        self_region_map[rname] = {
            "region": rname,
            "position": pos_label,
            "storeCount": store_count,
            "completed": stats["completed"],
            "expected": expected,
            "kaidian": stats["kaidian"],
            "dayan": stats["dayan"],
            "qualified": stats["qualified"],
            "unqualified": stats["unqualified"],
            "expired": stats["expired"],
            "completionRate": completion_rate,
            "qualifiedRate": qualified_rate,
            "avgScore": avg_score,
            "submitRate": submit_rate,
            "reviewRate": review_rate,
            "_scoreTotal": region_score_sum.get(rname, 0.0),
            "_scoreCount": region_score_cnt.get(rname, 0),
            "_reviewed": region_reviewed.get(rname, 0),
            "_submitted": submitted,
            "_enrolled": enrolled,
        }

    return self_region_map, self_store_map


def _fetch_self_completion(token: str, start_date: str, end_date: str,
                           organize_id: Any) -> Dict[str, Dict[str, Any]]:
    """
    用慧运营「门店完成率汇总」接口拉取自检完成情况。

    相比按「门店数 × 天数 × 2」估算，这个接口给出的是后端按实际任务排程算出的
    应完成数，并且会返回区域下**全部**参与自检任务的门店（含一份报告都没交的门店），
    所以既准确又能回答「这个月哪些门店还没巡检」。

    返回 {storeCode: {...}}；接口不可用时返回空 dict，由调用方回退到估算口径。
    """
    out: Dict[str, Dict[str, Any]] = {}
    try:
        plans = api.fetch_zj_plan_list(token, end_date)
    except Exception:
        return out
    if not plans:
        return out

    for p in plans:
        try:
            rows = api.fetch_store_complete_rate(
                token, p.get("planId"), p.get("repeatModel") or "R",
                start_date, end_date, organize_id,
            )
        except Exception:
            continue
        pname = str(p.get("planName") or "")
        for r in rows or []:
            name = r.get("fullName") or ""
            if not name or is_test_store(name):
                continue
            sc = str(r.get("storeCode") or r.get("storeId") or "").strip()
            if not sc:
                continue
            rec = out.get(sc)
            if rec is None:
                rec = {
                    "storeCode": sc,
                    "storeName": name,
                    "region": (r.get("organizeName") or "").split("/")[-1],
                    "completed": 0,
                    "expected": 0,
                    "unfinished": 0,
                    "qualified": 0,
                    "unqualified": 0,
                    "kaidian": 0,
                    "dayan": 0,
                    "scoreTotal": 0.0,
                    "scoreCount": 0,
                }
                out[sc] = rec
            done = safe_int(r.get("reportNum"))
            rec["completed"] += done
            rec["expected"] += safe_int(r.get("ywcReportNum"))
            rec["unfinished"] += safe_int(r.get("wwcReportNum"))
            rec["qualified"] += safe_int(r.get("hgReportNum"))
            rec["unqualified"] += safe_int(r.get("bhgReportNum"))
            if "打烊" in pname:
                rec["dayan"] += done
            else:
                rec["kaidian"] += done
            dppjf = safe_float(r.get("dppjf"), 0.0)
            if dppjf > 0:
                rec["scoreTotal"] += dppjf
                rec["scoreCount"] += 1
    return out


def _merge_self_completion(self_pos_region_map, self_pos_store_map, completion,
                           pos_label: str, leaves, self_rows=None) -> Tuple[Dict, Dict]:
    """
    把「门店完成率汇总」的真实数据合并进自检区域 / 门店聚合结果。
    - 补齐未提交自检报告的门店（它们的 completed=0，但 expected>0）
    - 应完成改用后端真实值，完成率随之重算
    """
    # 1) 门店维度合并
    for sc, c in completion.items():
        key = f"{pos_label}|{sc}"
        s = self_pos_store_map.get(key)
        if s is None:
            s = {
                "position": pos_label,
                "region": c["region"],
                "storeCode": sc,
                "storeName": c["storeName"],
                "completed": 0, "kaidian": 0, "dayan": 0,
                "qualified": 0, "unqualified": 0,
                "totalScore": 0.0, "scoreCount": 0, "avgScore": 0.0,
                "reportId": "", "signId": "", "planType": "ZJ", "reportDate": "",
                "monthCompleted": 0,
            }
            self_pos_store_map[key] = s
        # 以接口数据为准（它是按任务排程统计的，比逐条报告计数更贴近慧运营页面）
        s["completed"] = c["completed"]
        s["expected"] = c["expected"]
        s["unfinished"] = c["unfinished"]
        s["kaidian"] = c["kaidian"]
        s["dayan"] = c["dayan"]
        s["qualified"] = c["qualified"]
        s["unqualified"] = c["unqualified"]
        if c["scoreCount"] > 0:
            s["totalScore"] = c["scoreTotal"]
            s["scoreCount"] = c["scoreCount"]
            s["avgScore"] = round(c["scoreTotal"] / c["scoreCount"], 2)
        elif s["scoreCount"] > 0:
            s["avgScore"] = round(s["totalScore"] / s["scoreCount"], 2)
    # 未出现在接口里的门店（未参与任何自检任务）按估算补齐字段
    for s in self_pos_store_map.values():
        s.setdefault("expected", 0)
        s.setdefault("unfinished", 0)

    # 2) 区域维度按门店重算
    if region_store_counts:
        # fix15b：直接采用已按「测试门店 + 门店状态非正常」过滤后的真实门店数，与常规巡检/视频口径一致
        region_store_count = {rname: region_store_counts.get(rname, 0) for rname in region_store_counts}
    else:
        region_store_count = {leaf.get("organizeName", ""): safe_int(leaf.get("currentStoreCount"))
                              for leaf in leaves}
        # 剔除测试门店（按 self_rows 里出现的测试门店 storeCode 去重）
        if self_rows:
            region_names = set(region_store_count.keys())
            test_codes: Dict[str, set] = {}
            for r in self_rows:
                if is_test_store(r.get("fullName", "")):
                    region = match_region(r.get("nameLink", ""), region_names)
                    sc = str(r.get("storeCode", "")).strip()
                    if sc:
                        test_codes.setdefault(region, set()).add(sc)
            for rname, codes in test_codes.items():
                region_store_count[rname] = max(0, region_store_count.get(rname, 0) - len(codes))
    agg: Dict[str, Dict[str, Any]] = {}
    for key, s in self_pos_store_map.items():
        if not key.startswith(pos_label + "|"):
            continue
        rname = s.get("region", "")
        a = agg.setdefault(rname, {
            "region": rname, "position": pos_label,
            "storeCount": region_store_count.get(rname, 0),
            "enrolledCount": 0, "completed": 0, "expected": 0, "unfinished": 0,
            "kaidian": 0, "dayan": 0, "qualified": 0, "unqualified": 0, "expired": 0,
        })
        a["enrolledCount"] += 1
        a["completed"] += s.get("completed", 0)
        a["expected"] += s.get("expected", 0)
        a["unfinished"] += s.get("unfinished", 0)
        a["kaidian"] += s.get("kaidian", 0)
        a["dayan"] += s.get("dayan", 0)
        a["qualified"] += s.get("qualified", 0)
        a["unqualified"] += s.get("unqualified", 0)
        if s.get("totalScore") and s.get("scoreCount"):
            a["_scoreTotal"] = a.get("_scoreTotal", 0.0) + s["totalScore"]
            a["_scoreCount"] = a.get("_scoreCount", 0) + s["scoreCount"]
        a["_submitted"] = a.get("_submitted", 0) + s.get("submittedReports", 0)
        a["_reviewed"] = a.get("_reviewed", 0) + s.get("reviewedReports", 0)
        if s.get("completed", 0) > 0:
            a["_enrolled"] = a.get("_enrolled", 0) + 1

    # 没有门店数据的区域（组织树里有、但无自检任务）也保留
    for rname, cnt in region_store_count.items():
        if rname and rname not in agg:
            agg[rname] = {
                "region": rname, "position": pos_label, "storeCount": cnt,
                "enrolledCount": 0, "completed": 0, "expected": 0, "unfinished": 0,
                "kaidian": 0, "dayan": 0, "qualified": 0, "unqualified": 0, "expired": 0,
            }

    for a in agg.values():
        a["completionRate"] = round(a["completed"] / a["expected"] * 100, 1) if a["expected"] > 0 else 0.0
        a["qualifiedRate"] = round(a["qualified"] / a["completed"] * 100, 1) if a["completed"] > 0 else 0.0
        # 平均分 / 提交率 / 点评率
        a["avgScore"] = round(a["_scoreTotal"] / a["_scoreCount"], 2) if a.get("_scoreCount") else 0.0
        a["submitRate"] = round(a.get("_enrolled", 0) / a["storeCount"] * 100, 1) if a["storeCount"] > 0 else 0.0
        a["reviewRate"] = round(a.get("_reviewed", 0) / a["_submitted"] * 100, 1) if a.get("_submitted") else 0.0

    return agg, self_pos_store_map


def _inject_self_rectification(self_pos_store_map, self_pos_region_map, rect_rows):
    """
    fix60：把「门店整改汇总」注入自检门店与区域（应整改单数 = 累计口径）。

    口径（与慧运营「层级检核 → 整改单」一致，按所选日期区间过滤）：
      应整改单数 rectifyTotal = yzg(已整改) + dzg(待整改) + dsh(待审核) = sumNum，
      已整改 rectified = yzg，未完成 needRectify = dzg + dsh。
    应整改单数是累计值，不会因为整改完成而归零。
    必须在 _merge_self_completion 之后调用，保证覆盖完成率接口补齐的全部门店。
    """
    rect_map: Dict[str, Dict[str, Any]] = {}
    for row in (rect_rows or []):
        sn = (row.get("organizeName") or row.get("fullName") or row.get("sn") or "").strip()
        if sn:
            rect_map[sn] = row

    region_total: Dict[str, int] = {}
    region_done: Dict[str, int] = {}
    for s in self_pos_store_map.values():
        rect = rect_map.get(str(s.get("storeName", "")).strip())
        if rect:
            yzg = safe_int(rect.get("yzg"))
            dzg = safe_int(rect.get("dzg"))
            dsh = safe_int(rect.get("dsh"))
            s["rectified"] = yzg                    # 已整改
            s["needRectify"] = dzg + dsh            # 未完成（待整改 + 待审核）
            s["rectifyTotal"] = yzg + dzg + dsh     # 应整改单数（累计）
            s["pendingAudit"] = dsh
            s["expired"] = safe_int(rect.get("yqzs"))
        else:
            s.setdefault("rectified", 0)
            s.setdefault("needRectify", 0)
            s.setdefault("rectifyTotal", 0)
        rn = s.get("region", "")
        region_total[rn] = region_total.get(rn, 0) + safe_int(s.get("rectifyTotal"))
        region_done[rn] = region_done.get(rn, 0) + safe_int(s.get("rectified"))

    for rname, m in self_pos_region_map.items():
        total = region_total.get(rname, 0)
        done = region_done.get(rname, 0)
        m["needRectify"] = total - done
        m["rectified"] = done
        m["rectifyTotal"] = total
        m["rectifyRate"] = round(done / total * 100, 1) if total > 0 else 0.0


def _region_sort_key(r):
    position_order = ["培训组（直营组）", "新店运营组", "加盟营运组", "新店筹备组"]
    pos_idx = position_order.index(r.get("position", "")) if r.get("position") in position_order else 99
    return (pos_idx, r.get("region", ""))


def _build_ai_inspection(start_date: str, end_date: str) -> Dict[str, Any]:
    """fix54：AI 慧检看板数据。复用 _fetch_region_ranking('ai') 的区域汇总，组装精简看板。"""
    try:
        ai_region_list = _fetch_region_ranking("ai", start_date, end_date)
    except Exception as e:
        log(f"  AI 慧检看板失败：{e}")
        return {"positions": [], "regions": [], "stores": [], "rankStores": [],
                "totalStores": 0, "totalInspected": 0}
    ai_all_stores = [st for r in ai_region_list for st in r.get("stores", [])]
    ai_regions = sorted(ai_region_list, key=_region_sort_key)
    ai_stores = sorted(ai_all_stores, key=lambda s: (-(s.get("score") or 0), s.get("storeName", "")))
    ai_rank = sorted([s for s in ai_all_stores if s.get("score", 0) > 0],
                     key=lambda s: (-(s.get("score") or 0), s.get("storeName", "")))
    ai_pos_map: Dict[str, Dict[str, Any]] = {}
    for r in ai_region_list:
        pos = r.get("position", "")
        if pos not in ai_pos_map:
            ai_pos_map[pos] = {"position": pos, "storeCount": 0, "inspectedCount": 0,
                               "avgScore": 0.0, "_n": 0, "_sc": 0.0}
        ai_pos_map[pos]["storeCount"] += r.get("storeCount", 0)
        ai_pos_map[pos]["inspectedCount"] += r.get("inspectedCount", 0)
        sc = r.get("avgScore") or 0
        if sc > 0:
            ai_pos_map[pos]["_sc"] += sc
            ai_pos_map[pos]["_n"] += 1
    ai_positions = []
    for pos, v in ai_pos_map.items():
        v["avgScore"] = round(v["_sc"] / v["_n"], 2) if v["_n"] else 0.0
        del v["_n"]; del v["_sc"]
        ai_positions.append(v)
    return {
        "positions": ai_positions,
        "regions": ai_regions,
        "stores": ai_stores,
        "rankStores": ai_rank,
        "totalStores": sum(r["storeCount"] for r in ai_region_list),
        "totalInspected": sum(r["inspectedCount"] for r in ai_region_list),
    }


def build_dashboard_data(start_date: str, end_date: str) -> Dict[str, Any]:
    """
    拉取三个岗位的常规巡检、每日自检、问题类别等数据并聚合。
    """
    positions = cfg.TARGET_POSITIONS

    # 全局容器
    all_stores: List[Dict[str, Any]] = []
    position_summaries = []
    region_map: Dict[str, Dict[str, Any]] = {}
    top_categories: List[Dict[str, Any]] = []

    self_inspection_position_summaries = []
    self_region_map: Dict[str, Dict[str, Any]] = {}
    self_store_map: Dict[str, Dict[str, Any]] = {}
    # 自检全局分子分母（用于整体平均分 / 点评率，不能把百分比直接相加）
    self_glob = {"scoreTotal": 0.0, "scoreCount": 0, "submitted": 0, "reviewed": 0,
                 "enrolled": 0, "storeCount": 0}
    # 每个岗位是否成功取到慧运营真实的自检应完成数据
    self_real_flags: Dict[str, bool] = {}

    video_position_summaries = []
    video_region_map: Dict[str, Dict[str, Any]] = {}
    video_all_stores: List[Dict[str, Any]] = []
    video_category_details: List[Dict[str, Any]] = []

    # 总览高发问题
    overview_self_cats: Dict[str, int] = {}
    overview_regular_cats: Dict[str, int] = {}
    overview_video_cats: Dict[str, int] = {}

    days = days_between(start_date, end_date)

    # 诊断：列出当前账号在慧运营可切换的全部岗位（真实 roleName/organizeName），
    # 写入 data.json 的 debug_positions，便于排查「第四组匹配不到」类问题。
    debug_positions = []
    try:
        _def = api.login()
        _tk = _def.get("token")
        _all = api.list_positions(_tk)
        debug_positions = [
            {"roleName": p.get("roleName", ""), "organizeName": p.get("organizeName", ""),
             "roleId": p.get("roleId"), "organizeId": p.get("organizeId")}
            for p in _all
        ]
    except Exception as e:
        debug_positions = [{"error": str(e)}]

    for pos_name, org_name in positions:
        try:
            token, matched = api.switch_position_and_login(pos_name, org_name)
        except Exception as e:
            print(f"[WARN] 跳过岗位 {pos_name}/{org_name}（匹配/登录失败）：{e}")
            continue
        pos_label = cfg.POSITION_LABELS.get(org_name, org_name)
        organize_id = matched.get("organizeId")

        # 1) 常规巡检汇总
        rows = api.fetch_store_inspection_report(token, start_date, end_date)

        # 2) 常规巡检报告列表（用于构造详情页 URL）
        cg_reports = api.fetch_cg_reports(token, start_date, end_date)
        store_report_map = _latest_report_for_store(cg_reports)

        # 2.1) 门店整改汇总：未整改 / 已整改 / 逾期 / 待审核（项数口径）
        rect_rows = []
        try:
            rect_rows = api.fetch_store_rectification_summary(token, start_date, end_date)
        except Exception:
            rect_rows = []

        # 2.2) 各巡检模板的检查项数 —— 用于把报告份数换算成「巡检项数」
        tpl_item_count: Dict[Any, int] = {}
        for tid in {r.get("templateId") for r in (cg_reports or []) if r.get("templateId")}:
            try:
                tpl_item_count[tid] = len(api.fetch_category_unqualified_info(
                    token, start_date, end_date, 4, template_id=tid) or [])
            except Exception:
                tpl_item_count[tid] = 0

        # 3) 组织树与层级信息
        leaves = api.leaf_regions(token, root_name=org_name)
        org_info = api.all_org_info(token)
        max_high_no = safe_int(org_info.get("maxHighNo"), 4)

        # 4) 品类不合格（常规巡检）
        cat_rows = api.fetch_category_unqualified_total(token, start_date, end_date, max_high_no)

        # 5) 每日自检报告
        self_rows = api.fetch_self_inspection_reports(token, start_date, end_date)

        # 6) 每日自检问题项（repeatModel=R，问题项级别）
        zj_item_rows = []
        zj_cat_rows = []
        try:
            zj_item_rows = api.fetch_zj_category_unqualified_info(
                token, start_date, end_date, max_high_no, organize_id
            )
        except Exception:
            zj_item_rows = []
        if not zj_item_rows:
            try:
                zj_cat_rows = api.fetch_zj_category_unqualified_total(
                    token, start_date, end_date, max_high_no, organize_id
                )
            except Exception:
                zj_cat_rows = []

        # fix15b：常规巡检门店数按真实门店清单校正（剔除测试门店 + 门店状态非正常 zc）
        region_store_counts: Dict[str, int] = {}
        for _leaf in leaves:
            _rname = _leaf.get("organizeName", "")
            if not _rname:
                continue
            try:
                _stores = api.fetch_stores_by_organize(token, _leaf.get("organizeId"))
                _valid = [s for s in _stores if not is_test_store(s.get("fullName", "")) and s.get("storeStatus") not in ("bd", "ty")]
                region_store_counts[_rname] = len(_valid)
            except Exception:
                region_store_counts[_rname] = safe_int(_leaf.get("currentStoreCount"))

        # 常规巡检聚合
        pos_region_stats, test_region_counts, store_records = _aggregate_regular_regions(
            rows, leaves, pos_label, cg_reports, rect_rows, tpl_item_count,
            region_store_counts=region_store_counts)

        # 把 signId/reportId 关联到门店记录
        region_stores: Dict[str, List[Dict[str, Any]]] = {}
        for s in store_records:
            sc = str(s.get("storeCode", "")).strip()
            rep = store_report_map.get(sc, {})
            s["reportId"] = rep.get("reportId", "")
            s["signId"] = rep.get("signId", "")
            s["planType"] = "CG"
            s["reportDate"] = rep.get("reportDate", "")
            all_stores.append(s)
            region_stores.setdefault(s["region"], []).append(s)

        # 合并常规巡检区域
        pos_region_summary = _build_region_summary(pos_region_stats, {}, pos_label)
        for rname, rdata in pos_region_summary.items():
            if rname not in region_map:
                region_map[rname] = dict(rdata, stores=[])
            region_map[rname]["stores"].extend(region_stores.get(rname, []))

        # 岗位汇总（常规巡检）
        # 「已巡检」= report/list 里产生过报告的门店数。
        # 注意：不能用 sumCount > 0 判断 —— sumCount 是「不合格项数」，无不合格项的门店为 0。
        inspected = len(store_records)
        scored = [s["score"] for s in store_records if s["score"] > 0]
        pos_avg = round(sum(scored) / len(scored), 2) if scored else 0.0
        # fix15：不再用 currentStoreCount（组织树全量，含 bd/ty/测试），改用 _aggregate_regular_regions
        # 已经按 storeStatus='zc' 过滤后的真实门店数累加，与慧运营「组织门店数」对齐
        total_store_count = sum(safe_int(s.get("store_count")) for s in pos_region_stats.values())
        pos_total_items = sum(safe_int(s.get("sumCount")) for s in store_records)
        pos_unq_items = sum(safe_int(s.get("unqualifiedItems")) for s in store_records)
        pos_normal_items = sum(safe_int(s.get("normalCount")) for s in store_records)
        position_summaries.append({
            "position": pos_label,
            "organizeName": org_name,
            "storeCount": total_store_count,
            "inspectedCount": inspected,
            "avgScore": pos_avg,
            "totalItems": pos_total_items,
            "normalItems": pos_normal_items,
            "unqualifiedItems": pos_unq_items,
            "qualifiedRate": round(pos_normal_items / pos_total_items * 100, 1) if pos_total_items else 0.0,
            "submitRate": round(inspected / total_store_count * 100, 1) if total_store_count else 0.0,
            "regions": sorted(pos_region_stats.keys()),
        })

        # 常规巡检问题类别聚合到全局
        for item in _aggregate_cat_rows(cat_rows, pos_label):
            overview_regular_cats[item["category"]] = overview_regular_cats.get(item["category"], 0) + item["count"]
            top_categories.append(item)

        # 每日自检聚合
        self_pos_region_map, self_pos_store_map = _aggregate_self_regions(
            self_rows, leaves, pos_label, days, region_store_counts=region_store_counts)

        # 用慧运营「门店完成率汇总」接口修正应完成/完成率，并补齐未提交报告的门店
        self_completion = _fetch_self_completion(token, start_date, end_date, organize_id)
        if self_completion:
            try:
                self_pos_region_map, self_pos_store_map = _merge_self_completion(
                    self_pos_region_map, self_pos_store_map, self_completion, pos_label, leaves, self_rows
                )
                pos_self_real = True
            except Exception:
                pos_self_real = False
        else:
            pos_self_real = False
        self_real_flags[pos_label] = pos_self_real

        # fix60：注入门店整改汇总（应整改单数累计口径，覆盖完成率合并后的全部门店）
        try:
            _inject_self_rectification(self_pos_store_map, self_pos_region_map, rect_rows)
        except Exception as e:
            print(f"[WARN] 自检整改单数注入失败 {pos_label}: {e}")

        # 该岗位各区域的门店清单（用于前端点击区域下钻）
        pos_region_stores: Dict[str, List[Dict[str, Any]]] = {}
        for s in self_pos_store_map.values():
            pos_region_stores.setdefault(s.get("region", ""), []).append(s)

        for rname, rdata in self_pos_region_map.items():
            if rname not in self_region_map:
                merged = dict(rdata)
                merged["stores"] = pos_region_stores.get(rname, [])
                self_region_map[rname] = merged
            else:
                m = self_region_map[rname]
                m["completed"] += rdata["completed"]
                m["expected"] += rdata["expected"]
                m["unfinished"] = m.get("unfinished", 0) + rdata.get("unfinished", 0)
                m["kaidian"] += rdata["kaidian"]
                m["dayan"] += rdata["dayan"]
                m["qualified"] += rdata["qualified"]
                m["unqualified"] += rdata["unqualified"]
                m["expired"] += rdata["expired"]
                m["enrolledCount"] = m.get("enrolledCount", 0) + rdata.get("enrolledCount", 0)
                # fix60：跨岗位累计整改单数
                m["needRectify"] = m.get("needRectify", 0) + rdata.get("needRectify", 0)
                m["rectified"] = m.get("rectified", 0) + rdata.get("rectified", 0)
                m["rectifyTotal"] = m.get("rectifyTotal", 0) + rdata.get("rectifyTotal", 0)
                for f in ("_scoreTotal", "_scoreCount", "_reviewed", "_submitted", "_enrolled"):
                    m[f] = m.get(f, 0) + rdata.get(f, 0)
                m.setdefault("stores", []).extend(pos_region_stores.get(rname, []))
        # 跨岗位合并后重算比率（不能直接把百分比相加）
        for m in self_region_map.values():
            m["avgScore"] = round(m["_scoreTotal"] / m["_scoreCount"], 2) if m.get("_scoreCount") else 0.0
            m["submitRate"] = round(m.get("_enrolled", 0) / m["storeCount"] * 100, 1) if m.get("storeCount") else 0.0
            m["reviewRate"] = round(m.get("_reviewed", 0) / m["_submitted"] * 100, 1) if m.get("_submitted") else 0.0
            m["rectifyRate"] = round(m.get("rectified", 0) / m["rectifyTotal"] * 100, 1) if m.get("rectifyTotal") else 0.0

        for key, s in self_pos_store_map.items():
            s["avgScore"] = round(s["totalScore"] / s["scoreCount"], 2) if s["scoreCount"] > 0 else 0.0
            if key not in self_store_map:
                self_store_map[key] = s
            else:
                existing = self_store_map[key]
                existing["completed"] += s["completed"]
                existing["kaidian"] += s["kaidian"]
                existing["dayan"] += s["dayan"]
                existing["qualified"] += s["qualified"]
                existing["unqualified"] += s["unqualified"]
                existing["totalScore"] += s["totalScore"]
                existing["scoreCount"] += s["scoreCount"]
                existing["avgScore"] = round(existing["totalScore"] / existing["scoreCount"], 2) if existing["scoreCount"] > 0 else 0.0

        # 岗位自检汇总
        total_completed = sum(s["completed"] for s in self_pos_region_map.values())
        total_expected = sum(safe_int(s.get("expected")) for s in self_pos_region_map.values())
        total_unfinished = sum(safe_int(s.get("unfinished")) for s in self_pos_region_map.values())
        if total_expected <= 0:  # 接口不可用，回退到估算口径
            total_expected = sum(safe_int(s.get("storeCount")) for s in self_pos_region_map.values()) * days * 2
            total_unfinished = max(0, total_expected - total_completed)
        total_qualified = sum(s["qualified"] for s in self_pos_region_map.values())
        pos_score_total = sum(safe_float(s.get("_scoreTotal")) for s in self_pos_region_map.values())
        pos_score_count = sum(safe_int(s.get("_scoreCount")) for s in self_pos_region_map.values())
        pos_enrolled = sum(safe_int(s.get("_enrolled")) for s in self_pos_region_map.values())
        pos_submitted = sum(safe_int(s.get("_submitted")) for s in self_pos_region_map.values())
        pos_reviewed = sum(safe_int(s.get("_reviewed")) for s in self_pos_region_map.values())
        self_glob["scoreTotal"] += pos_score_total
        self_glob["scoreCount"] += pos_score_count
        self_glob["submitted"] += pos_submitted
        self_glob["reviewed"] += pos_reviewed
        self_glob["enrolled"] += pos_enrolled
        self_glob["storeCount"] += total_store_count
        self_inspection_position_summaries.append({
            "position": pos_label,
            "organizeName": org_name,
            "storeCount": total_store_count,
            "completed": total_completed,
            "expected": total_expected,
            "unfinished": total_unfinished,
            "realExpected": pos_self_real,
            "completionRate": round(total_completed / total_expected * 100, 1) if total_expected > 0 else 0.0,
            "qualified": total_qualified,
            "qualifiedRate": round(total_qualified / total_completed * 100, 1) if total_completed > 0 else 0.0,
            "avgScore": round(pos_score_total / pos_score_count, 2) if pos_score_count > 0 else 0.0,
            "submitRate": round(pos_enrolled / total_store_count * 100, 1) if total_store_count > 0 else 0.0,
            "reviewRate": round(pos_reviewed / pos_submitted * 100, 1) if pos_submitted > 0 else 0.0,
            "regions": sorted(self_pos_region_map.keys()),
        })

        # 自检问题项聚合到全局（优先问题项级别，回退到类别级别）
        self_items = _aggregate_item_rows(zj_item_rows, pos_label) if zj_item_rows \
            else _aggregate_cat_rows(zj_cat_rows, pos_label)
        for item in self_items:
            overview_self_cats[item["category"]] = overview_self_cats.get(item["category"], 0) + item["count"]

        # 7) 视频巡检聚合
        video_rows = api.fetch_video_inspection_reports(token, start_date, end_date)

        # 7.1) 视频稽核问题项明细 —— 供「视频巡检 → 按问题分类」与首页视频高发问题使用
        try:
            sp_items = api.fetch_sp_category_unqualified_info(token, start_date, end_date, max_high_no)
        except Exception:
            sp_items = []
        sp_item_count = len(sp_items or [])
        # 视频稽核门店汇总：门店维度不合格项数
        try:
            sp_store_rows = api.fetch_sp_store_inspection_report(token, start_date, end_date)
        except Exception:
            sp_store_rows = []
        video_pos_region_map, video_store_records = _aggregate_video_regions(
            video_rows, leaves, pos_label, sp_store_rows, sp_item_count)
        for c in (sp_items or []):
            title = (c.get("title") or "").strip()
            if not title:
                continue
            bhg = safe_int(c.get("bxjcsBhg"))
            if bhg <= 0:
                continue
            # 视频巡检接口把所有项的 categoryName 都填成"视频巡检"，真实问题描述在 title 中。
            cat = (c.get("title") or c.get("categoryName") or "视频巡检").strip() or "视频巡检"
            overview_video_cats[cat] = overview_video_cats.get(cat, 0) + bhg
            video_category_details.append({
                "position": pos_label,
                "category": cat,
                "title": title,
                "count": bhg,
                "inspected": safe_int(c.get("bxjcs")),
                "unqualified": bhg,
                "storeCount": safe_int(c.get("bxjmds")),
                "unqStoreCount": safe_int(c.get("bxjmdsBhg")),
            })
        video_pos_region_stores: Dict[str, List[Dict[str, Any]]] = {}
        for s in video_store_records:
            video_all_stores.append(s)
            video_pos_region_stores.setdefault(s["region"], []).append(s)
        for rname, rdata in video_pos_region_map.items():
            if rname not in video_region_map:
                video_region_map[rname] = dict(rdata, stores=[])
            video_region_map[rname]["stores"].extend(video_pos_region_stores.get(rname, []))
        video_scored = [s["score"] for s in video_store_records if s.get("score", 0) > 0]
        video_pos_avg = round(sum(video_scored) / len(video_scored), 2) if video_scored else 0.0
        video_position_summaries.append({
            "position": pos_label,
            "organizeName": org_name,
            "storeCount": total_store_count,
            "inspectedCount": len(video_store_records),
            "avgScore": video_pos_avg,
            "regions": sorted(video_pos_region_map.keys()),
        })

    # Top 问题排序
    overview_regular_top10 = sorted(
        [{"category": k, "count": v} for k, v in overview_regular_cats.items()],
        key=lambda x: -x["count"],
    )[:10]

    overview_self_sorted = sorted(
        [{"category": k, "count": v} for k, v in overview_self_cats.items()],
        key=lambda x: -x["count"],
    )
    overview_self_top3 = overview_self_sorted[:3]

    overview_video_sorted = sorted(
        [{"category": k, "count": v} for k, v in overview_video_cats.items()],
        key=lambda x: -x["count"],
    )

    # 区域排序
    regions = sorted(region_map.values(), key=_region_sort_key)
    self_regions = sorted(self_region_map.values(), key=_region_sort_key)
    video_regions = sorted(video_region_map.values(), key=_region_sort_key)
    stores = sorted(all_stores, key=lambda s: (-s["score"], s["storeName"]))
    self_stores = sorted(self_store_map.values(), key=lambda s: (-s["completed"], s["storeName"]))
    video_stores = sorted(video_all_stores, key=lambda s: (-(s.get("score") or 0), s.get("storeName", "")))
    video_rank_stores = sorted(
        [s for s in video_all_stores if s.get("score", 0) > 0],
        key=lambda s: (-(s.get("score") or 0), s.get("storeName", "")),
    )
    self_rank_stores = sorted(
        [s for s in self_store_map.values() if s["scoreCount"] > 0],
        key=lambda s: (-s["avgScore"], s["storeName"]),
    )

    return {
        "webBase": api.web_base(),
        "startDate": start_date,
        "endDate": end_date,
        "generatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "debug_positions": debug_positions,
        "positions": position_summaries,
        "regions": regions,
        "stores": stores,
        "topCategories": overview_regular_top10,
        "categoryDetails": top_categories,
        "totalStores": sum(p["storeCount"] for p in position_summaries),
        "totalInspected": sum(p["inspectedCount"] for p in position_summaries),
        "selfInspection": {
            "positions": self_inspection_position_summaries,
            "regions": self_regions,
            "stores": self_stores,
            "rankStores": self_rank_stores,
            "topCategories": overview_self_sorted,
            "totalStores": sum(p["storeCount"] for p in self_inspection_position_summaries),
            "totalCompleted": sum(p["completed"] for p in self_inspection_position_summaries),
            "totalExpected": sum(p["expected"] for p in self_inspection_position_summaries),
            "totalUnfinished": sum(p.get("unfinished", 0) for p in self_inspection_position_summaries),
            "realExpected": all(p.get("realExpected") for p in self_inspection_position_summaries),
            "monthLabel": datetime.datetime.now().strftime("%Y-%m"),
            "days": days,
            "totalAvgScore": round(self_glob["scoreTotal"] / self_glob["scoreCount"], 2)
                             if self_glob["scoreCount"] else 0.0,
            "totalReviewRate": round(self_glob["reviewed"] / self_glob["submitted"] * 100, 1)
                               if self_glob["submitted"] else 0.0,
            "totalSubmitRate": round(self_glob["enrolled"] / self_glob["storeCount"] * 100, 1)
                               if self_glob["storeCount"] else 0.0,
        },
        "videoInspection": {
            "positions": video_position_summaries,
            "regions": video_regions,
            "stores": video_stores,
            "rankStores": video_rank_stores,
            "topCategories": overview_video_sorted,
            "categoryDetails": video_category_details,
            "totalStores": sum(p["storeCount"] for p in video_position_summaries),
            "totalInspected": sum(p["inspectedCount"] for p in video_position_summaries),
        },
        "aiInspection": _build_ai_inspection(start_date, end_date),
        "overview": {
            "selfTopCategories": overview_self_top3,
            "regularTopCategories": overview_regular_top10,
            "videoTopCategories": overview_video_sorted[:10],
        },
    }


def _fetch_region_ranking(type_name: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    按指定时间范围拉取常规巡检或每日自检数据，按岗位+区域聚合平均分排名。
    type_name: 'regular' | 'self'
    """
    positions = cfg.TARGET_POSITIONS
    region_list: List[Dict[str, Any]] = []

    for pos_name, org_name in positions:
        try:
            token, matched = api.switch_position_and_login(pos_name, org_name)
            pos_label = cfg.POSITION_LABELS.get(org_name, org_name)
            leaves = api.leaf_regions(token, root_name=org_name)
            # 组织树里的真实区域名，用于把报告行正确归到区域（避免名字与慧运营不一致）
            region_names = {leaf.get("organizeName", "") for leaf in leaves if leaf.get("organizeName")}

            # 用真实门店清单校正门店数：org 树的 currentStoreCount 会把测试门店也算进去，
            # 必须按 /web/md/store/list 全量门店过滤后再计数。
            region_store_counts: Dict[str, int] = {}
            region_valid_codes: Dict[str, set] = {}
            for leaf in leaves:
                rname = leaf.get("organizeName", "")
                if not rname:
                    continue
                try:
                    stores = api.fetch_stores_by_organize(token, leaf.get("organizeId"))
                    # fix15：过滤「测试/删除门店 + 门店状态非正常」，与慧运营「组织门店数」口径一致
                    valid = [s for s in stores if not is_test_store(s.get("fullName", "")) and s.get("storeStatus") not in ("bd", "ty")]
                    region_store_counts[rname] = len(valid)
                    region_valid_codes[rname] = {str(s.get("storeCode", "")).strip() for s in valid if s.get("storeCode")}
                except Exception:
                    region_store_counts[rname] = safe_int(leaf.get("currentStoreCount"))
                    region_valid_codes[rname] = set()

            def _valid_store(region: str, sc: str) -> bool:
                codes = region_valid_codes.get(region)
                if not codes:
                    return True
                return sc in codes

            def _region_store_count(region: str) -> int:
                return region_store_counts.get(region, 0)

            if type_name == "regular":
                # 改用 report/list（planType=CG）按真实日期区间拉取，storeInspectionReport 会跨月混同
                rows = api.fetch_cg_reports(token, start_date, end_date)
                pos_region_stats: Dict[str, Dict[str, Any]] = {}
                for leaf in leaves:
                    rname = leaf.get("organizeName", "")
                    if rname:
                        pos_region_stats[rname] = {
                            "store_count": _region_store_count(rname),
                            "stores": {},  # storeCode -> 最新报告
                        }
                for row in rows:
                    region = match_region(row.get("nameLink", ""), region_names)
                    store_name = row.get("fullName", "")
                    if is_test_store(store_name):
                        continue
                    sc = str(row.get("storeCode", "")).strip()
                    if not sc:
                        continue
                    if not _valid_store(region, sc):
                        continue
                    if region not in pos_region_stats:
                        pos_region_stats[region] = {"store_count": _region_store_count(region), "stores": {}}
                    # 同一门店取区间内最新一份报告
                    existing = pos_region_stats[region]["stores"].get(sc)
                    rd = str(row.get("reportDate", "") or row.get("created", "") or "")
                    if existing is None or rd >= existing.get("_date", ""):
                        score = safe_float(row.get("score"))
                        pos_region_stats[region]["stores"][sc] = {
                            "_date": rd,
                            "storeName": str(row.get("fullName", store_name)).strip(),
                            "storeCode": sc,
                            "score": score,
                            "isPass": bool(row.get("isPass")),
                            "unRectifyNum": safe_int(row.get("unRectifyNum")),
                        }

                for rname, stats in pos_region_stats.items():
                    stores = stats["stores"]
                    inspected = len(stores)
                    scored = [s for s in stores.values() if s["score"] is not None and s["score"] > 0]
                    scores = [s["score"] for s in scored]
                    avg_score = round(sum(scores) / len(scores), 2) if scores else 0.0
                    store_count = stats["store_count"]
                    submit_rate = round(inspected / store_count * 100, 1) if store_count > 0 else 0.0
                    comment_rate = round(len(scored) / inspected * 100, 1) if inspected > 0 else 0.0
                    pass_count = sum(1 for s in stores.values() if s.get("isPass"))
                    qualified_rate = round(pass_count / inspected * 100, 1) if inspected > 0 else 0.0
                    unq_items = sum(s.get("unRectifyNum", 0) for s in stores.values())
                    region_list.append({
                        "region": rname,
                        "position": pos_label,
                        "storeCount": store_count,
                        "inspectedCount": inspected,
                        "avgScore": avg_score,
                        "hasData": len(scored) > 0,
                        "submitRate": submit_rate,
                        "commentRate": comment_rate,
                        "qualifiedRate": qualified_rate,
                        "unqualifiedItems": unq_items,
                        "scoreMin": min(scores) if scores else None,
                        "scoreMax": max(scores) if scores else None,
                    "stores": sorted(stores.values(), key=lambda x: x.get("score") or -1, reverse=True),
                })

            elif type_name == "video":
                # 视频稽核报告列表：与 CG 字段结构类似，按门店取最新一份
                rows = api.fetch_video_inspection_reports(token, start_date, end_date)
                pos_region_stats: Dict[str, Dict[str, Any]] = {}
                for leaf in leaves:
                    rname = leaf.get("organizeName", "")
                    if rname:
                        pos_region_stats[rname] = {
                            "store_count": _region_store_count(rname),
                            "stores": {},  # storeCode -> 最新报告
                        }
                for row in rows:
                    region = match_region(row.get("nameLink", ""), region_names)
                    store_name = row.get("fullName", "")
                    if is_test_store(store_name):
                        continue
                    sc = str(row.get("storeCode", "")).strip()
                    if not sc:
                        continue
                    if not _valid_store(region, sc):
                        continue
                    if region not in pos_region_stats:
                        pos_region_stats[region] = {"store_count": _region_store_count(region), "stores": {}}
                    existing = pos_region_stats[region]["stores"].get(sc)
                    rd = str(row.get("reportDate", "") or row.get("created", "") or "")
                    if existing is None or rd >= existing.get("_date", ""):
                        score = safe_float(row.get("score"))
                        pos_region_stats[region]["stores"][sc] = {
                            "_date": rd,
                            "storeName": str(row.get("fullName", store_name)).strip(),
                            "storeCode": sc,
                            "score": score,
                            "isPass": bool(row.get("isPass")),
                            "unRectifyNum": safe_int(row.get("unRectifyNum")),
                        }

                for rname, stats in pos_region_stats.items():
                    stores = stats["stores"]
                    inspected = len(stores)
                    scored = [s for s in stores.values() if s["score"] is not None and s["score"] > 0]
                    scores = [s["score"] for s in scored]
                    avg_score = round(sum(scores) / len(scores), 2) if scores else 0.0
                    store_count = stats["store_count"]
                    submit_rate = round(inspected / store_count * 100, 1) if store_count > 0 else 0.0
                    comment_rate = round(len(scored) / inspected * 100, 1) if inspected > 0 else 0.0
                    pass_count = sum(1 for s in stores.values() if s.get("isPass"))
                    qualified_rate = round(pass_count / inspected * 100, 1) if inspected > 0 else 0.0
                    unq_items = sum(s.get("unRectifyNum", 0) for s in stores.values())
                    region_list.append({
                        "region": rname,
                        "position": pos_label,
                        "storeCount": store_count,
                        "inspectedCount": inspected,
                        "avgScore": avg_score,
                        "hasData": len(scored) > 0,
                        "submitRate": submit_rate,
                        "commentRate": comment_rate,
                        "qualifiedRate": qualified_rate,
                        "unqualifiedItems": unq_items,
                        "scoreMin": min(scores) if scores else None,
                        "scoreMax": max(scores) if scores else None,
                        "stores": sorted(stores.values(), key=lambda x: x.get("score") or -1, reverse=True),
                    })

            elif type_name == "ai":
                # AI 慧检报告列表（fix54）。字段名以云端真实返回为准，做多候选兜底。
                rows = api.fetch_ai_reports(token, start_date, end_date)
                pos_region_stats: Dict[str, Dict[str, Any]] = {}
                for leaf in leaves:
                    rname = leaf.get("organizeName", "")
                    if rname:
                        pos_region_stats[rname] = {
                            "store_count": _region_store_count(rname),
                            "stores": {},  # storeCode -> 最新报告
                        }
                for row in rows:
                    region = match_region(
                        row.get("nameLink") or row.get("storeName") or row.get("fullName") or "",
                        region_names)
                    store_name = row.get("fullName") or row.get("storeName") or row.get("name") or ""
                    if is_test_store(store_name):
                        continue
                    sc = str(row.get("storeCode") or row.get("code") or "").strip()
                    if not sc:
                        continue
                    if not _valid_store(region, sc):
                        continue
                    if region not in pos_region_stats:
                        pos_region_stats[region] = {"store_count": _region_store_count(region), "stores": {}}
                    existing = pos_region_stats[region]["stores"].get(sc)
                    rd = str(row.get("reportDate") or row.get("created") or row.get("createTime") or "")
                    if existing is None or rd >= existing.get("_date", ""):
                        score = safe_float(
                            row.get("score") or row.get("reportScore") or row.get("avgScore")
                            or row.get("totalScore") or row.get("point"))
                        pos_region_stats[region]["stores"][sc] = {
                            "_date": rd,
                            "storeName": str(store_name).strip(),
                            "storeCode": sc,
                            "score": score,
                            "isPass": bool(row.get("isPass") or row.get("status") in ("合格", "pass", "1", 1)),
                            "unRectifyNum": safe_int(row.get("unRectifyNum") or row.get("rectifyNum")),
                            "reportId": row.get("reportId") or row.get("id"),
                        }

                for rname, stats in pos_region_stats.items():
                    stores = stats["stores"]
                    inspected = len(stores)
                    scored = [s for s in stores.values() if s["score"] is not None and s["score"] > 0]
                    scores = [s["score"] for s in scored]
                    avg_score = round(sum(scores) / len(scores), 2) if scores else 0.0
                    store_count = stats["store_count"]
                    submit_rate = round(inspected / store_count * 100, 1) if store_count > 0 else 0.0
                    comment_rate = round(len(scored) / inspected * 100, 1) if inspected > 0 else 0.0
                    pass_count = sum(1 for s in stores.values() if s.get("isPass"))
                    qualified_rate = round(pass_count / inspected * 100, 1) if inspected > 0 else 0.0
                    unq_items = sum(s.get("unRectifyNum", 0) for s in stores.values())
                    region_list.append({
                        "region": rname,
                        "position": pos_label,
                        "storeCount": store_count,
                        "inspectedCount": inspected,
                        "avgScore": avg_score,
                        "hasData": len(scored) > 0,
                        "submitRate": submit_rate,
                        "commentRate": comment_rate,
                        "qualifiedRate": qualified_rate,
                        "unqualifiedItems": unq_items,
                        "scoreMin": min(scores) if scores else None,
                        "scoreMax": max(scores) if scores else None,
                        "stores": sorted(stores.values(), key=lambda x: x.get("score") or -1, reverse=True),
                    })

            else:  # self
                self_rows = api.fetch_self_inspection_reports(token, start_date, end_date)
                pos_region_stats: Dict[str, Dict[str, Any]] = {}
                for leaf in leaves:
                    rname = leaf.get("organizeName", "")
                    if rname:
                        pos_region_stats[rname] = {
                            "store_count": _region_store_count(rname),
                            "stores": {},  # storeCode -> 最新报告
                        }
                for r in self_rows:
                    store_name = r.get("fullName", "")
                    if is_test_store(store_name):
                        continue
                    region = match_region(r.get("nameLink", ""), region_names)
                    sc = str(r.get("storeCode", "")).strip()
                    if not sc:
                        continue
                    if not _valid_store(region, sc):
                        continue
                    if region not in pos_region_stats:
                        pos_region_stats[region] = {"store_count": _region_store_count(region), "stores": {}}
                    existing = pos_region_stats[region]["stores"].get(sc)
                    rd = str(r.get("reportDate", "") or r.get("created", "") or "")
                    if existing is None or rd >= existing.get("_date", ""):
                        # 慧运营自检报告的 score 字段：未点评时是字符串「未点评」，
                        # 已点评时是数字（含真实打 0 分的）。所以「有没有被点评」
                        # 必须靠这个标记判断，用 score>0 会把打 0 分的算成未点评。
                        raw_score = r.get("score")
                        is_reviewed = raw_score is not None and str(raw_score).strip() != cfg.UNREVIEWED_MARK
                        s_score = safe_float(raw_score, None) if is_reviewed else None
                        if s_score is None:
                            s_score = safe_float(r.get("zjScore"), None)
                        pos_region_stats[region]["stores"][sc] = {
                            "_date": rd,
                            "storeName": str(r.get("fullName", store_name)).strip(),
                            "storeCode": sc,
                            "score": s_score,
                            "reviewed": is_reviewed,
                            "isPass": bool(r.get("isPass")),
                            "unRectifyNum": safe_int(r.get("unRectifyNum")),
                        }

                # 用「门店完成率汇总」拿真实的完成/合格/不合格数
                comp_by_region: Dict[str, Dict[str, Any]] = {}
                try:
                    organize_id = matched.get("organizeId")
                    if organize_id:
                        completion = _fetch_self_completion(token, start_date, end_date, organize_id)
                        for rec in completion.values():
                            rname = rec.get("region", "")
                            if not rname:
                                continue
                            bucket = comp_by_region.setdefault(rname, {
                                "completed": 0, "expected": 0, "qualified": 0, "unqualified": 0,
                                "scoreTotal": 0.0, "scoreCount": 0,
                            })
                            bucket["completed"] += safe_int(rec.get("completed"))
                            bucket["expected"] += safe_int(rec.get("expected"))
                            bucket["qualified"] += safe_int(rec.get("qualified"))
                            bucket["unqualified"] += safe_int(rec.get("unqualified"))
                            if rec.get("scoreCount", 0) > 0:
                                bucket["scoreTotal"] += safe_float(rec.get("scoreTotal"), 0.0)
                                bucket["scoreCount"] += safe_int(rec.get("scoreCount"))
                except Exception:
                    traceback.print_exc()

                for rname, stats in pos_region_stats.items():
                    stores = stats["stores"]
                    inspected = len(stores)
                    scored = [s for s in stores.values() if s["score"] is not None and s["score"] > 0]
                    scores = [s["score"] for s in scored]
                    # 点评率 = 已被点评的门店数 / 已提交门店数（不是「有得分」，打 0 分也算已点评）
                    reviewed = [s for s in stores.values() if s.get("reviewed")]
                    avg_score = round(sum(scores) / len(scores), 2) if scores else 0.0
                    store_count = stats["store_count"]
                    submit_rate = round(inspected / store_count * 100, 1) if store_count > 0 else 0.0
                    comment_rate = round(len(reviewed) / inspected * 100, 1) if inspected > 0 else 0.0
                    pass_count = sum(1 for s in stores.values() if s.get("isPass"))
                    fallback_qualified_rate = round(pass_count / inspected * 100, 1) if inspected > 0 else 0.0
                    fallback_unq = sum(s.get("unRectifyNum", 0) for s in stores.values())

                    comp = comp_by_region.get(rname)
                    if comp and comp.get("expected", 0) > 0:
                        completion_rate = round(comp["completed"] / comp["expected"] * 100, 1)
                        total_qu = comp["qualified"] + comp["unqualified"]
                        qualified_rate = round(comp["qualified"] / total_qu * 100, 1) if total_qu > 0 else fallback_qualified_rate
                        unq_items = comp["unqualified"]
                        if comp.get("scoreCount", 0) > 0:
                            avg_score = round(comp["scoreTotal"] / comp["scoreCount"], 2)
                    else:
                        completion_rate = submit_rate
                        qualified_rate = fallback_qualified_rate
                        unq_items = fallback_unq

                    region_list.append({
                        "region": rname,
                        "position": pos_label,
                        "storeCount": store_count,
                        "inspectedCount": inspected,
                        "avgScore": avg_score,
                        "hasData": len(scored) > 0,
                        "submitRate": submit_rate,
                        "commentRate": comment_rate,
                        "completionRate": completion_rate,
                        "qualifiedRate": qualified_rate,
                        "unqualifiedItems": unq_items,
                        "scoreMin": min(scores) if scores else None,
                        "scoreMax": max(scores) if scores else None,
                        "stores": sorted(stores.values(), key=lambda x: x.get("score") or -1, reverse=True),
                    })

        except Exception as e:
            traceback.print_exc()
            raise RuntimeError(f"拉取区域排名 {type_name}/{pos_name}/{org_name} 失败: {e}")

    region_list.sort(key=_region_sort_key)
    return region_list


def _fetch_self_trends(start_date: str, end_date: str, group_by: str = "position") -> Dict[str, Any]:
    """
    拉取每日自检趋势数据，按日期聚合每个岗位（position）或每个区域（region）的完成数与合格数。
    返回：dates, series[{name, data}], kpi{totalCompleted, totalQualified, avgDailyCompleted, qualifiedRate}
    """
    positions = cfg.TARGET_POSITIONS
    all_rows: List[Dict[str, Any]] = []
    for pos_name, org_name in positions:
        try:
            token, matched = api.switch_position_and_login(pos_name, org_name)
            rows = api.fetch_self_inspection_reports(token, start_date, end_date)
            pos_label = cfg.POSITION_LABELS.get(org_name, org_name)
            for r in rows:
                r["_position"] = pos_label
                r["_region"] = extract_region(r.get("nameLink", ""))
                all_rows.append(r)
        except Exception:
            traceback.print_exc()

    # 生成日期序列
    s = datetime.datetime.strptime(start_date, "%Y-%m-%d").date()
    e = datetime.datetime.strptime(end_date, "%Y-%m-%d").date()
    dates = []
    d = s
    while d <= e:
        dates.append(d.strftime("%Y-%m-%d"))
        d += datetime.timedelta(days=1)

    # 按岗位 / 区域聚合：每天 completed / qualified
    key_attr = "_region" if group_by == "region" else "_position"
    by_group: Dict[str, Dict[str, Dict[str, int]]] = {}
    total_completed = 0
    total_qualified = 0
    for r in all_rows:
        key = r.get(key_attr, "其他") or "其他"
        rd = str(r.get("reportDate", "")).strip()[:10]
        if not rd or rd not in dates:
            continue
        if key not in by_group:
            by_group[key] = {dt: {"completed": 0, "qualified": 0} for dt in dates}
        by_group[key][rd]["completed"] += 1
        total_completed += 1
        is_pass = r.get("isPass")
        if is_pass is True:
            by_group[key][rd]["qualified"] += 1
            total_qualified += 1

    # 系列排序：岗位模式按固定岗位顺序；区域模式按总完成数降序
    if group_by == "region":
        sorted_keys = sorted(by_group.keys(), key=lambda k: -sum(v["completed"] for v in by_group[k].values()))
    else:
        position_order = ["培训组（直营组）", "新店运营组", "加盟营运组", "新店筹备组"]
        sorted_keys = sorted(by_group.keys(), key=lambda x: position_order.index(x) if x in position_order else 99)

    series = []
    for key in sorted_keys:
        series.append({
            "name": key,
            "data": [by_group[key][dt]["completed"] for dt in dates],
        })

    days = max(1, len(dates))
    qualified_rate = round(total_qualified / total_completed * 100, 1) if total_completed > 0 else 0.0
    return {
        "dates": dates,
        "series": series,
        "kpi": {
            "totalCompleted": total_completed,
            "totalQualified": total_qualified,
            "avgDailyCompleted": round(total_completed / days, 1),
            "qualifiedRate": qualified_rate,
        },
    }


def _fetch_video_trends(start_date: str, end_date: str, group_by: str = "position") -> Dict[str, Any]:
    """
    拉取视频巡检趋势数据，按日期聚合每个岗位（position）或每个区域（region）的完成数与合格数。
    返回：dates, series[{name, data}], kpi{totalCompleted, totalQualified, avgDailyCompleted, qualifiedRate}
    """
    positions = cfg.TARGET_POSITIONS
    all_rows: List[Dict[str, Any]] = []
    for pos_name, org_name in positions:
        try:
            token, matched = api.switch_position_and_login(pos_name, org_name)
            rows = api.fetch_video_inspection_reports(token, start_date, end_date)
            pos_label = cfg.POSITION_LABELS.get(org_name, org_name)
            for r in rows:
                r["_position"] = pos_label
                r["_region"] = extract_region(r.get("nameLink", ""))
                all_rows.append(r)
        except Exception:
            traceback.print_exc()

    s = datetime.datetime.strptime(start_date, "%Y-%m-%d").date()
    e = datetime.datetime.strptime(end_date, "%Y-%m-%d").date()
    dates = []
    d = s
    while d <= e:
        dates.append(d.strftime("%Y-%m-%d"))
        d += datetime.timedelta(days=1)

    key_attr = "_region" if group_by == "region" else "_position"
    by_group: Dict[str, Dict[str, Dict[str, int]]] = {}
    total_completed = 0
    total_qualified = 0
    for r in all_rows:
        key = r.get(key_attr, "其他") or "其他"
        rd = str(r.get("reportDate", "")).strip()[:10]
        if not rd or rd not in dates:
            continue
        if key not in by_group:
            by_group[key] = {dt: {"completed": 0, "qualified": 0} for dt in dates}
        by_group[key][rd]["completed"] += 1
        total_completed += 1
        is_pass = r.get("isPass")
        if is_pass is True:
            by_group[key][rd]["qualified"] += 1
            total_qualified += 1

    if group_by == "region":
        sorted_keys = sorted(by_group.keys(), key=lambda k: -sum(v["completed"] for v in by_group[k].values()))
    else:
        position_order = ["培训组（直营组）", "新店运营组", "加盟营运组", "新店筹备组"]
        sorted_keys = sorted(by_group.keys(), key=lambda x: position_order.index(x) if x in position_order else 99)

    series = []
    for key in sorted_keys:
        series.append({
            "name": key,
            "data": [by_group[key][dt]["completed"] for dt in dates],
        })

    days = max(1, len(dates))
    qualified_rate = round(total_qualified / total_completed * 100, 1) if total_completed > 0 else 0.0
    return {
        "dates": dates,
        "series": series,
        "kpi": {
            "totalCompleted": total_completed,
            "totalQualified": total_qualified,
            "avgDailyCompleted": round(total_completed / days, 1),
            "qualifiedRate": qualified_rate,
        },
    }


def _get_or_build_region_ranking(type_name: str, period: str) -> List[Dict[str, Any]]:
    """带缓存的区域排名计算。"""
    with region_ranking_lock:
        cached = region_ranking_cache.get(type_name, {}).get(period)
        if cached:
            return cached

    if period == "thisWeek":
        start, end = this_week_range()
    elif period == "lastWeek":
        start, end = last_week_range()
    elif period == "thisMonth":
        start, end = current_month_range()
    elif period == "lastMonth":
        start, end = last_month_range()
    else:
        start, end = this_week_range()

    data = _fetch_region_ranking(type_name, start, end)

    with region_ranking_lock:
        region_ranking_cache.setdefault(type_name, {})[period] = data
    return data


def _merge_region_rankings(reg_list: List[Dict[str, Any]],
                           self_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把常规巡检与门店自检的区域排名合并为「全部类型」视图。"""
    reg_map = {r["region"]: r for r in reg_list}
    self_map = {r["region"]: r for r in self_list}
    regions = sorted(set(reg_map.keys()) | set(self_map.keys()))
    out: List[Dict[str, Any]] = []
    for region in regions:
        reg = reg_map.get(region, {})
        slf = self_map.get(region, {})
        store_count = reg.get("storeCount") or slf.get("storeCount") or 0
        reg_inspected = reg.get("inspectedCount", 0)
        self_inspected = slf.get("inspectedCount", 0)
        inspected_count = reg_inspected + self_inspected
        unq_items = (reg.get("unqualifiedItems") or 0) + (slf.get("unqualifiedItems") or 0)
        completion_rate = slf.get("completionRate")

        def _weighted(a, wa, b, wb):
            total = wa + wb
            if total <= 0:
                return None
            return round(((a or 0) * wa + (b or 0) * wb) / total, 1)

        qualified_rate = _weighted(reg.get("qualifiedRate"), reg_inspected,
                                   slf.get("qualifiedRate"), self_inspected)
        comment_rate = _weighted(reg.get("commentRate"), reg_inspected,
                                 slf.get("commentRate"), self_inspected)

        if reg.get("avgScore") is not None and slf.get("avgScore") is not None:
            if inspected_count > 0:
                avg_score = round((reg["avgScore"] * reg_inspected + slf["avgScore"] * self_inspected)
                                  / inspected_count, 2)
            else:
                avg_score = reg["avgScore"]
        elif reg.get("avgScore") is not None:
            avg_score = reg["avgScore"]
        elif slf.get("avgScore") is not None:
            avg_score = slf["avgScore"]
        else:
            avg_score = None

        mins = [x for x in [reg.get("scoreMin"), slf.get("scoreMin")] if x is not None]
        maxs = [x for x in [reg.get("scoreMax"), slf.get("scoreMax")] if x is not None]

        # 合并常规 + 自检门店清单（同一门店按 storeCode 去重）
        merged_stores: Dict[str, Dict[str, Any]] = {}
        for s in reg.get("stores", []):
            sc = s.get("storeCode")
            if not sc:
                continue
            merged_stores[sc] = {
                "storeName": s.get("storeName", ""),
                "storeCode": sc,
                "regularScore": s.get("score"),
                "regularIsPass": s.get("isPass"),
                "regularUnq": s.get("unRectifyNum", 0),
                "selfScore": None,
                "selfIsPass": None,
                "selfUnq": 0,
            }
        for s in slf.get("stores", []):
            sc = s.get("storeCode")
            if not sc:
                continue
            if sc in merged_stores:
                merged_stores[sc]["selfScore"] = s.get("score")
                merged_stores[sc]["selfIsPass"] = s.get("isPass")
                merged_stores[sc]["selfUnq"] = s.get("unRectifyNum", 0)
            else:
                merged_stores[sc] = {
                    "storeName": s.get("storeName", ""),
                    "storeCode": sc,
                    "regularScore": None,
                    "regularIsPass": None,
                    "regularUnq": 0,
                    "selfScore": s.get("score"),
                    "selfIsPass": s.get("isPass"),
                    "selfUnq": s.get("unRectifyNum", 0),
                }
        merged_store_list = sorted(merged_stores.values(), key=lambda x: (x.get("regularScore") or 0) + (x.get("selfScore") or 0), reverse=True)

        out.append({
            "region": region,
            "position": reg.get("position") or slf.get("position") or "",
            "storeCount": store_count,
            "inspectedCount": inspected_count,
            "unqualifiedItems": unq_items,
            "completionRate": completion_rate,
            "qualifiedRate": qualified_rate,
            "commentRate": comment_rate,
            "avgScore": avg_score,
            "hasData": avg_score is not None,
            "scoreMin": min(mins) if mins else None,
            "scoreMax": max(maxs) if maxs else None,
            "stores": merged_store_list,
        })
    out.sort(key=lambda x: (-(x["avgScore"] if x["avgScore"] is not None else -1), x["region"]))
    return out


# ============================================================
# 不合格明细（问题项 / 门店 / 区域 / 分类 多维度下钻）
# ============================================================

unqualified_cache: Dict[str, Any] = {
    "key": None,
    "data": None,
    "ts": 0.0,
}
unqualified_lock = threading.Lock()


def _fetch_item_store_map(token: str, item_rows: List[Dict[str, Any]], start_date: str,
                          end_date: str, max_high_no: int,
                          workers: int = 12) -> Dict[Any, List[Dict[str, Any]]]:
    """
    并发拉取每个「巡检问题项」的不合格门店清单。

    慧运营需要按问题项逐个下钻（/statRi/.../categoryUnqualifiedInfo/storeList），
    串行会很慢，这里用线程池并发。只对确实有不合格的项发起请求。
    """
    from concurrent.futures import ThreadPoolExecutor

    targets = [r for r in item_rows if safe_int(r.get("bxjcsBhg")) > 0]
    results: Dict[Any, List[Dict[str, Any]]] = {}

    def work(row):
        cid = row.get("contentId")
        try:
            lst = api.fetch_cg_item_store_list(token, row, start_date, end_date, max_high_no)
        except Exception:
            lst = []
        return cid, lst

    if not targets:
        return results
    with ThreadPoolExecutor(max_workers=min(workers, len(targets))) as ex:
        for cid, lst in ex.map(work, targets):
            results[cid] = lst
    return results


def _rate(num: float, den: float) -> float:
    """不合格率，返回 0~1 的小数。"""
    if den <= 0:
        return 0.0
    return round(num / den, 4)


def _build_unqualified_detail(start_date: str, end_date: str) -> Dict[str, Any]:
    """
    构建「不合格明细」全量数据。

    数据来源（全部为常规巡检 planType=CG）：
      - categoryUnqualifiedInfo  问题项级：title / categoryName / 不合格次数 / 不合格门店数
      - categoryUnqualifiedTotal 分类×区域级：巡检次数 / 不合格次数 / 门店数
      - storeList（按问题项下钻） 该问题项在哪些门店不合格、各不合格几次

    输出 5 个维度：byItem / byStore / byRegion / byCategory / storeTopItems
    """
    positions = cfg.TARGET_POSITIONS

    items: Dict[Any, Dict[str, Any]] = {}        # contentId -> 问题项聚合
    cats: Dict[str, Dict[str, Any]] = {}         # 分类 -> 聚合
    regions: Dict[str, Dict[str, Any]] = {}      # 区域 -> 聚合
    store_items: Dict[str, Dict[str, Any]] = {}  # 门店 -> {contentId: 次数}
    store_meta: Dict[str, Dict[str, str]] = {}   # 门店 -> region / position
    store_rank: Dict[str, Dict[str, Any]] = {}   # 门店 -> 分数排名原始数据
    region_rank: Dict[str, Dict[str, Any]] = {}  # 区域 -> 分数排名聚合
    category_store_map: Dict[str, Dict[str, int]] = {}  # 分类 -> {门店: 次数}
    item_store_detail: Dict[Any, Dict[str, int]] = {}   # contentId -> {门店: 次数}

    for pos_name, org_name in positions:
        try:
            token, matched = api.switch_position_and_login(pos_name, org_name)
        except Exception:
            traceback.print_exc()
            continue
        pos_label = cfg.POSITION_LABELS.get(org_name, org_name)

        try:
            org_info = api.all_org_info(token)
            max_high_no = safe_int(org_info.get("maxHighNo"), 4)
        except Exception:
            max_high_no = 4

        region_names = set()
        try:
            region_names = {lv.get("organizeName", "") for lv in api.leaf_regions(token, root_name=org_name)}
            region_names.discard("")
        except Exception:
            region_names = set()

        # 1) 问题项级
        try:
            item_rows = api.fetch_category_unqualified_info(token, start_date, end_date, max_high_no)
        except Exception:
            traceback.print_exc()
            item_rows = []

        # 2) 分类×区域级
        try:
            cat_rows = api.fetch_category_unqualified_total(token, start_date, end_date, max_high_no)
        except Exception:
            traceback.print_exc()
            cat_rows = []

        # 3) 门店 -> 区域 / 分数（用报告列表，不用 storeInspectionReport）
        #
        # 重要：/web/ri/cg/stat/storeInspectionReport 被慧运营后端硬限制为最多 20 行，
        # 无论 pageNumber/pageSize 传什么都只返回 20 条。加盟营运组实际有 88 家门店被巡检，
        # 该接口只能看到 20 家。而 /web/ri/report/list 是完整分页的，所以这里改用报告列表，
        # 既拿区域归属也拿门店分数，口径才是全量的。
        try:
            cg_reports = api.fetch_cg_reports(token, start_date, end_date)
        except Exception:
            traceback.print_exc()
            cg_reports = []

        # 本岗位在区间内有报告的真实门店集合（用于过滤下钻结果）
        scope_stores: set = set()
        for rep in cg_reports:
            sname = (rep.get("fullName") or "").strip()
            if not sname or is_test_store(sname):
                continue
            scope_stores.add(sname)
            region = match_region(rep.get("nameLink", ""), region_names) or "未分配区域"
            store_meta[sname] = {"region": region, "position": pos_label}

            sc = safe_float(rep.get("score"), None)
            rdate = str(rep.get("reportDate") or "")
            rk = store_rank.setdefault(sname, {
                "store": sname,
                "region": region,
                "position": pos_label,
                "latestScore": None,
                "latestDate": "",
                "reportCount": 0,
                "unqReports": 0,
                "reportId": rep.get("reportId"),
                "signId": rep.get("signId"),
            })
            rk["reportCount"] += 1
            if str(rep.get("isPassString") or "") == "不合格":
                rk["unqReports"] += 1
            if sc is not None and rdate >= rk["latestDate"]:
                rk["latestScore"] = sc
                rk["latestDate"] = rdate
                rk["reportId"] = rep.get("reportId")
                rk["signId"] = rep.get("signId")

        # 4) 每个问题项的不合格门店
        store_map = _fetch_item_store_map(token, item_rows, start_date, end_date, max_high_no)

        # --- 聚合：问题项 + 门店（来自问题项下钻） ---
        #
        # 注意：categoryUnqualifiedInfo 的 bxjcsBhg 是「不合格门店数」而不是「不合格次数」。
        # 真实的不合格次数需要从 storeList 下钻里把每家门店的 num 加起来。
        # 门店范围用本岗位的报告列表过滤，避免下钻把跨岗位/跨区域的门店带进来。
        for r in item_rows:
            cid = r.get("contentId")
            if cid is None:
                continue
            ins = safe_int(r.get("bxjcs"))
            rec = items.setdefault(cid, {
                "contentId": cid,
                "title": (r.get("title") or "").strip(),
                "category": r.get("categoryName") or "未分类",
                "inspectCount": 0,
                "unqCount": 0,
                "storeCount": 0,
                "positions": set(),
            })
            rec["inspectCount"] += ins
            rec["positions"].add(pos_label)

            for s in store_map.get(cid, []):
                sname = (s.get("organizeName") or "").strip()
                if not sname or is_test_store(sname) or sname not in scope_stores:
                    continue
                num = safe_int(s.get("num"), 1) or 1

                # 问题项维度：真实不合格次数 / 涉及门店数
                rec["unqCount"] += num
                rec["storeCount"] += 1

                # 门店维度：每家门店涉及的问题项及次数
                bucket = store_items.setdefault(sname, {})
                bucket[cid] = max(num, bucket.get(cid, 0))
                store_meta.setdefault(sname, {"region": "", "position": pos_label})

                # 分类维度：每个分类下各门店的出现次数
                csm = category_store_map.setdefault(rec["category"], {})
                csm[sname] = csm.get(sname, 0) + num

                # 问题项维度：每个问题项下各门店的出现次数（用于弹窗明细）
                isd = item_store_detail.setdefault(cid, {})
                isd[sname] = isd.get(sname, 0) + num

        # --- 聚合：分类 × 区域 ---
        for r in cat_rows:
            cname = r.get("categoryName") or "未分类"
            region = match_region(r.get("nameLink"), region_names) if region_names \
                else extract_region(r.get("nameLink"))
            ins = safe_int(r.get("bxjcs"))
            unq = safe_int(r.get("bxjcsBhg"))
            mds = safe_int(r.get("bxjmds"))
            mds_bhg = safe_int(r.get("bxjmdsBhg"))

            c = cats.setdefault(cname, {
                "category": cname,
                "inspectCount": 0,
                "unqCount": 0,
                "storeCount": 0,
                "storeUnqCount": 0,
            })
            c["inspectCount"] += ins
            c["unqCount"] += unq
            c["storeCount"] = max(c["storeCount"], mds)
            c["storeUnqCount"] = max(c["storeUnqCount"], mds_bhg)

            g = regions.setdefault(region, {
                "region": region,
                "inspectCount": 0,
                "unqCount": 0,
                "storeCount": 0,
                "storeUnqCount": 0,
                "positions": set(),
            })
            g["inspectCount"] += ins
            g["unqCount"] += unq
            g["storeCount"] = max(g["storeCount"], mds)
            g["storeUnqCount"] = max(g["storeUnqCount"], mds_bhg)
            g["positions"].add(pos_label)

    # --- 自检报告门店分数聚合（用于「全部类型 / 每日自检」门店排名） ---
    self_store_rank: Dict[str, Dict[str, Any]] = {}
    for pos_name, org_name in positions:
        try:
            token, matched = api.switch_position_and_login(pos_name, org_name)
        except Exception:
            traceback.print_exc()
            continue
        pos_label = cfg.POSITION_LABELS.get(org_name, org_name)
        try:
            region_names = {lv.get("organizeName", "") for lv in api.leaf_regions(token, root_name=org_name)}
            region_names.discard("")
        except Exception:
            region_names = set()
        try:
            self_rows = api.fetch_self_inspection_reports(token, start_date, end_date)
        except Exception:
            traceback.print_exc()
            self_rows = []
        for rep in self_rows:
            sname = (rep.get("fullName") or "").strip()
            if not sname or is_test_store(sname):
                continue
            region = match_region(rep.get("nameLink", ""), region_names) or "未分配区域"
            raw_score = rep.get("score")
            if raw_score == cfg.UNREVIEWED_MARK or raw_score is None:
                continue
            sc = safe_float(raw_score, None)
            if sc is None:
                continue
            rk = self_store_rank.setdefault(sname, {
                "store": sname, "region": region, "position": pos_label,
                "latestScore": None, "latestDate": "", "reportCount": 0,
                "reportId": rep.get("reportId"),
            })
            rk["reportCount"] += 1
            rdate = str(rep.get("reportDate") or "")
            if rdate >= rk["latestDate"]:
                rk["latestScore"] = sc
                rk["latestDate"] = rdate
                rk["reportId"] = rep.get("reportId")

    # --- 用门店巡检数据补齐门店所属区域/岗位 ---
    for sname, meta in store_meta.items():
        if meta.get("region"):
            continue
        meta["region"] = _lookup_store_region(sname) or "未分配区域"

    # --- 输出：按问题分类 ---
    by_item = []
    for rec in items.values():
        ins = rec["inspectCount"]
        unq = rec["unqCount"]
        by_item.append({
            "contentId": rec["contentId"],
            "title": rec["title"],
            "category": rec["category"],
            "inspectCount": ins,
            "unqCount": unq,
            "storeCount": rec["storeCount"],
            "unqRate": _rate(unq, ins),
            "position": " / ".join(sorted(rec["positions"])) or "-",
        })
    by_item.sort(key=lambda x: (-x["unqCount"], -x["storeCount"], x["title"]))

    # --- 输出：按门店分类 ---
    by_store = []
    for sname, bucket in store_items.items():
        total = sum(bucket.values())
        item_lookup = {i["contentId"]: i for i in by_item}
        top = []
        for cid, num in bucket.items():
            info = item_lookup.get(cid)
            if not info:
                continue
            top.append({"contentId": cid, "title": info["title"], "category": info["category"], "count": num})
        top.sort(key=lambda x: (-x["count"], x["title"]))
        meta = store_meta.get(sname, {})
        by_store.append({
            "store": sname,
            "region": meta.get("region") or "未分配区域",
            "position": meta.get("position") or "-",
            "unqCount": total,
            "itemCount": len(bucket),
            "topItems": top[:5],
        })
    by_store.sort(key=lambda x: (-x["unqCount"], -x["itemCount"], x["store"]))

    # --- 输出：按区域分类 ---
    # unqCount 用门店下钻的真实不合格次数聚合，保证与按门店/问题口径一致；
    # inspectCount 仍取自慧运营的区域汇总（巡检次数）。
    region_unq: Dict[str, int] = {}
    region_store_unq: Dict[str, int] = {}
    for b in by_store:
        region_unq[b["region"]] = region_unq.get(b["region"], 0) + b["unqCount"]
        region_store_unq[b["region"]] = region_store_unq.get(b["region"], 0) + 1

    by_region = []
    for g in regions.values():
        unq = region_unq.get(g["region"], 0)
        by_region.append({
            "region": g["region"],
            "inspectCount": g["inspectCount"],
            "unqCount": unq,
            "storeUnqCount": region_store_unq.get(g["region"], 0),
            "unqRate": _rate(unq, g["inspectCount"]),
            "position": " / ".join(sorted(g["positions"])) or "-",
        })
    by_region.sort(key=lambda x: (-x["unqCount"], x["region"]))

    # --- 输出：巡检类型（分类）高发 ---
    # 从问题项聚合，避免 categoryUnqualifiedTotal 的 bxjcsBhg 口径与门店侧不一致。
    cat_agg: Dict[str, Dict[str, Any]] = {}
    for i in by_item:
        c = cat_agg.setdefault(i["category"], {
            "inspectCount": 0,
            "unqCount": 0,
            "storeCount": 0,
            "positions": set(),
        })
        c["inspectCount"] += i["inspectCount"]
        c["unqCount"] += i["unqCount"]
        c["storeCount"] += i["storeCount"]
        # by_item 把岗位合并成了 " / " 连接的字符串，这里拆回集合
        for p in (i.get("position") or "").split(" / "):
            p = p.strip()
            if p:
                c["positions"].add(p)
    by_category = []
    for cname, c in cat_agg.items():
        by_category.append({
            "category": cname,
            "inspectCount": c["inspectCount"],
            "unqCount": c["unqCount"],
            "storeUnqCount": c["storeCount"],
            "unqRate": _rate(c["unqCount"], c["inspectCount"]),
            "positions": sorted(c["positions"]),
        })
    by_category.sort(key=lambda x: (-x["unqCount"], x["category"]))

    # --- 输出：门店高发问题（展开用） ---
    store_top: Dict[str, List[Dict[str, Any]]] = {}
    for s in by_store:
        store_top[s["store"]] = s["topItems"]

    # --- 输出：门店分数排名 ---
    store_rank_list = []
    for rk in store_rank.values():
        store_rank_list.append({
            "store": rk["store"],
            "region": rk["region"],
            "position": rk["position"],
            "avgScore": rk["latestScore"],
            "reportCount": rk["reportCount"],
            "unqReports": rk["unqReports"],
            "lastDate": rk["latestDate"],
            "reportId": rk["reportId"],
            "signId": rk["signId"],
            "planType": "CG",
        })
    store_rank_list.sort(key=lambda x: (-(x["avgScore"] if x["avgScore"] is not None else -1),
                                        x["store"]))

    # --- 输出：区域分数排名 ---
    # 先按区域汇总不合格次数，避免在门店循环里重复累加
    region_unq: Dict[str, int] = {}
    for b in by_store:
        region_unq[b["region"]] = region_unq.get(b["region"], 0) + b["unqCount"]

    for rk in store_rank.values():
        avg = rk["latestScore"]
        if avg is None:
            continue
        g = region_rank.setdefault(rk["region"], {
            "region": rk["region"],
            "scoreSum": 0.0,
            "scoreCount": 0,
            "storeCount": 0,
            "reportCount": 0,
            "unqCount": 0,
            "needRectify": 0,
            "rectified": 0,
            "minScore": None,
            "maxScore": None,
        })
        g["scoreSum"] += avg
        g["scoreCount"] += 1
        g["storeCount"] += 1
        g["reportCount"] += rk["reportCount"]
        g["needRectify"] += rk.get("needRectify", 0)
        g["rectified"] += rk.get("rectified", 0)
        g["minScore"] = avg if g["minScore"] is None else min(g["minScore"], avg)
        g["maxScore"] = avg if g["maxScore"] is None else max(g["maxScore"], avg)

    for name, g in region_rank.items():
        g["unqCount"] = region_unq.get(name, 0)

    region_rank_list = []
    for g in region_rank.values():
        scored = g["scoreCount"]
        avg = round(g["scoreSum"] / scored, 2) if scored else None
        rectify_rate = _rate(g["rectified"], g["needRectify"]) if g["needRectify"] > 0 else 0.0
        region_rank_list.append({
            "region": g["region"],
            "avgScore": avg,
            "scoredStoreCount": scored,
            "storeCount": g["storeCount"],
            "reportCount": g["reportCount"],
            "unqCount": g["unqCount"],
            "needRectify": g["needRectify"],
            "rectified": g["rectified"],
            "rectifyRate": rectify_rate,
            "minScore": g["minScore"],
            "maxScore": g["maxScore"],
        })
    region_rank_list.sort(key=lambda x: (-(x["avgScore"] if x["avgScore"] is not None else -1),
                                         x["region"]))

    # --- 自检门店排名 ---
    self_store_rank_list = []
    for rk in self_store_rank.values():
        if rk["latestScore"] is None:
            continue
        self_store_rank_list.append({
            "store": rk["store"],
            "region": rk["region"],
            "position": rk["position"],
            "avgScore": rk["latestScore"],
            "reportCount": rk["reportCount"],
            "lastDate": rk["latestDate"],
            "reportId": rk["reportId"],
            "type": "self",
            "planType": "ZJ",
        })
    self_store_rank_list.sort(key=lambda x: (-x["avgScore"], x["store"]))

    # --- 全类型门店排名（CG + 自检）---
    # 展示规则：区间内 CG 与自检谁更晚，就显示谁的最新得分；
    # reportId/signId 也跟随更晚的那个类型，便于跳转对应报告。
    all_store_map: Dict[str, Dict[str, Any]] = {}
    for rk in store_rank_list:
        all_store_map[rk["store"]] = {
            "store": rk["store"],
            "region": rk["region"],
            "position": rk["position"],
            "cgScore": rk["avgScore"],
            "cgDate": rk["lastDate"] or "",
            "cgReportId": rk.get("reportId"),
            "cgSignId": rk.get("signId"),
            "cgCount": rk["reportCount"],
            "selfScore": None,
            "selfDate": "",
            "selfReportId": None,
            "selfCount": 0,
        }
    for rk in self_store_rank_list:
        s = rk["store"]
        if s in all_store_map:
            all_store_map[s]["selfScore"] = rk["avgScore"]
            all_store_map[s]["selfDate"] = rk["lastDate"] or ""
            all_store_map[s]["selfReportId"] = rk.get("reportId")
            all_store_map[s]["selfCount"] = rk["reportCount"]
        else:
            all_store_map[s] = {
                "store": s,
                "region": rk["region"],
                "position": rk["position"],
                "cgScore": None, "cgDate": "", "cgReportId": None, "cgSignId": None, "cgCount": 0,
                "selfScore": rk["avgScore"],
                "selfDate": rk["lastDate"] or "",
                "selfReportId": rk.get("reportId"),
                "selfCount": rk["reportCount"],
            }

    all_store_rank_list = []
    for m in all_store_map.values():
        use_self = m["selfScore"] is not None and m["selfScore"] != 0 and m["selfDate"] >= m["cgDate"]
        avg = None
        report_id = None
        sign_id = None
        report_count = 0
        plan_type = "CG"
        if use_self:
            avg = m["selfScore"]
            report_id = m["selfReportId"]
            report_count = m["selfCount"] or 1
            plan_type = "ZJ"
        elif m["cgScore"] is not None:
            avg = m["cgScore"]
            report_id = m["cgReportId"]
            sign_id = m["cgSignId"]
            report_count = m["cgCount"] or 1
            plan_type = "CG"
        elif m["selfScore"] is not None:
            avg = m["selfScore"]
            report_id = m["selfReportId"]
            report_count = m["selfCount"] or 1
            plan_type = "ZJ"
        else:
            continue
        all_store_rank_list.append({
            "store": m["store"],
            "region": m["region"],
            "position": m["position"],
            "avgScore": avg,
            "cgScore": m["cgScore"],
            "selfScore": m["selfScore"],
            "reportCount": report_count,
            "reportId": report_id,
            "signId": sign_id,
            "type": "all",
            "planType": plan_type,
        })
    all_store_rank_list.sort(key=lambda x: (-x["avgScore"], x["store"]))

    # --- 分类 → 门店明细（用于「巡检类型高发」展开） ---
    category_store_output = {}
    for cname, smap in category_store_map.items():
        lst = [{"store": s, "count": n, "region": store_meta.get(s, {}).get("region", "未分配区域"), "position": store_meta.get(s, {}).get("position", "-")}
               for s, n in smap.items()]
        lst.sort(key=lambda x: (-x["count"], x["store"]))
        category_store_output[cname] = lst

    # --- 问题项 -> 门店明细（用于「按问题分类」弹窗） ---
    item_store_output = {}
    for cid, smap in item_store_detail.items():
        lst = [{"store": s, "count": n, "region": store_meta.get(s, {}).get("region", "未分配区域")}
               for s, n in smap.items()]
        lst.sort(key=lambda x: (-x["count"], x["store"]))
        item_store_output[cid] = lst

    total_unq = sum(i["unqCount"] for i in by_item)
    return {
        "startDate": start_date,
        "endDate": end_date,
        "byItem": by_item,
        "byStore": by_store,
        "byRegion": by_region,
        "byCategory": by_category,
        "categoryStoreMap": category_store_output,
        "itemStoreMap": item_store_output,
        "storeTopItems": store_top,
        "storeRank": store_rank_list,
        "selfStoreRank": self_store_rank_list,
        "allStoreRank": all_store_rank_list,
        "regionRank": region_rank_list,
        "kpi": {
            "totalUnq": total_unq,
            "itemKinds": len([i for i in by_item if i["unqCount"] > 0]),
            "storeKinds": len(by_store),
            "regionKinds": len(by_region),
            "categoryKinds": len(by_category),
            "rankStoreKinds": len(store_rank_list),
            "rankRegionKinds": len(region_rank_list),
        },
    }


def _lookup_store_region(store_name: str) -> str:
    """从主看板缓存里查门店所属区域，查不到返回空串。"""
    with cache_lock:
        data = cache.get("data") or {}
    for s in data.get("stores", []) or []:
        if (s.get("storeName") or "").strip() == store_name:
            return s.get("region") or ""
    return ""


def _get_or_build_unqualified(start_date: str, end_date: str, force: bool = False) -> Dict[str, Any]:
    """带缓存地返回不合格明细数据。"""
    key = f"{start_date}~{end_date}"
    with unqualified_lock:
        if (not force and unqualified_cache["key"] == key and unqualified_cache["data"]
                and time.time() - unqualified_cache["ts"] < cfg.CACHE_TTL_SECONDS):
            return unqualified_cache["data"]

    data = _build_unqualified_detail(start_date, end_date)

    with unqualified_lock:
        unqualified_cache["key"] = key
        unqualified_cache["data"] = data
        unqualified_cache["ts"] = time.time()
    return data


def update_data(force: bool = False):
    """后台更新缓存数据"""
    with cache_lock:
        if cache["updating"]:
            return
        if not force and cache["last_update"]:
            elapsed = time.time() - cache["last_update"]
            if elapsed < cfg.CACHE_TTL_SECONDS:
                return
        cache["updating"] = True

    try:
        start, end = default_range()
        data = build_dashboard_data(start, end)
        with cache_lock:
            cache["data"] = data
            cache["last_update"] = time.time()
            cache["error"] = None
        # 清空区域排名缓存，让下次请求重新计算
        with region_ranking_lock:
            for rk in ("regular", "self", "video", "all"):
                region_ranking_cache.get(rk, {}).clear()
    except Exception as e:
        traceback.print_exc()
        with cache_lock:
            cache["error"] = str(e)
    finally:
        with cache_lock:
            cache["updating"] = False


def background_updater():
    while True:
        try:
            update_data()
        except Exception:
            traceback.print_exc()
        time.sleep(cfg.CACHE_TTL_SECONDS)


@app.route("/api/data")
def api_data():
    mode = request.args.get("mode", "current_month")
    custom_start = request.args.get("start", "")
    custom_end = request.args.get("end", "")

    with cache_lock:
        cached = cache["data"]
        cached_time = cache["last_update"]
        updating = cache["updating"]
        err = cache["error"]

    cached_range = (cached.get("startDate"), cached.get("endDate")) if cached else (None, None)
    requested_range = parse_range(mode, custom_start, custom_end)

    if cached_range != requested_range and not updating:
        try:
            data = build_dashboard_data(*requested_range)
            with cache_lock:
                cache["data"] = data
                cache["last_update"] = time.time()
                cache["error"] = None
            cached = data
            err = None
        except Exception as e:
            traceback.print_exc()
            err = str(e)

    return jsonify({
        "success": cached is not None,
        "data": cached,
        "updating": updating,
        "error": err,
        "cachedAt": datetime.datetime.fromtimestamp(cached_time).strftime("%Y-%m-%d %H:%M:%S") if cached_time else None,
    })


@app.route("/api/trends")
def api_trends():
    type_name = request.args.get("type", "self")
    period = request.args.get("period", "7")
    group_by = request.args.get("groupBy", "region")  # 自检趋势默认按区域展示

    today = datetime.date.today()
    if period == "7":
        start = (today - datetime.timedelta(days=6)).strftime("%Y-%m-%d")
        end = today.strftime("%Y-%m-%d")
    elif period == "30":
        start = (today - datetime.timedelta(days=29)).strftime("%Y-%m-%d")
        end = today.strftime("%Y-%m-%d")
    elif period == "month":
        start = today.replace(day=1).strftime("%Y-%m-%d")
        end = today.strftime("%Y-%m-%d")
    elif period == "range":
        # 使用当前全局选中的日期区间
        start = request.args.get("start") or today.strftime("%Y-%m-%d")
        end = request.args.get("end") or today.strftime("%Y-%m-%d")
    else:
        start = (today - datetime.timedelta(days=6)).strftime("%Y-%m-%d")
        end = today.strftime("%Y-%m-%d")

    try:
        data = _fetch_self_trends(start, end, group_by=group_by)
        return jsonify({"success": True, "data": data, "error": None})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "data": {}, "error": str(e)})


@app.route("/api/regionRankings")
def api_region_rankings():
    type_name = request.args.get("type", "regular")
    period = request.args.get("period", "thisWeek")
    if type_name not in ("regular", "self", "all", "video"):
        type_name = "regular"
    if period not in ("thisWeek", "lastWeek", "thisMonth", "lastMonth"):
        period = "thisWeek"
    try:
        if type_name == "all":
            reg = _get_or_build_region_ranking("regular", period)
            slf = _get_or_build_region_ranking("self", period)
            data = _merge_region_rankings(reg, slf)
        else:
            data = _get_or_build_region_ranking(type_name, period)
        return jsonify({"success": True, "data": data, "error": None})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "data": [], "error": str(e)})


@app.route("/api/unqualified")
def api_unqualified():
    """不合格明细：按问题项 / 门店 / 区域 / 分类四个维度。"""
    mode = request.args.get("mode", "current_month")
    custom_start = request.args.get("start", "")
    custom_end = request.args.get("end", "")
    force = request.args.get("force", "") in ("1", "true", "yes")

    start_date, end_date = parse_range(mode, custom_start, custom_end)
    try:
        data = _get_or_build_unqualified(start_date, end_date, force=force)
        return jsonify({"success": True, "data": data, "error": None})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "data": {}, "error": str(e)})


@app.route("/api/unqualified/itemDetail")
def api_unqualified_item_detail():
    """
    单个问题项的下钻：不合格门店清单 + 现场照片。
    参数：contentId, start, end
    """
    raw_cid = request.args.get("contentId", "")
    start_date = request.args.get("start", "")
    end_date = request.args.get("end", "")
    if not raw_cid:
        return jsonify({"success": False, "data": {}, "error": "缺少 contentId"})
    if not start_date or not end_date:
        start_date, end_date = parse_range("current_month", "", "")

    try:
        content_id = int(raw_cid)
    except ValueError:
        return jsonify({"success": False, "data": {}, "error": "contentId 非法"})

    # 从缓存里取回该问题项的聚合门店清单（与主表口径一致）
    base = _get_or_build_unqualified(start_date, end_date)
    row = None
    for i in base.get("byItem", []):
        if i.get("contentId") == content_id:
            row = i
            break
    if row is None:
        return jsonify({"success": False, "data": {}, "error": "未找到该问题项"})

    stores = base.get("itemStoreMap", {}).get(content_id, [])

    # 现场照片仍需要调慧运营接口；这里先用一个最小化的 row 尝试，
    # 若返回空则再遍历各岗位的真实 row。
    photos = []
    try:
        login_res = api.login()
        token = (login_res.get("data") or {}).get("token") or login_res.get("token")
        payload_row = {
            "contentId": content_id,
            "title": row.get("title", ""),
            "categoryName": row.get("category", ""),
        }
        raw = api.fetch_cg_item_pictures(token, payload_row, start_date, end_date, 4)
        for p in raw:
            urls = [cfg.IMG_BASE + u if not str(u).startswith("http") else u
                    for u in (p.get("urls") or [])]
            photos.append({"uploadTime": p.get("uploadTime", ""), "urls": urls})
    except Exception as e:
        print("[itemDetail] pictureList 失败:", e)

    return jsonify({
        "success": True,
        "data": {
            "contentId": content_id,
            "title": row.get("title", ""),
            "category": row.get("category", ""),
            "stores": stores,
            "photos": photos,
        },
        "error": None,
    })


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    update_data(force=True)
    return jsonify({"success": True, "message": "刷新已触发"})


STATIC_DIR = os.path.join(BASE_DIR, "static")


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:path>")
def catch_all(path):
    cand_static = os.path.join(STATIC_DIR, path)
    cand_root = os.path.join(BASE_DIR, path)
    if path and os.path.isfile(cand_static):
        return send_from_directory(STATIC_DIR, path)
    if path and os.path.isfile(cand_root):
        return send_from_directory(BASE_DIR, path)
    return send_from_directory(STATIC_DIR, "index.html")


def main():
    print("[server] 首次拉取慧运营数据...")
    update_data(force=True)
    print("[server] 首次拉取完成")

    t = threading.Thread(target=background_updater, daemon=True)
    t.start()

    port = int(os.environ.get("PORT", os.environ.get("HY_SERVER_PORT", cfg.SERVER_PORT)))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
