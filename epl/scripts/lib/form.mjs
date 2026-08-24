// 近期狀況與交手紀錄。
//
// 結論先講:這三個特徵**沒有進模型**,係數是 0。不是懶得接,是量過了沒用。
//
// 量法(可重跑:npm run tune:form):
//   1. 挑係數只用 2024-25,驗收用完全沒參與挑選的 2025-26 —— 同一批資料
//      又調又驗,挑出來的一定是雜訊。
//   2. 驗收賽季上最好的一組只贏基準 RPS 0.00013,而成對比較的標準誤是
//      0.00025 —— 改善連一個標準誤都不到,bootstrap p ≈ 0.29。
//   3. 更直接的證據:把特徵拿去跟「模型算錯的部分」(殘差)求相關,
//      760 場全部落在 r = ±0.07 以內,沒有一個達到顯著;而且「近期勝點差」
//      的相關係數在兩季之間從 -0.072 翻到 +0.004 —— 這是雜訊的長相。
//
// 為什麼會這樣,事後看其實合理:
//   球隊強弱本來就在 Dixon-Coles 的 att/def 與 Elo 裡了。近五場的波動扣掉
//   自己的長期水準之後,剩下的多半真的只是運氣。交手紀錄更是 ——
//   三年前那場「歷屆對戰」的兩隊人早就換光了。
//
// 那為什麼還留著這個檔案:
//   算出來的東西**要給人看**(近五戰、歷屆交手是讀者要的資訊),
//   只是不拿去動預測。adjustLambdas 的係數留在 0,哪天有更多賽季的資料
//   重跑 tune:form,如果真的量出效果再打開 —— 到那時也會有數字可以交代。
//
// 鐵則:每個函式都只看 before 之前的比賽。這樣回測才不會偷看未來。

const pointsFor = (m, code) => {
  const gf = m.home === code ? m.fh : m.fa;
  const ga = m.home === code ? m.fa : m.fh;
  return gf > ga ? 3 : gf === ga ? 1 : 0;
};

/* 把比賽依隊伍索引起來,回測時每一輪都重算會很慢 —— 建一次索引重複用。 */
export function buildFormIndex(matches) {
  const byTeam = new Map();
  const byPair = new Map();
  const played = matches.filter(m => m.played && m.fh != null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const m of played) {
    for (const code of [m.home, m.away]) {
      if (!byTeam.has(code)) byTeam.set(code, []);
      byTeam.get(code).push(m);
    }
    // 交手紀錄不分主客,兩隊排序後當鍵
    const key = [m.home, m.away].sort().join('|');
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(m);
  }
  return { byTeam, byPair };
}

const before = (list, date) => (list ?? []).filter(m => m.date < date);

/* 近期狀況:最近 n 場的場均勝點,減掉同一隊較長期的場均勝點。
   為什麼要相減 —— 直接用「最近五場拿幾分」會把「這隊很強」也算進去,
   而強弱 Poisson 與 Elo 已經知道了,重複算沒有意義。
   相減之後留下的才是「相對於自己的水準,最近是超常還是失常」。
   回傳範圍大約 -2 ~ +2(場均勝點的差)。 */
export function formDelta(index, code, date, { short = 5, long = 20 } = {}) {
  const list = before(index.byTeam.get(code), date);
  if (list.length < short + 3) return 0;          // 樣本太少就沒有意見
  const recent = list.slice(-short);
  const base = list.slice(-Math.min(long, list.length));
  const ppg = ms => ms.reduce((a, m) => a + pointsFor(m, code), 0) / ms.length;
  return ppg(recent) - ppg(base);
}

/* 近期進球狀況:同樣是「相對自己」的差。
   分開算進球與失球,因為 λ 是分開的 —— 一隊可能最近進球變多但也失更多。 */
export function goalForm(index, code, date, { short = 5, long = 20 } = {}) {
  const list = before(index.byTeam.get(code), date);
  if (list.length < short + 3) return { gf: 0, ga: 0 };
  const gfOf = m => (m.home === code ? m.fh : m.fa);
  const gaOf = m => (m.home === code ? m.fa : m.fh);
  const avg = (ms, f) => ms.reduce((a, m) => a + f(m), 0) / ms.length;
  const recent = list.slice(-short);
  const base = list.slice(-Math.min(long, list.length));
  return {
    gf: avg(recent, gfOf) - avg(base, gfOf),
    ga: avg(recent, gaOf) - avg(base, gaOf),
  };
}

/* 歷屆交手:這兩隊過去 k 次碰頭,主隊的場均淨勝球。
   刻意不加時間衰減 —— 先用最單純的版本測,有用再談要不要加權。
   沒交手過(升班馬)回 0。 */
export function h2hDelta(index, home, away, date, { k = 6 } = {}) {
  const key = [home, away].sort().join('|');
  const list = before(index.byPair.get(key), date);
  if (!list.length) return { gd: 0, n: 0 };
  const recent = list.slice(-k);
  const gd = recent.reduce((a, m) => {
    const h = m.home === home ? m.fh - m.fa : m.fa - m.fh;
    return a + h;
  }, 0) / recent.length;
  return { gd, n: recent.length };
}

/* 把三個特徵組成一場比賽的調整量。
   係數由回測決定 —— 全部給 0 就等於完全不調整(基準線)。 */
export function adjustLambdas({ lh, la }, feats, coef) {
  const { formH = 0, formA = 0, gfH = 0, gfA = 0, gaH = 0, gaA = 0, h2h = 0 } = feats;
  const { bForm = 0, bGoal = 0, bH2h = 0 } = coef;
  // 自己最近進球多 → λ 調高;對手最近失球多 → λ 也調高
  const adjH = bForm * formH + bGoal * (gfH - gaA) + bH2h * h2h;
  const adjA = bForm * formA + bGoal * (gfA - gaH) - bH2h * h2h;
  return { lh: lh * Math.exp(adjH), la: la * Math.exp(adjA) };
}

/* 一場比賽的完整特徵包。回測與 build 都用這個,確保兩邊算的是同一件事。 */
export function matchFeatures(index, home, away, date) {
  const gH = goalForm(index, home, date), gA = goalForm(index, away, date);
  const h = h2hDelta(index, home, away, date);
  return {
    formH: formDelta(index, home, date),
    formA: formDelta(index, away, date),
    gfH: gH.gf, gaH: gH.ga,
    gfA: gA.gf, gaA: gA.ga,
    h2h: h.gd, h2hN: h.n,
  };
}

/* 走查回測量出來的係數。全 0 = 不調整。
   要改這裡的值,先跑 npm run tune:form 並把驗收賽季的數字貼進 data/form-tuning.json,
   不要憑感覺填。 */
export const TUNED = { bForm: 0, bGoal: 0, bH2h: 0 };

/* 近五戰(給人看的,不進模型)。
   回傳最近 n 場的對手、主客、比分與勝負,新的在前面。 */
export function recentForm(index, code, date, n = 5) {
  const list = before(index.byTeam.get(code), date).slice(-n).reverse();
  return list.map(m => {
    const home = m.home === code;
    const gf = home ? m.fh : m.fa, ga = home ? m.fa : m.fh;
    return {
      date: m.date, season: m.season, opp: home ? m.away : m.home,
      venue: home ? 'H' : 'A', gf, ga,
      res: gf > ga ? 'W' : gf === ga ? 'D' : 'L',
    };
  });
}

/* 近五戰的彙總:幾勝幾和幾負、進失球、場均勝點。 */
export function formSummary(rows) {
  const s = { games: rows.length, w: 0, d: 0, l: 0, gf: 0, ga: 0 };
  for (const r of rows) {
    s[r.res === 'W' ? 'w' : r.res === 'D' ? 'd' : 'l']++;
    s.gf += r.gf; s.ga += r.ga;
  }
  s.pts = s.w * 3 + s.d;
  s.ppg = rows.length ? s.pts / rows.length : 0;
  return s;
}
