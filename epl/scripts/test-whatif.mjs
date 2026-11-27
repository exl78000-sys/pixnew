/* 「如果…會怎樣」(2026-11-27,N4)的守門。

   畫面講「一場都不指定時,這裡的數字跟預測分頁相同」—— 那是一句要驗的宣稱,不是設計目標。
   它成立要三件事同時對:同一份模擬程式(season-sim.js)、同一組強度參數(meta.model.sim)、
   同一組名額與種子(meta.model.simConfig),外加瀏覽器從 fixtures.json 組出來的輸入跟建站用的同一批。
   所以這裡**拿瀏覽器那一段(seasonInputs)在 Node 裡重跑**,逐聯賽逐隊比 sim.json。
   聯賽清單掃 web/data/leagues/(手寫清單的坑踩過五次)。 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runSeason, seasonInputs } from '../web/assets/js/season-sim.js';

const ROOT = new URL('../web/data/', import.meta.url).pathname;
let fail = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) fail++;
};
const load = (dir, f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

const dirs = [['pl', ROOT], ...readdirSync(join(ROOT, 'leagues')).sort()
  .map(k => [k, join(ROOT, 'leagues', k)]).filter(([, d]) => existsSync(join(d, 'meta.json')))];
console.log(`\n▶ 如果…會怎樣:瀏覽器重跑 = 建站的模擬(${dirs.length} 個聯賽)`);

let tried = 0;
for (const [lg, dir] of dirs) {
  const meta = load(dir, 'meta.json'), fixtures = load(dir, 'fixtures.json'), sim = load(dir, 'sim.json');
  const cfg = meta.model?.simConfig;
  check(cfg && Number.isInteger(cfg.runs) && Number.isInteger(cfg.seed) && Number.isInteger(cfg.relegated),
    `${lg}:meta 帶模擬設定(名額與種子)`, JSON.stringify(cfg ?? null));
  check(cfg?.runs === meta.model?.simulationRuns, `${lg}:設定的模擬次數 = 畫面寫的次數`, `${cfg?.runs} vs ${meta.model?.simulationRuns}`);
  const inp = seasonInputs(meta, fixtures);
  if (!inp) { console.log(`  · ${lg}:沒有未賽的聯賽場次,略過重跑`); continue; }
  tried++;
  const t0 = Date.now();
  const mine = runSeason(inp);
  const ms = Date.now() - t0;
  const byCode = new Map(sim.map(r => [r.code, r]));
  const KEYS = ['expectedPoints', 'expectedPos', 'titlePct', 'promotionPct', 'playoffPct', 'top4Pct', 'top6Pct', 'relegationPct', 'relegationPlayoffPct'];
  /* 容差:lambdaFromSim 是 exp 相乘、建站是 exp(加總),浮點末位的差偶爾讓某一次 Poisson 抽樣跨過門檻。
     實測六個聯賽一個都沒差;留 0.2 個百分點 / 0.2 分,比「一場改判」的影響(1 / runs = 0.01%)大得多,
     比任何「指定一場結果」造成的變化小得多。 */
  const diffs = [];
  for (const r of mine) {
    const o = byCode.get(r.code);
    if (!o) { diffs.push(`${r.code} 不在 sim.json`); continue; }
    for (const k of KEYS) if ((r[k] ?? null) !== null || (o[k] ?? null) !== null) {
      if (Math.abs((r[k] ?? NaN) - (o[k] ?? NaN)) > 0.2 || (r[k] == null) !== (o[k] == null)) diffs.push(`${r.code}.${k} ${r[k]} vs ${o[k]}`);
    }
    const pd = r.posDist.reduce((m, v, i) => Math.max(m, Math.abs(v - (o.posDist[i] ?? 0))), 0);
    if (pd > 0.2) diffs.push(`${r.code}.posDist 最大差 ${pd.toFixed(1)}`);
  }
  check(mine.length === sim.length && !diffs.length, `${lg}:不指定任何一場時,逐隊逐欄位等於 sim.json`,
    diffs.length ? diffs.slice(0, 4).join('、') : `${mine.length} 隊・${ms} ms`);

  /* 指定結果真的有作用,而且方向對:讓積分榜第一的那一隊剩下的比賽全輸,奪冠機率要掉;全贏要升(或已經是 100)。 */
  const top = [...mine].sort((a, b) => b.titlePct - a.titlePct)[0].code;
  const mineFx = inp.fixtures.filter(f => f.home === top || f.away === top).slice(0, 6);
  const as = want => new Map(mineFx.map(f => [`${f.home}|${f.away}`, f.home === top ? want : ({ H: 'A', A: 'H', D: 'D' })[want]]));
  const lose = runSeason({ ...inp, fixed: as('A') }).find(r => r.code === top);
  const win = runSeason({ ...inp, fixed: as('H') }).find(r => r.code === top);
  const base = mine.find(r => r.code === top);
  check(lose.titlePct < base.titlePct && win.titlePct >= base.titlePct,
    `${lg}:指定 ${top} 接下來 ${mineFx.length} 場全輸 / 全贏,奪冠機率往對的方向動`,
    `${lose.titlePct} < ${base.titlePct} ≤ ${win.titlePct}`);
  /* 指定的場次一定照指定結果:預期積分全贏時至少多拿「每場 3 分減掉原本期望」—— 直接驗下限:全輸的期望積分 = 目前積分 + 其餘場次,低於全贏。 */
  check(win.expectedPoints - lose.expectedPoints >= 3 * mineFx.length - 1,
    `${lg}:全贏與全輸的期望積分差 ≥ 每場 3 分`, `${(win.expectedPoints - lose.expectedPoints).toFixed(1)} vs ${3 * mineFx.length}`);
}
check(tried > 0, '至少有一個聯賽真的重跑過', `${tried}`);

/* 真資料驗不到的兩件事(季中沒有升班馬先驗、本季附加賽五月才有):捏一份,直接驗 seasonInputs 的輸出。
   負向對照實測過:拿掉這兩條,把「忽略先驗」「混進附加賽」貼回去,上面那幾條一條都不紅。 */
{
  const meta = { currentSeason: 'S', model: { promotedPrior: ['C'], simConfig: { runs: 10, seed: 1, relegated: 1 },
    sim: { base: 1.3, homeAdv: 1.1, teams: { A: { att: 1, def: 1 }, B: { att: 1, def: 1 }, C: { att: 1, def: 1 } } } } };
  const fx = [
    { season: 'S', home: 'A', away: 'B', played: true, fh: 1, fa: 0 },
    { season: 'S', home: 'B', away: 'C', played: false },
    { season: 'S', home: 'A', away: 'C', played: false, stage: 'playoff' },
    { season: 'P', home: 'C', away: 'A', played: false },
  ];
  const inp = seasonInputs(meta, fx);
  check(inp?.promoted?.length === 1 && inp.promoted[0] === 'C', '升班馬先驗跟著 meta 帶進模擬', JSON.stringify(inp?.promoted));
  check(inp?.fixtures?.length === 1 && inp.fixtures[0].home === 'B' && inp.played.length === 1,
    '只收本季的聯賽場次(附加賽與別季不算)', `未賽 ${inp?.fixtures?.length}、已賽 ${inp?.played?.length}`);
}

/* 共用的那一份:建站的 simulate.mjs 只包一層,不准自己再寫一份蒙地卡羅。 */
const wrap = readFileSync(new URL('./lib/simulate.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check(/from '\.\.\/\.\.\/web\/assets\/js\/season-sim\.js'/.test(wrap) && !/Math\.random|gauss|SIGMA_|posHist|xorshift|s \^= s/.test(wrap),
  '建站的模擬走共用的 season-sim.js,沒有自己再寫一份');
const view = readFileSync(new URL('../web/assets/js/whatif-view.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check(/seasonInputs\(/.test(view) && !/lambdaFromSim\(/.test(view), '畫面組輸入走 seasonInputs(測試驗的就是那一段)');

console.log(fail ? `\n✗ 如果…會怎樣:${fail} 條沒過` : '\n✓ 如果…會怎樣:全部通過');
process.exit(fail ? 1 : 0);
