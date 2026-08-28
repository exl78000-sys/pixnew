#!/usr/bin/env node
// 選用:抓外部新聞 RSS → data/raw/news*.json,build 時會自動併進動態頁。
// 用法: npm run news [-- --league=es1]
// 注意:受限網路環境(只放行 GitHub 的沙箱)會抓不到,這時其他功能照常運作。
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const league = arg('league') === 'es1' ? 'es1' : 'pl';
const configFile = league === 'es1' ? 'feeds-laliga.json' : 'feeds.json';
const outputFile = league === 'es1' ? 'news-la-liga.json' : 'news.json';

const strip = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const pick = (block, ...tags) => {
  for (const t of tags) {
    const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(block);
    if (m) return strip(m[1]);
  }
  return '';
};

/* RSS 的 pubDate 會出現 JS 解不了的時區縮寫。

   實際踩過:Sky Sports 的英超 feed 是 "Thu, 27 Aug 2026 19:00:00 **BST**",
   `new Date()` 對它回 Invalid Date,而原本的寫法直接 `.toISOString()` —— 整支拋錯,
   **那個來源的 15 則全部沒了**,只在輸出留下一行 "✗ Invalid time value"。
   一筆日期壞掉不該讓整個來源掛掉。

   所以:先照原樣解,不行就把字尾的時區縮寫換成偏移量再解,
   還是不行就回 null 由呼叫端處理(用抓取日期,並且把筆數報出來)。 */
const TZ_OFFSET = { GMT: '+0000', UTC: '+0000', UT: '+0000', Z: '+0000', BST: '+0100', CET: '+0100', CEST: '+0200', WET: '+0000', WEST: '+0100' };
function parseFeedDate(raw) {
  if (!raw) return null;
  const t = String(raw).trim();
  let d = new Date(t);
  if (!Number.isNaN(d.getTime())) return d;
  const m = /\s([A-Za-z]{1,4})$/.exec(t);
  const off = m && TZ_OFFSET[m[1].toUpperCase()];
  if (off) {
    d = new Date(t.replace(/\s[A-Za-z]{1,4}$/, ` ${off}`));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

let unparsedDates = 0;

function parseFeed(xml, source, max, keywords = []) {
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];
  return blocks.slice(0, max).map((b, i) => {
    const date = pick(b, 'pubDate', 'published', 'updated', 'dc:date');
    const parsed = parseFeedDate(date);
    /* 解不出日期就用抓取當天,但要記下來報出去 ——
       靜靜蓋上今天的日期會讓三天前的新聞排到最上面,而沒有人會發現。 */
    if (date && !parsed) unparsedDates++;
    const iso = (parsed ?? new Date()).toISOString().slice(0, 10);
    const linkMatch = /<link[^>]*href="([^"]+)"/i.exec(b);
    return {
      id: `rss-${source.replace(/\W/g, '')}-${i}`,
      cat: league === 'es1' ? '西甲外電' : '外電',
      date: iso,
      title: pick(b, 'title'),
      body: pick(b, 'description', 'summary', 'content').slice(0, 220),
      source,
      link: linkMatch ? linkMatch[1] : pick(b, 'link'),
    };
  }).filter(x => x.title && (!keywords.length || keywords.some(k => `${x.title} ${x.body}`.toLowerCase().includes(k.toLowerCase()))));
}

async function main() {
  const cfg = JSON.parse(await readFile(join(ROOT, 'data', 'manual', configFile), 'utf8'));
  const out = [];
  let failed = 0;
  for (const f of cfg.feeds) {
    process.stdout.write(`  ↓  ${f.name} … `);
    try {
      const res = await fetch(f.url, { headers: { 'user-agent': 'epl-warroom/1.0' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseFeed(await res.text(), f.name, cfg.maxPerFeed ?? 15, f.keywords ?? []);
      out.push(...items);
      console.log(`${items.length} 則`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
      failed++;
    }
  }
  if (!out.length) {
    console.log('\n沒有抓到任何外電(可能是網路限制)。這不影響其他資料 —— 動態頁仍會有傷停、轉會、賽前與數據看點。');
    return;
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  await mkdir(join(ROOT, 'data', 'raw'), { recursive: true });
  const unique = [...new Map(out.map(x => [x.link || `${x.source}|${x.title}`, x])).values()]
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  await writeFile(join(ROOT, 'data', 'raw', outputFile), JSON.stringify(unique, null, 2));
  console.log(`\n✔ ${league} 共 ${unique.length} 則(失敗 ${failed} 個來源)→ data/raw/${outputFile},請接著建置`);
  if (unparsedDates) {
    console.log(`  ⚠ 有 ${unparsedDates} 則的 pubDate 解不出來,已用抓取當天的日期代替 —— `
      + '那幾則的先後順序會不準,要去 parseFeedDate 補時區縮寫');
  }
}

main();
