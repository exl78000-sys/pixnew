/* 即時比分走的那條分支(2026-10-30,補齊規劃 D3 方案 A)。

   比賽夜的兩支迴圈原本每 2~3 分鐘把比分與整份 web/data 提交到**預設分支**,一個比賽夜幾十則
   「chore: 比賽中更新」,預設分支的歷史被它們淹掉,倉庫也一直長大。改成推到這條獨立分支,
   部署那一支每次把它併回預設分支(一則提交)再把它重設成一則 —— 歷史最多留到下一次部署(12 小時)。
   流程在 `scripts/live-data.mjs`;前端讀 raw 的網址從這裡組,分支名只寫這一次。 */
export const LIVE_BRANCH = 'live-data';

/* 只有在 Actions 裡建置時才知道 repo;本機建置回 null,前端自動退回讀本地檔。
   **不再看 GITHUB_REF_NAME** —— 比分不在建置的那條分支上,在 LIVE_BRANCH 上。 */
export const liveFeedUrl = (path, env = process.env) => env.GITHUB_REPOSITORY
  ? `https://raw.githubusercontent.com/${env.GITHUB_REPOSITORY}/${LIVE_BRANCH}/${path}`
  : null;

/* 部署重設這條分支時,一定要帶上的檔:前端從 raw 讀的三份 feed。
   它們是建置產物、不在部署的回寫清單裡,重設時不帶的話,下一次比賽夜之前 raw 那一條就是 404。 */
export const FEED_PATHS = [
  'epl/web/data/live.json',
  'epl/web/data/cups-live.json',
  'epl/web/data/leagues/es1/live.json',
];

/* 標記「這一則是部署併回預設分支之後重設的」。overlay 只拿這一則之後改過的檔 ——
   之前的部分已經在預設分支上了,而且預設分支那份可能更新(部署自己又抓過一次)。 */
export const ABSORBED_MARK = 'live-data-absorbed';
