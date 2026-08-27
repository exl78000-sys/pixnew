#!/usr/bin/env node
/* 西甲走查回測。
 *
 * 跟英超跑的是**同一份實作**(lib/backtest.mjs),協議一模一樣:
 * 只用比賽日之前的資料建模、一定要跟基準線比、母體要講清楚。
 * 這樣兩個聯賽的 RPS 才真的可以放在一起看 —— 如果各寫一份,
 * 數字差 0.01 就分不出是聯賽的差異還是實作的差異。
 *
 * 訓練 2024-25 → 驗收 2025-26。為什麼不是驗收本季:本季只踢了 16 場,
 * 那個樣本量算出來的 RPS 標準誤比兩個模型的差距還大,報出來沒有意義。
 *
 * 基準線不寫死。英超那條 { .44/.25/.31 } 是英超的長期分佈,
 * 直接搬到西甲就是拿別的聯賽的先驗當這個聯賽的基準 —— 那是編的。
 * 這裡從**訓練季**實際算,不從驗收季算(那會偷看未來)。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { loadTeams } from './lib/teams.mjs';
import { loadMatches } from './lib/adapters/index.mjs';
import { walkForward, metric } from './lib/backtest.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPETITION = 'esp.1';
const TRAIN_SEASON = '2024-25';
const TEST_SEASON = '2025-26';

function main() {
  const T = loadTeams(ROOT, { file: 'teams-la-liga.json' });
  const load = season => loadMatches({
    root: ROOT, competition: COMPETITION, season, codeOf: T.codeOf,
    // 回測只用日期、輪次與比分,開賽鐘面時間用不到,所以不帶 kickoffOf
    rawDir: 'openfootball-la-liga',
  });
  for (const season of [TRAIN_SEASON, TEST_SEASON]) {
    const f = join(ROOT, 'data', 'raw', 'openfootball-la-liga', `${season}.json`);
    if (!existsSync(f)) {
      console.log(`✗ 缺少 ${season} 的賽果(${f})。先跑 npm run laliga:fetch。`);
      process.exitCode = 1;
      return;
    }
  }

  const trainAll = load(TRAIN_SEASON);
  const past = trainAll.filter(m => m.played);
  const testAll = load(TEST_SEASON);
  const test = testAll.filter(m => m.played);

  /* 母體要講清楚:2024-25 上游末輪沒有比分,實際是 370 / 380。
     不講的話分母會悄悄變小,那跟編數字是同一件事(鐵則一)。 */
  const dropped = {
    [TRAIN_SEASON]: trainAll.length - past.length,
    [TEST_SEASON]: testAll.length - test.length,
  };
  console.log(`▶ 西甲走查回測`);
  console.log(`  訓練 ${TRAIN_SEASON}:${past.length} / ${trainAll.length} 場`
    + (dropped[TRAIN_SEASON] ? `(上游缺 ${dropped[TRAIN_SEASON]} 場比分,不納入)` : ''));
  console.log(`  驗收 ${TEST_SEASON}:${test.length} / ${testAll.length} 場`
    + (dropped[TEST_SEASON] ? `(上游缺 ${dropped[TEST_SEASON]} 場比分,不納入)` : ''));

  // 基準線從訓練季算,不從驗收季算
  const tally = { home: 0, draw: 0, away: 0 };
  for (const m of past) tally[m.fh > m.fa ? 'home' : m.fh === m.fa ? 'draw' : 'away']++;
  const BASE = {
    home: round(tally.home / past.length, 4),
    draw: round(tally.draw / past.length, 4),
    away: round(tally.away / past.length, 4),
  };
  console.log(`  基準線(取自 ${TRAIN_SEASON} 實際分佈):主 ${BASE.home} / 和 ${BASE.draw} / 客 ${BASE.away}`);

  const wf = walkForward({ past, test, baseline: BASE, odds: null });
  const M = wf.report.models;
  console.table([
    ['Dixon-Coles Poisson', M.poisson], ['Elo', M.elo],
    ['兩者平均', M.blend], ['基準線(訓練季分佈)', M.baseline],
  ].map(([名稱, m]) => ({
    模型: 名稱, 場次: wf.report.games, RPS: m.rps, LogLoss: m.logLoss,
    命中率: `${round(m.hitRate * 100, 1)}%`,
  })));

  const better = M.blend.rps < M.baseline.rps;
  console.log(better
    ? `✔ 西甲模型優於基準線(${M.blend.rps} < ${M.baseline.rps})`
    : `✗ 西甲模型沒有贏過基準線(${M.blend.rps} ≥ ${M.baseline.rps})—— 不要在頁面上宣稱模型有用`);

  const report = {
    ranAt: new Date().toISOString(),
    league: 'es1',
    season: TEST_SEASON,
    trainSeasons: [TRAIN_SEASON],
    /* 這兩個欄位是給畫面用的,不是註解:讀者要看得到「這個數字是拿幾場算的、
       少掉的幾場為什麼少」。少報一場都不行。 */
    coverage: {
      [TRAIN_SEASON]: { played: past.length, scheduled: trainAll.length },
      [TEST_SEASON]: { played: test.length, scheduled: testAll.length },
      note: dropped[TRAIN_SEASON] || dropped[TEST_SEASON]
        ? '上游(openfootball)有部分場次沒有比分,那些場次不納入回測母體。'
        : null,
    },
    ...wf.report,
  };
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'backtest-laliga.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(ROOT, 'data', 'backtest-laliga-matches.json'), JSON.stringify({
    league: 'es1', season: TEST_SEASON, ranAt: report.ranAt, matches: wf.perMatch,
  }));
  console.log(`→ 已寫入 data/backtest-laliga.json 與 backtest-laliga-matches.json(${wf.perMatch.length} 場)`);
  if (!better) process.exitCode = 1;
}

main();
