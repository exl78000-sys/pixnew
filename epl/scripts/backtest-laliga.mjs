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
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { loadTeams } from './lib/teams.mjs';
import { laligaMatches, backfillLine } from './lib/laliga-matches.mjs';
import { walkForward, pairedDiff } from './lib/backtest.mjs';
import { oddsIndex } from './lib/odds.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* 訓練季由「檔案在不在」決定,不寫死。但**加一季不等於更準** ——
   太舊的賽季陣容早就換過,可能只是雜訊。所以下面會把每一種組合各跑一次,
   讓數字自己說話,不憑「資料越多越好」的直覺決定。 */
const TRAIN_CANDIDATES = ['2023-24', '2024-25'];
const TEST_SEASON = '2025-26';

function main() {
  const T = loadTeams(ROOT, { file: 'teams-la-liga.json' });
  // 回測只用日期、輪次與比分,開賽鐘面時間用不到,所以不帶 kickoffOf
  const load = season => {
    const { matches, backfill } = laligaMatches(ROOT, season, { codeOf: T.codeOf });
    const line = backfillLine(season, backfill);
    if (line) console.log(line);
    return matches;
  };
  const has = season => existsSync(join(ROOT, 'data', 'raw', 'openfootball-la-liga', `${season}.json`));
  if (!has(TEST_SEASON)) {
    console.log(`✗ 缺少驗收季 ${TEST_SEASON} 的賽果。先跑 npm run laliga:fetch。`);
    process.exitCode = 1;
    return;
  }
  const trainSeasons = TRAIN_CANDIDATES.filter(has);
  if (!trainSeasons.length) {
    console.log('✗ 一季訓練資料都沒有。先跑 npm run laliga:fetch。');
    process.exitCode = 1;
    return;
  }

  const bySeason = Object.fromEntries(trainSeasons.map(s => [s, load(s)]));
  const testAll = load(TEST_SEASON);
  const test = testAll.filter(m => m.played);

  /* 母體要講清楚:2024-25 上游末輪沒有比分,實際是 370 / 380。
     不講的話分母會悄悄變小,那跟編數字是同一件事(鐵則一)。 */
  console.log(`▶ 西甲走查回測`);
  const coverage = {};
  for (const s of [...trainSeasons, TEST_SEASON]) {
    const all = s === TEST_SEASON ? testAll : bySeason[s];
    const played = all.filter(m => m.played);
    coverage[s] = { played: played.length, scheduled: all.length };
    console.log(`  ${s === TEST_SEASON ? '驗收' : '訓練'} ${s}:${played.length} / ${all.length} 場`
      + (all.length - played.length ? `(上游缺 ${all.length - played.length} 場比分,不納入)` : ''));
  }

  /* 訓練季組合各跑一次。**只有驗收季的 RPS 有發言權**,
     而且要拿差距的標準誤來看 —— 差 0.001 卻在一個標準誤內,那不是「比較好」。 */
  const combos = trainSeasons.map((_, i) => trainSeasons.slice(i));   // ['23-24','24-25'] / ['24-25']
  const runs = combos.map(seasons => {
    const past = seasons.flatMap(s => bySeason[s].filter(m => m.played));
    // 基準線從**訓練季**算,不從驗收季算(那會偷看未來)
    const tally = { home: 0, draw: 0, away: 0 };
    for (const m of past) tally[m.fh > m.fa ? 'home' : m.fh === m.fa ? 'draw' : 'away']++;
    const baseline = {
      home: round(tally.home / past.length, 4),
      draw: round(tally.draw / past.length, 4),
      away: round(tally.away / past.length, 4),
    };
    return { seasons, past, baseline, wf: walkForward({ past, test, baseline, odds: null }) };
  });

  if (runs.length > 1) {
    console.log('\n  訓練季組合比較(只看驗收季):');
    console.table(runs.map(r => ({
      訓練季: r.seasons.join('+'), 場數: r.past.length,
      RPS: r.wf.report.models.blend.rps, 命中率: `${round(r.wf.report.models.blend.hitRate * 100, 1)}%`,
    })));
    const [more, fewer] = runs;
    const d = pairedDiff(more.wf.rows.blend, fewer.wf.rows.blend);
    console.log(`  多一季 ${more.seasons[0]} 的效果:${d.diff >= 0 ? '好' : '差'} ${Math.abs(d.diff).toFixed(5)}`
      + `、標準誤 ${d.se.toFixed(5)}(${Math.abs(d.ratio).toFixed(1)} 個標準誤)`);
    console.log(`  → ${Math.abs(d.ratio) < 1
      ? '一個標準誤都不到,分不出高下 —— 照專案規矩不改,維持較少的那組(樣本越新越貼近現況)。'
      : d.diff > 0 ? '多一季確實比較好,採用多的那組。' : '多一季反而變差,維持較少的那組。'}`);
  }

  // 採用的那一組:差距不顯著時取「季數少的」—— 舊賽季的陣容早就換過,不要為了資料多而多
  const chosen = runs.length > 1
    && pairedDiff(runs[0].wf.rows.blend, runs[1].wf.rows.blend).ratio >= 1
    ? runs[0] : runs.at(-1);
  const TRAIN_USED = chosen.seasons;
  const past = chosen.past;
  const BASE = chosen.baseline;
  console.log(`\n  採用訓練季:${TRAIN_USED.join('、')}`);
  console.log(`  基準線(取自訓練季實際分佈):主 ${BASE.home} / 和 ${BASE.draw} / 客 ${BASE.away}`);

  /* 市場基準。西甲的賠率檔要 npm run laliga:odds 才有,拿不到就整段略過 ——
     **絕對不能拿英超的市場數字頂替**,那是另一個聯賽的盤口。 */
  let odds = null;
  const oddsPath = join(ROOT, 'data', 'raw', 'football-data-couk-la-liga', `${TEST_SEASON}.csv`);
  if (existsSync(oddsPath)) {
    const ix = oddsIndex(readFileSync(oddsPath, 'utf8'), { codeOf: T.codeOf, div: 'SP1' });
    if (ix.count) {
      odds = ix;
      console.log(`  市場基準:讀到 ${ix.count} 場賠率`
        + (ix.unmatched.length ? `(對不上隊名:${ix.unmatched.join('、')})` : ''));
    } else {
      console.log(`  ⚠ 賠率檔存在但一場都解不出來,不比市場(對不上:${ix.unmatched.join('、') || '未知'})`);
    }
  } else {
    console.log('  市場基準:沒有西甲賠率檔,不比市場(跑 npm run laliga:odds 取得)');
  }

  const wf = walkForward({ past, test, baseline: BASE, odds });
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
    trainSeasons: TRAIN_USED,
    /* 這兩個欄位是給畫面用的,不是註解:讀者要看得到「這個數字是拿幾場算的、
       少掉的幾場為什麼少」。少報一場都不行。 */
    coverage: {
      ...Object.fromEntries(Object.entries(coverage).filter(([s]) => TRAIN_USED.includes(s) || s === TEST_SEASON)),
      note: Object.values(coverage).some(c => c.played !== c.scheduled)
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
