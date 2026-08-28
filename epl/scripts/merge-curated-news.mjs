#!/usr/bin/env node
/* 人工整理外電:收件匣 → 檔案庫。
 *
 *   data/manual/news-curated.json          協作方每次交付的整份檔案(收件匣,只涵蓋一週)
 *   data/manual/news-curated-archive.json  累積下來的檔案庫(這個腳本產生,不要手動編輯)
 *
 * 沒有這一步的話,下一次交付會把上一週的整批蓋掉,而且不會有任何地方報錯。
 *
 * **重跑是安全的**:內容沒變就完全不寫檔(排程每 10 分鐘跑一次,
 * 每次都改檔案的話 git log 會被雜訊淹掉)。
 *
 *   npm run news:merge                 合併並淘汰 180 天前的
 *   npm run news:merge -- --keep-days=365
 *   npm run news:merge -- --dry-run    只看會發生什麼,不寫檔
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDelivery, mergeDelivery, pruneArchive, coverageOf, emptyArchive,
} from './lib/curated-archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const hit = argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const DRY = argv.includes('--dry-run');
const KEEP_DAYS = Number(arg('keep-days', '180'));
const AS_OF = arg('as-of') || new Date().toISOString().slice(0, 10);
const INBOX = arg('inbox') || join(ROOT, 'data', 'manual', 'news-curated.json');
const ARCHIVE = arg('archive') || join(ROOT, 'data', 'manual', 'news-curated-archive.json');

const readJson = async (p, fallback) => {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) {
    console.log(`⚠ ${p} 讀不到:${e.message}`);
    return fallback;
  }
};

async function main() {
  console.log(`▶ 合併人工整理外電(保留 ${KEEP_DAYS} 天,基準日 ${AS_OF})\n`);

  const rawInbox = await readJson(INBOX, null);
  const archive0 = await readJson(ARCHIVE, emptyArchive());
  const before = JSON.stringify(archive0);

  let merged = { archive: archive0, added: [], updated: [], unchanged: [], newDelivery: false };
  if (!rawInbox) {
    console.log(`  收件匣不在(${INBOX}),只做淘汰`);
  } else {
    const d = readDelivery(rawInbox);
    for (const p of d.problems) console.log(`  ⚠ 收件匣:${p}`);
    if (!d.ok) {
      // window 壞掉 → 涵蓋範圍就講不清楚,而涵蓋範圍是這份資料的誠實度所在。
      console.error('✗ 收件匣的 window 不合法,不合併(涵蓋範圍會說不清楚)');
      process.exitCode = 1;
      return;
    }
    if (d.outside.length) {
      console.log(`  · 有 ${d.outside.length} 則日期落在宣告的 ${d.from}~${d.to} 之外:${d.outside.join('、')}`);
    }
    console.log(`  收件匣:${d.from} ~ ${d.to},${d.stories.length} 則(來源 ${d.source ?? '未註明'})`);
    merged = mergeDelivery(archive0, d);
    console.log(`  新增 ${merged.added.length}・更新 ${merged.updated.length}・已存在 ${merged.unchanged.length}`
      + `${merged.newDelivery ? '・這是一次新的交付' : '・這次交付先前已記錄過'}`);
    for (const id of merged.added) console.log(`    + ${id}`);
    for (const id of merged.updated) console.log(`    ~ ${id}(內容有更新)`);
  }

  const pruned = pruneArchive(merged.archive, { asOf: AS_OF, keepDays: KEEP_DAYS });
  pruned.archive.keepDays = KEEP_DAYS;
  if (pruned.droppedStories.length || pruned.droppedDeliveries) {
    console.log(`  淘汰 ${pruned.cutoff} 之前的:${pruned.droppedStories.length} 則`
      + `、${pruned.droppedDeliveries} 次交付紀錄`);
  }

  const cov = coverageOf(pruned.archive);
  console.log(`\n  檔案庫:${cov.stories} 則,涵蓋 ${cov.days} 天`);
  for (const r of cov.ranges) console.log(`    ${r.from} ~ ${r.to}`);
  // 斷檔要印出來 —— 「8/1~8/28」看起來像連續 28 天,實際可能只有兩個週末
  for (const g of cov.gaps) console.log(`    ⚠ 斷檔 ${g.from} ~ ${g.to}(這幾天沒有人整理)`);

  const after = JSON.stringify(pruned.archive, null, 2) + '\n';
  if (before === JSON.stringify(pruned.archive)) {
    console.log('\n✓ 檔案庫沒有變化,不寫檔');
    return;
  }
  if (DRY) { console.log('\n(--dry-run,沒有寫檔)'); return; }
  await writeFile(ARCHIVE, after);
  console.log(`\n✓ 已寫入 ${ARCHIVE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
