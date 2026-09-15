#!/usr/bin/env node
/* 義甲資料邊界測試。實作在 `lib/test-league.mjs` —— 跟德甲、法甲**同一支**,
 * 這裡只有義甲自己的參數。為什麼共用、守的是哪幾件事,看那一支的檔頭。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLeague } from './lib/test-league.mjs';

testLeague({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  key: 'it1', zh: '義甲',
  rawDir: 'openfootball-serie-a', fillDir: 'football-data-couk-serie-a', ofCode: 'it.1', div: 'I1',
  teamFile: 'teams-serie-a.json',
  seasons: ['2023-24', '2024-25', '2025-26', '2026-27'],
  /* 義大利是 Europe/Rome,跟德國同一個時區(CET/CEST)。 */
  timezone: { summer: '+02:00', winter: '+01:00' },
  /* **義甲沒有附加賽** —— 後 3 名直接降級。德甲法甲那句「第 16 名跟次級聯賽第 3 名打附加賽」
     抄過來就是在畫面上印一個義甲沒有的制度,所以這裡守的是相反的那一句。 */
  relegationHint: /後 3 名直接降級.*沒有附加賽/u,
});
