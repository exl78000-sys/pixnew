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
import { round, percentile } from './util.mjs';

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

/* 雷達軸(前端疊層用)。主雷達那六軸是 xG 系的量,近 10 場沒有逐場 xG 來源,
 * 疊上去就是編數字 —— 所以位移雷達自己一組軸,全部用逐場真的量得到的欄位。
 * 被射門/被射正/牌反向:雷達的慣例是「越外越好」,跟主雷達的防守穩固同一個做法。 */
export const TREND_RADAR_AXES = [
  ['sf', '射門', false], ['stf', '射正', false], ['cf', '角球', false],
  ['sa', '被射門↓', true], ['sta', '被射正↓', true], ['cards', '吃牌↓', true],
];

/* 把百分位掛回每隊的 styleTrend。兩個池分開:
 * 近 10 場跟各隊的近 10 場比、上季基準跟各隊的上季基準比 ——
 * 各自都是「當時在聯賽裡站哪個位置」,兩層畫在同一張雷達上意義才對得齊。
 * 池的大小(升班馬沒有基準、樣本不足的沒有近況)記在 pctPool,畫面要講。 */
export function attachTrendPercentiles(byCode) {
  const trends = [...byCode.values()];
  const recentPool = Object.fromEntries(TREND_RADAR_AXES.map(([f]) => [f, trends.map(t => t.recent[f])]));
  const withBase = trends.filter(t => t.baseline);
  const basePool = Object.fromEntries(TREND_RADAR_AXES.map(([f]) => [f, withBase.map(t => t.baseline[f])]));
  const pct = (v, pool, inverse) => {
    const p = percentile(v, pool);
    return inverse ? round(100 - p, 1) : p;
  };
  for (const t of trends) {
    t.recentPct = Object.fromEntries(TREND_RADAR_AXES.map(([f, , inv]) => [f, pct(t.recent[f], recentPool[f], inv)]));
    t.baselinePct = t.baseline
      ? Object.fromEntries(TREND_RADAR_AXES.map(([f, , inv]) => [f, pct(t.baseline[f], basePool[f], inv)]))
      : null;
    t.pctPool = { recent: trends.length, baseline: withBase.length };
  }
}
