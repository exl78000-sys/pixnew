#!/usr/bin/env node
// 把原始資料 + 分析引擎的結果,產生成前端可直接讀的 JSON 資料集。
// 用法: npm run build [--as-of=YYYY-MM-DD] [--runs=10000]
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPETITION, CURRENT_SEASON, LAST_SEASON, HISTORY_SEASONS, ATTRIBUTION } from './lib/sources.mjs';
import { loadTeams } from './lib/teams.mjs';
import { loadMatches, loadSquads } from './lib/adapters/index.mjs';
import { competition as competitionDef, seasonLength } from './lib/canonical.mjs';
import { buildTable, headToHead } from './lib/table.mjs';
import { buildElo, eloProbs } from './lib/elo.mjs';
import { fitPoisson, applyPromotedPrior, predict, strengthTable } from './lib/poisson.mjs';
import { simulateSeason } from './lib/simulate.mjs';
import { buildPlayers, leaderboards, aggregateSeason } from './lib/players.mjs';
import { buildTactics, formationImpact } from './lib/tactics.mjs';
import { projectXI } from './lib/lineup.mjs';
import { buildClassifier, rolePools, roleFormation, phaseShapes, countRoles, standardShape } from './lib/roles.mjs';
import { buildCoaches } from './lib/coaches.mjs';
import { officialFormations, officialLineups, officialManagers, attachCodes } from './lib/adapters/pulselive.mjs';
import { injuryFeed, dataStories, previewStories, scheduleStories } from './lib/news.mjs';
import { buildMatchReport } from './lib/matchreport.mjs';
import {
  preMatchBundle, postMatchBundle, generateReport, ReportCache, llmEnabled,
} from './lib/report/index.mjs';
import { parseCSVObjects, num } from './lib/csv.mjs';
import { upcomingOdds } from './lib/odds.mjs';
import { pickPair } from './lib/colour.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'data');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const AS_OF = arg('as-of') || new Date().toISOString().slice(0, 10);
const RUNS = Number(arg('runs') || 10000);
// 賽前分析只寫最近幾場:整季 380 篇對讀者沒意義,對 LLM 帳單也不友善
const AI_PREVIEW_COUNT = Number(arg('ai-previews') || 20);

const write = async (name, data) => {
  const path = join(OUT, name);
  await writeFile(path, JSON.stringify(data));
  const kb = (JSON.stringify(data).length / 1024).toFixed(0);
  console.log(`  ✓ ${name.padEnd(16)} ${kb.padStart(5)} KB`);
};

// FPL 官方的賽程難度(1~5),照 (主,客) 配對接到 openfootball 賽程上
function loadDifficulty(root, codeOf, teamById) {
  const path = join(root, 'data', 'raw', 'fpl', `${CURRENT_SEASON}-fixtures.csv`);
  if (!existsSync(path)) return { byPair: new Map(), byTeam: new Map() };
  const rows = parseCSVObjects(readFileSync(path, 'utf8'));
  const byPair = new Map(), byTeam = new Map();
  for (const r of rows) {
    const h = teamById.get(r.team_h)?.code, a = teamById.get(r.team_a)?.code;
    if (!h || !a) continue;
    const hd = num(r.team_h_difficulty), ad = num(r.team_a_difficulty);
    // FPL 的 kickoff_time 是 UTC 且會反映轉播改期,比 openfootball 的預設時段準
    byPair.set(`${h}|${a}`, { home: hd, away: ad, event: num(r.event), kickoff: r.kickoff_time || null });
    for (const [code, diff, opp, isHome] of [[h, hd, a, true], [a, ad, h, false]]) {
      if (!byTeam.has(code)) byTeam.set(code, []);
      byTeam.get(code).push({ event: num(r.event), diff, opp, home: isHome, kickoff: r.kickoff_time });
    }
  }
  for (const list of byTeam.values()) list.sort((x, y) => x.event - y.event);
  return { byPair, byTeam };
}

async function main() {
  console.log(`▶ 建立資料集(基準日 ${AS_OF},模擬 ${RUNS} 次)\n`);
  await mkdir(OUT, { recursive: true });

  // 回測結果由 npm test 產生;沒跑過就標成未回測,不憑空填數字
  const btPath = join(ROOT, 'data', 'backtest.json');
  let backtest = { available: false, note: '尚未回測,執行 npm test 後重跑 build 即可帶入' };
  if (existsSync(btPath)) {
    const r = JSON.parse(await readFile(btPath, 'utf8'));
    backtest = {
      available: true, season: r.season, games: r.games, ranAt: r.ranAt,
      rps: r.models.blend.rps, logLoss: r.models.blend.logLoss, hitRate: r.models.blend.hitRate,
      baselineRps: r.models.baseline.rps, models: r.models,
      // 模型驗證頁需要完整資料,不只摘要
      calibration: r.calibration ?? [], byRound: r.byRound ?? [],
      surprises: r.surprises ?? [], baselineProbs: r.baselineProbs ?? null,
      market: r.market ?? { available: false },   // 模型 vs 市場
    };
  }

  // 即時比賽狀態(npm run live 產生;沒有就當作本輪尚無任何開踢資訊)
  const livePath = join(ROOT, 'data', 'raw', 'live.json');
  const liveState = existsSync(livePath) ? JSON.parse(await readFile(livePath, 'utf8')) : null;

  // 隊徽(npm run crests 產生,已內嵌為 data URI)直接掛到球隊登錄上,
  // 前端就不必為了圖片再多載一份資料。
  const crestPath = join(ROOT, 'data', 'manual', 'crests.json');
  const crestData = existsSync(crestPath) ? JSON.parse(await readFile(crestPath, 'utf8')).crests ?? {} : {};

  // 球員頭貼(選用):外部產生的 data URI,鍵是 FPL 的 code。
  // 沒有這個檔也完全正常 —— 前端會退回顯示隊徽,不會有破圖。
  const photoPath = join(ROOT, 'data', 'manual', 'photos.json');
  const photoData = existsSync(photoPath) ? JSON.parse(await readFile(photoPath, 'utf8')).photos ?? {} : {};

  // 每一場的走查預測(npm test 產生),用來做「賽前預測 vs 實際結果」對照
  const btMatchPath = join(ROOT, 'data', 'backtest-matches.json');
  const btMatches = existsSync(btMatchPath) ? JSON.parse(await readFile(btMatchPath, 'utf8')) : null;
  const predByMatch = new Map();
  for (const m of btMatches?.matches ?? []) predByMatch.set(`${m.season}|${m.home}|${m.away}`, m.pred);

  const T = loadTeams(ROOT);
  for (const t of T.list) if (crestData[t.code]) t.crest = crestData[t.code];
  const seasons = [...new Set([...HISTORY_SEASONS, CURRENT_SEASON])];
  const load = season => loadMatches({ root: ROOT, competition: COMPETITION, season, codeOf: T.codeOf });
  const bySeason = new Map(seasons.map(s => [s, load(s)]));
  const history = HISTORY_SEASONS.flatMap(s => bySeason.get(s));
  const lastMatches = bySeason.get(LAST_SEASON);
  const curMatches = bySeason.get(CURRENT_SEASON);
  const curCodes = [...new Set(curMatches.flatMap(m => [m.home, m.away]))].sort();
  const lastCodes = [...new Set(lastMatches.flatMap(m => [m.home, m.away]))].sort();

  // ── 積分榜 ────────────────────────────────
  const lastTable = buildTable(lastMatches, lastCodes);

  // 即時來源已完賽、但 openfootball 還沒更新的場次,先補進本季賽果,
  // 這樣積分榜不用等上游更新就是最新的。
  let liveFilled = 0;
  if (liveState && !liveState.demo) {
    const byKey = new Map(curMatches.map(m => [`${m.home}|${m.away}`, m]));
    for (const f of liveState.fixtures) {
      if (!f.finished || f.hs == null) continue;
      const m = byKey.get(f.key);
      if (!m || m.played) continue;
      Object.assign(m, { played: true, fh: f.hs, fa: f.as, fromLive: true });
      liveFilled++;
    }
  }
  const curPlayed = curMatches.filter(m => m.played);
  const curTable = buildTable(curMatches, curCodes);

  // ── 強度模型 ──────────────────────────────
  const trainMatches = [...history, ...curPlayed];
  const model = applyPromotedPrior(fitPoisson(trainMatches, curCodes, { refDate: AS_OF }));
  const elo = buildElo(trainMatches);
  const strength = strengthTable(model);
  const strengthBy = new Map(strength.map(s => [s.code, s]));

  // ── FPL 資料 ──────────────────────────────
  const fplLast = loadSquads({ root: ROOT, season: LAST_SEASON, codeOf: T.codeOf });
  const fplCur = loadSquads({ root: ROOT, season: CURRENT_SEASON, codeOf: T.codeOf });
  const diff = loadDifficulty(ROOT, T.codeOf, fplCur.teamById);

  // 本季逐輪累計(npm run season 產生);賽季剛開始或上游還沒發布時會是空的
  const seasonPath = join(ROOT, 'data', 'raw', 'season-gws.json');
  const seasonStore = existsSync(seasonPath) ? JSON.parse(await readFile(seasonPath, 'utf8')) : null;
  const seasonUsable = seasonStore && seasonStore.season === CURRENT_SEASON && (seasonStore.rounds?.length ?? 0) > 0;
  const { totals: currentTotals, teamMatches } = seasonUsable
    ? aggregateSeason(seasonStore.rounds)
    : { totals: new Map(), teamMatches: new Map() };

  // 賽季長度由實際賽果推,不要寫死 38 場 —— 之後接盃賽才不會算錯
  const lastSeasonMatches = seasonLength(lastMatches);
  const { players, poolSizes, currentPoolSizes } = buildPlayers({
    current: fplCur.players, last: fplLast.players,
    currentTotals, teamMatches, asOf: AS_OF,
    seasonMinutes: lastSeasonMatches * 90,
  });
  const leaders = {
    seasons: { current: CURRENT_SEASON, last: LAST_SEASON },
    currentAvailable: currentTotals.size > 0,
    currentRounds: seasonUsable ? seasonStore.rounds.length : 0,
    last: leaderboards(players, 'last'),
    current: currentTotals.size ? leaderboards(players, 'current') : null,
  };

  const tactics = buildTactics({
    tableRows: lastTable, lastPlayers: fplLast.players, currentPlayers: fplCur.players, asOf: AS_OF,
  });
  const tacticsBy = new Map(tactics.map(t => [t.code, t]));

  // 角色分類器要在這裡就建好 —— 下面寫 players.json 與 shapes.json 都會用到,
  // 宣告在使用點之後會撞上 TDZ
  const classify = buildClassifier(players);
  const pools = rolePools(players, classify);

  // ── 英超官方資料(pulselive)────────────────
  // 官方公布的陣型/先發/教練是事實,拿得到就蓋掉我們自己的推導。
  // 抓不到(檔案不存在、賽季剛開打還沒資料)全部回 null,下面每一處都會自動退回推導。
  const offShapes = officialFormations(ROOT);
  // 官方只給「顯示名 + 背號」,這裡把它接回我們的球員庫,前端才畫得出頭貼、連得到球員頁
  const offLineups = attachCodes(officialLineups(ROOT), players);
  const offManagers = officialManagers(ROOT);
  if (offShapes) {
    const n = Object.keys(offShapes.teams).length;
    console.log(`  官方陣型:${n} 隊有紀錄(共 ${Object.keys(offLineups?.matches ?? {}).length} 場正式名單)`);
    const ms = offLineups?.matchStats;
    if (ms) {
      console.log(`  官方名單對照球員:${ms.matched} 人成功、${ms.missed} 人對不上`
        + (ms.missedNames.length ? `(${ms.missedNames.slice(0, 6).join('、')}${ms.missed > 6 ? '…' : ''})` : ''));
      console.log(`  官方排位(陣容圖照官方畫):${ms.rowsOk} 邊可用、${ms.rowsFail} 邊對不齊`);
    }
  } else {
    console.log('  官方陣型:沒有 data/raw/pulselive/official.json,本次全部用角色推導');
  }

  const coaches = buildCoaches(ROOT, {
    allMatches: [...history, ...curPlayed], seasonMatches: lastMatches, season: LAST_SEASON,
  });
  // 官方教練名單:只標示不一致,不覆蓋 —— coaches.json 的戰術註解是綁在某位教練身上的,
  // 直接改名字會讓註解變成在講另一個人。
  if (offManagers) {
    const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
    for (const c of coaches.coaches) {
      const off = offManagers.managers[c.team];
      if (!off?.name) continue;
      c.officialName = off.name;
      c.officialMismatch = norm(off.name) !== norm(c.name);
      if (!c.officialMismatch) continue;

      // 換帥了。現任是誰要對(顯示官方的名字),但任期、戰績、戰術風格全部是前任的 ——
      // 掛在新教練名下等於憑空幫他捏造了一份履歷,所以搬到 predecessor 底下明講。
      c.predecessor = {
        name: c.name, zh: c.zh, nat: c.nat,
        since: c.since, tenureDays: c.tenureDays,
        formation: c.formation, style: c.style, note: c.note,
        seasonRecord: c.seasonRecord, allRecord: c.allRecord,
      };
      c.name = off.name;
      c.zh = null;                 // 官方只給英文名,沒有中文譯名就不要編一個
      c.nat = null;
      c.since = null; c.tenureDays = null;
      c.formation = null; c.style = []; c.note = '';
      c.seasonRecord = null; c.allRecord = null;
      c.confidence = 'high';       // 現任是誰以官方為準,這件事本身是確定的
    }
    coaches.officialAsOf = offManagers.asOf;
    const stale = coaches.coaches.filter(c => c.officialMismatch);
    if (stale.length) {
      console.log(`  ⚠ 已換帥 ${stale.length} 隊(顯示官方現任,戰術與戰績標為前任):`);
      for (const c of stale) console.log(`      ${c.team} ${c.predecessor.name || '(空白)'} → ${c.name}`);
    }
  }
  const coachBy = new Map(coaches.coaches.map(c => [c.team, c]));

  // ── 賽程 + 預測 ───────────────────────────
  // 回測顯示 Poisson 與 Elo 平均後的表現最好,所以正式預測用兩者的平均
  /* 市場機率(博彩收盤/開盤賠率去水錢後)。有的話每場都能做「模型 vs 市場」對照 ——
     這是模型唯一有意義的外部對手。抓不到就整個略過,預測照常顯示。 */
  const oddsPath = join(ROOT, 'data', 'raw', 'football-data-couk', 'fixtures.csv');
  let marketBy = {};
  if (existsSync(oddsPath)) {
    const r = upcomingOdds(readFileSync(oddsPath, 'utf8'), { codeOf: T.codeOf });
    marketBy = r.byMatch;
    console.log(`  市場賠率:${r.count} 場有賽前盤口`);
  }

  const fixtures = curMatches.map(m => {
    const p = predict(model, m.home, m.away);
    const e = eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500);
    const blend = {
      home: round((p.home + e.home) / 2, 4),
      draw: round((p.draw + e.draw) / 2, 4),
      away: round((p.away + e.away) / 2, 4),
    };
    const d = diff.byPair.get(`${m.home}|${m.away}`) ?? null;
    return {
      id: m.id, season: m.season, round: m.round, date: m.date,
      home: m.home, away: m.away, played: m.played,
      fh: m.fh, fa: m.fa, hh: m.hh, ha: m.ha, time: m.time ?? null,
      // 倒數計時要用精確到分鐘的 UTC 時間;沒有 FPL 資料才退回 openfootball 的英國當地時間
      kickoff: d?.kickoff ?? `${m.date}T${(m.time ?? '15:00')}:00+01:00`,
      kickoffSource: d?.kickoff ? 'fpl' : 'openfootball',
      difficulty: d ? { home: d.home, away: d.away } : null,
      prediction: { ...p, ...blend, poisson: { home: p.home, draw: p.draw, away: p.away }, elo: e },
      market: marketBy[`${m.home}|${m.away}`] ?? null,
      // 兩隊對照圖用的配色。英超九隊主色是紅的、六隊是深藍的,直接用會撞色 ——
      // 所以每一場都算一次,兩隊同色系時自動把客隊拉開。詳見 lib/colour.mjs。
      colors: pickPair(T.byCode.get(m.home)?.colors, T.byCode.get(m.away)?.colors),
    };
  });
  {
    const n = fixtures.filter(f => f.market).length;
    if (n) console.log(`  逐場模型 vs 市場:${n} 場對得上`);
  }

  // ── 賽季模擬 ──────────────────────────────
  const sim = simulateSeason({
    model, fixtures: curMatches.filter(m => !m.played), codes: curCodes, played: curPlayed, runs: RUNS,
  });
  const simBy = new Map(sim.map(s => [s.code, s]));

  // ── 開季賽程難度 ──────────────────────────
  const WINDOW = 6;
  const difficultySummary = curCodes.map(code => {
    const list = (diff.byTeam.get(code) ?? []).slice(0, WINDOW);
    const avg = list.length ? round(list.reduce((a, x) => a + x.diff, 0) / list.length, 2) : null;
    return { code, avg, opponents: list.map(x => x.opp), detail: list };
  }).filter(x => x.avg !== null);

  // ── 球隊總表 ──────────────────────────────
  const teams = curCodes.map(code => {
    const reg = T.byCode.get(code);
    const row = lastTable.find(r => r.code === code) ?? null;
    const cur = curTable.find(r => r.code === code) ?? null;
    return {
      ...reg,
      lastSeason: row ? {
        pos: row.pos, p: row.p, w: row.w, d: row.d, l: row.l, gf: row.gf, ga: row.ga, gd: row.gd,
        pts: row.pts, ppg: row.ppg, form: row.form, home: row.home, away: row.away,
        homeAwayGap: row.homeAwayGap, cleanSheets: row.cleanSheets, longest: row.longest,
        half: row.half, bttsPct: row.bttsPct, over25Pct: row.over25Pct,
        biggestWin: row.biggestWin, biggestLoss: row.biggestLoss,
      } : null,
      inLastSeason: !!row,
      current: cur ? { pos: cur.pos, p: cur.p, w: cur.w, d: cur.d, l: cur.l, gf: cur.gf, ga: cur.ga, pts: cur.pts, form: cur.form } : null,
      elo: elo.get(code)?.elo ?? null,
      eloHistory: elo.get(code)?.history ?? [],
      strength: strengthBy.get(code) ?? null,
      sim: simBy.get(code) ?? null,
      tactics: tacticsBy.get(code) ?? null,
      coach: coachBy.get(code) ? {
        name: coachBy.get(code).name, zh: coachBy.get(code).zh, since: coachBy.get(code).since,
        confidence: coachBy.get(code).confidence, formation: coachBy.get(code).formation,
        style: coachBy.get(code).style,
      } : null,
      schedule: difficultySummary.find(d => d.code === code) ?? null,
      squadSize: players.filter(p => p.team === code).length,
      injuries: players.filter(p => p.team === code && p.status !== 'a' && p.news).length,
    };
  }).sort((a, b) => (b.sim?.expectedPoints ?? 0) - (a.sim?.expectedPoints ?? 0));

  // ── 交手紀錄(本季所有對戰組合) ────────────
  const h2h = {};
  const pairs = new Set();
  for (const f of curMatches) pairs.add([f.home, f.away].sort().join('|'));
  for (const key of pairs) {
    const [a, b] = key.split('|');
    const rec = headToHead(history, a, b);
    if (rec.games) h2h[key] = rec;
  }

  // ── 即時戰況 ──────────────────────────────
  const fixtureByKey = new Map(fixtures.map(f => [`${f.home}|${f.away}`, f]));
  let liveOut = {
    available: false,
    note: '尚未取得即時狀態。執行 npm run live(需要能連到官方 FPL API)或 npm run live -- --replay=2025-26:1 看真實比賽的示範。',
  };
  if (liveState) {
    // 重播的是過去賽季的比賽,不能接到本季賽程上(輪次會亂),
    // 賽前機率也必須用「那場開賽前」的資料重新擬合,不能拿今天的強度去預測去年的比賽。
    const liveSeason = liveState.season ?? CURRENT_SEASON;
    const isCurrentSeason = !liveState.demo && liveSeason === CURRENT_SEASON;

    let predictionFor;
    if (isCurrentSeason) {
      predictionFor = f => fixtureByKey.get(f.key)?.prediction ?? null;
    } else {
      const refDate = liveState.fixtures.map(f => f.kickoff).filter(Boolean).sort()[0]?.slice(0, 10) ?? AS_OF;
      const before = [...history, ...curPlayed].filter(m => m.date < refDate);
      const replayCodes = [...new Set(liveState.fixtures.flatMap(f => [f.home, f.away]))].sort();
      const rModel = applyPromotedPrior(fitPoisson(before, replayCodes, { refDate }));
      const rElo = buildElo(before);
      console.log(`  ↻ 重播模式:用 ${refDate} 之前的 ${before.length} 場比賽重新擬合賽前模型`);
      predictionFor = f => {
        const p = predict(rModel, f.home, f.away);
        const e = eloProbs(rElo.get(f.home)?.elo ?? 1500, rElo.get(f.away)?.elo ?? 1500);
        return {
          ...p,
          home: round((p.home + e.home) / 2, 4),
          draw: round((p.draw + e.draw) / 2, 4),
          away: round((p.away + e.away) / 2, 4),
        };
      };
    }

    const matches = liveState.fixtures.map(f => {
      const fx = isCurrentSeason ? fixtureByKey.get(f.key) : null;
      const rep = buildMatchReport({
        fixture: f,
        prediction: predictionFor(f),
        tactics: tacticsBy,
        zh: code => T.byCode.get(code)?.en ?? code,
      });
      return {
        ...rep,
        fixtureId: fx?.id ?? null,
        round: isCurrentSeason ? (fx?.round ?? liveState.round) : liveState.round,
        difficulty: fx?.difficulty ?? null,
      };
    }).sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));

    liveOut = {
      available: true,
      source: liveState.source,
      sourceLabel: liveState.sourceLabel,
      demo: !!liveState.demo,
      season: liveState.season ?? CURRENT_SEASON,
      round: liveState.round,
      fetchedAt: liveState.fetchedAt,
      counts: {
        total: matches.length,
        live: matches.filter(m => m.started && !m.finished).length,
        finished: matches.filter(m => m.finished).length,
        upcoming: matches.filter(m => !m.started).length,
      },
      matches,
    };
  }

  // ── 賽後報告 ──────────────────────────────
  // 只要拿得到出場名單就產生報告,不論來自即時、重播或本季逐輪累積。
  const reports = {};
  const reportSources = [];
  if (liveState) reportSources.push({ season: liveState.season ?? CURRENT_SEASON, fixtures: liveState.fixtures, demo: !!liveState.demo });
  if (seasonStore?.rounds?.length) {
    for (const r of seasonStore.rounds) reportSources.push({ season: seasonStore.season, fixtures: r.fixtures, demo: false });
  }
  for (const src of reportSources) {
    for (const f of src.fixtures) {
      if (!f.started || !Object.values(f.lineups).some(l => l.length)) continue;
      const key = `${src.season}|${f.home}|${f.away}`;
      if (reports[key]) continue;
      const isCur = src.season === CURRENT_SEASON;
      const pre = isCur ? fixtureByKey.get(f.key)?.prediction ?? null : predByMatch.get(key) ?? null;
      reports[key] = {
        ...buildMatchReport({
          fixture: f, prediction: pre, tactics: tacticsBy,
          zh: code => T.byCode.get(code)?.en ?? code,
        }),
        season: src.season, demo: src.demo,
      };
    }
  }

  // ── AI 分析文章 ────────────────────────────
  // 流程:分析引擎算好 feature bundle → 有 API key 就交給 LLM 潤稿 → 數字驗證 → 寫入快取。
  // 沒有 key(預設情況)就用模板版,內容一樣完整,只是文字比較制式。
  // 不論走哪條路,文章裡的每個數字都必須在 bundle 的 facts 裡找得到,否則整篇退回模板。
  const cache = await new ReportCache(ROOT).load();
  const usedHashes = new Set();
  const aiPre = {}, aiPost = {};
  const seasonLabel = `${CURRENT_SEASON} 賽季`;
  const teamOf = code => T.byCode.get(code) ?? { code, en: code, zh: code };
  const teamFull = code => {
    const t = teams.find(x => x.code === code);
    return t ?? teamOf(code);
  };

  // 賽前:只寫還沒開打、而且是最近 20 場的比賽,不必整季 380 篇都寫
  const upcoming = fixtures.filter(f => !f.played)
    .sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1)).slice(0, AI_PREVIEW_COUNT);
  for (const f of upcoming) {
    const bundle = preMatchBundle({
      fixture: f, home: teamFull(f.home), away: teamFull(f.away),
      h2h: h2h[[f.home, f.away].sort().join('|')] ?? null,
      tacticsHome: tacticsBy.get(f.home), tacticsAway: tacticsBy.get(f.away),
      asOf: AS_OF, seasonLabel,
    });
    const rep = await generateReport(bundle, { cache });
    usedHashes.add(rep.hash);
    aiPre[`${f.home}|${f.away}`] = rep;
  }

  // 賽後:所有已經有出場名單的比賽
  for (const [key, r] of Object.entries(reports)) {
    const bundle = postMatchBundle({
      report: r, home: teamOf(r.home), away: teamOf(r.away), asOf: AS_OF, seasonLabel,
    });
    const rep = await generateReport(bundle, { cache });
    usedHashes.add(rep.hash);
    aiPost[key] = rep;
  }

  const kept = await cache.save(usedHashes);
  const aiSummary = {
    enabled: llmEnabled(),
    pre: Object.keys(aiPre).length, post: Object.keys(aiPost).length,
    llmWritten: [...Object.values(aiPre), ...Object.values(aiPost)].filter(r => r.source === 'llm').length,
    cacheHits: cache.hits, cacheEntries: kept,
  };

  // ── 新聞 ──────────────────────────────────
  const injuries = injuryFeed(players, T, AS_OF);
  const stories = dataStories({ table: lastTable, tactics, teams: T, season: LAST_SEASON, asOf: AS_OF });
  const previews = previewStories({ fixtures, teams: T, asOf: AS_OF });
  const schedule = scheduleStories({ difficulty: difficultySummary, teams: T, asOf: AS_OF, window: WINDOW });
  // 若使用者自行抓過 RSS(scripts/fetch-news.mjs),這裡會一併併入
  const externalPath = join(ROOT, 'data', 'raw', 'news.json');
  let external = [];
  if (existsSync(externalPath)) {
    try { external = JSON.parse(await readFile(externalPath, 'utf8')); } catch { external = []; }
  }

  const news = [...previews, ...schedule, ...stories, ...injuries.slice(0, 60), ...external]
    .sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));

  // ── 輸出 ──────────────────────────────────
  console.log('寫入資料集:');
  await write('meta.json', {
    builtAt: new Date().toISOString(),
    asOf: AS_OF,
    currentSeason: CURRENT_SEASON,
    lastSeason: LAST_SEASON,
    historySeasons: HISTORY_SEASONS,
    sources: ATTRIBUTION,
    model: {
      type: 'Dixon-Coles Poisson + Elo(取平均)',
      homeAdvantage: round(Math.exp(model.gamma), 3),
      rho: model.rho,
      decayXi: model.xi,
      promotedPrior: model.promoted,
      simulationRuns: RUNS,
      backtest,
      caveats: [
        '模型只吃比賽結果與 FPL 統計,不含轉會、傷病與賽程密度的人工調整。',
        '賽季模擬用獨立 Poisson 抽樣,和局會略少於真實比例(約少 1% 的總積分誤差)。',
        '升班馬沒有近期英超樣本,套用「聯盟後段先驗」,不確定性標得比較大。',
      ],
    },
    counts: {
      teams: teams.length, players: players.length, fixtures: fixtures.length,
      news: news.length, injuries: injuries.length, poolSizes, currentPoolSizes,
      currentSeasonRounds: leaders.currentRounds,
      currentSeasonPlayers: currentTotals.size,
    },
    competition: competitionDef(COMPETITION),
    coachDataAsOf: coaches.asOf,
    live: liveOut.available
      ? { available: true, source: liveOut.source, sourceLabel: liveOut.sourceLabel, demo: liveOut.demo, round: liveOut.round, fetchedAt: liveOut.fetchedAt, counts: liveOut.counts }
      : { available: false },
    liveResultsMerged: liveFilled,
    official: offShapes
      ? {
          available: true, source: 'pulselive', asOf: offShapes.asOf, season: offShapes.season,
          teamsWithFormation: Object.keys(offShapes.teams).length,
          matchesWithLineup: Object.keys(offLineups?.matches ?? {}).length,
          managersAsOf: offManagers?.asOf ?? null,
        }
      : { available: false },
    ai: aiSummary,
  });
  await write('clubs.json', T.list); // 27 隊完整名稱登錄(含已降級球隊,顯示歷史資料用)
  await write('teams.json', teams);
  await write('fixtures.json', fixtures);
  await write('table.json', { last: lastTable, current: curTable, lastSeason: LAST_SEASON, currentSeason: CURRENT_SEASON });
  const roleOf = p => {
    const r = classify(p, p.last ?? p.current);
    return { key: r.key, zh: r.zh, lowSample: !!r.lowSample };
  };
  await write('players.json', players.map(p => ({
    ...(photoData[p.code] ? { ...p, photo: photoData[p.code] } : p),
    role: roleOf(p),
  })));
  await write('leaders.json', leaders);
  await write('tactics.json', tactics);
  await write('formation.json', formationImpact({ tactics, table: lastTable }));

  // 標準陣型與攻守分型:先把 FPL 的四個粗類細分成八種角色,再由角色的出場分鐘推導。
  // 升班馬沒有足夠的英超樣本,會回報 insufficient 而不是硬編一個陣型出來。
  const shapes = Object.fromEntries(curCodes.map(code => {
    const squad = players.filter(p => p.team === code);
    const official = offShapes?.teams?.[code] ?? null;
    const rf = roleFormation(squad, classify);
    // 升班馬推導不出來,但官方陣型照樣拿得到 —— 這正是接官方資料最大的收穫
    if (rf.insufficient) {
      return [code, {
        insufficient: true, contributors: rf.contributors, totalMinutes: rf.totalMinutes,
        official, source: official ? 'official' : 'insufficient',
      }];
    }
    const ph = phaseShapes(rf.counts, squad, classify, pools);
    return [code, {
      counts: rf.counts, raw: rf.raw, ...ph,
      official,
      // 攻守分型只有推導版本(官方只公布一個陣型,不分有球無球),
      // 所以 base 用官方的、attacking/defending 仍是推導 —— 前端要照這個標示來源
      source: official ? 'official' : 'derived',
    }];
  }));
  await write('shapes.json', shapes);

  // 預估先發:每隊算一次就好(推測不看對手是誰),比每場算一次小得多。
  // 頭貼刻意不帶進來 —— players.json 已經有一份,重複塞會讓這個檔從 40 KB 變 900 KB。
  //
  // 陣型的優先序:官方公布 > 角色推導 > FPL 四粗類。
  // 為什麼不能直接用 FPL:它只有 GK/DEF/MID/FWD 四類,而且把邊鋒歸為中場,
  // 照它分線的話 20 隊裡有 13 隊都會變成 4-5-1 —— 那是分類太粗,不是球隊真的都這樣踢。
  const shapeFor = code => {
    const off = offShapes?.teams?.[code]?.formation;
    if (off) return { formation: off, formationSource: 'official' };
    const derived = shapes[code]?.insufficient ? null : shapes[code]?.base?.label ?? null;
    return { formation: derived, formationSource: 'derived' };
  };
  const lineups = Object.fromEntries(curCodes.map(code => [code, projectXI({
    players, team: code, tactics: tacticsBy.get(code), rounds: leaders.currentRounds ?? 0,
    ...shapeFor(code), classify,
  })]));
  {
    const n = src => Object.values(lineups).filter(l => l.shapeSource === src).length;
    console.log(`  預估先發陣型:官方 ${n('official')} 隊・角色推導 ${n('derived')} 隊・FPL 粗類 ${n('fpl')} 隊`);
  }
  await write('lineups.json', lineups);

  await write('official.json', offLineups
    ? { available: true, asOf: offLineups.asOf, season: offLineups.season, matches: offLineups.matches,
        managers: offManagers?.managers ?? {}, managersAsOf: offManagers?.asOf ?? null }
    : { available: false, matches: {}, managers: {} });
  await write('coaches.json', coaches);
  await write('news.json', news);
  await write('sim.json', sim);
  await write('live.json', liveOut);
  await write('h2h.json', h2h);
  await write('analysis.json', { ...aiSummary, pre: aiPre, post: aiPost, counts: { pre: aiSummary.pre, post: aiSummary.post } });
  await write('reports.json', {
    seasons: [...new Set(Object.keys(reports).map(k => k.split('|')[0]))],
    count: Object.keys(reports).length,
    reports,
  });
  // Canonical 格式是內部契約,不要原封不動送到前端 —— 空欄位會把檔案灌胖一倍
  const slimMatch = m => {
    const out = { id: m.id, season: m.season, round: m.round, date: m.date, home: m.home, away: m.away, played: m.played, fh: m.fh, fa: m.fa };
    if (m.hh !== null) { out.hh = m.hh; out.ha = m.ha; }
    if (m.kickoff) out.kickoff = m.kickoff;
    return out;
  };
  await write('results.json', [...history, ...curPlayed].filter(m => m.played).map(m => {
    const pred = predByMatch.get(`${m.season}|${m.home}|${m.away}`);
    const slim = slimMatch(m);
    return pred ? { ...slim, prediction: pred } : slim;
  }));

  console.log(`\n✔ 完成:${teams.length} 隊 / ${players.length} 名球員 / ${fixtures.length} 場賽程 / ${news.length} 則動態`);
  const photoHits = players.filter(p => photoData[p.code]).length;
  console.log(`  球員頭貼:${photoHits ? `${photoHits} / ${players.length} 名有圖` : '未提供(data/manual/photos.json 不存在,前端退回隊徽)'}`);
  console.log(`  分析文章:賽前 ${aiSummary.pre} 篇・賽後 ${aiSummary.post} 篇,快取命中 ${aiSummary.cacheHits} 篇` +
    (aiSummary.enabled ? `,LLM 潤稿 ${aiSummary.llmWritten} 篇` : '(模板版;設定 ANTHROPIC_API_KEY 可啟用 LLM 潤稿)'));
  if (liveOut.available) {
    console.log(`  即時:${liveOut.sourceLabel}`);
    console.log(`        第 ${liveOut.round} 輪 —— 進行中 ${liveOut.counts.live}・已完賽 ${liveOut.counts.finished}・未開賽 ${liveOut.counts.upcoming}` +
      (liveFilled ? `(其中 ${liveFilled} 場結果已補進積分榜)` : ''));
  } else {
    console.log('  即時:尚未取得(npm run live)');
  }
}

main().catch(err => { console.error('✗ 建置失敗:', err); process.exit(1); });
