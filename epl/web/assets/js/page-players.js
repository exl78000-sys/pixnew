import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, players, leaders } = await C.load('meta', 'clubs', 'teams', 'players', 'leaders');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav('players.html');

  const byCode = new Map(players.map(p => [p.code, p]));
  const codes = [...new Set(players.map(p => p.team))].sort((a, b) => C.zh(a).localeCompare(C.zh(b), 'zh-Hant'));
  const POS = [['GK', '門將'], ['DEF', '後衛'], ['MID', '中場'], ['FWD', '前鋒']];
  let compare = [];

  const boardDefs = [
    ['scorers', '射手榜', '上季進球', v => v],
    ['assisters', '助攻榜', '上季助攻', v => v],
    ['xgi', '每 90 分鐘進球參與', 'xGI/90', v => C.fx(v, 2)],
    ['creators', '創造機會', 'xA/90', v => C.fx(v, 2)],
    ['finishers', '終結超出期望', '進球 − xG', v => C.signed(v, 1)],
    ['defenders', '後衛防守貢獻', '防守貢獻/90', v => C.fx(v, 2)],
    ['keepers', '門將撲救效率', '少失球數', v => C.signed(v, 1)],
    ['workhorses', '回收球', '回收/90', v => C.fx(v, 1)],
    ['youngGuns', '22 歲以下', '總得分', v => v],
    ['value', 'CP 值', '每百萬身價得分', v => C.fx(v, 1)],
  ];

  app.innerHTML = `
  <div class="page-head">
    <h1>球員</h1>
    <p>${meta.counts.players} 名 ${meta.currentSeason} 註冊球員,數據來自上季 ${meta.lastSeason} 的完整表現。
       百分位是跟「同位置、上季出場 600 分鐘以上」的球員比(門將 ${meta.counts.poolSizes.GK} 人、
       後衛 ${meta.counts.poolSizes.DEF} 人、中場 ${meta.counts.poolSizes.MID} 人、前鋒 ${meta.counts.poolSizes.FWD} 人)。
       點球員看雷達圖,可以勾選兩人做對比。</p>
  </div>

  <div class="section"><h2>排行榜</h2><span class="hint">上季數據・掛在當時效力的球隊</span></div>
  <div class="grid g3">${boardDefs.map(([k, title, unit, fmt]) => `
    <div class="card"><h3>${title} <span class="dim tiny">${unit}</span></h3>
      ${(leaders[k] ?? []).slice(0, 8).map((p, i) => `
        <div class="stat-line" style="cursor:pointer" data-p="${p.code}">
          <span class="small"><span class="dim mono">${String(i + 1).padStart(2)}</span>
            ${C.badge(p.lastTeam ?? p.team)} ${C.esc(p.name)}
            ${p.transferred ? `<span class="tiny dim">→ ${C.zh(p.team)}</span>` : ''}</span>
          <b class="mono small">${fmt(p.value)}</b></div>`).join('')}
    </div>`).join('')}</div>

  <div class="section"><h2>全部球員</h2><span class="hint">可排序、可篩選</span></div>
  <div class="filters">
    <input id="q" type="search" placeholder="搜尋球員…" style="min-width:180px">
    <select id="fTeam"><option value="">所有球隊</option>${codes.map(c => `<option value="${c}">${C.zh(c)}</option>`).join('')}</select>
    <select id="fPos"><option value="">所有位置</option>${POS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
    <select id="fMin"><option value="0">不限出場</option><option value="600" selected>上季 600 分鐘以上</option>
      <option value="1800">上季 1800 分鐘以上</option></select>
    <button class="btn" id="cmpBtn">對比模式:關</button>
    <span class="dim small" id="count"></span>
  </div>
  <div id="cmpBox"></div>
  <div id="list"></div>
  ${C.foot(meta)}`;

  document.querySelectorAll('[data-p]').forEach(el => { el.onclick = () => openPlayer(byCode.get(el.dataset.p)); });

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
      ((p.last?.minutes ?? 0) >= minMin) &&
      (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)));
    document.getElementById('count').textContent = `共 ${rows.length} 人`;
    document.getElementById('list').innerHTML = C.table(rows, [
      { key: 'name', label: '球員', value: p => p.name,
        render: p => `${cmpMode ? `<input type="checkbox" ${compare.includes(p.code) ? 'checked' : ''} style="margin-right:6px">` : ''}${C.esc(p.name)}${p.status !== 'a' ? ` <span class="pill bad tiny">${p.statusZh}</span>` : ''}` },
      { key: 'team', label: '球隊', value: p => C.zh(p.team), render: p => C.teamCell(p.team) },
      { key: 'pos', label: '位置', value: p => ['GK', 'DEF', 'MID', 'FWD'].indexOf(p.pos), render: p => p.posZh },
      { key: 'age', label: '年齡', value: p => p.age ?? 0, num: true },
      { key: 'minutes', label: '分鐘', value: p => p.last?.minutes ?? 0, num: true },
      { key: 'goals', label: '進球', value: p => p.last?.goals ?? 0, num: true },
      { key: 'assists', label: '助攻', value: p => p.last?.assists ?? 0, num: true },
      { key: 'xg90', label: 'xG/90', value: p => p.last?.xg90 ?? 0, num: true },
      { key: 'xa90', label: 'xA/90', value: p => p.last?.xa90 ?? 0, num: true },
      { key: 'finishing', label: '終結', value: p => p.last?.finishing ?? 0, num: true,
        title: '進球 − 期望進球', render: p => (p.last ? C.signed(p.last.finishing, 1) : '—') },
      { key: 'defCon90', label: '防守貢獻/90', value: p => p.last?.defCon90 ?? 0, num: true },
      { key: 'price', label: '身價', value: p => p.price, num: true, render: p => `£${p.price.toFixed(1)}m` },
    ], { sortKey: 'minutes', desc: true, onRow: p => (cmpMode ? toggleCompare(p) : openPlayer(p)) });
  };

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

    C.drawer(`${C.badge(p.team)} ${C.esc(p.name)}`, `
      <div class="card">
        <div class="spread">
          <div><div style="font-size:19px;font-weight:800">${C.esc(p.fullName)}</div>
            <div class="small muted">${p.posZh}・${p.age ?? '?'} 歲・${t.zh}
              ${p.squadNumber ? `・背號 ${p.squadNumber}` : ''}・£${p.price.toFixed(1)}m</div></div>
          ${p.status !== 'a' ? `<span class="pill bad">${p.statusZh}</span>` : '<span class="pill accent">可出賽</span>'}
        </div>
        ${p.news ? `<div class="note" style="margin-top:10px">${C.esc(p.news)}</div>` : ''}
        ${p.transferred ? `<div class="note info" style="margin-top:10px">上季效力 ${C.zh(p.lastTeam)},本季已加盟 ${t.zh};下方數據為在原隊的表現。</div>` : ''}
        ${p.isNewFace ? '<div class="note info" style="margin-top:10px">上季沒有英超出場紀錄(新援、新秀或長期缺陣),沒有可比較的數據。</div>' : ''}
      </div>

      ${p.last && p.qualified ? `<div class="card"><h3>能力雷達</h3>
        ${C.radar([{ name: p.name, color: t.colors[0], values: p.radar }], { size: 300 })}
        <div class="tiny dim center">與同位置、上季出場 600 分鐘以上的球員相比的百分位</div>
        <div style="margin-top:12px">${p.radar.map(r => pctLine(r.label, r.value, r.raw)).join('')}</div>
      </div>` : ''}

      ${p.last ? `<div class="card"><h3>上季數據(${meta.lastSeason})</h3>
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
      <div><a href="teams.html?code=${p.team}">看 ${t.zh} 的完整剖析 →</a></div>`);
  }

  const pc = C.qs('code');
  if (pc && byCode.has(pc)) openPlayer(byCode.get(pc));

} catch (err) { C.fail(err); }
