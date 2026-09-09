#!/usr/bin/env node
/* 探測:退訂 SportMonks 之後,球員檔裡那些頭貼網址還供不供圖?
 *
 * 為什麼要問這個:西甲球員檔的 photo 是 `https://cdn.sportmonks.com/...` 這種**遠端網址**
 * (英超是內嵌 base64,不受影響)。API 訂閱 2026-09-03 取消了 —— 而「API 停了」跟
 * 「圖片 CDN 停了」是兩件事,不能憑印象斷言。沙箱連不到外網,所以寫成探測跑在 runner 上。
 *
 * 只發 HEAD、只抓 12 個,而且是**零額外授權**:這些網址本來就印在已經部署的西甲球員頁上。
 *
 *   node scripts/probe-photo-cdn.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = 12;

const load = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const es = load(join(ROOT, 'web', 'data', 'leagues', 'es1', 'players.json'));
const list = (es?.players ?? es ?? []).filter(p => typeof p?.photo === 'string' && p.photo.startsWith('http'));

if (!list.length) { console.log('西甲球員檔沒有遠端頭貼網址,不用探測。'); process.exit(0); }

const hosts = new Map();
for (const p of list) { const h = new URL(p.photo).host; hosts.set(h, (hosts.get(h) ?? 0) + 1); }
console.log(`西甲有遠端頭貼網址的球員:${list.length} 人`);
for (const [h, n] of hosts) console.log(`  主機 ${h}:${n} 筆`);

// 均勻取樣,不要只抓前 12 個(同一隊、同一批上傳,結果會有偏差)
const step = Math.max(1, Math.floor(list.length / N));
const sample = Array.from({ length: N }, (_, i) => list[i * step]).filter(Boolean);

let ok = 0, bad = 0;
for (const p of sample) {
  try {
    const res = await fetch(p.photo, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    const type = res.headers.get('content-type') ?? '';
    const len = res.headers.get('content-length') ?? '?';
    const good = res.ok && /^image\//.test(type);
    if (good) ok++; else bad++;
    console.log(`  ${good ? '✔' : '✗'} ${String(p.name).padEnd(24)} HTTP ${res.status} ${type} ${len} bytes`);
  } catch (e) {
    bad++;
    console.log(`  ✗ ${String(p.name).padEnd(24)} ${e.message}`);
  }
}
console.log(`\n結果:${ok} / ${sample.length} 張還取得到圖。`);
console.log(ok === 0
  ? '→ CDN 已經不供圖:西甲的頭貼要換來源(頁面會自動退回名字,不會出現破圖框)。'
  : ok === sample.length
    ? '→ CDN 仍然供圖:退訂的是 API,靜態圖片不受影響。'
    : '→ 部分取不到:那是個別球員的圖被下架,不是整個 CDN 停掉。');
