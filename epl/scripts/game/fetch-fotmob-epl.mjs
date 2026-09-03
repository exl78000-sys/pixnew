#!/usr/bin/env node
/* 模擬遊玩用的英超逐場資料(FotMob)—— 控球率、逐射門 xG 與情境、逐分鐘動能、事件、名單。
 *
 * 為什麼有這一支:模擬遊玩(2026-09-03 規劃)第 4 項「每場都有控球率,抓取過往資料」。
 * 英超在這之前**一場控球率都沒有**(football-data CSV、FPL、openfootball 都沒這欄)。
 * `probe-possession.mjs` 實測過兩個來源都有:FotMob(全場 + 上下半場)與官網後端
 * `/stats/match/{id}`(`possession_percentage`)。主來源選 FotMob —— 同一個請求還帶
 * 逐射門 xG / 情境 / 座標、逐分鐘動能、事件與名單,遊戲側寫全部用得到;官網那條
 * 當**獨立核對**(`--verify`),鐵則五。
 *
 * 規矩(跟西甲 FotMob 抓取一樣):
 * - 永久快取,抓過就不再抓(完賽資料不會變)。每次請求上限、單線、間隔 600ms。
 *   一場一個請求 —— CLAUDE.md 寫「先不要做」,**這次是使用者明確要求的**,上限照守。
 * - **比分核對過才收**:FotMob 的比分要跟本站賽果(openfootball,獨立來源)一致,
 *   對不上整場不收。
 * - 存的是**精簡萃取**不是原始 payload(一場原始約 200 KB;西甲那份轉換後仍 69 KB/場,
 *   380 場會到 26 MB)。這裡只留遊戲要的:球隊統計、上下半場控球、事件、射門、動能、名單。
 *   萃取規則改了就 +1 `EXTRACT_VERSION`,舊快取會被重抓(受上限節制)。
 * - 這份 raw 只給 `scripts/game/` 讀。真實管線目前不用它;將來要用也是另一件事。
 *
 *   npm run game:fetch -- --season=2025-26 --limit=400   # 回填整季
 *   npm run game:fetch                                   # 本季增量(預設 40 場)
 *   npm run game:fetch -- --verify=20                    # 拿官網端點核對 20 場控球
 *   npm run game:fetch -- --refresh --limit=30              # 萃取多了欄位時把本季重抓一次(不 +1 版本)
 *   2026-09-03 起一場兩個請求(詳情 + 逐人熱區圖),--limit 是請求數,場數是它的一半。
 *   npm run game:fetch -- --dry-run
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from '../lib/teams.mjs';
import { fotmobTeamStats, fotmobEvents, fotmobPos, fotmobPlayers } from '../lib/adapters/fotmob-match.mjs';
import { API as PL_API, PL_HEADERS } from '../lib/pulselive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'https://www.fotmob.com';
const UA = 'pl-war-room/1.0 (football analysis side project)';
const LEAGUE_ID = 47;             // 英超在 FotMob 的 leagueId(probe-possession 實測)
const DIR = join(ROOT, 'data', 'raw', 'fotmob-epl');
export const EXTRACT_VERSION = 1;

const HARD_LIMIT = 800;           // 一次執行的請求硬上限:一場兩個請求(詳情 + 熱區圖),回填一季 380 場要 760
const DEFAULT_LIMIT = 40;
const INTERVAL_MS = 600;
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const dryRun = process.argv.includes('--dry-run');
const limit = Math.min(HARD_LIMIT, Math.max(0, Number(arg('limit') ?? DEFAULT_LIMIT)));
const verifyN = Number(arg('verify') ?? 0);
const refresh = process.argv.includes('--refresh');   // 已快取的也重抓(萃取多了欄位、但不想 +1 版本重抓整季時用)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const round = (n, d = 3) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 10 ** d) / 10 ** d : null);
const numOrNull = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

let used = 0;
async function get(url, headers = {}) {
  if (used >= HARD_LIMIT) return { error: `已達本次 ${HARD_LIMIT} 個請求上限` };
  used++;
  await sleep(INTERVAL_MS);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000),
      headers: { accept: 'application/json', 'user-agent': UA, ...headers } });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status}` };
    let j;
    try { j = JSON.parse(text); } catch { return { error: '回應不是 JSON' }; }
    if (j?.error) return { error: `回了 200 但帶 error:${String(j.error).slice(0, 80)}` };   // 200 + error 那條坑
    return { json: j };
  } catch (e) { return { error: e.message }; }
}

/* 本季:results.json 裡最大的 season。不寫死年份,換季不用改碼。 */
function seasonsOf(results) { return [...new Set(results.map(r => r.season))].sort(); }
const fotmobSeason = s => { const y = Number(s.slice(0, 4)); return `${y}/${y + 1}`; };

/* FotMob 聯賽賽程 → 「主|客」→ matchId。隊名走名冊的寬鬆對照(AFC Bournemouth 那類)。
   對不上的隊名印出來 —— tolerant 模式靜靜吞掉整隊是本站踩過的坑。 */
function indexFixtures(json, codeOf) {
  const byPair = new Map(), unknown = new Set();
  for (const item of json?.fixtures?.allMatches ?? json?.matches?.allMatches ?? []) {
    const home = codeOf(item.home?.name), away = codeOf(item.away?.name);
    if (!home) unknown.add(item.home?.name);
    if (!away) unknown.add(item.away?.name);
    if (!home || !away || !item.id) continue;
    byPair.set(`${home}|${away}`, { matchId: String(item.id), date: String(item.status?.utcTime ?? '').slice(0, 10),
      finished: item.status?.finished === true, scoreStr: item.status?.scoreStr ?? null });
  }
  return { byPair, unknown: [...unknown] };
}

/* 精簡萃取。欄位全部是探測看過的(probe-possession 2026-09-03,ARS 3-0 COV),
   沒看過的不猜;球隊統計與事件直接用西甲那個轉換器(兩邊共用,不複製)。 */
function possessionByPeriod(raw) {
  const per = raw?.content?.stats?.Periods ?? {};
  const pick = p => {
    const row = (p?.stats ?? []).flatMap(g => g?.stats ?? []).find(r => r?.key === 'BallPossesion');
    return Array.isArray(row?.stats) ? row.stats.map(numOrNull) : null;
  };
  return { all: pick(per.All), h1: pick(per.FirstHalf), h2: pick(per.SecondHalf) };
}
/* 跑動 / 衝刺(2026-09-03 重探後加):球隊層 physical_metrics_* 與逐人 performance.totalDistanceCovered / topSpeed。
   實測:2026-27 每場都有;2025-26 有 282/380(缺的集中在 11 座主場,不是時間點);2024-25 沒有。
   萃取版本不 +1(2024-25 以前重抓也是 null),兩季各用 --refresh 重抓一次。沒有值一律 null,不是 0。 */
function physicalOf(raw, sideOf) {
  const rows = (raw?.content?.stats?.Periods?.All?.stats ?? []).flatMap(g => g?.stats ?? []);
  const pick = key => { const r = rows.find(x => x?.key === key); return Array.isArray(r?.stats) ? r.stats.map(numOrNull) : [null, null]; };
  const team = { distance: pick('physical_metrics_distance_covered'), sprintDistance: pick('physical_metrics_sprinting'), sprints: pick('physical_metrics_number_of_sprints'),
    walking: pick('physical_metrics_walking'), running: pick('physical_metrics_running') };
  const players = [];
  for (const k of ['homeTeam', 'awayTeam']) {
    const side = raw?.content?.lineup?.[k];
    for (const p of [...(side?.starters ?? []), ...(side?.subs ?? [])]) {
      const d = numOrNull(p.performance?.totalDistanceCovered), v = numOrNull(p.performance?.topSpeed);
      if (d == null && v == null) continue;
      players.push({ team: sideOf(side?.id), name: p.name ?? '', shirt: numOrNull(p.shirtNumber), distance: d, topSpeed: v, rating: numOrNull(p.performance?.rating) });
    }
  }
  const has = team.distance.some(v => v != null) || players.length > 0;
  return has ? { team, players } : null;
}
function extract(raw, fixture) {
  const homeCode = fixture.home, awayCode = fixture.away;
  const homeId = raw?.general?.homeTeam?.id, awayId = raw?.general?.awayTeam?.id;
  const sideOf = teamId => (Number(teamId) === Number(homeId) ? homeCode : Number(teamId) === Number(awayId) ? awayCode : null);
  const stats = fotmobTeamStats(raw);
  const events = fotmobEvents(raw, { homeCode, awayCode }).map(e => ({
    minute: e.minute, extra: e.extra, team: e.team, type: e.type, detail: e.detail, player: e.player,
  }));
  const shots = (raw?.content?.shotmap?.shots ?? []).map(s => ({
    min: numOrNull(s.min), extra: numOrNull(s.minAdded), team: sideOf(s.teamId), player: s.playerName ?? null,
    type: s.eventType ?? null, situation: s.situation ?? null, xg: round(s.expectedGoals), xgot: round(s.expectedGoalsOnTarget),
    onTarget: s.isOnTarget === true, blocked: s.isBlocked === true, inBox: s.isFromInsideBox === true,
    ownGoal: s.isOwnGoal === true, x: round(s.x, 1), y: round(s.y, 1), foot: s.shotType ?? null,
  }));
  const momentum = (raw?.content?.momentum?.main?.data ?? []).map(d => [numOrNull(d.minute), numOrNull(d.value)]);
  const side = (s, code) => ({
    team: code, formation: s?.formation ?? null, coach: s?.coach?.name ?? null,
    xi: (s?.starters ?? []).map(p => ({ name: p.name ?? '', shirt: numOrNull(p.shirtNumber), pos: fotmobPos(p.positionId) })),
    bench: (s?.subs ?? []).map(p => ({ name: p.name ?? '', shirt: numOrNull(p.shirtNumber), pos: fotmobPos(p.positionId) })),
  });
  const lu = raw?.content?.lineup ?? {};
  const scoreStr = String(raw?.header?.status?.scoreStr ?? '').trim();
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(scoreStr);
  const providerScore = m ? [Number(m[1]), Number(m[2])] : null;
  const shotGoals = shots.filter(s => s.type === 'Goal').length;
  return {
    key: `${homeCode}|${awayCode}`, season: fixture.season, date: fixture.date, matchId: null,
    home: homeCode, away: awayCode, score: [fixture.fh, fixture.fa], providerScore,
    teamStats: { [homeCode]: stats.home, [awayCode]: stats.away }, unmappedStats: stats.unmapped,
    possession: possessionByPeriod(raw),
    events, shots, momentum,
    lineups: { [homeCode]: side(lu.homeTeam, homeCode), [awayCode]: side(lu.awayTeam, awayCode) },
    physical: physicalOf(raw, sideOf),
    /* 三路進攻佔比(左/中/右,全場與上下半場;探測 2026-09-03):供應商算的,本站只搬運。 */
    zones: raw?.content?.attackingZones ?? null,
    heatmapUrl: raw?.content?.heatmapUrl ?? null,
    /* shotmap 的進球數跟比分對不上就標出來 —— 不丟整場(控球還是對的),但用射門資料
       的人要知道那一場的射門不完整。 */
    checks: { shotmapGoals: shotGoals, shotmapComplete: shotGoals === fixture.fh + fixture.fa },
    extractVersion: EXTRACT_VERSION, fetchedAt: new Date().toISOString(),
  };
}

/* 往季的 fixtureId 不在 pulselive 快取裡:打官網的賽季清單找到該季,再拉整季賽程(pageSize 100,4 頁)。
   隊伍對照用官方 club.abbr(= 本站隊碼,CLAUDE.md 驗過)。這一段只在 --verify 且非本季時跑,約 5 個請求。 */
async function pulseFixturesFor(season, teams) {
  const r = await get(`${PL_API}/competitions/1/compseasons?pageSize=30`, PL_HEADERS);
  const want = `${season.slice(0, 4)}/${season.slice(5, 7)}`;
  const cs = (r.json?.content ?? []).find(c => String(c.label ?? '').includes(want));
  if (!cs) { console.log(`  ⚠ 官網賽季清單找不到 ${want}`); return []; }
  const out = [];
  for (let page = 0; page < 5; page++) {
    const f = await get(`${PL_API}/fixtures?comps=1&compSeasons=${cs.id}&pageSize=100&page=${page}&sort=asc&statuses=C`, PL_HEADERS);
    const list = f.json?.content ?? [];
    for (const fx of list) {
      const [h, a] = fx.teams ?? [];
      const code = t => teams.codeOf(t?.team?.club?.abbr) ?? teams.codeOf(t?.team?.name) ?? null;
      const home = code(h), away = code(a);
      if (home && away && fx.id) out.push({ key: `${home}|${away}`, fixtureId: fx.id, homeId: h.team?.id, awayId: a.team?.id });
    }
    if (list.length < 100) break;
  }
  return out;
}

/* 逐人活動熱區(2026-09-03 探到):另一個端點,回每人一串 <circle cx cy> 的觸球位置(105×68 場地座標)。
   存的是**12×8 格的計數**加質心,不存逐點 —— 逐點一季約 5 MB,格子 1/3;動畫要的是「這個人平常在哪一區」,
   格子夠用。座標系跟 shotmap 一樣(x 往對方球門)。主客各自對回隊碼要靠 playerId 對 lineup 的 id。 */
const GRID_X = 6, GRID_Y = 4;   // 6×4 就夠:動畫要的是質心、離散度與大致區域;12×8 一季 14 MB
function heatOf(json, raw, sideOf) {
  const players = json?.players;
  if (!players || typeof players !== 'object') return null;
  /* 熱區的鍵是 **Opta id**(p168144 那種),不是名單裡的 FotMob 球員 id(Raya 是 562727)——
     實測對不上一個。playerStats 每筆同時有 id、optaId、teamId,用它對照;沒有 optaId 的退回 FotMob id。 */
  const idTeam = new Map();
  for (const e of Object.values(raw?.content?.playerStats ?? {})) {
    const who = { team: sideOf(e.teamId), name: e.name ?? '' };
    if (e.optaId != null) idTeam.set(String(e.optaId), who);
    if (e.id != null && !idTeam.has(String(e.id))) idTeam.set(String(e.id), who);
  }
  const out = [];
  for (const [key, svg] of Object.entries(players)) {
    const id = key.replace(/^p/, '');
    const who = idTeam.get(id);
    if (!who || typeof svg !== 'string') continue;
    const pts = [...svg.matchAll(/cx="([\d.]+)" cy="([\d.]+)"/g)].map(m => [Number(m[1]), Number(m[2])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (!pts.length) continue;
    const grid = new Array(GRID_X * GRID_Y).fill(0);
    let sx = 0, sy = 0;
    for (const [x, y] of pts) {
      const gx = Math.min(GRID_X - 1, Math.max(0, Math.floor(x / 105 * GRID_X))), gy = Math.min(GRID_Y - 1, Math.max(0, Math.floor(y / 68 * GRID_Y)));
      grid[gy * GRID_X + gx]++; sx += x; sy += y;
    }
    const cx = sx / pts.length, cy = sy / pts.length;
    const sd = Math.sqrt(pts.reduce((a, [x, y]) => a + (x - cx) ** 2 + (y - cy) ** 2, 0) / pts.length);
    // grid 存成逗號字串:陣列在縮排 JSON 裡一格一行,一場 61 KB、整季 24 MB;字串是 1/3
    out.push({ team: who.team, name: who.name, n: pts.length, cx: round(cx, 1), cy: round(cy, 1), spread: round(sd, 1), grid: grid.join(',') });
  }
  return out.length ? { gridX: GRID_X, gridY: GRID_Y, players: out } : null;
}

async function verify(store, results, n, teams) {
  /* 獨立來源:官網後端的 /stats/match/{fixtureId}。本季的 fixtureId 在 pulselive 快取裡,往季另外拉。 */
  const pulse = await read(join(ROOT, 'data', 'raw', 'pulselive', 'official.json'));
  const teamsById = pulse?.teams ?? {};
  let all = Object.values(pulse?.matches ?? {})
    .filter(m => m.fixtureId && m.homeId && m.awayId)
    .map(m => ({ key: `${teamsById[m.homeId]}|${teamsById[m.awayId]}`, fixtureId: m.fixtureId, homeId: m.homeId, awayId: m.awayId }));
  if (pulse?.season && pulse.season !== store.season) all = await pulseFixturesFor(store.season, teams);
  const candidates = all
    .filter(c => store.matches[c.key] && !(store.verification?.items ?? []).some(x => x.key === c.key));
  console.log(`\n▶ 用官網端點核對控球率:候選 ${candidates.length} 場,本次最多 ${n} 場`);
  const items = store.verification?.items ?? [];
  for (const c of candidates.slice(0, n)) {
    const r = await get(`${PL_API}/stats/match/${c.fixtureId}`, PL_HEADERS);
    if (!r.json) { console.log(`  ⚠ ${c.key}:${r.error}`); continue; }
    const pct = id => numOrNull((r.json.data?.[id]?.M ?? []).find(x => x.name === 'possession_percentage')?.value);
    const official = [pct(c.homeId), pct(c.awayId)];
    const fm = store.matches[c.key].possession?.all ?? [null, null];
    const diff = Math.max(Math.abs((fm[0] ?? 999) - (official[0] ?? 0)), Math.abs((fm[1] ?? 999) - (official[1] ?? 0)));
    const ok = Number.isFinite(diff) && diff <= 2;
    items.push({ key: c.key, fotmob: fm, official, diff: Number.isFinite(diff) ? diff : null, ok, at: new Date().toISOString() });
    console.log(`  ${ok ? '✓' : '✗'} ${c.key}:FotMob ${fm.join('-')}・官網 ${official.join('-')}`);
  }
  store.verification = { source: 'pulselive /stats/match possession_percentage', tolerance: 2,
    checked: items.length, agree: items.filter(x => x.ok).length, items };
}

async function main() {
  const teams = loadTeams(ROOT);
  const results = await read(join(ROOT, 'web', 'data', 'results.json'));
  if (!Array.isArray(results)) { console.log('✗ 讀不到 web/data/results.json(先跑 npm run build)'); return; }
  const seasons = seasonsOf(results);
  const season = arg('season') ?? seasons[seasons.length - 1];
  const played = results.filter(r => r.season === season && r.played && r.date <= new Date().toISOString().slice(0, 10));
  await mkdir(DIR, { recursive: true });
  const STORE = join(DIR, `${season}-game-details.json`);
  /* 逐人統計(評分、射門、傳球、對抗、防守)另存一檔:一季約 4 MB,跟主檔分開,主檔才不會每季十幾 MB。
     用西甲那個轉換器的 fotmobPlayers(canonical 逐人物件),賽後報告的「球員評分與明細」卡直接吃。 */
  const PSTORE = join(DIR, `${season}-player-stats.json`);
  const pstore = (await read(PSTORE)) ?? { season, source: 'fotmob', matches: {} };
  pstore.matches ??= {};
  const store = (await read(STORE)) ?? { season, source: 'fotmob', extractVersion: EXTRACT_VERSION, matches: {}, attempts: {} };
  store.matches ??= {}; store.attempts ??= {};
  const stale = k => store.matches[k]?.extractVersion !== EXTRACT_VERSION;
  const pending = played.filter(f => refresh || !store.matches[`${f.home}|${f.away}`] || stale(`${f.home}|${f.away}`))
    .sort((a, b) => a.date.localeCompare(b.date));
  console.log(`\n▶ FotMob 英超 ${season}:已完賽 ${played.length} 場・快取 ${Object.keys(store.matches).length} 場・待補 ${pending.length} 場・本次上限 ${limit}`);

  if (verifyN > 0) { await verify(store, results, verifyN, teams); }
  else if (pending.length && limit > 0) {
    if (dryRun) { pending.slice(0, limit).forEach(f => console.log(`  · ${f.date} ${f.home}–${f.away}`)); return; }
    const league = await get(`${BASE}/api/data/leagues?id=${LEAGUE_ID}&ccode3=GBR&season=${encodeURIComponent(fotmobSeason(season))}`,
      { referer: `${BASE}/` });
    if (!league.json) { console.log(`✗ 聯賽賽程抓不到:${league.error}`); return; }
    const { byPair, unknown } = indexFixtures(league.json, teams.codeOf);
    if (unknown.length) console.log(`  ⚠ 對不上名冊的 FotMob 隊名:${unknown.join('、')}`);
    console.log(`  FotMob 賽程 ${byPair.size} 場可對照`);
    let ok = 0, rejected = 0;
    for (const f of pending.slice(0, Math.floor((limit - 1) / 2))) {   // 一場兩個請求
      const key = `${f.home}|${f.away}`;
      const remote = byPair.get(key);
      const note = reason => { store.attempts[key] = { at: new Date().toISOString(), reason, matchId: remote?.matchId ?? null }; rejected++; console.log(`  ⚠ ${f.date} ${key}:${reason}`); };
      if (!remote) { note('FotMob 賽程找不到對應場次'); continue; }
      if (remote.date && remote.date !== f.date) { note(`日期不一致(FotMob ${remote.date})`); continue; }
      if (!remote.finished) { note('FotMob 標未完賽'); continue; }
      const r = await get(`${BASE}/api/data/matchDetails?matchId=${remote.matchId}`, { referer: `${BASE}/` });
      if (!r.json) { note(r.error); continue; }
      const rec = extract(r.json, f);
      rec.matchId = remote.matchId;
      /* 逐人統計 → 另一個檔。隊碼對照走 general 的 teamId */
      {
        const homeId = r.json?.general?.homeTeam?.id, awayId = r.json?.general?.awayTeam?.id;
        const pl = fotmobPlayers(r.json, { homeId, awayId, homeCode: f.home, awayCode: f.away });
        const unmapped = pl.__unmapped ?? []; delete pl.__unmapped;
        pstore.matches[key] = { key, season, date: f.date, players: pl, unmapped };
      }
      /* 熱區圖:第二個請求。抓不到不擋整場(控球那些照收),heat 留 null 並記原因。
         已經有熱區的場次(--refresh 重抓時)直接沿用,不再多打一個請求。 */
      rec.heat = store.matches[key]?.heat ?? null;
      if (rec.heatmapUrl && !rec.heat) {
        const h = await get(`${BASE}${rec.heatmapUrl}`, { referer: `${BASE}/` });
        if (h.json) rec.heat = heatOf(h.json, r.json, teamId => (Number(teamId) === Number(r.json?.general?.homeTeam?.id) ? f.home : Number(teamId) === Number(r.json?.general?.awayTeam?.id) ? f.away : null));
        else rec.heatError = h.error;
      }
      delete rec.heatmapUrl;
      if (!rec.providerScore || rec.providerScore[0] !== f.fh || rec.providerScore[1] !== f.fa) {
        note(`比分不符(FotMob ${rec.providerScore?.join('-') ?? '?'},本站 ${f.fh}-${f.fa})`); continue;
      }
      if (rec.possession.all?.some(v => v === null)) { note('沒有控球率欄位'); continue; }
      store.matches[key] = rec; delete store.attempts[key]; ok++;
      if (ok % 20 === 0) { await writeFile(STORE, JSON.stringify(store, null, 1)); await writeFile(PSTORE, JSON.stringify(pstore)); console.log(`  … 已收 ${ok} 場(中途存檔)`); }
    }
    console.log(`✔ 新增 ${ok} 場・退回 ${rejected} 場`);
  } else console.log('  沒有待補場次。');

  store.updatedAt = new Date().toISOString();
  store.extractVersion = EXTRACT_VERSION;
  await writeFile(STORE, JSON.stringify(store, null, 1));
  pstore.updatedAt = store.updatedAt;
  await writeFile(PSTORE, JSON.stringify(pstore));
  const n = Object.keys(store.matches).length;
  const incomplete = Object.values(store.matches).filter(m => !m.checks?.shotmapComplete).length;
  console.log(`  快取共 ${n} 場・逐人統計 ${Object.keys(pstore.matches).length} 場・shotmap 進球數對不上比分 ${incomplete} 場・本次請求 ${used}/${HARD_LIMIT}`
    + (store.verification ? `・官網核對 ${store.verification.agree}/${store.verification.checked} 場在 ±${store.verification.tolerance} 以內` : ''));
}
main().catch(e => { console.error(e); process.exit(1); });
