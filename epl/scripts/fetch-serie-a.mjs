#!/usr/bin/env node
/* 義甲(Serie A)的兩個來源 → data/raw/。實作在 `lib/league-fetch.mjs` ——
 * 跟英冠、德甲、法甲**同一支**,這裡只有義甲自己的參數。
 *
 *   openfootball/football.json  it.1.json   賽程 + 賽果 + 半場比分 + 輪次(主來源)
 *   football-data.co.uk         I1.csv      賽果 + 逐場統計(射門/角球/牌)+ 賠率(獨立來源)
 *
 *   npm run it1:fetch
 *
 * 沙箱裡直接驗過(2026-09-15):openfootball it.1 四季各 380 場,2023-24 ~ 2025-26 全部有比分。
 * I1 的 2021-22 與 2022-23 倉庫裡就有(`football-data-couk-extra/I1/`,教練任期那一輪抓的),
 * 欄位跟 D1 一模一樣(HS/AST/HC/HY/HR 與賠率都在),所以 legacyDir 指過去。
 * **但那兩季不涵蓋本站要的四季**,2023-24 之後要靠 runner 抓 —— 沙箱不放行那個網域。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLeagueSources } from './lib/league-fetch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

await fetchLeagueSources({
  root: ROOT, zh: '義甲', ofCode: 'it.1', fdDiv: 'I1',
  ofDir: 'openfootball-serie-a', fdDir: 'football-data-couk-serie-a',
  required: ['2025-26', '2026-27'],
  optional: ['2023-24', '2024-25'],
  minMatches: 350,          // 20 隊 × 38 輪 = 380 場排完
  fdRequired: false,        // 沙箱抓不到那個網域;缺第二來源時 build 照實標示
  legacyDir: 'I1',
});
