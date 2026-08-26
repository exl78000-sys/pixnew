#!/usr/bin/env node
// 西甲資料版：模型只使用 2025-26 完整賽季與 2026-27 本季資料；
// 球隊風格另取 2025-26 已逐場核對的 Understat 球隊摘要。
// 輸出維持既有前端的核心資料形狀，但明確關閉沒有可靠來源的球員、傷停、即時與戰術模組。
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMatches } from './lib/adapters/openfootball.mjs';
import { competition } from './lib/canonical.mjs';
import { loadTeams } from './lib/teams.mjs';
import { buildTable, headToHead, teamRecord } from './lib/table.mjs';
import { fitPoisson, applyPromotedPrior, predict, strengthTable } from './lib/poisson.mjs';
import { buildElo, eloProbs } from './lib/elo.mjs';
import { simulateSeason } from './lib/simulate.mjs';
import { buildFormIndex, recentForm, formSummary, formDelta, TUNED } from './lib/form.mjs';
import { upcomingOdds } from './lib/odds.mjs';
import { pickPair, intoBand } from './lib/colour.mjs';
import { setPieceProfile } from './lib/tactics.mjs';
import { buildProviderMatchReport } from './lib/postmatch-report.mjs';
import { percentile, round } from './lib/util.mjs';
import { loadPlayers, buildLeaders, attachRadar, BOARDS, RADAR_AXES, MIN_MINUTES } from './lib/adapters/understat-players.mjs';
import { loadSquadStore, enrichPlayers, coverage as sportmonksCoverage } from './lib/adapters/sportmonks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'data', 'leagues', 'es1');
const COMPETITION = 'esp.1';
const LAST_SEASON = '2025-26';
const CURRENT_SEASON = '2026-27';
const AS_OF = process.argv.find(a => a.startsWith('--as-of='))?.split('=')[1]
  ?? new Date().toISOString().slice(0, 10);
const RUNS = Number(process.argv.find(a => a.startsWith('--runs='))?.split('=')[1] ?? 5000);

// SportMonks 提供出生日期，但前端不應把生日直接當作主要欄位；
// 統一用同一個資料基準日計算整數年齡，並保留原始日期供追溯。
const ageAt = (birthDate, asOf) => {
  if (!birthDate || !asOf) return null;
  const birth = new Date(`${birthDate}T00:00:00Z`);
  const on = new Date(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(birth.getTime()) || !Number.isFinite(on.getTime()) || birth > on) return null;
  let age = on.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = on.getUTCMonth() < birth.getUTCMonth()
    || (on.getUTCMonth() === birth.getUTCMonth() && on.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age--;
  return age >= 0 ? age : null;
};

const lastSunday = (year, month) => {
  const d = new Date(Date.UTC(year, month, 0));
  return d.getUTCDate() - d.getUTCDay();
};

// 西班牙本土賽事使用 Europe/Madrid。openfootball 給當地鐘面時間但不帶時區；
// 依歐洲夏令時間規則補上 offset，避免把冬季賽事全部錯移一小時。
const madridKickoff = m => {
  if (!m.time) return null;
  const [year, month, day] = m.date.split('-').map(Number);
  const summer = (month > 3 && month < 10)
    || (month === 3 && day >= lastSunday(year, 3))
    || (month === 10 && day < lastSunday(year, 10));
  return `${m.date}T${m.time}:00${summer ? '+02:00' : '+01:00'}`;
};

const write = async (name, data) => {
  await writeFile(join(OUT, `${name}.json`), JSON.stringify(data));
  console.log(`  ✓ ${name}.json`);
};

const slimMatch = m => {
  const out = {
    id: m.id, season: m.season, round: m.round, date: m.date,
    home: m.home, away: m.away, played: m.played, fh: m.fh, fa: m.fa,
  };
  if (m.hh !== null) { out.hh = m.hh; out.ha = m.ha; }
  if (m.kickoff) out.kickoff = m.kickoff;
  return out;
};

const sumRows = rows => ({
  shots: rows.reduce((n, x) => n + Number(x?.shots ?? 0), 0),
  xG: rows.reduce((n, x) => n + Number(x?.xG ?? 0), 0),
  againstShots: rows.reduce((n, x) => n + Number(x?.against?.shots ?? 0), 0),
  xGA: rows.reduce((n, x) => n + Number(x?.against?.xG ?? 0), 0),
});

// FotMob 的垂直球場座標可還原成「門將 → 後防 → 中場 → 前場」的排位。
// 不把 positionId 直接暴露給前端；只在 canonical 轉換這一層做最小映射。
const fotmobPos = id => {
  const n = Number(id);
  if (n === 11) return 'G';
  if (n >= 30 && n < 50) return 'D';
  if (n >= 70 && n < 100) return 'M';
  if (n >= 100) return 'F';
  return '?';
};

const fotmobPlayer = p => ({
  providerId: p.providerId ?? null, name: p.name ?? '', number: p.shirt ?? null,
  pos: fotmobPos(p.positionId), rating: p.rating ?? null, photo: null,
  verticalLayout: p.verticalLayout ?? null,
});

function fotmobRows(players) {
  const groups = new Map();
  for (const p of players) {
    const y = Number(p.verticalLayout?.y);
    const key = Number.isFinite(y) ? y.toFixed(3) : `pos-${fotmobPos(p.positionId)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fotmobPlayer(p));
  }
  const rows = [...groups.entries()]
    .sort(([a], [b]) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) - Number(b) : a.localeCompare(b))
    .map(([, row]) => row.sort((a, b) => Number(a.verticalLayout?.x ?? 0) - Number(b.verticalLayout?.x ?? 0)));
  return rows.length > 1 && rows.flat().length === 11 ? rows : null;
}

function canonicalFotmobOfficial(record) {
  const side = raw => {
    const starters = raw?.starters ?? [];
    return {
      team: raw?.name ?? null, formation: raw?.formation ?? null,
      xi: starters.map(fotmobPlayer), rows: fotmobRows(starters),
      source: record.source ?? 'fotmob/enetpulse',
    };
  };
  const home = side(record.lineup?.home), away = side(record.lineup?.away);
  if (!home.formation || !away.formation || home.xi.length !== 11 || away.xi.length !== 11) return null;
  return {
    season: record.season, matchId: record.matchId, date: record.date,
    fetchedAt: record.fetchedAt, source: record.source ?? 'fotmob/enetpulse', sourceUrl: record.sourceUrl ?? 'https://www.fotmob.com/',
    score: record.score ?? null, coverage: record.coverage ?? {
      formations: true, starters: true, positions: true, layouts: true, ratings: true, photos: false,
    }, home, away,
  };
}

// LaLiga 官網的正式頁提供完整先發、替補、背號與頭像，但不提供第三方評分或球場座標。
// rows 是依官網公布的 formation 與先發順序分行，並明確保留 layouts=false 的資料界線。
function canonicalLaLigaOfficial(record) {
  const side = raw => {
    const xi = raw?.xi ?? [];
    const clean = p => ({
      providerId: p.providerId ?? null, name: p.name ?? '', number: p.number ?? null,
      pos: p.pos ?? '?', rating: null, photo: p.photo ?? null, captain: p.captain === true,
    });
    return {
      team: raw?.team ?? null, formation: raw?.formation ?? null,
      xi: xi.map(clean), rows: Array.isArray(raw?.rows) ? raw.rows.map(row => row.map(clean)) : null,
      source: 'laliga.com',
    };
  };
  const home = side(record.lineup?.home), away = side(record.lineup?.away);
  if (!home.formation || !away.formation || home.xi.length !== 11 || away.xi.length !== 11) return null;
  return {
    season: record.season, matchId: record.matchId, date: record.date,
    fetchedAt: record.fetchedAt, source: 'laliga.com', sourceUrl: record.sourceUrl ?? 'https://www.laliga.com/',
    score: record.score ?? null, coverage: {
      ...(record.coverage ?? {}), formations: true, starters: true, positions: false,
      layouts: false, ratings: false, photos: true,
    }, home, away,
  };
}

const canonicalOfficial = record => record?.source === 'laliga.com'
  ? canonicalLaLigaOfficial(record) : canonicalFotmobOfficial(record);

// 西甲沒有 FPL 球員層資料，風格只用可逐隊核對的賽果與 Understat 球隊摘要。
// 不把球員年齡、傳球創造或壓迫等目前沒有來源的欄位塞進來。
function buildTeamProfiles(tableRows, store) {
  const profiles = tableRows.map(row => {
    const raw = store?.teams?.[row.code];
    if (!raw?.validation?.ok) return null;
    const totals = sumRows(Object.values(raw.situations ?? {}));
    const open = raw.situations?.OpenPlay;
    const speeds = raw.profile?.attackSpeed ?? {};
    const zones = raw.profile?.shotZone ?? {};
    const formationRows = Object.values(raw.profile?.formation ?? {});
    const formationMinutes = formationRows.reduce((n, x) => n + Number(x.time ?? 0), 0);
    const formations = formationRows
      .sort((a, b) => b.time - a.time)
      .map(x => ({ name: x.stat, minutes: x.time, share: round((x.time / (formationMinutes || 1)) * 100, 1) }));
    const fast = speeds.Fast ?? { xG: 0, shots: 0 };
    const boxShots = Number(zones.shotPenaltyArea?.shots ?? 0) + Number(zones.shotSixYardBox?.shots ?? 0);
    const setPieces = setPieceProfile(raw, row.p, { takers: { pen: [], fk: [], corner: [] } });
    return {
      code: row.code,
      source: 'Understat', sourceUrl: raw.url?.replace('/getTeamData/', '/team/'), matches: row.p,
      attack: {
        goals: row.gf, goals90: row.avgGF,
        shots: totals.shots, shots90: round(totals.shots / row.p, 2),
        xG: round(totals.xG, 2), xG90: round(totals.xG / row.p, 2),
        finishing: round(row.gf - totals.xG, 1),
        openPlayXG: round(Number(open?.xG ?? 0), 2), openPlayXG90: round(Number(open?.xG ?? 0) / row.p, 2),
        fastXGShare: round(totals.xG ? (Number(fast.xG ?? 0) / totals.xG) * 100 : 0, 1),
        boxShotShare: round(totals.shots ? (boxShots / totals.shots) * 100 : 0, 1),
      },
      defence: {
        conceded: row.ga, conceded90: row.avgGA,
        shots: totals.againstShots, shots90: round(totals.againstShots / row.p, 2),
        xGA: round(totals.xGA, 2), xGA90: round(totals.xGA / row.p, 2),
        overperform: round(totals.xGA - row.ga, 1), cleanSheets: row.cleanSheets,
      },
      setPieces,
      formation: { primary: formations[0]?.name ?? null, list: formations },
      tempo: { ...row.half },
      resilience: {
        leadHoldPct: row.half.leadHoldPct, trailRescuePct: row.half.trailRescuePct,
        comeback: row.half.comeback, collapse: row.half.collapse,
      },
      homeAwayGap: row.homeAwayGap, homePpg: row.home.ppg, awayPpg: row.away.ppg, ppg: row.ppg,
    };
  }).filter(Boolean);

  const resilience = t => ((t.resilience.leadHoldPct ?? 0) + (t.resilience.trailRescuePct ?? 0) * 1.5) / 2;
  const axes = [
    { label: '進攻 xG', get: t => t.attack.xG90 },
    { label: '防守穩固', get: t => t.defence.xGA90, inverse: true },
    { label: '運動戰創造', get: t => t.attack.openPlayXG90 },
    { label: '定位球威脅', get: t => t.setPieces.xG90 },
    { label: '快速進攻', get: t => t.attack.fastXGShare },
    { label: '比賽韌性', get: resilience },
  ];
  const rank = (target, get, desc = true) => [...profiles]
    .sort((a, b) => desc ? get(b) - get(a) : get(a) - get(b))
    .findIndex(x => x.code === target.code) + 1;
  for (const t of profiles) {
    t.radar = axes.map(a => ({
      label: a.label,
      value: a.inverse
        ? round(100 - percentile(a.get(t), profiles.map(a.get)), 1)
        : percentile(a.get(t), profiles.map(a.get)),
      raw: round(a.get(t), 3),
    }));
    t.tags = [];
    if (rank(t, x => x.attack.xG90) <= 5) t.tags.push('xG 火力前段');
    if (rank(t, x => x.defence.xGA90, false) <= 5) t.tags.push('防守數據前段');
    if (rank(t, x => x.attack.openPlayXG90) <= 5) t.tags.push('運動戰創造前段');
    if (rank(t, x => x.setPieces.xG90) <= 5) t.tags.push('定位球強權');
    if (rank(t, x => x.attack.fastXGShare) <= 5) t.tags.push('快速轉換');
    if (rank(t, x => x.attack.boxShotShare) <= 5) t.tags.push('禁區內取向');
    if (t.attack.finishing >= 5) t.tags.push('超額終結');
    if (t.attack.finishing <= -5) t.tags.push('浪費機會');
    if (t.homeAwayGap >= 0.8) t.tags.push('主場龍');
    if ((t.resilience.leadHoldPct ?? 100) <= 65) t.tags.push('守不住領先');
  }
  return profiles;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const T = loadTeams(ROOT, { file: 'teams-la-liga.json' });
  const crestPath = join(ROOT, 'data', 'manual', 'crests-la-liga.json');
  const crestData = existsSync(crestPath)
    ? JSON.parse(await readFile(crestPath, 'utf8')).crests ?? {}
    : {};
  for (const t of T.list) {
    if (crestData[t.code]) t.crest = crestData[t.code];
    t.chartColor = intoBand(t.colors?.[0]) ?? intoBand(t.colors?.[1]) ?? '#9aa0aa';
  }

  const load = season => loadMatches({
    root: ROOT, competition: COMPETITION, season, codeOf: T.codeOf,
    rawDir: 'openfootball-la-liga', kickoffOf: madridKickoff,
  });
  const lastMatches = load(LAST_SEASON);
  const curMatches = load(CURRENT_SEASON);
  const curPlayed = curMatches.filter(m => m.played && m.date <= AS_OF);
  // 上游若先填入未來賽果，基準日之後仍一律當未賽，避免模型偷看未來。
  for (const m of curMatches) {
    if (m.date > AS_OF && m.played) Object.assign(m, { played: false, fh: null, fa: null, hh: null, ha: null });
  }

  const curCodes = [...new Set(curMatches.flatMap(m => [m.home, m.away]))].sort();
  const lastCodes = [...new Set(lastMatches.flatMap(m => [m.home, m.away]))].sort();
  if (curCodes.length !== 20 || lastCodes.length !== 20) {
    throw new Error(`西甲隊數不符：${LAST_SEASON}=${lastCodes.length}、${CURRENT_SEASON}=${curCodes.length}`);
  }

  const lastTable = buildTable(lastMatches, lastCodes);
  const curTable = buildTable(curMatches, curCodes);
  const situationsPath = join(ROOT, 'data', 'raw', 'understat-la-liga', `${LAST_SEASON}-team-situations.json`);
  let teamSituations = null;
  if (existsSync(situationsPath)) {
    const raw = JSON.parse(await readFile(situationsPath, 'utf8'));
    if (raw.season === LAST_SEASON && raw.complete && raw.validation?.allScorelinesReconciled) {
      teamSituations = raw;
      console.log(`  Understat 西甲攻守情境：${Object.keys(raw.teams ?? {}).length} 隊逐場比分已核對`);
    } else console.log('  ⚠ Understat 西甲攻守情境未完整核對，本次不使用');
  }
  const teamProfiles = buildTeamProfiles(lastTable, teamSituations);
  const profileBy = new Map(teamProfiles.map(x => [x.code, x]));
  const trainMatches = [...lastMatches, ...curPlayed];
  const model = applyPromotedPrior(fitPoisson(trainMatches, curCodes, { refDate: AS_OF }));
  const elo = buildElo(trainMatches);
  const strengthBy = new Map(strengthTable(model).map(x => [x.code, x]));

  let marketBy = {};
  const futureOdds = join(ROOT, 'data', 'raw', 'football-data-couk', 'fixtures.csv');
  if (existsSync(futureOdds)) {
    const r = upcomingOdds(readFileSync(futureOdds, 'utf8'), { codeOf: T.codeOf, div: 'SP1' });
    marketBy = r.byMatch;
    if (r.unmatched?.length) console.log(`  ⚠ 西甲賠率隊名未對上：${r.unmatched.join('、')}`);
    console.log(`  市場賠率：${r.count} 場`);
  }

  const fixtures = curMatches.map(m => {
    const p = predict(model, m.home, m.away);
    const e = eloProbs(elo.get(m.home)?.elo ?? 1500, elo.get(m.away)?.elo ?? 1500);
    return {
      ...slimMatch(m),
      kickoff: m.kickoff,
      kickoffSource: 'openfootball',
      difficulty: null,
      // 第一版沒有逐場賽前快照。已完賽後才用結果重擬合出的機率不能冒充賽前預測，
      // 因此已完賽場次只顯示比分；未賽場次才發布目前模型機率。
      prediction: m.played ? null : {
        ...p,
        home: round((p.home + e.home) / 2, 4),
        draw: round((p.draw + e.draw) / 2, 4),
        away: round((p.away + e.away) / 2, 4),
        poisson: { home: p.home, draw: p.draw, away: p.away },
        elo: e,
      },
      market: marketBy[`${m.home}|${m.away}`] ?? null,
      colors: pickPair(T.byCode.get(m.home)?.colors, T.byCode.get(m.away)?.colors),
    };
  });

  const sim = simulateSeason({
    model,
    fixtures: curMatches.filter(m => !m.played),
    codes: curCodes,
    played: curPlayed,
    runs: RUNS,
    seed: 20262701,
  });
  const simBy = new Map(sim.map(x => [x.code, x]));
  const lastBy = new Map(lastTable.map(x => [x.code, x]));
  const curBy = new Map(curTable.map(x => [x.code, x]));
  // SportMonks 名單只讀本地快取；有核對過的隊伍就把實際名單人數帶到球隊頁，
  // 沒有快取的隊伍維持 0，讓缺口可見而不是把歷史名單誤當成本季名單。
  const currentSquadStore = loadSquadStore(ROOT, CURRENT_SEASON);
  const currentSquadSize = new Map(Object.entries(currentSquadStore?.squads ?? {})
    .map(([code, list]) => [code, Array.isArray(list) ? list.length : 0]));

  const historyByTeam = new Map(curCodes.map(code => [code, []]));
  for (const [season, matches] of [[LAST_SEASON, lastMatches], [CURRENT_SEASON, curMatches]]) {
    const participants = new Set(matches.flatMap(m => [m.home, m.away]));
    for (const code of curCodes) {
      if (!participants.has(code)) continue;
      historyByTeam.get(code).push({
        season, ...teamRecord(matches, code), first10: teamRecord(matches, code, { limit: 10 }),
      });
    }
  }

  const teams = curCodes.map(code => {
    const reg = T.byCode.get(code);
    const ls = lastBy.get(code) ?? null;
    const current = curBy.get(code) ?? null;
    return {
      ...reg,
      lastSeason: ls ? {
        pos: ls.pos, p: ls.p, w: ls.w, d: ls.d, l: ls.l,
        gf: ls.gf, ga: ls.ga, gd: ls.gd, pts: ls.pts, ppg: ls.ppg,
        form: ls.form, home: ls.home, away: ls.away,
        homeAwayGap: ls.homeAwayGap, cleanSheets: ls.cleanSheets,
        longest: ls.longest, half: ls.half, bttsPct: ls.bttsPct,
        over25Pct: ls.over25Pct, biggestWin: ls.biggestWin, biggestLoss: ls.biggestLoss,
      } : null,
      inLastSeason: !!ls,
      current: current ? {
        pos: current.pos, p: current.p, w: current.w, d: current.d, l: current.l,
        gf: current.gf, ga: current.ga, gd: current.gd, pts: current.pts, form: current.form,
      } : null,
      elo: elo.get(code)?.elo ?? null,
      eloHistory: elo.get(code)?.history ?? [],
      strength: strengthBy.get(code) ?? null,
      sim: simBy.get(code) ?? null,
      tactics: profileBy.get(code) ?? null, coach: null, schedule: null,
      history: historyByTeam.get(code), squadSize: currentSquadSize.get(code) ?? 0, injuries: 0,
    };
  }).sort((a, b) => (b.sim?.expectedPoints ?? 0) - (a.sim?.expectedPoints ?? 0));

  // API-Football 完賽資料由 laliga:postmatch 寫入；build 只讀本地永久快取，開頁不呼叫 API。
  const postMatchPath = join(ROOT, 'data', 'raw', 'api-football-la-liga', `${CURRENT_SEASON}-match-details.json`);
  let postMatchStore = { matches: {} };
  if (existsSync(postMatchPath)) {
    try {
      const raw = JSON.parse(await readFile(postMatchPath, 'utf8'));
      if (raw.season === CURRENT_SEASON) postMatchStore = raw;
      else console.log(`  ⚠ 西甲賽後快取賽季不符（${raw.season ?? '未知'}），本次略過`);
    } catch { console.log('  ⚠ 西甲賽後快取損壞，本次略過'); }
  }
  const fixtureByPair = new Map(fixtures.map(f => [`${f.home}|${f.away}`, f]));
  const reports = {};
  for (const [pair, detail] of Object.entries(postMatchStore.matches ?? {})) {
    const fixture = fixtureByPair.get(pair);
    const report = buildProviderMatchReport({
      fixture, detail,
      nameOf: code => T.byCode.get(code)?.en ?? code,
    });
    if (report) reports[`${CURRENT_SEASON}|${pair}`] = report;
  }
  // SportMonks 是西甲賽後主要來源；API-Football 只在 SportMonks 沒有可發布資料時補缺口。
  const sportmonksMatchPath = join(ROOT, 'data', 'raw', 'sportmonks-la-liga', `${CURRENT_SEASON}-match-details.json`);
  if (existsSync(sportmonksMatchPath)) {
    try {
      const sm = JSON.parse(await readFile(sportmonksMatchPath, 'utf8'));
      for (const [pair, detail] of Object.entries(sm.matches ?? {})) {
        const fixture = fixtureByPair.get(pair);
        const report = buildProviderMatchReport({ fixture, detail, nameOf: code => T.byCode.get(code)?.en ?? code });
        // 主要來源的結果最後寫入，確保同場同時存在兩個來源時仍以 SportMonks 為準。
        if (report) reports[`${CURRENT_SEASON}|${pair}`] = report;
      }
      console.log(`  SportMonks 西甲賽後快取：${Object.keys(sm.matches ?? {}).length} 場・可發布 ${Object.keys(reports).length} 場（含既有來源）`);
    } catch { console.log('  ⚠ SportMonks 賽後快取損壞,本次略過'); }
  }
  const reportCount = Object.keys(reports).length;
  /* 抓取端如果撞到「這個方案不含此賽季」,會把原因寫進存檔的 blocked。
     有 blocked 就代表這不是「還沒抓到」而是「拿不到」—— 畫面上要說的是後者。
     方案升級之後抓取端會自己把 blocked 清掉,這裡不必記得改。 */
  const blocked = postMatchStore.blocked ?? null;
  console.log(blocked
    ? `  ⚠ API-Football 西甲賽後資料拿不到:${blocked.message}`
    : `  API-Football 西甲賽後永久快取：${reportCount}/${curPlayed.length} 場可發布`);

  // 逐場正式先發優先使用 FotMob/enetpulse；找不到的場次再使用西甲官網。
  // 兩者都先轉成既有 official.matches 契約，比分不一致一律不發布。
  const fotmobPath = join(ROOT, 'data', 'raw', 'fotmob-la-liga', `${CURRENT_SEASON}-lineups.json`);
  let officialMatches = {};
  let fotmobStore = null;
  if (existsSync(fotmobPath)) {
    try {
      fotmobStore = JSON.parse(await readFile(fotmobPath, 'utf8'));
      for (const [pair, record] of Object.entries(fotmobStore.matches ?? {})) {
        const fixture = fixtureByPair.get(pair);
        const converted = canonicalOfficial(record);
        if (!fixture || !converted || record.score?.home !== fixture.fh || record.score?.away !== fixture.fa) continue;
        officialMatches[pair] = converted;
      }
      console.log(`  FotMob 西甲正式先發：${Object.keys(officialMatches).length}/${Object.keys(fotmobStore.matches ?? {}).length} 場比分核對通過`);
    } catch { console.log('  ⚠ FotMob 西甲先發快取損壞,本次略過'); }
  }
  const officialPath = join(ROOT, 'data', 'raw', 'laliga-official', `${CURRENT_SEASON}-lineups.json`);
  let officialStore = null;
  if (existsSync(officialPath)) {
    try {
      officialStore = JSON.parse(await readFile(officialPath, 'utf8'));
      let added = 0;
      for (const [pair, record] of Object.entries(officialStore.matches ?? {})) {
        const fixture = fixtureByPair.get(pair);
        const converted = canonicalOfficial(record);
        if (!fixture || !converted || record.score?.home !== fixture.fh || record.score?.away !== fixture.fa) continue;
        if (!officialMatches[pair]) { officialMatches[pair] = converted; added++; }
      }
      console.log(`  LaLiga 官方先發：新增 ${added} 場・合計 ${Object.keys(officialStore.matches ?? {}).length} 場快取`);
    } catch { console.log('  ⚠ LaLiga 官方先發快取損壞,本次略過'); }
  }
  const officialLineupCount = Object.keys(officialMatches).length;

  // 只用已通過比分核對的正式陣型建立本季 shapes；沒有正式場次的球隊保持資料不足，
  // 不把 Understat 的整季陣型比例或角色推導冒充逐場官方陣型。
  const shapeSamples = new Map();
  const sourceRank = source => /sportmonks/i.test(String(source ?? '')) ? 3
    : /api-football/i.test(String(source ?? '')) ? 2 : 1;
  const addShape = (pair, code, formation, source) => {
    if (!formation) return;
    const key = `${pair}|${code}`;
    const previous = shapeSamples.get(key);
    if (!previous || sourceRank(source) > sourceRank(previous.source)) {
      shapeSamples.set(key, { pair, code, formation, source });
    }
  };
  for (const [pair, match] of Object.entries(officialMatches)) {
    addShape(pair, T.codeOf(match.home?.team) ?? match.home?.code ?? pair.split('|')[0], match.home?.formation, match.source);
    addShape(pair, T.codeOf(match.away?.team) ?? match.away?.code ?? pair.split('|')[1], match.away?.formation, match.source);
  }
  for (const report of Object.values(reports)) {
    for (const code of [report.home, report.away]) {
      addShape(report.key, code, report.sides?.[code]?.shape?.label, report.source);
    }
  }
  const shapes = Object.fromEntries(curCodes.map(code => {
    const samples = [...shapeSamples.values()].filter(x => x.code === code);
    if (!samples.length) return [code, { insufficient: true, source: 'unavailable', games: 0 }];
    const counts = new Map();
    for (const row of samples) counts.set(row.formation, (counts.get(row.formation) ?? 0) + 1);
    const used = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return [code, {
      official: {
        formation: used[0][0], games: samples.length,
        used: used.map(([formation, games]) => ({ formation, games })),
      },
      source: 'official',
      sources: [...new Set(samples.map(x => x.source).filter(Boolean))],
      note: '只統計已核對比分的正式先發陣型；場次不足時不可視為整季常態。',
    }];
  }));
  console.log(`  西甲正式陣型摘要：${Object.values(shapes).filter(s => s.official).length}/${curCodes.length} 隊有已核對場次`);

  const formIndex = buildFormIndex(trainMatches);
  const teamForm = {};
  for (const code of curCodes) {
    const recent = recentForm(formIndex, code, '9999-12-31', 5);
    teamForm[code] = {
      recent, summary: formSummary(recent),
      delta: round(formDelta(formIndex, code, '9999-12-31'), 3),
      availability: null,
    };
  }

  const h2h = {};
  const pairs = new Set(curMatches.map(m => [m.home, m.away].sort().join('|')));
  for (const key of pairs) {
    const [a, b] = key.split('|');
    const rec = headToHead(trainMatches, a, b);
    if (rec.games) h2h[key] = rec;
  }

  const sources = [
    {
      name: 'openfootball / football.json',
      url: 'https://github.com/openfootball/football.json',
      use: '西甲 2025-26 賽果與 2026-27 賽程/比分', license: 'Public Domain',
    },
    {
      name: 'football-data.co.uk',
      url: 'https://www.football-data.co.uk/spainm.php',
      use: '可取得時的西甲市場賠率', license: '免費資料檔',
    },
    {
      name: 'Understat',
      url: `https://understat.com/league/La_liga/${LAST_SEASON.slice(0, 4)}`,
      use: '2025-26 西甲球隊 xG/xGA、射門、陣型、進攻速度與五種進球情境',
      license: '公開頁面低頻率快取',
    },
    {
      name: 'API-Football',
      url: 'https://www.api-football.com/',
      use: '2026-27 完賽後球隊統計、正式陣容、事件與球員評分（成功後永久快取）',
      license: 'API 方案資料',
    },
    {
      name: 'FotMob / enetpulse',
      url: 'https://www.fotmob.com/',
      use: '已完賽西甲逐場先發、陣型與位置座標（小批量永久快取）',
      license: '公開網站資料端點，需遵守來源使用條款',
    },
  ];
  const backtest = {
    available: false,
    note: '西甲目前只有 2025-26 一季完整歷史，尚無獨立留出賽季可做可靠回測。',
  };
  /* ── 球員(Understat)────────────────────────
     兩季各一份。上季完整、本季至今 —— 兩者性質不同,不能混在一起算,
     所以分開輸出並各自標明是哪一季。

     API-Football 那條路走不通(Free 方案只到 2024,實測過)。SportMonks
     若有本地快取,只補經核對的球員身分欄位；傷停與防守統計仍不補。 */
  const playerSeasons = {};
  for (const season of [CURRENT_SEASON, LAST_SEASON]) {
    const loaded = loadPlayers(ROOT, season);
    if (!loaded) { console.log(`  ⚠ 西甲球員 ${season}:沒有快取,略過`); continue; }
    attachRadar(loaded.players);
    playerSeasons[season] = loaded;
    const multi = loaded.players.filter(p => p.multiTeam).length;
    const qualified = loaded.players.filter(p => p.qualified).length;
    console.log(`  西甲球員 ${season}:${loaded.players.length} 人・達 ${MIN_MINUTES} 分鐘門檻 ${qualified} 人・跨隊 ${multi} 人`);
  }

  const playersOut = [];
  const sportmonksBySeason = {};
  for (const [season, data] of Object.entries(playerSeasons)) {
    const store = loadSquadStore(ROOT, season);
    const enriched = enrichPlayers(data.players, store, { codeOf: T.codeOf });
    const withAge = enriched.players.map(p => ({ ...p, age: ageAt(p.dateOfBirth, AS_OF) }));
    sportmonksBySeason[season] = {
      available: enriched.available,
      ...sportmonksCoverage(withAge),
      retrievedAt: store?.retrievedAt ?? null,
    };
    console.log(`  SportMonks 球員補充 ${season}：${enriched.matched}/${data.players.length} 人對上${store ? '' : '（無快取）'}`);
    for (const p of withAge) playersOut.push({ ...p, season });
  }

  const meta = {
    builtAt: new Date().toISOString(), asOf: AS_OF,
    league: 'es1', edition: 'basic',
    currentSeason: CURRENT_SEASON, lastSeason: LAST_SEASON,
    historySeasons: [LAST_SEASON], h2hSeasons: [LAST_SEASON, CURRENT_SEASON],
    sources: [
      ...sources,
      {
        name: 'SportMonks',
        url: 'https://api.sportmonks.com/v3/football/squads/teams/{team_id}?include=player',
        use: '西甲球員背號、頭貼、生日、身高體重、國籍、隊長與合約（只讀本地快取）',
        license: '訂閱 API 資料',
      },
    ],
    capabilities: {
      /* players 是 true；整季進攻與串聯來自 Understat，身分欄位可由
         SportMonks 快取補充。前端仍靠 leaders.missing 宣告尚未取得的項目。 */
      live: false, players: playersOut.length > 0, injuries: false, tactics: teamProfiles.length > 0,
      coaches: false, news: false, officialLineups: reportCount > 0 || officialLineupCount > 0, matchReports: reportCount > 0,
      fixtures: true, standings: true, teams: true, predictions: true, market: true,
      teamProfiles: teamProfiles.length > 0, setPieces: teamProfiles.length > 0,
    },
    model: {
      type: 'Dixon-Coles Poisson + Elo（取平均）',
      homeAdvantage: round(Math.exp(model.gamma), 3), rho: model.rho, decayXi: model.xi,
      promotedPrior: model.promoted, simulationRuns: RUNS, backtest,
      caveats: [
        '西甲模型只使用 2025-26 完整賽季與 2026-27 已完賽資料，樣本少於英超版。',
        '尚無獨立留出賽季可做可靠回測，因此機率只適合作為初版比較基準。',
        '不含球員、傷停、轉會、教練異動、賽程密度與歐戰疲勞。',
        '升班馬沒有上一季西甲樣本，套用聯盟後段先驗並提高模擬不確定性。',
      ],
    },
    counts: {
      teams: teams.length, players: playersOut.length, fixtures: fixtures.length,
      news: 0, injuries: 0, currentSeasonRounds: Math.max(0, ...curPlayed.map(m => m.round ?? 0)),
      currentSeasonPlayers: playerSeasons[CURRENT_SEASON]?.players?.length ?? 0, teamProfiles: teams.filter(t => t.tactics).length,
      matchReports: reportCount, officialLineups: officialLineupCount,
    },
    competition: competition(COMPETITION),
    live: { available: false }, official: { available: false }, ai: { enabled: false, pre: 0, post: 0 },
  };

  console.log('寫入西甲球隊數據第二版資料集：');
  meta.official = {
    available: officialLineupCount > 0 || reportCount > 0,
    source: officialLineupCount > 0 ? [...new Set(Object.values(officialMatches).map(x => x.source))].join(' + ') : (reportCount ? 'api-football' : null),
    sources: [...new Set(Object.values(officialMatches).map(x => x.source))],
    teamFormation: false,
    matches: officialLineupCount,
  };
  await write('meta', meta);
  await write('clubs', T.list);
  await write('teams', teams);
  await write('fixtures', fixtures);
  await write('table', { last: lastTable, current: curTable, lastSeason: LAST_SEASON, currentSeason: CURRENT_SEASON });
  await write('sim', sim);
  await write('form', {
    asOf: AS_OF, inModel: false, tuned: TUNED, tuning: null,
    note: '近期資料只供顯示，不調整模型機率。', teams: teamForm,
  });
  await write('h2h', h2h);
  await write('results', [...lastMatches, ...curPlayed].filter(m => m.played).map(slimMatch));
  await write('news', []);
  await write('players', playersOut);
  await write('leaders', {
    seasons: { current: CURRENT_SEASON, last: LAST_SEASON },
    currentAvailable: Boolean(playerSeasons[CURRENT_SEASON]?.players?.length),
    /* 本季剛開打,沒有人踢滿門檻 —— 那時「每 90 分鐘」的榜是空的。
       前端要據此預設切到上季並說明原因,而不是端一張空表出來。 */
    currentQualified: playerSeasons[CURRENT_SEASON]?.players?.filter(p => p.qualified).length ?? 0,
    minMinutes: MIN_MINUTES,
    source: 'Understat',
    retrievedAt: playerSeasons[CURRENT_SEASON]?.retrievedAt ?? playerSeasons[LAST_SEASON]?.retrievedAt ?? null,
    boards: BOARDS.map(({ key, label, unit, per90 }) => ({ key, label, unit, per90 })),
    axes: RADAR_AXES,
    /* 誠實層:西甲球員頁**沒有**哪些東西,由資料層直接宣告,
       前端照著說。不要讓讀者以為是還沒載入或壞掉。 */
    missing: [
      ...(Object.values(sportmonksBySeason).some(x => x.squadNumber > 0) ? [] : ['背號']),
      ...(Object.values(sportmonksBySeason).some(x => x.photo > 0) ? [] : ['頭貼']),
      ...(Object.values(sportmonksBySeason).some(x => x.dateOfBirth > 0) ? [] : ['出生日期與身價']),
      '傷停與停賽', '防守數據(鏟球/攔截/撲救)',
    ],
    sportmonks: sportmonksBySeason,
    note: 'Understat 提供整季彙總；SportMonks 補充可取得的球員身分欄位。每 90 分鐘僅在上場時間達門檻時給出。',
    current: playerSeasons[CURRENT_SEASON] ? buildLeaders(playerSeasons[CURRENT_SEASON].players) : null,
    last: playerSeasons[LAST_SEASON] ? buildLeaders(playerSeasons[LAST_SEASON].players) : null,
  });
  await write('coaches', { asOf: null, officialAsOf: null, season: LAST_SEASON, coaches: [] });
  await write('goals', { seasons: [], note: '西甲尚未接逐球員進球明細。', data: {} });
  await write('reports', {
    seasons: reportCount ? [CURRENT_SEASON] : [], count: reportCount, reports,
    source: reportCount ? [...new Set(Object.values(reports).map(r => r.source))].join(' + ') : 'sportmonks + api-football', pending: Math.max(0, curPlayed.length - reportCount),
    blocked,
    note: blocked
      ? '目前使用的 API-Football 方案不含本賽季，因此這不是「還沒抓到」而是拿不到。換成涵蓋本賽季的方案後會自動恢復。'
      : '每場成功取得球隊統計、球員評分、事件與正式陣容後永久快取；SportMonks 優先，API-Football 僅補缺口；開頁不呼叫 API。',
  });
  await write('analysis', { enabled: false, pre: {}, post: {}, counts: { pre: 0, post: 0 } });
  // analysis.html 共用同一組載入契約。西甲沒有這些模組時寫出明確空資料，避免 404。
  await write('tactics', teamProfiles);
  await write('experts', { updatedAt: null, count: 0, matches: {} });
  await write('lineups', {});
  await write('shapes', shapes);
  await write('official', {
    available: officialLineupCount > 0 || reportCount > 0,
    season: CURRENT_SEASON,
    source: officialLineupCount > 0 ? [...new Set(Object.values(officialMatches).map(x => x.source))].join(' + ') : (reportCount ? 'api-football' : null),
    sources: [...new Set(Object.values(officialMatches).map(x => x.source))],
    matches: officialMatches,
  });
  await write('live', { available: false, note: '西甲尚未接即時資料。' });

  const crestHits = teams.filter(t => t.crest).length;
  console.log(`\n✔ 西甲球隊數據第二版：${teams.length} 隊・${LAST_SEASON} ${lastMatches.filter(m => m.played).length} 場・${CURRENT_SEASON} ${curPlayed.length}/${curMatches.length} 場已完賽`);
  console.log(`  球隊隊徽：${crestHits}/${teams.length}`);
  console.log(`  上季風格資料：${teamProfiles.length}/20；本季回歸球隊：${teams.filter(t => t.tactics).length}/20`);
  console.log(blocked
    ? `  完整賽後資料：0/${curPlayed.length}（方案不含本賽季，不是等待中）`
    : `  完整賽後資料：${reportCount}/${curPlayed.length}（其餘等待 laliga:postmatch 永久快取）`);
}

main().catch(err => { console.error(`✗ 西甲建置失敗：${err.stack ?? err.message}`); process.exit(1); });
