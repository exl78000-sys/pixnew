#!/usr/bin/env node
// 低頻核對 LaLiga 官方球隊 staff 頁的現任主教練。
// 只寫入本地快取；開頁與 build 都不連外。官方頁沒有主教練姓名時不猜測。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEASON = '2026-27';
const BASE = 'https://www.laliga.com';
const API_BASE = 'https://apim.laliga.com/public-service';
const DIRECTORY_URL = `${BASE}/en-US/laliga-easports/clubs`;
// LaLiga 網站前端公開使用的 APIM subscription key；不是帳號 token，亦不授予管理權限。
const PUBLIC_API_KEY = 'c13c3a8e2f6b46da9c5c425cf61fab3e';
const STORE_FILE = join(ROOT, 'data', 'raw', 'laliga-official', `${SEASON}-coaches.json`);
const TTL_MS = 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';

const slugFallback = {
  'd-alaves': 'ALA', 'deportivo-alaves': 'ALA', 'athletic-club': 'ATH',
  'club-atletico-de-madrid': 'ATM', 'atletico-de-madrid': 'ATM', 'fc-barcelona': 'BAR', 'real-betis': 'BET',
  'rc-celta': 'CEL', 'rc-celta-de-vigo': 'CEL', 'rc-deportivo': 'DEP',
  'deportivo-la-coruna': 'DEP', 'elche-c-f': 'ELC', 'elche-cf': 'ELC', 'rcd-espanyol': 'ESP',
  'getafe-cf': 'GET', 'girona-fc': 'GIR', 'levante-ud': 'LEV', 'malaga-cf': 'MAL',
  'rcd-mallorca': 'MLL', 'c-a-osasuna': 'OSA', 'ca-osasuna': 'OSA', 'real-oviedo': 'OVI',
  'r-racing-club': 'RAC', 'racing-santander': 'RAC', 'rayo-vallecano': 'RAY', 'real-madrid': 'RMA',
  'real-sociedad': 'RSO', 'sevilla-fc': 'SEV', 'valencia-cf': 'VAL',
  'villarreal-cf': 'VIL',
};

const emptyStore = () => ({
  version: 1, source: 'laliga.com', season: SEASON, retrievedAt: null,
  sourceUrl: DIRECTORY_URL, coaches: [], attempts: {}, coverage: { pages: 0, coaches: 0, errors: 0 },
});

async function loadStore() {
  if (!existsSync(STORE_FILE)) return emptyStore();
  try {
    const raw = JSON.parse(await readFile(STORE_FILE, 'utf8'));
    return { ...emptyStore(), ...raw, coaches: raw.coaches ?? [], attempts: raw.attempts ?? {} };
  } catch { return emptyStore(); }
}

export function parseClubSlugs(html) {
  const out = [];
  const seen = new Set();
  const re = /href=["']\/en-US\/clubs\/([^/"']+)\/squad["']/gi;
  for (const match of String(html ?? '').matchAll(re)) {
    const slug = match[1];
    if (!seen.has(slug)) { seen.add(slug); out.push(slug); }
  }
  return out;
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html ?? '').matchAll(re)) {
    try { out.push(JSON.parse(match[1].trim())); } catch { /* malformed block is not authoritative */ }
  }
  return out;
}

const coachRole = value => /^(head\s+)?coach$/i.test(String(value ?? '').trim());

export function parseOfficialCoach(html) {
  const blocks = jsonLdBlocks(html);
  const roots = blocks.flatMap(x => Array.isArray(x) ? x : [x]).filter(Boolean);
  for (const root of roots) {
    const rows = Array.isArray(root.coach) ? root.coach : [];
    const coach = rows.find(row => coachRole(row?.jobTitle) && row?.name);
    if (!coach) continue;
    return {
      name: String(coach.name).trim(),
      officialRole: String(coach.jobTitle ?? 'Coach').trim(),
      officialPlayerUrl: coach.url ?? null,
      imagePath: coach.image && coach.image !== 'null' ? coach.image : null,
      teamName: root.memberOf?.name ?? root.name ?? null,
    };
  }
  return null;
}

export function parseOfficialCoachPayload(payload) {
  const rows = Array.isArray(payload?.squads) ? payload.squads : [];
  const row = rows.find(item => item?.current !== false
    && /^(coach|head coach)$/i.test(String(item?.role?.name ?? item?.position?.name ?? '').trim())
    && item?.person?.name);
  if (!row) return null;
  const image = row.photos?.['002']?.['64x64'] ?? row.photos?.['001']?.['64x70'] ?? null;
  return {
    name: String(row.person.name).trim(),
    officialRole: String(row.role?.name ?? row.position?.name ?? 'Coach').trim(),
    officialPlayerUrl: row.person.slug ? `${BASE}/en-US/player/${row.person.slug}` : null,
    imagePath: image && !/\/default-player\//i.test(image) ? image : null,
    teamName: row.team?.nickname ?? row.team?.boundname ?? row.team?.name ?? null,
  };
}

const normal = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function teamCodeFor(slug, teamName, teams) {
  const direct = slugFallback[String(slug).toLowerCase()];
  if (direct) return direct;
  if (teamName) {
    const code = teams.codeOf(teamName);
    if (code) return code;
  }
  const key = normal(slug).replace(/\s+/g, '');
  return teams.list.find(team => [team.en, team.of, ...(team.alias ?? [])]
    .some(value => normal(value).replace(/\s+/g, '') === key))?.code ?? null;
}

function coachRow(team, coach, sourceUrl) {
  return {
    team, name: coach.name, zh: null, nat: null, confidence: 'high', formation: null, style: [],
    note: '現任教練姓名來自 LaLiga 官方球隊 staff 頁；任期、戰績與戰術註解尚未人工核對。',
    since: null, tenureDays: null, seasonRecord: null, allRecord: null, spells: [], predecessors: [],
    source: 'LaLiga', sourceUrl, providerId: null, providerSeason: null,
    imagePath: coach.imagePath ?? null, officialRole: coach.officialRole ?? 'Coach',
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json', 'user-agent': UA,
      'content-language': 'en', 'country-code': 'ES',
      'ocp-apim-subscription-key': PUBLIC_API_KEY,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function main() {
  const store = await loadStore();
  const force = process.argv.includes('--force');
  const age = store.retrievedAt ? Date.now() - Date.parse(store.retrievedAt) : Infinity;
  if (!force && Number.isFinite(age) && age >= 0 && age < TTL_MS && store.coverage?.pages >= 15) {
    console.log(`▶ LaLiga 官方教練快取仍有效：${store.coverage.coaches}/${store.coverage.pages} 頁，24 小時內略過`);
    return store;
  }

  const teams = loadTeams(ROOT, { file: 'teams-la-liga.json' });
  const attempts = {};
  const coaches = [];
  let slugs;
  try {
    slugs = parseClubSlugs(await fetchText(DIRECTORY_URL));
  } catch (error) {
    console.log(`⚠ LaLiga 官方球隊目錄：${error.message}`);
    return store;
  }
  if (slugs.length < 15) {
    console.log(`⚠ LaLiga 官方球隊目錄只解析到 ${slugs.length} 個球隊頁，保留舊快取`);
    return store;
  }

  for (const slug of slugs) {
    const sourceUrl = `${BASE}/en-US/clubs/${slug}/squad`;
    try {
      const apiUrl = `${API_BASE}/api/v1/teams/${encodeURIComponent(slug)}/squad-manager?limit=50&seasonYear=2026`;
      const coach = parseOfficialCoachPayload(await fetchJson(apiUrl));
      const team = teamCodeFor(slug, coach?.teamName, teams);
      if (!coach || !team) throw new Error(!coach ? 'staff JSON-LD 沒有主教練' : '無法對回本站隊碼');
      coaches.push(coachRow(team, coach, sourceUrl));
      console.log(`  ✓ ${team}: ${coach.name}`);
    } catch (error) {
      attempts[slug] = { at: new Date().toISOString(), reason: error.message, sourceUrl };
      console.log(`  ⚠ ${slug}: ${error.message}`);
    }
    await sleep(200);
  }
  const deduped = [...new Map(coaches.map(row => [row.team, row])).values()];
  const next = {
    version: 1, source: 'laliga.com', season: SEASON, retrievedAt: new Date().toISOString(),
    sourceUrl: DIRECTORY_URL, coaches: deduped, attempts,
    coverage: { pages: slugs.length, coaches: deduped.length, errors: Object.keys(attempts).length },
  };
  await mkdir(dirname(STORE_FILE), { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(next, null, 1));
  console.log(`✔ LaLiga 官方教練核對完成：${deduped.length}/${slugs.length} 頁`);
  console.log(`  檔案：${STORE_FILE}`);
  return next;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => {
  console.error(`✗ ${error.message}`); process.exitCode = 1;
});
