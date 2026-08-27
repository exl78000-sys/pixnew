#!/usr/bin/env node
// 本機一次同步：把目前可取得的即時資料寫回本地快取並重建兩聯賽資料集。
// 不跑賽後大批量補抓、不提交 Git；發布前由使用者檢查後一次 git push。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function run(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exit ${code}`)));
  });
}

try {
  console.log('▶ 本機一次同步：英超即時快取');
  await run('scripts/fetch-live.mjs');
  console.log('▶ 本機一次同步：西甲 SportMonks 即時快取（最多 2 次請求）');
  await run('scripts/fetch-laliga-live.mjs', ['--max-requests=2']);
  console.log('▶ 建立英超資料集');
  await run('scripts/build.mjs');
  console.log('▶ 建立西甲資料集');
  await run('scripts/build-laliga.mjs');
  console.log('✔ 本機同步完成；資料仍只在本機，確認後再 git commit / push。');
} catch (err) {
  console.error(`✗ 本機同步失敗：${err.message}`);
  process.exitCode = 1;
}
