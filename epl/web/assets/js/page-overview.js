import * as C from './core.js?v=016fe78a';

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
  const LEAGUE_SETS = ['meta', 'teams', 'fixtures', 'news'];
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
  const { data: shared } = await C.loadFrom('pl', ['cups', 'ucl']);
  C.nav();

  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div>
    <div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  const cupList = Object.values(shared.cups?.cups ?? {});
  const cupMatches = cupList.reduce((n, c) => n
    + (c.seasons ?? []).reduce((m, s) => m + (s.total ?? 0), 0), 0);
  const uclSeasons = (shared.ucl?.seasons ?? []).filter(s => s.availability === 'available');

  const totalTeams = leagues.reduce((n, x) => n + (x.data.meta.counts?.teams ?? 0), 0);
  const totalPlayed = leagues.reduce((n, x) => n + x.data.fixtures.filter(f => f.played).length, 0);

  /* 這一頁的分頁清單。只列這個聯賽真的開放的頁 —— open 是 null 代表全開(英超)。 */
  const openPages = lg => ['index', 'live', 'teams', 'tactics', 'players', 'news', 'model']
    .filter(p => !C.closedPage(lg, p));
  const pageLink = (page, lg) => (lg === 'pl' ? C.link(page) : C.link(page, { league: lg }));

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
        <div><h2 style="margin:0">${C.esc(L.zh)}</h2>
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
  const upcoming = (() => {
    const now = Date.now(), end = now + 7 * 86400000;
    const inWindow = k => { const t = Date.parse(k); return t >= now - 2 * 3600000 && t <= end; };
    const rows = [];
    for (const { lg, data } of leagues) {
      const nameOf = code => (data.teams ?? []).find(t => t.code === code)?.en ?? code;
      for (const f of data.fixtures) {
        if (f.played || !f.kickoff || !inWindow(f.kickoff)) continue;
        rows.push({ kick: f.kickoff, comp: C.LEAGUES[lg].zh, home: nameOf(f.home), away: nameOf(f.away),
          note: `第 ${f.round} 輪`, pending: false,
          link: C.link('analysis', { id: f.id, league: lg === 'pl' ? null : lg }) });
      }
    }
    const known = new Set(leagues.flatMap(({ data }) =>
      (data.teams ?? []).flatMap(t => [t.en, t.of].filter(Boolean).map(x => x.toLowerCase()))));
    const covered = s => s && (s.code || known.has(String(s.name ?? '').toLowerCase()));
    for (const cup of cupList) {
      const season = (cup.seasons ?? []).find(s => s.current);
      for (const r of season?.rounds ?? []) for (const m of r.matches ?? []) {
        if (m.played || !m.kickoff || !inWindow(m.kickoff)) continue;
        if (!covered(m.home) && !covered(m.away)) continue;
        rows.push({ kick: m.kickoff, comp: cup.zh ?? cup.en, home: m.home?.name ?? '?', away: m.away?.name ?? '?',
          note: m.stage ?? '', pending: m.kickoff.endsWith('T00:00:00Z'), link: null });
      }
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
    return cupList.map(cup => {
      const season = (cup.seasons ?? []).find(s => s.current);
      const future = (season?.rounds ?? []).flatMap(r => (r.matches ?? [])
        .filter(m => !m.played && m.kickoff && Date.parse(m.kickoff) > end
          && (covered(m.home) || covered(m.away)))
        .map(m => ({ kick: m.kickoff, stage: m.stage })));
      if (!future.length) return null;
      const first = future.sort((a, b) => (a.kick < b.kick ? -1 : 1))[0];
      return `${cup.zh ?? cup.en} ${first.stage ?? ''}:${C.dateFull(first.kick.slice(0, 10))} 起(${future.length} 場)`;
    }).filter(Boolean);
  })();

  const upcomingBlock = `
  <div class="section"><h2>即將到來</h2><span class="hint">未來 7 天・${leagues.map(x => C.LEAGUES[x.lg].zh).join('、')} + 盃賽</span></div>
  ${upcoming.length ? `<div class="card">${C.table(upcoming, [
    { key: 'kick', label: '開球(台北)', value: u => u.kick,
      render: u => (u.pending
        ? `<span class="small">${C.dateFull(u.kick.slice(0, 10))} <span class="dim">・時間待定</span></span>`
        : `<span class="small">${C.kickoffLocal(u.kick)}</span>`) },
    { key: 'cd', label: '倒數', value: u => u.kick, sortable: false,
      render: u => (u.pending ? '<span class="dim small">—</span>' : `<span class="small">${C.countdown(u.kick)}</span>`) },
    { key: 'comp', label: '賽事', value: u => u.comp, render: u => `<span class="pill tiny">${C.esc(u.comp)}</span>` },
    { key: 'match', label: '對戰', value: u => u.home, left: true,
      render: u => (u.link
        ? `<a href="${u.link}" style="color:inherit">${C.esc(u.home)} <span class="dim">vs</span> ${C.esc(u.away)}</a>`
        : `${C.esc(u.home)} <span class="dim">vs</span> ${C.esc(u.away)}`) },
    { key: 'note', label: '輪次', value: u => u.note, sortable: false,
      render: u => `<span class="tiny dim">${C.esc(u.note)}</span>` },
  ], { sortKey: 'kick', desc: false })}
  <div class="tiny dim" style="margin-top:8px">${cupBeyond.length ? `7 天之後的盃賽:${cupBeyond.map(C.esc).join(';')}。` : ''}
    聯賽場次點對戰直接進賽前分析;盃賽場次沒有分析頁(模型是聯賽調的)。
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
    <div class="card"><div class="spread"><h3 style="margin:0">歐冠</h3>
      <a class="pill accent" href="${C.link('cups', { cup: 'ucl' })}">開啟 →</a></div>
      <div class="tiny dim" style="margin-top:8px">${uclSeasons.length
        ? `${uclSeasons.map(s => C.esc(s.label)).join('、')} 完整・每季 36 隊`
        : '目前沒有可用的完整賽季'}</div>
      <div class="tiny dim" style="margin-top:6px">沒有勝率預測 —— 現有模型是用聯賽比賽調的,
        歐冠有跨聯賽實力比較、兩回合制、延長與 PK 四件它沒見過的事。</div></div>

    <div class="card"><div class="spread"><h3 style="margin:0">英格蘭盃賽</h3>
      <a class="pill accent" href="${C.link('cups', { cup: 'facup' })}">開啟 →</a></div>
      <div class="tiny dim" style="margin-top:8px">${cupList.length
        ? `${cupList.map(c => C.esc(c.zh ?? c.en)).join('、')}・共 ${cupMatches} 場`
        : '尚未接入'}</div>
      <div class="tiny dim" style="margin-top:6px">比分分三層顯示:90 分鐘、延長後、PK ——
        只印最終比分會把「1-1 PK 5-4」講成 1-1。</div></div>

    <div class="card"><div class="spread"><h3 style="margin:0">足球知識</h3>
      <a class="pill accent" href="${C.link('knowledge')}">開啟 →</a></div>
      <div class="tiny dim" style="margin-top:8px">陣型、背號與位置分工。</div>
      <div class="tiny dim" style="margin-top:6px">共識層與本站算出來的實際分佈**分開標示** ——
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
} catch (err) { C.fail(err); }
