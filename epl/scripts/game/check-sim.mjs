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
 *
 * **場數少的時候 λ 錨會假警報。** 預設本來是 3 場,而 3 場的 SE 只有 0.33 ——
 * 同一份引擎 3 場量到「-4.0 SE 錨沒守住」、12 場量到 -2.5、30 場量到 -0.6。
 * 那不是引擎在飄,是 SE 本身的噪音。所以預設改成 12,而且會印出
 * 「這個場數驗得出多大的偏差」,不夠的時候只印不判。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createSim } = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
const profile = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'game', 'pl.json'), 'utf8'));
const RUNS = Math.max(1, parseInt(process.argv[2] ?? '12', 10));
const MIN_JUDGE = 10;            // 少於這個場數只印不判(SE 的噪音比要驗的偏差還大)
const HOME = 'ARS', AWAY = 'LIV';
const STEP = 1 / 60;

/* 一場:逐格推進並量「眼睛看得到的那一層」。
   瞬移的容差用**這個人自己的最高速**,不是一個全域常數 —— 每個人的上限本來就不同。 */
function play(seed, minutes = 90) {
  const sim = createSim({ profile, home: HOME, away: AWAY, seed, pred: PRED });
  /* 跑到**完場**為止,不是跑固定的分鐘數 —— 階段 3 之後有中場與補時,一場是 90 分鐘以上。
     guard 只是防無窮迴圈,不是比賽長度。 */
  const N = Math.round((minutes + 20) * 60 / STEP);
  let prev = null, jumps = 0, maxJump = 0, still = 0, samples = 0, half = null, swaps = 0;
  const bins = new Array(7).fill(0);
  for (let i = 0; i < N && !sim.state().over; i++) {
    sim.advance(STEP);
    const s = sim.state();
    bins[Math.min(6, Math.floor(Math.max(0, s.ball.x) / (105 / 7)))]++;
    /* 中場換邊那一格,二十二個人**依設計**被鏡射到對面 —— 那不是瞬移。
       第一版沒排除它,12 場印「263 次瞬移、最大 98.33 m ← 引擎有問題」,
       而追下去每一次都在第 45 分、每場剛好 22 次(= 全隊)。
       排的是**換半場的那一格**(不是「第 45 分」,補時會讓分鐘不準),
       代價是那一格真的有 bug 也看不到 —— 一場三十四萬格裡的一格,換一個不會說謊的數字。 */
    if (s.half !== half) { half = s.half; if (prev) swaps++; prev = null; }
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
  return { sim, st: sim.state(), m: sim.motion(), jumps, maxJump, still, samples, bins, swaps };
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
const swaps = rows.reduce((a, r) => a + r.swaps, 0);
line('瞬移(超過自己最高速)', `${totalJumps} 次`, totalJumps ? `最大 ${worstJump.toFixed(2)} m ← 引擎有問題` : `✓(換邊的 ${swaps} 格不算,見 play() 的註解)`);
const inside = rows.every(r => r.st.players.every(p => p.x >= -1.5 && p.x <= 106.5 && p.y >= -1.5 && p.y <= 69.5));
line('所有人都在場內', inside ? '✓' : '✗ 有人跑出球場');
/* 這一條原本寫「← 球的速度被蓋掉了」,那是**斷言原因**。實際量過兩種都會中:
   (a) 持球者的 local 變數過期,球停在腳下被人撿走(階段 1 踩過,一次 93/97 顆);
   (b) 射門力道不夠,球在門前滾到停,門將或後衛撿走(階段 2b 量到 12 場 5 次,
       球速 0、離門 5~6 m,4 次是門將 1 次是後衛)。
   所以這裡只講量到什麼,原因要去看 diag —— 鐵則一:不要寫一個查不到出處的因果。 */
const lost = rows.reduce((a, r) => a + (r.st.diag?.lostShot ?? 0), 0);
line('射門在飛行中被吃掉', `${lost} 次`, lost ? '← 有人在球過門線之前控到它,要去查是球停了還是被蓋掉' : '✓');

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
    /* 「±3 SE 內」只在場數夠的時候才是結論。場數少的時候 SE 大,任何偏差都會通過(看起來很安全),
       而 SE 的估計本身也在跳 —— 兩種錯都發生過。所以把**驗得出多大的偏差**一起印出來。 */
    const res = `這個場數只驗得出 ≥ ${(3 * s2).toFixed(2)} 球的偏差`;
    line(`${who}進球`, `${m.toFixed(2)} ± ${s2.toFixed(2)}`, RUNS < MIN_JUDGE
      ? `λ ${lam} → 差 ${sig.toFixed(1)} SE(${RUNS} 場,只印不判;${res})`
      : `λ ${lam} → 差 ${sig.toFixed(1)} SE ${Math.abs(sig) <= 3 ? '✓' : '← 錨沒守住'}(${res})`);
  }
}

/* 3. 逐項對回球隊自己的真實比率(rates 是分主客的,不是平的 —— 踩過) */
console.log('');
const rt = (code, where) => profile.teams[code]?.rates?.[where] ?? {};
const real = { sf: (rt(HOME, 'home').sf ?? 0) + (rt(AWAY, 'away').sf ?? 0), cf: (rt(HOME, 'home').cf ?? 0) + (rt(AWAY, 'away').cf ?? 0) };
/* 射門數要對的是 **expShots**(= 自己的 sf × 對手的 sa ÷ 聯盟平均),不是兩隊 sf 相加。
   sf 相加**不看對手防守** —— 兩支防守好的隊碰在一起,它會高估一大截(ARS vs LIV:30.4 對 23.5)。
   而 λ 的錨用的就是 expShots(`k = λ ÷ expShots ÷ 每球 xG`),所以拿 sf 相加當目標去調 urge,
   等於引擎照一個量調、錨照另一個量驗 —— 那正是階段 4e 修的那個系統性 25% 偏高。
   兩個都印:對的那個在前面,sf 相加放後面當參考(它是「不管對手是誰」的上限)。 */
{
  const c0 = rows[0].sim.calibration();
  const budget = (c0.home?.expShots ?? 0) + (c0.away?.expShots ?? 0);
  const got = mean(rows.map(r => r.st.counts.shots));
  line('每場射門', got.toFixed(1),
    `期望 ${budget.toFixed(1)}(= 各自 sf × 對手 sa ÷ 聯盟平均,λ 的錨用的就是它)→ 比值 ${(got / budget).toFixed(2)}`);
  line('  (參考)兩隊 sf 相加', real.sf.toFixed(1), '不看對手防守,所以是上限 —— 不要拿它調 urge');
}
{
  const rr = (code, where) => profile.teams[code]?.rates?.[where] ?? {};
  const realOn = (rr(HOME, 'home').stf ?? 0) + (rr(AWAY, 'away').stf ?? 0);
  line('每場射正', mean(rows.map(r => r.st.counts.onTarget)).toFixed(1), `真實 ${realOn.toFixed(1)}`);
}
line('每場角球', mean(rows.map(r => r.st.counts.corners.home + r.st.counts.corners.away)).toFixed(1), `真實 ${real.cf.toFixed(1)}`);
line('每場 xG(主:客)', `${mean(rows.map(r => r.st.xg.home)).toFixed(2)} : ${mean(rows.map(r => r.st.xg.away)).toFixed(2)}`);
line('每場界外球 / 球門球', `${mean(rows.map(r => r.st.counts.throwIns)).toFixed(0)} / ${mean(rows.map(r => r.st.counts.goalKicks)).toFixed(0)}`);
line('每場傳球 / 抄截', `${mean(rows.map(r => r.st.counts.passes)).toFixed(0)} / ${mean(rows.map(r => r.st.counts.tackles)).toFixed(0)}`);
/* 階段 3 加的:中場、補時、犯規與牌。真值都在側寫的 rates 裡(逐隊分主客),不是寫死的。 */
{
  const rr = (code, where) => profile.teams[code]?.rates?.[where] ?? {};
  const realF = (rr(HOME, 'home').fouls ?? 0) + (rr(AWAY, 'away').fouls ?? 0);
  const realY = (rr(HOME, 'home').yellow ?? 0) + (rr(AWAY, 'away').yellow ?? 0);
  line('整場長度', `${mean(rows.map(r => r.st.t / 60)).toFixed(1)} 分`,
    `上半補時 ${mean(rows.map(r => r.sim.events().find(e => e.type === 'half')?.extra ?? 0)).toFixed(1)} 分・下半 ${mean(rows.map(r => r.st.added)).toFixed(1)} 分`);
  line('每場犯規', mean(rows.map(r => r.st.counts.fouls.home + r.st.counts.fouls.away)).toFixed(1), `真實 ${realF.toFixed(1)}`);
  line('每場黃牌 / 紅牌', `${mean(rows.map(r => r.st.counts.cards.home + r.st.counts.cards.away)).toFixed(2)} / ${mean(rows.map(r => r.st.counts.reds.home + r.st.counts.reds.away)).toFixed(2)}`,
    `真實 ${realY.toFixed(2)} / 0.10`);
  line('控球串(賽後解讀吃這個)', mean(rows.map(r => r.sim.chains().length)).toFixed(0));
  /* 控球(2026-09-17,階段 2c)。目標值**跟引擎要**(`possTarget`),不在這裡自己算一份 ——
     兩邊各寫一份式子的話,改了引擎那邊的推法,這支檢查會拿舊式子去判它。
     這裡印的是這一組配對;跨配對的擬合(模擬會不會只是永遠停在 50%)是校準時做的事,
     掃描紀錄留在 game-sim.js 的 POSS_K 註解裡。 */
  const want = rows[0].sim.possTarget();
  const got = (() => {
    const h = rows.reduce((a, r) => a + r.st.poss.home, 0), a2 = rows.reduce((a, r) => a + r.st.poss.away, 0);
    return h + a2 > 0 ? h / (h + a2) * 100 : null;
  })();
  if (got != null) line('控球(主隊)', `${got.toFixed(1)}%`, want == null ? '側寫沒有控球率' : `目標 ${want.toFixed(1)}%(從兩隊真實的主客控球率推)`);

  /* 階段 4b(2026-09-17):十二碼、助攻、進球情境。
     十二碼的真值是從側寫推的,不是寫死的:Penalty 佔射門 share × 每隊每場射門 × 2 隊。
     助攻**只印不判** —— 本站唯一的助攻資料是 FPL 的定義(贏得十二碼、被撲出後補進都算,
     實測助攻/進球 0.905~0.937),跟這裡算的「進球前一腳傳到射手腳下」不是同一件事。
     拿定義不同的兩個數字互比,就是本站在衝刺次數上踩過的那個坑。 */
  const pen = profile.league_?.shotSituations?.Penalty;
  const realPen = pen ? pen.share * profile.league_.rates.sf * 2 : null;
  line('每場十二碼', mean(rows.map(r => r.st.counts.pens.home + r.st.counts.pens.away)).toFixed(2),
    realPen == null ? '側寫沒有十二碼情境' : `真實 ${realPen.toFixed(2)}(Penalty 佔射門 ${pen.share} × 每隊 ${profile.league_.rates.sf} 射門 × 2)`);
  const gl = rows.reduce((a, r) => a + r.st.score[0] + r.st.score[1], 0);
  const asts = rows.reduce((a, r) => a + r.st.counts.assists.home + r.st.counts.assists.away, 0);
  line('助攻 / 進球', gl ? (asts / gl).toFixed(3) : '—',
    '只回報 —— 本站的助攻真值是 FPL 定義(較寬鬆),跟這裡的「進球前一腳」不能比');
}

/* 2f. 射門情境的分佈。真值是側寫的 shotSituations share(FotMob 逐射門分類)。
      **引擎分得出來的只有六種**,分不出來的那兩種照實印出來說「不做」,不要偷偷併進別人。 */
{
  const real = profile.league_?.shotSituations ?? {};
  const sit = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.st.counts.shotSit ?? {})) sit[k] = (sit[k] ?? 0) + v;
  const tot = Object.values(sit).reduce((a, b) => a + b, 0);
  if (tot > 0) {
    console.log('');
    for (const k of ['RegularPlay', 'FromCorner', 'FastBreak', 'ThrowInSetPiece', 'SetPiece', 'Penalty']) {
      line(`情境 ${k}`, `${((sit[k] ?? 0) / tot * 100).toFixed(1)}%`, `真實 ${((real[k]?.share ?? 0) * 100).toFixed(1)}%`);
    }
    line('情境(引擎不分)', `FreeKick ${((real.FreeKick?.share ?? 0) * 100).toFixed(1)}% · IndividualPlay ${((real.IndividualPlay?.share ?? 0) * 100).toFixed(1)}%`,
      '直接罰球射門與單人突破沒有可靠判準,不假裝分得出來');
  }
}

/* 3b. 射門的**離門距離分佈**。真值不是我寫的數字,是倉庫裡 FotMob 逐場 shotmap 的座標算出來的
       —— 這樣資料變了它自己會變(而且「真實是多少」永遠查得到出處)。
       為什麼要看分佈而不是只看每球平均 xG:只對平均值的話,一堆六公尺的射門配一個很小的
       xG 係數也會「對上」,而那是把形狀調錯之後再用水準去湊。 */
const realShots = (() => {
  const bins = new Array(7).fill(0); let n = 0, ds = 0, box = 0, xg = 0;
  /* **逐情境**也收一份(階段 4i)。總和對上不代表每一種都對:實測本站總和 15.1 m
     看起來只差一點,拆開才看到角球是 15.0 m(真實 12.7)而且 69% 擠在 15~20 m 一格。 */
  const bySit = {};
  for (const f of ['2025-26-game-details.json', '2026-27-game-details.json']) {
    const path = join(ROOT, 'data', 'raw', 'fotmob-epl', f);
    if (!existsSync(path)) continue;
    const j = JSON.parse(readFileSync(path, 'utf8'));
    for (const m of Object.values(j.matches ?? {})) for (const sh of (m.shots ?? [])) {
      if (sh.x == null || sh.y == null) continue;
      const d = Math.hypot(105 - sh.x, 34 - sh.y);
      bins[Math.min(6, Math.floor(d / 5))]++; n++; ds += d; if (sh.inBox) box++;
      if (sh.xg != null) xg += sh.xg;
      const b = (bySit[sh.situation ?? '(無)'] ??= { n: 0, dsum: 0, bins: new Array(7).fill(0) });
      b.n++; b.dsum += d; b.bins[Math.min(6, Math.floor(d / 5))]++;
    }
  }
  return n ? { n, dist: ds / n, box: box / n, xg: xg / n, bins: bins.map(b => b / n), bySit } : null;
})();
const simShots = (() => {
  const bins = new Array(7).fill(0); let n = 0, ds = 0, box = 0, xg = 0;
  for (const r of rows) {
    const c = r.st.counts;
    for (let b = 0; b < 7; b++) bins[b] += c.shotBins[b];
    n += c.shots; ds += c.shotDsum; box += c.shotInBox; xg += r.st.xg.home + r.st.xg.away;
  }
  return n ? { n, dist: ds / n, box: box / n, xg: xg / n, bins: bins.map(b => b / n) } : null;
})();
if (simShots && realShots) {
  const pc = a => a.map(v => `${Math.round(v * 100)}%`).join(' ');
  line('射門離門距離', `${simShots.dist.toFixed(1)} m`, `真實 ${realShots.dist.toFixed(1)} m(${realShots.n} 顆)`);
  line('射門在禁區內', `${(simShots.box * 100).toFixed(0)}%`, `真實 ${(realShots.box * 100).toFixed(0)}%`);
  line('每球 xG', simShots.xg.toFixed(4), `真實 ${realShots.xg.toFixed(4)}`);
  console.log(`  ${'離門 0-5/5-10/…/30+'.padEnd(26, '\u3000')} ${pc(simShots.bins)}`);
  console.log(`  ${'真實'.padEnd(26, '\u3000')} ${pc(realShots.bins)}`);
}

/* 3b-2. **逐情境**的離門分佈(階段 4i)。總和是幾種情境的混合,它對上只代表混出來的平均對上 ——
         而每一種的形狀可以整個是錯的。真實的三個形狀差很多:RegularPlay 17.1 m、
         FromCorner 12.7 m、FreeKick 26.7 m,所以要各自對各自。 */
{
  const simSit = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.st.counts.sitBins ?? {})) {
    const a = (simSit[k] ??= { n: 0, dsum: 0, bins: new Array(7).fill(0) });
    a.n += v.n; a.dsum += v.dsum; v.bins.forEach((b, i) => { a.bins[i] += b; });
  }
  const keys = Object.keys(simSit).filter(k => simSit[k].n >= 20)
    .sort((a, b) => simSit[b].n - simSit[a].n);
  if (keys.length && realShots?.bySit) {
    console.log('');
    console.log(`  ${'情境的離門分佈'.padEnd(20, '\u3000')} 平均   0-5 5-10 10-15 15-20 20-25 25-30 30+`);
    const row = (label, a) => `  ${label.padEnd(20, '\u3000')} ${(a.dsum / a.n).toFixed(1).padStart(5)}m `
      + a.bins.map(b => String(Math.round(b / a.n * 100)).padStart(4)).join('');
    for (const k of keys) {
      console.log(row(`  ${k}`, simSit[k]));
      const r = realShots.bySit[k];
      if (r) console.log(row('    真實', r));
    }
    /* 驗收的那兩個數字(RegularPlay 的 0~10 與 10~20 合計,階段 4m 定的)要附**以場為單位**
       的標準誤。逐顆射門的二項式 `√(p(1−p)/射門數)` 把「同一場裡的射門互相獨立」當前提,
       而那不一定成立:禁區戰打得多的那一場會一次貢獻一堆近距離射門。
       **實測下來差得不多**:50 場、714 顆 RegularPlay 射門,二項式 1.74 pp、
       以場為單位的 jackknife 1.90 pp —— 只低估 1.1 倍(一場才 15 顆 RegularPlay 射門,
       沒什麼可叢集的)。我原本從「換一組種子 share 跳 4.4 個百分點」推論低估 1.8~2.5 倍,
       **直接量一次就推翻了**:那 4.4 個百分點只有 1.6 個 SE,本來就是噪音。
       留 jackknife 是因為它問的才是對的問題(獨立的單位是場不是球),不是因為差很多。
       真正要記住的是另一件事:**同一個種子換一個旗標不會給出同一場比賽**
       (引擎是決定性的,但旗標改了 rng 抽籤的次數就對不上,整條序列錯開 ——
       接十二碼那一段的註解本來就寫著)。所以開/關**不是成對比較**,
       差值的標準誤要照兩個獨立樣本算:√2 × 1.9 ≈ 2.7 pp。
       階段 4n 的四個配置差值是 +1.4 / +1.0 / −1.9 / −1.8 pp,全部在 1 個 SE 以內。 */
    const per = rows.map(r => r.st.counts.sitBins?.RegularPlay)
      .filter(v => v && v.n > 0)
      .map(v => ({ n: v.n, lo: v.bins[0] + v.bins[1], mid: v.bins[2] + v.bins[3] }));
    const realRP = realShots.bySit.RegularPlay;
    if (per.length > 2 && realRP) {
      const jack = key => {
        const tot = per.reduce((a, m) => a + m.n, 0), num = per.reduce((a, m) => a + m[key], 0);
        const g = per.length;
        const ps = per.map(m => (num - m[key]) / (tot - m.n) * 100);
        const mu = ps.reduce((a, x) => a + x, 0) / g;
        return { v: num / tot * 100, se: Math.sqrt((g - 1) / g * ps.reduce((a, x) => a + (x - mu) ** 2, 0)) };
      };
      const lo = jack('lo'), mid = jack('mid');
      const rTot = realRP.bins.reduce((a, b) => a + b, 0);
      const rLo = (realRP.bins[0] + realRP.bins[1]) / rTot * 100, rMid = (realRP.bins[2] + realRP.bins[3]) / rTot * 100;
      console.log(`  ${'    驗收 0~10 / 10~20'.padEnd(20, '\u3000')} `
        + `${lo.v.toFixed(1)}% ± ${lo.se.toFixed(1)} / ${mid.v.toFixed(1)}% ± ${mid.se.toFixed(1)}`
        + `　真實 ${rLo.toFixed(1)} / ${rMid.toFixed(1)}`);
      console.log(`  ${'    (標準誤以場為單位 —— 逐顆射門的二項式會低估,見上面那段註解)'.padEnd(20, '\u3000')}`);
    }
  }
}

/* 3b-3. **射門 = 機會 × 扣扳機機率**(階段 4k)。只看射門的分佈分不出兩件完全不同的事:
         「球太常在那裡」還是「在那裡太愛射」。最後一欄回推**要生出真實的分佈,
         每一格的機率得是多少** —— 如果那個數字在近距離低得離譜(真人在三公尺當然會射),
         那錯的就不是選擇,是機會的分佈,而那要改的是別的東西。 */
{
  const n = new Array(7).fill(0), sh = new Array(7).fill(0);
  for (const r of rows) {
    const o = r.st.counts.oppBins; if (!o) continue;
    o.n.forEach((v, i) => { n[i] += v; }); o.shot.forEach((v, i) => { sh[i] += v; });
  }
  const totN = n.reduce((a, b) => a + b, 0), totS = sh.reduce((a, b) => a + b, 0);
  const realBins = realShots?.bySit?.RegularPlay?.bins;
  if (totN > 0 && totS > 0 && realBins) {
    const realN = realBins.reduce((a, b) => a + b, 0);
    const LAB = ['0-5', '5-10', '10-15', '15-20', '20-25', '25-30', '30+'];
    console.log('');
    console.log(`  ${'射程內的決策點'.padEnd(20, '\u3000')} 機會%   射門%  真實%   扣扳機   要對上真實得是`);
    for (let i = 0; i < 7; i++) {
      const need = n[i] > 0 ? realBins[i] / realN * totS / n[i] : NaN;
      console.log(`  ${('  ' + LAB[i]).padEnd(20, '\u3000')}`
        + `${(n[i] / totN * 100).toFixed(1).padStart(5)}%${(sh[i] / totS * 100).toFixed(1).padStart(7)}%`
        + `${(realBins[i] / realN * 100).toFixed(0).padStart(6)}%${(sh[i] / n[i]).toFixed(3).padStart(9)}`
        + `${need.toFixed(3).padStart(16)}`);
    }
    console.log(`  ${'（真實那一欄是 RegularPlay 的離門分佈;扣扳機機率的上限是 0.9)'.padEnd(20, '\u3000')}`);
  }
}

/* 3b-4. **對抗那一層**(階段 4q 找到錨,4r 照它重寫)。本站四輪防守側的修正(4k 放大半徑、
         4n 門將碰持球者、4o 逼搶者站到球門那一側、4p 換分母)全部死在「抄截與犯規爆炸」上,
         而我一路以為沒有東西可以校準那一層 —— **側寫的 `extra` 與 `rates` 裡就有**。
         三個錨(抄截 / 犯規 / 過人成功)由**引擎**從側寫算並吐出來(`duelAnchors()`),
         這裡不自己再算一份 —— 兩份會悄悄過期。 */
{
  const A = rows[0]?.sim?.duelAnchors?.() ?? null;
  const avg = f => rows.reduce((a, r) => a + f(r.st.counts), 0) / rows.length;
  const se = f => {
    const v = rows.map(r => f(r.st.counts)), m = v.reduce((a, b) => a + b, 0) / v.length;
    return v.length < 2 ? 0 : Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1) / v.length);
  };
  console.log('');
  if (!A) {
    console.log('  對抗那一層:側寫算不出錨(缺 extra 或 rates)—— 只印本站的數字,不判');
    console.log(`  ${'對抗'.padEnd(14, '\u3000')} ${avg(c => c.duels ?? 0).toFixed(1)}`
      + `\u3000抄截 ${avg(c => c.tackles).toFixed(1)}\u3000犯規 ${avg(c => c.fouls.home + c.fouls.away).toFixed(1)}`
      + `\u3000過人成功 ${avg(c => c.dribbles ?? 0).toFixed(1)}`);
  } else {
    console.log('  對抗那一層(階段 4r:一次對抗判一次,三種結局把它拆完)');
    const line = (名稱, f, real) => {
      const v = avg(f), e = se(f);
      const 判 = e > 0 && Math.abs(v - real) > 2 * e ? `**差 ${((v - real) / e).toFixed(1)} SE**` : '✓';
      console.log(`  ${名稱.padEnd(14, '\u3000')} ${v.toFixed(1).padStart(6)} ± ${e.toFixed(1)}`
        + `\u3000真實 ${real.toFixed(1)}\u3000${判}`);
    };
    line('一場的對抗次數', c => c.duels ?? 0, A.duels);
    line('　抄截', c => c.tackles, A.tackles);
    line('　犯規', c => c.fouls.home + c.fouls.away, A.fouls);
    line('　過人成功', c => c.dribbles ?? 0, A.dribbles);
    /* 「對抗總數」的真實值是三種結局相加,而地面對抗自己也有一個數字 —— 兩個各自算出來
       卻對得上,那是很強的線索不是證明,所以印出來但不當判準。 */
    const teams = Object.values(profile.teams ?? {}).filter(t => t.extra?.ground_duels_won?.mean != null);
    const gn = teams.reduce((a, t) => a + t.extra.ground_duels_won.n, 0);
    const gd = gn ? teams.reduce((a, t) => a + t.extra.ground_duels_won.mean * t.extra.ground_duels_won.n, 0) / gn : null;
    if (gd) console.log(`  ${'（三種結局相加'.padEnd(14, '\u3000')} ${A.duels.toFixed(1)}`
      + `,而 ground_duels_won 兩隊合計 ${(gd * 2).toFixed(1)} —— 線索,不是判準)`);
    /* 接觸**不是**對抗:這一行是 4r 的判準來源 —— 站位改動會把「判定跑了多久」放大 4.5 倍,
       而「碰到幾次」幾乎不變(×1.06)。判定掛在更穩的帶球決策上(×1.01)才脫得了鉤。 */
    console.log(`  ${'　（參考)進到抄截半徑的次數'.padEnd(14, '\u3000')} ${avg(c => c.contacts ?? 0).toFixed(0).padStart(6)}`
      + `\u3000在半徑內的秒數 ${(avg(c => c.contactFrames ?? 0) / 60).toFixed(0)} 秒`
      + ` —— 這兩個都**不是**對抗,只是幾何`);
  }
}

/* 3c. 越位與逼搶。兩個都有真值:越位是 shotmap 同一份檔案裡的 teamStats.offsides,
       逼搶是側寫的 `style.pressing`(每 100 次對手傳球的抄截 + 攔截,FotMob 逐場、非 proxy)。
       傳球成功率**只印不判** —— 本站的擷取裡 `passAccuracy` 840 個隊季場全是 null,沒有真值。 */
const realOffside = (() => {
  let n = 0, sum = 0;
  for (const f of ['2025-26-game-details.json', '2026-27-game-details.json']) {
    const path = join(ROOT, 'data', 'raw', 'fotmob-epl', f);
    if (!existsSync(path)) continue;
    const j = JSON.parse(readFileSync(path, 'utf8'));
    for (const m of Object.values(j.matches ?? {})) for (const ts of Object.values(m.teamStats ?? {}))
      if (ts.offsides != null) { sum += ts.offsides; n++; }
  }
  return n ? sum / n : null;
})();
console.log('');
for (const [side, code, opp] of [['home', HOME, 'away'], ['away', AWAY, 'home']]) {
  const off = mean(rows.map(r => r.st.counts.offsides[side]));
  const acts = mean(rows.map(r => r.st.counts.tacklesBy[side] + r.st.counts.intercepts[side]));
  const oppPass = mean(rows.map(r => r.st.counts.passBy[opp]));
  const ok = mean(rows.map(r => r.st.counts.passOk[side]));
  const mine = mean(rows.map(r => r.st.counts.passBy[side]));
  const pv = profile.teams[code]?.style?.pressing?.value;
  line(`${code} 越位`, off.toFixed(2), realOffside == null ? '' : `真實 ${realOffside.toFixed(2)}`);
  line(`${code} 逼搶(每100對手傳球)`, (acts / Math.max(1, oppPass) * 100).toFixed(2), pv == null ? '' : `真實 ${pv}`);
  line(`${code} 傳球 / 傳到隊友`, `${mine.toFixed(0)} / ${ok.toFixed(0)} = ${(ok / Math.max(1, mine) * 100).toFixed(1)}%`, '只回報(本站沒有真實的傳球成功率)');
}
/* 逼搶那一行的**定義對不齊**,要講出來:本站數的是「對方踢出來的球被我方控到」的全部次數,
   而 FotMob 的 tackles + interceptions 是兩個特定事件,亂戰中的解圍與撿球不算。
   所以模擬的數字本來就會比真實大 —— 它能看**趨勢**(調鬆了會漲),不能當成「差幾倍就是錯幾倍」。
   這是本站踩過很多次的「我的分母跟被比較的那一邊是不是同一批」。 */
console.log('  （逼搶那一行的定義比 FotMob 寬:本站把所有「對方的球被我控到」都算進去,數字本來就會偏大）');
/* 傳球失敗的原因分類 —— 找根因時唯一有用的那一行。第一次跑出來是
   「接球者就在四公尺內卻被別人拿走」佔 76%,那才把問題指到「接球者沒有優先權」上;
   在那之前我以為是傳球失準或被折射。 */
const why = rows.reduce((a, r) => { for (const k of ['defl', 'near', 'far']) a[k] += r.st.counts.why?.[k] ?? 0; return a; },
  { defl: 0, near: 0, far: 0 });
const lostAll = why.defl + why.near + why.far;
if (lostAll) console.log(`  ${'傳球失敗的原因'.padEnd(26, '\u3000')} 被折射 ${(why.defl / lostAll * 100).toFixed(0)}%`
  + ` / 接球者在旁邊卻被搶走 ${(why.near / lostAll * 100).toFixed(0)}%`
  + ` / 接球者不在那裡 ${(why.far / lostAll * 100).toFixed(0)}%`);

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
