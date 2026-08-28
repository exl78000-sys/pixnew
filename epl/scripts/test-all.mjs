#!/usr/bin/env node
/* `npm test` 的外殼:依序跑三支,串流它們的輸出,最後印一次合計。

   為什麼要這一層:**測試的區塊數與斷言數不可以寫進文件。**
   每加一條測試就要記得改三個地方,而那三個地方一定會分岔 ——
   2026-08-28 實測:CLAUDE.md 說「20 個區塊、205 條斷言」、
   接手資訊說「29 個區塊、533 條」、補齊規劃說「19 區塊 / 166 條」,
   而實際是 30 / 549。三份文件三個數字,全錯。

   所以數字改成跑的時候算出來,文件只指向這一行。
   (資料類的數字 —— vault 筆記數、租借發布數之類 —— 走 `npm run docs:check`,
   那些不會每次改測試就變,適合守在文件裡。)

   順序與失敗傳遞見下面 STEPS。 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 順序不能動:backtest-laliga 產生的數字是 test-laliga 要驗的。

   後面兩步是 2026-08-28 補的:
   - check-docs  文件裡的數字對不對得回實際資料(手動維護一定會歪,實測過三份三個數)
   - obsidian    vault 的產生器自己有兩道守門(同檔名、壞連結),但**沒有任何流程在跑它** ——
                 資料結構一變會安靜壞掉,要等有人手動跑 local:sync 才發現。
                 寫到暫存目錄,不動使用者真正在用的那一份(他可能正開著 Obsidian)。 */
const VAULT_TMP = join(tmpdir(), 'epl-vault-test');
const STEPS = [
  ['scripts/test.mjs', []],
  ['scripts/backtest-laliga.mjs', []],
  ['scripts/test-laliga.mjs', []],
  ['scripts/check-docs.mjs', []],
  ['scripts/build-obsidian.mjs', [`--out=${VAULT_TMP}`]],
];

const tally = { blocks: 0, pass: 0, fail: 0 };
/* 逐行掃輸出來數。用 stdout 而不是去改三十幾個各自的 ok()/check() 閉包 ——
   那些閉包散在兩個檔案裡,各自有各自的寫法(✓ 與 ✔ 都有人用)。 */
function count(chunk, carry) {
  const text = carry + chunk;
  const lines = text.split('\n');
  const rest = lines.pop();
  for (const line of lines) {
    if (/^\s*▶/.test(line)) tally.blocks++;
    else if (/^\s+[✓✔]/.test(line)) tally.pass++;
    else if (/^\s+✗/.test(line)) tally.fail++;
  }
  return rest;
}

function run(file, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: ROOT, env: process.env });
    let carry = '';
    child.stdout.on('data', d => {
      const s = d.toString();
      process.stdout.write(s);
      carry = count(s, carry);
    });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('error', reject);
    child.on('close', code => {
      if (carry) count('\n', carry);
      carry = '';
      resolve(code);
    });
  });
}

let exitCode = 0;
for (const [step, args] of STEPS) {
  const code = await run(step, args);
  if (code !== 0) {
    exitCode = code;
    console.log(`\n✗ ${step} 結束碼 ${code},停在這裡`);
    break;
  }
}

console.log(`\n▶ 合計:${tally.blocks} 個區塊、${tally.pass + tally.fail} 條斷言、${tally.fail} 條失敗`);
console.log('  這兩個數字不要寫進文件 —— 每加一條測試就會歪。要引用就指向這一行。');
process.exit(exitCode);
