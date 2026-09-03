#!/usr/bin/env node
/* 模擬遊玩的自我檢查。守兩件事:
 *   1. **獨立管線**(使用者 2026-09-03 的決定)—— 真實管線不 import 遊戲、遊戲只寫 web/data/game/。
 *   2. **側寫的每個數字對得回來源** —— 不是「看起來合理」,是重算一次要一樣。
 * 引擎的不變量(進球數 = 射門進球數、射手在場上、無操作 = 站上預測…)在下面第三節,
 * 引擎檔還沒建時那一節整段跳過並印出來,不假裝通過。 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teamMatchRows } from '../lib/style-trend.mjs';
import { loadTeams } from '../lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
};
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

console.log('\n▶ 模擬遊玩:獨立管線');
{
  /* 真實管線的任何檔案都不可以 import 遊戲模組。掃三個地方:scripts/lib、scripts/*.mjs(build 那些)、
     web/assets/js 裡不以 game- 開頭的檔。 */
  /* 唯一的例外是 page-explore.js —— 它是「探索」單頁的分頁宿主,遊戲要掛在網站上總得有一頁 import 它。
     它只負責 render(容器),不讀遊戲的任何資料。其他真實管線的檔案一律不可以。 */
  const realFiles = [
    ...walk(join(ROOT, 'scripts', 'lib')),
    ...readdirSync(join(ROOT, 'scripts')).filter(f => f.endsWith('.mjs')).map(f => join(ROOT, 'scripts', f)),
    ...readdirSync(join(ROOT, 'web', 'assets', 'js')).filter(f => f.endsWith('.js') && !f.startsWith('game-') && f !== 'page-explore.js').map(f => join(ROOT, 'web', 'assets', 'js', f)),
  ];
  const offenders = realFiles.filter(f => /from ['"][^'"]*(?:scripts\/game\/|\/game\/|\.\/game-)[^'"]*['"]/.test(readFileSync(f, 'utf8')));
  check('真實管線沒有任何檔案 import 遊戲模組(宿主 page-explore.js 除外)', offenders.length === 0, offenders.map(f => f.replace(ROOT, '')).join('、'));
  const explore = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-explore.js'), 'utf8');
  check('宿主只 import view 的 render,不碰遊戲資料', /import \{ renderGame \} from '\.\/game-view\.js/.test(explore) && !/game\/pl|game-engine/.test(explore));

  const build = readFileSync(join(ROOT, 'scripts', 'game', 'build-game.mjs'), 'utf8');
  const writes = [...build.matchAll(/writeFile\(([^)]*)\)/g)].map(m => m[1]);
  check('build-game 只寫 web/data/game/', writes.length > 0 && writes.every(w => /OUT/.test(w)) && /['"]web['"],\s*['"]data['"],\s*['"]game['"]/.test(build), writes.join(' | '));
  const profile = readFileSync(join(ROOT, 'scripts', 'game', 'lib', 'profile.mjs'), 'utf8');
  check('profile.mjs 只讀不寫(沒有 writeFile)', !/writeFile/.test(profile));

  /* 前端頁面清單:game- 開頭的共用模組要進 bundle 的 SHARED,不然單檔版靜靜少一頁。
     檔還沒建時這條先不驗(引擎是階段 2)。 */
  const bundle = readFileSync(join(ROOT, 'scripts', 'bundle.mjs'), 'utf8');
  const gameJs = readdirSync(join(ROOT, 'web', 'assets', 'js')).filter(f => f.startsWith('game-') && f.endsWith('.js'));
  if (gameJs.length) check('game-*.js 都在 bundle 的 SHARED 清單', gameJs.every(f => bundle.includes(`'${f.replace(/\.js$/, '')}'`)), gameJs.join('、'));
  else console.log('  · 前端遊戲模組還沒建,SHARED 那條略過');
}

console.log('\n▶ 模擬遊玩:側寫對得回來源');
{
  const P = join(ROOT, 'web', 'data', 'game', 'pl.json');
  if (!existsSync(P)) { check('web/data/game/pl.json 存在(先跑 npm run game:build)', false); }
  else {
    const g = read(P);
    const teams = Object.values(g.teams);
    check('20 隊', teams.length === 20, String(teams.length));
    check('每隊先發 11 人且都在名單裡', teams.every(t => t.xi.length === 11 && t.xi.every(c => t.squad.some(p => p.code === c))));
    check('每隊替補席 9 人、不與先發重覆', teams.every(t => t.bench.length === 9 && !t.bench.some(c => t.xi.includes(c))));
    check('每隊陣型選項至少一個、都是 N-N-… 形式', teams.every(t => t.formation.options.length >= 1 && t.formation.options.every(f => /^\d(-\d)+$/.test(f))));
    check('沒有任何隊的名單裡有人重覆', teams.every(t => new Set(t.squad.map(p => p.code)).size === t.squad.length));

    /* 事件率重算:拿 CSV 自己再算一次 ARS 主場射門均值。 */
    const T = loadTeams(ROOT);
    const csv = s => join(ROOT, 'data', 'raw', 'football-data-couk', `${s}.csv`);
    const rows = [g.lastSeason, g.currentSeason].filter(s => existsSync(csv(s)))
      .flatMap(s => teamMatchRows(readFileSync(csv(s), 'utf8'), { codeOf: T.codeOf }).get('ARS') ?? []);
    const home = rows.filter(r => r.home);
    const sf = Math.round((home.reduce((a, r) => a + r.sf, 0) / home.length) * 100) / 100;
    check('ARS 主場射門均值對回 CSV 重算', g.teams.ARS.rates.home.sf === sf && g.teams.ARS.rates.home.games === home.length, `${g.teams.ARS.rates.home.sf} vs ${sf}`);

    /* 控球分布重算:拿 raw 快取再算一次 MCI 主場控球均值。 */
    const dir = join(ROOT, 'data', 'raw', 'fotmob-epl');
    const fm = existsSync(dir) ? readdirSync(dir).filter(f => /-game-details\.json$/.test(f)).flatMap(f => Object.values(read(join(dir, f)).matches ?? {})) : [];
    const mci = fm.filter(m => m.home === 'MCI' && m.possession?.all).map(m => m.possession.all[0]);
    const mean = Math.round((mci.reduce((a, b) => a + b, 0) / mci.length) * 100) / 100;
    check('MCI 主場控球均值對回 raw 快取重算', g.teams.MCI.possession.home.mean === mean && g.teams.MCI.possession.home.n === mci.length, `${g.teams.MCI.possession.home.mean} vs ${mean}(n=${mci.length})`);
    check('每隊主客控球分布都有樣本', teams.every(t => t.possession.home.n > 0 && t.possession.away.n > 0));
    check('兩隊控球相加 = 100(每一場)', fm.every(m => !m.possession?.all || m.possession.all[0] + m.possession.all[1] === 100));

    /* 射門情境:各隊份額相加 = 1;每次射門的 xG 在 [0,1]。 */
    check('射門情境份額相加 = 1(聯賽層)', Math.abs(Object.values(g.league_.shotSituations).reduce((a, s) => a + s.share, 0) - 1) < 0.01);
    check('逐射門 xG 都在 [0,1]', fm.every(m => m.shots.every(s => s.xg === null || (s.xg >= 0 && s.xg <= 1))));
    check('射門進球數 = 比分(每一場 shotmap 完整,或標了不完整)', fm.every(m => m.checks?.shotmapComplete === (m.shots.filter(s => s.type === 'Goal').length === m.score[0] + m.score[1])));

    /* 能力值:用了哪一季要寫;有值的分鐘一定 ≥ 450。 */
    const all = teams.flatMap(t => t.squad);
    check('能力值來源標示與門檻一致', all.every(p => (p.ability.src === null) === (p.ability.att === null) && (p.ability.src === null || p.ability.minutes >= 450)));
    check('牌數是非負整數', all.every(p => Number.isInteger(p.yellow) && p.yellow >= 0 && Number.isInteger(p.red) && p.red >= 0));

    /* 獨立來源核對:本季快取的 verification 區塊要全部通過。 */
    const cur = read(join(dir, `${g.currentSeason}-game-details.json`));
    check('控球率的官網核對全部在容差內', cur.verification && cur.verification.checked >= 10 && cur.verification.agree === cur.verification.checked,
      cur.verification ? `${cur.verification.agree}/${cur.verification.checked}` : '沒有 verification');
    check('抽樣類的來源說明有 n', ['rates', 'possession', 'shots', 'subs'].every(k => /\d/.test(g.sources[k] ?? '')));
  }
}

console.log('\n▶ 模擬遊玩:引擎不變量');
{
  const enginePath = join(ROOT, 'web', 'assets', 'js', 'game-engine.js');
  if (!existsSync(enginePath)) console.log('  · game-engine.js 還沒建(階段 2),整節略過');
  else {
    const mod = await import(pathToFileURL(enginePath));
    const { runEngineChecks } = await import(pathToFileURL(join(ROOT, 'scripts', 'game', 'lib', 'engine-checks.mjs')));
    for (const [label, ok, detail] of await runEngineChecks(mod, ROOT)) check(label, ok, detail);
  }
}
