/* 歷來交手的不變量(測試用;2026-09-26)。

   英冠與德義法的 build 原本寫 `if (r?.matches?.length)`,而 `headToHead` 回的是 `{ games, aWin, draw, bWin, …, list }`
   —— **沒有 matches**,條件永遠不成立,h2h.json 整份是 `{}`。單場頁對每一場都印
   「以來沒有在這個聯賽交手過(多半是剛升上來的球隊)」,拜仁對多特也一樣。不拋錯、畫面完全正常。

   守三件事:
   一、不是空的 —— results.json 裡本季球隊之間只要有一組碰過面,就不可以是空的;
   二、每一組自己加得起來(勝 + 和 + 負 = 場數 = list 的筆數),鍵是排序過的兩隊(前端用 `[h, a].sort().join('|')` 查);
   三、results.json 涵蓋的賽季裡,每一組本季球隊的交手,list 裡一場不多、一場不少(只算聯賽;英冠的升級附加賽不算)。
   第三條拿 results.json 當對照組 —— 它跟 h2h 的交手池不是同一份程式組出來的,掛錯鍵或漏季都會對不上。 */
export function h2hIssues({ h2h, results, fixtures, currentSeason }) {
  const issues = [];
  const cur = new Set(fixtures.filter(f => f.season === currentSeason).flatMap(f => [f.home, f.away]));
  const seasons = new Set(results.map(m => m.season));
  const want = new Map();
  for (const m of results) {
    if (!m.played || m.stage || !cur.has(m.home) || !cur.has(m.away)) continue;
    const k = [m.home, m.away].sort().join('|');
    want.set(k, (want.get(k) ?? 0) + 1);
  }
  const keys = Object.keys(h2h ?? {});
  if (want.size && !keys.length) issues.push(`h2h 是空的,而 results.json 裡本季球隊之間有 ${want.size} 組碰過面`);
  for (const k of keys) {
    const r = h2h[k];
    if (k !== k.split('|').sort().join('|')) issues.push(`${k}:鍵沒有排序(前端查不到)`);
    if (r.games !== r.list?.length || r.aWin + r.draw + r.bWin !== r.games) issues.push(`${k}:勝和負、場數與 list 對不上`);
  }
  for (const [k, n] of want) {
    const got = (h2h?.[k]?.list ?? []).filter(x => seasons.has(x.season)).length;
    if (got !== n) issues.push(`${k}:results.json 的 ${[...seasons].sort().join('、')} 交手 ${n} 場,歷來交手裡是 ${got} 場`);
  }
  return { issues, pairs: keys.length, expected: want.size };
}
