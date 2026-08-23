#!/usr/bin/env node
// 抓即時比賽狀態 → data/raw/live.json,build 時會併進網站。
//
//   npm run live                          自動:先試官方 API,失敗改用 GitHub 鏡像
//   npm run live -- --source=api          只用官方 API(比賽進行中逐分鐘更新)
//   npm run live -- --source=mirror       只用 GitHub 鏡像
//   npm run live -- --round=3             指定輪次
//   npm run live -- --replay=2025-26:38   重播某一輪真實比賽(會標記為示範資料)
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { fetchLive } from './lib/live.mjs';
import { CURRENT_SEASON } from './lib/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];

async function main() {
  const T = loadTeams(ROOT);
  const opts = {
    source: arg('source') ?? 'auto',
    season: arg('season') ?? CURRENT_SEASON,
    round: arg('round') ? Number(arg('round')) : null,
    replay: arg('replay') ?? null,
    codeOf: T.codeOf,
    root: ROOT,
  };
  console.log(`▶ 抓取即時狀態(來源 ${opts.replay ? 'replay ' + opts.replay : opts.source})\n`);

  let data;
  try {
    data = await fetchLive(opts);
  } catch (err) {
    console.error('✗ ' + err.message);
    console.error('\n提示:官方 FPL API 需要能連到 fantasy.premierleague.com。');
    console.error('     受限網路(例如只放行 GitHub 的沙箱)請改用:');
    console.error('       npm run live -- --source=mirror --round=N');
    console.error('     或用真實歷史比賽重播來確認功能:');
    console.error('       npm run live -- --replay=2025-26:38');
    process.exit(1);
  }

  const started = data.fixtures.filter(f => f.started);
  const live = started.filter(f => !f.finished);
  const done = started.filter(f => f.finished);
  const withLineups = data.fixtures.filter(f => Object.values(f.lineups).some(l => l.length));

  await mkdir(join(ROOT, 'data', 'raw'), { recursive: true });
  await writeFile(join(ROOT, 'data', 'raw', 'live.json'), JSON.stringify(data, null, 1));

  console.log(`  來源:${data.sourceLabel}`);
  console.log(`  第 ${data.round} 輪・共 ${data.fixtures.length} 場`);
  console.log(`  進行中 ${live.length}・已完賽 ${done.length}・未開賽 ${data.fixtures.length - started.length}`);
  console.log(`  有出場名單的比賽:${withLineups.length}`);
  if (data.demo) console.log('  ⚠ 這是重播資料,網站上會明確標示不是現在進行中的比賽');
  console.log('\n✔ 已寫入 data/raw/live.json,請接著跑 npm run build');
}

main();
