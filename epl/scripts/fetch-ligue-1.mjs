#!/usr/bin/env node
/* 法甲(Ligue 1)的兩個來源 → data/raw/。實作在 `lib/league-fetch.mjs` ——
 * 跟英冠、德甲、義甲**同一支**,這裡只有法甲自己的參數。
 *
 *   openfootball/football.json  fr.1.json   賽程 + 賽果 + 半場比分 + 輪次(主來源)
 *   football-data.co.uk         F1.csv      賽果 + 逐場統計(射門/角球/牌)+ 賠率(獨立來源)
 *
 *   npm run fr1:fetch
 *
 * 沙箱裡直接驗過(2026-09-15):openfootball fr.1 四季各 306 場;
 * **2025-26 有一場沒有比分**(305/306)—— 那正是第二來源要補的那種,
 * 補比分走 `lib/league-matches.mjs`,逐場核對通過才收。
 * F1 的 2021-22 與 2022-23 倉庫裡就有,欄位跟 D1 一模一樣,所以 legacyDir 指過去。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLeagueSources } from './lib/league-fetch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

await fetchLeagueSources({
  root: ROOT, zh: '法甲', ofCode: 'fr.1', fdDiv: 'F1',
  ofDir: 'openfootball-ligue-1', fdDir: 'football-data-couk-ligue-1',
  required: ['2025-26', '2026-27'],
  optional: ['2023-24', '2024-25'],
  minMatches: 280,          // 18 隊 × 34 輪 = 306 場排完
  fdRequired: false,
  legacyDir: 'F1',
});
