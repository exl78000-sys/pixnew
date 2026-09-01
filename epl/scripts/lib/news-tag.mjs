/* 把外電項目對到球隊。三個聯賽共用一支。
 *
 * 為什麼需要:RSS 外電原本完全沒有 team 欄位 —— 實測英超 50 則裡有 43 則
 * 明確提到英超球隊,但球隊頁、單場分析頁、動態頁的球隊篩選通通看不到它們,
 * 看起來像「比賽新聞沒抓」,其實是抓了卻沒接上。
 *
 * **配錯隊比配不到糟**(這個專案反覆吃虧的那條),所以:
 *
 * 1. 只用**完整可辨識的詞組**比對,不用單一泛詞。
 *    `Manchester` / `United` / `City` / `Town` 都是多支球隊共有的,一律不用 ——
 *    名冊裡的 `en` 與 `of` 本來就是「Manchester City」「Leeds United」這種完整寫法。
 * 2. 比對前先檢查**這個詞組是不是只對到一支球隊**;對到兩支以上就整個丟掉,
 *    不猜。(例如未來若有兩支隊的簡稱撞在一起,會自動失效而不是亂配。)
 * 3. 詞組比對走**詞界**,`Villa` 不會命中 `Villarreal`。
 * 4. 一則新聞可能講到兩隊(轉會新聞很常見),所以輸出 `teams` 陣列;
 *    `team` 取**標題裡最先出現**的那一支(通常是主詞),讓既有的單選篩選仍然可用。
 */

/* 英文足球媒體慣用、而且在本站三個聯賽裡不會撞的簡稱。
   只加「不加隊名也不會誤會」的;有疑慮的一律不加。 */
const NICKNAMES = {
  TOT: ['Spurs'],
  NFO: ['Forest'],
  CRY: ['Palace'],
  AVL: ['Villa'],
  WOL: ['Wolves'],
  BHA: ['Seagulls'],
  MUN: ['Man United'],
};

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strip = s => String(s ?? '').replace(/\s+(FC|AFC)$/i, '').trim();

/* 從名冊建詞組表。回傳 [{ re, code }],已去掉會對到多支球隊的詞組。 */
export function buildTeamMatchers(teams) {
  const byPhrase = new Map();               // 小寫詞組 → Set(code)
  const add = (phrase, code) => {
    const p = strip(phrase).toLowerCase();
    if (p.length < 4) return;               // 太短的一律不用(Hull 4 字剛好保留)
    if (!byPhrase.has(p)) byPhrase.set(p, new Set());
    byPhrase.get(p).add(code);
  };
  for (const t of teams) {
    if (!t?.code) continue;
    for (const v of [t.en, t.of, ...(t.alias ?? []), ...(NICKNAMES[t.code] ?? [])]) if (v) add(v, t.code);
  }
  const out = [];
  for (const [phrase, codes] of byPhrase) {
    if (codes.size !== 1) continue;         // 對到多支 → 不猜,整個丟掉
    out.push({ phrase, code: [...codes][0], re: new RegExp(`\\b${esc(phrase)}\\b`, 'i') });
  }
  // 長的先比,讓「Leeds United」贏過「Leeds」(如果兩者都在表裡)
  out.sort((a, b) => b.phrase.length - a.phrase.length);
  return out;
}

/* 就地把 teams / team 掛上去。回傳掛到幾則。
   已經有 team 的(人工交付本來就標了)不覆蓋。 */
export function tagNewsTeams(items, matchers) {
  if (!Array.isArray(items) || !matchers?.length) return 0;
  let n = 0;
  for (const it of items) {
    if (!it || it.team) continue;           // 人工整理已經標好的,不動
    const title = String(it.title ?? '');
    const hay = `${title} ${it.body ?? ''}`;
    /* 同一支球隊可能有多個詞組(en 的「Man City」與 of 的「Manchester City」)。
       位置要取**所有詞組裡最靠前的那一個** —— 只看第一個命中的詞組會出錯:
       「Man City open talks with Chelsea」的標題裡是 Man City,但先命中的是
       body 裡的 Manchester City,於是 MCI 拿到「標題沒有」的分數而排到 Chelsea 後面。 */
    const best = new Map();                 // code → 標題裡最靠前的位置
    for (const m of matchers) {
      if (!m.re.test(hay)) continue;
      const at = title.search(m.re);
      const pos = at < 0 ? Number.MAX_SAFE_INTEGER : at;
      if (!best.has(m.code) || pos < best.get(m.code)) best.set(m.code, pos);
    }
    const hits = [...best].map(([code, at]) => ({ code, at }));
    if (!hits.length) continue;
    hits.sort((a, b) => a.at - b.at);
    it.teams = hits.map(h => h.code);
    it.team = hits[0].code;
    n++;
  }
  return n;
}
