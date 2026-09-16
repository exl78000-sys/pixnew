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

  /* 前端頁面清單:**頁面真的會載入的**那幾支 game- 模組要進 bundle 的 SHARED,
     不然單檔版靜靜少一頁。2026-09-16 之後 `game-engine` / `game-playback` 已經不是其中之一
     (頁面不再 import 它們,檔案留著只為了它們自己的測試)——
     所以這一條改成從 **game-view 的 import 開始走訪**,而不是「目錄裡每一個 game-*.js」:
     那樣寫的話,任何一支被退役的模組都會讓這條紅在「它不在清單裡」,而它本來就不該在。 */
  const bundle = readFileSync(join(ROOT, 'scripts', 'bundle.mjs'), 'utf8');
  const JS = join(ROOT, 'web', 'assets', 'js');
  const importsOf = f => [...readFileSync(join(JS, f), 'utf8').matchAll(/from '\.\/([a-z0-9-]+)\.js/g)].map(m => `${m[1]}.js`);
  const reach = new Set(); const todo = ['game-view.js'];
  while (todo.length) {
    const f = todo.pop();
    if (reach.has(f) || !existsSync(join(JS, f))) continue;
    reach.add(f);
    for (const n of importsOf(f)) if (n.startsWith('game-')) todo.push(n);
  }
  const need = [...reach].sort();
  check('頁面載得到的 game-*.js 都在 bundle 的 SHARED 清單',
    need.every(f => bundle.includes(`'${f.replace(/\.js$/, '')}'`)), need.join('、'));
  /* 反過來也要守:退役的模組不可以還留在清單裡(留著就是單檔版多打包幾百行沒有人用的程式) */
  const retired = readdirSync(JS).filter(f => f.startsWith('game-') && f.endsWith('.js') && !reach.has(f));
  check('退役的 game-*.js 不在 SHARED 清單裡',
    retired.every(f => !bundle.includes(`'${f.replace(/\.js$/, '')}'`)), retired.join('、') || '(沒有退役的)');
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

console.log('\n▶ 模擬遊玩:賽後判讀');
{
  const enginePath = join(ROOT, 'web', 'assets', 'js', 'game-engine.js');
  const diagPath = join(ROOT, 'web', 'assets', 'js', 'game-diag.js');
  if (!existsSync(enginePath) || !existsSync(diagPath)) console.log('  · 引擎或判讀模組還沒建,整節略過');
  else {
    const eng = await import(pathToFileURL(enginePath));
    const D = await import(pathToFileURL(diagPath));
    const profile = read(join(ROOT, 'web', 'data', 'game', 'pl.json'));
    const pred = { xgHome: 1.6, xgAway: 1.1 };
    const names = { home: 'Arsenal', away: 'Liverpool' };

    /* 一場跑到完場,然後照 game-view 的 skipToEnd 那條路組出顯示狀態 ——
       事件、回合簡記、控球秒數三樣都是畫面上會有的那一份。 */
    const playOne = seed => {
      const m = eng.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed });
      while (!m.state().finished) m.nextSequence();
      const s = m.state();
      return {
        m, s,
        input: {
          events: m.events(),
          chains: m.sequences().map(D.chainBrief),
          poss: { home: s.home.stats.possSec, away: s.away.stats.possSec },
        },
      };
    };
    const runs = [1, 2, 3, 4, 5, 6, 7, 8].map(playOne);

    /* 1. 判讀的計數要對得回引擎自己的 stats。
       「我數不出來 ≠ 上游沒有」的同一條:分母跟被比較的那一邊要是同一批。
       實際抓到過一個:第一版照 pulselive 的直覺把烏龍球翻給另一隊,兩隊的進球數就互換了,
       而畫面完全正常(負向對照在第 6 條)。 */
    {
      const bad = [];
      for (const { s, input } of runs) {
        const t = D.tally(input);
        for (const side of ['home', 'away']) {
          const st = s[side].stats;
          for (const [k, mine, theirs] of [
            ['進球', t[side].goals, st.goals], ['射門', t[side].shots, st.shots],
            ['角球', t[side].corners, st.corners], ['犯規', t[side].fouls, st.fouls],
            ['黃牌', t[side].yellow, st.yellow], ['紅牌', t[side].red, st.red],
            ['越位', t[side].offsides, st.offsides],
          ]) if (mine !== theirs) bad.push(`${side} ${k} ${mine}≠${theirs}`);
        }
      }
      check('判讀的計數對得回引擎 stats(8 場 × 兩隊 × 七項)', bad.length === 0, bad.slice(0, 4).join('、'));
    }

    /* 2. 回合的分母也要對得上:簡記的筆數 = 引擎的回合數,而且逐側加總一樣。 */
    {
      const bad = runs.filter(({ s, input }) => {
        const t = D.tally(input);
        return input.chains.length !== s.seqs || t.home.seqs + t.away.seqs !== s.seqs;
      });
      check('回合簡記的分母對得回引擎的回合數', bad.length === 0, `${bad.length}/8 場對不上`);
      /* 三個三分之一加起來要等於總丟球數 —— 只數一格的話哪天分界線改了不會有人發現。 */
      const badThird = runs.filter(({ input }) => {
        const t = D.tally(input);
        return ['home', 'away'].some(sd => t[sd].lostOwn + t[sd].lostMid + t[sd].lostAtt !== t[sd].lostTotal);
      });
      check('丟球的三個三分之一加起來等於總丟球數', badThird.length === 0, `${badThird.length}/8 場對不上`);
    }

    /* 3. 鐵則一:文章裡的每一個數字都要在同一條的 evidence 找得到。
       文字是純函式產的,所以驗一次就夠 —— 但要用真的模擬結果驗,不是手捏的。 */
    {
      const bad = [];
      for (const { s, input } of runs) {
        const t = D.tally(input);
        const diag = D.diagnose(t);
        const paras = D.recap(t, { homeName: names.home, awayName: names.away, score: s.score, diag });
        for (const x of [...diag, ...paras]) {
          const un = D.unattested(x.text, x.evidence, [names.home, names.away]);
          if (un.length) bad.push(`${un.join(',')} ← ${x.text.slice(0, 28)}`);
        }
      }
      check('判讀與敘述裡的每個數字都有出處(8 場全部)', bad.length === 0, bad.slice(0, 2).join(' | '));
    }

    /* 4. 空結果是正常結果。拿一場「什麼都沒發生」的計數驗,不驗「8 場裡至少有一場是空的」——
       後者是把資料當紅線,哪天亂數換一批就紅在跟它想守的事無關的地方。 */
    {
      const blank = D.tally({});
      const diag = D.diagnose(blank);
      const paras = D.recap(blank, { homeName: names.home, awayName: names.away, score: [0, 0], diag });
      check('沒有任何事件時判讀回空陣列、敘述照樣寫得出來(而且講出「沒有判讀」)',
        diag.length === 0 && paras.length === 3 && paras.every(p => p.text.length > 0) && paras[2].text.includes('沒有特別的戰術判讀'));
      /* 有判讀時敘述**不要**再重述一遍 —— 畫面上每一條連同依據就列在下面,重複畫兩次會長到讀不下去。 */
      const withDiag = runs.find(r => D.diagnose(D.tally(r.input)).length > 0);
      if (withDiag) {
        const t2 = D.tally(withDiag.input);
        const p2 = D.recap(t2, { homeName: names.home, awayName: names.away, score: withDiag.s.score, diag: D.diagnose(t2) });
        check('有判讀時敘述只有比分與數字兩段(判讀由清單呈現,不重述)', p2.length === 2);
      }
    }

    /* 5. 界線:判讀不可以把真實那一面的東西搬進來。
       game-diag.js 一行 import 都不該有(它是純函式);門檻只能是兩隊互比或這一場的絕對次數,
       所以原始碼裡不會出現 profile / league 這種聯賽層的東西。 */
    {
      const src = readFileSync(diagPath, 'utf8');
      const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('判讀模組沒有任何 import(純函式,不吃聯賽基準)', !/^\s*import\s/m.test(noComment));
      check('判讀模組不碰 profile / league 層的資料', !/\bprofile\b|\bleague_\b|C\.load/.test(noComment));
    }

    /* 6. 負向對照。每一條斷言都要證明它真的擋得住它想擋的那個 bug ——
       「加完是綠的」跟「這條測試守不住任何東西」長得一模一樣。 */
    {
      const { s, input } = runs[0];
      const t = D.tally(input);
      // (a) 烏龍球翻給另一隊 → 第 1 條要紅(這一場有烏龍球才驗得到,沒有就找一場有的)
      const ogRun = runs.find(r => r.input.events.some(e => e.type === 'goal' && e.ownGoal));
      if (!ogRun) console.log('  · 這八場沒有烏龍球,烏龍球歸屬的負向對照略過(下一條照跑)');
      else {
        const flipped = ogRun.input.events.map(e => (e.type === 'goal' && e.ownGoal ? { ...e, side: e.side === 'home' ? 'away' : 'home' } : e));
        const t2 = D.tally({ ...ogRun.input, events: flipped });
        const st = ogRun.s;
        check('負向對照:烏龍球歸錯隊 → 進球數就對不回引擎',
          t2.home.goals !== st.home.stats.goals || t2.away.goals !== st.away.stats.goals);
      }
      // (b) 文字裡塞一個 evidence 沒有的數字 → 第 3 條要紅
      check('負向對照:文字裡多一個沒出處的數字 → 驗證器抓得到',
        D.unattested('射門 7 次,跑動 118 公里', { 射門: 7 }, []).includes('118'));
      // (c) 隊名自己帶數字(Schalke 04)不剝掉的話會被當成沒出處
      check('負向對照:隊名裡的數字要剝掉才不會誤報',
        D.unattested('Schalke 04 射門 7 次', { 射門: 7 }, []).includes('04')
        && D.unattested('Schalke 04 射門 7 次', { 射門: 7 }, ['Schalke 04']).length === 0);
      // (c2) 誰先進球要看事件順序,不是 min:補時的 min 一律是 90,90+1 跟 90 用 min 比會平手
      {
        const evs = [
          { type: 'goal', side: 'away', min: 90, extra: null, x: 95, xg: 0.3, situation: 'RegularPlay' },
          { type: 'goal', side: 'home', min: 90, extra: 1, x: 95, xg: 0.3, situation: 'RegularPlay' },
        ];
        const tt = D.tally({ events: evs });
        const p1 = D.recap(tt, { homeName: names.home, awayName: names.away, score: [1, 1], diag: [] });
        check('先進球看事件順序(90 在 90+1 之前),不是拿 min 比',
          p1[0].text.includes(`${names.away} 在第 90 分鐘先進球`), p1[0].text.slice(0, 40));
      }
      // (d) 回合簡記少記一筆 → 第 2 條要紅
      const t3 = D.tally({ ...input, chains: input.chains.slice(0, -1) });
      check('負向對照:回合簡記少一筆 → 分母就對不上', t3.home.seqs + t3.away.seqs !== s.seqs);
    }

    /* 7. 畫面那邊:每一個「一個回合結算」的地方都要記簡記。
       少一個的話判讀的分母就跟畫面對不上,而畫面完全正常 —— 這是「接一條路徑要四個地方
       同時有它」那條坑的同一形狀。比的是**性質**(結算的同時要記),不是字面的寫法。 */
    {
      const view = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-view.js'), 'utf8').split('\n');
      /* 2026-09-16:連續引擎裡「一次進攻」是引擎自己收的控球串(`sim.chains()`),
         頁面不再逐回合記簡記 —— 所以這一條改成守**判讀吃的是引擎那一份**,
         而不是「頁面每個結算點都要記」(那件事已經不存在了)。 */
      const src = view.join('\n');
      check('賽後解讀吃的是引擎收的控球串,不是頁面自己記的',
        /tally\(\{ events: disp\.events, chains: match\.chains\(\)/.test(src) && !/disp\.chains/.test(src));
      check('賽後解讀分頁只在完場後掛出來', /disp\?\.finished \? \[\.\.\.base, \['recap'/.test(src));
      /* 分頁列要重畫。開賽時那份 innerHTML 裡把分頁寫死的話,完場才長出來的那一頁
         **內容切過去了、按鈕不在**(實測過:讀者看不出自己在哪一頁,也回不去)。
         守的是「那份一次性的樣板裡沒有分頁標籤」,不是某支函式叫什麼名字。 */
      check('分頁列不是開賽時寫死的一份 innerHTML', /id="gTabs"><\/div>/.test(src) && !/id="gTabs">\$\{/.test(src));
      /* 切到賽後解讀不可以掛在 `!disp.finished` 那個轉換上 —— `full` 事件在播放時就把它設成 true 了,
         到 finish() 那個條件永遠是 false。實測自然完場時分頁列還是四個。
         **這條擋的是同一個回歸,真正發現它的是瀏覽器**:掃原始碼看不到「什麼時候被呼叫」。 */
      const finishBody = src.slice(src.indexOf('function finish()'), src.indexOf('function skipToEnd()'));
      check('完場切到賽後解讀不是掛在 finished 的轉換上',
        /tab = 'recap'/.test(finishBody) && !/!disp\.finished/.test(finishBody));
    }
  }
}
