// Adapter:FPL 逐輪鏡像的進球與助攻紀錄 → 逐場進球明細
//
// 來源檔由外部協作產生(見 docs/提示詞A-逐場進球助攻.md),
// 內容是 vaastav 的 merged_gw.csv 篩出「有進球或助攻」的列。
//
// ── 為什麼載入時要修 team 欄 ─────────────────────────────
// 原始規格叫協作方從 players_raw.csv 取球員所屬隊伍 —— **那是我寫錯的**。
// players_raw.csv 是**季末快照**,球季中途轉隊或外借的人會掛在最後那一隊。
// 實例:Rashford 2024-25 第 13 輪替曼聯進 2 球,但他一月外借維拉,
// 季末快照把他記在維拉,那兩球就變成維拉進的 —— 而且不會報錯。
//
// 修法不需要重抓:opp(逐輪的 opponent_team)與 home(was_home)都是逐場欄位,
// 兩個都對。知道「對手是誰、我方是主是客、哪一天」就能從賽程反推我方是誰 ——
// 那一天對手只打一場,我方就是那場的另一邊。
//
// 日期優先、輪次備援:FPL 的 round 是 gameweek,改期的比賽會跟賽程的輪次對不上
// (實例:AVL vs LIV 在 FPL 是 GW25,在賽程是第 29 輪,但日期一樣)。
//
// 修完之後一定要核對比分:每場「我方球員進球 + 對手烏龍球」必須等於實際比分。
// 這是對 openfootball 核的,跟 FPL 是兩個獨立來源,對得上才算數。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'fpl-goals';
export const label = 'FPL 逐輪鏡像(進球與助攻明細)';
export const supports = ['goals'];

export function loadGoals({ root, season, matches }) {
  const file = join(root, 'data', 'raw', 'fpl', `${season}-goals.json`);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.records)) return null;

  const byDate = new Map(), byRound = new Map();
  for (const m of matches) {
    byDate.set(`${m.date}|${m.away}|H`, m);
    byDate.set(`${m.date}|${m.home}|A`, m);
    byRound.set(`${m.round}|${m.away}|H`, m);
    byRound.set(`${m.round}|${m.home}|A`, m);
  }

  const records = [];
  let repaired = 0, orphan = 0;
  for (const r of raw.records) {
    const side = r.home ? 'H' : 'A';
    const m = byDate.get(`${r.date}|${r.opp}|${side}`) ?? byRound.get(`${r.round}|${r.opp}|${side}`);
    if (!m) { orphan++; continue; }
    const team = r.home ? m.home : m.away;
    if (team !== r.team) repaired++;
    records.push({
      code: String(r.code), team, opp: r.opp, home: r.home,
      round: m.round, date: m.date,
      min: r.min, start: r.start,
      g: r.g, a: r.a, og: r.og, pm: r.pm,
    });
  }

  return { season, source: raw._source ?? null, records, repaired, orphan, reported: raw._counts ?? null };
}

/* 比分核對:每場「我方球員進球 + 對手烏龍球」要等於實際比分。
   回傳對不上的場次 —— 呼叫端決定要警告還是擋下來。 */
export function reconcile(records, matches) {
  const tally = new Map();
  for (const r of records) {
    const home = r.home ? r.team : r.opp, away = r.home ? r.opp : r.team;
    const k = `${home}|${away}`;
    if (!tally.has(k)) tally.set(k, { gh: 0, ga: 0 });
    const t = tally.get(k);
    // 烏龍球記在踢進自家門的球員身上,所以要加到對手的得分
    if (r.home) { t.gh += r.g; t.ga += r.og; } else { t.ga += r.g; t.gh += r.og; }
  }
  const mismatches = [];
  let checked = 0;
  for (const m of matches) {
    if (!m.played) continue;
    checked++;
    const t = tally.get(`${m.home}|${m.away}`) ?? { gh: 0, ga: 0 };
    if (t.gh !== m.fh || t.ga !== m.fa) {
      mismatches.push({ date: m.date, home: m.home, away: m.away, real: `${m.fh}-${m.fa}`, got: `${t.gh}-${t.ga}` });
    }
  }
  return { checked, ok: checked - mismatches.length, mismatches };
}
