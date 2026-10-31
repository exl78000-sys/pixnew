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

/* 一場比賽在 raw 與 results 裡的配對鍵。三個聯賽是「主|客」;歐冠**不行**:同一組主客在同一季會出現兩次
   (聯賽階段 + 淘汰賽,2025-26 有 7 組),「主|客」當鍵第二場會靜靜蓋掉第一場 —— 這是英冠附加賽那條坑在歐冠的版本。
   所以歐冠的 results 與 raw 都帶 `pair`(主|客|日期),有就用它,沒有退回「主|客」(三個聯賽的 raw 不變)。 */
export const pairOf = m => m.pair ?? `${m.home}|${m.away}`;

/* PK 大戰的射門要排除。FotMob 的 shotmap 把互射十二碼也列進去(2025-26 歐冠決賽:7 球 Penalty,分鐘 122~130;
   2024-25 Atleti vs Real Madrid:8 球,分鐘 **120**~127),照算會把 1-1 的比賽數成 9 顆進球、射門圖判定不完整、
   xG 多算七次。互射的假分鐘從 120 或更後面起跳,而正規延長賽的最後一分鐘也是 120 —— 光看分鐘分不開,
   所以要知道**這一場有沒有踢 PK**(results 的 pens):有踢 PK 的場次,分鐘 ≥ 120 的 Penalty 一律當互射;
   沒踢 PK 的場次沒有互射可排。period(PenaltyShootout)是新抓的 raw 才可能有,有就以它為準。 */
export const isShootoutShot = (s, { pens = false } = {}) => s?.period === 'PenaltyShootout'
  || (s?.period == null && !!pens && Number(s?.min) >= 120 && s?.situation === 'Penalty');

/* 射門圖上沒有隊伍的射門,用**同一場的正式名單**對回(2026-10-03)。
   FotMob 的射門圖有時用一個跟賽程不同的隊伍 id(實測:足總盃 2025-26 Macclesfield FC 三場、44 腳全是 null),
   抓取器照對照表轉不出隊碼就留 null。站上的射門圖照 `s.team === 主隊` 分半場,null 一律畫到**客隊**那一半 ——
   其中兩場 Macclesfield 是主隊,等於把他們的射門畫成對手的;算兩隊射門與 xG 時又整批不算。
   對回的規則:射手的名字在**這一場**的正式名單(先發 + 替補)裡只出現在一隊 → 就是那一隊。烏龍球也一樣
   (射門圖的烏龍球 team 是**射手自己那一隊**:全部 raw 裡帶隊伍的烏龍球 295 腳,能在名單上找到射手的 284 腳
   全部是射手那一隊、0 腳相反)。對回之後要過一道核對:逐隊射門數(扣烏龍球與 PK 大戰)= 那一場的球隊統計射門數
   —— 射門圖本來就帶隊伍的場次 3,283 場裡 3,280 場成立。**任何一腳對不上、或核對不過,整場一腳都不改**
   (照舊 null,畫面照講),不挑對得上的那幾腳用。改過的射門標 `teamFrom: 'lineup'`,畫面講這是用名單對回的。 */
export function repairShotTeams(m, { pens = false } = {}) {
  const shots = m.shots ?? [];
  const missing = shots.filter(s => s.team == null);
  if (!missing.length) return { shots, repaired: 0, unresolved: 0 };
  const codes = [m.home, m.away];
  const roster = code => new Set([...(m.lineups?.[code]?.xi ?? []), ...(m.lineups?.[code]?.bench ?? [])].map(p => p.name).filter(Boolean));
  const R = codes.map(roster);
  const teamOf = s => { const hit = codes.filter((c, i) => s.player && R[i].has(s.player)); return hit.length === 1 ? hit[0] : null; };
  const fixed = shots.map(s => (s.team == null ? { ...s, team: teamOf(s), teamFrom: 'lineup' } : s));
  const fail = { shots, repaired: 0, unresolved: missing.length };
  if (fixed.some(s => s.team == null)) return fail;
  const counted = code => fixed.filter(s => s.team === code && !s.ownGoal && !isShootoutShot(s, { pens })).length;
  if (!codes.every(c => Number.isFinite(m.teamStats?.[c]?.shots) && m.teamStats[c].shots === counted(c))) return fail;
  return { shots: fixed, repaired: missing.length, unresolved: 0 };
}

/* 「被封阻射門」的語意修正(2026-09-15 深夜):對照表在版本 1 把 shot_blocks(自己做的封阻)當成被封阻的射門。
   不重抓幾千場,用**射門圖**回推:射門圖完整的場次,被封阻 = 該隊 blocked 的射門數(跟 blocked_shots 760/760 一致);
   有 teamExtra.blocked_shots(版本 2 抓的)就用它;兩者都沒有的舊紀錄,原值改記到 blocksMade、被封阻寫 null —— 不留一個語意錯的數字。 */
export function fixBlockedShots(m) {
  const out = {};
  for (const [c, st] of Object.entries(m.teamStats ?? {})) {
    const t = { ...st };
    const fromExtra = m.teamExtra?.[c]?.blocked_shots;
    const fromMap = m.shots?.length && m.checks?.shotmapComplete ? m.shots.filter(sh => sh.team === c && sh.blocked).length : null;
    if ((m.extractVersion ?? 1) < 2 || t.blocksMade === undefined) {
      // 版本 1(或還沒帶 blocksMade 的紀錄):blockedShots 原本裝的是 shot_blocks
      if (t.blocksMade === undefined) t.blocksMade = t.blockedShots ?? null;
      t.blockedShots = Number.isFinite(fromExtra) ? fromExtra : fromMap;
    }
    out[c] = t;
  }
  return out;
}

/* `excludeFromTeams(賽果那一場)`:逐場照收、但**不算進逐隊彙總**的場次(英冠的升級附加賽:不進積分榜也不進模型,
   球隊頁那一塊照「這個聯賽」講)。刻意不寫成「有 stage 就排除」—— 歐冠與盃賽的賽果也帶 stage(那是輪次),那裡每一場都該算。
   排除了幾場記在 `teamExcluded`,呼叫端印出來。 */
export function loadFotmobMatchStats(root, { results = [], rawDir = 'fotmob-epl', excludeFromTeams = null } = {}) {
  const dir = join(root, 'data', 'raw', rawDir);
  const out = { source: 'FotMob matchDetails', seasons: [], count: 0, rejected: [], verification: {}, matches: {}, teams: {}, teamExcluded: [] };
  if (!existsSync(dir)) return out;
  const scoreOf = new Map(results.filter(r => r.played).map(r => [`${r.season}|${pairOf(r)}`, [r.fh, r.fa]]));
  // 有沒有踢 PK(歐冠 results 有 pens;三個聯賽沒有 → 一律 false)
  const pensOf = new Map(results.filter(r => r.played).map(r => [`${r.season}|${pairOf(r)}`, !!(Array.isArray(r.pens) && r.pens.length)]));
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
      const key = `${season}|${pairOf(m)}`;
      const truth = scoreOf.get(key);
      if (!truth) { out.rejected.push({ key, reason: '本站賽果沒有這場(或未完賽)' }); continue; }
      if (truth[0] !== m.score?.[0] || truth[1] !== m.score?.[1] || m.providerScore?.[0] !== truth[0] || m.providerScore?.[1] !== truth[1]) {
        out.rejected.push({ key, reason: `比分不符(本站 ${truth.join('-')},FotMob ${m.providerScore?.join('-')})` }); continue;
      }
      if (!m.possession?.all || m.possession.all[0] + m.possession.all[1] !== 100) { out.rejected.push({ key, reason: '控球率缺或相加不是 100' }); continue; }
      const pens = pensOf.get(key) === true;
      const shotGoals = (m.shots ?? []).filter(s => s.type === 'Goal' && !isShootoutShot(s, { pens })).length;
      /* 射門圖上沒有隊伍的射門用同一場的名單對回(規則與核對見 repairShotTeams);被封阻的回推也用對回後的那一份 */
      const fix = repairShotTeams(m, { pens });
      out.matches[key] = {
        key, season, date: m.date, home: m.home, away: m.away, score: [...truth], matchId: m.matchId,
        ...(m.pair ? { pair: m.pair } : {}), pens,
        possession: m.possession, teamStats: fixBlockedShots({ ...m, shots: fix.shots }), shots: fix.shots, momentum: m.momentum ?? [],
        ...(fix.repaired ? { shotTeamFix: { repaired: fix.repaired, from: 'lineup' } } : {}),
        ...(fix.unresolved ? { shotTeamUnresolved: fix.unresolved } : {}),
        events: m.events ?? [], lineups: m.lineups ?? null,
        /* 跑動 / 衝刺(2026-09-03 重探後加):供應商的追蹤資料,不是每場都有(2025-26 有 282/380,缺的集中在 11 座主場);沒有就是 null,不是 0 */
        physical: m.physical ?? null,
        heat: m.heat ?? null, zones: m.zones ?? null,
        players: pstore.matches?.[pairOf(m)]?.players ?? null,
        /* **空的射門圖不算「完整」。** 0-0 收場的場次,沒有任何射門時 `shotGoals === 0 === 比分合計`
           也成立 —— 於是索引會說「射門圖完整」,畫面就不印「這一場沒有 xG」那句,
           而實際上一顆射門都沒有。實測:足總盃 2025-26 第二輪 5040321(0-0、PK 4-5)就是這樣,
           shotmapComplete=true 而 xG 是 null,兩個欄位自己矛盾。
           「完整」的前提是**有這份資料**,所以要求至少一顆射門。 */
        shotmapComplete: (m.shots ?? []).length > 0 && shotGoals === truth[0] + truth[1],
      };
    }
  }
  out.count = Object.keys(out.matches).length;
  out.seasons = [...new Set(out.seasons)].sort();

  // 逐隊彙總(主客分開):控球分布、每場射門 / 被射門、xG / xGA、射門情境
  const notForTeams = new Set(excludeFromTeams ? results.filter(r => excludeFromTeams(r)).map(r => `${r.season}|${pairOf(r)}`) : []);
  const forTeams = Object.values(out.matches).filter(m => !notForTeams.has(m.key));
  out.teamExcluded = Object.keys(out.matches).filter(k => notForTeams.has(k)).sort();
  const codes = new Set(forTeams.flatMap(m => [m.home, m.away]));
  for (const code of codes) {
    const mine = forTeams.filter(m => m.home === code || m.away === code);
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
      /* 控球率有沒有經第二來源抽核(英超有官網端點;西甲沒有)—— 畫面上的那句話照這個旗標講 */
      verified: Object.values(out.verification).some(v => v && v.checked > 0 && v.agree === v.checked),
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
export function toCanonicalDetail(m, { verified = false } = {}) {
  const lineups = {};
  for (const [code, l] of Object.entries(m.lineups ?? {})) {
    lineups[code] = { formation: l.formation ?? null, coach: l.coach ?? null, team: code, rows: null,
      xi: (l.xi ?? []).map(p => ({ providerId: null, name: p.name, shirt: p.shirt, pos: p.pos, grid: null })),
      bench: (l.bench ?? []).map(p => ({ providerId: null, name: p.name, shirt: p.shirt, pos: p.pos, grid: null })) };
  }
  return {
    key: `${m.home}|${m.away}`, season: m.season, source: 'fotmob', fixtureId: m.matchId ?? null, kickoff: null,
    home: m.home, away: m.away, score: { home: m.score[0], away: m.score[1] },
    teamStats: m.teamStats, players: m.players ?? {}, events: m.events.map(e => {
      /* FotMob 烏龍球事件的 team 是**踢進自家球門那個人的隊**,得分算對手。
         拿三聯賽全部 FotMob 資料驗過(2026-09-05):有烏龍球的 85 場,翻轉後逐隊進球數 85 場全對回比分,
         不翻轉 0 場對得上。canonical 的 team 語意是「得分方」(goalEvidence 照這個數),所以這裡翻。 */
      const own = e.type === 'Goal' && e.detail === 'Own Goal';
      const team = own ? (e.team === m.home ? m.away : m.home) : e.team;
      return { minute: e.minute, extra: e.extra, label: `${e.minute}'${e.extra ? `+${e.extra}` : ''}`, team, type: e.type,
        detail: e.detail, comments: null, player: e.player ?? null, playerId: null, assist: null, assistId: null, ...(own ? { ownGoal: true, ownGoalBy: e.team } : {}) };
    }),
    lineups, possession: m.possession, momentum: m.momentum, shots: m.shots, shotmapComplete: m.shotmapComplete,
    /* 射門的隊伍有幾腳是用名單對回的 / 有幾腳對不回(repairShotTeams);畫面照這兩個講 */
    ...(m.shotTeamFix ? { shotTeamFix: m.shotTeamFix } : {}), ...(m.shotTeamUnresolved ? { shotTeamUnresolved: m.shotTeamUnresolved } : {}),
    physical: m.physical ?? null, possessionVerified: !!verified,
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
  /* 身分(2026-10-31):每個人每季在 FotMob 那邊接到的球員 id 與背號(最近一場的)。
     不放進逐場列(那會讓 player-logs 變大而前端用不到),另外回傳給 attachFotmobIdentity */
  const ident = {};
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
        const id = ((ident[who.code] ??= {})[m.season] ??= { fids: new Set(), shirt: null, shirtDate: null });
        if (p.providerId != null) id.fids.add(String(p.providerId));
        if (p.shirt != null && (!id.shirtDate || m.date >= id.shirtDate)) { id.shirt = p.shirt; id.shirtDate = m.date; }
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
          /* 防守三項(2026-10-31,西甲的球員頁用;attachDefense 加總)。逐場 playerStats 給的就是這一場的次數 */
          tackles: p.tackles?.total ?? null, interceptions: p.tackles?.interceptions ?? null, saves: p.goals?.saves ?? null,
        });
        rows++;
      }
    }
  }
  return { logs, ident, rows, unmatched, players: Object.keys(logs).length };
}

/* FotMob 那邊的「同一個人」的逐場列,跟 Understat 的整季出場與分鐘對不對得起來(兩家各自記的)。
   attachDefense 與 attachFotmobIdentity 共用這一條判準 —— 各寫一份的話兩邊的「對上了」會不是同一件事。 */
export function logsAgree(p, rows, tol = 90) {
  if (!rows.length) return 'none';
  if (rows.length !== p.games) return 'games';
  const min = rows.reduce((a, r) => a + (r.min ?? 0), 0);
  return Math.abs(min - (p.minutes ?? 0)) > tol ? 'minutes' : 'ok';
}

/* 把 FotMob 的球員 id 與背號掛到本站的球員上(2026-10-31,使用者選「頭貼只抓榜上的人、背號也一起補」)。
   - 只掛**對上了**的那一季(`logsAgree` 是 ok:場數等於 Understat 出場、分鐘差 ≤ tol)—— 姓名配對配錯人的話,
     場數與分鐘幾乎不可能剛好一樣;配錯人掛上別人的臉比沒有臉糟得多(租借姓名那條坑)。
   - 那一季只接到**一個** FotMob id、而且那個 id 這一季沒有被別人認領,才掛 `fotmobId`。
   - 背號:只在本站還沒有背號時補(西甲有 SportMonks,不蓋掉),取這一季最近一場的;季中換號的人拿到的是現在的號碼。
     來源記在 `squadNumberSource`,畫面要講是單一來源。
   - 頭貼:`photos` 是 FotMob id → data URI(`data/manual/league-photos.json`,只抓榜上的人);本站已經有頭貼的不換。 */
/* `seasonal(season)`:這一季的背號要不要以 FotMob 為準。西甲的 SportMonks 是**現在**的名單快照,
   build 把它掛到兩季上 —— 上一季的列印的是現在的號碼(實測 2025-26 兩邊都有的 283 人裡 52 人不同,
   抽看的都是換過號的情形:Fermín López 的 FotMob 2025-26 逐場名單記 16、SportMonks 現在記 7)。FotMob 是逐場名單、本來就是那一季的號碼,
   所以往季以它為準;本季仍以 SportMonks 為主(兩邊不同的 6 人無從判斷誰對,不換)。 */
export function attachFotmobIdentity(players, built, { tol = 90, photos = {}, seasonal = () => false } = {}) {
  /* shirtCheck:本站已經有背號(西甲的 SportMonks)而 FotMob 也有時,兩邊一不一致 —— 那是 FotMob 背號唯一能被獨立對照的地方,
     德義法拿 FotMob 背號當單一來源的依據就是這個數字(build log 印出來,不寫死) */
  const count = { id: 0, shirt: 0, replaced: 0, photo: 0, ambiguous: 0, shared: 0, shirtCheck: { same: 0, diff: 0 } };
  const cand = [];
  for (const p of players) {
    const rows = (built?.logs?.[p.code] ?? []).filter(r => r.season === p.season);
    if (logsAgree(p, rows, tol) !== 'ok') continue;
    const id = built?.ident?.[p.code]?.[p.season];
    if (!id) continue;
    if (id.fids.size !== 1) { count.ambiguous++; continue; }
    cand.push({ p, fid: [...id.fids][0], shirt: id.shirt });
  }
  const claims = new Map();
  for (const c of cand) { const k = `${c.p.season}|${c.fid}`; claims.set(k, (claims.get(k) ?? 0) + 1); }
  for (const { p, fid, shirt } of cand) {
    if (claims.get(`${p.season}|${fid}`) > 1) { count.shared++; continue; }
    p.fotmobId = fid; count.id++;
    if (p.squadNumber != null && shirt != null && !seasonal(p.season)) count.shirtCheck[Number(p.squadNumber) === Number(shirt) ? 'same' : 'diff']++;
    if (shirt != null && p.squadNumber != null && seasonal(p.season) && Number(p.squadNumber) !== Number(shirt)) {
      p.squadNumber = shirt; p.squadNumberSource = 'fotmob'; count.replaced++;
    } else if (p.squadNumber == null && shirt != null) { p.squadNumber = shirt; p.squadNumberSource = 'fotmob'; count.shirt++; }
    if (!p.photo && photos[fid]) { p.photo = photos[fid]; p.photoSource = 'FotMob'; count.photo++; }
  }
  return count;
}

/* 搶斷、攔截、撲救的整季合計(2026-10-31,西甲)。Understat 不給防守數字;FotMob 逐場統計有,
   而 buildPlayerLogs 已經把每一場接到本站的球員代碼上 —— 這裡只是一季加起來。

   **給之前要過一道獨立核對**:FotMob 這一季接到他的場次與分鐘,要跟 Understat 的整季出場與分鐘對得起來
   (兩家各自記的):場次一樣多、分鐘差不超過 `tol`。實測西甲兩季場次一樣多的 858 人,分鐘差中位 6、最大 87
   (補時的算法不同),所以 tol 取 90 —— 一場的量。對不上的分兩種,都不給:
     · `games`:FotMob 少了幾場(那幾場的逐場檔沒抓到)或多了幾場 —— 加出來是少算或多算,不是這一季;
     · `minutes`:場次一樣而分鐘差太多 —— 多半是接錯人。
   沒有逐場列的人(`none`)也不給。給的話每一項都是**真的加總**,不外插、不補 0。 */
export function attachDefense(players, logs, { tol = 90 } = {}) {
  const count = {};
  for (const p of players) {
    const c = (count[p.season] ??= { published: 0, games: 0, minutes: 0, none: 0, total: 0 });
    c.total++;
    const rows = (logs?.[p.code] ?? []).filter(r => r.season === p.season);
    const agree = logsAgree(p, rows, tol);
    if (agree !== 'ok') { c[agree]++; continue; }
    const min = rows.reduce((a, r) => a + (r.min ?? 0), 0);
    const sum = k => (rows.some(r => r[k] == null) ? null : rows.reduce((a, r) => a + r[k], 0));
    /* 撲救只給門將:外場球員的 saves 是 null(上游沒給),加出來也是 null,但寫明比較不會被誤讀 */
    p.defense = { tackles: sum('tackles'), interceptions: sum('interceptions'),
      saves: rows.some(r => r.saves != null) && rows.every(r => r.saves != null) ? sum('saves') : null,
      matches: rows.length, minutes: min };
    c.published++;
  }
  return count;
}
