#!/usr/bin/env node
/* 法甲(Ligue 1)資料集 → web/data/leagues/fr1/
 * 實作在 `lib/build-league.mjs` —— 跟德甲、義甲**同一支**,這裡只有法甲自己的參數。
 *
 *   npm run fr1:build
 *
 * ── 這個聯賽的來源都是實測過的,不是照抄德甲 ──
 * probe-new-leagues.mjs 在 CI runner 上跑過(2026-09-15):
 *   openfootball fr.1        四季各 306 場;**2025-26 有一場沒有比分**(305/306)——
 *                            那正是第二來源要補的那種,補比分走 lib/league-matches.mjs
 *   football-data.co.uk F1   欄位跟 D1 一模一樣
 *   Understat "Ligue_1"      2025-26 回 553 筆,欄位跟西甲那一組一個不少
 *   FotMob 聯賽 id 53        賽程 306 場、18 隊裡 15 隊對得上 openfootball、國家 FRA
 *                            取樣 Rennes 1-0 Marseille:五塊全有
 *
 * **對不上的那三個是上游的短名,不是挑錯聯賽**:Rennes / Lyon / Brest,
 * openfootball 的全名分別是 Stade Rennais FC 1901 / Olympique Lyonnais / Stade Brestois 29
 * —— 三個都跟短名一個共同 token 都沒有(CLAUDE.md「兩份名單對照只比全名會整隊漏掉」那條坑,
 * 法甲一次出現三個)。alias 已經補進名冊,而**一對一不是證據**:
 * build 另外拿逐隊進球跟積分榜對帳,對不上的會印出來。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLeague } from './lib/build-league.mjs';

await buildLeague({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  key: 'fr1', zh: '法甲', competition: 'fra.1',
  rawDir: 'openfootball-ligue-1', fillDir: 'football-data-couk-ligue-1', div: 'F1',
  understatDir: 'understat-ligue-1', fotmobDir: 'fotmob-ligue-1',
  teamFile: 'teams-ligue-1.json', crestFile: 'crests-ligue-1.json',
  /* 法國是 Europe/Paris:夏令 CEST(+02:00)、冬令 CET(+01:00)。 */
  timezone: { summer: '+02:00', winter: '+01:00' },
  lastSeason: '2025-26', currentSeason: '2026-27', priorSeasons: ['2023-24', '2024-25'],
  fotmobId: 53, rounds: 34, backtestFile: 'backtest-ligue-1.json',
  relegation: '法甲的升降級:後 2 名直接降級,第 16 名跟法乙第 3 名打附加賽 —— 那是「跨聯賽」的比賽,'
    + '本站沒有法乙的資料評不出對手強度,所以模擬只給冠軍 / 前四 / 直接降級,不給附加賽的勝負機率',
});
