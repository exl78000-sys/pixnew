#!/usr/bin/env node
// 小批量快取西甲已完賽正式先發/陣型資料。
//
//   npm run laliga:lineups                 # 預設最多 10 場
//   npm run laliga:lineups -- --limit=3    # 先小量試跑
//   npm run laliga:lineups -- --dry-run    # 只列出待補場次,不連線
//
// FotMob 是網站公開資料端點,不是穩定的官方 API。這支刻意不放進每 15 分鐘的
// 即時流程:成功資料永久快取,每日硬上限 20 次,失敗場次記錄原因,避免重複燒額度。
// 目前只快取 canonical lineup 所需欄位;完整賽後統計仍由既有 API-Football 管線處理。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMatches } from './lib/adapters/openfootball.mjs';
import { loadTeams } from './lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://www.fotmob.com';
const DEFAULT_SEASON = '2026-27';
const DEFAULT_LIMIT = 10;
const DAILY_LIMIT = 20;
const DELAY = 1200;
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.split('=').slice(1).join('=');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const season = arg('season') ?? DEFAULT_SEASON;
const fotmobSeason = `${season.slice(0, 4)}/${Number(season.slice(0, 4)) + 1}`;
const limit = Math.max(0, Number(arg('limit') ?? DEFAULT_LIMIT));
const dryRun = process.argv.includes('--dry-run');
const rawDir = join(ROOT, 'data', 'raw', 'fotmob-la-liga');
const storeFile = join(rawDir, `${season}-lineups.json`);

const emptyStore = () => ({
  version: 1, source: 'fotmob/enetpulse', season, updatedAt: null, matches: {}, attempts: {},
});

async function loadStore() {
  if (!existsSync(storeFile)) return emptyStore();
  try {
    const parsed = JSON.parse(await readFile(storeFile, 'utf8'));
    if (parsed.season !== season) return emptyStore();
    return { ...emptyStore(), ...parsed, matches: parsed.matches ?? {}, attempts: parsed.attempts ?? {} };
  } catch { return emptyStore(); }
}

class Budget {
  constructor() { this.used = 0; }
  canSpend() { return this.used < DAILY_LIMIT; }
  spend() { this.used++; }
}

async function get(path, budget) {
  if (!budget.canSpend()) return { error: `已達每日 ${DAILY_LIMIT} 次上限` };
  if (budget.used) await sleep(DELAY);
  budget.spend();
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(20000),
      headers: { accept: 'application/json', referer: `${BASE}/`, 'user-agent': UA },
    });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    try { return { json: JSON.parse(text), status: res.status }; }
    catch { return { error: '回應不是 JSON', status: res.status }; }
  } catch (err) { return { error: err.message }; }
}

const canonicalPlayer = p => ({
  providerId: p?.id ?? null,
  name: p?.name ?? '',
  positionId: p?.positionId ?? null,
  usualPlayingPositionId: p?.usualPlayingPositionId ?? null,
  shirt: p?.shirtNumber ?? null,
  captain: p?.isCaptain === true,
  countryCode: p?.countryCode ?? null,
  horizontalLayout: p?.horizontalLayout ?? null,
  verticalLayout: p?.verticalLayout ?? null,
  rating: Number.isFinite(p?.performance?.rating) ? p.performance.rating : null,
  performance: p?.performance ?? null,
});

const canonicalSide = side => ({
  providerId: side?.id ?? null,
  name: side?.name ?? '',
  formation: side?.formation ?? null,
  rating: Number.isFinite(side?.rating) ? side.rating : null,
  starters: (side?.starters ?? []).map(canonicalPlayer),
  substitutes: (side?.substitutes ?? side?.bench ?? []).map(canonicalPlayer),
});

function matchDate(utcTime) { return String(utcTime ?? '').slice(0, 10); }

function buildFixtureIndex(fixtures, codeOf) {
  const byPair = new Map();
  for (const item of fixtures?.allMatches ?? []) {
    const home = codeOf(item.home?.name), away = codeOf(item.away?.name);
    if (!home || !away || !item.id) continue;
    byPair.set(`${home}|${away}`, {
      matchId: String(item.id), date: matchDate(item.status?.utcTime),
      home, away, score: item.status?.scoreStr ?? null,
      finished: item.status?.finished === true,
    });
  }
  return byPair;
}

function completedMatches(seasonMatches, store) {
  return seasonMatches
    .filter(m => m.played && m.date <= new Date().toISOString().slice(0, 10))
    .filter(m => !store.matches[`${m.home}|${m.away}`])
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function save(store) {
  await mkdir(rawDir, { recursive: true });
  store.updatedAt = new Date().toISOString();
  await writeFile(storeFile, JSON.stringify(store, null, 1));
}

async function main() {
  const teams = loadTeams(ROOT, { file: 'teams-la-liga.json' });
  const seasonMatches = loadMatches({
    root: ROOT, competition: 'esp.1', season, codeOf: teams.codeOf,
    rawDir: 'openfootball-la-liga',
  });
  const store = await loadStore();
  const pending = completedMatches(seasonMatches, store);
  console.log(`▶ FotMob 西甲 ${season}：已完賽 ${seasonMatches.filter(m => m.played).length} 場・永久快取 ${Object.keys(store.matches).length} 場`);
  if (!pending.length) { console.log('  沒有待補場次。'); return; }
  console.log(`  待補 ${pending.length} 場，本次上限 ${Math.min(limit, pending.length, DAILY_LIMIT - 2)} 場・每日總上限 ${DAILY_LIMIT} 次請求`);
  if (dryRun) {
    for (const m of pending.slice(0, limit)) console.log(`  · ${m.date} ${m.home}–${m.away}`);
    return;
  }

  const budget = new Budget();
  const directory = await get('/api/data/allLeagues', budget);
  const allLeagues = [
    ...(directory.json?.popular ?? []),
    ...(directory.json?.international ?? []),
    ...(directory.json?.countries ?? []).flatMap(c => c.leagues ?? []),
  ];
  const laLiga = allLeagues.find(x => /la\s*liga/i.test(x?.name ?? ''));
  if (!laLiga?.id) throw new Error(directory.error ?? '找不到 FotMob LaLiga leagueId');

  const league = await get(`/api/data/leagues?id=${laLiga.id}&ccode3=ESP&season=${encodeURIComponent(fotmobSeason)}`, budget);
  const index = buildFixtureIndex(league.json?.fixtures, teams.codeOf);
  if (!index.size) throw new Error(league.error ?? 'FotMob 聯賽回應沒有可對照賽程');

  let fetched = 0, skipped = 0;
  for (const fixture of pending.slice(0, limit)) {
    if (!budget.canSpend()) { console.log(`  ⚠ 已達每日 ${DAILY_LIMIT} 次上限,停止`); break; }
    const key = `${fixture.home}|${fixture.away}`;
    const remote = index.get(key);
    if (!remote || !remote.finished || (remote.date && remote.date !== fixture.date)) {
      store.attempts[key] = { at: new Date().toISOString(), reason: remote ? '日期或完賽狀態不一致' : 'FotMob 賽程找不到對應場次' };
      skipped++;
      console.log(`  ⚠ ${fixture.date} ${fixture.home}–${fixture.away}: ${store.attempts[key].reason}`);
      continue;
    }
    const detail = await get(`/api/data/matchDetails?matchId=${encodeURIComponent(remote.matchId)}`, budget);
    const lineup = detail.json?.content?.lineup;
    const home = canonicalSide(lineup?.homeTeam), away = canonicalSide(lineup?.awayTeam);
    const complete = [home, away].every(side => side.name && side.formation && side.starters.length === 11);
    if (!complete) {
      store.attempts[key] = { at: new Date().toISOString(), reason: detail.error ?? '先發或陣型欄位不完整', matchId: remote.matchId };
      skipped++;
      console.log(`  ⚠ ${fixture.date} ${fixture.home}–${fixture.away}: ${store.attempts[key].reason}`);
      continue;
    }
    store.matches[key] = {
      matchId: remote.matchId, season, date: fixture.date, home: fixture.home, away: fixture.away,
      score: { home: fixture.fh, away: fixture.fa }, source: 'fotmob/enetpulse',
      fetchedAt: new Date().toISOString(), lineup: { home, away },
      coverage: {
        formations: true, starters: true,
        positions: home.starters.every(p => p.positionId != null) && away.starters.every(p => p.positionId != null),
        layouts: home.starters.every(p => p.horizontalLayout || p.verticalLayout) && away.starters.every(p => p.horizontalLayout || p.verticalLayout),
        ratings: home.starters.some(p => p.rating != null) || away.starters.some(p => p.rating != null),
      },
    };
    delete store.attempts[key];
    fetched++;
    console.log(`  ✓ ${fixture.date} ${fixture.home}–${fixture.away}: ${home.formation} / ${away.formation}`);
    await save(store);
  }
  await save(store);
  console.log(`✔ 新增 ${fetched} 場・跳過 ${skipped} 場・永久快取共 ${Object.keys(store.matches).length} 場・本次請求 ${budget.used}/${DAILY_LIMIT}`);
  console.log(`  檔案：${storeFile}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
