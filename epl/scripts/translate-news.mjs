#!/usr/bin/env node
// 把西甲外電的標題與摘要翻成繁體中文,結果永久快取。
//
//   npm run news:translate                  # 只翻還沒翻過的
//   npm run news:translate -- --force       # 全部重翻
//   npm run news:translate -- --limit=3     # 先小量試
//
// 為什麼要快取:外電內容不會變,同一篇翻兩次除了燒錢沒有別的效果。
// 快取的鍵是**標題+摘要的雜湊** —— 用 id 當鍵會有問題,因為 RSS 的 id 是
// 「來源+序號」(rss-TheGuardianLaLiga-0),序號會隨著新文章進來而位移,
// 明天的 0 號跟今天的 0 號是不同文章。用內容雜湊就不會錯認。
//
// 沒有 ANTHROPIC_API_KEY 就整支跳過,不是錯誤 —— 畫面會顯示原文。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { translateItem, translateEnabled } from './lib/report/translate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEWS = join(ROOT, 'data', 'raw', 'news-la-liga.json');
const CACHE = join(ROOT, 'data', 'raw', 'news-la-liga-zh.json');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const FORCE = process.argv.includes('--force');
const LIMIT = Math.max(1, Number(arg('limit') ?? 40));
const DELAY = 400;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const keyOf = item => createHash('sha1')
  .update(`${item.title}\n${item.body ?? ''}`).digest('hex').slice(0, 16);

async function main() {
  if (!existsSync(NEWS)) {
    console.log('  沒有西甲外電快取,先跑 npm run laliga:news。');
    return;
  }
  const items = JSON.parse(await readFile(NEWS, 'utf8'));
  if (!Array.isArray(items) || !items.length) { console.log('  外電快取是空的,沒有東西可翻。'); return; }

  if (!translateEnabled()) {
    console.log(`  ⚠ 沒有 ANTHROPIC_API_KEY,略過翻譯(${items.length} 則外電會以原文顯示)。`);
    console.log('     這不是錯誤 —— 前端有分辨,沒有譯文就直接顯示原文並標明。');
    return;
  }

  const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : { entries: {} };
  cache.entries ??= {};

  let done = 0, skipped = 0, failed = 0;
  const failures = [];
  for (const item of items) {
    const k = keyOf(item);
    if (!FORCE && cache.entries[k]) { skipped++; continue; }
    if (done >= LIMIT) break;
    if (done) await sleep(DELAY);
    const r = await translateItem(item);
    done++;
    if (!r.ok) {
      failed++;
      failures.push({ title: item.title.slice(0, 60), error: r.error });
      // 失敗也記下來,但標成 failed —— 下次會重試,而且畫面知道這篇沒譯文
      cache.entries[k] = { ok: false, error: r.error, at: new Date().toISOString() };
      continue;
    }
    cache.entries[k] = {
      ok: true, title: r.title, body: r.body,
      model: r.model, at: new Date().toISOString(),
    };
  }

  // 清掉已經不在外電清單裡的舊譯文,避免快取無限長大
  const live = new Set(items.map(keyOf));
  let pruned = 0;
  for (const k of Object.keys(cache.entries)) {
    if (!live.has(k)) { delete cache.entries[k]; pruned++; }
  }

  cache.source = 'Anthropic API(機器翻譯)';
  cache.note = '外電原文的機器翻譯。只翻譯不改寫;數字與人名隊名保留原文。原文一律保留並顯示。';
  cache.updatedAt = new Date().toISOString();
  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache, null, 2) + '\n');

  console.log(`  西甲外電翻譯:新翻 ${done - failed} 篇・已有 ${skipped} 篇・失敗 ${failed} 篇・清掉過期 ${pruned} 篇`);
  for (const f of failures) console.log(`    ✗ ${f.title}… → ${f.error}`);
  if (failed) console.log('    (失敗的維持顯示原文,下次執行會重試)');
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
