#!/usr/bin/env node
/* 把字體抓下來存成 web/assets/fonts/*.woff2,並產生 web/assets/css/fonts.css 指向它們。
   用法: npm run fonts   (產物已進版控,平常不用重跑)

   2026-09-26 之前是把 woff2 base64 內嵌在 fonts.css 裡(89 KB),再由 app.css @import。
   量過正式站的代價:@import 要等 app.css 下載完才會被發現(串行一趟),而 base64 讓字型檔多 33%、
   又跟 CSS 綁在一起快取。改成獨立的 .woff2:HTML 直接 <link> fonts.css(跟 app.css 並行)、
   <link rel="preload" as="font"> 讓字型在第一次繪製前就在路上,不會先用系統字體再跳一次。
   離線與單檔版仍然自足:單檔版打包時 bundle.mjs 把 .woff2 讀回來內嵌成 data URI。
   **檔名要穩定**(archivo.woff2、jetbrains-mono.woff2):每一頁的 preload 是寫死指著它們的。 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 用新版 Chrome 的 UA 才會拿到 woff2 的可變字體版本(一個檔涵蓋所有字重)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FAMILIES = [
  { name: 'Archivo', file: 'archivo', spec: 'Archivo:wght@400..800' },
  { name: 'JetBrains Mono', file: 'jetbrains-mono', spec: 'JetBrains+Mono:wght@400..700' },
];

async function main() {
  const out = ['/* 自動產生,請勿手改 —— 執行 npm run fonts 重新產生。字型檔在 ../fonts/,單檔版打包時會內嵌。 */'];
  const fontsDir = join(ROOT, 'web', 'assets', 'fonts');
  await mkdir(fontsDir, { recursive: true });
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

    let n = 0;
    for (const block of chosen) {
      const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(block)?.[1];
      if (!url) continue;
      const buf = Buffer.from(await (await fetch(url, { headers: { 'user-agent': UA } })).arrayBuffer());
      total += buf.length;
      // 同一個家族多個 latin 區塊(很少見)就編號,第一個不編號 —— 檔名要穩定,HTML 的 preload 寫死指著它
      const file = `${f.file}${n ? `-${n}` : ''}.woff2`;
      await writeFile(join(fontsDir, file), buf);
      out.push(block.replace(/src:[^;]+;/, `src: url('../fonts/${file}') format('woff2');`).trim());
      process.stdout.write(`${file} ${(buf.length / 1024).toFixed(0)} KB `);
      n++;
    }
    console.log('');
  }
  await writeFile(join(ROOT, 'web', 'assets', 'css', 'fonts.css'), out.join('\n\n') + '\n');
  console.log(`\n✔ 字體完成 → web/assets/fonts/*.woff2(${(total / 1024).toFixed(0)} KB)+ web/assets/css/fonts.css`);
}

main().catch(err => { console.error('✗ 抓字體失敗:', err.message); process.exit(1); });
