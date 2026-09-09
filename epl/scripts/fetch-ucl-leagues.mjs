#!/usr/bin/env node
/* 抓歐冠球隊所屬聯賽的賽果(德甲 / 義甲 / 法甲),**只為了歐冠的賽前對比**。
 *
 * 為什麼要這個:歐冠一季 36 隊,本站只認得 10 支(英超 5 + 西甲 5),
 * 所以 144 場聯賽階段比賽裡兩隊都有資料的只有 8 場(6%)。加上這三個聯賽之後
 * 認得 21 支、兩隊都有的變成 48 場(33%)—— 這個數字是先量過才決定要不要做的。
 *
 * **這不是「接了三個新聯賽」。** 只抓賽果、只算積分榜、只給歐冠那一頁用:
 *   · 沒有球員層、沒有 xG、沒有陣容、沒有預測
 *   · 導覽列不掛(「導覽列只掛做得出來的三頁」)
 *   · 球隊仍然點不進去 —— 本站沒有它們的球隊頁,連過去是空的(鐵則三)
 * 想把它們做成完整聯賽是另一件事,那要照 build-championship.mjs 那條路走。
 *
 * 來源:openfootball / football.json —— 跟英超西甲英冠同一個來源、同一個 adapter,
 * 靜態檔下載(raw.githubusercontent.com),沒有金鑰也沒有配額。
 * 一季一個請求,三個聯賽三個請求。
 *
 * **2026-09-09 加抓歷史賽季**:跨聯賽 Elo(`lib/ucl-elo.mjs`)要用整池的賽果算評分,
 * 只有本季不夠 —— 開季兩輪的積分榜對預測沒有意義。實測要幾季:
 * 起始 2021-22 → 回測 RPS 0.2206、2022-23 → 0.2208、2023-24 → 0.2227、2024-25 → 0.2300。
 * 取 **2023-24 起**(本站三個聯賽的 openfootball 快取最早就是這一季,八個聯賽對齊)。
 *
 * **已完結的賽季不會再變,所以只抓一次。** TTL 只套用在本季 ——
 * 穩定之後每次仍然只有 5 個請求(跟加歷史之前一樣),不是 5 × 賽季數。
 *
 *   npm run ucl:leagues
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// 聯賽清單只有一份,在 lib 那邊 —— 抓取器與計算端各寫一份的話,加聯賽時一定會漏掉一邊
import { UCL_LEAGUES } from './lib/ucl-standings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const OUT = join(ROOT, 'data', 'raw', 'openfootball-ucl');
const FORCE = process.argv.includes('--force');
const TTL_HOURS = 6;

/* 池子要回溯到哪一季。**不是隨便選的** —— 見檔頭那組實測數字。
   往前推的季數由這裡決定,`seasonsFor` 從本季往回數。 */
const HISTORY_SEASONS = 3;

/* 「2026-27」往前推 n 季。openfootball 的目錄名就是這個格式。 */
function seasonsFor(current, n) {
  const m = /^(\d{4})-(\d{2})$/.exec(current);
  if (!m) return [current];
  const y = Number(m[1]);
  const out = [];
  for (let i = n; i >= 0; i--) out.push(`${y - i}-${String((y - i + 1) % 100).padStart(2, '0')}`);
  return out;
}



/* 要抓哪一季:跟著歐冠的**本季**走,不要寫死年份。
   歐冠還沒抓到的話就不做 —— 沒有歐冠就沒有人要用這份資料。 */
async function currentSeason() {
  const p = join(ROOT, 'web', 'data', 'ucl.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(await readFile(p, 'utf8'));
    return (j.seasons ?? []).find(s => s.current)?.label ?? null;
  } catch { return null; }
}

/* isCurrent 為 false 時不看 TTL:已完結的賽季不會再變,抓過就不再抓。
   這是「加了歷史卻沒有把請求數乘上去」的關鍵 —— 沒有這一條,
   每次部署都會重抓四季 × 五個聯賽 = 20 個請求,而其中 15 個永遠拿到一樣的東西。 */
const stale = async (file, isCurrent) => {
  if (FORCE || !existsSync(file)) return true;
  if (!isCurrent) return false;
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    const age = Date.now() - Date.parse(j.retrievedAt ?? '');
    return !Number.isFinite(age) || age > TTL_HOURS * 3600000;
  } catch { return true; }
};

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

async function main() {
  const season = await currentSeason();
  if (!season) {
    console.log('歐冠聯賽賽果:還沒有 ucl.json(先跑 npm run ucl),這次不抓。');
    return;
  }
  const seasons = seasonsFor(season, HISTORY_SEASONS);
  console.log(`歐冠球隊所屬聯賽的賽果(${seasons.join('、')}) —— 積分榜用本季,跨聯賽評分用整池`);

  let fetched = 0, skipped = 0;
  for (const sea of seasons) {
    const isCurrent = sea === season;
    for (const lg of UCL_LEAGUES) {
      const dir = join(OUT, lg.key);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${sea}.json`);
      if (!(await stale(file, isCurrent))) { skipped++; continue; }

      let res;
      try {
        res = await fetch(`${BASE}/${sea}/${lg.file}.json`, { signal: AbortSignal.timeout(30000) });
      } catch (e) { console.log(`  ⚠ ${sea} ${lg.zh}:${e.message}`); continue; }

      if (!res.ok) {
        /* 404 是「這一季還沒發布」,不是「拿不到」—— 兩個結論差很多,而且季初真的會遇到。
           不落盤空殼:這份資料的用途是對比,沒有就不給對比,不需要留一個空檔案。 */
        console.log(`  ${sea} ${lg.zh}:HTTP ${res.status}${res.status === 404 ? '(這一季還沒發布)' : ''}`);
        continue;
      }
      const raw = await res.json();
      const matches = raw.matches ?? [];
      if (!matches.length) { console.log(`  ⚠ ${sea} ${lg.zh}:回了 0 場,不覆蓋既有快取`); continue; }
      await writeAtomic(file, { ...raw, retrievedAt: new Date().toISOString(), source: 'openfootball', league: lg.key });
      const played = matches.filter(m => m.score).length;
      const teams = new Set(matches.flatMap(m => [m.team1, m.team2])).size;
      console.log(`  ✔ ${sea} ${lg.zh}:${matches.length} 場・已完賽 ${played}・${teams} 隊`);
      fetched++;
    }
  }
  console.log(`  抓了 ${fetched} 份、沿用既有 ${skipped} 份(已完結的賽季只抓一次)`);
}

main().catch(e => { console.error('歐冠聯賽賽果抓取失敗:', e.message); process.exitCode = 1; });
