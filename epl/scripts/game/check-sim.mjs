#!/usr/bin/env node
/* 連續時間引擎的自我檢查(2026-09-16,階段 1)。
 *
 * 為什麼要有這一支:連續模擬是**純邏輯**,90 分鐘在 Node 裡幾秒就跑完 ——
 * 所以「像不像在踢球」不必靠眼睛看,可以逐項對回 FotMob 的真實值。
 * 這比截圖可靠:畫面看起來順不順是主觀的,跑動 11 m/分 對 113 m/分 不是。
 *
 * 這一支刻意**不進 npm test**:階段 1 還在調,把會動的數字當紅線只會讓 CI 每天紅一次
 * (CLAUDE.md:把會隨資料變動的數字當 CI 紅線,紅久了就沒有人看)。
 * 等階段 2 校準完再挑幾條真正的不變量進去。
 *
 * 用法:node scripts/game/check-sim.mjs [場數]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createSim } = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
const profile = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'game', 'pl.json'), 'utf8'));
const RUNS = Math.max(1, parseInt(process.argv[2] ?? '3', 10));
const HOME = 'ARS', AWAY = 'LIV';
const STEP = 1 / 60;

/* 一場:逐格推進並量「眼睛看得到的那一層」。
   瞬移的容差用**這個人自己的最高速**,不是一個全域常數 —— 每個人的上限本來就不同。 */
function play(seed, minutes = 90) {
  const sim = createSim({ profile, home: HOME, away: AWAY, seed, pred: PRED });
  const N = Math.round(minutes * 60 / STEP);
  let prev = null, jumps = 0, maxJump = 0, still = 0, samples = 0;
  const bins = new Array(7).fill(0);
  for (let i = 0; i < N; i++) {
    sim.advance(STEP);
    const s = sim.state();
    bins[Math.min(6, Math.floor(Math.max(0, s.ball.x) / (105 / 7)))]++;
    if (prev) for (const p of s.players) {
      const a = prev[p.code];
      if (!a) continue;
      samples++;
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      if (d > p.vmax * STEP * 1.5 + 0.02) { jumps++; maxJump = Math.max(maxJump, d); }
      if (Math.hypot(p.vx, p.vy) < 0.3) still++;
    }
    prev = Object.fromEntries(s.players.map(p => [p.code, p]));
  }
  return { sim, st: sim.state(), m: sim.motion(), jumps, maxJump, still, samples, bins };
}

const rows = [];
/* λ 的來源:站上對這一場的預測。沒有給 pred 的話引擎用 1.35 當預設,
   那只是「有個數字可以跑」,不是本站的預測 —— 驗錨一定要餵真的 λ。 */
/* 這一組 λ 是**測試用的**,不是站上對 ARS vs LIV 的預測(那一組是 ARS vs AVL 的)。
   錨要驗的是「給它一個 λ,它跑出來的平均進球回不回得到那個 λ」,所以用哪一組都成立 ——
   但註解不可以寫成「站上的預測」,那會變成一個沒有出處的宣稱。 */
const PRED = { xgHome: 1.99, xgAway: 0.70 };
for (let seed = 1; seed <= RUNS; seed++) rows.push(play(seed));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const se = a => (a.length < 2 ? 0 : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1) / a.length));
const line = (label, v, extra = '') => console.log(`  ${label.padEnd(26, '\u3000')} ${v}${extra ? `  ${extra}` : ''}`);

console.log(`\n▶ 連續時間引擎(${HOME} vs ${AWAY},${RUNS} 場 × 90 分鐘)\n`);

/* 1. 硬性不變量:這幾條不該有例外,錯了就是引擎壞了 */
const totalJumps = rows.reduce((a, r) => a + r.jumps, 0);
const worstJump = Math.max(...rows.map(r => r.maxJump));
line('瞬移(超過自己最高速)', `${totalJumps} 次`, totalJumps ? `最大 ${worstJump.toFixed(2)} m ← 引擎有問題` : '✓');
const inside = rows.every(r => r.st.players.every(p => p.x >= -1.5 && p.x <= 106.5 && p.y >= -1.5 && p.y <= 69.5));
line('所有人都在場內', inside ? '✓' : '✗ 有人跑出球場');
const lost = rows.reduce((a, r) => a + (r.st.diag?.lostShot ?? 0), 0);
line('射門在飛行中被吃掉', `${lost} 次`, lost ? '← 球的速度被蓋掉了(踩過一次)' : '✓');

/* 2. λ 錨。換引擎之後它是**統計版**的:精確相等做不到(射門是長出來的),
      所以驗的是「N 場平均落在 λ 的幾個標準誤內」。 */
console.log('');
const cal = rows[0].sim.calibration();
console.log(`  λ 錨:每球平均 xG 用 ${cal.xgPerShotFrom} = ${cal.xgPerShotReal}`);
console.log(`        k(主)${cal.home.k}(λ ${cal.home.lambda} ÷ 期望射門 ${cal.home.expShots.toFixed(1)} × ${cal.xgPerShotReal})`);
console.log(`        k(客)${cal.away.k}(λ ${cal.away.lambda} ÷ 期望射門 ${cal.away.expShots.toFixed(1)} × ${cal.xgPerShotReal})`);
for (const [i, who, lam] of [[0, '主隊', PRED.xgHome], [1, '客隊', PRED.xgAway]]) {
  const g = rows.map(r => r.st.score[i]);
  const s2 = se(g), m = mean(g);
  /* SE 是 0 的時候(場次少、每一場的進球數剛好都一樣)這個檢定沒有定義 ——
     不是「差無限多個 SE」。第一版印了 `Infinity SE ← 錨沒守住`,而那只是樣本太小。
     這跟「0 是一個看起來很像答案的數字」同一家族:**沒有定義**與**很糟**是兩件事。 */
  if (s2 === 0) line(`${who}進球`, `${m.toFixed(2)}`, `λ ${lam} → ${RUNS} 場的進球數完全相同,SE 是 0、這個檢定算不出來(要更多場)`);
  else {
    const sig = (m - lam) / s2;
    line(`${who}進球`, `${m.toFixed(2)} ± ${s2.toFixed(2)}`, `λ ${lam} → 差 ${sig.toFixed(1)} SE ${Math.abs(sig) <= 3 ? '✓' : '← 錨沒守住'}`);
  }
}

/* 3. 逐項對回球隊自己的真實比率(rates 是分主客的,不是平的 —— 踩過) */
console.log('');
const rt = (code, where) => profile.teams[code]?.rates?.[where] ?? {};
const real = { sf: (rt(HOME, 'home').sf ?? 0) + (rt(AWAY, 'away').sf ?? 0), cf: (rt(HOME, 'home').cf ?? 0) + (rt(AWAY, 'away').cf ?? 0) };
line('每場射門', mean(rows.map(r => r.st.counts.shots)).toFixed(1), `真實 ${real.sf.toFixed(1)}`);
line('每場射正', mean(rows.map(r => r.st.counts.onTarget)).toFixed(1));
line('每場角球', mean(rows.map(r => r.st.counts.corners.home + r.st.counts.corners.away)).toFixed(1), `真實 ${real.cf.toFixed(1)}`);
line('每場 xG(主:客)', `${mean(rows.map(r => r.st.xg.home)).toFixed(2)} : ${mean(rows.map(r => r.st.xg.away)).toFixed(2)}`);
line('每場界外球 / 球門球', `${mean(rows.map(r => r.st.counts.throwIns)).toFixed(0)} / ${mean(rows.map(r => r.st.counts.goalKicks)).toFixed(0)}`);
line('每場傳球 / 抄截', `${mean(rows.map(r => r.st.counts.passes)).toFixed(0)} / ${mean(rows.map(r => r.st.counts.tackles)).toFixed(0)}`);

/* 4. 運動層(階段 1 的那幾項,回歸用) */
console.log('');
for (const [side, code] of [['home', HOME], ['away', AWAY]]) {
  const per = mean(rows.map(r => {
    const ps = r.m.players.filter(p => p.side === side && p.role !== 'GK');
    return ps.reduce((a, p) => a + p.dist, 0) / ps.length / (r.m.secs / 60);
  }));
  const realRun = profile.teams[code]?.pace?.distancePerMin / 11;
  line(`${code} 場上球員跑動`, `${per.toFixed(0)} m/分`, realRun ? `真實 ${realRun.toFixed(0)}` : '');
}
line('站著的比例', `${mean(rows.map(r => 100 * r.still / r.samples)).toFixed(1)}%`);
const bins = new Array(7).fill(0);
for (const r of rows) r.bins.forEach((b, i) => { bins[i] += b; });
const bt = bins.reduce((a, b) => a + b, 0);
console.log(`\n  球的 x 分佈(自家門 → 對手門):${bins.map(b => `${(100 * b / bt).toFixed(0)}%`).join(' ')}\n`);
