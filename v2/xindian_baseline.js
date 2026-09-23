/* ============================================================================
   fix202：新店运营组虚拟桶基线与重建逻辑
   ----------------------------------------------------------------------------
   背景：平台 2026-09-21 13:33~14:43 撤销了「新店运营组」组织节点，并把刘浩区域、
   陈晓君区域并入加盟营运组、开业督导组挂回加盟服务部，同时改写了历史报告的
   组织路径(nl)。此后 collect_raw 采到的 raw 月文件里不再有「新店运营组」岗位：
   · 原新店报告 nl 变为「总经办/加盟服务部/加盟营运组/刘浩区域|陈晓君区域」
     → 被前端聚合错误计入加盟营运组（加盟组数字虚高）
   · 开业督导组报告 nl=「总经办/加盟服务部/开业督导组/开业督导组」不含任何岗位名
     → 任何桶都进不去，数据彻底丢失
   · 月视图「新店运营组」桶无数据 → 卡片全 0

   用户口径（9/23）：新店运营组 = 刘浩区域 + 陈晓君区域 + 开业督导区域；
   培训组只有直营 8 家店，绝不能把原新店店归进培训组。

   重建方案：在 loadRawMonth 加载层做预处理（xyReshufflePayload）——
   · 把 nl 命中新店区域段的报告从各岗位桶搬进虚拟「新店运营组」桶
     （cg/zj/sp 按 reportId 去重、storeInspection/rectification 按门店名去重，
      因为同一报告会同时出现在培训组/加盟营运组两个账号范围的数组里）
   · 搬移后给报告 nl 加「新店运营组/」前缀，让 rawInOrgNl/rawMatchRegion 正常工作
   · leaves 用最新接口值：刘浩区域/陈晓君区域从加盟营运组 leaves 实时覆盖，
     开业督导组/范鑫区域用撤销前基线（接口已不返回）
   · 下游 aggregateRegular/Self/Video/Ai 全部零改动自动生效
   ============================================================================ */

// 区域基线：刘浩/陈晓君 = 2026-09 撤销后加盟营运组 leaves 实时值（预处理时动态覆盖）；
// 开业督导组 = 2026-09-22 实测在营 5 家（撤销前组织树 8 家，其中 3 家已非在营，接口不再返回该叶子）；
// 范鑫区域 = 撤销前基线（0 店占位）
const XY_BASELINE = {
  leaves: [
    { organizeName: '刘浩区域', currentStoreCount: 23 },
    { organizeName: '陈晓君区域', currentStoreCount: 21 },
    { organizeName: '开业督导组', currentStoreCount: 5 },
    { organizeName: '范鑫区域', currentStoreCount: 0 },
  ],
  // 静态兜底店名单：2026-09-21 撤销前（git 68b56f4fc）有报告的 29 家门店。
  // 仅用于 nl 缺失的报告兜底归属；正常路径按 nl 区域段动态匹配（可覆盖新开店）
  reportStores: {
    '珠海斗门井岸大信新都汇店': '陈晓君区域',
    '厦门加州商业广场店': '刘浩区域',
    '厦门海沧招商花园城店': '刘浩区域',
    '深圳罗湖笋岗店': '刘浩区域',
    '珠海站A进站口店': '陈晓君区域',
    '广州荔湾中山八店': '陈晓君区域',
    '韶关浈江五里亭店': '刘浩区域',
    '云浮云城源盛华庭店': '刘浩区域',
    '清远北门街店': '刘浩区域',
    '清远清城时代天骄花园店': '刘浩区域',
    '清远英德明珠广场店': '刘浩区域',
    '韶关南雄维新路店': '刘浩区域',
    '广州番禺万达金街店': '陈晓君区域',
    '韶关乐昌碧桂园店': '刘浩区域',
    '佛山顺德保利碧桂园悦公馆店': '刘浩区域',
    '中山小榄百汇时代广场店': '陈晓君区域',
    '厦门星河CoCopark店': '刘浩区域',
    '惠州天益城店': '刘浩区域',
    '惠州惠城水口保利北门店': '刘浩区域',
    '江门鹤山中核和悦府店': '陈晓君区域',
    '茂名东荟城店': '陈晓君区域',
    '广州番禺亚运城店': '陈晓君区域',
    '江门蓬江金蓝海店': '开业督导组',
    '江门恩平锦江国际广场店': '陈晓君区域',
    '茂名茂南南华小区店': '陈晓君区域',
    '中山健康花城店': '陈晓君区域',
    '江门鹤山新华城店': '陈晓君区域',
    '深圳龙岗金地龙城中央店': '刘浩区域',
    '江门新会星汇广场店': '陈晓君区域',
  },
};
const XY_STORE_SET = new Set(Object.keys(XY_BASELINE.reportStores));
const XY_POS_NAME = '新店运营组';
// 需要从加盟营运组 leaves 摘除（已搬去新店桶）的动态叶子
const XY_DYNAMIC_LEAF_NAMES = new Set(['刘浩区域', '陈晓君区域']);

function xyUpdateLeaf(name, count) {
  const l = XY_BASELINE.leaves.find(x => x.organizeName === name);
  if (l && count > 0) l.currentStoreCount = count;
}
function xyCurrentLeaves() {
  return XY_BASELINE.leaves.map(x => ({
    organizeName: x.organizeName,
    currentStoreCount: Number(x.currentStoreCount) || 0,
  }));
}
// 新店运营组当前门店总数（leaves 累加，随接口实时值更新）
function xyPosStoreTotal() {
  return XY_BASELINE.leaves.reduce((a, x) => a + (Number(x.currentStoreCount) || 0), 0);
}
// nl 是否命中新店区域段（路径段匹配，如「总经办/加盟服务部/加盟营运组/刘浩区域」）
function xyRegionHit(nl) {
  const s = String(nl || '');
  if (!s) return null;
  for (const l of XY_BASELINE.leaves) {
    const rn = l.organizeName;
    if (s === rn || s.indexOf('/' + rn) >= 0 || s.indexOf(rn + '/') >= 0) return rn;
  }
  return null;
}

/* 预处理：把撤销后散落的原新店数据重建进虚拟「新店运营组」桶（in-place 改写 payload） */
function xyReshufflePayload(payload) {
  if (!payload || !payload.positions) return;
  if (payload.positions[XY_POS_NAME]) return; // 撤销前采集的月份有真实岗位，不动
  const xy = { leaves: null, cg: [], zj: [], sp: [], storeInspection: [], rectification: [] };
  const xySn = new Set();          // 本月动态报告店名单（nl 命中的店名）
  const seenRid = new Set();       // cg/zj/sp 按 reportId 去重（同报告在多账号范围数组里重复）
  const seenAggSn = new Set();     // storeInspection 按店名去重
  const seenRectSn = new Set();    // rectification 按店名去重

  const entries = Object.entries(payload.positions);
  // 第一遍：搬报告类数组（cg/zj/sp/storeInspection），并从加盟营运组 leaves 摘除已搬走的区域叶子
  for (const [orgName, pdata] of entries) {
    for (const arrKey of ['cg', 'zj', 'sp', 'storeInspection']) {
      const arr = pdata[arrKey];
      if (!arr || !arr.length) continue;
      const keep = [];
      for (const r of arr) {
        const sname = String((r && r.sn) || '').trim();
        const hit = xyRegionHit(r && r.nl);
        const isXy = hit || (sname && XY_STORE_SET.has(sname));
        if (!isXy) { keep.push(r); continue; }
        // 去重：报告类按 rid，聚合类按店名
        if (arrKey === 'storeInspection') {
          if (!sname || seenAggSn.has(sname)) continue;
          seenAggSn.add(sname);
        } else {
          const rid = String((r && r.rid) || '');
          if (rid) {
            if (seenRid.has(rid)) continue;
            seenRid.add(rid);
          }
        }
        // nl 加岗位前缀，让下游 rawInOrgNl(nl,'新店运营组') 与区域匹配正常工作
        if (r && r.nl != null && String(r.nl).indexOf(XY_POS_NAME) < 0) {
          r.nl = XY_POS_NAME + '/' + String(r.nl);
        }
        xy[arrKey].push(r);
        if (sname) xySn.add(sname);
      }
      if (keep.length !== arr.length) pdata[arrKey] = keep;
    }
    if (orgName === '加盟营运组' && Array.isArray(pdata.leaves)) {
      const kept = [];
      for (const l of pdata.leaves) {
        if (l && XY_DYNAMIC_LEAF_NAMES.has(l.organizeName)) {
          xyUpdateLeaf(l.organizeName, Number(l.currentStoreCount) || 0);
        } else kept.push(l);
      }
      pdata.leaves = kept;
    }
  }
  // 第二遍：rectification 无 nl，按店名搬（动态名单优先，静态名单兜底）
  for (const [, pdata] of entries) {
    const arr = pdata.rectification;
    if (!arr || !arr.length) continue;
    const keep = [];
    for (const r of arr) {
      const sname = String((r && r.sn) || '').trim();
      if (sname && (xySn.has(sname) || XY_STORE_SET.has(sname))) xy.rectification.push(r);
      else keep.push(r);
    }
    if (keep.length !== arr.length) pdata.rectification = keep;
  }
  if (xy.cg.length || xy.zj.length || xy.sp.length || xy.storeInspection.length || xy.rectification.length) {
    xy.leaves = xyCurrentLeaves();
    payload.positions[XY_POS_NAME] = xy;
  }
}
