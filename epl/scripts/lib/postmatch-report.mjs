// 由供應商中立的完賽資料建立前端共用的 MatchReport。
// 這條路徑不依賴 FPL；西甲可直接用正式陣容、球隊統計與球員評分產生賽後頁。
import { round } from './util.mjs';
import { inPlay } from './inplay.mjs';
import { liveSummaryFor } from './matchreport.mjs';

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
    /* `Number('') === 0` —— 沒有 grid 的話這裡會把整隊算成「第 0 排」,
       球場圖畫成一條線而且不報錯(2026-09-03 接 FotMob 時實測踩到)。
       空字串與 null 一律當成沒有站位資料,整份回 null 讓呼叫端退回。 */
    const raw = String(player.grid ?? '').trim();
    if (!raw) return null;
    const [row] = raw.split(':').map(Number);
    if (!Number.isFinite(row)) return null;
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(player);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list
    .sort((a, b) => Number(String(a.grid).split(':')[1]) - Number(String(b.grid).split(':')[1])));
}

const playerKeys = player => {
  const name = String(player?.name ?? player?.player ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const id = player?.providerId ?? player?.playerId;
  return [...new Set([id != null ? `id:${String(id)}` : null, name ? `name:${name}` : null].filter(Boolean))];
};

const playerKey = player => playerKeys(player)[0] ?? null;

const addCount = (map, player) => {
  for (const key of playerKeys(player)) map.set(key, (map.get(key) ?? 0) + 1);
};

const countFor = (map, player) => playerKeys(player).map(key => map.get(key) ?? 0).find(Boolean) ?? 0;

function goalEvidence(detail, fixture) {
  const goals = new Map(), assists = new Map();
  const byTeam = { [fixture.home]: 0, [fixture.away]: 0 };
  for (const event of detail.events ?? []) {
    if (event?.type !== 'Goal' || !(event.team in byTeam)) continue;
    byTeam[event.team]++;
    addCount(goals, { providerId: event.playerId, name: event.player });
    if (event.assistId != null || event.assist) addCount(assists, { providerId: event.assistId, name: event.assist });
  }
  // 只有兩隊事件進球都精確對回最終比分，才可以拿它覆寫球員統計。
  // 這避免不完整的事件清單把真實射手錯清成 0。
  return {
    complete: byTeam[fixture.home] === fixture.fh && byTeam[fixture.away] === fixture.fa,
    goals, assists,
  };
}

const ratingRows = (list, positionByProviderId = new Map()) => [...list].filter(p => p.rating !== null)
  .sort((a, b) => b.rating - a.rating).slice(0, 3)
  .map(p => ({ name: p.name, pos: pos(positionByProviderId.get(String(p.providerId)) ?? p.pos), minutes: p.minutes, rating: p.rating }));

function sideOf(code, detail, { expectedGoals = null, evidence = null, positionByProviderId = new Map() } = {}) {
  const lineup = detail.lineups?.[code] ?? { xi: [], bench: [], formation: null };
  const stats = detail.players?.[code] ?? [];
  const byId = new Map(stats.filter(p => p.providerId != null).map(p => [String(p.providerId), p]));
  const rawGoalTotal = stats.reduce((total, p) => total + num(p.goals?.total), 0);
  const rawGoalsReliable = expectedGoals !== null && rawGoalTotal === expectedGoals;
  const merge = (player, starts) => {
    const s = byId.get(String(player.providerId)) ?? stats.find(x => x.name === player.name) ?? {};
    const lookup = s.providerId != null ? s : player;
    const eventGoals = evidence ? countFor(evidence.goals, lookup) : 0;
    const eventAssists = evidence ? countFor(evidence.assists, lookup) : 0;
    const goals = evidence?.complete ? eventGoals : (rawGoalsReliable ? num(s.goals?.total) : 0);
    const assists = evidence?.complete ? eventAssists : num(s.goals?.assists);
    const resolvedPos = positionByProviderId.get(String(s.providerId ?? player.providerId)) ?? s.pos ?? player.pos;
    return {
      ...player, ...s, code: null, pos: pos(resolvedPos), role: pos(resolvedPos),
      starts, minutes: s.minutes ?? null,
      goalStats: s.goals ?? {},
      goals, assists,
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
    best: ratingRows(stats, positionByProviderId), used: used.length, coach: lineup.coach ?? null,
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

export function buildProviderMatchReport({ fixture, detail, nameOf = code => code, positionByProviderId = new Map() } = {}) {
  if (!fixture?.played || !detail || fixture.home !== detail.home || fixture.away !== detail.away) return null;
  if (detail.score?.home !== fixture.fh || detail.score?.away !== fixture.fa) return null;
  if (!detail.coverage?.teamStatistics || !detail.coverage?.playerStatistics || !detail.coverage?.ratings || !detail.coverage?.events || !detail.coverage?.lineups) return null;
  const report = {
    key: `${fixture.home}|${fixture.away}`, season: fixture.season,
    home: fixture.home, away: fixture.away, kickoff: detail.kickoff ?? fixture.kickoff ?? null,
    started: true, finished: true, minute: 90, hs: fixture.fh, as: fixture.fa,
    sides: {
      [fixture.home]: sideOf(fixture.home, detail, { expectedGoals: fixture.fh, evidence: goalEvidence(detail, fixture), positionByProviderId }),
      [fixture.away]: sideOf(fixture.away, detail, { expectedGoals: fixture.fa, evidence: goalEvidence(detail, fixture), positionByProviderId }),
    },
    advanced: detail, source: detail.source ?? 'api-football', demo: false,
  };
  report.notes = notesFor(report, detail, nameOf);
  const hxg = report.sides[fixture.home].xG, axg = report.sides[fixture.away].xG;
  report.actual = { xGHome: hxg == null ? null : round(hxg, 2), xGAway: axg == null ? null : round(axg, 2) };
  return report;
}

// 即時賽事沿用同一份 canonical detail，但不要求完賽才有的完整欄位。
// 缺少陣容、評分或統計時仍可畫比分卡；前端會把缺欄位顯示成「未取得」。
export function buildLiveProviderReport({ fixture, detail, prediction = null, minute = 0, nameOf = code => code } = {}) {
  if (!fixture || !detail || fixture.home !== detail.home || fixture.away !== detail.away) return null;
  const hs = detail.score?.home ?? fixture.fh ?? null;
  const as = detail.score?.away ?? fixture.fa ?? null;
  const report = {
    key: `${fixture.home}|${fixture.away}`, season: fixture.season,
    home: fixture.home, away: fixture.away, kickoff: detail.kickoff ?? fixture.kickoff ?? null,
    started: true, finished: fixture.finished === true, minute: Number.isFinite(Number(minute)) ? Number(minute) : 0,
    hs, as,
    sides: {
      [fixture.home]: sideOf(fixture.home, detail),
      [fixture.away]: sideOf(fixture.away, detail),
    },
    advanced: detail, source: detail.source ?? 'sportmonks', demo: false,
  };
  /* 進行中的 livescores 沒有陣容與逐人統計,sides 是空殼 —— 但事件裡有進球。
     判進球用兩個訊號取聯集:adapter 對到型別的 'Goal',或 addition 欄的序數寫法
     (實測 '1st Goal'…'5th Goal';'Goal Disallowed' 不匹配序數式,自然排除)。
     **數量對得上該隊比分才掛**:烏龍球事件的隊伍語意沒驗證過,對不上寧可不標
     (配錯人比不標糟)。牌的事件還沒在真實 payload 看過型別,不從事件推。 */
  const evs = Array.isArray(detail.events) ? detail.events : [];
  const isGoalEvent = e => e.type === 'Goal' || /^\d+(st|nd|rd|th) goal$/i.test(String(e.comments ?? '').trim());
  for (const [side, scored] of [[fixture.home, hs], [fixture.away, as]]) {
    const s = report.sides[side];
    if (s.scorers.length || s.used > 0) continue;
    const gs = evs.filter(e => e.team === side && isGoalEvent(e));
    if (!gs.length || gs.length !== scored) continue;
    const byName = new Map();
    for (const e of gs) byName.set(e.player ?? '?', (byName.get(e.player ?? '?') ?? 0) + 1);
    s.scorers = [...byName].map(([name, goals]) => ({ name, goals }));
    s.goals = gs.length;
  }
  report.notes = notesFor(report, detail, nameOf);
  if (prediction && hs != null && as != null) {
    // 即時勝率由「賽前預測 + 目前比分／分鐘」計算，不使用賽後結果重擬合。
    report.inplay = inPlay({
      lambdaHome: prediction.xgHome, lambdaAway: prediction.xgAway,
      hs, as, minute: report.minute, finished: report.finished,
      redHome: report.sides[fixture.home].red, redAway: report.sides[fixture.away].red,
    });
    report.preMatch = { home: prediction.home, draw: prediction.draw, away: prediction.away, xgHome: prediction.xgHome, xgAway: prediction.xgAway };
    /* 講評走英超同一支 liveSummaryFor(規則生成、每句只引用算好的數字)——
       沒有的資料(場上 xG、FPL 指數、陣型)它自己會跳過那幾句,不印 null。 */
    report.liveSummary = liveSummaryFor(report, nameOf);
  }
  return report;
}
