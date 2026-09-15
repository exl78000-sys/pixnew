#!/usr/bin/env node
/* 義甲(Serie A)資料集 → web/data/leagues/it1/
 * 實作在 `lib/build-league.mjs` —— 跟德甲、法甲**同一支**,這裡只有義甲自己的參數。
 *
 *   npm run it1:build
 *
 * ── 這個聯賽的來源都是實測過的,不是照抄德甲 ──
 * probe-new-leagues.mjs 在 CI runner 上跑過(2026-09-15):
 *   openfootball it.1        四季各 380 場,2023-24 ~ 2025-26 全部有比分(沙箱直接驗的)
 *   football-data.co.uk I1   欄位跟 D1 一模一樣(HS/AST/HC/HY/HR 與賠率都在)
 *   Understat "Serie_A"      2025-26 回 586 筆,欄位跟西甲那一組一個不少
 *   FotMob 聯賽 id 55        賽程 380 場、20 隊裡 19 隊對得上 openfootball、國家 ITA
 *                            取樣 Genoa 0-0 Lecce:stats / shotmap / lineup / events / playerStats 全有
 *
 * **id 55 是證明出來的不是查到的**:義大利自己有 Serie B(86)與女足 Serie A(10178),
 * 而且**巴西也有 Serie A** —— 照名字挑會挑到別的聯賽,而它照樣回得出 20 隊與逐場資料,
 * 畫面不會報錯、只是整個聯賽是錯的。判準是隊數吻合 + 國家碼 + 逐隊比對。
 *
 * ── 義甲的升降級跟德甲法甲不一樣 ──
 * **後 3 名直接降級,沒有附加賽。** 德甲與法甲的第 16 名要打跨聯賽附加賽,
 * 照抄過來就是在畫面上印一個義甲沒有的制度。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLeague } from './lib/build-league.mjs';

await buildLeague({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  key: 'it1', zh: '義甲', competition: 'ita.1',
  rawDir: 'openfootball-serie-a', fillDir: 'football-data-couk-serie-a', div: 'I1', ofCode: 'it.1',
  understatDir: 'understat-serie-a', fotmobDir: 'fotmob-serie-a',
  teamFile: 'teams-serie-a.json', crestFile: 'crests-serie-a.json',
  /* 義大利是 Europe/Rome:夏令 CEST(+02:00)、冬令 CET(+01:00)—— 跟德國同一個時區。 */
  timezone: { summer: '+02:00', winter: '+01:00' },
  lastSeason: '2025-26', currentSeason: '2026-27', priorSeasons: ['2023-24', '2024-25'],
  fotmobId: 55, rounds: 38, backtestFile: 'backtest-serie-a.json',
  relegation: '義甲的升降級:後 3 名直接降級,沒有附加賽 —— 跟德甲法甲不一樣,'
    + '那兩個聯賽的第 16 名還要跟次級聯賽第 3 名打跨聯賽附加賽,義甲沒有這一關',
});
