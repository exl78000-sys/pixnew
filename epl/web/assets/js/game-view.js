import * as C from './core.js?v=9dd1d118';
import { blendPair, inPlaySim, seededRng } from './predict-core.js?v=a99cd006';
import { mountDuelAnim } from './duel-anim.js?v=9024ec0a';
import { createMatch, defaultSetup } from './game-engine.js?v=b48e4aa3';

/* 模擬遊玩(2026-09-03,取代對戰模擬)。FM24 2D classic 的配置:記分板、球場、右側四個分頁
   (比賽統計 / 事件流 / 陣容與換人 / 戰術)、下方勝率條 + 動能條 + 文字播報。
 *
 * **這是遊戲,不是本站的預測。** 跟真實管線的關係只有一條:沒有任何改動時 λ_game = 站上的 λ
 * (game-engine.js 檔頭;測試守著)。使用者換人、改先發之後才會偏離。
 * 所有操作只存在這一頁的記憶體裡,不進資料、不進 vault。
 * 只開英超 —— 明確清單 GAME_LEAGUES,不用「不是某聯賽就開」的二元式(league() 那條坑)。 */
export const GAME_LEAGUES = ['pl'];

const SPEEDS = { slow: 320, normal: 160, fast: 60 };
const NOTABLE = new Set(['goal', 'card', 'sub', 'half', 'full']);
const SIT_ZH = { RegularPlay: '運動戰', FromCorner: '角球', FastBreak: '快攻', FreeKick: '任意球', SetPiece: '定位球', ThrowInSetPiece: '界外球', IndividualPlay: '個人突破', Penalty: '十二碼', OwnGoal: '烏龍球' };
const OUT_ZH = { saved: '被撲出', blocked: '被封阻', off: '射偏', post: '中柱' };
const POS_ZH = { GK: '門將', DEF: '後衛', MID: '中場', FWD: '前鋒' };

export async function renderGame(app) {
  try {
    const lg = C.league();
    if (!GAME_LEAGUES.includes(lg)) {
      app.innerHTML = `<h1>模擬遊玩</h1><div class="note">模擬遊玩目前只有英超。西甲少了推估先發、主罰與球員牌數,英冠沒有球員資料 ——
        不是還沒接,是這幾樣目前沒有來源。<a href="${C.link('explore', { view: 'duel', league: 'pl' })}">切到英超玩</a></div>`;
      return;
    }
    const { data, absent } = await C.loadFrom('pl', ['meta', 'teams', 'game/pl']);
    const profile = data['game/pl'];
    if (!profile || absent.includes('game/pl')) throw new Error('沒有模擬遊玩的側寫(先跑 npm run game:build)');
    const sim = data.meta?.model?.sim;
    const teams = data.teams.filter(t => sim?.teams?.[t.code] && profile.teams[t.code]).sort((a, b) => a.en.localeCompare(b.en));
    const teamBy = new Map(teams.map(t => [t.code, t]));
    const eloBy = new Map(teams.map(t => [t.code, t.elo]));
    const crest = code => (teamBy.get(code)?.crest ? `<img class="crest" src="${teamBy.get(code).crest}" alt="" width="26" height="26">` : '');
    const nameOf = code => teamBy.get(code)?.zh ?? teamBy.get(code)?.en ?? code;
    const HIDE = `onerror="this.style.display='none'"`;

    const state = { home: teams[0]?.code, away: teams[1]?.code, neutral: false, seed: Math.floor(Math.random() * 1e9),
      setup: { home: null, away: null }, speed: 'normal', highlights: false };
    const setupOf = side => (state.setup[side] ??= defaultSetup(profile, state[side]));
    const squadOf = side => new Map(profile.teams[state[side]].squad.map(p => [p.code, p]));

    let match = null, anim = null, timer = null, paused = false, tab = 'stats';
    let running = false;

    const predOf = () => blendPair(sim, state.home, state.away, eloBy.get(state.home), eloBy.get(state.away), { neutral: state.neutral });

    /* ── 賽前:選隊、預覽 ─────────────────────────── */
    function renderControls() {
      const host = document.getElementById('gameBody');
      const sel = (id, cur) => `<select id="${id}">${teams.map(t => `<option value="${t.code}"${t.code === cur ? ' selected' : ''}>${C.esc(t.zh ?? t.en)}</option>`).join('')}</select>`;
      host.innerHTML = `
        <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
          <span class="small">主隊 ${sel('gHome', state.home)}</span>
          <button class="btn" id="gSwap" title="交換主客">⇄</button>
          <span class="small">客隊 ${sel('gAway', state.away)}</span>
          <label class="small" style="margin-left:8px"><input type="checkbox" id="gNeutral"${state.neutral ? ' checked' : ''}> 中立場</label>
        </div>
        <div id="gPred" style="margin-top:12px"></div>
        <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn primary" id="gRun">開賽</button>
          <button class="btn" id="gReplay">重播同一場</button>
          <button class="btn tiny" id="gLineup">賽前調整先發與陣型</button>
        </div>
        <div id="gSetup"></div>
        <div id="gStage" style="margin-top:12px"></div>`;
      document.getElementById('gPred').innerHTML = predHtml();
      const bind = (id, ev, fn) => { const n = document.getElementById(id); if (n) n[ev] = fn; };
      const reset = () => { state.setup = { home: null, away: null }; document.getElementById('gPred').innerHTML = predHtml(); document.getElementById('gSetup').innerHTML = ''; };
      bind('gHome', 'onchange', e => { state.home = e.target.value; reset(); });
      bind('gAway', 'onchange', e => { state.away = e.target.value; reset(); });
      bind('gNeutral', 'onchange', e => { state.neutral = e.target.checked; document.getElementById('gPred').innerHTML = predHtml(); });
      bind('gSwap', 'onclick', () => { [state.home, state.away] = [state.away, state.home]; state.setup = { home: null, away: null }; renderControls(); });
      bind('gRun', 'onclick', () => { state.seed = Math.floor(Math.random() * 1e9); start(); });
      bind('gReplay', 'onclick', () => start());
      bind('gLineup', 'onclick', () => renderSetup());
    }
    function predHtml() {
      if (state.home === state.away) return '<div class="note">兩邊選了同一隊 —— 換一隊再算。</div>';
      const p = predOf();
      if (!p) return '<div class="note">這組隊伍算不出來(缺模型參數)。</div>';
      const m = createMatch({ profile, home: state.home, away: state.away, pred: p, seed: 0, setup: { home: setupOf('home'), away: setupOf('away') } });
      const l = m.lambdas();
      const changed = Math.abs(l.home - p.xgHome) > 1e-9 || Math.abs(l.away - p.xgAway) > 1e-9;
      const ip = inPlaySim({ lambdaHome: l.home, lambdaAway: l.away, minute: 0 });
      return `
        <div class="scoreline" style="margin:10px 0">
          <div class="side">${crest(state.home)}<b>${C.esc(nameOf(state.home))}</b></div>
          <div class="sc dim" style="font-size:15px">${state.neutral ? '中立場' : 'vs'}</div>
          <div class="side away">${crest(state.away)}<b>${C.esc(nameOf(state.away))}</b></div>
        </div>
        ${C.probBar(changed ? ip : p)}
        <div class="tiny dim center" style="margin-top:6px">${changed
          ? `<b>遊戲模型</b>(先發已改):λ ${l.home.toFixed(2)} : ${l.away.toFixed(2)},站上原本 ${p.xgHome} : ${p.xgAway}`
          : `站上預測:預期進球 ${p.xgHome} : ${p.xgAway}・大 2.5 球 ${C.pct(p.over25, 0)}・雙方進球 ${C.pct(p.btts, 0)}(沒改先發時遊戲的 λ 就是這兩個數)`}</div>`;
    }

    /* ── 賽前調整:先發 / 替補互換、陣型 ───────────────── */
    function renderSetup() {
      const host = document.getElementById('gSetup');
      const side = s => {
        const su = setupOf(s), sq = squadOf(s), t = profile.teams[state[s]];
        const row = (c, where) => { const p = sq.get(c); return `<button class="btn tiny${where === 'xi' ? ' on' : ''}" data-side="${s}" data-code="${c}" data-where="${where}" title="${C.esc(p.statusZh ?? '')}${p.news ? ':' + C.esc(p.news) : ''}">${p.shirt ?? '–'} ${C.esc(p.name)} <span class="dim">${p.role ?? p.pos}${p.status !== 'a' ? ' ⚠' : ''}</span></button>`; };
        return `<div class="card" style="flex:1;min-width:260px">
          <h3>${crest(state[s])} ${C.esc(nameOf(state[s]))} <span class="dim tiny">陣型 <select data-form="${s}">${t.formation.options.map(f => `<option${f === su.formation ? ' selected' : ''}>${f}</option>`).join('')}</select></span></h3>
          <div class="tiny dim">先發(點一個先發、再點一個替補就互換)</div>
          <div class="row" style="gap:4px;flex-wrap:wrap;margin:6px 0">${su.xi.map(c => row(c, 'xi')).join('')}</div>
          <div class="tiny dim">替補席</div>
          <div class="row" style="gap:4px;flex-wrap:wrap;margin:6px 0">${su.bench.map(c => row(c, 'bench')).join('')}</div>
          <div class="tiny dim">預設先發 = 實時頁的推估先發;陣型只能從本季用過的挑(${t.formation.used.map(u => `${u.formation}×${u.games}`).join('、') || '官方最近一場'})。⚠ = 傷停狀態不是「可出賽」,遊戲不禁止。</div>
        </div>`;
      };
      host.innerHTML = `<div class="row" style="gap:12px;align-items:flex-start;margin-top:12px;flex-wrap:wrap">${side('home')}${side('away')}</div>`;
      let pick = null;
      host.querySelectorAll('[data-code]').forEach(b => {
        b.onclick = () => {
          const { side: s, code, where } = b.dataset;
          if (!pick || pick.side !== s) { pick = { side: s, code, where }; b.classList.add('primary'); return; }
          if (pick.code === code) { pick = null; renderSetup(); return; }
          const su = setupOf(s);
          if (pick.where !== where) {
            const xiCode = where === 'xi' ? code : pick.code, benchCode = where === 'xi' ? pick.code : code;
            su.xi = su.xi.map(c => (c === xiCode ? benchCode : c));
            su.bench = su.bench.map(c => (c === benchCode ? xiCode : c));
          }
          pick = null; renderSetup(); document.getElementById('gPred').innerHTML = predHtml();
        };
      });
      host.querySelectorAll('[data-form]').forEach(sel => { sel.onchange = () => { setupOf(sel.dataset.form).formation = sel.value; }; });
    }

    /* ── 比賽 ─────────────────────────────────────── */
    function start() {
      const p = predOf();
      const box = document.getElementById('gStage');
      if (!box || !p || state.home === state.away) return;
      stop();
      match = createMatch({ profile, home: state.home, away: state.away, pred: p, seed: state.seed,
        setup: { home: { ...setupOf('home') }, away: { ...setupOf('away') } } });
      paused = false; running = true;
      const rules = match.rules;
      box.innerHTML = `<div class="duel-stage">
        <div class="spread">
          <span class="pill bad" id="gMin"></span>
          <span class="tiny dim row" style="gap:6px">
            <button class="btn tiny" id="gPause">暫停</button>
            速度 <select id="gSpeed">${Object.entries({ slow: '慢', normal: '正常', fast: '快' }).map(([k, z]) => `<option value="${k}"${k === state.speed ? ' selected' : ''}>${z}</option>`).join('')}</select>
            <label><input type="checkbox" id="gHl"${state.highlights ? ' checked' : ''}> 精華</label>
            <button class="btn tiny" id="gSkip">跳到結果</button>
          </span>
        </div>
        <div class="scoreline" style="margin:8px 0">
          <div class="side">${crest(state.home)}<b>${C.esc(nameOf(state.home))}</b></div>
          <div class="sc" id="gScore">0 : 0</div>
          <div class="side away">${crest(state.away)}<b>${C.esc(nameOf(state.away))}</b></div>
        </div>
        <div id="gFlash" class="center"></div>
        <div class="game-main">
          <div class="game-pitch"><canvas id="gCanvas" width="920" height="600" style="width:100%;height:auto;display:block;border-radius:10px"></canvas>
            <div id="gProb" style="margin-top:8px"></div>
            <div class="tiny dim center" id="gNext" style="margin-top:4px"></div>
            <div id="gMomentum" style="margin-top:8px"></div>
          </div>
          <div class="game-panel">
            <div class="filters" id="gTabs">${[['stats', '比賽統計'], ['events', '事件流'], ['lineup', '陣容與換人'], ['tactics', '戰術']].map(([k, z]) => `<button class="btn tiny${k === tab ? ' on' : ''}" data-tab="${k}">${z}</button>`).join('')}</div>
            <div id="gPanel"></div>
          </div>
        </div>
        <div id="gComm" class="game-comm"></div>
        <div class="tiny dim" id="gFoot" style="margin-top:8px"></div>
      </div>`;
      const colorOf = code => teamBy.get(code)?.colors?.[0] ?? '#00ff85';
      let cA = colorOf(state.home), cB = colorOf(state.away);
      if (cA.toLowerCase() === cB.toLowerCase()) cB = '#04f5ff';
      const xiNames = side => {
        const sq = squadOf(side), out = { GK: [], DEF: [], MID: [], FWD: [] }, shirts = { GK: [], DEF: [], MID: [], FWD: [] };
        for (const c of setupOf(side).xi) { const p = sq.get(c); (out[p.pos] ?? out.MID).push(p.name); (shirts[p.pos] ?? shirts.MID).push(p.shirt); }
        return { xi: out, shirts };
      };
      const hN = xiNames('home'), aN = xiNames('away');
      anim = mountDuelAnim(document.getElementById('gCanvas'), {
        homeCode: state.home, awayCode: state.away,
        home: { formation: setupOf('home').formation, xi: hN.xi, shirts: hN.shirts, color: cA },
        away: { formation: setupOf('away').formation, xi: aN.xi, shirts: aN.shirts, color: cB },
        lambdaHome: p.xgHome, lambdaAway: p.xgAway, rng: seededRng(state.seed ^ 0x5bd1e995),
        possHome: match.possTarget != null ? match.possTarget / 100 : null,
      });
      document.querySelectorAll('#gTabs [data-tab]').forEach(b => { b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('#gTabs [data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === tab)); renderPanel(); }; });
      document.getElementById('gSpeed').onchange = e => { state.speed = e.target.value; schedule(); };
      document.getElementById('gHl').onchange = e => { state.highlights = e.target.checked; };
      document.getElementById('gPause').onclick = () => { paused = !paused; document.getElementById('gPause').textContent = paused ? '繼續' : '暫停'; if (paused) { tab = 'lineup'; renderPanel(); } };
      document.getElementById('gSkip').onclick = () => { while (!match.state().finished) match.tick(); frame([]); stop(false); };
      frame([]);
      schedule();
    }
    function schedule() {
      if (timer) clearInterval(timer);
      timer = C.pageInterval(() => {
        if (paused || !match || match.state().finished) return;
        let evs = match.tick();
        /* 精華模式:沒有值得看的事件就連跳幾分鐘,有事件才停下來演 */
        let hops = 0;
        while (state.highlights && !evs.some(e => NOTABLE.has(e.type) || (e.type === 'shot' && e.outcome !== 'off')) && hops < 6 && !match.state().finished) { evs = evs.concat(match.tick()); hops++; }
        frame(evs);
        if (match.state().finished) stop(false);
      }, SPEEDS[state.speed]);
    }
    function stop(kill = true) {
      if (timer) { clearInterval(timer); timer = null; }
      if (kill && anim) { anim.destroy(); anim = null; }
      running = false;
    }

    let lastGoalMin = -99;
    function frame(newEvents) {
      const s = match.state(), evs = match.events();
      const l = match.lambdas();
      const ip = inPlaySim({ lambdaHome: l.home, lambdaAway: l.away, hs: s.score[0], as: s.score[1], minute: s.min, finished: s.finished, redHome: l.redHome, redAway: l.redAway });
      const goals = evs.filter(e => e.type === 'goal');
      if (newEvents.some(e => e.type === 'goal')) lastGoalMin = s.min;
      anim?.setState({ min: s.min, done: s.finished, dueSides: goals.map(e => e.side), hs: s.score[0], as: s.score[1] });
      for (const e of newEvents) {
        if (e.type === 'sub') e.onShirt = match.playerOf(e.side, e.on)?.shirt ?? null;
        anim?.perform(e);
      }
      const $ = id => document.getElementById(id);
      $('gMin').innerHTML = s.finished ? '完場' : `<span class="livedot"></span>第 ${s.min}${s.min >= 90 ? '+' : ''} 分鐘${paused ? '(暫停)' : ''}`;
      $('gMin').className = `pill ${s.finished ? '' : 'bad'}`;
      $('gScore').textContent = `${s.score[0]} : ${s.score[1]}`;
      $('gProb').innerHTML = C.probBar(ip);
      $('gNext').innerHTML = s.finished ? '' : `剩餘期望進球 ${ip.xgRestHome} : ${ip.xgRestAway}・下一球 ${C.esc(nameOf(state.home))} ${C.pct(ip.nextGoal.home, 0)} / ${C.esc(nameOf(state.away))} ${C.pct(ip.nextGoal.away, 0)}${l.redHome || l.redAway ? `・紅牌 ${l.redHome}:${l.redAway}` : ''}`;
      $('gFlash').innerHTML = s.finished ? `<img class="duel-flash" src="assets/img/duel-fulltime.webp" width="96" alt="" ${HIDE}>`
        : (s.min - lastGoalMin <= 2 && goals.length) ? `<img class="duel-flash" src="assets/img/duel-goal.webp" width="80" alt="" ${HIDE}>` : '';
      $('gMomentum').innerHTML = momentumHtml(evs, s.min);
      renderPanel();
      const comm = $('gComm');
      const lines = evs.filter(e => e.type !== 'foul' || e.min >= s.min - 1).slice(-40).map(commentary).filter(Boolean);
      comm.innerHTML = lines.slice(-14).reverse().map(t => `<div class="tiny">${t}</div>`).join('');
      $('gFoot').innerHTML = s.finished ? `<img src="assets/img/duel-dice.webp" width="20" style="vertical-align:middle" ${HIDE}> 種子 ${state.seed} —— 「重播」用同一顆種子(同一串操作)重現同一場。
        <b>這是遊戲模型,不是本站預測</b>:進球逐分鐘抽自 λ_game(分鐘制 Poisson,沒有 Dixon-Coles 修正),
        射門 / 角球 / 犯規 / 牌 / 換人抽自逐場資料的分布,跑位動畫是程序化演出。能力係數 a = ${match.rules.a}(${C.esc(match.rules.aSource)})。` : '';
    }

    function playerName(side, code) { return match.playerOf(side, code)?.name ?? code; }
    function commentary(e) {
      const t = e.side ? C.esc(nameOf(e.team)) : '';
      const m = `<span class="mono dim">${e.min}'</span>`;
      switch (e.type) {
        case 'kickoff': return `${m} 開球。控球目標 ${match.possTarget ?? '—'}%(主隊,抽自兩隊分布)`;
        case 'half': return `${m} 中場 ${e.score[0]}:${e.score[1]}`;
        case 'full': return `${m} 完場 ${e.score[0]}:${e.score[1]}`;
        case 'goal': return `${m} ⚽ <b>${t} 進球!</b> ${e.ownGoal ? `${C.esc(e.scorerName)} 烏龍球` : `${C.esc(e.scorerName)}${e.assistName ? `(${C.esc(e.assistName)} 助攻)` : ''}`}・${SIT_ZH[e.situation] ?? e.situation}${e.takerName ? `,${C.esc(e.takerName)} 主罰` : ''} ${e.score[0]}:${e.score[1]}`;
        case 'shot': return `${m} ${t} ${C.esc(e.playerName)} 射門${OUT_ZH[e.outcome] ?? ''}(${SIT_ZH[e.situation] ?? e.situation})`;
        case 'corner': return `${m} ${t} 角球,${C.esc(e.playerName)} 主罰`;
        case 'card': return `${m} ${e.card === 'red' ? '🟥' : '🟨'} ${t} ${C.esc(e.playerName)}${e.card === 'red' ? ' 紅牌離場' : e.second ? ' 第二張黃牌' : ' 黃牌'}`;
        case 'sub': return `${m} 🔁 ${t} ${C.esc(e.onName)} 換 ${C.esc(e.offName)}${e.user ? '(你的換人)' : ''}`;
        case 'foul': return null;
        default: return null;
      }
    }
    function momentumHtml(evs, min) {
      /* 每 5 分鐘一格:主隊的射門×2 + 角球 + 進球×3 減客隊的。**由事件流算**,不是資料。 */
      const buckets = [];
      for (let b = 0; b < 90; b += 5) {
        let v = 0;
        for (const e of evs) {
          if (e.min < b || e.min >= b + 5 || !e.side) continue;
          const w = e.type === 'goal' ? 3 : e.type === 'shot' ? 2 : e.type === 'corner' ? 1 : 0;
          v += e.side === 'home' ? w : -w;
        }
        buckets.push(v);
      }
      const mx = Math.max(4, ...buckets.map(Math.abs));
      return `<div class="game-momentum" title="動能:每 5 分鐘由事件流算(射門×2、角球×1、進球×3),上=主隊">${buckets.map((v, i) => {
        const h = Math.round((Math.abs(v) / mx) * 22);
        const future = i * 5 >= min;
        return `<span class="${v >= 0 ? 'h' : 'a'}${future ? ' future' : ''}" style="height:${h}px"></span>`;
      }).join('')}</div>`;
    }

    /* ── 右側分頁 ───────────────────────────────── */
    function renderPanel() {
      const host = document.getElementById('gPanel');
      if (!host || !match) return;
      const s = match.state();
      if (tab === 'stats') host.innerHTML = statsHtml(s);
      else if (tab === 'events') host.innerHTML = eventsHtml();
      else if (tab === 'lineup') host.innerHTML = lineupHtml(s);
      else host.innerHTML = tacticsHtml();
      if (tab === 'lineup') bindSubs();
    }
    function statsHtml(s) {
      const H = s.home.stats, A = s.away.stats;
      const pt = match.possTarget;
      const row = (label, a, b, note = '') => `<div class="game-stat"><span>${a}</span><span class="dim tiny">${label}${note ? `<span class="dim"> ${note}</span>` : ''}</span><span>${b}</span></div>`;
      return `${row('控球 %', pt ?? '—', pt ? 100 - pt : '—', '抽樣')}${row('射門', H.shots, A.shots)}${row('射正', H.on, A.on)}${row('被封阻', H.blocked, A.blocked)}
        ${row('xG', H.xg.toFixed(2), A.xg.toFixed(2), '情境均值')}${row('角球', H.corners, A.corners)}${row('犯規', H.fouls, A.fouls)}${row('黃牌', H.yellow, A.yellow)}${row('紅牌', H.red, A.red)}
        ${row('λ(遊戲)', s.home.lambdaEff.toFixed(2), s.away.lambdaEff.toFixed(2), '含紅牌')}
        <div class="tiny dim" style="margin-top:6px">控球是抽自兩隊主/客場分布的目標值(FotMob ${profile.teams[state.home].possession.home.n}+${profile.teams[state.away].possession.away.n} 場);其餘由事件流累計。xG 是各情境的平均 xG/射門,不是逐射門。</div>`;
    }
    function eventsHtml() {
      const evs = match.events().filter(e => e.type !== 'foul' && e.type !== 'kickoff');
      if (!evs.length) return '<div class="tiny dim">還沒有事件。</div>';
      return `<div style="display:grid;gap:2px">${evs.slice().reverse().map(e => `<div class="stat-line">${commentary(e) ?? ''}</div>`).join('')}</div>`;
    }
    let subPick = { home: null, away: null };
    function lineupHtml(s) {
      const side = sd => {
        const ss = s[sd], sq = squadOf(sd);
        const btn = (c, where) => { const p = sq.get(c); const y = ss.yellows.find(y => y.player === c)?.n; return `<button class="btn tiny${where === 'on' ? ' on' : ''}${subPick[sd]?.[where] === c ? ' primary' : ''}" data-sub-side="${sd}" data-sub-code="${c}" data-sub-where="${where}">${p.shirt ?? '–'} ${C.esc(p.name)} <span class="dim">${p.role ?? p.pos}</span>${y ? ' 🟨' : ''}</button>`; };
        const auto = ss.plan.filter(p => !p.done && !p.user).map(p => `${p.min}' ${POS_ZH[p.band] ?? p.band}`).join('、');
        return `<div class="card" style="margin-bottom:8px">
          <h3>${C.esc(nameOf(state[sd]))} <span class="dim tiny">${ss.formation}・換人 ${ss.subsUsed}/5・窗口 ${ss.windowsUsed}/3${ss.red ? `・紅牌 ${ss.red}` : ''}</span></h3>
          <div class="tiny dim">場上</div><div class="row" style="gap:4px;flex-wrap:wrap;margin:4px 0">${ss.onPitch.map(c => btn(c, 'on')).join('')}</div>
          <div class="tiny dim">替補席</div><div class="row" style="gap:4px;flex-wrap:wrap;margin:4px 0">${ss.bench.map(c => btn(c, 'bench')).join('')}</div>
          ${ss.off.length ? `<div class="tiny dim">已下場:${ss.off.map(c => C.esc(sq.get(c)?.name ?? c)).join('、')}</div>` : ''}
          <div class="row" style="gap:6px;margin-top:6px"><button class="btn tiny" data-do-sub="${sd}">換人(點一個場上、一個替補)</button><span class="tiny dim" id="gSubMsg-${sd}"></span></div>
          <div class="tiny dim">${auto ? `沒動的話引擎會自己換:${auto}(次數、分鐘、位置抽自 ${profile.league_.subs.n} 次真實換人的分布)` : '自動換人已用完或已被你的操作取代'}</div>
        </div>`;
      };
      return side('home') + side('away') + `<div class="tiny dim">換人只在暫停或比賽進行中都可做;λ 從換人那一分鐘起改變(能力係數 a = ${match.rules.a})。</div>`;
    }
    function bindSubs() {
      document.querySelectorAll('[data-sub-code]').forEach(b => {
        b.onclick = () => {
          const { subSide: sd, subCode: c, subWhere: w } = b.dataset;
          subPick[sd] ??= {}; subPick[sd][w] = subPick[sd][w] === c ? null : c; renderPanel();
        };
      });
      document.querySelectorAll('[data-do-sub]').forEach(b => {
        b.onclick = () => {
          const sd = b.dataset.doSub, pk = subPick[sd] ?? {};
          const msg = document.getElementById(`gSubMsg-${sd}`);
          if (!pk.on || !pk.bench) { msg.textContent = '要先點一個場上的人和一個替補'; return; }
          const r = match.substitute(sd, pk.on, pk.bench);
          msg.textContent = r.ok ? '換了' : r.error;
          if (r.ok) { subPick[sd] = null; frame([r.event]); }
        };
      });
    }
    function tacticsHtml() {
      const side = sd => {
        const t = profile.teams[state[sd]], sit = t.shotSituations ?? {};
        const top = Object.entries(sit).sort((a, b) => b[1].shots - a[1].shots).slice(0, 4).map(([k, v]) => `${SIT_ZH[k] ?? k} ${C.pct(v.share, 0)}(xG/射門 ${v.xgPerShot})`).join('、');
        const tk = t.takers ? ['pen', 'fk', 'corner'].map(k => `${{ pen: '十二碼', fk: '任意球', corner: '角球' }[k]}:${(t.takers[k] ?? []).map(x => x.name).join('/') || '—'}`).join('・') : '—';
        const r = t.rates.home, ra = t.rates.away;
        return `<div class="card" style="margin-bottom:8px"><h3>${C.esc(nameOf(state[sd]))}</h3>
          <div class="tiny">陣型:最近一場 ${t.formation.latest ?? '—'}・本季用過 ${t.formation.used.map(u => `${u.formation}×${u.games}`).join('、') || '—'}</div>
          <div class="tiny">主場 射門 ${r?.sf ?? '—'}/場・被射門 ${r?.sa ?? '—'}・角球 ${r?.cf ?? '—'}・犯規 ${r?.fouls ?? '—'}・黃牌 ${r?.yellow ?? '—'}(${r?.games ?? 0} 場);客場 射門 ${ra?.sf ?? '—'}・被射門 ${ra?.sa ?? '—'}(${ra?.games ?? 0} 場)</div>
          <div class="tiny">控球:主場 ${t.possession.home.mean ?? '—'}%±${t.possession.home.sd ?? '—'}・客場 ${t.possession.away.mean ?? '—'}%±${t.possession.away.sd ?? '—'}</div>
          <div class="tiny">射門情境(${t.shotSample} 次):${top || '—'}</div>
          <div class="tiny">主罰:${tk}</div>
          ${t.resilience ? `<div class="tiny">韌性:領先守住 ${t.resilience.leadHoldPct}%・落後追回 ${t.resilience.trailRescuePct}%(資訊,不進遊戲)</div>` : ''}
        </div>`;
      };
      return side('home') + side('away') + `<div class="tiny dim">全部是真資料(逐場 CSV、FotMob、Understat、FPL);唯讀 —— 戰術面板只描述,能改的只有先發、陣型與換人。</div>`;
    }

    app.innerHTML = `
      <h1>模擬遊玩 <span class="dim">英超</span></h1>
      <p class="lede">選兩隊、調先發與陣型、開賽後隨時換人。這是遊戲:沒改動時機率就是站上的預測,改了才依球員能力變。</p>
      <div class="card"><div id="gameBody"></div></div>
      <div class="note" style="margin-top:12px"><b>這張圖哪些是真的。</b>
        <b>真資料</b>:名單、背號、角色、陣型選項、主罰順序、球員能力(FPL per-90)與牌數、兩隊各項事件率、控球分布、射門情境與 xG/射門(${profile.league_.shotMinutes.n} 次射門)。
        <b>抽樣</b>:控球目標、射門 / 角球 / 犯規 / 牌 / 換人的次數與分鐘、進球分鐘(${profile.league_.goalMinutes.n} 顆)。
        <b>遊戲規則</b>:能力係數 a(校準點估計 ${profile.calibration?.a ?? '—'} ± ${profile.calibration?.se ?? '—'},${profile.calibration?.significant ? '顯著' : '跟 0 分不開'};防守側借用同值)、紅牌 0.72/1.30(站上實時頁同組)、牌與射手的加權方式。
        <b>演出</b>:跑位、傳球、丟球的畫面。<b>沒有</b>:體能、球員屬性、賽中受傷、一對一、教練決策。
        <b>跟真實管線的關係只有一條</b>:沒有任何改動時 λ 等於站上預測;任何操作不寫回資料,也不影響站上任何一頁。</div>
      ${C.foot(data.meta)}`;
    renderControls();
  } catch (e) {
    app.innerHTML = `<div class="note bad">載入失敗:${C.esc(e.message)}</div>`;
    throw e;
  }
}
