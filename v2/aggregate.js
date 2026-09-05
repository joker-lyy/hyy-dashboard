/* ============================================================================
   按任意日期区间实时聚合
   ----------------------------------------------------------------------------
   数据来源：data/raw/YYYY-MM.json（由 scripts/collect_raw.py 按月采集）
   产出    ：与 data/data.json 完全同构的对象，可直接喂给现有 render 函数

   【精度说明 —— 重要，页面会如实标注】
   · 报告级指标（分数 / 报告份数 / 合格状态 / 完成次数 / 日期）
        → 来自逐条报告明细，按天精确，任意区间都准
   · 区间聚合指标（不合格项数 / 问题类别统计 / 整改进度）
        → 慧运营接口只能按区间返回汇总值、无法再按天拆分，因此按「月」采集。
          所选区间若未完整覆盖某个月，该月这部分会整体计入，结果略偏高。
   ============================================================================ */

// 数据相对路径：自动适配两种部署结构。
//  1) GitHub Pages 部署（v2/ 子目录 + 仓库根 data/）：页面在 .../v2/ → 需要 ../data/raw
//  2) 国内镜像/扁平部署（index.html 在根 + data/ 在根子目录）：需要 data/raw
// 用 script 自身 URL 推断：v2 部署时 aggregate.js 在 .../v2/aggregate.js，其父级是 v2/；
// 因此以 `aggregate.js` 的 URL 路径作为基准来拼 RAW_BASE。
const AGG_SELF = (document.currentScript && document.currentScript.src) || '';
// 取 .../<dir>/aggregate.js 的 <dir>，若不在 v2/ 子目录则视为扁平部署
const IS_V2_DEPLOY = /\/v2\/aggregate\.js(\?|$)/.test(AGG_SELF) || /\/v2\/?$/.test(location.pathname);
const RAW_BASE = IS_V2_DEPLOY ? '../data/raw' : 'data/raw';
const DATA_JSON_FOR_BASELINE = IS_V2_DEPLOY ? '../data/data.json' : 'data/data.json';

// 与 scripts/hhy_config.py 的 POSITION_LABELS 保持一致
const RAW_POSITION_LABELS = {
  '培训组': '培训组（直营组）',
  '新店运营组': '新店运营组',
  '加盟营运组': '加盟营运组',
  '新店筹建组': '新店筹建组',  // fix21+：慧运营 REAL 组织名（user 截图里就是这个）
  '新店筹备组': '新店筹建组',  // 兼容历史键名（fix18 早期搜过这个名）
};

let rawIndexCache = null;
const rawMonthCache = {};   // 'YYYY-MM' -> payload

/* ---------------- 基础工具 ---------------- */
function rawSafeInt(v, d = 0) {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return isNaN(n) ? d : Math.round(n);
}
function rawSafeFloat(v, d = null) {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return isNaN(n) ? d : n;
}
function rawRate(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 1000) / 10;
}
function rawIsTestStore(name) {
  if (!name) return false;
  const s = String(name);
  return s.indexOf('测试') >= 0 || s.indexOf('删除') >= 0;
}
// 镜像 server.py 的 match_region：从右往左找组织树里真实存在的区域名
/* fix108：慧运营 report/list 账号级全组织可见，培训组桶(8/9月)混入全部 403 家门店。
   按 nl 组织路径判断是否属于本组；orgName 即 nl 中的组织段（培训组/新店运营组/加盟营运组/新店筹建组） */
function rawInOrgNl(nl, orgName){
  return !nl || String(nl).indexOf(orgName) >= 0;
}
function rawMatchRegion(nameLink, regionNames) {
  if (!nameLink) return '未分配区域';
  const parts = String(nameLink).split('/').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return '未分配区域';
  if (regionNames && regionNames.size) {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (regionNames.has(parts[i])) return parts[i];
    }
  }
  return parts[parts.length - 1];
}
function monthKey(dateStr) { return String(dateStr || '').slice(0, 7); }

/* fix97：leaves 为空的月份（如 2026-07 培训组/加盟营运组）区域聚合会整体跳过 →
   区域汇总「无数据」。兜底：从该岗位区间内门店的组织路径末段反推区域叶子
   （门店数未知记 0，之后由 tryAggregateRange 用 data.json 基线还原）。 */
function synthLeavesIfEmpty(posLabel, leaves, storeBuckets) {
  if ((leaves || []).length) return leaves;
  const seen = new Set();
  const synth = [];
  for (const [key, b] of Object.entries(storeBuckets || {})) {
    if (posLabel && key.split('||')[0] !== posLabel) continue;
    const rname = rawMatchRegion((b && b.orgPath) || '', new Set());
    if (rname && rname !== '未分配区域' && !seen.has(rname)) {
      seen.add(rname);
      synth.push({ organizeName: rname, currentStoreCount: 0 });
    }
  }
  return synth.length ? synth : leaves;
}

/* fix74：跨 raw 月份构建 storeCode → {position, region, orgPath} 反查表
   给 AI 慧检聚合用：每条 AI store 拿到（岗位、区域），无对应则丢弃。
   区域：用 raw 月份的 leaves 的 organizeName 反查 orgPath 末段；
        若没有叶子（极端情况）退到 orgPath 末段。 */
function buildRawStoreMap(loaded, baselineStoreMap) {
  const map = {};
  for (const month of loaded) {
    const payload = rawMonthCache[month];
    if (!payload) continue;
    for (const [orgName, pdata] of Object.entries(payload.positions || {})) {
      const posLabel = RAW_POSITION_LABELS[orgName] || orgName;
      const leaves = pdata.leaves || [];
      const regionNames = new Set(leaves.map(l => l.organizeName));
      const seen = new Set();
      for (const arr of [pdata.cg || [], pdata.zj || [], pdata.sp || []]) {
        for (const r of arr) {
          if (!rawInOrgNl(r.nl, orgName)) continue; // fix108
          const sc = String(r.sc || '');
          if (!sc || seen.has(sc)) continue;
          seen.add(sc);
          if (map[sc] && map[sc].orgPath) continue;   // 已存在且有完整 orgPath
          map[sc] = {
            position: posLabel,
            region: rawMatchRegion(r.nl, regionNames),
            orgPath: r.nl || '',
          };
        }
      }
    }
  }
  return map;
}
/* fix37：根据"报表刷新于"时间计算区间内每天的应完成份数。
   业务规则（用户 2026-09-02 截图确认）：
   · 一家门店每天应完成 2 份：开店自检（14:00 前完成）+ 打烊自检（20:00 开始）
   ·"报表刷新于"是数据采集的最远时间点（由 raw/index.json.generatedAt 给出）
   · 对区间内每一天：
     ‒ 该天 < 报表刷新日 → 当天 2 份（完整天）
     ‒ 该天 == 报表刷新日 → 按报表刷新小时分档：14:00 前 0 份 / 14~20 点 1 份 / ≥ 20 点 2 份
     ‒ 该天 > 报表刷新日 → 0 份（数据尚未采集，计入应完成会高估分母）
   返回值：单店在 [startDateStr, endDateStr] 区间内的应完成总份数 */
function dailyExpected(generatedAtUtc, startDateStr, endDateStr) {
  if (!startDateStr || !endDateStr) return 0;
  if (!generatedAtUtc) {
    // 没拿到刷新时间，回退旧口径（区间总天 × 2）
    const days = Math.max(1, Math.round((new Date(endDateStr) - new Date(startDateStr)) / 86400000) + 1);
    return days * 2;
  }
  // raw/index.json 的 generatedAt 是 UTC 字符串（如 "2026-09-02 07:43:23"），对应北京时间
  const utc = new Date(generatedAtUtc.replace(' ', 'T') + 'Z');
  if (isNaN(utc.getTime())) {
    const days = Math.max(1, Math.round((new Date(endDateStr) - new Date(startDateStr)) / 86400000) + 1);
    return days * 2;
  }
  const bj = new Date(utc.getTime() + 8 * 3600 * 1000);
  const dataDate = bj.toISOString().slice(0, 10);
  const dataHour = bj.getUTCHours(); // 整体 +8 后 bj 的 UTC 字段就是北京时间
  // 遍历区间每一天
  let total = 0;
  const start = new Date(startDateStr + 'T00:00:00Z').getTime();
  const end = new Date(endDateStr + 'T00:00:00Z').getTime();
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d < dataDate) {
      total += 2;             // 报表刷新之前的天 = 完整天
    } else if (d === dataDate) {
      if (dataHour < 14) total += 0;
      else if (dataHour < 20) total += 1;
      else total += 2;
    } else {
      // d > dataDate：报表还没采到，不计入应完成（否则完成率会被低估）
      // 这里 continue = 0 份
    }
  }
  return total;
}

/* ---------------- 月份文件加载 ---------------- */
async function loadRawIndex() {
  if (rawIndexCache) return rawIndexCache;
  try {
    const resp = await fetch(`${RAW_BASE}/index.json`, { cache: 'no-store' });
    if (!resp.ok) { rawIndexCache = {}; return rawIndexCache; }
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('json')) { rawIndexCache = {}; return rawIndexCache; }
    rawIndexCache = await resp.json();
    return rawIndexCache;
  } catch (e) {
    rawIndexCache = {};
    return rawIndexCache;
  }
}

/* fix10：从 data.json 拿组织树门店基线（7/46/341），与 raw.positions.leaves 是否齐全无关。
   raw 月份文件里很多岗位的 leaves 是空的（按报告范围裁剪），用它会算出 0；
   只有 data.json 是组织树实时全量。失败退到 leaves 累加（二级兜底）。 */
let baselineCache = null;
async function loadBaselineStoreCounts() {
  if (baselineCache) return baselineCache;
  try {
    const resp = await fetch(DATA_JSON_FOR_BASELINE, { cache: 'no-store' });
    if (resp.ok) {
      const j = await resp.json();
      const map = {};
      for (const p of (j.data && j.data.positions) || []) {
        if (p && p.position != null) map[p.position] = p.storeCount;
      }
      baselineCache = map;
      return map;
    }
  } catch (e) { /* 网络失败走下面兜底 */ }
  baselineCache = {};
  return baselineCache;
}

/* fix54：自定义区间视图下，AI 慧检为企业级报告（ent=cjss），不属于分岗位 raw 采集模型，
   无法按所选日期精确拆分。这里直接复用 baseline data.json 里的最新全量 aiInspection 兜底，
   并打 _rangeNote 标记，让页面如实提示「该板块显示最新全量、未做区间拆分」。
   若云端尚未跑出 aiInspection，则回落为空结构（AI 板块显示「无数据」，不崩）。 */
let baselineAiCache = null;
async function loadBaselineAiInspection() {
  if (baselineAiCache !== null) return baselineAiCache;
  try {
    const resp = await fetch(DATA_JSON_FOR_BASELINE, { cache: 'no-store' });
    if (resp.ok) {
      const j = await resp.json();
      const ai = (j.data && j.data.aiInspection) || null;
      baselineAiCache = ai && Array.isArray(ai.regions) ? ai : null;
      return baselineAiCache;
    }
  } catch (e) { /* 网络失败走回落 */ }
  baselineAiCache = null;
  return null;
}

async function loadRawMonth(month) {
  if (rawMonthCache[month]) return rawMonthCache[month];
  try {
    const resp = await fetch(`${RAW_BASE}/${month}.json`, { cache: 'no-store' });
    if (!resp.ok) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('json')) return null;
    rawMonthCache[month] = await resp.json();
    return rawMonthCache[month];
  } catch (e) {
    return null;
  }
}

function monthsInRange(start, end) {
  const out = [];
  if (!start || !end) return out;
  let [y, m] = start.slice(0, 7).split('-').map(Number);
  const [ey, em] = end.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function ensureRawMonths(months) {
  await loadRawIndex();
  await Promise.all(months.map(m => loadRawMonth(m).catch(() => null)));
  return months.filter(m => rawMonthCache[m]);
}

/* ---------------- 筛选 ---------------- */
function filterByDate(rows, start, end) {
  return (rows || []).filter(r => r.d && r.d >= start && r.d <= end);
}

/* ============================================================================
   常规巡检（QSC）
   ============================================================================ */
function aggregateRegular(months, start, end, baselineStoreMap) {
  // —— 跨月共享的累加器（必须在月份循环之外，否则同一家店会在各月各建一条）——
  // key 统一用  "岗位||门店名"，避免不同岗位的同名门店互相覆盖
  const storeBuckets = {};   // 报告级明细（按天精确）
  const siMap = {};          // 月度聚合：门店不合格项数（跨月累加）
  const rectMap = {};        // 月度聚合：门店整改进度（跨月累加）
  const leafMap = {};        // 岗位 -> 组织树叶子（后出现的月份覆盖前面的，即取最新）
  const categoryAgg = {};    // 问题类别（跨月累加）
  const tplItemCount = {};
  const monthScope = [];

  // 先把已知岗位全部占位，避免某些月份 API 没返回 leaves 时岗位被悄悄丢掉
  for (const posLabel of Object.values(RAW_POSITION_LABELS)) {
    leafMap[posLabel] = [];
  }

  for (const month of months) {
    const payload = rawMonthCache[month];
    if (!payload) continue;
    Object.assign(tplItemCount, payload.tplItemCount || {});
    const fully = start <= payload.start && end >= payload.end;
    monthScope.push({ month, fully, start: payload.start, end: payload.end });

    for (const [orgName, pdata] of Object.entries(payload.positions || {})) {
      const posLabel = RAW_POSITION_LABELS[orgName] || orgName;
      if (!leafMap[posLabel]) leafMap[posLabel] = [];
      if ((pdata.leaves || []).length) leafMap[posLabel] = pdata.leaves;

      // fix108：按 nl 组织路径过滤（培训组桶 8/9 月混入全部 403 家），rectification 无 nl 用本组门店名匹配
      const orgStoreNames = new Set();
      for (const r of (pdata.storeInspection || [])) {
        if (!rawInOrgNl(r.nl, orgName)) continue;
        if (r.sn) orgStoreNames.add(r.sn);
      }

      for (const r of (pdata.storeInspection || [])) {
        if (!rawInOrgNl(r.nl, orgName)) continue;
        const key = posLabel + '||' + r.sn;
        if (!r.sn) continue;
        const b = siMap[key] || (siMap[key] = { sum: 0, s: null, st: '', pass: null });
        b.sum += rawSafeInt(r.sum);
        if (r.s != null) b.s = r.s;
        if (r.st) b.st = r.st;
        if (r.pass != null) b.pass = r.pass;
      }
      for (const r of (pdata.rectification || [])) {
        const key = posLabel + '||' + r.sn;
        if (!r.sn) continue;
        if (orgStoreNames.size && !orgStoreNames.has(r.sn)) continue; // fix108
        const b = rectMap[key] || (rectMap[key] = { sum: 0, yzg: 0, dzg: 0, dsh: 0, yqzs: 0 });
        b.sum += rawSafeInt(r.sum);
        b.yzg += rawSafeInt(r.yzg);
        b.dzg += rawSafeInt(r.dzg);
        b.dsh += rawSafeInt(r.dsh);
        b.yqzs += rawSafeInt(r.yqzs);
      }
      for (const c of (pdata.categoryUnq || [])) {
        if (!c.cat) continue;
        const b = categoryAgg[c.cat] || (categoryAgg[c.cat] = { bj: 0, bh: 0 });
        b.bj += rawSafeInt(c.bj);
        b.bh += rawSafeInt(c.bh);
      }

      // 报告明细：按日期精确筛选
      const cg = filterByDate(pdata.cg || [], start, end);
      for (const rep of cg) {
        const sname = (rep.sn || '').trim();
        if (!sname || rawIsTestStore(sname)) continue;
        if (!rawInOrgNl(rep.nl, orgName)) continue; // fix108
        const key = posLabel + '||' + sname;
        const b = storeBuckets[key] || (storeBuckets[key] = {
          position: posLabel, storeName: sname, storeCode: rep.sc, orgPath: rep.nl,
          latestScore: null, latestDate: '', scoreSum: 0, scoreCount: 0,
          reportCount: 0, tplCounts: {}, reportId: '', signId: '',
          isPass: null, storeStatus: '',
        });
        b.reportCount++;
        if (rep.tid) b.tplCounts[rep.tid] = (b.tplCounts[rep.tid] || 0) + 1;
        const sc = rawSafeFloat(rep.s, null);
        if (sc != null) { b.scoreSum += sc; b.scoreCount++; }
        if (rep.d >= b.latestDate) {
          b.latestDate = rep.d;
          b.latestScore = sc;
          b.reportId = rep.rid; b.signId = rep.sid;
          b.isPass = rep.pass; b.storeStatus = rep.st;
        }
      }
    }
  }

  // —— 汇总阶段：按岗位逐个组装，跨月数据此时已全部累加完毕 ——
  const allStores = [];
  const regionMap = {};
  const positionSummaries = [];
  let totalStoreCount = 0;

  for (const [posLabel, rawLeaves] of Object.entries(leafMap)) {
    // fix97：leaves 空的月份兜底反推区域叶子（见 synthLeavesIfEmpty 注释）
    const leaves = synthLeavesIfEmpty(posLabel, rawLeaves, storeBuckets);
    const regionNames = new Set(leaves.map(l => l.organizeName));
    const regionStores = {};

    for (const [key, b] of Object.entries(storeBuckets)) {
      if (key.split('||')[0] !== posLabel) continue;
      const sname = b.storeName;
      const region = rawMatchRegion(b.orgPath, regionNames);
      const sup = siMap[key] || {};
      const rect = rectMap[key];
      // 分数口径与后端一致：优先最新一份报告分数，回退区间平均，再回退汇总接口
      let score = 0;
      if (b.latestScore != null && b.latestScore > 0) score = b.latestScore;
      else if (b.scoreCount > 0) score = Math.round((b.scoreSum / b.scoreCount) * 100) / 100;
      else if (sup.s != null) score = rawSafeFloat(sup.s, 0);

      let inspectedItems = 0;
      for (const [tid, n] of Object.entries(b.tplCounts)) {
        inspectedItems += n * rawSafeInt(tplItemCount[tid]);
      }
      if (inspectedItems === 0) inspectedItems = b.reportCount;
      const unqItems = rawSafeInt(sup.sum);
      const normalItems = Math.max(0, inspectedItems - unqItems);

      const rec = {
        position: posLabel,
        region,
        storeCode: b.storeCode,
        storeName: sname,
        orgPath: b.orgPath,
        score,
        reportCount: b.reportCount,
        sumCount: inspectedItems,
        normalCount: normalItems,
        unqualifiedItems: unqItems,
        // fix60/fix62：「应整改单数」= 累计口径（已整改 yzg + 待整改 dzg + 待审核 dsh）
        //   不会因为已整改完成而归零；与慧运营「层级检核-整改单-门店整改汇总」一致。
        //   口径统一：needRectify = 未完成（dzg + dsh）；rectifyTotal = 累计（yzg + dzg + dsh）
        //   app.js 里 rectTotal = needRectify + rectified = 累计，故 needRectify 保持"未完成"语义。
        needRectify: rect ? (rawSafeInt(rect.dzg) + rawSafeInt(rect.dsh)) : 0,
        rectified: rect ? rawSafeInt(rect.yzg) : 0,
        expired: rect ? rawSafeInt(rect.yqzs) : 0,
        pendingAudit: rect ? rawSafeInt(rect.dsh) : 0,
        rectifyTotal: rect ? (rawSafeInt(rect.yzg) + rawSafeInt(rect.dzg) + rawSafeInt(rect.dsh)) : 0,
        reportId: b.reportId,
        signId: b.signId,
        isPass: sup.pass != null ? sup.pass : b.isPass,
        storeStatus: sup.st || b.storeStatus,
        franchiseeName: '',
        planType: 'CG',
        reportDate: b.latestDate,
      };
      allStores.push(rec);
      (regionStores[region] = regionStores[region] || []).push(rec);
    }

    // 区域聚合
    for (const leaf of leaves) {
      const rname = leaf.organizeName;
      if (!rname) continue;
      const stores = regionStores[rname] || [];
      const scored = stores.filter(s => s.score > 0);
      const avg = scored.length
        ? Math.round((scored.reduce((a, s) => a + s.score, 0) / scored.length) * 100) / 100
        : 0;
      const t = stores.reduce((a, s) => a + rawSafeInt(s.sumCount), 0);
      const n = stores.reduce((a, s) => a + rawSafeInt(s.normalCount), 0);
      const rec = {
        region: rname,
        position: posLabel,
        storeCount: rawSafeInt(leaf.currentStoreCount),
        inspectedCount: stores.length,
        avgScore: avg,
        totalItems: t,
        normalItems: n,
        unqualifiedItems: stores.reduce((a, s) => a + rawSafeInt(s.unqualifiedItems), 0),
        needRectify: stores.reduce((a, s) => a + rawSafeInt(s.needRectify), 0),
        rectified: stores.reduce((a, s) => a + rawSafeInt(s.rectified), 0),
        expired: stores.reduce((a, s) => a + rawSafeInt(s.expired), 0),
        submitRate: rawRate(stores.length, rawSafeInt(leaf.currentStoreCount)),
        qualifiedRate: rawRate(n, t),
        stores,
      };
      if (!regionMap[rname]) regionMap[rname] = { ...rec, stores: [] };
      regionMap[rname].stores.push(...rec.stores);
      // 同区域可能跨岗位出现，重新汇总一次
      const merged = regionMap[rname].stores;
      const mScored = merged.filter(s => s.score > 0);
      const mt = merged.reduce((a, s) => a + rawSafeInt(s.sumCount), 0);
      const mn = merged.reduce((a, s) => a + rawSafeInt(s.normalCount), 0);
      regionMap[rname].inspectedCount = merged.length;
      regionMap[rname].avgScore = mScored.length
        ? Math.round((mScored.reduce((a, s) => a + s.score, 0) / mScored.length) * 100) / 100 : 0;
      regionMap[rname].totalItems = mt;
      regionMap[rname].normalItems = mn;
      regionMap[rname].unqualifiedItems = merged.reduce((a, s) => a + rawSafeInt(s.unqualifiedItems), 0);
      regionMap[rname].needRectify = merged.reduce((a, s) => a + rawSafeInt(s.needRectify), 0);
      regionMap[rname].rectified = merged.reduce((a, s) => a + rawSafeInt(s.rectified), 0);
      regionMap[rname].expired = merged.reduce((a, s) => a + rawSafeInt(s.expired), 0);
      regionMap[rname].qualifiedRate = rawRate(mn, mt);
    }

    // 岗位汇总
    // fix10：「门店数」=组织树全部门店数（已剔测试门店），与所选区间无关，
    //   永远恒定（7 / 46 / 341 等）。
    // 「已巡检 / 平均分 / 不合格率」= 所选区间内动态聚合。
    // 这样切月份时门店数不会乱跳成"区间内报告门店数"，穿透 boot / 定时刷新 / 手动切区
    // 全路径生效，**不再依赖 app.js 里的 baseline 兜底**（根源已修）。
    const posStores = allStores.filter(s => s.position === posLabel);
    const posScored = posStores.filter(s => s.score > 0);
    // fix10：优先取 raw 月份里真实门店基线（fresh、全组织树），再退到 data.json baseline（兜底）。
    // 历史：2026-09-05 用户截图"直营组只有 8 家店"——data.json baseline 里培训组=8 是历史错误值，
    //   实际 raw 2026-09 培训组 leaves（直营组）=9（中山又开了一店）。直接用 leaves 反推更准。
    // fix106: 门店数口径=在营且非测试（data.json 基线已是该口径），raw leaves 是全量口径（含停业/测试）仅作兜底
    const baselineCount = (baselineStoreMap && baselineStoreMap[posLabel]) || 0;
    const leavesCount = leaves.reduce((a, l) => a + rawSafeInt(l.currentStoreCount), 0);
    const storeCount = baselineCount > 0 ? baselineCount : (leavesCount > 0 ? leavesCount : 0);
    totalStoreCount += storeCount;
    const posItems = posStores.reduce((a, s) => a + rawSafeInt(s.sumCount), 0);
    const posNormal = posStores.reduce((a, s) => a + rawSafeInt(s.normalCount), 0);
    positionSummaries.push({
      position: posLabel,
      organizeName: posLabel,
      storeCount,                                                       // 组织树门店数（恒定）
      inspectedCount: posStores.length,                                // 区间内已巡检（随区间变）
      avgScore: posScored.length
        ? Math.round((posScored.reduce((a, s) => a + s.score, 0) / posScored.length) * 100) / 100
        : 0,
      totalItems: posItems,
      normalItems: posNormal,
      unqualifiedItems: posStores.reduce((a, s) => a + rawSafeInt(s.unqualifiedItems), 0),
      qualifiedRate: rawRate(posNormal, posItems),
      submitRate: rawRate(posStores.length, storeCount),                // 分子=已巡检，分母=组织树
      regions: leaves.map(l => l.organizeName),
    });
  }

  // 高发问题（按不合格次数倒序）
  const topCategories = Object.entries(categoryAgg)
    .map(([category, v]) => ({ category, count: v.bh }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);

  return {
    stores: allStores,
    regions: Object.values(regionMap),
    positions: positionSummaries,
    topCategories,
    categoryDetails: [],
    totalStores: totalStoreCount,
    totalInspected: allStores.length,
    _monthScope: monthScope,
  };
}

/* ============================================================================
   门店自检（ZJ）
   ============================================================================ */
function aggregateSelf(months, start, end, baselineStoreMap, generatedAt) {
  // fix37：每店应完成份数按「区间逐天 × 报表刷新日」逐天求和：
  //   · 报表刷新日之前的天 = 2 份
  //   · 报表刷新日当天 = 按刷新时刻分档（14前 0 / 14~20 1 / ≥20 2）
  //   · 报表刷新日之后的天 = 0 份（数据未到，计入分母会拉低完成率）
  // 例：报表刷新 9/2 15:43（1 份），区间 9/1~9/3
  //     → 9/1=2 + 9/2=1 + 9/3=0 = 3 份/店；7 店 × 3 = **21 份**（与用户期望一致）
  const perStoreExpected = dailyExpected(generatedAt, start, end);
  const storeBuckets = {};
  const zjCategoryAgg = {};
  // fix39：整改单聚合（第二阶段见下方 —— rectifyMap 在 storeBuckets 完成后再按"门店名"反查 region）
  let totalCompleted = 0;

  // fix10：跨月共享 leafMap（后出现的月份覆盖前面，取最新）
  // 区域级 baseline 来自 raw 月份文件的 leaves.currentStoreCount
  const leafMap = {};
  for (const posLabel of Object.values(RAW_POSITION_LABELS)) {
    leafMap[posLabel] = [];
  }

  for (const month of months) {
    const payload = rawMonthCache[month];
    if (!payload) continue;
    for (const [orgName, pdata] of Object.entries(payload.positions || {})) {
      const posLabel = RAW_POSITION_LABELS[orgName] || orgName;
      if (!leafMap[posLabel]) leafMap[posLabel] = [];
      if ((pdata.leaves || []).length) leafMap[posLabel] = pdata.leaves;
      const regionNames = new Set(leafMap[posLabel].map(l => l.organizeName));

      for (const c of (pdata.zjItems || [])) {
        if (!c.cat) continue;
        const b = zjCategoryAgg[c.cat] || (zjCategoryAgg[c.cat] = { bh: 0 });
        b.bh += rawSafeInt(c.bh);
      }

      const zj = filterByDate(pdata.zj || [], start, end);
      for (const rep of zj) {
        const sname = (rep.sn || '').trim();
        if (!sname || rawIsTestStore(sname)) continue;
        if (!rawInOrgNl(rep.nl, orgName)) continue; // fix108
        const region = rawMatchRegion(rep.nl, regionNames);
        const key = posLabel + '||' + sname;
        const b = storeBuckets[key] || (storeBuckets[key] = {
          position: posLabel, region, storeCode: rep.sc, storeName: sname,
          completed: 0, kaidian: 0, dayan: 0, qualified: 0, unqualified: 0,
          totalScore: 0, scoreCount: 0, latestDate: '', reportId: '', signId: '',
          reports: [],  // fix46：存该店所有自检报告，弹窗"查看报告(N)"用
        });
        b.completed++;
        totalCompleted++;
        if (String(rep.tn || '').indexOf('开店') >= 0) b.kaidian++;
        else if (String(rep.tn || '').indexOf('打烊') >= 0) b.dayan++;
        if (rep.pass) b.qualified++;
        if (String(rep.ps || '') === '不合格') b.unqualified++;
        // 未点评时 score 是字符串「未点评」，但 raw 里正常分数也以字符串"100.0"返回
        // fix31：必须显式排除"未点评"并按 Number() 解析数字，否则 scoreCount 永远是 0
        // fix34：去掉 num > 0 过滤，让 0 分（不合格报告）也计入平均分，否则有不合格时平均分虚高
        const sc = rep.s;
        if (sc != null && sc !== '' && sc !== '未点评' && sc !== '未评') {
          const num = Number(sc);
          if (!isNaN(num)) {
            b.totalScore += num;
            b.scoreCount++;
          }
        }
        if (rep.d >= b.latestDate) {
          b.latestDate = rep.d;
          b.reportId = rep.rid || '';
          b.signId = rep.sid || '';
        }
        // fix46：累计该店所有自检报告（弹窗列表用）
        b.reports.push({
          d: rep.d, tn: rep.tn || '',
          pass: !!rep.pass, ps: rep.ps || '',
          s: (rep.s != null && rep.s !== '' && rep.s !== '未点评' && rep.s !== '未评') ? Number(rep.s) : null,
          rid: rep.rid || '', sid: rep.sid || '',
        });
      }
    }
  }

  // fix39：先把 sn → region 全局映射建好（storeBuckets 里 region 已经匹配过；
  //   仍空白的，再用 门店名 去 leaves 全集找 region；其次再回落到 posLabel）
  const snRegionMap = {};
  for (const k of Object.keys(storeBuckets)) {
    const b = storeBuckets[k];
    if (!b.storeName) continue;
    if (b.region) snRegionMap[b.storeName] = b.region;
  }
  // 用 leaves 全集补一次（raw 没有 zj 报告但出现过门店名也兜底）
  for (const [posLabel, leaves] of Object.entries(leafMap)) {
    for (const lf of leaves) {
      const regionName = lf.organizeName;
      const leafNames = (lf.leaves || []).map(x => typeof x === 'string' ? x : (x && x.name) || '').filter(Boolean);
      for (const ln of leafNames) {
        if (!snRegionMap[ln]) snRegionMap[ln] = regionName;
      }
    }
  }
  // fix39/fix60：把 rectify 按 sn → region 唯一归属；区域聚合时把 r.stores 各自的 yzg/dzg/dsh 累加
  // 应整改单数 = 累计口径：已整改(yzg) + 待整改(dzg) + 待审核(dsh)，不会因整改完成而归零
  const rectifyBySn = {};   // sn -> {yzg, dzg, dsh}
  const rectifyRegionMap = {};   // region -> {yzg, dzg, dsh}（区域汇总额外指标）
  for (const month of months) {
    const payload = rawMonthCache[month];
    if (!payload) continue;
    for (const [orgName, pdata] of Object.entries(payload.positions || {})) {
      const posLabel = RAW_POSITION_LABELS[orgName] || orgName;
      // fix108：本组门店名集合（rectification 无 nl）
      const rectOrgSn = new Set();
      for (const r of (pdata.storeInspection || [])) {
        if (rawInOrgNl(r.nl, orgName) && r.sn) rectOrgSn.add(r.sn);
      }
      for (const r of (pdata.rectification || [])) {
        const sname = (r.sn || '').trim();
        if (!sname || rawIsTestStore(sname)) continue;
        if (rectOrgSn.size && !rectOrgSn.has(sname)) continue; // fix108
        const yzg = rawSafeInt(r.yzg);
        const dzg = rawSafeInt(r.dzg);
        const dsh = rawSafeInt(r.dsh);
        const sn = rectifyBySn[sname] || (rectifyBySn[sname] = { yzg: 0, dzg: 0, dsh: 0 });
        sn.yzg += yzg; sn.dzg += dzg; sn.dsh += dsh;
        const region = snRegionMap[sname] || posLabel;
        const rb = rectifyRegionMap[region] || (rectifyRegionMap[region] = { yzg: 0, dzg: 0, dsh: 0 });
        rb.yzg += yzg; rb.dzg += dzg; rb.dsh += dsh;
      }
    }
  }

  const stores = Object.values(storeBuckets).map(b => ({
    position: b.position,
    region: b.region,
    storeCode: b.storeCode,
    storeName: b.storeName,
    completed: b.completed,
    kaidian: b.kaidian,
    dayan: b.dayan,
    qualified: b.qualified,
    unqualified: b.unqualified,
    totalScore: Math.round(b.totalScore * 10) / 10,
    scoreCount: b.scoreCount,
    avgScore: b.scoreCount ? Math.round((b.totalScore / b.scoreCount) * 100) / 100 : 0,
    reportId: b.reportId,
    signId: b.signId,
    planType: 'ZJ',
    reportDate: b.latestDate,
    reviewedReports: b.scoreCount,
    submittedReports: b.completed,
    // fix46：该店所有自检报告明细（弹窗用，按日期降序）
    reports: (b.reports || []).slice().sort((a, b2) => (b2.d || '').localeCompare(a.d || '')),
  }));

  // 区域聚合
  const regionMap = {};
  for (const s of stores) {
    const r = regionMap[s.position + '||' + s.region] || (regionMap[s.position + '||' + s.region] = {
      region: s.region, position: s.position, stores: [],
    });
    r.stores.push(s);
  }
  const regions = Object.values(regionMap).map(r => {
    const completed = r.stores.reduce((a, s) => a + s.completed, 0);
    const scored = r.stores.filter(s => s.scoreCount > 0);
    // fix10：区域门店数按 baseline(岗位) × raw leaves 比例缩放
    // 例：9月 raw 培训组 leaves 直营组=8，但 baseline=7 → 缩放到 7
    // 8月新店运营组 baseline=46, leaves 累加=46 → 区域 19/8/19/0 直接保留
    // leaves 为空时回退到区间内已巡检门店数（兜底）
    const posLeaves = leafMap[r.position] || [];
    const leaf = posLeaves.find(l => l.organizeName === r.region);
    const posBaseline = baselineStoreMap && baselineStoreMap[r.position];
    const posLeavesSum = posLeaves.reduce((a, l) => a + rawSafeInt(l.currentStoreCount), 0);
    const leafVal = leaf ? rawSafeInt(leaf.currentStoreCount) : null;
    let storeCount;
    if (leafVal != null && posBaseline != null && posBaseline > 0 && posLeavesSum > 0) {
      storeCount = Math.round(leafVal * posBaseline / posLeavesSum);
    } else if (leafVal != null) {
      storeCount = leafVal;
    } else {
      storeCount = r.stores.length;
    }
    // fix37：应完成 = 门店数 × 每店应完成份数（按区间逐天 + 报表刷新时分档求和）
    // 例：报表刷新 9/2 15:43，区间 9/1~9/3 → 每店 (9/1=2)+(9/2=1)+(9/3=0) = 3 份
    //     → 7店 × 3 = **21 份**（与用户期望一致）
    const expected = storeCount * perStoreExpected;
    // fix39/fix60：区域整改进度（累计口径）
    //   应整改单数 = yzg(已整改) + dzg(待整改) + dsh(待审核)，与门店整改汇总 sumNum 一致
    //   已整改 = yzg；未完成 needRectify = dzg + dsh
      let yzgSum = 0, pendSum = 0;
      for (const s of r.stores) {
        const sn = rectifyBySn[s.storeName || ''];
        if (sn && (sn.yzg + sn.dzg + sn.dsh) > 0) {
          s.rectified = sn.yzg;
          s.needRectify = sn.dzg + sn.dsh;
          s.rectifyTotal = sn.yzg + sn.dzg + sn.dsh;
          s.pendingAudit = sn.dsh;
          yzgSum += sn.yzg;
          pendSum += sn.dzg + sn.dsh;
        } else {
          s.rectified = 0;
          s.needRectify = 0;
          s.rectifyTotal = 0;
        }
        // fix41：兜底——yzg=0 且 rectification 没记录但店里有不合格报告时
        //   按不合格份数补"待整改"（慧运营 rectification 表存在漏统计）
        //   例：广州天河正佳广场店 9/1 有 1 份不合格，但 rectification 没进，dzg 应补 1
        if ((s.rectified + s.needRectify) === 0 && (s.unqualified || 0) > 0) {
          s.needRectify = s.unqualified;
          s.rectifyTotal = s.unqualified;
          pendSum += s.needRectify;
        }
      }
      return {
      region: r.region,
      position: r.position,
      storeCount,
      completed,
      expected,
      unfinished: Math.max(0, expected - completed),
      completionRate: expected > 0 ? Math.round((completed / expected) * 1000) / 10 : 0,
      qualified: r.stores.reduce((a, s) => a + s.qualified, 0),
      unqualified: r.stores.reduce((a, s) => a + s.unqualified, 0),
      reviewedReports: r.stores.reduce((a, s) => a + s.scoreCount, 0),
      submittedReports: completed,
      // fix30：补 reviewRate（区域汇总大表"点评率"列用到）
      reviewRate: completed > 0 ? Math.round((r.stores.reduce((a, s) => a + s.scoreCount, 0) / completed) * 1000) / 10 : 0,
      avgScore: scored.length
        ? Math.round((scored.reduce((a, s) => a + s.avgScore, 0) / scored.length) * 100) / 100
        : 0,
      // fix39/fix60/fix62：整改进度（区域汇总"整改率"列用到）
      //   口径统一：
      //     needRectify（未完成）= dzg + dsh
      //     rectifyTotal（累计应整改）= yzg + dzg + dsh  ← 「应整改单数」用这个
      //     rectified（已整改）= yzg
      //   app.js 里 rectTotal = needRectify + rectified 正好等于累计，故这里 needRectify
      //   必须保持"未完成"语义，不能写成累计，否则会重复计算已整改。
      //   fix62：原写法引用未定义变量 dzgSum，导致整个聚合抛异常、回退预生成快照
      //          （应整改单数累计口径修复一直没生效的根因）
      rectified: yzgSum,
      needRectify: pendSum,
      rectifyTotal: yzgSum + pendSum,
      pendingRectify: pendSum,
      rectifyRate: (yzgSum + pendSum) > 0 ? Math.round((yzgSum / (yzgSum + pendSum)) * 1000) / 10 : 0,
      stores: r.stores,
    };
  });

  // fix30：回填每个门店的 expected/unfinished（按区域应完成份数平均分摊）
  for (const region of regions) {
    const perStore = region.storeCount > 0
      ? Math.round(region.expected / region.storeCount)
      : 0;
    for (const s of region.stores) {
      s.expected = Math.max(s.completed || 0, perStore);
      s.unfinished = Math.max(0, s.expected - (s.completed || 0));
    }
  }

  // 岗位聚合
  const posMap = {};
  for (const s of stores) {
    const p = posMap[s.position] || (posMap[s.position] = { position: s.position, stores: [] });
    p.stores.push(s);
  }
  const positions = Object.values(posMap).map(p => {
    // fix10：岗位门店数优先取 data.json baseline（恒定 7/46/341），raw leaves 不全时用它
    const baselineCount = baselineStoreMap && baselineStoreMap[p.position];
    const leavesCount = (leafMap[p.position] || []).reduce((a, l) => a + rawSafeInt(l.currentStoreCount), 0);
    const storeCount = (baselineCount != null && baselineCount > 0) ? baselineCount : leavesCount;
    // fix37：应完成 = 门店数 × 每店应完成份数（按区间逐天 + 报表刷新时分档求和）
    const expected = storeCount * perStoreExpected;
    const completed = p.stores.reduce((a, s) => a + s.completed, 0);
    const qualified = p.stores.reduce((a, s) => a + s.qualified, 0);
    const unqualified = p.stores.reduce((a, s) => a + s.unqualified, 0);
    const scoreCount = p.stores.reduce((a, s) => a + s.scoreCount, 0);
    // fix39：岗位整改进度（汇总下属区域的 yzg/dzg）
    const yzgSum = p.stores.reduce((a, s) => a + (s.rectified || 0), 0);
    const dzgSum = p.stores.reduce((a, s) => a + (s.needRectify || 0), 0);
    return {
      position: p.position,
      storeCount,
      expected,
      completed,
      qualified,
      unqualified,
      scoreCount,
      // fix42：组别汇总·大卡需要的 4 个率（与区域汇总同一算法）
      completionRate: expected > 0 ? Math.round((completed / expected) * 1000) / 10 : 0,
      reviewRate: completed > 0 ? Math.round((scoreCount / completed) * 1000) / 10 : 0,
      qualifiedRate: (qualified + unqualified) > 0
        ? Math.round((qualified / (qualified + unqualified)) * 1000) / 10
        : 0,
      avgScore: (() => {
        const scored = p.stores.filter(s => s.scoreCount > 0);
        return scored.length
          ? Math.round((scored.reduce((a, s) => a + s.avgScore, 0) / scored.length) * 100) / 100
          : 0;
      })(),
      // fix39
      rectified: yzgSum,
      needRectify: dzgSum,
      rectifyRate: (yzgSum + dzgSum) > 0 ? Math.round((yzgSum / (yzgSum + dzgSum)) * 1000) / 10 : 0,
      // fix42：组别大卡底部区域标签
      regions: Array.from(new Set(p.stores.map(s => s.region || '').filter(Boolean))),
    };
  });

  const topCategories = Object.entries(zjCategoryAgg)
    .map(([category, v]) => ({ category, count: v.bh }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);

  const totalScoreSum = stores.reduce((a, s) => a + s.totalScore, 0);
  const totalScoreCount = stores.reduce((a, s) => a + s.scoreCount, 0);

  // fix37：总部应完成 = Σ区域应完成（已按区间逐天 + 报表刷新分档求和）
  const totalExpected = regions.reduce((a, r) => a + (r.expected || 0), 0);
  const totalUnfinished = regions.reduce((a, r) => a + (r.unfinished || 0), 0);
  return {
    positions, regions, stores,
    rankStores: stores.slice().sort((a, b) => b.avgScore - a.avgScore),
    topCategories,
    totalStores: stores.length,
    totalCompleted,
    totalExpected,
    totalUnfinished,
    realExpected: false,
    monthLabel: start.slice(0, 7),
    // 兼容旧调用方：保留 days 字段（按"完整天 × 2 / 2 = 完整天"估算，仅作为 fallback）
    days: perStoreExpected || 1,
    totalAvgScore: totalScoreCount ? Math.round((totalScoreSum / totalScoreCount) * 100) / 100 : 0,
    totalReviewRate: rawRate(totalScoreCount, totalCompleted),
    totalSubmitRate: 0,
  };
}

/* ============================================================================
   视频巡检（SP）
   ============================================================================ */
function aggregateVideo(months, start, end, baselineStoreMap) {
  // —— 跨月共享的累加器（与 aggregateRegular 同样处理）——
  const storeBuckets = {};   // key = 岗位||门店名
  const rectMap = {};
  const leafMap = {};        // 岗位 -> 组织树叶子（取最新月份）
  const categoryAgg = {};

  // 先把已知岗位全部占位
  for (const posLabel of Object.values(RAW_POSITION_LABELS)) {
    leafMap[posLabel] = [];
  }

  for (const month of months) {
    const payload = rawMonthCache[month];
    if (!payload) continue;
    for (const [orgName, pdata] of Object.entries(payload.positions || {})) {
      const posLabel = RAW_POSITION_LABELS[orgName] || orgName;
      if (!leafMap[posLabel]) leafMap[posLabel] = [];
      if ((pdata.leaves || []).length) leafMap[posLabel] = pdata.leaves;

      // fix108：本组门店名集合（rectification 无 nl，按门店名匹配）
      const orgSnSet = new Set();
      for (const r of (pdata.storeInspection || [])) {
        if (rawInOrgNl(r.nl, orgName) && r.sn) orgSnSet.add(r.sn);
      }
      for (const r of (pdata.rectification || [])) {
        const key = posLabel + '||' + r.sn;
        if (!r.sn) continue;
        if (orgSnSet.size && !orgSnSet.has(r.sn)) continue; // fix108
        const b = rectMap[key] || (rectMap[key] = { sum: 0, yzg: 0, dzg: 0, dsh: 0, yqzs: 0 });
        b.yzg += rawSafeInt(r.yzg);
        b.dzg += rawSafeInt(r.dzg);
        b.dsh += rawSafeInt(r.dsh);
        b.yqzs += rawSafeInt(r.yqzs);
      }

      const sp = filterByDate(pdata.sp || [], start, end);
      for (const rep of sp) {
        const sname = (rep.sn || '').trim();
        if (!sname || rawIsTestStore(sname)) continue;
        if (!rawInOrgNl(rep.nl, orgName)) continue; // fix108
        const key = posLabel + '||' + sname;
        const b = storeBuckets[key] || (storeBuckets[key] = {
          position: posLabel, storeName: sname, storeCode: rep.sc, orgPath: rep.nl,
          latestScore: null, latestDate: '', scoreSum: 0, scoreCount: 0,
          reportCount: 0, reportId: '', isPass: null, passCount: 0,
        });
        b.reportCount++;
        const sc = rawSafeFloat(rep.s, null);
        if (sc != null) { b.scoreSum += sc; b.scoreCount++; if (sc >= 90) b.passCount++; }
        if (rep.d >= b.latestDate) {
          b.latestDate = rep.d;
          b.latestScore = sc;
          b.reportId = rep.rid;
          b.isPass = rep.pass;
        }
      }
    }
  }

  // —— 汇总阶段 ——
  const allStores = [];
  const regionMap = {};
  const positionSummaries = [];
  let totalStoreCount = 0;

  for (const [posLabel, rawLeaves] of Object.entries(leafMap)) {
    // fix97：leaves 空的月份兜底（与 aggregateRegular 同源）
    const leaves = synthLeavesIfEmpty(posLabel, rawLeaves, storeBuckets);
    const regionNames = new Set(leaves.map(l => l.organizeName));
    totalStoreCount += leaves.reduce((a, l) => a + rawSafeInt(l.currentStoreCount), 0);
    const regionStores = {};

    for (const [key, b] of Object.entries(storeBuckets)) {
      if (key.split('||')[0] !== posLabel) continue;
      const rect = rectMap[key];
      let score = 0;
      if (b.latestScore != null && b.latestScore > 0) score = b.latestScore;
      else if (b.scoreCount > 0) score = Math.round((b.scoreSum / b.scoreCount) * 100) / 100;
      const rec = {
        position: posLabel,
        region: rawMatchRegion(b.orgPath, regionNames),
        storeCode: b.storeCode,
        storeName: b.storeName,
        orgPath: b.orgPath,
        score,
        sumCount: b.reportCount,
        normalCount: 0,
        reportCount: b.reportCount,
        unqualifiedItems: 0,
        // fix62：口径统一 —— needRectify = 未完成(dzg+dsh)；rectifyTotal = 累计(yzg+dzg+dsh)
        needRectify: rect ? (rawSafeInt(rect.dzg) + rawSafeInt(rect.dsh)) : 0,
        rectified: rect ? rawSafeInt(rect.yzg) : 0,
        expired: rect ? rawSafeInt(rect.yqzs) : 0,
        rectifyTotal: rect ? (rawSafeInt(rect.yzg) + rawSafeInt(rect.dzg) + rawSafeInt(rect.dsh)) : 0,
        reportId: b.reportId, signId: '',
        passCount: b.passCount,
        isPass: b.isPass, planType: 'VIDEO', reportDate: b.latestDate,
      };
      allStores.push(rec);
      (regionStores[rec.region] = regionStores[rec.region] || []).push(rec);
    }

    for (const leaf of leaves) {
      const rname = leaf.organizeName;
      if (!rname) continue;
      const stores = regionStores[rname] || [];
      const r = regionMap[rname] || (regionMap[rname] = {
        region: rname, position: posLabel,
        storeCount: rawSafeInt(leaf.currentStoreCount),
        inspectedCount: 0, avgScore: 0, totalItems: 0, normalItems: 0,
        unqualifiedItems: 0, needRectify: 0, rectified: 0, expired: 0,
        submitRate: 0, qualifiedRate: 0, stores: [],
      });
      r.stores.push(...stores);
      const scored = r.stores.filter(s => s.score > 0);
      r.inspectedCount = r.stores.length;
      r.avgScore = scored.length
        ? Math.round((scored.reduce((a, s) => a + s.score, 0) / scored.length) * 100) / 100 : 0;
      r.needRectify = r.stores.reduce((a, s) => a + rawSafeInt(s.needRectify), 0);
      r.rectified = r.stores.reduce((a, s) => a + rawSafeInt(s.rectified), 0);
      r.expired = r.stores.reduce((a, s) => a + rawSafeInt(s.expired), 0);
      r.submitRate = rawRate(r.stores.length, r.storeCount);
    }

    const posStores = allStores.filter(s => s.position === posLabel);
    const posScored = posStores.filter(s => s.score > 0);
    const baselineCount = baselineStoreMap && baselineStoreMap[posLabel];
    const leavesCount = leaves.reduce((a, l) => a + rawSafeInt(l.currentStoreCount), 0);
    const storeCount = (baselineCount != null && baselineCount > 0) ? baselineCount : leavesCount;
    positionSummaries.push({
      position: posLabel,
      storeCount,
      inspectedCount: posStores.length,
      avgScore: posScored.length
        ? Math.round((posScored.reduce((a, s) => a + s.score, 0) / posScored.length) * 100) / 100 : 0,
      regions: [...new Set(posStores.map(s => s.region))],
    });
  }

  return {
    positions: positionSummaries,
    regions: Object.values(regionMap),
    stores: allStores,
    rankStores: allStores.slice().sort((a, b) => b.score - a.score),
    topCategories: Object.entries(categoryAgg)
      .map(([category, v]) => ({ category, count: v.bh }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count),
    categoryDetails: [],
    totalStores: totalStoreCount,
    totalInspected: allStores.length,
  };
}

/* ============================================================================
   主入口：按区间聚合出与 data.json 同构的对象
   ============================================================================ */

/* ============================================================================
   AI 慧检（企业级报告，每店一条最新 AI 评分，无日期字段）
   fix74：之前误从 raw 月份文件读 positions.*.storeInspection[]，
     但 raw.storeInspection 与 cg 字段（sn/sc/nl/s/sum/pass）和字段定义完全一致，
     实际是「常规巡检按门店聚合的最新分」而非 AI 慧检——这是用户原话：「你拉了常规巡检的了」。
   正确数据源：data.json.aiInspection.stores[]（包含 AI 评分 reportId、score=10/0）。
   区域：用 raw 月份文件构建 storeCode→(position, region, orgPath) 反查表，给每条 AI store 标岗位/区域。
     反查失败则丢弃（没在组织树里的店不入看板）。
   ============================================================================ */
async function aggregateAi(aiBaseline, rawStoreMap, baselineStoreMap, rawBaselineForRegion) {
  const baselineStores = (aiBaseline && Array.isArray(aiBaseline.stores)) ? aiBaseline.stores : [];
  if (!baselineStores.length) {
    return {
      positions: [], regions: [], stores: [], rankStores: [],
      totalStores: 0, totalInspected: 0,
      _rangeNote: 'AI 慧检暂无数据（baseline 未抓到 AI 报告列表）',
    };
  }

  // 按 (position, region) 分桶
  const buckets = {};
  const seen = new Set();     // fix74：data.json baseline.stores[] 同一 storeCode 重复多次（实测 7 店各×4），按 storeCode 去重
  const dropped = [];
  for (const s of baselineStores) {
    const sc = String(s.storeCode || '');
    const sname = String(s.storeName || '').trim();
    if (!sc || rawIsTestStore(sname)) continue;
    if (seen.has(sc)) continue;
    seen.add(sc);
    const meta = rawStoreMap[sc];
    if (!meta || !meta.position || !meta.region) {
      dropped.push({ sc, sn: sname, reason: '未在 raw 组织树反查到岗位/区域' });
      continue;
    }
    const key = meta.position + '||' + meta.region;
    if (!buckets[key]) buckets[key] = {
      position: meta.position,
      region: meta.region,
      stores: [],
    };
    buckets[key].stores.push({
      storeCode: sc,
      storeName: sname,
      orgPath: meta.orgPath || '',
      score: rawSafeFloat(s.score, 0),
      isPass: !!s.isPass,
      unRectifyNum: rawSafeInt(s.unRectifyNum, 0),
      reportId: s.reportId || '',
      _date: s._date || '',
    });
  }
  if (Object.keys(buckets).length === 0) {
    return {
      positions: [], regions: [], stores: [], rankStores: [],
      totalStores: 0, totalInspected: 0,
      _rangeNote: 'AI 慧检数据存在但与组织树对不上，无法归属到区域。dropped=' + dropped.length,
    };
  }

  // 组装 regions
  const regions = Object.values(buckets).map(b => {
    const scored = b.stores.filter(s => s.score > 0);
    const passed = b.stores.filter(s => s.score >= 10).length;   // 10 = 通过
    const avg = b.stores.length
      ? Math.round((b.stores.reduce((a, s) => a + s.score, 0) / b.stores.length) * 100) / 100
      : 0;
    const scoredAvg = scored.length
      ? Math.round((scored.reduce((a, s) => a + s.score, 0) / scored.length) * 100) / 100
      : 0;
    // fix74：口径与自检/常规对齐——storeCount = 该区域组织树门店基数（baseline），
    //   inspectedCount = AI 实际已巡检门店数。这样「完成率 = 已检 / 基数」才有意义。
    //   基线来源：通过 rawBaselineForRegion callback 取（多数已是 7/46/341）。
    const auditCount = b.stores.length;
    const storeCount = rawBaselineForRegion
      ? rawBaselineForRegion(b.position, b.region) ?? auditCount
      : auditCount;
    const submitRate = storeCount ? rawRate(auditCount, storeCount) : 0;
    return {
      region: b.region,
      position: b.position,
      storeCount,
      inspectedCount: auditCount,
      avgScore: avg,
      scoredAvg,
      hasData: true,
      qualifiedRate: rawRate(passed, auditCount),
      submitRate,
      unqualifiedItems: b.stores.reduce((a, s) => a + (s.isPass ? 0 : 1), 0),
      stores: b.stores,
    };
  }).sort((a, b) => (b.avgScore - a.avgScore) || (b.stores.length - a.stores.length));

  // 组装 positions（用 baseline 真实门店基线，含尚未慧检的岗位也占位——前端会按 storeCount>0 过滤）
  const positionAgg = {};
  for (const r of regions) {
    const p = positionAgg[r.position] || (positionAgg[r.position] = {
      position: r.position,
      storeCount: 0,
      inspectedCount: 0,
      avgScore: 0,
      _sum: 0,
      _count: 0,
    });
    p._sum += r.stores.reduce((a, s) => a + s.score, 0);
    p._count += r.stores.length;
    p.inspectedCount += r.stores.length;
  }
  for (const p of Object.values(positionAgg)) {
    p.avgScore = p._count ? Math.round((p._sum / p._count) * 100) / 100 : 0;
    delete p._sum; delete p._count;
    // 门店基数用 data.json 的 positions[].storeCount（与 baselineStoreMap 同源）
    p.storeCount = baselineStoreMap && baselineStoreMap[p.position]
      ? baselineStoreMap[p.position]
      : 0;
    p.regions = regions.filter(r => r.position === p.position).map(r => r.region);
  }
  const positions = Object.values(positionAgg).sort((a, b) => b.storeCount - a.storeCount);

  const allStores = regions.flatMap(r => r.stores.map(s => ({
    ...s,
    position: r.position,
    region: r.region,
    planType: 'AI',
  })));
  const rankStores = allStores.slice().sort((a, b) => (b.score - a.score) || (a.storeCode - b.storeCode));

  return {
    positions,
    regions,
    stores: allStores,
    rankStores,
    totalStores: positions.reduce((a, p) => a + p.storeCount, 0),
    totalInspected: allStores.length,
  };
}

async function aggregateRange(start, end) {
  const index = await loadRawIndex();
  const all = monthsInRange(start, end);
  const available = (index.months || []);
  const months = all.filter(m => available.indexOf(m) >= 0);
  if (!months.length) throw new Error('该区间暂无原始数据');

  const loaded = await ensureRawMonths(months);
  if (!loaded.length) throw new Error('原始数据加载失败');

  // fix10：拿一份 data.json 里的门店基线，传给聚合函数
  const baselineStoreMap = await loadBaselineStoreCounts();

  const regular = aggregateRegular(loaded, start, end, baselineStoreMap);
  const self = aggregateSelf(loaded, start, end, baselineStoreMap, index.generatedAt);
  const video = aggregateVideo(loaded, start, end, baselineStoreMap);

  // fix74：AI 慧检从 data.json.aiInspection.stores 读（之前误读 raw.storeInspection 实为 CG）。
  //   需要 rawStoreMap（storeCode→岗位/区域）和 baselineStoreMap（岗位→门店数）。
  let ai;
  try {
    const aiBaseline = await loadBaselineAiInspection();
    if (!aiBaseline || !Array.isArray(aiBaseline.stores) || !aiBaseline.stores.length) {
      throw new Error('AI baseline 无 stores 数据');
    }
    const rawStoreMap = buildRawStoreMap(loaded, baselineStoreMap);
    // fix74：AI 区域 storeCount 用 raw 该岗位 leaves 的 currentStoreCount（与其它板块同源）
    const regionBaselineLookup = (pos, reg) => {
      for (const month of loaded) {
        const p = rawMonthCache[month];
        if (!p) continue;
        for (const [orgName, pdata] of Object.entries(p.positions || {})) {
          const posLabel = RAW_POSITION_LABELS[orgName] || orgName;
          if (posLabel !== pos) continue;
          for (const l of pdata.leaves || []) {
            if (l.organizeName === reg) return rawSafeInt(l.currentStoreCount);
          }
        }
      }
      return null;
    };
    ai = await aggregateAi(aiBaseline, rawStoreMap, baselineStoreMap, regionBaselineLookup);
    if (!ai.regions || !ai.regions.length) throw new Error('aggregateAi produced no regions（baseline 与 raw 组织树全部对不上）');
    ai._rangeNote = 'AI 慧检为企业级报告（每店一份最新评分），按 data.json baseline 聚合到区域（不按所选日期拆分）';
  } catch (e) {
    console.warn('[aggregateRange] aggregateAi failed:', e);
    ai = { positions: [], regions: [], stores: [], rankStores: [], totalStores: 0, totalInspected: 0,
      _rangeNote: 'AI 慧检暂无法生成：' + (e && e.message ? e.message : e) };
  }

  // 精度标注：哪些月是部分覆盖（不合格项/整改进度会略偏高）
  const partial = (regular._monthScope || []).filter(m => !m.fully).map(m => m.month);

  return {
    webBase: (window.appData && window.appData.webBase) || 'https://zhyy.ruipos.com',
    startDate: start,
    endDate: end,
    generatedAt: index.generatedAt,
    positions: regular.positions,
    regions: regular.regions,
    stores: regular.stores,
    topCategories: regular.topCategories,
    categoryDetails: regular.categoryDetails,
    totalStores: regular.totalStores,
    totalInspected: regular.totalInspected,
    selfInspection: self,
    videoInspection: video,
    aiInspection: ai,
    overview: {
      selfTopCategories: (self.topCategories || []).slice(0, 10),
      regularTopCategories: (regular.topCategories || []).slice(0, 10),
      videoTopCategories: (video.topCategories || []).slice(0, 10),
    },
    // 前端自己算的标记：用于页面提示「哪些月是部分覆盖」
    _partialMonths: partial,
    _rawMonths: loaded,
  };
}
