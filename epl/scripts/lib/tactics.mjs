import { round, sum, percentile } from './util.mjs';
import { ageOn } from './adapters/fpl-snapshot.mjs';


// 由出場分鐘的位置分佈反推「平均場上陣型」
function formationOf(teamPlayers) {
  const by = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of teamPlayers) by[p.pos] = (by[p.pos] || 0) + p.minutes;
  const outfield = by.DEF + by.MID + by.FWD || 1;
  const def = (by.DEF / outfield) * 10, mid = (by.MID / outfield) * 10, fwd = (by.FWD / outfield) * 10;
  // 注意:FPL 把邊鋒歸類為中場,所以這裡量的是「後場/中場/鋒線的人力配置」,
  // 不是轉播圖上的陣型。小數本身才是重點(4.9 名後衛 = 五後衛體系)。
  const label = `${round(def, 1)} - ${round(mid, 1)} - ${round(fwd, 1)}`;
  const notes = [];
  let shape;
  if (def >= 4.55) { shape = '五後衛 / 三中衛體系'; notes.push('後場長期五人,翼衛負責寬度'); }
  else if (def <= 3.7) { shape = '偏三後衛出球'; notes.push('後場人力偏少,重心壓上'); }
  else shape = '四後衛體系';
  if (fwd >= 1.55) notes.push('雙前鋒/前場雙塔');
  else if (fwd <= 1.15) notes.push('單箭頭,前場靠中場插上');
  if (mid >= 5.2) notes.push('中場人數厚實(含邊鋒)');
  return { def: round(def, 2), mid: round(mid, 2), fwd: round(fwd, 2), label, shape, notes };
}

function setPieceTakers(teamPlayers) {
  const pick = key => teamPlayers.filter(p => p[key]).sort((a, b) => a[key] - b[key]).slice(0, 3)
    .map(p => ({ name: p.name, order: p[key] }));
  return { pen: pick('penOrder'), fk: pick('fkOrder'), corner: pick('cornerOrder') };
}

export function buildTactics({ tableRows, lastPlayers, currentPlayers, asOf }) {
  const byTeam = new Map();
  for (const p of lastPlayers) {
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const curByTeam = new Map();
  for (const p of currentPlayers) {
    if (!curByTeam.has(p.team)) curByTeam.set(p.team, []);
    curByTeam.get(p.team).push(p);
  }

  const profiles = tableRows.map(row => {
    const squad = byTeam.get(row.code) ?? [];
    const gks = squad.filter(p => p.pos === 'GK');
    const used = squad.filter(p => p.minutes > 0);
    const minutesSorted = [...used].sort((a, b) => b.minutes - a.minutes);
    const top11 = sum(minutesSorted.slice(0, 11), p => p.minutes);
    const totalMin = sum(used, p => p.minutes) || 1;
    const xG = sum(squad, p => p.xG);
    const xA = sum(squad, p => p.xA);
    const xGA = sum(gks, p => p.xGC);       // 門將的 xGC ≈ 全隊被創造的期望失球
    const defGoals = sum(squad.filter(p => p.pos === 'DEF' || p.pos === 'GK'), p => p.goals);
    const ageW = sum(used, p => (ageOn(p.birthDate, asOf) ?? 0) * p.minutes) / totalMin;

    const p = row.p || 38;
    return {
      code: row.code,
      pos: row.pos,
      formation: formationOf(squad),
      attack: {
        goals: row.gf, xG: round(xG, 1), xG90: round((xG / p), 2),
        finishing: round(row.gf - xG, 1),
        xA: round(xA, 1),
        creativity90: round(sum(squad, s => s.creativity) / p, 1),
        threat90: round(sum(squad, s => s.threat) / p, 1),
      },
      defence: {
        conceded: row.ga, xGA: round(xGA, 1), xGA90: round(xGA / p, 2),
        overperform: round(xGA - row.ga, 1),   // 正 = 實際失球少於期望(門將/運氣加成)
        cleanSheets: row.cleanSheets,
        defCon90: round(sum(squad, s => s.defCon) / p, 1),
      },
      setPieces: {
        takers: setPieceTakers(squad),
        defenderGoalShare: round(row.gf ? (defGoals / row.gf) * 100 : 0, 1),
        defenderGoals: defGoals,
      },
      squad: {
        used: used.length,
        // 用該隊實際出賽場次推,不寫死 38 場
        top11Share: round((top11 / (p * 90 * 11)) * 100, 1),
        avgAgeWeighted: round(ageW, 1),
        currentSize: (curByTeam.get(row.code) ?? []).length,
      },
      discipline: {
        yellow: sum(squad, s => s.yellow), red: sum(squad, s => s.red),
        perGame: round((sum(squad, s => s.yellow) + sum(squad, s => s.red) * 2) / p, 2),
      },
      tempo: {
        gf1: row.half.gf1, gf2: row.half.gf2, ga1: row.half.ga1, ga2: row.half.ga2,
        secondHalfSwing: row.half.secondHalfSwing,
      },
      resilience: {
        leadHoldPct: row.half.leadHoldPct, trailRescuePct: row.half.trailRescuePct,
        comeback: row.half.comeback, collapse: row.half.collapse,
      },
      homeAwayGap: row.homeAwayGap,
      homePpg: row.home.ppg, awayPpg: row.away.ppg,
      ppg: row.ppg,
    };
  });

  // 風格雷達:同一指標在 20 隊之中的百分位
  const axes = [
    { label: '進攻火力', get: t => t.attack.xG90 },
    { label: '終結效率', get: t => t.attack.finishing },
    { label: '防守穩固', get: t => t.defence.xGA90, inverse: true },
    { label: '傳球創造', get: t => t.attack.creativity90 },
    { label: '定位球威脅', get: t => t.setPieces.defenderGoalShare },
    { label: '比賽韌性', get: t => ((t.resilience.leadHoldPct ?? 0) + (t.resilience.trailRescuePct ?? 0) * 1.5) / 2 },
  ];
  for (const t of profiles) {
    t.radar = axes.map(a => {
      const pool = profiles.map(a.get);
      let v = percentile(a.get(t), pool);
      if (a.inverse) v = round(100 - v, 1);
      return { label: a.label, value: v, raw: a.get(t) };
    });
    t.tags = deriveTags(t, profiles);
  }
  return profiles;
}

function deriveTags(t, all) {
  const rank = (get, desc = true) => {
    const vals = all.map(get).sort((a, b) => (desc ? b - a : a - b));
    return vals.indexOf(get(t)) + 1;
  };
  const tags = [];
  if (rank(x => x.attack.xG90) <= 5) tags.push('火力前段');
  if (rank(x => x.defence.xGA90, false) <= 5) tags.push('鐵桶陣');
  if (t.attack.finishing >= 5) tags.push('超額終結');
  if (t.attack.finishing <= -5) tags.push('浪費機會');
  if (t.defence.overperform >= 5) tags.push('門將撐場');
  if (t.formation.def >= 4.55) tags.push('三中衛體系');
  if (t.formation.fwd >= 1.55) tags.push('雙前鋒');
  if (t.tempo.secondHalfSwing >= 6) tags.push('後段發力');
  if (t.tempo.secondHalfSwing <= -6) tags.push('虎頭蛇尾');
  if (t.homeAwayGap >= 0.8) tags.push('主場龍');
  if (t.homeAwayGap <= 0) tags.push('客場不怯場');
  if ((t.resilience.leadHoldPct ?? 100) <= 65) tags.push('守不住領先');
  if (t.resilience.comeback >= 3) tags.push('逆轉王');
  if (t.squad.top11Share >= 70) tags.push('主力吃重');
  if (t.squad.top11Share <= 58) tags.push('大幅輪換');
  if (t.discipline.perGame >= 2.2) tags.push('動作兇悍');
  if (t.setPieces.defenderGoalShare >= 25) tags.push('定位球強權');
  if (t.squad.avgAgeWeighted <= 25.5) tags.push('青春軍團');
  if (t.squad.avgAgeWeighted >= 28.5) tags.push('老練陣容');
  return tags;
}
