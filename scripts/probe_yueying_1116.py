# -*- coding: utf-8 -*-
"""排查：悦盈店 11 月报告被归入常规巡检（CG）但实际应是门店自检（用户 11/16 反馈）。
列出 raw 2026-11.json 中悦盈店的全部报告及其类型字段。"""
import json, io, sys, os

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(BASE, "data", "raw", "2026-11.json")
OUT = r"C:\Users\Rain\AppData\Local\Temp\yueying_raw.txt"

o = []
d = json.load(open(RAW, encoding="utf-8"))
data = d.get("data", d) if isinstance(d, dict) else d

def walk(pos):
    """positions: org -> pdata{cg:[...], zj?, sp?...}"""
    if not isinstance(pos, dict):
        return
    for org, pdata in pos.items():
        if not isinstance(pdata, dict):
            continue
        for typ, rows in pdata.items():
            if typ not in ("cg", "zj", "sp", "zx") or not isinstance(rows, list):
                continue
            for r in rows:
                sn = str(r.get("sn") or r.get("storeName") or "")
                if "悦盈" not in sn:
                    continue
                o.append("org=%s typ=%s" % (org, typ))
                o.append("  full=%s" % json.dumps(r, ensure_ascii=False)[:1600])

pos = data.get("positions") or data.get("positionsData") or {}
if not pos:
    # 打印顶层键帮助定位
    o.append("top keys: %s" % list(data.keys())[:20])
    for k, v in (data.items() if isinstance(data, dict) else []):
        if isinstance(v, dict):
            o.append("dict %s keys=%s" % (k, list(v.keys())[:10]))
        elif isinstance(v, list):
            o.append("list %s len=%d sample=%s" % (k, len(v), json.dumps(v[0], ensure_ascii=False)[:300] if v else ""))
else:
    walk(pos)

if not o:
    o.append("NOT FOUND in positions; top keys=%s" % list(data.keys())[:20])

open(OUT, "w", encoding="utf-8").write("\n".join(o))
print("WROTE %d lines" % len(o))
