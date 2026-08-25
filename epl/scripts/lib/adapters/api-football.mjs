// Adapter:API-Football (api-sports.io) → 官方陣型與教練
//
// 這一支是「怎麼接一個需要金鑰的 API」的範本。要接別家,複製這個檔改三個地方:
//   1. BASE / 端點路徑
//   2. 認證 header 的名稱
//   3. toCanonical() 裡的欄位對應
// 其他(金鑰處理、快取、節流、失敗隔離)都可以照抄。
//
// ⚠ 我沒有實測過:開發沙箱連不到外網。第一次真正執行會在你的電腦或 runner 上。
//    設計上失敗完全無害 —— 抓不到就回 null,上層自動退回既有的角色推導。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const id = 'api-football';
export const label = 'API-Football (api-sports.io)';
export const supports = [
  'formations', 'coaches', 'post-match-details', 'ratings',
  'team-statistics', 'player-statistics', 'events',
];

const BASE = 'https://v3.football.api-sports.io';
export const API_FOOTBALL_LEAGUES = Object.freeze({
  pl: 39,                      // Premier League
  es1: 140,                    // La Liga
});
const LEAGUE_EPL = API_FOOTBALL_LEAGUES.pl;
const COMPLETED = new Set(['FT', 'AET', 'PEN']);
const RETRY_AFTER_MS = 30 * 60e3;

/* ── 1. 金鑰 ──────────────────────────────────
   只從環境變數讀,而且只在建置階段(Node)用。產物是靜態 JSON,
   金鑰不會、也不可能出現在前端 bundle 裡。
   絕對不要寫死在檔案裡 —— 這個 repo 是公開的。 */
export const enabled = (env = process.env) => Boolean(env.API_FOOTBALL_KEY);

/* ── 2. 額度控制 ──────────────────────────────
   免費方案 100 次/天。目前排程每 15 分鐘一次 = 96 次/天,
   等於每次只剩 1 個請求的預算 —— 不夠。
   所以這裡自己記帳,超過就停,不要把額度燒光導致整天都拿不到資料。 */
const DAILY_BUDGET = Number(process.env.API_FOOTBALL_BUDGET ?? 80);   // 留 20 次緩衝

class Budget {
  constructor(root) { this.file = join(root, 'data', 'cache', 'api-football-budget.json'); this.used = 0; this.day = null; }
  async load() {
    try {
      const j = JSON.parse(await readFile(this.file, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      if (j.day === today) { this.used = j.used; this.day = j.day; }
      else { this.used = 0; this.day = today; }
    } catch { this.day = new Date().toISOString().slice(0, 10); }
    return this;
  }
  left() { return Math.max(0, DAILY_BUDGET - this.used); }
  async spend(n = 1) {
    this.used += n;
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify({ day: this.day, used: this.used }));
  }
}

/* ── 3. 快取 ──────────────────────────────────
   同一場比賽的官方陣容公布後就不會再變,沒必要每次 build 都重抓。
   這也是使用者當初訂的規則:所有人共用後端的快取,不是每個人各自去打 API。 */
const cachePath = (root, key) => join(root, 'data', 'cache', `af-${key}.json`);

async function cached(root, key, ttlMs, produce) {
  const f = cachePath(root, key);
  if (existsSync(f)) {
    try {
      const j = JSON.parse(await readFile(f, 'utf8'));
      if (Date.now() - new Date(j.at).getTime() < ttlMs) return { ...j, fromCache: true };
    } catch { /* 壞掉的快取直接當沒有 */ }
  }
  const data = await produce();
  if (data === null) return null;
  const rec = { at: new Date().toISOString(), data };
  await mkdir(join(f, '..'), { recursive: true });
  await writeFile(f, JSON.stringify(rec));
  return { ...rec, fromCache: false };
}

/* ── 4. 請求 ──────────────────────────────────
   逾時、重試、節流都在這裡。任何失敗都回 null,不丟例外 ——
   資料源掛掉不該讓整個 build 失敗。 */
async function call(path, { env = process.env, budget, fetchImpl = fetch, retries = 2 } = {}) {
  if (!enabled(env)) return null;
  if (budget && budget.left() <= 0) {
    console.warn(`  ⚠ API-Football 今日額度用完(${DAILY_BUDGET}),略過`);
    return null;
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetchImpl(`${BASE}${path}`, {
        headers: { 'x-apisports-key': env.API_FOOTBALL_KEY, accept: 'application/json' },
        signal: ctrl.signal,
      });
      await budget?.spend(1);
      if (res.status === 429) {                       // 被限流:等一下再試
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const j = await res.json();
      // API-Football 即使 HTTP 200 也可能在 errors 裡回錯誤
      if (j.errors && Object.keys(j.errors).length) {
        console.warn(`  ⚠ API-Football 回報錯誤:${JSON.stringify(j.errors).slice(0, 120)}`);
        return null;
      }
      return j.response ?? null;
    } catch {
      if (attempt === retries) return null;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
  return null;
}

/* ── 5. 對應到本站格式 ────────────────────────
   外部欄位一律在這裡轉成本站的形狀,上層永遠不碰供應商的 JSON。
   這就是 Canonical Schema 的意義:換供應商只要改這個函式。 */
const toCanonicalFormation = (row, codeOf) => ({
  team: codeOf(row.team?.name) ?? null,
  formation: row.formation ?? null,          // 例 "4-3-3" —— 這就是我們缺的官方陣型
  xi: (row.startXI ?? []).map(x => ({
    name: x.player?.name ?? '', number: x.player?.number ?? null,
    grid: x.player?.grid ?? null,            // "行:列",官方的實際站位格線
    pos: x.player?.pos ?? null,              // G/D/M/F
  })),
  coach: row.coach?.name ?? null,
  source: id,
});

/* 取某一輪所有比賽的官方陣容。回 null 代表這次拿不到(沒金鑰/額度用完/連不上)。 */
export async function loadFormations({ root, season, round, codeOf, env = process.env, fetchImpl = fetch }) {
  if (!enabled(env)) return null;
  const budget = await new Budget(root).load();

  // 先拿這一輪的 fixture id(官方陣容要用 fixture id 查)
  const fx = await cached(root, `fixtures-${season}-${round}`, 6 * 3600e3, () =>
    call(`/fixtures?league=${LEAGUE_EPL}&season=${season}&round=Regular%20Season%20-%20${round}`,
      { env, budget, fetchImpl }));
  if (!fx?.data?.length) return null;

  const out = {};
  for (const f of fx.data) {
    const fid = f.fixture?.id;
    if (!fid) continue;
    // 陣容公布後就不會再變,快取存 24 小時
    const lu = await cached(root, `lineup-${fid}`, 24 * 3600e3, () =>
      call(`/fixtures/lineups?fixture=${fid}`, { env, budget, fetchImpl }));
    if (!lu?.data?.length) continue;
    for (const side of lu.data) {
      const c = toCanonicalFormation(side, codeOf);
      if (c.team) out[c.team] = c;
    }
    await new Promise(r => setTimeout(r, 300));       // 對免費方案客氣一點
  }
  return { formations: out, budgetLeft: budget.left(), fetchedAt: new Date().toISOString() };
}

/* ── 6. 完賽資料 ──────────────────────────────
   賽後球員與球隊數據一旦抓成功就寫進 data/raw,永久保留、不設 TTL。
   live 輪詢可以一直呼叫這個函式；已成功的比賽會在任何網路請求之前被略過。
   供應商沒有速度、跑動距離與衝刺資料,因此 canonical schema 明確標成 unavailable,
   絕不從其他欄位推估。 */
const postMatchPath = (root, { storeDir = 'api-football', storeFile = 'match-details.json' } = {}) =>
  join(root, 'data', 'raw', storeDir, storeFile);
const emptyPostMatchStore = season => ({
  version: 1, source: id, season, updatedAt: null, matches: {}, attempts: {},
});

async function readPostMatchStore(root, season, storage) {
  try {
    const parsed = JSON.parse(await readFile(postMatchPath(root, storage), 'utf8'));
    if (parsed.season && parsed.season !== season) return emptyPostMatchStore(season);
    return {
      ...emptyPostMatchStore(season), ...parsed, season,
      matches: parsed.matches ?? {}, attempts: parsed.attempts ?? {},
    };
  } catch { return emptyPostMatchStore(season); }
}

async function writePostMatchStore(root, store, storage) {
  const file = postMatchPath(root, storage);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 1));
}

const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
};
const boolOrNull = value => value === null || value === undefined ? null : Boolean(value);
const firstStat = row => row?.statistics?.[0] ?? {};

function canonicalPlayer(row) {
  const s = firstStat(row);
  return {
    providerId: row.player?.id ?? null,
    name: row.player?.name ?? '',
    photo: row.player?.photo ?? null,
    shirt: numberOrNull(s.games?.number),
    pos: s.games?.position ?? null,
    minutes: numberOrNull(s.games?.minutes),
    rating: numberOrNull(s.games?.rating),
    captain: boolOrNull(s.games?.captain),
    substitute: boolOrNull(s.games?.substitute),
    offsides: numberOrNull(s.offsides),
    shots: { total: numberOrNull(s.shots?.total), on: numberOrNull(s.shots?.on) },
    goals: {
      total: numberOrNull(s.goals?.total), conceded: numberOrNull(s.goals?.conceded),
      assists: numberOrNull(s.goals?.assists), saves: numberOrNull(s.goals?.saves),
    },
    passes: {
      total: numberOrNull(s.passes?.total), key: numberOrNull(s.passes?.key),
      accuracy: numberOrNull(s.passes?.accuracy),
    },
    tackles: {
      total: numberOrNull(s.tackles?.total), blocks: numberOrNull(s.tackles?.blocks),
      interceptions: numberOrNull(s.tackles?.interceptions),
    },
    duels: { total: numberOrNull(s.duels?.total), won: numberOrNull(s.duels?.won) },
    dribbles: {
      attempts: numberOrNull(s.dribbles?.attempts), success: numberOrNull(s.dribbles?.success),
      past: numberOrNull(s.dribbles?.past),
    },
    fouls: { drawn: numberOrNull(s.fouls?.drawn), committed: numberOrNull(s.fouls?.committed) },
    cards: { yellow: numberOrNull(s.cards?.yellow), red: numberOrNull(s.cards?.red) },
    penalty: {
      won: numberOrNull(s.penalty?.won), committed: numberOrNull(s.penalty?.commited ?? s.penalty?.committed),
      scored: numberOrNull(s.penalty?.scored), missed: numberOrNull(s.penalty?.missed),
      saved: numberOrNull(s.penalty?.saved),
    },
  };
}

const TEAM_STAT_FIELDS = new Map([
  ['ball possession', 'possession'], ['total shots', 'shots'], ['shots on goal', 'shotsOn'],
  ['shots off goal', 'shotsOff'], ['blocked shots', 'blockedShots'], ['corner kicks', 'corners'],
  ['offsides', 'offsides'], ['fouls', 'fouls'], ['goalkeeper saves', 'saves'],
  ['total passes', 'passes'], ['passes accurate', 'passesAccurate'], ['passes %', 'passAccuracy'],
  ['expected_goals', 'xG'],
]);

function canonicalTeamStats(row) {
  const out = {
    possession: null, shots: null, shotsOn: null, shotsOff: null, blockedShots: null,
    corners: null, offsides: null, fouls: null, saves: null, passes: null,
    passesAccurate: null, passAccuracy: null, xG: null,
  };
  for (const s of row?.statistics ?? []) {
    const field = TEAM_STAT_FIELDS.get(String(s.type ?? '').toLowerCase());
    if (field) out[field] = numberOrNull(s.value);
  }
  return out;
}

function canonicalEvent(row, codeOf) {
  const elapsed = numberOrNull(row.time?.elapsed);
  const extra = numberOrNull(row.time?.extra);
  return {
    minute: elapsed, extra,
    label: elapsed === null ? '' : `${elapsed}${extra ? `+${extra}` : ''}'`,
    team: codeOf(row.team?.name),
    type: row.type ?? null,
    detail: row.detail ?? null,
    comments: row.comments ?? null,
    player: row.player?.name ?? null,
    playerId: row.player?.id ?? null,
    assist: row.assist?.name ?? null,
    assistId: row.assist?.id ?? null,
  };
}

const canonicalLineupPlayer = row => ({
  providerId: row?.player?.id ?? null,
  name: row?.player?.name ?? '',
  shirt: numberOrNull(row?.player?.number),
  pos: row?.player?.pos ?? null,
  grid: row?.player?.grid ?? null,
});

function canonicalLineup(row, codeOf) {
  const team = codeOf(row?.team?.name);
  if (!team) return null;
  return {
    team,
    formation: row.formation ?? null,
    coach: row.coach?.name ?? null,
    xi: (row.startXI ?? []).map(canonicalLineupPlayer).filter(p => p.name),
    bench: (row.substitutes ?? []).map(canonicalLineupPlayer).filter(p => p.name),
  };
}

const hasObjectValue = obj => Object.values(obj ?? {}).some(v => v !== null && v !== undefined);

/* 匯出純轉換函式,讓測試可用假回應驗證欄位,不需要真的消耗 API 額度。 */
export function normaliseMatchDetail(row, { codeOf, season = null } = {}) {
  if (!row || typeof codeOf !== 'function') return null;
  const home = codeOf(row.teams?.home?.name);
  const away = codeOf(row.teams?.away?.name);
  if (!home || !away) return null;

  const teamStats = {};
  for (const side of row.statistics ?? []) {
    const code = codeOf(side.team?.name);
    if (code) teamStats[code] = canonicalTeamStats(side);
  }
  const players = {};
  for (const side of row.players ?? []) {
    const code = codeOf(side.team?.name);
    if (code) players[code] = (side.players ?? []).map(canonicalPlayer).filter(p => p.name);
  }
  const events = (row.events ?? []).map(e => canonicalEvent(e, codeOf))
    .filter(e => e.team || e.player || e.type)
    .sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999) || (a.extra ?? 0) - (b.extra ?? 0));
  const hasStats = Object.values(teamStats).some(hasObjectValue);
  const hasPlayers = Object.values(players).some(list => list.length);
  const hasEvents = events.length > 0;
  const lineups = {};
  for (const rowLineup of row.lineups ?? []) {
    const lineup = canonicalLineup(rowLineup, codeOf);
    if (lineup) lineups[lineup.team] = lineup;
  }
  const hasLineups = [home, away].every(code => lineups[code]?.xi?.length === 11);
  const fetchedAt = new Date().toISOString();
  return {
    key: `${home}|${away}`, season, source: id,
    fixtureId: row.fixture?.id ?? null,
    kickoff: row.fixture?.date ?? null,
    status: row.fixture?.status?.short ?? null,
    home, away, fetchedAt,
    score: { home: numberOrNull(row.goals?.home), away: numberOrNull(row.goals?.away) },
    teamStats, players, events, lineups,
    coverage: {
      teamStatistics: hasStats, playerStatistics: hasPlayers, ratings: Object.values(players).flat().some(p => p.rating !== null),
      events: hasEvents, lineups: hasLineups,
      tracking: false, speed: false, distance: false, sprints: false,
    },
    unavailable: ['speed', 'distance', 'sprints'],
  };
}

const apiSeason = season => Number(String(season).slice(0, 4));
const chunks = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

/**
 * 抓取已完賽的完整資料。onlyKeys 可傳本輪剛完賽的 HOME|AWAY 清單；成功後永不再抓。
 * 回傳摘要供 CLI/live log 顯示。沒有金鑰時安全略過。
 */
export async function fetchCompletedMatchDetails({
  root, season, codeOf, onlyKeys = null, force = false,
  leagueId = LEAGUE_EPL, storeDir = 'api-football', storeFile = 'match-details.json',
  expectedScores = null, requireLineups = false,
  env = process.env, fetchImpl = fetch,
} = {}) {
  if (!enabled(env)) return { enabled: false, fetched: 0, cached: 0, note: '未設定 API_FOOTBALL_KEY' };
  const storage = { storeDir, storeFile };
  const store = await readPostMatchStore(root, season, storage);
  const requested = onlyKeys ? [...new Set([...onlyKeys])] : null;
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const needs = key => {
    if (store.matches[key]) return false;
    const attempt = store.attempts[key] ?? {};
    const last = new Date(attempt.at ?? 0).getTime();
    if (!force && attempt.day === today && (attempt.tries ?? 0) >= 3) return false;
    return force || !Number.isFinite(last) || now - last >= RETRY_AFTER_MS;
  };
  const pendingRequested = requested?.filter(needs) ?? null;
  if (requested && !pendingRequested.length) {
    return { enabled: true, fetched: 0, cached: requested.filter(k => store.matches[k]).length, throttled: requested.filter(k => !store.matches[k]).length };
  }

  const budget = await new Budget(root).load();
  const budgetBefore = budget.left();
  const fixtures = await call(`/fixtures?league=${leagueId}&season=${apiSeason(season)}&status=FT-AET-PEN`,
    { env, budget, fetchImpl });
  if (!Array.isArray(fixtures)) return { enabled: true, fetched: 0, cached: 0, error: '完賽清單取得失敗', budgetLeft: budget.left() };

  const wanted = new Set(pendingRequested ?? []);
  const candidates = fixtures.map(row => {
    const home = codeOf(row.teams?.home?.name), away = codeOf(row.teams?.away?.name);
    return { row, home, away, key: home && away ? `${home}|${away}` : null, id: row.fixture?.id };
  }).filter(x => x.key && x.id && COMPLETED.has(x.row.fixture?.status?.short))
    .filter(x => (pendingRequested ? wanted.has(x.key) : needs(x.key)));

  const attemptedAt = new Date().toISOString();
  const attemptedKeys = new Set(candidates.map(x => x.key));
  for (const key of pendingRequested ?? []) attemptedKeys.add(key);
  for (const key of attemptedKeys) {
    const old = store.attempts[key] ?? {};
    store.attempts[key] = { at: attemptedAt, day: today, tries: old.day === today ? (old.tries ?? 0) + 1 : 1 };
  }

  let fetched = 0;
  const byId = new Map(candidates.map(x => [String(x.id), x]));
  for (const batch of chunks(candidates, 20)) {
    if (!batch.length) continue;
    const detailRows = await call(`/fixtures?ids=${batch.map(x => x.id).join('-')}`, { env, budget, fetchImpl });
    if (!Array.isArray(detailRows)) continue;
    for (const raw of detailRows) {
      const candidate = byId.get(String(raw.fixture?.id));
      const detail = normaliseMatchDetail(raw, { codeOf, season });
      if (!candidate || !detail || !COMPLETED.has(detail.status)) continue;
      const expected = expectedScores instanceof Map ? expectedScores.get(candidate.key) : expectedScores?.[candidate.key];
      if (expected && (detail.score.home !== expected.home || detail.score.away !== expected.away)) {
        store.attempts[candidate.key] = {
          ...store.attempts[candidate.key], error: 'score-mismatch',
          expected: `${expected.home}-${expected.away}`, received: `${detail.score.home}-${detail.score.away}`,
        };
        continue;
      }
      // 不把半成品當永久完成：三條資料都齊、且至少一位球員有供應商評分才落盤。
      // 否則 live 會稍後重試；一天每場最多三次,避免終場瞬間一直燒額度。
      if (!detail.coverage.teamStatistics || !detail.coverage.playerStatistics || !detail.coverage.ratings || !detail.coverage.events) continue;
      if (requireLineups && !detail.coverage.lineups) continue;
      store.matches[candidate.key] = detail;
      delete store.attempts[candidate.key];
      fetched++;
    }
  }
  store.updatedAt = new Date().toISOString();
  await writePostMatchStore(root, store, storage);
  return {
    enabled: true, fetched,
    cached: requested?.filter(k => store.matches[k]).length ?? Object.keys(store.matches).length,
    missing: attemptedKeys.size - fetched, budgetLeft: budget.left(), requestsUsed: budgetBefore - budget.left(),
    file: postMatchPath(root, storage),
  };
}
