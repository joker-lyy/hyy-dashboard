#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
补拉 data/details/ 缺失的巡检报告明细（CG/ZJ/SP）。

用法:
    python fetch_missing_details.py            # 只补当前月(raw/YYYY-MM.json)里有不合格项(ur>0)且无明细的报告
    python fetch_missing_details.py --all      # 所有 raw 月份里有不合格项但缺明细的报告

明细文件格式与既有 data/details/<TYP>_<rid>.json 完全一致：
{generatedAt, detail:{planType, reportId, signId, storeName, endpoint, fetchedAt, raw, reportDate}}
"""
import json
import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
import hhy_api  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根
DETAIL_DIR = os.path.join(BASE, "data", "details")
RAW_DIR = os.path.join(BASE, "data", "raw")
TYPE_MAP = {"cg": "CG", "zj": "ZJ", "sp": "SP"}


def collect_targets(all_months=False):
    """从 raw 月度文件收集「有不合格项但缺明细」的报告。"""
    targets = {}
    import re
    months = sorted(f for f in os.listdir(RAW_DIR) if re.fullmatch(r"\d{4}-\d{2}\.json", f))
    if not all_months:
        months = months[-1:]  # 默认只看最近一个月
    for fn in months:
        try:
            d = json.load(open(os.path.join(RAW_DIR, fn), encoding="utf-8"))
        except Exception as e:
            print(f"[skip] {fn}: {e}")
            continue
        for _pos, g in (d.get("positions") or {}).items():
            for t in ("cg", "zj", "sp"):
                for r in g.get(t, []) or []:
                    ur = r.get("ur") or 0
                    if ur <= 0:
                        continue
                    typ = TYPE_MAP[t]
                    rid = str(r.get("rid") or "")
                    if not rid:
                        continue
                    fp = os.path.join(DETAIL_DIR, f"{typ}_{rid}.json")
                    if os.path.exists(fp):
                        continue
                    targets[rid] = {
                        "typ": typ, "rid": rid, "sid": r.get("sid") or rid,
                        "sn": r.get("sn") or "", "d": r.get("d") or "", "ur": ur,
                    }
    return sorted(targets.values(), key=lambda x: (x["d"], x["typ"]))


def fetch_raw(tok, typ, rid, sid):
    """按 2026-09-04 _probe_result.json 实测：明细接口参数走 URL query（form 空 body）。"""
    cands = [
        ("/web/ri/report/info?version=1", {"reportId": rid, "planType": typ}),
        ("/statRi/web/ri/report/info?version=1", {"reportId": rid, "planType": typ}),
    ]
    if typ == "SP":
        cands.append(("/web/ri/videoReport/info?version=1", {"reportId": rid}))
    last_err = None
    for path, params in cands:
        try:
            data = hhy_api.post_query(tok, path, params)
            if data:
                if isinstance(data, dict):
                    data["_endpoint"] = path.split("?")[0]
                return data
        except Exception as e:
            last_err = e
    if last_err:
        print(f"    [{typ}_{rid}] 候选全失败: {str(last_err)[:120]}")
    return None


def _strip_oss_sig(obj):
    """fix92/fix149: 剥掉 OSS 图片 URL 签名参数——否则触发 GitHub Push Protection 拒推。"""
    import re as _re
    pat = _re.compile(r'[?&](Expires=\d+|OSSAccessKeyId=[^&"\' ]+|Signature=[^&"\' ]+)')
    if isinstance(obj, str):
        return pat.sub("", obj)
    if isinstance(obj, dict):
        return {k: _strip_oss_sig(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_strip_oss_sig(v) for v in obj]
    return obj


def main():
    all_months = "--all" in sys.argv
    targets = collect_targets(all_months)
    print(f"待补拉明细: {len(targets)} 份")
    if not targets:
        print("无缺失，退出。")
        return
    tok = hhy_api.login().get("token", "")
    if not tok:
        raise SystemExit("登录失败，拿不到 token")
    ok = fail = 0
    for i, t in enumerate(targets, 1):
        rid, typ = t["rid"], t["typ"]
        try:
            raw = fetch_raw(tok, typ, rid, t["sid"])
        except Exception as e:
            raw = None
            print(f"  [{i}/{len(targets)}] {typ}_{rid} 异常: {e}")
        if not raw or not isinstance(raw, dict):
            print(f"  [{i}/{len(targets)}] {typ}_{rid} ({t['d']} {t['sn']}) 拉取失败")
            fail += 1
            time.sleep(0.4)
            continue
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        raw = _strip_oss_sig(raw)
        payload = {
            "generatedAt": now,
            "detail": {
                "planType": typ,
                "reportId": str(rid),
                "signId": str(t["sid"]),
                "storeName": t["sn"],
                "endpoint": raw.get("_endpoint", "/web/ri/report/info"),                "fetchedAt": now,
                "raw": raw,
                "reportDate": str(raw.get("reportDate") or t["d"]),
            },
        }
        fp = os.path.join(DETAIL_DIR, f"{typ}_{rid}.json")
        with open(fp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        ok += 1
        print(f"  [{i}/{len(targets)}] {typ}_{rid} ({t['d']} {t['sn']} ur={t['ur']}) ✔")
        time.sleep(0.4)
    print(f"完成: 成功 {ok} / 失败 {fail}")


if __name__ == "__main__":
    main()
