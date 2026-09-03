/* 即時勝率的歷史累積。
 *
 * inPlay 每 2 分鐘算一次 1X2,但算完就丟 —— 這裡把 (分鐘, 主/和/客, 比分) 存下來,
 * 才畫得出「勝率隨比賽變化」的曲線。比賽日的迴圈每次 build 都會經過這裡。
 *
 * 幾個刻意的決定:
 *
 * - **一分鐘最多一個點,留最新的。** 迴圈每 2 分鐘跑一次,但 FPL 的 minute
 *   在中場會停在 45 —— 不去重的話中場休息會累積一疊同分鐘的點。
 * - **第一個點是賽前機率(第 0 分)。** 曲線要從「開賽前模型怎麼看」開始,
 *   不然開賽第一個樣本可能已經是第 6 分鐘,前面是空的。
 * - **完賽補一個收斂點然後封存(done)。** inPlay 在 finished 時自然收斂成
 *   實際結果(勝方 1.0);封存之後不再追加,免得賽後的重跑一直疊點。
 * - **重播(demo)不累積。** 那是過去賽季的示範,混進來會污染本季的歷史。
 * - **換季就重開。** 跨季的鍵(season|home|away)不會撞,但檔案會無限長大;
 *   一季約 380 場 × ~50 點,足夠而且有界。
 *
 * 儲存形狀(緊湊陣列,一點 ~30 bytes):
 *   { season, matches: { "home|away": { pts: [[min,h,d,a,hs,as],...], done } } }
 */
import { round } from './util.mjs';

export function appendSamples(store, liveOut, { now = Date.now() } = {}) {
  if (!liveOut?.available || liveOut.demo) return store ?? null;
  const season = liveOut.season;
  let s = store;
  if (!s || s.season !== season) s = { season, matches: {} };

  for (const m of liveOut.matches ?? []) {
    if (!m.started) continue;
    const key = `${m.home}|${m.away}`;
    const rec = s.matches[key] ?? (s.matches[key] = { pts: [], done: false });
    if (rec.done) continue;

    // 賽前錨點:曲線的第 0 分是模型的賽前機率
    if (!rec.pts.length && m.preMatch) {
      rec.pts.push([0, m.preMatch.home, m.preMatch.draw, m.preMatch.away, 0, 0]);
      /* 賽前 xG(2026-09-03 補):跟 1X2 同一刻凍結。只對**之後**的比賽有效 —— 之前的場次沒存,
         就是沒有,呼叫端顯示「—」,不拿賽後重算的 λ 回填。 */
      if (Number.isFinite(m.preMatch.xgHome) && Number.isFinite(m.preMatch.xgAway)) {
        rec.pre = { xgHome: round(m.preMatch.xgHome, 2), xgAway: round(m.preMatch.xgAway, 2) };
      }
    }

    const p = m.inplay;
    if (!p) continue;
    const min = m.finished ? Math.max(90, p.minute ?? 90) : (p.minute ?? null);
    if (min == null || min <= 0) continue;
    const sample = [min, round(p.home, 4), round(p.draw, 4), round(p.away, 4), m.hs ?? 0, m.as ?? 0];

    const last = rec.pts.at(-1);
    if (last && last[0] === min) rec.pts[rec.pts.length - 1] = sample;   // 同分鐘留最新
    else if (!last || min > last[0]) rec.pts.push(sample);               // 只往前,不倒退

    if (m.finished) rec.done = true;
  }
  return s;
}

/* 已完賽場次的**賽前機率快照**。
 *
 * 這是本檔案唯一有資格回答「這場開賽前模型怎麼看」的東西 —— 第 0 分那個點
 * 是開賽前存下來的,之後不會被覆寫(pts 只往前、done 之後不再追加)。
 *
 * 為什麼需要它:build 的模型擬合在「歷史 + 本季已完賽」上,**含這一場**。
 * 拿那組機率掛到已完賽的比賽上,再標成「賽前模型」,是用看過結果的模型
 * 冒充當時的預測 —— Elo 更是逐場更新的,那場的比分直接進了參數。
 * 西甲與英冠的 build 從一開始就拒絕這樣做(prediction: m.played ? null : ...),
 * 英超那一份沒有,2026-09-01 補上。
 *
 * 走查回測的逐場預測(backtest-matches.json)是另一個合格來源,但它只涵蓋
 * **已經跑完的賽季**;本季一場都沒有,所以本季只能靠這份快照。
 *
 * 沒有快照就回不到,呼叫端要照實顯示「無快照」,不要拿事後模型補。 */
export function preMatchSnapshots(store) {
  const out = new Map();
  for (const [key, rec] of Object.entries(store?.matches ?? {})) {
    const first = rec.pts?.[0];
    if (!first || first[0] !== 0) continue;      // 第一點不是第 0 分 = 沒接到賽前錨點
    out.set(key, { home: first[1], draw: first[2], away: first[3], xgHome: rec.pre?.xgHome ?? null, xgAway: rec.pre?.xgAway ?? null });
  }
  return out;
}

/* 給前端的形狀:只給有內容的場次(>= 3 個點才畫得成曲線)。 */
export function historyForSite(store) {
  if (!store) return { season: null, matches: {} };
  const out = {};
  for (const [k, rec] of Object.entries(store.matches ?? {})) {
    if ((rec.pts?.length ?? 0) >= 3) out[k] = { pts: rec.pts, done: !!rec.done };
  }
  return { season: store.season, matches: out };
}
