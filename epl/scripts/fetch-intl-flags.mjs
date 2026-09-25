#!/usr/bin/env node
/* 國家隊的國旗 → data/manual/intl-flags.json(2026-09-25,使用者選「開源國旗集」)
 *
 *   npm run intl:flags              只抓還沒有的
 *   npm run intl:flags -- --force   全部重抓
 *
 * ── 來源 ──
 * lipis/flag-icons(MIT,授權檔確認過)的 4x3 SVG,走 raw.githubusercontent.com —— 靜態檔,沙箱放行,
 * 跟義甲法甲的隊徽同一條路。一個國碼一個檔,抓過的不重抓(sha256 記著)。
 *
 * ── 為什麼要轉成小張 PNG ──
 * 國徽旗的 SVG 一面就 80 KB 以上(西班牙 81 KB、墨西哥 85 KB,完整向量的國徽),顯示出來只有 20×15。
 * 用 Chromium(Playwright,沙箱有;跟 sweep-pages 同一套,不是本站的依賴)把 SVG 畫成四倍大,
 * 再用本站自己的 lib/png.mjs 盒式縮到 40×30(顯示 20×15 的兩倍,高解析螢幕也清楚)、編成 PNG 內嵌。
 * **沒有 Playwright 就停**,一個字都不寫 —— 部署那一支不跑這一步(國旗不會變,本機抓一次提交)。
 *
 * ── 哪些隊、哪個碼 ──
 * 隊:產物字典裡的每一隊,加上 martj42 兩年內踢過的每一隊(新隊出現在賽程之前就先備好)。
 * 碼:身分表的 `flag` 覆寫(英格蘭四隊、巴斯克是國旗集的非 ISO 碼;中華台北刻意不給)→ isoOf 的小寫
 * (跟中文名同一份代碼;isoOf 已經排除 DD、CS 這種廢止的舊碼)。國旗集沒有這個碼的,那一隊沒有國旗。
 *
 * **同一面旗兩個碼**(屬地在國旗集裡用的是宗主國的旗)不在這裡判 —— 這裡只存圖與 sha256,
 * 建置(build-intl)看到兩隊同一面旗,就把非會員那一邊拿掉:瓜德羅普的球隊掛法國國旗,比不掛更糟。
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseIntlResults } from './lib/intl.mjs';
import { loadIntlTeamTable, makeIntlResolver } from './lib/intl-teams.mjs';
import { resizeRGBA, encodePNG } from './lib/png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'manual', 'intl-flags.json');
const REPO = 'https://raw.githubusercontent.com/lipis/flag-icons/main';
export const FLAG_W = 40, FLAG_H = 30;
const SUPER = 4;             // 先畫四倍大再盒式縮:國徽那些細線在 20×15 才不會變成鋸齒
const GAP = 120;
const ACTIVE_DAYS = 730;
const force = process.argv.includes('--force');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function main() {
  const PW = ['/opt/node22/lib/node_modules/playwright/index.mjs', 'playwright'];
  let chromium = null;
  for (const p of PW) { try { ({ chromium } = await import(p)); break; } catch { /* 試下一個 */ } }
  if (!chromium) { console.log('✗ 找不到 playwright —— 國旗要用 Chromium 把 SVG 畫成小圖;沒有就不動任何檔(沙箱在 /opt/node22 底下有)'); process.exitCode = 1; return; }

  // 要哪些隊
  const mj = parseIntlResults(readFileSync(join(ROOT, 'data', 'raw', 'intl', 'results.csv'), 'utf8'));
  const table = loadIntlTeamTable(ROOT);
  const R = makeIntlResolver(table, new Set(mj.flatMap(m => [m.home, m.away])));
  const lastDate = mj.at(-1).date;
  const cutoff = new Date(Date.parse(`${lastDate}T00:00:00Z`) - ACTIVE_DAYS * 86400000).toISOString().slice(0, 10);
  const keys = new Set(mj.filter(m => m.date >= cutoff).flatMap(m => [m.home, m.away]));
  const prod = join(ROOT, 'web', 'data', 'intl.json');
  if (existsSync(prod)) for (const k of Object.keys(JSON.parse(readFileSync(prod, 'utf8')).teams ?? {})) keys.add(k);

  // 國旗集有哪些碼(一個請求)、它自己的版本號(一個請求,記出處用)
  const country = JSON.parse(await get(`${REPO}/country.json`));
  const have = new Map(country.map(c => [c.code, c]));
  const version = JSON.parse(await get(`${REPO}/package.json`)).version ?? null;

  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const flags = { ...(prev && !force && prev.size?.[0] === FLAG_W && prev.size?.[1] === FLAG_H ? prev.flags : {}) };
  const want = new Set();
  const noCode = [], notInSet = [];
  for (const k of [...keys].sort()) {
    const code = R.flagCodeOf(k);
    if (!code) { noCode.push(k); continue; }
    if (!have.has(code)) { notInSet.push(`${k}(${code})`); continue; }
    want.add(code);
  }
  const todo = [...want].filter(c => !flags[c]);
  console.log(`▶ 國旗:${keys.size} 隊・要 ${want.size} 個碼(已有 ${want.size - todo.length}、要抓 ${todo.length})・國旗集 v${version}`);
  if (noCode.length) console.log(`  沒有國碼(不給國旗):${noCode.join('、')}`);
  if (notInSet.length) console.log(`  國旗集沒有這個碼:${notInSet.join('、')}`);

  if (todo.length) {
    const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    let n = 0;
    for (const code of todo) {
      if (n++) await sleep(GAP);
      const svg = await get(`${REPO}/flags/4x3/${code}.svg`);
      const w = FLAG_W * SUPER, h = FLAG_H * SUPER;
      // 在 Chromium 裡把 SVG 畫到四倍大的畫布上,拿回 RGBA —— 轉圖只用瀏覽器,縮圖與編碼用本站自己的 png.mjs
      const rgba = await page.evaluate(async ({ svg, w, h }) => {
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        const im = new Image();
        im.src = url;
        await im.decode();
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(im, 0, 0, w, h);
        URL.revokeObjectURL(url);
        return Array.from(ctx.getImageData(0, 0, w, h).data);
      }, { svg, w, h });
      const small = resizeRGBA({ width: w, height: h, data: Uint8Array.from(rgba) }, FLAG_W);
      const png = encodePNG(small);
      flags[code] = {
        sha256: createHash('sha256').update(svg).digest('hex'), svgBytes: Buffer.byteLength(svg),
        img: `data:image/png;base64,${png.toString('base64')}`,
      };
    }
    await browser.close();
  }

  // 只留還用得到的碼(隊伍換了,舊碼不留著佔地方)
  const kept = Object.fromEntries(Object.entries(flags).filter(([c]) => want.has(c)).sort(([a], [b]) => (a < b ? -1 : 1)));
  const out = {
    _note: '國家隊的國旗(npm run intl:flags 產生;不要手改)。來源 lipis/flag-icons 的 4x3 SVG,用 Chromium 畫成四倍大再縮成 40×30 的 PNG。'
      + '同一面旗兩個碼的(屬地用宗主國的旗)由建置判斷,不在這裡刪。',
    source: { name: 'lipis/flag-icons', url: 'https://github.com/lipis/flag-icons', license: 'MIT', version,
      retrievedAt: todo.length ? new Date().toISOString() : prev?.source?.retrievedAt ?? null },
    size: [FLAG_W, FLAG_H],
    flags: kept,
  };
  const tmp = `${OUT}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 1) + '\n');
  await rename(tmp, OUT);
  const bytes = Object.values(kept).reduce((a, f) => a + f.img.length, 0);
  console.log(`✔ data/manual/intl-flags.json:${Object.keys(kept).length} 面(這一輪抓 ${todo.length} 面、共 ${todo.length + 2} 個請求),內嵌 ${(bytes / 1024).toFixed(0)} KB`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
}
