import * as C from './core.js?v=e2cd8ffc';

/* 跨聯賽球員搜尋(總球員頁)。2026-08-30 改成**合併單表**(使用者要求),
   加隊徽與頭貼。設計決定,都是踩過的坑或明寫的界線:

   1. **聯賽從註冊表長出來,不寫死。**
   2. **合併顯示,但互比要標**:分鐘/進球/助攻是同一種事實,可以排序;
      xG/xA 兩邊模型不同(FPL vs Understat),欄位照出、警語常駐 ——
      每一列都掛聯賽籤,讀者知道自己在比什麼。
   3. **整欄都是 null 的欄位不畫**;個別 null 顯示 —、排序沉底(null 不是 0)。
   4. **隊徽與頭貼不走全域登錄** —— 隊碼跨聯賽會撞(BUR),各聯賽自己一張表。
      頭貼在各聯賽的 players.json(英超 3.2MB base64、西甲外連 CDN),
      **首屏不揹**:先畫表,背景載完再補畫 —— 搜尋功能不等圖。 */

const app = document.getElementById('app');

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
      const { data } = await C.loadFrom(lg, ['players-core', 'clubs']);
      const clubs = (data.clubs?.clubs ?? data.clubs ?? []);
      return { lg, rows: data['players-core'] ?? null,
        crestBy: new Map(clubs.map(c => [c.code, c.crest ?? null])) };
    } catch { return { lg, rows: null, crestBy: new Map() }; }
  }));
  const pools = loaded.filter(x => Array.isArray(x.rows) && x.rows.length);
  const missing = lgs.filter(lg => !pools.some(x => x.lg === lg));
  const crestOf = (lg, code) => pools.find(x => x.lg === lg)?.crestBy.get(code) ?? null;

  // 合併池:players-core 每列本來就帶 league 欄位
  const all = pools.flatMap(x => x.rows);
  const seasons = [...new Set(all.flatMap(p => p.seasons.map(s => s.season)))].sort().reverse();
  const state = { season: seasons[0], q: '' };

  /* 頭貼:背景懶載入,載完補畫。key 用 lg|code —— code 跨聯賽也可能撞 */
  const photoBy = new Map();
  let photosReady = false;
  (async () => {
    await Promise.all(pools.map(async x => {
      try {
        const { data } = await C.loadFrom(x.lg, ['players']);
        const list = data.players?.players ?? data.players ?? [];
        for (const p of list) if (p.photo && p.code != null) photoBy.set(`${x.lg}|${p.code}`, p.photo);
      } catch { /* 沒有就沒有(英冠),不擋表 */ }
    }));
    photosReady = true;
    renderTable();
  })();

  const statFor = p => p.seasons.find(s => s.season === state.season) ?? null;

  function renderTable() {
    const host = document.getElementById('pools');
    if (!host) return;
    const ql = state.q.toLowerCase();
    const hit = ql
      ? all.filter(p => p.name.toLowerCase().includes(ql)
        || (p.fullName ?? '').toLowerCase().includes(ql)
        || (p.team ?? '').toLowerCase() === ql)
      : all;
    const has = key => hit.some(p => statFor(p)?.[key] != null);
    const cols = [
      { key: 'lg', label: '聯賽', num: false, value: p => p.league,
        render: p => `<span class="pill tiny">${C.esc(C.LEAGUES[p.league]?.zh ?? p.league)}</span>` },
      { key: 'name', label: '球員', num: false, left: true, value: p => p.name,
        render: p => {
          const ph = photoBy.get(`${p.league}|${p.code}`);
          return `<span class="team-cell">${ph ? `<img src="${ph}" alt="" width="24" height="24"
              style="border-radius:50%;object-fit:cover" loading="lazy">` : ''}
            <span>${C.esc(p.name)}${p.fullName && p.fullName !== p.name
              ? ` <span class="dim tiny">${C.esc(p.fullName)}</span>` : ''}</span></span>`;
        } },
      { key: 'team', label: '隊', num: false, value: p => p.team ?? '',
        render: p => {
          const cr = crestOf(p.league, p.team);
          return `<span class="team-cell">${cr ? `<img class="crest" src="${cr}" alt="" width="20" height="20" loading="lazy">` : ''}
            <span>${C.esc(p.team ?? '—')}</span></span>`;
        } },
      { key: 'pos', label: '位置', num: false, value: p => p.posZh ?? p.pos ?? '',
        render: p => C.esc(p.posZh ?? p.pos ?? '—') },
      ...(hit.some(p => p.age != null) ? [{ key: 'age', label: '年齡', num: true,
        value: p => p.age, render: p => p.age ?? '—' }] : []),
      ...(hit.some(p => p.price != null) ? [{ key: 'price', label: '身價', num: true,
        value: p => p.price, render: p => p.price != null ? `£${p.price}m` : '—' }] : []),
      ...STAT_COLS.filter(([k]) => has(k)).map(([k, label]) => ({
        key: k, label, num: true,
        value: p => statFor(p)?.[k],
        render: p => {
          const v = statFor(p)?.[k];
          return v == null ? '—' : (k === 'xG' || k === 'xA' ? C.fx(v, 2) : v);
        },
      })),
    ];
    /* 未搜尋的預設視圖不能用全池分鐘排序 —— 兩聯賽輪次不同步時
       (實測西甲多踢一輪、球員 270 分 vs 英超 180),前 80 名會被單一聯賽
       整個填滿,看起來像「只有西甲」。改成各聯賽取前 40、按組內名次交錯,
       首屏兩邊都在;搜尋結果照舊全量。 */
    const shown = ql ? hit : (() => {
      const ranked = pools.flatMap(x => [...x.rows]
        .sort((a, b) => (statFor(b)?.minutes ?? -1) - (statFor(a)?.minutes ?? -1))
        .slice(0, 40).map((p, i) => ({ p, rank: i })));
      return ranked.sort((a, b) => a.rank - b.rank).map(r => r.p);
    })();
    host.innerHTML = `
      <div class="section"><h2>全部聯賽</h2>
        <span class="hint">${hit.length} 人${ql ? '符合' : `・未搜尋時各聯賽列上場時間前 40 名(交錯排列)`}
          ・賽季 <select id="pSeason">${seasons.map(s =>
            `<option value="${s}"${s === state.season ? ' selected' : ''}>${s}</option>`).join('')}</select></span></div>
      <div class="card">
        ${hit.length ? C.table(shown, cols, {
          /* 預設不帶排序鍵 —— 帶了會把交錯順序再排回去,西甲又霸榜;點表頭仍可排 */
          sortKey: null, desc: true,
          onRow: p => C.go('players', { code: p.code, league: p.league }),
        }) : '<div class="note">沒有符合的球員。</div>'}
        <div class="tiny dim" style="margin-top:8px">點任何一列進該聯賽的球員詳情。
          分鐘、進球、助攻是同一種事實,可跨聯賽排序;<b>xG/xA 兩邊模型不同</b>
          (FPL vs Understat),數字並列但不可直接互比 —— 每列的聯賽籤就是提醒。
          ${photosReady ? '' : '頭貼載入中…'}</div>
      </div>
      ${missing.map(lg => `<div class="note" style="margin-top:10px"><b>${C.esc(C.LEAGUES[lg]?.zh ?? lg)}</b>:${
        C.esc(C.LEAGUES[lg]?.gapNote ?? '這個聯賽還沒有球員資料。')}</div>`).join('')}`;
    const sel = document.getElementById('pSeason');
    if (sel) sel.onchange = e => { state.season = e.target.value; renderTable(); };
  }

  app.innerHTML = `
    <h1>球員搜尋 <span class="dim">跨聯賽</span></h1>
    <p class="lede">一個框查所有聯賽的球員,合併一張表。點結果進該聯賽的球員頁看完整數據。</p>
    <div class="card">
      <input id="pq" type="search" placeholder="輸入球員名字(至少 2 個字母)或隊碼…"
        style="width:100%;box-sizing:border-box" autocomplete="off">
      <div class="tiny dim" style="margin-top:6px">
        同名不代表同一人;各聯賽的數據各自成池(資料源與 xG 模型不同),
        xG/xA <b>不可直接互比</b> —— 合併只是省你切頁,每列的聯賽籤標明出處。</div>
    </div>
    <div id="pools"></div>`;
  renderTable();

  const pq = document.getElementById('pq');
  pq.oninput = () => {
    const v = pq.value.trim();
    const q = v.length >= 2 ? v : '';
    if (q === state.q) return;
    state.q = q;
    renderTable();
  };
  pq.focus();
} catch (e) {
  app.innerHTML = `<div class="note bad">載入失敗:${C.esc(e.message)}</div>`;
  throw e;
}
