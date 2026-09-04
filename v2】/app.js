// GitHub Pages 静态版：所有数据都是构建期预生成的 JSON，无后端、无跨域
// v2 子目录：从上级 data 取数
const DATA_BASE = "../data";

let appData = null;
let unqData = null;
let unqLoadedAt = null;
let unqStoreRankType = 'all'; // all | cg | self | video
let unqStoreType = 'cg'; // cg | self | video | all
let unqItemCategory = '__all__';
let unqRegionFilter = '__all__';
let unqStoreTopPosition = '__all__';
let unqCategoryTopPosition = '__all__';
let unqPhotoCache = {};
let activePosFilter = '__all__';
let activeMainTab = 'overview';
// v2 精简：去掉 regionRanking / unqualifiedDetail 顶层 tab，三类巡检 tab 各 5 subtab
let activeSubTab = {overview:'', selfInspection:'selfRegions', regularInspection:'regularRegions', videoInspection:'videoRegions'};
let selfTrendPeriod = '7';
let selfTrendGroupBy = 'region';  // 默认按区域看趋势（用户要求看各区域如直营组、刘浩区域）
let videoTrendPeriod = '7';
let videoTrendGroupBy = 'region';  // 视频巡检趋势默认按区域
let currentStart = '';
let currentEnd = '';
let videoProblemPos = '__all__';
let regionRankPeriod = {all:'thisWeek', regular:'thisWeek', self:'thisWeek', video:'thisWeek'};
let regionRankData = {all:{}, regular:{}, self:{}, video:{}};
const PERIOD_LABELS = {thisWeek:'本周', lastWeek:'上周', thisMonth:'本月', lastMonth:'上月'};

function $(id){ return document.getElementById(id); }
function html(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(n){ return n===undefined||n===null?'-':n; }
function round(n, d=2){ const p=Math.pow(10,d); return Math.round((n||0)*p)/p; }
function scoreClass(s){ if(s>=90)return 'score-good'; if(s>=70)return 'score-mid'; return 'score-bad'; }
function rateClass(r){ if(r>=90)return 'rate-good'; if(r>=70)return 'rate-mid'; return 'rate-bad'; }

// v2 手动刷新报表：cache-busting 戳 + URL 拼接辅助（确保刷新时拿到最新 JSON，不读浏览器缓存）
let _refreshTs = 0;
function cb(url){
  const t = _refreshTs || Date.now();
  return url + (url.includes('?') ? '&' : '?') + '_=' + t;
}

function setStatus(msg, type){
  const el = $('statusPill');
  el.textContent = msg;
  el.className = 'status-pill ' + (type||'');
}

/**
 * 构造慧运营报告详情页跳转 URL。
 * 真实格式（用户提供）：
 *   https://hyygray.ruipos.com/pollingReport?beFrom=常规报告详情&reportId=xxx&planType=CG&signId=yyy
 * planType: CG=常规巡检（QSC）, ZJ=门店自检
 *
 * 2026-08-28 通过与慧运营前端 JS 逆向比对确认的真实路由（app~5a11b65b.js 路由表
 * + cloudPolling~344e7fba 组件里的 $router.push 调用）：
 *   CG 常规巡检（QSC） → /pollingReport           ?beFrom=常规报告详情&reportId=&planType=CG&signId=
 *   ZX 专项巡检 → /specialpollingReport    ?beFrom=专项报告详情&reportId=&planType=ZX
 *   ZJ 门店自检 → /selfTestReport-details  ?beFrom=自检报告&planType=ZJ&reportId=   （无 signId）
 *   SP 视频巡检 → /videoReportDetails      ?beFrom=视频报告详情&reportId=
 * 其中 ZJ 详情页内部调用 /web/ri/report/info?reportId=&planType=ZJ，已实测返回 200。
 */
// 每种报告详情页真正依赖的主键参数：
//   CG → 必须同时传 reportId + signId（逆向 cloudPolling~4c591fb7.js 确认，
//         慧运营内部路由 this.$router.push({name:'pollingReport', query:{reportId, planType:'CG', signId}})）
//   ZJ → 只传 reportId（已实测 report/info?planType=ZJ&reportId= 可用）
const REPORT_ROUTES = {
  // 慧运营前端使用 history 模式（真实路径，非 /#/ 哈希路由）。
  // 之前误判为 hash 路由，导致链接变成 /#/pollingReport?... 而打不开；
  // 真实可用格式为用户实测： https://hyygray.ruipos.com/pollingReport?beFrom=常规报告详情&reportId=xxx&planType=CG&signId=yyy
  CG: {path:'/pollingReport',          beFrom:'常规报告详情', planType:'CG', idParam:'signId',  needsReportId:true },
  ZX: {path:'/specialpollingReport',   beFrom:'专项报告详情', planType:'ZX', idParam:'reportId', needsReportId:false},
  ZJ: {path:'/selfTestReport-details', beFrom:'自检报告',     planType:'ZJ', idParam:'reportId', needsReportId:false},
  SP: {path:'/videoReportDetails',     beFrom:'视频报告详情', planType:null, idParam:'reportId', needsReportId:false},
};

// 报告详情页域名必须和取数域名同源。
// 慧运营的灰度环境 hyygray.ruipos.com 与正式环境 zhyy.ruipos.com 数据不互通，
// 之前用了灰度域名，导致点开常规巡检（QSC）报告一律提示「报告不存在」。
// 默认生产环境前端域名；loadData 成功后会根据后端返回的 isGrey 覆盖为灰度/生产
let HYY_WEB_BASE = 'https://zhyy.ruipos.com';

function reportUrl(reportId, signId, planType){
  const pt = String(planType || 'CG').toUpperCase();
  const rt = REPORT_ROUTES[pt] || REPORT_ROUTES.CG;
  const id = rt.idParam === 'signId' ? (signId || reportId) : reportId;
  if(!id) return '';
  let url = `${HYY_WEB_BASE}${rt.path}`
          + `?beFrom=${encodeURIComponent(rt.beFrom)}`;
  if(rt.idParam === 'signId' && rt.needsReportId && reportId){
    url += `&reportId=${encodeURIComponent(reportId)}`
         + `&${rt.idParam}=${encodeURIComponent(id)}`;
  } else {
    url += `&${rt.idParam}=${encodeURIComponent(id)}`;
  }
  if(rt.planType) url += `&planType=${encodeURIComponent(rt.planType)}`;
  return url;
}

function reportLink(item, label, planType){
  if(!item) return '<span style="color:#999">无报告</span>';
  const pt = String(planType || item.planType || 'CG').toUpperCase();
  const url = reportUrl(item.reportId, item.signId, pt);
  if(!url) return '<span style="color:#999">无报告</span>';
  // 加 rel=noreferrer + referrerpolicy=no-referrer，避免从 localhost 跳转时触发 OSS referer 防盗链
  return `<a class="report-link" href="${url}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" onclick="event.stopPropagation()">${html(label||'查看报告')}</a>`;
}

function fmtDate(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// 后端 cachedAt 是 UTC 时间，统一转换为北京时间(UTC+8)显示，避免 8 小时误差
function toBeijing(str){
  if(!str || str === '-') return str;
  let s = String(str).trim().replace(' ', 'T');
  let d = new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z');
  if(isNaN(d.getTime())) return str;
  const bj = new Date(d.getTime() + 8*3600*1000);
  const p = n => String(n).padStart(2,'0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth()+1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;
}

// 慧运营系统上线日：早于此日期没有数据
const SYSTEM_START_DATE = '2026-07-01';

function initDates(){
  // 默认展示「本月 1 号 ~ 今天」
  const r = rangeOfThisMonth();
  if(r.start < SYSTEM_START_DATE) r.start = SYSTEM_START_DATE;
  $('startDate').value = r.start;
  $('startDate').min = SYSTEM_START_DATE;
  $('endDate').value = r.end;
  $('endDate').max = r.end;
  currentStart = $('startDate').value;
  currentEnd = $('endDate').value;
}

/* ---------------- 快捷区间 ---------------- */
// 取「本月 1 号 ~ 今天」
function rangeOfThisMonth(){
  const t = new Date();
  const first = new Date(t.getFullYear(), t.getMonth(), 1);
  return { start: fmtDate(first), end: fmtDate(t) };
}
// 取「上个月 1 号 ~ 上个月最后一天」
function rangeOfLastMonth(){
  const t = new Date();
  const y = t.getFullYear();
  const m = t.getMonth();  // 当前月 0-based
  const lastFirst = new Date(y, m - 1, 1);  // 上月 1 号
  const lastDay   = new Date(y, m, 0);      // 上月最后一天
  return { start: fmtDate(lastFirst), end: fmtDate(lastDay) };
}
// 用户点击「上月数据 / 本月数据」：写回输入框 → 应用 → 高亮按钮
function applyQuickRange(which){
  let r;
  if(which === 'thisMonth') r = rangeOfThisMonth();
  else if(which === 'lastMonth') r = rangeOfLastMonth();
  else return;
  // 与 SYSTEM_START_DATE 兜底：上个月早于系统上线日时，把开始日夹到系统上线日
  if(r.start < SYSTEM_START_DATE) r.start = SYSTEM_START_DATE;
  $('startDate').value = r.start;
  $('endDate').value = r.end;
  $('rangeThisMonthBtn').classList.toggle('active', which === 'thisMonth');
  $('rangeLastMonthBtn').classList.toggle('active', which === 'lastMonth');
  // 复用手写应用流程（校验、currentStart 更新、renderAll、提示条都一套搞定）
  applyDateRange();
}
// 点「应用」或手动改日期时，清掉快捷按钮高亮
function clearQuickRangeButtons(){
  ['rangeThisMonthBtn','rangeLastMonthBtn'].forEach(id=>{
    const el = $(id);
    if(el) el.classList.remove('active');
  });
}

// 页面顶部区间提示条：告诉用户当前看的是哪段数据、精度如何
function ensureRangeBanner(){
  let el = $('rangeBanner');
  if(!el){
    el = document.createElement('div');
    el.id = 'rangeBanner';
    el.className = 'range-banner';
    const header = document.querySelector('header');
    if(header && header.parentNode) header.parentNode.insertBefore(el, header.nextSibling);
  }
  return el;
}

function showRangeBanner(start, end, partialMonths, rawMonths){
  const el = ensureRangeBanner();
  const months = (rawMonths||[]).length;
  let level = 'ok';
  const at = (rawMonths && rawMonths.length)
    ? toBeijing(appData && appData.generatedAt) : null;
  const atTxt = at ? ` · 报表刷新于 ${at}` : '';
  let msg = `当前区间 ${start} ~ ${end} · 由原始数据实时计算（覆盖 ${months} 个月，完整对齐${atTxt}）`;
  if(partialMonths && partialMonths.length){
    level = 'warn';
    msg = `当前区间 ${start} ~ ${end} · 分数/完成次数按天精确${atTxt}；`
        + `其中 ${partialMonths.join('、')} 为部分月份，其「不合格项数 / 整改进度」按整月计入，略偏高`;
  }
  el.className = 'range-banner ' + level;
  el.innerHTML = `<span class="rb-dot"></span><span>${html(msg)}</span>`;
  el.style.display = 'flex';
}

// 原始数据不可用时：如实说明当前是预生成的固定区间快照
function showStaticBanner(start, end, at){
  const el = ensureRangeBanner();
  el.className = 'range-banner warn';
  el.innerHTML = `<span class="rb-dot"></span><span>原始数据尚未生成，暂无法按日期筛选。`
    + `当前显示的是 ${start} ~ ${end} 的预生成快照（生成于 ${at}），每日凌晨自动更新。</span>`;
  el.style.display = 'flex';
}

// 区间聚合失败时显示具体错误（方便排查"按按钮没反应"这种问题）
function showStaticBannerError(start, end, errMsg){
  const el = ensureRangeBanner();
  el.className = 'range-banner error';
  el.innerHTML = `<span class="rb-dot"></span><span>所选区间 ${start} ~ ${end} 暂无法按日期筛选（${errMsg}）。`
    + `已自动切换为预生成快照显示。`
    + `<br>提示：请按 Ctrl+Shift+R 强制刷新页面（浏览器可能缓存了旧版 aggregate.js）。</span>`;
  el.style.display = 'flex';
}

function hideRangeBanner(){
  const el = $('rangeBanner');
  if(el) el.style.display = 'none';
}

// 尝试用原始数据按所选区间实时聚合；失败返回 false 由调用方回退
async function tryAggregateRange(s, e){
  if(typeof aggregateRange !== 'function') return false;
  try{
    setStatus('按所选区间计算…', 'loading');
    const data = await aggregateRange(s, e);
    appData = data;
    renderAll();
    showRangeBanner(s, e, data._partialMonths, data._rawMonths);
    const at = toBeijing(data.generatedAt);
    setStatus(`报表刷新于 ${at} · 当前数据已按 ${s} ~ ${e} 计算`, '');
    return true;
  }catch(err){
    console.warn('按区间聚合不可用，回退到预生成快照：', err && err.message);
    showStaticBannerError(s, e, err && err.message || '未知错误');
    return false;
  }
}

// 启动时一次性把所有月份的原始 JSON 加载到内存（aggregate.js 的 rawMonthCache）。
// 之后任何「应用 / 切区间」都走缓存里的本地筛选，零网络等待。
async function preloadAllRawMonths(){
  if(typeof loadRawIndex !== 'function' || typeof loadRawMonth !== 'function') return false;
  try{
    const idx = await loadRawIndex();
    const months = (idx.months || []);
    if(!months.length) return false;
    setStatus(`加载 ${months.length} 个月份的原始数据…`, 'loading');
    let ok = 0;
    for(const m of months){
      try{ await loadRawMonth(m); ok++; }catch(_){ /* 单月失败不影响其他月 */ }
    }
    return ok > 0;
  }catch(e){
    console.warn('原始数据不可用：', e && e.message);
    return false;
  }
}

async function applyDateRange(){
  clearQuickRangeButtons();
  const s = $('startDate').value;
  const e = $('endDate').value;
  if(!s || !e){
    alert('请选择开始和结束日期');
    return;
  }
  if(s > e){
    alert('开始日期不能晚于结束日期');
    return;
  }
  if(s < SYSTEM_START_DATE){
    alert(`慧运营系统自 ${SYSTEM_START_DATE} 起上线，此前没有数据。`);
    $('startDate').value = SYSTEM_START_DATE;
    return;
  }
  currentStart = s;
  currentEnd = e;
  // 主数据区间变化后，周/月区域排名缓存一并失效
  regionRankData = {all:{}, regular:{}, self:{}, video:{}};

  // 优先按所选区间从已缓存的原始数据实时筛选；若用户选了缓存外月份，
  // aggregateRange 会内部去 fetch 该月文件（首次访问新月份才会再走网络）
  const ok = await tryAggregateRange(s, e);
  if(!ok){
    // tryAggregateRange 内部已经显示了具体错误，保留用户输入
    // 不再走 loadData fallback（否则会覆盖用户选的区间显示成全季度快照）
    return;
  }
}

async function loadData(force){
  $('loading').style.display = 'block';
  $('error').style.display = 'none';
  setStatus('数据加载中…', 'loading');
  try{
    // 静态版：数据由 GitHub Actions 构建期生成，无后端、无需刷新与轮询
    const url = `${DATA_BASE}/data.json`;
    const resp = await fetch(cb(url), {cache:'no-store'});
    let json = await resp.json();
    if(!json.success || !json.data){
      throw new Error(json.error || '数据为空，请稍后刷新重试');
    }
    appData = json.data;
    if(appData && appData.webBase){
      HYY_WEB_BASE = appData.webBase;
    }
    // 组织树门店数基线：data.json 由 Actions 每日生成，含"应覆盖门店数"（已排除测试门店），
    // 这是时点数据、不随查询月份变化。7/8 月的 raw 文件里培训组/加盟营运组组织树采集缺失（leaves 为空），
    // 若用当月 leaves 计算会导致门店数忽大忽小（如 0/46/0 或 8/46/341）。
    // 这里统一以 data.json 的口径为准，保证任何月份显示的"门店数"都是同一个组织树口径。
    try{
      const base = {};
      ((appData && appData.positions) || []).forEach(p => { if(p && p.position) base[p.position] = p.storeCount; });
      if(Object.keys(base).length) window.__BASELINE_STORE_COUNT__ = base;
    }catch(e){}
    // 记录静态数据的固定区间，供 applyDateRange 提示用户
    window.__STATIC_BUILD_RANGE__ = {
      start: appData.startDate || currentStart,
      end: appData.endDate || currentEnd,
      at: toBeijing(json.cachedAt) || '-',
    };
    // 主数据刷新后，区域排名浏览器缓存一并失效，避免慧运营新增报告后仍显示旧数字
    regionRankData = {all:{}, regular:{}, self:{}, video:{}};
    renderAll();
    setStatus('数据更新于 ' + toBeijing(json.cachedAt) || '-', '');
    // 如实标注：当前是预生成的固定区间快照，不是按所选日期实时算的
    const r = window.__STATIC_BUILD_RANGE__;
    if(currentStart === r.start && currentEnd === r.end){
      showRangeBanner(r.start, r.end, [], null);
    }else{
      showStaticBanner(r.start, r.end, r.at);
    }
  }catch(e){
    $('error').textContent = '加载失败：' + e.message;
    $('error').style.display = 'block';
    setStatus('加载失败', 'error');
  }finally{
    $('loading').style.display = 'none';
  }
}

// ===== 数据刷新说明 =====
// data/data.json 是 GitHub Actions 生成的静态快照，浏览器永远只能拉到"已发布"的那一份。
// 要出现新数据，必须触发云端 workflow 重新拉取慧运营 → 重新提交 data/ → Pages 重新部署。
// 所以「手动刷新报表」按钮的完整流程：触发 Actions → 轮询 data.json 快照时间 → 变了才重新载入。
const GH_REPO = 'joker-lyy/hyy-dashboard';
const GH_WF = 'update-data.yml';
const GH_TOKEN_KEY = 'hy_gh_token';

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function getGhToken(){
  let t = localStorage.getItem(GH_TOKEN_KEY);
  if(t) return t;
  t = (prompt(
    '要出现新数据，需要触发 GitHub Actions 云端拉取慧运营。\n' +
    '请输入 GitHub 个人访问令牌（只需输入一次，保存在你这台电脑的浏览器里）：\n\n' +
    '创建方法：github.com → Settings → Developer settings → Personal access tokens →\n' +
    'Generate new token (classic) → 勾选「workflow」权限 → 生成后复制粘贴到下面。\n\n' +
    '（留空点确定 = 只重新加载当前已发布的数据，数据时间不会变）', '') || '').trim();
  if(t.toUpperCase() === '清除'){ localStorage.removeItem(GH_TOKEN_KEY); return ''; }
  if(t) localStorage.setItem(GH_TOKEN_KEY, t);
  return t;
}

// 读取当前线上快照的数据时间（data.json 的 cachedAt）
async function fetchSnapshotTime(){
  try{
    const resp = await fetch(cb(`${DATA_BASE}/data.json`), {cache:'no-store'});
    const json = await resp.json();
    return (json && json.cachedAt) ? json.cachedAt : '';
  }catch(e){ return ''; }
}

// 轮询线上快照时间，直到与 baseline 不同（或超时）。返回新的 cachedAt，超时返回 null
async function pollSnapshotChange(baseline, timeoutMs, intervalMs){
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline){
    await sleep(intervalMs);
    const t = await fetchSnapshotTime();
    if(t && t !== baseline) return t;
  }
  return null;
}

// 清空内存缓存并按当前区间重新加载全部数据，返回数据快照时间
async function localReload(){
  _refreshTs = Date.now();
  unqData = null;
  unqPhotoCache = {};
  regionRankData = {all:{}, regular:{}, self:{}, video:{}};
  window.__STATIC_BUILD_RANGE__ = null;
  try{ if(typeof rawMonthCache !== 'undefined'){ for(const k in rawMonthCache) delete rawMonthCache[k]; } }catch(e){}
  try{ if(typeof rawIndexCache !== 'undefined'){ rawIndexCache = null; } }catch(e){}
  if(typeof aggregateRange === 'function'){
    const dataReady = await preloadAllRawMonths();
    if(dataReady) await tryAggregateRange(currentStart, currentEnd);
    else await loadData(true);
  } else {
    await loadData(true);
  }
  await loadUnqualified();
  const sub = activeSubTab[activeMainTab];
  if(sub && sub.endsWith('Problems')) renderTypeProblems(sub.replace('Problems',''));
  return await fetchSnapshotTime();
}

// 手动刷新报表按钮：
// - 按住 Shift 点击 = 清除已保存的 GitHub 令牌
// - 有令牌：触发云端 Actions 拉取 → 等新数据发布 → 自动载入（真·刷新）
// - 无令牌：仅重新加载当前已发布数据（如实显示数据时间，不显示本地时钟）
async function refreshReport(){
  const btn = $('refreshReportBtn');
  const evt = window.event;
  if(evt && evt.shiftKey){
    localStorage.removeItem(GH_TOKEN_KEY);
    setStatus('已清除 GitHub 令牌，下次刷新会重新询问', 'warn');
    return;
  }
  if(btn){ btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = '刷新中…'; }
  try{
    const token = getGhToken();
    if(!token){
      // 无令牌：只重载已发布数据
      setStatus('正在重新加载已发布数据…（数据时间不会变，如需新数据请输入令牌触发云端拉取）', 'loading');
      const t = await localReload();
      setStatus(t ? ('已重新加载 · 数据生成于 ' + toBeijing(t) + '（触发云端拉取可获得更新的数据）') : '已重新加载', '');
      if(btn) btn.textContent = '✓ 已刷新';
      setTimeout(()=>{ if(btn) btn.textContent = btn.dataset.old || '手动刷新报表'; }, 1500);
      return;
    }
    // 有令牌：触发云端拉取
    setStatus('正在触发云端拉取（GitHub Actions）…', 'loading');
    const baseline = await fetchSnapshotTime();
    const resp = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WF}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ref: 'main'})
    });
    if(resp.status === 204){
      setStatus('云端拉取已启动，正在等待新数据发布（通常 2~10 分钟）…', 'loading');
      if(btn) btn.textContent = '⏳ 等待云端';
      const changed = await pollSnapshotChange(baseline, 20 * 60 * 1000, 15000);
      if(changed){
        const t = await localReload();
        setStatus('✅ 数据已更新至 ' + toBeijing(changed), '');
        if(btn) btn.textContent = '✓ 已更新';
        setTimeout(()=>{ if(btn) btn.textContent = btn.dataset.old || '手动刷新报表'; }, 2500);
      }else{
        setStatus('云端拉取仍在进行（超过 20 分钟未完成），稍后再点一次「手动刷新报表」即可载入结果', 'warn');
        if(btn) btn.textContent = '⏳ 仍在拉取';
        setTimeout(()=>{ if(btn) btn.textContent = btn.dataset.old || '手动刷新报表'; }, 2500);
      }
    } else if(resp.status === 401 || resp.status === 403){
      localStorage.removeItem(GH_TOKEN_KEY);
      let msg = '';
      try{ msg = (await resp.json()).message || ''; }catch(e){}
      setStatus('令牌无效或缺少 workflow 权限（' + msg + '），已清除令牌；请重新点击按钮并输入有效令牌', 'error');
    } else {
      setStatus('触发云端拉取失败（HTTP ' + resp.status + '），可稍后重试', 'error');
    }
  }catch(e){
    setStatus('刷新失败：' + (e && e.message), 'error');
  }finally{
    if(btn){ btn.textContent = btn.dataset.old || '手动刷新报表'; btn.disabled = false; }
  }
}

function renderAll(){
  const d = appData;
  renderOverview(d);
  renderPositions(d);
  renderSelfInspection(d);
  renderRegularInspection(d);
  renderVideoInspection(d);
  // 重模块改为标签页首次激活时再加载，避免首页被 /api/unqualified (40s+) 等阻塞
}

async function loadUnqualified(){
  try{
    const url = `${DATA_BASE}/unqualified.json`;
    const resp = await fetch(cb(url), {cache:'no-store'});
    const json = await resp.json();
    if(!json.success || !json.data) return;
    unqData = json.data;
    unqLoadedAt = toBeijing(json.cachedAt) || new Date().toLocaleString();
    renderUnqualified();
  }catch(e){ console.error('loadUnqualified', e); }
}

function renderUnqualified(){
  if(!unqData) return;
  const active = document.querySelector('#unqSubTabs .subtab.active')?.dataset.sub || 'unqStore';
  if(active === 'unqStore') renderUnqStore();
  else if(active === 'unqItem') renderUnqItem();
  else if(active === 'unqRegion') renderUnqRegion();
  else if(active === 'unqStoreRank') renderUnqStoreRank();
  else if(active === 'unqRegionRank') renderUnqRegionRank();
  else if(active === 'unqStoreTop') renderUnqStoreTop();
  else if(active === 'unqCategoryTop') renderUnqCategoryTop();
}

function fmtRate(v){ return (v*100).toFixed(1) + '%'; }

function unqExpandToggle(id){
  const el = $(id);
  if(!el) return;
  el.style.display = el.style.display === 'table-row' ? 'none' : 'table-row';
}

/* ---------- 不合格明细照片按需加载 ---------- */
async function loadItemPhoto(contentId){
  if(!contentId) return '';
  if(unqPhotoCache[contentId] === '') return '';
  if(unqPhotoCache[contentId]) return unqPhotoCache[contentId];
  unqPhotoCache[contentId] = '__loading__';
  try{
    throw new Error('静态版不提供单问题项照片下钻');
    const json = await fetch(url).then(r=>r.json());
    if(!json.success || !json.data){ unqPhotoCache[contentId] = ''; return ''; }
    const first = (json.data.photos || []).find(p=>(p.urls||[]).length);
    const u = first ? first.urls[0] : '';
    unqPhotoCache[contentId] = u;
    return u;
  }catch(e){ unqPhotoCache[contentId] = ''; return ''; }
}

function getItemPhoto(contentId){
  const v = unqPhotoCache[contentId];
  return v && v !== '__loading__' ? v : '';
}

function refreshUnqPhotos(container){
  if(!container) return;
  container.querySelectorAll('img[data-photo-cid]').forEach(img=>{
    const cid = img.dataset.photoCid;
    const cached = getItemPhoto(cid);
    if(cached){ img.src = cached; img.classList.remove('loading'); return; }
    loadItemPhoto(cid).then(url=>{
      if(url){ img.src = url; img.classList.remove('loading'); }
      else { img.classList.remove('loading'); img.classList.add('no-photo'); img.alt = '无照片'; }
    });
  });
}

function unqItemImg(cid, cls='unq-item-img'){
  return `<img class="${cls} loading" data-photo-cid="${cid}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="">`;
}

function unqItemRow(item, withCount=true){
  const countHtml = withCount ? `<span style="color:#c0392b;font-weight:600">${item.count}次</span>` : '';
  return `
    <div class="unq-item-row" data-cid="${item.contentId||''}">
      ${unqItemImg(item.contentId)}
      <div class="unq-item-body">
        <div class="unq-item-title">${html(item.title)} ${countHtml}</div>
        <span class="unq-item-cat">${html(item.category)}</span>
      </div>
    </div>`;
}

/* ---------- 按门店分类（卡片） ---------- */
function buildUnqStoreTypeChips(){
  const types = [
    {k:'cg', l:'常规巡检（QSC）'},
    {k:'self', l:'每日自检'},
    {k:'video', l:'视频巡检'},
    {k:'all', l:'全部类型'},
  ];
  const el = $('unqStoreTypeChips');
  if(!el) return;
  el.innerHTML = types.map(t=>
    `<button class="chip ${unqStoreType===t.k?'active':''}" data-t="${t.k}">${t.l}</button>`
  ).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{ unqStoreType = btn.dataset.t; buildUnqStoreTypeChips(); renderUnqStore(); };
  });
}

function renderUnqStore(){
  buildUnqStoreTypeChips();
  const search = ($('unqStoreSearch').value||'').trim().toLowerCase();
  const el = $('unqStoreCards');
  if(!el) return;

  // 自检 / 全部类型 / 视频巡检：数据源不同，用简化的门店卡片渲染
  if(unqStoreType !== 'cg'){
    let src = [];
    let planTypeForLink = 'CG';
    if(unqStoreType === 'self'){ src = unqData.selfStoreRank || []; planTypeForLink = 'ZJ'; }
    else if(unqStoreType === 'all'){ src = unqData.allStoreRank || []; planTypeForLink = null; }
    else if(unqStoreType === 'video'){
      // 视频巡检门店来自主看板 videoInspection.stores（有分门店，含 score / unqualifiedItems）
      src = (appData.videoInspection && appData.videoInspection.stores || []).map(v=>({
        store: v.storeName, region: v.region, position: v.position,
        avgScore: v.score, reportCount: v.reportCount,
        reportId: v.reportId, signId: v.signId, unqualifiedItems: v.unqualifiedItems,
      }));
    }
    const rows = src.filter(s=>
      (s.store||'').toLowerCase().includes(search) ||
      (s.region||'').toLowerCase().includes(search)
    );
    el.innerHTML = rows.map(s=>`
      <div class="unq-card">
        <div class="unq-card-head">
          <div>
            <div class="unq-card-title">${html(s.store)}</div>
            <div class="unq-card-meta">${html(s.region)} · ${html(s.position)}</div>
          </div>
          <span class="unq-card-badge">${s.avgScore != null ? s.avgScore + ' 分' : '无分'}</span>
        </div>
        <div class="unq-card-stats">
          <span>报告数 <b>${s.reportCount != null ? s.reportCount : '-'}</b></span>
          ${s.unqualifiedItems != null ? `<span>不合格 <b>${s.unqualifiedItems}</b></span>` : ''}
          ${s.lastDate ? `<span>最近 <b>${html(s.lastDate)}</b></span>` : ''}
        </div>
        <div class="unq-card-actions">
          ${unqStoreType === 'video' ? (s.signId ? reportLink(s, '查看报告', 'CG') : '<span style="color:#999">视频报告暂不支持外链</span>') : reportLink(s, '查看报告', s.planType || planTypeForLink)}
        </div>
      </div>
    `).join('') || '<div class="empty">无数据</div>';
    return;
  }

  const rows = (unqData.byStore||[]).filter(s=>
    (s.store||'').toLowerCase().includes(search) ||
    (s.region||'').toLowerCase().includes(search)
  );
  el.innerHTML = rows.map(s=>`
    <div class="unq-card">
      <div class="unq-card-head">
        <div>
          <div class="unq-card-title">${html(s.store)}</div>
          <div class="unq-card-meta">${html(s.region)} · ${html(s.position)}</div>
        </div>
        <span class="unq-card-badge">不合格 ${s.unqCount} 项</span>
      </div>
      <div class="unq-card-stats">
        <span>涉及问题项 <b>${s.itemCount}</b></span>
        <span>${(s.topItems||[]).length ? `高发问题 Top${Math.min(s.topItems.length,3)}` : '无高发问题'}</span>
      </div>
      <div class="unq-card-items">
        ${(s.topItems||[]).slice(0,3).map(t=>unqItemRow(t)).join('')}
      </div>
      <div class="unq-card-actions">
        <span class="link-btn" onclick="showUnqStoreDetail('${encodeURIComponent(s.store||'')}', '${encodeURIComponent(s.region||'')}', '${encodeURIComponent(s.position||'')}')">查看全部问题</span>
      </div>
    </div>
  `).join('') || '<div class="empty">无数据</div>';
  refreshUnqPhotos(el);
}

function showUnqStoreDetail(storeEnc, regionEnc, positionEnc){
  const store = decodeURIComponent(storeEnc||'');
  const region = decodeURIComponent(regionEnc||'');
  const modal = $('unqItemModal') || document.createElement('div');
  if(!modal.id){ modal.id='unqItemModal'; modal.className='modal'; document.body.appendChild(modal); }
  modal.style.display='flex';
  modal.onclick = e => { if(e.target===modal) modal.style.display='none'; };
  modal.innerHTML = `<div class="modal-box"><div class="modal-header"><h3>${html(store)} · 不合格明细</h3><button class="modal-close" onclick="$('unqItemModal').style.display='none'">&times;</button></div><div class="modal-body">加载中…</div></div>`;
  // 从 itemStoreMap 里找出该门店的所有问题项
  const items = [];
  const itemMap = unqData.itemStoreMap || {};
  const itemLookup = {};
  (unqData.byItem||[]).forEach(i=> itemLookup[i.contentId] = i);
  Object.entries(itemMap).forEach(([cid, list])=>{
    const row = list.find(r=>r.store === store);
    if(!row) return;
    const info = itemLookup[cid];
    if(!info) return;
    items.push({contentId: cid, title: info.title, category: info.category, count: row.count});
  });
  items.sort((a,b)=> b.count - a.count);
  const body = modal.querySelector('.modal-body');
  body.innerHTML = `
    <p class="modal-sub">区域：${html(region)} · 共 ${items.length} 项不合格</p>
    <div class="unq-card-items" id="unqStoreDetailItems">
      ${items.map(t=>unqItemRow(t)).join('') || '<span class="empty">无明细</span>'}
    </div>
  `;
  refreshUnqPhotos(body);
}

/* ---------- 按问题分类（分类芯片 + 卡片） ---------- */
function buildUnqItemCategoryChips(){
  const cats = ['__all__', ...new Set((unqData.byItem||[]).map(i=>i.category).filter(Boolean).sort())];
  const el = $('unqItemCategoryChips');
  if(!el) return;
  el.innerHTML = cats.map(c=>{
    const label = c==='__all__' ? '全部' : c;
    return `<button class="chip ${unqItemCategory===c?'active':''}" data-cat="${html(c)}">${html(label)}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{ unqItemCategory = btn.dataset.cat; buildUnqItemCategoryChips(); renderUnqItem(); };
  });
}

function renderUnqItem(){
  buildUnqItemCategoryChips();
  const search = ($('unqItemSearch').value||'').trim().toLowerCase();
  const rows = (unqData.byItem||[]).filter(i=>{
    const matchCat = unqItemCategory === '__all__' || i.category === unqItemCategory;
    const matchSearch = (i.title||'').toLowerCase().includes(search) || (i.category||'').toLowerCase().includes(search);
    return matchCat && matchSearch;
  }).sort((a,b)=> b.unqCount - a.unqCount);
  const el = $('unqItemCards');
  if(!el) return;
  el.innerHTML = rows.map(i=>`
    <div class="unq-card">
      <div class="unq-card-head">
        <div>
          <div class="unq-card-title">${html(i.title)}</div>
          <div class="unq-card-meta">${html(i.category)}</div>
        </div>
        <span class="unq-card-badge">${i.unqCount} 次</span>
      </div>
      <div class="unq-card-stats">
        <span>涉及门店 <b>${i.storeCount}</b></span>
        <span>巡检次数 <b>${i.inspectCount}</b></span>
        <span>不合格率 <b class="${rateClass(i.unqRate*100)}">${fmtRate(i.unqRate)}</b></span>
      </div>
      <div class="unq-card-items">
        ${unqItemImg(i.contentId)}
        <div style="font-size:12px;color:#666">点击展开查看涉及门店 / 照片</div>
      </div>
      <div class="unq-card-actions">
        <span class="link-btn" onclick="showUnqItemDetail(${i.contentId}, '${encodeURIComponent(i.title||'')}', '${encodeURIComponent(i.category||'')}', ${i.unqCount})">查看门店 / 照片</span>
      </div>
    </div>
  `).join('') || '<div class="empty">无数据</div>';
  refreshUnqPhotos(el);
}

/* ---------- 按区域分类（区域芯片 + 门店卡片） ---------- */
function buildUnqRegionChips(){
  const regs = ['__all__', ...new Set((unqData.byStore||[]).map(s=>s.region).filter(Boolean).sort())];
  const el = $('unqRegionChips');
  if(!el) return;
  el.innerHTML = regs.map(r=>{
    const label = r==='__all__' ? '全部' : r;
    return `<button class="chip ${unqRegionFilter===r?'active':''}" data-reg="${html(r)}">${html(label)}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{ unqRegionFilter = btn.dataset.reg; buildUnqRegionChips(); renderUnqRegion(); };
  });
}

function renderUnqRegion(){
  buildUnqRegionChips();
  const search = ($('unqRegionSearch').value||'').trim().toLowerCase();
  const groups = {};
  (unqData.byStore||[]).forEach(s=>{
    if(unqRegionFilter !== '__all__' && s.region !== unqRegionFilter) return;
    if(search && !(s.region||'').toLowerCase().includes(search) && !(s.store||'').toLowerCase().includes(search)) return;
    (groups[s.region] = groups[s.region] || []).push(s);
  });
  const el = $('unqRegionCards');
  if(!el) return;
  el.innerHTML = Object.entries(groups).sort((a,b)=> b[1].reduce((s,r)=>s+r.unqCount,0) - a[1].reduce((s,r)=>s+r.unqCount,0)).map(([region, stores])=>{
    const totalUnq = stores.reduce((s,r)=>s+r.unqCount, 0);
    const totalItem = stores.reduce((s,r)=>s+r.itemCount, 0);
    return `
      <div class="unq-region-section">
        <div class="unq-region-title">${html(region)} <span class="count">${stores.length} 家门店 · ${totalUnq} 项不合格 · ${totalItem} 个问题项</span></div>
        <div class="unq-card-grid unq-region-grid">
          ${stores.sort((a,b)=> b.unqCount - a.unqCount).map(s=>`
            <div class="unq-card">
              <div class="unq-card-head">
                <div class="unq-card-title">${html(s.store)}</div>
                <span class="unq-card-badge">${s.unqCount} 项</span>
              </div>
              <div class="unq-card-meta" style="margin-bottom:8px">${html(s.position)} · ${s.itemCount} 个问题项</div>
              <div class="unq-card-items">
                ${(s.topItems||[]).slice(0,2).map(t=>unqItemRow(t)).join('')}
              </div>
              <div class="unq-card-actions">
                <span class="link-btn" onclick="showUnqStoreDetail('${encodeURIComponent(s.store||'')}', '${encodeURIComponent(s.region||'')}', '${encodeURIComponent(s.position||'')}')">查看全部</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('') || '<div class="empty">无数据</div>';
  refreshUnqPhotos(el);
}


function buildUnqStoreRankTypeChips(){
  const types = [
    {k:'all', l:'全部类型'},
    {k:'cg', l:'常规巡检（QSC）'},
    {k:'self', l:'每日自检'},
    {k:'video', l:'视频巡检'},
  ];
  const el = $('unqStoreRankTypeChips');
  if(!el) return;
  el.innerHTML = types.map(t=>`
    <button class="fbtn ${unqStoreRankType===t.k?'active':''}" data-t="${t.k}">${t.l}</button>
  `).join('');
  el.querySelectorAll('.fbtn').forEach(btn=>{
    btn.onclick = ()=>{
      unqStoreRankType = btn.dataset.t;
      buildUnqStoreRankTypeChips();
      renderUnqStoreRank();
    };
  });
}

function renderUnqStoreRank(){
  buildUnqStoreRankTypeChips();
  const search = ($('unqStoreRankSearch').value||'').trim().toLowerCase();
  let src = [];
  if(unqStoreRankType === 'cg') src = unqData.storeRank || [];
  else if(unqStoreRankType === 'self') src = unqData.selfStoreRank || [];
  else if(unqStoreRankType === 'video') src = [];
  else src = unqData.allStoreRank || [];

  const rows = src.filter(s=>
    (s.store||'').toLowerCase().includes(search) ||
    (s.region||'').toLowerCase().includes(search)
  ).slice().sort((a,b)=> (b.avgScore ?? -Infinity) - (a.avgScore ?? -Infinity));
  $('unqStoreRankTable').innerHTML = `
    <thead><tr>
      <th>排名</th><th>门店</th><th>区域</th><th>不合格项数</th><th>慧运营巡检得分</th><th>操作</th>
    </tr></thead>
    <tbody>
      ${rows.map((s,idx)=>`
        <tr>
          <td>${idx+1}</td>
          <td>${html(s.store)}</td>
          <td>${html(s.region)}</td>
          <td>${s.unqReports != null ? s.unqReports : '-'}</td>
          <td class="${scoreClass(s.avgScore)}">${s.avgScore != null ? s.avgScore : '-'}</td>
          <td>${reportLink(s, '巡检报告', s.planType || (unqStoreRankType==='self'?'ZJ':'CG'))}</td>
        </tr>
      `).join('')}
      ${rows.length===0?'<tr><td colspan="6" class="empty">无数据</td></tr>':''}
    </tbody>
  `;
}

function renderUnqRegionRank(){
  // 倒序：区域平均分从高到低（高分排前），无分数的排最后
  const rows = (unqData.regionRank || []).slice().sort((a,b)=>{
    const av = a.avgScore != null ? a.avgScore : -Infinity;
    const bv = b.avgScore != null ? b.avgScore : -Infinity;
    return bv - av;
  });
  $('unqRegionRankTable').innerHTML = `
    <thead><tr>
      <th>排名</th><th>区域</th><th>有分门店数</th><th>总不合格项</th><th>门店分数区间</th><th>区域平均分</th><th>整改率</th><th>操作</th>
    </tr></thead>
    <tbody>
      ${rows.map((r,idx)=>`
        <tr>
          <td>${idx+1}</td>
          <td>${html(r.region)}</td>
          <td>${r.scoredStoreCount || 0}</td>
          <td>${r.unqCount || 0}</td>
          <td>${r.minScore != null && r.maxScore != null ? r.minScore + '-' + r.maxScore : '-'}</td>
          <td class="${scoreClass(r.avgScore)}">${r.avgScore != null ? r.avgScore : '-'}</td>
          <td>${fmtRate(r.rectifyRate || 0)}</td>
          <td><span class="link-btn" onclick="showRegionStoresByName('${encodeURIComponent(r.region||'')}')">查看门店</span></td>
        </tr>
      `).join('')}
      ${rows.length===0?'<tr><td colspan="8" class="empty">无数据</td></tr>':''}
    </tbody>
  `;
}

function showRegionStoresByName(regionEnc){
  const region = decodeURIComponent(regionEnc || '');
  // 从主看板数据里找该区域的门店
  const stores = (appData && appData.stores || []).filter(s=>(s.region||'') === region);
  const modal = $('regionModal');
  if(!modal) return;
  $('regionModalTitle').textContent = `${html(region)} · 门店清单`;
  $('regionModalSub').textContent = `共 ${stores.length} 家门店`;
  $('regionModalTable').innerHTML = `
    <thead><tr><th>门店</th><th>岗位</th><th>得分</th><th>报告</th></tr></thead>
    <tbody>
      ${stores.length ? stores.map(s=>`
        <tr>
          <td>${html(s.storeName)}</td>
          <td>${html(s.position)}</td>
          <td class="${scoreClass(s.score)}">${s.score>0?s.score:'-'}</td>
          <td>${reportLink(s, '巡检报告', 'CG')}</td>
        </tr>
      `).join('') : '<tr><td colspan="4" class="empty">该区域暂无门店数据</td></tr>'}
    </tbody>
  `;
  modal.classList.add('active');
}

function buildUnqStoreTopPositionChips(){
  const positions = ['__all__', ...new Set((unqData.byStore||[]).map(s=>s.position).filter(Boolean).sort())];
  const el = $('unqStoreTopPositionChips');
  if(!el) return;
  el.innerHTML = positions.map(p=>{
    const label = p==='__all__' ? '全部岗位' : p;
    return `<button class="chip ${unqStoreTopPosition===p?'active':''}" data-pos="${html(p)}">${html(label)}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{ unqStoreTopPosition = btn.dataset.pos; buildUnqStoreTopPositionChips(); renderUnqStoreTop(); };
  });
}

function renderUnqStoreTop(){
  buildUnqStoreTopPositionChips();
  const search = ($('unqStoreTopSearch').value||'').trim().toLowerCase();
  const data = unqData.storeTopItems || {};
  const posMap = {};
  (unqData.byStore||[]).forEach(s=>{ posMap[s.store] = s.position; });
  const stores = Object.keys(data).filter(s=>{
    if(!s.toLowerCase().includes(search)) return false;
    if(unqStoreTopPosition !== '__all__' && posMap[s] !== unqStoreTopPosition) return false;
    return true;
  });
  $('unqStoreTopTable').innerHTML = `
    <thead><tr><th>门店</th><th>岗位</th><th>高发问题</th></tr></thead>
    <tbody>
      ${stores.map(store=>`
        <tr>
          <td style="white-space:nowrap">${html(store)}</td>
          <td>${html(posMap[store] || '-')}</td>
          <td>
            ${(data[store]||[]).map((t,i)=>`<div style="margin:4px 0"><span style="color:#c0392b;font-weight:600">${i+1}.</span> ${html(t.title)} <span style="color:#888">(${html(t.category)}) × ${t.count}</span></div>`).join('') || '<span class="empty">无</span>'}
          </td>
        </tr>
      `).join('')}
      ${stores.length===0?'<tr><td colspan="3" class="empty">无数据</td></tr>':''}
    </tbody>
  `;
}

function buildUnqCategoryTopPositionChips(){
  const positions = ['__all__', ...new Set((unqData.byCategory||[]).flatMap(c=>c.positions||[]).filter(Boolean).sort())];
  const el = $('unqCategoryTopPositionChips');
  if(!el) return;
  el.innerHTML = positions.map(p=>{
    const label = p==='__all__' ? '全部岗位' : p;
    return `<button class="chip ${unqCategoryTopPosition===p?'active':''}" data-pos="${html(p)}">${html(label)}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{ unqCategoryTopPosition = btn.dataset.pos; buildUnqCategoryTopPositionChips(); renderUnqCategoryTop(); };
  });
}

function renderUnqCategoryTop(){
  buildUnqCategoryTopPositionChips();
  const search = ($('unqCategoryTopSearch').value||'').trim().toLowerCase();
  const rows = (unqData.byCategory||[])
    .filter(c=>{
      if(!(c.category||'').toLowerCase().includes(search)) return false;
      if(unqCategoryTopPosition !== '__all__' && !(c.positions||[]).includes(unqCategoryTopPosition)) return false;
      return true;
    })
    .sort((a,b)=> a.unqRate - b.unqRate);
  $('unqCategoryTopTable').innerHTML = `
    <thead><tr>
      <th>排名</th><th>分类</th><th>发现次数</th><th>占比</th><th>涉及门店</th><th>操作</th>
    </tr></thead>
    <tbody>
      ${rows.map((c,idx)=>`
        <tr>
          <td>${idx+1}</td>
          <td>${html(c.category)}</td>
          <td>${c.unqCount}</td>
          <td>${fmtRate(c.unqRate)}</td>
          <td>${c.storeUnqCount}</td>
          <td><span class="link-btn" onclick="showCategoryStoreDetail('${encodeURIComponent(c.category||'')}')">查看门店</span></td>
        </tr>
      `).join('')}
      ${rows.length===0?'<tr><td colspan="6" class="empty">无数据</td></tr>':''}
    </tbody>
  `;
}

function showCategoryStoreDetail(encCategory){
  const category = decodeURIComponent(encCategory || '');
  const list = (unqData.categoryStoreMap && unqData.categoryStoreMap[category]) || [];
  const modal = $('unqItemModal') || document.createElement('div');
  if(!modal.id){ modal.id='unqItemModal'; modal.className='modal'; document.body.appendChild(modal); }
  modal.style.display='flex';
  modal.onclick = e => { if(e.target===modal) modal.style.display='none'; };
  modal.innerHTML = `<div class="modal-box"><div class="modal-header"><h3>${html(category)} · 涉及门店</h3><button class="modal-close" onclick="$('unqItemModal').style.display='none'">&times;</button></div><div class="modal-body">加载中…</div></div>`;
  const filtered = unqCategoryTopPosition === '__all__' ? list : list.filter(s=>s.position === unqCategoryTopPosition);
  const storeRows = filtered.map(s=>`<tr><td>${html(s.store)}</td><td>${html(s.region||'')}</td><td>${html(s.position||'')}</td><td>${s.count}</td></tr>`).join('');
  modal.querySelector('.modal-body').innerHTML = `
    <p class="modal-sub">${filtered.length} 家门店涉及该问题</p>
    <table class="rank"><thead><tr><th>门店</th><th>区域</th><th>岗位</th><th>出现次数</th></tr></thead><tbody>${storeRows || '<tr><td colspan="4" class="empty">无明细</td></tr>'}</tbody></table>
  `;
}

function renderCategoryStoreList(category){
  const list = (unqData.categoryStoreMap && unqData.categoryStoreMap[category]) || [];
  if(!list.length) return '<span class="empty">无明细</span>';
  return `<table class="rank" style="margin:0;background:#fff"><thead><tr><th>门店</th><th>区域</th><th>出现次数</th></tr></thead><tbody>` +
    list.map(s=>`<tr><td>${html(s.store)}</td><td>${html(s.region)}</td><td>${s.count}</td></tr>`).join('') +
    `</tbody></table>`;
}

async function showUnqItemDetail(contentId, encTitle, encCategory, unqCount){
  const title = decodeURIComponent(encTitle||'');
  const category = decodeURIComponent(encCategory||'');
  const modal = $('unqItemModal') || document.createElement('div');
  if(!modal.id){ modal.id='unqItemModal'; modal.className='modal'; document.body.appendChild(modal); }
  modal.style.display='flex';
  modal.onclick = e => { if(e.target===modal) modal.style.display='none'; };
  modal.innerHTML = `<div class="modal-box"><div class="modal-header"><div><h3>${html(title)}</h3><div style="font-size:12px;color:#666;margin-top:4px">${html(category)} · 不合格 ${unqCount||0} 次</div></div><button class="modal-close" onclick="$('unqItemModal').style.display='none'">&times;</button></div><div class="modal-body">加载中…</div></div>`;
  try{
    throw new Error('静态版不提供单问题项照片下钻');
    const json = await fetch(url).then(r=>r.json());
    const d = json.data || {};
    const storeRows = (d.stores||[]).map(s=>`<tr><td>${html(s.store)}</td><td>${html(s.region||'')}</td><td>${s.count}</td></tr>`).join('');
    const photos = [];
    (d.photos||[]).forEach(p=>{
      (p.urls||[]).forEach(u=>{
        photos.push({url:u, time:p.uploadTime});
      });
    });
    const photoRows = photos.map(p=>`<img src="${html(p.url)}" style="width:100%;max-width:140px;height:120px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="window.open('${html(p.url)}','_blank')">`).join('');
    modal.querySelector('.modal-body').innerHTML = `
      <h4>涉及门店</h4>
      <table class="rank"><thead><tr><th>门店</th><th>区域</th><th>次数</th></tr></thead><tbody>${storeRows || '<tr><td colspan="3" class="empty">无</td></tr>'}</tbody></table>
      <h4 style="margin-top:16px">现场照片（${photos.length} 张）</h4>
      <div class="unq-photo-grid">${photoRows || '<span class="empty">暂无照片</span>'}</div>
    `;
  }catch(e){
    modal.querySelector('.modal-body').innerHTML = '<span style="color:#c0392b">加载失败：'+html(e.message)+'</span>';
  }
}

function renderOverview(d){
  const avgScore = d.stores.filter(s=>s.score>0).length > 0
    ? (d.stores.reduce((sum,s)=>sum+(s.score>0?s.score:0),0) / d.stores.filter(s=>s.score>0).length).toFixed(1)
    : '0.0';
  const totalNeed = d.stores.reduce((sum,s)=>sum+s.needRectify,0);
  const totalRectified = d.stores.reduce((sum,s)=>sum+s.rectified,0);
  const totalExpired = d.stores.reduce((sum,s)=>sum+s.expired,0);
  const self = d.selfInspection || {};
  const video = d.videoInspection || {};
  const selfRate = self.totalExpected ? (self.totalCompleted/self.totalExpected*100).toFixed(1) : '0.0';
  $('overviewCards').innerHTML = `
    <div class="card"><div class="card-h"><span class="scope-tag scope-cg">常规巡检（QSC）</span>覆盖门店总数</div><div class="card-v">${d.totalStores}</div><div class="card-sub">三个岗位组织树门店数之和</div></div>
    <div class="card"><div class="card-h"><span class="scope-tag scope-cg">常规巡检（QSC）</span>已检门店</div><div class="card-v">${d.totalInspected}</div><div class="card-sub">区间内产生巡检报告的门店</div></div>
    <div class="card"><div class="card-h"><span class="scope-tag scope-cg">常规巡检（QSC）</span>平均分</div><div class="card-v">${avgScore}</div><div class="card-sub">按慧运营 avgScore 聚合</div></div>
    <div class="card"><div class="card-h"><span class="scope-tag scope-cg">常规巡检（QSC）</span>需整改 / 已整改</div><div class="card-v">${totalNeed} / ${totalRectified}</div><div class="card-sub">逾期未整改 ${totalExpired}</div></div>
    <div class="card"><div class="card-h"><span class="scope-tag scope-zj">门店自检</span>已完成报告</div><div class="card-v">${self.totalCompleted || 0}</div><div class="card-sub">${self.realExpected ? '按任务排程应完成 ' + (self.totalExpected||0) : '按公式估算应完成 ' + (self.totalExpected||0)}，完成率约 ${selfRate}%</div></div>
  `;

  renderTopCategories(d);
}

function renderTopList(elId, items){
  const el = $(elId);
  if(!el) return;
  if(!items || items.length===0){
    el.innerHTML = '<li class="empty" style="border:none">暂无数据</li>';
    return;
  }
  const total = items.reduce((s,x)=>s+x.count,0) || 1;
  const max = Math.max(...items.map(x=>x.count)) || 1;
  el.innerHTML = items.map((x,idx)=>{
    const pct = (x.count/total*100).toFixed(1);
    const bar = (x.count/max*100).toFixed(1);
    return `<li>
      <div class="trow">
        <span class="tno">${idx+1}</span>
        <span class="tname" title="${html(x.category)}">${html(x.category)}</span>
        <span class="tpct">${pct}%</span>
      </div>
      <span class="tbar"><i style="width:${bar}%"></i></span>
    </li>`;
  }).join('');
}

function renderTopCategories(d){
  const ov = d.overview || {};
  renderTopList('selfTopList', (ov.selfTopCategories || []).slice(0, 3));
  renderTopList('videoTopList', (ov.videoTopCategories || []).slice(0, 3));
  renderTopList('regularTopList', (ov.regularTopCategories || []).slice(0, 10));
}

function renderPositions(d){
  if(!d) return;
  // 岗位大卡所有字段一律从 d.stores 实时聚合（不再信任 aggregate.js 输出的 d.positions 字段），
  // 顺序沿用 d.positions，保证"培训组→新店→加盟"三张卡的稳定展示。
  const pool = buildStorePool(d);
  const regPool = pool.regular;
  // 门店数统一取组织树基线（data.json 口径，已排除测试门店），
  // 保证 7/8/9 各月显示同一个"应覆盖门店数"，不会因某月 raw 组织树采集缺失而忽大忽小
  const baseline = window.__BASELINE_STORE_COUNT__ || {};
  const list = (d.positions || []).map(p => {
    const fb = regPool[p.position] || {};
    // 门店数：优先组织树基线（跨月份一致），回退 pool，再回退 aggregate 输出
    const storeCount = (baseline[p.position] != null)
      ? baseline[p.position]
      : (fb.storeCount != null ? fb.storeCount : (p.storeCount || 0));
    const inspectedCount = fb.inspectedCount != null ? fb.inspectedCount : (p.inspectedCount || 0);
    // 完成率 = 已巡检门店数 / 应覆盖门店数，口径与上面两个数字保持一致
    const submitRate = (storeCount > 0)
      ? Math.round(inspectedCount / storeCount * 1000) / 10
      : 0;
    return {
      position: p.position,
      storeCount,
      inspectedCount,
      submitRate,
      avgScore: fb.avgScore != null ? fb.avgScore : (p.avgScore || 0),
      unqualifiedItems: fb.unqualifiedItems != null ? fb.unqualifiedItems : (p.unqualifiedItems || 0),
      qualifiedRate: fb.qualifiedRate != null ? fb.qualifiedRate : (p.qualifiedRate || 0),
      regions: (fb.regions && fb.regions.length) ? fb.regions : (p.regions || []),
    };
  });
  $('overviewPositions').innerHTML = list.map(p=>`
    <div class="pos-card">
      <div class="pos-title">${html(p.position)}<span class="scope-tag scope-cg">常规巡检（QSC）</span></div>
      <div class="pos-subtitle">常规巡检（QSC）汇总 · 不含门店自检 / 视频巡检</div>
      <div class="pos-meta">
        <div><span class="pv">${p.storeCount}</span><span class="pl">门店数</span></div>
        <div><span class="pv">${p.inspectedCount}</span><span class="pl">已巡检</span></div>
        <div><span class="pv">${p.submitRate}%</span><span class="pl">完成率</span></div>
        <div><span class="pv">${p.avgScore || '0.0'}</span><span class="pl">平均分</span></div>
        <div><span class="pv">${p.unqualifiedItems}</span><span class="pl">不合格项</span></div>
        <div><span class="pv">${p.qualifiedRate}%</span><span class="pl">合格率</span></div>
        <div><span class="pv">${p.regions.length}</span><span class="pl">区域数</span></div>
      </div>
      <div class="reg-tags">${p.regions.map(r=>`<span class="reg-tag">${html(r)}</span>`).join('')}</div>
    </div>
  `).join('');
}

// === 岗位维度兜底聚合：直接从 d.stores / d.selfInspection.stores / d.videoInspection.stores
//     按 position 实时聚合门店数/已巡检/平均分/不合格项/合格率/区域，前端不再依赖 aggregate.js 输出的字段
function aggregateStoresByPosition(stores){
  const byPos = {};
  stores.forEach(s => {
    const pos = s.position || '未分类';
    if(!byPos[pos]){
      byPos[pos] = { position: pos, list: [], scoreSum: 0, unqItems: 0, sumCount: 0, regionSet: new Set() };
    }
    byPos[pos].list.push(s);
    byPos[pos].scoreSum += (s.score || 0);
    byPos[pos].unqItems += (s.unqualifiedItems || 0);
    byPos[pos].sumCount  += (s.sumCount  || 0);
    if(s.region) byPos[pos].regionSet.add(s.region);
  });
  const result = {};
  Object.keys(byPos).forEach(pos => {
    const b = byPos[pos];
    const total = b.list.length;
    const codeSet = new Set(b.list.map(s => s.storeCode || s.storeName));
    const avg = total ? b.scoreSum / total : 0;
    const qual = b.sumCount > 0 ? (1 - b.unqItems / b.sumCount) * 100 : 0;
    const submit = total > 0 ? Math.round(codeSet.size / total * 1000) / 10 : 0;
    result[pos] = {
      position: pos,
      storeCount: codeSet.size,    // 独立门店数（去重 storeCode）
      inspectedCount: total,        // 巡检报告数
      submitRate: submit,
      avgScore: Math.round(avg * 100) / 100,
      unqualifiedItems: b.unqItems,
      qualifiedRate: Math.round(qual * 10) / 10,
      regions: Array.from(b.regionSet),
    };
  });
  return result;
}

// self 巡检的 stores 字段映射稍有不同（completed / unqStoreCount 之类），这里做归一化
function normalizeSelfVideoStore(s){
  return {
    position: s.position,
    storeCode: s.storeCode || s.storeName,
    region: s.region,
    score: s.score,
    sumCount: s.sumCount || s.totalItems || 0,
    unqualifiedItems: s.unqualifiedItems || 0,
  };
}

function buildStorePool(d){
  const pool = { regular: {}, self: {}, video: {} };
  if(!d) return pool;
  pool.regular = aggregateStoresByPosition(d.stores || []);
  const selfStores = ((d.selfInspection||{}).stores || []).map(normalizeSelfVideoStore);
  pool.self = aggregateStoresByPosition(selfStores);
  const videoStores = ((d.videoInspection||{}).stores || []).map(normalizeSelfVideoStore);
  pool.video = aggregateStoresByPosition(videoStores);
  return pool;
}

function buildPosFilter(containerId, onChange){
  const d = appData;
  const positions = ['__all__'].concat(d.positions.map(p=>p.position));
  const labels = {'__all__':'全部岗位'};
  d.positions.forEach(p=>labels[p.position]=p.position);
  const el = $(containerId);
  if(!el) return;
  el.innerHTML = positions.map(pos=>`
    <button class="fbtn ${pos===activePosFilter?'active':''}" data-pos="${html(pos)}">${html(labels[pos])}</button>
  `).join('');
  el.querySelectorAll('.fbtn').forEach(btn=>{
    btn.onclick = ()=>{
      activePosFilter = btn.dataset.pos;
      document.querySelectorAll('.pos-filter .fbtn').forEach(b=>{
        b.classList.toggle('active', b.dataset.pos===activePosFilter);
      });
      onChange();
    };
  });
}

function filterByPos(items){
  if(activePosFilter==='__all__') return items;
  return items.filter(x=>x.position===activePosFilter);
}

function renderSelfInspection(d){
  const self = d.selfInspection || {};

  // 1. 区域汇总
  buildPosFilter('selfRegionPosFilter', ()=>renderSelfInspection(d));
  const regionItems = filterByPos(self.regions || []);
  const rsearch = ($('selfRegionSearch').value||'').trim().toLowerCase();
  const rfiltered = regionItems.filter(r=>
    (r.region||'').toLowerCase().includes(rsearch) ||
    (r.position||'').toLowerCase().includes(rsearch)
  );
  $('selfRegionTable').innerHTML = `
    <thead><tr>
      <th>区域</th><th>岗位</th><th>门店数</th><th>参与自检</th><th>完成率</th><th>已完成</th><th>应完成</th><th>未完成</th><th>完成率</th>
      <th>平均分</th><th>点评率</th>
      <th>开店</th><th>打烊</th><th>合格</th><th>不合格</th><th>合格率</th><th>整改率</th><th>逾期</th><th>门店清单</th>
    </tr></thead>
    <tbody>
      ${rfiltered.map(r=>{
        const qTotal = (r.qualified||0) + (r.unqualified||0);
        const qRate = qTotal > 0 ? Math.round((r.qualified||0) / qTotal * 1000) / 10 : 0;
        const rectTotal = r.rectifyTotal || 0;
        const rectRate = r.rectifyRate != null
          ? r.rectifyRate
          : (rectTotal > 0 ? Math.round((r.rectified||0) / rectTotal * 1000) / 10 : null);
        return `
        <tr>
          <td>${html(r.region||'-')}</td>
          <td>${html(r.position||'-')}</td>
          <td>${r.storeCount || 0}</td>
          <td>${r.enrolledCount === undefined ? '-' : r.enrolledCount}</td>
          <td class="${rateClass(r.submitRate)}">${r.submitRate != null ? r.submitRate : 0}%</td>
          <td>${r.completed != null ? r.completed : 0}</td>
          <td>${r.expected != null ? r.expected : '-'}</td>
          <td>${r.unfinished === undefined ? '-' : r.unfinished}</td>
          <td class="${rateClass(r.completionRate)}">${r.completionRate != null ? r.completionRate : 0}%</td>
          <td class="${scoreClass(r.avgScore)}">${r.avgScore ? r.avgScore : '-'}</td>
          <td class="${rateClass(r.reviewRate)}">${r.reviewRate != null ? r.reviewRate : 0}%</td>
          <td>${r.kaidian || 0}</td>
          <td>${r.dayan || 0}</td>
          <td>${r.qualified || 0}</td>
          <td>${r.unqualified || 0}</td>
          <td class="${rateClass(qRate)}">${qTotal > 0 ? qRate + '%' : '-'}</td>
          <td class="rate-mid">${rectRate != null ? rectRate + '%' : (rectTotal > 0 ? Math.round((r.rectified||0)/rectTotal*1000)/10 + '%' : '—')}</td>
          <td>${r.expired || 0}</td>
          <td><span class="link-btn" onclick="showSelfRegionStores('${encodeURIComponent(r.region||'')}', '${encodeURIComponent(r.position||'')}')">查看门店 &gt;</span></td>
        </tr>`;
      }).join('')}
      ${rfiltered.length===0?'<tr><td colspan="19" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 2. 岗位组织（三张岗位大卡）
  renderPositionCards('self', d);

  // 3. 区域分数排名及明细（异步加载 rankings_self_*.json）
  renderRegionRanking('self');

  // 4. 门店分数排名及明细
  buildPosFilter('selfStoreRankPosFilter', ()=>renderSelfInspection(d));
  const rankSearch = ($('selfStoreRankSearch').value||'').trim().toLowerCase();
  const rankItems = filterByPos(self.rankStores || [])
    .filter(s=>s.avgScore>0)
    .filter(s=>(s.storeName||'').toLowerCase().includes(rankSearch))
    .sort((a,b)=> b.avgScore - a.avgScore);
  $('selfStoreRankTable').innerHTML = `
    <thead><tr><th>排名</th><th>门店</th><th>岗位</th><th>区域</th><th>每日自检平均分</th><th>已点评次数</th><th>自检报告</th></tr></thead>
    <tbody>
      ${rankItems.map((s,idx)=>{
        const rank = idx+1;
        let cls = 'top-num';
        if(rank===1) cls += ' gold';
        else if(rank===2) cls += ' silver';
        else if(rank===3) cls += ' bronze';
        return `
          <tr>
            <td><span class="${cls}">${rank}</span></td>
            <td>${html(s.storeName)}</td>
            <td>${html(s.position)}</td>
            <td>${html(s.region)}</td>
            <td class="${scoreClass(s.avgScore)}">${s.avgScore}</td>
            <td>${s.scoreCount}</td>
            <td>${reportLink(s, '查看报告', 'ZJ')}</td>
          </tr>
        `;
      }).join('')}
      ${rankItems.length===0?'<tr><td colspan="7" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 5. 高发问题汇总 —— 由 switchSubTab 触发（unqData 异步加载）
}

function renderRegularInspection(d){
  // 1. 区域汇总
  buildPosFilter('regionPosFilter', ()=>renderRegularInspection(d));
  const items = filterByPos(d.regions);
  const search = ($('regionSearch').value||'').trim().toLowerCase();
  const filtered = items.filter(r=>
    (r.region||'').toLowerCase().includes(search) ||
    (r.position||'').toLowerCase().includes(search)
  );
  $('regionTable').innerHTML = `
    <thead><tr>
      <th>区域</th><th>岗位</th><th>门店数</th><th>已巡检</th><th>完成率</th><th>平均分</th>
      <th>巡检项</th><th>合格项</th><th>不合格项</th><th>合格率</th>
      <th>未整改</th><th>已整改</th><th>整改率</th><th>逾期</th><th>门店清单</th>
    </tr></thead>
    <tbody>
      ${filtered.map(r=>{
        const rectTotal = (r.needRectify||0) + (r.rectified||0);
        const rectRate = rectTotal > 0 ? Math.round((r.rectified||0) / rectTotal * 1000) / 10 : 0;
        return `
        <tr>
          <td>${html(r.region)}</td>
          <td>${html(r.position)}</td>
          <td>${r.storeCount}</td>
          <td>${r.inspectedCount}</td>
          <td class="${rateClass(r.submitRate)}">${r.submitRate != null ? r.submitRate : 0}%</td>
          <td class="${scoreClass(r.avgScore)}">${r.avgScore || '-'}</td>
          <td>${r.totalItems || 0}</td>
          <td>${r.normalItems || 0}</td>
          <td>${r.unqualifiedItems || 0}</td>
          <td class="${rateClass(r.qualifiedRate)}">${r.qualifiedRate != null ? r.qualifiedRate : 0}%</td>
          <td>${r.needRectify}</td>
          <td>${r.rectified}</td>
          <td class="${rateClass(rectRate)}">${rectTotal > 0 ? rectRate + '%' : '-'}</td>
          <td>${r.expired}</td>
          <td><span class="link-btn" onclick="showRegionStores('${encodeURIComponent(r.region||'')}', '${encodeURIComponent(r.position||'')}')">查看门店 &gt;</span></td>
        </tr>`;
      }).join('')}
      ${filtered.length===0?'<tr><td colspan="15" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 2. 岗位组织（三张岗位大卡：直营组·培训组 / 新店运营组 / 加盟营运组）
  renderPositionCards('regular', d);

  // 3. 区域分数排名及明细（异步加载 rankings_regular_*.json）
  renderRegionRanking('regular');

  // 4. 门店分数排名及明细
  buildPosFilter('regularStoreRankPosFilter', ()=>renderRegularInspection(d));
  const rankSearch = ($('regularStoreRankSearch').value||'').trim().toLowerCase();
  const rankItems = filterByPos(d.stores)
    .filter(s=>s.score>0)
    .filter(s=>(s.storeName||'').toLowerCase().includes(rankSearch))
    .sort((a,b)=> b.score - a.score);
  $('regularStoreRankTable').innerHTML = `
    <thead><tr><th>排名</th><th>门店</th><th>岗位</th><th>区域</th><th>常规巡检（QSC）得分</th><th>报告数</th><th>巡检报告</th></tr></thead>
    <tbody>
      ${rankItems.map((s,idx)=>{
        const rank = idx+1;
        let cls = 'top-num';
        if(rank===1) cls += ' gold';
        else if(rank===2) cls += ' silver';
        else if(rank===3) cls += ' bronze';
        return `
          <tr>
            <td><span class="${cls}">${rank}</span></td>
            <td>${html(s.storeName)}</td>
            <td>${html(s.position)}</td>
            <td>${html(s.region)}</td>
            <td class="${scoreClass(s.score)}">${s.score}</td>
            <td>${s.reportCount || 0}</td>
            <td>${reportLink(s, '查看报告', 'CG')}</td>
          </tr>
        `;
      }).join('')}
      ${rankItems.length===0?'<tr><td colspan="7" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 5. 高发问题汇总 —— 由 switchSubTab 触发（unqData 异步加载后写 regularProblemsCards）
}

function renderVideoInspection(d){
  const video = d.videoInspection || {};

  // 1. 区域汇总
  const rsearch = ($('videoRegionSearch').value||'').trim().toLowerCase();
  const rfiltered = (video.regions || []).filter(r=>
    (r.region||'').toLowerCase().includes(rsearch) ||
    (r.position||'').toLowerCase().includes(rsearch)
  );
  $('videoRegionTable').innerHTML = `
    <thead><tr>
      <th>区域</th><th>岗位</th><th>门店数</th><th>已巡检</th><th>完成率</th><th>平均分</th>
      <th>巡检项</th><th>合格项</th><th>不合格项</th><th>合格率</th>
      <th>需整改</th><th>已整改</th><th>整改率</th><th>逾期</th><th>门店清单</th>
    </tr></thead>
    <tbody>
      ${rfiltered.map(r=>{
        const rectTotal = (r.needRectify||0) + (r.rectified||0);
        const rectRate = rectTotal > 0 ? Math.round((r.rectified||0) / rectTotal * 1000) / 10 : 0;
        return `
        <tr>
          <td>${html(r.region)}</td>
          <td>${html(r.position)}</td>
          <td>${r.storeCount}</td>
          <td>${r.inspectedCount}</td>
          <td class="${rateClass(r.submitRate)}">${r.submitRate != null ? r.submitRate : 0}%</td>
          <td class="${scoreClass(r.avgScore)}">${r.avgScore || '-'}</td>
          <td>${r.totalItems || 0}</td>
          <td>${r.normalItems || 0}</td>
          <td>${r.unqualifiedItems || 0}</td>
          <td class="${rateClass(r.qualifiedRate)}">${r.qualifiedRate != null ? r.qualifiedRate : 0}%</td>
          <td>${r.needRectify}</td>
          <td>${r.rectified}</td>
          <td class="${rateClass(rectRate)}">${rectTotal > 0 ? rectRate + '%' : '-'}</td>
          <td>${r.expired}</td>
          <td><span class="link-btn" onclick="showRegionStores('${encodeURIComponent(r.region||'')}', '${encodeURIComponent(r.position||'')}')">查看门店 &gt;</span></td>
        </tr>`;
      }).join('')}
      ${rfiltered.length===0?'<tr><td colspan="15" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 2. 岗位组织（三张岗位大卡：直营组·培训组 / 新店运营组 / 加盟营运组）
  renderPositionCards('video', d);

  // 3. 区域分数排名及明细（异步加载 rankings_video_*.json）
  renderRegionRanking('video');

  // 4. 门店分数排名及明细
  const vsearch = ($('videoStoreRankSearch').value||'').trim().toLowerCase();
  const vstores = video.stores || video.rankStores || [];
  const vrankItems = vstores
    .filter(s=>(s.score||0)>0)
    .filter(s=>(s.storeName||'').toLowerCase().includes(vsearch))
    .sort((a,b)=> (b.score||0) - (a.score||0));
  $('videoStoreRankTable').innerHTML = `
    <thead><tr><th>排名</th><th>门店</th><th>区域</th><th>岗位</th><th>视频巡检得分</th><th>巡检报告</th></tr></thead>
    <tbody>
      ${vrankItems.map((s,idx)=>{
        const rank = idx+1;
        let cls = 'top-num';
        if(rank===1) cls += ' gold';
        else if(rank===2) cls += ' silver';
        else if(rank===3) cls += ' bronze';
        return `
          <tr>
            <td><span class="${cls}">${rank}</span></td>
            <td>${html(s.storeName)}</td>
            <td>${html(s.region)}</td>
            <td>${html(s.position)}</td>
            <td class="${scoreClass(s.score)}">${s.score}</td>
            <td>${reportLink(s, '查看报告', 'SP')}</td>
          </tr>
        `;
      }).join('')}
      ${vrankItems.length===0?'<tr><td colspan="6" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 5. 高发问题汇总 —— 由 switchSubTab 触发（unqData 异步加载后写 videoProblemsCards）
}

// 视频巡检数据看板（区域得分 + 整改情况）
function renderVideoOverviewChart(video){
  const el = $('videoOverviewChart');
  if(!el || typeof echarts === 'undefined') return;
  const regs = (video && video.regions) || [];
  const rows = regs
    .filter(r => r.avgScore > 0 || (r.needRectify||0) + (r.rectified||0) > 0)
    .slice(0, 12);
  if(rows.length === 0){
    el.innerHTML = '<div class="empty" style="padding:60px 0">该区间暂无视频巡检数据</div>';
    return;
  }
  const labels = rows.map(r => r.region || '-');
  const scores = rows.map(r => Number(r.avgScore) || 0);
  const need = rows.map(r => Number(r.needRectify) || 0);
  const fixed = rows.map(r => Number(r.rectified) || 0);
  if(!el._chart) el._chart = echarts.init(el);
  el._chart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['平均分', '需整改', '已整改'], top: 4 },
    grid: { left: 50, right: 30, top: 40, bottom: 60 },
    xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, rotate: 25, fontSize: 11 } },
    yAxis: [
      { type: 'value', name: '平均分', min: 0, max: 100, position: 'left' },
      { type: 'value', name: '项数', position: 'right' },
    ],
    series: [
      { name: '平均分', type: 'bar', data: scores, itemStyle: { color: '#2f6fed' }, barMaxWidth: 24, label: { show: true, position: 'top', fontSize: 11, formatter: p => p.value || '' } },
      { name: '需整改', type: 'bar', yAxisIndex: 1, data: need, itemStyle: { color: '#e0603a' }, barMaxWidth: 18 },
      { name: '已整改', type: 'bar', yAxisIndex: 1, data: fixed, itemStyle: { color: '#1a7f37' }, barMaxWidth: 18 },
    ],
  }, true);
}

function renderVideoProblems(video){
  const rows = video.categoryDetails || [];
  const kw = ($('videoProblemSearch').value||'').trim().toLowerCase();

  const chips = $('videoProblemPosChips');
  if(chips){
    const poss = ['__all__'].concat([...new Set(rows.map(r=>r.position))].filter(Boolean));
    if(videoProblemPos === '' || !poss.includes(videoProblemPos)) videoProblemPos = '__all__';
    chips.innerHTML = poss.map(p=>{
      const label = p==='__all__' ? '全部岗位' : p;
      return `<button class="chip ${p===videoProblemPos?'active':''}" data-pos="${html(p)}">${html(label)}</button>`;
    }).join('');
    chips.querySelectorAll('.chip').forEach(btn=>{
      btn.onclick = ()=>{
        videoProblemPos = btn.dataset.pos;
        renderVideoProblems(video);
      };
    });
  }

  let list = rows.filter(r=>videoProblemPos==='__all__' || r.position===videoProblemPos);
  if(kw){
    list = list.filter(r=>
      (r.title||'').toLowerCase().includes(kw) || (r.category||'').toLowerCase().includes(kw));
  }
  list = list.slice().sort((a,b)=>(b.unqualified||0)-(a.unqualified||0));

  // 同岗位内合并同名巡检项（三个岗位可能共用同一套模板）
  const merged = {};
  list.forEach(r=>{
    const k = `${r.category||''}|${r.title||''}`;
    if(!merged[k]){
      merged[k] = {
        category: r.category || '视频巡检',
        title: r.title || '',
        unqualified: 0, inspected: 0, storeCount: 0, unqStoreCount: 0,
      };
    }
    const m = merged[k];
    m.unqualified += r.unqualified || 0;
    m.inspected += r.inspected || 0;
    m.storeCount = Math.max(m.storeCount, r.storeCount || 0);
    m.unqStoreCount = Math.max(m.unqStoreCount, r.unqStoreCount || 0);
  });
  const items = Object.values(merged).sort((a,b)=>b.unqualified-a.unqualified);
  const maxCount = items.length ? Math.max(...items.map(x=>x.unqualified)) : 1;

  $('videoProblemTable').innerHTML = `
    <thead><tr>
      <th>排名</th><th>问题分类</th><th>巡检项</th><th>不合格次数</th>
      <th>不合格率</th><th>涉及门店</th><th>不合格门店</th>
    </tr></thead>
    <tbody>
      ${items.map((x,idx)=>{
        const rate = x.inspected > 0 ? (x.unqualified / x.inspected * 100).toFixed(1) : '0.0';
        const bar = maxCount ? (x.unqualified / maxCount * 100).toFixed(1) : 0;
        return `
        <tr>
          <td>${idx+1}</td>
          <td>${html(x.category)}</td>
          <td title="${html(x.title)}">${html(x.title)}</td>
          <td>${x.unqualified}</td>
          <td><span class="bar-bg"><span class="barfill" style="width:${bar}%"></span></span>${rate}%</td>
          <td>${x.storeCount || '-'}</td>
          <td>${x.unqStoreCount || '-'}</td>
        </tr>`;
      }).join('')}
      ${items.length===0?'<tr><td colspan="7" class="empty">暂无视频巡检问题数据</td></tr>':''}
    </tbody>
  `;
}

// ---------- 自检趋势图 ----------
let selfTrendChart = null;
const TREND_PERIOD_LABELS = {'7':'近7天','30':'近30天','month':'本月','range':'当前区间'};

function fmtDate(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function buildSelfTrendPeriodChips(){
  const el = $('selfTrendPeriodChips');
  if(!el) return;
  const periods = ['7','30','month','range'];
  el.innerHTML = periods.map(p=>{
    const cls = p===selfTrendPeriod?'active':'';
    return `<button class="chip ${cls}" data-period="${p}">${TREND_PERIOD_LABELS[p]}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{
      selfTrendPeriod = btn.dataset.period;
      el.querySelectorAll('.chip').forEach(b=>b.classList.toggle('active', b.dataset.period===selfTrendPeriod));
      loadSelfTrends();
    };
  });
}

function buildSelfTrendGroupChips(){
  const el = $('selfTrendGroupChips');
  if(!el) return;
  const groups = [
    {k:'region', l:'按区域'},
    {k:'position', l:'按岗位'}
  ];
  el.innerHTML = groups.map(g=>{
    const cls = g.k===selfTrendGroupBy?'active':'';
    return `<button class="chip ${cls}" data-group="${g.k}">${g.l}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{
      selfTrendGroupBy = btn.dataset.group;
      el.querySelectorAll('.chip').forEach(b=>b.classList.toggle('active', b.dataset.group===selfTrendGroupBy));
      loadSelfTrends();
    };
  });
}

async function loadSelfTrends(){
  buildSelfTrendPeriodChips();
  buildSelfTrendGroupChips();
  if(selfTrendChart){
    selfTrendChart.showLoading({text:'加载中…'});
  }
  const meta = $('selfTrendMeta');
  if(meta) meta.textContent = TREND_PERIOD_LABELS[selfTrendPeriod] + ' · 加载中';

  try{
    const url = `${DATA_BASE}/trends_${encodeURIComponent(selfTrendPeriod)}_${encodeURIComponent(selfTrendGroupBy)}.json`;
    const resp = await fetch(cb(url), {cache:'no-store'});
    const json = await resp.json();
    if(!json.success) throw new Error(json.error || '加载失败');
    renderSelfTrends(json.data);
    if(meta){
      meta.textContent = `${TREND_PERIOD_LABELS[selfTrendPeriod]} · 共 ${json.data.dates.length} 天`;
    }
  }catch(e){
    if(meta) meta.textContent = TREND_PERIOD_LABELS[selfTrendPeriod] + ' · 加载失败：' + e.message;
    $('selfTrendKpi').innerHTML = `<div class="empty">${html(e.message)}</div>`;
  }finally{
    if(selfTrendChart) selfTrendChart.hideLoading();
  }
}

function renderSelfTrends(data){
  const kpi = data.kpi || {};
  const series = data.series || [];
  $('selfTrendKpi').innerHTML = `
    <div class="card"><div class="card-h">总完成报告数</div><div class="card-v">${kpi.totalCompleted || 0}</div></div>
    <div class="card"><div class="card-h">总合格报告数</div><div class="card-v">${kpi.totalQualified || 0}</div></div>
    <div class="card"><div class="card-h">日均完成</div><div class="card-v">${kpi.avgDailyCompleted || 0}</div></div>
    <div class="card"><div class="card-h">平均合格率</div><div class="card-v ${rateClass(parseFloat(kpi.qualifiedRate || 0))}">${kpi.qualifiedRate || '0.0'}%</div></div>
  `;

  if(!selfTrendChart){
    selfTrendChart = echarts.init($('selfTrendChart'));
  }
  const colors = ['#2f6fed','#1a7f37','#e0603a','#8e44ad'];
  const option = {
    tooltip: {trigger:'axis'},
    legend: {
      type: series.length>8?'scroll':'plain',
      data: series.map(s=>s.name),
      bottom:0,
      textStyle:{fontSize:11}
    },
    grid: {left:50, right:20, top:30, bottom: series.length>8?55:40},
    xAxis: {type:'category', boundaryGap:false, data: data.dates},
    yAxis: {type:'value', minInterval:1},
    series: series.map((s,i)=>({
      name: s.name,
      type: 'line',
      smooth: true,
      // 不加面积填充：三条线叠一起时大面积色块会互相遮挡，看不清各岗位走势
      symbol:'circle',
      symbolSize:5,
      data: s.data,
      itemStyle:{color: colors[i % colors.length]},
      lineStyle:{width:2}
    }))
  };
  selfTrendChart.setOption(option, true);
}

// ---------- 视频巡检趋势图 ----------
let videoTrendChart = null;

function buildVideoTrendPeriodChips(){
  const el = $('videoTrendPeriodChips');
  if(!el) return;
  const periods = ['7','30','month','range'];
  el.innerHTML = periods.map(p=>{
    const cls = p===videoTrendPeriod?'active':'';
    return `<button class="chip ${cls}" data-period="${p}">${TREND_PERIOD_LABELS[p]}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{
      videoTrendPeriod = btn.dataset.period;
      el.querySelectorAll('.chip').forEach(b=>b.classList.toggle('active', b.dataset.period===videoTrendPeriod));
      loadVideoTrends();
    };
  });
}

function buildVideoTrendGroupChips(){
  const el = $('videoTrendGroupChips');
  if(!el) return;
  const groups = [
    {k:'region', l:'按区域'},
    {k:'position', l:'按岗位'}
  ];
  el.innerHTML = groups.map(g=>{
    const cls = g.k===videoTrendGroupBy?'active':'';
    return `<button class="chip ${cls}" data-group="${g.k}">${g.l}</button>`;
  }).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{
      videoTrendGroupBy = btn.dataset.group;
      el.querySelectorAll('.chip').forEach(b=>b.classList.toggle('active', b.dataset.group===videoTrendGroupBy));
      loadVideoTrends();
    };
  });
}

async function loadVideoTrends(){
  buildVideoTrendPeriodChips();
  buildVideoTrendGroupChips();
  if(videoTrendChart){
    videoTrendChart.showLoading({text:'加载中…'});
  }
  const meta = $('videoTrendMeta');
  if(meta) meta.textContent = TREND_PERIOD_LABELS[videoTrendPeriod] + ' · 加载中';

  try{
    const url = `${DATA_BASE}/trends_video_${encodeURIComponent(videoTrendPeriod)}_${encodeURIComponent(videoTrendGroupBy)}.json`;
    const resp = await fetch(cb(url), {cache:'no-store'});
    const json = await resp.json();
    if(!json.success) throw new Error(json.error || '加载失败');
    renderVideoTrends(json.data);
    if(meta){
      meta.textContent = `${TREND_PERIOD_LABELS[videoTrendPeriod]} · 共 ${json.data.dates.length} 天`;
    }
  }catch(e){
    if(meta) meta.textContent = TREND_PERIOD_LABELS[videoTrendPeriod] + ' · 加载失败：' + e.message;
    $('videoTrendKpi').innerHTML = `<div class="empty">${html(e.message)}</div>`;
  }finally{
    if(videoTrendChart) videoTrendChart.hideLoading();
  }
}

function renderVideoTrends(data){
  const kpi = data.kpi || {};
  const series = data.series || [];
  $('videoTrendKpi').innerHTML = `
    <div class="card"><div class="card-h">总完成报告数</div><div class="card-v">${kpi.totalCompleted || 0}</div></div>
    <div class="card"><div class="card-h">总合格报告数</div><div class="card-v">${kpi.totalQualified || 0}</div></div>
    <div class="card"><div class="card-h">日均完成</div><div class="card-v">${kpi.avgDailyCompleted || 0}</div></div>
    <div class="card"><div class="card-h">平均合格率</div><div class="card-v ${rateClass(parseFloat(kpi.qualifiedRate || 0))}">${kpi.qualifiedRate || '0.0'}%</div></div>
  `;

  if(!videoTrendChart){
    videoTrendChart = echarts.init($('videoTrendChart'));
  }
  const colors = ['#2f6fed','#1a7f37','#e0603a','#8e44ad'];
  const option = {
    tooltip: {trigger:'axis'},
    legend: {
      type: series.length>8?'scroll':'plain',
      data: series.map(s=>s.name),
      bottom:0,
      textStyle:{fontSize:11}
    },
    grid: {left:50, right:20, top:30, bottom: series.length>8?55:40},
    xAxis: {type:'category', boundaryGap:false, data: data.dates},
    yAxis: {type:'value', minInterval:1},
    series: series.map((s,i)=>({
      name: s.name,
      type: 'line',
      smooth: true,
      symbol:'circle',
      symbolSize:5,
      data: s.data,
      itemStyle:{color: colors[i % colors.length]},
      lineStyle:{width:2}
    }))
  };
  videoTrendChart.setOption(option, true);
}

// ---------- 区域排名（每周 / 每月） ----------
function buildPeriodChips(containerId, typeName){
  const el = $(containerId);
  if(!el) return;
  const periods = ['thisWeek','lastWeek','thisMonth','lastMonth'];
  el.innerHTML = periods.map(p=>
    `<button class="chip ${p===regionRankPeriod[typeName]?'active':''}" data-period="${p}">${PERIOD_LABELS[p]}</button>`
  ).join('');
  el.querySelectorAll('.chip').forEach(btn=>{
    btn.onclick = ()=>{
      regionRankPeriod[typeName] = btn.dataset.period;
      el.querySelectorAll('.chip').forEach(b=>b.classList.toggle('active', b.dataset.period===regionRankPeriod[typeName]));
      renderRegionRanking(typeName);
    };
  });
}

function renderRankTable(tableId, metaId, rows, period, loading, typeName='regular'){
  const table = $(tableId);
  const meta = $(metaId);
  if(!table) return;
  if(loading){
    table.innerHTML = '<tbody><tr><td class="empty">正在从慧运营拉取该区间数据…</td></tr></tbody>';
    if(meta) meta.textContent = PERIOD_LABELS[period] + ' · 加载中';
    return;
  }
  const sorted = (rows||[]).slice().sort((a,b)=> b.avgScore - a.avgScore);
  const isAll = typeName === 'all';
  const header = isAll
    ? '<th>排名</th><th>区域</th><th>岗位</th><th>门店数</th><th>已巡检</th><th>不合格项</th><th>完成率</th><th>合格率</th><th>点评率</th><th>整改率</th><th>区域平均分</th><th>门店分数区间</th>'
    : '<th>排名</th><th>区域</th><th>岗位</th><th>门店数</th><th>已巡检</th><th>平均分</th><th>合格率</th><th>整改率</th><th>点评率</th>';
  const colspan = isAll ? 12 : 9;
  const regionLink = (r) => `<span class="link-btn" onclick="showRankRegionStores('${encodeURIComponent(r.region||'').replace(/'/g,'%27')}','${encodeURIComponent(r.position||'').replace(/'/g,'%27')}','${typeName}')">${html(r.region)}</span>`;
  table.innerHTML = `
    <thead><tr>${header}</tr></thead>
    <tbody>
      ${sorted.map((r,idx)=>{
        const rank = idx+1;
        let cls = 'top-num';
        if(rank===1) cls += ' gold';
        else if(rank===2) cls += ' silver';
        else if(rank===3) cls += ' bronze';
        const scoreDisplay = r.hasData ? `<span class="${scoreClass(r.avgScore)}">${r.avgScore}</span>` : '<span style="color:#999">-</span>';
        const rowStyle = r.hasData ? '' : 'style="background:#fafafa"';
        const submitRateDisplay = r.hasData && r.submitRate != null ? `<span class="${rateClass(r.submitRate)}">${r.submitRate}%</span>` : '<span style="color:#999">-</span>';
        const commentRateDisplay = r.hasData && r.commentRate != null ? `<span class="${rateClass(r.commentRate)}">${r.commentRate}%</span>` : '<span style="color:#999">-</span>';
        const rectifyRateDisplay = '<span style="color:#999">—</span>';
        if(!isAll){
          return `
            <tr ${rowStyle}>
              <td><span class="${cls}">${rank}</span></td>
              <td>${regionLink(r)}</td>
              <td>${html(r.position)}</td>
              <td>${r.storeCount}</td>
              <td>${r.inspectedCount}</td>
              <td>${scoreDisplay}</td>
              <td>${submitRateDisplay}</td>
              <td>${rectifyRateDisplay}</td>
              <td>${commentRateDisplay}</td>
            </tr>
          `;
        }
        const unqDisplay = r.unqualifiedItems != null ? r.unqualifiedItems : '<span style="color:#999">-</span>';
        const completionDisplay = r.hasData && r.completionRate != null ? `<span class="${rateClass(r.completionRate)}">${r.completionRate}%</span>` : '<span style="color:#999">-</span>';
        const qualifiedDisplay = r.hasData && r.qualifiedRate != null ? `<span class="${rateClass(r.qualifiedRate)}">${r.qualifiedRate}%</span>` : '<span style="color:#999">-</span>';
        const rangeDisplay = (r.scoreMin != null && r.scoreMax != null) ? `${r.scoreMin} ~ ${r.scoreMax}` : '<span style="color:#999">-</span>';
        return `
          <tr ${rowStyle}>
            <td><span class="${cls}">${rank}</span></td>
            <td>${regionLink(r)}</td>
            <td>${html(r.position)}</td>
            <td>${r.storeCount}</td>
            <td>${r.inspectedCount}</td>
            <td>${unqDisplay}</td>
            <td>${completionDisplay}</td>
            <td>${qualifiedDisplay}</td>
            <td>${commentRateDisplay}</td>
            <td>${rectifyRateDisplay}</td>
            <td>${scoreDisplay}</td>
            <td>${rangeDisplay}</td>
          </tr>
        `;
      }).join('')}
      ${sorted.length===0?`<tr><td colspan="${colspan}" class="empty">该区间暂无数据</td></tr>`:''}
    </tbody>
  `;
  if(meta){
    const scored = sorted.filter(x=>x.hasData).length;
    meta.textContent = `${PERIOD_LABELS[period]} · 共 ${sorted.length} 个区域 · 有得分的 ${scored} 个`;
  }
  // 渲染柱状图数据看板
  renderRankChart(typeName, sorted);
}

// 数据看板 - 区域排名柱状图
function renderRankChart(typeName, sorted){
  const chartIds = {
    all:     'regionRankAllChart',
    regular: 'regionRankRegularChart',
    self:    'regionRankSelfChart',
    video:   'regionRankVideoChart',
  };
  const chartId = chartIds[typeName];
  if(!chartId) return;
  const el = $(chartId);
  if(!el || typeof echarts === 'undefined') return;
  // 限制最多展示 12 个区域，否则柱子太挤
  const rows = (sorted || []).filter(x=>x.hasData && x.avgScore > 0).slice(0, 12);
  if(rows.length === 0){
    el.innerHTML = '<div class="empty" style="padding:60px 0">该区间暂无评分数据</div>';
    return;
  }
  const labels = rows.map(r => r.region || '-');
  const scores = rows.map(r => Number(r.avgScore) || 0);
  const submissions = rows.map(r => Number(r.submitRate) || 0);
  if(!el._chart) el._chart = echarts.init(el);
  el._chart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['区域平均分', '完成率(%)'], top: 4 },
    grid: { left: 50, right: 30, top: 40, bottom: 60 },
    xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, rotate: 25, fontSize: 11 } },
    yAxis: [
      { type: 'value', name: '平均分', min: 0, max: 100, position: 'left' },
      { type: 'value', name: '完成率%', min: 0, max: 100, position: 'right' },
    ],
    series: [
      { name: '区域平均分', type: 'bar', data: scores, itemStyle: { color: '#2f6fed' }, barMaxWidth: 28, label: { show: true, position: 'top', fontSize: 11, formatter: p => p.value } },
      { name: '完成率(%)', type: 'line', yAxisIndex: 1, data: submissions, itemStyle: { color: '#e0603a' }, symbol: 'circle', symbolSize: 6, smooth: true },
    ],
  }, true);
}

// v2 区域分数排名映射到各 tab 内的 subtab 容器
const RANK_TABLE_IDS = {
  all:     {table:'regionRankAllTable',     meta:'allRankMeta',      chips:'allPeriodChips'},
  regular: {table:'regularRegionRankTable', meta:'regularRegionRankMeta', chips:'regularRegionRankPeriodChips'},
  self:    {table:'selfRegionRankTable',    meta:'selfRegionRankMeta',    chips:'selfRegionRankPeriodChips'},
  video:   {table:'videoRegionRankTable',   meta:'videoRegionRankMeta',   chips:'videoRegionRankPeriodChips'},
};

async function renderRegionRanking(typeName){
  const ids = RANK_TABLE_IDS[typeName] || RANK_TABLE_IDS.regular;
  const period = regionRankPeriod[typeName] || 'thisWeek';
  const tableId = ids.table, metaId = ids.meta;
  buildPeriodChips(ids.chips, typeName);

  // 视频巡检：后端已支持（planType = SP），正常走接口渲染
  const cached = regionRankData[typeName][period];
  if(cached){
    renderRankTable(tableId, metaId, cached, period, false, typeName);
    return;
  }

  renderRankTable(tableId, metaId, [], period, true, typeName);
  try{
    let data = [];
    if(typeName === 'all'){
      // 全部类型：后端已合并常规巡检（QSC） + 门店自检
      const resp = await fetch(cb(`${DATA_BASE}/rankings_all_${period}.json`), {cache:'no-store'});
      const json = await resp.json();
      if(!json.success){
        throw new Error(json.error || '拉取失败');
      }
      data = json.data || [];
    }else{
      const resp = await fetch(cb(`${DATA_BASE}/rankings_${typeName}_${period}.json`), {cache:'no-store'});
      const json = await resp.json();
      if(!json.success){
        throw new Error(json.error || '拉取失败');
      }
      data = json.data || [];
    }
    regionRankData[typeName][period] = data;
    // 期间可能已切换，仅在当前仍匹配时渲染
    if(regionRankPeriod[typeName] === period){
      renderRankTable(tableId, metaId, data, period, false, typeName);
    }
  }catch(e){
    const table = $(tableId);
    if(table) table.innerHTML = `<tbody><tr><td class="empty">加载失败：${html(e.message)}</td></tr></tbody>`;
    if($(metaId)) $(metaId).textContent = PERIOD_LABELS[period] + ' · 加载失败';
  }
}

function showRegionStores(region, position){
  region = decodeURIComponent(region || '');
  position = decodeURIComponent(position || '');
  const regionData = (appData.regions || []).find(r=>r.region===region && r.position===position);
  if(!regionData) return;
  const stores = regionData.stores || [];
  const total = regionData.storeCount || 0;
  const inspected = stores.length;
  const uninspected = Math.max(0, total - inspected);
  $('regionModalTitle').textContent = `${html(region)} · 常规巡检（QSC）门店清单`;
  $('regionModalSub').innerHTML =
    `岗位：${html(position)}　区域门店总数：${total}　` +
    `本月已巡检：<b style="color:#1a7f37">${inspected}</b> 家　` +
    `未巡检：<b style="color:#c0392b">${uninspected}</b> 家`;
  // 得分降序排列（与慧运营「层级检核」报表口径一致：高分在前）
  const list = stores.slice().sort((a, b)=> (Number(b.score) || 0) - (Number(a.score) || 0));
  $('regionModalTable').innerHTML = `
    <thead><tr>
      <th>门店名称</th><th>得分</th>
      <th>检测项目合格率</th><th>需整改项目数</th><th>已整改数</th>
      <th>未整改数</th><th>整改率</th><th>逾期未整改数</th><th>查看该报表</th>
    </tr></thead>
    <tbody>
      ${list.map(s=>{
        const need = Number(s.needRectify) || 0;
        const done = Number(s.rectified) || 0;
        const unRect = Math.max(0, need - done);
        const rectRate = need > 0 ? Math.round(done / need * 1000) / 10 : 0;
        // 检测项目合格率 = 合格项 / 检查项
        const totalItems = Number(s.sumCount) || 0;
        const normalItems = (s.normalCount != null)
          ? (Number(s.normalCount) || 0)
          : Math.max(0, totalItems - (Number(s.unqualifiedItems) || 0));
        const qRate = totalItems > 0 ? Math.round(normalItems / totalItems * 1000) / 10 : 0;
        return `
        <tr>
          <td>${html(s.storeName)}</td>
          <td class="${scoreClass(s.score)}">${s.score>0?s.score:'-'}</td>
          <td>${totalItems > 0 ? qRate + '%' : '-'}</td>
          <td>${need || '-'}</td>
          <td>${done || '-'}</td>
          <td>${need > 0 ? unRect : '-'}</td>
          <td>${need > 0 ? rectRate + '%' : '-'}</td>
          <td>${s.expired != null ? s.expired : '-'}</td>
          <td>${reportLink(s, '查看该报表', s.planType || 'CG')}</td>
        </tr>`;
      }).join('')}
      ${list.length===0?'<tr><td colspan="9" class="empty">本区域暂无已巡检门店</td></tr>':''}
    </tbody>
  `;
  $('regionModal').classList.add('active');
}

// 门店自检：点击区域行 → 该区域门店清单 + 本月是否已巡检
function showSelfRegionStores(region, position){
  const rname = decodeURIComponent(region || '');
  const pname = decodeURIComponent(position || '');
  const rows = (appData.selfInspection.regions || []).filter(r=>r.region===rname && r.position===pname);
  if(!rows.length){
    alert('该区域暂无自检门店数据');
    return;
  }
  const monthLabel = (appData.selfInspection || {}).monthLabel || '本月';

  // 同一门店可能来自多个自检任务，按 storeCode 去重
  const seen = new Set();
  const list = [];
  rows.forEach(r=>(r.stores || []).forEach(s=>{
    const k = String(s.storeCode || s.storeName || '');
    if(!k || seen.has(k)) return;
    seen.add(k);
    list.push(s);
  }));
  list.sort((a,b)=>
    ((b.monthCompleted||0)>0 ? 1:0) - ((a.monthCompleted||0)>0 ? 1:0) ||
    (b.completed||0)-(a.completed||0) ||
    String(a.storeName||'').localeCompare(String(b.storeName||''),'zh')
  );

  const total = rows[0].storeCount || list.length;
  const enrolled = list.length;
  const monthDone = list.filter(s=>(s.monthCompleted||0)>0).length;
  const rangeDone = list.filter(s=>(s.completed||0)>0).length;

  $('regionModalTitle').textContent = `${rname} · 自检门店清单`;
  $('regionModalSub').innerHTML =
    `岗位：${html(pname)}　区域门店总数：${total}　参与自检任务：${enrolled}<br>` +
    `${monthLabel} 已提交：<b style="color:#1a7f37">${monthDone}</b> 家　` +
    `${monthLabel} 未提交：<b style="color:#c0392b">${enrolled - monthDone}</b> 家　` +
    `（当前区间内有提交的：${rangeDone} 家）`;

  $('regionModalTable').innerHTML = `
    <thead><tr>
      <th>门店</th><th>当天是否有自检</th><th>已完成</th><th>应完成</th><th>未完成</th>
      <th>开店</th><th>打烊</th><th>合格</th><th>不合格</th><th>合格率</th><th>整改率</th><th>平均分</th>
    </tr></thead>
    <tbody>
      ${list.map(s=>{
        const m = s.monthCompleted || 0;
        const badge = m > 0
          ? '<span class="badge-ok">已巡检</span>'
          : '<span class="badge-no">未巡检</span>';
        const qTotal = (s.qualified||0) + (s.unqualified||0);
        const qRate = qTotal > 0 ? Math.round((s.qualified||0) / qTotal * 1000) / 10 : 0;
        return `
          <tr>
            <td>${html(s.storeName)}</td>
            <td>${badge}</td>
            <td>${s.completed}</td>
            <td>${s.expected === undefined ? '-' : s.expected}</td>
            <td>${s.unfinished === undefined ? '-' : s.unfinished}</td>
            <td>${s.kaidian}</td>
            <td>${s.dayan}</td>
            <td>${s.qualified}</td>
            <td>${s.unqualified}</td>
            <td class="${rateClass(qRate)}">${qTotal > 0 ? qRate + '%' : '-'}</td>
            <td class="rate-mid">—</td>
            <td class="${s.avgScore>0?scoreClass(s.avgScore):''}">${s.avgScore>0?s.avgScore:'-'}</td>
          </tr>
        `;
      }).join('')}
      ${list.length===0?'<tr><td colspan="12" class="empty">该区域暂无参与自检任务的门店</td></tr>':''}
    </tbody>
  `;
  $('regionModal').classList.add('active');
}

function closeRegionModal(){
  $('regionModal').classList.remove('active');
}

function showRankRegionStores(region, position, typeName){
  region = decodeURIComponent(region || '');
  position = decodeURIComponent(position || '');
  const period = regionRankPeriod[typeName] || 'thisWeek';
  const rows = regionRankData[typeName] && regionRankData[typeName][period] ? regionRankData[typeName][period] : [];
  const r = rows.find(x => x.region === region && x.position === position);
  if(!r) return;
  const stores = (r.stores || []).slice();
  const total = r.storeCount || 0;
  const inspected = stores.length;
  const uninspected = Math.max(0, total - inspected);

  // 已做排前，未做排后；已做的按分数降序
  stores.sort((a,b)=>{
    const aDone = (a.regularScore != null || a.selfScore != null || a.score != null) ? 1 : 0;
    const bDone = (b.regularScore != null || b.selfScore != null || b.score != null) ? 1 : 0;
    if(aDone !== bDone) return bDone - aDone;
    const aScore = a.regularScore != null ? a.regularScore : (a.selfScore != null ? a.selfScore : (a.score || 0));
    const bScore = b.regularScore != null ? b.regularScore : (b.selfScore != null ? b.selfScore : (b.score || 0));
    return bScore - aScore;
  });

  const typeLabel = {all:'全部类型', regular:'常规巡检（QSC）', self:'门店自检', video:'视频巡检'}[typeName] || typeName;
  $('regionModalTitle').textContent = `${html(region)} · ${typeLabel}门店清单`;
  $('regionModalSub').innerHTML =
    `岗位：${html(position)}　区域门店总数：<b>${total}</b>　` +
    `已做：<b style="color:#1a7f37">${inspected}</b>　` +
    `未做：<b style="color:#c0392b">${uninspected}</b>`;

  let thead, tbody;
  if(typeName === 'all'){
    thead = '<th>门店</th><th>常规巡检（QSC）</th><th>门店自检</th>';
    tbody = stores.map(s=>{
      const regDone = s.regularScore != null;
      const selfDone = s.selfScore != null;
      const regCell = regDone
        ? `<span class="badge-ok">已巡检</span> <span class="${scoreClass(s.regularScore)}">${s.regularScore}</span> ${s.regularIsPass === true ? '<span class="badge-ok">合格</span>' : (s.regularIsPass === false ? '<span class="badge-warn">不合格</span>' : '')}`
        : '<span class="badge-no">未巡检</span>';
      const selfCell = selfDone
        ? `<span class="badge-ok">已完成</span> <span class="${scoreClass(s.selfScore)}">${s.selfScore}</span> ${s.selfIsPass === true ? '<span class="badge-ok">合格</span>' : (s.selfIsPass === false ? '<span class="badge-warn">不合格</span>' : '')}`
        : '<span class="badge-no">未完成</span>';
      return `<tr><td>${html(s.storeName || s.storeCode || '-')}</td><td>${regCell}</td><td>${selfCell}</td></tr>`;
    }).join('');
  }else{
    const doneLabel = typeName === 'self' ? '已完成' : '已巡检';
    const noLabel = typeName === 'self' ? '未完成' : '未巡检';
    thead = `<th>门店</th><th>状态</th><th>得分</th><th>是否合格</th><th>不合格项</th>`;
    tbody = stores.map(s=>{
      const done = s.score != null;
      const score = s.score != null ? `<span class="${scoreClass(s.score)}">${s.score}</span>` : '-';
      const pass = s.isPass === true ? '<span class="badge-ok">合格</span>' : (s.isPass === false ? '<span class="badge-warn">不合格</span>' : '-');
      const unq = s.unRectifyNum || 0;
      return `<tr><td>${html(s.storeName || s.storeCode || '-')}</td><td>${done ? `<span class="badge-ok">${doneLabel}</span>` : `<span class="badge-no">${noLabel}</span>`}</td><td>${score}</td><td>${pass}</td><td>${unq}</td></tr>`;
    }).join('');
  }
  if(stores.length === 0){
    tbody = `<tr><td colspan="${typeName==='all'?3:5}" class="empty">本区域暂无门店数据</td></tr>`;
  }
  $('regionModalTable').innerHTML = `<thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody>`;
  $('regionModal').classList.add('active');
}

function regionTypeFromSub(subId){
  const map = {regionRankAll:'all', regionRankRegular:'regular', regionRankSelf:'self', regionRankVideo:'video'};
  return map[subId];
}

// Main tabs
document.querySelectorAll('#mainTabs .tab').forEach(b=>{
  b.onclick = ()=>{
    document.querySelectorAll('#mainTabs .tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    activeMainTab = b.dataset.t;
    $(activeMainTab).classList.add('active');
    const sub = activeSubTab[activeMainTab];
    if(sub) switchSubTab(sub);
  };
});

function switchSubTab(subId){
  activeSubTab[activeMainTab] = subId;
  document.querySelectorAll('.subtabs .subtab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.module-panel').forEach(p=>p.classList.remove('active'));
  const btn = document.querySelector(`.subtab[data-sub="${subId}"]`);
  if(btn) btn.classList.add('active');
  const panel = $(subId);
  if(panel) panel.classList.add('active');

  // v2 区域分数排名 subtab：按类型拉 rankings json
  if(subId === 'selfRegionRank')    renderRegionRanking('self');
  else if(subId === 'regularRegionRank') renderRegionRanking('regular');
  else if(subId === 'videoRegionRank')   renderRegionRanking('video');

  // v2 高发问题汇总 subtab：确保 unqData 加载后按区域分块渲染
  if(subId === 'selfProblems' || subId === 'regularProblems' || subId === 'videoProblems'){
    const t = subId.replace('Problems','');
    const ensure = unqData ? Promise.resolve() : loadUnqualified();
    ensure.then(()=>renderTypeProblems(t));
  }
}

// Sub tabs
document.querySelectorAll('.subtab').forEach(b=>{
  b.onclick = ()=>switchSubTab(b.dataset.sub);
});

// Search bindings (v2: 三类巡检 5 subtab 对应的新 search id)
$('selfRegionSearch').oninput = ()=>renderSelfInspection(appData);
$('selfStoreRankSearch').oninput = ()=>renderSelfInspection(appData);
$('selfProblemsSearch').oninput = ()=>renderTypeProblems('self');
$('regionSearch').oninput = ()=>renderRegularInspection(appData);
$('regularStoreRankSearch').oninput = ()=>renderRegularInspection(appData);
$('regularProblemsSearch').oninput = ()=>renderTypeProblems('regular');
$('videoRegionSearch').oninput = ()=>renderVideoInspection(appData);
$('videoStoreRankSearch').oninput = ()=>renderVideoInspection(appData);
$('videoProblemsSearch').oninput = ()=>renderTypeProblems('video');

// Chart resize on window resize
window.addEventListener('resize', ()=>{
  if(selfTrendChart) selfTrendChart.resize();
  if(videoTrendChart) videoTrendChart.resize();
  document.querySelectorAll('.rank-chart').forEach(el=>{ if(el._chart) el._chart.resize(); });
});

// Initial load：先一次性把所有月份 JSON 加载到内存（aggregate.js 的 rawMonthCache），
// 之后用默认区间渲染首屏。后续用户切区间/快捷按钮都不再 fetch。
initDates();
(async function boot(){
  if(typeof aggregateRange === 'function'){
    $('loading').style.display = 'block';
    const dataReady = await preloadAllRawMonths();
    if(dataReady){
      await tryAggregateRange(currentStart, currentEnd);
    } else {
      hideRangeBanner();
      await loadData();
    }
    $('loading').style.display = 'none';
  } else {
    await loadData();
  }
})();

// 每 10 分钟刷新：按当前所处模式刷新，避免把用户选的区间冲掉
setInterval(async ()=>{
  if(appData && appData._rawMonths){
    await tryAggregateRange(currentStart, currentEnd);
  }else{
    loadData(false);
  }
}, 10*60*1000);

/* ============================================================================
   v2 新增：岗位组织（type: self/regular/video）、高发问题汇总（type: self/regular/video）
   - 岗位组织：在三个明细 tab 内各画三张岗位大卡（直营组/新店运营组/加盟营运组），
     数据从对应类型的 regions 按 position 分组聚合
   - 高发问题汇总：按区域分块 + @image#1 那种门店卡片（不合格项数 + Top3 问题 + 查看全部）
     数据从 unqData 按 type 取（self→selfStoreRank / regular→byStore / video→appData.videoInspection.stores）
   ============================================================================ */

const POSITION_LABEL = {self:'门店自检', regular:'常规巡检（QSC）', video:'视频巡检'};
const POSITION_SCOPE = {self:'scope-zj', regular:'scope-cg', video:'scope-sp'};

function renderPositionCards(type, d){
  const containerId = type + 'PositionsCards';
  const el = $(containerId);
  if(!el) return;

  // 不论 self/regular/video，所有数字字段一律从 d.stores 实时聚合（storePool 兜底），
  // 不再依赖 aggregate.js 输出的 d.positions / d.selfInspection.positions / d.videoInspection.positions
  const pool = buildStorePool(d);
  const typePool = pool[type] || {};

  // 顺序骨架：self/regular/video 各自对应一个 positions 数组（如果存在）
  let skeleton = [];
  if(type === 'self'){
    const si = (d||{}).selfInspection || {};
    skeleton = (si.positions || []).map(p => p.position);
  } else if(type === 'regular'){
    skeleton = (d||{}).positions ? d.positions.map(p => p.position) : Object.keys(typePool);
  } else if(type === 'video'){
    const vi = (d||{}).videoInspection || {};
    skeleton = (vi.positions || []).map(p => p.position);
  }
  // 如果骨架为空（如 aggregate 没输出 positions），就用 pool 里实际聚合出来的 position key
  if(!skeleton.length) skeleton = Object.keys(typePool);

  // 按骨架顺序构建卡片，每张卡都从 storePool 取数
  // regular 类型的"门店数"统一用组织树基线（data.json 口径，已排除测试门店），保证跨月份一致
  const baseline = (type === 'regular') ? (window.__BASELINE_STORE_COUNT__ || {}) : {};
  const positions = skeleton.map(posName => {
    const fb = typePool[posName];
    if(fb){
      const c = Object.assign({}, fb);
      if(baseline[posName] != null) c.storeCount = baseline[posName];
      return c;
    }
    // 骨架里有但 pool 里没有的（aggregate 旧数据残留），给空值占位
    return {
      position: posName,
      storeCount: (baseline[posName] != null) ? baseline[posName] : 0,
      inspectedCount: 0, submitRate: 0, avgScore: 0, unqualifiedItems: 0, qualifiedRate: 0, regions: []
    };
  });

  if(!positions.length){
    el.innerHTML = '<div class="empty" style="grid-column:1/-1">暂无岗位数据</div>';
    return;
  }

  const label = POSITION_LABEL[type] || '';
  const scopeCls = POSITION_SCOPE[type] || '';
  el.innerHTML = positions.map(p=>{
    const sc = p.storeCount || 0;
    const ic = p.inspectedCount || 0;
    // 完成率与门店数/已巡检保持同一口径
    const submitRate = (sc > 0) ? Math.round(ic / sc * 1000) / 10 : 0;
    const avgScore = p.avgScore || 0;
    const unq = p.unqualifiedItems != null ? p.unqualifiedItems : 0;
    const qRate = p.qualifiedRate != null ? p.qualifiedRate : 0;
    const regionList = p.regions || [];
    const visible = regionList.slice(0, 8);
    const more = regionList.length > 8 ? `<span class="reg-tag">+${regionList.length - 8}</span>` : '';
    return `
      <div class="pos-card">
        <div class="pos-title">${html(p.position)}<span class="scope-tag ${scopeCls}">${label}</span></div>
        <div class="pos-subtitle">${label} · 按岗位汇总</div>
        <div class="pos-meta">
          <div><span class="pv">${p.storeCount||0}</span><span class="pl">门店数</span></div>
          <div><span class="pv">${p.inspectedCount||0}</span><span class="pl">已巡检</span></div>
          <div><span class="pv">${submitRate}%</span><span class="pl">完成率</span></div>
          <div><span class="pv">${avgScore || '-'}</span><span class="pl">平均分</span></div>
          <div><span class="pv">${unq}</span><span class="pl">不合格项</span></div>
          <div><span class="pv">${qRate}%</span><span class="pl">合格率</span></div>
          <div><span class="pv">${regionList.length}</span><span class="pl">区域数</span></div>
        </div>
        <div class="reg-tags">${visible.map(r=>`<span class="reg-tag">${html(r)}</span>`).join('')}${more}</div>
      </div>
    `;
  }).join('') || '<div class="empty" style="grid-column:1/-1">暂无岗位数据</div>';
}

// 高发问题汇总：严格按 V1 不合格明细「按门店分类」卡片样式渲染，三类型自适应数据源
//   type='self'    → unqData.selfStoreRank                          (简化卡片)
//   type='regular' → unqData.byStore                                (含 Top3 问题明细)
//   type='video'   → appData.videoInspection.stores                 (简化卡片)
function renderTypeProblems(type){
  const containerId = type + 'ProblemsCards';
  const el = $(containerId);
  if(!el) return;
  if(!unqData){
    el.innerHTML = '<div class="empty">不合格数据加载中…</div>';
    return;
  }

  // === 数据源按类型 ===
  let stores = [];
  let planTypeForLink = 'CG';
  if(type === 'self'){
    stores = unqData.selfStoreRank || [];
    planTypeForLink = 'ZJ';
  } else if(type === 'regular'){
    stores = unqData.byStore || [];
    planTypeForLink = 'CG';
  } else if(type === 'video'){
    stores = ((appData||{}).videoInspection && (appData.videoInspection).stores || []).map(v=>({
      store: v.storeName, region: v.region, position: v.position,
      avgScore: v.score, reportCount: v.reportCount,
      reportId: v.reportId, signId: v.signId, unqualifiedItems: v.unqualifiedItems,
    }));
    planTypeForLink = 'CG';
  }

  // === 搜索（店名 / 区域） ===
  const searchEl = $(type + 'ProblemsSearch');
  const search = searchEl ? (searchEl.value || '').trim().toLowerCase() : '';
  const filtered = stores.filter(s=>
    (s.store||'').toLowerCase().includes(search) ||
    (s.region||'').toLowerCase().includes(search)
  );

  // === 渲染：常规巡检（CG）走 V1 标准 Top3 卡片，其他走简化卡片 ===
  const rows = filtered;
  let html;
  if(type === 'regular'){
    html = rows.map(s=>`
      <div class="unq-card">
        <div class="unq-card-head">
          <div>
            <div class="unq-card-title">${html(s.store)}</div>
            <div class="unq-card-meta">${html(s.region)} · ${html(s.position)}</div>
          </div>
          <span class="unq-card-badge">不合格 ${s.unqCount || 0} 项</span>
        </div>
        <div class="unq-card-stats">
          <span>涉及问题项 <b>${s.itemCount || 0}</b></span>
          <span>${(s.topItems||[]).length ? `高发问题 Top${Math.min(s.topItems.length,3)}` : '无高发问题'}</span>
        </div>
        <div class="unq-card-items">
          ${(s.topItems||[]).slice(0,3).map(t=>unqItemRow(t)).join('')}
        </div>
        <div class="unq-card-actions">
          <span class="link-btn" onclick="showUnqStoreDetail('${encodeURIComponent(s.store||'')}', '${encodeURIComponent(s.region||'')}', '${encodeURIComponent(s.position||'')}')">查看全部问题</span>
        </div>
      </div>
    `).join('') || '<div class="empty">无数据</div>';
  } else {
    // 自检 / 视频巡检：V1 简化卡片样式（无 Top3 问题明细）
    html = rows.map(s=>`
      <div class="unq-card">
        <div class="unq-card-head">
          <div>
            <div class="unq-card-title">${html(s.store)}</div>
            <div class="unq-card-meta">${html(s.region)} · ${html(s.position)}</div>
          </div>
          <span class="unq-card-badge">${s.avgScore != null ? s.avgScore + ' 分' : '无分'}</span>
        </div>
        <div class="unq-card-stats">
          <span>报告数 <b>${s.reportCount != null ? s.reportCount : '-'}</b></span>
          ${s.unqualifiedItems != null ? `<span>不合格 <b>${s.unqualifiedItems}</b></span>` : ''}
          ${s.lastDate ? `<span>最近 <b>${html(s.lastDate)}</b></span>` : ''}
        </div>
        <div class="unq-card-actions">
          ${type === 'video' ? (s.signId ? reportLink(s, '查看报告', 'CG') : '<span style="color:#999">视频报告暂不支持外链</span>') : reportLink(s, '查看报告', s.planType || planTypeForLink)}
        </div>
      </div>
    `).join('') || '<div class="empty">无数据</div>';
  }

  el.innerHTML = html;
  refreshUnqPhotos(el);
}
