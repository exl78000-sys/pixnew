/* 球員核心契約(跨聯賽統一層)。
 *
 * 兩個聯賽的球員產物是**兩種形狀**(英超 FPL:一人一筆、last/current 子物件;
 * 西甲 Understat:一人一季一筆、欄位攤平)。這一份把兩邊都映射成同一個形狀,
 * 給跨聯賽搜尋等統一介面用;各聯賽自己的 players.json **原樣保留**,
 * 詳情頁照舊吃各自的富資料。
 *
 * 契約決定(2026-08-29,與使用者確認過):
 * - **聯集 + null**:某聯賽沒有的欄位一律 null(不是 0,不是省略鍵)——
 *   「沒有資料」與「資料是 0」要分開;而鍵固定存在,前端不用逐鍵探測。
 * - **不帶照片**:photo 是 base64,塞進來核心檔會跟 players.json 一樣胖,
 *   跨聯賽搜尋不需要它;要照片時點進去讀該聯賽的完整檔。
 * - 排序/排行拿到 null 要先濾掉,不可以當 0 排 —— 拿 null 當 0 排身價榜,
 *   西甲 600 人全部沉底,看起來像壞掉。
 * - 兩個映射函式的**輸出鍵集合必須完全相同**,npm test 有一條逐鍵比對。
 */
import { round } from './util.mjs';

const SEASON_FIELDS = ['minutes', 'goals', 'assists', 'xG', 'xA', 'shots', 'keyPasses', 'yellow', 'red'];

const seasonEntry = (season, src) => {
  const out = { season };
  for (const f of SEASON_FIELDS) out[f] = src[f] ?? null;
  return out;
};

const record = ({ league, code, name, fullName, team, pos, posZh, age, price, status, statusZh, seasons }) => ({
  league, code, name, fullName: fullName ?? null, team, pos: pos ?? null, posZh: posZh ?? null,
  age: age ?? null, price: price ?? null, status: status ?? null, statusZh: statusZh ?? null, seasons,
});

/* FPL 形狀 → 核心。last/current 是彙總子物件;FPL 沒有逐場射門/關鍵傳球/牌
   (產物層沒有),那些欄位在賽季列裡是 null —— 是「沒有來源」不是 0。 */
export function coreFromFpl(players, { lastSeason, currentSeason }) {
  return players.map(p => {
    const seasons = [];
    if (p.last?.minutes > 0) seasons.push(seasonEntry(lastSeason, {
      minutes: p.last.minutes, goals: p.last.goals, assists: p.last.assists,
      xG: p.last.xG, xA: p.last.xA,
    }));
    if (p.current?.minutes > 0) seasons.push(seasonEntry(currentSeason, {
      minutes: p.current.minutes, goals: p.current.goals, assists: p.current.assists,
      xG: p.current.xG, xA: p.current.xA,
    }));
    return record({
      league: 'pl', code: p.code, name: p.name, fullName: p.fullName, team: p.team,
      pos: p.pos, posZh: p.posZh, age: p.age, price: p.price, status: p.status, statusZh: p.statusZh,
      seasons,
    });
  });
}

/* Understat 形狀 → 核心。一人一季一筆,依 code 併回一人多季;
   身價與傷停狀態西甲沒有來源 → null。 */
export function coreFromUnderstat(rows) {
  const byCode = new Map();
  for (const r of rows) {
    if (!byCode.has(r.code)) {
      byCode.set(r.code, record({
        league: 'es1', code: r.code, name: r.name, fullName: r.fullName, team: r.team,
        pos: r.pos, posZh: r.posZh, age: r.age, price: null, status: null, statusZh: null,
        seasons: [],
      }));
    }
    const rec = byCode.get(r.code);
    if (r.minutes > 0) rec.seasons.push(seasonEntry(r.season, {
      minutes: r.minutes, goals: r.goals, assists: r.assists,
      xG: round(r.xG, 2), xA: round(r.xA, 2), shots: r.shots, keyPasses: r.keyPasses,
      yellow: r.yellow, red: r.red,
    }));
    /* 最新賽季那筆當人的門面(隊伍/位置會換季更新) */
    if (r.season > (rec._latest ?? '')) {
      Object.assign(rec, { team: r.team, pos: r.pos ?? rec.pos, posZh: r.posZh ?? rec.posZh, age: r.age ?? rec.age });
      rec._latest = r.season;
    }
  }
  const out = [...byCode.values()];
  for (const r of out) { delete r._latest; r.seasons.sort((a, b) => (a.season < b.season ? -1 : 1)); }
  return out;
}
