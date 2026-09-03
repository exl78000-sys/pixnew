#!/usr/bin/env node
/* 英超逐場控球率的來源探測(唯讀,不寫任何快取)。
 *
 * 模擬遊玩(2026-09-03 規劃)第 4 項:每場都要有控球率,抓過往資料。
 * 英超目前**一場控球率都沒有** —— football-data 的 CSV、FPL、openfootball 都沒這欄。
 * 兩個候選,**先探再抓、不憑印象斷言欄位**(CLAUDE.md 第四節):
 *
 *   1. FotMob matchDetails —— 西甲賽後資料已在用,轉換器對好了 `BallPossesion`
 *   2. pulselive /stats/match/{fixtureId} —— 官網後端,賽程與事件就從這來,欄位沒探過
 *
 * 另外要回答「回填 2025-26 全季」找 matchId 的路:FotMob 的聯賽賽程端點
 * (`/api/data/leagues?id=47&season=2025/2026`,英超 leagueId=47 是西甲探測時
 * 從 allLeagues 看到的同一張表)。
 *
 * 抓取禮貌:**最多 3 個請求**,單線,間隔 400ms。
 *   npm run probe:possession
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (football analysis side project)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;

async function get(url, headers = {}) {
  if (requests >= 3) throw new Error('已達本次 3 個請求上限');
  requests++;
  await sleep(400);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000),
    headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]} ${text.slice(0, 120)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`回傳不是 JSON(${text.length} bytes)`); }
  if (j?.error) throw new Error(`回了 200 但帶 error:${JSON.stringify(j.error).slice(0, 120)}`);
  return j;
}

/* 遞迴找出鍵名含 possession 的節點(不分大小寫、容忍上游的拼字)。
   照名字猜欄位是這個專案踩過最多次的坑,所以把**實際的路徑**印出來。 */
function findKeys(obj, pattern, path = '', out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 9) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (pattern.test(k)) out.push([p, JSON.stringify(v).slice(0, 160)]);
    if (typeof v === 'string' && pattern.test(v)) out.push([p, JSON.stringify(obj).slice(0, 160)]);
    findKeys(v, pattern, p, out, depth + 1);
  }
  return out;
}
const POSS = /possess?ion|possesion/i;

async function main() {
  console.log('\n▶ 英超逐場控球率來源探測(最多 3 個請求)\n');
  const goals = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', 'fotmob-goals-2026-27.json'), 'utf8'));
  const official = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'official.json'), 'utf8'));
  const sampleFm = (goals.leagues?.pl?.matches ?? []).find(m => m.fotmobMatchId);
  const [offKey, sampleOff] = Object.entries(official.matches ?? {}).find(([, m]) => m.fixtureId) ?? [];
  console.log(`FotMob 樣本:${sampleFm?.home} vs ${sampleFm?.away} ${sampleFm?.date}(matchId ${sampleFm?.fotmobMatchId})`);
  console.log(`pulselive 樣本:${offKey}(fixtureId ${sampleOff?.fixtureId})`);

  // 1. FotMob matchDetails
  try {
    const d = await get(`https://www.fotmob.com/api/data/matchDetails?matchId=${sampleFm.fotmobMatchId}`,
      { referer: 'https://www.fotmob.com/' });
    const hits = findKeys(d.content?.stats ?? d, POSS);
    console.log(`\n── FotMob matchDetails ── content 的鍵:${Object.keys(d.content ?? {}).join(', ')}`);
    console.log(`   含 possession 的節點 ${hits.length} 個:`);
    hits.slice(0, 6).forEach(([p, v]) => console.log(`     ${p}\n        ${v}`));
    const status = d.header?.status;
    console.log(`   header.status:${JSON.stringify(status).slice(0, 160)}`);
  } catch (e) { console.log(`\n✗ FotMob matchDetails:${e.message}`); }

  // 2. pulselive /stats/match/{id}
  try {
    const d = await get(`https://footballapi.pulselive.com/football/stats/match/${sampleOff.fixtureId}`,
      { Origin: 'https://www.premierleague.com', Referer: 'https://www.premierleague.com/' });
    console.log(`\n── pulselive /stats/match ── 頂層鍵:${Object.keys(d).join(', ')}`);
    const hits = findKeys(d, POSS);
    console.log(`   含 possession 的節點 ${hits.length} 個:`);
    hits.slice(0, 6).forEach(([p, v]) => console.log(`     ${p}\n        ${v}`));
    const data = d.data ?? {};
    for (const [teamId, side] of Object.entries(data).slice(0, 2)) {
      const M = side?.M ?? side;
      console.log(`   隊 ${teamId}:${Array.isArray(M) ? M.length + ' 個統計項' : typeof M}`
        + (Array.isArray(M) ? ` 例:${M.slice(0, 5).map(x => `${x.name}=${x.value}`).join('、')}` : ''));
    }
  } catch (e) { console.log(`\n✗ pulselive /stats/match:${e.message}`); }

  // 3. FotMob 聯賽賽程(回填 2025-26 用的 matchId 清單)
  try {
    const d = await get('https://www.fotmob.com/api/data/leagues?id=47&ccode3=GBR&season=2025/2026',
      { referer: 'https://www.fotmob.com/' });
    const all = d.fixtures?.allMatches ?? d.matches?.allMatches ?? [];
    console.log(`\n── FotMob leagues(2025/2026)── 頂層鍵:${Object.keys(d).join(', ')}`);
    console.log(`   allMatches ${all.length} 場;第一場:${JSON.stringify(all[0]).slice(0, 220)}`);
    const finished = all.filter(m => m.status?.finished).length;
    console.log(`   已完賽 ${finished} 場`);
  } catch (e) { console.log(`\n✗ FotMob leagues:${e.message}`); }

  console.log(`\n本次請求 ${requests}/3`);
}
main().catch(e => { console.error(e); process.exit(1); });
