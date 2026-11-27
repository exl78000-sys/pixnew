/* 整季蒙地卡羅模擬 —— 建站與瀏覽器共用的那一份(2026-11-27,N4「如果…會怎樣」)。

   原本整段在 scripts/lib/simulate.mjs,只有建站在用。「如果…會怎樣」要在瀏覽器裡用**同一套**重跑,
   所以把核心搬到這裡,simulate.mjs 只剩包一層(從擬合好的 model 拿 λ)。**不另外寫一份前端版** ——
   本站付過好幾次「複製一份轉換過去,改了一邊另一邊悄悄過期」的代價(姓名配對、風格卡、賽前陣容對照)。
   搬動之後拿六個聯賽的真實參數比對過:不指定結果時輸出逐位元組不變(亂數抽取的順序一個都沒動)。

   重點:每一次模擬都重新抽一組「球隊真實強度」,而不是只用點估計 ——
   否則會嚴重低估不確定性(模型會過度自信地把冠軍給某一隊)。

   參數:
   - lambdaOf(home, away) → { lh, la }:這一場兩隊的預期進球(建站來自擬合的 model,瀏覽器來自 meta.model.sim)。
   - promoted:套用升班馬先驗的球隊(強度不確定性比較大)。
   - promotion / promotionPlayoff / relegated / relegationPlayoff:「數哪幾名」,只改統計、不多抽亂數(見 simulate.mjs 的說明)。
   - fixed:Map「主隊|客隊」→ 'H' | 'D' | 'A'。**使用者指定的結果**:那一場照樣抽比分(讓淨勝球是合理的),
     但只收符合指定結果的那一組 —— 抽到不符合就再抽。只有被指定的場次會多消耗亂數,
     所以不指定任何一場時,整條亂數序列跟原本一模一樣。 */

const SIGMA_KNOWN = 0.10;    // 有充足樣本的球隊,強度估計的標準差
const SIGMA_PRIOR = 0.15;    // 套用升班馬先驗的球隊,不確定性更大
const roundTo = (n, d = 2) => { const p = 10 ** d; return Math.round((Number(n) || 0) * p) / p; };
/* 指定結果時最多重抽幾次。強弱懸殊的配對要弱隊贏,一次命中的機率可能只有一成多,50 次幾乎一定抽得到;
   真的抽不到就用最小的合法比分(1-0 / 0-0 / 0-1),不讓迴圈卡住。 */
const FIXED_TRIES = 50;

export function runSeason({ lambdaOf, fixtures, codes, played = [], runs = 10000, seed = 20262027, promoted = [],
  promotion = null, promotionPlayoff = null, relegated = 3, relegationPlayoff = false, fixed = null }) {
  if (!Number.isInteger(relegated) || relegated < 1) throw new Error(`simulateSeason: relegated 要是正整數(拿到 ${relegated})`);
  if (promotionPlayoff != null && !(promotion && promotionPlayoff > promotion)) {
    throw new Error(`simulateSeason: promotionPlayoff(${promotionPlayoff})要大於 promotion(${promotion})`);
  }
  const idx = new Map(codes.map((c, i) => [c, i]));
  const n = codes.length;

  const base = fixtures.map(f => {
    const { lh, la } = lambdaOf(f.home, f.away);
    return { h: idx.get(f.home), a: idx.get(f.away), lh, la, want: fixed?.get(`${f.home}|${f.away}`) ?? null };
  });

  const sigma = codes.map(c => ((promoted || []).includes(c) ? SIGMA_PRIOR : SIGMA_KNOWN));

  const basePts = new Float64Array(n), baseGd = new Float64Array(n);
  for (const m of played) {
    if (!idx.has(m.home) || !idx.has(m.away)) continue;
    const h = idx.get(m.home), a = idx.get(m.away);
    baseGd[h] += m.fh - m.fa; baseGd[a] += m.fa - m.fh;
    if (m.fh > m.fa) basePts[h] += 3;
    else if (m.fh < m.fa) basePts[a] += 3;
    else { basePts[h] += 1; basePts[a] += 1; }
  }

  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return (s >>> 0) / 4294967296; };
  const gauss = () => {
    const u = Math.max(1e-12, rnd()), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const poisson = l => { // Knuth
    const L = Math.exp(-l);
    let k = 0, p = 1;
    do { k++; p *= rnd(); } while (p > L);
    return k - 1;
  };
  const outcome = (x, y) => (x > y ? 'H' : x < y ? 'A' : 'D');
  const FALLBACK = { H: [1, 0], D: [0, 0], A: [0, 1] };

  const sumPts = new Float64Array(n), sumPos = new Float64Array(n);
  const title = new Float64Array(n), top4 = new Float64Array(n), top6 = new Float64Array(n), releg = new Float64Array(n);
  const promo = new Float64Array(n), promoPlayoff = new Float64Array(n), relegPlayoff = new Float64Array(n);
  const posHist = Array.from({ length: n }, () => new Float64Array(n + 1));
  const pts = new Float64Array(n), gd = new Float64Array(n);
  const nAtt = new Float64Array(n), nDef = new Float64Array(n);
  const order = [...Array(n).keys()];

  for (let r = 0; r < runs; r++) {
    // 減掉 σ²/2:讓 E[exp(雜訊)] = 1,避免抽樣本身憑空墊高全聯盟進球數
    for (let i = 0; i < n; i++) {
      const half = (sigma[i] * sigma[i]) / 2;
      nAtt[i] = gauss() * sigma[i] - half;
      nDef[i] = gauss() * sigma[i] - half;
    }
    pts.set(basePts); gd.set(baseGd);
    for (const g of base) {
      const lh = g.lh * Math.exp(nAtt[g.h] + nDef[g.a]);
      const la = g.la * Math.exp(nAtt[g.a] + nDef[g.h]);
      let x = poisson(lh), y = poisson(la);
      if (g.want && outcome(x, y) !== g.want) {
        let ok = false;
        for (let t = 0; t < FIXED_TRIES && !ok; t++) { x = poisson(lh); y = poisson(la); ok = outcome(x, y) === g.want; }
        if (!ok) [x, y] = FALLBACK[g.want];
      }
      gd[g.h] += x - y; gd[g.a] += y - x;
      if (x > y) pts[g.h] += 3; else if (x < y) pts[g.a] += 3; else { pts[g.h] += 1; pts[g.a] += 1; }
    }
    order.sort((i, j) => pts[j] - pts[i] || gd[j] - gd[i] || (rnd() - 0.5));
    for (let k = 0; k < n; k++) {
      const t = order[k], pos = k + 1;
      sumPts[t] += pts[t]; sumPos[t] += pos; posHist[t][pos]++;
      if (pos === 1) title[t]++;
      if (promotion && pos <= promotion) promo[t]++;
      if (promotionPlayoff && pos > promotion && pos <= promotionPlayoff) promoPlayoff[t]++;
      if (pos <= 4) top4[t]++;
      if (pos <= 6) top6[t]++;
      if (pos > n - relegated) releg[t]++;
      if (relegationPlayoff && pos === n - relegated) relegPlayoff[t]++;
    }
  }

  return codes.map((c, i) => ({
    code: c,
    expectedPoints: roundTo(sumPts[i] / runs, 1),
    expectedPos: roundTo(sumPos[i] / runs, 2),
    titlePct: roundTo((title[i] / runs) * 100, 1),
    ...(promotion ? { promotionPct: roundTo((promo[i] / runs) * 100, 1) } : {}),
    ...(promotionPlayoff ? { playoffPct: roundTo((promoPlayoff[i] / runs) * 100, 1) } : {}),
    top4Pct: roundTo((top4[i] / runs) * 100, 1),
    top6Pct: roundTo((top6[i] / runs) * 100, 1),
    relegationPct: roundTo((releg[i] / runs) * 100, 1),
    ...(relegationPlayoff ? { relegationPlayoffPct: roundTo((relegPlayoff[i] / runs) * 100, 1) } : {}),
    posDist: [...posHist[i]].slice(1).map(v => roundTo((v / runs) * 100, 1)),
  })).sort((a, b) => b.expectedPoints - a.expectedPoints);
}

/* 瀏覽器端:用 meta.model.sim(建站寫出去的同一組強度參數)當 λ。
   跟建站的 lambdas(model) 只差在「exp(加總)」對「exp 相乘」,浮點末位的差,蒙地卡羅結果在誤差內相同(測試守著)。 */
export function lambdaFromSim(sim) {
  return (home, away) => {
    const th = sim.teams[home], ta = sim.teams[away];
    if (!th || !ta) return { lh: 1.4, la: 1.2 };
    return { lh: sim.base * th.att * ta.def * sim.homeAdv, la: sim.base * ta.att * th.def };
  };
}

/* 瀏覽器端重跑整季的輸入,從產物組出來(meta + fixtures.json)。放在這裡而不是畫面那支,
   是為了讓 npm test 能在 Node 裡拿**同一段**去比 sim.json —— 畫面那支 import core.js,Node 載不起來。
   回 null = 沒有可以假設的東西(沒有模擬設定、或這一季已經沒有未賽的聯賽場次)。 */
export function seasonInputs(meta, fixtures) {
  const cfg = meta?.model?.simConfig, simP = meta?.model?.sim;
  if (!cfg || !simP?.teams) return null;
  const league = fixtures.filter(f => f.season === meta.currentSeason && !f.stage);
  const played = league.filter(f => f.played && f.fh != null && f.fa != null);
  const remaining = league.filter(f => !f.played);
  const codes = [...new Set(league.flatMap(f => [f.home, f.away]))].filter(c => simP.teams[c]).sort();
  if (!remaining.length || !codes.length) return null;
  return { lambdaOf: lambdaFromSim(simP), fixtures: remaining, codes, played, promoted: meta.model.promotedPrior ?? [], ...cfg };
}
