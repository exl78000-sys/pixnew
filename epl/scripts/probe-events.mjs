#!/usr/bin/env node
// 探測「進球方式(運動戰/角球/任意球)」有沒有免費而且**不需要大量請求**的來源。
//
//   npm run probe:events
//
// 刻意設計成很輕:總共只打 2 個請求。
// 使用者的顧慮是「大量提取會被擋」,所以探測本身不能自己先違反這個原則。
//
// 兩個候選:
//   1. StatsBomb Open Data —— GitHub 上的靜態 JSON,不是爬網站,完全沒有被擋的問題。
//      問題是它開放哪些賽事?英超現行賽季在不在裡面?
//   2. Understat —— 射門層級資料,每一腳射門都有 situation(OpenPlay / FromCorner /
//      SetPiece / DirectFreekick / Penalty)。如果真的有,那正好就是使用者要的
//      「運動戰 / 角球 / 任意球」。關鍵是:一支球隊一季的所有射門在**同一頁**裡嗎?
//      是的話一季只要 20 個請求,不是 380。
const UA = 'Mozilla/5.0 (compatible; pl-war-room/1.0; football analysis side project)';
const line = t => console.log(`\n${'─'.repeat(70)}\n▶ ${t}`);

async function statsbomb() {
  line('StatsBomb Open Data:開放哪些賽事(GitHub 靜態檔,不是爬網站)');
  const url = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data/competitions.json';
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  console.log(`  ${url} → HTTP ${r.status}`);
  if (!r.ok) return;
  const j = await r.json();
  console.log(`  共 ${j.length} 筆(賽事 × 賽季)`);
  const byComp = new Map();
  for (const c of j) {
    const k = `${c.country_name} / ${c.competition_name}`;
    if (!byComp.has(k)) byComp.set(k, []);
    byComp.get(k).push(c.season_name);
  }
  console.log(`  賽事清單:`);
  for (const [k, seasons] of [...byComp].sort()) {
    console.log(`    ${k.padEnd(46)} ${seasons.length} 季:${seasons.sort().join(', ')}`);
  }
  // 最關鍵的問題:有沒有英超、有沒有近期賽季
  const pl = j.filter(c => /premier league/i.test(c.competition_name) && /england/i.test(c.country_name));
  console.log(`\n  ★ 英超:${pl.length ? pl.map(c => c.season_name).join(', ') : '沒有'}`);
  const recent = j.filter(c => /202[3-9]/.test(c.season_name));
  console.log(`  ★ 2023 年以後的賽季:${recent.length
    ? [...new Set(recent.map(c => `${c.competition_name} ${c.season_name}`))].join(' | ') : '沒有'}`);
}

async function understat() {
  line('Understat:射門層級資料裡有沒有 situation(進球方式)');
  // 一支球隊一季的全部射門。如果在同一頁,一季只要 20 個請求。
  const url = 'https://understat.com/team/Arsenal/2025';
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  console.log(`  ${url} → HTTP ${r.status}・${(await r.clone().text()).length} 位元組`);
  if (!r.ok) return;
  const html = await r.text();

  // 資料嵌在 <script> 裡的 JSON.parse('...') 字串,變數名稱是 shotsData / datesData 之類
  const vars = [...html.matchAll(/var\s+(\w+)\s*=\s*JSON\.parse\('([^']+)'\)/g)];
  console.log(`  頁面裡的資料變數:${vars.map(v => v[1]).join(', ') || '(找不到)'}`);

  const shotsVar = vars.find(v => /shot/i.test(v[1]));
  if (!shotsVar) { console.log('  ✗ 找不到射門資料變數'); return; }

  const decoded = shotsVar[2].replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  let data;
  try { data = JSON.parse(decoded); } catch (e) { console.log(`  ✗ 解析失敗:${e.message}`); return; }

  const shots = Array.isArray(data) ? data : Object.values(data).flat();
  console.log(`  ✔ ${shotsVar[1]}:${shots.length} 腳射門(這是一支球隊一整季的量)`);
  console.log(`    欄位:${Object.keys(shots[0]).join(', ')}`);

  const tally = key => {
    const m = new Map();
    for (const s of shots) m.set(s[key], (m.get(s[key]) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ');
  };
  console.log(`\n  ★ situation 的值:${tally('situation')}`);
  console.log(`  ★ shotType 的值:${tally('shotType')}`);
  console.log(`  ★ result 的值:${tally('result')}`);

  const goals = shots.filter(s => s.result === 'Goal');
  console.log(`\n  進球 ${goals.length} 顆,依方式分:`);
  const gm = new Map();
  for (const g of goals) gm.set(g.situation, (gm.get(g.situation) ?? 0) + 1);
  for (const [k, v] of [...gm].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(16)} ${v} 球`);
  const withAssist = goals.filter(g => g.player_assisted).length;
  console.log(`  有助攻者的進球:${withAssist} / ${goals.length}`);
  console.log(`\n  進球範例:${JSON.stringify(goals[0])}`);
}

for (const fn of [statsbomb, understat]) {
  try { await fn(); } catch (e) { console.log(`  ✗ 例外:${e.message}`); }
}
console.log(`\n${'─'.repeat(70)}\n完成(總共只打了 2 個請求)。`);
