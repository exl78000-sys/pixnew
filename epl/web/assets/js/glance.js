/* 「我的球隊」一眼看(2026-11-27,N5):一支關注的球隊,上一場比分與下一場是什麼。
   總覽最上面那一條用它。**一行 import 都沒有**,npm test 才在 Node 裡載得起來
   (畫面那一支 import core.js,Node 載不了)。

   只用總覽本來就載的 overview.json(賽程摘要:id / 日期 / 開球 / 主客 / 已賽 / 比分),不多要任何一份產物。

   兩條規則跟 follow-view 的 nextLeagueMatches 同一套,而且理由一樣:
   - 「下一場」數的是**還沒踢**,不是「有開球時間」—— 上游逐月公布開球時間,
     用 kickoff 當條件會漏掉一整批。有時間的照時間排,只有日期的用日期排(同一天的話有時間的先)。
   - 「上一場」只收**有比分**的已賽場次;暫定比分照實帶旗標(畫面要講「暫定」)。 */

const sortKey = f => f.kickoff ?? `${f.date ?? '9999-99-99'}T99:99`;

export function teamGlance(fixtures, code) {
  const mine = (fixtures ?? []).filter(f => f.home === code || f.away === code);
  const played = mine.filter(f => f.played && f.fh != null && f.fa != null)
    .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const next = mine.filter(f => !f.played).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))[0] ?? null;
  const p = played[0] ?? null;
  let last = null;
  if (p) {
    const home = p.home === code;
    const gf = home ? p.fh : p.fa, ga = home ? p.fa : p.fh;
    last = { id: p.id, date: p.date ?? null, home, opp: home ? p.away : p.home, gf, ga,
      result: gf > ga ? 'W' : gf < ga ? 'L' : 'D', provisional: !!p.scoreProvisional };
  }
  return {
    last,
    next: next ? { id: next.id, date: next.date ?? null, kickoff: next.kickoff ?? null,
      home: next.home === code, opp: next.home === code ? next.away : next.home } : null,
  };
}
