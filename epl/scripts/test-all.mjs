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
import { fileURLToPath } from 'node:url';
import { STEPS, isBacktestStep, isGameStep } from './lib/test-steps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* 步驟清單在 lib/test-steps.mjs(2026-09-26 抽出去:部署 workflow 的 backtest-all 要挑同一份清單裡的回測並行跑)。

   --skip-backtests:部署 workflow 用。五個聯賽的走查回測在同一個 job 前面已經並行跑過(backtest-all.mjs,
   同一次 checkout、同一批 raw),這裡不重跑;test-laliga 那幾支照樣驗它們寫出的產物。
   本機 npm test 不帶旗標,全部跑 —— 本機沒有前面那一步。 */
const SKIP_BACKTESTS = process.argv.includes('--skip-backtests');
/* --skip-game:同樣是部署 workflow 用。模擬引擎的測試一支 7 分鐘、只讀倉庫裡的東西,
   workflow 另開 game-tests job 跟 build 並行跑它,deploy 兩邊都等。本機 npm test 照跑。 */
const SKIP_GAME = process.argv.includes('--skip-game');
const steps = STEPS.filter(s => !(SKIP_BACKTESTS && isBacktestStep(s)) && !(SKIP_GAME && isGameStep(s)));
if (SKIP_BACKTESTS) console.log(`· --skip-backtests:略過 ${STEPS.filter(isBacktestStep).length} 支走查回測(部署 workflow 前面已並行跑過,產物照驗)`);
if (SKIP_GAME) console.log('· --skip-game:略過模擬引擎的測試(部署 workflow 的 game-tests job 並行跑它)');

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
const failedSteps = [];
/* 每一步印耗時(2026-09-26,D1):部署那一步 855 秒到底花在哪裡,以前只能猜。 */
for (const [step, args] of steps) {
  const t0 = Date.now();
  const code = await run(step, args);
  console.log(`  ⏱ ${step} ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  if (code !== 0) {
    exitCode = exitCode || code;
    failedSteps.push(step);
  }
}

if (failedSteps.length) console.log(`\n✗ 失敗的步驟:${failedSteps.join('、')}`);
console.log(`\n▶ 合計:${tally.blocks} 個區塊、${tally.pass + tally.fail} 條斷言、${tally.fail} 條失敗`);
console.log('  這兩個數字不要寫進文件 —— 每加一條測試就會歪。要引用就指向這一行。');
process.exit(exitCode);
