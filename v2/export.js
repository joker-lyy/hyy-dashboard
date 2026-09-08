/* ============================================================
 * export.js —— 隐藏报表输出模块（fix155：HTML 品牌巡检报告 + 问题导向深度分析）
 * 仅当 URL 带 ?key=888 时由 app.js 动态加载；普通访问/分享链接完全不加载。
 * fix155 变化：
 *   1) 放弃 PPT（pptxgenjs 排版差），改为生成排版好的独立 HTML 报告（新窗口打开，可一键打印成 PDF）
 *   2) 分析重心从"分数"转向"问题"：接入巡检问题汇总及整改跟进数据（unqualified_v2.json），
 *      提取高发问题项、重复出问题的门店（整改未落实证据）、问题在组别/区域的分布、
 *      问题项环比，再交给 AI 做【问题诊断→根因→培训部改善动作→老板想听的结论】
 *   3) 分数只做背景指标（覆盖率/合格率表保留），报告主线是问题与行动
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
  #expPanel{width:560px;max-width:92vw;max-height:88vh;overflow:auto;background:#fff;border-radius:14px;
    padding:22px 24px;box-shadow:0 12px 40px rgba(0,0,0,.35);color:#1a2a4a}
  #expPanel h3{margin:0 0 6px;font-size:18px}
  #expPanel .sub{color:#7a8399;font-size:12px;margin-bottom:14px}
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
      <h3>📊 品牌巡检报告输出</h3>
      <div class="sub">仅本机可见 · 问题导向深度分析（高发问题/重复问题门店/培训部改善动作）· 排版好的 HTML 报告，可打印成 PDF</div>
      <label>输出范围</label>
      <div class="chipbar" id="expTypeBar"></div>
      <div class="sub" id="expScope"></div>
      <div class="sec">
        <label>智谱 AI API Key（首次填写后存本机浏览器）</label>
        <input type="text" id="expKey" placeholder="粘贴你的智谱 API Key（glm-4-flash）">
      </div>
      <div class="row">
        <button class="act gray" id="expCsvBtn">① 导出数据 Excel</button>
        <button class="act" id="expHtmlBtn">② 生成品牌巡检分析报告</button>
      </div>
      <div id="expStat"></div>
    </div>`;
  document.body.appendChild(ov);

  let expType = curType();
  function renderChips(){
    const bar = ov.querySelector('#expTypeBar');
    const opts = [...TYPES, 'all'];
    bar.innerHTML = opts.map(t=>`<span class="chip${t===expType?' on':''}" data-t="${t}">${t==='all'?'全部四类':TAB_NAMES[t]}</span>`).join('');
    bar.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{ expType=c.dataset.t; renderChips(); renderScope(); });
  }
  function scopeText(){
    return `日期区间：${currentStart||'-'} ~ ${currentEnd||'-'}　|　环比周期：上一等长周期`;
  }
  function renderScope(){ ov.querySelector('#expScope').textContent = scopeText(); }
  renderChips(); renderScope();
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

  /* ---------- 基础指标抽取（分数只做背景） ---------- */
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
      const unq = pStores.reduce((a,s)=>a+num(s.unqualifiedItems),0);
      return {
        name: pname, th,
        storeCount: num(p.storeCount) || pStores.length,
        covered: withReport.length,
        coverage: (num(p.storeCount)||pStores.length)>0 ? Math.round(withReport.length/(num(p.storeCount)||pStores.length)*1000)/10 : 0,
        avgScore: num(p.avgScore),
        passStores, scoredCount: scored.length,
        passRate: scored.length ? Math.round(passStores/scored.length*1000)/10 : 0,
        unqItems: unq
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
   * 核心：巡检问题汇总及整改跟进数据深度提取（unqualified_v2.json）
   * entry 字段：d 日期 / t 问题项 / sn 门店 / rg 区域 / ps 组别 / rid 报告 / desc 描述
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
  function analyzeProblems(cur, prev){
    // 1) 高发问题项 Top：次数 / 涉及门店 / 区域分布 / 组别分布 / 样例描述 / 环比
    const map = new Map();
    cur.forEach(x=>{
      const key = (x.t||'-').trim();
      let g = map.get(key);
      if(!g){ g = { t:key, count:0, stores:new Set(), regions:new Map(), groups:new Map(), descs:[], srcs:new Map() }; map.set(key,g); }
      g.count++; g.stores.add(x.sn||'-');
      g.regions.set(x.rg||'-', (g.regions.get(x.rg||'-')||0)+1);
      g.groups.set(x.ps||'-', (g.groups.get(x.ps||'-')||0)+1);
      g.srcs.set(x.src, (g.srcs.get(x.src)||0)+1);
      if(x.desc && g.descs.length<3 && !g.descs.includes(x.desc)) g.descs.push(x.desc);
    });
    const pmap = new Map();
    (prev||[]).forEach(x=>{ const k=(x.t||'-').trim(); pmap.set(k,(pmap.get(k)||0)+1); });
    const items = [...map.values()].map(g=>({
      t:g.t, count:g.count, storeCount:g.stores.size,
      topRegion: [...g.regions.entries()].sort((a,b)=>b[1]-a[1])[0]||['-',0],
      groupDist: [...g.groups.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]+'×'+x[1]).slice(0,4).join('、'),
      descs:g.descs,
      prevCount: pmap.get(g.t)!=null ? pmap.get(g.t) : null
    })).sort((a,b)=>b.count-a.count);
    items.forEach(x=>x.delta = x.prevCount!=null ? x.count-x.prevCount : null);

    // 2) 重复出问题的门店（同一门店同一问题出现 ≥2 份报告 = 整改未落实）
    const repMap = new Map();
    cur.forEach(x=>{ const k=(x.sn||'-')+'||'+(x.t||'-').trim(); repMap.set(k,(repMap.get(k)||0)+1); });
    const repeats = [...repMap.entries()].filter(x=>x[1]>=2).map(x=>{
      const parts = x[0].split('||');
      const sample = cur.find(y=>y.sn===parts[0] && (y.t||'').trim()===parts[1]);
      return { sn:parts[0], t:parts[1], times:x[1], ps:sample?sample.ps:'-', rg:sample?sample.rg:'-' };
    }).sort((a,b)=>b.times-a.times);

    // 3) 问题门店排行（出现问题的门店按问题条数）
    const sMap = new Map();
    cur.forEach(x=>{ const k=x.sn||'-'; sMap.set(k, (sMap.get(k)||0)+1); });
    const worstStores = [...sMap.entries()].map(x=>{
      const sample = cur.find(y=>y.sn===x[0]);
      return { sn:x[0], count:x[1], ps:sample?sample.ps:'-', rg:sample?sample.rg:'-' };
    }).sort((a,b)=>b.count-a.count).slice(0,12);

    return { items, repeats, worstStores, total:cur.length };
  }

  /* ---------- Excel 导出 ---------- */
  ov.querySelector('#expCsvBtn').onclick = async ()=>{
    const list = expType==='all' ? TYPES.map(collect).filter(Boolean) : [collect(expType)].filter(Boolean);
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

  /* ---------- 智谱 AI：问题导向深度分析 ---------- */
  async function aiAnalysis(bg, problems, prevTxt){
    const key = (ov.querySelector('#expKey').value||'').trim();
    if(!key) throw new Error('请先填写智谱 API Key');
    localStorage.setItem('zhipu_api_key', key);
    const body = {
      model:'glm-4-flash', temperature:0.3, max_tokens:2600,
      messages:[
        {role:'system', content:`你是连锁寿司品牌（苍井寿司）培训部的资深分析顾问，报告对象是老板（经营分析会用）。
写报告的铁律：
- 分数只是既定事实，不要复述分数、不要说"平均分下降X分"这类废话；老板要听的是：品牌现在有什么食品安全问题、问题出在谁身上、为什么会反复出现、培训部接下来做什么动作把问题压下去。
- 所有判断必须带数据（问题次数、涉及门店数、环比变化、重复出现次数），不许空话。
- "培训部能做什么"必须是具体可落地的动作（专项培训/带教/考核/复检安排/材料更新），不写"加强管理""提高意识"这类套话。
严格按以下格式输出，不要额外寒暄：
【问题诊断】4-5条。每条格式"问题名：出现了N次/涉及M家门店（环比+X/-X）。集中出现在XX组别/区域，典型情形是……（引用描述）。风险等级：高/中"
【根因分析】3-4条。每条一句话，从数据推断根因（如：某问题在同一门店重复出现≥2次说明整改未闭环，是执行问题不是认知问题；某问题集中在某组别说明带教标准不一致等）
【培训部改善动作】5-6条。每条格式"第N周｜动作（具体到培训内容/对象/形式）｜覆盖对象｜衡量目标（量化，如该问题次数环比下降50%）"，用分号分隔字段
【给老板的结论】3条，结论先行、老板视角：品牌当前最大的食品安全风险是什么、整改闭环断在哪里、培训部承诺下周期达到什么结果`},
        {role:'user', content:'本期区间：'+currentStart+' ~ '+currentEnd+(prevTxt?('，环比周期：'+prevTxt):'，无环比数据')+
          '\n\n问题数据（巡检问题汇总及整改跟进提取）：\n'+JSON.stringify(problems, null, 1)+
          '\n\n背景指标（只供参考，不要复述）：\n'+JSON.stringify(bg, null, 1)}
      ]
    };
    const r = await fetch(AI_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body: JSON.stringify(body) });
    if(!r.ok) throw new Error('智谱接口返回 '+r.status);
    const j = await r.json();
    const txt = (j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content||'').trim();
    const seg = {};
    ['问题诊断','根因分析','培训部改善动作','给老板的结论'].forEach(k=>{
      const m = txt.match(new RegExp('【'+k+'】([\\s\\S]*?)(?=【|$)'));
      seg[k] = m ? m[1].split('\n').map(l=>l.trim()).filter(Boolean) : [];
    });
    return seg;
  }

  /* ============================================================
   * HTML 报告生成（排版好的独立文档，新窗口打开，可打印 PDF）
   * ============================================================ */
  const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function deltaBadge(cur, pv, goodWhenDown){
    if(pv==null || !isFinite(pv)) return '<span class="dnull">无上期</span>';
    const d = Math.round((cur-pv)*10)/10;
    if(d===0) return '<span class="dflat">持平</span>';
    const down = d<0;
    const good = goodWhenDown ? down : !down;
    return `<span class="${good?'dgood':'dbad'}">${d>0?'+':''}${d}</span>`;
  }

  ov.querySelector('#expHtmlBtn').onclick = async ()=>{
    const btn = ov.querySelector('#expHtmlBtn');
    try{
      const datasets = expType==='all' ? TYPES.map(collect).filter(Boolean) : [collect(expType)].filter(Boolean);
      if(!datasets.length){ stat('❌ 数据还没加载完，稍等几秒再试'); return; }
      btn.disabled = true;
      stat('⏳ 1/3 提取「巡检问题汇总及整改跟进」数据…');
      const pr = prevRange();
      const uq = await loadUnqData();
      const curEnts = unqEntriesForRange(uq, currentStart, currentEnd);
      const prevEnts = pr ? unqEntriesForRange(uq, pr.s, pr.e) : [];
      const prob = analyzeProblems(curEnts, prevEnts);

      stat('⏳ 2/3 重算上一周期背景指标…');
      let prev = null;
      try{ prev = await loadPrev(); }catch(e){ console.warn('prev load failed', e); }
      const prevTxt = prev ? (prev.range.s+' ~ '+prev.range.e) : '';

      stat('⏳ 3/3 智谱 AI 深度分析中…（问题诊断/根因/培训部动作/老板结论）');
      const pvGroup = (type, gname)=>{ const t = prev && prev.byType.find(x=>x&&x.type===type); if(!t) return null; return t.groups.find(g=>g.name===gname)||null; };
      const bg = {
        达标线: '直营90/新店90/加盟营运80',
        板块: datasets.map(d=>({
          名称:d.name,
          组别: d.groups.map(g=>{
            const pv = pvGroup(d.type, g.name);
            return { 组别:g.name, 覆盖率:g.coverage+'%', 门店合格率:g.passRate+'%',
              环比: pv ? { 平均分: Math.round((g.avgScore-pv.avgScore)*100)/100, 合格率pp: Math.round((g.passRate-pv.passRate)*10)/10, 不合格项: g.unqItems-pv.unqItems } : '无上期' };
          }),
          未达标门店: d.fails.map(f=>`${f.name}(${f.score}分,线${f.th},不合格${f.unq}项)`)
        }))
      };
      let ai = null;
      try{ ai = await aiAnalysis(bg, { 高发问题: prob.items.slice(0,15), 重复出现问题的门店: prob.repeats.slice(0,12), 问题最集中的门店: prob.worstStores }, prevTxt); }
      catch(e){ stat('⚠️ AI 分析失败（'+e.message+'），先生成无 AI 章节的报告'); }
      if(ai && (!ai['问题诊断'] || !ai['问题诊断'].length)) ai = null;

      stat('🧩 渲染 HTML 报告…');

      /* ---- 组装报告 HTML ---- */
      const rangeTxt = `${currentStart} ~ ${currentEnd}`;
      const nowTxt = new Date().toLocaleString('zh-CN',{hour12:false});
      const h = [];
      h.push(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>苍井寿司品牌巡检分析报告 ${rangeTxt}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#1a2a4a;background:#eef1f6;line-height:1.65}
.page{max-width:960px;margin:0 auto;background:#fff;padding:48px 56px;box-shadow:0 0 24px rgba(0,0,0,.08)}
.cover{background:linear-gradient(135deg,#1A2A4A,#186BEB);color:#fff;margin:-48px -56px 40px;padding:56px}
.cover .brand{font-size:14px;letter-spacing:4px;opacity:.75;margin-bottom:18px}
.cover h1{font-size:34px;margin-bottom:10px}
.cover .meta{font-size:14px;opacity:.85;margin-top:14px}
h2.sec{font-size:20px;margin:38px 0 6px;padding-left:12px;border-left:5px solid #186BEB;color:#1A2A4A}
h2.sec .no{color:#186BEB;margin-right:8px}
.subnote{font-size:12px;color:#7a8399;margin:0 0 14px 17px}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px}
.card{flex:1;min-width:150px;background:#f5f7fb;border:1px solid #e2e8f3;border-radius:10px;padding:14px 16px}
.card .k{font-size:12px;color:#7a8399}
.card .v{font-size:28px;font-weight:700;margin:2px 0}
.card .d{font-size:11px}
table{width:100%;border-collapse:collapse;margin:12px 0 6px;font-size:12.5px}
th{background:#186BEB;color:#fff;font-weight:600;padding:8px 8px;text-align:center;white-space:nowrap}
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
.bar-row .num{width:120px;font-size:12px;color:#5a6377}
.ai-block{background:#f8fafd;border:1px solid #e2e8f3;border-radius:10px;padding:18px 22px;margin:14px 0}
.ai-block h3{font-size:15px;color:#186BEB;margin-bottom:10px}
.ai-block ol{padding-left:20px}
.ai-block li{margin:7px 0;font-size:13.5px}
.ai-block.action{background:#f2faf5;border-color:#cdebd8}
.ai-block.action h3{color:#1E8E4D}
.ai-block.boss{background:#fdf6f4;border-color:#f2d8d2}
.ai-block.boss h3{color:#C0392B}
.foot{margin-top:44px;padding-top:16px;border-top:1px dashed #dfe4ee;font-size:11px;color:#9aa3b5;display:flex;justify-content:space-between}
.toolbar{position:sticky;top:0;z-index:9;background:#fff;border-bottom:1px solid #e2e8f3;padding:10px 56px;display:flex;gap:10px;align-items:center;max-width:960px;margin:0 auto}
.toolbar button{border:none;border-radius:8px;padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer;color:#fff;background:#186BEB}
.toolbar .tip{font-size:12px;color:#7a8399}
@media print{body{background:#fff}.toolbar{display:none}.page{box-shadow:none;max-width:none;padding:24px 32px}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">🖨 打印 / 另存为 PDF</button><span class="tip">报告仅本机生成 · 建议用 Chrome 打印，边距选「默认」、勾选「背景图形」</span></div>
<div class="page">
<div class="cover"><div class="brand">CANGJING SUSHI · 苍井寿司</div>
<h1>品牌巡检分析报告</h1>
<div class="meta">统计区间 ${esc(rangeTxt)}${prevTxt?'　·　环比上一周期 '+esc(prevTxt):''}<br>数据来源：慧运营巡检（常规/自检/视频/AI慧检）+ 巡检问题汇总及整改跟进 · 生成时间 ${esc(nowTxt)} · 培训部出品</div></div>`);

      /* 01 执行摘要：结论先行的卡片 */
      const totalUnq = prob.total;
      const repeatCnt = prob.repeats.reduce((a,x)=>a+x.times,0);
      let cov={c:0,n:0}, pass={p:0,s:0};
      datasets.forEach(d=>d.groups.forEach(g=>{ cov.c+=g.covered; cov.n+=g.storeCount; pass.p+=g.passStores; pass.s+=g.scoredCount; }));
      h.push(`<h2 class="sec"><span class="no">01</span>执行摘要 · 这一期品牌发生了什么</h2>
<div class="subnote">分数只是既定事实，本报告的核心是：问题出在哪、为什么反复、培训部怎么做</div>
<div class="cards">
<div class="card"><div class="k">巡检不合格记录总数</div><div class="v">${totalUnq}</div><div class="d">覆盖 ${prob.items.length} 个不同问题项</div></div>
<div class="card"><div class="k">重复出现的整改漏洞</div><div class="v" style="color:#C0392B">${prob.repeats.length}</div><div class="d">同一门店同一问题出现≥2次，共 ${repeatCnt} 条记录</div></div>
<div class="card"><div class="k">问题最集中的门店</div><div class="v" style="font-size:18px;padding-top:6px">${esc(prob.worstStores[0]?prob.worstStores[0].sn:'-')}</div><div class="d">${prob.worstStores[0]?('共 '+prob.worstStores[0].count+' 条不合格记录'):'-'}</div></div>
<div class="card"><div class="k">门店覆盖率 / 合格率</div><div class="v" style="font-size:20px;padding-top:4px">${cov.n?Math.round(cov.c/cov.n*1000)/10:0}% / ${pass.s?Math.round(pass.p/pass.s*1000)/10:0}%</div><div class="d">合格线：直营/新店90 · 加盟营运80</div></div>
</div>`);

      /* 02 高发问题提取分析（核心章节） */
      h.push(`<h2 class="sec"><span class="no">02</span>巡检问题提取分析 · 高发问题 Top 10</h2>
<div class="subnote">提取自「巡检问题汇总及整改跟进」全部四类巡检 · 括号内为环比上一等长周期出现次数变化</div>`);
      const top10 = prob.items.slice(0,10);
      const maxC = Math.max(...top10.map(x=>x.count),1);
      top10.forEach(x=>{
        const dl = x.delta==null ? '<span class="dnull">无上期</span>' : (x.delta===0?'<span class="dflat">持平</span>':(x.delta>0?`<span class="dbad">▲+${x.delta}（恶化）</span>`:`<span class="dgood">▼${x.delta}（改善）</span>`));
        h.push(`<div class="bar-row"><div class="lb" title="${esc(x.t)}">${esc(x.t)}</div>
<div class="track"><div class="fill" style="width:${Math.round(x.count/maxC*100)}%"></div></div>
<div class="num">${x.count} 次 · ${x.storeCount} 家门店 · ${dl}</div></div>`);
      });
      h.push(`<table><tr><th class="l" style="width:34%">问题项</th><th>次数</th><th>涉及门店</th><th>最集中区域</th><th class="l">组别分布</th><th>环比</th></tr>`);
      top10.forEach(x=>{
        h.push(`<tr><td class="l" title="${esc((x.descs[0]||''))}">${esc(x.t)}</td><td><b>${x.count}</b></td><td>${x.storeCount}</td><td>${esc(x.topRegion[0])}(${x.topRegion[1]})</td><td class="l" style="font-size:11.5px">${esc(x.groupDist)}</td><td>${x.delta==null?'<span class="dnull">无上期</span>':(x.delta>0?`<span class="dbad">+${x.delta}</span>`:(x.delta<0?`<span class="dgood">${x.delta}</span>`:'<span class="dflat">持平</span>'))}</td></tr>`);
      });
      h.push('</table>');
      // 典型问题描述摘录
      const withDesc = prob.items.filter(x=>x.descs.length).slice(0,6);
      if(withDesc.length){
        h.push(`<div class="subnote" style="margin-top:14px"><b style="color:#1A2A4A">典型问题描述摘录</b>（一线检查员原话，帮助理解问题实际情形）</div>
<div class="ai-block"><ol>${withDesc.map(x=>`<li><b>${esc(x.t)}</b>（${x.count}次）：${esc(x.descs[0])}</li>`).join('')}</ol></div>`);
      }

      /* 03 整改闭环分析：重复出现的问题门店 */
      h.push(`<h2 class="sec"><span class="no">03</span>整改闭环分析 · 重复出问题的门店（整改未落实证据）</h2>
<div class="subnote">同一门店同一问题在区间内出现 ≥2 份报告 → 说明上一次整改没有落地，是执行问题不是认知问题</div>`);
      if(prob.repeats.length){
        h.push(`<table><tr><th class="l">门店</th><th>组别</th><th>区域</th><th>重复问题</th><th>出现次数</th></tr>`);
        prob.repeats.slice(0,15).forEach(x=>{
          h.push(`<tr><td class="l"><b>${esc(x.sn)}</b></td><td>${esc(x.ps)}</td><td>${esc(x.rg)}</td><td class="l">${esc(x.t)}</td><td><span class="risk-high">${x.times} 次</span></td></tr>`);
        });
        h.push('</table>');
      } else {
        h.push('<div class="ai-block" style="color:#1E8E4D">✅ 本期未发现同一门店同一问题重复出现 2 次以上的情况，整改闭环情况良好。</div>');
      }
      // 问题最集中的门店
      h.push(`<div class="subnote" style="margin-top:16px"><b style="color:#1A2A4A">不合格记录最集中的门店 Top 12</b></div>
<table><tr><th class="l">门店</th><th>组别</th><th>区域</th><th>不合格记录数</th></tr>`);
      prob.worstStores.forEach(x=>{ h.push(`<tr><td class="l">${esc(x.sn)}</td><td>${esc(x.ps)}</td><td>${esc(x.rg)}</td><td>${x.count}</td></tr>`); });
      h.push('</table>');

      /* 04 巡检数据表（统一口径：组别/门店/覆盖率/门店合格率/平均分/平均分环比） */
      h.push(`<h2 class="sec"><span class="no">04</span>巡检数据表</h2>
<div class="subnote">覆盖率 = 已巡检门店 ÷ 应巡检门店；门店合格率 = 达标门店 ÷ 已巡检门店（达标线：直营/新店 90 分，加盟营运 80 分）· 环比为上一等长周期</div>`);
      datasets.forEach(d=>{
        h.push(`<div style="font-size:14px;font-weight:700;margin:16px 0 4px">巡检项目：${esc(d.name)}</div>
<table><tr><th class="l">组别</th><th>门店</th><th>巡检覆盖率</th><th>门店合格率</th><th>平均分</th><th>平均分环比</th></tr>`);
        d.groups.forEach(g=>{
          const pv = pvGroup(d.type, g.name);
          h.push(`<tr><td class="l">${esc(g.name)}</td><td>${g.storeCount}</td><td>${g.coverage}%（${g.covered}/${g.storeCount}）</td><td>${g.passRate}%（${g.passStores}/${g.scoredCount}）</td><td>${g.avgScore}</td><td>${pv?deltaBadge(g.avgScore,pv.avgScore,true):'<span class="dnull">无上期</span>'}</td></tr>`);
        });
        h.push('</table>');
      });

      /* 05 AI 深度分析 */
      if(ai){
        const list = (k,cls,tit)=> ai[k]&&ai[k].length ? `<div class="ai-block ${cls}"><h3>${tit}</h3><ol>${ai[k].map(l=>`<li>${esc(l.replace(/^[·•\-0-9.、\s]+/,''))}</li>`).join('')}</ol></div>` : '';
        h.push(`<h2 class="sec"><span class="no">05</span>深度分析 · 问题诊断与根因（AI 提炼，培训部复核后使用）</h2>`);
        h.push(list('问题诊断','','🔍 问题诊断：品牌现在的食品安全问题'));
        h.push(list('根因分析','','🧩 根因分析：为什么这些问题反复出现'));
        h.push(`<h2 class="sec"><span class="no">06</span>培训部改善行动计划</h2>
<div class="subnote">格式：周次｜动作｜覆盖对象｜衡量目标 · 供培训部与营运复核后下发</div>`);
        if(ai['培训部改善动作']&&ai['培训部改善动作'].length){
          h.push(`<table><tr><th style="width:9%">周次</th><th class="l" style="width:42%">动作</th><th class="l" style="width:20%">覆盖对象</th><th class="l">衡量目标</th></tr>`);
          ai['培训部改善动作'].forEach(l=>{
            const parts = l.replace(/^[·•\-0-9.、\s]+/,'').split(/[;；｜|]/).map(x=>x.trim());
            h.push(`<tr><td>${esc(parts[0]||'')}</td><td class="l">${esc(parts[1]||'')}</td><td class="l">${esc(parts[2]||'')}</td><td class="l">${esc(parts.slice(3).join('；'))}</td></tr>`);
          });
          h.push('</table>');
        }
        h.push(`<h2 class="sec"><span class="no">07</span>给老板的结论</h2>`);
        h.push(list('给老板的结论','boss','📌 结论'));
      } else {
        h.push(`<h2 class="sec"><span class="no">05</span>深度分析</h2><div class="ai-block">⚠️ AI 分析未生成（未填 Key 或调用失败）。填写智谱 API Key 后重新生成即可包含：问题诊断 / 根因分析 / 培训部改善行动计划 / 老板结论。</div>`);
      }

      /* 06 未达标门店清单 */
      const allFails = [];
      datasets.forEach(d=>d.fails.forEach(f=>allFails.push({...f, src:d.name})));
      allFails.sort((a,b)=>a.score-b.score);
      if(allFails.length){
        h.push(`<h2 class="sec"><span class="no">${ai?'08':'05'}</span>未达标门店清单（整改优先级）</h2>
<table><tr><th class="l">门店</th><th>组别</th><th>区域</th><th>平均分</th><th>达标线</th><th>差距</th><th>不合格项</th></tr>`);
        allFails.slice(0,15).forEach(f=>{ h.push(`<tr><td class="l"><b>${esc(f.name)}</b></td><td>${esc(f.pos)}</td><td>${esc(f.region||'-')}</td><td>${f.score}</td><td>${f.th}分</td><td><span class="dbad">${(f.score-f.th).toFixed(1)}</span></td><td>${f.unq}</td></tr>`); });
        h.push('</table>');
      }

      h.push(`<div class="foot"><span>苍井寿司 · 培训部 · 内部资料</span><span>${esc(rangeTxt)} · 慧运营看板自动生成</span></div>
</div></body></html>`);

      const w = window.open('', '_blank');
      if(!w){ stat('❌ 浏览器拦截了新窗口，请允许弹出窗口后重试'); return; }
      w.document.open(); w.document.write(h.join('\n')); w.document.close();
      stat('✅ HTML 报告已在新窗口打开！可点页内「打印 / 另存为 PDF」保存'+(ai?'（含 AI 深度分析）':'（AI 章节缺失）')+(prev?'':'（无环比）'));
    }catch(e){
      stat('❌ 生成失败：'+e.message);
      console.error(e);
    }finally{ btn.disabled=false; }
  };

  console.log('[export] 品牌巡检报告模块已加载（HTML 版 fix155，暗号模式）');
})();
