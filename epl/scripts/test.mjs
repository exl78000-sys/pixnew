#!/usr/bin/env node
// 走查回測(walk-forward):只用「比賽日之前」的資料建模,再預測該輪比賽。
// 用來驗證預測引擎沒有偷看未來,而且真的比亂猜好。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadTeams } from './lib/teams.mjs';
import { matchPerson as loanMatchPerson, yearShifted as loanYearShifted } from './verify-loans.mjs';
import { normName, matchOne as nameMatchOne } from './lib/names.mjs';
import { loadMatches } from './lib/adapters/index.mjs';
import { COMPETITION } from './lib/sources.mjs';
import { fitPoisson, applyPromotedPrior, predict } from './lib/poisson.mjs';
import { buildElo, eloProbs } from './lib/elo.mjs';
import { round } from './lib/util.mjs';
import { inPlay } from './lib/inplay.mjs';
import {
  preMatchBundle, postMatchBundle, templateFor, verify, generateReport, ReportCache,
} from './lib/report/index.mjs';
import { attachCodes } from './lib/adapters/pulselive.mjs';
import { oddsIndex, devig, parseOddsCsv, FD_NAMES } from './lib/odds.mjs';
import { pickPair, oklch, contrast, deltaE, THRESHOLDS } from './lib/colour.mjs';
import {
  buildFormIndex, formDelta, goalForm, h2hDelta, recentForm, formSummary, adjustLambdas, TUNED,
} from './lib/form.mjs';
import { teamAvailability, cardWatch } from './lib/availability.mjs';
import { finalCacheIssues, fixtureScoreOf, goalsOf, minuteOf, shouldRefreshFinal } from './fetch-official.mjs';
import { loadGoals, reconcile } from './lib/adapters/fpl-goals.mjs';
import { GOAL_SEASONS, LAST_SEASON } from './lib/sources.mjs';
import { teamGoals } from './lib/goals.mjs';
// 走查回測的實作抽到 lib,英超與西甲跑同一份 —— 複製一份會讓兩個聯賽的數字慢慢不能比
import { walkForward, rps, outcome, logLoss, pairedDiff } from './lib/backtest.mjs';
import { shirtsFromOfficial, shirtsFromManual, backfillSquadNumbers } from './lib/squadnumbers.mjs';
import { numberProfile, traditionVsData, formationUsage, formationFromLineups } from './lib/knowledge.mjs';
import { normaliseCupFixture, buildCupTeamIndex, KNOWN_SCORE_DESCRIPTIONS, KNOWN_STATES } from './lib/adapters/sportmonks-cups.mjs';
import { groupByStage, winnerOf, runsByTeam, championOf } from './lib/cups.mjs';
import { teamRecord } from './lib/table.mjs';
import { loadExpertOpinions, validateExpertOpinions } from './lib/experts.mjs';
import { normaliseMatchDetail } from './lib/adapters/api-football.mjs';
import { nameTokens as uclNameTokens } from './lib/adapters/fotmob-ucl.mjs';
import { checkScores, toFeedItems, forLeague, KNOWN_STATUS } from './lib/adapters/curated-news.mjs';
import { readDelivery, mergeDelivery, pruneArchive, coverageOf, overlay, emptyArchive } from './lib/curated-archive.mjs';
import { tierKey, lookupTier } from './lib/adapters/england-tiers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_SEASON = '2025-26';
const TRAIN_FROM = ['2023-24', '2024-25'];

function checkApiFootball(T) {
  const homeName = T.byCode.get('ARS')?.en ?? 'Arsenal';
  const awayName = T.byCode.get('CHE')?.en ?? 'Chelsea';
  const raw = {
    fixture: { id: 123, date: '2026-08-22T14:00:00Z', status: { short: 'FT' } },
    teams: { home: { name: homeName }, away: { name: awayName } },
    goals: { home: 2, away: 1 },
    lineups: [
      { team: { name: homeName }, formation: '4-3-3', coach: { name: 'Home Coach' },
        startXI: Array.from({ length: 11 }, (_, i) => ({ player: { id: 100 + i, name: `Home ${i + 1}`, number: i + 1, pos: i ? 'D' : 'G', grid: i ? `2:${i}` : '1:1' } })), substitutes: [] },
      { team: { name: awayName }, formation: '4-2-3-1', coach: { name: 'Away Coach' },
        startXI: Array.from({ length: 11 }, (_, i) => ({ player: { id: 200 + i, name: `Away ${i + 1}`, number: i + 1, pos: i ? 'M' : 'G', grid: i ? `2:${i}` : '1:1' } })), substitutes: [] },
    ],
    statistics: [{ team: { name: homeName }, statistics: [
      { type: 'Ball Possession', value: '61%' }, { type: 'Total Shots', value: 17 },
      { type: 'Passes %', value: '88%' }, { type: 'expected_goals', value: '2.14' },
    ] }, { team: { name: awayName }, statistics: [
      { type: 'Ball Possession', value: '39%' }, { type: 'Total Shots', value: 8 },
    ] }],
    players: [{ team: { name: homeName }, players: [{
      player: { id: 7, name: 'Test Player', photo: 'https://example.com/p.png' },
      statistics: [{
        games: { minutes: 90, number: 7, position: 'M', rating: '7.4', captain: false, substitute: false },
        shots: { total: 3, on: 2 }, goals: { total: 1, assists: 1 },
        passes: { total: 52, key: 3, accuracy: '86%' }, tackles: { total: 2, blocks: 1, interceptions: 2 },
        duels: { total: 9, won: 6 }, dribbles: { attempts: 4, success: 3 },
        fouls: { drawn: 2, committed: 1 }, cards: { yellow: 0, red: 0 },
      }],
    }] }],
    events: [{ time: { elapsed: 45, extra: 2 }, team: { name: homeName }, player: { id: 7, name: 'Test Player' }, type: 'Goal', detail: 'Normal Goal' }],
  };
  const d = normaliseMatchDetail(raw, { codeOf: T.codeOf, season: '2026-27' });
  const p = d?.players?.ARS?.[0];
  const cases = [
    ['完賽資料對到正確球隊', d?.key === 'ARS|CHE' && d.status === 'FT'],
    ['百分比與 xG 轉成數值', d?.teamStats?.ARS?.possession === 61 && d.teamStats.ARS.xG === 2.14],
    ['球員評分與完整攻守欄位保留', p?.rating === 7.4 && p.shots.on === 2 && p.passes.key === 3 && p.duels.won === 6 && p.tackles.interceptions === 2],
    ['事件含補時、球員與類型', d?.events?.[0]?.label === "45+2'" && d.events[0].playerId === 7 && d.events[0].type === 'Goal'],
    ['正式陣容、陣型與比分保留', d?.coverage?.lineups === true && d.lineups.ARS.formation === '4-3-3'
      && d.lineups.ARS.xi.length === 11 && d.score.home === 2 && d.score.away === 1],
    ['速度/距離/衝刺明確標成不可用', d?.coverage?.speed === false && d.coverage.distance === false && d.coverage.sprints === false
      && d.unavailable.join('|') === 'speed|distance|sprints'],
  ];
  let fail = 0;
  for (const [name, ok] of cases) { console.log(`  ${ok ? '✔' : '✗'} ${name}`); if (!ok) fail++; }
  return fail;
}

function summarise(name, rows) {
  const n = rows.length;
  const acc = rows.filter(r => r.hit).length / n;
  return {
    模型: name,
    場次: n,
    RPS: round(rows.reduce((a, r) => a + r.rps, 0) / n, 4),
    LogLoss: round(rows.reduce((a, r) => a + r.ll, 0) / n, 4),
    命中率: `${round(acc * 100, 1)}%`,
  };
}

/* AI 報告層的檢查分三塊:
   1. 模板產出的每一篇都要能通過數字驗證(模板自己也不准編數字)
   2. 驗證器擋得住編造的數字與 bundle 沒有的主題
   3. LLM 產出沒通過驗證時,確實會退回模板版而不是照登
*/
async function checkReports() {
  const rd = f => JSON.parse(readFileSync(join(ROOT, 'web', 'data', f), 'utf8'));
  let fixtures, teams, h2h, tactics, reports;
  try {
    [fixtures, teams, h2h, tactics, reports] =
      ['fixtures.json', 'teams.json', 'h2h.json', 'tactics.json', 'reports.json'].map(rd);
  } catch {
    console.log('  ⚠ 找不到前端資料集,跳過(請先跑 npm run build)');
    return 0;
  }
  const byCode = new Map(teams.map(t => [t.code, t]));
  const tacBy = new Map(tactics.map(t => [t.code, t]));
  const bundles = [];
  for (const f of fixtures.filter(x => !x.played)) {
    bundles.push(preMatchBundle({
      fixture: f, home: byCode.get(f.home), away: byCode.get(f.away),
      h2h: h2h[[f.home, f.away].sort().join('|')] ?? null,
      tacticsHome: tacBy.get(f.home), tacticsAway: tacBy.get(f.away),
      asOf: '2026-01-01', seasonLabel: 'test',
    }));
  }
  for (const r of Object.values(reports.reports)) {
    bundles.push(postMatchBundle({
      report: r, home: byCode.get(r.home) ?? { en: r.home, zh: r.home },
      away: byCode.get(r.away) ?? { en: r.away, zh: r.away },
      asOf: '2026-01-01', seasonLabel: 'test',
    }));
  }
  const unverified = bundles.filter(b => !verify(templateFor(b).paragraphs.join('\n'), b.facts).ok);

  const facts = [{ id: 'p', label: '主勝', value: 0.45, text: '45%' }];
  const cases = [
    [`模板 ${bundles.length} 篇全部通過數字驗證`, unverified.length === 0,
      unverified.slice(0, 3).map(b => `${b.key}:${verify(templateFor(b).paragraphs.join('\n'), b.facts).reason}`).join(' / ')],
    ['擋得住編造的數字', !verify('主勝 45%,近 7 場不敗。', facts).ok, ''],
    ['擋得住 bundle 沒有的主題', !verify('主勝 45%,但傷兵滿營。', facts).ok, ''],
    ['4-4-2 不會被誤判成負數', verify('陣型是 4-4-2。', [{ id: 'a', label: 'x', value: 4, text: '4' }, { id: 'b', label: 'y', value: 2, text: '2' }]).ok, ''],
  ];

  // LLM 造假的完整流程:給一個會編數字的假模型,結果必須是模板版而不是它寫的
  const liar = async () => ({
    ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '主隊近 17 場不敗,勝率高達 91%。' }] }),
    text: async () => '',
  });
  const out = await generateReport(bundles[0], { env: { ANTHROPIC_API_KEY: 'test-key' }, fetchImpl: liar });
  cases.push(['LLM 編數字時會退回模板版', out.source === 'template' && /未通過數字驗證/.test(out.note ?? ''), out.note ?? '']);

  const honest = async () => ({
    ok: true, status: 200,
    json: async () => ({ model: 'test', content: [{ type: 'text', text: templateFor(bundles[0]).paragraphs.join('\n\n') }] }),
    text: async () => '',
  });
  const ok2 = await generateReport(bundles[0], { env: { ANTHROPIC_API_KEY: 'test-key' }, fetchImpl: honest });
  cases.push(['LLM 只引用有據數字時會被採用', ok2.source === 'llm', ok2.note ?? '']);

  // 快取存在的意義就是省錢:同一份 bundle 只該打一次 API
  let calls = 0;
  const counted = async (...a) => { calls++; return honest(...a); };
  const cache = new ReportCache(ROOT);
  const env = { ANTHROPIC_API_KEY: 'test-key' };
  await generateReport(bundles[0], { cache, env, fetchImpl: counted });
  const second = await generateReport(bundles[0], { cache, env, fetchImpl: counted });
  cases.push(['同一份資料只打一次 LLM', calls === 1 && second.cached === true, `實際呼叫 ${calls} 次`]);

  // 資料變了就必須重寫,否則讀者會看到跟數字對不上的舊文章
  calls = 0;
  await generateReport(bundles[1], { cache, env, fetchImpl: counted });
  cases.push(['資料變了就重新產生', calls === 1, `實際呼叫 ${calls} 次`]);

  let fail = 0;
  for (const [name, pass, detail] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

function checkExpertOpinions() {
  const good = {
    version: 1, updatedAt: '2026-08-25', matches: {
      '2026-27|ARS|COV': [{
        id: 'verified-example', category: 'expert', expert: 'Test Expert', role: '評論員', publisher: 'Test Publisher',
        publishedAt: '2026-08-22T12:00:00Z', url: 'https://example.com/analysis', sourceType: 'article',
        summary: '這是一段經過人工核對、只用來測試資料驗證器的完整摘要內容。',
        topics: ['壓迫'], evidence: ['與實際 xG 對照'], reviewedAt: '2026-08-25T10:00:00Z', verified: true,
      }, {
        id: 'draft-example', category: 'legend', expert: 'Draft Expert', role: '名宿', publisher: 'Test Publisher',
        publishedAt: '2026-08-22T13:00:00Z', url: 'https://example.com/draft', sourceType: 'broadcast',
        summary: '這是一段欄位完整但尚未經人工核對的草稿,不可以送到前端顯示。', verified: false,
      }],
    },
  };
  const out = validateExpertOpinions(good, { validMatchKeys: new Set(['2026-27|ARS|COV']) });
  const throws = raw => { try { validateExpertOpinions(raw); return false; } catch { return true; } };
  const directQuote = structuredClone(good);
  directQuote.matches['2026-27|ARS|COV'][0].quote = '不應接受的直接引言';
  const missingSource = structuredClone(good);
  missingSource.matches['2026-27|ARS|COV'][0].url = '';
  const badCategory = structuredClone(good);
  badCategory.matches['2026-27|ARS|COV'][0].category = 'fan';
  const sharedSource = structuredClone(good);
  sharedSource.matches['2026-27|ARS|COV'][1] = {
    ...sharedSource.matches['2026-27|ARS|COV'][0], id: 'same-page-other-person',
    category: 'news', expert: 'Other Person', url: 'https://example.com/analysis', verified: true,
  };
  const actual = loadExpertOpinions(ROOT);
  const publicRows = Object.values(actual.matches).flat();
  const cases = [
    ['已核對真人觀點會發布', out.counts.opinions === 1 && out.matches['2026-27|ARS|COV']?.length === 1],
    ['未核對草稿不會送到前端', out.counts.drafts === 1 && !out.matches['2026-27|ARS|COV'].some(x => x.id === 'draft-example')],
    ['缺原始來源會被擋住', throws(missingSource)],
    ['不支援的分類會被擋住', throws(badCategory)],
    ['同一篇原始頁可以收錄不同具名人物', !throws(sharedSource)],
    ['第一版直接引言會被擋住', throws(directQuote)],
    ['目前公開資料全部是具名、已分類且已核對的真人來源', publicRows.every(x => x.human && x.verified && x.expert && x.url && ['news', 'legend', 'expert'].includes(x.category))],
  ];
  let fail = 0;
  for (const [name, ok] of cases) { console.log(`  ${ok ? '✔' : '✗'} ${name}`); if (!ok) fail++; }
  return fail;
}

async function main() {
  const T = loadTeams(ROOT);
  const load = season => loadMatches({ root: ROOT, competition: COMPETITION, season, codeOf: T.codeOf });
  const past = TRAIN_FROM.flatMap(load);
  const test = load(TEST_SEASON).filter(m => m.played);
  const codes = [...new Set(test.flatMap(m => [m.home, m.away]))].sort();
  const rounds = [...new Set(test.map(m => m.round))].sort((a, b) => a - b);

  // 賽季基準線:英超長期的主/和/客分佈
  const BASE = { home: 0.44, draw: 0.25, away: 0.31 };

  // 市場基準:讀當季的博彩收盤賠率(去水錢後的隱含機率)。
  // 有就在同一批比賽上比「模型 vs 市場」;沒有(檔案不存在)這一段就整個略過。
  let odds = null;
  try {
    const csv = readFileSync(join(ROOT, 'data', 'raw', 'football-data-couk', `${TEST_SEASON}.csv`), 'utf8');
    odds = oddsIndex(csv, { codeOf: T.codeOf });
    console.log(`  市場基準:讀到 ${odds.byMatch.size} 場賠率(${TEST_SEASON})`);
  } catch { /* 沒有賠率檔就不比市場 */ }

  const wf = walkForward({ past, test, baseline: BASE, odds });
  const { perMatch } = wf;
  const { dc, el, base, blend, mkt, blendMkt } = wf.rows;

  console.log(`\n▶ 走查回測 ${TEST_SEASON}(訓練資料只到每輪開賽前)\n`);
  console.table([
    summarise('Dixon-Coles Poisson', dc),
    summarise('Elo', el),
    summarise('兩者平均', blend),
    summarise('基準線(固定機率)', base),
  ]);
  if (mkt.length) {
    console.log('\n▶ 模型 vs 市場(同一批有賠率的比賽)');
    console.table([summarise('兩者平均(模型)', blendMkt), summarise('博彩收盤(市場)', mkt)]);
  }
  // 產物由共用實作組出來,這裡只補「哪一季、什麼時候跑的」
  const report = {
    ranAt: new Date().toISOString(), season: TEST_SEASON, trainSeasons: TRAIN_FROM, ...wf.report,
  };
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'backtest.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(ROOT, 'data', 'backtest-matches.json'), JSON.stringify({
    season: TEST_SEASON, ranAt: report.ranAt, matches: perMatch,
  }));
  console.log(`→ 已寫入 data/backtest.json 與 backtest-matches.json(${perMatch.length} 場走查預測)`);

  // 即時勝率模型的自我檢查:性質對不對比數字漂亮更重要
  console.log('\n▶ 即時勝率模型自我檢查');
  const L = { lambdaHome: 1.8, lambdaAway: 1.1 };
  const checks = [
    ['機率總和為 1', Math.abs(((x => x.home + x.draw + x.away)(inPlay({ ...L }))) - 1) < 1e-3],
    ['領先時間越晚勝率越高', inPlay({ ...L, hs: 1, minute: 80 }).home > inPlay({ ...L, hs: 1, minute: 45 }).home],
    ['完賽後收斂成實際結果', inPlay({ ...L, hs: 2, as: 1, minute: 90, finished: true }).home === 1],
    ['紅牌會壓低該隊勝率', inPlay({ ...L, minute: 20, redHome: 1 }).home < inPlay({ ...L, minute: 20 }).home],
  ];
  let inplayFail = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✔' : '✗'} ${name}`); if (!ok) inplayFail++; }

  // AI 報告層:重點不是文字好不好看,是「數字有沒有被編造」這條線守不守得住
  console.log('\n▶ AI 報告層自我檢查');
  const reportFail = await checkReports();

  console.log('\n▶ 真人專家觀點自我檢查');
  const expertFail = checkExpertOpinions();

  console.log('\n▶ API-Football 完賽資料自我檢查');
  const apiFootballFail = checkApiFootball(T);

  // 官方名單對照:配錯人比對不上更糟 —— 對不上只是少張頭貼,配錯是把數據掛到別人身上
  console.log('\n▶ 官方名單球員對照自我檢查');
  const nameFail = checkOfficialNames();

  // 市場基準去水錢:算錯的話整段「模型 vs 市場」都是騙人的
  // 隊名對照:同一個來源在不同賽季會換寫法,對不上就是靜靜漏資料
  console.log('\n▶ 隊名對照自我檢查');
  const teamFail = checkTeamNames(T);

  console.log('\n▶ 賠率去水錢自我檢查');
  const oddsFail = checkOdds();

  // 兩隊對照的配色:紅隊對紅隊的話圖表等於沒有顏色,而且色盲讀者要分得出來
  console.log('\n▶ 兩隊對照配色自我檢查');
  const colourFail = checkColours(T);

  // 近況/交手的特徵:最重要的一項是「它現在不准動到預測」
  console.log('\n▶ 近況與交手特徵自我檢查');
  const formFail = checkForm(past, test);

  console.log('\n▶ 傷停與拿牌自我檢查');
  const availFail = checkAvailability();

  // 兩隊對照條:條長必須跟 ▲ 說的是同一件事
  console.log('\n▶ 兩隊對照條長自我檢查');
  const barFail = await checkBars();

  console.log('\n▶ 資料缺口判斷自我檢查');
  const gapFail = await checkDataGap();

  console.log('\n▶ 官方進球事件解析自我檢查');
  const goalFail = checkGoalEvents();

  console.log('\n▶ 進球子類型自我檢查');
  const kindFail = await checkGoalKinds();

  console.log('\n▶ 比賽事件時間軸自我檢查');
  const timelineFail = await checkTimeline();

  console.log('\n▶ 逐場進球明細自我檢查');
  const detailFail = checkGoalDetails(T);

  console.log('\n▶ Understat 進球情境自我檢查');
  const situationFail = checkGoalSituations();

  console.log('\n▶ 進球資料集「不知道 vs 是 0」自我檢查');
  const nullFail = checkGoalsDataset();

  console.log('\n▶ 背號回填自我檢查');
  const shirtFail = checkSquadNumbers();

  console.log('\n▶ 兩聯賽回測共用實作自我檢查');
  const btFail = checkBacktestShared();

  console.log('\n▶ 足球知識層自我檢查');
  const knFail = checkKnowledge();

  console.log('\n▶ 英格蘭盃賽');
  const cupFail = checkCups();

  console.log('\n▶ 人工整理外電');
  const curatedFail = checkCuratedNews();

  console.log('\n▶ 歐冠');
  const uclFail = checkUcl();

  console.log('\n▶ 租借紀錄(人工交付,必須核對過才發布)');
  const loanFail = checkLoans();

  console.log('\n▶ 資產版本戳(部署後看不看得到更新)');
  const stampFail = checkAssetStamps();

  const better = report.models.blend.rps < report.models.baseline.rps;
  console.log(better ? '\n✔ 預測引擎優於基準線' : '\n✗ 預測引擎未勝過基準線,請檢查參數');
  if (!better || inplayFail || reportFail || expertFail || apiFootballFail || nameFail || oddsFail || colourFail || formFail || availFail || barFail || teamFail || gapFail || goalFail || kindFail || timelineFail || detailFail || situationFail || nullFail || shirtFail || btFail || knFail || cupFail || uclFail || curatedFail || loanFail || stampFail) process.exitCode = 1;
}

/* 建置後的 goals.json:守兩件真的踩過的事。

   一、**沒進過球的球隊不能從資料集消失。**
   codes 原本只從 records 的 team 欄位取,一支「還沒進球、只失球」的球隊
   (Coventry 首輪 0-3)整隊查無資料,球隊頁連整段都不出現 ——
   看起來像壞掉,實際答案是「進 0 失 3」。逐隊對回賽果就抓得到。

   二、**「不知道」不能靜靜變成 0。**
   FotMob 的逐球事件沒有上場分鐘、也沒有先發/替補。第一版 `p.min += null`
   讓分鐘變成 0、`if (r.start)` 把 null 判成替補,產出的是
   「Arsenal 三球全由替補打進,每個人上場 0 分鐘」—— 畫面上看起來像真資料。
   所以 startKnown/minKnown 是 false 的賽季,那些欄位必須是 null 而不是 0。 */
function checkGoalsDataset() {
  const LEAGUES = [
    ['英超', join(ROOT, 'web', 'data', 'goals.json'), join(ROOT, 'web', 'data', 'fixtures.json')],
    ['西甲', join(ROOT, 'web', 'data', 'leagues', 'es1', 'goals.json'),
      join(ROOT, 'web', 'data', 'leagues', 'es1', 'fixtures.json')],
  ];
  const cases = [];
  let any = false;
  for (const [label, gPath, fPath] of LEAGUES) {
    let G, F;
    try {
      G = JSON.parse(readFileSync(gPath, 'utf8'));
      F = JSON.parse(readFileSync(fPath, 'utf8'));
    } catch { cases.push([`${label} 進球資料集`, true, '(還沒建置,略過)']); continue; }
    any = true;
    const fixtures = (F.fixtures ?? F).filter(m => m.played);

    for (const season of G.seasons) {
      const S = G.data[season];
      // 逐隊對回賽果。goals.json 只收「已核對」的場次,所以拿同一批場次來比:
      // 用 vs 裡出現過的對手組合反推是繞路,直接比整季總和即可 ——
      // 兩邊都涵蓋同一批比賽時,總和必須一模一樣。
      const acc = new Map();
      const bump = (c, gf, ga) => {
        const v = acc.get(c) ?? { gf: 0, ga: 0 };
        v.gf += gf; v.ga += ga; acc.set(c, v);
      };
      /* **只比對明細真的涵蓋到的那幾場。**
         逐球明細是人工交付的,只收核對通過的場次;賽程則會先一步拿到新賽果。
         兩邊涵蓋的比賽不同時,整季總和本來就不會一樣 ——
         第一版直接比整季總和,於是每次有新賽果落地、明細還沒跟上,
         這條就變紅,看起來像上游資料錯了,其實只是涵蓋範圍不同。
         matchKeys 是 build 記下來的涵蓋清單;沒有這個欄位(往季走 openfootball,
         整季都有)就照舊比整季。 */
      const covered = Array.isArray(S.matchKeys) ? new Set(S.matchKeys) : null;
      const seasonFixtures = fixtures.filter(m => m.season === season
        && (!covered || covered.has(`${m.home}|${m.away}`)));
      for (const m of seasonFixtures) {
        bump(m.home, m.fh, m.fa); bump(m.away, m.fa, m.fh);
      }
      if (covered) {
        const all = fixtures.filter(m => m.season === season).length;
        cases.push([`${label} ${season} 明細涵蓋清單對得回賽程(${seasonFixtures.length}/${all} 場)`,
          seasonFixtures.length === covered.size,
          `清單 ${covered.size} 場,賽程裡找得到 ${seasonFixtures.length} 場`]);
      }
      /* 賽程檔只放本季,往季的比較就沒有對照組。**這種情況要印成「略過」
         而不是通過** —— 「0 隊全對」是空的綠燈,正是這個專案最怕的東西。
         往季的比分核對由上面的「逐場進球明細」用 openfootball 做。 */
      if (!acc.size) {
        cases.push([`${label} ${season} 逐隊進失球對回賽果`, true,
          '', `(賽程檔沒有 ${season},由逐場進球明細那節核對)`]);
      } else {
      const bad = [];
      for (const [code, v] of acc) {
        const t = S.teams[code];
        if (!t) { if (v.gf || v.ga) bad.push(`${code} 整隊不見(${v.gf}-${v.ga})`); continue; }
        if (t.for !== v.gf || t.against !== v.ga) bad.push(`${code} ${t.for}-${t.against}≠${v.gf}-${v.ga}`);
      }
      cases.push([`${label} ${season} 逐隊進失球對回賽果(${acc.size} 隊${covered ? `・限明細涵蓋的 ${covered.size} 場` : ''})`,
        bad.length === 0, bad.slice(0, 3).join(' / ')]);
      }

      // 沒有 start 的賽季:先發/替補與整季佔比一律 null
      if (S.startKnown === false) {
        const teams = Object.values(S.teams);
        const zeroed = teams.filter(t => t.starterGoals !== null || t.subGoals !== null);
        const players = teams.flatMap(t => t.players);
        const pZero = players.filter(p => p.startG !== null || p.subG !== null);
        cases.push(
          [`${label} ${season} 沒有先發欄位 → 球隊的先發/替補進球是 null 不是 0`,
            zeroed.length === 0 && S.subShare === null,
            `${zeroed.length} 隊被填了數字・subShare=${S.subShare}`],
          [`${label} ${season} 沒有先發欄位 → 球員的先發/替補進球是 null 不是 0`,
            pZero.length === 0, `${pZero.length} 人被填了數字`],
        );
      }
      if (S.minKnown === false) {
        const players = Object.values(S.teams).flatMap(t => t.players);
        const zeroed = players.filter(p => p.min !== null);
        const per90 = players.filter(p => p.g90 !== null || p.a90 !== null);
        cases.push([`${label} ${season} 沒有上場分鐘 → min 與每 90 分鐘一律 null`,
          zeroed.length === 0 && per90.length === 0,
          `min 被填 ${zeroed.length} 人・per90 被填 ${per90.length} 人`]);
      }
      // 有 start 的賽季:先發 + 替補 = 本隊球員自己進的球(不含對手烏龍)
      if (S.startKnown === true) {
        const bad2 = Object.entries(S.teams)
          .filter(([, t]) => t.starterGoals + t.subGoals !== t.for - t.ownFor)
          .map(([c, t]) => `${c} ${t.starterGoals}+${t.subGoals}≠${t.for - t.ownFor}`);
        cases.push([`${label} ${season} 先發進球 + 替補進球 = 本隊球員進球`,
          bad2.length === 0, bad2.slice(0, 3).join(' / ')]);
      }
    }
  }
  if (!any) return 0;
  let fail = 0;
  for (const [name, pass, detail, skip] of cases) {
    if (skip) { console.log(`  ⚠ ${name} —— ${skip}`); continue; }
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 背號回填。三條都是「配錯號碼比留空更糟」的具體形狀:
   同一 code 跨場號碼打架、同隊同名分不出是誰、兩個來源互相矛盾 ——
   遇到任何一種都必須留空,不能挑一個填。 */
/* 走查回測的共用實作。這一節守的是「兩個聯賽的數字可以放在一起看」——
   如果哪天有人把西甲的回測複製成第二份實作,協議一旦分岔,
   RPS 差 0.01 就分不出是聯賽的差異還是實作的差異。

   另外守 pairedDiff:它是「這個優勢穩不穩」的唯一根據,
   算錯的話頁面上那句「幾個標準誤」就是錯的。 */
/* 足球知識層。這一頁大半是**共識**不是本站的統計,所以檢查的重點不是數字對不對,
   而是**兩層有沒有混在一起、每一條共識查不查得到出處**:

   · 每一條共識都要掛得到來源 id,掛不到就是隨口說的
   · 陣型的站位圖每一排加起來要是 11 人,而且要跟 bands 對得上
   · 背號分佈的母體要排除「沒有背號」與「沒有位置」的人,而且要報出排除了幾個 ——
     母體悄悄變小跟編數字是同一件事 */
function checkKnowledge() {
  const cases = [];
  let guide = null;
  try { guide = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', 'football-knowledge.json'), 'utf8')); }
  catch { console.log('  ⚠ 找不到共識層資料,略過'); return 0; }

  const ids = new Set((guide._sources ?? []).map(s => s.id));
  const orphan = [];
  const chk = (o, label) => { for (const id of o.sources ?? []) if (!ids.has(id)) orphan.push(`${label}:${id}`); };
  chk(guide.numberOrigin, 'numberOrigin');
  guide.numbers.forEach(n => chk(n, `#${n.n}`));
  guide.positions.forEach(p => chk(p, p.key));
  guide.formations.forEach(f => chk(f, f.key));
  cases.push(['每一條共識都掛得到來源', orphan.length === 0, orphan.join('、')]);
  cases.push(['每個來源都有短名與網址',
    (guide._sources ?? []).every(s => s.id && s.url && s.short), '']);

  const badRows = guide.formations.filter(f => {
    const flat = (f.rows ?? []).reduce((n, r) => n + r.length, 0);
    const bands = (f.rows ?? []).slice(1).map(r => r.length);
    return flat !== 11 || JSON.stringify(bands) !== JSON.stringify(f.bands);
  }).map(f => f.label);
  cases.push(['每個陣型的站位圖都是 11 人且跟 bands 一致', badRows.length === 0, badRows.join('、')]);

  // 母體:沒有背號、沒有位置的都不能算進去,而且要報出來
  const roster = [
    { squadNumber: 1, pos: 'GK' }, { squadNumber: 1, pos: 'GK' },
    { squadNumber: 9, pos: 'FWD' }, { squadNumber: 9, pos: 'MID' },
    { squadNumber: 9, pos: null },        // 沒有位置 → 不列入
    { squadNumber: null, pos: 'DEF' },    // 沒有背號 → 不列入
    { squadNumber: 99, pos: 'DEF' },      // 超出上限 → 不列入分佈
  ];
  const prof = numberProfile(roster, { maxNumber: 26 });
  const nine = prof.rows.find(r => r.n === 9);
  cases.push(
    ['沒有位置的人不列入分佈,但要算進 droppedNoPos',
      nine.total === 2 && prof.coverage.droppedNoPos === 1],
    ['沒有背號的人不算進 withNumber',
      prof.coverage.withNumber === 6 && prof.coverage.players === 7],
    ['最多的位置與佔比算得對', nine.topPos === 'FWD' || nine.topPos === 'MID' ? nine.topShare === 0.5 : false],
    ['超出上限的號碼不進分佈', !prof.rows.some(r => r.n === 99)],
  );

  const trad = traditionVsData(guide.numbers, prof);
  cases.push(
    ['傳統說法逐號對得上實際分佈', trad.find(t => t.n === 1)?.actual?.total === 2],
    ['沒有樣本的號碼回 null,不硬湊', trad.find(t => t.n === 13)?.actual === null],
  );

  const usage = formationUsage([
    { code: 'AAA', formation: { list: [{ name: '4-4-2', minutes: 300, share: 60 }, { name: '4-3-3', minutes: 200, share: 40 }] } },
    { code: 'BBB', formation: { list: [{ name: '4-4-2', minutes: 500, share: 100 }] } },
  ]);
  cases.push(
    ['陣型使用分鐘逐隊加總', usage.rows[0].label === '4-4-2' && usage.rows[0].minutes === 800],
    ['佔比用全部分鐘當分母', usage.rows[0].share === 0.8],
    ['用最多的隊排在前面', usage.rows[0].topTeams[0].code === 'BBB'],
  );

  const fromLineups = formationFromLineups({
    a: { home: { formation: '4-2-3-1' }, away: { formation: '4-4-2' } },
    b: { home: { formation: '4-2-3-1' }, away: {} },
  });
  cases.push(
    ['正式名單的陣型逐份計數', fromLineups.total === 3 && fromLineups.rows[0].count === 2],
    ['沒有陣型的那一邊不算進母體', fromLineups.rows.reduce((n, r) => n + r.count, 0) === 3],
    ['沒有任何名單時回 null,不回空表', formationFromLineups({}) === null],
  );

  // 產物:兩個聯賽都要有,而且共識層要嵌得進去(前端只載入一組資料集)
  for (const [label, f] of [['英超', ['web', 'data', 'knowledge.json']],
    ['西甲', ['web', 'data', 'leagues', 'es1', 'knowledge.json']]]) {
    try {
      const k = JSON.parse(readFileSync(join(ROOT, ...f), 'utf8'));
      cases.push(
        [`${label}產物帶著共識層`, k.guide?.formations?.length === guide.formations.length],
        [`${label}產物的背號母體有報涵蓋率`, k.numbers?.coverage?.players > 0],
      );
    } catch { cases.push([`${label}知識產物還沒建置,略過`, true]); }
  }

  let fail = 0;
  for (const [name, ok, detail] of cases) {
    console.log(`  ${ok ? '✔' : '✗'} ${name}${ok || !detail ? '' : ` —— ${detail}`}`);
    if (!ok) fail++;
  }
  return fail;
}

function checkBacktestShared() {
  const cases = [];

  // 完美預測 RPS = 0;把機率押錯邊 RPS 最大
  cases.push(
    ['完美預測 RPS = 0', rps({ home: 1, draw: 0, away: 0 }, 0) === 0],
    ['押錯到另一端 RPS = 1', rps({ home: 1, draw: 0, away: 0 }, 2) === 1],
    ['RPS 懲罰「差很遠」多於「差一點」',
      rps({ home: 1, draw: 0, away: 0 }, 2) > rps({ home: 1, draw: 0, away: 0 }, 1)],
    ['outcome:主勝 0、和 1、客勝 2',
      outcome({ fh: 2, fa: 1 }) === 0 && outcome({ fh: 1, fa: 1 }) === 1 && outcome({ fh: 0, fa: 1 }) === 2],
    ['logLoss 對正確結果給越高機率越小',
      logLoss({ home: 0.9, draw: 0.05, away: 0.05 }, 0) < logLoss({ home: 0.4, draw: 0.3, away: 0.3 }, 0)],
  );

  // pairedDiff:兩組完全一樣 → 差距 0;better 每場都好一點點 → 差距正、標準誤 0
  const same = [{ rps: 0.2 }, { rps: 0.3 }, { rps: 0.25 }];
  const d0 = pairedDiff(same, same);
  const better = same.map(r => ({ rps: r.rps - 0.02 }));
  const d1 = pairedDiff(better, same);
  cases.push(
    ['一模一樣的兩組 → 差距 0', d0.diff === 0],
    ['每場都好 0.02 → 差距 0.02、標準誤 0', d1.diff === 0.02 && d1.se === 0],
    ['正負號:better 真的比較好時 diff 為正', d1.diff > 0],
    ['長度不同回 null', pairedDiff(same, same.slice(1)) === null],
  );

  /* 走查不准偷看未來。用一組**造出來的**賽果驗:
     若實作不小心把整季都餵進 fit,第 1 輪就會知道後面發生的事。
     這裡只檢查「每一輪的訓練集不含該輪與其後的比賽」這個不變式,
     用 minBefore=0 讓每一輪都會被預測。 */
  const teams = ['AAA', 'BBB', 'CCC', 'DDD'];
  const test = [];
  let rd = 0;
  for (let i = 0; i < 12; i++) {
    rd = Math.floor(i / 2) + 1;
    const h = teams[i % 4], a = teams[(i + 1) % 4];
    test.push({ season: 'X', date: `2020-01-${String(rd).padStart(2, '0')}`, round: rd,
      home: h, away: a, fh: (i % 3), fa: ((i + 1) % 3), played: true });
  }
  const past = test.map(m => ({ ...m, season: 'W', round: m.round, date: '2019-01-01' }));
  const wf = walkForward({ past, test, baseline: { home: 0.4, draw: 0.3, away: 0.3 }, minBefore: 0, iters: 60 });
  cases.push(
    ['每一場都有預測', wf.perMatch.length === test.length],
    ['機率三者加總為 1',
      wf.perMatch.every(m => Math.abs(m.pred.home + m.pred.draw + m.pred.away - 1) < 1e-3)],
    ['沒有賠率時「模型 vs 市場」整段標成不可用', wf.report.market.available === false],
    ['基準線原樣回傳,不會被改寫', wf.report.baselineProbs.home === 0.4],
  );

  // 產物:兩個聯賽的回測都要用同一組欄位,不然模型頁得寫兩套
  const KEYS = ['games', 'models', 'calibration', 'byRound', 'surprises', 'baselineProbs', 'vsBaseline'];
  for (const [label, f] of [['英超', 'backtest.json'], ['西甲', 'backtest-laliga.json']]) {
    try {
      const r = JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
      const missing = KEYS.filter(k => !(k in r));
      cases.push([`${label}產物有共用實作的全部欄位`, missing.length === 0]);
      cases.push([`${label}模型贏過基準線`, r.models.blend.rps < r.models.baseline.rps]);
    } catch { cases.push([`${label}回測產物還沒產生,略過`, true]); }
  }

  let fail = 0;
  for (const [name, ok] of cases) { console.log(`  ${ok ? '✔' : '✗'} ${name}`); if (!ok) fail++; }
  return fail;
}

function checkSquadNumbers() {
  const cases = [];
  const side = (xi, subs = []) => ({ xi, subs });

  // 一、同一 code 在兩場的背號不同 → 多半是名單對照把兩個人配成同一位,兩筆都丟
  const unstable = shirtsFromOfficial({ matches: {
    'A|B': { home: side([{ code: '1', shirt: 7 }, { code: '2', shirt: 9 }]), away: side([]) },
    'C|D': { home: side([{ code: '1', shirt: 21 }]), away: side([]) },
  } });
  cases.push(['同一球員跨場背號不一致 → 兩筆都不採用',
    !unstable.shirts.has('1') && unstable.shirts.get('2') === 9 && unstable.unstable.includes('1')]);

  // 二、FotMob 交付只有「隊碼 + 顯示名」,同隊同名兩位就不猜
  const roster = [
    { code: 'a1', team: 'ARS', name: 'White' },
    { code: 'b1', team: 'BOU', name: 'Silva' },
    { code: 'b2', team: 'BOU', name: 'Silva' },
  ];
  const man = shirtsFromManual({ hit: new Map([
    ['ARS|White', { squadNumber: 4 }],
    ['BOU|Silva', { squadNumber: 14 }],
  ]) }, roster);
  cases.push(['同隊同名兩位 → 背號不填,並記下原因',
    man.shirts.get('a1') === 4 && !man.shirts.has('b1') && !man.shirts.has('b2')
      && man.ambiguous.some(x => x.startsWith('BOU:Silva'))]);

  // 三、兩個來源都有值但互相矛盾 → 兩邊都不採用(不是挑官方的)
  const players = [
    { code: 'x', team: 'T', name: 'X', squadNumber: null },
    { code: 'y', team: 'T', name: 'Y', squadNumber: null },
    { code: 'z', team: 'T', name: 'Z', squadNumber: null },
    { code: 'w', team: 'T', name: 'W', squadNumber: 21 },
  ];
  const r = backfillSquadNumbers(players, {
    official: new Map([['x', 5], ['z', 8], ['w', 47]]),
    manual: new Map([['x', 6], ['y', 11], ['z', 8]]),
  });
  const byCode = Object.fromEntries(players.map(p => [p.code, p]));
  cases.push(
    ['官方與補件矛盾 → 兩邊都不填', byCode.x.squadNumber === null && r.disagree.includes('x')],
    ['只有補件有 → 填,並標來源', byCode.y.squadNumber === 11 && byCode.y.squadNumberSource === 'fotmob'],
    ['兩邊一致 → 填,來源記官方', byCode.z.squadNumber === 8 && byCode.z.squadNumberSource === 'official' && r.agree === 1],
    ['FPL 已有值不覆蓋,但要把衝突報出來',
      byCode.w.squadNumber === 21 && r.conflicts.some(c => c.code === 'w' && c.official === 47)],
  );

  // 四、實際產物:標了來源的一定有號碼,沒補過的不該帶來源欄位
  try {
    const built = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'players.json'), 'utf8'));
    const bad = built.filter(p => p.squadNumberSource && p.squadNumber == null);
    const src = built.filter(p => p.squadNumberSource).length;
    cases.push([`產物:${src} 人的背號是補進來的,每一筆都真的有號碼`, bad.length === 0]);
  } catch { cases.push(['產物:還沒建置 players.json,略過', true]); }

  let fail = 0;
  for (const [name, ok] of cases) { console.log(`  ${ok ? '✔' : '✗'} ${name}`); if (!ok) fail++; }
  return fail;
}

function checkGoalSituations() {
  let raw, tactics;
  try {
    raw = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'understat', `${LAST_SEASON}-team-situations.json`), 'utf8'));
    tactics = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'tactics.json'), 'utf8'));
  } catch {
    console.log('  ✗ 找不到原始或建置後的進球情境資料');
    return 1;
  }
  const teams = Object.values(raw.teams ?? {});
  const reconciled = teams.every(t => {
    const rows = Object.values(t.situations ?? {});
    return t.validation?.ok
      && rows.reduce((n, s) => n + s.goals, 0) === t.validation.expectedGoals
      && rows.reduce((n, s) => n + s.against.goals, 0) === t.validation.expectedConceded;
  });
  const ars = raw.teams?.ARS;
  const arsTactics = tactics.find(t => t.code === 'ARS');
  const cases = [
    ['20 隊資料完整', raw.complete && teams.length === 20],
    ['五類進失球逐隊對上獨立賽果', reconciled],
    ['Arsenal 角球進球對上官方 19 球', ars?.situations?.FromCorner?.goals === 19 && raw.validation?.arsenalOfficialCheck?.ok],
    ['定位球雷達改用 xG/場', arsTactics?.setPieces?.available
      && arsTactics.setPieces.xG90 === round(ars.nonPenaltySetPiece.xG / ars.matches, 3)
      && arsTactics.radar.some(a => a.label === '定位球威脅' && a.raw === arsTactics.setPieces.xG90)],
  ];
  let fail = 0;
  for (const [name, ok] of cases) { console.log(`  ${ok ? '✔' : '✗'} ${name}`); if (!ok) fail++; }
  return fail;
}

/* 逐場進球明細。這份資料是外部協作抽回來的,所以檢查要當它可能有錯來寫。

   最重要的一條是**比分核對**:每場「我方球員進球 + 對手烏龍球」必須等於實際比分。
   這是拿 openfootball 的賽果來核的 —— 跟 FPL 是兩個獨立來源,對得上才算數。
   交回來的第一版就是靠這條抓到 15 + 24 場對不上,追下去才發現球員隊伍
   取自季末快照、轉隊的人整季的球都記到新東家(Rashford 替曼聯進的 2 球
   被記成維拉的)。adapter 現在會在載入時修掉,這條檢查守著它別再壞。 */
function checkGoalDetails(T) {
  const cases = [];
  let any = false;
  for (const season of GOAL_SEASONS) {
    const ms = loadMatches({ root: ROOT, competition: COMPETITION, season, codeOf: T.codeOf });
    const g = loadGoals({ root: ROOT, season, matches: ms });
    if (!g) { cases.push([`${season} 進球明細`, true, '(檔案不存在,略過)']); continue; }
    any = true;
    const rec = reconcile(g.records, ms);
    cases.push(
      [`${season} 比分與賽果完全相符(${rec.ok}/${rec.checked} 場)`, rec.mismatches.length === 0,
        rec.mismatches.slice(0, 3).map(m => `${m.date} ${m.home} ${m.real} ${m.away}→${m.got}`).join(' / ')],
      [`${season} 每一筆都對得回賽程`, g.orphan === 0, `${g.orphan} 筆對不到`],
    );
    // 烏龍球必須算給對手,不是算給踢進去的那一隊
    const og = g.records.filter(r => r.og > 0);
    if (og.length) {
      const one = og[0];
      const t = teamGoals(g.records, one.team);
      const opp = teamGoals(g.records, one.opp);
      cases.push([`${season} 烏龍球算給對手(${one.team} 的烏龍記成 ${one.opp} 的進球)`,
        t.ownAgainst > 0 && opp.ownFor > 0, `ownAgainst=${t.ownAgainst} ownFor=${opp.ownFor}`]);
    }
  }
  if (!any) return 0;

  /* 隊伍修正:用一筆刻意寫錯 team 的紀錄,驗證 adapter 會從賽程反推回正確的隊伍。
     (這正是 Rashford 那個 bug 的形狀:對手與主客都對,只有 team 是錯的。) */
  const season = GOAL_SEASONS[0];
  const ms = loadMatches({ root: ROOT, competition: COMPETITION, season, codeOf: T.codeOf });
  const g = loadGoals({ root: ROOT, season, matches: ms });
  if (g) {
    const sample = g.records.find(r => r.g > 0);
    const m = ms.find(x => x.date === sample.date && (x.home === sample.team || x.away === sample.team));
    cases.push(['球員的隊伍是從賽程反推的,不是照抄檔案裡的欄位',
      Boolean(m) && (sample.home ? m.home : m.away) === sample.team,
      `${sample.date} ${sample.team} vs ${sample.opp}`]);
  }

  let fail = 0;
  for (const [name, pass, detail] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 官方進球事件的解析。
   踩過兩次雷,兩條都要有測試守著:

   1. 官方的 event.type 是代碼(G/B/S/PS/PE)不是英文字。第一次用 /goal/i
      去比對就得到「0 顆進球」,差點誤報成「官方不給進球事件」。
   2. 改用 type === 'G' 之後,對上真實資料才發現 Brighton 4-0 Aston Villa
      只抓到 3 顆 —— 少的那顆是**烏龍球,型別不是 G**。
      所以現在改用「比分變了就是進球」判定,不需要事先知道所有型別代碼。

   測資用實測回來的真實事件形狀,不要自己編一個好看的。 */
function checkGoalEvents() {
  const events = [
    { clock: { secs: 0, label: "00'00" }, phase: '1', type: 'PS', time: { millis: 1000 }, score: { homeScore: 0, awayScore: 0 } },
    { id: 183587, personId: 72371, teamId: 4, assistId: 49293, clock: { secs: 60, label: "01'00" }, phase: '1', type: 'G', description: 'G', time: { millis: 2000 }, score: { homeScore: 0, awayScore: 1 } },
    { id: 227665, personId: 51229, teamId: 4, clock: { secs: 300, label: "05'00" }, phase: '1', type: 'B', description: 'Y', time: { millis: 2500 }, score: { homeScore: 0, awayScore: 1 } },
    { id: 391374, personId: 63741, teamId: 4, clock: { secs: 3900, label: "65'00" }, phase: '2', type: 'S', description: 'ON', time: { millis: 5000 }, score: { homeScore: 1, awayScore: 2 } },
    // 刻意亂序:後進的球放前面,驗證會被排回時間順序
    { id: 9, personId: 999, teamId: 4, clock: { secs: 5600, label: "90+4'00" }, phase: '2', type: 'G', description: 'P', time: { millis: 9000 }, score: { homeScore: 2, awayScore: 2 } },
    // 真實事故測資:PE 的寫入時間比同比分的真正 G 早,不能讓 PE 先占走這顆球
    { id: 8, clock: { secs: 5600, label: "90+4'00" }, phase: '2', type: 'PE', time: { millis: 8999 }, score: { homeScore: 2, awayScore: 2 } },
    { id: 183594, personId: 128976, teamId: 34, assistId: 6712, clock: { secs: 1380, label: "23'00" }, phase: '1', type: 'G', description: 'G', time: { millis: 3000 }, score: { homeScore: 1, awayScore: 1 } },
    // 烏龍球:型別不是 G,踢進自家門的是客隊球員(teamId 34),但分要算給主隊
    { id: 77, personId: 88888, teamId: 34, clock: { secs: 2600, label: "43'00" }, phase: '1', type: 'OG', description: 'O', time: { millis: 4000 }, score: { homeScore: 1, awayScore: 2 } },
  ];
  const g = goalsOf(events);
  const own = g.find(x => x.type === 'OG');
  const cases = [
    ['比分變了就算進球,出牌與換人不算', g.length === 4, `抓到 ${g.length} 筆`],
    ['烏龍球也算進去(型別不是 G,只認 G 會漏掉)', Boolean(own), g.map(x => x.type).join()],
    ['烏龍球算給得分的那一隊,不是踢進去的那一隊',
      own?.side === 'A' && own?.team === 34, `side=${own?.side} team=${own?.team}`],
    ['助攻者跟著那一顆球', g[0].person === 72371 && g[0].assist === 49293, JSON.stringify(g[0])],
    ['沒有助攻者時是 null,不是 0 或 undefined', g.at(-1).assist === null, String(g.at(-1).assist)],
    ['亂序的事件會排回時間順序', g.map(x => x.min).join() === '1,23,43,90', g.map(x => x.min).join()],
    ['傷停時間算進該半場的最後一分鐘', minuteOf("90+4'00") === 90, String(minuteOf("90+4'00"))],
    ['type 與 description 原封不動保留,不自己翻譯',
      g.at(-1).kind === 'P' && g.at(-1).type === 'G', `${g.at(-1).type}/${g.at(-1).kind}`],
    ['同比分的 PE 比 G 早寫入時,仍由真正 G 提供射手',
      g.at(-1).person === 999 && g.at(-1).type === 'G', JSON.stringify(g.at(-1))],
    /* 收口(2026-08-31):認領資格走白名單。黑名單擋不掉沒見過的代碼 ——
       紅牌 R 不在黑名單、又帶 personId,真正的進球事件若剛好缺 personId
       (烏龍球實際發生過),射手就會被安到吃牌的人身上;而品質檢查抓不到,
       因為 person 不是 null,只是錯的人。認不出是進球就留 null 讓它重抓。 */
    ['無射手的烏龍球撞上同比分的紅牌:寧可留 null,不把吃牌的人當射手', (() => {
      const gg = goalsOf([
        { id: 1, type: 'OG', description: 'O', teamId: 34, clock: { label: "12'00" }, time: { millis: 1000 },
          score: { homeScore: 1, awayScore: 0 } },                     // 烏龍球,沒有 personId
        { id: 2, type: 'R', personId: 55555, teamId: 34, clock: { label: "20'00" }, time: { millis: 2000 },
          score: { homeScore: 1, awayScore: 0 } },                     // 同比分下的紅牌,有 personId
      ]);
      return gg.length === 1 && gg[0].person === null && gg[0].side === 'H';
    })(), ''],
    ['白名單:沒見過的代碼不得認領進球(不給分類那條規則)', (() => {
      const gg = goalsOf([
        { id: 1, type: 'ZZ', personId: 4242, clock: { label: "30'00" }, time: { millis: 1000 },
          score: { homeScore: 0, awayScore: 1 } },
      ]);
      return gg.length === 1 && gg[0].person === null;
    })(), ''],
    ['進球當下比分有帶出來', g[0].hs === 0 && g[0].as === 1, `${g[0].hs}-${g[0].as}`],
    ['沒有 events 也不會炸', goalsOf(undefined).length === 0, ''],
    ['沒有比分的事件不會被誤判成進球',
      goalsOf([{ type: 'G', personId: 1 }]).length === 0, ''],
    ['完賽快取有空射手時要重抓',
      shouldRefreshFinal({ final: true, goals: [{ person: null, hs: 1, as: 0 }] }, { home: 1, away: 0 }), ''],
    ['完賽快取完整時不用重抓',
      !shouldRefreshFinal({ final: true, goals: [{ person: 1, hs: 1, as: 0 }] }, { home: 1, away: 0 }), ''],
    ['完賽重試遵守 nextRetryAt,不會在比賽日每兩分鐘狂打', (() => {
      const cached = { final: true, goals: [{ person: null, hs: 1, as: 0 }], quality: { nextRetryAt: '2026-08-31T12:10:00.000Z' } };
      return !shouldRefreshFinal(cached, { home: 1, away: 0 }, Date.parse('2026-08-31T12:00:00.000Z'))
        && shouldRefreshFinal(cached, { home: 1, away: 0 }, Date.parse('2026-08-31T12:11:00.000Z'));
    })(), ''],
    ['比分與進球數不一致會列為品質問題',
      finalCacheIssues({ goals: [{ person: 1, hs: 1, as: 0 }] }, { home: 2, away: 0 }).includes('goal-count-mismatch'), ''],
    ['官方賽程的主客比分可正規化',
      JSON.stringify(fixtureScoreOf({ teams: [{ score: 4 }, { score: { current: 3 } }] })) === '{"home":4,"away":3}', ''],
  ];
  let fail = 0;
  for (const [name, pass, detail] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 比賽事件時間軸:牌、換人與半場標記(2026-08-29 加)。

   這批資料本來就跟進球一起回來,只是以前整批丟掉了 —— 零額外請求。

   三件要守住的事:
   1. **換人不配對「誰換誰」。** 官方事件流沒有欄位把 ON 與 OFF 連起來,
      而同一分鐘同一隊可以換兩人(實測 FUL vs CHE 第 65 分,四筆事件時間完全相同)。
      配錯人比不配對糟得多。
   2. **沒見過的代碼不分類。** 目前見過 Y 與 R;R 是拿 FPL 逐球員資料獨立核對過的
      (BHA vs AVL 第 40 分,FPL 說 AVL 的 Gomes 紅牌 1、上場 39 分)。
      第三種出現時 kind 是 null、原碼留在 kindRaw。
   3. **隊伍用名單反查,不看 teamId** —— 跟進球那裡同一套。 */
async function checkTimeline() {
  const { timelineOf } = await import('./fetch-official.mjs');
  const { namedTimeline } = await import('../scripts/lib/adapters/pulselive.mjs');

  const events = [
    { type: 'PS', clock: { label: "00'00", secs: 0 }, phase: '1' },
    { type: 'B', clock: { label: "09'00", secs: 540 }, phase: '1', personId: 1, teamId: 100, description: 'Y' },
    { type: 'B', clock: { label: "40'00", secs: 2400 }, phase: '1', personId: 1, teamId: 100, description: 'R' },
    { type: 'PE', clock: { label: "45+3'00", secs: 2880 }, phase: '1' },
    { type: 'PS', clock: { label: "45'00", secs: 2700 }, phase: '2' },
    // 同一分鐘同一隊換兩人 —— 四筆的順序不可以被拿來配對
    { type: 'S', clock: { label: "65'00", secs: 3900 }, phase: '2', personId: 2, teamId: 100, description: 'ON' },
    { type: 'S', clock: { label: "65'00", secs: 3900 }, phase: '2', personId: 3, teamId: 100, description: 'OFF' },
    { type: 'S', clock: { label: "65'00", secs: 3900 }, phase: '2', personId: 4, teamId: 100, description: 'ON' },
    { type: 'S', clock: { label: "65'00", secs: 3900 }, phase: '2', personId: 5, teamId: 100, description: 'OFF' },
    { type: 'B', clock: { label: "70'00", secs: 4200 }, phase: '2', personId: 9, teamId: 200, description: 'ZZ' },
    { type: 'PE', clock: { label: "90+5'00", secs: 5700 }, phase: '2' },
  ];
  const t = timelineOf(events);
  const H = { xi: [{ id: 1, name: '主隊吃牌', code: 'h1' }, { id: 3, name: '被換下', code: 'h3' }, { id: 5, name: '被換下二', code: 'h5' }],
    subs: [{ id: 2, name: '換上一', code: 'h2' }, { id: 4, name: '換上二', code: 'h4' }] };
  const A = { xi: [{ id: 9, name: '客隊怪牌', code: 'a9' }], subs: [] };
  const n = namedTimeline(t, H, A, 'HOM', 'AWY');

  const cases = [
    ['牌抓得到', t.cards.length === 3, String(t.cards.length)],
    ['換人抓得到', t.subs.length === 4, String(t.subs.length)],
    ['半場標記只有 PS/PE 四筆', t.periods.length === 4, String(t.periods.length)],
    ['黃牌與紅牌都分類得出來',
      t.cards[0].kind === '黃牌' && t.cards[1].kind === '紅牌', ''],
    /* 這一條是核心:沒見過的代碼**不可以**自己補一個中文名。 */
    ['沒見過的牌代碼不分類,原碼留著',
      t.cards[2].kind === null && t.cards[2].kindRaw === 'ZZ', JSON.stringify(t.cards[2])],
    ['補時的 label 保留得到(45+3)',
      t.periods.some(p => p.label === "45+3'00"), ''],
    ['隊伍用名單反查,不是 teamId',
      n.cards[0].team === 'HOM' && n.cards[2].team === 'AWY', ''],
    ['球員名字對得上', n.cards[0].player === '主隊吃牌' && n.subs[0].player === '換上一', ''],
    /* **沒有任何欄位宣稱誰替誰。** 有的話就是在猜。 */
    ['換人沒有「誰替誰」的欄位',
      n.subs.every(x => !('replaces' in x) && !('replacedBy' in x) && !('pairedWith' in x)), ''],
    ['上場與下場分得出來',
      n.subs.filter(x => x.dir === 'on').length === 2
      && n.subs.filter(x => x.dir === 'off').length === 2, ''],
    ['沒有 events 也不會炸', timelineOf(undefined).cards.length === 0, ''],
    ['沒有 timeline 時 namedTimeline 回 null', namedTimeline(null, H, A, 'HOM', 'AWY') === null, ''],
  ];

  /* 正式資料裡出現沒見過的代碼就要紅 —— 先核對過才放行(跟進球子類型同一套規矩)。 */
  const off = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'official.json'), 'utf8'));
  const unknownCards = new Set(), unknownDirs = new Set();
  let cardN = 0, subN = 0, noTeam = 0;
  for (const m of Object.values(off.matches ?? {})) {
    for (const c of m.timeline?.cards ?? []) { cardN++; if (!c.kind) unknownCards.add(c.kindRaw); if (!c.team) noTeam++; }
    for (const x of m.timeline?.subs ?? []) { subN++; if (!x.dir) unknownDirs.add(x.dirRaw); if (!x.team) noTeam++; }
  }
  cases.push(
    ['正式資料裡沒有沒見過的牌代碼', unknownCards.size === 0, [...unknownCards].join('、')],
    ['正式資料裡沒有沒見過的換人代碼', unknownDirs.size === 0, [...unknownDirs].join('、')],
    ['正式資料的事件都查得到隊伍', noTeam === 0, `${noTeam} 筆查不到`],
    ['產物裡真的有牌與換人', cardN > 0 && subN > 0, `牌 ${cardN}・換人 ${subN}`],
  );

  /* **進行中的場次要重抓。** 原本的條件是「有陣容就跳過」,而陣容賽前一小時就有了,
     於是整場比賽都不會再更新事件 —— 進球、牌與換人要等完賽才一次補上。
     比賽日的迴圈每 2 分鐘叫一次 fetch-official 就是為了拿這些,跳過等於那一步白跑。 */
  {
    const src = readFileSync(join(ROOT, 'scripts', 'fetch-official.mjs'), 'utf8');
    cases.push(
      ['進行中的場次不會被「已有陣容」跳過',
        /const live = f\.status === 'L'/.test(src) && /!done && !live && cached\.home/.test(src), ''],
      ['牌與換人有存進快取', /timeline: timelineOf\(/.test(src) || /timelineOf\(d\.events\)/.test(src), ''],
    );
  }

  let fail = 0;
  for (const [name, pass, detail] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 進球子類型:一般 / 十二碼 / 烏龍球。

   接手文件曾經寫「description 還沒集滿,不要猜一個對照表寫死」。現在集到三種了
   —— G 一般、P 十二碼、O 烏龍球,O 是拿名單核對的(踢進的人在對方名單裡)——
   所以開始顯示。但界線要守住:**沒見過的代碼一律 null**,不能因為
   「看起來應該是某某」就補一個進去,那就變成編數據了。

   烏龍球另外有一個容易寫反的地方:球算給得分方(team),
   踢進去的人卻在失球那一隊的名單裡。查名字要跨兩隊一起查,
   只查得分方會查成「不詳」。 */
async function checkGoalKinds() {
  const { namedGoals } = await import('../scripts/lib/adapters/pulselive.mjs');
  const H = { xi: [{ id: 1, name: '主隊射手', code: 'h1' }, { id: 2, name: '主隊助攻', code: 'h2' }], subs: [] };
  const A = { xi: [{ id: 9, name: '客隊自擺烏龍', code: 'a9' }], subs: [{ id: 8, name: '客隊替補', code: null }] };
  const raw = [
    { side: 'H', person: 1, assist: 2, min: 10, label: "10'00", kind: 'G', hs: 1, as: 0 },
    { side: 'H', person: 9, assist: null, min: 20, label: "20'00", kind: 'O', hs: 2, as: 0 },
    { side: 'A', person: 8, assist: null, min: 30, label: "30'00", kind: 'P', hs: 2, as: 1 },
    { side: 'A', person: 8, assist: null, min: 40, label: "40'00", kind: 'ZZ', hs: 2, as: 2 },
  ];
  const g = namedGoals(raw, H, A, 'HOM', 'AWY');
  const [normal, own, pen, unknown] = g;

  const cases = [
    ['一般進球不給子類型標籤', normal.kind === null, String(normal.kind)],
    ['P 認成十二碼', pen.kind === 'penalty', String(pen.kind)],
    ['O 認成烏龍球', own.kind === 'own', String(own.kind)],
    ['沒見過的代碼一律 null,不憑空補分類', unknown.kind === null, String(unknown.kind)],
    ['沒見過的代碼仍留下原碼,將來要再分類查得到', unknown.kindRaw === 'ZZ', String(unknown.kindRaw)],
    ['烏龍球算給得分的那一隊', own.team === 'HOM', String(own.team)],
    ['烏龍球標得出踢進去的人是哪一隊的', own.scorerTeam === 'AWY', String(own.scorerTeam)],
    ['烏龍球的射手查得到名字(要跨兩隊查,只查得分方會變不詳)',
      own.scorer === '客隊自擺烏龍', String(own.scorer)],
    ['助攻跟著那一顆球', normal.assist === '主隊助攻' && normal.assistCode === 'h2', JSON.stringify(normal)],
    ['沒有助攻時是 null', pen.assist === null, String(pen.assist)],
    ['對不上我方球員庫時仍給名字,code 是 null,不編一個 code',
      pen.scorer === '客隊替補' && pen.scorerCode === null, JSON.stringify(pen)],
    ['沒有進球事件時回空陣列,不是 null', namedGoals([], H, A, 'HOM', 'AWY').length === 0, ''],
  ];

  // 真實資料也要照同一套規則:目前見過的代碼只有 G/P/O,多出來的一定要先核對過再放行
  const store = join(ROOT, 'web', 'data', 'official.json');
  if (existsSync(store)) {
    /* 只驗 final 的場次 —— 進行中的比賽官方事件是流式進來的,剛進的球
       射手欄可能晚幾分鐘才補上(2026-08-29 LIV|NFO 進行中實際踩到:
       0:1 那顆 scorer 還是 null,測試假紅)。暫態不是資料錯。 */
    const live = Object.values(JSON.parse(readFileSync(store, 'utf8')).matches ?? {})
      .filter(m => m.final)
      .flatMap(m => m.goals ?? []);
    const seen = [...new Set(live.map(x => x.kindRaw))].filter(Boolean).sort();
    cases.push(
      ['正式資料裡沒有沒核對過的子代碼', seen.every(k => ['G', 'P', 'O'].includes(k)), seen.join()],
      ['正式資料每一顆進球都查得到射手', live.every(x => x.scorer), `${live.filter(x => !x.scorer).length} 顆查不到`],
    );
  }

  let fail = 0;
  for (const [name, pass, detail] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 隊名對照。踩過的雷:openfootball 在 2018-19 寫 "Manchester United"、
   2020-21 起改寫 "Manchester United FC",對照不到就被 tolerant 模式靜靜吞掉,
   曼聯的歷來交手因此少了兩季,而畫面上完全看不出來。
   所以這裡把「同一支隊的各種寫法」直接列出來當測資。 */
function checkTeamNames(T) {
  const same = [
    ['MUN', ['Manchester United', 'Manchester United FC', 'Man Utd', 'Man United']],
    ['MCI', ['Manchester City', 'Manchester City FC', 'Man City']],
    ['BOU', ['AFC Bournemouth', 'Bournemouth', 'Bournemouth FC']],
    ['BHA', ['Brighton & Hove Albion', 'Brighton & Hove Albion FC', 'Brighton and Hove Albion', 'Brighton']],
    ['NFO', ['Nottingham Forest', 'Nottingham Forest FC', "Nott'm Forest"]],
    ['TOT', ['Tottenham Hotspur', 'Tottenham Hotspur FC', 'Spurs', 'Tottenham']],
    ['WHU', ['West Ham United', 'West Ham United FC', 'West Ham']],
    ['WOL', ['Wolverhampton Wanderers', 'Wolverhampton Wanderers FC', 'Wolves']],
  ];
  const bad = [];
  for (const [code, names] of same) {
    for (const n of names) if (T.codeOf(n) !== code) bad.push(`${n} → ${T.codeOf(n)}(應為 ${code})`);
  }
  /* 賠率來源(football-data.co.uk)自己有一份隊名對照表。
     兩份對照表遲早會走鐘,所以這裡直接拿它的 27 個隊名去打 codeOf ——
     哪天有一邊漏了新球隊,這條會先叫。 */
  const fdBad = Object.entries(FD_NAMES).filter(([n, c]) => T.codeOf(n) !== c)
    .map(([n, c]) => `${n} → ${T.codeOf(n)}(應為 ${c})`);
  // 反向:不在名冊裡的球隊必須回 null,不能被寬鬆比對硬湊給某一隊
  const gone = ['Watford FC', 'Norwich City', 'West Bromwich Albion FC', 'Cardiff City', 'Huddersfield Town'];
  const wrong = gone.filter(n => T.codeOf(n) !== null).map(n => `${n} → ${T.codeOf(n)}`);

  const cases = [
    [`同一隊的 ${same.reduce((a, x) => a + x[1].length, 0)} 種寫法都對得上`, bad.length === 0, bad.slice(0, 3).join(' / ')],
    [`賠率來源的 ${Object.keys(FD_NAMES).length} 個隊名 codeOf 也認得`, fdBad.length === 0, fdBad.slice(0, 3).join(' / ')],
    ['已降級、名冊裡沒有的球隊回 null,不會硬湊', wrong.length === 0, wrong.join(' / ')],
  ];
  let fail = 0;
  for (const [name, pass, detail] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 兩隊對照條(core.js 的 versus)。
   這個元件踩過兩次雷,兩次都是「圖跟字互相矛盾」:
     1. 「越低越好」的項目沒取倒數,第 16 名的條比第 5 名長;
     2. 取了倒數之後,值是 0 的那一邊變成 1/0,把對面壓成一根針。
   兩次都是眼睛看出來的,那就把它變成算得出來的 —— 直接讀元件吐出的
   width 百分比,檢查它跟 ▲ 標的方向一致。

   core.js 是給瀏覽器用的,模組載入時會綁一個 keydown。這裡補一個最小的
   document 樁就能在 Node 裡載入真正的元件 —— 抄一份到測試裡是沒有意義的,
   抄本不會跟著壞。 */
async function checkBars() {
  globalThis.document ??= { addEventListener() {} };
  const V = await import('../web/assets/js/core.js');

  // 每一列拆出:主隊條長、客隊條長、▲ 標在哪一邊
  const parse = html => html.split('class="vs-row"').slice(1).map(chunk => {
    const w = [...chunk.matchAll(/width:([\d.]+)%/g)].map(m => Number(m[1]));
    const vals = chunk.split('vs-track');            // [主隊值, 主隊條…, 標籤+客隊條, 客隊值]
    const homeWin = /vs-win/.test(vals[0]);
    const awayWin = /vs-win/.test(vals[vals.length - 1]);
    return { h: w[0], a: w[1], win: homeWin ? 'h' : awayWin ? 'a' : null };
  });

  const rows = [
    { label: '越低越好・一邊是 0', h: 0, a: 7.3, better: 'low' },
    { label: '越低越好・兩邊都 0', h: 0, a: 0, better: 'low' },
    { label: '越低越好・名次', h: 5, a: 16, better: 'low' },
    { label: '越低越好・失球', h: 10, a: 5, better: 'low' },
    { label: '越高越好・一邊是 0', h: 0, a: 3 },
    { label: '越高越好・勝點', h: 1.4, a: 0.8 },
    { label: '一邊沒有資料', h: null, a: 2 },
  ];
  const out = parse(V.versus(rows, { home: 'AAA', away: 'BBB' }));

  const named = rows.map((r, i) => ({ ...r, ...out[i] }));
  const withWin = named.filter(r => r.win);
  const agree = withWin.every(r => (r.win === 'h' ? r.h >= r.a : r.a >= r.h));
  const inRange = named.filter(r => r.h != null && r.a != null && r.h !== 0)
    .every(r => r.h >= 6 && r.h <= 100 && r.a >= 6 && r.a <= 100);
  const zeroRow = named[0];
  const bothZero = named[1];
  const noData = named[6];

  const cases = [
    ['條長方向跟 ▲ 一致', agree,
      withWin.filter(r => (r.win === 'h' ? r.h < r.a : r.a < r.h)).map(r => r.label).join('、')],
    ['條長都在 6%~100% 之間', inRange, named.map(r => `${r.h}/${r.a}`).join(' ')],
    ['值是 0 時對面不會被壓成一根針', zeroRow.a >= 6, `對面只有 ${zeroRow.a}%`],
    ['兩邊都 0 時一樣長', bothZero.h === bothZero.a, `${bothZero.h} vs ${bothZero.a}`],
    ['沒有資料就不畫條', noData.h === 0 && noData.a === 0, `${noData.h} vs ${noData.a}`],
  ];

  let fail = 0;
  for (const [name, pass, detail] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 資料缺口判斷(core.js 的 dataGap)。
   西甲的戰術頁與球員頁曾經吐出「載入失敗…請先執行 npm run build」——
   訊息對象是開發者,而且理由是錯的:真正的原因是西甲還沒有那份資料。
   現在由 dataGap 判斷該不該擋,判錯就直接變成讀者看到的錯訊息,
   所以這裡把每一種情況都釘死。

   特別要守住兩條相反方向的:
     · 導覽列沒掛的主頁面要擋(不然又回到開發者訊息)
     · 單場分析**不能**擋 —— 它是從賽程表點進去的,西甲有比分、預測與
       風格對比,真的做得出來,一起擋掉等於砍掉一個能用的功能。 */
async function checkDataGap() {
  globalThis.document ??= { addEventListener() {} };
  const V = await import('../web/assets/js/core.js');
  const W = await import('./live-window.mjs');
  const full = { formation: { a: 1 }, shapes: { a: 1 }, players: [1], leaders: { a: 1 }, news: [1], live: { a: 1 }, form: { a: 1 } };
  const g = (lg, page, names, data = full, absent = []) => V.dataGap(lg, page, names, data, absent);

  const cases = [
    ['西甲的戰術頁已開放,只依賴可核對的 Understat 球隊資料', !g('es1', 'tactics', ['tactics'], { tactics: [1] })],
    ['西甲的球員頁已開放,不擋', !g('es1', 'players', ['players', 'leaders'])],
    ['球員頁開放了但資料是空的,保險仍然會擋',
      !!g('es1', 'players', ['players', 'leaders'], { ...full, players: [] })],
    ['西甲的動態頁已開放,資料存在時不擋', !g('es1', 'news', ['news'], { ...full, news: [1] })],
    ['西甲的動態頁資料空的仍擋', !!g('es1', 'news', ['news'], { ...full, news: [] })],
    ['西甲的實時戰況頁已開放,沒有即時來源時仍可顯示模板', !g('es1', 'live', ['live'], { ...full, live: { available: false } })],
    /* 模型頁對西甲開了 —— 但它沒有回測數字,所以「開」的意思是
       「照實說明為什麼還不能回測,並攤開模型設定」,不是「假裝有驗證結果」。
       守兩件事:有 form 就不擋;form 缺了保險照樣擋(不然會開出一個真的空頁)。 */
    ['西甲的模型驗證頁已開放', !g('es1', 'model', ['form'])],
    ['模型頁開放了但 form 缺了,保險仍然會擋',
      !!g('es1', 'model', ['form'], { ...full, form: {} })],
    ['西甲的單場分析不擋', !g('es1', 'analysis', ['players', 'shapes'], { players: [], shapes: {} })],
    ['西甲已開放的賽程頁不擋', !g('es1', 'fixtures', ['fixtures'], { fixtures: [1] })],
    ['西甲已開放的球隊頁不擋(球員是空的也一樣)', !g('es1', 'teams', ['players'], { players: [] })],
    ['西甲的足球知識頁已開放,共識層在就不擋',
      !g('es1', 'knowledge', ['knowledge'], { knowledge: { guide: { formations: [1] } } })],
    ['知識頁的共識層是空的仍然擋(保險)',
      !!g('es1', 'knowledge', ['knowledge'], { knowledge: {} })],
    ['英超每一頁都不擋', ['index', 'live', 'fixtures', 'teams', 'tactics', 'players', 'news', 'model']
      .every(p => !g('pl', p, Object.keys(full)))],
    ['宣告開放但資料是空的仍然擋(保險)', !!g('pl', 'news', ['news'], { ...full, news: [] })],
    ['資料集缺檔也算缺口', !!g('pl', 'players', ['players', 'leaders'], { players: [1] }, ['leaders'])],
    ['缺口訊息不出現 build / 404 這些字',
      !/build|404|npm/i.test(g('es1', 'news', ['news'], { ...full, news: [] }).message)],
    ['缺口帶得出這一頁需要什麼',
      g('es1', 'news', ['news'], { ...full, news: [] }).needs.join() === 'news'],

    /* ── 英冠(2026-08-28 加的第三個聯賽)──
       它只掛三頁,而且**做不到的那幾頁不是「還在補」** —— 沒有來源。
       缺口頁的文案要講得出這個差別。 */
    ['英冠的球員頁要擋', !!g('en2', 'players', ['players', 'leaders'])],
    ['英冠的戰術頁要擋', !!g('en2', 'tactics', ['tactics'], { tactics: [1] })],
    ['英冠的實時頁要擋', !!g('en2', 'live', ['live'])],
    ['英冠的首頁、球隊、模型、動態不擋',
      ['index', 'teams', 'model', 'news'].every(p => !g('en2', p, Object.keys(full)))],
    /* 動態頁是 2026-08-28 補的:BBC 與 Guardian 的英冠 feed 實測可用。
       但它跟其他三頁一樣要有保險 —— 宣告開放而資料是空的仍然要擋。 */
    ['英冠的動態頁資料空的仍然擋(保險)',
      !!g('en2', 'news', ['news'], { ...full, news: [] })],
    ['英冠的缺口說法是「沒有來源」不是「還在補」',
      /實測|做不出來/.test(V.LEAGUES.en2.gapNote ?? '')],

    /* **分頁標籤有些是函式**(首頁要顯示「英超首頁 / 西甲首頁 / 英冠首頁」)。
       pageLabel 原本直接回傳,於是缺口頁把函式的原始碼印在畫面上:
       `L => \`${L.zh}首頁\``。實際看到才發現的,所以補一條守著。 */
    ['pageLabel 解得開函式標籤', V.pageLabel('index', 'en2') === '英冠首頁'
      && V.pageLabel('index', 'pl') === '英超首頁'],
    ['pageLabel 不會把程式碼吐給讀者',
      !['index', 'teams', 'model', 'ucl', 'knowledge', 'cups']
        .some(p => /=>|\$\{/.test(V.pageLabel(p, 'en2')))],
    /* ── 開賽倒數(2026-08-28 修)──
       原本是 upcoming.slice(0, 8),而一輪有 10 場(英冠 12 場),
       所以**每一輪都固定有兩場沒有倒數**,被切掉的還是開球最晚的那兩場。
       實測 2026-27 第 2 輪:Man Utd vs Ipswich 與 Aston Villa vs Arsenal
       在整個「開賽倒數」區都找不到。

       規則是「開球順序上第一段連續同輪」——沒有任何 magic number,
       卡片數上限自然等於一輪的場數。量過三種做法「把一輪切一半」的時間比例:
       固定筆數 22%/65%/69%、湊滿一輪再停 0%/13%/0%、現行 0%/13%/0%,
       而現行的卡片上限從 19~23 降到 10~12。 */
    ['一輪 10 場就顯示 10 場',
      V.countdownFixtures([...Array(10)].map((_, i) => ({ id: i, round: 2 }))
        .concat([...Array(10)].map((_, i) => ({ id: 10 + i, round: 3 })))).length === 10],
    ['英冠一輪 12 場就顯示 12 場',
      V.countdownFixtures([...Array(12)].map((_, i) => ({ id: i, round: 2 }))
        .concat([{ id: 'x', round: 3 }])).length === 12],
    /* 改期的補賽自成一段(輪次跟前後都不同),單獨顯示一張卡 —— 那是對的:
       2025-26 第 31 輪的 Man City vs Crystal Palace 晚了 53 天才踢,
       同輪其他九場早就結束。剩下的不是藏起來,由呼叫端補一行摘要。 */
    ['改期的補賽自成一段,不會把下一輪拖進來', (() => {
      const rows = [{ id: 'late', round: 31 }, ...[...Array(10)].map((_, i) => ({ id: i, round: 36 }))];
      const out = V.countdownFixtures(rows);
      return out.length === 1 && out[0].id === 'late';
    })()],
    ['永遠不會把一輪切一半', (() => {
      const rows = [...[...Array(4)].map((_, i) => ({ id: i, round: 2 })),
        ...[...Array(10)].map((_, i) => ({ id: 10 + i, round: 3 }))];
      const out = V.countdownFixtures(rows);
      // 第 2 輪只剩 4 場就是它全部;第 3 輪一場都不混進來(那一輪要嘛全給要嘛不給)
      return out.length === 4 && out.every(f => f.round === 2);
    })()],
    ['沒有未賽場次時回空陣列', V.countdownFixtures([]).length === 0],

    /* ── 球隊頁的「接下來的賽程」(2026-08-28 修)──
       原本排在最後(陣容那一大塊後面)而且連到 index 的速覽抽屜 ——
       全站其他每一處單場連結都是 analysis 的完整單場頁。 */
    ['球隊頁的未來賽程連到單場分析,不是首頁', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
      const blk = src.slice(src.indexOf('function nextFixturesBlock'), src.indexOf('function detail('));
      return /C\.link\('analysis'/.test(blk);
    })()],
    ['球隊頁的未來賽程排在陣容之前(排在最後等於沒有)', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
      /* 兩個都只在版面樣板裡出現一次,直接比位置就夠 ——
         不要拿 ${C.foot(meta)} 之類的當範圍錨點,那一段在別的函式裡也有。 */
      const a = src.indexOf('${nextFixturesBlock(');
      const b = src.indexOf('${squadSection(');
      return a > 0 && b > 0 && a < b;
    })()],
    ['球隊頁的倒數會走(有叫 startCountdowns)', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
      return /C\.startCountdowns\(\)/.test(src);
    })()],
    /* 「看完整賽程」連的是首頁那張賽程表(它本來就有球隊/賽季/輪次/狀態四個篩選),
       **不是另外做一頁** —— 做第二份的話改了一邊另一邊會悄悄過期。 */
    ['球隊頁的完整賽程連到既有的賽程表並帶球隊', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
      const blk = src.slice(src.indexOf('function nextFixturesBlock'), src.indexOf('function detail('));
      return /C\.link\('index', \{ team: t\.code \}\)/.test(blk);
    })()],
    /* 深連結進來要**同時**放開輪次篩選 —— 輪次預設是「下一輪」,
       只設球隊的話「看完整賽程」會只剩一場,那就是說了不算。 */
    /* 「本季還有 N 場」不可以數 upcoming —— upcoming 只收**有開球時間**的場次
       (scheduleState 對沒有 kickoff 的回 unknown),而上游是逐月公布時間的:
       實測西甲 339/380、英冠 264/552 目前還沒有時間。拿 upcoming 去講,
       西甲會顯示「本季還有 11 場」,而它其實還有三百多場。 */
    ['實時頁的「本季還有幾場」數的是未賽場次,不是有開球時間的場次', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-live.js'), 'utf8');
      return /const unplayedCount = fixtures\.filter\(f => !f\.played\)\.length/.test(src)
        && /本季還有 \$\{unplayedCount\} 場未賽/.test(src);
    })()],
    ['沒有開球時間的場次確實不會進倒數(三個聯賽都有這種場次)', (() => {
      const has = ['data', 'data/leagues/es1', 'data/leagues/en2'].map(d => {
        const f = JSON.parse(readFileSync(join(ROOT, 'web', d, 'fixtures.json'), 'utf8'));
        return f.some(x => !x.kickoff && !x.played);
      });
      // 英超目前全有時間,另外兩個聯賽一定有沒時間的 —— 這條是在守「這件事真的存在」
      return has[1] && has[2];
    })()],
    ['賽程表讀得到 ?team=,而且會把輪次篩選一起放開', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'fixture-list.js'), 'utf8');
      const i = src.indexOf("C.qs('team')");
      if (i < 0) return false;
      const blk = src.slice(i, i + 700);
      return /selectIds\.round/.test(blk) && /\.value = ''/.test(blk)
        && /options\].some/.test(blk);   // 隊碼對不上就當沒帶,不要靜靜篩成空的
    })()],

    /* ── 跨聯賽總覽頁(2026-08-29 加)──
       它是「本站有哪些聯賽、各做到哪一層」的入口。三件事要守住:
       只放在 SITE_PAGES(兩邊都放會出現兩個一樣的分頁)、每個聯賽都掛得上、
       而且不可以自己列一份聯賽清單。 */
    ['總覽只在 SITE_PAGES,不在 PAGES(兩邊都放會出現兩個一樣的分頁)', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'core.js'), 'utf8');
      const site = src.slice(src.indexOf('const SITE_PAGES = ['), src.indexOf('const GROUPS = ['));
      const pages = src.slice(src.indexOf('const PAGES = ['), src.indexOf('const ESSENTIAL_') >= 0
        ? src.indexOf('const ESSENTIAL_') : src.indexOf('export function nav'));
      return /'overview'/.test(site) && !/\['overview'/.test(pages);
    })()],
    ['每個聯賽的導覽列都掛得上總覽', Object.entries(V.LEAGUES)
      .every(([, L]) => !L.open || L.open.includes('overview'))],
    ['總覽不會被當成某個聯賽的缺口頁擋掉',
      Object.keys(V.LEAGUES).every(lg => !V.closedPage(lg, 'overview'))],
    ['總覽的聯賽清單從註冊表長出來,不寫死', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-overview.js'), 'utf8');
      return /Object\.keys\(C\.LEAGUES\)/.test(src)
        && !/\{\s*id:\s*'pl'/.test(src) && !/id === 'pl'/.test(src);
    })()],
    /* 讀取邏輯只留一份 —— 總覽自己再寫一次 fetch 的話,哪天改了快取或路徑規則,
       那一頁會悄悄用舊的規則。 */
    ['總覽走共用的 loadFrom,沒有自己再寫一份 fetch', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-overview.js'), 'utf8');
      return /C\.loadFrom\(/.test(src) && !/\bfetch\(/.test(src);
    })()],
    /* 英冠沒有球員頁,給連結等於把讀者送去缺口頁 —— 判斷走 closedPage,
       不要在總覽頁再列一次哪個聯賽有哪些頁。 */
    ['總覽只連得進去的頁才給連結', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-overview.js'), 'utf8');
      return /C\.closedPage\(/.test(src);
    })()],
    ['總覽對沒有球員來源的聯賽不顯示 0', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-overview.js'), 'utf8');
      return /capabilities\?\.players === false/.test(src) && /沒有來源/.test(src);
    })()],
    /* bundle.mjs 自己維護第三份頁面清單。忘了加的話那一頁不會壞,
       只會從單檔版靜靜消失,而分頁版一切正常 —— 實際發生過(總覽)。 */
    ['單檔版的頁面清單涵蓋 web/ 底下每一個 .html', (() => {
      const src = readFileSync(join(ROOT, 'scripts', 'bundle.mjs'), 'utf8');
      const list = /const PAGES = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
      const inBundle = new Set([...list.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]));
      const onDisk = readdirSync(join(ROOT, 'web')).filter(f => f.endsWith('.html'))
        .map(f => f.replace(/\.html$/, ''));
      const missing = onDisk.filter(p => !inBundle.has(p));
      return missing.length === 0;
    })()],
    ['overview.html 存在且載入 page-overview.js', (() => {
      const html = readFileSync(join(ROOT, 'web', 'overview.html'), 'utf8');
      return /page-overview\.js/.test(html);
    })()],

    /* ── 比賽日進場判斷(2026-08-29 修)──
       **原本會讓整個高頻更新失效。** live-window 只要讀得到 data/raw/live.json
       就信它,而那是**上一次抓的快照** —— 進場前根本還沒抓。
       實測:Crystal Palace vs Man City 開賽 10 分鐘,而快照是 199 分鐘前的第 1 輪
       (全部 finished),於是回報「不進場,下一場還有 979 分鐘」,手動觸發也進不去。 */
    ['即時資料過期時,改用開賽時間判斷「正在踢」', (() => {
      const now = Date.parse('2026-08-28T19:10:00Z');
      const r = W.decideWindow({
        now,
        fixtures: [{ home: 'CRY', away: 'MCI', kickoff: '2026-08-28T19:00:00Z', played: false },
          { home: 'LIV', away: 'NFO', kickoff: '2026-08-29T11:30:00Z', played: false }],
        // 199 分鐘前的快照,內容是上一輪、全部踢完
        live: { demo: false, fetchedAt: '2026-08-28T15:52:00Z', fixtures: [{ started: true, finished: true }] },
      });
      return r.active === true && r.liveCount === 1 && /開賽時間/.test(r.reason);
    })()],
    ['即時資料夠新時就信它(輪詢迴圈裡剛抓完的那一份)', (() => {
      const now = Date.parse('2026-08-28T19:10:00Z');
      const r = W.decideWindow({
        now,
        fixtures: [{ home: 'CRY', away: 'MCI', kickoff: '2026-08-28T19:00:00Z', played: false }],
        live: { demo: false, fetchedAt: '2026-08-28T19:09:00Z', fixtures: [{ started: true, finished: false }] },
      });
      return r.active === true && /即時資料源/.test(r.reason);
    })()],
    /* 迴圈的退出條件靠這個:最後一場剛踢完,feed 已經說 finished,
       但依開賽時間算還在 TAIL_MIN 內 —— 這時要信 feed 才不會空轉。 */
    ['最後一場剛結束時要收工,不要靠開賽時間空轉', (() => {
      const now = Date.parse('2026-08-28T20:50:00Z');
      const r = W.decideWindow({
        now,
        fixtures: [{ home: 'CRY', away: 'MCI', kickoff: '2026-08-28T19:00:00Z', played: false }],
        live: { demo: false, fetchedAt: '2026-08-28T20:49:00Z', fixtures: [{ started: true, finished: true }] },
      });
      return r.active === false;
    })()],
    ['沒有 fetchedAt 的即時資料當成過期', (() => {
      const now = Date.parse('2026-08-28T19:10:00Z');
      const r = W.decideWindow({
        now,
        fixtures: [{ home: 'CRY', away: 'MCI', kickoff: '2026-08-28T19:00:00Z', played: false }],
        live: { demo: false, fixtures: [{ started: true, finished: true }] },
      });
      return r.active === true && /開賽時間/.test(r.reason);
    })()],
    ['完全沒有即時資料時也判斷得出正在踢', (() => {
      const now = Date.parse('2026-08-28T19:10:00Z');
      const r = W.decideWindow({ now, live: null,
        fixtures: [{ home: 'CRY', away: 'MCI', kickoff: '2026-08-28T19:00:00Z', played: false }] });
      return r.active === true;
    })()],
    ['已完賽的場次不算「正在踢」(補賽改期才不會空轉)', (() => {
      const now = Date.parse('2026-08-28T19:10:00Z');
      const r = W.decideWindow({ now, live: null,
        fixtures: [{ home: 'CRY', away: 'MCI', kickoff: '2026-08-28T19:00:00Z', played: true }] });
      return r.active === false;
    })()],
    ['下一場還很久就不進場', (() => {
      const now = Date.parse('2026-08-28T19:10:00Z');
      const r = W.decideWindow({ now, live: null,
        fixtures: [{ home: 'LIV', away: 'NFO', kickoff: '2026-08-29T11:30:00Z', played: false }] });
      return r.active === false && /下一場還有/.test(r.reason);
    })()],
    /* 進場判斷要認得每個有即時來源的聯賽。原本只讀英超的檔案,
       西甲那支 workflow 因此沒有守衛 —— 排程一開就是不分晝夜每次都打 SportMonks。 */
    ['進場判斷走註冊表,西甲與英超各讀自己的檔', (() => {
      const src = readFileSync(join(ROOT, 'scripts', 'live-window.mjs'), 'utf8');
      return /const LEAGUES = \{/.test(src) && /leagues', 'es1', 'fixtures\.json'/.test(src)
        && /sportmonks-la-liga/.test(src);
    })()],
    ['不認得的聯賽回 active:false,不會誤判成英超',
      W.liveWindow(Date.now(), 'zzz').active === false],
    /* 三支 workflow 的排程 2026-08-29 開回來。西甲那支同時補了守衛 ——
       沒有守衛的「每 5 分鐘」等於沒比賽也每天打 576 次 API。
       (別在 block comment 裡寫 cron 的星號斜線寫法,那會提早把註解關掉。) */
    ['西甲比賽日 workflow 有「沒比賽就結束」的守衛', (() => {
      const src = readFileSync(join(ROOT, '..', '.github', 'workflows', 'laliga-matchday.yml'), 'utf8');
      return /live-window\.mjs --league=es1/.test(src)
        && /steps\.win\.outputs\.active == 'true'/.test(src);
    })()],
    ['三支 workflow 都有排程', (() => {
      return ['epl-live.yml', 'epl-matchday.yml', 'laliga-matchday.yml'].every(f =>
        /cron:/.test(readFileSync(join(ROOT, '..', '.github', 'workflows', f), 'utf8')));
    })()],
    /* **push 觸發刻意不恢復。** 原本 push 到 claude/** 就跑一次完整建置與部署,
       那是關掉排程的主因(高頻更新與部署互相排隊)。 */
    ['部署那支不吃 push 觸發', (() => {
      const src = readFileSync(join(ROOT, '..', '.github', 'workflows', 'epl-live.yml'), 'utf8');
      const on = src.slice(src.indexOf('\non:'), src.indexOf('\npermissions:'));
      return !/^\s*push:/m.test(on);
    })()],
    ['快開賽了就先睡到賽前 75 分再進場', (() => {
      const now = Date.parse('2026-08-28T19:10:00Z');
      const r = W.decideWindow({ now, live: null,
        fixtures: [{ home: 'LIV', away: 'NFO', kickoff: '2026-08-28T21:00:00Z', played: false }] });
      return r.active === true && r.sleepSec === Math.round((110 - 75) * 60);
    })()],

    /* ── 2026-08-29 全案掃描抓到的三處(都是「寫死的事實碰上第三個聯賽」)── */
    ['vault 的走查回測檔走註冊表,不是「不是英超就讀西甲」', (() => {
      const src = readFileSync(join(ROOT, 'scripts', 'build-obsidian.mjs'), 'utf8');
      return /join\(ROOT, 'data', lg\.wf\)/.test(src)
        && /wf: 'backtest-championship-matches\.json'/.test(src)
        && !/backtest-laliga-matches\.json'\s*\)/.test(src.split('const LEAGUES')[1].split('];')[1] ?? '');
    })()],
    ['分析頁的「整季 N 場」從回測資料來,不寫死 380', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-analysis.js'), 'utf8');
      return /整季 \$\{mk\.games\} 場/.test(src) && !/整季 380 場/.test(src);
    })()],
    ['首頁的「重跑上季 N 輪」從賽制來,不寫死 38(英冠是 46)', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-index.js'), 'utf8');
      return /roundsPerSeason/.test(src) && !/重跑上季 38 輪/.test(src);
    })()],

    /* ── 勝率曲線的累積器(2026-08-29 加)──
       inPlay 每 2 分鐘算一次就丟,這裡守「存下來」那一段的行為。 */
    ...await (async () => {
      const { appendSamples, historyForSite } = await import('./lib/prob-history.mjs');
      const mk = (over = {}) => ({
        available: true, demo: false, season: '2026-27',
        matches: [{ home: 'CRY', away: 'MCI', started: true, finished: false, hs: 0, as: 0,
          preMatch: { home: 0.45, draw: 0.28, away: 0.27 },
          inplay: { minute: 10, home: 0.4, draw: 0.3, away: 0.3 }, ...over }],
      });
      let st = appendSamples(null, mk());
      // 快照當下的值 —— store 是原地修改的,留引用的話會被後面的呼叫改掉
      const first = JSON.parse(JSON.stringify(st.matches['CRY|MCI'].pts));
      st = appendSamples(st, mk({ inplay: { minute: 10, home: 0.41, draw: 0.3, away: 0.29 } }));
      const sameMin = JSON.parse(JSON.stringify(st.matches['CRY|MCI'].pts));
      st = appendSamples(st, mk({ inplay: { minute: 12, home: 0.38, draw: 0.3, away: 0.32 }, hs: 0, as: 1 }));
      st = appendSamples(st, mk({ finished: true, inplay: { minute: 90, home: 0, draw: 0, away: 1 }, hs: 0, as: 1 }));
      const done = st.matches['CRY|MCI'];
      const after = appendSamples(st, mk({ inplay: { minute: 95, home: 0.5, draw: 0.5, away: 0 } }));
      const demo = appendSamples(null, { ...mk(), demo: true });
      const newSeason = appendSamples(st, { ...mk(), season: '2027-28' });
      return [
        ['第一個點是賽前機率(第 0 分)', first[0][0] === 0 && first[0][1] === 0.45, JSON.stringify(first[0])],
        ['同一分鐘留最新的一點,不疊', sameMin.length === 2 && sameMin[1][1] === 0.41, String(sameMin.length)],
        ['完賽補收斂點並封存', done.done === true && done.pts.at(-1)[0] === 90 && done.pts.at(-1)[3] === 1, ''],
        ['封存之後不再追加(賽後重跑不會疊點)',
          after.matches['CRY|MCI'].pts.length === done.pts.length, ''],
        ['重播(demo)不累積', demo === null, ''],
        ['換季就重開', newSeason.season === '2027-28' && !newSeason.matches['CRY|MCI'].done, ''],
        ['少於 3 點的場次不進產物',
          Object.keys(historyForSite({ season: 'x', matches: { a: { pts: [[0, 1, 0, 0, 0, 0]], done: false } } }).matches).length === 0, ''],
      ];
    })(),
    ['三個聯賽都有 prob-history 產物(缺一份分析頁會 404)',
      ['data', 'data/leagues/es1', 'data/leagues/en2'].every(d =>
        existsSync(join(ROOT, 'web', d, 'prob-history.json'))), ''],

    /* ── 近 10 場風格位移(A 層,2026-08-29 加)── */
    ...await (async () => {
      const { styleTrendFor, teamMatchRows, attachTrendPercentiles, seasonRuler } = await import('./lib/style-trend.mjs');
      const csv = 'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HC,AC,HY,AY,HR,AR\n'
        + 'E0,10/08/2025,Alpha,Beta,2,1,15,8,6,3,7,2,1,2,0,0\n'
        + 'E0,17/08/2025,Beta,Alpha,0,0,10,12,2,5,4,6,3,1,1,0\n';
      const rows = teamMatchRows(csv, { codeOf: n => ({ Alpha: 'AAA', Beta: 'BBB' }[n] ?? null) });
      const aaa = rows.get('AAA');
      const mk = n => Array.from({ length: n }, (_, i) => ({
        date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
        sf: 10, sa: 10, stf: 4, sta: 4, cf: 5, ca: 5, cards: 2, gf: 1, ga: 1, htgf: 1, htga: 0 }));
      const full = styleTrendFor({ lastRows: mk(38), curRows: mk(2) });
      const promoted = styleTrendFor({ lastRows: [], curRows: mk(6) });
      const thin = styleTrendFor({ lastRows: [], curRows: mk(3) });
      return [
        ['季檔逐場解析:主客展開、欄位對邊', aaa?.length === 2
          && aaa[0].sf === 15 && aaa[0].sa === 8 && aaa[1].sf === 12 && aaa[1].home === false,
          JSON.stringify(aaa?.[1] ?? null)],
        ['視窗取最近 10 場且跨季', full && full.recent.games === 10 && full.currentSeasonGames === 2, ''],
        ['上季完整才給基準與位移', full && full.baseline?.games === 38 && full.delta != null, ''],
        /* 升班馬拿英冠基準比會把「聯賽變強」誤讀成「打法變了」—— 基準一定是 null。 */
        ['升班馬沒有上季基準,delta 為 null', promoted && promoted.baseline === null && promoted.delta === null, ''],
        ['不足 5 場整包 null(三場的平均是雜訊)', thin === null, ''],
        /* 疊層雷達的級分(2026-08-29 加,同日依使用者建議改成**固定尺**)。
           第一版是近況池跟基準池分開 —— 兩個池各自會動,「6→9」分不出是
           你變了還是別隊變了。現在兩層共用同一把尺:上季全季全部球隊的分布
           (含降級隊)。被射門/被射正/牌反向:雷達慣例是越外越好。 */
        ...(() => {
          const lo = styleTrendFor({ lastRows: mk(38), curRows: mk(2) });                    // sa=10
          const hi = styleTrendFor({ lastRows: mk(38).map(r => ({ ...r, sa: 20 })), curRows: [] }); // 被射門多
          const noBase = styleTrendFor({ lastRows: [], curRows: mk(6) });
          const m = new Map([['LO', lo], ['HI', hi], ['NB', noBase]]);
          /* 尺含一支「已降級」的隊(REL):它不在 m 裡,但在上季 CSV 裡 —— 尺要算它 */
          const ruler = seasonRuler(new Map([
            ['LO', mk(38)], ['HI', mk(38).map(r => ({ ...r, sa: 20 }))], ['REL', mk(38).map(r => ({ ...r, sf: 20 }))],
          ]));
          attachTrendPercentiles(m, { ruler });
          const inRange = t => Object.values(t.recentPct).every(v => v >= 0 && v <= 100);
          return [
            ['疊層級分:每隊都有 recentPct 且 0~100、尺含降級隊', ruler.teams === 3
              && [...m.values()].every(t => t.recentPct && inRange(t)), ''],
            ['防守壓制反向:被射門多的隊 suppress 級分較低', hi.recentPct.suppress < lo.recentPct.suppress,
              `hi=${hi.recentPct.suppress} lo=${lo.recentPct.suppress}`],
            /* 兩層同一把尺:同一個值不管在哪一層,百分位必須一樣 ——
               這就是「箭頭只有一個意思」的那條性質 */
            ['兩層同尺:近況值等於上季值時,兩層百分位相同', lo.recentPct.suppress === lo.baselinePct.suppress
              && lo.recentPct.volume === lo.baselinePct.volume, ''],
            ['沒有上季基準的隊 baselinePct 為 null、尺大小照實記', noBase.baselinePct === null
              && noBase.pctPool.ruler === 3, ''],
            /* xG 三軸(2026-08-29):逐場 xG join 齊才用 XG 組,半套不硬用 */
        ...(() => {
          const mkXg = n => mk(n).map((r, i) => ({ ...r, xg: 1.5, xga: 1.2, date: r.date + '' }));
          const full = styleTrendFor({ lastRows: mkXg(38), curRows: mkXg(2) });
          const holey = styleTrendFor({ lastRows: mkXg(38), curRows: [...mkXg(1), { ...mk(1)[0], xg: null, xga: null }] });
          const m2 = new Map([['XX', full], ['YY', holey]]);
          const ruler2 = seasonRuler(new Map([['XX', mkXg(38)], ['YY', mkXg(38)]]));
          attachTrendPercentiles(m2, { ruler: ruler2 });
          return [
            ['xG 視窗完整 → XG 組(前三軸與主雷達同名)', full.recent.xg === 1.5
              && m2.get('XX').axesMode === 'xg' && m2.get('XX').axes[0].key === 'atk'
              && m2.get('XX').axes[0].label === '進攻火力', ''],
            ['xG 缺一場 → 整組退回實測軸,不用半套平均', holey.recent.xg === null
              && m2.get('YY').axesMode === 'measured' && m2.get('YY').axes.some(a => a.key === 'volume'), ''],
            ['尺記錄 xG 完整視窗數', ruler2.xgWindows === ruler2.windows && ruler2.windows > 0, ''],
          ];
        })(),
        ['產物:英超與西甲的位移雷達用 XG 組、英冠維持實測組', (() => {
          const pl = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'teams.json'), 'utf8'));
          const en = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'en2', 'teams.json'), 'utf8'));
          const plXg = pl.filter(t => t.styleTrend?.axesMode === 'xg').length;
          const enOk = en.filter(t => t.styleTrend).every(t => t.styleTrend.axesMode === 'measured');
          return plXg >= 15 && enOk;
        })()],
        ['逐場 xG 快取:每隊逐場比分已對回本站賽果(rejected 空)', (() => {
          const st = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'understat', 'team-dates.json'), 'utf8'));
          const last = st.seasons['2025-26'];
          return Object.keys(last).length >= 20 && Object.values(last).every(t => t.verified)
            && (st.rejected ?? []).length === 0;
        })()],
        ['沒有上季 CSV(尺是空的)就不給級分,前端只畫表', (() => {
              const solo = new Map([['X', styleTrendFor({ lastRows: [], curRows: mk(6) })]]);
              attachTrendPercentiles(solo, { ruler: seasonRuler(new Map()) });
              return solo.get('X').recentPct === undefined;
            })(), ''],
          ];
        })(),
      ];
    })(),
    ['產物:多數球隊有位移資料、每隊有雷達覆蓋標註', (() => {
      const teams = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'teams.json'), 'utf8'));
      const withTrend = teams.filter(t => t.styleTrend).length;
      const withCov = teams.filter(t => t.radarCoverage).length;
      return withTrend >= 15 && withCov >= 18;
    })()],
    ['位移卡與雷達標註都講了「不進模型」與換帥警語', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
      return /不影響模型勝率/.test(src) && /它描述的是前任的打法/.test(src);
    })()],
    /* 位移雷達不准疊在主雷達上:主雷達那六軸是 xG 系,近 10 場沒有逐場 xG 來源。
       位移卡自己畫、自己一組軸(逐場可測的欄位),core.radar 用 dash 分層。 */
    ['位移卡有疊層雷達:上季實線、近況虛線、反向軸有說明', (() => {
      const pg = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
      const core = readFileSync(join(ROOT, 'web', 'assets', 'js', 'core.js'), 'utf8');
      return /st\.recentPct/.test(pg) && /dash: '6 5'/.test(pg) && /反向/.test(pg)
        && /stroke-dasharray/.test(core);
    })()],
    /* 使用者要求:百分位改 10 級分呈現。級分只是顯示層(每 10 分一級,10 最高),
       底層還是百分位 —— 隊數與說明都要跟著資料,不寫死 20。 */
    /* 位移標籤與軸序(2026-08-29,使用者要求跟主雷達對得起來):
       攻擊軸在上、防守在右下與下;標籤只給級分動 ≥2 的軸,±1 是雜訊不追。 */
    ['位移雷達:軸組由資料決定(st.axes)、XG 組照主雷達位置重排、位移標籤 ≥2 級', (() => {
      const pg = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
      return /st\.axes \?\?/.test(pg) && /'atk', 'fin', 'defx'/.test(pg)
        && /Math\.abs\(x\.d\) >= 2/.test(pg) && /打法沒有明顯位移/.test(pg)
        && /同名同義/.test(pg);
    })()],
    ['雷達軸標 10 級分:兩張雷達都開、說明講了級分、隊數不寫死', (() => {
      const pg = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
      const core = readFileSync(join(ROOT, 'web', 'assets', 'js', 'core.js'), 'utf8');
      const calls = pg.match(/C\.radar\([^;]*?levels: true/gs) ?? [];
      return calls.length >= 2 && /levelOf/.test(core)
        && /Math\.min\(10, Math\.floor\(\(v \?\? 0\) \/ 10\) \+ 1\)/.test(core)
        && /\$\{teams\.length\} 隊/.test(pg) && !/20 隊中的百分位/.test(pg);
    })()],
    ['產物:西甲球隊也有位移資料(SP1 逐場統計)', (() => {
      const teams = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'es1', 'teams.json'), 'utf8'));
      const withTrend = teams.filter(t => t.styleTrend);
      return withTrend.length >= 15 && withTrend.every(t => t.styleTrend.recentPct);
    })()],
    /* 使用者回饋:點對戰要直接進分析,不要先開抽屜再點一次。
       抽屜只留給沒有分析頁的場次(往季賽果)。 */
    ['賽程表點列直達分析頁,沒有分析的才開抽屜', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'fixture-list.js'), 'utf8');
      return /f\.season === meta\.currentSeason && f\.played\) \|\| hasFullAnalysis\(f\)/.test(src)
        && /location\.href = C\.link\('analysis', \{ id: f\.id \}\)/.test(src);
    })()],
    /* 總覽的「即將到來」(2026-08-29,使用者要求):全部聯賽 + 盃賽合在一張表。
       天數窗不用固定筆數(固定筆數會把一輪切一半);盃賽只列本站名冊球隊的場次
       (足總盃資格賽一輪幾百場低級別比賽);占位的 00:00Z 標時間待定。 */
    ['總覽有「即將到來」:7 天窗、盃賽過濾低級別、占位時間標待定、倒數會走', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-overview.js'), 'utf8');
      return /即將到來/.test(src) && /7 \* 86400000/.test(src)
        && /covered\(m\.home\) && !covered\(m\.away\)/.test(src)
        && /T00:00:00Z/.test(src) && /時間待定/.test(src)
        && /startCountdowns/.test(src);
    })()],
    /* 隊徽 + 整列可點(使用者要求)。隊徽一定要從各聯賽自己的名冊拿 ——
       隊碼跨聯賽重複(BUR),全域登錄是後蓋前;盃賽的走 cups.json 的 crests 查表。 */
    ['總覽即將到來:隊徽從各聯賽名冊與盃賽查表拿、整列點擊進分析', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-overview.js'), 'utf8');
      return /hCrest: h\?\.crest/.test(src) && /cupCrests\[m\.home\?\.sourceId\]/.test(src)
        && /onRow: u => \{ if \(u\.link\) location\.href = u\.link; \}/.test(src);
    })()],
    /* 使用者指定:總覽的即將賽程不列英冠(盃賽裡英冠球隊的場次照列)。
       用集合宣告,hint 文案跟著同一個集合走,不會表拿掉了標題還寫著英冠。 */
    ['總覽即將賽程排除英冠,hint 文案跟著同一個集合', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-overview.js'), 'utf8');
      return /UPCOMING_HIDE = new Set\(\['en2'\]\)/.test(src)
        && /if \(UPCOMING_HIDE\.has\(lg\)\) continue;/.test(src)
        && /leagues\.filter\(x => !UPCOMING_HIDE\.has\(x\.lg\)\)/.test(src);
    })()],

    /* ── 教練職涯史核對器(B 層,2026-08-29)── */
    ...await (async () => {
      const { verifyCareers } = await import('./verify-coach-careers.mjs');
      const { createHash } = await import('node:crypto');
      const ctx = {
        rosters: { pl: new Map([['CHE', { name: 'Calum McFarlane', since: null }],
          ['AVL', { name: 'Unai Emery', since: '2022-10-24' }]]),
          es1: new Map([['RMA', { name: 'José Mário Dos Santos Mourinho Félix', since: null }]]),
          en2: new Map([['LIN', { name: 'Chris Cohen & Tom Shaw', since: '2026-05-29' }]]) },
        teamCodes: { pl: new Map(), es1: new Map(), en2: new Map() },
        seasons: { pl: [], es1: [], en2: [] }, membership: { pl: new Map(), es1: new Map(), en2: new Map() },
      };
      ctx.allClubNames = ['derby county', 'aston villa'];
      /* 成員資格的小宇宙:pl 只有 2026-27 一季,而 WOL 不在裡面 —— 用來測開放式任期 */
      ctx.teamCodes.pl = new Map([['wolverhampton wanderers', 'WOL']]);
      ctx.seasons.pl = ['2024-25', '2026-27'];
      ctx.membership.pl = new Map([['2024-25', new Set(['WOL'])], ['2026-27', new Set(['AVL'])]]);
      const run = coaches => verifyCareers({ coaches }, ctx);
      const wrong = run([{ league: 'pl', team: 'CHE', name: 'Xabi Alonso', current: {}, previous: [] }]);
      /* 西班牙雙姓:最後一個 token 不是姓氏的全部。第一版拿它當姓,冤枉了四筆 —— 對錯人比對不到糟。 */
      const variant = run([{ league: 'es1', team: 'RMA', name: 'José Mourinho', current: {}, previous: [] }]);
      const duo = run([{ league: 'en2', team: 'LIN', name: 'Tom Shaw', current: {}, previous: [] }]);
      const selfContra = run([{ league: 'pl', team: 'AVL', name: 'Unai Emery', firstHeadCoachJob: true,
        current: { club: 'Aston Villa' }, previous: [], note: 'Derby County 官方公告寫明那是他的第一份管理工作' }]);
      /* 「官方稱這是他的第一份工作」講的是現職、沒點名別隊 —— 不能定罪(冤枉過 Arteta) */
      const firstOk = run([{ league: 'pl', team: 'AVL', name: 'Unai Emery', firstHeadCoachJob: true,
        current: { club: 'Aston Villa' }, previous: [], note: '官方任命報導明確稱這是他的第一份管理工作' }]);
      const dayVsMonth = run([{ league: 'en2', team: 'LIN', name: 'Chris Cohen',
        current: { club: 'Lincoln City', from: '2026-05-29' }, previous: [] }]);
      /* 開放式任期(to null):只核對起始賽季。拿未來賽季的成員資格去否定會冤枉真紀錄 */
      const openEnd = run([{ league: 'pl', team: 'AVL', name: 'Unai Emery', current: { club: 'Aston Villa' },
        previous: [{ club: 'Wolverhampton Wanderers', competition: 'Premier League', from: '2024-12-19', to: null }] }]);
      return [
        ['職涯核對:與官方名冊不同人 → 定罪', wrong.pl.verdict === 'rejected'
          && wrong.pl.convictions.some(c => c.includes('不是同一人')), ''],
        ['職涯核對:西班牙雙姓變體不冤枉(Mourinho ≠ Félix 姓)', variant.es1.convictions.length === 0
          && variant.es1.labelIssues.length === 1, JSON.stringify(variant.es1.convictions)],
        ['職涯核對:雙教頭「甲 & 乙」拆開對,單人名字配得上', duo.en2.convictions.length === 0, ''],
        ['職涯核對:宣稱第一份工作、note 點名別隊 → 自我矛盾定罪', selfContra.pl.verdict === 'rejected', ''],
        ['職涯核對:「第一份」指的是現職、沒點名別隊 → 不定罪(冤枉過 Arteta)',
          firstOk.pl.convictions.length === 0, JSON.stringify(firstOk.pl.convictions)],
        ['職涯核對:本站 since 是日精度時 ±14 天容忍', dayVsMonth.en2.convictions.length === 0, ''],
        ['職涯核對:離任日 null 只核對起始賽季,不拿未來賽季冤枉(Pereira 的 Wolves)',
          openEnd.pl.convictions.length === 0 && openEnd.pl.notes.some(n => n.includes('只核對了起始賽季')),
          JSON.stringify(openEnd.pl.convictions)],
        /* 聯賽標錯的跨聯賽偵測:任期落在持有賽季、球隊卻不在宣稱聯賽的登錄表、
           反而在另一個聯賽找得到 → 定罪(Mowbray 的 WBA 標成英超,實際在英冠)。
           任期在持有賽季之外的同樣情況只記無法核對,不冤枉。 */
        ...(() => {
          ctx.teamCodes.en2.set('west bromwich albion', 'WBA');
          const mk = (from, to) => run([{ league: 'en2', team: 'LIN', name: 'Chris Cohen', current: { club: 'Lincoln City' },
            previous: [{ club: 'West Bromwich Albion', competition: 'Premier League', from, to }] }]);
          const inHeld = mk('2025-01-17', '2025-04-21');   // pl 持有 2024-25
          const outside = mk('2018-01-01', '2018-04-01');  // 持有賽季之外
          return [
            ['職涯核對:聯賽標錯(持有賽季內、隊在別的聯賽)→ 定罪',
              inHeld.en2.verdict === 'rejected' && inHeld.en2.convictions.some(c => c.includes('從未出現在該聯賽')),
              JSON.stringify(inHeld.en2.convictions)],
            ['職涯核對:同樣情況但任期在持有賽季外 → 只記無法核對', outside.en2.convictions.length === 0
              && outside.en2.notes.some(n => n.includes('無法核對')), ''],
          ];
        })(),
        ['職涯核對:收件匣在的話,核對產物要在而且 sha 對得上', (() => {
          const inboxPath = join(ROOT, 'data', 'manual', 'coach-careers.json');
          if (!existsSync(inboxPath)) return true;
          const vPath = join(ROOT, 'data', 'coach-careers-verified.json');
          if (!existsSync(vPath)) return false;
          const v = JSON.parse(readFileSync(vPath, 'utf8'));
          return v.inboxSha256 === createHash('sha256').update(readFileSync(inboxPath, 'utf8')).digest('hex');
        })()],
        /* 產物:核對通過的職涯要真的掛上教練卡。風格是本站從季檔算的 ——
           場均值要附同期聯賽平均與場次;沒有逐場來源的聯賽只列任期事實。
           斷言綁「形狀」不綁人名,重交付換人也不會歪。 */
        ['產物:通過的前任期掛上各聯賽 coaches.json,含風格或缺席原因', (() => {
          const vPath = join(ROOT, 'data', 'coach-careers-verified.json');
          if (!existsSync(vPath)) return true;
          const v = JSON.parse(readFileSync(vPath, 'utf8'));
          const okOne = c =>
            (c.career.style && c.career.style.games >= 5 && c.career.style.perGame.sf > 0
              && c.career.style.leagueAvg.sf > 0)
            || (!c.career.style && typeof c.career.styleUnavailable === 'string' && c.career.styleUnavailable.length > 0);
          const files = { pl: 'web/data/coaches.json', es1: 'web/data/leagues/es1/coaches.json', en2: 'web/data/leagues/en2/coaches.json' };
          for (const [lg, f] of Object.entries(files)) {
            const pub = (v.published ?? []).filter(r => r.league === lg);
            const data = JSON.parse(readFileSync(join(ROOT, ...f.split('/')), 'utf8'));
            const withCareer = (data.coaches ?? data).filter(c => c.career);
            if (withCareer.length !== pub.length || !withCareer.every(okOne)) return false;
          }
          return true;
        })()],
        /* 外國聯賽的任期風格(2026-08-29 靜態季檔回填):人工對照表 + 三道守門 */
        ...await (async () => {
          const { tenureStyle } = await import('./lib/coach-career.mjs');
          const ok = tenureStyle(ROOT, { club: 'RB Leipzig', competition: 'Bundesliga', country: 'Germany',
            from: '2022-09-08', to: '2025-03-30' });
          const wrongCountry = tenureStyle(ROOT, { club: 'X', competition: 'Serie A', country: 'Brazil',
            from: '2022-01-01', to: '2023-01-01' });
          const noAlias = tenureStyle(ROOT, { club: 'Foo FC', competition: 'Bundesliga', country: 'Germany',
            from: '2022-01-01', to: '2023-01-01' });
          return [
            ['外國任期:萊比錫 90 場德甲、附同期聯賽平均', ok.style?.games === 90
              && ok.style.leagueZh === '德甲' && ok.style.leagueAvg.sf > 0, JSON.stringify(ok.reason ?? '')],
            ['外國任期:同名聯賽 country 對不上 → 拒算(義甲 ≠ 巴甲)',
              !wrongCountry.style && /不同名同姓|拒算/.test(wrongCountry.reason), wrongCountry.reason ?? ''],
            ['外國任期:沒有人工對照 → 照實說,不模糊比對',
              !noAlias.style && /人工對照/.test(noAlias.reason), noAlias.reason ?? ''],
            /* 拼字錯/層級錯要跟涵蓋不足分開講:Ramis 的 Espanyol 被交付標成西甲,
               實際當季在西乙 —— 新守門讓它現形,而不是偽裝成資料缺口 */
            ['外國任期:隊不在季檔 → 講「找不到」不講「涵蓋不足」', (() => {
              const r = tenureStyle(ROOT, { club: 'RCD Espanyol', competition: 'La Liga', country: 'Spain',
                from: '2023-11-01', to: '2024-03-01' });
              return !r.style && /找不到/.test(r.reason);
            })(), ''],
          ];
        })(),
        ['前端:教練卡有前任期區塊,講了「球隊表現 ≠ 教練個人風格」與跨聯賽不可比', (() => {
          const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
          return /careerBlock/.test(src) && /球隊表現 ≠ 教練個人風格/.test(src)
            && /不可直接互比/.test(src) && /只列核對過的任期事實/.test(src);
        })()],
      ];
    })(),

    /* ── 球員核心契約(跨聯賽統一層,2026-08-29)──
       聯集 + null(沒有資料 ≠ 0)、不帶照片、兩邊鍵集合逐鍵相同。 */
    ['球員核心:兩聯賽鍵集合相同、賽季列鍵相同', (() => {
      const pl = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'players-core.json'), 'utf8'));
      const es = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'es1', 'players-core.json'), 'utf8'));
      const k = r => JSON.stringify(Object.keys(r).sort());
      const sk = r => JSON.stringify(Object.keys(r.seasons.find(Boolean) ?? {}).sort());
      const plS = pl.find(r => r.seasons.length), esS = es.find(r => r.seasons.length);
      return pl.length > 400 && es.length > 400 && k(pl[0]) === k(es[0]) && sk(plS) === sk(esS);
    })()],
    ['球員核心:null 政策(西甲身價/狀態全 null、英超逐場射門 null、無照片)', (() => {
      const pl = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'players-core.json'), 'utf8'));
      const es = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'es1', 'players-core.json'), 'utf8'));
      return es.every(r => r.price === null && r.status === null)
        && pl.every(r => r.seasons.every(s => s.shots === null && s.keyPasses === null))
        && pl.every(r => !('photo' in r)) && es.every(r => !('photo' in r));
    })()],
    /* 核心層的數字要對得回富資料 —— 統一層不是另一份事實,是同一份的映射 */
    ['球員核心:進球總和對得回各聯賽的 players.json', (() => {
      const plFull = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'players.json'), 'utf8'));
      const pl = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'players-core.json'), 'utf8'));
      const meta = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'meta.json'), 'utf8'));
      const coreCur = pl.reduce((n, r) => n + (r.seasons.find(s => s.season === meta.currentSeason)?.goals ?? 0), 0);
      const fullCur = plFull.reduce((n, p) => n + ((p.current?.minutes > 0 ? p.current.goals : 0) ?? 0), 0);
      const esFull = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'es1', 'players.json'), 'utf8'));
      const es = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'es1', 'players-core.json'), 'utf8'));
      const esCore = es.reduce((n, r) => n + r.seasons.reduce((m, s) => m + (s.goals ?? 0), 0), 0);
      const esFullSum = esFull.reduce((n, p) => n + (p.minutes > 0 ? (p.goals ?? 0) : 0), 0);
      return coreCur === fullCur && esCore === esFullSum;
    })()],
    /* ── 跨聯賽球員搜尋頁(2026-08-29,使用者要求:掛盃賽右邊,各聯賽自己的照舊)── */
    ['總球員頁:只在 SITE_PAGES、聯賽從註冊表來、不混排、空欄不畫', (() => {
      const core = readFileSync(join(ROOT, 'web', 'assets', 'js', 'core.js'), 'utf8');
      const pg = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-allplayers.js'), 'utf8');
      const bundle = readFileSync(join(ROOT, 'scripts', 'bundle.mjs'), 'utf8');
      const sitePagesBlock = core.slice(core.indexOf('const SITE_PAGES'), core.indexOf('const PAGES'));
      return (core.match(/'allplayers'/g) ?? []).length >= 3          // SITE_PAGES + es1/en2 open
        && sitePagesBlock.includes("'allplayers'")
        && !core.slice(core.indexOf('const PAGES')).split('const GROUPS')[0].includes("'allplayers'")  // PAGES 沒有(兩個分頁那條坑)
        && /'allplayers'/.test(bundle)                                 // 單檔版清單(靜靜消失那條坑)
        && /Object\.keys\(C\.LEAGUES\)/.test(pg)                       // 註冊表,不寫死聯賽
        && /不可直接互比/.test(pg)                                     // xG/xA 模型不同的警語
        && /聯賽籤/.test(pg)                                           // 合併表:每列標出處
        && /photoBy/.test(pg) && /crestBy/.test(pg)                    // 頭貼懶載入、隊徽分聯賽表(隊碼會撞)
        && /gapNote/.test(pg)                                          // 英冠缺席講原因
        && /!= null/.test(pg) && /'—'/.test(pg);                       // null 不畫成 0
    })()],
    ['跨聯賽搜尋:懶載入、不合併同人、跨池警語、兩個渲染器共用一份', (() => {
      const core = readFileSync(join(ROOT, 'web', 'assets', 'js', 'core.js'), 'utf8');
      const pg = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-players.js'), 'utf8');
      return /crossLeaguePlayers/.test(core) && /_playersCoreCache/.test(core)
        && (pg.match(/updateXLeague\(/g) ?? []).length >= 3
        && /同名不代表同一人/.test(pg) && /不可直接互比/.test(pg)
        && (pg.match(/id="xleague"/g) ?? []).length === 2;
    })()],

    /* ── 中場/戰況講評(2026-08-29,使用者要求)──
       規則生成、每句只引用算好的數字;FPL 分鐘在中場停 45 → 43~50 標中場。 */
    ...await (async () => {
      const { buildMatchReport } = await import('./lib/matchreport.mjs');
      const mkFix = minute => ({
        key: 'AAA|BBB', home: 'AAA', away: 'BBB', kickoff: '2026-08-29T11:30:00Z',
        started: true, finished: false, minutes: minute, hs: 0, as: 1,
        lineups: { AAA: [], BBB: [] },
      });
      const args = { prediction: { home: 0.5, draw: 0.25, away: 0.25, xgHome: 1.8, xgAway: 1.0 },
        tactics: new Map(), zh: c => c };
      const ht = buildMatchReport({ fixture: mkFix(45), ...args });
      const mid = buildMatchReport({ fixture: mkFix(30), ...args });
      const done = buildMatchReport({ fixture: { ...mkFix(90), finished: true }, ...args });
      /* 富數據夾具:場上數據句(威脅/防守負荷/撲救/BPS)要從 FPL 合計長出來 */
      const mkP = (name, pos, o = {}) => ({ name, pos, code: name, starts: 1, minutes: 60,
        xG: 0, xA: 0, goals: 0, assists: 0, yellow: 0, red: 0, saves: 0, conceded: 0, xGC: 0,
        bps: 0, threat: 0, creativity: 0, influence: 0, tackles: 0, recoveries: 0, cbi: 0, ...o });
      const rich = buildMatchReport({ fixture: { ...mkFix(60), lineups: {
        AAA: [mkP('GkA', 'GK', { saves: 4, influence: 20 }),
          mkP('DefA', 'DEF', { tackles: 8, recoveries: 12, cbi: 10, influence: 15, yellow: 1 })],
        BBB: [mkP('GkB', 'GK', { influence: 5 }),
          mkP('AtkB', 'FWD', { threat: 55, creativity: 30, influence: 40, bps: 31, yellow: 1 }),
          mkP('MidB', 'MID', { threat: 10, influence: 10, yellow: 1 })],
      } }, ...args, official: { clock: "70'00" } });
      return [
        ['講評:43~50 分標中場、其餘標戰況、完場不給', ht.liveSummary?.kind === 'ht'
          && mid.liveSummary?.kind === 'live' && done.liveSummary == null, ''],
        ['講評:句子引用比分/勝率位移/下一球(全是算好的數字)', (() => {
          const t = ht.liveSummary.paragraphs.join('');
          return /上半場結束/.test(t) && /0:1/.test(t) && /百分點/.test(t) && /下一球/.test(t);
        })(), ''],
        ['講評:場上數據句(威脅/防守負荷/撲救/牌/BPS)從 FPL 合計長出來', (() => {
          const t = rich.liveSummary.paragraphs.join('');
          return /進攻威脅值 0:65/.test(t) && t.includes('AtkB(55)')
            && /搶斷\+回收\+解圍 30 對 0/.test(t) && /GkA 4 次/.test(t)
            && /3 張黃牌/.test(t) && t.includes('AtkB(BBB,31 分)');
        })(), ''],
        ['講評:指數還是 0 的比賽不長場上數據句(0:0 是雜訊不是資訊)', (() => {
          const t = ht.liveSummary.paragraphs.join('');
          return !/威脅值/.test(t) && !/防守端/.test(t) && !/BPS/.test(t);
        })(), ''],
        ['講評:官方比賽鐘進 feed(FPL 分鐘塊狀跳,顯示要靠它當錨)', rich.clock === "70'00" && ht.clock == null, ''],
        ['講評:sides.stats 是全隊加總且欄位齊(前端場上數據表吃這份)', (() => {
          const s = rich.sides.AAA.stats, b = rich.sides.BBB.stats;
          return s.tackles === 8 && s.recoveries === 12 && s.cbi === 10 && s.influence === 35
            && b.threat === 65 && b.topThreat?.name === 'AtkB' && s.topThreat === null;
        })(), ''],
        ['講評:前端掛在實時抽屜、標自動生成', (() => {
          const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-live.js'), 'utf8');
          return /liveSummary/.test(src) && /中場講評/.test(src) && /自動生成/.test(src);
        })()],
        ['比賽日迴圈:rebase 失敗要 abort、推不出去要重置(卡死那課)', (() => {
          const wf = readFileSync(join(ROOT, '..', '.github', 'workflows', 'epl-matchday.yml'), 'utf8');
          return /git rebase --abort/.test(wf) && /reset --hard -q "origin/.test(wf);
        })()],
      ];
    })(),

    /* ── 租借往來卡(2026-08-29 深夜)──
       跨聯賽單一份掛英超目錄、等級走到畫面上、核對器內部輸出不外洩。 */
    ['租借往來:單一份資料、等級分開標、evidence 不進前端', (() => {
      const loans = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'loans.json'), 'utf8'));
      const pg = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-teams.js'), 'utf8');
      return loans.records.length > 500
        && loans.records.every(r => !('evidence' in r) && ['confirmed', 'consistent'].includes(r.verdict))
        && !existsSync(join(ROOT, 'web', 'data', 'leagues', 'es1', 'loans.json'))   // 跨聯賽只有一份
        && /loadFrom\('pl', \['loans'\]\)/.test(pg)
        && /已確認/.test(pg) && /無矛盾/.test(pg) && /兩者可信度不同/.test(pg)
        && /if \(!recs\.length\) return ''/.test(pg);   // 沒紀錄不留空卡
    })()],

    /* ── 即時機率的校準量測(2026-08-29,只量不改模型)──
       Brier 對照「賽前凍結」、0 分錨點與 90+ 收斂點不計、落後方專表、
       樣本不足要明講。數學用合成資料驗到小數。 */
    ...await (async () => {
      const { inplayCalibration } = await import('./lib/inplay-calibration.mjs');
      const store = { season: '2026-27', matches: {
        'AAA|BBB': { done: true, pts: [
          [0, 0.5, 0.3, 0.2, 0, 0],      // 賽前錨點:不計
          [10, 0.6, 0.25, 0.15, 1, 0],   // 主隊領先
          [80, 0.9, 0.08, 0.02, 1, 0],
          [90, 1, 0, 0, 1, 0],           // 收斂點:不計(抄答案)
        ] },
        'CCC|DDD': { done: false, pts: [[0, 0.4, 0.3, 0.3, 0, 0], [10, 0.4, 0.3, 0.3, 0, 0], [20, 0.4, 0.3, 0.3, 0, 0]] },
      } };
      const r = inplayCalibration(store);
      const near = (x, y) => Math.abs(x - y) < 1e-9;
      return [
        ['校準:未完賽不計、0 分錨點與 90 收斂點不計', r.matches === 1 && r.points === 2, ''],
        ['校準:Brier 算得對(0.6/0.25/0.15 對主勝 → 0.245;凍結 0.38)', (() => {
          const c = r.cells.find(x => x.band === '1-15' && x.state === 'lead');
          return c && near(c.brier, 0.245) && near(c.brierPre, 0.38) && c.matches === 1;
        })(), ''],
        ['校準:落後方表(模型給 0.15、實際 0 翻盤)', (() => {
          const t = r.trailing.find(x => x.band === '1-15');
          return t && near(t.avgProb, 0.15) && t.comebackRate === 0 && t.n === 1;
        })(), ''],
        ['校準:樣本不足要明講(verdict=insufficient、門檻 30 場)',
          r.verdict === 'insufficient' && r.minMatches === 30, ''],
        ['校準:build 產出資料集、模型頁有量測節與不足警語', (() => {
          const pm = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-model.js'), 'utf8');
          const b = readFileSync(join(ROOT, 'scripts', 'build.mjs'), 'utf8');
          return /樣本還不夠下結論/.test(pm) && /凍結不動/.test(pm) && /只量不改模型/.test(pm)
            && /inplay-calibration/.test(b)
            && existsSync(join(ROOT, 'web', 'data', 'inplay-calibration.json'));
        })(), ''],
      ];
    })(),

    ['對戰模擬:只在 PAGES/分析組、誠實界線寫在畫面上、種子可重播', (() => {
      const core = readFileSync(join(ROOT, 'web', 'assets', 'js', 'core.js'), 'utf8');
      const pg = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-duel.js'), 'utf8');
      const pc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'predict-core.js'), 'utf8');
      /* 2026-08-30 搬進跨聯賽組(使用者要求放盃賽旁邊):SITE_PAGES 有、
         PAGES 與分析組**不能有** —— 兩邊都放會出現兩個分頁 */
      const sitePagesBlock = core.slice(core.indexOf('const SITE_PAGES'), core.indexOf('const GROUPS'));
      const pagesBlock = core.slice(core.indexOf('const GROUPS'));
      return sitePagesBlock.includes("['duel', '對戰模擬']")
        && sitePagesBlock.indexOf("'cups'") < sitePagesBlock.indexOf("'duel'")   // 盃賽旁邊
        && !pagesBlock.includes("'duel'")
        && /跨聯賽/.test(pg) && /crestBy/.test(pg)                  // 頁內選聯賽、隊徽分聯賽表
        /* 生圖素材(2026-08-30):六張都在、各壓在 300KB 內、
           img 全掛 onerror 隱藏 —— 單檔版沒有圖檔,要優雅降級不是破圖 */
        && ['hero', 'pitch', 'goal', 'halftime', 'fulltime', 'dice'].every(n => {
          const f = join(ROOT, 'web', 'assets', 'img', `duel-${n}.webp`);
          return existsSync(f) && statSync(f).size < 300 * 1024;
        })
        && (pg.match(/assets\/img\/duel-/g) ?? []).length >= 5
        /* onerror 可以是字面、也可以是 \${HIDE} 樣板變數(骨架版用後者) */
        && !/img src="assets\/img\/duel-[^"]*"(?![^>]*(?:onerror|\$\{HIDE\}))/.test(pg)
        /* 2D 跑位動畫(2026-08-30):FM 式演出。界線要打在畫面上,
           陣型走官方逐場資料、名單走 players-core、動畫用種子衍生的 rng(可重播) */
        && (() => {
          const an = readFileSync(join(ROOT, 'web', 'assets', 'js', 'duel-anim.js'), 'utf8');
          const bundle = readFileSync(join(ROOT, 'scripts', 'bundle.mjs'), 'utf8');
          return /mountDuelAnim/.test(pg) && /跑位動畫是程序化演出/.test(pg)
            && /formationOf/.test(pg) && /pickXI/.test(pg)
            && /程序化演出/.test(an) && /parseFormation/.test(an)
            && /'duel-anim'/.test(bundle)                       // 單檔版 SHARED 清單
            /* 精緻化(2026-08-30):下半場換邊、失球方中圈開球、canvas 記分板、防守收縮 */
            && /dirOf/.test(an) && /pendingKickoff/.test(an)
            && /記分板/.test(an) && /squeeze/.test(an)
            && /seededRng\(state\.seed \^/.test(pg);            // 動畫自己的種子流,同種子同劇本
        })()
        && /不是預測的斷言/.test(pg) && /做了就是編數字/.test(pg)
        && /跨聯賽對戰也不提供/.test(pg) && /分鐘分布未建模/.test(pg)
        && /seededRng/.test(pc) && /mulberry32/.test(pc)            // 種子亂數,同種子重播同一場
        /* 播放模式:in-play 引擎共用、計時器走 pageInterval(裸 setInterval 是老坑) */
        && /inPlaySim/.test(pg) && /跳到結果/.test(pg)
        && /C\.pageInterval/.test(pg) && !pg.includes(' setInterval(');
    })()],

    /* ── 對戰模擬:前端預測核心的 golden(2026-08-30)──
       predict-core.js 是 lib/poisson + lib/elo 的瀏覽器移植;
       這裡拿三個聯賽**每一場未賽**的 fixtures.json 預測逐場重算比對,
       任何一邊漂移(改了 lib 沒改移植、或反過來)都會紅。 */
    ...await (async () => {
      const { blendPair } = await import('../web/assets/js/predict-core.js');
      const out = [];
      for (const [lg, dir] of [['pl', 'web/data'], ['es1', 'web/data/leagues/es1'], ['en2', 'web/data/leagues/en2']]) {
        const meta = JSON.parse(readFileSync(join(ROOT, dir, 'meta.json'), 'utf8'));
        const teams = JSON.parse(readFileSync(join(ROOT, dir, 'teams.json'), 'utf8'));
        const fixtures = JSON.parse(readFileSync(join(ROOT, dir, 'fixtures.json'), 'utf8'));
        const eloBy = new Map(teams.map(t => [t.code, t.elo]));
        const sim = meta.model.sim;
        let n = 0, bad = 0, badKey = '';
        for (const f of fixtures) {
          if (f.played || !f.prediction) continue;
          const p = blendPair(sim, f.home, f.away, eloBy.get(f.home), eloBy.get(f.away));
          if (!p) continue;
          n++;
          const s = f.prediction;
          const same = p.home === s.home && p.draw === s.draw && p.away === s.away
            && p.xgHome === s.xgHome && p.xgAway === s.xgAway
            && (!s.topScores || (p.topScores[0].s === s.topScores[0].s && p.topScores[0].p === s.topScores[0].p))
            && (!s.elo || p.elo.home === s.elo.home);
          if (!same) { bad++; if (!badKey) badKey = `${f.home}|${f.away}`; }
        }
        out.push([`模擬 golden:${lg} 前端重算 ${n} 場未賽預測全部一致`,
          n > 50 && bad === 0, bad ? `${bad} 場不一致(首例 ${badKey})` : `只有 ${n} 場`]);
      }
      /* 播放模式的 in-play 引擎:inPlaySim 對 lib/inplay.mjs 的 inPlay,
         120 個情境(λ×比分×分鐘×紅牌×完場)逐鍵完全一致 */
      const { inPlay } = await import('./lib/inplay.mjs');
      const { inPlaySim } = await import('../web/assets/js/predict-core.js');
      let ipBad = 0;
      for (const lambdaHome of [0.8, 1.42, 2.68]) for (const lambdaAway of [0.7, 1.65])
        for (const [hs, as] of [[0, 0], [1, 0], [1, 2], [3, 3]])
          for (const minute of [0, 30, 45, 77, 90])
            for (const args of [{}, { redHome: 1 }, { finished: true }]) {
              const a = inPlay({ lambdaHome, lambdaAway, hs, as, minute, ...args });
              const b = inPlaySim({ lambdaHome, lambdaAway, hs, as, minute, ...args });
              if (JSON.stringify(a) !== JSON.stringify(b)) ipBad++;
            }
      out.push(['模擬 golden:播放模式的 in-play 引擎與實時頁逐鍵一致(360 情境)', ipBad === 0, `${ipBad} 個情境不一致`]);
      return out;
    })(),

    /* ── 單場即時中樞(2026-08-29,使用者要求:每場自己一頁)──
       分析頁比賽中就是即時頁(面板+講評+輪詢),完場自動消失由賽後接手;
       實時頁的進行中卡瘦身、直達單場頁 —— 單場的家始終只有分析頁一個。 */
    ['單場即時:分析頁有即時面板與輪詢、實時頁卡片直達', (() => {
      const pa = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-analysis.js'), 'utf8');
      const pl = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-live.js'), 'utf8');
      return /id="livePanel"/.test(pa) && /livePanelHtml/.test(pa) && /liveSummary/.test(pa)
        && /m\.started && !m\.finished/.test(pa) && /20000/.test(pa)
        && /場上數據/.test(pa) && /沒有免費的即時來源/.test(pa)
        && /act\(sh\) \+ act\(sa\) > 0/.test(pa)
        /* 走鐘:分鐘顯示以 feed 抓取時刻為錨往前推,每秒更新、不跨 45/90 界線。
           共用一份在 core(各寫一份的話修了分析頁、實時頁照舊凍住 —— 實際發生),
           錨取官方鐘與 FPL 分鐘的較大者(剛開賽的官方鐘快取停在 00'00 → 變 0 那次),
           feed 只進不退(CDN 新舊副本交替 → 倒數那次),兩頁各自有守門。 */
        && (() => {
          const core = readFileSync(join(ROOT, 'web', 'assets', 'js', 'core.js'), 'utf8');
          return /export function liveMinute/.test(core)
            && /'45\+'/.test(core) && /'90\+'/.test(core) && /offEff >= fpl/.test(core)
            /* 賽前舊快照不算死時間:錨取快照與開球較晚者(TOT|NEW 超前真實時間那次) */
            && /Math\.max\(fetchT, ko\)/.test(core)
            && !/function liveMinute/.test(pa) && !/function liveMinute/.test(pl)   // 不准各自再寫一份
            && /C\.liveMinute\(/.test(pa) && /C\.liveMinute\(/.test(pl)
            && /data-liveclock/.test(pa) && /data-liveclock/.test(pl)
            && /}, 1000\)/.test(pa) && /}, 1000\)/.test(pl)
            && /Date\.parse\(fetchedAt\) < Date\.parse\(cur\.fetchedAt\)/.test(pa)
            && /Date\.parse\(stamp\) < Date\.parse\(lastStamp\)/.test(pl);
        })()
        && /點開看講評、勝率曲線與場上資訊/.test(pl)
        && pl.includes(`href="\${C.link('analysis', { id: m.fixtureId })}"`);
    })()],

    /* ── 延賽/改期偵測(探勘缺口 G,2026-08-29)──
       狀態轉入延期集合、utcDate 變更、延期後回排定 = 改期,三種事件;
       快照 diff 以 fdId 對齊(主客組合在有附加賽的聯賽不唯一,老坑)。 */
    ...await (async () => {
      const { diffSnapshots, attachScheduleStatus, normalizeMatches } = await import('./lib/schedule-status.mjs');
      const prev = [
        { fdId: 1, home: 'AAA', away: 'BBB', utcDate: '2026-09-01T14:00:00Z', status: 'TIMED' },
        { fdId: 2, home: 'CCC', away: 'DDD', utcDate: '2026-09-02T14:00:00Z', status: 'POSTPONED' },
        { fdId: 3, home: 'EEE', away: 'FFF', utcDate: '2026-09-03T14:00:00Z', status: 'TIMED' },
      ];
      const next = [
        { fdId: 1, home: 'AAA', away: 'BBB', utcDate: '2026-09-01T14:00:00Z', status: 'POSTPONED' },
        { fdId: 2, home: 'CCC', away: 'DDD', utcDate: '2026-10-15T19:45:00Z', status: 'TIMED' },
        { fdId: 3, home: 'EEE', away: 'FFF', utcDate: '2026-09-03T16:30:00Z', status: 'TIMED' },
      ];
      const ev = diffSnapshots(prev, next);
      const fix = [{ home: 'AAA', away: 'BBB', played: false, kickoff: '2026-09-01T14:00:00+00:00' },
        { home: 'EEE', away: 'FFF', played: false, kickoff: '2026-09-03T14:00:00+00:00' }];
      const n = attachScheduleStatus(fix, next);
      const norm = normalizeMatches([
        { id: 9, stage: 'PLAYOFFS', homeTeam: { name: 'X' }, awayTeam: { name: 'Y' }, utcDate: 'd', status: 'TIMED' },
        { id: 8, stage: 'REGULAR_SEASON', homeTeam: { name: 'Alpha FC' }, awayTeam: { name: 'Beta' }, utcDate: 'd', status: 'TIMED' },
      ], nm => ({ alpha: 'AAA', beta: 'BBB' }[nm.toLowerCase().replace(' fc', '')] ?? null));
      return [
        ['延賽偵測:轉延期 / 延期後改期 / 換時間 三種事件都抓到',
          ev.length === 3 && ev.some(e => e.kind === 'postponed' && e.fdId === 1)
          && ev.some(e => e.kind === 'rescheduled' && e.fdId === 2 && e.to === '2026-10-15T19:45:00Z')
          && ev.some(e => e.kind === 'rescheduled' && e.fdId === 3), JSON.stringify(ev)],
        ['延賽偵測:只標有事的場次,沒事不加欄位', n === 1
          && fix[0].officialStatus === 'POSTPONED' && fix[0].officialStatusZh === '延期'
          && !('officialStatus' in fix[1]), ''],
        ['延賽偵測:附加賽不收、隊名對不到就跳過', norm.length === 1 && norm[0].home === 'AAA', ''],
        ['延賽偵測:接線(builds 掛 + 實時頁講官方狀態 + CI 抓取與回寫)', (() => {
          const b1 = readFileSync(join(ROOT, 'scripts', 'build.mjs'), 'utf8');
          const b2 = readFileSync(join(ROOT, 'scripts', 'build-championship.mjs'), 'utf8');
          const lv = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-live.js'), 'utf8');
          const wf = readFileSync(join(ROOT, '..', '.github', 'workflows', 'epl-live.yml'), 'utf8');
          return /attachScheduleStatus\(fixtures/.test(b1) && /attachScheduleStatus\(fixtures/.test(b2)
            && /officialStatusZh/.test(lv) && /schedule:status/.test(wf)
            && /epl\/data\/raw\/schedule-status\.json/.test(wf);
        })()],
      ];
    })(),

    /* ── 教練基本檔案核對器(2026-08-29)。核心是來源真偽:
       交付的 53 個戰術來源網址實測 41 個 404 —— 編造網址的筆定罪,整聯賽退。 ── */
    ...await (async () => {
      const { verifyProfiles } = await import('./verify-coach-profiles.mjs');
      const ctx = {
        rosters: { pl: new Map([['ARS', { name: 'Mikel Arteta', zh: '阿爾特塔', formation: '4-3-3' }]]),
          es1: new Map(), en2: new Map() },
        controls: { pl: new Map([['ARS', { zh: '阿爾特塔', formation: '4-3-3' }]]), es1: new Map(), en2: new Map() },
        urlStatus: { 'https://dead.example/x': 404, 'https://ok.example/y': 200 },
      };
      ctx.urlStatus['https://blocked.example/z'] = 403;
      const run = coaches => verifyProfiles({ coaches }, ctx);
      const mk = extra => ({ league: 'pl', team: 'ARS', name: 'Mikel Arteta', zh: '阿爾特塔', ...extra });
      const fabricated = run([mk({ formation: '4-3-3', style: ['高位壓迫'],
        sources: ['https://dead.example/x', 'https://dead.example/x'] })]);
      const secondDead = run([mk({ formation: '4-3-3', style: ['高位壓迫'],
        sources: ['https://ok.example/y', 'https://dead.example/x'] })]);
      const botBlocked = run([mk({ formation: '4-3-3', style: ['高位壓迫'],
        sources: ['https://ok.example/y', 'https://blocked.example/z'] })]);
      const honest = run([mk({ formation: null, style: [], sources: ['https://ok.example/y', 'https://ok.example/y'] })]);
      const zhWrong = run([{ league: 'pl', team: 'ARS', name: 'Mikel Arteta', zh: '亞提達',
        formation: null, style: [], sources: ['https://ok.example/y', 'https://ok.example/y'] }]);
      return [
        /* 政策分三級:主張的來源全死 → 定罪;第二來源死 → labelIssue(該修不誆人);
           403/5xx 是站方擋爬蟲或伺服器錯,不當「不存在」的證據(第一版冤枉過曼城官網) */
        ['檔案核對:主張的來源全 404 → 定罪、整聯賽退', fabricated.pl.verdict === 'rejected'
          && fabricated.pl.convictions.some(c => c.includes('主張沒有依據')), ''],
        ['檔案核對:主來源活著、第二來源死 → labelIssue 不定罪', secondDead.pl.verdict === 'accepted'
          && secondDead.pl.labelIssues.some(c => c.includes('來源失聯')), JSON.stringify(secondDead.pl.convictions)],
        ['檔案核對:403 擋爬蟲不當不存在的證據', botBlocked.pl.verdict === 'accepted', ''],
        ['檔案核對:誠實的 null + 真來源 → 通過', honest.pl.verdict === 'accepted', JSON.stringify(honest.pl.convictions)],
        ['檔案核對:對照題譯名不符 → 定罪', zhWrong.pl.verdict === 'rejected', ''],
        /* 掛載:只補 null 不覆蓋;雙教頭聯名紀錄不收單人譯名 */
        ...await (async () => {
          const { attachProfiles } = await import('./lib/coach-profiles.mjs');
          void attachProfiles;   // 掛載邏輯用純函式難注入檔案系統,改驗產物 + 原始碼守則
          const src = readFileSync(join(ROOT, 'scripts', 'lib', 'coach-profiles.mjs'), 'utf8');
          return [
            ['檔案掛載:只補 null、不覆蓋既有整理、雙教頭不收單人譯名',
              /!co\.zh && rec\.zh/.test(src) && /!co\.formation && rec\.formation/.test(src)
              && /joint/.test(src) && /includes\('&'\)/.test(src), ''],
          ];
        })(),
        ['產物:通過的檔案補進名冊(pl 換帥教練有譯名與國籍)', (() => {
          const vPath = join(ROOT, 'data', 'coach-profiles-verified.json');
          if (!existsSync(vPath)) return true;
          const v = JSON.parse(readFileSync(vPath, 'utf8'));
          for (const lg of ['pl', 'es1', 'en2']) {
            if (v.blocks?.[lg]?.verdict !== 'accepted') continue;
            const p = lg === 'pl' ? 'web/data/coaches.json' : `web/data/leagues/${lg}/coaches.json`;
            const arr = JSON.parse(readFileSync(join(ROOT, ...p.split('/')), 'utf8'));
            const coaches = arr.coaches ?? arr;
            for (const rec of v.published.filter(r => r.league === lg)) {
              const co = coaches.find(c => c.team === rec.team);
              if (!co) continue;
              if (String(co.name ?? '').includes('&')) continue;   // 雙教頭只補陣型風格
              if (rec.zh && !co.zh) return false;
              if (rec.nat && !co.nat) return false;
            }
          }
          return true;
        })()],
        ['檔案核對:收件匣在的話,核對產物 sha 要對得上', (() => {
          const inboxPath = join(ROOT, 'data', 'manual', 'coach-profiles.json');
          if (!existsSync(inboxPath)) return true;
          const vPath = join(ROOT, 'data', 'coach-profiles-verified.json');
          if (!existsSync(vPath)) return false;
          const v = JSON.parse(readFileSync(vPath, 'utf8'));
          return v.inboxSha256 === createHash('sha256').update(readFileSync(inboxPath, 'utf8')).digest('hex');
        })()],
      ];
    })(),

    /* ── 盃賽併頁 + 球隊完整賽程含盃賽(2026-08-29,使用者要求)── */
    ['球隊深連結預設只看未賽(「完整賽程」要的是未來)', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'fixture-list.js'), 'utf8');
      const i = src.indexOf("C.qs('team')");
      return i > 0 && /selectIds\.state/.test(src.slice(i, i + 900))
        && /'未賽'/.test(src.slice(i, i + 900));
    })()],
    ['球隊深連結附掛盃賽場次,而且只在帶 team 時才載 1.8MB 的 cups', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'fixture-list.js'), 'utf8');
      return /appendCupFixtures\(want\)/.test(src)
        && /loadFrom\('pl', \['cups', 'ucl'\]\)/.test(src);
    })()],
    /* 抽籤後上游常給「日期 + 00:00Z」占位 —— 半夜整點 UTC 不會有球賽,
       照印會變成「台北 08:00 開球」這種假時間。 */
    ['占位的 00:00Z 開球時間標成「時間待定」,不印假時間', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'fixture-list.js'), 'utf8');
      return /T00:00:00Z/.test(src) && /時間待定/.test(src);
    })()],
    ['盃賽名冊沒有隊碼時用隊名備援(英冠球隊在盃賽資料裡沒有 code)', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'fixture-list.js'), 'utf8');
      return /side\.code === code/.test(src) && /names\.has/.test(src);
    })()],
    ['英冠也開放盃賽(英冠球隊本來就打足總盃與聯賽盃)',
      V.LEAGUES.en2.open.includes('cups')],

    ['缺口訊息不會把資料集的內部鍵給讀者看',
      ['live', 'players', 'leaders', 'news', 'form', 'tactics', 'knowledge', 'cups']
        .every(k => /[\u4e00-\u9fff]/.test(V.DATASET_ZH?.[k] ?? ''))],
  ];

  let fail = 0;
  for (const [name, pass] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 近況與交手紀錄的特徵。
   這些特徵目前**沒有進模型**(TUNED 全 0),所以第一條也是最重要的一條檢查是:
   套用調整之後 λ 必須一模一樣。哪天有人手滑改了係數卻沒重跑 tune:form,
   這裡就會擋下來 —— 模型頁上寫著「這些沒有進模型」,那就得是真的。

   第二重要的是不准偷看未來:把未來的比賽塞進索引,算出來的值不能改變。
   走查回測的可信度整個押在這件事上。 */
function checkForm(past, test) {
  const all = [...past, ...test];
  const index = buildFormIndex(all);
  const code = test[0].home;
  const cut = test[Math.floor(test.length / 2)].date;

  // 只用 cut 之前的比賽另外建一個索引;兩邊在 cut 這個時間點算出來的值必須相同
  const partial = buildFormIndex(all.filter(m => m.date < cut));
  const leakOk = ['formH'].every(() => Math.abs(formDelta(index, code, cut) - formDelta(partial, code, cut)) < 1e-12)
    && Math.abs(goalForm(index, code, cut).gf - goalForm(partial, code, cut).gf) < 1e-12;

  const pairA = test[0].home, pairB = test[0].away;
  const hLate = h2hDelta(index, pairA, pairB, '9999-12-31');
  const hEarly = h2hDelta(index, pairA, pairB, '1990-01-01');

  const rows = recentForm(index, code, '9999-12-31', 5);
  const sum = formSummary(rows);
  const seasonRec = teamRecord(test, code);
  const first10 = teamRecord([...test].reverse(), code, { limit: 10 });
  const lam = { lh: 1.73, la: 1.21 };
  const feats = {
    formH: 1.2, formA: -0.8, gfH: 0.9, gaH: -0.3, gfA: 0.4, gaA: 0.7, h2h: 2.5,
  };
  const zero = adjustLambdas(lam, feats, TUNED);
  const nonZero = adjustLambdas(lam, feats, { bForm: 0.1, bGoal: 0.1, bH2h: 0.05 });

  const cases = [
    ['目前的係數不會動到 λ(這些特徵沒有進模型)',
      zero.lh === lam.lh && zero.la === lam.la,
      `λ 變成 ${zero.lh.toFixed(4)} / ${zero.la.toFixed(4)}`],
    ['係數不是 0 時確實會調整', nonZero.lh !== lam.lh && nonZero.la !== lam.la, ''],
    ['不偷看未來:未來的比賽不影響當下的特徵值', leakOk, ''],
    ['沒交手過回 0,不亂猜', hEarly.gd === 0 && hEarly.n === 0, ''],
    ['有交手紀錄時 n 會大於 0', hLate.n > 0, `n=${hLate.n}`],
    ['近五戰最多五場、由新到舊', rows.length <= 5 && rows.every((r, i) => i === 0 || r.date <= rows[i - 1].date), ''],
    ['近五戰的勝負與比分一致',
      rows.every(r => r.res === (r.gf > r.ga ? 'W' : r.gf === r.ga ? 'D' : 'L')), ''],
    ['彙總的勝點跟逐場對得起來', sum.pts === sum.w * 3 + sum.d && sum.w + sum.d + sum.l === rows.length, ''],
    ['近五戰勝率跟勝場數對得起來', sum.winPct === Math.round((sum.w / rows.length) * 1000) / 10, `${sum.winPct}%`],
    ['逐季攻守的勝和負與場次對得起來', seasonRec.w + seasonRec.d + seasonRec.l === seasonRec.p, ''],
    ['前 10 場不受輸入順序影響且最多 10 場', first10.p <= 10 && first10.p === Math.min(10, seasonRec.p), `p=${first10.p}`],
    ['前 10 場攻守平均跟總數對得起來', first10.p === 0 || (first10.avgGF === round(first10.gf / first10.p, 2) && first10.avgGA === round(first10.ga / first10.p, 2)), ''],
  ];

  let fail = 0;
  for (const [name, pass, detail] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 傷停與拿牌。這一段沒有回測(上游不給歷史快照),所以檢查的是「算術對不對」,
   不是「有沒有預測力」—— 後者要等 snapshot-availability.mjs 累積夠了才談得上。 */
function checkAvailability() {
  const p = (code, status, minutes, xGI, yellow = 0, red = 0) => ({
    code, name: code, pos: 'MID', status, statusZh: status, news: '', chanceNext: null,
    last: { minutes, xGI, startRate: 1 },
    current: { minutes: 0, xGI: 0, yellow, red, startRate: 1 },
  });
  // 四個人各 900 分鐘,其中一個傷停 → 缺了 25% 的上場時間
  const squad = [
    p('A', 'a', 900, 4), p('B', 'a', 900, 4), p('C', 'a', 900, 4), p('D', 'i', 900, 8),
  ];
  const a = teamAvailability(squad, { teamMatches: 10 });

  const cases = [
    ['用上季當基準(本季場次不足)', a.baseline === 'last', a.baseline],
    ['缺陣佔上場時間算得對', Math.abs(a.missing.minutes - 0.25) < 1e-9, String(a.missing.minutes)],
    ['缺陣佔期望進球參與算得對', Math.abs(a.missing.threat - 0.4) < 1e-9, String(a.missing.threat)],
    ['沒有參考資料的球員會被標出來',
      teamAvailability([...squad, p('E', 'a', 0, 0)], { teamMatches: 10 }).noBaseline === 1, ''],
    ['4 張黃牌 → 再一張停 1 場', cardWatch(4, 10)?.away === 1 && cardWatch(4, 10)?.ban === 1, ''],
    ['5 張黃牌之後改看下一個門檻', cardWatch(5, 10)?.next === 10, ''],
    ['過了第 19 場,5 張的門檻就不再適用', cardWatch(4, 20)?.next === 10, ''],
    ['整季門檻都過了就沒有停賽風險', cardWatch(16, 38) === null, ''],
    ['有疑慮的人不算進「確定缺陣」',
      teamAvailability([p('A', 'a', 900, 4), p('B', 'd', 900, 4)], { teamMatches: 10 }).missing.minutes === 0, ''],
  ];

  /* 已經轉隊的人不是傷兵。把他算進「這場缺了多少戰力」會誤導 ——
     他不在隊上了,位置也多半有新援補上。所以他要整個移出母體。 */
  const gone = { ...p('X', 'u', 900, 4), news: 'Has joined Como permanently' };
  const withGone = teamAvailability([p('A', 'a', 900, 4), p('B', 'i', 900, 4), gone], { teamMatches: 10 });
  cases.push(
    ['轉隊的人不算傷停', withGone.outCount === 1 && withGone.out[0].name === 'B', `outCount=${withGone.outCount}`],
    ['轉隊的人移出母體(剩兩人,傷停就是一半)',
      Math.abs(withGone.missing.minutes - 0.5) < 1e-9, String(withGone.missing.minutes)],
    ['換血幅度單獨算(三人裡走一個 = 三分之一)',
      withGone.departed.count === 1 && Math.abs(withGone.departed.minutes - 1 / 3) < 1e-9,
      String(withGone.departed.minutes)],
    ['status=u 但看不出是轉隊時仍算缺陣',
      teamAvailability([p('A', 'a', 900, 4), { ...p('Y', 'u', 900, 4), news: 'Not in squad' }],
        { teamMatches: 10 }).outCount === 1, ''],
  );

  let fail = 0;
  for (const [name, pass, detail] of cases) {
    console.log(`  ${pass ? '✔' : '✗'} ${name}${pass || !detail ? '' : ` —— ${detail}`}`);
    if (!pass) fail++;
  }
  return fail;
}

/* 每一種對戰組合都要通過資料視覺化的可量測檢查。
   門檻與數學都照 dataviz 技能的驗證器:OKLab ΔE、Machado-Oliveira-Fernandes(2009)
   色盲模擬、WCAG 對比。眼睛看不出「這兩個紅差多少」,所以用算的。 */
function checkColours(T) {
  const codes = T.list.map(t => t.code);
  const S = '#171021';
  let band = 0, chroma = 0, cvd = 0, normal = 0, con = 0, n = 0;
  let wN = 99, wC = 99, wCon = 99, wNpair = null;
  for (const h of codes) for (const a of codes) {
    if (h === a) continue;
    n++;
    const p = pickPair(T.byCode.get(h).colors, T.byCode.get(a).colors, { surface: S });
    for (const c of [p.home, p.away]) {
      const o = oklch(c);
      if (o.L < 0.48 || o.L > 0.67) band++;          // 驗證器的深色模式明度區間
      if (o.C < THRESHOLDS.chroma) chroma++;
      const k = contrast(c, S);
      if (k < THRESHOLDS.contrast) con++;
      wCon = Math.min(wCon, k);
    }
    const dn = deltaE(p.home, p.away);
    const dc = Math.min(deltaE(p.home, p.away, 'protan'), deltaE(p.home, p.away, 'deutan'));
    if (dn < THRESHOLDS.normal) normal++;
    if (dc < THRESHOLDS.cvd) cvd++;
    if (dn < wN) { wN = dn; wNpair = `${h} vs ${a}`; }
    wC = Math.min(wC, dc);
  }
  const cases = [
    [`${n} 組對戰的明度都在區間內`, band === 0],
    ['彩度都夠(不會讀成灰色)', chroma === 0],
    [`色盲仍分得出來(最差 ΔE ${wC.toFixed(1)} ≥ ${THRESHOLDS.cvd})`, cvd === 0],
    [`一般視覺分得出來(最差 ΔE ${wN.toFixed(1)} ≥ ${THRESHOLDS.normal},${wNpair})`, normal === 0],
    [`對比都夠(最差 ${wCon.toFixed(2)} ≥ ${THRESHOLDS.contrast})`, con === 0],
    // 同色系的球隊一定要被拉開,否則這整套就沒有意義
    ['紅隊對紅隊會自動換色', (() => {
      const p = pickPair(T.byCode.get('LIV').colors, T.byCode.get('NFO').colors, { surface: S });
      return deltaE(p.home, p.away) >= THRESHOLDS.normal;
    })()],
    ['主隊保留自己的主色', (() => {
      const p = pickPair(T.byCode.get('LIV').colors, T.byCode.get('NFO').colors, { surface: S });
      return oklch(p.home).h > 10 && oklch(p.home).h < 45;   // 仍是紅色系
    })()],
  ];
  let fail = 0;
  for (const [name, ok] of cases) { console.log(`  ${ok ? '✔' : '✗'} ${name}`); if (!ok) fail++; }
  return fail;
}

function checkOdds() {
  const cases = [];
  // 加總為 1
  const p = devig(2.0, 3.5, 4.0);
  cases.push(['去水錢後三者加總為 1', p && Math.abs(p.home + p.draw + p.away - 1) < 1e-9]);
  // 賠率越低 → 機率越高(單調)
  cases.push(['賠率越低機率越高', p && p.home > p.draw && p.draw > p.away]);
  // overround 為正(莊家一定有水錢)
  cases.push(['水錢(overround)為正', p && p.overround > 0 && p.overround < 0.3]);
  // 壞賠率回 null,不會污染
  cases.push(['壞賠率回 null 不亂算', devig(0, 0, 0) === null && devig(1, 2, 3) === null]);
  // CSV 解析 + 隊名對照
  const csv = 'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,PSCH,PSCD,PSCA\n'
    + 'E0,16/08/25,Man United,Arsenal,1,2,3.10,3.40,2.30\n'
    + 'E0,16/08/25,Nowhere,Chelsea,0,0,2.0,3.0,4.0';
  const r = parseOddsCsv(csv, {});
  cases.push(['CSV 解析 + 隊名對照', r.matches.length === 1 && r.matches[0].home === 'MUN'
    && r.matches[0].away === 'ARS' && r.unmatched.includes('Nowhere')]);
  // 收盤優先於開盤:同一列給兩種,要挑收盤(PSCH)
  const csv2 = 'Div,Date,HomeTeam,AwayTeam,PSH,PSD,PSA,PSCH,PSCD,PSCA\n'
    + 'E0,16/08/25,Arsenal,Chelsea,9,9,9,1.50,4.00,7.00';
  const r2 = parseOddsCsv(csv2, {});
  cases.push(['收盤賠率優先於開盤', r2.matches[0]?.source === 'Pinnacle 收盤' && r2.matches[0]?.decimals.home === 1.5]);

  let fail = 0;
  for (const [name, ok] of cases) { console.log(`  ${ok ? '✔' : '✗'} ${name}`); if (!ok) fail++; }
  return fail;
}

function checkOfficialNames() {
  let players;
  try { players = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'players.json'), 'utf8')); }
  catch { console.log('  ⚠ 還沒有 web/data/players.json,略過'); return 0; }

  // 官方寫法 → 期望對到我們球員庫的哪一位(用 FPL 的 web name 表示)。
  // 挑的都是「三種寫法都不一樣」的難例:同隊三個 Gabriel、含重音、複姓、暱稱式 web name。
  const want = [
    ['ARS', 'Gabriel Magalhães', 'Gabriel'],
    ['ARS', 'Gabriel Martinelli', 'Martinelli'],
    ['ARS', 'Gabriel Jesus', 'G.Jesus'],
    ['ARS', 'Martin Ødegaard', 'Ødegaard'],
    ['ARS', 'Myles Lewis-Skelly', 'Lewis-Skelly'],
    ['ARS', 'David Raya', 'Raya'],
    ['ARS', 'Gabriel', null],          // 同隊三個 Gabriel,分不出來就該回 null,不准亂配
    ['ARS', 'Nobody Here', null],
  ];
  const byCode = new Map(players.map(p => [p.code, p]));
  let fail = 0;
  for (const [team, official, expect] of want) {
    const r = attachCodes({
      asOf: null, season: null,
      matches: { [`${team}|XXX`]: {
        home: { formation: null, xi: [{ name: official, shirt: null, pos: 'M' }], subs: [] },
        away: { formation: null, xi: [], subs: [] } } },
    }, players);
    const got = r.matches[`${team}|XXX`].home.xi[0].code;
    const gotName = got ? byCode.get(got)?.name ?? got : null;
    const ok = gotName === expect;
    if (!ok) fail++;
    console.log(`  ${ok ? '✔' : '✗'} ${official} → ${gotName ?? '(對不上)'}${ok ? '' : `,應該是 ${expect ?? '(對不上)'}`}`);
  }
  return fail;
}


/* 英格蘭盃賽。這一節守的是四件**真的踩過或差點踩到**的事。

   一、隊名寬鬆比對在盃賽會對錯球隊。
   二、延長賽與 PK 的比分不能被壓成一個數字。
   三、未賽場次不能被算成「踢了但沒贏」。
   四、沒見過的比分類別不給語意,而且要報出來。 */
/* ── 資產版本戳 ────────────────────────────────
   「部署了卻沒看到更新」的根因:HTML 直接寫 assets/js/page-index.js,
   沒有任何版本資訊,瀏覽器繼續端舊的那一份。
   最難察覺的是 **meta.json 是新的、JS 是舊的** ——
   頁尾顯示最新建置時間、版面卻是上一版,看起來像改動沒生效。
   這一節守著:戳有打上、每一頁都有、而且**對得回檔案內容**
   (對不回就是有人改了檔案卻忘記重跑 stamp)。 */
function checkAssetStamps() {
  let fail = 0;
  const ok = (cond, msg, extra = '') => { if (cond) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${extra ? ` (${extra})` : ''}`); fail++; } };
  const W = join(ROOT, 'web');
  const stripV = t => t.replace(/(\.(?:js|css))\?v=[0-9a-f]{8}/g, '$1');
  const shortHash = t => createHash('sha256').update(t).digest('hex').slice(0, 8);

  const html = readFileSync(join(W, 'index.html'), 'utf8');
  ok(/href="assets\/css\/app\.css\?v=[0-9a-f]{8}"/.test(html), 'index.html 的 CSS 有版本戳');
  ok(/src="assets\/js\/page-index\.js\?v=[0-9a-f]{8}"/.test(html), 'index.html 的頁面 JS 有版本戳');
  ok(!/<title>總覽/.test(html), 'index.html 的 title 不再是「總覽」');

  const pageIndex = readFileSync(join(W, 'assets', 'js', 'page-index.js'), 'utf8');
  ok(/from '\.\/core\.js\?v=[0-9a-f]{8}'/.test(pageIndex), 'page-index 引用 core.js 時帶版本戳');
  ok(/from '\.\/fixture-list\.js\?v=[0-9a-f]{8}'/.test(pageIndex), 'page-index 引用共用模組時帶版本戳');

  const coreStamp = pageIndex.match(/core\.js\?v=([0-9a-f]{8})/)?.[1];
  const coreSrc = readFileSync(join(W, 'assets', 'js', 'core.js'), 'utf8');
  ok(coreStamp === shortHash(coreSrc), 'core.js 的戳對得回檔案內容', `${coreStamp} vs ${shortHash(coreSrc)}`);

  const cssStamp = html.match(/app\.css\?v=([0-9a-f]{8})/)?.[1];
  const cssSrc = stripV(readFileSync(join(W, 'assets', 'css', 'app.css'), 'utf8'));
  ok(cssStamp === shortHash(cssSrc), 'app.css 的戳對得回檔案內容', `${cssStamp} vs ${shortHash(cssSrc)}`);

  // 漏一頁的話,那一頁就是會「沒看到更新」的那一頁
  const pages = readdirSync(W).filter(f => f.endsWith('.html'));
  const missed = pages.filter(f => {
    const t = readFileSync(join(W, f), 'utf8');
    return /src="assets\/js\/[\w-]+\.js"/.test(t) || /href="assets\/css\/app\.css"/.test(t);
  });
  ok(missed.length === 0, `${pages.length} 頁全部打上版本戳`, missed.join('、'));

  /* meta.json 要記著這次建置的戳,前端才有辦法知道「我現在跑的是不是最新那一版」。
     使用者實際遇到的症狀:在導覽列點來點去,有時候跳成上一版的排版 ——
     GitHub Pages 給 HTML 的快取是十分鐘而且每個檔案各自計時,
     所以同一次瀏覽裡可能一頁新、一頁舊。對不上就重載一次(core.js 的 checkStale)。
     這幾條守著 meta 裡的戳跟實際檔案對得起來 —— 對不上的話,
     每一次開頁都會白白重載一次。 */
  for (const f of ['meta.json', join('leagues', 'es1', 'meta.json')]) {
    const path = join(W, 'data', f);
    if (!existsSync(path)) continue;
    const m = JSON.parse(readFileSync(path, 'utf8'));
    ok(m.assets?.core === coreStamp, `${f} 記的 core 戳跟實際檔案一致`, `${m.assets?.core} vs ${coreStamp}`);
    ok(m.assets?.css === cssStamp, `${f} 記的 css 戳跟實際檔案一致`, `${m.assets?.css} vs ${cssStamp}`);
  }

  /* 共用模組要真的被兩邊引用。這一條是在守「複製一份過去」——
     預測積分榜同時出現在積分與賽程頁與實時戰況頁,兩邊各寫一份的話
     改了一邊另一邊會悄悄變成另一個版本,而且畫面上看不出來。
     順帶守著 import 有沒有真的加上去:上一次改這裡時,
     版本戳讓 import 那一行不再是字面字串,replace 靜靜沒命中,
     頁面變成「載入失敗」而 npm test 全綠 —— 測試檢查不到版面。 */
  const liveSrc = readFileSync(join(W, 'assets', 'js', 'page-live.js'), 'utf8');
  ok(/import \{ mountSimTable \} from '\.\/sim-table\.js(\?v=[0-9a-f]{8})?';/.test(liveSrc),
    'page-live.js 有 import 共用的預測積分榜');
  ok(liveSrc.includes("mountSimTable('simTable'"), 'page-live.js 有呼叫它');

  /* 首頁只留賽程,兩張積分榜都在實時戰況頁 ——
     這兩條是在守「不要又搬回來」:同一份資料兩個地方畫,
     改了一邊另一邊會悄悄過期。 */
  const idx = readFileSync(join(W, 'assets', 'js', 'page-index.js'), 'utf8');
  ok(!idx.includes('本季目前戰績'), '首頁不重複「本季目前戰績」');
  ok(!idx.includes('mountSimTable'), '首頁不重複「本季預測積分榜」');
  ok(!/'sim'/.test(idx), '首頁不再載 sim.json(用不到就不要下載)');

  /* 單檔版的 hash 路由每次換頁都會 `.topbar?.remove()`。
     nav() 若用布林旗標擋重複渲染,旗標在第一頁就被設成 true,
     之後永遠 return —— **第一頁之後整條導覽列都不見了**。
     旗標記的是「這次載入畫過了」,DOM 記的才是「現在畫面上有沒有」。 */
  const core = readFileSync(join(W, 'assets', 'js', 'core.js'), 'utf8');
  // 註解裡會提到 navDone(它就記在那段註解裡),所以要先把註解去掉再檢查程式本身
  const coreCode = core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/\bnavDone\b/.test(coreCode), 'nav() 不用布林旗標擋重複渲染(單檔版換頁會把導覽列砍掉)');
  ok(core.includes("if (document.querySelector('.topbar')) return;"), 'nav() 改看 DOM 判斷要不要畫');
  ok(core.includes("const SITE_PAGES"), '導覽列分成跨聯賽與聯賽兩組');
  ok(core.includes('checkStale'), 'core.js 有版本對不上時的自我修復');
  ok(core.includes('sessionStorage'), '重載有 sessionStorage 記號,不會無限重載');

  /* 剛結束的比賽留在最上面三天。這三條守的是兩件會靜靜出錯的事:

     一、**同一場出現兩次。** 頁尾的「已完賽」區如果還吃 done / finishedSchedule,
        剛結束的那幾場會同時出現在兩個區塊 —— 版面看起來沒壞,只是重複,
        而重複的比分讀者會以為是兩場不同的比賽。
     二、**115 分鐘這個數字被抄成第二份。** 賽末時間 = 開球 + MATCH_WINDOW_MIN,
        core 已經有這個常數;頁面自己再寫一個 115 的話,改了一邊另一邊不會跟著動。 */
  ok(/export const MATCH_WINDOW_MIN/.test(core), 'core.js 把賽末時間常數匯出去給頁面共用');
  ok(liveSrc.includes('C.MATCH_WINDOW_MIN'), '實時戰況頁用 core 的賽末時間,不自己再寫一份');
  ok(!/\b115\b/.test(liveSrc.replace(/\/\*[\s\S]*?\*\//g, '')), '實時戰況頁沒有另一份寫死的 115');
  ok(liveSrc.includes('const RECENT_MS = 3 * 24 * 3600 * 1000'), '「剛結束」的窗口是 3 天');
  ok(liveSrc.includes('doneRest') && liveSrc.includes('finishedRest'),
    '已完賽區吃的是扣掉「剛結束」之後的清單(否則同一場出現兩次)');
  ok(!/\$\{live\.available && done\.length \?/.test(liveSrc),
    '已完賽區不再直接用未扣除的 done');
  ok(liveSrc.includes('live.demo ? new Set()'),
    '重播模式不做排除(重播的是別季比賽,配對鍵可能撞上本季)');

  /* 第二層分頁。GROUPS 裡列的頁面都必須真的存在於 PAGES ——
     打錯一個字的話那一頁會從導覽列整個消失(頂層排除它、子層又找不到它),
     而且不會有任何地方報錯。 */
  const groupPages = [...core.matchAll(/pages: \[([^\]]+)\]/g)]
    .flatMap(m => m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')));
  ok(groupPages.length >= 5, `分析組收了 ${groupPages.length} 個分頁`);
  const declared = [...core.matchAll(/^  \['([\w-]+)',/gm)].map(m => m[1]);
  const orphan = groupPages.filter(p => !declared.includes(p));
  ok(orphan.length === 0, '分組列的分頁都真的存在於 PAGES', orphan.join('、'));
  // 每一個被分組的頁面都要有對應的 html,否則子分頁會連到 404
  const missingHtml = groupPages.filter(p => !existsSync(join(W, `${p}.html`)));
  ok(missingHtml.length === 0, '分組的每一頁都有對應的 html', missingHtml.join('、'));
  return fail;
}

/* 歐冠。這一節守的是五件**真的踩過或差一點踩到**的事。

   一、上游的 fullTime 在 PK 場是**含 PK 的累加值**,不是比分。
   二、兩回合的總比分不可以把 PK 加進去。
   三、聯賽階段的名次要用官方那份,自己算的只拿來對帳。
   四、1-8 / 9-24 / 25-36 三段是**看實際參賽推出來的**,不是照名次假設的。
   五、導覽列的兩份清單都放同一頁的話,會出現兩個「歐冠」。 */
/* 人工整理的外電。守四件事:

   一、**比分核對真的會擋。** 交付方自己寫 verified:true 不算數(鐵則五),
      而且賽果會更新、這份檔案是靜態的 —— 只核對一次不夠。
   二、**不可以掛「機器翻譯」標記。** 中文摘要是人寫的,標成機器翻譯是講假話。
   三、**傳聞與已確認的交易要分開**,而且沒見過的 status 不給語意。
   四、**同一組對戰跨季會重複**,配錯季的話比分會全對不上(實際踩過)。 */
function checkCuratedNews() {
  let fail = 0;
  const ok = (cond, msg, extra = '') => { if (cond) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${extra ? ` (${extra})` : ''}`); fail++; } };

  const src = join(ROOT, 'data', 'manual', 'news-curated.json');
  if (!existsSync(src)) { console.log('  (沒有 news-curated.json,略過)'); return 0; }
  const raw = JSON.parse(readFileSync(src, 'utf8'));

  /* ── 核對器本身會不會擋 ──
     用真的賽果造一則「比分寫錯」的摘要,必須被判成 conflict 並退回。
     這一條在守「核對不是裝飾」。 */
  const fixtures = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'es1', 'fixtures.json'), 'utf8'));
  const list = fixtures.fixtures ?? fixtures;
  const sample = list.find(m => m.played);
  const ctx = { codeOf: x => x, fixturesOf: () => list };
  const good = { competition: 'es1', date: sample.date ?? sample.kickoff?.slice(0, 10),
    matches: [{ home: sample.home, away: sample.away, score: `${sample.fh}-${sample.fa}` }] };
  const bad = { ...good, matches: [{ ...good.matches[0], score: `${sample.fh + 3}-${sample.fa}` }] };
  ok(checkScores(good, ctx).state === 'verified', '比分對得上 → verified');
  ok(checkScores(bad, ctx).state === 'conflict', '比分對不上 → conflict(核對真的會擋)');
  ok(toFeedItems([bad], ctx).items.length === 0 && toFeedItems([bad], ctx).rejected.length === 1,
    '判成 conflict 的整則不出,而且會被列進 rejected');

  /* 同一組對戰跨季重複時,要用報導日期收斂到對的那一季。
     實際踩過:第一版用 find(home && away) 抓到上一季那一場,
     西甲三則賽報全部被誤判成「比分不符」。 */
  const twoSeasons = [
    { ...sample, season: 'X', fh: sample.fh + 5, fa: sample.fa, date: '2000-01-01', kickoff: '2000-01-01T00:00:00Z' },
    sample,
  ];
  ok(checkScores(good, { codeOf: x => x, fixturesOf: () => twoSeasons }).state === 'verified',
    '同一組對戰有兩季時,用報導日期挑到對的那一場');

  /* ── 產物 ── */
  for (const [lg, path] of [['pl', join(ROOT, 'web', 'data', 'news.json')],
    ['es1', join(ROOT, 'web', 'data', 'leagues', 'es1', 'news.json')]]) {
    if (!existsSync(path)) continue;
    const feed = JSON.parse(readFileSync(path, 'utf8'));
    const cur = feed.filter(x => x.curated);
    ok(cur.length > 0, `${lg}:動態流裡有人工整理的項目`, String(cur.length));
    ok(cur.every(x => x.link && x.source), `${lg}:每一則都有原文連結與來源`);
    // titleZh / bodyZh 會讓前端掛上「機器翻譯」標記 —— 這一類不是機器翻譯
    ok(cur.every(x => !x.titleZh && !x.bodyZh), `${lg}:沒有用機器翻譯的欄位(標錯等於講假話)`);
    ok(cur.every(x => ['verified', 'unverified', 'none'].includes(x.scoreCheck)),
      `${lg}:比分核對狀態只有三種,不會有 conflict 漏出來`);
    ok(cur.every(x => !x.status || x.statusLabel), `${lg}:每個 status 都有給讀者看的說法(沒見過的不給語意)`);
    // 歐冠是跨聯賽的,兩邊都要看得到
    ok(cur.some(x => x.competition === 'ucl'), `${lg}:歐冠的項目也在這個聯賽的動態流裡`);
    ok(cur.every(x => x.competition === lg || x.competition === 'ucl'),
      `${lg}:不會混進另一個聯賽的項目`);
    const verified = cur.filter(x => x.scoreCheck === 'verified');
    ok(verified.length > 0, `${lg}:至少有一則的比分是真的核對過的`, String(verified.length));
  }

  // 來源檔裡沒見過的 status 要被抓出來
  const all = toFeedItems(raw.stories ?? [], { codeOf: () => null, fixturesOf: () => null });
  ok(all.unknownStatus.length === 0, '來源檔沒有未定義語意的 status', all.unknownStatus.join('、'));
  ok(Object.keys(KNOWN_STATUS).length >= 5, 'status 對照表有涵蓋傳聞與已確認兩類');
  ok((raw.stories ?? []).every(x => /^https:\/\//.test(x.link ?? '')), '來源檔每一則都有 https 連結');

  /* 前端:輪次顯示順序。使用者要求「最新的在最上面、決賽在最上面」。
     盃賽那邊**要先切資格賽再倒**,順序反過來會把決賽切掉。 */
  const W = join(ROOT, 'web', 'assets', 'js');
  // 歐冠 2026-08-29 併進盃賽單頁:渲染在 ucl-view.js,page-ucl.js 只剩轉址
  const uclSrc = readFileSync(join(W, 'ucl-view.js'), 'utf8');
  const cupSrc = readFileSync(join(W, 'page-cups.js'), 'utf8');
  ok(/\[\.\.\.s\.rounds\]\.reverse\(\)/.test(uclSrc), '歐冠:輪次顯示時倒過來(決賽在最上面)');
  ok(uclSrc.indexOf('<h2>淘汰賽</h2>') < uclSrc.indexOf('<h2>聯賽階段</h2>'), '歐冠:淘汰賽排在聯賽階段前面');
  ok(uclSrc.indexOf('<h2>聯賽階段</h2>') < uclSrc.indexOf('leaderBoards(s)'), '歐冠:球員榜排在最後,不會夾在標題與內容之間');
  /* **先切再倒。** 切輪次的邏輯已經收進 visibleRounds();
     這裡守的是「reverse 套在 visibleRounds() 的結果上」——
     反過來(先 reverse 再切)會把決賽那幾輪切掉。 */
  ok(/visibleRounds\(season, showQualifying\)\.slice\(\)\.reverse\(\)/.test(cupSrc),
    '盃賽:先切掉資格賽再倒過來(順序反了會把決賽切掉)');

  /* ── 收件匣 → 檔案庫 ──
     交付檔一份只涵蓋一週。直接讀它的話,下一次交付會把上一週整批蓋掉,
     而且**不會有任何地方報錯** —— 舊的賽報就這樣靜靜消失。
     這一組守四件事:去重、firstSeen 不被後來的交付蓋掉、
     淘汰要連交付紀錄一起淘汰、涵蓋範圍要把斷檔講出來。 */
  {
    const A = join(ROOT, 'data', 'manual', 'news-curated-archive.json');
    ok(existsSync(A), '檔案庫存在(data/manual/news-curated-archive.json)');
    const arc = existsSync(A) ? JSON.parse(readFileSync(A, 'utf8')) : { stories: [], deliveries: [] };
    const ids = (arc.stories ?? []).map(s => s.id);
    ok(new Set(ids).size === ids.length, '檔案庫沒有重複的 id', `${ids.length} 則`);
    ok((arc.stories ?? []).every(s => /^\d{4}-\d{2}-\d{2}$/.test(s.firstSeen ?? '')),
      '每一則都記了 firstSeen(第一次收到是哪天)');
    ok((arc.stories ?? []).length >= (raw.stories ?? []).length,
      '檔案庫的則數不少於收件匣(收件匣已經併進去了)',
      `${(arc.stories ?? []).length} vs ${(raw.stories ?? []).length}`);

    const d1 = readDelivery({ source: 'X', retrievedAt: '2026-01-08T00:00:00Z',
      window: { from: '2026-01-01', to: '2026-01-07' },
      stories: [{ id: 'a', date: '2026-01-02', title: '一' }, { id: 'b', date: '2026-01-03', title: '二' }] });
    ok(d1.ok && d1.stories.length === 2, '交付檔讀得進來');
    const m1 = mergeDelivery(emptyArchive(), d1, { now: '2026-01-08T00:00:00Z' });
    ok(m1.added.length === 2 && m1.archive.stories.length === 2, '第一次交付:兩則都收');

    // 同一份再送一次 → 完全沒有變化(排程每 10 分鐘跑一次,會變的話 git log 全是雜訊)
    const m2 = mergeDelivery(m1.archive, d1, { now: '2026-01-09T00:00:00Z' });
    ok(!m2.changed && m2.unchanged.length === 2 && m2.archive.stories.length === 2,
      '同一份重送:不重複、也不算成有變化');

    // 第二週:一則新的、一則改過內容的舊的
    const d2 = readDelivery({ source: 'X', retrievedAt: '2026-01-15T00:00:00Z',
      window: { from: '2026-01-08', to: '2026-01-14' },
      stories: [{ id: 'b', date: '2026-01-03', title: '二(更正)' }, { id: 'c', date: '2026-01-10', title: '三' }] });
    const m3 = mergeDelivery(m1.archive, d2, { now: '2026-01-15T00:00:00Z' });
    ok(m3.archive.stories.length === 3, '第二次交付:舊的沒有被整批蓋掉(這就是這一層存在的理由)');
    ok(m3.added.length === 1 && m3.updated.length === 1, '新的算新增、改過的算更新');
    const b = m3.archive.stories.find(s => s.id === 'b');
    ok(b.title === '二(更正)' && b.firstSeen === '2026-01-08' && b.lastSeen === '2026-01-15',
      '更正會蓋掉內容,但 firstSeen 保留第一次看到的那天');

    /* 涵蓋範圍:兩段相鄰 → 併成一段;中間空著 → 要算出斷檔。
       不算斷檔的話,「1/1~1/31」看起來像連續 31 天,實際可能只有兩個週末。 */
    const cov = coverageOf(m3.archive);
    ok(cov.ranges.length === 1 && cov.from === '2026-01-01' && cov.to === '2026-01-14' && cov.days === 14,
      '相鄰的兩次交付併成一段連續區間', JSON.stringify(cov.ranges));
    ok(cov.gaps.length === 0, '連續就是沒有斷檔');
    const d4 = readDelivery({ source: 'X', retrievedAt: '2026-02-05T00:00:00Z',
      window: { from: '2026-02-01', to: '2026-02-04' },
      stories: [{ id: 'd', date: '2026-02-02', title: '四' }] });
    const m4 = mergeDelivery(m3.archive, d4, { now: '2026-02-05T00:00:00Z' });
    const cov2 = coverageOf(m4.archive);
    ok(cov2.ranges.length === 2 && cov2.gaps.length === 1
      && cov2.gaps[0].from === '2026-01-15' && cov2.gaps[0].to === '2026-01-31',
      '中間沒交付的那 17 天會被算成斷檔', JSON.stringify(cov2.gaps));
    ok(cov2.days === 18, '累計天數只算真的有收的那幾天,不是頭尾相減', String(cov2.days));

    /* 淘汰:交付紀錄要一起淘汰,不然涵蓋範圍會宣稱收了一段其實已經刪掉的日子。
       跨過界線的那一次,from 要夾到界線上。 */
    const pr = pruneArchive(m4.archive, { asOf: '2026-02-05', keepDays: 25 });
    ok(pr.cutoff === '2026-01-11', '淘汰界線 = 基準日往前 keepDays 天', pr.cutoff);
    ok(pr.archive.stories.every(s => s.date >= pr.cutoff), '界線之前的則被淘汰');
    ok(pr.archive.deliveries.length === 2 && pr.droppedDeliveries === 1,
      '整段都在界線之前的交付紀錄也被淘汰(留著的話涵蓋範圍會宣稱收了已刪掉的日子)',
      `留 ${pr.archive.deliveries.length}・刪 ${pr.droppedDeliveries}`);
    const clamped = pr.archive.deliveries.find(x => x.clamped);
    ok(clamped && clamped.from === pr.cutoff,
      '跨過界線的那一次交付,from 夾到界線上(界線前的內容已經不在了)');

    /* 疊加:合併腳本與 build 是兩個步驟。新交付落地但還沒合併時,
       只讀檔案庫的話這一批**整批看不到**。 */
    const over = overlay(m1.archive.stories, [{ id: 'b', date: '2026-01-03', title: '二(收件匣版)' },
      { id: 'z', date: '2026-01-20', title: '新的' }]);
    ok(over.length === 3, '疊加:收件匣的新項目看得到');
    ok(over.find(s => s.id === 'b').title === '二(收件匣版)', '同一個 id 以收件匣為準');
    ok(over.find(s => s.id === 'b').firstSeen === '2026-01-08', '疊加時 firstSeen 仍然保留');
    ok(over[0].id === 'z', '疊加後照日期由新到舊排');

    // 壞掉的那幾則要被跳過,不是整份丟掉
    const dBad = readDelivery({ window: { from: '2026-01-01', to: '2026-01-07' },
      stories: [{ id: 'ok', date: '2026-01-02' }, { date: '2026-01-03' }, { id: 'x', date: '一月三號' }] });
    ok(dBad.stories.length === 1 && dBad.problems.length === 1,
      '沒有 id 或日期格式不對的被跳過,其他照收');
    ok(!readDelivery({ stories: [] }).ok, 'window 壞掉 → 整份不收(涵蓋範圍會說不清楚)');

    /* 產物:畫面上講的涵蓋範圍要跟檔案庫一致,而且兩個聯賽都要有。
       這一段是「涵蓋範圍不是編的」那條的守門員。 */
    const real = coverageOf(arc);
    for (const [lg, mp] of [['pl', join(ROOT, 'web', 'data', 'meta.json')],
      ['es1', join(ROOT, 'web', 'data', 'leagues', 'es1', 'meta.json')]]) {
      if (!existsSync(mp)) continue;
      const c = JSON.parse(readFileSync(mp, 'utf8')).curatedNews;
      ok(c && c.days === real.days && c.from === real.from && c.to === real.to,
        `${lg}:meta 講的涵蓋範圍跟檔案庫算出來的一致`,
        c ? `${c.from}~${c.to} ${c.days}天` : '(沒有)');
      ok(c && c.gaps.length === real.gaps.length, `${lg}:斷檔數目一致`);
    }
    const newsSrc = readFileSync(join(W, 'page-news.js'), 'utf8');
    ok(/meta\.curatedNews/.test(newsSrc) && /斷檔|沒有人整理/.test(newsSrc),
      '動態頁真的把涵蓋範圍與斷檔印出來(鐵則四)');
  }
  return fail;
}

function checkUcl() {
  let fail = 0;
  /* 認不得的球隊的隊徽。三件事要釘住:
     一、隊徽的 key 是 FotMob id,對照表是另一份檔;兩邊對不上就代表有一邊改過沒同步。
     二、**有隊徽不等於有球隊頁** —— 網站上那些球隊只給圖不給連結。
     三、對照不到的那一支(Paphos FC)不可以偷偷生一張圖出來。 */
  {
    const okU = (cond, label, extra = '') => {
      if (!cond) fail++;
      console.log(`  ${cond ? '✔' : '✗'} ${label}${extra ? ` (${extra})` : ''}`);
    };
    const idp = join(ROOT, 'data', 'manual', 'ucl-team-ids.json');
    const crp = join(ROOT, 'data', 'manual', 'crests-ucl.json');
    if (existsSync(idp) && existsSync(crp)) {
      const map = JSON.parse(readFileSync(idp, 'utf8'));
      const crests = JSON.parse(readFileSync(crp, 'utf8')).crests ?? {};
      const mapIds = new Set((map.teams ?? []).map(t => String(t.fotmobId)));
      const crestIds = new Set(Object.keys(crests));
      okU([...mapIds].every(x => crestIds.has(x)) && [...crestIds].every(x => mapIds.has(x)),
        '歐冠隊徽的 key 與 id 對照表完全一致',
        `對照 ${mapIds.size} / 隊徽 ${crestIds.size}`);
      okU((map.unmapped ?? []).every(u => !crestIds.has(String(u.fotmobId ?? ''))),
        '對照不到的球隊沒有被硬補一張圖',
        (map.unmapped ?? []).map(u => u.fdName).join('、') || '無');
      const assets = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'ucl-teams.json'), 'utf8'));
      okU((assets.external ?? []).every(t => t.crest && !t.code),
        '外部球隊只帶名字與隊徽,沒有隊碼(有隊碼就會被當成有球隊頁)',
        `${(assets.external ?? []).length} 支`);
      /* 2026-08-28 起「走到哪一輪」涵蓋全部球隊,不再只算本站認得的那 8~11 支。
         那些數字本來就在同一份資料裡,只是以前 runsByTeam 遇到沒有隊碼就 continue。 */
      const ucl = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'ucl.json'), 'utf8'));
      for (const season of ucl.seasons ?? []) {
        const rows = season.table?.rows ?? [];
        if (!rows.length) continue;
        const expectedRuns = season.played > 0 ? rows.length : 0;
        okU((season.runs ?? []).length === expectedRuns,
          `歐冠 ${season.label}:${season.played > 0 ? '走到哪一輪涵蓋全部球隊' : '未開賽不產生虛構戰績列'}`,
          `runs ${(season.runs ?? []).length} / 預期 ${expectedRuns}`);
        okU((season.runs ?? []).every(r => r.id != null),
          `歐冠 ${season.label}:每一列都有球隊 id(沒有隊碼的也要在)`);

        const sq = season.squads;
        if (!sq) continue;
        /* 陣容只掛對照表裡有的球隊 —— 不做隊名比對,對不到就不掛。 */
        const mapped = new Set((map.teams ?? []).map(t => t.fdId));
        const known = new Set(rows.map(r => r.id));
        okU(Object.keys(sq.teams ?? {}).every(id => mapped.has(Number(id)) || known.has(Number(id))),
          `歐冠 ${season.label}:陣容只掛得到對照表認得的球隊`);
        /* **單位要跟著資料走。** total_scoring_att 是「每 90 分鐘射門」不是總數,
           把它標成總數就是編數字。所以來源宣告的欄位名要一起輸出。 */
        okU(sq.statMeta?.total_scoring_att === 'Shots per 90',
          `歐冠 ${season.label}:球員數據帶著來源宣告的單位`,
          sq.statMeta?.total_scoring_att ?? '(沒有 statMeta)');
        const players = Object.values(sq.teams ?? {}).flat();
        okU(players.every(x => x.minutes > 0),
          `歐冠 ${season.label}:陣容只收有實際出賽的球員`, `${players.length} 人`);
      }

      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'ucl-view.js'), 'utf8');
      okU(/externalCrest/.test(src) && !/externalCrest[\s\S]{0,400}C\.link\(/.test(src),
        '歐冠頁對外部球隊不給連結(沒有球隊頁可以連)');
      /* 走到哪一輪現在列出 36 隊,但只有本站有球隊頁的那幾支可以點 ——
         其餘套上 clickable 會看起來能點卻沒有地方去。 */
      okU(/rowClickable:\s*r\s*=>\s*!!r\.code/.test(src),
        '歐冠頁:沒有球隊頁的球隊那一列不可點');
    }
  }
  const ok = (cond, msg, extra = '') => { if (cond) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${extra ? ` (${extra})` : ''}`); fail++; } };

  const W = join(ROOT, 'web');
  const uclPath = join(W, 'data', 'ucl.json');
  if (!existsSync(uclPath)) { console.log('  (沒有 ucl.json,略過)'); return 0; }
  const ucl = JSON.parse(readFileSync(uclPath, 'utf8'));

  /* 兩個聯賽必須是**同一份**。歐冠是跨聯賽的賽事,兩邊看到不一樣的東西
     代表有人複製了一份轉換邏輯過去,那份遲早會漂移。 */
  const esPath = join(W, 'data', 'leagues', 'es1', 'ucl.json');
  if (existsSync(esPath)) {
    ok(JSON.stringify(ucl) === readFileSync(esPath, 'utf8').trim()
      || JSON.stringify(ucl) === JSON.stringify(JSON.parse(readFileSync(esPath, 'utf8'))),
      '英超與西甲的 ucl.json 完全相同(同一份資料,不是各算一份)');
  }

  ok(ucl.teamCodeConflicts?.length === 0, '沒有兩支歐冠球隊對到同一個隊碼',
    JSON.stringify(ucl.teamCodeConflicts ?? []));

  /* ── 歐冠頁的名字與隊徽是跨聯賽的一份 ──
     以前名字與隊徽是查「目前這個聯賽的 clubs.json」,而兩份 clubs 的隊碼
     **完全沒有交集**,於是同一支球隊在兩頁長得不一樣:Barcelona 在英超頁
     叫上游的 `Barça`、沒有隊徽,在西甲頁才是 `FC Barcelona` ——
     而標題寫著「英超與西甲・共 N 支」。這一組守著它不會再漂回去。 */
  {
    const ap = join(W, 'data', 'ucl-teams.json');
    const bp = join(W, 'data', 'leagues', 'es1', 'ucl-teams.json');
    ok(existsSync(ap) && existsSync(bp), '兩個聯賽都產出了 ucl-teams.json');
    if (existsSync(ap) && existsSync(bp)) {
      ok(readFileSync(ap, 'utf8') === readFileSync(bp, 'utf8'),
        '英超與西甲的 ucl-teams.json 逐位元組相同(跨聯賽只能有一份)');
      const at = JSON.parse(readFileSync(ap, 'utf8'));

      /* ucl.json 裡出現過的每一個隊碼都要在這一份裡 ——
         漏掉的那一支會退回顯示上游的縮寫,而且**只在其中一頁**,
         那正是這次要修掉的症狀。整份走一遍收 code,不列舉區塊,
         否則以後多一個區塊就會有一批球隊靜靜地少掉名字。 */
      const codes = new Set();
      const walk = v => {
        if (Array.isArray(v)) { for (const x of v) walk(x); return; }
        if (!v || typeof v !== 'object') return;
        if (typeof v.code === 'string' && v.code) codes.add(v.code);
        for (const x of Object.values(v)) walk(x);
      };
      walk(ucl);
      const have = new Set(at.teams.map(t => t.code));
      const missing = [...codes].filter(c => !have.has(c));
      ok(missing.length === 0, 'ucl.json 裡的每一個隊碼在 ucl-teams.json 都查得到名字',
        missing.join('、'));
      ok(at.teams.every(t => t.en && t.en !== t.code),
        '每一支都有本站自己的隊名(不是退回代號)');
      ok(at.teams.every(t => t.crest), '每一支都有隊徽',
        at.teams.filter(t => !t.crest).map(t => t.code).join('、'));
      ok(at.teams.some(t => t.league === 'pl') && at.teams.some(t => t.league === 'es1'),
        '兩個聯賽的球隊都收進來了(不是只有其中一邊)');
      const codesSorted = at.teams.map(t => t.code);
      ok(JSON.stringify(codesSorted) === JSON.stringify([...codesSorted].sort()),
        '順序固定(排序不固定的話兩個 build 產出就不會逐位元組相同)');

      /* **登錄順序**:跨聯賽那一份要先登錄,本聯賽的後登錄。
         registerTeams 是逐欄位覆蓋,反過來的話本聯賽比較完整的那筆
         (配色、球場、chartColor)會被只帶名字與隊徽的那筆蓋掉一部分。 */
      const src = readFileSync(join(W, 'assets', 'js', 'ucl-view.js'), 'utf8');
      const iShared = src.indexOf('C.registerTeams(uclTeams');
      const iLocal = src.indexOf('C.registerTeams(clubs)');
      ok(iShared > 0 && iLocal > 0 && iShared < iLocal,
        '歐冠頁先登錄跨聯賽那一份、再登錄本聯賽的');
      ok(/'ucl-teams'/.test(readFileSync(join(W, 'assets', 'js', 'page-cups.js'), 'utf8')),
        '盃賽頁真的載了 ucl-teams(歐冠視圖靠它)');
    }
  }

  const avail = (ucl.seasons ?? []).filter(s => s.availability === 'available');
  ok(avail.length >= 2, '至少兩季可用', `${avail.length} 季`);

  for (const s of avail) {
    const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'football-data', `ucl-${s.label}.json`), 'utf8'));
    const completed = s.total > 0 && s.played === s.total;

    /* ── 一、PK 場的比分 ──────────────────────────
       原始回傳的 fullTime = regularTime + extraTime + penalties(6 場實測全部成立)。
       直接印 fullTime 的話,2025-26 決賽會顯示成「PSG 5-4 Arsenal」,
       實際上是 1-1、PK 4-3 —— 那不是少一個欄位,是把冠軍講錯。 */
    let sumBad = 0;
    for (const m of raw.matches) {
      const sc = m.score ?? {};
      if (!sc.duration || sc.duration === 'REGULAR') continue;
      for (const side of ['home', 'away']) {
        const sum = (sc.regularTime?.[side] ?? 0) + (sc.extraTime?.[side] ?? 0) + (sc.penalties?.[side] ?? 0);
        if (sum !== sc.fullTime?.[side]) sumBad++;
      }
    }
    ok(sumBad === 0, `${s.label}:上游的 fullTime 仍等於 regular+et+pk(這條變了就要重看轉換)`, `${sumBad} 處不符`);

    const pkMatches = s.rounds.flatMap(r => r.ties.flatMap(t => t.legs)).filter(m => m.pens);
    if (completed) ok(pkMatches.length > 0, `${s.label}:完賽球季有 PK 場可以驗`);
    for (const m of pkMatches) {
      const rawM = raw.matches.find(x => x.id === m.id);
      const ftPair = [rawM.score.fullTime.home, rawM.score.fullTime.away];
      ok(JSON.stringify(m.final) !== JSON.stringify(ftPair),
        `${s.label}:PK 場的比分不是 fullTime(${m.home.name} vs ${m.away.name})`,
        `final ${JSON.stringify(m.final)} / fullTime ${JSON.stringify(ftPair)}`);
      const expect = [(rawM.score.regularTime?.home ?? 0) + (rawM.score.extraTime?.home ?? 0),
        (rawM.score.regularTime?.away ?? 0) + (rawM.score.extraTime?.away ?? 0)];
      ok(JSON.stringify(m.final) === JSON.stringify(expect),
        `${s.label}:PK 場的比分 = 正規時間 + 延長(${m.home.name} vs ${m.away.name})`);
    }

    /* ── 二、總比分不含 PK ────────────────────────
       PK 是總比分打平之後才踢的,加進去等於算兩次。 */
    for (const r of s.rounds) {
      for (const t of r.ties) {
        if (!t.aggregate) continue;
        const byId = new Map(t.teams.map(x => [x.id, 0]));
        for (const m of t.legs) {
          if (!m.final) continue;
          byId.set(m.home.id, byId.get(m.home.id) + m.final[0]);
          byId.set(m.away.id, byId.get(m.away.id) + m.final[1]);
        }
        const want = t.teams.map(x => byId.get(x.id));
        if (JSON.stringify(want) !== JSON.stringify(t.aggregate)) {
          ok(false, `${s.label} ${r.zh}:總比分是兩回合相加、不含 PK`,
            `${JSON.stringify(t.aggregate)} vs ${JSON.stringify(want)}`);
        }
        // PK 分勝負的那幾組,總比分一定是平的
        if (t.decidedBy === 'penalties') {
          ok(t.aggregate[0] === t.aggregate[1],
            `${s.label} ${r.zh}:PK 分勝負的組別總比分是平的`, JSON.stringify(t.aggregate));
        }
      }
    }

    /* ── 三、晉級核對(這一層唯一的獨立驗證,鐵則五)──
       總比分算錯、PK 判錯、兩回合配錯,任何一種都會讓這條對不上。 */
    ok(s.advancementProblems.length === 0,
      `${s.label}:每一組的晉級者都真的出現在下一輪`, JSON.stringify(s.advancementProblems));

    // 兩回合配對:淘汰賽每一組剛好兩場,決賽一場
    for (const r of s.rounds) {
      const want = r.stage === 'FINAL' ? 1 : 2;
      const bad = r.ties.filter(t => t.legs.length !== want);
      ok(bad.length === 0, `${s.label} ${r.zh}:每一組 ${want} 場`,
        bad.map(t => t.teams.map(x => x.name).join(' vs ')).join('、'));
    }

    /* ── 四、積分榜 ───────────────────────────── */
    ok(s.table.order === 'official', `${s.label}:名次取自官方積分榜,不是本站排的`, s.table.order);
    ok(s.table.mismatches.length === 0,
      `${s.label}:本站依賽果算的積分與官方逐隊一致`, JSON.stringify(s.table.mismatches.slice(0, 3)));
    ok(s.table.rows.length === s.teams, `${s.label}:積分榜的隊數等於參賽隊數`, `${s.table.rows.length} vs ${s.teams}`);

    // 三段結局只有在淘汰賽名單實際出現後才知道；未開賽時不按規則硬猜。
    if (s.outcomesKnown) {
      ok(s.bandBroken === false, `${s.label}:直接晉級 / 附加賽 / 淘汰三段的名次連續`, JSON.stringify(s.bands));
      ok(s.bands.auto?.count + s.bands.playoff?.count + s.bands.out?.count === s.table.rows.length,
        `${s.label}:三段加起來剛好是全部球隊`);
    } else {
      ok(Object.values(s.bands).every(v => v === null), `${s.label}:淘汰賽名單未出現時不編造晉級區間`, JSON.stringify(s.bands));
      ok(s.table.rows.every(r => r.outcome === null), `${s.label}:淘汰賽名單未出現時不先判定球隊結局`);
    }

    // 沒見過的比分類別出現就要紅 —— 代表上游有我們沒核對過的東西
    ok(s.unknownDurations.length === 0, `${s.label}:沒有未核對的比分類別`, s.unknownDurations.join('、'));
    ok(completed ? s.champion !== null : s.champion === null, `${s.label}:冠軍狀態符合球季是否完賽`);
    if (s.played === 0) ok(s.runs.length === 0, `${s.label}:尚未開賽時不把任何球隊誤標成冠軍`);
  }

  /* ── 六、人工交付的 FotMob 檔 ──────────────────
     鐵則五:協作方自己回報「檢查全過」不算數,要拿獨立來源逐場核對。
     這裡的獨立來源是 football-data.org(完全不同的供應商)。 */
  for (const s2 of avail) {
    const cc = s2.crossCheck;
    if (!cc) { ok(false, `${s2.label}:應該要有第二來源核對結果`); continue; }
    ok(cc.teamsMatched === cc.teamsTotal, `${s2.label}:FotMob 的 36 隊全部對得上主來源`,
      `${cc.teamsMatched}/${cc.teamsTotal}`);
    const completed = s2.total > 0 && s2.played === s2.total;
    if (completed) {
      ok(cc.aligned === cc.total, `${s2.label}:${cc.total} 場的日期與主客全部對得上`, `${cc.aligned}/${cc.total}`);
      ok(cc.problemCount === 0, `${s2.label}:兩個來源的比分 0 場不一致`,
        cc.problems.slice(0, 3).map(p => p.text).join(' / '));
      ok(cc.passed, `${s2.label}:完賽球季的第二來源核對通過`);
    }
    // 核對沒過就不可以採用球員榜 —— 這條守的是「不要挑一個喜歡的答案」
    ok(cc.passed || !s2.leaders, `${s2.label}:核對沒過時不採用第二來源的球員榜`);
    if (s2.leaders) {
      ok(s2.leaders.length >= 4, `${s2.label}:球員榜有多個類別`, String(s2.leaders.length));
      ok(s2.leaders.every(b => b.rows.length && b.rows.every(r => Number.isFinite(r.value))),
        `${s2.label}:每一榜都有名次而且值是數字`);
      ok(s2.leaders.every(b => Number.isFinite(b.pool)), `${s2.label}:每一榜都標了母體人數(不是完整名單)`);
    }
  }

  /* 隊名橋兩個實際踩過的坑。
     一、PSV:football-data 那邊整個隊名就叫 "PSV",當停用詞會變成空 token。
     二、Inter / Brest:全名是 "FC Internazionale Milano" 與 "Stade Brestois 29",
        跟 FotMob 的簡稱一個共同 token 都沒有 —— 一定要連 shortName 一起比。 */
  {
    const nameTokens = uclNameTokens;
    ok(nameTokens('PSV').length > 0, '隊名橋:PSV 不會被正規化成空的');
    ok(nameTokens('PSV Eindhoven').some(t => nameTokens('PSV').includes(t)),
      '隊名橋:PSV 與 PSV Eindhoven 有共同 token');
    ok(nameTokens('Olympiacos').join() === nameTokens('Olympiakos').join(), '隊名橋:c/k 拼法一致');
    ok(nameTokens('Pafos FC').join() === nameTokens('Paphos FC').join(), '隊名橋:f/ph 拼法一致');
  }

  /* ── 七、只有抽籤的那一季 ─────────────────────
     **不可以顯示開球時間與輪次** —— 上游那 144 場全部是同一個佔位時間、
     輪次全是 null。把佔位時間端上畫面就是編數字(鐵則一)。 */
  const draw = (ucl.seasons ?? []).filter(x => x.availability === 'draw-only');
  for (const d of draw) {
    ok(d.singleSource === true, `${d.label}:標記成單一來源(沒有第二份可以核對)`);
    ok(d.draw?.check?.sane === true, `${d.label}:抽籤結構自洽`, JSON.stringify(d.draw?.check));
    ok(d.draw.check.homePerTeam.length === 1 && d.draw.check.awayPerTeam.length === 1
      && d.draw.check.homePerTeam[0] === d.draw.check.awayPerTeam[0],
      `${d.label}:每隊主客場次數一樣`, JSON.stringify(d.draw.check));
    ok(d.draw.check.repeatedPairs === 0, `${d.label}:沒有重複的對戰組合`);
    ok(d.draw.check.distinctOpponents.join() === d.draw.check.playedPerTeam.join(),
      `${d.label}:每個對手只碰一次`);
    const json = JSON.stringify(d.draw);
    ok(!/kickoff|utcDate|"date"/i.test(json), `${d.label}:抽籤資料裡沒有開球時間(上游只有佔位值)`);
    ok(!/roundName|matchday/i.test(json), `${d.label}:抽籤資料裡沒有輪次(上游全是 null)`);
    ok(d.played === 0 && !d.champion, `${d.label}:沒有比分也沒有冠軍`);
    ok(d.teamsKnown > 0, `${d.label}:本站認得的球隊有對到隊碼`, `${d.teamsKnown}/${d.teamsTotal}`);
  }

  /* ── 五、導覽列 ─────────────────────────────
     歐冠與足球知識都在 SITE_PAGES(跨聯賽那一組)。
     **兩份清單都放的話導覽列會出現兩個「歐冠」** —— 這個實際發生過。 */
  const core = readFileSync(join(W, 'assets', 'js', 'core.js'), 'utf8');
  const siteBlock = core.match(/const SITE_PAGES = \[([\s\S]*?)\];/)?.[1] ?? '';
  const pagesBlock = core.match(/const PAGES = \[([\s\S]*?)\];/)?.[1] ?? '';
  const stripComments = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* 2026-08-29:歐冠+足總盃+聯賽盃併成單一「盃賽」入口(使用者要求)。
     ucl.html 留轉址,SITE_PAGES 只掛 cups。 */
  ok(/'cups'/.test(siteBlock) && !/'ucl'/.test(stripComments(siteBlock)),
    '盃賽(含歐冠)在 SITE_PAGES,ucl 不再單獨掛');
  ok(!/'ucl'/.test(stripComments(pagesBlock)) && !/\['cups'/.test(stripComments(pagesBlock)),
    '歐冠與盃賽都不在 PAGES(兩邊都放會出現重複分頁)');
  ok(/es1[\s\S]{0,200}open: \[[^\]]*'cups'/.test(core), '西甲開放盃賽(預設分頁是歐冠)');
  ok(/page-ucl[\s\S]{0,400}location\.replace/.test(readFileSync(join(W, 'assets', 'js', 'page-ucl.js'), 'utf8').replace(/^/,'page-ucl ')),
    'ucl.html 保留為轉址(舊連結不斷)');

  const bundle = readFileSync(join(ROOT, 'scripts', 'bundle.mjs'), 'utf8');
  ok(/const PAGES = \[[^\]]*'ucl'/.test(bundle), '單檔版有收歐冠頁(漏了的話點進去是空白)');
  ok(existsSync(join(W, 'ucl.html')), 'ucl.html 存在');

  /* 盃賽對手的隊徽。**一支球隊只存一份,用 sourceId 查表。**
     第一版把 data URI 直接掛在每一個球隊格上,同一支球隊在一季裡出現很多次 ——
     487 個位置 × 8.8 KB,cups.json 從 741 KB 漲到 5.2 MB、
     單檔版從 16.9 MB 漲到 25.6 MB。同一張圖存了幾百遍,而畫面看不出差別。 */
  {
    const cupsPath = join(W, 'data', 'cups.json');
    if (existsSync(cupsPath)) {
      const cupsData = JSON.parse(readFileSync(cupsPath, 'utf8'));
      const lookup = cupsData.crests ?? {};
      ok(Object.keys(lookup).length > 0, '盃賽對手隊徽:有查表', String(Object.keys(lookup).length));
      ok(Object.values(lookup).every(v => /^data:image\/png;base64,/.test(v)),
        '盃賽對手隊徽:全部是內嵌的 PNG(CSP 會擋外部圖,熱連也等於每次開頁去要圖)');
      // 場次裡不可以再夾帶隊徽 —— 那就是把同一張圖存幾百遍
      let inline = 0;
      for (const c of cupsData.cups ?? []) for (const s2 of c.seasons ?? []) {
        for (const r of s2.rounds ?? []) for (const m of r.matches ?? []) {
          for (const side of ['home', 'away']) if (m[side]?.crest) inline++;
        }
      }
      ok(inline === 0, '盃賽對手隊徽:沒有掛在每一場上(同一張圖只存一份)', `${inline} 處`);
      // 有隊徽 ≠ 有身分:那些球隊仍然沒有隊碼
      const withCrestButCoded = Object.keys(lookup).length && (cupsData.cups ?? []).some(c =>
        (c.seasons ?? []).some(s2 => (s2.rounds ?? []).some(r => (r.matches ?? []).some(m =>
          ['home', 'away'].some(side => m[side]?.code && lookup[m[side]?.sourceId])))));
      ok(!withCrestButCoded, '盃賽對手隊徽:只補本站沒有的球隊,不覆蓋本站自己那份');
      const cupSrc3 = readFileSync(join(W, 'assets', 'js', 'page-cups.js'), 'utf8');
      ok(/CUP_CRESTS\[t\.sourceId\]/.test(cupSrc3), '盃賽頁:隊徽用 sourceId 查表');
      ok(!/t\.crest/.test(cupSrc3), '盃賽頁:不再讀每場夾帶的隊徽');
    }
  }

  /* 對手層級。**這一節守的是 CLAUDE.md 陷阱表那條在這裡的第二次出現。**

     第一版的隊名正規化把字首與字尾的 AFC/FC 都去掉,於是:
       AFC Liverpool(第九級)  → 對成 Liverpool FC   → 標成「英超」
       Bournemouth FC(第九級) → 對成 AFC Bournemouth → 標成「英超」
     兩支第九級的球隊被標成英超,而且畫面上看起來完全正常。
     **字尾的 FC/AFC 是法人形式,字首的 AFC 是球隊身分的一部分** —— 只能去字尾。 */
  {
    ok(tierKey('Barnsley') === tierKey('Barnsley FC'), '層級隊名:字尾 FC 去掉(同一支球隊)');
    ok(tierKey('Barrow') === tierKey('Barrow AFC'), '層級隊名:字尾 AFC 去掉(同一支球隊)');
    ok(tierKey('AFC Liverpool') !== tierKey('Liverpool FC'),
      '層級隊名:**字首的 AFC 不可以去掉**(AFC Liverpool 不是 Liverpool)');
    ok(tierKey('Bournemouth FC') !== tierKey('AFC Bournemouth'),
      '層級隊名:Bournemouth FC 不是 AFC Bournemouth');
    ok(tierKey('AFC Wimbledon') === tierKey('AFC Wimbledon'), '層級隊名:兩邊都有字首 AFC 時照樣對得上');

    const tierPath = join(ROOT, 'data', 'manual', 'team-tiers.json');
    if (existsSync(tierPath)) {
      const store = JSON.parse(readFileSync(tierPath, 'utf8'));
      ok(Object.keys(store.seasons ?? {}).length >= 2, '層級名單:至少兩季');
      ok(lookupTier(store, 'AFC Liverpool', '2025-26') === null,
        '層級名單:AFC Liverpool 查不到層級(它不是英超那支)');
      ok(lookupTier(store, 'Bournemouth FC', '2025-26') === null,
        '層級名單:Bournemouth FC 查不到層級');
      const pv = lookupTier(store, 'Port Vale', '2025-26');
      ok(pv?.zh === '英甲' && pv.exact === true, '層級名單:Port Vale 2025-26 是英甲(當季精確)', JSON.stringify(pv));
      const pv27 = lookupTier(store, 'Port Vale', '2026-27');
      ok(pv27?.exact === false, '層級名單:本季查不到就退回別季,而且標記成非當季', JSON.stringify(pv27));
    }

    const cupsPath2 = join(W, 'data', 'cups.json');
    if (existsSync(cupsPath2)) {
      const cd = JSON.parse(readFileSync(cupsPath2, 'utf8'));
      const KNOWN_TIERS = new Set(['英超', '英冠', '英甲', '英乙']);
      let tagged = 0, badTier = 0, codedWithTier = 0, staleNoSeason = 0;
      for (const c of cd.cups ?? []) for (const s2 of c.seasons ?? []) {
        for (const r of s2.rounds ?? []) for (const m of r.matches ?? []) {
          for (const side of ['home', 'away']) {
            const t = m[side];
            if (!t?.tier) continue;
            tagged++;
            if (!KNOWN_TIERS.has(t.tier)) badTier++;
            if (t.code) codedWithTier++;
            // 非當季的層級一定要帶賽季,不然就是拿別季的事實講這一季
            if (t.tierSeason && t.tierSeason === s2.label) staleNoSeason++;
          }
        }
      }
      ok(tagged > 0, '產物:盃賽對手有標層級', String(tagged));
      ok(badTier === 0, '產物:層級只有四種已知的說法', String(badTier));
      ok(codedWithTier === 0, '產物:本站認得的球隊不掛層級標籤(那一格用本站自己的身分)');
      ok(staleNoSeason === 0, '產物:tierSeason 只在「不是當季」時才出現');
      // AFC Liverpool 這種第九級球隊在產物裡一定沒有層級
      let trap = 0;
      for (const c of cd.cups ?? []) for (const s2 of c.seasons ?? []) {
        for (const r of s2.rounds ?? []) for (const m of r.matches ?? []) {
          for (const side of ['home', 'away']) {
            const t = m[side];
            if (['AFC Liverpool', 'Bournemouth FC'].includes(t?.name) && t?.tier) trap++;
          }
        }
      }
      ok(trap === 0, '產物:AFC Liverpool / Bournemouth FC 沒有被標成英超');
    }
  }

  /* 盃賽頁:預設顯示哪幾輪要走 visibleRounds(),不要再散在樣板裡。
     「本站球隊還沒進場」那一支只顯示最新一輪 —— 全攤開是幾百場資格賽。 */
  const cupSrc2 = readFileSync(join(W, 'assets', 'js', 'page-cups.js'), 'utf8');
  ok(/function visibleRounds\(/.test(cupSrc2), '盃賽頁:預設輪次由 visibleRounds() 決定');
  ok(/noKnownYet\) return season\.rounds\.slice\(-1\)/.test(cupSrc2),
    '盃賽頁:本站球隊還沒進場時只顯示最新一輪');
  ok(cupSrc2.includes('season.noKnownYet'), '盃賽頁:資格賽說明會分辨「還沒進場」與「前 N 輪」');
  return fail;
}

/* 租借紀錄:人工交付的東西一定要核對過才能發布(鐵則五)。

   2026-08-28 那一份交付的 2024-25 整批是偽造的 —— 把 2025-26 複製一份、年份 -1。
   Leeds United 2024-25 在英冠,而檔案裡有 6 筆「2024-25 英超 / 母隊 Leeds」。
   協作方不會回報這件事,畫面上也看起來完全正常,所以這幾條要釘死。 */
function checkLoans() {
  let fail = 0;
  const ok = (cond, label, extra = '') => {
    if (!cond) fail++;
    console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` (${extra})` : ''}`);
  };
  const vp = join(ROOT, 'data', 'loans-verified.json');
  if (!existsSync(vp)) {
    console.log('  · 沒有 data/loans-verified.json,跳過(執行 npm run loans:verify 產生)');
    return 0;
  }
  const v = JSON.parse(readFileSync(vp, 'utf8'));
  const inbox = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', 'loans.json'), 'utf8'));

  // 一、發布的只能是核對過的兩種等級
  ok(v.records.every(r => r.verdict === 'confirmed' || r.verdict === 'consistent'),
    '發布的紀錄只有 confirmed 與 consistent',
    [...new Set(v.records.map(r => r.verdict))].join('/'));

  // 二、被判定矛盾的絕對不可以出現在發布清單裡
  const rejectedKeys = new Set((v.rejected ?? []).filter(r => r.kind === 'data')
    .map(r => `${r.season}|${r.player}|${r.loanClub}`));
  ok(v.records.every(r => !rejectedKeys.has(`${r.season}|${r.player}|${r.loanClub}`)),
    '與獨立來源衝突而被退回的紀錄沒有混進發布清單', `退回中 data 類 ${rejectedKeys.size} 筆`);

  /* 三、2024-25 的處置。

     這一條改過一次:第一份交付的 2024-25 是偽造的(從 2025-26 複製、年份 -1),
     所以當時斷言「收件匣不可以有 2024-25」。2026-08-28 的重做版**重新抽取**了那一季,
     再用同一條擋就變成擋真資料了。

     所以現在守的不是「有沒有 2024-25」,而是**它有沒有那個偽造的特徵** ——
     年份平移的指紋(下面第五條在發布清單上守著),以及每一筆有沒有自己的來源。 */
  const withSource = inbox.records.filter(r => r.source);
  ok(withSource.length === inbox.records.length,
    '收件匣每一筆都帶自己的來源網址(交回來的東西要查得到出處)',
    `${withSource.length} / ${inbox.records.length}`);
  ok(!!(inbox._delivery || inbox._excluded?.reason),
    '收件匣寫明了這一份是什麼、前一版發生過什麼');

  // 四、年份平移的指紋不可以出現在發布清單裡(這正是偽造那批的特徵)
  const g = new Map();
  for (const r of v.records) {
    if (!r.date) continue;
    const k = `${r.player}|${r.parentClub}|${r.loanClub}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r.date);
  }
  let shifted = 0;
  for (const dates of g.values()) {
    for (let i = 0; i < dates.length; i++) {
      for (let j = i + 1; j < dates.length; j++) {
        if (dates[i].slice(5) === dates[j].slice(5)) shifted++;
      }
    }
  }
  ok(shifted === 0, '發布清單裡沒有「月日相同、只差年份」的複本', `${shifted} 組`);

  // 五、掛到球員身上的租借,等級要跟著走(畫面才分得出兩種)
  for (const [label, rel] of [['英超', join('web', 'data', 'players.json')],
    ['西甲', join('web', 'data', 'leagues', 'es1', 'players.json')]]) {
    const pf = join(ROOT, rel);
    if (!existsSync(pf)) continue;
    const players = JSON.parse(readFileSync(pf, 'utf8'));
    const list = (Array.isArray(players) ? players : Object.values(players)).flatMap(x => x.loans ?? []);
    ok(list.every(l => l.verdict === 'confirmed' || l.verdict === 'consistent'),
      `${label} 球員身上的租借都帶著核對等級`, `${list.length} 筆`);
  }

  // 六、核對結果要跟得上收件匣。對不上代表有人改了交付內容卻沒重跑核對 ——
  //     build 會拿舊的核對結果背書新的資料,而且不會有任何地方報錯。
  const inboxSha = createHash('sha256')
    .update(readFileSync(join(ROOT, 'data', 'manual', 'loans.json'))).digest('hex');
  ok(v.inboxSha === inboxSha, '核對結果是從目前這一版收件匣產生的',
    v.inboxSha ? `記錄 ${String(v.inboxSha).slice(0, 8)} vs 實際 ${inboxSha.slice(0, 8)}` : '產物沒有記錄雜湊');

  /* 七、核對器本身還有沒有在運作。

     原本這裡寫「一定要有退回紀錄,否則多半是它壞了」—— 那條是錯的:
     2026-08-28 的重做版交付通過了每一項檢查,退回 0 筆是資料乾淨,不是核對器壞掉。
     改成直接測那兩支純函式,而且測的正是**真的出過錯的那兩件事**。 */

  // 姓名比對曾經「姓氏唯一就回傳」,於是 Gustavo Nunes 比到 Matheus Nunes(2861 分鐘),
  // 核對器再拿那個分鐘去指控真紀錄是假的。名字首字母不同就不可以配對。
  /* **只能有一份比對實作。** 2026-08-28 這段程式在 verify-loans.mjs 與 lib/loans.mjs
     各有一份;我修好核對器那一份,另一份沒動 —— 於是實際掛到球員身上的那一步
     仍在對錯人,而且畫面上看不出來。實測 20 筆掛錯(Ben Nelson 的租借掛到
     Reiss Nelson、Gustavo Nunes 的掛到 Matheus Nunes)。這一條守住不准再複製回去。 */
  for (const f of ['lib/loans.mjs', 'verify-loans.mjs']) {
    const src = readFileSync(join(ROOT, 'scripts', f), 'utf8');
    ok(src.includes("from './names.mjs'") || src.includes("from './lib/names.mjs'"),
      `${f} 的姓名配對走共用的 lib/names.mjs`);
    ok(!/const\s+norm\s*=\s*s\s*=>\s*String\([\s\S]{0,80}normalize\('NFD'\)/.test(src),
      `${f} 沒有自己再寫一份姓名正規化`);
  }

  /* NFD 分解不掉的字母會被整個刪掉:Đorđe Petrović → "or e petrovic"。
     那比配不到更糟 —— 剩下的殘骸有機會撞到別人。 */
  ok(normName('Đorđe Petrović') === normName('Djordje Petrovic'),
    '姓名正規化:Đ 照通用音譯換成 Dj(交付檔寫 Djordje)',
    `${normName('Đorđe Petrović')} vs ${normName('Djordje Petrovic')}`);
  ok(nameMatchOne([{ n: 'Đorđe Petrović' }, { n: 'Nikola Milenković' }], 'Djordje Petrovic',
    { nameOf: x => x.n })?.n === 'Đorđe Petrović',
    '姓名配對:Đorđe Petrović 配得到交付檔的 Djordje Petrovic');
  ok(normName('Ø') === 'o' && normName('ß') === 'ss', '姓名正規化:Ø / ß 也處理');

  /* 同一個人在資料裡有多筆(西甲是一人一季一筆,966 筆裡 266 組是跨季重複)——
     不收成一個候選的話,exact 會配到兩筆然後判定不唯一,同一個人反而永遠配不上。 */
  const twoSeasons = [{ id: 7, n: 'Rafa Mir' }, { id: 7, n: 'Rafa Mir' }, { id: 9, n: 'Otro Jugador' }];
  ok(nameMatchOne(twoSeasons, 'Rafa Mir', { nameOf: x => x.n, idOf: x => x.id })?.id === 7,
    '姓名配對:同一個人的多筆紀錄收成一個候選,不會因為「不唯一」而放棄');

  const fpl = [{ n: 'Matheus Nunes' }, { n: 'Konstantinos Tsimikas' }, { n: 'Harry Wilson' }, { n: 'Ben Wilson' }];
  const nameOf = x => x.n;
  ok(loanMatchPerson(fpl, 'Gustavo Nunes', nameOf) === null,
    '姓名比對:姓氏相同但名字不同 → 不配對(Gustavo Nunes ≠ Matheus Nunes)');
  ok(loanMatchPerson(fpl, 'Kostas Tsimikas', nameOf)?.n === 'Konstantinos Tsimikas',
    '姓名比對:同姓且名字首字母相同且唯一 → 配得上(Kostas ↔ Konstantinos)');
  ok(loanMatchPerson(fpl, 'Wilson', nameOf) === null,
    '姓名比對:只有姓氏、對得到多個人 → 回 null 而不是猜一個');

  // 年份平移偵測:整批複製的指紋。2026-08-28 第一份交付有 14 組。
  const shiftedFixture = loanYearShifted([
    { player: 'A', parentClub: 'X', loanClub: 'Y', date: '2024-08-31' },
    { player: 'A', parentClub: 'X', loanClub: 'Y', date: '2025-08-31' },
    { player: 'B', parentClub: 'X', loanClub: 'Y', date: '2025-01-10' },
  ]);
  ok(shiftedFixture.size === 2, '年份平移偵測:月日相同、差整數年的兩筆會被標記', `標記 ${shiftedFixture.size} 筆`);
  return fail;
}

function checkCups() {
  let fail = 0;
  const ok = (cond, label, extra = '') => {
    if (!cond) fail++;
    console.log(`  ${cond ? '✔' : '✗'} ${label}${extra ? ` (${extra})` : ''}`);
  };

  /* 一、嚴格比對:AFC Liverpool 不可以對成 Liverpool。
     這不是假想 —— 上游真的兩支都有(id 8 與 id 19711),
     而寬鬆比對會把它們塌成同一支。 */
  const teams = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', 'teams.json'), 'utf8')).teams;
  const strict = buildCupTeamIndex(teams);
  ok(strict('Liverpool') === 'LIV', '嚴格比對:Liverpool → LIV');
  ok(strict('AFC Liverpool') === null, '嚴格比對:AFC Liverpool 不對應到任何隊', '第九級的另一支球隊');
  ok(strict('AFC Bournemouth') === 'BOU', '嚴格比對:AFC Bournemouth → BOU');
  ok(strict('Bournemouth FC') === null, '嚴格比對:Bournemouth FC 不對應到任何隊');
  ok(strict('  liverpool  ') === 'LIV', '嚴格比對仍然吃得下大小寫與前後空白');

  // 二、延長與 PK:一場 1-1 打到 PK 5-4 的比賽,三層比分都要留著
  const codeOf = strict;
  const shootout = normaliseCupFixture({
    id: 1, stage: { name: 'Final' }, starting_at: '2026-05-16 16:30:00',
    state: { state: 'FT_PEN' }, result_info: 'Home won after penalties.',
    participants: [
      { id: 8, name: 'Liverpool', meta: { location: 'home' } },
      { id: 52, name: 'AFC Bournemouth', meta: { location: 'away' } },
    ],
    scores: [
      { participant_id: 8, description: '1ST_HALF', score: { goals: 0 } },
      { participant_id: 52, description: '1ST_HALF', score: { goals: 1 } },
      { participant_id: 8, description: '2ND_HALF', score: { goals: 1 } },
      { participant_id: 52, description: '2ND_HALF', score: { goals: 1 } },
      { participant_id: 8, description: 'ET', score: { goals: 1 } },
      { participant_id: 52, description: 'ET', score: { goals: 1 } },
      { participant_id: 8, description: 'CURRENT', score: { goals: 1 } },
      { participant_id: 52, description: 'CURRENT', score: { goals: 1 } },
      { participant_id: 8, description: 'PENALTY_SHOOTOUT', score: { goals: 5 } },
      { participant_id: 52, description: 'PENALTY_SHOOTOUT', score: { goals: 4 } },
    ],
  }, { codeOf });
  ok(JSON.stringify(shootout.ht) === '[0,1]', 'PK 場:半場比分留著');
  ok(JSON.stringify(shootout.final) === '[1,1]', 'PK 場:最終比分是 1-1 而不是 5-4');
  ok(JSON.stringify(shootout.pens) === '[5,4]', 'PK 場:PK 比分獨立保留');
  ok(shootout.aet === true, 'PK 場:有 ET 比分 → 判定為延長賽');
  ok(shootout.ft90Suspect === false, 'PK 場:90 分比分沒有被誤判成不可信');
  ok(winnerOf(shootout) === 'home', 'PK 場:勝方由 PK 決定,不是由 1-1 決定');
  ok(shootout.home.code === 'LIV' && shootout.away.code === 'BOU', 'PK 場:兩隊都對得到隊碼');

  /* participant_id 對主客不能靠陣列順序 —— 這裡故意把客隊放前面 */
  const reversed = normaliseCupFixture({
    id: 2, stage: { name: 'Round 3' }, state: { state: 'FT' },
    participants: [
      { id: 52, name: 'AFC Bournemouth', meta: { location: 'away' } },
      { id: 8, name: 'Liverpool', meta: { location: 'home' } },
    ],
    scores: [
      { participant_id: 52, description: 'CURRENT', score: { goals: 0 } },
      { participant_id: 8, description: 'CURRENT', score: { goals: 3 } },
    ],
  }, { codeOf });
  ok(JSON.stringify(reversed.final) === '[3,0]', '主客由 meta.location 決定,不是陣列順序');

  // 三、未賽場次:不能被算成「踢了但沒贏」
  const pending = normaliseCupFixture({
    id: 3, stage: { name: 'Round 4' }, starting_at: '2026-09-08 00:00:00',
    state: { state: 'NS' },
    participants: [
      { id: 8, name: 'Liverpool', meta: { location: 'home' } },
      { id: 6, name: 'Tottenham Hotspur', meta: { location: 'away' } },
    ],
    scores: [],
  }, { codeOf });
  ok(pending.played === false, '未賽場次 played 為 false');
  ok(pending.final === null, '未賽場次沒有比分,不是 0-0');
  ok(pending.aet === null, '未賽場次的延長賽是 null(不知道),不是 false');

  /* 上游的 90 分比分會壞。實抓遇到 Port Vale 6-1 的 90 分配上 5-1 的最終比分 ——
     最終比分比 90 分還低,不可能。那場 state 是 FT(沒打延長),
     所以第一版「CURRENT ≠ 2ND_HALF 就是延長賽」的推導會**假陽性**。
     現在只認 ET 比分與 state=AET,壞掉的 90 分比分直接捨棄那一欄。 */
  const badNinety = normaliseCupFixture({
    id: 5, stage: { name: 'Round 1' }, state: { state: 'FT' },
    participants: [
      { id: 8, name: 'Liverpool', meta: { location: 'home' } },
      { id: 52, name: 'AFC Bournemouth', meta: { location: 'away' } },
    ],
    scores: [
      { participant_id: 8, description: '2ND_HALF', score: { goals: 6 } },
      { participant_id: 52, description: '2ND_HALF', score: { goals: 1 } },
      { participant_id: 8, description: 'CURRENT', score: { goals: 5 } },
      { participant_id: 52, description: 'CURRENT', score: { goals: 1 } },
    ],
  }, { codeOf });
  ok(badNinety.aet === false, '90 分比分壞掉 + state 是 FT → 不判成延長賽');
  ok(badNinety.ft90Suspect === true, '90 分比分對不上會被標成不可信');
  ok(badNinety.ft90 === null, '不可信的 90 分比分不輸出,畫面上不會顯示錯的數字');
  ok(JSON.stringify(badNinety.final) === '[5,1]', '最終比分不受影響');

  // state 是 AET 但上游沒給 ET 比分 → 仍然算延長賽(兩個訊號任一成立即可)
  const aetByState = normaliseCupFixture({
    id: 6, stage: { name: 'Round 4' }, state: { state: 'AET' },
    participants: [
      { id: 8, name: 'Liverpool', meta: { location: 'home' } },
      { id: 52, name: 'AFC Bournemouth', meta: { location: 'away' } },
    ],
    scores: [
      { participant_id: 8, description: 'CURRENT', score: { goals: 2 } },
      { participant_id: 52, description: 'CURRENT', score: { goals: 1 } },
    ],
  }, { codeOf });
  ok(aetByState.aet === true, 'state 是 AET → 判定為延長賽(即使沒有 ET 比分)');
  const runs = runsByTeam(groupByStage([reversed, pending]));
  const liv = runs.find(r => r.code === 'LIV');
  ok(liv.played === 1, '晉級表:已賽只算 1 場', `實際 ${liv.played}`);
  ok(liv.wins === 1, '晉級表:勝場 1');
  ok(liv.nextStage === 'Round 4', '晉級表:未賽的那場記成「下一場」而不是輸掉');
  ok(liv.out === null, '晉級表:沒有輸過就不標出局');
  const tot = runs.find(r => r.code === 'TOT');
  ok(tot?.played === 0 && tot?.nextStage === 'Round 4', '晉級表:只有未賽場次的球隊 played 是 0');

  // 輪次排序用開球時間,不是名稱對照表
  const rounds = groupByStage([
    { stage: 'Final', kickoff: '2026-05-16T16:30:00Z', played: true, final: [1, 0] },
    { stage: 'Round 1', kickoff: '2025-08-13T18:45:00Z', played: true, final: [2, 1] },
    { stage: 'Semi-finals', kickoff: '2026-04-26T17:15:00Z', played: true, final: [3, 0] },
  ]);
  ok(rounds.map(r => r.stage).join(' → ') === 'Round 1 → Semi-finals → Final',
    '輪次依開球時間排序', rounds.map(r => r.stage).join(' → '));

  // 冠軍:最後一輪只有一場而且分得出勝負才給
  const champ = championOf(groupByStage([shootout]));
  ok(champ?.team?.code === 'LIV', '冠軍由最後一輪的單場決定(且 PK 也算數)');
  const noChamp = championOf(groupByStage([
    { stage: 'Semi-finals', kickoff: '2026-04-26T17:15:00Z', played: true, final: [1, 1] },
    { stage: 'Semi-finals', kickoff: '2026-04-27T16:30:00Z', played: true, final: [2, 0] },
  ]));
  ok(noChamp === null, '最後一輪不只一場 → 不給冠軍');

  // 四、白名單:實抓才出現的 ET 系列必須在裡面,否則整批延長賽會被當成不明類別
  for (const d of ['CURRENT', '1ST_HALF', '2ND_HALF', 'PENALTY_SHOOTOUT', 'ET', 'ET_1ST_HALF', 'ET_2ND_HALF']) {
    ok(KNOWN_SCORE_DESCRIPTIONS.has(d), `比分類別白名單含 ${d}`);
  }
  for (const st of ['FT', 'FT_PEN', 'AET', 'CANCELLED', 'ABANDONED']) {
    ok(KNOWN_STATES.has(st), `狀態碼白名單含 ${st}`);
  }
  const weird = normaliseCupFixture({
    id: 4, stage: { name: 'Round 1' }, state: { state: 'SOMETHING_NEW' },
    participants: [
      { id: 8, name: 'Liverpool', meta: { location: 'home' } },
      { id: 52, name: 'AFC Bournemouth', meta: { location: 'away' } },
    ],
    scores: [
      { participant_id: 8, description: 'GOLDEN_GOAL', score: { goals: 1 } },
      { participant_id: 52, description: 'GOLDEN_GOAL', score: { goals: 0 } },
    ],
  }, { codeOf });
  ok(weird.unknownDescriptions.includes('GOLDEN_GOAL'), '沒見過的比分類別會被記錄下來');
  ok(weird.stateKnown === false, '沒見過的狀態碼會被標成未知');
  ok(weird.final === null, '沒見過的類別不給語意,不會被當成最終比分');

  // 產物:cups.json 若存在,逐項對回原始快取
  const cupsPath = join(ROOT, 'web', 'data', 'cups.json');
  if (!existsSync(cupsPath)) {
    console.log('  · 尚未產生 cups.json(需要 SPORTMONKS_TOKEN 跑 npm run encups),跳過產物檢查');
    return fail;
  }
  const cups = JSON.parse(readFileSync(cupsPath, 'utf8'));
  ok(cups.cups?.length >= 1, `產物:至少一個盃賽`, `${cups.cups?.length} 個`);
  for (const cup of cups.cups ?? []) {
    const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'sportmonks-cups', `${cup.key}.json`), 'utf8'));
    for (const season of cup.seasons ?? []) {
      const rawSeason = raw.seasons.find(s => s.label === season.label);
      const rounded = season.rounds.reduce((a, r) => a + r.total, 0);
      ok(rounded === rawSeason.matches.length,
        `產物:${cup.zh} ${season.label} 分輪之後場次沒有增減`,
        `${rounded} vs ${rawSeason.matches.length}`);
      ok(season.total === rawSeason.matches.length, `產物:${cup.zh} ${season.label} 總場次對得回原始快取`);
      /* 本站球隊還沒進場的賽季:整季都算資格賽,而且預設只顯示最新一輪。
         **findIndex 找不到回的是 -1 不是 0** —— 原本 `firstKnown > 0 ? … : 0`
         把 -1 當成 0,於是「整季都還沒有本站球隊」被當成「第一輪就有」,
         資格賽既不收起來也沒有說明,足總盃 2026-27 一進頁就是 533 場
         第九級的比賽攤在眼前。這幾條守著那個判斷。 */
      if (season.firstKnownRound < 0) {
        ok(season.noKnownYet === true, `產物:${cup.zh} ${season.label} 標記成「本站球隊還沒進場」`);
        ok(season.qualifyingRounds === season.rounds.length,
          `產物:${cup.zh} ${season.label} 整季都算資格賽`,
          `${season.qualifyingRounds} vs ${season.rounds.length}`);
        ok(season.qualifyingMatches === season.total,
          `產物:${cup.zh} ${season.label} 資格賽場次等於整季場次`);
      } else {
        ok(season.noKnownYet !== true, `產物:${cup.zh} ${season.label} 有本站球隊,不算「還沒進場」`);
      }

      // 沒見過的類別如果真的出現,這裡要紅 —— 代表上游有我們沒核對過的東西
      ok(!season.unknownDescriptions?.length,
        `產物:${cup.zh} ${season.label} 沒有未核對的比分類別`,
        (season.unknownDescriptions ?? []).join('、') || '無');
    }
  }
  return fail;
}

await main();
