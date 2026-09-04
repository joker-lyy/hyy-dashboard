#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
按月采集慧运营原始记录，输出到 data/raw/YYYY-MM.json

设计要点
--------
1) 每个月一个独立文件，互不干扰：data/raw/2026-07.json、2026-08.json ...
2) 天然增量 —— 每次运行只（重）采集「当前月」和「上个月」，历史月份一旦
   采集过就永不重拉。所以 Actions 每天只需几分钟，而不是把历史全拉一遍。
3) 与 fetch_data.py 完全独立 —— 本脚本只写 data/raw/，不碰任何其他文件。
   即使本脚本失败，现有的看板数据照常工作（前端检测不到原始数据就走老路）。
4) 每个文件同时保存「报告明细」和「月度聚合」两类数据：
   - 报告明细（cg/zj/sp）：每条带 reportDate，前端可按任意日期精确筛选
   - 月度聚合（storeInspection / rectification / categoryUnq / zjItems）：
     这类接口只能按区间返回汇总值，无法再按天拆分，所以按月存，
     前端跨月时把各月的计数相加（计数类字段相加是精确的）

输出结构
--------
data/raw/YYYY-MM.json
{
  "month": "2026-08",
  "fetchedAt": "2026-09-01 12:00:00",       # UTC
  "start": "2026-08-01",
  "end": "2026-08-31",
  "positions": {
    "培训组": {
      "cg":  [ {d,sn,sc,nl,s,rid,sid,tid,pass,ps,ur,ic,ec} ... ],
      "zj":  [ {d,sn,sc,nl,tn,pass,ps,s} ... ],
      "sp":  [ {d,sn,sc,nl,s,rid,tid,pass} ... ],
      "storeInspection": [ {sn,sc,nl,avgScore,sumCount,...} ... ],
      "rectification":   [ {sn,sumNum,yzg,dzg,dsh,yqzs} ... ],
      "categoryUnq":     [ {category,bxjcs,bxjcsBhg,...} ... ],
      "zjItems":         [ {contentId,title,category,bxjcs,bxjcsBhg} ... ],
      "leaves":          [ {organizeName,currentStoreCount} ... ]
    }
  },
  "tplItemCount": { "<templateId>": 57 }
}
字段名做了压缩（d=报告日期, sn=门店名, sc=门店编码, nl=组织路径, s=分数 ...），
两年下来单文件约 800 KB，24 个文件合计约 19 MB，仓库完全扛得住。
"""
import datetime
import json
import os
import sys
import traceback

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

OUT_DIR = os.path.join(os.path.dirname(BASE_DIR), "data", "raw")

# 系统实际上线日：早于此日期没有数据，不必采集
SYSTEM_START_DATE = "2026-07-01"

# 每次运行重采集最近几个月？
# 2 = 当月 + 上月。跨月时上月可能还没采全（比如 9/1 跑时 8 月刚结束），
# 重采一次补齐；再往前的月份都已定型，永不重拉。
REFRESH_RECENT_MONTHS = 2

# 每月最多往前补采多少个月（防止首次运行时把空月份也建一堆文件）
MAX_MONTHS_PER_RUN = 30


def log(msg):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def month_ranges():
    """返回本次需要采集的月份列表（YYYY-MM 字符串），从旧到新。"""
    today = datetime.date.today()
    start = datetime.date(*[int(x) for x in SYSTEM_START_DATE.split("-")])
    months = []
    y, m = start.year, start.month
    while (y, m) <= (today.year, today.month):
        months.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return months


def month_day_range(month):
    """'2026-08' -> ('2026-08-01', '2026-08-31')，月末不超过今天。"""
    y, m = int(month[:4]), int(month[5:7])
    first = datetime.date(y, m, 1)
    if m == 12:
        last = datetime.date(y + 1, 1, 1) - datetime.timedelta(days=1)
    else:
        last = datetime.date(y, m + 1, 1) - datetime.timedelta(days=1)
    today = datetime.date.today()
    if last > today:
        last = today
    return first.strftime("%Y-%m-%d"), last.strftime("%Y-%m-%d")


def to_int(v, default=0):
    try:
        if v is None or v == "":
            return default
        return int(float(v))
    except (TypeError, ValueError):
        return default


def to_float(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def slim_cg(rows):
    """常规巡检报告明细（每条带 reportDate，前端按日期筛选就靠它）。"""
    out = []
    for r in rows or []:
        out.append({
            "d": str(r.get("reportDate") or "")[:10],
            "sn": (r.get("fullName") or "").strip(),
            "sc": str(r.get("storeCode") or "").strip(),
            "nl": r.get("nameLink") or "",
            "s": to_float(r.get("score")),
            "rid": str(r.get("reportId") or ""),
            "sid": str(r.get("signId") or ""),
            "tid": str(r.get("templateId") or ""),
            "pass": bool(r.get("isPass")),
            "ps": str(r.get("isPassString") or ""),
            "ur": to_int(r.get("unRectifyNum")),
            "ic": bool(r.get("isCorrected")),
            "ec": bool(r.get("isExpiredCorrect")),
            "st": r.get("storeStatus") or "",
        })
    return out


def slim_zj(rows):
    """自检报告明细。score 未点评时是字符串「未点评」，保留原值供前端判断。"""
    out = []
    for r in rows or []:
        raw_score = r.get("score")
        out.append({
            "d": str(r.get("reportDate") or "")[:10],
            "sn": (r.get("fullName") or "").strip(),
            "sc": str(r.get("storeCode") or "").strip(),
            "nl": r.get("nameLink") or "",
            "tn": r.get("templateName") or "",
            "pass": bool(r.get("isPass")),
            "ps": str(r.get("isPassString") or ""),
            "s": to_float(raw_score) if not isinstance(raw_score, str) else raw_score,
        })
    return out


def slim_sp(rows):
    """视频巡检报告明细。"""
    out = []
    for r in rows or []:
        out.append({
            "d": str(r.get("reportDate") or "")[:10],
            "sn": (r.get("fullName") or "").strip(),
            "sc": str(r.get("storeCode") or "").strip(),
            "nl": r.get("nameLink") or "",
            "s": to_float(r.get("score")),
            "rid": str(r.get("reportId") or ""),
            "tid": str(r.get("templateId") or ""),
            "pass": bool(r.get("isPass")),
            "ps": str(r.get("isPassString") or ""),
        })
    return out


def slim_store_inspection(rows):
    """门店维度：不合格项数（sumCount）等月度汇总。计数类字段，跨月相加精确。"""
    out = []
    for r in rows or []:
        out.append({
            "sn": (r.get("fullName") or r.get("organizeName") or "").strip(),
            "sc": str(r.get("storeCode") or "").strip(),
            "nl": r.get("orgName") or "",
            "s": to_float(r.get("avgScore")),
            "sum": to_int(r.get("sumCount")),
            "nrm": to_int(r.get("normalCount")),
            "xcr": to_int(r.get("xuCorrectedReport")),
            "icc": to_int(r.get("isCorrectedCount")),
            "ecr": to_int(r.get("expiredCorrectReport")),
            "pass": r.get("isPass"),
            "st": r.get("storeStatus") or "",
        })
    return out


def slim_rectification(rows):
    """门店维度整改进度（项数口径）。"""
    out = []
    for r in rows or []:
        out.append({
            "sn": (r.get("organizeName") or r.get("fullName") or "").strip(),
            "sum": to_int(r.get("sumNum")),
            "yzg": to_int(r.get("yzg")),
            "dzg": to_int(r.get("dzg")),
            "dsh": to_int(r.get("dsh")),
            "yqzs": to_int(r.get("yqzs")),
        })
    return out


def slim_category(rows):
    """问题类别不合格统计（常规巡检）。"""
    out = []
    for r in rows or []:
        out.append({
            "cat": r.get("categoryName") or r.get("category") or "",
            "bj": to_int(r.get("bxjcs")),
            "bh": to_int(r.get("bxjcsBhg")),
            "sc": to_int(r.get("storeCount") or r.get("bhgStoreCount")),
        })
    return out


def slim_zj_items(rows):
    """自检问题项明细。"""
    out = []
    for r in rows or []:
        out.append({
            "cid": str(r.get("contentId") or ""),
            "t": r.get("title") or r.get("contentName") or "",
            "cat": r.get("categoryName") or r.get("category") or "",
            "bj": to_int(r.get("bxjcs")),
            "bh": to_int(r.get("bxjcsBhg")),
            "sc": to_int(r.get("storeCount") or r.get("bhgStoreCount")),
        })
    return out


def fetch_month(api, cfg, month, fetched_at):
    """采集单个月份的全部岗位数据。返回 (payload, ok)。"""
    start, end = month_day_range(month)
    log(f"  [{month}] 区间 {start} ~ {end}")

    positions = {}
    tpl_item_count = {}
    ok = True

    for pos_name, org_name in cfg.TARGET_POSITIONS:
        try:
            token, matched = api.switch_position_and_login(pos_name, org_name)
            label = org_name  # 用组织名做 key，与前端岗位标签对齐

            log(f"    岗位 {org_name} 已登录")

            # 1) 常规巡检报告明细
            try:
                cg = api.fetch_cg_reports(token, start, end)
            except Exception as e:
                log(f"      cg 报告失败：{e}")
                cg = []
                ok = False

            # 2) 自检报告明细
            try:
                zj = api.fetch_self_inspection_reports(token, start, end)
            except Exception as e:
                log(f"      zj 报告失败：{e}")
                zj = []
                ok = False

            # 3) 视频巡检报告明细
            try:
                sp = api.fetch_video_inspection_reports(token, start, end)
            except Exception as e:
                log(f"      sp 报告失败：{e}")
                sp = []
                ok = False

            # 4) 门店巡检汇总（不合格项数）
            try:
                si = api.fetch_store_inspection_report(token, start, end)
            except Exception as e:
                log(f"      storeInspection 失败：{e}")
                si = []

            # 5) 门店整改进度
            try:
                rect = api.fetch_store_rectification_summary(token, start, end)
            except Exception as e:
                log(f"      rectification 失败：{e}")
                rect = []

            # 6) 组织树叶子节点（门店总数）
            try:
                leaves = api.leaf_regions(token)
                leaves = [{"organizeName": l.get("organizeName", ""),
                           "currentStoreCount": to_int(l.get("currentStoreCount"))}
                          for l in leaves or []]
            except Exception as e:
                log(f"      leaves 失败：{e}")
                leaves = []

            # 7) 问题类别不合格（常规巡检）
            cat = []
            try:
                org_info = api.all_org_info(token)
                max_high_no = to_int(org_info.get("maxHighNo"), 4)
                cat = api.fetch_category_unqualified_total(token, start, end, max_high_no)
            except Exception as e:
                log(f"      categoryUnq 失败：{e}")

            # 8) 自检问题项
            zj_items = []
            try:
                org_info = api.all_org_info(token)
                max_high_no = to_int(org_info.get("maxHighNo"), 4)
                organize_id = matched.get("organizeId")
                zj_items = api.fetch_zj_category_unqualified_info(
                    token, start, end, max_high_no, organize_id)
            except Exception as e:
                log(f"      zjItems 失败：{e}")

            # 9) 模板检查项数（用于把报告份数换算成巡检项数）
            for tid in {r.get("templateId") for r in (cg or []) if r.get("templateId")}:
                key = str(tid)
                if key in tpl_item_count:
                    continue
                try:
                    rows = api.fetch_category_unqualified_info(
                        token, start, end, 4, template_id=tid)
                    tpl_item_count[key] = len(rows or [])
                except Exception:
                    tpl_item_count[key] = 0

            positions[label] = {
                "cg": slim_cg(cg),
                "zj": slim_zj(zj),
                "sp": slim_sp(sp),
                "storeInspection": slim_store_inspection(si),
                "rectification": slim_rectification(rect),
                "categoryUnq": slim_category(cat),
                "zjItems": slim_zj_items(zj_items),
                "leaves": leaves,
            }
            log(f"      cg={len(cg)} zj={len(zj)} sp={len(sp)} 门店汇总={len(si)}")

        except Exception as e:
            traceback.print_exc()
            log(f"    岗位 {org_name} 采集失败：{e}")
            ok = False

    return {
        "month": month,
        "fetchedAt": fetched_at,
        "start": start,
        "end": end,
        "positions": positions,
        "tplItemCount": tpl_item_count,
    }, ok


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    missing = [k for k in ("HY_USERNAME", "HY_PASSWORD") if not os.environ.get(k)]
    if missing:
        log(f"错误：缺少环境变量 {missing}")
        return 1

    log("导入后端模块 ...")
    import hhy_api as api
    import hhy_config as cfg

    fetched_at = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    months = month_ranges()
    if not months:
        log("没有需要采集的月份")
        return 0

    # 只重采最近 N 个月；更早的月份如果文件已存在就跳过
    recent = set(months[-REFRESH_RECENT_MONTHS:])
    todo = []
    for m in months:
        path = os.path.join(OUT_DIR, f"{m}.json")
        if m in recent or not os.path.exists(path):
            todo.append(m)
    todo = todo[-MAX_MONTHS_PER_RUN:]

    log(f"本次采集月份：{todo}")
    log(f"已存在且跳过的历史月份：{[m for m in months if m not in todo]}")

    summary = {}
    for month in todo:
        log(f"采集 {month} ...")
        try:
            payload, ok = fetch_month(api, cfg, month, fetched_at)
            path = os.path.join(OUT_DIR, f"{month}.json")
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, path)
            size = os.path.getsize(path) / 1024
            summary[month] = {"ok": ok, "kb": round(size)}
            log(f"  写入 {month}.json ({size:.0f} KB, ok={ok})")
        except Exception:
            traceback.print_exc()
            summary[month] = {"ok": False}
            log(f"  {month} 采集失败")

    # 索引文件：告诉前端有哪些月份可用
    index = {
        "generatedAt": fetched_at,
        "startDate": SYSTEM_START_DATE,
        "months": sorted(f[:-5] for f in os.listdir(OUT_DIR) if f.endswith(".json")),
        "detail": summary,
    }
    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    log(f"索引：{index['months']}")

    failed = [m for m, v in summary.items() if not v.get("ok")]
    log("完成。" + (f"失败月份：{failed}" if failed else "全部成功"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
