/* 德義法的現任教練:FotMob 逐場正式名單的教練欄 × 球隊頁的逐季教練紀錄(2026-10-14 起;2026-11-01 抽成純函式)。
 *
 * 規則:最新一場名單上的教練,球隊頁的紀錄裡也有他才發布(同一個供應商的兩個端點,單一來源,畫面照講)。
 *
 * 代理教練(2026-11-01):德甲 FCB 10-25 名單上是 Aaron Danks、義甲 NAP 10-28 是 Marco Landucci,
 * 前面每一場都是 Kompany / Allegri。只看最後一場就兩隊都不發布。改法只在**球隊頁是那幾場之後抓的**時候成立:
 * 上游有機會記上新人(BMG 一場的看守 Lichte 它就記了)而沒記,而本季紀錄仍掛在前一位名下 →
 * 兩個端點仍然都說是前一位,發布他,並帶出哪幾場是別人坐鎮(戰績不算那幾場)。
 * 球隊頁比那幾場舊的,分不出是代理還是換帥,照舊不發布(抓取器會提早重抓那一頁,見 coachRefetchReason)。
 *
 *   ms:這一隊有名單教練的場次,依日期排好({ date, lineups: { [code]: { coach } } })
 *   page:球隊頁快取那一隊({ fetchedAt, coachHistory: [{ name, season }] })
 *   回 { skip } 或 { name, run, standIn }:run 是他最後一段連續帶隊的場次(含之前),standIn 是 null 或 { names, dates } */
export function resolveLineupCoach({ ms, code, page, curSeason, same }) {
  const hist = page?.coachHistory ?? [];
  const inHist = n => hist.some(h => same(h.name, n));
  const coachAt = k => ms[k].lineups[code].coach;
  let last = ms.length - 1;
  let name = coachAt(last), standIn = null;
  if (!inHist(name)) {
    let k = last;
    while (k >= 0 && !inHist(coachAt(k))) k--;
    const prevName = k >= 0 ? coachAt(k) : null;
    const after = ms.slice(k + 1);
    const pageAfter = Date.parse(page?.fetchedAt ?? '') > Date.parse(after.at(-1).date);
    const curOk = prevName != null && hist.some(h => same(h.name, prevName) && h.season === curSeason);
    if (!pageAfter || !curOk) {
      const why = !page?.coachHistoryFull ? '(球隊頁的教練紀錄是截短版)' : pageAfter ? '' : '(球隊頁是那之前抓的)';
      return { skip: `名單是 ${name},球隊頁的逐季紀錄沒有他${why}` };
    }
    standIn = { names: [...new Set(after.map((_, j) => coachAt(k + 1 + j)))], dates: after.map(m => String(m.date).slice(0, 10)) };
    name = prevName;
    last = k;
  }
  let i = last;
  while (i > 0 && same(coachAt(i - 1), name)) i--;
  return { name, run: ms.slice(i, last + 1), fromStart: i === 0, lastMatch: ms[last].date, standIn };
}
