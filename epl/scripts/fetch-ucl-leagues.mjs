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
 *   npm run ucl:leagues
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const OUT = join(ROOT, 'data', 'raw', 'openfootball-ucl');
const FORCE = process.argv.includes('--force');
const TTL_HOURS = 6;

/* 只收「歐冠有球隊、而且 openfootball 有這一份」的聯賽。
   key 用本站的短代碼,file 是 openfootball 的檔名。 */
export const UCL_LEAGUES = [
  { key: 'de1', file: 'de.1', zh: '德甲', en: 'Bundesliga' },
  { key: 'it1', file: 'it.1', zh: '義甲', en: 'Serie A' },
  { key: 'fr1', file: 'fr.1', zh: '法甲', en: 'Ligue 1' },
];

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

const stale = async file => {
  if (FORCE || !existsSync(file)) return true;
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
  console.log(`歐冠球隊所屬聯賽的賽果(${season}) —— 只為了歐冠的賽前對比`);

  for (const lg of UCL_LEAGUES) {
    const dir = join(OUT, lg.key);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${season}.json`);
    if (!(await stale(file))) { console.log(`  ${lg.zh}:快取仍新鮮,略過`); continue; }

    let res;
    try {
      res = await fetch(`${BASE}/${season}/${lg.file}.json`, { signal: AbortSignal.timeout(30000) });
    } catch (e) { console.log(`  ⚠ ${lg.zh}:${e.message}`); continue; }

    if (!res.ok) {
      /* 404 是「這一季還沒發布」,不是「拿不到」—— 兩個結論差很多,而且季初真的會遇到。
         不落盤空殼:這份資料的用途是對比,沒有就不給對比,不需要留一個空檔案。 */
      console.log(`  ${lg.zh}:HTTP ${res.status}${res.status === 404 ? '(這一季還沒發布)' : ''}`);
      continue;
    }
    const raw = await res.json();
    const matches = raw.matches ?? [];
    if (!matches.length) { console.log(`  ⚠ ${lg.zh}:回了 0 場,不覆蓋既有快取`); continue; }
    await writeAtomic(file, { ...raw, retrievedAt: new Date().toISOString(), source: 'openfootball', league: lg.key });
    const played = matches.filter(m => m.score).length;
    const teams = new Set(matches.flatMap(m => [m.team1, m.team2])).size;
    console.log(`  ✔ ${lg.zh}:${matches.length} 場・已完賽 ${played}・${teams} 隊`);
  }
}

main().catch(e => { console.error('歐冠聯賽賽果抓取失敗:', e.message); process.exitCode = 1; });
