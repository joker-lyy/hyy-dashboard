// GitHub Pages 静态版：所有数据都是构建期预生成的 JSON，无后端、无跨域
// v2 子目录：从上级 data 取数
const DATA_BASE = "../data";
// reportDetails.json 全量版 236MB 超 GitHub 100MB 单文件限制，切成 3 片存放，加载时按字节拼接还原
const REPORT_DETAILS_PARTS = 3;

let appData = null;
// fix53：报告明细（免登录查看），键为 planType:reportId，值来自 data/reportDetails.json
let reportDetails = {};
// fix70：报告明细本身的"最近刷新时间"（双击 .bat 后更新），用于右上角
let reportDetailsGeneratedAt = null;
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
// fix48：门店分数排名内的"区域二级筛选"（点了组别后再筛区域）
let selfRankRegionFilter = '__all__';
let regularRankRegionFilter = '__all__';
let videoRankRegionFilter = '__all__';
let activeMainTab = 'overview';
// v2 精简：去掉 regionRanking / unqualifiedDetail 顶层 tab，三类巡检 tab 各 5 subtab
let activeSubTab = {overview:'', selfInspection:'selfRegions', regularInspection:'regularRegions', videoInspection:'videoRegions', aiInspection:'aiRegions'};
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
// fix87：页面只展示本轮数据真正完成生成的时间，不再拿 reportDetails 的旧生成时间冒充。
let reportRefreshCompletedAt = null;
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
  // 慧运营是哈希路由，直接访问 history 路径会返回 404；必须保留 /#/。
  let url = `${HYY_WEB_BASE}/#${rt.path}`
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
  if(!item || !item.reportId) return '<span style="color:#999">无报告</span>';
  const pt = String(planType || item.planType || 'CG').toUpperCase();
  const rid = encodeURIComponent(String(item.reportId));
  const sid = encodeURIComponent(String(item.signId || ''));
  const sn = encodeURIComponent(item.storeName || item.store || '');
  const rg = encodeURIComponent(item.region || '');
  const rd = encodeURIComponent(item.reportDate || item.lastDate || '');
  const sc = (item.score != null) ? item.score : (item.avgScore != null ? item.avgScore : '');
  const ip = item.isPass === true ? 1 : (item.isPass === false ? 0 : -1);
  // fix75：调试日志（用户点视频巡检报告无反应时方便定位）
  //  上线后可去掉，但保留方便后续排查
  // fix53：改为仪表盘内弹窗查看，免登录；不再跳慧运营网页
  // fix62：把 signId 传给弹窗，便于「暂无明细」时给出「在慧运营后台打开」原报告链接
  // fix75：SP 报告点击后弹窗会显示"视频巡检无明细"提示 + 慧运营后台跳转按钮
  return `<a class="report-link" href="javascript:void(0)" onclick="event.stopPropagation();try{console.log('[reportLink]',{pt:'${pt}',rid:'${rid}',sn:'${sn}'});showReportDetail('${rid}','${sid}','${pt}','${sn}','${rg}','${rd}',${JSON.stringify(sc)},${ip})}catch(e){console.error('[reportLink] error',e);alert('打开报告失败：'+e.message)}">${html(label||'查看报告')}</a>`;
}

// fix53：报告明细弹窗（免登录查看）
function closeReportDetailModal(){ $('reportDetailModal').classList.remove('active'); }

// fix57：原始报告 UI 全面升级 —— 突出「问题点 + 现场照片 + 整改状态」
// 用户原始诉求：一眼看出问题在哪里、整改到哪一步；不只列名+分数。
function _pick(o, keys){ for(const k of keys){ if(o[k] != null && o[k] !== '') return o[k]; } return ''; }
function _pickResult(it){
  if(it.pass != null) return it.pass ? {ok:true, label:'合格'} : {ok:false, label:'不合格'};
  if(it.isPass != null) return it.isPass ? {ok:true, label:'合格'} : {ok:false, label:'不合格'};
  if(it.qualified != null) return it.qualified ? {ok:true, label:'合格'} : {ok:false, label:'不合格'};
  if(it.isQualified != null) return it.isQualified ? {ok:true, label:'合格'} : {ok:false, label:'不合格'};
  if(it.result != null){
    const r = String(it.result);
    return {ok: r.includes('合格')||r.includes('通过'), label: r};
  }
  if(it.status != null){
    const r = String(it.status);
    return {ok: r.includes('合格')||r.includes('通过'), label: r};
  }
  if(it.resultStatus != null) return {ok:null, label: String(it.resultStatus)};
  return {ok:null, label:''};
}
// 提取照片 URL 列表（兼容多种字段命名）
function _pickPhotos(it){
  const cands = [
    it.pictures, it.pictureList, it.photos, it.photoList, it.images,
    it.imageList, it.imgs, it.attachments, it.attachList, it.files,
    it.checkPics, it.problemPics, it.itemPics, it.picList, it.pics,
  ];
  for(const c of cands){
    if(Array.isArray(c) && c.length){
      return c.map(p => (typeof p === 'string') ? p : (p.url || p.src || p.path || p.fileUrl || p.imageUrl || ''))
              .filter(Boolean);
    }
  }
  if(typeof it === 'object'){
    // 单图情况
    const single = it.picUrl || it.imageUrl || it.photo || it.picture;
    if (single) return [typeof single === 'string' ? single : (single.url || single.src || '')];
  }
  return [];
}
// 图片域名兜底（HYY 图片域名前缀）
const _HYY_IMG_BASE = 'https://testhyy.ruipos.com/';
function _absImgUrl(u){
  if(!u) return '';
  const s = String(u);
  if(/^https?:\/\//i.test(s)) return s;
  // 去掉开头的 /
  return _HYY_IMG_BASE + s.replace(/^\/+/, '');
}

function _reportScoreScale(raw){
  // 慧运营接口把模板分值放大返回：QSC 模板 1 分会返回 100，2 分会返回 200。
  // 模板设置里的「报告得分=换算成百分制」，所以展示时统一还原为模板分值。
  const templateScore = Number(raw && raw.templateScore);
  if(templateScore >= 1000) return 100;
  if(templateScore >= 100) return 100;
  return 1;
}
function _numScore(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _isTrueFlag(v){
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'True';
}
function _fmtScore(v){
  if(v == null || !Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
function _renderReportItemTable(name, arr, opts){
  opts = opts || {};
  // fix73：如果 arr 元素有 itemList 子数组（ZJ 自检报告 categoryList[].itemList[] 结构），
  // 按 cat 分组渲染（cat 头部 + 内部 itemList 表格）
  if(Array.isArray(arr) && arr.length && arr[0] && Array.isArray(arr[0].itemList)){
    let out = `<div class="rd-sec"><div class="rd-sec-h">${html(name)}（共 ${arr.length} 类目）</div>`;
    for(const cat of arr.slice(0, 30)){
      const cname = cat.categoryName || cat.name || '未命名';
      const items = cat.itemList || [];
      const catScore = _numScore(cat.categoryScore);
      const catScoreText = opts.normalizeScore && catScore != null && Number(opts.scoreDivisor) > 1
        ? ` · 得分 ${_fmtScore(catScore / Number(opts.scoreDivisor))}` : '';
      out += `<div style="margin:8px 0 4px;font-weight:600">📂 ${html(cname)}（${items.length} 项${catScoreText}）</div>`;
      out += _renderReportItemTable(cname, items, opts);
    }
    return out + '</div>';
  }
  let out = `<div class="rd-sec"><div class="rd-sec-h">${html(name)}（共 ${arr.length} 项）</div>`;
  out += `<table class="rank rd-detail"><thead><tr><th style="width:24%">检查项</th><th style="width:10%">类别</th><th style="width:8%">${opts.weighted100 ? '得分 / 满分' : '得分'}</th><th style="width:10%">结果</th><th>问题点 / 说明 / 现场照片</th></tr></thead><tbody>`;
  for(const it of arr.slice(0,300)){
    if(!it || typeof it !== 'object') continue;
    const nm = _pick(it, ['title','name','itemName','checkName','contentName','checkItem','checkItemName','itemTitle','pointName','subject','item','checkPointName','pointContent']);
    const cat = _pick(it, ['category','categoryName','itemCategory','type','bigCategory','bigCategoryName','smallCategory','smallCategoryName','sortName','checkPointCategory','checkTypeName']);
    const rawSc = _pick(it, ['score','itemScore','scoreValue','pointScore','realScore','actualScore','point','itemPoint','deductScore']);
    const actualSc = _numScore(_pick(it, ['realScore','actualScore','score','itemScore']));
    const maxSc = _numScore(_pick(it, ['passedScore','maxScore','fullScore','score','itemScore']));
    const divisor = Number(opts.scoreDivisor) > 0 ? Number(opts.scoreDivisor) : 1;
    // 自检明细接口把项目分值放大 100 倍（1000=10分、2000=20分），
    // 与常规巡检的权重还原共用 scoreDivisor，但自检只展示实际“得分”这一列，
    // 不把原始放大值漏到普通明细渲染里。
    const normalizeScore = opts.normalizeScore === true && divisor > 1;
    const displayRawSc = _numScore(rawSc);
    const displaySc = normalizeScore && displayRawSc != null ? displayRawSc / divisor : displayRawSc;
    const scv = opts.weighted100 && (actualSc != null || maxSc != null)
      ? `${_fmtScore(actualSc == null ? null : actualSc / divisor)} / ${_fmtScore(maxSc == null ? null : maxSc / divisor)}`
      : _fmtScore(displaySc);
    const res = _pickResult(it);
    // 慧运营常规巡检报告的“问题描述”实际字段通常是 disQualifiedDesc；
    // 直营组等批次不会写入 description/problemDesc，漏掉该字段就会出现“不合格但问题点为空”。
    const note = _pick(it, ['disQualifiedDesc','disqualifyDesc','unqualifiedDesc','issueDescription','problemDescription','remark','note','desc','description','comment','reason','problemDesc','problem','remarkInfo','content','checkContent']);
    const rect = _pick(it, ['rectifyStatus','rectStatus','rectificationStatus','rectifyState','handleStatus','processingStatus','isRectified']);
    const photos = _pickPhotos(it);
    // 不合格项高亮
    const rowCls = (res.ok === false) ? ' class="rd-fail"' : '';
    const resultHtml = res.label
      ? (res.ok === false
          ? `<span class="badge-no">${html(res.label)}</span>`
          : (res.ok === true ? `<span class="badge-ok">${html(res.label)}</span>` : `<span class="badge-mid">${html(res.label)}</span>`))
      : '-';
    // 整改状态徽章
    let rectHtml = '';
    if(rect){
      const r = String(rect);
      const isDone = r.includes('已') && (r.includes('整改') || r.includes('完成'));
      const isWait = r.includes('待') || r.includes('未整改');
      const cls = isDone ? 'badge-ok' : (isWait ? 'badge-no' : 'badge-mid');
      rectHtml = ` <span class="${cls}">${html(r)}</span>`;
    }
    // 照片缩略图墙
    let photosHtml = '';
    if(photos.length){
      const absPhotos = photos.slice(0,6).map(p => _absImgUrl(p)).filter(Boolean);
      photosHtml = '<div class="rd-photos">' + absPhotos.map(u =>
        `<a href="${html(u)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><img src="${html(u)}" loading="lazy" onerror="this.parentNode.style.display=\\'none\\'" alt="现场照片"/></a>`
      ).join('') + (photos.length > 6 ? `<span class="rd-photo-more">+${photos.length-6}</span>` : '') + '</div>';
    }
    // 不合格项问题点说明（标红）
    const noteHtml = (res.ok === false && note)
      ? `<div class="rd-problem">⚠ ${html(String(note))}</div>`
      : (note ? `<div class="rd-note">${html(String(note))}</div>` : '');
    out += `<tr${rowCls}><td>${html(String(nm||'-'))}</td><td>${html(String(cat||'-'))}</td><td>${html(String(scv===''?'':scv))}</td><td>${resultHtml}${rectHtml}</td><td>${noteHtml}${photosHtml}</td></tr>`;
  }
  out += `</tbody></table></div>`;
  return out;
}
function _renderReportKv(raw){
  const skip = new Set(['success','error','cachedAt','meta','details','raw','endpoint','planType','reportId','signId','rectifications','token']);
  const rows = [];
  for(const [k,v] of Object.entries(raw)){
    if(skip.has(k)) continue;
    if(v && typeof v === 'object') continue;
    rows.push([k, v]);
  }
  if(!rows.length){
    return `<details class="rd-raw"><summary>原始明细数据（调试用）</summary><pre>${html(JSON.stringify(raw, null, 2))}</pre></details>`;
  }
  let out = `<div class="rd-sec"><div class="rd-sec-h">报告信息</div><table class="rank rd-detail"><tbody>`;
  for(const [k,v] of rows){
    out += `<tr><td class="rd-k">${html(String(k))}</td><td>${html(String(v==null?'':v))}</td></tr>`;
  }
  out += `</tbody></table></div>`;
  return out;
}
function _looksLikeCgRaw(raw){
  if(!raw || !Array.isArray(raw.categoryList)) return false;
  // 常规巡检 QSC 的接口字段在不同组织/报告批次并不完全一致：
  // 直营组有一批报告返回 templateScore=100、transTo100pts=true，
  // 但检查项分值仍是 100/200/300 的放大值。不能只靠 templateScore 判断，
  // 否则会退回普通表格，把每个项目误显示成 100 分。
  if(raw._cgNormalized || Number(raw.templateScore) >= 1000 || raw.transTo100pts === false) return true;
  const itemCount = raw.categoryList.reduce((n, c) => n + (Array.isArray(c && c.itemList) ? c.itemList.length : 0), 0);
  const hasScaledWeight = raw.categoryList.some(c => (c.itemList || []).some(it => {
    const v = Number(it && (it.passedScore != null ? it.passedScore : it.score));
    return Number.isFinite(v) && v > 10;
  }));
  return Number(raw.itemSum) >= 30 || (itemCount >= 30 && hasScaledWeight);
}
function renderReportRaw(raw){
  if(!raw || typeof raw !== 'object') return '';
  // 苍井 CG 常规巡检 QSC：不同批次可能返回不同 templateScore，
  // 统一由结构识别后进入按真实权重渲染。
  if(_looksLikeCgRaw(raw)) return renderReportRawCG(raw);
  // 门店自检（ZJ）：报告总分已经是百分制，但分类/检查项分值仍按 100 倍返回，
  // 例如 1000=10 分、2000=20 分。进入普通表格前统一除以 100。
  if(Array.isArray(raw.categoryList)){
    const itemCount = raw.categoryList.reduce((n, c) => n + ((c && c.itemList) || []).length, 0);
    const hasScaledItems = raw.categoryList.some(c => (c.itemList || []).some(it => {
      const v = Number(it && (it.realScore != null ? it.realScore : (it.score != null ? it.score : it.passedScore)));
      return Number.isFinite(v) && v > 100;
    }));
    // ZJ 明细通常只有 3~7 项，且部分批次没有返回 transTo100pts；
    // 用“小项目数 + 100 倍分值”识别，避免再把 1000/2000 原样显示。
    const looksLikeSelf = itemCount > 0 && itemCount <= 20 && hasScaledItems
      && (Number(raw.templateScore) === 100 || raw.itemSum == null || Number(raw.itemSum) <= 20);
    if(looksLikeSelf){
      return _renderReportItemTable('报告明细', raw.categoryList, {normalizeScore:true, scoreDivisor:100});
    }
  }
  // 单列数组：直接当明细行
  if(Array.isArray(raw)) return _renderReportItemTable('报告明细', raw);
  // 对象：优先找已知明细列表字段
  const LIST_KEYS = ['categoryList','items','details','itemList','checkItems','reportItems',
                     'list','categorys','problems','evaluateItems','checkList','itemDetails',
                     'checkPoints','questionList','contentList','subItems','reportDetailList',
                     'checkPointList','checkItemList','inspectItems','inspectItemList',
                     'itemDetailList','problemList','reportDetailVoList','detailList',
                     'checkResultList','resultItemList','checkContentList','problemItems',
                     'problemItemList','evaluationList','evaluateList','checkVoList'];
  let foundSections = [];
  const seenSigs = new Set();
  for(const k of LIST_KEYS){
    if(Array.isArray(raw[k]) && raw[k].length){
      // 同一份明细可能存了多个字段名（如 itemList/checkItems/evaluateItems），按内容签名去重，只渲染一次
      let sig = null;
      try{ sig = JSON.stringify(raw[k]); }catch(e){ sig = null; }
      if(sig && seenSigs.has(sig)) continue;
      if(sig) seenSigs.add(sig);
      foundSections.push([k, raw[k]]);
    }
  }
  if(foundSections.length){
    return foundSections.map(([k,arr]) => _renderReportItemTable(k, arr)).join('');
  }
  // 没有已知列表字段 -> 渲染成「报告信息」键值表（不再丢成裸 JSON）
  return _renderReportKv(raw);
}

// CG 报告明细（苍井常规巡检 QSC）：分类 → 检查项，带得分 / 合格判定 / 不合格说明 / 现场照片
function _cgQualified(it){
  const v = it.isQualified;
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'True';
}

// fix78：AI 慧检报告明细（端点 /statRi/web/ai/audit/report/detail；itemList 含 description+attachmentList[]）
// 视觉对照慧运营 SPA 详情页：巡检项 + 项目分值 + 巡检结果 + 合格分值 + 不合格说明 + 现场照片
function _absCjssImg(rel){
  if(!rel) return '';
  const s = String(rel);
  if(/^https?:/i.test(s)) return s;  // 已是绝对地址
  // AI 视频巡检报告的图片走 testhyy bucket（实测可裸访问，200 OK）
  const OSS = 'https://testhyy.oss-cn-shanghai.aliyuncs.com/';
  return OSS + s.replace(/^\/+/, '');
}
function _aiQualified(it){
  // AI 报告 result: 1=合格 0=不合格；resultName 中文（兜底判定）
  if(it.result != null) return Number(it.result) === 1;
  const rn = String(it.resultName || '');
  return rn.includes('合格') && !rn.includes('不合');
}
function renderReportRawAI(raw){
  const items = Array.isArray(raw.itemList) ? raw.itemList : [];
  let out = '';
  // 报告头
  const totalScore = (typeof raw.totalScore === 'number') ? raw.totalScore : null;
  const totalN = items.length;
  const qualifiedN = items.filter(_aiQualified).length;
  if(totalScore != null || totalN || raw.taskName || raw.reportTime){
    out += `<div class="rd-basic" style="margin-bottom:10px">`;
    if(totalScore != null) out += `<div class="rd-row"><span>报告总分</span><b>（满分 ${totalN} / 实际得分 ${qualifiedN}）</b></div>`;
    if(raw.taskName) out += `<div class="rd-row"><span>所属任务</span><b>${html(String(raw.taskName))}</b></div>`;
    if(raw.reportTime) out += `<div class="rd-row"><span>报告时间</span><b>${html(String(raw.reportTime))}</b></div>`;
    out += `</div>`;
  }
  if(!items.length){
    out += `<div class="placeholder-box">该 AI 慧检报告未返回明细项。</div>`;
    return out;
  }
  // 项级别：合格徽章 / 不合格徽章 / 项目分值 / 巡检结果 / 问题描述 / 现场照片
  for(const it of items){
    const name = it.itemName || `项目 ${it.itemId}`;
    const score = (it.itemScore != null) ? Number(it.itemScore) : 0;
    const pass = _aiQualified(it);
    const headCls = pass ? 'rd-cat-h' : 'rd-cat-h rd-cat-fail';
    out += `<div class="rd-cat">`;
    out += `<div class="${headCls}">📌 ${html(name)} <span class="rd-cat-sub">（满分 ${score}）</span>`;
    out += pass ? ` <span class="badge-ok">合格</span>` : ` <span class="badge-no">${html(String(it.resultName||'不合格'))}</span>`;
    out += `</div>`;
    // 不合格描述
    const desc = String(it.descText || '').trim();
    if(desc){
      out += `<div class="rd-note" style="margin:6px 0"><b>问题描述：</b>${html(desc)}</div>`;
    }
    // 现场照片
    const atts = Array.isArray(it.attachmentList) ? it.attachmentList : [];
    if(atts.length){
      out += `<div class="rd-photos" style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0">`;
      for(const a of atts.slice(0,8)){
        const url = _absCjssImg(a.imageUrl || '');
        if(!url) continue;
        const t = a.captureTime || '';
        out += `<a href="${html(url)}" target="_blank" rel="noopener noreferrer" title="${html(t)}">
          <img src="${html(url)}" referrerpolicy="no-referrer" loading="lazy" style="width:120px;height:120px;object-fit:cover;border-radius:6px;border:1px solid #e0e0e0;background:#f5f6f8">
        </a>`;
      }
      if(atts.length > 8) out += `<span style="color:#888;font-size:12px;align-self:center">+${atts.length-8} 张</span>`;
      out += `</div>`;
    } else {
      out += `<div class="rd-note" style="margin:6px 0;color:#888;font-size:12px">（无现场照片）</div>`;
    }
    out += `</div>`;
  }
  return out;
}

function _cgScoreSummary(raw){
  if(!raw || typeof raw !== 'object') return {max: null, actual: null, divisor: 1, cats: []};
  // notcategoryList 是「不合格项索引」，其中的项目已经包含在 categoryList，
  // 不能与 categoryList 相加，否则直营组会被重复计算成满分 117 分。
  const cats = Array.isArray(raw.categoryList) && raw.categoryList.length
    ? raw.categoryList : (raw.notcategoryList || []);
  const divisor = _reportScoreScale(raw);
  let max = 0, actual = 0;
  for(const c of cats){
    for(const it of (c.itemList || [])){
      const itemMax = _numScore(it.passedScore != null ? it.passedScore : it.score);
      const itemActual = _numScore(it.realScore != null ? it.realScore : it.score);
      if(itemMax != null) max += itemMax / divisor;
      if(itemActual != null) actual += itemActual / divisor;
    }
  }
  return {max, actual, divisor, cats};
}
function renderReportRawCG(raw){
  let out = '';
  // QSC 模板设置明确为「换算成百分制」，项目分值合计 100；接口把分值放大 100 倍。
  const summary = _cgScoreSummary(raw);
  const divisor = summary.divisor;
  const catsAll = summary.cats;
  const totalAll = summary.max;
  const totalActual = summary.actual;
  const pass = raw.isPassString;
  if(totalAll || pass || raw.templateName){
    out += `<div class="rd-basic" style="margin-bottom:10px">`;
    out += `<div class="rd-row"><span>报告总分</span><b>（满分 ${_fmtScore(totalAll)} / 实际得分 ${_fmtScore(totalActual)}）</b></div>`;
    if(pass) out += `<div class="rd-row"><span>巡检判定</span><b>${html(String(pass))}</b></div>`;
    if(raw.templateName) out += `<div class="rd-row"><span>巡检模板</span><b>${html(String(raw.templateName))}</b></div>`;
    out += `</div>`;
  }
  // 总结分析
  if(Array.isArray(raw.summaryList) && raw.summaryList.length){
    out += `<div class="rd-sec"><div class="rd-sec-h">总结分析</div>`;
    for(const s of raw.summaryList){
      const t = s.title || ''; const c = s.content || '';
      if(t || c) out += `<div class="rd-note">${t?`<b>${html(t)}：</b>`:''}${html(c)||'（未填写）'}</div>`;
    }
    out += `</div>`;
  }
  // 分类 → 检查项
  if(!catsAll.length){
    out += `<div class="placeholder-box">该报告未返回分类明细。</div>`;
    return out;
  }
  for(const cat of catsAll){
    const name = cat.categoryName || '未命名分类';
    const items = cat.itemList || [];
    // 按 QSC 项目权重汇总，不再把每个检查项当成 1 分。
    let catMax = 0, catActual = 0;
    for(const it of items){
      const max = _numScore(it.passedScore != null ? it.passedScore : it.score);
      const actual = _numScore(it.realScore != null ? it.realScore : it.score);
      if(max != null) catMax += max / divisor;
      if(actual != null) catActual += actual / divisor;
    }
    const failN = items.filter(it => !_cgQualified(it)).length;
    const headCls = failN ? 'rd-cat-h rd-cat-fail' : 'rd-cat-h';
    out += `<div class="rd-cat">`;
    out += `<div class="${headCls}">📂 ${html(name)} <span class="rd-cat-sub">（满分 ${_fmtScore(catMax)} / 实际得分 ${_fmtScore(catActual)}）</span>`;
    if(failN) out += ` <span class="badge-no">${failN} 项不合格</span>`;
    out += `</div>`;
    if(items.length) out += _renderReportItemTable(name, items, {weighted100:true, scoreDivisor:divisor});
    out += `</div>`;
  }
  return out;
}

// fix57：整改单表格加上「问题照片」「整改前后对比」缩略图列
function renderRectifications(rects){
  if(!Array.isArray(rects) || !rects.length) return '';
  let rows = '';
  for(const r of rects.slice(0, 100)){
    if(!r || typeof r !== 'object') continue;
    const desc = _pick(r, ['description','desc','problemDesc','problem','content','rectifyContent','requireContent']);
    const point = _pick(r, ['checkPoint','checkPointName','checkpoint','pointName']);
    const rel = _pick(r, ['relInspectItem','inspectItem','relItem','itemName','checkItem']);
    const status = _pick(r, ['status','rectifyStatus','rectStatus','rectificationStatus','state','handleStatus','processingStatus']);
    const source = _pick(r, ['source','sourceName','rectifySource']);
    const related = _pick(r, ['relatedReport','reportName','reportTitle','reportId']);
    const owner = _pick(r, ['owner','rectifyUser','responsibleUser','dutyUser','responsible','rectifyPerson']);
    const deadline = _pick(r, ['deadline','rectifyDeadline','requireDeadline','limitDate','finishDate']);
    const photos = _pickPhotos(r);
    let statusHtml = '-';
    if(status){
      const s = String(status);
      const isDone = s.includes('已') && (s.includes('整改') || s.includes('完成'));
      const isWait = s.includes('待') || s.includes('未');
      const cls = isDone ? 'badge-ok' : (isWait ? 'badge-no' : 'badge-mid');
      statusHtml = `<span class="${cls}">${html(s)}</span>`;
    }
    let photosHtml = '';
    if(photos.length){
      const abs = photos.slice(0,4).map(p => _absImgUrl(p)).filter(Boolean);
      photosHtml = '<div class="rd-photos rd-photos-sm">' + abs.map(u =>
        `<a href="${html(u)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><img src="${html(u)}" loading="lazy" onerror="this.parentNode.style.display=\\'none\\'" alt="整改照片"/></a>`
      ).join('') + '</div>';
    }
    rows += `<tr>
      <td>${html(String(desc||'-'))}</td>
      <td>${html(String(point||'-'))}</td>
      <td>${html(String(rel||'-'))}</td>
      <td>${statusHtml}</td>
      <td>${html(String(owner||'-'))}</td>
      <td>${html(String(deadline||'-'))}</td>
      <td>${html(String(source||'-'))}</td>
      <td>${photosHtml || html(String(related||'-'))}</td>
    </tr>`;
  }
  if(!rows) return '';
  return `<h4 class="rd-h">关联整改单（共 ${rects.length} 条）</h4>
    <table class="rank rd-detail"><thead><tr>
      <th>问题描述</th><th>检查要点</th><th>关联巡检项</th><th>整改状态</th><th>责任人</th><th>整改期限</th><th>来源</th><th>现场照片 / 相关报告</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function showReportDetail(ridEnc, sidEnc, pt, snEnc, rgEnc, rdEnc, sc, ip){
  const rid = decodeURIComponent(ridEnc || '');
  const sid = decodeURIComponent(sidEnc || '');
  const sn = decodeURIComponent(snEnc || '');
  const rg = decodeURIComponent(rgEnc || '');
  const rd = decodeURIComponent(rdEnc || '');
  // fix78：AI 报告新 planType=AI，先按调用方传的 pt 找，缺失时按 AI:/SP:回退
  const candidates = [(pt || 'CG') + ':' + rid, 'AI:' + rid, 'SP:' + rid];
  let det = null, foundKey = '';
  // fix79：reportDetails 实际是 {success, generatedAt, source, details:{...}} 嵌套结构，
  //   顶层没有明细键；同时要兼容旧版（直接是字典）以防以后又改回
  const rdMap = (reportDetails && reportDetails.details) ? reportDetails.details : reportDetails;
  // fix98：只有带真实 raw 的条目才算命中——旧管线残留的 VIDEO: 键往往 raw=null 且只有
  //   error（如 "no_data_or_endpoint"），直接命中会让弹窗停在「云端暂未抓取到」或
  //   渲染扁平元数据，永远不会触发按需加载的 SP_ 单文件。跳过它们走懒加载兜底。
  for(const k of candidates){
    const e = rdMap && rdMap[k];
    if(e && (e.raw || (!e.error && e.reportId != null))){ det = e; foundKey = k; break; }
  }
  const effectivePt = det ? (foundKey.split(':')[0] || pt) : (pt || 'CG');
  const planLabel = {CG:'常规巡检（QSC）', ZJ:'门店自检', SP:'视频巡检', AI:'AI 慧检（视频巡检）'}[effectivePt] || effectivePt;
  let body = '';
  body += `<div class="rd-basic">`;
  body += `<div class="rd-row"><span>门店</span><b>${html(sn || '-')}</b></div>`;
  body += `<div class="rd-row"><span>区域</span><b>${html(rg || '-')}</b></div>`;
  body += `<div class="rd-row"><span>计划类型</span><b>${html(planLabel)}</b></div>`;
  body += `<div class="rd-row"><span>报告日期</span><b>${html(rd || '-')}</b></div>`;
  // CG 报告顶部也必须使用 QSC 权重计算结果，不能继续显示列表里的旧 score。
  // 直营组部分批次列表分数与报告明细分数可能不同，明细权重是唯一可信口径。
  let headerScore = sc;
  if(det && det.raw && _looksLikeCgRaw(det.raw)){
    const cgSummary = _cgScoreSummary(det.raw);
    if(cgSummary.actual != null) headerScore = cgSummary.actual;
  } else if(det && det.raw && Array.isArray(det.raw.categoryList) && det.raw.transTo100pts === true){
    // 门店自检报告头部的 score 已经是百分制；只修正文档明细中的 100 倍项目分值。
    const selfScore = _numScore(det.raw.score);
    if(selfScore != null) headerScore = selfScore;
  }
  if(headerScore !== '' && headerScore != null){
    const headerNum = Number(headerScore);
    const scCls = Number.isFinite(headerNum) && headerNum > 0 ? scoreClass(headerNum) : '';
    body += `<div class="rd-row"><span>总得分</span><b class="${scCls}">${html(_fmtScore(headerScore))}</b></div>`;
  }
  if(ip === 1 || ip === 0){
    body += `<div class="rd-row"><span>判定</span><b>${ip ? '<span class="badge-ok">合格</span>' : '<span class="badge-no">不合格</span>'}</b></div>`;
  }
  body += `</div>`;
  // fix62：本地明细不可用时，给出「在慧运营后台打开」原报告链接
  // fix63：原写法只有 noopener，浏览器跳转时仍带 referrer=仪表盘域名，被阿里云 OSS
  //   防盗链拒访（错误 "You are denied by bucket referer policy"）。
  //   加 noreferrer 去掉 referrer 头才能让慧运营的 OSS 静态页正常加载。
  // fix64：直接跳单份报告详情页无效——慧运营 selfTestReport-details 不是按
  //   reportId 简单定位，需要 organizeId / 签名 token 等拿不到的字段，否则会
  //   打开空模板页（用户截图：点了中山康华店，跳过去显示「加茂南店」空模板）。
  //   改为跳报告列表页让用户自己按日期/门店筛选。保留「复制 reportId」方便粘贴查。
  //   URL 路由表（用户实测可访问）：
  //     CG 常规巡检（QSC）→ /pollingReport               （带 reportId+signId 才准）
  //     ZJ 门店自检      → /selfTestReport               （按日期/区域列表）
  //     SP 视频巡检      → /videoReport                  （按日期/区域列表）
  //     AI 慧检         → /statRi/web/aiAuditReport      （按日期/区域列表）
  // fix88：删除「在慧运营后台查看报告」「复制报告信息」按钮（用户要求）
  if(det && det.raw){
    // fix78：AI 慧检报告（端点 /statRi/web/ai/audit/report/detail）返 raw.itemList[] 含 description+photo，
    //   用专门的 AI 表格渲染——巡检项、项目分值、合格/不合格、问题描述、现场照片
    const isAiReport = Array.isArray(det.raw.itemList);
    if(isAiReport){
      body += `<h4 class="rd-h">AI 慧检项目明细</h4>` + renderReportRawAI(det.raw);
    } else {
      // 旧逻辑：CG / ZJ / 老 SP（只有 metadata）
      // fix75：视频巡检（SP）报告的 API 本身只返回元数据（template/score/summary/employeeName 等），
      //   不返回明细检查项列表——这是慧运营 API 设计，不是我们没抓到。
      //   所以 SP 报告弹窗里没有明细项是正常的，给出明确提示并突出"打开慧运营视频报告"按钮。
      const isVideoNoDetail = (effectivePt === 'SP') && det.raw && det.raw._renderForm === 'flat'
        && !Array.isArray(det.raw.categoryList)
        && !Array.isArray(det.raw.items)
        && !Array.isArray(det.raw.details);
      if(isVideoNoDetail){
        body += `<h4 class="rd-h">报告明细</h4>`;
        body += `<div class="placeholder-box" style="margin-bottom:8px">
          ℹ 视频巡检报告本身不包含逐项明细，仅记录巡检得分、巡检人员、整改状态等元数据。
          如需查看该视频原片、点位截图或具体巡检项，请在慧运营后台的「视频巡检」模块中查看。
        </div>`;
        body += renderReportRaw(det.raw);
        } else {
        body += `<h4 class="rd-h">报告明细</h4>` + renderReportRaw(det.raw);
        }
    }
  }else if(det && det.error){
    body += `<div class="placeholder-box">该报告明细云端暂未抓取到（数据刷新后将自动补齐）。可查看上方基础信息。</div>`;
  }else{
    // fix89：优先按 reportId 直接拉仓库里的单报告小文件（几百 KB，秒开），
    //   不再让用户苦等 170MB 大分片在浏览器里下载完。
    const reArgs = [`'${ridEnc}'`, `'${sidEnc}'`, `'${pt || ''}'`, `'${snEnc}'`, `'${rgEnc}'`, `'${rdEnc}'`, `'${sc}'`, ip];
    body += `<div class="placeholder-box" id="rdLazyBox">正在读取该报告的明细…</div>`;
    (async () => {
      // fix89b：fetch 先行，结束后再找 rdLazyBox（占位框此刻才被 innerHTML 插入页面）
      const cand = [(pt || 'CG') + '_' + rid, 'AI_' + rid, 'SP_' + rid, 'ZJ_' + rid];
      let found = null, foundName = '';
      for(const name of cand){
        try{
          const resp = await fetch(cb(`${DATA_BASE}/details/${encodeURIComponent(name)}.json`));
          if(!resp.ok) continue;
          const j = await resp.json();
          const det = j && j.detail;
          if(det && det.reportId){ found = det; foundName = name; break; }
        }catch(e){ /* 404 或网络失败，试下一个候选 */ }
      }
      if(found){
        if(!reportDetails.details) reportDetails.details = {};
        reportDetails.details[foundName.replace('_', ':')] = found;
        showReportDetail(ridEnc, sidEnc, pt, snEnc, rgEnc, rdEnc, sc, ip);
        return;
      }
      const box = $('rdLazyBox');
      if(!box) return; // 弹窗已被关闭或重开
      // 单文件也没有 → 明细还没随数据一起发布，提示可后台全量加载
      box.innerHTML = `暂无该报告的本地明细（云端本轮未抓到）。<br>
        <button type="button" style="margin-top:12px;padding:8px 22px;background:#186BEB;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer" onclick="this.disabled=true;this.innerText='加载中…';(async()=>{await loadReportDetails();showReportDetail(${reArgs.join(',')});})()">全量加载明细</button>`;
    })();
  }
  // fix53：关联整改单（层级检核-整改单，所有报告类型共用接口）
  const rects = det && det.rectifications;
  if(Array.isArray(rects) && rects.length){
    body += renderRectifications(rects);
  } else if(det && det.rectificationsNote){
    body += `<div class="placeholder-box">该报告的整改单云端暂未抓取到（接口返回量异常或暂无关联整改单）。</div>`;
  }
  $('reportDetailBody').innerHTML = body;
  $('reportDetailTitle').textContent = `${html(sn || '门店')} · 报告详情`;
  // fix76：从区域清单弹窗点「查看报告」时，关掉外层 regionModal 与 unqItemModal
  //   避免两个 modal 同时 active、相互遮挡让用户以为「点了没反应」
  ['regionModal','unqItemModal'].forEach(id=>{ const m = $(id); if(m && m.classList.contains('active')) m.classList.remove('active'); if(m && m.style && m.style.display === 'flex') m.style.display = 'none'; });
  $('reportDetailModal').classList.add('active');
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
  // 日期输入实时联动：用户改日期时立刻把高亮切到匹配项
  // 「全部数据」只对用户主动点击生效，手动改日期时不主动点亮
  ['startDate','endDate'].forEach(id=>{
    const el = $(id);
    if(!el) return;
    el.addEventListener('change', ()=>{
      clearQuickRangeButtons();
      syncActiveRangeButton();
    });
  });
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
// 用户点击「上月数据 / 本月数据 / 全部数据」：写回输入框 → 应用 → 高亮按钮
function applyQuickRange(which){
  let r;
  if(which === 'thisMonth') r = rangeOfThisMonth();
  else if(which === 'lastMonth') r = rangeOfLastMonth();
  else if(which === 'all'){
    // 全部数据：走 data.json（预生成快照，包含门店数 7/46/341 基线 + 区间汇总）
    ['rangeThisMonthBtn','rangeLastMonthBtn'].forEach(id=>{ const el=$(id); if(el) el.classList.remove('active'); });
    const btn = $('rangeAllBtn'); if(btn) btn.classList.add('active');
    if(typeof loadData === 'function'){
      $('loading').style.display = 'block';
      hideRangeBanner();
      loadData(false).then(()=>{ $('loading').style.display = 'none'; });
    }
    return;
  }
  else return;
  // 与 SYSTEM_START_DATE 兜底：上个月早于系统上线日时，把开始日夹到系统上线日
  if(r.start < SYSTEM_START_DATE) r.start = SYSTEM_START_DATE;
  $('startDate').value = r.start;
  $('endDate').value = r.end;
  $('rangeThisMonthBtn').classList.toggle('active', which === 'thisMonth');
  $('rangeLastMonthBtn').classList.toggle('active', which === 'lastMonth');
  const btnAll = $('rangeAllBtn'); if(btnAll) btnAll.classList.remove('active');
  // 复用手写应用流程（校验、currentStart 更新、renderAll、提示条都一套搞定）
  applyDateRange();
}
// 点「应用」或手动改日期时，先把 3 个快捷按钮全清掉，再按当前日期重新高亮匹配的那个
const QUICK_RANGE_BTNS = ['rangeThisMonthBtn','rangeLastMonthBtn','rangeAllBtn'];
function clearQuickRangeButtons(){
  QUICK_RANGE_BTNS.forEach(id=>{
    const el = $(id);
    if(el) el.classList.remove('active');
  });
}
// 按当前 start/end 反推应该高亮哪个快捷按钮：精确匹配「本月」或「上月」则点亮，其余不点
// （「全部数据」只在用户主动点击时才点亮，这里不去主动判定）
function syncActiveRangeButton(){
  const s = $('startDate').value;
  const e = $('endDate').value;
  if(!s || !e) return;
  const tm = rangeOfThisMonth();
  if(s === tm.start && e === tm.end){
    const b = $('rangeThisMonthBtn'); if(b) b.classList.add('active');
    return;
  }
  const lm = rangeOfLastMonth();
  if(s === lm.start && e === lm.end){
    const b = $('rangeLastMonthBtn'); if(b) b.classList.add('active');
    return;
  }
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
  // fix87 + fixGitSync：优先使用 publishedAt（与 Git 提交时间一致），其次 refreshCompletedAt；旧快照才回退到 cachedAt/generatedAt。
  // reportDetailsGeneratedAt 仅代表明细文件写入时间，不能代表整轮报表已完成。
  const at = toBeijing(reportRefreshCompletedAt)
    || toBeijing(appData && appData.publishedAt)
    || toBeijing(appData && appData.refreshCompletedAt)
    || toBeijing(appData && appData.generatedAt)
    || toBeijing(reportDetailsGeneratedAt);
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
    // fix10：boot() 路径走的是 preloadAllRawMonths + tryAggregateRange，
    // 完全不调 loadData —— 上一次/几个月一次的"基线快照"就此永远是空对象，
    // 导致 7/46/341 的门店数全被 aggregateRange 重算成"区间内有报告的门店数"（46/18/90）。
    // 这里发现 baseline 是空，立刻 fetch 一次 data.json 把基线填回来。
    if(!window.__STATIC_BASELINE__ || !(window.__STATIC_BASELINE__.positions||[]).length){
      try{
        const r = await fetch(cb(`${DATA_BASE}/data.json`), {cache:'no-store'});
        const j = await r.json();
        if(j && j.success && j.data){
          window.__STATIC_BASELINE__ = {
            positions: (j.data.positions || []).map(p => ({ position: p.position, storeCount: p.storeCount })),
            regions:   (j.data.regions   || []).map(r => ({ region:   r.region,   storeCount: r.storeCount })),
            totalStores: j.data.totalStores,
          };
        }
      }catch(_){ /* fetch 失败就交给下面的空 baseline 兜底 */ }
    }
    // fix9：在调用 aggregateRange 之前，先抓一份 data.json 的"门店数基线"快照
    // （组织树门店数，已剔测试门店）。aggregateRange 按区间重算时会把
    // positions[].storeCount / totalStores / regions[].storeCount 都重算成
    // "区间内有报告的门店数"，这跟"门店数=组织树门店数"的口径不一致。
    // 这里在聚合完之后，把这三个字段强制还原成 data.json 基线，保证：
    //   - 门店数永远 = 组织树门店数（7 / 46 / 341，跨期恒定）
    //   - 已巡检 / 平均分 / 不合格率 按所选区间实时聚合（来自 raw）
    const baseline = window.__STATIC_BASELINE__ || { positions: [], regions: [], totalStores: null };
    const data = await aggregateRange(s, e);
    // 把聚合结果里所有"storeCount"强制还原为 data.json 口径
    if(data){
      const posMap = {}; (baseline.positions || []).forEach(b => { posMap[b.position] = b.storeCount; });
      (data.positions || []).forEach(p => {
        if(posMap[p.position] != null) p.storeCount = posMap[p.position];
      });
      const regMap = {}; (baseline.regions || []).forEach(b => { regMap[b.region] = b.storeCount; });
      (data.regions || []).forEach(r => {
        if(regMap[r.region] != null) r.storeCount = regMap[r.region];
      });
      if(baseline.totalStores != null) data.totalStores = baseline.totalStores;
    }
    appData = await applyAiReportDateRange(data, s, e);
    renderAll();
    showRangeBanner(s, e, appData._partialMonths, appData._rawMonths);
    // fix70：右上角时间用 reportDetails.json 的 generatedAt（双击 .bat 后即时更新）
    const rdAt = reportDetailsGeneratedAt ? toBeijing(reportDetailsGeneratedAt) : null;
    const at = rdAt || toBeijing(data.generatedAt);
    setStatus(at ? `报表刷新于 ${at}` : '数据已加载', '');
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
  // 不管成功失败都同步一次快捷按钮高亮：日期若恰好等于本月/上月区间，按钮要亮
  // （失败时只更新高亮，banner 错误提示由 tryAggregateRange 内部显示）
  syncActiveRangeButton();
  if(!ok){
    // tryAggregateRange 内部已经显示了具体错误，保留用户输入
    // 不再走 loadData fallback（否则会覆盖用户选的区间显示成全季度快照）
    return;
  }
}

// fix97：AI 报告列表（带 reportDate）由批抓端写入 data/aiReports.json，
// 让 AI 慧检板块真正按所选区间过滤（此前 fix95 只能回退全量快照）。
let __aiReportsCache = null;
async function loadAiReportsList(){
  if(__aiReportsCache) return __aiReportsCache;
  try{
    const r = await fetch(cb(`${DATA_BASE}/aiReports.json`), {cache:'no-store'});
    __aiReportsCache = r.ok ? ((await r.json()).reports || []) : [];
  }catch(e){ __aiReportsCache = []; }
  return __aiReportsCache;
}

// fix87：AI 慧检必须服从页面当前日期区间。
// AI 接口汇总快照是“最新一条/店”，不能直接拿来展示 9 月页面里的 8 月报告；
// 这里用 aiReports.json（含日期的 AI 报告列表）+ 已加载的 AI:reportId 明细
// 按 reportDate 过滤，并按门店保留区间内最新一份。
async function applyAiReportDateRange(data, start, end){
  if(!data || !data.aiInspection || !start || !end) return data;
  const rdMap = (reportDetails && reportDetails.details) ? reportDetails.details : reportDetails;
  const baseAi = data.aiInspection;
  // fix97：合并 aiReports.json（带日期的 AI 报告列表）到扫描集。
  // 它是弹窗明细之外唯一带 reportDate 的 AI 数据源，保证区间过滤有数据可用。
  const aiList = await loadAiReportsList();
  const aiRows = {};
  (aiList || []).forEach(r=>{
    if(r && r.reportId) aiRows['AI:' + r.reportId] = {
      reportId: r.reportId, reportDate: r.reportDate,
      storeCode: r.storeCode, storeName: r.storeName,
      raw: { reportTime: r.reportDate, storeCode: r.storeCode, storeName: r.storeName,
             score: r.score, isPass: r.isPass, taskName: r.taskName },
    };
  });
  const merged = Object.assign({}, aiRows, (rdMap && typeof rdMap === 'object') ? rdMap : {});
  const baseStores = (baseAi.stores || baseAi.rankStores || []).slice();
  const metaByCode = {};
  const metaByName = {};
  // 先使用常规巡检组织树中的真实岗位/区域。AI baseline 的旧快照曾把 storeName
  // 填进 region，不能让这个错误字段覆盖真实组织归属。
  const addMeta = s=>{
    if(!s || typeof s !== 'object') return;
    const code = String(s.storeCode || '');
    const name = String(s.storeName || '');
    const hasOrg = !!(s.position || s.region);
    if(code && hasOrg && !metaByCode[code]) metaByCode[code] = s;
    if(name && hasOrg && !metaByName[name]) metaByName[name] = s;
  };
  (data.stores || []).forEach(addMeta);
  (data.regions || []).forEach(r=>(r.stores || []).forEach(addMeta));
  baseStores.forEach(addMeta);
  // 兼容聚合后的 regions.stores，但只接收有真实组织字段的记录。
  (baseAi.regions || []).forEach(r=>(r.stores || []).forEach(s=>{
    const x = {...s, position:s.position || r.position, region:s.region || r.region};
    addMeta(x);
  }));
  const latest = {};
  Object.entries(merged).forEach(([key, entry])=>{
    if(!key.startsWith('AI:') || !entry) return;
    const raw = entry.raw || {};
    const date = String(entry.reportDate || raw.reportTime || '').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || date > end) return;
    const code = String(entry.storeCode || raw.storeCode || '');
    const name = String(entry.storeName || raw.storeName || '');
    const meta = (code && metaByCode[code]) || (name && metaByName[name]);
    if(!meta) return;
    const old = latest[code || name];
    if(old && String(old._date || '') >= date) return;
    const r0 = entry.raw || {};
    const inRangeScore = (r0.score != null ? Number(r0.score) : (Number(entry.score) || null));
    const inRangePass = (r0.isPass != null ? r0.isPass : (entry.isPass != null ? entry.isPass : null));
    latest[code || name] = {
      ...meta,
      storeCode: code || meta.storeCode,
      storeName: name || meta.storeName,
      reportId: entry.reportId || r0.reportId || meta.reportId || '',
      _date: date,
      reportDate: date,
      // fix97：用区间内那份报告自己的得分/结论，不沿用快照里的旧分数
      score: inRangeScore != null && !isNaN(inRangeScore) ? inRangeScore : meta.score,
      isPass: inRangePass != null ? inRangePass : meta.isPass,
    };
  });
  // 没有明细日期时不悄悄混入旧快照，直接显示当前区间无 AI 报告。
  // fix95：fix89 后明细改为按需加载，details 里通常没有 AI 数据 → 筛选恒为空 → 板块「无数据」。
  // 改为：筛选为空时回退显示 baseline 快照（AI 本就是"每店最新一份"快照），并如实标注。
  const stores = Object.values(latest);
  if (!stores.length) {
    data.aiInspection = {...baseAi,
      _rangeNote:`AI 慧检显示最新快照（逐份报告日期未随明细发布，无法按 ${start} ~ ${end} 精确筛选）`};
    return data;
  }
  const regionMap = {};
  stores.forEach(s=>{
    const pos = s.position || '未分配组别';
    const reg = s.region || pos;
    const key = pos + '||' + reg;
    const r = regionMap[key] || (regionMap[key] = {region:reg, position:pos, stores:[]});
    r.stores.push(s);
  });
  const oldRegions = baseAi.regions || [];
  const oldRegionMap = {}; oldRegions.forEach(r=>{ oldRegionMap[r.position+'||'+r.region] = r; });
  const regions = Object.values(regionMap).map(r=>{
    const old = oldRegionMap[r.position+'||'+r.region] || {};
    const passed = r.stores.filter(s=>s.isPass || Number(s.score) >= 10).length;
    const avg = r.stores.length ? Math.round(r.stores.reduce((a,s)=>a+(Number(s.score)||0),0)/r.stores.length*100)/100 : 0;
    return {...old, region:r.region, position:r.position, stores:r.stores,
      inspectedCount:r.stores.length, avgScore:avg,
      qualifiedRate: Math.round(passed/r.stores.length*1000)/10,
      submitRate: old.storeCount ? Math.round(r.stores.length/old.storeCount*1000)/10 : 0,
      unqualifiedItems:r.stores.length-passed, hasData:true};
  }).sort((a,b)=>(b.avgScore||0)-(a.avgScore||0));
  const posMap = {};
  regions.forEach(r=>{
    const p = posMap[r.position] || (posMap[r.position] = {position:r.position, storeCount:0, inspectedCount:0, avgScore:0, _sum:0, _n:0, regions:[]});
    p.storeCount = Math.max(p.storeCount, Number(r.storeCount)||0);
    p.inspectedCount += r.inspectedCount || 0; p._sum += (r.avgScore||0)*(r.inspectedCount||0); p._n += r.inspectedCount||0;
    p.regions.push(r.region);
  });
  const positions = Object.values(posMap).map(p=>({...p, avgScore:p._n?Math.round(p._sum/p._n*100)/100:0}));
  positions.forEach(p=>{delete p._sum; delete p._n;});
  const allStores = stores.map(s=>({...s, planType:'AI'}));
  data.aiInspection = {...baseAi, positions, regions, stores:allStores, rankStores:allStores.slice().sort((a,b)=>(b.score||0)-(a.score||0)), totalInspected:allStores.length,
    _rangeNote:`AI 慧检已按所选区间 ${start} ~ ${end} 筛选`};
  return data;
}

// fix53：报告明细（免登录查看）独立加载，boot 走聚合路径或 loadData 两条路都会调用
async function loadReportDetails(){
  try{
    const bufs = [];
    for(let i = 1; i <= REPORT_DETAILS_PARTS; i++){
      // 明细分片内容不可变，走浏览器 HTTP 缓存，二次打开不再全量重下 236MB
      const pr = await fetch(cb(`${DATA_BASE}/reportDetails.part${i}.json`));
      bufs.push(await pr.arrayBuffer());
    }
    const rdJson = JSON.parse(await new Blob(bufs).text());
    reportDetails = (rdJson && rdJson.details) || {};
    // 兼容旧缓存：明细生成时间只能作为兜底，不能覆盖整轮刷新完成时间。
    if(rdJson && rdJson.generatedAt){
      reportDetailsGeneratedAt = rdJson.generatedAt;
    }
  }catch(e){ reportDetails = {}; }
  // fix87：单独读取刷新凭证。它由整轮数据生成的最后一步写入，是真实完成时间。
  try{
    const rfResp = await fetch(cb(`${DATA_BASE}/refresh.json`), {cache:'no-store'});
    const rfJson = await rfResp.json();
    if(rfJson && rfJson.refreshCompletedAt){
      reportRefreshCompletedAt = rfJson.refreshCompletedAt;
    }
  }catch(e){ /* 旧数据没有 refresh.json 时使用 data.json 兼容字段 */ }
  // 报告明细加载完成后，重新按当前日期区间裁剪 AI，避免 boot 先聚合、后加载明细导致仍显示旧月份。
  if(appData && currentStart && currentEnd){
    appData = await applyAiReportDateRange(appData, currentStart, currentEnd);
    renderAll();
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
    appData = await applyAiReportDateRange(json.data, currentStart, currentEnd);
    if(appData && appData.webBase){
      HYY_WEB_BASE = appData.webBase;
    }
    // fix53：报告明细（免登录查看），独立于主数据加载，失败不影响主看板
    // fix89：明细已拆为单报告小文件（data/details/），弹窗按需取，不再后台全量下载 170MB
    // loadReportDetails();
    // fix8：门店数等组别字段一律直接读 d.positions[i]（data.json Actions 每日生成，已排除测试门店），
    // 时点恒定、跨月份一致。不再写 window.__BASELINE_STORE_COUNT__ 兜底变量（renderPositions 已照搬 V1）。
    // fix9：存一份"门店数基线"快照给 tryAggregateRange 用，
    // 避免按区间重算后把 positions/regions/totalStores 的 storeCount 算成"区间内有报告的门店数"
    window.__STATIC_BASELINE__ = {
      positions: ((appData && appData.positions) || []).map(p => ({ position: p.position, storeCount: p.storeCount })),
      regions:   ((appData && appData.regions)   || []).map(r => ({ region: r.region, storeCount: r.storeCount })),
      totalStores: appData && appData.totalStores,
    };
    // 记录静态数据的固定区间，供 applyDateRange 提示用户
    window.__STATIC_BUILD_RANGE__ = {
      start: appData.startDate || currentStart,
      end: appData.endDate || currentEnd,
      at: toBeijing(reportRefreshCompletedAt)
        || toBeijing(json.publishedAt)
        || toBeijing(json.refreshCompletedAt)
        || toBeijing(json.cachedAt)
        || toBeijing(appData.publishedAt)
        || toBeijing(appData.generatedAt)
        || '-',
    };
    // 主数据刷新后，区域排名浏览器缓存一并失效，避免慧运营新增报告后仍显示旧数字
    regionRankData = {all:{}, regular:{}, self:{}, video:{}};
    renderAll();
    const refreshAt = toBeijing(reportRefreshCompletedAt)
      || toBeijing(json.publishedAt)
      || toBeijing(json.refreshCompletedAt)
      || toBeijing(json.cachedAt)
      || toBeijing(appData.publishedAt)
      || toBeijing(appData.generatedAt);
    setStatus(refreshAt ? '报表刷新于 ' + refreshAt : '数据已加载', '');
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
  renderAiInspection(d);
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
  renderUnqSnapshotBar();  // fix49：刷新快照区间提示条
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

/* ---------- 不合格明细照片按需加载 ----------
   fix28：照片改为静态化——采集端（fetch_data.py）把每个问题项的现场照片
   下载地址写进 unqualified.json 的 itemPhotos 字段，前端直接读，不再调后端。 */
function itemPhotoUrls(contentId){
  if(!contentId || !unqData || !unqData.itemPhotos) return [];
  return unqData.itemPhotos[String(contentId)] || [];
}

async function loadItemPhoto(contentId){
  if(!contentId) return '';
  if(unqPhotoCache[contentId] === '') return '';
  if(unqPhotoCache[contentId]) return unqPhotoCache[contentId];
  const urls = itemPhotoUrls(contentId);
  const u = urls[0] || '';
  unqPhotoCache[contentId] = u;
  return u;
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
    if(cached){
      img.src = cached;
      img.classList.remove('loading');
      img.classList.remove('no-photo');
      // 加载失败 fallback
      img.onerror = ()=>{
        img.onerror = null;
        img.classList.add('no-photo');
        img.removeAttribute('onclick');
        img.alt = '图片加载失败';
        // 用 placeholder 盖住
        if(!img.nextElementSibling || !img.nextElementSibling.classList.contains('unq-img-placeholder')){
          const ph = document.createElement('div');
          ph.className = 'unq-img-placeholder';
          ph.innerHTML = '🖼️<br>图片加载失败';
          img.parentNode.insertBefore(ph, img.nextSibling);
          img.style.opacity = '0';
        }
      };
      return;
    }
    loadItemPhoto(cid).then(url=>{
      if(url){
        img.src = url;
        img.classList.remove('loading');
      } else {
        img.classList.remove('loading');
        img.classList.add('no-photo');
        img.alt = '暂无照片';
        img.removeAttribute('onclick');
        // 用 placeholder 盖住
        if(!img.nextElementSibling || !img.nextElementSibling.classList.contains('unq-img-placeholder')){
          const ph = document.createElement('div');
          ph.className = 'unq-img-placeholder';
          ph.innerHTML = '📷<br>暂无照片';
          img.parentNode.insertBefore(ph, img.nextSibling);
          img.style.opacity = '0';
        }
      }
    });
  });
}

function unqItemImg(cid, cls='unq-item-img'){
  if(!cid) return '';
  return `<img class="${cls} loading" data-photo-cid="${cid}" data-photo-title="${html(itemPhotoTitle(cid)||'')}" referrerpolicy="no-referrer" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="加载中" onclick="openUnqLightbox(this)">`;
}

// fix49：通过 contentId 反查问题项的标题，用于灯箱底部 caption
function itemPhotoTitle(cid){
  if(!cid || !unqData) return '';
  const cidNum = Number(cid);
  const byItem = unqData.byItem || [];
  for(const i of byItem){
    if(Number(i.contentId) === cidNum) return i.title || '';
  }
  return '';
}

// fix49：图片灯箱
function openUnqLightbox(imgEl){
  if(!imgEl || !imgEl.src || imgEl.classList.contains('no-photo')) return;
  const lb = $('unqLightbox');
  const lbImg = $('unqLightboxImg');
  const lbCap = $('unqLightboxCaption');
  if(!lb || !lbImg) return;
  lbImg.src = imgEl.src;
  lbCap.textContent = imgEl.dataset.photoTitle || '';
  lb.classList.add('show');
}
function closeUnqLightbox(ev){
  if(ev && ev.target && ev.target.tagName === 'IMG') return; // 点击图片本身不关闭
  const lb = $('unqLightbox');
  if(!lb) return;
  lb.classList.remove('show');
  const lbImg = $('unqLightboxImg');
  if(lbImg) lbImg.src = '';
}

// fix49：快照区间提示条——把"快照范围"和当前选择区间的不一致亮出来
function renderUnqSnapshotBar(){
  const el = $('unqSnapshotBar');
  if(!el || !unqData) return;
  const snapStart = unqData.startDate || '';
  const snapEnd = unqData.endDate || '';
  const cachedAt = unqLoadedAt || '';
  const userStart = currentStart || '';
  const userEnd = currentEnd || '';
  const mismatch = userStart && userEnd && (snapStart !== userStart || snapEnd !== userEnd);
  el.innerHTML = `
    <span class="badge">快照区间 ${snapStart} ~ ${snapEnd}</span>
    <span>（每日凌晨 01:00 自动更新；最新抓取 ${cachedAt || '-'}）</span>
    ${mismatch ? `<span style="margin-left:auto">⚠️ 与右上角当前选择 (${userStart} ~ ${userEnd}) 不一致——本面板展示的是定时快照，不受日期切换影响</span>` : ''}
  `;
  el.className = 'unq-snapshot-bar' + (mismatch ? ' warn' : '');
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
    // fix77：视频巡检数据源 videoInspection.stores 是企业级汇总，本面板未单独维护该视图。
    //   给一个明确引导，免得用户以为"数据没了"。
    if(unqStoreType === 'video' && src.length === 0){
      el.innerHTML = `<div class="empty" style="padding:60px 16px;text-align:center">
        <div style="font-size:14px;color:#666;margin-bottom:6px">视频巡检门店明细在本面板暂未单独汇总，</div>
        <div style="font-size:13px;color:#888">请到上方「视频巡检」主面板查看各区域视频巡检门店详情。</div>
      </div>`;
      return;
    }
    // fix77：全部类型无数据时提供重试入口
    if(unqStoreType === 'all' && src.length === 0){
      el.innerHTML = `<div class="empty" style="padding:40px 16px;text-align:center">
        <div style="font-size:14px;color:#666;margin-bottom:6px">全部类型门店汇总尚未生成。</div>
        <button type="button" style="display:inline-block;padding:6px 14px;background:#186BEB;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;margin-top:4px" onclick="unqData=null;loadUnqualified()">点此重新加载</button>
      </div>`;
      return;
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
          ${unqStoreType === 'video' ? (s.reportId ? reportLink(s, '查看报告', 'SP') : '<span style="color:#999">暂无视频报告编号</span>') : reportLink(s, '查看报告', s.planType || planTypeForLink)}
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
    <thead><tr><th>门店</th><th>组别</th><th>得分</th><th>报告</th></tr></thead>
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
    const label = p==='__all__' ? '全部组别' : p;
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
    <thead><tr><th>门店</th><th>组别</th><th>高发问题</th></tr></thead>
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
    const label = p==='__all__' ? '全部组别' : p;
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
    <table class="rank"><thead><tr><th>门店</th><th>区域</th><th>组别</th><th>出现次数</th></tr></thead><tbody>${storeRows || '<tr><td colspan="4" class="empty">无明细</td></tr>'}</tbody></table>
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
    // fix28：改为读静态数据——门店清单来自 itemStoreMap，照片来自 itemPhotos（均由采集端写入 unqualified.json）
    const stores = (unqData.itemStoreMap || {})[contentId] || [];
    const storeRows = (stores||[]).map(s=>`<tr><td>${html(s.store)}</td><td>${html(s.region||'')}</td><td>${s.count}</td></tr>`).join('');
    const photos = itemPhotoUrls(contentId).map(u=>({url:u}));
    const photoRows = photos.map(p=>`<img src="${html(p.url)}" referrerpolicy="no-referrer" style="width:100%;max-width:140px;height:120px;object-fit:cover;border-radius:6px;cursor:pointer" onclick="window.open('${html(p.url)}','_blank')">`).join('');
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
    <div class="card"><div class="card-h"><span class="scope-tag scope-cg">常规巡检（QSC）</span>覆盖门店总数</div><div class="card-v">${d.totalStores}</div><div class="card-sub">四个组别组织树门店数之和</div></div>
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
  // fix8：完全照搬 V1（原版根目录）做法——直接读 d.positions[i] 的所有字段，
  // 不再用 storePool 按区间实时聚合、不再用 baseline 兜底。
  // data.json 由 Actions 每日生成（含已排除测试门店的组织树门店数），
  // 这是时点恒定值，跨月份都是同一个"应覆盖门店数"，与 V1 完全一致。
  $('overviewPositions').innerHTML = (d.positions || []).map(p=>`
    <div class="pos-card">
      <div class="pos-title">${html(p.position)}<span class="scope-tag scope-cg">常规巡检（QSC）</span></div>
      <div class="pos-subtitle">常规巡检（QSC）汇总 · 不含门店自检 / 视频巡检</div>
      <div class="pos-meta">
        <div><span class="pv">${p.storeCount || 0}</span><span class="pl">门店数</span></div>
        <div><span class="pv">${p.inspectedCount || 0}</span><span class="pl">已巡检</span></div>
        <div><span class="pv">${p.submitRate != null ? p.submitRate : 0}%</span><span class="pl">完成率</span></div>
        <div><span class="pv">${p.avgScore || '0.0'}</span><span class="pl">平均分</span></div>
        <div><span class="pv">${p.unqualifiedItems || 0}</span><span class="pl">不合格项</span></div>
        <div><span class="pv">${p.qualifiedRate != null ? p.qualifiedRate : 0}%</span><span class="pl">合格率</span></div>
        <div><span class="pv">${(p.regions || []).length}</span><span class="pl">区域数</span></div>
      </div>
      <div class="reg-tags">${(p.regions || []).map(r=>`<span class="reg-tag">${html(r)}</span>`).join('')}</div>
    </div>
  `).join('');
}


function buildPosFilter(containerId, onChange){
  const d = appData;
  const positions = ['__all__'].concat(d.positions.map(p=>p.position));
  const labels = {'__all__':'全部组别'};
  d.positions.forEach(p=>labels[p.position]=p.position);
  const el = $(containerId);
  if(!el) return;
  el.innerHTML = positions.map(pos=>`
    <button class="fbtn ${pos===activePosFilter?'active':''}" data-pos="${html(pos)}">${html(labels[pos])}</button>
  `).join('');
  el.querySelectorAll('.fbtn').forEach(btn=>{
    btn.onclick = ()=>{
      activePosFilter = btn.dataset.pos;
      // fix48：换组别时，重置三个面板内的"区域二级筛选"（旧组别下的区域选择对新组别无意义）
      selfRankRegionFilter = '__all__';
      regularRankRegionFilter = '__all__';
      videoRankRegionFilter = '__all__';
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

// fix48：门店分数排名内的「组别 → 区域」二级 chip。
// regions 是 string[]（当前选中组别下出现过的所有区域）。
function buildRankRegionFilter(containerId, regions, currentSel, onChange){
  const el = $(containerId);
  if(!el) return;
  const list = ['__all__'].concat(regions || []);
  el.innerHTML = list.map(reg=>{
    const label = reg === '__all__' ? '全部区域' : reg;
    return `<button class="fbtn rank-region-fbtn ${reg===currentSel?'active':''}" data-region="${html(reg)}">${html(label)}</button>`;
  }).join('');
  el.querySelectorAll('.rank-region-fbtn').forEach(btn=>{
    btn.onclick = ()=>{
      onChange(btn.dataset.region);
    };
  });
}

// fix48：取当前选中组别下的所有区域（来自 appData.positions.regions）
function regionsForActivePos(){
  if(activePosFilter === '__all__') return [];
  const pos = (appData.positions || []).find(p => p.position === activePosFilter);
  return (pos && pos.regions) || [];
}

function renderSelfInspection(d){
  const self = d.selfInspection || {};

  // 1. 区域汇总
  buildPosFilter('selfRegionPosFilter', ()=>renderSelfInspection(d));
  const regionItems = filterByPos(self.regions || []);
  const rsearch = ($('selfRegionSearch').value||'').trim().toLowerCase();
  // fix38：按区域平均分降序，无平均分（-）排最后；同分按区域名兜底
  const rfiltered = regionItems
    .map(r=>{
      const hasScore = r.avgScore != null && r.avgScore > 0;
      return {r, hasScore, score: hasScore ? r.avgScore : -1};
    })
    .filter(x=>
      (x.r.region||'').toLowerCase().includes(rsearch) ||
      (x.r.position||'').toLowerCase().includes(rsearch)
    )
    .sort((a,b)=>{
      if(a.hasScore !== b.hasScore) return a.hasScore ? -1 : 1;
      if(a.hasScore) return b.score - a.score;
      return String(a.r.region||'').localeCompare(String(b.r.region||''),'zh');
    });
  $('selfRegionTable').innerHTML = `
    <thead><tr>
      <th>区域</th><th>组别</th><th>门店数</th>
      <th>应完成自检数</th><th>已完成</th>
      <th>合格份数</th><th>区域平均分</th>
      <th>完成率</th><th>点评率</th><th>合格率</th><th>整改率</th>
      <th>门店清单</th>
    </tr></thead>
    <tbody>
      ${rfiltered.map(({r, hasScore})=>{
        const qTotal = (r.qualified||0) + (r.unqualified||0);
        const qRate = qTotal > 0 ? (r.qualified||0) / qTotal : 0;
        // 完成率 = 已完成 / 应完成（沿用系统口径，跟 V1 完全一致）
        const completionRate = r.completionRate != null
          ? r.completionRate
          : (r.expected > 0 ? Math.round((r.completed||0) / r.expected * 1000) / 10 : 0);
        // fix36：区域平均分 = 该区域有得分的门店各自平均分的平均（aggregate.js 已算）
        const regionAvg = (r.avgScore != null && r.avgScore > 0) ? r.avgScore : '-';
        const regionAvgCls = (regionAvg !== '-') ? scoreClass(regionAvg) : '';
        return `
        <tr>
          <td>${html(r.region||'-')}</td>
          <td>${html(r.position||'-')}</td>
          <td>${r.storeCount || 0}</td>
          <td>${r.expected != null ? r.expected : '-'}</td>
          <td>${r.completed != null ? r.completed : 0}</td>
          <td>${r.qualified || 0}</td>
          <td class="${regionAvgCls}">${regionAvg}</td>
          <td class="${rateClass(completionRate)}">${completionRate != null ? completionRate : 0}%</td>
          <td class="${rateClass(r.reviewRate)}">${r.reviewRate != null ? r.reviewRate : 0}%</td>
          <td class="${rateClass(qRate*100)}">${qTotal > 0 ? Math.round(qRate * 1000) / 10 + '%' : '-'}</td>
          <td class="${rateClass(r.rectifyRate)}">${(r.rectified != null && (r.rectified + (r.needRectify||0)) > 0) ? r.rectifyRate + '%' : '-'}</td>
          <td><span class="link-btn" onclick="showSelfRegionStores('${encodeURIComponent(r.region||'')}', '${encodeURIComponent(r.position||'')}')">查看门店 &gt;</span></td>
        </tr>`;
      }).join('')}
      ${rfiltered.length===0?'<tr><td colspan="12" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 2. 组别组织（四张组别大卡）
  renderPositionCards('self', d);

  // 4. 门店分数排名及明细
  buildPosFilter('selfStoreRankPosFilter', ()=>renderSelfInspection(d));
  // fix48：组别已选时，渲染"区域二级 chip"；未选组别则不显示二级目录
  if(activePosFilter !== '__all__'){
    buildRankRegionFilter('selfStoreRankRegionFilter', regionsForActivePos(), selfRankRegionFilter, reg=>{
      selfRankRegionFilter = reg;
      renderSelfInspection(d);
    });
  } else {
    const _rfc = $('selfStoreRankRegionFilter'); if(_rfc) _rfc.innerHTML = '';
  }
  const rankSearch = ($('selfStoreRankSearch').value||'').trim().toLowerCase();
  const rankItems = filterByPos(self.rankStores || [])
    .filter(s=>s.avgScore>0)
    .filter(s => selfRankRegionFilter==='__all__' || s.region===selfRankRegionFilter)
    .filter(s=>(s.storeName||'').toLowerCase().includes(rankSearch))
    .sort((a,b)=> b.avgScore - a.avgScore);
  $('selfStoreRankTable').innerHTML = `
    <thead><tr><th>排名</th><th>门店</th><th>组别</th><th>区域</th><th>每日自检平均分</th><th>已点评次数</th><th>自检报告</th></tr></thead>
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
            <td>${
              (s.reports && s.reports.length)
                ? `<span class="link-btn" onclick="showStoreSelfReports('${encodeURIComponent(s.storeName||'')}', '${encodeURIComponent(s.position||'')}', '${encodeURIComponent(s.region||'')}')">查看报告(${s.reports.length})</span>`
                : '<span style="color:#999">无报告</span>'
            }</td>
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
  // fix52：区域汇总按平均分降序，无平均分排最后（与门店自检一致）
  const filtered = items
    .map(r=>({ r, hasScore: (r.avgScore!=null && r.avgScore>0), score: (r.avgScore!=null && r.avgScore>0) ? r.avgScore : -1 }))
    .filter(x=>
      (x.r.region||'').toLowerCase().includes(search) ||
      (x.r.position||'').toLowerCase().includes(search)
    )
    .sort((a,b)=>{
      if(a.hasScore !== b.hasScore) return a.hasScore ? -1 : 1;
      if(a.hasScore) return b.score - a.score;
      return String(a.r.region||'').localeCompare(String(a.r.region||''),'zh');
    })
    .map(x=>x.r);
  $('regionTable').innerHTML = `
    <thead><tr>
      <th>区域</th><th>组别</th><th>门店数</th><th>已巡检</th><th>完成率</th><th>平均分</th>
      <th>巡检项合格率</th>
      <th>应整改</th><th>已整改</th><th>未整改</th><th>整改率</th>
      <th>门店清单</th>
    </tr></thead>
    <tbody>
      ${filtered.map(r=>{
        // fix59：「应整改」= 累计应修（含已修）= 待修 + 已修，与整效率分母一致；
        //       「未整改」= 当前仍待修 = needRectify（仅未修部分）。
        const rectTotal = (r.needRectify||0) + (r.rectified||0);
        const rectRate = rectTotal > 0 ? Math.round((r.rectified||0) / rectTotal * 1000) / 10 : 0;
        const unrectified = Math.max(0, (r.needRectify||0) - (r.rectified||0));
        return `
        <tr>
          <td>${html(r.region)}</td>
          <td>${html(r.position)}</td>
          <td>${r.storeCount}</td>
          <td>${r.inspectedCount}</td>
          <td class="${rateClass(r.submitRate)}">${r.submitRate != null ? r.submitRate : 0}%</td>
          <td class="${scoreClass(r.avgScore)}">${r.avgScore || '-'}</td>
          <td class="${rateClass(r.qualifiedRate)}">${r.qualifiedRate != null ? r.qualifiedRate : 0}%</td>
          <td>${rectTotal}</td>
          <td>${r.rectified || 0}</td>
          <td>${unrectified}</td>
          <td class="${rateClass(rectRate)}">${rectTotal > 0 ? rectRate + '%' : '-'}</td>
          <td><span class="link-btn" onclick="showRegionStores('${encodeURIComponent(r.region||'')}', '${encodeURIComponent(r.position||'')}')">查看门店 &gt;</span></td>
        </tr>`;
      }).join('')}
      ${filtered.length===0?'<tr><td colspan="12" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 2. 组别组织（四张组别大卡：直营组·培训组 / 新店运营组 / 加盟营运组 / 新店筹建组）
  renderPositionCards('regular', d);

  // 4. 门店分数排名及明细
  buildPosFilter('regularStoreRankPosFilter', ()=>renderRegularInspection(d));
  // fix48：组别已选时，渲染"区域二级 chip"
  if(activePosFilter !== '__all__'){
    buildRankRegionFilter('regularStoreRankRegionFilter', regionsForActivePos(), regularRankRegionFilter, reg=>{
      regularRankRegionFilter = reg;
      renderRegularInspection(d);
    });
  } else {
    const _rfc = $('regularStoreRankRegionFilter'); if(_rfc) _rfc.innerHTML = '';
  }
  const rankSearch = ($('regularStoreRankSearch').value||'').trim().toLowerCase();
  const rankItems = filterByPos(d.stores)
    .filter(s=>s.score>0)
    .filter(s => regularRankRegionFilter==='__all__' || s.region===regularRankRegionFilter)
    .filter(s=>(s.storeName||'').toLowerCase().includes(rankSearch))
    .sort((a,b)=> b.score - a.score);
  $('regularStoreRankTable').innerHTML = `
    <thead><tr><th>排名</th><th>门店</th><th>组别</th><th>区域</th><th>常规巡检（QSC）得分</th><th>报告数</th><th>巡检报告</th></tr></thead>
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

  // fix45：视频巡检补「组别分类」chip（与门店自检 / 常规巡检一致）
  buildPosFilter('videoRegionPosFilter', ()=>renderVideoInspection(d));
  buildPosFilter('videoStoreRankPosFilter', ()=>renderVideoInspection(d));

  // 1. 区域汇总
  const rsearch = ($('videoRegionSearch').value||'').trim().toLowerCase();
  // fix52：区域汇总按平均分降序，无平均分排最后（与门店自检一致）
  // fix73：去掉门店数=0 的占位行（如"范鑫区域"、"空间设计"等无门店但出现在 leaves 的占位）
  const rfiltered = filterByPos(video.regions || [])
    .filter(r => rawSafeInt(r.storeCount) > 0)
    .map(r=>({ r, hasScore: (r.avgScore!=null && r.avgScore>0), score: (r.avgScore!=null && r.avgScore>0) ? r.avgScore : -1 }))
    .filter(x=>
      (x.r.region||'').toLowerCase().includes(rsearch) ||
      (x.r.position||'').toLowerCase().includes(rsearch)
    )
    .sort((a,b)=>{
      if(a.hasScore !== b.hasScore) return a.hasScore ? -1 : 1;
      if(a.hasScore) return b.score - a.score;
      return String(a.r.region||'').localeCompare(String(b.r.region||''),'zh');
    })
    .map(x=>x.r);
  $('videoRegionTable').innerHTML = `
    <thead><tr>
      <th>区域</th><th>组别</th><th>门店数</th><th>已巡检</th><th>完成率</th><th>平均分</th>
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
          <td><span class="link-btn" onclick="showVideoRegionStores('${encodeURIComponent(r.region||'')}', '${encodeURIComponent(r.position||'')}')">查看门店 &gt;</span></td>
        </tr>`;
      }).join('')}
      ${rfiltered.length===0?'<tr><td colspan="15" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 2. 组别组织（四张组别大卡：直营组·培训组 / 新店运营组 / 加盟营运组 / 新店筹建组）
  renderPositionCards('video', d);

  // 4. 门店分数排名及明细
  // fix48：组别已选时，渲染"区域二级 chip"
  if(activePosFilter !== '__all__'){
    buildRankRegionFilter('videoStoreRankRegionFilter', regionsForActivePos(), videoRankRegionFilter, reg=>{
      videoRankRegionFilter = reg;
      renderVideoInspection(d);
    });
  } else {
    const _rfc = $('videoStoreRankRegionFilter'); if(_rfc) _rfc.innerHTML = '';
  }
  const vsearch = ($('videoStoreRankSearch').value||'').trim().toLowerCase();
  const vstores = video.stores || video.rankStores || [];
  const vrankItems = filterByPos(vstores)
    .filter(s=>(s.score||0)>0)
    .filter(s => videoRankRegionFilter==='__all__' || s.region===videoRankRegionFilter)
    .filter(s=>(s.storeName||'').toLowerCase().includes(vsearch))
    .sort((a,b)=> (b.score||0) - (a.score||0));
  $('videoStoreRankTable').innerHTML = `
    <thead><tr><th>排名</th><th>门店</th><th>区域</th><th>组别</th><th>视频巡检得分</th><th>巡检报告</th></tr></thead>
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

// fix54：AI 慧检看板（结构照视频巡检，字段以后端 aiInspection 为准）
function showAiRegionStores(region, position){
  region = decodeURIComponent(region || '');
  position = decodeURIComponent(position || '');
  const ai = (appData && appData.aiInspection) || {};
  const rows = (ai.regions || []).filter(r => r.region === region && r.position === position);
  if(!rows.length){
    alert('该区域暂无 AI 慧检门店数据');
    return;
  }
  const regionData = rows[0];
  const stores = regionData.stores || [];
  const total = regionData.storeCount || 0;
  const inspected = stores.length;
  const uninspected = Math.max(0, total - inspected);
  $('regionModalTitle').textContent = `${html(region)} · AI 慧检门店清单`;
  $('regionModalSub').innerHTML =
    `组别：${html(position)}　区域门店总数：<b>${total}</b>　` +
    `已巡检：<b style="color:#1a7f37">${inspected}</b> 家　` +
    `未巡检：<b style="color:#c0392b">${uninspected}</b> 家`;
  const list = stores.slice().sort((a,b)=> (Number(b.score) || 0) - (Number(a.score) || 0));
  $('regionModalTable').innerHTML = `
    <thead><tr><th>门店名称</th><th>AI 巡检得分</th><th>报告</th></tr></thead>
    <tbody>
      ${list.map(s=>{
        const reportCell = (s.reportId)
          ? reportLink({ reportId: s.reportId, signId: s.signId, storeName: s.storeName, region: region, reportDate: s.reportDate, score: s.score, isPass: s.isPass }, '查看报告', 'AI')
          : '<span style="color:#999">无报告</span>';
        return `
        <tr>
          <td>${html(s.storeName)}</td>
          <td class="${scoreClass(s.score)}">${s.score>0?s.score:'-'}</td>
          <td>${reportCell}</td>
        </tr>`;
      }).join('')}
      ${list.length===0?'<tr><td colspan="3" class="empty">该区域暂无 AI 慧检门店</td></tr>':''}
    </tbody>
  `;
  $('regionModal').classList.add('active');
}

function renderAiInspection(d){
  const ai = (d && d.aiInspection) || {};
  buildPosFilter('aiRegionPosFilter', ()=>renderAiInspection(d));
  buildPosFilter('aiStoreRankPosFilter', ()=>renderAiInspection(d));

  // fix54：自定义区间视图下 AI 慧检为企业级报告，显示 baseline 全量并提示未做区间拆分
  const noteEl = $('aiRangeNote');
  if (noteEl) {
    if (ai._rangeNote) {
      noteEl.textContent = ai._rangeNote;
      noteEl.style.display = '';
    } else {
      noteEl.style.display = 'none';
    }
  }

  // 1. 区域汇总（按平均分降序，无分排末）
  const rsearch = ($('aiRegionSearch').value||'').trim().toLowerCase();
  // fix73：去掉门店数=0 的占位行（区域下没门店）
  const rfiltered = filterByPos(ai.regions || [])
    .filter(r => rawSafeInt(r.storeCount) > 0)
    .map(r=>({ r, hasScore: (r.avgScore!=null && r.avgScore>0), score: (r.avgScore!=null && r.avgScore>0) ? r.avgScore : -1 }))
    .filter(x=>
      (x.r.region||'').toLowerCase().includes(rsearch) ||
      (x.r.position||'').toLowerCase().includes(rsearch)
    )
    .sort((a,b)=>{
      if(a.hasScore !== b.hasScore) return a.hasScore ? -1 : 1;
      if(a.hasScore) return b.score - a.score;
      return String(a.r.region||'').localeCompare(String(b.r.region||''),'zh');
    })
    .map(x=>x.r);
  $('aiRegionTable').innerHTML = `
    <thead><tr>
      <th>区域</th><th>组别</th><th>门店数</th><th>已巡检</th><th>完成率</th>
      <th>平均分</th><th>合格率</th><th>门店清单</th>
    </tr></thead>
    <tbody>
      ${rfiltered.map(r=>`
        <tr>
          <td>${html(r.region)}</td>
          <td>${html(r.position)}</td>
          <td>${r.storeCount}</td>
          <td>${r.inspectedCount}</td>
          <td class="${rateClass(r.submitRate)}">${r.submitRate != null ? r.submitRate : 0}%</td>
          <td class="${scoreClass(r.avgScore)}">${r.avgScore || '-'}</td>
          <td class="${rateClass(r.qualifiedRate)}">${r.qualifiedRate != null ? r.qualifiedRate : 0}%</td>
          <td><span class="link-btn" onclick="showAiRegionStores('${encodeURIComponent(r.region||'')}', '${encodeURIComponent(r.position||'')}')">查看门店 &gt;</span></td>
        </tr>`).join('')}
      ${rfiltered.length===0?'<tr><td colspan="8" class="empty">无数据</td></tr>':''}
    </tbody>
  `;

  // 2. 组别汇总
  renderPositionCards('ai', d);

  // 3. 门店分数排名及明细
  const vsearch = ($('aiStoreRankSearch').value||'').trim().toLowerCase();
  const vstores = ai.stores || ai.rankStores || [];
  const vrankItems = filterByPos(vstores)
    .filter(s=>(s.score||0)>0)
    .filter(s=>(s.storeName||'').toLowerCase().includes(vsearch))
    .sort((a,b)=> (b.score||0) - (a.score||0));
  $('aiStoreRankTable').innerHTML = `
    <thead><tr><th>排名</th><th>门店</th><th>区域</th><th>组别</th><th>AI 巡检得分</th><th>巡检报告</th></tr></thead>
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
            <td>${reportLink(s, '查看报告', 'AI')}</td>
          </tr>`;
      }).join('')}
      ${vrankItems.length===0?'<tr><td colspan="6" class="empty">无数据</td></tr>':''}
    </tbody>
  `;
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
      const label = p==='__all__' ? '全部组别' : p;
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

  // 同组别内合并同名巡检项（三个组别可能共用同一套模板）
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
    {k:'position', l:'按组别'}
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
      // 不加面积填充：三条线叠一起时大面积色块会互相遮挡，看不清各组别走势
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
    {k:'position', l:'按组别'}
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
    ? '<th>排名</th><th>区域</th><th>组别</th><th>门店数</th><th>已巡检</th><th>不合格项</th><th>完成率</th><th>合格率</th><th>点评率</th><th>整改率</th><th>区域平均分</th><th>门店分数区间</th>'
    : '<th>排名</th><th>区域</th><th>组别</th><th>门店数</th><th>已巡检</th><th>平均分</th><th>合格率</th><th>整改率</th><th>点评率</th>';
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
    `组别：${html(position)}　区域门店总数：${total}　` +
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

// fix51：视频巡检 · 区域汇总 → 该区域门店清单（与常规/自检一致风格，独立函数读 videoInspection.regions）
function showVideoRegionStores(region, position){
  region = decodeURIComponent(region || '');
  position = decodeURIComponent(position || '');
  const v = (appData && appData.videoInspection) || {};
  const rows = (v.regions || []).filter(r => r.region === region && r.position === position);
  if(!rows.length){
    alert('该区域暂无视频巡检门店数据');
    return;
  }
  const regionData = rows[0];
  const stores = regionData.stores || [];
  const total = regionData.storeCount || 0;
  const inspected = stores.length;
  const uninspected = Math.max(0, total - inspected);
  const monthLabel = v.monthLabel || '本月';

  $('regionModalTitle').textContent = `${html(region)} · 视频巡检门店清单`;
  $('regionModalSub').innerHTML =
    `组别：${html(position)}　区域门店总数：<b>${total}</b>　` +
    `已巡检：<b style="color:#1a7f37">${inspected}</b> 家　` +
    `未巡检：<b style="color:#c0392b">${uninspected}</b> 家` +
    `　<span style="color:#888">（${monthLabel}）</span>`;

  // 得分降序
  const list = stores.slice().sort((a,b)=> (Number(b.score) || 0) - (Number(a.score) || 0));

  $('regionModalTable').innerHTML = `
    <thead><tr>
      <th>门店名称</th><th>视频巡检得分</th><th>巡检项</th><th>合格项</th><th>不合格项</th>
      <th>合格率</th><th>已整改</th><th>逾期</th><th>报告</th>
    </tr></thead>
    <tbody>
      ${list.map(s=>{
        const totalItems  = Number(s.sumCount) || 0;
        const normalItems = (s.normalCount != null) ? (Number(s.normalCount) || 0) : 0;
        const unqItems    = Number(s.unqualifiedItems) || 0;
        const qRate = totalItems > 0 ? Math.round(normalItems / totalItems * 1000) / 10 : 0;
        const rectified = Number(s.rectified) || 0;
        const expired   = (s.expired != null) ? s.expired : '-';
        const reportCell = (s.reportId)
          ? reportLink({ reportId: s.reportId, signId: s.signId, storeName: s.storeName, region: region, reportDate: s.reportDate, score: s.score, isPass: s.isPass }, '查看报告', 'SP')
          : '<span style="color:#999">无报告</span>';
        return `
        <tr>
          <td>${html(s.storeName)}</td>
          <td class="${scoreClass(s.score)}">${s.score>0?s.score:'-'}</td>
          <td>${totalItems > 0 ? totalItems : '-'}</td>
          <td>${totalItems > 0 ? normalItems : '-'}</td>
          <td>${unqItems || '-'}</td>
          <td>${totalItems > 0 ? qRate + '%' : '-'}</td>
          <td>${rectified || '-'}</td>
          <td>${expired}</td>
          <td>${reportCell}</td>
        </tr>`;
      }).join('')}
      ${list.length===0?'<tr><td colspan="9" class="empty">该区域暂无视频巡检门店</td></tr>':''}
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
    ((b.avgScore||0) - (a.avgScore||0)) ||
    ((b.monthCompleted||0)>0 ? 1:0) - ((a.monthCompleted||0)>0 ? 1:0) ||
    (b.completed||0)-(a.completed||0) ||
    String(a.storeName||'').localeCompare(String(b.storeName||''),'zh')
  );

  const total = rows[0].storeCount || list.length;
  const enrolled = list.length;

  $('regionModalTitle').textContent = `${rname} · 自检门店清单`;
  // fix35：删除「已提交/未提交/区间内提交」一行，只保留组别和门店统计
  $('regionModalSub').innerHTML =
    `组别：${html(pname)}　区域门店总数：${total}　参与自检任务：${enrolled}`;

  $('regionModalTable').innerHTML = `
    <thead><tr>
      <th>门店</th><th>应完成份数</th><th>已完成</th><th>完成率</th>
      <th>合格份数</th><th>合格率</th><th>平均分</th>
      <th>应整改单数</th><th>已整改</th><th>整改率</th>
    </tr></thead>
    <tbody>
      ${list.map(s=>{
        const qTotal = (s.qualified||0) + (s.unqualified||0);
        const qRate = qTotal > 0 ? Math.round((s.qualified||0) / qTotal * 1000) / 10 : 0;
        const exp = s.expected;
        const cmp = s.completed || 0;
        const completionRate = (exp > 0) ? Math.round((cmp / exp) * 1000) / 10 : 0;
        // 整改率：按每店自己的 yzg/dzg（来自 rectification 按 sn 聚合）
        const rec = s.rectified || 0;
        const need = s.needRectify || 0;
        const rectTotal = rec + need;
        const rectifyRate = rectTotal > 0 ? Math.round((rec / rectTotal) * 1000) / 10 : 0;
        return `
          <tr>
            <td>${html(s.storeName)}</td>
            <td>${exp === undefined ? '-' : exp}</td>
            <td>${cmp}</td>
            <td class="${rateClass(completionRate)}">${exp > 0 ? completionRate + '%' : '-'}</td>
            <td>${s.qualified}</td>
            <td class="${rateClass(qRate)}">${qTotal > 0 ? qRate + '%' : '-'}</td>
            <td class="${s.avgScore>0?scoreClass(s.avgScore):''}">${s.avgScore>0?s.avgScore:'-'}</td>
            <td>${rectTotal}</td>
            <td>${rec}</td>
            <td class="${rateClass(rectifyRate)}">${rectTotal > 0 ? rectifyRate + '%' : '-'}</td>
          </tr>
        `;
      }).join('')}
      ${list.length===0?'<tr><td colspan="10" class="empty">该区域暂无参与自检任务的门店</td></tr>':''}
    </tbody>
  `;
  $('regionModal').classList.add('active');
}

function closeRegionModal(){
  $('regionModal').classList.remove('active');
}

// fix46：自检报告弹窗——展示单店所有自检报告明细（日期 / 类型 / 点评 / 分数）
//   入参 encodeURIComponent 后的 storeName/position/region，传进来后 decode
function showStoreSelfReports(storeNameEnc, positionEnc, regionEnc){
  const storeName = decodeURIComponent(storeNameEnc || '');
  const position  = decodeURIComponent(positionEnc  || '');
  const region    = decodeURIComponent(regionEnc    || '');

  // 从 appData.selfInspection.rankStores 里反查该店的 reports 数组
  const stores = (appData.selfInspection && appData.selfInspection.rankStores) || [];
  const target = stores.find(s => (s.storeName||'') === storeName && (s.position||'') === position);
  const reports = (target && target.reports) ? target.reports.slice() : [];

  $('regionModalTitle').textContent = `${html(storeName)} · 自检报告明细`;
  $('regionModalSub').innerHTML =
    `区域：${html(region)}　组别：${html(position)}　报告数：<b>${reports.length}</b>`;

  $('regionModalTable').innerHTML = `
    <thead><tr>
      <th>日期</th><th>自检类型</th><th>点评结果</th><th>分数</th><th>报告</th>
    </tr></thead>
    <tbody>
      ${reports.map(r=>{
        const passTxt = r.ps || (r.pass ? '合格' : '不合格');
        // 合格=绿色、不合格=红色；未点评用灰色
        const passStyle = r.pass ? 'color:#1a7f37;font-weight:600' : (r.ps === '未点评' ? 'color:#999' : 'color:#c0392b;font-weight:600');
        const scoreTxt = (r.s == null || isNaN(r.s)) ? (r.ps || '未点评') : r.s;
        const scoreCls = (typeof r.s === 'number' && r.s > 0) ? scoreClass(r.s) : '';
        // fix47：rid 存在 → 跳详情；缺失时显示慧运营自检报告列表入口，
        //        让用户即便数据未补全也能进慧运营自己筛选查看。
        const cell = r.rid
          ? reportLink({ reportId: r.rid, signId: r.sid, storeName: storeName, region: region, reportDate: r.d, score: r.s, isPass: r.pass }, '查看详情', 'ZJ')
          : `<a class="report-link" href="${HYY_WEB_BASE}/selfTestReport-details?beFrom=${encodeURIComponent('自检报告')}&planType=ZJ" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" onclick="event.stopPropagation()" style="color:#888;text-decoration:underline">打开自检报告</a>`;
        return `
          <tr>
            <td>${html(r.d || '-')}</td>
            <td>${html(r.tn || '-')}</td>
            <td style="${passStyle}">${html(passTxt)}</td>
            <td class="${scoreCls}">${scoreTxt}</td>
            <td>${cell}</td>
          </tr>
        `;
      }).join('')}
      ${reports.length===0?'<tr><td colspan="5" class="empty">该门店在当前区间内暂无自检报告</td></tr>':''}
    </tbody>
  `;
  $('regionModal').classList.add('active');
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
    `组别：${html(position)}　区域门店总数：<b>${total}</b>　` +
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
    else if(activeMainTab === 'unqualifiedDetail') switchSubTab('unqStore'); // fix28：问题高发首次进入默认子面板
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

  // fix28：问题高发顶层 tab 的 7 个子面板，首次激活时按需加载 unqData
  if(subId.startsWith('unq')){
    const ensure = unqData ? Promise.resolve() : loadUnqualified();
    ensure.then(()=>renderUnqualified());
  }
}

// Sub tabs
document.querySelectorAll('.subtab').forEach(b=>{
  b.onclick = ()=>switchSubTab(b.dataset.sub);
});

// Search bindings (v2: 三类巡检 5 subtab 对应的新 search id)
$('selfRegionSearch').oninput = ()=>renderSelfInspection(appData);
$('selfStoreRankSearch').oninput = ()=>renderSelfInspection(appData);
$('regionSearch').oninput = ()=>renderRegularInspection(appData);
$('regularStoreRankSearch').oninput = ()=>renderRegularInspection(appData);
$('videoRegionSearch').oninput = ()=>renderVideoInspection(appData);
$('videoStoreRankSearch').oninput = ()=>renderVideoInspection(appData);
$('aiRegionSearch').oninput = ()=>renderAiInspection(appData);
$('aiStoreRankSearch').oninput = ()=>renderAiInspection(appData);

// fix28：问题高发 tab 的搜索框绑定
$('unqStoreSearch').oninput = ()=>renderUnqStore();
$('unqItemSearch').oninput = ()=>renderUnqItem();
$('unqRegionSearch').oninput = ()=>renderUnqRegion();
$('unqStoreRankSearch').oninput = ()=>renderUnqStoreRank();
$('unqStoreTopSearch').oninput = ()=>renderUnqStoreTop();
$('unqCategoryTopSearch').oninput = ()=>renderUnqCategoryTop();

// Chart resize on window resize
window.addEventListener('resize', ()=>{
  if(selfTrendChart) selfTrendChart.resize();
  if(videoTrendChart) videoTrendChart.resize();
  document.querySelectorAll('.rank-chart').forEach(el=>{ if(el._chart) el._chart.resize(); });
});

// Initial load：默认按「本月 1 号 ~ 今天」走 raw 实时聚合，门店数用 data.json baseline（7/46/341）
// 右上角的「全部数据」按钮切换回 data.json 预生成快照；「上月/选择日期」走 raw。
initDates();
(async function boot(){
  $('loading').style.display = 'block';
  if(typeof aggregateRange === 'function'){
    const dataReady = await preloadAllRawMonths();
    if(dataReady){
      await tryAggregateRange(currentStart, currentEnd);
    } else {
      await loadData(false);
      showStaticBanner(currentStart, currentEnd, toBeijing(appData.generatedAt));
    }
  } else {
    await loadData(false);
  }
  // fix53：无论走聚合路径还是 loadData，明细均已改为弹窗按需读取单报告小文件（fix89）
  $('loading').style.display = 'none';
})();

// 每 10 分钟刷新：按当前所处模式刷新
setInterval(async ()=>{
  if(appData && appData._rawMonths){
    await tryAggregateRange(currentStart, currentEnd);
  } else {
    loadData(false);
  }
}, 10*60*1000);

/* ============================================================================
   v2 新增：组别组织（type: self/regular/video）、高发问题汇总（type: self/regular/video）
   - 组别组织：在四个明细 tab 内各画四张组别大卡（直营组/新店运营组/加盟营运组/新店筹建组），
     数据从对应类型的 regions 按 position 分组聚合
   - 高发问题汇总：按区域分块 + @image#1 那种门店卡片（不合格项数 + Top3 问题 + 查看全部）
     数据从 unqData 按 type 取（self→selfStoreRank / regular→byStore / video→appData.videoInspection.stores）
   ============================================================================ */

const POSITION_LABEL = {self:'门店自检', regular:'常规巡检（QSC）', video:'视频巡检', ai:'AI慧检'};
const POSITION_SCOPE = {self:'scope-zj', regular:'scope-cg', video:'scope-sp'};

function renderPositionCards(type, d){
  const containerId = type + 'PositionsCards';
  const el = $(containerId);
  if(!el) return;

  // fix8：完全照搬 V1 做法——按 type 直接读对应 positions 数组的字段
  //   type='regular' → d.positions[i]
  //   type='self'    → d.selfInspection.positions[i]
  //   type='video'   → d.videoInspection.positions[i]
  // 不再用 storePool 实时聚合、不再用 baseline 兜底。门店数等所有字段以 data.json 快照为准，
  // 与 V1 根目录原版完全一致。
  let positions = [];
  if(type === 'self'){
    const si = (d||{}).selfInspection || {};
    positions = si.positions || [];
  } else if(type === 'regular'){
    positions = (d||{}).positions || [];
  } else if(type === 'video'){
    const vi = (d||{}).videoInspection || {};
    positions = vi.positions || [];
  } else if(type === 'ai'){
    const ai = (d||{}).aiInspection || {};
    positions = ai.positions || [];
  }

  if(!positions.length){
    el.innerHTML = '<div class="empty" style="grid-column:1/-1">暂无组别数据</div>';
    return;
  }

  const label = POSITION_LABEL[type] || '';
  const scopeCls = POSITION_SCOPE[type] || '';
  el.innerHTML = positions.map(p=>{
    const sc = p.storeCount || 0;
    const ic = p.inspectedCount || 0;
    // 完成率优先取 data.json 自带的 submitRate，否则按 ic/sc 重算
    const submitRate = (p.submitRate != null) ? p.submitRate : ((sc > 0) ? Math.round(ic / sc * 1000) / 10 : 0);
    const avgScore = p.avgScore || 0;
    const unq = p.unqualifiedItems != null ? p.unqualifiedItems : 0;
    const qRate = p.qualifiedRate != null ? p.qualifiedRate : 0;
    const regionList = p.regions || [];
    const visible = regionList.slice(0, 8);
    const more = regionList.length > 8 ? `<span class="reg-tag">+${regionList.length - 8}</span>` : '';
    // fix42：门店自检·组别大卡——按用户要求显示 6 字段（数据与区域汇总同源）
    if (type === 'self') {
      const completionRate = (p.completionRate != null) ? p.completionRate : 0;
      const reviewRate = (p.reviewRate != null) ? p.reviewRate : 0;
      const qualifiedRate = (p.qualifiedRate != null) ? p.qualifiedRate : 0;
      const avgScoreDisplay = avgScore > 0 ? avgScore : '-';
      const avgScoreCls = avgScore > 0 ? scoreClass(avgScore) : '';
      const rectifyRate = (p.rectifyRate != null) ? p.rectifyRate : 0;
      const rectifyTotal = (p.rectified || 0) + (p.needRectify || 0);
      return `
        <div class="pos-card">
          <div class="pos-title">${html(p.position)}<span class="scope-tag ${scopeCls}">${label}</span></div>
          <div class="pos-subtitle">${label} · 按组别汇总</div>
          <div class="pos-meta">
            <div><span class="pv">${sc}</span><span class="pl">门店数</span></div>
            <div><span class="pv ${avgScoreCls}">${avgScoreDisplay}</span><span class="pl">平均分</span></div>
            <div><span class="pv ${rateClass(completionRate)}">${completionRate}%</span><span class="pl">自检完成率</span></div>
            <div><span class="pv ${rateClass(reviewRate)}">${reviewRate}%</span><span class="pl">点评率</span></div>
            <div><span class="pv ${rateClass(qualifiedRate)}">${(qualifiedRate > 0 || (p.qualified + p.unqualified) > 0) ? qualifiedRate + '%' : '-'}</span><span class="pl">合格率</span></div>
            <div><span class="pv ${rateClass(rectifyRate)}">${rectifyTotal > 0 ? rectifyRate + '%' : '-'}</span><span class="pl">整改率</span></div>
          </div>
          <div class="reg-tags">${visible.map(r=>`<span class="reg-tag">${html(r)}</span>`).join('')}${more}</div>
        </div>
      `;
    }
    return `
      <div class="pos-card">
        <div class="pos-title">${html(p.position)}<span class="scope-tag ${scopeCls}">${label}</span></div>
        <div class="pos-subtitle">${label} · 按组别汇总</div>
        <div class="pos-meta">
          <div><span class="pv">${sc}</span><span class="pl">门店数</span></div>
          <div><span class="pv">${ic}</span><span class="pl">已巡检</span></div>
          <div><span class="pv">${submitRate}%</span><span class="pl">完成率</span></div>
          <div><span class="pv">${avgScore || '-'}</span><span class="pl">平均分</span></div>
          <div><span class="pv">${unq}</span><span class="pl">不合格项</span></div>
          <div><span class="pv">${qRate}%</span><span class="pl">合格率</span></div>
          <div><span class="pv">${regionList.length}</span><span class="pl">区域数</span></div>
        </div>
        <div class="reg-tags">${visible.map(r=>`<span class="reg-tag">${html(r)}</span>`).join('')}${more}</div>
      </div>
    `;
  }).join('');
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
    planTypeForLink = 'SP';
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
  let cardsHtml;
  if(type === 'regular'){
    cardsHtml = rows.map(s=>`
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
    cardsHtml = rows.map(s=>`
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
          ${type === 'video' ? (s.reportId ? reportLink(s, '查看报告', 'SP') : '<span style="color:#999">暂无视频报告编号</span>') : reportLink(s, '查看报告', s.planType || planTypeForLink)}
        </div>
      </div>
    `).join('') || '<div class="empty">无数据</div>';
  }

  el.innerHTML = cardsHtml;
  refreshUnqPhotos(el);
}
