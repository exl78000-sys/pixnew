#!/usr/bin/env node
/* 法甲走查回測 —— 實作在 lib/backtest-runner.mjs,跟西甲、英冠、德甲**同一支**。
 *
 * 各寫一份的話,兩個聯賽的 RPS 差 0.01 就分不出是聯賽的差異還是實作的差異
 * (CLAUDE.md:跨聯賽的轉換與流程一律共用,不複製)。
 *
 * 訓練 2023-24 / 2024-25 → 驗收 2025-26(306 場)。
 * 驗收季不用本季:本季只踢了十幾場,那個樣本量算出來的 RPS 標準誤
 * 比兩個模型的差距還大,報出來沒有意義。
 *
 *   npm run fr1:backtest
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLeagueBacktest } from './lib/backtest-runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = runLeagueBacktest({
  root: ROOT, league: 'fr1', label: '法甲',
  teamFile: 'teams-ligue-1.json', competition: 'fra.1',
  rawDir: 'openfootball-ligue-1', fillDir: 'football-data-couk-ligue-1', div: 'F1',
  /* football-data.co.uk 的隊名是簡稱,跟 openfootball 的全名對不上。
     **不走寬鬆比對** —— 用名冊裡逐隊列出來的 fd 欄(名字怎麼來的見那份檔案的 _note)。 */
  codeOf: T => {
    const byFd = new Map(T.list.filter(t => t.fd).map(t => [t.fd, t.code]));
    return name => byFd.get(name) ?? T.codeOf(name);
  },
  trainCandidates: ['2023-24', '2024-25'],
  testSeason: '2025-26',
  outFile: 'backtest-ligue-1.json', matchesFile: 'backtest-ligue-1-matches.json',
});
if (!r.ok) process.exitCode = 1;
