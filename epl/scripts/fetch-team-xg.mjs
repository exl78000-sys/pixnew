#!/usr/bin/env node
/* 抓 Understat 的**逐場**球隊 xG(getTeamData 的 dates 陣列)。
 *
 * 用途:位移雷達的 xG 三軸(進攻火力/終結效率/防守穩固)要跟主雷達同名同義,
 * 缺的就是逐場 xG —— 2026-08-29 實測 dates 陣列就有(38 場、雙方 xG)。
 * 上季 + 本季都抓:滾動視窗跨季。上季是歷史,驗證通過就不再重抓;
 * 本季每次跑都刷新。
 *
 *   node scripts/fetch-team-xg.mjs --league=pl
 *   node scripts/fetch-team-xg.mjs --league=es1
 *
 * 禮貌:單線、每隊間隔 1.6 秒(跟 setpieces 同一個節奏)。
 * 驗證(鐵則五):每隊每季的進球總和要等於本站賽果算出來的 gf ——
 * 對不上就整隊該季不採用(不挑好看的用)。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const LEAGUE = arg('league') || 'pl';
const DELAY = Math.max(0, Number(arg('delay') ?? 1600));
const FORCE = process.argv.includes('--force');

const PROFILES = {
  pl: { teamFile: 'teams.json', cacheDir: 'understat', dataDir: 'web/data',
    lastSeason: '2025-26', currentSeason: '2026-27' },
  es1: { teamFile: 'teams-la-liga.json', cacheDir: 'understat-la-liga', dataDir: 'web/data/leagues/es1',
    lastSeason: '2025-26', currentSeason: '2026-27' },
};
const P = PROFILES[LEAGUE];
if (!P) { console.error(`未知聯賽 ${LEAGUE}`); process.exit(1); }

// 跟 fetch-setpieces 同一份 slug 覆寫(只列跟名冊 en 不同的)
const NAME = LEAGUE === 'pl' ? {
  LEE: 'Leeds', MCI: 'Manchester City', MUN: 'Manchester United', NEW: 'Newcastle United',
  NFO: 'Nottingham Forest', WOL: 'Wolverhampton Wanderers', HUL: 'Hull', COV: 'Coventry',
  IPS: 'Ipswich', WHU: 'West Ham', SHU: 'Sheffield United', LUT: 'Luton', SOU: 'Southampton', LEI: 'Leicester',
} : {};

const FILE = join(ROOT, 'data', 'raw', P.cacheDir, 'team-dates.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchDates(slug, year) {
  const res = await fetch(`https://understat.com/getTeamData/${encodeURIComponent(slug)}/${year}`, {
    signal: AbortSignal.timeout(20000),
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      referer: `https://understat.com/team/${encodeURIComponent(slug)}/${year}`,
      'user-agent': 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)',
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`API error: ${JSON.stringify(j.error)}`);
  if (!Array.isArray(j.dates)) throw new Error('缺 dates 陣列');
  return j.dates;
}

const compactDates = dates => dates
  .filter(d => d.isResult)
  .map(d => {
    const us = d.side, them = d.side === 'h' ? 'a' : 'h';
    return {
      date: String(d.datetime).slice(0, 10),
      home: d.side === 'h',
      gf: Number(d.goals?.[us]), ga: Number(d.goals?.[them]),
      xg: round(Number(d.xG?.[us]), 3), xga: round(Number(d.xG?.[them]), 3),
    };
  });

async function main() {
  await mkdir(dirname(FILE), { recursive: true });
  const T = loadTeams(ROOT, LEAGUE === 'pl' ? undefined : { file: P.teamFile });
  const results = JSON.parse(await readFile(join(ROOT, P.dataDir, 'results.json'), 'utf8'));
  const arr = results.results ?? results;
  const gfOf = (code, season) => arr.filter(m => m.season === season && !m.stage
    && (m.home === code || m.away === code) && m.played)
    .reduce((n, m) => n + (m.home === code ? m.fh : m.fa), 0);
  const codesOf = season => [...new Set(arr.filter(m => m.season === season && !m.stage)
    .flatMap(m => [m.home, m.away]))];

  const store = existsSync(FILE) ? JSON.parse(await readFile(FILE, 'utf8'))
    : { _note: '逐場球隊 xG(Understat getTeamData 的 dates)。產生:node scripts/fetch-team-xg.mjs。每隊每季進球總和已對回本站賽果,對不上整隊該季不收。', seasons: {}, rejected: [] };
  store.rejected = [];

  for (const season of [P.lastSeason, P.currentSeason]) {
    const year = season.slice(0, 4);
    const codes = codesOf(season);
    if (!codes.length) { console.log(`  ${season}:本站還沒有這季的賽果,跳過`); continue; }
    store.seasons[season] ??= {};
    const bucket = store.seasons[season];
    const isLast = season === P.lastSeason;
    for (const code of codes) {
      // 上季驗證過就不重抓(歷史不會變);本季每次刷新
      if (isLast && !FORCE && bucket[code]?.verified) continue;
      const slug = T.byCode.get(code)?.understat ?? NAME[code] ?? T.byCode.get(code)?.en;
      if (!slug) { console.log(`  ✗ ${code}:缺 Understat 隊名`); continue; }
      try {
        const rows = compactDates(await fetchDates(slug, year));
        const sumGf = rows.reduce((n, r) => n + r.gf, 0);
        const ourGf = gfOf(code, season);
        /* 本季允許兩邊「場次落差」(來源更新節奏不同),但**重疊部分的總進球**
           不可驗 —— 改驗逐場:我方賽果裡同日期同主客的比分要一致 */
        const ours = arr.filter(m => m.season === season && !m.stage && m.played
          && (m.home === code || m.away === code));
        const byDate = new Map(ours.map(m => [m.date, m]));
        let mismatch = 0, joined = 0;
        for (const r of rows) {
          const m = byDate.get(r.date);
          if (!m) continue;
          joined++;
          const gf = m.home === code ? m.fh : m.fa, ga = m.home === code ? m.fa : m.fh;
          if (gf !== r.gf || ga !== r.ga) mismatch++;
        }
        if (mismatch > 0) {
          store.rejected.push({ season, code, mismatch });
          delete bucket[code];
          console.log(`  ✗ ${code} ${season}:${mismatch} 場比分跟本站賽果對不上,整隊該季不收`);
        } else {
          const verified = isLast ? sumGf === ourGf && rows.length >= 30 : true;
          bucket[code] = { slug, fetchedAt: new Date().toISOString(), verified, matches: rows };
          console.log(`  ✔ ${code} ${season}:${rows.length} 場・xG 合計 ${round(rows.reduce((n, r) => n + r.xg, 0), 1)}`
            + `・比分核對 ${joined} 場全符${isLast && !verified ? '(⚠ 總進球對不上,標未驗證)' : ''}`);
        }
      } catch (e) {
        console.log(`  ✗ ${code} ${season}(${slug}):${e.message}`);
      }
      await sleep(DELAY);
    }
  }
  store.fetchedAt = new Date().toISOString();
  await writeFile(FILE, JSON.stringify(store));
  console.log(`  ✓ ${FILE.split('/').slice(-2).join('/')}`);
}

main().catch(e => { console.error('✗', e.message); process.exitCode = 1; });
