import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, fixtures, h2h, players, tactics, analysis, lineups, live, shapes, official } =
    await C.load('meta', 'clubs', 'teams', 'fixtures', 'h2h', 'players', 'tactics', 'analysis', 'lineups', 'live', 'shapes', 'official');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const teamBy = new Map(teams.map(t => [t.code, t]));
  const tacBy = new Map(tactics.map(t => [t.code, t]));
  const articleFor = f => analysis.pre[`${f.home}|${f.away}`] ?? null;
  // 這幾個會在 renderMatch 裡用到,必須在呼叫點之前就初始化好 —— 放在下面的
  // 函式區只會撞上 TDZ(函式宣告會提升,const 不會)
  const photoByCode = new Map(players.map(x => [x.code, x.photo ?? null]));
  const photoOf = code => photoByCode.get(code) ?? null;

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

    <div class="section"><h2>兩套模型怎麼看${f.market ? '・市場怎麼看' : ''}</h2>
      <span class="hint">分歧本身就是資訊</span></div>
    <div class="card">
      <div class="stat-line"><span class="small">Dixon-Coles Poisson(看進失球的量)</span>
        <span class="mono small">${C.pct(p.poisson.home, 0)} / ${C.pct(p.poisson.draw, 0)} / ${C.pct(p.poisson.away, 0)}</span></div>
      <div class="stat-line"><span class="small">Elo 實力評分(看贏球的結果)</span>
        <span class="mono small">${C.pct(p.elo.home, 0)} / ${C.pct(p.elo.draw, 0)} / ${C.pct(p.elo.away, 0)}</span></div>
      <div class="stat-line"><span class="small"><b>取平均(本站採用)</b></span>
        <span class="mono small"><b>${C.pct(p.home, 0)} / ${C.pct(p.draw, 0)} / ${C.pct(p.away, 0)}</b></span></div>
      ${f.market ? `<div class="stat-line" style="border-top:1px solid var(--line);margin-top:6px;padding-top:8px">
        <span class="small" style="color:var(--draw)"><b>博彩市場</b>(${f.market.source}・去水錢後)</span>
        <span class="mono small" style="color:var(--draw)"><b>${C.pct(f.market.probs.home, 0)} / ${C.pct(f.market.probs.draw, 0)} / ${C.pct(f.market.probs.away, 0)}</b></span></div>` : ''}
      <div class="tiny dim" style="margin-top:8px">
        為什麼取平均:${meta.model.backtest.available
          ? `回測 ${meta.model.backtest.games} 場,平均後的 RPS ${meta.model.backtest.rps} 比單獨使用任一個都低。`
          : '回測顯示兩者平均最穩。'}
        <a href="${C.link('model')}">看完整驗證 →</a></div>
    </div>
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

    ${lineupSection(f)}

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

    const board = (code, list, shape, thisFormation, officialRows) => {
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
        ${C.pitch(list, { photos: true, color: C.team(code).colors?.[0] ?? '#00ff85', officialRows })}
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
      ${board(f.home, withPhoto(xi.home), shapeOf(f.home, 'home'), fmOf('home'), rowsOf('home', withPhoto(xi.home)))}
      ${board(f.away, withPhoto(xi.away), shapeOf(f.away, 'away'), fmOf('away'), rowsOf('away', withPhoto(xi.away)))}
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

    <div class="section"><h2>兩隊陣容對照</h2>
      <span class="hint">依球員角色分帶並排,看得出兩隊把人放在哪裡</span></div>
    <div class="card">${compareRows(f, withPhoto(xi.home), withPhoto(xi.away))}</div>
    <div class="note" style="margin-top:10px">
      <b>這裡是依「球員是什麼角色」分帶,不是照球場上的排。</b>
      兩隊陣型不同時(例如 4-2-3-1 對 3-4-2-1),排數與每排人數本來就對不齊,
      硬要並排會變成拿蘋果比橘子;角色分帶才有共同的軸可以比。
      所以<b>翼衛算在後防</b>(他本來就是後衛),即使他在上面的球場圖裡站在中場那一排。
      要看實際站位請看上面的球場圖。
    </div>`;
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

  // 兩隊各站一列,依 GK/DEF/MID/FWD 分段對照
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
    const maxGap = Math.abs(biggest[2]);
    // 三個結果的總偏差,拿來判斷「基本一致」還是「明顯分歧」
    const total = gaps.reduce((a, g) => a + Math.abs(g[2]), 0) / 2;
    const level = total < 0.05 ? 'agree' : total < 0.12 ? 'mild' : 'strong';
    const backtest = meta.model.backtest;
    const mk = backtest.market;
    return `<div class="note ${level === 'strong' ? 'warn' : ''}" style="margin-top:10px">
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

  function compareRows(f, home, away) {
    // 依角色分帶,不是 FPL 的四粗類 —— 粗類會讓 4-2-3-1 和 3-4-2-1 都顯示成「中場 5v4」,
    // 看不出兩隊的差別在哪。角色分帶才分得出「防中 2v1、前場 3v2」這種真正的對比。
    const BAND = { GK: 'GK', CB: 'DEF', FB: 'DEF', DM: 'MID', CM: 'MID', AM: 'ATT', W: 'ATT', ST: 'FWD' };
    const LINE = [['GK', '門將'], ['DEF', '後防'], ['MID', '中場'], ['ATT', '前場'], ['FWD', '鋒線']];
    const roleOf = code => players.find(x => x.code === code)?.role ?? null;
    // 名單本身帶的 role 優先(預估名單排位時就分好了),沒有才回球員庫查
    const bandOf = p => BAND[p.role ?? roleOf(p.code)?.key] ?? (p.pos === 'GK' ? 'GK' : p.pos === 'DEF' ? 'DEF' : p.pos === 'FWD' ? 'FWD' : 'MID');
    const cell = (p, code) => {
      const r = p.roleZh ? { zh: p.roleZh, key: p.role } : roleOf(p.code);
      return `<span class="lu-p" title="${C.esc(p.name)}${r ? `・${r.zh}` : ''}">
        ${C.playerPhoto({ ...p, team: code }, 26)}<span class="nm">${C.esc(p.name)}${p.doubt ? ' ⚠' : ''}
        ${r && !r.lowSample ? `<span class="dim tiny"> ${r.zh}</span>` : ''}</span></span>`;
    };
    return LINE.map(([band, zh]) => {
      const h = home.filter(x => bandOf(x) === band), a = away.filter(x => bandOf(x) === band);
      if (!h.length && !a.length) return '';
      return `<div class="lu-line">
        <div class="lu-side">${h.map(p => cell(p, f.home)).join('')}</div>
        <div class="lu-pos">${zh}<span class="dim tiny"> ${h.length}v${a.length}</span></div>
        <div class="lu-side right">${a.map(p => cell(p, f.away)).join('')}</div>
      </div>`;
    }).join('');
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
