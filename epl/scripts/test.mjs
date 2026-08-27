#!/usr/bin/env node
// 走查回測(walk-forward):只用「比賽日之前」的資料建模,再預測該輪比賽。
// 用來驗證預測引擎沒有偷看未來,而且真的比亂猜好。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { loadTeams } from './lib/teams.mjs';
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
import { goalsOf, minuteOf } from './fetch-official.mjs';
import { loadGoals, reconcile } from './lib/adapters/fpl-goals.mjs';
import { GOAL_SEASONS, LAST_SEASON } from './lib/sources.mjs';
import { teamGoals } from './lib/goals.mjs';
// 走查回測的實作抽到 lib,英超與西甲跑同一份 —— 複製一份會讓兩個聯賽的數字慢慢不能比
import { walkForward, rps, outcome, logLoss, pairedDiff } from './lib/backtest.mjs';
import { shirtsFromOfficial, shirtsFromManual, backfillSquadNumbers } from './lib/squadnumbers.mjs';
import { numberProfile, traditionVsData, formationUsage, formationFromLineups } from './lib/knowledge.mjs';
import { teamRecord } from './lib/table.mjs';
import { loadExpertOpinions, validateExpertOpinions } from './lib/experts.mjs';
import { normaliseMatchDetail } from './lib/adapters/api-football.mjs';

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

  const better = report.models.blend.rps < report.models.baseline.rps;
  console.log(better ? '\n✔ 預測引擎優於基準線' : '\n✗ 預測引擎未勝過基準線,請檢查參數');
  if (!better || inplayFail || reportFail || expertFail || apiFootballFail || nameFail || oddsFail || colourFail || formFail || availFail || barFail || teamFail || gapFail || goalFail || kindFail || detailFail || situationFail || nullFail || shirtFail || btFail || knFail) process.exitCode = 1;
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
      for (const m of fixtures.filter(m => m.season === season)) {
        bump(m.home, m.fh, m.fa); bump(m.away, m.fa, m.fh);
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
      cases.push([`${label} ${season} 逐隊進失球對回賽果(${acc.size} 隊)`,
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
    ['進球當下比分有帶出來', g[0].hs === 0 && g[0].as === 1, `${g[0].hs}-${g[0].as}`],
    ['沒有 events 也不會炸', goalsOf(undefined).length === 0, ''],
    ['沒有比分的事件不會被誤判成進球',
      goalsOf([{ type: 'G', personId: 1 }]).length === 0, ''],
  ];
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
    const live = Object.values(JSON.parse(readFileSync(store, 'utf8')).matches ?? {})
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

await main();
