# 點火器 + 看門狗(Cloudflare Worker)

## 它解決什麼

GitHub 的 `schedule` 是 best-effort。實測 2026-08-31 前七天,`epl-matchday`
**「完全沒有 job 在跑」的空窗**中位數 43 分鐘(設定是 15 分鐘)、只有 5%
在 20 分鐘內接上、38 段超過 45 分鐘、最長一段 44 小時。長迴圈保護的是
「已經進場之後」,保護不了**進場那一刻** —— 2026-08-29 西甲 LEV vs BET
就是整場零覆蓋;2026-08-31 英超 AVL vs ARS 也在開球當下沒有任何輪詢。

這支 Worker 做三件事:

1. **點火**:比賽快開打而沒有 job 在跑 → 叫 GitHub 開比賽日迴圈。
2. **看門狗**:比賽正在踢而即時資料超過 6 分鐘沒更新 → 自動補派送;
   超過 15 分鐘 → 送告警(有設 webhook 的話)。
3. **收工部署**:當天最後一場結束 30 分鐘後,補一次完整建置與部署。

GitHub 原本的 cron **不拿掉**,兩條路徑並存 —— Cloudflare 掛了還有原本那條。

## 設計上的三個刻意選擇

- **無狀態**:每次執行都從公開靜態檔重算,不用 KV(免費版每天 1000 次寫入,
  兩個聯賽的高頻輪詢會擦邊)。冪等性靠「派送前先問 GitHub 有沒有 job 在跑」。
- **窗口故意比工作流程寬**(開賽前 95 / 後 155 分,工作流程是 75 / 140):
  這裡只是扳機,真正的判斷仍在 `epl/scripts/live-window.mjs`。寧可多扳幾次
  (不該進場時工作流程幾秒內就結束),也不要漏掉開賽那一刻。
  **兩邊不是同一份邏輯,也不應該是** —— 把那份 Node 判斷複製過來,
  改了一邊另一邊會悄悄過期。
- **永遠不擋自己**:任何一步失敗都只記錄、繼續下一個聯賽。會拋例外的看門狗
  比沒有看門狗更糟。

## 部署(約五分鐘)

1. **開一組 token**(這一步必須你自己做,我不經手憑證):
   GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Repository access 只選 `exl78000-sys/pixnew`,
   Permissions 只勾 **Actions: Read and write**,其他全部不給。
   這樣就算外洩,最壞情況是有人幫你跑 workflow,碰不到程式碼或其他 repo。

2. **登入 Cloudflare**:
   ```bash
   cd infra/ignition-worker
   npx wrangler login
   ```

3. **設定機密**:
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put ALERT_WEBHOOK   # 選用
   ```
   沒設 `ALERT_WEBHOOK` 也能跑,只是不會主動通知,異常仍記在 Worker 的 log。

4. **部署**:
   ```bash
   npx wrangler deploy
   ```

5. **驗一下**:打開 `https://warroom-ignition.<你的帳號>.workers.dev/status`。
   會回一份 JSON,列出每個聯賽現在有沒有比賽在窗口內、即時資料多新、
   GitHub 認證是否正常(`auth`)、以及它剛才判斷要做什麼。

   **公開網址是唯讀的**:沒帶 `?key=` 時只報告、不派送(workers.dev 的網址
   任何人都打得到,而這支會真的觸發 workflow)。想讓它當手動急救鈕就設一組
   `npx wrangler secret put STATUS_KEY`,之後用 `/status?key=你設的值` 呼叫。
   cron 走的是另一條路徑,永遠是執行模式,不受這個限制。

## token 過期怎麼辦

fine-grained token 有期限。到期那天如果沒有任何機制講,這支會**每次都問不到
GitHub 的執行狀態、於是什麼都不派送** —— 靜靜地失效。所以:

- `runState()` 分三態(`busy` / `idle` / `unknown`),**問不到不等於忙**;
- 該派送而狀態是 `unknown` 時會送告警(有設 `ALERT_WEBHOOK` 的話);
- `/status` 的 `auth` 欄位隨時看得出來(401 = token 失效、403 = 權限不足、
  404 = repo 名稱或存取權不對)。

### 「讀得到」不等於「派得動」(2026-09-02 補)

原本 `authHealth` 只打唯讀端點 —— 那證明得了讀,證明不了寫。token 若只勾了
**Actions: Read**,一路要到比賽開打那一刻真的派送才會 403,而那時沒有人在看。
這正是這支 Worker 要消滅的故障形態,它自己卻有。

現在多一道**零副作用的寫入探針**:對派送端點送一個不可能存在的 ref。
GitHub 先檢查權限再驗 ref,所以

| 回應 | 意思 |
|---|---|
| `422 No ref found` | **有**派工權限(想看到的就是這個) |
| `403` | token 沒有 Actions: Write |
| `404` | REPO / workflow 名稱不對,或沒有存取權 |

實測過(2026-09-02,用有寫權限的 token):回 422,而且**沒有排出任何 run**,
不會誤觸一次建置。

每 5 分鐘打一次太吵,所以 cron 只在**整點後那一格**驗(每小時約一次);
打開 `/status` 則一定會驗一次 —— 要等最多一小時才知道自己派不派得動,
等於沒有這個檢查。探針本身是唯讀的,所以不受 `/status` 的唯讀模式限制。

`/status` 的 `auth` 會多出 `write: true/false`。`false` 時會送告警。

換 token:重開一組之後 `npx wrangler secret put GITHUB_TOKEN` 貼上即可,
不用重新部署。

## 費用

免費方案綽綽有餘:每天約 288 次 cron 執行(免費上限 10 萬次請求/天),
沒有比賽時每次只讀兩個靜態賽程檔。不需要 KV、不需要付費方案。

## 調參

`src/worker.js` 最上面那幾個常數:窗口寬度、判定過期的分鐘數、告警門檻、
收工部署延遲。改完重跑 `npx wrangler deploy`。

## 分支換了怎麼辦

`wrangler.toml` 的 `[vars] BRANCH` 要跟著改,再 `npx wrangler deploy` 一次。
派送用的 `ref` 就是它 —— 指到不存在的分支時 GitHub 會回 422,
`/status` 會顯示「派送失敗 HTTP 422」。
