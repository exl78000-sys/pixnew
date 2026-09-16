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
  const sim = createSim({ profile, home: HOME, away: AWAY, seed });
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
for (let seed = 1; seed <= RUNS; seed++) rows.push(play(seed));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const line = (label, v, extra = '') => console.log(`  ${label.padEnd(26, '　')} ${v}${extra ? `  ${extra}` : ''}`);

console.log(`\n▶ 連續時間引擎 階段 1(${HOME} vs ${AWAY},${RUNS} 場 × 90 分鐘)\n`);

/* 1. 硬性不變量:這幾條不該有例外,錯了就是引擎壞了 */
const totalJumps = rows.reduce((a, r) => a + r.jumps, 0);
const worstJump = Math.max(...rows.map(r => r.maxJump));
line('瞬移(超過自己最高速)', `${totalJumps} 次`, totalJumps ? `最大 ${worstJump.toFixed(2)} m ← 引擎有問題` : '✓');
const anyOut = rows.every(r => r.st.players.every(p => p.x >= -1.5 && p.x <= 106.5 && p.y >= -1.5 && p.y <= 69.5));
line('所有人都在場內', anyOut ? '✓' : '✗ 有人跑出球場');

/* 2. 對照組:跑動量要對得回 FotMob 的真實值。
      本站的真實值是球隊每分鐘 distancePerMin,除以 11 才是每人每分鐘 —— 分母要跟被比較的那一邊同一批。 */
console.log('');
for (const [side, code] of [['home', HOME], ['away', AWAY]]) {
  const per = mean(rows.map(r => {
    const ps = r.m.players.filter(p => p.side === side && p.role !== 'GK');
    return ps.reduce((a, p) => a + p.dist, 0) / ps.length / (r.m.secs / 60);
  }));
  const real = profile.teams[code]?.pace?.distancePerMin / 11;
  const ratio = real ? per / real : null;
  line(`${code} 場上球員跑動`, `${per.toFixed(0)} m/分`,
    real ? `FotMob 真實值 ${real.toFixed(0)}(${ratio > 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(0)}%)` : '沒有真實值可比');
}

/* 3. 只回報、不判定的量:階段 1 還沒校準,這些數字現在只是「長什麼樣子」 */
console.log('');
const c = k => mean(rows.map(r => r.st.counts[k]));
line('站著(<0.3 m/s)的比例', `${mean(rows.map(r => 100 * r.still / r.samples)).toFixed(1)}%`);
line('有人持球的時間', `${mean(rows.map(r => 100 * (r.st.poss.home + r.st.poss.away) / r.m.secs)).toFixed(1)}%`);
line('控球(主:客)', `${mean(rows.map(r => 100 * r.st.poss.home / (r.st.poss.home + r.st.poss.away))).toFixed(1)} : ${mean(rows.map(r => 100 * r.st.poss.away / (r.st.poss.home + r.st.poss.away))).toFixed(1)}`);
for (const k of ['passes', 'shots', 'tackles', 'outs', 'loose']) line(`每場 ${k}`, c(k).toFixed(0));
const bins = new Array(7).fill(0);
for (const r of rows) r.bins.forEach((b, i) => { bins[i] += b; });
const bt = bins.reduce((a, b) => a + b, 0);
console.log(`\n  球的 x 分佈(自家門 → 對手門):${bins.map(b => `${(100 * b / bt).toFixed(0)}%`).join(' ')}`);
console.log('\n  階段 1 沒有進球 —— 「這一腳進不進」要校準過才算數(鐵則一),那是階段 2。\n');
