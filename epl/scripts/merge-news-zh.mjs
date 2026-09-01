#!/usr/bin/env node
/* 人工交付的外電譯文 → 譯文快取(build 讀的那一份)。
 *
 * 走的是本站既有的「收件匣 → 核對 → 發布」慣例:
 *   收件匣 data/manual/news-zh.json(協作方/助手交回來的原始內容)
 *   發布   data/raw/news{,-la-liga,-championship}-zh.json(build 只讀這些)
 *
 * **翻譯的正確性沒辦法自動驗**(那要另一個翻譯來對,等於換一個地方猜)。
 * 所以這裡只擋「結構上一定錯」的那幾種,而且擋掉的**逐筆印出來**:
 *   1. key 對不到任何一則現存外電 —— 多半是清單過期了(外電會滾動)
 *   2. 譯文是空的,或 ok 是 false
 *   3. 譯文跟原文一模一樣 —— 那是沒翻,不是翻譯
 *   4. 譯文裡沒有任何中日韓字元 —— 同上,擋掉整批複製原文的情況
 *
 * 譯者身分照實記錄(by):是人翻的就寫 human,是模型翻的就寫模型名。
 * 前端會據此標「人工翻譯」或「機器翻譯」—— 把機器翻譯講成人工是說謊(鐵則四)。
 *
 *   npm run news:zh              # 核對並寫入
 *   npm run news:zh -- --dry     # 只看結果,不寫檔
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEWS_FILES, newsKeyOf } from './lib/news-zh.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const INBOX = join(ROOT, 'data', 'manual', 'news-zh.json');
const read = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const hasCJK = s => /[㐀-鿿豈-﫿]/.test(String(s ?? ''));

function main() {
  const inbox = read(INBOX);
  if (!inbox) {
    console.log(`  沒有收件匣 ${INBOX.replace(ROOT + '/', '')} —— 先跑 npm run news:todo 產生待翻清單。`);
    return;
  }
  const by = String(inbox.by ?? '').trim() || 'unknown';
  const entries = inbox.entries ?? {};
  const keys = Object.keys(entries);
  if (!keys.length) { console.log('  收件匣是空的。'); return; }

  /* 先把三個聯賽的原文全部索引起來 —— 一份交付檔可以同時涵蓋多個聯賽,
     key 是內容雜湊,不會混淆。 */
  const origin = new Map();     // key → { league, item }
  for (const [lg, cfg] of Object.entries(NEWS_FILES)) {
    for (const it of read(join(ROOT, 'data', 'raw', cfg.raw)) ?? []) {
      if (it?.title) origin.set(newsKeyOf(it), { league: lg, item: it });
    }
  }

  const accepted = {};          // league → { key → entry }
  const rejected = [];
  for (const key of keys) {
    const e = entries[key] ?? {};
    const src = origin.get(key);
    if (!src) { rejected.push([key, '對不到現存外電(清單可能過期了)']); continue; }
    if (e.ok === false || !String(e.title ?? '').trim()) { rejected.push([key, '譯者標記無法翻譯或標題是空的']); continue; }
    if (String(e.title).trim() === String(src.item.title).trim()) { rejected.push([key, '譯文跟原文一模一樣(沒翻)']); continue; }
    if (!hasCJK(e.title)) { rejected.push([key, '標題裡沒有中文字'] ); continue; }
    (accepted[src.league] ??= {})[key] = {
      ok: true, title: String(e.title).trim(),
      body: String(e.body ?? '').trim() || null,
      model: by, at: new Date().toISOString(),
    };
  }

  let wrote = 0;
  for (const [lg, add] of Object.entries(accepted)) {
    const cfg = NEWS_FILES[lg];
    const p = join(ROOT, 'data', 'raw', cfg.zh);
    const cache = read(p) ?? { _note: '外電譯文快取。人工交付經 npm run news:zh 核對後寫入;鍵是標題+摘要的雜湊。', entries: {} };
    cache.entries = { ...cache.entries, ...add };
    cache.updatedAt = new Date().toISOString();
    if (!DRY) writeFileSync(p, JSON.stringify(cache, null, 1));
    wrote += Object.keys(add).length;
    console.log(`  ✔ ${cfg.zh_label}:新增 ${Object.keys(add).length} 則(累計 ${Object.keys(cache.entries).length} 則)`);
  }
  if (rejected.length) {
    console.log(`  ⚠ 退回 ${rejected.length} 則:`);
    for (const [k, why] of rejected.slice(0, 12)) console.log(`     ${k}  ${why}`);
    if (rejected.length > 12) console.log(`     …還有 ${rejected.length - 12} 則`);
  }
  console.log(`\n${DRY ? '(--dry 沒有寫檔)' : '✔'} 收下 ${wrote} 則、退回 ${rejected.length} 則・譯者:${by}`);
  if (!DRY && wrote) console.log('  接著跑 npm run build(或三個聯賽的 build)讓譯文上站。');
}
main();
