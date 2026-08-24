import { round } from '../util.mjs';

/* Feature Bundle —— AI 報告唯一的數字來源。
 *
 * 這一層的存在理由只有一個:**不讓語言模型自己算數或猜數字**。
 * 所有統計都在這裡由既有的分析引擎算完、四捨五入定案,
 * 之後模板與 LLM 都只能引用 facts 裡已經存在的值(見 verify.mjs 的檢查)。
 *
 * 另一個好處是可快取:同一份 bundle 的 hash 相同,就不必再打一次 LLM。
 */

const pctText = v => `${round(v * 100, 0)}%`;
const oneDp = v => round(v, 1);

/* ── fact:一個可被引用的數字 ──────────────────
   id    穩定識別碼(給模板與快取用)
   label 人看得懂的名稱(給 LLM 當上下文)
   value 數值本身
   text  允許寫進文章的字面形式
*/
const fact = (id, label, value, text = null) => ({
  id, label, value: typeof value === 'number' ? value : null,
  text: text ?? String(value),
});

/* ── 賽前 ──────────────────────────────────── */
export function preMatchBundle({ fixture, home, away, h2h, tacticsHome, tacticsAway, asOf, seasonLabel }) {
  const p = fixture.prediction;
  const facts = [];
  const F = (...a) => { facts.push(fact(...a)); return facts.at(-1); };

  F('prob.home', `${home.en} 主勝機率`, p.home, pctText(p.home));
  F('prob.draw', '和局機率', p.draw, pctText(p.draw));
  F('prob.away', `${away.en} 客勝機率`, p.away, pctText(p.away));
  F('xg.home', `${home.en} 期望進球`, round(p.xgHome, 2));
  F('xg.away', `${away.en} 期望進球`, round(p.xgAway, 2));
  if (p.poisson) {
    F('poisson.home', 'Poisson 模型主勝', p.poisson.home, pctText(p.poisson.home));
    F('poisson.away', 'Poisson 模型客勝', p.poisson.away, pctText(p.poisson.away));
  }
  if (p.elo) {
    F('elo.home', 'Elo 模型主勝', p.elo.home, pctText(p.elo.home));
    F('elo.away', 'Elo 模型客勝', p.elo.away, pctText(p.elo.away));
  }

  const side = (t, key, tac) => {
    if (t.elo != null) F(`${key}.elo`, `${t.en} Elo 評分`, Math.round(t.elo));
    const cur = t.current, last = t.lastSeason;
    if (cur?.p) {
      F(`${key}.pts`, `${t.en} 本季積分`, cur.pts);
      F(`${key}.played`, `${t.en} 本季已賽`, cur.p);
      F(`${key}.pos`, `${t.en} 目前排名`, cur.pos);
    }
    if (last) {
      F(`${key}.lastPos`, `${t.en} 上季名次`, last.pos);
      F(`${key}.lastPts`, `${t.en} 上季積分`, last.pts);
      F(`${key}.lastGf`, `${t.en} 上季進球`, last.gf);
      F(`${key}.lastGa`, `${t.en} 上季失球`, last.ga);
    }
    if (tac) {
      // 陣型標籤會被寫進文章,直接拿標籤上印出來的數字當 fact,
      // 而不是拿未四捨五入的原值(5.05 印成 5.1,驗證會對不上)
      const parts = String(tac.formation.label).split('-').map(x => Number(x.trim()));
      const names = ['平均後衛人數', '平均中場人數', '平均前鋒人數'];
      parts.forEach((n, i) => { if (Number.isFinite(n)) F(`${key}.shape${i}`, `${t.en} ${names[i]}`, n); });
      F(`${key}.xg90`, `${t.en} 每 90 分鐘期望進球`, oneDp(tac.attack.xG90));
      F(`${key}.xga90`, `${t.en} 每 90 分鐘期望失球`, oneDp(tac.defence.xGA90));
      F(`${key}.finishing`, `${t.en} 整季比期望多進的球數`, round(tac.attack.finishing, 1));
      F(`${key}.cleanSheets`, `${t.en} 上季零封場次`, tac.defence.cleanSheets);
      F(`${key}.leadHold`, `${t.en} 領先守成率`, oneDp(tac.resilience.leadHoldPct), `${oneDp(tac.resilience.leadHoldPct)}%`);
      F(`${key}.trailRescue`, `${t.en} 落後翻盤率`, oneDp(tac.resilience.trailRescuePct), `${oneDp(tac.resilience.trailRescuePct)}%`);
    }
  };
  side(home, 'home', tacticsHome);
  side(away, 'away', tacticsAway);

  if (h2h?.games) {
    const [a] = [home.code, away.code].sort();
    const homeIsA = a === home.code;
    F('h2h.games', '近年交手場次', h2h.games);
    F('h2h.homeWins', `${home.en} 交手勝場`, homeIsA ? h2h.aWin : h2h.bWin);
    F('h2h.awayWins', `${away.en} 交手勝場`, homeIsA ? h2h.bWin : h2h.aWin);
    F('h2h.draws', '交手和局', h2h.draw);
  }

  if (fixture.difficulty) {
    F('diff.home', `${home.en} 這場的賽程難度`, fixture.difficulty.home);
    F('diff.away', `${away.en} 這場的賽程難度`, fixture.difficulty.away);
  }

  return {
    kind: 'pre',
    key: `${fixture.home}|${fixture.away}`,
    season: fixture.season, round: fixture.round, kickoff: fixture.kickoff,
    home: { code: home.code, en: home.en, zh: home.zh },
    away: { code: away.code, en: away.en, zh: away.zh },
    shape: {
      home: tacticsHome?.formation?.label ?? null,
      away: tacticsAway?.formation?.label ?? null,
    },
    // 升班馬沒有上季英超統計。與其讓文章默默少講一邊,不如明講為什麼。
    noHistory: [
      tacticsHome ? null : home.en,
      tacticsAway ? null : away.en,
    ].filter(Boolean),
    facts,
    provenance: {
      source: 'openfootball 賽果 + FPL 官方統計',
      model: 'Dixon-Coles Poisson 與 Elo 平均',
      asOf, seasonLabel,
    },
  };
}

/* ── 賽後 ──────────────────────────────────── */
export function postMatchBundle({ report, home, away, asOf, seasonLabel }) {
  const H = report.sides[report.home], A = report.sides[report.away];
  const facts = [];
  const F = (...a) => facts.push(fact(...a));

  F('score.home', `${home.en} 進球`, report.hs);
  F('score.away', `${away.en} 進球`, report.as);
  F('minute', '比賽進行分鐘', report.minute);
  F('xg.home', `${home.en} 本場期望進球`, H.xG);
  F('xg.away', `${away.en} 本場期望進球`, A.xG);
  F('xg.gap', '雙方期望進球差距', round(Math.abs(H.xG - A.xG), 2));
  F('xa.home', `${home.en} 本場期望助攻`, H.xA);
  F('xa.away', `${away.en} 本場期望助攻`, A.xA);
  F('cards.homeYellow', `${home.en} 黃牌`, H.yellow);
  F('cards.awayYellow', `${away.en} 黃牌`, A.yellow);
  if (H.red) F('cards.homeRed', `${home.en} 紅牌`, H.red);
  if (A.red) F('cards.awayRed', `${away.en} 紅牌`, A.red);

  for (const [s, t, key] of [[H, home, 'home'], [A, away, 'away']]) {
    F(`${key}.shapeDef`, `${t.en} 先發後衛數`, s.shape.DEF);
    F(`${key}.shapeMid`, `${t.en} 先發中場數`, s.shape.MID);
    F(`${key}.shapeFwd`, `${t.en} 先發前鋒數`, s.shape.FWD);
    F(`${key}.subs`, `${t.en} 用掉的替補人次`, s.bench.length);
    if (s.shapeDelta) F(`${key}.shapeDelta`, `${t.en} 後場人數與上季常態的差`, s.shapeDelta.def);
    for (const b of s.bench.slice(0, 3)) F(`${key}.on.${b.name}`, `${b.name} 推估上場分鐘`, b.onAbout);
    if (s.keeper) {
      F(`${key}.saves`, `${t.en} 門將撲救`, s.keeper.saves);
      F(`${key}.gkStopped`, `${t.en} 門將比期望少失球`, s.keeper.stopped);
    }
    for (const b of s.best) F(`${key}.bps.${b.name}`, `${t.en} ${b.name} 的 BPS`, b.bps);
    for (const g of s.scorers) F(`${key}.goals.${g.name}`, `${g.name} 進球數`, g.goals);
  }

  if (report.preMatch) {
    F('pre.home', '賽前主勝機率', report.preMatch.home, pctText(report.preMatch.home));
    F('pre.draw', '賽前和局機率', report.preMatch.draw, pctText(report.preMatch.draw));
    F('pre.away', '賽前客勝機率', report.preMatch.away, pctText(report.preMatch.away));
    F('pre.xgHome', `賽前預期 ${home.en} 進球`, round(report.preMatch.xgHome, 2));
    F('pre.xgAway', `賽前預期 ${away.en} 進球`, round(report.preMatch.xgAway, 2));
  }

  return {
    kind: 'post',
    key: report.key, season: report.season ?? null, kickoff: report.kickoff,
    finished: report.finished, started: report.started,
    home: { code: report.home, en: home.en, zh: home.zh },
    away: { code: report.away, en: away.en, zh: away.zh },
    shape: { home: H.shape.label, away: A.shape.label },
    scorers: {
      home: H.scorers.map(s => s.name), away: A.scorers.map(s => s.name),
    },
    best: {
      home: H.best.map(b => ({ name: b.name, pos: b.pos })),
      away: A.best.map(b => ({ name: b.name, pos: b.pos })),
    },
    engineNotes: (report.notes ?? []).map(n => (typeof n === 'string' ? { kind: 'other', text: n } : n)),
    facts,
    provenance: {
      source: 'FPL 官方即時統計(出場、進球、助攻、xG/xA、BPS)',
      model: '陣型由實際出場位置推導,換人時間由出場分鐘反推',
      asOf, seasonLabel,
    },
  };
}
