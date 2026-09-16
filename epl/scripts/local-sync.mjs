#!/usr/bin/env node
// 本機一次同步：把目前可取得的即時資料寫回本地快取並重建**每一個**聯賽的資料集。
// 不跑賽後大批量補抓、不提交 Git；發布前由使用者檢查後一次 git push。
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* 走 npm script 而不是直接指 .mjs:聯賽的腳本檔名推不出來,而 package.json 就是那張對照表。 */
function npm(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', script],
      { cwd: ROOT, env: process.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`npm run ${script} exit ${code}`)));
  });
}

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
  /* 其餘聯賽:**掃 `web/data/leagues/` 目錄**,不手寫清單。
     這一段原本是手寫的(西甲 → 英冠 → 德甲),加義甲法甲時沒有人回來改 ——
     於是 `npm run local:sync` 只重建四個聯賽,義甲法甲靜靜停在舊產物,
     而畫面完全正常(「手寫的聯賽清單,加第五個聯賽時沒有人會記得回來改」)。
     規矩不變:回測在該聯賽的 build 之前、所有聯賽都在 `scripts/build.mjs` 之前 ——
     資產戳是最後那一支寫的,任何聯賽排在它後面,那個聯賽的戳就會被重寫掉。
     對照表用 package.json 的 npm scripts(那是真正的映射,檔名推不出來:
     es1 → laliga、en2 → championship、de1 → bundesliga…)。
     `EXPLICIT` 是不照 `{聯賽}:build` 慣例的那幾個,上面已經各自跑過;
     兩種都不是就**當場失敗**,不要靜靜跳過。 */
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
  const EXPLICIT = new Set(['es1']);   // 西甲的 npm script 叫 laliga:*,而且上面單獨跑了
  const leagueKeys = readdirSync(join(ROOT, 'web', 'data', 'leagues'), { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name).sort();
  const uncovered = leagueKeys.filter(k => !EXPLICIT.has(k) && !scripts[`${k}:build`]);
  if (uncovered.length) throw new Error(`這幾個聯賽既沒有 {聯賽}:build 也不在明確清單裡,不會被重建:${uncovered.join('、')}`);
  for (const k of leagueKeys) {
    if (EXPLICIT.has(k)) continue;
    for (const step of ['verify-teams', 'verify-coaches', 'backtest', 'build']) {
      if (scripts[`${k}:${step}`]) await npm(`${k}:${step}`);
    }
  }
  /* 走 `npm run build` 而不是直接指 `scripts/build.mjs` —— 那個 npm script 是**三支的串接**
     (build.mjs && game/build-game.mjs && stamp-assets.mjs)。直接指 build.mjs 的話後兩支不會跑,
     而 `stamp-assets.mjs` 是把資產戳寫進**每一個**聯賽 meta.json 的那一支:
     跑完 `npm run local:sync` 之後六個聯賽的 `meta.assets` 全都是 undefined
     (不是對不上,是不見了),`npm test` 紅 12 條。
     這一支的註解從以前就在講資產戳的順序規矩,而它自己根本沒有跑那一步 ——
     跟 laliga-matchday.yml 那次(迴圈補一行 npm run stamp)是同一個根因的第三次。
     「build 是什麼」只能有一個定義,就是 package.json 裡的那一行。 */
  console.log('▶ 建立英超資料集(含模擬遊玩產物與資產戳)');
  await npm('build');
  /* vault 是本機資產(gitignore),所以在本機流程重建,不放 CI ——
     在 runner 上產生一份沒有人看得到的 5,675 則筆記沒有意義。 */
  console.log('▶ 重建 Obsidian vault');
  await run('scripts/build-obsidian.mjs');
  console.log('✔ 本機同步完成；資料仍只在本機，確認後再 git commit / push。');
} catch (err) {
  console.error(`✗ 本機同步失敗：${err.message}`);
  process.exitCode = 1;
}
