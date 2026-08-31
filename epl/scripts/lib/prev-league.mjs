/* 升降級球隊「上季在別的聯賽」的成績。
 *
 * 為什麼需要:升班隊在新聯賽的 `lastSeason` 是空的(去年不在這裡),
 * 球隊頁的上季區塊因此整塊空白 —— 而那一季的資料本站其實有,
 * 只是躺在另一個聯賽的目錄裡(COV/HUL 2025-26 在英冠)。
 *
 * 三條界線:
 * 1. **只做本站真的有那個聯賽的方向**。英超↔英冠雙向都有;
 *    西甲的升班隊來自西乙、英冠的升班隊來自英甲 —— 本站沒有那兩個聯賽,
 *    就回空的,畫面照實說「上一季不在本站涵蓋的聯賽」,不留空欄位。
 * 2. **產物形狀跟 lastSeason 一模一樣**(同一支 buildTable 算的),
 *    前端才能重用同一組渲染;另外掛 league 標籤,因為
 *    **不同聯賽的名次與積分不可互比** —— 那要寫在畫面上。
 * 3. **兩個 build 共用這一支**,不各寫一份(改了一邊另一邊會悄悄過期)。
 */
import { buildTable } from './table.mjs';
import { leagueMatches } from './league-matches.mjs';
import { loadTeams } from './teams.mjs';

/* 本站有哪些聯賽可以當「上一季的來源」。鍵是聯賽代碼,不寫死方向 ——
   升班(英冠→英超)與降級(英超→英冠)用的是同一張表。 */
export const PREV_LEAGUE_SOURCES = {
  pl: {
    zh: '英超', teamsFile: undefined, competition: 'eng.1',
    rawDir: 'openfootball', fillDir: 'football-data-couk', div: 'E0',
  },
  en2: {
    zh: '英冠', teamsFile: 'teams-championship.json', competition: 'eng.2',
    rawDir: 'openfootball-championship', fillDir: 'football-data-couk-championship', div: 'E1',
    /* 升級附加賽不是聯賽比賽 —— 跟英冠自己的 build 同一條規則,
       不排除的話名次與積分會跟英冠站上顯示的對不起來。 */
    stageOf: m => (m.round == null ? '升級附加賽' : null),
  },
};

/* 從 `from` 聯賽的 `season` 賽季,取出 `codes` 這幾支球隊的成績。
   回傳 Map(code → { league, leagueKey, ...跟 lastSeason 同形狀 })。
   來源不存在(沒有那個聯賽的原始檔)就回空 Map,不丟例外 —— 缺資料不是錯誤。 */
export function previousLeagueRecords(ROOT, { from, season, codes, kickoffOf }) {
  const src = PREV_LEAGUE_SOURCES[from];
  const wanted = new Set(codes ?? []);
  if (!src || !wanted.size) return new Map();
  let matches;
  try {
    const T = loadTeams(ROOT, src.teamsFile ? { file: src.teamsFile } : undefined);
    ({ matches } = leagueMatches(ROOT, season, {
      codeOf: T.codeOf, kickoffOf,
      competition: src.competition, rawDir: src.rawDir, fillDir: src.fillDir, div: src.div,
      stageOf: src.stageOf,
    }));
  } catch { return new Map(); }
  const league = (matches ?? []).filter(m => !m.stage);
  if (!league.some(m => m.played)) return new Map();
  /* 名次要用**該聯賽全部球隊**排,不能只排我們要的那兩隊 ——
     只排兩隊的話 COV 會變成「第 1 名」,而它在英冠是第幾名才是事實。 */
  const allCodes = [...new Set(league.flatMap(m => [m.home, m.away]))];
  const table = buildTable(league, allCodes);
  const out = new Map();
  for (const row of table) {
    if (!wanted.has(row.code)) continue;
    out.set(row.code, { league: src.zh, leagueKey: from, season, teams: allCodes.length, ...row });
  }
  return out;
}
