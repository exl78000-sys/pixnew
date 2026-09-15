import * as C from './core.js?v=deaac0d6';
import { blendPair, inPlaySim, seededRng } from './predict-core.js?v=a99cd006';
import { mountDuelAnim } from './duel-anim.js?v=cc096ebb';
import { createMatch, defaultSetup, minuteAt, TACTIC_KEYS } from './game-engine.js?v=71a86a76';
import { SPEEDS, planPlayback, modeFor } from './game-playback.js?v=3726cb40';

/* 模擬遊玩(2026-09-03,取代對戰模擬)。FM24 2D classic 的配置:記分板、球場、右側四個分頁
   (比賽統計 / 事件流 / 陣容與換人 / 戰術)、下方勝率條 + 動能條 + 文字播報。
 *
 * **這是遊戲,不是本站的預測。** 跟真實管線的關係只有一條:沒有任何改動時 λ_game = 站上的 λ
 * (game-engine.js 檔頭;測試守著)。使用者換人、改先發之後才會偏離。
 * 所有操作只存在這一頁的記憶體裡,不進資料、不進 vault。
 * 只開英超 —— 明確清單 GAME_LEAGUES,不用「不是某聯賽就開」的二元式(league() 那條坑)。
 *
 * ── 2026-09-15 畫面當主時鐘(使用者用問答定的)──
 * 舊版引擎每個比賽分鐘定時走一步、事件當場進事件流與比分,畫面事後排隊追 —— 使用者回報「球場動態跟事件不一樣」。
 * 現在頁面一次向引擎拿一個回合(`match.nextSequence()`),交給動畫演(`anim.play(seq)`);
 * 動畫在事件**真的在畫面上發生**時回報(球過線、哨聲、旗子),頁面才把它放進事件流、比分、統計、動能與勝率條。
 * 所以這一頁有兩份狀態:引擎的(已經算到未來幾秒)與**顯示的**(`disp`,只含演過的事件)。
 * 畫面上所有數字都讀 disp,唯二讀引擎的是 λ(換人 / 紅牌改的)與換人的合法性檢查。 */
export const GAME_LEAGUES = ['pl'];

/* 播放速度(2026-09-15 晚,不剪接版):四檔的差別只在「演哪幾段」,演的段落一律連續、真人速度 ——
   規則與每檔的定義在 game-playback.js(純函式,測得到)。頁面這邊只做三件事:向引擎多拿幾個回合排隊、
   照規劃器說的跳過(事件照樣套進顯示狀態、事件流寫一行「略過」)、把要演的交給動畫(前面有跳過就淡出淡入)。 */
const SIT_ZH = { RegularPlay: '運動戰', FromCorner: '角球', FastBreak: '快攻', FreeKick: '任意球', SetPiece: '定位球', ThrowInSetPiece: '界外球', IndividualPlay: '個人突破', Penalty: '十二碼', OwnGoal: '烏龍球' };
const OUT_ZH = { saved: '被撲出', blocked: '被封阻', off: '射偏', post: '中柱' };
const POS_ZH = { GK: '門將', DEF: '後衛', MID: '中場', FWD: '前鋒' };
const START_ZH = { kickoff: '開球', goalkick: '球門球', throwin: '界外球', freekick: '任意球', corner: '角球', penalty: '十二碼', keeper: '門將發球', loose: '二點球', turnover: '斷球反擊' };


export async function renderGame(app) {
  try {
    const lg = C.league();
    if (!GAME_LEAGUES.includes(lg)) {
      /* 缺的東西要講**這個聯賽真正缺的那幾樣**。英冠 2026-09-15 起有球員層了(逐場累加),
         所以「英冠沒有球員資料」已經是假話 —— 它缺的是遊戲要的那幾樣:推估先發、主罰順位、逐人能力係數。 */
      app.innerHTML = `<h1>模擬遊玩</h1><div class="note">模擬遊玩目前只有英超 —— 它要的是推估先發、主罰順位與逐人能力係數(英超靠 FPL)。
        西甲與英冠有球員資料,但沒有這三樣:西甲缺推估先發、主罰與球員牌數,英冠的球員層是逐場統計累加的,沒有先發預測與能力係數。
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
      setup: { home: null, away: null }, speed: 'normal' };
    const setupOf = side => (state.setup[side] ??= { ...defaultSetup(profile, state[side]), tactics: defaultTactics(state[side]) });
    const defaultTactics = code => Object.fromEntries(TACTIC_KEYS.map(k => [k, profile.teams[code]?.style?.[k]?.level ?? 3]));
    /* 動畫吃的是相對預設的位移 */
    const tacticDeltas = (side, levels) => { const d = defaultTactics(state[side]); return Object.fromEntries(TACTIC_KEYS.map(k => [k, (levels[k] ?? d[k]) - d[k]])); };
    const squadOf = side => new Map(profile.teams[state[side]].squad.map(p => [p.code, p]));

    let match = null, anim = null, paused = false, tab = 'stats';
    let running = false;
    /* 顯示狀態:只含畫面上演過的事件(見檔頭)。 */
    let disp = null;
    let curSeq = null, lastDead = 0;
    /* 排隊中的回合(引擎已產、畫面還沒處理)與「上一段演完之後跳過了幾個」(要淡出淡入的依據) */
    let queue = [], skipped = [], everPlayed = false;

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
      host.innerHTML = `<div class="row" style="gap:12px;align-items:flex-start;margin-top:12px;flex-wrap:wrap">${side('home')}${side('away')}</div>
        <div style="margin-top:12px">${tacticsPanelHtml('home')}${tacticsPanelHtml('away')}<div class="tiny dim">戰術指令的預設是本季真實踢法;開賽後在「戰術」分頁隨時可改。只改踢法,不改進球期望。</div></div>`;
      bindTactics();
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

    /* ── 顯示狀態 ─────────────────────────────────── */
    function freshDisp() {
      const side = sd => ({ on: [...setupOf(sd).xi], bench: [...setupOf(sd).bench], off: [], subs: 0, yellows: new Map() });
      return { events: [], notes: [], score: [0, 0], poss: { home: 0, away: 0 }, seqs: 0, lineup: { home: side('home'), away: side('away') }, lastGoalAt: null, finished: false, half: 1, clock: 0 };
    }
    /* 把一筆事件套進顯示狀態(不畫)。跳到結果時整串事件都走這裡,所以它跟逐筆回報用同一條路。 */
    function applyEvent(e) {
      disp.events.push(e);
      if (e.type === 'goal') { disp.score = [...e.score]; disp.lastGoalAt = performance.now(); }
      if (e.type === 'half') disp.half = 2;
      if (e.type === 'full') disp.finished = true;
      const L = disp.lineup[e.side];
      if (!L) return;
      if (e.type === 'sub') { L.on = L.on.map(c => (c === e.off ? e.on : c)); L.bench = L.bench.filter(c => c !== e.on); L.off.push(e.off); L.subs++; }
      if (e.type === 'card') {
        if (e.card === 'yellow') L.yellows.set(e.player, (L.yellows.get(e.player) ?? 0) + 1);
        else { L.on = L.on.filter(c => c !== e.player); L.off.push(e.player); }
      }
    }
    function statsOf(side) {
      const ev = disp.events.filter(e => e.side === side);
      const n = t => ev.filter(e => e.type === t).length;
      const shots = ev.filter(e => e.type === 'shot' || (e.type === 'goal' && !e.ownGoal));
      return {
        shots: shots.length + ev.filter(e => e.type === 'goal' && e.ownGoal).length,
        on: n('goal') + ev.filter(e => e.type === 'shot' && e.outcome === 'saved').length,
        blocked: ev.filter(e => e.type === 'shot' && e.outcome === 'blocked').length,
        off: ev.filter(e => e.type === 'shot' && (e.outcome === 'off' || e.outcome === 'post')).length,
        xg: shots.reduce((a, e) => a + (e.xg ?? 0), 0),
        corners: n('corner'), fouls: n('foul'), offsides: n('offside'),
        yellow: ev.filter(e => e.type === 'card' && e.card === 'yellow').length,
        red: ev.filter(e => e.type === 'card' && e.card === 'red').length,
      };
    }

    /* ── 比賽 ─────────────────────────────────────── */
    function start() {
      const p = predOf();
      const box = document.getElementById('gStage');
      if (!box || !p || state.home === state.away) return;
      stop();
      match = createMatch({ profile, home: state.home, away: state.away, pred: p, seed: state.seed,
        setup: { home: { ...setupOf('home') }, away: { ...setupOf('away') } } });
      disp = freshDisp(); curSeq = null; lastDead = 0; queue = []; skipped = []; everPlayed = false;
      paused = false; running = true;
      box.innerHTML = `<div class="duel-stage">
        <div class="spread">
          <span class="pill bad" id="gMin"></span>
          <span class="tiny dim row" style="gap:6px;flex-wrap:wrap">
            <button class="btn tiny" id="gPause">暫停</button>
            速度 <select id="gSpeed">${Object.entries(SPEEDS).map(([k, v]) => `<option value="${k}"${k === state.speed ? ' selected' : ''}>${v.zh}</option>`).join('')}</select>
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
            <div class="tiny dim" id="gSeq" style="margin-top:4px;min-height:1.2em"></div>
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
      const xiOf = side => {
        const sq = squadOf(side), out = { GK: [], DEF: [], MID: [], FWD: [] }, shirts = { GK: [], DEF: [], MID: [], FWD: [] }, codes = { GK: [], DEF: [], MID: [], FWD: [] };
        for (const c of setupOf(side).xi) { const p = sq.get(c); (out[p.pos] ?? out.MID).push(p.name); (shirts[p.pos] ?? shirts.MID).push(p.shirt); (codes[p.pos] ?? codes.MID).push(p.code); }
        return { xi: out, shirts, codes };
      };
      const hN = xiOf('home'), aN = xiOf('away');
      /* 動畫的真資料:逐人熱區質心 / 離散度、場均跑動、最高速度、細分角色;球隊的跑動節奏與三路進攻佔比。
         codes 是引擎的球員代碼 —— 劇本用它指名誰碰球,畫面上的圓點就是事件裡的那個人。 */
      const metaOf = side => { const sq = squadOf(side), out = {}; for (const c of setupOf(side).xi) { const p = sq.get(c); out[p.name] = { role: p.role, heat: p.heat ?? null, run: p.run ?? null }; } return out; };
      const canvas = document.getElementById('gCanvas');
      anim = mountDuelAnim(canvas, {
        homeCode: state.home, awayCode: state.away,
        home: { formation: setupOf('home').formation, ...hN, color: cA, meta: metaOf('home'), pace: profile.teams[state.home].pace ?? null, zones: profile.teams[state.home].zones ?? null },
        away: { formation: setupOf('away').formation, ...aN, color: cB, meta: metaOf('away'), pace: profile.teams[state.away].pace ?? null, zones: profile.teams[state.away].zones ?? null },
        rng: seededRng(state.seed ^ 0x5bd1e995),
      });
      for (const sd of ['home', 'away']) anim.setTactics(sd, tacticDeltas(sd, setupOf(sd).tactics ?? {}));
      document.querySelectorAll('#gTabs [data-tab]').forEach(b => { b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('#gTabs [data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === tab)); renderPanel(); }; });
      document.getElementById('gSpeed').onchange = e => { state.speed = e.target.value; };   // 下一個回合起生效
      document.getElementById('gPause').onclick = () => { paused = !paused; anim?.pause(paused); document.getElementById('gPause').textContent = paused ? '繼續' : '暫停'; if (paused) { tab = 'lineup'; renderPanel(); } uiTick(); };
      document.getElementById('gSkip').onclick = skipToEnd;
      frame();
      /* 時鐘與記分板每 0.2 秒讀一次動畫的進度(畫面當主時鐘);換分頁時 pageInterval 會被收掉。
         另外看著畫布還在不在頁面上 —— 使用者切到別的分頁時宿主只收 pageInterval,rAF 迴圈要自己停。 */
      C.pageInterval(() => { if (anim && !document.body.contains(canvas)) { stop(); return; } uiTick(); }, 200);
      advance();
    }
    /* 向引擎拿一個回合排進佇列。引擎在這一步產生的事件分三種:回合開始前的(換人、開賽標記)、
       回合自己的(射門 / 進球 / 角球 / 犯規 / 牌 / 越位 —— 演的話動畫在畫面上發生時回報)、回合之後的(中場 / 完場)。 */
    function pull() {
      if (match.state().finished) return null;
      const before = match.events().length;
      const seq = match.nextSequence();
      if (!seq) return null;
      const evs = match.events().slice(before);
      return { seq, pre: evs.filter(e => e.seq == null && e.type !== 'half' && e.type !== 'full'), post: evs.filter(e => e.type === 'half' || e.type === 'full') };
    }
    /* 跳過一個回合:不演,但它的每一筆事件照樣套進顯示狀態(事件流、比分、統計、動能都看得到),控球秒數也算 */
    function skipSeq(q) {
      for (const e of q.pre) applyEvent(e);
      for (const e of q.seq.events) applyEvent(e);
      for (const e of q.post) applyEvent(e);
      lastDead = q.seq.dead; disp.poss[q.seq.side] += q.seq.dur; disp.seqs++;
      skipped.push(q.seq);
    }
    /* 規劃器決定演或跳(game-playback.js):向引擎多拿到看得見下一段有戲的回合為止,前面的整段跳過,
       然後把要演的交給動畫;跳過了幾個就先淡出淡入(所有人放到下一段開頭的站位)—— 演的段落裡沒有任何剪接。 */
    function advance() {
      if (!match || !anim || !running) return;
      for (;;) {
        const plan = planPlayback(queue.map(q => q.seq), { speed: state.speed, finished: match.state().finished });
        if (plan.need) { const q = pull(); if (q) { queue.push(q); continue; } }
        for (const q of queue.splice(0, plan.skip)) skipSeq(q);
        if (plan.play && queue.length) { playSeq(queue.shift()); return; }
        if (match.state().finished && !queue.length) { finish(); return; }
      }
    }
    /* 一段跳過(可能分好幾輪規劃湊起來)在事件流寫一行,讓讀者知道中間過了幾個回合、事件都記了 */
    function noteSkipped() {
      if (!skipped.length) return;
      const a = skipped[0], b = skipped[skipped.length - 1];
      disp.notes.push({ kind: 'skip', n: skipped.length, from: minuteAt(a.t0, a.half), to: minuteAt(b.t1, b.half), at: disp.events.length - 0.5 });
    }
    function playSeq(q) {
      const seq = q.seq;
      const jumped = everPlayed && skipped.length > 0;
      noteSkipped();
      const m = minuteAt(seq.t0, seq.half);
      const label = jumped ? `⏩ 略過 ${skipped.length} 回合,跳到第 ${m.min}${m.extra ? '+' + m.extra : ''} 分鐘` : null;
      skipped = []; everPlayed = true;
      curSeq = seq;
      const deadBefore = lastDead;
      frame();
      anim.play(seq, {
        pre: q.pre, post: q.post, deadBefore, mode: modeFor(seq, { speed: state.speed, deadBefore, jumped, label }),
        onEvent: e => { applyEvent(e); frame(); },
        onNote: n => { disp.notes.push({ ...n, at: disp.events.length }); renderComm(); },
        onDone: () => { lastDead = seq.dead; disp.poss[seq.side] += seq.dur; disp.seqs++; if (tab === 'stats') renderPanel(); advance(); },
      });
      const el = document.getElementById('gSeq');
      if (el) el.textContent = `第 ${seq.id} 回合・${C.esc(nameOf(seq.team))} ${START_ZH[seq.start.type] ?? seq.start.type}`;
    }
    function finish() {
      running = false;
      if (disp && !disp.finished) disp.finished = true;
      if (disp) { noteSkipped(); skipped = []; }
      const sc = match?.state();
      if (sc) anim?.finish({ hs: sc.score[0], as: sc.score[1] });   // 最後幾個回合被跳過時,記分板要寫完場比分
      frame();
    }
    function skipToEnd() {
      if (!match) return;
      while (!match.state().finished) match.nextSequence();
      disp = freshDisp();
      for (const e of match.events()) applyEvent(e);
      const s = match.state();
      disp.poss = { home: s.home.stats.possSec, away: s.away.stats.possSec }; disp.seqs = s.seqs; disp.finished = true; disp.half = 2;
      running = false; curSeq = null; queue = []; skipped = [];
      anim?.finish({ hs: s.score[0], as: s.score[1] });   // 畫布留著、比分板寫完場比分;圓點不再照劇本動
      frame();
    }
    function stop() {
      if (anim) { anim.destroy(); anim = null; }
      running = false;
    }

    /* 顯示的分鐘:動畫的進度換成引擎秒數,再用引擎的規則印(規則只有一份,45+ / 90+ 才對得上事件流) */
    function shownMinute() {
      if (!disp) return { min: 0, extra: null };
      if (disp.finished) return minuteAt((curSeq?.t1 ?? 90 * 60) , 2);
      const sec = anim?.clock();
      if (sec == null || !curSeq) return minuteAt(disp.half === 2 ? 45 * 60 : 0, disp.half);
      return minuteAt(sec, curSeq.half);
    }
    function uiTick() {
      if (!disp) return;
      const $ = id => document.getElementById(id);
      const m = shownMinute();
      const label = `${m.min}${m.extra ? `+${m.extra}` : ''}`;
      anim?.setClock(m);
      const minEl = $('gMin');
      if (minEl) {
        minEl.innerHTML = disp.finished ? '完場' : `<span class="livedot"></span>第 ${label} 分鐘${paused ? '(暫停)' : ''}`;
        minEl.className = `pill ${disp.finished ? '' : 'bad'}`;
      }
      const l = match.lambdas();
      const ip = inPlaySim({ lambdaHome: l.home, lambdaAway: l.away, hs: disp.score[0], as: disp.score[1], minute: Math.min(90, m.min), finished: disp.finished, redHome: l.redHome, redAway: l.redAway });
      const prob = $('gProb'); if (prob) prob.innerHTML = C.probBar(ip);
      const nx = $('gNext');
      if (nx) nx.innerHTML = disp.finished ? '' : `剩餘期望進球 ${ip.xgRestHome} : ${ip.xgRestAway}・下一球 ${C.esc(nameOf(state.home))} ${C.pct(ip.nextGoal.home, 0)} / ${C.esc(nameOf(state.away))} ${C.pct(ip.nextGoal.away, 0)}${l.redHome || l.redAway ? `・紅牌 ${l.redHome}:${l.redAway}` : ''}`;
      const fl = $('gFlash');
      if (fl) fl.innerHTML = disp.finished ? `<img class="duel-flash" src="assets/img/duel-fulltime.webp" width="96" alt="" ${HIDE}>`
        : (disp.lastGoalAt != null && performance.now() - disp.lastGoalAt < 3000) ? `<img class="duel-flash" src="assets/img/duel-goal.webp" width="80" alt="" ${HIDE}>` : '';
    }
    function frame() {
      if (!disp) return;
      const $ = id => document.getElementById(id);
      uiTick();
      const sc = $('gScore'); if (sc) sc.textContent = `${disp.score[0]} : ${disp.score[1]}`;
      const mo = $('gMomentum'); if (mo) mo.innerHTML = momentumHtml();
      renderPanel();
      renderComm();
      const foot = $('gFoot');
      if (foot) foot.innerHTML = disp.finished ? `<img src="assets/img/duel-dice.webp" width="20" style="vertical-align:middle" ${HIDE}> 種子 ${state.seed} —— 「重播」用同一顆種子(同一串操作)重現同一場。
        <b>這是遊戲模型,不是本站預測</b>:比賽是一個接一個的控球回合,進球由回合裡的射門逐一決定 ——
        每次射門抽該隊真實射門圖的一筆(座標、xG、射手),進球機率 = 那一筆的 xG × 錨定係數(沒有 Dixon-Coles 修正);
        角球 / 犯規 / 牌 / 越位 / 換人的率抽自逐場資料,跑位動畫是程序化演出。能力係數 a = ${match.rules.a}(${C.esc(match.rules.aSource)})。` : '';
    }
    function renderComm() {
      const comm = document.getElementById('gComm');
      if (!comm || !disp) return;
      /* 播報:事件與回合備註(界外球、斷球…)混排,照發生順序;只留最近 14 行 */
      const items = [];
      disp.events.forEach((e, i) => items.push({ k: i, t: commentary(e) }));
      for (const n of disp.notes) items.push({ k: n.at - 0.5, t: noteText(n) });
      const lines = items.filter(x => x.t).sort((a, b) => a.k - b.k).slice(-14).reverse();
      comm.innerHTML = lines.map(x => `<div class="tiny">${x.t}</div>`).join('');
    }

    function playerName(side, code) { return match.playerOf(side, code)?.name ?? code; }
    function commentary(e) {
      const t = e.side ? C.esc(nameOf(e.team)) : '';
      const m = `<span class="mono dim">${e.min}${e.extra ? `+${e.extra}` : ''}'</span>`;
      switch (e.type) {
        case 'kickoff': return `${m} 開球。控球目標 ${match.possTarget ?? '—'}%(主隊,抽自兩隊分布)`;
        case 'half': return `${m} 中場 ${e.score[0]}:${e.score[1]}`;
        case 'full': return `${m} 完場 ${e.score[0]}:${e.score[1]}`;
        case 'goal': return `${m} ⚽ <b>${t} 進球!</b> ${e.ownGoal ? `${C.esc(e.scorerName)} 烏龍球` : `${C.esc(e.scorerName)}${e.assistName ? `(${C.esc(e.assistName)} 助攻)` : ''}`}・${SIT_ZH[e.situation] ?? e.situation}${e.takerName ? `,${C.esc(e.takerName)} 主罰` : ''} ${e.score[0]}:${e.score[1]}`;
        case 'shot': return `${m} ${t} ${C.esc(e.playerName)} 射門${OUT_ZH[e.outcome] ?? ''}(${SIT_ZH[e.situation] ?? e.situation},xG ${e.xg?.toFixed(2) ?? '—'})`;
        case 'corner': return `${m} ${t} 角球,${C.esc(e.playerName)} 主罰`;
        case 'card': return `${m} ${e.card === 'red' ? '🟥' : '🟨'} ${t} ${C.esc(e.playerName)}${e.card === 'red' ? ' 紅牌離場' : e.second ? ' 第二張黃牌' : ' 黃牌'}`;
        case 'sub': return `${m} 🔁 ${t} ${C.esc(e.onName)} 換 ${C.esc(e.offName)}${e.user ? '(你的換人)' : ''}`;
        case 'foul': return `${m} <span class="dim">${t} ${C.esc(e.playerName)} 犯規(${C.esc(e.onName)} 被犯規${e.penalty ? ',十二碼' : ''})</span>`;
        case 'offside': return `${m} <span class="dim">${t} ${C.esc(e.playerName)} 越位</span>`;
        default: return null;
      }
    }
    function noteText(n) {
      const t = C.esc(nameOf(state[n.side]));
      if (n.kind === 'turnover') return `<span class="dim">${C.esc(nameOf(state[n.bySide]))} ${C.esc(n.by ?? '')} ${n.how === 'tackle' ? '搶斷' : n.how === 'intercept' ? '截到傳球' : '斷球'}</span>`;
      if (n.kind === 'skip') return `<span class="dim">⏩ 略過 ${n.n} 回合(第 ${n.from.min}~${n.to.min} 分鐘,事件照記)</span>`;
      if (n.kind === 'out') return `<span class="dim">${n.out === 'throwin' ? '界外球' : '球門球'}(${C.esc(nameOf(state[n.to]))})</span>`;
      if (n.kind === 'loose') return `<span class="dim">${t} 沒控好,二點球</span>`;
      if (n.kind === 'restart' && ['corner', 'freekick', 'penalty', 'kickoff'].includes(n.type)) return `<span class="dim">${t} ${START_ZH[n.type]}${n.player ? `,${C.esc(n.player)}` : ''}</span>`;
      return null;
    }
    function momentumHtml() {
      /* 每 5 分鐘一格:主隊的射門×2 + 角球 + 進球×3 減客隊的。**由畫面上演過的事件算**,不是引擎的。 */
      const cur = shownMinute().min;
      const buckets = [];
      for (let b = 0; b < 90; b += 5) {
        let v = 0;
        for (const e of disp.events) {
          if (e.min < b || e.min >= b + 5 || !e.side) continue;
          const w = e.type === 'goal' ? 3 : e.type === 'shot' ? 2 : e.type === 'corner' ? 1 : 0;
          v += e.side === 'home' ? w : -w;
        }
        buckets.push(v);
      }
      const mx = Math.max(4, ...buckets.map(Math.abs));
      return `<div class="game-momentum" title="動能:每 5 分鐘由演過的事件算(射門×2、角球×1、進球×3),上=主隊">${buckets.map((v, i) => {
        const h = Math.round((Math.abs(v) / mx) * 22);
        const future = i * 5 >= cur && !disp.finished;
        return `<span class="${v >= 0 ? 'h' : 'a'}${future ? ' future' : ''}" style="height:${h}px"></span>`;
      }).join('')}</div>`;
    }

    /* ── 右側分頁 ───────────────────────────────── */
    function renderPanel() {
      const host = document.getElementById('gPanel');
      if (!host || !match || !disp) return;
      if (tab === 'stats') host.innerHTML = statsHtml();
      else if (tab === 'events') host.innerHTML = eventsHtml();
      else if (tab === 'lineup') host.innerHTML = lineupHtml();
      else host.innerHTML = tacticsHtml();
      if (tab === 'lineup') bindSubs();
      if (tab === 'tactics') bindTactics();
    }
    function statsHtml() {
      const H = statsOf('home'), A = statsOf('away');
      const s = match.state();
      const pt = match.possTarget;
      const tot = disp.poss.home + disp.poss.away;
      const ph = tot > 0 ? Math.round(100 * disp.poss.home / tot) : null;
      const row = (label, a, b, note = '') => `<div class="game-stat"><span>${a}</span><span class="dim tiny">${label}${note ? `<span class="dim"> ${note}</span>` : ''}</span><span>${b}</span></div>`;
      return `${row('控球 %', ph ?? '—', ph != null ? 100 - ph : '—', pt != null ? `目標 ${pt}:${100 - pt}` : '')}${row('射門', H.shots, A.shots)}${row('射正', H.on, A.on)}${row('被封阻', H.blocked, A.blocked)}
        ${row('xG', H.xg.toFixed(2), A.xg.toFixed(2), '逐射門')}${row('角球', H.corners, A.corners)}${row('犯規', H.fouls, A.fouls)}${row('越位', H.offsides, A.offsides)}${row('黃牌', H.yellow, A.yellow)}${row('紅牌', H.red, A.red)}
        ${row('λ(遊戲)', s.home.lambdaEff.toFixed(2), s.away.lambdaEff.toFixed(2), '含紅牌')}
        <div class="tiny dim" style="margin-top:6px">由畫面上演過與略過的回合累計(到第 ${disp.seqs} 回合;略過的回合事件照記,只是不演)。控球 = 演過的回合裡兩隊各持球多久;目標值抽自兩隊主/客場分布(FotMob ${profile.teams[state.home].possession.home.n}+${profile.teams[state.away].possession.away.n} 場)。xG 是每次射門抽到的那一筆真實射門的 xG。</div>`;
    }
    function eventsHtml() {
      const evs = disp.events.filter(e => e.type !== 'foul' && e.type !== 'kickoff');
      if (!evs.length) return '<div class="tiny dim">還沒有事件。</div>';
      return `<div style="display:grid;gap:2px">${evs.slice().reverse().map(e => `<div class="stat-line">${commentary(e) ?? ''}</div>`).join('')}</div>`;
    }
    let subPick = { home: null, away: null };
    function lineupHtml() {
      const s = match.state();
      const side = sd => {
        const ss = s[sd], L = disp.lineup[sd], sq = squadOf(sd);
        const btn = (c, where) => { const p = sq.get(c); const y = L.yellows.get(c); return `<button class="btn tiny${where === 'on' ? ' on' : ''}${subPick[sd]?.[where] === c ? ' primary' : ''}" data-sub-side="${sd}" data-sub-code="${c}" data-sub-where="${where}">${p.shirt ?? '–'} ${C.esc(p.name)} <span class="dim">${p.role ?? p.pos}</span>${y ? ' 🟨' : ''}</button>`; };
        const auto = ss.plan.filter(p => !p.done && !p.user).map(p => `${p.min}' ${POS_ZH[p.band] ?? p.band}`).join('、');
        const pendingSubs = ss.subsUsed - L.subs;
        return `<div class="card" style="margin-bottom:8px">
          <h3>${C.esc(nameOf(state[sd]))} <span class="dim tiny">${ss.formation}・換人 ${ss.subsUsed}/5・窗口 ${ss.windowsUsed}/3${L.off.length - L.subs > 0 ? `・紅牌 ${L.off.length - L.subs}` : ''}</span></h3>
          <div class="tiny dim">場上</div><div class="row" style="gap:4px;flex-wrap:wrap;margin:4px 0">${L.on.map(c => btn(c, 'on')).join('')}</div>
          <div class="tiny dim">替補席</div><div class="row" style="gap:4px;flex-wrap:wrap;margin:4px 0">${L.bench.map(c => btn(c, 'bench')).join('')}</div>
          ${L.off.length ? `<div class="tiny dim">已下場:${L.off.map(c => C.esc(sq.get(c)?.name ?? c)).join('、')}</div>` : ''}
          ${pendingSubs > 0 ? `<div class="tiny">已登記 ${pendingSubs} 個換人,下一次停球時上場</div>` : ''}
          <div class="row" style="gap:6px;margin-top:6px"><button class="btn tiny" data-do-sub="${sd}">換人(點一個場上、一個替補)</button><span class="tiny dim" id="gSubMsg-${sd}"></span></div>
          <div class="tiny dim">${auto ? `沒動的話引擎會自己換:${auto}(次數、分鐘、位置抽自 ${profile.league_.subs.n} 次真實換人的分布)` : '自動換人已用完或已被你的操作取代'}</div>
        </div>`;
      };
      return side('home') + side('away') + `<div class="tiny dim">換人在暫停或比賽進行中都可做;登記後在下一次停球時上場,λ 從那一刻起改變(能力係數 a = ${match.rules.a})。</div>`;
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
          /* 引擎立刻換(下一個回合就用新名單);畫面上的圓點在下一次停球時才換,事件流也在那時才出現 */
          const r = match.substitute(sd, pk.on, pk.bench);
          msg.textContent = r.ok ? '登記了,下一次停球時上場' : r.error;
          if (r.ok) { subPick[sd] = null; renderPanel(); }
        };
      });
    }
    /* 戰術指令(階段 B):六軸 × 五級;預設 = 本季真實踢法推的那一級(標 n 與依據);改了下一個回合起生效。
       只改回合的組成與站位,λ 不變 —— 面板上寫明。賽前(還沒開賽)改的存在 setup 裡,開賽時帶進引擎。 */
    function tacticsPanelHtml(sd) {
      const t = profile.teams[state[sd]], axes = profile.styleAxes ?? {};
      const cur = match && running ? match.tactics()[sd].levels : (setupOf(sd).tactics ?? defaultTactics(state[sd]));
      const def = defaultTactics(state[sd]);
      return `<div class="card" style="margin-bottom:8px"><h3>${C.esc(nameOf(state[sd]))} <span class="dim tiny">戰術指令</span></h3>
        ${TACTIC_KEYS.map(k => { const a = axes[k] ?? { zh: k, levels: ['1', '2', '3', '4', '5'] }; const st = t.style?.[k]; return `
          <div class="tac-row" style="display:grid;grid-template-columns:52px 1fr;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid var(--line)">
            <span class="small"><b>${C.esc(a.zh)}</b></span>
            <span class="row" style="gap:3px;flex-wrap:wrap">${a.levels.map((z, i) => `<button class="btn tiny${cur[k] === i + 1 ? ' on' : ''}" data-tac-side="${sd}" data-tac-key="${k}" data-tac-level="${i + 1}" title="${def[k] === i + 1 ? '本季實際' : ''}">${C.esc(z)}${def[k] === i + 1 ? '<span class="dim">・本季</span>' : ''}</button>`).join('')}</span>
            <span></span><span class="tiny dim">本季實際:${st?.value != null ? `${st.value}${C.esc(st.unit ?? '')}(${C.esc(st.basis)},${st.n} 場${st.proxy ? ',代理指標' : ''})` : '沒有資料,預設中'}。改了會動:${C.esc(a.effects ?? '')}</span>
          </div>`; }).join('')}
      </div>`;
    }
    function bindTactics() {
      document.querySelectorAll('[data-tac-key]').forEach(b => {
        b.onclick = () => {
          const { tacSide: sd, tacKey: k, tacLevel: lv } = b.dataset;
          const level = Number(lv);
          const su = setupOf(sd); su.tactics = { ...(su.tactics ?? defaultTactics(state[sd])), [k]: level };
          if (match && running) { const r = match.setTactics(sd, { [k]: level }); anim?.setTactics(sd, tacticDeltas(sd, r.levels)); }
          if (tab === 'tactics' && match) renderPanel(); else renderSetup();
        };
      });
    }
    function tacticsHtml() {
      const side = sd => {
        const t = profile.teams[state[sd]], sit = t.shotSituations ?? {};
        const top = Object.entries(sit).sort((a, b) => b[1].shots - a[1].shots).slice(0, 4).map(([k, v]) => `${SIT_ZH[k] ?? k} ${C.pct(v.share, 0)}(xG/射門 ${v.xgPerShot})`).join('、');
        const tk = t.takers ? ['pen', 'fk', 'corner'].map(k => `${{ pen: '十二碼', fk: '任意球', corner: '角球' }[k]}:${(t.takers[k] ?? []).map(x => x.name).join('/') || '—'}`).join('・') : '—';
        const r = t.rates.home, ra = t.rates.away;
        const pl = t.play?.[sd === 'home' ? 'home' : 'away'];
        return `<div class="card" style="margin-bottom:8px"><h3>${C.esc(nameOf(state[sd]))}</h3>
          <div class="tiny">陣型:最近一場 ${t.formation.latest ?? '—'}・本季用過 ${t.formation.used.map(u => `${u.formation}×${u.games}`).join('、') || '—'}</div>
          <div class="tiny">主場 射門 ${r?.sf ?? '—'}/場・被射門 ${r?.sa ?? '—'}・角球 ${r?.cf ?? '—'}・犯規 ${r?.fouls ?? '—'}・黃牌 ${r?.yellow ?? '—'}(${r?.games ?? 0} 場);客場 射門 ${ra?.sf ?? '—'}・被射門 ${ra?.sa ?? '—'}(${ra?.games ?? 0} 場)</div>
          <div class="tiny">控球:主場 ${t.possession.home.mean ?? '—'}%±${t.possession.home.sd ?? '—'}・客場 ${t.possession.away.mean ?? '—'}%±${t.possession.away.sd ?? '—'}${pl ? `・傳球 ${pl.passes ?? '—'}/場・越位 ${pl.offsides ?? '—'}/場(${pl.games} 場)` : ''}</div>
          <div class="tiny">射門情境(${t.shotSample} 次):${top || '—'}</div>
          <div class="tiny">射門池:${t.shots?.n ?? 0} 筆真實射門(座標、xG、射手),引擎每次射門抽一筆</div>
          <div class="tiny">主罰:${tk}</div>
          ${t.resilience ? `<div class="tiny">韌性:領先守住 ${t.resilience.leadHoldPct}%・落後追回 ${t.resilience.trailRescuePct}%(資訊,不進遊戲)</div>` : ''}
        </div>`;
      };
      return tacticsPanelHtml('home') + tacticsPanelHtml('away')
        + `<div class="tiny dim" style="margin-bottom:8px"><b>指令只改踢法,不改進球期望。</b>改的是回合的組成與站位:射門 / 角球 / 犯規 / 越位的次數、傳球串長度、斷球位置、防線與寬度;
          引擎會把射門的轉換率跟著調回來,所以 λ(遊戲)一個都不變。每一級改多少是遊戲規則(沒有資料能校準),預設那一級是從本季真實數據推的,標「代理指標」的軸用的是替代量(例如壓迫用對手傳球數),階段 C 重抓抄截 / 攔截 / 長傳之後會換掉。改了下一個回合起生效。</div>`
        + side('home') + side('away') + `<div class="tiny dim">下面這些是真資料(逐場 CSV、FotMob、Understat、FPL),唯讀。</div>`;
    }

    app.innerHTML = `
      <h1>模擬遊玩 <span class="dim">英超</span></h1>
      <p class="lede">選兩隊、調先發與陣型、開賽後隨時換人。這是遊戲:沒改動時機率就是站上的預測,改了才依球員能力變。</p>
      <div class="card"><div id="gameBody"></div></div>
      <div class="note" style="margin-top:12px"><b>這張圖哪些是真的。</b>
        <b>真資料</b>:名單、背號、角色、陣型選項、主罰順序、球員能力(FPL per-90)與牌數、兩隊各項事件率、控球分布、傳球數、越位數、
        逐射門的座標 / xG / 射手(${profile.league_.shotPool?.n ?? profile.league_.shotMinutes.n} 次射門的射門池)。
        <b>抽樣</b>:控球目標、每個回合的結局(射門 / 角球 / 犯規 / 越位 / 出界 / 被斷球,機率由上面的率算)、射門那一筆、進球分鐘的傾斜(${profile.league_.goalMinutes.n} 顆)、換人的次數與分鐘。
        <b>遊戲規則</b>:每隊每場 100 個控球回合、球在場上 57 分鐘、停球秒數、能力係數 a(校準點估計 ${profile.calibration?.a ?? '—'} ± ${profile.calibration?.se ?? '—'},${profile.calibration?.significant ? '顯著' : '跟 0 分不開'};防守側借用同值)、紅牌 0.72/1.30(站上實時頁同組)、牌與射手的加權方式。
        <b>演出</b>:跑位、傳球路線、無球跑動 —— 但演的是引擎的劇本:誰開始、誰碰球、在哪裡射門都是劇本裡的人與位置(射門位置是真實射門圖抽的),
        事件在畫面上發生時才進事件流與比分。跑動有物理:每個人有速度、加速度有上限,
        <b>最高速度就是他自己的真資料</b>(FotMob 逐人最高速度),站位參考逐人觸球熱區質心、進攻偏向參考三路進攻佔比。
        跑動量校準過:<b>播放速度選「即時」時</b>,每人每比賽分鐘約 105 公尺,對照 FotMob 這兩隊的真實值(每隊每分鐘 ÷ 11)。
        <b>正常 / 快 / 精華不剪接</b>:演的段落一律連續、真人速度、每一腳都演;省時間的方法只有整段跳過(畫面淡出、時鐘跳到那一分鐘、
        跳過的回合事件照樣進事件流與比分)與把太長的停球剪到重新開始 —— 所以那三檔的跑動量不等於真實(只演了有戲的段落)。
        軌跡本身一律是演出。<b>戰術指令</b>(心態 / 壓迫 / 防線 / 寬度 / 節奏 / 直接度):預設 = 本季真實踢法(六個指標從逐場數據推,標 n;有些是代理指標),
        拉動只改回合的組成與站位,λ 不變 —— 每一級改多少是遊戲規則,沒有資料能校準。<b>沒有</b>:體能、球員屬性、賽中受傷、一對一、教練決策。
        <b>跟真實管線的關係只有一條</b>:沒有任何改動時 λ 等於站上預測;任何操作不寫回資料,也不影響站上任何一頁。</div>
      ${C.foot(data.meta)}`;
    renderControls();
  } catch (e) {
    app.innerHTML = `<div class="note bad">載入失敗:${C.esc(e.message)}</div>`;
    throw e;
  }
}
