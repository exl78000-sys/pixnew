#!/usr/bin/env node
/* 事件模擬引擎的真實資料校驗(設計文檔路徑第 6 步)。
 *
 * test.mjs 裡的 checkMatchSim() 是**護欄**:守住 Σxg==λ、決定性,以及場均
 * 落在一個寬鬆區間。那種檢查抓得到「改壞了」,抓不到「慢慢漂掉」。
 *
 * 這一支是**對帳**:拿三個賽季 1140 場英超的真實逐場數據,跟模擬產出的
 * 同樣指標逐項比對。重點不只在平均值 —— 平均對了但分布太窄,代表引擎
 * 產出的每一場都長得差不多,那樣的時間軸讀起來會很假。所以標準差一起看。
 *
 * 用法:npm run sim:check
 *
 * ── 這份校驗不能證明什麼(先講清楚)────────────────
 *
 * 1. λ 是**同期內擬合**的,不是走查。這裡驗的是「給定一個合理的 λ,事件引擎
 *    產生的過程像不像真的比賽」,不是「λ 準不準」—— 後者是 test.mjs 的走查回測
 *    在管的,兩件事不要混。
 * 2. 陣容一律用**本季**的先發推估。舊賽季的實際陣容我們沒有,所以「誰射門」
 *    這一項歷史上無法驗證,只能驗「射幾次」。
 * 3. 真實資料沒有控球率,那一項無從對帳。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { parseCSVObjects } from './lib/csv.mjs';
import { FD_NAMES } from './lib/odds.mjs';
import { fitPoisson, applyPromotedPrior, lambdas } from './lib/poisson.mjs';
import { simulateMatch } from './lib/matchsim.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEASONS = ['2023-24', '2024-25', '2025-26'];

// dd/mm/yy → yyyy-mm-dd
const isoDate = s => {
  const [d, m, y] = String(s).split('/');
  if (!d || !m || !y) return null;
  return `20${y.slice(-2)}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function loadSeason(season) {
  const path = join(ROOT, 'data', 'raw', 'football-data-couk', `${season}.csv`);
  if (!existsSync(path)) return [];
  return parseCSVObjects(readFileSync(path, 'utf8'))
    .map(r => {
      const home = FD_NAMES[r.HomeTeam], away = FD_NAMES[r.AwayTeam];
      const fh = num(r.FTHG), fa = num(r.FTAG);
      if (!home || !away || fh === null || fa === null) return null;
      return {
        season, date: isoDate(r.Date), home, away, fh, fa, played: true,
        // 每隊各一份的逐場數據
        stat: {
          home: { shots: num(r.HS), onTarget: num(r.HST), corners: num(r.HC), fouls: num(r.HF), yellow: num(r.HY), goals: fh },
          away: { shots: num(r.AS), onTarget: num(r.AST), corners: num(r.AC), fouls: num(r.AF), yellow: num(r.AY), goals: fa },
        },
      };
    })
    .filter(m => m && Object.values(m.stat).every(s => Object.values(s).every(v => v !== null)));
}

// ── 敘述統計 ────────────────────────────────
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
// Pearson 相關
const corr = (a, b) => {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};

const KEYS = ['shots', 'onTarget', 'corners', 'fouls', 'yellow', 'goals'];
const ZH = { shots: '射門', onTarget: '射正', corners: '角球', fouls: '犯規', yellow: '黃牌', goals: '進球' };

const collect = rows => Object.fromEntries(KEYS.map(k => [k, rows.map(r => r[k])]));

async function main() {
  console.log('▶ 事件模擬引擎 vs 真實英超逐場數據\n');

  const real = SEASONS.flatMap(loadSeason);
  if (!real.length) { console.log('✗ 找不到 football-data.co.uk 的 CSV,無法校驗'); process.exit(1); }
  console.log(`  真實資料:${real.length} 場(${SEASONS.join('、')})`);

  const lineups = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'lineups.json'), 'utf8'));
  const players = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'players.json'), 'utf8'));

  /* λ 由各賽季自己擬合(同期內)。理由見檔頭:這裡驗的是事件過程,
     不是預測準度,所以不需要走查 —— 需要的只是一組「像真的」的 λ。 */
  const byLambda = new Map();
  for (const season of SEASONS) {
    const games = real.filter(m => m.season === season);
    if (!games.length) continue;
    const codes = [...new Set(games.flatMap(m => [m.home, m.away]))].sort();
    const refDate = games.map(m => m.date).filter(Boolean).sort().at(-1);
    const model = applyPromotedPrior(fitPoisson(games, codes, { refDate }));
    for (const m of games) {
      const { lh, la } = lambdas(model, m.home, m.away);
      byLambda.set(m, { lh, la });
    }
  }

  // 只留兩隊都有本季陣容的場次(舊賽季的降級球隊沒有)
  const usable = real.filter(m => lineups[m.home] && lineups[m.away] && byLambda.has(m));
  console.log(`  可模擬:${usable.length} 場(其餘球隊沒有本季陣容資料)\n`);

  const realRows = [], simRows = [];
  const realHome = [], realAway = [], simHome = [], simAway = [];
  let seed = 90210;
  for (const m of usable) {
    const { lh, la } = byLambda.get(m);
    const r = simulateMatch({
      lambdaHome: lh, lambdaAway: la,
      home: lineups[m.home], away: lineups[m.away], players, seed: seed++,
    });
    for (const side of ['home', 'away']) {
      const rr = m.stat[side];
      const ss = { ...r.stats[side], goals: r.score[side] };
      realRows.push(rr); simRows.push(ss);
      (side === 'home' ? realHome : realAway).push(rr.shots);
      (side === 'home' ? simHome : simAway).push(ss.shots);
    }
  }

  const R = collect(realRows), S = collect(simRows);
  let fail = 0;
  const flag = ok => { if (!ok) fail++; return ok ? '✔' : '✗'; };

  // ── 1. 平均值與離散度 ──────────────────────
  console.log('▶ 每隊每場的分布(平均 ± 標準差)');
  console.log('  指標      真實            模擬            平均差    離散度比');
  for (const k of KEYS) {
    const rm = mean(R[k]), rs = sd(R[k]), sm = mean(S[k]), ss = sd(S[k]);
    const dm = rm ? (sm - rm) / rm : 0;
    const ratio = rs ? ss / rs : 0;
    /* 平均值容許 ±15%。離散度容許 0.65~1.35 ——
       比 1 小太多代表每場都長得差不多(假),大太多代表亂跳。 */
    const ok = Math.abs(dm) <= 0.15 && ratio >= 0.65 && ratio <= 1.35;
    console.log(`  ${flag(ok)} ${ZH[k].padEnd(4)}  ${rm.toFixed(2).padStart(6)} ± ${rs.toFixed(2).padStart(5)}`
      + `   ${sm.toFixed(2).padStart(6)} ± ${ss.toFixed(2).padStart(5)}`
      + `   ${(dm * 100 >= 0 ? '+' : '') + (dm * 100).toFixed(1)}%`.padStart(9)
      + `   ${ratio.toFixed(2)}`.padStart(9));
  }

  /* ── 1b. 隊間差距 vs 隊內隨機 ────────────────
   *
   * 總標準差對了,不代表引擎對了 —— 它可能是「隊與隊差太多」加上
   * 「同一隊每場都差不多」剛好加總成正確的總量。這兩件事要分開看:
   *
   *   隊間 = 各隊球季平均射門的標準差   → 強弱差距拉得對不對
   *   隊內 = 每場對自己球季平均的偏離   → 單場的隨機性夠不夠
   *
   * 這一項是踩過雷才補的:四道關卡是連乘的,所以每關 1.23 倍的優勢
   * 會變成 5.3 倍的射門差距,而真實強隊對升班馬只有 1.83 倍。
   * 只看總標準差完全看不出來。 */
  console.log('\n▶ 隊間差距 vs 隊內隨機(射門)');
  const byTeam = (rows, key) => {
    const g = new Map();
    rows.forEach((r, i) => {
      const t = key[i];
      if (!g.has(t)) g.set(t, []);
      g.get(t).push(r.shots);
    });
    return g;
  };
  const teamKey = [];
  for (const m of usable) { teamKey.push(m.home); teamKey.push(m.away); }
  const split = (rows) => {
    const g = byTeam(rows, teamKey);
    const teamMeans = [...g.values()].filter(v => v.length >= 8).map(mean);
    const within = [...g.values()].flatMap(v => { const mu = mean(v); return v.map(x => x - mu); });
    return { between: sd(teamMeans), within: sd(within) };
  };
  const rSplit = split(realRows), sSplit = split(simRows);
  for (const [label, rv, sv, lo, hi] of [
    ['隊間(各隊球季平均的離散)', rSplit.between, sSplit.between, 0.6, 1.5],
    ['隊內(單場對自己平均的離散)', rSplit.within, sSplit.within, 0.75, 1.3],
  ]) {
    const ratio = rv ? sv / rv : 0;
    const ok = ratio >= lo && ratio <= hi;
    console.log(`  ${flag(ok)} ${label.padEnd(16)} 真實 ${rv.toFixed(2)}　模擬 ${sv.toFixed(2)}　比值 ${ratio.toFixed(2)}`
      + `(容許 ${lo}~${hi})`);
  }

  // ── 2. 主客差異 ────────────────────────────
  console.log('\n▶ 主場優勢(主隊射門 − 客隊射門)');
  const rDiff = mean(realHome) - mean(realAway), sDiff = mean(simHome) - mean(simAway);
  const diffOk = sDiff > 0 && Math.abs(sDiff - rDiff) < 1.6;
  console.log(`  ${flag(diffOk)} 真實 +${rDiff.toFixed(2)} / 模擬 +${sDiff.toFixed(2)}`
    + `　(方向要一致,差距容許 1.6 次以內)`);

  // ── 3. 轉換率 ──────────────────────────────
  console.log('\n▶ 轉換率');
  const rate = (o, a, b) => mean(o[a]) / mean(o[b]);
  const pairs = [
    ['射正率(射正 ÷ 射門)', rate(R, 'onTarget', 'shots'), rate(S, 'onTarget', 'shots'), 0.06],
    ['進球轉換(進球 ÷ 射門)', rate(R, 'goals', 'shots'), rate(S, 'goals', 'shots'), 0.035],
    ['射正轉換(進球 ÷ 射正)', rate(R, 'goals', 'onTarget'), rate(S, 'goals', 'onTarget'), 0.09],
  ];
  for (const [label, rv, sv, tol] of pairs) {
    const ok = Math.abs(sv - rv) <= tol;
    console.log(`  ${flag(ok)} ${label.padEnd(22)} 真實 ${(rv * 100).toFixed(1)}%　模擬 ${(sv * 100).toFixed(1)}%`
      + `　(容許差 ${(tol * 100).toFixed(1)} 個百分點)`);
  }

  // ── 4. 射門與進球的關聯 ────────────────────
  console.log('\n▶ 射門與進球的相關性');
  const rc = corr(R.shots, R.goals), sc = corr(S.shots, S.goals);
  /* **方向要講對。** 第一版印「模擬偏高屬預期」,而實測是模擬 0.170 < 真實 0.277 ——
     說明跟自己印出來的數字相反;而且斷言 `sc < rc + 0.35` 守的正是偏高那一側,
     對實際發生的方向沒有任何約束力(0.170 < 0.627 永遠成立)。

     偏低是**配額法的結構性結果,不是缺陷**:進球數先由 λ 抽定,再依 xG 加權挑
     哪幾次機會進 —— 進球數跟事件鏈產生的射門數是解耦的,兩者的相關性本來就會
     比真實比賽弱。所以這裡守的是「還是正相關、而且沒有強過真實太多」,
     並且把**量到的方向與差距印出來**,不要複述一個固定的說法。
     門檻沒有動 —— 動門檻要有證據,而這一輪修的是敘述。 */
  const corrOk = sc > 0.1 && sc < rc + 0.35;
  const dir = sc < rc ? '偏低' : '偏高';
  console.log(`  ${flag(corrOk)} 真實 r=${rc.toFixed(3)}　模擬 r=${sc.toFixed(3)}`
    + `　(模擬${dir} ${Math.abs(sc - rc).toFixed(3)};配額法讓進球數與射門數解耦,偏低是預期的`
    + `・容許 0.10 ~ ${(rc + 0.35).toFixed(2)})`);

  // ── 5. 極端值 ──────────────────────────────
  /* 用高百分位,不要用最大值。
     最大值會隨樣本數成長,而真實有 2280 筆、模擬只有 1444 筆 ——
     拿 max 比 max 本身就不可比,分不出「尾巴真的太肥」還是「剛好抽到離群值」。 */
  console.log('\n▶ 分布的尾巴');
  const pctl = (a, q) => { const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(v.length * q))]; };
  for (const k of ['shots', 'corners', 'fouls']) {
    const rp = pctl(R[k], 0.99), sp = pctl(S[k], 0.99);
    const ok = sp <= rp * 1.25 && Math.min(...S[k]) >= 0;
    console.log(`  ${flag(ok)} ${ZH[k].padEnd(4)} p99 真實 ${rp} / 模擬 ${sp}(容許 1.25 倍)`
      + `　　最大值 真實 ${Math.max(...R[k])} / 模擬 ${Math.max(...S[k])}`);
  }

  console.log(fail
    ? `\n✗ ${fail} 項超出容許範圍 —— 引擎已經漂掉,調 RATES 之前先看是哪一項`
    : '\n✔ 全部指標都落在真實資料的容許範圍內');
  if (fail) process.exitCode = 1;
}

await main();
