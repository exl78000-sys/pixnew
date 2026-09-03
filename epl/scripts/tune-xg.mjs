#!/usr/bin/env node
/* 用逐場 xG 擬合攻守強度 —— 有沒有比用進球好?(2026-09-04)
 *
 *   node scripts/tune-xg.mjs
 *
 * 動機:模型輸給市場 0.0025 RPS。進球是 xG 的雜訊版本(一季 38 場的進球數,運氣佔比不小),
 * 文獻裡最常見的改法是拿 xG 當擬合目標。本站現在有 Understat 逐場球隊 xG 2023-24 起三季
 * (每隊每季進球合計對回本站賽果,對不上整隊不收)。
 *
 * 協議跟 tune-form 一模一樣:
 *   調參賽季 2024-25(訓練 2023-24)  → 在 w ∈ {0, .25, .5, .75, 1} 裡挑(w = xG 在擬合目標裡的比重)
 *   驗收賽季 2025-26(訓練 2023-24 + 2024-25)→ 沒參與挑選,只跑一次;改善要大過成對標準誤才算數
 * 每場的擬合目標 = w·xG + (1−w)·進球;沒有 xG 的場次退回進球(並印出涵蓋率)。
 * ρ 與 Elo 仍用真實進球。輸出 data/xg-tuning.json;沒過就寫進「試過不通」,不進模型。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { loadTeams } from './lib/teams.mjs';
import { loadMatches } from './lib/adapters/index.mjs';
import { COMPETITION } from './lib/sources.mjs';
import { fitPoisson, applyPromotedPrior, lambdas, outcomeProbs } from './lib/poisson.mjs';
import { buildElo, eloProbs } from './lib/elo.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TUNE = { season: '2024-25', train: ['2023-24'] };
const HOLDOUT = { season: '2025-26', train: ['2023-24', '2024-25'] };
const WEIGHTS = [0, 0.25, 0.5, 0.75, 1];
/* α = Dixon-Coles 在混合裡的比重(現行 0.5)。xG 擬合的改善在 DC 單獨看是混合後的兩倍 ——
   五五混合把它吃掉一半,所以把 α 也放進同一輪:調參季挑 (w, α),驗收季只驗那一組。 */
const ALPHAS = [0.5, 0.6, 0.7, 0.8, 0.9, 1];

const outcome = m => (m.fh > m.fa ? 0 : m.fh === m.fa ? 1 : 2);
function rps(p, o) {
  const pv = [p.home, p.draw, p.away], ov = [0, 0, 0]; ov[o] = 1;
  let cp = 0, co = 0, s = 0;
  for (let i = 0; i < 2; i++) { cp += pv[i]; co += ov[i]; s += (cp - co) ** 2; }
  return s / 2;
}

/* 逐場 xG 對照:(隊, 日期) → xg(那隊該場的 xG)。兩隊各自的紀錄要對得起來才用(主隊的 xg = 客隊的 xga)。 */
function xgLookup() {
  const p = join(ROOT, 'data', 'raw', 'understat', 'team-dates.json');
  if (!existsSync(p)) return { get: () => null, seasons: [] };
  const store = JSON.parse(readFileSync(p, 'utf8'));
  const map = new Map();
  for (const [season, teams] of Object.entries(store.seasons)) {
    for (const [code, t] of Object.entries(teams)) {
      if (!t.verified) continue;
      for (const r of t.matches) map.set(`${code}|${r.date}`, r);
    }
  }
  return { get: (code, date) => map.get(`${code}|${date}`) ?? null, seasons: Object.keys(store.seasons) };
}
const XG = xgLookup();

/* 把 xG 掛到比賽上:home 隊的紀錄給主隊 xG,away 隊的給客隊;兩邊都要有而且互相一致(差 < 0.01)才掛。 */
function attachXg(matches) {
  let hit = 0;
  const out = matches.map(m => {
    const h = XG.get(m.home, m.date), a = XG.get(m.away, m.date);
    if (!h || !a || h.home !== true || a.home !== false || Math.abs(h.xg - a.xga) > 0.011 || Math.abs(a.xg - h.xga) > 0.011) return m;
    hit++;
    return { ...m, xgH: h.xg, xgA: a.xg };
  });
  return { matches: out, coverage: matches.length ? hit / matches.length : 0 };
}
const withTarget = (m, w) => (m.xgH == null ? m : { ...m, tfh: w * m.xgH + (1 - w) * m.fh, tfa: w * m.xgA + (1 - w) * m.fa });

/* 走查一個賽季,每個 w 各擬一次(w 影響 λ,所以不能像 tune-form 那樣只擬一次) */
function collect({ season, train }, T) {
  const load = s => loadMatches({ root: ROOT, competition: COMPETITION, season: s, codeOf: T.codeOf });
  const pastRaw = train.flatMap(load);
  const testRaw = load(season).filter(m => m.played);
  const past = attachXg(pastRaw), test = attachXg(testRaw);
  console.log(`  ${season}:訓練 ${pastRaw.length} 場(xG 涵蓋 ${round(past.coverage * 100, 1)}%)・驗 ${testRaw.length} 場(xG 涵蓋 ${round(test.coverage * 100, 1)}%)`);
  const codes = [...new Set(test.matches.flatMap(m => [m.home, m.away]))].sort();
  const rounds = [...new Set(test.matches.map(m => m.round))].sort((a, b) => a - b);
  const per = Object.fromEntries(WEIGHTS.map(w => [w, []]));
  for (const rd of rounds) {
    const games = test.matches.filter(m => m.round === rd);
    const before = [...past.matches, ...test.matches.filter(m => m.round < rd)];
    if (before.length < 100) continue;
    const refDate = games[0].date;
    const elo = buildElo(before);
    for (const w of WEIGHTS) {
      const model = applyPromotedPrior(fitPoisson(before.map(m => withTarget(m, w)), codes, { refDate, iters: 1200 }));
      for (const m of games) {
        const { lh, la } = lambdas(model, m.home, m.away);
        const p = outcomeProbs(lh, la, model.rho);
        const e = eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500);
        const b = { home: (p.home + e.home) / 2, draw: (p.draw + e.draw) / 2, away: (p.away + e.away) / 2 };
        const o = outcome(m);
        per[w].push({ rps: rps(b, o), hit: [b.home, b.draw, b.away].indexOf(Math.max(b.home, b.draw, b.away)) === o, dcRps: rps(p, o), p, e, o });
      }
    }
  }
  return per;
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
/* 給一個 α 重新混合(不用重擬):回逐場 rps 與命中 */
const blendAt = (rows, alpha) => rows.map(r => {
  const b = { home: alpha * r.p.home + (1 - alpha) * r.e.home, draw: alpha * r.p.draw + (1 - alpha) * r.e.draw, away: alpha * r.p.away + (1 - alpha) * r.e.away };
  return { rps: rps(b, r.o), hit: [b.home, b.draw, b.away].indexOf(Math.max(b.home, b.draw, b.away)) === r.o };
});
function paired(base, alt) {
  const d = base.map((x, i) => x.rps - alt[i].rps);   // 正 = alt 比較好
  const m = mean(d), sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1));
  return { diff: m, se: sd / Math.sqrt(d.length), n: d.length };
}

const T = loadTeams(ROOT);
console.log(`▶ xG 擬合目標的走查回測(Understat 逐場 xG:${XG.seasons.join('、')})`);
const tune = collect(TUNE, T);
const rows = WEIGHTS.map(w => ({ w, RPS: round(mean(tune[w].map(r => r.rps)), 5), 'DC 單獨 RPS': round(mean(tune[w].map(r => r.dcRps)), 5),
  對w0: round(mean(tune[w].map(r => r.rps)) - mean(tune[0].map(r => r.rps)), 5), 命中率: `${round(mean(tune[w].map(r => r.hit ? 1 : 0)) * 100, 1)}%` }));
console.log(`\n調參賽季 ${TUNE.season}`); console.table(rows);
const best = rows.slice().sort((a, b) => a.RPS - b.RPS)[0];
console.log(`調參賽季最佳 w = ${best.w}`);

console.log(`\n▶ 驗收賽季 ${HOLDOUT.season}(沒參與挑 w)`);
const hold = collect(HOLDOUT, T);
const h0 = hold[0];
const out = WEIGHTS.filter(w => w !== 0).map(w => {
  const c = paired(h0, hold[w]);
  return { w, RPS: round(mean(hold[w].map(r => r.rps)), 5), 對w0: round(-c.diff, 5), '±標準誤': round(c.se, 5), 比值: round(c.diff / c.se, 2),
    命中率: `${round(mean(hold[w].map(r => r.hit ? 1 : 0)) * 100, 1)}%`, 是挑出來的: w === best.w ? '★' : '' };
});
console.table([{ w: 0, RPS: round(mean(h0.map(r => r.rps)), 5), 對w0: 0, '±標準誤': null, 比值: null, 命中率: `${round(mean(h0.map(r => r.hit ? 1 : 0)) * 100, 1)}%`, 是挑出來的: '' }, ...out]);
const chosen = out.find(r => r.w === best.w);
const pass = best.w !== 0 && chosen && chosen.對w0 < 0 && Math.abs(chosen.對w0) > chosen['±標準誤'];
console.log(pass
  ? `\n判定(只調 w):w = ${best.w} 在驗收季改善 ${chosen.對w0}(標準誤 ${chosen['±標準誤']}),超過一個標準誤。`
  : `\n判定(只調 w):${best.w === 0 ? '調參季就沒有任何 w > 0 贏過進球' : `w = ${best.w} 在驗收季${chosen?.對w0 < 0 ? '有改善但沒超過標準誤' : '沒有改善'}`}。`);

/* ── 第二輪:(w, α) 一起挑 ── */
console.log(`\n▶ (w, α) 一起調:調參賽季 ${TUNE.season}`);
const grid = [];
for (const w of WEIGHTS) for (const alpha of ALPHAS) grid.push({ w, alpha, RPS: round(mean(blendAt(tune[w], alpha).map(r => r.rps)), 5) });
grid.sort((a, b) => a.RPS - b.RPS);
console.table(grid.slice(0, 8));
const best2 = grid[0];
const base2 = blendAt(hold[0], 0.5);            // 現行:進球擬合、五五混合
const alt2 = blendAt(hold[best2.w], best2.alpha);
const c2 = paired(base2, alt2);
const pass2 = c2.diff > 0 && c2.diff > c2.se;
console.log(`\n▶ 驗收賽季 ${HOLDOUT.season}:挑出來的 (w = ${best2.w}, α = ${best2.alpha})`);
console.table([
  { 設定: '現行(w=0, α=0.5)', RPS: round(mean(base2.map(r => r.rps)), 5), 對現行: 0, '±標準誤': null, 比值: null, 命中率: `${round(mean(base2.map(r => r.hit ? 1 : 0)) * 100, 1)}%` },
  { 設定: `w=${best2.w}, α=${best2.alpha}`, RPS: round(mean(alt2.map(r => r.rps)), 5), 對現行: round(-c2.diff, 5), '±標準誤': round(c2.se, 5), 比值: round(c2.diff / c2.se, 2), 命中率: `${round(mean(alt2.map(r => r.hit ? 1 : 0)) * 100, 1)}%` },
]);
console.log(pass2
  ? `\n判定:(w=${best2.w}, α=${best2.alpha}) 在驗收季改善 ${round(-c2.diff, 5)}(標準誤 ${round(c2.se, 5)},比值 ${round(c2.diff / c2.se, 2)}),超過一個標準誤 —— 值得進模型。`
  : `\n判定:(w=${best2.w}, α=${best2.alpha}) 在驗收季${c2.diff > 0 ? '有改善但沒超過標準誤' : '沒有改善'}(比值 ${round(c2.diff / c2.se, 2)})。不進模型,寫進「試過不通」。`);
writeFileSync(join(ROOT, 'data', 'xg-tuning.json'), JSON.stringify({
  ranAt: new Date().toISOString(), protocol: { tune: TUNE, holdout: HOLDOUT, weights: WEIGHTS, target: 'w·xG + (1−w)·goals;ρ 與 Elo 用進球' },
  xgSeasons: XG.seasons, tune: rows, bestTuneW: best.w, holdout: out, holdoutBase: round(mean(h0.map(r => r.rps)), 5), pass,
  joint: { alphas: ALPHAS, tuneTop: grid.slice(0, 8), best: { w: best2.w, alpha: best2.alpha }, holdout: { rps: round(mean(alt2.map(r => r.rps)), 5), base: round(mean(base2.map(r => r.rps)), 5), diff: round(-c2.diff, 5), se: round(c2.se, 5), ratio: round(c2.diff / c2.se, 2), pass: pass2 } },
}, null, 2));
console.log('  ✓ data/xg-tuning.json');
