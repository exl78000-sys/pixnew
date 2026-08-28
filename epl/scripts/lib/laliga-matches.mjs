/* 西甲賽果的入口 —— **邏輯在 lib/league-matches.mjs**,這裡只綁西甲的參數。
 *
 * 原本整套實作在這個檔案裡、div 寫死 'SP1'。英冠要用一模一樣的
 * 「主來源缺比分 → 用獨立來源核對後補上」流程,複製一份過去的話,
 * 改了一邊另一邊會悄悄過期(CLAUDE.md 陷阱表裡那條租借姓名配對就是這樣掛掉的)。
 * 所以邏輯抽走、這裡留薄包裝 —— 既有的六個呼叫端一行都不用改。
 */
import { leagueMatches } from './league-matches.mjs';
export { backfillScores, backfillLine } from './league-matches.mjs';

const COMPETITION = 'esp.1';
const RAW_DIR = 'openfootball-la-liga';
const FILL_DIR = 'football-data-couk-la-liga';

export function laligaMatches(root, season, { codeOf, kickoffOf, fill = true } = {}) {
  return leagueMatches(root, season, {
    codeOf, kickoffOf, fill,
    competition: COMPETITION, rawDir: RAW_DIR, fillDir: FILL_DIR, div: 'SP1',
  });
}
