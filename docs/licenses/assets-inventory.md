# 素材盤點清單(M0-T2)

盤點日期:2026-07-13|盤點人:本地 AI 助手
素材來源:製作人本機 `C:\Users\Gon\Desktop\素材`

## 素材包總覽

| 檔案 | 大小 | 處置 |
|---|---|---|
| `moderninteriors-win.zip` | 156 MB | ✅ 已解壓到 `unity/Assets/Art/Raw~/ModernInteriors/`(53,329 個檔案,155.8 MB) |
| `Modern_Interiors_Free_v2.2.zip` | 1.1 MB | 略過 —— 為完整版的子集,無需重複 |
| `Modern_Interiors_RPG_Maker_Version.zip` | 8.6 MB | 略過 —— RPG Maker 格式,Unity 用不到 |
| `Character Generator 2.0 Setup.exe` | 73 MB | 未安裝 —— LimeZu 官方角色產生器工具(Windows),製作人設計 6 位室友外觀時可安裝使用,產出的 spritesheet 再交給 AI 助手 |
| `Character Generator 2.0 Linux Build.zip` | 98 MB | 略過 —— Linux 版,本機為 Windows |

> **為何放 `Raw~` 而不是 `Raw`**:資料夾名結尾帶 `~` 時 Unity 不會匯入其內容。
> 素材包有 5.3 萬個 PNG,若直接進 `Assets/Art/Raw/`,首次開專案會建立數萬筆 import 紀錄,
> 嚴重拖慢開啟與後續操作。M1-T1 整理素材時,才把選用的圖挑進正式匯入資料夾。
> `.gitignore` 已涵蓋 `Raw~/`(授權禁止再散布,絕不進版控)。

## 主包內容結構(ModernInteriors/)

| 資料夾 | 內容 | 備註 |
|---|---|---|
| `1_Interiors/` | 室內磁磚與家具圖集,16/32/48px 三種尺寸 | 每尺寸含 `Room_Builder_*.png`(建牆地板)與 `Interiors_*.png`(家具),另有主題分類版(Theme_Sorter)與去陰影版 |
| `2_Characters/Character_Generator/` | 角色素材:20 個預製角色 + 部件庫(Bodies/Eyes/Hairstyles/Outfits/Accessories,含兒童版) | 含 `Spritesheet_animations_GUIDE.png` 動畫佈局說明 |
| `3_Animated_objects/` | 動畫物件(電視、時鐘、飲水機等),16/32/48px,gif 預覽 + spritesheets | |
| `4_User_Interface_Elements/` | UI 圖集與思考表情氣泡動畫,16/32/48px | 表情氣泡可直接用於對話/情緒顯示 |
| `6_Home_Designs/` | 現成室內設計範例(公寓、電視攝影棚、健身房等) | 有 `TV_Studio_Designs` 與 `Condominium_Designs`,可作公寓場景參考 |
| `Palettes/` | 調色盤 | |
| `LICENSE.txt`、`READ_ME.txt` | 授權與說明 | |

## 關鍵規格(M1-T1 需要)

- **像素尺寸**:16 / 32 / 48px 三套齊全。公寓俯視 + 六人同屏,建議 M1-T1 以 **32x32** 為基準(畫面資訊密度與可讀性折衷;16px 太小、48px 檔案大)。最終由架構師裁定。
- **角色行走圖**:✅ 有。20 個預製角色,32px 版 spritesheet 為 1792x1312(多列動畫:走路四向、idle、坐、手機等,詳見 `Spritesheet_animations_GUIDE.png`)。
- **角色自訂**:Character Generator 部件庫齊全,亦有官方桌面工具(見上表)。
- **字型**:❌ 素材資料夾內**沒有** Cubic 11 字型檔(.ttf)。需製作人另行下載(免費,SIL OFL 授權,https://github.com/ACh-K/Cubic-11),放入 `unity/Assets/Art/Fonts/`。

## 授權(Modern Interiors 完整版)

出處:limezu.itch.io(LICENSE.txt 原文收錄於素材包內)

- ✅ 可用於商業與非商業專案(含改作)
- ❌ 不可轉售或再散布素材(含改作後轉售)—— **因此素材只留本機,已由 .gitignore 排除**
- ⚠️ 需標註出處:`limezu.itch.io`(遊戲上架/發布時記得放 credits)
- ⬜ 授權頁截圖:待製作人到 itch.io 購買頁截圖存入本資料夾(`docs/licenses/`)
