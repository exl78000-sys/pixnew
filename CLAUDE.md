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
| **隊名正規化去掉字首的 AFC** | `AFC Liverpool`(第九級)被對成 `Liverpool FC`、`Bournemouth FC`(第九級)被對成 `AFC Bournemouth` —— 兩支第九級球隊在盃賽頁被標成「英超」,而畫面看起來完全正常 | **字尾**的 FC/AFC 是法人形式(Barnsley = Barnsley FC),**字首**的 AFC 是球隊身分的一部分。只去字尾。這是「盃賽寬鬆比對會對錯球隊」的第二次出現,靠 nearMisses 清單抓到的 —— **那份清單不是裝飾** |
| **同一組對戰在不同賽季會重複** | 用 `find(home===H && away===A)` 找比賽,拿到的可能是**上一季**那一場。西甲三則賽報因此全被判成「比分不符」:摘要寫 1-2、抓到上季的 0-2 | 用日期收斂(報導日或比賽日前後幾天內)。**收斂不到要記成「無法核對」,不是「不一致」** —— 那兩個結論差很多 |
| **人工交付的明細與賽程涵蓋的比賽不同批** | 新賽果落地、逐球明細還沒跟上時,「逐隊進失球對回賽果」整條變紅,看起來像上游資料錯了 | 明細只收核對通過的場次,所以 `goals.json` 每季記 `matchKeys`(涵蓋哪幾場),核對限定在同一批比賽上 |
| API 回 **HTTP 200 加一個 error 物件** | 只看 `res.ok` 會把失敗當成功;排程每天跑、每天回報成功,實際一筆都沒抓到 | API-Football 看 `j.errors`、Understat 看 `j.error`。而且要分得出「暫時失敗」與「這個方案就是拿不到」,後者要記錄下來讓畫面講實話 |
| **備援來源的方案限制被當成整季的結論** | 西甲賽後已由主要來源(SportMonks)發布 16/20,剛完賽那 4 場的頁面卻寫著「本站使用的資料源方案不含本賽季…在換成涵蓋本賽季的方案之前都不會出現」—— 而隔壁 16 場的球隊統計、正式陣容、事件與評分全都在。判斷式是「還有場次沒發布 → 把備援的 blocked 傳到前端」,主要來源換成 SportMonks 之後沒跟著改 | 「拿不到」只能在**主要來源一場都發不出來**時講。分成兩個欄位:`blocked`(整季拿不到,reportCount===0 才給)與 `backupBlocked`(主要來源可用、備援補不了缺口),缺口照實說是「還沒抓到」。`npm test` 有四條守著,含「主要來源已發布場次時 blocked 必須是 null」 |
| **比分的分段欄位不是累計值** | 歐冠的 `et` 是**延長賽的增量**,不是「延長賽後的比分」。2025-26 決賽 `final=[1,1]`、`ft90=[1,1]`、`et=[0,0]`、`pens=[4,3]` —— 照 `et` 印會變成「0:0(PK 4:3)」,而半場還印著 0:1,自己跟自己矛盾。這跟 `fullTime` 那一列是同一類錯:憑印象讀欄位 | **比分只讀 `final`。** 拿全部資料驗過:`final === ft90 + et` 在歐冠 378 場全部成立,而 `ft90` 有 372 場是 null。盃賽 1,444 場有 2 場上游自己加不回來 —— 那種要標「分段對不起來」,不挑一個當答案 |
| **RSS 來源的名字不等於它的內容** | `feeds.json` 裡叫「Sky Sports 英超」的那一筆,網址其實是 `feeds.skynews.com/feeds/rss/sports.xml` —— Sky News 的**綜合體育**。抓回來的拳擊與網球會掛在動態頁上標成「英超外電」,而畫面看起來完全正常 | 加來源時**先抓一次看標題**,不要只看名字。正確的是 `skysports.com/rss/11661`(2026-08-28 實測 20 則全是英超)。來源自己歸錯類的不算(Guardian 把週報測驗放在英超 feed 裡),那種不要用關鍵字黑名單去殺,會誤傷真文章 |
| **「姓氏唯一就配對」會對到完全不同的人** | 租借核對器的姓名 fallback 寫成「姓氏相同且唯一就回傳」,完全沒檢查名字 —— `Gustavo Nunes` 配到 `Matheus Nunes`(FPL 唯一姓 Nunes 的人,2861 分鐘)、`Fer López` 配到 `Hugo Bueno López`(2359 分鐘),然後核對器拿那些分鐘去**指控真紀錄是假的** | 姓氏相同**且名字首字母相同且唯一**才算配上,否則回 null。`npm test` 有三條守著(含 Gustavo ≠ Matheus)。這條坑本站講過很多次(「對錯人比對不到糟得多」),而核對器自己犯了 |
| **修好一份、忘了另一份複本** | 姓名配對在 `verify-loans.mjs` 與 `lib/loans.mjs` 各有一份。我修好核對器那一份,另一份沒動 —— **實際掛到球員身上的那一步仍在對錯人**,而畫面上完全看不出來。實測 20 筆掛錯:Ben Nelson 的租借掛到 Reiss Nelson、Julián Araujo 的掛到 Ronald Araújo、Gustavo Nunes 的掛到 Matheus Nunes | 抽成 `scripts/lib/names.mjs`,兩邊 import 同一份。`npm test` 有四條守著「兩個檔案都走共用的、而且沒有自己再寫一份正規化」。這條坑 CLAUDE.md 本來就寫過(「複製一份轉換過去的話,改了一邊另一邊會悄悄過期」),而我自己犯了 |
| **NFD 分解不掉的字母會被整個刪掉** | `Đ` `Ø` `Ł` `ß` `ı` 都是獨立字元,沒有「基底 + 附加符號」可分解。`normalize('NFD')` 之後它們原封不動,再被 `[^a-z0-9]` 清掉 —— `Đorđe Petrović` 變成 `"or e petrovic"`。那比配不到更糟:剩下的殘骸有機會撞到別人 | `lib/names.mjs` 先逐字對照換掉再做 NFD。`Đ → Dj`(塞爾維亞/克羅埃西亞語的通用音譯,交付檔就是寫 Djordje),`Ð`(冰島 eth)是另一個字,照舊 → D |
| **拿 A 聯賽的資料去驗「租到 B 聯賽以外」的球員** | 檢查「租到西甲的人,西甲資料把他放在哪一隊」時沒先確認**目的地當季真的在西甲**。Racing Santander / Cádiz / Granada 2025-26 都在西乙,租過去的人本來就不會出現在西甲資料裡,而他離隊前在原隊留下的出賽紀錄被判成「矛盾」 | 只有目的地當季確實在那個聯賽時才做這項檢查。(第一份交付的 Pelayo Fernández → Cádiz 就是被這樣誤判的,而且已經發函退回過 —— 那次退回是錯的) |
| **拿 metadata 標籤當判決依據** | 交付檔把 Hull City / Southampton / West Ham 的 `parentLeague` 標成英超,但那幾季他們在英冠。原本這會讓整筆被退回 —— 可是那個欄位**下游根本沒用到**(接資料用的是隊碼),標錯不代表這筆租借是假的 | 標籤問題記成 `labelIssues` 回報,不退回紀錄。真正能定罪的是直接跟聲明衝突的證據:出賽分鐘、目的地球員名單、年份平移指紋 |
| **一筆日期解不開,整個來源的 15 則全沒了** | Sky Sports 的 pubDate 是 `Thu, 27 Aug 2026 19:00:00 **BST**`,`new Date()` 對它回 Invalid Date,而 `.toISOString()` 直接拋錯 —— 輸出只留一行「✗ Invalid time value」,那個來源整批消失 | `fetch-news.mjs` 的 `parseFeedDate()` 會把字尾的時區縮寫換成偏移量再解;還是解不開就用抓取當天並**把筆數報出來**(靜靜蓋上今天的日期會讓三天前的新聞排到最上面,而沒有人會發現) |
| **`data/raw/fpl/{季}-players.csv` 當季那一份裝的是上一季的數字** | 檔名寫著 2026-27,裡面 Raya 是 3330 分鐘 —— 跟 2025-26 那一份一模一樣,而 2026-27 只踢了 1 輪。拿它當本季分鐘用,會誣賴一批真資料(我用它核對租借,一口氣冤枉了四筆) | 用之前先自我檢查:**該檔的進球總和要等於 `goals.json` 記的該季總進球**。2024-25 是 1081 = 1081,可以用;當季那一份對不上,拒用。`verify-loans.mjs` 就是這樣擋的 |
| **人工交付的資料會整批複製、只改年份** | 2026-08-28 交付的租借檔,2024-25 整批是 2025-26 的複本(年份 -1)。17 組重覆裡 14 組「月日完全相同、剛好差一年」;而 Leeds United 2024-25 在英冠,檔案裡卻有 6 筆「2024-25 英超 / 母隊 Leeds」 | 逐季的**聯賽成員資格**(`results.json`)是最便宜也最硬的檢查:那支球隊當季在不在這個聯賽。再加逐季出賽分鐘與目的地聯賽的逐季球員。`npm run loans:verify` 三種都做 |
| **交付檔的一個區塊整批標錯隊** | 6 筆「→ Alaves」裡有 5 筆被 Understat 證明其實在 Getafe,而同一份檔案裡「→ Getafe」的引進是 0 筆 | 同一個(賽季 + 目的地)是一個區塊。**區塊裡只要有紀錄被證明是錯的,剩下的整批不採用** —— 挑通過的用等於在兩個對不上的來源裡選一個喜歡的答案(進球明細那次的教訓) |

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
區塊數與斷言數**不寫在文件裡** —— 每加一條測試就會歪(實測過:三份文件三個數字,全錯)。
`npm test` 最後會自己印一行合計。涵蓋:走查回測、模型 vs 市場、即時勝率、AI 報告層、
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
(workflow 裡的順序本來就是對的。**但 `scripts/local-sync.mjs` 原本是反的** ——
build → laliga:build,跑完 `npm run local:sync` 再跑 `npm test` 就會紅在資產戳那條。
2026-08-28 修正。這條規則不是只給「手動重跑的人」看的,寫成腳本的地方也要照。)

**資產有版本戳。** `npm run build` 會跑 `scripts/stamp-assets.mjs`,
依**內容雜湊**給 `web/*.html` 的 CSS/JS 與 JS 之間的 import 打上 `?v=`。
沒有它的話改版面部署上去,使用者會看到最難察覺的組合:
**meta.json 是新的、JS 是舊的** —— 頁尾顯示最新建置時間、版面卻是上一版。
手動改完前端沒重跑 build 的話,跑 `npm run stamp` 補上;`npm test` 有一節守著
「戳對不對得回檔案內容」。

**人工交付的租借資料要先過核對器,而且核對結果要跟得上收件匣。**
`loans-verified.json` 記著收件匣的 sha256;收件匣改過卻沒重跑核對時,
`loadVerifiedLoans` 回 `stale`,build **整批不掛**並印出原因,`npm test` 也會紅。
沒有這道守門的話,build 會拿舊的核對結果背書新的交付內容,而且不會有任何地方報錯。
`loans:verify` 已掛進 `local:sync` 與 `epl-live.yml`。
`data/manual/loans.json` 是**收件匣**(協作方交付的原始內容,裡面有已知是錯的);
`npm run loans:verify` 核對後產生 `data/loans-verified.json`,**build 只讀後者**。
直接讀收件匣等於把核對整個繞過去。判定分四級,發布的只有 `confirmed`(有獨立來源
正面確認)與 `consistent`(查得動的都沒有矛盾),而且**等級要跟著資料走到畫面上** ——
兩者對讀者的意義不同,不可以混成一句「有租借紀錄」。

**Obsidian vault 是產物,而且有一個不能刪的例外。**
`npm run obsidian` 產生 `epl/vault/`(5,716 則筆記:兩個聯賽 + 歐冠 + 英格蘭盃賽 +
足球知識),比照 `dist/` 不進版控 ——
但 `vault/我的筆記/` 是使用者手寫的,`.gitignore` 特地留了 `!epl/vault/我的筆記/`。
產生器清空的範圍是**從這次要寫的路徑推出來的**(加新資料夾自動涵蓋),
**不要改成 rm 整個 vault**:那會把手寫筆記不可逆地刪掉,重跑救不回來。
另有一道斷言:產生器想寫進 `我的筆記/` 就中止。詳見 `docs/接手資訊.md` 的 Obsidian vault 一節。

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
