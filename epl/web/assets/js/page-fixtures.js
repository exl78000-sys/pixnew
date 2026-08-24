import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, fixtures, h2h, players, tactics, results, reports, analysis } =
    await C.load('meta', 'clubs', 'teams', 'fixtures', 'h2h', 'players', 'tactics', 'results', 'reports', 'analysis');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const teamBy = new Map(teams.map(t => [t.code, t]));
  const tacBy = new Map(tactics.map(t => [t.code, t]));
  // 本季看賽程與預測,過去賽季看已完賽的比分與賽後分析
  const pastSeasons = [...new Set(results.map(m => m.season))].filter(x => x !== meta.currentSeason).sort().reverse();
  const bySeason = season => season === meta.currentSeason
    ? fixtures
    : results.filter(m => m.season === season).map(m => ({ ...m, kickoff: null }));
  let season = meta.currentSeason;
  const reportFor = f => reports.reports[`${f.season}|${f.home}|${f.away}`] ?? null;

  const rounds = [...new Set(fixtures.map(f => f.round))].sort((a, b) => a - b);
  const codes = [...new Set(fixtures.flatMap(f => [f.home, f.away]))].sort((a, b) => C.name(a).localeCompare(C.name(b), 'zh-Hant'));
  const nextRound = fixtures.find(f => !f.played && f.date >= meta.asOf)?.round ?? rounds[0];

  app.innerHTML = `
  <div class="page-head">
    <h1>賽程與單場預測</h1>
    <p>每一場都用 Dixon-Coles Poisson 與 Elo 各算一次再取平均(回測顯示兩者平均最準)。
       點任一場可以看比分機率分佈、雙方戰術對比、交手紀錄與傷停。
       開賽時間已換算成你所在時區(${C.tzName()}),並採用會反映轉播改期的官方時間。</p>
    ${C.stampRow([
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算;GitHub Actions 每 15 分鐘跑一次' }),
      C.stamp('開賽時間(官方,含改期)', { iso: meta.builtAt, kind: 'daily' }),
    ])}
  </div>
  <div class="filters">
    <label>賽季</label><select id="fSeason">
      <option value="${meta.currentSeason}">${meta.currentSeason}(本季・預測)</option>
      ${pastSeasons.map(x => `<option value="${x}">${x}(已完賽)</option>`).join('')}</select>
    <label>輪次</label><select id="fRound"><option value="">全部</option>
      ${rounds.map(r => `<option value="${r}" ${r === nextRound ? 'selected' : ''}>第 ${r} 輪</option>`).join('')}</select>
    <label>球隊</label><select id="fTeam"><option value="">全部</option>
      ${codes.map(c => `<option value="${c}">${C.name(c)}</option>`).join('')}</select>
    <label>狀態</label><select id="fState">
      <option value="">全部</option><option value="未賽">未賽</option><option value="已賽">已賽</option></select>
    <span class="dim small" id="count"></span>
  </div>
  <div id="list"></div>
  ${C.foot(meta)}`;

  const render = () => {
    season = document.getElementById('fSeason').value;
    const isCurrent = season === meta.currentSeason;
    const r = document.getElementById('fRound').value;
    const t = document.getElementById('fTeam').value;
    const st = document.getElementById('fState').value;
    const rows = bySeason(season).filter(f =>
      (!r || f.round === +r) && (!t || f.home === t || f.away === t) &&
      (!st || (st === '已賽' ? f.played : !f.played)));
    const withReport = rows.filter(f => reportFor(f)).length;
    document.getElementById('count').textContent =
      `共 ${rows.length} 場${withReport ? `・其中 ${withReport} 場有完整賽後分析` : ''}`;
    document.getElementById('list').innerHTML = C.table(rows, [
      { key: 'date', label: isCurrent ? '開賽時間' : '日期', value: f => f.kickoff ?? f.date,
        render: f => `<span class="small">${f.kickoff ? C.kickoffLocal(f.kickoff) : C.dateFull(f.date)}</span>` },
      { key: 'cd', label: isCurrent ? '倒數' : '狀態', value: f => f.kickoff ?? '', sortable: false,
        render: f => (f.played
          ? (reportFor(f) ? '<span class="pill accent tiny">有賽後分析</span>' : '<span class="dim small">完場</span>')
          : `<span class="small">${C.countdown(f.kickoff)}</span>`) },
      { key: 'round', label: '輪', value: f => f.round, num: true },
      { key: 'home', label: '主隊', value: f => C.name(f.home), render: f => C.teamCell(f.home) },
      { key: 'score', label: '比分 / 預期', value: f => (f.played ? f.fh - f.fa : 0), sortable: false,
        render: f => f.played
          ? `<b class="mono" style="font-size:14px">${f.fh} - ${f.fa}</b>`
          : `<span class="mono dim">${f.prediction.xgHome} : ${f.prediction.xgAway}</span>` },
      { key: 'away', label: '客隊', value: f => C.name(f.away), render: f => C.teamCell(f.away) },
      { key: 'prob', label: isCurrent ? '主 / 和 / 客' : '賽前機率', value: f => f.prediction?.home ?? 0, sortable: false,
        render: f => (f.prediction ? C.probBar(f.prediction) : '<span class="dim small">—</span>') },
      { key: 'hit', label: '模型', value: f => hitScore(f), sortable: false, title: '賽前機率最高的結果是否命中',
        render: f => {
          if (!f.played || !f.prediction) return '—';
          const p = f.prediction, act = f.fh > f.fa ? 'home' : f.fh < f.fa ? 'draw2' : 'draw';
          const pick = [['home', p.home], ['draw', p.draw], ['away', p.away]].sort((a, b) => b[1] - a[1])[0][0];
          const real = f.fh > f.fa ? 'home' : f.fh === f.fa ? 'draw' : 'away';
          return pick === real
            ? `<span class="pill accent tiny">命中 ${C.pct(p[real], 0)}</span>`
            : `<span class="pill tiny">失準 ${C.pct(p[real], 0)}</span>`;
        } },
      { key: 'over', label: '大 2.5', value: f => f.prediction?.over25 ?? 0, num: true,
        render: f => (f.prediction ? C.pct(f.prediction.over25, 0) : '—') },
      { key: 'diff', label: '難度', value: f => (f.difficulty ? f.difficulty.home + f.difficulty.away : 0), num: true,
        title: 'FPL 官方賽程難度(主/客,1~5)',
        render: f => f.difficulty ? `<span class="small dim">${f.difficulty.home} / ${f.difficulty.away}</span>` : '—' },
      { key: 'article', label: '分析', value: () => 0, sortable: false,
        render: f => (!f.played && analysis.pre[`${f.home}|${f.away}`]
          ? `<a class="pill info tiny" href="${C.link('analysis', { id: f.id })}"
               onclick="event.stopPropagation()">賽前分析</a>` : '') },
    ], { sortKey: 'date', desc: false, onRow: openMatch });
    C.startCountdowns();
  };

  const hitScore = f => {
    if (!f.played || !f.prediction) return -1;
    const p = f.prediction;
    const real = f.fh > f.fa ? 'home' : f.fh === f.fa ? 'draw' : 'away';
    return p[real];
  };
  ['fSeason', 'fRound', 'fTeam', 'fState'].forEach(id => { document.getElementById(id).onchange = render; });
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
    const rep = reportFor(f);
    const H = teamBy.get(f.home), A = teamBy.get(f.away);
    const key = [f.home, f.away].sort().join('|');
    const rec = h2h[key];
    const th = tacBy.get(f.home), ta = tacBy.get(f.away);

    const compare = (label, hv, av, d = 2) => `
      <div class="stat-line"><b class="mono">${C.fx(hv, d)}</b>
        <span class="small muted">${label}</span><b class="mono">${C.fx(av, d)}</b></div>`;

    const h2hHtml = rec ? `
      <div class="row small" style="justify-content:space-between">
        <span>${C.name(f.home)} <b>${rec.aWin || rec.bWin ? (f.home < f.away ? rec.aWin : rec.bWin) : 0}</b> 勝</span>
        <span class="dim">和 ${rec.draw}</span>
        <span><b>${f.home < f.away ? rec.bWin : rec.aWin}</b> 勝 ${C.name(f.away)}</span>
      </div>
      <div style="margin-top:8px">${rec.list.slice(0, 5).map(m => `
        <div class="stat-line"><span class="small dim mono">${C.dateFull(m.date)}</span>
          <span class="small">${C.name(m.home)} <b class="mono">${m.fh}-${m.fa}</b> ${C.name(m.away)}</span></div>`).join('')}</div>`
      : '<div class="dim small">近三季沒有交手紀錄(可能是升班馬)。</div>';

    const squadHtml = code => `
      <div><div class="small muted" style="margin-bottom:4px">${C.teamCell(code, { link: false })}</div>
        ${keyPlayers(code).map(pl => `
          <div class="stat-line"><span class="small">${C.esc(pl.name)} <span class="dim tiny">${pl.posZh}</span></span>
            <b class="mono small">${pl.last.xgi90} xGI/90</b></div>`).join('') || '<div class="dim small">上季無足夠出場資料</div>'}
        ${outList(code).length ? `<div class="tiny" style="margin-top:6px;color:var(--loss)">
          傷停:${outList(code).slice(0, 5).map(x => C.esc(x.name)).join('、')}</div>` : ''}
      </div>`;

    C.drawer(`${C.badge(f.home)} ${C.name(f.home)} <span class="dim">vs</span> ${C.name(f.away)} ${C.badge(f.away)}`, `
      <div class="card">
        <div class="spread"><span class="small dim">${f.kickoff ? C.kickoffLocal(f.kickoff) : C.dateFull(f.date)}・${f.season}・第 ${f.round} 輪
          ${f.kickoff && !f.played ? `・開賽倒數 ${C.countdown(f.kickoff)}` : ''}
          ${f.kickoff && f.date < meta.asOf && !f.played ? '<span class="pill warn tiny">賽果待更新</span>' : ''}</span>
          <span class="pill ${f.played ? '' : 'info'}">${f.played ? '完場' : '未開賽'}</span></div>
        ${f.played ? `<div class="scoreline" style="margin:14px 0">
            <div class="side">${C.badge(f.home)}<b>${C.name(f.home)}</b></div>
            <div class="sc">${f.fh} : ${f.fa}</div>
            <div class="side away">${C.badge(f.away)}<b>${C.name(f.away)}</b></div>
          </div>` : ''}
        ${p ? `<div style="margin:12px 0">${C.probBar(p)}</div>` : '<div class="dim small">這場沒有留下賽前預測。</div>'}
        ${f.played && p ? (() => {
          const ZH = { home: '主勝', draw: '和局', away: '客勝' };
          const real = f.fh > f.fa ? 'home' : f.fh === f.fa ? 'draw' : 'away';
          const pick = [['home', p.home], ['draw', p.draw], ['away', p.away]].sort((a, b) => b[1] - a[1])[0];
          const hit = pick[0] === real;
          return `<div class="note ${hit ? 'info' : ''}">賽前模型最看好${ZH[pick[0]]}(${C.pct(pick[1], 0)}),
            實際是<b>${ZH[real]}</b>,模型給這結果 <b>${C.pct(p[real], 0)}</b> —— ${hit ? '判斷正確' : '沒有命中'}。
            預期比分 ${p.xgHome}:${p.xgAway},實際 ${f.fh}:${f.fa}。</div>`;
        })() : ''}
        ${p ? `<div class="grid g3" style="margin-top:10px">
          <div><div class="tiny dim">${f.played ? '賽前預期進球' : '預期進球'}</div><div class="mono"><b>${p.xgHome}</b> : <b>${p.xgAway}</b></div></div>
          <div><div class="tiny dim">大於 2.5 球</div><div class="mono"><b>${C.pct(p.over25)}</b></div></div>
          <div><div class="tiny dim">雙方進球</div><div class="mono"><b>${C.pct(p.btts ?? 0)}</b></div></div>
        </div>
        <div class="small dim" style="margin-top:10px">
          最可能比分 ${(p.topScores ?? []).map(s => `<span class="pill">${s.s} <span class="dim">·</span> ${C.pct(s.p, 0)}</span>`).join(' ')}
        </div>` : ''}
        ${!f.played && p ? `<div style="margin-top:12px">
          <a class="pill accent" href="${C.link('analysis', { id: f.id })}">完整賽前分析(獨立頁面)→</a></div>` : ''}
      </div>

      ${rep ? C.matchReportCards(rep) : (f.played
        ? '<div class="note">這場沒有逐球員的出場資料,所以沒有陣容與戰術解讀。有資料的輪次可用 <span class="mono">npm run season</span> 補上。</div>'
        : '')}

      ${p?.grid ? `<div class="card"><h3>比分機率分佈</h3>${C.scoreHeat(p.grid, f.home, f.away)}</div>` : ''}

      ${p?.poisson ? `<div class="card"><h3>兩套模型怎麼看</h3>
        <div class="stat-line"><span class="small">Poisson 進攻/防守模型</span>
          <span class="mono small">${C.pct(p.poisson.home, 0)} / ${C.pct(p.poisson.draw, 0)} / ${C.pct(p.poisson.away, 0)}</span></div>
        <div class="stat-line"><span class="small">Elo 實力評分</span>
          <span class="mono small">${C.pct(p.elo.home, 0)} / ${C.pct(p.elo.draw, 0)} / ${C.pct(p.elo.away, 0)}</span></div>
        <div class="stat-line"><span class="small"><b>取平均(採用值)</b></span>
          <span class="mono small"><b>${C.pct(p.home, 0)} / ${C.pct(p.draw, 0)} / ${C.pct(p.away, 0)}</b></span></div>
        <div class="tiny dim" style="margin-top:6px">零封機率:${C.name(f.home)} ${C.pct(p.csHome, 0)}・${C.name(f.away)} ${C.pct(p.csAway, 0)}</div>
      </div>` : ''}

      <div class="card"><h3>上季數據對比</h3>
        <div class="row small dim" style="justify-content:space-between;margin-bottom:6px">
          <span>${C.name(f.home)}</span><span>${C.name(f.away)}</span></div>
        ${compare('聯賽名次', H.lastSeason?.pos ?? null, A.lastSeason?.pos ?? null, 0)}
        ${compare('場均勝點', H.lastSeason?.ppg ?? null, A.lastSeason?.ppg ?? null)}
        ${compare('每場期望進球 xG', th?.attack.xG90 ?? null, ta?.attack.xG90 ?? null)}
        ${compare('每場期望失球 xGA', th?.defence.xGA90 ?? null, ta?.defence.xGA90 ?? null)}
        ${compare('主場 / 客場場均勝點', H.lastSeason?.home.ppg ?? null, A.lastSeason?.away.ppg ?? null)}
        ${compare('Elo 實力評分', H.elo, A.elo, 0)}
      </div>

      ${th && ta ? `<div class="card"><h3>戰術風格對比</h3>
        ${C.radar([
          { name: C.name(f.home), color: '#00ff85', values: th.radar },
          { name: C.name(f.away), color: '#04f5ff', values: ta.radar },
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
