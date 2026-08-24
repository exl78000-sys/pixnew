#!/usr/bin/env node
// 抓英超官方(pulselive)的正式陣容、陣型與現任教練 → data/raw/pulselive/official.json
//
//   npm run official                 只補缺的(正常排程用這個)
//   npm run official -- --managers   強制重抓教練名單
//   npm run official -- --all        重抓所有已完賽的陣容(第一次建檔用)
//
// 這是英超官網自己在用的後端,沒有金鑰、沒有公開文件。因此:
//   1. 抓到就存,存過就不再抓 —— 已完賽的陣容不會再變
//   2. 每次執行有請求上限,不會因為一次跑歪就狂打人家的伺服器
//   3. 全部失敗也無害 —— 上層拿不到官方資料就自動退回既有的角色推導
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { API, PL_HEADERS, findSeason, normaliseFormation, teamMap } from './lib/pulselive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'pulselive', 'official.json');
const has = k => process.argv.includes(`--${k}`);

// 存檔格式版本。改欄位就把它加一 —— 下次執行會自動重抓已存的場次,
// 不然舊檔會一直被當成「已經抓過」,新欄位永遠是空的。
// v2 是壞掉的那次寫進去的(升級檢查沒觸發,格式其實還是 v1),
// 所以要跳到 3 才推得動 —— 檔案裡已經寫著 2 了。
const STORE_VERSION = 3;

const MAX_DETAIL = has('all') ? 400 : 14;   // 每次執行最多抓幾場詳情
const SOON_MS = 3 * 60 * 60 * 1000;         // 開賽前 3 小時內就開始試(正式陣容約賽前 1 小時公布)
const MANAGER_TTL = 24 * 60 * 60 * 1000;

const j = async url => {
  const res = await fetch(url, { headers: PL_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(API, '')}`);
  return res.json();
};

// 官方的 lineup 一筆 → 我們要的形狀。名字、背號、場上位置都直接沿用官方的。
const person = p => ({
  // 兩個 id 都要:formation.players 的排位用的是 id,不是 playerId
  id: p.id ?? null,
  playerId: p.playerId || null,
  name: p.name?.display ?? null,
  shirt: p.matchShirtNumber ?? p.info?.shirtNum ?? null,
  pos: p.matchPosition ?? p.info?.position ?? null,
  posInfo: p.info?.positionInfo ?? null,
  captain: Boolean(p.captain),
});

const sideOf = tl => ({
  formation: normaliseFormation(tl.formation?.label),
  formationRaw: tl.formation?.label ?? null,
  rows: Array.isArray(tl.formation?.players) ? tl.formation.players : null,
  xi: (tl.lineup ?? []).map(person),
  subs: (tl.substitutes ?? []).map(person),
});

async function main() {
  const T = loadTeams(ROOT);
  // version 預設 null 而不是 STORE_VERSION —— 舊檔沒有這個鍵,展開時不會覆蓋掉預設值,
  // 預設就填新版號的話升級檢查永遠不會觸發(舊檔會被誤認為已是新版)
  let store = { version: null, season: null, teams: {}, managers: {}, managersFetchedAt: null, matches: {} };
  try { store = { ...store, ...JSON.parse(await readFile(OUT, 'utf8')) }; } catch { /* 第一次執行 */ }
  if (store.version !== STORE_VERSION) {
    console.log(`  存檔格式從 v${store.version ?? 1} 升到 v${STORE_VERSION},重抓所有場次的陣容`);
    store.matches = {};
    store.version = STORE_VERSION;
  }

  const season = await findSeason(j);
  console.log(`▶ 官方賽季:${season.label}(id ${season.id})`);
  if (store.season?.id !== season.id) {
    console.log('  賽季換了,重新建立隊伍對照與教練名單');
    store = { season, teams: {}, managers: {}, managersFetchedAt: null, matches: {} };
  }
  store.season = season;

  /* 1. 隊伍對照:官方 teamId → 我們的隊碼 */
  if (!Object.keys(store.teams).length) {
    const teams = await j(`${API}/compseasons/${season.id}/teams`);
    const { map, unmatched } = teamMap(teams, T);
    store.teams = map;
    console.log(`  隊伍對照 ${Object.keys(map).length}/20` + (unmatched.length ? `,對不上:${unmatched.join('、')}` : ''));
  }
  const codeOfTeamId = id => store.teams[String(id)] ?? null;

  /* 2. 現任教練:每天refresh 一次就夠,教練不會每 15 分鐘換一個 */
  const managersStale = !store.managersFetchedAt || Date.now() - Date.parse(store.managersFetchedAt) > MANAGER_TTL;
  if (has('managers') || managersStale) {
    let n = 0;
    for (const [tid, code] of Object.entries(store.teams)) {
      try {
        const staff = await j(`${API}/teams/${tid}/compseasons/${season.id}/staff`);
        const mgr = (staff.officials ?? []).find(o => o.role === 'Manager' && o.active !== false)
                 ?? (staff.officials ?? []).find(o => o.role === 'Manager');
        if (mgr) { store.managers[code] = { name: mgr.name?.display ?? null, officialId: mgr.officialId ?? mgr.id ?? null }; n++; }
      } catch (e) { console.log(`  ✗ 教練 ${code}:${e.message}`); }
    }
    store.managersFetchedAt = new Date().toISOString();
    console.log(`  教練名單:抓到 ${n}/20 隊`);
  }

  /* 3. 賽程:已完賽的補齊,即將開賽的試著抓正式陣容 */
  const fixtures = [];
  for (const q of [`statuses=C&sort=desc&pageSize=60`, `statuses=U,L&sort=asc&pageSize=20`]) {
    try {
      const r = await j(`${API}/fixtures?comps=1&compSeasons=${season.id}&page=0&${q}`);
      fixtures.push(...(r.content ?? []));
    } catch (e) { console.log(`  ✗ 賽程(${q}):${e.message}`); }
  }

  const now = Date.now();
  const wanted = [];
  for (const f of fixtures) {
    const home = codeOfTeamId(f.teams?.[0]?.team?.id), away = codeOfTeamId(f.teams?.[1]?.team?.id);
    if (!home || !away) continue;
    const key = `${home}|${away}`;
    const done = f.status === 'C';
    const cached = store.matches[key];
    // 已完賽且抓過先發 → 不用再抓。進行中/未開賽 → 只要還沒拿到陣容就再試。
    if (cached?.final && done && !has('all')) continue;
    if (cached && !done && cached.home?.xi?.length && cached.away?.xi?.length) continue;
    const ko = f.kickoff?.millis ?? f.provisionalKickoff?.millis ?? null;
    if (!done && (ko === null || ko - now > SOON_MS)) continue;   // 離開賽還早,陣容還沒出來
    wanted.push({ f, key, home, away, ko, done });
  }

  console.log(`  待抓詳情:${wanted.length} 場(本次上限 ${MAX_DETAIL})`);
  let got = 0, empty = 0;
  for (const w of wanted.slice(0, MAX_DETAIL)) {
    try {
      const d = await j(`${API}/fixtures/${w.f.id}`);
      const lists = d.teamLists ?? [];
      if (!lists.length) { empty++; continue; }        // 陣容還沒公布,下一輪再來
      const byTeam = new Map(lists.map(tl => [tl.teamId, tl]));
      const h = byTeam.get(w.f.teams[0].team.id), a = byTeam.get(w.f.teams[1].team.id);
      if (!h || !a) { empty++; continue; }
      store.matches[w.key] = {
        fixtureId: w.f.id,
        kickoff: w.ko ? new Date(w.ko).toISOString() : null,
        status: d.status ?? w.f.status,
        final: w.done,                                  // 已完賽 = 這筆定案,以後不用再抓
        home: sideOf(h), away: sideOf(a),
      };
      got++;
      console.log(`  ✔ ${w.key}  ${store.matches[w.key].home.formation ?? '?'} vs ${store.matches[w.key].away.formation ?? '?'}`);
    } catch (e) { console.log(`  ✗ ${w.key}:${e.message}`); }
  }

  store.fetchedAt = new Date().toISOString();
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(store, null, 1));
  const withF = Object.values(store.matches).filter(m => m.home.formation && m.away.formation).length;
  console.log(`\n✔ 已寫入 data/raw/pulselive/official.json`);
  console.log(`  本次新增 ${got} 場・陣容未公布 ${empty} 場・累計有官方陣型 ${withF} 場・教練 ${Object.keys(store.managers).length} 隊`);
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
