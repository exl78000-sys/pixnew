#!/usr/bin/env node
/* 德甲 / 義甲 / 法甲的球場、城市、容量、隊色、教練歷任 —— FotMob 球隊頁(`/api/data/teams?id=`)。
 *
 * 為什麼(2026-10-09,使用者:「接 FotMob」):這幾樣原本等人工交付。探測(三輪,見變更紀錄)確認球隊頁本來就給
 * 球場名、城市、容量、場地表面與一個隊色。**它是單一來源** —— 沒有第二個來源能核對球場與容量,
 * 所以下游(`build-league-teams-inbox.mjs`)產生收件匣時每一格的出處都指向這一頁,畫面也要講「單一來源」。
 *
 * 做什麼:一個請求拿聯賽頁的隊 id(54 / 55 / 53 是 probe-new-leagues 逐隊證明過的),每隊一個請求拿球隊頁,
 * 只存要用的欄位(不存整份,一頁 200 KB)。隊名走名冊寬鬆對照,**對不上的印出來並跳過** —— 不編身分。
 * 場館資料幾乎不變,所以每隊快取 30 天(`--ttl-days=`),部署一天兩次不會每次打 56 個請求;`--force` 全抓。
 * 抓失敗保留上一份(逐隊),不整份覆寫(「抓取器整份覆寫」那條坑)。
 *
 *   node scripts/fetch-league-teams-fotmob.mjs --league=de1   (也可 it1 / fr1;不帶就三個都跑)
 *   寫 data/raw/fotmob-teams/{聯賽}.json(--out= 可改目錄,探測用)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (football analysis side project)';
const FM = 'https://www.fotmob.com';
export const LEAGUES = {
  de1: { zh: '德甲', id: 54, ccode3: 'GER', teamFile: 'teams-bundesliga.json', meta: 'de1' },
  it1: { zh: '義甲', id: 55, ccode3: 'ITA', teamFile: 'teams-serie-a.json', meta: 'it1' },
  fr1: { zh: '法甲', id: 53, ccode3: 'FRA', teamFile: 'teams-ligue-1.json', meta: 'fr1' },
};
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const get = async url => {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { accept: 'application/json', 'user-agent': UA, referer: `${FM}/` } });
  if (!res.ok) return { status: res.status, j: null };
  const j = await res.json().catch(() => null);
  return { status: res.status, j: j?.error ? null : j };
};
const fotmobSeason = s => { const y = Number(s.slice(0, 4)); return `${y}/${y + 1}`; };

/* 從球隊頁只取要用的欄位。形狀以探測為準:`overview.venue.widget.{name,city,location}`、
   `overview.venue.statPairs` 是 [標題, 值] 的陣列(Capacity 是整數)、`details.teamColor` 是十六進位色。
   教練歷任與隊色陣列的內容還沒讀過,原樣存(截短)等下游讀,不在這裡猜。 */
export function pickTeamPage(j) {
  const v = j?.overview?.venue ?? {};
  const pair = k => (v.statPairs ?? []).find(p => p?.[0] === k)?.[1] ?? null;
  return {
    color: j?.details?.teamColor ?? null,
    teamColors: j?.overview?.teamColors ?? null,
    venue: v.widget?.name ?? null, city: v.widget?.city ?? null, location: v.widget?.location ?? null,
    capacity: Number.isFinite(Number(pair('Capacity'))) ? Number(pair('Capacity')) : null,
    surface: pair('Surface'), opened: pair('Opened'),
    coachHistory: Array.isArray(j?.overview?.coachHistory) ? j.overview.coachHistory.slice(0, 3) : (j?.overview?.coachHistory ?? null),
  };
}

export async function fetchLeagueTeams(key, { outDir = join(ROOT, 'data', 'raw', 'fotmob-teams'), ttlDays = 30, force = false, log = console.log } = {}) {
  const L = LEAGUES[key];
  const meta = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', L.meta, 'meta.json'), 'utf8'));
  const T = loadTeams(ROOT, { file: L.teamFile });
  const file = join(outDir, `${key}.json`);
  const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const oldBy = new Map((old?.teams ?? []).map(t => [t.code, t]));
  const lg = await get(`${FM}/api/data/leagues?id=${L.id}&ccode3=${L.ccode3}&season=${encodeURIComponent(fotmobSeason(meta.currentSeason))}`);
  const rows = lg.j?.table?.[0]?.data?.table?.all ?? lg.j?.table?.[0]?.data?.tables?.[0]?.table?.all ?? [];
  if (!rows.length) { log(`✗ ${L.zh}:聯賽頁 HTTP ${lg.status},沒有球隊列表,保留上一份`); return { requests: 1, kept: true }; }
  const teams = [], unknown = [], failed = [];
  let requests = 1;
  for (const r of rows) {
    const code = T.codeOf(r.name);
    if (!code) { unknown.push(r.name); continue; }
    const prev = oldBy.get(code);
    const fresh = prev && prev.fotmobId === r.id && Date.now() - Date.parse(prev.fetchedAt) < ttlDays * 864e5;
    if (fresh && !force) { teams.push(prev); continue; }
    requests++;
    const p = await get(`${FM}/api/data/teams?id=${r.id}`);
    if (!p.j) { failed.push(`${r.name}(HTTP ${p.status})`); if (prev) teams.push(prev); continue; }
    teams.push({ code, fotmobId: r.id, fotmobName: r.name, fetchedAt: new Date().toISOString(), ...pickTeamPage(p.j) });
  }
  if (unknown.length) log(`  ⚠ ${L.zh}:對不上名冊的 FotMob 隊名(跳過,不編身分):${unknown.join('、')}`);
  if (failed.length) log(`  ⚠ ${L.zh}:球隊頁抓失敗(有上一份就保留):${failed.join('、')}`);
  if (!teams.length) { log(`✗ ${L.zh}:一支都沒對上,保留上一份`); return { requests, kept: true }; }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ league: key, season: meta.currentSeason, source: 'fotmob teams', fetchedAt: new Date().toISOString(), teams }, null, 1));
  const n = f => teams.filter(t => t[f] != null).length;
  log(`✔ ${L.zh} ${meta.currentSeason}:${teams.length}/${rows.length} 隊・球場 ${n('venue')}・城市 ${n('city')}・容量 ${n('capacity')}・隊色 ${n('color')}・${requests} 個請求`);
  return { requests, kept: false };
}

if (process.argv[1]?.endsWith('fetch-league-teams-fotmob.mjs')) {
  const keys = arg('league') ? [arg('league')] : Object.keys(LEAGUES);
  for (const k of keys) {
    if (!LEAGUES[k]) { console.error(`未知聯賽 ${k}`); process.exit(1); }
    await fetchLeagueTeams(k, { outDir: arg('out') ?? undefined, ttlDays: Number(arg('ttl-days') ?? 30), force: process.argv.includes('--force') });
  }
}
