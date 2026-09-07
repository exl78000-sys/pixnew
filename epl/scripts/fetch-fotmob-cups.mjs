#!/usr/bin/env node
/* 英格蘭盃賽(足總盃 / 聯賽盃)的賽程與賽果 —— FotMob 盃賽端點 → data/raw/fotmob-cups/{facup,eflcup}.json
 *
 * 為什麼(2026-09-07):SportMonks 9/3 退訂,`encups` 的快取停在 9/2;聯賽盃第三輪 9/8 開踢,
 * 盃賽頁從此凍住。站上本來就在打 FotMob 的聯賽端點(47/87/48),盃賽是同一個端點換 id(132/133),
 * 形狀用 probe-fotmob-cups.mjs 兩輪探測實測過(細節見 lib/adapters/fotmob-cups.mjs 檔頭)。
 *
 * 規矩:
 * 1. **一季一個請求**;本季 3 小時內不重抓、上季 7 天內不重抓(完賽資料不會變)。
 * 2. **PK 場的比數與勝方不在賽程端點**,另打單場詳情(matchDetails),每次最多 --max-details 場、
 *    抓過永久存在 season.details 裡;掛上去前核對隊 id 與最終比分,對不上就是抓錯場,不掛。
 *    **本季優先**:第一次真抓時足總盃上季 17 場 PK 把配額吃光,聯賽盃本季 11 場一場都沒補到(run 34145087061)。
 *    所以分兩段:先把兩個盃賽的賽程都抓回來,再依「本季 → 上季」的順序補詳情。
 * 3. **驗 selectedSeason**:足總盃 2026-27 上游還沒發布,帶 season=2026/2027 回的是 2025/2026 ——
 *    不驗的話會把上季存成本季,畫面看起來完全正常。
 * 4. **跟 SportMonks 舊快取逐場核對**(鐵則五,現成的獨立來源),結果存進 season.crossCheck;
 *    有不一致的賽季 build 不發布(那邊擋)。對不上的算「無法核對」,不算不一致。
 * 5. 隊名只做嚴格比對;寬鬆會中、嚴格不中的印成 nearMisses 給人核對(cupAlias),不自動採用。
 * 6. 抓不到就保留上一份快取,不洗掉。
 *
 *   npm run cups:fetch
 *   npm run cups:fetch -- --force --max-details=20
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import {
  FOTMOB_CUPS, fotmobSeason, buildCupTeamIndex, normaliseFotmobCupMatch, withCupDetails,
  parseCupDetail, crossCheckWithSportmonks,
} from './lib/adapters/fotmob-cups.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'fotmob-cups');
const SM_DIR = join(ROOT, 'data', 'raw', 'sportmonks-cups');
const BASE = 'https://www.fotmob.com';
const UA = 'pl-war-room/1.0 (football analysis side project)';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const FORCE = process.argv.includes('--force');
const MAX_DETAILS = Number(arg('max-details') ?? 24);
const MAX_REQUESTS = 4 + MAX_DETAILS;
const GAP = 800;
const TTL_CURRENT_MS = 3 * 3600000;
const TTL_PAST_MS = 7 * 86400000;
// 版本不同就整份重抓(修了轉換邏輯而快取還在 TTL 內 → 修了等於沒修,encups 踩過)
const SCHEMA_VERSION = 1;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;
async function get(url) {
  if (requests >= MAX_REQUESTS) throw new Error(`已達本次 ${MAX_REQUESTS} 個請求上限`);
  if (requests) await sleep(GAP);
  requests++;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000),
    headers: { accept: 'application/json', 'user-agent': UA, referer: `${BASE}/` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 100)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`回傳不是 JSON(${text.length} bytes)`); }
  // 200 加一個 error 物件是踩過的坑
  if (j?.error) throw new Error(`回了 200 但帶 error:${JSON.stringify(j.error).slice(0, 120)}`);
  return j;
}

const readJson = async p => { if (!existsSync(p)) return null; try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1) + '\n');
  await rename(tmp, file);
}
const prevSeasonOf = label => { const y = Number(label.slice(0, 4)) - 1; return `${y}-${String(y + 1).slice(2)}`; };

async function main() {
  const meta = await readJson(join(ROOT, 'web', 'data', 'meta.json'));
  const CURRENT = meta?.currentSeason ?? '2026-27';
  const WANT = [CURRENT, prevSeasonOf(CURRENT)];
  console.log(`▶ 英格蘭盃賽(FotMob):賽季 ${WANT.join('、')}・最多 ${MAX_REQUESTS} 個請求(其中單場詳情 ${MAX_DETAILS})`);

  const { list, codeOf: looseCodeOf } = loadTeams(ROOT);
  const codeOf = buildCupTeamIndex(list);
  await mkdir(OUT, { recursive: true });
  const now = new Date().toISOString();
  let detailsBudget = MAX_DETAILS;
  const work = [];   // { cup, file, smStore, seasonsOut, missing, available, pending: [{ label, season }] }

  for (const cup of FOTMOB_CUPS) {
    const file = join(OUT, `${cup.key}.json`);
    let prev = await readJson(file);
    if (prev && prev.schemaVersion !== SCHEMA_VERSION) { console.log(`  ${cup.zh}:快取是舊版結構(${prev.schemaVersion}),整份重抓`); prev = null; }
    const cached = new Map((prev?.seasons ?? []).map(s => [s.label, s]));
    const smStore = await readJson(join(SM_DIR, `${cup.key}.json`));
    const seasonsOut = [];
    const missing = [];
    const job = { cup, file, smStore, seasonsOut, missing, available: prev?.availableSeasons ?? null, slots: [] };

    for (const label of WANT) {
      const old = cached.get(label);
      const ttl = label === CURRENT ? TTL_CURRENT_MS : TTL_PAST_MS;
      const age = old?.retrievedAt ? Date.now() - Date.parse(old.retrievedAt) : Infinity;
      let season = null;

      if (old && !FORCE && age < ttl) {
        console.log(`  ${cup.zh} ${label}:快取 ${(age / 3600000).toFixed(1)} 小時前抓的,不重抓賽程`);
        season = old;
      } else {
        let body = null;
        try { body = await get(`${BASE}/api/data/leagues?id=${cup.id}&ccode3=GBR&season=${encodeURIComponent(fotmobSeason(label))}`); }
        catch (e) { console.log(`  ✗ ${cup.zh} ${label}:${e.message}${old ? '(保留上一份)' : ''}`); if (old) seasonsOut.push(old); else missing.push({ label, reason: `抓取失敗:${e.message}` }); continue; }
        if (Array.isArray(body.allAvailableSeasons)) job.available = body.allAvailableSeasons;
        const name = String(body.details?.name ?? '');
        if (!cup.expect.test(name)) {
          console.log(`  ✗ ${cup.zh}:id ${cup.id} 回的名字是「${name}」,不是這個盃賽,整個跳過`);
          if (old) seasonsOut.push(old);
          break;
        }
        const selected = body.details?.selectedSeason ?? null;
        if (selected !== fotmobSeason(label)) {
          // 上游還沒建這一季:帶 season 參數會回最新那季 —— 不驗就會把上季存成本季
          const reason = `上游還沒發布這一季(端點目前最新是 ${body.details?.latestSeason ?? selected ?? '?'})`;
          console.log(`  · ${cup.zh} ${label}:${reason}`);
          missing.push({ label, reason });
          if (old) seasonsOut.push(old);
          continue;
        }
        const all = Array.isArray(body.fixtures?.allMatches) ? body.fixtures.allMatches : [];
        if (!all.length) {
          console.log(`  · ${cup.zh} ${label}:端點回了 0 場${old ? ',保留上一份' : ''}`);
          missing.push({ label, reason: '端點回了 0 場' });
          if (old) seasonsOut.push(old);
          continue;
        }
        const details = { ...(old?.details ?? {}) };
        const matches = all.map(m => normaliseFotmobCupMatch(m, { codeOf, details: details[String(m.id)] ?? null }));
        season = { label, sourceSeason: selected, current: label === CURRENT, retrievedAt: now, matches, details };
      }

      seasonsOut.push(season);
      job.slots.push({ label, season });
    }
    if (!seasonsOut.length) { console.log(`  ✗ ${cup.zh} 一季都沒有,不寫入`); continue; }
    work.push(job);
  }

  /* 第二段:PK 場的比數與勝方(單場詳情)。**本季優先、再上季**,跨兩個盃賽一起排 ——
     快取仍新鮮也要補(不然上季 36 場 PK 要等 7 天一批)。掛上去前核對隊 id 與最終比分,
     對不上就是抓錯場,寧可留「勝方待查」。 */
  const order = [...WANT].flatMap(label => work.flatMap(job => job.slots.filter(s => s.label === label).map(s => ({ job, ...s }))));
  const detailStats = new Map();   // season → { got, bad }
  for (const { job, season } of order) {
    if (detailsBudget <= 0) break;
    const stat = { got: 0, bad: 0 };
    detailStats.set(season, stat);
    const pending = season.matches.filter(m => m.state === 'FT_PEN' && !season.details?.[m.id]);
    for (const m of pending) {
      {
        if (detailsBudget <= 0) break;
        detailsBudget--;
        let got = 0, bad = 0;
        try {
          const d = await get(`${BASE}/api/data/matchDetails?matchId=${encodeURIComponent(m.id)}`);
          const parsed = parseCupDetail(d);
          if (!parsed) { stat.bad++; console.log(`    ✗ 詳情 ${m.id}:沒有 header.status/teams`); continue; }
          if (parsed.homeId !== m.home?.sourceId || parsed.awayId !== m.away?.sourceId) { stat.bad++; console.log(`    ✗ 詳情 ${m.id}:隊 id 對不上賽程端點(${parsed.homeId}/${parsed.awayId} vs ${m.home?.sourceId}/${m.away?.sourceId}),不掛`); continue; }
          if (parsed.score && m.final && (parsed.score[0] !== m.final[0] || parsed.score[1] !== m.final[1])) { stat.bad++; console.log(`    ✗ 詳情 ${m.id}:最終比分對不上(${parsed.score.join('-')} vs ${m.final.join('-')}),不掛`); continue; }
          if (parsed.conflict) { stat.bad++; console.log(`    ✗ 詳情 ${m.id}:PK 比數與輸家對不起來,不掛`); continue; }
          if (!parsed.pens && !parsed.pensWinner) { stat.bad++; console.log(`    · 詳情 ${m.id}:沒有 PK 比數也沒有輸家(${m.home?.name} v ${m.away?.name})`); continue; }
          season.details = { ...(season.details ?? {}), [m.id]: { pens: parsed.pens, pensWinner: parsed.pensWinner, extraTime: parsed.extraTime, source: 'FotMob matchDetails', retrievedAt: now } };
          stat.got++;
        } catch (e) { stat.bad++; console.log(`    ✗ 詳情 ${m.id}:${e.message}`); }
      }
    }
    if (stat.got) season.matches = season.matches.map(m => withCupDetails(m, season.details?.[m.id] ?? null));
  }

  /* 第三段:統計、核對、寫檔 */
  for (const job of work) {
    const { cup, file, smStore, seasonsOut, missing, available } = job;
    for (const season of seasonsOut) {
      const label = season.label;
      const { got = 0, bad = 0 } = detailStats.get(season) ?? {};

      season.unknownReasons = [...new Set(season.matches.flatMap(m => m.unknownReasons ?? []))];
      season.nearMisses = [...new Set(season.matches.flatMap(m => [m.home, m.away])
        .filter(t => t?.name && !t.code && looseCodeOf(t.name))
        .map(t => `${t.name}(id ${t.sourceId} → 疑似 ${looseCodeOf(t.name)})`))];
      season.finished = season.matches.length > 0 && season.matches.every(m => m.played || m.state === 'CANCELLED' || m.state === 'AWARDED');
      season.total = season.matches.length;
      const sm = smStore?.seasons?.find(s => s.label === label) ?? null;
      season.crossCheck = sm
        ? { against: 'SportMonks', smRetrievedAt: smStore.retrievedAt ?? null, smMatches: sm.matches.length, ...crossCheckWithSportmonks(season.matches, sm.matches) }
        : null;

      const played = season.matches.filter(m => m.played).length;
      const pk = season.matches.filter(m => m.state === 'FT_PEN').length;
      const pkKnown = season.matches.filter(m => m.state === 'FT_PEN' && m.pensWinner).length;
      const mapped = season.matches.filter(m => m.home?.code || m.away?.code).length;
      const cc = season.crossCheck;
      console.log(`  ${cup.zh} ${label}:${season.total} 場・已完賽 ${played}・延長 ${season.matches.filter(m => m.aet === true).length}`
        + `・PK ${pk}(勝方已補 ${pkKnown}${got ? `,這次 +${got}` : ''}${bad ? `,失敗 ${bad}` : ''})・含英超球隊 ${mapped}`);
      if (cc) console.log(`    核對 SportMonks:對上 ${cc.matched}/${cc.compared}・比分一致 ${cc.agree}・不一致 ${cc.disagree.length}・PK 有無不同 ${cc.pensMismatch.length}・無法核對 ${cc.unverified}`
        + (cc.disagree.length ? `\n    ✗ ${cc.disagree.slice(0, 5).map(d => `${d.home} v ${d.away} ${d.date}:FotMob ${d.fotmob} / SM ${d.sportmonks}`).join('\n    ✗ ')}` : '')
        + (cc.pensMismatch.length ? `\n    · PK 有無不同(不擋,以單場詳情為準):${cc.pensMismatch.slice(0, 5).map(d => `${d.home} v ${d.away} ${d.date}:FotMob ${d.fotmob} / SM ${d.sportmonks}`).join(';')}` : ''));
      else console.log('    (沒有 SportMonks 快取可核對這一季)');
      if (season.unknownReasons.length) console.log(`    ⚠ 沒見過的完賽狀態:${season.unknownReasons.join('、')} —— 核對過才可加進 KNOWN_REASONS`);
      if (season.nearMisses.length) console.log(`    ⚠ 名字接近但沒自動對應(${season.nearMisses.length} 支,刻意不自動採用):\n       ${season.nearMisses.join('\n       ')}`);
    }

    await writeAtomic(file, {
      key: cup.key, zh: cup.zh, en: cup.en, leagueId: cup.id, schemaVersion: SCHEMA_VERSION,
      source: 'FotMob', retrievedAt: now,
      availableSeasons: available, missingSeasons: missing,
      coverage: {
        note: '只有正賽(足總盃從 Round 1 起、聯賽盃從 Round 1 起);第九級打起的資格賽與 preliminary round 不在來源裡。',
        verifiedAgainst: smStore ? `SportMonks 舊快取(抓到 ${smStore.retrievedAt ?? '?'} 為止)` : null,
      },
      seasons: seasonsOut,
    });
    console.log(`  ✔ ${cup.zh} → ${file}`);
  }
  console.log(`\n✔ 英格蘭盃賽抓取完成(${requests}/${MAX_REQUESTS} 個請求)`);
}

main().catch(e => { console.error(`✗ 英格蘭盃賽抓取失敗:${e.message}`); process.exitCode = 1; });
