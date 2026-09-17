import * as C from './core.js?v=d2162a48';
import { blendPair, inPlaySim, seededRng } from './predict-core.js?v=a99cd006';
import { mountPitch } from './game-pitch.js?v=7d3b9def';
import { createLiveMatch, defaultSetup, LIVE_SPEEDS } from './game-live.js?v=37899382';
import { tally, diagnose, tacticNotes, recap, chainBrief } from './game-diag.js?v=13b570f3';

/* 模擬遊玩(2026-09-03,取代對戰模擬)。FM24 2D classic 的配置:記分板、球場、右側四個分頁
   (比賽統計 / 事件流 / 陣容與換人 / 戰術)、下方勝率條 + 動能條 + 文字播報。
 *
 * **這是遊戲,不是本站的預測。** 跟真實管線的關係只有一條:沒有任何改動時 λ_game = 站上的 λ
 * (game-engine.js 檔頭;測試守著)。使用者換人、改先發之後才會偏離。
 * 所有操作只存在這一頁的記憶體裡,不進資料、不進 vault。
 * 只開英超 —— 明確清單 GAME_LEAGUES,不用「不是某聯賽就開」的二元式(league() 那條坑)。
 *
 * ── 2026-09-16 換成連續時間引擎(階段 3)──
 * 舊的做法是「引擎產一個回合 → 動畫照劇本演」,而演出為了壓時間會剪接(把人放到該在的地方、
 * 一格跳到終點、射手瞬移到射門點)。使用者的原話是「瞬間換位、莫名掉球、無故進球,根本沒有在踢球」。
 * 現在**沒有劇本也沒有剪接**:`game-sim.js` 用 1/60 秒的固定時步算球與二十二個人,
 * 這一頁每一格把「真實時間 × 倍率」推進給它(`live.advance`),再把那一刻畫出來(`game-pitch.js`)。
 * 播放速度四檔的差別只有倍率,**沒有任何一格被跳過**。
 *
 * 兩份狀態的問題也一起沒了:引擎不再算到未來,`advance()` 回傳的就是「這一格剛發生的事」,
 * 所以 `disp` 與引擎永遠同步(舊版要靠動畫回報才敢寫進比分)。
 * 轉接層在 `game-live.js` —— 頁面不直接碰 `game-sim.js`,翻譯只有一份。 */
export const GAME_LEAGUES = ['pl'];

/* 速度只是**時間倍率**(定義在 game-live.js)。以前這裡要講「哪幾段會被跳過」,現在不必 ——
   一格都不跳。倍率越高,同樣一秒真實時間裡引擎多走幾秒,人的動作就越快,但**每一步都還在**。 */
const SIT_ZH = { RegularPlay: '運動戰', FromCorner: '角球', FastBreak: '快攻', FreeKick: '任意球', SetPiece: '定位球', ThrowInSetPiece: '界外球', IndividualPlay: '個人突破', Penalty: '十二碼', OwnGoal: '烏龍球' };
const OUT_ZH = { saved: '被撲出', blocked: '被封阻', off: '射偏', post: '中柱' };
const POS_ZH = { GK: '門將', DEF: '後衛', MID: '中場', FWD: '前鋒' };
const START_ZH = { kickoff: '開球', goalkick: '球門球', throwin: '界外球', freekick: '任意球', corner: '角球', penalty: '十二碼', keeper: '門將發球', loose: '二點球', turnover: '斷球反擊' };
const TACTIC_ZH = { mentality: '心態', pressing: '壓迫', line: '防線高度', width: '場地寬度', tempo: '節奏', directness: '直接度' };


export async function renderGame(app) {
  try {
    const lg = C.league();
    if (!GAME_LEAGUES.includes(lg)) {
      /* 缺的東西要講**這個聯賽真正缺的那幾樣**。英冠 2026-09-15 起有球員層了(逐場累加),
         所以「英冠沒有球員資料」已經是假話 —— 它缺的是遊戲要的那幾樣:推估先發、主罰順位、逐人能力係數。 */
      /* **不要在這裡列聯賽名。** 原本寫「西甲與英冠有球員資料,但沒有這三樣:西甲缺…,
         英冠的…」—— 加德甲義甲法甲之後,站在那三個聯賽的讀者看到的是一句
         **沒有提到自己**的說明(「這一批是誰」那條坑的第 N 次)。
         理由對每個非英超聯賽都一樣,所以用目前聯賽的名字講,名字從註冊表讀。 */
      const zh = C.LEAGUES[C.league()]?.zh ?? '這個聯賽';
      app.innerHTML = `<h1>模擬遊玩</h1><div class="note">模擬遊玩目前只有英超 —— 它要的是<b>推估先發、主罰順位與逐人能力係數</b>,
        英超靠 FPL 才有這三樣。${C.esc(zh)}即使有球員資料,也沒有這三項(它們不在本站接得到的來源裡),
        所以不是還沒接,是目前沒有來源。<a href="${C.link('explore', { view: 'duel', league: 'pl' })}">切到英超玩</a></div>`;
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
    /* **只列連續引擎真的接得到的那兩軸。** 舊版有六軸,而新引擎裡只有壓迫與防線高度有對應的旋鈕 ——
       其餘四個留著就是四個拉了不會有任何反應的按鈕,那比沒有更糟(鐵則三的同一個道理)。
       缺的那四個在畫面上列出來說「還沒接」,不要讓讀者自己去猜。 */
    const LIVE_TACTICS = ['pressing', 'line'];
    const TACTIC_TODO = ['mentality', 'width', 'tempo', 'directness'];
    const defaultTactics = code => Object.fromEntries(LIVE_TACTICS.map(k => [k, profile.teams[code]?.style?.[k]?.level ?? 3]));
    const squadOf = side => new Map(profile.teams[state[side]].squad.map(p => [p.code, p]));

    let match = null, pitch = null, paused = false, tab = 'stats';
    let running = false, raf = 0, lastTs = 0;
    /* 顯示狀態:引擎推進出來的事件照順序套進這裡(見檔頭) */
    let disp = null;

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
      /* 連續引擎裡 **λ 是錨,整場不變**:換先發、換人、紅牌的影響是從場上長出來的
         (少一個人就是真的少一個人),不透過改 λ 去模擬。舊版會依球員能力重算 λ 並在這裡
         印「先發已改」,那句話在這個引擎裡不成立,所以拿掉 —— 留著就是畫面在說謊。 */
      return `
        <div class="scoreline" style="margin:10px 0">
          <div class="side">${crest(state.home)}<b>${C.esc(nameOf(state.home))}</b></div>
          <div class="sc dim" style="font-size:15px">${state.neutral ? '中立場' : 'vs'}</div>
          <div class="side away">${crest(state.away)}<b>${C.esc(nameOf(state.away))}</b></div>
        </div>
        ${C.probBar(p)}
        <div class="tiny dim center" style="margin-top:6px">站上預測:預期進球 ${p.xgHome} : ${p.xgAway}・大 2.5 球 ${C.pct(p.over25, 0)}・雙方進球 ${C.pct(p.btts, 0)}
          <br>遊戲的 λ <b>就是這兩個數</b>,而且整場不變 —— 換人與紅牌在這個引擎裡是場上真的少一個人 / 換一個人,不靠改 λ 模擬。</div>`;
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
      return { events: [], notes: [], chains: [], score: [0, 0], poss: { home: 0, away: 0 }, seqs: 0, lineup: { home: side('home'), away: side('away') }, lastGoalAt: null, finished: false, half: 1, clock: 0 };
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
      /* **進球不另外算一次射門**:連續引擎每一腳射門都先發一筆 `shot`,進了才再發 `goal`。
         舊版是「shot 或 goal」二選一,照抄過來就會把每個進球算成兩次射門。 */
      return {
        shots: n('shot'),
        on: n('goal') + n('save'),
        blocked: n('block'),
        xg: ev.filter(e => e.type === 'shot').reduce((a, e) => a + (e.xg ?? 0), 0),
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
      match = createLiveMatch({ profile, home: state.home, away: state.away, pred: p, seed: state.seed,
        setup: { home: { ...setupOf('home') }, away: { ...setupOf('away') } } });
      disp = freshDisp();
      if (tab === 'recap') tab = 'stats';
      paused = false; running = true;
      box.innerHTML = `<div class="duel-stage">
        <div class="spread">
          <span class="pill bad" id="gMin"></span>
          <span class="tiny dim row" style="gap:6px;flex-wrap:wrap">
            <button class="btn tiny" id="gPause">暫停</button>
            速度 <select id="gSpeed">${Object.entries(LIVE_SPEEDS).map(([k, v]) => `<option value="${k}"${k === state.speed ? ' selected' : ''}>${v.zh}</option>`).join('')}</select>
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
          <div class="game-pitch"><canvas id="gCanvas" width="920" height="596" style="width:100%;height:auto;display:block;border-radius:10px"></canvas>
            <div class="tiny dim" id="gSeq" style="margin-top:4px;min-height:1.2em"></div>
            <div id="gProb" style="margin-top:8px"></div>
            <div class="tiny dim center" id="gNext" style="margin-top:4px"></div>
            <div id="gMomentum" style="margin-top:8px"></div>
          </div>
          <div class="game-panel">
            <div class="filters" id="gTabs"></div>
            <div id="gPanel"></div>
          </div>
        </div>
        <div id="gComm" class="game-comm"></div>
        <div class="tiny dim" id="gFoot" style="margin-top:8px"></div>
      </div>`;
      /* 背號給球場用:圓點上要印背號,不然二十二個點分不出誰是誰 */
      const shirts = {};
      for (const sd of ['home', 'away']) for (const [c, q] of squadOf(sd)) if (q.shirt != null) shirts[c] = q.shirt;
      const canvas = document.getElementById('gCanvas');
      pitch = mountPitch(canvas, {
        home: teamBy.get(state.home)?.colors ?? ['#00ff85', '#ffffff'],
        away: teamBy.get(state.away)?.colors ?? ['#04f5ff', '#0b2b28'],
        shirts,
      });
      for (const sd of ['home', 'away']) match.setTactics(sd, setupOf(sd).tactics ?? {});
      renderTabs();
      document.getElementById('gSpeed').onchange = e => { state.speed = e.target.value; };
      document.getElementById('gPause').onclick = () => {
        paused = !paused;
        document.getElementById('gPause').textContent = paused ? '繼續' : '暫停';
        lastTs = 0;                       // 暫停期間過的真實時間不算進比賽
        if (paused) { tab = 'lineup'; renderTabs(); renderPanel(); }
        uiTick();
      };
      document.getElementById('gSkip').onclick = skipToEnd;
      frame();
      loop();
      /* 面板與播報不必每一格重畫(一秒六十次會讓瀏覽器忙著排版)。
         球場自己在 rAF 裡畫,這裡只管文字那一半。切到別的分頁時 pageInterval 會被收掉,
         但 rAF 不會 —— 所以這裡同時看著畫布還在不在頁面上。 */
      C.pageInterval(() => {
        if (pitch && !document.body.contains(canvas)) { stop(); return; }
        frame();
      }, 250);
    }
    /* 主迴圈:真實時間 × 倍率 = 要推進的比賽秒數。**這裡沒有任何跳過** ——
       倍率高的時候人動得快,但每一格都算、每一格都畫。
       一格最多推進 0.5 秒比賽時間:分頁切回來時 `dt` 會是好幾秒,照實推進的話
       引擎要一次算幾百步,畫面會卡住一下(而且那幾秒的比賽沒有人看到)。 */
    function loop() {
      raf = requestAnimationFrame(loop);
      if (!match || !pitch || !running) return;
      const now = performance.now();
      const real = lastTs ? Math.min(0.5, (now - lastTs) / 1000) : 0;
      lastTs = now;
      if (!paused && !disp.finished) {
        const evs = match.advance(real * (LIVE_SPEEDS[state.speed]?.mult ?? 8));
        for (const e of evs) applyEvent(e);
        if (evs.length) { frame(); if (disp.finished) finish(); }
      }
      pitch.draw(match.pitch());
    }
    function finish() {
      running = false;
      if (disp) { disp.finished = true; tab = 'recap'; renderTabs(); }
      frame();
    }
    /* 跳到結果:把剩下的比賽用大步長推完(不畫),事件照樣逐筆套進顯示狀態 ——
       跟正常播放走的是**同一條路**,所以統計與事件流不會有第二套算法。 */
    function skipToEnd() {
      if (!match) return;
      let guard = 0;
      while (!match.state().finished && guard++ < 20000) {
        for (const e of match.advance(0.5)) applyEvent(e);
      }
      running = false; paused = false;
      disp.finished = true;
      tab = 'recap'; renderTabs();
      pitch?.draw(match.pitch());
      frame();
    }
    function stop() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      running = false; lastTs = 0; pitch = null;
    }

    /* 顯示的分鐘:**引擎自己算好的那一份**(`game-sim.js` 的 clockOf)。
       前端不要再算一次 —— 兩份在補時那幾分鐘一定會對不起來,而事件流印的是引擎那一份。 */
    function shownMinute() {
      if (!match || !disp) return { min: 0, extra: 0 };
      return match.state().clock;
    }
    function uiTick() {
      if (!disp) return;
      const $ = id => document.getElementById(id);
      const m = shownMinute();
      const label = `${m.min}${m.extra ? `+${m.extra}` : ''}`;
      const minEl = $('gMin');
      if (minEl) {
        minEl.innerHTML = disp.finished ? '完場' : `<span class="livedot"></span>第 ${label} 分鐘${paused ? '(暫停)' : ''}`;
        minEl.className = `pill ${disp.finished ? '' : 'bad'}`;
      }
      /* 勝率條走站上的即時模型(`predict-core.js`),吃的是 λ 的錨與現在的比分 / 紅牌。
         λ 整場不變是刻意的 —— 見 predHtml 那一段。 */
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
      if (foot) {
        const cal = match.calibration();
        foot.innerHTML = disp.finished ? `<img src="assets/img/duel-dice.webp" width="20" style="vertical-align:middle" ${HIDE}> 種子 ${state.seed} —— 「重播」用同一顆種子重現同一場。
        <b>這是遊戲模型,不是本站預測</b>:球與二十二個人用 1/60 秒的固定時步算,射門、角球、犯規、越位都是從場上長出來的,沒有劇本。
        進球沒有 Dixon-Coles 修正 —— 錨是 k = λ ÷ 期望射門 ÷ 每球 xG(主 ${cal.home?.k ?? '—'}、客 ${cal.away?.k ?? '—'};每球平均 xG ${cal.xgPerShotReal},來源 ${C.esc(cal.xgPerShotFrom)})——
        所以「沒有改動時 N 場的平均進球回得到站上的 λ」是統計上的等式,不是逐場相等。` : '';
      }
    }
    function renderComm() {
      const comm = document.getElementById('gComm');
      if (!comm || !disp) return;
      /* 播報:事件與回合備註(界外球、斷球…)混排,照發生順序;只留最近 14 行 */
      /* 連續引擎沒有「回合備註」那一層 —— 界外球 / 斷球在畫面上看得到,寫成一行文字只是噪音。
         留下來的是真正的事件。 */
      const items = disp.events.map((e, i) => ({ k: i, t: commentary(e) }));
      const lines = items.filter(x => x.t).sort((a, b) => a.k - b.k).slice(-14).reverse();
      comm.innerHTML = lines.map(x => `<div class="tiny">${x.t}</div>`).join('');
    }

    function playerName(side, code) { return match?.playerOf(side, code)?.name ?? code; }
    /* 播報。**只講引擎真的算出來的東西** —— 舊版印「運動戰 / 角球 / 快攻」那種情境分類與助攻,
       而連續引擎裡沒有那兩樣(進球是誰踢的有,球是怎麼來的沒有)。印一個猜的情境就是編數字。 */
    function commentary(e) {
      const t = e.team ? C.esc(nameOf(e.team)) : '';
      const m = `<span class="mono dim">${e.min}${e.extra ? `+${e.extra}` : ''}'</span>`;
      const who = e.name ? C.esc(e.name) : (e.player ? C.esc(playerName(e.side, e.player)) : '');
      switch (e.type) {
        case 'half': return `${m} 中場 ${e.score ? `${e.score[0]}:${e.score[1]}` : `${disp.score[0]}:${disp.score[1]}`}`;
        case 'full': return `${m} 完場 ${e.score[0]}:${e.score[1]}`;
        case 'goal': return `${m} ⚽ <b>${t} 進球!</b> ${who}(xG ${e.xg != null ? e.xg.toFixed(2) : '—'}) ${e.score[0]}:${e.score[1]}`;
        case 'shot': return `${m} ${t} ${who} 射門(${e.dist} 公尺,xG ${e.xg != null ? e.xg.toFixed(2) : '—'})`;
        case 'save': return `${m} <span class="dim">${t} ${who} 的射門被撲出</span>`;
        case 'block': return `${m} <span class="dim">${who} 封阻</span>`;
        case 'corner': return `${m} ${t} 角球`;
        case 'card': return `${m} ${e.card === 'red' ? '🟥' : '🟨'} ${t} ${who}${e.card === 'red' ? ' 兩黃罰下' : ' 黃牌'}`;
        case 'sub': return `${m} 🔁 ${t} ${who} 換 ${C.esc(e.offName ?? '')}`;
        case 'offside': return `${m} <span class="dim">${t} ${who} 越位</span>`;
        case 'foul': return null;            // 犯規太多,只進統計不進播報(一場二十次,印出來會把進球洗掉)
        default: return null;
      }
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
    /* 賽後解讀只在完場後掛出來 —— 比賽中它一個字都寫不出來(判讀要的是整場的分母),
       掛一個點了沒東西的按鈕比不掛更糟。反過來,完場時 finish() / skipToEnd() 會自己切過去,
       不靠讀者去找(「東西在但沒有按鈕」那條坑的反面)。 */
    function panelTabs() {
      const base = [['stats', '比賽統計'], ['events', '事件流'], ['lineup', '陣容與換人'], ['tactics', '戰術']];
      return disp?.finished ? [...base, ['recap', '賽後解讀']] : base;
    }
    /* 分頁列要**重畫**,不能只在開賽時寫一次 —— 完場才長出來的那一頁不重畫就沒有按鈕。
       實測:內容切過去了、分頁列還是四個,讀者看不出自己在哪一頁,也回不去。 */
    function renderTabs() {
      const host = document.getElementById('gTabs');
      if (!host) return;
      host.innerHTML = panelTabs().map(([k, z]) => `<button class="btn tiny${k === tab ? ' on' : ''}" data-tab="${k}">${z}</button>`).join('');
      host.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { tab = b.dataset.tab; renderTabs(); renderPanel(); }; });
    }
    function renderPanel() {
      const host = document.getElementById('gPanel');
      if (!host || !match || !disp) return;
      if (tab === 'stats') host.innerHTML = statsHtml();
      else if (tab === 'events') host.innerHTML = eventsHtml();
      else if (tab === 'lineup') host.innerHTML = lineupHtml();
      else if (tab === 'recap') host.innerHTML = recapHtml();
      else host.innerHTML = tacticsHtml();
      if (tab === 'lineup') bindSubs();
      if (tab === 'tactics') bindTactics();
    }
    function statsHtml() {
      const H = statsOf('home'), A = statsOf('away');
      const s = match.state();
      /* 控球的「目標」是從**兩隊真實的主客控球率**推的,式子在引擎裡(`possTarget`)——
         這裡不自己算一份:抄過來的話,改了引擎那邊的推法,這一頁會悄悄過期。
         模擬跑出來的是它自己踢出來的結果,兩個並排,讀者看得出這一場偏了多少。
         引擎不會把控球硬設成目標值:目標只是對照,不是模擬的輸入。 */
      const pTarget = match.possTarget();
      const tot = s.possSec.home + s.possSec.away;
      const ph = tot > 0 ? Math.round(100 * s.possSec.home / tot) : null;
      const row = (label, a, b, note = '') => `<div class="game-stat"><span>${a}</span><span class="dim tiny">${label}${note ? `<span class="dim"> ${note}</span>` : ''}</span><span>${b}</span></div>`;
      const l = match.lambdas();
      return `${row('控球 %', ph ?? '—', ph != null ? 100 - ph : '—', `持球秒數・目標 ${pTarget != null ? `${Math.round(pTarget)}:${100 - Math.round(pTarget)}` : '—'}`)}${row('射門', H.shots, A.shots)}${row('射正', H.on, A.on)}${row('被封阻', H.blocked, A.blocked)}
        ${row('xG', H.xg.toFixed(2), A.xg.toFixed(2), '逐射門')}${row('角球', H.corners, A.corners)}${row('犯規', H.fouls, A.fouls)}${row('越位', H.offsides, A.offsides)}${row('黃牌', H.yellow, A.yellow)}${row('紅牌', H.red, A.red)}
        ${row('λ(遊戲的錨)', l.home.toFixed(2), l.away.toFixed(2), '整場不變')}
        <div class="tiny dim" style="margin-top:6px">全部由<b>畫面上已經發生的事件</b>累計 —— 這個引擎不會算到未來,所以不會提前洩露還沒演的射門。
          控球 = 兩隊各持球多久(秒);目標那一欄是從兩隊<b>真實的主客控球率</b>推的,
          引擎只是把每一隊的護球能力接上去,實際踢出來多少是它自己的結果(所以會偏)。
          xG 是每一腳射門當下由距離與張角算的,水準校準到聯盟每球平均。
          <b>還沒做的</b>:十二碼、直接紅牌、助攻、進球情境分類(運動戰 / 角球 / 快攻)—— 沒做就不列,不放空欄位。</div>`;
    }
    /* 賽後解讀。判讀與敘述都在 game-diag.js(純函式,測得到);這裡只負責畫。
       讀的是 disp,不是 match.state() —— 完場之後兩者相同,但規矩只有一條才不會有人抄錯。 */
    function recapHtml() {
      const st = match.state();
      const t = tally({ events: disp.events, chains: match.chains(), poss: st.possSec });
      const diag = diagnose(t);
      const hn = nameOf(state.home), an = nameOf(state.away);
      const paras = recap(t, { homeName: hn, awayName: an, score: disp.score, diag });

      const byName = side => (side === 'home' ? hn : an);
      const ev = e => Object.entries(e).map(([k, v]) => `${k} ${v}`).join('、');
      /* 判讀不要用 .stat-line:它是 space-between 而且**不換行**,三個子元素會互相擠 ——
         實測 1280px 下隊名被壓成直排的「兵 / 工 / 廠」。這裡要的是一段話加一行依據,所以用普通區塊。 */
      const item = inner => `<div style="padding:6px 0;border-bottom:1px dashed var(--line-soft)">${inner}</div>`;
      const list = diag.length
        ? `<div style="margin-top:8px">${diag.map(d => item(`<b>${C.esc(byName(d.side))}</b>・${C.esc(d.text)}<div class="tiny dim" style="margin-top:2px">依據:${C.esc(ev(d.evidence))}</div>`)).join('')}</div>`
        : '';
      /* 「你調過的指令」那一區在連續引擎裡還沒有對應的紀錄(setTactics 不留歷史),
         所以先不畫 —— 畫一個永遠空的區塊比不畫更糟。 */
      const tac = '';
      return `<div style="display:grid;gap:8px">${paras.map(x => `<div>${C.esc(x.text)}</div>`).join('')}</div>${list}${tac}
        <div class="tiny dim" style="margin-top:8px">這是<b>這一場模擬</b>的讀法,不是本站對真實比賽的賽後報告 ——
        數字全部來自這一場演過的 ${match.chains().length} 次進攻,判讀的門檻是兩隊互比或這一場的絕對次數,沒有拿聯賽平均當尺。
        單場的樣本很小:同一組先發換一個亂數種子,結論可能就不一樣。</div>`;
    }
    function eventsHtml() {
      const evs = disp.events.filter(e => e.type !== 'foul' && e.type !== 'kickoff');
      if (!evs.length) return '<div class="tiny dim">還沒有事件。</div>';
      return `<div style="display:grid;gap:2px">${evs.slice().reverse().map(e => `<div class="stat-line">${commentary(e) ?? ''}</div>`).join('')}</div>`;
    }
    let subPick = { home: null, away: null };
    function lineupHtml() {
      const side = sd => {
        const L = disp.lineup[sd], sq = squadOf(sd);
        const btn = (c, where) => {
          const p = sq.get(c); const y = L.yellows.get(c);
          return `<button class="btn tiny${where === 'on' ? ' on' : ''}${subPick[sd]?.[where] === c ? ' primary' : ''}" data-sub-side="${sd}" data-sub-code="${c}" data-sub-where="${where}">${p?.shirt ?? '–'} ${C.esc(p?.name ?? c)} <span class="dim">${p?.role ?? p?.pos ?? ''}</span>${y ? ' 🟨' : ''}</button>`;
        };
        const reds = L.off.length - L.subs;
        return `<div class="card" style="margin-bottom:8px">
          <h3>${C.esc(nameOf(state[sd]))} <span class="dim tiny">${setupOf(sd).formation}・換人 ${L.subs}/5${reds > 0 ? `・紅牌 ${reds}` : ''}</span></h3>
          <div class="tiny dim">場上</div><div class="row" style="gap:4px;flex-wrap:wrap;margin:4px 0">${L.on.map(c => btn(c, 'on')).join('')}</div>
          <div class="tiny dim">替補席</div><div class="row" style="gap:4px;flex-wrap:wrap;margin:4px 0">${L.bench.map(c => btn(c, 'bench')).join('')}</div>
          ${L.off.length ? `<div class="tiny dim">已下場:${L.off.map(c => C.esc(sq.get(c)?.name ?? c)).join('、')}</div>` : ''}
          <div class="row" style="gap:6px;margin-top:6px"><button class="btn tiny" data-do-sub="${sd}">換人(點一個場上、一個替補)</button><span class="tiny dim" id="gSubMsg-${sd}"></span></div>
        </div>`;
      };
      return side('home') + side('away')
        + `<div class="tiny dim">換人<b>立刻</b>生效:換上來的人接手原本那個位置,下一格就在場上跑。
          這個引擎裡換人不改 λ —— 影響是從場上長出來的(他的最高速度、他站的位置)。
          <b>還沒做的</b>:自動換人(引擎不會自己換)、換人次數與窗口的規則、體能。</div>`;
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
          /* 合法性檢查在引擎裡(下場的人要在場上、上場的人要在板凳而且沒被用過)——
             畫面只負責把結果講出來,不要自己再寫一份規則。 */
          const ok = match.sub(sd, pk.on, pk.bench);
          msg.textContent = ok ? '換上場了' : '換不了(那個人不在場上,或替補已經用過)';
          if (ok) { subPick[sd] = null; renderPanel(); }
        };
      });
    }
    /* 戰術指令。**只列連續引擎真的接得到的兩軸**,其餘四個照實說還沒接 ——
       留著四個拉了不會有任何反應的按鈕,比沒有這四個更糟。
       每一級改多少是遊戲規則(壓迫 ±15%/級、防線 ±12.5%/級),刻意做小:
       大到會讓 λ 的錨失效的話,這一頁就在編數字了。 */
    function tacticsPanelHtml(sd) {
      const t = profile.teams[state[sd]], axes = profile.styleAxes ?? {};
      const cur = setupOf(sd).tactics ?? defaultTactics(state[sd]);
      const def = defaultTactics(state[sd]);
      const todo = TACTIC_TODO.map(k => axes[k]?.zh ?? k).join('、');
      return `<div class="card" style="margin-bottom:8px"><h3>${C.esc(nameOf(state[sd]))} <span class="dim tiny">戰術指令</span></h3>
        ${LIVE_TACTICS.map(k => { const a = axes[k] ?? { zh: k, levels: ['1', '2', '3', '4', '5'] }; const st = t.style?.[k]; return `
          <div class="tac-row" style="display:grid;grid-template-columns:52px 1fr;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid var(--line)">
            <span class="small"><b>${C.esc(a.zh)}</b></span>
            <span class="row" style="gap:3px;flex-wrap:wrap">${a.levels.map((z, i) => `<button class="btn tiny${cur[k] === i + 1 ? ' on' : ''}" data-tac-side="${sd}" data-tac-key="${k}" data-tac-level="${i + 1}">${C.esc(z)}${def[k] === i + 1 ? '<span class="dim">・本季</span>' : ''}</button>`).join('')}</span>
            <span></span><span class="tiny dim">本季實際:${st?.value != null ? `${st.value}${C.esc(st.unit ?? '')}(${C.esc(st.basis)},${st.n} 場${st.proxy ? ',代理指標' : ''})` : '沒有資料,預設中'}</span>
          </div>`; }).join('')}
        <div class="tiny dim" style="margin-top:6px">還沒接上新引擎的指令:${C.esc(todo)} —— 舊引擎有,連續引擎裡還沒有對應的旋鈕,所以不放按鈕。</div>
      </div>`;
    }
    function bindTactics() {
      document.querySelectorAll('[data-tac-key]').forEach(b => {
        b.onclick = () => {
          const { tacSide: sd, tacKey: k, tacLevel: lv } = b.dataset;
          const su = setupOf(sd); su.tactics = { ...(su.tactics ?? defaultTactics(state[sd])), [k]: Number(lv) };
          if (match) match.setTactics(sd, su.tactics);
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
      <p class="lede">選兩隊、調先發與陣型、開賽後隨時換人。球與二十二個人是<b>連續時間模擬</b>出來的 ——
        沒有劇本、沒有剪接,播放速度只是時間倍率。</p>
      <div class="card"><div id="gameBody"></div></div>
      <div class="note" style="margin-top:12px"><b>這張圖哪些是真的。</b>
        <b>真資料</b>:名單、背號、角色、陣型選項、<b>逐人最高速度</b>(FotMob,當成他跑步速度的上限)、
        兩隊的跑動節奏、各項事件率(射門 / 角球 / 犯規 / 黃牌 / 越位)、控球分布、壓迫強度
        (每 100 次對手傳球的抄截 + 攔截),以及進球的錨 λ(站上對這一場的預測)。
        <b>從模擬長出來的</b>:每一腳傳球、每一次射門、角球、界外球、越位、犯規與牌 ——
        它們不是抽出來的,是球跟人在場上互動的結果。射門的位置分佈校準過 ——
        平均離門距離與禁區內的比例都對著本站倉庫裡的 FotMob 逐場射門座標調,
        實際差多少每次都印在 <code>npm run game:sim</code> 的輸出裡(這一頁不抄那些數字,它們會變)。
        <b>遊戲規則</b>(沒有資料可以校準的部分):加速度與煞車上限、控球半徑、逼搶距離、
        折射的機率與角度、接球者的優勢、扣扳機的機率形狀、戰術指令每一級改多少。
        <b>還沒做的</b>:十二碼、直接紅牌、助攻、進球情境分類、體能、受傷、自動換人、
        六軸戰術裡的心態 / 寬度 / 節奏 / 直接度。<b>沒做的一律不放欄位</b>,不留空格子。
        <b>補時比真實的短</b>,那不是 bug:真實足球 90 分鐘裡球只活約 55 分鐘,而這支模擬的死球等待只有一兩秒,
        補時是照「這一半死掉多少時間」原樣補回去的。
        <b>跟真實管線的關係只有一條</b>:沒有任何改動時,N 場的平均進球回得到站上的 λ(統計上的等式,不是逐場相等);
        任何操作不寫回資料,也不影響站上任何一頁。</div>
      ${C.foot(data.meta)}`;
    renderControls();
  } catch (e) {
    app.innerHTML = `<div class="note bad">載入失敗:${C.esc(e.message)}</div>`;
    throw e;
  }
}
