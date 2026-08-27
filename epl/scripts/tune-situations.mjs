#!/usr/bin/env node
// 進球情境係數的調參與驗證(Understat 的五類 xG)。
//
//   node scripts/tune-situations.mjs
//   node scripts/tune-situations.mjs --league=es1
//
// 假說:**定位球能力比運動戰能力更能跨季延續**。
// 運動戰得分很受球隊當下狀態、傷兵與對手強弱影響;定位球比較靠身高、
// 傳中品質與練過的套路,這些換季之後變化較慢。如果這個假說成立,
// 「上一季的定位球強弱」就會帶有現在的 Poisson 看不到的資訊 ——
// 因為 Poisson 只吃總進球數,分不出那球是角球進的還是快攻進的。
//
// **為什麼一定要用上一季而不是本季**:Understat 給的是整季彙總,不是逐場。
// 拿本季彙總去預測本季的比賽就是偷看未來 —— 那個「改善」完全是假的。
// 所以這裡一律用**前一季**的情境當先驗,走查時每一場都只用開賽前就已知的資訊。
//
// 協議跟 tune-form.mjs 完全一樣,不另外發明一套:
//
//   調參賽季 2024-25(先驗 2023-24 情境)→ 挑係數,可以盡情挑
//   驗收賽季 2025-26(先驗 2024-25 情境)→ 完全沒參與挑選,只跑一次
//
// 驗收賽季上改善**超過一個成對標準誤**才算數。沒有就照實說,係數留 0。
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMatches } from './lib/adapters/index.mjs';
import { loadTeams } from './lib/teams.mjs';
import { laligaMatches } from './lib/laliga-matches.mjs';
import { COMPETITION } from './lib/sources.mjs';
import { fitPoisson, applyPromotedPrior, lambdas, outcomeProbs } from './lib/poisson.mjs';
import { buildElo, eloProbs } from './lib/elo.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const LEAGUE = arg('league') || 'pl';

const PROFILES = {
  pl: {
    label: '英超', competition: COMPETITION, teamFile: 'teams.json', cacheDir: 'understat',
    tune: { season: '2024-25', train: ['2023-24'], prior: '2023-24' },
    holdout: { season: '2025-26', train: ['2023-24', '2024-25'], prior: '2024-25' },
  },
  es1: {
    label: '西甲', competition: 'esp.1', teamFile: 'teams-la-liga.json', cacheDir: 'understat-la-liga',
    /* train 是「這一季開打前就已經有的比賽」。以前西甲的調參季寫成 []
       (那時還沒有 2023-24 的賽果),結果走查前十幾輪因為樣本不足被跳過,
       調參季只剩 280 場 —— 跟驗收季的 380 場不是同一個協議。
       補上 2023-24 之後兩季都是完整 380 場,才跟英超那套對得起來。 */
    tune: { season: '2024-25', train: ['2023-24'], prior: '2023-24' },
    holdout: { season: '2025-26', train: ['2023-24', '2024-25'], prior: '2024-25' },
  },
};
const P = PROFILES[LEAGUE];
if (!P) throw new Error(`不支援的聯賽 --league=${LEAGUE}`);

/* 定位球 = 角球 + 間接自由球 + 直接自由球。
   **十二碼刻意不算進去** —— 罰球次數主要反映的是「被犯規多少」與裁判尺度,
   不是定位球能力;混進來只會讓這個特徵變成雜訊。 */
const DEAD_BALL = ['FromCorner', 'SetPiece', 'DirectFreekick'];

const situationsFile = season => join(ROOT, 'data', 'raw', P.cacheDir, `${season}-team-situations.json`);

/* 讀某一季的情境,轉成「每場定位球進球 / 每場定位球失球」。
   回傳 null 代表那一季沒抓過 —— 上層要照實說,不可以用 0 頂替,
   因為 0 的意思是「這隊定位球剛好等於聯盟平均」,跟「不知道」完全是兩件事。 */
function loadSituations(season) {
  const f = situationsFile(season);
  if (!existsSync(f)) return null;
  let j;
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  const teams = j.teams ?? {};
  const out = new Map();
  for (const [code, t] of Object.entries(teams)) {
    const games = Number(t.matches) || 0;
    if (!games) continue;
    let gf = 0, ga = 0;
    for (const key of DEAD_BALL) {
      gf += Number(t.situations?.[key]?.goals) || 0;
      ga += Number(t.situations?.[key]?.against?.goals) || 0;
    }
    out.set(code, { gf90: gf / games, ga90: ga / games, games });
  }
  return out.size ? out : null;
}

/* 轉成相對聯盟平均的對數比。用對數是為了跟 adjustLambdas 的 exp() 對上 ——
   係數乘上去再取 exp,等於「比平均高幾成」而不是「多幾球」,
   這樣不同聯賽、不同賽季的尺度才可比。
   分母加一個同量級緩衝,避免某隊整季 0 顆定位球時炸成 -Infinity
   (專案在 versus() 那裡踩過同一個坑)。 */
function toIndex(map) {
  const vals = [...map.values()];
  const avgF = vals.reduce((a, x) => a + x.gf90, 0) / vals.length;
  const avgA = vals.reduce((a, x) => a + x.ga90, 0) / vals.length;
  const buf = 0.05;
  const idx = new Map();
  for (const [code, v] of map) {
    idx.set(code, {
      atk: Math.log((v.gf90 + buf) / (avgF + buf)),
      def: Math.log((v.ga90 + buf) / (avgA + buf)),
    });
  }
  return { idx, avgF: round(avgF, 3), avgA: round(avgA, 3) };
}

const outcome = m => (m.fh > m.fa ? 0 : m.fh === m.fa ? 1 : 2);
const logLoss = (p, o) => -Math.log(Math.max(1e-9, [p.home, p.draw, p.away][o]));
function rps(p, o) {
  const pv = [p.home, p.draw, p.away];
  const ov = [0, 0, 0]; ov[o] = 1;
  let cp = 0, co = 0, s = 0;
  for (let i = 0; i < 2; i++) { cp += pv[i]; co += ov[i]; s += (cp - co) ** 2; }
  return s / 2;
}

/* 走查一季。跟 tune-form 一樣,把「與係數無關」的東西先算好 ——
   λ 與 Elo 不受係數影響,跑一次就好。 */
function collect({ season, train, prior }, T) {
  const situations = loadSituations(prior);
  if (!situations) return { rows: [], missingPrior: prior };
  const { idx, avgF, avgA } = toIndex(situations);

  /* 西甲走 laligaMatches:它讀對的目錄,而且會用**已核對過的**備援來源
     補上 openfootball 缺的比分(2024-25 少了最後一輪 10 場)。
     這裡少 10 場的話,調參季的樣本跟回測用的不是同一批,結論不能互相對照。 */
  const load = s => (LEAGUE === 'es1'
    ? laligaMatches(ROOT, s, { codeOf: T.codeOf }).matches
    : loadMatches({ root: ROOT, competition: P.competition, season: s, codeOf: T.codeOf }));
  const past = train.flatMap(load);
  const test = load(season).filter(m => m.played);
  if (!test.length) return { rows: [], missingSeason: season };
  const codes = [...new Set(test.flatMap(m => [m.home, m.away]))].sort();
  const rounds = [...new Set(test.map(m => m.round))].sort((a, b) => a - b);

  const rows = [];
  const noPrior = new Set();
  for (const rd of rounds) {
    const games = test.filter(m => m.round === rd);
    const before = [...past, ...test.filter(m => m.round < rd)];
    if (before.length < 100) continue;
    const refDate = games[0].date;
    const model = applyPromotedPrior(fitPoisson(before, codes, { refDate, iters: 1200 }));
    const elo = buildElo(before);
    for (const m of games) {
      const { lh, la } = lambdas(model, m.home, m.away);
      // 升班馬上一季不在這個聯賽 → 沒有先驗。特徵給 0(= 不調整)並記名,
      // 報告裡要講出來有幾場是這種情況,不能假裝全部都有資料。
      const h = idx.get(m.home), a = idx.get(m.away);
      if (!h) noPrior.add(m.home);
      if (!a) noPrior.add(m.away);
      rows.push({
        round: rd, home: m.home, away: m.away, lh, la, rho: model.rho,
        elo: eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500),
        o: outcome(m),
        f: {
          hAtk: h?.atk ?? 0, hDef: h?.def ?? 0,
          aAtk: a?.atk ?? 0, aDef: a?.def ?? 0,
          known: Boolean(h && a),
        },
      });
    }
  }
  return { rows, noPrior: [...noPrior].sort(), avgF, avgA, priorTeams: idx.size };
}

/* 係數怎麼作用:自己上季定位球強 → 進球 λ 調高;
   對手上季定位球失得多 → 自己的 λ 也調高。跟 form.mjs 的形狀一致。 */
function adjust({ lh, la }, f, { bAtk = 0, bDef = 0 }) {
  const adjH = bAtk * f.hAtk + bDef * f.aDef;
  const adjA = bAtk * f.aAtk + bDef * f.hDef;
  return { lh: lh * Math.exp(adjH), la: la * Math.exp(adjA) };
}

function score(rows, coef) {
  const per = [];
  let ll = 0, hit = 0;
  for (const r of rows) {
    const { lh, la } = adjust({ lh: r.lh, la: r.la }, r.f, coef);
    const p = outcomeProbs(lh, la, r.rho);
    const b = {
      home: (p.home + r.elo.home) / 2,
      draw: (p.draw + r.elo.draw) / 2,
      away: (p.away + r.elo.away) / 2,
    };
    per.push(rps(b, r.o));
    ll += logLoss(b, r.o);
    if ([b.home, b.draw, b.away].indexOf(Math.max(b.home, b.draw, b.away)) === r.o) hit++;
  }
  const n = rows.length;
  return { per, rps: per.reduce((a, x) => a + x, 0) / n, logLoss: ll / n, hitRate: hit / n, n };
}

/* 成對比較 + bootstrap。比賽本身難易差很大,直接比兩個平均會被賽季難度蓋過,
   所以逐場相減之後再看。負 = 調整後比較好。 */
function paired(aPer, bPer, iters = 4000) {
  const n = aPer.length;
  const d = aPer.map((x, i) => x - bPer[i]);
  const mean = d.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  let opposite = 0;
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[(Math.random() * n) | 0];
    if ((s / n) * Math.sign(mean) <= 0) opposite++;
  }
  return { mean, se, p: opposite / iters };
}

async function main() {
  const T = loadTeams(ROOT, { file: P.teamFile });
  console.log(`\n▶ 進球情境特徵:調參與驗收(${P.label})`);
  console.log(`  定位球 = ${DEAD_BALL.join(' + ')};十二碼不算(反映的是被犯規次數,不是定位球能力)`);

  const tune = collect(P.tune, T);
  const hold = collect(P.holdout, T);

  for (const [name, r, cfg] of [['調參', tune, P.tune], ['驗收', hold, P.holdout]]) {
    if (r.missingPrior) {
      console.log(`\n✗ ${name}賽季 ${cfg.season} 缺少先驗:${r.missingPrior} 的情境資料沒抓過。`);
      console.log(`   抓法:npm run setpieces -- --season=${r.missingPrior}` +
        (LEAGUE === 'es1' ? ' --league=es1' : ''));
      console.log('   沙箱連不到外網,要在 GitHub Actions 的 runner 上跑(epl-live.yml 已加這一步)。');
      process.exitCode = 1;
      return;
    }
    if (r.missingSeason) {
      console.log(`\n✗ ${name}賽季 ${r.missingSeason} 沒有賽果資料,跑不了。`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`  調參 ${P.tune.season}(先驗 ${P.tune.prior}):${tune.rows.length} 場・` +
    `先驗涵蓋 ${tune.priorTeams} 隊・無先驗 ${tune.noPrior.length} 隊${tune.noPrior.length ? `(${tune.noPrior.join('、')})` : ''}`);
  console.log(`  驗收 ${P.holdout.season}(先驗 ${P.holdout.prior}):${hold.rows.length} 場・` +
    `先驗涵蓋 ${hold.priorTeams} 隊・無先驗 ${hold.noPrior.length} 隊${hold.noPrior.length ? `(${hold.noPrior.join('、')})` : ''}`);
  console.log(`  聯盟平均定位球:每場進 ${hold.avgF} 球 / 失 ${hold.avgA} 球`);

  // ── 調參:在調參賽季上掃係數 ──
  const t0 = score(tune.rows, {});
  const grid = [];
  for (let bAtk = -0.30; bAtk <= 0.301; bAtk += 0.05) {
    for (let bDef = -0.30; bDef <= 0.301; bDef += 0.05) {
      const c = { bAtk: round(bAtk, 3), bDef: round(bDef, 3) };
      grid.push({ c, s: score(tune.rows, c) });
    }
  }
  grid.sort((a, b) => a.s.rps - b.s.rps);
  const best = grid[0];
  console.log(`\n  調參賽季基準 RPS ${round(t0.rps, 5)};最佳 ${round(best.s.rps, 5)} ` +
    `(bAtk=${best.c.bAtk} bDef=${best.c.bDef})`);

  // 單一特徵各自的最佳值 —— 想知道是哪一個在出力
  const bestOnly = key => {
    const sub = grid.filter(g => (key === 'bAtk' ? g.c.bDef === 0 : g.c.bAtk === 0));
    sub.sort((a, b) => a.s.rps - b.s.rps);
    return sub[0];
  };

  // ── 驗收:完全沒參與挑選的賽季,只跑一次 ──
  const h0 = score(hold.rows, {});
  const trials = [['最佳組合', best.c]];
  for (const key of ['bAtk', 'bDef']) {
    const b = bestOnly(key);
    if (b && (b.c.bAtk || b.c.bDef)) trials.push([`只開 ${key}`, b.c]);
  }

  const rowsOut = [];
  for (const [name, c] of trials) {
    const s = score(hold.rows, c);
    const cmp = paired(h0.per, s.per);
    rowsOut.push({
      係數: name, bAtk: c.bAtk ?? 0, bDef: c.bDef ?? 0,
      RPS: round(s.rps, 5),
      對基準: round(s.rps - h0.rps, 5),
      '±標準誤': round(cmp.se, 5),
      'bootstrap p': round(cmp.p, 3),
      命中率: `${round(s.hitRate * 100, 1)}%`,
    });
  }

  console.log(`\n  驗收賽季 ${P.holdout.season}:基準 RPS ${round(h0.rps, 5)}\n`);
  console.table([
    { 係數: '基準(不調整)', bAtk: 0, bDef: 0, RPS: round(h0.rps, 5), 對基準: 0, '±標準誤': null, 'bootstrap p': null, 命中率: `${round(h0.hitRate * 100, 1)}%` },
    ...rowsOut,
  ]);

  const passed = rowsOut.filter(r => r.對基準 < 0 && Math.abs(r.對基準) > r['±標準誤']);
  console.log(passed.length
    ? `\n判定:有 ${passed.length} 組在驗收賽季上改善且超過一個標準誤 —— 值得進模型。`
    : '\n判定:沒有一組通過。改善(如果有)都在雜訊範圍內,係數維持 0。');
  console.log('  規矩:改善要大過成對比較的標準誤才算數,不然換一批比賽就會翻盤。');
  if (!passed.length) {
    console.log('  照鐵則二:沒有回測證據就不進模型。這個結果要寫在模型頁上,不是悄悄拿掉。');
  }

  /* 存檔給模型頁讀。**不通過也要存** —— 這一頁的價值有一半在「測了什麼、
     結果沒用」,悄悄不存等於假裝沒測過。格式比照 data/form-tuning.json。 */
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const out = join(ROOT, 'data', LEAGUE === 'pl' ? 'situation-tuning.json' : `situation-tuning-${LEAGUE}.json`);
  writeFileSync(out, JSON.stringify({
    ranAt: new Date().toISOString(),
    league: LEAGUE, leagueLabel: P.label,
    deadBall: DEAD_BALL,
    hypothesis: '定位球能力比運動戰能力更能跨季延續,所以上一季的定位球強弱可能帶有 Poisson 看不到的資訊。',
    tuneSeason: P.tune.season, tunePrior: P.tune.prior, tuneGames: tune.rows.length,
    holdoutSeason: P.holdout.season, holdoutPrior: P.holdout.prior, holdoutGames: hold.rows.length,
    priorCoverage: {
      tune: { teams: tune.priorTeams, noPrior: tune.noPrior },
      holdout: { teams: hold.priorTeams, noPrior: hold.noPrior },
    },
    leagueAverage: { deadBallFor90: hold.avgF, deadBallAgainst90: hold.avgA },
    tuneBaselineRps: round(t0.rps, 5),
    tuneBest: { coef: best.c, rps: round(best.s.rps, 5) },
    holdout: { baselineRps: round(h0.rps, 5), baselineHitRate: round(h0.hitRate, 4), trials: rowsOut },
    accepted: passed.length ? passed[0] : null,
  }, null, 2) + '\n');
  console.log(`→ 已寫入 ${out.replace(ROOT + '/', '')}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
