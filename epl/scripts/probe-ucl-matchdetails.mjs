#!/usr/bin/env node
/* 歐冠逐場詳情探測(唯讀,不寫任何正式快取)。
 *
 * 為什麼(2026-09-11,使用者問「歐冠沒有賽完紀錄可以看?」):
 * 歐冠踢完之後畫面上只剩比分 —— 沒有事件、沒有名單、沒有統計、沒有賽後報告,
 * 而且前端的展開鈕條件是 `!m.played`,**已完賽根本點不進去**。
 * `ucl.json` 來自 football-data.org 的賽事端點(賽果 + 積分榜),本來就只有那些。
 *
 * 但「沒抓」不等於「拿不到」(鐵則三,Understat 那條坑)。三個聯賽的賽後報告
 * 就是 FotMob 的逐場詳情給的,而盃賽(132/133)已經走同一條路在跑。
 * 這支只回答「**歐冠在同一組端點回什麼**」,不憑印象寫 adapter(CLAUDE.md 第四節):
 *
 *   1. 歐冠的 FotMob 聯賽 id 是多少 —— **不用猜的**,走 allLeagues 目錄用名字找
 *   2. 賽程端點給不給本季、場次數對不對、`selectedSeason` 是不是要的那季
 *      (盃賽那條坑:帶 season 參數可能回「最新那季」)
 *   3. 單場詳情有沒有三個聯賽在用的那幾塊:
 *      `content.stats`(球隊統計)、`content.shotmap`(逐射門 xG)、
 *      `content.lineup`(正式名單)、`content.matchFacts.events`(事件)、
 *      `content.playerStats`(逐人評分與數據)
 *   4. 隊 id 接不接得回本站 —— `data/manual/ucl-team-ids.json` 已經有 40 隊的
 *      football-data ↔ FotMob 對照(現在拿來掛隊徽的),看它夠不夠用
 *   5. **鐵則五:拿獨立來源核對** —— FotMob 的比分要對得回 `ucl.json`
 *      (那份是 football-data.org,完全不同的供應商)。日期收斂,不只比隊伍
 *      (「同一組對戰在不同賽季會重複」那條坑)
 *
 * 抓取禮貌:單線、間隔 800ms、硬上限 8 個請求(目錄 1 + 賽程 1 + 單場最多 3,留餘裕)。
 * 沙箱連不到外網 —— 走 probe-apis.yml 的 workflow_dispatch 跑,再讀 log。
 *
 *   npm run probe:ucl-details
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (football analysis side project)';
const ALL_LEAGUES = 'https://www.fotmob.com/api/allLeagues';
const LEAGUE = 'https://www.fotmob.com/api/data/leagues';
const DETAILS = 'https://www.fotmob.com/api/data/matchDetails?matchId=';
const MAX_REQUESTS = 8;
const MAX_DETAILS = 3;
const SEASON = { label: '2026-27', fm: '2026/2027' };
/* 名字比對用。**不要用 id 猜** —— 這個專案在「憑印象斷言端點」上栽過,
   而 allLeagues 是 FotMob 自己的目錄,一個請求就有權威答案。 */
const WANT = /champions\s*league/i;
const NOT_WANT = /women|youth|u1[5-9]|afc|caf|concacaf|conmebol|asian/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;
async function get(url) {
  if (requests >= MAX_REQUESTS) throw new Error(`已達本次 ${MAX_REQUESTS} 個請求上限`);
  if (requests) await sleep(800);
  requests++;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { accept: 'application/json', 'user-agent': UA, referer: 'https://www.fotmob.com/' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 140)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`回傳不是 JSON(${text.length} bytes)`); }
  // 200 加一個 error 物件是踩過的坑
  if (j?.error) throw new Error(`回了 200 但帶 error:${JSON.stringify(j.error).slice(0, 140)}`);
  return j;
}

const has = v => (Array.isArray(v) ? `array(${v.length})` : v && typeof v === 'object' ? `object(${Object.keys(v).length} 鍵)` : v == null ? '—' : typeof v);
/* 走整份收一次,不列舉區塊 —— allLeagues 把國際賽事放在哪個鍵是它的事,
   列舉的話以後換一個鍵就整個找不到(「只讀了其中一個區塊」那條坑)。 */
function findLeagues(root, re, notRe) {
  const out = [];
  const seen = new Set();
  const walk = v => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    const name = v.name ?? v.localizedName ?? null;
    if (v.id != null && typeof name === 'string' && re.test(name) && !(notRe && notRe.test(name))) {
      const k = `${v.id}|${name}`;
      if (!seen.has(k)) { seen.add(k); out.push({ id: v.id, name, ccode: v.ccode ?? null }); }
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(root);
  return out;
}

function ourSeason() {
  const p = join(ROOT, 'web', 'data', 'ucl.json');
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return (j.seasons ?? []).find(s => s.current) ?? null;
}
function idBridge() {
  const p = join(ROOT, 'data', 'manual', 'ucl-team-ids.json');
  if (!existsSync(p)) return new Map();
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return new Map((j.teams ?? []).map(t => [String(t.fotmobId), t]));
}

async function main() {
  console.log(`▶ 歐冠逐場詳情探測(唯讀,上限 ${MAX_REQUESTS} 個請求)\n`);

  // ── 1. 找歐冠的聯賽 id:走目錄,不猜 ──────────────────
  let dir;
  try { dir = await get(ALL_LEAGUES); }
  catch (e) { console.log(`✗ allLeagues 拿不到:${e.message}`); process.exit(0); }
  const hits = findLeagues(dir, WANT, NOT_WANT);
  console.log(`目錄裡名字含 "Champions League" 的(已排除女子/青年/其他洲):${hits.length} 個`);
  for (const h of hits) console.log(`   id=${h.id}  ${h.name}${h.ccode ? `  (${h.ccode})` : ''}`);
  const ucl = hits.find(h => /uefa/i.test(h.name)) ?? hits[0];
  if (!ucl) { console.log('✗ 目錄裡找不到歐冠 —— 名字的寫法可能不同,把上面那份清單擴大再看一次'); process.exit(0); }
  console.log(`\n→ 採用 id=${ucl.id}(${ucl.name})\n`);

  // ── 2. 賽程端點 ────────────────────────────────────
  let lg;
  try { lg = await get(`${LEAGUE}?id=${ucl.id}&season=${encodeURIComponent(SEASON.fm)}`); }
  catch (e) { console.log(`✗ 賽程端點拿不到:${e.message}`); process.exit(0); }
  const got = lg?.details?.selectedSeason ?? null;
  console.log(`賽季驗證:要 ${SEASON.fm}、端點回 ${JSON.stringify(got)} → ${got === SEASON.fm ? '✔ 一致' : '✗ 不一致(盃賽那條坑:帶 season 可能回最新那季)'}`);
  const all = lg?.matches?.allMatches ?? lg?.fixtures?.allMatches ?? [];
  const finished = all.filter(m => m?.status?.finished);
  console.log(`場次:${all.length} 場,已完賽 ${finished.length} 場`);
  if (!all.length) { console.log('✗ 一場都沒有 —— 端點形狀可能不同,先把頂層鍵印出來:', Object.keys(lg ?? {}).join(',')); process.exit(0); }
  console.log(`單場欄位:${Object.keys(all[0]).join(', ')}`);
  console.log(`status 欄位:${Object.keys(all[0].status ?? {}).join(', ')}`);

  // ── 3. 接不接得回本站(隊 id 對照)──────────────────
  const bridge = idBridge();
  const teamIds = new Set();
  for (const m of all) { if (m.home?.id != null) teamIds.add(String(m.home.id)); if (m.away?.id != null) teamIds.add(String(m.away.id)); }
  const mapped = [...teamIds].filter(id => bridge.has(id));
  console.log(`\n隊 id 對照(ucl-team-ids.json 現成的 ${bridge.size} 筆):${mapped.length}/${teamIds.size} 隊接得上`);
  const missing = [...teamIds].filter(id => !bridge.has(id))
    .map(id => all.find(m => String(m.home?.id) === id || String(m.away?.id) === id))
    .map(m => (String(m?.home?.id) && bridge.has(String(m.home.id)) ? m?.away?.name : m?.home?.name));
  if (missing.length) console.log(`   接不上的:${[...new Set(missing)].join('、')}`);

  // ── 4. 獨立來源核對:FotMob 的比分要對得回 ucl.json ──
  const ours = ourSeason();
  if (!ours) { console.log('\n(本機沒有 ucl.json,跳過交叉核對)'); }
  else {
    const byFd = new Map();
    for (const m of (ours.leagueMatches ?? [])) {
      if (!m.played || !Array.isArray(m.final)) continue;
      byFd.set(`${m.home?.id}|${m.away?.id}|${String(m.kickoff ?? '').slice(0, 10)}`, m);
    }
    let agree = 0; const disagree = []; let unmatched = 0;
    const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    for (const f of finished) {
      const h = bridge.get(String(f.home?.id))?.fdId, a = bridge.get(String(f.away?.id))?.fdId;
      const d = new Date(f.status?.utcTime ?? f.time ?? 0).toISOString().slice(0, 10);
      /* 日期收斂:同一組對戰在不同賽季會重複,只比隊伍會抓到上一季那場。
         ±1 天是時區邊界,不是寬鬆比對。 */
      const hit = [d, shift(d, -1), shift(d, 1)].map(x => byFd.get(`${h}|${a}|${x}`)).find(Boolean);
      if (!hit) { unmatched++; continue; }
      const fm = String(f.status?.scoreStr ?? '').split('-').map(x => Number(x.trim()));
      if (fm.length === 2 && fm[0] === hit.final[0] && fm[1] === hit.final[1]) agree++;
      else disagree.push(`${f.home?.name} ${f.status?.scoreStr} ${f.away?.name} vs 本站 ${hit.final.join('-')}`);
    }
    console.log(`\n交叉核對(獨立來源 football-data.org):對上 ${agree + disagree.length} 場、比分一致 ${agree}、不一致 ${disagree.length}、收斂不到 ${unmatched} 場`);
    for (const d of disagree.slice(0, 5)) console.log(`   ✗ ${d}`);
    if (unmatched) console.log('   (收斂不到 ≠ 不一致 —— 多半是本站那一季還沒抓到那幾場)');
  }

  // ── 5. 單場詳情有沒有那幾塊 ────────────────────────
  const samples = finished.slice(0, MAX_DETAILS);
  console.log(`\n單場詳情(取已完賽的前 ${samples.length} 場):`);
  for (const s of samples) {
    let d;
    try { d = await get(`${DETAILS}${s.id}`); }
    catch (e) { console.log(`   ✗ matchId=${s.id} ${e.message}`); continue; }
    const c = d?.content ?? {};
    const shots = c.shotmap?.shots ?? c.shotmap ?? null;
    console.log(`   ${s.home?.name} ${s.status?.scoreStr} ${s.away?.name}(matchId=${s.id})`);
    console.log(`      content 鍵:${Object.keys(c).join(', ') || '(空)'}`);
    console.log(`      stats=${has(c.stats)}  shotmap=${has(shots)}  lineup=${has(c.lineup)}`
      + `  events=${has(c.matchFacts?.events?.events)}  playerStats=${has(c.playerStats)}`);
    // 有逐射門就報 xG 合計與進球數 —— 「完整性檢查」是採不採用的分界(兩種 xG 算法那條坑)
    if (Array.isArray(shots) && shots.length) {
      const xg = shots.reduce((n, x) => n + (Number(x.expectedGoals) || 0), 0);
      const goals = shots.filter(x => x.isOwnGoal || /goal/i.test(String(x.eventType ?? ''))).length;
      console.log(`      逐射門:${shots.length} 次、xG 合計 ${xg.toFixed(2)}、標為進球 ${goals} 次(比分 ${s.status?.scoreStr})`);
    }
  }

  console.log(`\n◀ 結束,共 ${requests} 個請求`);
}

main().catch(e => { console.log(`✗ ${e.message}`); process.exit(0); });
