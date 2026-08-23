#!/usr/bin/env node
// 抓球隊隊徽 → 縮圖 → 內嵌成 data URI(data/manual/crests.json)
// artifact 的 CSP 會擋所有外部資源,所以隊徽必須內嵌;順便讓網站離線也看得到。
// 用法: npm run crests [--width=64] [--force]
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { decodePNG, resizeRGBA, encodePNG } from './lib/png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'manual', 'crests.json');
const REPO = 'https://raw.githubusercontent.com/luukhopman/football-logos/master';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const WIDTH = Number(arg('width') || 64);
const force = process.argv.includes('--force');

// 該來源依「當季所屬聯賽」放檔案,所以降級球隊要去對應賽季的歷史目錄找
const FOLDERS = [
  'logos/England - Premier League',
  'history/2025-26/England - Premier League',
  'history/2024-25/England - Premier League',
  'history/2023-24/England - Premier League',
];

// 檔名跟 openfootball 的隊名不完全一致(有的留 FC 有的不留),所以逐一試候選
const candidates = t => [...new Set([
  t.of,
  t.of.replace(/\s+FC$/, ''),
  t.of.replace(/\s+AFC$/, ''),
  t.of.replace(/^AFC\s+/, ''),
])];

const url = (folder, name) => `${REPO}/${encodeURI(folder)}/${encodeURIComponent(name)}.png`;

async function findCrest(team) {
  for (const folder of FOLDERS) {
    for (const name of candidates(team)) {
      const res = await fetch(url(folder, name), { method: 'GET' });
      if (res.ok) return { buf: Buffer.from(await res.arrayBuffer()), folder, name };
    }
  }
  return null;
}

async function main() {
  const T = loadTeams(ROOT);
  const existing = !force && existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : { crests: {} };
  const crests = { ...(existing.crests ?? {}) };
  const sources = { ...(existing.sources ?? {}) };

  console.log(`▶ 抓取 ${T.list.length} 支球隊的隊徽(縮到寬 ${WIDTH}px)\n`);
  let got = 0, skipped = 0, failed = [];
  let raw = 0, small = 0;

  for (const t of T.list) {
    if (crests[t.code] && !force) { skipped++; continue; }
    process.stdout.write(`  ${t.code} ${t.en ?? t.of} … `);
    try {
      const found = await findCrest(t);
      if (!found) { console.log('✗ 找不到'); failed.push(t.code); continue; }
      const img = decodePNG(found.buf);
      const out = encodePNG(resizeRGBA(img, WIDTH));
      crests[t.code] = `data:image/png;base64,${out.toString('base64')}`;
      sources[t.code] = `${found.folder}/${found.name}.png`;
      raw += found.buf.length; small += out.length;
      got++;
      console.log(`${img.width}×${img.height} → ${WIDTH}px・${(out.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
      failed.push(t.code);
    }
  }

  await writeFile(OUT, JSON.stringify({
    _note: '球隊隊徽(自動產生,請勿手改)。執行 npm run crests -- --force 可重抓。',
    _source: 'https://github.com/luukhopman/football-logos',
    _license: '隊徽為各俱樂部商標,此處僅作為分析工具的識別用途。',
    _width: WIDTH,
    _updated: new Date().toISOString().slice(0, 10),
    sources, crests,
  }, null, 1));

  console.log(`\n✔ 完成:新增 ${got}・沿用 ${skipped}・失敗 ${failed.length}${failed.length ? '(' + failed.join(',') + ')' : ''}`);
  if (got) console.log(`  原始 ${(raw / 1024).toFixed(0)} KB → 縮圖後 ${(small / 1024).toFixed(0)} KB`);
  console.log('  請接著跑 npm run build');
  if (failed.length) process.exitCode = 1;
}

main();
