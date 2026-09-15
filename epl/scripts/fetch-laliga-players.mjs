#!/usr/bin/env node
// 抓西甲球員的整季數據(Understat)。實作在 `lib/understat-players.mjs` —— 跟德甲**同一支**。
//
//   npm run laliga:players            # 只補還沒有的賽季
//   npm run laliga:players -- --force # 重抓
//
// 為什麼是 Understat 而不是 API-Football:
// 實測過(scripts/probe-laliga-players.mjs,GitHub Actions runner 上跑的),
// 手上這把 API-Football 金鑰是 **Free 方案,只開放 2022–2024**,
// league=140 的 2025 與 2026 兩季都回 plan 錯誤。整條路走不通。
//
// 端點形狀、各種守門與「界線」(沒有背號 / 頭貼 / 傷停 / 出生日期)都寫在共用那一份的檔頭。
// **抽出來的理由**:那些守門每一條都是踩過坑之後長出來的(200 + error 物件、
// 空陣列不算成功、隊名對不上要印出來、本季不能因為有檔就跳過)——
// 德甲複製一份過去的話,改了一邊另一邊會悄悄過期(CLAUDE.md 講過很多次的那條)。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchUnderstatPlayers } from './lib/understat-players.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Understat 用開季年份當 season:2025 = 2025-26。
// 本季也抓 —— 它會是「至今」的部分資料,那不是問題,標清楚就好。
await fetchUnderstatPlayers({
  root: ROOT,
  league: 'La_liga',                 // 底線、小寫 l —— 上游就是這樣寫的
  label: '西甲',
  teamFile: 'teams-la-liga.json',
  dir: 'understat-la-liga',
  seasons: [
    { label: '2025-26', provider: 2025 },
    { label: '2026-27', provider: 2026 },
  ],
  force: process.argv.includes('--force'),
  // 既有產物裡就是這一句,保持不變(抽共用的時候產物要逐欄位不變)
  note: 'POST league=La_liga&season=YYYY，整季一個請求。無背號、無頭貼、無傷停、無出生日期。',
});
