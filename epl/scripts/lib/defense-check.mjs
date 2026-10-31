/* 防守數據的產物核對(2026-10-31):西甲與德義法共用一份 —— 各寫一份的話,改了一邊另一邊會悄悄過期
   (「修好一份、忘了另一份複本」那條坑)。回傳 { label, ok, detail } 的陣列,由各自的測試印。

   查的是**本站自己算的東西**對不對得起來,不查涵蓋率高低(那會隨上游變,當紅線就是「把目標達成寫成 CI 紅線」):
   - 每一個給了 defense 的人,都能從 player-logs 重算回來,也都過了場次與分鐘的核對;
   - leaders.defense 的逐季計數對得回 players.json;
   - 有防守數據就不准在「沒有」清單裡講沒有;
   - 球員列表(列表頁讀它)帶著同一份。 */
export function defenseProductChecks({ players, logs, leaders, playersList }) {
  const bad = [];
  const tol = leaders?.defense?.tolMinutes ?? 90;
  for (const p of players.filter(x => x.defense)) {
    const rows = (logs?.[p.code] ?? []).filter(r => r.season === p.season);
    const sum = k => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
    const min = sum('min');
    if (rows.length !== p.games || Math.abs(min - p.minutes) > tol || p.defense.minutes !== min
      || p.defense.tackles !== sum('tackles') || p.defense.interceptions !== sum('interceptions')) bad.push(`${p.name} ${p.season}`);
  }
  const counts = Object.entries(leaders?.defense?.seasons ?? {})
    .filter(([s, c]) => c.published !== players.filter(x => x.season === s && x.defense).length);
  return [
    { label: '防守產物:每一個給了的人都從逐場紀錄重算得回來、也都過了場次與分鐘的核對', ok: bad.length === 0, detail: bad.slice(0, 4).join('、') },
    { label: '防守產物:leaders.defense 的逐季涵蓋對得回 players.json', ok: !!leaders?.defense && counts.length === 0, detail: counts.map(([s]) => s).join('、') },
    { label: '防守產物:有給就不准在「沒有」清單裡講沒有防守數據', ok: !(leaders?.missing ?? []).some(x => /防守/.test(x)) === !!leaders?.defense, detail: '' },
    { label: '防守產物:球員列表帶著同一份(列表頁的欄位讀它)', ok: playersList.filter(x => x.defense).length === players.filter(x => x.defense).length, detail: '' },
  ];
}
