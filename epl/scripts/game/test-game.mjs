#!/usr/bin/env node
/* 模擬遊玩的自我檢查。守兩件事:
 *   1. **獨立管線**(使用者 2026-09-03 的決定)—— 真實管線不 import 遊戲、遊戲只寫 web/data/game/。
 *   2. **側寫的每個數字對得回來源** —— 不是「看起來合理」,是重算一次要一樣。
 * 第三節是**連續引擎**的結構不變量(不超速、不出界、事件的當事人在場上、同種子同一場);
 * 會漂的數字(射門數、跑動量)不在這裡,由 `npm run game:sim` 印。 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

    /* 動畫的節奏資料(2026-09-03):跑動節奏、三路進攻、逐人跑動與最高速度。不是每場都有追蹤資料,
       所以看的是「大多數」而不是全部;三路佔比相加要是 1。
       (逐人熱區 2026-09-25 從側寫拿掉 —— 唯一讀它的是退役的回合制播放,檢查跟著撤。) */
    const xiAll = teams.flatMap(t => t.xi.map(c => t.squad.find(p => p.code === c)));
    check('每隊都有跑動節奏(pace),每分鐘跑動距離在 800–1600 m 之間', teams.every(t => t.pace && t.pace.distancePerMin > 800 && t.pace.distancePerMin < 1600), teams.filter(t => !t.pace).map(t => t.code).join('、'));
    check('每隊都有三路進攻佔比且相加 = 1', teams.every(t => t.zones && Math.abs(t.zones.left + t.zones.center + t.zones.right - 1) < 0.02));
    /* 下限不設 3 km:替補上場幾分鐘的人場均本來就低(實測有),上限 14 km 抓的是單位錯(公尺當公里之類) */
    check('先發球員多數有場均跑動(≥ 80%),數字在 0–14 km', xiAll.filter(p => p.run).length >= xiAll.length * 0.8 && xiAll.every(p => !p.run || (p.run.distancePerGame > 0 && p.run.distancePerGame < 14000)), `${xiAll.filter(p => p.run).length}/${xiAll.length}`);
    /* **最高速度是連續引擎唯一讀的那一個**(`vmax = run.topSpeed / 3.6`,每個人跑不過自己的真實上限)。
       之前這一節只驗場均跑動、從來沒驗過引擎真正在用的那個欄位 —— 單位錯(m/s 當 km/h)的話,
       二十二個人會一起慢三倍半,而畫面只是「看起來有點慢」。20~40 km/h 抓的是那種錯,不是精確值。 */
    check('有最高速度的先發球員,數字在 20–40 km/h(引擎拿它當每個人的速度上限)',
      xiAll.filter(p => p.run?.topSpeed != null).length >= xiAll.length * 0.8 && xiAll.every(p => p.run?.topSpeed == null || (p.run.topSpeed >= 20 && p.run.topSpeed <= 40)),
      `${xiAll.filter(p => p.run?.topSpeed != null).length}/${xiAll.length}・範圍 ${Math.min(...xiAll.filter(p => p.run?.topSpeed != null).map(p => p.run.topSpeed))}~${Math.max(...xiAll.filter(p => p.run?.topSpeed != null).map(p => p.run.topSpeed))}`);
    check('側寫不再帶熱區與射門池(沒有人讀的東西不進產物)', teams.every(t => !('shots' in t) && t.squad.every(p => !('heat' in p))) && !('shotPool' in (g.league_ ?? {})));

    check('每隊有主 / 客場的傳球數與越位數(戰術分頁印的真實值)', teams.every(t => t.play && ['home', 'away'].every(v => t.play[v] && t.play[v].games > 0 && t.play[v].passes > 200 && t.play[v].passes < 900 && t.play[v].offsides >= 0 && t.play[v].offsides < 8)));
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

console.log('\n▶ 模擬遊玩:連續引擎的結構不變量');
{
  /* **2026-09-25 從退役的回合制那一套搬過來。** 舊的 `game-engine.js`(回合制引擎)與
     `duel-anim.js`(照劇本演的播放)守了四十幾條規則,其中幾條講的是**任何一台引擎都該成立**的事 ——
     不超速、不出界、事件的當事人在場上、場上人數 = 11 − 紅牌、同種子同一場。
     頁面從 2026-09-16 起跑的是 `game-sim.js`,而那幾條在它身上**一條都不是紅線**
     (`check-sim` 會印瞬移次數,但它刻意不進 npm test)。量過三場,它們現在都成立;
     這一節讓它們**一直**成立。退役那一套的其餘規則守的是它自己的機制(劇本、剪接、
     播放規劃器、步態擺幅),連續引擎沒有那些東西,不搬。
     **只守結構,不守會漂的數字** —— 射門數、跑動量那些由 `check-sim` 印。 */
  const SM = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
  const profile = read(join(ROOT, 'web', 'data', 'game', 'pl.json'));
  const PRED = { xgHome: 1.99, xgAway: 0.70 };
  const STEP = 1 / 60;
  const sim = SM.createSim({ profile, home: 'ARS', away: 'LIV', seed: 1, pred: PRED });
  /* 瞬移的容差跟 `check-sim` 的 play() 同一條(自己的最高速 × 1.5 × 一格 + 2 cm):
     那一邊印、這一邊擋,兩邊用同一個定義 —— 不然會有一場在這裡紅、在那裡印 ✓。 */
  const jumpTol = p => p.vmax * STEP * 1.5 + 0.02;
  let prev = null, prevOn = null, half = null, nEv = 0, jumps = 0, worstJump = 0, frames = 0;
  const outside = [], badCount = [], badActor = [], subLog = [];
  let subbed = null;
  /* 上限是 110 分鐘的格數(跟 check-sim 的 play() 同一個算法):一場有中場與補時,跑固定的格數會停在半場 ——
     第一版寫 200,000 格(55 分鐘),換人那一步永遠輪不到,而「跑到完場」那條紅在迴圈上限。 */
  const N = Math.round(110 * 60 / STEP);
  for (let i = 0; i < N && !sim.state().over; i++) {
    /* 換人要**真的發生一次**才驗得到(連續引擎不自動換人,使用者 2026-09-20 的決定)。
       第 60 分換一次:主隊第一個外場球員換替補席第一個人。 */
    if (!subbed && sim.state().t >= 60 * 60) {
      const st0 = sim.state();
      const off = st0.players.find(p => p.side === 'home' && p.role !== 'GK')?.code;
      const on = sim.benchOf('home')[0]?.code;
      subbed = { off, on, ok: sim.substitute('home', off, on) };
      /* 換完**當下**就看:上場的人在場上、下場的人不在(標題講的就是這兩件事 ——
         第一版只看完場時下場的人不在,把換人寫成「拿掉一個人」的錯它看不出來,只有人數那一條紅) */
      const after = new Set(sim.state().players.map(p => p.code));
      subbed.onAfter = after.has(on); subbed.offAfter = after.has(off);
      /* 同一個替補不能上場兩次;已經下場的人不在替補席,也不能再換回來 */
      const other = sim.state().players.find(p => p.side === 'home' && p.role !== 'GK' && p.code !== on)?.code;
      subbed.again = sim.substitute('home', other, on);
      subbed.back = sim.substitute('home', other, off);
    }
    sim.advance(STEP);
    frames++;
    const s = sim.state();
    const on = new Set(s.players.map(p => p.code));
    const evs = sim.events();
    for (const e of evs.slice(nEv)) {
      if (e.type === 'sub') { subLog.push(e); continue; }
      const who = e.type === 'goal' || e.type === 'block' || e.type === 'save' ? e.by : e.player;
      if (who == null) continue;
      /* 上一格或這一格在場上都算:紅牌的那一格,拿牌的人在事件之後就離場了 */
      if (!on.has(who) && !prevOn?.has(who)) badActor.push(`${e.type} ${who} @${Math.floor(s.t / 60)}'`);
    }
    nEv = evs.length;
    for (const sd of ['home', 'away']) {
      const n = s.players.filter(p => p.side === sd).length;
      if (n !== 11 - s.counts.reds[sd] && badCount.length < 3) badCount.push(`${sd} ${n} 人、紅牌 ${s.counts.reds[sd]} @${Math.floor(s.t / 60)}'`);
    }
    /* 中場換邊那一格二十二個人**依設計**被鏡射到對面 —— 不是瞬移(check-sim 那條坑) */
    if (s.half !== half) { half = s.half; prev = null; }
    for (const p of s.players) {
      if ((p.x < -2 || p.x > 107 || p.y < -2 || p.y > 70) && outside.length < 3) outside.push(`${p.code} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
      const q = prev?.get(p.code);
      if (q) {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d > jumpTol(p)) { jumps++; worstJump = Math.max(worstJump, d); }
      }
    }
    prev = new Map(s.players.map(p => [p.code, p]));
    prevOn = on;
  }
  const end = sim.state();
  check('跑到完場(不是跑到迴圈上限)', end.over, `${frames} 格`);
  check('沒有人超過自己的最高速度(逐格位移,換邊那一格除外)', jumps === 0, jumps ? `${jumps} 次,最大 ${worstJump.toFixed(2)} m` : '');
  check('球員不會跑到場外(離邊線 ≤ 2 m)', outside.length === 0, outside.join('、'));
  check('每一格的場上人數 = 11 − 紅牌(兩隊)', badCount.length === 0, badCount.join('、'));
  check('事件的當事人在事件當下都在場上(射門、進球、犯規、拿牌、越位、十二碼、封阻、撲救)', badActor.length === 0, badActor.slice(0, 3).join('、'));
  check('換人成功:事件記下來、下場的人原本在場上、上場的人換完在場上',
    !!subbed?.ok && subLog.some(e => e.off === subbed.off && e.on === subbed.on) && subbed.onAfter && !subbed.offAfter,
    subbed ? `${subbed.off} → ${subbed.on}` : '沒有換到人');
  check('同一個替補不能上場兩次、下場的人不能再換回來', subbed?.again === false && subbed?.back === false);
  /* 可重現:同種子、同設定,前 10 分鐘的事件流逐字相同(整場跑兩次太貴,事件流的前綴已經足夠抓到
     「偷用 Math.random / 牆上時鐘」那一類錯)。跨設定**不保證**可比 —— 那是 4f 那條坑,不是這裡守的事。 */
  /* 一格一格推:`advance()` 一次最多走 MAX_STEPS 格,一口氣叫 advance(600) 只會走到那個上限 */
  const firstTen = seed => {
    const m = SM.createSim({ profile, home: 'ARS', away: 'LIV', seed, pred: PRED });
    for (let i = 0; i < 10 * 60 / STEP; i++) m.advance(STEP);
    return JSON.stringify(m.events());
  };
  const a = firstTen(7), b = firstTen(7), c = firstTen(8);
  check('同種子同一場(前 10 分鐘的事件流逐字相同),換一個種子就不同', a === b && a !== c && a.length > 50);
}

console.log('\n▶ 模擬遊玩:戰術指令的級數(畫面與引擎同一套意思)');
{
  /* **2026-09-25 修的那個錯**:畫面上的五級是聯盟的五分位(側寫的 `style.*.level`,標「・本季」的是
     這一隊所在的那一級),而引擎的級數是「3 = 恆等元」。畫面又在**建立設定時就把側寫的級塞進 tactics、
     開賽就送進引擎** —— 於是每一場(使用者什麼都沒碰)都在跑一組沒校準過的偏移:ARS 的防線被壓到
     最深一級、壓迫 ×1.15,而 λ 的錨(`check-sim`)量的是**沒有偏移**的那一場。動任何一顆按鈕,
     另外兩軸也會跟著被送出去。這一節守四件事:
       ① 引擎給的「沒下指令時是哪一級」:壓迫 = 這一隊自己那一級,其餘 = 3;轉接層轉出去的是同一份
       ② 送出那一組級數 = 恆等元(倍率一個都不動,前 10 分鐘的事件流跟什麼都沒送的逐字相同)
       ③ 壓迫的五級是聯盟五分位的真實中位數:非遞減、落在聯盟真實的範圍裡、換算跟 pressBase 同一條
       ④ 畫面:設定預設是空的、亮的是引擎那一級、本季只當標記、點一顆只送那一軸 */
  const SM = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
  const LV = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-live.js')));
  const profile = read(join(ROOT, 'web', 'data', 'game', 'pl.json'));
  const PRED = { xgHome: 1.99, xgAway: 0.70 };
  const codes = Object.keys(profile.teams);
  const OTHER = ['line', 'directness', 'mentality', 'width', 'tempo'];

  /* ① */
  const badDef = codes.filter(c => {
    const d = SM.tacticDefaults(profile, c);
    return d.pressing !== profile.teams[c].style.pressing.level || OTHER.some(k => d[k] !== 3);
  });
  check('沒下指令時引擎在踢的那一級:壓迫 = 這一隊自己那一級,其餘五軸 = 3(20 隊)', badDef.length === 0 && codes.length === 20, badDef.join('、'));
  check('轉接層轉出去的就是引擎那一份(頁面不自己寫一份「哪一級是恆等元」)',
    codes.every(c => JSON.stringify(LV.engineTacticLevels(profile, c)) === JSON.stringify(SM.tacticDefaults(profile, c))));

  /* ② 恆等元:倍率與跑出來的比賽都不動 */
  const idBad = codes.filter(c => {
    const other = codes.find(x => x !== c);
    const m = SM.createSim({ profile, home: c, away: other, seed: 1, pred: PRED });
    const r = m.setTactics('home', SM.tacticDefaults(profile, c));
    return !(r.pressing === 1 && r.line === 1 && r.directness === 0 && r.mentality === 0 && r.width === 1 && r.tempo === 1);
  });
  check('把引擎的預設級原封送回去,六個倍率一個都不動(20 隊)', idBad.length === 0, idBad.join('、'));
  const tenMin = send => {
    const m = SM.createSim({ profile, home: 'ARS', away: 'LIV', seed: 5, pred: PRED });
    if (send) { m.setTactics('home', SM.tacticDefaults(profile, 'ARS')); m.setTactics('away', SM.tacticDefaults(profile, 'LIV')); }
    for (let i = 0; i < 10 * 60 * 60; i++) m.advance(1 / 60);
    return JSON.stringify(m.events());
  };
  check('送了預設級跟什麼都沒送是同一場(前 10 分鐘的事件流逐字相同)', tenMin(false) === tenMin(true));

  /* ③ 壓迫的五級:期望值自己從側寫算一次(中位數 + 跟引擎同一條換算,常數從引擎原始碼讀) */
  const simSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
  const LG = Number(simSrc.match(/const PRESS_LG = ([0-9.]+)/)?.[1]), SPAN = Number(simSrc.match(/const PRESS_SPAN = ([0-9.]+)/)?.[1]);
  const conv = v => Math.min(1.3, Math.max(0.7, 1 + (v / LG - 1) * SPAN));
  const med = a => { const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  const want = [1, 2, 3, 4, 5].map(L => conv(med(codes.filter(c => profile.teams[c].style.pressing.level === L).map(c => profile.teams[c].style.pressing.value))));
  const bases = codes.map(c => conv(profile.teams[c].style.pressing.value));
  let worst = 0, mono = true, inRange = true;
  for (const c of codes) {
    const own = profile.teams[c].style.pressing.level, base = conv(profile.teams[c].style.pressing.value);
    const got = [1, 2, 3, 4, 5].map(L => {
      const m = SM.createSim({ profile, home: c, away: codes.find(x => x !== c), seed: 1, pred: PRED });
      return m.setTactics('home', { pressing: L }).pressing * base;
    });
    got.forEach((g, i) => { const w = i + 1 === own ? base : want[i]; worst = Math.max(worst, Math.abs(g - w)); });
    if (got.some((g, i) => i && g < got[i - 1] - 1e-12)) mono = false;
    if (got.some(g => g < Math.min(...bases) - 1e-12 || g > Math.max(...bases) + 1e-12)) inRange = false;
  }
  check('壓迫的每一級 = 那一級球隊真實值的中位數(自己那一級 = 自己的真實值),換算跟 pressBase 同一條',
    Number.isFinite(LG) && Number.isFinite(SPAN) && worst < 1e-12, `最大差 ${worst.toExponential(1)}・五級 ${want.map(w => w.toFixed(3)).join(' / ')}`);
  check('壓迫的五級非遞減,而且落在聯盟真實的範圍裡(不是遊戲規則的 ±30%)', mono && inRange,
    `聯盟 ${Math.min(...bases).toFixed(3)}~${Math.max(...bases).toFixed(3)}`);

  /* ④ 畫面:用原始碼守(剝掉註解再掃 —— 這一段註解本身就在講舊的寫法) */
  const view = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-view.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  check('設定的 tactics 預設是空的(開賽送進引擎的也就是空的)', /tactics: \{\} \}\)/.test(view) && !/tactics: defaultTactics\(/.test(view));
  check('亮起來的是引擎那一級 + 使用者改過的,「・本季」只當標記',
    /const cur = \{ \.\.\.engineTactics\(state\[sd\]\), \.\.\.\(setupOf\(sd\)\.tactics \?\? \{\}\) \}/.test(view)
    && /const def = seasonTactics\(state\[sd\]\)/.test(view) && /engineTacticLevels\(profile, code\)/.test(view));
  check('點一顆按鈕只送那一軸(不再把整組側寫級一起送出去)',
    /su\.tactics = \{ \.\.\.\(su\.tactics \?\? \{\}\), \[k\]: Number\(lv\) \}/.test(view) && !/defaultTactics/.test(view));
  check('畫面不再宣稱「只改踢法,不改進球期望」(引擎不會把進球期望調回來)', !/不改進球期望/.test(view) && /不會把/.test(view));
}

console.log('\n▶ 模擬遊玩:賽後判讀');
{
  /* **判讀要拿畫面實際餵給它的那一份事件流去驗。**(2026-09-19,階段 5a)
     這一節原本跑的是**已經退役的回合制引擎**(`game-engine.js`),而頁面從 2026-09-16 起
     餵的是連續引擎的事件 —— 兩種事件的形狀不一樣,於是測試全綠而畫面印著錯的數字:
     連續引擎每一腳射門先發 `shot`、進了再發 `goal`,舊的是二選一,所以
     `isShot = shot || goal` 把每個進球算成兩次射門(實測一場 24 腳數成 29);
     `outcome` / `x` / `situation` 三個欄位連續引擎一個都沒有,所以「射正」等於進球數、
     「被封阻」「禁區內射門」「定位球射門」**永遠是 0**,靠後兩者的兩則判讀從來沒有響過。
     這是本站記過的「同一種東西有兩種合法形狀,而測試拿錯的那一種當標準」。
     場數用 4 不是 8:連續引擎一場要跑十幾秒,而這一節驗的是**純函式**,
     4 場已經足夠讓每一類事件都出現(下面第 1 條會驗它們真的都出現了)。 */
  const simPath = join(ROOT, 'web', 'assets', 'js', 'game-sim.js');
  const diagPath = join(ROOT, 'web', 'assets', 'js', 'game-diag.js');
  if (!existsSync(simPath) || !existsSync(diagPath)) console.log('  · 引擎或判讀模組還沒建,整節略過');
  else {
    const eng = await import(pathToFileURL(simPath));
    const D = await import(pathToFileURL(diagPath));
    const profile = read(join(ROOT, 'web', 'data', 'game', 'pl.json'));
    const pred = { xgHome: 1.6, xgAway: 1.1 };
    const names = { home: 'Arsenal', away: 'Liverpool' };

    /* 一場跑到完場,然後照 game-view 那條路組出判讀的輸入 ——
       事件、控球串、控球秒數三樣都是畫面上會有的那一份(`renderGame` 就是這樣叫的)。 */
    const playOne = seed => {
      const m = eng.createSim({ profile, home: 'ARS', away: 'LIV', pred, seed });
      for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !m.state().over; i++) m.advance(1 / 60);
      const s = m.state();
      return { m, s, input: { events: m.events(), chains: m.chains(), poss: s.possSec } };
    };
    const runs = [1, 2, 3, 4].map(playOne);

    /* 1. 判讀的計數要對得回引擎自己的 counts。
       「我數不出來 ≠ 上游沒有」的同一條:分母跟被比較的那一邊要是同一批。
       實際抓到過兩個,兩次畫面都完全正常:回合制引擎那一輪是把烏龍球翻給另一隊
       (兩隊的進球數互換);連續引擎這一輪是把每個進球也算成一次射門
       (一場 24 腳數成 29 腳,而畫面上那一句就寫著「射門 15 比 14」)。
       現在的負向對照守的是後者,在第 6 條 —— 前者的那個機制在連續引擎裡還不存在。 */
    {
      const bad = [], zero = [];
      for (const { s, input } of runs) {
        const t = D.tally(input);
        const c = s.counts;
        for (const side of ['home', 'away']) {
          const i = side === 'home' ? 0 : 1;
          for (const [k, mine, theirs] of [
            ['進球', t[side].goals, s.score[i]], ['射門', t[side].shots, c.shotsBy[side]],
            ['射正', t[side].on, c.onTargetBy[side]], ['被封阻', t[side].blocked, c.blockedBy[side]],
            ['門將擋掉', t[side].gkStops, c.gkStopBy[side]],
            ['角球', t[side].corners, c.corners[side]], ['犯規', t[side].fouls, c.fouls[side]],
            ['紅牌', t[side].red, c.reds[side]], ['越位', t[side].offsides, c.offsides[side]],
          ]) if (mine !== theirs) bad.push(`${side} ${k} ${mine}≠${theirs}`);
          /* 四類要剛好把射門數分完 —— 少數一類的話它會被偏出吸收成一個看不出來的數字。 */
          const ss = t[side];
          if (ss.on + ss.off + ss.blocked + ss.gkStops !== ss.shots) bad.push(`${side} 四類加起來 ${ss.on + ss.off + ss.blocked + ss.gkStops}≠射門 ${ss.shots}`);
        }
        /* **這幾類不可以全場是 0** —— 它們正是階段 5a 之前「欄位根本不存在」的那幾個,
           而 0 在畫面上看起來只是「這場沒發生」(4h:0 不是少,是那條路沒鋪)。 */
        const sum = k => t.home[k] + t.away[k];
        /* **只列每場一定有很多次的那幾類。** `blocked` 不在裡面:場上球員的封阻目前
           一場只有 0.8 次(真實約 7 次,那正是階段 5a 量出來的缺口),
           要求「每一場都大於 0」就是把一個會隨引擎變的數字當紅線 —— 而且修好它的那一天
           這條會變成永遠綠、修壞的那一天會紅在一個跟它無關的地方。封阻那一類由
           下面的**分割**與**逐事件的 gk 旗標**守,數量只印出來。 */
        for (const k of ['on', 'boxShots', 'longShots']) if (sum(k) === 0) zero.push(k);
      }
      check(`判讀的計數對得回引擎 counts(${runs.length} 場 × 兩隊 × 九項 + 四類分完射門數)`,
        bad.length === 0, bad.slice(0, 4).join('、'));
      {
        const tot = k => runs.reduce((a, r) => { const t = D.tally(r.input); return a + t.home[k] + t.away[k]; }, 0);
        check('射正 / 禁區內 / 禁區外都不是整批 0(欄位不存在時它們全是 0,而畫面完全正常)',
          zero.length === 0, zero.join('、'));
        console.log(`  · ${runs.length} 場合計:射正 ${tot('on')}、被封阻 ${tot('blocked')}、門將擋掉 ${tot('gkStops')}、禁區內 ${tot('boxShots')}、禁區外 ${tot('longShots')}、角球與十二碼射門 ${tot('setPieceShots')}`);
      }
    }

    /* 2. 回合的分母也要對得上:簡記的筆數 = 引擎的回合數,而且逐側加總一樣。 */
    {
      const bad = runs.filter(({ s, input }) => {
        const t = D.tally(input);
        /* 連續引擎沒有「回合數」這個東西 —— 分母就是引擎自己收的控球串,
           所以這一條驗的是「逐側加總 = 總串數」(舊引擎那邊是比 `state().seqs`)。 */
        return t.home.seqs + t.away.seqs !== input.chains.length;
      });
      check('控球串的分母逐側加總對得回總串數', bad.length === 0, `${bad.length}/${runs.length} 場對不上`);
      /* 三個三分之一加起來要等於總丟球數 —— 只數一格的話哪天分界線改了不會有人發現。 */
      const badThird = runs.filter(({ input }) => {
        const t = D.tally(input);
        return ['home', 'away'].some(sd => t[sd].lostOwn + t[sd].lostMid + t[sd].lostAtt !== t[sd].lostTotal);
      });
      check('丟球的三個三分之一加起來等於總丟球數', badThird.length === 0, `${badThird.length}/${runs.length} 場對不上`);
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
      check(`判讀與敘述裡的每個數字都有出處(${runs.length} 場全部)`, bad.length === 0, bad.slice(0, 2).join(' | '));
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
      /* (a) **把進球也算成一次射門** → 第 1 條要紅。這正是階段 5a 之前的寫法
         (`isShot = shot || goal`),而它在舊的回合制引擎上是對的 —— 換引擎之後沒有人回來改,
         於是畫面上那一句「射門 15 比 14」多算了每一顆進球。
         (原本這裡的負向對照是「烏龍球歸錯隊」,那是回合制引擎才有的東西 ——
         連續引擎還沒有烏龍球,留著就是在守一件不存在的事。) */
      {
        /* **不可以靠「這個種子剛好有進球」。** 第一版拿 `runs[0]` 的真事件流當母體,
           而它要有進球才驗得到 —— 2026-09-20 接體能那一輪,新的常數加上當天重算的側寫
           讓種子 1 變成 0-0,這條就紅在「驗不到」上,而它要守的事一件都沒變。
           那是「把目標達成寫成 CI 紅線」的近親:**斷言的前提綁在一個會漂的結果上**。
           改成**合成**的輸入:在真的事件流後面各加一顆進球與一腳射門 ——
           射門數只准 +1;`tally` 如果把進球也算成射門就會 +2。一場都不用跑,而且不會漂。 */
        const synth = { ...input, events: [...input.events,
          { type: 'goal', side: 'home', min: 10 }, { type: 'shot', side: 'home', min: 11 }] };
        const ts = D.tally(synth);
        check('負向對照:進球也算一次射門 → 射門數就多一顆(合成輸入,不靠種子有沒有進球)',
          ts.home.shots === t.home.shots + 1 && ts.home.goals === t.home.goals + 1,
          `射門 ${t.home.shots} → ${ts.home.shots}、進球 ${t.home.goals} → ${ts.home.goals}`);
        /* 真事件流上的那一條保留,但只在**這一場真的有進球**時才判 ——
           有就是白拿的一條,沒有就印一行,不當紅線(「無法核對 ≠ 不一致」)。 */
        const dbl = { home: 0, away: 0 };
        for (const e of input.events) if (e.type === 'goal') dbl[e.side]++;
        const scored = ['home', 'away'].some(sd => dbl[sd] > 0);
        check('(有進球時才判)真事件流上把進球也算成射門一樣對不回 counts',
          !scored || ['home', 'away'].some(sd => t[sd].shots + dbl[sd] !== s.counts.shotsBy[sd]),
          scored ? `這一場 ${dbl.home}-${dbl.away}` : '這一場兩隊都沒進球 —— 只印不判');
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
      check('負向對照:控球串少一筆 → 分母就對不上', t3.home.seqs + t3.away.seqs !== input.chains.length);
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

    /* 8. 領土的三個錨(階段 4s)。它們在這之前**沒有任何消費端** —— 側寫寫進去、沒有人讀,
       而本站的球住在對方半場的時間多了一半(完成傳球 71.5% 對真實 55.7%)。
       兩條守的是不同的東西:計數器還在(掉了的話畫面與報告都不會報錯),
       以及**錨用的是這兩隊自己的值** —— 我第一版拿聯盟平均當錨,而 ARS 與 LIV 都是控球型的隊,
       那樣會把差距誇大一截(更早一版更糟:把單一隊的 extra 當成了聯盟平均)。 */
    {
      const sim = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      check('引擎把領土的三個計數器吐給 counts',
        /boxTouch: \{ \.\.\.st\.boxTouch \}/.test(sim)
        && /okOwnHalf: \{ \.\.\.st\.okOwnHalf \}/.test(sim)
        && /okOppHalf: \{ \.\.\.st\.okOppHalf \}/.test(sim));
      const chk = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8');
      const block = chk.slice(chk.indexOf('3b-5.'), chk.indexOf('3b-6.'));
      /* 這一條原本釘著 `ex(HOME, k)` 這個**寫法**,而 4w 把三份同義的輔助併成一份之後
         它就紅在「重構但行為不變」上。改成守性質:領土的錨走那一份共用的 `pair()`,
         而 `pair()` 本身讀的是 HOME 與 AWAY 自己的 extra。
         順帶守住併完的狀態:**只能有一份** —— 兩份同義的東西改了一邊另一邊會悄悄過期。 */
      check('領土的錨取這兩隊自己的值,不是聯盟平均',
        /pair\('touches_opp_box'\)/.test(block) && /pair\('own_half_passes'\)/.test(block)
        && /\[HOME\]\?\.extra/.test(chk) && /\[AWAY\]\?\.extra/.test(chk));
      check('取這兩隊 extra 的輔助只有一份(同一個量不要兩個來源)',
        (chk.match(/const pair = /g) ?? []).length === 1);
    }

    /* 9. 長傳與界外球的錨(階段 4t)。跟第 8 節同一個病:側寫裡有、沒有人讀。
       `long_balls_accurate` 在 4t 之前 **0 個消費端**,而它量出來是 ×2.9 ——
       那正是四輪都在找的「球是怎麼到對方半場的」那一層(結論:它不是原因,見變更紀錄)。
       `player_throws` 更直接:引擎那個常數的註解寫著「真實約 40 次」,**憑印象的數字**,
       而 raw 裡一直有這個欄位(真實 36.1,而本站已經漂到 21.5)。

       三條守的是三件不同的事:計數器還在、錨的欄位還在側寫裡、**兩個門檻都要印**。
       最後一條是因為上游沒把「長傳」的定義存進 raw ——
       只印一個門檻的話,讀者會以為那是上游的定義,而那是本站選的。 */
    {
      const sim = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      check('引擎把長傳的計數器吐給 counts(兩個門檻)',
        /longTry: st\.longTry, longOk: st\.longOk/.test(sim)
        && /longTry25: st\.longTry25, longOk25: st\.longOk25/.test(sim));
      const prof = readFileSync(join(ROOT, 'scripts', 'game', 'lib', 'profile.mjs'), 'utf8');
      check('側寫收 long_balls_accurate 與 player_throws 兩個錨',
        /'long_balls_accurate'/.test(prof) && /'player_throws'/.test(prof));
      const chk = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8');
      const block = chk.slice(chk.indexOf('3b-6.'), chk.indexOf('3c.'));
      check('長傳那一節印兩個門檻,而且錨是 long_balls_accurate',
        /long_balls_accurate/.test(block) && /longOk25/.test(block) && /longOk\b/.test(block));
      check('界外球對回 player_throws', /player_throws/.test(block));
      /* 活球時間**沒有**上游的錨(dump 過 raw:teamStats / teamExtra 都沒有這個欄位)。
         「英超一場活球約 55 分」是我自己的常識,不是這個倉庫量得出來的東西 ——
         寫進畫面或文件就是編數字(鐵則一,而它沒有「只在畫面上」這種例外)。
         這一條守的是:那一節不准出現一個活球分鐘數的真值。 */
      check('活球時間只印不判,沒有憑印象的真值',
        !/活球.{0,12}真實/.test(block) && /沒有「活球時間」的上游錨/.test(block));
    }

    /* 10. 駐留(階段 4u)。這一節**沒有上游的錨**(34 個 teamExtra + 13 個 teamStats 鍵
       全部 dump 過,沒有進攻段落 / 球門球 / 活球時間),所以兩條守的是**它不准假裝有**:
       不出現「真實 N」那種字樣,而且時間佔比與傳球佔比兩個都印(它們不相等,
       差值本身是「每秒傳球次數前後場不同」這件事的證據 —— 第一版我寫成「兩個要一致」)。

       第三條守的是量測**不消耗 rng**:駐留全部從 state() 讀。會消耗亂數的量測工具
       會讓同一個種子跑出不同的比賽(4t 那條坑),那種東西量到的差值一個字都不能信。 */
    {
      const chkRaw = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8');
      /* **掃之前剝註解** —— 講這條規則的註解自己就寫著「兩個要一致」(那是它要擋的字串)。
         不剝的話這條永遠紅,而紅的原因跟它想守的事一點關係都沒有。同一個坑本站記過一次,
         而我在寫這一條的同一輪又犯了。 */
      const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const chk = strip(chkRaw);
      /* 段落的頭尾都要用**剝註解之後還在**的字串(那一節的輸出字面值)。
         第一版拿下一節的註解標題當結尾,而它正好被剝掉了 → 段落一路吃到檔尾,
         把別節的「真實 ${…}」也算進來,於是這條紅在一件它管不到的事上。 */
      const b0 = chk.indexOf('一段進攻 = 球進到'), b1 = chk.indexOf('怎麼結束:');
      const block = chk.slice(b0, b1 + 300);
      check('駐留那一節只印不判,不假裝有上游的錨',
        /只印不判/.test(block) && !/真實 \$\{/.test(block));
      check('時間佔比與傳球佔比兩個都印,而且沒有宣稱它們相等',
        /球在對方半場的時間/.test(block) && /完成傳球的佔比/.test(block)
        && !/兩個要一致/.test(block));
      /* 駐留的追蹤**不消耗 rng**:它只讀 `s`(state() 回來的那個物件)。
         迴圈本身當然要 `sim.advance` / `sim.state` —— 那是呼叫端,不是追蹤器。
         所以掃的是**我插進去的那一段**,不是整個 play()(第一版掃整個,而它必然含
         advance,於是那條在守一件做不到的事)。 */
      const track = chkRaw.slice(chkRaw.indexOf('const now = snap(s.counts);'), chkRaw.indexOf('pc = now;'));
      check('駐留的追蹤那一段只讀 state 的物件,沒有回頭呼叫引擎',
        track.length > 200 && !/\bsim\s*\./.test(track));
    }

    /* 11. 階段 4v 的兩件事,兩條都守**性質**不守數字(五個常數的值會隨側寫重算而漂,
       拿它們當紅線就是「把會隨資料變動的數字當 CI 紅線」)。

       (一) **稀有事件要有期望值。** 十二碼一場 0.23 球,30 場只出現一兩球 ——
       次數的 Poisson 雜訊蓋過要量的東西(4b 記過)。4v 就是靠期望值才抓到
       `forward` 改了之後十二碼塌到 0.03:`BOX_CARE` 是第五個「綁在灌水底數上」的
       下游常數,而我第一輪的四個裡漏了它。

       (二) **對抗那四個錨是聯盟平均 ×2,不是這一場兩隊自己的值。** 實測差
       抄截 −12% / 過人 +7% / 犯規 −5%。兩個都要印出來,不然下一個人(或我)
       會再照著聯盟那一組校準一次 ——「錨用了聯盟平均,而這一場踢的是兩支特定的球隊」第八次。 */
    {
      const sim = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      check('引擎把十二碼的期望值吐給 counts', /penExp: st\.penExp/.test(sim));
      const chkRaw = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8');
      const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const chk = strip(chkRaw);
      check('十二碼的期望值跟次數並排印(稀有事件不看次數)',
        /每場十二碼/.test(chk) && /十二碼的期望值/.test(chk) && /penExp/.test(chk));
      /* 段落的頭尾用剝註解之後還在的輸出字面值(第 10 節那條坑) */
      const d0 = chk.indexOf('一場的對抗次數'), d1 = chk.indexOf('三種結局相加');
      const duel = chk.slice(d0, d1 > d0 ? d1 : d0 + 900);
      /* 這一條原本還釘著 `ex2(` 這個輔助函式的名字 —— 那是**釘寫法**,而 4w 把三份同義的
         輔助併成一份之後它就紅在「重構但行為不變」上(本站記過的那條坑)。改成守性質:
         兩組錨都出現在那一節裡。 */
      check('對抗那一節兩個錨都印:聯盟平均與這一場兩隊自己的值',
        /這一場/.test(duel) && /聯盟平均/.test(duel) && /A\.league/.test(duel));
    }

    /* 12. 階段 4w:對抗的四個錨改追**這一場兩隊自己的值**。
       守的是性質不是數字(那四個值會隨側寫重算而漂):
       (一) 引擎吐得出兩組,而且 `fixture` 真的是這兩隊自己的值(這裡獨立再算一次來對);
       (二) 三種結局各由**對應那一隊**自己的相對值帶:抄截看防守方、過人成功看持球方、
            犯規看防守方(`foulRel` 從 4r 就是這樣);
       (三) 控球的比值不准再出現在對抗的權重裡 —— 它是過人成功的 proxy,而真正的欄位
            (`dribbles_succeeded`)就在同一個物件上(4r 拿 `style.pressing` 當犯規 proxy 的同一個錯)。 */
    {
      const simPath = join(ROOT, 'web', 'assets', 'js', 'game-sim.js');
      const S = await import(pathToFileURL(simPath));
      const sim = S.createSim({ profile, home: 'ARS', away: 'LIV', seed: 1 });
      const A = sim.duelAnchors?.() ?? null;
      check('duelAnchors 兩組都吐:league(比例的基礎)與 fixture(這一場的判準)',
        !!A && !!A.league && !!A.fixture && A.league.duels > 0 && A.fixture.duels > 0);
      if (A?.fixture) {
        /* 獨立再算一次 —— 引擎自己算的跟這裡算的要一樣,不然「這一場的錨」只是一個名字。
           犯規要用**各自主客身分**的值,因為引擎的 `foulRel` 就是那樣取的。 */
        const ex = (c, k) => profile.teams?.[c]?.extra?.[k]?.mean;
        const wantTk = ex('ARS', 'matchstats.headers.tackles') + ex('LIV', 'matchstats.headers.tackles');
        const wantDr = ex('ARS', 'dribbles_succeeded') + ex('LIV', 'dribbles_succeeded');
        const wantFl = profile.teams.ARS.rates.home.fouls + profile.teams.LIV.rates.away.fouls;
        const near = (a, b) => Math.abs(a - b) < 1e-9;
        check('fixture 的三個數字就是這兩隊自己的(獨立算一次對得上)',
          near(A.fixture.tackles, wantTk) && near(A.fixture.dribbles, wantDr) && near(A.fixture.fouls, wantFl),
          `抄截 ${A.fixture.tackles.toFixed(2)} / 過人 ${A.fixture.dribbles.toFixed(2)} / 犯規 ${A.fixture.fouls.toFixed(2)}`);
        /* 兩組**要不一樣** —— 一樣的話這一輪等於沒做,而那正是 4v 之前的狀態。
           不釘差多少(那會隨側寫漂),只釘「不是同一個數字」。 */
        check('這一場的錨跟聯盟平均 ×2 不是同一組數字',
          A.fixture.tackles !== A.league.tackles && A.fixture.dribbles !== A.league.dribbles);
      }
      const src = readFileSync(simPath, 'utf8');
      const strip2 = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const bare = strip2(src);
      const d0 = bare.indexOf('function startDuel'), d1 = bare.indexOf('function resolveDuel');
      const duelSrc = bare.slice(d0, d1);
      check('對抗的權重由各隊自己的相對值帶(抄截看防守方、過人看持球方)',
        /DW\.tackle \* s\.tklRel/.test(duelSrc) && /DW\.beat \* sideOf\(on\.side\)\.drbRel/.test(duelSrc)
        && /DW\.foul \* s\.foulRel/.test(duelSrc));
      check('控球的比值不再出現在對抗的權重裡(它是過人成功的 proxy)',
        d0 > 0 && d1 > d0 && !/keep/.test(duelSrc));
    }

    /* 13. 階段 4x:**每次犯規吃黃牌的機率改成逐隊**。這是 4w 那條坑的鏡像 ——
       4w 是「錨用了聯盟平均而引擎是對的」,這次是 **`check-sim` 的錨早就是這一場的值
       (ARS 0.95 + LIV 1.95 = 2.90),而引擎用聯盟的 0.172**。兩隊差一倍
       (ARS 主 0.094 / LIV 客 0.184),拿聯盟值套上去黃牌就是 3.87 對 2.90。
       守的是**性質**:兩個抽牌點都要用犯規者那一隊的值,而那個值算得出這兩隊不同的數字。 */
    {
      const simSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const bare = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* 正則第一版寫 `[^)]*`,而它跨不過 `sideOf(by.side)` 裡的那個右括號 → 找到 0 處。
         那是**斷言自己的誤報**,不是程式少做 —— 先確認失敗的是哪一邊再改。 */
      const draws = bare.match(/rng\(\) <[^;{]*\.ypf\b/g) ?? [];
      check('兩個抽牌點都用犯規者那一隊的吃牌率', draws.length === 2,
        `找到 ${draws.length} 處`);
      /* 這一條第一版寫 `!/rng\(\) < YELLOW_PER_FOUL/` —— 而 4x 把那個名字改成 `YELLOW_LG` 了,
         所以**負向對照下它照樣是綠的**(把聯盟值貼回去也不含舊名字)。守不住回歸的斷言
         跟沒有這條一樣。改成:抽牌點一個都不准直接用聯盟那個常數。 */
      check('聯盟那個值只剩退路,不再直接拿去抽牌',
        !/rng\(\) <[^;{]*\bYELLOW_(LG|PER_FOUL)\b/.test(bare)
        && /YELLOW_LG/.test(bare) && /yellowPerFoulOf/.test(bare));
      /* 這兩隊的值**真的不一樣**,否則這一條在守一件不存在的事(4v 的 keySuffix 那條教訓:
         只驗「帶了不撞」而不驗「不帶真的會撞」,等於沒驗)。 */
      const ypf = (c, side) => {
        const r = profile.teams?.[c]?.rates?.[side];
        return (r?.yellow == null || !r?.fouls) ? null : r.yellow / r.fouls;
      };
      const a = ypf('ARS', 'home'), b = ypf('LIV', 'away');
      const lg = profile.league_?.rates?.yellowPerFoul;
      check('這兩隊的吃牌率彼此不同,也跟聯盟不同(不然這一條沒有守到東西)',
        a != null && b != null && lg != null && Math.abs(a - b) > 0.02
        && Math.abs((a + b) / 2 - lg) > 0.01,
        `ARS ${a?.toFixed(3)} / LIV ${b?.toFixed(3)} / 聯盟 ${lg?.toFixed(3)}`);
    }

    /* 14. 階段 4l:**角球射門有兩種,而本站只有一種**。真實的 1,835 顆 FromCorner
       逐顆有 `foot` 欄位:頭球 46%(平均 8.4 m)、腳下 54%(平均 16.3 m)。
       本站的頭球那條路是對的,缺的是腳下 —— 而規劃寫的「沒有第二波」是錯的:
       進攻方一場贏到 5.1 次第二球,只是拿到之後不射。
       守四件事:第二球的旗標要在 openChain 之前算(它會把 pendingOrigin 清掉)、
       出手不另外寫一份射門程式、真實的拆解要從 raw 算、量測用的計數器要吐出來。 */
    {
      const simSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const bare = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* 結尾的錨要寫 `function kick(from` —— 只寫 `function kick` 的話會命中**更前面**的
         `function kickoff`,切出來的是空字串,而兩條斷言就紅在「切錯了」上。
         這是本站「批次改名用名字 + 左括號當錨」那條坑的近親:**識別字是別人的前綴**。 */
      const g0 = bare.indexOf('function giveTo'), g1 = bare.indexOf('function kick(from');
      const giveSrc = g0 >= 0 && g1 > g0 ? bare.slice(g0, g1) : '';
      /* `openChain` 消費掉 pendingOrigin,所以「這是不是第二球」一定要在它之前算完。
         寫在後面的話旗標永遠是 false,而**一個錯都不會報**(本站記過的那一類)。 */
      check('第二球的判斷在 openChain 之前(它會把 pendingOrigin 領走)',
        giveSrc.indexOf('pendingOrigin') > 0
        && giveSrc.indexOf('pendingOrigin') < giveSrc.indexOf('openChain('));
      /* 出手要走 decide() 原本那一條 —— 換的只有扣扳機的機率。另外寫一份的話
         xG、情境分類、事件與統計就有兩個來源,而那是本站踩過的坑。 */
      const snapUse = bare.match(/CORNER_SNAP/g) ?? [];
      check('第二球只換扣扳機的機率,不另外寫一份射門程式',
        /rng\(\) < \(snap \? CORNER_SNAP : cl\(urge/.test(bare) && snapUse.length === 2,
        `CORNER_SNAP 出現 ${snapUse.length} 次(宣告 + 用一次)`);
      /* 旗標每次接球都要覆寫:拿到球還沒決定就被抄走的話,它會留到下一次完全不同的情況。 */
      check('接球時一律覆寫第二球的旗標(不是只在第二球時設 true)',
        /p\.snap = false;/.test(giveSrc) && /p\.snap = true;/.test(giveSrc));
      const counts = ['cornerSrc', 'cornerFirst', 'cornerShot', 'cornerNext', 'clearWhy'];
      check('角球的來源分類計數器都吐給 counts',
        counts.every(k => new RegExp(k + ': \\{ \\.\\.\\.st\\.' + k + ' \\}').test(bare)));

      const chkSrc = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8');
      const chkBare = chkSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* 真實的頭球 / 腳下拆解要**從 raw 算**,不是抄一個數字進來(鐵則一沒有「只在註解裡」這種例外)。
         **而且只能有一個來源**:2026-09-19 實測到 check-sim 自己攤 raw 算出 1,838、
         側寫寫著 1,835(側寫停在前一次 build),同一頁上兩個數字。所以印在畫面上的那一行
         改讀側寫的 `byFoot`,raw 那一份只留給沒有進側寫的量。 */
      check('真實的頭球 / 腳下拆解從 raw 的 foot 欄位算(進側寫)',
        /sh\.foot === 'Header'/.test(chkBare));
      check('角球的頭球 / 腳下那一行只讀側寫,不另外攤一次 raw',
        /byFoot/.test(chkBare) && !/rc\.head/.test(chkBare));
      /* `realShots` 是模組層的 const —— 用在宣告之前就是暫時死區,而 `node --check` 看不出來。
         4l 把角球那一節的真實拆解印在它前面,當場踩到。
         **錨不要挑某一個用它的地方**:4l-4 把那一行改讀側寫之後,原本釘的
         `realShots?.bySit?.FromCorner` 就不在了,測試紅在「錨不見了」而不是紅在它要守的事。
         守的性質寫成「檔案裡第一次出現 realShots 就是那個宣告」。 */
      const rsDecl = chkBare.indexOf('const realShots');
      check('realShots 宣告在它第一個用的地方之前(模組層 const 沒有提升)',
        rsDecl > 0 && chkBare.indexOf('realShots') === rsDecl + 'const '.length);
      /* 解圍那個錨是這一場兩隊自己的值(4w 的規矩),而且只回報不判。
         **這一條原本還釘著註解裡的「定義可能不同」那五個字** —— 而 4l-3 把那個問題
         量出答案了(59% 是解圍、41% 是長傳),句子跟著改,測試就紅在「錨不見了」。
         釘字面的句子守不住任何性質:改成守**錨的來源**,而「有沒有分開比」由第 17 節守。 */
      check('解圍的錨走共用的 pair()(這一場兩隊,不是聯盟平均)',
        /pair\('clearances'\)/.test(chkBare));
    }

    /* 15. 階段 4l-2:**同一個 situation 裡還有兩種形狀**。上游逐顆射門帶 `foot`,
       拆開來 FromCorner 是頭球(xG 0.124、平均 8.4 m)與腳下(0.086、16.3 m)兩件事,
       而引擎的 `headerAt` 本來拿混合的 0.103 當頭球的 xG。
       另外兩條守的是這一輪修掉的**基礎錯配**:射正要比率不比次數(`stf` 與 `sf` 是賽季平均,
       而引擎的射門數校準的是 `expShots`)。 */
    {
      const simSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const bare = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const fc = profile.league_?.shotSituations?.FromCorner;
      check('側寫把角球射門拆成頭球與腳下(逐顆的 foot 欄位)',
        fc?.byFoot?.header?.shots > 0 && fc?.byFoot?.foot?.shots > 0
        && fc.byFoot.header.shots + fc.byFoot.foot.shots === fc.shots,
        `頭球 ${fc?.byFoot?.header?.shots} + 腳下 ${fc?.byFoot?.foot?.shots} = ${fc?.shots}`);
      /* 兩種**真的不一樣**,否則這一條在守一件不存在的事(4v 的教訓)。 */
      check('兩種的 xG 與離門真的不同(不然拆開沒有意義)',
        Math.abs(fc.byFoot.header.xgPerShot - fc.byFoot.foot.xgPerShot) > 0.02
        && Math.abs(fc.byFoot.header.distMean - fc.byFoot.foot.distMean) > 3,
        `xG ${fc.byFoot.header.xgPerShot} vs ${fc.byFoot.foot.xgPerShot}`
        + `・離門 ${fc.byFoot.header.distMean} vs ${fc.byFoot.foot.distMean}`);
      check('頭球的 xG 用頭球那一種的真值,不是混合的',
        /CORNER_HEAD_XG = [^;]*byFoot\?\.header\?\.xgPerShot/.test(bare)
        && /const xg = cl\(CORNER_HEAD_XG,/.test(bare));
      /* 站位的**性質**:瞄得到的那幾個裡要有一個在 5 公尺內(真實的角球頭球 19% 在 5 m 內),
         而二點球那一個要在瞄得到的範圍外(`BOX_D + 2`)。比性質不比字面的數字。 */
      {
        const m = bare.match(/const spots = \[([\s\S]*?)\];/);
        const xs = [...(m?.[1] ?? '').matchAll(/dir \* ([0-9.]+)/g)].map(a => Number(a[1]));
        const aimable = xs.filter(x => x < 18.5);
        check('角球站位有一個在小禁區(瞄得到的最近一個 < 5 m),二點球那個在瞄不到的範圍外',
          xs.length >= 5 && Math.min(...aimable) < 5 && xs.some(x => x > 18.5),
          `瞄得到 ${aimable.join(' / ')}・全部 ${xs.join(' / ')}`);
      }
      const chkBare2 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('射正判的是率,不是拿兩個不同基礎的次數相減',
        /line\('射正率'/.test(chkBare2) && !/line\('每場射正'/.test(chkBare2));
      check('角球射門逐種的離門分佈印出來,而真值從側寫讀(不另外攤一次 raw)',
        /cornerShotBins/.test(chkBare2) && /byFoot/.test(chkBare2));
    }

    /* 16. 階段 4l-4:**角球的第一點是一次爭頂,不是「離球最近的人拿到」**。
       4l-2 的兩個否定都停在那條規則上:傳中一準,第一點就必然是進攻方的。
       守四件事:兩邊各派一個人(不是全場最近的一個)、贏家由機率決定、
       空中能力走側寫的 `aerials_won`(先前零消費端)而且夾子從側寫算、
       以及**距離不進權重**(掃 0.6 / 1.2 / 2.5 完全不動,兩邊離球差平均 0.042 m)。 */
    {
      const simSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const bare = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const c0 = bare.indexOf("st.lastKick === 'corner' && ball.passer");
      const c1 = bare.indexOf('function headerAt');
      const duelSrc = c0 >= 0 && c1 > c0 ? bare.slice(c0, c1) : '';
      check('傳中的第一點是兩邊各派最近的一個人(不是全場最近的一個)',
        duelSrc.length > 0 && /p\.side === att/.test(duelSrc)
        && /na && nd/.test(duelSrc) && !/let who = null, wd = 2\.5/.test(duelSrc),
        `切出來 ${duelSrc.length} 字元`);
      check('兩個人都在範圍裡時,贏家由機率決定',
        /const pAtt = wA \/ \(wA \+ wD\)/.test(duelSrc) && /rng\(\) < pAtt \? na : nd/.test(duelSrc));
      /* **距離不進權重**:掃出來完全不動(0.215 / 0.215 / 0.215),而原因是機制決定的 ——
         這一段每一格重試到有人進到 2.5 公尺內,所以兩邊都剛好在門檻上。
         守的是性質:算權重那兩行不准讀 `da` / `dd`。 */
      const wLines = (duelSrc.match(/const w[AD] = [^;]*;/g) ?? []).join(' ');
      check('爭頂的權重只看兩隊的空中能力與防守方的結構優勢,不看距離',
        wLines.includes('aerRel') && wLines.includes('AERIAL_DEF_EDGE')
        && !/\bda\b|\bdd\b/.test(wLines),
        wLines.replace(/\s+/g, ' ').slice(0, 120));
      /* 空中能力接的是側寫的欄位,而夾子跟 tklRel / drbRel 走同一支 `lim()`
         —— 照抄一個寫死的範圍是 4w 記過的坑。 */
      check('空中能力走 extra.aerials_won,夾子從側寫算(不是寫死的範圍)',
        /TEAM_AER = 'aerials_won'/.test(bare) && /aer: lim\(TEAM_AER\)/.test(bare)
        && /DW\.lim\.aer\[0\], DW\.lim\.aer\[1\]/.test(bare));
      /* 這個欄位**真的在側寫裡**,而且兩隊不一樣 —— 不然這條在守一件不存在的事。 */
      const aer = c => profile.teams?.[c]?.extra?.aerials_won?.mean;
      check('側寫真的有 aerials_won,而且這兩隊的值不同',
        aer('ARS') > 0 && aer('LIV') > 0 && aer('ARS') !== aer('LIV'),
        `ARS ${aer('ARS')} / LIV ${aer('LIV')}`);
      /* **掃之前先剝註解** —— 第一版直接掃原始碼,而我自己寫的那段註解裡就有「第一點的爭頂」
         這幾個字,所以負向對照(把那一行的標籤改掉)照樣是綠的。本站記過的同一條坑,
         而這次是反過來:註解讓一條守不住的斷言看起來有守到。 */
      const chkBare3 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('爭頂的計數器吐給 counts,check-sim 印出來',
        /air: \{ touch: st\.air\.touch/.test(bare) && /第一點的爭頂/.test(chkBare3));
    }

    /* 17. 階段 4l-3:**「本站的 clear」不是一種事件,是兩種**。逐次量過大腳那一腳的來源:
       59% 是搶到鬆球之後解掉(上游的 `clearances`),41% 是接了隊友的傳球、控住 0.9 秒、
       再大腳 —— 上游會把那一記記成長傳。所以拿總數比 `clearances` 是
       「拿自己計數器的名字去比上游的同名欄位」,那個 ×3.06 有一大半是名字對錯了。
       守三件事:引擎標了來源、`check-sim` **分開比**(反應式的那一份才對 `clearances`)、
       以及**兩種都真的存在**(只有一種的話這個拆解在守一件不存在的事)。 */
    {
      const simSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const bare4 = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('接到球時標了「球是怎麼來的」,大腳時逐來源記一次',
        /p\.gotFrom = from \? \(from\.side === p\.side \? 'teamPass' : 'steal'\) : 'loose'/.test(bare4)
        && /st\.hoofFrom\[p\.gotFrom/.test(bare4) && /hoofFrom: \{ \.\.\.st\.hoofFrom \}/.test(bare4));
      /* **拿去比 `clearances` 的不可以是總數。** 切出那一段再看它讀的是誰 ——
         掃整份的話「clears」在別處出現照樣綠(負向對照驗過)。 */
      const chkBare4 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const i0 = chkBare4.indexOf("const realClr");
      const i1 = chkBare4.indexOf("show('  　解圍的三條路'");
      const seg = i0 >= 0 && i1 > i0 ? chkBare4.slice(i0, i1) : '';
      check('解圍的倍率用反應式那一份算,不是總 clear',
        seg.length > 0 && /react \/ realClr/.test(seg) && !/\bclr \/ realClr\b/.test(seg),
        `切出來 ${seg.length} 字元`);
      const chkRaw4 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8');
      check('接隊友傳球再大腳那一份另外印,而且講明它是長傳不是解圍',
        /asPass/.test(seg) && /會記成一記長傳/.test(chkRaw4));
      /* **兩種都要真的出現** —— 跑一場真的模擬來數,不是掃原始碼。
         只有一種的話,上面那兩條就是在守一個不會發生的分支。 */
      {
        const S2 = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        const sim2 = S2.createSim({ profile, home: 'ARS', away: 'LIV', seed: 7 });
        for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !sim2.state().over; i++) sim2.advance(1 / 60);
        const hf = sim2.state().counts.hoofFrom ?? {};
        check('一場真模擬裡兩種來源都出現(拆解不是在守一件不存在的事)',
          (hf.loose ?? 0) > 0 && (hf.teamPass ?? 0) > 0,
          Object.entries(hf).map(([k, v]) => `${k} ${v}`).join('、') || '(一種都沒有)');
      }
    }

    /* 18. 階段 4l-5:**第二球落在哪裡**。角球的腳下射門 73% 走 snap 那一條,所以
       「進攻方在哪裡控到第二球」這張直方圖**就是**那一種射門的離門分佈。
       `cornerNextD` 是階段 4l 加的,加完之後**四個階段零個消費端** ——
       而 4l-5 的規劃還寫著「本站沒有這個計數器」,下一個人會再造一個。
       守三件事:兩邊都記(只記進攻方的話看不到球是被誰截走的)、
       離門距離對**開角球那一隊要攻的球門**算(兩排才在同一根軸上)、
       以及 `check-sim` 真的把它印出來。 */
    {
      const simSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const bare5 = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* **切出那一段再看**:掃整份的話別處出現 `cornerNextBins` 照樣綠。
         負向對照是把舊寫法貼回去(`if (k === 'att')` + `sideOf(side)`)。 */
      const i0 = bare5.indexOf("st.cornerNext[k] =");
      const i1 = bare5.indexOf("const origin = pend && pend.side === side");
      const seg5 = i0 >= 0 && i1 > i0 ? bare5.slice(i0, i1) : '';
      check('第二球的位置兩邊都記,而且對開角球那一隊的球門算',
        seg5.length > 0 && /st\.cornerNextBins\[k\]/.test(seg5)
        && /sideOf\(pend\.side\)/.test(seg5) && !/if \(k === 'att'\)/.test(seg5),
        `切出來 ${seg5.length} 字元`);
      const chkBare5 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('check-sim 把它印出來(這個計數器先前零個消費端)',
        /cornerNextBins/.test(chkBare5) && /第二球落在哪裡/.test(chkBare5));
      /* **兩排都要真的有東西** —— 跑一場真模擬來數。只記到一邊的話上面兩條
         就是在守一件不會發生的事(4l-3 那一節的同一條規矩)。 */
      /* **最多三場加總、兩排都有就停**(2026-09-25 改)。它要守的是「兩排計數器都有在寫」,
         不是「某一場兩邊都搶到第二球」—— 階段 5n 之後種子 11 那一場防守方剛好 0 次
         (一場平均兩三次,一場是 0 的機率約 6%),單場版本就紅在抽樣上(「斷言是抓樣意外」那條坑)。 */
      {
        const S3 = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        let att3 = 0, def3 = 0, played3 = 0;
        for (const sd of [11, 12, 13]) {
          const sim3 = S3.createSim({ profile, home: 'ARS', away: 'LIV', seed: sd });
          for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !sim3.state().over; i++) sim3.advance(1 / 60);
          const nb = sim3.state().counts.cornerNextBins ?? {};
          const tot = k => (nb[k] ?? []).reduce((a, b) => a + b, 0);
          att3 += tot('att'); def3 += tot('def'); played3++;
          if (att3 > 0 && def3 > 0) break;
        }
        check('真模擬裡進攻與防守兩排都有第二球(最多三場加總)',
          att3 > 0 && def3 > 0, `${played3} 場:進攻 ${att3} / 防守 ${def3}`);
      }
    }

    /* 19. 階段 5a:**射門的三種下場**,以及「禁區內」是矩形不是圓。
       兩件事都是**量錯了**而不是引擎錯了:
       ① `st.shotInBox` 第一版寫 `dGoal < 18`(圓),而錨是 FotMob 的 `inBox`(矩形)——
          拿 10,610 顆真實射門逐顆判,兩種差 4.5 個百分點,那就是「59% 對 67%」裡的一大半。
       ② 射門 = 被封阻 + 射正 + 偏出,而 `check-sim` 只印了射正那一類 ——
          `blockedBy` 零個消費端,於是「封阻只有真實的 0.26 倍」在畫面上完全看不見。
       掃原始碼之前**先剝註解**:上面那兩段註解自己就寫著 `dGoal < 18`,
       不剝的話這一條會永遠紅,而紅的原因跟它想守的事一點關係都沒有。 */
    {
      const simSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const bare6 = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const inc = bare6.match(/^.*st\.shotInBox\+\+.*$/gm) ?? [];
      check('三個射門產生點都用同一支矩形判準(十二碼與角球頭球原本是無條件 ++)',
        inc.length === 3 && inc.every(l => /inBoxAt\(p\.x, p\.y, goalX\)/.test(l)),
        `${inc.length} 處:${inc.map(l => l.trim()).join(' | ')}`);
      check('判準從 BOX_D / BOX_W 來,不是自己寫一個半徑',
        /const inBoxAt = \(x, y, goalX\) =>[^;]*BOX_D[^;]*BOX_W/.test(bare6)
        && !/dGoal < 18/.test(bare6),
        /dGoal < 18/.test(bare6) ? '原始碼裡還有 dGoal < 18' : '');

      const chkBare6 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('check-sim 把三種下場一起印(封阻那一類先前零個消費端)',
        /blockedBy\.home \+ r\.st\.counts\.blockedBy\.away/.test(chkBare6)
        && /被封阻/.test(chkBare6) && /偏出/.test(chkBare6));
      /* 真值的母體要跟引擎同一批:烏龍球 shotmap 有、引擎產不出來,
         而它們的座標在自己那一端(離門 95 公尺以上),不排掉會整批掉進「30 公尺以上」那一格。 */
      check('真值把烏龍球排掉(引擎產不出烏龍球,母體要同一批)',
        /sh\.ownGoal\) continue/.test(chkBare6));
      check('判定用這一場兩隊、聯盟只當參照(4w 的規矩)',
        /collectReal\(sh => sh\.team === HOME \|\| sh\.team === AWAY\)/.test(chkBare6)
        && /realFx\.box/.test(chkBare6));
      /* **封阻真的會發生** —— 不然上面那幾條是在守一件不存在的事(4l-3 的同一條規矩)。
         只驗「大於 0」:它離錨還很遠(×0.26),把目前的值寫成紅線就是
         「把會隨資料變動的數字當 CI 紅線」,而修好它的那一天這條會紅在「補上了」。 */
      {
        const S4 = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        const sim4 = S4.createSim({ profile, home: 'ARS', away: 'LIV', seed: 13 });
        for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !sim4.state().over; i++) sim4.advance(1 / 60);
        const c4 = sim4.state().counts, ev4 = sim4.events();
        const blk = c4.blockedBy.home + c4.blockedBy.away;
        const gk4 = c4.gkStopBy.home + c4.gkStopBy.away;
        const off4 = c4.shots - blk - gk4 - c4.onTarget;
        /* 守的是**分割**(四類剛好把射門分完)與**旗標**,不是「每一類都要大於 0」——
           場上球員的封阻現在一場才 0.8 次,seed 13 就真的是 0,而那正是這一輪要講的缺口。
           把它寫成紅線就是「把會隨資料變動的數字當 CI 紅線」。 */
        const blkEv = ev4.filter(e => e.type === 'block');
        check('四種下場剛好把射門數分完,而且每一筆封阻都標了是不是門將',
          off4 >= 0 && blk + gk4 + c4.onTarget + off4 === c4.shots
          && blkEv.every(e => typeof e.gk === 'boolean')
          && blkEv.filter(e => !e.gk).length === blk && blkEv.filter(e => e.gk).length === gk4,
          `射門 ${c4.shots} = 封阻 ${blk} + 門將擋掉 ${gk4} + 射正 ${c4.onTarget} + 偏出 ${off4}`);
      }
    }

    /* 20. 階段 5b:**封阻的形狀**。5a 把總數印出來之後,5b 量到那個總數差 ×0.15 ——
       而「調一個全域乘數把總數湊對」會讓封阻的**是隨機的一批球**。真實有三個形狀:
       逐帶是駝峰、被封阻的球平均 xG 只有沒被封阻的 0.46 倍、頭球被封阻遠少於腳下。
       這一節守的是**那三個量得出來**(計數器存在、加得回總數、check-sim 印出來),
       不守它們的值 —— 值是 5c 的驗收條件,現在寫成紅線就是「把目標達成寫成 CI 紅線」。 */
    {
      const chkBare7 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('check-sim 把封阻的三個形狀都印出來(逐帶 / xG / 頭球腳下)',
        /shotBlkBins/.test(chkBare7) && /被封阻 ÷ 沒被封阻/.test(chkBare7) && /頭球 \/ 腳下 的封阻率/.test(chkBare7));
      /* 真值要**從 shotmap 逐顆算**,不是抄一個數字進程式 —— 抄的那種資料變了不會跟著變。
         錨**不可以**用 `sh.foot === 'Header'`:4l 的角球頭球腳下拆解也有一模一樣的那一行,
         把 blkShape 這一份停掉它照樣命中 —— 四條負向對照裡只有這條沒紅,就是這樣抓到的。
         改用只在這一份出現的三個累加器(逐帶 / xG / 頭球),三個都要在。 */
      check('封阻的真值是從逐顆射門算的(blkShape 的三個累加器都在)',
        /blkShape:/.test(chkBare7) && /blkBins\[bi\]\+\+/.test(chkBare7)
        && /qual\.blkXg \+=/.test(chkBare7) && /qual\.headBlk\+\+/.test(chkBare7));
      /* **四個計數器要一起加**。跑一場真模擬來驗有一個問題:場上球員的封阻現在一場才 0.8 腳,
         隨便一個種子就是 **0** —— 那幾條斷言會「通過」而什麼都沒守到(第一版 seed 17 就是 0)。
         所以拆成兩層:**形狀的接線掃原始碼**(那一段一定在,跟資料無關),
         **恆等式跑真模擬**(逐帶合計 = 封阻總數,那在 0 的時候也成立、在有封阻時才真的守得住)。 */
      {
        const simSrc7 = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const i0 = simSrc7.indexOf('if (gk) st.gkStopBy[ball.shot.side]++;');
        const i1 = simSrc7.indexOf("emit({ type: 'block'", i0);
        const seg7 = i0 >= 0 && i1 > i0 ? simSrc7.slice(i0, i1) : '';
        check('場上球員的封阻同時記逐帶、xG 與頭球(少一個的話那個形狀永遠是空的)',
          seg7.length > 0 && /st\.shotBlkBins\[/.test(seg7) && /st\.blkXg \+=/.test(seg7)
          && /st\.blkHead\+\+/.test(seg7) && /st\.blockedBy\[ball\.shot\.side\]\+\+/.test(seg7),
          `切出來 ${seg7.length} 字元`);
      }
      {
        const S5 = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        let binSum = 0, blk5 = 0, head = 0, headBlk = 0, shots5 = 0, blkXg = 0;
        for (const seed of [17, 18, 19]) {
          const sim5 = S5.createSim({ profile, home: 'ARS', away: 'LIV', seed });
          for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !sim5.state().over; i++) sim5.advance(1 / 60);
          const c5 = sim5.state().counts;
          binSum += c5.shotBlkBins.reduce((a, b) => a + b, 0);
          blk5 += c5.blockedBy.home + c5.blockedBy.away;
          head += c5.shotHead; headBlk += c5.blkHead; shots5 += c5.shots; blkXg += c5.blkXg;
        }
        check('逐帶的封阻數加起來等於封阻總數,而且頭球的封阻不會多過頭球',
          binSum === blk5 && headBlk <= head && head <= shots5 && headBlk <= blk5,
          `3 場合計:逐帶 ${binSum} = 封阻 ${blk5}・頭球 ${head}(其中被封阻 ${headBlk})・射門 ${shots5}・blkXg ${blkXg.toFixed(3)}`);
      }
    }

    /* 21. 階段 5c:**射門線上有沒有人**。5b 的結論(「不是擋不到,是路上沒有人」)
       靠一支 scratchpad 探針,而那支探針**量錯了線** —— 畫的是「射手 → 球門中心」,
       而球瞄的是 `PITCH_H/2 + err`(射正 ±2.7 m、偏出 2.1~6.9 m)。30 場 675 腳的交叉表:
       兩條線都判「有人」55 腳、只有中心線判有人 28 腳、只有真飛行線判有人 43 腳 ——
       **兩個方向各錯三分之一**。所以這一節守三件事:量測接進了引擎(不再只活在 scratchpad)、
       線畫在**真正的飛行方向**上、以及計數自己不矛盾。
       **不守它的值** —— 值是 5d 的驗收條件,現在寫成紅線就是「把目標達成寫成 CI 紅線」。 */
    {
      const simBare = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('三個射門產生點都量了射門線(少一個那一種射門就靜靜不在分母裡)',
        (simBare.match(/noteShotLane\(p, dGoal\)/g) ?? []).length === 3);
      /* 錨要切出**函式自己那一段**:`hypot(ball.vx, ball.vy)` 在整份裡有六處,
         直接掃全檔的話把別人的那幾處也算進來,停掉這一份它照樣綠
         —— 那正是 5b 的四條負向對照裡唯一沒紅的那一條踩到的坑。 */
      const i0 = simBare.indexOf('function noteShotLane(');
      const i1 = simBare.indexOf('st.laneNear[k]++;', i0);
      const seg = i0 >= 0 && i1 > i0 ? simBare.slice(i0, i1) : '';
      /* 否定那半句原本寫 `!/PITCH_H \/ 2 - p\.y/` —— 而這支函式的參數叫 `shooter` 不叫 `p`,
         所以那半句**永遠不會命中**,真正在守的只有正向那半句(負向對照裡它確實紅了,
         但紅的是正向那一半)。改成守「線的**起點**是球不是射手」:`shooter` 只准出現在
         `sideOf(shooter.side)` 與比隊伍那兩處,位置一律讀 `ball`。 */
      check('射門線畫在**真正的飛行方向**上,而且從球起算(不是射手 → 球門中心)',
        seg.length > 0 && /hypot\(ball\.vx, ball\.vy\)/.test(seg)
        && /q\.x - ball\.x/.test(seg) && !/shooter\.[xy]\b/.test(seg),
        `切出來 ${seg.length} 字元`);
      check('兩個門檻都在:DEFLECT_R(擋得到)與 1 m(差一點)—— 只有一個就分不出「沒有人」與「站得不夠準」',
        /lane < DEFLECT_R/.test(seg) && /lane < 1\b/.test(seg));
      const chkBare8 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('check-sim 把曝光印在封阻率旁邊(不印的話這個量測又只活在 scratchpad 裡)',
        /laneOcc/.test(chkBare8) && /路上有人/.test(chkBare8) && /封阻 ÷ 路上有人/.test(chkBare8));
      /* 標題上的半徑要**從引擎讀**。自己寫一個 0.75 的話,引擎改了 DEFLECT_R 它會靜靜過期 */
      check('曝光那一行的半徑是從引擎的原始碼讀的,不是寫死的數字',
        /const DEFLECT_R = \(\[0-9.\]|DEFLECT_R = \(readFileSync/.test(chkBare8)
        || /match\(\/const DEFLECT_R/.test(chkBare8));
      {
        const S6 = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        let shots = 0, ls = 0, bad = 0;
        for (const seed of [11, 12, 13]) {
          const sim6 = S6.createSim({ profile, home: 'ARS', away: 'LIV', seed });
          for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !sim6.state().over; i++) sim6.advance(1 / 60);
          const c6 = sim6.state().counts;
          shots += c6.shots; ls += c6.laneShots.reduce((a, b) => a + b, 0);
          for (let k = 0; k < 7; k++) if (!(c6.laneOcc[k] <= c6.laneNear[k] && c6.laneNear[k] <= c6.laneShots[k])) bad++;
        }
        check('每一腳射門都量到了,而且 DEFLECT_R 內 ≤ 1 m 內 ≤ 這一帶的射門數',
          ls === shots && bad === 0, `3 場:射門 ${shots}、量到 ${ls}、逐帶不一致 ${bad} 格`);
      }
    }

    /* 22. 階段 5d:**撲搶的天花板**。5c 的結論是「缺的全是曝光」,而最順手的下一步
       是給防守員一個「撲上去擋」的動作。5d 先回推它的上限(4k:先問函式族生不生得出
       目標的形狀),量出來天花板**隨離門距離單調上升**而真實的封阻率是**駝峰** ——
       15~25 公尺天花板比真實還低、30 公尺外高到三倍,**沒有任何撲搶成功率生得出駝峰**。
       這一節守的是那個量測本身量得對(飛行時間解二次式、只算擋得在中間的人、
       `LANE_FAR` 只是量測的邊界不進引擎行為),**不守它的值**。 */
    const st5e = [];                          // 第 22 節跑的那三場,第 23 節(5e)接著用
    let chkOut = '';                          // check-sim 跑一次的 stdout,第 23 / 24 節共用(只跑一次)
    {
      const simBare8 = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const j0 = simBare8.indexOf('function noteShotLane(');
      const j1 = simBare8.indexOf('st.laneReach[k]++;', j0);
      const seg8 = j0 >= 0 && j1 > j0 ? simBare8.slice(j0, j1) : '';
      /* 飛行時間**要解二次式**:球滾地會減速,寫 `a / v` 會低估時間、把「來得及」算少。
         錨挑 `2 * BALL_FRICTION * a`(判別式那一項)—— 整份裡只有這裡有。 */
      check('「他來得及嗎」的飛行時間解二次式(球會減速),不是 a ÷ v',
        seg8.length > 0 && /2 \* BALL_FRICTION \* a/.test(seg8) && /Math\.sqrt\(disc\)/.test(seg8),
        `切出來 ${seg8.length} 字元`);
      /* `LANE_FAR` 是**量測的邊界**,不是模型的參數 —— 引擎的行為不准讀它。

         **不要數出現次數。** 這條原本寫成「整份 3 處、函式裡 2 處」,而階段 5e 只是
         在同一個迴圈裡**多加一個量測**(數人數,不是只記有沒有)就紅在「多了一個」——
         本站記過那條坑(「數出現次數的斷言,加一個聯賽就紅在多了一個」),
         而它就發生在守「不要把量測漏進行為」的這一條自己身上。
         改成守**性質**:每一處 `LANE_FAR` 都要落在宣告那一行或 `noteShotLane` 裡面。 */
      const jE = simBare8.indexOf('function ', j0 + 22);   // noteShotLane 的下一個函式 = 它的結尾
      /* **量測函式不只一支了**(2026-09-20,階段 5g 加了 `laneAtDecision`)——
         而這一條守的性質是「**引擎的行為**不准讀 `LANE_FAR`」,不是「只有一支量測函式」。
         所以清單要跟著量測函式走,不是寫死一支。這正是它自己上一段註解在講的坑
         (從「數出現次數」改成守性質之後,**範圍**還是會過期)。
         **範圍要自己算出來**:每一支量測函式的起點到它的下一個 `function `,
         寫死行號或寫死名字清單的話,下一支量測函式又會讓它紅在「行為沒變」上。 */
      const MEASURE = ['function noteShotLane(', 'function laneAtDecision('];
      const spans = MEASURE.map(sig => {
        const a = simBare8.indexOf(sig);
        return a < 0 ? null : [a, simBare8.indexOf('function ', a + sig.length)];
      }).filter(Boolean);
      let stray = 0, at = -1, tot = 0;
      while ((at = simBare8.indexOf('LANE_FAR', at + 1)) >= 0) {
        tot++;
        const isDecl = simBare8.slice(Math.max(0, at - 6), at) === 'const ';
        if (!isDecl && !spans.some(([a, b]) => b > a && at > a && at < b)) stray++;
      }
      check('LANE_FAR 只給量測用:宣告與那幾支量測函式以外一處都不准有',
        j0 >= 0 && jE > j1 && spans.length === MEASURE.length && tot >= 2 && stray === 0,
        `整份 ${tot} 處、量測函式 ${spans.length} 支、漏進行為 ${stray} 處`);
      const chkBare9 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('check-sim 把「4 m 內」與「撲得到的天花板」兩排都印出來',
        /laneFar/.test(chkBare9) && /laneReach/.test(chkBare9) && /撲得到/.test(chkBare9));
      {
        const S9 = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        let bad = 0, far = 0, rch = 0, shots = 0;
        for (const seed of [21, 22, 23]) {
          const sim9 = S9.createSim({ profile, home: 'ARS', away: 'LIV', seed });
          for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !sim9.state().over; i++) sim9.advance(1 / 60);
          const c9 = sim9.state().counts;
          st5e.push(c9);                        // 第 23 節(5e)共用這三場,不要再跑三場
          for (let k = 0; k < 7; k++) {
            /* 四個門檻是一層套一層的:DEFLECT_R ⊂ 1 m ⊂ 4 m ⊂ 這一帶的射門。
               而「撲得到」的前置就是 4 m 內有人,所以它也不可能比 4 m 那一格多。 */
            if (!(c9.laneOcc[k] <= c9.laneNear[k] && c9.laneNear[k] <= c9.laneFar[k]
              && c9.laneFar[k] <= c9.laneShots[k] && c9.laneReach[k] <= c9.laneFar[k])) bad++;
            far += c9.laneFar[k]; rch += c9.laneReach[k]; shots += c9.laneShots[k];
          }
        }
        check('四個門檻一層套一層,而且天花板不會超過「4 m 內有人」',
          bad === 0, `3 場:射門 ${shots}、4 m 內 ${far}、撲得到 ${rch}、逐帶不一致 ${bad} 格`);
      }
    }

    /* 23. 階段 5e:**其餘九個人站在哪裡**。5d 在同一張表上留了一句「15~20 公尺那一格是
       個凹陷」,而重量出來那個差**不到 1 個 SE、而且符號相反** —— 規劃裡的診斷是雜訊。
       這一節守的是新那幾個量測本身量得對:純觀測(不碰 rng)、計數器的上下界、
       深度量的是**自家**球門那一側,以及 check-sim 真的把樣本數與 SE 印出來
       (沒有那兩行,下一個人會再一次把雜訊讀成凹陷)。**不守它們的值** —— 那會漂。 */
    {
      const simBare = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const a0 = simBare.indexOf('function noteShotLane(');
      const a1 = simBare.indexOf('function ', a0 + 22);
      const seg = a0 >= 0 && a1 > a0 ? simBare.slice(a0, a1) : '';
      /* 純觀測:量測一旦呼叫 rng() 就會把亂數序列錯開,同一個種子跑出來不是同一場比賽
         (本站記過那條坑,而 5e 是拿同種子 8/8 逐場逐字相同證明的)。 */
      check('noteShotLane 一次 rng() 都不呼叫(它是量測,不是行為)',
        seg.length > 0 && !/\brng\s*\(/.test(seg), `切出來 ${seg.length} 字元`);
      const chkBare = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* **掃原始碼分不出「印出來」與「原始碼裡有這個字串」。** 這兩條的第一版寫成
         `chkBare.includes('這一帶幾腳')`,而負向對照把那一行包進 `if (0)` 之後
         **照樣是綠的** —— 字串還在,只是永遠不執行。那跟「這條測試守不住任何東西」
         長得一模一樣,而它是負向對照抓到的,不是讀程式看出來的。
         所以真的跑一次 check-sim,掃它的 **stdout**。一場就夠:這幾排跟場數無關。 */
      chkOut = spawnSync(process.execPath,
        [join(ROOT, 'scripts', 'game', 'check-sim.mjs'), '1'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
      check('check-sim **真的印出** 5e 那幾排(跑一次掃 stdout,不是掃原始碼)',
        ['門側的人', '深度上在球之前', '站進球道', '每 10 m 球道', '最近那個離線',
          '球道長度', '防線深度', '後四人的前後差', '後四人的橫向跨距']
          .every(t => chkOut.includes(t)), `check-sim 輸出 ${chkOut.length} 字元`);
      /* 樣本數與 SE 要印在旁邊 —— 少了它們,逐帶的比例看起來就像一條曲線,
         而一帶只有幾十腳。5e 的規劃就是這樣把雜訊寫成了「要修的凹陷」。 */
      check('逐帶的比例旁邊**真的印出**樣本數與 ±1 SE(不然雜訊會被讀成形狀)',
        chkOut.includes('這一帶幾腳') && /±1 SE/.test(chkOut), `check-sim 輸出 ${chkOut.length} 字元`);
      /* SE 是二項式的 √(p(1−p)/n) —— 這一條掃不到 stdout(輸出只有數字),
         所以它留在原始碼那一層,而且自己一條:一條斷言有幾個子句就要貼幾個 bug。 */
      check('那個 ±1 SE 是二項式算的,不是隨手給一個數字',
        /Math\.sqrt\(p \* \(1 - p\) \/ n\)/.test(chkBare));
      {
        let bad = 0, badLine = 0, gs = 0, n4 = 0, shots = 0, dep = 0, depN = 0;
        for (const c of st5e) {
          for (let k = 0; k < 7; k++) {
            /* 上下界:① 站進球道 4 m 的**人數**不會比「有沒有人」那一格的**腳數**少
               (有人 → 至少一個人);② 只有 10 個對方場上球員,門側最多 10 × 腳數;
               ③ 有記到離線距離 / 深度的腳數不會超過這一帶的射門數。 */
            /* 「門側」的兩種量法:離球門**中心**比射手近(`gsN`)是標準意思,
               而它把**站得寬**的後衛排掉;`gsLineN` 只看沿場長的深度。
               **兩個誰都不包含誰**(第一版斷言寫了 `gsN <= gsLineN`,那是錯的:
               射手站得很寬的時候,離門線比他遠的後衛照樣可以離球門中心比他近),
               所以這裡只守各自的上界 —— 對方場上最多 10 個人。 */
            if (!(c.laneN[k] >= c.laneFar[k] && c.gsN[k] <= 10 * c.laneShots[k]
              && c.gsLineN[k] <= 10 * c.laneShots[k]
              && c.lanePerpN[k] <= c.laneShots[k] && c.lineDepthN[k] <= c.laneShots[k]
              && c.lineWide[k] <= 68 * c.lineDepthN[k])) bad++;
            /* 最深 ≤ 平均 ≤ 第四深 自己一條 —— 它守的是「深度那三個數字沒有接反」,
               跟上面那些上界是不同的性質(一條斷言有幾個子句就要貼幾個 bug)。 */
            if (!(c.lineBack[k] <= c.lineDepth[k] && c.lineDepth[k] <= c.lineFront[k])) badLine++;
            gs += c.gsN[k]; n4 += c.laneN[k]; shots += c.laneShots[k];
            dep += c.lineDepth[k]; depN += c.lineDepthN[k];
          }
        }
        check('5e 的四個計數器都在上下界裡(人數 ≥ 有沒有、門側 ≤ 10 人、記到的 ≤ 射門數)',
          st5e.length > 0 && shots > 0 && bad === 0,
          `${st5e.length} 場:射門 ${shots}、門側 ${gs}、站進球道 ${n4}、逐帶越界 ${bad} 格`);
        check('後四人的最深 ≤ 平均 ≤ 第四深(三個數字沒有接反)',
          st5e.length > 0 && badLine === 0, `逐帶不一致 ${badLine} 格`);
        /* 深度量的是離**自家**球門線。拿錯一邊的話它會變成 105 − 真值,
           而射門那一刻防守方最深的四個人一定在自家半場那一側,所以平均必定小於半場。
           **這是拿錯球門的判別式**,不是一個調出來的門檻。 */
        check('防線深度算的是離自家球門線(射門當下必定小於半場)',
          depN > 0 && dep / depN < 105 / 2,
          `${depN} 腳平均 ${depN > 0 ? (dep / depN).toFixed(1) : '—'} m`);
      }
    }

    /* 24. 階段 5f:**寬度是誰決定的,以及收窄能買到多少**。5e 量到後四人橫向跨距
       41~46 公尺(場寬 68),而 y 只有兩個來源:隊形的槽位與盯人。這一節守的是
       那兩個量測量得對,以及天花板探針量在**會碰到球的那個半徑**上 ——
       第一版只量 `LANE_FAR`(4 m),而真正造成封阻的是 `DEFLECT_R`(0.75 m),
       拿前者換算封阻率就是用推的(這一輪已經推錯兩次)。**不守它們的值。** */
    {
      const simBare = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const b0 = simBare.indexOf('function noteShotLane(');
      const b1 = simBare.indexOf('function ', b0 + 22);
      const seg5f = b0 >= 0 && b1 > b0 ? simBare.slice(b0, b1) : '';
      /* **歸因的值會過期。** 站位那一段只在有持球者時跑,而鬆球(角球頭球、凌空抽射)
         整塊不跑 —— 只檢查 `!= null` 分不出「這一格寫的」與「上一次持球時寫的」。
         錨挑時間戳那個判斷,它只在這裡出現。 */
      check('隊形歸因帶新鮮度判定(鬆球時站位那段不跑,值會過期)',
        seg5f.length > 0 && /dfAt != null && st\.t - q\.dfAt </.test(seg5f),
        `切出來 ${seg5f.length} 字元`);
      /* 天花板要量在 `DEFLECT_R` 上 —— 只有 `LANE_FAR` 的話,
         要換算成封阻率就只能推(5c 量過的轉換率是掛在 0.75 m 上的)。 */
      check('收窄的天花板同時量 4 m 與 0.75 m(後者才換算得到封阻率)',
        /perp < LANE_FAR\) n\+\+/.test(seg5f) && /perp < DEFLECT_R\) hit = 1/.test(seg5f));
      /* `SQUEEZE` 跟 `LANE_FAR` 同一類:量測的邊界,引擎的行為不准讀它。
         守性質不數次數(數次數的斷言這一輪已經被自己咬過一次)。 */
      /* **計數器的長度由它決定是合法的**(`laneSq: SQUEEZE.map(...)`)——
         那是量測的基礎設施,不是引擎的行為。第一版的規則寫成「宣告與 noteShotLane
         以外一處都不准有」,於是**乾淨狀態下就紅**,而且七個負向對照每個都多紅一條、
         針對它的那個 bug 因此完全沒驗到。所以允許的三種:宣告、`noteShotLane` 裡面、
         以及**同一行也提到 `laneSq`** 的(配置計數器)。 */
      let strayS = 0, atS = -1, totS = 0;
      while ((atS = simBare.indexOf('SQUEEZE', atS + 1)) >= 0) {
        totS++;
        const isDecl = simBare.slice(Math.max(0, atS - 6), atS) === 'const ';
        const ls0 = simBare.lastIndexOf('\n', atS), ls1 = simBare.indexOf('\n', atS);
        const lineOf = simBare.slice(ls0 + 1, ls1 < 0 ? undefined : ls1);
        const isAlloc = lineOf.includes('laneSq');
        if (!isDecl && !isAlloc && !(b0 >= 0 && b1 > b0 && atS > b0 && atS < b1)) strayS++;
      }
      check('SQUEEZE 只給量測用:宣告與 noteShotLane 以外一處都不准有',
        totS >= 2 && strayS === 0, `整份 ${totS} 處、漏進行為 ${strayS} 處`);
      check('那個收窄的判定跟上面那幾排逐字同一段球道區間(a 的上下界一樣)',
        (seg5f.match(/a <= 0\.3 \|\| a >= L/g) ?? []).length === 2);
      {
        let bad = 0, shots = 0, wide = 0, sq0n = 0, sq3n = 0;
        /* 幾個收窄檔次由產物自己決定 —— 寫死 `[0,1,2,3]` 的話,
           以後多一檔就會靜靜不被檢查(手寫清單那條坑)。 */
        const SQ_N = (st5e[0]?.laneSq ?? []).map((_, i) => i);
        for (const c of st5e) {
          for (let k = 0; k < 7; k++) {
            /* **不要守「越窄越多」** —— 那不是結構上必然的:球道不經過中線時,
               把人往中線收會讓他離開走廊(實測 0.75 m 那一排 25% 就比 0% 高)。
               守的是結構上的上界:最多四個人、「有沒有」不會多過射門數、
               跨距不會超過場寬、被盯人不會超過四個。 */
            if (!(SQ_N.every(si => c.laneSq[si][k] <= 4 * c.laneShots[k]
                && c.laneSqHit[si][k] <= c.laneShots[k])
              && c.lineWideShape[k] <= 68 * c.lineShapeN[k]
              && c.lineMarked[k] <= 4 * c.lineDepthN[k])) bad++;
            shots += c.laneShots[k]; wide += c.lineWideShape[k];
            sq0n += c.laneSq[0][k]; sq3n += c.laneSq[SQ_N.length - 1][k];
          }
        }
        check('收窄的每一檔都在結構上界裡(最多四個人、有沒有不會多過射門數)',
          st5e.length > 0 && shots > 0 && SQ_N.length >= 2 && bad === 0,
          `${st5e.length} 場:射門 ${shots}、${SQ_N.length} 檔、不收窄 ${sq0n}、最窄 ${sq3n}、逐帶越界 ${bad} 格`);
        /* **第一檔一定要是「不收窄」** —— 沒有同母體的基準線,
           「收窄買到多少」就混進了「母體從十個人換成四個人」。 */
        check('收窄的第一檔是「不收窄」(同母體的基準線)',
          /const SQUEEZE = \[1,/.test(simBare));
      }
      check('check-sim 真的印出 5f 那幾排(照隊形 / 被盯人 / 基準線 / 兩個半徑的收窄)',
        ['照隊形會是', '其中被盯人拉走', '不收窄', '收窄到 75%', '0.75 m 內']
          .every(t => chkOut.includes(t)), `check-sim 輸出 ${chkOut.length} 字元`);

    /* 25. **體能**(2026-09-20)。使用者指定要做體能。它**沒有直接的真值**
       (逐場的 `physical` 只有全場總計),所以這一節守的不是「衰退幅度對不對」——
       那個沒有錨可以判 —— 而是三件守得住的事:
       ① **0 是恆等元**(接上去而不調的話,跑出來跟沒有體能時逐場逐字相同);
       ② **它只改跑得出來的速度,不碰任何結果**(xG、扣扳機的機率一個都不准讀它);
       ③ **它在畫面上不准再被寫成「還沒做」**(本站記過五次的坑)。
       **不守「後 15 分比前 15 分慢」** —— 量過:那個比值在 2 / 3 / 4 場是
       1.002 / 1.012 / 1.004,場間雜訊完全蓋過 0.02 的效果(40 場才看得到 0.983)。
       拿它當紅線就是一條會隨機變紅的假紅線。守得住的是**確定性**的那一層:
       `vmax` 逐格不會變大,而且比值剛好等於疲勞公式。 */
    {
      const simRaw = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const S25 = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
      const STEP25 = 1 / 60;
      const fade = Number((simRaw.match(/^const STAM_FADE = ([0-9.]+);/m) ?? [])[1]);
      check('STAM_FADE 是一個讀得出來的常數', Number.isFinite(fade) && fade >= 0, `STAM_FADE = ${fade}`);
      /* **恆等元要用跑的證明,不是用讀的。** 兩個版本:把常數設成 0、
         以及把疲勞那個乘數**整段拿掉**。兩邊逐場的比分 / 射門 / 角球 / 犯規 / 傳球
         要一字不差 —— 差一個字就代表 0 也在消耗 rng 或改行為,
         那樣「沒有體能時等於站上的 λ」那條保證就不成立了。

         **剝除的錨挑在「用到 fat 的那一行」,不是「算出 fat 的那一行」。**
         第一版錨在 `const fat = p.fatigue ?? 1;`,而負向對照要打壞恆等元最自然的改法
         就是改那一行(`* 0.999`)—— 於是剝除**靜靜沒命中**、兩個版本變成同一份程式,
         紅的是下面那條「對照版真的不一樣了」而不是恆等元本身。
         (在 STAM_FADE = 0 下,`p.vmax = p.vmax0 * p.fatigue` 那一行在 guard 裡不會跑,
          所以只剝 `* fat` 就等於把疲勞整個拿掉。) */
      {
        const load = async s => import('data:text/javascript;base64,' + Buffer.from(s, 'utf8').toString('base64'));
        const zeroed = simRaw.replace(/^const STAM_FADE = [0-9.]+;/m, 'const STAM_FADE = 0;');
        const stripped = zeroed.replace(' * fat,', ' * 1,');
        check('把疲勞那個乘數拿掉的對照版真的不一樣了(不然下一條在比兩份相同的程式)',
          stripped !== zeroed && zeroed !== simRaw);
        const [A, B] = [await load(zeroed), await load(stripped)];
        const fin = (M, seed) => {
          const s = M.createSim({ profile, home: 'ARS', away: 'LIV', seed, pred });
          for (let i = 0; i < Math.round(110 * 60 / STEP25) && !s.state().over; i++) s.advance(STEP25);
          const c = s.state();
          return `${c.score[0]}-${c.score[1]}/${c.counts.shots}/${c.counts.corners.home + c.counts.corners.away}`
            + `/${c.counts.fouls.home + c.counts.fouls.away}/${c.counts.passes}`;
        };
        let same = 0; const seeds = [1, 2];
        for (const sd of seeds) if (fin(A, sd) === fin(B, sd)) same++;
        check('STAM_FADE = 0 是恆等元(跟「整段拿掉」逐場相同)',
          same === seeds.length, `${same} / ${seeds.length} 場逐場相同`);
      }
      /* **體能改的是行為不是結果。** 把控球硬設成目標值那一課:一個「體能」如果去
         乘 xG 或扣扳機的機率,那就是在畫面上編數字。守法是位置 —— 每一處
         `STAM_FADE` 要嘛是宣告、要嘛在 `movePlayer` 裡;每一處 `fatigue` 要嘛在
         `movePlayer` 裡、要嘛是初始化(`fatigue: 1`,球員構造與換人各一)。
         **不要數出現次數**(「數出現次數的斷言,加一個就紅在多了一個」)。 */
      {
        const bare = simRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const m0 = bare.indexOf('function movePlayer(');
        const m1 = bare.indexOf('function moveBall(', m0);
        const inMove = i => m0 >= 0 && m1 > m0 && i > m0 && i < m1;
        let strayF = 0, strayG = 0, totF = 0, totG = 0, at = -1;
        while ((at = bare.indexOf('STAM_FADE', at + 1)) >= 0) {
          totG++;
          if (!inMove(at) && !/^const STAM_FADE = /.test(bare.slice(at - 6, at + 20))) strayG++;
        }
        at = -1;
        while ((at = bare.indexOf('fatigue', at + 1)) >= 0) {
          totF++;
          if (!inMove(at) && !/^fatigue: 1/.test(bare.slice(at, at + 10))) strayF++;
        }
        check('體能只在跑動那一層:STAM_FADE 只在宣告與 movePlayer、fatigue 只在 movePlayer 與初始化',
          m0 >= 0 && m1 > m0 && totG >= 2 && totF >= 3 && strayG === 0 && strayF === 0,
          `STAM_FADE ${totG} 處(漏出去 ${strayG})・fatigue ${totF} 處(漏出去 ${strayF})`);
        /* 換上場的人 `dist` 從 0 開始,所以 `vmax` 也要回到新鮮值 ——
           **手動換人的價值就是這個**,少這一行生力軍就跟被換下的人一樣累。 */
        const sub0 = bare.indexOf('substitute(side, offCode, onCode)');
        const subSeg = sub0 >= 0 ? bare.slice(sub0, sub0 + 900) : '';
        check('換上場的人體能是滿的(換人那一段把 fatigue 與 vmax 一起重設)',
          /dist: 0/.test(subSeg) && /fatigue: 1/.test(subSeg) && /vmax: spare\.p\.vmax0/.test(subSeg),
          `切出來 ${subSeg.length} 字元`);
      }
      /* **確定性的那一層**:`vmax` 逐格不准變大(疲勞是單調的),而且兩個時間點的
         比值要剛好等於 `(1 − f·d₂/10⁴) / (1 − f·d₁/10⁴)`。這不是統計量,
         一場就驗得死 —— 上面那段註解講的「不守速度比」換來的就是這一條。 */
      if (fade > 0) {
        const s = S25.createSim({ profile, home: 'ARS', away: 'LIV', seed: 1, pred });
        let t1 = null, rises = 0, prev = {};
        for (let i = 0; i < Math.round(110 * 60 / STEP25); i++) {
          if (s.state().over) break;
          const mo = s.motion();
          if (i === Math.round(20 * 60 / STEP25)) t1 = Object.fromEntries(mo.players.map(p => [p.code, p]));
          for (const p of mo.players) { if (prev[p.code] && p.vmax > prev[p.code] + 1e-9) rises++; prev[p.code] = p.vmax; }
          s.advance(STEP25);
        }
        const t2 = Object.fromEntries(s.motion().players.map(p => [p.code, p]));
        let worst = 0, n = 0, km = 0;
        for (const c of Object.keys(t2)) {
          const a = t1?.[c]; if (!a) continue;
          const want = (1 - fade * t2[c].dist / 1e4) / (1 - fade * a.dist / 1e4);
          worst = Math.max(worst, Math.abs(t2[c].vmax / a.vmax - want)); n++; km += t2[c].dist;
        }
        check('vmax 逐格不會變大,而且比值剛好等於疲勞公式(一場、22 人)',
          n >= 20 && rises === 0 && worst < 1e-9,
          `${n} 人:變大 ${rises} 次、最大誤差 ${worst.toExponential(1)}、完場平均跑動 ${(km / n / 1000).toFixed(2)} km`);
      }
      check('check-sim **真的印出**體能那一排(跑一次掃 stdout)',
        chkOut.includes('體能:逐 15 分的平均速度') && chkOut.includes('後 15 分 ÷ 前 15 分'),
        `check-sim 輸出 ${chkOut.length} 字元`);
      /* **有哪一句還在講我們沒有它** —— 本站記過五次,最近一次就犯在 CLAUDE.md 自己身上。
         體能做完之後,畫面上任何一段「還沒做的」都不准再列它。
         掃的是 `game-view.js` 裡每一段 `還沒做的` 之後到句號為止的那一小段,
         不是整份(整份會被「刻意不做」與解釋體能的那幾句誤報)。 */
      {
        const view = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-view.js'), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const segs = [];
        let at = -1;
        while ((at = view.indexOf('還沒做的', at + 1)) >= 0) {
          const end = view.indexOf('。', at);
          segs.push(view.slice(at, end < 0 ? at + 300 : end));
        }
        check('畫面上的「還沒做的」不准再列體能(加了能力之後要回頭看的那一句)',
          segs.length >= 2 && segs.every(t => !t.includes('體能')),
          `${segs.length} 段「還沒做的」`);
        check('畫面把體能講清楚:沒有真值可校準、而且它不負責後段進球潮',
          /衰退的幅度沒有真值可以校準/.test(view) && /不產生真實世界的後段進球潮/.test(view));
      }
    }

    /* 26. 階段 5g:**扣扳機有沒有在挑空走廊**(2026-09-20)。5f 否定收窄、5d 否定撲搶之後
       剩下的最後一個候選。量法是在**每一個射程內的決策點**上取球道佔比,射與不射同一份。
       結論是**否定**(射的 7.7% 對沒射的 8.1%,0.4 SE),而更硬的一句在回推那一行:
       封阻率 = 曝光 × 轉換,拿現在的轉換回推,要對上真實得有 **>100%** 的曝光 ——
       **算術上不可能**,所以站位 / 扣扳機 / 半徑三條路都不是缺口所在。
       (2026-09-25 階段 5n:那裡的「站位」是 5f 的**收窄防線**;逼搶者站到門側是另一條,
        它動得了曝光 —— check-sim 那一行的結論現在跟著數字變,不再是固定的字串。)
       這一節守的是**量測本身量得對**(純觀測、同一條線、同一批母體、上下界),
       **不守它的值** —— 那會漂。 */
    {
      const simB = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const d0 = simB.indexOf('function laneAtDecision(');
      const d1 = simB.indexOf('function noteShotLane(', d0);
      const seg = d0 >= 0 && d1 > d0 ? simB.slice(d0, d1) : '';
      /* 純觀測:這一段碰 `rng()` 的話,同一個種子跑出來就不是同一場比賽,
         而 5g 之後的每一個比較都會失效(「同一個種子換一個旗標」那條坑)。 */
      check('決策點的球道量測不呼叫 rng(純觀測)',
        seg.length > 0 && !/\brng\(/.test(seg), `切出來 ${seg.length} 字元`);
      /* **兩條線要分得開**:決策當下用意圖線(射手 → 球門中心),射出去之後用飛行方向。
         拿飛行方向去分「射 / 沒射」等於用結局條件化,而拿意圖線去比 5c 那幾排
         等於拿兩條不同的線並排讀(5c 實測兩條在 675 腳上各錯三分之一)。 */
      check('決策點用意圖線(球門中心)、noteShotLane 用飛行方向 —— 兩條線沒有混用',
        /PITCH_H \/ 2 - p\.y/.test(seg) && !/ball\.v[xy]/.test(seg)
        && /ball\.vx \/ v/.test(simB), `切出來 ${seg.length} 字元`);
      /* **同一份 `dl` 給兩群用**:抽籤前算一次,抽完再加射門那一份。
         分兩支各量一次的話那就是兩份程式,而「射的」與「沒射的」就不再是同一條線。 */
      check('球道在抽籤**之前**量一次,射門那一份直接沿用同一個結果',
        simB.indexOf('const dl = laneAtDecision(') >= 0
        && simB.indexOf('const dl = laneAtDecision(') < simB.indexOf('st.decShotOcc[oppBin] += dl.occ')
        && (simB.match(/laneAtDecision\(/g) ?? []).length === 2);   // 宣告 + 唯一的呼叫點
      {
        const S26 = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        let bad = 0, N = 0, SN = 0, O = 0, F = 0;
        for (const seed of [31, 32]) {
          const sim = S26.createSim({ profile, home: 'ARS', away: 'LIV', seed });
          for (let i = 0, M = Math.round(110 * 60 * 60); i < M && !sim.state().over; i++) sim.advance(1 / 60);
          const c = sim.state().counts;
          for (let k = 0; k < 7; k++) {
            /* 一層套一層:射門 ⊂ 決策點、0.75 m ⊂ 4 m ⊂ 決策點,而射門那一份
               不可能多過它自己的母體、也不可能多過同一個門檻的全體。 */
            if (!(c.decShot[k] <= c.decN[k] && c.decOcc[k] <= c.decFar[k] && c.decFar[k] <= c.decN[k]
              && c.decShotOcc[k] <= c.decShotFar[k] && c.decShotFar[k] <= c.decShot[k]
              && c.decShotOcc[k] <= c.decOcc[k] && c.decShotFar[k] <= c.decFar[k])) bad++;
            N += c.decN[k]; SN += c.decShot[k]; O += c.decOcc[k]; F += c.decFar[k];
          }
          /* 決策點的射門數要對得回引擎自己的射門計數器 —— 對不上就代表
             有一條射門的路沒有經過這個決策點(十二碼與角球頭球就是那種),
             而那會讓「射的那一群」跟畫面上的射門不是同一批。 */
          if (SN > c.counts?.shots) bad++;
        }
        check('決策點的計數器一層套一層(射門 ⊂ 決策點、0.75 m ⊂ 4 m)',
          N > 0 && SN > 0 && bad === 0,
          `2 場:決策點 ${N}、射門 ${SN}、0.75 m ${O}、4 m ${F}、逐帶越界 ${bad} 格`);
      }
      check('check-sim **真的印出** 5g 那幾排(跑一次掃 stdout)',
        ['決策點的球道', '路上有人:射的 / 沒射的', 'P(射|有人)', '全部決策點的曝光']
          .every(t => chkOut.includes(t)), `check-sim 輸出 ${chkOut.length} 字元`);
      /* **回推那一行是 5g 真正的結論**:封阻率 = 曝光 × 轉換,所以「要對上真實需要多少曝光」
         = 真實封阻率 ÷ 轉換。它超過 100% 就是算術上不可能 —— 那句話要印得出來,
         不然下一個人會再去調一次站位(本站已經為這件事花了 5b~5g 六輪)。 */
      {
        const chkB = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        check('回推的式子是「真實封阻率 ÷ 轉換」,而且轉換取的就是印出來的那一個',
          /const conv = O > 0 \? myBlkN0 \/ O : null;/.test(chkB)
          && /100 \* realBlk \/ conv/.test(chkB));
        check('check-sim **真的印出**回推那一行(它是 5g 的結論)',
          chkOut.includes('回推:要對上真實的封阻率,曝光得是'), `check-sim 輸出 ${chkOut.length} 字元`);
      }
    }

    /* 27. 階段 5h:**禁區裡的活動量**(2026-09-21)。5b~5g 六輪的結論是「封阻補不上是因為
       這個引擎沒有製造出真實的人堆」,而那句話唯一的憑據是 `boxTouch` 的倍率 ——
       **而那個倍率的兩邊不是同一個定義**:上游的 `touches_opp_box` 是 Opta 的「碰到球」,
       本站只數接到球。`check-sim` 那一行的註解**本來就寫著「所以這個倍率是下限」**,
       六輪沒有人回去修(「我的分母跟被比較的那一邊是不是同一批」第十次,而這一次
       它就寫在要被當前提的那個數字旁邊)。
       這一節守的是量測本身量得對:純觀測、兩個呼叫點都在、十二碼不算、守方不含門將、
       `BOX_REVISIT` 不漏進引擎行為、計數器的上下界,以及 check-sim 真的把那幾排
       **連同「仍然是下限」那句話**印出來(鐵則四)。**不守它們的值** —— 那會漂。 */
    {
      const simBareA = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* 量測函式的範圍**自己算**(起點到下一個 `function `)—— 寫死行號或名字清單的話,
         下一支量測函式又會讓它紅在「行為沒變」上(5g 在 LANE_FAR 那一條上踩過)。 */
      const MEAS = ['function noteBoxTouch(', 'function noteBoxFrame(', 'function noteShotBox('];
      const span = sig => {
        const a = simBareA.indexOf(sig);
        return a < 0 ? null : [a, simBareA.indexOf('function ', a + sig.length)];
      };
      const spansA = MEAS.map(span).filter(Boolean);
      const bodyOf = sig => { const sp = span(sig); return sp && sp[1] > sp[0] ? simBareA.slice(sp[0], sp[1]) : ''; };
      check('5h 的三支量測函式都在,而且一個 rng( 都沒有(純觀測)',
        spansA.length === MEAS.length && MEAS.every(sig => bodyOf(sig) && !/rng\(/.test(bodyOf(sig))),
        `${spansA.length}/${MEAS.length} 支`);
      /* **兩個呼叫點都要在。** 只留 `giveTo` 那一個的話,數字會靜靜退回「只數接到球」,
         而那正是這一輪要修的那個定義落差 —— 不報錯、畫面正常、倍率變小。 */
      {
        const gi = simBareA.indexOf('function giveTo('), ki = simBareA.indexOf('function kick(');
        const gEnd = simBareA.indexOf('function ', gi + 17), kEnd = simBareA.indexOf('function ', ki + 15);
        const inGive = gi >= 0 && simBareA.slice(gi, gEnd).includes('noteBoxTouch(p)');
        const inKick = ki >= 0 && simBareA.slice(ki, kEnd).includes('noteBoxTouch(from)');
        check('對齊上游定義:接到球與踢出去**兩邊**都記一次觸球',
          inGive && inKick, `giveTo ${inGive ? '✓' : '✗'}、kick ${inKick ? '✓' : '✗'}`);
      }
      /* **十二碼不記**:那是死球、所有人排在禁區外,算進來只會把「人堆」的平均壓低,
         而它跟人堆一點關係都沒有。錨挑 takePenalty 這一段裡有沒有 noteShotBox。 */
      {
        const pi = simBareA.indexOf('function takePenalty(');
        const pEnd = simBareA.indexOf('function ', pi + 22);
        check('十二碼不進「射門當下禁區裡幾個人」(死球,所有人都排在禁區外)',
          pi >= 0 && pEnd > pi && !simBareA.slice(pi, pEnd).includes('noteShotBox('));
      }
      /* 兩支取樣都要把門將排掉,而且是**同一個寫法** —— 一邊排一邊不排的話,
         逐格的人數跟射門當下的人數就不是同一個量,而兩個數字會被並排讀。 */
      check('守方不含門將,而且兩支取樣同一個寫法',
        ['function noteBoxFrame(', 'function noteShotBox(']
          .every(sig => /q !== sideOf\(q\.side\)\.gk/.test(bodyOf(sig))));
      /* `BOX_REVISIT` 跟 `LANE_FAR` 同一條規則:**量測的邊界,引擎的行為不准讀它**。
         它決定的是「球沿著禁區線滾來滾去算不算一次新的進攻」,不是球該怎麼滾。 */
      {
        let stray = 0, at = -1, tot = 0;
        while ((at = simBareA.indexOf('BOX_REVISIT', at + 1)) >= 0) {
          tot++;
          const isDecl = simBareA.slice(Math.max(0, at - 6), at) === 'const ';
          if (!isDecl && !spansA.some(([a, b]) => b > a && at > a && at < b)) stray++;
        }
        check('BOX_REVISIT 只給量測用:宣告與那三支量測函式以外一處都不准有',
          tot >= 2 && stray === 0, `整份 ${tot} 處、漏進行為 ${stray} 處`);
      }
      /* 上下界:對齊版一定 ≥ 只數接到球那一版(它多算了踢出去);
         「出去 0.5 秒以上才算」一定 ≤ 原始的進出次數;禁區內的射門不會多過總射門。 */
      {
        const SA = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        let bad = 0, recv = 0, all_ = 0, ent = 0, ent2 = 0, sec = 0, sbn = 0, shots = 0;
        for (const seed of [31, 32]) {
          const simA = SA.createSim({ profile, home: 'ARS', away: 'LIV', seed });
          for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !simA.state().over; i++) simA.advance(1 / 60);
          const c = simA.state().counts;
          const two = o => (o?.home ?? 0) + (o?.away ?? 0);
          recv += two(c.boxTouch); all_ += two(c.boxTouchAll);
          ent += two(c.boxEntry); ent2 += two(c.boxEntry2); sec += two(c.boxSec);
          sbn += c.shotBox.open.n + c.shotBox.corner.n; shots += c.shots;
          if (!(two(c.boxTouchAll) >= two(c.boxTouch))) bad++;
          if (!(two(c.boxEntry2) <= two(c.boxEntry))) bad++;
          if (!(two(c.boxSec) > 0 && two(c.boxEntry) > 0)) bad++;
          /* 「有人碰到球的那幾次」⊂「越過禁區線的那幾次」,而且每一次至少有一下觸球。
             這一條擋的是把兩個計數器接反 —— 它們的比值(40%)正是這一輪的結論之一。

             **上界要寫成嚴格的 `<`。** 第一版寫 `<=`,而負向對照(把「一段只記第一次」
             改成「每一下都記」)**一條都沒紅** —— 那樣 boxEntryHit 會等於 boxTouchAll,
             兩個 `<=` 都還成立。嚴格的那一個要求「至少有一段碰到球超過一下」,
             而那正是被改掉的性質(實測 83 段 / 124 下,差很遠)。
             「加完是綠的」不是驗收 —— 它跟「這條斷言守不住任何東西」長得一模一樣。 */
          if (!(two(c.boxEntryHit) <= two(c.boxEntry) && two(c.boxEntryHit) < two(c.boxTouchAll))) bad++;
          /* 攻方持球的秒數 ≤ 球在禁區裡的總秒數:三段(攻/守/鬆球)是把同一段時間切開的。
             而「攻方最後碰球」那一段不可能多過三段相加 —— 它是其中的一部分。 */
          {
            const by = c.boxSecBy ?? {}, tot = (by.att ?? 0) + (by.def ?? 0) + (by.loose ?? 0);
            if (!(tot >= two(c.boxSec) - 1e-6 && (by.att ?? 0) <= tot + 1e-6)) bad++;
          }
          if (!(c.shotBox.open.n + c.shotBox.corner.n <= c.shots)) bad++;
          /* 一隊場上最多 10 個非門將的人,所以禁區裡的人數不可能超過 10。
             這一條擋的是「把兩隊算在同一邊」或「把門將算進去」這種量錯。 */
          for (const k of ['open', 'corner']) {
            const b = c.shotBox[k];
            if (b.n > 0 && !(b.att / b.n <= 10 && b.def / b.n <= 10)) bad++;
          }
          if (!(two(c.boxAttSec) <= 10 * two(c.boxSec) && two(c.boxDefSec) <= 10 * two(c.boxSec))) bad++;
        }
        check('5h 的計數器上下界都對(對齊版 ≥ 接球版、重新進來 ≤ 進出、人數 ≤ 10)',
          bad === 0, `2 場:接球 ${recv}、對齊 ${all_}、進出 ${ent}/${ent2}、秒 ${sec.toFixed(0)}、禁區內射門 ${sbn}/${shots}、越界 ${bad} 項`);
      }
      /* 數字的上下界擋不住「每一下都記」以外的接法,所以**再守一次寫法**:
         `boxEntryHit` 只准在「這一段的第一次碰球」加一,而且新的一段要把旗標放掉。
         兩個子句各自對應一個負向對照(拿掉守衛 / 拿掉重設)—— 一條斷言有幾個子句,
         就要貼幾個 bug,這是本站記過的規矩。 */
      check('「有人碰到球的那幾次」一段只記一次(有守衛,而且新的一段會重設旗標)',
        /!st\.boxHit\[p\.side\]\) \{ st\.boxHit\[p\.side\] = true; st\.boxEntryHit\[p\.side\]\+\+; \}/.test(simBareA)
        && /st\.boxHit\[side\] = false;/.test(simBareA));
      /* 掃 stdout,不是掃原始碼 —— 掃原始碼分不出「印出來」與「字串還在但永遠不執行」
         (5e 那條坑:把那一行包進 `if (0)` 的負向對照紅了 0 條)。 */
      check('check-sim **真的印出** 5h 那幾排(跑一次掃 stdout)',
        ['禁區觸球・對齊上游定義', '球越過禁區線進去(次/場)', '其中有人碰到球的',
          '球在禁區時,禁區裡平均幾個人', '禁區內射門當下・運動戰']
          .every(t => chkOut.includes(t)), `check-sim 輸出 ${chkOut.length} 字元`);
      /* **兩個「我自己量錯」的警語也要印出來。** 第一版把「球在對方禁區裡」整段當成進攻
         (其中 256 秒是守方自己在禁區裡持球),而「越過禁區線」有 60% 根本沒有人碰到球 ——
         兩個數字單獨看都像一個進攻次數,而它們都不是。不把這兩句印出來的話,
         下一個人(或我自己)會照著讀一次。 */
      check('check-sim 講出那兩個容易讀錯的地方(守方那一段不是進攻、越線不等於攻進禁區)',
        chkOut.includes('守方那一段不是進攻') && chkOut.includes('不等於足球講的「攻進禁區」'),
        `check-sim 輸出 ${chkOut.length} 字元`);
      /* **「仍然是下限」那句話是鐵則四。** 對齊之後還是少了帶球的逐下觸球,
         不講出來的話下一個人會把對齊後的倍率當成最終答案。 */
      check('check-sim 講出「對齊之後仍然是下限」(沒有帶球的逐下觸球)',
        chkOut.includes('仍然是下限') && chkOut.includes('球黏在腳下'),
        `check-sim 輸出 ${chkOut.length} 字元`);
    }

    /* 28. 階段 5i:**跟進**(2026-09-21)。5h 量到運動戰的禁區內射門當下攻方只有 1.24 人
       而角球是 4.27,所以這一節問「誰把人送進去、送不送得到」。答案是 (乙):
       **天花板 3.89 人、實際 0.97 人**,到得了卻沒到的那 2.92 人有 83% 在 `shape` 分支、
       整段只跑 2.22 m/s(= `SIM_JOG` 2.5)—— 擋住的是走位分支的速度檔,不是物理。
       這一節守的是量測本身量得對:純觀測、標籤標在分支自己身上、探針在走位迴圈**之後**、
       計數器的恆等式,以及 check-sim 真的把那幾排印出來。**不守它們的值** —— 那會漂。 */
    {
      const simBareB = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const spanOf = sig => {
        const a = simBareB.indexOf(sig);
        return a < 0 ? '' : simBareB.slice(a, simBareB.indexOf('function ', a + sig.length));
      };
      const who = spanOf('function noteBoxWho('), d2b = spanOf('function distToBox(');
      check('5i 的兩支量測函式都在,而且一個 rng( 都沒有(純觀測)',
        who.length > 0 && d2b.length > 0 && !/rng\(/.test(who) && !/rng\(/.test(d2b),
        `noteBoxWho ${who.length} 字元、distToBox ${d2b.length} 字元`);
      /* **標籤標在分支自己身上,探針不准把條件抄一遍。** 抄一遍就是「同一個量兩個來源」
         (本站的老坑):改了走位的分支,探針的歸因會悄悄過期而畫面完全正常。 */
      check('wantWhy 由走位分支自己標,探針不重算條件',
        (simBareB.match(/p\.wantWhy = '/g) ?? []).length >= 9
        && !/support\.has\(|=== presser|=== cover/.test(who),
        `分支標籤 ${(simBareB.match(/p\.wantWhy = '/g) ?? []).length} 處`);
      /* 探針要在**走位迴圈之後**叫 —— 之前叫的話讀到的是上一格的 wantWhy
         (「取值與判條件要在同一個時間點」)。直線腳本的原始碼順序就是執行順序。 */
      {
        const mv = simBareB.indexOf('movePlayer(p, dt, want);');
        const nb = simBareB.indexOf('noteBoxWho();');
        check('歸因的探針叫在走位迴圈之後(不是之前)', mv > 0 && nb > mv, `movePlayer@${mv}、noteBoxWho@${nb}`);
      }
      /* check-sim 加總 `boxFollow` 時**不准手寫鍵的清單**:第一版列了六個,引擎後來多了
         三個計數器,它們靜靜沒被加總 → 「到得了卻沒到的」印成 0.00 而旁邊的百分比有值。 */
      {
        const chkB2 = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        check('check-sim 把 boxFollow 的**每一個數值鍵**都加總,不手寫清單',
          /typeof v === 'number'/.test(chkB2) && !/\['visits', 'cand', 'near'/.test(chkB2));
      }
      {
        const SB = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        let bad = 0, vis = 0, cand = 0, ceil = 0, came = 0, miss = 0, whoTot = 0;
        for (const seed of [41, 42]) {
          const simB = SB.createSim({ profile, home: 'ARS', away: 'LIV', seed });
          for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !simB.state().over; i++) simB.advance(1 / 60);
          const f = simB.state().counts.boxFollow ?? {};
          vis += f.visits ?? 0; cand += f.cand ?? 0; ceil += f.ceil ?? 0; came += f.came ?? 0; miss += f.missN ?? 0;
          whoTot += Object.values(simB.state().counts.boxWho ?? {}).reduce((a, b) => a + b, 0);
          /* **恆等式**:到得了卻沒到的 = 天花板 − 實際到的。兩個計數器接反或漏掉一個
             這一條就會紅,而它不依賴任何會漂的值。 */
          if ((f.missN ?? 0) !== (f.ceil ?? 0) - (f.came ?? 0)) bad++;
          if (!((f.cand ?? 0) >= (f.ceil ?? 0) && (f.cand ?? 0) >= (f.near ?? 0))) bad++;
          if (!((f.ceil ?? 0) >= (f.came ?? 0))) bad++;   // 到得了的一定涵蓋真的到了的
          if (!((f.visits ?? 0) > 0 && (f.dwell ?? 0) > 0)) bad++;
        }
        check('5i 的計數器自己不矛盾(沒到 = 天花板 − 到了、候選 ⊇ 天花板 ⊇ 實際)',
          bad === 0 && whoTot > 0,
          `2 場:進攻 ${vis}、候選 ${cand}、天花板 ${ceil}、實際 ${came}、沒到 ${miss}、人-格 ${whoTot}、越界 ${bad} 項`);
      }
      check('check-sim **真的印出** 5i 那幾排(跑一次掃 stdout)',
        ['跟進:誰把攻方球員送進對方禁區', '人-格的來源(非持球者)', '直塞跑',
          '**天花板**:全速直衝到得了', '到得了卻沒到的']
          .every(t => chkOut.includes(t)), `check-sim 輸出 ${chkOut.length} 字元`);
      /* **5h 那一行的標籤修好了。** 它印的是 `sec / ent`(分母是全部越線次數),而標題
         寫著「每次碰得到球的進去,待幾秒」—— 標籤說的跟算的不是同一件事,量出來的
         1.72 秒比實際(3.63)低了一倍多。掃 stdout,不是掃原始碼。 */
      check('5h 的駐留那一行標的是它真正算的東西(分母寫出來了)',
        chkOut.includes('每次越線平均待幾秒') && chkOut.includes('含沒有人碰到球的那')
        && !chkOut.includes('每次碰得到球的進去,待幾秒'), `check-sim 輸出 ${chkOut.length} 字元`);
    }

    /* 29. 階段 5j:**「讓跟進的人用跑的」買到的是零**(2026-09-21)。5i 指名了走位分支的
       速度檔,而同一輪沒問「他們要跑去哪」——量出來那些人的陣型目標離禁區邊 **17.9 公尺**、
       只有 9% 在 3 公尺內,所以跑快只是讓他更快到一個禁區外的點(4l-2 那條坑)。
       掃 22(恆等元)/ 12 / 6 的結果寫在 `game-sim.js` 那一行的註解裡,可掃的門檻已拿掉。
       這一節守的是:① 那個否定結果**沒有被偷偷改回去**(速度檔是無條件的);
       ② 新加的 `shapeD2B` 是**量測的欄位**,引擎的行為不准讀它;
       ③ 沒有值的那幾格不准拿 0 湊數;④ check-sim 真的把那一排印出來。 */
    {
      const simBareC = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* 否定結果要守得住:速度檔**無條件**,而且那個掃完不動的門檻一個字都不准留下
         (「量出來完全不動的參數不要留著裝樣子」)。 */
      check('5j 的否定結果還在:走位的速度檔是無條件的,沒有留下那個掃不動的門檻',
        /speed: d > 22 \? SIM_RUN : d > 6 \? SIM_JOG : SIM_WALK/.test(simBareC)
        && !/FOLLOW_RUN/.test(simBareC));
      /* `shapeD2B` 跟 `LANE_FAR` / `BOX_REVISIT` 同一條規則:**量測的欄位,行為不准讀它**。
         允許的位置只有兩處 —— 走位分支裡那一行寫入,與量測函式 `noteBoxFrame` 裡的讀取。 */
      {
        const a = simBareC.indexOf('function noteBoxFrame(');
        const span = a < 0 ? null : [a, simBareC.indexOf('function ', a + 22)];
        let stray = 0, at = -1, tot = 0;
        while ((at = simBareC.indexOf('shapeD2B', at + 1)) >= 0) {
          tot++;
          const isWrite = simBareC.slice(at, at + 40).startsWith('shapeD2B = distToBox(');
          if (!isWrite && !(span && at > span[0] && at < span[1])) stray++;
        }
        check('shapeD2B 只給量測用:寫入那一行與 noteBoxFrame 以外一處都不准有',
          tot >= 2 && stray === 0, `整份 ${tot} 處、漏進行為 ${stray} 處`);
      }
      /* 沒走到走位分支的那幾格沒有 `shapeD2B`,**不可以拿 0 去湊分母** ——
         那會把平均往下拉,而 0 看起來剛好像「目標就在禁區邊上」(0 是一個很像答案的數字)。 */
      check('沒有值的那幾格不進分母(用 != null 守著,不是拿 0 湊)',
        /if \(c\.q\.shapeD2B != null\) \{ st\.boxFollow\.missTgt \+= c\.q\.shapeD2B; st\.boxFollow\.missTgtN\+\+; \}/.test(simBareC));
      check('check-sim **真的印出**「他們的陣型目標離禁區邊」那一排(跑一次掃 stdout)',
        chkOut.includes('他們的陣型目標離禁區邊') && chkOut.includes('3 公尺內的佔'),
        `check-sim 輸出 ${chkOut.length} 字元`);
    }

    /* 30. 階段 5k:**「把目標拉進禁區」人真的進去了,而買到的還是零**(2026-09-21)。
       5j 指名的槓桿是**目標**不是速度,這一輪照 `cornerSpots` 的慣例做了:持球方離對方球門
       最近的 N 個,在球進到進攻三分之一時把走位目標拉進禁區(深度與橫向對著真實的
       運動戰禁區內射門分佈挑)。恆等元 N = 0 驗過兩層(同種子 8/8 一字不差、30 場逐項相同)。
       結果:機制**確實生效**(禁區內射門當下的攻方人數 1.24 → 1.85、連守方也被盯人帶進去
       2.74 → 3.09),而**封阻一動都沒動**(2.9% → 3.1%,真實 32.0%);唯一動了的
       「射門在禁區內」換一組種子就**符號相反**(+5.8 / −3.8 pp);代價是強弱被壓縮
       (客隊進球 +2.7 / +2.8 SE,兩組種子都是)。完整的表在 `game-sim.js` 那段註解裡。
       這一節守兩件事:① 那個否定結果**沒有被偷偷改回去**(走位的目標不由禁區的幾何決定);
       ② 註解裡記的那兩個真實數字**對得回 shotmap**(鐵則一沒有「只在註解裡」這種例外)。 */
    {
      const simRawK = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const simBareK = simRawK.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* 守的是**性質**:走位分支裡對 `pos` 的每一次改寫都要是「已知的那幾處」——
         數字 4 不是寫死的門檻,它就是下面那張表的長度,加一處合法的改寫就要在這裡列出來
         (那正是要的覆核點)。這樣連「不用具名常數、直接寫 `PITCH_W - 10`」的版本也擋得住。 */
      const kA = simBareK.indexOf('let pos = shapeOf(p.slot,');
      const kE = simBareK.indexOf('const d = hypot(pos.x - p.x', kA);
      const seg5k = kA >= 0 && kE > kA ? simBareK.slice(kA, kE) : '';
      const POS_WRITES = [
        /let pos = shapeOf\(p\.slot,/,
        /pos = \{ x: s\.att > 0 \? Math\.min\(pos\.x, line\) : Math\.max\(pos\.x, line\), y: pos\.y \}/,
        /pos = \{ x: behindBall, y: pos\.y \}/,
        /pos = \{ x: cl\(m\.x \+ dx \/ d \* GOALSIDE/,
      ];
      const known = POS_WRITES.filter(re => re.test(seg5k)).length;
      const writes = (seg5k.match(/pos = /g) ?? []).length;
      check('5k 的否定結果還在:走位的目標只由陣型 / 越位 / 防守改寫,沒有「拉進禁區」那一步',
        seg5k.length > 200 && known === POS_WRITES.length && writes === POS_WRITES.length
        && !/BOX_RUN/.test(simBareK),
        `走位分支 ${seg5k.length} 字元、改寫 ${writes} 處、已知 ${known} 處`);
      /* 註解裡記的「真實深度中位 10.0 / 橫向 75 分位 10.8」是一個**宣稱**,
         鐵則一一樣管它(「註解裡的『真實約 N』是憑印象的」那條坑)。所以在這裡
         **從 shotmap 逐顆重算一次**,而且把實際值印出來 —— 容差留 1.0 / 1.5 公尺
         是給資料自然增長用的(這是會漂的量,不是人為改動才會變的紅線)。 */
      {
        const dir5k = join(ROOT, 'data', 'raw', 'fotmob-epl');
        const dep = [], lat = [];
        if (existsSync(dir5k)) {
          for (const f of readdirSync(dir5k).filter(f => /-game-details\.json$/.test(f))) {
            for (const m of Object.values(read(join(dir5k, f)).matches ?? {})) {
              for (const sh of (m.shots ?? [])) {
                if (sh.x == null || sh.y == null || sh.ownGoal) continue;
                if (sh.situation !== 'RegularPlay') continue;
                const d = 105 - sh.x, w = Math.abs(sh.y - 34);
                if (d <= 16.5 && w <= 20.16) { dep.push(d); lat.push(w); }   // 矩形判準,跟 inBoxAt 同一套
              }
            }
          }
        }
        const q = (a, pp) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length * pp)]; };
        const claimD = Number((simRawK.match(/拉到深度 ([\d.]+)/) ?? [])[1]);
        const claimW = Number((simRawK.match(/橫向夾到 ([\d.]+)/) ?? [])[1]);
        if (!existsSync(dir5k)) check('5k 註解裡的真實深度對得回 shotmap', true, '沒有 fotmob-epl 的 raw,不判');
        else check('5k 註解裡記的真實深度 / 橫向,對得回 shotmap 逐顆(容差 1.0 / 1.5 m)',
          dep.length > 500 && claimD > 0 && claimW > 0
          && Math.abs(claimD - q(dep, 0.5)) <= 1.0 && Math.abs(claimW - q(lat, 0.75)) <= 1.5,
          `${dep.length} 顆:深度中位 ${q(dep, 0.5).toFixed(2)}(註解 ${claimD})、`
          + `橫向 75 分位 ${q(lat, 0.75).toFixed(2)}(註解 ${claimW})`);
      }

    }

    /* 31. 階段 5l:**撲上去擋**(2026-09-21)。使用者把遊戲側的驗收改成
       「動畫的行為像不像踢球」(真實資料當依據 + 遊戲變數,λ 仍是硬錨),
       於是 5d 那個**對著形狀**的否定不再擋住這個動作 —— 接上去封阻 2.9% → 4.8%
       (第二組獨立種子 3.7% → 5.2%,兩組都複現),而 λ 兩組都沒被吃掉。
       這一節守四件事:① 撲的速度不准超過自己的最高速(本站的硬規則);
       ② 線畫在**球真正的飛行方向**上(5b 踩過畫成「射手 → 球門中心」);
       ③ 只撲**球還沒過去**的那一段、而且門將不在這一支(他擋的上游記成撲救);
       ④ 診斷是純觀測(一個 rng 都沒有),而且 check-sim 真的把它印出來。 */
    {
      const simRawL = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const simBareL = simRawL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const a = simBareL.indexOf('function lanePoint(');
      const lp = a >= 0 ? simBareL.slice(a, simBareL.indexOf('function ', a + 20)) : '';
      check('撲球的目標點畫在球**真正的飛行方向**上(不是射手 → 球門中心)',
        /ball\.vx \/ sp/.test(lp) && /ball\.vy \/ sp/.test(lp) && !/PITCH_H \/ 2/.test(lp),
        `lanePoint ${lp.length} 字元`);
      check('只撲球還沒過去的那一段(背後的球擋不到),而且離線太遠的不撲',
        /if \(along <= 0\) return null;/.test(lp) && /if \(perp > BLOCK_REACH\) return null;/.test(lp));
      /* 速度是 `p.vmax` —— 本站沒有撲救式的撲倒,任何人任何時候都不准超過自己的最高速。
         這一條**不是**在守某個寫法,是在守那條硬規則:撲球那一支給的速度不可以是別的東西。 */
      {
        const i = simBareL.indexOf("p.wantWhy = 'block';");
        const seg = i >= 0 ? simBareL.slice(i, i + 200) : '';
        check('撲球的速度是自己的最高速,沒有偷偷加速', /speed: p\.vmax \}/.test(seg), `切出來 ${seg.length} 字元`);
      }
      check('門將不在撲球那一支(他擋掉的上游記成撲救,不是封阻)',
        /p\.role !== 'GK' && !p\.off/.test(simBareL.slice(simBareL.indexOf('const lunge ='), simBareL.indexOf('const lunge =') + 260)));
      /* 診斷跟 5h / 5i 的量測同一條規矩:純觀測,一個 rng 都不准有。 */
      {
        const b2 = simBareL.indexOf('function noteShotChase(');
        const seg = b2 >= 0 ? simBareL.slice(b2, simBareL.indexOf('function ', b2 + 24)) : '';
        check('撲球的診斷是純觀測(noteShotChase 裡一個 rng( 都沒有)',
          seg.length > 200 && !/rng\(/.test(seg), `noteShotChase ${seg.length} 字元`);
      }
      check('check-sim **真的印出**撲球那一排(跑一次掃 stdout)',
        chkOut.includes('撲球:一腳射門有幾個人撲') && chkOut.includes('整段飛行最近的防守者離飛行線'),
        `check-sim 輸出 ${chkOut.length} 字元`);
      /* 畫面上那段說明**不准再說撲搶被否定了** —— 那是本站記過五次的坑
         (加了能力之後要回頭問:有哪一頁還在講我們沒有它)。 */
      {
        const view = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-view.js'), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        /* 2026-09-25(階段 5n)起這段也講逼搶者站門側;「最近的防守者離球的路線 5.7 公尺」那句
           是 5n 之前的量測,改成跟 StatsBomb 並排的講法(第 36 節守它不再說「所以現在沒有做」)。 */
        check('統計面板不再寫「撲搶被否定」,而是講現在的行為與它的界線',
          /撲上去擋/.test(view) && !/量過六輪/.test(view) && /StatsBomb/.test(view));
      }
    }

    /* 32. 階段 5m:**跑動**(2026-09-21)。使用者「跑動先做」。
       這一節守的是**量法**,不是那幾個會漂的數字:
       ① 錨是「外場一個位置」((球隊總計 − 門將) ÷ 10),不是 `distancePerMin ÷ 11`
          —— 後者的分子含門將與替補,拿去比十個外場球員低 4.8%;
       ② 側寫的兩個累加器走**同一批場次**(`gkGames ≤ games`),而且修正的**方向**要對;
       ③ 衝刺那兩個錨(側寫裡有而三個月沒人讀)**真的印出來**,掃 stdout 不是掃原始碼;
       ④ **逐分支的歸因加起來要等於球員真的跑掉的距離** —— 第一版漏掉死球那兩支,
          合計 119 對錨的 129,而剩下幾類的百分比看起來完全正常。
          這一條是**數值**的,下一個人再加一支分支而忘了記,它就會紅;
       ⑤ 相位的累加要求**相位跟上一格一樣**(沒有它,「鬆球」那一列會印出 ×2.6,
          而鬆球時兩道夾都不生效、夾前夾後必須相同 —— 我差一點照它寫下錯的根因);
       ⑥ 兩道走位的夾看的是 `shapeSide`(傳球在路上時沿用傳球方),不是 `ball.holder`;
       ⑦ `SPRINT_V` / `SPRINT_T` 是**量測的邊界**,引擎的行為不准讀(跟 `LANE_FAR` 同一條)。 */
    {
      const simRawM = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const simBareM = simRawM.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const chkBareM = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('跑動的錨用「外場一個位置」(outfieldPerMin),不是球隊總計 ÷ 11',
        /outfieldPerMin/.test(chkBareM) && !/distancePerMin\s*\/\s*11/.test(chkBareM));
      {
        const withPace = Object.values(profile.teams).filter(t => t.pace);
        const bad = withPace.filter(t => t.pace.outfieldPerMin == null || t.pace.gkGames > t.pace.games
          || !(t.pace.outfieldPerMin > t.pace.distancePerMin / 11));
        check('側寫每隊都有外場跑動,兩個累加器同一批,而且方向是「比 ÷11 高」',
          withPace.length >= 20 && bad.length === 0,
          bad.map(t => t.code).join('、') || `${withPace.length} 隊都通過`);
      }
      check('check-sim **真的印出**衝刺那兩個錨(側寫裡有而三個月沒人讀)',
        chkOut.includes('衝刺次數(兩隊合計)') && chkOut.includes('衝刺距離(兩隊合計)')
        && chkOut.includes('跑動的來源'), `check-sim 輸出 ${chkOut.length} 字元`);
      {
        const b3 = simBareM.indexOf('function noteRun(');
        const segR = b3 >= 0 ? simBareM.slice(b3, simBareM.indexOf('function ', b3 + 18)) : '';
        check('跑動的歸因是純觀測(noteRun 裡一個 rng( 都沒有)',
          segR.length > 300 && !/rng\(/.test(segR), `noteRun ${segR.length} 字元`);
        /* **這一條第一版守不住任何東西**(2026-09-21 的負向對照抓到的):錨寫成
           `/p\.tgtPhaseOk/`,而 `noteRun` 裡它出現**兩次** —— 跳躍那個計數器用的是
           `!p.tgtPhaseOk`。把相位累加的 `&& p.tgtPhaseOk` 整個拿掉,另一處照樣命中,
           斷言照樣綠。錨要挑**只在被守的那一份出現**的東西(本站記過這條,而我又犯了)。
           兩個子句各自釘死,而且各有一個負向對照(b5 拿掉累加的守衛、b5b 把 contPh 放寬)。 */
        check('相位的累加要求相位跟上一格一樣(否則量到的是換手那一格的跳躍)',
          /if \(p\.tgt0Move != null && p\.tgtPhaseOk\)/.test(segR)
          && /contPh = cont && p\.tgtPhase === ph0/.test(simBareM));
      }
      check('兩道走位的夾看 shapeSide(傳球在路上沿用傳球方),不是 ball.holder',
        /const shapeSide = holder \? holder\.side : \(\(SHAPE_PASS_KEEP && ball\.passSide\) \|\| null\)/.test(simBareM)
        && /if \(shapeSide === p\.side && p\.role !== 'GK'\)/.test(simBareM)
        && /if \(shapeSide && shapeSide !== p\.side\)/.test(simBareM)
        && !/if \(holder && holder\.side [!=]== p\.side/.test(simBareM));
      /* `SPRINT_V` / `SPRINT_T` 跟 `LANE_FAR` 同一條:量測的邊界,引擎的行為不准讀。
         **範圍自己算出來**(宣告那一行 + `noteRun` 的起訖),寫死行號的話下一輪又會紅在「行為沒變」。 */
      {
        const a3 = simBareM.indexOf('function noteRun(');
        const span = a3 < 0 ? null : [a3, simBareM.indexOf('function ', a3 + 18)];
        let stray = 0, tot = 0;
        for (const name of ['SPRINT_V', 'SPRINT_T']) {
          let at = -1;
          while ((at = simBareM.indexOf(name, at + 1)) >= 0) {
            tot++;
            const isDecl = simBareM.slice(Math.max(0, at - 6), at) === 'const ';
            if (!isDecl && !(span && at > span[0] && at < span[1])) stray++;
          }
        }
        check('SPRINT_V / SPRINT_T 只給量測用:宣告與 noteRun 以外一處都不准有',
          span && span[1] > span[0] && tot >= 4 && stray === 0, `整份 ${tot} 處、漏進行為 ${stray} 處`);
      }
      /* **加起來要等於真的跑掉的距離。** 掃原始碼守不住這一條 —— 漏掉一整類的症狀是
         「剩下幾類的百分比看起來完全正常」,只有拿總和對一次才看得出來。 */
      {
        const SM = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        const simM = SM.createSim({ profile, home: 'ARS', away: 'LIV', seed: 5 });
        for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !simM.state().over; i++) simM.advance(1 / 60);
        const run = simM.state().counts.run ?? {};
        const why = Object.values(run.why ?? {}).reduce((a, b) => a + b, 0);
        const role = Object.values(run.role ?? {}).reduce((a, b) => a + b, 0);
        const real = simM.motion().players.filter(q => q.role !== 'GK').reduce((a, q) => a + q.dist, 0);
        const rel = real > 0 ? Math.abs(why - real) / real : 1;
        check('逐分支與逐位置的歸因加起來 = 外場球員真的跑掉的距離(漏一整類就會紅)',
          real > 50000 && rel < 0.005 && Math.abs(role - why) / Math.max(1, why) < 0.005,
          `分支 ${why.toFixed(0)} / 位置 ${role.toFixed(0)} / 實際 ${real.toFixed(0)} m,差 ${(100 * rel).toFixed(2)}%`);
        check('衝刺有數到(≥ 7 m/s 持續 ≥ 1 秒),而且 1 秒門檻真的在做事',
          (run.sprints?.home ?? 0) + (run.sprints?.away ?? 0) > 0
          && (run.sprintDistAll?.home ?? 0) > (run.sprintDist?.home ?? 0),
          `一場 ${(run.sprints?.home ?? 0) + (run.sprints?.away ?? 0)} 次`);
      }
    }

    /* 33. 階段 5o:**第二組獨立種子也走 `check-sim`**(2026-09-22)。
       本站每一輪的驗收都要「兩組獨立種子都複現」(5k / 5l / 5m 都是這樣收的),
       而在這之前第二組一律是另外寫一支 scratch harness 去跑 —— 那是
       「同一個量兩個來源」:兩支各算一次,公式改了會有一份悄悄過期
       (5m 的跑動錨就是在 harness 那一份上漏掉門將的)。
       守兩件事,而且是**相反的方向**:
       ① 種子真的可以位移(`--seed0`),不然第二組還是得另外寫一支;
       ② **不給旗標時第一場仍然是種子 1** —— 預設一漂,先前每一輪的紀錄就對不回來了,
          而那種錯是靜的(數字全都變了,而看起來只是「引擎又動了」)。

       **負向對照(2026-09-22,四個 bug 各跑一次)** —— 驗收是「紅了 N 條而且是**對應的**那幾條」:
         b1 旗標改名 `--from=`      → 紅 2(①的子句一 + ②:旗標不管用了,帶旗標仍是種子 1)
         b2 場數改回 `argv[2]`      → 紅 2(①的子句二 + ②)
         b3 迴圈寫死 `seed = 1`     → **紅 1(只有①)** —— ②看不到迴圈,如預期
         b4 預設改成 `?? '1001'`    → **紅 1(只有②)** —— 如預期
       b3 / b4 是乾淨的一對一,所以這兩條**各自守得住自己那件事**。
       b1 / b2 會同時紅兩條:那不是巧合,旗標名字或參數解析壞掉時「位移」本來就不成立,
       所以②在這兩個 bug 上**不是獨立的證據**(蘊含關係要寫出來,不然下一個人會當成兩道保險)。
       一個誠實的但書:b2 那一輪②之所以紅,有一部分是對照台的假象 —— 這條斷言把
       `process.argv.slice(2)` 換成自己的 argv 再求值,而 b2 把它改成了 `process.argv[2]`,
       換不到,於是讀到真的行程參數。**真正抓到 b2 的是①的子句二**(正則直接掃那個寫法)。 */
    {
      const chkBareS = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('check-sim 收得了 --seed0,而且場數不會被旗標吃掉',
        /--seed0=/.test(chkBareS) && /find\(a => !a\.startsWith\('--'\)\)/.test(chkBareS)
        && /for \(let seed = SEED0; seed < SEED0 \+ RUNS; seed\+\+\)/.test(chkBareS));
      /* **把它自己那兩行解析式抓出來真的算一次**,不要掃 `?? '1'` 這個字面 ——
         字面搬到別的運算式裡照樣綠。負向對照:把預設改成 '1001' 這一條會紅。 */
      {
        const decl = chkBareS.match(/^const (?:RUNS|SEED0) = .*$/gm) ?? [];
        const run = argv => {
          const fn = new Function('argv', decl.map(d => d.replace(/process\.argv\.slice\(2\)/g, 'argv'))
            .join('\n') + '\nreturn [RUNS, SEED0];');
          return fn(argv);
        };
        const [r0, s0] = run([]), [r1, s1] = run(['30', '--seed0=1001']), [r2, s2] = run(['--seed0=1001']);
        check('沒給 --seed0 的時候第一場還是種子 1(先前每一輪的紀錄才對得回來)',
          s0 === 1 && s1 === 1001 && r1 === 30 && s2 === 1001 && r2 === 12 && r0 === 12,
          `預設 ${r0} 場 / 種子 ${s0};帶旗標 ${r1} 場 / 種子 ${s1};只帶旗標 ${r2} 場 / 種子 ${s2}`);
      }
    }

    /* 34. 階段 5p:**人堆值多少封阻**(2026-09-24)。5o-3 登記「角球有排好的站位而運動戰沒有」
       是封阻唯一沒被否定的路,動手蓋之前先量兩個上限 —— 引擎自己的角球(人堆做到滿),
       與真實的角球 vs 運動戰(人堆在真實世界值多少)。守四件事:
       ① check-sim **真的印出**那幾排(掃 stdout,5e 那條坑:掃原始碼分不出印與不印);
       ② `shotCrowd` 與 `shotBox` 是**同一個呼叫點**記的,兩種情境的腳數要一模一樣 ——
          哪天有人只搬了其中一個,分桶就跟 5h 的人數不同批,而兩邊看起來都對;
       ③ 真實那一側的切法跟引擎一樣:禁區內、**十二碼不算**、角球 vs 其他;
       ④ 頭腳真的有拆,而且兩邊都有樣本(角球射門一半是頭球,混在一起比會把人堆的效果算錯)。

       **負向對照(2026-09-24,五個 bug 各跑一次)** —— 驗收是「紅了 N 條而且是**對應的**那幾條」:
         b1 印出那段包進 `if (0)`        → 紅 2(①+②)—— ②讀的就是那一行,**不是獨立的證據**
         b2 真實那一份頭腳不拆            → **紅 1(只有②)**,訊息印出「頭球 —」
         b3 引擎只記運動戰、不記角球      → **紅 1(只有③)**,訊息印出「角球 0 / 2」
         b4 真實那一側把十二碼算進來      → **紅 1(只有④ 的第一個子句)**
         b5 真實那一側拿 SetPiece 當角球  → **紅 1(只有④ 的第二個子句)**
       一條斷言有幾個子句就貼幾個 bug(④有兩個,所以 b4 / b5 各打一個)。 */
    {
      check('check-sim **真的印出**人堆那幾排(引擎曝光 / 封阻 + 同一個切法的真實封阻)',
        ['人堆・運動戰', '曝光依守方人數', '真實封阻', '人堆做到滿'].every(t => chkOut.includes(t)),
        `check-sim 輸出 ${chkOut.length} 字元`);
      check('真實那一份頭腳都拆了,而且都有樣本(不是「—」)',
        /真實封阻 [0-9.]+%\(腳下 [0-9.]+%・頭球 [0-9.]+%/.test(chkOut) && !/腳下 —|頭球 —/.test(chkOut),
        (chkOut.match(/真實封阻 [^,]*/) ?? ['(找不到)'])[0]);
      {
        const SM = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
        const sim = SM.createSim({ profile, home: 'ARS', away: 'LIV', seed: 3, pred: { xgHome: 1.99, xgAway: 0.70 } });
        for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !sim.state().over; i++) sim.advance(1 / 60);
        const c = sim.state().counts, sum = a => a.reduce((x, y) => x + y, 0);
        const on = sum(c.shotCrowd?.open?.n ?? []), cn = sum(c.shotCrowd?.corner?.n ?? []);
        check('shotCrowd 跟 shotBox 同一批:兩種情境的腳數一模一樣(同一個呼叫點記的)',
          on === c.shotBox.open.n && cn === c.shotBox.corner.n && on > 0,
          `運動戰 ${on} / ${c.shotBox.open.n}・角球 ${cn} / ${c.shotBox.corner.n}`);
      }
      const chkBareP = readFileSync(join(ROOT, 'scripts', 'game', 'check-sim.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('真實那一側跟引擎同一個切法:禁區內、十二碼不算、角球 vs 其他',
        /sh\.inBox && sh\.situation !== 'Penalty'/.test(chkBareP)
        && /boxBlk\[sh\.situation === 'FromCorner' \? 'corner' : 'open'\]/.test(chkBareP));
    }

    /* 35. 階段 5q:**射手被逼住**(2026-09-24)。5p 登記「真實世界沒有追蹤座標,所以沒有真值」——
       StatsBomb 的 freeze frame 就是那個真值(`data/raw/statsbomb/`,只存分箱計數)。守五件事:
       ① check-sim **真的印出**那幾排,而且真實那一側有數字(掃 stdout);
       ② 引擎的分箱跟真值檔**逐字相同** —— 兩邊各自改一個邊界的話,並排的每一格都是錯的而看起來都對;
       ③ `shotPress` 跟 `shotCrowd` 是同一個呼叫點記的:腳數與封阻數一模一樣,每一組分箱加起來等於它的母體;
       ④ 真值檔標明出處與授權(StatsBomb 開放資料是非商業使用、要標明來源),而且**只有分箱計數**;
       ⑤ `notePress` 是純計數:不呼叫 rng(呼叫的話同一個種子就不是同一場比賽)。

       **負向對照(2026-09-24,五個 bug 各跑一次整份 test-game)** —— 驗收是「紅了 N 條而且是**對應的**那幾條」:
         b1 check-sim 印的那段包進 `if (0)`                 → **紅 1(只有①)**,訊息印「找不到」
         b2 引擎的 near 邊界 5 改成 6                      → **紅 1(只有②)**
         b3 角球那一側不記 `r.n++`                         → **紅 1(只有③)**,角球腳數 0 ≠ 2
         b4 真值檔 source 裡兩個 StatsBomb 都拿掉          → **紅 1(只有④)**(網址裡的小寫 statsbomb 還在)
         b5 notePress 裡多一個短路不執行的 `rng()`          → **紅 1(只有⑤)**
       b1 與 b4 第一次是「沒命中」:b1 的錨是後來重構掉的那一行、b4 只拿掉了兩個 StatsBomb 的其中一個 ——
       打 bug 的腳本自己沒打中,harness 照設計大聲跳過;改好之後重跑才是上面那兩行。 */
    {
      check('check-sim **真的印出**射手被逼住那幾排,而且真實那一側有數字',
        ['射手被逼住・禁區內運動戰腳下', '最近的防守者', '路上有人(真飛行線', '三角形裡的人數', '接球到射門', '接球點到射門點', '資料來源:StatsBomb']
          .every(t => chkOut.includes(t))
        && /最近的防守者[^\n]*真實 \d+\/\d+\/\d+\/\d+\/\d+%/.test(chkOut),
        (chkOut.match(/最近的防守者 <[^\n]*/) ?? ['(找不到)'])[0]);
      const SM = await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')));
      const sbFile = join(ROOT, 'data', 'raw', 'statsbomb', 'pl-2015-16-shot-pressure.json');
      const sb = existsSync(sbFile) ? JSON.parse(readFileSync(sbFile, 'utf8')) : null;
      const deflectR = Number((readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8').match(/const DEFLECT_R = ([0-9.]+)/) ?? [])[1]);
      check('引擎的分箱跟真值檔逐字相同,「路上有人」的半徑也是同一個(兩邊各改一個的話,並排的每一格都錯)',
        !!sb && JSON.stringify(SM.PRESS_BINS) === JSON.stringify(sb.bins) && sb.laneR === deflectR,
        `引擎 ${JSON.stringify(SM.PRESS_BINS)} / DEFLECT_R ${deflectR}・真值 ${JSON.stringify(sb?.bins)} / ${sb?.laneR}`);
      {
        const sim = SM.createSim({ profile, home: 'ARS', away: 'LIV', seed: 3, pred: { xgHome: 1.99, xgAway: 0.70 } });
        for (let i = 0, N = Math.round(110 * 60 * 60); i < N && !sim.state().over; i++) sim.advance(1 / 60);
        const c = sim.state().counts, sum = a => a.reduce((x, y) => x + y, 0);
        const P = c.shotPress ?? {}, bad = [];
        for (const sit of ['open', 'corner']) {
          const n = (P[sit]?.foot?.n ?? 0) + (P[sit]?.head?.n ?? 0), blk = (P[sit]?.foot?.blk ?? 0) + (P[sit]?.head?.blk ?? 0);
          if (n !== sum(c.shotCrowd[sit].n)) bad.push(`${sit} 腳數 ${n} ≠ ${sum(c.shotCrowd[sit].n)}`);
          if (blk !== sum(c.shotCrowd[sit].blk)) bad.push(`${sit} 封阻 ${blk} ≠ ${sum(c.shotCrowd[sit].blk)}`);
          for (const body of ['foot', 'head']) {
            const r = P[sit]?.[body]; if (!r) { bad.push(`${sit}.${body} 不在`); continue; }
            for (const [k, tot] of [['near', r.n], ['ang', r.n], ['cone', r.n], ['recv', r.recvN], ['carry', r.carryN], ['blockAt', r.blk]])
              if (sum(r[k]) !== tot) bad.push(`${sit}.${body}.${k} ${sum(r[k])} ≠ ${tot}`);
            if (body === 'head' && r.recvN !== 0) bad.push(`${sit}.head 記了接球(頭球沒有接球)`);
            if (r.laneN !== r.n || r.laneExp > r.laneN || r.laneExpBlk > Math.min(r.laneExp, r.blk)) bad.push(`${sit}.${body} 路上有人 ${r.laneExpBlk}/${r.laneExp}/${r.laneN}(n ${r.n}・封阻 ${r.blk})`);
          }
        }
        check('shotPress 跟 shotCrowd 同一批(腳數 / 封阻數一樣),每一組分箱加起來等於它的母體',
          bad.length === 0 && (P.open?.foot?.n ?? 0) > 0, bad.join('・') || `運動戰腳下 ${P.open?.foot?.n} 腳`);
      }
      check('真值檔標明出處與授權,而且只有分箱計數(不存逐腳的座標)',
        !!sb && /StatsBomb/.test(sb.source) && /非商業/.test(sb.source)
        && ['open', 'corner'].every(s => ['foot', 'head'].every(b => Object.values(sb[s][b]).every(v => typeof v === 'number' || (Array.isArray(v) && v.every(x => typeof x === 'number'))))),
        sb ? sb.source : '真值檔不在');
      {
        const simSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
        const a = simSrc.indexOf('function notePress('), b = simSrc.indexOf('\n  }\n', a);
        const body = a > 0 && b > a ? simSrc.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') : '';
        check('notePress 是純計數:不呼叫 rng', body.length > 200 && !/\brng\(/.test(body), `切出 ${body.length} 字元`);
      }
    }

    /* 36. 階段 5n:**逼搶者站門側、跟得上**(2026-09-25;使用者:「做阻擋要看得見」)。
       量出來的機制:射門前那段持球裡,門側的逼搶者離開門側 197 / 198 次(第二組 200 / 201)
       是**同一個人被帶過去** —— 他照速度檔在 6 m 內慢跑,持球者 6.6~7.1 m/s。
       改兩件事(目標在持球者與自家球門之間、目標跟著持球者的速度走,上限是跑不是衝刺),
       再把射門的壓力倍率與幾個常數重新校準(數字與驗收見 `PRESS_TRACK` 與變更紀錄)。
       這一節守的是**寫法與恆等元**,不守那幾個會漂的數字(那些 `check-sim` 每次都印):
       ① **`PRESS_TRACK = 0` 是恆等元**:跟「把新那一支與 movePlayer 的會動目標整段拿掉」逐場相同;
       ② 拿掉的對照版真的不一樣(不然①在比兩份相同的程式),而且現行版本跟 0 不一樣(那一支是活的);
       ③ 會動的目標**只給逼搶者**:補位者也跟上的版本量過會把弱隊壓垮(30 場客隊 0.17 球),
          誰要加第二個使用者得先重量 λ;
       ④ 射門的壓力倍率是讀得出來的常數、只在扣扳機那一行用,寫死的 0.55 不准回來
          (拿 StatsBomb 的分佈對過:懲罰只會把「被逼住才射」的比例推離真實)。
       負向對照(2026-09-25,八個 bug 各一份影子目錄,結果表在變更紀錄 5n 第六節):
       每個 bug 只紅它對應的那一條。 */
    {
      const simRawN = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-sim.js'), 'utf8');
      const loadN = async s => import('data:text/javascript;base64,' + Buffer.from(s, 'utf8').toString('base64'));
      const trackRaw = (simRawN.match(/^const PRESS_TRACK = ([A-Za-z_0-9.]+);/m) ?? [])[1];
      check('PRESS_TRACK 是一個讀得出來的常數,而且現在是開的', trackRaw != null && trackRaw !== '0', `PRESS_TRACK = ${trackRaw}`);
      const zeroed = simRawN.replace(/^const PRESS_TRACK = [A-Za-z_0-9.]+;/m, 'const PRESS_TRACK = 0;');
      /* 「整段拿掉」:逼搶那一支只留舊的寫法,movePlayer 的會動目標那一段刪掉、加速度那一行換回原樣。
         錨挑在**新程式自己才有**的字串上 —— 負向對照打壞恆等元最自然的寫法是去改舊那一支,
         錨要是挑在舊那一支上,剝除會靜靜沒命中(STAM_FADE 那一條記過)。 */
      const S0 = '        if (PRESS_TRACK > 0) {\n', MID = '        } else {\n', END = '        }\n      } else if (p === cover) {';
      const i0 = zeroed.indexOf(S0), i1 = zeroed.indexOf(MID, i0), i2 = zeroed.indexOf(END, i1);
      let stripped = i0 > 0 && i1 > i0 && i2 > i1
        ? zeroed.slice(0, i0) + zeroed.slice(i1 + MID.length, i2) + '      } else if (p === cover) {' + zeroed.slice(i2 + END.length)
        : zeroed;
      const m0 = stripped.indexOf('  if (want.tvx != null) {'), m1 = stripped.indexOf('  const ex = wantVx - p.vx', m0);
      stripped = m0 > 0 && m1 > m0 ? stripped.slice(0, m0) + stripped.slice(m1) : stripped;
      stripped = stripped.replace('const a = ((want.tvx != null ? hypot(wantVx, wantVy) : target) < sp ? SIM_DECEL : SIM_ACCEL) * dt;',
        'const a = (target < sp ? SIM_DECEL : SIM_ACCEL) * dt;');
      /* 「剝乾淨了沒」要看**剝掉註解之後**的程式 —— 註解裡本來就在講 `want.tvx`(第一版就紅在自己的註解上)。
         新那一支只認它自己的開頭 `if (PRESS_TRACK > 0) {`:第一版寫「整份都不准有 `PRESS_TRACK > 0`」,
         負向對照 b3(補位那一行也用同一個開關)就多紅在這一條 —— 那是斷言比它要守的範圍寬。 */
      const strippedBare = stripped.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('拿掉新那一支的對照版真的不一樣了(三處都剝到;不然下一條在比兩份相同的程式)',
        i0 > 0 && i1 > i0 && i2 > i1 && m0 > 0 && m1 > m0 && !/want\.tvx/.test(strippedBare) && !/if \(PRESS_TRACK > 0\) \{/.test(strippedBare)
        && stripped !== zeroed && zeroed !== simRawN,
        `剝除點 ${i0} / ${i1} / ${i2}・movePlayer ${m0} / ${m1}`);
      const [Z, X, C] = [await loadN(zeroed), await loadN(stripped),
        await import(pathToFileURL(join(ROOT, 'web', 'assets', 'js', 'game-sim.js')))];
      const STEPN = 1 / 60, MINS = 20;
      const fp = (M, seed) => {
        const s = M.createSim({ profile, home: 'ARS', away: 'LIV', seed, pred });
        for (let i = 0; i < Math.round(MINS * 60 / STEPN) && !s.state().over; i++) s.advance(STEPN);
        const c = s.state();
        const pos = c.players.reduce((a, q) => a + q.x * 3 + q.y, 0).toFixed(6);
        return `${c.score[0]}-${c.score[1]}/${c.counts.shots}/${c.counts.passes}/${c.counts.fouls.home + c.counts.fouls.away}/${pos}`;
      };
      const seedsN = [1, 2];
      let same = 0;
      for (const sd of seedsN) if (fp(Z, sd) === fp(X, sd)) same++;
      check(`PRESS_TRACK = 0 是恆等元(跟「整段拿掉」逐場相同:${MINS} 分鐘的比分 / 射門 / 傳球 / 犯規 / 二十二人的位置)`,
        same === seedsN.length, `${same} / ${seedsN.length} 場相同`);
      check('現行的版本跟 PRESS_TRACK = 0 不一樣(新那一支是活的,不是寫了沒跑)', fp(C, 1) !== fp(Z, 1));
      /* ③ 會動的目標只給逼搶者。先剝註解(註解裡本來就在講 tvx),再看每一個落在哪裡。
         **不數出現次數**(加一處就紅在「多了一個」),只問每一處在不在它該在的地方。 */
      const bareN = simRawN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const p0 = bareN.indexOf('} else if (p === presser) {'), p1 = bareN.indexOf('} else if (p === cover) {', p0);
      const mv0 = bareN.indexOf('function movePlayer('), mv1 = bareN.indexOf('function moveBall(', mv0);
      let strayT = 0, inPressT = 0, at = -1;
      while ((at = bareN.indexOf('tvx', at + 1)) >= 0) {
        if (at > p0 && at < p1) inPressT++;
        else if (!(at > mv0 && at < mv1)) strayT++;
      }
      check('會動的目標只給逼搶者(tvx 只出現在逼搶那一支與 movePlayer;補位者也跟上會把弱隊壓垮)',
        p0 > 0 && p1 > p0 && mv0 > 0 && mv1 > mv0 && inPressT > 0 && strayT === 0, `逼搶那一支 ${inPressT} 處・漏出去 ${strayT} 處`);
      /* ④ 射門的壓力倍率 */
      const spN = Number((simRawN.match(/^const SHOT_PRESSED = ([0-9.]+);/m) ?? [])[1]);
      let strayP = 0; at = -1;
      while ((at = bareN.indexOf('SHOT_PRESSED', at + 1)) >= 0) {
        const decl = /^const SHOT_PRESSED = /.test(bareN.slice(at - 6, at + 20));
        const urge = /pressure < 3 \? SHOT_PRESSED : 1/.test(bareN.slice(Math.max(0, at - 20), at + 20));
        if (!decl && !urge) strayP++;
      }
      check('射門的壓力倍率是讀得出來的常數、只在扣扳機那一行用,寫死的 0.55 沒有回來',
        Number.isFinite(spN) && spN >= 0 && spN <= 1 && /pressure < 3 \? SHOT_PRESSED : 1/.test(bareN) && strayP === 0
        && !/pressure < 3 \? 0\.\d+/.test(bareN),
        `SHOT_PRESSED = ${spN}・漏出去 ${strayP} 處`);
      /* ⑤ 畫面上那段說明**不准再說「站到門側會壓平強弱,所以沒有做」** —— 做了(本站記過好幾次的坑:
         加了能力之後要回頭問,有哪一句還在講我們沒有它)。剝註解再掃,註解裡本來就在講那句話。 */
      {
        const viewN = readFileSync(join(ROOT, 'web', 'assets', 'js', 'game-view.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        check('統計面板講逼搶者站門側、跟著退,而且不再說「所以現在沒有做」',
          /站在持球者與自家球門之間/.test(viewN) && !/所以現在沒有做/.test(viewN) && !/在射門之前<\/b>就站進球門那一側/.test(viewN));
      }
    }
    }
  }
}
