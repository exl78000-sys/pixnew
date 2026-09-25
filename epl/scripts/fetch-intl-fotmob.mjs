#!/usr/bin/env node
/* 國家隊賽事的賽程與賽果 —— FotMob 聯賽端點 → data/raw/fotmob-intl/{key}.json(2026-09-24)
 *
 * 為什麼要 FotMob:歷史賽果的獨立來源(martj42/international_results)**只收踢完的比賽**,
 * 賽程與這一窗的新賽果只能從這裡拿。收哪些賽事、每個 id 怎麼證明的,看 lib/adapters/fotmob-intl.mjs 的檔頭。
 *
 * 規矩:
 * 1. **一個賽事一個請求**(本季),3 小時內不重抓(`--force` 例外)。八個賽事 = 八個請求。
 * 2. **id 要用內容證明**:本季已完賽、而且落在 martj42 涵蓋範圍內的場次逐場對過去,
 *    對上的數量不夠(Nations League 本季一場都還沒踢)就**多抓一次上一季**當證據 ——
 *    上一季不會再變,抓過就存在 `proof` 裡永久用,不重抓。所以只有第一次會多幾個請求。
 *    證明的門檻與判決在 lib/intl.mjs 的 proofFromCheck;**建置時會用當下的對照表重算一次**,
 *    這裡算的只是決定「要不要多抓上一季」。
 * 3. **驗 selectedSeason**:帶 season 參數要的那季不存在時,FotMob 回的是最新那季(盃賽那次實際踩過),
 *    不驗的話會把本季存成上一季的證據。
 * 4. **驗 details.name 不是女足 / 青年 / 奧運**:allLeagues 的名字靠不住(10557 在那裡沒有 Women's),
 *    所以看單一賽事端點自己的 details.name。
 * 5. 抓不到就保留上一份,不洗掉;回的場次是 0 而同一季上一份有場次,當成上游暫時性的空回應,也保留上一份。
 *
 * 唯讀以外只寫 `outDir`。沙箱連不到 FotMob —— 在 runner 上跑(epl-live.yml 的部署那一條)。
 *
 *   npm run intl:fetch
 *   npm run intl:fetch -- --force
 *   npm run intl:fetch -- --out=/tmp/fotmob-intl     # 探測用:寫到別的地方,不動倉庫
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FOTMOB_INTL, normaliseIntlMatch } from './lib/adapters/fotmob-intl.mjs';
import { parseIntlResults, crossCheckIntl, proofFromCheck } from './lib/intl.mjs';
import { loadIntlTeamTable, makeIntlResolver } from './lib/intl-teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const INTL_RAW_DIR = join(ROOT, 'data', 'raw', 'fotmob-intl');
const BASE = 'https://www.fotmob.com';
const UA = 'pl-war-room/1.0 (football analysis side project)';
const GAP = 800;
const TTL_MS = 3 * 3600000;
// 版本不同就整份重抓(修了轉換邏輯而快取還在 TTL 內 → 修了等於沒修,encups 踩過)
export const INTL_SCHEMA_VERSION = 1;
/* 不是男子 A 級的賽事名。只拿來擋 details.name —— 真正的身分證明是內容比對,這一道是便宜的第一關。 */
const NOT_MEN_A = /women|\(w\)|\bw\b|femenin|\bu-?\d{2}\b|youth|olympic|futsal|beach/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async p => { if (!existsSync(p)) return null; try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1) + '\n');
  await rename(tmp, file);
}

/* martj42 的賽果(沒有就回 null:證明那一步跳過,第一次跑不擋賽程) */
export function loadMartj42(root = ROOT) {
  const p = join(root, 'data', 'raw', 'intl', 'results.csv');
  return existsSync(p) ? parseIntlResults(readFileSync(p, 'utf8')) : null;
}

/* `gapMs` 只給測試用(拿假的 fetch 驗守門邏輯時不必真的等);線上一律用預設的禮貌間隔。 */
export async function fetchIntl({ outDir = INTL_RAW_DIR, force = false, maxRequests = 20, gapMs = GAP, log = console.log } = {}) {
  let requests = 0;
  async function get(url) {
    if (requests >= maxRequests) throw new Error(`已達本次 ${maxRequests} 個請求上限`);
    if (requests && gapMs) await sleep(gapMs);
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

  const mj = loadMartj42();
  const lastDate = mj?.at(-1)?.date ?? null;
  const resolver = mj ? makeIntlResolver(loadIntlTeamTable(ROOT), new Set(mj.flatMap(m => [m.home, m.away]))) : null;
  if (!mj) log('  ⚠ 沒有 data/raw/intl/results.csv(先跑 npm run intl:results)—— 這一輪不做 id 證明,只抓賽程');

  await mkdir(outDir, { recursive: true });
  log(`▶ 國家隊賽事(FotMob):${FOTMOB_INTL.length} 個賽事・最多 ${maxRequests} 個請求${lastDate ? `・martj42 涵蓋到 ${lastDate}` : ''}`);
  const summary = [];
  const needProof = [];

  // 第一段:本季賽程(一個賽事一個請求)
  for (const comp of FOTMOB_INTL) {
    const file = join(outDir, `${comp.key}.json`);
    let prev = await readJson(file);
    if (prev && (prev.schemaVersion !== INTL_SCHEMA_VERSION || prev.id !== comp.id)) {
      log(`  ${comp.zh}:快取是舊版結構或別的 id,整份重抓`);
      prev = null;
    }
    const age = prev?.retrievedAt ? Date.now() - Date.parse(prev.retrievedAt) : Infinity;
    let rec = prev;
    if (!prev || force || age >= TTL_MS) {
      try {
        const body = await get(`${BASE}/api/data/leagues?id=${comp.id}`);
        const det = body.details ?? {};
        const name = String(det.name ?? '');
        if (NOT_MEN_A.test(name)) throw new Error(`details.name 是「${name}」,不是男子 A 級 —— id 可能被重新指派,不收`);
        const matches = (body.fixtures?.allMatches ?? []).map(normaliseIntlMatch).filter(m => m.id && m.kickoff);
        const season = det.selectedSeason ?? null;
        if (!matches.length && prev?.matches?.length && prev.season === season) {
          throw new Error(`同一季(${season})回了 0 場,上一份有 ${prev.matches.length} 場 —— 當成暫時性的空回應`);
        }
        rec = {
          schemaVersion: INTL_SCHEMA_VERSION, key: comp.key, id: comp.id, fmName: name || null,
          season, availableSeasons: body.allAvailableSeasons ?? det.allAvailableSeasons ?? [],
          retrievedAt: new Date().toISOString(), matches,
          // 上一季的證據不隨本季重抓而消失(它不會再變)
          proof: prev?.proof ?? null,
        };
        await writeAtomic(file, rec);
      } catch (e) {
        log(`  ✗ ${comp.zh}:${e.message}${prev ? '(保留上一份)' : ''}`);
        summary.push({ key: comp.key, ok: false, why: e.message });
        if (!prev) continue;
        rec = prev;
      }
    } else {
      log(`  ${comp.zh}:快取 ${(age / 3600000).toFixed(1)} 小時前抓的,不重抓`);
    }

    const ns = rec.matches.filter(m => m.state === 'NS').length;
    const ft = rec.matches.filter(m => m.state === 'FT').length;
    let proof = null;
    if (mj) {
      const pool = [...rec.matches, ...(rec.proof?.matches ?? [])];
      proof = proofFromCheck(crossCheckIntl(pool, mj, resolver.keyOf), comp.expect);
      if (!proof.ok && !rec.proof) needProof.push({ comp, file, rec });
    }
    log(`  ${comp.zh}(${comp.id}):季 ${rec.season}・${rec.matches.length} 場(未賽 ${ns}、已完賽 ${ft})`
      + (proof ? `・證明 ${proof.ok ? '✓' : '—'} 對上 ${proof.matched} 場${rec.proof ? `(含上一季 ${rec.proof.season} 的 ${rec.proof.matches.length} 場)` : ''}` : ''));
    if (!summary.some(s => s.key === comp.key)) summary.push({ key: comp.key, ok: true });
  }

  // 第二段:證據不夠的,抓上一季(只有第一次會走到這裡)
  for (const { comp, file, rec } of needProof) {
    const list = rec.availableSeasons ?? [];
    const i = list.indexOf(rec.season);
    const want = i >= 0 ? list[i + 1] : null;
    if (!want) { log(`  · ${comp.zh}:本季證據不夠,而且沒有上一季可以拿(可選季 ${list.join(' / ') || '—'})—— 建置會把它排除`); continue; }
    try {
      const body = await get(`${BASE}/api/data/leagues?id=${comp.id}&season=${encodeURIComponent(want)}`);
      const got = body.details?.selectedSeason ?? null;
      if (got !== want) throw new Error(`要的是 ${want},回的是 ${got} —— 上游沒有那一季時會回最新那季,不收`);
      const matches = (body.fixtures?.allMatches ?? []).map(normaliseIntlMatch).filter(m => m.id && m.kickoff && m.state === 'FT');
      rec.proof = { season: want, retrievedAt: new Date().toISOString(), matches };
      await writeAtomic(file, rec);
      const p = proofFromCheck(crossCheckIntl([...rec.matches, ...matches], mj, resolver.keyOf), comp.expect);
      log(`  ${comp.zh}:上一季 ${want} 已完賽 ${matches.length} 場 → 證明 ${p.ok ? '✓' : '✗ ' + p.why}(對上 ${p.matched}:${p.tournaments.slice(0, 3).map(x => `${x.t}×${x.n}`).join('、')})`);
    } catch (e) {
      log(`  ✗ ${comp.zh} 上一季 ${want}:${e.message}`);
    }
  }

  log(`✔ 國家隊賽事:這一輪 ${requests} 個請求,寫到 ${outDir}`);
  return { requests, summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
  const out = arg('out') ? resolve(arg('out')) : INTL_RAW_DIR;
  fetchIntl({ outDir: out, force: process.argv.includes('--force') })
    .then(({ summary }) => {
      // 全部失敗才算失敗(外部來源,CI 那一步本來就 continue-on-error;這裡只是讓 log 看得出來)
      if (summary.length && summary.every(s => !s.ok)) process.exitCode = 1;
    })
    .catch(e => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
}
