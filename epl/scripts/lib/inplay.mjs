import { round } from './util.mjs';

// 進行中比賽的即時勝率。
//
// 做法:賽前模型算出的 λ 是「整場 90 分鐘」的期望進球,按剩餘時間等比例縮放,
// 再把「目前比分」當成已經確定的部分,對剩餘時間的進球數做卷積。
// 比賽結束時剩餘時間為 0,結果自然收斂成實際比分(機率 100%)。
const MAX_MORE = 7;         // 剩餘時間最多再算幾球
const RED_OWN = 0.72;       // 每張紅牌:自己的進攻打折
const RED_OPP = 1.30;       // 每張紅牌:對手的進攻放大
const FULL = 90;

const pmf = (l, n) => {
  const out = [];
  let term = Math.exp(-l);
  for (let k = 0; k <= n; k++) { out.push(term); term = (term * l) / (k + 1); }
  return out;
};

export function remainingFraction(minute, finished) {
  if (finished) return 0;
  if (minute == null || minute <= 0) return 1;
  return Math.max(0, Math.min(1, (FULL - minute) / FULL));
}

export function inPlay({ lambdaHome, lambdaAway, hs = 0, as = 0, minute = 0, finished = false, redHome = 0, redAway = 0 }) {
  const f = remainingFraction(minute, finished);
  const lh = lambdaHome * f * RED_OWN ** redHome * RED_OPP ** redAway;
  const la = lambdaAway * f * RED_OWN ** redAway * RED_OPP ** redHome;

  const ph = pmf(lh, MAX_MORE), pa = pmf(la, MAX_MORE);
  let home = 0, draw = 0, away = 0;
  const scores = new Map();
  for (let i = 0; i <= MAX_MORE; i++) {
    for (let j = 0; j <= MAX_MORE; j++) {
      const p = ph[i] * pa[j];
      const fh = hs + i, fa = as + j;
      if (fh > fa) home += p; else if (fh === fa) draw += p; else away += p;
      const k = `${fh}-${fa}`;
      scores.set(k, (scores.get(k) ?? 0) + p);
    }
  }
  const total = home + draw + away || 1;

  // 下一球歸屬:兩個 Poisson 過程競爭,機率就是各自強度的佔比
  const nextTotal = lh + la;
  const anyMore = 1 - Math.exp(-nextTotal);

  return {
    minute, finished, remaining: round(f, 3),
    home: round(home / total, 4), draw: round(draw / total, 4), away: round(away / total, 4),
    xgRestHome: round(lh, 2), xgRestAway: round(la, 2),
    expectedFinal: { home: round(hs + lh, 2), away: round(as + la, 2) },
    nextGoal: nextTotal > 0
      ? { home: round((lh / nextTotal) * anyMore, 3), away: round((la / nextTotal) * anyMore, 3), none: round(1 - anyMore, 3) }
      : { home: 0, away: 0, none: 1 },
    topScores: [...scores.entries()]
      .map(([s, p]) => ({ s, p: round(p / total, 4) }))
      .sort((a, b) => b.p - a.p).slice(0, 5),
  };
}

// 把賽前預測與目前局面對照:比分是不是「超前/落後於內容」
export function swingVsPreMatch(pre, now) {
  return {
    home: round(now.home - pre.home, 3),
    draw: round(now.draw - pre.draw, 3),
    away: round(now.away - pre.away, 3),
  };
}
