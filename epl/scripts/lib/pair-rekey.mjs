/* 逐場 raw 的舊鍵就地改成 pair 鍵(抓取器 scripts/game/fetch-fotmob-epl.mjs 載入快取時呼叫)。
 *
 * 為什麼要有這一支:逐場 raw 以 pairOf(賽果那一場)為鍵(lib/matchstats.mjs)。同一組主客一季踢兩場的賽事,
 * 賽果帶 `pair`(主|客|日期)—— 歐冠從 2026-09 起(聯賽階段 + 淘汰賽)、英冠的升級附加賽從 2026-10-03 起。
 * 在那之前寫進 raw 的紀錄是「主|客」:同一組主客的第二場被當成已快取而跳過,或兩場都待補時後抓的蓋掉先抓的 ——
 * 英冠 2025-26 三組的 raw 存的是附加賽,聯賽那一場從來沒進來,而一個錯都不報。
 *
 * 規則:紀錄自己帶 date,「主|客|日期」對得上賽果裡**某一場的 pair** 就改成那個鍵;對不上的(聯賽場次)一個字元都不動。
 * 主客取紀錄自己的 home / away(逐場那一檔有),沒有的(逐人統計那一檔只有 date)從舊鍵拆。
 * 目標鍵已經有一筆就不動、記成衝突 —— 兩筆都留著給人看,不挑一個蓋掉另一個。
 * 抽成純函式是為了 npm test 能拿捏造的資料驗(內嵌在抓取器的 main 裡只能靠「跑一次看 raw」驗,而那要網路)。 */
export function rekeyByPair(map, pairs, { addPair = false } = {}) {
  const moved = [], conflicts = [];
  for (const [k, m] of Object.entries(map)) {
    if (m?.pair && k === m.pair) continue;
    const [h, a] = k.split('|');
    const pair = `${m?.home ?? h}|${m?.away ?? a}|${m?.date}`;
    if (!pairs.has(pair) || k === pair) continue;
    if (map[pair]) { conflicts.push({ from: k, to: pair }); continue; }
    map[pair] = { ...m, key: pair, ...(addPair ? { pair } : {}) };
    delete map[k];
    moved.push({ from: k, to: pair });
  }
  return { moved, conflicts };
}
