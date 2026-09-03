/* 英超逐場統計(FotMob):控球、球隊統計、逐射門 xG 與情境、逐分鐘動能、事件、名單。
 *
 * 來源是 `data/raw/fotmob-epl/{季}-game-details.json`(`scripts/game/fetch-fotmob-epl.mjs` 抓的精簡萃取;
 * 那支原本是模擬遊玩專用,2026-09-03 使用者決定把這批真資料接進真實管線與 Obsidian vault)。
 * 這裡是**真實管線**的讀取器:build.mjs 用它產 `web/data/matchstats.json`、把本季場次掛成賽後報告的
 * `advanced`、把逐隊彙總掛到 teams.json;vault 產生器讀產物寫進比賽與球隊筆記。
 *
 * 守門(鐵則五,兩個獨立來源):
 *   1. 比分要等於本站賽果(openfootball / FPL,跟 FotMob 獨立);對不上整場不收。抓取器已擋一次,這裡再擋一次 ——
 *      raw 是人也能改的檔案。
 *   2. 控球率:抓取器用官網後端 `/stats/match` 抽核(存在 raw 的 `verification`),這裡把結果帶到產物上;
 *      沒有核對紀錄的賽季照實標「未抽核」,不假裝核過。
 *   3. shotmap 的進球數 ≠ 比分的場次標 `shotmapComplete:false`,射門層的彙總不用它(控球與球隊統計照用)。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = xs => { if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
const dist = xs => ({ mean: xs.length ? r2(mean(xs)) : null, sd: xs.length >= 2 ? r2(sd(xs)) : null, n: xs.length });

export function loadFotmobMatchStats(root, { results = [] } = {}) {
  const dir = join(root, 'data', 'raw', 'fotmob-epl');
  const out = { source: 'FotMob matchDetails', seasons: [], count: 0, rejected: [], verification: {}, matches: {}, teams: {} };
  if (!existsSync(dir)) return out;
  const scoreOf = new Map(results.filter(r => r.played).map(r => [`${r.season}|${r.home}|${r.away}`, [r.fh, r.fa]]));
  for (const f of readdirSync(dir).filter(x => /-game-details\.json$/.test(x)).sort()) {
    const store = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const season = store.season;
    out.seasons.push(season);
    out.verification[season] = store.verification
      ? { checked: store.verification.checked, agree: store.verification.agree, tolerance: store.verification.tolerance, source: store.verification.source }
      : null;
    for (const m of Object.values(store.matches ?? {})) {
      const key = `${season}|${m.home}|${m.away}`;
      const truth = scoreOf.get(key);
      if (!truth) { out.rejected.push({ key, reason: '本站賽果沒有這場(或未完賽)' }); continue; }
      if (truth[0] !== m.score?.[0] || truth[1] !== m.score?.[1] || m.providerScore?.[0] !== truth[0] || m.providerScore?.[1] !== truth[1]) {
        out.rejected.push({ key, reason: `比分不符(本站 ${truth.join('-')},FotMob ${m.providerScore?.join('-')})` }); continue;
      }
      if (!m.possession?.all || m.possession.all[0] + m.possession.all[1] !== 100) { out.rejected.push({ key, reason: '控球率缺或相加不是 100' }); continue; }
      const shotGoals = (m.shots ?? []).filter(s => s.type === 'Goal').length;
      out.matches[key] = {
        key, season, date: m.date, home: m.home, away: m.away, score: [...truth], matchId: m.matchId,
        possession: m.possession, teamStats: m.teamStats, shots: m.shots ?? [], momentum: m.momentum ?? [],
        events: m.events ?? [], lineups: m.lineups ?? null,
        /* 跑動 / 衝刺(2026-09-03 重探後加):供應商的追蹤資料,不是每場都有(2025-26 有 282/380,缺的集中在 11 座主場);沒有就是 null,不是 0 */
        physical: m.physical ?? null,
        shotmapComplete: shotGoals === truth[0] + truth[1],
      };
    }
  }
  out.count = Object.keys(out.matches).length;
  out.seasons = [...new Set(out.seasons)].sort();

  // 逐隊彙總(主客分開):控球分布、每場射門 / 被射門、xG / xGA、射門情境
  const codes = new Set(Object.values(out.matches).flatMap(m => [m.home, m.away]));
  for (const code of codes) {
    const mine = Object.values(out.matches).filter(m => m.home === code || m.away === code);
    const side = (m, isHome) => (isHome ? m.home : m.away);
    const venue = isHome => {
      const rows = mine.filter(m => side(m, isHome) === code);
      const me = m => m.teamStats[code] ?? {}, opp = m => m.teamStats[isHome ? m.away : m.home] ?? {};
      const num = f => rows.map(f).filter(v => Number.isFinite(v));
      return {
        games: rows.length,
        possession: dist(rows.map(m => m.possession.all[isHome ? 0 : 1])),
        shotsFor: rows.length ? r2(mean(num(m => me(m).shots))) : null, shotsAgainst: rows.length ? r2(mean(num(m => opp(m).shots))) : null,
        xgFor: num(m => me(m).xG).length ? r2(mean(num(m => me(m).xG))) : null, xgAgainst: num(m => opp(m).xG).length ? r2(mean(num(m => opp(m).xG))) : null,
        cornersFor: rows.length ? r2(mean(num(m => me(m).corners))) : null, foulsFor: rows.length ? r2(mean(num(m => me(m).fouls))) : null,
      };
    };
    const shots = mine.filter(m => m.shotmapComplete).flatMap(m => m.shots.filter(s => s.team === code));
    const bySit = {};
    for (const s of shots) { const k = s.situation ?? 'Unknown'; bySit[k] ??= { shots: 0, goals: 0, xg: 0 }; bySit[k].shots++; bySit[k].goals += s.type === 'Goal' ? 1 : 0; bySit[k].xg += s.xg ?? 0; }
    /* 跑動與衝刺:只算有資料的場次(n 另記);逐人取每場均值與最高速度,3 場以上才列。 */
    const phys = mine.filter(m => m.physical?.team?.distance?.some(v => v != null));
    const physSide = m => (m.home === code ? 0 : 1);
    const byPlayer = new Map();
    for (const m of phys) for (const p of m.physical.players ?? []) {
      if (p.team !== code) continue;
      const e = byPlayer.get(p.name) ?? { name: p.name, shirt: p.shirt, games: 0, distance: 0, topSpeed: null };
      e.games++; e.distance += p.distance ?? 0; e.topSpeed = Math.max(e.topSpeed ?? 0, p.topSpeed ?? 0) || e.topSpeed; e.shirt ??= p.shirt;
      byPlayer.set(p.name, e);
    }
    const physical = phys.length ? {
      games: phys.length,
      distancePerGame: Math.round(mean(phys.map(m => m.physical.team.distance[physSide(m)]))),
      sprintDistancePerGame: Math.round(mean(phys.map(m => m.physical.team.sprintDistance[physSide(m)]).filter(Number.isFinite))),
      sprintsPerGame: r2(mean(phys.map(m => m.physical.team.sprints[physSide(m)]).filter(Number.isFinite))),
      players: [...byPlayer.values()].filter(p => p.games >= 3)
        .map(p => ({ name: p.name, shirt: p.shirt, games: p.games, distancePerGame: Math.round(p.distance / p.games), topSpeed: p.topSpeed == null ? null : r2(p.topSpeed) }))
        .sort((a, b) => b.distancePerGame - a.distancePerGame),
    } : null;
    out.teams[code] = {
      code, seasons: [...new Set(mine.map(m => m.season))].sort(), games: mine.length,
      home: venue(true), away: venue(false),
      ...(physical ? { physical } : {}),
      situations: Object.fromEntries(Object.entries(bySit).map(([k, v]) => [k, { shots: v.shots, goals: v.goals, share: r3(v.shots / Math.max(1, shots.length)), xgPerShot: r3(v.xg / Math.max(1, v.shots)) }])),
      shotSample: shots.length,
    };
  }
  return out;
}

/* 一場 → 賽後報告的 canonical detail(`buildProviderMatchReport` / `attachAdvancedCodes` 吃的那一種)。
   FotMob 的精簡萃取沒有逐人統計與評分,所以 coverage 照實標:teamStatistics / events / lineups 有,
   playerStatistics / ratings 沒有 —— 前端據此不畫球員評分卡、本場最佳退回 FPL 表現分。 */
export function toCanonicalDetail(m) {
  const lineups = {};
  for (const [code, l] of Object.entries(m.lineups ?? {})) {
    lineups[code] = { formation: l.formation ?? null, coach: l.coach ?? null, team: code, rows: null,
      xi: (l.xi ?? []).map(p => ({ providerId: null, name: p.name, shirt: p.shirt, pos: p.pos, grid: null })),
      bench: (l.bench ?? []).map(p => ({ providerId: null, name: p.name, shirt: p.shirt, pos: p.pos, grid: null })) };
  }
  return {
    key: `${m.home}|${m.away}`, season: m.season, source: 'fotmob', fixtureId: m.matchId ?? null, kickoff: null,
    home: m.home, away: m.away, score: { home: m.score[0], away: m.score[1] },
    teamStats: m.teamStats, players: {}, events: m.events.map(e => ({
      minute: e.minute, extra: e.extra, label: `${e.minute}'${e.extra ? `+${e.extra}` : ''}`, team: e.team, type: e.type,
      detail: e.detail, comments: null, player: e.player ?? null, playerId: null, assist: null, assistId: null })),
    lineups, possession: m.possession, momentum: m.momentum, shots: m.shots, shotmapComplete: m.shotmapComplete,
    physical: m.physical ?? null,
    coverage: { teamStatistics: true, playerStatistics: false, ratings: false, events: true, lineups: Object.keys(lineups).length === 2,
      tracking: false,
      /* 跑動距離 / 衝刺 / 最高速度:這場有值才 true。供應商沒給的場次整組 null,那幾場照實 false。 */
      distance: !!m.physical?.team?.distance?.some(v => v != null),
      sprints: !!m.physical?.team?.sprints?.some(v => v != null),
      speed: !!m.physical?.players?.some(p => p.topSpeed != null) },
  };
}
