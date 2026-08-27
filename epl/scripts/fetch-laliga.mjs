#!/usr/bin/env node
// 西甲資料版只抓 2025-26 與 2026-27 的 openfootball 公共領域賽果/賽程。
// 獨立目錄避免與英超同名賽季檔互相覆蓋。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'openfootball-la-liga');
const BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';
/* 2025-26 與 2026-27 是必要的(少了就不能建站,拿不到要當錯誤)。

   2023-24 與 2024-25 是**選配**。它們解開兩件事:
   - 2024-25:西甲有兩季完整歷史 → 走查回測跑得起來(已完成,RPS 0.2043)
   - 2023-24:進球情境特徵的驗收跑得起來 —— 調參季 2024-25 需要
     **它自己的前一季**當先驗(拿本季彙總預測本季就是偷看未來),
     那就是 2023-24。少了它,調參那一段整個做不成。
   而 fetch-setpieces 需要該季的賽果檔才推得出當季的 20 隊隊碼,
   所以要抓的不只是情境,還有賽果本身。

   歷史季拿不到只警告不拋錯 —— 但一定要印出來,不要靜靜吞掉。 */
const REQUIRED = ['2025-26', '2026-27'];
const OPTIONAL = ['2023-24', '2024-25'];
const SEASONS = [...OPTIONAL, ...REQUIRED];

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const season of SEASONS) {
    const url = `${BASE}/${season}/es.1.json`;
    const res = await fetch(url, { headers: { 'user-agent': 'war-room/1.0 (football analysis side project)' } });
    if (!res.ok) {
      if (OPTIONAL.includes(season)) {
        console.log(`  ⚠ ${season}(選配)拿不到:HTTP ${res.status} —— 跳過。`);
        console.log(`     少了它,依賴這一季的回測或特徵驗收會照實擋下來,不會硬跑出假結果。`);
        continue;
      }
      throw new Error(`${season} 抓取失敗:HTTP ${res.status}`);
    }
    const text = await res.text();
    const json = JSON.parse(text);
    if (!Array.isArray(json.matches) || json.matches.length < 300) {
      if (OPTIONAL.includes(season)) {
        console.log(`  ⚠ ${season}(選配)資料不完整:${json.matches?.length ?? 0} 場 —— 跳過。`);
        continue;
      }
      throw new Error(`${season} 資料不完整:${json.matches?.length ?? 0} 場`);
    }
    await writeFile(join(OUT, `${season}.json`), JSON.stringify(json));
    console.log(`✓ 西甲 ${season}:${json.matches.length} 場`);
  }
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exit(1); });
