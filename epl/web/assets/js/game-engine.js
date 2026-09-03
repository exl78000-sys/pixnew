/* 模擬遊玩的比賽引擎 —— 純函式、無 DOM、node 裡測得動(scripts/game/test-game.mjs 會載進來跑)。
 *
 * **這是遊戲模型,不是本站的預測。** 它跟真實管線的關係只有一條:錨。
 *   λ_game = λ_site × (Q_att(現在的 XI) / Q_att(預設 XI))^a × (Q_def(對手現在的 XI) / Q_def(對手預設 XI))^(-b)
 * 預設 XI = 側寫裡 lineups.json 的推估先發,所以**沒有任何改動時 λ_game = λ_site**(測試守著)。
 * 使用者換人、改先發之後才會偏離,而偏離多少由 a、b 決定。
 *
 * 每個係數的來歷(只有兩種:從資料算、或標成遊戲規則並寫理由;沒有第三種):
 *   a      進攻側,`scripts/game/calibrate-xi.mjs` 用 2024-25 的 xGI/90 解釋 2025-26 逐場先發:
 *          點估計 0.75、標準誤 0.47,**跟 0 分不開**,後半季驗證的概似增益 +1.2。
 *          所以它是「有資料方向、但效果量未驗證」的遊戲規則;畫面上照這樣寫。側寫沒有校準檔時退回 0.75 並標未校準。
 *   b      防守側。2024-25 的 FPL 快照沒有逐人防守 per-90,校不了 → 借用 a(遊戲規則)。
 *   紅牌    0.72 / 1.30,跟 predict-core.js 的 inPlaySim 同一組(那是站上實時頁在用的常數),
 *          引擎自己抽進球時用同一組,畫面上的勝率條(inPlaySim)才跟場上的抽樣一致。
 *   分鐘權重 進球 / 射門 / 牌的分鐘分布來自 FotMob 逐場事件(側寫附 n),不是均勻。
 *   射門數  我方射門率 × 對手被射門率 / 聯盟均值(逐場 CSV);其中進球那幾次由 λ 決定,其餘是「不進的射門」。
 *   換人    次數、分鐘、被換下位置全部抽側寫的直方圖;誰上場是同位置替補裡分鐘最多的(遊戲規則)。
 *   牌      每次犯規的黃牌率 = 該隊黃牌/犯規(逐場 CSV);掛誰:在場球員按 (本季+上季黃牌 + 1) 加權 ——
 *          +1 是讓零牌的人也抽得到(遊戲規則)。門將不拿牌(遊戲規則;真實裡很少)。
 *   射手    在場球員按累積 xG 加權;全隊都是 0 時退回角色權重(遊戲規則)。烏龍球按聯賽份額,掛對方後衛。
 *   控球    抽自兩隊主/客控球分布的中點加雜訊(FotMob,側寫附 n)。
 *
 * 決定性:同一顆種子、同一串操作 → 事件流逐字相同。所有隨機走自己的 rng。
 */

export const DEFAULT_RULES = {
  a: 0.75, b: 0.75, aSource: '未校準(預設)',
  RED_OWN: 0.72, RED_OPP: 1.30,          // 與 predict-core inPlaySim 同組
  MAX_SUBS: 5, SUB_WINDOWS: 3, HALF_TIME: 45, FULL: 90,
  CARD_SMOOTH: 1,                         // 黃牌權重的 +1
  ROLE_GOAL_WEIGHT: { ST: 4, W: 2.5, AM: 2.5, CM: 1.2, DM: 0.6, FB: 0.5, CB: 0.5, GK: 0 },   // 沒有 xG 資料時的退路
};

// mulberry32 —— 跟 predict-core 的 seededRng 同一個演算法。不 import 是為了讓這個檔在 node 裡零依賴載入。
export function rngOf(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const poisson = (rng, l) => { if (l <= 0) return 0; const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rng(); } while (p > L); return k - 1; };
const gauss = rng => { const u = Math.max(1e-12, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const pickWeighted = (rng, items, w) => {
  const ws = items.map(w); const tot = ws.reduce((a, b) => a + b, 0);
  if (!(tot > 0)) return items.length ? items[Math.floor(rng() * items.length)] : null;
  let r = rng() * tot;
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
};
const pickHist = (rng, hist) => pickWeighted(rng, Object.keys(hist).map(Number), k => hist[k]);
const band = pos => ({ GK: 'GK', DEF: 'DEF', MID: 'MID', FWD: 'FWD' }[pos] ?? 'MID');
const r2 = n => Math.round(n * 100) / 100;

/* 直方圖(桶寬 5)→ 每分鐘權重,Σ = 1。桶 90 整個給第 90 分鐘(90+ 補時全算那一分鐘)。 */
function minuteWeights(hist5, full = 90) {
  const w = new Array(full + 1).fill(0);
  let n = 0;
  for (const [b, c] of Object.entries(hist5 ?? {})) { n += c; }
  if (!n) { for (let m = 1; m <= full; m++) w[m] = 1 / full; return w; }
  for (const [b, c] of Object.entries(hist5)) {
    const start = Number(b);
    if (start >= full) { w[full] += c / n; continue; }
    for (let m = Math.max(1, start); m < Math.min(full, start + 5); m++) w[m] += c / n / 5;
    if (start === 0) w[1] += c / n / 5;   // 桶 0 的第 0 分鐘沒有人踢,併給第 1 分鐘
  }
  return w;
}

/* 角色中位數:能力值是 null 的人(兩季都不到 450 分鐘)用同角色的中位數,並標 lowSample。 */
function roleMedians(profile, field) {
  const by = {};
  for (const t of Object.values(profile.teams)) for (const p of t.squad) {
    const v = p.ability?.[field];
    if (v == null || !p.role) continue;
    (by[p.role] ??= []).push(v);
  }
  const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, med(v)]));
}

export function defaultSetup(profile, code) {
  const t = profile.teams[code];
  return { xi: [...t.xi], bench: [...t.bench], formation: t.formation.latest ?? t.formation.predicted ?? t.formation.options[0] ?? '4-4-2', subs: null };
}

export function createMatch({ profile, home, away, pred, seed = 1, setup = {}, rules = {} }) {
  const R = { ...DEFAULT_RULES, ...rules };
  if (profile.calibration?.a != null && rules.a == null) { R.a = profile.calibration.a; R.b = profile.calibration.a; R.aSource = `校準點估計(±${profile.calibration.se},${profile.calibration.significant ? '顯著' : '跟 0 分不開'})`; }
  const rng = rngOf(seed);
  const L = profile.league_;
  const medAtt = roleMedians(profile, 'att'), medDef = roleMedians(profile, 'def');
  const attOf = p => (p.ability?.att ?? medAtt[p.role] ?? 0);
  const defOf = p => (p.ability?.def ?? medDef[p.role] ?? 0);
  const wGoal = minuteWeights(L.goalMinutes?.hist5), wShot = minuteWeights(L.shotMinutes?.hist5), wCard = minuteWeights(L.cardMinutes?.hist5);

  function mkSide(side, code, cfg) {
    const t = profile.teams[code];
    const d = defaultSetup(profile, code);
    const squad = new Map(t.squad.map(p => [p.code, p]));
    const xi = (cfg?.xi?.length === 11 ? cfg.xi : d.xi).filter(c => squad.has(c));
    const bench = (cfg?.bench ?? d.bench).filter(c => squad.has(c) && !xi.includes(c));
    const venue = side === 'home' ? 'home' : 'away';
    const rates = t.rates[venue] ?? t.rates.home ?? {};
    return {
      side, code, t, squad, venue,
      formation: cfg?.formation ?? d.formation,
      defaultXi: d.xi, onPitch: [...xi], bench: [...bench], off: [], sentOff: [], cameOn: new Set(),
      subsUsed: 0, windows: new Set(), yellows: new Map(), red: 0,
      rates, plan: cfg?.subs ? cfg.subs.map(s => ({ ...s, user: true })) : null,
      stats: { shots: 0, on: 0, off: 0, blocked: 0, corners: 0, fouls: 0, yellow: 0, red: 0, xg: 0, goals: 0 },
    };
  }
  const H = mkSide('home', home, setup.home), A = mkSide('away', away, setup.away);
  const opp = s => (s === H ? A : H);
  const outfield = s => s.onPitch.filter(c => s.squad.get(c).pos !== 'GK');
  const qAtt = (s, codes) => codes.filter(c => s.squad.get(c).pos !== 'GK').reduce((a, c) => a + attOf(s.squad.get(c)), 0);
  const qDef = (s, codes) => codes.filter(c => s.squad.get(c).pos !== 'GK').reduce((a, c) => a + defOf(s.squad.get(c)), 0);
  /* Q 用「在場 + 被罰下的人」算 —— 紅牌少一人的效果由 RED 常數給,Q 再少一個人就重複算了。 */
  const qSet = s => [...s.onPitch, ...s.sentOff];
  const ratioAtt = s => { const d = qAtt(s, s.defaultXi); return d > 0 ? qAtt(s, qSet(s)) / d : 1; };
  const ratioDef = s => { const d = qDef(s, s.defaultXi); return d > 0 ? qDef(s, qSet(s)) / d : 1; };
  /* λ_game(不含紅牌)。紅牌由 redFactor 另外乘 —— 畫面上的 inPlaySim 自己會乘,傳給它的是這個。 */
  const lambda = s => (s === H ? pred.xgHome : pred.xgAway) * ratioAtt(s) ** R.a * ratioDef(opp(s)) ** (-R.b);
  const redFactor = s => R.RED_OWN ** s.red * R.RED_OPP ** opp(s).red;

  // 賽前抽的東西:控球目標、自動換人計畫
  const possTarget = (() => {
    const ph = H.t.possession.home, pa = A.t.possession.away;
    if (ph?.mean == null || pa?.mean == null) return null;
    const mean = (ph.mean + (100 - pa.mean)) / 2;
    const sdv = Math.sqrt(((ph.sd ?? 8) ** 2 + (pa.sd ?? 8) ** 2) / 4);
    return Math.max(20, Math.min(80, Math.round(mean + gauss(rng) * sdv)));
  })();
  function autoPlan(s) {
    const n = pickHist(rng, L.subs?.countHist ?? { 3: 1 }) ?? 3;
    const mins = [];
    for (let i = 0; i < n; i++) {
      const b = pickHist(rng, Object.fromEntries(Object.entries(L.subs?.minuteHist5 ?? { 60: 1 }).filter(([k]) => Number(k) >= 45)));
      mins.push(Math.min(R.FULL, b + Math.floor(rng() * 5)));
    }
    mins.sort((a, b) => a - b);
    /* 三個窗口(中場不算):不同的分鐘超過 3 個就把最近的兩個併到前面那個 */
    const distinct = () => [...new Set(mins.filter(m => m !== R.HALF_TIME))];
    while (distinct().length > R.SUB_WINDOWS) {
      const d = distinct();
      let bi = 0, bd = Infinity;
      for (let i = 0; i + 1 < d.length; i++) if (d[i + 1] - d[i] < bd) { bd = d[i + 1] - d[i]; bi = i; }
      for (let i = 0; i < mins.length; i++) if (mins[i] === d[bi + 1]) mins[i] = d[bi];
    }
    return mins.map(min => ({ min, band: pickHist(rng, L.subs?.offPos ?? { MID: 1 }) ?? 'MID', user: false }));
  }
  for (const s of [H, A]) if (!s.plan) s.plan = autoPlan(s);

  const st = { min: 0, half: 1, score: [0, 0], finished: false, events: [] };
  const push = e => { st.events.push(e); return e; };
  const nameOf = (s, c) => s.squad.get(c)?.name ?? c;
  const pushEv = (s, e) => push({ min: st.min, side: s.side, team: s.code, ...e });

  function scorerOf(s) {
    const cands = outfield(s);
    const totalXg = cands.reduce((a, c) => a + (s.squad.get(c).xg ?? 0), 0);
    return pickWeighted(rng, cands, c => (totalXg > 0 ? (s.squad.get(c).xg ?? 0) : (R.ROLE_GOAL_WEIGHT[s.squad.get(c).role] ?? 1)));
  }
  function assistOf(s, scorer) {
    const share = s.t.assistShare ?? 0.7;
    if (rng() > share) return null;
    const cands = outfield(s).filter(c => c !== scorer);
    return pickWeighted(rng, cands, c => (s.squad.get(c).xa ?? 0) + 0.05);
  }
  const sitOf = (s, goal) => {
    const src = s.t.shotSituations ?? L.shotSituations ?? {};
    const keys = Object.keys(src);
    if (!keys.length) return 'RegularPlay';
    return pickWeighted(rng, keys, k => (goal ? src[k].goals : src[k].shots)) ?? 'RegularPlay';
  };
  const xgOf = (s, sit) => (s.t.shotSituations?.[sit]?.xgPerShot ?? L.shotSituations?.[sit]?.xgPerShot ?? 0.1);
  const takerOf = (s, list) => {
    for (const x of list ?? []) { const c = s.onPitch.find(cc => s.squad.get(cc).name === x.name); if (c) return c; }
    return null;
  };

  function goal(s) {
    const ownGoal = rng() < (L.ownGoalShare ?? 0);
    const sit = ownGoal ? 'OwnGoal' : sitOf(s, true);
    const o = opp(s);
    let scorer = null, assist = null, taker = null;
    if (ownGoal) { const defs = outfield(o).filter(c => o.squad.get(c).pos === 'DEF'); scorer = pickWeighted(rng, defs.length ? defs : outfield(o), () => 1); }
    else if (sit === 'Penalty') { scorer = takerOf(s, s.t.takers?.pen) ?? scorerOf(s); }
    else { scorer = scorerOf(s); assist = assistOf(s, scorer); }
    if (sit === 'FromCorner') taker = takerOf(s, s.t.takers?.corner);
    if (sit === 'FreeKick' || sit === 'SetPiece') taker = takerOf(s, s.t.takers?.fk);
    s.stats.shots++; s.stats.on++; s.stats.goals++; s.stats.xg = r2(s.stats.xg + (ownGoal ? 0 : xgOf(s, sit)));
    st.score[s === H ? 0 : 1]++;
    return pushEv(s, { type: 'goal', situation: sit, ownGoal, scorer, scorerName: ownGoal ? nameOf(o, scorer) : nameOf(s, scorer),
      assist, assistName: assist ? nameOf(s, assist) : null, taker, takerName: taker ? nameOf(s, taker) : null,
      score: [...st.score], xg: ownGoal ? 0 : xgOf(s, sit) });
  }
  function shot(s) {
    const sit = sitOf(s, false);
    const src = s.t.shotSituations?.[sit] ?? L.shotSituations?.[sit] ?? { onTargetPct: 0.35, goalPerShot: 0.1 };
    const pOn = Math.max(0, (src.onTargetPct - src.goalPerShot) / Math.max(0.01, 1 - src.goalPerShot));
    const r = rng();
    const outcome = r < pOn ? 'saved' : r < pOn + (L.blockedShare ?? 0.25) ? 'blocked' : (rng() < 0.08 ? 'post' : 'off');
    const taker = sit === 'Penalty' ? (takerOf(s, s.t.takers?.pen) ?? scorerOf(s)) : pickWeighted(rng, outfield(s), c => attOf(s.squad.get(c)) + 0.02);
    s.stats.shots++; s.stats[outcome === 'saved' ? 'on' : outcome === 'blocked' ? 'blocked' : 'off']++;
    s.stats.xg = r2(s.stats.xg + xgOf(s, sit));
    return pushEv(s, { type: 'shot', situation: sit, outcome, player: taker, playerName: nameOf(s, taker), xg: xgOf(s, sit) });
  }
  function corner(s) {
    const taker = takerOf(s, s.t.takers?.corner) ?? pickWeighted(rng, outfield(s), c => (s.squad.get(c).ability?.cre ?? 5) + 1);
    s.stats.corners++;
    return pushEv(s, { type: 'corner', player: taker, playerName: nameOf(s, taker) });
  }
  function card(s, code, kind) {
    if (kind === 'yellow') {
      const n = (s.yellows.get(code) ?? 0) + 1; s.yellows.set(code, n); s.stats.yellow++;
      pushEv(s, { type: 'card', card: 'yellow', second: n === 2, player: code, playerName: nameOf(s, code) });
      if (n === 2) return card(s, code, 'red');
      return;
    }
    s.onPitch = s.onPitch.filter(c => c !== code); s.sentOff.push(code); s.red++; s.stats.red++;
    pushEv(s, { type: 'card', card: 'red', player: code, playerName: nameOf(s, code), players: s.onPitch.length });
  }
  function foul(s) {
    s.stats.fouls++;
    const who = pickWeighted(rng, outfield(s), c => (s.squad.get(c).yellow ?? 0) + R.CARD_SMOOTH);
    pushEv(s, { type: 'foul', player: who, playerName: nameOf(s, who) });
    const fouls = s.rates.fouls || 11, pY = (s.rates.yellow ?? L.rates.yellow) / fouls, pR = (s.rates.red ?? L.rates.red) / fouls;
    const r = rng();
    if (r < pR) card(s, who, 'red');
    else if (r < pR + pY) card(s, who, 'yellow');
  }
  function doSub(s, offCode, onCode, user) {
    const o = s.squad.get(offCode), n = s.squad.get(onCode);
    s.onPitch = s.onPitch.map(c => (c === offCode ? onCode : c));
    s.bench = s.bench.filter(c => c !== onCode); s.off.push(offCode); s.cameOn.add(onCode); s.subsUsed++;
    if (st.min !== R.HALF_TIME) s.windows.add(st.min);
    return pushEv(s, { type: 'sub', off: offCode, offName: o?.name ?? offCode, on: onCode, onName: n?.name ?? onCode, user, subsUsed: s.subsUsed });
  }
  function canSub(s, offCode, onCode) {
    if (st.finished) return '比賽已結束';
    if (s.subsUsed >= R.MAX_SUBS) return `已用完 ${R.MAX_SUBS} 個換人名額`;
    if (!s.onPitch.includes(offCode)) return '要換下的人不在場上';
    if (!s.bench.includes(onCode)) return '要換上的人不在替補席';
    if (st.min !== R.HALF_TIME && !s.windows.has(st.min) && s.windows.size >= R.SUB_WINDOWS) return `已用完 ${R.SUB_WINDOWS} 個換人窗口(中場不算)`;
    return null;
  }
  function runPlan(s) {
    for (const p of s.plan) {
      if (p.done || p.min !== st.min) continue;
      p.done = true;
      let offCode = p.off, onCode = p.on;
      if (!offCode) {
        /* 剛換上來的人不再被自動換下 —— 同一分鐘兩個換人時,第二個會從「現在的場上」挑,
           不排除的話會挑到第一個剛上場的(實測 300 場裡有);規則上合法,但沒有教練會這樣做。 */
        const fresh = outfield(s).filter(c => !s.cameOn.has(c));
        const cands = fresh.filter(c => band(s.squad.get(c).pos) === p.band && !s.yellows.has(c));
        const pool = cands.length ? cands : (fresh.length ? fresh : outfield(s));
        offCode = pickWeighted(rng, pool, () => 1);
      }
      if (!onCode) {
        const pos = s.squad.get(offCode)?.pos;
        const same = s.bench.filter(c => s.squad.get(c).pos === pos);
        const pool = (same.length ? same : s.bench.filter(c => s.squad.get(c).pos !== 'GK'));
        onCode = pool.sort((a, b) => (s.squad.get(b).minutes.current + s.squad.get(b).minutes.last) - (s.squad.get(a).minutes.current + s.squad.get(a).minutes.last))[0];
      }
      if (offCode && onCode && !canSub(s, offCode, onCode)) doSub(s, offCode, onCode, p.user === true);
    }
  }
  /* 「不進的射門」期望值:射門率(我方 × 對手被射門 / 聯盟均)減掉 λ 那幾次。 */
  const shotsExpected = s => Math.max(0, ((s.rates.sf ?? L.rates.sf) * ((opp(s).rates.sa ?? L.rates.sf) / L.rates.sf)));
  const cornersExpected = s => (s.rates.cf ?? L.rates.cf) * ((opp(s).rates.ca ?? L.rates.cf) / L.rates.cf);
  const foulsExpected = s => ((s.rates.fouls ?? L.rates.fouls) + (opp(s).rates.foulsAgainst ?? L.rates.fouls)) / 2;

  function tick() {
    if (st.finished) return [];
    const before = st.events.length;
    st.min++;
    if (st.min === 1) push({ min: 0, type: 'kickoff', side: 'home', team: H.code });
    if (st.min === R.HALF_TIME + 1) { st.half = 2; push({ min: R.HALF_TIME, type: 'half', score: [...st.score] }); }
    for (const s of [H, A]) runPlan(s);
    for (const s of [H, A]) {
      const lam = lambda(s) * redFactor(s);
      const g = poisson(rng, lam * wGoal[st.min]);
      for (let i = 0; i < g; i++) goal(s);
      const sh = poisson(rng, Math.max(0, shotsExpected(s) - lam) * wShot[st.min]);
      for (let i = 0; i < sh; i++) shot(s);
      const c = poisson(rng, cornersExpected(s) / R.FULL);
      for (let i = 0; i < c; i++) corner(s);
      const f = poisson(rng, foulsExpected(s) * wCard[st.min]);
      for (let i = 0; i < f; i++) foul(s);
    }
    if (st.min >= R.FULL) { st.finished = true; push({ min: R.FULL, type: 'full', score: [...st.score] }); }
    return st.events.slice(before);
  }

  const sideState = s => ({
    code: s.code, formation: s.formation, onPitch: [...s.onPitch], bench: [...s.bench], off: [...s.off], sentOff: [...s.sentOff],
    subsUsed: s.subsUsed, windowsUsed: s.windows.size, red: s.red, stats: { ...s.stats },
    ratioAtt: r2(ratioAtt(s)), ratioDef: r2(ratioDef(s)), lambda: r2(lambda(s)), lambdaEff: r2(lambda(s) * redFactor(s)),
    yellows: [...s.yellows.entries()].map(([c, n]) => ({ player: c, n })),
    plan: s.plan.map(p => ({ min: p.min, band: p.band ?? null, off: p.off ?? null, on: p.on ?? null, done: p.done === true, user: p.user === true })),
  });

  return {
    rules: R, possTarget,
    state: () => ({ min: st.min, half: st.half, score: [...st.score], finished: st.finished, possTarget, home: sideState(H), away: sideState(A) }),
    events: () => [...st.events],
    tick,
    lambdas: () => ({ home: lambda(H), away: lambda(A), redHome: H.red, redAway: A.red }),
    canSub: (side, offCode, onCode) => canSub(side === 'home' ? H : A, offCode, onCode),
    substitute(side, offCode, onCode) {
      const s = side === 'home' ? H : A;
      const err = canSub(s, offCode, onCode);
      if (err) return { ok: false, error: err };
      return { ok: true, event: doSub(s, offCode, onCode, true) };
    },
    setFormation(side, label) { (side === 'home' ? H : A).formation = label; },
    playerOf: (side, code) => (side === 'home' ? H : A).squad.get(code) ?? null,
  };
}
