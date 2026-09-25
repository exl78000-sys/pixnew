#!/usr/bin/env node
/* 國家隊賽事的積分榜與淘汰賽對陣長什麼樣 —— **先存一份看過,不猜欄位名**(2026-09-25)。
 *
 *   npm run probe:intl-tables
 *
 * ── 為什麼要這一支 ──
 * 抓取器(fetch-intl-fotmob.mjs)打的聯賽端點,同一個回應裡除了 `fixtures` 還有別的區塊
 * (分組積分榜、淘汰賽對陣),抓取器目前只存賽程。要不要存、怎麼畫,得先看上游**實際**給什麼:
 * 本站踩過好幾次「照直覺讀欄位」(`total_scoring_att` 是每 90 分、`et` 是增量不是累計、
 * FotMob 烏龍球事件的 team 是踢進自家門的那一隊)。沙箱連不到 FotMob,所以在 runner 上問。
 *
 * 印的東西:
 *   1. 每個賽事回應的頂層鍵與 `tabs`(上游自己說這個賽事有哪幾個分頁)
 *   2. `table` 與 `playoff` 的**結構**(逐層的鍵與型別、陣列長度、第一個元素長什麼樣),
 *      每一張分組表的名字、列數、第一列原文 —— 摘要排在 DUMP 前面
 *   3. DUMP 區塊(**一定排在最後**):每個賽事把 { tabs, table, playoff } 原封不動 gzip + base64,
 *      附位元組數與 sha256,本機用 `npm run probe:undump` 還原後逐位元組核對
 *
 * 唯讀、**8 個請求**(一個賽事一個,跟抓取器打的是同一個網址)、不寫任何快取,
 * 掛在 probe-apis.yml 的 latest job 最後一步。
 */
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { FOTMOB_INTL } from './lib/adapters/fotmob-intl.mjs';

const BASE = 'https://www.fotmob.com';
const UA = 'pl-war-room/1.0 (football analysis side project)';
const GAP = 800;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v);

/* 結構:逐層印鍵與型別。陣列只展開第一個元素,但**把其他元素多出來 / 少掉的鍵也講出來**
   (只看第一個會漏掉「有的列有 deduction、有的沒有」這種事)。 */
function shape(v, pad = '    ', depth = 0) {
  if (depth > 7) return [`${pad}…(太深,略)`];
  const out = [];
  if (Array.isArray(v)) {
    if (!v.length) return out;
    const first = v[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const k0 = new Set(Object.keys(first));
      const extra = new Set(), missing = new Set();
      for (const x of v.slice(1)) {
        if (!x || typeof x !== 'object') continue;
        for (const k of Object.keys(x)) if (!k0.has(k)) extra.add(k);
        for (const k of k0) if (!(k in x)) missing.add(k);
      }
      if (extra.size) out.push(`${pad}[其他元素多出的鍵] ${[...extra].join(', ')}`);
      if (missing.size) out.push(`${pad}[其他元素少掉的鍵] ${[...missing].join(', ')}`);
    }
    out.push(`${pad}[0]: ${typeOf(first)}`);
    if (first && typeof first === 'object') out.push(...shape(first, pad + '  ', depth + 1));
    return out;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const leaf = x === null || typeof x !== 'object';
      out.push(`${pad}${k}: ${typeOf(x)}${leaf ? ` = ${JSON.stringify(x)?.slice(0, 60)}` : ''}`);
      if (!leaf) out.push(...shape(x, pad + '  ', depth + 1));
    }
  }
  return out;
}

/* 分組表:上游的表可能是一張(data.table)或多張(data.tables[]),名字在哪個鍵也不知道 ——
   所以不假設,**走整份找「看起來像一列積分」的陣列**(元素有 name 與 pts 或 played),
   把它的路徑、列數與第一列原文印出來。 */
function findTables(v, path = 'table', out = []) {
  if (Array.isArray(v)) {
    const rowLike = v.length && v.every(x => x && typeof x === 'object' && 'name' in x && ('pts' in x || 'played' in x));
    if (rowLike) { out.push({ path, rows: v }); return out; }
    v.forEach((x, i) => findTables(x, `${path}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) findTables(x, `${path}.${k}`, out);
  }
  return out;
}

const dumps = [];
let requests = 0;
for (const comp of FOTMOB_INTL) {
  if (requests) await sleep(GAP);
  requests++;
  const url = `${BASE}/api/data/leagues?id=${comp.id}`;
  console.log(`\n${'─'.repeat(72)}\n▶ ${comp.zh}(${comp.key}・${comp.id})`);
  let body;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000),
      headers: { accept: 'application/json', 'user-agent': UA, referer: `${BASE}/` } });
    const text = await res.text();
    if (!res.ok) { console.log(`  ✗ HTTP ${res.status} ${text.slice(0, 120)}`); continue; }
    body = JSON.parse(text);
  } catch (e) { console.log(`  ✗ ${e.message}`); continue; }
  if (body?.error) { console.log(`  ✗ 回了 200 但帶 error:${JSON.stringify(body.error).slice(0, 120)}`); continue; }

  console.log(`  details.name = ${JSON.stringify(body.details?.name)}・selectedSeason = ${JSON.stringify(body.details?.selectedSeason)}`);
  console.log(`  頂層鍵:${Object.keys(body).map(k => `${k}:${typeOf(body[k])}`).join(', ')}`);
  console.log(`  tabs = ${JSON.stringify(body.tabs ?? null)}`);

  for (const key of ['table', 'playoff']) {
    const v = body[key];
    if (v == null || (Array.isArray(v) && !v.length)) { console.log(`  ${key}:${typeOf(v)}(沒有)`); continue; }
    console.log(`  ${key} 的結構:`);
    for (const l of shape(v)) console.log(l);
  }

  const tables = findTables(body.table);
  console.log(`  看起來像積分列的陣列 ${tables.length} 個:`);
  for (const t of tables) {
    console.log(`    ${t.path}:${t.rows.length} 列`);
    console.log(`      第一列:${JSON.stringify(t.rows[0]).slice(0, 400)}`);
  }

  const payload = Buffer.from(JSON.stringify({ key: comp.key, id: comp.id, season: body.details?.selectedSeason ?? null,
    tabs: body.tabs ?? null, table: body.table ?? null, playoff: body.playoff ?? null }));
  dumps.push({ name: `${comp.key}-tables.json`, buf: payload });
}

console.log(`\n${'─'.repeat(72)}\n▶ DUMP(gzip + base64;本機 npm run probe:undump 還原後比對 sha256)・這一輪 ${requests} 個請求`);
for (const { name, buf } of dumps) {
  const sha = createHash('sha256').update(buf).digest('hex');
  const chunks = gzipSync(buf, { level: 9 }).toString('base64').match(/.{1,3000}/g) ?? [];
  console.log(`DUMP-BEGIN ${name} ${buf.length} ${sha} ${chunks.length}`);
  chunks.forEach((c, i) => console.log(`DUMP ${name} ${i} ${c}`));
  console.log(`DUMP-END ${name}`);
}
console.log('✔ 探測結束(沒有寫倉庫裡的任何檔)');
