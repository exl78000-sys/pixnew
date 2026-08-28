#!/usr/bin/env node
/* 文件裡的數字對不對得回實際資料。

   這個專案的賣點是「每個數字都查得到出處」,但**文件自己的數字會過期**。
   2026-08-28 實測到的:vault 寫 5,675 則(實際 5,716,四個地方都錯)、
   租借寫「發布 117 / 退回 14」(實際 593 / 0)、傷停寫 2 天(實際 5)。
   手動改一輪沒有用 —— 下次改資料又會歪,而且沒有人會發現。

   所以宣告一組要守的數字,讓它對不上就紅。
   `npm run docs:check -- --fix` 會直接把文件裡的數字改成實際值。

   **測試的區塊數與斷言數不在這裡守**,因為那個每加一條測試就變 ——
   那兩個數字由 `npm test` 自己印出來,文件不寫死(見 scripts/test-all.mjs)。

   **而資料類的數字也要再分一次。** 第一版把它們全部當紅線,結果 CI 每跑一次
   資料就紅一次 —— vault 筆記數會隨賽程與球員變(本機 5,716、CI 5,733)、
   頭貼會隨每次 photos 抓到新圖而增加、傷停快照每天 +1。
   把這種數字當紅線,只會訓練人忽略紅色,比不檢查更糟。

   所以分兩種:
     drifts: true   會隨資料自然變動 → **只回報,不擋**。文件裡那個數字是快照。
     drifts: false  只有人為改動才會變(新交付、接了新資料源)→ 對不上就紅。

   還有一條比分類更前面的規則:**檢查的對象只能是「現況」**。
   敘事裡描述過去事件的數字(「當時核對後發布了 N 筆」)是紀錄不是狀態,
   自動改它等於竄改歷史。踩過一次,見下面租借那一段的註解。

   兩種都會把實際值印出來,CI 的 log 才能自己說明發生什麼事。 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.argv.includes('--fix');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const arr = x => (Array.isArray(x) ? x : Object.values(x ?? {}));
const has = p => existsSync(join(ROOT, p));

const countVaultNotes = () => {
  const dir = join(ROOT, 'vault');
  if (!existsSync(dir)) return null;
  // 只有手寫資料夾 = 產物還沒產生(CI 的 checkout 就是這樣),不是「有 0 則筆記」
  const generated = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '我的筆記');
  if (!generated.length) return null;
  let n = 0;
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '我的筆記') walk(full); }
      else if (e.name.endsWith('.md') && full !== join(dir, 'README.md')) n++;
    }
  };
  walk(dir);
  return n;
};

/* 每一項:實際值怎麼算、在文件裡長什麼樣。
   `pattern` 必須剛好一個捕捉群組 —— 那個群組就是要比對(或修正)的數字。
   刻意用很窄的樣式:寬鬆的樣式會去改到別的句子裡剛好長得像的數字。 */
const CHECKS = [
  {
    key: 'vault 筆記數',
    drifts: true,   // 賽程、球員一變就變
    actual: countVaultNotes,
    patterns: [/共 ([\d,]+) 則筆記/g, /vault[^。\n]{0,20}?\(([\d,]{4,6}) 則/g, /\*\*([\d,]{4,6}) 則筆記/g],
  },
  /* **租借發布筆數已經拿掉,不要加回來。**

     它在文件裡只出現在一句**敘述過去的話**:
       「重做版已收下…759 筆進來,核對後發布 594 筆(confirmed 153・consistent 440)」
     那是收件當下的紀錄。594 在那一刻是對的,而 `--fix` 會把它改成今天的數字 ——
     等於竄改一筆歷史紀錄,讓它宣稱「當時發布了 597 筆」,而那是假的。

     這一輪在 CI 上實際發生了:本機 594、CI 597。原因是 `npm run fetch --force`
     會更新 data/raw/fpl/*.csv,而核對器對那份 CSV 有自我檢查 ——
     本機那份 2026-27 被拒用,CI 抓到新的通過了,於是 3 筆從「無法核對」
     變成「無矛盾」。數字本身沒有錯,是我把它當成了現況。

     **規則:只檢查以「現況」呈現的數字(現況表、「目前 N 場」),
     不要碰敘事裡描述過去事件的數字。** 後者是紀錄,不是狀態。 */
  {
    /* 「N / 54 有隊徽」指的是**歐冠三季出現過的不重複球隊**裡有幾支拿得到隊徽,
       不是 ucl-teams.json 的 teams 長度(那是本站登錄過的球隊,不等於在歐冠出現過)。
       第一版就是這樣算錯的,算出 55。 */
    key: '歐冠有隊徽的球隊數',
    drifts: false,   // 只有補了隊徽或多一季才會變

    actual: () => {
      if (!has('web/data/ucl.json') || !has('web/data/ucl-teams.json')) return null;
      const u = read(join(ROOT, 'web/data/ucl.json'));
      const assets = read(join(ROOT, 'web/data/ucl-teams.json'));
      const external = new Set((assets.external ?? []).map(t => t.id));
      const seen = new Map();
      const see = t => { if (t && t.id != null && !seen.has(t.id)) seen.set(t.id, t); };
      for (const s2 of u.seasons ?? []) {
        for (const m of s2.leagueMatches ?? []) { see(m.home); see(m.away); }
        for (const rd of s2.rounds ?? []) for (const tie of rd.ties ?? []) for (const leg of tie.legs ?? []) { see(leg.home); see(leg.away); }
        for (const r of s2.table?.rows ?? []) see(r);
      }
      return [...seen.values()].filter(t => t.code || external.has(t.id)).length;
    },
    patterns: [/(\d+) \/ 54 有隊徽/g, /變成 (\d+)\/54 有隊徽/g],
  },
  {
    key: '傷停快照天數',
    drifts: true,   // 每天 +1

    actual: () => {
      const p = join(ROOT, 'data', 'availability-history.json');
      if (!existsSync(p)) return null;
      const j = read(p);
      return Array.isArray(j) ? j.length : Object.keys(j.days ?? j).length;
    },
    patterns: [/\*\*(\d+) \/ 60 天\*\*/g, /傷停快照[^|\n]*\|\s*(\d+) \/ 60 天/g],
  },
  {
    /* **樣式一定要窄。** 第一版寫成 /(\d{3}) \/ 599/,結果去比到
       「補球員背號 544/599」—— 那是背號不是頭貼,`--fix` 會把它改成 584 改壞。
       所以要求同一行裡出現「頭貼」才算。 */
    key: '英超球員頭貼',
    drifts: true,   // 每次 photos 抓到新圖就增加

    actual: () => {
      if (!has('web/data/players.json')) return null;
      const pl = arr(read(join(ROOT, 'web/data/players.json')));
      return pl.filter(p => p.photo).length;
    },
    patterns: [/頭貼[^|\n]{0,24}?(\d{3})\s?\/\s?599/g],
  },
];

const DOCS = ['../CLAUDE.md', 'README.md', 'docs/接手資訊.md', 'docs/補齊規劃.md']
  .map(f => join(ROOT, f)).filter(existsSync);

let bad = 0, drifted = 0, fixed = 0, checked = 0;
console.log('\n▶ 文件數字對不對得回實際資料');

for (const c of CHECKS) {
  let actual;
  try { actual = c.actual(); } catch { actual = null; }
  if (actual === null || actual === undefined) {
    console.log(`  · ${c.key}:算不出實際值(資料還沒產生),略過`);
    continue;
  }
  // 實際值一律印出來 —— CI 上出問題時,log 要能自己說明是什麼對不上
  console.log(`  · ${c.key}:實際 ${actual}${c.drifts ? '(會隨資料變動,只回報)' : ''}`);
  const want = String(actual);
  const wantComma = actual.toLocaleString('en-US');
  for (const file of DOCS) {
    let text = readFileSync(file, 'utf8');
    let changed = false;
    for (const pat of c.patterns) {
      text = text.replace(new RegExp(pat.source, pat.flags), (m, got) => {
        checked++;
        const plain = String(got).replace(/,/g, '');
        if (plain === want) return m;
        if (c.drifts) drifted++; else bad++;
        const useComma = String(got).includes(',');
        const repl = m.replace(got, useComma ? wantComma : want);
        console.log(`  ${FIX ? '✎' : (c.drifts ? '·' : '✗')} ${c.key} @ ${file.replace(`${ROOT}/`, '')}`
          + `:文件寫 ${got},實際 ${want}${c.drifts ? '(快照過期,不擋)' : ''}`);
        if (FIX) { changed = true; fixed++; return repl; }
        return m;
      });
    }
    if (FIX && changed) writeFileSync(file, text);
  }
}

console.log(`\n  掃到 ${checked} 處宣稱・該紅的對不上 ${bad} 處・快照過期 ${drifted} 處`
  + `${FIX ? `・已修 ${fixed} 處` : ''}`);
if (drifted && !FIX) {
  console.log('  快照過期的那幾處不會擋 CI(那些數字本來就會隨資料變動)。');
  console.log('  想更新就跑:npm run docs:check -- --fix');
}
if (bad && !FIX) {
  console.log('  修法:npm run docs:check -- --fix');
  console.log('  (改完請看一眼 —— 自動改的是數字,句子的意思要人確認)');
  process.exitCode = 1;
}
