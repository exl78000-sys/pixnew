#!/usr/bin/env node
/* 英冠(EFL Championship)資料集 → web/data/leagues/en2/
 *
 * ── 這個聯賽跟另外兩個不一樣的地方,先講清楚 ──
 *
 * 英冠**沒有球員層級的免費資料**:FPL 只有英超;Understat 只做歐洲五大聯賽,
 * 2026-08-28 實測 `POST /main/getPlayersStats/` 用 league=Championship /
 * EFL_Championship / English_Championship / ENG_Championship 四種寫法全部回
 * `{"success":true,"players":[]}`,而同一個請求 EPL 回 537 人、La_liga 回 600 人;
 * `getTeamData/{英冠球隊}/2025` 一律 404。**那是驗證過的否定,不是猜的**
 * (對照組跑得出資料,所以不是我端點打錯)。
 *
 * 所以這個聯賽做得出來的是「球隊與比賽」那一層。**整季的球員層**(逐輪出賽、整季 xG、傷停)仍然沒有;
 * 但**比賽層**從 2026-09-05 起有了:FotMob 的逐場資料(聯賽 id 48,跟英超西甲同一支抓取器)
 * 給控球、球隊統計、逐射門 xG、事件、正式名單與逐人評分,比分逐場對回本站賽果才收。
 * 於是賽後報告(reports.json)與球隊頁的逐場統計英冠也有 —— 不是「做不到」,是以前沒有去接。
 * 導覽列只掛做得出來的頁(core.js 的 LEAGUES.en2.open),
 * 其餘的頁網址仍然進得來,由 LeagueGap 講一句實話 —— 不是給一個空白頁。
 *
 * ── 兩個獨立來源 ──
 *   openfootball en.2.json    賽程骨架 + 賽果 + 半場 + 輪次 + 升級附加賽
 *   football-data.co.uk E1    賽果 + 逐場統計 + 賠率(獨立來源,用來核對與補缺)
 *
 * 兩份的重疊場次逐場核對走 lib/league-matches.mjs —— 跟西甲**同一份實作**:
 * 有一場不符就整份不採用。實測 2025-26 552 場全對、0 場不符,
 * 主來源目前沒有缺比分(不像西甲 2024-25 缺了最後一輪),所以補了 0 場。
 *
 *   npm run en2:build
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leagueMatches, backfillLine, europeanKickoff, fotmobBackfillLine } from './lib/league-matches.mjs';
import { buildLiveProviderReport, buildProviderMatchReport } from './lib/postmatch-report.mjs';
import { loadFotmobMatchStats, toCanonicalDetail } from './lib/matchstats.mjs';
import { attachNewsZh } from './lib/news-zh.mjs';
import { buildTeamMatchers, tagNewsTeams } from './lib/news-tag.mjs';
import { competition } from './lib/canonical.mjs';
import { loadTeams } from './lib/teams.mjs';
import { buildTable, headToHead, teamRecord, applyDeductions } from './lib/table.mjs';
import { teamMatchRows, styleTrendFor, attachTrendPercentiles, seasonRuler } from './lib/style-trend.mjs';
import { attachCareers } from './lib/coach-career.mjs';
import { attachProfiles } from './lib/coach-profiles.mjs';
import { attachScheduleStatus } from './lib/schedule-status.mjs';
import { fitPoisson, applyPromotedPrior, predict, strengthTable, simParams } from './lib/poisson.mjs';
import { buildElo, eloProbs, ELO_PARAMS } from './lib/elo.mjs';
import { simulateSeason } from './lib/simulate.mjs';
import { buildFormIndex, recentForm, formSummary, TUNED } from './lib/form.mjs';
import { upcomingOdds, seasonMarket, pickMarket } from './lib/odds.mjs';
import { pickPair, intoBand } from './lib/colour.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'data', 'leagues', 'en2');
const COMPETITION = 'eng.2';
const RAW_DIR = 'openfootball-championship';
const FILL_DIR = 'football-data-couk-championship';

const LAST_SEASON = '2025-26';
const CURRENT_SEASON = '2026-27';
const PRIOR_SEASONS = ['2023-24', '2024-25'];
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const AS_OF = arg('as-of') ?? new Date().toISOString().slice(0, 10);
const RUNS = Number(arg('runs') ?? 5000);

/* 英格蘭是 Europe/London:夏令 BST(+01:00)、冬令 GMT(+00:00)。
   adapter 的預設 kickoffOf 固定補 +01:00 —— 那是給西歐用的,
   照用的話冬季場次會整批早一小時。DST 規則共用 lib 那一份,不自己再寫。 */
const londonKickoff = europeanKickoff({ summer: '+01:00', winter: '+00:00' });

const write = async (name, data) => {
  await writeFile(join(OUT, `${name}.json`), JSON.stringify(data));
  console.log(`  ✓ ${name}.json`);
};

const slimMatch = m => {
  const out = {
    id: m.id, season: m.season, round: m.round, date: m.date,
    home: m.home, away: m.away, played: m.played, fh: m.fh, fa: m.fa,
  };
  if (m.hh !== null) { out.hh = m.hh; out.ha = m.ha; }
  if (m.kickoff) out.kickoff = m.kickoff;
  if (m.scoreProvisional) { out.scoreProvisional = true; out.scoreSource = m.scoreSource ?? 'fotmob'; }   // FotMob 暫定賽果(社群檔還沒到);provisional 這個名字西甲另有用途
  if (m.stage) out.stage = m.stage;
  if (m.scoreSource) out.scoreSource = m.scoreSource;
  return out;
};

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log(`▶ 建立英冠資料集(基準日 ${AS_OF},模擬 ${RUNS} 次)\n`);

  const T = loadTeams(ROOT, { file: 'teams-championship.json' });
  /* E1 的隊名是簡稱(Wolves、Sheffield Weds、QPR),跟 openfootball 的全名對不上。
     **不走 loadTeams 的寬鬆比對** —— 那條路徑會把 AFC 前綴之類的東西一起吃掉,
     本站在盃賽頁上被它咬過兩次。這裡有一張逐隊列出來的精確表(名冊的 fd 欄),
     對照怎麼來的見 data/manual/teams-championship.json 的 _note:
     不是用名字相似度,是用「比賽日期+比分」的指紋配出來的。 */
  const byFd = new Map(T.list.map(t => [t.fd, t.code]));
  const codeOf = name => byFd.get(name) ?? T.codeOf(name);

  // 隊徽:19 支在盃賽那份、5 支在英超那份,英冠自己不需要再抓一次
  const crestBy = new Map();
  {
    const pl = existsSync(join(ROOT, 'data', 'manual', 'crests.json'))
      ? JSON.parse(await readFile(join(ROOT, 'data', 'manual', 'crests.json'), 'utf8')).crests ?? {} : {};
    const cupsPath = join(ROOT, 'data', 'manual', 'crests-cups.json');
    const cups = existsSync(cupsPath) ? JSON.parse(await readFile(cupsPath, 'utf8')) : { crests: {}, sources: {} };
    const cupByName = new Map(Object.entries(cups.sources ?? {})
      .map(([id, v]) => [T.looseKey(v.name), cups.crests?.[id]]).filter(([, v]) => v));
    for (const t of T.list) {
      const c = pl[t.code] ?? cupByName.get(T.looseKey(t.en)) ?? cupByName.get(T.looseKey(t.of));
      if (c) crestBy.set(t.code, c);
    }
  }
  /* 人工交付的隊色、城市、球場、容量、綽號。**只讀核對後的產物**,不讀收件匣 ——
     直接讀收件匣等於把核對繞過去(比照租借那一條)。
     收件匣改過卻沒重跑核對時 sha 對不上,整批不掛並印出原因,不會拿舊的核對結果背書新內容。 */
  const delivered = new Map();
  let deliveryNote = null;
  {
    const vPath = join(ROOT, 'data', 'championship-teams-verified.json');
    const inboxPath = join(ROOT, 'data', 'manual', 'championship-teams-delivery.json');
    if (existsSync(vPath) && existsSync(inboxPath)) {
      const v = JSON.parse(await readFile(vPath, 'utf8'));
      const sha = createHash('sha256').update(await readFile(inboxPath)).digest('hex');
      if (!v.accepted) {
        deliveryNote = `球隊資料交付未通過核對(${v.problems.length} 項),整批不採用。`;
      } else if (v.inboxSha !== sha) {
        deliveryNote = '收件匣改過但沒重跑核對(sha 對不上),整批不採用 —— 請跑 npm run en2:verify-teams。';
      } else {
        for (const rec of v.teams) delivered.set(rec.code, rec.fields);
      }
      if (deliveryNote) console.log(`  ⚠ ${deliveryNote}`);
      else console.log(`  球隊資料交付:${delivered.size} 隊(對照題 ${v.controlTeams} 支既有球隊逐欄位一致)`);
    }
  }

  for (const t of T.list) {
    Object.assign(t, delivered.get(t.code) ?? {});
    if (crestBy.has(t.code)) t.crest = crestBy.get(t.code);
    /* 缺色時退中性灰 —— 畫面上看得出來是沒有,比隨便給一個顏色好:
       給了顏色讀者會以為那是球隊的顏色。交付進來之後這一行就會拿到真的隊色。 */
    t.chartColor = intoBand(t.colors?.[0]) ?? intoBand(t.colors?.[1]) ?? '#9aa0aa';
  }
  const crestCount = crestBy.size;

  const backfills = [];
  const load = season => {
    const { matches, backfill, fotmob } = leagueMatches(ROOT, season, {
      codeOf, kickoffOf: londonKickoff,
      competition: COMPETITION, rawDir: RAW_DIR, fillDir: FILL_DIR, div: 'E1',
      fotmobDir: 'fotmob-championship',   // 第三來源:FotMob 賽果(暫定,逐場核對),2026-09-04
      /* 升級附加賽不是聯賽比賽:場地中立、單場定生死,而且只有四隊打。
         算進積分榜會多算分,進 Poisson 訓練會把季末四強的額外樣本混進主客場參數。
         **而且它跟聯賽撞「主客組合」這個鍵**,所以要在補比分之前就標出來。
         標了之後積分榜與模型都排除 —— 但留在賽果裡,那些比賽真的發生過。 */
      stageOf: m => (m.round == null ? '升級附加賽' : null),
    });
    const line = backfillLine(season, backfill);
    if (line) console.log(line);
    const fmLine = fotmobBackfillLine(season, fotmob);
    if (fmLine) console.log(fmLine);
    if (backfill?.filled) backfills.push({ season, ...backfill });
    return matches;
  };
  const leagueOnly = ms => ms.filter(m => !m.stage);

  const lastMatches = load(LAST_SEASON);
  const curMatches = load(CURRENT_SEASON);
  const priorSeasons = [];
  for (const season of PRIOR_SEASONS) {
    if (!existsSync(join(ROOT, 'data', 'raw', RAW_DIR, `${season}.json`))) continue;
    const ms = leagueOnly(load(season)).filter(m => m.played);
    if (ms.length < 400) { console.log(`  ⚠ ${season} 只有 ${ms.length} 場,不足一季,不納入訓練`); continue; }
    priorSeasons.push({ season, matches: ms });
    console.log(`  歷史賽季 ${season}:${ms.length} 場納入模型訓練`);
  }
  const priorMatches = priorSeasons.flatMap(x => x.matches);
  const fullSeasons = [...priorSeasons.map(x => x.season), LAST_SEASON];

  // 上游若先填入未來賽果,基準日之後一律當未賽 —— 模型不可以偷看未來
  for (const m of curMatches) {
    if (m.date > AS_OF && m.played) Object.assign(m, { played: false, fh: null, fa: null, hh: null, ha: null });
  }
  const curLeague = leagueOnly(curMatches);
  const lastLeague = leagueOnly(lastMatches);
  const curPlayed = curLeague.filter(m => m.played && m.date <= AS_OF);

  const curCodes = [...new Set(curLeague.flatMap(m => [m.home, m.away]))].sort();
  const lastCodes = [...new Set(lastLeague.flatMap(m => [m.home, m.away]))].sort();
  const N = competition(COMPETITION).teams;
  if (curCodes.length !== N || lastCodes.length !== N) {
    throw new Error(`英冠隊數不符:${LAST_SEASON}=${lastCodes.length}、${CURRENT_SEASON}=${curCodes.length}(應為 ${N})`);
  }

  const lastTable = buildTable(lastLeague, lastCodes);
  const curTable = buildTable(curLeague, curCodes);
  /* 扣分處分:2025-26 的 LEI −6 與 WBA −2 有判決書逐字佐證(生效日落在該季)。
     套了之後升降級對帳應該轉綠 —— 之前 LEI 照比分算第 21 名安全、實際降級,
     差的就是這 6 分。來源與原文在 data/manual/points-deductions.json。 */
  const deductionsFile = join(ROOT, 'data', 'manual', 'points-deductions.json');
  let appliedDeductions = [];
  if (existsSync(deductionsFile)) {
    const pd = JSON.parse(readFileSync(deductionsFile, 'utf8'));
    for (const [season, table] of [[LAST_SEASON, lastTable], [CURRENT_SEASON, curTable]]) {
      const ded = (pd.deductions ?? []).filter(d => d.league === 'en2' && d.season === season);
      if (ded.length) {
        applyDeductions(table, ded);
        appliedDeductions.push(...ded);
        console.log(`  扣分處分:${season} 套用 ${ded.map(d => `${d.team} −${d.points}`).join('、')}(判決書佐證)`);
      }
    }
  }

  const trainMatches = [...priorMatches, ...lastLeague, ...curPlayed];
  const model = applyPromotedPrior(fitPoisson(trainMatches, curCodes, { refDate: AS_OF }));
  const elo = buildElo(trainMatches);
  const strengthBy = new Map(strengthTable(model).map(x => [x.code, x]));

  /* 市場賠率。fixtures.csv 是**全歐洲一份**,`npm run odds` 早就下載了 ——
     英冠(Div=E1)本來就在裡面,重抓一次是白費請求。 */
  let marketBy = {};
  let seasonMarketBy = {};
  const futureOdds = join(ROOT, 'data', 'raw', 'football-data-couk', 'fixtures.csv');
  if (existsSync(futureOdds)) {
    const r = upcomingOdds(readFileSync(futureOdds, 'utf8'), { codeOf, div: 'E1' });
    marketBy = r.byMatch;
    if (r.unmatched?.length) console.log(`  ⚠ 英冠賠率隊名未對上:${r.unmatched.join('、')}`);
    console.log(`  市場賠率:${r.count} 場`);
  }
  /* 已完賽場次改讀**賽季檔**:`fixtures.csv` 只涵蓋未來幾天,比賽踢完就掉出去,
     於是「模型 vs 市場」的對照會隨時間憑空消失(2026-09-02 實測:三個聯賽
     86 場已完賽都拿得到收盤賠率,畫面上卻只有 32 場)。賽季檔給的還是**收盤**
     賠率,比開盤更準。未賽場次仍然只有 fixtures.csv 有。 */
  {
    const sp = join(ROOT, 'data', 'raw', 'football-data-couk-championship', `${CURRENT_SEASON}.csv`);
    if (existsSync(sp)) {
      const r = seasonMarket(readFileSync(sp, 'utf8'), { codeOf: codeOf, div: 'E1' });
      seasonMarketBy = r.byMatch;
      console.log(`  市場賠率(本季已完賽):${r.count} 場`
        + (r.dupes.length ? `・鍵重複不採用:${r.dupes.join('、')}` : ''));
    }
  }

  const fixtures = curMatches.map(m => {
    const p = predict(model, m.home, m.away);
    const e = eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500);
    return {
      ...slimMatch(m),
      kickoff: m.kickoff,
      kickoffSource: 'openfootball',
      difficulty: null,
      // 已完賽後才用結果重擬合出的機率不能冒充賽前預測,所以只有未賽場次給機率
      prediction: m.played ? null : {
        ...p,
        home: round((p.home + e.home) / 2, 4),
        draw: round((p.draw + e.draw) / 2, 4),
        away: round((p.away + e.away) / 2, 4),
        poisson: { home: p.home, draw: p.draw, away: p.away },
        elo: e,
      },
      // 已賽場次「目前模型怎麼看」—— 跟西甲同一個欄位,前端標明那不是賽前預測(2026-09-05 補,之前英冠沒有)
      postFit: m.played ? {
        ...p,
        home: round((p.home + e.home) / 2, 4),
        draw: round((p.draw + e.draw) / 2, 4),
        away: round((p.away + e.away) / 2, 4),
        poisson: { home: p.home, draw: p.draw, away: p.away },
        elo: e,
      } : null,
      /* 已賽用賽季檔(收盤、涵蓋整季),未賽用 fixtures.csv(開盤、只有未來幾天)。
         兩邊都沒有就是 null —— 沒有盤口是常態,不要編一個。 */
      market: pickMarket({ played: m.played, key: `${m.home}|${m.away}`, seasonBy: seasonMarketBy, upcomingBy: marketBy }),
      colors: pickPair(T.byCode.get(m.home)?.colors, T.byCode.get(m.away)?.colors),
    };
  });

  const sim = simulateSeason({
    model, fixtures: curLeague.filter(m => !m.played),
    codes: curCodes, played: curPlayed, runs: RUNS, seed: 20262702,
    // 英冠前 2 直升英超、3~6 打附加賽 ——「前四」在這裡不是一條界線
    promotion: 2,
  });
  const simBy = new Map(sim.map(x => [x.code, x]));
  const lastBy = new Map(lastTable.map(x => [x.code, x]));
  const curBy = new Map(curTable.map(x => [x.code, x]));

  const historyByTeam = new Map(curCodes.map(code => [code, []]));
  for (const [season, matches] of [[LAST_SEASON, lastLeague], [CURRENT_SEASON, curLeague]]) {
    const participants = new Set(matches.flatMap(m => [m.home, m.away]));
    for (const code of curCodes) {
      if (!participants.has(code)) continue;
      historyByTeam.get(code).push({
        season, ...teamRecord(matches, code), first10: teamRecord(matches, code, { limit: 10 }),
      });
    }
  }

  /* 近 10 場風格位移 —— 跟英超**同一份實作**(lib/style-trend.mjs)。
     E1 季檔跟 E0 同一套欄位、同一個來源,跨季不換尺。英冠沒有 xG,
     這批逐場實測(射門/射正/角球/牌)就是它的第一層風格資料。
     上季不在英冠的(從英超降下來的 WOL/WHU/BUR、從英甲升上來的 BOL/CAR/LIN)
     基準是 null —— 拿別的聯賽的數字當基準,位移會把「聯賽不同」誤讀成「打法變了」。 */
  const styleTrendBy = new Map();
  {
    const csvOf = season => {
      const p = join(ROOT, 'data', 'raw', FILL_DIR, `${season}.csv`);
      return existsSync(p) ? teamMatchRows(readFileSync(p, 'utf8'), { codeOf, div: 'E1' }) : new Map();
    };
    const lastRows = csvOf(LAST_SEASON), curRows = csvOf(CURRENT_SEASON);
    const playedOf = code => curLeague.filter(m => m.played && (m.home === code || m.away === code)).length;
    for (const code of curCodes) {
      const t = styleTrendFor({
        lastRows: lastRows.get(code) ?? [], curRows: curRows.get(code) ?? [],
        minBaseline: 40, curPlayed: playedOf(code),   // 英冠一季 46 場,基準要接近整季才算數
      });
      if (t) styleTrendBy.set(code, t);
    }
    attachTrendPercentiles(styleTrendBy, { ruler: seasonRuler(lastRows, { minGames: 40 }) });
    console.log(`  風格位移:近 10 場視窗 ${styleTrendBy.size} 隊(上季不在英冠的基準為 null)`);
  }

  /* 逐場統計(FotMob,2026-09-05):跟西甲同一份 lib。比分逐場對回本站賽果、控球率相加要是 100,
     不符的整場退回並印出來。英冠沒有第二來源可抽核控球率,verified 會是 false,畫面照這個講。 */
  const fotmobStats = loadFotmobMatchStats(ROOT, { results: [...lastMatches, ...curMatches].filter(m => m.played), rawDir: 'fotmob-championship' });
  if (fotmobStats.count) {
    console.log(`  FotMob 逐場統計:${fotmobStats.count} 場(${fotmobStats.seasons.join('、')})・退回 ${fotmobStats.rejected.length} 場・控球率未經第二來源抽核`);
    for (const r of fotmobStats.rejected.slice(0, 5)) console.log(`    ⚠ ${r.key}:${r.reason}`);
  }

  const teams = curCodes.map(code => {
    const reg = T.byCode.get(code);
    const ls = lastBy.get(code) ?? null;
    const current = curBy.get(code) ?? null;
    return {
      ...reg,
      lastSeason: ls ? {
        pos: ls.pos, p: ls.p, w: ls.w, d: ls.d, l: ls.l,
        gf: ls.gf, ga: ls.ga, gd: ls.gd, pts: ls.pts, ppg: ls.ppg,
        // 扣分處分(判決書逐字佐證,見 data/manual/points-deductions.json)
        deduction: ls.deduction ?? null, deductionNote: ls.deductionNote ?? null,
        form: ls.form, home: ls.home, away: ls.away,
        homeAwayGap: ls.homeAwayGap, cleanSheets: ls.cleanSheets,
        longest: ls.longest, half: ls.half, bttsPct: ls.bttsPct,
        over25Pct: ls.over25Pct, biggestWin: ls.biggestWin, biggestLoss: ls.biggestLoss,
      } : null,
      inLastSeason: !!ls,
      current,
      history: historyByTeam.get(code) ?? [],
      strength: strengthBy.get(code) ?? null,
      elo: elo.get(code)?.elo ?? null,
      sim: simBy.get(code) ?? null,
      // 這個聯賽沒有的東西一律 null,不要給 0 —— 0 看起來像「量到了,是零」
      styleTrend: styleTrendBy.get(code) ?? null,
      squadSize: null, coach: null, tactics: null,
    };
  });

  const formIndex = buildFormIndex([...priorMatches, ...lastLeague, ...curPlayed]);
  const teamForm = curCodes.map(code => {
    const rows = recentForm(formIndex, code, AS_OF, 5);
    return { code, ...formSummary(rows), matches: rows };
  });

  const h2h = {};
  for (let i = 0; i < curCodes.length; i++) {
    for (let j = i + 1; j < curCodes.length; j++) {
      const a = curCodes[i], b = curCodes[j];
      const r = headToHead([...priorMatches, ...lastLeague, ...curPlayed], a, b);
      if (r?.matches?.length) h2h[`${a}|${b}`] = r;
    }
  }

  /* 走查回測。跟西甲同一支 runner(lib/backtest-runner.mjs),協議一致 ——
     所以三個聯賽的 RPS 真的可以放在一起看。 */
  let backtest = {
    available: false,
    note: `英冠已有 ${fullSeasons.join('、')} 完整歷史,走查回測跑得起來;`
      + '但這次 build 沒有讀到回測產物,請先執行 npm run en2:backtest。',
  };
  {
    const btPath = join(ROOT, 'data', 'backtest-championship.json');
    if (existsSync(btPath)) {
      const r = JSON.parse(await readFile(btPath, 'utf8'));
      backtest = {
        available: true, season: r.season, games: r.games, ranAt: r.ranAt,
        trainSeasons: r.trainSeasons ?? [],
        rps: r.models.blend.rps, logLoss: r.models.blend.logLoss, hitRate: r.models.blend.hitRate,
        baselineRps: r.models.baseline.rps, models: r.models,
        calibration: r.calibration ?? [], byRound: r.byRound ?? [],
        surprises: r.surprises ?? [], baselineProbs: r.baselineProbs ?? null,
        vsBaseline: r.vsBaseline ?? null, vsMarket: r.vsMarket ?? null,
        coverage: r.coverage ?? null,
        market: r.market?.available
          ? r.market
          : { available: false, note: '本站尚未取得英冠的博彩收盤賠率,無法與市場比較。' },
      };
      console.log(`  走查回測:${r.season} ${r.games} 場・RPS ${r.models.blend.rps}`
        + `(基準線 ${r.models.baseline.rps}、差距 ${r.vsBaseline?.ratio ?? '—'} 個標準誤)`);
    }
  }

  /* ── 升降級對帳:我們算出來的積分榜,跟「誰真的還在這個聯賽」對不對得起來 ──
     英冠幾乎每季都有**扣分**(財政違規、進入破產保護等),而比賽資料裡沒有扣分,
     所以從比分算出來的積分榜有可能跟官方榜差一兩個名次。
     實測 2025-26:我們算的後三名是 BLB、OXF、SHW,但**實際離開聯賽的是 LEI、OXF、SHW** ——
     LEI 與 BLB 同為 52 分,LEI 淨勝球還比較好(-10 vs -14),照比分算 LEI 是第 21 名。

     這種事不能只有我知道。做成每次 build 都跑的對帳,對不上就**寫進畫面** ——
     「我們的名次可能跟官方差一名」是讀者有權知道的事,而不是等他自己發現。
     也不去硬改名次:我們沒有扣分的資料來源,猜一個數字填進去才是編數字。 */
  let tableCaveat = null;
  {
    const lastSet = new Set(lastCodes), curSet = new Set(curCodes);
    const left = lastCodes.filter(c => !curSet.has(c));
    const playoffFinal = lastMatches.filter(m => m.stage && m.played).at(-1);
    const promoted = [
      ...lastTable.slice(0, 2).map(r => r.code),
      ...(playoffFinal ? [playoffFinal.fh > playoffFinal.fa ? playoffFinal.home : playoffFinal.away] : []),
    ];
    const ourBottom = lastTable.slice(-3).map(r => r.code);
    const relegated = left.filter(c => !promoted.includes(c));
    const unexpected = relegated.filter(c => !ourBottom.includes(c));
    const spared = ourBottom.filter(c => !relegated.includes(c));
    if (unexpected.length || spared.length) {
      const nameOf = c => T.byCode.get(c)?.en ?? c;
      tableCaveat = {
        season: LAST_SEASON,
        ourBottom, actuallyRelegated: relegated,
        note: `${LAST_SEASON} 我們算出來的後三名是 ${ourBottom.map(nameOf).join('、')},`
          + `但實際降級的是 ${relegated.map(nameOf).join('、')}。`
          + '這一頁的積分榜是**從比賽比分算出來的**,不含英冠常見的扣分處分'
          + '(財政違規等),所以名次可能跟官方榜差一兩名。'
          + '本站沒有扣分的資料來源,不會去猜一個數字填上 —— 照實把差異講出來。',
      };
      console.log(`  ⚠ ${tableCaveat.note.replace(/\*\*/g, '')}`);
    } else {
      console.log(`  升降級對帳:${LAST_SEASON} 我們的後三名與實際降級的隊伍一致`);
    }
  }

  const backfillNotes = backfills.map(b =>
    `${b.season} 有 ${b.filled} 場的比分主來源(openfootball)沒有,改用 football-data.co.uk;`
    + `兩邊重疊的 ${b.checked} 場逐場核對完全一致才採用。`);

  /* 外電。只讀每日快取,開頁不抓外部網站(跟另外兩個聯賽一樣)。
     這裡再做一次最小欄位驗證,壞掉或沒有連結的 RSS 項目不進前端。

     **來源是實測過才收的**:Sky 的 11663 看名字像英冠,實際回的是英超與綜合內容
     (「Gallery: New Premier League kits」),所以不用它 —— 理由記在
     data/manual/feeds-championship.json 的 _rejected。
     譯文由 npm run news:translate -- --league=en2 產生;沒有就維持原文。 */
  let externalNews = [];
  {
    const p = join(ROOT, 'data', 'raw', 'news-championship.json');
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(await readFile(p, 'utf8'));
        externalNews = Array.isArray(raw)
          ? raw.filter(x => x && x.title && x.link && x.source).slice(0, 100)
          : [];
      } catch { externalNews = []; }
    }
    const zhN = attachNewsZh(ROOT, 'en2', externalNews);
    const tagged = tagNewsTeams(externalNews, buildTeamMatchers(teams));
    if (tagged) console.log(`  外電對到球隊:${tagged}/${externalNews.length} 則`);
    console.log(`  外電:${externalNews.length} 則${zhN ? `(${zhN} 則有中文譯文)` : ''}`);
  }

  const meta = {
    /* **不要設 edition**。那個欄位在前端被當成「是不是西甲」的二元旗標用
       (page-index / page-teams / page-tactics / fixture-list 都是),
       設成 'basic' 的話英冠會走西甲那條路,首頁就會宣稱我們有 xG 與球員資料。
       前端該問的是 capabilities,不是 edition —— 但那要動四個頁面,
       這裡先不設,行為才是對的。 */
    league: 'en2', leagueLabel: '英冠',
    /* capabilities 是前端用來決定「這一頁要不要畫」的旗標。
       沒有的一律 false,**不要留空不寫** —— 沒寫的話前端讀到 undefined,
       某些地方會當成「還沒判斷」而不是「沒有」。 */
    capabilities: { players: false, injuries: false,
      coaches: existsSync(join(ROOT, 'data', 'championship-coaches-verified.json'))
        && JSON.parse(readFileSync(join(ROOT, 'data', 'championship-coaches-verified.json'), 'utf8')).accepted,
      xg: false, lineups: false, live: false },
    builtAt: new Date().toISOString(), asOf: AS_OF,
    /* 欄位名要跟另外兩個聯賽一致:currentSeason / lastSeason。
       第一版寫成 season,首頁那句「2025-26 完整・undefined 進行中」就是這樣來的 ——
       不會拋錯,只會在畫面上印一個 undefined。 */
    currentSeason: CURRENT_SEASON, lastSeason: LAST_SEASON,
    h2hSeasons: [...fullSeasons, CURRENT_SEASON],
    competition: competition(COMPETITION),
    historySeasons: fullSeasons,
    tableCaveat,
    /* 頁首那段話由各聯賽自己寫 —— 前端不該知道哪個聯賽有什麼資料。
       這一段要**先講做得到什麼、再講做不到什麼**,而不是只列做得到的:
       讀者看到「英冠」會預期跟英超一樣的東西,不講清楚就是靠沉默誤導。 */
    intro: `把 ${fullSeasons.join('、')} 與本季 ${CURRENT_SEASON} 的每一場英冠比賽跑成模型,`
      + '做出積分預測、單場勝負機率與賽季模擬,並跟市場賠率並排比較。'
      + '**這個聯賽只做到球隊與比賽這一層** —— 沒有球員數據、沒有 xG、沒有陣容與傷停,'
      + '因為英冠沒有免費的球員級資料源(下方「目前資料界線」有實測細節)。',
    boundaries: [
      '✓ 賽程、比分、積分榜、近期戰績、單場預測與賽季模擬(前 2 直升、3~6 附加賽、後 3 降級)',
      '✓ 兩個獨立來源逐場核對:openfootball(en.2)與 football-data.co.uk(E1),對不上就整份不採用',
      '✓ 市場賠率並排比較(來源與英超西甲同一份 fixtures.csv,英冠本來就在裡面)',
      '✓ 外電:BBC 與 Guardian 的英冠 feed(兩個都實測過內容才收;'
      + 'Sky 有一個名字像英冠、實際回英超內容,不用它)。只有標題與短摘要,不翻譯',
      '✓ 逐場實測統計(射門/射正/角球/牌,football-data.co.uk):球隊頁的近 10 場風格位移,'
      + '跟英超同一份實作;上季不在英冠的球隊基準為 null,不拿別的聯賽當基準',
      '— 沒有球員數據與 xG:Understat 不涵蓋英冠(2026-08-28 實測四種聯賽代碼皆回空陣列,'
      + '而同一個請求 EPL 回 537 人、西甲回 600 人),FPL 只有英超。**這是驗證過的沒有,不是還沒做**',
      /* 這一行**不要寫死**。第一版寫「隊色與球場資料尚未取得」,交付進來之後它就變成
         畫面上的一句假話 —— 而畫面說謊比缺一格嚴重。改成跟著資料走。 */
      ...(delivered.size
        ? [`✓ 隊色、城市、球場、容量與綽號:人工交付並通過核對(${delivered.size} 隊;`
          + '其中 12 支跟本站既有的英超名冊逐欄位一致,那是刻意留的對照題)']
        : ['— 隊色與球場資料尚未取得,所以圖表暫時是中性灰'
          + (deliveryNote ? `(${deliveryNote}` + ')' : '')]),
      ...(existsSync(join(ROOT, 'data', 'championship-coaches-verified.json'))
        && JSON.parse(readFileSync(join(ROOT, 'data', 'championship-coaches-verified.json'), 'utf8')).accepted
        ? ['✓ 教練名冊:人工交付並通過核對(6 支英超對照組跟官方每日名單全對;任內戰績由本站賽果依上任日期切分)']
        : ['— 沒有教練名冊']),
      '— 沒有傷停、正式陣容與賽後統計',
      ...(tableCaveat ? [`— ${tableCaveat.note.replace(/\*\*/g, '')}`] : []),
      ...(backtest.available
        ? [`✓ 走查回測 ${backtest.season} ${backtest.games} 場:RPS ${backtest.rps}、基準線 ${backtest.baselineRps}`
          + `(訓練季 ${backtest.trainSeasons.join('、')},每一輪只用開賽前的資料重新訓練)`]
        : ['— 還沒跑走查回測,所以這一頁不給準度數字']),
    ],
    /* 欄位是 name / url / use / license —— 跟另外兩個聯賽一致。
       第一版自己用 id / label / role,頁尾就印出「來源:undefined、undefined」。
       同一個 build 裡第三次犯同一種錯(season、reports、這裡):
       產物的欄位名不是自由發揮的地方,是跟前端的約定。 */
    sources: [
      {
        name: 'openfootball / football.json(en.2)',
        url: 'https://github.com/openfootball/football.json',
        use: `英冠 ${[...fullSeasons, CURRENT_SEASON].join('、')} 賽程與賽果`,
        license: 'Public Domain',
      },
      {
        name: 'football-data.co.uk(E1)',
        url: 'https://www.football-data.co.uk/englandm.php',
        use: '獨立核對賽果、補主來源缺的比分、市場賠率',
        license: '免費資料檔',
      },
    ],
    /* 欄位名跟另外兩個聯賽**一模一樣**(type / caveats / decayXi …)。
       第一版自己取名叫 note,結果首頁讀 meta.model.caveats 就炸了 ——
       前端是三個聯賽共用的,欄位名不一致等於每加一個聯賽就要改前端。 */
    model: {
      type: 'Dixon-Coles Poisson + Elo(取平均)',
      /* 對戰模擬的前端參數(未捨入)—— golden 測試守著等價性 */
      sim: { ...simParams(model), elo: ELO_PARAMS },
      homeAdvantage: round(Math.exp(model.gamma), 3), rho: model.rho, decayXi: model.xi,
      promotedPrior: model.promoted, simulationRuns: RUNS,
      /* 沒有回測就不給準度數字(鐵則二)。available:false 會讓首頁那兩個 KPI
         顯示「—」與「尚未回測」,而不是空白或 0 —— 0 看起來像一個很好的分數。 */
      backtest,
      caveats: [
        `英冠模型使用 ${fullSeasons.join('、')} 完整賽季與 ${CURRENT_SEASON} 已完賽資料。`,
        ...backfillNotes,
        '升級附加賽不進模型也不進積分榜(中立場地、只有四隊打),但保留在賽果裡。',
        /* 這一段是這個聯賽最重要的一句實話:少了什麼要講在畫面上,不是只寫在程式註解裡。 */
        '**不含球員、傷停、xG 與陣容** —— 英冠沒有免費的球員級資料源'
        + '(Understat 只做五大聯賽、FPL 只有英超,兩者都實測過),'
        + '所以這個聯賽只做得出球隊與比賽那一層。',
        '升班馬沒有上一季英冠樣本,套用聯盟後段先驗並提高模擬不確定性。',
      ],
    },
    counts: {
      teams: teams.length, fixtures: fixtures.length,
      players: 0, news: externalNews.length, injuries: 0, coaches: 0,
      crests: crestCount,
      currentSeasonRounds: Math.max(0, ...curPlayed.map(m => m.round ?? 0)),
      playoffMatches: [...lastMatches, ...curMatches].filter(m => m.stage).length,
    },
    /* 這個聯賽沒有的能力一律明講,前端才不會畫一個空殼。 */
    live: { available: false, note: '英冠沒有接即時比分來源;比分依 openfootball 與 football-data.co.uk 的更新節奏落地。' },
    official: { available: false },
    ai: { enabled: false, pre: 0, post: 0 },
    players: { available: false, note: 'Understat 不涵蓋英冠(2026-08-28 實測四種聯賽代碼皆回空陣列,同一請求 EPL 537 人、西甲 600 人),FPL 只有英超。' },
  };

  console.log('寫入英冠資料集:');
  for (const t of teams) { const ms = fotmobStats.teams[t.code]; if (ms?.games) t.matchStats = ms; }
  await write('meta', meta);
  await write('clubs', T.list);
  await write('teams', teams);
  /* 官方賽程狀態(延期/取消)—— 跟英超同一份實作,快照太舊不掛 */
  {
    const ssPath = join(ROOT, 'data', 'raw', 'schedule-status.json');
    if (existsSync(ssPath)) {
      const ss = JSON.parse(readFileSync(ssPath, 'utf8'));
      const fresh = ss.leagues?.en2?.fetchedAt && (Date.now() - new Date(ss.leagues.en2.fetchedAt)) < 3 * 86400000;
      if (fresh) {
        const n = attachScheduleStatus(fixtures, ss.leagues.en2.matches);
        if (n) console.log(`  官方賽程狀態:${n} 場標為延期/取消`);
      }
    }
  }
  await write('fixtures', fixtures);
  await write('table', { last: lastTable, current: curTable, lastSeason: LAST_SEASON, currentSeason: CURRENT_SEASON });
  await write('sim', sim);
  await write('form', {
    asOf: AS_OF, inModel: false, tuned: TUNED, tuning: null, situationTuning: null,
    note: '近期資料只供顯示,不調整模型機率。', teams: teamForm,
  });
  await write('h2h', h2h);
  await write('results', [...lastMatches, ...curMatches].filter(m => m.played).map(slimMatch));
  /* 下面三份是首頁會讀的,英冠沒有內容 —— 寫**空的**而不是不寫。
     不寫的話前端拿到 404 會走「還沒 build」那條訊息,那是錯的:
     我們 build 了,是這個聯賽沒有這種資料。 */
  await write('news', externalNews);
  /* 勝率曲線的歷史。這個聯賽沒有逐分鐘的即時管線,所以是空的 ——
     但**檔案要在**:分析頁三個聯賽共用,少這一份會 404 整頁炸掉(英冠踩過)。 */
  await write('prob-history', { season: null, matches: {} });
  /* 球員、教練、進球明細:英冠**沒有免費來源**(見檔頭的實測)。
     寫空的而不是不寫,而且每一份都帶 available:false 與一句為什麼 ——
     前端要能分得出「還沒 build」與「這個聯賽沒有這種資料」,
     那是兩句完全不同的話,給錯讀者會以為網站壞了。 */
  const noPlayerData = 'Understat 不涵蓋英冠(2026-08-28 實測 Championship / EFL_Championship / '
    + 'English_Championship / ENG_Championship 四種寫法皆回空陣列,而同一個請求 EPL 回 537 人、'
    + '西甲回 600 人,getTeamData 對英冠球隊一律 404),FPL 只有英超。';
  await write('players', []);
  await write('leaders', { available: false, note: noPlayerData, boards: [] });
  /* 教練。人工交付 → 核對器(npm run en2:verify-coaches)→ 產物,build 只讀產物。
     收件匣改過沒重跑核對時 sha 對不上,整批不掛(比照球隊資料與租借)。
     任期已知的,拿本站的英冠賽果**自動算任內戰績** —— 日期錯了戰績就會算到
     前任頭上,所以這也是 since 日期錯誤會現形的地方。 */
  {
    let coachesOut = { available: false, note: '英冠教練交付未通過核對或還沒核對。', season: CURRENT_SEASON, coaches: [] };
    const vPath = join(ROOT, 'data', 'championship-coaches-verified.json');
    const inboxPath = join(ROOT, 'data', 'manual', 'championship-coaches-delivery.json');
    if (existsSync(vPath) && existsSync(inboxPath)) {
      const v = JSON.parse(await readFile(vPath, 'utf8'));
      const sha = createHash('sha256').update(await readFile(inboxPath)).digest('hex');
      if (!v.accepted) console.log('  ⚠ 教練交付未通過核對,整批不掛');
      else if (v.inboxSha !== sha) console.log('  ⚠ 教練收件匣改過但沒重跑核對(sha 對不上),整批不掛');
      else {
        const allMatches = [...priorMatches, ...lastLeague, ...curPlayed];
        const withPpg = r => ({ ...r, pts: r.w * 3 + r.d, ppg: r.p ? round((r.w * 3 + r.d) / r.p, 2) : 0 });
        coachesOut = {
          available: true, season: CURRENT_SEASON,
          source: v.source, verifiedAt: v.ranAt,
          note: '人工交付,已過核對器:6 支英超對照組跟官方每日名單全對、逐欄位出處齊全;'
            + '外電庫比對為累積式訊號。任內戰績由本站賽果依 since 日期自動切分。',
          coaches: v.coaches.map(c => {
            const sinceIso = c.since ? (c.since.length === 7 ? `${c.since}-01` : c.since) : null;
            /* datePrecision 要跟著標:YYYY-MM 的交付切分是取月初,那個月內的比賽
               可能還是前任帶的 —— 戰績照算,但畫面要講得出精度。 */
            const tenure = sinceIso
              ? allMatches.filter(m => (m.home === c.team || m.away === c.team) && m.date >= sinceIso)
              : null;
            const lastTen = tenure ? tenure.filter(m => m.season === LAST_SEASON) : null;
            const curTen = tenure ? tenure.filter(m => m.season === CURRENT_SEASON) : null;
            return {
              team: c.team, name: c.name, nat: c.nat, since: c.since, caretaker: c.caretaker,
              sincePrecision: c.since ? (c.since.length === 7 ? 'month' : 'day') : null,
              sourceVerified: true,
              seasonRecord: lastTen?.length ? withPpg(teamRecord(lastTen, c.team)) : null,
              currentSeasonRecord: curTen?.length ? withPpg(teamRecord(curTen, c.team)) : null,
              allRecord: tenure?.length ? withPpg(teamRecord(tenure, c.team)) : null,
            };
          }),
        };
        console.log(`  教練:${coachesOut.coaches.length} 隊(任期已知 ${coachesOut.coaches.filter(c => c.since).length} 隊,任內戰績已切分)`);
      }
    }
    // 教練前一段任期(B 層):en2 批次通過核對後這裡自動掛上,被退回時是空操作
    attachCareers(ROOT, coachesOut.coaches, 'en2');
    attachProfiles(ROOT, coachesOut.coaches, 'en2');
    await write('coaches', coachesOut);
    // 球隊卡要看得到教練
    for (const t of teams) {
      const c = coachesOut.coaches.find(x => x.team === t.code);
      if (c?.name) t.coach = { name: c.name, nat: c.nat, since: c.since, caretaker: c.caretaker };
    }
    await write('teams', teams);   // 重寫一次,把 coach 掛上去
  }
  await write('goals', { available: false, note: noPlayerData, seasons: [], data: {}, unavailable: ['scorers'] });

  /* ── 單場分析頁要的六份 ──
     這一頁**不在導覽列的 open 清單裡,但它照樣進得來** —— 首頁的「接下來的比賽」
     每一場都連過去。少寫這六份的話,讀者從首頁點一場比賽就會撞上
     「載入失敗…請先執行 npm run build」—— 那是給開發者的訊息,而且理由是錯的。
     (西甲當初就是這樣壞掉的,`dataGap` 那一節的註解寫了。)

     這一頁對英冠是**有內容的**:賽前機率、市場賠率、雙方近況、歷來交手都算得出來。
     所以是把缺的那幾份寫成「明確不可用」,不是把整頁擋掉。 */
  await write('tactics', []);
  await write('shapes', {});
  await write('lineups', {});
  await write('experts', {
    version: 1, updatedAt: null, mode: 'unavailable',
    note: '英冠沒有收錄真人專家觀點。本站的專家觀點只收具名、可查證的來源,英冠目前沒有。',
    counts: { matches: 0 }, matches: {}, count: 0,
  });
  await write('official', {
    available: false, season: CURRENT_SEASON, source: null, sources: [], matches: {},
    note: '英冠沒有接正式先發名單來源。',
  });
  /* 英冠即時比分(2026-09-04):FotMob 賽程端點,比賽日約每 15 分鐘一次(laliga-matchday.yml 一起跑)。
     只有比分與分鐘;抓取超過 6 小時就不宣告可用(跟西甲同一條新鮮度規矩)。
     **live.matches 是陣列,official/experts 的 matches 是物件** —— 以 es1 的產物為準。 */
  let liveOut = {
    available: false, source: null, sourceLabel: null, demo: false,
    season: CURRENT_SEASON, fetchedAt: null, counts: { live: 0, today: 0 }, matches: [],
    note: '英冠即時比分來自 FotMob 的賽程端點,只在比賽日更新;沒有比賽的日子這裡就是空的。',
  };
  {
    const sp = join(ROOT, 'data', 'raw', 'fotmob-championship', 'scores.json');
    if (existsSync(sp)) {
      try {
        const sc = JSON.parse(readFileSync(sp, 'utf8'));
        const ageH = (Date.now() - Date.parse(sc.fetchedAt ?? 0)) / 3600000;
        if (sc.season === CURRENT_SEASON && Number.isFinite(ageH) && ageH <= 6) {
          const today = sc.fetchedAt.slice(0, 10);
          const todays = sc.matches.filter(m => m.date === today && (m.started || m.finished) && !m.cancelled);
          const byPair = new Map(fixtures.map(f => [`${f.home}|${f.away}`, f]));
          const minuteOf = m => { const mm = /^(\d+)/.exec(String(m.liveTime ?? '')); return m.finished ? 90 : mm ? Number(mm[1]) : 0; };
          const matches = todays.map(m => {
            const fixture = byPair.get(`${m.home}|${m.away}`);
            if (!fixture) return null;
            const detail = { key: `${m.home}|${m.away}`, season: CURRENT_SEASON, source: 'fotmob', kickoff: m.utcTime,
              home: m.home, away: m.away, score: m.score ? { home: m.score[0], away: m.score[1] } : { home: null, away: null },
              teamStats: {}, players: {}, events: [], lineups: {},
              coverage: { teamStatistics: false, playerStatistics: false, ratings: false, events: false, lineups: false } };
            return buildLiveProviderReport({ fixture: { ...fixture, finished: m.finished }, detail, minute: minuteOf(m), nameOf: code => T.byCode.get(code)?.en ?? code });
          }).filter(Boolean);
          liveOut = { available: true, source: 'fotmob', sourceLabel: 'FotMob 比分(比賽日約每 15 分鐘)', demo: false,
            season: CURRENT_SEASON, fetchedAt: sc.fetchedAt,
            counts: { total: matches.length, live: todays.filter(m => m.started && !m.finished).length, finished: todays.filter(m => m.finished).length, upcoming: 0, today: matches.length },
            matches, note: '只有比分與分鐘,沒有事件、陣容與統計。' };
          console.log(`  英冠即時比分:FotMob 快照 ${Math.round(ageH * 60)} 分鐘前・今天 ${matches.length} 場(進行中 ${liveOut.counts.live})`);
        }
      } catch (e) { console.log(`  ⚠ FotMob 比分快照讀不了:${e.message}`); }
    }
  }
  await write('live', liveOut);
  /* reports 的形狀要跟另外兩個聯賽一樣(seasons / count / reports 是個以
     「賽季|主|客」為鍵的物件)。第一版自己編了 {pre,post},
     fixture-list 去讀 reports.reports[key] 就炸了 —— 又一次自己取名字的代價。

     blocked 這個欄位有明確語意(整季拿不到,CLAUDE.md 有一整條在講):
     英冠是**根本沒有這個資料源**,不是方案不含本季,所以照實寫原因。 */
  /* 賽後報告(2026-09-05):FotMob 的逐場資料轉成 canonical detail,走跟西甲同一個 buildProviderMatchReport
     (它自己會再核對一次比分、要求五種 coverage 齊全)。以前這裡是空殼加 blocked:'no-source' ——
     那句「沒有接賽後資料源」現在不成立了,blocked 要回 null。 */
  const reports = {};
  const nameOf = code => T.byCode.get(code)?.en ?? code;
  for (const f of fixtures) {
    if (!f.played) continue;
    const ms = fotmobStats.matches?.[`${f.season}|${f.home}|${f.away}`];
    if (!ms) continue;
    const report = buildProviderMatchReport({ fixture: f, detail: toCanonicalDetail(ms, { verified: false }), nameOf });
    if (report) reports[`${f.season}|${f.home}|${f.away}`] = report;
  }
  const reportCount = Object.keys(reports).length;
  const pendingCount = fixtures.filter(f => f.played && f.season === CURRENT_SEASON && !reports[`${f.season}|${f.home}|${f.away}`]).length;
  if (reportCount) console.log(`  英冠賽後報告:${reportCount} 場(FotMob)・本季還沒抓到 ${pendingCount} 場`);
  await write('reports', {
    seasons: reportCount ? [...new Set(Object.values(reports).map(r => r.season))].sort() : [], count: reportCount, reports,
    source: reportCount ? 'fotmob' : null, pending: pendingCount,
    blocked: reportCount ? null : { reason: 'not-fetched', message: '英冠的 FotMob 逐場資料還沒抓(npm run game:fetch -- --league=en2)。', at: new Date().toISOString() },
    backupBlocked: null,
    note: reportCount
      ? '英冠賽後資料來自 FotMob 逐場端點:球隊統計、逐射門 xG、事件、正式名單與逐人評分;比分逐場對回本站賽果才收。沒有第二來源可抽核控球率。'
      : '英冠的 FotMob 逐場資料還沒抓。',
  });
  if (fotmobStats.count) {
    await write('matchstats', { source: fotmobStats.source, note: '英冠逐場統計(FotMob):控球、球隊統計、逐射門 xG、動能、事件、名單、跑動、逐人統計。比分已逐場對回本站賽果;控球率沒有第二來源可抽核。',
      seasons: fotmobStats.seasons, count: fotmobStats.count, rejected: fotmobStats.rejected, verification: fotmobStats.verification, teams: fotmobStats.teams, matches: fotmobStats.matches });
  }
  await write('analysis', { enabled: false, pre: {}, post: {}, counts: { pre: 0, post: 0 } });

  console.log(`\n✔ 英冠:${teams.length} 隊、${fixtures.length} 場賽程、隊徽 ${crestCount}/${T.list.length}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exit(1); });
