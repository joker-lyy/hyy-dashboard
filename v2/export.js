/* ============================================================
 * export.js —— 隐藏报表输出模块（fix154 品牌巡检报告版）
 * 仅当 URL 带 ?key=888 时由 app.js 动态加载；普通访问/分享链接完全不加载。
 * 报告口径：
 *   覆盖率 = 区间内有报告的门店数 / 组别门店数
 *   平均分 = 组别内门店区间平均分的均值
 *   门店合格率 = 门店区间平均分 ≥ 达标线的门店占比（达标线：直营90/新店运营90/新店筹建90/加盟营运80）
 *   环比 = 上一等长周期（aggregateRange 重算）
 *   不合格项提取分析 = 高发问题类别 + AI 提炼食品安全风险/提升点/行动计划
 * 智谱 Key 存 localStorage('zhipu_api_key')，不进代码库。
 * ============================================================ */
(function(){
  'use strict';

  const AI_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const PPTJS_CDN = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
  const TAB_NAMES = { overview:'总览', regularInspection:'常规巡检', selfInspection:'门店自检', videoInspection:'视频巡检', aiInspection:'AI 慧检', unqualifiedDetail:'巡检问题汇总及整改跟进' };
  const TYPES = ['regularInspection','selfInspection','videoInspection','aiInspection'];
  // fix154：门店合格率达标线（按组别）
  function thresholdOf(posName){
    const n = String(posName||'');
    if(n.indexOf('加盟')>=0 && n.indexOf('新店')<0 && n.indexOf('筹建')<0) return 80; // 加盟营运组
    return 90; // 培训组（直营）/新店运营/新店筹建
  }

  function tabData(){
    try{ return (typeof appData!=='undefined' && appData) ? appData : null; }catch(e){ return null; }
  }
  function blockOf(t){
    const d = tabData(); if(!d) return null;
    if(t==='regularInspection') return d;
    return d[t] || null;
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
  #expPanel input[type=text],#expPanel select{width:100%;padding:7px 10px;border:1px solid #ccd4e4;
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
      <div class="sub">仅本机可见 · 覆盖率/平均分/门店合格率（达标线：直营90 · 新店90 · 加盟营运80）· 自动环比上一周期</div>
      <label>输出范围</label>
      <div class="chipbar" id="expTypeBar"></div>
      <div class="sub" id="expScope"></div>
      <div class="sec">
        <label>智谱 AI API Key（首次填写后存本机浏览器）</label>
        <input type="text" id="expKey" placeholder="粘贴你的智谱 API Key（glm-4-flash）">
      </div>
      <div class="row">
        <button class="act gray" id="expCsvBtn">① 导出数据 Excel</button>
        <button class="act" id="expPptBtn">② 生成品牌巡检分析报告 PPT</button>
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

  /* ---------- 数据抽取（本期，取自看板当前聚合） ---------- */
  function num(v,d){ v=Number(v); return isFinite(v)?v:(d||0); }

  function groupMetrics(block){
    // 按组别（position）汇总：覆盖率/平均分/门店合格率（达标线）/完成率/点评率/不合格项
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
      const reports = pStores.reduce((a,s)=>a+num(s.reportCount),0);
      return {
        name: pname,
        th,
        storeCount: num(p.storeCount) || pStores.length,
        covered: withReport.length,
        coverage: (num(p.storeCount)||pStores.length)>0 ? Math.round(withReport.length/(num(p.storeCount)||pStores.length)*1000)/10 : 0,
        avgScore: num(p.avgScore),
        passStores, scoredCount: scored.length,
        passRate: scored.length ? Math.round(passStores/scored.length*1000)/10 : 0,
        reports,
        completed: num(p.completed), expected: num(p.expected),
        completion: num(p.completionRate),
        review: num(p.reviewRate),
        unqItems: unq
      };
    });
  }
  function topCats(block, n){
    return (block.topCategories||[]).slice(0,n).map(c=>({ t:c.category||c.title||c.name||'-', n:num(c.count) }));
  }
  function failedStores(block, limit){
    // 未达标门店（按组别达标线），按分数升序
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
    return { type, name:TAB_NAMES[type], groups:groupMetrics(b), cats:topCats(b,8), fails:failedStores(b,10) };
  }

  /* ---------- 环比（重算上一等长周期） ---------- */
  async function loadPrev(){
    const pr = prevRange();
    if(!pr) return null;
    if(typeof aggregateRange !== 'function') return null;
    const prev = await aggregateRange(pr.s, pr.e);
    const pick = (d,t)=>{
      const b = t==='regularInspection' ? d : d[t];
      return b ? collectFrom(b, t) : null;
    };
    function collectFrom(b, type){
      return { type, name:TAB_NAMES[type], groups:groupMetrics(b), cats:topCats(b,8) };
    }
    return { range: pr, byType: TYPES.map(t=>pick(prev,t)) };
  }

  /* ---------- Excel 导出 ---------- */
  ov.querySelector('#expCsvBtn').onclick = ()=>{
    const list = expType==='all' ? TYPES.map(collect).filter(Boolean) : [collect(expType)].filter(Boolean);
    if(!list.length){ stat('❌ 数据还没加载完，稍等几秒再试'); return; }
    const lines = [];
    lines.push(`苍井寿司巡检数据导出\t区间 ${currentStart} ~ ${currentEnd}\t达标线：直营90/新店90/加盟营运80`);
    list.forEach(d=>{
      lines.push(''); lines.push(`【${d.name}】`);
      lines.push('组别\t达标线\t门店数\t覆盖门店\t覆盖率\t平均分\t合格门店\t门店合格率\t报告数\t完成率\t点评率\t不合格项');
      d.groups.forEach(g=>lines.push([g.name,g.th,g.storeCount,g.covered,g.coverage+'%',g.avgScore,g.passStores+'/'+g.scoredCount,g.passRate+'%',g.reports,g.completion+'%',g.review+'%',g.unqItems].join('\t')));
      if(d.cats.length){ lines.push(''); lines.push('高发问题（不合格项提取）\t次数');
        d.cats.forEach(c=>lines.push([c.t,c.n].join('\t'))); }
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

  /* ---------- 智谱 AI：结构化分析 ---------- */
  async function aiAnalysis(datasets, prev){
    const key = (ov.querySelector('#expKey').value||'').trim();
    if(!key) throw new Error('请先填写智谱 API Key');
    localStorage.setItem('zhipu_api_key', key);
    const brief = {
      本期区间: currentStart+' ~ '+currentEnd,
      上一周期: prev ? prev.range.s+' ~ '+prev.range.e : '无',
      板块: datasets.map(d=>({
        名称:d.name,
        组别指标:d.groups.map(g=>({
          组别:g.name, 达标线:g.th, 门店数:g.storeCount, 覆盖率:g.coverage+'%',
          平均分:g.avgScore, 门店合格率:g.passRate+'%', 不合格项:g.unqItems,
          环比: (()=>{ const pg = prev && prev.byType.find(x=>x&&x.type===d.type); if(!pg) return '无上期';
            const p = pg.groups.find(x=>x.name===g.name); if(!p) return '上期无该组';
            return `平均分${g.avgScore-p.avgScore>=0?'+':''}${Math.round((g.avgScore-p.avgScore)*100)/100}、合格率${Math.round((g.passRate-p.passRate)*10)/10}pp、不合格项${g.unqItems-p.unqItems>=0?'+':''}${g.unqItems-p.unqItems}`; })()
        })),
        高发问题:d.cats,
        未达标门店:d.fails.map(f=>`${f.name}(${f.score}分,线${f.th})`)
      }))
    };
    const body = {
      model:'glm-4-flash', temperature:0.3, max_tokens:2000,
      messages:[
        {role:'system', content:`你是连锁寿司品牌（苍井寿司）的食品安全与营运督导专家。根据巡检数据写月度品牌巡检分析，供经营分析会PPT使用。严格按以下格式输出，不要额外寒暄：
【食品安全问题】3-4条，每条一句话指出具体风险（结合高发问题类别和最差组别/门店，带数据）
【提升点】3-4条，每条一句话（对比环比变化，指出退步最明显的组别/指标及原因推测）
【行动计划】4-6条，格式"第N周｜动作｜责任组别｜目标（量化）"，用分号分隔三个字段
【总结】2句话整体结论`},
        {role:'user', content:'数据：\n'+JSON.stringify(brief, null, 1)}
      ]
    };
    const r = await fetch(AI_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body: JSON.stringify(body) });
    if(!r.ok) throw new Error('智谱接口返回 '+r.status);
    const j = await r.json();
    const txt = (j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content||'').trim();
    // 解析分段
    const seg = {};
    ['食品安全问题','提升点','行动计划','总结'].forEach(k=>{
      const m = txt.match(new RegExp('【'+k+'】([\\s\\S]*?)(?=【|$)'));
      seg[k] = m ? m[1].split('\n').map(l=>l.trim()).filter(Boolean) : [];
    });
    return seg;
  }

  /* ---------- PPT 生成 ---------- */
  function loadPptx(){
    return new Promise((res,rej)=>{
      if(window.PptxGenJS) return res();
      const s = document.createElement('script');
      s.src = PPTJS_CDN; s.onload=res; s.onerror=()=>rej(new Error('pptxgenjs 加载失败（检查网络）'));
      document.head.appendChild(s);
    });
  }
  const deltaTxt = (cur, pv, unit, goodWhenUp=true)=>{
    if(pv==null || !isFinite(pv)) return '';
    const d = Math.round((cur-pv)*10)/10;
    if(d===0) return '持平';
    const up = d>0;
    const good = goodWhenUp ? up : !up;
    return (up?'▲':'▼')+Math.abs(d)+(unit||'')+(good?'（改善）':'（退步）');
  };

  ov.querySelector('#expPptBtn').onclick = async ()=>{
    const btn = ov.querySelector('#expPptBtn');
    try{
      const datasets = expType==='all' ? TYPES.map(collect).filter(Boolean) : [collect(expType)].filter(Boolean);
      if(!datasets.length){ stat('❌ 数据还没加载完，稍等几秒再试'); return; }
      btn.disabled = true;
      stat('⏳ 1/4 加载 PPT 组件…');
      await loadPptx();
      stat('⏳ 2/4 重算上一周期做环比…（约 1~2 分钟，请勿关闭）');
      let prev = null;
      try{ prev = await loadPrev(); }catch(e){ console.warn('prev load failed', e); }
      stat('⏳ 3/4 智谱 AI 分析中…（食品安全问题/提升点/行动计划）');
      let ai = null;
      try{ ai = await aiAnalysis(datasets, prev); }
      catch(e){ stat('⚠️ AI 分析失败（'+e.message+'），先生成无 AI 页的报告'); }
      stat('⏳ 4/4 生成 16:9 品牌 PPT…');

      const pptx = new PptxGenJS();
      pptx.defineLayout({ name:'W169', width:13.333, height:7.5 });
      pptx.layout = 'W169';
      const NAVY='1A2A4A', BLUE='186BEB', RED='C0392B', GREEN='1E8E4D', GRAY='5A6377', LG='F5F7FB';
      const rangeTxt = `${currentStart} ~ ${currentEnd}`;
      const prevTxt = prev ? `环比周期 ${prev.range.s} ~ ${prev.range.e}` : '';

      // 每组别取上期同组数据
      const pvGroup = (type, gname)=>{ const t = prev && prev.byType.find(x=>x&&x.type===type); if(!t) return null; return t.groups.find(g=>g.name===gname)||null; };
      const pvCat = (type, t)=>{ const x = prev && prev.byType.find(y=>y&&y.type===type); if(!x) return null; return x.cats.find(c=>c.t===t)||null; };

      // S1 封面
      let s = pptx.addSlide();
      s.background = { color:NAVY };
      s.addText('品牌巡检月度分析报告', { x:0.9,y:2.2,w:11.5,h:1.2, fontSize:42,bold:true,color:'FFFFFF' });
      s.addText(`食品安全 · 营运质量 · 整改跟进`, { x:0.9,y:3.5,w:11.5,h:0.6, fontSize:20,color:'9FB4D8' });
      s.addText(`${rangeTxt}　·　${prevTxt}`, { x:0.9,y:4.3,w:11.5,h:0.5, fontSize:16,color:'9FB4D8' });
      s.addText('苍井寿司 · 培训部', { x:0.9,y:6.5,w:6,h:0.4, fontSize:14,color:'9FB4D8' });

      // S2 执行摘要（取第一个有数据板块的全局均值）
      {
        const sl = pptx.addSlide();
        sl.addText('执行摘要 · 核心指标', { x:0.7,y:0.5,w:12,h:0.7, fontSize:26,bold:true,color:NAVY });
        sl.addText(`${rangeTxt}${prevTxt?' · '+prevTxt:''} · 合格线：直营/新店 90 分，加盟营运 80 分`, { x:0.7,y:1.15,w:12,h:0.4, fontSize:13,color:GRAY });
        // 汇总全部门店口径
        let cov={c:0,n:0}, pass={p:0,s:0}, unq=0, reports=0, scSum=0, scCnt=0;
        datasets.forEach(d=>d.groups.forEach(g=>{
          cov.c+=g.covered; cov.n+=g.storeCount; pass.p+=g.passStores; pass.s+=g.scoredCount;
          unq+=g.unqItems; reports+=g.reports;
          if(g.avgScore>0){ scSum+=g.avgScore*g.scoredCount; scCnt+=g.scoredCount; }
        }));
        let pcov=null,ppass=null,punq=null;
        if(prev){ pcov={c:0,n:0}; ppass={p:0,s:0}; punq=0;
          prev.byType.forEach(t=>t&&t.groups.forEach(g=>{ pcov.c+=g.covered; pcov.n+=g.storeCount; ppass.p+=g.passStores; ppass.s+=g.scoredCount; punq+=g.unqItems; })); }
        const cards = [
          {t:'门店覆盖率', v:(cov.n?Math.round(cov.c/cov.n*1000)/10:0)+'%', d: pcov&&pcov.n?deltaTxt(cov.c/cov.n*100, pcov.c/pcov.n*100, 'pp'):'无上期'},
          {t:'整体平均分', v:(scCnt?Math.round(scSum/scCnt*100)/100:'-'), d:''},
          {t:'门店合格率', v:(pass.s?Math.round(pass.p/pass.s*1000)/10:0)+'%', d: ppass&&ppass.s?deltaTxt(pass.p/pass.s*100, ppass.p/ppass.s*100, 'pp'):''},
          {t:'不合格项数', v:String(unq), d: pcov?deltaTxt(unq, punq, '', false):''},
        ];
        cards.forEach((c,i)=>{
          const x = 0.7 + i*3.1;
          sl.addShape('roundRect', { x, y:1.9, w:2.85, h:1.7, fill:{color:LG}, line:{color:'D8DEEA',pt:1} });
          sl.addText(c.t, { x:x+0.2,y:2.05,w:2.5,h:0.4, fontSize:13,color:GRAY });
          sl.addText(c.v, { x:x+0.2,y:2.45,w:2.5,h:0.8, fontSize:32,bold:true,color:NAVY });
          sl.addText(c.d, { x:x+0.2,y:3.2,w:2.5,h:0.35, fontSize:11,color:(c.d.indexOf('改善')>=0?GREEN:c.d.indexOf('退步')>=0?RED:GRAY) });
        });
        sl.addText(`报告总数 ${reports}　·　未达标门店清单与高发问题见后页`, { x:0.7,y:4.0,w:12,h:0.4, fontSize:13,color:GRAY });
        // 组别达标一览条
        const rows = [[
          {text:'组别',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}},
          {text:'达标线',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}},
          {text:'覆盖率',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}},
          {text:'平均分',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}},
          {text:'门店合格率',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}},
          {text:'平均分环比',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}}]];
        datasets[0].groups.forEach(g=>{
          const pv = pvGroup(datasets[0].type, g.name);
          const dcol = pv?deltaTxt(g.avgScore, pv.avgScore, '分'):'无上期';
          rows.push([g.name, g.th+'分', g.coverage+'%', String(g.avgScore), g.passRate+'% ('+g.passStores+'/'+g.scoredCount+')',
            {text:dcol, options:{color:(dcol.indexOf('改善')>=0?GREEN:dcol.indexOf('退步')>=0?RED:GRAY)}}]);
        });
        sl.addTable(rows, { x:0.7,y:4.5,w:12,colW:[3.2,1.4,1.6,1.6,2.6,1.6], fontSize:12, rowH:0.4, border:{pt:0.5,color:'D8DEEA'}, align:'center', valign:'middle' });
      }

      // S3 每个板块一页详细指标 + 环比
      datasets.forEach(d=>{
        const sl = pptx.addSlide();
        sl.addText(`${d.name} · 组别指标与环比`, { x:0.7,y:0.5,w:12,h:0.7, fontSize:26,bold:true,color:NAVY });
        sl.addText(`${rangeTxt}${prevTxt?' · '+prevTxt:''}`, { x:0.7,y:1.15,w:12,h:0.4, fontSize:13,color:GRAY });
        const head = ['组别','达标线','门店数','覆盖率','平均分','门店合格率','完成率','点评率','不合格项','环比(分/合格率pp)'].map(t=>({text:t,options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}}));
        const rows = [head];
        d.groups.forEach(g=>{
          const pv = pvGroup(d.type, g.name);
          let dcell = '无上期';
          if(pv){ dcell = deltaTxt(g.avgScore,pv.avgScore,'分')+' / '+deltaTxt(g.passRate,pv.passRate,'pp'); }
          rows.push([g.name, g.th+'分', String(g.storeCount), g.coverage+'%', String(g.avgScore),
            g.passRate+'% ('+g.passStores+'/'+g.scoredCount+')', g.completion+'%', g.review+'%', String(g.unqItems),
            {text:dcell, options:{color:(dcell.indexOf('改善')>=0?GREEN:dcell.indexOf('退步')>=0?RED:GRAY), fontSize:10}}]);
        });
        sl.addTable(rows, { x:0.7,y:1.7,w:12,colW:[2.2,1,1,1.2,1.1,2.2,1.2,1.1,1.1,1.9], fontSize:11, rowH:0.42, border:{pt:0.5,color:'D8DEEA'}, align:'center', valign:'middle' });
      });

      // S4 高发问题（不合格项提取分析）+ 环比
      datasets.forEach(d=>{
        if(!d.cats.length) return;
        const sl = pptx.addSlide();
        sl.addText(`${d.name} · 不合格项提取分析`, { x:0.7,y:0.5,w:12,h:0.7, fontSize:26,bold:true,color:NAVY });
        sl.addText('高发问题 Top8 · 括号为环比上一周期变化', { x:0.7,y:1.15,w:12,h:0.4, fontSize:13,color:GRAY });
        const max = Math.max(...d.cats.map(c=>c.n), 1);
        d.cats.forEach((c,i)=>{
          const y = 1.75 + i*0.66;
          const pv = pvCat(d.type, c.t);
          const dl = pv!=null ? deltaTxt(c.n, pv.n, '', false) : '';
          sl.addText(c.t, { x:0.7,y:y,w:6.4,h:0.5, fontSize:13,bold:true,color:NAVY, valign:'middle' });
          sl.addShape('rect', { x:7.2,y:y+0.09,w:4.2*(c.n/max),h:0.32, fill:{color:BLUE} });
          sl.addText(String(c.n)+(dl?'  '+dl:''), { x:7.2+4.2*(c.n/max)+0.1,y:y,w:2.2,h:0.5, fontSize:11,color:(dl.indexOf('退步')>=0?RED:dl.indexOf('改善')>=0?GREEN:GRAY), valign:'middle' });
        });
      });

      // S5 未达标门店清单（全板块合并，取最差 12 家）
      {
        const all = [];
        datasets.forEach(d=>d.fails.forEach(f=>all.push({...f, src:d.name})));
        all.sort((a,b)=>a.score-b.score);
        if(all.length){
          const sl = pptx.addSlide();
          sl.addText('未达标门店清单（整改优先级）', { x:0.7,y:0.5,w:12,h:0.7, fontSize:26,bold:true,color:NAVY });
          sl.addText('按门店区间平均分升序 · 达标线：直营/新店 90，加盟营运 80', { x:0.7,y:1.15,w:12,h:0.4, fontSize:13,color:GRAY });
          const rows = [['门店','组别','区域','平均分','达标线','差距','不合格项','报告数','所属板块'].map(t=>({text:t,options:{bold:true,fill:{color:RED},color:'FFFFFF'}}))];
          all.slice(0,12).forEach(f=>rows.push([f.name,f.pos,f.region||'-',String(f.score),f.th+'分',(f.score-f.th).toFixed(1),String(f.unq),String(f.reports),f.src]));
          sl.addTable(rows, { x:0.7,y:1.7,w:12,colW:[2.4,1.9,1.5,1,1,0.9,1.1,0.9,1.3], fontSize:11, rowH:0.42, border:{pt:0.5,color:'D8DEEA'}, align:'center', valign:'middle' });
        }
      }

      // S6-S8 AI 分析页
      if(ai){
        const bullet = (arr)=> arr.map(l=>({ text:l.replace(/^[·•\-0-9.、\s]+/,''), options:{ bullet:{code:'2022'}, fontSize:15, color:'1A2A4A', paraSpaceAfter:8 } }));
        const mk = (title, sub, items, color)=>{
          const sl = pptx.addSlide();
          sl.addText(title, { x:0.7,y:0.5,w:12,h:0.7, fontSize:26,bold:true,color:NAVY });
          sl.addText(sub, { x:0.7,y:1.15,w:12,h:0.4, fontSize:12,color:GRAY });
          sl.addShape('rect', { x:0.7,y:1.65,w:0.12,h:0.6, fill:{color:color} });
          sl.addText(bullet(items), { x:1.0,y:1.8,w:11.6,h:5.2, valign:'top' });
        };
        if(ai['食品安全问题']&&ai['食品安全问题'].length) mk('食品安全问题与风险', rangeTxt+' · AI 提炼自高发问题与最差组别/门店', ai['食品安全问题'], RED);
        if(ai['提升点']&&ai['提升点'].length) mk('提升点（含环比对比）', prevTxt, ai['提升点'], BLUE);
        if(ai['行动计划']&&ai['行动计划'].length){
          const sl = pptx.addSlide();
          sl.addText('整改行动计划', { x:0.7,y:0.5,w:12,h:0.7, fontSize:26,bold:true,color:NAVY });
          sl.addText('AI 生成 · 供培训部与营运复核后下发', { x:0.7,y:1.15,w:12,h:0.4, fontSize:12,color:GRAY });
          const rows = [['周次','动作','责任组别','目标'].map(t=>({text:t,options:{bold:true,fill:{color:GREEN},color:'FFFFFF'}}))];
          ai['行动计划'].forEach(l=>{
            const parts = l.replace(/^[·•\-0-9.、\s]+/,'').split(/[;；｜|]/).map(x=>x.trim()).filter(Boolean);
            rows.push([parts[0]||'',parts[1]||'',parts[2]||'',parts.slice(3).join('；')||'']);
          });
          sl.addTable(rows, { x:0.7,y:1.7,w:12,colW:[1.4,4.8,2.4,3.4], fontSize:12, rowH:0.5, border:{pt:0.5,color:'D8DEEA'}, valign:'middle' });
        }
        if(ai['总结']&&ai['总结'].length) mk('月度总结', rangeTxt, ai['总结'], NAVY);
      }

      const fname = `品牌巡检分析报告_${currentStart}_${currentEnd}.pptx`;
      await pptx.writeFile({ fileName: fname });
      stat('✅ 报告已生成：'+fname+(ai?'（含AI分析4页）':'（AI页跳过）')+(prev?'':'（无环比数据）'));
    }catch(e){
      stat('❌ 生成失败：'+e.message);
    }finally{ btn.disabled=false; }
  };

  console.log('[export] 品牌巡检报告模块已加载（暗号模式 fix154）');
})();
