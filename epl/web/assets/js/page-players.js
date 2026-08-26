import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, players, leaders } = await C.load('meta', 'clubs', 'teams', 'players', 'leaders');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  /* 西甲的球員資料來自 Understat,欄位跟英超那套 FPL 完全不同 ——
     沒有背號、頭貼、傷停、防守數據。與其把英超版面留一堆空欄位
     (那比不做更糟,讀者會以為壞掉),不如另外畫一頁只放真的有的東西。
     由資料層自己宣告來源,前端不用去猜現在是哪個聯賽。 */
  if (leaders.source === 'Understat') {
    renderUnderstat({ meta, players, leaders });
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
          有資料之後執行 <span class="mono">npm run season</span> 再 <span class="mono">npm run build</span>,
          這一頁就會自動填上本季數字。現在先看上季。</div>`
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
    document.querySelectorAll('[data-p]').forEach(el => { el.onclick = () => openPlayer(byCode.get(el.dataset.p)); });
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
    document.getElementById('list').innerHTML = C.table(rows, [
      { key: 'name', label: '球員', value: p => p.name, left: true,
        render: p => `${cmpMode ? `<input type="checkbox" ${compare.includes(p.code) ? 'checked' : ''} style="margin-right:6px">` : ''}${C.esc(p.name)}${p.status !== 'a' ? ` <span class="pill bad tiny">${p.statusZh}</span>` : ''}` },
      { key: 'team', label: '球隊', value: p => C.name(p.team), render: p => C.teamCell(p.team) },
      { key: 'pos', label: '位置', value: p => ['GK', 'DEF', 'MID', 'FWD'].indexOf(p.pos), render: p => p.posZh },
      { key: 'age', label: '年齡', value: p => p.age ?? 0, num: true },
      { key: 'minutes', label: '分鐘', value: p => S().stat(p)?.minutes ?? 0, num: true },
      { key: 'goals', label: '進球', value: p => S().stat(p)?.goals ?? 0, num: true },
      { key: 'assists', label: '助攻', value: p => S().stat(p)?.assists ?? 0, num: true },
      { key: 'xg90', label: 'xG/90', value: p => S().stat(p)?.xg90 ?? 0, num: true },
      { key: 'xa90', label: 'xA/90', value: p => S().stat(p)?.xa90 ?? 0, num: true },
      { key: 'finishing', label: '終結', value: p => S().stat(p)?.finishing ?? 0, num: true,
        title: '進球 − 期望進球', render: p => (S().stat(p) ? C.signed(S().stat(p).finishing, 1) : '—') },
      { key: 'defCon90', label: '防守貢獻/90', value: p => S().stat(p)?.defCon90 ?? 0, num: true },
      { key: 'price', label: '身價', value: p => p.price, num: true, render: p => `£${p.price.toFixed(1)}m` },
    ], { sortKey: 'minutes', desc: true, onRow: p => (cmpMode ? toggleCompare(p) : openPlayer(p)) });
  };

  renderSeasonUI();

  ['q', 'fTeam', 'fPos', 'fMin'].forEach(id => {
    const el = document.getElementById(id);
    el.oninput = render; el.onchange = render;
  });
  render();

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

    C.drawer(`${C.playerPhoto(p)} ${C.esc(p.name)}`, `
      <div class="card">
        <div class="spread">
          <div><div style="font-size:19px;font-weight:800">${C.esc(p.fullName)}</div>
            <div class="small muted">${p.posZh}・${p.age ?? '?'} 歲・${t.en}
              ${p.squadNumber ? `・背號 ${p.squadNumber}` : ''}・£${p.price.toFixed(1)}m</div></div>
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
      <div><a href="${C.link('teams', { code: p.team })}">看 ${t.en} 的完整剖析 →</a></div>`);
  }

  const pc = C.qs('code');
  if (pc && byCode.has(pc)) openPlayer(byCode.get(pc));

} catch (err) { if (err.message !== 'skip') C.fail(err); }

/* ── 西甲球員頁(Understat)──────────────────
   刻意跟英超版分開。這個來源給的是**整季彙總**,不是逐場,
   而且只有進攻與串聯類的欄位。能做的都做滿,做不到的直接寫出來。 */
function renderUnderstat({ meta, players, leaders }) {
  const app = document.getElementById('app');
  const SEASONS = { current: leaders.seasons.current, last: leaders.seasons.last };
  // 本季剛開打時沒有人踢滿門檻,每 90 分鐘的榜會整片空 —— 那時預設看上季
  let season = leaders.currentQualified > 0 ? SEASONS.current : SEASONS.last;
  let posFilter = '', teamFilter = '', query = '';

  const bySeason = s => players.filter(p => p.season === s);
  const codeName = c => C.name(c);
  const teamCell = p => p.teams.map(t => C.teamLink(t)).join('<span class="dim"> → </span>')
    + (p.multiTeam ? ' <span class="pill warn tiny" title="本季效力兩隊,數字是兩隊合計">跨隊</span>' : '');

  const boardCard = b => {
    const rows = (leaders[season === SEASONS.current ? 'current' : 'last'] ?? {})[b.key] ?? [];
    if (!rows.length) {
      return `<div class="card"><h3>${C.esc(b.label)}</h3>
        <div class="tiny dim">${b.per90
          ? `本季還沒有人踢滿 ${leaders.minMinutes} 分鐘,每 90 分鐘的數字現在給了會誤導,所以先不給。`
          : '這一季還沒有資料。'}</div></div>`;
    }
    const fmt = v => (b.per90 || String(v).includes('.') ? C.fx(v, 2) : v);
    return `<div class="card"><div class="spread"><h3>${C.esc(b.label)}</h3>
        <span class="pill tiny">${C.esc(b.unit)}</span></div>
      ${rows.map((r, i) => `<div class="stat-line">
        <span class="small"><span class="dim mono" style="display:inline-block;width:1.6em">${i + 1}</span>
          ${C.esc(r.name)}<span class="dim tiny"> ${r.teams.map(codeName).join(' / ')}</span></span>
        <b class="mono">${fmt(r.value)}</b></div>`).join('')}</div>`;
  };

  const hasSportMonks = players.some(p => p.sportmonksId);
  const COLS = [
    { key: 'name', label: '球員', get: p => `${p.photo ? C.playerPhoto(p, 26) : ''}${C.esc(p.name)}` },
    { key: 'team', label: '球隊', get: teamCell },
    { key: 'posZh', label: '位置', get: p => `<span class="dim">${C.esc(p.posZh)}</span>` },
    ...(hasSportMonks ? [
      { key: 'squadNumber', label: '背號', num: true },
      { key: 'dateOfBirth', label: '出生日期', get: p => p.dateOfBirth ?? '—' },
    ] : []),
    { key: 'games', label: '出場', num: true },
    { key: 'minutes', label: '分鐘', num: true },
    { key: 'goals', label: '進球', num: true },
    { key: 'assists', label: '助攻', num: true },
    { key: 'xG', label: 'xG', num: true, d: 2 },
    { key: 'xA', label: 'xA', num: true, d: 2 },
    { key: 'shots', label: '射門', num: true },
    { key: 'keyPasses', label: '關鍵傳球', num: true },
    { key: 'xgi90', label: 'xGI/90', num: true, d: 2 },
  ];
  let sortKey = 'goals', sortDesc = true;

  const tableHtml = () => {
    let rows = bySeason(season);
    if (posFilter) rows = rows.filter(p => p.pos === posFilter);
    if (teamFilter) rows = rows.filter(p => p.teams.includes(teamFilter));
    if (query) { const q = query.toLowerCase(); rows = rows.filter(p => p.name.toLowerCase().includes(q)); }
    rows = rows.slice().sort((a, b) => {
      const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
      if (typeof av === 'string') return sortDesc ? String(bv).localeCompare(av) : String(av).localeCompare(String(bv));
      return sortDesc ? bv - av : av - bv;
    }).slice(0, 100);
    return `<div class="table-wrap"><table class="tbl"><thead><tr>${COLS.map(c =>
      `<th class="${c.num ? 'num' : ''} sortable" data-sort="${c.key}">${C.esc(c.label)}${
        sortKey === c.key ? (sortDesc ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(p => `<tr>${COLS.map(c => `<td class="${c.num ? 'num mono' : ''}">${
        c.get ? c.get(p) : (c.num && c.d ? C.fx(p[c.key], c.d) : (p[c.key] ?? '—'))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="tiny dim" style="margin-top:8px">依${C.esc(COLS.find(c => c.key === sortKey)?.label ?? sortKey)}排序,最多顯示 100 人(符合條件 ${
        rows.length >= 100 ? '超過 100' : rows.length} 人)。點欄位標題可換排序。
        <span class="mono">xGI/90</span> 只在上場時間達 ${leaders.minMinutes} 分鐘時給出。</div>`;
  };

  const codes = [...new Set(players.flatMap(p => p.teams))].sort((a, b) => codeName(a).localeCompare(codeName(b), 'zh-Hant'));
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
      <div class="note" style="margin-top:14px"><b>西甲沒有、英超才有的東西:</b>
        ${leaders.missing.map(C.esc).join('、')}。這些欄位這個來源就是沒有,
        所以這一頁不放 —— 留一個永遠空白的欄位比不做更糟。</div>
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
        <input id="pq" type="search" placeholder="搜尋球員…" value="${C.esc(query)}"
               style="flex:1;min-width:160px;padding:7px 11px;border-radius:8px;border:1px solid var(--line);background:#ffffff08;color:var(--ink)">
        <select id="ppos" style="padding:7px 11px;border-radius:8px;border:1px solid var(--line);background:#ffffff08;color:var(--ink)">
          <option value="">全部位置</option>
          ${[['GK', '門將'], ['D', '後衛'], ['M', '中場'], ['F', '前鋒']].map(([k, l]) =>
            `<option value="${k}" ${posFilter === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="pteam" style="padding:7px 11px;border-radius:8px;border:1px solid var(--line);background:#ffffff08;color:var(--ink)">
          <option value="">全部球隊</option>
          ${codes.map(c => `<option value="${c}" ${teamFilter === c ? 'selected' : ''}>${C.esc(codeName(c))}</option>`).join('')}
        </select>
      </div>
      ${tableHtml()}
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
    app.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
      const k = th.dataset.sort;
      if (k === sortKey) sortDesc = !sortDesc; else { sortKey = k; sortDesc = true; }
      draw();
    });
    const q = app.querySelector('#pq');
    if (q) { q.oninput = () => { query = q.value; draw(); q.focus(); }; }
    const ps = app.querySelector('#ppos');
    if (ps) ps.onchange = () => { posFilter = ps.value; draw(); };
    const ts = app.querySelector('#pteam');
    if (ts) ts.onchange = () => { teamFilter = ts.value; draw(); };
  };
  draw();
}
