/* 背號回填。
 *
 * FPL 快照的 squad_number 有 533/599 是空的。缺的那 66 人在球員頁、球員表與
 * 陣容表上都是「—」,而背號其實拿得到 —— 只是散在兩個我們已經有的地方:
 *
 *   1. **英超官方名單**(pulselive)。每一份先發/替補名單都帶背號,
 *      而且是**零額外請求** —— 那些 fixture 既有排程本來就在抓。
 *      這是官方自己公布的,可信度高於任何第三方。
 *   2. **FotMob 人工交付**(data/manual/fotmob-squad-numbers.json)。
 *      協作方查的,沒有第二來源背書。
 *
 * 優先序 FPL > 官方 > FotMob,但**只填空的**:
 * FPL 已經有值就不覆蓋。理由是覆蓋要先確定「這兩筆講的是同一個人」,
 * 而球員對照本身就是靠名字猜的 —— 對照配錯時,覆蓋會把一個對的號碼換成錯的,
 * 留空只是繼續空著。實際跑出來只有一筆衝突(TOT:Moore FPL#21 / 官方#47),
 * 一筆不足以判斷是官方換號還是我們配錯人,所以印出來讓人看,不自動改。
 *
 * 兩個來源都有值的人拿來當**交叉核對**用(鐵則五):對不上的一律不採用。
 */

/* 從官方名單抽 code → 背號。同一人在不同場次背號不一致的話兩邊都丟掉 ——
   那表示我們把兩個人對照成同一個 code 了,填哪一個都可能是錯的。 */
export function shirtsFromOfficial(offLineups) {
  const seen = new Map(), bad = new Set();
  const walk = side => {
    for (const x of [...(side?.xi ?? []), ...(side?.subs ?? [])]) {
      if (!x.code || x.shirt == null) continue;
      if (seen.has(x.code) && seen.get(x.code) !== x.shirt) bad.add(x.code);
      seen.set(x.code, x.shirt);
    }
  };
  for (const m of Object.values(offLineups?.matches ?? {})) { walk(m.home); walk(m.away); }
  for (const c of bad) seen.delete(c);
  return { shirts: seen, unstable: [...bad] };
}

/* FotMob 交付的是「隊碼 + 我方顯示名」,不是 code。對回球員庫時要求
   同隊同名**唯一**一位,對到兩位就不採用 —— 配錯背號比留空更糟。 */
export function shirtsFromManual(manual, players) {
  const shirts = new Map(), ambiguous = [];
  for (const [key, row] of manual?.hit ?? []) {
    const [team, query] = key.split('|');
    const cand = players.filter(p => p.team === team && p.name === query);
    if (cand.length !== 1) { ambiguous.push(`${team}:${query}(${cand.length} 位同名)`); continue; }
    shirts.set(cand[0].code, row.squadNumber);
  }
  return { shirts, ambiguous };
}

/* 就地回填,回傳這次做了什麼 —— build 要印出來,測試要驗。 */
export function backfillSquadNumbers(players, { official, manual }) {
  const agree = [], disagree = [], conflicts = [];
  // 兩個第三方來源互相核對
  for (const [code, n] of manual ?? []) {
    if (!official?.has(code)) continue;
    (official.get(code) === n ? agree : disagree).push(code);
  }
  const rejected = new Set(disagree);

  let fromOfficial = 0, fromManual = 0;
  for (const p of players) {
    if (p.squadNumber != null) {
      const o = official?.get(p.code);
      if (o != null && o !== p.squadNumber) conflicts.push({ code: p.code, team: p.team, name: p.name, fpl: p.squadNumber, official: o });
      continue;
    }
    if (rejected.has(p.code)) continue;                    // 兩個來源打架的不填
    if (official?.has(p.code)) { p.squadNumber = official.get(p.code); p.squadNumberSource = 'official'; fromOfficial++; continue; }
    if (manual?.has(p.code)) { p.squadNumber = manual.get(p.code); p.squadNumberSource = 'fotmob'; fromManual++; }
  }
  return { fromOfficial, fromManual, agree: agree.length, disagree, conflicts };
}
