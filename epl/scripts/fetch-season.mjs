#!/usr/bin/env node
// 抓本季「每一輪」的逐球員資料 → data/raw/season-gws.json
// build 會把它累加成每位球員的本季累計數據,排行榜才分得出本季 / 上季。
//
//   npm run season                                  抓本季所有已完成的輪次
//   npm run season -- --source=api                  指定來源
//   npm run season -- --season=2025-26 --max=5      指定賽季與輪數(驗證或展示用)
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { fetchLive } from './lib/live.mjs';
import { CURRENT_SEASON } from './lib/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];

async function main() {
  const T = loadTeams(ROOT);
  const season = arg('season') ?? CURRENT_SEASON;
  const source = arg('source') ?? 'auto';
  const max = Number(arg('max') || 38);

  console.log(`▶ 抓取 ${season} 的逐輪資料(來源 ${source},最多 ${max} 輪)\n`);
  const rounds = [];
  let misses = 0;

  for (let r = 1; r <= max; r++) {
    process.stdout.write(`  第 ${String(r).padStart(2)} 輪 … `);
    try {
      const state = await fetchLive({ source, season, round: r, codeOf: T.codeOf, root: ROOT });
      const withPlayers = state.fixtures.filter(f => Object.values(f.lineups).some(l => l.length));
      if (!withPlayers.length) { console.log('尚無出場資料'); misses++; }
      else {
        rounds.push({ round: r, fixtures: state.fixtures });
        console.log(`${withPlayers.length} 場・${withPlayers.reduce((a, f) => a + Object.values(f.lineups).flat().length, 0)} 筆出場`);
        misses = 0;
      }
    } catch (err) {
      console.log(`無資料(${err.message.split(' —— ')[0]})`);
      misses++;
    }
    // 連續兩輪都沒有,代表賽季就到這裡
    if (misses >= 2) { console.log('  ↳ 連續兩輪無資料,停止'); break; }
  }

  const out = {
    season, source, fetchedAt: new Date().toISOString(),
    rounds,
    counts: {
      rounds: rounds.length,
      matches: rounds.reduce((a, r) => a + r.fixtures.filter(f => f.finished).length, 0),
    },
  };
  await writeFile(join(ROOT, 'data', 'raw', 'season-gws.json'), JSON.stringify(out));

  if (!rounds.length) {
    console.log(`\n本季(${season})目前還沒有任何逐球員資料可抓。`);
    console.log('這是正常的 —— 上游要等該輪結束後才會發布。網站上會標示「本季尚未有數據」。');
  } else {
    console.log(`\n✔ 共 ${rounds.length} 輪、${out.counts.matches} 場已完賽 → data/raw/season-gws.json`);
  }
  console.log('  請接著跑 npm run build');
}

main();
