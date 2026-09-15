#!/usr/bin/env node
/* 探測 Understat 有沒有德甲的整季球員數據,以及**聯賽代號到底是哪一個字串**。
 *
 *   npm run probe:understat-de1
 *
 * 為什麼要有這一支:CLAUDE.md 第四條 ——「不要憑印象斷言某個 API 有什麼欄位」。
 * 德甲的球員層是這一輪唯一缺的東西,而我對它的印象是「Understat 做五大聯賽,
 * 所以 slug 應該是 Bundesliga」。**印象不算數**:西甲那條路是
 * `league=La_liga`(底線、小寫 l),照同一個直覺推德甲會得到什麼寫法不一定對,
 * 而這個端點**猜錯不會回 HTTP 錯誤**,它回 `{"error":{...}}` 或一個空陣列 ——
 * 那正是「API 回 200 加一個 error 物件」那條坑,只看 res.ok 會以為成功了。
 *
 * 沙箱連不到 understat.com(2026-09-15 實測 CONNECT 403),所以這支是給
 * GitHub Actions 的 runner 跑的(probe-apis.yml 的 latest job **最後一步** ——
 * 讀結果的方法是抓 job log 的尾端,排前面會被後面的步驟擠出視窗)。
 *
 * 要回答的四個問題:
 *   1. 哪一個 league 字串真的回得到德甲球員?(候選逐一試,不是猜一個就寫死)
 *   2. 回傳的欄位跟西甲那份**一不一樣**?不一樣的話累加與前端都要跟著改。
 *   3. 隊名對不對得上 `teams-bundesliga.json` 的名冊?
 *      —— 對不上的那幾隊會靜靜整隊消失,而畫面完全正常(英冠那次 14 支)。
 *   4. 上季(2025-26)拿不拿得到?球員頁能不能比照英超做「本季 + 上季」看這一題。
 *
 * 抓取禮貌:**最多 6 個請求**,每個之間隔 1.5 秒,一個位元組都不寫進倉庫。
 * 使用者要求過不要大量爬網站,探測自己先違反就沒有說服力。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'https://understat.com/main/getPlayersStats/';
const MAX_REQUESTS = 6;

/* 候選字串。第一個是我的猜測,**其餘是常見的其他寫法** ——
   列出來逐一試,才問得出「哪一個對」而不是「我猜的那個通不通」。
   對照組放最後:西甲那個字串是已知會成功的,它也失敗的話代表
   端點本身壞了或 runner 被擋,而不是德甲沒有(這兩個結論差很多)。 */
const CANDIDATES = ['Bundesliga', 'bundesliga', 'Bundesliga_1', 'German_Bundesliga'];
const CONTROL = 'La_liga';

let used = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = t => console.log(`\n${'─'.repeat(72)}\n▶ ${t}`);

async function ask(league, season) {
  if (used >= MAX_REQUESTS) { console.log(`  (已達 ${MAX_REQUESTS} 個請求上限,略過 ${league}/${season})`); return null; }
  if (used) await sleep(1500);
  used++;
  const body = new URLSearchParams({ league, season: String(season) }).toString();
  let res;
  try {
    res = await fetch(URL_, {
      method: 'POST', body, signal: AbortSignal.timeout(30000),
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        referer: `https://understat.com/league/${league}/${season}`,
        'user-agent': 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)',
        'x-requested-with': 'XMLHttpRequest',
      },
    });
  } catch (e) {
    console.log(`  [${used}/${MAX_REQUESTS}] ${league}/${season} → 連不上:${e.message}`);
    return null;
  }
  console.log(`  [${used}/${MAX_REQUESTS}] POST league=${league}&season=${season} → HTTP ${res.status}`);
  if (!res.ok) return null;
  let j;
  try { j = await res.json(); } catch { console.log('  ✗ 回的不是 JSON(可能是 HTML 錯誤頁)'); return null; }
  /* 200 + error 物件是這個端點的失敗方式,不是 HTTP 錯誤碼。 */
  if (j?.error) { console.log(`  ✗ 端點回報 error:${JSON.stringify(j.error).slice(0, 120)}`); return null; }
  const rows = Array.isArray(j) ? j : (j.players ?? j.response?.players ?? null);
  if (!Array.isArray(rows)) { console.log(`  ✗ 回傳不是球員陣列(頂層鍵:${Object.keys(j ?? {}).join(',') || '無'})`); return null; }
  console.log(`  → ${rows.length} 筆`);
  return rows;
}

async function main() {
  const T = loadTeams(ROOT, { file: 'teams-bundesliga.json' });

  line('1. 哪一個 league 字串回得到德甲?(逐一試,不是猜一個寫死)');
  let slug = null, rows = null;
  for (const c of CANDIDATES) {
    const r = await ask(c, 2025);
    /* **空陣列不算成功。** 英冠那次四種寫法全回 `{"success":true,"players":[]}`,
       只看「有沒有拋錯」會把它當成拿到了。 */
    if (r && r.length) { slug = c; rows = r; break; }
    if (r) console.log('     (回了空陣列 —— 這個寫法端點認得,但沒有資料,不算成功)');
  }
  if (!slug) {
    console.log('\n  ✗ 候選字串都沒有資料。先跑對照組確認是「德甲沒有」還是「整個端點不通」:');
    const ctl = await ask(CONTROL, 2025);
    console.log(ctl?.length
      ? `  → 西甲回了 ${ctl.length} 筆,端點是通的 ⇒ 結論是**這幾個寫法都不對或德甲真的沒有**,要再找別的寫法`
      : '  → 西甲也拿不到 ⇒ 端點或 runner 出口有問題,**這一輪不能下任何關於德甲的結論**');
    return;
  }
  console.log(`\n  ✔ 可用的聯賽代號是 "${slug}"`);

  line('2. 欄位跟西甲那一份一不一樣?(不一樣的話累加與前端都要改)');
  const keys = Object.keys(rows[0] ?? {});
  console.log(`  欄位(${keys.length}):${keys.join(', ')}`);
  console.log('  範例一筆:');
  for (const k of keys) console.log(`    ${k} = ${JSON.stringify(rows[0][k])}`);
  /* 西甲抓取器檔頭列出來的那一組。少了任何一個,下游就要改。 */
  const NEED = ['id', 'player_name', 'games', 'time', 'goals', 'xG', 'assists', 'xA',
    'shots', 'key_passes', 'yellow_cards', 'red_cards', 'position', 'team_title',
    'npg', 'npxG', 'xGChain', 'xGBuildup'];
  const lack = NEED.filter(k => !keys.includes(k));
  console.log(lack.length ? `  ⚠ 少了西甲有的欄位:${lack.join('、')}` : '  ✔ 西甲那一組欄位一個不少,下游可以照用');
  const extra = keys.filter(k => !NEED.includes(k));
  if (extra.length) console.log(`  (多出來的:${extra.join('、')})`);

  line('3. 隊名對不對得上 teams-bundesliga.json');
  const seen = new Map();
  for (const r of rows) seen.set(r.team_title, (seen.get(r.team_title) ?? 0) + 1);
  const bad = [];
  for (const [name, n] of seen) if (!T.codeOf(name)) bad.push(`${name}(${n} 人)`);
  console.log(`  上游出現 ${seen.size} 個隊名,對得上 ${seen.size - bad.length} 個`);
  if (bad.length) {
    console.log('  ⚠ 對不上(要補進名冊的 alias,不補的話這幾隊會整隊消失而畫面完全正常):');
    for (const b of bad) console.log(`      ${b}`);
  } else console.log('  ✔ 全部對得上');
  /* 反方向也要看:名冊上有、上游卻一個球員都沒有的隊 —— 那通常代表 alias 寫錯了,
     而正方向的檢查看不出來(上游的名字都對得上,只是對到同一隊)。 */
  const covered = new Set([...seen.keys()].map(n => T.codeOf(n)).filter(Boolean));
  const thisSeason = T.list.filter(t => t.fd);     // 名冊含升降級球隊,只看有 D1 寫法的那些當粗略母體
  const missing = thisSeason.filter(t => !covered.has(t.code)).map(t => `${t.code} ${t.en}`);
  console.log(`  名冊涵蓋 ${covered.size} 隊;名冊上有而這一季沒有球員的:${missing.length ? missing.join('、') : '無'}`);
  console.log('  (德甲一季 18 隊,名冊 24 隊含升降級 —— 差額是正常的,要看的是**有沒有某一隊本季在打卻不見了**)');

  line('4. 上季與本季各有多少(球員頁能不能做「本季 + 上季」兩套)');
  console.log(`  2025-26:${rows.length} 筆`);
  const cur = await ask(slug, 2026);
  console.log(cur?.length
    ? `  2026-27:${cur.length} 筆 → 兩季都有,可以比照英超做兩套`
    : '  2026-27:拿不到或是空的 → 只做上季,並在畫面上寫明原因(不要留空欄位)');

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`結論:聯賽代號 "${slug}"、欄位${lack.length ? '有差異(見上)' : '跟西甲相同'}、`
    + `隊名${bad.length ? `有 ${bad.length} 個對不上` : '全對'}。共用掉 ${used} 個請求。`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
