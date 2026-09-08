/* ============================================================
 * export.js —— 隐藏报表输出模块（fix153）
 * 仅当 URL 带 ?key=888 时由 app.js 动态加载；普通访问/分享链接完全不加载。
 * 功能：①当前板块数据快照 ②导出 Excel(CSV) ③智谱AI分析 + 16:9 PPT 输出
 * 智谱 Key 存 localStorage('zhipu_api_key')，不进代码库。
 * ============================================================ */
(function(){
  'use strict';

  const AI_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const PPTJS_CDN = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
  const TAB_NAMES = { overview:'总览', regularInspection:'常规巡检', selfInspection:'门店自检', videoInspection:'视频巡检', aiInspection:'AI 慧检', unqualifiedDetail:'巡检问题汇总及整改跟进' };
  const TYPES = ['regularInspection','selfInspection','videoInspection','aiInspection'];

  function tabData(){
    try{ return (typeof appData!=='undefined' && appData) ? appData : null; }catch(e){ return null; }
  }
  // 某类巡检的聚合块（常规巡检的字段直接挂在顶层）
  function blockOf(t){
    const d = tabData(); if(!d) return null;
    if(t==='regularInspection') return d;
    return d[t] || null;
  }
  function curType(){
    return TYPES.includes(activeMainTab) ? activeMainTab
      : (activeMainTab==='unqualifiedDetail' ? 'regularInspection' : 'regularInspection');
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
      <h3>📊 报表输出</h3>
      <div class="sub">仅本机可见 · 数据取自当前看板聚合结果</div>
      <label>输出范围</label>
      <div class="chipbar" id="expTypeBar"></div>
      <div class="sub" id="expScope"></div>
      <div class="sec">
        <label>智谱 AI API Key（首次填写后存本机浏览器）</label>
        <input type="text" id="expKey" placeholder="粘贴你的智谱 API Key（glm-4-flash）">
      </div>
      <div class="row">
        <button class="act gray" id="expCsvBtn">① 导出数据 Excel</button>
        <button class="act" id="expPptBtn">② 生成月度分析 PPT</button>
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
    return `日期区间：${currentStart||'-'} ~ ${currentEnd||'-'}　|　页面组别筛选：${activePosFilter==='__all__'?'全部组别':activePosFilter}`;
  }
  function renderScope(){ ov.querySelector('#expScope').textContent = scopeText(); }
  renderChips(); renderScope();
  setInterval(renderScope, 2000);

  fab.onclick = ()=>{ ov.classList.add('active'); ov.querySelector('#expKey').value = localStorage.getItem('zhipu_api_key')||''; };
  ov.onclick = e=>{ if(e.target===ov) ov.classList.remove('active'); };

  const stat = msg=>{ ov.querySelector('#expStat').textContent = msg; };

  /* ---------- 数据抽取 ---------- */
  function num(v,d){ v=Number(v); return isFinite(v)?v:(d||0); }
  function pct(a,b){ return b>0 ? (a/b*100).toFixed(1)+'%' : '-'; }

  function collect(type){
    const b = blockOf(type);
    if(!b) return null;
    const pos = (b.positions||[]).map(p=>({
      name:p.position||p.name||'-',
      stores:num(p.storeCount), expected:num(p.expected), completed:num(p.completed),
      completion:p.completionRate||(p.completed&&p.expected?pct(p.completed,p.expected):'-'),
      review:p.reviewRate||'-'
    }));
    const regs = (b.regions||[]).slice(0,12).map(r=>({
      name:r.region||r.name||'-',
      stores:num(r.storeCount||r.stores), reports:num(r.reportCount||r.total||r.count),
      okRate:r.okRate||r.passRate||'-', unq:num(r.unqualifiedCount||r.unqCount||0)
    }));
    const cats = (b.topCategories||[]).slice(0,6).map(c=>({ t:c.title||c.name||c.category||'-', n:num(c.count||c.total) }));
    let totalReports=0, totalUnq=0;
    (b.stores||[]).forEach(s=>{ totalReports+=num(s.reportCount||s.total||s.count); totalUnq+=num(s.unqualifiedCount||s.unqCount); });
    return { type, name:TAB_NAMES[type], pos, regs, cats, totalReports, totalUnq,
      totalStores:num(b.totalStores), totalInspected:num(b.totalInspected) };
  }
  function collectAll(){ return TYPES.map(collect).filter(Boolean); }

  /* ---------- Excel 导出 ---------- */
  ov.querySelector('#expCsvBtn').onclick = ()=>{
    const list = expType==='all' ? collectAll() : [collect(expType)].filter(Boolean);
    if(!list.length){ stat('❌ 数据还没加载完，稍等几秒再试'); return; }
    const lines = [];
    lines.push(`慧运营看板数据导出\t区间 ${currentStart} ~ ${currentEnd}\t筛选：${activePosFilter==='__all__'?'全部组别':activePosFilter}`);
    list.forEach(d=>{
      lines.push(''); lines.push(`【${d.name}】报告数 ${d.totalReports}　不合格 ${d.totalUnq}`);
      lines.push('组别\t门店数\t已交报告\t应完成\t完成率\t点评率');
      d.pos.forEach(p=>lines.push([p.name,p.stores,p.completed,p.expected,p.completion,p.review].join('\t')));
      if(d.regs.length){ lines.push(''); lines.push('区域\t门店数\t报告数\t合格率\t不合格数');
        d.regs.forEach(r=>lines.push([r.name,r.stores,r.reports,r.okRate,r.unq].join('\t'))); }
      if(d.cats.length){ lines.push(''); lines.push('高发问题\t次数');
        d.cats.forEach(c=>lines.push([c.t,c.n].join('\t'))); }
    });
    const blob = new Blob(['\ufeff'+lines.join('\r\n')], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `慧运营数据_${currentStart}_${currentEnd}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    stat('✅ Excel 数据已下载');
  };

  /* ---------- 智谱 AI ---------- */
  async function aiSummary(datasets){
    const key = (ov.querySelector('#expKey').value||'').trim();
    if(!key) throw new Error('请先填写智谱 API Key');
    localStorage.setItem('zhipu_api_key', key);
    const brief = datasets.map(d=>({
      板块:d.name, 报告数:d.totalReports, 不合格项:d.totalUnq, 门店数:d.totalStores,
      组别:d.pos, 高发问题:d.cats
    }));
    const body = {
      model:'glm-4-flash', temperature:0.3, max_tokens:1600,
      messages:[
        {role:'system', content:'你是连锁寿司品牌的营运培训助手。根据巡检看板数据写月度经营分析总结，供月度经营分析会PPT使用。要求：中文、分点、每点不超过40字、先讲结论再讲数据、指出最需要整改的组别/区域与建议动作、语气客观专业。输出4-6个要点，每行一个，用"·"开头。'},
        {role:'user', content:`统计区间 ${currentStart} ~ ${currentEnd}，筛选范围：${activePosFilter==='__all__'?'全部组别':activePosFilter}。\n数据：\n`+JSON.stringify(brief, null, 1)}
      ]
    };
    const r = await fetch(AI_URL, { method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body: JSON.stringify(body) });
    if(!r.ok) throw new Error('智谱接口返回 '+r.status);
    const j = await r.json();
    return (j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content||'').trim();
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

  ov.querySelector('#expPptBtn').onclick = async ()=>{
    const btn = ov.querySelector('#expPptBtn');
    try{
      const datasets = expType==='all' ? collectAll() : [collect(expType)].filter(Boolean);
      if(!datasets.length){ stat('❌ 数据还没加载完，稍等几秒再试'); return; }
      btn.disabled = true;
      stat('⏳ 1/3 加载 PPT 组件…');
      await loadPptx();
      stat('⏳ 2/3 智谱 AI 分析总结中…（约 10 秒）');
      let aiText = '';
      try{ aiText = await aiSummary(datasets); }
      catch(e){ stat('⚠️ AI 分析失败（'+e.message+'），先生成无 AI 页的 PPT'); }
      stat('⏳ 3/3 生成 16:9 PPT…');

      const pptx = new PptxGenJS();
      pptx.defineLayout({ name:'W169', width:13.333, height:7.5 });
      pptx.layout = 'W169';
      const NAVY='1A2A4A', BLUE='186BEB', GRAY='5A6377', LGRAY='F5F7FB';
      const filterTxt = activePosFilter==='__all__'?'全部组别':activePosFilter;

      // S1 封面
      let s = pptx.addSlide();
      s.background = { color:NAVY };
      s.addText('慧运营巡检 月度经营分析', { x:0.9,y:2.4,w:11.5,h:1.2, fontSize:40,bold:true,color:'FFFFFF' });
      s.addText(`${currentStart} ~ ${currentEnd}　·　${filterTxt}`, { x:0.9,y:3.7,w:11.5,h:0.6, fontSize:20,color:'9FB4D8' });
      s.addText('苍井寿司 · 培训部', { x:0.9,y:6.5,w:6,h:0.4, fontSize:14,color:'9FB4D8' });

      // S2 核心指标（每类一张小节或合并表）
      datasets.forEach(d=>{
        const sl = pptx.addSlide();
        sl.addText(`${d.name} · 核心指标`, { x:0.7,y:0.5,w:12,h:0.7, fontSize:26,bold:true,color:NAVY });
        sl.addText(`${currentStart} ~ ${currentEnd} · ${filterTxt}`, { x:0.7,y:1.15,w:12,h:0.4, fontSize:13,color:GRAY });
        const rows = [
          [{text:'组别',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}},
           {text:'门店数',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}},
           {text:'已交/应完成',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}},
           {text:'完成率',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}},
           {text:'点评率',options:{bold:true,fill:{color:BLUE},color:'FFFFFF'}}]
        ];
        d.pos.forEach(p=>rows.push([p.name,String(p.stores),`${p.completed}/${p.expected}`,p.completion,p.review]));
        sl.addTable(rows, { x:0.7,y:1.8,w:12,colW:[3.4,1.8,2.6,2.1,2.1], fontSize:13, rowH:0.42, border:{pt:0.5,color:'D8DEEA'}, align:'center', valign:'middle' });
        sl.addText(`报告总数 ${d.totalReports}　·　不合格项 ${d.totalUnq}`, { x:0.7,y:6.6,w:8,h:0.4, fontSize:13,color:GRAY });
      });

      // S3 高发问题
      datasets.forEach(d=>{
        if(!d.cats.length) return;
        const sl = pptx.addSlide();
        sl.addText(`${d.name} · 高发问题 Top${d.cats.length}`, { x:0.7,y:0.5,w:12,h:0.7, fontSize:26,bold:true,color:NAVY });
        const max = Math.max(...d.cats.map(c=>c.n), 1);
        d.cats.forEach((c,i)=>{
          const y = 1.7 + i*0.85;
          sl.addText(c.t, { x:0.7,y:y,w:6.6,h:0.5, fontSize:14,bold:true,color:NAVY, valign:'middle' });
          sl.addShape('rect', { x:7.5,y:y+0.08,w:4.6*(c.n/max),h:0.34, fill:{color:BLUE} });
          sl.addText(String(c.n), { x:7.5+4.6*(c.n/max)+0.1,y:y,w:0.9,h:0.5, fontSize:13,color:GRAY, valign:'middle' });
        });
      });

      // S4 AI 总结
      if(aiText){
        const sl = pptx.addSlide();
        sl.addText('AI 月度分析总结', { x:0.7,y:0.5,w:12,h:0.7, fontSize:26,bold:true,color:NAVY });
        sl.addText(`${currentStart} ~ ${currentEnd} · ${filterTxt} · 智谱AI生成，供经营分析会参考`, { x:0.7,y:1.15,w:12,h:0.4, fontSize:12,color:GRAY });
        const lines = aiText.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>({
          text: l.replace(/^[·•\-]\s*/,''), options:{ bullet:{code:'2022'}, fontSize:16, color:'1A2A4A', paraSpaceAfter:10 }
        }));
        sl.addText(lines, { x:0.9,y:1.9,w:11.6,h:5, valign:'top' });
      }

      const fname = `慧运营月度分析_${currentStart}_${currentEnd}.pptx`;
      await pptx.writeFile({ fileName: fname });
      stat('✅ PPT 已生成并下载：'+fname+(aiText?'（含AI总结页）':'（AI页跳过）'));
    }catch(e){
      stat('❌ 生成失败：'+e.message);
    }finally{ btn.disabled=false; }
  };

  console.log('[export] 报表输出模块已加载（暗号模式）');
})();
