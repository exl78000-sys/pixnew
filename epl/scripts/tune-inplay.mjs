#!/usr/bin/env node
/* 即時勝率的時間曲線:調參與驗收(`npm run tune:inplay`)。做法與理由見 lib/inplay-tuning.mjs 的檔頭。
 *
 * 協議(2026-09-25 寫程式之前定的):
 *   - 賽前 λ 由這一支自己走查:賽季 X 的每一輪只用「X 之前兩季 + X 那一輪之前」的比賽建模,
 *     六個聯賽同一條規則。**不讀 data/backtest-*-matches.json** —— 回測哪天換驗收季,
 *     那些檔就不再有 2025-26,這一支會靜靜少掉整個調參季。
 *   - 調參季固定 2025-26(六個聯賽都有完整的 FotMob 逐場事件)。
 *   - 驗收 = 調參季之後的每一季(現在只有 2026-27)。只會變多,不會因為換季縮小 ——
 *     「新球季開打那幾週樣本不夠 → 退回線性」那種來回跳,這樣就不會發生。
 *   - 分數:每場取 c = 1..90 的 RPS 平均當一場;成對差的 SE 用場算。
 *   - 通過 = 驗收季「曲線 − 線性」< 0、超過 2 個 SE、而且驗收 ≥ MIN_VALID_MATCHES 場。
 *   - 局面乘數(落後方加速、領先方收)只量不上線;每次重跑只為了讓模型頁的數字是現跑的。
 *
 * 只讀倉庫、零網路,寫 data/inplay-tuning.json(build 讀它)。 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { loadMatches } from './lib/adapters/index.mjs';
import { leagueMatches } from './lib/league-matches.mjs';
import { walkForward } from './lib/backtest.mjs';
import { COMPETITION, CURRENT_SEASON } from './lib/sources.mjs';
import { inPlay } from './lib/inplay.mjs';
import {
  eventsOf, reconcile, goalTimingCurve, validCurve, scoreMatches, pairedScores, trailingTable,
  fitGameState, gameStateModel, stateBucket, timeBand, MIN_VALID_MATCHES,
} from './lib/inplay-tuning.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TUNE_SEASON = '2025-26';

/* 六個聯賽的載入設定跟各自的回測腳本一樣(隊名對照、補比分的備援、附加賽不算)。 */
const byFd = T => { const m = new Map(T.list.filter(t => t.fd).map(t => [t.fd, t.code])); return n => m.get(n) ?? T.codeOf(n); };
const LEAGUES = [
  { key: 'pl', fm: 'fotmob-epl' },
  { key: 'es1', fm: 'fotmob-la-liga', teamFile: 'teams-la-liga.json', competition: 'esp.1', rawDir: 'openfootball-la-liga', fillDir: 'football-data-couk-la-liga', div: 'SP1' },
  { key: 'en2', fm: 'fotmob-championship', teamFile: 'teams-championship.json', competition: 'eng.2', rawDir: 'openfootball-championship', fillDir: 'football-data-couk-championship', div: 'E1', codeOf: byFd, stageOf: m => (m.round == null ? '升級附加賽' : null) },
  { key: 'de1', fm: 'fotmob-bundesliga', teamFile: 'teams-bundesliga.json', competition: 'ger.1', rawDir: 'openfootball-bundesliga', fillDir: 'football-data-couk-bundesliga', div: 'D1', codeOf: byFd },
  { key: 'it1', fm: 'fotmob-serie-a', teamFile: 'teams-serie-a.json', competition: 'ita.1', rawDir: 'openfootball-serie-a', fillDir: 'football-data-couk-serie-a', div: 'I1', codeOf: byFd },
  { key: 'fr1', fm: 'fotmob-ligue-1', teamFile: 'teams-ligue-1.json', competition: 'fra.1', rawDir: 'openfootball-ligue-1', fillDir: 'football-data-couk-ligue-1', div: 'F1', codeOf: byFd },
];
const prevSeason = s => { const y = Number(s.slice(0, 4)) - 1; return `${y}-${String(y + 1).slice(2)}`; };
const nextSeason = s => { const y = Number(s.slice(0, 4)) + 1; return `${y}-${String(y + 1).slice(2)}`; };

/* 一個聯賽一季:走查 λ + FotMob 事件,逐場對回比分。對不上的照實數出來。 */
function leagueSeason(L, season) {
  const fmPath = join(ROOT, 'data', 'raw', L.fm, `${season}-game-details.json`);
  if (!existsSync(fmPath)) return { rows: [], note: `${L.key} ${season}:沒有 FotMob 逐場檔` };
  let load;
  if (L.key === 'pl') {
    const T = loadTeams(ROOT);
    load = s => loadMatches({ root: ROOT, competition: COMPETITION, season: s, codeOf: T.codeOf });
  } else {
    const T = loadTeams(ROOT, { file: L.teamFile });
    const codeOf = L.codeOf ? L.codeOf(T) : T.codeOf;
    load = s => leagueMatches(ROOT, s, { codeOf, competition: L.competition, rawDir: L.rawDir, fillDir: L.fillDir, div: L.div, stageOf: L.stageOf ?? null })
      .matches.filter(m => !m.stage);
  }
  const trainSeasons = [prevSeason(prevSeason(season)), prevSeason(season)];
  /* 某一季的賽果檔不在(新球季剛開打、還沒抓到)就當那一季沒有 —— 這一步不容忍失敗,
     所以缺資料只能讓它「不跑」,不能讓它丟例外把部署擋掉。 */
  const played = s => { try { return load(s).filter(m => m.played); } catch { return []; } };
  const past = trainSeasons.flatMap(played);
  const test = played(season);
  if (!test.length || past.length < 100) return { rows: [], note: `${L.key} ${season}:訓練 ${past.length} 場、已完賽 ${test.length} 場,不跑` };
  const tally = { home: 0, draw: 0, away: 0 };
  for (const m of past) tally[m.fh > m.fa ? 'home' : m.fh === m.fa ? 'draw' : 'away']++;
  const baseline = Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, v / past.length]));
  const wf = walkForward({ past, test, baseline, odds: null });
  const F = JSON.parse(readFileSync(fmPath, 'utf8')).matches ?? {};
  const rows = [];
  let noEvents = 0, mismatch = 0;
  for (const m of wf.perMatch) {
    const fm = F[`${m.home}|${m.away}`];
    if (!fm) { noEvents++; continue; }
    const { goals: raw, reds } = eventsOf(fm, m.home, m.away);
    const goals = reconcile(raw, m.fh, m.fa);
    if (!goals) { mismatch++; continue; }
    rows.push({ league: L.key, season, date: m.date, home: m.home, away: m.away, fh: m.fh, fa: m.fa, lh: m.pred.xgHome, la: m.pred.xgAway, goals, reds });
  }
  return {
    rows,
    note: `${L.key} ${season}:訓練 ${trainSeasons.join('+')} ${past.length} 場・走查 ${wf.perMatch.length} 場・事件對上 ${rows.length}`
      + (noEvents ? `・FotMob 沒有 ${noEvents}` : '') + (mismatch ? `・事件加不回比分 ${mismatch}` : ''),
    coverage: { walked: wf.perMatch.length, used: rows.length, noEvents, mismatch },
  };
}

function collect(season) {
  const rows = [], notes = [], byLeague = {};
  for (const L of LEAGUES) {
    const r = leagueSeason(L, season);
    rows.push(...r.rows); notes.push(r.note);
    if (r.coverage) byLeague[L.key] = r.coverage;
  }
  return { rows, notes, byLeague };
}

console.log('▶ 即時勝率的時間曲線:調參與驗收');
const tune = collect(TUNE_SEASON);
for (const n of tune.notes) console.log(`  調參 ${n}`);
const validSeasons = [];
for (let s = nextSeason(TUNE_SEASON); s <= CURRENT_SEASON; s = nextSeason(s)) validSeasons.push(s);
const valid = { rows: [], notes: [], byLeague: {} };
for (const s of validSeasons) {
  const v = collect(s);
  valid.rows.push(...v.rows); valid.notes.push(...v.notes);
  valid.byLeague[s] = v.byLeague;
}
for (const n of valid.notes) console.log(`  驗收 ${n}`);

const curve = goalTimingCurve(tune.rows);
if (!validCurve(curve.S)) {
  /* 資料壞掉(例如調參季的逐場檔整個沒了)時不要寫一條壞曲線 —— 寫一份「沒有通過」的結果,
     build 就退回線性。紅線不放在這裡:抓取類的步驟失敗不該把部署整個擋掉。 */
  console.log('  ✗ 調參季估不出合格的曲線(沒有資料或形狀不對),寫「沒有通過」');
}
const S = validCurve(curve.S) ? curve.S : null;
const linear = (m, c, st) => { const p = inPlay({ lambdaHome: m.lh, lambdaAway: m.la, hs: st.hs, as: st.as, minute: c, redHome: st.rh, redAway: st.ra }); return [p.home, p.draw, p.away]; };
const withCurve = (m, c, st) => { const p = inPlay({ lambdaHome: m.lh, lambdaAway: m.la, hs: st.hs, as: st.as, minute: c, redHome: st.rh, redAway: st.ra, curve: S }); return [p.home, p.draw, p.away]; };

const r5 = x => (x == null ? null : round(x, 5));
/* 成對比較的兩邊叫什麼要跟著比較本身:時間曲線那一組是 linear → curve;局面乘數與截斷那兩組是 base → candidate
   (照舊叫 linear / curve 的話,下一個人讀產物會以為局面乘數是在跟線性比)。 */
const pack = (p, [an, bn] = ['linear', 'curve']) => p && { matches: p.matches, [an]: r5(p.a), [bn]: r5(p.b), diff: r5(p.diff), se: r5(p.se), z: p.z == null ? null : round(p.z, 2) };
const BC = ['base', 'candidate'];
const compare = (rows, a, b, win) => pairedScores(scoreMatches(rows, a, win), scoreMatches(rows, b, win));
const WINDOWS = [['1-45', 1, 45], ['46-75', 46, 75], ['76-90', 76, 90], ['90', 90, 90]];

let validation = { passes: false, reason: 'no-curve', matches: valid.rows.length, minMatches: MIN_VALID_MATCHES, seasons: validSeasons };
let tuning = null, gameState = null, truncation = null, trailing = null;
if (S) {
  tuning = { ...pack(compare(tune.rows, linear, withCurve)), windows: Object.fromEntries(WINDOWS.map(([k, from, to]) => [k, pack(compare(tune.rows, linear, withCurve, { from, to }))])) };
  const v = valid.rows.length ? compare(valid.rows, linear, withCurve) : null;
  const passes = !!v && v.matches >= MIN_VALID_MATCHES && v.diff < 0 && v.z != null && v.z <= -2;
  validation = {
    ...validation,
    ...pack(v),
    passes,
    reason: !v ? 'no-validation-data' : v.matches < MIN_VALID_MATCHES ? 'insufficient' : passes ? 'passed' : 'not-significant',
    windows: v ? Object.fromEntries(WINDOWS.map(([k, from, to]) => [k, pack(compare(valid.rows, linear, withCurve, { from, to }))])) : null,
    byLeague: v ? Object.fromEntries(LEAGUES.map(L => {
      const rows = valid.rows.filter(m => m.league === L.key);
      return [L.key, rows.length ? pack(compare(rows, linear, withCurve)) : null];
    })) : null,
  };

  /* 落後方專表:現行(線性)、曲線與實際並排,兩季各一張。 */
  trailing = {
    tuning: trailingTable(tune.rows, { linear, curve: withCurve }),
    validation: valid.rows.length ? trailingTable(valid.rows, { linear, curve: withCurve }) : null,
  };

  /* 局面乘數(只量):對照組是同一支馬可夫鏈、乘數全 1(= 曲線的精確解),只差乘數。 */
  const fit = fitGameState(tune.rows, S);
  const mult = (d, k) => fit[`${timeBand(k)}:${stateBucket(d)}`]?.m ?? 1;
  const exactCurve = gameStateModel(S, () => 1);
  const withState = gameStateModel(S, mult);
  const gt = compare(tune.rows, exactCurve, withState);
  const gv = valid.rows.length ? compare(valid.rows, exactCurve, withState) : null;
  gameState = {
    adopted: false,
    rule: '驗收季要贏過時間曲線超過 2 個 SE 才進模型',
    passes: !!gv && gv.matches >= MIN_VALID_MATCHES && gv.diff < 0 && gv.z != null && gv.z <= -2,
    multipliers: Object.fromEntries(Object.entries(fit).map(([k, a]) => [k, { m: round(a.m, 3), se: a.se == null ? null : round(a.se, 3), goals: a.goals }])),
    base: '時間曲線(精確解,乘數全 1)', candidate: '時間曲線 + 局面乘數',
    tuning: pack(gt, BC), validation: pack(gv, BC),
  };

  /* 截斷(inPlay 每隊最多再 7 球,λ 很大時會丟掉一截機率)只回報:線性時間、精確解 vs inPlay。 */
  const linS = Array.from({ length: 91 }, (_, c) => (90 - c) / 90);
  const exactLinear = gameStateModel(linS, () => 1);
  truncation = { base: 'inPlay(每隊最多再 7 球)', candidate: '同一條線性時間的精確解',
    tuning: pack(compare(tune.rows, linear, exactLinear), BC), validation: valid.rows.length ? pack(compare(valid.rows, linear, exactLinear), BC) : null };
}

const out = {
  builtAt: new Date().toISOString(),
  method: '檢查點 c = 1..90(時鐘走到 c:00)的即時勝率,逐場平均 RPS;場為獨立樣本',
  tuneSeason: TUNE_SEASON, validSeasons,
  coverage: { tuning: tune.byLeague, validation: valid.byLeague },
  curve: {
    S: S ? S.map(x => round(x, 4)) : null,
    matches: curve.matches, goals: curve.goals,
    firstHalfShare: curve.goals ? round(curve.firstHalf / curve.goals, 4) : null,
    firstHalfStoppageShare: curve.goals ? round(curve.firstHalfStoppage / curve.goals, 4) : null,
    secondHalfStoppageShare: curve.goals ? round(curve.secondHalfStoppage / curve.goals, 4) : null,
  },
  tuning, validation, trailing, gameState, truncation,
};
/* 曲線以捨入後的那一份為準(build 讀的是檔案):通過與否也用捨入後的再確認一次形狀。 */
if (out.curve.S && !validCurve(out.curve.S)) { out.validation.passes = false; out.validation.reason = 'rounded-curve-invalid'; }
writeFileSync(join(ROOT, 'data', 'inplay-tuning.json'), JSON.stringify(out, null, 1));

const f5 = x => (x == null ? '—' : x.toFixed(5));
console.log(`  曲線:${curve.matches} 場 ${curve.goals} 球・上半場 ${(100 * out.curve.firstHalfShare).toFixed(1)}%`
  + `・下半場補時 ${(100 * out.curve.secondHalfStoppageShare).toFixed(1)}%・S(80) ${S ? S[80].toFixed(3) : '—'}(線性 0.111)・S(90) ${S ? S[90].toFixed(3) : '—'}(線性 0)`);
if (tuning) console.log(`  調參 ${TUNE_SEASON}(樣本內):線性 ${f5(tuning.linear)} → 曲線 ${f5(tuning.curve)}・差 ${f5(tuning.diff)} ± ${f5(tuning.se)}(${tuning.z} SE)`);
console.log(`  驗收 ${validSeasons.join('、') || '—'}:${validation.matches} 場・線性 ${f5(validation.linear)} → 曲線 ${f5(validation.curve)}`
  + `・差 ${f5(validation.diff)} ± ${f5(validation.se)}(${validation.z ?? '—'} SE)→ ${validation.passes ? '✓ 通過,build 會用曲線' : `✗ ${validation.reason},build 維持線性`}`);
if (gameState) console.log(`  局面乘數(只量):調參 ${f5(gameState.tuning?.diff)} ± ${f5(gameState.tuning?.se)}(${gameState.tuning?.z} SE)`
  + `・驗收 ${f5(gameState.validation?.diff)} ± ${f5(gameState.validation?.se)}(${gameState.validation?.z ?? '—'} SE)→ ${gameState.passes ? '過了門檻,但要人決定才上線' : '沒過,不進模型'}`);
if (truncation) console.log(`  截斷修正(只回報):驗收 ${f5(truncation.validation?.diff)} ± ${f5(truncation.validation?.se)}`);
console.log('→ 已寫入 data/inplay-tuning.json');
