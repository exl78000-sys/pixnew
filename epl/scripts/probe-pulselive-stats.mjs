#!/usr/bin/env node
/* pulselive `/stats/match/{fixtureId}` 有沒有射門統計(唯讀,不寫任何快取)。2026-10-11。
 *
 * 為什麼探:即時戰況沒有射門次數 / 射正 / xG 以外的場上數據,FPL 即時資料不給。
 * `probe-possession.mjs`(2026-09)已經看過這個端點每隊約 160 個統計項(含 possession_percentage),
 * 但**當時只印了控球,沒有存欄位清單**,射門有沒有、叫什麼名字,倉庫裡查不到。
 * 本站一場一個請求的規矩:進行中的場次每 2 分鐘本來就打 `/fixtures/{id}`(fetch-official),
 * 這個是另一個端點,每場每輪會多一個請求 —— 所以要先知道**值得不值得**,再談要不要接。
 *
 * 三件事:
 *   1. 已完賽 3 場:列出名稱含 shot / target / attempt / goal / xg / expected / chance / blocked 的統計項(兩隊的值)。
 *   2. 鐵則五:跟 FotMob 逐場資料(data/raw/fotmob-epl,獨立來源)的總射門與射正逐場比對。
 *   3. **進行中的比賽有沒有資料**(最關鍵:完賽後才有就沒用):若此刻有 status L 的場次,抓一次看 data 是不是空的。
 *      沒有進行中的場次就明講「這一輪沒量到」,不是「沒有」。
 *
 * 抓取禮貌:最多 7 個請求,單線,間隔 600ms。
 *   npm run probe:pulselive-stats
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://footballapi.pulselive.com/football';
const H = { 'user-agent': 'pl-war-room/1.0 (football analysis side project)', accept: 'application/json',
  Origin: 'https://www.premierleague.com', Referer: 'https://www.premierleague.com/' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;
async function get(url) {
  if (requests >= 7) throw new Error('已達本次 7 個請求上限');
  requests++; await sleep(600);
  const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(API, '')}`);
  return res.json();
}
const NAME = /shot|target|attempt|scoring_att|goal|xg|expected|chance|blocked/i;
const statsOf = (d, teamId) => {
  const side = d?.data?.[teamId]; const M = side?.M ?? side;
  return Array.isArray(M) ? Object.fromEntries(M.map(x => [x.name, x.value])) : null;
};

const off = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'pulselive', 'official.json'), 'utf8'));
let fm = {};
try { fm = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'fotmob-epl', '2026-27-game-details.json'), 'utf8')).matches ?? {}; } catch {}
const finished = Object.entries(off.matches).filter(([k, m]) => m.final && fm[k]?.teamStats).slice(0, 3);
console.log(`▶ pulselive /stats/match 射門統計探測(樣本 ${finished.length} 場已完賽)\n`);

for (const [key, m] of finished) {
  try {
    const d = await get(`${API}/stats/match/${m.fixtureId}`);
    const [h, a] = key.split('|');
    const sh = statsOf(d, m.homeId), sa = statsOf(d, m.awayId);
    console.log(`── ${key}(fixtureId ${m.fixtureId})頂層鍵:${Object.keys(d).join(', ')};統計項 主 ${sh ? Object.keys(sh).length : '無'} / 客 ${sa ? Object.keys(sa).length : '無'}`);
    if (sh && sa) {
      const names = Object.keys(sh).filter(n => NAME.test(n));
      for (const n of names) console.log(`   ${n.padEnd(34)} ${String(sh[n]).padStart(6)} : ${String(sa[n] ?? '—').padEnd(6)}`);
    }
    const f = fm[key].teamStats;
    console.log(`   FotMob(獨立來源):總射門 ${f[h]?.shots} : ${f[a]?.shots}・射正 ${f[h]?.shotsOn} : ${f[a]?.shotsOn}・xG ${f[h]?.xG} : ${f[a]?.xG}`);
  } catch (e) { console.log(`✗ ${key}:${e.message}`); }
}

try {
  const r = await get(`${API}/fixtures?comps=1&compSeasons=${off.season?.id ?? off.seasonId ?? ''}&page=0&statuses=L&pageSize=10`);
  const live = r.content ?? [];
  console.log(`\n── 進行中的場次:${live.length}`);
  for (const f of live.slice(0, 2)) {
    try {
      const d = await get(`${API}/stats/match/${f.id}`);
      const t = f.teams?.map(x => x.team?.id) ?? [];
      const sh = statsOf(d, t[0]), sa = statsOf(d, t[1]);
      console.log(`   fixture ${f.id}(${f.clock?.label ?? '?'}):統計項 主 ${sh ? Object.keys(sh).length : '無'} / 客 ${sa ? Object.keys(sa).length : '無'}`);
      if (sh && sa) for (const n of Object.keys(sh).filter(n => NAME.test(n))) console.log(`     ${n.padEnd(34)} ${sh[n]} : ${sa[n] ?? '—'}`);
    } catch (e) { console.log(`   ✗ fixture ${f.id}:${e.message}`); }
  }
  if (!live.length) console.log('   此刻沒有進行中的英超比賽 —— **進行中有沒有資料這一輪沒量到**(不是「沒有」),下個比賽日再跑一次。');
} catch (e) { console.log(`\n✗ 進行中場次:${e.message}`); }
console.log(`\n請求數 ${requests}`);
