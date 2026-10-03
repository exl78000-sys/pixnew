#!/usr/bin/env node
/* 主場優勢的量測台(2026-10-03)。
 *
 * 為什麼要另外一支:`check-sim` 只踢**一組對戰、一個方向**,主場的效應跟兩隊的強弱混在一起分不開 ——
 * 2026-09-30 那張「主 0.83 / 客 1.12」就是六組配對的平均,而那六組裡強隊有的在主場、有的在客場。
 * 這一支用**鏡像**:每一組配對兩個方向都踢(同一組種子),量「同一隊、同一個對手,主場 ÷ 客場」,
 * 強弱在比值裡消掉,剩下的就是主客。
 *
 * 印兩件事:
 *   一、**λ 的錨逐隊逐主客看**(每一個「隊 × 主客」的 z),主客**分開平均**。
 *       只看合計會被抵銷:2026-10-03 量到的正是主隊系統性偏低、客隊偏高(z 平均 −1.13 / +0.70),
 *       兩者平均起來 −0.21,看起來完全正常。
 *   二、鏡像比值對**真實英超**的主 ÷ 客(FotMob 逐場 raw,這一支自己算,不抄數字)。
 *
 * 跟 `check-sim` 一樣**不進 npm test**:它跑幾百場,而且量的是會隨行為變的數字。
 *
 * 用法:node scripts/game/check-home.mjs [每方向場數=12] [--seed0=1] [--pairs=ARS-LIV,MCI-IPS]
 *        [--neutral](兩邊都用中立場的 λ,引擎也開中立場 —— 鏡像比值應該全部接近 1)
 *        [--src=實驗版引擎的路徑](對照實驗用;不給就是 web/assets/js/game-sim.js)
 *        [--verbose](逐隊逐主客印出來)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createMatchPool } = await import(pathToFileURL(join(ROOT, 'scripts', 'game', 'lib', 'match-pool.mjs')));
const { blendPair } = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'predict-core.js')));
const profile = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'game', 'pl.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'meta.json'), 'utf8'));
const teams = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'teams.json'), 'utf8'));
const eloBy = new Map(teams.map(t => [t.code, t.elo]));

const args = process.argv.slice(2);
const flag = k => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
/* 場數取第一個不是旗標的參數(check-sim 踩過:直接讀 argv[2] 會把旗標 parseInt 成 NaN) */
const N = Math.max(2, parseInt(args.find(a => !a.startsWith('--')) ?? '12', 10));
const SEED0 = Math.max(0, parseInt(flag('seed0') ?? '1', 10));
const NEUTRAL = args.includes('--neutral');
const VERBOSE = args.includes('--verbose');
const srcPath = flag('src');
const source = srcPath ? readFileSync(resolve(srcPath), 'utf8') : null;
/* 預設六組:強對強、強對中、極端、中對中各一,強弱兩邊都有在主場的時候(鏡像就是為了這個) */
const PAIRS = (flag('pairs') ?? 'ARS-LIV,ARS-TOT,MCI-IPS,BOU-BRE,NEW-EVE,CHE-SUN').split(',').map(s => s.split('-'));
for (const [x, y] of PAIRS) {
  if (!profile.teams[x] || !profile.teams[y]) throw new Error(`側寫裡沒有 ${x} 或 ${y}`);
  if (!meta.model?.sim?.teams?.[x] || !meta.model?.sim?.teams?.[y]) throw new Error(`站上的模型沒有 ${x} 或 ${y} 的參數`);
}
/* λ 跟遊戲頁同一條路:站上的 Poisson 與 Elo 平均(blendPair),中立場就拿掉主場那一份 */
const predOf = (h, a) => {
  const p = blendPair(meta.model.sim, h, a, eloBy.get(h), eloBy.get(a), { neutral: NEUTRAL });
  return { xgHome: p.xgHome, xgAway: p.xgAway };
};
const eng = await import(source ? 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
  : pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));

const pool = createMatchPool({ root: ROOT, profile });
const specs = [];
for (const [x, y] of PAIRS) for (const [h, a] of [[x, y], [y, x]]) {
  const pred = predOf(h, a);
  for (let s = SEED0; s < SEED0 + N; s++) specs.push({ seed: s, home: h, away: a, pred, source, neutral: NEUTRAL });
}
pool.warm(specs);
const rows = [];
for (const sp of specs) {
  const st = (await pool.get(sp)).state(), c = st.counts;
  const pt = (st.poss?.home ?? 0) + (st.poss?.away ?? 0);
  const per = side => ({
    goals: st.score[side === 'home' ? 0 : 1], shots: c.shotsBy?.[side] ?? 0, xg: st.xg?.[side] ?? 0,
    box: c.boxTouchAll?.[side] ?? 0, opp: c.okOppHalf?.[side] ?? 0, own: c.okOwnHalf?.[side] ?? 0,
    poss: pt ? 100 * st.poss[side] / pt : 50, corners: c.corners?.[side] ?? 0,
    off: c.offsides?.[side] ?? 0, fouls: c.fouls?.[side] ?? 0, onT: c.onTargetBy?.[side] ?? 0,
  });
  rows.push({ home: sp.home, away: sp.away, pred: sp.pred, h: per('home'), a: per('away') });
}
await pool.close();

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / Math.max(1, a.length - 1));
const cal0 = eng.createSim({ profile, home: PAIRS[0][0], away: PAIRS[0][1], seed: 1, pred: rows[0].pred, neutral: NEUTRAL }).calibration();
console.log(`\n▶ 主場優勢量測台:${PAIRS.length} 組 × 兩個方向 × ${N} 場(種子 ${SEED0}~${SEED0 + N - 1})`
  + `${srcPath ? '・實驗版引擎 ' + srcPath : ''}${NEUTRAL ? '・中立場' : ''}`);
if (cal0.venue) console.log(`  引擎的主場參數:${JSON.stringify(cal0.venue)}`);

/* 一、λ 錨:每一個「隊 × 主客」一個 z,主客分開平均 */
const z = { home: [], away: [] }, fShot = { home: [], away: [] }, fXg = { home: [], away: [] };
for (const [x, y] of PAIRS) for (const [h, a] of [[x, y], [y, x]]) {
  const R = rows.filter(r => r.home === h && r.away === a);
  const cal = eng.createSim({ profile, home: h, away: a, seed: 1, pred: R[0].pred, neutral: NEUTRAL }).calibration();
  for (const side of ['home', 'away']) {
    const S = R.map(r => (side === 'home' ? r.h : r.a));
    const g = S.map(r => r.goals), lam = R[0].pred[side === 'home' ? 'xgHome' : 'xgAway'];
    const s = sd(g) / Math.sqrt(g.length);
    /* SE 是 0(每一場進球數一樣)時這個檢定沒有定義,不是「差無限多個 SE」(check-sim 同一條) */
    if (!(s > 0)) continue;
    const zz = (mean(g) - lam) / s;
    z[side].push(zz);
    const shots = mean(S.map(r => r.shots)), xgps = S.reduce((t, r) => t + r.xg, 0) / Math.max(1, S.reduce((t, r) => t + r.shots, 0));
    fShot[side].push(shots / cal[side].expShots);
    fXg[side].push(xgps / cal.selectedXg);
    if (VERBOSE) console.log(`    ${h}-${a} ${side === 'home' ? '主' : '客'} ${side === 'home' ? h : a}`
      + `  進球 ${mean(g).toFixed(2)} 對 λ ${lam}(${zz >= 0 ? '+' : ''}${zz.toFixed(1)} SE)`
      + `・射門 ${shots.toFixed(1)} ÷ 期望 ${cal[side].expShots.toFixed(1)}・每球 xG ${xgps.toFixed(3)}`);
  }
}
const zLine = s => `${mean(z[s]) >= 0 ? '+' : ''}${mean(z[s]).toFixed(2)} ± ${(1 / Math.sqrt(z[s].length)).toFixed(2)}`;
console.log(`\n  一、λ 錨(每一個「隊 × 主客」的 z,主客分開平均;z 平均的 SE ≈ 1/√個數)`);
console.log(`    主 ${zLine('home')}・客 ${zLine('away')}  ← 兩個都要在 0 附近;一正一負就是主客被搬了家`);
console.log(`    射門 ÷ 期望射門:主 ${mean(fShot.home).toFixed(3)}・客 ${mean(fShot.away).toFixed(3)}`
  + `   每球 xG ÷ 聯盟平均:主 ${mean(fXg.home).toFixed(3)}・客 ${mean(fXg.away).toFixed(3)}`);

/* 二、真實英超的主 ÷ 客:FotMob 逐場 raw,逐場配對。每次跑都重算 —— 季中 raw 會長 */
const REAL_KEYS = { goals: null, shots: 'shots', xg: 'xG', box: 'touches_opp_box', opp: 'opposition_half_passes',
  own: 'own_half_passes', poss: 'possession', corners: 'corners', off: 'offsides', fouls: 'fouls', onT: 'shotsOn' };
const real = {};
{
  const dir = join(ROOT, 'data', 'raw', 'fotmob-epl');
  const pairs = Object.fromEntries(Object.keys(REAL_KEYS).map(k => [k, []]));
  for (const f of readdirSync(dir).filter(n => n.endsWith('-game-details.json'))) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const m of Object.values(d.matches ?? {})) {
      const ts = m.teamStats, tx = m.teamExtra;
      if (!ts?.[m.home] || !ts?.[m.away]) continue;
      const H = { ...ts[m.home], ...(tx?.[m.home] ?? {}) }, A = { ...ts[m.away], ...(tx?.[m.away] ?? {}) };
      for (const [k, key] of Object.entries(REAL_KEYS)) {
        const h = key ? H[key] : m.score?.[0], a = key ? A[key] : m.score?.[1];
        if (Number.isFinite(h) && Number.isFinite(a)) pairs[k].push([h, a]);
      }
    }
  }
  for (const [k, p] of Object.entries(pairs)) {
    if (p.length < 50) continue;
    const h = mean(p.map(x => x[0])), a = mean(p.map(x => x[1]));
    real[k] = { v: k === 'poss' ? h - a : h / a, n: p.length };
  }
}
const lr = Object.fromEntries(Object.keys(REAL_KEYS).map(m => [m, []]));
for (const [x, y] of PAIRS) for (const [t, o] of [[x, y], [y, x]]) {
  const H = rows.filter(r => r.home === t && r.away === o).map(r => r.h);
  const A = rows.filter(r => r.home === o && r.away === t).map(r => r.a);
  for (const m of Object.keys(lr)) {
    const h = mean(H.map(r => r[m])), a = mean(A.map(r => r[m]));
    if (m === 'poss') lr[m].push(h - a); else if (h > 0 && a > 0) lr[m].push(Math.log(h / a));
  }
}
const ZH = { goals: '進球', shots: '射門', xg: 'xG', box: '禁區觸球', opp: '對方半場完成傳球', own: '自家半場完成傳球',
  poss: '控球', corners: '角球', off: '越位', fouls: '犯規', onT: '射正' };
console.log(`\n  二、鏡像:同一隊、同一個對手,主場 ÷ 客場(幾何平均 ± 隊間 SE)    真實英超(FotMob 逐場,主 ÷ 客)`);
for (const m of Object.keys(lr)) {
  const r = lr[m]; if (!r.length) continue;
  const g = mean(r), s = sd(r) / Math.sqrt(r.length);
  const v = m === 'poss' ? `${g >= 0 ? '+' : ''}${g.toFixed(2)} pp ± ${s.toFixed(2)}` : `${Math.exp(g).toFixed(3)} ± ${(Math.exp(g) * s).toFixed(3)}`;
  const rv = real[m] ? (m === 'poss' ? `${real[m].v >= 0 ? '+' : ''}${real[m].v.toFixed(2)} pp` : real[m].v.toFixed(3)) + `(${real[m].n} 場)` : '—';
  console.log(`    ${ZH[m].padEnd(10, '　')} ${v.padEnd(24)} ${rv}`);
}
{
  let hs = 0, hx = 0, as = 0, ax = 0;
  for (const r of rows) { hs += r.h.shots; hx += r.h.xg; as += r.a.shots; ax += r.a.xg; }
  const rx = real.xg && real.shots ? (real.xg.v / real.shots.v).toFixed(3) : '—';
  console.log(`    每球 xG 主 ÷ 客 ${((hx / hs) / (ax / as)).toFixed(3)}(主 ${(hx / hs).toFixed(4)}、客 ${(ax / as).toFixed(4)})    真實 ${rx}`);
}
console.log(NEUTRAL
  ? '\n  中立場:鏡像比值應該全部接近 1 —— 有一項明顯不是,就是還有哪一個地方在讀主客身分。'
  : '\n  真實那一欄是**聯盟平均**的主客差;引擎那一欄是六組配對的平均,兩隊的主客分裂各自不同,所以看的是量級與方向。');
