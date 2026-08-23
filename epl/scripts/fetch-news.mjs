#!/usr/bin/env node
// 選用:抓外部英超新聞 RSS → data/raw/news.json,build 時會自動併進動態頁。
// 用法: npm run news
// 注意:受限網路環境(只放行 GitHub 的沙箱)會抓不到,這時其他功能照常運作。
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const strip = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .trim();

const pick = (block, ...tags) => {
  for (const t of tags) {
    const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i').exec(block);
    if (m) return strip(m[1]);
  }
  return '';
};

function parseFeed(xml, source, max) {
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];
  return blocks.slice(0, max).map((b, i) => {
    const date = pick(b, 'pubDate', 'published', 'updated', 'dc:date');
    const iso = date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const linkMatch = /<link[^>]*href="([^"]+)"/i.exec(b);
    return {
      id: `rss-${source.replace(/\W/g, '')}-${i}`,
      cat: '外電',
      date: iso,
      title: pick(b, 'title'),
      body: pick(b, 'description', 'summary', 'content').slice(0, 220),
      source,
      link: linkMatch ? linkMatch[1] : pick(b, 'link'),
    };
  }).filter(x => x.title);
}

async function main() {
  const cfg = JSON.parse(await readFile(join(ROOT, 'data', 'manual', 'feeds.json'), 'utf8'));
  const out = [];
  let failed = 0;
  for (const f of cfg.feeds) {
    process.stdout.write(`  ↓  ${f.name} … `);
    try {
      const res = await fetch(f.url, { headers: { 'user-agent': 'epl-warroom/1.0' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseFeed(await res.text(), f.name, cfg.maxPerFeed ?? 15);
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
  await writeFile(join(ROOT, 'data', 'raw', 'news.json'), JSON.stringify(out, null, 2));
  console.log(`\n✔ 共 ${out.length} 則(失敗 ${failed} 個來源)→ data/raw/news.json,請接著跑 npm run build`);
}

main();
