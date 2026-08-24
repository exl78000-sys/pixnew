#!/usr/bin/env node
// 抓 football-data.co.uk 的英超賠率 CSV → data/raw/football-data-couk/{season}.csv
//
//   npm run odds                    抓回測要用的那幾季
//   npm run odds -- --season=2025-26 只抓某一季
//
// 免金鑰。這個站每輪比賽後更新當季 CSV,歷史季固定不再變 ——
// 所以歷史季抓過就跳過,當季每次都重抓。
// 失敗完全無害:build 與回測拿不到賠率就只是少一條「市場基準」線,其餘照常。
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOddsCsv, upcomingOdds } from './lib/odds.mjs';
import { loadTeams } from './lib/teams.mjs';
import { CURRENT_SEASON } from './lib/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'raw', 'football-data-couk');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];

// '2025-26' → '2526'
const fdCode = s => { const [a, b] = s.split('-'); return a.slice(2) + b; };
const url = season => `https://www.football-data.co.uk/mmz4281/${fdCode(season)}/E0.csv`;

// 要哪幾季:回測用的訓練+測試季,加上進行中的當季
const SEASONS = [...new Set([...(arg('season') ? [arg('season')] : ['2023-24', '2024-25', '2025-26']), CURRENT_SEASON])];

async function main() {
  const T = loadTeams(ROOT);
  await mkdir(DIR, { recursive: true });
  console.log('▶ 抓 football-data.co.uk 英超賠率\n');

  for (const season of SEASONS) {
    const file = join(DIR, `${season}.csv`);
    const isPast = season !== CURRENT_SEASON;
    if (isPast && existsSync(file)) {
      // 歷史季固定,但空檔(上次抓失敗)還是要重試
      const prev = await readFile(file, 'utf8').catch(() => '');
      if (prev.length > 200) { console.log(`  · ${season} 已有,跳過`); continue; }
    }
    try {
      const res = await fetch(url(season), { headers: { 'user-agent': 'pl-war-room/1.0 (football analysis side project)' } });
      if (!res.ok) { console.log(`  ✗ ${season}:HTTP ${res.status}`); continue; }
      const text = await res.text();
      const { matches, unmatched, noOdds } = parseOddsCsv(text, { codeOf: T.codeOf });
      if (!matches.length) { console.log(`  ✗ ${season}:解析後 0 場,不覆蓋既有檔`); continue; }
      await writeFile(file, text);
      console.log(`  ✔ ${season}:${matches.length} 場有賠率`
        + (noOdds ? `・${noOdds} 場無賠率` : '')
        + (unmatched.length ? `・對不上隊名:${unmatched.join('、')}` : ''));
    } catch (e) {
      console.log(`  ✗ ${season}:${e.message}`);
    }
  }
  /* 未來賽事的賠率。本季的賽季檔要到賽季後段才發布(現在打 2627 是 HTTP 300),
     但 fixtures.csv 每天更新且含未開賽場次 —— 逐場的「模型 vs 市場」就靠它。 */
  try {
    const res = await fetch('https://www.football-data.co.uk/fixtures.csv',
      { headers: { 'user-agent': 'pl-war-room/1.0 (football analysis side project)' } });
    if (!res.ok) console.log(`  ✗ 未來賽事賠率:HTTP ${res.status}`);
    else {
      const text = await res.text();
      const r = upcomingOdds(text, { codeOf: T.codeOf });
      if (!r.count) {
        // 一場都解不出來時把表頭印出來,下次不用再猜欄位名稱
        console.log(`  ✗ 未來賽事賠率:解析後 0 場英超。表頭裡的賠率欄位:${(r.oddsColumns ?? []).join(',') || '(找不到)'}`);
      } else {
        await writeFile(join(DIR, 'fixtures.csv'), text);
        console.log(`  ✔ 未來賽事賠率:${r.count} 場英超`
          + (r.unmatched.length ? `・對不上隊名:${r.unmatched.join('、')}` : ''));
      }
    }
  } catch (e) { console.log(`  ✗ 未來賽事賠率:${e.message}`); }

  console.log('\n完成。回測會自動讀進來,產生「模型 vs 市場」的對照。');
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
