#!/usr/bin/env node
/* 抓盃賽對手的隊徽 → 縮圖 → 內嵌成 data URI(data/manual/crests-cups.json)。
 *
 * 為什麼要另外一支:既有的 fetch-crests.mjs 抓的是 luukhopman/football-logos,
 * 那個倉庫是「歐洲前 25 個聯賽」——**只有各國的頂級聯賽**,
 * 沒有英冠、英甲、英乙,更沒有非聯賽球隊。實測過:
 *   logos/England - Premier League/Arsenal FC.png   200
 *   logos/England - Championship/…                  8 種資料夾寫法全部 404
 * 而盃賽的對手大半就是那些球隊,所以那條路補不了。
 *
 * 這裡改用 **SportMonks 自己的隊徽網址**(participants[].image_path)。兩個好處:
 *
 * 1. **拿網址是零額外請求。** participants 本來就在盃賽 fixture 的 include 裡,
 *    image_path 是同一份回傳裡的欄位 —— 不用多打任何一個 API 請求。
 * 2. **用 id 對照,不用隊名。** 隊徽是掛在 SportMonks 的 team id 上的,
 *    不需要做隊名比對 —— 也就完全避開了盃賽最大的那個坑:
 *    寬鬆比對把 AFC Liverpool 對成 Liverpool。id 對就是對,不對就沒有。
 *
 * **抓哪些:只抓「有本站球隊的那幾輪」裡出現的對手。**
 * 足總盃從第九級的資格賽打起,整季 745 支球隊;全抓的話單檔版會胖一大圈,
 * 而那幾百支只出現在資格賽的球隊,讀者在預設畫面上根本看不到。
 * 界線就定在畫面實際會顯示的範圍。
 *
 * 抓取禮貌:單線、間隔 200ms、每次執行硬上限 --limit(預設 120)張,
 * 已經抓過的直接略過(可續跑)。圖片來自我們付費方案的 CDN,不是爬第三方網站。
 *
 *   npm run cup-crests
 *   npm run cup-crests -- --limit=40 --width=64 --force
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, resizeRGBA, encodePNG } from './lib/png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'data', 'raw', 'sportmonks-cups');
const OUT = join(ROOT, 'data', 'manual', 'crests-cups.json');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const WIDTH = Number(arg('width') || 64);
const LIMIT = Number(arg('limit') || 120);
const FORCE = process.argv.includes('--force');
const DELAY = 200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 目標名單:出現在「有本站球隊的輪次」裡、而且本站沒有隊碼的球隊。
   有隊碼的用本站自己那份隊徽(crests.json),不重複抓也不換一份。 */
async function targets() {
  if (!existsSync(SRC)) return { list: [], seasons: 0 };
  const want = new Map();          // sourceId → { name, url }
  let seasons = 0, noUrl = 0;
  for (const f of (await readdir(SRC)).filter(x => x.endsWith('.json'))) {
    const raw = JSON.parse(await readFile(join(SRC, f), 'utf8'));
    for (const s of raw.seasons ?? []) {
      seasons++;
      // 依輪次分組,只留「這一輪有本站球隊」的
      const byStage = new Map();
      for (const m of s.matches ?? []) {
        const k = m.stage ?? '';
        if (!byStage.has(k)) byStage.set(k, []);
        byStage.get(k).push(m);
      }
      for (const list of byStage.values()) {
        if (!list.some(m => m.home?.code || m.away?.code)) continue;
        for (const m of list) for (const side of ['home', 'away']) {
          const t = m[side];
          if (!t || t.code || !t.sourceId) continue;   // 有隊碼的走本站自己那份
          if (!t.name || t.name === 'TBC') continue;   // 未抽籤的位置不是球隊
          if (!t.imageUrl) { noUrl++; continue; }
          if (!want.has(t.sourceId)) want.set(t.sourceId, { name: t.name, url: t.imageUrl });
        }
      }
    }
  }
  return { list: [...want].map(([id, v]) => ({ id, ...v })), seasons, noUrl };
}

async function main() {
  const { list, seasons, noUrl } = await targets();
  if (!seasons) { console.log('⚠ 沒有盃賽快取(先跑 npm run encups),略過。'); return; }
  if (!list.length) {
    console.log(`⚠ 盃賽資料裡沒有任何隊徽網址(${noUrl} 個對手沒有 image_path)——`
      + ' 上游可能沒給這個欄位,或快取還是舊版(schemaVersion < 4),先重跑 npm run encups -- --force。');
    return;
  }

  const store = !FORCE && existsSync(OUT)
    ? JSON.parse(await readFile(OUT, 'utf8')) : { _note: '', crests: {}, sources: {}, failed: {} };
  store.crests ??= {}; store.sources ??= {}; store.failed ??= {};

  const todo = list.filter(t => !store.crests[t.id]);
  console.log(`▶ 盃賽對手隊徽:目標 ${list.length} 隊・已有 ${list.length - todo.length}・這次抓 ${Math.min(todo.length, LIMIT)}`
    + `(上限 ${LIMIT})・縮到寬 ${WIDTH}px`);
  if (noUrl) console.log(`  (另有 ${noUrl} 個對手上游沒給隊徽網址,不抓也不編)`);

  let got = 0; const failed = [];
  for (const t of todo.slice(0, LIMIT)) {
    if (got) await sleep(DELAY);
    try {
      const res = await fetch(t.url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { failed.push(`${t.name} HTTP ${res.status}`); store.failed[t.id] = `HTTP ${res.status}`; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      // 只收 PNG。decodePNG 讀不了的格式(webp/svg)不硬轉,寧可沒有也不要壞圖
      if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
        failed.push(`${t.name} 不是 PNG`); store.failed[t.id] = 'not-png'; continue;
      }
      const small = encodePNG(resizeRGBA(decodePNG(buf), WIDTH));
      store.crests[t.id] = `data:image/png;base64,${small.toString('base64')}`;
      store.sources[t.id] = { name: t.name, url: t.url };
      delete store.failed[t.id];
      got++;
    } catch (e) { failed.push(`${t.name} ${e.message}`); store.failed[t.id] = e.message; }
  }

  store._note = '盃賽對手的隊徽,key 是 SportMonks 的 team id(不是本站隊碼)。'
    + '本站有隊碼的球隊走 crests.json,不放這裡。來源:SportMonks image_path。';
  store.retrievedAt = new Date().toISOString();
  store.width = WIDTH;
  await writeFile(OUT, JSON.stringify(store, null, 0) + '\n');

  const bytes = Object.values(store.crests).reduce((a, v) => a + v.length, 0);
  console.log(`✔ 這次新增 ${got} 張・累計 ${Object.keys(store.crests).length} 張`
    + `(約 ${(bytes / 1024).toFixed(0)} KB)→ ${OUT}`);
  if (failed.length) console.log(`  ✗ 失敗 ${failed.length}:${failed.slice(0, 8).join('、')}`);
  const left = todo.length - got;
  if (left > 0) console.log(`  還有 ${left} 隊沒抓(下次執行會接著抓)`);
}

main().catch(e => { console.error('盃賽隊徽抓取失敗:', e.message); process.exitCode = 1; });
