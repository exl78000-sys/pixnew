import { round, sum } from './util.mjs';
import { inPlay } from './inplay.mjs';

// 由單場的真實出場資料,推導出這場比賽的陣容配置、戰術取向與內容評價。
//
// 重要:FPL 的資料沒有進球與卡牌的「發生分鐘」,所以事件列表不會假造時間。
// 換人時間可以由出場分鐘反推(替補打 30 分鐘 ≈ 第 60 分鐘上場),標示為推估值。

const ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

/* 這場的陣型。
   有官方公布就用官方的 —— FPL 只有四個粗類、又把邊鋒歸為中場、翼衛歸為後衛,
   照它數的話 Chelsea 的 3-4-2-1 會變成「6-3-1」(三中衛+兩翼衛+一個算進後衛),
   Fulham 的 4-2-3-1 會變成「4-5-1」。那不是球隊排的陣型,是分類太粗。 */
function shapeOf(xi, official = null) {
  const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of xi) c[p.pos] = (c[p.pos] ?? 0) + 1;

  // 官方排位:rows[0] 是門將,其餘由後往前一排一排
  const lines = official?.rows?.length > 1 ? official.rows.slice(1).map(r => r.length) : null;
  const label = official?.formation ?? `${c.DEF}-${c.MID}-${c.FWD}`;
  const back = lines ? lines[0] : c.DEF;
  const front = lines ? lines[lines.length - 1] : c.FWD;

  let shapeZh;
  if (back >= 5) shapeZh = '五後衛 / 三中衛體系';
  else if (back <= 3) shapeZh = '三後衛';
  else shapeZh = '四後衛';
  if (front >= 2) shapeZh += '・雙前鋒';
  else if (front <= 0) shapeZh += '・無正印中鋒';
  else shapeZh += '・單箭頭';

  return {
    ...c, label, shapeZh,
    // 註記來源:前端要能講清楚這個陣型是官方公布的還是我們數出來的
    source: official?.formation ? 'official' : 'fpl',
    // 攻守判斷用官方的線數,沒有才退回 FPL 粗類
    back, front,
  };
}

function sideReport(players, matchMinutes, seasonShape, official = null) {
  const xi = players.filter(p => p.starts > 0).sort((a, b) => ORDER[a.pos] - ORDER[b.pos] || b.minutes - a.minutes);
  const bench = players.filter(p => !p.starts && p.minutes > 0)
    .map(p => ({ ...p, onAbout: Math.max(1, (matchMinutes || 90) - p.minutes) }))
    .sort((a, b) => a.onAbout - b.onAbout);
  const offs = xi.filter(p => p.minutes < (matchMinutes || 90) - 1)
    .map(p => ({ ...p, offAbout: p.minutes }))
    .sort((a, b) => a.offAbout - b.offAbout);

  const shape = shapeOf(xi, official);
  const gk = players.filter(p => p.pos === 'GK').sort((a, b) => b.minutes - a.minutes)[0] ?? null;

  /* 球場圖要照官方排位畫。站位取官方、場中狀態(進球/卡牌/分鐘)取即時資料,
     兩邊用 code 接起來 —— 只用官方的話會少掉進球標記,只用即時的話站位是錯的。 */
  const byCode = new Map(xi.map(p => [p.code, p]));
  const rows = official?.rows?.length
    ? official.rows.map(row => row.map(op => {
      const live = op.code ? byCode.get(op.code) : null;
      return live ? { ...live, role: op.role ?? live.role ?? null } : { name: op.name, pos: op.pos, code: op.code ?? null, minutes: null };
    }))
    : null;

  return {
    xi, bench, offs, shape, rows,
    seasonShape: seasonShape ?? null,
    shapeDelta: seasonShape ? {
      def: round(shape.DEF - seasonShape.def, 1),
      mid: round(shape.MID - seasonShape.mid, 1),
      fwd: round(shape.FWD - seasonShape.fwd, 1),
    } : null,
    xG: round(sum(players, p => p.xG), 2),
    xA: round(sum(players, p => p.xA), 2),
    goals: sum(players, p => p.goals),
    assists: sum(players, p => p.assists),
    yellow: sum(players, p => p.yellow),
    red: sum(players, p => p.red),
    keeper: gk ? { name: gk.name, saves: gk.saves, conceded: gk.conceded, xGC: round(gk.xGC, 2), stopped: round(gk.xGC - gk.conceded, 2) } : null,
    scorers: players.filter(p => p.goals > 0).map(p => ({ name: p.name, goals: p.goals })),
    assisters: players.filter(p => p.assists > 0).map(p => ({ name: p.name, assists: p.assists })),
    cards: players.filter(p => p.yellow || p.red).map(p => ({ name: p.name, yellow: p.yellow, red: p.red })),
    best: [...players].sort((a, b) => b.bps - a.bps).slice(0, 3).map(p => ({ name: p.name, pos: p.pos, bps: p.bps, minutes: p.minutes })),
    used: players.length,
  };
}

function notesFor(rep, zh) {
  const n = [];
  const push = (kind, text) => n.push({ kind, text });
  const H = rep.sides[rep.home], A = rep.sides[rep.away];
  const nameH = zh(rep.home), nameA = zh(rep.away);

  for (const [code, s, name] of [[rep.home, H, nameH], [rep.away, A, nameA]]) {
    if (!s.xi.length) continue;
    // 官方陣型跟上季常態不能直接比:常態是 FPL 四粗類算的(翼衛算後衛、邊鋒算中場),
    // 官方是真正的線。拿 3(官方後衛線)去減 4.4(FPL 後衛數)會得到假的差距。
    if (s.shape.source !== 'official' && s.shapeDelta && Math.abs(s.shapeDelta.def) >= 0.7) {
      push('shape', s.shapeDelta.def > 0
        ? `${name} 這場排出 ${s.shape.label},後場比上季常態多約 ${Math.abs(s.shapeDelta.def)} 人,重心明顯往後壓。`
        : `${name} 這場排出 ${s.shape.label},後場比上季常態少約 ${Math.abs(s.shapeDelta.def)} 人,防線推得更前面。`);
    }
    if (s.shape.front >= 2) push('shape', `${name} 用雙前鋒(${s.shape.label}),前場有兩個支點。`);
    if (s.shape.front === 0) push('shape', `${name} 先發沒有正印中鋒(${s.shape.label}),偏向無鋒陣、由中場插上。`);
    if (s.red > 0) push('cards', `${name} 吃到 ${s.red} 張紅牌,少打一人已反映在即時勝率上。`);
  }

  // 比分與內容(xG)是否一致
  const gd = (rep.hs ?? 0) - (rep.as ?? 0);
  const xgd = H.xG - A.xG;
  if (rep.started && Math.abs(xgd) >= 0.6 && Math.sign(xgd) !== Math.sign(gd) && gd !== 0) {
    const lucky = gd > 0 ? nameH : nameA;
    const robbed = gd > 0 ? nameA : nameH;
    push('xg', `比分站在 ${lucky} 這邊,但期望進球是 ${H.xG} 比 ${A.xG} —— 內容其實是 ${robbed} 佔優,結果超出了表現。`);
  } else if (rep.started && Math.abs(xgd) >= 1.2) {
    push('xg', `期望進球 ${H.xG} 比 ${A.xG},場面一面倒,比分與內容一致。`);
  }

  for (const [s, name, opp] of [[H, nameH, nameA], [A, nameA, nameH]]) {
    if (s.keeper && s.keeper.saves >= 5) {
      push('keeper', `${name} 門將 ${s.keeper.name} 撲救 ${s.keeper.saves} 次` +
        (s.keeper.stopped > 0.5 ? `,比期望少失 ${s.keeper.stopped} 球,是這場撐住球隊的人。` : '。'));
    }
    const benchGoals = sum(s.bench, p => p.goals + p.assists);
    if (benchGoals > 0) push('bench', `${name} 的替補直接參與 ${benchGoals} 球,換人換出了效果。`);
    if (s.bench.length >= 3) {
      const window = s.bench.slice(0, 3);
      const spread = Math.max(...window.map(p => p.onAbout)) - Math.min(...window.map(p => p.onAbout));
      if (spread <= 3) push('bench', `${name} 在約第 ${window[0].onAbout} 分鐘一次換上三人,是明顯的整批調整。`);
    }
  }
  return n;
}

export function buildMatchReport({ fixture, prediction, tactics, zh, official = null }) {
  const { home, away, lineups } = fixture;
  const matchMinutes = fixture.minutes || (fixture.finished ? 90 : 0);
  const seasonShape = code => {
    const t = tactics.get(code);
    return t ? { def: t.formation.def, mid: t.formation.mid, fwd: t.formation.fwd, label: t.formation.label } : null;
  };

  const rep = {
    key: fixture.key, home, away, kickoff: fixture.kickoff,
    started: fixture.started, finished: fixture.finished,
    minute: matchMinutes, hs: fixture.hs, as: fixture.as,
    sides: {
      [home]: sideReport(lineups[home] ?? [], matchMinutes, seasonShape(home), official?.home ?? null),
      [away]: sideReport(lineups[away] ?? [], matchMinutes, seasonShape(away), official?.away ?? null),
    },
  };

  if (prediction) {
    rep.inplay = inPlay({
      lambdaHome: prediction.xgHome, lambdaAway: prediction.xgAway,
      hs: fixture.hs ?? 0, as: fixture.as ?? 0,
      minute: matchMinutes, finished: fixture.finished,
      redHome: rep.sides[home].red, redAway: rep.sides[away].red,
    });
    rep.preMatch = { home: prediction.home, draw: prediction.draw, away: prediction.away, xgHome: prediction.xgHome, xgAway: prediction.xgAway };
    rep.vsPrediction = {
      xgHomeDiff: round(rep.sides[home].xG - prediction.xgHome, 2),
      xgAwayDiff: round(rep.sides[away].xG - prediction.xgAway, 2),
    };
  }
  rep.notes = notesFor(rep, zh);
  return rep;
}
