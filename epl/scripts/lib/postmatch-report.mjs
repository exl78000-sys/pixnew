// 由供應商中立的完賽資料建立前端共用的 MatchReport。
// 這條路徑不依賴 FPL；西甲可直接用正式陣容、球隊統計與球員評分產生賽後頁。
import { round } from './util.mjs';

const pos = value => ({ G: 'GK', D: 'DEF', M: 'MID', F: 'FWD' }[value] ?? value ?? '?');
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;

function shapeOf(formation) {
  const lines = String(formation ?? '').split('-').map(Number).filter(Number.isFinite);
  const back = lines[0] ?? null, front = lines.at(-1) ?? null;
  let shapeZh = '正式陣型';
  if (back !== null) shapeZh = back >= 5 ? '五後衛 / 三中衛體系' : back <= 3 ? '三後衛' : '四後衛';
  if (front !== null) shapeZh += front >= 2 ? '・雙前鋒' : front === 0 ? '・無正印中鋒' : '・單箭頭';
  return { label: formation ?? '—', shapeZh, source: 'official', back, front };
}

function rowsOf(players) {
  const rows = new Map();
  for (const player of players) {
    const [row] = String(player.grid ?? '').split(':').map(Number);
    if (!Number.isFinite(row)) return null;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(player);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list
    .sort((a, b) => Number(String(a.grid).split(':')[1]) - Number(String(b.grid).split(':')[1])));
}

const ratingRows = list => [...list].filter(p => p.rating !== null)
  .sort((a, b) => b.rating - a.rating).slice(0, 3)
  .map(p => ({ name: p.name, pos: pos(p.pos), minutes: p.minutes, rating: p.rating }));

function sideOf(code, detail) {
  const lineup = detail.lineups?.[code] ?? { xi: [], bench: [], formation: null };
  const stats = detail.players?.[code] ?? [];
  const byId = new Map(stats.filter(p => p.providerId != null).map(p => [String(p.providerId), p]));
  const merge = (player, starts) => {
    const s = byId.get(String(player.providerId)) ?? stats.find(x => x.name === player.name) ?? {};
    return {
      ...player, ...s, code: null, pos: pos(s.pos ?? player.pos), role: pos(s.pos ?? player.pos),
      starts, minutes: s.minutes ?? null,
      goalStats: s.goals ?? {},
      goals: num(s.goals?.total), assists: num(s.goals?.assists),
      yellow: num(s.cards?.yellow), red: num(s.cards?.red),
      photo: s.photo ?? null,
    };
  };
  const xi = lineup.xi.map(p => merge(p, 1));
  const bench = lineup.bench.map(p => merge(p, 0)).filter(p => (p.minutes ?? 0) > 0)
    .map(p => ({ ...p, onAbout: Math.max(1, 90 - p.minutes) }));
  const used = [...xi, ...bench];
  const keeper = used.filter(p => p.pos === 'GK').sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0))[0] ?? null;
  const team = detail.teamStats?.[code] ?? {};
  return {
    xi, bench, offs: [], rows: rowsOf(xi), shape: shapeOf(lineup.formation), seasonShape: null,
    xG: team.xG ?? null, xA: null,
    goals: used.reduce((n, p) => n + p.goals, 0),
    assists: used.reduce((n, p) => n + p.assists, 0),
    yellow: used.reduce((n, p) => n + p.yellow, 0),
    red: used.reduce((n, p) => n + p.red, 0),
    keeper: keeper ? {
      name: keeper.name, saves: keeper.goalStats?.saves ?? null,
      conceded: keeper.goalStats?.conceded ?? null, xGC: null, stopped: null,
    } : null,
    scorers: used.filter(p => p.goals).map(p => ({ name: p.name, goals: p.goals })),
    assisters: used.filter(p => p.assists).map(p => ({ name: p.name, assists: p.assists })),
    cards: used.filter(p => p.yellow || p.red).map(p => ({ name: p.name, yellow: p.yellow, red: p.red })),
    best: ratingRows(stats), used: used.length, coach: lineup.coach ?? null,
  };
}

function notesFor(report, detail, nameOf) {
  const notes = [];
  const H = detail.teamStats?.[report.home] ?? {}, A = detail.teamStats?.[report.away] ?? {};
  const hn = nameOf(report.home), an = nameOf(report.away);
  if (H.xG != null && A.xG != null) {
    const goalDiff = report.hs - report.as, xgDiff = H.xG - A.xG;
    if (goalDiff && Math.sign(goalDiff) !== Math.sign(xgDiff) && Math.abs(xgDiff) >= 0.5) {
      notes.push({ kind: 'xg', text: `最終比分偏向${goalDiff > 0 ? hn : an}，但實際 xG 是 ${H.xG} 比 ${A.xG}，場面品質與結果並不同向。` });
    }
  }
  if (H.shots != null && A.shots != null && Math.abs(H.shots - A.shots) >= 8) {
    notes.push({ kind: 'shots', text: `${H.shots > A.shots ? hn : an}以 ${Math.max(H.shots, A.shots)} 比 ${Math.min(H.shots, A.shots)} 的射門數明顯佔優。` });
  }
  for (const code of [report.home, report.away]) {
    const side = report.sides[code];
    if (side.shape.label !== '—') notes.push({ kind: 'shape', text: `${nameOf(code)}正式排出 ${side.shape.label}。` });
  }
  return notes;
}

export function buildProviderMatchReport({ fixture, detail, nameOf = code => code } = {}) {
  if (!fixture?.played || !detail || fixture.home !== detail.home || fixture.away !== detail.away) return null;
  if (detail.score?.home !== fixture.fh || detail.score?.away !== fixture.fa) return null;
  if (!detail.coverage?.teamStatistics || !detail.coverage?.playerStatistics || !detail.coverage?.ratings || !detail.coverage?.events || !detail.coverage?.lineups) return null;
  const report = {
    key: `${fixture.home}|${fixture.away}`, season: fixture.season,
    home: fixture.home, away: fixture.away, kickoff: detail.kickoff ?? fixture.kickoff ?? null,
    started: true, finished: true, minute: 90, hs: fixture.fh, as: fixture.fa,
    sides: {
      [fixture.home]: sideOf(fixture.home, detail),
      [fixture.away]: sideOf(fixture.away, detail),
    },
    advanced: detail, source: detail.source ?? 'api-football', demo: false,
  };
  report.notes = notesFor(report, detail, nameOf);
  const hxg = report.sides[fixture.home].xG, axg = report.sides[fixture.away].xG;
  report.actual = { xGHome: hxg == null ? null : round(hxg, 2), xGAway: axg == null ? null : round(axg, 2) };
  return report;
}
