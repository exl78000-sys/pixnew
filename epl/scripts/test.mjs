#!/usr/bin/env node
// 走查回測(walk-forward):只用「比賽日之前」的資料建模,再預測該輪比賽。
// 用來驗證預測引擎沒有偷看未來,而且真的比亂猜好。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadTeams } from './lib/teams.mjs';
import { loadSeason } from './lib/matches.mjs';
import { fitPoisson, applyPromotedPrior, predict } from './lib/poisson.mjs';
import { buildElo, eloProbs } from './lib/elo.mjs';
import { round } from './lib/util.mjs';
import { inPlay } from './lib/inplay.mjs';

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

function main() {
  const T = loadTeams(ROOT);
  const past = TRAIN_FROM.flatMap(s => loadSeason(ROOT, s, T.codeOf));
  const test = loadSeason(ROOT, TEST_SEASON, T.codeOf).filter(m => m.played);
  const codes = [...new Set(test.flatMap(m => [m.home, m.away]))].sort();
  const rounds = [...new Set(test.map(m => m.round))].sort((a, b) => a - b);

  const dc = [], el = [], base = [], blend = [];
  // 賽季基準線:英超長期的主/和/客分佈
  const BASE = { home: 0.44, draw: 0.25, away: 0.31 };

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
    }
  }

  console.log(`\n▶ 走查回測 ${TEST_SEASON}(訓練資料只到每輪開賽前)\n`);
  console.table([
    summarise('Dixon-Coles Poisson', dc),
    summarise('Elo', el),
    summarise('兩者平均', blend),
    summarise('基準線(固定機率)', base),
  ]);
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
  };
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'backtest.json'), JSON.stringify(report, null, 2));
  console.log('→ 已寫入 data/backtest.json(build 時會帶進網站)');

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

  const better = report.models.blend.rps < report.models.baseline.rps;
  console.log(better ? '\n✔ 預測引擎優於基準線' : '\n✗ 預測引擎未勝過基準線,請檢查參數');
  if (!better || inplayFail) process.exitCode = 1;
}

main();
