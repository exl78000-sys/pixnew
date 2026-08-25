#!/usr/bin/env node
// 抓西甲球員的整季數據(Understat)。
//
//   npm run laliga:players            # 只補還沒有的賽季
//   npm run laliga:players -- --force # 重抓
//
// 為什麼是 Understat 而不是 API-Football:
// 實測過(scripts/probe-laliga-players.mjs,GitHub Actions runner 上跑的),
// 手上這把 API-Football 金鑰是 **Free 方案,只開放 2022–2024**,
// league=140 的 2025 與 2026 兩季都回 plan 錯誤。整條路走不通。
//
// Understat 這條是第二輪探測找到的,關鍵在端點形狀:
//
//   POST https://understat.com/main/getPlayersStats/
//   body: league=La_liga&season=2025
//
// **一個請求就回整個聯賽一季的所有球員**(2025-26 是 600 筆)。
// 不是逐隊、更不是逐場 —— 使用者要求過不要大量抓取,這個形狀正好符合。
// 聯賽 HTML 頁(understat.com/league/La_liga/2025)只端 18 KB 的外殼、
// 一個資料變數都沒有,跟球隊 HTML 頁一樣;資料在這個獨立的 XHR 端點。
// 這正是 CLAUDE.md 記著的那個坑:探測失敗不等於資料不存在,先確認端點找對沒有。
//
// 回傳欄位(實測,不是憑印象):
//   id, player_name, games, time, goals, xG, assists, xA, shots, key_passes,
//   yellow_cards, red_cards, position, team_title, npg, npxG, xGChain, xGBuildup
//
// **界線**:Understat 是 xG 統計站。沒有背號、沒有頭貼、沒有傷停、沒有出生日期,
// 也沒有英超那套 FPL 的防守貢獻/BPS 欄位。這些西甲就是沒有 ——
// 前端要據實標示,不要為了跟英超版面對齊而留空欄位或補估計值。
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'raw', 'understat-la-liga');
const FORCE = process.argv.includes('--force');
const DELAY = 1500;

// Understat 用開季年份當 season:2025 = 2025-26。
// 本季也抓 —— 它會是「至今」的部分資料,那不是問題,標清楚就好。
const SEASONS = [
  { label: '2025-26', provider: 2025 },
  { label: '2026-27', provider: 2026 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const file = label => join(DIR, `${label}-players.json`);

async function fetchSeason(provider) {
  const url = 'https://understat.com/main/getPlayersStats/';
  const body = new URLSearchParams({ league: 'La_liga', season: String(provider) }).toString();
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST', body,
        signal: AbortSignal.timeout(30000),
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          referer: `https://understat.com/league/La_liga/${provider}`,
          'user-agent': 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)',
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      // 端點在參數不對時會回 {"error":{...}} 而不是 HTTP 錯誤碼 —— 只看 res.ok 會把失敗當成功
      if (j?.error) throw new Error(`端點回報 error_code ${j.error.error_code}`);
      const rows = Array.isArray(j) ? j : (j.players ?? j.response?.players ?? null);
      if (!Array.isArray(rows)) throw new Error(`回傳不是球員陣列(頂層鍵:${Object.keys(j ?? {}).join(',') || '無'})`);
      return rows;
    } catch (e) {
      last = e;
      if (attempt < 3) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw last;
}

async function main() {
  const T = loadTeams(ROOT, { file: 'teams-la-liga.json' });
  await mkdir(DIR, { recursive: true });

  let requests = 0;
  for (const { label, provider } of SEASONS) {
    if (!FORCE && existsSync(file(label))) {
      const prev = JSON.parse(await readFile(file(label), 'utf8'));
      // 本季會一直長,不能只看「檔案在不在」就跳過;上季完結了就不必重抓
      if (label !== SEASONS.at(-1).label) {
        console.log(`  · ${label} 已有 ${prev.players?.length ?? 0} 筆,跳過(加 --force 重抓)`);
        continue;
      }
    }
    if (requests) await sleep(DELAY);
    requests++;
    console.log(`▶ ${label}(Understat season=${provider})`);
    let rows;
    try {
      rows = await fetchSeason(provider);
    } catch (e) {
      // 本季開季初可能還沒有資料,那不是錯誤;上季抓不到才是問題
      console.log(`  ⚠ 抓不到:${e.message}`);
      continue;
    }

    /* 隊名要對得上我們的隊碼,對不上的**列出來**不要靜靜吞掉 ——
       CLAUDE.md 記著的坑:openfootball 的隊名跨季寫法不同,
       被 tolerant 模式吞掉之後整季資料消失,而畫面上看不出來。 */
    const unmatched = new Map();
    const players = rows.map(r => {
      const code = T.codeOf(r.team_title);
      if (!code) unmatched.set(r.team_title, (unmatched.get(r.team_title) ?? 0) + 1);
      return { ...r, code: code ?? null };
    });
    const matched = players.filter(p => p.code).length;
    console.log(`  ${players.length} 名球員・隊名對上 ${matched} 筆`);
    if (unmatched.size) {
      console.log(`  ⚠ 對不上隊名(要補進 data/manual/teams-la-liga.json 的 alias):`);
      for (const [name, n] of [...unmatched].sort((a, b) => b[1] - a[1])) console.log(`      ${name}(${n} 人)`);
    }

    await writeFile(file(label), JSON.stringify({
      season: label, providerSeason: provider,
      source: 'Understat',
      sourceUrl: 'https://understat.com/main/getPlayersStats/',
      note: 'POST league=La_liga&season=YYYY，整季一個請求。無背號、無頭貼、無傷停、無出生日期。',
      retrievedAt: new Date().toISOString(),
      count: players.length, matched,
      unmatchedTeams: Object.fromEntries(unmatched),
      players,
    }, null, 2) + '\n');
    console.log(`  ✔ ${file(label)}`);
  }
  console.log(`\n共用掉 ${requests} 個請求。`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
