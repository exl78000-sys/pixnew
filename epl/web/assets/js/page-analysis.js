import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, fixtures, h2h, players, tactics, analysis } =
    await C.load('meta', 'clubs', 'teams', 'fixtures', 'h2h', 'players', 'tactics', 'analysis');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const teamBy = new Map(teams.map(t => [t.code, t]));
  const tacBy = new Map(tactics.map(t => [t.code, t]));
  const articleFor = f => analysis.pre[`${f.home}|${f.away}`] ?? null;

  // 網址可以用 ?id=(跟賽程頁一致)或 ?home=&away=(人看得懂,可以直接手打)
  const id = C.qs('id');
  const hq = C.qs('home'), aq = C.qs('away');
  const target = id ? fixtures.find(f => f.id === id)
    : hq && aq ? fixtures.find(f => f.home === hq && f.away === aq) : null;

  if (target) renderMatch(target); else renderList();

  /* ── 沒指定比賽:列出有分析的場次 ─────────── */
  function renderList() {
    const list = fixtures.filter(f => !f.played && articleFor(f))
      .sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));
    app.innerHTML = `
    <div class="page-head">
      <h1>賽前分析</h1>
      <p>每場比賽一頁,有固定網址,可以直接分享。文章裡的每個數字都來自本站的統計模型,
         不是評論員的印象 —— 也因此它不會談轉會八卦或更衣室氣氛,那些我們沒有資料。</p>
    ${C.stampRow([
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算;GitHub Actions 每 15 分鐘跑一次' }),
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
    ])}
    </div>
    ${list.length ? '' : '<div class="note">目前沒有待分析的場次(可能本季賽程尚未開始,或都已完賽)。</div>'}
    <div id="list"></div>
    ${C.foot(meta)}`;

    if (!list.length) return;
    document.getElementById('list').innerHTML = C.table(list, [
      { key: 'date', label: '開賽時間', value: f => f.kickoff,
        render: f => `<span class="small">${C.kickoffLocal(f.kickoff)}</span>` },
      { key: 'cd', label: '倒數', value: f => f.kickoff, sortable: false,
        render: f => `<span class="small">${C.countdown(f.kickoff)}</span>` },
      { key: 'round', label: '輪', value: f => f.round, num: true },
      { key: 'home', label: '主隊', value: f => C.name(f.home), render: f => C.teamCell(f.home) },
      { key: 'away', label: '客隊', value: f => C.name(f.away), render: f => C.teamCell(f.away) },
      { key: 'prob', label: '主 / 和 / 客', value: f => f.prediction.home, sortable: false,
        render: f => C.probBar(f.prediction) },
      { key: 'src', label: '文章', value: f => articleFor(f).source, sortable: false,
        render: f => (articleFor(f).source === 'llm'
          ? '<span class="pill accent tiny">AI 潤稿</span>' : '<span class="pill tiny">模板</span>') },
      { key: 'go', label: '', value: () => 0, sortable: false,
        render: f => `<a class="pill info tiny" href="${C.link('analysis', { id: f.id })}">看分析 →</a>` },
    ], { sortKey: 'date', desc: false });
    C.startCountdowns();
  }

  /* ── 單場分析 ────────────────────────────── */
  function renderMatch(f) {
    const p = f.prediction;
    const art = articleFor(f);
    const H = teamBy.get(f.home), A = teamBy.get(f.away);
    const th = tacBy.get(f.home), ta = tacBy.get(f.away);
    const rec = h2h[[f.home, f.away].sort().join('|')] ?? null;
    const state = C.scheduleState(f);

    const cmp = (label, hv, av, d = 2, better = 'high') => {
      const win = hv === null || av === null ? null : better === 'high' ? (hv > av ? 'h' : hv < av ? 'a' : null)
        : (hv < av ? 'h' : hv > av ? 'a' : null);
      const mark = side => (win === side ? 'style="color:var(--accent)"' : '');
      return `<div class="stat-line"><b class="mono" ${mark('h')}>${C.fx(hv, d)}</b>
        <span class="small muted">${label}</span><b class="mono" ${mark('a')}>${C.fx(av, d)}</b></div>`;
    };

    app.innerHTML = `
    <div class="page-head">
      <a class="small dim" href="${C.link('analysis')}">← 所有賽前分析</a>
      <h1 style="margin-top:6px">${C.name(f.home)} <span class="dim">vs</span> ${C.name(f.away)}</h1>
      <p>${f.season} 賽季第 ${f.round} 輪・${C.kickoffLocal(f.kickoff)}(${C.tzName()})</p>
      ${C.stampRow([
        C.stamp('勝率與預期進球', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算' }),
        C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '戰術指標與關鍵球員來自上季' }),
        art ? C.stamp('本文', { iso: meta.builtAt, kind: 'daily', note: art.source === 'llm' ? 'AI 撰寫,數字經過驗證' : '由統計結果自動生成' }) : null,
      ])}
    </div>

    <div class="card">
      <div class="scoreline" style="margin:4px 0 14px">
        <div class="side">${C.badge(f.home, 'big')}<b>${C.name(f.home)}</b></div>
        <div class="sc" style="font-size:20px">${p.xgHome} <span class="dim">:</span> ${p.xgAway}</div>
        <div class="side away">${C.badge(f.away, 'big')}<b>${C.name(f.away)}</b></div>
      </div>
      <div class="center small dim" style="margin-bottom:10px">模型預期進球</div>
      ${C.probBar(p)}
      <div class="row small dim" style="justify-content:space-between;margin-top:6px">
        <span>主勝 ${C.pct(p.home, 0)}</span><span>和局 ${C.pct(p.draw, 0)}</span><span>客勝 ${C.pct(p.away, 0)}</span></div>
      <div class="spread" style="margin-top:14px">
        <span class="small">${state.phase === 'upcoming'
          ? `開賽倒數 ${C.countdown(f.kickoff)}`
          : `<span class="pill warn tiny">${C.elapsedText(state.elapsed)}</span>`}</span>
        <a class="pill info tiny" href="${C.link('live')}">看實時戰況 →</a>
      </div>
    </div>

    ${art ? `<div class="section"><h2>${C.esc(art.title)}</h2>
      <span class="hint">${art.source === 'llm' ? 'AI 撰寫,數字經過驗證' : '由統計結果自動生成'}</span></div>
      <div class="card">
        <div id="article" style="display:grid;gap:12px;line-height:1.85"></div>
        <div class="note" style="margin-top:14px">${C.esc(art.caveat)}</div>
        ${art.note ? `<div class="tiny dim" style="margin-top:8px">${C.esc(art.note)}</div>` : ''}
      </div>` : ''}

    <div class="section"><h2>兩套模型怎麼看</h2><span class="hint">分歧本身就是資訊</span></div>
    <div class="card">
      <div class="stat-line"><span class="small">Dixon-Coles Poisson(看進失球的量)</span>
        <span class="mono small">${C.pct(p.poisson.home, 0)} / ${C.pct(p.poisson.draw, 0)} / ${C.pct(p.poisson.away, 0)}</span></div>
      <div class="stat-line"><span class="small">Elo 實力評分(看贏球的結果)</span>
        <span class="mono small">${C.pct(p.elo.home, 0)} / ${C.pct(p.elo.draw, 0)} / ${C.pct(p.elo.away, 0)}</span></div>
      <div class="stat-line"><span class="small"><b>取平均(本站採用)</b></span>
        <span class="mono small"><b>${C.pct(p.home, 0)} / ${C.pct(p.draw, 0)} / ${C.pct(p.away, 0)}</b></span></div>
      <div class="tiny dim" style="margin-top:8px">
        為什麼取平均:${meta.model.backtest.available
          ? `回測 ${meta.model.backtest.games} 場,平均後的 RPS ${meta.model.backtest.rps} 比單獨使用任一個都低。`
          : '回測顯示兩者平均最穩。'}
        <a href="${C.link('model')}">看完整驗證 →</a></div>
    </div>

    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3>其他機率</h3>
        <div class="stat-line"><span class="small">大於 2.5 球</span><b class="mono">${C.pct(p.over25)}</b></div>
        <div class="stat-line"><span class="small">雙方都進球</span><b class="mono">${C.pct(p.btts ?? 0)}</b></div>
        <div class="stat-line"><span class="small">${C.name(f.home)} 零封</span><b class="mono">${C.pct(p.csHome)}</b></div>
        <div class="stat-line"><span class="small">${C.name(f.away)} 零封</span><b class="mono">${C.pct(p.csAway)}</b></div>
        <div class="small dim" style="margin-top:10px">最可能比分
          ${(p.topScores ?? []).map(s => `<span class="pill">${s.s} <span class="dim">·</span> ${C.pct(s.p, 0)}</span>`).join(' ')}</div>
      </div>
      <div class="card"><h3>數據對比</h3>
        <div class="row small dim" style="justify-content:space-between;margin-bottom:6px">
          <span>${C.name(f.home)}</span><span>${C.name(f.away)}</span></div>
        ${cmp('Elo 實力評分', H.elo, A.elo, 0)}
        ${cmp('上季聯賽名次', H.lastSeason?.pos ?? null, A.lastSeason?.pos ?? null, 0, 'low')}
        ${cmp('上季場均勝點', H.lastSeason?.ppg ?? null, A.lastSeason?.ppg ?? null)}
        ${cmp('每場期望進球 xG', th?.attack.xG90 ?? null, ta?.attack.xG90 ?? null)}
        ${cmp('每場期望失球 xGA', th?.defence.xGA90 ?? null, ta?.defence.xGA90 ?? null, 2, 'low')}
        ${cmp('領先守成率 %', th?.resilience.leadHoldPct ?? null, ta?.resilience.leadHoldPct ?? null, 1)}
        ${cmp('落後翻盤率 %', th?.resilience.trailRescuePct ?? null, ta?.resilience.trailRescuePct ?? null, 1)}
        <div class="tiny dim" style="margin-top:8px">綠色代表該項較佳(名次與失球是越低越好)。
          ${promoted(f).length ? `${promoted(f).join('、')} 是升班馬,沒有上季英超資料,所以這幾欄是空的 ——
            模型改用「聯盟後段先驗」估計其實力,不確定性比其他球隊大。` : ''}</div>
      </div>
    </div>

    ${p.grid ? `<div class="section"><h2>比分機率分佈</h2><span class="hint">顏色越亮代表越可能</span></div>
      <div class="card">${C.scoreHeat(p.grid, f.home, f.away)}</div>` : ''}

    ${!(th && ta) ? `<div class="note" style="margin-top:16px">
      ${promoted(f).join('、')} 沒有上季英超的全季統計,因此無法做戰術風格對比。
      等本季累積足夠場次後,這一段會自動出現。</div>` : ''}
    ${th && ta ? `<div class="section"><h2>戰術風格對比</h2><span class="hint">上季全季統計的百分位</span></div>
      <div class="card">
        ${C.radar([
          { name: C.name(f.home), color: '#00ff85', values: th.radar },
          { name: C.name(f.away), color: '#04f5ff', values: ta.radar },
        ], { size: 340 })}
        <div class="stat-line" style="margin-top:10px"><span class="small">${C.teamCell(f.home, { link: false })}</span>
          <span class="row tiny" style="gap:5px">${th.tags.slice(0, 3).map(t => `<span class="pill accent">${C.esc(t)}</span>`).join('')}
            <span class="mono dim">${th.formation.label}</span></span></div>
        <div class="stat-line"><span class="small">${C.teamCell(f.away, { link: false })}</span>
          <span class="row tiny" style="gap:5px">${ta.tags.slice(0, 3).map(t => `<span class="pill info">${C.esc(t)}</span>`).join('')}
            <span class="mono dim">${ta.formation.label}</span></span></div>
        <div class="tiny dim" style="margin-top:6px">標籤是上季全季統計歸納出的風格,右側為平均站位。</div>
      </div>` : ''}

    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3>近三季交手</h3>${h2hHtml(f, rec)}</div>
      <div class="card"><h3>關鍵球員(上季 xGI/90)</h3>
        <div class="grid g2">${squadHtml(f.home)}${squadHtml(f.away)}</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h2>這份分析怎麼來的</h2>
      <div class="small muted" style="display:grid;gap:8px">
        <div><b>數字先算完,文字才生成。</b>勝率、期望進球、戰術指標全部由統計模型算出,
          寫成文章的那一步只能引用這些已經算好的數字 ——
          任何一個數字對不上,整篇就會被退回改用制式模板,不會登出去。</div>
        <div><b>資料來源:</b>${meta.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>`).join('、')}。
          基準日 ${meta.asOf},建置於 ${meta.builtAt.slice(0, 16).replace('T', ' ')} UTC。</div>
        <div><b>模型:</b>${meta.model.type}。<a href="${C.link('model')}">回測與校準結果</a>是公開的,
          包含模型錯得最離譜的那幾場。</div>
        <div><b>不知道的事:</b>${meta.model.caveats[0]}</div>
      </div>
    </div>
    ${C.foot(meta)}`;

    if (art) {
      document.getElementById('article').innerHTML =
        art.paragraphs.map(t => `<p style="margin:0">${C.esc(t)}</p>`).join('');
    }
    C.startCountdowns();
  }

  // 升班馬沒有上季英超資料,頁面上多處要據實說明,不能只留空白
  function promoted(f) {
    return [f.home, f.away].filter(c => !tacBy.has(c)).map(c => C.name(c));
  }

  function h2hHtml(f, rec) {
    if (!rec) return '<div class="dim small">近三季沒有交手紀錄(可能是升班馬)。</div>';
    const homeIsA = [f.home, f.away].sort()[0] === f.home;
    return `<div class="row small" style="justify-content:space-between">
        <span>${C.name(f.home)} <b>${homeIsA ? rec.aWin : rec.bWin}</b> 勝</span>
        <span class="dim">和 ${rec.draw}</span>
        <span><b>${homeIsA ? rec.bWin : rec.aWin}</b> 勝 ${C.name(f.away)}</span>
      </div>
      <div style="margin-top:8px">${rec.list.slice(0, 6).map(m => `
        <div class="stat-line"><span class="small dim mono">${C.dateFull(m.date)}</span>
          <span class="small">${C.name(m.home)} <b class="mono">${m.fh}-${m.fa}</b> ${C.name(m.away)}</span></div>`).join('')}</div>`;
  }

  function squadHtml(code) {
    const key = players.filter(p => p.team === code && p.last && p.last.minutes >= 450)
      .sort((a, b) => b.last.xgi90 - a.last.xgi90).slice(0, 4);
    const out = players.filter(p => p.team === code && p.news && p.status !== 'a' && !/joined|loan|left/i.test(p.news));
    return `<div><div class="small muted" style="margin-bottom:4px">${C.teamCell(code, { link: false })}</div>
      ${key.map(pl => `<div class="stat-line"><span class="small">${C.esc(pl.name)} <span class="dim tiny">${pl.posZh}</span></span>
        <b class="mono small">${pl.last.xgi90}</b></div>`).join('') || '<div class="dim small">上季無足夠出場資料</div>'}
      ${out.length ? `<div class="tiny" style="margin-top:6px;color:var(--loss)">
        傷停:${out.slice(0, 5).map(x => C.esc(x.name)).join('、')}</div>` : ''}</div>`;
  }

} catch (err) { C.fail(err); }
