/* 模擬遊玩的比賽引擎 —— 純函式、無 DOM、node 裡測得動(scripts/game/test-game.mjs 會載進來跑)。
 *
 * **這是遊戲模型,不是本站的預測。** 它跟真實管線的關係只有一條:錨。
 *   λ_game = λ_site × (Q_att(現在的 XI) / Q_att(預設 XI))^a × (Q_def(對手現在的 XI) / Q_def(對手預設 XI))^(-b)
 * 預設 XI = 側寫裡 lineups.json 的推估先發,所以**沒有任何改動時 λ_game = λ_site**(測試守著)。
 * 使用者換人、改先發之後才會偏離,而偏離多少由 a、b 決定。
 *
 * ── 2026-09-15 改成回合制(使用者用問答定的) ──────────────────────────────
 * 舊版每個比賽分鐘各自獨立抽進球 / 射門 / 角球 / 犯規,事件之間沒有因果,畫面演不出來
 * (角球不會接射門、犯規不會變任意球、丟球不會變反擊),而且一分鐘的事件在同一秒全部落地,
 * 畫面只能事後排隊追 —— 使用者回報「球場動態跟事件不一樣」就是這個。
 *
 * 現在比賽是**一個接一個的控球回合**(`nextSequence()`):每個回合有起點(開球 / 球門球 / 界外球 /
 * 任意球 / 角球 / 十二碼 / 門將發球 / 斷球反擊 / 二點球)、一串傳球的人、和一個結局
 * (射門 / 贏得角球 / 被犯規 / 越位 / 出界 / 被斷球)。結局決定下一個回合怎麼開始,
 * 所以角球接著射門、犯規接著任意球、斷球接著反擊 —— 畫面照回合的劇本演,事件在畫面上發生時才算數。
 *
 * 每個係數的來歷(只有兩種:從資料算、或標成遊戲規則並寫理由;沒有第三種):
 *   a      進攻側,`scripts/game/calibrate-xi.mjs` 用 2024-25 的 xGI/90 解釋 2025-26 逐場先發:
 *          點估計 0.75、標準誤 0.47,**跟 0 分不開**,後半季驗證的概似增益 +1.2。
 *          所以它是「有資料方向、但效果量未驗證」的遊戲規則;畫面上照這樣寫。側寫沒有校準檔時退回 0.75 並標未校準。
 *   b      防守側。2024-25 的 FPL 快照沒有逐人防守 per-90,校不了 → 借用 a(遊戲規則)。
 *   紅牌    0.72 / 1.30,跟 predict-core.js 的 inPlaySim 同一組(那是站上實時頁在用的常數)。
 *   射門    每次射門**抽一筆該隊的真實射門**(FotMob 射門池:座標、xG、情境、射手);進球機率 = 那一筆的 xG × k,
 *          k = λ_game / (每場射門數 × 射門池平均 xG) —— 這就是錨:期望進球 = λ_game(數學上精確,測試守 3 個標準誤)。
 *          射門數 = 我方射門率 × 對手被射門率 / 聯盟均值(逐場 CSV);分鐘分布抽 FotMob 逐射門的分鐘直方圖。
 *   回合數  每隊每場 SEQ_PER_TEAM 個回合(遊戲規則;Opta 公開的英超統計約 90~110)。
 *          回合長度 = 球在場上的時間 × 控球目標 / 回合數 —— 控球率由此變成畫面上的時間,不是一個數字。
 *   球在場上 BIP_SEC = 57 分(遊戲規則;英超公開的 ball-in-play 平均約 55~58 分)。停球秒數 DEAD 是遊戲規則,
 *          補時 = 每半場 1 分鐘 + 該半場進球 / 換人 / 牌 / 十二碼耗掉的停球時間(IFAB 的補時原則)。
 *   角球    我方角球率 × 對手被角球率 / 聯盟均(逐場 CSV);角球接射門的機率 = 該隊角球射門份額 × 射門數 ÷ 角球數(FotMob)。
 *   犯規    對手的犯規率(逐場 CSV);十二碼 = 該隊十二碼射門份額 × 射門數 ÷ 被犯規數(FotMob);
 *          前場任意球接射門 = 任意球 + 定位球份額 × 射門數 ÷ (被犯規數 × FOUL_ATT_THIRD)。FOUL_ATT_THIRD 是遊戲規則。
 *   越位    該隊每場越位數(FotMob 逐場球隊統計)。
 *   牌      每次犯規的黃牌率 = 該隊黃牌/犯規(逐場 CSV);掛誰:在場球員按 (本季+上季黃牌 + 1) 加權。門將不拿牌(遊戲規則)。
 *   傳球串  長度抽 Poisson(該隊每場傳球數 ÷ 回合數,FotMob);誰傳給誰按角色的推進權重(演出,不是資料)。
 *   換人    次數、分鐘、被換下位置全部抽側寫的直方圖;在停球時執行。
 *   出界    沒有結局的回合裡 35% 出界(界外球 85% / 球門球 15%,界外球一半留給攻方)—— 遊戲規則,沒有逐場界外球資料。
 *
 * 決定性:同一顆種子、同一串操作 → 事件流與回合逐字相同。所有隨機走自己的 rng。
 */

export const DEFAULT_RULES = {
  a: 0.75, b: 0.75, aSource: '未校準(預設)',
  RED_OWN: 0.72, RED_OPP: 1.30,          // 與 predict-core inPlaySim 同組
  MAX_SUBS: 5, SUB_WINDOWS: 3, HALF_TIME: 45, FULL: 90,
  CARD_SMOOTH: 1,                         // 黃牌權重的 +1
  ROLE_GOAL_WEIGHT: { ST: 4, W: 2.5, AM: 2.5, CM: 1.2, DM: 0.6, FB: 0.5, CB: 0.5, GK: 0 },   // 沒有射門池資料時的退路
  // ── 回合制(2026-09-15)──
  SEQ_PER_TEAM: 100,                      // 每隊每場的控球回合數(遊戲規則,見檔頭)
  BIP_SEC: 57 * 60,                       // 球在場上的秒數(遊戲規則,見檔頭)
  /* 停球秒數(遊戲規則)。goal / penalty / 換人 / 牌 是「裁判會補回來」的那一類(進補時);
     其餘(球門球、界外球、任意球、角球、越位、門將發球)是**補不回來**的,而球在場上的時間 = 比賽長度 − 停球。
     所以後者的數字只是相對權重:開賽時依兩隊的事件率算出期望停球,整組縮放到讓球在場上 = BIP_SEC
     (deadScale)。不縮放的話回合數會隨停球的多寡漂,射門數就跟著漂,錨就不準(實測 120 回合、射門多 34%)。 */
  DEAD: { kickoff: 0, goalkick: 20, throwin: 10, freekick: 22, corner: 26, goal: 50, offside: 14, penalty: 35, keeper: 4, loose: 0, turnover: 0 },
  DEAD_SUB: 18, DEAD_CARD: 12,            // 換人 / 拿牌各多耗的停球秒數(補時會加回來)
  ADDED_BASE: 45,                         // 每半場基本補時(秒);加上補回來的停球,一場約 6~7 分補時
  STOPPAGE_MINUTES: 6,                    // 射門分鐘直方圖的 90 那一桶涵蓋整段補時,拿來當每分鐘權重時要除以補時長度(遊戲規則)
  FOUL_ATT_THIRD: 0.30,                   // 被犯規的位置在前場三分之一的比例(遊戲規則)
  OUT_SHARE: 0.35, THROWIN_SHARE: 0.85, THROWIN_KEEP: 0.5,   // 沒有結局的回合:出界的比例、其中界外球的比例、界外球留給攻方的比例
  BLOCK_KEEP: 0.5, POST_KEEP: 0.5,        // 被封阻 / 中柱之後攻方撿回二點球的比例
  CORNER_KEEP: 0.35, FK_KEEP: 0.4,        // 角球 / 任意球沒射門時攻方留住球的比例
  SEQ_DUR_JITTER: 0.5,                    // 回合長度 = 均值 × (1 ± 0.5) 均勻
  MAX_CHAIN: 9,                           // 一個回合最多幾個人碰球(畫面演得完)
  /* ── 戰術指令(2026-09-15,階段 B;使用者定的:只改踢法,不改進球機率)──
     六項指令各 1~5 級,預設 = 側寫從本季真資料推的那一級(style.*.level);Δ = 現在的級 − 預設級。
     每一級改多少是遊戲規則(沒有資料能校準「把壓迫調高一級會多幾次犯規」),所以數字都小、而且畫面上寫明是規則。
     **λ 不動**:射門數變了,k = λ ÷ (射門數 × 平均 xG) 跟著重算,期望進球仍然精確等於 λ(測試守著)。 */
  TAC: { mentalityShots: 0.08, mentalityOppShots: 0.05, widthCorners: 0.06, pressingFouls: 0.06, lineOffsides: 0.10,
    directOffsides: 0.05, directPasses: 0.08, tempoPasses: 0.05, pressingTurnoverX: 5 },
};
export const TACTIC_KEYS = ['mentality', 'pressing', 'line', 'width', 'tempo', 'directness'];

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
const r1 = n => Math.round(n * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* 直方圖(桶寬 5)→ 每分鐘權重,Σ = 1。桶 90 整個給第 90 分鐘(90+ 補時全算那一分鐘)。 */
function minuteWeights(hist5, full = 90) {
  const w = new Array(full + 1).fill(0);
  let n = 0;
  for (const [, c] of Object.entries(hist5 ?? {})) { n += c; }
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

/* 引擎秒數 → 顯示分鐘(足球寫法:45+2、90+5)。上半場 0 → 2700+補時,下半場從 2700 起算。
   抽成純函式是因為畫面當主時鐘(2026-09-15):前端把演出的進度換算成引擎秒數之後,要用**同一條規則**印分鐘,
   自己再寫一份的話 45+ 與 90+ 的邊界會跟事件流裡的分鐘對不上。 */
export function minuteAt(sec, half, R = DEFAULT_RULES) {
  const cap = half === 1 ? R.HALF_TIME : R.FULL;
  const raw = Math.floor(sec / 60) + 1;
  return { min: Math.min(cap, raw), extra: raw > cap ? raw - cap : null };
}

export function defaultSetup(profile, code) {
  const t = profile.teams[code];
  return { xi: [...t.xi], bench: [...t.bench], formation: t.formation.latest ?? t.formation.predicted ?? t.formation.options[0] ?? '4-4-2', subs: null };
}

/* 射門池的情境分組:開放式進攻(含快攻、個人突破、界外球後的進攻)、角球、任意球 / 定位球、十二碼。
   引擎照回合的種類從對應的那一組抽真實射門。 */
const SIT_GROUP = { RegularPlay: 'open', FastBreak: 'open', IndividualPlay: 'open', ThrowInSetPiece: 'open',
  FromCorner: 'corner', FreeKick: 'fk', SetPiece: 'fk', Penalty: 'pen' };

/* 傳球串的推進權重(演出,不是資料):回合前段在後場與中場之間轉,後段往前場的人送。 */
const CHAIN_W = {
  early: { GK: 0.3, CB: 3, FB: 3, DM: 2, CM: 1.5, AM: 0.5, W: 0.8, ST: 0.3 },
  mid: { GK: 0, CB: 1, FB: 2, DM: 2, CM: 3, AM: 2, W: 2, ST: 1 },
  late: { GK: 0, CB: 0.2, FB: 1, DM: 0.5, CM: 1.5, AM: 3, W: 3, ST: 2.5 },
};
const OFFSIDE_W = { ST: 5, W: 3, AM: 1.5, CM: 0.5, FB: 0.5, DM: 0.1, CB: 0.1, GK: 0 };

export function createMatch({ profile, home, away, pred, seed = 1, setup = {}, rules = {} }) {
  const R = { ...DEFAULT_RULES, ...rules };
  if (profile.calibration?.a != null && rules.a == null) { R.a = profile.calibration.a; R.b = profile.calibration.a; R.aSource = `校準點估計(±${profile.calibration.se},${profile.calibration.significant ? '顯著' : '跟 0 分不開'})`; }
  const rng = rngOf(seed);
  const L = profile.league_;
  const medAtt = roleMedians(profile, 'att'), medDef = roleMedians(profile, 'def');
  const attOf = p => (p.ability?.att ?? medAtt[p.role] ?? 0);
  const defOf = p => (p.ability?.def ?? medDef[p.role] ?? 0);
  const wGoal = minuteWeights(L.goalMinutes?.hist5), wShot = minuteWeights(L.shotMinutes?.hist5), wCard = minuteWeights(L.cardMinutes?.hist5);
  /* 直方圖的 90 那一桶是整段補時(約 6 分鐘)的總和,minuteWeights 把它全放在第 90 分 ——
     回合制的時鐘真的會在 90+ 跑好幾分鐘,每一分鐘都拿整桶的權重就多算 6 倍。 */
  const wAt = (w, m) => (m >= R.FULL ? w[R.FULL] / R.STOPPAGE_MINUTES : w[m]);

  /* 射門池(側寫 `shots`):按情境分組,每組是 [x, y, xG, 情境, 結果, 射手] 的列。某組一筆都沒有的隊退回聯賽池。 */
  function poolOf(t) {
    const src = t.shots?.rows?.length ? t.shots : (L.shotPool ?? { rows: [], sits: [], outs: [], players: [] });
    const groups = { open: [], corner: [], fk: [], pen: [] };
    for (const row of src.rows) (groups[SIT_GROUP[src.sits[row[3]]] ?? 'open']).push(row);
    const fb = L.shotPool ?? src;
    const fbGroups = { open: [], corner: [], fk: [], pen: [] };
    for (const row of fb.rows) (fbGroups[SIT_GROUP[fb.sits[row[3]]] ?? 'open']).push(row);
    const meanXg = src.rows.length ? src.rows.reduce((a, r) => a + r[2], 0) / src.rows.length : 0.1;
    // 逐人射門數(給「抽到的射手不在場上」時退回用)
    const shotCount = new Map();
    for (const row of src.rows) if (row[5] >= 0) shotCount.set(src.players[row[5]], (shotCount.get(src.players[row[5]]) ?? 0) + 1);
    return { src, groups, fbGroups, fb, meanXg, shotCount };
  }

  function mkSide(side, code, cfg) {
    const t = profile.teams[code];
    const d = defaultSetup(profile, code);
    const squad = new Map(t.squad.map(p => [p.code, p]));
    const xi = (cfg?.xi?.length === 11 ? cfg.xi : d.xi).filter(c => squad.has(c));
    const bench = (cfg?.bench ?? d.bench).filter(c => squad.has(c) && !xi.includes(c));
    const venue = side === 'home' ? 'home' : 'away';
    const rates = t.rates[venue] ?? t.rates.home ?? {};
    const play = t.play?.[venue] ?? t.play?.home ?? null;
    /* 戰術指令:預設 = 側寫推的那一級(沒有側寫就 3);使用者給的只收 1~5 的整數 */
    const defaults = Object.fromEntries(TACTIC_KEYS.map(k => [k, t.style?.[k]?.level ?? 3]));
    const tactics = { ...defaults };
    for (const k of TACTIC_KEYS) { const v = Number(cfg?.tactics?.[k]); if (Number.isInteger(v) && v >= 1 && v <= 5) tactics[k] = v; }
    return {
      side, code, t, squad, venue, tactics, tacticDefaults: defaults,
      formation: cfg?.formation ?? d.formation,
      defaultXi: d.xi, onPitch: [...xi], bench: [...bench], off: [], sentOff: [], cameOn: new Set(),
      subsUsed: 0, windows: new Set(), yellows: new Map(), red: 0,
      rates, play, pool: poolOf(t), plan: cfg?.subs ? cfg.subs.map(s => ({ ...s, user: true })) : null,
      stats: { shots: 0, on: 0, off: 0, blocked: 0, corners: 0, fouls: 0, yellow: 0, red: 0, xg: 0, goals: 0, offsides: 0, possSec: 0, seqs: 0 },
    };
  }
  const H = mkSide('home', home, setup.home), A = mkSide('away', away, setup.away);
  const opp = s => (s === H ? A : H);
  const outfield = s => s.onPitch.filter(c => s.squad.get(c).pos !== 'GK');
  const gkOf = s => s.onPitch.find(c => s.squad.get(c).pos === 'GK') ?? s.onPitch[0];
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
  const shareOf = s => { const ph = (possTarget ?? 50) / 100; return s === H ? ph : 1 - ph; };
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

  /* ── 時鐘 ────────────────────────────────────────────────
     clock 是秒;上半場 0 → 2700 + 補時,下半場從 2700 重新起算到 5400 + 補時。
     顯示分鐘照足球的寫法:45+、90+(min 封頂,extra 另記)。 */
  const st = { clock: 0, half: 1, min: 1, extra: null, score: [0, 0], finished: false, events: [], seqs: [], lost: [0, 0, 0] };
  const minuteOf = sec => minuteAt(sec, st.half, R);
  const syncMin = () => { const m = minuteOf(st.clock); st.min = m.min; st.extra = m.extra; };
  const push = e => { st.events.push(e); return e; };
  const nameOf = (s, c) => s.squad.get(c)?.name ?? c;
  let seqId = 0;
  let cur = null;   // 正在產生的回合(事件掛在它身上)
  const pushEv = (s, e) => {
    const m = minuteOf(st.clock);
    const ev = push({ min: m.min, extra: m.extra, sec: Math.round(st.clock), seq: cur?.id ?? null, side: s?.side ?? null, team: s?.code ?? null, ...e });
    if (cur) cur.events.push(ev);
    return ev;
  };

  /* ── 抽人 ── */
  function scorerFallback(s) {
    const cands = outfield(s);
    const byShots = cands.filter(c => (s.pool.shotCount.get(c) ?? 0) > 0);
    if (byShots.length) return pickWeighted(rng, byShots, c => s.pool.shotCount.get(c));
    const totalXg = cands.reduce((a, c) => a + (s.squad.get(c).xg ?? 0), 0);
    return pickWeighted(rng, cands, c => (totalXg > 0 ? (s.squad.get(c).xg ?? 0) : (R.ROLE_GOAL_WEIGHT[s.squad.get(c).role] ?? 1)));
  }
  const takerOf = (s, list) => {
    for (const x of list ?? []) { const c = s.onPitch.find(cc => s.squad.get(cc).name === x.name); if (c) return c; }
    return null;
  };
  const roleOf = (s, c) => s.squad.get(c)?.role ?? ({ GK: 'GK', DEF: 'CB', MID: 'CM', FWD: 'ST' }[s.squad.get(c)?.pos] ?? 'CM');
  /* 傳球串:起點之後抽 n 個接球的人,按回合進度用不同的角色權重;同一個人不連續兩次。 */
  function chainOf(s, startCode, n) {
    const chain = [startCode];
    const cands = s.onPitch;
    for (let i = 0; i < n; i++) {
      const stage = i < n * 0.4 ? 'early' : i < n * 0.75 ? 'mid' : 'late';
      const prev = chain[chain.length - 1];
      const nxt = pickWeighted(rng, cands.filter(c => c !== prev), c => (CHAIN_W[stage][roleOf(s, c)] ?? 1) * (1 + (s.squad.get(c).ability?.cre ?? 0) / 20));
      if (!nxt) break;
      chain.push(nxt);
    }
    return chain.slice(0, R.MAX_CHAIN);
  }

  /* ── 射門:抽一筆真實射門,結果由錨定的機率決定 ── */
  const sitOfRow = (s, row) => s.pool.src.sits[row[3]] ?? 'RegularPlay';
  function sampleShot(s, group) {
    const g = s.pool.groups[group]?.length ? s.pool.groups[group] : (s.pool.fbGroups[group]?.length ? s.pool.fbGroups[group] : s.pool.groups.open);
    const fromFallback = !s.pool.groups[group]?.length;
    const row = g[Math.floor(rng() * g.length)];
    const src = fromFallback ? s.pool.fb : s.pool.src;
    const code = row[5] >= 0 && !fromFallback ? src.players[row[5]] : null;
    return { x: row[0], y: row[1], xg: row[2], situation: src.sits[row[3]] ?? 'RegularPlay', realOutcome: src.outs[row[4]] ?? 'off', shooter: code, fromFallback };
  }
  const dT = (s, k) => s.tactics[k] - s.tacticDefaults[k];   // 指令相對預設的位移(−4 ~ +4)
  const mul = (x, per, d) => x * Math.max(0.5, 1 + per * d);
  /* 期望射門含心態:自己進攻多射一點、對手也多一點(壓上去後面就空)。k 從這個算,所以 λ 不變 */
  const expectedShots = s => mul(mul(Math.max(0.5, (s.rates.sf ?? L.rates.sf) * ((opp(s).rates.sa ?? L.rates.sf) / L.rates.sf)), R.TAC.mentalityShots, dT(s, 'mentality')), R.TAC.mentalityOppShots, dT(opp(s), 'mentality'));
  const kOf = s => (lambda(s) * redFactor(s)) / (expectedShots(s) * Math.max(0.01, s.pool.meanXg));
  /* 進球機率隨分鐘的傾斜:同一顆 xG 在真實進球密度高的分鐘轉換率高一點(進球分布 ÷ 射門分布,兩邊都是真資料),
     總和不變 —— Σ_m wShot[m] × (wGoal[m]/wShot[m]) = 1,錨仍然精確。 */
  const tiltOf = m => (wShot[m] > 0 ? wGoal[m] / wShot[m] : 1);   // 90+ 兩邊同樣除以補時長度,比值不變
  function resolveShot(s, group, opts = {}) {
    const sh = sampleShot(s, group);
    let shooter = opts.shooter ?? (sh.shooter && s.onPitch.includes(sh.shooter) ? sh.shooter : scorerFallback(s));
    if (!shooter) shooter = outfield(s)[0];
    const m = minuteOf(st.clock).min;
    const pGoal = clamp(sh.xg * kOf(s) * tiltOf(m), 0, 0.97);
    const isGoal = rng() < pGoal;
    let outcome = 'goal';
    if (!isGoal) {
      // 不進的話用射門池裡不進的結果分布(真資料):被撲 / 被封 / 射偏 / 中柱
      const g = s.pool.groups[group]?.length ? s.pool.groups[group] : s.pool.groups.open;
      const miss = g.filter(r => s.pool.src.outs[r[4]] !== 'goal');
      outcome = miss.length ? (s.pool.src.outs[miss[Math.floor(rng() * miss.length)][4]] ?? 'off') : 'off';
      if (outcome === 'goal') outcome = 'off';
    }
    return { ...sh, shooter, outcome, pGoal: r2(pGoal) };
  }

  function goal(s, sh, chain, sit) {
    const o = opp(s);
    const ownGoal = sit !== 'Penalty' && rng() < (L.ownGoalShare ?? 0);
    let scorer = sh.shooter, assist = null, taker = null;
    if (ownGoal) { const defs = outfield(o).filter(c => o.squad.get(c).pos === 'DEF'); scorer = pickWeighted(rng, defs.length ? defs : outfield(o), () => 1); }
    else if (sit !== 'Penalty' && chain.length >= 2 && rng() < (s.t.assistShare ?? 0.7)) assist = chain[chain.length - 2];
    if (sit === 'FromCorner') taker = takerOf(s, s.t.takers?.corner) ?? chain[0];
    if (sit === 'FreeKick' || sit === 'SetPiece') taker = takerOf(s, s.t.takers?.fk) ?? chain[0];
    s.stats.goals++; s.stats.xg = r2(s.stats.xg + (ownGoal ? 0 : sh.xg));
    st.score[s === H ? 0 : 1]++;
    return pushEv(s, { type: 'goal', situation: ownGoal ? 'OwnGoal' : sit, ownGoal, scorer, scorerName: ownGoal ? nameOf(o, scorer) : nameOf(s, scorer),
      assist, assistName: assist ? nameOf(s, assist) : null, taker, takerName: taker ? nameOf(s, taker) : null,
      score: [...st.score], xg: ownGoal ? 0 : sh.xg, x: sh.x, y: sh.y });
  }
  function card(s, code, kind) {
    st.lost[st.half] += R.DEAD_CARD;
    if (kind === 'yellow') {
      const n = (s.yellows.get(code) ?? 0) + 1; s.yellows.set(code, n); s.stats.yellow++;
      pushEv(s, { type: 'card', card: 'yellow', second: n === 2, player: code, playerName: nameOf(s, code) });
      if (n === 2) return card(s, code, 'red');
      return;
    }
    s.onPitch = s.onPitch.filter(c => c !== code); s.sentOff.push(code); s.red++; s.stats.red++;
    pushEv(s, { type: 'card', card: 'red', player: code, playerName: nameOf(s, code), players: s.onPitch.length });
  }
  /* 犯規:s 是犯規的一方,victim 是被犯規的對手球員 */
  function foul(s, victim, at, pen) {
    s.stats.fouls++;
    const who = pickWeighted(rng, outfield(s), c => (s.squad.get(c).yellow ?? 0) + R.CARD_SMOOTH);
    const o = opp(s);
    const ev = pushEv(s, { type: 'foul', player: who, playerName: nameOf(s, who), on: victim, onName: nameOf(o, victim), x: at.x, y: at.y, penalty: pen });
    const fouls = s.rates.fouls || 11, pY = (s.rates.yellow ?? L.rates.yellow) / fouls, pR = (s.rates.red ?? L.rates.red) / fouls;
    const r = rng();
    if (r < pR) card(s, who, 'red');
    else if (r < pR + pY) card(s, who, 'yellow');
    return { who, ev };
  }
  function doSub(s, offCode, onCode, user) {
    const o = s.squad.get(offCode), n = s.squad.get(onCode);
    s.onPitch = s.onPitch.map(c => (c === offCode ? onCode : c));
    s.bench = s.bench.filter(c => c !== onCode); s.off.push(offCode); s.cameOn.add(onCode); s.subsUsed++;
    if (st.min !== R.HALF_TIME) s.windows.add(st.min);
    st.lost[st.half] += R.DEAD_SUB;
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
      if (p.done || p.min > st.min) continue;
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

  /* ── 每場期望值(全部從側寫的率算)── */
  const shotShare = (s, keys) => { const src = s.t.shotSituations ?? L.shotSituations ?? {}; return keys.reduce((a, k) => a + (src[k]?.share ?? 0), 0); };
  const cornersExpected = s => mul(Math.max(0.5, (s.rates.cf ?? L.rates.cf) * ((opp(s).rates.ca ?? L.rates.cf) / L.rates.cf)), R.TAC.widthCorners, dT(s, 'width'));
  const foulsBy = s => mul(Math.max(1, ((s.rates.fouls ?? L.rates.fouls) + (opp(s).rates.foulsAgainst ?? L.rates.fouls)) / 2), R.TAC.pressingFouls, dT(s, 'pressing'));   // s 犯規的次數/場;壓迫高犯規多
  const offsidesOf = s => mul(mul(Math.max(0, s.play?.offsides ?? L.play?.offsides ?? 1.6), R.TAC.lineOffsides, dT(opp(s), 'line')), R.TAC.directOffsides, dT(s, 'directness'));   // 對手防線高、自己踢得直接 → 越位多
  const passesOf = s => mul(mul(Math.max(50, s.play?.passes ?? L.play?.passes ?? 430), -R.TAC.directPasses, dT(s, 'directness')), -R.TAC.tempoPasses, dT(s, 'tempo'));
  const outcomeShare = (s, key) => { const rows = s.pool.src.rows; if (!rows.length) return 0; return rows.filter(r => s.pool.src.outs[r[4]] === key).length / rows.length; };

  /* 停球縮放(見 DEAD 的註解):補不回來的停球在期望上要等於 比賽長度 − 球在場上 = 5400 + 2 × 基本補時 − BIP_SEC。 */
  const deadScale = (() => {
    const N = R.SEQ_PER_TEAM;
    let exp = 0;
    for (const s of [H, A]) {
      const o = opp(s);
      const S = expectedShots(s), C = cornersExpected(s), F = foulsBy(o), O = offsidesOf(s);
      const sOpen = S * shotShare(s, ['RegularPlay', 'FastBreak', 'IndividualPlay', 'ThrowInSetPiece']);
      const nonOut = Math.max(0, N - sOpen - C - F - O);
      const out = nonOut * R.OUT_SHARE;
      exp += C * R.DEAD.corner + F * R.DEAD.freekick + O * R.DEAD.offside
        + out * (R.THROWIN_SHARE * R.DEAD.throwin + (1 - R.THROWIN_SHARE) * R.DEAD.goalkick)
        + S * (outcomeShare(s, 'off') + outcomeShare(s, 'post') * (1 - R.POST_KEEP)) * R.DEAD.goalkick
        + S * outcomeShare(s, 'saved') * R.DEAD.keeper;
    }
    const target = R.FULL * 60 + 2 * R.ADDED_BASE - R.BIP_SEC;
    return exp > 0 ? clamp(target / exp, 0.5, 3) : 1;
  })();
  const deadOf = kind => Math.round((R.DEAD[kind] ?? 0) * (['goal', 'penalty', 'kickoff'].includes(kind) ? 1 : deadScale));

  /* ── 回合 ────────────────────────────────────────────────
     restart 是下一個回合的起點(在**那一隊的進攻座標**裡:攻向 x = 105)。 */
  const flipXY = (x, y) => ({ x: r1(105 - x), y: r1(68 - y) });
  let restart = { side: 'home', type: 'kickoff', x: 52.5, y: 34, player: null };
  const isStoppage = type => !['turnover', 'loose', 'keeper'].includes(type);

  function startPlayer(s, type, x, y) {
    if (type === 'goalkick' || type === 'keeper') return gkOf(s);
    if (type === 'corner') return takerOf(s, s.t.takers?.corner) ?? pickWeighted(rng, outfield(s), c => (s.squad.get(c).ability?.cre ?? 5) + 1);
    if (type === 'freekick') return takerOf(s, s.t.takers?.fk) ?? pickWeighted(rng, outfield(s), c => (s.squad.get(c).ability?.cre ?? 5) + 1);
    if (type === 'penalty') return takerOf(s, s.t.takers?.pen) ?? scorerFallback(s);
    if (type === 'kickoff') return pickWeighted(rng, outfield(s), c => ({ ST: 3, AM: 2, CM: 2 }[roleOf(s, c)] ?? 0.3));
    if (type === 'throwin') return pickWeighted(rng, outfield(s), c => ({ FB: 4, W: 2, CM: 1, CB: 1 }[roleOf(s, c)] ?? 0.5));
    // 斷球反擊 / 二點球:靠位置的人 —— 由結局那一步指定,沒有指定就挑中後場的人
    return pickWeighted(rng, outfield(s), c => (x < 50 ? { CB: 3, FB: 2, DM: 2, CM: 1.5 } : { CM: 2, AM: 2, W: 2, ST: 1.5 })[roleOf(s, c)] ?? 0.5);
  }

  function endHalfIfDue() {
    const limit = (st.half === 1 ? R.HALF_TIME : R.FULL) * 60 + R.ADDED_BASE + st.lost[st.half];
    if (st.clock < limit) return false;
    if (st.half === 1) {
      st.clock = limit; syncMin();
      push({ min: R.HALF_TIME, extra: st.extra, sec: Math.round(st.clock), seq: null, type: 'half', score: [...st.score] });
      st.half = 2; st.clock = R.HALF_TIME * 60; syncMin();
      restart = { side: 'away', type: 'kickoff', x: 52.5, y: 34, player: null };
      return false;   // 下半場照常開球
    }
    st.clock = limit; syncMin();
    st.finished = true;
    push({ min: R.FULL, extra: st.extra, sec: Math.round(st.clock), seq: null, type: 'full', score: [...st.score] });
    return true;
  }

  /* 一個回合。回傳給畫面的劇本:誰開始、誰碰球、怎麼結束、之後停多久、下一回合怎麼開。 */
  function nextSequence() {
    if (st.finished) return null;
    const s = restart.side === 'home' ? H : A, o = opp(s);
    const type = restart.type;
    syncMin();
    if (st.min === 1 && st.half === 1 && st.events.length === 0) push({ min: 0, extra: null, sec: 0, seq: null, type: 'kickoff', side: 'home', team: H.code });
    // 停球時做換人(自動計畫到了分鐘;使用者的換人在 substitute() 已即時套用)
    if (isStoppage(type)) for (const sd of [H, A]) runPlan(sd);
    const id = ++seqId;
    const m = st.min;
    /* 上一回合結束時挑好的主罰者(角球 / 門將 / 斷球的人)可能剛剛在停球時被換下 —— 實測 seed 3 回合 168:
       角球主罰者在同一個停球被自動換人換走,傳球串的第一個人已經不在場上。不在場上就重挑。 */
    const restartPlayer = restart.player && s.onPitch.includes(restart.player) ? restart.player : startPlayer(s, type, restart.x, restart.y);
    cur = { id, side: s.side, team: s.code, half: st.half, t0: Math.round(st.clock), min: m, start: { type, x: restart.x, y: restart.y, player: restartPlayer }, events: [], chain: [], end: null, dead: 0 };
    s.stats.seqs++;
    const N = R.SEQ_PER_TEAM;
    const perMin = 90;   // 分鐘權重的平均是 1/90,乘 90 讓平均倍率 = 1
    let group = null, pShot = 0, dur = 0;
    if (type === 'corner') { group = 'corner'; pShot = clamp(shotShare(s, ['FromCorner']) * expectedShots(s) / cornersExpected(s), 0, 0.9); dur = 12 + rng() * 6; }
    else if (type === 'freekick' && restart.x >= 70) { group = 'fk'; pShot = clamp(shotShare(s, ['FreeKick', 'SetPiece']) * expectedShots(s) / (foulsBy(o) * R.FOUL_ATT_THIRD), 0, 0.9); dur = 8 + rng() * 6; }
    else if (type === 'penalty') { group = 'pen'; pShot = 1; dur = 6; }
    else {
      group = 'open';
      const meanDur = R.BIP_SEC * shareOf(s) / N;
      dur = meanDur * (1 - R.SEQ_DUR_JITTER + rng() * 2 * R.SEQ_DUR_JITTER);
      pShot = shotShare(s, ['RegularPlay', 'FastBreak', 'IndividualPlay', 'ThrowInSetPiece']) * expectedShots(s) / N * wAt(wShot, m) * perMin;
    }
    const pCorner = group === 'open' ? cornersExpected(s) / N : 0;
    const pFoul = group === 'open' ? foulsBy(o) / N * wAt(wCard, m) * perMin : (group === 'pen' ? 0 : foulsBy(o) / N * 0.5);
    const pOff = group === 'open' ? offsidesOf(s) / N : 0;
    // 傳球串
    const nPass = group === 'pen' ? 0 : group === 'corner' ? 1 + (rng() < 0.4 ? 1 : 0) : group === 'fk' ? (rng() < 0.5 ? 0 : 1) : poisson(rng, passesOf(s) / N);
    const chain = chainOf(s, cur.start.player, Math.min(R.MAX_CHAIN - 1, nPass));
    // 結局
    const r = rng();
    let endType;
    if (r < pShot) endType = 'shot';
    else if (r < pShot + pCorner) endType = 'corner';
    else if (r < pShot + pCorner + pFoul) endType = 'foul';
    else if (r < pShot + pCorner + pFoul + pOff) endType = 'offside';
    else endType = group === 'open' ? (rng() < R.OUT_SHARE ? 'out' : 'turnover') : (rng() < (group === 'corner' ? R.CORNER_KEEP : R.FK_KEEP) ? 'loose' : 'turnover');
    st.clock += dur; syncMin();
    s.stats.possSec += dur;
    let end, next, dead = 0;
    const last = chain[chain.length - 1];
    if (endType === 'shot') {
      const sh = resolveShot(s, group, group === 'pen' ? { shooter: cur.start.player } : {});
      if (sh.shooter !== last) chain.push(sh.shooter);
      s.stats.shots++;
      const sit = sh.situation;
      let goalEv = null;
      if (sh.outcome === 'goal') {
        s.stats.on++;
        goalEv = goal(s, sh, chain, group === 'pen' ? 'Penalty' : sit);
      } else {
        s.stats[sh.outcome === 'saved' ? 'on' : sh.outcome === 'blocked' ? 'blocked' : 'off']++;
        s.stats.xg = r2(s.stats.xg + sh.xg);
        pushEv(s, { type: 'shot', situation: group === 'pen' ? 'Penalty' : sit, outcome: sh.outcome, player: sh.shooter, playerName: nameOf(s, sh.shooter), xg: sh.xg, x: sh.x, y: sh.y, pGoal: sh.pGoal });
      }
      end = { type: 'shot', x: sh.x, y: sh.y, player: sh.shooter, outcome: sh.outcome, situation: group === 'pen' ? 'Penalty' : sit, xg: sh.xg, pGoal: sh.pGoal, goal: goalEv ? { ownGoal: goalEv.ownGoal, scorer: goalEv.scorer, assist: goalEv.assist } : null };
      if (sh.outcome === 'goal') { dead = deadOf('goal'); st.lost[st.half] += dead; next = { side: o.side, type: 'kickoff', x: 52.5, y: 34, player: null }; }
      else if (sh.outcome === 'saved') { dead = deadOf('keeper'); next = { side: o.side, type: 'keeper', x: 6, y: 34, player: gkOf(o) }; }
      else if (sh.outcome === 'blocked') {
        if (rng() < R.BLOCK_KEEP) next = { side: s.side, type: 'loose', x: r1(Math.max(60, sh.x - 10)), y: sh.y, player: null };
        else { const f = flipXY(sh.x, sh.y); next = { side: o.side, type: 'turnover', x: r1(Math.max(5, f.x + 6)), y: f.y, player: null }; }
      } else if (sh.outcome === 'post' && rng() < R.POST_KEEP) next = { side: s.side, type: 'loose', x: r1(Math.max(60, sh.x - 8)), y: sh.y, player: null };
      else { dead = deadOf('goalkick'); next = { side: o.side, type: 'goalkick', x: 5.5, y: r1(34 + (rng() < 0.5 ? -8 : 8)), player: gkOf(o) }; }
    } else if (endType === 'corner') {
      s.stats.corners++;
      const y = rng() < 0.5 ? 0.5 : 67.5;
      const taker = takerOf(s, s.t.takers?.corner) ?? pickWeighted(rng, outfield(s), c => (s.squad.get(c).ability?.cre ?? 5) + 1);
      pushEv(s, { type: 'corner', player: taker, playerName: nameOf(s, taker), y });
      end = { type: 'corner', x: 104.5, y, player: last };
      dead = deadOf('corner'); next = { side: s.side, type: 'corner', x: 104.5, y, player: taker };
    } else if (endType === 'foul') {
      const pPen = clamp(shotShare(s, ['Penalty']) * expectedShots(s) / foulsBy(o), 0, 0.5);
      const pen = group === 'open' && rng() < pPen;
      let at;
      if (pen) at = { x: r1(88 + rng() * 15), y: r1(22 + rng() * 24) };
      else if (rng() < R.FOUL_ATT_THIRD) at = { x: r1(70 + rng() * 18), y: r1(6 + rng() * 56) };
      else at = { x: r1(15 + rng() * 55), y: r1(6 + rng() * 56) };
      const { who } = foul(o, last, at, pen);
      end = { type: 'foul', x: at.x, y: at.y, player: last, by: who, penalty: pen };
      if (pen) { dead = deadOf('penalty'); st.lost[st.half] += dead; next = { side: s.side, type: 'penalty', x: 94, y: 34, player: null }; }
      else { dead = deadOf('freekick'); next = { side: s.side, type: 'freekick', x: at.x, y: at.y, player: null }; }
    } else if (endType === 'offside') {
      s.stats.offsides++;
      const who = pickWeighted(rng, outfield(s).filter(c => c !== last), c => OFFSIDE_W[roleOf(s, c)] ?? 0.3) ?? last;
      const at = { x: r1(78 + rng() * 22), y: r1(10 + rng() * 48) };
      pushEv(s, { type: 'offside', player: who, playerName: nameOf(s, who), x: at.x, y: at.y });
      chain.push(who);
      end = { type: 'offside', x: at.x, y: at.y, player: who, passer: last };
      const f = flipXY(at.x, at.y);
      dead = deadOf('offside'); next = { side: o.side, type: 'freekick', x: f.x, y: f.y, player: null };
    } else if (endType === 'out') {
      const throwIn = rng() < R.THROWIN_SHARE;
      if (throwIn) {
        const keep = rng() < R.THROWIN_KEEP;
        const at = { x: r1(15 + rng() * 80), y: rng() < 0.5 ? 0.5 : 67.5 };
        end = { type: 'out', kind: 'throwin', x: at.x, y: at.y, player: last, keep };
        dead = deadOf('throwin');
        next = keep ? { side: s.side, type: 'throwin', x: at.x, y: at.y, player: null } : (() => { const f = flipXY(at.x, at.y); return { side: o.side, type: 'throwin', x: f.x, y: f.y, player: null }; })();
      } else {
        end = { type: 'out', kind: 'goalkick', x: r1(90 + rng() * 14), y: rng() < 0.5 ? r1(rng() * 18) : r1(50 + rng() * 18), player: last };
        dead = deadOf('goalkick'); next = { side: o.side, type: 'goalkick', x: 5.5, y: r1(34 + (rng() < 0.5 ? -8 : 8)), player: gkOf(o) };
      }
    } else if (endType === 'loose') {
      end = { type: 'loose', x: r1(60 + rng() * 30), y: r1(14 + rng() * 40), player: last };
      next = { side: s.side, type: 'loose', x: end.x, y: end.y, player: null };
    } else {
      // 被斷球:對方某個人(防守能力加權)在球場某處把球贏走 → 對方從那裡反擊
      const at = group === 'open' ? { x: r1(clamp(20 + rng() * 65 - R.TAC.pressingTurnoverX * dT(o, 'pressing'), 8, 96)), y: r1(6 + rng() * 56) } : { x: r1(70 + rng() * 25), y: r1(10 + rng() * 48) };
      const by = pickWeighted(rng, outfield(o), c => 0.2 + defOf(o.squad.get(c)));
      end = { type: 'turnover', x: at.x, y: at.y, player: last, by };
      const f = flipXY(at.x, at.y);
      next = { side: o.side, type: 'turnover', x: f.x, y: f.y, player: by };
    }
    cur.chain = chain; cur.end = end; cur.t1 = Math.round(st.clock); cur.dur = r1(dur);
    st.clock += dead; cur.dead = dead; syncMin();
    cur.next = next;
    restart = next;
    st.seqs.push(cur);
    const out = cur; cur = null;
    endHalfIfDue();
    if (st.finished) out.next = null;
    return out;
  }

  /* 走到下一個顯示分鐘(測試與「跳到結果」用):回傳這段時間新增的事件。 */
  function tick() {
    if (st.finished) return [];
    const before = st.events.length;
    const m0 = st.min, h0 = st.half;
    while (!st.finished && st.min === m0 && st.half === h0) nextSequence();
    return st.events.slice(before);
  }

  const sideState = s => ({
    code: s.code, formation: s.formation, onPitch: [...s.onPitch], bench: [...s.bench], off: [...s.off], sentOff: [...s.sentOff],
    subsUsed: s.subsUsed, windowsUsed: s.windows.size, red: s.red, stats: { ...s.stats, possSec: Math.round(s.stats.possSec) },
    tactics: { ...s.tactics }, tacticDefaults: { ...s.tacticDefaults },
    ratioAtt: r2(ratioAtt(s)), ratioDef: r2(ratioDef(s)), lambda: r2(lambda(s)), lambdaEff: r2(lambda(s) * redFactor(s)),
    yellows: [...s.yellows.entries()].map(([c, n]) => ({ player: c, n })),
    plan: s.plan.map(p => ({ min: p.min, band: p.band ?? null, off: p.off ?? null, on: p.on ?? null, done: p.done === true, user: p.user === true })),
  });

  return {
    rules: R, possTarget,
    state: () => ({ min: st.min, extra: st.extra, sec: Math.round(st.clock), half: st.half, score: [...st.score], finished: st.finished, possTarget,
      possActual: (H.stats.possSec + A.stats.possSec) > 0 ? Math.round(100 * H.stats.possSec / (H.stats.possSec + A.stats.possSec)) : null,
      seqs: st.seqs.length, added: [null, R.ADDED_BASE + st.lost[1], R.ADDED_BASE + st.lost[2]], deadScale: r2(deadScale),
      home: sideState(H), away: sideState(A) }),
    events: () => [...st.events],
    sequences: () => [...st.seqs],
    tick, nextSequence,
    restart: () => ({ ...restart }),
    lambdas: () => ({ home: lambda(H), away: lambda(A), redHome: H.red, redAway: A.red }),
    canSub: (side, offCode, onCode) => canSub(side === 'home' ? H : A, offCode, onCode),
    substitute(side, offCode, onCode) {
      const s = side === 'home' ? H : A;
      const err = canSub(s, offCode, onCode);
      if (err) return { ok: false, error: err };
      return { ok: true, event: doSub(s, offCode, onCode, true) };
    },
    setFormation(side, label) { (side === 'home' ? H : A).formation = label; },
    /* 戰術指令:賽中隨時改,下一個回合起生效;回傳現在的級與預設級(畫面標「本季實際」用) */
    setTactics(side, patch = {}) {
      const s = side === 'home' ? H : A;
      for (const k of TACTIC_KEYS) { const v = Number(patch[k]); if (Number.isInteger(v) && v >= 1 && v <= 5) s.tactics[k] = v; }
      return { levels: { ...s.tactics }, defaults: { ...s.tacticDefaults } };
    },
    tactics: () => ({ home: { levels: { ...H.tactics }, defaults: { ...H.tacticDefaults } }, away: { levels: { ...A.tactics }, defaults: { ...A.tacticDefaults } } }),
    playerOf: (side, code) => (side === 'home' ? H : A).squad.get(code) ?? null,
  };
}
