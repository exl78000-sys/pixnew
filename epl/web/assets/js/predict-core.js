/* 對戰模擬的預測核心(瀏覽器端)。
 *
 * 這是 scripts/lib/poisson.mjs 的 predict 與 scripts/lib/elo.mjs 的 eloProbs
 * 的逐行移植;參數(meta.model.sim)由 build 從擬合好的模型輸出、未捨入 ——
 * strengthTable 那份是給人看的 3 位數,拿它重算會對不回站上的預測。
 *
 * **等價性由 golden 測試守著**:三個聯賽每一場未賽的 fixtures.json 預測,
 * 這一份在 node 裡重算全部要一致;改了這裡或改了 lib 那邊,CI 都會紅。
 * 所以這裡看起來「重複」的程式其實有一條測試把兩份鎖在一起。
 */
// 與 scripts/lib/util.mjs 的 round 逐字相同 —— toFixed 的捨入在第 4 位會差 1,golden 抓過
const round = (n, d = 2) => {
  const p = 10 ** d;
  return Math.round((Number(n) || 0) * p) / p;
};

// Dixon-Coles 低比分修正(與 lib/poisson.mjs 的 tau 逐字相同)
function tau(x, y, l, m, rho) {
  if (x === 0 && y === 0) return 1 - l * m * rho;
  if (x === 0 && y === 1) return 1 + l * rho;
  if (x === 1 && y === 0) return 1 + m * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

function pmf(l, maxGoals) {
  const out = [];
  let term = Math.exp(-l);
  for (let k = 0; k <= maxGoals; k++) {
    out.push(term);
    term = (term * l) / (k + 1);
  }
  return out;
}

/* Poisson 半邊。neutral = 中立場:把主場優勢從 λ 拿掉 ——
   這是模型自己的參數,不是編出來的旋鈕。 */
export function predictPair(sim, home, away, { neutral = false } = {}) {
  const th = sim.teams[home], ta = sim.teams[away];
  if (!th || !ta) return null;
  const lh = sim.base * th.att * ta.def * (neutral ? 1 : sim.homeAdv);
  const la = sim.base * ta.att * th.def;
  const MG = sim.maxGoals;
  const ph = pmf(lh, MG), pa = pmf(la, MG);
  const grid = [];
  let total = 0;
  for (let x = 0; x <= MG; x++) {
    grid[x] = [];
    for (let y = 0; y <= MG; y++) {
      const p = ph[x] * pa[y] * tau(x, y, lh, la, sim.rho);
      grid[x][y] = Math.max(0, p);
      total += grid[x][y];
    }
  }
  let pHome = 0, pDraw = 0, pAway = 0, over25 = 0, btts = 0, csHome = 0, csAway = 0;
  const scores = [];
  for (let x = 0; x <= MG; x++) {
    for (let y = 0; y <= MG; y++) {
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
    // 抽樣用的完整格(0..maxGoals、未捨入)。golden 不比這一項 —— build 沒輸出它。
    fullGrid: grid,
  };
}

// Elo 半邊(與 lib/elo.mjs 的 eloProbs 同一組常數,由 meta.model.sim.elo 帶進來)
export function eloPair(sim, rh, ra, { neutral = false } = {}) {
  const e = sim.elo;
  const pHomeRaw = 1 / (1 + 10 ** ((ra - (rh + (neutral ? 0 : e.homeAdv))) / 400));
  const draw = e.drawBase - e.drawSlope * Math.abs(pHomeRaw - 0.5);
  const rest = 1 - draw;
  return { home: round(pHomeRaw * rest, 4), draw: round(draw, 4), away: round((1 - pHomeRaw) * rest, 4) };
}

// 兩邊取平均 —— 跟 build 產 fixtures.json 的 blend 同一條算式與捨入
export function blendPair(sim, home, away, eloHome, eloAway, opts = {}) {
  const p = predictPair(sim, home, away, opts);
  if (!p) return null;
  const e = eloPair(sim, eloHome ?? 1500, eloAway ?? 1500, opts);
  return {
    ...p,
    home: round((p.home + e.home) / 2, 4),
    draw: round((p.draw + e.draw) / 2, 4),
    away: round((p.away + e.away) / 2, 4),
    poisson: { home: p.home, draw: p.draw, away: p.away },
    elo: e,
  };
}

/* 從比分分布抽一場比賽。**這是遊戲,不是預測**:比分從模型的真實分布抽,
   進球分鐘均勻抽樣(分鐘分布未建模,畫面要照實講),進球者按該隊球員的
   實際進球佔比抽(sharesOf 給 [{name, w}];沒有就不指名)。
   rng 由呼叫端傳入(帶種子才能重播同一場)。 */
export function sampleMatch(pred, rng, { homeShares = null, awayShares = null } = {}) {
  const g = pred.fullGrid;
  let r = rng(), hs = 0, as = 0;
  outer: for (let x = 0; x < g.length; x++) {
    for (let y = 0; y < g[x].length; y++) {
      r -= g[x][y];
      if (r <= 0) { hs = x; as = y; break outer; }
    }
  }
  const pick = shares => {
    if (!shares?.length) return null;
    const tot = shares.reduce((n, s) => n + s.w, 0);
    if (tot <= 0) return null;
    let v = rng() * tot;
    for (const s of shares) { v -= s.w; if (v <= 0) return s.name; }
    return shares[shares.length - 1].name;
  };
  const events = [];
  for (let i = 0; i < hs; i++) events.push({ side: 'home', min: 1 + Math.floor(rng() * 90), scorer: pick(homeShares) });
  for (let i = 0; i < as; i++) events.push({ side: 'away', min: 1 + Math.floor(rng() * 90), scorer: pick(awayShares) });
  events.sort((a, b) => a.min - b.min);
  return { hs, as, events };
}

// 可重播的種子亂數(mulberry32)—— 種子印在畫面上,同一顆種子重抽同一場
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
