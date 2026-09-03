/* 模擬遊玩的球隊側寫 —— 把真實管線的產物與 raw 資料轉成遊戲引擎要吃的形狀。
 *
 * **只讀不寫。** 這個模組讀 `web/data/*.json`(真實管線的產物)與 `data/raw/`,
 * 產出的東西由 `build-game.mjs` 寫進 `web/data/game/`,真實管線不 import 這裡的任何東西
 * (`test-game.mjs` 守著)。
 *
 * 每一個數字都要能指回來源;指不回去的就不放。側寫裡的層級只有三種:
 *   真資料 —— 直接從來源抄(名單、陣型、主罰、能力 per-90、牌數)
 *   抽樣分布 —— 從逐場資料算出來的均值 / 標準差 / 直方圖,附 n
 *   遊戲規則 —— 只在引擎裡,側寫不放(側寫放的都是資料)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { teamMatchRows } from '../../lib/style-trend.mjs';
import { loadTeams } from '../../lib/teams.mjs';

const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = xs => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const dist = xs => ({ mean: xs.length ? r2(mean(xs)) : null, sd: xs.length >= 2 ? r2(sd(xs)) : null, n: xs.length });
/* 直方圖:桶寬固定,桶的鍵是桶的起點;分鐘 ≥ 90 全部落在 90 那一桶(補時)。 */
const hist = (xs, width, max = 90) => {
  const out = {};
  for (const x of xs) {
    if (!Number.isFinite(x)) continue;
    const b = Math.min(max, Math.floor(x / width) * width);
    out[b] = (out[b] ?? 0) + 1;
  }
  return out;
};

/* 能力值:用哪一季的 per-90。本季分鐘夠就用本季(狀態最新),不夠退上季,
   兩季都不夠 → null,引擎用同角色的中位數並標 lowSample。
   門檻 450 跟 lib/roles.mjs 的 QUALIFY 一樣 —— 出場太少的側寫不可信。 */
const QUALIFY = 450;
function abilityOf(p) {
  const pick = (s, tag) => ({
    src: tag, minutes: s.minutes,
    att: s.xgi90 ?? null, thr: s.threat90 ?? null, cre: s.creativity90 ?? null,
    def: s.defCon90 ?? null, cbi: s.cbi90 ?? null, tkl: s.tackles90 ?? null, sav: s.saves90 ?? null,
  });
  if ((p.current?.minutes ?? 0) >= QUALIFY) return pick(p.current, 'current');
  if ((p.last?.minutes ?? 0) >= QUALIFY) return pick(p.last, 'last');
  return { src: null, minutes: (p.current?.minutes ?? 0) + (p.last?.minutes ?? 0), att: null, thr: null, cre: null, def: null, cbi: null, tkl: null, sav: null };
}

function compactPlayer(p) {
  const a = abilityOf(p);
  return {
    code: p.code, name: p.name, fullName: p.fullName ?? null, shirt: p.squadNumber ?? null, pos: p.pos, role: p.role?.key ?? null,
    roleLow: p.role?.lowSample === true, age: p.age ?? null,
    status: p.status ?? 'a', statusZh: p.statusZh ?? null, chance: p.chanceNext ?? null, news: p.news || null,
    minutes: { last: p.last?.minutes ?? 0, current: p.current?.minutes ?? 0 },
    starts: { last: p.last?.starts ?? 0, current: p.current?.starts ?? 0 },
    goals: (p.last?.goals ?? 0) + (p.current?.goals ?? 0),
    assists: (p.last?.assists ?? 0) + (p.current?.assists ?? 0),
    xg: r2((p.last?.xG ?? 0) + (p.current?.xG ?? 0)),
    xa: r2((p.last?.xA ?? 0) + (p.current?.xA ?? 0)),
    yellow: (p.last?.yellow ?? 0) + (p.current?.yellow ?? 0),
    red: (p.last?.red ?? 0) + (p.current?.red ?? 0),
    ability: a,
    ...(p.tracking?.heat ? { heat: { cx: p.tracking.heat.cx, cy: p.tracking.heat.cy, spread: p.tracking.heat.spread, games: p.tracking.heat.games, touches: p.tracking.heat.touches } } : {}),
    ...(p.tracking?.distancePerGame != null ? { run: { distancePerGame: p.tracking.distancePerGame, topSpeed: p.tracking.topSpeed ?? null, games: p.tracking.games } } : {}),
  };
}

/* FotMob 逐場快取(data/raw/fotmob-epl/*-game-details.json)—— 控球、射門、事件。 */
function loadFotmob(root) {
  const dir = join(root, 'data', 'raw', 'fotmob-epl');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /-game-details\.json$/.test(f)).sort()
    .flatMap(f => Object.values(readJson(join(dir, f)).matches ?? {}));
}

export function buildGameProfile(root, { league = 'pl' } = {}) {
  if (league !== 'pl') throw new Error('模擬遊玩目前只做英超(使用者 2026-09-03 的決定)');
  const W = n => join(root, 'web', 'data', `${n}.json`);
  const meta = readJson(W('meta')), teams = readJson(W('teams')), players = readJson(W('players'));
  const lineups = readJson(W('lineups')), official = readJson(W('official')), shapes = readJson(W('shapes'));
  const goals = readJson(W('goals'));
  const T = loadTeams(root);
  const cur = meta.currentSeason, last = meta.lastSeason;
  const codes = teams.map(t => t.code);

  // ── 逐場 CSV:事件率(主客分開),上季 + 本季 ──────────────
  const csvDir = join(root, 'data', 'raw', 'football-data-couk');
  const rowsBy = new Map();
  for (const s of [last, cur]) {
    const f = join(csvDir, `${s}.csv`);
    if (!existsSync(f)) continue;
    for (const [code, rows] of teamMatchRows(readFileSync(f, 'utf8'), { codeOf: T.codeOf })) {
      rowsBy.set(code, [...(rowsBy.get(code) ?? []), ...rows.map(r => ({ ...r, season: s }))]);
    }
  }
  /* 犯規與紅牌 teamMatchRows 沒帶(它是給風格位移用的),這裡自己再讀一次 CSV 補上。 */
  const foulRows = new Map();
  for (const s of [last, cur]) {
    const f = join(csvDir, `${s}.csv`);
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    const head = text.split('\n')[0].split(',');
    const idx = k => head.indexOf(k);
    for (const line of text.split('\n').slice(1)) {
      const c = line.split(',');
      if (c.length < 20 || c[idx('HF')] === '' || c[idx('HF')] == null) continue;
      const home = T.codeOf(c[idx('HomeTeam')]), away = T.codeOf(c[idx('AwayTeam')]);
      if (!home || !away) continue;
      const put = (code, isHome, pre, other) => {
        if (!foulRows.has(code)) foulRows.set(code, []);
        foulRows.get(code).push({ home: isHome, ff: +c[idx(pre + 'F')], fa: +c[idx(other + 'F')],
          yf: +c[idx(pre + 'Y')], rf: +c[idx(pre + 'R')], ya: +c[idx(other + 'Y')] });
      };
      put(home, true, 'H', 'A'); put(away, false, 'A', 'H');
    }
  }
  const ratesOf = (code, isHome) => {
    const rows = (rowsBy.get(code) ?? []).filter(r => r.home === isHome);
    const fr = (foulRows.get(code) ?? []).filter(r => r.home === isHome);
    if (!rows.length) return null;
    const m = k => r2(mean(rows.map(r => r[k])));
    return { games: rows.length, sf: m('sf'), sa: m('sa'), stf: m('stf'), sta: m('sta'), cf: m('cf'), ca: m('ca'),
      gf: m('gf'), ga: m('ga'),
      fouls: fr.length ? r2(mean(fr.map(r => r.ff))) : null, foulsAgainst: fr.length ? r2(mean(fr.map(r => r.fa))) : null,
      yellow: fr.length ? r2(mean(fr.map(r => r.yf))) : null, red: fr.length ? r3(mean(fr.map(r => r.rf))) : null };
  };
  const leagueRates = (() => {
    const all = [...rowsBy.values()].flat();
    const fr = [...foulRows.values()].flat();
    const m = k => r2(mean(all.map(r => r[k])));
    return { teamGames: all.length, sf: m('sf'), stf: m('stf'), cf: m('cf'),
      fouls: r2(mean(fr.map(r => r.ff))), yellow: r2(mean(fr.map(r => r.yf))), red: r3(mean(fr.map(r => r.rf))),
      yellowPerFoul: fr.length ? r3(fr.reduce((a, r) => a + r.yf, 0) / Math.max(1, fr.reduce((a, r) => a + r.ff, 0))) : null };
  })();

  // ── FotMob 逐場:控球、射門情境、事件分鐘 ───────────────
  const fm = loadFotmob(root);
  const possOf = (code, isHome) => dist(fm.filter(m => (isHome ? m.home : m.away) === code && m.possession?.all)
    .map(m => m.possession.all[isHome ? 0 : 1]));
  const allPoss = fm.filter(m => m.possession?.all).map(m => m.possession.all[0]);
  const shotsAll = fm.flatMap(m => m.shots.map(s => ({ ...s, key: m.key })));
  const situationsOf = shots => {
    const by = {};
    for (const s of shots) {
      const k = s.situation ?? 'Unknown';
      by[k] ??= { shots: 0, goals: 0, onTarget: 0, xg: 0 };
      by[k].shots++; by[k].goals += s.type === 'Goal' ? 1 : 0; by[k].onTarget += s.onTarget ? 1 : 0; by[k].xg += s.xg ?? 0;
    }
    const total = shots.length || 1;
    return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, {
      shots: v.shots, goals: v.goals, share: r3(v.shots / total), onTargetPct: r3(v.onTarget / v.shots),
      xgPerShot: r3(v.xg / v.shots), goalPerShot: r3(v.goals / v.shots) }]));
  };
  /* 跑動節奏、三路進攻、逐人熱區與跑動(2026-09-03 加,給動畫用):
     - tempo:該隊每分鐘跑動距離與衝刺次數(FotMob 追蹤資料,不是每場都有,n 另記)
     - zones:該隊左/中/右進攻佔比的平均(供應商算的)
     - 逐人:熱區質心 / 離散度(觸球位置,兩隊都正規化成向右進攻,門將質心 x≈12 驗過)、場均跑動、最高速度。
       FotMob 用全名,FPL 用簡稱,配對走 lib/names.mjs 的 matchOne(姓氏 + 名字首字母,配不出唯一就不掛)。 */
  const tempoBy = new Map(), zonesBy = new Map();
  for (const m of fm) {
    for (const [code, idx] of [[m.home, 0], [m.away, 1]]) {
      const ph = m.physical?.team;
      if (ph?.distance?.[idx] != null) {
        const t = tempoBy.get(code) ?? { games: 0, distance: 0, sprints: 0, sprintDist: 0 };
        t.games++; t.distance += ph.distance[idx]; t.sprints += ph.sprints?.[idx] ?? 0; t.sprintDist += ph.sprintDistance?.[idx] ?? 0;
        tempoBy.set(code, t);
      }
      const z = (idx === 0 ? m.zones?.home : m.zones?.away)?.total;
      if (z && [z.left, z.center, z.right].every(Number.isFinite)) {
        const t = zonesBy.get(code) ?? { games: 0, left: 0, center: 0, right: 0 };
        t.games++; t.left += z.left; t.center += z.center; t.right += z.right;
        zonesBy.set(code, t);
      }
    }
  }
  const subsOn = fm.flatMap(m => m.events.filter(e => e.type === 'subst'));
  const subCountByTeamMatch = fm.flatMap(m => [m.home, m.away].map(t => m.events.filter(e => e.type === 'subst' && e.team === t).length));
  const goalMins = fm.flatMap(m => m.events.filter(e => e.type === 'Goal').map(e => e.minute + (e.extra ?? 0) * 0));
  const cardEv = fm.flatMap(m => m.events.filter(e => e.type === 'Card'));
  const goalEv = fm.flatMap(m => m.events.filter(e => e.type === 'Goal'));
  const blockedShare = (() => {
    const ts = fm.flatMap(m => Object.values(m.teamStats)).filter(s => s.shots != null && s.blockedShots != null);
    const shots = ts.reduce((a, s) => a + s.shots, 0);
    return shots ? r3(ts.reduce((a, s) => a + s.blockedShots, 0) / shots) : null;
  })();
  /* 遊戲係數的校準結果(scripts/game/calibrate-xi.mjs)。沒有檔就是沒校準,側寫照實寫 null,
     引擎用預設並在畫面標「未校準」—— 不可以在這裡填一個看起來合理的數。 */
  const calibPath = join(root, 'data', 'game-calibration.json');
  const calibration = existsSync(calibPath) ? readJson(calibPath) : null;

  /* 被換下的位置:FotMob 的換人事件只有上場那一個名字(轉換器就是這樣寫的),
     位置要從 `official.json` 的 timeline.subs(dir=off)對回先發 —— 那份有 playerCode。 */
  const offPos = {};
  let offN = 0;
  for (const m of Object.values(official.matches ?? {})) {
    const posBy = new Map();
    for (const side of ['home', 'away']) for (const p of (m[side]?.rows ?? []).flat()) posBy.set(p.code, p.pos);
    for (const s of m.timeline?.subs ?? []) {
      if (s.dir !== 'off') continue;
      const pos = posBy.get(s.playerCode);
      if (!pos) continue;
      offPos[pos] = (offPos[pos] ?? 0) + 1; offN++;
    }
  }

  // ── 各隊 ───────────────────────────────────────────────
  const byTeamPlayers = new Map(codes.map(c => [c, players.filter(p => p.team === c).map(compactPlayer)]));
  const latestFormation = (() => {
    const by = new Map();
    const entries = Object.entries(official.matches ?? {}).sort((a, b) => ((a[1].kickoff ?? '') < (b[1].kickoff ?? '') ? -1 : 1));
    for (const [k, v] of entries) {
      const [h, a] = k.split('|');
      if (v.home?.formation) by.set(h, { formation: v.home.formation, match: k, kickoff: v.kickoff, bench: v.home.subs ?? [] });
      if (v.away?.formation) by.set(a, { formation: v.away.formation, match: k, kickoff: v.kickoff, bench: v.away.subs ?? [] });
    }
    return by;
  })();

  const teamsOut = {};
  for (const t of teams) {
    const code = t.code;
    const squad = byTeamPlayers.get(code) ?? [];
    const squadBy = new Map(squad.map(p => [p.code, p]));
    const lu = lineups[code];
    const xiCodes = (lu?.rows ?? []).flat().map(p => p.code).filter(c => squadBy.has(c));
    const lf = latestFormation.get(code);
    /* 替補席:官方最近一場的替補名單裡本季名單認得的人;湊不到 9 人就從名單裡
       不在 XI、分鐘最多的補。全部是真名單 —— 不發明球員。 */
    const benchCodes = (lf?.bench ?? []).map(b => b.code).filter(c => squadBy.has(c) && !xiCodes.includes(c));
    const spare = squad.filter(p => !xiCodes.includes(p.code) && !benchCodes.includes(p.code))
      .sort((a, b) => (b.minutes.current + b.minutes.last) - (a.minutes.current + a.minutes.last)).map(p => p.code);
    while (benchCodes.length < 9 && spare.length) benchCodes.push(spare.shift());
    const used = shapes[code]?.official?.used ?? [];
    const formations = [...new Set([lf?.formation, lu?.shape, ...used.map(u => u.formation)].filter(Boolean))];
    const sp = t.tactics?.setPieces ?? {};
    const teamShots = shotsAll.filter(s => s.team === code);
    /* 逐人熱區與跑動:直接讀球員主檔的 tracking(build.mjs 用 lib/matchstats.mjs 的 attachPlayerTracking 掛的),
       這裡不再自己配對 —— 兩份配對邏輯一定會分岔(CLAUDE.md 的老坑)。 */
    const tp = tempoBy.get(code), zn = zonesBy.get(code);
    teamsOut[code] = {
      /* 叫 pace 不叫 tempo —— tempo 是既有的半場進球那一組,同名會被後面那個蓋掉(實際踩到) */
      pace: tp ? { games: tp.games, distancePerMin: Math.round(tp.distance / tp.games / 95), sprintsPerMin: r2(tp.sprints / tp.games / 95), sprintDistPerMin: Math.round(tp.sprintDist / tp.games / 95) } : null,
      zones: zn ? { games: zn.games, left: r3(zn.left / zn.games / 100), center: r3(zn.center / zn.games / 100), right: r3(zn.right / zn.games / 100) } : null,
      code, zh: t.zh, en: t.en, colors: t.colors ?? [],
      formation: { latest: lf?.formation ?? null, latestMatch: lf?.match ?? null, predicted: lu?.shape ?? null,
        used: used.map(u => ({ formation: u.formation, games: u.games })), options: formations },
      xi: xiCodes, bench: benchCodes, squad,
      xiSource: lu ? `lineups.json 推估先發(${lu.shapeSource ?? '?'})` : null,
      rates: { home: ratesOf(code, true), away: ratesOf(code, false) },
      possession: { home: possOf(code, true), away: possOf(code, false) },
      situations: sp.available ? Object.fromEntries(Object.entries(sp.breakdown ?? {}).map(([k, v]) => [k, {
        shots: v.shots, goals: v.goals, xG: r2(v.xG), xgPerShot: v.shots ? r3(v.xG / v.shots) : null,
        against: { shots: v.against?.shots ?? null, goals: v.against?.goals ?? null } }])) : null,
      shotSituations: teamShots.length ? situationsOf(teamShots) : null,
      shotSample: teamShots.length,
      takers: sp.takers ?? null,
      subShare: goals.data?.[last]?.teams?.[code] ? r3((goals.data[last].teams[code].subGoals ?? 0) / Math.max(1, goals.data[last].teams[code].for ?? 1)) : null,
      assistShare: goals.data?.[last]?.teams?.[code] ? r3(Math.min(1, (goals.data[last].teams[code].assists ?? 0) / Math.max(1, goals.data[last].teams[code].for ?? 1))) : null,
      resilience: t.tactics?.resilience ?? null,
      tempo: t.tactics?.tempo ?? null,
    };
  }

  return {
    league: 'pl', version: 1, builtAt: new Date().toISOString(), currentSeason: cur, lastSeason: last,
    note: '模擬遊玩的側寫。只讀真實管線的產物與 raw 資料,不寫回。每個數字附 n 或來源;遊戲規則(係數)不在這裡,在引擎裡。',
    sources: {
      rates: `football-data.co.uk 逐場 CSV(${last}${existsSync(join(csvDir, `${cur}.csv`)) ? ` + ${cur}` : ''}),隊-場 ${leagueRates.teamGames} 列`,
      possession: `FotMob matchDetails(data/raw/fotmob-epl),${fm.length} 場;官網 /stats/match 抽核 20 場全部在 ±2 內`,
      shots: `FotMob shotmap,${shotsAll.length} 次射門(逐射門 xG 與情境)`,
      tempo: `FotMob 追蹤資料(跑動距離 / 衝刺),${[...tempoBy.values()].reduce((a, t) => a + t.games, 0)} 隊-場;熱區與逐人跑動見球員主檔的 tracking、三路進攻 ${[...zonesBy.values()].reduce((a, t) => a + t.games, 0)} 隊-場`,
      ability: 'FPL per-90(players.json 的 last / current),450 分鐘以上才用',
      cards: 'FPL 逐季黃紅牌 + CSV 逐場牌數',
      subs: `FotMob 換人事件 ${subsOn.length} 次;被換下位置來自 official.json(${offN} 次)`,
      lineups: 'lineups.json 推估先發 + official.json 最近一場的替補席與陣型',
      situations: 'Understat getTeamData 上季整季情境(球隊層級)',
    },
    league_: {
      rates: leagueRates,
      possession: dist(allPoss),
      shotSituations: situationsOf(shotsAll),
      shotMinutes: { hist5: hist(shotsAll.map(s => s.min), 5), n: shotsAll.length },
      goalMinutes: { hist5: hist(goalMins, 5), n: goalMins.length },
      cardMinutes: { hist5: hist(cardEv.map(e => e.minute), 5), n: cardEv.length },
      subs: { countHist: hist(subCountByTeamMatch, 1, 5), minuteHist5: hist(subsOn.map(e => e.minute), 5), n: subsOn.length,
        offPos, offN },
      reds: { perMatch: fm.length ? r3(cardEv.filter(e => e.detail === 'Red Card').length / fm.length) : null, n: fm.length },
      blockedShare,
      ownGoalShare: goalEv.length ? r3(goalEv.filter(e => e.detail === 'Own Goal').length / goalEv.length) : null,
      penaltyShare: goalEv.length ? r3(goalEv.filter(e => e.detail === 'Penalty').length / goalEv.length) : null,
      goals: goalEv.length,
    },
    calibration: calibration ? { a: calibration.a, se: calibration.se, significant: calibration.significant,
      validGain: calibration.valid?.llGainVs0 ?? null, coverage: calibration.coverage, method: calibration.method, note: calibration.note } : null,
    teams: teamsOut,
  };
}
