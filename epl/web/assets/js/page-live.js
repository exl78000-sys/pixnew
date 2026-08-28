import * as C from './core.js?v=cef0959b';
import { mountSimTable } from './sim-table.js?v=a4e7b86f';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, live: liveInitial, fixtures, table, tactics, analysis, sim } =
    await C.load('meta', 'clubs', 'teams', 'live', 'fixtures', 'table', 'tactics', 'analysis', 'sim');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();
  const isLaLiga = C.league() === 'es1';

  const tacBy = new Map(tactics.map(t => [t.code, t]));
  // 整頁的渲染包成函式:輪詢到新資料、或單純時間往前走(比賽從未開賽變成進行中)時,
  // 都可以重跑一次,不必整頁重新載入。
  let live = liveInitial;
  // 即時模式(npm run live:watch)會在資料裡自報;靜態站沒有這個旗標
  const isLiveMode = () => !!live.liveMode;
  // 球員檔約 3 MB，平常不跟即時戰況一起載入；第一次點球員才取得，之後沿用快取。
  let playerByCodePromise = null;
  const getPlayerByCode = async () => {
    if (!playerByCodePromise) {
      playerByCodePromise = C.load('players').then(({ players }) => new Map(players.map(p => [String(p.code), p])));
    }
    return playerByCodePromise;
  };
  const resolvePlayer = async code => (await getPlayerByCode()).get(String(code));
  // 比賽報告是掛在 body 的抽屜，不在 #app 內，所以監聽整份 document。
  C.bindPlayerLinks(document, resolvePlayer, { meta, mode: 'current' });

  function renderPage() {
    const scrollY = window.scrollY;
    const matches = live.available ? live.matches : [];
    const liveByKey = new Map(matches.filter(m => !live.demo).map(m => [`${m.home}|${m.away}`, m]));
    const done = matches.filter(m => m.finished);
    // SportMonks livescores 沒有比賽時不一定帶輪次；不要把 undefined 顯示給使用者。
    const liveRound = Number.isFinite(Number(live.round)) ? Number(live.round) : null;
    // 西甲目前尚未接入逐分鐘 feed，但賽程已有已完賽比分；先用同一張卡片模板呈現，
    // 點擊後仍可進入單場分析與可用的賽後報告，不把空的 live feed 當成沒有賽果。
    const finishedSchedule = fixtures.filter(f => f.played)
      .sort((a, b) => (a.kickoff < b.kickoff ? 1 : -1));
    const now = Date.now();

    /* 剛結束的比賽留在上面三天。
       原本一完賽就掉到頁尾的「已完賽」區,而那一區在「開賽倒數」下面 ——
       週末剛踢完的那幾場反而變成最難找的。

       窗口從**結束時間**起算(開球 + MATCH_WINDOW_MIN),不是從開球起算,
       否則同一天的晚場會比早場少留兩個小時。MATCH_WINDOW_MIN 直接用
       core 的那一個,不在這裡另寫一份 —— 兩份會各自漂移。 */
    const RECENT_MS = 3 * 24 * 3600 * 1000;
    const endedAt = fx => (fx.kickoff ? Date.parse(fx.kickoff) + C.MATCH_WINDOW_MIN * 60000 : NaN);
    const recentFinished = fixtures.filter(fx => {
      if (!fx.played) return false;
      const e = endedAt(fx);
      // e 比 now 大(資料源比賽程先給比分)也算剛結束 —— 那是「更新」,不是「還沒發生」
      return Number.isFinite(e) && now - e < RECENT_MS;
    }).sort((a, b) => (a.kickoff < b.kickoff ? 1 : -1));
    const recentIds = new Set(recentFinished.map(fx => fx.id));
    /* 重播模式的 done 是**別季**的比賽,配對鍵可能剛好撞上本季的某一場,
       撞到就會讓那張重播卡片憑空消失。所以只有非重播模式才做排除。 */
    const recentKeys = live.demo ? new Set() : new Set(recentFinished.map(fx => `${fx.home}|${fx.away}`));
    const doneRest = done.filter(m => !recentKeys.has(`${m.home}|${m.away}`));
    const finishedRest = finishedSchedule.filter(fx => !recentIds.has(fx.id));

    // 從人的角度講「多久以前」。負值(資料源比賽程早)不講,免得出現「-1 小時前」
    const agoText = ms => {
      if (!Number.isFinite(ms) || ms < 0) return null;
      const h = Math.floor(ms / 3600000);
      if (h < 1) return '剛結束';
      if (h < 24) return `${h} 小時前`;
      return `${Math.floor(h / 24)} 天前`;
    };
    // 有真正即時資料的那幾場用完整的完場卡(陣型、xG、賽前機率),其餘用賽程卡
    const recentCards = recentFinished.map(fx => {
      const m = liveByKey.get(`${fx.home}|${fx.away}`);
      const ago = agoText(now - endedAt(fx));
      return m && m.finished ? finishedCard(m, ago) : finishedFixtureCard(fx, ago);
    });

    // 就算沒有即時資料源,光靠賽程也知道現在有哪幾場正在踢 —— 這一段永遠可用
    const phased = fixtures.map(f => ({ f, s: C.scheduleState(f, now) }));
    const inPlaySched = phased.filter(x => x.s.phase === 'inplay').sort((a, b) => (a.f.kickoff < b.f.kickoff ? -1 : 1));
    /* 「還沒有賽果」那一區的上限。一輪有幾場是**聯賽決定的**(英超西甲 20 隊 → 10 場、
       英冠 24 隊 → 12 場),不可以寫死一個數字(CLAUDE.md 那條「前端把聯賽的事實寫死」)。
       開賽倒數不用這個數 —— 它按「同一輪連到哪就到哪」自己收斂。 */
    const perRound = Math.max(1, Math.floor((meta.competition?.teams ?? 20) / 2));
    const awaiting = phased.filter(x => x.s.phase === 'awaiting' && !x.f.played)
      .sort((a, b) => (a.f.kickoff > b.f.kickoff ? -1 : 1)).slice(0, perRound);
    const upcoming = phased.filter(x => x.s.phase === 'upcoming').map(x => x.f)
      .sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));

    /* 開賽倒數只顯示「開球順序上第一段連續同輪」的場次,其餘收成一行摘要。
       規則與量過的數字寫在 core.js 的 countdownFixtures —— 抽到那裡是為了能被
       npm test 測到:測試看不到 DOM,留在頁面裡就只能用正則掃原始碼。 */
    const countdownList = C.countdownFixtures(upcoming);
    const countdownRest = upcoming.slice(countdownList.length);
    /* 補賽:這一段的輪次**比已經踢過的輪次還低**,代表它是從更早的一輪延後過來的。
       實測 2025-26 第 31 輪 Man City vs Crystal Palace —— 同輪其他九場 3/21 踢完,
       它 5/13 才踢,晚了 53 天。畫面上要講出來,否則五月中冒出一個「第 31 輪」
       看起來像資料錯了。判斷用「已完賽的最大輪次」,不要用「下一段的輪次」——
       正常情況下一段本來就比較大,那樣會把每一輪都標成補賽。 */
    const maxPlayedRound = Math.max(0, ...fixtures.filter(f => f.played && f.round != null).map(f => f.round));
    /* 「本季還有幾場」要數**所有未賽的**,不能數 upcoming ——
       upcoming 只收有開球時間的場次(scheduleState 對沒有 kickoff 的回 unknown),
       而上游是逐月公布開球時間的:實測西甲 339/380、英冠 264/552 目前還沒有時間。
       拿 upcoming 去講「本季還有 N 場」,西甲會顯示 11 場,而它其實還有三百多場。
       那一批也不報「這一輪幾場」—— 同一輪可能只有一部分公布了時間,報出來是假的。 */
    const unplayedCount = fixtures.filter(f => !f.played).length;
    const isCatchUp = countdownList.length > 0 && countdownList[0].round != null
      && countdownList[0].round < maxPlayedRound;

    // 有真正即時資料的比賽優先用即時資料,其餘用賽程推導
    const liveCards = inPlaySched.map(({ f, s }) => ({ f, s, m: liveByKey.get(`${f.home}|${f.away}`) ?? null }));
    const withRealData = liveCards.filter(x => x.m).length;

    /* 資料來源說明 —— 這一段一定要講清楚,免得把重播當成現正進行 */
    /* 有比賽在踢、資料卻已經舊了的時候要明講。
       不講的話讀者會把 40 分鐘前的比分當成現在的比分 —— 那比沒有比分更糟。
       門檻抓 5 分鐘:比賽日的輪詢是每 2 分鐘一次,超過 5 分鐘代表更新機制沒在跑。 */
    const staleBanner = () => {
      if (!live.available || !live.fetchedAt) return '';
      const playing = (live.matches ?? []).filter(m => m.started && !m.finished).length;
      if (!playing) return '';
      const mins = Math.round((Date.now() - Date.parse(live.fetchedAt)) / 60000);
      if (mins < 5) return '';
      return `<div class="note ${mins >= 15 ? 'warn' : ''}" style="margin-top:12px">
        <b>比分已經 ${mins} 分鐘沒更新</b>(有 ${playing} 場正在踢)。
        畫面上的比分與分鐘數是 ${C.kickoffLocal(live.fetchedAt)} 抓到的,<b>不是現在的實況</b>。
        <div class="tiny dim" style="margin-top:6px">
          比賽中正常是每 2 分鐘更新一次。超過這個時間通常是更新流程還沒被觸發或正在排隊 ——
          這一頁每 20 秒會自己重新取一次,拿到新資料就會自動換掉,不需要重新整理。</div>
      </div>`;
    };

    const sourceBanner = () => {
      if (!live.available) {
        if (isLaLiga) return `<div class="note">西甲實時頁面已啟用賽程推算、開賽倒數與賽後分析模板；目前尚未接入西甲即時比分資料源，畫面不會把賽前預測冒充實況。<br>
          即時比分、場上陣容與勝率會在 SportMonks 即時端點完成後由此頁自動接入；目前可先點賽程或完賽場次查看完整分析。
          <br>下方的<b>開賽倒數</b>與依時間判斷的<b>進行中</b>區塊不需要即時資料源。</div>`;
        return `<div class="note">目前沒有接上即時比賽資料源,所以這一頁不會顯示場中比分 ——
          畫面不會把賽前預測冒充實況。
          <br>下方的<b>開賽倒數</b>與依時間判斷的<b>進行中</b>區塊不需要即時資料,永遠可用。</div>`;
      }
      if (live.demo) {
        return `<div class="note">上方的<b>進行中 / 等待賽果 / 開賽倒數</b>是依本季賽程與現在時間推算的,是真的。<br>
          下方<b>「已完賽」區塊</b>目前放的是${C.esc(live.sourceLabel)} —— 資料完全真實(真實出場名單、真實 xG、
          真實比分),但<b>不是本季的比賽</b>,只是用來示範賽後分析長什麼樣。<br>
          本季真正的即時比分接上之後,這一段會自動換成實況。</div>`;
      }
      const fresh = new Date(live.fetchedAt);
      const age = Math.round((Date.now() - fresh.getTime()) / 60000);
      const ageText = age < 2 ? '剛剛' : age < 90 ? `${age} 分鐘前` : `${Math.round(age / 60)} 小時前`;
      return `<div class="note info">資料來源:${C.esc(live.sourceLabel)}・
        資料時間 ${fresh.toLocaleString('zh-TW', { hour12: false })}(${ageText})
        ${isLiveMode()
          ? `<br><b>即時模式進行中</b> —— 每 ${Math.round((live.pollIntervalMs ?? 60000) / 1000)} 秒自動更新,不用重整。`
          : '<br>這是<b>當時的快照</b>,不會自己更新 —— 下次資料更新時這裡才會換。'}
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

    ${staleBanner()}
    ${sourceBanner()}

    <div class="grid g4" style="margin-top:14px">
      ${kpi('本季已完賽', `${curPlayed} 場`, `${meta.currentSeason}・共 ${fixtures.length} 場`)}
      ${kpi('進行中', inPlaySched.length, inPlaySched.length
        ? (withRealData ? `${withRealData} 場有即時比分` : '比分需要即時資料源')
        : '目前沒有比賽在踢')}
      ${kpi('下一場開賽', upcoming[0] ? C.countdown(upcoming[0].kickoff) : '—',
        upcoming[0] ? `${C.name(upcoming[0].home)} vs ${C.name(upcoming[0].away)}` : '本季賽程已結束')}
      ${kpi('本輪已完賽', live.available ? done.length : '—', live.available
        ? (liveRound ? `第 ${liveRound} 輪共 ${matches.length} 場` : `即時快照共 ${matches.length} 場`)
        : '即時來源尚未接入')}
    </div>

    ${inPlaySched.length ? `
      <div class="section"><h2><span class="livedot"></span>進行中</h2>
        <span class="hint">依賽程推算・${withRealData ? `${withRealData} 場已接上即時比分` : '尚未接上即時比分'}</span></div>
      ${!withRealData ? `<div class="note" style="margin-bottom:10px">
        這 ${inPlaySched.length} 場<b>依賽程現在正在進行</b>,但目前沒有接上即時資料源,所以看不到比分。<br>
        ${isLaLiga
          ? '西甲即時端點尚未接入；目前只顯示賽前預測與開賽時間。'
          : '接上即時來源之後,這一頁會自動更新真實比分、場上陣容與即時勝率。'}</div>` : ''}
      <div class="grid g2">${liveCards.map(x => x.m ? liveCard(x.m) : schedCard(x)).join('')}</div>` : ''}

    ${recentCards.length ? `
      <div class="section"><h2>剛結束</h2>
        <span class="hint">完賽 3 天內・共 ${recentCards.length} 場・新到舊・點任一場看完整賽後解讀</span></div>
      <div class="grid g2">${recentCards.join('')}</div>` : ''}

    ${awaiting.length ? `
      ${/* 原本這一句寫「資料源還沒更新比分」—— **那對延賽是錯的**:它說我們的資料落後了,
            但那場可能根本沒踢,讀者會等一個永遠不會來的比分。本站沒有延賽的資料來源,
            分不出是哪一種,所以兩種都講,並且把「早該結束多久」給讀者自己判斷。
            一季有 2~7 場改期(英超 2023-24 六次、英冠 2025-26 七次),這個空窗一定會出現。 */''}
      <div class="section"><h2>還沒有賽果</h2><span class="hint">時間上早該結束,但本站還沒拿到比分 —— 可能是資料源還沒更新,也可能是這場延賽了</span></div>
      <div class="grid g3">${awaiting.map(({ f, s }) => `
        <a class="card matchcard" href="${C.link('analysis', { id: f.id })}" style="padding:12px 14px">
          <div class="spread"><span class="tiny dim">${C.kickoffLocal(f.kickoff)}・第 ${f.round} 輪</span>
            <span class="pill warn tiny">${s.elapsed > 60 * 24
              ? `早該結束 ${Math.floor(s.elapsed / 60 / 24)} 天` : '賽果未取得'}</span></div>
          <div class="row" style="gap:7px;margin-top:8px">${C.badge(f.home)}<b class="small">${C.name(f.home)}</b>
            <span class="dim">vs</span>${C.badge(f.away)}<b class="small">${C.name(f.away)}</b></div>
          <div class="tiny dim" style="margin-top:6px">賽前預期 ${f.prediction.xgHome}:${f.prediction.xgAway}</div>
        </a>`).join('')}</div>` : ''}

    <div class="section"><h2>開賽倒數</h2><span class="hint">${countdownList.length
      ? `第 ${countdownList[0].round} 輪${isCatchUp ? '補賽' : ''}・${countdownList.length} 場・`
      : ''}依實際開球時間排序・已換算為 ${C.tzName()}</span></div>
    ${isCatchUp ? `<div class="note" style="margin-bottom:10px">這是第 ${countdownList[0].round} 輪的補賽 ——
      同一輪其他場次已經踢完,這場延後到現在。</div>` : ''}
    <div class="grid g2">${countdownList.map(countdownCard).join('') || '<div class="card dim">本季沒有未開賽的比賽了。</div>'}</div>
    ${/* 沒顯示的不是藏起來:下一批幾號開始、哪一輪、幾場,都寫在這一行。
          原本這裡寫「還有 362 場」(整季),讀者不會想到自己要找的那兩場就在裡面。 */''}
    ${countdownRest.length ? `<div class="note" style="margin-top:10px">
      下一批:第 ${countdownRest[0].round} 輪・${C.kickoffLocal(countdownRest[0].kickoff)} 起。
      <a href="${C.link('index')}">看完整賽程(本季還有 ${unplayedCount} 場未賽)→</a></div>` : ''}

    ${(doneRest.length || finishedRest.length) ? `
      <div class="section"><h2>已完賽${live.demo && liveRound ? `(重播 ${live.season} 第 ${liveRound} 輪)` : ''}</h2>
        <span class="hint">${live.demo ? '真實比賽資料,非本季' : live.available && liveRound ? `${meta.currentSeason} 第 ${liveRound} 輪` : `${meta.currentSeason} 已取得 ${finishedRest.length} 場比分`}・點任一場看完整賽後解讀</span></div>
      <div class="grid g2">${live.available && doneRest.length ? doneRest.map(m => finishedCard(m)).join('') : finishedRest.slice(0, 12).map(fx => finishedFixtureCard(fx)).join('')}</div>` : ''}

    ${curPlayed > 0 ? `
      <div class="section"><h2>本季即時積分榜</h2><span class="hint">${meta.currentSeason}・依目前已完賽場次計算</span></div>
      <div id="curTable"></div>` : `
      <div class="section"><h2>本季即時積分榜</h2></div>
      <div class="note">${meta.currentSeason} 目前還沒有已完賽的比賽進入資料源,積分榜是空的。
        ${isLaLiga
          ? '西甲賽果會由西甲同步流程帶入。'
          : '賽果由 openfootball 與即時來源兩邊帶入,兩者都會自動併進這張表。'}</div>`}

    ${/* 現況與預測並排。上面那張是「已經拿到幾分」,這張是「照目前實力跑完整季會是幾分」——
         比賽進行中的時候,兩張一起看才知道這一場的結果把誰推去了哪裡。
         表格本身跟積分與賽程頁共用同一份定義(sim-table.js),不複製。 */''}
    <div class="section"><h2>本季預測積分榜</h2>
      <span class="hint">蒙地卡羅模擬 ${meta.model.simulationRuns.toLocaleString()} 次賽季・跟上面那張是同一個賽季的兩種看法</span></div>
    <div id="simTable"></div>
    ${C.foot(meta)}`;

    mountSimTable('simTable', { sim, teams, table, meta });

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

  function finishedCard(m, ago = null) {
    const H = m.sides[m.home], A = m.sides[m.away];
    const surprise = m.preMatch
      ? (m.hs > m.as ? m.preMatch.home : m.hs < m.as ? m.preMatch.away : m.preMatch.draw)
      : null;
    return `<a class="card matchcard" href="#" data-match="${m.key}">
      <div class="spread"><span class="row" style="gap:6px"><span class="pill">完場</span>${
          ago ? `<span class="pill accent tiny">${ago}</span>` : ''}</span>
        <span class="tiny dim">${C.kickoffLocal(m.kickoff)}・第 ${m.round} 輪</span></div>
      <div style="margin:12px 0">${scoreOf(m)}</div>
      <div class="tiny dim center">陣型 ${H.shape.label} vs ${A.shape.label}・xG ${H.xG} : ${A.xG}
        ${surprise !== null ? `・賽前模型給這結果 ${C.pct(surprise, 0)}` : ''}</div>
      ${m.notes.length ? `<div class="small muted" style="margin-top:8px">${C.esc(m.notes[0].text)}</div>` : ''}
    </a>`;
  }

  function finishedFixtureCard(f, ago = null) {
    return `<a class="card matchcard" href="${C.link('analysis', { id: f.id })}">
      <div class="spread"><span class="row" style="gap:6px"><span class="pill">完場</span>${
          ago ? `<span class="pill accent tiny">${ago}</span>` : ''}</span>
        <span class="tiny dim">${C.kickoffLocal(f.kickoff)}・第 ${f.round} 輪</span></div>
      <div style="margin:12px 0">${scoreLine(f.home, f.away, `${f.fh ?? '-'} : ${f.fa ?? '-'}`)}</div>
      <div class="tiny dim center">已取得正式比分・點擊查看賽前機率與可用賽後資料 →</div>
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

  async function openReport(m) {
    if (!m) return;
    // 報告本體不重複儲存大型 base64 圖片，點開報告時才與本機球員庫合併頭貼。
    try { m = C.reportWithPlayerPhotos(m, await getPlayerByCode()); } catch { /* 圖片失敗仍顯示報告 */ }
    const p = m.finished ? m.preMatch : m.inplay;
    C.drawer(`${C.badge(m.home)} ${C.name(m.home)} ${m.hs ?? '-'}-${m.as ?? '-'} ${C.name(m.away)} ${C.badge(m.away)}`, `
      <div class="card">
        <div class="spread">
          <span class="small dim">${C.kickoffLocal(m.kickoff)}・第 ${m.round} 輪</span>
          <span class="pill ${m.finished ? '' : 'bad'}">${m.finished ? '完場' : `第 ${m.minute} 分鐘`}</span>
        </div>
        <div style="margin:14px 0">${scoreOf(m)}</div>
        ${p ? `${C.probBar(p)}
          <div class="tiny dim center" style="margin-top:6px">
            ${m.finished ? '完場後保留賽前機率・不用賽果改成 100%' : `剩餘 ${Math.round(p.remaining * 90)} 分鐘・期望再進 ${p.xgRestHome} : ${p.xgRestAway}`}</div>` : ''}
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
  /* 取回最新的 live.json。
     優先走 raw.githubusercontent.com —— 比賽日的輪詢每 2 分鐘就把資料推回 repo,
     那裡拿得到的比 Pages 上的新(Pages 要等下一次部署)。
     raw 掛掉、或本機開啟時,退回讀本站自己的 data/live.json。 */
  const feeds = [meta.liveFeed, 'data/live.json'].filter(Boolean);
  const fetchLive = async () => {
    for (const url of feeds) {
      try {
        const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) return await res.json();
      } catch { /* 換下一個來源 */ }
    }
    return null;
  };

  C.pageInterval(async () => {
    try {
      const fresh = await fetchLive();
      if (!fresh) return;
      const stamp = fresh.fetchedAt ?? null;
      if (stamp !== lastStamp || fresh.available !== live.available) {
        lastStamp = stamp;
        live = fresh;
        renderPage();
      }
    } catch { /* 靜態站沒有即時端點時會失敗,忽略即可 */ }
  }, POLL_MS);
  C.pageInterval(renderPage, REDRAW_MS);

} catch (err) { C.fail(err); }
