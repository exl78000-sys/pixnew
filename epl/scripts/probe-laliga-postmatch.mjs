#!/usr/bin/env node
/* SportMonks 停用後的替代來源探測(唯讀,不寫任何正式快取)。
 *
 * 2026-09-03 使用者取消了 SportMonks 方案。停掉之後**新場次**拿不到的是:
 *   1. 西甲賽後報告(球隊統計、事件、球員評分)—— 目前 30/30 場,不再增加
 *   2. 西甲即時比分 —— 已停(build 現在照實標成沒有資料源)
 *   3. 西甲球員的背號/頭貼/生日/身高體重 —— 凍結在目前這批,轉會不更新
 *   4. 英格蘭盃賽賽果(足總盃 / 聯賽盃)—— 不再更新
 * 已經抓到的都在版控裡,不會消失;抓取是「合併進既有快取」,失敗也不會洗掉。
 *
 * 這支只回答一個問題:**FotMob 的 matchDetails 能不能接手 1 與 2。**
 * 選它是因為本站已經在用它抓西甲逐場正式先發(`fetch-laliga-lineups.mjs`),
 * 客戶端、隊名對照與速率限制都現成,而且 2026-08-26 的探測就看到
 * `content.lineup` 帶有完賽評分 —— 但當時沒有確認球隊統計與事件。
 *
 * **不要憑印象斷言它有什麼欄位**(CLAUDE.md 第四節)。所以這裡只做一件事:
 * 抓一場已完賽的西甲比賽,把**實際回來的鍵**列出來,對照本站賽後報告需要的欄位。
 *
 * 沙箱連不到外網 —— 走 workflow_dispatch 跑,再讀 log。
 *   npm run probe:laliga-postmatch
 *
 * 抓取禮貌:**最多 3 個請求**,單線,間隔 400ms。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (football analysis side project)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;

async function get(url) {
  if (requests >= 3) throw new Error('已達本次 3 個請求上限');
  requests++;
  await sleep(400);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]} ${text.slice(0, 120)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`回傳不是 JSON(${text.length} bytes)`); }
  // API 回 200 加一個 error 物件是本站踩過的坑 —— 不看 res.ok 就當成功
  if (j?.error) throw new Error(`回了 200 但帶 error:${JSON.stringify(j.error).slice(0, 120)}`);
  return j;
}

// 本站賽後報告實際用到的東西 —— 探測要回答的就是「這幾樣有沒有」
const NEEDED = {
  '球隊統計(控球/射門/角球…)': j => j?.content?.stats ?? j?.content?.matchFacts?.stats ?? null,
  '球員評分': j => j?.content?.lineup?.homeTeam?.starters?.[0]?.performance ?? null,
  '先發與陣型': j => j?.content?.lineup?.homeTeam?.formation ?? null,
  '事件時間軸': j => j?.content?.matchFacts?.events ?? null,
  '最終比分': j => j?.header?.status?.scoreStr ?? null,
};

const keysOf = v => (v == null ? null
  : Array.isArray(v) ? `[${v.length}] ${v.length ? Object.keys(v[0] ?? {}).slice(0, 10).join(',') : ''}`
    : typeof v === 'object' ? Object.keys(v).slice(0, 14).join(',') : String(v).slice(0, 60));

async function main() {
  console.log('\n▶ 西甲賽後資料的替代來源探測(FotMob,最多 3 個請求)\n');

  /* 挑一場已完賽的西甲比賽:直接用本站已經快取的 FotMob 場次 ID,
     不再多打一次聯賽賽程(省一個請求,而且那份本來就是核對過的)。 */
  const cachePath = join(ROOT, 'data', 'raw', 'fotmob-la-liga', '2026-27-lineups.json');
  if (!existsSync(cachePath)) {
    console.log('✗ 找不到 FotMob 西甲快取,無法挑場次。先跑 npm run laliga:lineups。');
    return;
  }
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const entries = Object.entries(cache.matches ?? cache ?? {});
  const withId = entries.filter(([, m]) => m?.matchId);
  if (!withId.length) { console.log('✗ 快取裡沒有 matchId,不知道要探哪一場。'); return; }
  const [key, sample] = withId[0];
  console.log(`樣本場次:${key}(matchId ${sample.matchId})\n`);

  let detail;
  try {
    detail = await get(`https://www.fotmob.com/api/data/matchDetails?matchId=${sample.matchId}`);
  } catch (e) {
    console.log(`✗ matchDetails 抓不到:${e.message}`);
    console.log('  → 端點可能改了。改端點之前不要斷言「FotMob 拿不到」,先確認網址。');
    return;
  }

  console.log('回傳的頂層鍵:', Object.keys(detail).join(', '));
  console.log('content 的鍵 :', Object.keys(detail.content ?? {}).join(', '), '\n');
  let ok = 0;
  for (const [label, pick] of Object.entries(NEEDED)) {
    let v = null;
    try { v = pick(detail); } catch { v = null; }
    if (v != null) ok++;
    console.log(`  ${v != null ? '✔' : '✘'} ${label.padEnd(22)} ${v != null ? keysOf(v) : '(這條路徑取不到 —— 可能是欄位名不同,不代表沒有)'}`);
  }
  console.log(`\n${ok}/${Object.keys(NEEDED).length} 項在預期的路徑上取得到。`);
  console.log('取不到的那幾項,把上面「content 的鍵」拿去對 —— 欄位名不同跟資料不存在是兩件事。');
  console.log(`\n本次共 ${requests} 個請求。這支不寫任何檔案。`);
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
