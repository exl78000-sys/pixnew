// SportMonks 球員名單補充層。
//
// SportMonks 是本專案的主要球員身分／頭貼來源；英超仍以 FPL 的
// 表現統計為計算基礎，SportMonks 補足背號、頭貼與身分欄位。這裡只讀
// 本地快取，開頁與 build 都不連外。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'sportmonks';
export const label = 'SportMonks（主要球員資料來源）';
export const supports = ['playerMetadata', 'lineups', 'formations', 'postmatch-details'];

const STORE = (root, season, directory = 'sportmonks-la-liga') =>
  join(root, 'data', 'raw', directory, `${season}-squads.json`);

export const normaliseName = value => String(value ?? '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const namesOf = player => [player?.display_name, player?.name, player?.common_name,
  [player?.firstname, player?.lastname].filter(Boolean).join(' ')].filter(Boolean);

const rowsOf = store => Object.entries(store?.squads ?? {}).flatMap(([teamCode, rows]) =>
  (Array.isArray(rows) ? rows : []).map(row => ({ teamCode, row, player: row?.player ?? row })));

export function loadSquadStore(root, season, { directory = 'sportmonks-la-liga' } = {}) {
  const file = STORE(root, season, directory);
  if (!existsSync(file)) return null;
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'));
    if (store?.season !== season || !Object.keys(store.squads ?? {}).length) return null;

    /* SportMonks 曾把 2026-27 的 Deportivo A Coruña 回傳成 team code VIL，
       因為 provider 的 common_name 與隊名不一致；若直接使用會把拉科球員掛到
       Villarreal。以 provider 回傳的正式名稱做一次保守修復：移到 DEP，VIL 保持
       缺資料，直到下一次同步取得真正 Villarreal 名單，絕不把錯隊資料留在頁面。 */
    const driftName = String(store.teams?.VIL?.name ?? '').normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/deportivo.*(a\s*)?coruna/.test(driftName)) {
      const teams = { ...(store.teams ?? {}) };
      const squads = { ...(store.squads ?? {}) };
      if (!teams.DEP) teams.DEP = teams.VIL;
      if (!squads.DEP) squads.DEP = squads.VIL;
      delete teams.VIL;
      delete squads.VIL;
      return {
        ...store, teams, squads,
        coverage: { ...(store.coverage ?? {}), teams: Object.keys(teams).length, squads: Object.keys(squads).length },
      };
    }
    return store;
  } catch { return null; }
}

function candidateFor(player, candidates, codeOf) {
  const exact = new Map();
  for (const c of candidates) {
    for (const n of namesOf(c.player)) {
      const key = normaliseName(n);
      if (key) exact.set(`${c.teamCode}|${key}`, c);
    }
  }
  const teamCodes = new Set((player.teams ?? []).map(x => codeOf?.(x)).filter(Boolean));
  // FPL 的 web_name 常只有姓氏；全名也納入精確核對，能接回
  // António Silva、Ronald Araujo 這類縮寫球員而不靠猜測。
  for (const name of [player.name, player.fullName]) {
    const key = normaliseName(name);
    for (const code of teamCodes) {
      const hit = exact.get(`${code}|${key}`);
      if (hit) return hit;
    }
    const global = candidates.filter(c => namesOf(c.player).some(n => normaliseName(n) === key));
    if (global.length === 1) return global[0];
  }

  // Understat 偶爾用縮寫姓名。只有在「同隊、同姓且只有一個候選」時才放寬，
  // 避免把同姓球員的頭貼或背號掛錯人。
  const last = normaliseName(player.name).split(' ').at(-1);
  if (!last) return null;
  const fuzzy = candidates.filter(c => {
    const sameTeam = !teamCodes.size || teamCodes.has(c.teamCode);
    return sameTeam && namesOf(c.player).some(n => normaliseName(n).split(' ').at(-1) === last);
  });
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

export function enrichPlayers(players, store, { codeOf, fillMissing = false } = {}) {
  if (!Array.isArray(players) || !store) return { players: players ?? [], matched: 0, available: false };
  const candidates = rowsOf(store).filter(x => x.player && x.player.id != null);
  let matched = 0;
  const out = players.map(p => {
    const hit = candidateFor(p, candidates, codeOf);
    if (!hit) return p;
    const row = hit.row ?? {};
    const q = hit.player ?? {};
    matched++;
    const out = { ...p, sportmonksId: String(q.id), sportmonksTeam: hit.teamCode };
    const put = (key, value) => {
      if (value === null || value === undefined || value === '') return;
      if (!fillMissing || out[key] === null || out[key] === undefined || out[key] === '') out[key] = value;
    };
    put('squadNumber', row.jersey_number);
    // SportMonks 會用 placeholder URL 表示沒有頭貼；它不是有效照片，
    // 必須讓既有手動／備援來源接手，不能把 placeholder 當成已補齊。
    if (q.image_path && !/placeholder/i.test(String(q.image_path))) put('photo', q.image_path);
    put('dateOfBirth', q.date_of_birth);
    put('height', q.height);
    put('weight', q.weight);
    put('nationalityId', q.nationality_id ?? q.country_id);
    put('captain', row.captain === true ? true : null);
    put('contractStart', row.start);
    put('contractEnd', row.end);
    return out;
  });
  return { players: out, matched, available: candidates.length > 0 };
}

export function coverage(players) {
  const list = Array.isArray(players) ? players : [];
  const count = key => list.filter(p => p[key] !== null && p[key] !== undefined && p[key] !== '').length;
  return {
    players: list.length,
    matched: list.filter(p => p.sportmonksId).length,
    squadNumber: count('squadNumber'), photo: count('photo'), dateOfBirth: count('dateOfBirth'),
    physical: list.filter(p => p.height != null || p.weight != null).length,
    captain: count('captain'),
  };
}

const valueOf = row => row?.data?.value ?? row?.value ?? null;
const textOf = row => String(row?.type?.code ?? row?.type?.developer_name ?? row?.type?.name ?? '').toLowerCase();
const teamIdOf = (row, teamCodeById) => teamCodeById?.get(String(row?.team_id ?? row?.participant_id)) ?? null;

const playerPosition = id => {
  const n = Number(id);
  if (n === 24 || n === 25) return 'GK';
  if (n >= 26 && n <= 30) return 'DEF';
  if (n >= 31 && n <= 36) return 'MID';
  if (n >= 37 && n <= 41) return 'FWD';
  return null;
};

const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
};

const statValue = (details, ...keys) => {
  for (const key of keys) {
    const row = details.find(d => textOf(d).includes(key));
    if (row) return numberOrNull(valueOf(row));
  }
  return null;
};

function canonicalSportmonksPlayer(row) {
  const details = Array.isArray(row?.details) ? row.details : [];
  const player = row?.player ?? {};
  const rating = statValue(details, 'rating');
  const minutes = statValue(details, 'minutes-played', 'minutes_played', 'minutes');
  return {
    providerId: row?.player_id ?? player.id ?? null,
    name: row?.player_name ?? player.display_name ?? player.name ?? '',
    photo: player.image_path ?? null,
    shirt: numberOrNull(row?.jersey_number),
    pos: playerPosition(row?.position_id),
    minutes,
    rating,
    captain: row?.captain === true || statValue(details, 'captain') === 1,
    substitute: row?.type_id === 12,
    offsides: statValue(details, 'offsides'),
    shots: { total: statValue(details, 'shots-total', 'shots_total'), on: statValue(details, 'shots-on-target', 'shots_on_target') },
    goals: { total: statValue(details, 'goals'), conceded: statValue(details, 'goals-conceded'), assists: statValue(details, 'assists'), saves: statValue(details, 'saves') },
    passes: { total: statValue(details, 'passes'), key: statValue(details, 'key-passes', 'key_passes'), accuracy: statValue(details, 'pass-accuracy', 'pass_accuracy') },
    tackles: { total: statValue(details, 'tackles'), blocks: statValue(details, 'blocks'), interceptions: statValue(details, 'interceptions') },
    duels: { total: statValue(details, 'duels'), won: statValue(details, 'duels-won', 'duels_won') },
    dribbles: { attempts: statValue(details, 'dribbles'), success: statValue(details, 'dribbles-won', 'dribbles_won') },
    fouls: { drawn: statValue(details, 'fouls-drawn', 'fouls_drawn'), committed: statValue(details, 'fouls') },
    cards: { yellow: statValue(details, 'yellowcards', 'yellow-cards'), red: statValue(details, 'redcards', 'red-cards') },
    penalty: { saved: statValue(details, 'penalties-saved', 'penalty-saved') },
  };
}

function formationOf(raw, teamId) {
  const row = (raw?.formations ?? []).find(x => String(x.participant_id ?? x.team_id) === String(teamId));
  return row?.formation ?? row?.formation_name ?? row?.name ?? null;
}

// SportMonks fixture response → 本站 postmatch-report.mjs 所需的 canonical detail。
// 僅在資料確實存在時宣告 coverage，缺欄位就讓前端保持「未取得」而非補零。
export function normaliseSportmonksMatch(raw, { codeOf, fixture = null, teamCodeById = new Map(), season = null } = {}) {
  if (!raw || typeof codeOf !== 'function') return null;
  const participants = Array.isArray(raw.participants) ? raw.participants : [];
  const sideFor = location => participants.find(p => p.meta?.location === location || p.location === location);
  const homeParticipant = sideFor('home'), awayParticipant = sideFor('away');
  const home = codeOf(homeParticipant?.name) ?? fixture?.home ?? teamIdOf(homeParticipant, teamCodeById);
  const away = codeOf(awayParticipant?.name) ?? fixture?.away ?? teamIdOf(awayParticipant, teamCodeById);
  if (!home || !away) return null;
  const byTeam = new Map();
  for (const row of raw.lineups ?? []) {
    const code = teamIdOf(row, teamCodeById) ?? (String(row.team_id) === String(homeParticipant?.id) ? home : String(row.team_id) === String(awayParticipant?.id) ? away : null);
    if (code) {
      if (!byTeam.has(code)) byTeam.set(code, []);
      byTeam.get(code).push(row);
    }
  }
  const lineupFor = code => {
    const all = byTeam.get(code) ?? [];
    const xi = all.filter(p => p.type_id === 11 || p.formation_field != null).map(p => ({
      providerId: p.player_id ?? p.player?.id ?? null, name: p.player_name ?? p.player?.display_name ?? p.player?.name ?? '',
      shirt: numberOrNull(p.jersey_number), pos: playerPosition(p.position_id), grid: p.formation_field ?? null,
    })).filter(p => p.name);
    const bench = all.filter(p => !xi.some(x => String(x.providerId) === String(p.player_id)) && p.type_id === 12).map(p => ({
      providerId: p.player_id ?? p.player?.id ?? null, name: p.player_name ?? p.player?.display_name ?? p.player?.name ?? '',
      shirt: numberOrNull(p.jersey_number), pos: playerPosition(p.position_id), grid: null,
    })).filter(p => p.name);
    const teamId = all[0]?.team_id;
    const formation = formationOf(raw, teamId);
    return { team: code, formation, xi, bench, coach: null };
  };
  const lineups = { [home]: lineupFor(home), [away]: lineupFor(away) };
  const players = {};
  for (const code of [home, away]) players[code] = (byTeam.get(code) ?? []).map(canonicalSportmonksPlayer).filter(p => p.name);

  const teamStats = {};
  for (const code of [home, away]) {
    const rows = (raw.statistics ?? []).filter(x => teamIdOf(x, teamCodeById) === code || (x.location === 'home' && code === home) || (x.location === 'away' && code === away));
    const out = { possession: null, shots: null, shotsOn: null, shotsOff: null, blockedShots: null, corners: null, offsides: null, fouls: null, saves: null, passes: null, passesAccurate: null, passAccuracy: null, xG: null };
    const put = (keys, field) => { const n = statValue(rows, ...keys); if (n !== null) out[field] = n; };
    put(['ball-possession', 'ball_possession', 'possession'], 'possession'); put(['shots-total', 'shots_total'], 'shots');
    put(['shots-on-target', 'shots_on_target'], 'shotsOn'); put(['shots-off-target', 'shots_off_target'], 'shotsOff');
    put(['blocked-shots', 'blocked_shots'], 'blockedShots'); put(['corners'], 'corners'); put(['offsides'], 'offsides');
    put(['fouls'], 'fouls'); put(['saves'], 'saves'); put(['passes'], 'passes'); put(['passes-accurate', 'passes_accurate'], 'passesAccurate');
    put(['pass-accuracy', 'pass_accuracy'], 'passAccuracy'); put(['expected-goals', 'expected_goals', 'xg'], 'xG');
    teamStats[code] = out;
  }
  const events = (raw.events ?? []).map(e => {
    const code = teamIdOf(e, teamCodeById) ?? (e.location === 'home' ? home : e.location === 'away' ? away : null);
    const type = String(e.type?.code ?? e.type?.name ?? '').toLowerCase();
    return { minute: numberOrNull(e.minute ?? e.time), extra: numberOrNull(e.extra_minute ?? e.addition), label: e.minute == null ? '' : `${e.minute}${e.extra_minute ? `+${e.extra_minute}` : ''}'`, team: code, type: /goal/.test(type) ? 'Goal' : /card/.test(type) ? 'Card' : /subst|substitution/.test(type) ? 'subst' : e.type?.name ?? type, detail: e.info ?? e.type?.name ?? null, comments: e.addition ?? null, player: e.player_name ?? e.player?.display_name ?? e.player?.name ?? null, playerId: e.player_id ?? e.player?.id ?? null, assist: e.assist_name ?? e.assist?.name ?? null, assistId: e.assist_id ?? e.assist?.id ?? null };
  });
  const hasLineups = [home, away].every(code => lineups[code].xi.length === 11 && lineups[code].formation);
  const hasPlayerStats = Object.values(players).some(list => list.some(p => p.rating !== null || p.minutes !== null));
  const hasTeamStats = Object.values(teamStats).some(s => Object.values(s).some(v => v !== null));
  const score = fixture ? { home: fixture.fh, away: fixture.fa } : { home: numberOrNull(raw.scores?.find?.(x => x.description === 'CURRENT')?.score?.goals ?? raw.home_score), away: numberOrNull(raw.scores?.find?.(x => x.description === 'CURRENT')?.score?.goals ?? raw.away_score) };
  return { key: `${home}|${away}`, season, source: 'sportmonks', fixtureId: raw.id ?? null, kickoff: raw.starting_at ?? fixture?.kickoff ?? null, status: raw.state_id ?? null, home, away, fetchedAt: new Date().toISOString(), score, teamStats, players, events, lineups, coverage: { teamStatistics: hasTeamStats, playerStatistics: hasPlayerStats, ratings: Object.values(players).flat().some(p => p.rating !== null), events: Array.isArray(raw.events), lineups: hasLineups, tracking: false, speed: false, distance: false, sprints: false }, unavailable: ['speed', 'distance', 'sprints'] };
}
