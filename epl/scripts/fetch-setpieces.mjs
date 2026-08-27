#!/usr/bin/env node
// 抓上一完整賽季的 Understat 球隊「進攻情境」摘要。
//
//   npm run setpieces
//   npm run laliga:setpieces
//   npm run setpieces -- --force
//   npm run setpieces -- --limit=1 --delay=0   # 開發時只驗一隊
//
// 原則:
// - 歷史完整賽季只需抓一次;已有且驗證通過就跳過。
// - 單線、預設每隊至少間隔 1.6 秒,不做大量並發。
// - 每抓完一隊就寫 checkpoint;中途失敗下次從缺的隊繼續。
// - 每隊的五種情境進失球總和必須跟 openfootball 賽果完全一致,否則不標完成。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTeams } from './lib/teams.mjs';
import { loadMatches } from './lib/adapters/index.mjs';
import { teamRecord } from './lib/table.mjs';
import { round } from './lib/util.mjs';
import { COMPETITION as PL_COMPETITION, LAST_SEASON as PL_LAST_SEASON } from './lib/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const FORCE = process.argv.includes('--force');
const DELAY = Math.max(0, Number(arg('delay') ?? 1600));
const LIMIT = Math.max(1, Number(arg('limit') ?? 999));
const LEAGUE = arg('league') || 'pl';
const PROFILES = {
  pl: {
    label: '英超', teamFile: 'teams.json', competition: PL_COMPETITION,
    lastSeason: PL_LAST_SEASON, rawDir: 'openfootball', cacheDir: 'understat',
    providerLeague: 'EPL',
  },
  es1: {
    label: '西甲', teamFile: 'teams-la-liga.json', competition: 'esp.1',
    lastSeason: '2025-26', rawDir: 'openfootball-la-liga', cacheDir: 'understat-la-liga',
    providerLeague: 'La_liga',
  },
};
const PROFILE = PROFILES[LEAGUE];
if (!PROFILE) throw new Error(`不支援的聯賽 --league=${LEAGUE}`);
const { competition: COMPETITION } = PROFILE;
/* 預設抓「上一完整賽季」,但要測進球情境有沒有預測力時得往回多抓幾季 ——
   情境是整季彙總,拿本季彙總預測本季比賽等於偷看未來,只能用**上一季**當先驗。
   所以開一個 --season= 覆寫,歷史季各抓一次就好(抓完會存檔,不會重抓)。 */
const LAST_SEASON = arg('season') || PROFILE.lastSeason;
const DIR = join(ROOT, 'data', 'raw', PROFILE.cacheDir);
const FILE = join(DIR, `${LAST_SEASON}-team-situations.json`);
const PROVIDER_SEASON = LAST_SEASON.slice(0, 4);
const SITUATIONS = ['OpenPlay', 'FromCorner', 'SetPiece', 'DirectFreekick', 'Penalty'];

// 只列跟本站英文名不同的 Understat slug;其餘直接用 teams.json 的 en。
const NAME = {
  LEE: 'Leeds', MCI: 'Manchester City', MUN: 'Manchester United', NEW: 'Newcastle United',
  NFO: 'Nottingham Forest', WOL: 'Wolverhampton Wanderers',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const num = v => Number(v) || 0;
const compact = s => ({
  shots: num(s?.shots), goals: num(s?.goals), xG: round(num(s?.xG), 4),
  against: {
    shots: num(s?.against?.shots), goals: num(s?.against?.goals), xG: round(num(s?.against?.xG), 4),
  },
});
const compactGroup = group => Object.fromEntries(Object.entries(group ?? {}).map(([key, row]) => [key, {
  stat: row?.stat ?? key,
  time: num(row?.time),
  ...compact(row),
}]));

function combine(rows) {
  return {
    shots: rows.reduce((a, r) => a + r.shots, 0),
    goals: rows.reduce((a, r) => a + r.goals, 0),
    xG: round(rows.reduce((a, r) => a + r.xG, 0), 4),
    against: {
      shots: rows.reduce((a, r) => a + r.against.shots, 0),
      goals: rows.reduce((a, r) => a + r.against.goals, 0),
      xG: round(rows.reduce((a, r) => a + r.against.xG, 0), 4),
    },
  };
}

async function fetchTeam(slug) {
  const url = `https://understat.com/getTeamData/${encodeURIComponent(slug)}/${PROVIDER_SEASON}`;
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20000),
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          referer: `https://understat.com/team/${encodeURIComponent(slug)}/${PROVIDER_SEASON}`,
          'user-agent': 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)',
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.statistics?.situation) throw new Error('缺 statistics.situation');
      return { data, url };
    } catch (e) {
      last = e;
      if (attempt < 3) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw last;
}

/* 先寫暫存檔再改名。直接寫 FILE 的話,程序被中斷(管線被關掉、runner 被砍)
   會留下一個**半截或 0 位元組**的檔案,而下一次執行會 JSON.parse 它然後炸掉 ——
   而且看起來像上游資料壞了。改名是原子操作,要嘛舊的要嘛新的。 */
async function save(out) {
  out.retrievedAt = new Date().toISOString();
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 2) + '\n');
  await rename(tmp, FILE);
}

async function main() {
  const T = loadTeams(ROOT, { file: PROFILE.teamFile });
  const matches = loadMatches({
    root: ROOT, competition: COMPETITION, season: LAST_SEASON, codeOf: T.codeOf,
    rawDir: PROFILE.rawDir,
  });
  const codes = [...new Set(matches.flatMap(m => [m.home, m.away]))].sort();
  await mkdir(DIR, { recursive: true });

  let out = {
    season: LAST_SEASON,
    providerSeason: PROVIDER_SEASON,
    source: 'Understat',
    league: LEAGUE,
    sourceUrl: `https://understat.com/league/${PROFILE.providerLeague}/${PROVIDER_SEASON}`,
    note: '情境分類為 OpenPlay / FromCorner / SetPiece / DirectFreekick / Penalty。非十二碼定位球為後三者中的前兩種加直接任意球。',
    complete: false,
    retrievedAt: null,
    teams: {},
  };
  if (!FORCE && existsSync(FILE)) {
    // 舊檔壞掉(先前被中斷)就當作沒有,重抓一次 —— 不要因為一個殘檔整條管線停住
    try {
      const prev = JSON.parse(await readFile(FILE, 'utf8'));
      if (prev.season === LAST_SEASON) out = { ...out, ...prev, complete: false, teams: prev.teams ?? {} };
    } catch { console.log(`  ⚠ 既有的 ${LAST_SEASON} 快取解析不了(多半是上次被中斷),這次重抓。`); }
  }

  console.log(`▶ Understat ${PROFILE.label} ${LAST_SEASON} 情境資料(${codes.length} 隊・單線・間隔 ${DELAY}ms)\n`);
  let fetched = 0;
  for (const code of codes) {
    if (!FORCE && out.teams[code]?.validation?.ok) {
      console.log(`  · ${code} 已有且驗證通過,跳過`);
      continue;
    }
    if (fetched >= LIMIT) break;
    const slug = T.byCode.get(code)?.understat ?? NAME[code] ?? T.byCode.get(code)?.en;
    if (!slug) throw new Error(`${code} 缺 Understat 隊名`);
    try {
      const { data, url } = await fetchTeam(slug);
      const situations = Object.fromEntries(SITUATIONS.map(k => [k, compact(data.statistics.situation[k])]));
      const all = combine(Object.values(situations));
      const setPiece = combine(['FromCorner', 'SetPiece', 'DirectFreekick'].map(k => situations[k]));
      const real = teamRecord(matches, code);
      const providerResults = (data.dates ?? []).filter(m => m.isResult);
      const providerMatches = providerResults.length;
      const providerByMatch = new Map(providerResults.map(m => {
        const home = T.codeOf(m.h?.title), away = T.codeOf(m.a?.title);
        // 聯賽每個主客組合一季只出現一次。來源曾有同一場相差一天的日期口徑，
        // 所以比分核對以主客組合為鍵；日期仍保留在 mismatch 訊息供人工查核。
        return [`${home}|${away}`, {
          date: String(m.datetime).slice(0, 10), score: [Number(m.goals?.h), Number(m.goals?.a)],
        }];
      }));
      const expectedGames = matches.filter(m => m.played && (m.home === code || m.away === code));
      const scorelineMismatches = expectedGames.flatMap(m => {
        const provider = providerByMatch.get(`${m.home}|${m.away}`);
        return provider && provider.score[0] === m.fh && provider.score[1] === m.fa
          ? []
          : [{ date: m.date, home: m.home, away: m.away, expected: [m.fh, m.fa], provider: provider ?? null }];
      });
      const situationGoalsReconciled = all.goals === real.gf && all.against.goals === real.ga;
      const validation = {
        // 逐場比分核對比單純總和更嚴格。情境加總若因烏龍球口徑不同而不符，
        // 該隊的情境「進球數」不發布，但 xG/射門仍可使用。
        ok: providerMatches === real.p && scorelineMismatches.length === 0,
        providerMatches, expectedMatches: real.p,
        scorelinesReconciled: scorelineMismatches.length === 0,
        scorelineMismatches,
        situationGoalsReconciled,
        providerGoals: all.goals, expectedGoals: real.gf,
        providerConceded: all.against.goals, expectedConceded: real.ga,
      };
      if (!validation.ok) throw new Error(`核對失敗:${JSON.stringify(validation)}`);
      out.teams[code] = {
        providerName: slug,
        url,
        matches: providerMatches,
        situations,
        nonPenaltySetPiece: setPiece,
        profile: {
          formation: compactGroup(data.statistics.formation),
          attackSpeed: compactGroup(data.statistics.attackSpeed),
          shotZone: compactGroup(data.statistics.shotZone),
          timing: compactGroup(data.statistics.timing),
        },
        validation,
      };
      await save(out);
      console.log(`  ✔ ${code} ${slug}:定位球 ${situationGoalsReconciled ? `${setPiece.goals} 球 / ` : '進球分類從缺・'}${setPiece.xG} xG・${situationGoalsReconciled ? `失 ${setPiece.against.goals} 球 / ` : ''}${setPiece.against.xG} xGA`);
      fetched++;
      if (fetched < LIMIT) await sleep(DELAY);
    } catch (e) {
      console.log(`  ✗ ${code} ${slug}:${e.message}`);
      await save(out);
    }
  }

  out.complete = codes.every(code => out.teams[code]?.validation?.ok);
  out.validation = {
    teams: Object.keys(out.teams).length,
    expectedTeams: codes.length,
    allScorelinesReconciled: out.complete,
    situationGoalTotalsReconciled: codes.filter(code => out.teams[code]?.validation?.situationGoalsReconciled !== false).length,
    situationGoalTotalsExpected: codes.length,
    arsenalCornerGoals: out.teams.ARS?.situations?.FromCorner?.goals ?? null,
    arsenalOfficialCheck: LEAGUE === 'pl' ? {
      expected: 19,
      ok: out.teams.ARS?.situations?.FromCorner?.goals === 19,
      source: 'https://www.arsenal.com/news/arsenal-analysed-how-we-won-the-premier-league-aO1ug2E0S5oq',
    } : null,
  };
  if (out.complete && LEAGUE === 'pl' && !out.validation.arsenalOfficialCheck.ok) {
    out.complete = false;
    throw new Error(`Arsenal 官方角球進球核對失敗:實際 ${out.validation.arsenalCornerGoals},官方 19`);
  }
  await save(out);
  console.log(`\n${out.complete ? '✔ 完成' : '△ 尚未完成'}:${Object.keys(out.teams).length}/${codes.length} 隊・比分核對 ${out.complete ? '全數通過' : '待續跑'}`);
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
