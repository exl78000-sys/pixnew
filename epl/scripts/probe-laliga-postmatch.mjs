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

/* 本站賽後報告吃的是一個 **canonical detail**(SportMonks 與 API-Football 各有一個
   adapter 轉成它),欄位是:
     home / away / score / kickoff / teamStats / players / events / lineups / coverage
   所以這支要挖的不是「有沒有」,是「**在哪個鍵、長什麼形狀**」——
   照名字猜欄位是這個專案踩過最多次的坑。
   輸出刻意只印鍵與一兩筆樣本,不倒整包(log 會被擠掉)。 */

const cut = (v, n = 3) => {
  if (v == null) return 'null';
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return `{${Object.keys(v).slice(0, n * 5).join(',')}}`;
  return JSON.stringify(v).slice(0, 70);
};
const sample = (label, v, depth = 1) => {
  console.log(`\n── ${label} ── ${Array.isArray(v) ? v.length + ' 筆' : typeof v}`);
  if (v == null) { console.log('   (null)'); return; }
  if (Array.isArray(v)) {
    v.slice(0, 2).forEach((x, i) => console.log(`   [${i}] ${cut(x)}`));
    if (v[0] && typeof v[0] === 'object') {
      for (const [k, val] of Object.entries(v[0]).slice(0, 14)) console.log(`        ${k.padEnd(20)} ${cut(val)}`);
    }
    return;
  }
  for (const [k, val] of Object.entries(v).slice(0, 16)) {
    console.log(`   ${k.padEnd(22)} ${cut(val)}`);
    if (depth > 0 && val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k2, v2] of Object.entries(val).slice(0, 8)) console.log(`        ${k2.padEnd(18)} ${cut(v2)}`);
    }
  }
};

async function main() {
  console.log('\n▶ 西甲賽後資料的替代來源探測(FotMob,最多 3 個請求)\n');

  const cachePath = join(ROOT, 'data', 'raw', 'fotmob-la-liga', '2026-27-lineups.json');
  if (!existsSync(cachePath)) { console.log('✗ 找不到 FotMob 西甲快取。先跑 npm run laliga:lineups。'); return; }
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const withId = Object.entries(cache.matches ?? cache ?? {}).filter(([, m]) => m?.matchId);
  if (!withId.length) { console.log('✗ 快取裡沒有 matchId。'); return; }
  const [key, s0] = withId[0];
  console.log(`樣本場次:${key}(matchId ${s0.matchId})`);

  let d;
  try { d = await get(`https://www.fotmob.com/api/data/matchDetails?matchId=${s0.matchId}`); }
  catch (e) { console.log(`✗ matchDetails 抓不到:${e.message}\n  → 端點可能改了,先確認網址再下結論。`); return; }

  const c = d.content ?? {};
  console.log('\ncontent 的鍵:', Object.keys(c).join(', '));

  sample('general(隊伍與 ID)', {
    matchId: d.general?.matchId, leagueId: d.general?.leagueId, matchTimeUTC: d.general?.matchTimeUTC,
    matchTimeUTCDate: d.general?.matchTimeUTCDate,
    homeTeam: d.general?.homeTeam, awayTeam: d.general?.awayTeam,
  });
  sample('header.status(比分與狀態)', d.header?.status);
  sample('content.stats(球隊統計)', c.stats);
  const periods = c.stats?.Periods ?? c.stats?.periods;
  if (periods) {
    sample('stats.Periods 的鍵', periods, 0);
    const all = periods.All ?? periods.all ?? Object.values(periods)[0];
    sample('stats.Periods.All', all, 0);
    const groups = all?.stats ?? all;
    if (Array.isArray(groups)) {
      console.log(`\n   統計分組 ${groups.length} 組:`);
      groups.slice(0, 3).forEach(g => {
        console.log(`     ・${g.title ?? g.key ?? '?'} → ${cut(g.stats)}`);
        (g.stats ?? []).slice(0, 4).forEach(st => console.log(`         ${JSON.stringify(st).slice(0, 130)}`));
      });
    }
  }
  const lu = c.lineup ?? {};
  sample('content.lineup 的鍵', lu, 0);
  const ht = lu.homeTeam ?? lu.lineup?.[0];
  sample('lineup.homeTeam', ht, 0);
  const starters = ht?.starters ?? ht?.players?.flat?.();
  if (starters?.length) {
    console.log('\n   先發第一人的完整鍵:');
    for (const [k, v] of Object.entries(starters[0]).slice(0, 22)) console.log(`     ${k.padEnd(22)} ${cut(v)}`);
    console.log('   performance:', JSON.stringify(starters[0].performance ?? null).slice(0, 200));
  }
  sample('content.playerStats', c.playerStats, 0);
  /* 逐人統計的內部形狀 —— canonical detail 的 `players` 要的是
     minutes / rating / goals / assists / shots / passes / duels / cards。
     不知道 stats 怎麼包就寫不出對映,而猜欄位名是本站踩過最多次的坑。 */
  const oneId = Object.keys(c.playerStats ?? {})[0];
  const one = c.playerStats?.[oneId];
  if (one) {
    console.log(`\n   逐人統計樣本(${one.name}):stats 是 ${Array.isArray(one.stats) ? one.stats.length + ' 組陣列' : typeof one.stats}`);
    const groups = Array.isArray(one.stats) ? one.stats : Object.values(one.stats ?? {});
    groups.slice(0, 3).forEach(g => {
      console.log(`     ・${g?.title ?? g?.key ?? '?'} → ${cut(g?.stats)}`);
      const inner = g?.stats ?? {};
      Object.entries(inner).slice(0, 8).forEach(([k, v]) => console.log(`         ${k.padEnd(24)} ${JSON.stringify(v).slice(0, 90)}`));
    });
  }
  const ev = c.matchFacts?.events;
  sample('matchFacts.events', ev, 0);
  console.log('\n   eventTypes(全部):', JSON.stringify(ev?.eventTypes));
  if (Array.isArray(ev?.events)) {
    const byType = {};
    for (const e of ev.events) byType[e.type] = (byType[e.type] ?? 0) + 1;
    console.log('   事件型別分佈:', JSON.stringify(byType));
    // 每一種型別各印一筆 —— 進球與換人的欄位名是對映的關鍵
    for (const t of Object.keys(byType)) {
      const e = ev.events.find(x => x.type === t);
      console.log(`     [${t}] ${JSON.stringify(e).slice(0, 260)}`);
    }
  }

  console.log(`\n本次共 ${requests} 個請求。這支不寫任何檔案。`);
  console.log('對照本站 canonical detail 需要的:home/away/score/kickoff/teamStats/players/events/lineups');
}

main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
