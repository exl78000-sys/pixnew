// 資料來源設定 —— 換賽季只要改這裡
// 賽事定義在 lib/canonical.mjs 的 COMPETITIONS;這裡只指定「現在要跑哪一個」。
export const COMPETITION = 'eng.1';
export const CURRENT_SEASON = '2026-27';   // 進行中賽季(賽程 / 現役名單 / 傷病)
export const LAST_SEASON = '2025-26';      // 最近一個完整賽季(所有進階數據的基準)
export const HISTORY_SEASONS = ['2023-24', '2024-25', '2025-26']; // 進模型的訓練窗

/* 只給「歷來交手」用的更早賽季 —— 刻意**不進模型**。
   為什麼分開:訓練窗放太長會讓 Poisson 的時間衰減與 Elo 的跨季繼承一起走樣,
   那是動到預測本身,要重跑回測才知道好壞。但交手紀錄是給人看的資訊,
   多幾季只是讓「歷來對戰」名副其實,不影響任何一個機率數字。
   這些檔案是 optional:上游沒有就跳過,不讓 fetch 失敗。 */
export const H2H_EXTRA_SEASONS = ['2018-19', '2019-20', '2020-21', '2021-22', '2022-23'];

/* 有逐場進球明細的賽季。檔案由外部協作產生(docs/提示詞A-逐場進球助攻.md),
   放在 data/raw/fpl/{season}-goals.json。沒有檔案的賽季會自動略過。
   本季(2026-27)上游還沒發布 gws,要等它出來才補得了。 */
export const GOAL_SEASONS = ['2024-25', '2025-26'];

const OF = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const FPL = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';

export function sourceList() {
  const list = [];
  for (const s of [...new Set([...HISTORY_SEASONS, CURRENT_SEASON])]) {
    list.push({ url: `${OF}/${s}/en.1.json`, file: `openfootball/${s}.json`, label: `賽果/賽程 ${s}` });
  }
  for (const s of H2H_EXTRA_SEASONS) {
    list.push({ url: `${OF}/${s}/en.1.json`, file: `openfootball/${s}.json`, label: `歷來交手 ${s}`, optional: true });
  }
  for (const s of [...new Set([LAST_SEASON, CURRENT_SEASON])]) {
    list.push({ url: `${FPL}/${s}/players_raw.csv`, file: `fpl/${s}-players.csv`, label: `球員數據 ${s}` });
    list.push({ url: `${FPL}/${s}/teams.csv`, file: `fpl/${s}-teams.csv`, label: `球隊強度 ${s}` });
  }
  /* 進球明細涵蓋的賽季,球員名冊也要有 —— 不然「誰進的」只查得到代碼查不到名字。
     2024-25 有 65 位進球者已經離開英超,他們的名字只存在於那一季的名冊裡。
     這是靜態檔,抓一次就不用再抓。 */
  for (const s of GOAL_SEASONS) {
    if (s === LAST_SEASON || s === CURRENT_SEASON) continue;
    list.push({ url: `${FPL}/${s}/players_raw.csv`, file: `fpl/${s}-players.csv`, label: `球員名冊 ${s}(進球明細用)`, optional: true });
  }
  list.push({ url: `${FPL}/${CURRENT_SEASON}/fixtures.csv`, file: `fpl/${CURRENT_SEASON}-fixtures.csv`, label: `賽程難度 ${CURRENT_SEASON}` });
  return list;
}

export const ATTRIBUTION = [
  { name: 'SportMonks', url: 'https://www.sportmonks.com/football-api/', use: '英超主要球員身分、頭貼、賽後陣容、評分、事件與球隊統計；資料先快取再建置', license: '訂閱 API 資料' },
  { name: 'openfootball / football.json', url: 'https://github.com/openfootball/football.json', use: '英超賽程、比分(含半場)', license: 'Public Domain' },
  { name: 'vaastav / Fantasy-Premier-League', url: 'https://github.com/vaastav/Fantasy-Premier-League', use: '球員進階數據、傷停狀態、賽程難度', license: 'FPL 官方 API 鏡像' },
  { name: '英超官方 (pulselive)', url: 'https://www.premierleague.com', use: '官方正式陣容、陣型、現任教練', license: '官網公開端點' },
  { name: 'Wikipedia / Wikimedia Commons', url: 'https://en.wikipedia.org/api/rest_v1/', use: '英超與西甲教練公開人物縮圖備援；官方有真實頭貼時優先官方', license: '依 Wikimedia 使用條款與圖片授權' },
  { name: 'API-Football', url: 'https://www.api-football.com/', use: 'SportMonks 尚未提供時的賽後資料與球員頭貼備援', license: 'API 方案資料' },
  { name: 'Understat', url: 'https://understat.com/league/EPL/2025', use: '上一完整賽季的運動戰、角球、定位球與直接任意球 xG/進失球', license: '公開頁面低頻率快取' },
  { name: 'football-data.co.uk', url: 'https://www.football-data.co.uk', use: '博彩收盤賠率(模型 vs 市場的基準)', license: '免費、可自由使用' },
];
