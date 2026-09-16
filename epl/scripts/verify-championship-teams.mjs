#!/usr/bin/env node
/* 英冠球隊資料(隊色、城市、球場、容量、綽號)的核對器。
 *
 * **收件匣 → 核對 → 產物**,build 只讀產物。比照租借那一條:
 * 直接把交付檔寫進名冊等於把核對整個繞過去,而協作方自己說「都檢查過了」不算數
 * (鐵則五。實際踩過:交回來的進球明細自報 0 筆不符,拿獨立來源逐場核對出 39 場)。
 *
 *   收件匣  data/manual/championship-teams-delivery.json
 *   產物    data/championship-teams-verified.json
 *
 * ── 四道核對(2026-08-28 對第一版交付跑過)──
 *
 * 1. **對照題:12 支本站既有球隊**。這 12 支(BUR COV HUL IPS LEE LEI LUT SHU
 *    SOU SUN WHU WOL)的城市/球場/容量/隊色 `data/manual/teams.json` 早就有,
 *    是刻意留在交付清單裡的。對不上就是訊號 —— **整份不採用**,不挑著用
 *    (從兩個對不上的來源裡挑一個喜歡的答案等於沒有核對)。
 *    第一版:12/12 逐欄位完全一致。
 *
 * 2. **隊色 vs 隊徽**(獨立核對)。倉庫裡有 36 隊的隊徽 PNG,抽出主色跟交付的主色比。
 *    **不要求一樣** —— 球衣跟隊徽本來就可能不同,提示詞裡就是這樣寫的。
 *    這一關抓的是「差得離譜」。
 *    **這道檢查對白色球衣的球隊沒有分辨力**:Bolton 的隊徽是深藍加紅、一點白都沒有,
 *    但他們的球衣真的是白衫深藍褲。所以白/黑這種無彩度的主色只回報、不判定。
 *
 * 3. **容量的量級與一致性**。英冠球場落在一萬到六萬多之間;同一座球場(若有共用)
 *    容量必須一致。上限取 63,000 —— 62,500 的倫敦碗(West Ham)是真的,
 *    第一版我把上限寫成 62,000,結果誤標了那一筆,**那是規格寫窄了不是資料錯**。
 *
 * 4. **逐欄位出處**。有值就必須有 `sources[欄位]`,沒有的那一格不採用。
 *    不確定要回 null —— 缺一格畫面上可以標「未取得」,填錯的讀者不會知道。
 *
 *   npm run en2:verify-teams
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTeamDelivery, deliveryLines } from './lib/team-delivery.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = join(ROOT, 'data', 'manual', 'championship-teams-delivery.json');
const OUT = join(ROOT, 'data', 'championship-teams-verified.json');

/* **四道核對的實作抽在 `lib/team-delivery.mjs`**,德義法共用同一份 ——
   各寫一份的話,同一個核對在不同聯賽會慢慢分岔,而分岔的症狀是
   「某個聯賽的把關比別人鬆」,沒有人會發現。
   留在這裡的只有英冠自己的兩件事:對照組(12 支本站既有球隊)與隊徽的來源
   (英冠的隊徽散在 crests.json 與盃賽那份的名字查表裡,不是自己一個檔)。 */
const CAP_MIN = 10000, CAP_MAX = 63000;

const loose = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/^afc\s+|\s+afc$/g, ' ').replace(/^fc\s+|\s+fc$/g, ' ')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]/g, '');

export function verify(root = ROOT) {
  const inboxRaw = readFileSync(join(root, 'data', 'manual', 'championship-teams-delivery.json'));
  const roster = JSON.parse(readFileSync(join(root, 'data', 'manual', 'teams-championship.json'), 'utf8')).teams;
  const pl = JSON.parse(readFileSync(join(root, 'data', 'manual', 'teams.json'), 'utf8')).teams;

  const crests = (() => {
    const map = new Map();
    const own = JSON.parse(readFileSync(join(root, 'data', 'manual', 'crests.json'), 'utf8')).crests ?? {};
    const cupsPath = join(root, 'data', 'manual', 'crests-cups.json');
    const cups = existsSync(cupsPath) ? JSON.parse(readFileSync(cupsPath, 'utf8')) : { crests: {}, sources: {} };
    const byName = new Map(Object.entries(cups.sources ?? {})
      .map(([id, v]) => [loose(v.name), cups.crests?.[id]]).filter(([, v]) => v));
    for (const t of roster) {
      const c = own[t.code] ?? byName.get(loose(t.en)) ?? byName.get(loose(t.of));
      if (c) map.set(t.code, c);
    }
    return map;
  })();

  return verifyTeamDelivery({
    inboxRaw, roster, crests,
    control: new Map(pl.map(t => [t.code, t])),   // 12 支本站既有球隊,刻意留在交付清單裡
    capMin: CAP_MIN, capMax: CAP_MAX,
  });
}

function main() {
  const r = verify();
  for (const line of deliveryLines(r, '英冠')) console.log(line);
  if (r.accepted) console.log('  → data/championship-teams-verified.json');
  writeFileSync(OUT, JSON.stringify(r, null, 2));
}

/* **不要用 `import.meta.url === \`file://${process.argv[1]}\``。**
   本專案的路徑含中文,import.meta.url 會被百分號編碼(claude%E8%B6%B3%E7%90%83),
   跟原始路徑永遠不相等 —— main() 靜靜不執行,腳本跑完什麼都沒印。
   用 fileURLToPath 解回來再比(fetch-official.mjs 就是這樣寫的)。 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
