#!/usr/bin/env node
// 探勘各 API 的實際回傳結構(不是猜欄位,是把真的回傳印出來看)。
// 只在連得到外網的環境跑,由 workflow 觸發。用完就可以刪。
//
// 第二輪:第一輪確認 pulselive 的 fixtures 可用、teamlists 404,
// 所以這輪改成「把候選路徑全部打一次,看哪個真的回 200」。
const UA = 'pl-war-room/1.0 (football analysis side project)';
const PL = { Origin: 'https://www.premierleague.com', Referer: 'https://www.premierleague.com/' };
const API = 'https://footballapi.pulselive.com/football';

const raw = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
  const text = await res.text();
  return { status: res.status, ct: res.headers.get('content-type') || '', text };
};
const j = async (url, headers = {}) => {
  const r = await raw(url, headers);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.text);
};
const shape = (o, depth = 2, indent = '') => {
  if (o === null) return 'null';
  if (Array.isArray(o)) return o.length ? `[${o.length}] ` + (depth > 0 ? shape(o[0], depth - 1, indent) : '…') : '[]';
  if (typeof o !== 'object') return `${typeof o}(${String(o).slice(0, 48)})`;
  if (depth <= 0) return `{${Object.keys(o).slice(0, 10).join(',')}}`;
  return '\n' + Object.entries(o).slice(0, 18)
    .map(([k, v]) => `${indent}  ${k}: ${shape(v, depth - 1, indent + '  ')}`).join('\n');
};
const section = t => console.log(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}`);
const tryIt = async (label, fn) => {
  try { const r = await fn(); console.log(`\n--- ${label} ---`); console.log(shape(r, 3)); return r; }
  catch (e) { console.log(`\n--- ${label} ---\n✗ ${e.message}`); return null; }
};

/* ── 1. pulselive:找出真正的陣容端點 ────────── */
section('pulselive:賽季 / 賽事 / 找陣容端點');
const COMP = 1, SEASON = 841;   // 上一輪確認:英超 comp=1、2026/27 season=841

const fixtures = await j(`${API}/fixtures?comps=${COMP}&compSeasons=${SEASON}&page=0&pageSize=3&sort=asc&statuses=C`, PL);
const fx = fixtures.content[0];
console.log('\n★ fixture 完整原文(第一場):');
console.log(JSON.stringify(fx, null, 1).slice(0, 2600));

const fid = fx.id;
const tid = fx.teams?.[0]?.team?.id;
console.log(`\nfixture=${fid}  teamId=${tid}`);

// 候選路徑一次全打,只印狀態碼 —— 誰回 200 誰就是對的
const candidates = [
  `${API}/fixtures/${fid}`,
  `${API}/fixtures/${fid}?altIds=true`,
  `${API}/fixtures/${fid}/teamlists`,
  `${API}/teamlists/${fid}`,
  `${API}/teamlists?fixtures=${fid}`,
  `${API}/teamlists?fixture=${fid}&altIds=true`,
  `${API}/teamlists?compSeasons=${SEASON}&pageSize=2&altIds=true`,
  `${API}/matches/${fid}`,
  `${API}/stats/match/${fid}`,
  `${API}/fixtures/${fid}/textstream/EN?pageSize=3`,
  `${API}/teams/${tid}/compseasons/${SEASON}/staff?altIds=true`,
  `${API}/teams/${tid}?altIds=true`,
  `${API}/compseasons/${SEASON}/teams`,
];
console.log('\n★ 候選端點狀態碼:');
const hits = [];
for (const url of candidates) {
  const r = await raw(url, PL);
  const mark = r.status === 200 ? '✔' : '✗';
  console.log(`  ${mark} ${r.status}  ${url.replace(API, '')}  ${r.status === 200 ? `(${r.text.length}B)` : ''}`);
  if (r.status === 200) hits.push({ url, text: r.text });
}

// 200 的那幾個,把 key 印出來,順便找 formation / lineup 字樣
for (const h of hits) {
  console.log(`\n--- 內容:${h.url.replace(API, '')} ---`);
  let o; try { o = JSON.parse(h.text); } catch { console.log('  (非 JSON)'); continue; }
  console.log(shape(o, 3));
  if (/formation|lineup|teamList/i.test(h.text)) {
    console.log('  ⚑ 含 formation / lineup 字樣!');
    const m = h.text.match(/.{0,120}"(formation|lineup|teamList)[^"]*".{0,300}/i);
    if (m) console.log('  ' + m[0]);
  }
}

/* ── 2. football-data.org:免費方案到底涵蓋哪些賽事 ── */
section('football-data.org:免費方案賽事清單');
const T = process.env.FOOTBALL_DATA_TOKEN;
if (!T) console.log('(沒有 token,略過)');
else {
  const comps = await j('https://api.football-data.org/v4/competitions', { 'X-Auth-Token': T });
  for (const c of comps.competitions) {
    console.log(`  ${String(c.code).padEnd(5)} ${String(c.type).padEnd(7)} ${c.area?.name?.padEnd(14)} ${c.name}  [${c.plan}] 本季=${c.currentSeason?.startDate ?? '-'}`);
  }
  // 本季歐冠有沒有賽程了?
  await tryIt('CL 2026 賽季',
    () => j('https://api.football-data.org/v4/competitions/CL/matches?season=2026', { 'X-Auth-Token': T }).then(r => ({
      count: r.resultSet?.count, first: r.resultSet?.first, last: r.resultSet?.last, played: r.resultSet?.played,
      sample: r.matches?.[0] && { utcDate: r.matches[0].utcDate, stage: r.matches[0].stage, home: r.matches[0].homeTeam?.name, away: r.matches[0].awayTeam?.name },
    })));
  // 英超隊伍 id 對照(要把兩邊的隊伍接起來)
  await tryIt('PL 隊伍 id/tla 對照',
    () => j('https://api.football-data.org/v4/competitions/PL/teams', { 'X-Auth-Token': T })
      .then(r => r.teams.map(t => `${t.id} ${t.tla} ${t.shortName}`)));
}

/* ── 3. TheSportsDB:整隊查詢的限制 ───────────── */
section('TheSportsDB:整隊查詢 vs 單人查詢');
const sdb = await tryIt('lookup_all_players(Arsenal)= 幾筆?',
  () => j('https://www.thesportsdb.com/api/v1/json/3/lookup_all_players.php?id=133604')
    .then(r => ({ n: r.player?.length, names: r.player?.map(p => `${p.strPlayer}|${p.strPosition}|${p.strCutout ? 'cut' : '-'}${p.strThumb ? 'thumb' : '-'}`) })));
await tryIt('searchplayers(Declan Rice)',
  () => j('https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=Declan%20Rice')
    .then(r => r.player?.map(p => ({ team: p.strTeam, pos: p.strPosition, cutout: p.strCutout, thumb: p.strThumb }))));
await tryIt('searchplayers(冷門球員 Rico Lewis)',
  () => j('https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=Rico%20Lewis')
    .then(r => r.player?.map(p => ({ team: p.strTeam, cutout: p.strCutout ? 'yes' : 'no', thumb: p.strThumb ? 'yes' : 'no' }))));
// 圖檔真的抓得到嗎(有沒有 403)
const img = await fetch('https://r2.thesportsdb.com/images/media/player/cutout/xfwok41769331816.png', { headers: { 'user-agent': UA } });
console.log(`\n★ 圖檔直連:HTTP ${img.status}  ${img.headers.get('content-type')}  ${(await img.arrayBuffer()).byteLength}B`);

console.log('\n\n完成。');
