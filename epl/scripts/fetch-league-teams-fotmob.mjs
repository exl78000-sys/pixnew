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
 * 例外是教練:最新一場名單上的教練不在快取裡,那一隊提早重抓(`coachRefetchReason`,一次換帥一個請求)。
 * 抓失敗保留上一份(逐隊),不整份覆寫(「抓取器整份覆寫」那條坑)。
 *
 *   node scripts/fetch-league-teams-fotmob.mjs --league=de1   (也可 it1 / fr1;不帶就三個都跑)
 *   寫 data/raw/fotmob-teams/{聯賽}.json(--out= 可改目錄,探測用)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (football analysis side project)';
const FM = 'https://www.fotmob.com';
export const LEAGUES = {
  de1: { zh: '德甲', id: 54, ccode3: 'GER', teamFile: 'teams-bundesliga.json', meta: 'de1', matchDir: 'fotmob-bundesliga' },
  it1: { zh: '義甲', id: 55, ccode3: 'ITA', teamFile: 'teams-serie-a.json', meta: 'it1', matchDir: 'fotmob-serie-a' },
  fr1: { zh: '法甲', id: 53, ccode3: 'FRA', teamFile: 'teams-ligue-1.json', meta: 'fr1', matchDir: 'fotmob-ligue-1' },
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
   隊色陣列原樣存。教練歷任**整份存**(2026-11-01):第一版存 `.slice(-3)`。上游是時間序(2026-11-01 整份抓回來看過),
   最後三筆就是最近三筆,所以它沒有截掉現任 —— 但任期超過三筆的教練,上任季會被算晚(build 從紀錄往回找他的第一季)。
   一隊 8~20 筆,存整份。 */
export function pickTeamPage(j) {
  const v = j?.overview?.venue ?? {};
  const pair = k => (v.statPairs ?? []).find(p => p?.[0] === k)?.[1] ?? null;
  return {
    color: j?.details?.teamColor ?? null,
    teamColors: j?.overview?.teamColors ?? null,
    venue: v.widget?.name ?? null, city: v.widget?.city ?? null, location: v.widget?.location ?? null,
    capacity: Number.isFinite(Number(pair('Capacity'))) ? Number(pair('Capacity')) : null,
    surface: pair('Surface'), opened: pair('Opened'),
    coachHistory: j?.overview?.coachHistory ?? null,
    coachHistoryFull: true,
  };
}

/* 每隊最新一場正式名單上的教練(讀 game:fetch 落地的 raw;部署裡它排在這支之前)。沒有 raw 回空 Map。 */
export function latestLineupCoaches(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(f => /-game-details\.json$/.test(f))) {
    let j;
    try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const m of Object.values(j?.matches ?? j ?? {})) {
      for (const [code, l] of Object.entries(m?.lineups ?? {})) {
        if (!l?.coach || !m.date) continue;
        const prev = out.get(code);
        if (!prev || String(m.date) > prev.date) out.set(code, { coach: l.coach, date: String(m.date) });
      }
    }
  }
  return out;
}

/* 快取還在 TTL 內,但教練要不要重抓那一頁(2026-11-01)。場館一年不變,教練一季可以換兩次 ——
   德甲 BMG、義甲 PAR / VEN 在 10-09 抓頁之後換帥,新教練帶了三、四場還沒上站。
   重抓的條件:最新一場名單上的教練不在快取的教練紀錄裡,而且
   (a) 快取是那一場之前抓的(上游有機會已經記上他),或 (b) 快取是截短版(見 pickTeamPage)。
   抓過之後仍然沒有他(停賽的代理教練;KOE 的 Wagner、BST 的 Lachuer、LMA 的 Videira 整份紀錄裡都沒有),
   記在 `coachMissing`,TTL 內不再為同一位重抓 —— 不然每踢一輪快取又比最新那場舊,每週重抓同幾頁。 */
const normCoach = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
export function coachRefetchReason(prev, latest) {
  if (!prev || !latest?.coach) return null;
  const hist = Array.isArray(prev.coachHistory) ? prev.coachHistory : [];
  if (hist.some(h => normCoach(h?.name) === normCoach(latest.coach))) return null;
  if (prev.coachMissing && normCoach(prev.coachMissing) === normCoach(latest.coach)) return null;
  if (!prev.coachHistoryFull) return `名單是 ${latest.coach},快取的教練紀錄是截短版`;
  if (Date.parse(prev.fetchedAt) < Date.parse(latest.date)) return `名單是 ${latest.coach}(${latest.date.slice(0, 10)}),快取是那之前抓的`;
  return null;
}

export async function fetchLeagueTeams(key, { outDir = join(ROOT, 'data', 'raw', 'fotmob-teams'), ttlDays = 30, force = false, log = console.log } = {}) {
  const L = LEAGUES[key];
  const meta = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', L.meta, 'meta.json'), 'utf8'));
  const T = loadTeams(ROOT, { file: L.teamFile });
  const file = join(outDir, `${key}.json`);
  const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const oldBy = new Map((old?.teams ?? []).map(t => [t.code, t]));
  const coachNow = latestLineupCoaches(join(ROOT, 'data', 'raw', L.matchDir));
  const lg = await get(`${FM}/api/data/leagues?id=${L.id}&ccode3=${L.ccode3}&season=${encodeURIComponent(fotmobSeason(meta.currentSeason))}`);
  const rows = lg.j?.table?.[0]?.data?.table?.all ?? lg.j?.table?.[0]?.data?.tables?.[0]?.table?.all ?? [];
  if (!rows.length) { log(`✗ ${L.zh}:聯賽頁 HTTP ${lg.status},沒有球隊列表,保留上一份`); return { requests: 1, kept: true }; }
  const teams = [], unknown = [], failed = [], coachRefetch = [];
  let requests = 1;
  for (const r of rows) {
    const code = T.codeOf(r.name);
    if (!code) { unknown.push(r.name); continue; }
    const prev = oldBy.get(code);
    const fresh = prev && prev.fotmobId === r.id && Date.now() - Date.parse(prev.fetchedAt) < ttlDays * 864e5;
    const why = fresh && !force ? coachRefetchReason(prev, coachNow.get(code)) : null;
    if (fresh && !force && !why) { teams.push(prev); continue; }
    if (why) coachRefetch.push(`${code}:${why}`);
    requests++;
    const p = await get(`${FM}/api/data/teams?id=${r.id}`);
    if (!p.j) { failed.push(`${r.name}(HTTP ${p.status})`); if (prev) teams.push(prev); continue; }
    const picked = pickTeamPage(p.j), lc = coachNow.get(code)?.coach;
    const missing = lc && !(picked.coachHistory ?? []).some(h => normCoach(h?.name) === normCoach(lc)) ? lc : null;
    teams.push({ code, fotmobId: r.id, fotmobName: r.name, fetchedAt: new Date().toISOString(), ...picked, ...(missing ? { coachMissing: missing } : {}) });
  }
  if (coachRefetch.length) log(`  ${L.zh}:教練紀錄過期,重抓 ${coachRefetch.length} 隊:${coachRefetch.join('、')}`);
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
