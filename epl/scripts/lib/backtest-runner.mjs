/* 走查回測的共用實作(西甲 SP1、英冠 E1 都走這裡)。
 *
 * 協議一模一樣:只用比賽日之前的資料建模、一定要跟基準線比、母體要講清楚。
 * 這樣不同聯賽的 RPS 才真的可以放在一起看 —— 如果各寫一份,
 * 數字差 0.01 就分不出是聯賽的差異還是實作的差異。
 *
 * 這一份原本整個寫在 backtest-laliga.mjs 裡。英冠要跑同一套協議,
 * 複製一份過去的話改了一邊另一邊會悄悄過期(CLAUDE.md 那條坑,而且犯過),
 * 所以抽成這裡,兩支腳本都只給設定。
 *
 * 基準線**不寫死**。英超那條 { .44/.25/.31 } 是英超的長期分佈,
 * 搬到別的聯賽就是拿別人的先驗當這個聯賽的基準 —— 那是編的。
 * 一律從**訓練季**實際算,不從驗收季算(那會偷看未來)。
 */
import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { loadTeams } from './teams.mjs';
import { leagueMatches, backfillLine } from './league-matches.mjs';
import { walkForward, pairedDiff } from './backtest.mjs';
import { oddsIndex } from './odds.mjs';
import { round } from './util.mjs';

export function runLeagueBacktest({
  root, league, label, teamFile, competition, rawDir, fillDir, div,
  trainCandidates, testSeason, outFile, matchesFile,
  codeOf: codeOfOverride = null, stageOf = null,
}) {
  const T = loadTeams(root, { file: teamFile });
  const codeOf = codeOfOverride ? codeOfOverride(T) : T.codeOf;

  // 回測只用日期、輪次與比分,開賽鐘面時間用不到,所以不帶 kickoffOf
  const load = season => {
    const { matches, backfill } = leagueMatches(root, season, {
      codeOf, competition, rawDir, fillDir, div, stageOf,
    });
    const line = backfillLine(season, backfill);
    if (line) console.log(line);
    /* 非聯賽場次(英冠的升級附加賽)不進回測:中立場地、單場定生死,
       跟模型訓練與驗收的母體不是同一種比賽。 */
    return matches.filter(m => !m.stage);
  };
  const has = season => existsSync(join(root, 'data', 'raw', rawDir, `${season}.json`));
  if (!has(testSeason)) {
    console.log(`✗ 缺少驗收季 ${testSeason} 的賽果。`);
    return { ok: false };
  }
  const trainSeasons = trainCandidates.filter(has);
  if (!trainSeasons.length) {
    console.log('✗ 一季訓練資料都沒有。');
    return { ok: false };
  }

  const bySeason = Object.fromEntries(trainSeasons.map(s => [s, load(s)]));
  const testAll = load(testSeason);
  const test = testAll.filter(m => m.played);

  console.log(`▶ ${label}走查回測`);
  /* 母體要講清楚:上游缺比分的場次不納入。
     不講的話分母會悄悄變小,那跟編數字是同一件事(鐵則一)。 */
  const coverage = {};
  for (const s of [...trainSeasons, testSeason]) {
    const all = s === testSeason ? testAll : bySeason[s];
    const played = all.filter(m => m.played);
    coverage[s] = { played: played.length, scheduled: all.length };
    console.log(`  ${s === testSeason ? '驗收' : '訓練'} ${s}:${played.length} / ${all.length} 場`
      + (all.length - played.length ? `(上游缺 ${all.length - played.length} 場比分,不納入)` : ''));
  }

  /* 訓練季組合各跑一次。**只有驗收季的 RPS 有發言權**,
     而且要拿差距的標準誤來看 —— 差 0.001 卻在一個標準誤內,那不是「比較好」。 */
  const combos = trainSeasons.map((_, i) => trainSeasons.slice(i));
  const runs = combos.map(seasons => {
    const past = seasons.flatMap(s => bySeason[s].filter(m => m.played));
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

  /* 市場基準。拿不到就整段略過 —— **絕對不能拿別的聯賽的市場數字頂替**,
     那是另一個聯賽的盤口。 */
  let odds = null;
  const oddsPath = join(root, 'data', 'raw', fillDir, `${testSeason}.csv`);
  if (existsSync(oddsPath)) {
    const ix = oddsIndex(readFileSync(oddsPath, 'utf8'), { codeOf, div });
    if (ix.count) {
      odds = ix;
      console.log(`  市場基準:讀到 ${ix.count} 場賠率`
        + (ix.unmatched.length ? `(對不上隊名:${ix.unmatched.join('、')})` : ''));
    } else {
      console.log(`  ⚠ 賠率檔存在但一場都解不出來,不比市場(對不上:${ix.unmatched.join('、') || '未知'})`);
    }
  } else {
    console.log(`  市場基準:沒有${label}賠率檔,不比市場`);
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
    ? `✔ ${label}模型優於基準線(${M.blend.rps} < ${M.baseline.rps})`
    : `✗ ${label}模型沒有贏過基準線(${M.blend.rps} ≥ ${M.baseline.rps})—— 不要在頁面上宣稱模型有用`);

  const report = {
    ranAt: new Date().toISOString(),
    league, season: testSeason, trainSeasons: TRAIN_USED,
    /* 這兩個欄位是給畫面用的,不是註解:讀者要看得到「這個數字是拿幾場算的、
       少掉的幾場為什麼少」。少報一場都不行。 */
    coverage: {
      ...Object.fromEntries(Object.entries(coverage).filter(([s]) => TRAIN_USED.includes(s) || s === testSeason)),
      note: Object.values(coverage).some(c => c.played !== c.scheduled)
        ? '上游(openfootball)有部分場次沒有比分,那些場次不納入回測母體。'
        : null,
    },
    ...wf.report,
  };
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', outFile), JSON.stringify(report, null, 2));
  writeFileSync(join(root, 'data', matchesFile), JSON.stringify({
    league, season: testSeason, ranAt: report.ranAt, matches: wf.perMatch,
  }));
  console.log(`→ 已寫入 data/${outFile} 與 ${matchesFile}(${wf.perMatch.length} 場)`);
  return { ok: better, report };
}
