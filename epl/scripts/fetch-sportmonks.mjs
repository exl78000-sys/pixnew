#!/usr/bin/env node
// 從 SportMonks 補西甲球員名單欄位。
//
// 只快取 Understat 沒有的資料：背號、頭貼、生日、身高、體重、國籍、隊長與合約。
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
const TOKEN = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_KEY || process.env.SPORTMONKS_API_KEY;
const BASE = 'https://api.sportmonks.com/v3';
const OUT = join(ROOT, 'data', 'raw', 'sportmonks-la-liga');
const FORCE = process.argv.includes('--force');
const DELAY = 350;
const MAX_REQUESTS = Number(process.argv.find(x => x.startsWith('--max-requests='))?.split('=')[1] ?? 80);
const TTL_DAYS = 7;
const SEASONS = [
  { label: '2026-27', id: 27965 },
  { label: '2025-26', id: 25659 },
];
const FETCH_MATCHES = !process.argv.includes('--no-matches');
const MAX_DETAILS = Number(process.argv.find(x => x.startsWith('--max-details='))?.split('=')[1] ?? 20);

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
const stale = store => {
  if (!store?.retrievedAt) return true;
  const age = Date.now() - Date.parse(store.retrievedAt);
  return !Number.isFinite(age) || age > TTL_DAYS * 86400000;
};

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

async function readStore(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function syncSeason(T, season) {
  const file = join(OUT, `${season.label}-squads.json`);
  const previous = await readStore(file);
  if (!FORCE && previous?.season === season.label && !stale(previous)
      && Object.keys(previous.squads ?? {}).length) {
    console.log(`  · ${season.label} SportMonks 名單快取仍新鮮，跳過（--force 可重抓）`);
    return previous;
  }

  console.log(`▶ SportMonks ${season.label}（season=${season.id}）`);
  const teamRows = rows(await get(`/football/teams/seasons/${season.id}?per_page=100`));
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
    teams[code] = { id: team.id, name: team.name, shortCode: team.short_code ?? null };
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
    note: 'SportMonks 只作 Understat 球員欄位補充；逐場資料另有獨立快取，需通過隊伍與比分核對。',
  };
  await writeFile(file, JSON.stringify(store, null, 2) + '\n');
  console.log(`  ✔ ${file}`);
  return store;
}

async function syncCurrentMatches(T, seasonStore) {
  const season = SEASONS.find(x => x.label === '2026-27');
  const file = join(OUT, `${season.label}-match-details.json`);
  const previous = await readStore(file);
  const local = loadMatches({ root: ROOT, competition: 'esp.1', season: season.label, codeOf: T.codeOf, rawDir: 'openfootball-la-liga' });
  const played = local.filter(x => x.played);
  const teamCodeById = new Map(Object.entries(seasonStore.teams ?? {}).map(([code, t]) => [String(t.id), code]));
  const details = { ...(previous?.matches ?? {}) };

  // 只抓本季已完賽且尚未永久快取的場次；不以每次開頁或 build 觸發 API。
  let fixtureRows = [];
  for (let page = 1; page <= 5; page++) {
    const batch = rows(await get(`/football/fixtures?filters=fixtureSeasons:${season.id}&include=participants&per_page=100&page=${page}`));
    fixtureRows.push(...batch);
    if (batch.length < 100) break;
  }
  const candidates = [];
  for (const sf of fixtureRows) {
    const participants = rows(sf.participants);
    const codes = participants.map(p => teamCodeById.get(String(p.id)) || providerTeamCode(T, p)).filter(Boolean);
    const date = String(sf.starting_at ?? '').slice(0, 10);
    const localMatch = played.find(m => m.date === date && codes.includes(m.home) && codes.includes(m.away));
    if (!localMatch) continue;
    const key = `${localMatch.home}|${localMatch.away}`;
    if (details[key]) continue;
    candidates.push({ sf, localMatch, key });
  }
  console.log(`▶ SportMonks 賽後詳情：本季已完賽 ${played.length} 場・待補 ${candidates.length} 場・本次最多 ${MAX_DETAILS} 場`);
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
    coverage: { cached: Object.keys(details).length, fetchedThisRun: fetched },
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
  const T = loadTeams(ROOT, { file: 'teams-la-liga.json' });
  const stores = [];
  for (const season of SEASONS) {
    try { stores.push(await syncSeason(T, season)); }
    catch (error) { console.log(`  ⚠ ${season.label} 未完成：${error.message}`); }
  }
  if (FETCH_MATCHES) {
    const current = stores.find(x => x?.season === '2026-27');
    if (current) {
      try { await syncCurrentMatches(T, current); }
      catch (error) { console.log(`  ⚠ 2026-27 賽後詳情未完成：${error.message}`); }
    }
  }
  console.log(`\nSportMonks 名單同步完成：${stores.filter(Boolean).length}/${SEASONS.length} 季・使用 ${requests} 個請求`);
}

main().catch(error => { console.error(`✗ SportMonks 同步失敗：${error.message}`); process.exitCode = 1; });
