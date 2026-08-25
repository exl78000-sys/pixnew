#!/usr/bin/env node
// 每天存一份「當下的傷停狀態」,讓這個特徵**將來**能被回測。
//
//   node scripts/snapshot-availability.mjs      (build 之後跑)
//
// 為什麼需要這支:
// 傷停資料的來源(FPL)只給「現在」的名單,不給歷史。要證明「傷停有沒有讓
// 預測變準」,必須知道每一場比賽開打當下誰不能上 —— 拿今天的傷兵名單去回測
// 半年前的比賽等於偷看未來,測出來再漂亮也是假的。
//
// 上游不留歷史,那就自己留。每天存一份,累積一季之後就有真正的逐輪快照,
// 屆時可以跟近期狀況一樣走一次完整的走查回測,再決定要不要進模型。
//
// 存的東西刻意很小:每隊只留缺陣者的球員代碼與兩個比例。
// 名字、傷勢描述都不存 —— 那些查得到,而且會把檔案撐大。
//
// 合併衝突怎麼解:這個檔 runner 每天寫、本機 build 也會寫,所以 git merge 一定會撞。
// 解法固定是「隨便挑一邊,然後重跑這支」—— 因為它是以日期為鍵覆寫的,
// 重跑只會蓋掉今天那一筆,以前的天數原封不動。不要手動編輯 JSON。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { round } from './lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'web', 'data', 'form.json');
const OUT = join(ROOT, 'data', 'availability-history.json');

if (!existsSync(SRC)) {
  console.log('⚠ 找不到 web/data/form.json —— 請先跑 npm run build');
  process.exit(0);
}
const form = JSON.parse(readFileSync(SRC, 'utf8'));
const store = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, 'utf8'))
  : { note: '每日傷停快照。累積足夠場次後可用於走查回測 —— 在此之前傷停只是資訊,不進模型。', days: [] };

const day = {
  date: form.asOf,
  teams: Object.fromEntries(Object.entries(form.teams).map(([code, t]) => {
    const a = t.availability;
    return [code, {
      // 球隊踢了幾場 —— 回測時要靠它把快照對到正確的輪次
      p: a.teamMatches,
      base: a.baseline,
      // 缺了多少上場時間 / 多少期望進球參與(0~1)
      mo: round(a.missing.minutes, 4), th: round(a.missing.threat, 4),
      dmo: round(a.missing.doubtMinutes, 4), dth: round(a.missing.doubtThreat, 4),
      out: a.out.map(o => o.code),
      doubt: a.doubt.map(o => o.code),
    }];
  })),
};

// 同一天重跑就覆蓋,不要累積成一堆重複的快照
const i = store.days.findIndex(d => d.date === day.date);
if (i >= 0) store.days[i] = day; else store.days.push(day);
store.days.sort((a, b) => (a.date < b.date ? -1 : 1));
store.updatedAt = new Date().toISOString();
store.backtestable = store.days.length >= 60;   // 大約兩個月才有一季一半的輪次

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(store));
console.log(`✔ 傷停快照:${day.date}(累積 ${store.days.length} 天`
  + `${store.backtestable ? ',已足夠嘗試回測' : `,還需約 ${60 - store.days.length} 天才夠回測`})`);
