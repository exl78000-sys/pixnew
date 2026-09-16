/* 往季賽後報告的逐場檔(2026-09-16)。

   為什麼不塞進 `reports.json`:那一份是**首頁與單場頁整份載**的
   (`page-index.js` 與 `page-analysis.js` 都在 `C.load` 清單裡)。
   本季已經 1.6~4.9 MB;把上一季加進去,六個聯賽合計 2,302 場、一場約 60 KB ——
   首頁會變成幾十 MB。所以照**盃賽那條路**(`cup-details/{盃賽}/{季}/{id}.json`,
   2026-09-13 起,同樣的理由量過):索引留在 `reports.json`(只有 id),
   報告本身一場一個檔,讀者點開那一場才載。

   **檔案內容必須逐次建置位元組相同。** 部署一天跑兩次而且每次整份重寫;
   報告裡只要有一個時間戳,每次部署就會往 git 塞 2,302 個新 blob
   (一次約 138 MB)。`buildProviderMatchReport` 的輸出本身沒有時間戳 ——
   這一支也不准自己加,`npm test` 有一條守著(連跑兩次 build 之後檔案的 mtime 可以變、
   內容不准變)。盃賽那一份也是這樣才活得下來。

   清掉舊檔的範圍**只限這一季這一個聯賽的目錄**,而且只刪 `{id}.json` ——
   跟盃賽同一個寫法。整個目錄 rm 的話,哪天有人把別的東西放進來就會被連坐。 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* reports 是「季|主|客」→ 報告;idOf 把那個鍵換成場次 id(檔名)。
   回傳索引與統計 —— 索引只有 id,因為**報告檔自己就帶 home / away / hs / as / season**,
   單場頁拿到檔案就畫得出來,不必再載 results.json(那是 274 KB)。 */
export function writeMatchArchive({ outDir, reports, season, idOf, extraOf = () => ({}) }) {
  const dir = join(outDir, 'match-reports', season);
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));

  const ids = [];
  let bytes = 0;
  const missingId = [];
  for (const [key, report] of Object.entries(reports)) {
    if (!key.startsWith(`${season}|`)) continue;
    const id = idOf(key);
    /* id 查不到就**不寫**:檔名是網址的一部分,編一個出來的話讀者點進去會是 404,
       而索引會說「這一場有報告」——「按鈕在但點了沒東西」。記下來讓 build 印出人數。 */
    if (!id) { missingId.push(key); continue; }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    /* 報告本身沒有 `round` / `date` / `id`(那是賽程的欄位),而單場頁的頁首要印輪次。
       寫進檔案裡讓**逐場檔自足** —— 不然單場頁為了一個輪次要去載 results.json(274 KB)。
       這幾個都是靜態資料,不影響位元組穩定。 */
    const str = JSON.stringify({ ...report, ...extraOf(key), id });
    writeFileSync(join(dir, `${id}.json`), str);
    bytes += str.length;
    ids.push(id);
  }
  ids.sort();   // 索引排序,不然鍵的順序會跟著 Object 的插入順序漂,產物每次都不一樣
  return { season, count: ids.length, ids, kb: Math.round(bytes / 1024), missingId };
}

/* 「季|主|客」當鍵在**有附加賽的聯賽**裡不唯一(英冠季末的升級附加賽由聯賽裡的四隊互打,
   2023-24 就出現過附加賽 `NOR|LEE 0-0` 與聯賽 `NOR|LEE 2-3` 撞同一個鍵)。
   撞到的話 `reports` 本來就只留得下一份,而這裡再挑一個 id 去命名檔案,
   等於**把某一場的報告掛到另一場的網址上** —— 比沒有檔案糟得多。
   所以撞鍵的一律不寫,由呼叫端印出來。 */
export function idMapForArchive(matches) {
  const map = new Map();
  const duplicates = new Set();
  for (const m of matches) {
    const k = `${m.season}|${m.home}|${m.away}`;
    if (map.has(k)) duplicates.add(k); else map.set(k, m);
  }
  for (const k of duplicates) map.delete(k);
  return { map, duplicates: [...duplicates] };
}
