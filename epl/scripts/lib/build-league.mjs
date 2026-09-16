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
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { leagueMatches, backfillLine, europeanKickoff, fotmobBackfillLine } from './league-matches.mjs';
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
import { leagueKnowledge } from './knowledge.mjs';


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
  /* 人工交付的隊色、城市、球場、容量、綽號。**只讀核對後的產物,不讀收件匣** ——
     直接讀收件匣等於把核對繞過去(比照租借與英冠那兩條)。
     收件匣改過卻沒重跑核對時 sha 對不上,整批不掛並印出原因,
     不會拿舊的核對結果替新內容背書。交付還沒到就什麼都不做,畫面照舊標「未取得」。 */
  const delivered = new Map();
  let deliveryNote = null;
  if (L.deliveryFile && L.deliveryInbox) {
    const vPath = join(ROOT, 'data', L.deliveryFile);
    const inboxPath = join(ROOT, 'data', 'manual', L.deliveryInbox);
    if (existsSync(vPath) && existsSync(inboxPath)) {
      const v = JSON.parse(await readFile(vPath, 'utf8'));
      const sha = createHash('sha256').update(await readFile(inboxPath)).digest('hex');
      if (!v.accepted) {
        deliveryNote = `球隊資料交付未通過核對(${v.problems.length} 項),整批不採用。`;
      } else if (v.inboxSha !== sha) {
        deliveryNote = `收件匣改過但沒重跑核對(sha 對不上),整批不採用 —— 請跑 npm run ${L.key}:verify-teams。`;
      } else {
        for (const rec of v.teams) delivered.set(rec.code, rec.fields);
      }
      if (deliveryNote) console.log(`  ⚠ ${deliveryNote}`);
      /* **對照題是 null 不是 0**:這三個聯賽沒有對照組,講出來比印一個 0 誠實 */
      else console.log(`  球隊資料交付:${delivered.size} 隊`
        + (v.controlTeams == null ? '(這個聯賽沒有對照組,把關靠逐欄位出處)' : `(對照題 ${v.controlTeams} 支)`));
    }
  }

  for (const t of T.list) {
    Object.assign(t, delivered.get(t.code) ?? {});
    t.chartColor = intoBand(t.colors?.[0]) ?? '#9aa0aa';
    if (crestBy.has(t.code)) t.crest = crestBy.get(t.code);
  }

  /* 哪幾季有第二來源。**這件事要進產物** —— 把關強度逐季不同而畫面不講,
     等於讓讀者以為每一季一樣可靠。 */
  const hasFill = season => existsSync(join(ROOT, 'data', 'raw', FILL_DIR, `${season}.csv`));
  const scoreRefusals = [];
  const backfills = [];

  const load = season => {
    /* **第三來源要傳進去,不然抓了也沒人用。** `fotmobDir` 原本只給逐場詳情用,
       沒有傳給 `leagueMatches` —— 於是 `scores.json` 抓回來躺在 raw 裡,
       比分還是只能等 football-data.co.uk 的天級節奏(2026-09-16 補)。
       採用規矩跟英冠西甲同一份:FotMob 補的標暫定,兩邊都有的場次要逐場一致,
       對不上整份不採用而且記進 `scoreRefusals`(鐵則五)。 */
    const { matches, backfill, fotmob } = leagueMatches(ROOT, season, {
      codeOf, kickoffOf: berlinKickoff,
      competition: COMPETITION, rawDir: RAW_DIR, fillDir: FILL_DIR, div: DIV,
      fotmobDir: L.fotmobDir,
      fill: hasFill(season),
    });
    const line = backfillLine(season, backfill);
    if (line) console.log(line);
    const fmLine = fotmobBackfillLine(season, fotmob);
    if (fmLine) console.log(fmLine);
    if (backfill?.filled) backfills.push({ season, ...backfill });
    for (const [src, r] of [['football-data.co.uk', backfill], ['FotMob', fotmob]]) {
      if (r?.mismatches?.length) {
        scoreRefusals.push({ season, source: src, count: r.mismatches.length, sample: r.mismatches.slice(0, 5) });
      } else if (r?.duplicateKeys) {
        scoreRefusals.push({ season, source: src, duplicateKeys: true, count: 0, sample: [] });
      }
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

  /* 上游若先填入未來賽果,基準日之後一律當未賽 —— 模型不可以偷看未來。
     **兩個暫定旗標也要一起清掉**:第三來源(FotMob)補比分時會標 `scoreProvisional`
     與 `scoreSource`,而這裡只清 played / fh / fa 的話,那一場會變成
     「未賽、沒有比分,卻掛著『FotMob 暫定賽果』」——自己跟自己矛盾的狀態。
     接第三來源進德義法時用假快照重現出來的(真的 FotMob 不會把未來場次報成完賽,
     但清狀態就是要把不一致的組合清乾淨,不是賭上游不會那樣給)。 */
  for (const m of curMatches) {
    if (m.date > AS_OF && m.played) {
      Object.assign(m, { played: false, fh: null, fa: null, hh: null, ha: null });
      delete m.scoreProvisional; delete m.scoreSource;
    }
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
  /* 走**兩季**的已完賽場次,不是只走 `fixtures`(那只有本季)。
     2026-09-16 回填上一季的逐場資料時踩到:raw 從 27 場變成 333 場,而下面的烏龍球對帳
     仍然印「事件涵蓋 0/306 場」—— 看起來像回填沒有用,實際上是**回填進來的那一季根本沒被走到**,
     因為報告只建在本季賽程上,而對帳數的正是報告裡的事件。
     發布的仍然只有本季(`reports` 產物,跟其他四個聯賽一致);上一季的報告是另一件事
     —— 那會讓產物大十倍,要另外決定。所以**建立的母體**與**發布的範圍**分開。 */
  for (const f of [...lastMatches, ...curMatches]) {
    if (!f.played) continue;
    const ms = fotmobStats.matches?.[`${f.season}|${f.home}|${f.away}`];
    if (!ms) continue;
    const report = buildProviderMatchReport({ fixture: f, detail: toCanonicalDetail(ms, { verified: false }), nameOf });
    if (report) reports[`${f.season}|${f.home}|${f.away}`] = report;
  }
  const publishedReports = Object.fromEntries(
    Object.entries(reports).filter(([k]) => k.startsWith(`${CURRENT_SEASON}|`)));
  const reportCount = Object.keys(publishedReports).length;
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
  /* **逐季講,不要用一句話蓋住兩季。** 2026-09-16 回填上一季之後真的出現混合狀態:
     德甲 2025-26 對上了(缺口 20 = 烏龍球 20、涵蓋 306/306),而 2026-27 還沒
     (缺口 4、烏龍球 3)。舊寫法只有「全部對上」與「全部還沒對上」兩支,
     混合時會走後者,於是畫面上對著一季已經涵蓋滿的資料寫「事件還沒涵蓋全部場次」——
     那是假的。而且**沒對上的理由有兩種**(還沒涵蓋滿 / 涵蓋滿了但還差幾顆),
     要分開講,不然讀者不知道是等資料還是真的有出入。 */
  const seasonClause = g => (g.settled
    ? `${g.season} 缺口 ${g.gap} 顆 = 烏龍球 ${g.own} 顆(逐場事件涵蓋 ${g.covered}/${g.played} 場),對上了`
    : `${g.season} 缺口 ${g.gap} 顆、逐場事件涵蓋 ${g.covered}/${g.played} 場、其中烏龍球 ${g.own} 顆`);
  const whyUnsettled = goalGap.filter(g => !g.settled).map(g => (g.covered < g.played
    ? `${g.season} 的事件還沒涵蓋全部場次`
    : `${g.season} 的事件已涵蓋全部場次,但缺口比烏龍球${g.gap > g.own ? '多' : '少'} ${Math.abs(g.gap - g.own)} 顆`));
  const goalGapLines = goalGap.length && goalGap.some(g => g.covered)
    ? [goalGap.every(g => g.settled)
      ? `✓ 球員榜與積分榜的進球差額已對帳:${goalGap.map(seasonClause).join(';')}`
        + '(球員榜本來就不算烏龍球)'
      : `— 球員榜比積分榜少的那幾顆:${goalGap.map(seasonClause).join(';')}。`
        + `量級跟烏龍球相符(球員榜不算烏龍球),而 ${whyUnsettled.join(';')};`
        + `所以${whyUnsettled.length > 1 ? '那幾季' : '那一季'}只回報、不當結論。`]
    /* **這個百分比一定要從資料算。** 第一版寫死「少 0~11%」—— 那是德甲量出來的,
       照抄給義甲法甲就是在畫面上編數字(鐵則一沒有「只是一句說明」這種例外)。 */
    : [`— 球員進球加總比積分榜少:${goalGap.map(g => `${g.season} 缺 ${g.gap} 顆`
      + `(${g.tableGoals ? round((g.gap / g.tableGoals) * 100, 1) : 0}%)`).join('、')}。`
      + '量級跟烏龍球相符(積分榜算烏龍球,球員榜不算),但本站還沒抓'
      + `${L.zh}的逐場事件,沒有東西可以核對,所以只回報、不當結論。`];


  /* **隊名對照的獨立核對。** alias 是「一對一推出來的」,而一對一不是證據
     (租借姓名那條坑付過代價)。這裡逐隊比 Understat 與積分榜的兩個數字。

     **兩個數字都是「區間」而不是「一個值」**,因為季中轉隊的人上游只給兩隊合計,
     拆不開 —— 掛到任何一隊都是編數字,所以下限不掛;但「不掛」不等於「不算」,
     他確實在這個聯賽踢了那些分鐘、進了那些球,只是分不出哪一部分屬於哪一隊,
     所以進上限。真值一定落在區間裡,而**隊名對錯的話下限與上限會一起塌到 0**,
     鑑別力一點都沒少。

     這一段被自己咬過兩次,兩次方向相反:
       第一版兩邊都把那些人整個丟掉 → 轉會多的隊看起來就像對錯了隊
         (法甲 2025-26 REN 的進球只算到 37 / 59 —— Esteban Lepaul 整季 21 球掛在
          `Angers,Rennes`;義甲 2025-26 CAG 的分鐘只剩理論上限的 0.898,
          因為三個轉隊的人的分鐘一分都沒算進去)
       第二版把合計**整個加到每一隊** → 變成重複計算,德甲本來乾淨的兩隊
         (FCA / M05,正是 `Augsburg,Mainz 05` 那一串)反而被標成可疑

     判法是「理論值有沒有落在區間裡」,沒有魔術門檻:
       分鐘  一隊一季最多 11 × 90 × 場數,這個上限要落在區間裡。
             實測三個聯賽全季共 56 隊,區間上緣最低 0.995 —— 紅牌與碼表差
             落在 ±0.5%,所以容差留 5%(十倍餘裕);對錯隊會差幾十個百分點
       進球  區間下限**一定不會超過**積分榜的該隊進球(烏龍球只加在積分榜那一邊)

     **早季兩邊涵蓋的場次不是同一批**:實測 2026-27 德甲有幾隊 Understat 已經算到
     第 3 輪、openfootball 的賽果還停在第 2 輪,於是分鐘比值是 1.5、進球也超過積分榜
     —— 兩邊都沒有錯。那種記成 `coverage` 只回報、不判可疑(「先問我的分母跟被比較的
     那一邊是不是同一批」)。

     **它測不出什麼要講清楚**:兩支差不多大的隊互換,總量看起來會一樣,這個核對測不出來。
     它測得出的是「這個隊碼接到空的」與「接到一支大小差很多的隊」—— 而 alias 缺漏
     正是前者:義甲的 ROM 就是這樣抓到的(Understat 寫 `Roma`、名冊只有 `AS Roma`,
     寬鬆比對只去**字尾**的法人形式、不去字首的 AS,於是整隊一個球員都沒接到)。 */
  const MIN_TOL = 0.05;
  const blankCheck = () => ({ goals: 0, minutes: 0, multiGoals: 0, multiMinutes: 0, multiN: 0 });
  const nameCheck = [];
  for (const [season, data] of Object.entries(playerSeasons)) {
    const rows = season === CURRENT_SEASON ? curTable : lastTable;
    const byCode = new Map();
    const touch = code => {
      if (!byCode.has(code)) byCode.set(code, blankCheck());
      return byCode.get(code);
    };
    for (const p of data.players) {
      if (p.multiTeam) {
        for (const t of (p.teams ?? [])) {
          const code = T.codeOf(t);
          if (!code) continue;
          const v = touch(code);
          v.multiGoals += p.goals ?? 0; v.multiMinutes += p.minutes ?? 0; v.multiN++;
        }
        continue;
      }
      const code = T.codeOf(p.teams?.[0] ?? '');
      if (!code) continue;
      const v = touch(code);
      v.goals += p.goals ?? 0; v.minutes += p.minutes ?? 0;
    }
    for (const r of rows) {
      const v = byCode.get(r.code) ?? blankCheck();
      const cap = 11 * 90 * r.p;                  // 一隊一季的分鐘理論上限
      const minutesLo = cap ? round(v.minutes / cap, 3) : null;
      const minutesHi = cap ? round((v.minutes + v.multiMinutes) / cap, 3) : null;
      // 區間整個在上限**之上** = Understat 比賽果多算了場次,不是隊名對錯
      const coverage = minutesLo != null && minutesLo > 1 + MIN_TOL;
      const thin = minutesHi != null && minutesHi < 1 - MIN_TOL;
      const overGoals = !coverage && r.gf != null && v.goals > r.gf;
      nameCheck.push({
        season, code: r.code, played: r.p, transfers: v.multiN,
        goalsLo: v.goals, goalsHi: v.goals + v.multiGoals, tableGoals: r.gf,
        minutes: v.minutes, minutesCap: cap, minutesLo, minutesHi,
        verdict: (thin || overGoals) ? 'suspect' : coverage ? 'coverage' : 'ok',
        why: thin ? '分鐘區間整個低於理論上限 —— 這個隊碼可能沒接到球員,或接到一支小很多的隊'
          : overGoals ? '掛得上去的進球已經超過積分榜的該隊進球(烏龍球只會往另一個方向)'
            : coverage ? 'Understat 涵蓋的場次比本站賽果多(早季常見),兩邊不是同一批,這一列不判'
              : null,
      });
    }
  }
  const nameJudgedRows = nameCheck.filter(x => x.verdict !== 'coverage' && x.minutesHi != null);
  const nameJudged = nameJudgedRows.length;
  const nameWorstHi = nameJudged ? Math.min(...nameJudgedRows.map(x => x.minutesHi)) : null;
  if (hasPlayers) {
    const suspect = nameCheck.filter(x => x.verdict === 'suspect');
    const coverage = nameCheck.filter(x => x.verdict === 'coverage');
    console.log(`  隊名對照核對:判了 ${nameJudged} 列、分鐘區間上緣最低 ${nameWorstHi}`
      + `(理論上限要落在區間裡,容差 ${MIN_TOL})`
      + (coverage.length ? `・${coverage.length} 列兩邊場次不同批,不判` : '')
      + (suspect.length ? ` ⚠ 可疑 ${suspect.length} 隊:${suspect.map(x => `${x.season} ${x.code}`).join('、')}`
        : '(沒有可疑的隊)'));
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
        /* **來源代碼也是這個聯賽的事實**,跟隊數輪次、FotMob id 同一類。
           這一行原本寫死 `de.1` 與 `D1`(德甲的),於是義甲法甲的資料界線上
           印著別的聯賽的來源代碼 —— 不拋錯、`npm test` 也看不到版面,
           是把義甲首頁開起來看才現形的(「照抄德甲」的第五、六處)。 */
        ? [`✓ 兩個獨立來源逐場核對:openfootball(${L.ofCode})與 football-data.co.uk(${DIV}),對不上就整份不採用`
          + (noFill.length ? `。但只有部分賽季:${noFill.join('、')} 目前沒有 D1,那幾季只有單一來源` : '')]
        : [`— 目前只有 openfootball 一個來源:football-data.co.uk 的 ${DIV} 還沒抓到,所以還沒有逐場交叉核對`]),
      ...(styleTrendBy.size
        ? ['✓ 逐場實測統計(射門/射正/角球/牌,football-data.co.uk):球隊頁的近 10 場風格位移,跟英超同一份實作']
        : [`— 還沒有逐場實測統計(射門/角球/牌):那一份跟 ${DIV} 同一個來源,抓到之後才有`]),
      ...(hasPlayers
        /* **這句話要講出核對實際做了什麼、量出來多少**,而不是複述一個寫死的門檻。
           上一版寫「分鐘都落在滿季理論上限的 95% 以上」—— 那既是寫死的數字,
           也已經不是這個核對在量的東西了(現在量的是「理論上限有沒有落在區間裡」,
           而區間下緣最低到 0.898,因為季中轉隊的人只給兩隊合計)。 */
        ? [`✓ 球員整季數據與 xG(Understat,${playersOut.length} 筆):進球、助攻、xG、xA、射門、關鍵傳球與牌。`
          + `隊名對照拿逐隊出賽分鐘與進球獨立核對過:${nameJudged} 隊季裡,`
          + '每一隊的分鐘區間(季中轉隊的人上游只給兩隊合計,拆不開,所以算成區間)都涵蓋'
          + `滿季理論上限 11 × 90 × 場數,區間上緣最低 ${nameWorstHi};沒有一隊的球員進球超過積分榜。`,
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
      { name: `openfootball / football.json(${L.ofCode})`, url: 'https://github.com/openfootball/football.json' },
      /* 網址指向**抓取器真的下載的那一支 CSV**,不是各國的索引頁 ——
         索引頁的檔名(germanym.php / spainm.php…)本站只證實過三個,
         剩下的憑印象填就是編一個網址出來。這個組法是 league-fetch.mjs 的同一條。 */
      { name: `football-data.co.uk(${DIV})`,
        url: `https://www.football-data.co.uk/mmz4281/${CURRENT_SEASON.slice(2, 4)}${CURRENT_SEASON.slice(-2)}/${DIV}.csv` },
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
       每一列帶著區間與 verdict,`coverage` 那種是「兩邊涵蓋的場次不同批」不是對錯
       —— 不分開的話,早季每個聯賽都會有一批看起來像錯的列。
       球員進球加總仍比積分榜少幾顆(逐季的實際數字在 boundaries 裡,不寫死),
       量級跟烏龍球相符但沒有查證到底,所以只回報、不當結論(鐵則四)。 */
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
  /* 足球知識的資料層。**這一份漏掉的代價是整個「探索」頁進不去** ——
     `explore.html` 的第一個分頁就 `C.load('knowledge')`,404 之後畫面停在
     「載入資料中…」不動,連錯誤訊息都沒有。德義法三個聯賽都是這樣壞的
     (英冠也是,那一份在 build-championship.mjs 補)。
     共識層是跨聯賽的人工資料,照嵌;背號與陣型這兩層算不出來就 null。 */
  {
    const kp = join(ROOT, 'data', 'manual', 'football-knowledge.json');
    const guide = existsSync(kp) ? JSON.parse(await readFile(kp, 'utf8')) : null;
    await write('knowledge', leagueKnowledge({ season: CURRENT_SEASON, guide, players: playersOut }));
  }
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
    seasons: reportCount ? [...new Set(Object.values(publishedReports).map(r => r.season))].sort() : [],
    count: reportCount, reports: publishedReports, source: reportCount ? 'fotmob' : null, pending: pendingCount,
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
