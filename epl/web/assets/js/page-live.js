import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, live: liveInitial, fixtures, table, tactics, analysis } =
    await C.load('meta', 'clubs', 'teams', 'live', 'fixtures', 'table', 'tactics', 'analysis');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const tacBy = new Map(tactics.map(t => [t.code, t]));
  // 整頁的渲染包成函式:輪詢到新資料、或單純時間往前走(比賽從未開賽變成進行中)時,
  // 都可以重跑一次,不必整頁重新載入。
  let live = liveInitial;
  // 即時模式(npm run live:watch)會在資料裡自報;靜態站沒有這個旗標
  const isLiveMode = () => !!live.liveMode;

  function renderPage() {
    const scrollY = window.scrollY;
    const matches = live.available ? live.matches : [];
    const liveByKey = new Map(matches.filter(m => !live.demo).map(m => [`${m.home}|${m.away}`, m]));
    const done = matches.filter(m => m.finished);
    const now = Date.now();

    // 就算沒有即時資料源,光靠賽程也知道現在有哪幾場正在踢 —— 這一段永遠可用
    const phased = fixtures.map(f => ({ f, s: C.scheduleState(f, now) }));
    const inPlaySched = phased.filter(x => x.s.phase === 'inplay').sort((a, b) => (a.f.kickoff < b.f.kickoff ? -1 : 1));
    const awaiting = phased.filter(x => x.s.phase === 'awaiting' && !x.f.played)
      .sort((a, b) => (a.f.kickoff > b.f.kickoff ? -1 : 1)).slice(0, 12);
    const upcoming = phased.filter(x => x.s.phase === 'upcoming').map(x => x.f)
      .sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));

    // 有真正即時資料的比賽優先用即時資料,其餘用賽程推導
    const liveCards = inPlaySched.map(({ f, s }) => ({ f, s, m: liveByKey.get(`${f.home}|${f.away}`) ?? null }));
    const withRealData = liveCards.filter(x => x.m).length;

    /* 資料來源說明 —— 這一段一定要講清楚,免得把重播當成現正進行 */
    const sourceBanner = () => {
      if (!live.available) {
        return `<div class="note">目前沒有接上即時比賽資料源。<br>
          在自己的電腦上執行 <span class="mono">npm run live</span> 會連官方 FPL API 取得逐分鐘更新;
          受限網路可改用 <span class="mono">npm run live -- --replay=2025-26:1</span> 看真實比賽的示範。
          <br>下方的<b>開賽倒數</b>不需要即時資料,永遠可用。</div>`;
      }
      if (live.demo) {
        return `<div class="note">上方的<b>進行中 / 等待賽果 / 開賽倒數</b>是依本季賽程與現在時間推算的,是真的。<br>
          下方<b>「已完賽」區塊</b>目前放的是${C.esc(live.sourceLabel)} —— 資料完全真實(真實出場名單、真實 xG、
          真實比分),但<b>不是本季的比賽</b>,只是用來示範賽後分析長什麼樣。<br>
          要接上本季真正的即時比分,在自己的電腦上跑 <span class="mono">npm run live:watch</span>。</div>`;
      }
      const fresh = new Date(live.fetchedAt);
      const age = Math.round((Date.now() - fresh.getTime()) / 60000);
      const ageText = age < 2 ? '剛剛' : age < 90 ? `${age} 分鐘前` : `${Math.round(age / 60)} 小時前`;
      return `<div class="note info">資料來源:${C.esc(live.sourceLabel)}・
        資料時間 ${fresh.toLocaleString('zh-TW', { hour12: false })}(${ageText})
        ${isLiveMode()
          ? `<br><b>即時模式進行中</b> —— 每 ${Math.round((live.pollIntervalMs ?? 60000) / 1000)} 秒自動更新,不用重整。`
          : '<br>這是<b>當時的快照</b>,不會自己更新。要逐分鐘更新請在自己的電腦上跑 <span class="mono">npm run live:watch</span>。'}
        ${live.source === 'mirror' ? '<br>鏡像是每輪賽後才更新的,比賽進行中不會逐分鐘變動。' : ''}</div>`;
    };

    const kpi = (l, v, sub) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`;
    const cur = table.current;
    const curPlayed = cur.reduce((a, r) => a + r.p, 0) / 2;

    app.innerHTML = `
    <div class="page-head">
      <h1>實時戰況</h1>
      <p>進行中的比賽會顯示即時比分、實際排出的陣容與陣型,以及隨比分和時間更新的勝率;
         尚未開賽的顯示倒數計時(已換算成你所在時區 ${C.tzName()});已完賽的直接給賽後解讀。</p>
      ${C.stampRow([
        live.available
          ? C.stamp('比分與陣容', { iso: live.fetchedAt, kind: 'live', note: '來源:' + live.sourceLabel })
          : C.stamp('比分與陣容', { kind: 'live', note: '目前沒有接上即時資料源' }),
        C.stamp('賽前勝率與開賽時間', { iso: meta.builtAt, kind: 'daily' }),
        C.stamp('倒數計時', { kind: 'live', note: '瀏覽器每秒重算,不需要資料源' }),
      ])}
    </div>

    ${sourceBanner()}

    <div class="grid g4" style="margin-top:14px">
      ${kpi('本季已完賽', `${curPlayed} 場`, `${meta.currentSeason}・共 ${fixtures.length} 場`)}
      ${kpi('進行中', inPlaySched.length, inPlaySched.length
        ? (withRealData ? `${withRealData} 場有即時比分` : '比分需要即時資料源')
        : '目前沒有比賽在踢')}
      ${kpi('下一場開賽', upcoming[0] ? C.countdown(upcoming[0].kickoff) : '—',
        upcoming[0] ? `${C.name(upcoming[0].home)} vs ${C.name(upcoming[0].away)}` : '本季賽程已結束')}
      ${kpi('本輪已完賽', done.length, live.available ? `第 ${live.round} 輪共 ${matches.length} 場` : '—')}
    </div>

    ${inPlaySched.length ? `
      <div class="section"><h2><span class="livedot"></span>進行中</h2>
        <span class="hint">依賽程推算・${withRealData ? `${withRealData} 場已接上即時比分` : '尚未接上即時比分'}</span></div>
      ${!withRealData ? `<div class="note" style="margin-bottom:10px">
        這 ${inPlaySched.length} 場<b>依賽程現在正在進行</b>,但目前沒有接上即時資料源,所以看不到比分。<br>
        在自己的電腦上執行 <span class="mono">npm run live:watch</span>,頁面就會每分鐘自動更新真實比分、
        場上陣容與即時勝率。</div>` : ''}
      <div class="grid g2">${liveCards.map(x => x.m ? liveCard(x.m) : schedCard(x)).join('')}</div>` : ''}

    ${awaiting.length ? `
      <div class="section"><h2>等待賽果</h2><span class="hint">時間上早該結束,但資料源還沒更新比分</span></div>
      <div class="grid g3">${awaiting.map(({ f, s }) => `
        <a class="card matchcard" href="${C.link('analysis', { id: f.id })}" style="padding:12px 14px">
          <div class="spread"><span class="tiny dim">${C.kickoffLocal(f.kickoff)}・第 ${f.round} 輪</span>
            <span class="pill warn tiny">賽果未取得</span></div>
          <div class="row" style="gap:7px;margin-top:8px">${C.badge(f.home)}<b class="small">${C.name(f.home)}</b>
            <span class="dim">vs</span>${C.badge(f.away)}<b class="small">${C.name(f.away)}</b></div>
          <div class="tiny dim" style="margin-top:6px">賽前預期 ${f.prediction.xgHome}:${f.prediction.xgAway}</div>
        </a>`).join('')}</div>` : ''}

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
      // 列全部 20 隊(含尚未出賽的),名次才不會跳號
      document.getElementById('curTable').innerHTML = C.table(cur, [
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
        { key: 'form', label: '戰績', value: r => r.pts, sortable: false,
          render: r => (r.p ? C.formRun(r.form) : '<span class="dim tiny">尚未出賽</span>') },
      ], { sortKey: 'pts', desc: true, onRow: r => C.go('teams', { code: r.code }) });
    }

    C.startCountdowns();
    document.querySelectorAll('[data-match]').forEach(el => {
      el.onclick = e => { e.preventDefault(); openReport(matches.find(m => m.key === el.dataset.match)); };
    });

    window.scrollTo(0, scrollY);
  }

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

  // 沒有即時資料時的卡片:誠實顯示「正在進行、比分未知」
  function schedCard({ f, s }) {
    const p = f.prediction;
    return `<a class="card matchcard" href="${C.link('analysis', { id: f.id })}">
      <div class="spread"><span class="pill bad"><span class="livedot"></span>${C.elapsedText(s.elapsed)}</span>
        <span class="tiny dim">第 ${f.round} 輪</span></div>
      <div style="margin:12px 0">${scoreLine(f.home, f.away, '<span class="dim" style="font-size:22px">? : ?</span>')}</div>
      <div class="tiny dim center" style="margin-bottom:8px">比分需要即時資料源・下面是賽前預測</div>
      ${C.probBar(p)}
      <div class="tiny dim center" style="margin-top:6px">賽前預期比分 ${p.xgHome} : ${p.xgAway}
        ・最可能 ${p.topScores[0].s}(${C.pct(p.topScores[0].p, 0)})</div>
    </a>`;
  }

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
    return `<a class="card matchcard" href="${C.link('analysis', { id: f.id })}">
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
      ${m.notes.length ? `<div class="small muted" style="margin-top:8px">${C.esc(m.notes[0].text)}</div>` : ''}
    </a>`;
  }

  /* ── 完整賽後 / 場中報告 ───────────── */
  // 賽後文章跟賽前分析走同一套流程:數字先算完,文字只能引用算好的數字
  function articleCard(m) {
    const art = analysis.post[`${m.season ?? meta.currentSeason}|${m.home}|${m.away}`];
    if (!art) return '';
    return `<div class="card"><h3>${C.esc(art.title)}
        <span class="pill tiny ${art.source === 'llm' ? 'accent' : ''}">${art.source === 'llm' ? 'AI 潤稿' : '自動生成'}</span></h3>
      <div style="display:grid;gap:10px;line-height:1.8">
        ${art.paragraphs.map(t => `<p class="small" style="margin:0">${C.esc(t)}</p>`).join('')}</div>
      <div class="tiny dim" style="margin-top:10px">${C.esc(art.caveat)}</div></div>`;
  }

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

      ${articleCard(m)}

      ${C.matchReportCards(m)}

      ${m.fixtureId ? `<div><a href="${C.link('analysis', { id: m.fixtureId })}">看這場的賽前完整分析 →</a></div>` : ''}`);
  }

  renderPage();

  // 即時模式(npm run live:watch)會在記憶體裡更新 data/live.json,這裡定期取回並重畫;
  // 就算完全沒有即時資料源,也要定期重畫,比賽才會自己從「倒數」變成「進行中」。
  const POLL_MS = 20000, REDRAW_MS = 30000;
  let lastStamp = live.fetchedAt ?? null;
  setInterval(async () => {
    try {
      const res = await fetch(`data/live.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const fresh = await res.json();
      const stamp = fresh.fetchedAt ?? null;
      if (stamp !== lastStamp || fresh.available !== live.available) {
        lastStamp = stamp;
        live = fresh;
        renderPage();
      }
    } catch { /* 靜態站沒有即時端點時會失敗,忽略即可 */ }
  }, POLL_MS);
  setInterval(renderPage, REDRAW_MS);

} catch (err) { C.fail(err); }
