#!/usr/bin/env node
/* 抓義甲球員的整季數據(Understat)。實作在 `lib/understat-fetch.mjs` —— 跟西甲德甲**同一支**。
 *
 *   npm run it1:players            # 只補還沒有的賽季
 *   npm run it1:players -- --force # 重抓
 *
 * ── 聯賽代號是**實測**來的,不是猜的 ──
 * `probe-new-leagues.mjs` 在 CI runner 上跑過(2026-09-15):
 *   - 代號是 `Serie_A`(候選逐一試出來的;猜錯的話端點回 200 + error 物件或空陣列,
 *     不會拋錯 —— 英冠那次四種寫法全回空陣列)
 *   - 欄位跟西甲那一組**一個不少**,所以下游照用
 *   - 2025-26 回 586 筆
 *
 * 抓不到的原因只有一個:開發沙箱的出口代理不放行 understat.com(實測 CONNECT 403)。
 * 在 CI runner 上跑同一支就會成功 —— 所以義甲的球員層是「還沒抓」,不是「拿不到」。
 *
 * 一季一個請求(整個聯賽的所有球員一次回完),符合「不要大量爬網站」。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchUnderstatPlayers } from './lib/understat-fetch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Understat 用開季年份當 season:2025 = 2025-26。清單的**最後一個**視為本季(會一直長,所以每次都重抓)。
await fetchUnderstatPlayers({
  root: ROOT,
  league: 'Serie_A',
  label: '義甲',
  teamFile: 'teams-serie-a.json',
  dir: 'understat-serie-a',
  seasons: [
    { label: '2025-26', provider: 2025 },
    { label: '2026-27', provider: 2026 },
  ],
  force: process.argv.includes('--force'),
  note: 'POST league=Serie_A&season=YYYY，整季一個請求。無背號、無頭貼、無傷停、無出生日期。',
});
