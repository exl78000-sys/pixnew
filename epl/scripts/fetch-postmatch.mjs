#!/usr/bin/env node
// 手動補抓所有已完賽的 API-Football 球隊/球員/事件/正式陣容資料。
// 成功後永久快取；一般情況 npm run live 會在終場後自動執行，不必每天重抓。
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { CURRENT_SEASON } from './lib/sources.mjs';
import { loadMatches } from './lib/adapters/openfootball.mjs';
import { API_FOOTBALL_LEAGUES, fetchCompletedMatchDetails } from './lib/adapters/api-football.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.split('=')[1];

async function main() {
  const league = arg('league') ?? 'pl';
  if (!['pl', 'es1'].includes(league)) throw new Error(`不支援的聯賽：${league}`);
  const isLaLiga = league === 'es1';
  const season = arg('season') ?? (isLaLiga ? '2026-27' : CURRENT_SEASON);
  const T = loadTeams(ROOT, { file: isLaLiga ? 'teams-la-liga.json' : 'teams.json' });
  const storage = isLaLiga
    ? { storeDir: 'api-football-la-liga', storeFile: `${season}-match-details.json` }
    : { storeDir: 'api-football', storeFile: 'match-details.json' };
  const file = join(ROOT, 'data', 'raw', storage.storeDir, storage.storeFile);
  let cached = 0;
  if (existsSync(file)) {
    try { cached = Object.keys(JSON.parse(await readFile(file, 'utf8')).matches ?? {}).length; } catch { /* build 會另行拒絕壞檔 */ }
  }

  let onlyKeys = null, expectedScores = null;
  if (isLaLiga) {
    const matches = loadMatches({
      root: ROOT, competition: 'esp.1', season, codeOf: T.codeOf,
      rawDir: 'openfootball-la-liga',
    }).filter(m => m.played && m.date <= new Date().toISOString().slice(0, 10));
    onlyKeys = new Set(matches.map(m => `${m.home}|${m.away}`));
    expectedScores = new Map(matches.map(m => [`${m.home}|${m.away}`, { home: m.fh, away: m.fa }]));
    console.log(`▶ 補抓西甲 ${season} 已完賽完整數據（正式比分 ${matches.length} 場・已快取 ${cached} 場）`);
  } else console.log(`▶ 補抓英超 ${season} 已完賽完整數據（已快取 ${cached} 場）`);

  if (process.argv.includes('--dry-run')) {
    console.log(`  只檢查不連線：最多待補 ${Math.max(0, (onlyKeys?.size ?? 0) - cached)} 場`);
    return;
  }
  const result = await fetchCompletedMatchDetails({
    root: ROOT, season, codeOf: T.codeOf, force: process.argv.includes('--force'),
    onlyKeys, expectedScores,
    leagueId: API_FOOTBALL_LEAGUES[league], ...storage,
    requireLineups: isLaLiga,
  });
  if (!result.enabled) {
    console.log(`  ⚠ ${result.note}`);
    console.log(`  設定環境變數後再執行：API_FOOTBALL_KEY=你的金鑰 npm run ${isLaLiga ? 'laliga:postmatch' : 'postmatch'}`);
    return;
  }
  if (result.blocked) {
    // 「重試也沒用」要講清楚,不然排程會每天照跑、每天看起來成功
    console.log(`  ✗ 這個 API 方案拿不到 ${season}:${result.blocked.message}`);
    console.log('    原因已寫進賽後存檔,build 會據實顯示,不會再寫成「尚待抓取」。');
    console.log('    要改變只有一條路:換一個涵蓋此賽季的方案。');
    return;
  }
  if (result.error) console.log(`  ⚠ ${result.error}`);
  console.log(`  新抓 ${result.fetched ?? 0} 場・永久快取共 ${result.cached ?? 0} 場`
    + (result.missing ? `・待補 ${result.missing} 場` : '')
    + (result.requestsUsed == null ? '' : `・本次請求 ${result.requestsUsed} 次`)
    + (result.budgetLeft == null ? '' : `・今日額度剩 ${result.budgetLeft}`));
  if (result.file) console.log(`✔ ${result.file}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
