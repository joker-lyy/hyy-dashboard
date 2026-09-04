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

const RAW_BASE = 'data/raw';

// 与 scripts/hhy_config.py 的 POSITION_LABELS 保持一致
const RAW_POSITION_LABELS = {
  '培训组': '培训组（直营组）',
  '新店运营组': '新店运营组',
  '加盟营运组': '加盟营运组',
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

/* ---------------- 月份文件加载 ---------------- */
async function loadRawIndex() {
  if (rawIndexCache) return rawIndexCache;
  const resp = await fetch(`${RAW_BASE}/index.json`, { cache: 'no-store' });
  if (!resp.ok) throw new Error('原始数据索引不可用（尚未生成）');
  rawIndexCache = await resp.json();
  return rawIndexCache;
}

async function loadRawMonth(month) {
  if (rawMonthCache[month]) return rawMonthCache[month];
  const resp = await fetch(`${RAW_BASE}/${month}.json`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`缺少 ${month} 原始数据`);
  rawMonthCache[month] = await resp.json();
  return rawMonthCache[month];
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
   常规巡检（CG）
   ============================================================================ */
function aggregateRegular(months, start, end) {
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

      for (const r of (pdata.storeInspection || [])) {
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

  for (const [posLabel, leaves] of Object.entries(leafMap)) {
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
        needRectify: rect ? rawSafeInt(rect.dzg) : 0,
        rectified: rect ? rawSafeInt(rect.yzg) : 0,
        expired: rect ? rawSafeInt(rect.yqzs) : 0,
        pendingAudit: rect ? rawSafeInt(rect.dsh) : 0,
        rectifyTotal: rect ? rawSafeInt(rect.sum) : 0,
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
    const storeCount = leaves.reduce((a, l) => a + rawSafeInt(l.currentStoreCount), 0);
    totalStoreCount += storeCount;
    const posStores = allStores.filter(s => s.position === posLabel);
    const posScored = posStores.filter(s => s.score > 0);
    const posItems = posStores.reduce((a, s) => a + rawSafeInt(s.sumCount), 0);
    const posNormal = posStores.reduce((a, s) => a + rawSafeInt(s.normalCount), 0);
    positionSummaries.push({
      position: posLabel,
      organizeName: posLabel,
      storeCount,
      inspectedCount: posStores.length,
      avgScore: posScored.length
        ? Math.round((posScored.reduce((a, s) => a + s.score, 0) / posScored.length) * 100) / 100
        : 0,
      totalItems: posItems,
      normalItems: posNormal,
      unqualifiedItems: posStores.reduce((a, s) => a + rawSafeInt(s.unqualifiedItems), 0),
      qualifiedRate: rawRate(posNormal, posItems),
      submitRate: rawRate(posStores.length, storeCount),
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
function aggregateSelf(months, start, end) {
  const storeBuckets = {};
  const zjCategoryAgg = {};
  let totalCompleted = 0;

  for (const month of months) {
    const payload = rawMonthCache[month];
    if (!payload) continue;
    for (const [orgName, pdata] of Object.entries(payload.positions || {})) {
      const posLabel = RAW_POSITION_LABELS[orgName] || orgName;
      const leaves = pdata.leaves || [];
      const regionNames = new Set(leaves.map(l => l.organizeName));

      for (const c of (pdata.zjItems || [])) {
        if (!c.cat) continue;
        const b = zjCategoryAgg[c.cat] || (zjCategoryAgg[c.cat] = { bh: 0 });
        b.bh += rawSafeInt(c.bh);
      }

      const zj = filterByDate(pdata.zj || [], start, end);
      for (const rep of zj) {
        const sname = (rep.sn || '').trim();
        if (!sname || rawIsTestStore(sname)) continue;
        const region = rawMatchRegion(rep.nl, regionNames);
        const key = posLabel + '||' + sname;
        const b = storeBuckets[key] || (storeBuckets[key] = {
          position: posLabel, region, storeCode: rep.sc, storeName: sname,
          completed: 0, kaidian: 0, dayan: 0, qualified: 0, unqualified: 0,
          totalScore: 0, scoreCount: 0, latestDate: '', reportId: '', signId: '',
        });
        b.completed++;
        totalCompleted++;
        if (String(rep.tn || '').indexOf('开店') >= 0) b.kaidian++;
        else if (String(rep.tn || '').indexOf('打烊') >= 0) b.dayan++;
        if (rep.pass) b.qualified++;
        if (String(rep.ps || '') === '不合格') b.unqualified++;
        // 未点评时 score 是字符串「未点评」，只有数字才算已点评
        if (rep.s != null && typeof rep.s !== 'string') {
          b.totalScore += Number(rep.s);
          b.scoreCount++;
        }
        if (rep.d >= b.latestDate) {
          b.latestDate = rep.d;
          b.reportId = rep.rid || '';
          b.signId = rep.sid || '';
        }
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
    return {
      region: r.region,
      position: r.position,
      storeCount: r.stores.length,
      completed,
      qualified: r.stores.reduce((a, s) => a + s.qualified, 0),
      unqualified: r.stores.reduce((a, s) => a + s.unqualified, 0),
      reviewedReports: r.stores.reduce((a, s) => a + s.scoreCount, 0),
      avgScore: scored.length
        ? Math.round((scored.reduce((a, s) => a + s.avgScore, 0) / scored.length) * 100) / 100
        : 0,
      stores: r.stores,
    };
  });

  // 岗位聚合
  const posMap = {};
  for (const s of stores) {
    const p = posMap[s.position] || (posMap[s.position] = { position: s.position, stores: [] });
    p.stores.push(s);
  }
  const positions = Object.values(posMap).map(p => ({
    position: p.position,
    storeCount: p.stores.length,
    completed: p.stores.reduce((a, s) => a + s.completed, 0),
    qualified: p.stores.reduce((a, s) => a + s.qualified, 0),
    unqualified: p.stores.reduce((a, s) => a + s.unqualified, 0),
    avgScore: (() => {
      const scored = p.stores.filter(s => s.scoreCount > 0);
      return scored.length
        ? Math.round((scored.reduce((a, s) => a + s.avgScore, 0) / scored.length) * 100) / 100
        : 0;
    })(),
  }));

  const topCategories = Object.entries(zjCategoryAgg)
    .map(([category, v]) => ({ category, count: v.bh }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);

  const totalScoreSum = stores.reduce((a, s) => a + s.totalScore, 0);
  const totalScoreCount = stores.reduce((a, s) => a + s.scoreCount, 0);

  return {
    positions, regions, stores,
    rankStores: stores.slice().sort((a, b) => b.avgScore - a.avgScore),
    topCategories,
    totalStores: stores.length,
    totalCompleted,
    totalExpected: 0,
    totalUnfinished: 0,
    realExpected: false,
    monthLabel: start.slice(0, 7),
    days: Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1),
    totalAvgScore: totalScoreCount ? Math.round((totalScoreSum / totalScoreCount) * 100) / 100 : 0,
    totalReviewRate: rawRate(totalScoreCount, totalCompleted),
    totalSubmitRate: 0,
  };
}

/* ============================================================================
   视频巡检（SP）
   ============================================================================ */
function aggregateVideo(months, start, end) {
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

      for (const r of (pdata.rectification || [])) {
        const key = posLabel + '||' + r.sn;
        if (!r.sn) continue;
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
        const key = posLabel + '||' + sname;
        const b = storeBuckets[key] || (storeBuckets[key] = {
          position: posLabel, storeName: sname, storeCode: rep.sc, orgPath: rep.nl,
          latestScore: null, latestDate: '', scoreSum: 0, scoreCount: 0,
          reportCount: 0, reportId: '', isPass: null,
        });
        b.reportCount++;
        const sc = rawSafeFloat(rep.s, null);
        if (sc != null) { b.scoreSum += sc; b.scoreCount++; }
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

  for (const [posLabel, leaves] of Object.entries(leafMap)) {
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
        needRectify: rect ? rawSafeInt(rect.dzg) : 0,
        rectified: rect ? rawSafeInt(rect.yzg) : 0,
        expired: rect ? rawSafeInt(rect.yqzs) : 0,
        reportId: b.reportId, signId: '',
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
    positionSummaries.push({
      position: posLabel,
      storeCount: posStores.length,
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
async function aggregateRange(start, end) {
  const index = await loadRawIndex();
  const all = monthsInRange(start, end);
  const available = (index.months || []);
  const months = all.filter(m => available.indexOf(m) >= 0);
  if (!months.length) throw new Error('该区间暂无原始数据');

  const loaded = await ensureRawMonths(months);
  if (!loaded.length) throw new Error('原始数据加载失败');

  const regular = aggregateRegular(loaded, start, end);
  const self = aggregateSelf(loaded, start, end);
  const video = aggregateVideo(loaded, start, end);

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
