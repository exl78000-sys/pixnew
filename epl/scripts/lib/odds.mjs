// football-data.co.uk 的賠率 → 去除水錢後的隱含機率(市場的預測)。
//
// 為什麼要它:這個平台沒有付費的進階數據當賣點,唯一該被檢驗的就是「準不準」。
// 而博彩市場的收盤賠率,是全世界資訊最充分的一群人用真金白銀押出來的機率 ——
// 拿它當基準,「贏過市場」才是真的準,「跟市場差不多」已經很好,
// 「輸給市場」就得承認模型只吃比賽結果、看不到傷停與轉會的侷限。
//
// 全部是決定性的算術,沒有一個數字是模型或 LLM 猜的。
import { parseCSVObjects, num } from './csv.mjs';

/* football-data.co.uk 的隊名 → 我們的隊碼。
   它用的拼法是第三種(不同於 openfootball 的「Arsenal FC」與 FPL 的「Spurs」),
   所以要獨立一張表。對不上的隊(改朝換代、拼法變了)由 fetch 腳本回報,不會靜靜漏掉。 */
export const FD_NAMES = {
  Arsenal: 'ARS', 'Aston Villa': 'AVL', Bournemouth: 'BOU', Brentford: 'BRE',
  Brighton: 'BHA', Burnley: 'BUR', Chelsea: 'CHE', Coventry: 'COV',
  'Crystal Palace': 'CRY', Everton: 'EVE', Fulham: 'FUL', Hull: 'HUL',
  Ipswich: 'IPS', Leeds: 'LEE', Leicester: 'LEI', Liverpool: 'LIV',
  Luton: 'LUT', 'Man City': 'MCI', 'Man United': 'MUN', Newcastle: 'NEW',
  "Nott'm Forest": 'NFO', 'Sheffield United': 'SHU', Southampton: 'SOU',
  Sunderland: 'SUN', Tottenham: 'TOT', 'West Ham': 'WHU', Wolves: 'WOL',
};

/* 賠率欄位偏好順序。收盤(C)比開盤準,Pinnacle 是公認最銳利的莊家,
   市場平均次之,Bet365 保底 —— 誰有值就用誰,全部沒有才放棄這場。 */
const ODDS_COLS = [
  ['PSCH', 'PSCD', 'PSCA', 'Pinnacle 收盤'],
  ['AvgCH', 'AvgCD', 'AvgCA', '市場平均收盤'],
  ['MaxCH', 'MaxCD', 'MaxCA', '市場最佳收盤'],
  ['PSH', 'PSD', 'PSA', 'Pinnacle 開盤'],
  ['AvgH', 'AvgD', 'AvgA', '市場平均開盤'],
  ['B365H', 'B365D', 'B365A', 'Bet365 開盤'],
  ['BbAvH', 'BbAvD', 'BbAvA', '市場平均(舊格式)'],
];

// 十進位賠率 → 去除水錢的隱含機率。
// 1/賠率 是含水錢的隱含機率,三個加起來 > 1(莊家的利潤);
// 按比例normalize成加總為 1 —— 這是最沒有爭議的去水錢法(proportional/multiplicative)。
export function devig(oH, oD, oA) {
  if (!(oH > 1) || !(oD > 1) || !(oA > 1)) return null;
  const iH = 1 / oH, iD = 1 / oD, iA = 1 / oA;
  const s = iH + iD + iA;
  if (!(s > 0)) return null;
  return { home: iH / s, draw: iD / s, away: iA / s, overround: s - 1 };
}

// 從一列 CSV 取出最好的一組賠率,回傳去水錢後的機率 + 用了哪一組
function rowOdds(row) {
  for (const [h, d, a, label] of ODDS_COLS) {
    if (row[h] === undefined) continue;
    const oH = num(row[h], 0), oD = num(row[d], 0), oA = num(row[a], 0);
    const p = devig(oH, oD, oA);
    if (p) return { ...p, source: label, decimals: { home: oH, draw: oD, away: oA } };
  }
  return null;
}

// football-data.co.uk 的日期是 dd/mm/yy 或 dd/mm/yyyy → ISO
function fdDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(String(s).trim());
  if (!m) return null;
  const [, dd, mm, yy] = m;
  const yyyy = yy.length === 2 ? (Number(yy) > 70 ? `19${yy}` : `20${yy}`) : yy;
  return `${yyyy}-${mm}-${dd}`;
}

const codeFor = (name, codeOf) => FD_NAMES[name] ?? codeOf?.(name) ?? null;

/* 解析一整季的 CSV → 每場一筆 {date, home, away, fh, fa, probs, source}。
   對不上隊碼、或整列沒有任何賠率的,跳過並記進 skipped(呼叫端決定要不要在意)。

   div:只留這個聯賽(fixtures.csv 是全歐洲混在一起的,英超是 E0)。
   未開賽的比賽沒有比分,fh/fa 會是 null —— 那正是我們要的「賽前市場機率」。 */
export function parseOddsCsv(text, { codeOf, div = null } = {}) {
  const rows = parseCSVObjects(text);
  const matches = [];
  const unmatched = new Set();
  let noOdds = 0;
  for (const r of rows) {
    if (div && r.Div !== div) continue;
    if (!r.HomeTeam || !r.AwayTeam) continue;
    const home = codeFor(r.HomeTeam, codeOf), away = codeFor(r.AwayTeam, codeOf);
    if (!home) unmatched.add(r.HomeTeam);
    if (!away) unmatched.add(r.AwayTeam);
    if (!home || !away) continue;
    const o = rowOdds(r);
    if (!o) { noOdds++; continue; }
    matches.push({
      date: fdDate(r.Date), home, away,
      fh: r.FTHG === '' ? null : num(r.FTHG), fa: r.FTAG === '' ? null : num(r.FTAG),
      probs: { home: o.home, draw: o.draw, away: o.away },
      overround: o.overround, source: o.source, decimals: o.decimals,
    });
  }
  const header = Object.keys(rows[0] ?? {});
  return {
    matches, unmatched: [...unmatched], noOdds,
    // 一場都解不出來時,把表頭裡像賠率的欄位列出來,下次不用再猜
    oddsColumns: matches.length ? null : header.filter(h => /^(B365|PS|Avg|Max|BF|BW|BV|IW|LB|VC|WH)/.test(h)),
  };
}

// 給回測用:key = `${home}|${away}`(一季內主客對戰組合唯一)→ 市場機率
export function oddsIndex(text, opts) {
  const { matches, unmatched, noOdds } = parseOddsCsv(text, opts);
  const byMatch = new Map();
  for (const m of matches) byMatch.set(`${m.home}|${m.away}`, m);
  return { byMatch, count: matches.length, unmatched, noOdds };
}

/* 未來賽事的賠率(football-data.co.uk 的 fixtures.csv)。
   本季的賽季檔要等賽季結束前才會完整發布,但這個檔每天更新、含未開賽場次 ——
   逐場的「模型 vs 市場」就靠它。 */
export function upcomingOdds(text, { codeOf, div = 'E0' } = {}) {
  const { matches, unmatched, oddsColumns } = parseOddsCsv(text, { codeOf, div });
  const byMatch = {};
  for (const m of matches) {
    byMatch[`${m.home}|${m.away}`] = {
      date: m.date,
      probs: { home: round4(m.probs.home), draw: round4(m.probs.draw), away: round4(m.probs.away) },
      overround: round4(m.overround),
      source: m.source,
      decimals: m.decimals,
    };
  }
  return { byMatch, count: matches.length, unmatched, oddsColumns };
}

const round4 = n => Math.round(n * 1e4) / 1e4;

/* 已完賽場次的市場機率(football-data.co.uk 的**賽季檔**)。
 *
 * 為什麼需要它:`upcomingOdds` 讀的 `fixtures.csv` 只涵蓋**未來幾天**,
 * 比賽一踢完就從那個檔掉出去 —— 於是站上「模型 vs 市場」的對照會隨時間
 * **憑空消失**:2026-09-02 實測,英超 20 場已完賽只有 10 場還掛得到市場、
 * 西甲 30 場只有 10 場、英冠 36 場只有 12 場,而三個聯賽的賽季檔裡
 * **每一場都有收盤賠率**(86 場拿得到,畫面上只有 32 場)。
 *
 * 而且賽季檔給的是**收盤**賠率,比 fixtures.csv 的開盤更準
 * (`ODDS_COLS` 本來就把收盤排在前面)。
 *
 * 鍵是「主隊|客隊」。**有附加賽的聯賽這個鍵不唯一**(英冠季末升級附加賽由
 * 聯賽裡的四隊互打,CLAUDE.md 有一整條在講)—— 賽季檔通常只收聯賽場次,
 * 但撞到就整組跳過並回報,不挑一個當答案。
 */
/* 一場該掛哪一組盤口 —— 三支 build 共用,不各寫一份。
   已賽:賽季檔的收盤價;賽季檔還沒更新到這場(football-data.co.uk 是隔天甚至隔幾天才補)時,
   退回 fixtures.csv 的開盤價,但**要講明是開盤、收盤未到**(鐵則四),而且是可辨識的旗標,
   不是只靠字串。未賽:只有 fixtures.csv 有;賽季檔偶爾也會先有(改期補踢),當備援。
   2026-09-05 踩過:IPS vs LIV 剛踢完、賽季檔還沒有它,測試「已完賽一律收盤價」紅掉,
   deploy 整個被擋 12 小時,兩個聯賽的賽果都上不了站 —— 上游時差不能當 CI 紅線。 */
export function pickMarket({ played, key, seasonBy = {}, upcomingBy = {} }) {
  if (played) {
    if (seasonBy[key]) return seasonBy[key];
    const open = upcomingBy[key];
    return open ? { ...open, closingPending: true, source: `${open.source}(收盤價未到,賽季檔還沒更新到這場)` } : null;
  }
  return upcomingBy[key] ?? seasonBy[key] ?? null;
}

export function seasonMarket(text, { codeOf, div = 'E0' } = {}) {
  const { matches, unmatched } = parseOddsCsv(text, { codeOf, div });
  const byMatch = {};
  const dupes = [];
  for (const m of matches) {
    const key = `${m.home}|${m.away}`;
    if (key in byMatch) { dupes.push(key); continue; }
    byMatch[key] = {
      date: m.date,
      probs: { home: round4(m.probs.home), draw: round4(m.probs.draw), away: round4(m.probs.away) },
      overround: round4(m.overround), source: m.source, decimals: m.decimals,
    };
  }
  for (const key of dupes) delete byMatch[key];   // 撞鍵的兩場都不採用
  return { byMatch, count: Object.keys(byMatch).length, unmatched, dupes };
}
