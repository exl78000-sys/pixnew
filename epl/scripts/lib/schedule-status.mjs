/* 延賽/改期偵測(探勘缺口 G)。
 *
 * 來源:football-data.org v4(本站已整合的供應商,零新依賴)。
 * 它的 match status 列舉含 POSTPONED / SUSPENDED / CANCELLED(文件實測),
 * 但**沒有改期歷史** —— 所以歷史由本站自己建:每次抓取跟上一次快照 diff,
 * 狀態轉入延期集合、或 utcDate 變了,就記一筆變更事件(永久保留)。
 *
 * 用途是把實時頁的「還沒有賽果」從「可能資料落後、也可能延賽」變成
 * 講得出官方狀態。**只標註,不改本站的開球時間** ——
 * kickoff 的來源(openfootball/FPL)有自己的更新節奏,兩邊搶著寫會打架。
 */

const BAD = new Set(['POSTPONED', 'SUSPENDED', 'CANCELLED']);

const ZH = { POSTPONED: '延期', SUSPENDED: '腰斬待續', CANCELLED: '取消' };
export const statusZh = s => ZH[s] ?? s;

/* API 回應 → 精簡列。只收聯賽正規賽(ELC 的升級附加賽 stage 不同,
   而且它跟聯賽撞主客組合 —— 附加賽那條老坑)。codeOf 用 clubs 登錄表建。 */
export function normalizeMatches(apiMatches, codeOf) {
  const out = [];
  for (const m of apiMatches ?? []) {
    if (m.stage && m.stage !== 'REGULAR_SEASON') continue;
    const home = codeOf(m.homeTeam?.name ?? m.homeTeam?.shortName);
    const away = codeOf(m.awayTeam?.name ?? m.awayTeam?.shortName);
    if (!home || !away) continue;
    out.push({ fdId: m.id, home, away, utcDate: m.utcDate, status: m.status, matchday: m.matchday ?? null });
  }
  return out;
}

/* 兩次快照 → 變更事件。以 fdId 對齊(供應商自己的主鍵,不用主客組合 ——
   主客組合在有附加賽的聯賽不唯一,那條坑踩過)。 */
export function diffSnapshots(prev, next) {
  const prevBy = new Map((prev ?? []).map(m => [m.fdId, m]));
  const events = [];
  for (const m of next ?? []) {
    const p = prevBy.get(m.fdId);
    if (!p) continue;
    if (!BAD.has(p.status) && BAD.has(m.status)) {
      events.push({ kind: m.status.toLowerCase(), fdId: m.fdId, home: m.home, away: m.away, utcDate: m.utcDate });
    } else if (BAD.has(p.status) && !BAD.has(m.status)) {
      // 從延期回到排定 = 改期完成,新時間就是 utcDate
      events.push({ kind: 'rescheduled', fdId: m.fdId, home: m.home, away: m.away, from: p.utcDate, to: m.utcDate });
    } else if (p.utcDate !== m.utcDate) {
      events.push({ kind: 'rescheduled', fdId: m.fdId, home: m.home, away: m.away, from: p.utcDate, to: m.utcDate });
    }
  }
  return events;
}

/* 把官方狀態掛到本站賽程上。對齊規則:同主客 + 日期最近(差 7 天內)——
   日期優先、不用輪次(FPL 的 round 是 gameweek 那條坑);同一組對戰
   跨賽季會重複,但這裡兩邊都只有當季,主客組合在正規賽內唯一。
   只掛「有事」的場次(postponed/suspended/cancelled),沒事不加欄位 ——
   不留一排永遠是 null 的鍵。 */
export function attachScheduleStatus(fixtures, statusMatches) {
  const flagged = (statusMatches ?? []).filter(m => BAD.has(m.status));
  let attached = 0;
  for (const f of fixtures) {
    if (f.played) continue;
    const cands = flagged.filter(m => m.home === f.home && m.away === f.away);
    if (!cands.length) continue;
    const fDate = new Date(f.kickoff ?? `${f.date}T12:00:00Z`);
    const best = cands.map(m => ({ m, gap: Math.abs(new Date(m.utcDate) - fDate) }))
      .sort((a, b) => a.gap - b.gap)[0];
    if (best.gap > 7 * 86400000) continue;
    f.officialStatus = best.m.status;
    f.officialStatusZh = statusZh(best.m.status);
    attached++;
  }
  return attached;
}
