import * as C from './core.js';

const app = document.getElementById('app');

try {
  /* 抽屜瘦身之後就不需要 h2h / players / tactics 了 —— 那三張卡片搬去賽前分析頁,
     這裡少載 players.json 一份(2 MB 出頭),分頁模式下的首次開啟明顯變快。 */
  const { meta, clubs, teams, fixtures, results, reports, analysis } =
    await C.load('meta', 'clubs', 'teams', 'fixtures', 'results', 'reports', 'analysis');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();
  // 本季看賽程與預測,過去賽季看已完賽的比分與賽後分析
  const pastSeasons = [...new Set(results.map(m => m.season))].filter(x => x !== meta.currentSeason).sort().reverse();
  const bySeason = season => season === meta.currentSeason
    ? fixtures
    : results.filter(m => m.season === season).map(m => ({ ...m, kickoff: null }));
  let season = meta.currentSeason;
  const reportFor = f => reports.reports[`${f.season}|${f.home}|${f.away}`] ?? null;
  // 賽前分析頁只處理未開賽的場次,已完賽的別給一個點進去是空的連結
  const hasArticle = f => !f.played && !!analysis.pre[`${f.home}|${f.away}`];

  const rounds = [...new Set(fixtures.map(f => f.round))].sort((a, b) => a - b);
  const codes = [...new Set(fixtures.flatMap(f => [f.home, f.away]))].sort((a, b) => C.name(a).localeCompare(C.name(b), 'zh-Hant'));
  const nextRound = fixtures.find(f => !f.played && f.date >= meta.asOf)?.round ?? rounds[0];

  app.innerHTML = `
  <div class="page-head">
    <h1>賽程與預測</h1>
    <p>每一場都用 Dixon-Coles Poisson 與 Elo 各算一次再取平均(回測顯示兩者平均最準)。
       點任一場會開速覽:未開賽看勝率與最可能比分,已完賽看賽果與模型有沒有命中;
       想看陣容、戰術對比、近況與傷停,速覽裡有一顆進<b>完整賽前分析</b>的按鈕。
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
        // 直達完整分析,不用先開抽屜再點一次
        render: f => (hasArticle(f)
          ? `<a class="pill info tiny" href="${C.link('analysis', { id: f.id })}"
               onclick="event.stopPropagation()">完整分析 →</a>` : '') },
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

  /* 速覽抽屜。刻意只放「這一場的結果或機率」——
     陣容、戰術對比、交手紀錄、近況傷停全部在賽前分析頁,
     以前這裡各複製了一份,而且是比較差的版本(戰術雷達寫死綠藍兩色、
     數據對比沒有隊色對照條、傷停用字串比對而不是傷停模組)。
     一份資料兩個地方畫,改了一邊另一邊就會悄悄過期 —— 所以只留一份。 */
  function openMatch(f) {
    const p = f.prediction;
    const rep = reportFor(f);
    const full = `<a class="pill accent" href="${C.link('analysis', { id: f.id })}">完整賽前分析 →</a>`;

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
        ${/* g3 的自動欄寬在 680px 的抽屜裡只排得下兩欄,第三項會單獨掉到下一行。
             這三個值都很短,直接指定三等分即可,手機上(抽屜滿版 ~390px)也還有餘裕。 */ ''}
        ${p ? `<div class="grid g3" style="margin-top:10px;grid-template-columns:repeat(3,1fr)">
          <div><div class="tiny dim">${f.played ? '賽前預期進球' : '預期進球'}</div><div class="mono"><b>${p.xgHome}</b> : <b>${p.xgAway}</b></div></div>
          <div><div class="tiny dim">大於 2.5 球</div><div class="mono"><b>${C.pct(p.over25)}</b></div></div>
          <div><div class="tiny dim">雙方進球</div><div class="mono"><b>${C.pct(p.btts ?? 0)}</b></div></div>
        </div>
        <div class="small dim" style="margin-top:10px">
          最可能比分 ${(p.topScores ?? []).map(s => `<span class="pill">${s.s} <span class="dim">·</span> ${C.pct(s.p, 0)}</span>`).join(' ')}
        </div>` : ''}
        ${hasArticle(f) ? `<div class="spread" style="margin-top:14px;align-items:center">
          <span class="tiny dim">陣容、戰術對比、歷來交手、近況與傷停都在那一頁</span>${full}</div>` : ''}
      </div>

      ${rep ? C.matchReportCards(rep) : (f.played
        ? '<div class="note">這場沒有逐球員的出場資料,所以沒有陣容與戰術解讀。有資料的輪次可用 <span class="mono">npm run season</span> 補上。</div>'
        : '')}`);
  }

  const id = C.qs('id');
  if (id) { const f = fixtures.find(x => x.id === id); if (f) openMatch(f); }

} catch (err) { C.fail(err); }
