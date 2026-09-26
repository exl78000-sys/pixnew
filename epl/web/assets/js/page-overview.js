import * as C from './core.js?v=15d4daad';

const app = document.getElementById('app');

/* 跨聯賽總覽。這一頁的職責只有一個:**讓人一眼看出本站現在有哪些聯賽、
   每個聯賽做到哪一層、缺的是什麼**,然後分流出去。

   三個設計決定,都是這個專案踩過的坑:

   1. **聯賽清單從註冊表長出來,不寫死。** 前一版寫死 `[{pl},{es1}]`,
      加英冠時它不會壞、只會安靜地少一個聯賽 —— 那比壞掉難發現。
   2. **只連得進去的頁才給連結。** 連結一律照 LEAGUES[lg].open 算,寫死的話點過去只會撞上
      缺口頁。判斷走 C.closedPage(),不是在這裡再列一次哪個聯賽有哪些頁。
   3. **沒有來源的東西不顯示 0。** 一個聯賽的 counts.players 是 0 時,印出來像資料壞了;
      要講的是「這個聯賽沒有免費的球員資料源」。0 是一個看起來很像答案的數字。
      (英冠 2026-09-15 起有球員層 —— 這一段照 capabilities 走,所以它自己會變。) */

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
  /* 歐冠的勝率與國家隊各自讀,**讀不到就當沒有**:這兩份不是這一頁的主體,少一份不該讓整個總覽載入失敗
     (英超目錄的 404 在 loadFrom 裡是直接拋錯的)。 */
  const uclElo = (await C.loadFrom('pl', ['ucl-elo']).catch(() => ({ data: {} }))).data['ucl-elo'] ?? null;
  const intl = (await C.loadFrom('pl', ['intl']).catch(() => ({ data: {} }))).data.intl ?? null;
  /* 盃賽的球隊身分(隊徽/隊名)。**跨聯賽的一頁不能靠目前聯賽的名冊** ——
     而這一頁連目前聯賽的名冊都不是問題:cups.json 的 crests 查表**刻意只收本站沒有隊碼的球隊**,
     所以有隊碼的那些(英超 + 英冠 27 支)在這張「即將到來」的表上**一張隊徽都沒有**,
     旁邊第九級的球隊反而有 —— 而歐冠那幾列早就做對了(uclCrest 會先看 code)。
     核心說明在 core.js 的 cupClubs。 */
  const cupIdent = { clubs: await C.cupClubs(), crests: shared.cups?.crests ?? {} };
  C.registerCompetitions(shared.competitions);   // 有真圖就用真圖,沒有就退回色塊
  C.nav();

  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div>
    <div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  /* 盃賽的比分在 cups-live.json 那份小檔(cups.json 要等下一次部署)。

     **這裡的 await 也拿掉了**(跟盃賽頁同一個原因):小檔的第一順位是跨網域的 raw,
     連不通時實測 12.9 秒才 fallback,而整頁的第一次繪製都在等它。改成畫完再覆蓋、有變才重畫。
     「即將到來」那張表要在 render() 裡重算(upcomingHtml),覆蓋才進得了畫面 ——
     第一版把表算成一個字串常數,覆蓋後 render() 畫的還是舊字串,盃賽的即時比分在這一頁從來沒出現過。 */
  const overlayCupsLive = async () => {
    if (C.applyCupsLive(shared.cups, await C.fetchCupsLive(shared.cups)) > 0) render();
  };
  /* 聯賽的即時比分(2026-09-12,使用者回報「重新整理後比分退回去」):
     data.live 是 Pages 上那份 —— 部署當下的快照,離部署越久越舊。畫完立刻去拿 raw 那份,
     比較新才收(只進不退:raw CDN 會新舊副本交替回應),有變才重畫。
     **只抓讀者勾著的聯賽**(沒勾的不在這張表上);之後才勾的,由勾選那一步補抓(overlaid 記誰拿過了)——
     不補的話,新勾的那個聯賽印的是部署快照的比分,而且沒有任何地方講它是舊的。 */
  const overlaid = new Set();
  const overlayLeagueLive = async (list = leagues.filter(x => shownNow().has(x.lg))) => {
    let changed = 0;
    const t = s => Date.parse(s ?? '') || 0;
    await Promise.all(list.map(async ({ lg, data }) => {
      overlaid.add(lg);
      const fresh = await C.fetchFeed(C.liveFeeds(data.meta, lg));
      if (!fresh?.fetchedAt || t(fresh.fetchedAt) <= t(data.live?.fetchedAt)) return;
      data.live = fresh; changed++;
    }));
    if (changed) render();
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
  /* 勾選清單(2026-09-26,使用者:「總攬可以勾選要看到即將到來的賽事類別 例如 英超 歐冠」)。

     **從資料長出來,不手寫**:聯賽照註冊表(載得到的那些)、歐冠與盃賽要**有本季**才列 ——
     足總盃 2026-27 上游還沒發布,給它一格的話是「按鈕在但點了沒東西」;它發布的那天這一格自己出現。

     英冠**預設不勾**:那是使用者先前的決定(「總覽的即將賽程不列英冠」,一輪 12 場會蓋過主要聯賽)。
     以前是寫死的排除、讀者沒有辦法看到;現在是預設,想看的人勾起來就有。
     用集合不用「是不是某一個」的二元式。 */
  const UPCOMING_DEFAULT_OFF = new Set(['en2']);
  /* 國家隊(2026-09-26,使用者:「國家隊也加進勾選」)。一格一個**賽事家族**(歐國聯 / 中北美國聯 /
     非洲盃資格賽 / 海灣盃 / 友誼賽)—— 跟國家隊頁的篩選同一套分法;前面一格「國家隊」一次勾整組,
     它勾不勾是從家族算出來的,不另外存。
     **預設不勾**:國際賽週一週一百多場(9/26 起 7 天 160 場),預設勾著的話總覽就變成國家隊的賽程表 ——
     這張表原本沒有國家隊,讀者勾了才有。有未賽場次的家族才列(海灣盃踢完之後給它一格是「按鈕在但點了沒東西」)。 */
  const intlComps = new Map((intl?.comps ?? []).map(c => [c.key, c]));
  const intlFamOf = key => intlComps.get(key)?.family ?? null;
  const intlOpen = f => f.state !== 'CANCELLED' && !!f.kickoff;
  const intlFams = (intl?.families ?? []).filter(fam => (intl.fixtures ?? []).some(f => intlOpen(f)
    && intlFamOf(f.comp) === fam.key && Date.parse(f.kickoff) >= Date.now() - 2 * 3600000));
  const upcomingComps = [
    ...leagues.map(({ lg }) => ({ key: lg, label: C.LEAGUES[lg].zh, on: !UPCOMING_DEFAULT_OFF.has(lg) })),
    ...((shared.ucl?.seasons ?? []).some(s => s.current) ? [{ key: 'ucl', label: '歐冠', on: true }] : []),
    ...cupList.filter(c => (c.seasons ?? []).some(s => s.current))
      .map(c => ({ key: c.key, label: c.zh ?? c.en, on: true })),
    ...intlFams.map(fam => ({ key: `intl:${fam.key}`, label: fam.zh, text: `國家隊・${fam.zh}`, on: false, group: 'intl' })),
  ];
  const compText = c => c.text ?? c.label;   // 句子裡用的名字(「友誼賽」單獨出現分不出是誰的友誼賽)
  let picks = C.readCompPicks();
  let picksSaved = true;       // 上一次寫進瀏覽器有沒有成功(無痕視窗會失敗,要講)
  const shownNow = () => C.shownComps(upcomingComps, picks);
  /* 歐冠場次的輪次說明。**淘汰賽的 legs 也有 matchday(1 / 2 = 首 / 次回合)** ——
     照 `m.matchday ? '聯賽階段第 N 輪'` 寫的話,二月的十六強首回合會被標成
     「聯賽階段第 1 輪」,而畫面完全正常。輪次中文用產物裡的 `rounds[].zh`,
     不在前端另外抄一份對照表(抄的那一份改了上游不會跟著變)。 */
  const uclNote = (m, season) => {
    if (!m.stage || m.stage === 'LEAGUE_STAGE') return m.matchday ? `聯賽階段第 ${m.matchday} 輪` : '';
    const zh = (season?.rounds ?? []).find(r => r.stage === m.stage)?.zh ?? m.stage;
    return m.matchday ? `${zh} ${m.matchday === 1 ? '首' : '次'}回合` : zh;
  };

  const buildUpcoming = () => {
    const now = Date.now(), end = now + 7 * 86400000;
    const inWindow = k => { const t = Date.parse(k); return t >= now - 2 * 3600000 && t <= end; };
    const rows = [];
    /* 這裡收**全部**賽事的場次,勾不勾在 upcomingHtml 那一步濾 —— 勾選列上每一格的場數
       (包括沒勾的)要從同一份算,讀者才知道不勾的那幾個裡有幾場。 */
    for (const { lg, data } of leagues) {
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
              minute: m.finished ? null : C.minuteText(C.liveMinute(m, lv.fetchedAt)) }
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
    for (const cup of cupList) {
      const season = (cup.seasons ?? []).find(s => s.current);
      for (const r of season?.rounds ?? []) for (const m of r.matches ?? []) {
        if (m.played || !m.kickoff || !inWindow(m.kickoff)) continue;
        if (!covered(m.home) && !covered(m.away)) continue;
        /* 盃賽沒有獨立的 live.json:比分就在 cups.json 的場次上(state LIVE + liveScore),
           比賽日迴圈每 3 分鐘更新一次。分鐘數上游沒給,所以只寫「進行中」不編一個分鐘。 */
        const live = m.state === 'LIVE' && Array.isArray(m.liveScore)
          ? { hs: m.liveScore[0], as: m.liveScore[1], finished: false, minute: null } : null;
        rows.push({ kick: m.kickoff, comp: cup.zh ?? cup.en, compKey: cup.key,
          home: C.cupName(m.home, cupIdent), away: C.cupName(m.away, cupIdent),
          hCrest: C.cupCrest(m.home, cupIdent), aCrest: C.cupCrest(m.away, cupIdent),
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
    // 走整份(聯賽階段 + 淘汰賽);只讀 leagueMatches 的話二月起淘汰賽不會出現在這張表
    for (const m of C.uclSeasonMatches(uclSeason)) {
      if (m.played || !m.kickoff || !inWindow(m.kickoff)) continue;
      if (!m.home?.code && !m.away?.code) continue;
      rows.push({ kick: m.kickoff, comp: '歐冠', compKey: 'ucl',
        home: m.home?.name ?? '?', away: m.away?.name ?? '?',
        hCrest: uclCrest(m.home), aCrest: uclCrest(m.away),
        /* 歐冠場次連**單場頁**(2026-09-13 起有了),跟聯賽場次連分析頁是同一件事;
           以前只能連到盃賽頁的分頁,讀者還要自己在 18 場裡找。 */
        note: uclNote(m, uclSeason), pending: false,
        link: m.id != null ? C.link('ucl-match', { id: m.id }) : C.link('cups', { cup: 'ucl' }) });
    }
    /* 國家隊。名字與「還沒決定的參與者」走國家隊頁同一支(C.intlSideName);國旗是另一份產物,
       有人勾了國家隊才載(ensureFlags),載到之前只印名字。**不印比分**:國家隊沒有即時路徑(一天兩次),
       產物裡的 LIVE 是半天前的快照,拿它說「進行中」就是假話 —— 開賽了倒數那一格會自己講。 */
    for (const f of intl?.fixtures ?? []) {
      if (!intlOpen(f) || !inWindow(f.kickoff)) continue;
      const fam = intlFamOf(f.comp);
      if (!fam) continue;
      rows.push({ kick: f.kickoff, comp: intlComps.get(f.comp)?.short ?? f.comp, compKey: `intl:${fam}`,
        home: C.intlSideName(f.home, intl.teams), away: C.intlSideName(f.away, intl.teams),
        hFlag: intlFlags?.[f.home?.key] ?? null, aFlag: intlFlags?.[f.away?.key] ?? null,
        note: [f.roundZh, f.groupZh].filter(Boolean).join('・'), pending: false, live: null, link: C.link('intl') });
    }
    /* **依時間排,不依字串排**:英超、盃賽與歐冠寫 `…Z`,另外五個聯賽寫 `…+02:00`,國家隊寫 `….000Z` ——
       字典序只在同一種寫法裡成立。之前這一行比字串,10/10 13:00Z 的義甲排在 14:00Z 的英超後面。 */
    return rows.sort((a, b) => Date.parse(a.kick) - Date.parse(b.kick));
  };

  /* 窗外的下一批:窗裡沒有那個賽事時,讀者會以為它沒接上 —— 所以用一行摘要講
     (跟實時戰況頁倒數區的溢位摘要同一個做法)。

     **聯賽也要算進來**(2026-09-21 補)。第一版只走盃賽與歐冠兩個區塊,於是國際賽週
     那一天整個「即將到來」只剩一句「未來 7 天沒有已排定的比賽」,而六個聯賽的下一場
     10/09~10/10 就在資料裡、畫面一個字都沒講 —— 讀者看到的是「一個月沒有足球」或
     「站壞了」。實測那天:英超第 5 輪 9/18–9/20 踢完、第 6 輪 10/10 才開打(openfootball
     自己就是這樣排的),六個聯賽一模一樣。這是本站的老坑「只讀了資料的其中一個區塊」。

     而且條件從「這個賽事窗外還有場次」改成「這個賽事**窗裡一場都沒有**」——
     那才是這一行本來要回答的問題(舊註解寫的就是這個,實作寫寬了)。

     **只講勾著的賽事**(2026-09-26):讀者取消勾選的,在摘要裡冒出來等於沒取消。 */
  const beyondOf = (present, shown) => {
    const now = Date.now(), end = now + 7 * 86400000;
    /* 沒有開球時間的場次只比得了日期,所以要一個**當地**的今天(上游是逐月公布開球時間的,
       西甲現在 311 場未賽而只有 20 場有時間 —— 拿「有開球時間」當分母會講出假數字)。 */
    const todayISO = new Date(now - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const out = [];
    /* 聯賽:「還有幾場」一律數 `!played`,不是數有開球時間的那些。
       日期已過卻還沒踢的(改期而上游還沒給新日期)不算「接下來」—— 本站沒有延賽的資料源,
       把它當成下一批會印出一個已經過去的日期。 */
    for (const { lg, data } of leagues) {
      if (!shown.has(lg) || present.has(lg)) continue;
      const rest = (data.fixtures ?? []).filter(f => !f.played && f.date >= todayISO);
      if (!rest.length) continue;
      const first = rest.reduce((a, b) => (a.date <= b.date ? a : b));
      const batch = rest.filter(f => f.round === first.round);
      const pend = batch.filter(f => !f.kickoff).length;
      out.push(`${C.LEAGUES[lg].zh} 第 ${first.round} 輪:${C.dateFull(first.date)} 起(${batch.length} 場${
        pend ? `,${pend} 場時間待定` : ''})`);
    }
    const known = new Set(leagues.flatMap(({ data }) =>
      (data.teams ?? []).flatMap(t => [t.en, t.of].filter(Boolean).map(x => x.toLowerCase()))));
    const covered = s => s && (s.code || known.has(String(s.name ?? '').toLowerCase()));
    for (const cup of cupList) {
      if (!shown.has(cup.key) || present.has(cup.key)) continue;
      const season = (cup.seasons ?? []).find(s => s.current);
      const future = (season?.rounds ?? []).flatMap(r => (r.matches ?? [])
        .filter(m => !m.played && m.kickoff && Date.parse(m.kickoff) > end
          && (covered(m.home) || covered(m.away)))
        .map(m => ({ kick: m.kickoff, stage: m.stage })));
      if (!future.length) continue;
      const first = future.sort((a, b) => (a.kick < b.kick ? -1 : 1))[0];
      out.push(`${cup.zh ?? cup.en} ${first.stage ?? ''}:${C.dateFull(first.kick.slice(0, 10))} 起(${future.length} 場)`);
    }
    // 歐冠也一樣:窗裡沒有歐冠時,用一行講下一批是聯賽階段第幾輪、幾號起
    const uclSeason = (shared.ucl?.seasons ?? []).find(s => s.current);
    const uclFuture = !shown.has('ucl') || present.has('ucl') ? [] : C.uclSeasonMatches(uclSeason)
      .filter(m => !m.played && m.kickoff && Date.parse(m.kickoff) > end && (m.home?.code || m.away?.code))
      .sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));
    if (uclFuture.length) {
      const f = uclFuture[0];
      out.push(`歐冠 ${uclNote(f, uclSeason)}:${C.dateFull(f.kickoff.slice(0, 10))} 起(本站球隊 ${uclFuture.length} 場)`);
    }
    // 國家隊:勾著的家族在窗裡一場都沒有時,講下一批幾號起(跟盃賽同一個寫法)
    for (const fam of intlFams) {
      const k = `intl:${fam.key}`;
      if (!shown.has(k) || present.has(k)) continue;
      const future = (intl?.fixtures ?? []).filter(f => intlOpen(f) && intlFamOf(f.comp) === fam.key && Date.parse(f.kickoff) > end);
      if (!future.length) continue;
      const first = future.reduce((a, b) => (Date.parse(a.kickoff) <= Date.parse(b.kickoff) ? a : b));
      out.push(`國家隊・${fam.zh}:${C.dateFull(first.kickoff.slice(0, 10))} 起(${future.length} 場)`);
    }
    return out;
  };

  /* 勾選列。每一格帶**未來 7 天的場數,沒勾的也算** —— 取消勾選的賽事從表上消失之後,
     讀者要看得出它裡面還有幾場,不然「這 7 天沒有比賽」跟「被我關掉了」長得一模一樣。
     用真的 checkbox(鍵盤與讀屏都認得),外面包 label 讓整格都點得到。 */
  const picksHtml = (all, shown) => {
    const count = key => all.filter(u => u.compKey === key).length;
    const chip = c => {
      const n = count(c.key), on = shown.has(c.key);
      return `<label class="comp-pick${on ? ' on' : ''}" title="${C.esc(compText(c))}:未來 7 天 ${n} 場"><input type="checkbox" data-upcoming-comp="${
        C.esc(c.key)}"${on ? ' checked' : ''}>${C.compBadge(c.key)}<span>${C.esc(c.label)}</span><span class="n">${n}</span></label>`;
    };
    /* 國家隊自己一行,最前面一格一次勾整組。那一格勾不勾是**算出來的**(全勾 / 部分 / 沒勾,部分的時候是半勾),
       不另外存 —— 另外存的話會有「整組勾著而底下全沒勾」這種自己跟自己矛盾的組合。 */
    const nat = upcomingComps.filter(c => c.group === 'intl');
    const natOn = nat.filter(c => shown.has(c.key)).length;
    const natN = nat.reduce((t, c) => t + count(c.key), 0);
    return `<div class="comp-picks" role="group" aria-label="即將到來要列哪些賽事">
    ${upcomingComps.filter(c => c.group !== 'intl').map(chip).join('')}
    ${nat.length ? `<span class="comp-picks-break"></span><label class="comp-pick comp-group${natOn === nat.length ? ' on' : ''}" title="國家隊:未來 7 天 ${natN} 場(一次勾整組)"><input type="checkbox" data-upcoming-group="intl"${
      natOn === nat.length ? ' checked' : ''}${natOn && natOn < nat.length ? ' data-some="1"' : ''}><span>國家隊</span><span class="n">${natN}</span></label>${nat.map(chip).join('')}` : ''}
    <span class="comp-picks-act"><button class="btn tiny" type="button" data-upcoming-all>全選</button><button class="btn tiny" type="button" data-upcoming-none>全不選</button></span>
    ${picksSaved ? '' : `<span class="tiny warn-text">這個瀏覽器存不起來(無痕視窗,或擋掉了網站資料)——
      勾選只在這一頁有效,重新整理會回到預設。</span>`}</div>`;
  };

  // 每次 render() 重算:覆蓋(盃賽小檔、聯賽 raw feed)改的是資料,表要跟著資料重畫
  const upcomingHtml = () => { const all = buildUpcoming();
    const shown = shownNow();
    const upcoming = all.filter(u => shown.has(u.compKey));
    const beyond = beyondOf(new Set(upcoming.map(u => u.compKey)), shown);
    const partial = shown.size < upcomingComps.length;
    ensureFlags(shown);
    const offIn = upcomingComps.filter(c => !shown.has(c.key))
      .map(c => [compText(c), all.filter(u => u.compKey === c.key).length]).filter(([, n]) => n > 0);
    const offLine = offIn.length
      ? `沒勾的賽事另有 ${offIn.reduce((t, [, n]) => t + n, 0)} 場(${offIn.map(([l, n]) => `${C.esc(l)} ${n}`).join('、')})。` : '';
    return `
  <div class="section"><h2>即將到來</h2><span class="hint">未來 7 天・勾選存在這個瀏覽器</span></div>
  ${upcomingComps.length ? picksHtml(all, shown) : ''}
  ${upcomingComps.length && !shown.size ? `<div class="note"><b>沒有勾選任何賽事。</b>按上面的「全選」,或勾你要看的那幾個${
      all.length ? `(這 7 天一共 ${all.length} 場)` : ''}。</div>`
  : upcoming.length ? `<div class="card">${C.table(upcoming, [
    // 排序值是時間不是字串(三種寫法混著,字典序會排錯 —— 見 buildUpcoming 最後那一行)
    { key: 'kick', label: '開球(台北)', value: u => Date.parse(u.kick),
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
              u.live.minute ?? '進行中'}</span>${sc}</span>`;
      } },
    // 靠左:內容是「圖 + 字」的 flex 排版,跟對戰欄同一邊(使用者要求,2026-09-07)
    { key: 'comp', label: '賽事', value: u => u.comp, left: true, render: u => C.compBadge(u.compKey, { label: u.comp }) },
    { key: 'match', label: '對戰', value: u => u.home, left: true,
      render: u => {
        const img = c => (c ? `<img class="crest" src="${c}" loading="lazy" width="20" height="20" style="vertical-align:middle">` : '');
        // 國家隊是國旗(國家隊頁同一個樣式;旁邊就是隊名,所以 alt 是空的)
        const flag = f => (f ? `<img class="intl-flag" src="${f}" alt="" width="20" height="15">` : '');
        const body = `<span style="display:inline-flex;align-items:center;gap:6px">${img(u.hCrest)}${flag(u.hFlag)}<span>${C.esc(u.home)}</span>
          <span class="dim">vs</span> <span>${C.esc(u.away)}</span>${flag(u.aFlag)}${img(u.aCrest)}</span>`;
        return u.link ? `<a href="${u.link}" style="color:inherit;text-decoration:none">${body}</a>` : body;
      } },
    { key: 'note', label: '輪次', value: u => u.note, sortable: false,
      render: u => `<span class="tiny dim">${C.esc(u.note)}</span>` },
  ], { sortKey: 'kick', desc: false,
    /* 整列可點,不用瞄準文字連結(使用者要求)。歐冠場次連自己的單場頁(2026-09-13)。
       **盃賽場次開盃賽頁的對應分頁** —— 不是因為盃賽沒有單場頁(同日也做了 `cup-match.html`),
       是因為這張表只列**還沒踢的**場次(上面的 `if (m.played) continue`),
       而單場頁是賽後報告,還沒踢的場次點進去沒有東西可看。 */
    onRow: u => { if (u.link) location.href = u.link; } })}
  <div class="tiny dim" style="margin-top:8px">${beyond.length ? `窗外的下一批:${beyond.map(C.esc).join(';')}。` : ''}${offLine}
    聯賽場次點對戰直接進賽前分析,歐冠場次進歐冠單場頁(賽前對比、勝率與賽後報告都在那一頁);盃賽場次開盃賽頁的對應分頁。${
      upcoming.some(u => u.compKey.startsWith('intl:')) ? '國家隊場次開國家隊頁(勝率在那一頁);國家隊一天只更新兩次,沒有即時比分,開賽之後這裡不印比分。' : ''}
    只列已公布日期的場次;盃賽只列本站聯賽名冊裡的球隊,足總盃的低級別資格賽不在此列。</div></div>`
  : `<div class="note"><b>${partial ? '勾選的賽事' : ''}未來 7 天沒有已排定的比賽。</b>${offLine}${beyond.length
      ? `${partial ? '' : '本站涵蓋的賽事'}接下來是 —— ${beyond.map(C.esc).join(';')}。`
      : (partial ? '而且勾選的賽事,下一場都還沒公布日期。' : '而且每個賽事的下一場都還沒公布日期。')}
    <div class="tiny dim" style="margin-top:6px">場次的日期來自賽程資料源;<b>沒有場次不等於資料沒更新</b> ——
      國際賽週、盃賽的輪次之間都會出現這種空窗。改期而上游還沒給新日期的場次不算在上面那幾批裡。</div></div>`}`; };

  /* 最新動態:每個聯賽各取前幾則再依日期合併。
     只取一部分是因為這是總覽 —— 完整的在各聯賽的動態頁。 */
  const news = leagues.flatMap(({ lg, data }) => (data.news ?? []).slice(0, 4)
    .map(n => ({ ...n, leagueZh: C.LEAGUES[lg].zh })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8);

  /* 用網址去重的話,同一家來源在不同聯賽指向不同頁面就會重複列:頁尾實測是 football-data.co.uk 六次、
     Understat 與 SportMonks 各兩次(2026-09-24 全站掃描)。總覽只講「用了哪幾家」,
     所以按名字(去掉括號裡的聯賽代碼)去重,各聯賽自己的頁尾仍然連到各自的那一頁。 */
  const baseName = s => String(s.name ?? '').replace(/[((][^))]*[))]\s*$/, '').trim();
  const sources = leagues.flatMap(x => x.data.meta.sources ?? [])
    .filter((s, i, all) => all.findIndex(y => baseName(y) === baseName(s)) === i)
    .map(s => `<a href="${C.esc(s.url)}" target="_blank" rel="noopener">${C.esc(s.name)}</a>`)
    .join('、');

  /* 勾選只重畫「即將到來」那一區,不重畫整頁:整頁重畫會把讀者正在按的那一格換掉,
     鍵盤的焦點跟著不見(Tab 到第五格按空白鍵,下一次又要從頭 Tab)。重畫後把焦點放回同一格。
     事件掛在元素的 onchange / onclick 上,**不在 #app 上 addEventListener** ——
     單檔版換頁不會換掉 #app,掛在它上面的監聽每回到總覽一次就多一份。 */
  const focusSel = el => (el?.dataset?.upcomingComp != null ? `[data-upcoming-comp="${el.dataset.upcomingComp}"]`
    : el?.dataset?.upcomingGroup != null ? `[data-upcoming-group="${el.dataset.upcomingGroup}"]`
    : el?.hasAttribute?.('data-upcoming-all') ? '[data-upcoming-all]'
      : el?.hasAttribute?.('data-upcoming-none') ? '[data-upcoming-none]' : null);
  const bindUpcoming = () => {
    const box = document.getElementById('upcoming');
    if (!box) return;
    box.querySelectorAll('[data-upcoming-comp]').forEach(el => {
      el.onchange = () => setPicks({ ...picks, [el.dataset.upcomingComp]: el.checked });
    });
    for (const [sel, on] of [['[data-upcoming-all]', true], ['[data-upcoming-none]', false]]) {
      const b = box.querySelector(sel);
      if (b) b.onclick = () => setPicks(Object.fromEntries(upcomingComps.map(c => [c.key, on])));
    }
    // 「國家隊」那一格:半勾是 DOM 屬性(HTML 寫不出來),畫完才設;按下去整組跟著它
    const g = box.querySelector('[data-upcoming-group="intl"]');
    if (g) {
      g.indeterminate = g.dataset.some === '1';
      g.onchange = () => setPicks({ ...picks,
        ...Object.fromEntries(upcomingComps.filter(c => c.group === 'intl').map(c => [c.key, g.checked])) });
    }
  };
  /* 國旗是另一份產物(intl-flags.json,187 KB),**有人勾了國家隊才載** —— 大部分時候這張表沒有國家隊,
     沒有理由讓每個打開總覽的人都多下載它。載到之前只印隊名;載不到(英超目錄的 404 會拋錯)就一直只印隊名。 */
  let intlFlags = null;
  let flagsPending = false;
  const ensureFlags = shown => {
    if (intlFlags || flagsPending || ![...shown].some(k => k.startsWith('intl:'))) return;
    flagsPending = true;
    C.loadFrom('pl', ['intl-flags']).then(({ data }) => { intlFlags = data['intl-flags']?.flags ?? {}; })
      .catch(() => { intlFlags = {}; })
      .then(() => drawUpcoming());
  };
  const drawUpcoming = () => {
    const box = document.getElementById('upcoming');
    if (!box) return;
    const focus = focusSel(document.activeElement);
    box.innerHTML = upcomingHtml();
    bindUpcoming();
    C.startCountdowns();
    if (focus) box.querySelector(focus)?.focus({ preventScroll: true });
  };
  const setPicks = next => {
    picks = next;
    picksSaved = C.writeCompPicks(picks);
    drawUpcoming();
    // 新勾的聯賽還沒拿過 raw 那份即時快照:補拿(只拿沒拿過的),拿回來也可能發現有比賽在踢
    const late = leagues.filter(x => shownNow().has(x.lg) && !overlaid.has(x.lg));
    if (late.length) overlayLeagueLive(late).then(ensurePolling);
  };
  /* 有比賽在踢就每 60 秒再拿一次(盃賽頁同一個節奏;聯賽的迴圈本來就是 2 分鐘推一次),
     沒有比賽在踢的日子不輪詢 —— 這一頁不是實時頁。
     要不要輪詢看覆蓋**之後**的狀態:部署快照可能還在開賽前,而 raw 那份已經在踢了。
     包成一支、只開一次:之後才勾的聯賽補抓回來,也可能是那一場讓它該開始輪詢。 */
  let polling = false;
  const ensurePolling = () => {
    if (polling) return;
    const anyLive = leagues.some(({ data }) => (data.live?.matches ?? []).some(m => m.started && !m.finished))
      || C.cupsHaveLive(shared.cups);
    if (!anyLive) return;
    polling = true;
    C.pageInterval(async () => { await overlayLeagueLive(); await overlayCupsLive(); }, 60000);
  };

  const uclPred = uclElo?.model?.passes ? (uclElo.fixtures?.length ?? 0) : 0;
  const render = () => {
  const scrollY = window.scrollY;
  const focus = focusSel(document.activeElement);   // 覆蓋重畫時讀者可能正停在某一格勾選上
  const nowT = Date.now();
  const intlSoon = (intl?.fixtures ?? []).filter(f => f.state !== 'CANCELLED'
    && Date.parse(f.kickoff) > nowT && Date.parse(f.kickoff) <= nowT + 7 * 86400000);   // 覆蓋後重畫不要把讀者捲回頂端(跟實時頁同一招)
  app.innerHTML = `
  <div class="page-head">
    <h1>總覽</h1>
    <p>本站目前有 ${leagues.length} 個聯賽,加上跨聯賽的歐冠、英格蘭盃賽${intl ? '、國家隊' : ''}與足球知識。
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

  <div id="upcoming">${upcomingHtml()}</div>

  <div class="section"><h2>各聯賽</h2><span class="hint">點分頁直接進去・只列這個聯賽真的做得出來的頁</span></div>
  <div class="grid g2">${leagues.map(leagueCard).join('')}</div>
  ${skipped.length ? `<div class="note" style="margin-top:10px">
    ${skipped.map(x => C.esc(C.LEAGUES[x.lg]?.zh ?? x.lg)).join('、')} 的資料集還沒建置,
    這一輪先不畫 —— 少了 ${C.esc(skipped[0].absent.join('、'))}。</div>` : ''}

  <div class="section"><h2>跨聯賽</h2><span class="hint">這幾頁不分聯賽,每個聯賽看到的是同一份資料</span></div>
  <div class="grid g3">
    <div class="card"><div class="spread"><h3 style="margin:0;display:flex;align-items:center;gap:7px">${C.compBadge('ucl')}歐冠</h3>
      <a class="pill accent" href="${C.link('cups', { cup: 'ucl' })}">開啟 →</a></div>
      <div class="tiny dim" style="margin-top:8px">${uclSeasons.length
        ? `${uclSeasons.map(s => C.esc(s.label)).join('、')} 完整・每季 36 隊`
        : '目前沒有可用的完整賽季'}</div>
      ${/* 這一句原本寫死「沒有勝率預測」—— 階段 C 之後歐冠頁掛著上百場賽前勝率,這裡還在說沒有
            (「有哪一句還在講我們沒有它」又一次,2026-09-24 加國家隊卡片時看到)。改成照產物講:
            否定句只留在「真的是零」的分支。 */''}
      <div class="tiny dim" style="margin-top:6px">${uclPred
        ? `${uclPred} 場未賽有賽前勝率 —— 跨聯賽評分,走查回測改善 ${uclElo.model.improvement} ± ${uclElo.model.se}`
        : '這一輪沒有勝率預測 —— 跨聯賽評分的驗收沒有通過,或已經沒有未賽的場次。'}</div></div>

    ${intl ? `<div class="card"><div class="spread"><h3 style="margin:0">國家隊</h3>
      <a class="pill accent" href="${C.link('intl')}">開啟 →</a></div>
      <div class="tiny dim" style="margin-top:8px">${intl.comps.filter(c => c.status === 'ok').length} 個賽事・接下來 7 天 ${intlSoon.length} 場${
        intlSoon.length ? `(給勝率 ${intlSoon.filter(f => f.prob).length} 場)` : ''}</div>
      <div class="tiny dim" style="margin-top:6px">${intl.model.passed && intl.model.holdout
        ? `本站的國家隊 Elo,走查回測改善 ${intl.model.holdout.gain} ± ${intl.model.holdout.se};評分只從獨立來源的歷史賽果算,收錄到 ${C.esc(intl.model.ratingsAsOf)}。`
        : '國家隊 Elo 這一次的驗收沒有通過,所以不給勝率;賽程與賽果照常。'}</div></div>` : ''}

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
  bindUpcoming();
  C.startCountdowns();   // 「即將到來」的倒數要會走,不然停在載入當下慢慢變錯
  if (focus) app.querySelector(focus)?.focus({ preventScroll: true });
  window.scrollTo(0, scrollY);
  };

  render();
  overlayCupsLive();     // 畫完才去拿盃賽的即時比分,有變才重畫
  overlayLeagueLive().then(ensurePolling);
} catch (err) { C.fail(err); }
