// 逐場進球明細 → 球隊頁要的四種切面。
//
// 能回答的:這一季對每一隊進了幾球/被進幾球、誰進的、誰助攻、先發還是替補進的。
// 這個逐球資料不能把某一球分成運動戰/角球/任意球,所以不留個人級欄位。
// 球隊整季的進球情境另由 Understat 快取進入 tactics.json,不在這裡重複聚合。
import { round } from './util.mjs';

/* 一支球隊在一個賽季的進球剖面。
   records 已經過 adapter 修正與比分核對,這裡只做彙總,不再驗證。 */
export function teamGoals(records, code) {
  const mine = records.filter(r => r.team === code);
  const theirs = records.filter(r => r.opp === code);

  // 對手分佈:對每一隊進幾球、被進幾球
  const vs = new Map();
  const bump = (opp, key, n) => {
    if (!n) return;
    if (!vs.has(opp)) vs.set(opp, { f: 0, a: 0 });
    vs.get(opp)[key] += n;
  };
  for (const r of mine) {
    bump(r.opp, 'f', r.g);       // 我方球員進球
    bump(r.opp, 'a', r.og);      // 我方球員的烏龍球 = 對手得分
  }
  for (const r of theirs) {
    bump(r.team, 'a', r.g);      // 對手球員進球
    bump(r.team, 'f', r.og);     // 對手球員的烏龍球 = 我方得分
  }

  /* 進球榜與助攻榜。
     有些來源(逐球事件)只有「誰進的」,沒有上場分鐘、也沒有先發/替補。
     那兩欄要標 null 而不是 0 —— `p.min += null` 會靜靜變成 0,
     畫面上就成了「這名球員上場 0 分鐘卻進了球」;
     `if (r.start)` 則會把 null 判成替補,把整季的球全掛到板凳頭上。
     兩者都是編出來的數字,鐵則一不准。 */
  const hasStart = mine.some(r => r.start != null);
  const hasMin = mine.some(r => r.min != null);
  const byPlayer = new Map();
  for (const r of mine) {
    if (!r.g && !r.a) continue;
    if (!byPlayer.has(r.code)) byPlayer.set(r.code, { code: r.code, g: 0, a: 0, startG: 0, subG: 0, min: 0, games: 0 });
    const p = byPlayer.get(r.code);
    p.g += r.g; p.a += r.a; p.min += r.min ?? 0; p.games++;
    if (r.start != null) { if (r.start) p.startG += r.g; else p.subG += r.g; }
  }
  for (const p of byPlayer.values()) {
    if (!hasStart) { p.startG = null; p.subG = null; }
    if (!hasMin) p.min = null;
  }

  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  const goalsFor = sum(mine, 'g') + sum(theirs, 'og');
  const goalsAgainst = sum(theirs, 'g') + sum(mine, 'og');

  return {
    for: goalsFor, against: goalsAgainst,
    // 烏龍球分開列 —— 「這隊進了幾球」跟「有幾球是對手送的」是兩件事
    ownFor: sum(theirs, 'og'), ownAgainst: sum(mine, 'og'),
    starterGoals: hasStart ? sum(mine.filter(r => r.start === true), 'g') : null,
    subGoals: hasStart ? sum(mine.filter(r => r.start === false), 'g') : null,
    startKnown: hasStart, minKnown: hasMin,
    assists: sum(mine, 'a'),
    vs: [...vs].map(([opp, x]) => ({ opp, ...x })).sort((a, b) => b.f - a.f || a.a - b.a),
    players: [...byPlayer.values()].sort((a, b) => b.g - a.g || b.a - a.a),
  };
}

/* 全聯盟的替補進球佔比 —— 一支球隊高不高,要有比較基準才知道。 */
export function subShare(records) {
  // 沒有 start 欄位的來源算不出這個比例。回 null,不要回 0 ——
  // 0 的意思是「沒有替補進球」,那是另一件事。
  if (!records.some(r => r.start != null)) return null;
  const g = records.reduce((a, r) => a + r.g, 0);
  const sub = records.filter(r => r.start === false).reduce((a, r) => a + r.g, 0);
  return g ? round(sub / g, 4) : 0;
}

/* 給前端的完整資料集。每一季一份,球隊頁自己挑要看哪一季。 */
/* matchKeys:這一季的逐球明細**涵蓋哪幾場**(主隊|客隊)。
   非記不可,因為明細只收核對通過的場次,而賽程會先一步拿到新的賽果 ——
   兩邊涵蓋的比賽不同時,整季總和本來就不會一樣。
   沒有這份清單的話,「逐隊進失球對回賽果」那條斷言會在每次有新賽果、
   而人工交付的明細還沒跟上時變紅,看起來像資料錯了,其實只是涵蓋範圍不同。
   有了它,核對就限定在同一批比賽上,而且畫面也講得出涵蓋率(鐵則四)。 */
export function buildGoals(bySeason, { nameOf, codes, matchKeys = {} }) {
  const seasons = {};
  for (const [season, records] of Object.entries(bySeason)) {
    const teams = {};
    for (const code of codes) {
      const t = teamGoals(records, code);
      if (!t.for && !t.against) continue;      // 那一季不在英超的球隊直接跳過
      teams[code] = {
        ...t,
        players: t.players.slice(0, 12).map(p => ({
          ...p,
          name: nameOf(p.code),
          // per-90 的分母是上場分鐘。出場太少的不給這個數字 ——
          // 替補上場 10 分鐘進 1 球換算成每 90 分鐘 9 球,那是誤導不是資訊。
          g90: p.min >= 450 ? round((p.g / p.min) * 90, 2) : null,
          a90: p.min >= 450 ? round((p.a / p.min) * 90, 2) : null,
        })),
      };
    }
    /* 有些來源沒有「先發還是替補」這個欄位(例如逐球事件),那一季就算不出
       替補進球佔比。**不能讓 falsy 的 start 靜靜變成「全部都是替補進的」** ——
       filter(r => !r.start) 會把 null 當成替補,結果 subShare 變成 1、
       starterGoals 變成 0,畫面上就是「這隊 100% 的球都是替補進的」,
       那是編出來的。整季都沒有 start 就一律標 null。 */
    const hasStart = records.some(r => r.start != null);
    const hasMin = records.some(r => r.min != null);
    for (const t of Object.values(teams)) {
      if (!hasStart) { t.starterGoals = null; t.subGoals = null; }
    }
    seasons[season] = {
      teams,
      subShare: hasStart ? subShare(records) : null,
      startKnown: hasStart,
      minKnown: hasMin,
      goals: records.reduce((a, r) => a + r.g, 0),
      // null = 這一季的來源沒有回報涵蓋哪幾場(往季走 openfootball,整季都有)
      matchKeys: matchKeys[season] ?? null,
    };
  }
  return seasons;
}
