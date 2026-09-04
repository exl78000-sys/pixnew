#!/usr/bin/env node
/* 賽果與即時比分(FotMob 聯賽賽程端點)—— 一個聯賽一個請求,回整季每一場的狀態與比分。
 *
 * 為什麼(2026-09-04):西甲與英冠的賽果一直靠 openfootball 這種社群靜態檔,更新慢好幾天
 * (實測西甲 9/3 一場、英冠 9/1–9/2 十二場到 9/4 還是「未賽」);西甲即時比分靠的 SportMonks 9/3 取消,
 * 英冠從來沒有即時來源。使用者說十分鐘更新一次可以接受。這個端點每 10 分鐘打一次,一天 144 次,很禮貌。
 *
 * 規矩:
 * - 只寫 raw(`data/raw/{dir}/scores.json`),誰採用、怎麼核對由 build 決定:FotMob 的比分在社群檔到之前
 *   是**暫定**(`provisional`),社群檔到了兩邊要一致,對不上整季不採用 FotMob 那份(鐵則五)。
 * - 隊名走名冊寬鬆對照;對不上的隊名印出來(靜靜吞掉整隊消失是踩過的坑)。
 *
 *   npm run scores:fetch -- --league=es1      # 也可 pl / en2;一次一個聯賽,一個請求
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (football analysis side project)';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const LEAGUES = {
  pl: { id: 47, ccode3: 'GBR', dir: 'fotmob-epl', teamFile: 'teams.json', meta: ['web', 'data', 'meta.json'] },
  es1: { id: 87, ccode3: 'ESP', dir: 'fotmob-la-liga', teamFile: 'teams-la-liga.json', meta: ['web', 'data', 'leagues', 'es1', 'meta.json'] },
  en2: { id: 48, ccode3: 'GBR', dir: 'fotmob-championship', teamFile: 'teams-championship.json', meta: ['web', 'data', 'leagues', 'en2', 'meta.json'] },
};
const key = arg('league') ?? 'pl';
const LG = LEAGUES[key];
if (!LG) { console.error(`未知聯賽 ${key}`); process.exit(1); }
const fotmobSeason = s => { const y = Number(s.slice(0, 4)); return `${y}/${y + 1}`; };
const numOrNull = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

async function main() {
  const meta = JSON.parse(await readFile(join(ROOT, ...LG.meta), 'utf8'));
  const season = arg('season') ?? meta.currentSeason;
  const T = loadTeams(ROOT, { file: LG.teamFile });
  const url = `https://www.fotmob.com/api/data/leagues?id=${LG.id}&ccode3=${LG.ccode3}&season=${encodeURIComponent(fotmobSeason(season))}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json', 'user-agent': UA, referer: 'https://www.fotmob.com/' } });
  if (!res.ok) { console.log(`✗ FotMob HTTP ${res.status},保留上一份`); return; }
  const j = await res.json();
  if (j?.error) { console.log(`✗ FotMob 回了 200 但帶 error:${String(j.error).slice(0, 80)}`); return; }
  const all = j.fixtures?.allMatches ?? [];
  if (!all.length) { console.log('✗ FotMob 回了 0 場,保留上一份'); return; }
  const unknown = new Set();
  const matches = [];
  for (const it of all) {
    const home = T.codeOf(it.home?.name), away = T.codeOf(it.away?.name);
    if (!home) unknown.add(it.home?.name);
    if (!away) unknown.add(it.away?.name);
    if (!home || !away) continue;
    const st = it.status ?? {};
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(st.scoreStr ?? '').trim());
    matches.push({
      home, away, matchId: String(it.id), round: numOrNull(it.round),
      utcTime: st.utcTime ?? null, date: String(st.utcTime ?? '').slice(0, 10),
      started: st.started === true, finished: st.finished === true, cancelled: st.cancelled === true,
      score: m ? [Number(m[1]), Number(m[2])] : null,
      liveTime: st.liveTime?.short ?? st.liveTime?.long ?? null,
      reason: st.reason?.short ?? null,
    });
  }
  if (unknown.size) console.log(`  ⚠ 對不上名冊的 FotMob 隊名:${[...unknown].join('、')}`);
  const dir = join(ROOT, 'data', 'raw', LG.dir);
  await mkdir(dir, { recursive: true });
  const out = { league: key, season, source: 'fotmob leagues', fetchedAt: new Date().toISOString(), total: all.length, matches };
  await writeFile(join(dir, 'scores.json'), JSON.stringify(out));
  const fin = matches.filter(m => m.finished).length, live = matches.filter(m => m.started && !m.finished).length;
  console.log(`✔ ${key} ${season}:${matches.length}/${all.length} 場可對照・已完賽 ${fin}・進行中 ${live}・1 個請求`);
}
main().catch(e => { console.error('✗', e.message); process.exit(1); });
