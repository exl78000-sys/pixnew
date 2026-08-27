# 提示詞:用 FotMob 補英超戰情室缺的資料

把 `---` 之間那一整段複製給另一個 AI 助手。它是獨立的 —— 不需要看過這個專案。

拿回來的檔案放進 `epl/data/manual/`,我這邊會寫 adapter 接進去。

---

## 任務

我需要你從 FotMob 抓幾類足球資料,輸出成 JSON 檔給我。

### 抓取禮貌(這條最重要,請嚴格遵守)

- **單線,一次一個請求**,每個請求之間 **間隔至少 1.2 秒**
- **總量上限 120 個請求**。做不完就做多少算多少,把沒做完的列出來給我,
  不要為了做完而加快速度或並發
- User-Agent 用 `Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)`,
  帶 `referer: https://www.fotmob.com/`
- 遇到 429 或連續 3 次失敗就**停下來**,把已經拿到的存檔,回報停在哪裡

### 端點(已知可用)

```
https://www.fotmob.com/api/data/allLeagues                     聯賽目錄,拿 league id
https://www.fotmob.com/api/data/leagues?id={id}&ccode3={國碼}&season={2026%2F2027}
https://www.fotmob.com/api/data/matchDetails?matchId={id}      單場詳情(含事件與名單)
```

英超的 ccode3 是 `ENG`,西甲是 `ESP`。season 參數格式是 `2026/2027`(要 URL encode)。
球隊頁與球員頁的端點請你自己從 allLeagues / leagues 回傳的結構往下找,
**不要猜路徑** —— 找不到就回報找不到,不要編一個。

---

## 要抓的四件事(按優先順序)

### 1. 英超球員背號(最需要)—— 42 人

這些球員本季或上季有實際上場,但我手上的來源沒有背號。
請給我他們的**球衣號碼**。格式 `隊碼 顯示名`:

```
AVL Martinez / TOT Vicario / CHE Chalobah / MCI Rúben / BHA Gomez /
CRY Yeremy / TOT Spence / LIV C.Jones / TOT Romero / AVL Digne /
BOU Kroupi.Jr / MCI Reijnders / MCI Rodrigo / CHE Disasi / ARS White /
MUN Bayindir / CHE B.Badiashile / LEE Bornauw / CHE Jörgensen / CHE Marc Guiu /
LEE Harrison / BOU Enes Ünal / BHA Coppola / CRY Uche / SUN Masuaku /
BRE Carvalho / BHA Howell / BOU Silva / CRY Cardines / AVL A.García /
BHA Buonanotte / BHA Watson / AVL Burrowes / MUN Bendito Mantato / TOT Olusesi /
NEW Neave / LIV Koumas / MUN Fredricson / BHA Oriola / CHE Mheuka /
TOT Byfield / TOT Rowswell
```

隊碼對照:ARS=Arsenal, AVL=Aston Villa, BHA=Brighton, BOU=Bournemouth,
BRE=Brentford, CHE=Chelsea, CRY=Crystal Palace, LEE=Leeds, LIV=Liverpool,
MCI=Man City, MUN=Man United, NEW=Newcastle, SUN=Sunderland, TOT=Tottenham。

**名字是縮寫或簡寫**(FPL 的顯示名),例如 `MCI Rúben` 是 Rúben Dias、
`LIV C.Jones` 是 Curtis Jones。請用**球隊名單**去比對,不要只靠字串比對。
**不確定是哪一個人就標 `null` 並說明** —— 掛錯人比沒有更糟。

輸出 `fotmob-squad-numbers.json`:

```json
{
  "source": "FotMob",
  "retrievedAt": "2026-08-27T00:00:00Z",
  "note": "球衣號碼。matched=false 代表在球隊名單裡找不到對得起來的人。",
  "players": [
    { "team": "ARS", "query": "White", "matched": true,
      "fotmobName": "Ben White", "fotmobId": 12345, "squadNumber": 4 },
    { "team": "TOT", "query": "Rowswell", "matched": false,
      "reason": "球隊名單裡沒有姓 Rowswell 的球員" }
  ]
}
```

### 2. 英超球員頭貼 —— 6 人

`BOU Silva / CRY Cardines / AVL Burrowes / MUN Bendito Mantato / BHA Oriola / TOT Rowswell`

我要的是**圖片網址**,不是圖檔本身。輸出 `fotmob-player-photos.json`:

```json
{
  "source": "FotMob", "retrievedAt": "...",
  "players": [
    { "team": "BOU", "query": "Silva", "matched": true,
      "fotmobName": "...", "fotmobId": 12345,
      "photoUrl": "https://images.fotmob.com/image_resources/playerimages/12345.png" }
  ]
}
```

### 3. 教練任內戰績 —— 英超 12 人、西甲 20 人

我有教練姓名,缺的是**任期與戰績**。每位教練請給:

- `since`:接任日期(ISO `YYYY-MM-DD`,不確定就 `null`)
- 本季(2026-27)任內:`p` 場次 / `w` 勝 / `d` 和 / `l` 負 / `gf` 進 / `ga` 失

**只算他在這支球隊、這個聯賽、這一季的比賽。** 拿不到就整筆標 `null`,
不要用生涯數字或跨隊數字頂替。

輸出 `fotmob-coaches.json`:

```json
{
  "source": "FotMob", "retrievedAt": "...",
  "coaches": [
    { "league": "pl", "team": "ARS", "name": "Mikel Arteta",
      "since": "2019-12-20", "fotmobId": 123,
      "seasonRecord": { "season": "2026-27", "p": 1, "w": 1, "d": 0, "l": 0, "gf": 3, "ga": 0 } },
    { "league": "es1", "team": "ATH", "name": "Edin Terzic",
      "since": null, "seasonRecord": null, "reason": "FotMob 沒有任期資料" }
  ]
}
```

英超與西甲各 20 隊,請兩個聯賽都給。

### 4. 本季逐場進球明細(2026-27)—— 兩個聯賽

這是最花請求的一項,**請放在最後做,額度不夠就跳過**。

每場已完賽的比賽,列出每一顆進球:

- `minute` 分鐘
- `scorer` 進球者姓名 + `scorerId`
- `assist` 助攻者姓名 + `assistId`(沒有就 `null`)
- `team` 得分方的隊碼
- `kind`:`"open"` / `"penalty"` / `"own"` / `"freekick"` / `"header"` —— **只填你在資料裡真的看到的**,
  推測不出來就 `null`,不要用「看起來像」來分類

**烏龍球特別注意:得分方是被踢進的那一隊,不是踢球者的球隊。**
如果 FotMob 的欄位語意不清楚,請照實回報你看到的原始欄位,由我來判定。

輸出 `fotmob-goals-2026-27.json`:

```json
{
  "source": "FotMob", "retrievedAt": "...",
  "leagues": {
    "pl": { "season": "2026-27", "matches": [
      { "home": "ARS", "away": "COV", "date": "2026-08-21",
        "score": { "home": 3, "away": 0 }, "fotmobMatchId": 4321,
        "goals": [
          { "minute": 23, "team": "ARS", "scorer": "Bukayo Saka", "scorerId": 111,
            "assist": "Martin Ødegaard", "assistId": 222, "kind": "open" }
        ] }
    ] },
    "es1": { "season": "2026-27", "matches": [] }
  }
}
```

---

## 通用規則(四項都適用)

1. **不確定就標 `null` 並寫原因**,不要猜。掛錯球員的背號或頭貼,比留空更糟 ——
   我這邊有驗證,對不上的會整批退回,猜的部分等於白做。
2. **每個檔案都要有 `source` 與 `retrievedAt`。**
3. **回報實際用掉幾個請求**,以及有沒有被限流。
4. 如果某個端點回 **HTTP 200 但內容是錯誤物件**(而不是資料),
   請當成失敗處理並回報 —— 不要把它當成「拿到空資料」。
5. 做不完不是問題,**做錯才是**。優先順序 1 → 2 → 3 → 4,
   前面的做確實比後面的做完重要。

最後請附一段簡短說明:哪些拿到了、哪些沒有、為什麼。

---

## 拿回來之後(給我自己看的)

- 檔案放 `epl/data/manual/`
- 背號與頭貼:寫進 `scripts/lib/adapters/` 的新 adapter,依 `docs/接新API.md` 的五步
- **一定要用獨立來源核對**(鐵則五):協作方自報「全過」不算數。
  背號拿官方名單抽驗、進球明細拿 openfootball 賽果逐場對回比分 ——
  這個專案踩過一次:交回來的進球明細自報 `scoreMismatches: 0`,
  實際用 openfootball 對比出 2024-25 有 15 場、2025-26 有 24 場對不上。
- FotMob 是網站公開端點不是官方 API,接進去要照 `fetch-laliga-lineups.mjs` 的做法:
  永久快取、每日硬上限、失敗記錄原因
