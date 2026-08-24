// 資料來源設定 —— 換賽季只要改這裡
// 賽事定義在 lib/canonical.mjs 的 COMPETITIONS;這裡只指定「現在要跑哪一個」。
export const COMPETITION = 'eng.1';
export const CURRENT_SEASON = '2026-27';   // 進行中賽季(賽程 / 現役名單 / 傷病)
export const LAST_SEASON = '2025-26';      // 最近一個完整賽季(所有進階數據的基準)
export const HISTORY_SEASONS = ['2023-24', '2024-25', '2025-26']; // 交手紀錄與長期趨勢

const OF = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const FPL = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';

export function sourceList() {
  const list = [];
  for (const s of [...new Set([...HISTORY_SEASONS, CURRENT_SEASON])]) {
    list.push({ url: `${OF}/${s}/en.1.json`, file: `openfootball/${s}.json`, label: `賽果/賽程 ${s}` });
  }
  for (const s of [...new Set([LAST_SEASON, CURRENT_SEASON])]) {
    list.push({ url: `${FPL}/${s}/players_raw.csv`, file: `fpl/${s}-players.csv`, label: `球員數據 ${s}` });
    list.push({ url: `${FPL}/${s}/teams.csv`, file: `fpl/${s}-teams.csv`, label: `球隊強度 ${s}` });
  }
  list.push({ url: `${FPL}/${CURRENT_SEASON}/fixtures.csv`, file: `fpl/${CURRENT_SEASON}-fixtures.csv`, label: `賽程難度 ${CURRENT_SEASON}` });
  return list;
}

export const ATTRIBUTION = [
  { name: 'openfootball / football.json', url: 'https://github.com/openfootball/football.json', use: '英超賽程、比分(含半場)', license: 'Public Domain' },
  { name: 'vaastav / Fantasy-Premier-League', url: 'https://github.com/vaastav/Fantasy-Premier-League', use: '球員進階數據、傷停狀態、賽程難度', license: 'FPL 官方 API 鏡像' },
];
