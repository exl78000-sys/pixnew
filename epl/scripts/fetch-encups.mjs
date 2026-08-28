#!/usr/bin/env node
/* 抓英格蘭盃賽(足總盃 / 聯賽盃)的逐場賽果。
 *
 * 來源:SportMonks。方案實測授權 FA Cup(24)與 Carabao Cup(27) ——
 * 這兩個 id 是從 /my/leagues 的授權清單讀出來的,不是查文件猜的。
 *
 * **season id 一律當場解析,不寫死。** 每季都會換一組新的 id;
 * 寫死的話明年這支會安靜地抓到去年的資料 —— 那比抓不到更糟,
 * 因為畫面照樣有東西,只是全部是舊的。
 *
 * 抓取禮貌:單線、間隔 350ms、每頁 50 場,硬上限 40 個請求。
 * 兩個盃賽 × 兩季大約 16~20 個請求就夠。
 *
 *   npm run encups            兩個盃賽、兩季
 *   npm run encups -- --force 忽略快取重抓
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { normaliseCupFixture } from './lib/adapters/sportmonks-cups.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'sportmonks-cups');
const TOKEN = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_KEY || process.env.SPORTMONKS_API_KEY;
const BASE = 'https://api.sportmonks.com/v3';
const FORCE = process.argv.includes('--force');
const DELAY = 350;
const PER_PAGE = 50;
const MAX_REQUESTS = Number(process.argv.find(x => x.startsWith('--max-requests='))?.split('=')[1] ?? 40);
const TTL_HOURS = 12;

// 賽事名稱由 SportMonks 決定,不是我們取的 —— 中文名才是我們的。
export const CUPS = [
  { key: 'facup', leagueId: 24, zh: '足總盃', en: 'FA Cup' },
  { key: 'eflcup', leagueId: 27, zh: '聯賽盃', en: 'Carabao Cup' },
];
// SportMonks 的賽季名寫法是 "2026/2027";本站一律用 "2026-27"
const WANT = [{ label: '2026-27', sm: '2026/2027' }, { label: '2025-26', sm: '2025/2026' }];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;

async function get(path) {
  if (requests >= MAX_REQUESTS) throw new Error(`已達本次 ${MAX_REQUESTS} 個請求上限`);
  if (requests) await sleep(DELAY);
  requests++;
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(30000),
    headers: { accept: 'application/json', Authorization: TOKEN },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} 回傳不是 JSON`); }
  // SportMonks 也會用 HTTP 200 夾帶 errors,只看 res.ok 會把失敗當成功
  if (!res.ok || body?.errors) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(body?.errors ?? body?.message ?? {}).slice(0, 200)}`);
  }
  return body;
}

/* 一整季的 fixture 分頁抓完。SportMonks 的分頁旗標在 pagination.has_more,
   但不同端點回法不太一樣,所以「拿到的比 per_page 少」也當成最後一頁 ——
   兩個條件取聯集,少判一個就會無限翻頁把額度燒光。 */
async function allFixtures(seasonId) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const body = await get(`/football/fixtures?filters=fixtureSeasons:${seasonId}`
      + `&include=participants;scores;round;stage;state&per_page=${PER_PAGE}&page=${page}&order=starting_at`);
    const rows = Array.isArray(body?.data) ? body.data : [];
    out.push(...rows);
    const hasMore = body?.pagination?.has_more === true;
    if (!hasMore || rows.length < PER_PAGE) break;
  }
  return out;
}

const stale = store => {
  if (FORCE || !store?.retrievedAt) return true;
  const age = Date.now() - Date.parse(store.retrievedAt);
  return !Number.isFinite(age) || age > TTL_HOURS * 3600000;
};

async function readStore(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

// 寫到暫存再改名。直接寫的話中途被砍會留下半個檔,下次讀進來是壞的 JSON
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, file);
}

async function main() {
  if (!TOKEN) {
    console.log('⚠ 未設定 SPORTMONKS_TOKEN,略過英格蘭盃賽抓取。');
    return;
  }
  const { codeOf } = loadTeams(ROOT);
  await mkdir(OUT, { recursive: true });

  for (const cup of CUPS) {
    const file = join(OUT, `${cup.key}.json`);
    const prev = await readStore(file);
    if (!stale(prev)) {
      console.log(`  ${cup.zh}:快取仍新鮮(${prev.retrievedAt}),略過。加 --force 可重抓`);
      continue;
    }

    // season id 當場解析 —— 每季都會換,寫死的話明年會安靜地抓到去年的
    const league = await get(`/football/leagues/${cup.leagueId}?include=seasons`);
    const seasons = Array.isArray(league?.data?.seasons) ? league.data.seasons : [];
    const seasonsOut = [];
    const missing = [];

    for (const want of WANT) {
      const season = seasons.find(s => String(s.name) === want.sm);
      if (!season) { missing.push(want.label); continue; }
      const raw = await allFixtures(season.id);
      const matches = raw.map(f => normaliseCupFixture(f, { codeOf }));
      const unknown = [...new Set(matches.flatMap(m => m.unknownDescriptions))];
      const unknownStates = [...new Set(matches.filter(m => m.stateKnown === false).map(m => m.state))];
      seasonsOut.push({
        label: want.label, seasonId: season.id, sourceName: season.name,
        finished: season.finished ?? null, current: season.is_current === true,
        matches: matches.map(({ unknownDescriptions, ...m }) => m),
        unknownDescriptions: unknown,
        unknownStates,
      });
      const played = matches.filter(m => m.played).length;
      const pens = matches.filter(m => m.pens).length;
      const aet = matches.filter(m => m.aet === true).length;
      const mapped = matches.filter(m => m.home?.code || m.away?.code).length;
      console.log(`  ${cup.zh} ${want.label}(season ${season.id}):${matches.length} 場・已完賽 ${played}`
        + `・延長 ${aet}・PK ${pens}・含英超球隊 ${mapped}`);
      if (unknown.length) console.log(`    ⚠ 沒見過的比分類別:${unknown.join('、')} —— 核對過才可加進 KNOWN_SCORE_DESCRIPTIONS`);
      if (unknownStates.length) console.log(`    ⚠ 沒見過的狀態碼:${unknownStates.join('、')}`);
    }

    if (missing.length) console.log(`  ⚠ ${cup.zh} 上游沒有這些賽季:${missing.join('、')}`);
    if (!seasonsOut.length) { console.log(`  ✗ ${cup.zh} 一季都沒抓到,不寫入(保留舊快取)`); continue; }

    await writeAtomic(file, {
      key: cup.key, zh: cup.zh, en: cup.en, leagueId: cup.leagueId,
      source: 'SportMonks', retrievedAt: new Date().toISOString(),
      availableSeasons: seasons.map(s => s.name).slice(0, 40),
      missingSeasons: missing,
      seasons: seasonsOut,
    });
    console.log(`  ✔ ${cup.zh} → ${file}`);
  }
  console.log(`\n✔ 英格蘭盃賽抓取完成(${requests}/${MAX_REQUESTS} 個請求)`);
}

main().catch(e => { console.error(`✗ 英格蘭盃賽抓取失敗:${e.message}`); process.exitCode = 1; });
