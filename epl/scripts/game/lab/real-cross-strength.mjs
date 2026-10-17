import { readFileSync } from 'node:fs';
const j = JSON.parse(readFileSync(new URL('../../../data/raw/fotmob-epl/2025-26-game-details.json', import.meta.url), 'utf8'));
const ms = Object.values(j.matches).filter(m => m.teamStats && m.home && m.away);
// 一、整季的強弱:每隊每場 xG − 被 xG
const agg = {};
for (const m of ms) for (const [me, op] of [[m.home, m.away], [m.away, m.home]]) {
  const a = (agg[me] ??= { xf: 0, xa: 0, n: 0 }); const xf = m.teamStats[me]?.xG, xa = m.teamStats[op]?.xG;
  if (xf == null || xa == null) continue; a.xf += xf; a.xa += xa; a.n++;
}
const str = Object.fromEntries(Object.entries(agg).map(([c, a]) => [c, (a.xf - a.xa) / a.n]));
const rows = [];
for (const m of ms) for (const [me, op] of [[m.home, m.away], [m.away, m.home]]) {
  const t = m.teamStats[me], e = m.teamExtra?.[me] ?? {};
  if (!t || t.corners == null) continue;
  const tot = e.accurate_crosses != null && e.accurate_crosses_pct ? e.accurate_crosses / (e.accurate_crosses_pct / 100) : null;
  rows.push({ me, sdiff: str[me] - str[op], xg: t.xG, oxg: m.teamStats[op]?.xG, corners: t.corners, acc: e.accurate_crosses ?? null, tot, shots: t.shots, poss: t.possession, home: me === m.home });
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const reg = (xs, ys) => { const mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; } const b = sxy / sxx; const r = sxy / Math.sqrt(sxx * syy); const res = ys.map((y, i) => y - my - b * (xs[i] - mx)); const se = Math.sqrt(res.reduce((s, x) => s + x * x, 0) / (xs.length - 2) / sxx); return { b, se, r, my, n: xs.length }; };
console.log(`隊-場 ${rows.length}(${ms.length} 場)`);
console.log('\n一、對「兩隊整季強弱差」(xG − 被 xG,每場;中位隊差 0)回歸 —— 斜率 = 強弱差 +1 時多幾次');
for (const k of ['corners', 'acc', 'tot', 'shots', 'poss']) {
  const rs = rows.filter(r => r[k] != null && Number.isFinite(r[k]));
  const R = reg(rs.map(r => r.sdiff), rs.map(r => r[k]));
  console.log(`  ${k.padEnd(8)} 平均 ${R.my.toFixed(2).padStart(6)}  斜率 ${R.b.toFixed(2).padStart(6)} ± ${R.se.toFixed(2)}  r ${R.r.toFixed(2)}  n ${R.n}  →  相對效果 ${(100 * R.b / R.my).toFixed(0)}% / 單位強弱差`);
}
console.log('\n二、同一場裡,這場 xG 較高的那一邊 ÷ 較低的那一邊(幾何平均的比值)');
const byMatch = {};
for (const r of rows) (byMatch[`${r.me}`] ??= []);
const pairs = [];
for (const m of ms) { const a = rows.find(r => r.me === m.home && r.xg === m.teamStats[m.home]?.xG && r.oxg === m.teamStats[m.away]?.xG && r.home); const b = rows.find(r => r.me === m.away && r.xg === m.teamStats[m.away]?.xG && r.oxg === m.teamStats[m.home]?.xG && !r.home); if (a && b && a.xg !== b.xg) pairs.push(a.xg > b.xg ? [a, b] : [b, a]); }
for (const k of ['corners', 'acc', 'tot', 'shots']) {
  const ps = pairs.filter(([a, b]) => a[k] != null && b[k] != null);
  const sa = ps.reduce((s, [a]) => s + a[k], 0), sb = ps.reduce((s, [, b]) => s + b[k], 0);
  console.log(`  ${k.padEnd(8)} 強 ${(sa / ps.length).toFixed(2)} ÷ 弱 ${(sb / ps.length).toFixed(2)} = ${(sa / sb).toFixed(2)}(${ps.length} 場)`);
}
console.log('\n三、整季強弱前 5 / 後 5 隊');
const ord = Object.entries(str).sort((a, b) => b[1] - a[1]);
const grp = cs => { const rs = rows.filter(r => cs.includes(r.me)); return ['corners', 'acc', 'tot', 'shots'].map(k => `${k} ${mean(rs.filter(r => r[k] != null).map(r => r[k])).toFixed(1)}`).join('・'); };
console.log(`  前 5 ${ord.slice(0, 5).map(x => x[0]).join(' ')}:${grp(ord.slice(0, 5).map(x => x[0]))}`);
console.log(`  後 5 ${ord.slice(-5).map(x => x[0]).join(' ')}:${grp(ord.slice(-5).map(x => x[0]))}`);
