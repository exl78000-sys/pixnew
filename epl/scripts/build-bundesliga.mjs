#!/usr/bin/env node
/* 德甲(Bundesliga)資料集 → web/data/leagues/de1/
 * 實作在 `lib/build-league.mjs` —— 跟義甲、法甲**同一支**,這裡只有德甲自己的參數。
 *
 *   npm run de1:build
 *
 * ── 這個聯賽現在做得到什麼、做不到什麼 ──
 * 三層都有:球隊(openfootball + football-data.co.uk D1)、球員(Understat)、
 * 比賽(FotMob 聯賽 id 54,賽後報告 + 逐場統計)。隊徽 18/18。
 * **還沒有**的是隊色、城市、球場、教練、傷停與即時比分。
 *
 * 球員層缺的理由跟英冠**不一樣**,不要照抄英冠那句話:
 *   英冠是「Understat 不涵蓋這個聯賽」(實測過的否定,永遠不會有)。
 *   德甲**是**五大聯賽之一,Understat 有它 —— 只是開發沙箱的出口代理不放行
 *   understat.com(2026-09-15 實測 CONNECT 403),所以要在 CI runner 上抓。
 * 「還沒抓」與「拿不到」對讀者的意義完全不同(鐵則三與鐵則四)。
 *
 * ── 隊名對照 ──
 * `data/manual/teams-bundesliga.json` 的 `of` / `fd` 兩欄都是**從真實資料掃出來的**,
 * 不是憑印象填的(檔案的 _note 寫了怎麼來的)。build 會把對不上的隊名印出來。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLeague } from './lib/build-league.mjs';

await buildLeague({
  root: join(dirname(fileURLToPath(import.meta.url)), '..'),
  key: 'de1', zh: '德甲', competition: 'ger.1',
  rawDir: 'openfootball-bundesliga', fillDir: 'football-data-couk-bundesliga', div: 'D1',
  understatDir: 'understat-bundesliga', fotmobDir: 'fotmob-bundesliga',
  teamFile: 'teams-bundesliga.json', crestFile: 'crests-bundesliga.json',
  /* 德國是 Europe/Berlin:夏令 CEST(+02:00)、冬令 CET(+01:00)。 */
  timezone: { summer: '+02:00', winter: '+01:00' },
  lastSeason: '2025-26', currentSeason: '2026-27', priorSeasons: ['2023-24', '2024-25'],
  fotmobId: 54, rounds: 34, backtestFile: 'backtest-bundesliga.json',
  /* **升降級規則是這個聯賽的事實,不可以照抄別的聯賽。** */
  relegation: '德甲的升降級:後 2 名直接降級,第 16 名跟德乙第 3 名打附加賽 —— 那是「跨聯賽」的比賽,'
    + '本站沒有德乙的資料評不出對手強度,所以模擬只給冠軍 / 前四 / 直接降級,不給附加賽的勝負機率',
});
