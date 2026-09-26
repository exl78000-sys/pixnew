/* 圖片外置(2026-09-26,A2 + A3)。

   為什麼:產物裡的隊徽、頭貼、國旗、賽事圖原本都是 base64 data URI 內嵌在 JSON 裡 ——
   量過正式站:players.json 3.3 MB 有 2 MB 是 572 張頭貼(base64 讓 gzip 壓不動,傳輸 1.6 MB)、
   clubs.json 271 KB 有 265 KB 是 27 面隊徽、ucl-teams.json 648 KB 幾乎全是圖、cups.json 1.07 MB 有 838 KB 是圖;
   同一面隊徽在 clubs / teams / ucl-teams / 各聯賽的複本裡各存一份,而且跟著每一次資料改動一起重新下載、重新解析。

   做法:每一張圖落成**內容雜湊命名的獨立檔** `assets/img/h/<sha1 前 16 碼>.<副檔名>`,產物裡只留這個相對路徑。
   - 內容定址天然去重:同一張圖不論出現在幾份產物、幾個聯賽,磁碟上只有一個檔;
   - 圖沒變檔名就不變(瀏覽器快取與 git 都不用重存),圖變了檔名跟著變,不會吃到舊快取;
   - 產物裡剩 30 個字元的路徑,gzip 有效;圖用 <img loading="lazy"> 自己按需載。
   前端本來就是 `<img src=...>` / `<image href=...>`,data URI 換成相對路徑不用改畫法;
   單檔版沒有外部檔,打包時用 inlineImages 換回 data URI(所以 Node 端讀圖一律走 imageBytes,兩種都吃)。
   舊檔清理交給 prune-images.mjs:掃所有產物找還被引用的檔,只刪 assets/img/h/ 底下沒人引用的。

   **byte 穩定**:檔名由內容決定,檔案存在就不重寫(mtime 也不動),連跑兩次 build 磁碟上一個位元組都不變。 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const IMG_DIR = 'assets/img/h';
const DATA_RE = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/;
const EXT = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', gif: 'gif', 'svg+xml': 'svg' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
export const REF_RE = /^assets\/img\/h\/[0-9a-f]{16}\.(png|jpg|webp|gif|svg)$/;

const extOfRef = ref => ref.slice(ref.lastIndexOf('.') + 1);

/* 「這個值是不是一張圖」:data URI(單檔版、manual 的原始庫)或 assets/img/h/ 的路徑(分頁版產物)都算。
   給 webDir 的話路徑要真的有檔才算(測試用它守「按鈕在但圖是破的」);給 ext 的話副檔名也要對。 */
export function isImageRef(v, { webDir = null } = {}, ext = null) {
  if (typeof v !== 'string') return false;
  const m = DATA_RE.exec(v);
  if (m) return !ext || EXT[m[1]] === ext;
  if (!REF_RE.test(v)) return false;
  if (ext && extOfRef(v) !== ext) return false;
  return webDir ? existsSync(join(webDir, v)) : true;
}

/* 把圖讀成位元組:data URI 直接解 base64,路徑就從 web/ 讀檔。Obsidian 與測試都走這裡,不各自解一次。 */
export function imageBytes(v, { webDir = null } = {}) {
  if (typeof v !== 'string') return null;
  const m = DATA_RE.exec(v);
  if (m) return { ext: EXT[m[1]], buf: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') };
  if (!REF_RE.test(v) || !webDir) return null;
  const p = join(webDir, v);
  return existsSync(p) ? { ext: extOfRef(v), buf: readFileSync(p) } : null;
}

/* 深走訪,字串是 data URI 的就落檔、換成路徑;回傳**新的**物件(不動呼叫端手上的資料 ——
   build 寫完一份產物之後常常還會拿同一個物件去組下一份)。stats 給的話累計張數與位元組。 */
export function externalizeImages(data, { webDir, stats = null }) {
  const dir = join(webDir, IMG_DIR);
  let made = false;
  const seen = new Map();   // data URI → 路徑,同一份產物裡重複的圖只雜湊一次
  const put = uri => {
    if (seen.has(uri)) return seen.get(uri);
    const m = DATA_RE.exec(uri);
    if (!m) return uri;
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    const name = `${createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${EXT[m[1]]}`;
    const ref = `${IMG_DIR}/${name}`;
    const p = join(dir, name);
    /* 存在而且大小一樣就不碰:內容定址,同名必同內容(sha1 前 64 位元撞到的機率可以不管)。
       大小不一樣代表上一次寫到一半被中斷,重寫。 */
    if (!existsSync(p) || statSync(p).size !== buf.length) {
      if (!made) { mkdirSync(dir, { recursive: true }); made = true; }
      writeFileSync(p, buf);
      if (stats) stats.written = (stats.written ?? 0) + 1;
    }
    if (stats) { stats.images = (stats.images ?? 0) + 1; stats.bytes = (stats.bytes ?? 0) + buf.length; }
    seen.set(uri, ref);
    return ref;
  };
  const walk = v => {
    if (typeof v === 'string') return v.length > 64 && v.startsWith('data:image/') ? put(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(data);
}

/* 反向:路徑換回 data URI(單檔版用)。讀不到的檔照原樣留著 —— 單檔版開起來會是破圖,而 bundle 的守門會先擋。 */
export function inlineImages(data, { webDir }) {
  const cache = new Map();
  const get = ref => {
    if (cache.has(ref)) return cache.get(ref);
    const p = join(webDir, ref);
    const uri = existsSync(p) ? `data:${MIME[extOfRef(ref)]};base64,${readFileSync(p).toString('base64')}` : ref;
    cache.set(ref, uri);
    return uri;
  };
  const walk = v => {
    if (typeof v === 'string') return REF_RE.test(v) ? get(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(data);
}

/* 掃 web/data 底下**每一份** JSON 找還被引用的圖檔。連逐場檔也掃 —— 慢幾秒,但少掃一個目錄的代價是
   哪天有人在那裡放了圖,prune 會靜靜把它刪掉而畫面只剩破圖框。 */
export function referencedImages(webDir) {
  const refs = new Set();
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.json')) continue;
      const s = readFileSync(p, 'utf8');
      for (const m of s.matchAll(/assets\/img\/h\/([0-9a-f]{16}\.[a-z]+)/g)) refs.add(m[1]);
    }
  };
  const dataDir = join(webDir, 'data');
  if (existsSync(dataDir)) walk(dataDir);
  return refs;
}

/* 只刪 assets/img/h/ 裡沒被任何產物引用的檔;別的目錄一個都不碰。 */
export function pruneImages(webDir) {
  const dir = join(webDir, IMG_DIR);
  if (!existsSync(dir)) return { kept: 0, removed: 0, referenced: 0 };
  const refs = referencedImages(webDir);
  let kept = 0, removed = 0;
  for (const f of readdirSync(dir)) {
    if (refs.has(f)) { kept++; continue; }
    rmSync(join(dir, f));
    removed++;
  }
  return { kept, removed, referenced: refs.size };
}
