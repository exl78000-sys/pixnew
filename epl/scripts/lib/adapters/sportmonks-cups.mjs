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

// 已經在實際資料裡見過、而且知道語意的 description。多一種就要先核對過才加。
export const KNOWN_SCORE_DESCRIPTIONS = new Set([
  'CURRENT',            // 最終比分(打完延長賽的話就是延長後的)
  '1ST_HALF',           // 上半場結束時
  '2ND_HALF',           // 90 分鐘結束時
  '2ND_HALF_ONLY',      // 只算下半場進的球(累計比分用不到,但會出現)
  'PENALTY_SHOOTOUT',   // PK 大戰
]);

// state.state 的代碼。同樣只認見過的,其餘原樣保留。
export const KNOWN_STATES = new Set(['FT', 'FT_PEN', 'AET', 'NS', 'LIVE', 'HT', 'POSTP', 'CANCL', 'ABAN', 'TBA', 'DELAYED', 'INT', 'AWARDED', 'WO']);

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
      // 盃賽有一百多支球隊,本站只認得英超那 20 支。
      // 認不得的**只給名字**,不編隊碼也不掛隊徽(鐵則三:不要留假的欄位)。
      code: name ? codeOf(name) : null,
      sourceId: p.id ?? null,
    };
  }

  const ht = pair(byDescription['1ST_HALF']);
  const ft90 = pair(byDescription['2ND_HALF']);
  const final = pair(byDescription.CURRENT);
  const pens = pair(byDescription.PENALTY_SHOOTOUT);
  const state = fixture.state?.state ?? null;

  /* 延長賽:CURRENT 跟 2ND_HALF 不同就是打過延長。
     只有兩者都在才判斷 —— 少一邊就回 null(不知道),不要回 false(沒打過)。 */
  const aet = final && ft90 ? (final[0] !== ft90[0] || final[1] !== ft90[1]) : null;

  return {
    id: fixture.id ?? null,
    stage: fixture.stage?.name ?? null,
    stageId: fixture.stage_id ?? null,
    round: fixture.round?.name ?? null,
    leg: fixture.leg ?? null,
    kickoff: fixture.starting_at ? `${String(fixture.starting_at).replace(' ', 'T')}Z` : null,
    home: teams.home ?? null,
    away: teams.away ?? null,
    ht, ft90, final, pens,
    aet,
    state,
    stateKnown: state ? KNOWN_STATES.has(state) : null,
    resultInfo: fixture.result_info ?? null,
    played: final != null,
    unknownDescriptions: unknown,
  };
}
