import * as C from './core.js?v=aec8c394';

const app = document.getElementById('app');

/* 跨聯賽總覽。這一頁的職責只有一個:**讓人一眼看出本站現在有哪些聯賽、
   每個聯賽做到哪一層、缺的是什麼**,然後分流出去。

   三個設計決定,都是這個專案踩過的坑:

   1. **聯賽清單從註冊表長出來,不寫死。** 前一版寫死 `[{pl},{es1}]`,
      加英冠時它不會壞、只會安靜地少一個聯賽 —— 那比壞掉難發現。
   2. **只連得進去的頁才給連結。** 英冠沒有球員頁,給了連結讀者點過去只會撞上
      缺口頁。判斷走 C.closedPage(),不是在這裡再列一次哪個聯賽有哪些頁。
   3. **沒有來源的東西不顯示 0。** 英冠的 counts.players 是 0,印出來像資料壞了;
      要講的是「這個聯賽沒有免費的球員資料源」。0 是一個看起來很像答案的數字。 */

try {
  const LEAGUE_SETS = ['meta', 'teams', 'fixtures', 'news', 'live'];
  const entries = Object.keys(C.LEAGUES);
  const loaded = await Promise.all(entries.map(async lg => {
    const { data, absent } = await C.loadFrom(lg, LEAGUE_SETS);
    return { lg, data, absent };
  }));
  /* 某個聯賽少了必要的資料集就整張卡不畫,不要畫一張半空的 ——
     半空的卡看起來像那個聯賽壞了,而實際上多半是還沒 build。 */
  const leagues = loaded.filter(x => x.data.meta && x.data.fixtures);
  const skipped = loaded.filter(x => !x.data.meta || !x.data.fixtures);

  // 跨聯賽的資料集掛在英超目錄下(它們本來就是跨聯賽的一份)
  const { data: shared } = await C.loadFrom('pl', ['cups', 'ucl', 'ucl-teams', 'competitions']);
  C.registerCompetitions(shared.competitions);   // 有真圖就用真圖,沒有就退回色塊
  C.nav();

  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div>
    <div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  /* 盃賽的比分在 cups-live.json 那份小檔(cups.json 要等下一次部署)。
     這一頁的表是一次算完的,不做輪詢 —— 要看比賽中的變化到盃賽頁,那一頁每 60 秒會自己更新。

     **這裡的 await 也拿掉了**(跟盃賽頁同一個原因):小檔的第一順位是跨網域的 raw,
     連不通時實測 12.9 秒才 fallback,而整頁的第一次繪製都在等它。改成畫完再覆蓋、有變才重畫。 */
  const overlayCupsLive = async () => {
    if (C.applyCupsLive(shared.cups, await C.fetchCupsLive(shared.cups)) > 0) render();
  };
  const cupList = Object.values(shared.cups?.cups ?? {});
  const cupMatches = cupList.reduce((n, c) => n
    + (c.seasons ?? []).reduce((m, s) => m + (s.total ?? 0), 0), 0);
  const uclSeasons = (shared.ucl?.seasons ?? []).filter(s => s.availability === 'available');

  const totalTeams = leagues.reduce((n, x) => n + (x.data.meta.counts?.teams ?? 0), 0);
  const totalPlayed = leagues.reduce((n, x) => n + x.data.fixtures.filter(f => f.played).length, 0);

  /* 這一頁的分頁清單。只列這個聯賽真的開放的頁 —— open 是 null 代表全開(英超)。 */
  const openPages = lg => ['index', 'live', 'teams', 'tactics', 'players', 'news', 'model']
    .filter(p => !C.closedPage(lg, p));
  /* 一律明講聯賽。寫成「pl 就不給」會在站在西甲時被 link() 繼承成 es1(踩過) */
  const pageLink = (page, lg) => C.link(page, { league: lg });

  const leagueCard = ({ lg, data }) => {
    const L = C.LEAGUES[lg];
    const m = data.meta;
    const played = data.fixtures.filter(f => f.played).length;
    /* 「還有幾場」要數未賽的,不能數有開球時間的 —— 上游逐月才公布開球時間,
       西甲 339/380 目前只有日期。這一條在實時戰況頁踩過。 */
    const unplayed = data.fixtures.filter(f => !f.played).length;
    const next = data.fixtures.filter(f => !f.played && f.kickoff)
      .sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1))[0];
    /* 隊名用**這個聯賽自己的**名冊查,不走 C.registerTeams 的全域登錄 ——
       隊碼會跨聯賽重複(Burnley 在英超與英冠都是 BUR),全域登錄是後蓋前,
       三個聯賽一起註冊的話,誰的名字留下來取決於載入順序。
       查不到就顯示隊碼,不猜一個名字。 */
    const nameOf = code => (data.teams ?? []).find(t => t.code === code)?.en ?? code;
    const bt = m.model?.backtest;
    const noPlayers = m.capabilities?.players === false;

    return `<div class="card">
      <div class="spread">
        <div><h2 style="margin:0;display:flex;align-items:center;gap:8px">${C.compBadge(lg, { size: 'lg' })}${C.esc(L.zh)}</h2>
          <div class="tiny dim" style="margin-top:3px">${C.esc(m.currentSeason)}・基準日 ${C.esc(m.asOf)}</div></div>
        <span class="pill accent">${m.counts?.teams ?? '—'} 隊</span>
      </div>
      <div class="grid g3" style="margin:14px 0 10px">
        <div><div class="tiny dim">已賽</div><b class="mono">${played}</b>
          <span class="tiny dim">/ ${data.fixtures.length}</span></div>
        <div><div class="tiny dim">球員</div>${noPlayers
          ? '<span class="tiny dim">沒有來源</span>'
          : `<b class="mono">${m.counts?.players ?? '—'}</b>`}</div>
        <div><div class="tiny dim">動態</div><b class="mono">${m.counts?.news ?? 0}</b></div>
      </div>
      <div class="tiny dim">${next
        ? `下一場:${C.esc(nameOf(next.home))} vs ${C.esc(nameOf(next.away))}・${C.kickoffLocal(next.kickoff)}`
        : (unplayed ? `本季還有 ${unplayed} 場未賽,開球時間上游還沒公布` : '本季已經踢完')}</div>
      ${/* 模型準度直接放在卡片上 —— 那是這個站唯一該被檢驗的東西,
            不該要讀者點進去才看得到。沒有回測就照實說,不給數字。 */''}
      <div class="tiny" style="margin-top:6px">${bt?.available
        ? `走查回測 RPS <b>${bt.rps}</b>・基準線 ${bt.baselineRps}(${bt.games} 場)`
        : '<span class="dim">還沒有走查回測,所以不給準度數字</span>'}</div>
      ${noPlayers ? `<div class="tiny dim" style="margin-top:6px">
        ${C.esc(m.players?.note ?? '這個聯賽沒有球員級的資料源。')}</div>` : ''}
      <div class="tags" style="margin-top:12px">
        ${openPages(lg).map((p, i) => `<a class="pill ${i === 0 ? 'info' : ''}"
          href="${pageLink(p, lg)}">${C.esc(C.pageLabel(p, lg))}</a>`).join('')}
      </div></div>`;
  };

  /* 即將到來(未來 7 天,全部聯賽 + 盃賽,使用者要求)。
     用「天數窗」不用固定筆數 —— 固定筆數會把一輪切一半(實時戰況頁踩過那條坑)。
     兩個誠實邊界:
     - 盃賽只列**本站聯賽名冊裡的球隊**參與的場次。足總盃現在是資格賽,
       一輪有幾百場第七八九級球隊的比賽,全列進來總覽就不是總覽了。
     - 抽籤後上游常給「日期+00:00Z」占位,照印會變成「台北 08:00」的假時間 ——
       標成「時間待定」(跟球隊賽程頁同一個規則)。 */
  // 即將賽程不列的聯賽(使用者指定)。用集合不用「是不是某一個」的二元式
  const UPCOMING_HIDE = new Set(['en2']);
  const upcoming = (() => {
    const now = Date.now(), end = now + 7 * 86400000;
    const inWindow = k => { const t = Date.parse(k); return t >= now - 2 * 3600000 && t <= end; };
    const rows = [];
    for (const { lg, data } of leagues) {
      /* 使用者要求:總覽的即將賽程不列英冠(一輪 12 場會蓋過主要聯賽)。
         只影響這張表 —— 盃賽裡英冠球隊的場次照列,英冠自己的頁面不受影響。 */
      if (UPCOMING_HIDE.has(lg)) continue;
      /* 隊徽從**這個聯賽自己的**名冊拿,不走全域登錄 —— 隊碼跨聯賽會重複
         (Burnley 在英超與英冠都是 BUR),全域登錄是後蓋前。 */
      const tBy = new Map((data.teams ?? []).map(t => [t.code, t]));
      /* 已開賽的顯示比數(使用者要求,2026-09-07):從這個聯賽的即時快照(live.json)對主客鍵。
         重播模式是別季的比賽,不對;沒有快照就維持「已開賽・等待資料」—— 不拿賽前預測冒充比分。 */
      const lv = data.live;
      const liveBy = new Map((lv?.available && !lv.demo ? lv.matches ?? [] : []).map(m => [`${m.home}|${m.away}`, m]));
      for (const f of data.fixtures) {
        if (f.played || !f.kickoff || !inWindow(f.kickoff)) continue;
        const h = tBy.get(f.home), a = tBy.get(f.away);
        const m = liveBy.get(`${f.home}|${f.away}`);
        const live = m && (m.started || m.finished)
          ? { hs: m.hs ?? null, as: m.as ?? null, finished: m.finished === true,
              minute: m.finished ? null : C.liveMinute(m, lv.fetchedAt).disp }
          : null;
        rows.push({ kick: f.kickoff, comp: C.LEAGUES[lg].zh, compKey: lg,
          home: h?.en ?? f.home, away: a?.en ?? f.away,
          hCrest: h?.crest ?? null, aCrest: a?.crest ?? null,
          note: `第 ${f.round} 輪`, pending: false, live,
          link: C.link('analysis', { id: f.id, league: lg }) });
      }
    }
    const known = new Set(leagues.flatMap(({ data }) =>
      (data.teams ?? []).flatMap(t => [t.en, t.of].filter(Boolean).map(x => x.toLowerCase()))));
    const covered = s => s && (s.code || known.has(String(s.name ?? '').toLowerCase()));
    const cupCrests = shared.cups?.crests ?? {};
    for (const cup of cupList) {
      const season = (cup.seasons ?? []).find(s => s.current);
      for (const r of season?.rounds ?? []) for (const m of r.matches ?? []) {
        if (m.played || !m.kickoff || !inWindow(m.kickoff)) continue;
        if (!covered(m.home) && !covered(m.away)) continue;
        /* 盃賽沒有獨立的 live.json:比分就在 cups.json 的場次上(state LIVE + liveScore),
           比賽日迴圈每 3 分鐘更新一次。分鐘數上游沒給,所以只寫「進行中」不編一個分鐘。 */
        const live = m.state === 'LIVE' && Array.isArray(m.liveScore)
          ? { hs: m.liveScore[0], as: m.liveScore[1], finished: false, minute: null } : null;
        rows.push({ kick: m.kickoff, comp: cup.zh ?? cup.en, compKey: cup.key, home: m.home?.name ?? '?', away: m.away?.name ?? '?',
          hCrest: cupCrests[m.home?.sourceId] ?? null, aCrest: cupCrests[m.away?.sourceId] ?? null,
          note: m.stage ?? '', pending: m.kickoff.endsWith('T00:00:00Z'), live, link: C.link('cups', { cup: cup.key }) });
      }
    }
    /* 歐冠聯賽階段。資料早就在 ucl.json 裡(開球時間齊全、有 matchday),
       這張表以前只列英格蘭盃賽 —— 歐冠週的比賽在總覽上看不到。
       跟盃賽同一條規則:只列本站認得至少一邊的場次。對手的隊徽走 ucl-teams 的 external 查表
       (有圖不等於有球隊頁,所以一樣沒有連結)。 */
    const uclSeason = (shared.ucl?.seasons ?? []).find(s => s.current);
    const uclKnown = new Map((shared['ucl-teams']?.teams ?? []).map(t => [t.code, t]));
    const uclExternal = new Map((shared['ucl-teams']?.external ?? []).map(t => [t.id, t.crest]));
    const uclCrest = side => (side?.code ? uclKnown.get(side.code)?.crest : uclExternal.get(side?.id)) ?? null;
    for (const m of uclSeason?.leagueMatches ?? []) {
      if (m.played || !m.kickoff || !inWindow(m.kickoff)) continue;
      if (!m.home?.code && !m.away?.code) continue;
      rows.push({ kick: m.kickoff, comp: '歐冠', compKey: 'ucl',
        home: m.home?.name ?? '?', away: m.away?.name ?? '?',
        hCrest: uclCrest(m.home), aCrest: uclCrest(m.away),
        note: m.matchday ? `聯賽階段第 ${m.matchday} 輪` : (m.stage ?? ''), pending: false, link: C.link('cups', { cup: 'ucl' }) });
    }
    return rows.sort((a, b) => (a.kick < b.kick ? -1 : 1));
  })();

  /* 窗外的下一批盃賽:7 天內沒有盃賽時,讀者會以為盃賽沒接上 ——
     所以窗外的用一行摘要講(跟實時戰況頁倒數區的溢位摘要同一個做法)。 */
  const cupBeyond = (() => {
    const now = Date.now(), end = now + 7 * 86400000;
    const known = new Set(leagues.flatMap(({ data }) =>
      (data.teams ?? []).flatMap(t => [t.en, t.of].filter(Boolean).map(x => x.toLowerCase()))));
    const covered = s => s && (s.code || known.has(String(s.name ?? '').toLowerCase()));
    const out = cupList.map(cup => {
      const season = (cup.seasons ?? []).find(s => s.current);
      const future = (season?.rounds ?? []).flatMap(r => (r.matches ?? [])
        .filter(m => !m.played && m.kickoff && Date.parse(m.kickoff) > end
          && (covered(m.home) || covered(m.away)))
        .map(m => ({ kick: m.kickoff, stage: m.stage })));
      if (!future.length) return null;
      const first = future.sort((a, b) => (a.kick < b.kick ? -1 : 1))[0];
      return `${cup.zh ?? cup.en} ${first.stage ?? ''}:${C.dateFull(first.kick.slice(0, 10))} 起(${future.length} 場)`;
    }).filter(Boolean);
    // 歐冠也一樣:7 天內沒有歐冠時,用一行講下一批是聯賽階段第幾輪、幾號起
    const uclSeason = (shared.ucl?.seasons ?? []).find(s => s.current);
    const uclFuture = (uclSeason?.leagueMatches ?? [])
      .filter(m => !m.played && m.kickoff && Date.parse(m.kickoff) > end && (m.home?.code || m.away?.code))
      .sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));
    if (uclFuture.length) {
      const f = uclFuture[0];
      out.push(`歐冠 聯賽階段第 ${f.matchday ?? '?'} 輪:${C.dateFull(f.kickoff.slice(0, 10))} 起(本站球隊 ${uclFuture.length} 場)`);
    }
    return out;
  })();

  const upcomingBlock = `
  <div class="section"><h2>即將到來</h2><span class="hint">未來 7 天・${leagues.filter(x => !UPCOMING_HIDE.has(x.lg)).map(x => C.LEAGUES[x.lg].zh).join('、')} + 歐冠、盃賽</span></div>
  ${upcoming.length ? `<div class="card">${C.table(upcoming, [
    { key: 'kick', label: '開球(台北)', value: u => u.kick,
      render: u => (u.pending
        ? `<span class="small">${C.dateFull(u.kick.slice(0, 10))} <span class="dim">・時間待定</span></span>`
        : `<span class="small">${C.kickoffLocal(u.kick)}</span>`) },
    { key: 'cd', label: '倒數', value: u => u.kick, sortable: false,
      render: u => {
        if (u.pending) return '<span class="dim small">—</span>';
        if (!u.live) return `<span class="small">${C.countdown(u.kick)}</span>`;
        // 已開賽:比數 + 分鐘(有即時快照才會有;分鐘從快照時間往前推,跟實時戰況頁同一個 liveMinute)
        const sc = u.live.hs != null && u.live.as != null ? `<b class="mono" style="font-size:14px">${u.live.hs} : ${u.live.as}</b>` : '';
        return u.live.finished
          ? `<span class="small" style="display:inline-flex;align-items:center;gap:6px"><span class="pill tiny">完場</span>${sc}</span>`
          : `<span class="small" style="display:inline-flex;align-items:center;gap:6px"><span class="pill bad tiny"><span class="livedot"></span>${
              u.live.minute != null ? `第 ${u.live.minute} 分鐘` : '進行中'}</span>${sc}</span>`;
      } },
    // 靠左:內容是「圖 + 字」的 flex 排版,跟對戰欄同一邊(使用者要求,2026-09-07)
    { key: 'comp', label: '賽事', value: u => u.comp, left: true, render: u => C.compBadge(u.compKey, { label: u.comp }) },
    { key: 'match', label: '對戰', value: u => u.home, left: true,
      render: u => {
        const img = c => (c ? `<img class="crest" src="${c}" loading="lazy" width="20" height="20" style="vertical-align:middle">` : '');
        const body = `<span style="display:inline-flex;align-items:center;gap:6px">${img(u.hCrest)}<span>${C.esc(u.home)}</span>
          <span class="dim">vs</span> <span>${C.esc(u.away)}</span>${img(u.aCrest)}</span>`;
        return u.link ? `<a href="${u.link}" style="color:inherit;text-decoration:none">${body}</a>` : body;
      } },
    { key: 'note', label: '輪次', value: u => u.note, sortable: false,
      render: u => `<span class="tiny dim">${C.esc(u.note)}</span>` },
  ], { sortKey: 'kick', desc: false,
    /* 整列可點,不用瞄準文字連結(使用者要求)。盃賽與歐冠場次沒有獨立的分析頁,
       開的是盃賽頁的對應分頁 —— 歐冠的賽前對比、勝率與賽後報告都在那裡展開(「東西在但沒有入口」那條坑)。 */
    onRow: u => { if (u.link) location.href = u.link; } })}
  <div class="tiny dim" style="margin-top:8px">${cupBeyond.length ? `7 天之後的盃賽:${cupBeyond.map(C.esc).join(';')}。` : ''}
    聯賽場次點對戰直接進賽前分析;歐冠與盃賽場次開盃賽頁的對應分頁(歐冠的賽前對比、勝率與賽後報告在那裡展開)。
    只列已公布日期的場次;盃賽只列本站聯賽名冊裡的球隊,足總盃的低級別資格賽不在此列。</div></div>`
  : `<div class="note">未來 7 天沒有已排定的比賽(或開球時間上游還沒公布)。
    ${cupBeyond.length ? `之後的盃賽:${cupBeyond.map(C.esc).join(';')}。` : ''}</div>`}`;

  /* 最新動態:每個聯賽各取前幾則再依日期合併。
     只取一部分是因為這是總覽 —— 完整的在各聯賽的動態頁。 */
  const news = leagues.flatMap(({ lg, data }) => (data.news ?? []).slice(0, 4)
    .map(n => ({ ...n, leagueZh: C.LEAGUES[lg].zh })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8);

  const sources = leagues.flatMap(x => x.data.meta.sources ?? [])
    .filter((s, i, all) => all.findIndex(y => y.url === s.url) === i)
    .map(s => `<a href="${C.esc(s.url)}" target="_blank" rel="noopener">${C.esc(s.name)}</a>`)
    .join('、');

  const render = () => {
  app.innerHTML = `
  <div class="page-head">
    <h1>總覽</h1>
    <p>本站目前有 ${leagues.length} 個聯賽,加上跨聯賽的歐冠、英格蘭盃賽與足球知識。
       每個聯賽的模型各自訓練、各自回測,不互相借數字;做不到的那一層在下面各張卡上直說。</p>
    ${C.stampRow([
      C.stamp('聯賽資料', { iso: leagues[0]?.data.meta.builtAt, kind: 'daily', note: '每次 build 重算' }),
      shared.cups ? C.stamp('盃賽資料', { iso: shared.cups.retrievedAt, kind: 'manual', note: shared.cups.source }) : null,
    ])}
  </div>

  <div class="grid g4">
    ${kpi('聯賽', leagues.length, leagues.map(x => C.LEAGUES[x.lg].zh).join('、'))}
    ${kpi('球隊', totalTeams, '本季各聯賽合計')}
    ${kpi('已完賽', totalPlayed, '本季各聯賽合計')}
    ${kpi('盃賽', cupList.length, cupList.map(c => C.esc(c.zh ?? c.en)).join('、') || '尚未接入')}
  </div>

  ${upcomingBlock}

  <div class="section"><h2>各聯賽</h2><span class="hint">點分頁直接進去・只列這個聯賽真的做得出來的頁</span></div>
  <div class="grid g2">${leagues.map(leagueCard).join('')}</div>
  ${skipped.length ? `<div class="note" style="margin-top:10px">
    ${skipped.map(x => C.esc(C.LEAGUES[x.lg]?.zh ?? x.lg)).join('、')} 的資料集還沒建置,
    這一輪先不畫 —— 少了 ${C.esc(skipped[0].absent.join('、'))}。</div>` : ''}

  <div class="section"><h2>跨聯賽</h2><span class="hint">這幾頁不分聯賽,兩邊看到的是同一份資料</span></div>
  <div class="grid g3">
    <div class="card"><div class="spread"><h3 style="margin:0;display:flex;align-items:center;gap:7px">${C.compBadge('ucl')}歐冠</h3>
      <a class="pill accent" href="${C.link('cups', { cup: 'ucl' })}">開啟 →</a></div>
      <div class="tiny dim" style="margin-top:8px">${uclSeasons.length
        ? `${uclSeasons.map(s => C.esc(s.label)).join('、')} 完整・每季 36 隊`
        : '目前沒有可用的完整賽季'}</div>
      <div class="tiny dim" style="margin-top:6px">沒有勝率預測 —— 現有模型是用聯賽比賽調的,
        歐冠有跨聯賽實力比較、兩回合制、延長與 PK 四件它沒見過的事。</div></div>

    <div class="card"><div class="spread"><h3 style="margin:0;display:flex;align-items:center;gap:7px">${C.compBadge('facup')}${C.compBadge('eflcup')}英格蘭盃賽</h3>
      <a class="pill accent" href="${C.link('cups', { cup: 'facup' })}">開啟 →</a></div>
      <div class="tiny dim" style="margin-top:8px">${cupList.length
        ? `${cupList.map(c => C.esc(c.zh ?? c.en)).join('、')}・共 ${cupMatches} 場`
        : '尚未接入'}</div>
      <div class="tiny dim" style="margin-top:6px">比分分三層顯示:90 分鐘、延長後、PK ——
        只印最終比分會把「1-1 PK 5-4」講成 1-1。</div></div>

    <div class="card"><div class="spread"><h3 style="margin:0">足球知識</h3>
      <a class="pill accent" href="${C.link('knowledge')}">開啟 →</a></div>
      <div class="tiny dim" style="margin-top:8px">陣型、背號與位置分工。</div>
      <div class="tiny dim" style="margin-top:6px">共識層與本站算出來的實際分佈<b>分開標示</b> ——
        哪一段是足球常識、哪一段是這個站的數字,不混在一起。</div></div>
  </div>

  <div class="section"><h2>最新動態</h2><span class="hint">各聯賽合併・完整清單在各自的動態頁</span></div>
  <div class="card">${news.length
    ? news.map(n => `<div class="stat-line">
        <span class="small"><span class="pill tiny">${C.esc(n.leagueZh)}</span>
          ${n.link ? `<a href="${C.esc(n.link)}" target="_blank" rel="noopener">${C.esc(n.title)}</a>`
            : `<b>${C.esc(n.title)}</b>`}</span>
        <span class="tiny dim">${C.dateFull(n.date)}</span></div>`).join('')
    : '<div class="dim small">目前沒有動態資料。</div>'}</div>

  <footer class="foot wrap">資料來源:${sources || '見各頁'}。
    預測僅供分析參考,不構成任何投注建議。</footer>`;
  C.startCountdowns();   // 「即將到來」的倒數要會走,不然停在載入當下慢慢變錯
  };

  render();
  overlayCupsLive();     // 畫完才去拿盃賽的即時比分,有變才重畫
} catch (err) { C.fail(err); }
