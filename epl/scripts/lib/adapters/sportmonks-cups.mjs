/* Adapter:SportMonks 盃賽 fixture → 本站 canonical 盃賽場次。
 *
 * 三件實測出來、跟直覺不一樣的事(2026-08-28 探測,結果存 data/raw/probes/en-cups.json):
 *
 * 1. **輪次名在 `stage.name`,不在 `round.name`。**
 *    round.name 實際回的是 "1" 這種純數字,有些場次根本沒有 round;
 *    stage.name 才是 "Preliminary Round" / "Round 1" / "Quarterfinals" / "Final"。
 *    抓錯欄位的話整頁會變成一堆「第 1 輪」的散場比賽,骨架整個沒了。
 *
 * 2. **比分是一個陣列,每筆帶 description 與 participant_id。**
 *    實際見過:CURRENT / 1ST_HALF / 2ND_HALF / 2ND_HALF_ONLY / PENALTY_SHOOTOUT。
 *    要用 participants[].meta.location 把 participant_id 對回主客,
 *    不能假設陣列順序就是主客。
 *
 * 3. **延長賽沒有自己的 description。** 判斷方式是 CURRENT 與 2ND_HALF 不一樣 ——
 *    2ND_HALF 是 90 分鐘結束時的比分,CURRENT 是最終比分。
 *    另外 state.state 會給 FT / FT_PEN / AET 這類代碼當佐證。
 *
 * 沒見過的 description 一律不給語意:原樣收進 unknownDescriptions,
 * 由呼叫端報出來,測試有一條守著(比照進球事件子代碼的做法)。
 */

/* 已經在**實際資料裡**見過、而且知道語意的 description。
   前五個是第一輪探測看到的;後三個是第一次實抓才出現的 ——
   探測只取樣了每季 3 場,而那 3 場都沒打延長。
   **這正是白名單的價值**:沒見過的不給語意、由 log 報出來,
   所以延長賽這件事是被發現的,不是被猜到的。 */
export const KNOWN_SCORE_DESCRIPTIONS = new Set([
  'CURRENT',            // 最終比分(打完延長賽的話就是延長後的)
  '1ST_HALF',           // 上半場結束時
  '2ND_HALF',           // 90 分鐘結束時
  '2ND_HALF_ONLY',      // 只算下半場進的球(累計比分用不到,但會出現)
  'PENALTY_SHOOTOUT',   // PK 大戰
  'ET',                 // 延長賽結束時(實抓才出現)
  'ET_1ST_HALF',        // 延長賽上半
  'ET_2ND_HALF',        // 延長賽下半
]);

// state.state 的代碼。CANCELLED / ABANDONED 是實抓才出現的完整寫法 ——
// 原本我寫的 CANCL / ABAN 是猜的,實際資料裡沒有那兩個。
export const KNOWN_STATES = new Set([
  'FT', 'FT_PEN', 'AET', 'NS', 'LIVE', 'HT', 'INPLAY_1ST_HALF', 'INPLAY_2ND_HALF',
  'POSTP', 'CANCELLED', 'ABANDONED', 'TBA', 'DELAYED', 'INT', 'AWARDED', 'WO', 'SUSPENDED',
]);

/* 盃賽的隊名比對:**只認完全相同的名字**。
 *
 * 實測踩到的坑(2026-08-28):teams.mjs 的 loose() 會把開頭的 AFC / FC 拿掉,
 * 於是這四支變成兩個 key ——
 *
 *   Liverpool        id 8      Round 3 起(英超那支)
 *   AFC Liverpool    id 19711  資格賽前置輪(第九級的另一支球隊)
 *   AFC Bournemouth  id 52     Round 3
 *   Bournemouth FC   id 19571  資格賽前置輪
 *
 * loose 在只有 20 隊的聯賽裡很好用;在有 745 隊的盃賽裡它會製造**假的對應**,
 * 而且錯得很像真的 —— 把一支第九級球隊的資格賽顯示成利物浦的足總盃征程。
 *
 * 所以這裡只做大小寫與空白的正規化,不動 AFC/FC。
 * loose 會中、exact 不中的名字一律記進 nearMisses 由人核對,不自動採用 ——
 * 少對到一支只是少一個隊徽,對錯一支是在講一件假的事。
 */
const exactKey = name => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function buildCupTeamIndex(teams) {
  const index = new Map();
  for (const t of teams) {
    for (const n of [t.en, t.of, t.fpl, ...(t.alias ?? []), ...(t.cupAlias ?? [])]) {
      if (n) index.set(exactKey(n), t.code);
    }
  }
  return name => index.get(exactKey(name)) ?? null;
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

/* 把 scores 陣列攤成 { [description]: { home, away } }。
   participant_id 對主客靠 participants[].meta.location —— 陣列順序不保證。 */
function scoreMap(fixture) {
  const side = new Map();
  for (const p of fixture.participants ?? []) {
    const loc = p?.meta?.location;
    if (loc === 'home' || loc === 'away') side.set(p.id, loc);
  }
  const out = {};
  const unknown = new Set();
  for (const s of fixture.scores ?? []) {
    const d = s?.description;
    if (!d) continue;
    if (!KNOWN_SCORE_DESCRIPTIONS.has(d)) unknown.add(d);
    const loc = side.get(s.participant_id);
    if (!loc) continue;
    // score 有時是 { goals, participant } 有時直接是數字,兩種都吃
    const goals = num(s.score?.goals ?? s.score);
    if (goals == null) continue;
    (out[d] ??= { home: null, away: null })[loc] = goals;
  }
  return { byDescription: out, unknown: [...unknown] };
}

const pair = entry => (entry && entry.home != null && entry.away != null ? [entry.home, entry.away] : null);

export function normaliseCupFixture(fixture, { codeOf }) {
  const { byDescription, unknown } = scoreMap(fixture);
  const teams = {};
  for (const p of fixture.participants ?? []) {
    const loc = p?.meta?.location;
    if (loc !== 'home' && loc !== 'away') continue;
    const name = p.name ?? null;
    teams[loc] = {
      name,
      // 盃賽有數百支球隊,本站只認得英超那些。認不得的**只給名字**,
      // 不編隊碼也不掛隊徽(鐵則三)。codeOf 必須是**嚴格比對版**,
      // 見上面 buildCupTeamIndex 的註解 —— 用寬鬆比對會對錯球隊。
      code: name ? codeOf(name) : null,
      sourceId: p.id ?? null,
    };
  }

  const ht = pair(byDescription['1ST_HALF']);
  const ft90 = pair(byDescription['2ND_HALF']);
  const final = pair(byDescription.CURRENT);
  const pens = pair(byDescription.PENALTY_SHOOTOUT);
  const state = fixture.state?.state ?? null;

  /* 延長賽有兩個判準,兩個都留著而且**互相對照**:
       直接:有 ET 這筆比分 → 打過延長(實抓才發現有這個 description)
       推導:CURRENT ≠ 2ND_HALF → 90 分之後還有進球
     正常情況兩者應該一致。不一致代表上游的比分不完整(例如延長賽 0-0),
     所以兩個都存下來,由呼叫端比對並報出差異 —— 不要只留一個然後假裝沒事。 */
  const et = pair(byDescription.ET);
  const aetDirect = et != null;
  const aetDerived = final && ft90 ? (final[0] !== ft90[0] || final[1] !== ft90[1]) : null;
  const aet = aetDirect ? true : aetDerived;

  return {
    id: fixture.id ?? null,
    stage: fixture.stage?.name ?? null,
    stageId: fixture.stage_id ?? null,
    round: fixture.round?.name ?? null,
    leg: fixture.leg ?? null,
    kickoff: fixture.starting_at ? `${String(fixture.starting_at).replace(' ', 'T')}Z` : null,
    home: teams.home ?? null,
    away: teams.away ?? null,
    ht, ft90, et, final, pens,
    aet, aetDirect, aetDerived,
    state,
    stateKnown: state ? KNOWN_STATES.has(state) : null,
    resultInfo: fixture.result_info ?? null,
    played: final != null,
    unknownDescriptions: unknown,
  };
}
