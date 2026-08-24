// pulselive(英超官網後端)的共用常數與小工具。
//
// 這是官網自己在用的介面,沒有公開文件,所以欄位名稱全部是實際打過一次確認的:
//   /compseasons/{id}/teams          → [{ name, club:{abbr,id}, id }]
//   /fixtures?comps=1&compSeasons=…  → { content:[{ id, teams:[{team,score}], kickoff, status }] }
//   /fixtures/{id}                   → { …, teamLists:[{ teamId, lineup, substitutes, formation:{label,players} }] }
//   /teams/{id}/compseasons/{s}/staff→ { players, officials:[{ role:'Manager', name:{display} }] }
export const API = 'https://footballapi.pulselive.com/football';
export const PL_HEADERS = {
  'user-agent': 'pl-war-room/1.0 (football analysis side project)',
  accept: 'application/json',
  Origin: 'https://www.premierleague.com',
  Referer: 'https://www.premierleague.com/',
};

export const COMP_EPL = 1;   // 英超在 pulselive 的 competition id

// 陣型字串正規化。官方在不同端點給的格式不一樣:
// teamLists 給 "4-2-3-1",stats 給數字 4231 —— 統一成前者。
export function normaliseFormation(label) {
  if (label === null || label === undefined) return null;
  const s = String(label).trim();
  if (!s) return null;
  if (s.includes('-')) return s;
  if (/^\d{3,5}$/.test(s)) return s.split('').join('-');
  return s;
}

// 找出「本季」。官方把最新賽季排在 compseasons 的第一筆,但不要只信順序 ——
// 用標籤裡的年份挑最大的那個,順序變了也不會抓錯。
export async function findSeason(getJson) {
  const r = await getJson(`${API}/competitions/${COMP_EPL}/compseasons?pageSize=30`);
  const list = r.content ?? [];
  if (!list.length) throw new Error('拿不到賽季清單');
  const yearOf = s => Number(/(\d{4})\/\d{2,4}/.exec(s.label ?? '')?.[1] ?? 0);
  const best = list.reduce((a, b) => (yearOf(b) > yearOf(a) ? b : a), list[0]);
  return { id: best.id, label: best.label };
}

// 官方 teamId → 我們的隊碼。先比三字母縮寫(ARS/AVL…),對不上再比隊名。
export function teamMap(teams, T) {
  const map = {}, unmatched = [];
  const byCode = new Map(T.list.map(t => [t.code, t.code]));
  for (const t of teams) {
    const abbr = (t.club?.abbr ?? '').toUpperCase();
    const code = byCode.get(abbr) ?? T.codeOf(t.name) ?? T.codeOf(t.club?.name) ?? T.codeOf(t.shortName);
    if (code) map[String(t.id)] = code;
    else unmatched.push(t.name);
  }
  return { map, unmatched };
}
