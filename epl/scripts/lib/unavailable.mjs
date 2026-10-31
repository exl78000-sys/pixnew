/* 賽前缺陣名單(傷停)—— FotMob `matchDetails` 的 `content.lineup.{homeTeam,awayTeam}.unavailable[]`。
   2026-10-31 英冠接上(使用者選「接,用乙」:每一輪賽前替每一場抓一次,一輪 12 個請求)。

   為什麼是「賽前 24 小時內抓一次」:部署 12 小時一次(epl-live.yml 的 cron),所以每一場**恰好**會有一次部署
   落在開賽前 24 小時內 —— 一場一個請求,不多抓;抓到的是賽前 12~24 小時的狀態,畫面照實講抓取時間。
   某一次部署沒跑(runner 沒領到之類)的話,下一次部署只要還在開賽前就會補抓。
   完賽場次的名單不拿來當「現在」:探測(probe-fotmob-unavailable.mjs,run 41159406941)量到已完賽的場次也有名單,
   但那是不是賽前那一份、還是事後改過的,分不出來 —— 所以只信開賽前抓的。

   單一來源(英冠沒有第二份傷停可以對),使用者同意了;畫面要講。
   探測裡 type 只見過 `injury`,**停賽怎麼寫沒見過** —— 沒見過的類型不翻譯,原文照印(跟進球子代碼同一條規矩)。 */

export const WINDOW_H = 24;            // 開賽前多久內抓
export const MAX_PER_RUN = 16;         // 一次部署的硬上限(一輪 12 場;雙週賽的週中也不會在 24 小時內超過)
export const MAX_ATTEMPTS = 2;         // 回應裡沒有名單(上游還沒給)最多再試一次
const HOUR = 3600e3;

/* 這一次部署要抓哪幾場。matches 是 scores.json 的 matches(FotMob 賽程,帶 matchId 與 utcTime)。
   - 已開踢、取消、沒有時間的不抓;
   - 開賽前 WINDOW_H 小時內、還沒抓過的抓;
   - 上一次沒拿到名單(ok:false)的,最多再試到 MAX_ATTEMPTS 次;
   - 改期:快取裡那一份是在**新開賽時間**的 30 小時以前抓的,當成沒抓過(舊名單不代表新開賽前的狀態)。 */
export function pickDue({ matches = [], cache = {}, now = Date.now() } = {}) {
  const due = [];
  for (const m of matches) {
    if (!m.matchId || !m.utcTime || m.started || m.finished || m.cancelled) continue;
    const ko = Date.parse(m.utcTime);
    if (!Number.isFinite(ko) || ko <= now || ko - now > WINDOW_H * HOUR) continue;
    const c = cache[m.matchId];
    if (!c) { due.push(m); continue; }
    if (c.ok === false && (c.attempts ?? 1) < MAX_ATTEMPTS) { due.push(m); continue; }
    if (c.ok && Date.parse(c.fetchedAt) < ko - 30 * HOUR) due.push(m);
  }
  return due.sort((a, b) => a.utcTime.localeCompare(b.utcTime)).slice(0, MAX_PER_RUN);
}

/* 一份 matchDetails → { ok, reason?, home: {id, name, list}, away: {...} }。
   list 是 null 代表「回應裡沒有這個鍵」(不知道),[] 代表「上游說沒有人缺陣」—— 兩件事不可以混。 */
export function parseUnavailable(raw) {
  const lu = raw?.content?.lineup;
  if (!lu?.homeTeam || !lu?.awayTeam) return { ok: false, reason: '回應裡沒有 lineup' };
  const side = t => ({
    id: t.id ?? null, name: t.name ?? null,
    list: Array.isArray(t.unavailable) ? t.unavailable.map(p => ({
      pid: p.id ?? null, name: p.name ?? null,
      type: p.unavailability?.type ?? null,
      expectedReturn: p.unavailability?.expectedReturn ?? null,
    })) : null,
  });
  const home = side(lu.homeTeam), away = side(lu.awayTeam);
  if (home.list == null && away.list == null) return { ok: false, reason: '名單上沒有 unavailable 欄位', home, away };
  return { ok: true, home, away };
}

/* 只翻見過的。沒見過的回 null,前端印原文 —— 猜一個翻譯就是編。 */
export const typeZh = t => ({ injury: '受傷' }[t] ?? null);
const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
export function returnZh(s) {
  if (s == null) return null;
  if (s === 'Doubtful') return '出賽成疑';
  if (s === 'Unknown') return '回歸時間不明';
  const m = /^(Early|Mid|Late) ([A-Z][a-z]+) (\d{4})$/.exec(s);
  if (m && MONTHS[m[2]]) return `預計 ${m[3]} 年 ${MONTHS[m[2]]} 月${{ Early: '上旬', Mid: '中旬', Late: '下旬' }[m[1]]}回歸`;
  return null;
}

/* 快取 → 產物。fixtures 是本站的賽程(要用本站的場次 id 掛到單場頁),players 是本季球員層(用 FotMob id 接
   本季出賽數,讓讀者看得出缺的是主力還是板凳 —— 不用姓名接)。
   一場對到本站的哪一場:同主客、開賽時間差 3 天內(英冠的附加賽會讓主客重複,所以要時間收斂)。 */
export function buildUnavailable({ cache = {}, fixtures = [], players = [] } = {}) {
  const byPid = new Map(players.filter(p => p.providerId != null).map(p => [String(p.providerId), p]));
  const enrich = list => list == null ? null : list.map(p => {
    const s = p.pid != null ? byPid.get(String(p.pid)) : null;
    return { ...p, typeZh: typeZh(p.type), returnZh: returnZh(p.expectedReturn),
      ...(s ? { season: { matches: s.matches, minutes: s.minutes } } : {}) };
  });
  const out = { fixtures: {}, teams: {}, unmatched: [] };
  for (const c of Object.values(cache)) {
    if (!c.ok) continue;
    const ko = Date.parse(c.utcTime);
    const f = fixtures.find(x => x.home === c.home && x.away === c.away
      && Math.abs(Date.parse(x.kickoff ?? x.date) - ko) < 3 * 24 * HOUR);
    if (!f) { out.unmatched.push(`${c.home}|${c.away}|${String(c.utcTime).slice(0, 10)}`); continue; }
    const e = { matchId: c.matchId, kickoff: c.utcTime, fetchedAt: c.fetchedAt, home: enrich(c.sides?.home ?? null), away: enrich(c.sides?.away ?? null) };
    out.fixtures[f.id] = e;
    /* 每一隊只留開賽時間最晚的那一份。那可能是一場已經踢完的比賽的賽前名單,畫面要講是哪一場、什麼時候抓的。 */
    for (const [code, side, opp, isHome] of [[c.home, 'home', c.away, true], [c.away, 'away', c.home, false]]) {
      if (e[side] == null) continue;
      const prev = out.teams[code];
      if (prev && Date.parse(prev.kickoff) >= ko) continue;
      out.teams[code] = { fixtureId: f.id, opp, home: isHome, kickoff: c.utcTime, fetchedAt: c.fetchedAt, played: !!f.played, list: e[side] };
    }
  }
  return out;
}
