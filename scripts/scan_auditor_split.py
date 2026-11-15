# -*- coding: utf-8 -*-
"""按提交人口径统计 CG 报告（仅直营店）：稽核三人组 vs 其他（=自检）。
直营店判定：raw.nameLink/nl 含「直营组」或 storeType=zy。加盟店维持现状不参与翻转。"""
import json, glob, os, collections

DET = r"E:\Rain\WB\WorkBuddy\工具制作\hyy-dashboard\data\details"
OUT = r"C:\Users\Rain\AppData\Local\Temp\auditor_split.txt"
AUDITORS = {"赖奕毅", "高瑞瑜", "潘英化"}

files = glob.glob(os.path.join(DET, "CG_*.json"))
month_stat = collections.defaultdict(lambda: {"aud": 0, "self": 0})
tpl_aud = collections.Counter()
tpl_self = collections.Counter()
creator_self = collections.Counter()
self_rows = []   # 将被翻转为自检的明细行
nl_dump = collections.Counter()

for fp in files:
    rid = os.path.basename(fp)[3:-5]
    try:
        d = json.load(open(fp, encoding="utf-8"))
    except Exception:
        continue
    det = d.get("detail", d)
    raw = det.get("raw") if isinstance(det, dict) else None
    raw = raw or {}
    nl = raw.get("nameLink") or raw.get("creatorNameLink") or det.get("storeName") or ""
    store_type = raw.get("storeType") or ""
    is_zy = ("直营组" in nl) or (store_type == "zy")
    nl_dump["直营" if is_zy else "非直营"] += 1
    if not is_zy:
        continue
    creator = raw.get("creatorName") or "?"
    day = str(det.get("reportDate") or raw.get("created") or "")[:7] or "?"
    tn = raw.get("templateName") or "?"
    sn = det.get("storeName") or raw.get("fullName") or "?"
    dd = str(det.get("reportDate") or (raw.get("created") or "")[:10] or "")[:10]
    if creator in AUDITORS:
        month_stat[day]["aud"] += 1
        tpl_aud[tn] += 1
    else:
        month_stat[day]["self"] += 1
        tpl_self[tn] += 1
        creator_self[creator] += 1
        self_rows.append("%s | %s | %s | %s | sn=%s" % (dd, rid, creator, tn, sn))

o = ["CG detail files: %d | 直营明细: %s" % (len(files), dict(nl_dump))]
o.append("")
o.append("== 直营店 CG 按月（aud=稽核三人组, self=店长等=翻转为自检） ==")
ta = ts = 0
for m in sorted(month_stat):
    v = month_stat[m]
    o.append("  %s: aud=%3d  self=%3d" % (m, v["aud"], v["self"]))
    ta += v["aud"]; ts += v["self"]
o.append("  TOTAL: aud=%d  self=%d" % (ta, ts))
o.append("")
o.append("== 稽核三人组模板分布 ==")
for k, c in tpl_aud.most_common():
    o.append("  %4d  %s" % (c, k))
o.append("")
o.append("== 翻转为自检的模板分布 ==")
for k, c in tpl_self.most_common():
    o.append("  %4d  %s" % (c, k))
o.append("  提交人: %s" % dict(creator_self.most_common(10)))
o.append("")
o.append("== 翻转为自检的明细（%d 份） ==" % len(self_rows))
for r in sorted(self_rows):
    o.append("  " + r)
open(OUT, "w", encoding="utf-8").write("\n".join(o))
print("OK")
