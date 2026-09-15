/* 英格蘭盃賽(足總盃、聯賽盃)的賽後報告:FotMob 逐場詳情 → 站上同一份 MatchReport 契約。
 *
 * 為什麼有這一支(2026-09-13):歐冠單場頁做完之後,盃賽是唯一還沒有單場頁的賽事 ——
 * 而原因不是前端,是**沒有逐場詳情**。前兩輪探測(9/07、9/08)只看了 `header.status`
 * 的 PK 比數與勝方,沒看 `content` 裡有什麼。`probe-fotmob-cups.mjs --only=report`
 * (2026-09-13)補完那一問,四場跨三個分級全部有 `stats` / `shotmap` / `lineup` /
 * `matchFacts.events` / `playerStats`,射門圖四場全完整(進球數對得回比分)。
 *
 * 接法全部沿用,不另寫一套(跟歐冠 `lib/ucl-details.mjs` 同一條路):
 *   抓取  `scripts/game/fetch-fotmob-epl.mjs --league=facup|eflcup`(同一支抓取器多兩組參數)
 *   讀取  `lib/matchstats.mjs` 的 loadFotmobMatchStats
 *   轉換  `toCanonicalDetail`(烏龍球 team 語意那條坑它已經處理)
 *   報告  `lib/postmatch-report.mjs` 的 buildProviderMatchReport
 *
 * 跟歐冠不同的有四件事,都在這裡處理:
 *
 *   1. **隊伍身分是「隊碼,沒有隊碼就 `fm{FotMob id}`」。** 盃賽的對手一半不在本站的三個聯賽裡
 *      (足總盃第一輪是第三、四級球隊互打),替它們編一個隊碼等於造一個身分(鐵則三)。
 *      `cups.json` 本來就是這樣畫的(有 code 用隊徽與連結,沒有就用名字 + `crests[sourceId]`),
 *      所以這裡沿用同一個規矩,名字另外帶(`names`)。
 *
 *   2. **比分核對不是獨立來源。** `cups.json` 的賽果本身就是 FotMob 的賽程端點,
 *      所以「逐場詳情的比分對回本站賽果」在盃賽是**同一家供應商的一致性檢查**,
 *      不是鐵則五的獨立核對 —— 它擋得住「抓錯場次」,擋不住「供應商自己記錯」。
 *      這件事要寫進產物(`scoreCheck.independent: false`)讓畫面講得出來,
 *      不可以跟三個聯賽(openfootball / football-data 對照)混成一句「已核對」。
 *      2026-09-02 以前的場次倉庫裡有 SportMonks 舊快取可以當獨立來源,之後沒有。
 *
 *   3. **配對鍵是比賽 id,不是「主|客」,也不是「主|客|日期」。** 盃賽有重賽,
 *      而且同一季可能同一組主客踢兩次(英冠附加賽與歐冠那兩條坑的盃賽版);
 *      而 `cups.json` 每一場本來就帶 FotMob 的比賽 id,那是唯一的 —— 直接用它最安全。
 *      附帶的好處:抓取器不必再打一次賽程端點去查 matchId(cups 的快取裡就有)。
 *
 *   4. **PK 大戰的互射十二碼要排掉。** 盃賽的 PK 比三個聯賽多得多,而 FotMob 的射門圖
 *      把互射也列進去(歐冠決賽那條坑)。探測確認每一顆射門都有 `period`,
 *      PK 那場 46 顆裡 8 顆是 `PenaltyShootout` —— 所以 `isShootoutShot` 用 period 就分得開,
 *      不必退回「分鐘 ≥ 120」那條推路。`pens` 要帶到 detail 與報告給前端的射門圖用。
 *
 * ── 球員榜(2026-09-15)──
 * 逐場詳情裡本來就有雙方的逐人統計,累加規則跟歐冠 / 英冠共用(`lib/season-players.mjs`)。
 * 盃賽有三件事跟聯賽不一樣,都量過:
 *   · **互射十二碼不會算進進球**:40 場踢到 PK 的比賽逐場核對,球員進球 + 烏龍球 100% 對得回
 *     正規 + 延長的比分。(射門圖**會**把互射列進去,那是另一回事,`isShootoutShot` 處理。)
 *   · **低分級的場次常常沒有逐人統計**:足總盃 117 場裡只有 81 場有(缺的都是第三、四級互打),
 *     聯賽盃 155 場全有。這個涵蓋率要寫進產物讓畫面講,不能只給一個榜就當作全都涵蓋了。
 *   · **評分榜的門檻不能用聯賽那個 2**:淘汰制底下 1,597 人裡 1,044 人只踢一場,
 *     門檻 2 會讓踢兩場的人排在整個賽事第一。這裡用 3(門檻印在榜的標題上)。
 * 而**比分核對仍然不是獨立來源**(見上面第 2 點),所以球員榜的說明要照著講,不要升級成「已核對」。
 *
 * 產物分兩層(跟歐冠同一個規矩:索引小、逐場大):
 *   `cup-details.json`                     索引:哪幾場有報告、比分、xG、拒收與不完整的清單
 *   `cup-details/{盃賽}/{季}/{比賽 id}.json` 逐場報告(一場約 60 KB),前端點開才載
 * 只寫英超目錄 —— `cups.json` 就是跨聯賽一份放在 pl(三個聯賽的盃賽頁都從 pl 載),這份照它。
 *
 * 拒收與不完整**要進產物**(`rejected` / `incomplete` / `attempts`):依設計不採用之後
 * 什麼都不留的話,讀者看到踢完的比賽沒有報告而畫面不解釋,測試也分不出
 * 「依設計拒收」與「管線壞了」。
 */
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFotmobMatchStats, toCanonicalDetail, isShootoutShot } from './matchstats.mjs';
import { buildProviderMatchReport, FULL_COVERAGE } from './postmatch-report.mjs';
import { aggregatePlayers, leadersFrom } from './season-players.mjs';

/* 兩個盃賽:key 要跟 `cups.json` 的 `cups[].key` 一樣(前端用它查),
   FotMob 的聯賽 id 是抓賽事 logo 時實證過的(132 = FA Cup、133 = EFL Cup)。 */
export const FOTMOB_CUP_DETAILS = [
  { key: 'facup', zh: '足總盃', id: 132, rawDir: 'fotmob-facup' },
  { key: 'eflcup', zh: '聯賽盃', id: 133, rawDir: 'fotmob-eflcup' },
];
export const CUP_DETAILS_DIR = 'cup-details';
export const CUPS_RAW_DIR = 'fotmob-cups';

const r2 = n => Math.round(n * 100) / 100;

/* 評分榜要出賽幾場才列。**這個數字是從場次分布挑的,不是憑感覺**:
   足總盃 2025-26 的 1,597 人裡 1,044 人只踢一場、324 人踢兩場 —— 門檻 2 等於把「踢了兩場手感好」
   當成整個賽事最好的球員。3 場代表他至少撐過兩輪。門檻會印在榜的標題與說明上。 */
const CUP_RATING_MIN = 3;

/* 隊伍身分:有隊碼用隊碼,沒有就 `fm{FotMob id}`。**一個函式決定**,抓取器與 build 都叫它 ——
   兩邊各寫一份的話,raw 的鍵跟讀取時算出來的鍵會對不上,而症狀是「抓了卻沒有報告」。 */
export const cupTeamId = side => (side?.code ? String(side.code)
  : side?.sourceId != null ? `fm${side.sourceId}` : null);

/* 一個盃賽的快取 → results 形狀(跟三個聯賽的 results.json 同形:season / date / home / away / fh / fa / played)。
   比分只讀 `final`(分段欄位不是累計值,本站在歐冠決賽上踩過);PK 收場的 final 是延長後的平手比分,
   跟 FotMob 詳情的 scoreStr 同一個語意(探測過),所以比分核對照常做。 */
export function cupResultsOf(store, skipped = null) {
  const out = [];
  for (const s of store?.seasons ?? []) {
    for (const m of s.matches ?? []) {
      const home = cupTeamId(m.home), away = cupTeamId(m.away);
      const date = String(m.kickoff ?? '').slice(0, 10);
      /* 算不出身分或沒有日期的場次會在這裡被丟掉 —— 目前一場都沒有(288 場全部算得出來),
         但盃賽的抽籤會有「對手待定」,而**靜靜丟掉**就會讓「已完賽 N 場、報告 M 場」
         中間那個差額沒有人解釋得出來。所以呼叫端可以給一個陣列把它們收走。 */
      if (!home || !away || !m.id || !date) {
        if (skipped) skipped.push({ id: m.id ?? null, season: s.label,
          reason: !date ? '沒有開球日期' : !m.id ? '沒有比賽 id' : '算不出隊伍身分(沒有隊碼也沒有 FotMob id)' });
        continue;
      }
      out.push({
        id: String(m.id), matchId: String(m.id), season: s.label,
        date, kickoff: m.kickoff ?? null,
        stage: m.stage ?? null, roundKey: m.roundKey ?? null,
        home, away,
        // 鍵就是比賽 id(見檔頭第 3 點):盃賽有重賽,主|客 不唯一
        pair: String(m.id),
        homeName: m.home?.name ?? m.home?.shortName ?? home,
        awayName: m.away?.name ?? m.away?.shortName ?? away,
        homeCode: m.home?.code ?? null, awayCode: m.away?.code ?? null,
        homeSourceId: m.home?.sourceId ?? null, awaySourceId: m.away?.sourceId ?? null,
        fh: Array.isArray(m.final) ? m.final[0] : null,
        fa: Array.isArray(m.final) ? m.final[1] : null,
        played: m.played === true && Array.isArray(m.final),
        pens: Array.isArray(m.pens) && m.pens.length ? m.pens : null,
        aet: m.aet === true,
      });
    }
  }
  return out;
}

export function readCupStore(root, key) {
  const p = join(root, 'data', 'raw', CUPS_RAW_DIR, `${key}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/* xG 一種算法(跟歐冠同一條):射門圖完整才給逐射門加總,否則 null。供應商的球隊 xG 不拿來湊。 */
function withShotXg(detail, ms) {
  const ready = ms.shotmapComplete === true && Array.isArray(ms.shots) && ms.shots.length > 0;
  const sum = code => r2(ms.shots
    .filter(s => s.team === code && !isShootoutShot(s, { pens: ms.pens }))
    .reduce((a, s) => a + (Number(s.xg) || 0), 0));
  const teamStats = Object.fromEntries(Object.entries(detail.teamStats ?? {})
    .map(([code, t]) => [code, { ...(t ?? {}), xG: ready ? sum(code) : null }]));
  return { ...detail, teamStats, xgSource: ready ? 'shotmap' : null, pens: ms.pens === true };
}

const coverageGap = detail => FULL_COVERAGE.filter(k => !detail?.coverage?.[k]);

/* 盃賽的最低要求是這三塊。缺 playerStatistics / ratings 仍然出報告,缺的記在 `partial` 上。
   **為什麼不是五塊**:足總盃第一、二輪有 42 場上游只缺逐人那兩塊(英甲對英乙那種場次),
   球隊統計、射門圖、事件與名單全都在 —— 丟掉等於讓 42 場踢過的比賽什麼都沒有。 */
const CUP_REQUIRED = ['teamStatistics', 'events', 'lineups'];
const ZH_BLOCK = { playerStatistics: '逐人統計', ratings: '逐人評分', teamStatistics: '球隊統計', events: '事件', lineups: '正式名單' };

/* 抓取器層退回的場次(FotMob 標未完賽、比分不符…)。它們不在 store.matches 裡,
   所以讀取器的 rejected 看不到 —— 不帶出來的話畫面只能講「還沒抓到」,
   而其中一種(比分不符)是永遠抓不到的。 */
function attemptsOf(root, rawDir) {
  const dir = join(root, 'data', 'raw', rawDir);
  const out = [];
  let retrievedAt = null, cached = 0;
  if (!existsSync(dir)) return { attempts: out, retrievedAt, cached };
  for (const f of readdirSync(dir).filter(x => /-game-details\.json$/.test(x))) {
    try {
      const store = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      cached += Object.keys(store.matches ?? {}).length;
      if (store.updatedAt && (!retrievedAt || store.updatedAt > retrievedAt)) retrievedAt = store.updatedAt;
      for (const [pair, a] of Object.entries(store.attempts ?? {})) {
        out.push({ key: `${store.season}|${pair}`, label: a.label ?? pair, reason: a.reason ?? null, at: a.at ?? null });
      }
    } catch { /* 壞掉的快取當成沒有;count 對不上就看得出來 */ }
  }
  return { attempts: out, retrievedAt, cached };
}

/* 主函式。回傳 `{ index, files }`:index 寫成 `cup-details.json`,
   files 是 Map(相對路徑 → 報告物件),由 writeCupDetails 落地。
   裡面沒有 build 時間戳 —— retrievedAt 來自 raw,這樣同一份 raw 產出的索引逐位元組相同。 */
export function cupDetails(root) {
  const index = {
    source: 'FotMob matchDetails',
    xg: 'shotmap',
    xgNote: '逐射門 xG 加總;只在射門圖的進球數對得回比分時給,否則留空',
    /* 鐵則五的誠實話:盃賽的賽果本身就是 FotMob,所以比分核對只是同一家供應商的一致性檢查。
       畫面要照這個欄位講,不要跟三個聯賽的獨立核對混成一句「已核對」。 */
    scoreCheck: {
      independent: false,
      note: '盃賽的賽程與賽果也來自 FotMob,所以逐場詳情的比分核對是同一家供應商的一致性檢查'
        + '(擋得住抓錯場次,擋不住供應商自己記錯)。2026-09-02 以前的場次另有 SportMonks 舊快取逐場對過。',
    },
    retrievedAt: null, count: 0, cached: 0,
    cups: {}, reports: {}, incomplete: [], rejected: [], attempts: [], missing: [],
    /* 球員榜(逐場逐人統計累加)。一個盃賽一季一筆,含涵蓋率與被排除的場次 —— 榜單本身很小,
       **不放全部球員**:淘汰制底下八成的人只踢一場,一張 1,700 人的表是雜訊不是資料。 */
    players: {},
    /* 連 results 那一層都進不去的場次(身分或日期算不出來)。目前是空的,
       但不收著的話那種場次會從「已完賽 N 場」的分母裡靜靜消失。 */
    skipped: [],
  };
  const files = new Map();

  for (const cup of FOTMOB_CUP_DETAILS) {
    const store = readCupStore(root, cup.key);
    if (!store) { index.missing.push({ cup: cup.key, reason: '倉庫沒有這個盃賽的賽程快取(先跑 cups:fetch)' }); continue; }
    const skipped = [];
    const results = cupResultsOf(store, skipped);
    const stats = loadFotmobMatchStats(root, { results, rawDir: cup.rawDir });
    const { attempts, retrievedAt, cached } = attemptsOf(root, cup.rawDir);
    index.cached += cached;
    if (retrievedAt && (!index.retrievedAt || retrievedAt > index.retrievedAt)) index.retrievedAt = retrievedAt;
    for (const a of attempts) index.attempts.push({ cup: cup.key, ...a });
    for (const r of stats.rejected) index.rejected.push({ cup: cup.key, ...r });

    const seasons = {};
    for (const r of results) {
      if (!r.played) continue;
      (seasons[r.season] ??= { played: 0, reports: 0 }).played++;
      const key = `${r.season}|${r.pair}`;
      const ms = stats.matches[key];
      if (!ms) continue;                      // 還沒抓到,或已被讀取器退回(在 rejected 裡)
      const names = { [r.home]: r.homeName, [r.away]: r.awayName };
      const detail = { ...withShotXg(toCanonicalDetail(ms), ms), kickoff: r.kickoff };
      const report = buildProviderMatchReport({
        fixture: { season: r.season, home: r.home, away: r.away, fh: r.fh, fa: r.fa, played: true, kickoff: r.kickoff },
        detail, nameOf: id => names[id] ?? String(id), require: CUP_REQUIRED,
      });
      if (!report) {
        const gap = coverageGap(detail);
        const core = CUP_REQUIRED.filter(k => !detail?.coverage?.[k]);
        index.incomplete.push({ cup: cup.key, id: r.id, key, missing: gap,
          reason: core.length ? `供應商這場缺了必要的資料(${core.map(k => ZH_BLOCK[k] ?? k).join('、')})` : '比分或主客對不上' });
        continue;
      }
      /* 缺了哪幾塊(非必要的那幾塊)要帶到報告與索引 —— 畫面照它講,
         不是讓讀者自己發現「怎麼沒有球員評分卡」。 */
      const partial = coverageGap(detail);
      if (partial.length) report.partial = partial.map(k => ({ key: k, zh: ZH_BLOCK[k] ?? k }));
      report.id = r.id; report.cup = cup.key; report.stage = r.stage; report.roundKey = r.roundKey;
      report.names = names;
      report.codes = { [r.home]: r.homeCode, [r.away]: r.awayCode };
      report.sourceIds = { [r.home]: r.homeSourceId, [r.away]: r.awaySourceId };
      report.shotmapComplete = ms.shotmapComplete === true;
      report.pens = r.pens;          // 比數本身(畫面要印「PK 4-2」),不是布林
      report.aet = r.aet === true;
      files.set(`${cup.key}/${r.season}/${r.id}.json`, report);
      index.reports[String(r.id)] = {
        cup: cup.key, season: r.season, date: r.date, stage: r.stage,
        home: r.home, away: r.away, score: [r.fh, r.fa],
        pens: r.pens, aet: r.aet === true,
        xG: [report.actual?.xGHome ?? null, report.actual?.xGAway ?? null],
        shotmapComplete: ms.shotmapComplete === true,
        partial: report.partial ?? null,
      };
      seasons[r.season].reports++;
      index.count++;
    }
    /* 球員榜:一季一份。teamNames / teamCodes 從 results 來(逐場詳情的隊鍵是 `fm{id}` 或隊碼) */
    {
      const bySeason = {};
      for (const m of Object.values(stats.matches)) (bySeason[m.season] ??= []).push(m);
      /* 身分**在這裡決定一次**,前端不要自己從 `fm12345` 這種鍵反推 —— 隊徽與連結要的是
         `{ code, sourceId, name }` 這個形狀(cups.json 的球隊格就是它),前端照它畫就好。
         (跟「跨聯賽的東西不能有『目前聯賽』這個隱含參數」同一條:身分收在一個地方。) */
      const nameOf = {}, sideOf = {};
      for (const r of results) {
        nameOf[r.home] = r.homeName; nameOf[r.away] = r.awayName;
        sideOf[r.home] = { code: r.homeCode ?? null, sourceId: r.homeSourceId ?? null, name: r.homeName };
        sideOf[r.away] = { code: r.awayCode ?? null, sourceId: r.awaySourceId ?? null, name: r.awayName };
      }
      for (const [season, ms] of Object.entries(bySeason)) {
        const rows = ms.slice().sort((a, b) => String(a.key).localeCompare(String(b.key))).map(m => {
          /* 「有逐人統計」= 至少有一個人真的上場過。供應商對低分級的場次常常只給空名單,
             而空名單跟「這一場沒有人上場」長得一樣 —— 所以看的是分鐘,不是陣列長度。 */
          const has = m.players && Object.values(m.players).some(l => l?.some(p => Number.isFinite(p.minutes) && p.minutes > 0));
          return has
            ? { key: m.key, home: m.home, away: m.away, players: m.players, events: m.events ?? [], shots: m.shots ?? [], score: m.score, shotmapComplete: m.shotmapComplete }
            : { key: m.key, skip: '供應商沒有這一場的逐人統計' };
        });
        const agg = aggregatePlayers(rows, { teamNames: nameOf });
        if (!agg.reconciled) continue;
        const noData = agg.excluded.filter(e => /沒有這一場的逐人統計/.test(e.reason));
        const mismatched = agg.excluded.filter(e => !/沒有這一場的逐人統計/.test(e.reason));
        const boards = leadersFrom(agg, { minMatches: CUP_RATING_MIN });
        const teams = {};
        for (const b of boards) for (const r of b.rows) teams[r.teamId] = sideOf[r.teamId] ?? { code: null, sourceId: null, name: r.team };
        (index.players[cup.key] ??= {})[season] = {
          matches: ms.length, withPlayers: agg.matches, reconciled: agg.reconciled,
          xgComplete: agg.xgComplete, pool: agg.players.length,
          noPlayerData: noData.length, mismatched, cardsUnmatched: agg.cardsUnmatched,
          ratingMin: CUP_RATING_MIN, boards, teams,
        };
      }
    }
    index.cups[cup.key] = { zh: cup.zh, leagueId: cup.id, seasons };
    for (const x of skipped) index.skipped.push({ cup: cup.key, ...x });
  }
  return { index, files };
}

/* 逐場報告落地:**先清掉再寫**,報告被退回時舊檔才不會留在站上。
   只碰自己寫的那幾層(`{盃賽}/{季}/{數字}.json`)—— 目錄是產物專用的,
   但還是不要 rm 一個可能有別人東西的地方(vault 那條規矩)。 */
export function writeCupDetails(outDir, { files }) {
  const dir = join(outDir, CUP_DETAILS_DIR);
  if (existsSync(dir)) {
    for (const cup of readdirSync(dir)) {
      if (!FOTMOB_CUP_DETAILS.some(c => c.key === cup)) continue;   // 不是我們寫的就不碰
      const cd = join(dir, cup);
      for (const season of readdirSync(cd)) {
        if (!/^\d{4}-\d{2}$/.test(season)) continue;
        const sd = join(cd, season);
        for (const f of readdirSync(sd)) if (/^\d+\.json$/.test(f)) rmSync(join(sd, f));
        if (!readdirSync(sd).length) rmSync(sd, { recursive: true });
      }
    }
  }
  let bytes = 0;
  for (const [rel, report] of files) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    const str = JSON.stringify(report);
    writeFileSync(full, str);
    bytes += str.length;
  }
  return { files: files.size, kb: Math.round(bytes / 1024) };
}
