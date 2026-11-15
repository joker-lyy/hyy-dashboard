// fix251 模拟：培训组 11 月岗位大卡应剔除自检（已巡检 3→0、平均分 96.67→-）
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync('v2/aggregate.js', 'utf8');
const sandbox = {
  window: {}, console, fetch: async () => ({ ok: false, json: async () => ({}) }),
  location: { pathname: '/v2/aggregate.js', href: 'http://localhost/v2/aggregate.js' },
  navigator: { userAgent: 'sim' },
  document: { createElement: () => ({ style: {}, setAttribute(){}, appendChild(){}, remove(){} }), body: { appendChild(){} } },
};
vm.createContext(sandbox);
vm.runInContext(src + '\n;this.__aggregateRegular = aggregateRegular;', sandbox);

// 直接注入 11 月 raw
const raw = JSON.parse(fs.readFileSync('data/raw/2026-11.json', 'utf8'));
vm.runInContext(`rawMonthCache['2026-11'] = ${JSON.stringify(raw)};`, sandbox);
sandbox.window.__SELF_CHECK_AUTO_RIDS__ = new Set(
  JSON.parse(fs.readFileSync('data/selfCheckAuto.json', 'utf8')).rids.map(String)
);
sandbox.window.__SELF_CHECK_MARKS__ = JSON.parse(fs.readFileSync('data/selfCheckMarks.json', 'utf8')).marks || {};

const d = await sandbox.__aggregateRegular(['2026-11'], '2026-11-01', '2026-11-16', {});
const pos = d.positions.find(p => p.position === '培训组（直营组）');
console.log('培训组卡片: 门店数=%s 已巡检=%s 完成率=%s 平均分=%s 合格率=%s 不合格项=%s',
  pos.storeCount, pos.inspectedCount, pos.submitRate, pos.avgScore, pos.qualifiedRate, pos.unqualifiedItems);
const zy = d.stores.filter(s => s.position === '培训组（直营组）');
console.log('培训组 QSC 门店清单:', zy.map(s => `${s.storeName}(${s.score}/${s.reportCount})`).join(', ') || '(空)');
console.log('全岗位已巡检合计:', d.positions.map(p => `${p.position}:${p.inspectedCount}`).join(' | '));
