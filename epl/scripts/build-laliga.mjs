#!/usr/bin/env node
// 西甲資料版：模型只使用 2025-26 完整賽季與 2026-27 本季資料；
// 球隊風格另取 2025-26 已逐場核對的 Understat 球隊摘要。
// 輸出維持既有前端的核心資料形狀，但明確關閉沒有可靠來源的球員、傷停、即時與戰術模組。
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMatches } from './lib/adapters/openfootball.mjs';
import { coaches as fotmobCoaches, goals as fotmobGoals, verifyGoals, verifyCoachRecords, goalRecords } from './lib/adapters/fotmob-manual.mjs';
import { competition } from './lib/canonical.mjs';
import { buildGoals } from './lib/goals.mjs';
import { loadTeams } from './lib/teams.mjs';
import { laligaMatches, backfillLine } from './lib/laliga-matches.mjs';
import { europeanKickoff } from './lib/league-matches.mjs';
import { numberProfile, traditionVsData, formationUsage, usageAsRows } from './lib/knowledge.mjs';
import { loadUclSeasons, uclTeamAssets } from './lib/ucl.mjs';
import { loadCurated } from './lib/curated-archive.mjs';
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
import { loadPlayers, buildLeaders, attachRadar, normalisePlayerForSite, BOARDS, RADAR_AXES, MIN_MINUTES } from './lib/adapters/understat-players.mjs';
import { loadSquadStore, loadCoachDetails, coachesFromSquadStore, enrichPlayers, coverage as sportmonksCoverage, playerPosition as sportmonksPlayerPosition } from './lib/adapters/sportmonks.mjs';
import { loadOfficialCoachStore, officialCoachesFromStore } from './lib/adapters/laliga-official.mjs';
import { loadCoachPhotos, coachPhotoFor } from './lib/adapters/coach-photos.mjs';
import { loadExpertOpinions } from './lib/experts.mjs';
import { loadVerifiedLoans, attachLoans } from './lib/loans.mjs';
import { teamMatchRows, styleTrendFor, attachTrendPercentiles, seasonRuler } from './lib/style-trend.mjs';
import { attachCareers } from './lib/coach-career.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'data', 'leagues', 'es1');
const COMPETITION = 'esp.1';
const LAST_SEASON = '2025-26';
const CURRENT_SEASON = '2026-27';
/* 更早的完整賽季。**選配** —— openfootball 拿得到就用,拿不到照樣建站。
   為什麼要:多一季訓練資料本身就會讓 Poisson 的攻守參數穩一些,
   而且兩季完整歷史才跑得動走查回測(調參一季、驗收另一季)。
   Poisson 有時間衰減(refDate),舊比賽會自動降權,不必手動加權。 */
/* 2023-24 是**量過才加的**,不是「資料越多越好」的直覺:
   走查回測把兩種組合各跑一次,驗收季 2025-26 上
   2023-24+2024-25 的 RPS 0.2031 比只用 2024-25 的 0.2043 好 0.0012,
   差距是 2.1 個標準誤 —— 超過一個標準誤才採用(專案鐵則二的門檻)。
   線上模型與回測必須吃同一組訓練季,不然頁面上的準度講的是另一個模型。 */
const PRIOR_SEASONS = ['2023-24', '2024-25'];
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

// 西班牙本土賽事使用 Europe/Madrid(夏 +02:00、冬 +01:00)。
// DST 規則共用 lib/league-matches 那一份,不自己再寫。
const madridKickoff = europeanKickoff({ summer: '+02:00', winter: '+01:00' });

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
      // `label` 是英超模板的共同欄位；`primary` 與 `list` 保留西甲來源語意。
      // Understat 沒有逐場位置座標，因此不填英超專用的 shape/def/mid/fwd。
      formation: { label: formations[0]?.name ?? null, primary: formations[0]?.name ?? null, list: formations, source: 'Understat' },
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

  /* 賽果統一走 laligaMatches:它會在主來源缺比分時用**已核對過的**備援來源補上。
     回測與線上模型必須吃同一份賽果,不然頁面上的準度講的是另一批比賽。 */
  const backfills = [];   // 補過比分的賽季要寫進畫面上的資料說明,不能只印在 log
  const load = season => {
    const { matches, backfill } = laligaMatches(ROOT, season, { codeOf: T.codeOf, kickoffOf: madridKickoff });
    const line = backfillLine(season, backfill);
    if (line) console.log(line);
    if (backfill?.filled) backfills.push({ season, ...backfill });
    return matches;
  };
  const lastMatches = load(LAST_SEASON);
  const curMatches = load(CURRENT_SEASON);
  /* 選配歷史季:檔案不在就安靜跳過(fetch-laliga.mjs 那邊也是選配),
     但有拿到就要印出來 —— 訓練資料變多是會影響每一個機率的事,不能靜靜發生。 */
  const priorSeasons = [];
  for (const season of PRIOR_SEASONS) {
    if (!existsSync(join(ROOT, 'data', 'raw', 'openfootball-la-liga', `${season}.json`))) continue;
    const ms = load(season).filter(m => m.played);
    if (ms.length < 300) { console.log(`  ⚠ ${season} 只有 ${ms.length} 場,不足一季,不納入訓練`); continue; }
    priorSeasons.push({ season, matches: ms });
    console.log(`  歷史賽季 ${season}:${ms.length} 場納入模型訓練`);
  }
  const priorMatches = priorSeasons.flatMap(x => x.matches);
  // 模型實際吃到的完整賽季,用來組畫面上的說明 —— 說明要跟資料一致
  const fullSeasons = [...priorSeasons.map(x => x.season), LAST_SEASON];
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
  const trainMatches = [...priorMatches, ...lastMatches, ...curPlayed];
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
  const coachDetails = loadCoachDetails(ROOT);
  const currentSquadSize = new Map(Object.entries(currentSquadStore?.squads ?? {})
    .map(([code, list]) => [code, Array.isArray(list) ? list.length : 0]));
  // 以本季球隊名單的 provider ID 作為賽後位置的校正來源。舊快取曾使用
  // 錯誤 position ID 範圍，這層可在不重抓 API 的情況下安全修復已完成賽事。
  const sportmonksPositionByProviderId = new Map(Object.values(currentSquadStore?.squads ?? {}).flatMap(rows =>
    (Array.isArray(rows) ? rows : []).map(row => [
      String(row?.player_id ?? row?.player?.id ?? ''),
      sportmonksPlayerPosition(row?.position_id ?? row?.player?.position_id),
    ]).filter(([id, position]) => id && position)));
  const sportmonksCoachData = coachesFromSquadStore(currentSquadStore, { details: coachDetails });
  const officialCoachStore = loadOfficialCoachStore(ROOT, { season: CURRENT_SEASON });
  const officialCoachData = officialCoachesFromStore(officialCoachStore);
  // 官方 staff 頁是現任姓名的優先核對來源；SportMonks 只補官方尚未解析到的球隊。
  const officialCoachTeams = new Set(officialCoachData.map(c => c.team));
  const coachData = [...officialCoachData, ...sportmonksCoachData.filter(c => !officialCoachTeams.has(c.team))];

  /* 教練任內戰績(FotMob 人工交付)。**接之前先用我們自己的賽果重算核對** ——
     協作方自報「全過」不算數(鐵則五)。核對不過的整隊不掛,不是「先掛上去再說」。

     這一批的 since(接任日期)四十筆全是 null,所以只補戰績不補任期;
     畫面上不要因為有了戰績就宣稱知道任期。 */
  const coachBy0 = new Map(coachData.map(c => [c.team, c]));
  const fmCoaches = fotmobCoaches(ROOT);
  let coachRecordSource = null;
  if (fmCoaches) {
    const ourPlayed = curPlayed.map(m => ({ home: m.home, away: m.away, fh: m.fh, fa: m.fa }));
    const fmGoalsAll = fotmobGoals(ROOT);
    const gv = fmGoalsAll ? verifyGoals('es1', fmGoalsAll, ourPlayed) : { newer: [] };
    const cv = verifyCoachRecords('es1', fmCoaches, ourPlayed, gv.newer);
    for (const { coach } of cv.agree) {
      const target = coachBy0.get(coach.team);
      /* 掛在 currentSeasonRecord,**不是 seasonRecord** —— 這是本季的戰績。
         英超那邊 seasonRecord 是「上季完整 38 場」、currentSeasonRecord 是本季,
         兩個聯賽用同一組欄位名前端才能共用一張表;
         以前西甲把本季塞進 seasonRecord,合併時就會拿本季 1 場去跟英超上季 38 場排在一起。 */
      if (target) target.currentSeasonRecord = { season: CURRENT_SEASON, ...coach.seasonRecord };
    }
    coachRecordSource = {
      source: fmCoaches.source, retrievedAt: fmCoaches.retrievedAt,
      verified: cv.agree.length, differ: cv.differ.length, noRecord: cv.noRecord.length,
      // 上游比我們新的場次要講出來 —— 那是「我們的賽果還沒更新」不是「資料錯」
      aheadMatches: gv.newer.map(x => x.key),
      note: 'FotMob 交付的教練本季戰績,已用本站 openfootball 賽果逐欄位核對;'
        + '對不上的整隊不採用。接任日期上游沒有,維持未知。',
    };
    console.log(`  教練戰績(FotMob):核對通過 ${cv.agree.length} 隊`
      + (cv.differ.length ? `・對不上 ${cv.differ.length} 隊(不採用)` : '')
      + (gv.newer.length ? `・上游多 ${gv.newer.length} 場(已計入核對)` : ''));
  }
  const coachPhotos = loadCoachPhotos(ROOT);
  for (const c of coachData) {
    const photo = (c.imagePath && !/default-player|placeholder/i.test(c.imagePath))
      ? { imagePath: c.imagePath, source: c.source, sourceUrl: c.sourceUrl }
      : coachPhotoFor(coachPhotos, 'es1', c.team);
    if (photo?.imagePath) { c.imagePath = photo.imagePath; c.photoSource = photo.source; c.photoSourceUrl = photo.sourceUrl; }
  }
  // 教練前一段任期(B 層):核對通過的職涯 + 本站季檔算的逐場風格(lib/coach-career.mjs)
  attachCareers(ROOT, coachData, 'es1');
  const coachBy = new Map(coachData.map(c => [c.team, c]));

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

  /* 近 10 場風格位移 —— 跟英超同一份實作(lib/style-trend.mjs)。
     逐場統計取 football-data.co.uk 的 SP1 季檔(上季到本季同一套欄位)。
     升班馬上季不在西甲,基準 null、只列近況。 */
  const styleTrendBy = new Map();
  {
    const csvOf = season => {
      const p = join(ROOT, 'data', 'raw', 'football-data-couk-la-liga', `${season}.csv`);
      return existsSync(p) ? teamMatchRows(readFileSync(p, 'utf8'), { codeOf: T.codeOf, div: 'SP1' }) : new Map();
    };
    const trendLast = csvOf(LAST_SEASON), trendCur = csvOf(CURRENT_SEASON);
    for (const code of curCodes) {
      const t = styleTrendFor({ lastRows: trendLast.get(code) ?? [], curRows: trendCur.get(code) ?? [] });
      if (t) styleTrendBy.set(code, t);
    }
    attachTrendPercentiles(styleTrendBy, { ruler: seasonRuler(trendLast) });
    console.log(`  風格位移:近 10 場視窗 ${styleTrendBy.size} 隊(升班馬基準為 null)`);
  }

  const teams = curCodes.map(code => {
    const reg = T.byCode.get(code);
    const ls = lastBy.get(code) ?? null;
    const current = curBy.get(code) ?? null;
    return {
      ...reg,
      styleTrend: styleTrendBy.get(code) ?? null,
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
      tactics: profileBy.get(code) ?? null, coach: coachBy.get(code) ?? null, schedule: null,
      history: historyByTeam.get(code), squadSize: currentSquadSize.get(code) ?? 0,
      /* 傷停:西甲沒有可靠來源,所以是 **null 不是 0**。
         0 的意思是「查過了,這隊沒人受傷」,那是我們沒有的資訊;
         前端會據此整段不顯示,而不是印出一個假的「無傷停回報」。 */
      injuries: null,
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
  // 少數場次的 SportMonks 事件回應可能只有部分入球。人工覆寫只接受「兩隊
  // 射手數加總精確等於終場比分」且每場都有來源網址的資料；它獨立存放，絕不
  // 回寫或偽裝成 API 原始快取。
  const goalOverridePath = join(ROOT, 'data', 'manual', 'laliga-goal-overrides.json');
  let goalOverrides = {};
  if (existsSync(goalOverridePath)) {
    try {
      const raw = JSON.parse(await readFile(goalOverridePath, 'utf8'));
      if (raw?.season === CURRENT_SEASON) goalOverrides = raw.matches ?? {};
    } catch { console.log('  ⚠ 西甲已核對射手覆寫檔損壞，本次略過'); }
  }
  const withVerifiedScorers = (fixture, detail) => {
    const override = goalOverrides[`${fixture?.home}|${fixture?.away}`];
    if (!fixture || !detail || !Array.isArray(override?.goals)) return detail;
    const counts = { [fixture.home]: 0, [fixture.away]: 0 };
    for (const goal of override.goals) {
      if (!(goal?.team in counts) || !goal.player) return detail;
      counts[goal.team]++;
    }
    if (counts[fixture.home] !== fixture.fh || counts[fixture.away] !== fixture.fa) return detail;
    const goals = override.goals.map(goal => ({
      minute: goal.minute ?? null, extra: goal.extra ?? null,
      label: goal.minute == null ? '' : `${goal.minute}${goal.extra ? `+${goal.extra}` : ''}'`,
      team: goal.team, type: 'Goal', detail: 'verified scorer', comments: null,
      player: goal.player, playerId: null, assist: null, assistId: null,
      source: override.source, sourceUrl: override.sourceUrl,
    }));
    return {
      ...detail,
      events: [...(detail.events ?? []).filter(event => event?.type !== 'Goal'), ...goals],
      scorerOverride: { source: override.source, sourceUrl: override.sourceUrl },
    };
  };
  const reports = {};
  for (const [pair, detail] of Object.entries(postMatchStore.matches ?? {})) {
    const fixture = fixtureByPair.get(pair);
    const report = buildProviderMatchReport({
      fixture, detail: withVerifiedScorers(fixture, detail),
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
        const report = buildProviderMatchReport({
          fixture, detail: withVerifiedScorers(fixture, detail), nameOf: code => T.byCode.get(code)?.en ?? code,
          positionByProviderId: sportmonksPositionByProviderId,
        });
        // 主要來源的結果最後寫入，確保同場同時存在兩個來源時仍以 SportMonks 為準。
        if (report) reports[`${CURRENT_SEASON}|${pair}`] = report;
      }
      console.log(`  SportMonks 西甲賽後快取：${Object.keys(sm.matches ?? {}).length} 場・可發布 ${Object.keys(reports).length} 場（含既有來源）`);
    } catch { console.log('  ⚠ SportMonks 賽後快取損壞,本次略過'); }
  }
  const reportCount = Object.keys(reports).length;
  /* 「這一季拿不到」只能在**主要來源一場都發不出來**的時候講。

     SportMonks 是西甲賽後的主要來源,API-Football 只是備援。原本這裡的判斷是
     「還有場次沒發布 → 把備援的方案限制傳到前端」,於是 16/20 的狀態下,
     剩下那 4 場(8/25~8/27 剛踢完)的頁面會寫著
     「本站使用的資料源方案不含本賽季…在換成涵蓋本賽季的方案之前都不會出現」——
     而隔壁 16 場的球隊統計、正式陣容、事件與評分全都在。
     那是把「還沒抓到」講成「拿不到」,兩句話對讀者的意義完全相反。

     所以分成兩個欄位:主要來源掛蛋才是 blocked(整季拿不到);
     主要來源已經證明拿得到、只是缺幾場時走 backupBlocked
     (缺口照實說是「還沒抓到」,同時交代備援補不了)。
     兩個欄位最多只有一個非 null,沒有缺口時兩個都是 null。 */
  const pendingCount = Math.max(0, curPlayed.length - reportCount);
  const planBlocked = postMatchStore.blocked ?? null;
  const blocked = pendingCount > 0 && reportCount === 0 ? planBlocked : null;
  const backupBlocked = pendingCount > 0 && reportCount > 0 ? planBlocked : null;
  console.log(blocked
    ? `  ⚠ 西甲賽後資料整季拿不到:${blocked.message}`
    : `  西甲賽後永久快取：${reportCount}/${curPlayed.length} 場可發布${backupBlocked ? '(缺的等主要來源;備援 API-Football 方案不含本賽季)' : ''}`);

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
    {
      name: 'Wikipedia / Wikimedia Commons',
      url: 'https://en.wikipedia.org/api/rest_v1/',
      use: '西甲教練頭貼備援；LaLiga 官方真實頭貼優先',
      license: '依 Wikimedia 使用條款與圖片授權',
    },
  ];
  /* 回測結果由 npm run laliga:backtest 產生,跟英超跑同一份實作。
     沒跑過就標成未回測 —— **不憑空填數字,也不拿英超的數字充當西甲的**。
     這句 note 會直接印在模型頁上,所以必須跟實際用了幾季一致。 */
  const btLaPath = join(ROOT, 'data', 'backtest-laliga.json');
  let backtest = {
    available: false,
    note: fullSeasons.length >= 2
      ? `西甲已有 ${fullSeasons.join('、')} 兩季完整歷史，走查回測跑得起來；`
        + '但這次 build 沒有讀到回測產物,請先執行 npm run laliga:backtest。'
      : `西甲目前只有 ${fullSeasons.join('、') || LAST_SEASON} 一季完整歷史，尚無獨立留出賽季可做可靠回測。`,
  };
  if (existsSync(btLaPath)) {
    const r = JSON.parse(await readFile(btLaPath, 'utf8'));
    backtest = {
      available: true, season: r.season, games: r.games, ranAt: r.ranAt,
      trainSeasons: r.trainSeasons ?? [],
      rps: r.models.blend.rps, logLoss: r.models.blend.logLoss, hitRate: r.models.blend.hitRate,
      baselineRps: r.models.baseline.rps, models: r.models,
      calibration: r.calibration ?? [], byRound: r.byRound ?? [],
      surprises: r.surprises ?? [], baselineProbs: r.baselineProbs ?? null,
      vsBaseline: r.vsBaseline ?? null, vsMarket: r.vsMarket ?? null,
      coverage: r.coverage ?? null,
      /* 拿到西甲賠率之後這一段會自動出現(回測產物裡的 market 直接帶上來)。
         還沒拿到就標成不可用並說明原因 —— **不用英超的市場數字頂替**,
         那是另一個聯賽的盤口,借過來就是編數字。 */
      market: r.market?.available
        ? r.market
        : { available: false, note: '本站尚未取得西甲的博彩收盤賠率,無法與市場比較。' },
    };
    console.log(`  走查回測:${r.season} ${r.games} 場・RPS ${r.models.blend.rps}`
      + `(基準線 ${r.models.baseline.rps}、差距 ${r.vsBaseline?.ratio ?? '—'} 個標準誤)`);
  }
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
    /* 年齡是這一步才算出來的。buildLeaders 讀的是 playerSeasons,所以要寫回去 ——
       不寫回去,吃 age 的榜(22 歲以下)會永遠是空的,而且空得沒有理由可查。 */
    data.players = withAge;
    for (const p of withAge) playersOut.push(normalisePlayerForSite({ ...p, season }, { codeOf: T.codeOf }));
  }

  // 西甲新聞只讀每日快取；開頁不抓外部網站。抓取器會先限制來源數量，
  // 這裡再做一次最小欄位驗證，避免損壞或無連結的 RSS 項目進入前端。
  const externalNewsPath = join(ROOT, 'data', 'raw', 'news-la-liga.json');
  let externalNews = [];
  if (existsSync(externalNewsPath)) {
    try {
      const rawNews = JSON.parse(await readFile(externalNewsPath, 'utf8'));
      externalNews = Array.isArray(rawNews)
        ? rawNews.filter(item => item && item.title && item.link && item.source).slice(0, 100)
        : [];
    } catch { externalNews = []; }
  }

  /* 譯文快取(npm run news:translate 產生)。沒有就整批顯示原文 ——
     前端有分辨,不會留空。譯文一律**附在原文旁邊**而不是取代它:
     這是機器翻譯,讀者要能自己對照(鐵則四)。 */
  const zhPath = join(ROOT, 'data', 'raw', 'news-la-liga-zh.json');
  let translated = 0;
  if (existsSync(zhPath)) {
    try {
      const zh = JSON.parse(await readFile(zhPath, 'utf8'));
      const keyOf = item => createHash('sha1')
        .update(`${item.title}\n${item.body ?? ''}`).digest('hex').slice(0, 16);
      for (const item of externalNews) {
        const hit = zh.entries?.[keyOf(item)];
        if (hit?.ok && hit.title) {
          item.titleZh = hit.title;
          item.bodyZh = hit.body ?? null;
          item.translatedBy = hit.model ?? 'machine';
          translated++;
        }
      }
      if (translated) console.log(`  西甲外電譯文:${translated}/${externalNews.length} 則有中文`);
    } catch { /* 快取壞掉就當沒有,顯示原文 */ }
  }

  // 西甲即時快照只讀 SportMonks 本地檔；開頁與 build 都不連外。
  // 沒有快照或快照損壞時，保留賽程推算 fallback，不把空資料宣告成即時。
  const liveCachePath = join(ROOT, 'data', 'raw', 'sportmonks-la-liga', 'live.json');
  let liveOut = { available: false, note: '西甲即時比分尚未接入；實時頁面目前以賽程推算進行中與開賽倒數，並保留賽前預測。' };
  if (existsSync(liveCachePath)) {
    try {
      const cachedLive = JSON.parse(await readFile(liveCachePath, 'utf8'));
      if (cachedLive?.source === 'sportmonks' && Array.isArray(cachedLive.matches)) {
        liveOut = cachedLive;
      }
    } catch { /* 損壞快照不阻塞其他西甲資料 */ }
  }

  const meta = {
    builtAt: new Date().toISOString(), asOf: AS_OF,
    league: 'es1', edition: 'basic',
    schema: {
      version: 2,
      players: {
        common: ['code', 'name', 'fullName', 'team', 'teamCodes', 'age', 'photo', 'squadNumber', 'stats'],
        performanceSource: 'Understat', identitySource: 'SportMonks',
        note: 'stats 是單季彙總；未提供的身價、傷停與防守欄位不加入資料契約。',
      },
      tactics: {
        common: ['code', 'attack', 'defence', 'setPieces', 'formation.label', 'formation.list', 'tempo', 'resilience'],
        formationSource: 'Understat',
        note: 'formation.label 是整季主要陣型；沒有逐場座標，不提供英超專用 shape。',
      },
    },
    currentSeason: CURRENT_SEASON, lastSeason: LAST_SEASON,
    historySeasons: [...priorSeasons.map(x => x.season), LAST_SEASON],
    h2hSeasons: [...priorSeasons.map(x => x.season), LAST_SEASON, CURRENT_SEASON],
    sources: [
      ...sources,
      {
        name: 'SportMonks',
        url: 'https://api.sportmonks.com/v3/football/squads/teams/{team_id}?include=player',
        use: '西甲球員背號、頭貼、生日、身高體重、國籍、隊長與合約（只讀本地快取）',
        license: '訂閱 API 資料',
      },
      {
        name: 'LaLiga 官方球隊頁',
        url: 'https://www.laliga.com/en-US/laliga-easports/clubs',
        use: '西甲現任主教練 staff 姓名核對（每日快取，官方缺頁才由 SportMonks 補位）',
        license: '官方網站資料，遵守網站使用條款',
      },
    ],
    capabilities: {
      /* players 是 true；整季進攻與串聯來自 Understat，身分欄位可由
         SportMonks 快取補充。前端仍靠 leaders.missing 宣告尚未取得的項目。 */
      live: liveOut.available === true, players: playersOut.length > 0, injuries: false, tactics: teamProfiles.length > 0,
      coaches: coachData.length > 0, news: externalNews.length > 0, officialLineups: reportCount > 0 || officialLineupCount > 0, matchReports: reportCount > 0,
      fixtures: true, standings: true, teams: true, predictions: true, market: true,
      teamProfiles: teamProfiles.length > 0, setPieces: teamProfiles.length > 0,
    },
    model: {
      type: 'Dixon-Coles Poisson + Elo（取平均）',
      homeAdvantage: round(Math.exp(model.gamma), 3), rho: model.rho, decayXi: model.xi,
      promotedPrior: model.promoted, simulationRuns: RUNS, backtest,
      /* 這些話會原樣印在模型頁上,所以**每一句都要跟這次 build 的實際資料一致**。
         兩句舊的已經過期又講錯:
         - 「最後一輪上游沒有比分,該季實際納入 750 場而不是 380 場」——
           把兩季的總場數拿去跟一季的 380 比,而且只有 2024-25 缺,2023-24 是完整的。
           改成逐季報,而且只報真的有缺的那幾季。
         - 「尚未把西甲接進走查回測管線」—— 已經接了(RPS 0.2031)。改成看產物。 */
      caveats: [
        `西甲模型使用 ${fullSeasons.join('、')} 完整賽季與 ${CURRENT_SEASON} 已完賽資料,樣本少於英超版。`,
        ...(() => {
          const short = priorSeasons.filter(x => x.matches.length < 380);
          return short.length
            ? [`${short.map(x => `${x.season} 實際納入 ${x.matches.length} 場(上游少了 ${380 - x.matches.length} 場比分)`).join('、')}。`]
            : [];
        })(),
        /* 補過比分的賽季要講出來。這不是瑕疵,是**出處不同** ——
           讀者有權知道哪幾場的比分不是主來源給的,以及我們憑什麼相信它。 */
        ...backfills.map(b => `${b.season} 有 ${b.filled} 場的比分主來源(openfootball)沒有,`
          + `改用 football-data.co.uk;兩邊重疊的 ${b.checked} 場逐場核對完全一致才採用。`),
        backtest.available
          ? `走查回測 ${backtest.season} ${backtest.games} 場:RPS ${backtest.rps}、基準線 ${backtest.baselineRps}`
            + `${backtest.vsBaseline ? `,差距 ${backtest.vsBaseline.ratio} 個標準誤` : ''}。`
          : '尚未跑走查回測,因此機率只適合作為初版比較基準。',
        '不含球員、傷停、轉會、教練異動、賽程密度與歐戰疲勞。',
        '升班馬沒有上一季西甲樣本,套用聯盟後段先驗並提高模擬不確定性。',
      ],
    },
    counts: {
      teams: teams.length, players: playersOut.length, fixtures: fixtures.length,
      news: externalNews.length, injuries: 0, currentSeasonRounds: Math.max(0, ...curPlayed.map(m => m.round ?? 0)),
      currentSeasonPlayers: playerSeasons[CURRENT_SEASON]?.players?.length ?? 0, teamProfiles: teams.filter(t => t.tactics).length,
      coaches: coachData.length,
      matchReports: reportCount, officialLineups: officialLineupCount,
    },
    competition: competition(COMPETITION),
    live: liveOut.available
      ? { available: true, source: liveOut.source, sourceLabel: liveOut.sourceLabel, fetchedAt: liveOut.fetchedAt, counts: liveOut.counts }
      : { available: false, note: liveOut.note },
    liveFeed: (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REF_NAME)
      ? `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/${process.env.GITHUB_REF_NAME}/epl/web/data/leagues/es1/live.json`
      : null,
    official: { available: false }, ai: { enabled: false, pre: 0, post: 0 },
  };

  /* 人工整理的外電摘要。說明見 build.mjs 的同一段 ——
     讀的是**檔案庫疊上收件匣**,函式跟英超共用一份定義。 */
  let curatedNews = [], curatedCoverage = null;
  {
    const other = loadTeams(ROOT);
    const fx = [...lastMatches, ...curPlayed];
    const r = await loadCurated({
      root: ROOT, league: 'es1',
      codeOf: n => T.codeOf(n) ?? other.codeOf(n) ?? null,
      fixturesOf: comp => (comp === 'es1' ? fx : null),
      fs: { existsSync, readFile, join },
    });
    curatedNews = r.items; curatedCoverage = r.coverage;
    for (const l of r.lines) console.log(`  ${l}`);
  }
  console.log('寫入西甲球隊數據第二版資料集：');
  meta.official = {
    available: officialLineupCount > 0 || reportCount > 0,
    source: officialLineupCount > 0 ? [...new Set(Object.values(officialMatches).map(x => x.source))].join(' + ') : (reportCount ? 'api-football' : null),
    sources: [...new Set(Object.values(officialMatches).map(x => x.source))],
    teamFormation: false,
    matches: officialLineupCount,
  };
  meta.curatedNews = curatedCoverage;
  await write('meta', meta);
  await write('clubs', T.list);
  await write('teams', teams);
  await write('fixtures', fixtures);
  await write('table', { last: lastTable, current: curTable, lastSeason: LAST_SEASON, currentSeason: CURRENT_SEASON });
  await write('sim', sim);
  /* 進球情境特徵的驗收結果。**沒通過也要發布** —— 模型頁上「測過但沒進模型」
     那一段的存在意義就是這個:讀者看得到我們試了什麼、為什麼不用。 */
  const situationTuningPath = join(ROOT, 'data', 'situation-tuning-es1.json');
  const situationTuning = existsSync(situationTuningPath)
    ? JSON.parse(await readFile(situationTuningPath, 'utf8')) : null;
  // 另一個聯賽的結果,給畫面做交叉引用(兩邊都沒過的話,那個結論比單一聯賽強很多)
  if (situationTuning) {
    const otherPath = join(ROOT, 'data', 'situation-tuning.json');
    if (existsSync(otherPath)) {
      const o = JSON.parse(await readFile(otherPath, 'utf8'));
      situationTuning.other = {
        league: o.league, leagueLabel: o.leagueLabel, accepted: o.accepted,
        holdout: { baselineRps: o.holdout.baselineRps, trials: o.holdout.trials.slice(0, 1) },
      };
    }
  }
  /* 足球知識頁的資料層。西甲跟英超取得的粒度不同:
     背號分佈一樣算得出來,但陣型這邊有**上季逐場的使用分鐘**(Understat),
     比英超那份「本季 20 份正式名單」細得多 —— unit 標出來,畫面才講得對。 */
  {
    const knowledgePath = join(ROOT, 'data', 'manual', 'football-knowledge.json');
    const K = existsSync(knowledgePath)
      ? JSON.parse(await readFile(knowledgePath, 'utf8')) : null;
    if (K) {
      const roster = playersOut.filter(p => p.season === CURRENT_SEASON);
      const profile = numberProfile(roster);
      await write('knowledge', {
        season: CURRENT_SEASON,
        guide: K,
        numbers: { ...profile, tradition: traditionVsData(K.numbers, profile) },
        formations: usageAsRows(formationUsage(teamProfiles)),
        formationSeason: LAST_SEASON,
      });
    }
  }

  /* 歐冠。**跟英超共用同一份** —— 歐冠是跨聯賽的賽事,
     兩邊的頁面看到的必須一模一樣,所以載入與整理都在 lib/ucl.mjs,
     這裡只是再呼叫一次寫進 es1 的目錄(前端的資料是按聯賽分目錄放的)。
     複製一份轉換邏輯過來的話,改了一邊另一邊會悄悄過期。 */
  {
    const pl = loadTeams(ROOT);
    const ucl = await loadUclSeasons(ROOT, [{ league: 'pl', codeOf: pl.codeOf }, { league: 'es1', codeOf: T.codeOf }]);
    if (ucl) {
      await write('ucl', ucl);
      // 說明見 build.mjs 的同一段;這一份跟英超產出的必須逐位元組相同
      await write('ucl-teams', await uclTeamAssets(ROOT, ucl));
      const avail = ucl.seasons.filter(x => x.availability === 'available');
      console.log(`  歐冠:${avail.length} 季可用(${avail.map(x => x.label).join('、')})`);
    }
  }

  await write('form', {
    asOf: AS_OF, inModel: false, tuned: TUNED, tuning: null,
    situationTuning,
    note: '近期資料只供顯示,不調整模型機率。'
      + (situationTuning ? '上季進球情境也跑過走查回測驗收,改善小於雜訊,同樣不進模型。' : ''),
    teams: teamForm,
  });
  await write('h2h', h2h);
  await write('results', [...lastMatches, ...curPlayed].filter(m => m.played).map(slimMatch));

  await write('news', [...curatedNews, ...externalNews]);
  /* 租借紀錄。只讀核對過的那一份(data/loans-verified.json),不讀收件匣 ——
     收件匣裡有已知是錯的紀錄,直接讀它等於把核對整個繞過去。
     轉換與姓名配對收在 lib/loans.mjs,兩個聯賽呼叫同一支,不各寫一份。 */
  const loans = loadVerifiedLoans(ROOT);
  const loanHit = attachLoans(playersOut, loans, {
    nameOf: p => p.fullName || p.name,
    leagueCodes: new Set(teams.map(t => t.code)),
  });
  if (loans.stale) {
    console.log(`  ✗ 租借紀錄過期,整批不掛:${loans.staleReason}`);
    console.log('     修法:npm run loans:verify(核對結果要看過再發布)');
  } else if (loans.available) {
    console.log(`  租借紀錄:掛上 ${loanHit.attached} 筆(核對過 ${loans.records.length} 筆・退回 ${(loans.rejected ?? []).length} 筆)`);
    /* 配不到球員的要印出來 —— 多半是名字寫法不同,那是可以修的。
       靜靜吞掉的話,資料明明在檔案裡卻永遠不會出現在畫面上,而且沒有人會發現。 */
    if (loanHit.unmatched.length) {
      console.log(`  ⚠ 有 ${loanHit.unmatched.length} 筆租借配不到本聯賽球員:`
        + loanHit.unmatched.slice(0, 5).map(r => r.player).join('、')
        + (loanHit.unmatched.length > 5 ? ' …' : ''));
    }
  }
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
    /* 22 歲以下這個榜只看得到有出生日期的人。涵蓋率不寫出來的話,
       讀者會以為那是完整名單 —— 實際上沒對上 SportMonks 的人整批不在裡面。 */
    ageCoverage: Object.fromEntries(Object.entries(playerSeasons).map(([season, data]) => [season, {
      known: data.players.filter(p => p.age != null).length,
      total: data.players.length,
    }])),
  });
  await write('coaches', {
    // 戰績來源另外標:它跟教練姓名不是同一個來源,畫面要分得開
    recordSource: coachRecordSource,
    asOf: officialCoachStore?.retrievedAt ?? currentSquadStore?.retrievedAt ?? null,
    officialAsOf: officialCoachStore?.retrievedAt ?? null,
    season: CURRENT_SEASON,
    source: officialCoachData.length ? 'LaLiga + SportMonks' : (coachData.length ? 'SportMonks' : null),
    sourceUrl: officialCoachData.length ? (officialCoachStore?.sourceUrl ?? 'https://www.laliga.com/en-US/laliga-easports/clubs')
      : (coachData.length ? 'https://api.sportmonks.com/v3/football/teams/seasons/{season_id}?include=coaches' : null),
    sources: {
      official: { count: officialCoachData.length, coverage: officialCoachStore?.coverage ?? null },
      sportmonks: { count: sportmonksCoachData.filter(c => !officialCoachTeams.has(c.team)).length },
    },
    note: coachData.length
      ? '現任姓名以 LaLiga 官方 staff 頁優先核對；官方未解析到的球隊才由 SportMonks 補位。任期、戰績、慣用陣型與風格尚未人工核對。'
      : '西甲尚未取得可核對的教練資料。',
    coaches: coachData,
  });
  /* 本季逐球員進球明細(FotMob 人工交付)。只收**核對通過**的場次 ——
     上游多出來的場次不收,不然逐隊加總會跟本站賽果對不上。
     min 與 start 這個來源沒有,所以每 90 分鐘與「替補進球佔比」不做,
     欄位標 null 而不是 0(0 代表「沒有替補進球」,跟「不知道」是兩件事)。 */
  let goalsOut = { seasons: [], note: '西甲尚未接逐球員進球明細。', data: {} };
  {
    const fmGoalsAll = fotmobGoals(ROOT);
    if (fmGoalsAll) {
      const ourPlayed = curPlayed.map(m => ({ home: m.home, away: m.away, fh: m.fh, fa: m.fa }));
      const v = verifyGoals('es1', fmGoalsAll, ourPlayed);
      const keys = new Set(v.matched.map(x => x.key));
      const { rows, ownGoals } = goalRecords('es1', fmGoalsAll, { onlyKeys: keys });
      if (rows.length) {
        const names = new Map(rows.map(r => [r.code, r.name]));
        const data = buildGoals({ [CURRENT_SEASON]: rows }, {
          nameOf: c => names.get(c) ?? `#${c}`,
          codes: curCodes,
          matchKeys: { [CURRENT_SEASON]: [...keys] },
        });
        // subShare 對這一季無效(算不出先發/替補),標 null 讓畫面知道不能用
        for (const s of Object.values(data)) s.subShare = null;
        goalsOut = {
          seasons: [CURRENT_SEASON], data,
          source: fmGoalsAll.source, retrievedAt: fmGoalsAll.retrievedAt,
          matchesUsed: keys.size, ownGoals,
          unavailable: ['每 90 分鐘進球/助攻', '先發與替補進球拆分'],
          note: `本季 ${keys.size} 場已核對比分的逐球明細(來源 ${fmGoalsAll.source})。`
            + '上游沒有上場分鐘與先發/替補,所以每 90 分鐘與替補進球佔比不做。'
            + (v.newer.length ? `上游另有 ${v.newer.length} 場本站賽果尚未更新,暫不納入。` : ''),
        };
        console.log(`  西甲逐球明細:${keys.size} 場・${rows.length} 筆球員記錄・烏龍球 ${ownGoals}`);
      }
    }
  }
  await write('goals', goalsOut);
  await write('reports', {
    seasons: reportCount ? [CURRENT_SEASON] : [], count: reportCount, reports,
    source: reportCount ? [...new Set(Object.values(reports).map(r => r.source))].join(' + ') : 'sportmonks + api-football', pending: pendingCount,
    blocked,
    // 備援補不了缺口這件事仍要說,但它不是「這一季拿不到」的理由 —— 主要來源已發布 reportCount 場。
    backupBlocked,
    note: blocked
      ? '主要來源與備援目前都拿不到本賽季的完整賽後資料,因此這不是「還沒抓到」而是拿不到。換成涵蓋本賽季的方案後會自動恢復。'
      : backupBlocked
        ? `主要來源(SportMonks)已發布 ${reportCount} 場,其餘 ${pendingCount} 場是剛完賽、還沒快取到,不是拿不到。`
          + '備援來源 API-Football 的方案不含本賽季,補不了這個缺口。開頁不呼叫 API。'
        : '每場成功取得球隊統計、球員評分、事件與正式陣容後永久快取；SportMonks 優先，API-Football 僅補缺口；開頁不呼叫 API。',
  });
  await write('analysis', { enabled: false, pre: {}, post: {}, counts: { pre: 0, post: 0 } });
  // analysis.html 共用同一組載入契約。西甲沒有這些模組時寫出明確空資料，避免 404。
  await write('tactics', teamProfiles);
  // 真人觀點共用同一份人工核對來源，但西甲輸出只能留下西甲賽事鍵，
  // 避免英超觀點因為兩聯賽共用前端而被誤掛到西甲頁面。
  const validExpertKeys = new Set(curMatches.map(m => `${m.season}|${m.home}|${m.away}`));
  const allExpertOpinions = loadExpertOpinions(ROOT);
  const expertMatches = Object.fromEntries(Object.entries(allExpertOpinions.matches)
    .filter(([key]) => validExpertKeys.has(key)));
  const expertRows = Object.values(expertMatches).flat();
  const expertCategories = Object.fromEntries(['news', 'legend', 'expert']
    .map(category => [category, expertRows.filter(row => row.category === category).length]));
  await write('experts', {
    ...allExpertOpinions,
    count: expertRows.length,
    counts: { matches: Object.keys(expertMatches).length, opinions: expertRows.length, drafts: 0, categories: expertCategories },
    matches: expertMatches,
  });
  await write('lineups', {});
  /* 勝率曲線的歷史。這個聯賽沒有逐分鐘的即時管線,所以是空的 ——
     但**檔案要在**:分析頁三個聯賽共用,少這一份會 404 整頁炸掉(英冠踩過)。 */
  await write('prob-history', { season: null, matches: {} });
  await write('shapes', shapes);
  await write('official', {
    available: officialLineupCount > 0 || reportCount > 0,
    season: CURRENT_SEASON,
    source: officialLineupCount > 0 ? [...new Set(Object.values(officialMatches).map(x => x.source))].join(' + ') : (reportCount ? 'api-football' : null),
    sources: [...new Set(Object.values(officialMatches).map(x => x.source))],
    matches: officialMatches,
  });
  await write('live', liveOut);

  const crestHits = teams.filter(t => t.crest).length;
  console.log(`\n✔ 西甲球隊數據第二版：${teams.length} 隊・${LAST_SEASON} ${lastMatches.filter(m => m.played).length} 場・${CURRENT_SEASON} ${curPlayed.length}/${curMatches.length} 場已完賽`);
  console.log(`  球隊隊徽：${crestHits}/${teams.length}`);
  console.log(`  上季風格資料：${teamProfiles.length}/20；本季回歸球隊：${teams.filter(t => t.tactics).length}/20`);
  console.log(`  完整賽後資料：${reportCount}/${curPlayed.length}${
    blocked ? '（主要來源與備援都不含本賽季,不是等待中）'
      : backupBlocked ? '（其餘剛完賽、等 laliga:postmatch；備援方案不含本賽季）'
        : pendingCount ? '（其餘等待 laliga:postmatch 永久快取）' : ''}`);
}

main().catch(err => { console.error(`✗ 西甲建置失敗：${err.stack ?? err.message}`); process.exit(1); });
