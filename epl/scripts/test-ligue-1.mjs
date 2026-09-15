#!/usr/bin/env node
/* 法甲資料邊界測試。實作在 `lib/test-league.mjs` —— 跟德甲、義甲**同一支**,
 * 這裡只有法甲自己的參數。為什麼共用、守的是哪幾件事,看那一支的檔頭。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLeague } from './lib/test-league.mjs';

testLeague({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  key: 'fr1', zh: '法甲',
  rawDir: 'openfootball-ligue-1', fillDir: 'football-data-couk-ligue-1', ofCode: 'fr.1', div: 'F1',
  teamFile: 'teams-ligue-1.json',
  seasons: ['2023-24', '2024-25', '2025-26', '2026-27'],
  /* 法國是 Europe/Paris,跟德國義大利同一個時區(CET/CEST)。 */
  timezone: { summer: '+02:00', winter: '+01:00' },
  /* 法甲跟德甲一樣有跨聯賽附加賽,但對手是**法乙**第 3 名 —— 界線那句話要提到法乙,
     不然讀者不知道那一關是跨聯賽的、也就不知道本站為什麼不給它機率。 */
  relegationHint: /法乙.*附加賽/u,
});
