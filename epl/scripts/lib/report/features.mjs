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
/* league / provenance:三聯賽共用同一份 bundle 與模板(2026-09-04 起西甲也產文章)。
   文案裡「上季英超」「FPL 官方統計」這種聯賽事實不能寫死 —— 寫死就是在西甲頁面上講英超的話。 */
const PL = { key: 'pl', zh: '英超' };

export function preMatchBundle({ fixture, home, away, h2h, tacticsHome, tacticsAway, asOf, seasonLabel, league = PL, provenance = null }) {
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
      // 西甲的球隊側寫(Understat)沒有平均站位 —— 沒有就不講,不留空
      // 英超的 label 是平均人數(4 - 5.1 - 0.9),西甲的是上季最常用陣型(4-2-3-1)—— fact 的名字要照實
      if (tac.formation?.label) {
        const parts = String(tac.formation.label).split('-').map(x => Number(x.trim()));
        const avg = tac.formation.def != null;
        const names = avg ? ['平均後衛人數', '平均中場人數', '平均前鋒人數'] : ['最常用陣型的後衛數', '最常用陣型的中場數', '最常用陣型的前鋒數'];
        parts.forEach((n, i) => { if (Number.isFinite(n)) F(`${key}.shape${i}`, `${t.en} ${names[Math.min(i, 2)]}`, n); });
      }
      F(`${key}.xg90`, `${t.en} 每 90 分鐘期望進球`, oneDp(tac.attack.xG90));
      F(`${key}.xga90`, `${t.en} 每 90 分鐘期望失球`, oneDp(tac.defence.xGA90));
      F(`${key}.finishing`, `${t.en} 整季比期望多進的球數`, round(tac.attack.finishing, 1));
      if (tac.defence.cleanSheets != null) F(`${key}.cleanSheets`, `${t.en} 上季零封場次`, tac.defence.cleanSheets);
      /* 守成率:英超側寫自己算好在 resilience;西甲的在球隊上季摘要的 half 裡(同一個定義:半場領先後拿下 / 落後後翻盤) */
      const res = tac.resilience ?? (t.lastSeason?.half?.leadHoldPct != null
        ? { leadHoldPct: t.lastSeason.half.leadHoldPct, trailRescuePct: t.lastSeason.half.trailRescuePct } : null);
      if (res) {
        F(`${key}.leadHold`, `${t.en} 領先守成率`, oneDp(res.leadHoldPct), `${oneDp(res.leadHoldPct)}%`);
        F(`${key}.trailRescue`, `${t.en} 落後翻盤率`, oneDp(res.trailRescuePct), `${oneDp(res.trailRescuePct)}%`);
      }
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
      // average:由逐場登錄位置平均出來的站位(英超);mostUsed:上季用最多分鐘的陣型(西甲 Understat)
      kind: (tacticsHome ?? tacticsAway)?.formation?.def != null ? 'average' : 'mostUsed',
    },
    // 升班馬沒有上季英超統計。與其讓文章默默少講一邊,不如明講為什麼。
    noHistory: [
      tacticsHome ? null : home.en,
      tacticsAway ? null : away.en,
    ].filter(Boolean),
    league,
    facts,
    provenance: {
      source: provenance?.source ?? 'openfootball 賽果 + FPL 官方統計',
      model: provenance?.model ?? 'Dixon-Coles Poisson 與 Elo 平均',
      asOf, seasonLabel,
    },
  };
}

/* ── 賽後 ──────────────────────────────────── */
/* 陣型人數:英超那份由登錄位置推導,有 DEF/MID/FWD;西甲那份只有供應商的正式陣型標籤
   (5-4-1)與 back/front。從標籤拆:第一段後衛、最後一段前鋒、中間全部算中場。 */
function shapeCounts(shape) {
  if (!shape) return null;
  if (shape.DEF != null && shape.MID != null && shape.FWD != null) return { DEF: shape.DEF, MID: shape.MID, FWD: shape.FWD };
  const parts = String(shape.label ?? '').split('-').map(x => Number(x.trim()));
  if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return null;
  return { DEF: parts[0], MID: parts.slice(1, -1).reduce((a, b) => a + b, 0), FWD: parts.at(-1) };
}

export function postMatchBundle({ report, home, away, asOf, seasonLabel, league = PL, provenance = null }) {
  const H = report.sides[report.home], A = report.sides[report.away];
  const facts = [];
  const F = (...a) => facts.push(fact(...a));

  F('score.home', `${home.en} 進球`, report.hs);
  F('score.away', `${away.en} 進球`, report.as);
  F('minute', '比賽進行分鐘', report.minute);

  /* 本場 xG:英超由 FPL 逐人 xG 合計(sides.xG);西甲供應商沒給,改用 FotMob 逐射門 xG 加總,
     但只在 shotmap 完整(進球數對得上比分)時採用 —— 缺一顆射門的加總是錯的數字,不是近似值。 */
  const adv = report.advanced ?? null;
  const shotsOk = !!adv?.shots?.length && adv.shotmapComplete !== false;
  const xgOf = (side, code) => side.xG != null ? { v: side.xG, src: 'supplier' }
    : shotsOk ? { v: round(adv.shots.filter(s => s.team === code && !s.ownGoal).reduce((a, s) => a + (s.xg ?? 0), 0), 2), src: 'fotmob' } : null;
  const xgH = xgOf(H, report.home), xgA = xgOf(A, report.away);
  const xgSource = xgH && xgA ? xgH.src : null;
  if (xgSource) {
    F('xg.home', `${home.en} 本場期望進球`, xgH.v);
    F('xg.away', `${away.en} 本場期望進球`, xgA.v);
    F('xg.gap', '雙方期望進球差距', round(Math.abs(xgH.v - xgA.v), 2));
  }
  if (H.xA != null && A.xA != null) {
    F('xa.home', `${home.en} 本場期望助攻`, H.xA);
    F('xa.away', `${away.en} 本場期望助攻`, A.xA);
  }
  /* 控球與射門:兩個聯賽的 advanced 都可能有(英超 pulselive/FotMob、西甲 SportMonks/FotMob)。
     有就進 facts,模板在沒有 xG 時拿它們講場面。 */
  const poss = adv?.possession?.all;
  if (Array.isArray(poss) && poss[0] != null && poss[1] != null) {
    F('poss.home', `${home.en} 控球率`, poss[0], `${poss[0]}%`);
    F('poss.away', `${away.en} 控球率`, poss[1], `${poss[1]}%`);
  }
  const ts = adv?.teamStats ?? null;
  if (ts?.[report.home]?.shots != null && ts?.[report.away]?.shots != null) {
    F('shots.home', `${home.en} 射門`, ts[report.home].shots);
    F('shots.away', `${away.en} 射門`, ts[report.away].shots);
    if (ts[report.home].shotsOn != null && ts[report.away].shotsOn != null) {
      F('shotsOn.home', `${home.en} 射正`, ts[report.home].shotsOn);
      F('shotsOn.away', `${away.en} 射正`, ts[report.away].shotsOn);
    }
  }
  F('cards.homeYellow', `${home.en} 黃牌`, H.yellow);
  F('cards.awayYellow', `${away.en} 黃牌`, A.yellow);
  if (H.red) F('cards.homeRed', `${home.en} 紅牌`, H.red);
  if (A.red) F('cards.awayRed', `${away.en} 紅牌`, A.red);

  for (const [s, t, key] of [[H, home, 'home'], [A, away, 'away']]) {
    const sc = shapeCounts(s.shape);
    if (sc) {
      F(`${key}.shapeDef`, `${t.en} 先發後衛數`, sc.DEF);
      F(`${key}.shapeMid`, `${t.en} 先發中場數`, sc.MID);
      F(`${key}.shapeFwd`, `${t.en} 先發前鋒數`, sc.FWD);
    }
    F(`${key}.subs`, `${t.en} 用掉的替補人次`, s.bench.length);
    if (s.shapeDelta) F(`${key}.shapeDelta`, `${t.en} 後場人數與上季常態的差`, s.shapeDelta.def);
    for (const b of s.bench.slice(0, 3)) if (b.onAbout != null) F(`${key}.on.${b.name}`, `${b.name} 推估上場分鐘`, b.onAbout);
    if (s.keeper?.saves != null) {
      F(`${key}.saves`, `${t.en} 門將撲救`, s.keeper.saves);
      if (s.keeper.stopped != null) F(`${key}.gkStopped`, `${t.en} 門將比期望少失球`, s.keeper.stopped);
    }
    for (const b of s.best) F(`${key}.bps.${b.name}`, `${t.en} ${b.name} 的 BPS`, b.bps);
    for (const g of s.scorers) F(`${key}.goals.${g.name}`, `${g.name} 進球數`, g.goals);
  }

  if (report.preMatch) {
    F('pre.home', '賽前主勝機率', report.preMatch.home, pctText(report.preMatch.home));
    F('pre.draw', '賽前和局機率', report.preMatch.draw, pctText(report.preMatch.draw));
    F('pre.away', '賽前客勝機率', report.preMatch.away, pctText(report.preMatch.away));
    if (report.preMatch.xgHome != null && report.preMatch.xgAway != null) {
      F('pre.xgHome', `賽前預期 ${home.en} 進球`, round(report.preMatch.xgHome, 2));
      F('pre.xgAway', `賽前預期 ${away.en} 進球`, round(report.preMatch.xgAway, 2));
    }
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
    league,
    // 模板與免責說明要照這兩個講話:xG 是誰算的、陣型是公布的還是推導的
    xgSource,
    shapeSource: H.shape?.source ?? null,
    facts,
    provenance: {
      source: provenance?.source ?? 'FPL 官方即時統計(出場、進球、助攻、xG/xA、BPS)',
      model: provenance?.model ?? '陣型由實際出場位置推導,換人時間由出場分鐘反推',
      asOf, seasonLabel,
    },
  };
}
