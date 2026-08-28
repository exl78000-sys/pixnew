#!/usr/bin/env node
// 把整個平台(CSS + 所有頁面程式 + 全部資料)打包成單一 HTML 檔。
// 用途:寄給別人、丟上任何靜態空間、或直接用瀏覽器開 —— 不需要伺服器。
// 用法: npm run bundle  → dist/warroom.html
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
/* 新增頁面時**這裡也要加**,否則單檔版點那個分頁會是空白 ——
   分頁模式與單檔模式是兩條路徑,只改一邊測不出來。 */
/* 這是**第三份**頁面清單(core.js 還有 PAGES 與 SITE_PAGES)。加新頁時忘了改這裡,
   那一頁不會壞 —— 只會從單檔版靜靜消失,而分頁版一切正常。
   `npm test` 有一條守著:這份清單要涵蓋 web/ 底下的每一個 .html。 */
const PAGES = ['overview', 'index', 'live', 'fixtures', 'analysis', 'teams', 'tactics', 'players', 'coaches', 'news', 'model', 'knowledge', 'cups', 'ucl'];

// 單檔版把所有模組併成同一個 <script type="module">:
//   core.js 去掉 export 變成模組層宣告,再組一個 C 物件給各頁面用;
//   各頁面去掉 import 那行後包成 async function,由路由決定執行哪一個。
//
// 匯出清單一定要從原始碼解析,不能手寫 —— 手寫的清單會跟著 core.js 漂移,
// 少一個名字就是某個頁面在單檔版上整頁掛掉(而多頁版還好好的)。
function coreExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return [...names];
}

async function main() {
  // app.css 會 @import 內嵌字體,單檔版要把它一起攤平進來
  const fonts = await readFile(join(WEB, 'assets', 'css', 'fonts.css'), 'utf8');
  const css = (await readFile(join(WEB, 'assets', 'css', 'app.css'), 'utf8'))
    .replace(/@import url\('fonts\.css'\);/, fonts);
  const coreSrc = await readFile(join(WEB, 'assets', 'js', 'core.js'), 'utf8');
  const exportNames = coreExports(coreSrc);
  const core = coreSrc.replace(/^export /gm, '');

  /* 頁面之間共用的模組(不是 core、也不是某一頁)。單檔版沒有模組解析,
     所以要跟 core 一樣攤平成模組層宣告,並把頁面裡的 import 拿掉 ——
     漏掉的話單檔版會在該頁拋 "mountFixtureList is not defined"。 */
  /* 相依順序:sim-table 與 fixture-list 都只引用 core,彼此無關,
     所以這裡的順序不重要;真的出現「共用模組引用共用模組」時要照相依排。 */
  const SHARED = ['fixture-list', 'sim-table'];
  const sharedSrc = [];
  for (const name of SHARED) {
    const src = await readFile(join(WEB, 'assets', 'js', `${name}.js`), 'utf8');
    sharedSrc.push(src.replace(/^import \* as C from '\.\/core\.js(\?v=[0-9a-f]+)?';\s*/m, '').replace(/^export /gm, ''));
  }

  const pageSrc = {};
  for (const p of PAGES) {
    const src = await readFile(join(WEB, 'assets', 'js', `page-${p}.js`), 'utf8');
    pageSrc[p] = src
      .replace(/^import \* as C from '\.\/core\.js(\?v=[0-9a-f]+)?';\s*/m, '')
      .replace(/^import \{[^}]*\} from '\.\/[\w-]+\.js(\?v=[0-9a-f]+)?';\s*/gm, '');
  }

  const dataFiles = (await readdir(join(WEB, 'data'))).filter(f => f.endsWith('.json'));
  const data = {};
  for (const f of dataFiles) data[f.replace(/\.json$/, '')] = JSON.parse(await readFile(join(WEB, 'data', f), 'utf8'));
  const datasets = { pl: data };
  const leaguesDir = join(WEB, 'data', 'leagues');
  try {
    for (const ent of await readdir(leaguesDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = join(leaguesDir, ent.name);
      const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
      datasets[ent.name] = {};
      for (const f of files) datasets[ent.name][f.replace(/\.json$/, '')] = JSON.parse(await readFile(join(dir, f), 'utf8'));
    }
  } catch { /* 沒有額外聯賽時維持只有英超 */ }
  const meta = data.meta;

  // 資料裡若出現 </script 會提前關掉標籤,要先拆開
  const dataJson = JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
  const datasetsJson = JSON.stringify(datasets).replace(/<\/script/gi, '<\\/script');

  const html = `<title>英超戰情室</title>
<meta name="description" content="英超比賽分析平台:球員、戰術、教練、動態與賽果預測。">
<style>
${css}
</style>
<main class="wrap" id="app"><div class="loading">載入資料中…</div></main>
<script>window.__WARROOM_BUNDLE__ = true; window.__DATA__ = ${dataJson}; window.__DATASETS__ = ${datasetsJson};</script>
<script type="module">
${core}

const C = { ${exportNames.join(', ')} };

${sharedSrc.join('\n')}

const PAGE_FNS = {
${PAGES.map(p => `  '${p}': async () => {\n${pageSrc[p].split('\n').map(l => '    ' + l).join('\n')}\n  },`).join('\n')}
};

// 單檔版沒有真的換頁,靠 hash 路由重新渲染:先清掉上一頁留下的節點再跑新頁
async function route() {
  const page = location.hash.slice(1).split('?')[0] || 'index';
  // 先收掉上一頁的計時器 —— 不收的話實時戰況頁的重畫計時器會在 30 秒後
  // 把你正在看的比賽分析整個蓋掉(網址沒變,畫面卻換了)
  clearPageTimers();
  document.querySelector('.topbar')?.remove();
  document.getElementById('dw')?.remove();
  document.getElementById('dbg')?.remove();
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">載入中…</div>';
  window.scrollTo(0, 0);
  try {
    await (PAGE_FNS[page] ?? PAGE_FNS.index)();
  } catch (err) {
    app.innerHTML = '<div class="note">頁面載入失敗:' + esc(err.message) + '</div>';
    console.error(err);
  }
}
addEventListener('hashchange', route);
route();
</script>`;

  await mkdir(join(ROOT, 'dist'), { recursive: true });
  const out = join(ROOT, 'dist', 'warroom.html');
  await writeFile(out, html);
  console.log(`✔ 單檔版完成 → dist/warroom.html(${(html.length / 1024 / 1024).toFixed(2)} MB)`);
  const datasetCount = Object.values(datasets).reduce((n, d) => n + Object.keys(d).length, 0);
  console.log(`  含 ${PAGES.length} 個頁面、${datasetCount} 份資料集(${Object.keys(datasets).length} 個聯賽)、${exportNames.length} 個共用函式、基準日 ${meta.asOf}`);
}

main().catch(err => { console.error('✗ 打包失敗:', err); process.exit(1); });
