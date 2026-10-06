#!/usr/bin/env node
/* 強弱量測台(2026-10-06):九組配對 × 兩個方向 × 30 場,看引擎有沒有把「強弱」壓扁。
 *
 * 為什麼要有這一支:補齊規劃寫了好幾輪「中度懸殊的配對長不出機會的差距、強弱被壓扁」,依據是
 * `check-sim` 一組對戰 30 場的 z —— ARS 對 LIV −3.2 / −1.2 SE、ARS 對 TOT −2.8 SE。
 * **那些 z 單獨看都「顯著」,合起來是雜訊**:同一組 ARS 對 TOT 換一組種子(1001~1030)ARS 進球
 * 2.20 對 λ 2.24(−0.1 SE),第一組 1.50(−2.8 SE);九組配對 × 兩方向 × 30 場(540 場)合起來,
 * 模擬進球對 λ 的斜率是 0.98 ± 0.08、強隊 1.02 ± 0.03、弱隊 0.94 ± 0.04,沒有一筆 |z| > 3。
 * 一組對戰 30 場的 SE 是 0.25 球上下(λ 的 15~40%),拿它判「系統性偏差」就是在雜訊裡挑最大的那一個
 * (CLAUDE.md:「只看差值就宣稱有偏差」那條的同一家族;這次連 SE 都算了,但**挑了哪一組**也要算進去)。
 *
 * 所以強弱的判決要用**合起來的估計量**,而且跟 check-home 一樣走 worker 池(每場約 8 秒、四核並行):
 *   一、校準斜率:模擬進球 = a + b × λ,涵蓋全部「隊 × 主客」。b = 1 且 a = 0 才是沒有壓縮;
 *   二、每組配對裡 λ 較大的是強隊、較小的是弱隊,兩邊各自平均「進球 ÷ λ」;
 *   三、射門 ÷ 預算(`expShots`)、每球 xG、禁區觸球比、控球差 —— 強弱住在哪一層。
 * 真實那一欄(每球 xG 強 − 弱)每次從 FotMob 逐場 shotmap 重算,不抄數字。
 *
 * 跟 `check-sim`、`check-home` 一樣**不進 npm test**:它跑幾百場,而且量的是會隨行為變的數字。
 * 一次約 35 分鐘(540 場、四核)。
 *
 * 用法:node scripts/game/check-strength.mjs [每方向場數=30] [--seed0=101] [--pairs=ARS-TOT,MCI-IPS]
 *        [--src=實驗版引擎的路徑] [--out=結果.json] [--verbose]
 *      node scripts/game/check-strength.mjs --compare=a.json,b.json   (不跑模擬,只把幾份結果並排)
 *      node scripts/game/check-strength.mjs --pool=a.json,b.json[,c.json] [--out=合併.json]
 *        (同一個引擎、不同 --seed0 跑的幾份,場數相加後印報告;`--out` 存起來可以再丟給 --compare)
 *
 * **單組(每方向 30 場)的校準斜率不夠穩,判決要合併幾組種子再看**(2026-10-06 下午量到的):同一個實驗版引擎(E4)
 * 種子 101~130 的斜率是 1.031 ± 0.099、種子 201~230 是 0.575 ± 0.078 —— 兩組之差 0.456,在「36 筆各自獨立」的模型裡
 * 抽 4000 次沒有一次到這麼大;現況引擎兩組是 0.981 ± 0.080 與 0.942 ± 0.081(穩的)。所以單組自己報的 SE 會低估,
 * 斜率只當線索,拍板用 `--pool` 合起來的場數(≥ 60 場 / 方向)。
 *
 * **比較兩個引擎版本時**:旗標改了 rng 的消耗次數,同一個種子跑出來就不是同一場比賽 —— 差值的 SE 要用
 * 兩個獨立樣本算(×√2),不是成對。`--compare` 印的每一格 ± 都是各自的 SE,自己相減再放大。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { summarize, poolResults, mean, sd, se } from './lib/strength.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = k => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const f = (v, d = 2) => Number(v).toFixed(d);
const pm = (a, d = 3) => `${f(mean(a), d)} ± ${f(se(a), d)}`;

/* 印報告(跑完一輪、或把幾份結果合起來,都走這一份)。`ent` 是每個「隊 × 主客」一筆。 */
function report({ ent, PAIRS, title, verbose = false }) {
  console.log(`\n▶ 強弱量測台:${title}`);
  if (verbose) {
    console.log('  隊(主客) 對  λ    進球±SE   z     射門/預算   每球xG  禁區觸球  控球');
    for (const e of ent) console.log(`  ${e.code}(${e.side === 'home' ? '主' : '客'}) ${e.opp}  ${f(e.lam)}  ${f(e.goals)}±${f(e.se)}  ${f((e.goals - e.lam) / (e.se || 1), 1).padStart(5)}`
      + `  ${f(e.shots, 1)}/${f(e.expShots, 1)}  ${f(e.xgps, 4)}  ${f(e.box, 1)}  ${f(e.poss, 1)}`);
  }
  const R = summarize({ ent, PAIRS });
  console.log(`\n  一、λ 錨(合起來的估計量,不是逐組的 z)`);
  console.log(`    校準斜率:模擬進球 = ${f(R.a)} + ${f(R.b, 3)} × λ  (b 的 SE ${f(R.seB, 3)};b = 1、a = 0 才是沒有壓縮)`);
  console.log(`    強隊 進球 ÷ λ ${pm(R.gS)}・弱隊 ${pm(R.gW)}   z 平均 強 ${f(mean(R.zS))} / 弱 ${f(mean(R.zW))}・|z| > 3 的 ${R.big} 筆`);
  console.log(`    這個場數驗得出的偏差(2 SE):斜率 ±${f(2 * R.seB, 2)}・強隊 ±${f(2 * se(R.gS), 2)}・弱隊 ±${f(2 * se(R.gW), 2)}(比例)`);
  console.log(`\n  二、強弱住在哪一層`);
  console.log(`    射門 ÷ 預算:強隊 ${pm(R.sS)}・弱隊 ${pm(R.sW)}`);
  console.log(`    禁區觸球 強 ÷ 弱 ${pm(R.rb, 2)}・控球差 強 − 弱 ${pm(R.pd, 1)} pp`);
  if (R.possSlope != null) {
    console.log(`    控球跟著目標走嗎:引擎控球對目標的斜率 ${f(R.possSlope, 2)} ± ${f(R.possSlopeSe, 2)}(1 = 照目標、0 = 不理它)`
      + (R.pdT ? `・強 − 弱 引擎 ${pm(R.pd, 1)} 對目標 ${pm(R.pdT, 1)} pp` : ''));
  }

  /* 真實的每球 xG 強 − 弱:FotMob 逐場 shotmap,同一批配對、同一個「強弱」(λ 較大的那隊)。
     烏龍球不算(座標在自己那一端,引擎產不出來)—— check-sim 的 collectReal 同一條。 */
  {
    const agg = {};
    for (const fn of ['2025-26-game-details.json', '2026-27-game-details.json']) {
      const path = join(ROOT, 'data', 'raw', 'fotmob-epl', fn);
      if (!existsSync(path)) continue;
      const j = JSON.parse(readFileSync(path, 'utf8'));
      for (const m of Object.values(j.matches ?? {})) for (const sh of (m.shots ?? [])) {
        if (sh.x == null || sh.y == null || sh.ownGoal || sh.xg == null || !sh.team) continue;
        const o = (agg[sh.team] ??= { n: 0, xg: 0 }); o.n++; o.xg += sh.xg;
      }
    }
    const per = c => (agg[c]?.n ? agg[c].xg / agg[c].n : null);
    const real = R.strong.map((s, i) => (per(s.code) != null && per(R.weak[i].code) != null ? per(s.code) - per(R.weak[i].code) : null)).filter(v => v != null);
    console.log(`    每球 xG 強 − 弱:引擎 ${pm(R.dq, 4)}`
      + (real.length ? `・真實 ${pm(real, 4)}(同一批 ${real.length} 組配對、整季 shotmap)` : '・真實:沒有 shotmap'));
    console.log('      真實那一欄的 SE 很大(各隊整季的每球 xG 彼此差 ±0.03),所以只看「引擎離它有幾個 SE」,不要拿來調到剛好。');
  }
  console.log(`\n  逐組(強 / 弱各兩個方向平均)`);
  for (let i = 0; i < PAIRS.length; i++) {
    const S = R.strong[i], W = R.weak[i];
    console.log(`    ${S.pair}:強 ${S.code} λ ${f(S.lam)} 進球 ${f(S.goals)}(${f(S.goals / S.lam)}λ)・弱 ${W.code} λ ${f(W.lam)} 進球 ${f(W.goals)}(${f(W.goals / W.lam)}λ)`
      + `・每球 xG ${f(S.xgps, 4)} / ${f(W.xgps, 4)}・禁區觸球 ${f(S.box, 1)} / ${f(W.box, 1)}・控球 ${f(S.poss, 1)} / ${f(W.poss, 1)}`);
  }
  console.log('\n  怎麼讀:一組配對的 SE 約 0.25 球(λ 的 15~40%),逐組的偏差在 2 SE 以內都是雜訊;判決看上面「一」那兩行。');
  console.log('  單組(30 場 / 方向)的斜率會比它自己報的 SE 更會跳(同一個引擎換一組種子差過 0.46)—— 拍板前用 --pool 合起來再看。');
}

/* ── --compare:只並排幾份已經跑好的結果 ── */
const cmp = flag('compare');
if (cmp) {
  const files = cmp.split(',');
  const S = files.map(p => ({ p, r: JSON.parse(readFileSync(resolve(p), 'utf8')) })).map(x => ({ ...x, s: summarize(x.r) }));
  const rows = [
    ['檔', x => x.p.split('/').pop()], ['每方向場數', x => x.r.N], ['配對數', x => x.r.PAIRS.length],
    ['校準斜率 b', x => `${f(x.s.b, 3)} ± ${f(x.s.seB, 3)}`], ['截距 a', x => f(x.s.a)],
    ['強隊 進球÷λ', x => pm(x.s.gS)], ['弱隊 進球÷λ', x => pm(x.s.gW)],
    ['強隊 / 弱隊 z 平均', x => `${f(mean(x.s.zS))} / ${f(mean(x.s.zW))}`],
    ['強隊 射門÷預算', x => pm(x.s.sS)], ['弱隊 射門÷預算', x => pm(x.s.sW)],
    ['每球 xG 強−弱', x => pm(x.s.dq, 4)], ['禁區觸球 強÷弱', x => pm(x.s.rb, 2)], ['控球差 強−弱 (pp)', x => pm(x.s.pd, 1)],
    ['控球目標差 強−弱 (pp)', x => (x.s.pdT ? pm(x.s.pdT, 1) : '—(舊檔沒有目標)')],
    ['控球對目標的斜率', x => (x.s.possSlope == null ? '—' : `${f(x.s.possSlope, 2)} ± ${f(x.s.possSlopeSe, 2)}`)],
    ['|z| > 3 的筆數', x => x.s.big],
  ];
  for (const [name, fn] of rows) console.log(name.padEnd(18, '　') + S.map(x => String(fn(x)).padEnd(26)).join(''));
  process.exit(0);
}

/* ── --pool:把同一個引擎、不同種子的幾份結果合成一份(場數相加),印報告;`--out` 可以存起來再丟給 --compare ── */
const pooled = flag('pool');
if (pooled) {
  const rs = pooled.split(',').map(p => JSON.parse(readFileSync(resolve(p), 'utf8')));
  const P = poolResults(rs);
  report({ ent: P.ent, PAIRS: P.PAIRS, title: `合併 ${rs.length} 份(每方向共 ${P.N} 場,種子 ${P.SEED0})` });
  if (flag('out')) writeFileSync(resolve(flag('out')), JSON.stringify(P, null, 1));
  process.exit(0);
}

/* ── 跑模擬 ── */
const N = Math.max(2, parseInt(args.find(a => !a.startsWith('--')) ?? '30', 10));
const SEED0 = Math.max(0, parseInt(flag('seed0') ?? '101', 10));
const VERBOSE = args.includes('--verbose');
const srcPath = flag('src');
const source = srcPath ? readFileSync(resolve(srcPath), 'utf8') : null;
const PAIRS = (flag('pairs') ?? 'ARS-TOT,ARS-LIV,MCI-IPS,BOU-BRE,NEW-EVE,CHE-SUN,MCI-LEE,LIV-SUN,AVL-EVE').split(',').map(s => s.split('-'));

const { createMatchPool } = await import(pathToFileURL(join(ROOT, 'scripts', 'game', 'lib', 'match-pool.mjs')));
const { blendPair } = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'predict-core.js')));
const profile = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'game', 'pl.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'meta.json'), 'utf8'));
const teams = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'teams.json'), 'utf8'));
const eloBy = new Map(teams.map(t => [t.code, t.elo]));
for (const [x, y] of PAIRS) {
  if (!profile.teams[x] || !profile.teams[y]) throw new Error(`側寫裡沒有 ${x} 或 ${y}`);
  if (!meta.model?.sim?.teams?.[x] || !meta.model?.sim?.teams?.[y]) throw new Error(`站上的模型沒有 ${x} 或 ${y} 的參數`);
}
/* λ 跟遊戲頁同一條路:站上的 Poisson 與 Elo 平均(blendPair)—— check-home 同一個寫法 */
const predOf = (h, a) => {
  const p = blendPair(meta.model.sim, h, a, eloBy.get(h), eloBy.get(a), {});
  return { xgHome: p.xgHome, xgAway: p.xgAway };
};
const eng = await import(source ? 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
  : pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));

const pool = createMatchPool({ root: ROOT, profile });
const specs = [];
for (const [x, y] of PAIRS) for (const [h, a] of [[x, y], [y, x]]) {
  const pred = predOf(h, a);
  for (let s = SEED0; s < SEED0 + N; s++) specs.push({ seed: s, home: h, away: a, pred, source });
}
pool.warm(specs);
const rows = [];
for (const sp of specs) {
  const st = (await pool.get(sp)).state(), c = st.counts;
  const pt = (st.poss?.home ?? 0) + (st.poss?.away ?? 0);
  const per = side => ({ goals: st.score[side === 'home' ? 0 : 1], shots: c.shotsBy?.[side] ?? 0, xg: st.xg?.[side] ?? 0,
    box: c.boxTouchAll?.[side] ?? 0, poss: pt ? 100 * st.poss[side] / pt : 50 });
  rows.push({ home: sp.home, away: sp.away, pred: sp.pred, h: per('home'), a: per('away') });
}
await pool.close();

/* 每個「隊 × 主客」一筆。射門預算(expShots)跟 check-home 一樣向引擎要,不在這裡自己算一份。 */
const ent = [];
for (const [x, y] of PAIRS) for (const [h, a] of [[x, y], [y, x]]) {
  const R = rows.filter(r => r.home === h && r.away === a);
  const sim0 = eng.createSim({ profile, home: h, away: a, seed: 1, pred: R[0].pred });
  const cal = sim0.calibration();
  /* 控球目標:引擎自己算的(`possTarget`,主隊的),客隊是它的補數。**不在這裡另外算一份** */
  const tH = sim0.possTarget();
  for (const side of ['home', 'away']) {
    const S = R.map(r => (side === 'home' ? r.h : r.a));
    const g = S.map(r => r.goals), shots = S.reduce((t, r) => t + r.shots, 0);
    ent.push({ pair: `${x}-${y}`, code: side === 'home' ? h : a, opp: side === 'home' ? a : h, side,
      lam: R[0].pred[side === 'home' ? 'xgHome' : 'xgAway'], goals: mean(g), se: sd(g) / Math.sqrt(g.length), n: g.length,
      shots: shots / g.length, expShots: cal[side].expShots, xgps: S.reduce((t, r) => t + r.xg, 0) / Math.max(1, shots),
      box: mean(S.map(r => r.box)), poss: mean(S.map(r => r.poss)), possSe: se(S.map(r => r.poss)),
      possT: tH == null ? null : (side === 'home' ? tH : 100 - tH) });
  }
}

report({ ent, PAIRS, title: `${PAIRS.length} 組 × 兩個方向 × ${N} 場(種子 ${SEED0}~${SEED0 + N - 1})${srcPath ? '・實驗版引擎 ' + srcPath : ''}`, verbose: VERBOSE });
if (flag('out')) writeFileSync(resolve(flag('out')), JSON.stringify({ ent, PAIRS, N, SEED0 }, null, 1));
