/* 盃賽快取的「這一輪要寫哪幾季」—— 抽成純函式,因為它只能用測試守。
 *
 * ── 為什麼會有這一支 ──
 * 抓取器是「整份覆寫」:寫檔時拿這一輪組出來的 seasons 蓋掉整個檔案。
 * 而比賽中那一趟(`--live`)為了省請求,把要看的賽季縮成只有本季 ——
 * 上季根本沒進迴圈,於是被**寫掉了**。2026-09-15 19:04 的排程就是這樣把
 * 聯賽盃 2025-26 的 91 場刪掉的(`cup-details/eflcup/2025-26/` 91 個檔一起消失),
 * 而 `missingSeasons` 是 `[]`:從迴圈的角度看什麼都沒缺,它要的都拿到了。
 * `npm test` 全綠,畫面上只是少了一整季的賽後報告,沒有任何地方報錯。
 *
 * 這是 CLAUDE.md「抓取器整份覆寫,上游一頁沒回就把一筆資料弄丟」的變形:
 * 那一次是**上游**少回一頁,這一次是**我們自己把要看的範圍縮小了** ——
 * 而「這一輪不看」跟「這一季不要了」是兩件完全不同的事。
 *
 * 所以規則兩條,兩條都要:
 *   1. 這一輪沒去看的季(不在 want 裡的),從快取原樣帶過來
 *   2. 帶完之後季數仍比快取少,就是規則 1 出了問題 —— 回報 shrunk,呼叫端整份不寫
 * 第二條是給「以後有人改壞規則 1」準備的:少一季就不寫,資料不會因為一次改壞而消失。
 */

/** @param prev 讀進來的快取(可能是 null) @param fetched 這一輪組出來的季 @param want 這一輪去看的季別 */
export function mergeCupSeasons({ prev, fetched, want }) {
  const seen = new Set(fetched.map(s => s.label));
  /* 只帶「這一輪沒去看的」。去看了卻沒拿到的那些,抓取器自己有保留 old 的路徑
     並且會記進 missingSeasons —— 在這裡再補一次會把「抓失敗」蓋成「一切正常」。 */
  const kept = (prev?.seasons ?? []).filter(s => !want.includes(s.label) && !seen.has(s.label));
  // 由新到舊,不是「這一輪跑到的順序」—— build 與前端都照順序讀第一季當本季
  const seasons = [...fetched, ...kept].sort((a, b) => (a.label < b.label ? 1 : -1));
  const before = prev?.seasons?.length ?? 0;
  return {
    seasons, kept: kept.map(s => s.label),
    shrunk: before > 0 && seasons.length < before ? { before, after: seasons.length } : null,
  };
}
