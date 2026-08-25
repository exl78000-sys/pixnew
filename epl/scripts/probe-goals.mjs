#!/usr/bin/env node
// 探測「進球細節」能拿到什麼 —— 使用者問的是:
//   每季進球數、對哪隊進的、怎麼進的(運動戰/角球/任意球)、
//   助攻數與誰助攻、先發進球 vs 替補進球。
//
// 有些能從現有資料算,有些要看上游給不給。這支只回答「上游給不給」,
// 而且是**實測**,不是猜 —— 沙箱連不到外網,所以由 runner 執行。
//
//   npm run probe:goals
//
// 要確認三件事:
//   1. 英超官方(pulselive)的單場詳情裡有沒有 events(進球、助攻、時間、方式)
//   2. vaastav 的 FPL 鏡像有沒有「逐輪 × 逐球員」的歷史檔(過去賽季的逐場數據)
//   3. FPL 官方 API 的 element-summary 有沒有逐場歷史
const UA = 'pl-war-room/1.0 (football analysis side project)';
const PL = { Origin: 'https://www.premierleague.com', Referer: 'https://www.premierleague.com/', 'User-Agent': UA };
const API = 'https://footballapi.pulselive.com/football';

const get = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  return { ok: res.ok, status: res.status, ct: res.headers.get('content-type') ?? '', res };
};
const head = (s, n = 400) => String(s).slice(0, n).replace(/\s+/g, ' ');
const line = t => console.log(`\n${'─'.repeat(70)}\n▶ ${t}`);

/* ── 1. 英超官方單場詳情 ────────────────────────────── */
async function pulselive() {
  line('英超官方 (pulselive):單場詳情裡有沒有進球事件');
  // 先找一場已完賽的比賽
  const comps = await get(`${API}/competitions/1/compseasons`, PL);
  if (!comps.ok) { console.log(`  ✗ compseasons HTTP ${comps.status}`); return; }
  const seasons = (await comps.res.json()).content ?? [];
  const s = seasons[0];
  console.log(`  賽季:${s?.label}(id ${s?.id})`);

  const fx = await get(`${API}/fixtures?comps=1&compSeasons=${s.id}&statuses=C&page=0&pageSize=3&sort=desc`, PL);
  if (!fx.ok) { console.log(`  ✗ fixtures HTTP ${fx.status}`); return; }
  const list = (await fx.res.json()).content ?? [];
  if (!list.length) { console.log('  ✗ 這個賽季還沒有已完賽的比賽'); return; }

  const f = list[0];
  const name = `${f.teams?.[0]?.team?.name} vs ${f.teams?.[1]?.team?.name}`;
  console.log(`  取樣:${name}(fixture ${f.id})`);

  const d = await get(`${API}/fixtures/${f.id}`, PL);
  if (!d.ok) { console.log(`  ✗ fixtures/${f.id} HTTP ${d.status}`); return; }
  const j = await d.res.json();
  console.log(`  頂層欄位:${Object.keys(j).join(', ')}`);

  // events 是關鍵 —— 進球、助攻、時間、方式如果有,會在這裡
  const ev = j.events ?? j.matchEvents ?? null;
  if (!Array.isArray(ev)) {
    console.log('  ✗ 沒有 events 陣列 → 官方這個端點不給進球事件');
  } else {
    console.log(`  ✔ events:${ev.length} 筆`);
    const types = [...new Set(ev.map(e => e.type))];
    console.log(`    事件型別:${types.join(', ')}`);
    const goals = ev.filter(e => /goal/i.test(e.type ?? ''));
    console.log(`    進球類事件:${goals.length} 筆`);
    for (const g of goals.slice(0, 4)) console.log(`    · ${head(JSON.stringify(g), 320)}`);
    // 助攻是否單獨成一種事件、或掛在進球上
    console.log(`    第一筆事件全文:${head(JSON.stringify(ev[0]), 400)}`);
  }

  // 有些版本把統計放在 teams[].stats,順便看一眼有沒有 goal type 的彙總
  const stats = j.teams?.[0]?.stats ?? j.stats ?? null;
  if (stats) {
    const names = (Array.isArray(stats) ? stats : Object.keys(stats)).slice(0, 40);
    console.log(`  隊伍統計欄位(前 40):${head(JSON.stringify(names), 600)}`);
  }
}

/* ── 2. vaastav FPL 鏡像的逐輪歷史檔 ────────────────── */
async function vaastavGws() {
  line('vaastav / Fantasy-Premier-League:有沒有逐輪 × 逐球員的歷史檔');
  const base = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';
  for (const season of ['2024-25', '2025-26', '2026-27']) {
    for (const path of [`${season}/gws/merged_gw.csv`, `${season}/gws/gw1.csv`]) {
      const r = await get(`${base}/${path}`);
      if (!r.ok) { console.log(`  ✗ ${path} → HTTP ${r.status}`); continue; }
      const text = await r.res.text();
      const rows = text.split('\n');
      const cols = rows[0].split(',');
      console.log(`  ✔ ${path} → ${rows.length - 1} 列、${cols.length} 欄`);
      // 只列跟這次問題有關的欄位
      const want = cols.filter(c => /goal|assist|minute|start|opponent|was_home|round|team|penal|own/i.test(c));
      console.log(`    相關欄位:${want.join(', ')}`);
      if (path.includes('merged')) console.log(`    全部欄位:${head(cols.join(', '), 900)}`);
      break;   // 同一季找到一個就夠
    }
  }
}

/* ── 3. FPL 官方 API 的逐場歷史 ─────────────────────── */
async function fplSummary() {
  line('FPL 官方 API:element-summary 的逐場歷史');
  const b = await get('https://fantasy.premierleague.com/api/bootstrap-static/');
  if (!b.ok) { console.log(`  ✗ bootstrap HTTP ${b.status}`); return; }
  const boot = await b.res.json();
  // 挑一個進球最多的人來看
  const top = [...boot.elements].sort((a, c) => c.goals_scored - a.goals_scored)[0];
  console.log(`  取樣:${top.web_name}(id ${top.id},本季 ${top.goals_scored} 球)`);
  const r = await get(`https://fantasy.premierleague.com/api/element-summary/${top.id}/`);
  if (!r.ok) { console.log(`  ✗ element-summary HTTP ${r.status}`); return; }
  const j = await r.res.json();
  console.log(`  頂層欄位:${Object.keys(j).join(', ')}`);
  if (j.history?.length) {
    console.log(`  ✔ history:${j.history.length} 場`);
    console.log(`    欄位:${head(Object.keys(j.history[0]).join(', '), 900)}`);
    const scored = j.history.find(h => h.goals_scored > 0) ?? j.history[0];
    console.log(`    範例:${head(JSON.stringify(scored), 700)}`);
  }
  if (j.history_past?.length) {
    console.log(`  ✔ history_past(往季彙總):${j.history_past.length} 季`);
    console.log(`    欄位:${Object.keys(j.history_past[0]).join(', ')}`);
  }
}

for (const fn of [pulselive, vaastavGws, fplSummary]) {
  try { await fn(); } catch (e) { console.log(`  ✗ 例外:${e.message}`); }
}
console.log(`\n${'─'.repeat(70)}\n完成。`);
