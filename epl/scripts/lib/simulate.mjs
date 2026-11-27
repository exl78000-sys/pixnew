import { lambdas } from './poisson.mjs';
import { runSeason } from '../../web/assets/js/season-sim.js';

// 蒙地卡羅模擬整季。
// 重點:每一次模擬都重新抽一組「球隊真實強度」,而不是只用點估計 —— 
// 否則會嚴重低估不確定性(模型會過度自信地把冠軍給某一隊)。

/* promotion:「前幾名直接升級」。英超與西甲沒有這個概念,不給就不算 ——
   輸出多一個欄位對它們沒有意義,而且會讓前端以為每個聯賽都有直升。
   英冠是前 2 直升、3~6 打附加賽,所以「前四」那一欄在那裡沒有意義,
   要換成「直升」才講得對。既有的 top4Pct / top6Pct 語意不變(就是 ≤4 與 ≤6),
   不去改它們的名字 —— 名字對得上值,是這個檔案最不該動的東西。

   promotionPlayoff:升級附加賽區的最後一名(英冠 6)→ `playoffPct` = 落在 promotion+1 ~ 這一名。
   **不要拿 top6Pct 當附加賽區**:它含直升的前 2 名。2026-09-26 前英冠的「附加賽區」就是這樣印的 ——
   標題寫「第 3~6 名」,而 WHU 印 99%,真正落在 3~6 名的機率是 20%。

   relegated:**直接**降級的名額。原本寫死「後 3 名」(`pos >= n - 2`),六個聯賽共用 ——
   德甲法甲只有後 2 名直接降級、第 16 名打跨聯賽附加賽,於是那兩個聯賽的「降級」
   一直是「後 3 名」的機率(漢堡 58%,其中直接降級 43%、第 16 名 15%),而資料界線寫的是「直接降級」。
   預設 3 是英超、西甲、英冠、義甲的規則;德義法共用的 build 一律要自己給(lib/build-league.mjs)。
   relegationPlayoff:直接降級的上一名要打附加賽 → `relegationPlayoffPct` = 落在那一名的機率。
   只給「打到這一名」,不給附加賽的勝負 —— 對手在次級聯賽,本站評不出強度(鐵則二)。

   這幾個參數只改「數哪幾名」,不多抽一個亂數:同一組 seed 跑出來的其餘欄位逐位元組不變。 */
/* 2026-11-27:迴圈本體搬到 web/assets/js/season-sim.js(瀏覽器的「如果…會怎樣」跑同一份)。這裡只負責從擬合的 model 拿 λ。
   `fixed` 是使用者指定的結果,建站不會給。 */
export function simulateSeason({ model, fixtures, codes, played = [], runs = 10000, seed = 20262027, promotion = null,
  promotionPlayoff = null, relegated = 3, relegationPlayoff = false, fixed = null }) {
  return runSeason({ lambdaOf: (h, a) => lambdas(model, h, a), fixtures, codes, played, runs, seed, promoted: model.promoted || [],
    promotion, promotionPlayoff, relegated, relegationPlayoff, fixed });
}
