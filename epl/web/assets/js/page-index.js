import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, teams, sim, fixtures, news, table, clubs, reports } =
    await C.load('meta', 'teams', 'sim', 'fixtures', 'news', 'table', 'clubs', 'reports');
  C.registerTeams(clubs);
  C.registerTeams(teams);
  C.nav();

  const played = fixtures.filter(f => f.played);
  const basic = meta.edition === 'basic';
  const curBy = new Map((table.current ?? []).map(r => [r.code, r]));

  // 開季前幾輪的排名幾乎沒有意義(大家場次都一樣少),與其讓讀者自己踩坑,不如明講
  const earlyNote = () => {
    const maxPlayed = Math.max(0, ...(table.current ?? []).map(r => r.p));
    if (maxPlayed >= 6) return '';
    return `<div class="note" style="margin-top:10px">
      才踢了 ${maxPlayed} 輪,這張表<b>還不能當實力排序看</b> ——
      同分的隊伍靠淨勝球和進球數分先後,一場大勝就能把人推到第一。
      要看實力請往下看預測積分榜,那裡吃的是${basic ? '上一完整賽季' : '過去三季'}的樣本。</div>`;
  };
  const upcoming = fixtures.filter(f => !f.played).sort((a, b) => (a.date < b.date ? -1 : 1));
  const nextRound = upcoming[0]?.round ?? null;
  const injuries = news.filter(n => n.cat === '傷停' || n.cat === '禁賽');
  const simBy = new Map(sim.map(s => [s.code, s]));
  const bt = meta.model.backtest;

  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  app.innerHTML = `
  <div class="page-head">
    <h1>${basic ? '西甲戰情室・球隊數據第二版' : '英超戰情室'}</h1>
    <p>${basic
      ? `使用 ${meta.lastSeason} 完整賽果與 ${meta.currentSeason} 已完賽資料，產生積分榜、單場機率與賽季模擬；回歸球隊另有上季 xG、射門、實際陣型與進球情境。完賽後資料會一次性永久快取；球員與教練資料已接入，傷停仍無可靠來源${meta.live?.available ? '，即時比分也已接入' : ''}。`
      : `把 ${meta.historySeasons.join('、')} 的每一場比賽、每一位球員的進階數據跑成模型，做出本季 ${meta.currentSeason} 的積分預測、單場勝負機率、戰術剖析與傷停動態。所有數字都可以往下追到原始資料，沒有一項是拍腦袋填的。`}</p>
    ${C.stampRow([
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算；本機同步後再手動發布' }),
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
      meta.live?.available ? C.stamp('即時比分', { iso: meta.live.fetchedAt, kind: 'live', note: '來源:' + meta.live.sourceLabel }) : null,
    ])}
  </div>

  <div class="grid g4">
    ${kpi('本季進度', played.length ? `第 ${played.at(-1).round} 輪` : `第 ${nextRound ?? 1} 輪`,
      `${meta.currentSeason}・已賽 ${played.length} / ${fixtures.length} 場`)}
    ${kpi('模型準度', bt.available ? bt.rps : '—', bt.available ? `RPS(越低越好)・基準線 ${bt.baselineRps}` : (basic ? '尚無獨立留出賽季' : '執行 npm test 後產生'))}
    ${kpi('命中率', bt.available ? C.pct(bt.hitRate, 1) : '—', bt.available ? `${bt.season} ${bt.games} 場走查回測` : '尚未回測')}
    ${basic
      ? kpi('資料範圍', '2 季', `${meta.lastSeason} 完整・${meta.currentSeason} 進行中`)
      : meta.live?.demo === false && meta.live?.counts?.live > 0
      ? kpi('進行中', `${meta.live.counts.live} 場`, `第 ${meta.live.round} 輪・點上方實時戰況`)
      : kpi('傷停名單', injuries.length, `涵蓋 ${meta.counts.players} 名註冊球員`)}
  </div>

  <div class="section"><h2>本季目前戰績</h2>
    <span class="hint">${meta.currentSeason}・已踢完 ${played.length} 場的真實積分榜</span></div>
  ${played.length ? '<div id="curTable"></div>' + earlyNote() : `
    <div class="note">本季還沒有比賽踢完,所以還沒有積分榜。
      下面的預測完全來自過去幾季的資料;等第一輪踢完,這裡就會出現真實戰績。</div>`}

  <div class="section"><h2>本季預測積分榜</h2>
    <span class="hint">蒙地卡羅模擬 ${meta.model.simulationRuns.toLocaleString()} 次賽季</span></div>
  <div id="simTable"></div>
  <div class="note info" style="margin-top:10px">
    <b>每踢完一場就會重算。</b>期望積分 =<b>已經拿到的分數</b>+ 剩餘賽程的模擬結果,
    而且已完賽的比分也會回頭修正球隊強度,影響後面每一場的機率。
    ${played.length ? `目前已計入 ${played.length} 場真實賽果。` : ''}
  </div>

  <div class="grid g2" style="margin-top:16px">
    <div class="card">
      <h2>接下來的比賽</h2>
      <div id="next"></div>
      <div style="margin-top:10px"><a href="${C.link('fixtures')}">完整賽程與預測 →</a>
        ${basic ? '' : `・<a href="${C.link('live')}">實時戰況</a>`}</div>
    </div>
    <div class="card">
      <h2>${basic ? '目前資料界線' : '最新動態'}</h2>
      <div id="news">${basic ? `<div class="small muted" style="display:grid;gap:8px">
        <div>✓ 賽程、比分、積分榜、近期戰績、單場預測與賽季模擬</div>
        <div>✓ 上季球隊 xG/xGA、射門、實際陣型、五種進球情境與風格百分位</div>
        <div>✓ 完賽後完整資料永久快取 ${reports.count ?? 0}/${played.length} 場（球隊統計、正式陣容、事件與球員評分）</div>
        <div>— 球員與教練資料已接入；傷停${meta.capabilities?.injuries ? '已接入' : '尚無可靠來源'}；即時比分${meta.live?.available ? '已接入' : '仍以賽程推算'}</div>
        <div class="dim">模型只使用一個完整賽季，尚無獨立留出賽季可做可靠回測。</div>
      </div>` : ''}</div>
      ${basic ? '' : `<div style="margin-top:10px"><a href="${C.link('news')}">看全部動態 →</a></div>`}
    </div>
  </div>

  <div class="section"><h2>上季最終戰績</h2><span class="hint">${meta.lastSeason}・所有進階指標的基準</span></div>
  <div id="lastTable"></div>

  <div class="card" style="margin-top:20px">
    <h2>模型是怎麼算的</h2>
    <div class="small muted" style="display:grid;gap:6px">
      <div><b class="mono">${meta.model.type}</b> — 每支球隊各有進攻強度與防守強度,加上主場優勢
        (${meta.model.homeAdvantage}× 進球)與低比分修正 ρ=${meta.model.rho};
        近期比賽權重較高(時間衰減 ξ=${meta.model.decayXi})。</div>
      ${bt.available ? `<div>回測方式:重跑上季 38 輪,每一輪都只用「開賽前」的資料建模再預測,避免偷看未來。
        採用值 RPS ${bt.rps} / LogLoss ${bt.logLoss} / 命中率 ${C.pct(bt.hitRate)};
        單獨用 Poisson 是 ${bt.models.poisson.rps}、單獨用 Elo 是 ${bt.models.elo.rps}、
        固定機率基準線是 ${bt.models.baseline.rps} —— 兩者平均最好,所以平台採用平均值。</div>`
        : '<div class="dim">尚未跑過回測,執行 <span class="mono">npm test</span> 再重跑 build 就會顯示實測準度。</div>'}
      ${meta.model.caveats.map(c => `<div class="dim">・${c}</div>`).join('')}
    </div>
  </div>
  ${C.foot(meta)}`;

  /* 預測積分榜 */
  const simRows = sim.map(s => ({ ...s, t: C.team(s.code) }));
  document.getElementById('simTable').innerHTML = C.table(simRows, [
    { key: 'pos', label: '#', value: r => r.expectedPos, render: (r, i) => i + 1, sortable: false, num: true },
    { key: 'team', label: '球隊', value: r => C.name(r.code), render: r => C.teamCell(r.code) },
    { key: 'earned', label: '本季實得', value: r => (curBy.get(r.code)?.pts ?? 0), num: true,
      title: '已經踢完的比賽拿到的分數,這部分不是預測',
      render: r => { const c = curBy.get(r.code);
        return c?.p ? `<b>${c.pts}</b><span class="dim tiny"> / ${c.p} 場</span>` : '<span class="dim">—</span>'; } },
    { key: 'expectedPoints', label: '期望積分', value: r => r.expectedPoints, num: true,
      title: '本季實得 + 剩餘賽程的模擬結果',
      render: r => `<b>${r.expectedPoints}</b>` },
    { key: 'titlePct', label: '奪冠', value: r => r.titlePct, num: true,
      render: r => `${r.titlePct}%${C.bar(r.titlePct, 100)}` },
    { key: 'top4Pct', label: '前四', value: r => r.top4Pct, num: true,
      render: r => `${r.top4Pct}%${C.bar(r.top4Pct, 100, 'alt')}` },
    { key: 'relegationPct', label: '降級', value: r => r.relegationPct, num: true,
      render: r => `${r.relegationPct}%${C.bar(r.relegationPct, 100, 'hot')}` },
    { key: 'last', label: '上季', value: r => (C.team(r.code).lastSeason?.pos ?? 99),
      render: r => { const t = teams.find(x => x.code === r.code); return t?.lastSeason ? `第 ${t.lastSeason.pos} 名` : '<span class="pill">升班馬</span>'; }, num: true },
    { key: 'elo', label: 'Elo', value: r => teams.find(x => x.code === r.code)?.elo ?? 0, num: true,
      render: r => C.fx(teams.find(x => x.code === r.code)?.elo, 0) },
  ], { sortKey: 'expectedPoints', desc: true, onRow: r => { C.go('teams', { code: r.code }); } });

  /* 本季目前戰績 */
  if (played.length) {
    document.getElementById('curTable').innerHTML = C.table(table.current, [
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
      { key: 'form', label: '近況', value: r => r.pts, sortable: false, render: r => C.formRun(r.form) },
    ], { sortKey: 'pos', desc: false, onRow: r => { C.go('teams', { code: r.code }); } });
  }

  /* 近期比賽 */
  document.getElementById('next').innerHTML = upcoming.slice(0, 6).map(f => `
    <a href="${C.link('analysis', { id: f.id })}" style="color:inherit;text-decoration:none">
      <div class="spread" style="padding:8px 0;border-bottom:1px solid var(--line-soft)">
        <div style="min-width:0">
          <div class="row" style="gap:7px">${C.badge(f.home)}<b>${C.name(f.home)}</b>
            <span class="dim">vs</span>${C.badge(f.away)}<b>${C.name(f.away)}</b></div>
          <div class="tiny dim">${f.kickoff ? C.kickoffLocal(f.kickoff) : C.dateFull(f.date)}・第 ${f.round} 輪・
            預期比分 ${f.prediction.xgHome}:${f.prediction.xgAway}</div>
          ${f.kickoff ? `<div class="tiny"><span class="dim">開賽倒數 </span>${C.countdown(f.kickoff)}</div>` : '<div class="tiny dim">開球時間待賽程來源確認</div>'}
        </div>
        ${C.probBar(f.prediction)}
      </div></a>`).join('');

  /* 動態 */
  // 賽前預告已經在左邊那塊呈現了,這裡只放真正的動態
  if (!basic) document.getElementById('news').innerHTML = news.filter(n => n.cat !== '賽前').slice(0, 7).map(n => `
    <div style="padding:7px 0;border-bottom:1px solid var(--line-soft)">
      <div class="row" style="gap:7px">
        <span class="pill ${n.cat === '傷停' || n.cat === '禁賽' ? 'bad' : n.cat === '賽前' ? 'info' : 'accent'}">${n.cat}</span>
        <b class="small">${C.esc(n.title)}</b>
      </div>
      <div class="tiny muted" style="margin-top:2px">${C.esc(n.body).slice(0, 96)}</div>
    </div>`).join('');

  C.startCountdowns();

  /* 上季積分榜 */
  document.getElementById('lastTable').innerHTML = C.table(table.last, [
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
    { key: 'homeAwayGap', label: '主客差', value: r => r.homeAwayGap, num: true,
      title: '主場場均勝點 − 客場場均勝點', render: r => C.signed(r.homeAwayGap, 2) },
    { key: 'form', label: '末段狀態', value: r => r.pts, sortable: false, render: r => C.formRun(r.form) },
  ], { sortKey: 'pts', desc: true, onRow: r => { C.go('teams', { code: r.code }); } });

} catch (err) { C.fail(err); }
