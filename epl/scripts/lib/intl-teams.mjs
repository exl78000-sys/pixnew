/* 國家隊的身分:FotMob 隊名 → 本站的鍵(martj42 的隊名),以及中文名。
 *
 * ## 鍵用 martj42 的隊名
 *
 * 評分池是 martj42 的歷史賽果,所以它的隊名就是身分(`United States`、`Republic of Ireland`、`Turkey`)。
 * FotMob 的寫法不同(`USA`、`Ireland`、`Turkiye`、`Czechia`)—— 對照表在
 * `data/manual/intl-teams.json` 的 `aliases`,**每一筆都要有證據**(探測的 run 編號與逐場對上的場數),
 * 不是憑印象填。
 *
 * **比對只做正規化後完全相同**(大小寫、變音符號、標點、`&` → and)。不做寬鬆比對 ——
 * 國家隊名裡「Ireland / Northern Ireland」「Congo / DR Congo」「Guinea / Guinea-Bissau / Equatorial Guinea」
 * 「Korea Republic / Korea DPR」都是一個字之差的**不同隊**,寬鬆比對一定會對錯(盃賽頁被咬過三次)。
 * 對不上的一律回 null,由呼叫端印出來、而且那一場**不給勝率**(鐵則三)。
 *
 * ## 中文名
 *
 * 來源是 **Unicode CLDR**(Node 內建的 ICU,`Intl.DisplayNames('zh-Hant-TW', region)`)—— 標準資料,不是翻譯。
 * 先用英文 CLDR 名反查 ISO 地區碼,查不到的在對照表 `iso` 補(例如 martj42 的 `Ivory Coast` = CI);
 * 足球上慣用名跟 CLDR 不同的在 `zhOverride` 覆寫(英格蘭四隊不是 ISO 地區、`TW` 在國際賽是「中華台北」、
 * CLDR 的「中國香港特別行政區」在球場上叫「香港」)。都查不到的**照印英文名**,不編一個譯名。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const normTeam = s => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function loadIntlTeamTable(root) {
  const p = join(root, 'data', 'manual', 'intl-teams.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { aliases: {}, iso: {}, zhOverride: {} };
}

/* 反查表:CLDR 英文地區名 → ISO 碼。掃 AA~ZZ,DisplayNames 對不認得的碼會原樣回傳碼本身 —— 排掉。 */
let EN_TO_ISO = null;
function enToIso() {
  if (EN_TO_ISO) return EN_TO_ISO;
  EN_TO_ISO = new Map();
  const en = new Intl.DisplayNames(['en'], { type: 'region' });
  const A = 'A'.charCodeAt(0);
  for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) {
    const code = String.fromCharCode(A + i) + String.fromCharCode(A + j);
    let name;
    try { name = en.of(code); } catch { continue; }
    if (!name || name === code) continue;
    const k = normTeam(name);
    if (!EN_TO_ISO.has(k)) EN_TO_ISO.set(k, code);
  }
  return EN_TO_ISO;
}

/* 身分解析器。`known` 是評分池裡出現過的隊名(martj42 的鍵)。 */
export function makeIntlResolver(table, known) {
  const byNorm = new Map();
  for (const k of known) byNorm.set(normTeam(k), k);
  const aliases = new Map(Object.entries(table.aliases ?? {}).map(([from, to]) => [normTeam(from), to]));
  const zhTW = new Intl.DisplayNames(['zh-Hant-TW'], { type: 'region' });
  const isoOf = key => table.iso?.[key] ?? enToIso().get(normTeam(key)) ?? null;
  return {
    /* FotMob 的名字 → 評分池的鍵;對不上回 null(不猜)。 */
    keyOf(name) {
      const n = normTeam(name);
      if (!n) return null;
      if (aliases.has(n)) return byNorm.has(normTeam(aliases.get(n))) ? byNorm.get(normTeam(aliases.get(n))) : null;
      return byNorm.get(n) ?? null;
    },
    isoOf,
    /* 中文名:覆寫 → CLDR → null(呼叫端退回英文名) */
    zhOf(key) {
      if (!key) return null;
      if (table.zhOverride?.[key]) return table.zhOverride[key];
      const code = isoOf(key);
      if (!code) return null;
      let z;
      try { z = zhTW.of(code); } catch { return null; }
      return z && z !== code ? z : null;
    },
  };
}
