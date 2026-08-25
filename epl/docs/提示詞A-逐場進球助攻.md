# 提示詞:英超逐場進球與助攻抽取

> 這一份是可以直接整段複製、轉交給 AI 助手的版本。
> 它需要:能連外網、能跑 Node 或 Python。不需要任何 API 金鑰。
>
> 完整背景(為什麼要這些欄位、抓回來之後怎麼用、球隊頁怎麼排版)在
> `docs/進球細節-規格與提示詞.md` —— **那份是原本,這份是它的第七節抽出來的**。
> 兩邊不一致時以那一份為準。
>
> 抓取量:每季 3 個靜態檔,共 6 個請求,對象是 raw.githubusercontent.com。
> 這是下載檔案不是爬網站,沒有被擋的問題。

---

### 任務

從公開的 FPL 資料鏡像抽取英超兩個賽季的**逐場進球與助攻紀錄**,
產出兩個 JSON 檔。

### 輸入(全部公開,不需要金鑰)

基底網址:`https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data`

每個賽季(`2024-25`、`2025-26`)要下載三個檔:

```
{base}/{season}/gws/merged_gw.csv     逐輪 × 逐球員(主檔)
{base}/{season}/players_raw.csv       球員名冊(拿 element → code 對照)
{base}/{season}/teams.csv             隊伍名冊(拿 id → short_name 對照)
```

實測大小參考:2024-25 的 merged_gw 有 27,606 列、2025-26 有 29,758 列。
數量差太多就是抓錯檔了。

### 三個一定要做對的對照(做錯不會報錯,只會給出錯的答案)

1. **`element` 每季重新編號。** `merged_gw.csv` 的 `element` 是該季的內部編號,
   同一位球員不同季編號不同。輸出必須用 `players_raw.csv` 的 **`code`** 欄
   (跨季穩定,例如門將 Raya 兩季都是 `154561`)。
   → 用**同一季**的 `players_raw.csv` 建 `id → code` 對照表。

2. **`opponent_team` 也是每季重新編號**(1~20,依該季 20 隊英文名排序)。
   → 用**同一季**的 `teams.csv` 建 `id → short_name` 對照表。
   `short_name` 就是我要的三碼代號(ARS、LIV、MUN…),直接用,不用再轉。

3. **不要用 `name` 欄當鍵。** 它的格式在不同賽季不一樣(有的用底線串接 id)。
   名字只在對不上時拿來人工核對。

### 輸出格式(請嚴格照這個結構)

檔名 `{season}-goals.json`,例如 `2025-26-goals.json`:

```json
{
  "_season": "2025-26",
  "_source": "<你實際下載的 merged_gw.csv 網址>",
  "_generatedAt": "<ISO 8601 時間>",
  "_counts": {
    "csvRows": 29758, "records": 1042, "goals": 1116, "assists": 812,
    "ownGoals": 41, "unmatchedElements": 0, "scoreMismatches": 0
  },
  "records": [
    { "code": "223340", "team": "ARS", "opp": "COV", "home": true,
      "round": 1, "date": "2025-08-15", "min": 90, "start": true,
      "g": 1, "a": 0, "og": 0, "pm": 0 }
  ]
}
```

- `code`:字串(不要轉成數字,前導零會掉)
- `team`:該球員所屬隊伍的三碼代號(從 `players_raw.csv` 的 `team` 欄 → `teams.csv`)
- `opp`:對手三碼代號
- `home`:`was_home` 轉成布林
- `date`:從 `kickoff_time` 取 `YYYY-MM-DD`
- `start`:`starts == 1`
- `g`/`a`/`og`/`pm`:`goals_scored` / `assists` / `own_goals` / `penalties_missed`

**只輸出 `g + a + og + pm > 0` 的列。** 絕大多數列全是 0,
全存會讓檔案從 100 KB 變成 6 MB,而且一個問題也回答不了。

### 三個自我檢查(請務必跑,結果寫進 `_counts`,並在回報裡說明)

1. **對不上的 element**:每一列的 `element` 都要在該季 `players_raw.csv` 找得到。
   找不到的記進 `unmatchedElements`,並列出前 10 個名字。**正常應該是 0。**

2. **比分核對**:對每一場比賽,
   `該隊球員 goals_scored 總和 + 對手球員 own_goals 總和`
   必須等於該隊的實際比分(`team_h_score` / `team_a_score`)。
   對不上的場次數記進 `scoreMismatches`,並列出前 5 場的詳情。
   **正常應該是 0** —— 這條規則我已經用另一批資料驗證過成立。

3. **總數合理性**:一季英超約 1,000~1,200 顆進球。
   `_counts.goals` 明顯偏離就是哪裡錯了,**先別交,回頭查**。

### 回報時請一併告訴我

- 兩個檔各自的 `_counts`
- 三項自我檢查的結果(如果不是 0,把明細貼出來)
- `merged_gw.csv` 兩季的欄位有沒有差異(我知道 2024-25 有 49 欄、2025-26 有 46 欄,
  想確認差的是哪幾欄)
