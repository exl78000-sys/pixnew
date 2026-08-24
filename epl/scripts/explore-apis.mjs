#!/usr/bin/env node
// 探勘各 API 的實際回傳結構(不是猜欄位,是把真的回傳印出來看)。
// 只在連得到外網的環境跑,由 workflow 觸發。用完就可以刪。
const UA = 'pl-war-room/1.0 (football analysis side project)';
const PL = { Origin: 'https://www.premierleague.com', Referer: 'https://www.premierleague.com/' };

const j = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const shape = (o, depth = 2, indent = '') => {
  if (o === null) return 'null';
  if (Array.isArray(o)) return o.length ? `[${o.length}] ` + (depth > 0 ? shape(o[0], depth - 1, indent) : '…') : '[]';
  if (typeof o !== 'object') return `${typeof o}(${String(o).slice(0, 40)})`;
  if (depth <= 0) return `{${Object.keys(o).slice(0, 8).join(',')}}`;
  return '\n' + Object.entries(o).slice(0, 14)
    .map(([k, v]) => `${indent}  ${k}: ${shape(v, depth - 1, indent + '  ')}`).join('\n');
};
const section = t => console.log(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}`);
const tryIt = async (label, fn) => {
  try { const r = await fn(); console.log(`\n--- ${label} ---`); console.log(shape(r, 3)); return r; }
  catch (e) { console.log(`\n--- ${label} ---\n✗ ${e.message}`); return null; }
};

/* ── pulselive:官方陣型 ─────────────────── */
section('pulselive:找出本季英超的 compSeason,再取一場比賽的官方陣容');
const comps = await tryIt('competitions', () => j('https://footballapi.pulselive.com/football/competitions?pageSize=50', PL));
const plComp = comps?.content?.find(c => c.abbreviation === 'EN_PR');
console.log('\n英超 competition id =', plComp?.id);

const seasons = await tryIt('compseasons',
  () => j(`https://footballapi.pulselive.com/football/competitions/${plComp?.id ?? 1}/compseasons?pageSize=30`, PL));
const cur = seasons?.content?.[0];
console.log('\n最新賽季:', cur?.label, '→ id =', cur?.id);

const fixtures = await tryIt('fixtures(該賽季前幾場)',
  () => j(`https://footballapi.pulselive.com/football/fixtures?comps=${plComp?.id ?? 1}&compSeasons=${cur?.id}&page=0&pageSize=5&sort=asc&statuses=C`, PL));
const fx = fixtures?.content?.[0];
console.log('\n第一場 fixture id =', fx?.id, '|', fx?.teams?.map(t => t.team?.name).join(' vs '));

// 關鍵:teamlists 才有 formation
await tryIt('teamlists(官方陣型!)',
  () => j(`https://footballapi.pulselive.com/football/teamlists?compSeasons=${cur?.id}&page=0&pageSize=5`, PL));
if (fx?.id) {
  const tl = await tryIt(`teamlists?fixture=${fx.id}`,
    () => j(`https://footballapi.pulselive.com/football/teamlists?fixture=${fx.id}`, PL));
  // 把 formation 相關欄位完整印出來
  const one = tl?.content?.[0] ?? tl?.[0];
  if (one) {
    console.log('\n★ formation 欄位原文:');
    console.log(JSON.stringify({ formation: one.formation, teamId: one.teamId }, null, 1).slice(0, 900));
    console.log('\n★ lineup 第一位球員原文:');
    console.log(JSON.stringify(one.lineup?.[0] ?? one.players?.[0], null, 1).slice(0, 700));
  }
}

/* ── football-data.org:歐冠 ─────────────── */
section('football-data.org:歐冠賽程');
const T = process.env.FOOTBALL_DATA_TOKEN;
if (!T) console.log('(沒有 token,略過)');
else {
  await tryIt('competitions(免費方案涵蓋哪些)',
    () => j('https://api.football-data.org/v4/competitions', { 'X-Auth-Token': T }));
  await tryIt('CL matches',
    () => j('https://api.football-data.org/v4/competitions/CL/matches', { 'X-Auth-Token': T }));
}

/* ── TheSportsDB:球員照片 ───────────────── */
section('TheSportsDB:球員照片欄位');
const sdb = await tryIt('searchplayers(Saka)',
  () => j('https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=Bukayo%20Saka'));
if (sdb?.player?.[0]) {
  const p = sdb.player[0];
  console.log('\n★ 照片相關欄位:');
  for (const k of Object.keys(p).filter(k => /thumb|cutout|render|photo|image/i.test(k))) {
    console.log(`  ${k}: ${p[k] ?? 'null'}`);
  }
  console.log('  strTeam:', p.strTeam, '| strPosition:', p.strPosition, '| idPlayer:', p.idPlayer);
}
await tryIt('lookup_all_players(Arsenal 全隊)',
  () => j('https://www.thesportsdb.com/api/v1/json/3/lookup_all_players.php?id=133604'));

console.log('\n\n完成。');
