import * as C from './core.js?v=7d8fded0';

/* 跨聯賽球員搜尋(總球員頁)。各聯賽自己的球員頁照舊(搜本聯賽),
   這一頁是「一個框查全部聯賽」的入口。三個設計決定,都是踩過的坑:

   1. **聯賽從註冊表長出來,不寫死。**「不是英超就是西甲」那種二元式
      在只有兩個聯賽時看起來完全正確(league() 那條坑)。
   2. **各聯賽各自一張表,排序只在組內。** FPL 與 Understat 的口徑與
      xG 模型不同,混排強制排序等於做一個假的跨聯賽排行榜 —— 那是編數字。
   3. **整欄都是 null 的欄位不畫**(核心契約是聯集 + null:西甲沒有身價、
      英超逐場沒有射門)。個別 null 顯示 —、排序沉底 —— null 不是 0。 */

const app = document.getElementById('app');

/* 每個聯賽可能出現的欄位;某聯賽該欄整欄 null 就自動不畫。
   鍵名就是 players-core 的契約鍵,不另取名。 */
const STAT_COLS = [
  ['minutes', '分鐘'], ['goals', '進球'], ['assists', '助攻'],
  ['xG', 'xG'], ['xA', 'xA'], ['shots', '射門'], ['keyPasses', '關鍵傳球'],
  ['yellow', '黃牌'], ['red', '紅牌'],
];

try {
  C.nav();
  const lgs = Object.keys(C.LEAGUES);
  const loaded = await Promise.all(lgs.map(async lg => {
    try {
      const { data } = await C.loadFrom(lg, ['players-core']);
      return { lg, rows: data['players-core'] ?? null };
    } catch { return { lg, rows: null }; }
  }));
  const pools = loaded.filter(x => Array.isArray(x.rows) && x.rows.length);
  const missing = loaded.filter(x => !(Array.isArray(x.rows) && x.rows.length));

  // 每個池自己的賽季清單(兩邊賽季未必同步),預設最新的一季
  const state = new Map(pools.map(p => {
    const seasons = [...new Set(p.rows.flatMap(r => r.seasons.map(s => s.season)))].sort().reverse();
    return [p.lg, { seasons, season: seasons[0] }];
  }));
  let q = '';

  const statFor = (p, season) => p.seasons.find(s => s.season === season) ?? null;

  const poolSection = ({ lg, rows }) => {
    const L = C.LEAGUES[lg];
    const st = state.get(lg);
    const ql = q.trim().toLowerCase();
    const hit = ql
      ? rows.filter(p => p.name.toLowerCase().includes(ql)
        || (p.fullName ?? '').toLowerCase().includes(ql)
        || (p.team ?? '').toLowerCase() === ql)
      : rows;
    /* 欄位按「這一季這個池有沒有資料」決定 —— 不留永遠空白的欄位 */
    const has = key => hit.some(p => statFor(p, st.season)?.[key] != null);
    const cols = [
      { key: 'name', label: '球員', num: false, left: true, value: p => p.name,
        render: p => `${C.esc(p.name)}${p.fullName && p.fullName !== p.name
          ? ` <span class="dim tiny">${C.esc(p.fullName)}</span>` : ''}` },
      { key: 'team', label: '隊', num: false, value: p => p.team ?? '',
        render: p => C.esc(p.team ?? '—') },
      { key: 'pos', label: '位置', num: false, value: p => p.posZh ?? p.pos ?? '',
        render: p => C.esc(p.posZh ?? p.pos ?? '—') },
      ...(hit.some(p => p.age != null) ? [{ key: 'age', label: '年齡', num: true,
        value: p => p.age, render: p => p.age ?? '—' }] : []),
      ...(hit.some(p => p.price != null) ? [{ key: 'price', label: '身價', num: true,
        value: p => p.price, render: p => p.price != null ? `£${p.price}m` : '—' }] : []),
      ...STAT_COLS.filter(([k]) => has(k)).map(([k, label]) => ({
        key: k, label, num: true,
        value: p => statFor(p, st.season)?.[k],
        render: p => {
          const v = statFor(p, st.season)?.[k];
          return v == null ? '—' : (k === 'xG' || k === 'xA' ? C.fx(v, 2) : v);
        },
      })),
    ];
    const shown = ql ? hit : [...hit].sort((a, b) =>
      (statFor(b, st.season)?.minutes ?? -1) - (statFor(a, st.season)?.minutes ?? -1)).slice(0, 60);
    return `<div class="section"><h2>${C.esc(L.zh)}</h2>
        <span class="hint">${hit.length} 人${ql ? '符合' : `・未搜尋時列上場時間前 ${shown.length} 名`}</span></div>
      <div class="card">
        <div class="spread" style="margin-bottom:8px">
          <span class="tiny dim">賽季:
            <select data-season="${lg}">${st.seasons.map(s =>
              `<option value="${s}"${s === st.season ? ' selected' : ''}>${s}</option>`).join('')}</select></span>
          <span class="tiny dim">隊伍顯示隊碼・點任何一列進該聯賽的球員詳情</span>
        </div>
        ${hit.length ? C.table(shown, cols, {
          sortKey: ql ? null : 'minutes', desc: true,
          onRow: p => C.go('players', { code: p.code, league: lg }),
        }) : '<div class="note">這個聯賽沒有符合的球員。</div>'}
      </div>`;
  };

  const missingLine = ({ lg }) => {
    const L = C.LEAGUES[lg];
    return `<div class="note" style="margin-top:10px"><b>${C.esc(L.zh)}</b>:${
      C.esc(L.gapNote ?? '這個聯賽還沒有球員資料。')}</div>`;
  };

  const renderPools = () => {
    const host = document.getElementById('pools');
    if (host) host.innerHTML = pools.map(poolSection).join('')
      + missing.map(missingLine).join('');
    document.querySelectorAll('[data-season]').forEach(sel => {
      sel.onchange = () => { state.get(sel.dataset.season).season = sel.value; renderPools(); };
    });
  };

  app.innerHTML = `
    <h1>球員搜尋 <span class="dim">跨聯賽</span></h1>
    <p class="lede">一個框查所有聯賽的球員。點結果進該聯賽的球員頁看完整數據。</p>
    <div class="card">
      <input id="pq" type="search" placeholder="輸入球員名字(至少 2 個字母)或隊碼…"
        style="width:100%;box-sizing:border-box" autocomplete="off">
      <div class="tiny dim" style="margin-top:6px">
        同名不代表同一人;各聯賽的數據各自成池(資料源與 xG 模型不同),
        <b>不可直接互比</b> —— 所以排序只在各聯賽的表內進行,沒有跨聯賽排行榜。</div>
    </div>
    <div id="pools"></div>`;
  renderPools();

  const pq = document.getElementById('pq');
  pq.oninput = () => {
    const v = pq.value.trim();
    if (v === q) return;
    q = v.length >= 2 ? v : '';
    renderPools();
  };
  pq.focus();
} catch (e) {
  app.innerHTML = `<div class="note bad">載入失敗:${C.esc(e.message)}</div>`;
  throw e;
}
