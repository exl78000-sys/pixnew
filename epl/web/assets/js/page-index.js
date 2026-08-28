import * as C from './core.js?v=8f2d43d5';
import { mountFixtureList } from './fixture-list.js?v=b78e72fc';

const app = document.getElementById('app');

try {
  /* 預測積分榜移到實時戰況頁了,所以這一頁不再需要 sim.json —— 少載一份。 */
  const { meta, teams, fixtures, news, table, clubs, reports, results, analysis } =
    await C.load('meta', 'teams', 'fixtures', 'news', 'table', 'clubs', 'reports', 'results', 'analysis');
  C.registerTeams(clubs);
  C.registerTeams(teams);
  C.nav();

  const played = fixtures.filter(f => f.played);
  const basic = meta.edition === 'basic';

  const upcoming = fixtures.filter(f => !f.played).sort((a, b) => (a.date < b.date ? -1 : 1));
  const nextRound = upcoming[0]?.round ?? null;
  const injuries = news.filter(n => n.cat === '傷停' || n.cat === '禁賽');
  const bt = meta.model.backtest ?? { available: false };
  /* 頁首那段話原本是「西甲 or 英超」二選一寫死在這裡。加第三個聯賽時它就撞上了 ——
     英冠沒有球員、沒有 xG,套用西甲那段會宣稱一堆本站根本沒有的東西。
     新聯賽一律由自己的 build 寫進 meta.intro;兩個舊聯賽的文案先留在這裡,
     是為了不去動它們既有的產物。 */
  const intro = meta.intro ?? (basic
    ? `使用 ${meta.lastSeason} 完整賽果與 ${meta.currentSeason} 已完賽資料，產生積分榜、單場機率與賽季模擬；回歸球隊另有上季 xG、射門、實際陣型與進球情境。完賽後資料會一次性永久快取；球員與教練資料已接入，傷停仍無可靠來源${meta.live?.available ? '，即時比分也已接入' : ''}。`
    : `把 ${meta.historySeasons?.join('、') ?? '過往賽季'} 的每一場比賽、每一位球員的進階數據跑成模型，做出本季 ${meta.currentSeason} 的積分預測、單場勝負機率、戰術剖析與傷停動態。所有數字都可以往下追到原始資料，沒有一項是拍腦袋填的。`);

  /* ── 賽程表(原 page-fixtures.js)── */
  const pastSeasons = [...new Set(results.map(m => m.season))].filter(x => x !== meta.currentSeason).sort().reverse();
  const rounds = [...new Set(fixtures.map(f => f.round))].sort((a, b) => a - b);
  const codes = [...new Set(fixtures.flatMap(f => [f.home, f.away]))]
    .sort((a, b) => C.name(a).localeCompare(C.name(b), 'zh-Hant'));
  const nextRoundNo = fixtures.find(f => !f.played && f.date >= meta.asOf)?.round ?? rounds[0];

  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  app.innerHTML = `
  <div class="page-head">
    <h1>${C.LEAGUES[C.league()]?.zh ?? ''}首頁</h1>
    <p>${intro}</p>
    ${C.stampRow([
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算；本機同步後再手動發布' }),
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
      meta.live?.available ? C.stamp('即時比分', { iso: meta.live.fetchedAt, kind: 'live', note: '來源:' + meta.live.sourceLabel }) : null,
    ])}
  </div>

  <div class="grid g4">
    ${kpi('本季進度', played.length ? `第 ${played.at(-1).round} 輪` : `第 ${nextRound ?? 1} 輪`,
      `${meta.currentSeason}・已賽 ${played.length} / ${fixtures.length} 場`)}
    ${/* 兩個聯賽現在都有走查回測,所以這裡不再分聯賽。
          舊的兩句都已經過期:西甲那句「尚無獨立留出賽季」不成立了,
          英超那句「執行 npm test 後產生」是寫給開發者的。 */''}
    ${kpi('模型準度', bt.available ? bt.rps : '—',
      bt.available ? `RPS(越低越好)・基準線 ${bt.baselineRps}` : '這個聯賽還沒有回測結果')}
    ${kpi('命中率', bt.available ? C.pct(bt.hitRate, 1) : '—', bt.available ? `${bt.season} ${bt.games} 場走查回測` : '尚未回測')}
    ${basic || meta.players?.available === false
      ? kpi('資料範圍', `${(meta.historySeasons?.length ?? 1) + 1} 季`, `${meta.lastSeason} 完整・${meta.currentSeason} 進行中`)
      : meta.live?.demo === false && meta.live?.counts?.live > 0
      ? kpi('進行中', `${meta.live.counts.live} 場`, `第 ${meta.live.round} 輪・點上方實時戰況`)
      : kpi('傷停名單', injuries.length, `涵蓋 ${meta.counts.players} 名註冊球員`)}
  </div>

  <div class="grid g2" style="margin-top:16px">
    <div class="card">
      <h2>接下來的比賽</h2>
      <div id="next"></div>
      <div style="margin-top:10px"><a href="#allFixtures">往下看完整賽程與預測 →</a>
        ${/* 以前是「西甲一律不給實時戰況連結」。西甲的即時比分已經接上了
              (meta.live.available = true),所以改成看有沒有來源。 */''}
        ${meta.live?.available ? `・<a href="${C.link('live')}">實時戰況</a>` : ''}</div>
    </div>
    <div class="card">
      <h2>最新動態</h2>
      <div id="news"></div>
      <div style="margin-top:10px"><a href="${C.link('news')}">看全部動態 →</a></div>
    </div>
  </div>

  ${/* 賽程表原本是獨立的一頁。分成兩頁的話,讀者看完積分榜想看下一輪對誰,
        要再點一次而且整頁重載;而兩頁的頁首、時效標籤、模型說明本來就講同一件事,
        等於同一段話維護兩份。合併之後這一頁就是「這個賽季的全部」。 */''}
  <div class="section" id="allFixtures"><h2>完整賽程與預測</h2>
    <span class="hint">點任一場看單場分析・${C.tzName()}</span></div>
  <div class="filters">
    <label>賽季</label><select id="fSeason">
      <option value="${meta.currentSeason}">${meta.currentSeason}(本季・預測)</option>
      ${pastSeasons.map(x => `<option value="${x}">${x}(已完賽)</option>`).join('')}</select>
    <label>輪次</label><select id="fRound"><option value="">全部</option>
      ${rounds.map(r => `<option value="${r}" ${r === nextRoundNo ? 'selected' : ''}>第 ${r} 輪</option>`).join('')}</select>
    <label>球隊</label><select id="fTeam"><option value="">全部</option>
      ${codes.map(c => `<option value="${c}">${C.name(c)}</option>`).join('')}</select>
    <label>狀態</label><select id="fState">
      <option value="">全部</option><option value="未賽">未賽</option><option value="已賽">已賽</option></select>
    <span class="dim small" id="fxCount"></span>
  </div>
  <div id="fixtureList"></div>

  ${/* 「目前資料界線」。西甲那張卡片會插入 reports.count 之類的即時值,所以留在這裡;
        其餘聯賽由自己的 build 把每一行寫進 meta.boundaries —— 這一頁不該知道
        哪個聯賽有什麼,那正是加英冠時撞到的問題。 */''}
  ${!basic && meta.boundaries?.length ? `<div class="card" style="margin-top:20px">
      <h2>目前資料界線</h2>
      <div class="small muted" style="display:grid;gap:8px">
        ${meta.boundaries.map(x => `<div${x.startsWith('—') ? ' class="dim"' : ''}>${x}</div>`).join('')}
      </div>
    </div>` : ''}
  ${basic ? `<div class="card" style="margin-top:20px">
      <h2>目前資料界線</h2>
      <div>${`<div class="small muted" style="display:grid;gap:8px">
        <div>✓ 賽程、比分、積分榜、近期戰績、單場預測與賽季模擬</div>
        <div>✓ 上季球隊 xG/xGA、射門、實際陣型、五種進球情境與風格百分位</div>
        <div>✓ 完賽後完整資料永久快取 ${reports.count ?? 0}/${played.length} 場（球隊統計、正式陣容、事件與球員評分）</div>
        <div>— 球員與教練資料已接入；傷停${meta.capabilities?.injuries ? '已接入' : '尚無可靠來源'}；即時比分${meta.live?.available ? '已接入' : '仍以賽程推算'}</div>
        ${/* 這一行本來寫死「只使用一個完整賽季，尚無獨立留出賽季可做可靠回測」——
              補上 2024-25 並接進回測管線之後兩句都不成立了。改成跟著產物走。 */''}
        <div class="dim">模型訓練用了 ${meta.historySeasons?.join('、') ?? '過往賽季'};
          ${bt.available
            ? `走查回測 ${bt.season} ${bt.games} 場,RPS ${bt.rps}(基準線 ${bt.baselineRps})——
               <a href="${C.link('model')}">看驗證過程</a>。`
            : '尚未跑走查回測,所以這一頁不給準度數字。'}</div>
      </div>`}</div>
    </div>` : ''}

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
        : '<div class="dim">這個聯賽還沒有走查回測結果,所以這一頁不給準度數字 —— 給了就是假的。</div>'}
      ${meta.model.caveats.map(c => `<div class="dim">・${c}</div>`).join('')}
    </div>
  </div>
  ${C.foot(meta)}`;

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
  const newsRows = news.filter(n => n.cat !== '賽前').slice(0, 7);
  document.getElementById('news').innerHTML = newsRows.length
    ? newsRows.map(n => `
    <div style="padding:7px 0;border-bottom:1px solid var(--line-soft)">
      <div class="row" style="gap:7px">
        <span class="pill ${n.cat === '傷停' || n.cat === '禁賽' ? 'bad' : n.cat === '賽前' ? 'info' : 'accent'}">${C.esc(n.cat)}</span>
        ${n.link
          ? `<a class="small" href="${C.esc(n.link)}" target="_blank" rel="noopener"><b>${C.esc(n.title)}</b></a>`
          : `<b class="small">${C.esc(n.title)}</b>`}
      </div>
      <div class="tiny muted" style="margin-top:2px">${C.esc(n.body).slice(0, 96)}${n.source ? `<span class="dim">・${C.esc(n.source)}</span>` : ''}</div>
    </div>`).join('')
    : '<div class="small dim">目前沒有動態。</div>';

  C.startCountdowns();

  /* 賽程表(共用模組,原 page-fixtures.js) */
  mountFixtureList({ meta, teams, fixtures, results, reports, analysis });

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
