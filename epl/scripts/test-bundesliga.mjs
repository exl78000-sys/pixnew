#!/usr/bin/env node
/* 德甲資料邊界測試。實作在 `lib/test-league.mjs` —— 跟義甲、法甲**同一支**,
 * 這裡只有德甲自己的參數。為什麼共用、守的是哪幾件事,看那一支的檔頭。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testLeague } from './lib/test-league.mjs';

testLeague({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  key: 'de1', zh: '德甲',
  rawDir: 'openfootball-bundesliga', fillDir: 'football-data-couk-bundesliga', ofCode: 'de.1', div: 'D1',
  teamFile: 'teams-bundesliga.json',
  seasons: ['2023-24', '2024-25', '2025-26', '2026-27'],
  timezone: { summer: '+02:00', winter: '+01:00' },
  /* 德甲的第 16 名跟**德乙**第 3 名打附加賽 —— 界線那句話一定要提到德乙,
     不然讀者不知道那一關是跨聯賽的、也就不知道本站為什麼不給它機率。 */
  relegationHint: /德乙.*附加賽/u,
});
