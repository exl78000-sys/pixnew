#!/usr/bin/env node
// 手動補抓所有已完賽的 API-Football 球隊/球員/事件資料。
// 成功後永久快取；一般情況 npm run live 會在終場後自動執行，不必每天重抓。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { CURRENT_SEASON } from './lib/sources.mjs';
import { fetchCompletedMatchDetails } from './lib/adapters/api-football.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = key => process.argv.find(a => a.startsWith(`--${key}=`))?.split('=')[1];

async function main() {
  const season = arg('season') ?? CURRENT_SEASON;
  const T = loadTeams(ROOT);
  console.log(`▶ 補抓 ${season} 已完賽完整數據`);
  const result = await fetchCompletedMatchDetails({
    root: ROOT, season, codeOf: T.codeOf, force: process.argv.includes('--force'),
  });
  if (!result.enabled) {
    console.log(`  ⚠ ${result.note}`);
    console.log('  設定環境變數後再執行: API_FOOTBALL_KEY=你的金鑰 npm run postmatch');
    return;
  }
  if (result.error) console.log(`  ⚠ ${result.error}`);
  console.log(`  新抓 ${result.fetched ?? 0} 場・永久快取共 ${result.cached ?? 0} 場`
    + (result.missing ? `・待補 ${result.missing} 場` : '')
    + (result.budgetLeft == null ? '' : `・今日額度剩 ${result.budgetLeft}`));
  if (result.file) console.log(`✔ ${result.file}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
