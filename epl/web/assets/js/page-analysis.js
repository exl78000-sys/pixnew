import * as C from './core.js?v=dfd16172';

const app = document.getElementById('app');

try {
  // prob-history 的鍵帶連字號,解構拿不到,所以先收整包再取
  const data = await C.load('meta', 'clubs', 'teams', 'fixtures', 'h2h', 'players', 'tactics', 'analysis', 'reports', 'experts', 'lineups', 'live', 'shapes', 'official', 'form', 'prob-history', 'news');
  const { meta, clubs, teams, fixtures, h2h, players, tactics, analysis, reports, experts, lineups, live, shapes, official, form } = data;
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();
  const basic = meta.edition === 'basic';

  const teamBy = new Map(teams.map(t => [t.code, t]));
  const tacBy = new Map(tactics.map(t => [t.code, t]));
  const preArticleFor = f => analysis.pre[`${f.home}|${f.away}`] ?? null;
  const reportKey = f => `${f.season}|${f.home}|${f.away}`;
  const postArticleFor = f => analysis.post[reportKey(f)] ?? null;
  const reportFor = f => reports.reports[reportKey(f)] ?? null;
  const expertsFor = f => experts.matches[reportKey(f)] ?? [];
  // 這幾個會在 renderMatch 裡用到,必須在呼叫點之前就初始化好 —— 放在下面的
  // 函式區只會撞上 TDZ(函式宣告會提升,const 不會)
  // 西甲賽後報告使用 SportMonks providerId；英超與球員頁使用網站 code。
  // 同一份索引收兩個鍵，避免賽後球員頭貼／詳情因來源 ID 不同而斷線。
  const playerEntries = players.flatMap(x => [
    ...(x.code != null ? [[String(x.code), x]] : []),
    ...(x.sportmonksId != null ? [[String(x.sportmonksId), x]] : []),
  ]);
  const photoByCode = new Map(playerEntries.map(([code, x]) => [code, x.photo ?? null]));
  const playerByCode = new Map(playerEntries);
  const photoOf = code => photoByCode.get(code) ?? null;

  // 網址可以用 ?id=(跟賽程頁一致)或 ?home=&away=(人看得懂,可以直接手打)
  const id = C.qs('id');
  const hq = C.qs('home'), aq = C.qs('away');
  const target = id ? fixtures.find(f => f.id === id)
    : hq && aq ? fixtures.find(f => f.home === hq && f.away === aq) : null;

  /* 這一頁只處理「一場比賽」。沒指定是哪一場就導回賽程表 ——
     以前這裡有自己的列表,但它是賽程表的子集(只有未開賽且有文章的場次,
     還沒有篩選),兩個入口只會讓人猶豫該點哪一個。 */
  if (target) renderMatch(target);
  else location.replace(C.link('index'));

  /* ── 單場分析 ────────────────────────────── */
  function renderMatch(f) {
    if (basic) { renderBasicMatch(f); return; }
    const p = f.prediction;
    const preArt = preArticleFor(f);
    const postArt = postArticleFor(f);
    const postReport = reportFor(f);
    const expertRows = expertsFor(f);
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
      <a class="small dim" href="${C.link('index')}">← 回積分與賽程</a>
      <h1 style="margin-top:6px">${C.teamLink(f.home)} <span class="dim">vs</span> ${C.teamLink(f.away)}</h1>
      <p>${f.season} 賽季第 ${f.round} 輪・${C.kickoffLocal(f.kickoff)}(${C.tzName()})</p>
      ${C.stampRow([
        C.stamp('勝率與預期進球', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算' }),
        C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '戰術指標與關鍵球員來自上季' }),
        preArt ? C.stamp('賽前本文', { iso: meta.builtAt, kind: 'daily', note: preArt.source === 'llm' ? 'AI 撰寫,數字經過驗證' : '由統計結果自動生成' }) : null,
        postArt ? C.stamp('賽後本文', { iso: meta.builtAt, kind: 'daily', note: postArt.source === 'llm' ? 'AI 撰寫,數字經過驗證' : '由統計結果自動生成' }) : null,
        expertRows.length ? C.stamp(`真人觀點 ${expertRows.length} 筆`, { iso: experts.updatedAt, kind: 'manual', note: '具名來源,人工核對後才發布' }) : null,
      ])}
    </div>

    ${/* 已完賽的場次也會走到這一頁(實時戰況頁的每張比賽卡都連過來)。
         那時候大字要放真的比分,不是賽前的預期進球 —— 而且「開賽後 90 小時」
         這種文字對一場三天前踢完的比賽毫無意義。 */ ''}
    <div class="card">
      <div class="scoreline" style="margin:4px 0 14px">
        <div class="side">${C.badge(f.home, 'big')}<b>${C.teamLink(f.home)}</b></div>
        <div class="sc" style="font-size:20px">${f.played
          ? `${f.fh} <span class="dim">:</span> ${f.fa}`
          : `${p.xgHome} <span class="dim">:</span> ${p.xgAway}`}</div>
        <div class="side away">${C.badge(f.away, 'big')}<b>${C.teamLink(f.away)}</b></div>
      </div>
      <div class="center small dim" style="margin-bottom:10px">${f.played
        ? `最終比分・賽前模型預期 ${p.xgHome} : ${p.xgAway}` : '模型預期進球'}</div>
      ${C.probBar(p)}
      <div class="row small dim" style="justify-content:space-between;margin-top:6px">
        <span>主勝 ${C.pct(p.home, 0)}</span><span>和局 ${C.pct(p.draw, 0)}</span><span>客勝 ${C.pct(p.away, 0)}</span></div>
      <div class="tiny dim center" style="margin-top:6px">${f.played ? '以上是賽前的機率,沒有事後修改' : ''}</div>
      <div class="spread" style="margin-top:14px">
        <span class="small">${f.played ? (() => {
          const ZH = { home: '主勝', draw: '和局', away: '客勝' };
          const real = f.fh > f.fa ? 'home' : f.fh === f.fa ? 'draw' : 'away';
          const pick = [['home', p.home], ['draw', p.draw], ['away', p.away]].sort((x, y) => y[1] - x[1])[0];
          return pick[0] === real
            ? `<span class="pill accent tiny">模型命中${ZH[real]} ${C.pct(p[real], 0)}</span>`
            : `<span class="pill tiny">模型失準・給${ZH[real]} ${C.pct(p[real], 0)}</span>`;
        })() : state.phase === 'upcoming'
          ? `開賽倒數 ${C.countdown(f.kickoff)}`
          : `<span class="pill warn tiny">${C.elapsedText(state.elapsed)}</span>`}</span>
        ${/* 實時戰況這一頁不是每個聯賽都有(英冠沒有接即時來源)。
              沒有的聯賽照樣給連結的話,讀者點過去只會撞上缺口頁 ——
              那不是誠實,那是把人送去死路。用 C.closedPage 判斷,不寫死聯賽代碼。 */''}
        ${f.played
          ? `<a class="pill info tiny" href="#panel-post" data-view="post">看賽後分析 ↓</a>`
          : C.closedPage(C.league(), 'live')
            ? ''
            : `<a class="pill info tiny" href="${C.link('live')}">看實時戰況 →</a>`}
      </div>
    </div>

    ${/* **比賽進行中也要看得到事件。** 時間軸原本只畫在 f.played 的賽後分頁裡,
          而 fixtures.json 的 played 要等 openfootball 更新(它比官方慢好幾個小時) ——
          結果是:官方那邊早就有進球、牌與換人了,畫面上一片空白。
          所以 played 還是 false、但官方已經有事件時,把時間軸提到分頁之前直接顯示。 */''}
    ${!f.played ? `<div id="livePanel"></div>` + goalsCard(f, { live: true }) + probCurveCard(f) : ''}

    <div class="analysis-switch" id="analysis-views" role="tablist" aria-label="分析階段">
      ${f.played ? '<button class="btn analysis-tab" type="button" role="tab" data-view="compare" aria-controls="panel-compare">綜合對比</button>' : ''}
      <button class="btn analysis-tab" type="button" role="tab" data-view="pre" aria-controls="panel-pre">賽前分析</button>
      ${f.played ? '<button class="btn analysis-tab" type="button" role="tab" data-view="post" aria-controls="panel-post">賽後分析</button>' : ''}
    </div>

    ${f.played ? `<section class="analysis-panel" id="panel-compare" role="tabpanel">
      ${phaseComparison(f, postReport)}
    </section>` : ''}

    <section class="analysis-panel" id="panel-pre" role="tabpanel">
    ${articleCard(preArt, '賽前觀察', 'pre')}

    <div class="section"><h2>模型預測</h2>
      <span class="hint">兩套方法交叉驗證</span></div>
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

    <div class="section"><h2>專業市場機率</h2>
      <span class="hint">去除莊家水錢後的三向市場共識</span></div>
    ${professionalMarketCard(f, p)}
    ${f.market ? marketNote(f, p) : ''}

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
        ${C.versus([
          { label: 'Elo 實力評分', h: H.elo, a: A.elo, digits: 0 },
          { label: '上季聯賽名次', h: H.lastSeason?.pos ?? null, a: A.lastSeason?.pos ?? null, digits: 0, better: 'low' },
          { label: '上季場均勝點', h: H.lastSeason?.ppg ?? null, a: A.lastSeason?.ppg ?? null },
          { label: '每場期望進球', h: th?.attack.xG90 ?? null, a: ta?.attack.xG90 ?? null, hint: 'xG' },
          { label: '每場期望失球', h: th?.defence.xGA90 ?? null, a: ta?.defence.xGA90 ?? null, hint: 'xGA', better: 'low' },
          { label: '領先守成率', h: th?.resilience.leadHoldPct ?? null, a: ta?.resilience.leadHoldPct ?? null, digits: 1, unit: '%' },
          { label: '落後翻盤率', h: th?.resilience.trailRescuePct ?? null, a: ta?.resilience.trailRescuePct ?? null, digits: 1, unit: '%' },
        ], {
          home: f.home, away: f.away, colors: f.colors,
          note: `<b>條長代表「這一列誰比較好」,不是數值大小</b> ——
            標了 <span class="vs-dir">↓</span> 的項目(名次、失球)越低越好,條長會取倒數,
            否則第 16 名的條會比第 5 名長,圖形反而跟 ▲ 打架。實際數值就在條的外側。
            每一列各自比較,不共用同一條軸(單位本來就不同)。
            ${sameHue(f) ? '' : `<br><b>${C.name(f.away)}這一邊沒有用它的主色</b> ——
              兩隊主色太接近(英超九隊是紅的、六隊是深藍的),同色系會讓圖表等於沒有顏色,
              所以自動換成可分辨的替代色。隊名、色塊與左右位置才是識別依據。`}
            ${promoted(f).length ? `<br>${promoted(f).join('、')} 是升班馬,沒有上季英超資料,所以那幾列是空的 ——
              模型改用「聯盟後段先驗」估計其實力,不確定性比其他球隊大。` : ''}`,
        })}
      </div>
    </div>

    ${lineupSection(f)}

    ${p.grid ? `<div class="section"><h2>比分機率分佈</h2><span class="hint">顏色越亮代表越可能</span></div>
      <div class="card">${C.scoreHeat(p.grid, f.home, f.away)}</div>` : ''}

    ${!(th && ta) ? `<div class="note" style="margin-top:16px">
      ${promoted(f).join('、')} 沒有上季英超的全季統計,因此無法做戰術風格對比。
      等本季累積足夠場次後,這一段會自動出現。</div>` : ''}
    ${th && ta ? `<div class="section"><h2>戰術風格對比</h2><span class="hint">上季全季統計的百分位</span></div>
      <div class="card">
        ${/* 雷達圖跟上面的對照條用同一組隊色,兩張圖才對得起來 */ ''}
        ${C.radar([
          { name: C.name(f.home), color: f.colors?.home ?? '#00ff85', values: th.radar },
          { name: C.name(f.away), color: f.colors?.away ?? '#04f5ff', values: ta.radar },
        ], { size: 340 })}
        <div class="stat-line" style="margin-top:10px"><span class="small">${C.teamCell(f.home, { link: false })}</span>
          <span class="row tiny" style="gap:5px">${th.tags.slice(0, 3).map(t => `<span class="pill accent">${C.esc(t)}</span>`).join('')}
            <span class="mono dim">${th.formation.label}</span></span></div>
        <div class="stat-line"><span class="small">${C.teamCell(f.away, { link: false })}</span>
          <span class="row tiny" style="gap:5px">${ta.tags.slice(0, 3).map(t => `<span class="pill info">${C.esc(t)}</span>`).join('')}
            <span class="mono dim">${ta.formation.label}</span></span></div>
        <div class="tiny dim" style="margin-top:6px">標籤是上季全季統計歸納出的風格,右側為平均站位。</div>
      </div>` : ''}

    ${formSection(f)}

    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3>歷來交手</h3><div class="tiny dim" style="margin:-4px 0 8px">涵蓋 ${meta.h2hSeasons?.length ?? 0} 個賽季(${C.esc(meta.h2hSeasons?.[0] ?? "?")} 起)</div>${h2hHtml(f, rec)}</div>
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
    </section>

    ${f.played ? `<section class="analysis-panel post-report-grid" id="panel-post" role="tabpanel">
      ${goalsCard(f)}
      ${probCurveCard(f)}
      ${expertOpinionSection(f, expertRows)}
      ${relatedNewsSection(f)}
      ${articleCard(postArt, '賽後結論', 'post')}
      ${postReport ? C.matchReportCards(C.reportWithPlayerPhotos(postReport, playerByCode))
        : '<div class="note">這場尚未取得逐球員與實際 xG 資料，因此目前只能對照最終比分與賽前機率。</div>'}
    </section>` : ''}
    ${C.foot(meta)}`;

    setupAnalysisTabs(f.played ? 'compare' : 'pre');

    mountLivePanel(f);

    setupExpertPagers();
    C.bindPlayerLinks(document, code => playerByCode.get(code), { meta, mode: 'current' });
    C.startCountdowns();
  }

  function renderBasicMatch(f) {
    const report = reportFor(f);
    const expertRows = expertsFor(f);
    const lineup = official?.matches?.[`${f.home}|${f.away}`] ?? null;
    const H = teamBy.get(f.home), A = teamBy.get(f.away);
    const ht = H?.tactics, at = A?.tactics;
    const p = f.prediction;
    const rec = h2h[[f.home, f.away].sort().join('|')] ?? null;
    const val = (obj, path) => path.reduce((v, key) => v?.[key], obj) ?? null;
    const comparison = C.versus([
      { label: 'Elo', h: H?.elo ?? null, a: A?.elo ?? null, digits: 0 },
      { label: '上季名次', h: H?.lastSeason?.pos ?? null, a: A?.lastSeason?.pos ?? null, digits: 0, better: 'low' },
      { label: '場均勝點', h: H?.lastSeason?.ppg ?? null, a: A?.lastSeason?.ppg ?? null },
      { label: 'xG / 場', h: val(ht, ['attack', 'xG90']), a: val(at, ['attack', 'xG90']) },
      { label: 'xGA / 場', h: val(ht, ['defence', 'xGA90']), a: val(at, ['defence', 'xGA90']), better: 'low' },
      { label: '定位球 xG / 場', h: val(ht, ['setPieces', 'xG90']), a: val(at, ['setPieces', 'xG90']), digits: 3 },
    ], {
      home: f.home, away: f.away, colors: f.colors,
      note: `${meta.lastSeason} 球隊層級資料只供背景對比；下方賽後數字才是這一場的真實資料。`,
    });

    // 西甲初版沒有英超那種傷停／預估先發資料，但已經有模型、盤口、近況、
    // 交手、上季戰術與本季球員彙總。賽前頁把這些已核對欄位集中呈現，缺少的
    // 快照仍明確標示，不用賽後結果倒推。
    const recentCard = code => {
      const t = form?.teams?.[code];
      if (!t) return `<div class="card"><h3>${C.esc(C.name(code))} 近況</h3><div class="dim small">尚無近期資料</div></div>`;
      const runs = (t.recent ?? []).map(r => `<i class="frm ${r.res}" title="${C.esc(`${r.date}・${r.venue === 'H' ? '主' : '客'}場對 ${C.name(r.opp)}・${r.gf}-${r.ga}`)}">${r.res}</i>`).join('');
      return `<div class="card">
        <h3>${C.teamCell(code, { link: false })} 近況</h3>
        <div class="row" style="gap:8px;align-items:center;margin-bottom:8px">
          <span class="form-run">${runs || '<span class="dim small">—</span>'}</span>
          <span class="small dim">${t.summary?.w ?? 0}勝 ${t.summary?.d ?? 0}和 ${t.summary?.l ?? 0}負・進 ${t.summary?.gf ?? 0} 失 ${t.summary?.ga ?? 0}</span>
        </div>
        ${(t.recent ?? []).map(r => `<div class="stat-line">
          <span class="small dim mono">${C.dateFull(r.date)}</span>
          <span class="small">${r.venue === 'H' ? '主' : '客'} vs ${C.teamLink(r.opp)} <b class="mono">${r.gf}-${r.ga}</b></span></div>`).join('')}
        <div class="tiny dim" style="margin-top:8px">近五場資料只供賽前參照，不併入本站模型機率。</div>
      </div>`;
    };
    const recent = form?.teams?.[f.home] && form?.teams?.[f.away] ? `
      <div class="section" style="margin-top:18px"><h2>近期狀態</h2><span class="hint">近五場・不調整模型</span></div>
      <div class="card">${C.versus([
        { label: '近五戰場均勝點', h: form.teams[f.home].summary?.ppg, a: form.teams[f.away].summary?.ppg },
        { label: '近五戰進球', h: form.teams[f.home].summary?.gf, a: form.teams[f.away].summary?.gf, digits: 0 },
        { label: '近五戰失球', h: form.teams[f.home].summary?.ga, a: form.teams[f.away].summary?.ga, digits: 0, better: 'low' },
      ], { home: f.home, away: f.away, colors: f.colors, note: '近況是獨立參考欄位，沒有偷偷加權到上方機率。' })}</div>
      <div class="grid g2">${recentCard(f.home)}${recentCard(f.away)}</div>` : '';
    const squadCard = code => {
      const rows = players.filter(x => x.team === code && x.season === f.season && (x.minutes ?? 0) >= 90)
        .sort((a, b) => (b.goals ?? 0) - (a.goals ?? 0) || (b.xGI ?? 0) - (a.xGI ?? 0)).slice(0, 5);
      return `<div class="card"><h3>${C.teamCell(code, { link: false })} 關鍵球員</h3>
        ${rows.length ? rows.map(x => `<div class="stat-line clickable" data-player-code="${C.esc(x.code ?? x.id)}" tabindex="0" role="button">
          <span class="row small" style="gap:7px">${C.playerPhoto({ ...x, team: code }, 28)}<span>${C.esc(x.name)} <span class="dim tiny">${C.esc(x.posZh ?? '')}</span></span></span>
          <span class="mono small">${x.goals ?? 0} 球・${x.assists ?? 0} 助・xGI ${C.fx(x.xGI, 2)}</span></div>`).join('')
          : '<div class="dim small">本季尚無足夠出場資料</div>'}
        <div class="tiny dim" style="margin-top:8px">點擊球員可開啟完整資料；排序以本季進球，再以 xGI 輔助。</div>
      </div>`;
    };
    const tacticsBlock = ht?.radar && at?.radar ? `
      <div class="section" style="margin-top:18px"><h2>戰術風格背景</h2><span class="hint">${meta.lastSeason} 整季資料</span></div>
      <div class="card">${C.radar([
        { name: C.name(f.home), color: f.colors?.home ?? '#00ff85', values: ht.radar },
        { name: C.name(f.away), color: f.colors?.away ?? '#04f5ff', values: at.radar },
      ], { size: 320 })}
        <div class="stat-line"><span>${C.teamCell(f.home, { link: false })}</span><span class="tiny">${(ht.tags ?? []).slice(0, 3).map(t => `<span class="pill accent">${C.esc(t)}</span>`).join(' ')} <span class="mono dim">${C.esc(ht.formation?.label ?? '—')}</span></span></div>
        <div class="stat-line"><span>${C.teamCell(f.away, { link: false })}</span><span class="tiny">${(at.tags ?? []).slice(0, 3).map(t => `<span class="pill info">${C.esc(t)}</span>`).join(' ')} <span class="mono dim">${C.esc(at.formation?.label ?? '—')}</span></span></div>
        <div class="tiny dim" style="margin-top:8px">雷達與定位球指標來自上季整季統計，作為賽前背景，不代表本場實際表現。</div>
      </div>` : '';
    const preForecast = p ? `
      <div class="section"><h2>模型預測</h2><span class="hint">Dixon-Coles Poisson + Elo 平均</span></div>
      <div class="card">
        ${C.probBar(p)}
        <div class="row small dim" style="justify-content:space-between;margin-top:6px"><span>主勝 ${C.pct(p.home, 0)}</span><span>和局 ${C.pct(p.draw, 0)}</span><span>客勝 ${C.pct(p.away, 0)}</span></div>
        <div class="grid g2" style="margin-top:12px"><div class="stat-line"><span class="small">預期進球</span><b class="mono">${C.fx(p.xgHome, 2)} : ${C.fx(p.xgAway, 2)}</b></div><div class="stat-line"><span class="small">雙方進球</span><b class="mono">${C.pct(p.btts, 0)}</b></div><div class="stat-line"><span class="small">大於 2.5 球</span><b class="mono">${C.pct(p.over25, 0)}</b></div><div class="stat-line"><span class="small">零封</span><b class="mono">${C.pct(p.csHome, 0)} / ${C.pct(p.csAway, 0)}</b></div></div>
        <div class="small dim" style="margin-top:10px">最可能比分：${(p.topScores ?? []).slice(0, 4).map(s => `<span class="pill">${C.esc(s.s)}・${C.pct(s.p, 0)}</span>`).join(' ')}</div>
        ${p.grid ? `<div style="margin-top:14px">${C.scoreHeat(p.grid, f.home, f.away)}</div>` : ''}
        <div class="tiny dim" style="margin-top:8px">預測在開賽前生成；完賽後不重新收斂成 100% 或回填結果。</div>
      </div>
      <div class="section"><h2>專業市場機率</h2><span class="hint">有盤口才顯示，未把市場當資金流向</span></div>
      ${professionalMarketCard(f, p)}${f.market ? marketNote(f, p) : ''}`
      : `<div class="note info"><b>本場沒有保存可驗證的賽前機率快照。</b>已完賽場次只保留正式比分；不使用賽後重建數字冒充當時的預測。</div>`;

    app.innerHTML = `
    <div class="page-head">
      <a class="small dim" href="${C.link('index')}">← 回積分與賽程</a>
      <h1 style="margin-top:6px">${C.teamLink(f.home)} <span class="dim">vs</span> ${C.teamLink(f.away)}</h1>
      <p>西甲 ${f.season}・第 ${f.round} 輪・${f.kickoff ? C.kickoffLocal(f.kickoff) : C.dateFull(f.date)}</p>
      ${C.stampRow([
        C.stamp('正式比分', { iso: meta.builtAt, kind: 'daily' }),
        report ? C.stamp('完整賽後資料', { iso: report.advanced?.fetchedAt, kind: 'season', note: '完賽後抓取一次並永久快取' }) : null,
      ])}
    </div>
    <div class="card">
      <div class="scoreline" style="margin:4px 0 10px">
        <div class="side">${C.badge(f.home, 'big')}<b>${C.teamLink(f.home)}</b></div>
        <div class="sc" style="font-size:22px">${f.played ? `${f.fh} <span class="dim">:</span> ${f.fa}`
          : f.provisional ? `${f.provisional.fh} <span class="dim">:</span> ${f.provisional.fa}` : '未開賽'}</div>
        <div class="side away">${C.badge(f.away, 'big')}<b>${C.teamLink(f.away)}</b></div>
      </div>
      ${!f.played && f.provisional ? `<div class="center" style="margin-bottom:6px"><span class="pill warn tiny">終場・暫定</span></div>` : ''}
      <div class="center tiny dim">${f.played
        ? '這場沒有保存可驗證的賽前機率快照，因此不拿賽後重建機率冒充賽前預測。'
        : f.provisional
          ? `暫定比分來自 ${C.esc(f.provisional.source)}(本站直播時顯示的同一來源);獨立賽果(openfootball/football-data)核對通過後才會進積分榜、模型與完整賽後資料。`
          : '賽前機率請回賽程頁查看。'}</div>
    </div>
    ${!f.played ? `<div id="livePanel"></div>` : ''}

    ${f.played ? `<div class="analysis-switch" id="analysis-views" role="tablist" aria-label="分析階段">
      <button class="btn analysis-tab" type="button" role="tab" data-view="compare" aria-controls="panel-compare">綜合對比</button>
      <button class="btn analysis-tab" type="button" role="tab" data-view="pre" aria-controls="panel-pre">賽前分析</button>
      <button class="btn analysis-tab" type="button" role="tab" data-view="post" aria-controls="panel-post">賽後分析</button>
    </div>` : ''}

    ${f.played ? `<section class="analysis-panel" id="panel-compare" role="tabpanel">
      <div class="section"><h2>綜合對比</h2><span class="hint">賽前背景與實際比分</span></div>
      <div class="card">${comparison}</div>
      <div class="note" style="margin-top:12px">這裡把賽前可用的球隊背景與最終比分放在同一頁；西甲目前沒有保存可驗證的賽前機率快照，不以賽後資料回填預測。</div>
    </section>` : ''}

    <section class="analysis-panel" id="panel-pre" role="tabpanel">
      <div class="section"><h2>賽前分析</h2><span class="hint">${meta.lastSeason} 球隊背景・不調整賽後結論</span></div>
      ${preForecast}
      <div class="card">${comparison}</div>
      ${recent}
      ${tacticsBlock}
      <div class="section" style="margin-top:18px"><h2>歷來交手</h2><span class="hint">${meta.h2hSeasons?.[0] ?? ''} 起的可核對紀錄</span></div>
      <div class="card">${h2hHtml(f, rec)}</div>
      <div class="section" style="margin-top:18px"><h2>賽前關鍵球員</h2><span class="hint">本季已取得的整季彙總</span></div>
      <div class="grid g2">${squadCard(f.home)}${squadCard(f.away)}</div>
    </section>

    <section class="analysis-panel" id="panel-post" role="tabpanel">
      <div class="section"><h2>完整賽後分析</h2><span class="hint">球隊統計、正式陣容、事件與球員評分</span></div>
      ${lineupCard(lineup, f, report)}
      ${report ? C.matchReportCards(C.reportWithPlayerPhotos(report, playerByCode)) : missingReportCard()}
      ${expertOpinionSection(f, expertRows)}
      ${relatedNewsSection(f)}
    </section>
    ${C.foot(meta)}`;
    C.bindPlayerLinks(document, code => playerByCode.get(code), { meta, mode: 'current' });
    setupAnalysisTabs(f.played ? 'compare' : 'pre');
    setupExpertPagers();
    mountLivePanel(f);
  }

  function lineupCard(match, f, report = null) {
    if (!match?.home?.xi?.length || !match?.away?.xi?.length) return '';
    const sourceName = source => source === 'laliga.com' ? '西甲官方 LaLiga.com' : 'FotMob / enetpulse';
    const sourceHint = source => source === 'laliga.com'
      ? '官方公布的先發、替補、陣型與頭像；本站未補入第三方評分'
      : '官方先發、陣型、站位與完賽評分';
    // 正式先發的站位與下方賽後報告是不同資料集；把已核對的射手結果
    // 只讀地投影到這張戰術圖，避免下方有 ⚽、上方先發圖卻沒有的矛盾。
    const keyOf = name => String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const scorerMap = code => {
      const exact = new Map(), surname = new Map();
      for (const player of [...(report?.sides?.[code]?.xi ?? []), ...(report?.sides?.[code]?.bench ?? [])]) {
        if (!player.goals) continue;
        const full = keyOf(player.name), last = full.split(' ').at(-1);
        if (full) exact.set(full, (exact.get(full) ?? 0) + player.goals);
        if (last) {
          const hit = surname.get(last) ?? { goals: 0, names: new Set() };
          hit.goals += player.goals;
          hit.names.add(full);
          surname.set(last, hit);
        }
      }
      return player => {
        const full = keyOf(player.name);
        const short = surname.get(full.split(' ').at(-1));
        return exact.get(full) ?? (short?.names.size === 1 ? short.goals : 0);
      };
    };
    const board = (sourceSide, code, reverseRows = false) => {
      const scoreOf = scorerMap(code);
      const withGoals = player => ({ ...player, goals: scoreOf(player) });
      const side = {
        ...sourceSide,
        xi: sourceSide.xi.map(withGoals),
        rows: sourceSide.rows?.map(row => row.map(withGoals)) ?? null,
      };
      const top = [...side.xi].filter(p => p.rating !== null && p.rating !== undefined)
        .sort((a, b) => b.rating - a.rating).slice(0, 3);
      return `<div class="card">
        <div class="spread" style="margin-bottom:4px">
          <span class="row" style="gap:8px">${C.badge(code)}<b>${C.name(code)}</b></span>
          <span class="pill accent tiny">${C.esc(side.formation)}</span>
        </div>
        ${C.pitch(side.xi, { photos: true, officialRows: side.rows, reverseRows,
          color: C.team(code).colors?.[0] ?? '#00ff85', label: `${C.name(code)} ${side.formation}` })}
        <div class="tiny dim" style="margin-top:6px">先發評分：${top.length
          ? top.map(p => `${C.esc(p.name)} ${C.fx(p.rating, 1)}`).join('・') : '此來源沒有評分'}</div>
      </div>`;
    };
    const sources = [match, match.home, match.away].map(x => x?.source).filter(Boolean);
    const source = sources.includes('laliga.com') ? 'laliga.com' : 'fotmob/enetpulse';
    const coverage = match.coverage ?? {};
    const boundary = source === 'laliga.com'
      ? '西甲官網未提供第三方球員評分與座標；球場分行依官網陣型及先發順序呈現，不把推估評分或站位寫入資料。'
      : '本卡是已核對的完賽正式先發、陣型、位置與評分；目前來源沒有球員頭貼，完整球隊統計、事件與替補細節由下方 SportMonks 賽後報告卡提供，不用估算值補上。';
    return `<div class="section"><h2>本場正式先發</h2>
      <span class="hint">${sourceName(source)}・${C.dateFull(match.date)}・${sourceHint(source)}</span></div>
      <div class="grid g2">${board(match.home, f.home)}${board(match.away, f.away, true)}</div>
      <div class="note" style="margin-top:10px"><b>資料界線：</b>${boundary}
        ${coverage.photos ? '本場頭像直接使用官方圖片網址。' : ''}</div>`;
  }

  /* 沒有賽後資料時,要分清楚是「還沒抓到」還是「這個方案根本拿不到」。
     這兩句話對讀者的意義完全相反,所以這裡有三種狀態,不是兩種:

     1. blocked —— 主要來源一場都發不出來。這一季真的拿不到。
     2. backupBlocked —— 主要來源拿得到(已發布 count 場),備援補不了缺口。
        這一場是「還沒抓到」。
     3. 都沒有 —— 單純還沒輪到這一場。

     2 原本被歸進 1:只要還有場次沒發布就把備援的方案限制當成整季結論,
     於是 16/20 的狀態下,剛完賽那幾場的頁面寫著「換方案之前都不會出現」,
     而隔壁 16 場的球隊統計、正式陣容、事件與評分全都在。 */
  function missingReportCard() {
    const b = reports?.blocked;
    if (b) {
      return `<div class="card"><div class="note warn"><b>這一季的完整賽後資料目前拿不到。</b>
          本站使用的資料源方案不含本賽季,所以這不是「還沒抓到」——
          在換成涵蓋本賽季的方案之前,球隊統計、正式陣容、事件與球員評分都不會出現。</div>
        <div class="tiny dim" style="margin-top:10px">上方的比分、預測與兩隊風格對比不受影響,那些不靠這個資料源。</div></div>`;
    }
    /* 主要來源已經發布過場次,只是這一場還沒快取到 —— 這是「還沒抓到」。
       備援(API-Football)方案不含本賽季、補不了缺口這件事仍要講,
       但它不能升格成「整季拿不到」:那句話會蓋掉隔壁十幾場已經發布的完整賽後資料。 */
    const backup = reports?.backupBlocked;
    return `<div class="card"><div class="note info"><b>這場尚待永久快取。</b>
        必須同時取得球隊統計、兩隊正式陣容、事件、球員數據與至少一筆評分,且比分核對一致才會發布。缺任何一項都不會用估算值補上。${
          reports?.count ? `本季已有 ${reports.count} 場發布完整賽後資料,所以這是「還沒抓到」,不是拿不到。` : ''}</div>
      ${backup ? `<div class="tiny dim" style="margin-top:10px">備援來源的方案不含本賽季,補不了這個缺口;缺的場次等主要來源的下一次快取。</div>` : ''}
      <div class="tiny dim" style="margin-top:10px">開頁不會呼叫 API；資料由本機同步或手動流程在完賽後抓取一次並永久保存。</div></div>`;
  }

  /* 官方進球事件。有名單就一定有這批事件 —— 兩者來自同一個請求,
     所以這一段不需要任何額外抓取。沒有就不畫,不留空卡片。 */
  /* 勝率曲線。資料是比賽日的迴圈每 2 分鐘累積的 in-play 機率 ——
     沒有累積到的場次(累積器上線前踢的、或迴圈沒開)就沒有,不補造。 */
  /* 即時面板(2026-08-29,使用者要求:每場自己一頁,實時頁多場並列會亂)。
     比賽進行中,這一頁就是單場即時頁:比分、即時勝率、下一球、講評,
     跟實時頁同一個 feed(比賽日迴圈每 2 分鐘推)、每 20 秒輪詢;
     完場自動消失,由賽後分析接手 —— 單場的家始終只有這一頁。
     事件時間軸(進球/牌/換人)吃的是 official.json,重新整理才會更新;
     面板上的比分與機率不用重新整理。 */
  /* 即時面板輪詢(英超與西甲兩條版面**共用這一支** —— 各寫一份的話修了一邊
     另一邊悄悄過期,es1 版面第一版就是這樣整個漏掉面板的)。
     feed 與實時頁同一套:raw 分支檔比 Pages 新(比賽日迴圈高頻推),
     失敗退回本站檔 —— 退路要退到**自己聯賽**的 live.json,不寫死路徑。 */
  function mountLivePanel(f) {
    if (f.played) return;
    const findIn = l => (l?.matches ?? []).find(x => x.home === f.home && x.away === f.away);
    const lgPath = C.league() === 'pl' ? 'data/live.json' : `data/leagues/${C.league()}/live.json`;
    const feeds = [meta.liveFeed, lgPath].filter(Boolean);
    let cur = null;   // 最新一份 {m, fetchedAt},給走鐘用
    const renderLive = (m, fetchedAt) => {
      /* feed 只進不退:raw CDN 會新舊副本交替回應,拿到較舊的那份時
         比分、場上數據、分鐘全部會倒退(實測「分鐘倒數」就是這條)。
         舊的一律不採用 —— 走鐘照舊從上一份的錨往前推,等下一份新的。 */
      if (cur && m && fetchedAt && cur.fetchedAt
        && Date.parse(fetchedAt) < Date.parse(cur.fetchedAt)) return;
      const el = document.getElementById('livePanel');
      cur = (m && m.started && !m.finished) ? { m, fetchedAt } : null;
      if (el) el.innerHTML = cur ? livePanelHtml(m, f.colors, fetchedAt) : '';
    };
    renderLive(findIn(data.live), data.live?.fetchedAt);
    C.pageInterval(async () => {
      for (const url of feeds) {
        try {
          const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
          if (res.ok) { const j = await res.json(); renderLive(findIn(j), j.fetchedAt); return; }
        } catch { /* 換下一個來源 */ }
      }
    }, 20000);
    /* 走鐘:面板 20 秒才重畫一次,分鐘顯示在兩次之間自己往前走 ——
       「一直停在 75 分」就是這條鏈(FPL 分鐘塊狀跳 + 迴圈高頻 + CDN)疊出來的。
       只改字,不重畫面板。 */
    C.pageInterval(() => {
      if (!cur) return;
      const t = `第 ${C.liveMinute(cur.m, cur.fetchedAt).disp} 分鐘`;
      document.querySelectorAll('[data-liveclock]').forEach(n => { n.textContent = t; });
    }, 1000);
  }

  /* 顯示用分鐘走 C.liveMinute(跟實時頁共用 —— 各寫一份的話修了這頁那頁照舊凍住) */
  function livePanelHtml(m, colors, fetchedAt) {
    const H = m.sides?.[m.home], A = m.sides?.[m.away];
    const ip = m.inplay;
    const mn = C.liveMinute(m, fetchedAt);
    /* 場上數據表:FPL 即時逐人欄位的全隊加總。開關看「有沒有任何一項動起來」——
       實測中場時 FPL 的三個指數還是 0、防守計數已有值,只看指數會把真資料藏掉。
       全零(剛開賽)整卡不出,零和的列(兩邊都還是 0)個別藏。 */
    const sh = H?.stats, sa = A?.stats;
    const act = s => s.threat + s.creativity + s.influence + s.tackles + s.recoveries + s.cbi;
    const statRows = sh && sa && (act(sh) + act(sa) > 0) ? [
      { label: '場上 xG', h: H.xG, a: A.xG, digits: 2, hint: '期望進球(FPL 即時)' },
      { label: '威脅值', h: sh.threat, a: sa.threat, digits: 0, hint: 'FPL 官方進攻威脅指數' },
      { label: '創造力', h: sh.creativity, a: sa.creativity, digits: 0, hint: 'FPL 官方創造機會指數' },
      { label: '影響力', h: sh.influence, a: sa.influence, digits: 0, hint: 'FPL 官方比賽影響指數' },
      { label: '搶斷', h: sh.tackles, a: sa.tackles, digits: 0 },
      { label: '回收球權', h: sh.recoveries, a: sa.recoveries, digits: 0 },
      { label: '解圍+攔截+封堵', h: sh.cbi, a: sa.cbi, digits: 0 },
      { label: '門將撲救', h: H.keeper?.saves ?? 0, a: A.keeper?.saves ?? 0, digits: 0 },
      { label: '黃牌', h: H.yellow, a: A.yellow, digits: 0, better: 'low' },
    ].filter(r => r.label === '場上 xG' || r.better === 'low' || (r.h + r.a) > 0) : null;
    const bestLine = side => (side?.best ?? []).filter(b => b.bps > 0).slice(0, 3)
      .map(b => `${C.esc(b.name)} ${b.bps}`).join('、');
    return `<div class="section"><h2>即時戰況</h2>
        <span class="hint"><span class="livedot"></span> <span data-liveclock>第 ${mn.disp} 分鐘</span>・每 20 秒自動更新</span></div>
      <div class="card">
        <div class="spread"><span class="pill bad"><span class="livedot"></span><span data-liveclock>第 ${mn.disp} 分鐘</span></span>
          <span class="tiny dim">${C.kickoffLocal(m.kickoff)}</span></div>
        <div class="tiny dim" style="margin-top:4px">${mn.src}・分鐘由抓取後的實際時間推進(推算;中場與補時長度沒有資料,顯示停在 45+/90+)</div>
        <div class="scoreline" style="margin:14px 0">
          <div class="side">${C.badge(m.home)}<b>${C.name(m.home)}</b></div>
          <div class="sc">${m.hs ?? '-'} : ${m.as ?? '-'}</div>
          <div class="side away">${C.badge(m.away)}<b>${C.name(m.away)}</b></div>
        </div>
        ${(() => {
          /* 兩段各自守門:西甲的即時來源沒有陣容(label 是 —)也沒有場上 xG(null)——
             印出「— vs —・xG null:null」比不印糟 */
          const shapeOk = H?.shape?.label && A?.shape?.label && H.shape.label !== '—' && A.shape.label !== '—';
          const xgOk = H?.xG != null && A?.xG != null;
          const bits = [shapeOk ? `實際陣型 ${H.shape.label} vs ${A.shape.label}` : '',
            xgOk ? `場上 xG ${H.xG} : ${A.xG}` : ''].filter(Boolean);
          return bits.length ? `<div class="tiny dim center" style="margin-bottom:6px">${bits.join('・')}</div>` : '';
        })()}
        ${ip ? `${C.probBar(ip)}
          <div class="tiny dim center" style="margin-top:6px">剩餘時間期望進球 ${ip.xgRestHome} : ${ip.xgRestAway}
            ・下一球 ${C.name(m.home)} ${C.pct(ip.nextGoal.home, 0)} / ${C.name(m.away)} ${C.pct(ip.nextGoal.away, 0)}</div>` : ''}
        ${(H?.scorers?.length || A?.scorers?.length) ? `<div class="tiny" style="margin-top:8px">
          ⚽ ${[...(H?.scorers ?? []).map(x => `${C.esc(x.name)}${x.goals > 1 ? ' ×' + x.goals : ''}`),
               ...(A?.scorers ?? []).map(x => `${C.esc(x.name)}${x.goals > 1 ? ' ×' + x.goals : ''}`)].join('、')}</div>` : ''}
      </div>
      ${statRows ? `<div class="card" style="margin-top:10px"><h3>場上數據 <span class="pill tiny">每 20 秒更新</span></h3>
        ${C.versus(statRows, { home: m.home, away: m.away, colors,
          note: '全隊加總自 FPL 的即時逐球員數據。控球率、射門次數、傳球數與角球沒有免費的即時來源,所以不顯示 —— 缺的欄位不會用估計值補。' })}
        ${bestLine(H) || bestLine(A) ? `<div class="tiny dim" style="margin-top:8px">目前表現分(BPS)前三 ——
          ${C.name(m.home)}:${bestLine(H) || '—'}・${C.name(m.away)}:${bestLine(A) || '—'}</div>` : ''}
      </div>` : ''}
      ${m.liveSummary ? `<div class="card" style="margin-top:10px"><h3>${m.liveSummary.kind === 'ht' ? '中場講評' : `戰況講評 <span class="dim tiny">第 ${m.liveSummary.minute} 分鐘</span>`}
          <span class="pill tiny">自動生成</span></h3>
        <div style="display:grid;gap:8px;line-height:1.8">
          ${m.liveSummary.paragraphs.map(t => `<p class="small" style="margin:0">${C.esc(t)}</p>`).join('')}</div>
        <div class="tiny dim" style="margin-top:8px">每一句只引用模型與官方名單算出的數字;完場後由賽後分析接手。</div>
      </div>` : ''}`;
  }

  function probCurveCard(f) {
    const rec = data['prob-history']?.matches?.[`${f.home}|${f.away}`];
    if (!rec) return '';
    return `<div class="section"><h2>勝率變化</h2>
        <span class="hint">本站模型的即時機率・比賽中約每 2 分鐘一點</span></div>
      <div class="card">${C.probCurve(rec.pts, { home: f.home, away: f.away })}</div>`;
  }

  function goalsCard(f, { live = false } = {}) {
    const rec = official?.matches?.[`${f.home}|${f.away}`];
    const goals = rec?.goals ?? [];
    const timeline = rec?.timeline ?? null;
    const extras = (timeline?.cards?.length ?? 0) + (timeline?.subs?.length ?? 0);
    if (!goals.length && !extras) return '';
    /* 牌與換人跟進球是**同一個請求**帶回來的,以前整批丟掉了。
       標題跟著內容走:只有進球時不要說「完整事件」。 */
    return `<div class="section"><h2>${extras ? '比賽事件' : '進球時間軸'}</h2>
        <span class="hint">英超官方比賽事件${extras ? '・進球、牌、換人與半場' : ''}${
          live ? `・官方比賽鐘 ${C.esc(rec?.clock ?? '進行中')}` : ''}</span></div>
      <div class="card">${C.goalTimeline(goals, { home: f.home, away: f.away, timeline })}
        ${live ? `<div class="note" style="margin-top:10px">這一場的賽果還沒進本站的賽程資料
          (上游 openfootball 比官方慢),所以上面的分頁還停在賽前。
          事件本身是官方的,兩分鐘更新一次。</div>` : ''}</div>`;
  }

  function articleCard(art, fallbackTitle, phase = 'pre') {
    if (!art) return '';
    const llm = art.source === 'llm';
    const label = llm ? '本站 AI 分析' : '本站統計模板';
    return `<div class="section"><h2>${phase === 'post' ? '本站 AI／模型分析' : C.esc(art.title || fallbackTitle)}</h2>
      <span class="hint">${phase === 'post' ? '與真人專家觀點分開呈現' : (llm ? 'AI 撰寫,數字經過驗證' : '由統計結果自動生成')}</span></div>
      <div class="card article-card site-analysis-card">
        ${phase === 'post' ? `<div class="spread article-source-head"><h3>${C.esc(art.title || fallbackTitle)}</h3>
          <span class="pill ${llm ? 'info' : ''}">${label}・非真人觀點</span></div>` : ''}
        <div style="display:grid;gap:12px;line-height:1.85">
          ${(art.paragraphs ?? []).map(t => `<p style="margin:0">${C.esc(t)}</p>`).join('')}
        </div>
        ${art.caveat ? `<div class="note" style="margin-top:14px">${C.esc(art.caveat)}</div>` : ''}
        ${art.note ? `<div class="tiny dim" style="margin-top:8px">${C.esc(art.note)}</div>` : ''}
      </div>`;
  }

  /* 觀點區塊。原本有「新聞 / 名宿 / 專家」三顆分類鈕,但每場總共才約 3 筆 ——
     一顆鈕後面常常只有一筆,分類切換的成本比它省下的翻閱多。改成合成一串直接翻,
     順序是新聞 → 名宿 → 專家,所以打開就是新聞。分類本身沒有消失,
     它在每張卡右上角的標籤上 —— 那是標示,不是篩選器。 */
  /* 相關外電。**跟上面那一區分開** —— 那一區是人工核對過的具名專家觀點,
     它的價值就在嚴格;把機器比對出來的外電混進去會把那條線弄糊。

     這裡的每一則是**依球隊名比對**出來的,不保證在講這一場:轉會、傷停、
     教練里程碑的報導也會提到同樣的球隊。所以標題就寫「提到這兩隊的外電」,
     不寫「本場新聞」,並且只把「兩隊都提到 + 日期貼近開球」排前面 ——
     那是事實(兩隊都提到),不是推論(所以是本場報導)。 */
  function relatedNewsSection(f) {
    const all = Array.isArray(data.news) ? data.news : [];
    const teamsOf = n => (n.teams?.length ? n.teams : (n.team ? [n.team] : []));
    const ko = f.kickoff ? Date.parse(f.kickoff) : NaN;
    const near = n => {
      const d = Date.parse(`${n.date}T12:00:00Z`);
      return Number.isFinite(ko) && Number.isFinite(d) ? Math.abs(d - ko) <= 2 * 864e5 : false;
    };
    const rows = all
      .map(n => ({ n, t: teamsOf(n) }))
      .filter(x => x.t.includes(f.home) || x.t.includes(f.away))
      .map(x => ({ ...x, both: x.t.includes(f.home) && x.t.includes(f.away), close: near(x.n) }))
      .sort((a, b) => (b.both && b.close) - (a.both && a.close) || b.both - a.both
        || String(b.n.date).localeCompare(String(a.n.date)))
      .slice(0, 6);
    if (!rows.length) return '';
    const line = ({ n, both, close }) => {
      const url = C.safeUrl(n.link);
      const title = n.titleZh ?? n.title;
      return `<div class="stat-line" style="align-items:flex-start">
        <span class="small" style="flex:1">
          ${both && close ? '<span class="pill tiny warn">兩隊都提到</span> ' : ''}
          ${url ? `<a href="${C.esc(url)}" target="_blank" rel="noopener">${C.esc(title)}</a>` : C.esc(title)}
          ${n.titleZh ? '<span class="pill tiny">機器翻譯</span>' : ''}
          <span class="dim tiny">${C.esc(n.source ?? '本站整理')}・${C.esc(n.date ?? '')}</span>
        </span></div>`;
    };
    return `<div class="section" style="margin-top:20px"><h2>提到這兩隊的外電</h2>
        <span class="hint">依球隊名比對・不保證在講這一場</span></div>
      <div class="card">
        <div style="display:grid;gap:6px">${rows.map(line).join('')}</div>
        <div class="tiny dim" style="margin-top:10px">這些是<b>依球隊名自動比對</b>出來的外電 ——
          轉會、傷停、教練里程碑的報導也會提到同樣的球隊,所以<b>不保證是在講這一場</b>。
          標「兩隊都提到」的是兩隊名字都出現、而且日期在開球前後兩天內,最可能與本場有關。
          完整清單見<a href="${C.link('news')}">動態頁</a>(可依球隊篩選)。</div>
      </div>`;
  }

  function expertOpinionSection(f, rows) {
    const typeZh = {
      article: '文章', broadcast: '轉播', video: '影片', podcast: 'Podcast', 'press-conference': '記者會',
    };
    const categoryZh = { news: '新聞', legend: '名宿', expert: '專家' };
    const ORDER = { news: 0, legend: 1, expert: 2 };
    const list = [...rows].sort((a, b) => (ORDER[a.category] ?? 9) - (ORDER[b.category] ?? 9));
    const counts = ['news', 'legend', 'expert']
      .map(key => [categoryZh[key], list.filter(x => x.category === key).length])
      .filter(([, n]) => n > 0).map(([zh, n]) => `${zh} ${n}`).join('・');
    const cards = list.map((item, index) => `<article class="card expert-card" data-expert-card data-category="${C.esc(item.category)}" ${index ? 'hidden' : ''}>
      <div class="expert-head">
        <span class="expert-avatar" aria-hidden="true">${C.esc(item.expert.trim().slice(0, 1).toUpperCase())}</span>
        <div><h3>${C.esc(item.expert)}</h3><div class="small dim">${C.esc(item.role)}</div></div>
        <span class="pill expert-kind ${C.esc(item.category)} tiny">${categoryZh[item.category] ?? '觀點'}</span>
      </div>
      <p class="expert-summary">${C.esc(item.summary)}</p>
      ${item.topics?.length ? `<div class="tags">${item.topics.map(t => `<span class="pill tiny">${C.esc(t)}</span>`).join('')}</div>` : ''}
      ${item.evidence?.length ? `<div class="expert-evidence"><b>與本站數據對照</b>
        ${item.evidence.map(x => `<span>${C.esc(x)}</span>`).join('')}</div>` : ''}
      <div class="expert-source">
        <span><b>${C.esc(item.publisher)}</b>・${typeZh[item.sourceType] ?? C.esc(item.sourceType)}・${C.dateFull(item.publishedAt)}</span>
        <a href="${C.esc(item.url)}" target="_blank" rel="noopener noreferrer">查看原始來源 ↗</a>
      </div>
    </article>`).join('');

    return `<div class="section"><h2>新聞／名宿／專家觀點</h2>
      <span class="hint">${list.length ? `共 ${list.length} 則・${counts}・一則一則翻` : '需具名來源與原始連結'}</span></div>
      ${list.length ? `<div class="expert-shell" data-expert-pager>
        <div class="expert-viewport" aria-live="polite">${cards}</div>
        <div class="expert-pager-controls">
          <button class="btn" type="button" data-expert-prev aria-label="上一則觀點">← 上一則</button>
          <div><b data-expert-position>1 / ${list.length}</b><span class="tiny dim" data-expert-label>觀點</span></div>
          <button class="btn" type="button" data-expert-next aria-label="下一則觀點">下一則 →</button>
        </div>
      </div>
        <div class="tiny dim" style="margin-top:8px">只摘要原始來源可證實的觀點,不代表本站立場。每張卡都可回到原文或原始節目。</div>`
        : `<div class="card expert-empty">
          <div><span class="pill">0 筆已核對</span><h3>本場尚無可驗證的名宿／專家觀點</h3>
            <p class="small dim">需要具名專家、媒體、發布時間與原始連結,人工核對後才會顯示。本站不會為了填滿版面,把下方自動分析冒充成真人發言。</p></div>
          <span class="expert-empty-mark" aria-hidden="true">來源<br>待核</span>
        </div>`}`;
  }

  function setupExpertPagers() {
    const labels = { news: '新聞觀點', legend: '名宿觀點', expert: '專家觀點' };
    document.querySelectorAll('[data-expert-pager]').forEach(root => {
      const cards = [...root.querySelectorAll('[data-expert-card]')];
      if (!cards.length) return;
      const prev = root.querySelector('[data-expert-prev]');
      const next = root.querySelector('[data-expert-next]');
      const position = root.querySelector('[data-expert-position]');
      const label = root.querySelector('[data-expert-label]');
      let current = 0;

      const render = () => {
        cards.forEach((card, i) => {
          card.hidden = i !== current;
          card.classList.toggle('active', i === current);
        });
        position.textContent = `${current + 1} / ${cards.length}`;
        // 標籤跟著目前這一則走 —— 分類鈕拿掉之後,這裡是讀者知道「現在在看哪一類」的地方
        label.textContent = labels[cards[current].dataset.category] ?? '觀點';
        prev.disabled = cards.length < 2;
        next.disabled = cards.length < 2;
      };
      prev.onclick = () => { current = (current - 1 + cards.length) % cards.length; render(); };
      next.onclick = () => { current = (current + 1) % cards.length; render(); };
      render();
    });
  }

  function setupAnalysisTabs(initial) {
    const tabs = [...document.querySelectorAll('.analysis-tab')];
    const panels = [...document.querySelectorAll('.analysis-panel')];
    const show = view => {
      tabs.forEach(tab => {
        const on = tab.dataset.view === view;
        tab.classList.toggle('on', on);
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
      });
      panels.forEach(panel => { panel.hidden = panel.id !== `panel-${view}`; });
    };
    tabs.forEach(tab => { tab.onclick = () => show(tab.dataset.view); });
    document.querySelectorAll('[data-view][href^="#panel-"]').forEach(link => {
      link.onclick = event => {
        event.preventDefault();
        show(link.dataset.view);
        document.getElementById(`panel-${link.dataset.view}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });
    show(initial);
  }

  function professionalMarketCard(f, p) {
    if (!f.market) return `<div class="card market-card market-empty">
      <div class="spread"><h3>市場盤口尚未發布</h3><span class="pill tiny">等待資料</span></div>
      <p class="small dim" style="margin:8px 0 0">目前只有本站模型機率。取得可驗證的三向盤口後，才會計算去水機率與模型差距，不會用猜測值補空白。</p>
    </div>`;

    const market = f.market;
    const rows = [
      ['home', `${C.name(f.home)}勝`],
      ['draw', '和局'],
      ['away', `${C.name(f.away)}勝`],
    ].map(([key, label]) => {
      const gap = (p[key] - market.probs[key]) * 100;
      const gapText = `${gap > 0 ? '+' : ''}${gap.toFixed(1)}pp`;
      return `<div class="market-row">
        <b class="market-outcome">${C.esc(label)}</b>
        <div class="market-bars" aria-label="本站 ${C.pct(p[key], 1)}，市場 ${C.pct(market.probs[key], 1)}">
          <div class="market-track"><i class="model" style="width:${(p[key] * 100).toFixed(2)}%"></i></div>
          <div class="market-track"><i class="market" style="width:${(market.probs[key] * 100).toFixed(2)}%"></i></div>
        </div>
        <span class="mono market-prob"><b>${C.pct(p[key], 1)}</b><small>本站</small></span>
        <span class="mono market-prob market-value"><b>${C.pct(market.probs[key], 1)}</b><small>市場</small></span>
        <span class="mono market-odds"><b>${C.fx(market.decimals?.[key], 2)}</b><small>十進位</small></span>
        <span class="pill tiny ${Math.abs(gap) >= 5 ? 'warn' : ''}" title="本站減市場">${gapText}</span>
      </div>`;
    }).join('');

    return `<div class="card market-card">
      <div class="market-head">
        <div><h3>模型 vs 市場共識</h3>
          <div class="small dim">${C.esc(market.source)}・盤口日期 ${C.dateFull(market.date)}</div></div>
        <div class="right"><span class="pill warn">莊家水錢 ${(market.overround * 100).toFixed(1)}%</span>
          <div class="tiny dim" style="margin-top:5px">下列市場機率已去水，合計 100%</div></div>
      </div>
      <div class="market-legend tiny dim"><span><i class="model"></i>本站模型</span><span><i class="market"></i>市場去水機率</span><span>差距 = 本站 − 市場</span></div>
      <div class="market-rows">${rows}</div>
      <div class="note info" style="margin-top:12px"><b>這是市場定價共識，不是資金流向。</b>
        它由十進位賠率取倒數、再按比例去除莊家水錢得出；不能據此判斷大戶或專業玩家實際押了多少資金。</div>
    </div>`;
  }

  function phaseComparison(f, report) {
    const p = f.prediction;
    const real = f.fh > f.fa ? 'home' : f.fh === f.fa ? 'draw' : 'away';
    const outcome = { home: `${C.name(f.home)}勝`, draw: '和局', away: `${C.name(f.away)}勝` }[real];
    const pick = [['home', p.home], ['draw', p.draw], ['away', p.away]].sort((a, b) => b[1] - a[1])[0];
    const market = f.market?.probs ?? null;
    const actualHomeXg = report?.sides?.[f.home]?.xG ?? null;
    const actualAwayXg = report?.sides?.[f.away]?.xG ?? null;
    const marketVerdict = market
      ? (market[real] > p[real] ? '市場' : market[real] < p[real] ? '本站模型' : '兩邊相同')
      : null;
    const fmt = value => value == null ? '—' : C.fx(value, 2);

    return `<div class="section"><h2>賽前 → 市場 → 賽後</h2>
      <span class="hint">把當時的判斷與實際內容放在同一條時間線</span></div>
    <div class="phase-flow">
      <div class="phase-node pre">
        <span class="phase-kicker">01・賽前模型</span>
        <strong>${C.pct(p.home, 0)} / ${C.pct(p.draw, 0)} / ${C.pct(p.away, 0)}</strong>
        <small>預期進球 ${p.xgHome} : ${p.xgAway}</small>
      </div>
      <span class="phase-arrow" aria-hidden="true">→</span>
      <div class="phase-node market">
        <span class="phase-kicker">02・市場共識</span>
        <strong>${market ? `${C.pct(market.home, 0)} / ${C.pct(market.draw, 0)} / ${C.pct(market.away, 0)}` : '尚無盤口'}</strong>
        <small>${f.market ? `${C.esc(f.market.source)}・已去水` : '等待可驗證資料'}</small>
      </div>
      <span class="phase-arrow" aria-hidden="true">→</span>
      <div class="phase-node post">
        <span class="phase-kicker">03・賽後結果</span>
        <strong>${f.fh} : ${f.fa}</strong>
        <small>${outcome}${report ? `・實際 xG ${fmt(actualHomeXg)} : ${fmt(actualAwayXg)}` : ''}</small>
      </div>
    </div>

    <div class="grid g2 phase-summary">
      <div class="card">
        <h3>實際結果的賽前信心</h3>
        <div class="result-confidence">
          <div><span class="tiny dim">本站模型</span><b class="mono">${C.pct(p[real], 1)}</b></div>
          <div><span class="tiny dim">市場共識</span><b class="mono">${market ? C.pct(market[real], 1) : '—'}</b></div>
        </div>
        <div class="small muted">實際發生<b>${outcome}</b>。模型賽前最看好${pick[0] === real ? '的就是這個結果' : '的不是這個結果'}；
          ${marketVerdict ? `${marketVerdict}給實際結果的機率較高。` : '這場沒有市場盤口可比較。'}</div>
        <div class="tiny dim" style="margin-top:8px">單場只能對答案，不能據此判定整套模型優劣；長期表現仍要看模型頁的 RPS 回測。</div>
      </div>
      <div class="card">
        <h3>預期、場面與比分</h3>
        <div class="pre-post-row"><span>${C.name(f.home)}</span><b class="mono">${p.xgHome}</b><i>賽前 xG</i><b class="mono">${fmt(actualHomeXg)}</b><i>實際 xG</i><b class="mono accent-text">${f.fh}</b><i>進球</i></div>
        <div class="pre-post-row"><span>${C.name(f.away)}</span><b class="mono">${p.xgAway}</b><i>賽前 xG</i><b class="mono">${fmt(actualAwayXg)}</b><i>實際 xG</i><b class="mono accent-text">${f.fa}</b><i>進球</i></div>
        <div class="tiny dim" style="margin-top:10px">賽前 xG 是模型對整場進球量的預估；實際 xG 是比賽中射門品質的累積，兩者概念不同但可用來檢查預測與場面是否同向。</div>
      </div>
    </div>

    <div class="section"><h2>三向機率並排</h2><span class="hint">同一尺度比較本站與市場</span></div>
    ${professionalMarketCard(f, p)}`;
  }

  // 升班馬沒有上季英超資料,頁面上多處要據實說明,不能只留空白
  function promoted(f) {
    return [f.home, f.away].filter(c => !tacBy.has(c)).map(c => C.name(c));
  }

  // 開賽後 FPL 才會給真實名單。賽前只能推測 —— 這兩件事必須讓讀者一眼分得出來,
  // 所以標題、標籤、說明三處都要改,不能只換資料悄悄蒙混過去。
  function actualXI(f) {
    const m = (live?.matches ?? []).find(x => x.home === f.home && x.away === f.away && x.started);
    if (!m) return null;
    const side = code => (m.sides?.[code]?.xi ?? []).map(x => ({ ...x, photo: photoOf(x.code) }));
    const home = side(f.home), away = side(f.away);
    return home.length && away.length ? { m, home, away } : null;
  }

  // 英超官方在開賽前約一小時就公布正式名單,比 FPL(開賽後才給)早得多。
  // 所以賽前優先用官方的;開賽後改用 live,因為那裡才有進球、換人、紅牌等場中狀態。
  function officialXI(f) {
    const m = official?.matches?.[`${f.home}|${f.away}`];
    if (!m?.home?.xi?.length || !m?.away?.xi?.length) return null;
    const pic = x => ({ ...x, photo: x.code ? photoOf(x.code) : null });
    const side = s => m[s].xi.map(pic);
    // 官方排位:每一排實際有誰。有這個才畫得出真正的 4-1-4-1(而不是 FPL 粗類的 4-4-2)
    const rowsOf = s => (m[s].rows ? m[s].rows.map(r => r.map(pic)) : null);
    return { m, home: side('home'), away: side('away'),
      formation: { home: m.home.formation, away: m.away.formation },
      rows: { home: rowsOf('home'), away: rowsOf('away') } };
  }


  function lineupSection(f) {
    const live_ = actualXI(f);
    const off = officialXI(f);
    const real = live_ ?? off;                 // 有其一就是「實際」名單,不是推測
    const proj = { home: lineups[f.home], away: lineups[f.away] };
    if (!real && !proj.home && !proj.away) return '';

    const board = (code, list, shape, thisFormation, officialRows, reverseRows = false) => {
      const sh = shapes[code];
      const std = sh?.official
        ? `<b class="mono">${sh.official.formation}</b><span class="pill accent tiny">官方</span>`
        : (sh && !sh.insufficient ? `<b class="mono">${sh.base.label}</b><span class="pill tiny">推導</span>` : null);
      return `
      <div class="card">
        <div class="spread" style="margin-bottom:4px">
          <span class="row" style="gap:8px">${C.badge(code)}<b>${C.name(code)}</b></span>
          ${thisFormation
            ? `<span class="pill ${off || sh?.official ? 'accent' : ''} tiny" title="${off
                ? '英超官方公布的這場陣型'
                : sh?.official
                  ? `依該隊官方陣型(${sh.official.games} 場)排出的預估陣容`
                  : '官方尚無資料,由球員角色推導'}">${thisFormation}</span>`
            : `<span class="pill tiny" title="這場名單的四類人數(FPL 分類)">${shape}</span>`}
        </div>
        ${std ? `<div class="tiny dim" style="margin-bottom:8px">
          常態 ${std}${sh && !sh.insufficient ? `・
          進攻 <span class="mono" style="color:var(--accent)">${sh.attacking.label}</span>・
          防守 <span class="mono" style="color:var(--accent-3)">${sh.defending.label}</span>` : ''}
          </div>` : '<div class="tiny dim" style="margin-bottom:8px">升班馬,英超樣本不足以推導標準陣型</div>'}
        ${C.pitch(list, { photos: true, color: C.team(code).colors?.[0] ?? '#00ff85', officialRows, reverseRows })}
      </div>`;
    };

    const xi = real ? real : { home: proj.home?.xi ?? [], away: proj.away?.xi ?? [] };
    const withPhoto = list => list.map(x => ({ ...x, photo: x.photo ?? photoOf(x.code) }));
    const shapeOf = (code, side) => (live_
      ? (live_.m.sides?.[code]?.shape?.label ?? '—')
      : (proj[side]?.shape ?? '—'));
    // 這場的官方陣型與排位:即使名單走 live,陣型與站位仍以官方公布的為準。
    const fmOf = side => off?.formation?.[side] ?? (real ? null : proj[side]?.shape ?? null);
    // live 名單帶著進球、紅牌等場中狀態,官方排位只有站位 —— 用 code 把兩邊接起來,
    // 兩樣都留住:官方的站位 + live 的場中標記。接不齊就回 null,退回 FPL 粗類分排。
    const rowsOf = (side, list) => {
      // 沒有官方名單時,預估名單自己也帶排位(依官方陣型 + 角色分類排的)
      const raw = off?.rows?.[side] ?? (real ? null : proj[side]?.rows ?? null);
      if (!raw) return null;
      // 排位是另一條路徑,頭貼要自己補 —— 少了這行球場圖會整片沒有照片
      const r = raw.map(row => row.map(x => ({ ...x, photo: x.photo ?? photoOf(x.code) })));
      if (!live_ || !off?.rows?.[side]) return r;
      const byCode = new Map(list.filter(p => p.code != null).map(p => [String(p.code), p]));
      const mapped = r.map(row => row.map(p => (p.code != null ? byCode.get(String(p.code)) ?? p : p)));
      return mapped.reduce((a, x) => a + x.length, 0) === list.length ? mapped : null;
    };

    return `
    <div class="section"><h2>${real ? '實際先發陣容' : '預估先發陣容'}</h2>
      <span class="hint">${live_
        ? `官方名單・第 ${live_.m.minute} 分鐘`
        : off
          ? `英超官方公布的正式名單${off.m.kickoff ? `・${C.ageText ? C.ageText(off.m.kickoff) : ''}` : ''}`
          : `推測值,不是官方名單 —— 依球員近期先發紀錄推算`}</span></div>
    <div class="grid g2">
      ${board(f.home, withPhoto(xi.home), shapeOf(f.home, 'home'), fmOf('home'), rowsOf('home', withPhoto(xi.home)), !!off?.rows?.home)}
      ${board(f.away, withPhoto(xi.away), shapeOf(f.away, 'away'), fmOf('away'), rowsOf('away', withPhoto(xi.away)), !!off?.rows?.away)}
    </div>
    ${real ? '' : `<div class="note" style="margin-top:10px">
      <b>這是推測,不是官方公布的名單。</b>
      官方要到開賽前約一小時才公布 —— 在那之前只能從「誰最近一直在先發」反推。
      <div style="margin-top:6px"><b>陣型不是猜的。</b>
        ${[f.home, f.away].every(c => shapes[c]?.official)
          ? `兩隊都用<b>官方公布的陣型</b>把人排進各條線
             (${C.name(f.home)} ${shapes[f.home].official.formation}、${C.name(f.away)} ${shapes[f.away].official.formation}),
             再由球員的角色(中衛/邊後衛/防中/中場/前腰/邊鋒/中鋒)決定誰站哪一格。`
          : `有官方陣型的隊伍就照官方排,沒有的(本季還沒開踢)才由球員角色推導。`}
        <span class="dim">先前這裡是用 FPL 的四個粗類分線,而 FPL 把邊鋒歸為中場 ——
        結果 20 隊裡有 13 隊都會顯示成 4-5-1,那是分類太粗,不是球隊真的都這樣踢。</span>
      </div>
      ${proj.home?.basis === 'last' || proj.away?.basis === 'last'
        ? '本季才剛開打,目前主要依據<b>上季</b>的先發紀錄,準度會比賽季中段低不少。'
        : proj.home?.basis === 'mixed'
          ? `本季只進行了 ${proj.home?.rounds ?? 0} 輪,推測同時參考本季與上季,本季佔比會隨輪次增加。`
          : '已累積足夠的本季樣本,推測主要依據本季先發紀錄。'}
      <b>官方名單一公布(約開賽前一小時),這一區就會自動換成正式名單。</b>
    </div>`}
    ${real ? '' : injuryNote(f, proj)}
`;
  }

  function injuryNote(f, proj) {
    const rows = [['home', f.home], ['away', f.away]]
      .map(([k, code]) => {
        const out = proj[k]?.unavailable ?? [];
        const doubt = (proj[k]?.xi ?? []).filter(x => x.doubt);
        if (!out.length && !doubt.length) return '';
        return `<div class="stat-line"><span class="small">${C.teamCell(code, { link: false })}</span>
          <span class="small right">
            ${out.length ? `<span style="color:var(--loss)">缺陣 ${out.map(u => C.esc(u.name)).join('、')}</span>` : ''}
            ${out.length && doubt.length ? '　' : ''}
            ${doubt.length ? `<span style="color:var(--draw)">有疑慮 ${doubt.map(u => C.esc(u.name)).join('、')}</span>` : ''}
          </span></div>`;
      }).filter(Boolean).join('');
    return rows ? `<div class="card" style="margin-top:12px"><h3>傷停與疑慮</h3>${rows}
      <div class="tiny dim" style="margin-top:8px">傷停與禁賽的球員已從上面的預估陣容剔除;
        「有疑慮」的仍列入 —— 那種狀態的球員實際上經常還是先發。</div></div>` : '';
  }

  /* 這一場的模型 vs 市場。重點不是「誰對」——賽前沒人知道 ——
     而是「差多少、差在哪一邊」,以及讀者該用什麼態度看這個差距。 */
  function marketNote(f, p) {
    const m = f.market.probs;
    const gaps = [
      ['home', C.name(f.home) + '勝', p.home - m.home],
      ['draw', '和局', p.draw - m.draw],
      ['away', C.name(f.away) + '勝', p.away - m.away],
    ];
    const biggest = [...gaps].sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]))[0];
    // 已完賽的話就直接對答案:誰給實際結果的機率高,誰這場比較準。
    // 一場定不了輸贏,所以順帶把整季的數字擺出來 —— 免得讀者拿單場當結論。
    const settled = f.played && f.fh != null ? (() => {
      const real = f.fh > f.fa ? 'home' : f.fh === f.fa ? 'draw' : 'away';
      const zh = { home: `${C.name(f.home)}勝`, draw: '和局', away: `${C.name(f.away)}勝` }[real];
      const dm = p[real], dk = m[real];
      return { real, zh, model: dm, market: dk, winner: dm > dk ? '模型' : dm < dk ? '市場' : null };
    })() : null;
    const maxGap = Math.abs(biggest[2]);
    // 三個結果的總偏差,拿來判斷「基本一致」還是「明顯分歧」
    const total = gaps.reduce((a, g) => a + Math.abs(g[2]), 0) / 2;
    const level = total < 0.05 ? 'agree' : total < 0.12 ? 'mild' : 'strong';
    const backtest = meta.model.backtest;
    const mk = backtest.market;
    return `<div class="note ${level === 'strong' ? 'warn' : ''}" style="margin-top:10px">
      ${settled ? `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--line)">
        <b>結果是${settled.zh}。</b>賽前本站給 ${C.pct(settled.model, 0)}、市場給 ${C.pct(settled.market, 0)} ——
        ${settled.winner
          ? `<b style="color:${settled.winner === '模型' ? 'var(--accent)' : 'var(--draw)'}">這場${settled.winner}比較準</b>。`
          : '兩邊一樣。'}
        <span class="tiny dim">單場說明不了什麼 —— 機率模型本來就會有低機率事件發生,
        要看的是整季的平均。${mk?.available ? `整季 ${mk.games} 場:本站 RPS ${mk.model.rps}、市場 ${mk.market.rps}。` : ''}</span>
      </div>` : ''}
      <b>${level === 'agree'
        ? '模型和市場看法一致。'
        : level === 'mild'
          ? '模型和市場略有分歧。'
          : '模型和市場明顯分歧 —— 這種時候通常是市場對。'}</b>
      最大的差距在<b>${biggest[1]}</b>:本站 ${C.pct(p[biggest[0]], 0)}、市場 ${C.pct(m[biggest[0]], 0)}
      (相差 ${(maxGap * 100).toFixed(1)} 個百分點)。
      <div class="tiny dim" style="margin-top:6px">
        盤口看得到傷停、輪換、轉會與士氣,本站的模型只吃比賽結果與 FPL 統計 —— 那些都看不到。
        ${mk?.available
          ? `整季回測下來,本站 RPS ${mk.model.rps}、市場 ${mk.market.rps} ——
             差距很小,但<b>市場仍略勝一籌</b>。所以兩邊不同時,不要預設是市場錯了。`
          : '所以兩邊不同時,不要預設是市場錯了。'}
        市場機率是把十進位賠率取倒數、再按比例去掉莊家水錢(本場 ${(f.market.overround * 100).toFixed(1)}%)算出來的,
        不是任何人的主觀判斷。
      </div>
    </div>`;
  }

  // 客隊實際用的顏色跟它自己的主色差多少 —— 差很多就是被換過(兩隊撞色)
  function sameHue(f) {
    const own = C.team(f.away)?.colors?.[0];
    if (!own || !f.colors?.away) return true;
    const hx = s => s.replace('#', '').match(/../g).map(v => parseInt(v, 16));
    const [r1, g1, b1] = hx(own), [r2, g2, b2] = hx(f.colors.away);
    return Math.hypot(r1 - r2, g1 - g2, b1 - b2) < 90;
  }

  /* ── 近況、傷停與拿牌 ──────────────────────────
     這一段刻意跟上面的勝率分開放,而且標題就寫明「沒有進模型」——
     近五戰跟交手紀錄都跑過完整的走查回測(npm run tune:form),
     在沒參與挑係數的賽季上改善不到一個標準誤,所以係數留 0。
     資訊照給,但不能讓讀者以為勝率裡面已經算進去了。 */
  function formSection(f) {
    const H = form?.teams?.[f.home], A = form?.teams?.[f.away];
    if (!H || !A) return '';
    const sh = H.summary, sa = A.summary;
    const av = c => form.teams[c].availability;
    const pct = v => (v == null ? null : v * 100);

    return `
    <div class="section" style="margin-top:18px"><h2>近況、傷停與拿牌</h2>
      <span class="hint">這一段不影響上面的勝率</span></div>
    <div class="card">
      ${C.versus([
        { label: '近五戰場均勝點', h: sh.ppg, a: sa.ppg },
        { label: '近五戰進球', h: sh.gf, a: sa.gf, digits: 0 },
        { label: '近五戰失球', h: sh.ga, a: sa.ga, digits: 0, better: 'low' },
        { label: '傷停佔上場時間', h: pct(av(f.home).missing.minutes), a: pct(av(f.away).missing.minutes),
          digits: 1, unit: '%', better: 'low' },
        { label: '傷停佔進攻產出', h: pct(av(f.home).missing.threat), a: pct(av(f.away).missing.threat),
          digits: 1, unit: '%', better: 'low', hint: 'xGI' },
        { label: '夏天換血幅度', h: pct(av(f.home).departed.minutes), a: pct(av(f.away).departed.minutes),
          digits: 1, unit: '%', better: 'low', hint: '離隊者上季佔比' },
      ], {
        home: f.home, away: f.away, colors: f.colors,
        note: `<b>這五列的數字沒有進預測模型。</b>近期狀況與交手紀錄都做過走查回測 ——
          挑係數只用一個賽季,驗收用另一個完全沒參與挑選的賽季,結果最好的一組只贏基準
          RPS 0.00013,而成對比較的標準誤是 0.00025,改善連一個標準誤都不到。
          再把特徵拿去跟模型的殘差求相關,760 場全部落在 ±0.07 以內、沒有一個顯著。
          <a href="${C.link('model')}">驗證細節在模型頁</a>。
          <br><b>那三個百分比是什麼:</b>「傷停」兩列是目前確定不能上場的球員,
          在${av(f.home).baseline === 'current' ? '本季' : '上季'}合計吃掉了球隊多少比例的上場時間與進攻產出;
          用時間當權重是因為教練讓誰上場久誰就是主力,不必我們自己發明球員評分。
          「夏天換血幅度」則是已經轉隊或外借出去的球員 —— 他們不算這場的傷兵
          (位置多半已有新援補上),但走掉多少戰力本身就是賽前該知道的事。
          ${av(f.home).noBaseline + av(f.away).noBaseline > 0
            ? `<br><b>會低估:</b>兩隊合計有 ${av(f.home).noBaseline + av(f.away).noBaseline}
               名球員沒有參考賽季的數據(多半是剛加盟的新援),他們缺陣算不進上面的比例。` : ''}`,
      })}
    </div>

    <div class="grid g2" style="margin-top:16px">
      ${sideCard(f.home, f.colors?.home)}
      ${sideCard(f.away, f.colors?.away)}
    </div>`;
  }

  function sideCard(code, colour) {
    const t = form.teams[code], a = t.availability;
    const dot = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;
      background:${colour ?? 'var(--accent)'};vertical-align:-1px"></span>`;
    // 勝負用固定的狀態色(綠/黃/紅),不用隊色 —— 隊色是識別,狀態色是結果,
    // 兩者混用的話「紅色」到底代表輸球還是代表某一隊就說不清了。
    const runs = t.recent.map(r => `<i class="frm ${r.res}"
      title="${C.esc(`${r.date}・${r.venue === 'H' ? '主' : '客'}場對 ${C.name(r.opp)}・${r.gf}-${r.ga}`)}">${r.res}</i>`).join('');

    const person = (o, extra = '') => `<div class="stat-line">
      <span class="small">${C.esc(o.name)} <span class="dim tiny">${o.pos}</span></span>
      <span class="tiny dim">${extra}</span></div>`;

    return `<div class="card">
      <h3>${dot} ${C.esc(C.name(code))} 近況</h3>
      <div class="row" style="gap:8px;align-items:center;margin-bottom:8px">
        <span class="form-run">${runs}</span>
        <span class="small dim">${t.summary.w}勝 ${t.summary.d}和 ${t.summary.l}負・
          進 ${t.summary.gf} 失 ${t.summary.ga}</span>
      </div>
      ${t.recent.map(r => `<div class="stat-line">
        <span class="small dim mono">${C.dateFull(r.date)}</span>
        <span class="small">${r.venue === 'H' ? '主' : '客'} vs ${C.teamLink(r.opp)}
          <b class="mono">${r.gf}-${r.ga}</b></span></div>`).join('')}

      <div class="small muted" style="margin:12px 0 4px">確定缺陣${a.outCount > a.out.length ? `(共 ${a.outCount} 人,列出影響最大的 ${a.out.length} 位)` : ''}</div>
      ${a.out.length
        ? a.out.map(o => person(o, `${(o.minutesShare * 100).toFixed(1)}% 上場時間・${C.esc(o.statusZh)}`)).join('')
        : '<div class="dim small">沒有確定缺陣的球員</div>'}

      ${a.departed.count ? `<div class="small muted" style="margin:10px 0 4px">夏天離隊
        <span class="dim tiny">(不算這場的傷兵)</span></div>
        <div class="stat-line"><span class="small">${a.departed.names.map(C.esc).join('、')}${a.departed.count > a.departed.names.length ? ` 等 ${a.departed.count} 人` : ''}</span>
          <span class="tiny dim">上季佔 ${(a.departed.minutes * 100).toFixed(1)}% 上場時間</span></div>` : ''}

      ${a.doubt.length ? `<div class="small muted" style="margin:10px 0 4px">有疑慮(可能趕不上)</div>
        ${a.doubt.map(o => person(o, `${(o.minutesShare * 100).toFixed(1)}% 上場時間${o.chanceNext != null ? `・${o.chanceNext}% 機會出賽` : ''}`)).join('')}` : ''}

      <div class="small muted" style="margin:12px 0 4px">本季拿牌</div>
      ${a.cards.length
        ? a.cards.map(c => `<div class="stat-line">
            <span class="small">${C.esc(c.name)} <span class="dim tiny">${c.pos}</span></span>
            <span class="tiny">
              ${c.yellow ? `<span class="pill tiny" style="border-color:#ffb02055;color:var(--draw)">黃 ${c.yellow}</span>` : ''}
              ${c.red ? `<span class="pill bad tiny">紅 ${c.red}</span>` : ''}
              ${c.watch && c.watch.away === 1 ? `<span class="pill bad tiny">再一張停 ${c.watch.ban} 場</span>` : ''}
            </span></div>`).join('')
        : '<div class="dim small">本季還沒有人拿牌</div>'}
      <div class="tiny dim" style="margin-top:6px">英超規則:球隊第 19 場之前累積 5 張黃牌停 1 場,
        第 32 場之前 10 張停 2 場。目前踢了 ${a.teamMatches} 場。</div>
    </div>`;
  }

  function h2hHtml(f, rec) {
    if (!rec) return `<div class="dim small">${meta.h2hSeasons?.[0] ?? ''} 以來沒有在${C.LEAGUES[C.league()]?.zh ?? '本聯賽'}交手過(多半是剛升上來的球隊)。</div>`;
    const homeIsA = [f.home, f.away].sort()[0] === f.home;
    return `<div class="row small" style="justify-content:space-between">
        <span>${C.teamLink(f.home)} <b>${homeIsA ? rec.aWin : rec.bWin}</b> 勝</span>
        <span class="dim">和 ${rec.draw}</span>
        <span><b>${homeIsA ? rec.bWin : rec.aWin}</b> 勝 ${C.teamLink(f.away)}</span>
      </div>
      <div style="margin-top:8px">${rec.list.slice(0, 6).map(m => `
        <div class="stat-line"><span class="small dim mono">${C.dateFull(m.date)}</span>
          <span class="small">${C.teamLink(m.home)} <b class="mono">${m.fh}-${m.fa}</b> ${C.teamLink(m.away)}</span></div>`).join('')}</div>`;
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
