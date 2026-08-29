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
    /* 場上數據合計:FPL 即時逐人欄位的全隊加總。只放 FPL 真的給的 ——
       控球率/射門次數/角球沒有免費的即時來源,缺的欄位不出現,不用估計值補。
       威脅/創造/影響是 FPL 官方指數(小數),防守三項是動作計數。 */
    stats: {
      threat: round(sum(players, p => p.threat ?? 0), 0),
      creativity: round(sum(players, p => p.creativity ?? 0), 0),
      influence: round(sum(players, p => p.influence ?? 0), 0),
      tackles: sum(players, p => p.tackles ?? 0),
      recoveries: sum(players, p => p.recoveries ?? 0),
      cbi: sum(players, p => p.cbi ?? 0),
      topThreat: topBy(players, 'threat'),
      topCreator: topBy(players, 'creativity'),
    },
  };
}

/* 某個即時指數最高的球員(要真的有值才回,0 的時候回 null —— 開賽初期全是 0)。 */
function topBy(players, key) {
  const p = [...players].filter(x => x.minutes > 0 && x[key] > 0).sort((a, b) => b[key] - a[key])[0];
  return p ? { name: p.name, value: round(p[key], 1) } : null;
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

/* 中場/戰況講評(2026-08-29,使用者要求)。**每一句只引用已算好的數字**
   (報告層的規矩:數字先算完,文字只能引用),規則生成、不經 LLM。
   FPL 的 minute 在中場休息停在 45 —— 43~50 這段當「中場講評」,
   其餘進行中時段是「戰況講評」。 */
function liveSummaryFor(rep, zh) {
  if (!rep.started || rep.finished || !rep.inplay) return null;
  const H = rep.sides[rep.home], A = rep.sides[rep.away];
  const nameH = zh(rep.home), nameA = zh(rep.away);
  const pc = v => Math.round(v * 100) + '%';
  const atHT = rep.minute >= 43 && rep.minute <= 50;
  const ps = [];

  ps.push(`${atHT ? '上半場結束' : `第 ${rep.minute} 分鐘`},${nameH} ${rep.hs ?? 0}:${rep.as ?? 0} ${nameA}。`);

  const xgd = round(H.xG - A.xG, 2);
  if (Math.abs(xgd) >= 0.4) {
    const better = xgd > 0 ? nameH : nameA;
    ps.push(`場上 xG ${H.xG}:${A.xG},內容上${better}佔優。`);
  } else {
    ps.push(`場上 xG ${H.xG}:${A.xG},兩邊創造的機會量接近。`);
  }

  /* 場上數據句:全部從 FPL 即時合計來。開關看「有沒有任何一項動起來」——
     實測中場時 威脅/創造/影響 三個指數還是 0、防守計數卻已經有值,
     只看指數會把真資料一起藏掉。各句另有自己的門檻,沒到就不講。 */
  const sh = H.stats, sa = A.stats;
  const active = s => s.threat + s.creativity + s.influence + s.tackles + s.recoveries + s.cbi;
  if (sh && sa && active(sh) + active(sa) > 0) {
    if (sh.threat + sa.threat >= 30) {
      const lead = sh.threat > sa.threat ? nameH : nameA;
      const gap = Math.abs(sh.threat - sa.threat);
      const tp = [sh.topThreat && { ...sh.topThreat, team: nameH }, sa.topThreat && { ...sa.topThreat, team: nameA }]
        .filter(Boolean).sort((a, b) => b.value - a.value)[0];
      ps.push(`進攻威脅值 ${sh.threat}:${sa.threat}`
        + (gap >= Math.max(15, (sh.threat + sa.threat) * 0.25) ? `,攻勢的殺傷力偏向${lead}` : ',兩邊的攻勢威脅接近')
        + (tp ? `;場上威脅最高的是 ${tp.name}(${tp.value})` : '') + '。');
    }
    const dh = sh.tackles + sh.recoveries + sh.cbi, da = sa.tackles + sa.recoveries + sa.cbi;
    if (dh + da >= 30 && Math.abs(dh - da) >= (dh + da) * 0.2) {
      const busy = dh > da ? nameH : nameA;
      ps.push(`防守端${busy}明顯更忙:搶斷+回收+解圍 ${dh} 對 ${da} —— 防守動作多的一邊,通常就是被壓著打的一邊。`);
    }
    const saves = [];
    if ((H.keeper?.saves ?? 0) >= 2) saves.push(`${H.keeper.name} ${H.keeper.saves} 次`);
    if ((A.keeper?.saves ?? 0) >= 2) saves.push(`${A.keeper.name} ${A.keeper.saves} 次`);
    if (saves.length) ps.push(`門將撲救:${saves.join('、')}。`);
    const reds = [...H.cards, ...A.cards].filter(c => c.red).map(c => c.name);
    if (reds.length) ps.push(`${reds.join('、')}已被罰下,少人的一邊要重排防線。`);
    else if (H.yellow + A.yellow >= 3) ps.push(`場面火氣不小:雙方已累計 ${H.yellow + A.yellow} 張黃牌。`);
  }

  const pm = rep.preMatch, ip = rep.inplay;
  const moves = [
    ['home', nameH + '勝'], ['draw', '和局'], ['away', nameA + '勝'],
  ].map(([k, label]) => ({ label, d: ip[k] - pm[k] })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const top = moves[0];
  ps.push(`賽前模型 ${pc(pm.home)}/${pc(pm.draw)}/${pc(pm.away)}(主/和/客),`
    + `目前 ${pc(ip.home)}/${pc(ip.draw)}/${pc(ip.away)} —— `
    + `${top.label}的機率${top.d >= 0 ? '升' : '降'}了 ${Math.abs(Math.round(top.d * 100))} 個百分點。`);

  if (ip.nextGoal) {
    ps.push(`模型估下一球:${nameH} ${pc(ip.nextGoal.home)}、${nameA} ${pc(ip.nextGoal.away)},`
      + `剩餘時間期望再進 ${ip.xgRestHome}:${ip.xgRestAway}。`);
  }
  if (H.shape?.source === 'official' && A.shape?.source === 'official') {
    ps.push(`實際陣型 ${H.shape.label} 對 ${A.shape.label}(官方名單)。`);
  }
  /* 收尾:當下全場表現分(BPS)領先的人 —— FPL 用它決定 bonus,等於即時的最佳球員。 */
  const bestAll = [...(H.best ?? []).map(b => ({ ...b, team: nameH })),
    ...(A.best ?? []).map(b => ({ ...b, team: nameA }))]
    .filter(b => b.bps > 0).sort((a, b) => b.bps - a.bps)[0];
  if (bestAll) ps.push(`目前全場表現分(BPS)最高的是 ${bestAll.name}(${bestAll.team},${bestAll.bps} 分)—— FPL 就是用這個分數決定賽後 bonus。`);
  return { kind: atHT ? 'ht' : 'live', minute: rep.minute, paragraphs: ps };
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
  rep.liveSummary = liveSummaryFor(rep, zh);
  return rep;
}
