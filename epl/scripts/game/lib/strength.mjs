/* 強弱量測台的估計量(2026-10-06,`check-strength.mjs` 與它的測試共用)。
 *
 * 為什麼抽出來:這一份決定「引擎有沒有把強弱壓扁」的判決。寫在量測台的頂層程式裡,測試就 import 不到
 * (import 會把九組配對的模擬整個跑一遍);抽成純函式才測得到 —— 規則是 `lib/` 裡的純函式,
 * 量測台只負責跑場與印。
 *
 * 輸入 `ent`:每個「隊 × 主客」一筆 { pair, code, side, lam, goals, se, shots, expShots, xgps, box, poss }。 */
export const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
export const sd = a => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / Math.max(1, a.length - 1));
export const se = a => sd(a) / Math.sqrt(a.length);

/* SE 不取 0.05 以下:一組全是同一個進球數的樣本 SE 是 0,那不是「無限準」是「沒有定義」(check-sim 同一條)。 */
export const SE_FLOOR = 0.05;

/* 每組配對裡 λ 較大的是強隊、較小的是弱隊 —— 兩個方向的 λ 平均起來比(主場優勢在兩個方向裡抵銷),
   不是看誰先列出來、也不是看誰在主場。 */
export function summarize({ ent, PAIRS }) {
  const strong = [], weak = [], zS = [], zW = [];
  for (const [x, y] of PAIRS) {
    const A = ent.filter(e => e.pair === `${x}-${y}`);
    const by = new Map();
    for (const e of A) { const o = by.get(e.code) ?? []; o.push(e); by.set(e.code, o); }
    const t = [...by.entries()].map(([code, es]) => ({
      code, lam: mean(es.map(e => e.lam)), goals: mean(es.map(e => e.goals)),
      se: Math.sqrt(es.reduce((s, e) => s + e.se ** 2, 0)) / es.length,
      sr: mean(es.map(e => e.shots / e.expShots)), xgps: mean(es.map(e => e.xgps)),
      box: mean(es.map(e => e.box)), poss: mean(es.map(e => e.poss)),
      possT: es.every(e => e.possT != null) ? mean(es.map(e => e.possT)) : null }));
    if (t.length !== 2) throw new Error(`${x}-${y}:要剛好兩支球隊,得到 ${t.length}`);
    const [S, W] = t[0].lam >= t[1].lam ? [t[0], t[1]] : [t[1], t[0]];
    strong.push({ ...S, pair: `${x}-${y}` }); weak.push({ ...W, pair: `${x}-${y}` });
    /* 兩個方向的 SE 都是 0 的那一組檢定沒有定義(不是「差無限多個 SE」),不進 z 平均 */
    if (S.se > 0) zS.push((S.goals - S.lam) / S.se);
    if (W.se > 0) zW.push((W.goals - W.lam) / W.se);
  }
  /* 校準斜率:模擬進球 = a + b × λ,加權最小平方,權重 1/SE²。b = 1 且 a = 0 才是沒有壓縮;
     b < 1 是強弱被壓扁(強隊偏低、弱隊偏高)。 */
  const w = ent.map(e => 1 / Math.max(e.se, SE_FLOOR) ** 2), sw = w.reduce((a, b) => a + b, 0);
  const mx = ent.reduce((t, e, i) => t + w[i] * e.lam, 0) / sw, my = ent.reduce((t, e, i) => t + w[i] * e.goals, 0) / sw;
  const sxx = ent.reduce((t, e, i) => t + w[i] * (e.lam - mx) ** 2, 0), sxy = ent.reduce((t, e, i) => t + w[i] * (e.lam - mx) * (e.goals - my), 0);
  const b = sxy / sxx, a = my - b * mx;
  const res = ent.reduce((t, e, i) => t + w[i] * (e.goals - a - b * e.lam) ** 2, 0) / Math.max(1, ent.length - 2);
  /* 控球跟著強弱走嗎:引擎的控球對**目標控球**(兩隊自己的真實主客控球率推出來的,引擎的 `possTarget`)
     做加權最小平方。斜率 1 = 照目標走、0 = 完全不理它。控球不是 λ 那樣的硬錨,但它是畫面上
     看得到的強弱 —— 進球與射門可以被扣扳機撐住,控球只能從比賽過程長出來。舊的結果檔沒有 `possT`,就不算。 */
  let possSlope = null, possSlopeSe = null;
  const pe = ent.filter(e => e.possT != null && Number.isFinite(e.possT));
  if (pe.length >= 3) {
    const pw = pe.map(e => 1 / Math.max(e.possSe ?? 1, 0.3) ** 2), psw = pw.reduce((x, y) => x + y, 0);
    const px = pe.reduce((t, e, i) => t + pw[i] * e.possT, 0) / psw, py = pe.reduce((t, e, i) => t + pw[i] * e.poss, 0) / psw;
    const pxx = pe.reduce((t, e, i) => t + pw[i] * (e.possT - px) ** 2, 0), pxy = pe.reduce((t, e, i) => t + pw[i] * (e.possT - px) * (e.poss - py), 0);
    possSlope = pxy / pxx;
    const pa = py - possSlope * px;
    const pres = pe.reduce((t, e, i) => t + pw[i] * (e.poss - pa - possSlope * e.possT) ** 2, 0) / Math.max(1, pe.length - 2);
    possSlopeSe = Math.sqrt(pres / pxx);
  }
  return {
    possSlope, possSlopeSe,
    pdT: strong.every((s, i) => s.possT != null && weak[i].possT != null) ? strong.map((s, i) => s.possT - weak[i].possT) : null,
    strong, weak, zS, zW, a, b, seB: Math.sqrt(res / sxx),
    gS: strong.map(s => s.goals / s.lam), gW: weak.map(s => s.goals / s.lam),
    sS: strong.map(s => s.sr), sW: weak.map(s => s.sr),
    dq: strong.map((s, i) => s.xgps - weak[i].xgps),
    rb: strong.map((s, i) => s.box / weak[i].box), pd: strong.map((s, i) => s.poss - weak[i].poss),
    /* 逐筆 |z| > 3:SE 是 0 的那些沒有定義,不算(check-sim 同一條) */
    big: ent.filter(e => e.se > 0 && Math.abs((e.goals - e.lam) / e.se) > 3).length,
  };
}

/* 把同一個引擎、不同種子的幾份結果合成一份(2026-10-06)。
 *
 * 為什麼:一份(每方向 30 場、540 場、35 分鐘)的校準斜率,**同一個引擎換一組種子就差 0.46**
 * (E4 的 101~130 是 1.031、201~230 是 0.575;兩組之差在「36 筆各自獨立」的模型裡抽 4000 次一次都沒超過),
 * 所以它自己報的 SE(0.08~0.10)低估了真正的抽樣變異。判決要看**合起來的**場數,而不是挑一組。
 *
 * 規則:場數相加、平均數照場數加權、SE 照「各份的 n × SE 平方相加再除以總場數」合起來(獨立樣本的變異數相加);
 * 每球 xG 是比值(進球的 xG ÷ 射門數),照射門總數加權才是合起來的那一個比值 —— 照場數加權會偏。
 * **λ、射門預算、目標控球在每份裡必須逐位相同**:不同就代表那不是同一組配對與同一份側寫,合起來沒有意義。 */
export function poolResults(results) {
  if (!results?.length) throw new Error('沒有結果可以合併');
  const key = e => `${e.pair}|${e.code}|${e.opp}|${e.side}`;
  const pairsKey = r => JSON.stringify(r.PAIRS);
  for (const r of results) if (pairsKey(r) !== pairsKey(results[0])) throw new Error(`配對清單不同:${pairsKey(r)} 對 ${pairsKey(results[0])}`);
  const by = new Map();
  for (const r of results) for (const e of r.ent) { const l = by.get(key(e)) ?? []; l.push(e); by.set(key(e), l); }
  const ent = [];
  for (const e0 of results[0].ent) {
    const es = by.get(key(e0));
    if (es.length !== results.length) throw new Error(`${key(e0)}:只出現在 ${es.length}/${results.length} 份裡`);
    for (const e of es) for (const k of ['lam', 'expShots', 'possT']) {
      if ((e[k] ?? null) !== (e0[k] ?? null) && !(Number.isFinite(e[k]) && Math.abs(e[k] - e0[k]) < 1e-9)) {
        throw new Error(`${key(e0)}:${k} 兩份不同(${e[k]} 對 ${e0[k]}),不是同一組配對或同一份側寫`);
      }
    }
    const n = es.reduce((t, e) => t + e.n, 0);
    const wm = f => es.reduce((t, e) => t + e.n * f(e), 0) / n;
    const wse = f => Math.sqrt(es.reduce((t, e) => t + (e.n * f(e)) ** 2, 0)) / n;
    const totShots = es.reduce((t, e) => t + e.n * e.shots, 0);
    ent.push({
      pair: e0.pair, code: e0.code, opp: e0.opp, side: e0.side, lam: e0.lam,
      goals: wm(e => e.goals), se: wse(e => e.se), n,
      shots: totShots / n, expShots: e0.expShots,
      xgps: totShots > 0 ? es.reduce((t, e) => t + e.xgps * e.n * e.shots, 0) / totShots : 0,
      box: wm(e => e.box), poss: wm(e => e.poss), possSe: wse(e => e.possSe ?? 0), possT: e0.possT ?? null,
    });
  }
  return { ent, PAIRS: results[0].PAIRS, N: ent[0].n, SEED0: results.map(r => r.SEED0).join('+') };
}
