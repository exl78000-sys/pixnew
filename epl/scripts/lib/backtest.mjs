/* 走查回測(walk-forward)。
 *
 * 這一段本來寫死在 test.mjs 的 main() 裡,只服務英超。西甲有兩季完整歷史之後
 * 也該有實測準度,而**複製一份是最糟的做法** —— 兩份會慢慢長歪,
 * 到時候兩個聯賽的數字不能互相比較,而「可比較」正是跑兩個聯賽的意義。
 * 所以抽成一份,英超西甲各呼叫一次,協議完全一樣。
 *
 * 核心規矩(不准為了讓某個聯賽好看而放寬):
 *   1. **只用比賽日之前的資料建模。** 每一輪重新 fit 一次,不准偷看未來。
 *   2. **一定要跟基準線比。** 贏不過固定機率就不要宣稱模型有用。
 *   3. **母體要講清楚。** 上游沒有比分的比賽不算進去,而且要報出來 ——
 *      分母悄悄變小跟編數字是同一件事。
 */
import { round } from './util.mjs';
import { fitPoisson, applyPromotedPrior, predict } from './poisson.mjs';
import { buildElo, eloProbs } from './elo.mjs';

export const outcome = m => (m.fh > m.fa ? 0 : m.fh === m.fa ? 1 : 2);
export const logLoss = (p, o) => -Math.log(Math.max(1e-9, [p.home, p.draw, p.away][o]));

// Ranked Probability Score:足球預測的標準指標,越低越好。
// 用它而不是命中率,是因為「猜錯但接近」跟「猜錯得離譜」不該同分。
export function rps(p, o) {
  const pv = [p.home, p.draw, p.away];
  const ov = [0, 0, 0]; ov[o] = 1;
  let cp = 0, co = 0, s = 0;
  for (let i = 0; i < 2; i++) { cp += pv[i]; co += ov[i]; s += (cp - co) ** 2; }
  return s / 2;
}

/* 模型比基準線好多少,以及**那個差距的標準誤**。
   只報「0.2043 比 0.2241 低」不夠 —— 讀者無從判斷那是穩定的優勢
   還是換一批比賽就會翻掉的波動。逐場配對相減再算標準誤,
   跟 tune-form 驗收特徵用的是同一套(專案鐵則二的精神)。 */
export function pairedDiff(better, worse) {
  const n = better.length;
  if (!n || worse.length !== n) return null;
  const d = better.map((b, i) => worse[i].rps - b.rps);   // 正值代表 better 真的比較好
  const mean = d.reduce((a, x) => a + x, 0) / n;
  const varr = d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(varr / n);
  return { diff: round(mean, 5), se: round(se, 5), ratio: round(mean / se, 2), n };
}

export const metric = rows => ({
  rps: round(rows.reduce((a, r) => a + r.rps, 0) / rows.length, 4),
  logLoss: round(rows.reduce((a, r) => a + r.ll, 0) / rows.length, 4),
  hitRate: round(rows.filter(r => r.hit).length / rows.length, 4),
});

/* 校準:模型說 70% 會贏的比賽,實際是不是真的贏了 70%。
   每場貢獻三個點(主勝/和/客勝各一),這是多類別校準的標準做法。 */
function calibration(perMatch, bins = 10) {
  const pts = [];
  for (const m of perMatch) {
    const real = m.fh > m.fa ? 'home' : m.fh === m.fa ? 'draw' : 'away';
    for (const o of ['home', 'draw', 'away']) pts.push({ p: m.pred[o], hit: real === o ? 1 : 0 });
  }
  const out = [];
  for (let i = 0; i < bins; i++) {
    const lo = i / bins, hi = (i + 1) / bins;
    const inBin = pts.filter(r => r.p >= lo && (i === bins - 1 ? r.p <= hi : r.p < hi));
    out.push({
      lo: round(lo, 2), hi: round(hi, 2), n: inBin.length,
      predicted: inBin.length ? round(inBin.reduce((a, r) => a + r.p, 0) / inBin.length, 4) : null,
      actual: inBin.length ? round(inBin.reduce((a, r) => a + r.hit, 0) / inBin.length, 4) : null,
    });
  }
  return out;
}

// 逐輪表現:模型隨著資料變多有沒有變準
function byRound(perMatch, blend) {
  const g = new Map();
  for (let i = 0; i < perMatch.length; i++) {
    const r = perMatch[i].round;
    if (!g.has(r)) g.set(r, []);
    g.get(r).push(blend[i]);
  }
  return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([r, rows]) => ({
    round: r, games: rows.length,
    rps: round(rows.reduce((a, x) => a + x.rps, 0) / rows.length, 4),
    hitRate: round(rows.filter(x => x.hit).length / rows.length, 3),
  }));
}

// 最意外的比賽:模型給實際結果的機率最低的那幾場
function surprises(perMatch, n = 8) {
  return perMatch.map(m => {
    const real = m.fh > m.fa ? 'home' : m.fh === m.fa ? 'draw' : 'away';
    return { ...m, real, pReal: m.pred[real] };
  }).sort((a, b) => a.pReal - b.pReal).slice(0, n)
    .map(m => ({ date: m.date, round: m.round, home: m.home, away: m.away, fh: m.fh, fa: m.fa,
      real: m.real, pReal: round(m.pReal, 4), pred: m.pred }));
}

/* past      驗收季之前的比賽(訓練起點)
   test      驗收季**已完賽**的比賽
   baseline  這個聯賽的長期主/和/客分佈
   odds      { byMatch } —— 有就多跑一段「模型 vs 市場」,沒有就整段略過
   minBefore 少於這麼多場就不預測那一輪(樣本太小的 fit 不可信) */
export function walkForward({ past, test, baseline, odds = null, minBefore = 100, iters = 1200 }) {
  const codes = [...new Set(test.flatMap(m => [m.home, m.away]))].sort();
  const rounds = [...new Set(test.map(m => m.round))].sort((a, b) => a - b);
  const dc = [], el = [], base = [], blend = [], perMatch = [];
  const mkt = [], blendMkt = [], perMkt = [];
  const srcCount = new Map();
  const skippedRounds = [];

  for (const rd of rounds) {
    const games = test.filter(m => m.round === rd);
    const before = [...past, ...test.filter(m => m.round < rd)];
    if (before.length < minBefore) { skippedRounds.push(rd); continue; }
    const refDate = games[0].date;
    const model = applyPromotedPrior(fitPoisson(before, codes, { refDate, iters }));
    const elo = buildElo(before);
    for (const m of games) {
      const o = outcome(m);
      const p = predict(model, m.home, m.away);
      const e = eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500);
      const b = {
        home: (p.home + e.home) / 2, draw: (p.draw + e.draw) / 2, away: (p.away + e.away) / 2,
      };
      const push = (arr, pr) => arr.push({
        rps: rps(pr, o), ll: logLoss(pr, o),
        hit: [pr.home, pr.draw, pr.away].indexOf(Math.max(pr.home, pr.draw, pr.away)) === o,
      });
      push(dc, p); push(el, e); push(base, baseline); push(blend, b);

      // 有市場賠率的話,把市場機率與模型預測都記進「重疊集」——
      // 必須是同一批比賽,不然拿模型的全季去比市場的半季不公平
      const mk = odds?.byMatch?.get(`${m.home}|${m.away}`);
      if (mk) {
        push(mkt, mk.probs); push(blendMkt, b);
        srcCount.set(mk.source, (srcCount.get(mk.source) ?? 0) + 1);
        perMkt.push({ round: rd, model: rps(b, o), market: rps(mk.probs, o) });
      }

      perMatch.push({
        season: m.season, date: m.date, home: m.home, away: m.away, round: m.round,
        fh: m.fh, fa: m.fa,
        pred: {
          home: round(b.home, 4), draw: round(b.draw, 4), away: round(b.away, 4),
          xgHome: p.xgHome, xgAway: p.xgAway,
          topScores: p.topScores.slice(0, 3),
          over25: p.over25, btts: p.btts,
        },
      });
    }
  }

  const report = {
    games: dc.length,
    models: { poisson: metric(dc), elo: metric(el), blend: metric(blend), baseline: metric(base) },
    chosen: 'blend',
    calibration: calibration(perMatch),
    byRound: byRound(perMatch, blend),
    surprises: surprises(perMatch),
    baselineProbs: baseline,
    // 贏過基準線多少、那個差距穩不穩(差距 ÷ 標準誤)
    vsBaseline: pairedDiff(blend, base),
    vsMarket: mkt.length ? pairedDiff(blendMkt, mkt) : null,
    skippedRounds,
    market: mkt.length ? {
      available: true,
      games: mkt.length,
      source: [...srcCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      model: metric(blendMkt),
      market: metric(mkt),
      byRound: (() => {
        const g = new Map();
        for (const r of perMkt) {
          if (!g.has(r.round)) g.set(r.round, []);
          g.get(r.round).push(r);
        }
        return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([rd, rows]) => ({
          round: rd, games: rows.length,
          modelRps: round(rows.reduce((a, x) => a + x.model, 0) / rows.length, 4),
          marketRps: round(rows.reduce((a, x) => a + x.market, 0) / rows.length, 4),
        }));
      })(),
    } : { available: false },
  };
  return { report, perMatch, rows: { dc, el, base, blend, mkt, blendMkt } };
}
