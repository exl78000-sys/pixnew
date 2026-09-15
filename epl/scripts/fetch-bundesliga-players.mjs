#!/usr/bin/env node
/* 抓德甲球員的整季數據(Understat)。實作在 `lib/understat-players.mjs` —— 跟西甲**同一支**。
 *
 *   npm run de1:players            # 只補還沒有的賽季
 *   npm run de1:players -- --force # 重抓
 *
 * ── 這一支為什麼存在,以及為什麼它只能在 runner 上跑 ──
 * 德甲是 Understat 涵蓋的五大聯賽之一,所以德甲的球員層是**還沒抓**,不是拿不到 ——
 * 這跟英冠那種「Understat 不涵蓋這個聯賽」(實測過的否定,永遠不會有)完全不同,
 * 畫面上要分得出來。抓不到的原因只有一個:開發沙箱的出口代理不放行 understat.com
 * (2026-09-15 實測 CONNECT 403)。在 CI runner 上跑同一支就會成功。
 *
 * ── 聯賽代號與隊名都是**實測**來的,不是猜的 ──
 * `probe-understat-bundesliga.mjs` 在 runner 上跑過(2026-09-15):
 *   - 代號是 `Bundesliga`(候選逐一試出來的;猜錯的話端點回 200 + error 物件或空陣列,
 *     不會拋錯 —— 英冠那次四種寫法全回空陣列)
 *   - 欄位跟西甲那一組**一個不少**,所以下游照用
 *   - 2025-26 回 499 筆、2026-27 回 357 筆,兩季都有
 *   - **隊名 26 個裡只對上 11 個**:上游用短名(Hoffenheim / RasenBallsport Leipzig /
 *     Borussia M.Gladbach / FC Cologne / Freiburg / Wolfsburg / FC Heidenheim),
 *     那 7 個的 alias 已經逐字補進名冊(來歷寫在 teams-bundesliga.json 的 _understat)。
 *     剩下的是**季中轉隊**那種逗號串起來的兩隊名,共用那一支會拆開存進 codes。
 *
 * 一季一個請求(整個聯賽的所有球員一次回完),符合「不要大量爬網站」。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchUnderstatPlayers } from './lib/understat-players.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Understat 用開季年份當 season:2025 = 2025-26。清單的**最後一個**視為本季(會一直長,所以每次都重抓)。
await fetchUnderstatPlayers({
  root: ROOT,
  league: 'Bundesliga',
  label: '德甲',
  teamFile: 'teams-bundesliga.json',
  dir: 'understat-bundesliga',
  seasons: [
    { label: '2025-26', provider: 2025 },
    { label: '2026-27', provider: 2026 },
  ],
  force: process.argv.includes('--force'),
  note: 'POST league=Bundesliga&season=YYYY，整季一個請求。無背號、無頭貼、無傷停、無出生日期。',
});
