#!/usr/bin/env node
// 走查回測(walk-forward):只用「比賽日之前」的資料建模,再預測該輪比賽。
// 用來驗證預測引擎沒有偷看未來,而且真的比亂猜好。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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
import { oddsIndex, devig, parseOddsCsv } from './lib/odds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_SEASON = '2025-26';
const TRAIN_FROM = ['2023-24', '2024-25'];

const outcome = m => (m.fh > m.fa ? 0 : m.fh === m.fa ? 1 : 2);
const logLoss = (p, o) => -Math.log(Math.max(1e-9, [p.home, p.draw, p.away][o]));
// Ranked Probability Score:足球預測的標準指標,越低越好
function rps(p, o) {
  const pv = [p.home, p.draw, p.away];
  const ov = [0, 0, 0]; ov[o] = 1;
  let cp = 0, co = 0, s = 0;
  for (let i = 0; i < 2; i++) { cp += pv[i]; co += ov[i]; s += (cp - co) ** 2; }
  return s / 2;
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

async function main() {
  const T = loadTeams(ROOT);
  const load = season => loadMatches({ root: ROOT, competition: COMPETITION, season, codeOf: T.codeOf });
  const past = TRAIN_FROM.flatMap(load);
  const test = load(TEST_SEASON).filter(m => m.played);
  const codes = [...new Set(test.flatMap(m => [m.home, m.away]))].sort();
  const rounds = [...new Set(test.map(m => m.round))].sort((a, b) => a - b);

  const dc = [], el = [], base = [], blend = [];
  const perMatch = [];   // 每一場的走查預測,build 會拿去做「預測 vs 實際」對照
  // 賽季基準線:英超長期的主/和/客分佈
  const BASE = { home: 0.44, draw: 0.25, away: 0.31 };

  // 市場基準:讀當季的博彩收盤賠率(去水錢後的隱含機率)。
  // 有就在同一批比賽上比「模型 vs 市場」;沒有(檔案不存在)這一段就整個略過。
  let oddsBy = new Map();
  const srcCount = new Map();
  try {
    const csv = readFileSync(join(ROOT, 'data', 'raw', 'football-data-couk', `${TEST_SEASON}.csv`), 'utf8');
    const ix = oddsIndex(csv, { codeOf: T.codeOf });
    oddsBy = ix.byMatch;
    console.log(`  市場基準:讀到 ${oddsBy.size} 場賠率(${TEST_SEASON})`);
  } catch { /* 沒有賠率檔就不比市場 */ }
  const mkt = [], blendMkt = [];   // 只含「有賠率」那批;兩者比較才公平
  const perMkt = [];               // 逐輪對照要用

  for (const rd of rounds) {
    const games = test.filter(m => m.round === rd);
    const before = [...past, ...test.filter(m => m.round < rd)];
    if (before.length < 100) continue;
    const refDate = games[0].date;
    const model = applyPromotedPrior(fitPoisson(before, codes, { refDate, iters: 1200 }));
    const elo = buildElo(before);
    for (const m of games) {
      const o = outcome(m);
      const p = predict(model, m.home, m.away);
      const e = eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500);
      const b = {
        home: (p.home + e.home) / 2, draw: (p.draw + e.draw) / 2, away: (p.away + e.away) / 2,
      };
      const push = (arr, pr) => arr.push({
        rps: rps(pr, o), ll: logLoss(pr, o),
        hit: [pr.home, pr.draw, pr.away].indexOf(Math.max(pr.home, pr.draw, pr.away)) === o,
      });
      push(dc, p); push(el, e); push(base, BASE); push(blend, b);

      // 這場有市場賠率的話,把市場機率與模型預測都記進「重疊集」——
      // 必須是同一批比賽,不然拿模型的全季去比市場的半季不公平
      const mk = oddsBy.get(`${m.home}|${m.away}`);
      if (mk) {
        push(mkt, mk.probs); push(blendMkt, b);
        srcCount.set(mk.source, (srcCount.get(mk.source) ?? 0) + 1);
        perMkt.push({ round: rd, model: rps(b, o), market: rps(mk.probs, o) });
      }

      perMatch.push({
        season: m.season, date: m.date, home: m.home, away: m.away, round: m.round,
        fh: m.fh, fa: m.fa,
        pred: {
          home: round(b.home, 4), draw: round(b.draw, 4), away: round(b.away, 4),
          xgHome: p.xgHome, xgAway: p.xgAway,
          topScores: p.topScores.slice(0, 3),
          over25: p.over25, btts: p.btts,
        },
      });
    }
  }

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
  // ── 校準:模型說 70% 會贏的比賽,實際是不是真的贏了 70% ──────────
  // 每場比賽貢獻三個點(主勝/和/客勝各一),這是多類別校準的標準做法。
  function calibration(bins = 10) {
    const pts = [];
    for (const m of perMatch) {
      const real = m.fh > m.fa ? 'home' : m.fh === m.fa ? 'draw' : 'away';
      for (const o of ['home', 'draw', 'away']) pts.push({ p: m.pred[o], hit: real === o ? 1 : 0 });
    }
    const out = [];
    for (let i = 0; i < bins; i++) {
      const lo = i / bins, hi = (i + 1) / bins;
      const inBin = pts.filter(r => r.p >= lo && (i === bins - 1 ? r.p <= hi : r.p < hi));
      out.push({
        lo: round(lo, 2), hi: round(hi, 2), n: inBin.length,
        predicted: inBin.length ? round(inBin.reduce((a, r) => a + r.p, 0) / inBin.length, 4) : null,
        actual: inBin.length ? round(inBin.reduce((a, r) => a + r.hit, 0) / inBin.length, 4) : null,
      });
    }
    return out;
  }

  // ── 逐輪表現:模型隨著資料變多有沒有變準 ──────────
  function byRound() {
    const g = new Map();
    for (let i = 0; i < perMatch.length; i++) {
      const r = perMatch[i].round;
      if (!g.has(r)) g.set(r, []);
      g.get(r).push(blend[i]);
    }
    return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([r, rows]) => ({
      round: r, games: rows.length,
      rps: round(rows.reduce((a, x) => a + x.rps, 0) / rows.length, 4),
      hitRate: round(rows.filter(x => x.hit).length / rows.length, 3),
    }));
  }

  // ── 最意外的比賽:模型給實際結果的機率最低的那幾場 ──────────
  function surprises(n = 8) {
    return perMatch.map(m => {
      const real = m.fh > m.fa ? 'home' : m.fh === m.fa ? 'draw' : 'away';
      return { ...m, real, pReal: m.pred[real] };
    }).sort((a, b) => a.pReal - b.pReal).slice(0, n)
      .map(m => ({ date: m.date, round: m.round, home: m.home, away: m.away, fh: m.fh, fa: m.fa,
        real: m.real, pReal: round(m.pReal, 4), pred: m.pred }));
  }

  // 把結果寫成檔案,build 會讀進去顯示在頁面上 —— 頁面上的準度數字必須是真的跑出來的
  const metric = rows => ({
    rps: round(rows.reduce((a, r) => a + r.rps, 0) / rows.length, 4),
    logLoss: round(rows.reduce((a, r) => a + r.ll, 0) / rows.length, 4),
    hitRate: round(rows.filter(r => r.hit).length / rows.length, 4),
  });
  const report = {
    ranAt: new Date().toISOString(),
    season: TEST_SEASON,
    games: dc.length,
    models: { poisson: metric(dc), elo: metric(el), blend: metric(blend), baseline: metric(base) },
    chosen: 'blend',
    calibration: calibration(),
    byRound: byRound(),
    surprises: surprises(),
    baselineProbs: BASE,
    // 模型 vs 市場:同一批有賠率的比賽上,模型與博彩收盤各自的表現
    market: mkt.length ? {
      available: true,
      games: mkt.length,
      source: [...srcCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      model: metric(blendMkt),
      market: metric(mkt),
      byRound: (() => {
        const g = new Map();
        for (const r of perMkt) {
          if (!g.has(r.round)) g.set(r.round, []);
          g.get(r.round).push(r);
        }
        return [...g.entries()].sort((a, b) => a[0] - b[0]).map(([rd, rows]) => ({
          round: rd, games: rows.length,
          modelRps: round(rows.reduce((a, x) => a + x.model, 0) / rows.length, 4),
          marketRps: round(rows.reduce((a, x) => a + x.market, 0) / rows.length, 4),
        }));
      })(),
    } : { available: false },
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

  // 官方名單對照:配錯人比對不上更糟 —— 對不上只是少張頭貼,配錯是把數據掛到別人身上
  console.log('\n▶ 官方名單球員對照自我檢查');
  const nameFail = checkOfficialNames();

  // 市場基準去水錢:算錯的話整段「模型 vs 市場」都是騙人的
  console.log('\n▶ 賠率去水錢自我檢查');
  const oddsFail = checkOdds();

  const better = report.models.blend.rps < report.models.baseline.rps;
  console.log(better ? '\n✔ 預測引擎優於基準線' : '\n✗ 預測引擎未勝過基準線,請檢查參數');
  if (!better || inplayFail || reportFail || nameFail || oddsFail) process.exitCode = 1;
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
