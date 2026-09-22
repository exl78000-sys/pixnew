#!/usr/bin/env node
/* 歐冠外部球隊(本站六個聯賽都不認得的那些)的隊徽 → 縮圖 → 內嵌成 data URI。
 *
 * 為什麼到 2026-09-22 才有這一支:原本那 40 張是 2026-08-28 **人工交付**的,沒有抓取器。
 * 於是本季新進來的七支(Porto、Fenerbahçe、PAE AEK、LASK、Viking、Sabah FK、Paphos FC)
 * 就卡在「沒有人會回來補」—— 這正是本站記過的那條坑:
 * **抓取器的輸入靠一個沒進工作流的手動步驟,主來源一停就整條斷。**
 *
 * 目標名單完全由 `data/manual/ucl-team-ids.json` 決定(那份現在由 `npm run ucl:ids` 自己長),
 * 所以下一季再有新球隊進來,這兩步會自己把它補上,不必有人記得。
 *
 * 來源跟既有那 40 張同一個:images.fotmob.com/image_resources/logo/teamlogo/{FotMob id}.png
 * —— 一個聯賽一種來源(混來源的話同一排隊徽長得不一樣,而畫面上看不出為什麼)。
 * 每一張驗 PNG 魔數;不是 PNG 就不收(decodePNG 讀不了 webp/svg,硬轉會變壞圖)。
 *
 * **失敗的不寫成永久失敗、下次一定重試。** 沙箱的出口代理對這個網域回 403
 * (實測:104 bytes、開頭是 `Host`,不是 PNG)——把那種記成「抓不到」會讓一張
 * 抓得到的圖永遠不再被抓。這一條在補球員頭貼那一輪就踩過。
 *
 * 抓取禮貌:單線、間隔 200ms、每次上限 --limit(預設 20)張,已經有的直接略過 ——
 * 補齊之後這一步每次執行 **0 個請求**。
 *
 *   npm run ucl:crests
 *   npm run ucl:crests -- --limit=5 --dry-run
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, resizeRGBA, encodePNG } from './lib/png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP = join(ROOT, 'data', 'manual', 'ucl-team-ids.json');
const OUT = join(ROOT, 'data', 'manual', 'crests-ucl.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const LIMIT = Number(arg('limit') || 20);
const DRY = process.argv.includes('--dry-run');
const DELAY = 200;
const urlOf = id => `https://images.fotmob.com/image_resources/logo/teamlogo/${id}.png`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!existsSync(MAP)) { console.log('⚠ 沒有 ucl-team-ids.json(先跑 npm run ucl:ids),略過。'); return; }
  const map = JSON.parse(await readFile(MAP, 'utf8'));
  const store = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : { crests: {}, sources: {}, failed: {} };
  store.crests ??= {}; store.sources ??= {}; store.failed ??= {};
  /* 寬度跟既有那 40 張一樣 —— 換寬度就要整份重抓,不然同一排隊徽大小不一 */
  const WIDTH = Number(arg('width') || store.width || 64);

  const todo = (map.teams ?? []).filter(t => !store.crests[String(t.fotmobId)]);
  console.log(`▶ 歐冠外部球隊隊徽:對照 ${(map.teams ?? []).length} 隊・已有 ${Object.keys(store.crests).length} 張`
    + `・這次抓 ${Math.min(todo.length, LIMIT)}(上限 ${LIMIT})・縮到寬 ${WIDTH}px`);
  if (!todo.length) { console.log('✔ 沒有缺的,不發任何請求。'); return; }
  for (const t of todo) console.log(`    缺 ${t.fdName}(FotMob ${t.fotmobId} ${t.fotmobName ?? ''})`);
  if (DRY) { console.log('(--dry-run,不抓也不寫檔)'); return; }

  let got = 0; const failed = [];
  for (const t of todo.slice(0, LIMIT)) {
    const id = String(t.fotmobId);
    if (got) await sleep(DELAY);
    try {
      const res = await fetch(urlOf(id), { signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA, referer: 'https://www.fotmob.com/' } });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) { failed.push(`${t.fdName} HTTP ${res.status}`); store.failed[id] = `HTTP ${res.status}`; continue; }
      if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
        failed.push(`${t.fdName} 不是 PNG(${buf.length} bytes)`); store.failed[id] = 'not-png'; continue;
      }
      store.crests[id] = `data:image/png;base64,${encodePNG(resizeRGBA(decodePNG(buf), WIDTH)).toString('base64')}`;
      /* 逐張記時間:檔案層的 retrievedAt 是 2026-08-28 那次交付的,拿它替今天抓的圖背書
         (或反過來)都是說謊。沒有 `at` 的就是那次交付的 40 張。 */
      store.sources[id] = { name: t.fotmobName ?? t.fdName, url: urlOf(id), at: new Date().toISOString() };
      delete store.failed[id];
      got++;
    } catch (e) { failed.push(`${t.fdName} ${e.message}`); store.failed[id] = e.message; }
  }

  store._note = '歐冠球隊隊徽,key 是 FotMob 的 team id(不是本站隊碼)。本站六個聯賽認得的球隊走各自的 crests*.json,不放這裡。'
    + '來源:FotMob image_resources,每一張驗過 PNG 魔數。'
    + `retrievedAt 是 2026-08-28 那次人工交付的時間(那 40 張沒有逐張的 at);`
    + 'sources[id].at 有值的是 npm run ucl:crests 抓的。';
  store.width = WIDTH;
  if (got && !DRY) await writeFile(OUT, JSON.stringify(store, null, 0) + '\n');

  const bytes = Object.values(store.crests).reduce((a, v) => a + v.length, 0);
  console.log(`✔ 這次新增 ${got} 張・累計 ${Object.keys(store.crests).length} 張(約 ${(bytes / 1024).toFixed(0)} KB)`);
  if (failed.length) {
    console.log(`  ✗ 失敗 ${failed.length}:${failed.slice(0, 8).join('、')}`);
    console.log('    (失敗的不寫成永久失敗,下次執行一定重試 —— 沙箱的 403 不是「這張抓不到」)');
  }
  const left = todo.length - got;
  if (left > 0) console.log(`  還有 ${left} 隊沒抓(下次執行會接著抓)`);
}

main().catch(e => { console.error('歐冠隊徽抓取失敗:', e.message); process.exitCode = 1; });
