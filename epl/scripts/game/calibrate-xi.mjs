#!/usr/bin/env node
/* 校準「先發名單的能力改多少進球率」—— 模擬遊玩的遊戲係數 a。
 *
 * 遊戲模型:λ_game = λ_site × (Q_att(XI) / Q_att(典型 XI))^a × …
 * a 不是拍腦袋:用**前一季**(2024-25)的 FPL per-90 xGI 算每場先發的 Q,拿去解釋
 * 2025-26 走查回測的 λ(data/backtest-matches.json)之外還剩多少進球差異。
 * 前半季(1–19 輪)調、後半季(20–38 輪)驗 —— 同一批資料又調又驗挑出來的是雜訊(鐵則二)。
 * 能力用前一季的數字,所以先發的 Q 不會偷看到那場比賽本身的產出。
 *
 * 樣本:FPL 鏡像的逐輪合併檔(merged_gw.csv,靜態檔)給每輪每人的 starts / minutes,
 * 濃縮成 data/raw/fpl/2025-26-xi.json(每隊每場 11 個先發 code)進版控;合併檔本身 5 MB 不進。
 *
 *   node scripts/game/calibrate-xi.mjs --gws=/path/merged_gw.csv   # 第一次:產 xi.json 再校準
 *   node scripts/game/calibrate-xi.mjs                              # 之後:直接讀 xi.json
 * 輸出 data/game-calibration.json;build-game 讀它,沒有就標「未校準」。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSVObjects } from '../lib/csv.mjs';
import { loadTeams } from '../lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEASON = '2025-26', PRIOR = '2024-25';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const XI = join(ROOT, 'data', 'raw', 'fpl', `${SEASON}-xi.json`);
const QUALIFY = 450;
const r3 = n => Math.round(n * 1000) / 1000;

function buildXi(gwsPath) {
  const T = loadTeams(ROOT);
  const players = parseCSVObjects(readFileSync(join(ROOT, 'data', 'raw', 'fpl', `${SEASON}-players.csv`), 'utf8'));
  const codeById = new Map(players.map(p => [p.id, p.code]));
  const teams = parseCSVObjects(readFileSync(join(ROOT, 'data', 'raw', 'fpl', `${SEASON}-teams.csv`), 'utf8'));
  const codeByTeamId = new Map(teams.map(t => [t.id, t.short_name]));   // short_name = 本站隊碼(CLAUDE.md 驗過 20 隊全對)
  const byTM = new Map();
  let unmatched = 0;
  for (const r of parseCSVObjects(readFileSync(gwsPath, 'utf8'))) {
    if (r.starts !== '1') continue;
    const code = codeById.get(r.element), team = T.codeOf(r.team), opp = codeByTeamId.get(r.opponent_team);
    if (!code || !team || !opp) { unmatched++; continue; }
    const date = String(r.kickoff_time).slice(0, 10);
    const key = `${team}|${opp}|${date}`;
    if (!byTM.has(key)) byTM.set(key, { team, opp, home: r.was_home === 'True', date, round: Number(r.round), starters: [] });
    byTM.get(key).starters.push(code);
  }
  const list = [...byTM.values()].sort((a, b) => a.date.localeCompare(b.date));
  const bad = list.filter(x => x.starters.length !== 11).length;
  writeFileSync(XI, JSON.stringify({ season: SEASON, source: gwsPath.replace(/.*\//, ''), builtAt: new Date().toISOString(),
    note: '每隊每場的 11 個先發(FPL code)。從 vaastav merged_gw.csv 的 starts=1 濃縮;校準與遊戲側寫用。',
    teamMatches: list }, null, 0));
  console.log(`  xi.json:${list.length} 隊-場・先發不是 11 人的 ${bad} 場・對不上的列 ${unmatched}`);
}

function main() {
  const gws = arg('gws');
  if (gws) buildXi(gws);
  if (!existsSync(XI)) { console.log('✗ 沒有 xi.json,第一次要給 --gws=merged_gw.csv'); process.exit(1); }
  const xi = JSON.parse(readFileSync(XI, 'utf8')).teamMatches.filter(x => x.starters.length === 11);

  // 前一季的能力:xGI/90,450 分鐘以上;缺的人用同位置(element_type)中位數,並記涵蓋率
  const prior = parseCSVObjects(readFileSync(join(ROOT, 'data', 'raw', 'fpl', `${PRIOR}-players.csv`), 'utf8'));
  const ab = new Map(), pos = new Map();
  for (const p of prior) {
    pos.set(p.code, p.element_type);
    if (Number(p.minutes) >= QUALIFY) ab.set(p.code, Number(p.expected_goal_involvements_per_90));
  }
  const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const posMedian = {};
  for (const et of ['1', '2', '3', '4']) posMedian[et] = median([...ab.entries()].filter(([c]) => pos.get(c) === et).map(([, v]) => v));
  const cur = parseCSVObjects(readFileSync(join(ROOT, 'data', 'raw', 'fpl', `${SEASON}-players.csv`), 'utf8'));
  const curPos = new Map(cur.map(p => [p.code, p.element_type]));

  const bt = JSON.parse(readFileSync(join(ROOT, 'data', 'backtest-matches.json'), 'utf8')).matches;
  const predOf = (home, away, date) => bt.find(m => m.home === home && m.away === away && Math.abs(new Date(m.date) - new Date(date)) <= 2 * 864e5);

  let covered = 0, total = 0;
  const rows = [];
  for (const tm of xi) {
    const m = predOf(tm.home ? tm.team : tm.opp, tm.home ? tm.opp : tm.team, tm.date);
    if (!m) continue;
    let q = 0;
    for (const c of tm.starters) {
      const et = curPos.get(c) ?? pos.get(c);
      if (et === '1') continue;                 // 門將不進進攻指數
      total++;
      if (ab.has(c)) { q += ab.get(c); covered++; } else q += posMedian[et] ?? posMedian['3'];
    }
    rows.push({ team: tm.team, round: m.round, q, lambda: tm.home ? m.pred.xgHome : m.pred.xgAway, goals: tm.home ? m.fh : m.fa });
  }
  const train = rows.filter(r => r.round <= 19), valid = rows.filter(r => r.round > 19);
  const typ = new Map();
  for (const t of new Set(rows.map(r => r.team))) {
    const mine = train.filter(r => r.team === t);
    typ.set(t, mine.reduce((a, r) => a + r.q, 0) / mine.length);
  }
  const ll = (set, a) => set.reduce((s, r) => {
    const lam = r.lambda * (r.q / typ.get(r.team)) ** a;
    let lg = 0; for (let k = 2; k <= r.goals; k++) lg += Math.log(k);
    return s + (r.goals * Math.log(lam) - lam - lg);
  }, 0);
  let best = { a: 0, ll: -Infinity };
  for (let a = -1; a <= 3.0001; a += 0.05) { const v = ll(train, a); if (v > best.ll) best = { a: Math.round(a * 100) / 100, ll: v }; }
  const h = 0.05;
  const curv = (ll(train, best.a + h) - 2 * best.ll + ll(train, best.a - h)) / (h * h);
  const se = curv < 0 ? Math.sqrt(-1 / curv) : null;
  const out = {
    ranAt: new Date().toISOString(), season: SEASON, priorSeason: PRIOR, method: '前半季調(1–19 輪)、後半季驗(20–38 輪);Poisson 對數概似,格點 0.05',
    a: best.a, se: se != null ? r3(se) : null,
    train: { n: train.length, llGainVs0: r3(best.ll - ll(train, 0)), llGainVs1: r3(best.ll - ll(train, 1)) },
    valid: { n: valid.length, llGainVs0: r3(ll(valid, best.a) - ll(valid, 0)), llGainVs1: r3(ll(valid, best.a) - ll(valid, 1)), llAt1Vs0: r3(ll(valid, 1) - ll(valid, 0)) },
    coverage: r3(covered / total), qSpread: r3(Math.sqrt(rows.reduce((s, r) => s + (r.q / typ.get(r.team) - 1) ** 2, 0) / rows.length)),
    significant: se != null && Math.abs(best.a) > 2 * se,
    note: '進攻側係數。防守側沒有前一季的逐人防守 per-90(2024-25 的 FPL 快照沒有 defensive_contribution),校不了,引擎借用同一個值並標為遊戲規則。',
  };
  writeFileSync(join(ROOT, 'data', 'game-calibration.json'), JSON.stringify(out, null, 2));
  console.log(`✔ a = ${out.a} ± ${out.se}(${out.significant ? '顯著' : '跟 0 分不開'})・訓練 ${train.length} 隊-場 概似增益 ${out.train.llGainVs0}・驗證 ${valid.length} 隊-場 概似增益 ${out.valid.llGainVs0}(a=1 時 ${out.valid.llAt1Vs0})・能力涵蓋 ${Math.round(out.coverage * 100)}%・Q 相對離散 ${out.qSpread}`);
}
main();
