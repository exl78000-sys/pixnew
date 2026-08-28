#!/usr/bin/env node
/* 歐冠資料探測。

   已知:football-data.org 的 token 授權 13 個賽事,**CL 在裡面**
   (上一輪 probe-encups 實測,見 data/raw/probes/en-cups.json)。
   SportMonks 那條路走不通 —— 方案是 5/5 滿的,而且沒有歐冠。

   所以這一支要回答的不是「有沒有」,是**「哪幾季拿得到、拿得到什麼」**:

   1. /competitions/CL 回報哪些賽季(免費方案常常只開放目前那一季)
   2. 2024 / 2025 / 2026 三季的 matches 各自回什麼 ——
      **403 才是「方案不給」,404 是路徑錯,200 但 count 0 是「還沒開打」。**
      三種要分得開,不然會把「還沒開打」寫成「拿不到」。
   3. 拿得到的話,一場比賽長什麼樣(輪次、階段、兩回合、延長、PK)

   免費方案限 10 requests/分鐘,所以這裡硬上限 8 個請求、每個間隔 7 秒。 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'probes', 'ucl.json');
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const BASE = 'https://api.football-data.org/v4';
const MAX = 8;
const GAP = 7000;
let n = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(path) {
  if (n >= MAX) return { skipped: 'request-cap' };
  if (n) await sleep(GAP);
  n++;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'X-Auth-Token': TOKEN }, signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (e) { return { status: null, error: e.name || 'network-error' }; }
}

if (!TOKEN) {
  console.log('⚠ 未設定 FOOTBALL_DATA_TOKEN,略過。');
  process.exit(0);
}

const out = { retrievedAt: new Date().toISOString(), source: 'football-data.org', seasons: {} };

// 一、賽事本身開放哪些賽季
const comp = await get('/competitions/CL');
out.competition = {
  status: comp.status,
  name: comp.body?.name ?? null,
  currentSeason: comp.body?.currentSeason
    ? { startDate: comp.body.currentSeason.startDate, endDate: comp.body.currentSeason.endDate,
        matchday: comp.body.currentSeason.currentMatchday }
    : null,
  seasons: (comp.body?.seasons ?? []).map(s => ({
    start: s.startDate?.slice(0, 4), startDate: s.startDate, endDate: s.endDate, winner: s.winner?.shortName ?? null,
  })),
  message: comp.body?.message ?? null,
};
console.log(`── /competitions/CL → HTTP ${comp.status}`);
if (out.competition.message) console.log(`   訊息:${out.competition.message}`);
console.log(`   回報賽季:${out.competition.seasons.map(s => s.start).join('、') || '(無)'}`);

// 二、逐季試 matches。403 = 方案不給,200 + count 0 = 還沒開打,兩者結論完全不同
for (const season of ['2024', '2025', '2026']) {
  const r = await get(`/competitions/CL/matches?season=${season}`);
  const ms = Array.isArray(r.body?.matches) ? r.body.matches : [];
  const stages = [...new Set(ms.map(m => m.stage))];
  const played = ms.filter(m => m.status === 'FINISHED');
  out.seasons[season] = {
    status: r.status,
    // 403 是被方案擋下,不是「沒有這一季」—— 要分得開,不然會寫錯結論
    verdict: r.status === 403 ? 'plan-restricted'
      : r.status === 200 && ms.length === 0 ? 'empty-yet'
      : r.status === 200 ? 'available' : `http-${r.status}`,
    message: r.body?.message ?? null,
    count: ms.length,
    finished: played.length,
    stages,
    sample: ms[0] ? {
      utcDate: ms[0].utcDate, stage: ms[0].stage, group: ms[0].group, matchday: ms[0].matchday,
      status: ms[0].status,
      home: ms[0].homeTeam?.shortName ?? ms[0].homeTeam?.name, away: ms[0].awayTeam?.shortName ?? ms[0].awayTeam?.name,
      // 兩回合、延長、PK 是盃賽版面的骨架,要確認欄位真的有
      scoreKeys: ms[0].score ? Object.keys(ms[0].score) : null,
      fullTime: ms[0].score?.fullTime, halfTime: ms[0].score?.halfTime,
      extraTime: ms[0].score?.extraTime ?? null, penalties: ms[0].score?.penalties ?? null,
    } : null,
    // 有沒有英超/西甲球隊在裡面 —— 決定這一頁跟本站既有資料接不接得起來
    teams: [...new Set(ms.flatMap(m => [m.homeTeam?.shortName, m.awayTeam?.shortName]).filter(Boolean))].length,
  };
  const v = out.seasons[season];
  console.log(`── season=${season} → HTTP ${r.status}・${v.verdict}・${v.count} 場(完賽 ${v.finished})・${v.teams} 隊`);
  if (v.message) console.log(`   訊息:${v.message}`);
  if (v.stages.length) console.log(`   階段:${v.stages.join('、')}`);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`\n✔ 已寫入 ${OUT}(用了 ${n}/${MAX} 個請求)`);
