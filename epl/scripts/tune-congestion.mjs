#!/usr/bin/env node
// 賽程密度係數的調參與驗證。
//
//   node scripts/tune-congestion.mjs
//   node scripts/tune-congestion.mjs --league=es1
//
// 假說:休息天數少的球隊表現較差 —— 疲勞、輪換、傷兵累積。
// 這是最常被拿來解釋比賽結果的因素之一,而且**不需要任何新資料**:
// 從賽程表的日期就算得出來。
//
// ⚠ **這個特徵有一個先天的量測缺陷,結論一定要連著它一起讀**:
// 我們的賽程只有聯賽。歐冠、歐霸、足總盃、聯賽盃**都不在裡面** ——
// 而那才是賽程密度的主要來源。所以這裡算出來的「休息天數」對
// 有打歐戰的球隊是**系統性高估**(它們實際上更累)。
// 也就是說:如果測出來沒用,不能斷言「賽程密度沒有影響」,
// 只能說「用聯賽日期算出來的密度沒有預測力」。這兩句話差很多。
//
// 協議跟 tune-form.mjs / tune-situations.mjs 一樣:
//   調參賽季挑係數 → 驗收賽季只跑一次 → 改善要大過成對標準誤才算數。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMatches } from './lib/adapters/index.mjs';
import { loadTeams } from './lib/teams.mjs';
import { COMPETITION } from './lib/sources.mjs';
import { fitPoisson, applyPromotedPrior, lambdas, outcomeProbs } from './lib/poisson.mjs';
import { buildElo, eloProbs } from './lib/elo.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const LEAGUE = arg('league') || 'pl';

const PROFILES = {
  pl: {
    label: '英超', competition: COMPETITION, teamFile: 'teams.json',
    tune: { season: '2024-25', train: ['2023-24'] },
    holdout: { season: '2025-26', train: ['2023-24', '2024-25'] },
  },
  es1: {
    label: '西甲', competition: 'esp.1', teamFile: 'teams-la-liga.json',
    tune: { season: '2024-25', train: [] },
    holdout: { season: '2025-26', train: ['2024-25'] },
  },
};
const P = PROFILES[LEAGUE];
if (!P) throw new Error(`不支援的聯賽 --league=${LEAGUE}`);

/* 一週(7 天)當基準。取對數比,跟 λ 的 exp() 對上 ——
   係數乘上去等於「比一般一週多休幾成」,而不是「多休幾天」。
   上限壓在 14 天:休 14 天跟休 29 天對疲勞的意義差不多,
   不壓的話國際賽週那種長間隔會把整個尺度拉歪。 */
const NORMAL_REST = 7;
const REST_CAP = 14;
const restIndex = days => Math.log(Math.min(days, REST_CAP) / NORMAL_REST);

const outcome = m => (m.fh > m.fa ? 0 : m.fh === m.fa ? 1 : 2);
const logLoss = (p, o) => -Math.log(Math.max(1e-9, [p.home, p.draw, p.away][o]));
function rps(p, o) {
  const pv = [p.home, p.draw, p.away];
  const ov = [0, 0, 0]; ov[o] = 1;
  let cp = 0, co = 0, s = 0;
  for (let i = 0; i < 2; i++) { cp += pv[i]; co += ov[i]; s += (cp - co) ** 2; }
  return s / 2;
}

/* 休息天數要從**這一場之前**的比賽算,而且要涵蓋上一季的尾巴 ——
   開季第一場的「上一場」在上個賽季,不然整個第一輪都會是 null。 */
function restLookup(allMatches) {
  const byTeam = new Map();
  for (const m of allMatches) {
    for (const c of [m.home, m.away]) {
      if (!byTeam.has(c)) byTeam.set(c, []);
      byTeam.get(c).push(m.date);
    }
  }
  for (const list of byTeam.values()) list.sort();
  return (code, date) => {
    const list = byTeam.get(code);
    if (!list) return null;
    let prev = null;
    for (const d of list) { if (d >= date) break; prev = d; }
    if (!prev) return null;
    const days = Math.round((new Date(date) - new Date(prev)) / 86400000);
    return days > 0 ? days : null;
  };
}

function collect({ season, train }, T) {
  const load = s => loadMatches({ root: ROOT, competition: P.competition, season: s, codeOf: T.codeOf });
  const past = train.flatMap(load);
  const test = load(season).filter(m => m.played);
  if (!test.length) return { rows: [], missingSeason: season };
  const restOf = restLookup([...past, ...test]);
  const codes = [...new Set(test.flatMap(m => [m.home, m.away]))].sort();
  const rounds = [...new Set(test.map(m => m.round))].sort((a, b) => a - b);

  const rows = [];
  let noRest = 0;
  const restDays = [];
  for (const rd of rounds) {
    const games = test.filter(m => m.round === rd);
    const before = [...past, ...test.filter(m => m.round < rd)];
    if (before.length < 100) continue;
    const refDate = games[0].date;
    const model = applyPromotedPrior(fitPoisson(before, codes, { refDate, iters: 1200 }));
    const elo = buildElo(before);
    for (const m of games) {
      const { lh, la } = lambdas(model, m.home, m.away);
      const rh = restOf(m.home, m.date), ra = restOf(m.away, m.date);
      // 算不出休息天數(球隊在這個資料集裡的第一場)→ 特徵給 0,不猜。
      if (rh == null || ra == null) noRest++;
      if (rh != null) restDays.push(rh);
      rows.push({
        round: rd, lh, la, rho: model.rho,
        elo: eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500),
        o: outcome(m),
        f: { h: rh == null ? 0 : restIndex(rh), a: ra == null ? 0 : restIndex(ra) },
      });
    }
  }
  restDays.sort((a, b) => a - b);
  return {
    rows, noRest,
    restMedian: restDays[Math.floor(restDays.length / 2)] ?? null,
    shortRestPct: restDays.length
      ? round((restDays.filter(d => d <= 4).length / restDays.length) * 100, 1) : null,
  };
}

/* 自己休得多 → 自己的 λ 調高(bRest 應該是正的);
   對手休得多 → 對手守得好,自己的 λ 調低(bOpp 應該是負的)。
   兩個都讓網格自己找,不預設方向 —— 方向對不對本身就是證據。 */
function adjust({ lh, la }, f, { bRest = 0, bOpp = 0 }) {
  return {
    lh: lh * Math.exp(bRest * f.h + bOpp * f.a),
    la: la * Math.exp(bRest * f.a + bOpp * f.h),
  };
}

function score(rows, coef) {
  const per = [];
  let ll = 0, hit = 0;
  for (const r of rows) {
    const { lh, la } = adjust({ lh: r.lh, la: r.la }, r.f, coef);
    const p = outcomeProbs(lh, la, r.rho);
    const b = {
      home: (p.home + r.elo.home) / 2,
      draw: (p.draw + r.elo.draw) / 2,
      away: (p.away + r.elo.away) / 2,
    };
    per.push(rps(b, r.o));
    ll += logLoss(b, r.o);
    if ([b.home, b.draw, b.away].indexOf(Math.max(b.home, b.draw, b.away)) === r.o) hit++;
  }
  const n = rows.length;
  return { per, rps: per.reduce((a, x) => a + x, 0) / n, logLoss: ll / n, hitRate: hit / n, n };
}

function paired(aPer, bPer, iters = 4000) {
  const n = aPer.length;
  const d = aPer.map((x, i) => x - bPer[i]);
  const mean = d.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  let opposite = 0;
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[(Math.random() * n) | 0];
    if ((s / n) * Math.sign(mean) <= 0) opposite++;
  }
  return { mean, se, p: opposite / iters };
}

async function main() {
  const T = loadTeams(ROOT, { file: P.teamFile });
  console.log(`\n▶ 賽程密度特徵:調參與驗收(${P.label})`);
  console.log('  ⚠ 只有聯賽日期:歐冠、歐霸與盃賽都不在資料裡,');
  console.log('     所以有打歐戰的球隊,它們的「休息天數」是系統性高估的。');

  const tune = collect(P.tune, T);
  const hold = collect(P.holdout, T);
  for (const [name, r] of [['調參', tune], ['驗收', hold]]) {
    if (r.missingSeason) {
      console.log(`\n✗ ${name}賽季 ${r.missingSeason} 沒有賽果資料,跑不了。`);
      process.exitCode = 1; return;
    }
  }
  console.log(`  調參 ${P.tune.season}:${tune.rows.length} 場・休息中位數 ${tune.restMedian} 天・` +
    `≤4 天 ${tune.shortRestPct}%・算不出天數 ${tune.noRest} 場`);
  console.log(`  驗收 ${P.holdout.season}:${hold.rows.length} 場・休息中位數 ${hold.restMedian} 天・` +
    `≤4 天 ${hold.shortRestPct}%・算不出天數 ${hold.noRest} 場`);

  const t0 = score(tune.rows, {});
  const grid = [];
  for (let bRest = -0.30; bRest <= 0.301; bRest += 0.05) {
    for (let bOpp = -0.30; bOpp <= 0.301; bOpp += 0.05) {
      const c = { bRest: round(bRest, 3), bOpp: round(bOpp, 3) };
      grid.push({ c, s: score(tune.rows, c) });
    }
  }
  grid.sort((a, b) => a.s.rps - b.s.rps);
  const best = grid[0];
  console.log(`\n  調參賽季基準 RPS ${round(t0.rps, 5)};最佳 ${round(best.s.rps, 5)} ` +
    `(bRest=${best.c.bRest} bOpp=${best.c.bOpp})`);

  const bestOnly = key => {
    const sub = grid.filter(g => (key === 'bRest' ? g.c.bOpp === 0 : g.c.bRest === 0));
    sub.sort((a, b) => a.s.rps - b.s.rps);
    return sub[0];
  };

  const h0 = score(hold.rows, {});
  const trials = [['最佳組合', best.c]];
  for (const key of ['bRest', 'bOpp']) {
    const b = bestOnly(key);
    if (b && (b.c.bRest || b.c.bOpp)) trials.push([`只開 ${key}`, b.c]);
  }

  const rowsOut = trials.map(([name, c]) => {
    const s = score(hold.rows, c);
    const cmp = paired(h0.per, s.per);
    return {
      係數: name, bRest: c.bRest ?? 0, bOpp: c.bOpp ?? 0,
      RPS: round(s.rps, 5),
      對基準: round(s.rps - h0.rps, 5),
      '±標準誤': round(cmp.se, 5),
      'bootstrap p': round(cmp.p, 3),
      命中率: `${round(s.hitRate * 100, 1)}%`,
    };
  });

  console.log(`\n  驗收賽季 ${P.holdout.season}:基準 RPS ${round(h0.rps, 5)}\n`);
  console.table([
    { 係數: '基準(不調整)', bRest: 0, bOpp: 0, RPS: round(h0.rps, 5), 對基準: 0, '±標準誤': null, 'bootstrap p': null, 命中率: `${round(h0.hitRate * 100, 1)}%` },
    ...rowsOut,
  ]);

  const passed = rowsOut.filter(r => r.對基準 < 0 && Math.abs(r.對基準) > r['±標準誤']);
  console.log(passed.length
    ? `\n判定:有 ${passed.length} 組在驗收賽季上改善且超過一個標準誤 —— 值得進模型。`
    : '\n判定:沒有一組通過。改善(如果有)都在雜訊範圍內,係數維持 0。');
  console.log('  注意措辭:沒通過只代表「用聯賽日期算出來的密度沒有預測力」,');
  console.log('  不代表「賽程密度對比賽沒有影響」—— 歐戰與盃賽根本不在這份資料裡。');

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const out = join(ROOT, 'data', LEAGUE === 'pl' ? 'congestion-tuning.json' : `congestion-tuning-${LEAGUE}.json`);
  writeFileSync(out, JSON.stringify({
    ranAt: new Date().toISOString(),
    league: LEAGUE, leagueLabel: P.label,
    hypothesis: '休息天數少的球隊表現較差(疲勞、輪換、傷兵累積)。',
    limitation: '賽程只有聯賽:歐冠、歐霸與盃賽都不在資料裡,所以有打歐戰的球隊休息天數是系統性高估。'
      + '沒通過只代表「用聯賽日期算出來的密度沒有預測力」,不代表賽程密度沒有影響。',
    normalRest: NORMAL_REST, restCap: REST_CAP,
    tuneSeason: P.tune.season, tuneGames: tune.rows.length,
    holdoutSeason: P.holdout.season, holdoutGames: hold.rows.length,
    restProfile: {
      tune: { median: tune.restMedian, shortRestPct: tune.shortRestPct, unknown: tune.noRest },
      holdout: { median: hold.restMedian, shortRestPct: hold.shortRestPct, unknown: hold.noRest },
    },
    tuneBaselineRps: round(t0.rps, 5),
    tuneBest: { coef: best.c, rps: round(best.s.rps, 5) },
    holdout: { baselineRps: round(h0.rps, 5), baselineHitRate: round(h0.hitRate, 4), trials: rowsOut },
    accepted: passed.length ? passed[0] : null,
  }, null, 2) + '\n');
  console.log(`→ 已寫入 ${out.replace(ROOT + '/', '')}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
