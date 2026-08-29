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
export function teamMatchRows(csvText, { codeOf, div = 'E0', xgLookup = null } = {}) {
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
        // 逐場 xG(Understat,已對回賽果)。缺 = null 不是 0 —— 沒有資料 ≠ 零
        ...(xgLookup ? (xgLookup(code, date) ?? { xg: null, xga: null }) : {}),
      });
    };
    side(home, away, 'H', 'A', true);
    side(away, home, 'A', 'H', false);
  }
  for (const rows of byTeam.values()) rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return byTeam;
}

export const avg = rows => {
  if (!rows.length) return null;
  const out = { games: rows.length };
  for (const f of FIELDS) out[f] = round(rows.reduce((s, r) => s + (r[f] ?? 0), 0) / rows.length, 2);
  /* 逐場 xG:**全部列都有**才給平均 —— 半套視窗的 xG 平均會靜靜偏掉,
     缺一場就整組 null,軸的選擇端據此退回實測軸。 */
  if (rows.every(r => r.xg != null)) {
    out.xg = round(rows.reduce((s, r) => s + r.xg, 0) / rows.length, 2);
    out.xga = round(rows.reduce((s, r) => s + r.xga, 0) / rows.length, 2);
  } else { out.xg = null; out.xga = null; }
  return out;
};

/* 每隊:最近 window 場(跨季) vs 上季全季基準。
   baselineRows 要是**整季**(不足 minBaseline 場就當沒有基準 —— 半套基準比沒有更糟)。 */
export function styleTrendFor({ lastRows = [], curRows = [], window = 10, minGames = 5, minBaseline = 30, curPlayed = null } = {}) {
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
    /* 逐場統計主檔(football-data 季檔)比賽果慢一兩天 —— 已完賽但還沒進季檔的
       場次數要標在畫面上,不然剛踢完那幾天看起來像資料壞了(使用者問過)。 */
    pendingGames: curPlayed != null ? Math.max(0, curPlayed - curRows.length) : null,
    recent, baseline, delta,
  };
}

/* 雷達軸(前端疊層用)。主雷達那六軸是 xG 系的量,近 10 場沒有逐場 xG 來源,
 * 疊上去就是編數字 —— 所以位移雷達自己一組軸,全部從逐場真的量得到的欄位**合成**
 * (使用者回饋:裸統計軸沒有風格感)。公式透明、跟主雷達的韌性軸同一種做法
 * (那條也是加權合成)。反向軸:雷達慣例越外越好。 */
/* 兩組軸,選哪組由**資料**決定(逐場 xG 齊不齊),不是由聯賽寫死:
 * - XG 組:前三軸跟主雷達**同名同義**(進攻火力=xG/場、終結效率=進球−xG、
 *   防守穩固=xGA/場)—— 使用者一直要的「兩張雷達一樣」,逐場 xG 落地後
 *   終於做得到三軸;傳球創造與定位球威脅仍然沒有逐場來源,
 *   用場面控制/防守壓制/紀律三個實測軸補位。
 * - 實測組:英冠(沒有 Understat)與 xG 視窗不完整的隊照舊。
 * 第四欄是公式(畫面說明用)。 */
export const TREND_AXES_XG = [
  ['atk', '進攻火力', false, 'xG/場'],
  ['fin', '終結效率', false, '進球−xG(每場)'],
  ['defx', '防守穩固', true, 'xGA/場(反向)'],
  ['control', '場面控制', false, '我方射門佔雙方射門比例'],
  ['suppress', '防守壓制', true, '被射門/場(反向)'],
  ['discipline', '紀律', true, '牌/場(反向)'],
];
export const TREND_RADAR_AXES = [
  ['volume', '攻勢量能', false, '射門+角球/場'],
  ['convert', '進球轉化', false, '進球÷射門'],
  ['control', '場面控制', false, '我方射門佔雙方射門比例'],
  ['suppress', '防守壓制', true, '被射門/場(反向)'],
  ['defend', '防線把關', true, '失球÷被射門(反向)'],
  ['discipline', '紀律', true, '牌/場(反向)'],
];

/* 場均值 → 合成軸。比率用場均相除(分子分母各自平均後相除 = 總和相除,一致)。
   分母為 0 加不了倒數那課(versus 的坑):給中性值不給 Infinity。 */
export const styleAxesOf = a => (a ? {
  atk: a.xg ?? null,
  fin: a.xg != null ? round(a.gf - a.xg, 2) : null,
  defx: a.xga ?? null,
  volume: round(a.sf + a.cf, 2),
  convert: a.sf ? round(a.gf / a.sf, 3) : 0,
  control: (a.sf + a.sa) ? round(a.sf / (a.sf + a.sa), 3) : 0.5,
  suppress: a.sa,
  defend: a.sa ? round(a.ga / a.sa, 3) : 0,
  discipline: a.cards,
} : null);

/* 分級尺:上季**全部球隊的所有 10 場滾動視窗**的分布,含降級隊。
 *
 * 第一版用全季平均當尺,實測散佈太窄(2025-26 英超射門/場:全季平均
 * 9.3~15.7、10 場視窗 7.0~19.7)—— 38 場的平均把波動抹平了,拿 10 場的
 * 高波動值去比,隨便一波熱潮就頂穿整把尺,級分 10 變得太便宜(使用者抓到:
 * 曼城六軸幾乎全 10)。同樣本大小對同樣本大小,10 才代表
 * 「比上季任何一隊的任何一段 10 場都強」。
 * 基準層(全季平均)放同一把尺上讀作「這隊典型的 10 場落在哪」——
 * 兩層同尺的性質不變,箭頭仍然只有一個意思。 */
export function seasonRuler(rowsByTeam, { window = 10, minGames = 30 } = {}) {
  const ALL_KEYS = [...new Set([...TREND_RADAR_AXES, ...TREND_AXES_XG].map(([f]) => f))];
  const pools = Object.fromEntries(ALL_KEYS.map(f => [f, []]));
  let teams = 0, windows = 0, xgWindows = 0;
  for (const rows of rowsByTeam.values()) {
    if (rows.length < minGames) continue;
    teams++;
    for (let i = 0; i + window <= rows.length; i++) {
      const w = styleAxesOf(avg(rows.slice(i, i + window)));
      for (const f of ALL_KEYS) if (w[f] != null) pools[f].push(w[f]);
      windows++;
      if (w.atk != null) xgWindows++;   // xG 軸的池只收逐場 xG 完整的窗
    }
  }
  return { teams, windows, xgWindows, pools };
}

/* 把級分用的百分位掛回每隊的 styleTrend。**兩層共用同一把尺**(上季全季分布):
 * 第一版是近況跟各隊近況比、上季跟各隊上季比 —— 兩個池各自會動,
 * 於是「6→9」分不出是你變了還是別隊變了。一張叫「位移」的圖,
 * 箭頭必須只有一個意思:你自己動了。
 * 代價要照實標在畫面上:10 場平均比整季抖,極端級分可能含小樣本雜訊。 */
export function attachTrendPercentiles(byCode, { ruler } = {}) {
  if (!ruler || ruler.teams === 0) return;   // 沒有上季整季 CSV 就不給級分,前端只畫表
  const pct = (v, pool, inverse) => {
    const p = percentile(v, pool);
    return inverse ? round(100 - p, 1) : p;
  };
  /* 尺的 xG 池要夠大才用 XG 組(池太小級分沒有意義);九成的窗有 xG 就算夠 ——
     上季偶有一兩場 Understat 缺漏不至於整聯賽退回實測軸。 */
  const rulerHasXg = ruler.xgWindows >= ruler.windows * 0.9;
  for (const t of byCode.values()) {
    const rAxes = styleAxesOf(t.recent), bAxes = styleAxesOf(t.baseline);
    /* 逐隊選軸組:近況視窗的 xG 齊、(有基準的話)基準的 xG 也齊,才用 XG 組。
       半套 xG 不硬用 —— 缺一場的視窗平均會靜靜偏掉。 */
    const useXg = rulerHasXg && rAxes.atk != null && (!bAxes || bAxes.atk != null);
    const axes = useXg ? TREND_AXES_XG : TREND_RADAR_AXES;
    t.axes = axes.map(([key, label, inverse, formula]) => ({ key, label, inverse, formula }));
    t.recentPct = Object.fromEntries(axes.map(([f, , inv]) => [f, pct(rAxes[f], ruler.pools[f], inv)]));
    t.baselinePct = bAxes
      ? Object.fromEntries(axes.map(([f, , inv]) => [f, pct(bAxes[f], ruler.pools[f], inv)]))
      : null;
    t.pctPool = { ruler: ruler.teams, windows: ruler.windows, xgWindows: ruler.xgWindows };
    t.axesMode = useXg ? 'xg' : 'measured';
  }
}
