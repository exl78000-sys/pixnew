#!/usr/bin/env node
/* 歐冠球員榜的頭貼。**一個球員一個請求**,所以只抓「本季榜上真的會出現的人」。
 *
 * 為什麼是這條路(2026-09-21,探測 run #40 的結論):
 * 本站每次部署本來就在打的 `matchDetails` 回應裡**沒有**球員照片 —— 先發球員物件
 * 15 個鍵一個圖片欄位都沒有,整份 323 KB 走訪下來「值長得像圖片網址」的 34 種路徑
 * **0 種**落在 player / person / face / squad / lineup 底下(全是隊徽、裁判的國旗,
 * 加上 `matchFacts.postReview[].image` 那 7 筆 —— 7 筆是同一張新聞縮圖,不是頭貼)。
 * 所以不是本站的轉換器把它丟掉了,是那支端點沒給;零額外請求那條路不存在。
 * 而 `images.fotmob.com/image_resources/playerimages/{id}.png` 實測可用
 * (HTTP 200、image/png、14.0 KB、PNG 魔數正確)—— 隊徽與聯賽 logo 是同一套形式。
 *
 * 抓取禮貌(CLAUDE.md 第四節):一人一個請求是使用者**明確點頭**才做的
 * (2026-09-21 選「只抓本季(40 人)」)。所以這一支:
 *   - 只收**本季**榜上的 `pid`(往季的榜走交付檔那一路、沒有 pid,也不在這次的範圍裡);
 *   - 已經有圖的**不重抓**(第一次 40 個請求,之後每輪只補榜上新出現的人);
 *   - 單線、每次請求之間至少 `--delay` 毫秒;
 *   - `--limit` 是硬上限,超過就留到下一輪。
 *
 * **它讀的是倉庫裡那份 `web/data/ucl.json`,也就是上一次部署建出來的榜。**
 * 工作流裡這一步排在 build 之前(它要 Pillow,而 Pillow 跟英超頭貼那幾步裝在一起),
 * 所以**今天才擠進榜的人,他的臉要下一次部署才會出現** —— 一次部署的延遲。
 * 不改成「build → 抓 → 再 build」是因為那要跑兩次建站,換到的只是少一次部署的延遲;
 * 榜本來就是每天動幾個人。但那是真的延遲,不寫下來的話下一個人會把它當成 bug 去追。
 *
 * 用法:
 *   npm run ucl:photos                  # 補本季榜上缺的,最多 50 人
 *   npm run ucl:photos -- --limit=10    # 這一輪只補 10 個
 *   npm run ucl:photos -- --dry-run     # 不寫檔(沙箱驗流程用)
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pillowReady, toJpeg } from './lib/photo-jpeg.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'manual', 'ucl-photos.json');
const UCL = join(ROOT, 'web', 'data', 'ucl.json');
const TEMPLATE = 'https://images.fotmob.com/image_resources/playerimages/{id}.png';

const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
/* 50 而不是 25(英超那一支的預設):本季的榜就是 40 個不重複球員,一輪跑不完的話
   畫面上會有一半的人有臉、一半沒有,而那比全部沒有更像壞掉。40 × 1.2 秒 ≈ 48 秒。 */
const LIMIT = Math.max(1, Number(arg('limit') || 50));
const DELAY_MS = Math.max(1000, Number(arg('delay') || 1200));
/* 沙箱連不到外網,任何請求都回 403。在沙箱跑一次就把那個 403 寫進 attempts 的話,
   之後在真的有網路的 runner 上重跑會直接跳過那個人 —— 一個假的失敗紀錄
   能永久蓋掉一張拿得到的圖(英超那一支踩過,註解就在它的檔頭)。 */
const DRY_RUN = process.argv.includes('--dry-run');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => createHash('sha256').update(buf).digest('hex');

/* 榜上的 pid 是**上游的球員 id**,而隊伍那一欄的 teamId 是 football-data 的 ——
   兩個不同的空間,不要互相套用(那正是 2026-09-21 上午修掉的那個坑)。 */
async function wantedIds() {
  if (!existsSync(UCL)) return { ids: [], why: '沒有 web/data/ucl.json(先跑 npm run build)' };
  const ucl = JSON.parse(await readFile(UCL, 'utf8'));
  const cur = (ucl.seasons ?? []).find(s => s.current);
  if (!cur) return { ids: [], why: 'ucl.json 裡沒有標成 current 的賽季' };
  const ids = new Map();   // id → 這個人在榜上叫什麼(只拿來印 log)
  for (const b of cur.leaders ?? []) for (const r of b.rows ?? []) if (r.pid != null) ids.set(String(r.pid), r.name);
  return { ids: [...ids.entries()], season: cur.label };
}

async function loadStore() {
  if (!existsSync(STORE)) {
    return { _note: '歐冠球員榜的頭貼(自動產生,請勿手改)。一個球員一個請求,只抓本季榜上的人。',
      _license: '頭貼版權屬各攝影授權方,此處僅作為分析工具的識別用途。',
      _source: TEMPLATE, _format: 'jpeg', _updated: null, _count: 0, photos: {}, _attempts: {} };
  }
  const s = JSON.parse(await readFile(STORE, 'utf8'));
  s.photos ??= {}; s._attempts ??= {};
  return s;
}

async function request(id) {
  const url = TEMPLATE.replace('{id}', id);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'pl-war-room/1.0 (football analysis side project)' } });
    if (!res.ok) return { ok: false, status: res.status, why: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    /* 有些 CDN 對不存在的 id 回 200 加一張佔位圖或一段 HTML ——
       只看 res.ok 會把那個存成一張「頭貼」。魔數是最便宜的判準。 */
    if (!(buf[0] === 0x89 && buf[1] === 0x50)) return { ok: false, status: res.status, why: '回的不是 PNG' };
    return { ok: true, buf };
  } catch (e) { return { ok: false, status: 0, why: e.message }; }
}

async function main() {
  const { ids, why, season } = await wantedIds();
  if (why) { console.log(`✗ ${why}`); return; }
  const store = await loadStore();
  const have = new Set(Object.keys(store.photos));
  /* 失敗過三次的先不再試(上游就是沒有這個人的圖)。狀態 0 是連線層的失敗
     (沙箱的 403 也落在這裡),那種**不計次** —— 詳見上面 DRY_RUN 那段註解。 */
  const burnt = new Set(Object.entries(store._attempts).filter(([, a]) => (a.hard ?? 0) >= 3).map(([k]) => k));
  const todo = ids.filter(([id]) => !have.has(id) && !burnt.has(id));

  console.log(`▶ 歐冠球員頭貼(${season}):榜上 ${ids.length} 人・已有 ${ids.filter(([id]) => have.has(id)).length}`
    + `・試過三次拿不到 ${ids.filter(([id]) => burnt.has(id)).length}・這一輪要補 ${Math.min(todo.length, LIMIT)}/${todo.length}`);
  if (!todo.length) { console.log('✔ 沒有要補的'); return; }

  const ready = pillowReady();
  if (!ready.ok) {
    console.log(`✔ 略過補抓頭貼:${ready.why}`);
    console.log('  這不是錯誤 —— 既有的頭貼照常使用,只是這次不補新的。');
    return;
  }

  let added = 0, failed = 0;
  for (const [id, name] of todo.slice(0, LIMIT)) {
    if (added || failed) await sleep(DELAY_MS);
    const r = await request(id);
    if (!r.ok) {
      failed++;
      console.log(`  ✗ ${name}(${id}):${r.why}`);
      if (!DRY_RUN && r.status >= 400) {
        const a = store._attempts[id] ??= { hard: 0 };
        a.hard++; a.last = r.why; a.at = new Date().toISOString().slice(0, 10);
      }
      continue;
    }
    const jpeg = toJpeg(r.buf);
    console.log(`  ✔ ${name}(${id}):PNG ${(r.buf.length / 1024).toFixed(1)} KB → JPEG ${(jpeg.length / 1024).toFixed(1)} KB  ${sha(jpeg).slice(0, 8)}`);
    if (!DRY_RUN) { store.photos[id] = `data:image/jpeg;base64,${jpeg.toString('base64')}`; delete store._attempts[id]; }
    added++;
  }

  if (DRY_RUN) { console.log(`\n(dry-run,沒有寫檔)新增 ${added}、失敗 ${failed}`); return; }
  store._updated = new Date().toISOString().slice(0, 10);
  store._count = Object.keys(store.photos).length;
  /* 鍵排序固定,重跑才不會因為插入順序而產生假的 diff(逐場檔那條規矩的同一個理由) */
  store.photos = Object.fromEntries(Object.keys(store.photos).sort((a, b) => Number(a) - Number(b)).map(k => [k, store.photos[k]]));
  await writeFile(STORE, `${JSON.stringify(store, null, 2)}\n`);
  const bytes = Buffer.byteLength(JSON.stringify(store.photos));
  console.log(`\n✔ 新增 ${added}、失敗 ${failed};store 共 ${store._count} 張、${(bytes / 1024).toFixed(0)} KB`);
}

main().catch(e => { console.error('抓取失敗:', e.message); process.exitCode = 1; });
