#!/usr/bin/env node
// 探測 API-Football 的西甲球員資料 —— 動手寫抓取管線之前,先確定「真的拿得到什麼」。
//
//   npm run probe:laliga-players
//
// 為什麼要有這一支:CLAUDE.md 第四條 ——「不要憑印象斷言某個 API 有什麼欄位」。
// 沙箱連不到外網,所以這支是給 GitHub Actions 的 runner 跑的(probe-apis.yml)。
//
// **請求上限硬寫死 5 個**。這是使用者付費的額度,探測不該把它燒掉;
// 而且使用者明確要求過不要大量抓取,探測自己先違反就沒有說服力了。
//
// 要回答的五個問題:
//   1. 這把金鑰是什麼方案?今天還剩多少額度?(決定補抓要分幾天)
//   2. /fixtures 認得的西甲完賽場次有幾場、隊名對不對得上我們的隊碼?
//      —— 順便診斷「西甲賽後管線跑了但一場都沒存下來」是卡在哪裡。
//   3. /players?league=140&season=2026 有沒有整季彙總?幾頁?欄位長什麼樣?
//      —— 這是球員頁與 leaders 的關鍵路徑。
//   4. /players/squads?team=X 拿名單要幾個請求?比 /players 便宜嗎?
//   5. 上季(season=2025)在不在這個方案裡?
//      —— 英超球員頁是「本季 + 上季」兩套,西甲能不能比照要看這一題。
const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const LA_LIGA = 140;
const MAX_REQUESTS = 5;

let used = 0;
const line = t => console.log(`\n${'─'.repeat(72)}\n▶ ${t}`);

async function call(path) {
  if (used >= MAX_REQUESTS) {
    console.log(`  (已達 ${MAX_REQUESTS} 個請求上限,略過 ${path})`);
    return null;
  }
  used++;
  const r = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': KEY } });
  console.log(`  [${used}/${MAX_REQUESTS}] GET ${path} → HTTP ${r.status}`);
  if (!r.ok) { console.log(`  ✗ ${(await r.text()).slice(0, 200)}`); return null; }
  const j = await r.json();
  // API-Football 的錯誤是 200 + errors 物件,不是 HTTP 錯誤碼 —— 不看這個會以為成功了
  const errs = j.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
    console.log(`  ✗ errors: ${JSON.stringify(errs)}`);
    return null;
  }
  return j;
}

// 只印「欄位長什麼樣」,不印整包 —— 探測是要知道結構,不是要把資料搬回來
function shape(obj, prefix = '', depth = 0, out = []) {
  if (depth > 2 || obj == null) return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) shape(v, path, depth + 1, out);
    else if (Array.isArray(v)) out.push(`${path}[] (${v.length})`);
    else out.push(`${path} = ${JSON.stringify(v)}`);
  }
  return out;
}

async function main() {
  if (!KEY) {
    console.log('⚠ 沒有 API_FOOTBALL_KEY,整支略過。');
    console.log('  設定方式:repo → Settings → Secrets and variables → Actions');
    return;
  }

  line('1. 方案與今日額度');
  const status = await call('/status');
  if (status?.response) {
    const s = status.response;
    console.log(`  帳號:${s.account?.firstname ?? '?'} ${s.account?.lastname ?? ''}`.trim());
    console.log(`  方案:${s.subscription?.plan ?? '?'}・到期 ${s.subscription?.end ?? '?'}・啟用中 ${s.subscription?.active}`);
    console.log(`  今日請求:${s.requests?.current ?? '?'} / ${s.requests?.limit_day ?? '?'}`);
  }

  line('2. 西甲 2026-27 完賽場次(順便診斷賽後管線為何一場都沒存下來)');
  const fx = await call(`/fixtures?league=${LA_LIGA}&season=2026&status=FT-AET-PEN`);
  let sampleTeamId = null, sampleTeamName = null;
  if (fx) {
    console.log(`  API-Football 回報完賽 ${fx.results ?? fx.response?.length ?? 0} 場`);
    const rows = fx.response ?? [];
    if (rows.length) {
      const r0 = rows[0];
      sampleTeamId = r0.teams?.home?.id;
      sampleTeamName = r0.teams?.home?.name;
      console.log(`  第一場:${r0.teams?.home?.name} ${r0.goals?.home}-${r0.goals?.away} ${r0.teams?.away?.name}`
        + `(${r0.fixture?.date?.slice(0, 10)}・status ${r0.fixture?.status?.short})`);
      // 隊名寫法要拿去跟我們的對照表比 —— 對不上的話整條管線會靜靜地什麼都不做
      const names = [...new Set(rows.flatMap(r => [r.teams?.home?.name, r.teams?.away?.name]))].filter(Boolean);
      console.log(`  出現過的隊名(${names.length}):${names.join('、')}`);
    } else {
      console.log('  ⚠ 一場都沒有 —— 這就是賽後管線抓不到東西的原因,不是程式的問題');
    }
  }

  line('3. /players 整季彙總(球員頁與 leaders 的關鍵路徑)');
  const p1 = await call(`/players?league=${LA_LIGA}&season=2026&page=1`);
  if (p1) {
    console.log(`  本頁 ${p1.results ?? 0} 人・共 ${p1.paging?.total ?? '?'} 頁 → 全部抓完約需 ${p1.paging?.total ?? '?'} 個請求`);
    const one = p1.response?.[0];
    if (one) {
      console.log(`  範例:${one.player?.name}(${one.statistics?.[0]?.team?.name})`);
      console.log('  player 欄位:');
      for (const l of shape(one.player)) console.log(`    ${l}`);
      console.log('  statistics[0] 欄位:');
      for (const l of shape(one.statistics?.[0])) console.log(`    ${l}`);
      console.log(`  statistics 陣列長度 ${one.statistics?.length}`
        + '(轉隊的人會有多筆,每隊一筆 —— 加總前要先確認這件事)');
    }
  }

  line('4. /players/squads 名單(比 /players 便宜嗎?)');
  if (sampleTeamId) {
    const sq = await call(`/players/squads?team=${sampleTeamId}`);
    const team = sq?.response?.[0];
    if (team) {
      console.log(`  ${sampleTeamName}:${team.players?.length ?? 0} 人 / 1 個請求 → 20 隊約 20 個請求`);
      console.log('  players[0] 欄位:');
      for (const l of shape(team.players?.[0])) console.log(`    ${l}`);
      console.log('  ⚠ 注意:名單端點通常只有背號/年齡/位置,沒有整季統計。');
      console.log('     要進球助攻等數字還是得走 /players,兩者不是替代關係。');
    }
  } else console.log('  (拿不到球隊 id,略過)');

  line('5. 上季 2025-26 在不在這個方案裡');
  const last = await call(`/players?league=${LA_LIGA}&season=2025&page=1`);
  if (last) {
    console.log(`  可用:本頁 ${last.results ?? 0} 人・共 ${last.paging?.total ?? '?'} 頁`);
    console.log('  → 球員頁可以比照英超做「本季 + 上季」兩套');
  } else {
    console.log('  → 拿不到。球員頁就只做本季,並在畫面上寫明原因,不要留空欄位');
  }

  console.log(`\n${'─'.repeat(72)}\n共用掉 ${used} 個請求。`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
