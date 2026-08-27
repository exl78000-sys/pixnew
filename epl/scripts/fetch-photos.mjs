#!/usr/bin/env node
// 補抓球員頭貼。只處理 photos.json 的缺圖，單線節流並定期存檔，
// 避免對英超 CDN 造成瞬間大量請求，也避免中斷後重複下載。
//
// 用法:
//   npm run photos                         # 預設最多補 25 人
//   npm run photos -- --limit=100          # 放大單次批次
//   npm run photos -- --delay=1500         # 每次請求至少間隔 1.5 秒
//   npm run photos -- --probe=448104       # 只測一位，不寫入 photos.json
//   npm run photos -- --probe=448104 --template='https://.../{code}.png'
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playerPhotos } from './lib/adapters/fotmob-manual.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'data', 'manual', 'photo-manifest.json');
const OUT = join(ROOT, 'data', 'manual', 'photos.json');
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.split('=').slice(1).join('=');
const TEMPLATE = arg('template') || 'https://resources.premierleague.com/premierleague25/photos/players/110x140/{code}.png';
const LIMIT = Math.max(1, Number(arg('limit') || 25));
const DELAY_MS = Math.max(1000, Number(arg('delay') || 1200));
const PROBE = arg('probe') || null;
const RETRY_FAILED = process.argv.includes('--retry-failed');
/* 開發沙箱連不到外網,任何請求都回 403。在沙箱裡跑一次就會把那個 403
   寫進 _photoAttempts,之後在真的有網路的 runner 上重跑會直接跳過那個人 ——
   一個假的失敗紀錄能永久蓋掉一張拿得到的圖。要在沙箱驗流程就加 --dry-run。 */
const DRY_RUN = process.argv.includes('--dry-run');
const CHECKPOINT_EVERY = 5;
const MAX_BLOCK_STREAK = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/* 預設走英超 CDN 的樣板網址。但有些人在那個 CDN 上就是沒有圖
   (試過三次 404,_photoAttempts 記著),而別的來源查得到明確的圖片網址。
   那種情況允許 manifest 帶一個 photoUrl 直接指定 ——
   一個人一個網址、走同一條節流與去重路徑,不另外開一套抓圖流程。 */
const urlFor = (code, override = null) => override ?? TEMPLATE.replace('{code}', code);
const sha = buf => createHash('sha256').update(buf).digest('hex');

const PYTHON = String.raw`
import io, sys
from PIL import Image

raw = sys.stdin.buffer.read()
im = Image.open(io.BytesIO(raw)).convert('RGBA')
if im.width < 20 or im.height < 20:
    raise ValueError(f'image too small: {im.width}x{im.height}')
h = max(1, round(im.height * 96 / im.width))
im = im.resize((96, h), Image.Resampling.LANCZOS)
bg = Image.new('RGB', im.size, '#1a1420')
bg.paste(im, mask=im.getchannel('A'))

def encode(quality):
    out = io.BytesIO()
    bg.save(out, 'JPEG', quality=quality, optimize=True)
    return out.getvalue()

result = encode(78)
if len(result) > 3072:
    result = encode(70)
sys.stdout.buffer.write(result)
`;

function toJpeg(png) {
  const run = spawnSync('python3', ['-c', PYTHON], {
    input: png,
    encoding: null,
    maxBuffer: 5 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Pillow 處理失敗: ${run.stderr.toString().trim()}`);
  const out = Buffer.from(run.stdout);
  if (!out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) throw new Error('輸出不是 JPEG');
  return out;
}

async function request(code, override = null) {
  const url = urlFor(code, override);
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'image/png,image/*;q=0.8',
          'user-agent': 'pixnew-photo-cache/1.0',
        },
      });
      if (res.ok) {
        const type = res.headers.get('content-type') || '';
        const buf = Buffer.from(await res.arrayBuffer());
        if (!type.startsWith('image/') || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
          throw new Error(`回應不是 PNG (${type || '無 content-type'})`);
        }
        return { ok: true, status: res.status, url, buf };
      }

      last = { ok: false, status: res.status, url };
      // 403/404 不立刻重試；輸錯路徑或封鎖時重試只會增加壓力。
      if (res.status === 403 || res.status === 404) return last;
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retry) ? retry * 1000 : 5000 * (attempt + 1));
      } else if (res.status >= 500) {
        await sleep(2000 * 2 ** attempt);
      } else return last;
    } catch (err) {
      last = { ok: false, status: 'network', url, error: err.message };
      if (attempt < 2) await sleep(2000 * 2 ** attempt);
    }
  }
  return last;
}

function jpegHashes(photos) {
  const hashes = new Set();
  for (const uri of Object.values(photos)) {
    const comma = uri.indexOf(',');
    if (comma !== -1) hashes.add(sha(Buffer.from(uri.slice(comma + 1), 'base64')));
  }
  return hashes;
}

async function save(store, manifest, batch) {
  if (DRY_RUN) { console.log('  (--dry-run:不寫入 photos.json)'); return; }
  const codes = new Set(Object.keys(store.photos));
  store._count = codes.size;
  store._missing = manifest.players.map(p => p.code).filter(code => !codes.has(code));
  store._updated = new Date().toISOString().slice(0, 10);
  store._sources = [...(store._sources ?? []), batch];
  const tmp = `${OUT}.tmp`;
  await writeFile(tmp, JSON.stringify(store));
  await rename(tmp, OUT);
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  /* 人工交付的頭貼網址併進 manifest(不改 manifest 檔本身 —— 那是產物)。
     交付檔給的是「隊碼 + 我方顯示名」,所以同隊同名超過一位就不採用:
     把 A 的臉掛到 B 身上,比留一個隊徽佔位更糟。 */
  {
    const manual = playerPhotos(ROOT);
    let linked = 0;
    const ambiguous = [];
    for (const [key, row] of manual?.hit ?? []) {
      const [team, query] = key.split('|');
      const cand = manifest.players.filter(p => p.team === team && p.name === query);
      if (cand.length !== 1) { ambiguous.push(`${team}:${query}(${cand.length} 位同名)`); continue; }
      cand[0].photoUrl = row.photoUrl;
      linked++;
    }
    if (linked || ambiguous.length) {
      console.log(`  人工交付頭貼網址:${linked} 人可用`
        + (ambiguous.length ? `,${ambiguous.length} 人對不到唯一球員(${ambiguous.join('、')})` : ''));
    }
  }
  const store = JSON.parse(await readFile(OUT, 'utf8'));
  store.photos ??= {};
  store._failReasons ??= {};
  store._photoAttempts ??= {};

  if (PROBE) {
    const player = manifest.players.find(p => p.code === PROBE);
    if (!player) throw new Error(`manifest 沒有 ${PROBE}`);
    console.log(`▶ 測試 ${player.fullName} (${player.code})`);
    const result = await request(player.code);
    if (!result.ok) throw new Error(`HTTP ${result.status}${result.error ? `: ${result.error}` : ''}`);
    const jpeg = toJpeg(result.buf);
    console.log(`✔ ${result.url}`);
    console.log(`  PNG ${(result.buf.length / 1024).toFixed(1)} KB → JPEG ${(jpeg.length / 1024).toFixed(1)} KB`);
    return;
  }

  const missing = manifest.players.filter(p => {
    if (store.photos[p.code]) return false;
    return RETRY_FAILED || !store._photoAttempts[p.code]?.[p.photoUrl ?? TEMPLATE];
  }).slice(0, LIMIT);
  if (!missing.length) {
    const totalMissing = manifest.players.filter(p => !store.photos[p.code]).length;
    console.log(totalMissing
      ? `✔ 這個 CDN 規則已全部試過；仍有 ${totalMissing} 人沒有官方圖`
      : '✔ manifest 內的球員已全部有圖');
    return;
  }

  const hashes = jpegHashes(store.photos);
  const batch = {
    batch: (store._sources?.length ?? 0) + 1,
    url: TEMPLATE,
    width: 96,
    quality: 78,
    attempted: 0,
    got: 0,
    delayMs: DELAY_MS,
  };
  let blocked = 0;
  let dirty = 0;
  console.log(`▶ 補抓最多 ${missing.length} 人・單線・間隔至少 ${DELAY_MS}ms`);
  console.log(`  已有 ${Object.keys(store.photos).length}・待補 ${manifest.players.length - Object.keys(store.photos).length}\n`);

  for (const [index, player] of missing.entries()) {
    process.stdout.write(`  ${String(index + 1).padStart(3)}/${missing.length} ${player.team} ${player.fullName} … `);
    const result = await request(player.code, player.photoUrl ?? null);
    batch.attempted++;

    if (!result.ok) {
      store._failReasons[player.code] = result.status;
      store._photoAttempts[player.code] ??= {};
      // 鍵用「這次實際打的網址規則」。指定網址失敗記在樣板名下的話,
      // 之後換樣板重跑會誤以為樣板試過了而跳過這個人。
      store._photoAttempts[player.code][player.photoUrl ?? TEMPLATE] = result.status;
      console.log(`HTTP ${result.status}`);
      blocked = result.status === 403 || result.status === 429 ? blocked + 1 : 0;
      if (blocked >= MAX_BLOCK_STREAK) {
        // S3/CloudFront 對不存在的物件也可能回 403。用已知存在的 Saka
        // 當健康檢查，不把三個真正缺圖誤判為整體封鎖。
        console.log('\n      連續 3 個 403，等待 5 秒後檢查 CDN 健康狀態 …');
        await sleep(5000);
        const health = await request('223340');
        if (!health.ok) {
          console.log(`⚠ 已知存在的 Saka 頭貼也回 HTTP ${health.status}，自動停止以保護 CDN。`);
          break;
        }
        console.log('      CDN 正常，這三人應是尚無圖，繼續下一位。');
        blocked = 0;
      }
    } else {
      const jpeg = toJpeg(result.buf);
      const digest = sha(jpeg);
      if (hashes.has(digest)) {
        store._failReasons[player.code] = 'duplicate';
        console.log('重複圖，略過');
      } else {
        hashes.add(digest);
        store.photos[player.code] = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
        delete store._failReasons[player.code];
        delete store._photoAttempts[player.code];
        batch.got++;
        dirty++;
        blocked = 0;
        console.log(`✔ ${(jpeg.length / 1024).toFixed(1)} KB`);
      }
    }

    if (dirty >= CHECKPOINT_EVERY) {
      await save(store, manifest, batch);
      // save() 會把當前 batch 寫入 sources，後續 checkpoint 先拿掉再更新。
      store._sources.pop();
      dirty = 0;
    }
    if (index < missing.length - 1) await sleep(DELAY_MS + Math.floor(Math.random() * 250));
  }

  await save(store, manifest, batch);
  const size = (Buffer.byteLength(JSON.stringify(store)) / 1024 / 1024).toFixed(2);
  console.log(`\n✔ 本批新增 ${batch.got}/${batch.attempted}`);
  console.log(`  總計 ${store._count}/${manifest.players.length}・仍缺 ${store._missing.length}・photos.json ${size} MB`);
}

main().catch(err => {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
});
