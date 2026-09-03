import * as C from './core.js?v=e2cd8ffc';

/* ── 賽程列表 + 單場速覽抽屜(共用模組) ─────────────────────────
   原本是獨立的 page-fixtures.js。「總覽」與「賽程與預測」合併成一頁之後,
   這段程式被合併頁使用;**抽成模組而不是複製過去** ——
   複製的話同一份列表會有兩個版本,改了一邊另一邊悄悄過期
   (戰術頁的風格卡、賽前分析頁的陣容對照都踩過這個坑)。

   呼叫端負責:載資料、畫篩選器的 HTML、提供掛載點的 id。
   這裡負責:表格、抽屜、深連結 ?id=、倒數計時。 */
export function mountFixtureList({
  meta, teams, fixtures, results, reports, analysis,
  listId = 'fixtureList', countId = 'fxCount',
  selectIds = { season: 'fSeason', round: 'fRound', team: 'fTeam', state: 'fState' },
}) {
  const basic = meta.edition === 'basic';
  const teamBy = new Map(teams.map(t => [t.code, t]));
  const bySeason = season => season === meta.currentSeason
    ? fixtures
    : results.filter(m => m.season === season).map(m => ({ ...m, kickoff: null }));
  const reportFor = f => reports.reports[`${f.season}|${f.home}|${f.away}`] ?? null;
  const hasFullAnalysis = f => f.season === meta.currentSeason && (f.played
    ? !!reportFor(f) || !!analysis.post[`${f.season}|${f.home}|${f.away}`]
    : !!analysis.pre[`${f.home}|${f.away}`]);

  const render = () => {
    const season = document.getElementById(selectIds.season).value;
    const isCurrent = season === meta.currentSeason;
    const r = document.getElementById(selectIds.round).value;
    const t = document.getElementById(selectIds.team).value;
    const st = document.getElementById(selectIds.state).value;
    const rows = bySeason(season).filter(f =>
      (!r || f.round === +r) && (!t || f.home === t || f.away === t) &&
      (!st || (st === '已賽' ? f.played : !f.played)));
    const withReport = rows.filter(f => reportFor(f)).length;
    document.getElementById(countId).textContent =
      `共 ${rows.length} 場${withReport ? `・其中 ${withReport} 場有完整賽後分析` : ''}`;
    document.getElementById(listId).innerHTML = C.table(rows, [
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
    /* 點列直接進完整分析,不先開抽屜(使用者回饋:多一跳沒有意義)。
       **已賽的本季場次一律直達** —— 剛完場、報告還沒生成的空窗期,分析頁自己會
       降級成賽前分頁 + 比分,不需要在這裡擋。抽屜只留給往季賽果與
       還沒有賽前分析的未來場次,那裡它就是全部內容。 */
    ], { sortKey: 'date', desc: false, onRow: f => ((f.season === meta.currentSeason && f.played) || hasFullAnalysis(f)
      ? (location.href = C.link('analysis', { id: f.id })) : openMatch(f)) });
    C.startCountdowns();
  };

  const hitScore = f => {
    if (!f.played || !f.prediction) return -1;
    const p = f.prediction;
    const real = f.fh > f.fa ? 'home' : f.fh === f.fa ? 'draw' : 'away';
    return p[real];
  };
  ['season', 'round', 'team', 'state'].forEach(k => {
    const el = document.getElementById(selectIds[k]);
    if (el) el.onchange = render;
  });

  /* 深連結:?team=<隊碼> 進來就把球隊篩選預設好,並捲到賽程表。

     這一張表本來就有球隊/賽季/輪次/狀態四個篩選,還有預測、賽果與賽後報告 ——
     球隊頁要「看這支球隊的完整賽程」時,該做的是連進來這裡,
     **不是另外做一個賽程頁**。做第二份的話,改了一邊另一邊會悄悄過期
     (歐冠與足球知識就是為了這條才收在 lib/)。

     隊碼對不上就當沒帶(不要靜靜篩成空的,那看起來像這支球隊沒有比賽)。 */
  {
    const want = C.qs('team');
    const el = want && document.getElementById(selectIds.team);
    if (el && [...el.options].some(o => o.value === want)) {
      el.value = want;
      /* **輪次要一起放開。** 輪次篩選預設是「下一輪」,只設球隊的話
         「看完整賽程」會只剩一場 —— 連結講的是完整賽程,給一場就是說了不算。 */
      const round = document.getElementById(selectIds.round);
      if (round) round.value = '';
      /* 從球隊頁的「看完整賽程」進來的,要的是**未來的比賽** ——
         狀態預設成未賽。已賽的切一下狀態就有,預設塞整季會讓下一場沉在中間。 */
      const st = document.getElementById(selectIds.state);
      if (st) st.value = '未賽';
      requestAnimationFrame(() => el.closest('.filters')?.scrollIntoView({ block: 'start' }));
      appendCupFixtures(want);
    }
  }
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
        ? `<div class="note">${basic
          ? '這場尚待主要資料源完成永久快取;球隊統計、正式陣容、事件、球員資料與評分未全部通過前不顯示半成品。'
          : '這場沒有逐球員的出場資料,所以沒有陣容與戰術解讀 —— 上游補上之後會自動出現。'}</div>`
        : '')}`);
  }

  /* 該球隊的盃賽場次(2026-08-29 加)。聯賽賽程表刻意不混盃賽
     (「本季 380 場」不能突然變 500 場),所以盃賽另起一個區塊掛在表格後面。
     資料一律取英超目錄那一份(cups 只有那裡有;ucl 各聯賽是相同複本)。
     cups.json 有 1.8MB,**只在帶 ?team= 進來時才載**,平常的賽程表不揹這個重量。

     比對用 code 優先、隊名備援 —— cups 的名冊只認英超那 27 支,
     英冠球隊(例如 Millwall)在盃賽資料裡只有名字沒有 code。 */
  async function appendCupFixtures(code) {
    const host = document.getElementById('fixtureList');
    if (!host) return;
    const box = document.createElement('div');
    box.id = 'teamCupFixtures';
    host.after(box);
    try {
      const { data: shared } = await C.loadFrom('pl', ['cups', 'ucl']);
      const team = teams.find(t => t.code === code);
      const names = new Set([team?.en, team?.of, C.name(code)].filter(Boolean).map(x => x.toLowerCase()));
      const isMine = side => side && (side.code === code || names.has(String(side.name ?? '').toLowerCase()));

      const rows = [];
      for (const cup of shared.cups?.cups ?? []) {
        const season = cup.seasons?.find(x => x.current);
        for (const r of season?.rounds ?? []) {
          for (const m of r.matches) {
            if (m.played || (!isMine(m.home) && !isMine(m.away))) continue;
            const home = isMine(m.home);
            const opp = home ? m.away : m.home;
            /* 上游抽籤後常先給「日期 + 00:00Z」的占位 —— 半夜整點 UTC 不會有球賽,
               照印會變成「台北 08:00 開球」這種假時間。日期照給,時間標待定。 */
            const placeholder = typeof m.kickoff === 'string' && m.kickoff.endsWith('T00:00:00Z');
            rows.push({ comp: cup.zh, stage: r.stage,
              kickoff: placeholder ? null : m.kickoff,
              dateOnly: placeholder ? m.kickoff.slice(0, 10) : null,
              home, opp: opp?.name ?? '待定' });
          }
        }
      }
      rows.sort((a, b) => String(a.kickoff ?? a.dateOnly ?? '9') < String(b.kickoff ?? b.dateOnly ?? '9') ? -1 : 1);

      // 歐冠:新賽季只有抽籤時,列出抽到的對手(還沒有時間,不假裝有)
      const drawSeason = (shared.ucl?.seasons ?? []).find(x => x.availability === 'draw-only');
      const drawRow = drawSeason?.draw?.rows?.find(r => r.code === code);

      if (!rows.length && !drawRow) { box.remove(); return; }
      box.innerHTML = `
        <div class="section" style="margin-top:18px"><h2>盃賽場次</h2>
          <span class="hint">聯賽賽程表刻意不混盃賽,所以另列在這裡・<a href="${C.link('cups')}">盃賽頁 →</a></span></div>
        <div class="card">
          ${rows.map(r => `<div class="stat-line">
            <span class="small"><span class="pill tiny">${C.esc(r.comp)}</span>
              ${C.esc(r.stage)}・${r.home ? '主' : '客'} vs ${C.esc(r.opp)}</span>
            <span class="mono small dim">${r.kickoff ? C.kickoffLocal(r.kickoff)
              : r.dateOnly ? `${C.dateFull(r.dateOnly)}・時間待定` : '時間待定'}</span>
          </div>`).join('')}
          ${drawRow ? `<div class="stat-line"><span class="small"><span class="pill tiny">歐冠</span>
              ${C.esc(drawSeason.label)} 聯賽階段・已抽籤</span>
            <span class="tiny dim">對手:${[...(drawRow.home ?? []), ...(drawRow.away ?? [])].map(o => C.esc(o.name)).join('、')}
              ・開球時間上游未公布</span></div>` : ''}
          <div class="tiny dim" style="margin-top:8px">只列<b>已排定或已抽籤</b>的未賽場次。${
            C.league() !== 'es1' ? '足總盃英超球隊要到第三輪(一月)才進場,抽籤前這裡不會有足總盃。' : ''}</div>
        </div>`;
    } catch { box.remove(); /* 盃賽資料載不到就不畫,不擋聯賽表 */ }
  }

  const id = C.qs('id');

  // 深連結:?id=<場次> 直接開那一場的速覽
  const deepLink = C.qs('id');
  if (deepLink) { const f = fixtures.find(x => x.id === deepLink); if (f) openMatch(f); }
}
