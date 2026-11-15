# -*- coding: utf-8 -*-
"""fix250：直营店 CG 报告按提交人自动判自检 → data/selfCheckAuto.json

口径（用户 2026-11-16 定稿）：
  稽核巡检只有 赖奕毅 / 高瑞瑜 / 潘英化 三人会去做；
  直营店的 CG（常规巡检接口）报告，提交人不是这三人的一律 = 门店自检
  （不管用「直营自检表」「加盟自检表」还是「QSC巡检表（直营）」——店长自己做的都是自检）。
  加盟店的 CG 报告维持现状（加盟商提交的 QSC 巡检表仍算常规巡检），不参与翻转。

输出 data/selfCheckAuto.json：
  { generatedAt, note, auditors, marks: {"rid:<rid>": {...}}, rids: [...] }
  · marks 键格式与 selfCheckMarks.json 一致（rid:<rid>），2c 直接合并 keys
  · rids 为纯 rid 列表，前端 aggregate.js isSelfCheckMarked 查 Set

直营店判定：明细 raw.nameLink/creatorNameLink 含「直营组」或 raw.storeType == 'zy'。
幂等可重复跑；管线在 2c 之前调用（auto_update_daily.py），保证新增报告即时覆盖。
"""
import json, glob, os, datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DET = os.path.join(BASE, "data", "details")
OUT = os.path.join(BASE, "data", "selfCheckAuto.json")

AUDITORS = ["赖奕毅", "高瑞瑜", "潘英化"]


def main():
    marks = {}
    n_scan = 0
    for fp in glob.glob(os.path.join(DET, "CG_*.json")):
        rid = os.path.basename(fp)[3:-5]
        try:
            d = json.load(open(fp, encoding="utf-8"))
        except Exception:
            continue
        det = d.get("detail", d)
        raw = det.get("raw") if isinstance(det, dict) else None
        raw = raw or {}
        nl = raw.get("nameLink") or raw.get("creatorNameLink") or ""
        is_zy = ("直营组" in nl) or (raw.get("storeType") == "zy")
        if not is_zy:
            continue
        n_scan += 1
        creator = raw.get("creatorName") or ""
        if creator in AUDITORS:
            continue
        sn = det.get("storeName") or raw.get("fullName") or ""
        dd = str(det.get("reportDate") or (raw.get("created") or "")[:10] or "")[:10]
        marks["rid:" + rid] = {
            "by": "auto-auditor",
            "at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "rid": rid, "sn": sn, "d": dd,
            "creator": creator,
        }
    payload = {
        "generatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "note": "fix250: 直营店 CG 报告非稽核三人组(赖奕毅/高瑞瑜/潘英化)提交 = 门店自检；加盟店不参与",
        "auditors": AUDITORS,
        "marks": marks,
        "rids": sorted(k[4:] for k in marks),
    }
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)
    print("[fix250] selfCheckAuto: 扫描直营 CG 明细 %d 份 -> 自动自检 %d 份" % (n_scan, len(marks)))


if __name__ == "__main__":
    main()
