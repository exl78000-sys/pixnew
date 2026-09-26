/* npm test 的步驟清單(2026-09-26 從 test-all.mjs 抽出來)。

   為什麼抽:部署 workflow 要「五個聯賽的走查回測並行跑」(backtest-all.mjs),而哪些步驟是回測、
   哪些是驗回測的測試,只能有**一份**清單 —— 兩邊各寫一份的話,加第七個聯賽時漏了一邊就靜靜少跑一個
   (「聯賽清單有三份」那條坑)。test-all 跑全部,backtest-all 只挑 isBacktestStep 的那幾支。

   順序不能動:backtest-laliga 產生的數字是 test-laliga 要驗的。

   後面幾步是 2026-08-28 起陸續補的:
   - check-docs  文件裡的數字對不對得回實際資料(手動維護一定會歪,實測過三份三個數)
   - obsidian    vault 的產生器自己有兩道守門(同檔名、壞連結),但**沒有任何流程在跑它** ——
                 資料結構一變會安靜壞掉,要等有人手動跑 local:sync 才發現。
                 寫到暫存目錄,不動使用者真正在用的那一份(他可能正開著 Obsidian)。
   - test-vault  vault 的**內容**(2026-09-26):產生器的守門只看形狀,筆記裡印著過期的宣稱、
                 或者少了一整區資料,它都照樣放行。這一支自己產一份到暫存目錄,逐則拿筆記跟產物對。 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const VAULT_TMP = join(tmpdir(), 'epl-vault-test');

export const STEPS = [
  ['scripts/test.mjs', []],
  ['scripts/backtest-laliga.mjs', []],
  ['scripts/test-laliga.mjs', []],
  /* 英冠同理:backtest-championship 產生的數字是 test-championship 要驗的,順序不能反。 */
  ['scripts/backtest-championship.mjs', []],
  ['scripts/test-championship.mjs', []],
  /* 德甲(2026-09-15 加的第四個聯賽)同理:backtest-bundesliga 產生的數字是
     test-bundesliga 要驗的,順序不能反。 */
  ['scripts/backtest-bundesliga.mjs', []],
  ['scripts/test-bundesliga.mjs', []],
  /* 義甲與法甲(2026-09-15 加的第五、六個聯賽)同理:backtest 產生的數字是 test 要驗的,
     順序不能反。三個聯賽的 test 都只是 `lib/test-league.mjs` 的薄包裝。 */
  ['scripts/backtest-serie-a.mjs', []],
  ['scripts/test-serie-a.mjs', []],
  ['scripts/backtest-ligue-1.mjs', []],
  ['scripts/test-ligue-1.mjs', []],
  /* 國家隊(2026-09-24):只讀產物與 raw,不產生別的測試要驗的數字;抓取器那一段用假的 fetch,不連網。 */
  ['scripts/test-intl.mjs', []],
  /* 模擬遊玩(2026-09-03):獨立管線的守門 + 側寫對回來源 + 引擎不變量。
     排在英冠之後、文件檢查之前 —— 它只讀產物,不產生別的測試要驗的數字。 */
  ['scripts/game/test-game.mjs', []],
  ['scripts/check-docs.mjs', []],
  ['scripts/build-obsidian.mjs', [`--out=${VAULT_TMP}`]],
  ['scripts/test-vault.mjs', []],
];

/* 「這一步是走查回測」= 檔名 backtest-*.mjs。英超的走查回測在 test.mjs 裡,它的斷言直接吃回測的結果,
   拆不開,所以不算在這裡 —— workflow 想並行的是五個獨立聯賽的那幾支。 */
export const isBacktestStep = ([file]) => /\/backtest-[\w-]+\.mjs$/.test(file);

/* 「這一步是模擬引擎的測試」。2026-09-26 逐步計時:npm test 462 秒裡它一支就佔 422 秒(五個聯賽回測合計 10 秒)。
   它只讀倉庫裡的程式、產物與 raw,不需要 build job 剛抓的東西 —— 部署 workflow 另開一個 job 跟 build 並行跑它,
   build 那邊的 npm test 帶 --skip-game。 */
export const isGameStep = ([file]) => file === 'scripts/game/test-game.mjs';
