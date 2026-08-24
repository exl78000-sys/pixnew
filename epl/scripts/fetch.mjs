#!/usr/bin/env node
// 抓取原始資料 → epl/data/raw/
// 用法: npm run fetch [--force]   (--force 會覆寫既有檔案)
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceList } from './lib/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const force = process.argv.includes('--force');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function download(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'epl-warroom/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 4) throw err;
    const wait = 2 ** attempt * 1000;
    console.warn(`   ↻ 第 ${attempt} 次失敗(${err.message}),${wait / 1000}s 後重試`);
    await sleep(wait);
    return download(url, attempt + 1);
  }
}

const exists = async p => stat(p).then(() => true, () => false);

async function main() {
  const items = sourceList();
  console.log(`▶ 開始抓取 ${items.length} 份原始資料\n`);
  let ok = 0, skipped = 0, failed = 0;
  for (const it of items) {
    const out = join(RAW, it.file);
    if (!force && await exists(out)) { console.log(`  ⏭  ${it.label}(已存在,--force 可覆寫)`); skipped++; continue; }
    process.stdout.write(`  ↓  ${it.label} … `);
    try {
      const body = await download(it.url);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, body);
      console.log(`${(body.length / 1024).toFixed(0)} KB`);
      ok++;
    } catch (err) {
      // optional 的來源(例如更早賽季的交手紀錄)上游沒有就算了,
      // 不能因為它讓整個抓取流程算失敗 —— 主資料還是好的
      console.log(`✗ ${err.message}${it.optional ? '(選用來源,略過)' : ''}`);
      if (it.optional) skipped++; else failed++;
    }
  }
  console.log(`\n✔ 完成:新增 ${ok} / 略過 ${skipped} / 失敗 ${failed}`);
  if (failed) process.exitCode = 1;
}

main();
