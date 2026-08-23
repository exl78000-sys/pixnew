import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, fixtures, h2h, players, tactics } =
    await C.load('meta', 'clubs', 'teams', 'fixtures', 'h2h', 'players', 'tactics');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const teamBy = new Map(teams.map(t => [t.code, t]));
  const tacBy = new Map(tactics.map(t => [t.code, t]));
  const rounds = [...new Set(fixtures.map(f => f.round))].sort((a, b) => a - b);
  const codes = [...new Set(fixtures.flatMap(f => [f.home, f.away]))].sort((a, b) => C.zh(a).localeCompare(C.zh(b), 'zh-Hant'));
  const nextRound = fixtures.find(f => !f.played && f.date >= meta.asOf)?.round ?? rounds[0];

  app.innerHTML = `
  <div class="page-head">
    <h1>賽程與單場預測</h1>
    <p>每一場都用 Dixon-Coles Poisson 與 Elo 各算一次再取平均(回測顯示兩者平均最準)。
       點任一場可以看比分機率分佈、雙方戰術對比、交手紀錄與傷停。</p>
  </div>
  <div class="filters">
    <label>輪次</label><select id="fRound"><option value="">全部</option>
      ${rounds.map(r => `<option value="${r}" ${r === nextRound ? 'selected' : ''}>第 ${r} 輪</option>`).join('')}</select>
    <label>球隊</label><select id="fTeam"><option value="">全部</option>
      ${codes.map(c => `<option value="${c}">${C.zh(c)}</option>`).join('')}</select>
    <label>狀態</label><select id="fState">
      <option value="">全部</option><option value="未賽">未賽</option><option value="已賽">已賽</option></select>
    <span class="dim small" id="count"></span>
  </div>
  <div id="list"></div>
  ${C.foot(meta)}`;

  const render = () => {
    const r = document.getElementById('fRound').value;
    const t = document.getElementById('fTeam').value;
    const st = document.getElementById('fState').value;
    const rows = fixtures.filter(f =>
      (!r || f.round === +r) && (!t || f.home === t || f.away === t) &&
      (!st || (st === '已賽' ? f.played : !f.played)));
    document.getElementById('count').textContent = `共 ${rows.length} 場`;
    document.getElementById('list').innerHTML = C.table(rows, [
      { key: 'date', label: '日期', value: f => f.date, render: f => `<span class="mono small">${C.dateFull(f.date)}</span>` },
      { key: 'round', label: '輪', value: f => f.round, num: true },
      { key: 'home', label: '主隊', value: f => C.zh(f.home), render: f => C.teamCell(f.home) },
      { key: 'score', label: '比分 / 預期', value: f => (f.played ? f.fh - f.fa : 0), sortable: false,
        render: f => f.played
          ? `<b class="mono">${f.fh} - ${f.fa}</b>`
          : `<span class="mono dim">${f.prediction.xgHome} : ${f.prediction.xgAway}</span>` },
      { key: 'away', label: '客隊', value: f => C.zh(f.away), render: f => C.teamCell(f.away) },
      { key: 'prob', label: '主 / 和 / 客', value: f => f.prediction.home, sortable: false,
        render: f => C.probBar(f.prediction) },
      { key: 'over', label: '大 2.5', value: f => f.prediction.over25, num: true, render: f => C.pct(f.prediction.over25, 0) },
      { key: 'btts', label: '雙方進球', value: f => f.prediction.btts, num: true, render: f => C.pct(f.prediction.btts, 0) },
      { key: 'diff', label: '難度', value: f => (f.difficulty ? f.difficulty.home + f.difficulty.away : 0), num: true,
        title: 'FPL 官方賽程難度(主/客,1~5)',
        render: f => f.difficulty ? `<span class="small dim">${f.difficulty.home} / ${f.difficulty.away}</span>` : '—' },
    ], { sortKey: 'date', desc: false, onRow: openMatch });
  };

  ['fRound', 'fTeam', 'fState'].forEach(id => { document.getElementById(id).onchange = render; });
  render();

  function keyPlayers(code, n = 4) {
    return players.filter(p => p.team === code && p.last && p.last.minutes >= 450)
      .sort((a, b) => b.last.xgi90 - a.last.xgi90).slice(0, n);
  }
  function outList(code) {
    return players.filter(p => p.team === code && p.news && p.status !== 'a' && !/joined|loan|left/i.test(p.news));
  }

  function openMatch(f) {
    const p = f.prediction;
    const H = teamBy.get(f.home), A = teamBy.get(f.away);
    const key = [f.home, f.away].sort().join('|');
    const rec = h2h[key];
    const th = tacBy.get(f.home), ta = tacBy.get(f.away);

    const compare = (label, hv, av, d = 2) => `
      <div class="stat-line"><b class="mono">${C.fx(hv, d)}</b>
        <span class="small muted">${label}</span><b class="mono">${C.fx(av, d)}</b></div>`;

    const h2hHtml = rec ? `
      <div class="row small" style="justify-content:space-between">
        <span>${C.zh(f.home)} <b>${rec.aWin || rec.bWin ? (f.home < f.away ? rec.aWin : rec.bWin) : 0}</b> 勝</span>
        <span class="dim">和 ${rec.draw}</span>
        <span><b>${f.home < f.away ? rec.bWin : rec.aWin}</b> 勝 ${C.zh(f.away)}</span>
      </div>
      <div style="margin-top:8px">${rec.list.slice(0, 5).map(m => `
        <div class="stat-line"><span class="small dim mono">${C.dateFull(m.date)}</span>
          <span class="small">${C.zh(m.home)} <b class="mono">${m.fh}-${m.fa}</b> ${C.zh(m.away)}</span></div>`).join('')}</div>`
      : '<div class="dim small">近三季沒有交手紀錄(可能是升班馬)。</div>';

    const squadHtml = code => `
      <div><div class="small muted" style="margin-bottom:4px">${C.teamCell(code, { link: false })}</div>
        ${keyPlayers(code).map(pl => `
          <div class="stat-line"><span class="small">${C.esc(pl.name)} <span class="dim tiny">${pl.posZh}</span></span>
            <b class="mono small">${pl.last.xgi90} xGI/90</b></div>`).join('') || '<div class="dim small">上季無足夠出場資料</div>'}
        ${outList(code).length ? `<div class="tiny" style="margin-top:6px;color:var(--loss)">
          傷停:${outList(code).slice(0, 5).map(x => C.esc(x.name)).join('、')}</div>` : ''}
      </div>`;

    C.drawer(`${C.badge(f.home)} ${C.zh(f.home)} <span class="dim">vs</span> ${C.zh(f.away)} ${C.badge(f.away)}`, `
      <div class="card">
        <div class="spread"><span class="small dim">${C.dateFull(f.date)} ${f.time ?? ''}・第 ${f.round} 輪
          ${f.date < meta.asOf && !f.played ? '<span class="pill warn tiny">賽果待更新</span>' : ''}</span>
          ${f.played ? `<b class="mono" style="font-size:19px">${f.fh} - ${f.fa}</b>` : ''}</div>
        <div style="margin:12px 0">${C.probBar(p)}</div>
        <div class="grid g3">
          <div><div class="tiny dim">預期進球</div><div class="mono"><b>${p.xgHome}</b> : <b>${p.xgAway}</b></div></div>
          <div><div class="tiny dim">大於 2.5 球</div><div class="mono"><b>${C.pct(p.over25)}</b></div></div>
          <div><div class="tiny dim">雙方進球</div><div class="mono"><b>${C.pct(p.btts)}</b></div></div>
        </div>
        <div class="small dim" style="margin-top:10px">
          最可能比分 ${p.topScores.map(s => `<span class="pill">${s.s} ${C.pct(s.p, 0)}</span>`).join(' ')}
        </div>
      </div>

      <div class="card"><h3>比分機率分佈</h3>${C.scoreHeat(p.grid, f.home, f.away)}</div>

      <div class="card"><h3>兩套模型怎麼看</h3>
        <div class="stat-line"><span class="small">Poisson 進攻/防守模型</span>
          <span class="mono small">${C.pct(p.poisson.home, 0)} / ${C.pct(p.poisson.draw, 0)} / ${C.pct(p.poisson.away, 0)}</span></div>
        <div class="stat-line"><span class="small">Elo 實力評分</span>
          <span class="mono small">${C.pct(p.elo.home, 0)} / ${C.pct(p.elo.draw, 0)} / ${C.pct(p.elo.away, 0)}</span></div>
        <div class="stat-line"><span class="small"><b>取平均(採用值)</b></span>
          <span class="mono small"><b>${C.pct(p.home, 0)} / ${C.pct(p.draw, 0)} / ${C.pct(p.away, 0)}</b></span></div>
        <div class="tiny dim" style="margin-top:6px">零封機率:${C.zh(f.home)} ${C.pct(p.csHome, 0)}・${C.zh(f.away)} ${C.pct(p.csAway, 0)}</div>
      </div>

      <div class="card"><h3>上季數據對比</h3>
        <div class="row small dim" style="justify-content:space-between;margin-bottom:6px">
          <span>${C.zh(f.home)}</span><span>${C.zh(f.away)}</span></div>
        ${compare('聯賽名次', H.lastSeason?.pos ?? null, A.lastSeason?.pos ?? null, 0)}
        ${compare('場均勝點', H.lastSeason?.ppg ?? null, A.lastSeason?.ppg ?? null)}
        ${compare('每場期望進球 xG', th?.attack.xG90 ?? null, ta?.attack.xG90 ?? null)}
        ${compare('每場期望失球 xGA', th?.defence.xGA90 ?? null, ta?.defence.xGA90 ?? null)}
        ${compare('主場 / 客場場均勝點', H.lastSeason?.home.ppg ?? null, A.lastSeason?.away.ppg ?? null)}
        ${compare('Elo 實力評分', H.elo, A.elo, 0)}
      </div>

      ${th && ta ? `<div class="card"><h3>戰術風格對比</h3>
        ${C.radar([
          { name: C.zh(f.home), color: '#00ff85', values: th.radar },
          { name: C.zh(f.away), color: '#04f5ff', values: ta.radar },
        ], { size: 320 })}
        <div class="row tiny" style="justify-content:center;gap:6px;margin-top:6px">
          ${th.tags.slice(0, 3).map(t => `<span class="pill accent">${t}</span>`).join('')}
          ${ta.tags.slice(0, 3).map(t => `<span class="pill info">${t}</span>`).join('')}
        </div></div>` : ''}

      <div class="card"><h3>近三季交手</h3>${h2hHtml}</div>

      <div class="card"><h3>關鍵球員(上季 xGI/90)</h3>
        <div class="grid g2">${squadHtml(f.home)}${squadHtml(f.away)}</div>
      </div>`);
  }

  const id = C.qs('id');
  if (id) { const f = fixtures.find(x => x.id === id); if (f) openMatch(f); }

} catch (err) { C.fail(err); }
