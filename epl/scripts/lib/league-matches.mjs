/* 聯賽賽果的單一入口(**兩個聯賽共用**:西甲 SP1、英冠 E1)。
 *
 * 為什麼要有這一層:openfootball 是主來源,但它**會缺比分**:
 * 西甲 2024-25 少了最後一輪 10 場(370/380)。
 * 少掉的不是小事:模型少吃那些場、積分榜少算那些場,
 * 而且畫面上會顯示成「未賽」—— 讀者看不出是上游沒補,只會以為那些比賽不存在。
 *
 * football-data.co.uk 有那些場次,而且是**完全獨立的來源**。
 * 但不是拿來就用(鐵則五):先拿兩邊都有的場次逐場核對比分,
 * **只要有一場對不上就整份不採用** —— 那種時候該做的是查清楚,不是挑著用。
 *
 * 補進來的場次會標 scoreSource,畫面與報告要講得出「這一場的比分不是主來源給的」。
 *
 * 這一份原本叫 laliga-matches.mjs、div 寫死 'SP1'。英冠要用同一套邏輯,
 * 複製一份過去的話改了一邊另一邊會悄悄過期(CLAUDE.md 講過的坑,而且犯過),
 * 所以抽成這裡,laliga-matches.mjs 改成薄包裝。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadMatches } from './adapters/index.mjs';
import { parseOddsCsv } from './odds.mjs';

/* 用備援來源補上主來源缺的比分。
   回傳 { filled, checked, mismatches } —— 呼叫端要把它印出來,
   不要靜靜補完(補比分是會影響每一個機率的事)。 */
export function backfillScores(matches, csvText, codeOf, { div = 'SP1' } = {}) {
  const { matches: alt } = parseOddsCsv(csvText, { codeOf, div });
  const byKey = new Map(alt.filter(m => m.fh != null && m.fa != null).map(m => [`${m.home}|${m.away}`, m]));

  /* 鍵是「主隊|客隊」,而**那在有附加賽的聯賽裡不唯一**。
     英冠季末的升級附加賽由聯賽裡的四隊互打,2023-24 就出現
     附加賽 NOR|LEE 0-0 與聯賽 NOR|LEE 2-3 撞同一個鍵 ——
     第一版因此每季報 5 場「比分不符」、整份不採用,看起來像上游資料衝突,
     其實是我們自己的鍵撞了(5 場正好是準決賽 4 + 決賽 1)。

     備援來源(football-data.co.uk)本來就只有聯賽,所以非聯賽的場次直接不參與:
     既不拿來核對,也不補比分。 */
  const league = matches.filter(m => !m.stage);
  /* 排除附加賽之後鍵仍然重複的話,那就不是附加賽的問題了 ——
     那代表這一季的賽程本身有問題,補比分會補到錯的場次上,寧可整份不做。 */
  const seen = new Set(), dup = [];
  for (const m of league) {
    const k = `${m.home}|${m.away}`;
    if (seen.has(k)) dup.push(k); else seen.add(k);
  }
  if (dup.length) return { filled: 0, checked: 0, mismatches: [], duplicateKeys: [...new Set(dup)] };

  // 先核對:兩邊都有比分的場次必須完全一致
  const mismatches = [];
  let checked = 0;
  for (const m of league) {
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
  for (const m of league) {
    if (m.played) continue;
    const a = byKey.get(`${m.home}|${m.away}`);
    if (!a) continue;
    Object.assign(m, { played: true, fh: a.fh, fa: a.fa, scoreSource: 'football-data.co.uk' });
    filled++;
  }
  return { filled, checked, mismatches };
}

/* 某一季的賽果。fill=false 可以拿到「純 openfootball」的版本(測試用)。 */
export function leagueMatches(root, season, {
  codeOf, kickoffOf, competition, rawDir, fillDir, div, fill = true, stageOf = null,
} = {}) {
  const matches = loadMatches({
    root, competition, season, codeOf, rawDir, ...(kickoffOf ? { kickoffOf } : {}),
  });
  /* 非聯賽場次(英冠的升級附加賽)要在**補比分之前**標好。
     第一版是拿到 matches 之後才標的,於是 backfillScores 看不到 stage、
     附加賽照樣參與配對,主客組合撞鍵 —— 每季 5 場假警報。
     順序本身就是這個 bug,所以標記收進這裡。 */
  if (stageOf) for (const m of matches) { const st = stageOf(m); if (st) m.stage = st; }
  if (!fill || !fillDir) return { matches, backfill: null };
  const csv = join(root, 'data', 'raw', fillDir, `${season}.csv`);
  if (!existsSync(csv)) return { matches, backfill: null };
  const r = backfillScores(matches, readFileSync(csv, 'utf8'), codeOf, { div });
  return { matches, backfill: r };
}

/* 歐洲夏令時間的開球時間。openfootball 給當地鐘面時間但不帶時區,
   要照該國時區補上 offset,否則冬季賽事會整批錯移一小時。

   歐盟與英國的夏令規則相同(三月最後一個週日起、十月最後一個週日止),
   差別只在基準時區:西班牙 CET(+01/+02)、英格蘭 GMT(+00/+01)。
   這一份原本在 build-laliga 與 build-championship 各有一份 ——
   同一條規則寫兩次,哪天有人在其中一份修了邊界條件,另一份就悄悄過期。 */
const lastSunday = (year, month) => {
  const d = new Date(Date.UTC(year, month, 0));
  return d.getUTCDate() - d.getUTCDay();
};
export const europeanKickoff = ({ summer, winter }) => m => {
  if (!m.time) return null;
  const [year, month, day] = m.date.split('-').map(Number);
  const isSummer = (month > 3 && month < 10)
    || (month === 3 && day >= lastSunday(year, 3))
    || (month === 10 && day < lastSunday(year, 10));
  return `${m.date}T${m.time}:00${isSummer ? summer : winter}`;
};

// 把 backfill 報告印成一行。呼叫端一律要印 —— 補比分不能靜靜發生。
export function backfillLine(season, r) {
  if (!r) return null;
  if (r.duplicateKeys?.length) {
    return `  ⚠ ${season} 主客組合有重複(${r.duplicateKeys.join('、')}),補比分可能補到錯的場次,整份不做`;
  }
  if (r.mismatches.length) {
    return `  ⚠ ${season} 備援來源與主來源有 ${r.mismatches.length} 場比分不符,整份不採用`
      + `(${r.mismatches.slice(0, 3).map(m => `${m.key} ${m.ours.join('-')}≠${m.theirs.join('-')}`).join('、')})`;
  }
  return r.filled
    ? `  ${season}:主來源缺 ${r.filled} 場比分,由 football-data.co.uk 補上(${r.checked} 場重疊逐場核對一致)`
    : null;
}
