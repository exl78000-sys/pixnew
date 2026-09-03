/* 「我的預測」的計分。**純函式、零依賴**,所以 npm test 直接 import 得動 ——
 * 這一層會出的錯是「比較的兩邊不是同一批比賽」,那種錯掃原始碼掃不出來。
 *
 * 兩件刻意的事:
 *
 * 1. **比較一律在同一批場次上做。** 你猜了 30 場、模型每場都有機率、市場只有
 *    12 場有盤口 —— 拿「你 30 場的命中率」去比「市場 12 場的命中率」是拿兩批
 *    不同的比賽在比,那個數字沒有意義。所以總表分成兩組:
 *    `vsModel`(你與模型都有的場次)與 `vsAll`(三邊都有的場次)。
 * 2. **模型與市場的機率是預測當下凍結的那一份**,存在紀錄裡,不是現在重算的。
 *    build 的模型擬合含已完賽的比賽,事後重算等於讓模型看過答案再猜
 *    (這個專案已經為了同一件事修過一次:prediction / postFit 那次)。
 */

export const OUTCOMES = ['home', 'draw', 'away'];

export const outcomeOf = (fh, fa) => (fh > fa ? 'home' : fh === fa ? 'draw' : 'away');

// 機率分布 → 它最看好的那一邊。平手時取前面的(home > draw > away),決定性優先
export function pickOf(probs) {
  if (!probs) return null;
  let best = null;
  for (const k of OUTCOMES) {
    const v = Number(probs[k]);
    if (!Number.isFinite(v)) continue;
    if (best === null || v > Number(probs[best])) best = k;
  }
  return best;
}

/* Ranked Probability Score(越低越好)。站上模型頁用的是同一個指標,
   所以三邊放在一起是可比的 —— 但**你的預測會被當成 100% 押一邊**
   (你給的是斷言不是機率),那對你不利,畫面上要講明。 */
export function rps(probs, actual) {
  if (!probs) return null;
  let cumP = 0, cumO = 0, sum = 0;
  for (let i = 0; i < OUTCOMES.length - 1; i++) {
    cumP += Number(probs[OUTCOMES[i]]) || 0;
    cumO += OUTCOMES[i] === actual ? 1 : 0;
    sum += (cumP - cumO) ** 2;
  }
  return sum / (OUTCOMES.length - 1);
}

const certain = pick => (pick ? Object.fromEntries(OUTCOMES.map(k => [k, k === pick ? 1 : 0])) : null);

export const matchKey = f => `${f.season}|${f.home}|${f.away}`;

/* 一筆紀錄能不能算分。**開賽後才存的不算** —— 那不是預測,是回顧。
   頁面本來就在開賽時鎖住輸入,這裡是第二道:匯入別人的檔案也擋得住。 */
export function isEligible(rec) {
  if (!rec?.pick) return false;
  if (!rec.savedAt || !rec.kickoff) return true;    // 沒有時間資訊就不判(舊紀錄)
  const saved = Date.parse(rec.savedAt), ko = Date.parse(rec.kickoff);
  if (!Number.isFinite(saved) || !Number.isFinite(ko)) return true;
  return saved < ko;
}

/* records: { 'season|home|away': rec },fixtures: 該聯賽的賽程陣列。
   回傳逐場明細 + 兩組總計。 */
export function scorePredictions(records, fixtures) {
  const byKey = new Map((fixtures ?? []).map(f => [matchKey(f), f]));
  const rows = [];
  for (const [key, rec] of Object.entries(records ?? {})) {
    const f = byKey.get(key);
    if (!f) continue;                       // 賽程換季或改期,對不到就不算
    const eligible = isEligible(rec);
    const actual = f.played ? outcomeOf(f.fh, f.fa) : null;
    const modelPick = pickOf(rec.model);
    const marketPick = pickOf(rec.market);
    rows.push({
      key, fixture: f, rec, eligible, actual,
      modelPick, marketPick,
      youHit: actual ? rec.pick === actual : null,
      modelHit: actual && modelPick ? modelPick === actual : null,
      marketHit: actual && marketPick ? marketPick === actual : null,
      exact: actual && rec.fh != null && rec.fa != null
        ? Number(rec.fh) === f.fh && Number(rec.fa) === f.fa : null,
      youRps: actual ? rps(certain(rec.pick), actual) : null,
      modelRps: actual ? rps(rec.model, actual) : null,
      marketRps: actual ? rps(rec.market, actual) : null,
    });
  }
  rows.sort((a, b) => String(a.fixture.kickoff ?? a.fixture.date ?? '')
    .localeCompare(String(b.fixture.kickoff ?? b.fixture.date ?? '')));

  const scored = rows.filter(r => r.eligible && r.actual);
  const tally = subset => {
    if (!subset.length) return null;
    const avg = sel => {
      const vals = subset.map(sel).filter(v => Number.isFinite(v));
      return vals.length === subset.length && vals.length
        ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    /* 命中率也要「整批都有才算」。市場盤口不是每場都抓得到,而 `null` 被
       當成「沒猜中」的話,一批完全沒有盤口的比賽會印出「市場 0.0%」——
       那不是市場猜錯,是根本沒有市場。**沒有資料要顯示成沒有,不是 0。**
       (這個專案在 docs:check 上踩過同一種錯:0 是一個看起來很像答案的數字。) */
    const pct = sel => {
      const vals = subset.map(sel);
      return vals.every(v => v === true || v === false)
        ? vals.filter(Boolean).length / vals.length : null;
    };
    return {
      n: subset.length,
      you: pct(r => r.youHit), model: pct(r => r.modelHit), market: pct(r => r.marketHit),
      youRps: avg(r => r.youRps), modelRps: avg(r => r.modelRps), marketRps: avg(r => r.marketRps),
    };
  };
  const withExact = scored.filter(r => r.exact !== null);
  return {
    rows,
    pending: rows.filter(r => !r.actual).length,
    ignored: rows.filter(r => !r.eligible).length,
    /* 你自己的成績,不跟任何人比。**歐冠用得到**:盃賽沒有勝率預測
       (模型是用聯賽調的,沒在盃賽上驗收過 —— 鐵則二),所以那裡沒有對手。
       沒有這一欄的話,歐冠的預測踢完之後畫面上什麼都不會出現。 */
    solo: tally(scored),
    // 你與模型都有的場次(模型每場都有,所以這通常等於全部已完賽的預測)
    vsModel: tally(scored.filter(r => r.modelPick)),
    // 三邊都有的場次 —— 市場盤口不是每場都抓得到
    vsAll: tally(scored.filter(r => r.modelPick && r.marketPick)),
    exact: withExact.length
      ? { n: withExact.length, hit: withExact.filter(r => r.exact).length }
      : null,
  };
}
