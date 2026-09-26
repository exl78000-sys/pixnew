#!/usr/bin/env node
/* 五個聯賽的走查回測**並行**跑(2026-09-26,D1)。

   為什麼:部署 workflow 原本把 laliga / en2 / de1 / it1 / fr1 五支回測排成五個串行步驟,
   而它們彼此完全獨立(各自的 raw、各自的輸出檔),只是等前一支跑完才開始下一支。
   runner 有多個核心,並行就是白拿的時間。英超的走查回測在 test.mjs 裡(它的斷言直接吃回測的結果),不在這裡。

   清單**不手寫**:從 lib/test-steps.mjs(npm test 的同一份步驟)挑出 backtest-*.mjs 那幾支 ——
   加第七個聯賽時只要改那一份,這裡與 npm test 都會跟著。

   每一支的輸出等它結束才整段印(並行時交錯印會讀不懂);任何一支失敗整支就失敗,
   讓 workflow 跟原本五個步驟一樣紅。用法:npm run backtests */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS, isBacktestStep } from './lib/test-steps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LEAGUE_BACKTESTS = STEPS.filter(isBacktestStep).map(([file]) => file);

function run(file) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const chunks = [];
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: process.env });
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => chunks.push(d));
    child.on('close', code => resolve({ file, code, out: Buffer.concat(chunks).toString('utf8'), secs: (Date.now() - t0) / 1000 }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t0 = Date.now();
  const results = await Promise.all(LEAGUE_BACKTESTS.map(run));
  for (const r of results) {
    console.log(`\n═══ ${r.file}(${r.secs.toFixed(0)} 秒,exit ${r.code})═══`);
    process.stdout.write(r.out);
  }
  const failed = results.filter(r => r.code !== 0);
  console.log(`\n▶ ${results.length} 個聯賽的走查回測並行跑完:${((Date.now() - t0) / 1000).toFixed(0)} 秒`
    + `(串行會是 ${results.reduce((a, r) => a + r.secs, 0).toFixed(0)} 秒)${failed.length ? `・失敗 ${failed.map(r => r.file).join('、')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}
