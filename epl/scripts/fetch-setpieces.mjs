#!/usr/bin/env node
// 抓上一完整賽季的 Understat 球隊「進攻情境」摘要。
//
//   npm run setpieces
//   npm run setpieces -- --force
//   npm run setpieces -- --limit=1 --delay=0   # 開發時只驗一隊
//
// 原則:
// - 歷史完整賽季只需抓一次;已有且驗證通過就跳過。
// - 單線、預設每隊至少間隔 1.6 秒,不做大量並發。
// - 每抓完一隊就寫 checkpoint;中途失敗下次從缺的隊繼續。
// - 每隊的五種情境進失球總和必須跟 openfootball 賽果完全一致,否則不標完成。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTeams } from './lib/teams.mjs';
import { loadMatches } from './lib/adapters/index.mjs';
import { teamRecord } from './lib/table.mjs';
import { round } from './lib/util.mjs';
import { COMPETITION, LAST_SEASON } from './lib/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'raw', 'understat');
const FILE = join(DIR, `${LAST_SEASON}-team-situations.json`);
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const FORCE = process.argv.includes('--force');
const DELAY = Math.max(0, Number(arg('delay') ?? 1600));
const LIMIT = Math.max(1, Number(arg('limit') ?? 999));
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

async function save(out) {
  out.retrievedAt = new Date().toISOString();
  await writeFile(FILE, JSON.stringify(out, null, 2) + '\n');
}

async function main() {
  const T = loadTeams(ROOT);
  const matches = loadMatches({ root: ROOT, competition: COMPETITION, season: LAST_SEASON, codeOf: T.codeOf });
  const codes = [...new Set(matches.flatMap(m => [m.home, m.away]))].sort();
  await mkdir(DIR, { recursive: true });

  let out = {
    season: LAST_SEASON,
    providerSeason: PROVIDER_SEASON,
    source: 'Understat',
    sourceUrl: `https://understat.com/league/EPL/${PROVIDER_SEASON}`,
    note: '情境分類為 OpenPlay / FromCorner / SetPiece / DirectFreekick / Penalty。非十二碼定位球為後三者中的前兩種加直接任意球。',
    complete: false,
    retrievedAt: null,
    teams: {},
  };
  if (!FORCE && existsSync(FILE)) {
    const prev = JSON.parse(await readFile(FILE, 'utf8'));
    if (prev.season === LAST_SEASON) out = { ...out, ...prev, complete: false, teams: prev.teams ?? {} };
  }

  console.log(`▶ Understat ${LAST_SEASON} 情境資料(${codes.length} 隊・單線・間隔 ${DELAY}ms)\n`);
  let fetched = 0;
  for (const code of codes) {
    if (!FORCE && out.teams[code]?.validation?.ok) {
      console.log(`  · ${code} 已有且驗證通過,跳過`);
      continue;
    }
    if (fetched >= LIMIT) break;
    const slug = NAME[code] ?? T.byCode.get(code)?.en;
    if (!slug) throw new Error(`${code} 缺 Understat 隊名`);
    try {
      const { data, url } = await fetchTeam(slug);
      const situations = Object.fromEntries(SITUATIONS.map(k => [k, compact(data.statistics.situation[k])]));
      const all = combine(Object.values(situations));
      const setPiece = combine(['FromCorner', 'SetPiece', 'DirectFreekick'].map(k => situations[k]));
      const real = teamRecord(matches, code);
      const providerMatches = (data.dates ?? []).filter(m => m.isResult).length;
      const validation = {
        ok: providerMatches === real.p && all.goals === real.gf && all.against.goals === real.ga,
        providerMatches, expectedMatches: real.p,
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
        validation,
      };
      await save(out);
      console.log(`  ✔ ${code} ${slug}:定位球 ${setPiece.goals} 球 / ${setPiece.xG} xG・失 ${setPiece.against.goals} 球 / ${setPiece.against.xG} xGA`);
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
    arsenalCornerGoals: out.teams.ARS?.situations?.FromCorner?.goals ?? null,
    arsenalOfficialCheck: {
      expected: 19,
      ok: out.teams.ARS?.situations?.FromCorner?.goals === 19,
      source: 'https://www.arsenal.com/news/arsenal-analysed-how-we-won-the-premier-league-aO1ug2E0S5oq',
    },
  };
  if (out.complete && !out.validation.arsenalOfficialCheck.ok) {
    out.complete = false;
    throw new Error(`Arsenal 官方角球進球核對失敗:實際 ${out.validation.arsenalCornerGoals},官方 19`);
  }
  await save(out);
  console.log(`\n${out.complete ? '✔ 完成' : '△ 尚未完成'}:${Object.keys(out.teams).length}/${codes.length} 隊・比分核對 ${out.complete ? '全數通過' : '待續跑'}`);
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
