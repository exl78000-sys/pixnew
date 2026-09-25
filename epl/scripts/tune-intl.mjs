#!/usr/bin/env node
/* 國家隊 Elo 的調參與驗收(鐵則二:調參與驗收用不同年份,改善要大過成對標準誤)。
 *
 *   npm run tune:intl
 *
 * 調參只看 TUNE 那幾年、驗收只看 HOLDOUT 那幾年 —— 中間空一段(2020–2021,疫情年比賽少而且
 * 很多移到中立場),兩段之間沒有任何一場重疊。驗收用的參數**在調參結束時就固定了**,
 * 驗收那一批比賽完全沒參與挑選。
 *
 * 另外量一件上線才會遇到的事:**FotMob 的賽程不告訴你是不是中立場。** 上線時未賽的比賽
 * 一律當「名單上的主隊在主場」算,那在真的是中立場的比賽上會多給主隊 homeAdv 分。
 * 代價不是猜的 —— 在驗收那一批上把中立場當主場重算一次,差多少照實寫進產物。
 * 2026-09-25 起再挑一個**賽前推中立場**的做法(`venue`):參數一樣只用調參期挑、驗收期驗。
 *
 * 輸出 data/intl-elo-params.json(參數 + 調參與驗收當時的紀錄)。建置時讀它,
 * 並且**每次建置重算一次驗收**(參數不變、資料會長),畫面讀的是建置那一份。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseIntlResults, backtestIntl, frequencyBaseline, pairedGain, tournamentClass, venuePrior, venueBacktest,
  INTL_TUNE as TUNE, INTL_HOLDOUT as HOLDOUT, INTL_MIN_GAMES as MIN_GAMES,
} from './lib/intl.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRID = {
  homeAdv: [50, 75, 100, 125, 150],
  kScale: [0.5, 0.75, 1, 1.25],
  drawA: [0.26, 0.30, 0.34, 0.38, 0.42],
  drawB: [0.2, 0.4, 0.6, 0.8],
};

const matches = parseIntlResults(readFileSync(join(ROOT, 'data', 'raw', 'intl', 'results.csv'), 'utf8'));
const r5 = x => Math.round(x * 1e5) / 1e5;

let best = null;
let tried = 0;
for (const homeAdv of GRID.homeAdv) for (const kScale of GRID.kScale) for (const drawA of GRID.drawA) for (const drawB of GRID.drawB) {
  const params = { homeAdv, kScale, drawA, drawB };
  const rows = backtestIntl(matches, params, { ...TUNE, minGames: MIN_GAMES });
  const rps = rows.reduce((a, r) => a + r.rps, 0) / rows.length;
  tried++;
  if (!best || rps < best.rps) best = { params, rps, n: rows.length };
}
const edges = Object.entries(GRID).filter(([k, v]) => best.params[k] === v[0] || best.params[k] === v.at(-1)).map(([k]) => k);
console.log(`調參 ${TUNE.from}~${TUNE.to}:試了 ${tried} 組,最好 ${JSON.stringify(best.params)} RPS ${best.rps.toFixed(5)}(${best.n} 場)`);
if (edges.length) console.log(`  ⚠ 落在網格邊上:${edges.join('、')} —— 往外擴一格再掃一次`);

const hold = backtestIntl(matches, best.params, { ...HOLDOUT, minGames: MIN_GAMES });
const base = frequencyBaseline(hold);
const all = pairedGain(hold, base);
const sub = f => { const rows = hold.filter(r => f(r.m)); return pairedGain(rows, frequencyBaseline(rows)); };
const competitive = sub(m => tournamentClass(m.tournament) !== 'friendly');
const friendly = sub(m => tournamentClass(m.tournament) === 'friendly');
const fmt = g => g && `${g.n} 場  模型 ${g.model.toFixed(4)} / 基準線 ${g.baseline.toFixed(4)}  改善 ${g.gain.toFixed(4)} ± ${g.se.toFixed(4)}(${g.z.toFixed(1)} SE)`;
console.log(`驗收 ${HOLDOUT.from}~:${fmt(all)}`);
console.log(`  非友誼賽:${fmt(competitive)}`);
console.log(`  友誼賽:  ${fmt(friendly)}`);

/* 「不知道是不是中立場」的代價:同一批比賽,中立場的那些改成當主場算。
   只看真的是中立場的那幾場(其他場兩種算法完全一樣),差值 = 假設錯了要付多少。 */
const neutralOnly = { ...HOLDOUT, minGames: MIN_GAMES, filter: m => m.neutral };
const truth = backtestIntl(matches, best.params, neutralOnly);
const assumed = backtestIntl(matches, best.params, { ...neutralOnly, assumeHome: true });
const cost = truth.length ? (assumed.reduce((a, r) => a + r.rps, 0) - truth.reduce((a, r) => a + r.rps, 0)) / truth.length : null;
const share = hold.length ? truth.length / hold.length : null;
const shareBy = cls => { const rows = hold.filter(r => (tournamentClass(r.m.tournament) === 'friendly') === (cls === 'friendly')); return rows.length ? rows.filter(r => r.m.neutral).length / rows.length : null; };
console.log(`中立場當主場算的代價:中立場 ${truth.length} 場(佔驗收 ${(share * 100).toFixed(1)}%;友誼賽 ${(shareBy('friendly') * 100).toFixed(1)}%、非友誼賽 ${(shareBy('other') * 100).toFixed(1)}%),`
  + `每場 RPS 多 ${cost?.toFixed(4)} → 攤到整批 ${(cost * share).toFixed(4)}`);

/* 中立場的賽前推論(2026-09-25;lib/intl.mjs 的 makeVenueModel)。上面那一段量的是「不知道」的代價,
   這一段挑一個**只用開賽前 lag 天以前的資料**推 q 的做法,**只看調參期**挑參數,驗收期驗。
   結構(主辦型看同一屆、主客場型看主隊的習慣、機率照 q 加權平均)是探索時在**調參期**比出來的:
   不分類別的主場習慣、把主場加分乘上 (1−q) 的線性版本,調參期都比較差,所以網格裡只剩這一種結構。
   lag 固定 7 天:上線時 martj42 比賽程慢(跟 intlLagCost 同一個數字);0 天與 30 天也量過,挑出來的參數一樣。 */
const VENUE_LAG = 7;
const VENUE_GRID = { N: [3, 5, 8, 12, 20], alpha: [0.5, 1, 2, 4, 8, 16, 32], W: [21, 40, 60] };
const prior = venuePrior(matches, best.params, { ...TUNE, minGames: MIN_GAMES });
let vBest = null;
let vTried = 0;
const vHome = backtestIntl(matches, best.params, { ...TUNE, minGames: MIN_GAMES, assumeHome: true });
const rpsHomeTune = vHome.reduce((a, r) => a + r.rps, 0) / vHome.length;
for (const N of VENUE_GRID.N) for (const alpha of VENUE_GRID.alpha) for (const W of VENUE_GRID.W) {
  const venue = { N, alpha, W, lag: VENUE_LAG, prior };
  const t = venueBacktest(matches, best.params, venue, { ...TUNE, minGames: MIN_GAMES });
  vTried++;
  if (!vBest || t.rps < vBest.rps) vBest = { venue, rps: t.rps, n: t.n };
}
const vEdges = Object.entries(VENUE_GRID).filter(([k, v]) => vBest.venue[k] === v[0] || vBest.venue[k] === v.at(-1)).map(([k]) => k);
console.log(`中立場推論・調參:試了 ${vTried} 組,最好 N=${vBest.venue.N} alpha=${vBest.venue.alpha} W=${vBest.venue.W} lag=${VENUE_LAG}`
  + ` RPS ${vBest.rps.toFixed(5)}(一律主場 ${rpsHomeTune.toFixed(5)})`);
if (vEdges.length) console.log(`  ⚠ 落在網格邊上:${vEdges.join('、')} —— 往外擴一格再掃一次`);
const vHold = venueBacktest(matches, best.params, vBest.venue, { ...HOLDOUT, minGames: MIN_GAMES });
const fv = g => g && `${g.gain >= 0 ? '+' : ''}${g.gain.toFixed(5)} ± ${g.se.toFixed(5)}(${g.z.toFixed(1)} SE)`;
console.log(`  驗收 ${vHold.n} 場:推論對一律主場 ${fv(vHold.inferred)}・拿賽後的中立場欄位當答案 ${fv(vHold.oracle)}`);

const out = {
  note: '國家隊 Elo 的參數。調參與驗收用不同年份;建置時會用這組參數重算一次驗收(資料會長),畫面讀建置那一份。',
  params: best.params,
  minGames: MIN_GAMES,
  tune: { ...TUNE, n: best.n, rps: r5(best.rps), tried, grid: GRID, edges },
  holdoutAtTune: {
    ...HOLDOUT, n: all.n, model: r5(all.model), baseline: r5(all.baseline), gain: r5(all.gain), se: r5(all.se),
    competitive: competitive && { n: competitive.n, gain: r5(competitive.gain), se: r5(competitive.se) },
    friendly: friendly && { n: friendly.n, gain: r5(friendly.gain), se: r5(friendly.se) },
  },
  neutralUnknown: {
    note: '上線時未賽的比賽一律當名單上的主隊在主場(FotMob 賽程沒有中立場資訊)。這是在驗收那一批上量的代價。',
    neutralMatches: truth.length, shareOfHoldout: r5(share),
    shareFriendly: r5(shareBy('friendly')), shareOther: r5(shareBy('other')),
    rpsCostPerNeutralMatch: r5(cost), rpsCostOverall: r5(cost * share),
  },
  venue: {
    note: '中立場的賽前推論(lib/intl.mjs 的 makeVenueModel)。參數只用調參期挑;建置每次重算驗收,沒過門檻就退回一律主場。',
    N: vBest.venue.N, alpha: vBest.venue.alpha, W: vBest.venue.W, lag: VENUE_LAG,
    prior: Object.fromEntries(Object.entries(prior).sort().map(([g, x]) => [g, r5(x)])),
    tune: { ...TUNE, n: vBest.n, rps: r5(vBest.rps), rpsHome: r5(rpsHomeTune), tried: vTried, grid: VENUE_GRID, edges: vEdges },
    holdoutAtTune: {
      ...HOLDOUT, n: vHold.n,
      gain: r5(vHold.inferred.gain), se: r5(vHold.inferred.se), oracleGain: r5(vHold.oracle.gain), oracleSe: r5(vHold.oracle.se),
    },
  },
  ranAt: new Date().toISOString(),
};
writeFileSync(join(ROOT, 'data', 'intl-elo-params.json'), JSON.stringify(out, null, 1) + '\n');
console.log('✔ data/intl-elo-params.json');
