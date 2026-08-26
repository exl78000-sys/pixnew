# SportMonks 方案能力與請求規則

> 這份文件記錄「目前這個 Token 實際能請求什麼」，不是根據方案名稱或文件猜測。
> 每次更換 Token、方案或賽季，都要重新跑探測；探測結果以 `capabilities.json` 為準。

最後驗證：2026-08-26 13:08–13:09 UTC（GitHub Actions runner）  
驗證程式：`epl/scripts/probe-sportmonks-capabilities.mjs`  
同步程式：`epl/scripts/fetch-sportmonks.mjs`  
相關修正：commit `5fb6c2d`

## 本次實測結果

探測對象是西甲 2026/27（SportMonks season `27965`），抽查 Fixture `19732363`，共 10 次請求：

| 探測項目 | HTTP | 結果 |
|---|---:|---|
| `/my/resources` | 200 | 可用，122 項資源 |
| `/my/leagues` | 200 | 可用，5 個聯賽 |
| `/my/usage` | 200 | 可用，25 筆用量資訊 |
| Fixture `participants` | 200 | 可用 |
| Fixture `lineups` | 200 | 可用 |
| Fixture `events` | 200 | 可用 |
| Fixture `statistics` | 200 | 可用 |
| Fixture `formations` | 200 | 可用 |
| Fixture `xGFixture` | 403 / 5002 | 方案未提供，不可用 |

探測快照：`data/raw/sportmonks-la-liga/capabilities.json`。檔案只保存狀態碼、錯誤碼與數量，**不保存 Token、完整回應或個人資料**。

## 西甲即時比分

`scripts/fetch-laliga-live.mjs` 使用官方 `GET /football/livescores/inplay`，以
`filters=fixtureLeagues:564` 限定西甲；正常輪詢最多 2 次請求，優先請求
`participants;state;scores;events`，若目前方案不接受四個 include，會退回
`participants;state;scores`，不繞過方案限制。SportMonks 官方說明列出 Inplay Livescores、
All Livescores 與 Latest Updated Livescores 三種端點，並支援以 include 擴充回應：
[Livescores endpoints](https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/livescores)。

即時快照先寫入 `data/raw/sportmonks-la-liga/live.json`，再由 `laliga:build` 發布到
`web/data/leagues/es1/live.json`；頁面只讀本地快取。比分、狀態與事件若缺少就顯示未取得，
速度、距離、衝刺不在本站資料契約內。相同比分／分鐘不重寫 `fetchedAt`，GitHub Actions
不會因空輪詢反覆提交。

本次同步實際找到 380 場供應商賽程、16 場本地已完賽候選，並成功取得 16/16 場詳情。16 場均通過：兩隊比分核對、正式陣容、球員評分、球隊統計與事件。報告來源為 SportMonks，`reports.json` 為 `count=16`、`pending=0`。

## 固定請求規則

### 1. Token 只能放在伺服器／Actions

- 使用 HTTP `Authorization: <SPORTMONKS_TOKEN>` header。
- **不可**把 `api_token`、Token 或 Secret 放在網址、前端 JavaScript、`web/data` 或提交內容中。
- GitHub Actions 接受 `SPORTMONKS_TOKEN`，相容舊名稱 `SPORTMONKS_KEY`、`SPORTMONKS_API_KEY`。
- 開頁與本地 build 不呼叫 SportMonks；只讀已快取的 raw JSON。

### 2. 先探測，再決定 include

執行：

```bash
cd epl
npm run sportmonks:capabilities -- --league=es1
```

探測器最多 12 次請求，先查 `/my/resources`、`/my/leagues`、`/my/usage`，再逐一測試 Fixture include。同步器讀取對應的 `capabilities.json`，只送 `available=true` 的 include；不能把所有 include 綁成一個請求後，看到 403 就封鎖整條管線。

目前允許的 Fixture include：

```text
participants
lineups.details.type
formations
events.type
statistics.type
```

目前明確排除：`xGFixture`。xG 不可用時保持 `null`，不可填 0、不可用其他指標推算後冒充 SportMonks xG。

### 3. 分頁與額度

- Fixture／隊伍清單 `per_page=50`，這是官方上限；依 `pagination.has_more` 或空頁停止。
- 西甲同步目前硬上限：`--max-requests=160 --max-details=20 --max-coach-details=20`。
- 能力探測、同步、照片與教練補抓都要有明確上限；不要在使用者開頁時逐筆打 API。
- 不假設「每小時 2000 次」一定適用於所有 Token；每次以 `/my/usage` 和實際 HTTP 回應為準，遇到 403／429 不能重試轟炸。

### 4. 完整賽後資料的發布門檻

只有同時符合下列條件，才可寫入 `reports.json`：

1. 本地 fixture 與供應商隊伍、日期、比分一致。
2. 兩隊正式先發各 11 人且有陣型。
3. 至少一筆球員統計與評分。
4. 兩隊至少有一項球隊統計。
5. 事件陣列存在（可為空，但必須是供應商明確回傳的陣列）。
6. `coverage.teamStatistics/playerStatistics/ratings/events/lineups` 全部為 `true`。

未達門檻就留在 raw 快取，前端顯示「尚未取得」；不補零、不拿 FotMob／官方先發冒充完整賽後統計。

## 資料流與建置順序

```text
capabilities probe
  → SportMonks sync（只送允許 include）
  → raw match-details 快取
  → scripts/lib/adapters/sportmonks.mjs 轉 canonical
  → npm run laliga:build
  → web/data/leagues/es1/reports.json
  → test / bundle / Pages deploy
```

重要：`reports.json` 是 build 產物，不是抓取器直接寫出的資料。若只更新了 `data/raw/sportmonks-la-liga/*-match-details.json`，本地必須再執行：

```bash
npm run laliga:build
```

否則畫面可能仍顯示舊的 `count`／`pending`。API-Football 的 `blocked` 只在仍有未發布場次時顯示；SportMonks 已補齊全部場次時，舊的 API-Football 方案限制不得覆蓋可用狀態。

## 常見踩坑與正解

| 踩坑 | 症狀 | 正解 |
|---|---|---|
| 把所有 include 綁在一起 | 單一受限欄位造成整個 Fixture 403 | 先逐項探測，動態排除不可用 include |
| 把 403 當 Token 失效 | 反覆換 URL 或重試仍失敗 | 先看 `errorCode`；本次 `5002` 是方案未提供 `xGFixture` |
| 把 HTTP 200 當成功 | 回應內其實有錯誤物件 | 同時檢查 HTTP 狀態與 JSON 錯誤欄位 |
| 把 xG 缺失填成 0 | 圖表看似完整但數字是假的 | 保持 `null`，前端明確顯示未提供 |
| 只抓到 raw 就以為網站更新 | raw 有 16 場但頁面仍是 0 場 | 重跑 `npm run laliga:build`，確認 `reports.json` |
| 用 API-Football blocked 判定所有來源都不可用 | SportMonks 已有報告但頁面仍顯示不可用 | blocked 只代表未發布缺口，且完整發布時清除 |
| 把方案額度寫死 | 換 Token 後超額或錯誤重試 | 每次讀 `/my/usage`，同步器設定硬上限 |
| 把供應商欄位直接塞前端 | 欄位名稱跨來源不一致 | 先經 `adapters/sportmonks.mjs` 轉 canonical schema |

## 重驗清單

更換 Token、方案、賽季或修改 include 後，依序確認：

```bash
cd epl
npm run sportmonks:capabilities -- --league=es1
npm run sportmonks:sync -- --league=es1 --max-requests=160 --max-details=20 --max-coach-details=20
npm run laliga:build
node scripts/test-laliga.mjs
```

GitHub Actions 的 `epl-live.yml` 已在 SportMonks 同步前自動執行能力探測；探測失敗會安全略過，不會讓前端偷偷使用未驗證欄位。官方請求語法與 Fixture include 以 [SportMonks API Syntax](https://docs.sportmonks.com/v3/api/syntax)、[Fixtures endpoint](https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/fixtures) 為準。
