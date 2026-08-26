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
const TOKEN = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_KEY;
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
      console.log(`\n      → 本季 season id:${cur?.id ?? '找不到'}`);
    }
  }

  /* ── 4. 單場的深度 ────────────────────────
     這是西甲戰術頁的瓶頸:shapes 與 lineups 目前是空的,
     而 Understat 沒有逐場先發名單。SportMonks 給不給,決定戰術頁做不做得成。 */
  const seasonId = global.__CURRENT_SEASON_ID;
  if (seasonId) {
    line('4. 單場能拿到多深?(lineups / formation / events / statistics)');
    const f = await get(`/football/fixtures?filters=fixtureSeasons:${seasonId}&per_page=1`);
    const fx = f?.json?.data?.[0];
    if (fx) {
      console.log(`      取樣場次 id ${fx.id}:${brief(fx, 6)}`);
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
      }
    }
    const inj = await get('/football/injuries?per_page=1', { label: '傷停' });
    if (inj?.json?.data?.length) {
      console.log(`      ✔ 傷停可用,欄位:${keysOf(inj.json.data[0]).join(', ')}`);
    } else if (inj) {
      console.log('      ✗ 傷停:這個方案拿不到(或端點名稱不同)');
    }
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`共用掉 ${used} 個請求。`);
  console.log('\n判讀重點(照上面的實測結果,不要憑印象):');
  console.log('  · 第 2 題兩個聯賽都不在 → 這個訂閱對本專案沒用,先別接');
  console.log('  · 第 3 題本季不在 → 跟 API-Football 同一個坑,只能拿歷史,不能拿本季');
  console.log('  · 第 4 題 lineups/formations 拿得到 → 西甲戰術頁的瓶頸解開了');
  console.log('  · 第 5 題背號/頭貼/傷停拿得到 → 這才是「增加資訊」的實際內容');
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
