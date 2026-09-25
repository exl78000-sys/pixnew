/* 即時勝率的時間曲線:從哪裡來、怎麼驗、build 怎麼讀。
 *
 * 現行的 in-play(lib/inplay.mjs)把賽前 λ 按「剩幾分鐘 ÷ 90」等比例縮。兩件事它沒算:
 *   ① **補時**。時鐘走到 90 分它就當比賽結束,而 2025-26 六個聯賽 6,263 顆進球裡 7.9% 是下半場補時進的;
 *   ② **進球不是平均分佈的**。下半場進的比上半場多(56% 對 44%),越接近終場越密。
 * 於是 80 分時它以為還剩 11% 的進球、實際是 19%;90 分(補時中)它說 0、實際是 8% ——
 * 領先一球的那一隊在補時裡被它算成 100% 贏球。
 *
 * 這一支做三件事(`npm run tune:inplay` 呼叫):
 *   - 從逐場事件估「時鐘走到 c 分之後,還會進的球佔全場的比例」S(c),c = 0..90;
 *   - 用它重建每一場每一分鐘的即時勝率,跟現行的線性版本在**另一季**逐場成對比(鐵則二);
 *   - build 讀結果:**驗收通過才用曲線**,沒過或檔案不在就是原本的線性(`loadInplayCurve`)。
 *
 * 檢查點 c 的意思是「時鐘剛走到 c:00」:顯示為 37' 的球是第 37 分鐘裡進的,c = 37 時已經發生;
 * 45+2' 的球在 c = 45 之後、下半場開球之前(所以 c ≥ 46 才算發生);90+k' 的球在 c = 90 之後。
 * 補時的長度上游沒有(事件裡沒有「補幾分鐘」),所以檢查點只取每一場都一定踢得到的 1..90,
 * 補時被收進 c = 45 與 c = 90 的「之後還會進多少」裡 —— 不需要知道那一場補了多久。 */

export const CURVE_POINTS = 91;           // S[0..90]
export const MIN_VALID_MATCHES = 150;     // 驗收場數不到這個數,結論是「樣本不足」而不是通過

/* 一場 FotMob 逐場資料 → 進球與紅牌(只認兩隊,其他的不收)。
   烏龍球的 team 是**踢進自家門的那一隊**(CLAUDE.md 記過那條坑),翻不翻交給 reconcile 用比分判。 */
export function eventsOf(fm, home, away) {
  const goals = [], reds = [];
  for (const e of fm?.events ?? []) {
    const side = e.team === home ? 'h' : e.team === away ? 'a' : null;
    if (!side) continue;
    const t = { minute: e.minute, extra: e.extra ?? null };
    if (e.type === 'Goal') goals.push({ ...t, side, own: e.detail === 'Own Goal' });
    else if (e.type === 'Card' && /Red/.test(e.detail ?? '')) reds.push({ ...t, side });
  }
  return { goals, reds };
}

/* 逐場核對:兩隊的進球數要剛好等於終場比分(賽果來源跟 FotMob 是獨立的兩份,鐵則五)。
   烏龍球翻成得分方與不翻各試一次,選對得上的;兩個都對不上就整場不收 —— 事件不完整的場次
   會讓「幾分鐘時比分是多少」整個錯掉。 */
export function reconcile(goals, fh, fa) {
  for (const flip of [true, false]) {
    const g = goals.map(x => ({ minute: x.minute, extra: x.extra, side: x.own && flip ? (x.side === 'h' ? 'a' : 'h') : x.side }));
    const h = g.filter(x => x.side === 'h').length;
    if (h === fh && g.length - h === fa) return g;
  }
  return null;
}

/* 事件在檢查點 c 之前發生了沒 */
export function happened(ev, c) {
  if (ev.extra == null) return ev.minute <= c;
  return ev.minute === 45 ? c >= 46 : false;   // 45+k 在下半場開球前;90+k 在所有檢查點之後
}

export function stateAt(m, c) {
  let hs = 0, as = 0, rh = 0, ra = 0;
  for (const g of m.goals) if (happened(g, c)) g.side === 'h' ? hs++ : as++;
  for (const r of m.reds) if (happened(r, c)) r.side === 'h' ? rh++ : ra++;
  return { hs, as, rh, ra };
}

/* S(c):檢查點 c 之後還會進的球佔全場的比例。S(0) = 1,只會往下走。 */
export function goalTimingCurve(matches) {
  const all = matches.flatMap(m => m.goals);
  const S = [];
  for (let c = 0; c <= 90; c++) S.push(all.length ? all.filter(g => !happened(g, c)).length / all.length : null);
  return {
    S, goals: all.length, matches: matches.length,
    firstHalfStoppage: all.filter(g => g.extra != null && g.minute === 45).length,
    secondHalfStoppage: all.filter(g => g.extra != null && g.minute === 90).length,
    firstHalf: all.filter(g => g.minute <= 45).length,
  };
}

/* build 讀到的曲線要長這樣才用:91 格、S[0] = 1、只往下走、最後一格大於 0(補時還會進球)。
   任何一條不成立就當沒有 —— 用一條壞掉的曲線比用線性更糟。 */
export function validCurve(S) {
  if (!Array.isArray(S) || S.length !== CURVE_POINTS) return false;
  if (!S.every(x => Number.isFinite(x) && x >= 0 && x <= 1)) return false;
  if (Math.abs(S[0] - 1) > 1e-9 || !(S[90] > 0)) return false;
  for (let i = 1; i < S.length; i++) if (S[i] > S[i - 1] + 1e-12) return false;
  return true;
}

/* build 的入口:**驗收通過而且形狀合格才回傳曲線**,否則回 null(inPlay 就走原本的線性)。
   fs 由呼叫端給(跟 loadCompetitionLogos 同一個寫法),這一支才能在測試裡餵假的檔案。 */
export function loadInplayCurve(root, { readFileSync, existsSync, join }) {
  const p = join(root, 'data', 'inplay-tuning.json');
  if (!existsSync(p)) return null;
  let t;
  try { t = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  const S = t?.curve?.S;
  return t?.validation?.passes === true && validCurve(S) ? S : null;
}

/* ── 評分 ─────────────────────────────────────── */
export const rps3 = (p, o) => { const c1 = p[0] - (o === 0 ? 1 : 0), c2 = p[0] + p[1] - (o <= 1 ? 1 : 0); return (c1 * c1 + c2 * c2) / 2; };
export const outcome3 = m => (m.fh > m.fa ? 0 : m.fh === m.fa ? 1 : 2);

/* 每場取 c = from..to 的平均當一場的分數。**同一場的幾十個點互相相關**,獨立的樣本是場,
   所以成對差與 SE 都用場算(inplay-calibration 講過同一件事)。 */
export function scoreMatches(matches, model, { from = 1, to = 90 } = {}) {
  return matches.map(m => {
    const o = outcome3(m);
    let s = 0, n = 0;
    for (let c = from; c <= to; c++) { s += rps3(model(m, c, stateAt(m, c)), o); n++; }
    return s / n;
  });
}

/* b − a:負的代表 b 比較好 */
export function pairedScores(a, b) {
  const n = a.length;
  if (!n || n !== b.length) return null;
  const d = a.map((x, i) => b[i] - x);
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const se = sd / Math.sqrt(n);
  return {
    matches: n,
    a: a.reduce((s, x) => s + x, 0) / n, b: b.reduce((s, x) => s + x, 0) / n,
    diff: mean, se, z: se > 0 ? mean / se : null,
  };
}

/* 落後方專表:有一方落後的檢查點,模型給落後方「最後沒輸」與「最後贏」的機率,對上實際。
   直接回答模型頁那個問題 ——「對落後方是不是太樂觀」。models 是 { 名字: model }。 */
export const TRAIL_BANDS = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75], [76, 89], [90, 90]];
export function trailingTable(matches, models) {
  return TRAIL_BANDS.map(([lo, hi]) => {
    let n = 0, notLose = 0, won = 0;
    const sums = Object.fromEntries(Object.keys(models).map(k => [k, { notLose: 0, win: 0 }]));
    const ms = new Set();
    for (const m of matches) {
      const res = outcome3(m);
      for (let c = lo; c <= hi; c++) {
        const st = stateAt(m, c);
        if (st.hs === st.as) continue;
        const trail = st.hs < st.as ? 0 : 2;
        n++; ms.add(`${m.season}|${m.home}|${m.away}`);
        if (res === trail || res === 1) notLose++;
        if (res === trail) won++;
        for (const [k, model] of Object.entries(models)) {
          const p = model(m, c, st);
          sums[k].notLose += p[trail] + p[1];
          sums[k].win += p[trail];
        }
      }
    }
    return {
      band: `${lo}-${hi}`, points: n, matches: ms.size,
      actual: n ? { notLose: notLose / n, win: won / n } : null,
      models: Object.fromEntries(Object.entries(sums).map(([k, s]) => [k, n ? { notLose: s.notLose / n, win: s.win / n } : null])),
    };
  });
}

/* ── 局面乘數(候選,只量不上線)─────────────────────
   一隊的進球率 = λ × 時間曲線的份額 × m(自己的淨勝球狀態, 時段) × 紅牌。
   區段 k = 1..90 是 (k-1, k] 那一分鐘、k = 91 是下半場補時;狀態取區段開頭那一刻。
   乘數在調參季用最大概似估(對乘數的 Poisson,閉式解 = 進球 ÷ 曝光)。
   它要贏過時間曲線超過 2 個 SE 才有資格進模型 —— 2026-09-25 沒過,這裡每次重跑只為了讓畫面的數字是現跑的。 */
const RED_OWN = 0.72, RED_OPP = 1.30;     // 跟 lib/inplay.mjs 同一組(那裡的常數才是現行模型)
export const stateBucket = d => (d >= 2 ? 'L2' : d === 1 ? 'L1' : d === 0 ? '0' : d === -1 ? 'T1' : 'T2');
export const timeBand = k => (k <= 45 ? 'H1' : k <= 75 ? 'M' : 'Late');
const segShare = S => { const w = []; for (let k = 1; k <= 90; k++) w.push(S[k - 1] - S[k]); w.push(S[90]); return w; };
const inSeg = (g, k) => (k === 91 ? g.extra != null && g.minute === 90 : happened(g, k) && !happened(g, k - 1));

export function fitGameState(matches, S) {
  const w = segShare(S);
  const acc = {};
  for (const m of matches) {
    let hs = 0, as = 0, rh = 0, ra = 0;
    for (let k = 1; k <= 91; k++) {
      const fh = RED_OWN ** rh * RED_OPP ** ra, fa = RED_OWN ** ra * RED_OPP ** rh;
      for (const [side, lam, d, f] of [['h', m.lh, hs - as, fh], ['a', m.la, as - hs, fa]]) {
        const key = `${timeBand(k)}:${stateBucket(d)}`;
        const a = acc[key] ??= { goals: 0, exposure: 0 };
        a.exposure += lam * w[k - 1] * f;
        a.goals += m.goals.filter(g => g.side === side && inSeg(g, k)).length;
      }
      for (const g of m.goals) if (inSeg(g, k)) g.side === 'h' ? hs++ : as++;
      for (const r of m.reds) if (inSeg(r, k)) r.side === 'h' ? rh++ : ra++;
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, {
    goals: a.goals, exposure: a.exposure,
    m: a.exposure > 0 ? a.goals / a.exposure : 1,
    se: a.exposure > 0 ? Math.sqrt(a.goals) / a.exposure : null,
  }]));
}

/* 淨勝球的馬可夫鏈,從終場往回推,拿來算「有局面乘數」時的即時勝率。
   乘數全 1 時它就是時間曲線那一版的精確解(量過:跟 inPlay 的差來自 inPlay 每隊最多再 7 球的截斷)。 */
export function gameStateModel(S, mult) {
  const w = segShare(S);
  const D = 10, N = 2 * D + 1;
  const steps = w.map(x => Math.max(1, Math.ceil(x / 0.0004)));
  const solve = (lh, la, rh, ra) => {
    const fh = RED_OWN ** rh * RED_OPP ** ra, fa = RED_OWN ** ra * RED_OPP ** rh;
    let V = Array.from({ length: N }, (_, i) => { const d = i - D; return d > 0 ? [1, 0, 0] : d === 0 ? [0, 1, 0] : [0, 0, 1]; });
    const table = new Array(92);
    table[91] = V;
    for (let k = 91; k >= 1; k--) {
      const n = steps[k - 1], dw = w[k - 1] / n;
      const ph = new Float64Array(N), pa = new Float64Array(N);
      for (let i = 0; i < N; i++) { const d = i - D; ph[i] = lh * fh * dw * mult(d, k); pa[i] = la * fa * dw * mult(-d, k); }
      for (let s = 0; s < n; s++) {
        const NV = new Array(N);
        for (let i = 0; i < N; i++) {
          const up = V[Math.min(N - 1, i + 1)], dn = V[Math.max(0, i - 1)], cur = V[i], q = 1 - ph[i] - pa[i];
          NV[i] = [q * cur[0] + ph[i] * up[0] + pa[i] * dn[0], q * cur[1] + ph[i] * up[1] + pa[i] * dn[1], q * cur[2] + ph[i] * up[2] + pa[i] * dn[2]];
        }
        V = NV;
      }
      table[k - 1] = V;
    }
    return table;
  };
  const cache = new Map();
  return (m, c, st) => {
    const key = `${m.season}|${m.home}|${m.away}|${st.rh}|${st.ra}`;
    let t = cache.get(key);
    if (!t) { t = solve(m.lh, m.la, st.rh, st.ra); cache.set(key, t); if (cache.size > 4000) cache.clear(); }
    return t[c][Math.max(0, Math.min(N - 1, st.hs - st.as + D))];
  };
}
