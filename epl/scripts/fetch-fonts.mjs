#!/usr/bin/env node
// 把字體抓下來內嵌成 data URI → web/assets/css/fonts.css
// 這樣網站離線可用、單檔版也完全自足(不對外發任何請求)。
// 用法: npm run fonts   (產物已進版控,平常不用重跑)
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 用新版 Chrome 的 UA 才會拿到 woff2 的可變字體版本(一個檔涵蓋所有字重)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FAMILIES = [
  { name: 'Archivo', spec: 'Archivo:wght@400..800' },
  { name: 'JetBrains Mono', spec: 'JetBrains+Mono:wght@400..700' },
];

async function main() {
  const out = ['/* 自動產生,請勿手改 —— 執行 npm run fonts 重新產生 */'];
  let total = 0;
  for (const f of FAMILIES) {
    process.stdout.write(`  ↓  ${f.name} … `);
    const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${f.spec}&display=swap`, { headers: { 'user-agent': UA } });
    if (!cssRes.ok) throw new Error(`取得 ${f.name} 的 CSS 失敗:HTTP ${cssRes.status}`);
    const css = await cssRes.text();

    // 只留 latin 子集(中文本來就會落回系統字體,不需要下載 CJK)
    const blocks = css.split('@font-face').slice(1).map(b => '@font-face' + b);
    const latin = blocks.find(b => /\/\* latin \*\//.test(css.slice(0, css.indexOf(b))) || /latin/.test(b)) ?? blocks.at(-1);
    const target = blocks.filter((b, i) => {
      const before = css.slice(0, css.indexOf(b));
      const lastComment = before.match(/\/\* ([a-z0-9-]+) \*\/(?![\s\S]*\/\* [a-z0-9-]+ \*\/)/);
      return lastComment?.[1] === 'latin';
    });
    const chosen = target.length ? target : [latin];

    for (const block of chosen) {
      const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(block)?.[1];
      if (!url) continue;
      const buf = Buffer.from(await (await fetch(url, { headers: { 'user-agent': UA } })).arrayBuffer());
      total += buf.length;
      out.push(block.replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${buf.toString('base64')}) format('woff2');`).trim());
      process.stdout.write(`${(buf.length / 1024).toFixed(0)} KB `);
    }
    console.log('');
  }
  const path = join(ROOT, 'web', 'assets', 'css', 'fonts.css');
  await writeFile(path, out.join('\n\n') + '\n');
  console.log(`\n✔ 字體內嵌完成 → web/assets/css/fonts.css(原始字體 ${(total / 1024).toFixed(0)} KB)`);
}

main().catch(err => { console.error('✗ 抓字體失敗:', err.message); process.exit(1); });
