import * as C from './core.js?v=7d8fded0';
import { blendPair, sampleMatch, seededRng } from './predict-core.js?v=a2765df2';

/* 對戰模擬(模擬遊戲第一步)。三條誠實界線,每一條都在畫面上講:
   1. **機率跟站上完全同源** —— predict-core 是模型的逐行移植,
      golden 測試拿三個聯賽全部未賽場次守著等價,不是「差不多的算法」。
   2. **抽樣照實標示**:比分從模型分布抽;進球分鐘均勻抽樣(分鐘分布
      未建模,純演出);進球者按該隊球員本季實際進球佔比抽,
      本季還沒人進球就退上季,再沒有就不指名 —— 不會發明一個射手。
   3. **球員對抗、位置拉扯、跑動沒有免費資料源,所以沒有** ——
      不是還沒做,是做了就是編數字。
   同聯賽限定:跨聯賽的強度參數不可互比(各自對自己聯盟平均正規化)。 */

const app = document.getElementById('app');

try {
  const { meta, clubs, teams } = await C.load('meta', 'clubs', 'teams');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const sim = meta.model.sim;
  if (!sim) throw new Error('這個聯賽的建置還沒輸出模擬參數(meta.model.sim)');
  const eloBy = new Map(teams.map(t => [t.code, t.elo]));
  const list = teams.filter(t => sim.teams[t.code]).sort((a, b) => a.en.localeCompare(b.en));

  /* 進球者權重:統一核心層(players-core)的本季進球;整隊 0 就退上季。
     懶載入 —— 按「模擬一場」才需要,首屏不揹這份。 */
  let sharesCache = null;
  async function sharesOf(code) {
    if (!sharesCache) {
      try {
        const { data } = await C.loadFrom(C.league(), ['players-core']);
        sharesCache = data['players-core'] ?? [];
      } catch { sharesCache = []; }
    }
    const mine = sharesCache.filter(p => p.team === code);
    const bySeason = season => mine
      .map(p => ({ name: p.name, w: p.seasons.find(s => s.season === season)?.goals ?? 0 }))
      .filter(s => s.w > 0);
    const cur = bySeason(meta.currentSeason);
    if (cur.length) return { shares: cur, season: meta.currentSeason };
    const last = bySeason(meta.lastSeason);
    return last.length ? { shares: last, season: meta.lastSeason } : { shares: null, season: null };
  }

  const state = {
    home: list[0]?.code, away: list[1]?.code,
    neutral: false, seed: Math.floor(Math.random() * 1e9),
  };

  const sel = (id, cur) => `<select id="${id}">${list.map(t =>
    `<option value="${t.code}"${t.code === cur ? ' selected' : ''}>${C.esc(t.zh ?? t.en)}</option>`).join('')}</select>`;

  function predHtml() {
    if (state.home === state.away) return '<div class="note">兩邊選了同一隊 —— 換一隊再算。</div>';
    const p = blendPair(sim, state.home, state.away, eloBy.get(state.home), eloBy.get(state.away),
      { neutral: state.neutral });
    if (!p) return '<div class="note">這組隊伍算不出來(缺模型參數)。</div>';
    return `
      <div class="scoreline" style="margin:10px 0">
        <div class="side">${C.badge(state.home)}<b>${C.esc(C.name(state.home))}</b></div>
        <div class="sc dim" style="font-size:15px">${state.neutral ? '中立場' : 'vs'}</div>
        <div class="side away">${C.badge(state.away)}<b>${C.esc(C.name(state.away))}</b></div>
      </div>
      ${C.probBar(p)}
      <div class="tiny dim center" style="margin-top:6px">模型預期進球 ${p.xgHome} : ${p.xgAway}
        ・大 2.5 球 ${C.pct(p.over25, 0)}・雙方進球 ${C.pct(p.btts, 0)}</div>
      <div class="tiny dim center" style="margin-top:4px">最可能比分:${p.topScores.slice(0, 4)
        .map(s => `${s.s}(${C.pct(s.p, 1)})`).join('、')}</div>`;
  }

  async function runSim() {
    const box = document.getElementById('simout');
    if (!box || state.home === state.away) return;
    const p = blendPair(sim, state.home, state.away, eloBy.get(state.home), eloBy.get(state.away),
      { neutral: state.neutral });
    if (!p) return;
    const [hs, as] = [await sharesOf(state.home), await sharesOf(state.away)];
    const rng = seededRng(state.seed);
    const m = sampleMatch(p, rng, { homeShares: hs.shares, awayShares: as.shares });
    const line = e => `<div class="stat-line"><span class="small dim mono">${e.min}'</span>
      <span class="small">⚽ ${e.side === 'home' ? C.esc(C.name(state.home)) : C.esc(C.name(state.away))}
        ${e.scorer ? `—— ${C.esc(e.scorer)}` : '<span class="dim">(不指名:該隊可用的進球佔比樣本不足)</span>'}</span></div>`;
    const seasonUsed = [...new Set([hs.season, as.season].filter(Boolean))];
    box.innerHTML = `
      <div class="scoreline" style="margin:8px 0">
        <div class="side">${C.badge(state.home)}<b>${C.esc(C.name(state.home))}</b></div>
        <div class="sc">${m.hs} : ${m.as}</div>
        <div class="side away">${C.badge(state.away)}<b>${C.esc(C.name(state.away))}</b></div>
      </div>
      ${m.events.length ? `<div style="display:grid;gap:2px">${m.events.map(line).join('')}</div>`
        : '<div class="tiny dim center">這一場沒有進球。</div>'}
      <div class="tiny dim" style="margin-top:8px">種子 ${state.seed} —— 「重播」用同一顆種子重現同一場;「再抽」換一顆。
        比分抽自模型分布;進球分鐘均勻抽樣(分鐘分布未建模,純演出);
        進球者按${seasonUsed.length ? `${seasonUsed.join('/')} 實際進球佔比` : '實際進球佔比'}抽。</div>`;
  }

  function render() {
    const el = document.getElementById('pred');
    if (el) el.innerHTML = predHtml();
  }

  app.innerHTML = `
    <h1>對戰模擬 <span class="dim">${C.esc(C.LEAGUES[C.league()]?.zh ?? '')}</span></h1>
    <p class="lede">任選兩隊,用本站模型抽一場比賽。機率跟賽程頁完全同源;抽出來的每一場都只是分布裡的一個樣本。</p>
    <div class="card">
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        <span class="small">主隊 ${sel('dHome', state.home)}</span>
        <button class="btn" id="dSwap" title="交換主客">⇄</button>
        <span class="small">客隊 ${sel('dAway', state.away)}</span>
        <label class="small" style="margin-left:8px"><input type="checkbox" id="dNeutral"> 中立場(拿掉模型的主場優勢參數)</label>
      </div>
      <div id="pred" style="margin-top:12px"></div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn primary" id="dRun">模擬一場</button>
        <button class="btn" id="dReplay">重播同一場</button>
      </div>
      <div id="simout" style="margin-top:12px"></div>
    </div>
    <div class="note" style="margin-top:12px"><b>這是模擬遊戲,不是預測的斷言。</b>
      機率由本站模型(Dixon-Coles Poisson + Elo 取平均)算出,跟賽程頁同一組數字
      —— 等價性有測試守著。抽樣的部分照實講:比分抽自模型分布、進球分鐘均勻抽樣
      (真實的進球分鐘分布未建模)、進球者按球員實際進球佔比抽。
      球員對抗、位置拉扯與跑動<b>沒有免費資料源,所以這裡沒有</b> ——
      不是還沒做,是做了就是編數字。跨聯賽對戰也不提供:兩個聯賽的強度參數
      各自對自己的聯盟平均正規化,直接對戰等於編一個換算率。</div>
    ${C.foot(meta)}`;

  render();
  const bind = (id, ev, fn) => { const n = document.getElementById(id); if (n) n[ev] = fn; };
  bind('dHome', 'onchange', e => { state.home = e.target.value; render(); });
  bind('dAway', 'onchange', e => { state.away = e.target.value; render(); });
  bind('dNeutral', 'onchange', e => { state.neutral = e.target.checked; render(); });
  bind('dSwap', 'onclick', () => {
    [state.home, state.away] = [state.away, state.home];
    document.getElementById('dHome').value = state.home;
    document.getElementById('dAway').value = state.away;
    render();
  });
  bind('dRun', 'onclick', () => { state.seed = Math.floor(Math.random() * 1e9); runSim(); });
  bind('dReplay', 'onclick', () => runSim());
} catch (e) {
  app.innerHTML = `<div class="note bad">載入失敗:${C.esc(e.message)}</div>`;
  throw e;
}
