#!/usr/bin/env node
/* 英冠(EFL Championship)的兩個來源 → data/raw/。實作在 `lib/league-fetch.mjs` ——
 * 跟德甲、義甲、法甲**同一支**,這裡只有英冠自己的參數。
 *
 *   openfootball/football.json  en.2.json   賽程 + 賽果 + 半場比分 + 輪次 + 升級附加賽
 *   football-data.co.uk         E1.csv      賽果 + 射門/射正/角球/犯規/牌 + 賠率
 *
 *   npm run en2:fetch
 *
 * ── 兩邊固定差 5 場,那不是缺漏 ──
 * 2026-08-28 實測:openfootball 2023-24 / 2024-25 / 2025-26 各 557 場,而 E1 各 552。
 * 差的 5 場是**升級附加賽**(準決賽 4 + 決賽 1),E1 只收聯賽。不要當成缺漏去補 ——
 * 而且附加賽會讓「主隊|客隊」這個鍵在同一季撞號,build 端有 stageOf 專門處理。
 *
 * 這個聯賽**沒有球員層級的免費整季來源**(Understat 不涵蓋、FPL 只有英超,兩者都實測過),
 * 所以這兩份就是它全部的比賽層資料 —— 鐵則五要求的獨立核對只能靠它們互相比。
 * (球員層 2026-09-15 起改由 FotMob 逐場逐人統計累加而來,那是另一條路,不走這一支。)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLeagueSources } from './lib/league-fetch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

await fetchLeagueSources({
  root: ROOT, zh: '英冠', ofCode: 'en.2', fdDiv: 'E1',
  ofDir: 'openfootball-championship', fdDir: 'football-data-couk-championship',
  /* 本季與上季是必要的(少了就建不了站)。再往前兩季是選配:走查回測要「用前面的季訓練、
     在後面的季驗收」,拿不到就是回測跑不起來 —— 那要照實擋下,不是硬跑出一個數字。 */
  required: ['2025-26', '2026-27'],
  optional: ['2023-24', '2024-25'],
  minMatches: 500,          // 24 隊 × 46 輪 = 552 場排完
  /* 英冠**沒有第三個來源**,第二來源拿不到就一個核對都做不了 —— 所以必要季擋下來。
     德甲義甲法甲設 false,因為它們的必要季在沙箱本來就抓不到那個網域。 */
  fdRequired: true,
  legacyDir: null,          // 倉庫的 football-data-couk-extra 沒有 E1
});
