#!/usr/bin/env node
/* 國家隊:評分落後 N 天的代價,掃一條曲線(2026-10-05;使用者:「重量落後六週的代價」)
 *
 * 為什麼有這支:09-25 量的是「落後一週」(build 固定 `days: 7`),結論是沒有大過兩倍標準誤,所以不拿未核對的賽果做暫定更新。
 * 而 martj42 的檔案 08-26 之後沒再更新 —— 上游自己停的(抓下來跟倉庫那份逐位元組相同),不是本站抓不到 ——
 * 實際落後已經六週以上,當時的結論回答的是另一個情境。這支把**同一個量**(lib/intl.mjs 的 intlLagCost)掃過
 * 7~90 天,再用「現在上架的未賽場次」的狀態推這一批預期多付多少。
 *
 * 三節:
 *   A. 落後 N 天的代價。同一批驗收場次(2022 起),正常走查 vs N 天前凍結的評分,逐場成對比 RPS(正值 = 落後讓預測變差)。
 *      N = 7 那一行要逐位等於產物 intl.json 的 model.lag —— 對不上就是這支或 build 其中一個壞了。
 *   B. 依「評分沒算到的場數」分層:凍結日到開賽日之間兩隊各自踢了幾場、加總(0-2 / 3-4 / 5 以上)。
 *   C. 現在上架那一批(有勝率的未賽場次):兩隊合計沒算到的場數分佈、離評分截止日多遠,
 *      以及用 B 的分層**照這一批的場數分佈加權**出來的預期代價。
 *      **C 是估計不是直接量到的**:分層的每一格是驗收期的樣本,現在這批沒有真值可以比;加權時把各格當成互相獨立,
 *      SE 照這個算。場數是「現在」數的 —— 還沒開賽的場次到開賽時只會更多,所以這個估計偏低(假設上游一直沒更新)。
 *      C 要 FotMob 的快取(data/raw/fotmob-intl/,runner 抓、倉庫有回寫那一份);沒有就略過。
 *
 *   npm run intl:lag
 * 唯讀:不寫任何檔、零請求。數字會隨資料變,引用就重跑,不要抄文件裡的。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseIntlResults, parseShootouts, backtestIntl, frequencyBaseline, pairedGain, intlLagCost,
  INTL_HOLDOUT, INTL_MIN_GAMES, intlPasses,
} from './lib/intl.mjs';
import { loadIntlTeamTable } from './lib/intl-teams.mjs';
import { assembleIntl, loadRaws } from './build-intl.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const f4 = x => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(4)}`);
const z1 = x => (x == null ? '—' : x.toFixed(1));
const dayMs = 86400000;

const mjPath = join(ROOT, 'data', 'raw', 'intl', 'results.csv');
if (!existsSync(mjPath)) { console.log('沒有 data/raw/intl/results.csv(先跑 npm run intl:results)'); process.exit(0); }
const mj = parseIntlResults(readFileSync(mjPath, 'utf8'));
const params = JSON.parse(readFileSync(join(ROOT, 'data', 'intl-elo-params.json'), 'utf8'));
const P = params.params, minGames = params.minGames ?? INTL_MIN_GAMES, from = INTL_HOLDOUT.from;
const lastDate = mj.at(-1)?.date;

const hold = backtestIntl(mj, P, { from, minGames });
const g = pairedGain(hold, frequencyBaseline(hold));
console.log(`martj42 ${mj.length} 場(到 ${lastDate},距今 ${Math.round((Date.now() - Date.parse(lastDate)) / dayMs)} 天)・驗收 ${g.n} 場:模型對基準線改善 ${g.gain.toFixed(4)} ± ${g.se.toFixed(4)}`);

/* ── A. 曲線。再加一列「現在實際落後幾天」(今天 − 評分截止日),build 固定量 7 天,看不到這一格 ── */
const liveDays = Math.round((Date.now() - Date.parse(lastDate)) / dayMs);
const DAYS = [...new Set([7, 14, 21, 30, 38, 42, 45, 60, 90, liveDays])].sort((a, b) => a - b);
console.log('\n▶ A. 落後 N 天的代價(正值 = 落後讓預測變差;受影響 = 兩隊至少一隊在那幾天裡踢過)');
const row = x => `${String(x.n).padStart(5)} 場 ${f4(x.cost)} ± ${x.se.toFixed(4)} (z ${z1(x.z)})`;
for (const days of DAYS) {
  const r = intlLagCost(mj, P, { from, minGames, days });
  const pass = intlPasses({ gain: r.affected.cost, se: r.affected.se });
  console.log(`  ${String(days).padStart(3)} 天${days === liveDays ? '(現在)' : '      '} 全部 ${row(r.all)} | 受影響 ${row(r.affected)} | ${pass ? '大過兩倍標準誤' : '沒有大過'}・佔模型整體改善 ${(r.affected.cost / g.gain * 100).toFixed(1)}%`);
}

/* ── B. 依「評分沒算到的場數」分層 ── */
const stat = xs => {
  const n = xs.length;
  if (n < 2) return { n, cost: xs[0] ?? null, se: null, z: null };
  const m = xs.reduce((a, x) => a + x, 0) / n;
  const se = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1) / n);
  return { n, cost: m, se, z: se ? m / se : null };
};
const GROUPS = ['0-2', '3-4', '5+'];
const groupOf = k => (k <= 2 ? '0-2' : k <= 4 ? '3-4' : '5+');
const strata = {};
console.log('\n▶ B. 依「評分沒算到的場數」分層(凍結日到開賽日之間,兩隊各自踢過幾場、加總)');
for (const days of [42, 60, 90]) {
  const { rows } = intlLagCost(mj, P, { from, minGames, days, detail: true });
  strata[days] = Object.fromEntries(GROUPS.map(b => [b, stat(rows.filter(r => groupOf(r.k) === b).map(r => r.diff))]));
  console.log(`  落後 ${days} 天:` + GROUPS.map(b => { const s = strata[days][b]; return `${b} 場 ${s.n} 場 ${f4(s.cost)} ± ${s.se?.toFixed(4) ?? '—'}(z ${z1(s.z)})`; }).join(' | '));
}

/* ── C. 現在上架那一批 ── */
const rawsDir = join(ROOT, 'data', 'raw', 'fotmob-intl');
const raws = existsSync(rawsDir) ? loadRaws(rawsDir) : {};
if (!Object.keys(raws).length) { console.log('\n▶ C. 沒有 FotMob 快取(data/raw/fotmob-intl/),略過現在上架那一批'); process.exit(0); }
const soPath = join(ROOT, 'data', 'raw', 'intl', 'shootouts.csv');
const out = assembleIntl({ mj, shootouts: existsSync(soPath) ? parseShootouts(readFileSync(soPath, 'utf8')) : new Map(), mjMeta: null, params,
  table: loadIntlTeamTable(ROOT), raws, builtAt: new Date().toISOString(), flags: null });
const fetched = Object.values(raws).map(r => r.retrievedAt).filter(Boolean).sort().at(-1);
const slate = out.fixtures.filter(f => f.prob);
const kOf = f => (f.lag?.[0] ?? 0) + (f.lag?.[1] ?? 0);
const asOfT = Date.parse(out.model.ratingsAsOf);
const daysOf = f => (Date.parse(f.kickoff) - asOfT) / dayMs;
const med = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];
console.log(`\n▶ C. 現在上架(有勝率)的 ${slate.length} 場(FotMob 快取最後抓取 ${fetched};模型驗收 ${out.model.passed ? '通過' : '沒通過'};已完賽核對 ${JSON.stringify(out.checkCounts)})`);
if (!slate.length) process.exit(0);
const cnt = Object.fromEntries(GROUPS.map(b => [b, slate.filter(f => groupOf(kOf(f)) === b).length]));
console.log(`  兩隊合計沒算到的場數:0-2 場 ${cnt['0-2']}・3-4 場 ${cnt['3-4']}・5 場以上 ${cnt['5+']}(其中至少一隊沒算到:${slate.filter(f => kOf(f) > 0).length} 場)`);
console.log(`  離評分截止日(${out.model.ratingsAsOf})幾天開球:最小 ${Math.round(Math.min(...slate.map(daysOf)))}・中位 ${Math.round(med(slate.map(daysOf)))}・最大 ${Math.round(Math.max(...slate.map(daysOf)))}`);
for (const days of [42, 60, 90]) {
  let ex = 0, v = 0;
  for (const b of GROUPS) { const w = cnt[b] / slate.length, s = strata[days][b]; if (!w) continue; ex += w * s.cost; v += (w * s.se) ** 2; }
  const se = Math.sqrt(v);
  console.log(`  照這一批的場數分佈加權(分層取落後 ${days} 天):每場預期多付 RPS ${f4(ex)} ± ${se.toFixed(4)}(z ${z1(se ? ex / se : null)})・佔模型整體改善 ${(ex / g.gain * 100).toFixed(1)}%`);
}
console.log('  (估計,不是直接量到的;場數是現在數的,還沒開賽的場次到開賽時只會更多 —— 假設上游一直沒更新)');
