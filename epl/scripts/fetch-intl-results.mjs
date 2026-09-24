#!/usr/bin/env node
/* 國家隊歷史賽果 —— martj42/international_results → data/raw/intl/
 *
 * 為什麼是它:1872 年至今的男子國家隊 A 級賽(四萬九千多場)、有 PK 勝方,
 * 放在 github 上的靜態檔,走 raw.githubusercontent.com —— **沙箱與 runner 都抓得到**,
 * 而且是跟 FotMob 完全獨立的一份(鐵則五:國際比賽週的賽果要拿它逐場核對)。
 *
 * 它**只收已經踢完的比賽**(2026-09-24 實測 0 筆未賽),所以賽程與即時比分不在這裡,
 * 那一半走 fetch-intl-fotmob.mjs。
 *
 * 規矩:
 * 1. 原檔**逐位元組**存下來(不轉格式),另記 sha256 與筆數 —— 上游改了什麼,git diff 看得到。
 * 2. 6 小時內不重抓(--force 例外);上游更新的節奏是天,不是分鐘。
 * 3. 抓到的檔先自我檢查(表頭、筆數不能比上一份少一成以上、最新一場的日期不能倒退),
 *    沒過就**保留上一份**,不洗掉 —— 上游偶爾會在整理時暫時少一截。
 *
 *   npm run intl:results
 *   npm run intl:results -- --force
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIntlResults, parseShootouts } from './lib/intl.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'intl');
const BASE = 'https://raw.githubusercontent.com/martj42/international_results/master';
const FILES = [
  { name: 'results.csv', head: 'date,home_team,away_team,home_score,away_score,tournament,city,country,neutral' },
  { name: 'shootouts.csv', head: 'date,home_team,away_team,winner,first_shooter' },
];
const TTL_MS = 6 * 3600000;
const FORCE = process.argv.includes('--force');

const sha = t => createHash('sha256').update(t).digest('hex');

async function main() {
  await mkdir(OUT, { recursive: true });
  const metaPath = join(OUT, 'meta.json');
  const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, 'utf8')) : { files: {} };
  if (!FORCE && meta.retrievedAt && Date.now() - Date.parse(meta.retrievedAt) < TTL_MS) {
    console.log(`· 國家隊賽果 ${meta.retrievedAt} 抓過,6 小時內不重抓(--force 例外)`);
    return;
  }
  let changed = false, failed = 0;
  for (const f of FILES) {
    const url = `${BASE}/${f.name}`;
    let text;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      console.log(`✗ ${f.name} 抓不到(${e.message}),保留上一份`);
      failed++; continue;
    }
    const firstLine = text.split('\n', 1)[0].replace(/^﻿/, '').trim();
    if (firstLine !== f.head) { console.log(`✗ ${f.name} 表頭變了(${firstLine.slice(0, 80)}),不採用,保留上一份`); failed++; continue; }
    const prev = meta.files?.[f.name] ?? null;
    const rows = f.name === 'results.csv' ? parseIntlResults(text) : [...parseShootouts(text).values()];
    const lastDate = f.name === 'results.csv' ? rows.at(-1)?.date ?? null : null;
    if (prev?.rows && rows.length < prev.rows * 0.9) { console.log(`✗ ${f.name} 從 ${prev.rows} 筆掉到 ${rows.length} 筆,不採用`); failed++; continue; }
    if (prev?.lastDate && lastDate && lastDate < prev.lastDate) { console.log(`✗ ${f.name} 最新一場從 ${prev.lastDate} 倒退到 ${lastDate},不採用`); failed++; continue; }
    const hash = sha(text);
    if (prev?.sha256 === hash && existsSync(join(OUT, f.name))) { console.log(`· ${f.name} 沒變(${rows.length} 筆)`); continue; }
    const tmp = join(OUT, `${f.name}.tmp`);
    await writeFile(tmp, text);
    await rename(tmp, join(OUT, f.name));
    meta.files[f.name] = { rows: rows.length, lastDate, sha256: hash, bytes: Buffer.byteLength(text) };
    changed = true;
    console.log(`✔ ${f.name}:${rows.length} 筆${lastDate ? `,最新 ${lastDate}` : ''}`);
  }
  meta.source = 'martj42/international_results';
  meta.url = 'https://github.com/martj42/international_results';
  /* 有任何一個檔沒拿到就**不蓋抓取時間** —— 蓋了的話 6 小時內不會再試,而那一份其實是舊的 */
  if (!failed) meta.retrievedAt = new Date().toISOString();
  else process.exitCode = 1;
  await writeFile(metaPath, JSON.stringify(meta, null, 1) + '\n');
  if (!changed) console.log('· 國家隊賽果沒有變化');
}

main().catch(e => { console.error(`✗ ${e.stack ?? e.message}`); process.exitCode = 1; });
