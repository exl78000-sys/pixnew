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
 * 所以這個聯賽做得出來的是「球隊與比賽」那一層,做不出來的是球員、xG、陣容。
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leagueMatches, backfillLine } from './lib/league-matches.mjs';
import { competition } from './lib/canonical.mjs';
import { loadTeams } from './lib/teams.mjs';
import { buildTable, headToHead, teamRecord } from './lib/table.mjs';
import { fitPoisson, applyPromotedPrior, predict, strengthTable } from './lib/poisson.mjs';
import { buildElo, eloProbs } from './lib/elo.mjs';
import { simulateSeason } from './lib/simulate.mjs';
import { buildFormIndex, recentForm, formSummary, TUNED } from './lib/form.mjs';
import { upcomingOdds } from './lib/odds.mjs';
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

const lastSunday = (year, month) => {
  const d = new Date(Date.UTC(year, month, 0));
  return d.getUTCDate() - d.getUTCDay();
};
/* 英格蘭是 Europe/London:夏令 BST(+01:00)、冬令 GMT(+00:00)。
   adapter 的預設 kickoffOf 固定補 +01:00 —— 那是給西歐用的,
   照用的話冬季場次會整批早一小時,倒數計時與「幾點開賽」全錯。 */
const londonKickoff = m => {
  if (!m.time) return null;
  const [year, month, day] = m.date.split('-').map(Number);
  const summer = (month > 3 && month < 10)
    || (month === 3 && day >= lastSunday(year, 3))
    || (month === 10 && day < lastSunday(year, 10));
  return `${m.date}T${m.time}:00${summer ? '+01:00' : '+00:00'}`;
};

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
  for (const t of T.list) {
    if (crestBy.has(t.code)) t.crest = crestBy.get(t.code);
    /* 隊色還沒取得(見名冊的 _pending)。缺色時退中性灰 —— 畫面上看得出來是沒有,
       比隨便給一個顏色好:給了顏色讀者會以為那是球隊的顏色。 */
    t.chartColor = intoBand(t.colors?.[0]) ?? intoBand(t.colors?.[1]) ?? '#9aa0aa';
  }
  const crestCount = crestBy.size;

  const backfills = [];
  const load = season => {
    const { matches, backfill } = leagueMatches(ROOT, season, {
      codeOf, kickoffOf: londonKickoff,
      competition: COMPETITION, rawDir: RAW_DIR, fillDir: FILL_DIR, div: 'E1',
      /* 升級附加賽不是聯賽比賽:場地中立、單場定生死,而且只有四隊打。
         算進積分榜會多算分,進 Poisson 訓練會把季末四強的額外樣本混進主客場參數。
         **而且它跟聯賽撞「主客組合」這個鍵**,所以要在補比分之前就標出來。
         標了之後積分榜與模型都排除 —— 但留在賽果裡,那些比賽真的發生過。 */
      stageOf: m => (m.round == null ? '升級附加賽' : null),
    });
    const line = backfillLine(season, backfill);
    if (line) console.log(line);
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

  const trainMatches = [...priorMatches, ...lastLeague, ...curPlayed];
  const model = applyPromotedPrior(fitPoisson(trainMatches, curCodes, { refDate: AS_OF }));
  const elo = buildElo(trainMatches);
  const strengthBy = new Map(strengthTable(model).map(x => [x.code, x]));

  /* 市場賠率。fixtures.csv 是**全歐洲一份**,`npm run odds` 早就下載了 ——
     英冠(Div=E1)本來就在裡面,重抓一次是白費請求。 */
  let marketBy = {};
  const futureOdds = join(ROOT, 'data', 'raw', 'football-data-couk', 'fixtures.csv');
  if (existsSync(futureOdds)) {
    const r = upcomingOdds(readFileSync(futureOdds, 'utf8'), { codeOf, div: 'E1' });
    marketBy = r.byMatch;
    if (r.unmatched?.length) console.log(`  ⚠ 英冠賠率隊名未對上:${r.unmatched.join('、')}`);
    console.log(`  市場賠率:${r.count} 場`);
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
      market: marketBy[`${m.home}|${m.away}`] ?? null,
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

  const teams = curCodes.map(code => {
    const reg = T.byCode.get(code);
    const ls = lastBy.get(code) ?? null;
    const current = curBy.get(code) ?? null;
    return {
      ...reg,
      lastSeason: ls ? {
        pos: ls.pos, p: ls.p, w: ls.w, d: ls.d, l: ls.l,
        gf: ls.gf, ga: ls.ga, gd: ls.gd, pts: ls.pts, ppg: ls.ppg,
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
     沒有譯文快取:英冠沒有接翻譯,標題與摘要維持原文。 */
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
    console.log(`  外電:${externalNews.length} 則`);
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
    capabilities: { players: false, injuries: false, coaches: false, xg: false, lineups: false, live: false },
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
      '— 沒有球員數據與 xG:Understat 不涵蓋英冠(2026-08-28 實測四種聯賽代碼皆回空陣列,'
      + '而同一個請求 EPL 回 537 人、西甲回 600 人),FPL 只有英超。**這是驗證過的沒有,不是還沒做**',
      '— 沒有教練、傷停、正式陣容與賽後統計;隊色與球場資料尚未取得,所以圖表暫時是中性灰',
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
  await write('meta', meta);
  await write('clubs', T.list);
  await write('teams', teams);
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
  /* 球員、教練、進球明細:英冠**沒有免費來源**(見檔頭的實測)。
     寫空的而不是不寫,而且每一份都帶 available:false 與一句為什麼 ——
     前端要能分得出「還沒 build」與「這個聯賽沒有這種資料」,
     那是兩句完全不同的話,給錯讀者會以為網站壞了。 */
  const noPlayerData = 'Understat 不涵蓋英冠(2026-08-28 實測 Championship / EFL_Championship / '
    + 'English_Championship / ENG_Championship 四種寫法皆回空陣列,而同一個請求 EPL 回 537 人、'
    + '西甲回 600 人,getTeamData 對英冠球隊一律 404),FPL 只有英超。';
  await write('players', []);
  await write('leaders', { available: false, note: noPlayerData, boards: [] });
  await write('coaches', { available: false, note: '英冠教練名冊尚未取得,見 docs/英冠-球隊資料-交付提示詞.md。', season: CURRENT_SEASON, coaches: [] });
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
  await write('live', {
    available: false, source: null, sourceLabel: null, demo: false,
    season: CURRENT_SEASON, fetchedAt: null, counts: { live: 0, today: 0 },
    /* **live.matches 是陣列,official/experts 的 matches 是物件。**
       同一個名字兩種型別,照著別的檔案抄很容易抄反 —— 寫成 {} 的話
       單場分析頁在 `(live?.matches ?? []).find(...)` 直接拋錯。以 es1 的產物為準。 */
    matches: [],
    note: '英冠沒有接即時比分來源;比分依 openfootball 與 football-data.co.uk 的更新節奏落地。',
  });
  /* reports 的形狀要跟另外兩個聯賽一樣(seasons / count / reports 是個以
     「賽季|主|客」為鍵的物件)。第一版自己編了 {pre,post},
     fixture-list 去讀 reports.reports[key] 就炸了 —— 又一次自己取名字的代價。

     blocked 這個欄位有明確語意(整季拿不到,CLAUDE.md 有一整條在講):
     英冠是**根本沒有這個資料源**,不是方案不含本季,所以照實寫原因。 */
  await write('reports', {
    seasons: [], count: 0, reports: {}, source: null, pending: [],
    blocked: { reason: 'no-source', message: '英冠沒有接賽後資料源(本站的 SportMonks / API-Football 方案不含英冠)。', at: new Date().toISOString() },
    backupBlocked: null,
    note: '英冠沒有賽後球隊統計、正式陣容與球員評分。',
  });
  await write('analysis', { enabled: false, pre: {}, post: {}, counts: { pre: 0, post: 0 } });

  console.log(`\n✔ 英冠:${teams.length} 隊、${fixtures.length} 場賽程、隊徽 ${crestCount}/${T.list.length}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exit(1); });
