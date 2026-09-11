#!/usr/bin/env node
/* 全站掃描(2026-09-11):把 web/ 底下每一頁 × 三個聯賽 × 兩個寬度都用瀏覽器開一遍。
 *
 * 為什麼要有這一支:`npm test` 看不到版面。這個專案踩過的坑有一整類是
 * 「不拋錯、只是畫面上印垃圾」—— `[object Object]`、`**強調**`、`undefined`、
 * 手機寬度橫向溢位、破圖框。它們全部只有「真的開來看」才抓得到,而人不會每次
 * 都把 57 個目標開兩種寬度。這一支做的就是那件事,只印有異狀的。
 *
 * 頁面清單**從 web/*.html 掃出來**,不另外維護一份(「頁面清單有三份」那條坑)。
 * 深連結(單場分析、球隊頁、球員頁)的樣本 id 從資料檔取第一筆,不寫死。
 *
 * ── 讀結果時要知道的兩件事(不然會追錯 bug)──
 * 1. 沙箱連不到外網:西甲頭貼(SportMonks CDN)、教練照(Wikimedia)在這裡一定載不到,
 *    症狀是 console 的 `ERR_TUNNEL_CONNECTION_FAILED`。正式站不會。這裡把它們
 *    分開計成「外部資源」,不混進 pageerror。
 * 2. `loading="lazy"` 的圖在首屏外**不會開始載入**,但 `complete` 是 true、
 *    `naturalWidth` 是 0 —— 看起來跟破圖一模一樣。所以破圖只數**在視窗內**的。
 *    第一版沒分,allplayers 報了 37 張「破圖」,其中 32 張只是還沒捲到。
 *
 * 用法:另開一個終端跑 `npm run serve`(port 5173),再 `npm run sweep`。
 *   --base=http://127.0.0.1:5173   --out=/tmp/sweep.json   --only=players
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const BASE = arg('base') ?? 'http://127.0.0.1:5173';
const ONLY = arg('only') ?? null;
const OUT = arg('out') ?? null;

// Playwright 在 runner 與沙箱都是全域裝的;不進 package.json(零依賴那條)
const PW = ['/opt/node22/lib/node_modules/playwright/index.mjs', 'playwright'];
let chromium = null;
for (const p of PW) { try { ({ chromium } = await import(p)); break; } catch { /* 試下一個 */ } }
if (!chromium) { console.log('✗ 找不到 playwright(沙箱在 /opt/node22 底下;本機 npm i -g playwright)'); process.exit(0); }

const LEAGUES = { pl: '', es1: 'league=es1', en2: 'league=en2' };
const url = (page, lg, extra = '') => {
  const q = [LEAGUES[lg], extra].filter(Boolean).join('&');
  return `${BASE}/${page}.html${q ? '?' + q : ''}`;
};
const pages = readdirSync(WEB).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''));
// 跨聯賽那幾頁只在 pl 開一次就夠(內容跟聯賽無關);其餘每個聯賽都開
const SITE = new Set(['overview', 'knowledge', 'allplayers', 'explore', 'cups', 'ucl']);

/* 深連結樣本:從資料檔取,不寫死。拿不到就跳過那一種(英冠沒有球員)。 */
function samples(lg) {
  const dir = lg === 'pl' ? join(WEB, 'data') : join(WEB, 'data', 'leagues', lg);
  const read = f => { const p = join(dir, f); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
  const fx = read('fixtures.json'); const list = Array.isArray(fx) ? fx : (fx?.fixtures ?? []);
  const teams = read('teams.json'); const tl = teams?.teams ?? teams ?? [];
  const players = read('players.json'); const pl = players?.players ?? [];
  const out = [];
  const done = list.find(m => m.played), up = list.find(m => !m.played && m.kickoff);
  if (done) out.push(['analysis', `id=${done.id}`]);
  if (up) out.push(['analysis', `id=${up.id}`]);
  if (tl[0]?.code) out.push(['teams', `code=${tl[0].code}`]);
  if (pl[0]?.code) out.push(['players', `code=${pl[0].code}`]);
  return out;
}

const targets = [];
for (const lg of Object.keys(LEAGUES)) {
  for (const p of pages) if (!SITE.has(p)) targets.push({ lg, page: p, url: url(p, lg) });
  for (const [p, q] of samples(lg)) targets.push({ lg, page: `${p}?${q}`, url: url(p, lg, q) });
}
for (const p of pages) if (SITE.has(p)) targets.push({ lg: 'pl', page: p, url: url(p, 'pl') });
for (const c of ['ucl', 'facup', 'eflcup']) targets.push({ lg: 'pl', page: `cups?cup=${c}`, url: url('cups', 'pl', `cup=${c}`) });
// 從別的聯賽進跨聯賽頁(link() 繼承聯賽那條坑)
for (const lg of ['es1', 'en2']) for (const p of ['overview', 'cups']) targets.push({ lg, page: p, url: url(p, lg) });
const picked = ONLY ? targets.filter(t => t.page.includes(ONLY)) : targets;

/* 會進畫面的垃圾。`null` 只在單獨成詞時算(中文文案裡不會自然出現這個詞)。 */
const BAD = [[/\bundefined\b/, 'undefined'], [/\bNaN\b/, 'NaN'], [/\[object \w+\]/, '[object]'],
  [/\*\*[^*\n]{1,80}\*\*/, '**強調**'], [/\$\{/, '${'], [/Invalid Date/, 'Invalid Date'], [/載入失敗/, '載入失敗'], [/\bnull\b/, 'null']];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const results = [];
for (const t of picked) for (const w of [1200, 400]) {
  const page = await browser.newPage({ viewport: { width: w, height: 900 } });
  const errs = [], external = [], fails = [];
  page.on('pageerror', e => errs.push(e.message.slice(0, 160)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const txt = m.text();
    (/ERR_TUNNEL|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/.test(txt) ? external : errs).push(txt.slice(0, 160));
  });
  page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(BASE)) fails.push(`${r.status()} ${r.url().replace(BASE, '')}`); });
  let nav = 'ok';
  try { await page.goto(t.url, { waitUntil: 'networkidle', timeout: 30000 }); } catch { nav = 'timeout'; }
  await page.waitForTimeout(w === 1200 ? 1200 : 600);
  const r = await page.evaluate(() => {
    const text = document.body.innerText ?? '';
    const vh = innerHeight;
    return {
      text, appLen: (document.getElementById('app')?.innerText ?? '').trim().length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        ? `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}` : '',
      // 只數視窗內的破圖(lazy 的在首屏外根本還沒載)
      broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0 && i.offsetParent !== null
        && (() => { const b = i.getBoundingClientRect(); return b.top >= 0 && b.top < vh; })()).length,
    };
  });
  results.push({ lg: t.lg, page: t.page, w, nav, errs, fails, external: external.length, badText: BAD.filter(([re]) => re.test(r.text)).map(([, n]) => n), appLen: r.appLen, overflow: r.overflow, broken: r.broken });
  await page.close();
}
await browser.close();
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));

const bad = results.filter(r => r.nav !== 'ok' || r.errs.length || r.fails.length || r.badText.length || r.overflow || r.appLen < 120 || r.broken);
console.log(`掃了 ${picked.length} 個目標 × 2 寬度 = ${results.length} 次載入;有異狀 ${bad.length} 次`
  + `(外部資源載不到 ${results.filter(r => r.external).length} 次 —— 沙箱擋外網,正式站不會)\n`);
for (const r of bad) {
  const tags = [];
  if (r.nav !== 'ok') tags.push(`導航:${r.nav}`);
  if (r.errs.length) tags.push(`錯誤×${r.errs.length}`);
  if (r.fails.length) tags.push(`本站 HTTP 失敗×${r.fails.length}`);
  if (r.badText.length) tags.push(`文字:${r.badText.join('/')}`);
  if (r.overflow) tags.push(`橫向溢位 ${r.overflow}`);
  if (r.appLen < 120) tags.push(`#app 幾乎空的(${r.appLen} 字)`);
  if (r.broken) tags.push(`視窗內破圖×${r.broken}`);
  console.log(`[${r.lg}] ${r.page} @${r.w}  →  ${tags.join('、')}`);
  for (const e of r.errs.slice(0, 2)) console.log(`      ✗ ${e}`);
  for (const e of r.fails.slice(0, 3)) console.log(`      ↳ ${e}`);
}
if (!bad.length) console.log('全部乾淨。');
