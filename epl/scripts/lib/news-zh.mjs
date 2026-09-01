/* 外電譯文的快取檔與掛載 —— 三個聯賽共用一份,不各寫一份。
 *
 * 譯文快取由 `npm run news:translate -- --league=xx` 產生,鍵是
 * **標題+摘要的雜湊**(不能用 RSS 的 id:那是「來源+序號」,
 * 序號會隨新文章進來位移,明天的 0 號跟今天的 0 號是不同文章)。
 *
 * 譯文一律**附在原文旁邊**而不是取代它 —— 這是機器翻譯,讀者要能自己對照。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/* 每個聯賽的外電快取與譯文快取檔名。新增聯賽時只改這裡。 */
export const NEWS_FILES = {
  pl: { raw: 'news.json', zh: 'news-zh.json', zh_label: '英超' },
  es1: { raw: 'news-la-liga.json', zh: 'news-la-liga-zh.json', zh_label: '西甲' },
  en2: { raw: 'news-championship.json', zh: 'news-championship-zh.json', zh_label: '英冠' },
};

export const newsKeyOf = item => createHash('sha1')
  .update(`${item.title}\n${item.body ?? ''}`).digest('hex').slice(0, 16);

/* 把譯文掛到外電項目上(就地修改),回傳掛上幾則。
   沒有快取、快取壞掉、或某一則沒翻到 → 那一則維持原文,前端會照實顯示。 */
export function attachNewsZh(ROOT, league, items) {
  const cfg = NEWS_FILES[league];
  if (!cfg || !Array.isArray(items) || !items.length) return 0;
  const p = join(ROOT, 'data', 'raw', cfg.zh);
  if (!existsSync(p)) return 0;
  let n = 0;
  try {
    const zh = JSON.parse(readFileSync(p, 'utf8'));
    for (const item of items) {
      const hit = zh.entries?.[newsKeyOf(item)];
      if (hit?.ok && hit.title) {
        item.titleZh = hit.title;
        item.bodyZh = hit.body ?? null;
        item.translatedBy = hit.model ?? 'machine';
        n++;
      }
    }
  } catch { return 0; }   // 快取壞掉就當沒有,顯示原文
  return n;
}
