/* 歐冠賽後報告:FotMob 逐場詳情 → 三個聯賽在用的同一份 MatchReport 契約。**跨聯賽一份。**
 *
 * 為什麼有這一支(2026-09-11,使用者問「歐冠沒有賽完紀錄可以看?」):
 * 歐冠踢完之後畫面上只剩比分 —— `ucl.json` 來自 football-data.org 的賽事端點(賽果 + 積分榜),
 * 本來就只有那些。但「沒抓」不等於「拿不到」:`probe-ucl-matchdetails.mjs`(run 34607062325)實測
 * FotMob 歐冠(聯賽 id 42,走 allLeagues 目錄用名字找到的,不是猜的)的單場詳情有三個聯賽在用的
 * **同一組欄位**:球隊統計、逐射門 xG、正式名單、事件、逐人評分;三場的逐射門進球數全部對得回比分,
 * 比分跟 football-data 交叉核對 4/4 一致。
 *
 * 接法 —— **全部沿用,不另寫一套**:
 *   抓取  `scripts/game/fetch-fotmob-epl.mjs --league=ucl`(三個聯賽同一支抓取器,多一個 `ucl` 參數組)
 *   讀取  `lib/matchstats.mjs` 的 loadFotmobMatchStats(比分對回本站賽果才收,對不上整場退回)
 *   轉換  `toCanonicalDetail`(烏龍球 team 語意那條坑它已經處理)
 *   報告  `lib/postmatch-report.mjs` 的 buildProviderMatchReport(再核對一次比分、要求 coverage 齊全)
 *
 * 跟三個聯賽不同的只有兩件事,都在這裡處理:
 *
 *   1. **隊伍身分是 football-data 的 team id(字串),不是隊碼。** 歐冠 36 隊裡本站只有 8~11 支有隊碼,
 *      其餘沒有 —— 編一個隊碼等於替它們造一個身分(鐵則三)。所以 results / raw / 報告的 home、away
 *      一律是 `String(fdId)`,名字另外帶(`names`),前端用名字畫、用 id 查。
 *   2. **xG 只有一種算法:逐射門加總。** FotMob 同時給球隊層 xG 與逐射門 xG,兩者不完全一樣
 *      (西甲逐場比對 41 場有 5 場差到 0.37)。同一個賽事兩種算法而且只對其中一種說明出處,
 *      是本站最不該有的東西。這裡一律用逐射門加總,而且**只在射門圖完整時給**(進球數對得回比分);
 *      不完整的場次 xG 是 null,畫面講「這場射門圖不完整」,不退回供應商的球隊 xG 湊數。
 *
 * 產物分兩層(索引小、逐場大):
 *   `ucl-details.json`                 索引:哪幾場有報告、比分、xG、拒收與不完整的清單(幾 KB)
 *   `ucl-details/{季}/{fd 比賽 id}.json` 逐場報告(一場約 60 KB),前端點開才載 —— 一季 144 + 45 場
 *                                      全塞進一個檔會到 10 MB,盃賽頁每個讀者都要付這筆錢。
 * 兩個 build(英超、西甲)各呼叫一次同一個函式寫進各自的目錄;跟 ucl.json 同一個規矩。
 *
 * 拒收與不完整**要進產物**(`rejected` / `incomplete`):依設計不採用之後什麼都不留的話,
 * 讀者看到踢完的比賽沒有報告而畫面不解釋,測試也分不出「依設計拒收」與「管線壞了」。
 */
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uclSeasonMatches } from './ucl-elo.mjs';
import { loadFotmobMatchStats, toCanonicalDetail } from './matchstats.mjs';
import { buildProviderMatchReport } from './postmatch-report.mjs';

export const UCL_RAW_DIR = 'fotmob-ucl';
export const UCL_DETAILS_DIR = 'ucl-details';

const r2 = n => Math.round(n * 100) / 100;

/* 一季的歐冠場次 → 逐場抓取器與讀取器共用的 results 形狀(跟三個聯賽的 results.json 同形:
   season / date / home / away / fh / fa / played)。**聯賽階段與淘汰賽都收**:上游把同一種東西放在
   `leagueMatches` 與 `rounds[].ties[].legs[]` 兩個地方,走整份收一次(uclSeasonMatches),不列舉區塊 ——
   列舉的話以後多一個區塊就會有一批比賽靜靜掉隊(跨聯賽評分的橋就是這樣少了 45 場)。

   比分只讀 `final`(分段欄位不是累計值,本站在歐冠決賽上踩過)。PK 收場的 `final` 是延長後的平手比分,
   跟 FotMob 的 scoreStr 同一個語意(盃賽探測過),所以比分核對照常做。 */
export function uclResultsOf(season) {
  if (!season || season.availability !== 'available') return [];
  return uclSeasonMatches(season).map(m => ({
    id: m.id, season: season.label,
    date: String(m.kickoff ?? '').slice(0, 10), kickoff: m.kickoff ?? null,
    stage: m.stage ?? null, matchday: m.matchday ?? null,
    home: String(m.home.id), away: String(m.away.id),
    homeName: m.home.name ?? m.home.fullName, awayName: m.away.name ?? m.away.fullName,
    homeFullName: m.home.fullName, awayFullName: m.away.fullName,
    homeCode: m.home.code ?? null, awayCode: m.away.code ?? null,
    homeLeague: m.home.league ?? null, awayLeague: m.away.league ?? null,
    fh: Array.isArray(m.final) ? m.final[0] : null, fa: Array.isArray(m.final) ? m.final[1] : null,
    played: m.played === true && Array.isArray(m.final),
    pens: Array.isArray(m.pens) && m.pens.length ? m.pens : null,
  })).filter(r => r.date && r.home !== 'undefined' && r.away !== 'undefined');
}

/* xG 一種算法(見檔頭第 2 點):射門圖完整才給逐射門加總,否則 null。供應商的球隊 xG 不用。 */
function withShotXg(detail, ms) {
  const ready = ms.shotmapComplete === true && Array.isArray(ms.shots) && ms.shots.length > 0;
  const sum = code => r2(ms.shots.filter(s => s.team === code).reduce((a, s) => a + (Number(s.xg) || 0), 0));
  const teamStats = Object.fromEntries(Object.entries(detail.teamStats ?? {})
    .map(([code, t]) => [code, { ...(t ?? {}), xG: ready ? sum(code) : null }]));
  return { ...detail, teamStats, xgSource: ready ? 'shotmap' : null };
}

const coverageGap = detail => Object.entries(detail?.coverage ?? {})
  .filter(([k, v]) => ['teamStatistics', 'playerStatistics', 'ratings', 'events', 'lineups'].includes(k) && !v)
  .map(([k]) => k);

/* 主函式。回傳 `{ index, files }`:index 是小索引(寫成 ucl-details.json),files 是逐場報告
   (Map:相對路徑 → 報告物件),由 writeUclDetails 落地。裡面**沒有 build 時間戳** —— 兩個 build
   要寫出同一份;retrievedAt 是 raw 的抓取時間,兩邊讀同一個檔所以一樣。 */
export function uclDetails(root, ucl) {
  const seasons = (ucl?.seasons ?? []).filter(s => s.availability === 'available');
  const results = seasons.flatMap(uclResultsOf);
  const stats = loadFotmobMatchStats(root, { results, rawDir: UCL_RAW_DIR });

  const rawDir = join(root, 'data', 'raw', UCL_RAW_DIR);
  let retrievedAt = null, cached = 0;
  /* 抓取器退回的場次(store.attempts:FotMob 標未完賽、比分不符、賽程找不到…)也要進產物 ——
     它們不在 store.matches 裡,所以 loadFotmobMatchStats 的 rejected 看不到它們;不帶出來的話
     畫面只能講「還沒抓到」,而其中一種(比分不符)是永遠抓不到的。 */
  const attempts = [];
  if (existsSync(rawDir)) {
    for (const f of readdirSync(rawDir).filter(x => /-game-details\.json$/.test(x))) {
      try {
        const store = JSON.parse(readFileSync(join(rawDir, f), 'utf8'));
        cached += Object.keys(store.matches ?? {}).length;
        if (store.updatedAt && (!retrievedAt || store.updatedAt > retrievedAt)) retrievedAt = store.updatedAt;
        for (const [pair, a] of Object.entries(store.attempts ?? {})) {
          attempts.push({ key: `${store.season}|${pair}`, label: a.label ?? pair, reason: a.reason ?? null, at: a.at ?? null });
        }
      } catch { /* 壞掉的快取當成沒有;rejected 那邊不會有它,count 對不上就看得出來 */ }
    }
  }

  const index = {
    source: 'FotMob matchDetails', retrievedAt,
    /* 前端的說明文字照這兩個欄位講,不要在前端寫死 */
    xg: 'shotmap', xgNote: '逐射門 xG 加總;只在射門圖的進球數對得回比分時給,否則留空',
    count: 0, cached, seasons: {}, reports: {}, incomplete: [], rejected: stats.rejected,
    /* 抓取器層退回的(見上面);跟 rejected(讀取器層)分開列,兩層的原因不同 */
    attempts,
  };
  const files = new Map();

  for (const season of seasons) {
    const rows = results.filter(r => r.season === season.label);
    const names = {};
    for (const r of rows) { names[r.home] = r.homeName; names[r.away] = r.awayName; }
    const nameOf = id => names[id] ?? String(id);
    let n = 0;
    for (const r of rows) {
      if (!r.played) continue;
      const key = `${r.season}|${r.home}|${r.away}`;
      const ms = stats.matches[key];
      if (!ms) continue;                       // 還沒抓到,或已被 loadFotmobMatchStats 退回(在 rejected 裡)
      const detail = { ...withShotXg(toCanonicalDetail(ms), ms), kickoff: r.kickoff };
      const report = buildProviderMatchReport({
        fixture: { season: r.season, home: r.home, away: r.away, fh: r.fh, fa: r.fa, played: true, kickoff: r.kickoff },
        detail, nameOf,
      });
      if (!report) {
        index.incomplete.push({ id: r.id, key, missing: coverageGap(detail), reason: coverageGap(detail).length ? '供應商這場缺了一部分資料' : '比分或主客對不上' });
        continue;
      }
      // 前端用名字畫、用 id 查;報告的 home/away 是 fd id 字串(見檔頭第 1 點)
      report.id = r.id; report.stage = r.stage; report.matchday = r.matchday;
      report.names = { [r.home]: r.homeName, [r.away]: r.awayName };
      report.codes = { [r.home]: r.homeCode, [r.away]: r.awayCode };
      report.leagues = { [r.home]: r.homeLeague, [r.away]: r.awayLeague };
      report.shotmapComplete = ms.shotmapComplete === true;
      files.set(`${season.label}/${r.id}.json`, report);
      index.reports[String(r.id)] = {
        season: season.label, date: r.date, stage: r.stage, matchday: r.matchday,
        home: r.home, away: r.away, score: [r.fh, r.fa],
        xG: [report.actual?.xGHome ?? null, report.actual?.xGAway ?? null],
        shotmapComplete: ms.shotmapComplete === true,
      };
      n++;
    }
    index.seasons[season.label] = { reports: n, played: rows.filter(r => r.played).length };
    index.count += n;
  }
  return { index, files };
}

/* 逐場報告落地:**先清掉再寫**,報告被退回時舊檔才不會留在站上。只碰 `{季}/{數字}.json` 這種
   自己寫的檔名 —— 目錄是產物專用的,但還是不要 rm 一個可能有別人東西的地方(vault 那條規矩)。 */
export function writeUclDetails(outDir, { files }) {
  const dir = join(outDir, UCL_DETAILS_DIR);
  if (existsSync(dir)) {
    for (const season of readdirSync(dir)) {
      const sd = join(dir, season);
      if (!/^\d{4}-\d{2}$/.test(season)) continue;
      for (const f of readdirSync(sd)) if (/^\d+\.json$/.test(f)) rmSync(join(sd, f));
      if (!readdirSync(sd).length) rmSync(sd, { recursive: true });
    }
  }
  let bytes = 0;
  for (const [rel, report] of files) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    const s = JSON.stringify(report);
    writeFileSync(p, s);
    bytes += s.length;
  }
  return { files: files.size, kb: Math.round(bytes / 1024) };
}
