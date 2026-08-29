/* 近 N 場的風格位移(A 層)。
 *
 * 動機:風格雷達固定在上季全季 —— 樣本才夠大,但換了教練的球隊,
 * 雷達描述的是前任的打法(2026-27 開季實測 20 隊裡 10 隊換帥)。
 * 這一層拿**逐場可測的量**(射門、射正、角球、牌)做滾動視窗,
 * 跟上季基準比,把「打法變了沒」交給數字說。
 *
 * 幾個刻意的決定:
 *
 * - **單一來源跨季連續。** 逐場統計一律取 football-data.co.uk 的季檔 ——
 *   它從上季到本季用同一套欄位,滾動視窗跨過夏天不會換尺。
 *   xG 不放進滾動視窗:FPL 的逐場 xG 只有本季,上季的逐場 xG 沒有免費來源,
 *   混進來視窗前後就不是同一種數字。xG 另外以「本季至今」單獨標示。
 * - **升班馬沒有上季英超基準就不給 delta。** 拿英冠的射門數當基準,
 *   位移會把「聯賽變強」誤讀成「打法變了」。基準 null、畫面照實說。
 * - **不足 minGames 場不給位移。** 三場的平均是雜訊,給了會誤導。
 * - **這是資訊,不進模型**(跟近況五場同一個規矩,鐵則二)。
 */
import { parseCSVObjects, num } from './csv.mjs';
import { round } from './util.mjs';

// football-data 的日期是 dd/mm/yy(yy),轉 ISO 才能跟本站其他日期排序
const isoDate = s => {
  const m = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(s ?? '');
  if (!m) return null;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[2]}-${m[1]}`;
};

const FIELDS = ['sf', 'sa', 'stf', 'sta', 'cf', 'ca', 'cards', 'gf', 'ga'];

/* 一份季檔 → 每隊的逐場列(主客展開)。缺射門欄位的列跳過(未來場次)。 */
export function teamMatchRows(csvText, { codeOf, div = 'E0' } = {}) {
  const byTeam = new Map();
  for (const r of parseCSVObjects(csvText)) {
    if (div && r.Div !== div) continue;
    if (r.HS === '' || r.HS == null) continue;          // 沒統計 = 沒踢
    const date = isoDate(r.Date);
    const home = codeOf(r.HomeTeam), away = codeOf(r.AwayTeam);
    if (!date || !home || !away) continue;
    const side = (code, opp, pre, other, isHome) => {
      if (!byTeam.has(code)) byTeam.set(code, []);
      byTeam.get(code).push({
        date, opp, home: isHome,
        sf: num(r[pre + 'S']), sa: num(r[other + 'S']),
        stf: num(r[pre + 'ST']), sta: num(r[other + 'ST']),
        cf: num(r[pre + 'C']), ca: num(r[other + 'C']),
        cards: num(r[pre + 'Y']) + num(r[pre + 'R']),
        gf: num(pre === 'H' ? r.FTHG : r.FTAG),
        ga: num(pre === 'H' ? r.FTAG : r.FTHG),
      });
    };
    side(home, away, 'H', 'A', true);
    side(away, home, 'A', 'H', false);
  }
  for (const rows of byTeam.values()) rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return byTeam;
}

const avg = rows => {
  if (!rows.length) return null;
  const out = { games: rows.length };
  for (const f of FIELDS) out[f] = round(rows.reduce((s, r) => s + (r[f] ?? 0), 0) / rows.length, 2);
  return out;
};

/* 每隊:最近 window 場(跨季) vs 上季全季基準。
   baselineRows 要是**整季**(不足 minBaseline 場就當沒有基準 —— 半套基準比沒有更糟)。 */
export function styleTrendFor({ lastRows = [], curRows = [], window = 10, minGames = 5, minBaseline = 30 } = {}) {
  const all = [...lastRows, ...curRows];
  const recentRows = all.slice(-window);
  const recent = avg(recentRows);
  if (!recent || recent.games < minGames) return null;

  const baseline = lastRows.length >= minBaseline ? avg(lastRows) : null;
  const delta = baseline
    ? Object.fromEntries(FIELDS.map(f => [f, round(recent[f] - baseline[f], 2)]))
    : null;
  return {
    window,
    span: { from: recentRows[0].date, to: recentRows.at(-1).date },
    currentSeasonGames: curRows.length,
    recent, baseline, delta,
  };
}
