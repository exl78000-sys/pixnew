import * as C from './core.js?v=6ce2cd6c';

const app = document.getElementById('app');

/* 跨聯賽搜尋結果塊(兩個渲染器共用一份 —— 複製會悄悄過期)。
   token 防過期回應蓋掉新輸入;隊伍顯示隊碼不顯示名字 ——
   隊名要載別的聯賽的名冊,而隊碼跨聯賽會重複,全域登錄解錯名字。 */
let xleagueToken = 0;
async function updateXLeague(q) {
  const host = document.getElementById('xleague');
  if (!host) return;
  if (!q || q.trim().length < 2) { host.innerHTML = ''; return; }
  const tok = ++xleagueToken;
  const hits = await C.crossLeaguePlayers(q.trim(), C.league());
  if (tok !== xleagueToken || !document.getElementById('xleague')) return;
  host.innerHTML = hits.length ? `<div class="note info" style="margin-top:10px">
    其他聯賽找到 ${hits.length} 筆:${hits.slice(0, 8).map(p =>
      `<a href="${C.link('players', { code: p.code, league: p.league })}">${C.esc(p.name)}
        <span class="dim tiny">(${C.esc(C.LEAGUES[p.league]?.zh ?? p.league)}・${C.esc(p.team ?? '')})</span></a>`).join('、')}
    ${hits.length > 8 ? `<span class="dim tiny">…等 ${hits.length} 筆,輸入更完整的名字縮小範圍</span>` : ''}
    <div class="tiny dim" style="margin-top:4px">同名不代表同一人;各聯賽的數據各自成池,不可直接互比。</div>
  </div>` : '';
}


/* 核心欄位(兩個聯賽共用)。這 20 欄以前兩個渲染器各寫一份,標題與順序
   還悄悄漂移(統一頁重構的動機就是這個);現在一份工廠、聯賽差異用參數注入:
   - statOf:FPL 的數字在 last/current 子物件(隨季別切換),西甲攤平在最上層
   - nameCell / teamCol:狀態徽章、跨隊標記這些聯賽特有的呈現
   - afterId:聯賽特有欄(FPL 的出場數、西甲的 games) */
function coreColumns({ statOf, nameCell, teamCol, afterId = [] }) {
  const POS_ORDER = ['GK', 'DEF', 'MID', 'FWD', 'D', 'M', 'F'];
  const n = (key, label, { fx = false, dash = false } = {}) => ({
    key, label, num: true,
    value: p => statOf(p)?.[key] ?? 0,
    render: fx ? (p => C.fx(statOf(p)?.[key], 2))
      : dash ? (p => statOf(p)?.[key] ?? '—')
      : undefined,
  });
  return [
    { key: 'name', label: '球員', value: p => p.name, left: true, render: nameCell },
    teamCol,
    { key: 'pos', label: '位置', value: p => POS_ORDER.indexOf(p.pos), render: p => C.esc(p.posZh ?? p.pos ?? '—') },
    { key: 'age', label: '年齡', value: p => p.age ?? 0, num: true, render: p => p.age ?? '—' },
    { key: 'squadNumber', label: '背號', value: p => p.squadNumber ?? 0, num: true,
      render: p => (p.squadNumber == null ? '—' : `${p.squadNumber}${C.numberSourceMark(p)}`) },
    ...afterId,
    n('minutes', '分鐘'), n('goals', '進球'), n('assists', '助攻'), n('ga', '進球參與'),
    n('xG', 'xG', { fx: true }), n('xA', 'xA', { fx: true }), n('xGI', 'xGI', { fx: true }),
    n('xg90', 'xG/90'), n('xa90', 'xA/90'), n('xgi90', 'xGI/90'),
    n('shots', '射門', { dash: true }), n('keyPasses', '關鍵傳球', { dash: true }),
    n('yellow', '黃牌', { dash: true }), n('red', '紅牌', { dash: true }),
  ];
}

try {
  const { meta, clubs, teams, players, leaders } = await C.load('meta', 'clubs', 'teams', 'players', 'leaders');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  /* 西甲的比賽統計來自 Understat，身分、背號、頭貼與生日由 SportMonks
     本地快取補充；前端只呈現資料層確實提供的欄位，沒有的資料明確標示。 */
  if (leaders.source === 'Understat') {
    renderUnderstat({ meta, clubs, teams, players, leaders });
    throw new Error('skip');
  }

  const byCode = new Map(players.map(p => [p.code, p]));
  // 本季 / 上季 —— 所有數字都明確標示是哪一季,不再混在一起
  const SEASONS = {
    current: { key: 'current', label: `本季 ${leaders.seasons.current}`, stat: p => p.current, q: p => p.qualifiedCurrent, radar: p => p.radarCurrent, team: p => p.team },
    last: { key: 'last', label: `上季 ${leaders.seasons.last}`, stat: p => p.last, q: p => p.qualified, radar: p => p.radar, team: p => p.lastTeam ?? p.team },
  };
  let mode = leaders.currentAvailable ? 'current' : 'last';
  const S = () => SEASONS[mode];
  const codes = [...new Set(players.map(p => p.team))].sort((a, b) => C.name(a).localeCompare(C.name(b), 'zh-Hant'));
  const POS = [['GK', '門將'], ['DEF', '後衛'], ['MID', '中場'], ['FWD', '前鋒']];
  let compare = [];

  const boardDefs = [
    ['scorers', '射手榜', '進球', v => v],
    ['assisters', '助攻榜', '助攻', v => v],
    ['xgi', '每 90 分鐘進球參與', 'xGI/90', v => C.fx(v, 2)],
    ['creators', '創造機會', 'xA/90', v => C.fx(v, 2)],
    ['finishers', '終結超出期望', '進球 − xG', v => C.signed(v, 1)],
    ['defenders', '後衛防守貢獻', '防守貢獻/90', v => C.fx(v, 2)],
    ['keepers', '門將撲救效率', '少失球數', v => C.signed(v, 1)],
    ['workhorses', '回收球', '回收/90', v => C.fx(v, 1)],
    ['youngGuns', '22 歲以下', '總得分', v => v],
    ['value', 'CP 值', '每百萬身價得分', v => C.fx(v, 1)],
    ['dreamteam', '單週最佳陣容', '入選次數', v => `${v} 次`],
    ['supersubs', '板凳奇兵', '先發率(越低越常替補上場)', v => C.fx(v, 2)],
  ];

  /* 帶 ?code= 就直接整頁畫該球員,不先畫列表 —— 列表的表格有延後綁定的排序處理,#app 被換掉之後會找不到節點而丟錯 */
  if (C.qs('code') && byCode.has(String(C.qs('code')))) { openPlayer(byCode.get(String(C.qs('code')))); throw new Error('skip'); }   // 模組頂層不能 return;skip 是這個檔既有的「到此為止」慣例

  app.innerHTML = `
  <div class="page-head">
    <h1>球員</h1>
    <p>${meta.counts.players} 名 ${meta.currentSeason} 註冊球員。數據分成<b>本季至今</b>與<b>上季完整賽季</b>兩套,
       用下面的按鈕切換 —— 每個數字都會標明是哪一季,不會混在一起。
       百分位是跟同位置、出場達門檻的球員相比;點球員看雷達圖,可勾選兩人對比。</p>
    ${C.stampRow([
      C.stamp(`本季至今(${leaders.currentRounds} 輪)`, { iso: meta.builtAt, kind: 'daily' }),
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
    ])}
  </div>

  <div class="filters" style="margin-bottom:0">
    <button class="btn" data-season="current">${SEASONS.current.label}</button>
    <button class="btn" data-season="last">${SEASONS.last.label}</button>
    <span class="dim small" id="seasonNote"></span>
  </div>
  <div id="seasonBanner"></div>

  <div class="section"><h2>排行榜</h2><span class="hint" id="boardHint"></span></div>
  <div class="grid g3" id="boards"></div>

  <div class="section"><h2>全部球員</h2><span class="hint">可排序、可篩選</span></div>
  <div class="filters">
    <input id="q" type="search" placeholder="搜尋球員…" style="min-width:180px">
    <select id="fTeam"><option value="">所有球隊</option>${codes.map(c => `<option value="${c}">${C.name(c)}</option>`).join('')}</select>
    <select id="fPos"><option value="">所有位置</option>${POS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
    <select id="fMin"><option value="0" selected>不限出場</option><option value="90">90 分鐘以上</option>
      <option value="600">600 分鐘以上</option><option value="1800">1800 分鐘以上</option></select>
    <button class="btn" id="cmpBtn">對比模式:關</button>
    <span class="dim small" id="count"></span>
  </div>
  <div id="cmpBox"></div>
  <div id="list"></div>
  <div id="xleague"></div>
  <div class="tiny dim" style="margin-top:8px">
    背號以 FPL 官方快照為主;快照沒有的,先用英超官方名單上的號碼補
    (那是零額外請求、既有排程就抓回來的),再不然才用單一來源的補件並標
    <span class="dim">*</span>。兩個來源對不上的一律不填 —— 掛錯號碼比留空更糟。
    仍然查不到的顯示「—」。</div>
  ${C.foot(meta)}`;

  function renderSeasonUI() {
    document.querySelectorAll('[data-season]').forEach(b => b.classList.toggle('on', b.dataset.season === mode));
    const boards = mode === 'current' ? leaders.current : leaders.last;
    document.getElementById('boardHint').textContent = mode === 'current'
      ? `本季 ${leaders.seasons.current} 至今(${leaders.currentRounds} 輪)`
      : `上季 ${leaders.seasons.last} 完整賽季・掛在當時效力的球隊`;
    document.getElementById('seasonNote').textContent = mode === 'current'
      ? `${meta.counts.currentSeasonPlayers} 名球員有本季出場紀錄`
      : `${meta.counts.poolSizes.MID + meta.counts.poolSizes.DEF + meta.counts.poolSizes.FWD + meta.counts.poolSizes.GK} 名球員達上季百分位門檻`;

    document.getElementById('seasonBanner').innerHTML = (mode === 'current' && !boards)
      ? `<div class="note" style="margin-top:10px"><b>本季 ${leaders.seasons.current} 還沒有逐球員數據</b> ——
          賽季剛開打,上游資料源要等該輪結束後才會發布。<br>
          上游釋出之後這一頁會自動填上本季數字。現在先看上季。</div>`
      : '';

    if (!boards) { document.getElementById('boards').innerHTML = ''; return; }
    document.getElementById('boards').innerHTML = boardDefs.map(([k, title, unit, fmt]) => `
      <div class="card"><h3>${title} <span class="dim tiny">${S().label}・${unit}</span></h3>
        ${(boards[k] ?? []).slice(0, 8).map((p, i) => `
          <div class="stat-line" style="cursor:pointer" data-p="${p.code}">
            <span class="small"><span class="dim mono">${String(i + 1).padStart(2)}</span>
              ${C.playerPhoto(byCode.get(p.code) ?? p, 28)} ${C.esc(p.name)}
              ${p.transferred ? `<span class="tiny dim">→ ${C.name(p.team)}</span>` : ''}</span>
            <b class="mono small">${fmt(p.value)}</b></div>`).join('') || '<div class="dim small">本季尚無資料</div>'}
      </div>`).join('');
    document.querySelectorAll('[data-p]').forEach(el => { el.onclick = () => C.go('players', { code: el.dataset.p }); });
  }

  document.querySelectorAll('[data-season]').forEach(b => {
    b.onclick = () => {
      if (b.dataset.season === 'current' && !leaders.current) { mode = 'current'; renderSeasonUI(); render(); return; }
      mode = b.dataset.season;
      renderSeasonUI();
      render();
    };
  });

  let cmpMode = false;
  document.getElementById('cmpBtn').onclick = e => {
    cmpMode = !cmpMode; compare = [];
    e.target.textContent = `對比模式:${cmpMode ? '開(點兩位球員)' : '關'}`;
    e.target.classList.toggle('on', cmpMode);
    document.getElementById('cmpBox').innerHTML = '';
    render();
  };

  const render = () => {
    const q = document.getElementById('q').value.trim().toLowerCase();
    const t = document.getElementById('fTeam').value;
    const pos = document.getElementById('fPos').value;
    const minMin = +document.getElementById('fMin').value;
    const rows = players.filter(p =>
      (!t || p.team === t) && (!pos || p.pos === pos) &&
      ((S().stat(p)?.minutes ?? 0) >= minMin) &&
      (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)));
    document.getElementById('count').textContent = `共 ${rows.length} 人`;
    updateXLeague(q);
    document.getElementById('list').innerHTML = C.table(rows, coreColumns({
      statOf: p => S().stat(p),
      nameCell: p => `${cmpMode ? `<input type="checkbox" ${compare.includes(p.code) ? 'checked' : ''} style="margin-right:6px">` : ''}${C.playerPhoto(p, 28)} ${C.esc(p.name)}${p.status !== 'a' ? ` <span class="pill bad tiny">${p.statusZh}</span>` : ''}`,
      teamCol: { key: 'team', label: '球隊', value: p => C.name(p.team), render: p => C.teamCell(p.team) },
      afterId: [{ key: 'appearances', label: '出場', value: p => mode === 'current' ? (p.appearances ?? 0) : 0, num: true, render: p => mode === 'current' ? (p.appearances ?? '—') : '—' }],
    }), { sortKey: 'minutes', desc: true, onRow: p => (cmpMode ? toggleCompare(p) : C.go('players', { code: p.code })) });
  };

  renderSeasonUI();

  ['q', 'fTeam', 'fPos', 'fMin'].forEach(id => {
    const el = document.getElementById(id);
    el.oninput = render; el.onchange = render;
  });
  render();

  // 從賽後陣容、即時戰況或外部連結帶入 ?code= 時，直接開該球員詳情；
  // 不要求使用者先在 599 人清單裡重新搜尋一次。
  if (C.qs('code')) app.insertAdjacentHTML('afterbegin', `<div class="note">找不到球員代碼 ${C.esc(String(C.qs('code')))} —— 可能是別的聯賽的球員,或已不在本季名單。</div>`);

  function toggleCompare(p) {
    compare = compare.includes(p.code) ? compare.filter(c => c !== p.code) : [...compare, p.code].slice(-2);
    render();
    const box = document.getElementById('cmpBox');
    if (compare.length < 2) { box.innerHTML = '<div class="note info">已選 ' + compare.length + ' 人,再選一位即可對比。</div>'; return; }
    const [a, b] = compare.map(c => byCode.get(c));
    if (a.pos !== b.pos) { box.innerHTML = `<div class="note">${a.name}(${a.posZh})與 ${b.name}(${b.posZh})位置不同,雷達軸不一樣,只列數據對照。</div>${statTable(a, b)}`; return; }
    box.innerHTML = `<div class="card"><h3>${C.esc(a.name)} vs ${C.esc(b.name)}</h3>
      ${C.radar([
        { name: a.name, color: '#00ff85', values: a.radar },
        { name: b.name, color: '#04f5ff', values: b.radar },
      ], { size: 320 })}
      ${statTable(a, b)}</div>`;
  }

  const statTable = (a, b) => {
    const rows = [
      ['出場分鐘', 'minutes', 0], ['進球', 'goals', 0], ['助攻', 'assists', 0],
      ['xG', 'xG', 2], ['xA', 'xA', 2], ['xGI/90', 'xgi90', 2],
      ['終結超出期望', 'finishing', 1], ['防守貢獻/90', 'defCon90', 2], ['總得分', 'points', 0],
    ];
    return `<div style="margin-top:10px">${rows.map(([l, k, d]) => `
      <div class="stat-line"><b class="mono">${a.last ? C.fx(a.last[k], d) : '—'}</b>
        <span class="small muted">${l}</span>
        <b class="mono">${b.last ? C.fx(b.last[k], d) : '—'}</b></div>`).join('')}</div>`;
  };

  /* 跑動、最高速度與觸球熱區(FotMob 追蹤資料,2026-09-03 接進來)。不是每場都有,場數另記;
     熱區是 6×4 格的觸球位置計數,正規化成向右進攻(自家球門在左)。沒有資料整張不畫。 */
  function trackingCard(p, t) {
    const tr = p.tracking;
    if (!tr || (tr.distancePerGame == null && !tr.heat && !tr.rating)) return '';
    const line = (l, v) => `<div class="stat-line"><span class="small muted">${l}</span><b class="mono">${v}</b></div>`;
    const heat = tr.heat?.grid?.length === 24 ? (() => {
      const W = 240, H = 156, gx = 6, gy = 4, mx = Math.max(1, ...tr.heat.grid);
      const cells = tr.heat.grid.map((v, i) => {
        const cx = i % gx, cy = Math.floor(i / gx);
        return `<rect x="${(cx * W / gx).toFixed(1)}" y="${(cy * H / gy).toFixed(1)}" width="${(W / gx).toFixed(1)}" height="${(H / gy).toFixed(1)}" fill="${t.colors?.[0] ?? '#00ff85'}" fill-opacity="${(0.08 + 0.85 * v / mx).toFixed(2)}"><title>${v} 次觸球</title></rect>`;
      }).join('');
      return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;border-radius:8px;background:#0a1018;margin-top:8px">
        <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="var(--line)"/>
        ${cells}<line x1="${W / 2}" y1="0" x2="${W / 2}" y2="${H}" stroke="rgba(255,255,255,.35)"/>
        <circle cx="${(tr.heat.cx / 105 * W).toFixed(1)}" cy="${(tr.heat.cy / 68 * H).toFixed(1)}" r="5" fill="#fff"/></svg>
        <div class="tiny dim">自家球門在左、攻向右;白點是 ${tr.heat.touches} 次觸球的質心(${tr.heat.games} 場)。</div>`;
    })() : '';
    return `<div class="card"><h3>跑動、熱區與評分 <span class="dim tiny">FotMob</span></h3>
      ${tr.distancePerGame != null ? line('場均跑動', `${(tr.distancePerGame / 1000).toFixed(1)} km <span class="dim">・${tr.games} 場</span>`) : ''}
      ${tr.topSpeed != null ? line('最高速度', `${tr.topSpeed.toFixed(1)} km/h`) : ''}
      ${tr.rating ? line('平均評分', `${tr.rating.avg.toFixed(2)} <span class="dim">・${tr.rating.games} 場・FotMob</span>`) : ''}
      ${heat}
      <div class="tiny dim" style="margin-top:8px">供應商的追蹤資料,不是每場都有(2025-26 起);本站只搬運不推估。跟上面 FPL 的 per-90 是不同來源。</div>
    </div>`;
  }

  function openPlayer(p) {
    const t = C.team(p.team);
    const pctLine = (label, v, raw) => `
      <div style="margin-bottom:7px"><div class="row small" style="justify-content:space-between">
        <span class="muted">${label}</span><span class="mono">${raw ?? '—'}${v === null ? '' : ` <span class="dim">(${v} 分位)</span>`}</span></div>
      ${C.bar(v ?? 0, 100, v >= 80 ? '' : v >= 50 ? 'alt' : 'hot')}</div>`;
    const line = (l, v) => `<div class="stat-line"><span class="small muted">${l}</span><b class="mono">${v}</b></div>`;
    // 角色與高光:平均值看不出來的兩件事
    const roleCard = st => {
      if (!st) return '';
      const rows = [
        st.dreamteam > 0 ? line('入選官方單週最佳陣容', `${st.dreamteam} 次`) : '',
        st.startRate !== null && st.startRate !== undefined
          ? line('先發率', `${C.fx(st.startRate, 2)}${st.startRate >= 0.95 ? ' (幾乎場場先發)' : st.startRate < 0.8 ? ' (常從板凳上場)' : ''}`) : '',
      ].filter(Boolean);
      return rows.length ? `<div class="card"><h3>角色與高光</h3>${rows.join('')}
        <div class="tiny dim" style="margin-top:8px">最佳陣容是每輪選出的單週最佳 11 人,計數不是平均 ——
          它抓的是「打出過幾次亮眼表現」,跟上面的 per-90 平均值互補。
          先發率 = 先發次數 ÷(出場分鐘/90),1.0 代表上場就是先發。</div></div>` : '';
    };

    /* 完整頁,不是抽屜(2026-09-04,使用者要求):整頁換成這個球員,上方留回列表與回球隊的路 */
    playerPage(`${C.playerPhoto(p, 56)} ${C.esc(p.fullName ?? p.name)}`, `${t.en}・${p.posZh}`, `
      <div class="card">
        <div class="spread">
          <div><div style="font-size:19px;font-weight:800">${C.esc(p.fullName)}</div>
            <div class="small muted">${p.posZh}・${p.age ?? '?'} 歲・${t.en}
              ${p.squadNumber ? `・背號 ${p.squadNumber}${C.numberSourceMark(p)}` : ''}・£${p.price.toFixed(1)}m</div></div>
          ${p.status !== 'a' ? `<span class="pill bad">${p.statusZh}</span>` : '<span class="pill accent">可出賽</span>'}
        </div>
        ${p.news ? `<div class="note" style="margin-top:10px">${C.esc(p.news)}</div>` : ''}
        ${p.transferred ? `<div class="note info" style="margin-top:10px">上季效力 ${C.name(p.lastTeam)},本季已加盟 ${t.en};下方數據為在原隊的表現。</div>` : ''}
        ${p.isNewFace ? '<div class="note info" style="margin-top:10px">上季沒有英超出場紀錄(新援、新秀或長期缺陣),沒有可比較的數據。</div>' : ''}
      </div>

      ${(() => {
        const useCurrent = mode === 'current' && p.radarCurrent && p.qualifiedCurrent;
        const radar = useCurrent ? p.radarCurrent : (p.qualified ? p.radar : null);
        if (!radar) return '';
        return `<div class="card"><h3>能力雷達 <span class="dim tiny">${useCurrent ? `本季 ${leaders.seasons.current}` : `上季 ${leaders.seasons.last}`}</span></h3>
          ${C.radar([{ name: p.name, color: t.colors[0], values: radar }], { size: 300 })}
          <div class="tiny dim center">與同位置、出場達門檻的球員相比的百分位</div>
          <div style="margin-top:12px">${radar.map(r => pctLine(r.label, r.value, r.raw)).join('')}</div>
        </div>`;
      })()}

      ${roleCard(mode === 'current' ? p.current : p.last)}
      ${trackingCard(p, t)}

      ${p.current ? `<div class="card"><h3>本季至今(${leaders.seasons.current})
          <span class="dim tiny">${p.appearances} 場</span></h3>
        ${line('出場 / 先發', `${p.current.minutes} 分鐘 / ${p.current.starts} 場`)}
        ${line('進球 / 助攻', `${p.current.goals} / ${p.current.assists}`)}
        ${line('期望進球 xG / 助攻 xA', `${p.current.xG} / ${p.current.xA}`)}
        ${line('每 90 分鐘進球參與 xGI', p.current.xgi90)}
        ${line('防守貢獻 / 90', p.current.defCon90)}
        ${line('FPL 得分', p.current.points)}
      </div>` : `<div class="note info">本季 ${leaders.seasons.current} 尚無出場資料。</div>`}

      ${p.last ? `<div class="card"><h3>上季完整賽季(${meta.lastSeason})</h3>
        ${line('出場 / 先發', `${p.last.minutes} 分鐘 / ${p.last.starts} 場`)}
        ${line('進球 / 助攻', `${p.last.goals} / ${p.last.assists}`)}
        ${line('期望進球 xG / 助攻 xA', `${p.last.xG} / ${p.last.xA}`)}
        ${line('終結超出期望', C.signed(p.last.finishing, 2))}
        ${line('每 90 分鐘進球參與 xGI', p.last.xgi90)}
        ${p.pos === 'GK' ? line('撲救 / 90・少失球', `${p.last.saves90} ・ ${C.signed(p.last.shotStop, 1)}`) : ''}
        ${line('防守貢獻 / 90', p.last.defCon90)}
        ${line('搶斷 / 解圍攔截 / 回收(每 90)', `${p.last.tackles90} / ${p.last.cbi90} / ${p.last.recoveries90}`)}
        ${line('零封率', `${p.last.csRate}%`)}
        ${line('黃紅牌加權', p.last.cards)}
        ${line('FPL 總得分', p.last.points)}
      </div>` : ''}

      ${p.setPieces.pen || p.setPieces.fk || p.setPieces.corner ? `<div class="card"><h3>定位球順位</h3>
        ${p.setPieces.pen ? line('十二碼', `第 ${p.setPieces.pen} 順位`) : ''}
        ${p.setPieces.fk ? line('直接自由球', `第 ${p.setPieces.fk} 順位`) : ''}
        ${p.setPieces.corner ? line('角球 / 間接球', `第 ${p.setPieces.corner} 順位`) : ''}
      </div>` : ''}
      <div><a href="${C.link('teams', { code: p.team })}">看 ${t.en} 的完整剖析 →</a></div>`, { code: p.code, league: 'pl' });
  }

} catch (err) { if (err.message !== 'skip') C.fail(err); }

/* 球員的完整頁:把 #app 換成這個球員。抽屜版 2026-09-04 移除 —— 簡版跟完整版差不多,留兩份就會分岔。 */
function playerPage(title, sub, body, { code = null, league = 'pl' } = {}) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="page-head">
      <div class="row small" style="gap:12px;margin-bottom:6px"><a href="${C.link('players')}">← 球員列表</a></div>
      <h1 class="row" style="gap:10px;align-items:center">${title}</h1>
      <p>${sub}</p>
    </div>
    <div class="player-page">${body}<div id="playerLog"></div></div>`;
  window.scrollTo(0, 0);
  if (code) matchLogCard(code, league);
}

/* 逐場紀錄(2026-09-04):進完整頁才載 player-logs.json(668 人 × 幾十場,不塞進 players.json)。
   每列全部來自 FotMob 逐場快取:分鐘、評分、進球、助攻、射門、關鍵傳球、逐射門 xG 合計、跑動;
   沒有那一場資料的欄位印「—」,不推估。沒有這個人的紀錄整張不畫。 */
async function matchLogCard(code, league) {
  const host = document.getElementById('playerLog');
  if (!host) return;
  let rows = null;
  try { const { data } = await C.loadFrom(league, ['player-logs']); rows = data['player-logs']?.logs?.[String(code)] ?? null; } catch { rows = null; }
  if (!rows?.length) return;
  const v = (x, d = 0) => (x == null ? '—' : d ? C.fx(x, d) : x);
  const list = [...rows].sort((a, b) => b.date.localeCompare(a.date));
  const sum = k => list.reduce((a, r) => a + (r[k] ?? 0), 0);
  host.innerHTML = `<div class="card"><h3>逐場紀錄 <span class="dim tiny">FotMob・${list.length} 場</span></h3>
    <div class="row small dim" style="gap:12px;margin-bottom:6px"><span>進球 ${sum('goals')}</span><span>助攻 ${sum('assists')}</span><span>射門 ${sum('shots')}</span><span>xG ${C.fx(sum('xg'), 2)}</span></div>
    <div style="overflow-x:auto">${C.table(list, [
      { key: 'date', label: '日期', value: r => r.date, left: true },
      { key: 'opp', label: '對手', value: r => `${r.home ? '主' : '客'} ${C.name(r.opp)}`, sortValue: r => r.opp, left: true },
      { key: 'score', label: '比分', value: r => `<span class="pill tiny ${r.result === 'W' ? 'accent' : r.result === 'L' ? 'bad' : ''}">${r.score}</span>`, sortValue: r => r.result },
      { key: 'min', label: "分'", value: r => `${r.min}${r.sub ? '<span class="dim">↑</span>' : ''}`, sortValue: r => r.min, num: true },
      { key: 'rating', label: '評分', value: r => v(r.rating, 1), sortValue: r => r.rating ?? -1, num: true },
      { key: 'goals', label: '球', value: r => v(r.goals), sortValue: r => r.goals ?? -1, num: true },
      { key: 'assists', label: '助', value: r => v(r.assists), sortValue: r => r.assists ?? -1, num: true },
      { key: 'shots', label: '射門/正', value: r => `${v(r.shots)}/${v(r.shotsOn)}`, sortValue: r => r.shots ?? -1, num: true },
      { key: 'keyPasses', label: '關鍵傳球', value: r => v(r.keyPasses), sortValue: r => r.keyPasses ?? -1, num: true },
      { key: 'xg', label: 'xG', value: r => v(r.xg, 2), sortValue: r => r.xg ?? -1, num: true },
      { key: 'distance', label: '跑動 km', value: r => (r.distance == null ? '—' : (r.distance / 1000).toFixed(1)), sortValue: r => r.distance ?? -1, num: true },
    ], { sortKey: 'date', desc: true })}</div>
    <div class="tiny dim" style="margin-top:8px">↑ = 替補上場。xG 是該場逐射門 xG 合計(供應商標記);跑動是追蹤資料,不是每場都有。點欄位標題可換排序。</div>
  </div>`;
}

/* ── 西甲球員頁(Understat + SportMonks)────────
   Understat 給整季彙總，SportMonks 補身分欄位；版面與英超統一，
   但仍保留資料來源的界線，沒有來源的進階欄位不自行推估。 */
function renderUnderstat({ meta, clubs = [], teams = [], players, leaders }) {
  const app = document.getElementById('app');
  const SEASONS = { current: leaders.seasons.current, last: leaders.seasons.last };
  // 本季剛開打時沒有人踢滿門檻,每 90 分鐘的榜會整片空 —— 那時預設看上季
  let season = leaders.currentQualified > 0 ? SEASONS.current : SEASONS.last;
  /* 榜單標題一定要帶季別。這一頁有季別切換鈕,而且上面那行會在本季樣本不足時
     **自動改看上季** —— 標題不說是哪一季的話,讀者看到的預設值正好不是他以為的那一季。 */
  const seasonLabel = () => (season === SEASONS.current ? `本季 ${SEASONS.current}` : `上季 ${SEASONS.last}`);
  let posFilter = '', teamFilter = '', minMinutes = 0, query = '';

  const bySeason = s => players.filter(p => p.season === s);
  const normalise = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Understat 用隊名、頁面其餘元件用三碼代號；先在資料層已註冊的隊伍中做別名對照，
  // 否則西甲球員連結會把「Barcelona」誤當成隊碼而無法進入球隊頁。
  const teamNames = new Map();
  for (const t of [...clubs, ...teams]) {
    for (const value of [t.code, t.en, t.zh, t.of, t.understat, ...(t.alias ?? [])]) {
      const key = normalise(value);
      if (key && !teamNames.has(key)) teamNames.set(key, t.code);
    }
  }
  const codeOf = value => teamNames.get(normalise(value)) ?? value;
  const codeName = c => C.name(codeOf(c));
  const codesOf = p => (p.teams ?? []).map(codeOf);
  // 跨隊球員的整季數字仍是兩隊合計，但畫面只掛目前球隊，避免隊名與欄位拉開；
  // SportMonks 有核對結果時優先使用它，否則退回來源最後一隊。
  const currentTeamCode = p => codeOf(p.sportmonksTeam ?? p.teams?.at(-1));
  const teamCell = p => `${C.teamCell(currentTeamCode(p), {
    label: C.name(currentTeamCode(p)) !== currentTeamCode(p)
      ? C.name(currentTeamCode(p)) : (p.teams?.at(-1) ?? currentTeamCode(p)),
  })}${p.multiTeam ? ' <span class="pill warn tiny" title="本季效力過兩隊，數字是兩隊合計">跨隊</span>' : ''}`;

  const playerForPhoto = p => ({ ...p, team: currentTeamCode(p) });
  const playerById = () => new Map(bySeason(season).map(p => [String(p.id), p]));

  /* 年齡來自 SportMonks 的出生日期,沒對上的人整批不在榜裡。
     涵蓋率不到全部時要說出來 —— 這是「排除了誰」,不是小數點後的細節。 */
  const ageNote = () => {
    const c = leaders.ageCoverage?.[season];
    if (!c || !c.total || c.known >= c.total) return '';
    return `<div class="tiny dim" style="margin-top:8px">只計入有出生日期的
      ${c.known} / ${c.total} 人 —— 其餘來源沒給生日,不列入也不猜。</div>`;
  };

  const boardCard = b => {
    const rows = (leaders[season === SEASONS.current ? 'current' : 'last'] ?? {})[b.key] ?? [];
    if (!rows.length) {
      return `<div class="card"><h3>${C.esc(b.label)}
        <span class="dim tiny">${seasonLabel()}・${C.esc(b.unit)}</span></h3>
        <div class="tiny dim">${b.per90
          ? `本季還沒有人踢滿 ${leaders.minMinutes} 分鐘,每 90 分鐘的數字現在給了會誤導,所以先不給。`
          : '這一季還沒有資料。'}</div></div>`;
    }
    const fmt = v => (b.per90 || String(v).includes('.') ? C.fx(v, 2) : v);
    const byId = playerById();
    return `<div class="card"><div class="spread"><h3>${C.esc(b.label)}
        <span class="dim tiny">${seasonLabel()}</span></h3>
        <span class="pill tiny">${C.esc(b.unit)}</span></div>
      ${rows.map((r, i) => { const p = byId.get(String(r.id)); return `<div class="stat-line clickable" data-player-code="${C.esc(r.id)}" tabindex="0" role="button">
        <span class="small"><span class="dim mono" style="display:inline-block;width:1.6em">${i + 1}</span>
          ${p ? C.playerPhoto(playerForPhoto(p), 28) : ''} ${C.esc(r.name)}<span class="dim tiny"> ${p ? C.name(currentTeamCode(p)) : r.teams.map(codeName).join(' / ')}${p?.multiTeam ? '・跨隊' : ''}</span></span>
        <b class="mono">${fmt(r.value)}</b></div>`; }).join('')}${b.key === 'youth' ? ageNote() : ''}</div>`;
  };

  /* 欄位走共用工廠(coreColumns)、表格走 C.table —— 這裡以前手刻了一份
     可排序表格,跟 C.table 重複,而且 20 個欄位跟英超那份各寫各的、
     標題順序悄悄漂移。西甲的數字攤平在最上層 → statOf 是恆等。 */
  const filteredRows = () => {
    let rows = bySeason(season);
    if (posFilter) rows = rows.filter(p => p.pos === posFilter);
    if (teamFilter) rows = rows.filter(p => codesOf(p).includes(teamFilter));
    if (minMinutes) rows = rows.filter(p => (p.minutes ?? 0) >= minMinutes);
    if (query) { const q = query.toLowerCase(); rows = rows.filter(p => p.name.toLowerCase().includes(q)); }
    return rows;
  };
  const tableHtml = () => {
    const rows = filteredRows();
    return C.table(rows, coreColumns({
      statOf: p => p,
      nameCell: p => `<span class="player-cell">${C.playerPhoto(playerForPhoto(p), 28)}<span>${C.esc(p.name)}</span></span>`,
      teamCol: { key: 'team', label: '球隊', value: p => codeName(currentTeamCode(p)), left: true, render: teamCell },
      afterId: [{ key: 'games', label: '出場', value: p => p.games ?? 0, num: true }],
    }), { sortKey: 'goals', desc: true, onRow: p => C.go('players', { code: p.id }) })
      + `<div class="tiny dim" style="margin-top:8px">共 ${rows.length} 人。點欄位標題可換排序。
        <span class="mono">xGI/90</span> 只在上場時間達 ${leaders.minMinutes} 分鐘時給出。</div>`;
  };

  const codes = [...new Set(players.flatMap(codesOf))].sort((a, b) => codeName(a).localeCompare(codeName(b), 'zh-Hant'));
  const draw = () => {
    const cur = bySeason(season);
    app.innerHTML = `
    <div class="page-head">
      <h1>西甲球員</h1>
      <p>${C.esc(season)} 的 ${cur.length} 名球員。數字是<b>整季彙總</b>,不是逐場 ——
         來源(Understat)給的就是這個粒度。每 90 分鐘的數字只在上場時間達
         ${leaders.minMinutes} 分鐘時給出,樣本太少的給了會誤導。</p>
      ${C.stampRow([
        C.stamp(`${C.esc(season)} 整季統計`, { iso: leaders.retrievedAt, kind: 'season', note: '來源:Understat' }),
        C.stamp('百分位雷達', { kind: 'season', note: '只跟同季、同位置、達門檻的西甲球員比' }),
      ])}
      <div class="note" style="margin-top:14px"><b>資料界線:</b>
        ${leaders.missing.map(C.esc).join('、')} 目前沒有可靠來源，詳細面板只顯示已取得欄位；
        缺少的數值以「—」表示，不自行估算。</div>
    </div>

    <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">
      ${Object.entries(SEASONS).map(([k, v]) => `<button class="btn season-btn ${v === season ? 'on' : ''}" data-season="${C.esc(v)}">${
        k === 'current' ? '本季' : '上季'} ${C.esc(v)}</button>`).join('')}
      ${leaders.currentQualified === 0 && season === SEASONS.last
        ? '<span class="tiny dim" style="align-self:center">本季才剛開打,還沒有人踢滿門檻,所以預設看上季</span>' : ''}
    </div>

    <div class="section"><h2>榜單</h2><span class="hint">只做這個來源真的有的項目</span></div>
    <div class="grid g2">${leaders.boards.map(boardCard).join('')}</div>

    <div class="section"><h2>全部球員</h2><span class="hint">可篩選與排序</span></div>
    <div class="card">
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <input id="q" type="search" placeholder="搜尋球員…" value="${C.esc(query)}"
               style="flex:1;min-width:160px;padding:7px 11px;border-radius:8px;border:1px solid var(--line);background:#ffffff08;color:var(--ink)">
        <select id="fTeam" style="padding:7px 11px;border-radius:8px;border:1px solid var(--line);background:#ffffff08;color:var(--ink)">
          <option value="">所有球隊</option>
          ${codes.map(c => `<option value="${C.esc(c)}" ${teamFilter === c ? 'selected' : ''}>${C.esc(codeName(c))}</option>`).join('')}
        </select>
        <select id="fPos" style="padding:7px 11px;border-radius:8px;border:1px solid var(--line);background:#ffffff08;color:var(--ink)">
          <option value="">所有位置</option>
          ${[['GK', '門將'], ['D', '後衛'], ['M', '中場'], ['F', '前鋒']].map(([k, l]) =>
            `<option value="${k}" ${posFilter === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="fMin" style="padding:7px 11px;border-radius:8px;border:1px solid var(--line);background:#ffffff08;color:var(--ink)">
          <option value="0" ${minMinutes === 0 ? 'selected' : ''}>不限出場</option>
          <option value="90" ${minMinutes === 90 ? 'selected' : ''}>90 分鐘以上</option>
          <option value="600" ${minMinutes === 600 ? 'selected' : ''}>600 分鐘以上</option>
          <option value="1800" ${minMinutes === 1800 ? 'selected' : ''}>1800 分鐘以上</option>
        </select>
        <button class="btn" id="cmpBtn" type="button" disabled title="西甲目前沒有可核對的跨球員雷達資料">對比模式:不可用</button>
        <span class="dim small" id="count">共 ${filteredRows().length} 人</span>
      </div>
      ${tableHtml()}
      <div id="xleague"></div>
    </div>

    <div class="card">
      <h3>這一頁的數字怎麼來的</h3>
      <div class="small muted" style="display:grid;gap:8px">
        <div><b>位置</b>是來源給的 GK/D/M/F 標記。一個人有多個位置時,取<b>最偏防守</b>的那個當分組依據
          —— 兼踢中場的後衛拿去跟後衛比比較合理。這是推論,不是官方登錄位置。
          整季只以替補出場、來源沒標位置的人顯示「來源未標位置」,不參與百分位。</div>
        <div><b>跨隊球員</b>本季效力過兩隊時,來源給的是兩隊合計,不是分開的。
          所以標記出來,不硬掛到其中一隊 —— 掛錯的話那個隊的數字就是假的。</div>
        <div><b>終結超出期望</b>用非十二碼進球減 npxG。十二碼的 xG 是固定值,
          混進來只會反映罰球次數,不反映終結能力。</div>
        <div><b>來源:</b>Understat 整季統計 + SportMonks 球員名單欄位（均為本地快取,開頁不連外）。${C.esc(leaders.note)}</div>
      </div>
    </div>
    ${C.foot(meta)}`;

    app.querySelectorAll('.season-btn').forEach(b => b.onclick = () => { season = b.dataset.season; draw(); });
    // 排序由 C.table 自己處理(以前這裡掛手刻的 th 監聽,是 C.table 的重複實作)
    const q = app.querySelector('#q');
    if (q) { q.oninput = () => { query = q.value; draw(); q.focus(); }; }
    updateXLeague(query);
    const ps = app.querySelector('#fPos');
    if (ps) ps.onchange = () => { posFilter = ps.value; draw(); };
    const ts = app.querySelector('#fTeam');
    if (ts) ts.onchange = () => { teamFilter = ts.value; draw(); };
    const ms = app.querySelector('#fMin');
    if (ms) ms.onchange = () => { minMinutes = Number(ms.value); draw(); };
    const byId = playerById();
    const activatePlayer = event => {
      const el = event.target.closest?.('[data-player-code]');
      if (!el || !app.contains(el)) return;
      event.preventDefault();
      const p = byId.get(String(el.dataset.playerCode));
      if (p) C.go('players', { code: p.id });
    };
    app.querySelectorAll('[data-player-code]').forEach(el => {
      el.onclick = activatePlayer;
      el.onkeydown = e => { if (['Enter', ' '].includes(e.key)) activatePlayer(e); };
    });
  };

  function openUnderstatPlayer(p) {
    const primaryCode = currentTeamCode(p);
    const photoPlayer = playerForPhoto(p);
    const teamLabel = `${C.teamCell(primaryCode, {
      label: C.name(primaryCode) !== primaryCode ? C.name(primaryCode) : (p.teams?.at(-1) ?? primaryCode),
    })}${p.multiTeam ? ' <span class="pill warn tiny">跨隊</span>' : ''}`;
    const line = (label, value) => `<div class="stat-line"><span class="small muted">${label}</span><b class="mono">${value ?? '—'}</b></div>`;
    const value = (v, d = 0) => v == null ? '—' : (d ? C.fx(v, d) : v);
    const stat = p;
    const info = [
      line('球隊', teamLabel), line('位置', p.posZh ?? '來源未標位置'),
      line('年齡', p.age == null ? '—' : `${p.age} 歲`), line('背號', p.squadNumber ?? '—'),
      line('身高', p.height == null ? '—' : `${p.height} cm`), line('體重', p.weight == null ? '—' : `${p.weight} kg`),
    ].join('');
    const performance = [
      line('出場', value(stat.games)), line('分鐘', value(stat.minutes)),
      line('進球 / 助攻', `${value(stat.goals)} / ${value(stat.assists)}`),
      line('進球參與', value(stat.ga)), line('xG / xA', `${value(stat.xG, 2)} / ${value(stat.xA, 2)}`),
      line('xGI', value(stat.xGI, 2)), line('xG/90 / xA/90', `${value(stat.xg90, 2)} / ${value(stat.xa90, 2)}`),
      line('xGI/90', value(stat.xgi90, 2)), line('射門 / 關鍵傳球', `${value(stat.shots)} / ${value(stat.keyPasses)}`),
      line('黃牌 / 紅牌', `${value(stat.yellow)} / ${value(stat.red)}`),
    ].join('');
    const advanced = [
      line('終結超出期望', C.signed(stat.finishing, 2)),
      line('xG 串聯', value(stat.xGChain, 2)), line('xG 推進', value(stat.xGBuildup, 2)),
      line('xG 串聯/90', value(stat.chain90, 2)), line('xG 推進/90', value(stat.buildup90, 2)),
      line('防守貢獻/90', '—'), line('門將撲救/90', '—'),
    ].join('');
    const radar = p.radar ? `<div class="card"><h3>能力雷達 <span class="dim tiny">${C.esc(season)}</span></h3>
      ${C.radar([{ name: p.name, color: C.team(primaryCode).colors?.[0] ?? '#00ff85', values: p.radar }], { size: 300 })}
      <div class="tiny dim center">與同季、同位置且達 ${leaders.minMinutes} 分鐘門檻的西甲球員相比</div></div>` : '';
    playerPage(`${C.playerPhoto(photoPlayer, 56)} ${C.esc(p.name)}`, `${teamLabel}・資料來源 Understat + SportMonks`, `
      <div class="card"><div class="spread"><div>
        <div style="font-size:19px;font-weight:800">${C.esc(p.name)}</div>
        <div class="small muted">${teamLabel}・資料來源 Understat + SportMonks</div>
      </div><span class="pill info">${C.esc(p.season)}</span></div></div>
      <div class="card"><h3>基本資料</h3>${info}</div>
      <div class="card"><h3>表現數據</h3>${performance}</div>
      <div class="card"><h3>進階數據</h3>${advanced}<div class="tiny dim" style="margin-top:8px">西甲目前沒有可靠的逐球員防守與門將統計，該欄位不以其他數字代替。</div></div>
      ${radar}
      <div class="tiny dim">球員編號 ${C.esc(p.id)}・原始生日保留於本地資料作追溯，介面統一顯示年齡。</div>
      <div style="margin-top:10px">${primaryCode ? `<a href="${C.link('teams', { code: primaryCode })}">查看球隊完整剖析 →</a>` : ''}</div>`);
  }
  // 西甲球員頁也支援和英超相同的 ?code= 深連結。若指定球員屬於另一季，
  // 先切到該球員的資料季，再開詳細面板，避免連結落到空的預設季。
  const requestedId = C.qs('code');
  const requestedPlayer = requestedId
    ? players.find(p => String(p.id) === String(requestedId))
    : null;
  /* 帶 ?code= 就直接整頁畫該球員、不畫列表(列表表格的延後綁定會在 #app 被換掉後丟錯) */
  if (requestedPlayer) { season = requestedPlayer.season; openUnderstatPlayer(requestedPlayer); return; }
  draw();
}
