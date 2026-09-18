#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
refresh_rectify_details.py —— 每日刷新「未整改完」报告的明细快照（fix183，2026-09-17）

背景（门店反馈已整改、看板整改追踪却长期显示 0% 的根因）：
  batch_all.py 对 reportDetails.json 里已存在的报告「永不重抓」（already 跳过），
  而整改状态(isCorrected)是门店事后才在平台提交的 → 明细快照永远停在抓取当天。
  sync_ghpages 每晚再从旧 reportDetails 重新切出 data/details/，
  只刷仓库侧明细也会被倒灌回旧状态。

本脚本挂在管线 2b 之后、2c 重建之前，做四件事：
  1. 从 unqualified_v2.json 的 rectify 行收集「未完成(done<total)」且报告日期在 N 天内的报告；
  2. 实时重抓明细（hhy_api，URL query，复用 fetch_missing_details.fetch_raw）；
  3. 原地更新 hhy-deploy/data/reportDetails.json 对应键（保留原元数据，仅换 raw/fetchedAt，
     原子写回，防 sync 倒灌）；
  4. 同步重切仓库 data/details/<PT>_<rid>.json，让当轮 2c 重建立即拿到最新整改状态。

用法：
    管线自动调用（无参数）；手动：
    python refresh_rectify_details.py [--days 90] [--sleep 0.35] [--limit 0]
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))          # hyy-dashboard 仓库根
PIPE = os.path.join(os.path.dirname(BASE), "慧运营看板自动更新")             # 管线目录
RD_PATH = os.path.join(PIPE, "hhy-deploy", "data", "reportDetails.json")    # 明细真源（batch_all OUT）
DETAIL_DIR = os.path.join(BASE, "data", "details")
V2_PATH = os.path.join(BASE, "data", "unqualified_v2.json")

sys.path.insert(0, PIPE)
import auto_update_daily  # noqa: F401,E402  模块层注入 HY_USERNAME/HY_PASSWORD 环境变量
sys.path.insert(0, os.path.join(BASE, "scripts"))
import hhy_api  # noqa: E402
import fetch_missing_details as fmd  # noqa: E402  复用 fetch_raw + _strip_oss_sig
sys.path.insert(0, PIPE)
import batch_all as bat  # noqa: E402  SP(视频巡检)必须走它的灰度端点 fetch_video_detail


def count_corrected(raw):
    """按 build_unqualified_v2 同口径统计已整改数：notcategoryList 为主，
    为空时回退 categoryList 里 isQualified 明确 False 的项（fix179 口径）。"""
    if not isinstance(raw, dict):
        return 0, 0
    items = []
    for cat in (raw.get("notcategoryList") or []):
        items.extend(cat.get("itemList") or [])
    if not items:
        for cat in (raw.get("categoryList") or []):
            for it in (cat.get("itemList") or []):
                q = it.get("isQualified")
                if q is False or str(q).strip().lower() == "false":
                    items.append(it)
    total = len(items)
    # fix185：isCorrected 三态（0未整改/1已整改/2待审核=门店已提交照片待督导审核），
    # 仅 1 算已整改。旧 bool() 把 2 当 True，698 条待审核被虚报为已整改（利和 9/11 实锤）。
    done = sum(1 for it in items if it.get("isCorrected") == 1)
    return total, done


def collect_targets(days):
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    try:
        j = json.load(open(V2_PATH, encoding="utf-8"))
    except Exception as e:
        print("[ERROR] 读 unqualified_v2.json 失败: %s" % e)
        return []
    rows = j.get("rectify") if isinstance(j.get("rectify"), list) else []
    targets = {}
    for r in rows:
        typ = str(r.get("typ") or "").upper()
        rid = str(r.get("rid") or "")
        tot, done = r.get("total"), r.get("done")
        if typ not in ("CG", "ZJ", "SP") or not rid:
            continue
        if not isinstance(tot, int) or not isinstance(done, int) or done >= tot:
            continue  # 已整改完的不用刷
        if str(r.get("d") or "") < cutoff:
            continue  # 太老的不管（整改窗口外）
        targets[rid] = {"typ": typ, "rid": rid, "d": r.get("d") or "", "sn": r.get("sn") or ""}
    return sorted(targets.values(), key=lambda x: (x["d"], x["typ"]))


def flush_report_details(rd):
    """原子写回 reportDetails.json（照搬 batch_all._flush_report_details 的退避重试）。"""
    meta2 = {k: rd.get(k) for k in rd if k != "details"}
    meta2["generatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    meta2["source"] = "refresh_rectify_details.py"
    meta2["details"] = rd.get("details") or {}
    tmp = RD_PATH + ".tmp"
    if os.path.exists(tmp):
        try: os.remove(tmp)
        except Exception: pass
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta2, f, ensure_ascii=False)
    last_err = None
    for attempt in range(4):
        try:
            os.replace(tmp, RD_PATH)
            return True
        except Exception as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    print("[ERROR] reportDetails.json 写回失败: %s" % last_err)
    return False


def main():
    days = 90
    sleep_s = 0.35
    limit = 0
    args = sys.argv[1:]
    if "--days" in args: days = int(args[args.index("--days") + 1])
    if "--sleep" in args: sleep_s = float(args[args.index("--sleep") + 1])
    if "--limit" in args: limit = int(args[args.index("--limit") + 1])

    targets = collect_targets(days)
    if limit > 0:
        targets = targets[:limit]
    print(f"[refresh] 未整改完且 {days} 天内待刷新: {len(targets)} 份")
    if not targets:
        return

    if not os.path.exists(RD_PATH):
        print(f"[ERROR] 找不到 {RD_PATH}")
        sys.exit(1)
    t0 = time.time()
    print("[refresh] 加载 reportDetails.json ...")
    rd = json.load(open(RD_PATH, encoding="utf-8"))
    details = rd.get("details") if isinstance(rd.get("details"), dict) else None
    if details is None:
        print("[ERROR] reportDetails.json 无 details 字典")
        sys.exit(1)
    gen = rd.get("generatedAt") or rd.get("cachedAt") or time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[refresh] 已有明细 {len(details)} 条，加载耗时 {time.time()-t0:.0f}s")

    tok = hhy_api.login().get("token", "")
    if not tok:
        print("[ERROR] 登录失败")
        sys.exit(1)

    ok = fail = absent = changed = completed_now = 0
    for i, t in enumerate(targets, 1):
        typ, rid = t["typ"], t["rid"]
        key = f"{typ}:{rid}"
        entry = details.get(key)
        if not isinstance(entry, dict):
            absent += 1  # batch_all 下轮会按当前状态新抓，无需处理
            continue
        try:
            if typ == "SP":
                # fix183b：SP(视频巡检)必须走 batch_all 的灰度视频端点——普通端点只回元数据，
                # 9/17 实锤把 SP 明细降级（条目 75→55），这里改走 fetch_video_detail 修正。
                status, data_, err_ = bat.fetch_video_detail(tok, rid)
                raw = data_ if (status == 200 and data_) else None
                if raw is not None:
                    raw = bat.normalize_pt("SP", raw)
                    raw["_endpoint"] = "/web/ri/videoReport/info(gray)"
            else:
                raw = fmd.fetch_raw(tok, typ, rid, entry.get("signId") or rid)
        except Exception as e:
            raw = None
            print(f"  [{i}/{len(targets)}] {key} 异常: {str(e)[:100]}")
        if not raw or not isinstance(raw, dict):
            fail += 1
            time.sleep(sleep_s)
            continue
        raw = fmd._strip_oss_sig(raw)
        old_total, old_done = count_corrected(entry.get("raw"))
        new_total, new_done = count_corrected(raw)
        entry["endpoint"] = raw.pop("_endpoint", entry.get("endpoint") or "/statRi/web/ri/report/info")
        entry["fetchedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
        entry["raw"] = raw
        details[key] = entry
        # 同步重切仓库明细文件（供本轮 2c 立即生效；sync 之后会从 reportDetails 重新核对）
        try:
            payload = {"generatedAt": gen, "detail": fmd._strip_oss_sig(entry)}
            fp = os.path.join(DETAIL_DIR, key.replace(":", "_") + ".json")
            tmp = fp + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, fp)
        except Exception as e:
            print(f"  [{i}/{len(targets)}] {key} 明细文件重切失败: {e}")
        ok += 1
        if new_done != old_done:
            changed += 1
            if new_done >= new_total > 0:
                completed_now += 1
            print(f"  [{i}/{len(targets)}] {typ}_{rid} ({t['d']} {t['sn']}) 整改 {old_done}/{old_total} -> {new_done}/{new_total}")
        if (i) % 40 == 0:
            print(f"  进度 {i}/{len(targets)}: ok={ok} fail={fail} absent={absent} 变化={changed}", flush=True)
        time.sleep(sleep_s)

    if ok:
        print("[refresh] 写回 reportDetails.json ...")
        flush_ok = flush_report_details(rd)
        print(f"[refresh] 写回{'成功' if flush_ok else '失败'}")
    print(f"[refresh] 完成: 重抓 {ok} / 失败 {fail} / 不在累积表 {absent}；"
          f"状态有变化 {changed} 份（其中新完成 {completed_now} 份），耗时 {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
