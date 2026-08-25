#!/usr/bin/env node
// 探測西甲球員的整季數據還有沒有別的來源。
//
//   npm run probe:laliga-playerdata
//
// 為什麼需要這一支:第一支探測(probe:laliga-players)已經測出來,
// API-Football 這把金鑰是 **Free 方案,只開放 2022–2024 三個賽季**,
// 本季(2026)與上季(2025)都拿不到 —— 原本規劃的路整條走不通。
//
// 所以回頭找已經在用、而且不需要大量請求的來源。Understat 是最有希望的:
// 倉庫裡的球隊進球情境就是從它來的,而且已經核對過(Arsenal 五類相加等於總進球)。
// 問題是**球員層級的整季數據在哪個端點**。
//
// CLAUDE.md 記著一個親自踩過的坑:曾經因為 understat.com/team/{隊}/{年}(HTML 頁)
// 解析不到東西就斷言「拿不到」,實際上資料在 getTeamData/{隊}/{年} 這個獨立 JSON。
// 所以這支同時試 HTML 頁與幾個 JSON 端點候選,**照實回報哪個通、哪個不通**,
// 不預設答案。
//
// 一共最多 6 個請求,單線,每個之間隔 1.5 秒 —— 使用者明確要求不要大量抓取。
const SEASON = 2025;                 // Understat 用開季年份;2025 = 2025-26
const DELAY = 1500;
const MAX_REQUESTS = 6;

const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = t => console.log(`\n${'─'.repeat(72)}\n▶ ${t}`);
let used = 0;

async function get(url, { json = false, method = 'GET', body = null } = {}) {
  if (used >= MAX_REQUESTS) { console.log(`  (已達 ${MAX_REQUESTS} 個請求上限,略過)`); return null; }
  if (used) await sleep(DELAY);
  used++;
  try {
    const res = await fetch(url, {
      method, body,
      signal: AbortSignal.timeout(20000),
      headers: {
        accept: json ? 'application/json, text/javascript, */*; q=0.01' : 'text/html,*/*',
        referer: 'https://understat.com/league/La_liga/2025',
        'user-agent': UA,
        ...(json ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      },
    });
    // 不要叫 body —— 那是上面的參數名,函式內再 const 一次會蓋掉它並掉進 TDZ,
    // 每一個請求都變成「Cannot access 'body' before initialization」,
    // 而且錯誤被 catch 吃掉之後看起來像對方擋我們。這個坑踩過一次就夠了。
    const text = await res.text();
    console.log(`  [${used}/${MAX_REQUESTS}] ${url}\n      → HTTP ${res.status}・${text.length} 位元組`);
    return { status: res.status, body: text };
  } catch (e) {
    // 失敗不退回計數:請求可能已經送到對方那裡了,寧可高估也不要低估
    console.log(`  [!] ${url}\n      → ${e.message}`);
    return null;
  }
}

/* Understat 把資料塞在 `var X = JSON.parse('\x22...\x22')` 裡。
   先把有哪些變數列出來 —— 這一步才是重點:知道頁面到底端了什麼上來,
   而不是猜某個變數名該不該存在。 */
const varsIn = html => [...html.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*JSON\.parse/g)].map(m => m[1]);

function decodeVar(html, name) {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*JSON\\.parse\\('([^']+)'\\)`);
  const m = html.match(re);
  if (!m) return null;
  try { return JSON.parse(JSON.parse(`"${m[1].replace(/\\x/g, '\\u00')}"`)); } catch { return null; }
}

const fields = row => Object.entries(row ?? {})
  .map(([k, v]) => `${k}=${JSON.stringify(v)}`.slice(0, 46)).join('  ');

async function main() {
  line(`1. Understat 聯賽頁 —— 球員整季資料在不在這一頁裡`);
  const page = await get(`https://understat.com/league/La_liga/${SEASON}`);
  let found = false;
  if (page?.status === 200) {
    const names = varsIn(page.body);
    console.log(`  頁面裡的資料變數:${names.length ? names.join('、') : '(找不到)'}`);
    for (const n of names) {
      const data = decodeVar(page.body, n);
      const rows = Array.isArray(data) ? data : Object.values(data ?? {});
      console.log(`  · ${n}:${Array.isArray(data) ? '陣列' : '物件'} ${rows.length} 筆`);
      if (rows.length && typeof rows[0] === 'object') console.log(`      欄位:${Object.keys(rows[0]).join(', ')}`);
    }
    if (names.includes('playersData')) {
      found = true;
      const players = decodeVar(page.body, 'playersData') ?? [];
      console.log(`\n  ✔ playersData 有 ${players.length} 名球員 —— 整個聯賽一季只要 1 個請求`);
      for (const p of players.slice(0, 3)) console.log(`      ${fields(p)}`);
    }
  }

  if (found) {
    line('2. 上一季也拿得到嗎(球員頁要做兩季就靠這個)');
    const prev = await get(`https://understat.com/league/La_liga/${SEASON - 1}`);
    if (prev?.status === 200) {
      const n = (decodeVar(prev.body, 'playersData') ?? []).length;
      console.log(`  ${SEASON - 1}-${String(SEASON).slice(2)}:${n} 名球員${n ? ' ✔' : ' —— 沒有'}`);
    }
    console.log('\n  結論:走 Understat 聯賽頁,一季 1 個請求,不需要逐隊或逐場抓。');
    console.log('  ⚠ 但界線要先講清楚:Understat 是 xG 統計站,沒有背號、沒有頭貼、');
    console.log('     沒有傷停,也沒有「本季至今」的即時更新頻率保證。');
    console.log('     這些欄位英超有、西甲沒有,前端要據實標示,不要留空欄位。');
    return;
  }

  /* 聯賽頁只端了 18 KB 的外殼、沒有任何資料變數 —— 跟球隊 HTML 頁一樣。
     這正是 CLAUDE.md 記著的那個坑:資料不在 HTML 裡,在獨立的 XHR 端點。
     所以往下試端點,而且**通不通都照實印**,不要第一個失敗就下結論。

     上一輪已經測出來:
       getLeaguePlayers/La_liga/2025 → 404(這個路由不存在)
       main/getPlayersStats/         → 200 {"error":{"error_code":4,"error_msg":""}}
     第二個是關鍵:**端點存在**,回的是結構化錯誤而不是 404,
     代表它只是少了參數。所以這一輪專門試參數形狀。 */
  line('2. main/getPlayersStats/ 的參數形狀(上一輪測出這個端點存在,只是少參數)');
  const body = o => new URLSearchParams(o).toString();
  const shapes = [
    ['POST league+season', { method: 'POST', body: body({ league: 'La_liga', season: String(SEASON) }) }],
    ['POST 加分頁與排序', { method: 'POST', body: body({ league: 'La_liga', season: String(SEASON), page: '1', order: 'goals', dir: 'desc' }) }],
    ['GET  query string', { query: `?league=La_liga&season=${SEASON}` }],
  ];
  for (const [label, opt] of shapes) {
    const r = await get(`https://understat.com/main/getPlayersStats/${opt.query ?? ''}`,
      { json: true, method: opt.method, body: opt.body });
    if (!r) continue;
    const head = r.body.trim();
    const ok = r.status === 200 && (head.startsWith('{') || head.startsWith('['));
    console.log(`      ${label} → ${ok ? '解析看看' : '不是 JSON'}`);
    if (!ok) continue;
    let j = null;
    try { j = JSON.parse(head); } catch { console.log('      (JSON 解析失敗)'); continue; }
    if (j.error) { console.log(`      ✗ error_code ${j.error.error_code}${j.error.error_msg ? ` ${j.error.error_msg}` : ''}`); continue; }
    const rows = Array.isArray(j) ? j : (j.response?.players ?? j.players ?? Object.values(j)[0]);
    if (Array.isArray(rows) && rows.length) {
      console.log(`      ✔✔ 拿到 ${rows.length} 筆`);
      console.log(`      欄位:${Object.keys(rows[0]).join(', ')}`);
      console.log(`      範例:${fields(rows[0])}`);
      return;
    }
    console.log(`      回傳頂層鍵:${Object.keys(j).join(', ')}`);
  }

  /* 最後一問,而且是最要緊的一問:getTeamData 現在還通不通?
     倉庫裡的球隊進球情境全靠它。如果連它都不通了,那不是「球員資料拿不到」,
     是 Understat 整個變了 —— 現有管線也要跟著檢討,不能只當成新功能做不成。 */
  line('3. 既有的 getTeamData 現在還通不通(倉庫裡的進球情境全靠它)');
  const team = await get(`https://understat.com/getTeamData/Barcelona/${SEASON}`, { json: true });
  if (team?.status === 200) {
    try {
      const d = JSON.parse(team.body);
      const sit = Object.keys(d?.statistics?.situation ?? {});
      console.log(`  ✔ 還通:statistics.situation 有 ${sit.join('、') || '(空)'}`);
      console.log('  → 那就只有球員層級拿不到,既有的球隊情境管線不受影響');
    } catch { console.log('  ⚠ 回了 200 但不是預期的 JSON —— 現有管線可能已經受影響,要追'); }
  } else {
    console.log('  ⚠ 連 getTeamData 都不通了 —— 這不只是新功能做不成,');
    console.log('     倉庫裡的球隊進球情境將來也重抓不了,要當成獨立問題處理');
  }

  console.log('\n  以上都不通的話,不要硬做 —— 照實寫進文件:');
  console.log('  試過哪些網址、各自回什麼,下一個人才不會重跑一遍同樣的死路。');
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; })
  .finally(() => console.log(`\n${'─'.repeat(72)}\n共用掉 ${used} 個請求。`));
