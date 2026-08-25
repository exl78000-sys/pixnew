import * as C from './core.js';

const app = document.getElementById('app');

try {
  /* 抽屜瘦身之後就不需要 h2h / players / tactics 了 —— 那三張卡片搬去賽前分析頁,
     這裡少載 players.json 一份(2 MB 出頭),分頁模式下的首次開啟明顯變快。 */
  const { meta, clubs, teams, fixtures, results, reports, analysis } =
    await C.load('meta', 'clubs', 'teams', 'fixtures', 'results', 'reports', 'analysis');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();
  const basic = meta.edition === 'basic';
  const teamBy = new Map(teams.map(t => [t.code, t]));
  const playedCount = fixtures.filter(f => f.played).length;
  // 抽屜本身仍不預載 3 MB 球員檔；真的點姓名時才載入並開球員資料。
  let playerByCodePromise = null;
  const resolvePlayer = async code => {
    if (!playerByCodePromise) playerByCodePromise = C.load('players')
      .then(({ players }) => new Map(players.map(p => [String(p.code), p])));
    return (await playerByCodePromise).get(String(code));
  };
  C.bindPlayerLinks(document, resolvePlayer, { meta, mode: 'current' });
  // 本季看賽程與預測,過去賽季看已完賽的比分與賽後分析
  const pastSeasons = [...new Set(results.map(m => m.season))].filter(x => x !== meta.currentSeason).sort().reverse();
  const bySeason = season => season === meta.currentSeason
    ? fixtures
    : results.filter(m => m.season === season).map(m => ({ ...m, kickoff: null }));
  let season = meta.currentSeason;
  const reportFor = f => reports.reports[`${f.season}|${f.home}|${f.away}`] ?? null;
  // 本季單場頁現在同時承接賽前、賽後與兩者對比;過去賽季不在 fixtures.json,仍留在抽屜看報告。
  const hasFullAnalysis = f => f.season === meta.currentSeason && (f.played
    ? !!reportFor(f) || !!analysis.post[`${f.season}|${f.home}|${f.away}`]
    : !!analysis.pre[`${f.home}|${f.away}`]);

  const rounds = [...new Set(fixtures.map(f => f.round))].sort((a, b) => a - b);
  const codes = [...new Set(fixtures.flatMap(f => [f.home, f.away]))].sort((a, b) => C.name(a).localeCompare(C.name(b), 'zh-Hant'));
  const nextRound = fixtures.find(f => !f.played && f.date >= meta.asOf)?.round ?? rounds[0];

  app.innerHTML = `
  <div class="page-head">
    <h1>賽程與預測</h1>
    <p>每一場都用 Dixon-Coles Poisson 與 Elo 各算一次再取平均${basic ? '。西甲目前只有一個完整歷史賽季，尚未宣稱已經獨立回測優於其他模型' : '(回測顯示兩者平均最準)'}。
       點任一場會開速覽:未開賽看勝率與最可能比分,已完賽看賽果與模型有沒有命中;
       ${basic ? `目前提供比分、預測、市場機率（有盤口時），以及 ${meta.lastSeason} 兩隊攻守與風格對比；已進永久快取的完賽場次另有球隊統計、正式陣容、事件與球員評分。` : '想看陣容、戰術、近況與傷停,可進完整單場頁;已完賽還能把<b>賽前預測、市場機率與賽後數據並排對比</b>。'}
       有明確開球時間時會換算成你所在時區(${C.tzName()});只有日期的遠期賽程不會自行猜時間。</p>
    ${C.stampRow([
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算;GitHub Actions 每 15 分鐘跑一次' }),
      C.stamp(basic ? '西甲公開賽程時間' : '開賽時間(官方,含改期)', { iso: meta.builtAt, kind: 'daily' }),
      basic ? C.stamp(`完整賽後資料 ${reports.count ?? 0}/${playedCount} 場`, { iso: meta.builtAt, kind: 'daily', note: '完賽後抓取一次並永久快取' }) : null,
    ])}
  </div>
  ${basic ? `<div class="note ${reports.count ? 'info' : ''}" style="margin-bottom:14px">
    <b>賽後快取：${reports.count ?? 0}/${playedCount} 場。</b>
    每場必須同時取得球隊統計、兩隊正式陣容、事件、球員數據與評分，且比分核對一致才發布；開頁不會呼叫 API。
  </div>` : ''}
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
          : (f.kickoff ? `<span class="small">${C.countdown(f.kickoff)}</span>` : '<span class="dim small">時間待定</span>')) },
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
      ...(basic ? [] : [{ key: 'diff', label: '難度', value: f => (f.difficulty ? f.difficulty.home + f.difficulty.away : 0), num: true,
        title: 'FPL 官方賽程難度(主/客,1~5)',
        render: f => f.difficulty ? `<span class="small dim">${f.difficulty.home} / ${f.difficulty.away}</span>` : '—' }]),
      { key: 'article', label: '分析', value: () => 0, sortable: false,
        // 直達完整分析,不用先開抽屜再點一次
        render: f => (hasFullAnalysis(f)
          ? `<a class="pill info tiny" href="${C.link('analysis', { id: f.id })}"
               onclick="event.stopPropagation()">${f.played ? '賽前／賽後對比' : '完整賽前分析'} →</a>` : '') },
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
  function basicTeamComparison(f) {
    if (!basic) return '';
    const h = teamBy.get(f.home), a = teamBy.get(f.away);
    const ht = h?.tactics, at = a?.tactics;
    if (!ht && !at) return `<div class="note">兩隊都是本季升班馬，${meta.lastSeason} 沒有西甲球隊樣本，因此不製作風格對比。</div>`;
    const val = (obj, path) => path.reduce((v, key) => v?.[key], obj) ?? null;
    const rows = [
      { label: 'Elo', h: h?.elo ?? null, a: a?.elo ?? null, digits: 0 },
      { label: '上季名次', h: h?.lastSeason?.pos ?? null, a: a?.lastSeason?.pos ?? null, digits: 0, better: 'low' },
      { label: '場均勝點', h: h?.lastSeason?.ppg ?? null, a: a?.lastSeason?.ppg ?? null },
      { label: '場均進球', h: val(ht, ['attack', 'goals90']), a: val(at, ['attack', 'goals90']) },
      { label: '場均失球', h: val(ht, ['defence', 'conceded90']), a: val(at, ['defence', 'conceded90']), better: 'low' },
      { label: 'xG / 場', h: val(ht, ['attack', 'xG90']), a: val(at, ['attack', 'xG90']) },
      { label: 'xGA / 場', h: val(ht, ['defence', 'xGA90']), a: val(at, ['defence', 'xGA90']), better: 'low' },
      { label: '定位球 xG / 場', h: val(ht, ['setPieces', 'xG90']), a: val(at, ['setPieces', 'xG90']), digits: 3 },
      { label: '快速進攻 xG 佔比', h: val(ht, ['attack', 'fastXGShare']), a: val(at, ['attack', 'fastXGShare']), unit: '%', digits: 1 },
    ];
    const summary = (t, tac) => `<div>
      <div class="row" style="gap:7px">${C.badge(t.code)}<b>${C.esc(t.en)}</b></div>
      <div class="small muted" style="margin-top:5px">主要陣型：<b class="mono">${tac?.formation?.primary ?? '—'}</b></div>
      <div class="tags" style="margin-top:6px">${(tac?.tags ?? []).slice(0, 3).map(x => `<span class="pill tiny">${C.esc(x)}</span>`).join('') || '<span class="tiny dim">上季西甲樣本從缺</span>'}</div>
    </div>`;
    return `<div class="card"><div class="spread"><h3 style="margin:0">兩隊上季攻守與風格對比</h3><span class="pill tiny">${meta.lastSeason}</span></div>
      <div class="grid g2" style="margin:10px 0">${summary(h, ht)}${summary(a, at)}</div>
      ${C.versus(rows, {
        home: f.home, away: f.away, colors: f.colors,
        note: `${meta.lastSeason} 球隊層級真實賽果與 Understat 摘要；升班馬沒有樣本的欄位顯示從缺。這張卡只供對照，不是模型額外加權。`,
      })}
    </div>`;
  }

  function openMatch(f) {
    const p = f.prediction;
    const rep = reportFor(f);
    const full = `<a class="pill accent" href="${C.link('analysis', { id: f.id })}">${f.played ? '完整賽前／賽後對比' : '完整賽前分析'} →</a>`;

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
        ${basic && f.market ? `<div class="note info" style="margin-top:10px">
          <b>專業市場去水機率</b>：主勝 ${C.pct(f.market.probs.home)}、和局 ${C.pct(f.market.probs.draw)}、客勝 ${C.pct(f.market.probs.away)}；
          十進位賠率 ${f.market.decimals.home} / ${f.market.decimals.draw} / ${f.market.decimals.away}，水錢 ${C.pct(f.market.overround)}。
          <span class="dim">${f.market.source}，這是市場定價共識，不代表實際資金流向。</span>
        </div>` : ''}
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
        ${hasFullAnalysis(f) ? `<div class="spread" style="margin-top:14px;align-items:center">
          <span class="tiny dim">${f.played ? '賽前模型、市場共識、實際 xG、陣容與賽後解讀都能並排查看' : '陣容、戰術對比、歷來交手、近況與傷停都在那一頁'}</span>${full}</div>` : ''}
      </div>

      ${basicTeamComparison(f)}

      ${rep ? C.matchReportCards(rep) : (f.played
        ? `<div class="note">${basic ? '這場尚待 API-Football 永久快取；球隊統計、正式陣容、事件、球員資料與評分未全部通過前不顯示半成品。' : '這場沒有逐球員的出場資料,所以沒有陣容與戰術解讀。有資料的輪次可用 <span class="mono">npm run season</span> 補上。'}</div>`
        : '')}`);
  }

  const id = C.qs('id');
  if (id) { const f = fixtures.find(x => x.id === id); if (f) openMatch(f); }

} catch (err) { C.fail(err); }
