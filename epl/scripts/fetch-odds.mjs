#!/usr/bin/env node
// 抓 football-data.co.uk 的賠率 CSV → data/raw/football-data-couk{-la-liga}/{season}.csv
//
//   npm run odds                     抓英超回測要用的那幾季
//   npm run odds -- --season=2025-26  只抓某一季
//   npm run laliga:odds               同樣的事,但抓西甲(SP1)
//   npm run laliga:odds -- --names    **只印出上游的隊名,不寫檔**
//
// --names 存在的理由:這個站的西甲隊名拼法本站沒見過,而**猜拼法就是編資料**。
// 沙箱連不到外網(CLAUDE.md §四),所以先在 runner 上跑 --names 把真正的字串印出來,
// 再照著寫對照表 —— 不要憑印象填一張看起來很合理的表。
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
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const NAMES_ONLY = process.argv.includes('--names');

const LEAGUE = arg('league') === 'es1' ? 'es1' : 'pl';
const CFG = LEAGUE === 'es1'
  ? { label: '西甲', div: 'SP1', dir: 'football-data-couk-la-liga',
      teamsFile: 'teams-la-liga.json', seasons: ['2024-25', '2025-26'], current: '2026-27' }
  : { label: '英超', div: 'E0', dir: 'football-data-couk',
      teamsFile: null, seasons: ['2023-24', '2024-25', '2025-26'], current: CURRENT_SEASON };
const DIR = join(ROOT, 'data', 'raw', CFG.dir);

// '2025-26' → '2526'
const fdCode = s => { const [a, b] = s.split('-'); return a.slice(2) + b; };
const url = season => `https://www.football-data.co.uk/mmz4281/${fdCode(season)}/${CFG.div}.csv`;

// 要哪幾季:回測用的訓練+測試季,加上進行中的當季
const SEASONS = [...new Set([...(arg('season') ? [arg('season')] : CFG.seasons), CFG.current])];

async function main() {
  const T = loadTeams(ROOT, CFG.teamsFile ? { file: CFG.teamsFile } : undefined);
  await mkdir(DIR, { recursive: true });
  console.log(`▶ 抓 football-data.co.uk ${CFG.label}賠率(${CFG.div})\n`);

  /* --names:只把上游實際用的隊名列出來,一個字都不寫進倉庫。
     對得上的與對不上的分開列,對不上的那批就是要補進對照表的字串。 */
  if (NAMES_ONLY) {
    for (const season of SEASONS) {
      try {
        const res = await fetch(url(season), { headers: { 'user-agent': 'pl-war-room/1.0 (football analysis side project)' } });
        if (!res.ok) { console.log(`  ✗ ${season}:HTTP ${res.status}`); continue; }
        const text = await res.text();
        const r = parseOddsCsv(text, { codeOf: T.codeOf, div: CFG.div });
        const ok = new Set();
        for (const m of r.matches) { ok.add(m.home); ok.add(m.away); }
        console.log(`  ${season}:對得上 ${ok.size} 隊 / 解出 ${r.matches.length} 場`);
        if (r.unmatched.length) {
          console.log(`    對不上的上游隊名(${r.unmatched.length} 個),照抄下面這幾行去補對照表:`);
          for (const n of r.unmatched.sort()) console.log(`      ${JSON.stringify(n)}`);
        }
      } catch (e) { console.log(`  ✗ ${season}:${e.message}`); }
    }
    console.log('\n(--names 模式:沒有寫入任何檔案)');
    return;
  }

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
      const { matches, unmatched, noOdds } = parseOddsCsv(text, { codeOf: T.codeOf, div: CFG.div });
      if (!matches.length) { console.log(`  ✗ ${season}:解析後 0 場,不覆蓋既有檔`); continue; }
      /* 隊名對不上會讓那些比賽**靜靜消失**在回測母體外 —— 分母變小卻沒人知道,
         正是本專案最怕的那種錯。一整季 380 場,少於 300 場就一定是對照表壞了,
         這種時候寧可不寫,也不要產生一份看起來正常的殘缺資料。 */
      if (matches.length < 300 && season !== CFG.current) {
        console.log(`  ✗ ${season}:只解出 ${matches.length} 場(應該接近 380),不寫入。`
          + (unmatched.length ? ` 對不上的隊名:${unmatched.join('、')}` : ''));
        continue;
      }
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
      const r = upcomingOdds(text, { codeOf: T.codeOf, div: CFG.div });
      if (!r.count) {
        // 一場都解不出來時把表頭印出來,下次不用再猜欄位名稱
        console.log(`  ✗ 未來賽事賠率:解析後 0 場${CFG.label}。表頭裡的賠率欄位:${(r.oddsColumns ?? []).join(',') || '(找不到)'}`);
      } else {
        // fixtures.csv 是全歐洲混在一起的一份檔,兩個聯賽各存一份到自己的目錄
        await writeFile(join(DIR, 'fixtures.csv'), text);
        console.log(`  ✔ 未來賽事賠率:${r.count} 場${CFG.label}`
          + (r.unmatched.length ? `・對不上隊名:${r.unmatched.join('、')}` : ''));
      }
    }
  } catch (e) { console.log(`  ✗ 未來賽事賠率:${e.message}`); }

  console.log('\n完成。回測會自動讀進來,產生「模型 vs 市場」的對照。');
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
