/* 人名正規化與配對 —— **只有這一份**。

   為什麼要抽出來:2026-08-28 這一段程式在 `verify-loans.mjs` 與 `lib/loans.mjs`
   各有一份複本。我修好了核對器那一份(姓氏唯一就回傳 → 會對到完全不同的人),
   卻沒有動另一份 —— 於是**實際掛到球員身上的那一步仍在對錯人**,
   而且畫面上完全看不出來。實測有 20 筆掛錯:
   Ben Nelson 的租借掛到 Reiss Nelson、Julián Araujo 的掛到 Ronald Araújo、
   Gustavo Nunes 的掛到 Matheus Nunes。

   這正是 CLAUDE.md 講過的「複製一份轉換過去的話,改了一邊另一邊會悄悄過期」,
   而我自己犯了。所以兩邊一律 import 這一份,不要再各寫一次。 */

/* NFD 只分解「基底字母 + 組合附加符號」。**有些字母沒有基底可分解** ——
   Đ / Ø / Ł / ı / ß 都是獨立字元,分解不掉,然後就被 [^a-z0-9] 整個刪掉:
   `Đorđe Petrović` 會變成 `"or e petrovic"`。那比配不到更糟,
   因為剩下的殘骸有機會去撞到別的名字。所以先逐字對照換掉。 */
const LETTER = {
  Đ: 'Dj', đ: 'dj', Ð: 'D', ð: 'd', Ø: 'O', ø: 'o', Ł: 'L', ł: 'l',
  Æ: 'AE', æ: 'ae', Œ: 'OE', œ: 'oe', ß: 'ss', ı: 'i', İ: 'I', Þ: 'Th', þ: 'th',
};

/* 隊名鍵:去掉**字尾**的 FC/AFC(法人形式)。字首的 AFC 是球隊身分的一部分,
   保留 —— AFC Bournemouth ≠ Bournemouth FC 那條坑。職涯核對與 build 共用。 */
export const clubKey = name => normName(name).replace(/\s+(a?fc)$/, '').trim();

export const normName = s => String(s ?? '')
  .replace(/[ĐđÐðØøŁłÆæŒœßıİÞþ]/g, ch => LETTER[ch] ?? ch)
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/* 配對規則,由嚴到寬,配不出**唯一**的一律回 null。

   「只比姓氏」不算數:英超光同姓的就有 15 組(Martinez 兩位、Wilson 三位),
   而交付檔給的常常是簡稱。姓氏相同**且名字首字母也相同**才算 ——
   Kostas ↔ Konstantinos 過得了,Ben ↔ Reiss 過不了。

   `idOf` 用來把「同一個人的多筆紀錄」收成一個候選。
   西甲的 players.json 是一人一季一筆,966 筆裡有 266 組是同一個 Understat id
   的跨季重複 —— 不收的話 exact 會配到兩筆,然後判定不唯一而放棄,
   同一個人反而永遠配不上。 */
export function matchOne(candidates, name, { nameOf, idOf } = {}) {
  const getName = nameOf ?? (c => c.fullName || c.name);
  const getId = idOf ?? (c => c.code ?? c.id ?? getName(c));
  const uniqueById = list => {
    const seen = new Map();
    for (const c of list) if (!seen.has(getId(c))) seen.set(getId(c), c);
    return [...seen.values()];
  };

  const k = normName(name);
  if (!k) return null;
  const exact = uniqueById(candidates.filter(c => normName(getName(c)) === k));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;   // 真的有兩個同名的人,不猜

  const parts = k.split(' ');
  const last = parts.at(-1), first = parts[0] ?? '';
  if (!first || parts.length < 2) return null;
  const both = uniqueById(candidates.filter(c => {
    const n = normName(getName(c));
    return n.split(' ').at(-1) === last && n.startsWith(first[0]);
  }));
  return both.length === 1 ? both[0] : null;
}
