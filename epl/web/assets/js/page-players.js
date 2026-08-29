import * as C from './core.js?v=4e77ec5e';

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
    updateXLeague(q);
    document.getElementById('list').innerHTML = C.table(rows, [
      { key: 'name', label: '球員', value: p => p.name, left: true,
        render: p => `${cmpMode ? `<input type="checkbox" ${compare.includes(p.code) ? 'checked' : ''} style="margin-right:6px">` : ''}${C.playerPhoto(p, 28)} ${C.esc(p.name)}${p.status !== 'a' ? ` <span class="pill bad tiny">${p.statusZh}</span>` : ''}` },
      { key: 'team', label: '球隊', value: p => C.name(p.team), render: p => C.teamCell(p.team) },
      { key: 'pos', label: '位置', value: p => ['GK', 'DEF', 'MID', 'FWD'].indexOf(p.pos), render: p => p.posZh },
      { key: 'age', label: '年齡', value: p => p.age ?? 0, num: true },
      { key: 'squadNumber', label: '背號', value: p => p.squadNumber ?? 0, num: true,
        render: p => (p.squadNumber == null ? '—' : `${p.squadNumber}${C.numberSourceMark(p)}`) },
      { key: 'appearances', label: '出場', value: p => mode === 'current' ? (p.appearances ?? 0) : 0, num: true, render: p => mode === 'current' ? (p.appearances ?? '—') : '—' },
      { key: 'minutes', label: '分鐘', value: p => S().stat(p)?.minutes ?? 0, num: true },
      { key: 'goals', label: '進球', value: p => S().stat(p)?.goals ?? 0, num: true },
      { key: 'assists', label: '助攻', value: p => S().stat(p)?.assists ?? 0, num: true },
      { key: 'ga', label: '進球參與', value: p => S().stat(p)?.ga ?? 0, num: true },
      { key: 'xG', label: 'xG', value: p => S().stat(p)?.xG ?? 0, num: true, render: p => C.fx(S().stat(p)?.xG, 2) },
      { key: 'xA', label: 'xA', value: p => S().stat(p)?.xA ?? 0, num: true, render: p => C.fx(S().stat(p)?.xA, 2) },
      { key: 'xGI', label: 'xGI', value: p => S().stat(p)?.xGI ?? 0, num: true, render: p => C.fx(S().stat(p)?.xGI, 2) },
      { key: 'xg90', label: 'xG/90', value: p => S().stat(p)?.xg90 ?? 0, num: true },
      { key: 'xa90', label: 'xA/90', value: p => S().stat(p)?.xa90 ?? 0, num: true },
      { key: 'xgi90', label: 'xGI/90', value: p => S().stat(p)?.xgi90 ?? 0, num: true },
      { key: 'shots', label: '射門', value: p => S().stat(p)?.shots ?? 0, num: true, render: p => S().stat(p)?.shots ?? '—' },
      { key: 'keyPasses', label: '關鍵傳球', value: p => S().stat(p)?.keyPasses ?? 0, num: true, render: p => S().stat(p)?.keyPasses ?? '—' },
      { key: 'yellow', label: '黃牌', value: p => S().stat(p)?.yellow ?? 0, num: true, render: p => S().stat(p)?.yellow ?? '—' },
      { key: 'red', label: '紅牌', value: p => S().stat(p)?.red ?? 0, num: true, render: p => S().stat(p)?.red ?? '—' },
    ], { sortKey: 'minutes', desc: true, onRow: p => (cmpMode ? toggleCompare(p) : openPlayer(p)) });
  };

  renderSeasonUI();

  ['q', 'fTeam', 'fPos', 'fMin'].forEach(id => {
    const el = document.getElementById(id);
    el.oninput = render; el.onchange = render;
  });
  render();

  // 從賽後陣容、即時戰況或外部連結帶入 ?code= 時，直接開該球員詳情；
  // 不要求使用者先在 599 人清單裡重新搜尋一次。
  const requestedPlayer = C.qs('code') ? byCode.get(String(C.qs('code'))) : null;
  if (requestedPlayer) openPlayer(requestedPlayer);

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

  const COLS = [
    { key: 'name', label: '球員', left: true, get: p => `<span class="player-cell">${C.playerPhoto(playerForPhoto(p), 28)}<span>${C.esc(p.name)}</span></span>` },
    { key: 'team', label: '球隊', left: true, get: teamCell },
    { key: 'posZh', label: '位置', get: p => `<span class="dim">${C.esc(p.posZh)}</span>` },
    { key: 'age', label: '年齡', num: true, get: p => p.age ?? '—' },
    { key: 'squadNumber', label: '背號', num: true,
      get: p => (p.squadNumber == null ? '—' : `${p.squadNumber}${C.numberSourceMark(p)}`) },
    { key: 'games', label: '出場', num: true },
    { key: 'minutes', label: '分鐘', num: true },
    { key: 'goals', label: '進球', num: true },
    { key: 'assists', label: '助攻', num: true },
    { key: 'ga', label: '進球參與', num: true },
    { key: 'xG', label: 'xG', num: true, d: 2 },
    { key: 'xA', label: 'xA', num: true, d: 2 },
    { key: 'xGI', label: 'xGI', num: true, d: 2 },
    { key: 'xg90', label: 'xG/90', num: true, d: 2 },
    { key: 'xa90', label: 'xA/90', num: true, d: 2 },
    { key: 'shots', label: '射門', num: true },
    { key: 'keyPasses', label: '關鍵傳球', num: true },
    { key: 'xgi90', label: 'xGI/90', num: true, d: 2 },
    { key: 'yellow', label: '黃牌', num: true },
    { key: 'red', label: '紅牌', num: true },
  ];
  let sortKey = 'goals', sortDesc = true;

  const filteredRows = () => {
    let rows = bySeason(season);
    if (posFilter) rows = rows.filter(p => p.pos === posFilter);
    if (teamFilter) rows = rows.filter(p => codesOf(p).includes(teamFilter));
    if (minMinutes) rows = rows.filter(p => (p.minutes ?? 0) >= minMinutes);
    if (query) { const q = query.toLowerCase(); rows = rows.filter(p => p.name.toLowerCase().includes(q)); }
    return rows;
  };
  const tableHtml = () => {
    let rows = filteredRows();
    rows = rows.slice().sort((a, b) => {
      const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
      if (typeof av === 'string') return sortDesc ? String(bv).localeCompare(av) : String(av).localeCompare(String(bv));
      return sortDesc ? bv - av : av - bv;
    });
    return `<div class="table-wrap"><table class="tbl players-table"><thead><tr>${COLS.map(c =>
      `<th class="${c.num ? 'num' : ''} sortable" data-sort="${c.key}">${C.esc(c.label)}${
        sortKey === c.key ? (sortDesc ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(p => `<tr class="clickable" data-player-code="${C.esc(p.id)}" tabindex="0" role="button">${COLS.map(c => `<td class="${[c.num ? 'num mono' : '', c.left ? 'left' : ''].filter(Boolean).join(' ')}">${
        c.get ? c.get(p) : (c.num && c.d ? C.fx(p[c.key], c.d) : (p[c.key] ?? '—'))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="tiny dim" style="margin-top:8px">依${C.esc(COLS.find(c => c.key === sortKey)?.label ?? sortKey)}排序,共 ${rows.length} 人。
        點欄位標題可換排序。
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
    app.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
      const k = th.dataset.sort;
      if (k === sortKey) sortDesc = !sortDesc; else { sortKey = k; sortDesc = true; }
      draw();
    });
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
      if (p) openUnderstatPlayer(p);
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
    C.drawer(`${C.playerPhoto(photoPlayer, 34)} ${C.esc(p.name)}`, `
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
  if (requestedPlayer) season = requestedPlayer.season;
  draw();
  if (requestedPlayer) openUnderstatPlayer(requestedPlayer);
}
