#!/usr/bin/env node
/* 西甲賽後資料(FotMob)。SportMonks 方案 2026-09-03 取消後的接手來源。
 *
 *   npm run laliga:postmatch                # 預設一次最多 6 場
 *   npm run laliga:postmatch -- --limit=2   # 小量試跑
 *   npm run laliga:postmatch -- --dry-run   # 只列出要抓哪幾場,不發請求
 *
 * 三件跟既有 lineups 抓取一樣的規矩:
 * - **永久快取,抓過就不再抓**(完賽資料不會變),所以請求量隨賽季線性而不是每天重來。
 * - 每日硬上限,單線、間隔 400ms。使用者明確要求不要大量爬網站。
 * - **比分核對過才收**:FotMob 的比分要跟本站賽程(已與獨立來源核對)一致,
 *   對不上就整場不收 —— 寧可少一場,不要收一場對不起來的。
 *
 * 這支只**寫快取**,不產生前端產物;轉換在 `lib/adapters/fotmob-match.mjs`,
 * 發布與否由 `build-laliga` 那邊的 `buildProviderMatchReport` 決定(它自己還會再核對一次)。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseFotmobMatch } from './lib/adapters/fotmob-match.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://www.fotmob.com';
const UA = 'pl-war-room/1.0 (football analysis side project)';
const DIR = join(ROOT, 'data', 'raw', 'fotmob-la-liga');
const SEASON = '2026-27';
const STORE = join(DIR, `${SEASON}-match-details.json`);
const LINEUPS = join(DIR, `${SEASON}-lineups.json`);

const DEFAULT_LIMIT = 6;
const DAILY_LIMIT = 15;
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const limit = Math.max(0, Number(arg('limit') ?? DEFAULT_LIMIT));
const dryRun = process.argv.includes('--dry-run');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const read = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

let used = 0;
async function getMatch(matchId) {
  if (used >= DAILY_LIMIT) return { error: `已達每次 ${DAILY_LIMIT} 個請求上限` };
  used++;
  await sleep(400);
  try {
    const res = await fetch(`${BASE}/api/data/matchDetails?matchId=${matchId}`, {
      signal: AbortSignal.timeout(20000),
      headers: { accept: 'application/json', referer: `${BASE}/`, 'user-agent': UA },
    });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status}` };
    let j;
    try { j = JSON.parse(text); } catch { return { error: '回應不是 JSON' }; }
    // 200 加一個 error 物件是本站踩過的坑 —— 不看 res.ok 就當成功
    if (j?.error) return { error: `回了 200 但帶 error:${String(j.error).slice(0, 80)}` };
    return { json: j };
  } catch (e) { return { error: e.message }; }
}

async function main() {
  console.log('\n▶ 西甲賽後資料(FotMob)');
  const fixtures = await read(join(ROOT, 'web', 'data', 'leagues', 'es1', 'fixtures.json'));
  const lineups = await read(LINEUPS);
  if (!Array.isArray(fixtures) || !lineups) {
    console.log('  ✗ 缺賽程或 FotMob 陣容快取(先跑 npm run laliga:lineups)');
    return;
  }
  const store = (await read(STORE)) ?? { season: SEASON, source: 'fotmob', matches: {} };
  store.matches ??= {};

  /* 候選:已完賽、快取裡還沒有、而且**陣容快取裡有 matchId**。
     matchId 從既有的陣容快取來 —— 不另外打一次聯賽賽程,省一個請求,
     而且那份的隊碼對照已經核對過。 */
  const byKey = new Map(Object.entries(lineups.matches ?? {}));
  const pending = fixtures.filter(f => f.played
    && !store.matches[`${f.home}|${f.away}`]
    && byKey.get(`${f.home}|${f.away}`)?.matchId);

  console.log(`  已完賽 ${fixtures.filter(f => f.played).length} 場・快取 ${Object.keys(store.matches).length} 場`
    + `・待補 ${pending.length} 場・本次上限 ${Math.min(limit, DAILY_LIMIT)}`);
  if (dryRun) {
    for (const f of pending.slice(0, limit)) console.log(`  · ${f.date} ${f.home}–${f.away}`);
    console.log('  (--dry-run,沒有發任何請求)');
    return;
  }

  await mkdir(DIR, { recursive: true });
  let ok = 0, rejected = 0;
  const unmappedAll = new Set();
  for (const f of pending.slice(0, limit)) {
    const key = `${f.home}|${f.away}`;
    const { json, error } = await getMatch(byKey.get(key).matchId);
    if (error) { console.log(`  ✗ ${key}:${error}`); if (/上限/.test(error)) break; continue; }
    const detail = normaliseFotmobMatch(json, { fixture: f, season: SEASON });
    if (!detail) { console.log(`  ✗ ${key}:轉換不出 detail`); rejected++; continue; }
    /* **比分對不上就不收。** 本站的比分是跟獨立來源核對過的;FotMob 說別的,
       代表這一場對到錯的 matchId,或上游還沒定案。收進來會污染整個賽後頁。 */
    if (detail.score.home !== f.fh || detail.score.away !== f.fa) {
      console.log(`  ✗ ${key}:比分對不上(本站 ${f.fh}:${f.fa}、FotMob ${detail.score.home}:${detail.score.away})`);
      rejected++; continue;
    }
    for (const k of detail.unmappedStats ?? []) unmappedAll.add(k);
    store.matches[key] = detail;
    ok++;
    console.log(`  ✔ ${key} ${f.fh}:${f.fa}`
      + `・陣容 ${detail.coverage.lineups ? '✔' : '✘'}`
      + `・評分 ${detail.coverage.ratings ? '✔' : '✘'}`
      + `・球隊統計 ${detail.coverage.teamStatistics ? '✔' : '✘'}`
      + `・事件 ${detail.events.length}`);
  }

  store.retrievedAt = new Date().toISOString();
  store.coverage = { cached: Object.keys(store.matches).length, fetchedThisRun: ok, rejected };
  await writeFile(STORE, JSON.stringify(store, null, 1));
  console.log(`✔ 新增 ${ok} 場・退回 ${rejected} 場・快取共 ${Object.keys(store.matches).length} 場・本次請求 ${used}/${DAILY_LIMIT}`);
  /* 對映不到的球隊統計 key **一定要印出來**。不印的話,少掉的欄位在畫面上
     只是一個「—」,看起來像上游沒有,實際上是我們沒有對照 ——
     跟賠率解析器「一場都解不出來就把表頭印出來」同一個道理。 */
  if (unmappedAll.size) {
    console.log(`  ⚠ 這些球隊統計 key 還沒有對照(顯示成「—」):${[...unmappedAll].join('、')}`);
    console.log('    要用的話把它們加進 lib/adapters/fotmob-match.mjs 的 TEAM_STAT_KEYS。');
  }
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
