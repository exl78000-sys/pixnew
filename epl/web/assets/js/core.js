// 共用資料存取與 UI 元件(原生 ES module,不需要打包)
const cache = new Map();

export async function load(...names) {
  const out = {};
  await Promise.all(names.map(async n => {
    // 單檔打包版的資料直接內嵌在頁面裡,不用發請求
    if (globalThis.__DATA__?.[n]) { out[n] = globalThis.__DATA__[n]; return; }
    if (!cache.has(n)) cache.set(n, fetch(`data/${n}.json`).then(r => {
      if (!r.ok) throw new Error(`讀取 data/${n}.json 失敗(${r.status})`);
      return r.json();
    }));
    out[n] = await cache.get(n);
  }));
  return out;
}

/* ── 路由 ───────────────────────────── */
// 多頁模式:teams.html?code=ARS   單檔模式:#teams?code=ARS
export const BUNDLE = !!globalThis.__WARROOM_BUNDLE__;

export function link(page, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  return BUNDLE ? `#${page}${q ? '?' + q : ''}` : `${page}.html${q ? '?' + q : ''}`;
}
export const go = (page, params) => { location.href = link(page, params); };

export const qs = k => {
  if (BUNDLE) {
    const h = location.hash.slice(1), i = h.indexOf('?');
    return i < 0 ? null : new URLSearchParams(h.slice(i + 1)).get(k);
  }
  return new URLSearchParams(location.search).get(k);
};

export const currentPage = () => (BUNDLE
  ? location.hash.slice(1).split('?')[0] || 'index'
  : (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index');

/* ── 球隊 ───────────────────────────── */
let TEAMS = new Map();
// 顯示用的名稱登錄要涵蓋所有出現過的球隊(含已降級的),不然歷史表格會只剩三碼代號
export function registerTeams(list) {
  for (const t of list) TEAMS.set(t.code, { ...(TEAMS.get(t.code) ?? {}), ...t });
  return TEAMS;
}
export const team = code => TEAMS.get(code) ?? { code, en: code, zh: code, colors: ['#444', '#888'] };
// 顯示一律用英文隊名;中文名保留給球隊詳情頁做對照
export const name = code => team(code).en ?? team(code).zh ?? code;
export const zh = code => team(code).zh ?? code;

const luminance = hex => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function badge(code, size = '') {
  const t = team(code);
  // 有隊徽就用隊徽(已內嵌為 data URI);沒有才退回配色方塊
  if (t.crest) return `<img class="crest ${size}" src="${t.crest}" alt="${t.en ?? code}" title="${t.en ?? code}" loading="lazy" width="26" height="26">`;
  const bg = t.colors?.[0] ?? '#444';
  const fg = luminance(bg) > 0.55 ? '#12091a' : '#fff';
  return `<span class="badge ${size}" style="background:${bg};color:${fg}">${code}</span>`;
}
export function teamCell(code, { link: withLink = true, label: custom = null } = {}) {
  const label = custom ?? name(code);
  const inner = `<span class="team-cell">${badge(code)}<span class="nm">${label}</span></span>`;
  return withLink ? `<a href="${link('teams', { code })}" style="color:inherit;text-decoration:none">${inner}</a>` : inner;
}

/* ── 格式 ───────────────────────────── */
export const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
export const fx = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
export const signed = (v, d = 1) => (v > 0 ? '+' : '') + fx(v, d);
export const dateZh = s => (s ? `${s.slice(5, 7)}/${s.slice(8, 10)}` : '—');
export const dateFull = s => (s ? s.replace(/-/g, '/') : '—');
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const formRun = arr => `<span class="form-run">${(arr ?? []).map(f => `<i class="frm ${f}">${f}</i>`).join('')}</span>`;

export function probBar(p) {
  const seg = (cls, v, label) => `<span class="${cls}" style="flex:${Math.max(0.001, v)}" title="${label} ${pct(v)}">${v >= 0.13 ? pct(v, 0) : ''}</span>`;
  return `<span class="prob">${seg('h', p.home, '主勝')}${seg('d', p.draw, '和局')}${seg('a', p.away, '客勝')}</span>`;
}

export const bar = (v, max = 100, cls = '') =>
  `<span class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, (v / max) * 100))}%"></i></span>`;

/* ── 資料時效 ───────────────────────── */
// 這個站的資料來自好幾條不同節奏的管線:即時比分幾分鐘一次、賽程每天一次、
// 上季統計整季不動、教練名冊是人工整理的。全部混在同一頁時,讀者無從判斷
// 哪一塊是新的。所以每一頁的標題下面都標出「這一頁的數字有多新」。

export const ageText = (iso, now = Date.now()) => {
  if (!iso) return '未知';
  const min = Math.round((now - new Date(iso).getTime()) / 60000);
  if (min < 0) return '剛剛';
  if (min < 2) return '剛剛';
  if (min < 90) return `${min} 分鐘前`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr} 小時前`;
  return `${Math.round(hr / 24)} 天前`;
};

/* 一個資料來源的時效標記。
   kind: live(分鐘級)/ daily(每日重建)/ season(整季固定)/ manual(人工維護) */
const KIND = {
  live: { cls: 'accent', zh: '即時' },
  daily: { cls: 'info', zh: '每日更新' },
  season: { cls: '', zh: '整季固定' },
  manual: { cls: 'warn', zh: '人工維護' },
};

export function stamp(label, { iso = null, kind = 'daily', note = null } = {}) {
  const k = KIND[kind] ?? KIND.daily;
  const when = iso ? `${ageText(iso)}` : null;
  return `<span class="stamp" title="${esc(note ?? '')}">
    <span class="pill tiny ${k.cls}">${k.zh}</span>
    <span class="tiny dim">${esc(label)}${when ? `・${when}` : ''}</span></span>`;
}

// 頁面標題下的那一列時效標記
export const stampRow = items =>
  `<div class="stamp-row">${items.filter(Boolean).join('')}</div>`;

/* ── 導覽列 ─────────────────────────── */
const PAGES = [
  ['index', '總覽'],
  ['live', '實時戰況'],
  ['fixtures', '賽程預測'],
  ['analysis', '賽前分析'],
  ['teams', '球隊'],
  ['tactics', '戰術'],
  ['players', '球員'],
  ['coaches', '教練'],
  ['news', '動態'],
  ['model', '模型驗證'],
];
export function nav() {
  const here = currentPage();
  document.body.insertAdjacentHTML('afterbegin', `
    <header class="topbar"><div class="inner">
      <a class="brand" href="${link('index')}"><span class="dot"></span>英超戰情室<small>PL WAR ROOM</small></a>
      <nav class="tabs">${PAGES.map(([p, l]) =>
        `<a href="${link(p)}" class="${p === here ? 'on' : ''}">${l}</a>`).join('')}</nav>
    </div></header>`);
}

export function foot(meta) {
  return `<footer class="foot wrap">
    資料建置於 ${meta.builtAt.slice(0, 16).replace('T', ' ')} UTC・基準日 ${meta.asOf}・
    來源:${meta.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>`).join('、')}<br>
    模型:${meta.model.type}${meta.model.backtest.available
      ? `(回測 RPS ${meta.model.backtest.rps},優於基準線 ${meta.model.backtest.baselineRps})` : '(尚未回測)'}。
    預測僅供分析參考,不構成任何投注建議。
  </footer>`;
}

/* ── 倒數計時 ───────────────────────── */
// 開賽時間存的是 UTC,這裡一律換算成觀看者所在時區顯示。
export const kickoffLocal = iso => {
  if (!iso) return '—';
  const d = new Date(iso);
  // 不同年份的比賽(例如重播上季)要把年份標出來,不然 8/15 會被誤認為今年
  const opts = { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleString('zh-TW', opts);
};
export const tzName = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return '本地時間'; }
};

export function countdownText(iso, now = Date.now()) {
  const diff = new Date(iso).getTime() - now;
  if (diff <= 0) return { text: '已開賽・等待資料', past: true };
  const s = Math.floor(diff / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return { text: d > 0 ? `${d} 天 ${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`, past: false, soon: diff < 3600000 };
}

export const countdown = iso => `<span class="cd mono" data-kickoff="${iso}">${countdownText(iso).text}</span>`;

let cdTimer = null;
export function startCountdowns() {
  const tick = () => {
    const now = Date.now();
    for (const el of document.querySelectorAll('.cd[data-kickoff]')) {
      const { text, past, soon } = countdownText(el.dataset.kickoff, now);
      el.textContent = text;
      el.classList.toggle('past', past);
      el.classList.toggle('soon', !!soon);
    }
  };
  if (cdTimer) clearInterval(cdTimer);
  tick();
  cdTimer = setInterval(tick, 1000);
}

/* ── 依賽程推導比賽狀態 ─────────────── */
// 就算完全沒有即時資料源,光靠開賽時間也能知道「現在有哪幾場正在踢」。
// 注意:這裡算的是「開賽後經過幾分鐘」(含中場休息),不是比賽時鐘的分鐘數,
// 所以顯示時要講清楚,不能假裝知道現在是第幾分鐘。
const MATCH_WINDOW_MIN = 115;   // 90 分鐘 + 中場 15 + 傷停,寬估

export function scheduleState(fixture, now = Date.now()) {
  if (!fixture.kickoff) return { phase: fixture.played ? 'finished' : 'unknown' };
  const t = new Date(fixture.kickoff).getTime();
  const elapsed = Math.floor((now - t) / 60000);
  if (fixture.played) return { phase: 'finished', elapsed };
  if (elapsed < 0) return { phase: 'upcoming', elapsed };
  if (elapsed < MATCH_WINDOW_MIN) return { phase: 'inplay', elapsed };
  return { phase: 'awaiting', elapsed };   // 時間上早該結束,但還沒拿到賽果
}

// 開賽後經過的時間,轉成人看得懂的描述
export function elapsedText(elapsed) {
  if (elapsed < 0) return '尚未開賽';
  if (elapsed <= 47) return `開賽後約 ${elapsed} 分鐘`;
  if (elapsed <= 62) return '約中場休息';
  if (elapsed <= MATCH_WINDOW_MIN) return `開賽後約 ${elapsed} 分鐘(下半場)`;
  return `開賽後 ${Math.floor(elapsed / 60)} 小時`;
}

/* ── 抽屜 ───────────────────────────── */
let drawerEl, bgEl;
export function drawer(title, html) {
  // 換頁後舊節點會被移除,這裡要偵測並重建,否則抽屜開不起來
  if (drawerEl && !document.body.contains(drawerEl)) drawerEl = null;
  if (!drawerEl) {
    document.body.insertAdjacentHTML('beforeend',
      `<div class="drawer-bg" id="dbg"></div><aside class="drawer" id="dw">
        <div class="dh"><strong id="dwt"></strong><button class="x" id="dwx">×</button></div>
        <div class="db" id="dwb"></div></aside>`);
    drawerEl = document.getElementById('dw');
    bgEl = document.getElementById('dbg');
    const close = () => { drawerEl.classList.remove('open'); bgEl.classList.remove('open'); };
    bgEl.onclick = close;
    document.getElementById('dwx').onclick = close;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }
  document.getElementById('dwt').innerHTML = title;
  document.getElementById('dwb').innerHTML = html;
  drawerEl.classList.add('open');
  bgEl.classList.add('open');
  drawerEl.scrollTop = 0;
}

/* ── 賽後 / 場中報告(實時戰況頁與賽程頁共用)──── */
export function matchReportCards(m) {
  const H = m.sides[m.home], A = m.sides[m.away];
  const line = (l, hv, av) => `<div class="stat-line"><b class="mono">${hv}</b><span class="small muted">${l}</span><b class="mono">${av}</b></div>`;
  const xiHtml = s => `<div class="xi">
    ${s.xi.map(p => `<div class="p"><span><span class="pos">${p.pos}</span>${esc(p.name)}
      ${p.goals ? ` <span style="color:var(--accent)">⚽${p.goals > 1 ? p.goals : ''}</span>` : ''}
      ${p.assists ? ` <span class="dim">🅰${p.assists > 1 ? p.assists : ''}</span>` : ''}
      ${p.red ? ' <span style="color:var(--loss)">🟥</span>' : p.yellow ? ' <span style="color:var(--draw)">🟨</span>' : ''}</span>
      <span class="dim mono tiny">${p.minutes}'</span></div>`).join('')}
    ${s.bench.length ? `<div class="tiny dim" style="margin-top:6px">替補上場(時間為推估)</div>
      ${s.bench.map(p => `<div class="p sub"><span><span class="pos">${p.pos}</span>${esc(p.name)}
        ${p.goals ? ` <span style="color:var(--accent)">⚽${p.goals > 1 ? p.goals : ''}</span>` : ''}
        ${p.assists ? ' <span class="dim">🅰</span>' : ''}</span>
        <span class="dim mono tiny">≈${p.onAbout}' 上</span></div>`).join('')}` : ''}
  </div>`;

  return `
    ${m.notes.length ? `<div class="card"><h3>戰術解讀</h3>
      ${m.notes.map(n => `<div class="stat-line"><span class="small">・${esc(n.text)}</span></div>`).join('')}
    </div>` : ''}

    <div class="card"><h3>實際排出的陣容</h3>
      <div class="grid g2">
        <div><div class="row small" style="gap:7px;margin-bottom:6px">${badge(m.home)}<b>${name(m.home)}</b>
          <span class="pill">${H.shape.label}</span></div>
          <div class="tiny dim" style="margin-bottom:6px">${H.shape.shapeZh}
            ${H.seasonShape ? `・上季常態 ${H.seasonShape.label}` : ''}</div>
          ${xiHtml(H)}</div>
        <div><div class="row small" style="gap:7px;margin-bottom:6px">${badge(m.away)}<b>${name(m.away)}</b>
          <span class="pill">${A.shape.label}</span></div>
          <div class="tiny dim" style="margin-bottom:6px">${A.shape.shapeZh}
            ${A.seasonShape ? `・上季常態 ${A.seasonShape.label}` : ''}</div>
          ${xiHtml(A)}</div>
      </div>
      <div class="tiny dim" style="margin-top:10px">陣型依 FPL 的位置分類統計先發人數,邊鋒會被算進中場;
        換人時間由出場分鐘反推,標示 ≈ 者為推估值。</div>
    </div>

    <div class="card"><h3>數據對比</h3>
      <div class="row small dim" style="justify-content:space-between;margin-bottom:4px">
        <span>${name(m.home)}</span><span>${name(m.away)}</span></div>
      ${line('進球', m.hs ?? 0, m.as ?? 0)}
      ${line('期望進球 xG', H.xG, A.xG)}
      ${line('期望助攻 xA', H.xA, A.xA)}
      ${line('黃牌', H.yellow, A.yellow)}
      ${line('紅牌', H.red, A.red)}
      ${line('使用球員', H.used, A.used)}
      ${H.keeper && A.keeper ? line('門將撲救', H.keeper.saves, A.keeper.saves) : ''}
      ${H.keeper && A.keeper ? line('門將少失球', signed(H.keeper.stopped, 2), signed(A.keeper.stopped, 2)) : ''}
    </div>

    <div class="card"><h3>本場最佳(FPL 表現分)</h3>
      <div class="grid g2">
        <div>${H.best.map(b => `<div class="stat-line"><span class="small">${esc(b.name)}
          <span class="dim tiny">${b.pos} ${b.minutes}'</span></span><b class="mono">${b.bps}</b></div>`).join('')}</div>
        <div>${A.best.map(b => `<div class="stat-line"><span class="small">${esc(b.name)}
          <span class="dim tiny">${b.pos} ${b.minutes}'</span></span><b class="mono">${b.bps}</b></div>`).join('')}</div>
      </div>
    </div>`;
}

/* ── 可排序表格 ─────────────────────── */
export function table(rows, cols, { sortKey = null, desc = true, onRow = null, limit = null } = {}) {
  const id = `t${Math.random().toString(36).slice(2, 8)}`;
  let state = { key: sortKey, desc };

  const render = () => {
    let data = [...rows];
    if (state.key) {
      const col = cols.find(c => c.key === state.key);
      const get = col.sortValue ?? col.value;
      data.sort((a, b) => {
        const x = get(a), y = get(b);
        if (typeof x === 'string' || typeof y === 'string') return state.desc ? String(y).localeCompare(String(x)) : String(x).localeCompare(String(y));
        return state.desc ? (y ?? -Infinity) - (x ?? -Infinity) : (x ?? Infinity) - (y ?? Infinity);
      });
    }
    if (limit) data = data.slice(0, limit);
    // 表格預設靠右(數字才好比對),但隊伍欄的內容是 flex 排版,一定靠左顯示 ——
    // 表頭若還是靠右,標題就會飄到欄位的另一端,離自己的資料好幾百 px。
    // 這裡直接看第一列渲染出來的內容判斷,call site 不用逐一標註。
    const cellHtml = (c, r, i) => (c.render ? c.render(r, i) : c.value(r));
    const isLeft = c => c.left ?? (data.length > 0 && /class="team-cell"/.test(String(cellHtml(c, data[0], 0))));
    const cls = (c, extra = '') => [c.num ? 'num' : '', isLeft(c) ? 'left' : '', extra].filter(Boolean).join(' ');

    const head = cols.map(c =>
      `<th class="${cls(c, c.sortable === false ? '' : 'sortable') + (state.key === c.key ? ' sorted' : '')}" data-k="${c.key}" title="${c.title ?? ''}">${c.label}${state.key === c.key ? (state.desc ? ' ▾' : ' ▴') : ''}</th>`).join('');
    const body = data.map((r, i) =>
      `<tr class="${onRow ? 'clickable' : ''}" data-i="${rows.indexOf(r)}">${cols.map(c =>
        `<td class="${cls(c)}">${cellHtml(c, r, i)}</td>`).join('')}</tr>`).join('');
    const el = document.getElementById(id);
    el.querySelector('table').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
    el.querySelectorAll('th.sortable').forEach(th => {
      th.onclick = () => {
        const k = th.dataset.k;
        state = { key: k, desc: state.key === k ? !state.desc : true };
        render();
      };
    });
    if (onRow) el.querySelectorAll('tbody tr').forEach(tr => { tr.onclick = () => onRow(rows[+tr.dataset.i]); });
  };

  queueMicrotask(render);
  return `<div class="table-wrap" id="${id}"><table></table></div>`;
}

/* ── 雷達圖 ─────────────────────────── */
export function radar(series, { size = 300, labels = null, max = 100 } = {}) {
  const axes = labels ?? series[0].values.map(v => v.label);
  const n = axes.length;
  const cx = size / 2, cy = size / 2, R = size * 0.34;
  const pt = (i, r) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const rings = [0.25, 0.5, 0.75, 1].map(f =>
    `<polygon points="${axes.map((_, i) => pt(i, R * f).map(v => v.toFixed(1)).join(',')).join(' ')}"
      fill="none" stroke="#2b1f3d" stroke-width="1"/>`).join('');
  const spokes = axes.map((_, i) => {
    const [x, y] = pt(i, R);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2b1f3d" stroke-width="1"/>`;
  }).join('');
  const shapes = series.map(s => {
    const pts = s.values.map((v, i) => pt(i, R * Math.max(0.02, (v.value ?? 0) / max)).map(x => x.toFixed(1)).join(',')).join(' ');
    return `<polygon points="${pts}" fill="${s.color}22" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>` +
      s.values.map((v, i) => {
        const [x, y] = pt(i, R * Math.max(0.02, (v.value ?? 0) / max));
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${s.color}"/>`;
      }).join('');
  }).join('');
  const text = axes.map((a, i) => {
    const [x, y] = pt(i, R + 26);
    const anchor = Math.abs(x - cx) < 6 ? 'middle' : x > cx ? 'start' : 'end';
    return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="#a99cc4" font-size="11.5" text-anchor="${anchor}">${a}</text>`;
  }).join('');
  const legend = series.length > 1
    ? `<div class="row small" style="justify-content:center;margin-top:4px">${series.map(s =>
        `<span class="row" style="gap:5px"><i style="width:11px;height:11px;border-radius:3px;background:${s.color};display:inline-block"></i>${s.name}</span>`).join('')}</div>`
    : '';
  // 左右各留白,否則「定位球威脅」這種長標籤會被 viewBox 切掉
  const padX = 58, padY = 14;
  return `<svg class="radar" viewBox="${-padX} ${-padY} ${size + padX * 2} ${size + padY * 2}" role="img">${rings}${spokes}${shapes}${text}</svg>${legend}`;
}

/* ── 比分機率熱圖 ───────────────────── */
export function scoreHeat(grid, homeCode, awayCode) {
  const maxP = Math.max(...grid.flat());
  const colour = p => {
    const t = Math.pow(p / maxP, 0.6);
    return `rgba(0,255,133,${(t * 0.85).toFixed(3)})`;
  };
  const head = `<tr><th></th>${grid[0].map((_, y) => `<th class="num tiny">${y}</th>`).join('')}</tr>`;
  const rowsHtml = grid.map((row, x) =>
    `<tr><th class="num tiny">${x}</th>${row.map((p, y) =>
      `<td><div class="cell" style="background:${colour(p)}" title="${x}-${y}:${(p * 100).toFixed(1)}%">${(p * 100).toFixed(0)}</div></td>`).join('')}</tr>`).join('');
  return `<div class="small dim center" style="margin-bottom:6px">縱軸 ${name(homeCode)} 進球 × 橫軸 ${name(awayCode)} 進球(數字為 %)</div>
    <table class="heat">${head}${rowsHtml}</table>`;
}

/* ── 散點圖 ─────────────────────────── */
export function scatter(points, { w = 1000, h = 470, xLabel = '', yLabel = '', invertY = false, quadrants = true } = {}) {
  const pad = { l: 58, r: 22, t: 20, b: 46 };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const pad10 = (lo, hi) => { const d = (hi - lo) * 0.12 || 1; return [lo - d, hi + d]; };
  const [x0, x1] = pad10(Math.min(...xs), Math.max(...xs));
  const [y0, y1] = pad10(Math.min(...ys), Math.max(...ys));
  const X = v => pad.l + ((v - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const Y = v => {
    const t = (v - y0) / (y1 - y0);
    return pad.t + (invertY ? t : 1 - t) * (h - pad.t - pad.b);
  };
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
  const q = quadrants ? `
    <line x1="${X(mx)}" y1="${pad.t}" x2="${X(mx)}" y2="${h - pad.b}" stroke="#2b1f3d" stroke-dasharray="4 4"/>
    <line x1="${pad.l}" y1="${Y(my)}" x2="${w - pad.r}" y2="${Y(my)}" stroke="#2b1f3d" stroke-dasharray="4 4"/>` : '';
  // 標籤防重疊:同一區域已經有標籤就往下推,避免兩隊的代號疊在一起
  const placed = [];
  const dots = points.map(p => {
    const cx = X(p.x), cy = Y(p.y);
    let ly = cy + 4;
    while (placed.some(q => Math.abs(q.x - (cx + 9)) < 34 && Math.abs(q.y - ly) < 11)) ly += 11;
    placed.push({ x: cx + 9, y: ly });
    return `<g><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${p.color}" stroke="#0b0710" stroke-width="1.5">
      <title>${p.label}</title></circle>
      ${Math.abs(ly - (cy + 4)) > 2 ? `<line x1="${(cx + 7).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx + 9).toFixed(1)}" y2="${(ly - 3).toFixed(1)}" stroke="#3d2f52" stroke-width="1"/>` : ''}
      <text x="${(cx + 9).toFixed(1)}" y="${ly.toFixed(1)}" font-size="10.5" fill="#a99cc4">${p.code}</text></g>`;
  }).join('');
  return `<svg class="scatter" viewBox="0 0 ${w} ${h}" role="img">
    <rect x="${pad.l}" y="${pad.t}" width="${w - pad.l - pad.r}" height="${h - pad.t - pad.b}" fill="#ffffff05" stroke="#2b1f3d"/>
    ${q}${dots}
    <text x="${w / 2}" y="${h - 10}" text-anchor="middle" fill="#6f6389" font-size="12">${xLabel}</text>
    <text x="14" y="${h / 2}" text-anchor="middle" fill="#6f6389" font-size="12" transform="rotate(-90 14 ${h / 2})">${yLabel}</text>
  </svg>`;
}

/* ── 校準圖 ─────────────────────────────
   問題:「模型說 70% 會贏的比賽,實際是不是真的贏了 70%?」
   形式:預測值對實際值的散點 + y=x 參考線;點的大小代表樣本數。
   單一序列,所以不需要類別配色,也不需要圖例(標題已說明是什麼)。 */
export function calibrationChart(bins, { w = 620, h = 620 } = {}) {
  const pad = { l: 62, r: 20, t: 20, b: 56 };
  const X = v => pad.l + v * (w - pad.l - pad.r);
  const Y = v => h - pad.b - v * (h - pad.t - pad.b);
  const pts = bins.filter(b => b.n > 0 && b.predicted !== null);
  const maxN = Math.max(...pts.map(b => b.n), 1);

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const grid = ticks.map(t => `
    <line x1="${X(t).toFixed(1)}" y1="${pad.t}" x2="${X(t).toFixed(1)}" y2="${h - pad.b}" stroke="var(--line-soft)" stroke-width="1"/>
    <line x1="${pad.l}" y1="${Y(t).toFixed(1)}" x2="${w - pad.r}" y2="${Y(t).toFixed(1)}" stroke="var(--line-soft)" stroke-width="1"/>
    <text x="${X(t).toFixed(1)}" y="${h - pad.b + 20}" text-anchor="middle" font-size="11.5" fill="var(--ink-3)">${t * 100}%</text>
    <text x="${pad.l - 10}" y="${(Y(t) + 4).toFixed(1)}" text-anchor="end" font-size="11.5" fill="var(--ink-3)">${t * 100}%</text>`).join('');

  // 完美校準就是這條對角線 —— 參考線要收斂,不能搶過資料
  const diag = `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}"
    stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="5 5"/>
    <text x="${X(0.72)}" y="${(Y(0.72) - 10).toFixed(1)}" font-size="11.5" fill="var(--ink-3)"
      transform="rotate(-45 ${X(0.72)} ${Y(0.72)})">完美校準</text>`;

  const dots = pts.map(b => {
    const r = 5 + 9 * Math.sqrt(b.n / maxN);
    return `<circle cx="${X(b.predicted).toFixed(1)}" cy="${Y(b.actual).toFixed(1)}" r="${r.toFixed(1)}"
      fill="var(--accent)" fill-opacity="0.75" stroke="var(--panel-solid)" stroke-width="2">
      <title>預測 ${(b.predicted * 100).toFixed(1)}% → 實際 ${(b.actual * 100).toFixed(1)}%(${b.n} 個預測)</title></circle>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="校準圖:預測機率對實際發生率">
    <rect x="${pad.l}" y="${pad.t}" width="${w - pad.l - pad.r}" height="${h - pad.t - pad.b}"
      fill="none" stroke="var(--line)"/>
    ${grid}${diag}${dots}
    <text x="${(pad.l + w - pad.r) / 2}" y="${h - 12}" text-anchor="middle" font-size="12.5" fill="var(--ink-2)">模型預測的機率</text>
    <text x="16" y="${h / 2}" text-anchor="middle" font-size="12.5" fill="var(--ink-2)"
      transform="rotate(-90 16 ${h / 2})">實際發生的比例</text>
  </svg>`;
}

/* ── 逐輪折線圖 ─────────────────────────
   單一序列 + 一條基準線參考,同樣不需要圖例。 */
export function roundChart(rows, { w = 1000, h = 340, baseline = null, valueKey = 'rps', lower = true } = {}) {
  // 頂端留一條給基準線圖例用的空白帶,標註就不會壓到折線
  const pad = { l: 58, r: 22, t: baseline === null ? 20 : 42, b: 46 };
  const vals = rows.map(r => r[valueKey]);
  const lo = Math.min(...vals, baseline ?? Infinity) * 0.92;
  const hi = Math.max(...vals, baseline ?? -Infinity) * 1.06;
  const X = i => pad.l + (i / Math.max(1, rows.length - 1)) * (w - pad.l - pad.r);
  const Y = v => h - pad.b - ((v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);

  const yTicks = 4;
  const grid = [...Array(yTicks + 1)].map((_, i) => {
    const v = lo + (i / yTicks) * (hi - lo);
    return `<line x1="${pad.l}" y1="${Y(v).toFixed(1)}" x2="${w - pad.r}" y2="${Y(v).toFixed(1)}"
        stroke="var(--line-soft)" stroke-width="1"/>
      <text x="${pad.l - 10}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11.5" fill="var(--ink-3)">${v.toFixed(3)}</text>`;
  }).join('');

  // SVG 沒有測字寬的辦法,用中日韓全形 / 半形分開估,圖例才不會自己疊在一起
  const textW = t => [...t].reduce((a, c) => a + (c.codePointAt(0) > 0x2e80 ? 11.5 : 6.3), 0);
  const legendHint = lower ? '・越低越好,壓在線下才算有用' : '・越高越好';
  const legendW = textW(`基準線 ${(baseline ?? 0).toFixed(4)}${legendHint}`);

  // 基準線畫在圖上,說明放到頂端的空白帶當圖例,兩者不會互相遮擋
  const base = baseline === null ? '' : `
    <line x1="${pad.l}" y1="${Y(baseline).toFixed(1)}" x2="${w - pad.r}" y2="${Y(baseline).toFixed(1)}"
      stroke="var(--loss)" stroke-width="1.5" stroke-dasharray="6 4"/>
    <line x1="${(w - pad.r - legendW - 34).toFixed(1)}" y1="14" x2="${(w - pad.r - legendW - 8).toFixed(1)}" y2="14"
      stroke="var(--loss)" stroke-width="1.5" stroke-dasharray="6 4"/>
    <text x="${w - pad.r}" y="18" text-anchor="end" font-size="11.5"><tspan fill="var(--loss)"
      >基準線 ${baseline.toFixed(4)}</tspan><tspan fill="var(--ink-3)">${legendHint}</tspan></text>`;

  const d = rows.map((r, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(r[valueKey]).toFixed(1)}`).join(' ');
  const dots = rows.map((r, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(r[valueKey]).toFixed(1)}" r="4"
      fill="${r[valueKey] <= (baseline ?? Infinity) ? 'var(--accent)' : 'var(--loss)'}"
      stroke="var(--panel-solid)" stroke-width="1.5">
      <title>第 ${r.round} 輪・${r.games} 場・RPS ${r.rps}・命中率 ${(r.hitRate * 100).toFixed(0)}%</title></circle>`).join('');

  const xLabels = rows.filter((_, i) => i % 5 === 0 || i === rows.length - 1)
    .map(r => `<text x="${X(rows.indexOf(r)).toFixed(1)}" y="${h - pad.b + 20}" text-anchor="middle"
      font-size="11.5" fill="var(--ink-3)">${r.round}</text>`).join('');

  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="每一輪的預測準度">
    ${grid}${base}
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    ${dots}${xLabels}
    <text x="${(pad.l + w - pad.r) / 2}" y="${h - 10}" text-anchor="middle" font-size="12.5" fill="var(--ink-2)">輪次</text>
  </svg>`;
}

/* ── 折線圖(Elo 走勢) ─────────────── */
export function sparkline(values, { w = 320, h = 70, color = '#00ff85' } = {}) {
  if (!values.length) return '';
  const lo = Math.min(...values), hi = Math.max(...values);
  const X = i => (i / Math.max(1, values.length - 1)) * (w - 4) + 2;
  const Y = v => h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 10);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${X(values.length - 1).toFixed(1)}" cy="${Y(values.at(-1)).toFixed(1)}" r="3" fill="${color}"/>
  </svg>`;
}

export function fail(err) {
  document.querySelector('.wrap')?.insertAdjacentHTML('beforeend',
    `<div class="note">載入失敗:${esc(err.message)}<br>請先執行 <span class="mono">npm run build</span>,並用 <span class="mono">npm run serve</span> 開啟(直接用 file:// 開會被瀏覽器擋住)。</div>`);
  console.error(err);
}
