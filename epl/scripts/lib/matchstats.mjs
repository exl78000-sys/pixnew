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
import { matchOne } from './names.mjs';

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
    /* 逐人統計另存一檔(2026-09-04):評分、射門、傳球、對抗、防守。沒有那個檔就沒有逐人,coverage 照實標。 */
    const pf = join(dir, f.replace(/-game-details\.json$/, '-player-stats.json'));
    const pstore = existsSync(pf) ? JSON.parse(readFileSync(pf, 'utf8')) : { matches: {} };
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
        heat: m.heat ?? null, zones: m.zones ?? null,
        players: pstore.matches?.[`${m.home}|${m.away}`]?.players ?? null,
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
    /* 逐人觸球熱區(FotMob heatmap,6×4 格 + 質心;兩隊都正規化成向右進攻)。按供應商全名彙總,
       掛到球員身上由 attachPlayerTracking 做(那裡才有名單)。 */
    const heatBy = new Map();
    for (const m of mine) for (const p of m.heat?.players ?? []) {
      if (p.team !== code) continue;
      const h = heatBy.get(p.name) ?? { name: p.name, shirt: p.shirt ?? null, games: 0, touches: 0, sx: 0, sy: 0, ss: 0, grid: null };
      h.games++; h.touches += p.n; h.sx += p.cx * p.n; h.sy += p.cy * p.n; h.ss += p.spread * p.n;
      const g = String(p.grid ?? '').split(',').map(Number);
      if (g.length && g.every(Number.isFinite)) h.grid = h.grid ? h.grid.map((v, i) => v + (g[i] ?? 0)) : g;
      heatBy.set(p.name, h);
    }
    /* 逐人評分彙總(FotMob 評分,只算有評分的場次;替補沒上場的沒有評分) */
    const rateBy = new Map();
    for (const m of mine) for (const p of m.players?.[code] ?? []) {
      if (p.rating == null) continue;
      const r = rateBy.get(p.name) ?? { name: p.name, shirt: p.shirt ?? null, games: 0, sum: 0, minutes: 0 };
      r.games++; r.sum += p.rating; r.minutes += p.minutes ?? 0;
      rateBy.set(p.name, r);
    }
    const ratings = [...rateBy.values()].map(r => ({ name: r.name, shirt: r.shirt, games: r.games, avg: r2(r.sum / r.games), minutes: r.minutes }));
    const heat = [...heatBy.values()].filter(h => h.touches > 0).map(h => ({
      name: h.name, shirt: h.shirt, games: h.games, touches: h.touches,
      cx: r2(h.sx / h.touches), cy: r2(h.sy / h.touches), spread: r2(h.ss / h.touches), grid: h.grid ?? null,
    }));
    const physical = phys.length ? {
      games: phys.length,
      distancePerGame: Math.round(mean(phys.map(m => m.physical.team.distance[physSide(m)]))),
      sprintDistancePerGame: Math.round(mean(phys.map(m => m.physical.team.sprintDistance[physSide(m)]).filter(Number.isFinite))),
      sprintsPerGame: r2(mean(phys.map(m => m.physical.team.sprints[physSide(m)]).filter(Number.isFinite))),
      /* 1 場就列(games 另記,畫面自己標):遊戲的跑動加權 1 場也比沒有好;要「穩」的人看 games */
      players: [...byPlayer.values()].filter(p => p.games >= 1)
        .map(p => ({ name: p.name, shirt: p.shirt, games: p.games, distancePerGame: Math.round(p.distance / p.games), topSpeed: p.topSpeed == null ? null : r2(p.topSpeed) }))
        .sort((a, b) => b.distancePerGame - a.distancePerGame),
    } : null;
    out.teams[code] = {
      code, seasons: [...new Set(mine.map(m => m.season))].sort(), games: mine.length,
      home: venue(true), away: venue(false),
      ...(physical ? { physical } : {}),
      ...(heat.length ? { heat, heatGrid: { x: 6, y: 4 } } : {}),
      ...(ratings.length ? { ratings } : {}),
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
    teamStats: m.teamStats, players: m.players ?? {}, events: m.events.map(e => ({
      minute: e.minute, extra: e.extra, label: `${e.minute}'${e.extra ? `+${e.extra}` : ''}`, team: e.team, type: e.type,
      detail: e.detail, comments: null, player: e.player ?? null, playerId: null, assist: null, assistId: null })),
    lineups, possession: m.possession, momentum: m.momentum, shots: m.shots, shotmapComplete: m.shotmapComplete,
    physical: m.physical ?? null,
    coverage: { teamStatistics: true,
      playerStatistics: !!m.players && Object.values(m.players).some(l => l?.length),
      ratings: !!m.players && Object.values(m.players).some(l => l?.some(p => p.rating != null)),
      events: true, lineups: Object.keys(lineups).length === 2,
      tracking: false,
      /* 跑動距離 / 衝刺 / 最高速度:這場有值才 true。供應商沒給的場次整組 null,那幾場照實 false。 */
      distance: !!m.physical?.team?.distance?.some(v => v != null),
      sprints: !!m.physical?.team?.sprints?.some(v => v != null),
      speed: !!m.physical?.players?.some(p => p.topSpeed != null) },
  };
}


/* 把逐隊的逐人跑動與熱區掛到球員主檔(players.json)上。FotMob 用全名,FPL 用簡稱:
   先走 lib/names.mjs 的 matchOne(姓氏 + 名字首字母,配不出唯一就 null),再一道「姓氏 = 簡稱且隊裡唯一」的退路
   (「David Raya」↔「Raya」)。配不到就不掛 —— 配錯人比不掛糟。回傳配對統計給 build 印出來。
   模擬遊玩的側寫(scripts/game/lib/profile.mjs)也走這一個函式,不要再抄一份。 */
export function attachPlayerTracking(players, stats, { teamOf = p => p.team } = {}) {
  let matched = 0, total = 0;
  const byTeam = new Map();
  for (const p of players) { const t = teamOf(p); if (!t) continue; if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(p); }
  for (const [code, t] of Object.entries(stats?.teams ?? {})) {
    const squad = byTeam.get(code) ?? [];
    const cands = squad.filter(p => p.fullName);
    const byWeb = name => {
      const last = String(name).trim().split(/\s+/).at(-1)?.toLowerCase();
      const hits = squad.filter(p => String(p.name ?? '').toLowerCase() === last);
      return hits.length === 1 ? hits[0] : null;
    };
    const find = name => matchOne(cands, name, { nameOf: c => c.fullName }) ?? byWeb(name);
    for (const r of t.physical?.players ?? []) {
      total++;
      const p = find(r.name);
      if (!p) continue;
      matched++;
      p.tracking = { ...(p.tracking ?? {}), distancePerGame: r.distancePerGame, topSpeed: r.topSpeed ?? null, games: r.games };
    }
    for (const h of t.heat ?? []) {
      const p = find(h.name);
      if (!p) continue;
      p.tracking = { ...(p.tracking ?? {}), heat: { cx: h.cx, cy: h.cy, spread: h.spread, games: h.games, touches: h.touches, grid: h.grid, gridX: 6, gridY: 4 } };
    }
    for (const r of t.ratings ?? []) {
      const p = find(r.name);
      if (!p) continue;
      p.tracking = { ...(p.tracking ?? {}), rating: { avg: r.avg, games: r.games } };
    }
  }
  return { matched, total };
}


/* 球員逐場紀錄(2026-09-04):每人每場一列 —— 分鐘、評分、進球、助攻、射門、射正、關鍵傳球、逐射門 xG 合計、
   跑動距離、最高速度、對手、主客、比分。全部來自 FotMob 逐場快取(逐人統計、shotmap、追蹤資料),
   配對用跟 attachPlayerTracking 同一套(matchOne + 簡稱退路)。回 { code → [rows] },另存產物,
   球員完整頁進去才載(668 人 × 幾十場,不該塞進 players.json)。 */
export function buildPlayerLogs(players, stats, { teamOf = p => p.team } = {}) {
  const byTeam = new Map();
  for (const p of players) { const t = teamOf(p); if (!t) continue; if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(p); }
  const finderFor = code => {
    const squad = byTeam.get(code) ?? [];
    const cands = squad.filter(p => p.fullName);
    const cache = new Map();
    const byWeb = name => {
      const last = String(name).trim().split(/\s+/).at(-1)?.toLowerCase();
      const hits = squad.filter(p => String(p.name ?? '').toLowerCase() === last);
      return hits.length === 1 ? hits[0] : null;
    };
    return name => {
      if (!cache.has(name)) cache.set(name, matchOne(cands, name, { nameOf: c => c.fullName }) ?? byWeb(name));
      return cache.get(name);
    };
  };
  const finders = new Map();
  const find = (code, name) => { if (!finders.has(code)) finders.set(code, finderFor(code)); return finders.get(code)(name); };
  const logs = {};
  let rows = 0, unmatched = 0;
  for (const m of Object.values(stats?.matches ?? {}).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!m.players) continue;
    const xgBy = new Map();
    for (const s of m.shots ?? []) { if (!s.player) continue; const k = `${s.team}|${s.player}`; xgBy.set(k, (xgBy.get(k) ?? 0) + (s.xg ?? 0)); }
    const physBy = new Map((m.physical?.players ?? []).map(p => [`${p.team}|${p.name}`, p]));
    for (const [code, list] of Object.entries(m.players)) {
      const opp = code === m.home ? m.away : m.home;
      const isHome = code === m.home;
      for (const p of list) {
        if (!(p.minutes > 0)) continue;
        const who = find(code, p.name);
        if (!who) { unmatched++; continue; }
        const ph = physBy.get(`${code}|${p.name}`);
        const xg = xgBy.get(`${code}|${p.name}`);
        (logs[who.code] ??= []).push({
          season: m.season, date: m.date, key: m.key, team: code, opp, home: isHome,
          score: isHome ? `${m.score[0]}-${m.score[1]}` : `${m.score[1]}-${m.score[0]}`,
          result: m.score[0] === m.score[1] ? 'D' : (isHome === (m.score[0] > m.score[1]) ? 'W' : 'L'),
          min: p.minutes, rating: p.rating ?? null, goals: p.goals?.total ?? null, assists: p.goals?.assists ?? null,
          shots: p.shots?.total ?? null, shotsOn: p.shots?.on ?? null, keyPasses: p.passes?.key ?? null,
          xg: xg == null ? null : r2(xg), distance: ph?.distance ?? null, topSpeed: ph?.topSpeed == null ? null : r2(ph.topSpeed),
          sub: p.substitute === true,
        });
        rows++;
      }
    }
  }
  return { logs, rows, unmatched, players: Object.keys(logs).length };
}
