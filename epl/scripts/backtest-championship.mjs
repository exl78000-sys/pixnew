#!/usr/bin/env node
/* 英冠走查回測 —— 實作在 lib/backtest-runner.mjs,跟西甲同一支。
 *
 * 訓練 2023-24 / 2024-25 → 驗收 2025-26(552 場,樣本比英超西甲的 380 場還大)。
 * 驗收季不用本季:本季只踢了二十幾場,那個樣本量算出來的 RPS 標準誤
 * 比兩個模型的差距還大,報出來沒有意義。
 *
 * 升級附加賽不進回測 —— 中立場地、單場定生死,跟聯賽不是同一種比賽。
 * runner 依 stage 排除,標記由這裡給。
 *
 *   npm run en2:backtest
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLeagueBacktest } from './lib/backtest-runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = runLeagueBacktest({
  root: ROOT, league: 'en2', label: '英冠',
  teamFile: 'teams-championship.json', competition: 'eng.2',
  rawDir: 'openfootball-championship', fillDir: 'football-data-couk-championship', div: 'E1',
  /* E1 的隊名是簡稱,跟 openfootball 的全名對不上。**不走寬鬆比對** ——
     用名冊裡逐隊列出來的 fd 欄(對照怎麼配出來的見那份檔案的 _note)。 */
  codeOf: T => {
    const byFd = new Map(T.list.map(t => [t.fd, t.code]));
    return name => byFd.get(name) ?? T.codeOf(name);
  },
  stageOf: m => (m.round == null ? '升級附加賽' : null),
  trainCandidates: ['2023-24', '2024-25'],
  testSeason: '2025-26',
  outFile: 'backtest-championship.json', matchesFile: 'backtest-championship-matches.json',
});
if (!r.ok) process.exitCode = 1;
