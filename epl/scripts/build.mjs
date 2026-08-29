#!/usr/bin/env node
// 把原始資料 + 分析引擎的結果,產生成前端可直接讀的 JSON 資料集。
// 用法: npm run build [--as-of=YYYY-MM-DD] [--runs=10000]
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPETITION, CURRENT_SEASON, LAST_SEASON, HISTORY_SEASONS, H2H_EXTRA_SEASONS, GOAL_SEASONS, ATTRIBUTION } from './lib/sources.mjs';
import { loadTeams } from './lib/teams.mjs';
import { loadMatches, loadSquads } from './lib/adapters/index.mjs';
import { competition as competitionDef, seasonLength } from './lib/canonical.mjs';
import { buildTable, headToHead, teamRecord } from './lib/table.mjs';
import { buildElo, eloProbs, ELO_PARAMS } from './lib/elo.mjs';
import { fitPoisson, applyPromotedPrior, predict, strengthTable, simParams } from './lib/poisson.mjs';
import { simulateSeason } from './lib/simulate.mjs';
import { buildPlayers, leaderboards, aggregateSeason } from './lib/players.mjs';
import { buildTactics, formationImpact } from './lib/tactics.mjs';
import { projectXI } from './lib/lineup.mjs';
import { buildClassifier, rolePools, roleFormation, phaseShapes, countRoles, standardShape } from './lib/roles.mjs';
import { buildCoaches } from './lib/coaches.mjs';
import { officialFormations, officialLineups, officialManagers, attachCodes } from './lib/adapters/pulselive.mjs';
import { summariseSeason } from './lib/cups.mjs';
import { loadUclSeasons, uclTeamAssets } from './lib/ucl.mjs';
import { lookupTier, nearMisses } from './lib/adapters/england-tiers.mjs';
import { injuryFeed, dataStories, previewStories, scheduleStories } from './lib/news.mjs';
import { loadCurated } from './lib/curated-archive.mjs';
import { buildMatchReport } from './lib/matchreport.mjs';
import {
  preMatchBundle, postMatchBundle, generateReport, ReportCache, llmEnabled,
} from './lib/report/index.mjs';
import { parseCSVObjects, num } from './lib/csv.mjs';
import { upcomingOdds } from './lib/odds.mjs';
import { pickPair, intoBand } from './lib/colour.mjs';
import { appendSamples, historyForSite } from './lib/prob-history.mjs';
import { inplayCalibration } from './lib/inplay-calibration.mjs';
import { teamMatchRows, styleTrendFor, attachTrendPercentiles, seasonRuler } from './lib/style-trend.mjs';
import { attachCareers } from './lib/coach-career.mjs';
import { attachProfiles } from './lib/coach-profiles.mjs';
import { coreFromFpl } from './lib/player-core.mjs';
import { attachScheduleStatus } from './lib/schedule-status.mjs';
import { buildFormIndex, recentForm, formSummary, formDelta, TUNED } from './lib/form.mjs';
import { teamAvailability } from './lib/availability.mjs';
import { loadGoals, reconcile } from './lib/adapters/fpl-goals.mjs';
import { buildGoals } from './lib/goals.mjs';
import { shirtsFromOfficial, shirtsFromManual, backfillSquadNumbers } from './lib/squadnumbers.mjs';
import { numberProfile, traditionVsData, formationFromLineups } from './lib/knowledge.mjs';
import { round } from './lib/util.mjs';
import { loadExpertOpinions } from './lib/experts.mjs';
import { loadSquadStore as loadSportMonksSquadStore, enrichPlayers as enrichSportMonksPlayers } from './lib/adapters/sportmonks.mjs';
import { coaches as fotmobCoaches, goals as fotmobGoals, squadNumbers, verifyGoals, verifyCoachRecords, goalRecords } from './lib/adapters/fotmob-manual.mjs';
import { loadCoachPhotos, coachPhotoFor } from './lib/adapters/coach-photos.mjs';
import { loadVerifiedLoans, attachLoans } from './lib/loans.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'data');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const AS_OF = arg('as-of') || new Date().toISOString().slice(0, 10);
const RUNS = Number(arg('runs') || 10000);
// 賽前分析只寫最近幾場:整季 380 篇對讀者沒意義,對 LLM 帳單也不友善
const AI_PREVIEW_COUNT = Number(arg('ai-previews') || 20);

const playerNameKey = name => String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// API-Football 與 FPL 的人名格式不同(B. Saka / Bukayo Saka)。先用全名,再用隊內唯一姓氏對應,
// 只在能確定唯一人選時掛本站 code；不確定就保留供應商名字,不猜。
function attachAdvancedCodes(detail, report) {
  if (!detail || !report?.sides) return null;
  const players = {};
  const idToCode = new Map();
  for (const teamCode of [report.home, report.away]) {
    const side = report.sides[teamCode] ?? {};
    const roster = [...(side.xi ?? []), ...(side.bench ?? []), ...(side.rows ?? []).flat()]
      .filter((p, i, all) => p?.name && all.findIndex(x => x?.name === p.name) === i);
    const byFull = new Map(roster.map(p => [playerNameKey(p.name), p]));
    const byLast = new Map();
    for (const p of roster) {
      const last = playerNameKey(p.name).split(' ').at(-1);
      if (!last) continue;
      const list = byLast.get(last) ?? []; list.push(p); byLast.set(last, list);
    }
    players[teamCode] = (detail.players?.[teamCode] ?? []).map(p => {
      const key = playerNameKey(p.name), last = key.split(' ').at(-1);
      const exact = byFull.get(key);
      const surname = byLast.get(last)?.length === 1 ? byLast.get(last)[0] : null;
      const local = exact ?? surname;
      if (local?.code && p.providerId != null) idToCode.set(`${teamCode}|${p.providerId}`, local.code);
      return { ...p, code: local?.code ?? null, photo: local?.photo ?? p.photo ?? null };
    });
  }
  const events = (detail.events ?? []).map(e => ({
    ...e,
    playerCode: e.playerId == null ? null : idToCode.get(`${e.team}|${e.playerId}`) ?? null,
    assistCode: e.assistId == null ? null : idToCode.get(`${e.team}|${e.assistId}`) ?? null,
  }));
  return { ...detail, source: detail.source === 'sportmonks' ? 'sportmonks' : 'API-Football', players, events };
}

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
      trainSeasons: r.trainSeasons ?? [],
      rps: r.models.blend.rps, logLoss: r.models.blend.logLoss, hitRate: r.models.blend.hitRate,
      baselineRps: r.models.baseline.rps, models: r.models,
      // 贏過基準線／市場多少,以及那個差距是幾個標準誤 —— 沒有標準誤的比較讀者無從判斷
      vsBaseline: r.vsBaseline ?? null, vsMarket: r.vsMarket ?? null,
      // 模型驗證頁需要完整資料,不只摘要
      calibration: r.calibration ?? [], byRound: r.byRound ?? [],
      surprises: r.surprises ?? [], baselineProbs: r.baselineProbs ?? null,
      market: r.market ?? { available: false },   // 模型 vs 市場
    };
  }

  // 即時比賽狀態(npm run live 產生;沒有就當作本輪尚無任何開踢資訊)
  const livePath = join(ROOT, 'data', 'raw', 'live.json');
  const liveState = existsSync(livePath) ? JSON.parse(await readFile(livePath, 'utf8')) : null;

  // API-Football 完賽資料只由 fetch-live / fetch-postmatch 寫入；build 永遠只讀本地永久快取。
  const advancedPath = join(ROOT, 'data', 'raw', 'api-football', 'match-details.json');
  let advancedStore = { matches: {} };
  if (existsSync(advancedPath)) {
    try { advancedStore = JSON.parse(await readFile(advancedPath, 'utf8')); }
    catch { console.log('  ⚠ API-Football 賽後快取損壞,本次略過進階資料'); }
  }
  // SportMonks 是主要的英超進階資料來源；API-Football 只作備援。
  // build 只讀 Actions 已快取的檔案，不在開頁或建置時連外。
  const sportmonksAdvancedPath = join(ROOT, 'data', 'raw', 'sportmonks-epl', `${CURRENT_SEASON}-match-details.json`);
  let sportmonksAdvancedStore = { matches: {} };
  if (existsSync(sportmonksAdvancedPath)) {
    try { sportmonksAdvancedStore = JSON.parse(await readFile(sportmonksAdvancedPath, 'utf8')); }
    catch { console.log('  ⚠ SportMonks 英超賽後快取損壞,本次略過進階資料'); }
  }
  const advancedFor = (season, key) => {
    if (season !== CURRENT_SEASON) return null;
    // 主要來源優先；若 SportMonks 尚未完成該場，再退回 API-Football。
    return sportmonksAdvancedStore.season === season
      ? sportmonksAdvancedStore.matches?.[key] ?? advancedStore.matches?.[key] ?? null
      : advancedStore.season === season ? advancedStore.matches?.[key] ?? null : null;
  };

  // 隊徽(npm run crests 產生,已內嵌為 data URI)直接掛到球隊登錄上,
  // 前端就不必為了圖片再多載一份資料。
  const crestPath = join(ROOT, 'data', 'manual', 'crests.json');
  const crestData = existsSync(crestPath) ? JSON.parse(await readFile(crestPath, 'utf8')).crests ?? {} : {};

  // 球員頭貼(選用):外部產生的 data URI,鍵是 FPL 的 code。
  // 沒有這個檔也完全正常 —— 前端會退回顯示隊徽,不會有破圖。
  /* 足球共識層(陣型/背號/位置的傳統定義)。人工整理、逐條帶來源,
     跟計算出來的數字分開存放,前端才分得出哪一半是共識、哪一半是資料。 */
  const knowledgePath = join(ROOT, 'data', 'manual', 'football-knowledge.json');
  const KNOWLEDGE = existsSync(knowledgePath)
    ? JSON.parse(await readFile(knowledgePath, 'utf8')) : null;

  const photoPath = join(ROOT, 'data', 'manual', 'photos.json');
  const photoData = existsSync(photoPath) ? JSON.parse(await readFile(photoPath, 'utf8')).photos ?? {} : {};

  // 每一場的走查預測(npm test 產生),用來做「賽前預測 vs 實際結果」對照
  const btMatchPath = join(ROOT, 'data', 'backtest-matches.json');
  const btMatches = existsSync(btMatchPath) ? JSON.parse(await readFile(btMatchPath, 'utf8')) : null;
  const predByMatch = new Map();
  for (const m of btMatches?.matches ?? []) predByMatch.set(`${m.season}|${m.home}|${m.away}`, m.pred);

  const T = loadTeams(ROOT);
  for (const t of T.list) {
    if (crestData[t.code]) t.crest = crestData[t.code];
    /* 圖表用的隊色:球隊主色不能直接畫在深色底上 —— Fulham 是 #1A1A1A、
       Newcastle 是 #241F20,畫在深綠球場上等於隱形。這裡把色相保留、
       明度與彩度拉進可見範圍;整隊都是黑白的就退回中性色。 */
    t.chartColor = intoBand(t.colors?.[0]) ?? intoBand(t.colors?.[1]) ?? '#9aa0aa';
  }
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
  const fplLastRaw = loadSquads({ root: ROOT, season: LAST_SEASON, codeOf: T.codeOf });
  const fplCurRaw = loadSquads({ root: ROOT, season: CURRENT_SEASON, codeOf: T.codeOf });
  const sportmonksLast = loadSportMonksSquadStore(ROOT, LAST_SEASON, { directory: 'sportmonks-epl' });
  const sportmonksCur = loadSportMonksSquadStore(ROOT, CURRENT_SEASON, { directory: 'sportmonks-epl' });
  const enrich = (base, store, season, options = {}) => {
    if (!store) return base;
    const result = enrichSportMonksPlayers(base.players, store, { codeOf: T.codeOf, ...options });
    console.log(`  SportMonks ${season}:${result.matched}/${base.players.length} 名球員已合併主要身分／頭貼資料`);
    return { ...base, players: result.players };
  };
  const fplLast = enrich(fplLastRaw, sportmonksLast, LAST_SEASON);
  // 當季名單找不到的新球員，仍可從上一季 SportMonks 快取補回照片／身分；
  // 只填空欄位，不覆蓋當季主要來源。
  const fplCurPrimary = enrich(fplCurRaw, sportmonksCur, CURRENT_SEASON);
  const fplCur = enrich(fplCurPrimary, sportmonksLast, `${LAST_SEASON} 備援`, { fillMissing: true });
  const diff = loadDifficulty(ROOT, T.codeOf, fplCur.teamById);

  // 上一完整賽季的進球情境。這份靜態快取由 npm run setpieces 低頻率、
  // 可續跑地產生;只有 20 隊全部跟獨立賽果核對成功才會進入前端。
  const situationsPath = join(ROOT, 'data', 'raw', 'understat', `${LAST_SEASON}-team-situations.json`);
  let teamSituations = null;
  if (existsSync(situationsPath)) {
    const raw = JSON.parse(await readFile(situationsPath, 'utf8'));
    if (raw.season === LAST_SEASON && raw.complete && raw.validation?.allScorelinesReconciled) {
      teamSituations = raw;
      console.log(`  Understat 進球情境:${Object.keys(raw.teams ?? {}).length} 隊已核對`);
    } else {
      console.log('  ⚠ Understat 進球情境未完整核對,本次不使用');
    }
  }

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
    tableRows: lastTable, lastPlayers: fplLast.players, currentPlayers: fplCur.players,
    teamSituations, asOf: AS_OF,
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

  /* 背號回填。FPL 快照有 66 人沒有背號,而官方名單本來就帶背號 ——
     零額外請求,只是以前沒人把它接回球員庫。 */
  {
    const off = shirtsFromOfficial(offLineups);
    const man = shirtsFromManual(squadNumbers(ROOT), players);
    const r = backfillSquadNumbers(players, { official: off.shirts, manual: man.shirts });
    const have = players.filter(x => x.squadNumber != null).length;
    console.log(`  背號:${have} / ${players.length} 人`
      + `(官方名單補 ${r.fromOfficial}、FotMob 補 ${r.fromManual};兩來源重疊 ${r.agree} 筆全部相符)`);
    if (r.disagree.length) console.log(`  ⚠ 官方與 FotMob 背號不一致,兩邊都不採用:${r.disagree.join('、')}`);
    if (off.unstable.length) console.log(`  ⚠ 同一 code 跨場背號不一致(多半是名單對照配錯人),不採用:${off.unstable.join('、')}`);
    if (man.ambiguous.length) console.log(`  ⚠ FotMob 背號對不到唯一球員:${man.ambiguous.join('、')}`);
    for (const c of r.conflicts) {
      console.log(`  ⚠ ${c.team}:${c.name} FPL 背號 ${c.fpl}、官方名單 ${c.official} —— 保留 FPL 的,不自動改`);
    }
  }

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
  /* 教練本季戰績(FotMob 人工交付)。跟西甲同一套:**先用我們自己的賽果重算核對**,
     對不上的整隊不採用。英超原本只有 11/23 位有戰績,而且是人工維護的。
     這一批的 since 全是 null,所以只補戰績不補任期。 */
  {
    const fmCoaches = fotmobCoaches(ROOT);
    if (fmCoaches) {
      const ourPlayed = curPlayed.map(m => ({ home: m.home, away: m.away, fh: m.fh, fa: m.fa }));
      const fmGoalsAll = fotmobGoals(ROOT);
      const gv = fmGoalsAll ? verifyGoals('pl', fmGoalsAll, ourPlayed) : { newer: [] };
      const cv = verifyCoachRecords('pl', fmCoaches, ourPlayed, gv.newer);
      const byTeam = new Map(coaches.coaches.map(c => [c.team, c]));
      for (const { coach } of cv.agree) {
        const target = byTeam.get(coach.team);
        // 只補「本季」戰績,不動 coaches.json 原有的上季 seasonRecord 與戰術註解
        if (target) target.currentSeasonRecord = { season: CURRENT_SEASON, ...coach.seasonRecord };
      }
      coaches.currentRecordSource = {
        source: fmCoaches.source, retrievedAt: fmCoaches.retrievedAt,
        verified: cv.agree.length, differ: cv.differ.length,
        aheadMatches: gv.newer.map(x => x.key),
        note: 'FotMob 交付的教練本季戰績,已用本站 openfootball 賽果逐欄位核對;對不上的整隊不採用。',
      };
      console.log(`  教練本季戰績(FotMob):核對通過 ${cv.agree.length} 隊`
        + (cv.differ.length ? `・對不上 ${cv.differ.length} 隊(不採用)` : ''));
    }
  }

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
  const coachPhotos = loadCoachPhotos(ROOT);
  for (const c of coaches.coaches) {
    const photo = coachPhotoFor(coachPhotos, 'epl', c.team);
    if (photo?.imagePath) { c.imagePath = photo.imagePath; c.photoSource = photo.source; c.photoSourceUrl = photo.sourceUrl; }
  }
  /* 教練前一段任期(B 層,人工交付職涯 → 核對 → 本站自己算風格)。
     只掛核對通過(published)的;stale 時整批不掛(lib/coach-career.mjs)。 */
  attachCareers(ROOT, coaches.coaches, 'pl');
  attachProfiles(ROOT, coaches.coaches, 'pl');
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

  // 逐季攻守與開季前 10 場。只算現有、已核對的賽果檔,不新增 API 呼叫;
  // 每支隊只列它確實參賽的賽季,升降級空窗不補 0、更不猜數字。
  const teamHistory = new Map(curCodes.map(code => [code, []]));
  for (const season of seasons) {
    const matches = bySeason.get(season);
    const participants = new Set(matches.flatMap(m => [m.home, m.away]));
    for (const code of curCodes) {
      if (!participants.has(code)) continue;
      teamHistory.get(code).push({
        season,
        ...teamRecord(matches, code),
        first10: teamRecord(matches, code, { limit: 10 }),
      });
    }
  }

  /* ── 近 10 場風格位移(A 層)──
     風格雷達固定在上季全季 —— 而本季 20 隊裡約一半換了教練,雷達描述的是
     前任的打法。這一層拿逐場可測的量(射門/射正/角球/牌,football-data 季檔,
     同一來源跨季連續)做滾動視窗,跟上季基準比。升班馬沒有上季英超基準,
     delta 為 null;不足 5 場整包 null。**這是資訊,不進模型。**
     xG 只有本季有逐場來源(FPL 逐輪),另外算、另外標,不混進跨季視窗。 */
  const styleTrendBy = new Map();
  const xgTrendBy = new Map();
  {
    /* 逐場 xG(Understat team-dates,已逐場對回賽果)join 進 CSV 列 ——
       xG 三軸(進攻火力/終結效率/防守穩固)因此能跟主雷達同名同義。
       缺 join 的列 xg=null,視窗不完整就整組退回實測軸(style-trend 決定)。 */
    const xgStorePath = join(ROOT, 'data', 'raw', 'understat', 'team-dates.json');
    const xgStore = existsSync(xgStorePath) ? JSON.parse(readFileSync(xgStorePath, 'utf8')) : null;
    const xgLookupFor = season => {
      const bucket = xgStore?.seasons?.[season];
      if (!bucket) return null;
      const map = new Map();
      for (const [code, rec] of Object.entries(bucket)) {
        for (const m of rec.matches ?? []) map.set(`${code}|${m.date}`, { xg: m.xg, xga: m.xga });
      }
      return (code, date) => map.get(`${code}|${date}`) ?? null;
    };
    const csvOf = (season, xgLookup) => {
      const p = join(ROOT, 'data', 'raw', 'football-data-couk', `${season}.csv`);
      return existsSync(p) ? teamMatchRows(readFileSync(p, 'utf8'), { codeOf: T.codeOf, xgLookup }) : new Map();
    };
    const lastRows = csvOf(LAST_SEASON, xgLookupFor(LAST_SEASON)), curRows = csvOf(CURRENT_SEASON, xgLookupFor(CURRENT_SEASON));
    const playedOf = code => fixtures.filter(f => f.played && (f.home === code || f.away === code)).length;
    for (const code of curCodes) {
      const t = styleTrendFor({ lastRows: lastRows.get(code) ?? [], curRows: curRows.get(code) ?? [],
        curPlayed: playedOf(code) });
      if (t) styleTrendBy.set(code, t);
    }
    // 級分的尺 = 上季全季**全部 20 隊**的分布(含降級隊),兩層同一把
    attachTrendPercentiles(styleTrendBy, { ruler: seasonRuler(lastRows) });
    // 本季逐場 xG(FPL 逐輪的球員 xG 按隊加總)。只算本季,不假裝有上季的逐場 xG。
    try {
      const gws = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'season-gws.json'), 'utf8'));
      const acc = new Map();
      for (const r of gws.rounds ?? []) for (const f of r.fixtures ?? []) {
        if (!f.finished) continue;
        const codes = Object.keys(f.lineups ?? {});
        if (codes.length !== 2) continue;
        const xgOf = c => (f.lineups[c] ?? []).reduce((s2, p) => s2 + (Number(p.xG) || 0), 0);
        for (const c of codes) {
          const opp = codes.find(x => x !== c);
          const a = acc.get(c) ?? { games: 0, xg: 0, xga: 0 };
          a.games++; a.xg += xgOf(c); a.xga += xgOf(opp); acc.set(c, a);
        }
      }
      for (const [c, a] of acc) if (a.games > 0) {
        xgTrendBy.set(c, { games: a.games, xg: round(a.xg / a.games, 2), xga: round(a.xga / a.games, 2) });
      }
    } catch { /* 逐輪檔壞了就不給,不擋 build */ }
    console.log(`  風格位移:近 10 場視窗 ${styleTrendBy.size} 隊・本季逐場 xG ${xgTrendBy.size} 隊`);
  }

  /* 雷達的教練覆蓋:上季 38 場裡有幾場是現任帶的。換帥(officialMismatch)或
     任期未知的,覆蓋數給 null —— 畫面要講「這張雷達不一定代表現任的打法」。 */
  const radarCoverageBy = new Map();
  for (const code of curCodes) {
    const c = coachBy.get(code);
    if (!c) continue;
    const lastGames = lastMatches.filter(m => m.home === code || m.away === code);
    const covered = c.since && !c.officialMismatch
      ? lastGames.filter(m => m.date >= c.since).length
      : null;
    radarCoverageBy.set(code, {
      coach: c.zh ?? c.name ?? null, changed: !!c.officialMismatch, since: c.since ?? null,
      lastSeasonGames: covered, lastSeasonTotal: lastGames.length,
    });
  }

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
      styleTrend: styleTrendBy.get(code) ?? null,
      xgTrend: xgTrendBy.get(code) ?? null,
      radarCoverage: radarCoverageBy.get(code) ?? null,
      schedule: difficultySummary.find(d => d.code === code) ?? null,
      history: teamHistory.get(code),
      squadSize: players.filter(p => p.team === code).length,
      injuries: players.filter(p => p.team === code && p.status !== 'a' && p.news).length,
    };
  }).sort((a, b) => (b.sim?.expectedPoints ?? 0) - (a.sim?.expectedPoints ?? 0));

  /* ── 近況與傷停(給人看的資訊,沒有進預測模型) ────────────
     為什麼特別註明「沒有進模型」:近期狀況與交手紀錄都走過一次完整的
     走查回測(npm run tune:form),在沒參與挑係數的賽季上,改善幅度
     連一個標準誤都不到;把特徵拿去跟模型殘差求相關也全部不顯著。
     所以係數留 0 —— 資訊照給,但不假裝它讓預測變準了。 */
  const formIndex = buildFormIndex([...history, ...curMatches]);
  const LATEST = '9999-12-31';        // 索引裡本來就只有已完賽的比賽,取最後五場即可
  const curTableBy = new Map(curTable.map(r => [r.code, r]));
  const teamForm = {};
  for (const code of curCodes) {
    const squad = players.filter(p => p.team === code);
    const rows = recentForm(formIndex, code, LATEST, 5);
    teamForm[code] = {
      recent: rows,
      summary: formSummary(rows),
      // 相對於自己長期水準的落差,正 = 最近超常。這是回測用的特徵值,
      // 顯示出來是為了讓讀者看到「我們確實算了,只是量出來沒用」。
      delta: round(formDelta(formIndex, code, LATEST), 3),
      availability: teamAvailability(squad, { teamMatches: curTableBy.get(code)?.p ?? 0 }),
    };
  }

  /* ── 逐場進球明細 ────────────────────────────
     來源檔由外部協作產生;adapter 會在載入時修正 team 欄(季末快照對轉隊的人是錯的)
     並用日期把每一筆對回賽程。這裡再核一次比分 —— 對不上就不出這份資料,
     寧可少一個區塊,也不要在頁面上放一組跟賽果矛盾的數字。 */
  const goalsBySeason = {};
  for (const gs of GOAL_SEASONS) {
    const seasonMs = bySeason.get(gs) ?? (HISTORY_SEASONS.includes(gs) || gs === CURRENT_SEASON ? null : load(gs));
    if (!seasonMs) continue;
    const g = loadGoals({ root: ROOT, season: gs, matches: seasonMs });
    if (!g) continue;
    const rec = reconcile(g.records, seasonMs);
    if (rec.mismatches.length) {
      console.log(`  ⚠ ${gs} 進球明細與賽果對不上 ${rec.mismatches.length} 場,略過這一季`);
      rec.mismatches.slice(0, 3).forEach(m => console.log(`     ${m.date} ${m.home} ${m.real} ${m.away} → 推得 ${m.got}`));
      continue;
    }
    goalsBySeason[gs] = g.records;
    console.log(`  進球明細 ${gs}:${g.records.length} 筆・比分核對 ${rec.ok}/${rec.checked} ✔`
      + (g.repaired ? `・修正球員隊伍 ${g.repaired} 筆` : ''));
  }

  // ── 交手紀錄(本季所有對戰組合) ────────────
  const h2h = {};
  const pairs = new Set();
  for (const f of curMatches) pairs.add([f.home, f.away].sort().join('|'));
  /* 更早的賽季只給交手紀錄用,不進模型(見 sources.mjs 的說明)。
     檔案不存在就跳過 —— 上游沒有那一季不該讓整個 build 掛掉。 */
  const deepMatches = [];
  const deepSeasons = [];
  for (const s of H2H_EXTRA_SEASONS) {
    if (!existsSync(join(ROOT, 'data', 'raw', 'openfootball', `${s}.json`))) continue;
    deepMatches.push(...loadMatches({
      root: ROOT, competition: COMPETITION, season: s, codeOf: T.codeOf, tolerant: true,
    }));
    deepSeasons.push(s);
  }
  const h2hPool = [...deepMatches, ...history, ...curPlayed];
  for (const key of pairs) {
    const [a, b] = key.split('|');
    /* 交手紀錄要含本季已經踢過的那場 —— 兩隊本季碰過一次卻查不到,
       對讀者來說就是漏資料。history 只到上一季,所以要把本季賽果併進來。 */
    const rec = headToHead(h2hPool, a, b);
    if (rec.games) h2h[key] = rec;
  }
  const h2hSeasons = [...deepSeasons, ...HISTORY_SEASONS, CURRENT_SEASON];
  console.log(`  歷來交手:${h2hSeasons.length} 個賽季(${h2hSeasons[0]} 起)・${Object.keys(h2h).length} 組對戰`
    + (deepSeasons.length < H2H_EXTRA_SEASONS.length
      ? `,另有 ${H2H_EXTRA_SEASONS.length - deepSeasons.length} 季尚未抓取(npm run fetch)` : ''));

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
        // 官方陣型與排位:有的話陣型與球場圖都以官方為準
        official: offLineups?.matches?.[`${f.home}|${f.away}`] ?? null,
      });
      const report = {
        ...rep,
        fixtureId: fx?.id ?? null,
        round: isCurrentSeason ? (fx?.round ?? liveState.round) : liveState.round,
        difficulty: fx?.difficulty ?? null,
      };
      const detail = isCurrentSeason ? advancedFor(liveSeason, f.key) : null;
      return detail ? { ...report, advanced: attachAdvancedCodes(detail, report) } : report;
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
      const report = {
        ...buildMatchReport({
          fixture: f, prediction: pre, tactics: tacticsBy,
          official: isCur ? offLineups?.matches?.[`${f.home}|${f.away}`] ?? null : null,
          zh: code => T.byCode.get(code)?.en ?? code,
        }),
        season: src.season, demo: src.demo,
      };
      const detail = isCur ? advancedFor(src.season, f.key) : null;
      reports[key] = detail ? { ...report, advanced: attachAdvancedCodes(detail, report) } : report;
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


  /* 人工整理的外電摘要。
     跟 RSS 外電不同:中文是人寫的摘要,不是機器翻譯,所以**不掛翻譯標記**。
     跟站內生成的動態也不同:那些是本站算出來的,這些是外部報導。
     摘要裡引用的比分**每次 build 都拿本站賽果重新核對** ——
     交付方自己在檔案裡寫 verified:true 不算數(鐵則五),而且賽果會更新、
     這份檔案是靜態的,只核對一次的話兩邊哪天不一致不會有人發現。

     讀的是**檔案庫疊上收件匣**,不是單一份交付檔 ——
     交付檔一份只涵蓋一週,直接讀它的話下一次交付會把上一週整批蓋掉。
     這個函式英超與西甲共用一份定義(lib/curated-archive.mjs)。 */
  let curatedNews = [], curatedCoverage = null;
  {
    const other = loadTeams(ROOT, { file: 'teams-la-liga.json' });
    const r = await loadCurated({
      root: ROOT, league: 'pl',
      codeOf: n => T.codeOf(n) ?? other.codeOf(n) ?? null,
      fixturesOf: comp => (comp === 'pl' ? fixtures : null),
      fs: { existsSync, readFile, join },
    });
    curatedNews = r.items; curatedCoverage = r.coverage;
    for (const l of r.lines) console.log(`  ${l}`);
  }
  const news = [...curatedNews, ...previews, ...schedule, ...stories, ...injuries.slice(0, 60), ...external]
    .sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));

  // ── 輸出 ──────────────────────────────────
  console.log('寫入資料集:');
  await write('meta.json', {
    builtAt: new Date().toISOString(),
    asOf: AS_OF,
    // 人工整理外電實際涵蓋了哪幾段日子(含斷檔)——不講的話讀者會以為是連續的
    curatedNews: curatedCoverage,
    currentSeason: CURRENT_SEASON,
    lastSeason: LAST_SEASON,
    historySeasons: HISTORY_SEASONS,
    // 交手紀錄涵蓋的賽季 —— 比訓練窗長(見 sources.mjs),頁面上要照實說幾季
    h2hSeasons,
    sources: ATTRIBUTION,
    model: {
      type: 'Dixon-Coles Poisson + Elo(取平均)',
      /* 對戰模擬的前端參數(未捨入)—— golden 測試守著等價性 */
      sim: { ...simParams(model), elo: ELO_PARAMS },
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
    /* 比賽中的快速通道。比賽日的輪詢工作流程每 2 分鐘把 live.json 提交回 repo,
       但 Pages 重新部署要等下一次建置 —— 所以前端直接讀 raw.githubusercontent.com,
       資料一進 repo 就看得到,不用等部署。
       raw 有 access-control-allow-origin: * (已實測),瀏覽器讀得到。
       只有在 Actions 裡建置時才有 repo/分支資訊;本機建置就是 null,前端自動退回讀本地檔。 */
    liveFeed: (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REF_NAME)
      ? `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/${process.env.GITHUB_REF_NAME}/epl/web/data/live.json`
      : null,
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
  /* 官方賽程狀態(延期/取消,football-data.org 快照)。只標註有事的場次,
     沒事不加欄位;快照太舊(>3 天)就不掛 —— 拿舊狀態講今天的事會誤導。 */
  {
    const ssPath = join(ROOT, 'data', 'raw', 'schedule-status.json');
    if (existsSync(ssPath)) {
      const ss = JSON.parse(readFileSync(ssPath, 'utf8'));
      const fresh = ss.leagues?.pl?.fetchedAt && (Date.now() - new Date(ss.leagues.pl.fetchedAt)) < 3 * 86400000;
      if (fresh) {
        const n = attachScheduleStatus(fixtures, ss.leagues.pl.matches);
        if (n) console.log(`  官方賽程狀態:${n} 場標為延期/取消`);
      }
    }
  }
  await write('fixtures.json', fixtures);
  await write('table.json', { last: lastTable, current: curTable, lastSeason: LAST_SEASON, currentSeason: CURRENT_SEASON });
  const roleOf = p => {
    const r = classify(p, p.last ?? p.current);
    return { key: r.key, zh: r.zh, lowSample: !!r.lowSample };
  };
  /* 租借紀錄。只讀核對過的那一份(data/loans-verified.json),不讀收件匣 ——
     收件匣裡有已知是錯的紀錄,直接讀它等於把核對整個繞過去。
     轉換與姓名配對收在 lib/loans.mjs,兩個聯賽呼叫同一支,不各寫一份。 */
  const loans = loadVerifiedLoans(ROOT);
  const loanHit = attachLoans(players, loans, {
    nameOf: p => p.fullName || p.name,
    leagueCodes: new Set(curCodes),
  });
  if (loans.stale) {
    console.log(`  ✗ 租借紀錄過期,整批不掛:${loans.staleReason}`);
    console.log('     修法:npm run loans:verify(核對結果要看過再發布)');
  } else if (loans.available) {
    console.log(`  租借紀錄:掛上 ${loanHit.attached} 筆(核對過 ${loans.records.length} 筆・退回 ${(loans.rejected ?? []).length} 筆)`);
    /* 球隊視角的租借往來(跨聯賽單一份,掛英超目錄 —— cups 同一個慣例;
       球隊頁三個聯賽都從這裡讀,隊碼指的是俱樂部,升降級不影響)。
       等級要跟著資料走到畫面上;evidence 是核對器的內部輸出不進前端,
       source(出處連結)留著 —— 本站的賣點就是查得到出處。 */
    await write('loans.json', {
      verifiedAt: loans.verifiedAt ?? null,
      tally: loans.tally ?? {},
      records: loans.records.map(r => ({
        season: r.season, player: r.player, verdict: r.verdict,
        parent: r.parentClub, parentCode: r.parentCode ?? null,
        loan: r.loanClub, loanCode: r.loanCode ?? null,
        date: r.date ?? null, datePrecision: r.datePrecision ?? null,
        source: r.source ?? null,
      })),
    });
    /* 配不到球員的要印出來 —— 多半是名字寫法不同,那是可以修的。
       靜靜吞掉的話,資料明明在檔案裡卻永遠不會出現在畫面上,而且沒有人會發現。 */
    if (loanHit.unmatched.length) {
      console.log(`  ⚠ 有 ${loanHit.unmatched.length} 筆租借配不到本聯賽球員:`
        + loanHit.unmatched.slice(0, 5).map(r => r.player).join('、')
        + (loanHit.unmatched.length > 5 ? ' …' : ''));
    }
  }
  await write('players.json', players.map(p => ({
    // 照片採「補齊」策略：既有官方／手動快取保持不動，缺圖才使用 SportMonks。
    ...(p.photo || photoData[p.code] ? { ...p, photo: photoData[p.code] || p.photo } : p),
    role: roleOf(p),
  })));
  // 跨聯賽統一層(lib/player-core.mjs):聯集 + null、不帶照片,給跨聯賽搜尋用
  await write('players-core.json', coreFromFpl(players, { lastSeason: LAST_SEASON, currentSeason: CURRENT_SEASON }));
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
  /* 英格蘭盃賽(足總盃 / 聯賽盃)。來源與聯賽完全不同(SportMonks,不是 FPL/openfootball),
     所以**獨立一份產物、獨立一頁**,不混進 fixtures.json ——
     混進去的話「本季 380 場」這個數字會突然變成 500 多場,而那不是聯賽場次。
     沒抓到就整份不出現,前端整頁換成空狀態(不留空欄位)。 */
  {
    const cupsDir = join(ROOT, 'data', 'raw', 'sportmonks-cups');
    const files = ['facup', 'eflcup'];
    const cups = [];
    for (const key of files) {
      const f = join(cupsDir, `${key}.json`);
      if (!existsSync(f)) continue;
      const raw = JSON.parse(await readFile(f, 'utf8'));
      cups.push({
        key: raw.key, zh: raw.zh, en: raw.en,
        retrievedAt: raw.retrievedAt,
        missingSeasons: raw.missingSeasons ?? [],
        seasons: (raw.seasons ?? []).map(summariseSeason),
      });
    }
    /* 盃賽對手的隊徽。**用 SportMonks 的 team id 掛,不用隊名比對** ——
       盃賽有 745 支球隊,隊名寬鬆比對會對錯人(AFC Liverpool 那個坑)。
       本站認得的球隊走 crests.json(前端 C.badge 自己會處理),
       這裡只補**認不得的那些對手**:有隊徽就顯示真的隊徽,沒有就維持只給名字。
       掛隊徽不等於給身分 —— 那些球隊仍然沒有隊碼、點不進去。 */
    /* 對手是第幾級的球隊。盃賽頁上「Sunderland 輸給 Port Vale」看不出是不是冷門 ——
       這一格就是在補那個背景。**層級逐季查**:2025-26 的比賽用 2025-26 的層級,
       球隊每年升降級,拿某一季的層級講另一季就是編數字。
       上游本季只發布到英冠,所以英甲英乙會退回上一季 —— 那種情況要把賽季
       一起帶到前端,畫面必須標出來。對不上的(非聯賽球隊)不給層級,不猜。 */
    {
      const p = join(ROOT, 'data', 'manual', 'team-tiers.json');
      const store = existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null;
      if (store) {
        const unknownNames = new Set();
        let exact = 0, stale = 0, none = 0;
        for (const c of cups) for (const s of c.seasons) for (const r of s.rounds) for (const m of r.matches) {
          for (const side of ['home', 'away']) {
            const t = m[side];
            if (!t?.name || t.code || t.name === 'TBC') continue;
            unknownNames.add(t.name);
            const hit = lookupTier(store, t.name, s.label);
            if (!hit) { none++; continue; }
            t.tier = hit.zh;
            t.tierNo = hit.tier;
            // exact=false 代表這一季查不到、退回別季 —— 帶著賽季讓畫面標出來
            if (!hit.exact) { t.tierSeason = hit.season; stale++; } else exact++;
          }
        }
        const nm = nearMisses(store, [...unknownNames]);
        console.log(`  盃賽對手層級:${exact} 個位置用當季層級・${stale} 個退回別季(畫面會標賽季)`
          + `・${none} 個沒有層級(多半是非聯賽球隊,不猜)`);
        if (nm.length) {
          console.log(`  ⚠ 隊名不完全相同、只是正規化後相等的配對 ${nm.length} 組,請人核對:`);
          for (const x of nm.slice(0, 12)) console.log(`      ${x.cup}  ←→  ${x.source}(${x.season} ${x.tier})`);
        }
      } else {
        console.log('  盃賽對手層級:還沒有 team-tiers.json(跑 npm run tiers)');
      }
    }

    let cupCrests = {};
    {
      const p = join(ROOT, 'data', 'manual', 'crests-cups.json');
      const store = existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null;
      const byId = store?.crests ?? {};
      /* **隊徽只放一份,用 sourceId 查。**
         第一版把 data URI 直接掛在每一個球隊格上,而同一支球隊在一季裡會出現
         很多次 —— 487 個位置 × 8.8 KB,cups.json 從 741 KB 漲到 5.2 MB、
         單檔版從 16.9 MB 漲到 25.6 MB。同一張圖存了幾百遍。
         改成輸出一張 sourceId → data URI 的表,前端自己查。 */
      const used = new Set();
      let hit = 0, miss = 0;
      for (const c of cups) for (const s of c.seasons) for (const r of s.rounds) for (const m of r.matches) {
        for (const side of ['home', 'away']) {
          const t = m[side];
          if (!t || t.code || !t.sourceId) continue;
          if (byId[t.sourceId]) { used.add(t.sourceId); hit++; } else miss++;
        }
      }
      cupCrests = Object.fromEntries([...used].map(id => [id, byId[id]]));
      if (Object.keys(byId).length) {
        const kb = Object.values(cupCrests).reduce((a, v) => a + v.length, 0) / 1024;
        console.log(`  盃賽對手隊徽:${Object.keys(cupCrests).length} 隊有圖(蓋到 ${hit} 個球隊格)`
          + `・${miss} 個格子沒有圖・表大小 ${kb.toFixed(0)} KB`);
      } else {
        console.log('  盃賽對手隊徽:還沒有 crests-cups.json(需要跑 npm run encups 後再跑 npm run cup-crests)');
      }
    }
    if (cups.length) {
      await write('cups.json', {
        source: 'SportMonks',
        // 對手隊徽查表:sourceId → data URI。**一支球隊只存一份**,不要掛在每一場上
        crests: cupCrests,
        retrievedAt: cups.map(c => c.retrievedAt).sort().at(-1) ?? null,
        cups,
      });
      for (const c of cups) {
        for (const s of c.seasons) {
          console.log(`  ${c.zh} ${s.label}:${s.total} 場・已完賽 ${s.played}`
            + `・${s.rounds.length} 輪・延長 ${s.aet}・PK ${s.shootouts}`
            + `・球隊 ${s.teamsKnown}/${s.teamsTotal} 有本站資料`);
        }
      }
    } else {
      console.log('  英格蘭盃賽:沒有快取(需要 SPORTMONKS_TOKEN 跑 npm run encups),本次不產出 cups.json');
    }
  }
  /* 歐冠。**跨聯賽**:英超與西甲兩邊的頁面看到的是同一份,
     所以載入與整理收在 lib/ucl.mjs,兩邊各呼叫一次(build-laliga 也呼叫同一個)。
     隊碼對照同時吃英超與西甲兩份名單 —— 歐冠裡兩邊的球隊都有。 */
  {
    const es = loadTeams(ROOT, { file: 'teams-la-liga.json' });
    const ucl = await loadUclSeasons(ROOT, [{ league: 'pl', codeOf: T.codeOf }, { league: 'es1', codeOf: es.codeOf }]);
    if (ucl) {
      await write('ucl.json', ucl);
      /* 歐冠頁的名字與隊徽走這一份跨聯賽的檔,不查目前聯賽的 clubs ——
         兩份 clubs 的隊碼沒有交集,查了的話同一支球隊在兩頁會叫不同名字、
         隊徽也只出現一半。內容與 build-laliga 產出的必須逐位元組相同。 */
      const assets = await uclTeamAssets(ROOT, ucl);
      await write('ucl-teams.json', assets);
      console.log(`  歐冠球隊名字與隊徽(跨聯賽一份):${assets.known}/${assets.codesInUcl} 個隊碼認得`
        + `・有隊徽 ${assets.teams.filter(t => t.crest).length}`);
      for (const s of ucl.seasons) {
        if (s.availability === 'draw-only') {
          console.log(`  歐冠 ${s.label}:已抽籤未開賽・${s.total} 組對戰・${s.teams} 隊`
            + `・本站認得 ${s.teamsKnown}/${s.teamsTotal} 隊・結構自洽 ${s.draw.check.sane}`
            + `・單一來源(${s.source})`);
          continue;
        }
        if (s.availability !== 'available') { console.log(`  歐冠 ${s.label}:${s.availability}`); continue; }
        console.log(`  歐冠 ${s.label}:${s.total} 場・完賽 ${s.played}・${s.teams} 隊`
          + `・延長 ${s.aet}・PK ${s.shootouts}・名次來源 ${s.table.order}`
          + `・本站認得 ${s.teamsKnown}/${s.teamsTotal} 隊`
          + (s.champion ? `・冠軍 ${s.champion.team.name}` : ''));
        if (s.advancementProblems.length) console.log(`  ⚠ 歐冠 ${s.label} 晉級核對有問題:`, s.advancementProblems);
        if (s.table.mismatches.length) console.log(`  ⚠ 歐冠 ${s.label} 積分榜與官方對不上:`, s.table.mismatches);
        if (s.crossCheck) {
          console.log(`    第二來源核對(${s.crossCheck.source}):隊名 ${s.crossCheck.teamsMatched}/${s.crossCheck.teamsTotal}`
            + `・逐場 ${s.crossCheck.aligned}/${s.crossCheck.total}・問題 ${s.crossCheck.problemCount}`
            + ` → ${s.crossCheck.passed ? '通過' : '未通過,球員榜不採用'}`);
          if (!s.crossCheck.passed) console.log('     ', s.crossCheck.problems.slice(0, 5));
        }
      }
    } else {
      console.log('  歐冠:沒有快取(需要 FOOTBALL_DATA_TOKEN 跑 npm run ucl),本次不產出 ucl.json');
    }
  }
  await write('coaches.json', coaches);
  await write('news.json', news);
  await write('sim.json', sim);
  /* 即時勝率的歷史。累積檔在 data/(比賽日的迴圈會 commit 它),
     產物只給有內容的場次。live.json 的每一場也帶上自己的那條 ——
     實時頁畫進行中的曲線就不用再多載一份。 */
  {
    const histPath = join(ROOT, 'data', 'live-history.json');
    let store = existsSync(histPath) ? JSON.parse(await readFile(histPath, 'utf8')) : null;
    store = appendSamples(store, liveOut);
    if (store) {
      await writeFile(histPath, JSON.stringify(store));
      const site = historyForSite(store);
      if (liveOut.available) {
        for (const m of liveOut.matches) {
          const rec = site.matches[`${m.home}|${m.away}`];
          if (rec) m.probHistory = rec.pts;
        }
      }
      await write('prob-history.json', site);
      const n = Object.keys(site.matches).length;
      if (n) console.log(`  勝率曲線:${n} 場有歷史(累積檔 data/live-history.json)`);
    } else {
      await write('prob-history.json', { season: null, matches: {} });
    }
    /* 即時機率的校準量測(只量不改模型)。從同一份累積檔算,完賽場次越多越準;
       樣本不足時 verdict 是 insufficient,前端要把這件事打在畫面上。 */
    const calib = inplayCalibration(store);
    await write('inplay-calibration.json', calib);
    if (calib.matches) console.log(`  即時校準:${calib.matches} 場完賽・${calib.points} 個時點(${calib.verdict === 'ok' ? '樣本足夠' : `樣本不足,門檻 ${calib.minMatches} 場`})`);
  }
  await write('live.json', liveOut);
  await write('h2h.json', h2h);
  /* 調參與驗收的完整數字(npm run tune:form 產生)。
     沒跑過就沒有 —— 前端會據實顯示「尚未驗證」而不是留白。 */
  const tuningPath = join(ROOT, 'data', 'form-tuning.json');
  const tuning = existsSync(tuningPath) ? JSON.parse(await readFile(tuningPath, 'utf8')) : null;
  /* 進球情境的驗收結果(npm run tune:situations 產生)。
     **沒通過也要帶到前端** —— 模型頁「測過但沒有進模型的特徵」那一段的價值,
     有一半在於把測過而無效的東西攤開來,悄悄不顯示等於假裝沒測過。 */
  /* 進球情境特徵的驗收結果,外加**另一個聯賽**的摘要。
     兩個獨立聯賽都測過都沒過,這個結論比單一聯賽強很多 ——
     但要讓畫面講得出來,就得把另一邊的數字帶進來(而且只在真的有的時候帶)。 */
  const situationTuningPath = join(ROOT, 'data', 'situation-tuning.json');
  const situationTuning = existsSync(situationTuningPath)
    ? JSON.parse(await readFile(situationTuningPath, 'utf8')) : null;
  if (situationTuning) {
    const otherPath = join(ROOT, 'data', 'situation-tuning-es1.json');
    if (existsSync(otherPath)) {
      const o = JSON.parse(await readFile(otherPath, 'utf8'));
      situationTuning.other = {
        league: o.league, leagueLabel: o.leagueLabel, accepted: o.accepted,
        holdout: { baselineRps: o.holdout.baselineRps, trials: o.holdout.trials.slice(0, 1) },
      };
    }
  }
  const congestionTuningPath = join(ROOT, 'data', 'congestion-tuning.json');
  const congestionTuning = existsSync(congestionTuningPath)
    ? JSON.parse(await readFile(congestionTuningPath, 'utf8')) : null;
  /* 進球明細的球員姓名要涵蓋往季 —— 2024-25 有六十幾位進球者已經離開英超,
     只有那一季的名冊查得到他們。名冊抓不到就顯示代碼,不編一個名字出來。 */
  const goalNames = new Map(players.map(p => [p.code, p.name]));
  for (const gs of GOAL_SEASONS) {
    const csv = join(ROOT, 'data', 'raw', 'fpl', `${gs}-players.csv`);
    if (!existsSync(csv)) continue;
    for (const r of parseCSVObjects(readFileSync(csv, 'utf8'))) {
      if (!goalNames.has(r.code)) goalNames.set(r.code, r.web_name);
    }
  }
  /* 本季逐球員進球明細(FotMob 人工交付)。規劃裡這一格原本卡在
     「vaastav 的 2026-27 merged_gw 還沒發布(HTTP 404)」—— 現在有替代來源了。
     只收**核對通過**的場次;min 與 start 上游沒有,所以那一季的每 90 分鐘
     與先發/替補拆分不做。 */
  const goalMatchKeys = {};
  {
    const fmGoalsAll = fotmobGoals(ROOT);
    if (fmGoalsAll && !goalsBySeason[CURRENT_SEASON]) {
      const ourPlayed = curPlayed.map(m => ({ home: m.home, away: m.away, fh: m.fh, fa: m.fa }));
      const v = verifyGoals('pl', fmGoalsAll, ourPlayed);
      const keys = new Set(v.matched.map(x => x.key));
      const { rows, ownGoals } = goalRecords('pl', fmGoalsAll, { onlyKeys: keys });
      if (rows.length) {
        goalsBySeason[CURRENT_SEASON] = rows;
        goalMatchKeys[CURRENT_SEASON] = [...keys];
        for (const r of rows) if (!goalNames.has(r.code)) goalNames.set(r.code, r.name);
        console.log(`  英超本季逐球明細(FotMob):${keys.size} 場・${rows.length} 筆・烏龍球 ${ownGoals}`);
      }
    }
  }
  const goalsOut = buildGoals(goalsBySeason, {
    matchKeys: goalMatchKeys,
    nameOf: c => goalNames.get(c) ?? `#${c}`,
    /* team 與 opp 都要收。只收 team 的話,一支「還沒進過球」的球隊
       整個從資料集消失 —— Coventry 首輪 0-3 輸球,goals.json 裡查無此隊,
       球隊頁連「進球來源」整段都不出現,讀起來像資料壞了,
       其實答案是「進 0 失 3」。沒進球跟沒資料是兩件事。 */
    codes: [...new Set(Object.values(goalsBySeason)
      .flatMap(rs => rs.flatMap(r => [r.team, r.opp])))].sort(),
  });
  {
    const unnamed = new Set();
    for (const s of Object.values(goalsOut)) for (const t of Object.values(s.teams)) {
      for (const p of t.players) if (p.name.startsWith('#')) unnamed.add(p.code);
    }
    if (unnamed.size) console.log(`  ⚠ 進球明細有 ${unnamed.size} 位球員查不到名字(缺該季名冊,顯示為代碼)`);
  }
  await write('goals.json', {
    seasons: Object.keys(goalsOut),
    note: '逐場進球與助攻;FPL 事件不含單球進球方式。球隊層級的運動戰/角球/定位球季統計另由 Understat 提供。',
    data: goalsOut,
  });

  /* 足球知識頁的資料層。共識層(陣型定義、背號慣例、位置分工)是人工整理的,
     放在 data/manual/football-knowledge.json;這裡只算**本站真的算得出來的**:
     每個背號實際上是什麼位置的人在穿、實際用過哪些陣型。
     兩層在前端必須分得出來 —— 把共識寫成看起來像統計的樣子就是編數字。 */
  if (KNOWLEDGE) {
    const profile = numberProfile(players);
    await write('knowledge.json', {
      season: CURRENT_SEASON,
      /* 共識層直接嵌進來。它不分聯賽,兩份各帶一次是重複 ——
         但前端的載入器與單檔打包都是「一個聯賽一組資料集」,
         為了它另開一條載入路徑不划算,而且這份只有十幾 KB。 */
      guide: KNOWLEDGE,
      numbers: { ...profile, tradition: traditionVsData(KNOWLEDGE.numbers, profile) },
      // 英超沒有逐場陣型使用時間,只有本季正式名單上的陣型 —— 粒度不同,unit 標出來
      formations: formationFromLineups(offLineups?.matches ?? offShapes?.matches ?? null),
    });
  }

  await write('form.json', {
    asOf: AS_OF,
    // 誠實標註:這份資料不影響任何一個機率數字
    inModel: false,
    tuned: TUNED,
    tuning,
    situationTuning,
    congestionTuning,
    note: '近五戰、交手紀錄、傷停、上季進球情境與賽程密度都經過走查回測驗證,改善幅度小於雜訊,因此不進預測模型,僅作為資訊呈現。',
    teams: teamForm,
  });
  await write('analysis.json', { ...aiSummary, pre: aiPre, post: aiPost, counts: { pre: aiSummary.pre, post: aiSummary.post } });
  await write('reports.json', {
    seasons: [...new Set(Object.keys(reports).map(k => k.split('|')[0]))],
    count: Object.keys(reports).length,
    reports,
  });
  const knownMatchKeys = new Set([...history, ...curMatches].map(m => `${m.season}|${m.home}|${m.away}`));
  const expertOpinions = loadExpertOpinions(ROOT, { validMatchKeys: knownMatchKeys });
  await write('experts.json', expertOpinions);
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
  const photoHits = players.filter(p => p.photo || photoData[p.code]).length;
  console.log(`  球員頭貼:${photoHits ? `${photoHits} / ${players.length} 名有圖` : '未提供(data/manual/photos.json 不存在,前端退回隊徽)'}`);
  console.log(`  分析文章:賽前 ${aiSummary.pre} 篇・賽後 ${aiSummary.post} 篇,快取命中 ${aiSummary.cacheHits} 篇` +
    (aiSummary.enabled ? `,LLM 潤稿 ${aiSummary.llmWritten} 篇` : '(模板版;設定 ANTHROPIC_API_KEY 可啟用 LLM 潤稿)'));
  console.log(`  真人專家觀點:${expertOpinions.counts.opinions} 筆已核對・${expertOpinions.counts.drafts} 筆草稿(開頁不呼叫 API)`);
  if (liveOut.available) {
    console.log(`  即時:${liveOut.sourceLabel}`);
    console.log(`        第 ${liveOut.round} 輪 —— 進行中 ${liveOut.counts.live}・已完賽 ${liveOut.counts.finished}・未開賽 ${liveOut.counts.upcoming}` +
      (liveFilled ? `(其中 ${liveFilled} 場結果已補進積分榜)` : ''));
  } else {
    console.log('  即時:尚未取得(npm run live)');
  }
}

main().catch(err => { console.error('✗ 建置失敗:', err); process.exit(1); });
