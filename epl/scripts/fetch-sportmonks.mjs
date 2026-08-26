#!/usr/bin/env node
// 從 SportMonks 同步英超／西甲球員名單與已完賽資料。
//
// 名單只快取穩定身分欄位：背號、頭貼、生日、身高、體重、國籍、隊長與合約。
// 逐場 lineups / formations 會在已完賽且比分核對通過後寫入獨立快取，
// build 再透過 adapter 轉成本站 canonical 賽後格式；不把探測回應直接當正式資料。
// 沒有 token 時安全略過；不會把金鑰寫入檔案或 log。
//
//   npm run sportmonks:sync
//   npm run sportmonks:sync -- --force
//
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { loadMatches } from './lib/adapters/openfootball.mjs';
import { normaliseSportmonksMatch } from './lib/adapters/sportmonks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = key => process.argv.find(x => x.startsWith(`--${key}=`))?.split('=')[1];
const TOKEN = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_KEY || process.env.SPORTMONKS_API_KEY;
const BASE = 'https://api.sportmonks.com/v3';
const FORCE = process.argv.includes('--force');
const DELAY = 350;
const MAX_REQUESTS = Number(process.argv.find(x => x.startsWith('--max-requests='))?.split('=')[1] ?? 80);
const TTL_DAYS = 7;
const FETCH_MATCHES = !process.argv.includes('--no-matches');
const MAX_DETAILS = Number(process.argv.find(x => x.startsWith('--max-details='))?.split('=')[1] ?? 20);
const MAX_COACH_DETAILS = Number(process.argv.find(x => x.startsWith('--max-coach-details='))?.split('=')[1] ?? 20);
const COACH_TTL_DAYS = 30;

const LEAGUE = arg('league') ?? 'es1';
const CONFIG = LEAGUE === 'pl'
  ? {
      key: 'pl', leagueId: Number(process.env.SPORTMONKS_EPL_LEAGUE_ID ?? 8),
      teamsFile: 'teams.json', outputDir: 'sportmonks-epl', competition: 'eng.1',
      note: 'SportMonks 英超主要球員／賽後資料；FPL 僅保留作表現統計與賽程鏡像。',
    }
  : {
      key: 'es1', leagueId: Number(process.env.SPORTMONKS_LALIGA_LEAGUE_ID ?? 564),
      teamsFile: 'teams-la-liga.json', outputDir: 'sportmonks-la-liga', competition: 'esp.1',
      note: 'SportMonks 西甲球員名單補充；逐場資料需通過隊伍與比分核對。',
    };
const OUT = join(ROOT, 'data', 'raw', CONFIG.outputDir);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let requests = 0;

async function get(path) {
  if (requests >= MAX_REQUESTS) throw new Error(`已達本次 ${MAX_REQUESTS} 個請求上限`);
  if (requests) await sleep(DELAY);
  requests++;
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { accept: 'application/json' },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} 回傳不是 JSON`); }
  if (!res.ok || body?.errors || body?.message && !body?.data) {
    const detail = body?.message || JSON.stringify(body?.errors ?? {}).slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return body?.data ?? null;
}

const rows = value => Array.isArray(value) ? value : [];
const relatedRows = value => Array.isArray(value) ? value
  : Array.isArray(value?.data) ? value.data
    : Array.isArray(value?.data?.data) ? value.data.data
    : value && typeof value === 'object' ? [value] : [];
const stale = store => {
  if (!store?.retrievedAt) return true;
  const age = Date.now() - Date.parse(store.retrievedAt);
  return !Number.isFinite(age) || age > TTL_DAYS * 86400000;
};

const seasonLabel = value => {
  const m = String(value ?? '').match(/(20\d{2})\s*[\/-]\s*(20\d{2})/);
  return m ? `${m[1]}-${m[2].slice(-2)}` : String(value ?? '');
};

async function resolveSeasons() {
  // 西甲保留既有、已核對過的 season id；英超則依 token 實際可用賽季動態解析，
  // 避免把不同方案的 season id 硬寫死，也不會把不存在的賽季誤當成成功。
  if (CONFIG.key === 'es1') return [
    { label: '2026-27', id: 27965 },
    { label: '2025-26', id: 25659 },
  ];
  const seasonRows = rows(await get(`/football/seasons?filters=seasonLeagues:${CONFIG.leagueId}&per_page=50`));
  const usable = seasonRows.map(row => ({
    label: seasonLabel(row.name), id: row.id,
    current: row.is_current === true, finished: row.finished,
  })).filter(row => /^20\d{2}-\d{2}$/.test(row.label) && row.id != null);
  const wanted = ['2026-27', '2025-26'];
  const selected = wanted.map(label => usable.find(row => row.label === label)).filter(Boolean);
  if (selected.length) return selected;
  const sorted = usable.sort((a, b) => String(b.label).localeCompare(String(a.label)));
  return sorted.slice(0, 2);
}

// 供應商偶爾會在 common_name 回傳歷史／別名，若直接拿最後一欄對照，
// 可能把 Deportivo A Coruña 覆蓋到 Villarreal。先採用完整隊名的明確規則，
// 再退回本站別名表；同一個 provider id 不會被另一隊覆蓋。
function providerTeamCode(T, team) {
  const name = String(team?.name ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/deportivo.*coruna/.test(name)) return 'DEP';
  if (/villarreal/.test(name)) return 'VIL';
  return T.codeOf(team?.name) || T.codeOf(team?.short_code) || T.codeOf(team?.common_name);
}

function normaliseCoach(coach, seasonId) {
  if (!coach || typeof coach !== 'object') return null;
  // 依 endpoint 不同，教練資料可能直接放在關聯列，也可能包在
  // coach/person/data 內；先攤平外層，避免只拿到關聯列的 id。
  const profile = [coach.coach, coach.person, coach.data].find(x => x && typeof x === 'object') ?? coach;
  const name = profile.display_name ?? profile.name
    ?? ([profile.firstname, profile.lastname].filter(Boolean).join(' ') || null);
  const id = profile.id ?? coach.coach_id ?? coach.id ?? null;
  if (!name && id == null) return null;
  return {
    id,
    name,
    firstName: profile.firstname ?? profile.first_name ?? null,
    lastName: profile.lastname ?? profile.last_name ?? null,
    imagePath: profile.image_path ?? null,
    nationalityId: profile.nationality_id ?? profile.country_id ?? null,
    seasonId: profile.season_id ?? coach.season_id ?? seasonId,
    active: coach.active !== false,
    from: coach.started_at ?? coach.start ?? coach.from ?? null,
    to: coach.ended_at ?? coach.end ?? coach.to ?? null,
  };
}

function coachIdsFromStore(store) {
  return [...new Set(Object.values(store?.teams ?? {}).flatMap(team =>
    (Array.isArray(team?.coaches) ? team.coaches : [])
      // SportMonks 會把在任教練的合約終點設成未來日期；active 才是
      // 目前身分旗標，不能用「沒有 to」判斷在任。
      .filter(c => c?.active !== false && c?.id != null)
      .map(c => String(c.id))))];
}

async function syncCoachDetails(store, season) {
  const file = join(OUT, 'coach-details.json');
  const previous = await readStore(file);
  const details = { ...(previous?.details ?? {}) };
  const ids = coachIdsFromStore(store);
  const now = Date.now();
  const pending = ids.filter(id => {
    const row = details[id];
    if (!row?.attemptedAt) return true;
    const ttl = row.name ? COACH_TTL_DAYS : 7;
    return now - Date.parse(row.attemptedAt) > ttl * 86400000;
  });
  let fetched = 0;
  console.log(`▶ SportMonks 教練詳情：${ids.length} 個去重 ID・待補 ${pending.length} 個・本次最多 ${MAX_COACH_DETAILS} 個`);
  for (const id of pending.slice(0, MAX_COACH_DETAILS)) {
    try {
      const raw = await get(`/football/coaches/${encodeURIComponent(id)}`);
      const coach = normaliseCoach(raw, season.id);
      details[id] = {
        ...(coach ?? { id: Number(id), name: null }),
        attemptedAt: new Date().toISOString(),
      };
      fetched++;
      console.log(`  ${id}：${coach?.name ? '已取得姓名' : '回應未提供姓名'}`);
    } catch (error) {
      details[id] = { id: Number(id), name: null, attemptedAt: new Date().toISOString(), error: error.message };
      console.log(`  ⚠ ${id} 詳情失敗：${error.message}`);
    }
  }
  const out = {
    source: 'SportMonks',
    sourceUrl: 'https://api.sportmonks.com/v3/football/coaches/{coach_id}',
    retrievedAt: new Date().toISOString(),
    providerSeason: season.id,
    details,
    coverage: { ids: ids.length, cached: Object.keys(details).length, fetchedThisRun: fetched },
    note: '只以去重 coach ID 補抓詳情；姓名未回傳時保留空值，不以人工資料猜測。',
  };
  await writeFile(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`  ✔ ${file}`);
  return out;
}

async function readStore(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function syncSeason(T, season) {
  const file = join(OUT, `${season.label}-squads.json`);
  const previous = await readStore(file);
  const previousVillarrealName = String(previous?.teams?.VIL?.name ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const hasTeamMappingDrift = /deportivo.*coruna/.test(previousVillarrealName);
  // 教練欄位是後續版本才加入的 include；舊快取即使仍在 TTL 內也要重抓一次，
  // 否則新的資料契約會永遠等到七天後才出現。
  const hasCoachField = Object.keys(previous?.teams ?? {}).length > 0
    && Object.values(previous.teams).every(team => Array.isArray(team?.coaches));
  if (!FORCE && previous?.season === season.label && !stale(previous)
      && Object.keys(previous.squads ?? {}).length && !hasTeamMappingDrift && hasCoachField) {
    console.log(`  · ${season.label} SportMonks 名單快取仍新鮮，跳過（--force 可重抓）`);
    return previous;
  }
  if (hasTeamMappingDrift) console.log(`  ⚠ ${season.label} 發現錯隊名快取，強制重新抓取`);

  console.log(`▶ SportMonks ${season.label}（season=${season.id}）`);
  // coaches 是球隊端點的既有 include，不增加請求次數；資料不足時仍保留球隊名單。
  const teamRows = rows(await get(`/football/teams/seasons/${season.id}?include=coaches&per_page=100`));
  const teams = {};
  for (const team of teamRows) {
    const code = providerTeamCode(T, team);
    if (!code) {
      console.log(`  ⚠ 球隊對不上本站隊碼：${team.name ?? '(無名)'}`);
      continue;
    }
    if (teams[code] && String(teams[code].id) !== String(team.id)) {
      console.log(`  ⚠ 球隊代碼衝突 ${code}：保留 ${teams[code].name}，略過 ${team.name ?? '(無名)'}`);
      continue;
    }
    const coaches = relatedRows(team.coaches ?? team.coach)
      .map(coach => normaliseCoach(coach, season.id)).filter(Boolean);
    teams[code] = { id: team.id, name: team.name, shortCode: team.short_code ?? null, coaches };
  }
  if (!Object.keys(teams).length) throw new Error('SportMonks 沒有回傳可對應的西甲球隊');

  const squads = { ...(previous?.squads ?? {}) };
  let loaded = 0;
  for (const [code, team] of Object.entries(teams)) {
    try {
      const data = await get(`/football/squads/teams/${team.id}?include=player`);
      const list = rows(data).filter(row => row?.player?.id != null || row?.id != null);
      if (list.length) { squads[code] = list; loaded++; }
      console.log(`  ${code} ${team.name}：${list.length} 人`);
    } catch (error) {
      console.log(`  ⚠ ${code} 名單失敗：${error.message}`);
    }
  }

  const store = {
    season: season.label,
    providerSeason: season.id,
    source: 'SportMonks',
    sourceUrl: 'https://api.sportmonks.com/v3/football/squads/teams/{team_id}?include=player',
    retrievedAt: new Date().toISOString(),
    teams,
    squads,
    coverage: {
      teams: Object.keys(teams).length,
      squads: Object.keys(squads).length,
      loadedThisRun: loaded,
      players: Object.values(squads).reduce((n, list) => n + list.length, 0),
    },
    note: CONFIG.note,
  };
  await writeFile(file, JSON.stringify(store, null, 2) + '\n');
  console.log(`  ✔ ${file}`);
  return store;
}

async function syncCurrentMatches(T, seasonStore, season) {
  const file = join(OUT, `${season.label}-match-details.json`);
  const previous = await readStore(file);
  const local = loadMatches({ root: ROOT, competition: CONFIG.competition, season: season.label, codeOf: T.codeOf,
    rawDir: CONFIG.key === 'es1' ? 'openfootball-la-liga' : 'openfootball' });
  const played = local.filter(x => x.played);
  const teamCodeById = new Map(Object.entries(seasonStore.teams ?? {}).map(([code, t]) => [String(t.id), code]));
  const details = { ...(previous?.matches ?? {}) };

  // 只抓本季已完賽且尚未永久快取的場次；不以每次開頁或 build 觸發 API。
  let fixtureRows = [];
  for (let page = 1; page <= 5; page++) {
    // SportMonks v3 在不同邊緣節點可能回傳純陣列或 { data: [...] }；
    // 兩者都視為同一份 fixtures，避免把有效賽程誤判成 0 場。
    const batch = relatedRows(await get(`/football/fixtures?filters=fixtureSeasons:${season.id}&include=participants&per_page=100&page=${page}`));
    fixtureRows.push(...batch);
    if (batch.length < 100) break;
  }
  const candidates = [];
  let fixturesWithParticipants = 0;
  let fixturesWithMappedTeams = 0;
  let fixturesWithLocalPair = 0;
  let fixturesWithLocalDate = 0;
  const dateDistance = (a, b) => {
    const left = Date.parse(`${a}T00:00:00Z`), right = Date.parse(`${b}T00:00:00Z`);
    return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) / 86400000 : Infinity;
  };
  for (const sf of fixtureRows) {
    // include 關聯在部分 SportMonks 節點會再包一層 data；不能因此把每場
    // 的參賽隊伍誤判成空陣列。
    const participants = relatedRows(sf.participants);
    if (participants.length) fixturesWithParticipants++;
    const codes = participants.map(p => teamCodeById.get(String(p.id)) || providerTeamCode(T, p)).filter(Boolean);
    if (codes.length >= 2) fixturesWithMappedTeams++;
    const date = String(sf.starting_at ?? '').slice(0, 10);
    if (played.some(m => codes.includes(m.home) && codes.includes(m.away))) fixturesWithLocalPair++;
    if (played.some(m => dateDistance(m.date, date) <= 1)) fixturesWithLocalDate++;
    // starting_at 可能以 UTC 日期呈現，而 openfootball 使用球場當地日期；
    // 同一季同一對球隊只會有一場，允許一天時差仍要求兩隊都對上。
    const localMatch = played.find(m => dateDistance(m.date, date) <= 1
      && codes.includes(m.home) && codes.includes(m.away));
    if (!localMatch) continue;
    const key = `${localMatch.home}|${localMatch.away}`;
    if (details[key]) continue;
    candidates.push({ sf, localMatch, key });
  }
  console.log(`▶ SportMonks ${CONFIG.key === 'pl' ? '英超' : '西甲'}賽後詳情：${season.label} 已完賽 ${played.length} 場・待補 ${candidates.length} 場・本次最多 ${MAX_DETAILS} 場`);
  let fetched = 0;
  for (const { sf, localMatch, key } of candidates.slice(0, MAX_DETAILS)) {
    try {
      const raw = await get(`/football/fixtures/${sf.id}?include=participants;lineups.details.type;formations;events.type;statistics.type;xGFixture;sidelined.sideline`);
      const detail = normaliseSportmonksMatch(raw, { codeOf: T.codeOf, fixture: localMatch, teamCodeById, season: season.label });
      if (!detail || detail.score.home !== localMatch.fh || detail.score.away !== localMatch.fa) {
        console.log(`  ⚠ ${key} fixture ${sf.id} 未通過比分／隊伍核對，略過`);
        continue;
      }
      details[key] = detail;
      fetched++;
      console.log(`  ${key}：${detail.coverage.lineups ? '正式先發' : '無完整先發'}・${detail.coverage.ratings ? '有評分' : '無評分'}・${detail.coverage.teamStatistics ? '有球隊統計' : '無球隊統計'}`);
    } catch (error) { console.log(`  ⚠ ${key} 失敗：${error.message}`); }
  }
  const out = {
    season: season.label, providerSeason: season.id, source: 'SportMonks',
    sourceUrl: 'https://api.sportmonks.com/v3/football/fixtures/{fixture_id}',
    retrievedAt: new Date().toISOString(), matches: details,
    coverage: {
      cached: Object.keys(details).length, fetchedThisRun: fetched,
      localPlayed: played.length, providerFixtures: fixtureRows.length, candidates: candidates.length,
      fixturesWithParticipants, fixturesWithMappedTeams, fixturesWithLocalPair, fixturesWithLocalDate,
    },
    note: '與 openfootball 比分逐場核對後才發布；速度、距離、衝刺不在本資料源。',
  };
  await writeFile(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`  ✔ ${file}`);
  return out;
}

async function main() {
  if (!TOKEN) {
    console.log('⚠ 未設定 SPORTMONKS_TOKEN（或 SPORTMONKS_KEY / SPORTMONKS_API_KEY），略過。');
    return;
  }
  await mkdir(OUT, { recursive: true });
  const T = loadTeams(ROOT, { file: CONFIG.teamsFile });
  const seasons = await resolveSeasons();
  if (!seasons.length) throw new Error(`SportMonks 找不到 ${CONFIG.key === 'pl' ? '英超' : '西甲'} 可用賽季`);
  const stores = [];
  for (const season of seasons) {
    try { stores.push(await syncSeason(T, season)); }
    catch (error) { console.log(`  ⚠ ${season.label} 未完成：${error.message}`); }
  }
  const currentSeason = seasons.find(x => x.label === '2026-27') ?? seasons[0];
  const currentStore = stores.find(x => x?.season === currentSeason.label);
  if (currentStore) {
    try { await syncCoachDetails(currentStore, currentSeason); }
    catch (error) { console.log(`  ⚠ ${currentSeason.label} 教練詳情未完成：${error.message}`); }
  }
  if (FETCH_MATCHES) {
    const current = currentStore;
    if (current) {
      try { await syncCurrentMatches(T, current, currentSeason); }
      catch (error) { console.log(`  ⚠ ${currentSeason.label} 賽後詳情未完成：${error.message}`); }
    }
  }
  console.log(`\nSportMonks ${CONFIG.key === 'pl' ? '英超' : '西甲'}同步完成：${stores.filter(Boolean).length}/${seasons.length} 季・使用 ${requests} 個請求`);
}

main().catch(error => { console.error(`✗ SportMonks 同步失敗：${error.message}`); process.exitCode = 1; });
