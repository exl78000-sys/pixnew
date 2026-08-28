# 英超戰情室 —— 給接手 AI 助手的常駐規則

專案在 `epl/`。這份是**工作規則**;專案在做什麼看 `epl/README.md`,
這個時間點的狀態看 `epl/docs/接手資訊.md`,
**接下來要做什麼看 `epl/docs/補齊規劃.md`**(唯一一份待辦,不要在別處再開一份)。

**已經是兩個聯賽**:英超(根目錄的資料集)與西甲(`web/data/leagues/es1/`)。
新增聯賽的做法看 `scripts/build-laliga.mjs` 與 `scripts/test-laliga.mjs`。

---

## 一、鐵則(違反的話,做出來的東西整個沒有價值)

這個專案的賣點不是功能多,是**每個數字都查得到出處**。以下五條沒有例外。

### 1. 不准編數字

任何顯示在頁面上的數值,都必須是從真實資料算出來的。
不准用 LLM 猜、不准用「合理的估計值」填空、不准為了畫面好看造一個範例值。

AI 報告層(`epl/scripts/lib/report/`)有一道驗證器:文章裡出現的每個數字都要能對回
feature bundle,對不上整篇退回制式模板。**不要繞過它。**

### 2. 沒有回測證據就不進模型

想加一個預測特徵?先證明它有用:
- 調參與驗收要用**不同賽季**。同一批資料又調又驗,挑出來的一定是雜訊。
- 改善幅度要**大過成對比較的標準誤**,不然只是換一批比賽就會翻盤的波動。
- 參考 `npm run tune:form` 的做法。

已經量過而**沒有通過**的:近五戰狀況、近五戰進失球、歷來交手淨勝球。
它們的係數是 0(`epl/scripts/lib/form.mjs` 的 `TUNED`),只當資訊顯示。
`npm test` 有一條專門守著:套用之後 λ 必須一模一樣。**不要因為「直覺上應該有用」就打開。**

### 3. 拿不到的資料就不做,也不留空欄位

留一個永遠空白的欄位,比不做更糟 —— 讀者會以為是壞掉。

但**「探測失敗」不等於「資料不存在」**,這一條我親自踩過:

我曾經在這裡寫「進球方式(運動戰/角球/任意球)沒有免費來源,不做」,
理由是探測 `understat.com/team/Arsenal/2025` 回了 200 但解析不到資料變數。
**那是我端點找錯了** —— 資料在 `understat.com/getTeamData/{隊名}/{年份}`,
是獨立的 JSON 端點,不是嵌在球隊 HTML 頁裡。

現在英超與西甲的進球情境資料都已經在倉庫裡
(`data/raw/understat/` 與 `data/raw/understat-la-liga/`),
分成 `OpenPlay / FromCorner / SetPiece / DirectFreekick / Penalty` 五類,
而且核對過:Arsenal 五類相加 71 球等於該季總進球,角球 19 球對得上官網文章。

**但界線要守住:能做的是「球隊整季的分類」,不是「這一球是怎麼進的」。**
Understat 給的是球隊層級的季摘要,把某一類掛到某位球員的某一顆球是我們沒有的資料。
所以球員的逐球表**不要**加「進球方式」欄位,球隊整季分類放獨立面板。

**教訓:斷言某個資料拿不到之前,先確認自己試的是不是對的端點。**
真的確定拿不到再寫進這裡,而且要寫清楚試過什麼、用的是哪個網址。

### 4. 資料的不確定性要寫在畫面上

人工維護的、可能過期的、樣本不足的、推論而非實測的 —— 全部要標。
既有做法可參考:教練名冊的鮮度提醒、升班馬的「聯盟後段先驗」說明、
攻守分型的「這是推論,官方沒有這個東西」、模型頁的「測過但沒有進模型的特徵」。

### 5. 外部抽取的資料一定要用獨立來源核對

協作方自己回報「檢查全過」不算數。實際踩過:
交回來的進球明細自報 `scoreMismatches: 0`,但拿 openfootball 的賽果
(跟 FPL 完全獨立)逐場核對,2024-25 有 15 場、2025-26 有 24 場對不上。

---

## 二、會靜靜出錯的陷阱(每一條都真的踩過)

這些不會拋錯,只會給出錯的答案。

| 陷阱 | 症狀 | 正解 |
|---|---|---|
| `players_raw.csv` 是**季末快照** | 中途轉隊的人,整季的球記到新東家(Rashford 替曼聯進的 2 球變成維拉的) | 逐場資料要用逐場欄位。球員隊伍從 `opponent_team` + `was_home` + 賽程反推 |
| FPL 的 `element` 與 `opponent_team` **每季重新編號** | 用錯季的對照表 → 對手全錯 | 一定要用**同一季**的 `players_raw.csv` / `teams.csv` |
| FPL 的 `round` 是 **gameweek**,不是賽程輪次 | 改期的比賽對不上(AVL vs LIV:FPL GW25、賽程第 29 輪) | 配對用**日期優先**、輪次備援 |
| 官方 event 的 `type` 是**代碼**不是英文字 | 用 `/goal/i` 比對 → 一顆進球都抓不到 | 型別是 `G`/`B`/`S`/`PS`/`PE` |
| **烏龍球不是 `G` 事件** | 只認 `G` → 少算(Brighton 4-0 Aston Villa 只抓到 3 顆) | 用「**比分變了就是進球**」判定,不看型別 |
| 烏龍球事件的 `teamId` 語意不明確 | 實測一例是**得分方**(Lindelöf 替維拉踢進烏龍,teamId 卻是 Brighton),但樣本只有一個,不要當通則 | 別依賴 `teamId`。得分方一律由**比分差**決定,`goalsOf()` 就是這樣寫的 |
| openfootball 的隊名寫法**跨季不同** | `Manchester United` vs `Manchester United FC` → 整季資料被 tolerant 模式吞掉 | `codeOf` 已有寬鬆比對;tolerant 模式會把跳過的隊名印出來,**要看那行輸出** |
| FPL 的球隊 `short_name` 恰好等於本專案隊碼 | —— | 這是驗證過的,20 隊全對,可以直接用 |
| `versus()` 的「越低越好」取倒數 | 值是 0 時 1/0 爆掉,對面壓成一根針 | 分母加同量級緩衝(已修,有測試守著) |
| **同一次瀏覽裡一頁新版面、一頁舊版面** | 在導覽列點來點去,有時候跳成上一版的排版 —— 因為 GitHub Pages 給 HTML 的快取是十分鐘而且**每個檔案各自計時**,index.html 可能是舊的、teams.html 剛好過期換新的 | `stamp-assets.mjs` 把戳寫進 `meta.json` 的 `assets`,`core.js` 從 `import.meta.url` 讀自己的戳比對,對不上就重載一次(sessionStorage 記號防無限重載) |
| **import 那一行帶著版本戳** | 用字面字串 `from './core.js'` 做 replace **靜靜沒命中**;程式呼叫了沒 import 的東西 → 頁面顯示「載入失敗」,而 `npm test` 全綠(測試檢查不到版面) | `stamp-assets.mjs` 會把 import 改成 `from './core.js?v=abcd1234'`。改 import 那幾行一律用正則 `from '\./x\.js(\?v=[0-9a-f]{8})?'`,而且 replace 之後要斷言真的有命中 |
| 頁面切換後計時器沒清 | 舊頁面 30 秒後覆蓋 `#app`,看起來像「自動跳回去」 | 用 `C.pageInterval()`,不要裸 `setInterval` |
| Understat 的資料**不在 HTML 頁裡**(球隊頁與聯賽頁都是) | 抓 `/team/{隊}/{年}` 或 `/league/{聯賽}/{年}` 只回 18 KB 外殼,一個資料變數都沒有 | 球隊用 `/getTeamData/{隊}/{年}`;球員整季數據用 `POST /main/getPlayersStats/`,body 是 `league=La_liga&season=2025`,一個請求回整季 600 人 |
| **football-data.org 的 `fullTime` 在 PK 場是「累加值」不是比分** | 2025-26 歐冠決賽的 `fullTime` 是 `5-4`,實際上是 **1-1、PK 4-3** —— 直接印會把冠軍講錯 | 實測 6 場全部成立:`fullTime = regularTime + extraTime + penalties`。PK 場的比分要用 `regularTime + extraTime`,**不是 fullTime**。`duration` 是 `REGULAR` / `EXTRA_TIME` / `PENALTY_SHOOTOUT` |
| **FotMob 的比賽網址順序不是主客** | `/matches/{甲}-vs-{乙}/` 看起來像「甲是主隊」,實際上只有一半對得上(2024-25:35 對 / 36 反) | 主客看 `home` / `away` **欄位**(378 場全對、0 場反),網址只是 slug。照 slug 推會得到「這份資料一半的主客是錯的」這種完全錯誤的結論 |
| **兩份名單對照只比全名會整隊漏掉** | football-data 的 Inter 全名是 `FC Internazionale Milano`、Brest 是 `Stade Brestois 29`,跟另一邊的 `Inter` / `Brest` 一個共同 token 都沒有 | 全名與 **shortName 都要比**,取最好的一組。漏掉的那一隊會變成 10 場「隊名對不上」,交叉核對整份不通過 —— 看起來像資料錯,其實是對照表漏了 |
| **人工交付的明細與賽程涵蓋的比賽不同批** | 新賽果落地、逐球明細還沒跟上時,「逐隊進失球對回賽果」整條變紅,看起來像上游資料錯了 | 明細只收核對通過的場次,所以 `goals.json` 每季記 `matchKeys`(涵蓋哪幾場),核對限定在同一批比賽上 |
| API 回 **HTTP 200 加一個 error 物件** | 只看 `res.ok` 會把失敗當成功;排程每天跑、每天回報成功,實際一筆都沒抓到 | API-Football 看 `j.errors`、Understat 看 `j.error`。而且要分得出「暫時失敗」與「這個方案就是拿不到」,後者要記錄下來讓畫面講實話 |

---

## 三、怎麼驗證(每次改動都要跑)

```bash
cd epl
npm test          # 走查回測 + 13 個自我檢查區塊,零依賴
npm run build     # 產生 web/data/*.json
npm run bundle    # 產生單檔版 dist/warroom.html
```

進球事件的 `description` 子代碼目前已見過 **`G`(一般)、`P`(十二碼)、`O`(烏龍球)** ——
`O` 已用名單核對過(踢進的人在對方名單裡)。這三種已經在單場分析頁的
進球時間軸上顯示。**沒見過的代碼一律不給分類**,原碼留在 `kindRaw`,
測試有一條守著:正式資料裡出現第四種代碼就會紅,要先核對過才放行。

`npm test` 會跑**兩個聯賽**(`test.mjs` 英超 → `test-laliga.mjs` 西甲),
目前 20 個區塊、205 條斷言。涵蓋:走查回測、模型 vs 市場、即時勝率、AI 報告層、
真人專家觀點、API-Football 完賽資料、官方名單球員對照、隊名對照、賠率去水錢、
兩隊配色(702 組對戰的 ΔE 與對比)、近況特徵、傷停與拿牌、對照條長、
資料缺口判斷、官方進球事件解析、進球子類型、逐場進球明細、
Understat 進球情境、SportMonks 欄位與賽後資料轉換、西甲球隊數據。

**西甲的 `official.json`(逐場正式先發)與 `fixtures.json` 是兩份產物,要一起重跑。**
先發快取到的場次比 openfootball 賽果先落地時,只重跑其中一份會讓
「逐場對回比分」那條斷言紅掉 —— 看起來像供應商資料錯,其實是 `fixtures.json`
還停在舊的一份、沒把新落地的賽果算進去,於是逐場比對時賽程說「未賽」。
`npm run laliga:build` 一次產出兩份,不要單獨手動改任何一份。
(這條被一次 rebase 弄丟過,補回來。)

**跨聯賽的頁面只能有一份資料。** 足球知識與歐冠兩邊都看得到,
所以轉換邏輯收在 `scripts/lib/`(歐冠是 `lib/ucl.mjs`),
`build.mjs` 與 `build-laliga.mjs` **各呼叫一次同一個函式**,產出的 JSON 逐字元相同
(`npm test` 有一條守著)。複製一份轉換過去的話,改了一邊另一邊會悄悄過期。

**導覽列有兩份清單。** `SITE_PAGES` 是跨聯賽那一組(足球知識、歐冠),
`PAGES` 是這個聯賽那一組。**同一頁兩邊都放的話,導覽列會出現兩個一樣的分頁** ——
左邊一個、右邊一個,而且不會有任何地方報錯。實際踩過,測試補了一條。

**先跑 `laliga:build` 再跑 `build`。** `stamp-assets.mjs` 掛在 `npm run build` 的最後,
會把戳寫進**兩個聯賽**的 `meta.json`;反過來跑的話,`laliga:build` 會把 es1 的
`meta.json` 重寫掉、戳就不見了,`npm test` 的「meta 記的戳跟實際檔案一致」會紅。
(workflow 裡的順序本來就是對的,這條是給手動重跑的人看的。)

**資產有版本戳。** `npm run build` 會跑 `scripts/stamp-assets.mjs`,
依**內容雜湊**給 `web/*.html` 的 CSS/JS 與 JS 之間的 import 打上 `?v=`。
沒有它的話改版面部署上去,使用者會看到最難察覺的組合:
**meta.json 是新的、JS 是舊的** —— 頁尾顯示最新建置時間、版面卻是上一版。
手動改完前端沒重跑 build 的話,跑 `npm run stamp` 補上;`npm test` 有一節守著
「戳對不對得回檔案內容」。

**改前端一定要真的開來看。** 測試檢查不到版面 —— 用 Playwright 截圖
(`/opt/pw-browsers/chromium` 已裝好),分頁模式與單檔模式都要看。
分頁模式(`npm run serve`,port 5173)才是 GitHub Pages 實際部署的那個。

---

## 四、沙箱連不到外網

所有外部端點在開發沙箱都被擋。要實測資料源:寫成 `scripts/probe-*.mjs`,
加進 `.github/workflows/probe-apis.yml`,用 workflow_dispatch 跑,再讀 log。

**不要憑印象斷言某個 API 有什麼欄位。** 探測過的結果寫在
`docs/進球細節-規格與提示詞.md` 第一節。

抓取禮貌:使用者明確要求**不要大量爬網站**。
- 靜態檔下載(raw.githubusercontent.com)沒問題
- 官方端點的進球事件是**零額外請求** —— 既有排程本來就在抓那些 fixture
- 要一場一個請求的做法**先不要做**

---

## 五、分支與提交

- 開發分支 `claude/premier-league-analysis-platform-kc4btp`
- 預設分支 `claude/method-feasibility-analysis-60pwfp`(排程與部署跑這條)
- 做法:在開發分支提交 → push → 合併進預設分支 → push → 把預設分支合回開發分支

**合併衝突幾乎都在產物**(`data/backtest*.json`、`web/data/*.json`、
`data/availability-history.json`)。解法固定:

```bash
git checkout --theirs <那些檔案> && git add <那些檔案>
cd epl && npm test && npm run build && npm run snapshot && npm run bundle
```

**不要手動編輯那些 JSON。** 它們是產物,重跑就對了。

提交訊息用中文,寫清楚「為什麼」而不只是「改了什麼」。
踩到坑就把坑寫進訊息裡 —— 那是給下一個人的。

---

## 六、程式碼風格

- 原生 ES module,**零外部依賴**(不要引入 npm 套件)
- 註解寫**為什麼**,不寫「這行在做什麼」。特別是:某個門檻為什麼是這個數字、
  某個做法為什麼不用看起來更直覺的那種
- 前端不用框架。共用元件在 `web/assets/js/core.js`
- 資料源都走 adapter(`scripts/lib/adapters/`),介面看 `docs/接新API.md`
