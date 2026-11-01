/* 英超球員的所屬球隊:FPL 名冊與英超官方正式名單不一致時,以官方為準(2026-11-01,使用者:「好,以官方名單為準」)。
 *
 * 為什麼:FPL 的 players_raw.csv(`data/raw/fpl/{季}-players.csv`)的 `team` 欄對**暑假轉隊**的人還是舊東家 ——
 * 2026-11-01 量到 16 人,例:Konsa 名冊寫 AVL,而英超官方正式名單(pulselive)、FotMob 逐場名單、
 * 連 FPL 自己的逐場資料(season-gws.json)都說他本季替 ARS 上場,551 分鐘一分不差。
 * 只有那一欄是舊的,累計數據是對的。照舊欄位掛,球員頁、球隊名單、榜單的隊伍欄全都講錯。
 *
 * 規則(寧可不改也不能改錯人):
 *   1. 官方名單(先發 + 板凳)上某個名字最近一次出現在 T 隊;
 *   2. T 隊的 FPL 名冊裡找不到這個名字(找得到就不是這種情況);
 *   3. 整份名冊裡**唯一**配得上這個名字的人目前掛在別隊;
 *   4. 那個人在他 FPL 掛的那一隊,沒有比 T 隊那一次更晚的官方出場(否則是轉回去了,或配錯人);
 *   5. 兩個官方名字配到同一個人 → 兩個都不改。
 * 姓名配對走 lib/names.mjs 那一串(全名 / 簡稱 / 簡稱退路 / 全名開頭退路),跟英超本季進球表的身分接回同一份。
 * 改了的人回傳在 fixes 裡,呼叫端照實印出來、寫進產物(teamSource / fplTeam),畫面講「依官方正式名單」。 */
import { matchOne, webNameFinder, leadingNameFinder, normName } from './names.mjs';

const find = (pool, name) => matchOne(pool, name, { nameOf: c => c.fullName || c.name })
  ?? matchOne(pool, name, { nameOf: c => c.name })
  ?? webNameFinder(pool)(name)
  ?? leadingNameFinder(pool)(name);

export function officialTeamFix(players, lineups) {
  const fixes = [], skipped = [];
  if (!lineups?.matches) return { fixes, skipped };
  /* 名字 → 官方出場紀錄(哪一隊、哪一場、開球時間) */
  const seen = new Map();
  for (const [key, m] of Object.entries(lineups.matches)) {
    const [home, away] = key.split('|');
    for (const [side, team] of [['home', home], ['away', away]]) {
      for (const q of [...(m?.[side]?.xi ?? []), ...(m?.[side]?.subs ?? [])]) {
        if (!q?.name) continue;
        const k = normName(q.name);
        if (!seen.has(k)) seen.set(k, { name: q.name, apps: [] });
        seen.get(k).apps.push({ team, kickoff: m.kickoff ?? '', match: key });
      }
    }
  }
  const byTeam = new Map();
  for (const p of players) {
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const t = s => Date.parse(s) || 0;
  /* 每個 FPL 球員在他自己那一隊(FPL 掛的那一隊)最近一次被官方名單列出的時間 —— 規則 4 用 */
  const homeLatest = new Map();
  for (const { name, apps } of seen.values()) {
    for (const a of apps) {
      const p = find(byTeam.get(a.team) ?? [], name);
      if (p) homeLatest.set(p.code, Math.max(homeLatest.get(p.code) ?? 0, t(a.kickoff)));
    }
  }
  const cand = new Map();
  for (const { name, apps } of seen.values()) {
    const latest = apps.reduce((a, b) => (t(b.kickoff) > t(a.kickoff) ? b : a));
    if (find(byTeam.get(latest.team) ?? [], name)) continue;
    const p = find(players, name);
    if (!p) { skipped.push({ name, team: latest.team, why: '名冊裡找不到這個人' }); continue; }
    if (p.team === latest.team) continue;
    if ((homeLatest.get(p.code) ?? 0) >= t(latest.kickoff)) {
      skipped.push({ name, team: latest.team, why: `${p.team} 有更晚的官方出場` });
      continue;
    }
    const games = apps.filter(a => a.team === latest.team).length;
    const prev = cand.get(p.code);
    cand.set(p.code, prev ? null : { code: p.code, name, fplName: p.name, from: p.team, to: latest.team, games, lastSeen: latest.kickoff });
    if (prev) skipped.push({ name, team: latest.team, why: `跟 ${prev.name} 配到同一個人` });
  }
  for (const f of cand.values()) if (f) fixes.push(f);
  fixes.sort((a, b) => a.to.localeCompare(b.to) || a.name.localeCompare(b.name));
  return { fixes, skipped };
}

/* 把修正套到名冊上(就地改)。背號一併清掉 —— FPL 那個號碼是舊東家的,留著會在新東家的名單上撞號;
   清掉之後由官方名單的背號回填(build 的 backfillSquadNumbers)。 */
export function applyTeamFix(players, fixes) {
  const by = new Map(fixes.map(f => [String(f.code), f]));
  for (const p of players) {
    const f = by.get(String(p.code));
    if (!f) continue;
    p.fplTeam = p.team;
    p.team = f.to;
    p.teamSource = 'official';
    p.squadNumber = null;
  }
}
