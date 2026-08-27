# pixnew

**英超戰情室(PL War Room)** —— 以英超為準的比賽分析平台。
球員、戰術、教練、動態、預測五個面向,全部建立在真實資料上。

```bash
cd epl
npm run build     # 跑分析引擎,產生前端資料集
npm run serve     # 開 http://localhost:5173
```

完整說明(資料來源、分析引擎、AI 報告層、換季流程、已知限制)見
**[`epl/README.md`](epl/README.md)**。

---

## 這個 repo 有什麼

| 路徑 | 內容 |
|---|---|
| [`epl/`](epl/) | 英超戰情室的全部程式碼、資料與網站 |
| `.github/workflows/epl-live.yml` | 手動抓資料、重建網站並部署（本機完成後一次發布） |

---

## 歷史紀錄:AI 魚缸公寓

這個 repo 曾經同時放著另一個獨立專案「**AI 魚缸公寓**」(Unity 2D 觀察箱遊戲,
位於 `unity/` 與 `docs/`)。為了讓 repo 聚焦在單一專案,已於 **2026-08-24** 移除。

**內容沒有遺失**,可以從三個地方取回:

```bash
# 備份分支(移除前的完整狀態)
git fetch origin backup/fishtank-apartment-2026-08-24
git checkout backup/fishtank-apartment-2026-08-24 -- unity docs

# 或直接從最後一次改動的 commit 取回
git checkout e7095bc -- unity docs
```

git 不會真的刪掉任何東西 —— 舊 commit 裡的檔案永遠找得回來。

> 素材 PNG(LimeZu 授權禁止再散布)與含 API key 的 `config.json`
> 從一開始就沒有進過版控,不在上述任何快照內;`.meta` 檔都在,GUID 不會斷。
