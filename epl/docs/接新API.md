# 怎麼接一個新的 API

這個專案的資料層是 **Canonical Schema + adapter**:所有外部資料先轉成本站的格式,
上層(分析、模型、AI、前端)只讀那個格式。所以接新來源 = 寫一個 adapter,上層一行都不用改。

範本在 `scripts/lib/adapters/api-football.mjs`,複製它改三個地方就好。

---

## 五個步驟

### 1. 寫 adapter

放在 `scripts/lib/adapters/你的來源.mjs`,必須匯出:

```js
export const id = 'your-source';           // 唯一識別碼
export const label = '人看得懂的名字';       // 顯示在資料來源說明
export const supports = ['formations'];    // 提供哪些能力
export const enabled = env => Boolean(env.YOUR_KEY);   // 需要金鑰才要匯出這個
export async function loadFormations({ root, season, round, codeOf, env }) { /* ... */ }
```

**回 `null` 代表這次拿不到**(沒金鑰 / 額度用完 / 連不上)。不要丟例外 ——
資料源掛掉不該讓整個 build 失敗,上層會自動退回既有做法。

### 2. 註冊

`scripts/lib/adapters/index.mjs` 加一行 import 和一筆到 `ADAPTERS`。

### 3. 金鑰

**只從環境變數讀,而且只在建置階段用。**

```js
export const enabled = (env = process.env) => Boolean(env.API_FOOTBALL_KEY);
```

絕對不要寫死在檔案裡 —— 這個 repo 是公開的。
產物是靜態 JSON,所以金鑰不會、也不可能出現在前端 bundle。

**本機**
```bash
export API_FOOTBALL_KEY=xxxx
npm run build
```

**GitHub Actions**
1. repo → Settings → Secrets and variables → Actions → New repository secret
2. 名稱填 `API_FOOTBALL_KEY`,值貼金鑰
3. workflow 的對應步驟加上 env:

```yaml
- name: 建立資料集
  run: npm run build
  env:
    API_FOOTBALL_KEY: ${{ secrets.API_FOOTBALL_KEY }}
```

Secrets 在 log 裡會自動被遮成 `***`,不會外洩。

### 4. 額度與快取

免費方案通常有硬限制。目前排程是**每 15 分鐘一次 = 96 次/天**,
如果 API 只給 100 次/天,等於每次 build 只剩 1 個請求的預算 —— 不夠。

兩個對策,範本裡都實作了:

- **自己記帳**(`data/cache/api-football-budget.json`):超過預算就停,
  不要一口氣把額度燒光導致整天都拿不到。預留 20% 緩衝。
- **快取**(`data/cache/af-*.json`):官方陣容公布後就不會再變,存 24 小時。
  這也是這個專案的原則 —— 所有人共用後端的快取,不是每個使用者各自去打 API。

額度真的不夠就改排程:只在比賽時段跑(約 16 次/天),
反正沒有比賽的時候本來就不需要頻繁更新。

### 5. 驗證

**先確認它真的能用,再接進 build。**

```bash
npm run probe:apis    # 探測各候選來源通不通
```

接好之後,確認**沒有金鑰時也不會壞**:

```bash
unset API_FOOTBALL_KEY && npm run build   # 應該正常完成,只是少了那部分資料
```

---

## 幾個容易踩的坑

**HTTP 200 不代表成功**。API-Football 即使回 200,也可能在 `errors` 欄位裡放錯誤訊息。
範本裡有檢查。

**403 不等於 404**。403 是「被拒絕」(通常是被限流或擋 IP),404 才是「沒有這筆資料」。
分不清會誤判成「這筆資料不存在」而永遠不再重試 —— 抓頭貼時就踩過這個坑。

**節流**。免費方案是別人請你用的,不是你買的。範本裡每個請求間隔 300ms,
遇到 429 會退避重試。開幾十條並行連線很容易被永久封鎖。

**隊名對照**。每家 API 的隊名寫法都不同(`Man Utd` / `Manchester United` / `Man United`)。
用 `codeOf()` 轉成本站的三碼代號,對不上要**明確報錯**而不是靜靜跳過 ——
靜靜跳過會讓資料缺一半而沒人發現。

---

## 目前的 adapter

| id | 能力 | 需要金鑰 |
|---|---|---|
| `openfootball` | matches(賽程、賽果、半場比分) | 否 |
| `fpl-snapshot` | squads(球員數據、傷停) | 否 |
| `api-football` | formations、coaches、完賽球隊/球員統計、0–10 評分、事件時間軸 | **是** |

API-Football 的完賽資料已正式接入：`npm run live` 在終場後自動補抓，或用
`npm run postmatch` 手動補齊。完整結果永久保存在
`data/raw/api-football/match-details.json`；速度、距離與衝刺不在供應商欄位內，因此明確標為不可用。

即時比分走另一條路(`lib/live.mjs`),因為場中資料有自己的取捨(官方 API / 鏡像 / 重播三種來源)。
