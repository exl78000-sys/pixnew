#!/usr/bin/env node
/* 西甲走查回測 —— **實作在 lib/backtest-runner.mjs**,這裡只給設定。
 *
 * 跟英超跑的是同一份協議:只用比賽日之前的資料建模、一定要跟基準線比、
 * 母體要講清楚。英冠也走同一支 runner —— 各寫一份的話,
 * 兩個聯賽的 RPS 差 0.01 就分不出是聯賽的差異還是實作的差異。
 *
 * 訓練 2023-24 / 2024-25 → 驗收 2025-26。為什麼不是驗收本季:
 * 本季只踢了十幾場,那個樣本量算出來的 RPS 標準誤比兩個模型的差距還大。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLeagueBacktest } from './lib/backtest-runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = runLeagueBacktest({
  root: ROOT, league: 'es1', label: '西甲',
  teamFile: 'teams-la-liga.json', competition: 'esp.1',
  rawDir: 'openfootball-la-liga', fillDir: 'football-data-couk-la-liga', div: 'SP1',
  /* 訓練季由「檔案在不在」決定,不寫死。但**加一季不等於更準** ——
     太舊的賽季陣容早就換過,可能只是雜訊。runner 會把每一種組合各跑一次,
     讓數字自己說話,不憑「資料越多越好」的直覺決定。 */
  trainCandidates: ['2023-24', '2024-25'],
  testSeason: '2025-26',
  outFile: 'backtest-laliga.json', matchesFile: 'backtest-laliga-matches.json',
});
if (!r.ok) process.exitCode = 1;
