# -*- coding: utf-8 -*-
"""
fix107 离线修复：cg_reports 全组织可见导致门店被错标组别（培训组混入加盟/新店运营门店）
重建 data.json：
  1) CG stores：position 按 orgPath 修正 + 按 storeCode 去重
  2) CG regions：按 (position, region) 从修正后的门店重建
  3) CG positions：inspectedCount/avgScore/项数/合格率/提交率 重算
  4) selfInspection.regions / positions / 顶层汇总：从 self stores 重建
视频巡检板块已确认无污染，不动。
"""
import json
from collections import defaultdict

P = 'data/data.json'
root = json.load(open(P, encoding='utf-8'))
d = root['data']

ORG2LABEL = {'培训组': '培训组（直营组）', '新店运营组': '新店运营组',
             '加盟营运组': '加盟营运组', '新店筹建组': '新店筹建组'}
POS_ORDER = ['培训组（直营组）', '新店运营组', '加盟营运组', '新店筹建组']

def group_of(orgpath):
    parts = [x for x in str(orgpath or '').split('/') if x]
    for org, label in ORG2LABEL.items():
        if org in parts:
            return label
    return None

def pos_rank(p):
    return POS_ORDER.index(p) if p in POS_ORDER else 99

def _s(x):
    try:
        return float(x or 0)
    except Exception:
        return 0.0

def _i(x):
    try:
        return int(x or 0)
    except Exception:
        return 0

# ---------- 1. CG stores ----------
bycode = {}
for s in d.get('stores', []):
    g = group_of(s.get('orgPath'))
    if g:
        s['position'] = g
    k = s.get('storeCode') or s.get('storeName')
    if k not in bycode or _i(s.get('reportCount')) > _i(bycode[k].get('reportCount')):
        bycode[k] = s
cg = list(bycode.values())
d['stores'] = sorted(cg, key=lambda s: (-s.get('score', 0), s.get('storeName', '')))
print('[CG stores]', len(d['stores']), '去重后; 组别分布:',
      {g: sum(1 for s in cg if s['position'] == g) for g in POS_ORDER})

# ---------- 2. CG regions ----------
old_rc = {}
for r in d.get('regions', []):
    key = (r.get('position'), r.get('region'))
    old_rc[key] = max(old_rc.get(key, 0), _i(r.get('storeCount')))
any_rc = {}
for r in d.get('regions', []):
    if r.get('storeCount'):
        any_rc.setdefault(r.get('region'), _i(r['storeCount']))

reg_map = defaultdict(list)
for s in cg:
    reg_map[(s['position'], s.get('region') or '未分区')].append(s)
new_regions = []
for (pos, rn), ss in reg_map.items():
    insp = [s for s in ss if _i(s.get('reportCount')) > 0]
    scored = [s['score'] for s in insp if _s(s.get('score')) > 0]
    total = sum(_i(s.get('normalCount')) + _i(s.get('unqualifiedItems')) for s in insp)
    normal = sum(_i(s.get('normalCount')) for s in insp)
    sc = old_rc.get((pos, rn)) or any_rc.get(rn) or 0
    new_regions.append({
        'region': rn, 'position': pos, 'storeCount': sc,
        'inspectedCount': len(insp),
        'avgScore': round(sum(scored) / len(scored), 2) if scored else 0.0,
        'totalItems': total, 'normalItems': normal, 'unqualifiedItems': total - normal,
        'needRectify': sum(_i(s.get('needRectify')) for s in insp),
        'rectified': sum(_i(s.get('rectified')) for s in insp),
        'expired': sum(_i(s.get('expired')) for s in insp),
        'submitRate': round(len(insp) / sc * 100, 1) if sc else 0.0,
        'qualifiedRate': round(normal / total * 100, 1) if total else 0.0,
        'stores': sorted(insp, key=lambda s: (-s.get('score', 0), s.get('storeName', ''))),
    })
new_regions.sort(key=lambda r: (pos_rank(r['position']), -r['inspectedCount']))
d['regions'] = new_regions
print('[CG regions]', len(new_regions), '重建')

# ---------- 3. CG positions ----------
for p in d.get('positions', []):
    g = p['position']
    ss = [s for s in cg if s['position'] == g]
    insp = [s for s in ss if _i(s.get('reportCount')) > 0]
    scored = [s['score'] for s in insp if _s(s.get('score')) > 0]
    total = sum(_i(s.get('normalCount')) + _i(s.get('unqualifiedItems')) for s in insp)
    normal = sum(_i(s.get('normalCount')) for s in insp)
    p['inspectedCount'] = len(insp)
    p['avgScore'] = round(sum(scored) / len(scored), 2) if scored else 0.0
    p['totalItems'] = total
    p['normalItems'] = normal
    p['unqualifiedItems'] = total - normal
    p['qualifiedRate'] = round(normal / total * 100, 1) if total else 0.0
    p['submitRate'] = round(len(insp) / p['storeCount'] * 100, 1) if p.get('storeCount') else 0.0
    p['regions'] = sorted({s.get('region') for s in ss if s.get('region')})
    print(f"  [CG pos] {g}: 巡检 {len(insp)} / 平均 {p['avgScore']}")
d['totalInspected'] = sum(_i(p.get('inspectedCount')) for p in d.get('positions', []))

# ---------- 4. selfInspection ----------
si = d['selfInspection']
old_self_sc = {}
for r in si.get('regions', []):
    key = (r.get('position'), r.get('region'))
    old_self_sc[key] = max(old_self_sc.get(key, 0), _i(r.get('storeCount')))
raw_region_sc = {}
try:
    raw = json.load(open('data/raw/2026-09.json', encoding='utf-8'))
    for org, pd in raw.get('positions', {}).items():
        label = ORG2LABEL.get(org, org)
        for leaf in pd.get('leaves') or []:
            raw_region_sc[(label, leaf.get('organizeName'))] = _i(leaf.get('currentStoreCount'))
except Exception as e:
    print('[WARN] raw leaves 读取失败:', e)

sreg = defaultdict(list)
for s in si.get('stores', []):
    sreg[(s.get('position'), s.get('region') or '未分区')].append(s)
new_self_regions = []
for (pos, rn), ss in sreg.items():
    completed = sum(_i(s.get('completed')) for s in ss)
    expected = sum(_i(s.get('expected')) for s in ss)
    qualified = sum(_i(s.get('qualified')) for s in ss)
    unq = sum(_i(s.get('unqualified')) for s in ss)
    st = sum(_s(s.get('totalScore')) for s in ss)
    cnt = sum(_i(s.get('scoreCount')) for s in ss)
    reviewed = sum(_i(s.get('reviewedReports')) for s in ss)
    submitted = sum(_i(s.get('submittedReports')) for s in ss)
    enrolled = sum(1 for s in ss if _i(s.get('submittedReports')) > 0 or _i(s.get('completed')) > 0)
    sc = old_self_sc.get((pos, rn)) or raw_region_sc.get((pos, rn)) or 0
    new_self_regions.append({
        'region': rn, 'position': pos, 'storeCount': sc,
        'completed': completed, 'expected': expected,
        'unfinished': max(expected - completed, 0),
        'kaidian': sum(_i(s.get('kaidian')) for s in ss),
        'dayan': sum(_i(s.get('dayan')) for s in ss),
        'qualified': qualified, 'unqualified': unq,
        'expired': sum(_i(s.get('expired')) for s in ss),
        'completionRate': round(completed / expected * 100, 1) if expected else 0.0,
        'qualifiedRate': round(qualified / completed * 100, 1) if completed else 0.0,
        'avgScore': round(st / cnt, 2) if cnt else 0.0,
        'submitRate': round(enrolled / sc * 100, 1) if sc else 0.0,
        'reviewRate': round(reviewed / submitted * 100, 1) if submitted else 0.0,
        'needRectify': sum(_i(s.get('needRectify')) for s in ss),
        'rectified': sum(_i(s.get('rectified')) for s in ss),
        'rectifyTotal': sum(_i(s.get('rectifyTotal')) for s in ss),
        'pendingAudit': sum(_i(s.get('pendingAudit')) for s in ss),
        'unfinished2': sum(_i(s.get('unfinished')) for s in ss),
        'enrolledCount': enrolled,
        '_scoreTotal': st, '_scoreCount': cnt,
        '_reviewed': reviewed, '_submitted': submitted, '_enrolled': enrolled,
        'stores': sorted(ss, key=lambda s: (-(s.get('avgScore') or 0), s.get('storeName', ''))),
    })
new_self_regions.sort(key=lambda r: (pos_rank(r['position']), -r['completed']))
si['regions'] = new_self_regions
print('[self regions]', len(new_self_regions), '重建')

for p in si.get('positions', []):
    g = p['position']
    ss = [s for s in si.get('stores', []) if s.get('position') == g]
    if not ss:
        continue
    completed = sum(_i(s.get('completed')) for s in ss)
    expected = sum(_i(s.get('expected')) for s in ss)
    qualified = sum(_i(s.get('qualified')) for s in ss)
    st = sum(_s(s.get('totalScore')) for s in ss)
    cnt = sum(_i(s.get('scoreCount')) for s in ss)
    reviewed = sum(_i(s.get('reviewedReports')) for s in ss)
    submitted = sum(_i(s.get('submittedReports')) for s in ss)
    enrolled = sum(1 for s in ss if _i(s.get('submittedReports')) > 0 or _i(s.get('completed')) > 0)
    p['completed'] = completed
    p['expected'] = expected
    p['unfinished'] = max(expected - completed, 0)
    p['completionRate'] = round(completed / expected * 100, 1) if expected else 0.0
    p['qualified'] = qualified
    p['qualifiedRate'] = round(qualified / completed * 100, 1) if completed else 0.0
    p['avgScore'] = round(st / cnt, 2) if cnt else 0.0
    p['submitRate'] = round(enrolled / p['storeCount'] * 100, 1) if p.get('storeCount') else 0.0
    p['reviewRate'] = round(reviewed / submitted * 100, 1) if submitted else 0.0
    p['regions'] = sorted({s.get('region') for s in ss if s.get('region')})
    print(f"  [self pos] {g}: 完成 {completed} / 应完成 {expected} = {p['completionRate']}%")

si['totalCompleted'] = sum(_i(s.get('completed')) for s in si.get('stores', []))
si['totalExpected'] = sum(_i(s.get('expected')) for s in si.get('stores', []))
si['totalUnfinished'] = max(si['totalExpected'] - si['totalCompleted'], 0)
_t = sum(_s(s.get('totalScore')) for s in si.get('stores', []))
_c = sum(_i(s.get('scoreCount')) for s in si.get('stores', []))
si['totalAvgScore'] = round(_t / _c, 2) if _c else 0.0
_tv = sum(_i(s.get('reviewedReports')) for s in si.get('stores', []))
_ts = sum(_i(s.get('submittedReports')) for s in si.get('stores', []))
si['totalReviewRate'] = round(_tv / _ts * 100, 1) if _ts else 0.0
si['totalStores'] = sum(_i(p.get('storeCount')) for p in si.get('positions', []))

json.dump(root, open(P, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('[OK] data.json 已写回')
