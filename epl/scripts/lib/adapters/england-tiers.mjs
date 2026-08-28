/* 英格蘭聯賽層級對照:把盃賽對手的名字對回「他是第幾級的球隊」。
 *
 * 為什麼要這個:盃賽頁上「Sunderland 輸給 Port Vale」看不出是不是冷門 ——
 * 讀者需要知道 Port Vale 是英甲。這是盃賽最重要的一個背景資訊,
 * 而本站只認得英超那 27 支,其餘 750 支只有名字。
 *
 * 來源是 openfootball/football.json,**本站本來就在用的那一個**
 * (英超賽程就是從 en.1.json 來的),靜態檔、免費、Public Domain。
 * 實測涵蓋:
 *   2026-27  en.1(英超 20)、en.2(英冠 24)              ← 本季只有前兩級
 *   2025-26  en.2(24)、en.3(英甲 24)、en.4(英乙 24)
 *
 * ── 兩個刻意的設計 ──
 *
 * 1. **層級是逐季查的,不是查一次貼到底。** 球隊每年升降級 ——
 *    Sheffield Wednesday 上季在英冠,今年可能不是。所以 2025-26 的盃賽比賽
 *    用 2025-26 的層級(那是精確的),2026-27 的比賽優先用本季的層級;
 *    本季查不到(英甲英乙上游還沒發布)才退回上季,而且**畫面要標出賽季**。
 *    不標的話就是拿去年的事實講今年,那是編數字。
 *
 * 2. **對不上的就不給層級。** 非聯賽球隊(第五級以下)上游沒有,
 *    98 支對手裡有 33 支屬於這一類 —— 它們維持只有名字與隊徽,不猜。
 *
 * 隊名比對用寬鬆版(去掉 FC/AFC),因為上游同一支球隊跨季會寫成
 * "Cardiff City" 與 "Cardiff City FC"。盃賽那個「AFC Liverpool 對成 Liverpool」
 * 的坑在這裡風險低很多(母體是 116 支職業球隊,不是 745 支含第九級的),
 * 但仍然**不自動採用差太多的配對**:名字正規化之後不相等的,
 * 一律列進 nearMisses 交給人看,不靜靜當成對上了。
 */

export const TIER_SOURCES = [
  { season: '2026-27', file: 'en.1.json', zh: '英超', tier: 1 },
  { season: '2026-27', file: 'en.2.json', zh: '英冠', tier: 2 },
  { season: '2025-26', file: 'en.1.json', zh: '英超', tier: 1 },
  { season: '2025-26', file: 'en.2.json', zh: '英冠', tier: 2 },
  { season: '2025-26', file: 'en.3.json', zh: '英甲', tier: 3 },
  { season: '2025-26', file: 'en.4.json', zh: '英乙', tier: 4 },
];

/* **只去掉字尾的 FC / AFC,絕對不去字首的。**
   字尾是法人形式(Barnsley = Barnsley FC、Barrow = Barrow AFC),
   字首的 AFC 是**球隊身分的一部分**:

     AFC Liverpool   第九級的球隊    ≠  Liverpool FC     英超
     Bournemouth FC  第九級的球隊    ≠  AFC Bournemouth  英超

   第一版兩頭都去,於是 AFC Liverpool 被標成「英超」——
   CLAUDE.md 陷阱表裡那條「盃賽寬鬆比對會對錯球隊」,在這裡又出現一次,
   而且這次是 nearMisses 那份清單把它抓出來的。清單不是裝飾。 */
export const tierKey = name => String(name ?? '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\s+a?fc$/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]/g, '');

/* 查某一季某支球隊的層級。
   回傳 { zh, tier, season, exact } —— exact=false 代表這一季查不到、
   退回別季的資料,畫面必須把 season 標出來。 */
export function lookupTier(store, name, season) {
  const k = tierKey(name);
  if (!k) return null;
  const here = store?.seasons?.[season]?.[k];
  if (here) return { ...here, season, exact: true };
  // 本季沒有(例如英甲英乙上游只發布到上一季)→ 退回最近的一季,但要標明
  const others = Object.keys(store?.seasons ?? {}).sort().reverse();
  for (const s of others) {
    const hit = store.seasons[s]?.[k];
    if (hit) return { ...hit, season: s, exact: false };
  }
  return null;
}

/* 名字沒有完全相等、只是正規化之後相等的配對,列出來讓人看。
   「Cardiff City」對「Cardiff City FC」是安全的;
   如果出現差很多的一組,那就是要人來判斷的訊號。 */
export function nearMisses(store, names) {
  const out = [];
  for (const n of names) {
    const k = tierKey(n);
    for (const [season, table] of Object.entries(store?.seasons ?? {})) {
      const hit = table[k];
      if (hit && hit.name !== n) out.push({ cup: n, source: hit.name, season, tier: hit.zh });
    }
  }
  // 同一組只報一次
  const seen = new Set();
  return out.filter(x => { const k = `${x.cup}|${x.source}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
