import * as C from './core.js?v=e90d5ce3';
import { blendPair, sampleMatch, seededRng, inPlaySim } from './predict-core.js?v=a99cd006';

/* 對戰模擬(跨聯賽單一頁,掛盃賽旁邊 —— 2026-08-30 使用者要求不分聯賽)。
   誠實界線不變、全寫在畫面上:
   1. **機率跟站上完全同源** —— predict-core 是模型的逐行移植,golden 測試
      拿三個聯賽全部未賽場次守著等價。
   2. **對戰仍限同聯賽**:各聯賽的強度參數各自對自己的聯盟平均正規化,
      跨聯賽硬對戰等於編一個換算率。頁內用選單切聯賽,不用切換網站。
   3. 抽樣照實標示;球員對抗/位置/跑動沒有免費資料源,所以沒有。
   聯賽清單從註冊表長出來,不寫死(league() 那條坑)。
   隊徽不走全域登錄 —— 隊碼跨聯賽會撞(BUR),各聯賽自己一張表。 */

const app = document.getElementById('app');

try {
  const lgs = Object.keys(C.LEAGUES);
  const loaded = await Promise.all(lgs.map(async lg => {
    try {
      const { data } = await C.loadFrom(lg, ['meta', 'teams']);
      const sim = data.meta?.model?.sim;
      if (!sim || !Array.isArray(data.teams)) return null;
      return {
        lg, zh: C.LEAGUES[lg].zh, meta: data.meta, sim,
        teams: data.teams.filter(t => sim.teams[t.code]).sort((a, b) => a.en.localeCompare(b.en)),
        eloBy: new Map(data.teams.map(t => [t.code, t.elo])),
        crestBy: new Map(data.teams.map(t => [t.code, t.crest ?? null])),
      };
    } catch { return null; }
  }));
  const pools = loaded.filter(Boolean);
  if (!pools.length) throw new Error('沒有任何聯賽輸出模擬參數');
  C.nav();

  const state = {
    lg: pools[0].lg,
    home: pools[0].teams[0]?.code, away: pools[0].teams[1]?.code,
    neutral: false, seed: Math.floor(Math.random() * 1e9),
  };
  const cur = () => pools.find(x => x.lg === state.lg);

  // 隊徽用**該聯賽自己**的表 —— C.badge 走全域登錄,跨聯賽隊碼會撞
  const crest = code => {
    const c = cur().crestBy.get(code);
    return c ? `<img class="crest" src="${c}" alt="" width="26" height="26">` : '';
  };
  const nameOf = code => {
    const t = cur().teams.find(x => x.code === code);
    return t?.zh ?? t?.en ?? code;
  };

  /* 進球者權重:players-core(每聯賽各一份,懶載入+快取)。英冠沒有 → 不指名。 */
  const sharesCaches = new Map();
  async function sharesOf(code) {
    const L = cur();
    if (!sharesCaches.has(L.lg)) {
      try {
        const { data } = await C.loadFrom(L.lg, ['players-core']);
        sharesCaches.set(L.lg, data['players-core'] ?? []);
      } catch { sharesCaches.set(L.lg, []); }
    }
    const mine = sharesCaches.get(L.lg).filter(p => p.team === code);
    const bySeason = season => mine
      .map(p => ({ name: p.name, w: p.seasons.find(s => s.season === season)?.goals ?? 0 }))
      .filter(s => s.w > 0);
    const c = bySeason(L.meta.currentSeason);
    if (c.length) return { shares: c, season: L.meta.currentSeason };
    const l = bySeason(L.meta.lastSeason);
    return l.length ? { shares: l, season: L.meta.lastSeason } : { shares: null, season: null };
  }

  const teamSel = (id, curCode) => `<select id="${id}">${cur().teams.map(t =>
    `<option value="${t.code}"${t.code === curCode ? ' selected' : ''}>${C.esc(t.zh ?? t.en)}</option>`).join('')}</select>`;

  function predHtml() {
    const L = cur();
    if (state.home === state.away) return '<div class="note">兩邊選了同一隊 —— 換一隊再算。</div>';
    const p = blendPair(L.sim, state.home, state.away, L.eloBy.get(state.home), L.eloBy.get(state.away),
      { neutral: state.neutral });
    if (!p) return '<div class="note">這組隊伍算不出來(缺模型參數)。</div>';
    return `
      <div class="scoreline" style="margin:10px 0">
        <div class="side">${crest(state.home)}<b>${C.esc(nameOf(state.home))}</b></div>
        <div class="sc dim" style="font-size:15px">${state.neutral ? '中立場' : 'vs'}</div>
        <div class="side away">${crest(state.away)}<b>${C.esc(nameOf(state.away))}</b></div>
      </div>
      ${C.probBar(p)}
      <div class="tiny dim center" style="margin-top:6px">模型預期進球 ${p.xgHome} : ${p.xgAway}
        ・大 2.5 球 ${C.pct(p.over25, 0)}・雙方進球 ${C.pct(p.btts, 0)}</div>
      <div class="tiny dim center" style="margin-top:4px">最可能比分:${p.topScores.slice(0, 4)
        .map(s => `${s.s}(${C.pct(s.p, 1)})`).join('、')}</div>`;
  }

  /* 播放整場:分鐘走、比分跳、進球即時彈出、勝率條隨戰況動 ——
     勝率用跟實時頁同一顆 in-play 引擎(inPlaySim,golden 鎖等價)。
     計時器一律 C.pageInterval(裸 setInterval 是頁面切換不清那條老坑)。 */
  let playTimer = null;
  const SPEEDS = { slow: 260, normal: 130, fast: 55 };
  let speed = 'normal';

  async function runSim() {
    const box = document.getElementById('simout');
    const L = cur();
    if (!box || state.home === state.away) return;
    const p = blendPair(L.sim, state.home, state.away, L.eloBy.get(state.home), L.eloBy.get(state.away),
      { neutral: state.neutral });
    if (!p) return;
    const [hshare, ashare] = [await sharesOf(state.home), await sharesOf(state.away)];
    const rng = seededRng(state.seed);
    const m = sampleMatch(p, rng, { homeShares: hshare.shares, awayShares: ashare.shares });
    const seasonUsed = [...new Set([hshare.season, ashare.season].filter(Boolean))];
    const endMin = Math.max(90, ...m.events.map(e => e.min));

    if (playTimer) clearInterval(playTimer);
    let min = 0;

    const frame = () => {
      const done = min >= endMin;
      const seen = m.events.filter(e => e.min <= min);
      const hs = seen.filter(e => e.side === 'home').length;
      const as = seen.filter(e => e.side === 'away').length;
      const ip = inPlaySim({ lambdaHome: p.xgHome, lambdaAway: p.xgAway,
        hs, as, minute: min, finished: done });
      const line = e => `<div class="stat-line"><span class="small dim mono">${e.min}'</span>
        <span class="small">⚽ ${e.side === 'home' ? C.esc(nameOf(state.home)) : C.esc(nameOf(state.away))}
          ${e.scorer ? `—— ${C.esc(e.scorer)}` : '<span class="dim">(不指名:進球佔比樣本不足)</span>'}</span></div>`;
      const rows = [];
      for (const e of seen) rows.push(line(e));
      if (min >= 45) rows.splice(seen.filter(e => e.min <= 45).length, 0,
        `<div class="tiny dim center">—— 中場 ——</div>`);
      box.innerHTML = `
        <div class="spread"><span class="pill ${done ? '' : 'bad'}">${done ? '完場'
          : `<span class="livedot"></span>第 ${Math.min(min, 90)}${min > 90 ? '+' : ''} 分鐘`}</span>
          <span class="tiny dim">播放速度
            <select id="dSpeed">${Object.entries({ slow: '慢', normal: '正常', fast: '快' })
              .map(([k, zh]) => `<option value="${k}"${k === speed ? ' selected' : ''}>${zh}</option>`).join('')}</select>
            ${done ? '' : '<button class="btn tiny" id="dSkip">跳到結果</button>'}</span></div>
        <div class="scoreline" style="margin:8px 0">
          <div class="side">${crest(state.home)}<b>${C.esc(nameOf(state.home))}</b></div>
          <div class="sc">${hs} : ${as}</div>
          <div class="side away">${crest(state.away)}<b>${C.esc(nameOf(state.away))}</b></div>
        </div>
        ${C.probBar(ip)}
        ${done ? '' : `<div class="tiny dim center" style="margin-top:4px">剩餘期望進球 ${ip.xgRestHome} : ${ip.xgRestAway}
          ・下一球 ${C.esc(nameOf(state.home))} ${C.pct(ip.nextGoal.home, 0)} / ${C.esc(nameOf(state.away))} ${C.pct(ip.nextGoal.away, 0)}</div>`}
        ${rows.length ? `<div style="display:grid;gap:2px;margin-top:8px">${rows.join('')}</div>` : ''}
        ${done ? `<div class="tiny dim" style="margin-top:8px">種子 ${state.seed} —— 「重播」用同一顆種子重現同一場;「模擬一場」換一顆。
          比分抽自模型分布;進球分鐘均勻抽樣(分鐘分布未建模,純演出);
          進球者按${seasonUsed.length ? `${seasonUsed.join('/')} 實際進球佔比` : '實際進球佔比'}抽。
          勝率條用跟實時頁同一顆 in-play 引擎,對著「模擬出來的比分」計算。</div>` : ''}`;
      const sp = document.getElementById('dSpeed');
      if (sp) sp.onchange = e => { speed = e.target.value; restart(); };
      const sk = document.getElementById('dSkip');
      if (sk) sk.onclick = () => { min = endMin; frame(); if (playTimer) clearInterval(playTimer); };
    };
    const restart = () => {
      if (playTimer) clearInterval(playTimer);
      playTimer = C.pageInterval(() => {
        min++;
        frame();
        if (min >= endMin) clearInterval(playTimer);
      }, SPEEDS[speed]);
    };
    frame();
    restart();
  }

  function renderControls() {
    const host = document.getElementById('duelBody');
    host.innerHTML = `
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        <span class="small">主隊 ${teamSel('dHome', state.home)}</span>
        <button class="btn" id="dSwap" title="交換主客">⇄</button>
        <span class="small">客隊 ${teamSel('dAway', state.away)}</span>
        <label class="small" style="margin-left:8px"><input type="checkbox" id="dNeutral"${state.neutral ? ' checked' : ''}> 中立場(拿掉模型的主場優勢參數)</label>
      </div>
      <div id="pred" style="margin-top:12px"></div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn primary" id="dRun">模擬一場</button>
        <button class="btn" id="dReplay">重播同一場</button>
      </div>
      <div id="simout" style="margin-top:12px"></div>`;
    document.getElementById('pred').innerHTML = predHtml();
    const bind = (id, ev, fn) => { const n = document.getElementById(id); if (n) n[ev] = fn; };
    bind('dHome', 'onchange', e => { state.home = e.target.value; document.getElementById('pred').innerHTML = predHtml(); });
    bind('dAway', 'onchange', e => { state.away = e.target.value; document.getElementById('pred').innerHTML = predHtml(); });
    bind('dNeutral', 'onchange', e => { state.neutral = e.target.checked; document.getElementById('pred').innerHTML = predHtml(); });
    bind('dSwap', 'onclick', () => {
      [state.home, state.away] = [state.away, state.home];
      renderControls();
    });
    bind('dRun', 'onclick', () => { state.seed = Math.floor(Math.random() * 1e9); runSim(); });
    bind('dReplay', 'onclick', () => runSim());
  }

  app.innerHTML = `
    <h1>對戰模擬 <span class="dim">跨聯賽</span></h1>
    <p class="lede">選聯賽、選兩隊,用本站模型抽一場比賽。機率跟各聯賽賽程頁完全同源;抽出來的每一場都只是分布裡的一個樣本。</p>
    <div class="card">
      <div class="row" style="gap:8px;align-items:center">
        <span class="small">聯賽</span>
        ${pools.map(x => `<button class="btn tiny lgbtn" data-lg="${x.lg}">${C.esc(x.zh)}</button>`).join('')}
      </div>
      <div id="duelBody" style="margin-top:12px"></div>
    </div>
    <div class="note" style="margin-top:12px"><b>這是模擬遊戲,不是預測的斷言。</b>
      機率由本站模型(Dixon-Coles Poisson + Elo 取平均)算出,跟各聯賽賽程頁同一組數字
      —— 等價性有測試守著。比分抽自模型分布、進球分鐘均勻抽樣
      (真實的進球分鐘分布未建模)、進球者按球員實際進球佔比抽。
      球員對抗、位置拉扯與跑動<b>沒有免費資料源,所以這裡沒有</b> ——
      不是還沒做,是做了就是編數字。<b>跨聯賽對戰也不提供</b>:各聯賽的強度參數
      各自對自己的聯盟平均正規化,直接對戰等於編一個換算率 —— 用上面的選單切聯賽。</div>
    ${C.foot(pools[0].meta)}`;

  const markLg = () => document.querySelectorAll('.lgbtn').forEach(b =>
    b.classList.toggle('primary', b.dataset.lg === state.lg));
  document.querySelectorAll('.lgbtn').forEach(b => {
    b.onclick = () => {
      if (b.dataset.lg === state.lg) return;
      state.lg = b.dataset.lg;
      const L = cur();
      state.home = L.teams[0]?.code; state.away = L.teams[1]?.code;
      if (playTimer) clearInterval(playTimer);
      markLg(); renderControls();
    };
  });
  markLg();
  renderControls();
} catch (e) {
  app.innerHTML = `<div class="note bad">載入失敗:${C.esc(e.message)}</div>`;
  throw e;
}
