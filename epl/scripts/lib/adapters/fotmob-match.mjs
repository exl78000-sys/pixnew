/* FotMob 的 matchDetails → 本站的 canonical match detail。
 *
 * 2026-09-03 SportMonks 方案取消之後,西甲賽後報告的替代來源。
 * **`buildProviderMatchReport` 一行都不用改** —— 它吃的是供應商中立的 detail,
 * SportMonks 與 API-Football 各有一個 adapter 轉成它,這是第三個。
 *
 * 欄位是**探測出來的,不是猜的**(`probe-laliga-postmatch.mjs`,2026-09-03 實測
 * ALA 3-0 GET)。兩個「照名字猜就會錯」的地方:
 *
 * 1. **Tackles 的 key 是 `matchstats.headers.tackles`**,不是 `tackles` ——
 *    同一組裡 interceptions / recoveries / clearances 都是乾淨的 key,只有它是
 *    i18n 字串。猜 `tackles` 會拿到 0,而 0 看起來很像答案。
 * 2. **事件的 `homeScore` / `awayScore` 對不上比分**(73 分那顆進球寫 0:0,
 *    終場 3-0)。那個欄位的語意沒驗證過,所以**判哪一隊進的不用它**,
 *    用 `isHome`(烏龍球再反過來),再由 `goalEvidence` 拿最終比分核對 ——
 *    對不上就整份不覆寫球員統計,那是既有的守門。
 *
 * 烏龍球**不掛射手**:FotMob 的 `isHome` 指的是踢進的人屬於哪一隊,
 * 而得分的是對面。球隊計數要算、射手不指名 —— 配錯人比不配對糟。
 */

/* 對映表的版本。**改了欄位對映就要 +1** —— 快取存的是轉換後的 detail,
   舊資料不會自己跟著變。抓取器比對版本,不同就重抓那幾場(受每次請求上限
   節制,不會一次全打)。沒有這個的話得記得手動 --force,而「記得」不是機制。 */
export const ADAPTER_VERSION = 2;

const numOrNull = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/* FotMob 的 positionId → 本站四類。原本住在 build-laliga.mjs,
   賽後報告也要用,所以抽到這裡兩邊共用(複製一份的話會悄悄漂移)。 */
/* 回的是**單字母** G/D/M/F —— 那是 canonical detail 的約定,
   `postmatch-report.mjs` 的 `pos()` 再把它換成 GK/DEF/MID/FWD。
   這裡直接回 'GK' 的話,官方陣容產物會跟著變(實測 official.json 的
   每個 pos 都會改寫),而且下游會對照不到。原封不動從 build-laliga 搬過來。 */
export const fotmobPos = id => {
  const n = Number(id);
  if (n === 11) return 'G';
  if (n >= 30 && n < 50) return 'D';
  if (n >= 70 && n < 100) return 'M';
  if (n >= 100) return 'F';
  return '?';
};

export const fotmobPlayer = p => ({
  providerId: p.providerId ?? p.id ?? null,
  name: p.name ?? '',
  number: p.shirt ?? p.shirtNumber ?? null,
  pos: fotmobPos(p.positionId),
  rating: p.rating ?? p.performance?.rating ?? null,
  photo: null,
  verticalLayout: p.verticalLayout ?? null,
});

/* 先發 → 球場圖的排。用 verticalLayout.y 分組(同一排 y 相同),排內按 x 排。
   湊不齊 11 人或只有一排就回 null —— 畫一張排錯的陣型圖比不畫糟。 */
export function fotmobRows(players) {
  const groups = new Map();
  for (const p of players) {
    const y = Number(p.verticalLayout?.y);
    const key = Number.isFinite(y) ? y.toFixed(3) : `pos-${fotmobPos(p.positionId)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fotmobPlayer(p));
  }
  const rows = [...groups.entries()]
    .sort(([a], [b]) => (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) - Number(b) : a.localeCompare(b)))
    .map(([, row]) => row.sort((a, b) => Number(a.verticalLayout?.x ?? 0) - Number(b.verticalLayout?.x ?? 0)));
  return rows.length > 1 && rows.flat().length === 11 ? rows : null;
}

/* 球隊統計:FotMob 的 key → 本站欄位名。
   **對照表只放實測看過的 key**;沒看過的不猜,由 `unmappedStats` 回報,
   下一次跑就知道還差什麼(跟賠率解析器「解不出來就把表頭印出來」同一個做法)。 */
const TEAM_STAT_KEYS = {
  BallPossesion: 'possession',            // 上游就是這個拼字(少一個 s)
  total_shots: 'shots',
  ShotsOnTarget: 'shotsOn',
  ShotsOffTarget: 'shotsOff',
  /* 下面這幾個是**第一次跑完之後才確定的**。我原本照直覺寫成 `offsides`、
     `saves`、`blocked_shots`,全部對不上 —— 抓取器把對映不到的 key 印出來
     才看到真正的名字。大小寫與命名風格在同一份 payload 裡並不一致
     (`Offsides` 大寫、`keeper_saves` 加了前綴、tackles 是 i18n 字串)。 */
  shot_blocks: 'blockedShots',
  corners: 'corners',
  Offsides: 'offsides',
  fouls: 'fouls',
  keeper_saves: 'saves',
  passes: 'passes',                       // 傳球嘗試
  accurate_passes: 'passesAccurate',      // 傳球成功
  expected_goals: 'xG',
};

export function fotmobTeamStats(raw) {
  const groups = raw?.content?.stats?.Periods?.All?.stats ?? [];
  const home = {}, away = {};
  const unmapped = new Set();
  for (const group of groups) {
    for (const row of group?.stats ?? []) {
      // type:'title' 是分隔列,stats 是 [null,null]
      if (!row || row.type === 'title' || !Array.isArray(row.stats)) continue;
      const field = TEAM_STAT_KEYS[row.key];
      if (!field) { if (row.key) unmapped.add(row.key); continue; }
      const [h, a] = row.stats;
      home[field] = numOrNull(h); away[field] = numOrNull(a);
    }
  }
  const fill = s => ({
    possession: null, shots: null, shotsOn: null, shotsOff: null, blockedShots: null,
    corners: null, offsides: null, fouls: null, saves: null,
    passes: null, passesAccurate: null, passAccuracy: null, xG: null, ...s,
  });
  return { home: fill(home), away: fill(away), unmapped: [...unmapped] };
}

/* 逐人統計。stats 是四組(Top stats / Attack / Defense / Duels),
   每組是 { 顯示標題: { key, stat: { value, total?, type } } }。
   攤平成 key → {value,total} 再對映 —— 用 key 不用標題(標題會隨語言變)。 */
function flatPlayerStats(entry) {
  const out = {};
  for (const group of entry?.stats ?? []) {
    for (const item of Object.values(group?.stats ?? {})) {
      if (!item?.key) continue;
      out[item.key] = { value: item.stat?.value ?? null, total: item.stat?.total ?? null };
    }
  }
  return out;
}

/* 用過的球員統計 key 都登記起來,沒登記的由 `unmappedPlayerStats` 回報。
   球隊統計那邊已經證明「照直覺猜名字」會錯一半(offsides/saves/blocked_shots
   三個全錯),逐人這一層同樣不要猜 —— 讓它自己講還差什麼。 */
const USED_PLAYER_KEYS = new Set();
const v = (s, key) => { USED_PLAYER_KEYS.add(key); return numOrNull(s[key]?.value); };
const t = (s, key) => { USED_PLAYER_KEYS.add(key); return numOrNull(s[key]?.total); };

export function fotmobPlayers(raw, { homeId, awayId, homeCode, awayCode }) {
  const out = { [homeCode]: [], [awayCode]: [] };
  const seen = new Set();
  for (const entry of Object.values(raw?.content?.playerStats ?? {})) {
    const code = Number(entry?.teamId) === Number(homeId) ? homeCode
      : Number(entry?.teamId) === Number(awayId) ? awayCode : null;
    if (!code) continue;
    const s = flatPlayerStats(entry);
    for (const k of Object.keys(s)) seen.add(k);
    out[code].push({
      providerId: entry.id ?? null,
      name: entry.name ?? '',
      photo: null,
      shirt: numOrNull(entry.shirtNumber),
      pos: entry.isGoalkeeper ? 'G' : fotmobPos(entry.positionId),
      minutes: v(s, 'minutes_played'),
      rating: v(s, 'rating_title'),
      captain: entry.isCaptain === true,
      substitute: false,
      offsides: v(s, 'Offsides'),
      /* 逐人**沒有**「總射門」這個 key —— 只有射正/射偏/被封阻三個。
         三個都在才相加,缺一個就留空:湊不齊的和是錯的數,不是估計值。 */
      shots: {
        total: (() => {
          const on = v(s, 'ShotsOnTarget'), off = v(s, 'ShotsOffTarget'), blk = v(s, 'blocked_shots');
          return [on, off, blk].every(x => x !== null) ? on + off + blk : null;
        })(),
        on: v(s, 'ShotsOnTarget'),
      },
      goals: {
        total: v(s, 'goals'), conceded: v(s, 'goals_conceded'),
        assists: v(s, 'assists'), saves: v(s, 'saves'),
      },
      passes: { total: t(s, 'accurate_passes'), key: v(s, 'chances_created'), accuracy: null },
      // Tackles 的 key 是 i18n 字串,不是 'tackles' —— 實測過,見檔頭
      tackles: {
        total: v(s, 'matchstats.headers.tackles'),
        blocks: v(s, 'shot_blocks'),
        interceptions: v(s, 'interceptions'),
      },
      // 對抗:贏與輸是兩個 key,總數要自己加(同樣缺一個就留空)
      duels: (() => {
        const won = v(s, 'duel_won'), lost = v(s, 'duel_lost');
        return { total: won !== null && lost !== null ? won + lost : null, won };
      })(),
      dribbles: { attempts: t(s, 'dribbles_succeeded'), success: v(s, 'dribbles_succeeded') },
      fouls: { drawn: v(s, 'was_fouled'), committed: v(s, 'fouls') },
      cards: { yellow: null, red: null },        // 牌從事件推,playerStats 沒有
      penalty: { saved: v(s, 'penalties_saved') },
      accuratePasses: v(s, 'accurate_passes'),
      touches: v(s, 'touches'),
      recoveries: v(s, 'recoveries'),
      clearances: v(s, 'clearances'),
      xA: v(s, 'expected_assists'),
    });
  }
  out.__unmapped = [...seen].filter(k => !USED_PLAYER_KEYS.has(k));
  return out;
}

/* 事件。FotMob 的型別實測有 10 種:
   Card / Comment / AddedTime / Half / Substitution / Goal / Assist / Yellow / Red / InternationalDuty
   本站的時間軸只認 Goal 與 subst 與 Card,其餘(半場、傷停補時、文字評論)不進來。 */
export function fotmobEvents(raw, { homeCode, awayCode }) {
  const events = [];
  for (const e of raw?.content?.matchFacts?.events?.events ?? []) {
    const minute = numOrNull(e?.time);
    if (minute === null) continue;
    const ownGoal = e?.ownGoal === true;
    /* isHome 指的是**這名球員屬於哪一隊**。烏龍球的得分方是對面,所以要反過來。
       這裡不用 homeScore/awayScore —— 實測那兩個欄位對不上比分(見檔頭),
       而且 goalEvidence 會拿最終比分核對,對不上就不覆寫球員統計。 */
    const playerSide = e?.isHome === true ? homeCode : e?.isHome === false ? awayCode : null;
    if (!playerSide) continue;
    const scoringSide = ownGoal ? (playerSide === homeCode ? awayCode : homeCode) : playerSide;
    const label = `${minute}'${e.overloadTime ? `+${e.overloadTime}` : ''}`;
    if (e.type === 'Goal') {
      events.push({
        minute, extra: numOrNull(e.overloadTime), label, team: scoringSide, type: 'Goal',
        detail: ownGoal ? 'Own Goal' : (e.goalDescription ?? 'Normal Goal'),
        comments: e.goalDescription ?? null,
        // 烏龍球不指名射手 —— 踢進的人在對面,掛上去就是配錯人
        player: ownGoal ? null : (e.player?.name ?? null),
        playerId: ownGoal ? null : (e.player?.id ?? null),
        assist: e.assistStr ?? e.assist?.name ?? null,
        assistId: e.assist?.id ?? null,
      });
    } else if (e.type === 'Card') {
      const red = /red/i.test(String(e.card ?? e.cardDescription ?? ''));
      events.push({
        minute, extra: numOrNull(e.overloadTime), label, team: playerSide, type: 'Card',
        detail: red ? 'Red Card' : 'Yellow Card',
        comments: e.cardReason ?? e.cardDescription ?? null,
        player: e.player?.name ?? null, playerId: e.player?.id ?? null,
        assist: null, assistId: null,
      });
    } else if (e.type === 'Substitution') {
      events.push({
        minute, extra: numOrNull(e.overloadTime), label, team: playerSide, type: 'subst',
        detail: 'Substitution', comments: null,
        player: e.swap?.[0]?.name ?? e.player?.name ?? null,
        playerId: e.swap?.[0]?.id ?? e.player?.id ?? null,
        assist: null, assistId: null,
      });
    }
  }
  return events.sort((a, b) => a.minute - b.minute);
}

/* 牌從事件補回球員身上 —— playerStats 裡沒有牌。 */
function attachCards(players, events) {
  const byId = new Map();
  for (const list of Object.values(players)) for (const p of list) if (p.providerId != null) byId.set(String(p.providerId), p);
  for (const e of events) {
    if (e.type !== 'Card' || e.playerId == null) continue;
    const p = byId.get(String(e.playerId));
    if (!p) continue;
    if (e.detail === 'Red Card') p.cards.red = (p.cards.red ?? 0) + 1;
    else p.cards.yellow = (p.cards.yellow ?? 0) + 1;
  }
}

/* 站位 → `grid`("排:位",跟 SportMonks 同一個格式)。
   **一定要給真的值**:`rowsOf` 的實作是 `Number(player.grid ?? '')`,
   而 `Number('') === 0` —— 給 null 的話 11 個人會全部落進「第 0 排」,
   球場圖畫成一條線,而且不會有任何地方報錯。
   (又一次「0 是一個看起來很像答案的數字」。) */
function gridOf(starters) {
  const ys = [...new Set(starters.map(p => Number(p.verticalLayout?.y)).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!ys.length) return new Map();
  const out = new Map();
  for (const y of ys) {
    const row = ys.indexOf(y) + 1;
    starters.filter(p => Number(p.verticalLayout?.y) === y)
      .sort((a, b) => Number(a.verticalLayout?.x ?? 0) - Number(b.verticalLayout?.x ?? 0))
      .forEach((p, i) => out.set(p.id, `${row}:${i + 1}`));
  }
  return out;
}

const sideLineup = (side, code) => ({
  formation: side?.formation ?? null,
  xi: (() => {
    const starters = side?.starters ?? [];
    const grid = gridOf(starters);
    return starters.map(p => ({
      providerId: p.id ?? null, name: p.name ?? '',
      shirt: numOrNull(p.shirtNumber), pos: fotmobPos(p.positionId),
      grid: grid.get(p.id) ?? null,
    }));
  })(),
  bench: (side?.subs ?? side?.substitutes ?? []).map(p => ({
    providerId: p.id ?? null, name: p.name ?? '',
    shirt: numOrNull(p.shirtNumber), pos: fotmobPos(p.positionId), grid: null,
  })),
  rows: fotmobRows((side?.starters ?? []).map(p => ({ ...p, providerId: p.id, verticalLayout: p.verticalLayout }))),
  coach: side?.coach?.name ?? null,
  team: code,
});

/* 主入口。`fixture` 是本站賽程那一筆(用來決定隊碼與比分), `raw` 是 matchDetails。 */
export function normaliseFotmobMatch(raw, { fixture, season = null } = {}) {
  if (!raw || !fixture) return null;
  const homeCode = fixture.home, awayCode = fixture.away;
  const homeId = raw?.general?.homeTeam?.id ?? raw?.content?.lineup?.homeTeam?.id ?? null;
  const awayId = raw?.general?.awayTeam?.id ?? raw?.content?.lineup?.awayTeam?.id ?? null;

  const stats = fotmobTeamStats(raw);
  const playersRaw = fotmobPlayers(raw, { homeId, awayId, homeCode, awayCode });
  const unmappedPlayerStats = playersRaw.__unmapped ?? [];
  delete playersRaw.__unmapped;
  const players = playersRaw;
  const events = fotmobEvents(raw, { homeCode, awayCode });
  attachCards(players, events);

  const lineup = raw?.content?.lineup ?? {};
  const lineups = {
    [homeCode]: sideLineup(lineup.homeTeam, homeCode),
    [awayCode]: sideLineup(lineup.awayTeam, awayCode),
  };
  const teamStats = { [homeCode]: stats.home, [awayCode]: stats.away };

  /* 比分一律用本站賽程那一筆(已經跟獨立來源核對過);FotMob 的 scoreStr
     只拿來做一致性檢查,不當答案。對不上就整份不發布 —— 那是既有的守門
     (`buildProviderMatchReport` 會比 detail.score 與 fixture 的比分)。 */
    const scoreStr = String(raw?.header?.status?.scoreStr ?? '');
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(scoreStr.trim());
  const providerScore = m ? { home: Number(m[1]), away: Number(m[2]) } : null;

  const hasLineups = [homeCode, awayCode].every(c => lineups[c].xi.length === 11 && lineups[c].formation);
  const hasPlayerStats = Object.values(players).some(list => list.some(p => p.rating !== null || p.minutes !== null));
  const hasTeamStats = Object.values(teamStats).some(s => Object.values(s).some(x => x !== null));

  return {
    key: `${homeCode}|${awayCode}`, season: season ?? fixture.season ?? null,
    source: 'fotmob',
    fixtureId: raw?.general?.matchId ?? null,
    kickoff: raw?.general?.matchTimeUTCDate ?? fixture.kickoff ?? null,
    status: raw?.header?.status?.finished === true ? 'finished' : 'other',
    home: homeCode, away: awayCode,
    fetchedAt: new Date().toISOString(),
    score: providerScore ?? { home: fixture.fh, away: fixture.fa },
    teamStats, players, events, lineups,
    coverage: {
      teamStatistics: hasTeamStats, playerStatistics: hasPlayerStats,
      ratings: Object.values(players).flat().some(p => p.rating !== null),
      events: Array.isArray(raw?.content?.matchFacts?.events?.events),
      lineups: hasLineups,
      tracking: false, speed: false, distance: false, sprints: false,
    },
    // 對映不到的 key —— 不猜,回報出來讓下一次補對照表
    unmappedStats: stats.unmapped,
    unmappedPlayerStats,
    unavailable: ['speed', 'distance', 'sprints'],
  };
}
