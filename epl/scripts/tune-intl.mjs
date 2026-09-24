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
 *
 * 輸出 data/intl-elo-params.json(參數 + 調參與驗收當時的紀錄)。建置時讀它,
 * 並且**每次建置重算一次驗收**(參數不變、資料會長),畫面讀的是建置那一份。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIntlResults, backtestIntl, frequencyBaseline, pairedGain, tournamentClass } from './lib/intl.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TUNE = { from: '2014-01-01', to: '2019-12-31' };
export const HOLDOUT = { from: '2022-01-01', to: null };
export const MIN_GAMES = 20;
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
  ranAt: new Date().toISOString(),
};
writeFileSync(join(ROOT, 'data', 'intl-elo-params.json'), JSON.stringify(out, null, 1) + '\n');
console.log('✔ data/intl-elo-params.json');
