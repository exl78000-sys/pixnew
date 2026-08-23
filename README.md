# pixnew

這個 repo 目前放兩個獨立專案:

| 專案 | 內容 | 說明 |
|---|---|---|
| [`unity/`](unity/) + [`docs/`](docs/) | **AI 魚缸公寓** — Unity 2D 觀察箱遊戲 | 見下方 |
| [`epl/`](epl/) | **英超戰情室** — 英超比賽分析平台 | 球員 / 戰術 / 教練 / 動態 / 賽果預測,Node + 原生前端,`cd epl && npm run build && npm run serve` |

---

# AI 魚缸公寓(暫定名)

> 靈感來自林亦 LYi《我让六个AI合租,居然出了个海王?》與史丹佛 Generative Agents 論文。
> 玩家扮演「節目製作人」,俯視一間像素公寓,觀察 6 個由大語言模型驅動的 AI 室友自主生活、
> 社交、發展關係,並透過「事件卡」介入劇情走向。

**引擎:Unity(2D)** — Unity 專案位於 [`unity/`](unity/) 資料夾。

## 專案文檔

| 文檔 | 內容 |
|---|---|
| [docs/00-交接狀態.md](docs/00-交接狀態.md) | **從這裡開始**:目前進度、已知風險、本地接手起手式 |
| [docs/01-製作架構文檔.md](docs/01-製作架構文檔.md) | 遊戲定位、技術選型、系統架構、資料模型、成本設計 |
| [docs/02-開發流程文檔.md](docs/02-開發流程文檔.md) | 里程碑 M0~M4、協作循環、驗收標準、風險管理 |
| [docs/03-交辦事項文檔.md](docs/03-交辦事項文檔.md) | 所有任務的分工表(製作人 / 架構師 / AI 助手) |
| [docs/04-AI助手提示詞文檔.md](docs/04-AI助手提示詞文檔.md) | 每個開發任務的完整可複製提示詞 |

## 核心決策速覽

- **遊戲形式**:上帝視角觀察箱(玩家不操控角色,投放事件觀察湧現劇情)
- **引擎**:Unity 2022.3 LTS 以上(Unity 6 亦可),2D Tilemap
- **AI 大腦**:Anthropic API 分層 — Haiku 4.5 跑日常決策、Sonnet 5 跑對話/反思/規劃
- **部署**:單機自玩(Windows 桌面)
- **語言**:全繁體中文(UI 字型:Cubic 11)
- **開發路線**:MVP 先行(M1 → M4 逐步進化)

## 快速啟動(M0 骨架已就緒)

1. 安裝 **Unity Hub** 與 **Unity 2022.3 LTS 以上**。
2. Unity Hub → **Add(加入專案)** → 選擇本 repo 的 `unity/` 資料夾 → 開啟(首次會建索引)。
3. 素材:✅ 已解壓到 `unity/Assets/Art/Raw~/ModernInteriors/`(`~` 結尾 = Unity 不匯入,
   避免 5 萬張 PNG 拖垮開啟;盤點見 [docs/licenses/assets-inventory.md](docs/licenses/assets-inventory.md))。
   字型 `.ttf` 放 `unity/Assets/Art/Fonts/`(Cubic 11 尚待下載)。
4. API key:把 `unity/Assets/StreamingAssets/config.example.json` 複製為同資料夾的
   `config.json`,填入 Anthropic API key(此檔不進版控)。沒填也能跑,會是 mock 模式。
5. 開任意場景(如 SampleScene)→ Hierarchy 按右鍵 **Create Empty** → 選取後
   **Add Component → Bootstrap** → 按 **Play**。
6. 應看到:標題、跳動的模擬時鐘(第 N 天 HH:MM)、速度按鈕(⏸/1x/4x/16x,
   鍵盤空白/1/2/3),與「測試 LLM 連線」按鈕(填了 key 後按應回 ✅ 並顯示花費)。

## 分工模式

- **製作人(你)**:創意決策(角色人設、事件卡)、Unity Editor 實機驗收、提供 API key 與素材
- **架構師(Claude)**:系統設計、任務拆解、提示詞撰寫、程式碼撰寫與審查
- **AI 助手**:依照 `docs/04` 的提示詞逐一執行開發任務
