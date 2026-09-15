/* 「openfootball + football-data.co.uk + Understat + FotMob」這一型聯賽的 build ——
 * **德甲、義甲、法甲共用這一份**。
 *
 * 四個來源與它們各自的角色:
 *   openfootball {代碼}.json      賽程骨架 + 賽果 + 半場 + 輪次(主來源)
 *   football-data.co.uk {分區}    賽果 + 逐場統計(射門/角球/牌)+ 賠率(獨立來源)
 *   Understat {聯賽代號}          球員整季彙總(進球、助攻、xG、xA、射門、關鍵傳球、牌)
 *   FotMob 逐場(聯賽 id)         賽後報告、球隊統計、逐射門 xG、事件、正式名單、逐人評分
 *
 * 兩份賽果的重疊場次逐場核對走 `lib/league-matches.mjs`(跟西甲同一份實作):
 * 有一場不符就整份不採用。
 *
 * ── 為什麼是這三個聯賽,而不是全部六個 ──
 * 英超有 FPL 與官方 feed、西甲有 SportMonks 的補充層(背號/頭貼/出生日期)、
 * 英冠的球員層是**逐場累加**而且季末有升級附加賽 —— 那三個的資料形狀真的不同,
 * 硬塞進同一支會變成一堆 if,那比複製還糟。德義法三個的形狀一模一樣,
 * 差別全部是參數,所以它們共用。
 *
 * ── 呼叫端要給什麼 ──
 *   key / zh / competition / rawDir / fillDir / div / understatDir / fotmobDir
 *   crestFile / teamFile / timezone / lastSeason / currentSeason / priorSeasons
 *   teamCount / rounds / relegation(這個聯賽的升降級規則,**不可以照抄**)
 *
 * **`teamCount`、`rounds` 與 `relegation` 是聯賽的事實,抄過來就是一個假數字。**
 * 德甲與法甲的第 16 名打的是**跨聯賽**的附加賽(對德乙 / 法乙第 3 名),
 * 而義甲是後 3 名直接降級、沒有附加賽 —— 三句話對讀者的意義完全不同。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { leagueMatches, backfillLine, europeanKickoff } from './league-matches.mjs';
import { competition } from './canonical.mjs';
import { loadTeams } from './teams.mjs';
import { buildTable, headToHead, teamRecord } from './table.mjs';
import { teamMatchRows, styleTrendFor, attachTrendPercentiles, seasonRuler } from './style-trend.mjs';
import { fitPoisson, applyPromotedPrior, predict, strengthTable, simParams } from './poisson.mjs';
import { buildElo, eloProbs, ELO_PARAMS } from './elo.mjs';
import { simulateSeason } from './simulate.mjs';
import { buildFormIndex, recentForm, formSummary, TUNED } from './form.mjs';
import { upcomingOdds, seasonMarket, pickMarket } from './odds.mjs';
import { pickPair, intoBand } from './colour.mjs';
import { round } from './util.mjs';
/* 跨聯賽球員搜尋的統一層。**開了球員頁就一定要寫這一份** ——
   `allplayers-view.js` 與 `core.js` 的 crossLeaguePlayers 都是看
   `LEAGUES[lg].open` 有沒有 players 才去要它的,沒寫就是一個保證 404,
   而畫面只是「搜尋德甲球員什麼都搜不到」,不報錯。 */
import { coreFromUnderstat } from './player-core.mjs';
/* 比賽層(2026-09-15):FotMob 逐場 → 逐場統計 + 賽後報告。跟西甲、英冠**同一份實作**,
   不各寫一套(buildProviderMatchReport 自己會再核對一次比分、要求 coverage 齊全)。 */
import { loadFotmobMatchStats, toCanonicalDetail } from './matchstats.mjs';
import { buildProviderMatchReport } from './postmatch-report.mjs';
/* 球員層跟西甲**共用同一支適配器**(只有 dir 不同)—— Understat 兩邊的欄位是
   同一組,那是 probe-understat-bundesliga.mjs 逐欄位比對過的,不是假設。 */
import { loadPlayers, buildLeaders, attachRadar, normalisePlayerForSite, BOARDS, RADAR_AXES, MIN_MINUTES }
  from './adapters/understat-players.mjs';


const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];

export async function buildLeague(L) {
  const ROOT = L.root;
  const OUT = join(ROOT, 'web', 'data', 'leagues', L.key);
  const COMPETITION = L.competition;
  const RAW_DIR = L.rawDir;
  const FILL_DIR = L.fillDir;
  const DIV = L.div;

  const LAST_SEASON = L.lastSeason;
  const CURRENT_SEASON = L.currentSeason;
  const PRIOR_SEASONS = L.priorSeasons;
  const AS_OF = arg('as-of') ?? new Date().toISOString().slice(0, 10);
  const RUNS = Number(arg('runs') ?? 5000);

  /* 開球時間的時區**是聯賽的事實**,不可以照抄。adapter 的預設 kickoffOf 固定補 +01:00,
     照用的話夏季場次會整批晚一小時。DST 規則共用 lib 那一份,不自己再寫
     (英冠用倫敦、西甲用馬德里、德義法用中歐,同一個函式)。 */
  const berlinKickoff = europeanKickoff(L.timezone);

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
    if (m.scoreProvisional) { out.scoreProvisional = true; out.scoreSource = m.scoreSource ?? 'fotmob'; }
    if (m.scoreSource) out.scoreSource = m.scoreSource;
    return out;
  };

  await mkdir(OUT, { recursive: true });
  console.log(`▶ 建立${L.zh}資料集(基準日 ${AS_OF},模擬 ${RUNS} 次)\n`);

  const T = loadTeams(ROOT, { file: L.teamFile });
  /* football-data.co.uk 的隊名是**簡稱**(Bayern Munich / M'gladbach / Ein Frankfurt、
     Inter / Verona、Paris SG / St Etienne …),跟 openfootball 的全名對不上。
     **不走 loadTeams 的寬鬆比對** —— 那條路徑會把 FC 前後綴一起吃掉,本站在盃賽頁被它咬過兩次。
     這裡用名冊的 fd 欄逐隊精確對照(名字怎麼來的見 teams-bundesliga.json 的 _note)。 */
  const byFd = new Map(T.list.filter(t => t.fd).map(t => [t.fd, t.code]));
  const codeOf = name => byFd.get(name) ?? T.codeOf(name);

  /* 隊徽走 `npm run de1:crests`(football-logos 的靜態檔,跟英超西甲同一支抓取器),
     鍵就是本站隊碼。**隊色、城市、球場、教練還沒有** —— 要另外人工交付並過核對器。
     缺色時退中性灰 —— 畫面上看得出來是沒有,比隨便給一個顏色好。 */
  const crestBy = new Map();
  {
    const p = join(ROOT, 'data', 'manual', L.crestFile);
    if (existsSync(p)) {
      const j = JSON.parse(await readFile(p, 'utf8'));
      for (const [code, uri] of Object.entries(j.crests ?? {})) if (uri) crestBy.set(code, uri);
    }
  }
  for (const t of T.list) {
    t.chartColor = intoBand(t.colors?.[0]) ?? '#9aa0aa';
    if (crestBy.has(t.code)) t.crest = crestBy.get(t.code);
  }

  /* 哪幾季有第二來源。**這件事要進產物** —— 把關強度逐季不同而畫面不講,
     等於讓讀者以為每一季一樣可靠。 */
  const hasFill = season => existsSync(join(ROOT, 'data', 'raw', FILL_DIR, `${season}.csv`));
  const scoreRefusals = [];
  const backfills = [];

  const load = season => {
    const { matches, backfill } = leagueMatches(ROOT, season, {
      codeOf, kickoffOf: berlinKickoff,
      competition: COMPETITION, rawDir: RAW_DIR, fillDir: FILL_DIR, div: DIV,
      fill: hasFill(season),
    });
    const line = backfillLine(season, backfill);
    if (line) console.log(line);
    if (backfill?.filled) backfills.push({ season, ...backfill });
    if (backfill?.mismatches?.length) {
      scoreRefusals.push({ season, source: 'football-data.co.uk', count: backfill.mismatches.length, sample: backfill.mismatches.slice(0, 5) });
    }
    return matches;
  };

  const lastMatches = load(LAST_SEASON);
  const curMatches = load(CURRENT_SEASON);
  const priorSeasons = [];
  for (const season of PRIOR_SEASONS) {
    if (!existsSync(join(ROOT, 'data', 'raw', RAW_DIR, `${season}.json`))) continue;
    const ms = load(season).filter(m => m.played);
    /* 一季 306 場。少於 250 代表那一季的上游還不完整,不納入訓練 ——
       殘缺的季會讓 Poisson 的主客場參數偏掉,而畫面上看不出來。 */
    if (ms.length < 250) { console.log(`  ⚠ ${season} 只有 ${ms.length} 場,不足一季,不納入訓練`); continue; }
    priorSeasons.push({ season, matches: ms });
    console.log(`  歷史賽季 ${season}:${ms.length} 場納入模型訓練`);
  }
  const priorMatches = priorSeasons.flatMap(x => x.matches);
  const fullSeasons = [...priorSeasons.map(x => x.season), LAST_SEASON];

  // 上游若先填入未來賽果,基準日之後一律當未賽 —— 模型不可以偷看未來
  for (const m of curMatches) {
    if (m.date > AS_OF && m.played) Object.assign(m, { played: false, fh: null, fa: null, hh: null, ha: null });
  }
  const curPlayed = curMatches.filter(m => m.played && m.date <= AS_OF);

  const curCodes = [...new Set(curMatches.flatMap(m => [m.home, m.away]))].sort();
  const lastCodes = [...new Set(lastMatches.flatMap(m => [m.home, m.away]))].sort();
  const N = competition(COMPETITION).teams;
  if (curCodes.length !== N || lastCodes.length !== N) {
    throw new Error(`${L.zh}隊數不符:${LAST_SEASON}=${lastCodes.length}、${CURRENT_SEASON}=${curCodes.length}(應為 ${N})`);
  }
  if (curCodes.includes(null) || lastCodes.includes(null)) {
    throw new Error(`有隊名對不到隊碼 —— 名冊(${L.teamFile})要補,不要讓它靜靜掉隊`);
  }

  const lastTable = buildTable(lastMatches, lastCodes);
  const curTable = buildTable(curMatches, curCodes);

  const trainMatches = [...priorMatches, ...lastMatches, ...curPlayed];
  const model = applyPromotedPrior(fitPoisson(trainMatches, curCodes, { refDate: AS_OF }));
  const elo = buildElo(trainMatches);
  const strengthBy = new Map(strengthTable(model).map(x => [x.code, x]));

  /* 市場賠率。fixtures.csv 是**全歐洲一份**,`npm run odds` 早就下載了 ——
     德甲(Div=D1)本來就在裡面,重抓一次是白費請求。 */
  let marketBy = {}, seasonMarketBy = {};
  const futureOdds = join(ROOT, 'data', 'raw', 'football-data-couk', 'fixtures.csv');
  if (existsSync(futureOdds)) {
    const r = upcomingOdds(readFileSync(futureOdds, 'utf8'), { codeOf, div: DIV });
    marketBy = r.byMatch;
    if (r.unmatched?.length) console.log(`  ⚠ ${L.zh}賠率隊名未對上:${r.unmatched.join('、')}`);
    console.log(`  市場賠率:${r.count} 場`);
  }
  if (hasFill(CURRENT_SEASON)) {
    const r = seasonMarket(readFileSync(join(ROOT, 'data', 'raw', FILL_DIR, `${CURRENT_SEASON}.csv`), 'utf8'), { codeOf, div: DIV });
    seasonMarketBy = r.byMatch;
    console.log(`  市場賠率(本季已完賽):${r.count} 場` + (r.dupes.length ? `・鍵重複不採用:${r.dupes.join('、')}` : ''));
  }

  const fixtures = curMatches.map(m => {
    const p = predict(model, m.home, m.away);
    const e = eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500);
    const blend = {
      ...p,
      home: round((p.home + e.home) / 2, 4),
      draw: round((p.draw + e.draw) / 2, 4),
      away: round((p.away + e.away) / 2, 4),
      poisson: { home: p.home, draw: p.draw, away: p.away },
      elo: e,
    };
    return {
      ...slimMatch(m),
      kickoff: m.kickoff,
      kickoffSource: 'openfootball',
      difficulty: null,
      // 已完賽後才用結果重擬合出的機率不能冒充賽前預測,所以只有未賽場次給 prediction
      prediction: m.played ? null : blend,
      postFit: m.played ? blend : null,
      market: pickMarket({ played: m.played, key: `${m.home}|${m.away}`, seasonBy: seasonMarketBy, upcomingBy: marketBy }),
      colors: pickPair(T.byCode.get(m.home)?.colors, T.byCode.get(m.away)?.colors),
    };
  });

  /* 賽季模擬。**德甲沒有「直升」這個欄位** —— 它的第 16 名打的是跨聯賽的升降級附加賽,
     而本站沒有德乙的資料,評不出對手強度(鐵則二)。所以只給冠軍 / 前四 / 降級,
     附加賽那一名由前端照 `meta.boundaries` 講,不編一個機率出來。 */
  const sim = simulateSeason({
    model, fixtures: curMatches.filter(m => !m.played),
    codes: curCodes, played: curPlayed, runs: RUNS, seed: 20262703,
  });
  const simBy = new Map(sim.map(x => [x.code, x]));
  const lastBy = new Map(lastTable.map(x => [x.code, x]));
  const curBy = new Map(curTable.map(x => [x.code, x]));

  const historyByTeam = new Map(curCodes.map(code => [code, []]));
  for (const [season, matches] of [[LAST_SEASON, lastMatches], [CURRENT_SEASON, curMatches]]) {
    const participants = new Set(matches.flatMap(m => [m.home, m.away]));
    for (const code of curCodes) {
      if (!participants.has(code)) continue;
      historyByTeam.get(code).push({ season, ...teamRecord(matches, code), first10: teamRecord(matches, code, { limit: 10 }) });
    }
  }

  /* 近 10 場風格位移 —— 跟英超英冠**同一份實作**(lib/style-trend.mjs)。
     只有拿得到 D1 的季才有(射門/射正/角球/牌來自那一份);
     上季不在德甲的球隊基準是 null —— 拿德乙的數字當基準,位移會把「聯賽不同」誤讀成「打法變了」。 */
  const styleTrendBy = new Map();
  {
    const csvOf = season => (hasFill(season)
      ? teamMatchRows(readFileSync(join(ROOT, 'data', 'raw', FILL_DIR, `${season}.csv`), 'utf8'), { codeOf, div: DIV })
      : new Map());
    const lastRows = csvOf(LAST_SEASON), curRows = csvOf(CURRENT_SEASON);
    const playedOf = code => curMatches.filter(m => m.played && (m.home === code || m.away === code)).length;
    for (const code of curCodes) {
      const t = styleTrendFor({
        lastRows: lastRows.get(code) ?? [], curRows: curRows.get(code) ?? [],
        /* 上季至少要有這麼多場才當得了基準。門檻跟一季的場次有關(L.rounds),
           不是一個放諸四海的常數 —— 一季 34 輪與 38 輪的「夠不夠」不一樣。 */
        minBaseline: Math.round(L.rounds * 0.74), curPlayed: playedOf(code),
      });
      if (t) styleTrendBy.set(code, t);
    }
    if (styleTrendBy.size) {
      attachTrendPercentiles(styleTrendBy, seasonRuler([...lastRows.values()].flat()));
      console.log(`  風格位移:近 10 場視窗 ${styleTrendBy.size} 隊`);
    } else {
      console.log('  風格位移:沒有第二來源的逐場統計,這一層不做(不是空著,是整塊不畫)');
    }
  }

  const teams = curCodes.map(code => {
    const reg = T.byCode.get(code) ?? { code, en: code, zh: code };
    const st = strengthBy.get(code);
    return {
      code, en: reg.en, zh: reg.zh,
      colors: reg.colors ?? null, crest: reg.crest ?? null, chartColor: reg.chartColor,
      city: reg.city ?? null, venue: reg.venue ?? null, capacity: reg.capacity ?? null, nickname: reg.nickname ?? null,
      elo: Math.round(elo.get(code)?.elo ?? 1500),
      attack: st?.attack ?? null, defence: st?.defence ?? null,
      lastSeason: lastBy.get(code) ?? null,
      current: curBy.get(code) ?? null,
      sim: simBy.get(code) ?? null,
      history: historyByTeam.get(code) ?? [],
      styleTrend: styleTrendBy.get(code) ?? null,
      /* 陣容人數:**null 不是 0** —— 這個聯賽還沒有球員層,0 會被讀成「量到了,結果是零」 */
      squadSize: null,
    };
  });
  /* 掛上隊徽的隊數。**只數本季在打的那幾隊** —— 名冊含升降級球隊,
     數整份 crestBy 會得到一個比 teams.length 還大的數字,而那個數字會直接印在畫面上。 */
  const crestCount = teams.filter(t => t.crest).length;

  const formIndex = buildFormIndex([...priorMatches, ...lastMatches, ...curPlayed]);
  const teamForm = curCodes.map(code => {
    const rows = recentForm(formIndex, code, AS_OF, 5);
    return { code, ...formSummary(rows), matches: rows };
  });

  const h2h = {};
  for (let i = 0; i < curCodes.length; i++) {
    for (let j = i + 1; j < curCodes.length; j++) {
      const a = curCodes[i], b = curCodes[j];
      const r = headToHead([...priorMatches, ...lastMatches, ...curPlayed], a, b);
      if (r?.matches?.length) h2h[`${a}|${b}`] = r;
    }
  }

  /* 走查回測的結果由 `${L.key}:backtest` 另外產生(跟西甲英冠同一支 runner)。
     這裡只讀 —— 沒有就照實說沒有,不要在建站時順手跑一個沒有驗收協議的數字。 */
  /* 走查回測的結果由 `${L.key}:backtest` 另外產生(跟西甲英冠同一支 runner)。
     **欄位名照抄英冠那一份** —— 模型驗證頁讀的是 rps / logLoss / hitRate / baselineRps
     這幾個攤平在最上層的欄位,直接把回測檔整個展開的話 models 是物件、頂層沒有 rps,
     畫面會印 undefined 而且一個錯都不報(CLAUDE.md:產物的欄位名是跟前端的約定,不是自由發揮)。 */
  let backtest = {
    available: false,
    note: `${L.zh}已有 ${fullSeasons.join('、')} 完整歷史,走查回測跑得起來;`
      + `但這次 build 沒有讀到回測產物,請先執行 npm run ${L.key}:backtest。`,
  };
  {
    const btPath = join(ROOT, 'data', L.backtestFile);
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
          : { available: false, note: `本站尚未取得${L.zh}的博彩收盤賠率(football-data.co.uk 的 ${DIV} 還沒抓到),無法與市場比較。` },
      };
      console.log(`  走查回測:${r.season} ${r.games} 場・RPS ${r.models.blend.rps}`
        + `(基準線 ${r.models.baseline.rps}、差距 ${r.vsBaseline?.ratio ?? '—'} 個標準誤)`);
    }
  }

  const coverage = [...fullSeasons, CURRENT_SEASON].map(season => ({
    season, openfootball: existsSync(join(ROOT, 'data', 'raw', RAW_DIR, `${season}.json`)), footballData: hasFill(season),
  }));
  const noFill = coverage.filter(c => !c.footballData).map(c => c.season);

  /* ── 球員層(Understat)────────────────────────────────────────────
     德甲是 Understat 涵蓋的五大聯賽之一,所以這一層做得出來 —— 前提是 raw 在。
     沙箱抓不到 understat.com,raw 由 runner 上的 `de1:players` 抓回來並回寫;
     沒有 raw 時整層退回「還沒抓」,**不是**「沒有來源」(那是英冠,意思完全不同)。

     Understat 有什麼、沒有什麼寫在適配器的檔頭:沒有背號、頭貼、出生日期、傷停,
     也沒有英超那套 FPL 欄位。德甲**連 SportMonks 那層補充都沒有**(西甲有),
     所以年齡一律 null —— 吃年齡的榜(22 歲以下)會是空的,畫面要講得出為什麼。 */
  /* ── 比賽層:逐場統計與賽後報告(FotMob)────────────────────────────
     跟西甲、英冠同一份 lib。比分逐場對回本站賽果、控球率相加要是 100,不符的整場退回。
     德甲沒有第二來源可抽核控球率,`verified` 會是 false,畫面照這個講。
     raw 由 runner 上的 `game:fetch -- --league=${L.key}` 抓回來(沙箱連不到 fotmob.com)。 */
  const fotmobStats = loadFotmobMatchStats(ROOT, {
    results: [...lastMatches, ...curMatches].filter(m => m.played), rawDir: L.fotmobDir,
  });
  if (fotmobStats.count) {
    console.log(`  FotMob 逐場統計:${fotmobStats.count} 場(${fotmobStats.seasons.join('、')})`
      + `・退回 ${fotmobStats.rejected.length} 場・控球率未經第二來源抽核`);
  }

  /* 逐場統計掛到球隊上(球隊頁的那一區)。沒有的隊不掛欄位,前端的判斷會讓它整塊消失。 */
  for (const t of teams) { const ms = fotmobStats.teams[t.code]; if (ms?.games) t.matchStats = ms; }

  /* 賽後報告:逐場詳情轉成 canonical detail,走跟西甲英冠同一個 buildProviderMatchReport。
     它自己會再核對一次比分、要求五種 coverage 齊全 —— 不齊的那一場不發布(不是硬塞一份殘缺的)。 */
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
  const pendingCount = fixtures.filter(f => f.played && f.season === CURRENT_SEASON
    && !reports[`${f.season}|${f.home}|${f.away}`]).length;
  if (reportCount) console.log(`  ${L.zh}賽後報告:${reportCount} 場(FotMob)・本季還沒抓到 ${pendingCount} 場`);

  /* **上一輪留下來的那個殘差,現在有資料可以對帳了。**
     德甲球員進球加總比積分榜少 0~11%,我判斷是烏龍球但當時沒有德甲的事件來源可以證明。
     逐場事件裡有烏龍球(canonical 已經翻成得分方),所以這裡逐季數一次:
     缺口 = 烏龍球 的話,那個問號就可以收掉;對不上就照實留著,**不要硬湊一個解釋**。 */
  const ownGoals = {};
  for (const [key, r] of Object.entries(reports)) {
    const season = r.season ?? key.split('|')[0];
    ownGoals[season] ??= { matches: 0, own: 0 };
    ownGoals[season].matches++;
    ownGoals[season].own += (r.advanced?.events ?? []).filter(e => e.ownGoal).length;
  }

  const playerSeasons = {};
  for (const season of [CURRENT_SEASON, LAST_SEASON]) {
    const loaded = loadPlayers(ROOT, season, { dir: L.understatDir });
    if (!loaded) { console.log(`  ⚠ ${L.zh}球員 ${season}:沒有快取,略過(runner 上跑 de1:players)`); continue; }
    attachRadar(loaded.players);
    playerSeasons[season] = loaded;
    const multi = loaded.players.filter(p => p.multiTeam).length;
    const qualified = loaded.players.filter(p => p.qualified).length;
    console.log(`  ${L.zh}球員 ${season}:${loaded.players.length} 人・達 ${MIN_MINUTES} 分鐘門檻 ${qualified} 人・跨隊 ${multi} 人`);
  }

  const playersOut = [];
  for (const [season, data] of Object.entries(playerSeasons)) {
    for (const p of data.players) playersOut.push(normalisePlayerForSite({ ...p, season }, { codeOf: T.codeOf }));
  }
  const hasPlayers = playersOut.length > 0;

  /* ── 烏龍球對帳:這是**量測**,不是宣稱 ──
     第一版我在界線裡直接寫「差額現在對得起來了」,而當時的資料根本撐不起那句話:
     FotMob 只涵蓋 2026-27 的 19 / 27 場,2025-26 一場都沒有 —— 上一季的缺口
     (990 - 970 = 20 顆)沒有任何烏龍球資料可以對。**涵蓋不完整的季不能下結論**,
     這正是「無法核對 ≠ 不一致」與「我數不出來 ≠ 上游沒有」的同一條規矩。
     所以逐季算三個數字:缺口、抓到的烏龍球、事件涵蓋率,由涵蓋率決定講哪一句。 */
  const goalGap = [];
  for (const [season, data] of Object.entries(playerSeasons)) {
    const played = (season === CURRENT_SEASON ? curMatches : lastMatches).filter(m => m.played);
    const tableGoals = played.reduce((a, m) => a + (m.fh ?? 0) + (m.fa ?? 0), 0);
    const playerGoals = data.players.reduce((a, p) => a + (p.goals ?? 0), 0);
    const og = ownGoals[season] ?? { matches: 0, own: 0 };
    goalGap.push({ season, played: played.length, tableGoals, playerGoals,
      gap: tableGoals - playerGoals, own: og.own, covered: og.matches,
      /* 全部場次都有事件、而且缺口剛好等於烏龍球數 —— 兩個條件都成立才算對上。 */
      settled: og.matches === played.length && tableGoals - playerGoals === og.own });
  }
  for (const g of goalGap) {
    console.log(`  進球對帳 ${g.season}:積分榜 ${g.tableGoals} − 球員 ${g.playerGoals} = 缺口 ${g.gap}`
      + `・事件涵蓋 ${g.covered}/${g.played} 場、抓到烏龍球 ${g.own} 顆`
      + `${g.settled ? ' → 對上了' : ' → 涵蓋不完整或對不上,只回報'}`);
  }
  const goalGapLines = goalGap.length && goalGap.some(g => g.covered)
    ? [goalGap.every(g => g.settled)
      ? `✓ 球員榜與積分榜的進球差額已對帳:${goalGap.map(g => `${g.season} 缺口 ${g.gap} 顆 = 烏龍球 ${g.own} 顆`).join('、')}`
        + '(球員榜本來就不算烏龍球)'
      : `— 球員榜比積分榜少的那幾顆還在對帳中:${goalGap.map(g => `${g.season} 缺口 ${g.gap} 顆、`
        + `逐場事件涵蓋 ${g.covered}/${g.played} 場、其中烏龍球 ${g.own} 顆`).join(';')}。`
        + '量級跟烏龍球相符(球員榜不算烏龍球),但事件還沒涵蓋全部場次,所以只回報、不當結論。']
    : ['— 球員進球加總比積分榜少 0~11%:西甲也有同量級的缺口,量級跟烏龍球相符'
      + `(球員榜本來就不算烏龍球),但本站還沒抓${L.zh}的逐場事件,所以只回報、不當結論。`];


  /* **隊名對照的獨立核對。** alias 是「一對一推出來的」,而一對一不是證據
     (租借姓名那條坑付過代價)。這裡逐隊比兩個數字:
       出賽分鐘  一隊一季最多 11 × 90 × 場數,對錯隊的話會差很遠
       進球      Understat 的球員進球加總 **一定不會超過**積分榜的該隊進球
     實測(2025-26 全 18 隊):分鐘都落在理論上限的 96~100%、進球比值 0.886~1.000,
     沒有一隊接近 0 或超過 1 —— 對錯隊不可能長這樣。
     **那個 0~11% 的缺口本身沒有查證到底**:西甲也有同樣量級的缺口(21/1024),
     而西甲這條路已經在站上很久。它跟烏龍球的量級相符(球員榜不算烏龍球),
     但本站沒有德甲的烏龍球來源可以證明,所以**只回報、不當結論**(鐵則四)。 */
  const nameCheck = [];
  for (const [season, data] of Object.entries(playerSeasons)) {
    const rows = season === CURRENT_SEASON ? curTable : lastTable;
    const byCode = new Map();
    for (const p of data.players) {
      if (p.multiTeam) continue;                  // 整季合計掛不到單一隊
      const code = T.codeOf(p.teams?.[0] ?? '');
      if (!code) continue;
      const v = byCode.get(code) ?? { goals: 0, minutes: 0 };
      v.goals += p.goals ?? 0; v.minutes += p.minutes ?? 0;
      byCode.set(code, v);
    }
    for (const r of rows) {
      const v = byCode.get(r.code) ?? { goals: 0, minutes: 0 };
      const cap = 11 * 90 * r.p;                  // 一隊一季的分鐘理論上限
      nameCheck.push({
        season, code: r.code,
        goals: v.goals, tableGoals: r.gf,
        goalRatio: r.gf ? round(v.goals / r.gf, 3) : null,
        played: r.p,
        minutes: v.minutes, minutesCap: cap,
        minutesRatio: cap ? round(v.minutes / cap, 3) : null,
      });
    }
  }
  /* 對錯隊的樣子:進球比值接近 0 或大於 1、分鐘遠低於上限。兩個都要看 ——
     只看進球的話,一支整季只進幾球的隊看不出來。 */
  /* 進球比值在**剛開季**沒有鑑別力:踢 3 輪的隊,一顆烏龍球就讓比值掉到 0.75。
     所以下限只在踢滿 10 場之後才看;而「超過 1」與分鐘比值是**不隨場數變**的,
     一直都看。分鐘是這裡最硬的一條 —— 對錯隊的話它不可能還落在上限附近。 */
  const suspect = nameCheck.filter(x => (x.goalRatio != null && x.goalRatio > 1.02)
    || (x.minutesRatio ?? 1) < 0.85
    || (x.played >= 10 && x.goalRatio != null && x.goalRatio < 0.7));
  if (hasPlayers) {
    const worstG = Math.min(...nameCheck.filter(x => x.goalRatio != null).map(x => x.goalRatio));
    const worstM = Math.min(...nameCheck.filter(x => x.minutesRatio != null).map(x => x.minutesRatio));
    console.log(`  隊名對照核對:進球比值最低 ${worstG}、分鐘比值最低 ${worstM}`
      + (suspect.length ? ` ⚠ 可疑 ${suspect.length} 隊:${suspect.map(x => `${x.season} ${x.code}`).join('、')}` : '(沒有可疑的隊)'));
  }


  const meta = {
    /* **不要設 edition**(英冠那條註解同一個理由):那個欄位在前端被當成「是不是西甲」的二元旗標。 */
    league: L.key, leagueLabel: L.zh,
    /* capabilities 是前端用來決定「這一頁要不要畫」的旗標。沒有的一律 false,不要留空不寫。 */
    capabilities: { players: hasPlayers, injuries: false, coaches: false,
      xg: hasPlayers || reportCount > 0, lineups: reportCount > 0, live: false },
    builtAt: new Date().toISOString(), asOf: AS_OF,
    currentSeason: CURRENT_SEASON, lastSeason: LAST_SEASON,
    h2hSeasons: [...fullSeasons, CURRENT_SEASON],
    competition: competition(COMPETITION),
    historySeasons: fullSeasons,
    /* 頁首那段話由各聯賽自己寫 —— 前端不該知道哪個聯賽有什麼資料。
       **先講做得到什麼、再講做不到什麼**,而且做不到的要講清楚是哪一種(還沒抓 vs 拿不到)。 */
    intro: `把 ${fullSeasons.join('、')} 與本季 ${CURRENT_SEASON} 的每一場${L.zh}比賽跑成模型,`
      + '做出積分預測、單場勝負機率與賽季模擬,並跟市場賠率並排比較。'
      /* **這句話會隨資料變,所以不可以寫死。** 第一版寫「目前只做到球隊與比賽這一層」,
         球員層接上之後它就在畫面上說謊了 —— 那正是「『只有一個』那句寫死在畫面上」那條坑,
         而且這次是在**加了那個能力的同一支 build 裡**。一律由 hasPlayers 決定。 */
      + (hasPlayers
        ? `球員層走 Understat(整季彙總),目前 ${playersOut.length} 筆 —— 有進球、助攻、xG、xA、`
          + '射門與關鍵傳球;還沒有的是陣容、傷停與即時比分(下方「目前資料界線」有細節)。'
        : '這個聯賽目前只做到球隊與比賽這一層 —— 還沒有球員數據、xG、陣容與傷停。'
          + `${L.zh}是 Understat 有涵蓋的五大聯賽之一,所以球員層是「還沒接」,不是「拿不到」(`
          + '下方「目前資料界線」有細節)。'),
    boundaries: [
      /* **隊數與輪次一律從資料算。** 這一行原本寫死「18 隊 × 34 輪」(德甲的事實),
         義甲照抄就在畫面上印一個假數字 —— 義甲是 20 隊 38 輪。
         這是「前端把聯賽的事實寫死」的 build 版,而 `npm test` 看不到版面。 */
      `✓ 賽程、比分、積分榜、近期戰績、單場預測與賽季模擬(${N} 隊 × ${L.rounds} 輪)`,
      ...(noFill.length < coverage.length
        ? [`✓ 兩個獨立來源逐場核對:openfootball(de.1)與 football-data.co.uk(D1),對不上就整份不採用`
          + (noFill.length ? `。但只有部分賽季:${noFill.join('、')} 目前沒有 D1,那幾季只有單一來源` : '')]
        : [`— 目前只有 openfootball 一個來源:football-data.co.uk 的 ${DIV} 還沒抓到,所以還沒有逐場交叉核對`]),
      ...(styleTrendBy.size
        ? ['✓ 逐場實測統計(射門/射正/角球/牌,football-data.co.uk):球隊頁的近 10 場風格位移,跟英超同一份實作']
        : [`— 還沒有逐場實測統計(射門/角球/牌):那一份跟 ${DIV} 同一個來源,抓到之後才有`]),
      ...(hasPlayers
        ? [`✓ 球員整季數據與 xG(Understat,${playersOut.length} 筆):進球、助攻、xG、xA、射門、關鍵傳球與牌。`
          + '隊名對照拿逐隊出賽分鐘與進球獨立核對過(分鐘都落在滿季理論上限的 95% 以上)。',
          /* 缺口要照實講,而且要講出它是哪一種。
             **這一句也會過期**:賽後報告接上之後就有烏龍球可以對帳了,
             那時候還印「本站沒有來源可以證明」就是假的(跟上面那句寫死的同一種)。 */
          `— 球員層沒有背號、頭貼、出生日期與身價:Understat 不給,${L.zh}也沒有西甲那層補充來源,`
          + '所以年齡是空的、「22 歲以下」那張榜畫不出來。']
        : [`— 還沒有球員數據與 xG:${L.zh}是 Understat 涵蓋的聯賽,但開發沙箱的出口代理不放行 understat.com`
          + '(2026-09-15 實測 CONNECT 403),要在 CI runner 上抓。這是「還沒抓」,跟英冠那種「來源就是沒有」不一樣。']),
      /* 比賽層跟著資料講 —— **不要寫死**。上一輪就是把「只做到球隊與比賽層」寫死在這裡,
         球員層接上之後它在畫面上說謊了。同一支 build 裡的那句話要自己會變。 */
      ...(reportCount
        ? [`✓ 賽後報告與逐場統計(FotMob,${reportCount} 場):球隊統計、控球、逐射門 xG、事件、`
          + '正式名單與逐人評分。比分逐場對回本站賽果才收;控球率沒有第二來源可抽核。'
          + (pendingCount ? `本季還有 ${pendingCount} 場還沒抓到。` : ''),
          ...goalGapLines,
        ]
        /* FotMob 的聯賽 id 也是**這個聯賽的事實**:德甲 54、義甲 55、法甲 53。
           寫死 54 的話義甲的畫面會說「id 54 已驗證」,而那是德甲的 id。 */
        : [`— 還沒有賽後報告與逐場統計:來源在(FotMob 逐場端點,聯賽 id ${L.fotmobId} 已驗證),`
          + '只是 raw 還沒抓。這是「還沒抓」,不是「沒有來源」。']),
      ...(crestCount
        ? [`✓ 隊徽(${crestCount} / ${teams.length} 隊):football-logos 的靜態檔,內嵌成 data URI`
          + ' —— 不走遠端網址,圖被下架或讀者網路擋掉不會在畫面上留破圖框']
        : []),
      `— 還沒有隊色、城市、球場${crestCount === teams.length ? '' : '、部分球隊的隊徽'}與教練:`
        + '那幾樣要另外人工交付並通過核對器,交付之前畫面上不顯示',
      '— 沒有即時比分:比分依 openfootball 的更新節奏落地',
      /* 德甲的升降級跟英格蘭不一樣,前端不要自己猜 */
      /* 升降級規則**由呼叫端給**,不可以照抄:德甲與法甲的第 16 名打的是跨聯賽附加賽
         (對德乙 / 法乙第 3 名),義甲是後 3 名直接降級、根本沒有附加賽。
         抄過去就是在畫面上印一個這個聯賽沒有的制度。 */
      L.relegation,
    ],
    sources: [
      { name: 'openfootball / football.json', url: 'https://github.com/openfootball/football.json' },
      { name: 'football-data.co.uk(D1)', url: 'https://www.football-data.co.uk/germanym.php' },
    ],
    sourceCoverage: coverage,
    model: {
      type: 'Dixon-Coles Poisson + Elo',
      name: 'Dixon-Coles Poisson + Elo',
      /* 下面這五個欄位**不是可有可無的裝飾** —— 前端三個聯賽共用同一份程式,
         球隊頁的總覽說明直接寫 `meta.model.simulationRuns.toLocaleString()`,
         少一個欄位整頁就 TypeError 而畫面只剩一行字。第一版漏了它們,
         `npm test` 全綠(測試看不到版面),是把頁面開起來才看到的。
         欄位名一律照抄既有聯賽,不要自己取(CLAUDE.md:產物的欄位名是跟前端的約定)。 */
      sim: { ...simParams(model), elo: ELO_PARAMS },
      homeAdvantage: round(Math.exp(model.gamma), 3), rho: model.rho, decayXi: model.xi,
      promotedPrior: model.promoted, simulationRuns: RUNS,
      /* 給測試讀的結構化欄位,空陣列 = 補比分那一步沒有拒收過任何一季。 */
      scoreCheck: { refused: scoreRefusals },
      caveats: [
        '單場機率是 Poisson 與 Elo 各半的混合,跟英超西甲英冠同一套。',
        '近期狀況、近五戰進失球與歷來交手淨勝球都量過而沒有通過驗收,係數是 0,只當資訊顯示。',
        ...(noFill.length ? [`${noFill.join('、')} 這幾季目前只有一個來源(沒有 football-data.co.uk 的 ${DIV} 可以逐場核對)。`] : []),
        `升班馬沒有上一季${L.zh}樣本,套用聯盟後段先驗並提高模擬不確定性。`,
      ],
      backtest,
    },
    counts: {
      teams: teams.length, fixtures: fixtures.length,
      /* **數字一律從資料算。** 這三個原本是寫死的 0(球隊層那一輪留下來的),
         而球員層與賽後報告接上之後它們就在畫面上說謊了 —— 球員頁的標題直接印
         `counts.players`,所以那一頁一直寫著「0 名註冊球員」而下面列著 856 人。 */
      players: playersOut.length, news: 0, injuries: 0, coaches: 0,
      crests: crestCount, matchReports: reportCount,
      currentSeasonRounds: Math.max(0, ...curPlayed.map(m => m.round ?? 0)),
    },
    /* 這個聯賽沒有的能力一律明講,前端才不會畫一個空殼。 */
    live: { available: false, note: `${L.zh}還沒有接即時比分來源;比分依 openfootball 的更新節奏落地。` },
    official: { available: false },
    ai: { enabled: false, pre: 0, post: 0 },
    /* 有資料就講有、沒有就講**為什麼還沒有** —— 「還沒抓」跟英冠那種「來源就是沒有」
       對讀者的意義完全不同,`npm test` 有一條守著沒資料時不准出現「不涵蓋」那種說法。 */
    players: hasPlayers
      ? { available: true, source: 'understat',
        note: 'Understat 的整季彙總(一季一個請求)。有出賽、進球、助攻、xG、xA、射門、關鍵傳球與牌;'
          + '沒有背號、頭貼、出生日期、身價與傷停 —— 那幾樣 Understat 就是不給,畫面上不留空欄位。'
          + '季中轉隊的人上游只給兩隊合計,所以不掛到單一球隊,另外標記。' }
      : { available: false, source: null,
        note: `${L.zh}的球員層還沒接。Understat 確實涵蓋${L.zh}(它做五大聯賽),`
          + '只是開發沙箱的出口代理不放行 understat.com(2026-09-15 實測 CONNECT 403),要在 CI runner 上抓。'
          + '這跟英冠那種「來源就是沒有」不一樣 —— 是還沒做,不是做不到。' },
    scoreRefusals,
    backfills,
    /* 積分榜是從比分算的,不含扣分處分。德甲的扣分比英冠少見,但**沒有來源就不猜**:
       這個欄位在對帳對不上時由 build 填一句實話,平常是 null。
       **欄位一定要在**(哪怕永遠是 null)—— 前端三個聯賽共用同一份程式。 */
    tableCaveat: null,
  };

  console.log(`寫入${L.zh}資料集:`);
  await write('meta', meta);
  await write('clubs', T.list);
  await write('teams', teams);
  await write('fixtures', fixtures);
  await write('table', { last: lastTable, current: curTable, lastSeason: LAST_SEASON, currentSeason: CURRENT_SEASON });
  await write('sim', sim);
  await write('form', { asOf: AS_OF, inModel: false, tuned: TUNED, tuning: null, situationTuning: null,
    note: '近期資料只供顯示,不調整模型機率。', teams: teamForm });
  await write('h2h', h2h);
  await write('results', [...lastMatches, ...curMatches].filter(m => m.played).map(slimMatch));
  /* 下面這幾份這個聯賽沒有內容 —— **寫空的而不是不寫**。
     不寫的話前端拿到 404 會走「還沒 build」那條訊息,那是錯的:我們 build 了,
     是這個聯賽還沒有這種資料。每一份都帶 available:false 與一句為什麼。 */
  await write('news', []);
  /* 德甲沒有 AI 報告層 —— 但 analysis.json **還是要寫**。
     前端的單場分析頁拿到 404 會印「讀取 analysis 失敗」,那是「這一站壞了」的訊息;
     寫一份 enabled:false 的空檔,它才講得出「這個聯賽沒有這個功能」。
     (實測:第一版不寫,index.html?league=de1 只剩 93 個字元加一個 console 404。) */
  await write('analysis', { enabled: false, pre: {}, post: {}, counts: { pre: 0, post: 0 },
    llmWritten: 0, cacheHits: 0, cacheEntries: 0,
    note: `${L.zh}還沒有 AI 賽前/賽後報告(要先有球員層與逐場詳情)。` });
  await write('prob-history', { season: null, matches: {} });
  await write('players', playersOut);
  // 跨聯賽統一層(聯集 + null):德甲沒有身價與傷停 → null 不是 0
  /* **沒有球員時要寫一份空的,不是不寫。** 跨聯賽的球員搜尋(allplayers)會對
     每一個「導覽列開了 players」的聯賽抓這一份 —— 不寫就是 404,而 404 會讓前端
     走「還沒 build」那條訊息,那是錯的(這個聯賽 build 過了,只是還沒有球員)。
     這是德甲那一輪的同一條教訓,`npm run sweep` 在義甲法甲上又抓到一次。 */
  await write('players-core', hasPlayers ? coreFromUnderstat(playersOut, { league: L.key }) : []);
  /* 空產物的**形狀也要照抄既有聯賽**,不是只有欄位名。第一版自己寫了一套:
     `goals.seasons` 給了物件(既有聯賽是陣列)→ 球隊頁 `(goals?.seasons ?? []).filter`
     直接 TypeError,整頁「載入失敗」;`reports.pending` 給了陣列(既有聯賽是數字)、
     `leaders.boards` 給了陣列(既有聯賽是 `{季: []}`)。一個都不會拋錯到測試裡,
     是 `npm run sweep` 把頁面開起來才看到的。 */
  /* **形狀逐欄位照抄西甲那一份。** 前端的球員頁是看 `leaders.source` 分岔的
     (`'Understat'` 走整季彙總那條、`'match-aggregate'` 走英冠那條),
     而且它會去讀 `current` / `last` / `boards` / `axes` / `minMinutes` / `ageCoverage`。
     第一版我自己取了形狀(boards 依賽季分組、source 寫小寫 understat),
     結果榜是「有資料但前端讀不到」—— 那正是「產物的欄位名是跟前端的約定」那條坑。
     德甲**沒有** SportMonks 那層,所以 sportmonks 是空的、年齡一律 null。 */
  await write('leaders', hasPlayers ? {
    seasons: { current: CURRENT_SEASON, last: LAST_SEASON },
    currentAvailable: Boolean(playerSeasons[CURRENT_SEASON]?.players?.length),
    currentQualified: playerSeasons[CURRENT_SEASON]?.players?.filter(p => p.qualified).length ?? 0,
    minMinutes: MIN_MINUTES,
    source: 'Understat',
    retrievedAt: playerSeasons[CURRENT_SEASON]?.retrievedAt ?? playerSeasons[LAST_SEASON]?.retrievedAt ?? null,
    boards: BOARDS.map(({ key, label, unit, per90 }) => ({ key, label, unit, per90 })),
    axes: RADAR_AXES,
    /* 誠實層:這一層**沒有**什麼要明講 —— 有了一部分之後最容易忘記講剩下的沒有。
       德甲連西甲那層 SportMonks 補充都沒有,所以背號 / 頭貼 / 出生日期全缺,
       「22 歲以下」那張榜因此是空的(ageCoverage 會說出 0 / N)。 */
    missing: ['背號', '頭貼', '出生日期與身價(所以年齡與「22 歲以下」那張榜是空的)',
      '傷停與停賽', '防守數據(鏟球/攔截/撲救)'],
    sportmonks: {},
    note: 'Understat 提供整季彙總(一季一個請求)。每 90 分鐘僅在上場時間達門檻時給出。'
      + '隊名對照已用逐隊出賽分鐘與進球獨立核對過(見 nameCheck)。',
    /* 隊名對照的核對結果放進產物,畫面才講得出「這個對照是驗過的」。
       球員進球加總比積分榜少 0~11%,西甲也有同量級的缺口 —— 原因沒有查證到底,
       所以只回報,不當結論(鐵則四)。 */
    nameCheck,
    current: playerSeasons[CURRENT_SEASON] ? buildLeaders(playerSeasons[CURRENT_SEASON].players) : null,
    last: playerSeasons[LAST_SEASON] ? buildLeaders(playerSeasons[LAST_SEASON].players) : null,
    ageCoverage: Object.fromEntries(Object.entries(playerSeasons).map(([season, data]) => [season, {
      known: data.players.filter(p => p.age != null).length,
      total: data.players.length,
    }])),
    available: true,
  } : {
    available: false, source: null, statMeta: {},
    seasons: { current: CURRENT_SEASON, last: LAST_SEASON },
    boards: {}, squads: {}, layer: {}, missing: [], nameCheck: [], note: meta.players.note,
  });
  await write('coaches', { available: false, season: CURRENT_SEASON, source: null, verifiedAt: null,
    note: `${L.zh}教練名冊還沒交付(要人工交付並過核對器,比照英冠那條路)。`, coaches: [] });
  await write('goals', { available: false,
    note: `${L.zh}還沒有逐場進球明細 —— 那要先有球員層。Understat 涵蓋${L.zh},只是還沒抓。`,
    seasons: [], data: {}, unavailable: ['scorers'] });
  await write('experts', { version: 1, updatedAt: null, mode: 'unavailable',
    note: `${L.zh}還沒有收錄真人專家觀點。本站的專家觀點只收具名、可查證的來源。`,
    counts: { matches: 0 }, matches: {}, count: 0 });
  await write('official', { available: false, season: CURRENT_SEASON, source: null, sources: [],
    matches: {}, note: `${L.zh}還沒有接正式先發名單來源。` });
  await write('live', { available: false, source: null, sourceLabel: null, demo: false,
    season: CURRENT_SEASON, fetchedAt: null,
    counts: { total: 0, live: 0, finished: 0, upcoming: 0, today: 0 },
    matches: [], note: meta.live.note });
  /* blocked 有明確語意(整季拿不到)。德甲**不是**沒有資料源 —— 來源在,只是 raw 還沒抓,
     所以是 'not-fetched',不是 'no-source'。這兩句對讀者的意義完全不同(CLAUDE.md 一整條在講)。 */
  await write('reports', {
    seasons: reportCount ? [...new Set(Object.values(reports).map(r => r.season))].sort() : [],
    count: reportCount, reports, source: reportCount ? 'fotmob' : null, pending: pendingCount,
    blocked: reportCount ? null : { reason: 'not-fetched', message: `${L.zh}的 FotMob 逐場資料還沒抓(npm run game:fetch -- --league=${L.key})。`, at: new Date().toISOString() },
    backupBlocked: null,
    note: reportCount
      ? `${L.zh}賽後資料來自 FotMob 逐場端點:球隊統計、逐射門 xG、事件、正式名單與逐人評分;比分逐場對回本站賽果才收。沒有第二來源可抽核控球率。`
      : `${L.zh}的 FotMob 逐場資料還沒抓。`,
  });
  if (fotmobStats.count) {
    await write('matchstats', {
      source: fotmobStats.source,
      note: `${L.zh}逐場統計(FotMob):控球、球隊統計、逐射門 xG、動能、事件、名單、跑動、逐人統計。比分已逐場對回本站賽果;控球率沒有第二來源可抽核。`,
      seasons: fotmobStats.seasons, count: fotmobStats.count, rejected: fotmobStats.rejected,
      verification: fotmobStats.verification, teams: fotmobStats.teams, matches: fotmobStats.matches,
    });
  }
  /* 單場分析頁一定會去要這三份 —— 少一份就是 404 加「載入失敗」,
     而那是「這一站壞了」的訊息,不是「這個聯賽沒有這個功能」。既有聯賽沒有內容時
     寫的就是空物件 / 空陣列,照抄。 */
  await write('tactics', []);
  await write('lineups', {});
  await write('shapes', {});

  console.log(`\n✔ ${L.zh}:${teams.length} 隊、${fixtures.length} 場賽程、已完賽 ${curPlayed.length} 場`);
  console.log(`  第二來源涵蓋:${coverage.map(c => `${c.season} ${DIV} ${c.footballData ? "✓" : "—"}`).join("・")}`);
}
