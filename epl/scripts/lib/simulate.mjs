import { round } from './util.mjs';
import { lambdas } from './poisson.mjs';

// 蒙地卡羅模擬整季。
// 重點:每一次模擬都重新抽一組「球隊真實強度」,而不是只用點估計 —— 
// 否則會嚴重低估不確定性(模型會過度自信地把冠軍給某一隊)。
const SIGMA_KNOWN = 0.10;    // 有充足樣本的球隊,強度估計的標準差
const SIGMA_PRIOR = 0.15;    // 套用升班馬先驗的球隊,不確定性更大

/* promotion:「前幾名直接升級」。英超與西甲沒有這個概念,不給就不算 ——
   輸出多一個欄位對它們沒有意義,而且會讓前端以為每個聯賽都有直升。
   英冠是前 2 直升、3~6 打附加賽,所以「前四」那一欄在那裡沒有意義,
   要換成「直升」才講得對。既有的 top4Pct / top6Pct 語意不變(就是 ≤4 與 ≤6),
   不去改它們的名字 —— 名字對得上值,是這個檔案最不該動的東西。

   promotionPlayoff:升級附加賽區的最後一名(英冠 6)→ `playoffPct` = 落在 promotion+1 ~ 這一名。
   **不要拿 top6Pct 當附加賽區**:它含直升的前 2 名。2026-09-26 前英冠的「附加賽區」就是這樣印的 ——
   標題寫「第 3~6 名」,而 WHU 印 99%,真正落在 3~6 名的機率是 20%。

   relegated:**直接**降級的名額。原本寫死「後 3 名」(`pos >= n - 2`),六個聯賽共用 ——
   德甲法甲只有後 2 名直接降級、第 16 名打跨聯賽附加賽,於是那兩個聯賽的「降級」
   一直是「後 3 名」的機率(漢堡 58%,其中直接降級 43%、第 16 名 15%),而資料界線寫的是「直接降級」。
   預設 3 是英超、西甲、英冠、義甲的規則;德義法共用的 build 一律要自己給(lib/build-league.mjs)。
   relegationPlayoff:直接降級的上一名要打附加賽 → `relegationPlayoffPct` = 落在那一名的機率。
   只給「打到這一名」,不給附加賽的勝負 —— 對手在次級聯賽,本站評不出強度(鐵則二)。

   這幾個參數只改「數哪幾名」,不多抽一個亂數:同一組 seed 跑出來的其餘欄位逐位元組不變。 */
export function simulateSeason({ model, fixtures, codes, played = [], runs = 10000, seed = 20262027, promotion = null,
  promotionPlayoff = null, relegated = 3, relegationPlayoff = false }) {
  if (!Number.isInteger(relegated) || relegated < 1) throw new Error(`simulateSeason: relegated 要是正整數(拿到 ${relegated})`);
  if (promotionPlayoff != null && !(promotion && promotionPlayoff > promotion)) {
    throw new Error(`simulateSeason: promotionPlayoff(${promotionPlayoff})要大於 promotion(${promotion})`);
  }
  const idx = new Map(codes.map((c, i) => [c, i]));
  const n = codes.length;

  const base = fixtures.map(f => {
    const { lh, la } = lambdas(model, f.home, f.away);
    return { h: idx.get(f.home), a: idx.get(f.away), lh, la };
  });

  const sigma = codes.map(c => ((model.promoted || []).includes(c) ? SIGMA_PRIOR : SIGMA_KNOWN));

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
      const x = poisson(lh), y = poisson(la);
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
    expectedPoints: round(sumPts[i] / runs, 1),
    expectedPos: round(sumPos[i] / runs, 2),
    titlePct: round((title[i] / runs) * 100, 1),
    ...(promotion ? { promotionPct: round((promo[i] / runs) * 100, 1) } : {}),
    ...(promotionPlayoff ? { playoffPct: round((promoPlayoff[i] / runs) * 100, 1) } : {}),
    top4Pct: round((top4[i] / runs) * 100, 1),
    top6Pct: round((top6[i] / runs) * 100, 1),
    relegationPct: round((releg[i] / runs) * 100, 1),
    ...(relegationPlayoff ? { relegationPlayoffPct: round((relegPlayoff[i] / runs) * 100, 1) } : {}),
    posDist: [...posHist[i]].slice(1).map(v => round((v / runs) * 100, 1)),
  })).sort((a, b) => b.expectedPoints - a.expectedPoints);
}
