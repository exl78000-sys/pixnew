import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, live, fixtures, table, tactics } =
    await C.load('meta', 'clubs', 'teams', 'live', 'fixtures', 'table', 'tactics');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const tacBy = new Map(tactics.map(t => [t.code, t]));
  const matches = live.available ? live.matches : [];
  const inPlay = matches.filter(m => m.started && !m.finished);
  const done = matches.filter(m => m.finished);
  const now = Date.now();
  const upcoming = fixtures
    .filter(f => !f.played && new Date(f.kickoff).getTime() > now - 2 * 3600e3)
    .sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));

  /* 資料來源說明 —— 這一段一定要講清楚,免得把重播當成現正進行 */
  const sourceBanner = () => {
    if (!live.available) {
      return `<div class="note">目前沒有即時比賽資料。<br>
        在自己的電腦上執行 <span class="mono">npm run live</span> 會連官方 FPL API 取得逐分鐘更新;
        受限網路可改用 <span class="mono">npm run live -- --replay=2025-26:1</span> 看真實比賽的示範。
        <br>下方的<b>開賽倒數</b>不需要即時資料,永遠可用。</div>`;
    }
    if (live.demo) {
      return `<div class="note"><b>示範模式</b> —— 這裡顯示的是${C.esc(live.sourceLabel)}。
        資料本身完全真實(真實出場名單、真實 xG、真實比分),但<b>不是現在進行中的比賽</b>。
        要接上真正的即時資料,在自己的電腦上跑 <span class="mono">npm run live</span>(需要能連到官方 FPL API)。</div>`;
    }
    const fresh = new Date(live.fetchedAt);
    return `<div class="note info">資料來源:${C.esc(live.sourceLabel)}・
      最後更新 ${fresh.toLocaleString('zh-TW', { hour12: false })}
      ${live.source === 'mirror' ? '<br>鏡像是每輪賽後才更新的,比賽進行中不會逐分鐘變動;要逐分鐘更新請用 <span class="mono">npm run live -- --source=api</span>。' : ''}</div>`;
  };

  const kpi = (l, v, sub) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`;
  const cur = table.current;
  const curPlayed = cur.reduce((a, r) => a + r.p, 0) / 2;

  app.innerHTML = `
  <div class="page-head">
    <h1>實時戰況</h1>
    <p>進行中的比賽會顯示即時比分、實際排出的陣容與陣型,以及隨比分和時間更新的勝率;
       尚未開賽的顯示倒數計時(已換算成你所在時區 ${C.tzName()});已完賽的直接給賽後解讀。</p>
  </div>

  ${sourceBanner()}

  <div class="grid g4" style="margin-top:14px">
    ${kpi('本季已完賽', `${curPlayed} 場`, `${meta.currentSeason}・共 ${fixtures.length} 場`)}
    ${kpi('進行中', inPlay.length, live.available ? `第 ${live.round} 輪` : '尚無即時資料')}
    ${kpi('下一場開賽', upcoming[0] ? C.countdown(upcoming[0].kickoff) : '—',
      upcoming[0] ? `${C.name(upcoming[0].home)} vs ${C.name(upcoming[0].away)}` : '本季賽程已結束')}
    ${kpi('本輪已完賽', done.length, live.available ? `第 ${live.round} 輪共 ${matches.length} 場` : '—')}
  </div>

  ${inPlay.length ? `
    <div class="section"><h2><span class="livedot"></span>進行中</h2><span class="hint">比分、實際陣型與即時勝率</span></div>
    <div class="grid g2">${inPlay.map(liveCard).join('')}</div>` : ''}

  <div class="section"><h2>開賽倒數</h2><span class="hint">依實際開球時間排序・已換算為 ${C.tzName()}</span></div>
  <div class="grid g2">${upcoming.slice(0, 8).map(countdownCard).join('') || '<div class="card dim">本季沒有未開賽的比賽了。</div>'}</div>
  ${upcoming.length > 8 ? `<div style="margin-top:10px"><a href="${C.link('fixtures')}">看完整賽程(還有 ${upcoming.length - 8} 場)→</a></div>` : ''}

  ${done.length ? `
    <div class="section"><h2>已完賽${live.demo ? `(重播 ${live.season} 第 ${live.round} 輪)` : ''}</h2>
      <span class="hint">${live.demo ? '真實比賽資料,非本季' : `${meta.currentSeason} 第 ${live.round} 輪`}・點任一場看完整賽後解讀</span></div>
    <div class="grid g2">${done.map(finishedCard).join('')}</div>` : ''}

  ${curPlayed > 0 ? `
    <div class="section"><h2>本季即時積分榜</h2><span class="hint">${meta.currentSeason}・依目前已完賽場次計算</span></div>
    <div id="curTable"></div>` : `
    <div class="section"><h2>本季即時積分榜</h2></div>
    <div class="note">${meta.currentSeason} 目前還沒有已完賽的比賽進入資料源,積分榜是空的。
      賽果由 <span class="mono">npm run fetch -- --force</span>(openfootball)或 <span class="mono">npm run live</span> 帶入,
      兩者都會自動併進這張表。</div>`}
  ${C.foot(meta)}`;

  if (curPlayed > 0) {
    document.getElementById('curTable').innerHTML = C.table(cur.filter(r => r.p > 0), [
      { key: 'pos', label: '#', value: r => r.pos, num: true },
      { key: 'team', label: '球隊', value: r => C.name(r.code), render: r => C.teamCell(r.code) },
      { key: 'p', label: '賽', value: r => r.p, num: true },
      { key: 'w', label: '勝', value: r => r.w, num: true },
      { key: 'd', label: '和', value: r => r.d, num: true },
      { key: 'l', label: '負', value: r => r.l, num: true },
      { key: 'gf', label: '進', value: r => r.gf, num: true },
      { key: 'ga', label: '失', value: r => r.ga, num: true },
      { key: 'gd', label: '淨', value: r => r.gd, num: true, render: r => C.signed(r.gd, 0) },
      { key: 'pts', label: '積分', value: r => r.pts, num: true, render: r => `<b>${r.pts}</b>` },
      { key: 'form', label: '戰績', value: r => r.pts, sortable: false, render: r => C.formRun(r.form) },
    ], { sortKey: 'pts', desc: true, onRow: r => C.go('teams', { code: r.code }) });
  }

  C.startCountdowns();
  document.querySelectorAll('[data-match]').forEach(el => {
    el.onclick = e => { e.preventDefault(); openReport(matches.find(m => m.key === el.dataset.match)); };
  });

  /* ── 卡片 ─────────────────────────── */
  // 這兩個要用函式宣告 —— 上面的模板字串會先執行,const 會落在暫時死區
  function scoreLine(home, away, middle) {
    return `<div class="scoreline">
      <div class="side">${C.badge(home)}<b>${C.name(home)}</b></div>
      <div class="sc">${middle}</div>
      <div class="side away">${C.badge(away)}<b>${C.name(away)}</b></div>
    </div>`;
  }
  function scoreOf(m) { return scoreLine(m.home, m.away, `${m.hs ?? '-'} : ${m.as ?? '-'}`); }

  function liveCard(m) {
    const p = m.inplay;
    const H = m.sides[m.home], A = m.sides[m.away];
    return `<a class="card matchcard" href="#" data-match="${m.key}">
      <div class="spread"><span class="pill bad"><span class="livedot"></span>第 ${m.minute} 分鐘</span>
        <span class="tiny dim">第 ${m.round} 輪</span></div>
      <div style="margin:12px 0">${scoreOf(m)}</div>
      <div class="tiny dim center" style="margin-bottom:6px">實際陣型 ${H.shape.label} vs ${A.shape.label}
        ・場上 xG ${H.xG} : ${A.xG}</div>
      ${p ? `${C.probBar(p)}
        <div class="tiny dim center" style="margin-top:6px">剩餘時間期望進球 ${p.xgRestHome} : ${p.xgRestAway}
          ・下一球 ${C.name(m.home)} ${C.pct(p.nextGoal.home, 0)} / ${C.name(m.away)} ${C.pct(p.nextGoal.away, 0)}</div>` : ''}
      ${H.scorers.length || A.scorers.length ? `<div class="tiny" style="margin-top:8px">
        ⚽ ${[...H.scorers.map(s => `${C.esc(s.name)}${s.goals > 1 ? ' ×' + s.goals : ''}`),
             ...A.scorers.map(s => `${C.esc(s.name)}${s.goals > 1 ? ' ×' + s.goals : ''}`)].join('、')}</div>` : ''}
    </a>`;
  }

  function countdownCard(f) {
    const p = f.prediction;
    return `<a class="card matchcard" href="${C.link('fixtures', { id: f.id })}">
      <div class="spread">
        <span class="pill info">第 ${f.round} 輪</span>
        <span class="small">${C.kickoffLocal(f.kickoff)}</span>
      </div>
      <div style="margin:10px 0">${scoreLine(f.home, f.away, '<span class="dim" style="font-size:16px">vs</span>')}</div>
      <div class="center" style="font-size:19px;font-weight:700">${C.countdown(f.kickoff)}</div>
      <div style="margin-top:10px">${C.probBar(p)}</div>
      <div class="tiny dim center" style="margin-top:5px">賽前預期比分 ${p.xgHome} : ${p.xgAway}</div>
    </a>`;
  }

  function finishedCard(m) {
    const H = m.sides[m.home], A = m.sides[m.away];
    const surprise = m.preMatch
      ? (m.hs > m.as ? m.preMatch.home : m.hs < m.as ? m.preMatch.away : m.preMatch.draw)
      : null;
    return `<a class="card matchcard" href="#" data-match="${m.key}">
      <div class="spread"><span class="pill">完場</span>
        <span class="tiny dim">${C.kickoffLocal(m.kickoff)}・第 ${m.round} 輪</span></div>
      <div style="margin:12px 0">${scoreOf(m)}</div>
      <div class="tiny dim center">陣型 ${H.shape.label} vs ${A.shape.label}・xG ${H.xG} : ${A.xG}
        ${surprise !== null ? `・賽前模型給這結果 ${C.pct(surprise, 0)}` : ''}</div>
      ${m.notes.length ? `<div class="small muted" style="margin-top:8px">${C.esc(m.notes[0])}</div>` : ''}
    </a>`;
  }

  /* ── 完整賽後 / 場中報告 ───────────── */
  function openReport(m) {
    if (!m) return;
    const H = m.sides[m.home], A = m.sides[m.away];
    const p = m.inplay;
    C.drawer(`${C.badge(m.home)} ${C.name(m.home)} ${m.hs ?? '-'}-${m.as ?? '-'} ${C.name(m.away)} ${C.badge(m.away)}`, `
      <div class="card">
        <div class="spread">
          <span class="small dim">${C.kickoffLocal(m.kickoff)}・第 ${m.round} 輪</span>
          <span class="pill ${m.finished ? '' : 'bad'}">${m.finished ? '完場' : `第 ${m.minute} 分鐘`}</span>
        </div>
        <div style="margin:14px 0">${scoreOf(m)}</div>
        ${p ? `${C.probBar(p)}
          <div class="tiny dim center" style="margin-top:6px">
            ${m.finished ? '完場後機率收斂為實際結果' : `剩餘 ${Math.round(p.remaining * 90)} 分鐘・期望再進 ${p.xgRestHome} : ${p.xgRestAway}`}</div>` : ''}
        ${m.preMatch ? `<div class="stat-line" style="margin-top:10px">
          <span class="small muted">賽前模型</span>
          <span class="mono small">${C.pct(m.preMatch.home, 0)} / ${C.pct(m.preMatch.draw, 0)} / ${C.pct(m.preMatch.away, 0)}
            ・預期比分 ${m.preMatch.xgHome}:${m.preMatch.xgAway}</span></div>` : ''}
      </div>

      ${C.matchReportCards(m)}

      ${m.fixtureId ? `<div><a href="${C.link('fixtures', { id: m.fixtureId })}">看這場的賽前完整分析 →</a></div>` : ''}`);
  }

} catch (err) { C.fail(err); }
