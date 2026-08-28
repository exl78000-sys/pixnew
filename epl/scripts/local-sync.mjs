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
  console.log('▶ 核對人工交付的租借紀錄');
  await run('scripts/verify-loans.mjs');
  /* 順序不能反。stamp-assets.mjs 掛在 build.mjs 最後,會把資產戳寫進**兩個聯賽**
     的 meta.json;先跑 build 再跑 laliga:build 的話,後者會把 es1 的 meta 重寫掉、
     戳就不見了,npm test 的「meta 記的戳跟實際檔案一致」會紅。
     這一支原本就是反的(build → laliga:build),2026-08-28 修正。 */
  console.log('▶ 建立西甲資料集');
  await run('scripts/build-laliga.mjs');
  await run('scripts/fetch-news.mjs', ['--league=en2']);
  await run('scripts/backtest-championship.mjs');
  await run('scripts/build-championship.mjs');
  console.log('▶ 建立英超資料集');
  await run('scripts/build.mjs');
  /* vault 是本機資產(gitignore),所以在本機流程重建,不放 CI ——
     在 runner 上產生一份沒有人看得到的 5,675 則筆記沒有意義。 */
  console.log('▶ 重建 Obsidian vault');
  await run('scripts/build-obsidian.mjs');
  console.log('✔ 本機同步完成；資料仍只在本機，確認後再 git commit / push。');
} catch (err) {
  console.error(`✗ 本機同步失敗：${err.message}`);
  process.exitCode = 1;
}
