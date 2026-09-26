#!/usr/bin/env node
/* 給 web/*.html 與 JS 之間的 import 打上版本戳,並在每一頁的 <head> 注入預載(2026-09-26 起)。

   為什麼要做:改完版面部署上去,使用者卻「沒看到更新」。
   原因是 index.html 直接寫 `assets/js/page-index.js`,沒有任何版本資訊 ——
   瀏覽器(與 GitHub Pages 的快取)會繼續端舊的那一份。
   而且會出現最難察覺的一種:**meta.json 是新的、JS 是舊的** ——
   頁尾的「資料建置於」顯示最新時間,版面卻是上一版,
   看起來像「改動沒生效」,其實是兩份東西的快取步調不同。

   用**內容雜湊**而不是時間戳:檔案沒變就不換網址,快取才有意義,
   而且倉庫裡不會每次 build 都churn 一整排 ?v=。

   相依順序很重要:page-*.js 會 import core.js,
   所以要先算共用模組的雜湊、改寫引用它的檔案,再算那些檔案的雜湊。
   反過來的話 page 的雜湊會在自己的 import 被改寫之後就過期。

   ── 預載(B1,2026-09-26)──
   量過正式站:資料請求要等 HTML → page-*.js → core.js 三趟串行下載都完成才發得出去(1.57 秒才開始抓資料)。
   兩件事在這裡一起注入,因為只有這一支知道每一頁的模組圖與最終的戳:
   1. `<link rel="modulepreload">`:這一頁的模組**遞移**引用的每一支(core、follow、fixture-list…),
      瀏覽器在解析 HTML 時就一起抓,不必等上一層執行到 import 才發現下一層。href 必須跟 import 的網址
      一字不差(含 ?v=),不然預載的那份用不到,等於白抓 —— 所以戳在這裡算完才寫得出來。
   2. 一段內嵌 script,依網址上的 league 預載 meta / clubs / teams 三份每一頁都會載的資料
      (放 HTML 靜態 link 做不到:西甲的資料在 data/leagues/es1/,而同一份 HTML 六個聯賽共用)。
   兩段都夾在 <!-- preload:start --> … <!-- preload:end --> 之間,每次重跑整段換掉,不會越長越多。
   單檔版有自己的 HTML,不經過這裡。 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const JS = join(WEB, 'assets', 'js');
const CSS = join(WEB, 'assets', 'css');

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 8);
// 先把既有的戳拿掉再算,否則雜湊會把上一次的戳算進去,永遠不收斂
const strip = text => text.replace(/(\.(?:js|css))\?v=[0-9a-f]{8}/g, '$1');

const read = async f => strip(await readFile(f, 'utf8'));

/* 每一頁都會載的三份資料。跟 core.js 的頁面清單無關 —— 這裡只講「不管哪一頁都會要」的那幾份,
   多預載一份頁面用不到的等於多下載一次。變動時要看 page-*.js 的 C.load 清單。 */
export const PRELOAD_DATASETS = ['meta', 'clubs', 'teams'];
export const PRELOAD_SCRIPT = `<script>(function(){var m=/[?&]league=([a-z0-9]+)/.exec(location.search);var d=m&&m[1]!=='pl'?'data/leagues/'+m[1]+'/':'data/';${JSON.stringify(PRELOAD_DATASETS)}.forEach(function(n){var l=document.createElement('link');l.rel='preload';l.as='fetch';l.crossOrigin='anonymous';l.href=d+n+'.json';document.head.appendChild(l);});})()</script>`;
export const PRELOAD_START = '<!-- preload:start -->';
export const PRELOAD_END = '<!-- preload:end -->';

async function main() {
  const jsFiles = (await readdir(JS)).filter(f => f.endsWith('.js'));
  const pages = jsFiles.filter(f => f.startsWith('page-'));
  // 共用模組 = 不是 page-* 的那些(core.js、fixture-list.js…)
  const shared = jsFiles.filter(f => !f.startsWith('page-'));

  /* 共用模組之間也可能互相 import(fixture-list 引用 core),
     所以先照「被引用的次數」由少到多排,確保被依賴的先定版。
     目前只有兩層,不做完整拓撲排序 —— 真的變複雜時這裡會需要改。 */
  const srcs = new Map();
  for (const f of jsFiles) srcs.set(f, await read(join(JS, f)));
  const importsOf = f => shared.filter(s => srcs.get(f).includes(`'./${s}'`));
  const order = [...shared].sort((a, b) => importsOf(a).length - importsOf(b).length);

  const stamped = new Map();   // 檔名 → 雜湊
  const applyImports = text => {
    let out = text;
    for (const [name, h] of stamped) out = out.replaceAll(`'./${name}'`, `'./${name}?v=${h}'`);
    return out;
  };

  let changed = 0;
  for (const f of order) {
    const body = applyImports(srcs.get(f));
    stamped.set(f, hash(body));
    const before = await readFile(join(JS, f), 'utf8');
    if (before !== body) { await writeFile(join(JS, f), body); changed++; }
  }

  const pageHash = new Map();
  for (const f of pages) {
    const body = applyImports(srcs.get(f));
    pageHash.set(f, hash(body));
    const before = await readFile(join(JS, f), 'utf8');
    if (before !== body) { await writeFile(join(JS, f), body); changed++; }
  }

  /* 一頁遞移引用哪些共用模組(page → fixture-list → follow …)。照 order 的順序給(被依賴的在前),
     產物才穩定 —— 不然同一個模組圖每次可能排出不同順序,HTML 每次 build 都會 churn。 */
  const closureOf = page => {
    const seen = new Set();
    const stack = [page];
    while (stack.length) {
      const f = stack.pop();
      for (const dep of importsOf(f)) if (!seen.has(dep)) { seen.add(dep); stack.push(dep); }
    }
    return order.filter(f => seen.has(f));
  };

  const cssBody = await read(join(CSS, 'app.css'));
  const cssHash = hash(cssBody);
  /* 字型的 CSS 2026-09-26 起是獨立的 <link>(B2),不再從 app.css @import —— 並行下載,不用等 app.css 先到。
     沒有這個檔(還沒跑 npm run fonts)就不戳,頁面照樣能開(掉回系統字體)。 */
  let fontsHash = null;
  try { fontsHash = hash(await read(join(CSS, 'fonts.css'))); } catch { /* 沒有字型檔 */ }

  let htmlChanged = 0;
  for (const f of (await readdir(WEB)).filter(x => x.endsWith('.html'))) {
    const before = await readFile(join(WEB, f), 'utf8');
    let out = strip(before)
      .replace(/(href="assets\/css\/app\.css)"/, `$1?v=${cssHash}"`);
    if (fontsHash) out = out.replace(/(href="assets\/css\/fonts\.css)"/, `$1?v=${fontsHash}"`);
    let page = null;
    for (const [name, h] of pageHash) {
      if (out.includes(`src="assets/js/${name}"`)) page = name;
      out = out.replace(`src="assets/js/${name}"`, `src="assets/js/${name}?v=${h}"`);
    }
    /* 預載那一段:先整段拿掉再重新注入(有標記就換,沒標記就放在第一個 stylesheet 那行前面)。 */
    out = out.replace(new RegExp(`\\n?[ \\t]*${PRELOAD_START}[\\s\\S]*?${PRELOAD_END}`), '');
    if (page) {
      const links = closureOf(page).map(dep => `<link rel="modulepreload" href="assets/js/${dep}?v=${stamped.get(dep)}">`);
      const block = `\n${PRELOAD_START}\n${links.join('\n')}\n${PRELOAD_SCRIPT}\n${PRELOAD_END}`;
      out = out.replace(/\n<link rel="(?:preload|stylesheet)" href="assets\//, `${block}$&`);
    }
    if (out !== before) { await writeFile(join(WEB, f), out); htmlChanged++; }
  }

  /* 把戳寫進每個聯賽的 meta.json。前端拿它跟 core.js 自己網址上的戳比對 ——
     對不上就是那一頁的 HTML 是舊快取,重載一次(見 core.js 的 checkStale)。
     沒有這一步的話,前端沒有任何辦法知道「我現在跑的是不是最新那一版」。 */
  const stampInfo = { core: stamped.get('core.js') ?? null, css: cssHash };
  const metaFiles = [join(WEB, 'data', 'meta.json')];
  try {
    const lgDir = join(WEB, 'data', 'leagues');
    for (const ent of await readdir(lgDir, { withFileTypes: true })) {
      if (ent.isDirectory()) metaFiles.push(join(lgDir, ent.name, 'meta.json'));
    }
  } catch { /* 沒有其他聯賽時只有英超那一份 */ }
  let metaChanged = 0;
  for (const f of metaFiles) {
    let meta;
    try { meta = JSON.parse(await readFile(f, 'utf8')); } catch { continue; }
    if (JSON.stringify(meta.assets) === JSON.stringify(stampInfo)) continue;
    meta.assets = stampInfo;
    await writeFile(f, JSON.stringify(meta));
    metaChanged++;
  }

  console.log(`✔ 版本戳:JS ${changed} 個檔案、HTML ${htmlChanged} 頁、meta ${metaChanged} 份更新`
    + `(app.css ${cssHash}、fonts.css ${fontsHash ?? '無'}、core.js ${stamped.get('core.js')});每頁注入 modulepreload 與資料預載`);
}

// 被 import 時(測試要拿 PRELOAD_SCRIPT 等常數對 HTML)不跑;直接執行才跑
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(`✗ 版本戳失敗:${e.message}`); process.exitCode = 1; });
}
