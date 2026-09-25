import { round } from './util.mjs';

// 進行中比賽的即時勝率。
//
// 做法:賽前模型算出的 λ 是「整場」的期望進球,按「還剩多少進球份額」縮放,
// 再把「目前比分」當成已經確定的部分,對剩餘時間的進球數做卷積。
// 比賽結束時剩餘份額為 0,結果自然收斂成實際比分(機率 100%)。
//
// 「還剩多少份額」有兩種算法(2026-09-25 起):
//   - **時間曲線**(`curve`,91 格 S[0..90]):實測的「時鐘走到 c 分之後還會進的球佔全場的比例」,
//     含補時、而且下半場比上半場密。`npm run tune:inplay` 從逐場事件估、在另一季驗收,
//     **通過才由 build 傳進來**(`lib/inplay-tuning.mjs` 的 `loadInplayCurve`)。
//   - **線性**(沒傳 curve):(90 − 分鐘) ÷ 90。這是原本的做法 —— 它沒有補時,
//     時鐘走到 90 就當比賽結束(補時中領先一球的那一隊被算成 100% 贏),80 分時以為還剩 11% 的進球、實際是 19%。
//     沒有曲線(檔案不在、驗收沒過)就退回這一條,行為跟改之前一個字元都不差。
// 補時的第幾分鐘本站多半不知道(FPL 的 minutes 在補時停在 90),所以 90 分之後一律用 S[90]
// —— 當補時剛開始算,補時後段會偏保守。
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

export function remainingFraction(minute, finished, curve = null) {
  if (finished) return 0;
  if (minute == null || minute <= 0) return 1;
  if (curve) {
    /* 分鐘可能帶小數(官方鐘):兩格之間線性內插;90 之後停在 S[90]。 */
    const t = Math.min(FULL, minute), i = Math.floor(t);
    return i >= FULL ? curve[FULL] : curve[i] + (curve[i + 1] - curve[i]) * (t - i);
  }
  return Math.max(0, Math.min(1, (FULL - minute) / FULL));
}

export function inPlay({ lambdaHome, lambdaAway, hs = 0, as = 0, minute = 0, finished = false, redHome = 0, redAway = 0, curve = null }) {
  const f = remainingFraction(minute, finished, curve);
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
    /* timing:這一格是哪一種時間算法算的 —— 勝率曲線的累積檔會記下來,
       校準那一節才分得出新舊兩個模型的點(混在一起的話那張表在量兩個模型的平均)。 */
    minute, finished, remaining: round(f, 3), timing: curve ? 'curve' : 'linear',
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
