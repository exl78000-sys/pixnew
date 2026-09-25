#!/usr/bin/env node
/* 在 runner 上把**國家隊抓取器真的跑一次**,寫到暫存目錄(不動倉庫),印摘要與可以逐位元組還原的內容。
 *
 *   npm run probe:intl-fetch
 *
 * ── 為什麼要這一支 ──
 * 抓取器(fetch-intl-fotmob.mjs)要打 FotMob,沙箱連不到;而部署那一支(epl-live.yml)在開發分支上跑
 * 會連 Pages 一起部署 —— 還沒合併的東西不能那樣驗。所以這裡照探測的規矩:**唯讀**(只寫 runner 的暫存目錄)、
 * 請求數有上限(抓取器自己的 20),把抓回來的檔案 gzip + base64 印在 log 裡,
 * 每個檔附原始位元組數與 sha256 —— 本機還原之後對得上雜湊,才代表拿到的就是 runner 上抓取器寫出來的那一份,
 * 而不是「log 被截斷、少了一段」的半份。
 *
 * 印的東西:
 *   1. 抓取器自己的 log(每個賽事幾場、證明過沒有、有沒有多抓上一季)
 *   2. 摘要:每個賽事 NS / LIVE / FT / CANCELLED 各幾場、reason 的種類、**身分對不上的隊名**(要補的 alias)
 *   3. DUMP 區塊(**一定排在最後** —— 讀 log 是抓尾端,摘要被擠掉比 DUMP 被擠掉好補)
 */
import { mkdtempSync, readdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fetchIntl, loadMartj42 } from './fetch-intl-fotmob.mjs';
import { loadIntlTeamTable, makeIntlResolver } from './lib/intl-teams.mjs';

const out = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'fotmob-intl-'));
/* 先把倉庫裡的快取放進暫存目錄(2026-09-25):部署那一支就是帶著這份快取跑的 —— 上一季的證據沿用、
   不重抓。從空目錄開始的話,每一次探測都會多抓七個上一季,而且驗的不是部署實際會走的那條路。 */
const REPO_RAW = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'raw', 'fotmob-intl');
if (existsSync(REPO_RAW)) for (const f of readdirSync(REPO_RAW).filter(x => x.endsWith('.json'))) copyFileSync(join(REPO_RAW, f), join(out, f));
await fetchIntl({ outDir: out, force: true });

const mj = loadMartj42();
const resolver = mj ? makeIntlResolver(loadIntlTeamTable(join(dirname(fileURLToPath(import.meta.url)), '..')), new Set(mj.flatMap(m => [m.home, m.away]))) : null;
const files = readdirSync(out).filter(f => f.endsWith('.json')).sort();

console.log(`\n${'─'.repeat(72)}\n▶ 摘要(${files.length} 個檔)`);
const unknown = new Map();
for (const f of files) {
  const j = JSON.parse(readFileSync(join(out, f), 'utf8'));
  const by = {};
  const reasons = {};
  for (const m of j.matches) { by[m.state] = (by[m.state] ?? 0) + 1; if (m.reason) reasons[m.reason] = (reasons[m.reason] ?? 0) + 1; }
  const next = j.matches.filter(m => m.state === 'NS').sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)).slice(0, 2)
    .map(m => `${m.kickoff.slice(0, 16)} ${m.home?.name} v ${m.away?.name}`);
  console.log(`  ${f}:${j.fmName}・季 ${j.season}・${JSON.stringify(by)}・reason ${JSON.stringify(reasons)}`
    + `・上一季證據 ${j.proof ? `${j.proof.season} ${j.proof.matches.length} 場` : '無'}`
    + `・分組積分榜 ${j.groups ? `${j.groups.length} 組(進行中 ${j.groups.flatMap(g => g.rows).filter(r => r.live).length} 列)` : '無'}`);
  if (next.length) console.log(`    接下來:${next.join('、')}`);
  if (resolver) for (const m of [...j.matches, ...(j.proof?.matches ?? [])]) {
    for (const t of [m.home, m.away]) if (t?.name && !resolver.keyOf(t.name)) unknown.set(t.name, (unknown.get(t.name) ?? 0) + 1);
  }
}
console.log(`  身分對不上的隊名 ${unknown.size} 個:${[...unknown].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join('、') || '無'}`);

console.log(`\n${'─'.repeat(72)}\n▶ DUMP(gzip + base64;本機還原後比對 sha256)`);
for (const f of files) {
  const buf = readFileSync(join(out, f));
  const sha = createHash('sha256').update(buf).digest('hex');
  const chunks = gzipSync(buf, { level: 9 }).toString('base64').match(/.{1,3000}/g) ?? [];
  console.log(`DUMP-BEGIN ${f} ${buf.length} ${sha} ${chunks.length}`);
  chunks.forEach((c, i) => console.log(`DUMP ${f} ${i} ${c}`));
  console.log(`DUMP-END ${f}`);
}
console.log('✔ 探測結束(沒有寫倉庫裡的任何檔)');
