/* 西甲賽果的單一入口。
 *
 * 以前 build-laliga / backtest-laliga / fetch-setpieces 各自拼一次 loadMatches 的參數,
 * 三份設定要一起改才不會走鐘。這裡收成一份。
 *
 * 順帶解掉一個**上游資料缺口**:openfootball 的西甲 2024-25 少了最後一輪
 * 10 場的比分(370/380)。那 10 場不是小事 ——
 *   · 模型少吃 10 場訓練資料
 *   · fetch-setpieces 的逐場比分核對會因為場次對不上而**整季拒收**,
 *     於是進球情境特徵的驗收季先驗整個做不出來
 *
 * football-data.co.uk 的 SP1 檔有那 10 場,而且是**完全獨立的來源**。
 * 但不是拿來就用(鐵則五):先拿兩邊都有的 370 場逐場比分互相核對,
 * **只要有一場對不上就整份不採用**。實測 370/370 完全一致、0 場不符,
 * 所以那 10 場可以信。
 *
 * 補進來的場次會標 scoreSource,畫面與報告要講得出「這一場的比分不是主來源給的」。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadMatches } from './adapters/index.mjs';
import { parseOddsCsv } from './odds.mjs';

const COMPETITION = 'esp.1';
const RAW_DIR = 'openfootball-la-liga';
const FILL_DIR = 'football-data-couk-la-liga';

/* 用備援來源補上主來源缺的比分。
   回傳 { filled, checked, mismatches } —— 呼叫端要把它印出來,
   不要靜靜補完(補比分是會影響每一個機率的事)。 */
export function backfillScores(matches, csvText, codeOf) {
  const { matches: alt } = parseOddsCsv(csvText, { codeOf, div: 'SP1' });
  const byKey = new Map(alt.filter(m => m.fh != null && m.fa != null).map(m => [`${m.home}|${m.away}`, m]));

  // 先核對:兩邊都有比分的場次必須完全一致
  const mismatches = [];
  let checked = 0;
  for (const m of matches) {
    if (!m.played) continue;
    const a = byKey.get(`${m.home}|${m.away}`);
    if (!a) continue;
    checked++;
    if (a.fh !== m.fh || a.fa !== m.fa) {
      mismatches.push({ key: `${m.home}|${m.away}`, ours: [m.fh, m.fa], theirs: [a.fh, a.fa] });
    }
  }
  // 有一場對不上就整份不採用 —— 這種時候該做的是查清楚,不是挑著用
  if (mismatches.length) return { filled: 0, checked, mismatches };

  let filled = 0;
  for (const m of matches) {
    if (m.played) continue;
    const a = byKey.get(`${m.home}|${m.away}`);
    if (!a) continue;
    Object.assign(m, { played: true, fh: a.fh, fa: a.fa, scoreSource: 'football-data.co.uk' });
    filled++;
  }
  return { filled, checked, mismatches };
}

/* season 的西甲賽果。fill=false 可以拿到「純 openfootball」的版本(測試用)。 */
export function laligaMatches(root, season, { codeOf, kickoffOf, fill = true } = {}) {
  const matches = loadMatches({
    root, competition: COMPETITION, season, codeOf, rawDir: RAW_DIR, ...(kickoffOf ? { kickoffOf } : {}),
  });
  if (!fill) return { matches, backfill: null };
  const csv = join(root, 'data', 'raw', FILL_DIR, `${season}.csv`);
  if (!existsSync(csv)) return { matches, backfill: null };
  const r = backfillScores(matches, readFileSync(csv, 'utf8'), codeOf);
  return { matches, backfill: r };
}

// 把 backfill 報告印成一行。呼叫端一律要印 —— 補比分不能靜靜發生。
export function backfillLine(season, r) {
  if (!r) return null;
  if (r.mismatches.length) {
    return `  ⚠ ${season} 備援來源與主來源有 ${r.mismatches.length} 場比分不符,整份不採用`
      + `(${r.mismatches.slice(0, 3).map(m => `${m.key} ${m.ours.join('-')}≠${m.theirs.join('-')}`).join('、')})`;
  }
  return r.filled
    ? `  ${season}:主來源缺 ${r.filled} 場比分,由 football-data.co.uk 補上(${r.checked} 場重疊逐場核對一致)`
    : null;
}
