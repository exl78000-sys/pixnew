#!/usr/bin/env node
/* 德甲(Bundesliga)的兩個來源 → data/raw/。實作在 `lib/league-fetch.mjs` ——
 * 跟英冠、義甲、法甲**同一支**,這裡只有德甲自己的參數。
 *
 *   openfootball/football.json  de.1.json   賽程 + 賽果 + 半場比分 + 輪次(主來源)
 *   football-data.co.uk         D1.csv      賽果 + 逐場統計(射門/角球/牌)+ 賠率(獨立來源)
 *
 *   npm run de1:fetch
 *
 * 倉庫裡 2021-22 ~ 2024-25 的 D1 已經有了(`football-data-couk-extra/D1/`,教練任期那一輪抓的),
 * 所以 legacyDir 指過去 —— 再抓一次只是浪費上游的頻寬。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLeagueSources } from './lib/league-fetch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

await fetchLeagueSources({
  root: ROOT, zh: '德甲', ofCode: 'de.1', fdDiv: 'D1',
  ofDir: 'openfootball-bundesliga', fdDir: 'football-data-couk-bundesliga',
  /* 本季與上季是必要的(少了就建不了站);再往前是走查回測要的訓練季。 */
  required: ['2025-26', '2026-27'],
  optional: ['2023-24', '2024-25'],
  minMatches: 280,          // 18 隊 × 34 輪 = 306 場排完
  fdRequired: false,        // 沙箱抓不到那個網域,擋下來只會讓本機永遠跑不完
  legacyDir: 'D1',
});
