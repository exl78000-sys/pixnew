import { round, daysBetween } from './util.mjs';

// Dixon-Coles 風格的雙變量 Poisson:
//   λ_主 = exp(μ + att_主 + def_客 + γ)   λ_客 = exp(μ + att_客 + def_主)
//   att 越大 = 進攻越強;def 越大 = 防守越漏;γ = 主場優勢
//   加上時間衰減(近期比賽權重高)與低比分修正 ρ
const MAX_GOALS = 8;

const decay = (matchDate, refDate, xi) => Math.exp(-xi * Math.max(0, daysBetween(matchDate, refDate)));

function tau(x, y, l, m, rho) {
  if (x === 0 && y === 0) return 1 - l * m * rho;
  if (x === 0 && y === 1) return 1 + l * rho;
  if (x === 1 && y === 0) return 1 + m * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/* 擬合目標(2026-09-04):預設用進球 fh/fa。比賽物件帶 tfh/tfa 時,攻守強度改對 tfh/tfa 擬合
   (例如 xG,或 xG 與進球的混合)—— Poisson 的梯度 (y − λ) 對非整數 y 一樣成立。
   ρ(低比分修正)仍用真實進球:tau 的 0/1 判斷只對整數有意義。
   沒帶 tfh 的呼叫端行為一個位元都不變(golden 守著)。 */
export function fitPoisson(matches, codes, { refDate, xi = 0.0035, iters = 3000, lr = 0.06 } = {}) {
  const games = matches.filter(m => m.played && codes.includes(m.home) && codes.includes(m.away))
    .map(m => ({ ...m, w: decay(m.date, refDate, xi), yh: m.tfh ?? m.fh, ya: m.tfa ?? m.fa }));
  const idx = new Map(codes.map((c, i) => [c, i]));
  const n = codes.length;
  const att = new Float64Array(n), def = new Float64Array(n);
  const totalGoals = games.reduce((a, m) => a + (m.yh + m.ya) * m.w, 0);
  const totalW = games.reduce((a, m) => a + m.w, 0) || 1;
  let mu = Math.log(Math.max(0.2, totalGoals / (2 * totalW)));
  let gamma = 0.25;

  const gAtt = new Float64Array(n), gDef = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    gAtt.fill(0); gDef.fill(0);
    let gGamma = 0, gMu = 0;
    for (const m of games) {
      const h = idx.get(m.home), a = idx.get(m.away);
      const lh = Math.exp(mu + att[h] + def[a] + gamma);
      const la = Math.exp(mu + att[a] + def[h]);
      const rh = m.w * (m.yh - lh), ra = m.w * (m.ya - la);
      gAtt[h] += rh; gAtt[a] += ra;
      gDef[a] += rh; gDef[h] += ra;
      gGamma += rh; gMu += rh + ra;
    }
    const step = lr / totalW;
    for (let i = 0; i < n; i++) { att[i] += step * gAtt[i]; def[i] += step * gDef[i]; }
    gamma += step * gGamma; mu += step * gMu;
    // 中心化(att/def 均值歸零,把偏移吸收進 mu,λ 不變)
    let ma = 0, md = 0;
    for (let i = 0; i < n; i++) { ma += att[i]; md += def[i]; }
    ma /= n; md /= n;
    for (let i = 0; i < n; i++) { att[i] -= ma; def[i] -= md; }
    mu += ma + md;
  }

  // 每隊的有效樣本量(用於收縮與判斷升班馬)
  const weight = new Float64Array(n);
  for (const m of games) { weight[idx.get(m.home)] += m.w; weight[idx.get(m.away)] += m.w; }

  const model = { codes, idx, att: [...att], def: [...def], mu, gamma, rho: 0, weight: [...weight], xi, refDate };
  model.rho = fitRho(games, model);
  return model;
}

function fitRho(games, model) {
  let best = 0, bestLL = -Infinity;
  for (let rho = -0.20; rho <= 0.20001; rho += 0.005) {
    let ll = 0;
    for (const m of games) {
      if (m.fh > 1 || m.fa > 1) continue;
      const { lh, la } = lambdas(model, m.home, m.away);
      const t = tau(m.fh, m.fa, lh, la, rho);
      if (t <= 0) { ll = -Infinity; break; }
      ll += m.w * Math.log(t);
    }
    if (ll > bestLL) { bestLL = ll; best = rho; }
  }
  return round(best, 3);
}

export function lambdas(model, home, away) {
  const h = model.idx.get(home), a = model.idx.get(away);
  if (h === undefined || a === undefined) return { lh: 1.4, la: 1.2 };
  return {
    lh: Math.exp(model.mu + model.att[h] + model.def[a] + model.gamma),
    la: Math.exp(model.mu + model.att[a] + model.def[h]),
  };
}

// 沒有近期英超樣本的升班馬:套用「聯盟後段」先驗
export function applyPromotedPrior(model, minWeight = 4) {
  const n = model.codes.length;
  const known = [...Array(n).keys()].filter(i => model.weight[i] >= minWeight);
  const sortedAtt = known.map(i => model.att[i]).sort((x, y) => x - y);
  const sortedDef = known.map(i => model.def[i]).sort((x, y) => x - y);
  const bottomAtt = sortedAtt.slice(0, 3).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(3, sortedAtt.length));
  const topDef = sortedDef.slice(-3).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(3, sortedDef.length));
  const promoted = [];
  for (let i = 0; i < n; i++) {
    if (model.weight[i] >= minWeight) continue;
    model.att[i] = bottomAtt;
    model.def[i] = topDef;
    promoted.push(model.codes[i]);
  }
  model.promoted = promoted;
  return model;
}

/* 只要三路機率的輕量版本。
   回測調參要跑幾萬次,不需要完整比分矩陣與排序,拆出來單獨算比較快。 */
export function outcomeProbs(lh, la, rho) {
  const ph = poissonPmf(lh), pa = poissonPmf(la);
  let h = 0, d = 0, a = 0, total = 0;
  for (let x = 0; x <= MAX_GOALS; x++) {
    for (let y = 0; y <= MAX_GOALS; y++) {
      const p = Math.max(0, ph[x] * pa[y] * tau(x, y, lh, la, rho));
      total += p;
      if (x > y) h += p; else if (x === y) d += p; else a += p;
    }
  }
  return { home: h / total, draw: d / total, away: a / total };
}

// 單場預測:比分機率矩陣 + 各種衍生機率
// lam 給了就用給的 λ(近期狀況調整過的),沒給就用模型原本的。
export function predict(model, home, away, lam) {
  const { lh, la } = lam ?? lambdas(model, home, away);
  const ph = poissonPmf(lh), pa = poissonPmf(la);
  const grid = [];
  let total = 0;
  for (let x = 0; x <= MAX_GOALS; x++) {
    grid[x] = [];
    for (let y = 0; y <= MAX_GOALS; y++) {
      const p = ph[x] * pa[y] * tau(x, y, lh, la, model.rho);
      grid[x][y] = Math.max(0, p);
      total += grid[x][y];
    }
  }
  let pHome = 0, pDraw = 0, pAway = 0, over25 = 0, btts = 0, csHome = 0, csAway = 0;
  const scores = [];
  for (let x = 0; x <= MAX_GOALS; x++) {
    for (let y = 0; y <= MAX_GOALS; y++) {
      const p = grid[x][y] / total;
      grid[x][y] = p;
      if (x > y) pHome += p; else if (x === y) pDraw += p; else pAway += p;
      if (x + y > 2.5) over25 += p;
      if (x > 0 && y > 0) btts += p;
      if (y === 0) csHome += p;
      if (x === 0) csAway += p;
      scores.push({ s: `${x}-${y}`, p });
    }
  }
  scores.sort((a, b) => b.p - a.p);
  return {
    xgHome: round(lh, 2), xgAway: round(la, 2),
    home: round(pHome, 4), draw: round(pDraw, 4), away: round(pAway, 4),
    over25: round(over25, 4), under25: round(1 - over25, 4), btts: round(btts, 4),
    csHome: round(csHome, 4), csAway: round(csAway, 4),
    topScores: scores.slice(0, 6).map(s => ({ ...s, p: round(s.p, 4) })),
    grid: grid.slice(0, 6).map(row => row.slice(0, 6).map(p => round(p, 5))),
  };
}

function poissonPmf(l) {
  const out = [];
  let term = Math.exp(-l);
  for (let k = 0; k <= MAX_GOALS; k++) {
    out.push(term);
    term = (term * l) / (k + 1);
  }
  return out;
}

/* 前端「對戰模擬」用的未捨入參數。strengthTable 那份是給人看的 3 位數,
   exp(μ) 又根本沒輸出 —— 拿那些重算 λ 對不回站上的預測。
   等價性由 golden 測試守著:predict-core.js 重算三個聯賽每一場未賽的預測,
   都要跟 fixtures.json 一致。 */
export function simParams(model) {
  return {
    base: Math.exp(model.mu),
    homeAdv: Math.exp(model.gamma),
    rho: model.rho,
    maxGoals: MAX_GOALS,
    teams: Object.fromEntries(model.codes.map((c, i) => [c,
      { att: Math.exp(model.att[i]), def: Math.exp(model.def[i]) }])),
  };
}

// 球隊強度表(給前端顯示)
export function strengthTable(model) {
  return model.codes.map((c, i) => ({
    code: c,
    attack: round(Math.exp(model.att[i]), 3),   // 1.0 = 聯盟平均
    defence: round(Math.exp(model.def[i]), 3),  // <1 = 防守優於平均
    promoted: (model.promoted || []).includes(c),
  })).sort((a, b) => b.attack / b.defence - a.attack / a.defence);
}
