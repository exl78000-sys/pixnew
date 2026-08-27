/* 足球知識層:把「傳統慣例」跟「本站實際資料」擺在一起。
 *
 * 這一頁是全站唯一一頁大部分內容不是算出來的 —— 陣型優劣、背號意義、位置分工
 * 都是足球共識,不是本站的統計。所以做法刻意分成兩層:
 *
 *   共識層  data/manual/football-knowledge.json —— 人工整理,逐條帶來源網址
 *   資料層  這個檔 —— 從本站既有的 players / tactics 算出來的實際分佈
 *
 * **兩層在畫面上必須分得出來。** 把共識寫成看起來像統計的樣子,
 * 就是這個專案第一條鐵則在擋的事。
 *
 * 這裡只算「真的算得出來」的東西:
 *   · 每個背號實際上是什麼位置的人在穿(母體與涵蓋率一起報)
 *   · 每個陣型實際被用了多少分鐘、幾隊用過
 * 算不出來的(某個陣型「造成」什麼結果)一律不做 ——
 * 球隊實力跟陣型選擇是綁在一起的,那個因果本站沒有辦法拆開。
 */
import { round } from './util.mjs';

/* 位置代碼兩個聯賽不同:英超是 FPL 的 GK/DEF/MID/FWD,
   西甲是供應商的 GK/D/M/F。統一成四類再比,不然兩張表沒辦法並排看。 */
const POS_CANON = {
  GK: 'GK', G: 'GK',
  DEF: 'DEF', D: 'DEF', DF: 'DEF',
  MID: 'MID', M: 'MID', MF: 'MID',
  FWD: 'FWD', F: 'FWD', FW: 'FWD',
};
export const POS_ZH = { GK: '門將', DEF: '後衛', MID: '中場', FWD: '前鋒' };
export const POS_ORDER = ['GK', 'DEF', 'MID', 'FWD'];

/* players: [{ squadNumber, pos }]。回傳每個號碼的位置分佈 + 母體說明。

   **母體要報清楚**:沒有背號的、沒有位置的都不能算進去,
   但要說有多少人因此被排除 —— 不然讀者會把 243 人的分佈當成 357 人的。 */
export function numberProfile(players, { maxNumber = 26 } = {}) {
  const total = players.length;
  const withNumber = players.filter(p => p.squadNumber != null);
  const usable = withNumber.filter(p => POS_CANON[p.pos]);
  const byNumber = new Map();
  for (const p of usable) {
    const n = p.squadNumber;
    if (!Number.isInteger(n) || n < 1 || n > maxNumber) continue;
    if (!byNumber.has(n)) byNumber.set(n, { n, total: 0, counts: { GK: 0, DEF: 0, MID: 0, FWD: 0 } });
    const row = byNumber.get(n);
    row.total++;
    row.counts[POS_CANON[p.pos]]++;
  }
  const rows = [...byNumber.values()].sort((a, b) => a.n - b.n).map(r => {
    const [topPos, topN] = POS_ORDER
      .map(k => [k, r.counts[k]])
      .sort((a, b) => b[1] - a[1])[0];
    return { ...r, topPos, topShare: round(topN / r.total, 3) };
  });
  return {
    rows,
    coverage: {
      players: total,
      withNumber: withNumber.length,
      withNumberAndPos: usable.length,
      // 位置沒給的人不能算進分佈 —— 這個數字要印在畫面上
      droppedNoPos: withNumber.length - usable.length,
    },
  };
}

/* tactics: [{ code, formation: { list: [{ name, minutes, share }] } }]
   回傳每個陣型的實際使用量。**只報使用量,不報成績** ——
   「用這個陣型的球隊 xG 比較高」講的是球隊,不是陣型。 */
export function formationUsage(tactics) {
  const by = new Map();
  let totalMinutes = 0;
  for (const t of tactics) {
    for (const f of t.formation?.list ?? []) {
      if (!f.name || !f.minutes) continue;
      if (!by.has(f.name)) by.set(f.name, { label: f.name, minutes: 0, teams: [] });
      const row = by.get(f.name);
      row.minutes += f.minutes;
      row.teams.push({ code: t.code, minutes: f.minutes, share: f.share });
      totalMinutes += f.minutes;
    }
  }
  const rows = [...by.values()]
    .sort((a, b) => b.minutes - a.minutes)
    .map(r => ({
      label: r.label,
      minutes: r.minutes,
      share: round(r.minutes / totalMinutes, 4),
      teamCount: r.teams.length,
      // 用最多的三隊,讀者才知道這個陣型是誰在用
      topTeams: r.teams.sort((a, b) => b.minutes - a.minutes).slice(0, 3)
        .map(x => ({ code: x.code, share: x.share })),
    }));
  return { rows, totalMinutes };
}

/* 傳統說法 vs 實際分佈的對照。
   traditional 是共識層那 12 條;這裡只判斷「實際最多的位置」跟傳統講的是不是同一類,
   **不下「傳統過時了」這種結論** —— 位置分類本身是上游給的,
   而多數來源把邊鋒歸在中場,光這一點就會讓 7 / 11 看起來「不再是前鋒」。 */
export function traditionVsData(numbers, profile) {
  const byN = new Map(profile.rows.map(r => [r.n, r]));
  return numbers.map(t => {
    const d = byN.get(t.n) ?? null;
    return {
      n: t.n,
      traditional: t.zh,
      traditionalEn: t.en,
      variant: t.variant === true,
      actual: d
        ? { total: d.total, topPos: d.topPos, topShare: d.topShare, counts: d.counts }
        : null,
    };
  });
}

/* 正式名單裡實際用過的陣型。英超只有本季 10 場的官方名單(20 份),
   西甲則有上季逐場的使用分鐘 —— 兩者的粒度不同,所以回傳時要帶 unit,
   畫面才講得出「這個數字是怎麼來的」。 */
export function formationFromLineups(officialMatches) {
  const counts = new Map();
  let total = 0;
  for (const m of Object.values(officialMatches ?? {})) {
    for (const side of ['home', 'away']) {
      const f = m?.[side]?.formation;
      if (!f) continue;
      counts.set(f, (counts.get(f) ?? 0) + 1);
      total++;
    }
  }
  if (!total) return null;
  return {
    unit: 'lineups',
    total,
    rows: [...counts.entries()].sort((a, b) => b[1] - a[1])
      .map(([label, n]) => ({ label, count: n, share: round(n / total, 4) })),
  };
}

/* 把 formationUsage 的輸出對齊成同一個形狀,前端就只要畫一種表。 */
export function usageAsRows(usage) {
  if (!usage?.rows?.length) return null;
  return {
    unit: 'minutes',
    total: usage.totalMinutes,
    rows: usage.rows.map(r => ({
      label: r.label, count: r.minutes, share: r.share,
      teamCount: r.teamCount, topTeams: r.topTeams,
    })),
  };
}
