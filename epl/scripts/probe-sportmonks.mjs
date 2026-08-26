#!/usr/bin/env node
// 探測 SportMonks —— 接進 build 之前先確認「這個訂閱到底拿得到什麼」。
//
//   npm run probe:sportmonks
//
// 為什麼一定要先跑這支:上一次接 API-Football 的教訓。
// 規劃時假設「有金鑰就拿得到球員名單」,實際跑下去才發現那是 Free 方案、
// 只開放 2022–2024,本季與上季**完全拿不到**,整條路報廢。
// 而且更糟的是:它回 HTTP 200 加一個 errors 物件,排程每天照跑、每天回報成功,
// 實際一筆都沒抓到,畫面上還寫著「尚待快取」。
//
// 所以這支的第一優先不是「有什麼欄位」,而是:
//   **這個訂閱涵蓋哪些聯賽、哪些賽季?本季在不在裡面?**
// 這一題答錯,後面全部白做。
//
// 要回答的五個問題(對應目前真的缺的東西):
//   1. 金鑰有效嗎?方案與額度是什麼?
//   2. 訂閱涵蓋哪些聯賽?英超(EPL)與西甲(La Liga)在不在?
//   3. 那些聯賽有哪些賽季?**2026-27 本季拿得到嗎?**
//   4. 單場能不能拿到 lineups / formation / events / statistics
//      → 這是西甲戰術頁的瓶頸(shapes 與 lineups 目前是空的)
//   5. 有沒有 Understat 給不了的:背號、頭貼、傷停
//      → 這是「增加資訊」的實際內容
//
// 請求上限硬寫死。探測不該把別人的額度燒掉,而且使用者明確要求過不要大量抓取。
const TOKEN = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_KEY || process.env.SPORTMONKS_API_KEY;
const BASE = 'https://api.sportmonks.com/v3';
const MAX_REQUESTS = 12;
const DELAY = 400;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = t => console.log(`\n${'─'.repeat(72)}\n▶ ${t}`);
let used = 0;

/* 回傳 { status, json, error } —— 三者分開。
   error 是「對方明講的錯誤」,跟連不上不是同一件事;
   分不開的話會像 API-Football 那次一樣,把「方案不含」誤判成「暫時失敗」而一直重試。 */
async function get(path, { label = '' } = {}) {
  if (used >= MAX_REQUESTS) { console.log(`  (已達 ${MAX_REQUESTS} 個請求上限,略過 ${path})`); return null; }
  if (used) await sleep(DELAY);
  used++;
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}api_token=${TOKEN}`;
  const shown = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { accept: 'application/json' },
    });
    const text = await res.text();
    console.log(`  [${used}/${MAX_REQUESTS}] ${shown}\n      → HTTP ${res.status}・${text.length} 位元組${label ? `  (${label})` : ''}`);
    let json = null;
    try { json = JSON.parse(text); } catch { console.log(`      ✗ 不是 JSON:${text.slice(0, 120)}`); return { status: res.status, json: null, error: 'not-json' }; }
    // 403 是「被拒絕」(方案不含 / 沒權限),404 才是「這筆資料不存在」—— 兩者不要混
    if (json.message && !json.data) {
      console.log(`      ✗ ${res.status === 403 ? '被拒絕' : '訊息'}:${String(json.message).slice(0, 180)}`);
      return { status: res.status, json, error: json.message };
    }
    return { status: res.status, json, error: null };
  } catch (e) {
    console.log(`  [!] ${shown}\n      → ${e.message}`);
    return null;
  }
}

// 只印欄位名與少量樣本 —— 探測是要知道結構,不是把資料搬回來
const keysOf = o => (o && typeof o === 'object' ? Object.keys(o) : []);
const brief = (o, n = 5) => keysOf(o).slice(0, n).map(k => {
  const v = o[k];
  const s = v === null ? 'null' : Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' ? '{…}' : JSON.stringify(v);
  return `${k}=${String(s).slice(0, 30)}`;
}).join('  ');

async function main() {
  if (!TOKEN) {
    console.log('⚠ 沒有 SPORTMONKS_TOKEN,整支略過。');
    console.log('  設定方式:repo → Settings → Secrets and variables → Actions → New repository secret');
    console.log('  名稱填 SPORTMONKS_TOKEN,值貼金鑰。本機測試用 export SPORTMONKS_TOKEN=xxxx');
    return;
  }

  /* ── 1. 金鑰與方案 ──────────────────────
     先確認金鑰有效。這裡也順便看額度 —— 決定將來排程能跑多密。
     端點名稱不確定的就多試幾個候選,通不通都照實印,不預設答案。 */
  line('1. 金鑰是否有效、方案與額度');
  for (const p of ['/my/usage', '/my/resources', '/my/enrichments']) {
    const r = await get(p);
    if (r?.json?.data) {
      const d = r.json.data;
      console.log(`      ✔ ${p} 可用,頂層鍵:${keysOf(Array.isArray(d) ? d[0] : d).join(', ')}`);
      if (Array.isArray(d)) console.log(`        共 ${d.length} 筆,第一筆:${brief(d[0], 8)}`);
      else console.log(`        ${brief(d, 8)}`);
      break;
    }
  }
  if (used) {
    // rate limit 通常在回應的 rate_limit 區塊,不在 header —— 順手印出來
    const r = await get('/football/leagues?per_page=1', { label: '順便看 rate_limit' });
    if (r?.json?.rate_limit) console.log(`      額度:${JSON.stringify(r.json.rate_limit)}`);
    if (r?.json?.subscription) console.log(`      訂閱:${JSON.stringify(r.json.subscription).slice(0, 400)}`);
  }

  /* ── 2. 訂閱涵蓋哪些聯賽 ──────────────────
     這是 API-Football 那次沒問、結果整條路報廢的問題。
     免費/入門方案通常只含少數幾個聯賽,英超與西甲多半要付費。 */
  line('2. 訂閱涵蓋哪些聯賽(英超與西甲在不在?)');
  const leagues = await get('/football/leagues?per_page=100');
  const rows = leagues?.json?.data ?? [];
  let epl = null, laliga = null;
  if (rows.length) {
    console.log(`      可存取 ${rows.length} 個聯賽:`);
    for (const l of rows) console.log(`        ${String(l.id).padStart(5)}  ${l.name}${l.country_id ? `  (country ${l.country_id})` : ''}`);
    const find = re => rows.find(l => re.test(String(l.name ?? '')));
    epl = find(/premier\s*league/i);
    laliga = find(/la\s*liga|laliga|primera/i);
    console.log(`\n      英超:${epl ? `id ${epl.id}(${epl.name})✔` : '**不在訂閱裡**'}`);
    console.log(`      西甲:${laliga ? `id ${laliga.id}(${laliga.name})✔` : '**不在訂閱裡**'}`);
    global.__VERDICT = [(epl || laliga)
      ? `聯賽:${[epl && '英超', laliga && '西甲'].filter(Boolean).join('與')}都在訂閱裡(共 ${rows.length} 個聯賽)`
      : '聯賽:英超與西甲**都不在**訂閱裡 → 這個訂閱對本專案沒用,先別接'];
    if (!epl && !laliga) {
      console.log('\n      ⚠ 兩個都不在 —— 那這個訂閱對本專案沒有用,先不要接。');
      console.log('        要接的話得先升級到含英超/西甲的方案。');
    }
  }

  /* ── 3. 賽季 ──────────────────────────
     **最關鍵的一題。** API-Football 就是死在這裡:聯賽在、賽季不在。 */
  const target = laliga ?? epl;
  if (target) {
    line(`3. ${target.name} 有哪些賽季?本季(2026-27)拿得到嗎?`);
    const s = await get(`/football/seasons?filters=seasonLeagues:${target.id}&per_page=50`);
    const seasons = s?.json?.data ?? [];
    if (seasons.length) {
      const sorted = seasons.slice().sort((a, b) => String(b.name ?? '').localeCompare(String(a.name ?? '')));
      console.log(`      共 ${seasons.length} 季,最新五季:`);
      for (const x of sorted.slice(0, 5)) {
        console.log(`        ${String(x.id).padStart(6)}  ${x.name}${x.is_current ? '  ← 本季' : ''}${x.finished === false ? '  (進行中)' : ''}`);
      }
      const cur = sorted.find(x => x.is_current) ?? sorted[0];
      if (cur) global.__CURRENT_SEASON_ID = cur.id;
      // 已完結的賽季拿來取樣「單場能拿到多深」—— 那一季的比賽一定踢完了
      const done = sorted.find(x => x.id !== cur?.id && x.finished !== false);
      if (done) global.__DONE_SEASON_ID = done.id;
      console.log(`\n      → 本季 season id:${cur?.id ?? '找不到'}・已完結取樣季:${done?.id ?? '無'}(${done?.name ?? ''})`);
      (global.__VERDICT ??= []).push(cur?.is_current
        ? `賽季:本季 ${cur.name} **拿得到**(這是 API-Football 死掉的那一題)`
        : `賽季:最新只到 ${cur?.name ?? '?'},本季拿不到 → 跟 API-Football 同一個坑`);
    }
  }

  /* ── 4. 單場的深度 ────────────────────────
     這是西甲戰術頁的瓶頸:shapes 與 lineups 目前是空的,
     而 Understat 沒有逐場先發名單。SportMonks 給不給,決定戰術頁做不做得成。 */
  const seasonId = global.__CURRENT_SEASON_ID;
  const doneSeasonId = global.__DONE_SEASON_ID;
  if (seasonId) {
    /* 取樣一定要用**確定已完賽**的場次。
       第一輪踩到:用 per_page=1 拿到的是賽季第一場,lineups/events/statistics 全空 ——
       但那可能只是「還沒踢」,不是「方案不給」。兩者結論天差地遠,
       一個是「這條路能走」,一個是「整個白做」。所以改用已完結的上一季取樣。 */
    line('4. 單場能拿到多深?(lineups / formation / events / statistics)');
    const src = doneSeasonId ?? seasonId;
    const f = await get(`/football/fixtures?filters=fixtureSeasons:${src}&per_page=1`,
      { label: doneSeasonId ? '取樣自已完結的上一季' : '本季(可能還沒踢)' });
    const fx = f?.json?.data?.[0];
    if (fx) {
      console.log(`      取樣場次 id ${fx.id}:${brief(fx, 6)}`);
      console.log(`      state_id=${fx.state_id}  result_info=${JSON.stringify(fx.result_info)}  starting_at=${fx.starting_at}`);
      console.log('      ↑ result_info 有值 = 已完賽。空的話下面全空就只是「還沒踢」,不代表拿不到');
      const inc = 'lineups;lineups.player;formations;events;statistics;participants';
      const d = await get(`/football/fixtures/${fx.id}?include=${inc}`);
      const one = d?.json?.data;
      if (one) {
        console.log(`      include 之後的頂層鍵:${keysOf(one).join(', ')}`);
        for (const k of ['lineups', 'formations', 'events', 'statistics', 'participants']) {
          const v = one[k];
          if (Array.isArray(v) && v.length) {
            console.log(`      ✔ ${k}:${v.length} 筆 —— ${brief(v[0], 8)}`);
          } else {
            console.log(`      ✗ ${k}:${v == null ? '沒有這個欄位(include 可能不被方案允許)' : '空的'}`);
          }
        }
        const deep = ['lineups', 'formations'].filter(k => Array.isArray(one[k]) && one[k].length);
        (global.__VERDICT ??= []).push(deep.length === 2
          ? '單場深度:lineups 與 formations 都拿得到 → **西甲戰術頁的瓶頸解開了**'
          : deep.length
            ? `單場深度:只拿得到 ${deep.join('、')},另一個是空的`
            : (one.result_info
                ? '單場深度:已完賽場次仍拿不到 lineups/formations → 這個方案給不了,戰術頁另想辦法'
                : '單場深度:**無法判定** —— 取樣那場還沒踢完,空的很正常,要換一場已完賽的重測'));
      }
    }
  }

  /* ── 5. Understat 給不了的東西 ──────────────
     背號、頭貼、傷停 —— 這三樣是西甲球員頁現在明確標示「沒有」的。
     SportMonks 若有,那才是「增加資訊」的實際內容。 */
  if (target) {
    line('5. Understat 給不了的:背號、頭貼、傷停');
    const t = await get(`/football/teams/seasons/${seasonId ?? ''}?per_page=1`, { label: '球隊' });
    const team = t?.json?.data?.[0];
    if (team) {
      const sq = await get(`/football/squads/teams/${team.id}?include=player`);
      const row = sq?.json?.data?.[0];
      if (row) {
        console.log(`      ✔ 名單可用,欄位:${keysOf(row).join(', ')}`);
        console.log(`        ${brief(row, 10)}`);
        if (row.player) console.log(`        player 欄位:${keysOf(row.player).join(', ')}`);
        const has = k => (k in row) || (row.player && k in row.player);
        console.log(`        背號 jersey_number:${has('jersey_number') ? '✔' : '✗'}`);
        console.log(`        頭貼 image_path:${has('image_path') ? '✔' : '✗'}`);
        (global.__VERDICT ??= []).push(
          `球員欄位:背號 ${has('jersey_number') ? '✔' : '✗'}、頭貼 ${has('image_path') ? '✔' : '✗'}`
          + ' —— 這兩樣正是西甲球員頁現在標示「沒有」的');
      }
    }
    /* 傷停:第一輪 /football/injuries 回 404「The requested endpoint does not exist」。
       **404 不是 403** —— 404 是「這個路徑不存在」,403 才是「方案不含」。
       所以這是端點名字的問題,不是拿不到。列候選逐一試,通不通都照實印。
       (抓頭貼時就踩過把 403 當 404 的坑,反過來也一樣要小心) */
    let injOk = false;
    for (const path of ['/football/sidelined?per_page=1',
                        `/football/sidelined/teams/${team?.id ?? 0}`,
                        `/football/squads/teams/${team?.id ?? 0}?include=player.sidelined`]) {
      const r = await get(path, { label: '傷停候選' });
      const d = r?.json?.data;
      const row = Array.isArray(d) ? d[0] : d;
      if (row) {
        const inner = row.player?.sidelined?.[0] ?? row.sidelined?.[0] ?? row;
        console.log(`      ✔ 傷停可用 → ${path.split('?')[0]}`);
        console.log(`        欄位:${keysOf(inner).join(', ')}`);
        console.log(`        ${brief(inner, 8)}`);
        injOk = true;
        break;
      }
    }
    if (!injOk) console.log('      ✗ 以上候選都沒回傷停資料 —— 照實記錄,不要當成「一定拿不到」');
    (global.__VERDICT ??= []).push(injOk
      ? '傷停:拿得到 → 西甲可以補上「缺了多少戰力」,跟英超同級'
      : '傷停:試過的候選端點都沒回資料(第一輪的 /football/injuries 是 404,不是 403 —— 路徑問題不是權限問題)');
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`共用掉 ${used} 個請求。`);
  /* 判讀重點要**依實際結果產生**,不能寫死。
     第一輪就是寫死的,四行裡兩行跟實際結果相反 —— log 讀起來會誤導人,
     而 log 正是下一個人唯一看得到的東西。 */
  const verdict = global.__VERDICT ?? [];
  console.log('\n判讀(依這次實測產生,不是預先寫好的):');
  if (!verdict.length) console.log('  (沒有跑到結論 —— 看上面哪一步斷掉)');
  for (const v of verdict) console.log(`  · ${v}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
