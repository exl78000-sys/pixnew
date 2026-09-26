/* 賽後報告的逐場檔(往季 2026-09-16 起;本季 2026-09-26 起也是)。

   為什麼不塞進 `reports.json`:那一份是**首頁與單場頁整份載**的
   (`page-index.js` 與 `page-analysis.js` 都在 `C.load` 清單裡)。
   往季那次量過:六個聯賽合計 2,302 場、一場約 60 KB,塞進去首頁會變成幾十 MB。
   本季那次(2026-09-26)量的是正式站:英超 `reports.json` 3.2 MB(解壓後),首頁載它
   只回答「這場有沒有賽後報告」、單場頁載它只用其中一場 —— 兩頁都在為一個布林值付 3 MB,
   而且 `live.json` 裡還有一份一模一樣的 advanced 與 sides。
   所以本季也照**盃賽那條路**(`cup-details/{盃賽}/{季}/{id}.json`,2026-09-13 起):
   索引留在 `reports.json`(`index`:「季|主|客」→ 場次 id;往季是 `archive.ids`),
   報告本身一場一個檔,讀者點開那一場才載。

   **檔案內容必須逐次建置位元組相同。** 部署一天跑兩次而且每次整份重寫;
   報告裡只要有一個時間戳,每次部署就會往 git 塞 2,302 個新 blob
   (一次約 138 MB)。`buildProviderMatchReport` 的輸出本身沒有時間戳 ——
   這一支也不准自己加,`npm test` 有一條守著(連跑兩次 build 之後檔案的 mtime 可以變、
   內容不准變)。盃賽那一份也是這樣才活得下來。

   清掉舊檔的範圍**只限這一季這一個聯賽的目錄**,而且只刪 `{id}.json` ——
   跟盃賽同一個寫法。整個目錄 rm 的話,哪天有人把別的東西放進來就會被連坐。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* reports 是「季|主|客」→ 報告;idOf 把那個鍵換成場次 id(檔名)。
   回傳索引與統計 —— 索引只有 id,因為**報告檔自己就帶 home / away / hs / as / season**,
   單場頁拿到檔案就畫得出來,不必再載 results.json(那是 274 KB)。
   `ids` 是排好序的 id 清單(往季的索引:單場頁要認得「這個 id 是不是往季的」),
   `index` 是「鍵 → id」(本季的索引:賽程表要用鍵問「這場有沒有」)。兩個都給,呼叫端各取所需。
   不是這一季的鍵**不寫、也不進索引**,但收在 `otherSeason` 回報 —— 靜靜略過的話,
   索引說「沒有」而報告其實建過了,而畫面完全正常。 */
export function writeMatchArchive({ outDir, reports, season, idOf, extraOf = () => ({}) }) {
  const dir = join(outDir, 'match-reports', season);
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));

  const ids = [];
  const index = {};
  let bytes = 0;
  const missingId = [];
  const otherSeason = [];
  for (const [key, report] of Object.entries(reports)) {
    if (!key.startsWith(`${season}|`)) { otherSeason.push(key); continue; }
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
    index[key] = id;
  }
  ids.sort();   // 索引排序,不然鍵的順序會跟著 Object 的插入順序漂,產物每次都不一樣
  const sortedIndex = Object.fromEntries(Object.entries(index).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { season, count: ids.length, ids, index: sortedIndex, kb: Math.round(bytes / 1024), missingId, otherSeason };
}

/* 讀回逐場檔(Node 端用:測試、Obsidian、單檔打包)。
   回傳的形狀跟 2026-09-26 之前整份內嵌的 `reports.json` 一樣 ——
   `{ ...索引, reports: { 鍵 → 報告本體 } }` —— 所以既有的檢查邏輯不必重寫,只換讀法。
   本體的路徑從**鍵的季**組(`match-reports/{季}/{id}.json`),不另外存季:鍵本來就帶季。
   索引指到而檔案不在的,收進 `missing` 讓呼叫端決定要不要紅 —— 這裡不擋,測試才擋。 */
export function readMatchReports(dir) {
  const idxPath = join(dir, 'reports.json');
  if (!existsSync(idxPath)) return null;
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  const reports = {};
  const missing = [];
  for (const [key, id] of Object.entries(idx.index ?? {})) {
    const fp = join(dir, 'match-reports', key.split('|')[0], `${id}.json`);
    if (!existsSync(fp)) { missing.push(key); continue; }
    reports[key] = JSON.parse(readFileSync(fp, 'utf8'));
  }
  return { ...idx, reports, missing };
}

/* 讀回**往季**的逐場檔(Node 端用;2026-09-26 為 Obsidian vault 加的:「上季聯賽的賽後報告也存進去」)。
   `readMatchReports` 只讀本季的 `index` —— 它的呼叫端(測試、單檔打包)要的就是本季,不能改它的意思。
   往季的索引是 `reports.archive.ids`(只有 id),所以鍵從**檔案自己帶的** season / home / away 組,
   回傳同一個形狀:「季|主|客」→ 報告本體。
   兩種不採用,各自收起來讓呼叫端講:索引指到而檔案不在(`missing`)、
   檔案的季跟索引宣告的不同或兩個檔組出同一個鍵(`conflicts`,**兩個都不用** ——
   挑一個等於把某一場的報告掛到另一場上,跟 `idMapForArchive` 同一個理由)。 */
export function readArchivedReports(dir) {
  const idxPath = join(dir, 'reports.json');
  if (!existsSync(idxPath)) return null;
  const a = JSON.parse(readFileSync(idxPath, 'utf8')).archive;
  const reports = {};
  const missing = [];
  const conflicts = [];
  if (!a?.season || !a.ids?.length) return { season: a?.season ?? null, reports, missing, conflicts };
  const byKey = new Map();   // 鍵 → [{ id, r }]
  for (const id of a.ids) {
    const fp = join(dir, 'match-reports', a.season, `${id}.json`);
    if (!existsSync(fp)) { missing.push(id); continue; }
    const r = JSON.parse(readFileSync(fp, 'utf8'));
    if (r.season !== a.season) { conflicts.push(id); continue; }
    const key = `${r.season}|${r.home}|${r.away}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ id, r });
  }
  for (const [key, list] of byKey) {
    if (list.length === 1) reports[key] = list[0].r;
    else conflicts.push(...list.map(x => x.id));
  }
  return { season: a.season, reports, missing, conflicts };
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
