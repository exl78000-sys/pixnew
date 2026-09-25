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

/* 反查表:CLDR 英文地區名 → ISO 碼。掃 AA~ZZ,DisplayNames 對不認得的碼會原樣回傳碼本身 —— 排掉。
   **廢止的舊代碼也要排掉**(2026-09-25):ICU 會把 DD(東德)當成 DE、AN 當成 CW、CS 當成 RS、RH 當成 ZW,
   所以 `of('DD')` 回的是「Germany」,而 DD 在字母順序上比 DE 早 —— 第一版的反查就把德國對到 DD、
   塞爾維亞對到 CS、辛巴威對到 RH(七隊)。中文名沒被影響(zhOf 查的時候 ICU 又換回新碼),
   是要拿代碼去找國旗檔時才現形的。正規化之後不是自己的代碼一律不收。 */
let EN_TO_ISO = null;
const isCanonicalRegion = code => { try { return Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`; } catch { return false; } };
function enToIso() {
  if (EN_TO_ISO) return EN_TO_ISO;
  EN_TO_ISO = new Map();
  const en = new Intl.DisplayNames(['en'], { type: 'region' });
  const A = 'A'.charCodeAt(0);
  for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) {
    const code = String.fromCharCode(A + i) + String.fromCharCode(A + j);
    if (!isCanonicalRegion(code)) continue;
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
    /* 國旗碼(國旗集 lipis/flag-icons 的檔名,2026-09-25)。身分表的 `flag` 覆寫優先 —— 英格蘭四隊與巴斯克
       是國旗集的非 ISO 碼;值是 null 的是**刻意不給**(理由在 `_flagEvidence`,例如中華台北在國際賽用的不是國旗)。
       其餘用 isoOf 的小寫,跟中文名走同一份代碼,兩邊才不會各說各的。 */
    flagCodeOf(key) {
      if (!key) return null;
      if (table.flag && Object.hasOwn(table.flag, key)) return table.flag[key];
      const iso = isoOf(key);
      return iso ? iso.toLowerCase() : null;
    },
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

/* ── 國旗(2026-09-25)────────────────────────────────────────────────
   圖在 data/manual/intl-flags.json(npm run intl:flags,來源 lipis/flag-icons,MIT),這裡決定**哪一隊掛哪一面**。

   國旗集裡有些屬地用的是宗主國的旗:瓜德羅普、法屬圭亞那、聖馬丁畫出來就是法國三色旗,博奈爾就是荷蘭國旗 ——
   瓜德羅普的球隊掛法國國旗,比不掛更糟(讀者會以為那是法國)。所以:**非會員的旗跟別的碼「看起來同一面」就不給**,
   會員照常給。「同一面」用 40×30 的像素比:每個通道的平均絕對差 < 2。
   門檻是量出來的:同一面旗 0.00~0.38(法屬三面對法國 0.38 —— 配色細節不同,所以逐像素相同那種判法會漏掉),
   本來就長得像的不同國家最近是埃及對伊拉克 4.54、印尼對新加坡 6.77、摩爾多瓦對羅馬尼亞 11.02。
   `pixelsOf(img)` 由呼叫端給(PNG 解碼),這裡只做判斷,方便測試捏資料。 */
export const FLAG_SAME = 2;
export function flagDistance(a, b) {
  if (!a || !b || a.data.length !== b.data.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i] - b.data[i]);
  return s / a.data.length;
}
export function intlFlagPlan({ keys, flagCodeOf, flags, isMember, pixelsOf }) {
  const px = new Map();
  const pix = code => { if (!px.has(code)) px.set(code, flags[code] ? pixelsOf(flags[code].img) : null); return px.get(code); };
  const byKey = {}, noCode = [], notFetched = [], sameAs = [];
  const codes = Object.keys(flags);
  for (const k of keys) {
    const code = flagCodeOf(k);
    if (!code) { noCode.push(k); continue; }
    if (!flags[code]) { notFetched.push({ key: k, code }); continue; }
    if (!isMember(k)) {
      const twin = codes.find(c => c !== code && flagDistance(pix(code), pix(c)) < FLAG_SAME);
      if (twin) { sameAs.push({ key: k, code, as: twin }); continue; }
    }
    byKey[k] = { code, img: flags[code].img };
  }
  return { byKey, noCode, notFetched, sameAs };
}
