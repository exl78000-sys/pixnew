/* FotMob 球隊頁(`fetch-league-teams-fotmob.mjs` 的 raw)→ 球隊資料收件匣(2026-10-09)。
 *
 * 收件匣的格式與規矩看 `docs/交付格式-德義法球隊與教練.md`;核對器(`verify-league-teams.mjs`)照常把關:
 * 每一格有值就要有出處、容量落在合理區間、同一座球場容量一致、隊色對隊徽抓離譜。
 *
 * **跟人工交付不同的三件事,都要講清楚(鐵則四):**
 * 1. **單一來源。** 球場、城市、容量沒有第二個來源可以核對,每一格的出處都是同一頁。
 * 2. **原文名稱。** 球場與城市是 FotMob 給的原文(Stadio Giuseppe Meazza、Milano),沒有中文,不翻譯 —— 譯名是另一份要有出處的資料。
 * 3. **隊色是 FotMob 介面的主色** (`details.teamColor`),不一定是球衣主色;核對器只抓離譜。
 * 綽號 FotMob 不給,不填(寫 null 的欄位比編一個強)。教練不在這裡:FotMob 的教練歷任與逐場正式名單是同一家,
 * 拿它交付再用正式名單核對是自己核對自己,畫面會把「已核對」講得比實際強,所以不產生教練收件匣。 */
export const SOURCE_NOTE = 'FotMob 球隊頁(單一來源;球場與城市為原文名稱;隊色為 FotMob 介面主色,不一定是球衣主色)';

const slug = s => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const pageUrl = t => `https://www.fotmob.com/teams/${t.fotmobId}/overview/${slug(t.fotmobName)}`;

/** @param raw fetch-league-teams-fotmob 寫的 {teams:[{code,fotmobId,fotmobName,fetchedAt,color,venue,city,capacity}]}
 *  @param roster 名冊(取英文名,核對器要比 en) */
export function toTeamsInbox(raw, roster) {
  const enBy = new Map(roster.map(t => [t.code, t.en]));
  const hex = /^#[0-9a-fA-F]{6}$/;
  const teams = [];
  for (const t of raw.teams ?? []) {
    if (!enBy.has(t.code)) continue; // 不在名冊的不產生(核對器也會擋,這裡先不送)
    const url = pageUrl(t);
    const out = { code: t.code, en: enBy.get(t.code), sources: {} };
    const put = (f, v, ok = v != null && v !== '') => { if (ok) { out[f] = v; out.sources[f] = url; } };
    put('colors', [t.color.toUpperCase()], typeof t.color === 'string' && hex.test(t.color));
    put('city', t.city);
    put('venue', t.venue);
    put('capacity', t.capacity, Number.isInteger(t.capacity));
    teams.push(out);
  }
  const fetched = (raw.teams ?? []).map(t => t.fetchedAt).filter(Boolean).sort();
  return { source: SOURCE_NOTE, retrievedAt: fetched.at(-1) ?? raw.fetchedAt ?? null, teams };
}
