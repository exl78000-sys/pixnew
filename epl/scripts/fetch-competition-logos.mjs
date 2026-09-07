#!/usr/bin/env node
/* 賽事 logo(英超/西甲/英冠/歐冠/足總盃/聯賽盃)→ data/manual/competition-logos.json
 *
 * 站上原本用色塊 + 縮寫當賽事圖像,使用者要真圖。沙箱連不到任何圖片 CDN,
 * 所以這支只在 runner 上跑(epl-live.yml 有一步)。SportMonks 已退訂,不能用。
 *
 * 兩個來源,每一筆都要**名字核對過**才存:
 *
 *   A. football-data.org v4  /competitions/{code} 的 `emblem`
 *      官方文件明寫 competition 有 emblem(例如 https://crests.football-data.org/PL.png)。
 *      免費層有 PL / PD(西甲)/ ELC(英冠)/ CL 四個;FA Cup 與聯賽盃不在裡面。
 *      本站的歐冠資料就是從這裡來的,token 已在 secrets。免費方案 10 req/分,所以每次請求隔 7 秒。
 *
 *   B. FotMob(探測)。站上已經在打它的聯賽端點(fetch-fotmob-scores.mjs,id 47/87/48 是在用的)。
 *      logo 網址 images.fotmob.com/image_resources/logo/leaguelogo/{id}.png 是**推測**,
 *      足總盃 132 / 聯賽盃 133 / 歐冠 42 也是 —— 所以兩道關卡:聯賽端點回傳的名字要對得上、
 *      圖抓回來要真的是 PNG。任一關過不了就跳過並印出來,不硬塞。
 *
 * 三條規矩:
 * 1. id / code 是查來的,不是驗過的 —— 回傳的名字核對過才存(id 錯了不會拋錯,只會存成別的賽事)。
 * 2. 不假設回傳一定有 logo 欄位;沒有就明講並跳過(CLAUDE.md:不要憑印象斷言 API 有什麼欄位)。
 * 3. 抓過就不再抓:30 天內不重抓(logo 一年換不到一次),--force 才重來。
 *
 *   npm run competition-logos
 *   npm run competition-logos -- --force --width=64
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, resizeRGBA, encodePNG } from './lib/png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'manual', 'competition-logos.json');
const FD_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FD_BASE = 'https://api.football-data.org/v4';
const FD_GAP = 7000;   // 免費方案 10 req/分,留餘裕(跟 fetch-ucl.mjs 同一個數字)
const FM_BASE = 'https://www.fotmob.com/api/data/leagues';
const FM_LOGO = id => `https://images.fotmob.com/image_resources/logo/leaguelogo/${id}.png`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const WIDTH = Number(arg('width') || 64);
const FORCE = process.argv.includes('--force');
const TTL_DAYS = 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 鍵跟前端 core.js 的 COMPETITIONS 一致。expect 是名字的核對,不是搜尋條件。 */
const COMPETITIONS = [
  { key: 'pl',     zh: '英超',   expect: /^premier league$/i,               fd: 'PL',  fm: 47 },
  { key: 'es1',    zh: '西甲',   expect: /primera divisi|la ?liga/i,        fd: 'PD',  fm: 87 },
  { key: 'en2',    zh: '英冠',   expect: /championship/i,                   fd: 'ELC', fm: 48 },
  { key: 'ucl',    zh: '歐冠',   expect: /champions league/i,               fd: 'CL',  fm: 42 },
  { key: 'facup',  zh: '足總盃', expect: /fa cup/i,                         fd: null,  fm: 132 },
  { key: 'eflcup', zh: '聯賽盃', expect: /carabao|league cup|efl cup/i,     fd: null,  fm: 133 },
];

const fresh = e => e?.retrievedAt && (Date.now() - Date.parse(e.retrievedAt)) < TTL_DAYS * 86400000;

async function getJson(url, headers) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { accept: 'application/json', ...headers } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} 回傳不是 JSON`); }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body?.message ?? body?.error ?? {}).slice(0, 160)}`);
  return body;
}

// 只收 PNG(跟隊徽同一條規矩):decodePNG 讀不了的格式不硬轉,寧可沒有也不要壞圖
async function fetchPng(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`圖片 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error(`不是 PNG(${res.headers.get('content-type')})`);
  return `data:image/png;base64,${encodePNG(resizeRGBA(decodePNG(buf), WIDTH)).toString('base64')}`;
}

/* 來源 A:football-data.org。code 對得上、名字對得上、有 emblem,三個都要。 */
let fdCalls = 0;
async function fromFootballData(c) {
  if (!c.fd) return { skip: '免費層沒有這個賽事' };
  if (!FD_TOKEN) return { skip: '未設定 FOOTBALL_DATA_TOKEN' };
  if (fdCalls) await sleep(FD_GAP);
  fdCalls++;
  const d = await getJson(`${FD_BASE}/competitions/${c.fd}`, { 'X-Auth-Token': FD_TOKEN });
  const name = String(d?.name ?? '');
  if (d?.code !== c.fd || !c.expect.test(name)) return { fail: `回傳 code=${d?.code} name=「${name}」,跟預期的 ${c.zh} 對不上` };
  if (!d.emblem) return { fail: `回傳裡沒有 emblem(欄位有:${Object.keys(d ?? {}).slice(0, 12).join(',')})` };
  await sleep(300);
  return { dataUri: await fetchPng(d.emblem), name, url: d.emblem, source: 'football-data.org', id: d.code };
}

/* 來源 B:FotMob(探測)。名字從聯賽端點核對,圖從推測的網址抓 —— 兩關都過才算。 */
let fmCalls = 0;
async function fromFotmob(c) {
  if (!c.fm) return { skip: '沒有 FotMob id' };
  if (fmCalls) await sleep(1500);
  fmCalls++;
  const body = await getJson(`${FM_BASE}?id=${c.fm}&ccode3=GBR`, { 'user-agent': UA, referer: 'https://www.fotmob.com/' });
  const name = String(body?.details?.name ?? body?.name ?? '');
  if (!name) return { fail: `聯賽端點回傳裡找不到名字(頂層鍵:${Object.keys(body ?? {}).slice(0, 10).join(',')})` };
  if (!c.expect.test(name)) return { fail: `id ${c.fm} 的名字是「${name}」,跟預期的 ${c.zh} 對不上` };
  await sleep(300);
  return { dataUri: await fetchPng(FM_LOGO(c.fm)), name, url: FM_LOGO(c.fm), source: 'FotMob', id: c.fm };
}

async function main() {
  const store = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : { logos: {}, failed: {} };
  store.logos ??= {}; store.failed ??= {};
  const todo = COMPETITIONS.filter(c => FORCE || !fresh(store.logos[c.key]));
  console.log(`▶ 賽事 logo:${COMPETITIONS.length} 個賽事・已有且新鮮 ${COMPETITIONS.length - todo.length}・這次抓 ${todo.length}(縮到寬 ${WIDTH}px)`);
  if (!FD_TOKEN) console.log('  ⚠ 未設定 FOOTBALL_DATA_TOKEN:來源 A 整個跳過,只試 FotMob');
  if (!todo.length) { console.log(`✓ 全部在 ${TTL_DAYS} 天內抓過,不發請求`); return; }

  let got = 0; const failed = [];
  for (const c of todo) {
    const notes = [];
    let hit = null;
    for (const [label, fn] of [['football-data', fromFootballData], ['FotMob', fromFotmob]]) {
      try {
        const r = await fn(c);
        if (r.dataUri) { hit = r; break; }
        notes.push(`${label}:${r.skip ?? r.fail}`);
      } catch (e) { notes.push(`${label}:${e.message}`); }
    }
    if (!hit) { failed.push(`${c.zh} — ${notes.join(' / ')}`); store.failed[c.key] = notes.join(' / '); continue; }
    store.logos[c.key] = { dataUri: hit.dataUri, name: hit.name, source: hit.source, sourceId: hit.id, url: hit.url,
      retrievedAt: new Date().toISOString() };
    delete store.failed[c.key];
    got++;
    console.log(`  ✓ ${c.zh}:${hit.name}(${hit.source} ${hit.id})${notes.length ? `  [前一個來源:${notes.join(' / ')}]` : ''}`);
  }

  store._note = '賽事 logo(鍵跟前端 COMPETITIONS 一致)。來源:football-data.org 的 competition emblem,'
    + '不在其免費層的(足總盃、聯賽盃)走 FotMob;每一筆的名字都核對過才存;30 天內不重抓。'
    + 'build 讀這裡產 web/data/competitions.json。';
  store.width = WIDTH;
  store.retrievedAt = new Date().toISOString();
  await writeFile(OUT, JSON.stringify(store, null, 0) + '\n');
  const bytes = Object.values(store.logos).reduce((a, v) => a + (v.dataUri?.length ?? 0), 0);
  console.log(`✔ 這次新增 ${got} 張・累計 ${Object.keys(store.logos).length}/${COMPETITIONS.length}(約 ${(bytes / 1024).toFixed(0)} KB)→ ${OUT}`);
  if (failed.length) console.log(`  ✗ 沒抓到 ${failed.length}:\n    ${failed.join('\n    ')}`);
}

main().catch(e => { console.error('賽事 logo 抓取失敗:', e.message); process.exitCode = 1; });
