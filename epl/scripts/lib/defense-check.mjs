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

/* FotMob 身分的產物核對(2026-10-31):fotmobId / FotMob 背號 / FotMob 頭貼只准出現在「逐場跟 Understat 對上」的那一季。
   配錯人的話會把別人的臉掛上去,所以這一條守的是**掛的人都過了核對**,不守掛了幾個(那會隨上游變)。 */
export function identityProductChecks({ players, logs, leaders }) {
  const tol = leaders?.defense?.tolMinutes ?? 90;
  const bad = [];
  for (const p of players.filter(x => x.fotmobId != null)) {
    const rows = (logs?.[p.code] ?? []).filter(r => r.season === p.season);
    const min = rows.reduce((t, r) => t + (r.min ?? 0), 0);
    if (rows.length !== p.games || Math.abs(min - p.minutes) > tol) bad.push(`${p.name} ${p.season}`);
  }
  const orphanShirt = players.filter(p => p.squadNumberSource === 'fotmob' && p.fotmobId == null);
  const orphanPhoto = players.filter(p => p.photoSource === 'FotMob' && p.fotmobId == null);
  const claims = new Map();
  for (const p of players.filter(x => x.fotmobId != null)) { const k = `${p.season}|${p.fotmobId}`; claims.set(k, (claims.get(k) ?? 0) + 1); }
  const dup = [...claims].filter(([, n]) => n > 1).map(([k]) => k);
  const shirtGap = players.some(p => p.squadNumber != null) && (leaders?.missing ?? []).some(x => /^背號/.test(x));
  return [
    { label: 'FotMob 身分:掛了 fotmobId 的人每一季都過了場數與分鐘的核對', ok: bad.length === 0, detail: bad.slice(0, 4).join('、') },
    { label: 'FotMob 身分:FotMob 背號與頭貼只掛在有 fotmobId 的人身上', ok: !orphanShirt.length && !orphanPhoto.length, detail: [...orphanShirt, ...orphanPhoto].slice(0, 3).map(p => p.name).join('、') },
    { label: 'FotMob 身分:同一季沒有兩個人掛同一個 FotMob id', ok: dup.length === 0, detail: dup.slice(0, 3).join('、') },
    { label: 'FotMob 身分:有背號就不准在「沒有」清單裡講沒有背號', ok: !shirtGap, detail: '' },
  ];
}
