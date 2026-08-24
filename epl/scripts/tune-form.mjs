#!/usr/bin/env node
// 近期狀況/交手紀錄係數的調參與驗證。
//
//   node scripts/tune-form.mjs
//
// 為什麼要獨立一支而不是直接塞進 npm test:
// 調參本身會「選出在那批資料上最好看的數字」。如果調參跟驗收用同一個賽季,
// 得到的改善多半是挑出來的雜訊,不是真的。所以這裡把兩件事分開:
//
//   調參賽季 2024-25(訓練資料 2023-24)  → 挑係數,可以盡情挑
//   驗收賽季 2025-26(訓練資料前兩季)    → 完全沒參與挑選,只跑一次
//
// 驗收賽季上有改善才算數。沒有就照實說,係數留 0(等於不調整)。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadTeams } from './lib/teams.mjs';
import { loadMatches } from './lib/adapters/index.mjs';
import { COMPETITION } from './lib/sources.mjs';
import { fitPoisson, applyPromotedPrior, lambdas, outcomeProbs } from './lib/poisson.mjs';
import { buildElo, eloProbs } from './lib/elo.mjs';
import { buildFormIndex, matchFeatures, adjustLambdas } from './lib/form.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TUNE = { season: '2024-25', train: ['2023-24'] };
const HOLDOUT = { season: '2025-26', train: ['2023-24', '2024-25'] };

const outcome = m => (m.fh > m.fa ? 0 : m.fh === m.fa ? 1 : 2);
const logLoss = (p, o) => -Math.log(Math.max(1e-9, [p.home, p.draw, p.away][o]));
function rps(p, o) {
  const pv = [p.home, p.draw, p.away];
  const ov = [0, 0, 0]; ov[o] = 1;
  let cp = 0, co = 0, s = 0;
  for (let i = 0; i < 2; i++) { cp += pv[i]; co += ov[i]; s += (cp - co) ** 2; }
  return s / 2;
}

/* 走查一個賽季,把「與係數無關」的東西全部先算好存起來。
   關鍵在於 λ 與 Elo 都不受係數影響 —— 只要跑一次,
   之後幾百組係數就只是把 λ 乘上一個數再重算機率,快得多。 */
function collect({ season, train }, T) {
  const load = s => loadMatches({ root: ROOT, competition: COMPETITION, season: s, codeOf: T.codeOf });
  const past = train.flatMap(load);
  const test = load(season).filter(m => m.played);
  const codes = [...new Set(test.flatMap(m => [m.home, m.away]))].sort();
  const rounds = [...new Set(test.map(m => m.round))].sort((a, b) => a - b);
  // 索引可以用全部比賽建 —— 查詢時一律只看 date 之前的,不會偷看未來
  const index = buildFormIndex([...past, ...test]);

  const rows = [];
  for (const rd of rounds) {
    const games = test.filter(m => m.round === rd);
    const before = [...past, ...test.filter(m => m.round < rd)];
    if (before.length < 100) continue;
    const refDate = games[0].date;
    const model = applyPromotedPrior(fitPoisson(before, codes, { refDate, iters: 1200 }));
    const elo = buildElo(before);
    for (const m of games) {
      const { lh, la } = lambdas(model, m.home, m.away);
      rows.push({
        round: rd, date: m.date, home: m.home, away: m.away,
        lh, la, rho: model.rho, fh: m.fh, fa: m.fa,
        elo: eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500),
        o: outcome(m),
        feats: matchFeatures(index, m.home, m.away, m.date),
      });
    }
  }
  return rows;
}

/* 給一組係數,算出整批比賽的表現。回傳逐場 RPS 以便做成對比較。 */
function score(rows, coef) {
  const per = [];
  let ll = 0, hit = 0;
  for (const r of rows) {
    const { lh, la } = adjustLambdas({ lh: r.lh, la: r.la }, r.feats, coef);
    const p = outcomeProbs(lh, la, r.rho);
    const b = {
      home: (p.home + r.elo.home) / 2,
      draw: (p.draw + r.elo.draw) / 2,
      away: (p.away + r.elo.away) / 2,
    };
    per.push(rps(b, r.o));
    ll += logLoss(b, r.o);
    if ([b.home, b.draw, b.away].indexOf(Math.max(b.home, b.draw, b.away)) === r.o) hit++;
  }
  const n = rows.length;
  return { per, rps: per.reduce((a, x) => a + x, 0) / n, logLoss: ll / n, hitRate: hit / n, n };
}

/* 成對比較:同一批比賽、同一個順序,逐場相減。
   為什麼要成對 —— 比賽本身難易差很多,直接比兩個平均值會被賽季難度蓋過去。
   相減之後剩下的才是「這個調整帶來的差」。 */
function paired(aPer, bPer, iters = 4000) {
  const n = aPer.length;
  const d = aPer.map((x, i) => x - bPer[i]);          // 負 = b(調整後)比較好
  const mean = d.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  // bootstrap:重抽 n 場算平均差,看有多少次「方向跟觀察到的相反」
  let against = 0;
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[(Math.random() * n) | 0];
    if ((s / n) * Math.sign(mean) <= 0) against++;
  }
  return { mean, se, p: against / iters };
}

const COEF0 = { bForm: 0, bGoal: 0, bH2h: 0 };

function grid() {
  const F = [0, 0.02, 0.04, 0.06, 0.08, 0.12, 0.16];
  const G = [0, 0.02, 0.04, 0.06, 0.08, 0.12, 0.16];
  const H = [0, 0.01, 0.02, 0.04, 0.06];
  const out = [];
  for (const bForm of F) for (const bGoal of G) for (const bH2h of H) out.push({ bForm, bGoal, bH2h });
  return out;
}

const T = loadTeams(ROOT);
console.log('▶ 走查蒐集(這一步比較久,兩個賽季各要重擬 38 次模型)');
const tune = collect(TUNE, T);
console.log(`  調參賽季 ${TUNE.season}:${tune.length} 場`);
const hold = collect(HOLDOUT, T);
console.log(`  驗收賽季 ${HOLDOUT.season}:${hold.length} 場`);

// 特徵本身長什麼樣子 —— 全是 0 的話下面怎麼調都不會動,先看一眼
const stat = key => {
  const v = tune.map(r => r.feats[key]).filter(x => Number.isFinite(x));
  const nz = v.filter(x => x !== 0).length;
  const abs = v.map(Math.abs).sort((a, b) => a - b);
  return { 特徵: key, 非零場次: nz, 絕對值中位數: round(abs[abs.length >> 1] ?? 0, 3), 最大: round(abs[abs.length - 1] ?? 0, 3) };
};
console.log(`\n▶ 特徵分佈(${TUNE.season})`);
console.table(['formH', 'formA', 'gfH', 'gaH', 'gfA', 'gaA', 'h2h'].map(stat));

/* ── 更直接的證據:特徵跟「模型算錯的部分」有沒有關係 ──────────
   網格搜尋只告訴你「調了有沒有比較好」,看不出為什麼。
   殘差相關就直白多了:殘差 = 實際 − 模型期望值,也就是模型還不知道的那部分。
   如果特徵跟殘差完全無關,那不管係數怎麼調都不可能有用 —— 它沒有新資訊。 */
function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db);
}
function residualReport(all) {
  const pts = all.map(r => ({
    resGd: (r.fh - r.fa) - (r.lh - r.la),
    resH: r.fh - r.lh, resA: r.fa - r.la,
    dForm: r.feats.formH - r.feats.formA,
    dGoal: (r.feats.gfH - r.feats.gaA) - (r.feats.gfA - r.feats.gaH),
    h2h: r.feats.h2h,
    gaA: r.feats.gaA,
  }));
  const n = pts.length;
  const row = (label, key, target) => {
    const r = corr(pts.map(x => x[key]), pts.map(x => x[target]));
    const t = Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r));
    return { 特徵: label, 相關係數: round(r, 4), t: round(t, 2), 顯著: t > 1.96 ? '是' : '否' };
  };
  return [
    row('近期勝點差 → 淨勝球殘差', 'dForm', 'resGd'),
    row('近期進失球差 → 淨勝球殘差', 'dGoal', 'resGd'),
    row('歷屆交手淨勝球 → 淨勝球殘差', 'h2h', 'resGd'),
    row('客隊近期失球 → 主隊進球殘差', 'gaA', 'resH'),
  ];
}
const resid = residualReport([...tune, ...hold]);
console.log(`\n▶ 特徵 vs 模型殘差(${tune.length + hold.length} 場,兩季合併)`);
console.log('  殘差 = 實際 − 模型期望值。相關接近 0 = 這個特徵沒有模型還不知道的資訊。');
console.table(resid);

const b0 = score(tune, COEF0);
console.log(`\n▶ 調參賽季基準(係數全 0)RPS ${round(b0.rps, 4)}`);

const results = grid().map(c => ({ c, s: score(tune, c) }))
  .sort((a, b) => a.s.rps - b.s.rps);
const best = results[0];

console.log('\n▶ 調參賽季:前 8 組係數');
console.table(results.slice(0, 8).map(r => ({
  bForm: r.c.bForm, bGoal: r.c.bGoal, bH2h: r.c.bH2h,
  RPS: round(r.s.rps, 5), 對基準: round(r.s.rps - b0.rps, 5),
})));

// 單一特徵各自的最佳值 —— 想知道是哪一個在出力(或哪一個根本沒用)
console.log('\n▶ 調參賽季:每個特徵單獨開');
const solo = [];
for (const key of ['bForm', 'bGoal', 'bH2h']) {
  const cand = results.filter(r => Object.entries(r.c).every(([k, v]) => k === key || v === 0));
  const bestSolo = cand[0];
  solo.push({
    特徵: key, 最佳值: bestSolo.c[key],
    RPS: round(bestSolo.s.rps, 5), 對基準: round(bestSolo.s.rps - b0.rps, 5),
  });
}
console.table(solo);

// ── 驗收:上面挑出來的係數,拿到完全沒參與挑選的賽季上跑一次 ──
console.log(`\n▶ 驗收賽季 ${HOLDOUT.season}(這批資料沒有參與挑係數)`);
const h0 = score(hold, COEF0);
const rowsOut = [];
// 最佳組合常常剛好就等於某個單特徵最佳值 —— 一樣的東西列兩次只會讓人看不懂
const key = c => `${c.bForm}|${c.bGoal}|${c.bH2h}`;
const seen = new Set([key(best.c)]);
const trials = [['最佳組合', best.c]];
for (const s of solo) {
  if (s.最佳值 === 0) continue;
  const c = { ...COEF0, [s.特徵]: s.最佳值 };
  if (seen.has(key(c))) continue;
  seen.add(key(c));
  trials.push([`只開 ${s.特徵}`, c]);
}
for (const [name, c] of trials) {
  const s = score(hold, c);
  const cmp = paired(h0.per, s.per);
  rowsOut.push({
    係數: name, bForm: c.bForm, bGoal: c.bGoal, bH2h: c.bH2h,
    RPS: round(s.rps, 5),
    對基準: round(s.rps - h0.rps, 5),
    '±標準誤': round(cmp.se, 5),
    'bootstrap p': round(cmp.p, 3),
    命中率: `${round(s.hitRate * 100, 1)}%`,
  });
}
console.table([{ 係數: '基準(不調整)', bForm: 0, bGoal: 0, bH2h: 0, RPS: round(h0.rps, 5), 對基準: 0, '±標準誤': null, 'bootstrap p': null, 命中率: `${round(h0.hitRate * 100, 1)}%` }, ...rowsOut]);

const verdict = rowsOut.filter(r => r.對基準 < 0 && Math.abs(r.對基準) > r['±標準誤']);
console.log(verdict.length
  ? `\n判定:有 ${verdict.length} 組在驗收賽季上改善且超過一個標準誤 —— 值得進模型。`
  : '\n判定:驗收賽季上沒有一組的改善超得過雜訊。係數維持 0,只當資訊顯示。');

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'form-tuning.json'), JSON.stringify({
  ranAt: new Date().toISOString(),
  tuneSeason: TUNE.season, holdoutSeason: HOLDOUT.season,
  tuneGames: tune.length, holdoutGames: hold.length,
  residuals: resid,
  tuneBaselineRps: round(b0.rps, 5),
  tuneBest: { coef: best.c, rps: round(best.s.rps, 5) },
  solo,
  holdout: { baselineRps: round(h0.rps, 5), baselineHitRate: round(h0.hitRate, 4), trials: rowsOut },
  accepted: verdict.length > 0 ? verdict[0] : null,
}, null, 2));
console.log('→ 已寫入 data/form-tuning.json');
