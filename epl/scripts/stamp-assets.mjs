#!/usr/bin/env node
/* 給 web/*.html 與 JS 之間的 import 打上版本戳。

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
   反過來的話 page 的雜湊會在自己的 import 被改寫之後就過期。 */
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

  const cssBody = await read(join(CSS, 'app.css'));
  const cssHash = hash(cssBody);

  let htmlChanged = 0;
  for (const f of (await readdir(WEB)).filter(x => x.endsWith('.html'))) {
    const before = await readFile(join(WEB, f), 'utf8');
    let out = strip(before)
      .replace(/(href="assets\/css\/app\.css)"/, `$1?v=${cssHash}"`);
    for (const [name, h] of pageHash) {
      out = out.replace(`src="assets/js/${name}"`, `src="assets/js/${name}?v=${h}"`);
    }
    if (out !== before) { await writeFile(join(WEB, f), out); htmlChanged++; }
  }

  console.log(`✔ 版本戳:JS ${changed} 個檔案、HTML ${htmlChanged} 頁更新`
    + `(app.css ${cssHash}、core.js ${stamped.get('core.js')})`);
}

main().catch(e => { console.error(`✗ 版本戳失敗:${e.message}`); process.exitCode = 1; });
