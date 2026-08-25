#!/usr/bin/env node
// 西甲資料版只抓 2025-26 與 2026-27 的 openfootball 公共領域賽果/賽程。
// 獨立目錄避免與英超同名賽季檔互相覆蓋。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'openfootball-la-liga');
const BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const SEASONS = ['2025-26', '2026-27'];

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const season of SEASONS) {
    const url = `${BASE}/${season}/es.1.json`;
    const res = await fetch(url, { headers: { 'user-agent': 'war-room/1.0 (football analysis side project)' } });
    if (!res.ok) throw new Error(`${season} 抓取失敗:HTTP ${res.status}`);
    const text = await res.text();
    const json = JSON.parse(text);
    if (!Array.isArray(json.matches) || json.matches.length < 300) {
      throw new Error(`${season} 資料不完整:${json.matches?.length ?? 0} 場`);
    }
    await writeFile(join(OUT, `${season}.json`), JSON.stringify(json));
    console.log(`✓ 西甲 ${season}:${json.matches.length} 場`);
  }
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exit(1); });
