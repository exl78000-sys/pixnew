#!/usr/bin/env node
/* 產生「待翻譯清單 + 可直接複製的提示詞」。
 *
 * 為什麼是這條路:使用者選擇**不接 API 金鑰**,改走本站既有的
 * 「人工交付 → 核對 → 發布」慣例(跟外電摘要、租借、教練職涯同一套)。
 * 好處是金鑰不用交出去;代價是要人跑一趟,所以這支負責把那一趟變得很短。
 *
 *   node scripts/news-todo.mjs                 # 三個聯賽全部待翻的
 *   node scripts/news-todo.mjs --league=pl     # 只看英超
 *   node scripts/news-todo.mjs --out=todo.md   # 寫成檔案
 *
 * 只列**還沒有譯文**的 —— 已翻過的靠內容雜湊認得出來,不會叫你翻第二次。
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEWS_FILES, newsKeyOf } from './lib/news-zh.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const ONLY = arg('league');
const OUT = arg('out');
const LIMIT = Math.max(1, Number(arg('limit') ?? 60));

const read = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

const PROMPT = `你是繁體中文的體育新聞翻譯。下面是英文足球外電的標題與摘要,請翻成繁體中文。

規則(請嚴格遵守):
1. **只做語言轉換**。不要摘要、不要補背景、不要加評論。
2. **數字、比分、金額、日期照原文**,不要換算、不要四捨五入。
3. **人名與球隊名保留原文英文**(例如 Saka、Arsenal、Aston Villa),
   不要音譯 —— 本站其他地方也是用英文隊名,譯成中文會對不起來。
4. 看不懂或資訊不足的那一則,\`ok\` 填 false 並把 \`title\` 留空,**不要猜**。
5. 不要更動 \`key\`,那是本站用來對回原文的雜湊。

請**只**回傳這個形狀的 JSON(不要任何其他文字):

{
  "by": "你的名字或模型名(例如 human 或 gpt-x)",
  "entries": {
    "<key>": { "ok": true, "title": "中文標題", "body": "中文摘要" }
  }
}
`;

function main() {
  const leagues = ONLY ? [ONLY] : Object.keys(NEWS_FILES);
  const blocks = [];
  let total = 0;
  for (const lg of leagues) {
    const cfg = NEWS_FILES[lg];
    if (!cfg) { console.error(`✗ 未知聯賽 ${lg}`); process.exit(1); }
    const items = read(join(ROOT, 'data', 'raw', cfg.raw)) ?? [];
    const zh = read(join(ROOT, 'data', 'raw', cfg.zh)) ?? { entries: {} };
    const todo = items.filter(x => x?.title && !zh.entries?.[newsKeyOf(x)]?.ok).slice(0, LIMIT);
    console.log(`  ${cfg.zh_label}:${items.length} 則,待翻 ${todo.length} 則`);
    if (!todo.length) continue;
    total += todo.length;
    blocks.push(`\n## ${cfg.zh_label}(${todo.length} 則)\n\n\`\`\`json\n`
      + JSON.stringify(todo.map(x => ({ key: newsKeyOf(x), title: x.title, body: x.body ?? '' })), null, 1)
      + '\n```\n');
  }
  if (!total) { console.log('\n✔ 沒有待翻的外電。'); return; }
  const doc = `# 外電待翻清單(${new Date().toISOString().slice(0, 10)})\n\n${PROMPT}\n${blocks.join('')}\n`
    + `---\n\n收到回覆後:把 JSON 存成 \`epl/data/manual/news-zh.json\`,再跑 \`npm run news:zh\`。\n`
    + `多個聯賽可以合成同一份 —— key 是內容雜湊,不會混淆。\n`;
  if (OUT) { writeFileSync(join(ROOT, OUT), doc); console.log(`\n✔ 已寫入 ${OUT}(${total} 則)`); }
  else console.log(doc);
}
main();
