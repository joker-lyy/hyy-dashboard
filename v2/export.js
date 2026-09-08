/* ============================================================
 * export.js —— 隐藏报表输出模块（fix157：大厂审计报告标准版）
 * 仅当 URL 带 ?key=888 时由 app.js 动态加载；普通访问/分享链接完全不加载。
 * fix157 变化（对标麦当劳/肯德基/EcoSure 审计体系）：
 *   1) 报告只活在浏览器里，不落盘不占内存；要留存用页内「打印/另存为 PDF」
 *   2) 输出范围新增「巡检问题汇总及整改跟进」独立选项（纯问题分析报告）
 *   3) 双视角输出：
 *      · 老板版（经营决策）：问题分级（关键食安/一般执行/轻微）+ 整改闭环率 +
 *        风险敞口 + 决策建议（复检触发机制/责任到人/奖惩）——对标 EcoSure 分级处置
 *      · 培训版（课件）：面向加盟商与门店伙伴，高频问题逐条教学卡
 *        （真实案例→危害→正确做法→自查要点）+ 每日自查清单 + 给加盟商的话
 *   4) AI 提示词按大厂审计报告口径重写：先结论、分级、闭环、机制化
 * 智谱 Key 存 localStorage('zhipu_api_key')，不进代码库。
 * ============================================================ */
(function(){
  'use strict';

  const AI_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const TAB_NAMES = { overview:'总览', regularInspection:'常规巡检', selfInspection:'门店自检', videoInspection:'视频巡检', aiInspection:'AI 慧检', unqualifiedDetail:'巡检问题汇总及整改跟进' };
  const TYPES = ['regularInspection','selfInspection','videoInspection','aiInspection'];
  function thresholdOf(posName){
    const n = String(posName||'');
    if(n.indexOf('加盟')>=0 && n.indexOf('新店')<0 && n.indexOf('筹建')<0) return 80;
    return 90;
  }

  function tabData(){
    try{ return (typeof appData!=='undefined' && appData) ? appData : null; }catch(e){ return null; }
  }
  function blockOf(t){
    const d = tabData(); if(!d) return null;
    return t==='regularInspection' ? d : (d[t] || null);
  }
  function curType(){
    return TYPES.includes(activeMainTab) ? activeMainTab : 'regularInspection';
  }
  /* 默认勾选：当前所在巡检板块 + 问题汇总；其余由用户复选 */
  function defaultTypes(){
    const s = new Set([curType(), 'unq']);
    return s;
  }

  /* ---------- 样式 ---------- */
  const css = document.createElement('style');
  css.textContent = `
  #expFab{position:fixed;right:18px;bottom:64px;z-index:99990;width:52px;height:52px;border-radius:50%;
    background:linear-gradient(135deg,#186BEB,#1A2A4A);color:#fff;border:none;cursor:pointer;font-size:22px;
    box-shadow:0 4px 14px rgba(24,107,235,.4);display:flex;align-items:center;justify-content:center}
  #expFab:hover{transform:scale(1.08)}
  #expOverlay{position:fixed;inset:0;z-index:99991;background:rgba(10,18,40,.55);display:none;
    align-items:center;justify-content:center}
  #expOverlay.active{display:flex}
  #expPanel{width:580px;max-width:92vw;max-height:88vh;overflow:auto;background:#fff;border-radius:14px;
    padding:22px 24px;box-shadow:0 12px 40px rgba(0,0,0,.35);color:#1a2a4a}
  #expPanel h3{margin:0 0 6px;font-size:18px}
  #expPanel .sub{color:#7a8399;font-size:12px;margin-bottom:14px;line-height:1.6}
  #expPanel .sec{border-top:1px dashed #dfe4ee;padding-top:12px;margin-top:12px}
  #expPanel label{font-size:13px;font-weight:600;display:block;margin:8px 0 4px}
  #expPanel input[type=text]{width:100%;padding:7px 10px;border:1px solid #ccd4e4;
    border-radius:8px;font-size:13px;box-sizing:border-box}
  #expPanel .row{display:flex;gap:10px;margin-top:14px}
  #expPanel button.act{flex:1;padding:10px 0;border:none;border-radius:9px;font-size:14px;font-weight:600;
    cursor:pointer;color:#fff;background:#186BEB}
  #expPanel button.act.gray{background:#5a6377}
  #expPanel button.act:disabled{opacity:.55;cursor:wait}
  #expStat{margin-top:12px;font-size:12px;color:#5a6377;white-space:pre-wrap;line-height:1.7}
  #expPanel .chipbar{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px}
  #expPanel .chipbar .chip{padding:4px 12px;border-radius:999px;border:1px solid #ccd4e4;font-size:12px;cursor:pointer;background:#f5f7fb}
  #expPanel .chipbar .chip.on{background:#186BEB;color:#fff;border-color:#186BEB}
  `;
  document.head.appendChild(css);

  /* ---------- UI ---------- */
  const fab = document.createElement('button');
  fab.id = 'expFab'; fab.title = '报表输出（仅自己可见）'; fab.textContent = '📊';
  document.body.appendChild(fab);

  const ov = document.createElement('div');
  ov.id = 'expOverlay';
  ov.innerHTML = `
    <div id="expPanel">
      <h3>📊 巡检报告输出</h3>
      <div class="sub">对标大厂审计报告标准：问题分级 · 整改闭环 · 决策建议。<br>报告只在浏览器里打开，<b>不保存文件、不占内存</b>；要留存就在报告页点「打印 / 另存为 PDF」。</div>
      <label>报告视角</label>
      <div class="chipbar" id="expModeBar"></div>
      <label>输出范围（可多选，✓ 为已勾选）</label>
      <div class="chipbar" id="expTypeBar"></div>
      <div class="sub" id="expScope"></div>
      <div class="sec">
        <label>智谱 AI API Key（首次填写后存本机浏览器）</label>
        <input type="text" id="expKey" placeholder="粘贴你的智谱 API Key（glm-4-flash）">
      </div>
      <div class="row">
        <button class="act gray" id="expCsvBtn">① 导出数据 Excel</button>
        <button class="act" id="expHtmlBtn">② 生成分析报告</button>
      </div>
      <div id="expStat"></div>
    </div>`;
  document.body.appendChild(ov);

  let expTypes = defaultTypes();
  let expMode = 'boss'; // boss=老板版(经营决策) train=培训版(课件)
  function chip(id, opts, cur, cb){
    const bar = ov.querySelector(id);
    bar.innerHTML = opts.map(o=>`<span class="chip${o.k===cur?' on':''}" data-k="${o.k}">${o.l}</span>`).join('');
    bar.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{ cb(c.dataset.k); });
  }
  function renderMode(){ chip('#expModeBar', [{k:'boss',l:'👔 老板版（经营决策）'},{k:'train',l:'🎓 培训版（课件）'}], expMode, v=>{ expMode=v; renderMode(); }); }
  function renderChips(){
    /* 输出范围 = 复选：四类巡检可多选，「全部四类巡检」一键全选/清空，「问题汇总及整改跟进」独立复选 */
    const bar = ov.querySelector('#expTypeBar');
    const opts = [...TYPES.map(t=>({k:t,l:TAB_NAMES[t]})), {k:'unq',l:'巡检问题汇总及整改跟进'}, {k:'all',l:'全部四类巡检'}];
    bar.innerHTML = opts.map(o=>{
      const on = o.k==='all' ? TYPES.every(t=>expTypes.has(t)) : expTypes.has(o.k);
      return `<span class="chip${on?' on':''}" data-k="${o.k}">${on&&o.k!=='all'?'✓ ':''}${o.l}</span>`;
    }).join('');
    bar.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{
      const k = c.dataset.k;
      if(k==='all'){
        const allOn = TYPES.every(t=>expTypes.has(t));
        if(allOn) TYPES.forEach(t=>expTypes.delete(t)); else TYPES.forEach(t=>expTypes.add(t));
      } else {
        if(expTypes.has(k)){ expTypes.delete(k); } else { expTypes.add(k); }
      }
      renderChips(); renderScope();
    });
  }
  function scopeText(){
    const n = expTypes.size;
    return `已选 ${n} 项：${[...expTypes].map(k=>k==='unq'?'问题汇总及整改跟进':TAB_NAMES[k]).join('、')}　|　日期区间：${currentStart||'-'} ~ ${currentEnd||'-'}　|　环比：上一等长周期`;
  }
  function renderScope(){ ov.querySelector('#expScope').textContent = scopeText(); }
  renderMode(); renderChips(); renderScope();
  setInterval(renderScope, 2000);

  fab.onclick = ()=>{ ov.classList.add('active'); ov.querySelector('#expKey').value = localStorage.getItem('zhipu_api_key')||''; };
  ov.onclick = e=>{ if(e.target===ov) ov.classList.remove('active'); };

  const stat = msg=>{ ov.querySelector('#expStat').textContent = msg; };

  /* ---------- 日期工具 ---------- */
  function shiftDays(iso, n){
    const d = new Date(iso+'T00:00:00');
    d.setDate(d.getDate()+n);
    return d.toISOString().slice(0,10);
  }
  function prevRange(){
    const s = currentStart, e = currentEnd;
    if(!s || !e) return null;
    const len = Math.round((new Date(e+'T00:00:00') - new Date(s+'T00:00:00'))/86400000) + 1;
    const pe = shiftDays(s, -1);
    const ps = shiftDays(pe, -(len-1));
    return { s: ps, e: pe, len };
  }

  /* ---------- 基础指标 ---------- */
  function num(v,d){ v=Number(v); return isFinite(v)?v:(d||0); }
  function groupMetrics(block){
    const posList = block.positions || [];
    const storesAll = block.stores || [];
    return posList.map(p=>{
      const pname = p.position || p.name || '-';
      const th = thresholdOf(pname);
      const pStores = storesAll.filter(s=>(s.position||'')===pname);
      const withReport = pStores.filter(s=>num(s.reportCount)>0);
      const scored = pStores.filter(s=>num(s.score)>0);
      const passStores = scored.filter(s=>num(s.score)>=th).length;
      return {
        name: pname, th,
        storeCount: num(p.storeCount) || pStores.length,
        covered: withReport.length,
        coverage: (num(p.storeCount)||pStores.length)>0 ? Math.round(withReport.length/(num(p.storeCount)||pStores.length)*1000)/10 : 0,
        avgScore: num(p.avgScore),
        passStores, scoredCount: scored.length,
        passRate: scored.length ? Math.round(passStores/scored.length*1000)/10 : 0
      };
    });
  }
  function failedStores(block, limit){
    const out = [];
    (block.positions||[]).forEach(p=>{
      const pname = p.position||p.name||'-';
      const th = thresholdOf(pname);
      (block.stores||[]).filter(s=>(s.position||'')===pname && num(s.reportCount)>0 && num(s.score)>0 && num(s.score)<th)
        .forEach(s=>out.push({ pos:pname, name:s.storeName||'', region:s.region||'', score:num(s.score), th, unq:num(s.unqualifiedItems), reports:num(s.reportCount) }));
    });
    return out.sort((a,b)=>a.score-b.score).slice(0,limit);
  }
  function collect(type){
    const b = blockOf(type);
    if(!b) return null;
    return { type, name:TAB_NAMES[type], groups:groupMetrics(b), fails:failedStores(b,10) };
  }
  async function loadPrev(){
    const pr = prevRange();
    if(!pr || typeof aggregateRange !== 'function') return null;
    const prev = await aggregateRange(pr.s, pr.e);
    return { range: pr, byType: TYPES.map(t=>{
      const b = t==='regularInspection' ? prev : prev[t];
      return b ? { type:t, groups:groupMetrics(b) } : null;
    })};
  }

  /* ============================================================
   * 问题数据提取（unqualified_v2.json）
   * ============================================================ */
  async function loadUnqData(){
    if(typeof loadUnq2 === 'function'){ try{ await loadUnq2(); }catch(e){} }
    if(typeof unq2State !== 'undefined' && unq2State.loaded) return unq2State.data;
    const r = await fetch(`${DATA_BASE}/unqualified_v2.json?v=${Date.now()}`);
    if(!r.ok) throw new Error('问题数据加载失败 HTTP '+r.status);
    return await r.json();
  }
  function unqEntriesForRange(uq, s, e){
    const out = [];
    const types = (uq && uq.types) || {};
    Object.keys(types).forEach(t=>{
      ((types[t]&&types[t].entries)||[]).forEach(x=>{
        if(s && x.d < s) return;
        if(e && x.d > e) return;
        out.push(Object.assign({ src:t }, x));
      });
    });
    return out;
  }
  /* 大厂分级：Critical（直接食安风险）/ Moderate（流程执行缺陷）/ Minor（一般不规范） */
  const CRIT_KW = ['温度','过期','变质','腐败','发霉','异味','交叉','生熟','虫','鼠','蟑','异物','毛发','留样','健康证','直接入口','裸露','消毒','中毒','疑似'];
  const MOD_KW  = ['标签','效期','记录','储存','存放','解冻','洗手','手套','口罩','工作帽','清洁','清洗','垃圾','废油','食材','原料','冰箱','冷柜','货架','离墙离地','返库','先进先出'];
  function classify(t){
    const s = String(t||'');
    if(CRIT_KW.some(k=>s.indexOf(k)>=0)) return 'C';
    if(MOD_KW.some(k=>s.indexOf(k)>=0)) return 'M';
    return 'L';
  }
  /* 情形拆解：从问题描述里按检查员常用词提取高频细节（如着装→工衣/帽子/围裙各多少次） */
  const KW_VOCAB = ['工衣','工作服','工服','便装','帽子','帽','围裙','口罩','裤子','鞋','头发','发网','发帽','指甲','美甲','首饰','戒指','手表','工牌','仪容','着装',
    '过期','临期','变质','发霉','异味','标签','效期','生产日期','保质期','解冻','生熟','交叉','裸露','直接入口','食材','原料','三文鱼','食材检查',
    '冷藏','冷冻','冰箱','冷柜','温度','留样','消毒','虫','鼠','蟑','异物','毛发',
    '清洁','清洗','垃圾','垃圾桶','洗手','手套','抹布','砧板','刀具','记录','表单','台账','健康证'];
  function extractKw(descs){
    const cnt = {};
    descs.forEach(d=>{
      const s = String(d||'');
      if(!s) return;
      const seen = new Set();
      KW_VOCAB.forEach(k=>{ if(s.indexOf(k)>=0 && !seen.has(k)){ seen.add(k); cnt[k]=(cnt[k]||0)+1; } });
    });
    /* 归并近义词：工作服/工服→工衣，发网/发帽→头发相关 */
    if(cnt['工作服']) cnt['工衣'] = (cnt['工衣']||0)+cnt['工作服'], delete cnt['工作服'];
    if(cnt['工服']) cnt['工衣'] = (cnt['工衣']||0)+cnt['工服'], delete cnt['工服'];
    if(cnt['发网']) cnt['发帽'] = (cnt['发帽']||0)+cnt['发网'], delete cnt['发网'];
    return Object.entries(cnt).filter(x=>x[1]>=1).sort((a,b)=>b[1]-a[1]).slice(0,8);
  }
  function analyzeProblems(cur, prev){
    const descMap = new Map(); /* 问题标题 → 全部问题描述（情形拆解用） */
    const map = new Map();
    cur.forEach(x=>{
      const key = (x.t||'-').trim();
      if(!descMap.has(key)) descMap.set(key, []);
      const dm = descMap.get(key);
      if(x.desc) dm.push(x.desc);
      let g = map.get(key);
      if(!g){ g = { t:key, count:0, stores:new Set(), regions:new Map(), groups:new Map(), descs:[], srcs:new Map() }; map.set(key,g); }
      g.count++; g.stores.add(x.sn||'-');
      g.regions.set(x.rg||'-', (g.regions.get(x.rg||'-')||0)+1);
      g.groups.set(x.ps||'-', (g.groups.get(x.ps||'-')||0)+1);
      if(x.desc && g.descs.length<3 && !g.descs.includes(x.desc)) g.descs.push(x.desc);
    });
    const pmap = new Map();
    (prev||[]).forEach(x=>{ const k=(x.t||'-').trim(); pmap.set(k,(pmap.get(k)||0)+1); });
    const items = [...map.values()].map(g=>{
      const lv = classify(g.t);
      const allDesc = descMap.get(g.t) || [];
      const descFreq = new Map();
      allDesc.forEach(d=>{ const k=String(d||'').trim(); if(k) descFreq.set(k,(descFreq.get(k)||0)+1); });
      const topDescs = [...descFreq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(x=>({ d:x[0], n:x[1] }));
      return { t:g.t, level:lv, count:g.count, storeCount:g.stores.size,
        topRegion:[...g.regions.entries()].sort((a,b)=>b[1]-a[1])[0]||['-',0],
        groupDist:[...g.groups.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]+'×'+x[1]).slice(0,4).join('、'),
        descs:g.descs, kw: extractKw(allDesc), topDescs, prevCount: pmap.get(g.t)!=null ? pmap.get(g.t) : null };
    }).sort((a,b)=>(a.level===b.level? b.count-a.count : (a.level>b.level?1:-1)));
    items.forEach(x=>x.delta = x.prevCount!=null ? x.count-x.prevCount : null);

    // 重复出问题门店（闭环失败证据）
    const repMap = new Map();
    const repDescs = new Map(); /* 门店||问题 → 描述清单 */
    cur.forEach(x=>{
      const k=(x.sn||'-')+'||'+(x.t||'-').trim();
      repMap.set(k,(repMap.get(k)||0)+1);
      if(!repDescs.has(k)) repDescs.set(k,[]);
      if(x.desc) repDescs.get(k).push(x.desc);
    });
    const repeats = [...repMap.entries()].filter(x=>x[1]>=2).map(x=>{
      const parts = x[0].split('||');
      const sample = cur.find(y=>y.sn===parts[0] && (y.t||'').trim()===parts[1]);
      const dl = repDescs.get(x[0]) || [];
      const df = new Map();
      dl.forEach(d=>{ const s=String(d||'').trim(); if(s) df.set(s,(df.get(s)||0)+1); });
      const top = [...df.entries()].sort((a,b)=>b[1]-a[1]).slice(0,2).map(y=>y[0]+(y[1]>1?`（${y[1]}次）`:''));
      return { sn:parts[0], t:parts[1], times:x[1], ps:sample?sample.ps:'-', rg:sample?sample.rg:'-', level:classify(parts[1]), kw: extractKw(dl), topDescs: top };
    }).sort((a,b)=>b.times-a.times);

    const sMap = new Map();
    cur.forEach(x=>{ const k=x.sn||'-'; sMap.set(k, (sMap.get(k)||0)+1); });
    const worstStores = [...sMap.entries()].map(x=>{
      const sample = cur.find(y=>y.sn===x[0]);
      return { sn:x[0], count:x[1], ps:sample?sample.ps:'-', rg:sample?sample.rg:'-' };
    }).sort((a,b)=>b.count-a.count).slice(0,12);

    const lv = { C:0, M:0, L:0 };
    items.forEach(x=>lv[x.level]+=x.count);
    /* 闭环率 = 已闭环记录数 ÷ 问题记录总数。
       分母只算真实发生的问题记录（第1次出现即计入），与门店总数无关；
       同一「门店+问题」第2次及以后出现的记录 = 上次整改未闭环。 */
    let notClosed = 0;
    repMap.forEach(times=>{ if(times>=2) notClosed += times-1; });
    const loopRate = cur.length ? Math.round((1 - notClosed/cur.length)*1000)/10 : 100;
    return { items, repeats, worstStores, total:cur.length, level:lv, loopRate, notClosed };
  }

  /* ---------- Excel ---------- */
  ov.querySelector('#expCsvBtn').onclick = async ()=>{
    const list = TYPES.filter(t=>expTypes.has(t)).map(collect).filter(Boolean);
    if(!list.length){ stat('❌ 数据还没加载完，稍等几秒再试'); return; }
    let prev = null;
    try{ prev = await loadPrev(); }catch(e){}
    const pvGroup = (type, gname)=>{ if(!prev) return null; const t = prev.byType.find(x=>x&&x.type===type); if(!t) return null; return t.groups.find(g=>g.name===gname)||null; };
    const lines = [];
    lines.push(`苍井寿司巡检数据导出\t区间 ${currentStart} ~ ${currentEnd}\t达标线：直营90/新店90/加盟营运80`);
    lines.push('覆盖率 = 已巡检门店÷应巡检门店；门店合格率 = 达标门店÷已巡检门店');
    list.forEach(d=>{
      lines.push(''); lines.push(`【${d.name}（数据采集）】`);
      lines.push('组别\t门店\t巡检覆盖率\t门店合格率\t平均分\t平均分环比');
      d.groups.forEach(g=>{
        const pv = pvGroup(d.type, g.name);
        const dl = pv ? (Math.round((g.avgScore-pv.avgScore)*100)/100) : '无上期';
        lines.push([g.name,g.storeCount,`${g.coverage}%（${g.covered}/${g.storeCount}）`,`${g.passRate}%（${g.passStores}/${g.scoredCount}）`,g.avgScore,dl].join('\t'));
      });
      if(d.fails.length){ lines.push(''); lines.push('未达标门店\t组别\t区域\t平均分\t达标线\t不合格项\t报告数');
        d.fails.forEach(s=>lines.push([s.name,s.pos,s.region,s.score,s.th,s.unq,s.reports].join('\t'))); }
    });
    const blob = new Blob(['\ufeff'+lines.join('\r\n')], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `巡检数据_${currentStart}_${currentEnd}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    stat('✅ Excel 数据已下载');
  };

  /* ---------- AI：老板版（大厂审计报告口径） ---------- */
  async function aiBoss(problems, prevTxt, hasScores){
    const key = (ov.querySelector('#expKey').value||'').trim();
    if(!key) throw new Error('请先填写智谱 API Key');
    localStorage.setItem('zhipu_api_key', key);
    const body = {
      model:'glm-4-flash', temperature:0.3, max_tokens:2800,
      messages:[
        {role:'system', content:`你是国际连锁餐饮（麦当劳/肯德基/星巴克级别）的食品安全与营运审计总监，为苍井寿司（连锁寿司品牌）撰写月度审计分析报告，读者是品牌老板（经营决策会）。
你熟悉的行业方法必须体现出来：
- 问题分级处置：Critical（直接食安风险：温度失控/过期变质/交叉污染/虫鼠害/异物，72小时内必须整改并复检）、Moderate（流程执行缺陷：标签效期/记录/储存规范，30天窗口）、Minor（一般不规范，纳入例行辅导）。同一问题第二次出现视作系统性问题，升级处理。
- 闭环管理：发现≠解决。同一门店同一问题重复出现≥2次=上一次整改没有闭环，这是整份报告最严重的信号；要做闭环率和复检触发机制建议。
- 跨门店共性问题=培训体系问题，不是某家门店问题；单店重复问题=门店管理问题。
写报告的铁律：
- 结论先行。老板只看结论和要做什么决策，不复述数字表格。
- 每个判断带数据；禁止"加强管理/提高意识"这类空话；禁止复述分数。
- 建议必须机制化：谁负责、什么时限、怎么验证、不达标怎么办。
严格按以下格式输出，不要寒暄：
【经营层结论】3条。第一条必须是"本期品牌最大的食品安全风险是……"的直接判断（带数据）。
【系统性根因】3-4条。按"跨门店共性问题→培训/标准问题；单店重复问题→管理闭环问题"的框架给出根因判断，带数据。
【风险敞口与分级】2-3条。Critical问题有多少条/占多少比例、集中在哪些环节（温度/储存/卫生…）、暴露在哪类门店。
【决策建议】4-6条。每条格式"决策｜负责机制｜验证方式｜不达标处置"。必须包含：关键问题复检触发机制（如重复问题门店72小时复检）、责任到人（区域督导/店长署名闭环）、与加盟商考核挂钩。
【下周期承诺目标】2-3条，量化（如Critical问题条数下降X%、闭环率达到X%）。`},
        {role:'user', content:'本期区间：'+currentStart+' ~ '+currentEnd+(prevTxt?('，环比周期：'+prevTxt):'，无环比数据')+
          (hasScores?'\n（组别覆盖率/合格率背景数据已在报告表格中，不复述）':'')+
          '\n问题数据（巡检问题汇总及整改跟进提取，level：C=关键食安 M=流程执行 L=一般，loopRate=整改闭环率估算）：\n'+JSON.stringify(problems, null, 1)}
      ]
    };
    const r = await fetch(AI_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body: JSON.stringify(body) });
    if(!r.ok) throw new Error('智谱接口返回 '+r.status);
    const j = await r.json();
    const txt = (j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content||'').trim();
    const seg = {};
    ['经营层结论','系统性根因','风险敞口与分级','决策建议','下周期承诺目标'].forEach(k=>{
      const m = txt.match(new RegExp('【'+k+'】([\\s\\S]*?)(?=【|$)'));
      seg[k] = m ? m[1].split('\n').map(l=>l.trim()).filter(Boolean) : [];
    });
    return seg;
  }

  /* ---------- AI：培训版（课件，面向加盟商与门店伙伴） ---------- */
  async function aiTrain(problems){
    const key = (ov.querySelector('#expKey').value||'').trim();
    if(!key) throw new Error('请先填写智谱 API Key');
    localStorage.setItem('zhipu_api_key', key);
    const brief = {
      高频问题: problems.items.slice(0,6).map(x=>({ 问题:x.t, 次数:x.count, 涉及门店:x.storeCount, 情形拆解:x.kw, 典型情形:x.descs })),
      重复出问题的门店: problems.repeats.slice(0,8).map(x=>x.sn+'（'+x.t+'出现'+x.times+'次）')
    };
    const body = {
      model:'glm-4-flash', temperature:0.4, max_tokens:4000,
      messages:[
        {role:'system', content:`你是苍井寿司培训部金牌讲师，正在为加盟商和门店店长做食品安全专项培训课件。这门课的核心使命：**戳痛点**——让加盟商真切感觉到"这些事不做，亏的是我自己的钱、砸的是我自己的店"，痛了才讲得明、听得进、做得到。语言要求：说人话、敢说重话、句句带代价；禁止英文术语；对门店工作人员一律称"伙伴"。

【法规依据（只许引用以下条款，不许编造）】
1.《中华人民共和国食品安全法》第三十四条：禁止生产经营腐败变质、油脂酸败、霉变生虫、污秽不洁、混有异物、掺假掺杂或者感官性状异常的食品；超过保质期的食品。
2.《食品安全法》第四十五条：从事接触直接入口食品工作的从业人员应当每年进行健康检查，取得健康证明后方可上岗。患有国务院卫生行政部门规定的有碍食品安全疾病的人员，不得从事接触直接入口食品的工作。
3.《食品安全法》第五十四条：食品经营者应当按照保证食品安全的要求贮存食品，定期检查库存食品，及时清理变质或者超过保质期的食品。食品经营者贮存、运输和装卸食品的容器、工具和设备应当安全、无害，保持清洁。
4.《食品安全法》第一百二十四条：生产经营用超过保质期的食品原料、食品添加剂生产食品，或生产经营致病性微生物、农药残留、兽药残留、重金属等污染物质超过食品安全标准限量的食品，尚不构成犯罪的，没收违法所得，货值金额不足一万元的，并处五万元以上十万元以下罚款；货值金额一万元以上的，并处货值金额十倍以上二十倍以下罚款。
5.《食品安全法》第一百二十六条：未按规定对从业人员进行食品安全培训和考核、未建立并遵守食品进货查验记录制度等，由监管部门责令改正，给予警告；拒不改正的，处五千元以上五万元以下罚款；情节严重的，责令停产停业，直至吊销许可证。
6.《食品安全法》第一百三十五条：因食品安全犯罪被判处有期徒刑以上刑罚的，终身不得从事食品生产经营管理工作。
7. 国家标准《餐饮服务通用卫生规范》（GB 31654-2021）：从业人员应保持个人卫生，穿戴清洁的工作衣、帽、口罩；留样食品按品种分别盛放于清洗消毒后的专用密闭容器内，在专用冷藏设备中冷藏存放48小时以上，每个品种留样量不少于125g，并记录留样食品名称、留样量、留样时间、留样人员等。
8. 市场监管部门"餐饮服务食品安全操作规范"要求：食品贮存做到离墙离地10cm以上、分类分架存放，遵循先进先出；需要冷藏的熟制食品应在清洁密闭容器中冷藏。

严格按以下格式输出，不要寒暄：
【痛点开场】3条，每条算一笔加盟商自己的账：一次食安事故的直接代价（罚款额度引上面条款的数字）+ 间接代价（停业整顿期间房租人工照付、外卖平台评分和下架、顾客流失、品牌加盟资格）+ 对比做好只要花多少心思。要写"这一笔账你自己算"这种口吻。
【教学卡】5-6张，每张一行，格式（用竖线分隔）：
问题名｜真实发生（引数据里的次数与情形拆解，如"本期116次着装问题里没穿工衣最多"）｜踩了哪条法规（引用上面条款名+关键数字，如"《食品安全法》第126条：拒不改正可罚5千到5万、停产停业"）｜疼在哪（对加盟商的账：罚款/停业/赔偿/外卖分）｜正确做法（具体步骤含数字标准）｜门店自查（伙伴每天怎么快速自查）
【每日自查清单】8条，每条一句话、可打勾执行，覆盖上面高频问题。
【给加盟商的话】3条，加盟商视角，要带痛感：我该盯什么、出了问题第一时间做什么、不盯的代价是什么。`},
        {role:'user', content:'本期巡检发现的问题（真实数据，教学卡按出现次数从高到低）：\n'+JSON.stringify(brief, null, 1)}
      ]
    };
    const r = await fetch(AI_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body: JSON.stringify(body) });
    if(!r.ok) throw new Error('智谱接口返回 '+r.status);
    const j = await r.json();
    const txt = (j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content||'').trim();
    const seg = {};
    ['痛点开场','教学卡','每日自查清单','给加盟商的话'].forEach(k=>{
      const m = txt.match(new RegExp('【'+k+'】([\\s\\S]*?)(?=【|$)'));
      seg[k] = m ? m[1].split('\n').map(l=>l.trim()).filter(Boolean).filter(l=>l.indexOf('｜')>=0 || k!=='教学卡') : [];
    });
    return seg;
  }

  /* ============================================================
   * HTML 报告生成
   * ============================================================ */
  const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function deltaBadge(cur, pv){
    if(pv==null || !isFinite(pv)) return '<span class="dnull">无上期</span>';
    const d = Math.round((cur-pv)*10)/10;
    if(d===0) return '<span class="dflat">持平</span>';
    return d>0 ? `<span class="dgood">▲+${d}</span>` : `<span class="dbad">▼${d}</span>`;
  }
  const LV = {
    C:{ name:'Critical 关键食安', cls:'risk-high', col:'#C0392B' },
    M:{ name:'Moderate 流程执行', cls:'risk-mid', col:'#E67E22' },
    L:{ name:'Minor 一般不规范', cls:'risk-low', col:'#7a8399' }
  };
  const REPORT_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#1a2a4a;background:#eef1f6;line-height:1.65}
.page{max-width:960px;margin:0 auto;background:#fff;padding:48px 56px;box-shadow:0 0 24px rgba(0,0,0,.08)}
.cover{color:#fff;margin:-48px -56px 40px;padding:56px}
.cover.boss{background:linear-gradient(135deg,#1A2A4A,#186BEB)}
.cover.train{background:linear-gradient(135deg,#B45309,#F59E0B)}
.cover .brand{font-size:14px;letter-spacing:4px;opacity:.75;margin-bottom:18px}
.cover h1{font-size:34px;margin-bottom:10px}
.cover .meta{font-size:14px;opacity:.85;margin-top:14px;line-height:1.8}
h2.sec{font-size:20px;margin:38px 0 6px;padding-left:12px;border-left:5px solid #186BEB}
.page.train h2.sec{border-left-color:#F59E0B}
.subnote{font-size:12px;color:#7a8399;margin:0 0 14px 17px}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px}
.card{flex:1;min-width:150px;background:#f5f7fb;border:1px solid #e2e8f3;border-radius:10px;padding:14px 16px}
.card .k{font-size:12px;color:#7a8399}.card .v{font-size:28px;font-weight:700;margin:2px 0}.card .d{font-size:11px}
table{width:100%;border-collapse:collapse;margin:12px 0 6px;font-size:12.5px}
th{background:#186BEB;color:#fff;font-weight:600;padding:8px;text-align:center;white-space:nowrap}
.page.train th{background:#D97706}
td{padding:7px 8px;border-bottom:1px solid #e8edf5;text-align:center}
tr:nth-child(even) td{background:#f8fafd}
td.l,th.l{text-align:left}
.dgood{color:#1E8E4D;font-weight:700}.dbad{color:#C0392B;font-weight:700}.dflat{color:#7a8399}.dnull{color:#a9b2c4;font-size:11px}
.risk-high{display:inline-block;background:#C0392B;color:#fff;font-size:11px;border-radius:4px;padding:1px 7px}
.risk-mid{display:inline-block;background:#E67E22;color:#fff;font-size:11px;border-radius:4px;padding:1px 7px}
.risk-low{display:inline-block;background:#7a8399;color:#fff;font-size:11px;border-radius:4px;padding:1px 7px}
.bar-row{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:13px}
.bar-row .lb{width:34%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-row .track{flex:1;background:#eef1f6;border-radius:4px;height:20px;position:relative}
.bar-row .fill{height:100%;background:linear-gradient(90deg,#186BEB,#5a9cf8);border-radius:4px}
.bar-row .num{width:130px;font-size:12px;color:#5a6377}
.ai-block{background:#f8fafd;border:1px solid #e2e8f3;border-radius:10px;padding:18px 22px;margin:14px 0}
.ai-block h3{font-size:15px;color:#186BEB;margin-bottom:10px}
.ai-block ol,.ai-block ul{padding-left:20px}
.ai-block li{margin:7px 0;font-size:13.5px}
.ai-block.boss{background:#fdf6f4;border-color:#f2d8d2}.ai-block.boss h3{color:#C0392B}
.tcard{border:1px solid #e2e8f3;border-radius:12px;margin:14px 0;overflow:hidden}
.tcard .thead{background:#F59E0B;color:#fff;padding:9px 16px;font-weight:700;font-size:14px}
.tcard .trow{display:flex;border-top:1px solid #eef1f6;font-size:13.5px}
.tcard .tk{flex:0 0 110px;background:#fff7ec;font-weight:600;padding:10px 14px;color:#92400E}
.tcard .tv{flex:1;padding:10px 14px}
.checklist{background:#f2faf5;border:1px solid #cdebd8;border-radius:10px;padding:18px 22px;margin:14px 0}
.checklist h3{color:#1E8E4D;font-size:15px;margin-bottom:10px}
.checklist li{margin:8px 0;font-size:14px;list-style:none;padding-left:26px;position:relative}
.checklist li:before{content:"☐";position:absolute;left:0;color:#1E8E4D;font-size:16px}
.foot{margin-top:44px;padding-top:16px;border-top:1px dashed #dfe4ee;font-size:11px;color:#9aa3b5;display:flex;justify-content:space-between}
.toolbar{position:sticky;top:0;z-index:9;background:#fff;border-bottom:1px solid #e2e8f3;padding:10px 56px;display:flex;gap:10px;align-items:center;max-width:960px;margin:0 auto}
.toolbar button{border:none;border-radius:8px;padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer;color:#fff;background:#186BEB}
.toolbar .tip{font-size:12px;color:#7a8399}
@media print{body{background:#fff}.toolbar{display:none}.page{box-shadow:none;max-width:none;padding:24px 32px}}
`;

  function openReport(title, bodyHtml, trainMode){
    const nowTxt = new Date().toLocaleString('zh-CN',{hour12:false});
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${REPORT_CSS}</style></head><body>
<div class="toolbar"><button onclick="window.print()">🖨 打印 / 另存为 PDF</button><span class="tip">报告仅在本页显示，不占用电脑磁盘 · 打印时勾选「背景图形」</span></div>
<div class="page${trainMode?' train':''}">
${bodyHtml}
<div class="foot"><span>苍井寿司 · 培训部 · 内部资料</span><span>生成时间 ${esc(nowTxt)} · 慧运营看板自动生成</span></div>
</div></body></html>`;
    const w = window.open('', '_blank');
    if(!w) return null;
    w.document.open(); w.document.write(html); w.document.close();
    return w;
  }

  ov.querySelector('#expHtmlBtn').onclick = async ()=>{
    const btn = ov.querySelector('#expHtmlBtn');
    try{
      btn.disabled = true;
      const pr = prevRange();
      const isTrain = expMode==='train';

      stat('⏳ 1/3 提取「巡检问题汇总及整改跟进」数据…');
      const uq = await loadUnqData();
      const curEnts = unqEntriesForRange(uq, currentStart, currentEnd);
      const prevEnts = pr ? unqEntriesForRange(uq, pr.s, pr.e) : [];
      const prob = analyzeProblems(curEnts, prevEnts);
      if(!prob.items.length){ stat('❌ 该区间没有问题数据，换个区间试试'); return; }

      const selTypes = TYPES.filter(t=>expTypes.has(t));
      const needScores = !isTrain && selTypes.length>0;
      let datasets = [], prev = null, pvGroup = ()=>null;
      if(needScores){
        stat('⏳ 2/3 加载组别指标与环比…');
        datasets = selTypes.map(collect).filter(Boolean);
        try{ prev = await loadPrev(); }catch(e){}
        pvGroup = (type, gname)=>{ if(!prev) return null; const t = prev.byType.find(x=>x&&x.type===type); if(!t) return null; return t.groups.find(g=>g.name===gname)||null; };
      } else { stat('⏳ 2/3 跳过组别指标（本视角不需要）…'); }

      /* ===== 培训版（课件） ===== */
      if(isTrain){
        stat('⏳ 3/3 智谱 AI 生成教学卡与自查清单…');
        let ai = null;
        try{ ai = await aiTrain(prob); }catch(e){ stat('⚠️ AI 失败（'+e.message+'），生成无教学卡版课件'); }
        const rangeTxt = `${currentStart} ~ ${currentEnd}`;
        const h = [];
        h.push(`<div class="cover train"><div class="brand">CANGJING SUSHI · 苍井寿司</div>
<h1>门店食品安全专项培训课件</h1>
<div class="meta">面向：加盟商 · 门店伙伴　|　数据区间 ${esc(rangeTxt)}<br>内容依据：本期真实巡检发现（${prob.total} 条不合格记录）· 国家食品安全法律法规 · 由培训部整理</div></div>`);
        if(ai && ai['痛点开场'] && ai['痛点开场'].length){
          h.push(`<div style="background:#7c2d12;color:#fff;border-radius:12px;padding:22px 26px;margin:18px 0">
<div style="font-size:17px;font-weight:800;margin-bottom:10px">开场 · 先算一笔你自己的账</div>
<ol style="margin:0;padding-left:20px;line-height:1.9">${ai['痛点开场'].map(l=>`<li>${esc(l.replace(/^[·•\-0-9.、\s]+/,''))}</li>`).join('')}</ol>
<div style="margin-top:10px;font-size:12.5px;opacity:.85">食品安全从来不是"公司找麻烦"——上面每一条罚款、每一次停业，都是国家法律白纸黑字写着的，砸的是你自己的营业额。</div></div>`);
        }
        const top3 = prob.items.slice(0,3);
        h.push(`<h2 class="sec"><span style="color:#F59E0B">01</span>　上一期，我们的门店真实发生了什么</h2>
<div class="subnote">下面不是编的案例，全部来自本期巡检现场记录</div>
<div class="cards">
<div class="card"><div class="k">巡检发现的问题</div><div class="v" style="color:#C0392B">${prob.total}</div><div class="d">涉及 ${prob.items.length} 类问题 · ${new Set(curEnts.map(x=>x.sn)).size} 家门店</div></div>
<div class="card"><div class="k">最高频的问题</div><div class="v" style="font-size:15px;padding-top:8px">${esc(top3[0]?top3[0].t:'-')}</div><div class="d">出现了 ${top3[0]?top3[0].count:0} 次 · ${top3[0]?top3[0].storeCount:0} 家门店</div></div>
<div class="card"><div class="k">同一问题出现2次以上的门店</div><div class="v" style="color:#C0392B">${prob.repeats.length}</div><div class="d">说明上次改了又犯，这次重点讲</div></div>
</div>`);
        h.push(`<h2 class="sec"><span style="color:#F59E0B">02</span>　高频问题教学卡 · 每一条都有法可依</h2>
<div class="subnote">每张卡：真实发生 → 踩了哪条国家法规 → 疼在哪 → 正确做法 → 每天自查。建议店内晨会逐条过一遍</div>`);
        if(ai && ai['教学卡'] && ai['教学卡'].length){
          ai['教学卡'].forEach(card=>{
            const p = card.split('｜');
            const title = (p[0]||'').replace(/^[·•\-0-9.、\s]+/,'');
            const it = prob.items.find(x=> x.t.indexOf(title.trim())>=0 || title.indexOf(x.t.slice(0,6))>=0 ) ||
                       prob.items.find(x=> title && x.t.slice(0,4)===title.slice(0,4));
            const row = (k,v,style)=> v?`<div class="trow"${style?` ${style}`:''}><div class="tk">${k}</div><div class="tv">${v}</div></div>`:'';
            h.push(`<div class="tcard"><div class="thead">📋 ${esc(title)}</div>
${row('真实发生', esc(p[1]||''))}
${row('踩了哪条法规', p[2]?`<span style="background:#fdecea;color:#C0392B;border-radius:4px;padding:2px 8px;font-weight:600">${esc(p[2])}</span>`:'')}
${row('疼在哪（这笔账）', p[3]?esc(p[3]):'')}
${row('正确做法', esc(p[4]||''))}
${row('门店自查', esc(p[5]||p.slice(3).join('｜')||''))}
${it && it.kw && it.kw.length?`<div class="trow"><div class="tk">本期情形拆解</div><div class="tv">${it.kw.map(k=>`<span style="display:inline-block;background:#fff1e0;color:#B26A00;border-radius:4px;padding:1px 8px;margin:2px 4px 2px 0;font-size:12px;font-weight:600">${esc(k[0])} ×${k[1]}</span>`).join('')}${it.topDescs&&it.topDescs.length?`<div style="color:#777;font-size:12px;margin-top:4px">典型记录：${esc(it.topDescs[0].d)}${it.topDescs[0].n>1?`（${it.topDescs[0].n} 次一模一样的描述）`:''}</div>`:''}</div></div>`:''}
</div>`);
          });
        } else {
          /* 无AI兜底：静态法规映射 */
          const lawFor = t=>{
            const s = String(t||'');
            if(/过期|变质|腐败|发霉|异味|异物|三文鱼|食材/.test(s)) return '《食品安全法》第34条：禁止经营超过保质期、腐败变质、混有异物的食品';
            if(/温度|冷藏|冷冻|冰箱|解冻|储存|存放/.test(s)) return '《食品安全法》第54条：按保证食品安全的要求贮存食品 · GB 31654-2021 冷藏规范';
            if(/健康证/.test(s)) return '《食品安全法》第45条：接触直接入口食品的从业人员必须持有效健康证明上岗';
            if(/留样/.test(s)) return 'GB 31654-2021：留样专用密闭容器冷藏存放48小时以上，每品种不少于125g并记录';
            if(/工衣|帽子|口罩|仪容|着装|头发|手套|洗手/.test(s)) return 'GB 31654-2021：从业人员应保持个人卫生，穿戴清洁的工作衣、帽、口罩';
            if(/离墙离地|先进先出/.test(s)) return '餐饮服务食品安全操作规范：离墙离地10cm以上、分类分架、先进先出';
            return '《食品安全法》第126条：未落实食品安全管理要求，拒不改正可罚5千～5万元、情节严重停产停业';
          };
          prob.items.slice(0,6).forEach(x=>{
            h.push(`<div class="tcard"><div class="thead">📋 ${esc(x.t)}（本期 ${x.count} 次）</div>
<div class="trow"><div class="tk">踩了哪条法规</div><div class="tv"><span style="background:#fdecea;color:#C0392B;border-radius:4px;padding:2px 8px;font-weight:600">${esc(lawFor(x.t))}</span></div></div>
<div class="trow"><div class="tk">真实情形</div><div class="tv">${esc(x.descs[0]||'见巡检照片记录')}</div></div>
${x.kw && x.kw.length?`<div class="trow"><div class="tk">情形拆解</div><div class="tv">${x.kw.map(k=>`<span style="display:inline-block;background:#fff1e0;color:#B26A00;border-radius:4px;padding:1px 8px;margin:2px 4px 2px 0;font-size:12px;font-weight:600">${esc(k[0])} ×${k[1]}</span>`).join('')}</div></div>`:''}
<div class="trow"><div class="tk">涉及门店</div><div class="tv">${x.storeCount} 家 · 集中在 ${esc(x.topRegion[0])} · 组别：${esc(x.groupDist)}</div></div></div>`);
          });
        }
        h.push(`<h2 class="sec"><span style="color:#F59E0B">03</span>　门店每日自查清单 · 打卡执行</h2>`);
        if(ai && ai['每日自查清单'] && ai['每日自查清单'].length){
          h.push(`<div class="checklist"><h3>✅ 每天开店前 / 收市后各过一遍</h3><ul>${ai['每日自查清单'].map(l=>`<li>${esc(l.replace(/^[·•\-0-9.、\s]+/,''))}</li>`).join('')}</ul></div>`);
        }
        if(ai && ai['给加盟商的话'] && ai['给加盟商的话'].length){
          h.push(`<h2 class="sec"><span style="color:#F59E0B">04</span>　给加盟商伙伴的三句话</h2>
<div class="ai-block"><h3>💬 加盟商管理动作</h3><ul>${ai['给加盟商的话'].map(l=>`<li>${esc(l.replace(/^[·•\-0-9.、\s]+/,''))}</li>`).join('')}</ul></div>`);
        }
        if(prob.repeats.length){
          h.push(`<h2 class="sec"><span style="color:#F59E0B">05</span>　改了又犯的门店 · 请店长重点对照</h2>
<div class="subnote">以下门店同一问题出现 2 次以上——不是不会做，是没当回事。晨会请点名复盘</div>
<table><tr><th class="l">门店</th><th>区域</th><th class="l">重复的问题</th><th>出现次数</th><th class="l">具体情况</th></tr>`);
          prob.repeats.slice(0,12).forEach(x=>{
            const detail = x.kw && x.kw.length ? x.kw.slice(0,5).map(k=>`${k[0]}×${k[1]}`).join(' · ') : (x.topDescs||[]).join('；');
            h.push(`<tr><td class="l"><b>${esc(x.sn)}</b></td><td>${esc(x.rg)}</td><td class="l">${esc(x.t)}</td><td><span class="risk-high">${x.times} 次</span></td><td class="l" style="font-size:12px;color:#666">${esc(detail||'-')}</td></tr>`);
          });
          h.push('</table>');
        }
        /* 06 法规红线（静态·国家明文规定） */
        h.push(`<h2 class="sec"><span style="color:#F59E0B">06</span>　法规红线 · 这些不是公司规定，是国家明文规定</h2>
<div class="subnote">《中华人民共和国食品安全法》及国家标准《餐饮服务通用卫生规范》（GB 31654-2021）· 培训部依据国家现行有效版本整理</div>
<table><tr><th style="width:26%">法规条款</th><th class="l" style="width:40%">国家是怎么规定的</th><th class="l">违反的代价（白纸黑字）</th></tr>
<tr><td><b>食安法 第34条</b></td><td class="l" style="font-size:12.5px">禁止生产经营腐败变质、霉变生虫、混有异物、感官性状异常的食品；<b>超过保质期的食品</b></td><td class="l" style="font-size:12.5px">第124条：没收违法所得；货值不足1万的罚 <b style="color:#C0392B">5万～10万</b>；货值1万以上罚货值 <b style="color:#C0392B">10～20倍</b></td></tr>
<tr><td><b>食安法 第45条</b></td><td class="l" style="font-size:12.5px">接触直接入口食品的从业人员<b>每年健康检查、持有效健康证明</b>上岗；有碍食品安全疾病的不得上岗</td><td class="l" style="font-size:12.5px">第126条：责令改正、警告；拒不改正罚 <b style="color:#C0392B">5千～5万</b>，情节严重<b style="color:#C0392B">停产停业直至吊销许可证</b></td></tr>
<tr><td><b>食安法 第54条</b></td><td class="l" style="font-size:12.5px">按要求贮存食品，<b>定期检查库存，及时清理变质或超过保质期的食品</b></td><td class="l" style="font-size:12.5px">同上第126条；造成事故的按第124条重罚并承担民事赔偿</td></tr>
<tr><td><b>食安法 第135条</b></td><td class="l" style="font-size:12.5px">因食品安全犯罪被判处有期徒刑以上刑罚的，<b>终身不得从事食品生产经营管理工作</b></td><td class="l" style="font-size:12.5px"><b style="color:#C0392B">终身行业禁入</b>——这不是罚款能了的事</td></tr>
<tr><td><b>GB 31654-2021</b></td><td class="l" style="font-size:12.5px">从业人员保持个人卫生，<b>穿戴清洁的工作衣、帽、口罩</b>；留样食品专用密闭容器<b>冷藏存放48小时以上</b>，每品种<b>不少于125g</b>并记录</td><td class="l" style="font-size:12.5px">属食品安全国家标准，监管部门日常检查必查项，不符合即责令整改并记录在案</td></tr>
<tr><td><b>餐饮服务食品安全操作规范</b></td><td class="l" style="font-size:12.5px">食品贮存<b>离墙离地10cm以上</b>、分类分架、<b>先进先出</b>；冷藏熟制食品使用清洁密闭容器</td><td class="l" style="font-size:12.5px">日常监督检查量化分级降级，直接影响<b style="color:#C0392B">餐饮量化等级和平台公示</b></td></tr>
<tr><td><b>食安法 第126条（培训义务）</b></td><td class="l" style="font-size:12.5px">未按规定对从业人员进行<b>食品安全培训和考核</b>，同样违法</td><td class="l" style="font-size:12.5px">警告→拒不改正罚 <b style="color:#C0392B">5千～5万</b>——所以这份课件不是走形式，是法定义务</td></tr>
</table>
<div style="margin-top:12px;background:#fdecea;border-radius:8px;padding:12px 16px;font-size:13px;color:#7c2d12"><b>讲师提示：</b>给加盟商讲这一页时，直接说透——"这些条款罚的不是公司，执照是你的、罚款单开给的是你的店。一次执法抽检不合格，外卖平台下架、美团评分腰斩、周边三公里口碑清零，恢复要半年。做好这些只需要每天花10分钟按清单自查。"</div>`);
        const w = openReport(`苍井寿司门店食品安全专项培训课件 ${currentStart}~${currentEnd}`, h.join('\n'), true);
        stat(w ? '✅ 培训课件已在新窗口打开！含教学卡'+(ai&&ai['教学卡']?ai['教学卡'].length:0)+'张 · 可直接打印或截图进 PPT' : '❌ 浏览器拦截了新窗口，请允许弹出后重试');
        return;
      }

      /* ===== 老板版（经营决策） ===== */
      stat('⏳ 3/3 智谱 AI 经营决策分析…');
      const aiProb = {
        总量:{ 不合格记录:prob.total, 问题项数:prob.items.length, 关键食安问题条数:prob.level.C, 流程执行问题条数:prob.level.M, 一般问题条数:prob.level.L, 整改闭环率估算:prob.loopRate+'%' },
        高发问题: prob.items.slice(0,15).map(x=>({ 问题:x.t, 分级:x.level, 次数:x.count, 门店数:x.storeCount, 最集中区域:x.topRegion[0], 组别分布:x.groupDist, 环比:x.delta, 情形拆解:x.kw, 典型情形:x.descs[0] })),
        重复出问题的门店: prob.repeats.slice(0,12).map(x=>`${x.sn}(${x.ps})「${x.t}」${x.times}次`),
        问题最集中门店: prob.worstStores
      };
      let ai = null;
      try{ ai = await aiBoss(aiProb, prev?prev.range.s+' ~ '+prev.range.e:'', needScores); }
      catch(e){ stat('⚠️ AI 失败（'+e.message+'），先生成无 AI 章节报告'); }
      if(ai && (!ai['经营层结论'] || !ai['经营层结论'].length)) ai = null;

      const rangeTxt = `${currentStart} ~ ${currentEnd}`;
      const h = [];
      h.push(`<div class="cover boss"><div class="brand">CANGJING SUSHI · 苍井寿司</div>
<h1>品牌巡检审计报告</h1>
<div class="meta">经营决策版　|　统计区间 ${esc(rangeTxt)}${prev?'　·　环比上一周期 '+esc(prev.range.s+' ~ '+prev.range.e):''}<br>方法对标：国际连锁餐饮审计体系（问题分级 / 整改闭环 / 复检触发）· 培训部出品</div></div>`);

      const critPct = prob.total ? Math.round(prob.level.C/prob.total*1000)/10 : 0;
      h.push(`<h2 class="sec"><span style="color:#186BEB">01</span>　经营层结论仪表盘</h2>
<div class="cards">
<div class="card"><div class="k">不合格记录总量</div><div class="v">${prob.total}</div><div class="d">涉及 ${prob.items.length} 类问题</div></div>
<div class="card"><div class="k">Critical 关键食安问题</div><div class="v" style="color:#C0392B">${prob.level.C}</div><div class="d">占比 ${critPct}% · 72小时整改窗口</div></div>
<div class="card"><div class="k">整改闭环率</div><div class="v" style="color:${prob.loopRate<90?'#C0392B':'#1E8E4D'}">${prob.loopRate}%</div><div class="d">已闭环记录÷问题记录总数 · ${prob.notClosed} 条记录改了又犯（${prob.repeats.length} 家门店）</div></div>
<div class="card"><div class="k">风险最集中门店</div><div class="v" style="font-size:17px;padding-top:7px">${esc(prob.worstStores[0]?prob.worstStores[0].sn:'-')}</div><div class="d">${prob.worstStores[0]?prob.worstStores[0].count+' 条记录':'-'}</div></div>
</div>`);
      if(ai && ai['经营层结论'] && ai['经营层结论'].length){
        h.push(`<div class="ai-block boss"><h3>📌 经营层结论（结论先行）</h3><ol>${ai['经营层结论'].map(l=>`<li>${esc(l.replace(/^[·•\-0-9.、\s]+/,''))}</li>`).join('')}</ol></div>`);
      }

      h.push(`<h2 class="sec"><span style="color:#186BEB">02</span>　问题分级清单</h2>
<div class="subnote">Critical = 直接食安风险（温度/过期/交叉污染/虫鼠害/异物），72小时整改窗口 · Moderate = 流程执行缺陷，30天窗口 · Minor = 纳入例行辅导；同问题第二次出现即升级为系统性问题</div>
<table><tr><th style="width:12%">分级</th><th class="l" style="width:34%">问题项</th><th>次数</th><th>门店数</th><th>最集中区域</th><th>环比</th></tr>`);
      prob.items.slice(0,15).forEach(x=>{
        const lv = LV[x.level];
        const kwTxt = x.kw && x.kw.length ? `<div style="font-size:11.5px;color:#888;margin-top:2px">情形拆解：${x.kw.slice(0,6).map(k=>`${esc(k[0])}×${k[1]}`).join(' · ')}</div>` : '';
        h.push(`<tr><td><span class="${lv.cls}">${x.level}</span></td><td class="l" title="${esc(x.descs[0]||'')}">${esc(x.t)}${kwTxt}</td><td><b>${x.count}</b></td><td>${x.storeCount}</td><td>${esc(x.topRegion[0])}</td><td>${x.delta==null?'<span class="dnull">无上期</span>':(x.delta>0?`<span class="dbad">+${x.delta}</span>`:(x.delta<0?`<span class="dgood">${x.delta}</span>`:'<span class="dflat">持平</span>'))}</td></tr>`);
      });
      h.push('</table>');
      const withDesc = prob.items.filter(x=>x.descs.length).slice(0,6);
      if(withDesc.length){
        h.push(`<div class="subnote" style="margin-top:12px"><b style="color:#1A2A4A">现场证据摘录</b>（检查员原始记录）</div>
<div class="ai-block"><ul>${withDesc.map(x=>`<li><b>${esc(x.t)}</b>（${x.count}次）：${esc(x.descs[0])}</li>`).join('')}</ul></div>`);
      }

      h.push(`<h2 class="sec"><span style="color:#186BEB">03</span>　整改闭环审计 · 改了又犯的门店</h2>
<div class="subnote">同一门店同一问题出现 ≥2 份报告 = 上一次整改未闭环。国际连锁品牌将此视作最严重信号：第二次出现按系统性问题升级处理</div>`);
      if(prob.repeats.length){
        h.push(`<table><tr><th class="l">门店</th><th>组别</th><th>区域</th><th class="l">重复问题</th><th>分级</th><th>次数</th><th class="l">具体情况</th></tr>`);
        prob.repeats.slice(0,15).forEach(x=>{
          const lv = LV[x.level]||LV.L;
          const detail = x.kw && x.kw.length ? x.kw.slice(0,5).map(k=>`${k[0]}×${k[1]}`).join(' · ') : (x.topDescs||[]).join('；');
          h.push(`<tr><td class="l"><b>${esc(x.sn)}</b></td><td>${esc(x.ps)}</td><td>${esc(x.rg)}</td><td class="l">${esc(x.t)}</td><td><span class="${lv.cls}">${x.level}</span></td><td><span class="risk-high">${x.times} 次</span></td><td class="l" style="font-size:12px;color:#666">${esc(detail||'-')}</td></tr>`);
        });
        h.push('</table>');
      } else {
        h.push('<div class="ai-block" style="color:#1E8E4D">✅ 本期未发现重复未闭环问题。</div>');
      }

      if(needScores && datasets.length){
        h.push(`<h2 class="sec"><span style="color:#186BEB">04</span>　巡检数据表</h2>
<div class="subnote">覆盖率 = 已巡检门店 ÷ 应巡检门店；门店合格率 = 达标门店 ÷ 已巡检门店（达标线：直营/新店 90 分，加盟营运 80 分）· 环比为上一等长周期</div>`);
        datasets.forEach(d=>{
          h.push(`<div style="font-size:14px;font-weight:700;margin:16px 0 4px">巡检项目：${esc(d.name)}</div>
<table><tr><th class="l">组别</th><th>门店</th><th>巡检覆盖率</th><th>门店合格率</th><th>平均分</th><th>平均分环比</th></tr>`);
          d.groups.forEach(g=>{
            const pv = pvGroup(d.type, g.name);
            h.push(`<tr><td class="l">${esc(g.name)}</td><td>${g.storeCount}</td><td>${g.coverage}%（${g.covered}/${g.storeCount}）</td><td>${g.passRate}%（${g.passStores}/${g.scoredCount}）</td><td>${g.avgScore}</td><td>${pv?deltaBadge(g.avgScore,pv.avgScore):'<span class="dnull">无上期</span>'}</td></tr>`);
          });
          h.push('</table>');
        });
      }

      if(ai){
        const blk = (k,tit)=> ai[k]&&ai[k].length ? `<div class="ai-block ${k==='经营层结论'?'boss':''}"><h3>${tit}</h3><ol>${ai[k].map(l=>`<li>${esc(l.replace(/^[·•\-0-9.、\s]+/,''))}</li>`).join('')}</ol></div>` : '';
        h.push(`<h2 class="sec"><span style="color:#186BEB">05</span>　深度分析</h2>`);
        h.push(blk('系统性根因','🧩 系统性根因：为什么这些问题反复出现'));
        h.push(blk('风险敞口与分级','⚠️ 风险敞口与分级'));
      }

      if(ai && ai['决策建议'] && ai['决策建议'].length){
        h.push(`<h2 class="sec"><span style="color:#186BEB">06</span>　决策建议（机制化 · 责任到人）</h2>
<table><tr><th class="l" style="width:30%">决策</th><th class="l">负责机制 / 验证方式 / 不达标处置</th></tr>`);
        ai['决策建议'].forEach(l=>{
          const s = l.replace(/^[·•\-0-9.、\s]+/,'');
          const parts = s.split(/[；;：:｜|]/).map(x=>x.trim()).filter(Boolean);
          h.push(`<tr><td class="l"><b>${esc(parts[0]||'')}</b></td><td class="l">${esc(parts.slice(1).join('　|　'))}</td></tr>`);
        });
        h.push('</table>');
      }
      if(ai && ai['下周期承诺目标'] && ai['下周期承诺目标'].length){
        h.push(`<div class="ai-block" style="background:#f2faf5;border-color:#cdebd8"><h3 style="color:#1E8E4D">🎯 下周期承诺目标</h3><ul>${ai['下周期承诺目标'].map(l=>`<li>${esc(l.replace(/^[·•\-0-9.、\s]+/,''))}</li>`).join('')}</ul></div>`);
      }

      const allFails = [];
      datasets.forEach(d=>d.fails.forEach(f=>allFails.push({...f, src:d.name})));
      allFails.sort((a,b)=>a.score-b.score);
      if(allFails.length){
        h.push(`<h2 class="sec"><span style="color:#186BEB">${ai?'07':'05'}</span>　未达标门店清单（整改优先级）</h2>
<table><tr><th class="l">门店</th><th>组别</th><th>区域</th><th>平均分</th><th>达标线</th><th>差距</th><th>不合格项</th></tr>`);
        allFails.slice(0,15).forEach(f=>{ h.push(`<tr><td class="l"><b>${esc(f.name)}</b></td><td>${esc(f.pos)}</td><td>${esc(f.region||'-')}</td><td>${f.score}</td><td>${f.th}分</td><td><span class="dbad">${(f.score-f.th).toFixed(1)}</span></td><td>${f.unq}</td></tr>`); });
        h.push('</table>');
      }

      const w = openReport(`苍井寿司品牌巡检审计报告 ${currentStart}~${currentEnd}`, h.join('\n'), false);
      stat(w ? '✅ 老板版审计报告已在新窗口打开！'+(ai?'（含 AI 深度分析）':'（AI 章节缺失，请检查 Key）') : '❌ 浏览器拦截了新窗口，请允许弹出后重试');
    }catch(e){
      stat('❌ 生成失败：'+e.message);
      console.error(e);
    }finally{ btn.disabled=false; }
  };

  console.log('[export] 巡检报告模块已加载（大厂审计标准版 fix157，暗号模式）');
})();
