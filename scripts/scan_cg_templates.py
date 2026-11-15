# -*- coding: utf-8 -*-
"""扫描全部 CG 明细，统计 templateName 分布（重点「加盟自检表」模板的影响面）。"""
import json, glob, os, collections

DET = r"E:\Rain\WB\WorkBuddy\工具制作\hyy-dashboard\data\details"
OUT = r"C:\Users\Rain\AppData\Local\Temp\cg_tpl_scan.txt"

tpl_stat = collections.Counter()          # templateName -> count
by_month = collections.defaultdict(collections.Counter)   # templateName -> month -> count
creators = collections.defaultdict(collections.Counter)   # templateName -> creator -> count
stores = collections.defaultdict(set)                     # templateName -> stores
samples = collections.defaultdict(list)                   # templateName -> sample rid/d/sn

files = glob.glob(os.path.join(DET, "CG_*.json"))
o = ["total CG detail files: %d" % len(files)]
for fp in files:
    try:
        d = json.load(open(fp, encoding="utf-8"))
    except Exception:
        continue
    det = d.get("detail", d)
    raw = det.get("raw") if isinstance(det, dict) else None
    tn = (raw or {}).get("templateName") or det.get("templateName") or "?"
    rid = det.get("reportId") or (raw or {}).get("reportId") or os.path.basename(fp)[3:-5]
    day = str(det.get("reportDate") or (raw or {}).get("created") or "")[:7] or "?"
    creator = (raw or {}).get("creatorName") or "?"
    sn = det.get("storeName") or (raw or {}).get("fullName") or "?"
    tpl_stat[tn] += 1
    by_month[tn][day] += 1
    creators[tn][creator] += 1
    stores[tn].add(sn)
    if len(samples[tn]) < 3:
        samples[tn].append("%s %s %s %s" % (rid, day, sn, creator))

o.append("== templateName distribution ==")
for tn, c in tpl_stat.most_common():
    o.append("%6d  %s" % (c, tn))
    o.append("        months: %s" % dict(sorted(by_month[tn].items())))
    o.append("        stores: %d, creators: %s" % (len(stores[tn]), dict(creators[tn].most_common(6))))
    o.append("        samples: %s" % " | ".join(samples[tn]))
open(OUT, "w", encoding="utf-8").write("\n".join(o))
print("WROTE %d lines" % len(o))
