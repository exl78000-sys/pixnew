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
// v4:開始存進球事件(events)。
// v5:改用「比分變了就是進球」判定,不再只認 type==='G' —— 烏龍球不是 G。
// v6:除了進球,也存牌與換人(timelineOf)。升版會重抓所有場次的陣容與事件。
const STORE_VERSION = 6;

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

/* 進球事件。
   這是**零額外請求**的功能 —— 同一個 /fixtures/{id} 回應本來就帶著 events,
   我們以前只讀 teamLists 就把其餘欄位丟掉了。與其為了進球細節去一場一場
   重打人家的端點(一季 380 次),不如把已經拿在手上的東西存下來。

   官方的事件型別是代碼不是英文字:
     G  進球(description 是子類型,一般進球是 "G")
     B  出牌(description 是 Y / R)
     S  換人(description 是 ON / OFF)
     PS / PE  半場開始與結束
   所以不要用 /goal/i 去比對 type —— 那樣會一顆進球都找不到。

   assistId 是官方直接給的「這一球是誰助攻的」。FPL 只給「這場某人有 N 次助攻」,
   配不到是哪一球;官方這個欄位是唯一能把球與助攻配起來的來源。 */
export const minuteOf = label => {
  const m = /^(\d+)/.exec(String(label ?? ''));
  return m ? Number(m[1]) : null;
};

// 事件的先後順序。time.millis 是實際時鐘,最可靠;沒有就退回比賽進行秒數。
const seq = e => e.time?.millis ?? (Number(e.clock?.secs) || 0);

/* 怎麼判定一筆事件是進球:**比分變了就是進球**,而不是看 type === 'G'。

   一開始我是用 type 過濾的,結果對到真實資料就露餡了:
   Brighton 4-0 Aston Villa 只抓到 3 顆,少的第一顆是**烏龍球** ——
   烏龍球在官方的事件流裡不是 G,是另一種型別。只認 G 就會少算。

   比分差判定不需要事先知道所有型別代碼:官方每一筆事件都帶著當下比分
   (而且是該事件發生**之後**的比分,已用 FUL 2-3 CHE 的五顆進球逐筆核對過),
   所以只要比上一筆高,中間必然發生了一顆進球,不管它叫什麼名字。

   進哪一邊也由比分差決定,不看 teamId —— 烏龍球的 teamId 是踢進自家門的那一隊,
   拿它當得分方會把球算到錯的隊上。 */
export const goalsOf = events => {
  const all = (Array.isArray(events) ? events : []).slice().sort((a, b) => seq(a) - seq(b));
  const out = [];
  let ph = 0, pa = 0;
  for (const e of all) {
    const hs = e.score?.homeScore, as = e.score?.awayScore;
    if (hs == null || as == null) continue;
    if (hs > ph || as > pa) {
      out.push({
        side: hs > ph ? 'H' : 'A',          // 得分方,由比分差決定
        person: e.personId ?? null,
        assist: e.assistId ?? null,
        team: e.teamId ?? null,             // 烏龍球時這是「踢進自家門的那一隊」
        min: minuteOf(e.clock?.label),
        label: e.clock?.label ?? null,
        phase: e.phase ?? null,
        // type 與 description 都原封不動存,不自己翻譯 ——
        // 烏龍球與十二碼的代碼還沒集滿,等資料累積直接統計就知道,不要現在猜。
        type: e.type ?? null,
        kind: e.description ?? null,
        hs, as,
      });
    }
    ph = hs; pa = as;
  }
  return out;
};

/* 牌、換人與半場標記。**進球不在這裡** —— 它由 goalsOf 用「比分變了」判定,
   比看 type === 'G' 可靠(烏龍球不是 G)。要組完整時間軸就把兩者合起來排序。

   兩個刻意的設計:

   1. **換人不配對「誰換誰」。** 官方的事件流**沒有任何欄位**把 ON 與 OFF 連起來,
      而同一分鐘可以有兩組換人 —— 實測 FUL vs CHE 第 65 分鐘同一隊一次換兩人,
      四筆事件的 time.millis 完全相同。照相鄰順序配對就是猜,而**配錯人比不配對糟得多**
      (租借姓名那條坑講過)。所以只給「第幾分、哪一隊、誰上、誰下」,不宣稱誰替誰。
   2. **沒見過的代碼不分類。** 目前見過的只有 Y 與 R,而且 **R 是核對過才放行的**:
      2026-27 第 1 輪 BHA vs AVL 第 40 分有一筆 R,拿 FPL 的逐球員資料獨立核對 ——
      FPL 說 AVL 的 Gomes 紅牌 1、上場 39 分,兩邊指的是同一個人同一件事。
      第三種代碼出現時 kind 會是 null、原碼留在 kindRaw,測試會紅,先核對過才放行。
      (這跟進球子類型的做法一致:已見過 G / P / O,第四種出現就擋。)

   ── 一個會讓人以為資料錯的差異(拿兩邊對牌數之前一定要知道)──
   **FPL 會把被罰下者的黃牌吞掉。** 同一場 BHA vs AVL:官方事件流有 5 張黃 + 1 張紅,
   FPL 只有 4 張黃 + 1 張紅 —— 少的正是 Gomes 自己 9 分鐘那張(FPL 記他「黃 0 紅 1」)。
   所以每有一個人被罰下,兩邊的黃牌數就會差 1。那不是資料錯,是兩邊的記法不同。 */
export const CARD_KINDS = { Y: '黃牌', R: '紅牌' };
export const SUB_DIRS = { ON: 'on', OFF: 'off' };

export function timelineOf(events) {
  const all = (Array.isArray(events) ? events : []).slice().sort((a, b) => seq(a) - seq(b));
  const cards = [], subs = [], periods = [];
  for (const e of all) {
    const base = {
      person: e.personId ?? null, team: e.teamId ?? null,
      min: minuteOf(e.clock?.label), label: e.clock?.label ?? null, phase: e.phase ?? null,
    };
    if (e.type === 'B') {
      cards.push({ ...base, kindRaw: e.description ?? null, kind: CARD_KINDS[e.description] ?? null });
    } else if (e.type === 'S') {
      subs.push({ ...base, dirRaw: e.description ?? null, dir: SUB_DIRS[e.description] ?? null });
    } else if (e.type === 'PS' || e.type === 'PE') {
      /* 半場起訖。PE 的 label 帶補時(45+3\'00),那是唯一能講出
         「上半場踢了幾分鐘補時」的來源,而且時間軸要靠它分段。 */
      periods.push({ type: e.type, ...base, person: undefined, team: undefined });
    }
  }
  return { cards, subs, periods };
}

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
    /* 已完賽且抓過先發 → 不用再抓(那筆定案了)。
       **進行中的一律再抓** —— 原本這裡是「有陣容就跳過」,而陣容賽前一小時就有了,
       於是整場比賽都不會再更新,進球、牌與換人要等完賽才一次補上。
       比賽日的迴圈每 2 分鐘叫一次這支,就是為了拿這些事件;跳過等於那一步白跑。
       進行中的場次最多 10 場,一次 10 個請求,跟迴圈本來就在打的是同一個端點。
       未開賽 → 只要還沒拿到陣容就再試。 */
    if (cached?.final && done && !has('all')) continue;
    const live = f.status === 'L';
    if (cached && !done && !live && cached.home?.xi?.length && cached.away?.xi?.length) continue;
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
      const goals = goalsOf(d.events);
      const timeline = timelineOf(d.events);
      store.matches[w.key] = {
        fixtureId: w.f.id,
        kickoff: w.ko ? new Date(w.ko).toISOString() : null,
        status: d.status ?? w.f.status,
        final: w.done,                                  // 已完賽 = 這筆定案,以後不用再抓
        homeId: w.f.teams[0].team.id, awayId: w.f.teams[1].team.id,   // 事件的 teamId 要對回主客
        home: sideOf(h), away: sideOf(a),
        goals,
        /* 牌與換人。進球不放這裡 —— 它由 goalsOf 用「比分變了」判定,
           比看 type === 'G' 可靠(烏龍球不是 G)。畫面上要組時間軸時把兩者合起來排序。 */
        timeline,
        clock: d.clock?.label ?? null,     // 官方的比賽鐘,含 45+3 這種補時寫法
      };
      got++;
      const gTxt = goals.length ? `・${goals.length} 顆進球` : '';
      console.log(`  ✔ ${w.key}  ${store.matches[w.key].home.formation ?? '?'} vs ${store.matches[w.key].away.formation ?? '?'}${gTxt}`);
    } catch (e) { console.log(`  ✗ ${w.key}:${e.message}`); }
  }

  store.fetchedAt = new Date().toISOString();
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(store, null, 1));
  const withF = Object.values(store.matches).filter(m => m.home.formation && m.away.formation).length;
  console.log(`\n✔ 已寫入 data/raw/pulselive/official.json`);
  console.log(`  本次新增 ${got} 場・陣容未公布 ${empty} 場・累計有官方陣型 ${withF} 場・教練 ${Object.keys(store.managers).length} 隊`);
}

/* 只有直接執行才跑主流程。
   goalsOf 等純函式要能被 npm test 匯入驗證 —— 沒有這個守衛的話,
   光是 import 就會去打官方端點(而且在沙箱裡必定 403)。 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
}
