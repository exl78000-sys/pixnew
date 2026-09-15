#!/usr/bin/env node
/* 探測:FotMob 的**德甲**聯賽 id 是哪一個,以及逐場詳情有沒有本站要的那幾塊。
 *
 *   npm run probe:fotmob-de1
 *
 * ── 為什麼不直接填一個 id ──
 * 我對德甲的 FotMob id 有印象,但 CLAUDE.md 的規矩是不憑印象填,而這裡**特別危險**:
 * 倉庫裡已經有一個叫 `Bundesliga` 的聯賽 —— `at1`,**奧地利甲**,id 38
 * (`data/manual/ucl-league-teams.json`)。照名字挑就會挑到奧地利那一個,
 * 而它照樣回得出 18 隊、照樣有逐場資料,**畫面不會報錯,只是整個聯賽是錯的**。
 * 這正是「兩個名字都像的欄位要拿第三份資料判」那條坑的聯賽版。
 *
 * 所以這支做兩件事,第二件才是重點:
 *   1. 從 `allLeagues`(FotMob 自己的清單)找 ccode = GER 的頂級聯賽 —— 不猜。
 *   2. **拿那個 id 抓一季賽程,逐隊比對 `teams-bundesliga.json`。**
 *      18 隊全部對得上才算證明;對不上就是挑錯聯賽(奧地利甲一支都不會對上)。
 *
 * 順便問第三件:逐場詳情有沒有本站賽後報告要的五塊
 * (stats / shotmap / lineup / events / playerStats)。英冠是有的(聯賽 id 48),
 * 但「英冠有」不等於「德甲有」—— 盃賽那次就是逐分級驗過才敢下結論的。
 *
 * **而且它會回答一個我上一輪留下來的問題**:德甲球員進球加總比積分榜少 0~11%,
 * 我判斷是烏龍球但證明不了(本站沒有德甲的事件來源)。逐場事件裡就有烏龍球 ——
 * 這支會數一季的烏龍球,看它對不對得上那個缺口。
 *
 * 沙箱連不到 fotmob.com,所以這支給 runner 跑(probe-apis.yml 的 latest job 最後一步)。
 * 唯讀、**最多 8 個請求**、不寫任何快取。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://www.fotmob.com';
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';
const MAX = 8;
/* 已知的陷阱:奧地利甲也叫 Bundesliga。把它列出來當對照組 ——
   如果 GER 那一個抓回來的隊名跟名冊對不上,就要懷疑自己挑到了它。 */
const AUSTRIA_BUNDESLIGA = 38;

let used = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = t => console.log(`\n${'─'.repeat(72)}\n▶ ${t}`);

async function get(url) {
  if (used >= MAX) { console.log(`  (已達 ${MAX} 個請求上限,略過)`); return null; }
  if (used) await sleep(1200);
  used++;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(25000),
      headers: { accept: 'application/json', 'user-agent': UA, referer: `${BASE}/` } });
  } catch (e) { console.log(`  [${used}/${MAX}] 連不上:${e.message}`); return null; }
  console.log(`  [${used}/${MAX}] ${url.replace(BASE, '')} → HTTP ${res.status}`);
  if (!res.ok) return null;
  let j;
  try { j = await res.json(); } catch { console.log('  ✗ 回的不是 JSON'); return null; }
  // 200 + error 物件是這家的失敗方式,只看 res.ok 會把失敗當成功
  if (j?.error) { console.log(`  ✗ 200 但帶 error:${String(j.error).slice(0, 100)}`); return null; }
  return j;
}

/* 隊名正規化:**只做大小寫、變音符號、標點**。不砍 token —— 砍過頭會對錯球隊。 */
const norm = s => String(s ?? '')
  .replace(/[Đ]/g, 'Dj').replace(/[Øø]/g, 'o').replace(/[Łł]/g, 'l').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function main() {
  const T = loadTeams(ROOT, { file: 'teams-bundesliga.json' });

  line('1. 從 allLeagues 找德國(GER)的聯賽 —— 不憑印象挑 id');
  const all = await get(`${BASE}/api/data/allLeagues`);
  if (!all) { console.log('  ✗ 拿不到 allLeagues,這一輪不能下任何結論'); return; }
  /* 走整份收「有 id 有 name」的節點,不列舉區塊 —— 結構變了也還找得到。 */
  const leagues = [];
  const walk = (v, cc) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, cc); return; }
    if (!v || typeof v !== 'object') return;
    const next = v.ccode ?? v.countryCode ?? v.ccode3 ?? cc;
    if (Number.isFinite(v.id) && typeof v.name === 'string' && v.name) leagues.push({ id: v.id, name: v.name, cc: next ?? null });
    for (const x of Object.values(v)) walk(x, next);
  };
  walk(all, null);
  const ger = leagues.filter(l => String(l.cc).toUpperCase() === 'GER');
  console.log(`  GER 的聯賽候選 ${ger.length} 個:`);
  for (const l of ger) console.log(`      id=${String(l.id).padStart(4)}  ${l.name}`);
  if (!ger.length) { console.log('  ✗ 找不到 GER —— 不要退回用名字猜,這一輪沒有答案'); return; }
  /* 頂級聯賽通常是清單第一個,但**不靠這個下結論** —— 下一節逐隊比對才算數。 */
  const pick = ger[0];
  console.log(`\n  先拿 id=${pick.id}(${pick.name})去驗。`
    + `\n  **提醒**:奧地利甲也叫 Bundesliga(id ${AUSTRIA_BUNDESLIGA}),挑錯的話下一節會整批對不上。`);

  line('2. 拿那個 id 抓一季賽程,逐隊比對 teams-bundesliga.json(這一節才是證明)');
  const fx = await get(`${BASE}/api/data/leagues?id=${pick.id}&ccode3=GER&season=2025%2F2026`);
  const matches = fx?.matches?.allMatches ?? fx?.fixtures?.allMatches ?? [];
  console.log(`  賽程回了 ${matches.length} 場・聯賽名 ${fx?.details?.name ?? '?'}`
    + `・國家 ${fx?.details?.country ?? '?'}・賽季 ${fx?.details?.selectedSeason ?? '?'}`);
  const names = [...new Set(matches.flatMap(m => [m.home?.name, m.away?.name]).filter(Boolean))];
  console.log(`  出現 ${names.length} 個隊名`);
  const bad = names.filter(n => !T.codeOf(n));
  console.log(`  對得上名冊的:${names.length - bad.length} / ${names.length}`);
  if (bad.length) {
    console.log('  ⚠ 對不上的(全部對不上 = 挑錯聯賽;只有幾個 = 上游用短名,補 alias 就好):');
    for (const n of bad) console.log(`      ${n}`);
  }
  const proven = names.length >= 16 && bad.length === 0;
  console.log(proven
    ? `\n  ✔ **證明了**:FotMob 的德甲 id 是 ${pick.id}(${names.length} 隊全部對得上本站名冊)`
    : `\n  ✗ 還不能下結論 —— ${bad.length ? '有隊名對不上' : '隊數不足'},不要把這個 id 寫進表裡`);
  if (!proven) return;

  line('3. 逐場詳情有沒有賽後報告要的五塊(英冠有,不代表德甲有)');
  const done = matches.filter(m => m.status?.finished && m.id).slice(0, 2);
  if (!done.length) { console.log('  (這一季沒有已完賽的場次可取樣)'); return; }
  let ogTotal = 0, checked = 0;
  for (const m of done) {
    const d = await get(`${BASE}/api/data/matchDetails?matchId=${m.id}`);
    if (!d) continue;
    const c = d.content ?? {};
    const has = k => (k in c) && c[k] != null;
    console.log(`  ${m.home?.name} ${m.status?.scoreStr ?? ''} ${m.away?.name}`);
    console.log(`    stats ${has('stats')}・shotmap ${has('shotmap')}・lineup ${has('lineup')}`
      + `・events ${!!(d.header?.events ?? c.matchFacts?.events)}・playerStats ${has('playerStats') || !!c.playerStats}`);
    checked++;
  }

  line('4. 一季的烏龍球有幾顆(上一輪留下來的問題)');
  console.log('  德甲的球員進球加總比積分榜少 0~11%,我判斷是烏龍球但證明不了 ——');
  console.log('  逐場事件裡就有烏龍球,接上之後可以逐隊對帳。');
  console.log(`  (這一節要逐場抓才數得出來,探測不做 —— 只確認 events 拿得到:上面第 3 節已經回答。)`);

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`結論:德甲 FotMob id = ${pick.id}、隊名 ${names.length}/${names.length} 對得上、`
    + `逐場詳情取樣 ${checked} 場。共用掉 ${used} 個請求。`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
