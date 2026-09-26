/* 球員頁列表用的摘要 players-list.json(2026-09-27,A6)。

   為什麼:球員頁的列表只用每人十幾個欄位(名字、隊、位置、背號、頭貼路徑、狀態、出場數與一季的十四個數字),
   而 players.json 每人還揹著雷達、追蹤資料、租借、定位球順位、角色、合約…(英超 1,280 KB 裡 radar + tracking + loans
   就 400 KB)。列表每次進頁都載,詳情(帶 ?code=)與對比模式才需要整份 —— 那兩條路改成點到才讀 players.json。

   三種形狀照球員頁的三個渲染器(leaders.source 分岔):FPL(英超,current / last 子物件)、Understat(西甲德義法,
   一人一季一列、數字攤平)、逐場累加(英冠,stats 子物件)。**欄位就是列表讀的那些**;要在列表多畫一欄先來這裡加。
   跟 overview 同一個做法:build 從**寫出去的** players.json 抽,測試守著筆數與沒帶重的欄位。

   players-core.json 是另一份、另一個契約(跨聯賽搜尋,六個聯賽同一個鍵集合),不動它。 */

const FPL_STAT = ['minutes', 'goals', 'assists', 'ga', 'xG', 'xA', 'xGI', 'xg90', 'xa90', 'xgi90', 'shots', 'keyPasses', 'yellow', 'red'];
const US_STAT = ['games', ...FPL_STAT];
const AGG_STAT = ['mins_played', 'goals', 'goal_assist', 'expected_goals', 'expected_assists', 'ontarget_total', 'shots_total',
  'total_att_assist', 'tackles_total', 'interceptions_total', 'yellow_card', 'red_card', 'saves_total', 'rating'];

// 沒有的欄位給 null(不是 0、不是省略鍵):列表把 null 印成「—」,0 才是 0
const pick = (o, keys) => { const out = {}; for (const k of keys) out[k] = o?.[k] ?? null; return out; };

export function playersListFrom(players, { source }) {
  const rows = Array.isArray(players) ? players : (players?.players ?? null);
  if (!Array.isArray(rows)) throw new Error('playersListFrom:players.json 要先寫出去才抽得出列表');
  if (source === 'match-aggregate') {
    return rows.map(p => ({
      season: p.season ?? null, team: p.team ?? null, providerId: p.providerId ?? null, name: p.name,
      pos: p.pos ?? null, shirt: p.shirt ?? null, matches: p.matches ?? null, minutes: p.minutes ?? null,
      stats: pick(p.stats, AGG_STAT),
    }));
  }
  if (source === 'Understat') {
    return rows.map(p => ({
      id: p.id, code: p.code ?? p.id, season: p.season ?? null, name: p.name, fullName: p.fullName ?? null,
      teams: p.teams ?? null, teamCodes: p.teamCodes ?? null, multiTeam: !!p.multiTeam, sportmonksTeam: p.sportmonksTeam ?? null,
      pos: p.pos ?? null, posZh: p.posZh ?? null, age: p.age ?? null, squadNumber: p.squadNumber ?? null, photo: p.photo ?? null,
      ...pick(p, US_STAT),
    }));
  }
  if (source !== 'fpl') throw new Error(`playersListFrom:不認得的來源 ${source}(fpl / Understat / match-aggregate)`);
  return rows.map(p => ({
    code: p.code, name: p.name, fullName: p.fullName ?? null, team: p.team ?? null, pos: p.pos ?? null, posZh: p.posZh ?? null,
    age: p.age ?? null, squadNumber: p.squadNumber ?? null, squadNumberSource: p.squadNumberSource ?? null, photo: p.photo ?? null,
    status: p.status ?? null, statusZh: p.statusZh ?? null, appearances: p.appearances ?? null,
    current: p.current ? pick(p.current, FPL_STAT) : null, last: p.last ? pick(p.last, FPL_STAT) : null,
  }));
}

/* 列表不該帶的欄位 —— 帶了就是整份產物又回來了(測試掃原始 JSON 文字) */
export const HEAVY_KEYS = ['radar', 'radarCurrent', 'tracking', 'loans', 'setPieces', 'role', 'dataSources', 'contractStart', 'nationalityId'];
