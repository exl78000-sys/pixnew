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

    /* 動畫的節奏資料(2026-09-03):跑動節奏、三路進攻、逐人熱區與跑動。不是每場都有追蹤資料,
       所以看的是「大多數」而不是全部;熱區質心要落在球場內,門將不該有熱區驅動(引擎那邊排除),
       三路佔比相加要是 1。 */
    const xiAll = teams.flatMap(t => t.xi.map(c => t.squad.find(p => p.code === c)));
    check('每隊都有跑動節奏(pace),每分鐘跑動距離在 800–1600 m 之間', teams.every(t => t.pace && t.pace.distancePerMin > 800 && t.pace.distancePerMin < 1600), teams.filter(t => !t.pace).map(t => t.code).join('、'));
    check('每隊都有三路進攻佔比且相加 = 1', teams.every(t => t.zones && Math.abs(t.zones.left + t.zones.center + t.zones.right - 1) < 0.02));
    check('先發球員多數有觸球熱區(≥ 80%),質心在球場內', xiAll.filter(p => p.heat).length >= xiAll.length * 0.8 && xiAll.every(p => !p.heat || (p.heat.cx >= 0 && p.heat.cx <= 105 && p.heat.cy >= 0 && p.heat.cy <= 68)), `${xiAll.filter(p => p.heat).length}/${xiAll.length}`);
    /* 下限不設 3 km:替補上場幾分鐘的人場均本來就低(實測有),上限 14 km 抓的是單位錯(公尺當公里之類) */
    check('先發球員多數有場均跑動(≥ 80%),數字在 0–14 km', xiAll.filter(p => p.run).length >= xiAll.length * 0.8 && xiAll.every(p => !p.run || (p.run.distancePerGame > 0 && p.run.distancePerGame < 14000)), `${xiAll.filter(p => p.run).length}/${xiAll.length}`);
    check('門將的熱區質心在自家半場(座標方向:兩隊都向右進攻)', xiAll.filter(p => p.pos === 'GK' && p.heat).every(p => p.heat.cx < 30));

    /* 射門池(2026-09-15 回合制):每隊的真實射門列 [x, y, xG, 情境, 結果, 射手];座標在球場內、xG 在 [0,1]、
       射手配對率要夠(對不上永遠是安靜的 —— 收完要數一次配對率),而且每隊的列數對得回 raw 裡該隊有射手的射門數。 */
    /* 升班馬(HUL / IPS / COV)只有本季的英超場次,射門池幾十筆是資料的事實 —— 引擎某情境抽不到時退回聯賽池。門檻 30 守「有池」 */
    check('每隊都有射門池,列數 ≥ 30、座標在 105×68 內、xG 在 [0,1]', teams.every(t => t.shots && t.shots.n >= 30 && t.shots.rows.every(r => r[0] >= 0 && r[0] <= 105 && r[1] >= 0 && r[1] <= 68 && r[2] >= 0 && r[2] <= 1)), teams.map(t => `${t.code} ${t.shots?.n}`).filter(x => /\s\d\d?$/.test(x)).join('、'));
    check('射門池的射手配對率 ≥ 50%(每隊)', teams.every(t => t.shots.matched >= 0.5), teams.map(t => `${t.code} ${t.shots.matched}`).filter(x => /0\.[0-4]/.test(x)).join('、'));
    check('射門池的情境與結果標籤是已知的那幾種', teams.every(t => t.shots.sits.every(s => ['RegularPlay', 'FastBreak', 'IndividualPlay', 'ThrowInSetPiece', 'FromCorner', 'FreeKick', 'SetPiece', 'Penalty'].includes(s)) && t.shots.outs.every(o => ['goal', 'saved', 'blocked', 'off', 'post'].includes(o))));
    check('射門池的列數對回 raw 重算(ARS:該隊有座標與 xG 的射門筆數)', (() => {
      const n = fm.flatMap(m => m.shots).filter(sh => sh.team === 'ARS' && Number.isFinite(sh.x) && Number.isFinite(sh.y) && sh.xg != null).length;
      return g.teams.ARS.shots.n === n;
    })(), `${g.teams.ARS.shots.n}`);
    check('聯賽層射門池存在(某隊某情境一筆都沒有時的退路),列數是各隊的抽樣', g.league_.shotPool && g.league_.shotPool.rows.length >= 300);
    check('每隊有主 / 客場的傳球數與越位數(回合制的傳球串長度與越位率用)', teams.every(t => t.play && ['home', 'away'].every(v => t.play[v] && t.play[v].games > 0 && t.play[v].passes > 200 && t.play[v].passes < 900 && t.play[v].offsides >= 0 && t.play[v].offsides < 8)));
    /* 踢法側寫(階段 B):六軸都有級與依據;20 隊分五級各 4 隊(排名分級);代理指標有標;值對回 rates / play 重算(ARS 心態 = 射門 − 被射門) */
    const AX = ['mentality', 'pressing', 'line', 'width', 'tempo', 'directness'];
    check('每隊都有六軸踢法側寫,級 1~5、附 n 與依據', teams.every(t => t.style && AX.every(k => t.style[k] && t.style[k].level >= 1 && t.style[k].level <= 5 && t.style[k].n > 0 && t.style[k].basis)));
    check('20 隊每一軸分五級各 4 隊(排名分級,不是絕對門檻)', AX.every(k => { const c = [0, 0, 0, 0, 0]; for (const t of teams) c[t.style[k].level - 1]++; return c.every(x => x === 4); }));
    /* 階段 C 回填後壓迫與直接度換成直接指標(proxy=false,依據寫著 FotMob 逐場);心態 / 防線 / 節奏仍是代理 */
    check('代理指標有標(心態 / 防線 / 節奏是代理;寬度、壓迫、直接度是直接量)', teams.every(t => t.style.mentality.proxy === true && t.style.line.proxy === true && t.style.tempo.proxy === true && t.style.width.proxy === false && t.style.pressing.proxy === false && /FotMob/.test(t.style.pressing.basis) && t.style.directness.proxy === false) && g.styleAxes && AX.every(k => g.styleAxes[k].zh && g.styleAxes[k].levels.length === 5));
    check('ARS 心態的依據值對回 rates 重算(射門 − 被射門,主客按場數加權)', (() => {
      const r = g.teams.ARS.rates; const w = (k) => (r.home.games * r.home[k] + r.away.games * r.away[k]) / (r.home.games + r.away.games);
      return Math.abs(g.teams.ARS.style.mentality.value - (w('sf') - w('sa'))) < 0.01 && g.teams.ARS.style.mentality.n === r.home.games + r.away.games;
    })(), String(g.teams.ARS.style.mentality.value));
    /* 階段 C(2026-09-15):對照表以外的球隊統計。回填之前 raw 沒有 teamExtra,這幾條只印「尚未回填」不擋;
       有了之後要能對回獨立來源:黃牌對 football-data.co.uk 的逐場牌數(完全不同的供應商)、禁區內外射門相加 = 射門、
       blocked_shots 對同一份 payload 的 shot_blocks。抄截 / 攔截 / 對抗沒有第二來源,只能講清楚。 */
    {
      const withExtra = fm.filter(m => m.teamExtra && Object.values(m.teamExtra).some(t => Object.keys(t).length));
      if (!withExtra.length) console.log('  · teamExtra 尚未回填(跑 game-backfill.yml 之後這幾條才會驗)');
      else {
        check('teamExtra:禁區內外射門相加 = 射門(每一場、每一隊)', withExtra.every(m => Object.entries(m.teamExtra).every(([c, x]) => x.shots_inside_box == null || x.shots_outside_box == null || m.teamStats[c].shots == null || x.shots_inside_box + x.shots_outside_box === m.teamStats[c].shots)), `${withExtra.length} 場`);
        /* blocked_shots 是**自己被封阻的射門**(跟射門圖的 blocked 逐顆對得上 760/760);shot_blocks 是**自己做的封阻**(對側,而且只有 77% 相等)。
           第一版拿兩個互比,紅了才發現本站一直把 shot_blocks 當「被封阻射門」顯示 —— 對照表已換(2026-09-15 深夜) */
        check('teamExtra:blocked_shots = 射門圖裡該隊被封阻的射門數(射門圖完整的場次,逐場逐隊)', withExtra.filter(m => m.checks?.shotmapComplete).every(m => [m.home, m.away].every(c => m.teamExtra[c].blocked_shots == null || m.shots.filter(sh => sh.team === c && sh.blocked).length === m.teamExtra[c].blocked_shots)));
        /* raw 裡版本 2 的紀錄是換鍵**之前**抓的,blockedShots 仍是 shot_blocks;讀取器(fixBlockedShots)用 teamExtra / 射門圖修正,側寫與報告都走它 */
        const { fixBlockedShots } = await import('../lib/matchstats.mjs');
        check('讀取器修正後 teamStats.blockedShots = 自己被封阻的射門(= blocked_shots)', withExtra.every(m => { const t = fixBlockedShots(m); return [m.home, m.away].every(c => t[c].blockedShots == null || m.teamExtra[c].blocked_shots == null || t[c].blockedShots === m.teamExtra[c].blocked_shots); }));
        const csvRows = [g.lastSeason, g.currentSeason].filter(s2 => existsSync(csv(s2))).flatMap(s2 => [...teamMatchRows(readFileSync(csv(s2), 'utf8'), { codeOf: T.codeOf }).entries()].flatMap(([code, rows2]) => rows2.map(r => ({ code, ...r }))));
        /* CSV 的逐場列只有 cards(黃 + 紅合計),所以比的是 yellow_cards + red_cards */
        let cmp = 0, agree = 0;
        for (const m of withExtra) for (const [c, x] of Object.entries(m.teamExtra)) {
          if (x.yellow_cards == null) continue;
          const r = csvRows.find(q => q.code === c && q.date === m.date);
          if (!r || !Number.isFinite(r.cards)) continue;
          cmp++; if (r.cards === x.yellow_cards + (x.red_cards ?? 0)) agree++;
        }
        check('teamExtra:牌數對回 football-data.co.uk 逐場牌數(獨立來源,≥ 95% 一致)', cmp === 0 || agree / cmp >= 0.95, `${agree}/${cmp}`);
        const withStyle = teams.filter(t => t.style.pressing.proxy === false);
        console.log(`  · 壓迫換成直接指標的球隊 ${withStyle.length}/20(涵蓋要到一半場次)`);
      }
    }
    check('傳球數對回 raw 快取重算(ARS 主場)', (() => {
      const rows = fm.filter(m => m.home === 'ARS' && m.teamStats?.ARS);
      if (!rows.length) return g.teams.ARS.play.home == null;
      const mean = Math.round(rows.reduce((a, m) => a + (m.teamStats.ARS.passes ?? 0), 0) / rows.length * 100) / 100;
      return g.teams.ARS.play.home.passes === mean && g.teams.ARS.play.home.games === rows.length;
    })(), `${g.teams.ARS.play.home.passes}`);
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
