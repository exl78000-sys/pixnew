// Adapter:pulselive(英超官網後端)→ 官方陣型、正式先發、現任教練
//
// 定位:官方公布的事實。凡是這裡拿得到的,一律蓋掉我們自己推導的結果 ——
// 推導是「沒有官方資料時的替代品」,不是跟官方並列的另一種說法。
//
// 資料由 scripts/fetch-official.mjs 在有外網的環境抓好寫成 JSON,
// 這一支只負責讀檔與轉成上層要的形狀。抓不到就回 null,上層自動退回推導。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'pulselive';
export const label = '英超官方(pulselive)';
export const supports = ['formations', 'lineups', 'coaches'];

const FILE = root => join(root, 'data', 'raw', 'pulselive', 'official.json');

export function loadOfficial(root) {
  const f = FILE(root);
  if (!existsSync(f)) return null;
  try {
    const s = JSON.parse(readFileSync(f, 'utf8'));
    return s && s.matches ? s : null;
  } catch { return null; }
}

/* 每場比賽的官方陣型與正式先發,key 是 `主隊|客隊`(一季內唯一)。 */
export function officialLineups(root) {
  const s = loadOfficial(root);
  if (!s) return null;
  const out = {};
  for (const [key, m] of Object.entries(s.matches)) {
    if (!m.home?.xi?.length || !m.away?.xi?.length) continue;
    out[key] = {
      fixtureId: m.fixtureId, kickoff: m.kickoff, final: Boolean(m.final),
      // rows 是官方的每一排有誰,別漏掉 —— 少了它陣容圖只能退回 FPL 粗類分排
      home: { formation: m.home.formation, rows: m.home.rows ?? null, xi: m.home.xi, subs: m.home.subs },
      away: { formation: m.away.formation, rows: m.away.rows ?? null, xi: m.away.xi, subs: m.away.subs },
      /* 進球事件。fetch-official 已經用「比分變了就是進球」抓出來,所以不看型別、
         烏龍球也在裡面。這裡不丟掉 teamId 以外的任何欄位 —— 得分方一律看 side,
         那是由比分差算出來的,teamId 的語意實測不明確,不要拿它判隊。 */
      goals: (m.goals ?? []).map(g => ({
        side: g.side, min: g.min, label: g.label, phase: g.phase,
        kind: g.kind, person: g.person, assist: g.assist, hs: g.hs, as: g.as,
      })),
      /* 牌、換人與半場標記。進球不在這裡(它有自己的判定方式),
         畫面上要組完整時間軸時把兩者合起來排序。 */
      timeline: m.timeline ?? null,
      clock: m.clock ?? null,
    };
  }
  return { asOf: s.fetchedAt, season: s.season?.label ?? null, matches: out };
}

/* 每隊的官方陣型使用紀錄 → 本季最常用的那個就是「官方標準陣型」。
   注意:回傳的 games 是「有官方陣型的場次數」,不是球隊踢了幾場 ——
   前端要標示樣本數,不能讓 1 場的結論看起來跟 10 場一樣可靠。 */
export function officialFormations(root) {
  const s = loadOfficial(root);
  if (!s) return null;
  const by = new Map();
  const push = (code, formation, key, isHome, kickoff) => {
    if (!code || !formation) return;
    if (!by.has(code)) by.set(code, []);
    by.get(code).push({ formation, match: key, home: isHome, kickoff });
  };
  for (const [key, m] of Object.entries(s.matches)) {
    const [home, away] = key.split('|');
    push(home, m.home?.formation, key, true, m.kickoff);
    push(away, m.away?.formation, key, false, m.kickoff);
  }

  const out = {};
  for (const [code, list] of by) {
    const counts = {};
    for (const g of list) counts[g.formation] = (counts[g.formation] ?? 0) + 1;
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    // 最近一場優先當「目前陣型」的判斷依據之一,但主陣型仍以出現次數為準
    const recent = [...list].sort((a, b) => String(b.kickoff ?? '').localeCompare(String(a.kickoff ?? '')))[0];
    out[code] = {
      formation: ranked[0][0],
      games: list.length,
      used: ranked.map(([f, n]) => ({ formation: f, games: n })),
      latest: recent ? { formation: recent.formation, match: recent.match, kickoff: recent.kickoff } : null,
    };
  }
  return { asOf: s.fetchedAt, season: s.season?.label ?? null, teams: out };
}

/* 官方現任教練。人工維護的 coaches.json 有戰術註解,不能直接覆蓋 ——
   這裡只回報官方是誰,由上層決定怎麼標示不一致。 */
export function officialManagers(root) {
  const s = loadOfficial(root);
  if (!s || !s.managers || !Object.keys(s.managers).length) return null;
  return { asOf: s.managersFetchedAt ?? s.fetchedAt, managers: s.managers };
}

/* ── 官方名單 → 我們的球員 ────────────────────
   官方給「顯示名 + 背號」,我們的球員庫是 FPL 的 code,得對起來。

   背號看起來是最好的鍵,但 FPL 快照的 squadNumber 目前全是 null,所以實務上靠名字。
   而名字不能直接比:官方寫 "Gabriel Magalhães",FPL 的 fullName 是
   "Gabriel dos Santos Magalhães"、web name 只有 "Gabriel" —— 三種寫法沒有一種相等。

   所以改成比對「詞」:官方名字的最後一個詞(姓)必須出現在我方的名字詞集裡,
   其餘的詞每中一個加分,取分數最高且唯一的那一位。姓對不上就不算 ——
   同隊有三個 Gabriel 時,寧可對不上也不要配錯人。
   對不上的不丟掉:保留官方名字照樣畫得出來,只是沒有頭貼與球員頁連結。 */
const POS = { G: 'GK', D: 'DEF', M: 'MID', F: 'FWD' };
const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z]/g, '');
const tokens = s => String(s ?? '').split(/[\s.]+/).map(norm).filter(Boolean);

export function attachCodes(lineups, players) {
  if (!lineups) return null;
  const byTeam = new Map();
  for (const p of players) {
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push({ p, words: new Set([...tokens(p.fullName), ...tokens(p.name)]) });
  }

  let matched = 0, missed = 0, rowsOk = 0, rowsFail = 0;
  const missedNames = [];
  const findOne = (code, official) => {
    const squad = byTeam.get(code);
    if (!squad) return null;
    if (official.shirt != null) {
      const byShirt = squad.filter(x => x.p.squadNumber === official.shirt);
      if (byShirt.length === 1) return byShirt[0].p;
    }
    const t = tokens(official.name);
    if (!t.length) return null;
    const surname = t[t.length - 1];
    let best = null, bestScore = 0, tied = false;
    for (const cand of squad) {
      if (!cand.words.has(surname)) continue;              // 姓對不上就不考慮
      const score = t.reduce((n, w) => n + (cand.words.has(w) ? 1 : 0), 0);
      if (score > bestScore) { best = cand.p; bestScore = score; tied = false; }
      else if (score === bestScore && best) tied = true;
    }
    return tied ? null : best;                              // 分不出高下就不猜
  };

  const fix = (code, list) => (list ?? []).map(x => {
    const hit = findOne(code, x);
    if (hit) matched++; else { missed++; if (x.name) missedNames.push(`${code}:${x.name}`); }
    return { ...x, code: hit?.code ?? null, pos: POS[x.pos] ?? hit?.pos ?? 'MID', posRaw: x.pos ?? null };
  });

  // 官方的 formation.players 是「每一排有誰」的 id 陣列 —— 這才是真正的站位。
  // 有了它就不用再拿 FPL 的四個粗類去湊,4-1-4-1 才不會被畫成 4-4-2。
  // 對不齊(有人查不到、人數不等於 11)就回 null,前端自動退回舊畫法。
  const resolveRows = side => {
    if (!Array.isArray(side.rows) || !side.rows.length) return null;
    const byId = new Map(side.xi.filter(p => p.id != null).map(p => [p.id, p]));
    const rows = side.rows.map(r => r.map(id => byId.get(id)).filter(Boolean));
    const total = rows.reduce((n, r) => n + r.length, 0);
    if (total !== side.xi.length) { rowsFail++; return null; }
    rowsOk++;
    return rows;
  };

  const out = {};
  for (const [key, m] of Object.entries(lineups.matches)) {
    const [home, away] = key.split('|');
    const side = (code, s) => {
      const withCodes = { ...s, xi: fix(code, s.xi), subs: fix(code, s.subs) };
      return { ...withCodes, rows: resolveRows(withCodes) };
    };
    const H = side(home, m.home), A = side(away, m.away);
    out[key] = { ...m, home: H, away: A,
      goals: namedGoals(m.goals, H, A, home, away),
      timeline: namedTimeline(m.timeline, H, A, home, away) };
  }
  return { ...lineups, matches: out,
    matchStats: { matched, missed, missedNames: missedNames.slice(0, 20), rowsOk, rowsFail } };
}

/* 牌與換人的 personId 換成名字,並且**用名單反查是哪一隊** ——
   跟進球那裡一樣不看 teamId。這裡 teamId 其實沒有烏龍球那種語意問題,
   但用同一套查法比較不會有人改了一邊忘了另一邊。

   **換人不配對「誰換誰」。** 官方事件流沒有欄位把 ON 與 OFF 連起來,
   而同一分鐘同一隊可以換兩人(實測 FUL vs CHE 第 65 分,四筆事件時間完全相同)。
   照相鄰順序配對就是猜,配錯人比不配對糟得多。所以只給「第幾分、哪一隊、誰上、誰下」。

   名單裡查不到的人(例如教練吃牌)保留 person 原碼、team 給 null,
   由畫面決定要不要顯示 —— 不要因為查不到就丟掉一筆真的發生過的事。 */
export function namedTimeline(timeline, H, A, homeCode, awayCode) {
  if (!timeline) return null;
  const who = new Map();
  for (const [code, s] of [[homeCode, H], [awayCode, A]]) {
    for (const p of [...(s.xi ?? []), ...(s.subs ?? [])]) {
      if (p.id != null) who.set(p.id, { name: p.name, code: p.code ?? null, team: code });
    }
  }
  const name = e => {
    const w = e.person != null ? who.get(e.person) ?? null : null;
    return {
      min: e.min, label: e.label, phase: e.phase ?? null,
      player: w?.name ?? null, playerCode: w?.code ?? null, team: w?.team ?? null,
      person: e.person ?? null,          // 查不到時還原得回去
    };
  };
  return {
    cards: (timeline.cards ?? []).map(e => ({ ...name(e), kind: e.kind ?? null, kindRaw: e.kindRaw ?? null })),
    subs: (timeline.subs ?? []).map(e => ({ ...name(e), dir: e.dir ?? null, dirRaw: e.dirRaw ?? null })),
    periods: (timeline.periods ?? []).map(e => ({ type: e.type, min: e.min, label: e.label, phase: e.phase ?? null })),
  };
}

/* 進球事件裡的 personId 換成看得懂的名字與我們的球員 code。

   查表要**跨兩隊一起查**:烏龍球的踢球者在失球那一隊的名單裡,
   只查得分方會查成 null。得分方由 side 決定(比分差算出來的),
   踢球者屬於哪一隊則另外標,兩件事不要混在一起。

   kind 是官方 event 的 description 子代碼。目前只認三種:
   G 一般、P 十二碼、O 烏龍球 —— O 已用名單核對過(踢進的人在對方名單裡)。
   沒見過的代碼一律留 null,不要憑空補一個對照。 */
const GOAL_KIND = { G: null, P: 'penalty', O: 'own' };

export function namedGoals(goals, H, A, homeCode, awayCode) {
  if (!Array.isArray(goals) || !goals.length) return [];
  const who = new Map();
  for (const [code, s] of [[homeCode, H], [awayCode, A]]) {
    for (const p of [...(s.xi ?? []), ...(s.subs ?? [])]) {
      if (p.id != null) who.set(p.id, { name: p.name, code: p.code ?? null, team: code });
    }
  }
  return goals.map(g => {
    const scorer = g.person != null ? who.get(g.person) ?? null : null;
    const assist = g.assist != null ? who.get(g.assist) ?? null : null;
    const forCode = g.side === 'H' ? homeCode : awayCode;
    return {
      min: g.min, label: g.label, phase: g.phase ?? null,
      team: forCode,                                   // 這球算給誰
      kind: GOAL_KIND[g.kind] ?? null,                 // 認得的才給,其餘 null
      kindRaw: g.kind ?? null,                         // 留原碼,將來要再分類時有跡可循
      scorer: scorer?.name ?? null, scorerCode: scorer?.code ?? null,
      scorerTeam: scorer?.team ?? null,                // 烏龍球時會等於失球那一隊
      assist: assist?.name ?? null, assistCode: assist?.code ?? null,
      hs: g.hs, as: g.as,
    };
  });
}
