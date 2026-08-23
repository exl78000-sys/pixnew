// 共用資料存取與 UI 元件(原生 ES module,不需要打包)
const cache = new Map();

export async function load(...names) {
  const out = {};
  await Promise.all(names.map(async n => {
    if (!cache.has(n)) cache.set(n, fetch(`data/${n}.json`).then(r => {
      if (!r.ok) throw new Error(`讀取 data/${n}.json 失敗(${r.status})`);
      return r.json();
    }));
    out[n] = await cache.get(n);
  }));
  return out;
}

/* ── 球隊 ───────────────────────────── */
let TEAMS = new Map();
// 顯示用的名稱登錄要涵蓋所有出現過的球隊(含已降級的),不然歷史表格會只剩三碼代號
export function registerTeams(list) {
  for (const t of list) TEAMS.set(t.code, { ...(TEAMS.get(t.code) ?? {}), ...t });
  return TEAMS;
}
export const team = code => TEAMS.get(code) ?? { code, zh: code, colors: ['#444', '#888'] };
export const zh = code => team(code).zh ?? code;

const luminance = hex => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function badge(code, size = '') {
  const t = team(code);
  const bg = t.colors?.[0] ?? '#444';
  const fg = luminance(bg) > 0.55 ? '#12091a' : '#fff';
  return `<span class="badge ${size}" style="background:${bg};color:${fg}">${code}</span>`;
}
export function teamCell(code, { link = true, name = null } = {}) {
  const label = name ?? zh(code);
  const inner = `<span class="team-cell">${badge(code)}<span class="nm">${label}</span></span>`;
  return link ? `<a href="teams.html?code=${code}" style="color:inherit;text-decoration:none">${inner}</a>` : inner;
}

/* ── 格式 ───────────────────────────── */
export const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
export const fx = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
export const signed = (v, d = 1) => (v > 0 ? '+' : '') + fx(v, d);
export const dateZh = s => (s ? `${s.slice(5, 7)}/${s.slice(8, 10)}` : '—');
export const dateFull = s => (s ? s.replace(/-/g, '/') : '—');
export const qs = k => new URLSearchParams(location.search).get(k);
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const formRun = arr => `<span class="form-run">${(arr ?? []).map(f => `<i class="frm ${f}">${f}</i>`).join('')}</span>`;

export function probBar(p) {
  const seg = (cls, v, label) => `<span class="${cls}" style="flex:${Math.max(0.001, v)}" title="${label} ${pct(v)}">${v >= 0.13 ? pct(v, 0) : ''}</span>`;
  return `<span class="prob">${seg('h', p.home, '主勝')}${seg('d', p.draw, '和局')}${seg('a', p.away, '客勝')}</span>`;
}

export const bar = (v, max = 100, cls = '') =>
  `<span class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, (v / max) * 100))}%"></i></span>`;

/* ── 導覽列 ─────────────────────────── */
const PAGES = [
  ['index.html', '總覽'],
  ['fixtures.html', '賽程預測'],
  ['teams.html', '球隊'],
  ['tactics.html', '戰術'],
  ['players.html', '球員'],
  ['coaches.html', '教練'],
  ['news.html', '動態'],
];
export function nav(active) {
  const here = active ?? location.pathname.split('/').pop() ?? 'index.html';
  document.body.insertAdjacentHTML('afterbegin', `
    <header class="topbar"><div class="inner">
      <a class="brand" href="index.html"><span class="dot"></span>英超戰情室<small>PL WAR ROOM</small></a>
      <nav class="tabs">${PAGES.map(([h, l]) =>
        `<a href="${h}" class="${h === here || (here === '' && h === 'index.html') ? 'on' : ''}">${l}</a>`).join('')}</nav>
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

/* ── 抽屜 ───────────────────────────── */
let drawerEl, bgEl;
export function drawer(title, html) {
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
    const head = cols.map(c =>
      `<th class="${c.num ? 'num' : ''} ${c.sortable === false ? '' : 'sortable'} ${state.key === c.key ? 'sorted' : ''}" data-k="${c.key}" title="${c.title ?? ''}">${c.label}${state.key === c.key ? (state.desc ? ' ▾' : ' ▴') : ''}</th>`).join('');
    const body = data.map((r, i) =>
      `<tr class="${onRow ? 'clickable' : ''}" data-i="${rows.indexOf(r)}">${cols.map(c =>
        `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r, i) : c.value(r)}</td>`).join('')}</tr>`).join('');
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
  return `<div class="small dim center" style="margin-bottom:6px">縱軸 ${zh(homeCode)} 進球 × 橫軸 ${zh(awayCode)} 進球(數字為 %)</div>
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
