/* 一個人在這一場是先發還是替補(2026-10-31)—— 看**正式名單**,不看逐人統計。
 *
 * 為什麼:FotMob 的轉換器(adapters/fotmob-match.mjs 的 fotmobPlayers)把 `substitute` 寫死 false,而它在抓取時
 * 就存進 raw 的 player-stats,所以改轉換器救不回舊快取。名單(lineups.xi / bench)也在 raw 裡,只有姓名、背號、位置,
 * 沒有球員 id —— 所以用「同一場、同一隊、背號相同」對,**姓名當守門**:背號對到而姓名對不起來的回 null(不判),
 * 配錯人比配不到糟(西甲頭貼那條坑的同一個規矩)。
 *
 * 西甲進球表(goals.mjs)與逐場紀錄的「↑ 替補上場」(matchstats.mjs 的讀取器)都走這一支 —— 各寫一份的話,
 * 兩邊對「他是不是替補」會是兩個答案。 */
import { normName } from './names.mjs';

/* true = 先發、false = 替補名單、null = 判不出來(沒有名單、沒有背號、背號對到別人、兩邊都不在) */
export function lineupRole(lineup, p) {
  if (!lineup || p?.shirt == null) return null;
  const find = list => (list ?? []).find(x => x.shirt != null && Number(x.shirt) === Number(p.shirt));
  const same = x => normName(x.name) === normName(p.name);
  const xi = find(lineup.xi);
  if (xi) return same(xi) ? true : null;
  const b = find(lineup.bench);
  if (b) return same(b) ? false : null;
  return null;
}

/* 逐人列的 `substitute`:替補名單上而且有上場 → true;先發 → false;判不出來 → null(不是 false —— false 會被讀成「先發」)。
   回傳新的 players 物件,不改原物件(raw 快取是共用的)。 */
export function markSubstitutes(players, lineups) {
  if (!players) return players;
  const out = {};
  for (const [team, list] of Object.entries(players)) {
    const lu = lineups?.[team] ?? null;
    out[team] = (list ?? []).map(p => {
      const role = lineupRole(lu, p);
      return { ...p, substitute: role === null ? null : role === false };
    });
  }
  return out;
}
