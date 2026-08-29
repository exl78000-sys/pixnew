#!/usr/bin/env node
/* 教練前任期需要的 football-data.co.uk 靜態季檔,一次補齊。
 *
 * 這是**一次性回填**:歷史賽季的檔案不會再變,抓下來進版控,CI 不用重抓。
 * 需要哪些檔是從核對過的職涯(coach-careers-verified.json 的 previous[0])
 * 推出來的 —— careerBlock 只算最近一段任期的風格,所以只抓 previous[0] 的。
 * 網址格式:https://www.football-data.co.uk/mmz4281/{yy1yy2}/{DIV}.csv(靜態檔)。
 *
 * 放置:E0/E1/SP1 的舊賽季放進**既有**目錄(檔名照舊 {season}.csv),
 * coach-career 的季迴圈自動吃到;新聯賽放 football-data-couk-extra/{DIV}/。
 *
 *   node scripts/fetch-tenure-csvs.mjs
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const yy = season => season.slice(2, 4) + season.slice(5, 7);

/* [目錄, div, 賽季們]。清單的出處(哪位教練的哪段任期)寫在旁邊,
   之後要加誰照樣列 —— 不要抓「可能有用」的,只抓職涯真的用到的。 */
const NEED = [
  // 既有目錄的舊賽季
  ['football-data-couk', 'E0', ['2018-19', '2019-20', '2020-21', '2022-23']],           // Pellegrini WHU / Lampard CHE / Jones SOU
  ['football-data-couk-championship', 'E1', ['2016-17', '2017-18', '2018-19', '2022-23']], // Parkinson BOL / Wilder WAT
  ['football-data-couk-la-liga', 'SP1', ['2020-21', '2021-22', '2022-23', '2023-24']],  // Emery VIL / Bordalás VAL / Quique SEV / García ALA
  // 新聯賽(football-data-couk-extra/{DIV}/)
  ['football-data-couk-extra/D1', 'D1', ['2021-22', '2022-23', '2023-24', '2024-25']],  // Rose 萊比錫 / Glasner 法蘭克福 / Farke 門興 / Terzic BVB / Matarazzo 霍芬海姆
  ['football-data-couk-extra/D2', 'D2', ['2022-23', '2023-24']],                        // Hürzeler St. Pauli
  ['football-data-couk-extra/I1', 'I1', ['2021-22', '2022-23']],                        // Dionisi Sassuolo
  ['football-data-couk-extra/F1', 'F1', ['2021-22', '2022-23']],                        // Stéphan 史特拉斯堡
  ['football-data-couk-extra/P1', 'P1', ['2023-24', '2024-25', '2025-26']],             // Peixoto Moreirense / Anselmi Porto / Mourinho Benfica
  ['football-data-couk-extra/B1', 'B1', ['2024-25']],                                   // Hayen 布魯日
  ['football-data-couk-extra/SC0', 'SC0', ['2023-24', '2024-25']],                      // Clement Rangers
  ['football-data-couk-extra/SP2', 'SP2', ['2021-22', '2023-24', '2024-25']],           // José Alberto 希洪 / Hidalgo Huesca
  ['football-data-couk-extra/E2', 'E2', ['2023-24', '2024-25', '2025-26']],             // Skubala 林肯城
  ['football-data-couk-extra/E3', 'E3', ['2019-20', '2020-21', '2021-22']],             // Barry-Murphy Salford
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  let got = 0, skip = 0, fail = 0;
  for (const [dir, div, seasons] of NEED) {
    mkdirSync(join(ROOT, 'data', 'raw', dir), { recursive: true });
    for (const season of seasons) {
      const dest = join(ROOT, 'data', 'raw', dir, `${season}.csv`);
      if (existsSync(dest)) { skip++; continue; }
      const url = `https://www.football-data.co.uk/mmz4281/${yy(season)}/${div}.csv`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      if (!res.ok || !text.includes('HomeTeam')) {
        console.log(`  ✗ ${div} ${season}:HTTP ${res.status}${text.includes('HomeTeam') ? '' : '(內容不是季檔)'}`);
        fail++;
      } else {
        writeFileSync(dest, text);
        console.log(`  ✓ ${div} ${season}(${(text.length / 1024).toFixed(0)} KB)`);
        got++;
      }
      await sleep(400);
    }
  }
  console.log(`完成:新抓 ${got}、已有 ${skip}、失敗 ${fail}`);
  if (fail) process.exitCode = 1;
}

main();
