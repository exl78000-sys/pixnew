#!/usr/bin/env node
/* 德甲(Bundesliga)資料集 → web/data/leagues/de1/
 *
 * ── 這個聯賽現在做得到什麼、做不到什麼 ──
 *
 * 做得到的是「球隊與比賽」那一層:賽程、賽果、積分榜、近況、交手紀錄、
 * 單場勝負機率、賽季模擬、市場賠率對照、走查回測。**跟英冠第一版同一個範圍**。
 *
 * 做不到的是球員層 —— 但理由跟英冠**不一樣**,不要照抄英冠那句話:
 *   英冠是「Understat 不涵蓋這個聯賽」(實測過的否定,永遠不會有)。
 *   德甲**是**五大聯賽之一,Understat 有它 —— 只是開發沙箱的出口代理不放行
 *   understat.com(2026-09-15 實測 CONNECT 403),所以要在 CI runner 上抓。
 * 也就是說德甲的球員層是「還沒抓」,不是「拿不到」。這兩句對讀者的意義完全不同,
 * 畫面上要照實講(鐵則三與鐵則四)。
 *
 * ── 兩個來源 ──
 *   openfootball de.1.json           賽程骨架 + 賽果 + 半場 + 輪次(主來源)
 *   football-data.co.uk D1           賽果 + 逐場統計(射門/角球/牌)+ 賠率(獨立來源)
 *
 * 兩份的重疊場次逐場核對走 `lib/league-matches.mjs` —— 跟西甲、英冠**同一份實作**:
 * 有一場不符就整份不採用。
 *
 * **第二來源不是每一季都有。** 沙箱抓不到 football-data.co.uk,倉庫裡目前只有
 * 2023-24 與 2024-25(教練任期那一輪抓的);本季與上季要在 runner 上跑 `de1:fetch` 才會有。
 * 沒有第二來源的季:不補比分、不做逐場核對、沒有逐場統計與賠率 —— 全部照實記進產物
 * (`meta.sourceCoverage`),畫面照它講,**不要讓讀者以為每一季的把關強度一樣**。
 *
 * ── 隊名對照 ──
 * `data/manual/teams-bundesliga.json` 的 `of` / `fd` 兩欄都是**從真實資料掃出來的**,
 * 不是憑印象填的(檔案的 _note 寫了怎麼來的)。build 會把對不上的隊名印出來 ——
 * 英冠那次 14 支球隊靜靜對不上、畫面完全正常,靠的就是看那一行輸出。
 *
 *   npm run de1:build
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leagueMatches, backfillLine, europeanKickoff } from './lib/league-matches.mjs';
import { competition } from './lib/canonical.mjs';
import { loadTeams } from './lib/teams.mjs';
import { buildTable, headToHead, teamRecord } from './lib/table.mjs';
import { teamMatchRows, styleTrendFor, attachTrendPercentiles, seasonRuler } from './lib/style-trend.mjs';
import { fitPoisson, applyPromotedPrior, predict, strengthTable, simParams } from './lib/poisson.mjs';
import { buildElo, eloProbs, ELO_PARAMS } from './lib/elo.mjs';
import { simulateSeason } from './lib/simulate.mjs';
import { buildFormIndex, recentForm, formSummary, TUNED } from './lib/form.mjs';
import { upcomingOdds, seasonMarket, pickMarket } from './lib/odds.mjs';
import { pickPair, intoBand } from './lib/colour.mjs';
import { round } from './lib/util.mjs';
/* 跨聯賽球員搜尋的統一層。**開了球員頁就一定要寫這一份** ——
   `allplayers-view.js` 與 `core.js` 的 crossLeaguePlayers 都是看
   `LEAGUES[lg].open` 有沒有 players 才去要它的,沒寫就是一個保證 404,
   而畫面只是「搜尋德甲球員什麼都搜不到」,不報錯。 */
import { coreFromUnderstat } from './lib/player-core.mjs';
/* 球員層跟西甲**共用同一支適配器**(只有 dir 不同)—— Understat 兩邊的欄位是
   同一組,那是 probe-understat-bundesliga.mjs 逐欄位比對過的,不是假設。 */
import { loadPlayers, buildLeaders, attachRadar, normalisePlayerForSite, BOARDS, RADAR_AXES, MIN_MINUTES }
  from './lib/adapters/understat-players.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'data', 'leagues', 'de1');
const COMPETITION = 'ger.1';
const RAW_DIR = 'openfootball-bundesliga';
const FILL_DIR = 'football-data-couk-bundesliga';
const DIV = 'D1';

const LAST_SEASON = '2025-26';
const CURRENT_SEASON = '2026-27';
const PRIOR_SEASONS = ['2023-24', '2024-25'];
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const AS_OF = arg('as-of') ?? new Date().toISOString().slice(0, 10);
const RUNS = Number(arg('runs') ?? 5000);

/* 德國是 Europe/Berlin:夏令 CEST(+02:00)、冬令 CET(+01:00)。
   adapter 的預設 kickoffOf 固定補 +01:00 —— 照用的話夏季場次會整批晚一小時。
   DST 規則共用 lib 那一份,不自己再寫(英冠用倫敦、西甲用馬德里,同一個函式)。 */
const berlinKickoff = europeanKickoff({ summer: '+02:00', winter: '+01:00' });

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

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log(`▶ 建立德甲資料集(基準日 ${AS_OF},模擬 ${RUNS} 次)\n`);

  const T = loadTeams(ROOT, { file: 'teams-bundesliga.json' });
  /* D1 的隊名是簡稱(Bayern Munich、M'gladbach、Ein Frankfurt),跟 openfootball 的全名對不上。
     **不走 loadTeams 的寬鬆比對** —— 那條路徑會把 FC 前後綴一起吃掉,本站在盃賽頁被它咬過兩次。
     這裡用名冊的 fd 欄逐隊精確對照(名字怎麼來的見 teams-bundesliga.json 的 _note)。 */
  const byFd = new Map(T.list.filter(t => t.fd).map(t => [t.fd, t.code]));
  const codeOf = name => byFd.get(name) ?? T.codeOf(name);

  /* 隊徽、隊色、城市這些**目前都還沒有**(要另外人工交付並過核對器)。
     缺色時退中性灰 —— 畫面上看得出來是沒有,比隨便給一個顏色好。 */
  for (const t of T.list) t.chartColor = intoBand(t.colors?.[0]) ?? '#9aa0aa';

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
    throw new Error(`德甲隊數不符:${LAST_SEASON}=${lastCodes.length}、${CURRENT_SEASON}=${curCodes.length}(應為 ${N})`);
  }
  if (curCodes.includes(null) || lastCodes.includes(null)) {
    throw new Error('有隊名對不到隊碼 —— 名冊(teams-bundesliga.json)要補,不要讓它靜靜掉隊');
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
    if (r.unmatched?.length) console.log(`  ⚠ 德甲賠率隊名未對上:${r.unmatched.join('、')}`);
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
        minBaseline: 25, curPlayed: playedOf(code),   // 德甲一季 34 場
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

  /* 走查回測的結果由 `de1:backtest` 另外產生(跟西甲英冠同一支 runner)。
     這裡只讀 —— 沒有就照實說沒有,不要在建站時順手跑一個沒有驗收協議的數字。 */
  /* 走查回測的結果由 `de1:backtest` 另外產生(跟西甲英冠同一支 runner)。
     **欄位名照抄英冠那一份** —— 模型驗證頁讀的是 rps / logLoss / hitRate / baselineRps
     這幾個攤平在最上層的欄位,直接把回測檔整個展開的話 models 是物件、頂層沒有 rps,
     畫面會印 undefined 而且一個錯都不報(CLAUDE.md:產物的欄位名是跟前端的約定,不是自由發揮)。 */
  let backtest = {
    available: false,
    note: `德甲已有 ${fullSeasons.join('、')} 完整歷史,走查回測跑得起來;`
      + '但這次 build 沒有讀到回測產物,請先執行 npm run de1:backtest。',
  };
  {
    const btPath = join(ROOT, 'data', 'backtest-bundesliga.json');
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
          : { available: false, note: '本站尚未取得德甲的博彩收盤賠率(football-data.co.uk 的 D1 還沒抓到),無法與市場比較。' },
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
  const playerSeasons = {};
  for (const season of [CURRENT_SEASON, LAST_SEASON]) {
    const loaded = loadPlayers(ROOT, season, { dir: 'understat-bundesliga' });
    if (!loaded) { console.log(`  ⚠ 德甲球員 ${season}:沒有快取,略過(runner 上跑 de1:players)`); continue; }
    attachRadar(loaded.players);
    playerSeasons[season] = loaded;
    const multi = loaded.players.filter(p => p.multiTeam).length;
    const qualified = loaded.players.filter(p => p.qualified).length;
    console.log(`  德甲球員 ${season}:${loaded.players.length} 人・達 ${MIN_MINUTES} 分鐘門檻 ${qualified} 人・跨隊 ${multi} 人`);
  }

  const playersOut = [];
  for (const [season, data] of Object.entries(playerSeasons)) {
    for (const p of data.players) playersOut.push(normalisePlayerForSite({ ...p, season }, { codeOf: T.codeOf }));
  }
  const hasPlayers = playersOut.length > 0;

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
    league: 'de1', leagueLabel: '德甲',
    /* capabilities 是前端用來決定「這一頁要不要畫」的旗標。沒有的一律 false,不要留空不寫。 */
    capabilities: { players: hasPlayers, injuries: false, coaches: false, xg: hasPlayers, lineups: false, live: false },
    builtAt: new Date().toISOString(), asOf: AS_OF,
    currentSeason: CURRENT_SEASON, lastSeason: LAST_SEASON,
    h2hSeasons: [...fullSeasons, CURRENT_SEASON],
    competition: competition(COMPETITION),
    historySeasons: fullSeasons,
    /* 頁首那段話由各聯賽自己寫 —— 前端不該知道哪個聯賽有什麼資料。
       **先講做得到什麼、再講做不到什麼**,而且做不到的要講清楚是哪一種(還沒抓 vs 拿不到)。 */
    intro: `把 ${fullSeasons.join('、')} 與本季 ${CURRENT_SEASON} 的每一場德甲比賽跑成模型,`
      + '做出積分預測、單場勝負機率與賽季模擬,並跟市場賠率並排比較。'
      + '這個聯賽目前只做到球隊與比賽這一層 —— 還沒有球員數據、xG、陣容與傷停。'
      + '德甲是 Understat 有涵蓋的五大聯賽之一,所以球員層是「還沒接」,不是「拿不到」('
      + '下方「目前資料界線」有細節)。',
    boundaries: [
      '✓ 賽程、比分、積分榜、近期戰績、單場預測與賽季模擬(18 隊 × 34 輪)',
      ...(noFill.length < coverage.length
        ? [`✓ 兩個獨立來源逐場核對:openfootball(de.1)與 football-data.co.uk(D1),對不上就整份不採用`
          + (noFill.length ? `。但只有部分賽季:${noFill.join('、')} 目前沒有 D1,那幾季只有單一來源` : '')]
        : ['— 目前只有 openfootball 一個來源:football-data.co.uk 的 D1 還沒抓到,所以還沒有逐場交叉核對']),
      ...(styleTrendBy.size
        ? ['✓ 逐場實測統計(射門/射正/角球/牌,football-data.co.uk):球隊頁的近 10 場風格位移,跟英超同一份實作']
        : ['— 還沒有逐場實測統計(射門/角球/牌):那一份跟 D1 同一個來源,抓到之後才有']),
      '— 還沒有球員數據與 xG:德甲是 Understat 涵蓋的聯賽,但開發沙箱的出口代理不放行 understat.com'
        + '(2026-09-15 實測 CONNECT 403),要在 CI runner 上抓。這是「還沒抓」,跟英冠那種「來源就是沒有」不一樣。',
      '— 還沒有隊色、城市、球場、隊徽與教練:那幾樣要另外人工交付並通過核對器,交付之前畫面上不顯示',
      '— 沒有即時比分:比分依 openfootball 的更新節奏落地',
      /* 德甲的升降級跟英格蘭不一樣,前端不要自己猜 */
      '德甲的升降級:後 2 名直接降級,第 16 名跟德乙第 3 名打附加賽 —— 那是「跨聯賽」的比賽,'
        + '本站沒有德乙的資料評不出對手強度,所以模擬只給冠軍 / 前四 / 直接降級,不給附加賽的勝負機率',
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
        ...(noFill.length ? [`${noFill.join('、')} 這幾季目前只有一個來源(沒有 football-data.co.uk 的 D1 可以逐場核對)。`] : []),
        '升班馬沒有上一季德甲樣本,套用聯盟後段先驗並提高模擬不確定性。',
      ],
      backtest,
    },
    counts: {
      teams: teams.length, fixtures: fixtures.length,
      players: 0, news: 0, injuries: 0, coaches: 0, crests: 0,
      currentSeasonRounds: Math.max(0, ...curPlayed.map(m => m.round ?? 0)),
    },
    /* 這個聯賽沒有的能力一律明講,前端才不會畫一個空殼。 */
    live: { available: false, note: '德甲還沒有接即時比分來源;比分依 openfootball 的更新節奏落地。' },
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
        note: '德甲的球員層還沒接。Understat 確實涵蓋德甲(它做五大聯賽),'
          + '只是開發沙箱的出口代理不放行 understat.com(2026-09-15 實測 CONNECT 403),要在 CI runner 上抓。'
          + '這跟英冠那種「來源就是沒有」不一樣 —— 是還沒做,不是做不到。' },
    scoreRefusals,
    backfills,
    /* 積分榜是從比分算的,不含扣分處分。德甲的扣分比英冠少見,但**沒有來源就不猜**:
       這個欄位在對帳對不上時由 build 填一句實話,平常是 null。
       **欄位一定要在**(哪怕永遠是 null)—— 前端三個聯賽共用同一份程式。 */
    tableCaveat: null,
  };

  console.log('寫入德甲資料集:');
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
    note: '德甲還沒有 AI 賽前/賽後報告(要先有球員層與逐場詳情)。' });
  await write('prob-history', { season: null, matches: {} });
  await write('players', playersOut);
  // 跨聯賽統一層(聯集 + null):德甲沒有身價與傷停 → null 不是 0
  if (hasPlayers) await write('players-core', coreFromUnderstat(playersOut, { league: 'de1' }));
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
    note: '德甲教練名冊還沒交付(要人工交付並過核對器,比照英冠那條路)。', coaches: [] });
  await write('goals', { available: false,
    note: '德甲還沒有逐場進球明細 —— 那要先有球員層。Understat 涵蓋德甲,只是還沒抓。',
    seasons: [], data: {}, unavailable: ['scorers'] });
  await write('experts', { version: 1, updatedAt: null, mode: 'unavailable',
    note: '德甲還沒有收錄真人專家觀點。本站的專家觀點只收具名、可查證的來源。',
    counts: { matches: 0 }, matches: {}, count: 0 });
  await write('official', { available: false, season: CURRENT_SEASON, source: null, sources: [],
    matches: {}, note: '德甲還沒有接正式先發名單來源。' });
  await write('live', { available: false, source: null, sourceLabel: null, demo: false,
    season: CURRENT_SEASON, fetchedAt: null,
    counts: { total: 0, live: 0, finished: 0, upcoming: 0, today: 0 },
    matches: [], note: meta.live.note });
  await write('reports', { seasons: [], count: 0, reports: {}, source: null,
    note: '德甲還沒有賽後報告(要逐場詳情來源)。', pending: 0, blocked: null, backupBlocked: null });
  /* 單場分析頁一定會去要這三份 —— 少一份就是 404 加「載入失敗」,
     而那是「這一站壞了」的訊息,不是「這個聯賽沒有這個功能」。既有聯賽沒有內容時
     寫的就是空物件 / 空陣列,照抄。 */
  await write('tactics', []);
  await write('lineups', {});
  await write('shapes', {});

  console.log(`\n✔ 德甲:${teams.length} 隊、${fixtures.length} 場賽程、已完賽 ${curPlayed.length} 場`);
  console.log(`  第二來源涵蓋:${coverage.map(c => `${c.season} ${c.footballData ? 'D1 ✓' : 'D1 —'}`).join('・')}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); console.error(err.stack); process.exit(1); });
