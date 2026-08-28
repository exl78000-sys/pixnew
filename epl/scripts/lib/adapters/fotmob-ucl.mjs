/* Adapter:FotMob 人工交付的歐冠檔 → 本站可用的兩件東西。
 *
 * 這份檔案是**協作方交付**的,所以照鐵則五:自己回報「檢查全過」不算數,
 * 一定要拿獨立來源逐場核對。這裡的獨立來源就是已經在倉庫裡的
 * football-data.org 快取(`data/raw/football-data/ucl-*.json`)——
 * 兩邊是完全不同的供應商,對得起來才採用。
 *
 * 實測結果(2026-08-28,兩季 378 場):
 *   隊名對照   36 / 36 隊(兩季都是)
 *   逐場對照   189 / 189(日期 + 主客完全一致,沒有一場主客顛倒)
 *   比分       **0 場不一致**
 *
 * ── 一個差點下錯的結論,記在這裡 ──
 *
 * FotMob 的比賽網址長成 `/matches/{甲}-vs-{乙}/...`,看起來像「甲是主隊」。
 * 但拿 football-data 對照之後發現:**網址的順序只有一半的時候對得上主客**
 * (2024-25:35 對 / 36 反),而 `home` / `away` 欄位是 **136 場全對、0 場反**。
 * 也就是說 **slug 不是主客的依據,欄位才是**。
 * 我一開始是照 slug 推的,推出「這份檔案的主客有一半是錯的」——
 * 那個結論是錯的,而且會讓整份資料被誤判成不能用。
 *
 * ── 2026-27 只有這一個來源 ──
 *
 * football-data.org 對 2026-27 回 404(還沒建立),所以那一季**沒有第二個來源**
 * 可以核對。能做的只有結構自洽:144 場、36 隊、每隊 4 主 4 客、
 * 8 個不重複對手、沒有重複對戰。這些是瑞士制聯賽階段的硬性條件,
 * 抽籤資料壞掉的話這幾條會破。畫面上要講明「這一季只有一個來源」。
 *
 * 而且那一季**沒有開球時間也沒有輪次**:144 場的 kickoffUtc 全部是同一個
 * 佔位值 2026-09-08T19:00:00Z、roundName 全是 null。
 * 所以只呈現「誰對誰、誰主誰客」,**不顯示日期與輪次** —— 那兩樣我們沒有。
 */

const STOP = new Set(['fc', 'cf', 'sc', 'ac', 'as', 'ss', 'afc', 'bsc', 'gnk', 'vfb', 'sk', 'fk',
  'nk', 'rb', 'club', 'de', 'sad', 'ssc', 'ca', 'cd', 'sl', 'pae', 'sfp', 'kv', '1909', 'united',
  'fotball', 'ag', '1899']);

/* 隊名 token 化。k→c 與 ph→f 是實際踩到的兩組拼法差異
   (Olympiacos / Olympiakos、Pafos / Paphos),不是為了寬鬆而寬鬆。
   PSV 刻意**不列進 STOP**:football-data 那邊整個隊名就叫 "PSV",
   當成停用詞的話 token 會變成空的,那一隊就永遠對不上。 */
export function nameTokens(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o').replace(/k/g, 'c').replace(/ph/g, 'f')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(t => t && !STOP.has(t));
}

const pairScore = (a, b) => {
  const A = new Set(nameTokens(a)), B = new Set(nameTokens(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const t of A) if (B.has(t)) n++;
  return n ? (n * 2) / (A.size + B.size) : 0;
};

/* 兩邊都可能給多種寫法(全名與簡稱),取最好的一組。
   **少了這一步就會漏掉整隊。** 實際踩到:football-data 的 Inter 全名是
   "FC Internazionale Milano"、Brest 是 "Stade Brestois 29",
   跟 FotMob 的 "Inter" / "Brest" 一個共同 token 都沒有 ——
   只比全名的話這兩隊永遠對不上,而且錯法是安靜的:那一隊的 10 場
   會被記成「隊名對不上」,交叉核對就整份不通過。簡稱才是橋。 */
const overlap = (a, b) => {
  const A = Array.isArray(a) ? a : [a];
  const B = Array.isArray(b) ? b : [b];
  let best = 0;
  for (const x of A) for (const y of B) { const s = pairScore(x, y); if (s > best) best = s; }
  return best;
};

/* 兩份名單互相配對。**只採用「互為第一名」的組合** ——
   單向最佳會讓兩個 FotMob 隊搶同一個 football-data 隊,
   而那種情況一定有一個是錯的(盃賽的 AFC Liverpool 就是這樣差點上線)。 */
export function bridgeTeams(fotmobTeams, fdTeams) {
  const bestOf = (from, to) => {
    const out = new Map();
    for (const [id, name] of from) {
      let bs = 0, bid = null;
      for (const [oid, oname] of to) { const s = overlap(name, oname); if (s > bs) { bs = s; bid = oid; } }
      out.set(id, { bid, bs });
    }
    return out;
  };
  const fwd = bestOf(fotmobTeams, fdTeams);
  const rev = bestOf(fdTeams, fotmobTeams);
  const map = new Map(), unmatched = [];
  for (const [fid, { bid, bs }] of fwd) {
    if (bid != null && bs > 0 && rev.get(bid)?.bid === fid) map.set(fid, bid);
    else {
      const nameOf = v => (Array.isArray(v) ? v[0] : v);
      unmatched.push({ fotmob: nameOf(fotmobTeams.get(fid)),
        best: bid != null ? nameOf(fdTeams.get(bid)) : null, score: Number(bs.toFixed(2)) });
    }
  }
  return { map, unmatched };
}

/* 逐場核對。回傳的東西要能讓畫面講實話,所以連「對了幾場」都帶出去。
   任何一場比分或主客對不上,採用與否交給呼叫端決定 —— 這裡不自己吞掉。 */
export function crossCheck(fmMatches, fdMatches) {
  const fmTeams = new Map(), fdTeams = new Map();
  for (const m of fmMatches) for (const s of ['home', 'away']) fmTeams.set(m[s].id, m[s].name);
  // 全名與簡稱都收 —— 見 overlap() 上面那段註解
  for (const m of fdMatches) for (const s of ['homeTeam', 'awayTeam']) {
    fdTeams.set(m[s].id, [m[s].name, m[s].shortName].filter(Boolean));
  }
  const { map, unmatched } = bridgeTeams(fmTeams, fdTeams);

  const fdKey = new Map();
  for (const m of fdMatches) fdKey.set(`${m.utcDate.slice(0, 10)}|${m.homeTeam.id}|${m.awayTeam.id}`, m);

  let aligned = 0;
  const problems = [];
  for (const m of fmMatches) {
    const h = map.get(m.home.id), a = map.get(m.away.id);
    if (h == null || a == null) {
      problems.push({ kind: 'team', text: `${m.home.name} vs ${m.away.name} 隊名對不上` });
      continue;
    }
    const fdm = fdKey.get(`${m.date}|${h}|${a}`);
    if (!fdm) {
      // 主客顛倒要單獨報 —— 那是「方向錯」,跟「找不到這一場」是兩件事
      const flip = fdKey.get(`${m.date}|${a}|${h}`);
      problems.push({ kind: flip ? 'orientation' : 'missing',
        text: `${m.date} ${m.home.name} vs ${m.away.name}${flip ? '(主客相反)' : '(對照來源沒有這一場)'}` });
      continue;
    }
    aligned++;
    const sc = m.status?.score;
    if (!sc) continue;
    // PK 場的比分要用 regular + et,fullTime 是含 PK 的累加值
    const reg = fdm.score.duration === 'PENALTY_SHOOTOUT'
      ? [(fdm.score.regularTime?.home ?? 0) + (fdm.score.extraTime?.home ?? 0),
        (fdm.score.regularTime?.away ?? 0) + (fdm.score.extraTime?.away ?? 0)]
      : [fdm.score.fullTime.home, fdm.score.fullTime.away];
    if (sc.home !== reg[0] || sc.away !== reg[1]) {
      problems.push({ kind: 'score', text: `${m.date} ${m.home.name} ${sc.home}-${sc.away} ≠ ${reg.join('-')}` });
    }
  }
  return { teamsMatched: map.size, teamsTotal: fmTeams.size, unmatched, aligned, total: fmMatches.length, problems };
}

/* 只有抽籤、還沒開賽的那一季。結構自洽檢查 ——
   瑞士制聯賽階段的硬性條件,壞掉的話這幾條會破。 */
export function checkDraw(matches) {
  const home = new Map(), away = new Map(), opps = new Map(), pairs = new Map();
  for (const m of matches) {
    home.set(m.home.id, (home.get(m.home.id) ?? 0) + 1);
    away.set(m.away.id, (away.get(m.away.id) ?? 0) + 1);
    for (const [a, b] of [[m.home.id, m.away.id], [m.away.id, m.home.id]]) {
      if (!opps.has(a)) opps.set(a, []);
      opps.get(a).push(b);
    }
    const k = [m.home.id, m.away.id].sort((x, y) => x - y).join('-');
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const counts = [...opps.values()];
  return {
    matches: matches.length,
    teams: opps.size,
    homePerTeam: [...new Set(home.values())].sort((a, b) => a - b),
    awayPerTeam: [...new Set(away.values())].sort((a, b) => a - b),
    playedPerTeam: [...new Set(counts.map(v => v.length))].sort((a, b) => a - b),
    distinctOpponents: [...new Set(counts.map(v => new Set(v).size))].sort((a, b) => a - b),
    repeatedPairs: [...pairs.values()].filter(v => v > 1).length,
    duplicateIds: matches.length - new Set(matches.map(m => m.matchId)).size,
  };
}

export const drawIsSane = c => c.homePerTeam.length === 1 && c.awayPerTeam.length === 1
  && c.homePerTeam[0] === c.awayPerTeam[0]
  && c.playedPerTeam.length === 1 && c.distinctOpponents.length === 1
  && c.playedPerTeam[0] === c.distinctOpponents[0]
  && c.playedPerTeam[0] === c.homePerTeam[0] * 2
  && c.repeatedPairs === 0 && c.duplicateIds === 0;

/* 球員榜。FotMob 給的是**統計榜的母體**,不是全體報名名單
   (檔案自己的 notes 就這樣寫)—— 所以涵蓋率要標在畫面上,不能當成完整名單。
   每個類別只留前 N 名:整份 879 人 × 17 類搬進前端沒有意義,單檔版也會胖一圈。 */
export const LEADER_CATEGORIES = [
  { key: 'goals', zh: '進球', unit: '球' },
  { key: 'goal_assist', zh: '助攻', unit: '次' },
  { key: 'expected_goals', zh: '預期進球 xG', unit: '', dp: 2 },
  { key: 'total_att_assist', zh: '創造機會', unit: '次' },
  { key: 'rating', zh: 'FotMob 評分', unit: '', dp: 2 },
  { key: 'saves', zh: '每 90 分鐘撲救', unit: '', dp: 2 },
];

export function buildLeaders(players, { limit = 12 } = {}) {
  const out = [];
  for (const c of LEADER_CATEGORIES) {
    const rows = players
      .filter(p => Number.isFinite(p.stats?.[c.key]?.value))
      .map(p => ({
        name: p.name, team: p.teamName, teamId: p.teamId,
        value: p.stats[c.key].value,
        minutes: p.stats[c.key].minutesPlayed ?? null,
        matches: p.stats[c.key].matchesPlayed ?? null,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
    if (rows.length) out.push({ ...c, rows, pool: players.filter(p => Number.isFinite(p.stats?.[c.key]?.value)).length });
  }
  return out;
}
