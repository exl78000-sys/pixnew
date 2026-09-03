#!/usr/bin/env node
/* 跑動與衝刺資料的重探(唯讀,不寫快取)。
 *
 * 本站多處寫「跑動沒有免費來源」(CLAUDE.md、賽後卡片、tactics 的 coverage 旗標)。
 * 2026-09-03 抓 FotMob matchDetails 做控球率時看到球隊統計有 physical_metrics_* 的 key、
 * 逐人先發有 performance.totalDistanceCovered / topSpeed —— 那句可能是錯的。
 * 這支只回答「哪幾季有、每場都有嗎、欄位長什麼樣」,最多 4 個請求:本季一場、上季一場、
 * 前季(2024-25)一場(要先拉一次該季賽程拿 matchId)。
 *   node scripts/probe-physical.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (football analysis side project)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;
async function get(url) {
  if (requests >= 4) throw new Error('已達本次 4 個請求上限');
  requests++; await sleep(500);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', referer: 'https://www.fotmob.com/' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const numOrNull = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function physicalOf(d) {
  const groups = d.content?.stats?.Periods?.All?.stats ?? [];
  const team = {};
  for (const g of groups) for (const row of g?.stats ?? []) if (/physical|distance|sprint|running|walking/i.test(row?.key ?? '')) team[row.key] = { title: row.title, stats: row.stats };
  const sides = ['homeTeam', 'awayTeam'].map(k => d.content?.lineup?.[k]);
  const players = sides.flatMap(s => [...(s?.starters ?? []), ...(s?.subs ?? [])]);
  const withDist = players.filter(p => numOrNull(p.performance?.totalDistanceCovered) != null);
  const withSpeed = players.filter(p => numOrNull(p.performance?.topSpeed) != null);
  const sample = withDist[0]?.performance ?? null;
  return { team, players: players.length, withDist: withDist.length, withSpeed: withSpeed.length, sample, perfKeys: sample ? Object.keys(sample) : [] };
}
function show(label, d) {
  const p = physicalOf(d);
  console.log(`\n── ${label} ──`);
  console.log(`   球隊層 physical key ${Object.keys(p.team).length} 個:`);
  for (const [k, v] of Object.entries(p.team)) console.log(`     ${k.padEnd(40)} ${v.title}  =  ${JSON.stringify(v.stats)}`);
  console.log(`   逐人:名單 ${p.players} 人・有 totalDistanceCovered ${p.withDist} 人・有 topSpeed ${p.withSpeed} 人`);
  console.log(`   performance 的鍵:${p.perfKeys.join(', ')}`);
  if (p.sample) console.log(`   樣本:${JSON.stringify(p.sample).slice(0, 200)}`);
}

async function main() {
  console.log('\n▶ 跑動 / 衝刺資料重探(FotMob,最多 4 個請求)');
  const cur = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'fotmob-epl', '2026-27-game-details.json'), 'utf8'));
  const last = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'fotmob-epl', '2025-26-game-details.json'), 'utf8'));
  const curM = Object.values(cur.matches)[3], lastM = Object.values(last.matches).find(m => m.date < '2025-09-01');
  show(`本季 ${curM.key} ${curM.date}(matchId ${curM.matchId})`, await get(`https://www.fotmob.com/api/data/matchDetails?matchId=${curM.matchId}`));
  show(`上季 ${lastM.key} ${lastM.date}(matchId ${lastM.matchId})`, await get(`https://www.fotmob.com/api/data/matchDetails?matchId=${lastM.matchId}`));
  const lg = await get('https://www.fotmob.com/api/data/leagues?id=47&ccode3=GBR&season=2024/2025');
  const old = (lg.fixtures?.allMatches ?? []).find(m => m.status?.finished);
  if (old) show(`前季 ${old.home?.name} vs ${old.away?.name} ${String(old.status?.utcTime).slice(0, 10)}(matchId ${old.id})`, await get(`https://www.fotmob.com/api/data/matchDetails?matchId=${old.id}`));
  console.log(`\n本次請求 ${requests}/4`);
}
main().catch(e => { console.error('✗', e.message); process.exit(1); });
