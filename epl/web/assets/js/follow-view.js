/* 我的球隊(2026-09-14,使用者要求的「關注球隊」)。
   「我的」那一頁的第一個分頁,內容抽成 render 函式 —— 做法同 ucl-view / knowledge-view。

   這一頁**不會多出任何資料**。每支球隊的數字本站本來就有,關注做的是
   「把我的那幾支收到一起 + 在各頁先被看到」。不要在這裡長出別處沒有的數字。

   三件事刻意這樣做:

   1. **先畫聯賽,再補盃賽與歐冠。** 盃賽那三份產物合計約 2 MB
      (cups 1.06 MB + ucl 527 KB + ucl-teams 432 KB),而這一頁只從裡面撈兩三場。
      第一次繪製 await 它們的話,畫面會卡在「載入資料中…」等一份跟主要內容
      無關的大檔 —— 盃賽頁那條坑(第一次繪製之前 await 跨網域請求)的同一個形狀。
      所以:聯賽先畫,盃賽與歐冠拿到再併進「下一場」重畫。

   2. **每一區自己判斷資料在不在。** 有的聯賽沒有某一層(實測拿不到,不是還沒做),
      所以傷停那一區在英冠的卡片上**整區消失並說明原因**;盃賽沒有勝率預測
      (對手一半是第三四級球隊,評不出強度),所以盃賽的下一場不印機率。
      留一個永遠空白的欄位比不做更糟(鐵則三)。

   3. **關注名單存在瀏覽器這件事要寫在畫面上**,而且給匯出/匯入 ——
      不要讓人以為它存在雲端(鐵則四,跟「我的預測」同一套)。 */
import * as C from './core.js?v=f4adf252';
/* **具名 import 要寫在同一行。** 單檔版的打包是用單行正則把 import 拆掉的,
   跨行的話拆不掉 → 攤平之後還留著一個 import 陳述句 → 整份單檔版死掉。
   bundle.mjs 的守門會擋下來(「單檔版裡還有沒拆掉的 import」),不會靜靜過關。 */
import { readFollows, writeFollows, followStar, bindFollowStars, SOFT_LIMIT, FOLLOW_STORAGE_NOTE } from './follow.js?v=02130043';

/* 可以關注的聯賽 = 有球隊頁的那三個。**寫成明確清單,不要用「不是某某」的二元式** ——
   那種寫法在只有幾個聯賽時看起來完全正確,加第四個就會靜靜把它也放進來。 */
const FOLLOW_LEAGUES = ['pl', 'es1', 'en2'];

const fvEsc = C.esc;

/* 「接下來」顯示幾場。**這個數字要同時管「每個賽事各取幾場」與「合併後留幾場」** ——
   兩邊不一致就是 2026-09-15 使用者抓到的那個 bug:
   聯賽只取**一場**、盃賽與歐冠取全部,合併排序後切三場 ——
   於是 Arsenal 的第三場變成 10/13 的歐冠,而 **10/10 的英超對 Leeds 被整場跳過**,
   因為它從頭到尾沒有進候選名單。畫面上完全看不出來:三場都是真的比賽、
   時間也照順序,只是中間少了一場。
   **每個來源各取 N 場,合併之後才是真正的前 N 場。** */
const NEXT_N = 3;

/* 這一支球隊最近踢完的幾場(從該聯賽的 fixtures 撈,不另外要一份產物)。 */
function recentOf(fixtures, code, n = 5) {
  return (fixtures ?? [])
    .filter(f => f.played && (f.home === code || f.away === code))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    .slice(0, n);
}

/* 接下來的幾場聯賽。**數的是「還沒踢」而不是「有開球時間」** ——
   上游是逐月公布開球時間的,拿 kickoff 當條件會漏掉一整批還沒公布時間的場次。
   但要排序就需要時間,所以:有時間的照時間排、沒時間的用日期排在後面。

   **要取 N 場不是一場**(2026-09-15 修):只取一場的話,合併盃賽與歐冠之後
   第二、三格永遠是盃賽/歐冠,中間的聯賽場次被整場跳過。 */
export function nextLeagueMatches(fixtures, code, n = NEXT_N) {
  const key = f => f.kickoff ?? `${f.date ?? '9999-99-99'}T99:99`;
  return (fixtures ?? [])
    .filter(f => !f.played && (f.home === code || f.away === code))
    .sort((a, b) => String(key(a)).localeCompare(String(key(b))))
    .slice(0, n);
}

/* 一隊畫成一格。三條路:**本站認得的**用站上那份隊徽;**本站不認得但上游有圖的**
   (歐冠的 Lille、盃賽的低級別球隊)用上游那張;都沒有才只印名字。
   只寫前兩條的話,同一排裡有些格子有隊徽、有些是光禿禿的文字,看起來像壞掉。
   `nameless` 給自家那一格用:卡片抬頭已經寫著是誰了,每一行再印一次只是把列撐長。 */
function sideHtml(s, { nameless = false } = {}) {
  if (s.code) return nameless ? C.badge(s.code) : `${C.badge(s.code)} ${fvEsc(C.name(s.code))}`;
  if (s.crest) {
    return `<img class="crest" src="${s.crest}" alt="" loading="lazy" width="22" height="22"
      onerror='this.style.display="none"'> ${fvEsc(s.name ?? '')}`;
  }
  return fvEsc(s.name ?? '待定');
}

/* 一場比賽畫成一行。`comp` 是賽事標籤,`prob` 有才畫(盃賽沒有預測)。

   **主客用位置講,不放「主 / 客」藥丸**(使用者的決定,2026-09-15):
   主隊在左、客隊在右,跟賽果那一區同一套。原本每一行前面掛一個「主」或「客」字,
   讀者要先讀那個字才知道誰在哪邊,而位置本身就講得完 —— 而且兩區各用一套寫法
   (這裡是藥丸、賽果那裡是 vs / @)本來就要讀者記兩種。
   約定寫在區塊抬頭的「左邊主隊」,不是每一行重複一次。 */
export function matchLine(m, me) {
  const when = m.kickoff ? `<span class="cd" data-kickoff="${m.kickoff}"></span>
    <span class="tiny dim">${C.kickoffLocal(m.kickoff)}</span>`
    : `<span class="tiny dim">${C.dateFull(m.date ?? '')}・時間待定</span>`;
  const prob = m.prob
    ? `<span class="tiny">勝 <b>${C.pct(m.prob.win, 0)}</b>・和 ${C.pct(m.prob.draw, 0)}・負 ${C.pct(m.prob.lose, 0)}</span>`
    : `<span class="tiny dim" title="${fvEsc(m.noProbWhy ?? '')}">沒有勝率</span>`;
  const mine = { code: me.code, name: me.name };
  const opp = { code: m.oppCode, crest: m.oppCrest, name: m.oppName };
  const [L, R] = m.home ? [mine, opp] : [opp, mine];
  const nameOf = x => (x.code ? C.name(x.code) : (x.name ?? '待定'));
  /* 一隊一格,格子內 `nowrap`:窄螢幕實測過,不鎖的話換行會切在隊徽與隊名之間 ——
     400px 上出現過「隊徽在上一行、Leeds United 在下一行」,看起來像兩件事。
     破折號跟著左邊那一格走,行尾才不會掉一個沒有對象的符號。 */
  const cell = (x, dash = '') => `<span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap">${
    sideHtml(x, { nameless: x === mine })}${dash}</span>`;
  return `<div class="stat-line fixline" title="${fvEsc(`${nameOf(L)}(主)對 ${nameOf(R)}(客)`)}">
    <span class="small" style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
      ${m.compBadge ?? ''}${cell(L, '<span class="dim tiny">－</span>')}${cell(R)}
      ${m.link ? `<a class="tiny" href="${m.link}">分析 →</a>` : ''}</span>
    <span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap">${prob}${when}</span>
  </div>`;
}

/* 一支球隊一張卡。`pool` 是那個聯賽已經載好的資料。 */
function teamCard(pool, code, extraFixtures) {
  const t = (pool.teams ?? []).find(x => x.code === code);
  const L = C.LEAGUES[pool.lg];
  if (!t) {
    /* 關注的球隊不在這個聯賽的名冊裡 —— 升降級之後會發生(關注英冠的隊,他升上英超了)。
       **不要靜靜拿掉**:讀者會以為自己沒關注過。照實說,並給一個取消的按鈕。 */
    return `<div class="card followcard"><div class="spread">
      <b>${fvEsc(code)}</b>${followStar(pool.lg, code, { label: true })}</div>
      <div class="tiny dim" style="margin-top:6px">這支球隊不在本季的${fvEsc(L?.zh ?? pool.lg)}名冊裡
        —— 多半是升級或降級了。到那個聯賽重新關注一次,或在這裡取消。</div></div>`;
  }
  const cur = t.current ?? null;
  const rec = recentOf(pool.fixtures, code);
  const news = (pool.news ?? []).filter(n => n.team === code).slice(0, 4);

  /* 傷停。**三種狀態,不是兩種** —— 這一條踩過:
       · 沒有球員層的聯賽(Understat 只做五大聯賽、FPL 只有英超,兩者都實測過)
       · 西甲**有**球員層但**沒有傷停來源**(`capabilities.injuries === false`,
         players-core 的 status 743 筆全是 null)
       · 英超兩者都有
     只寫「有沒有人不能上」的話,西甲會印「目前沒有傷停或停賽回報」——
     那是假的:不是沒人傷,是本站查不到。這就是 CLAUDE.md 那條
     「0 是一個看起來很像答案的數字」。 */
  const outList = pool.injurySource
    ? (pool.players ?? []).filter(p => p.team === code && p.status && p.status !== 'a')
    : null;

  const nextAll = [
    ...(pool.next[code] ?? []),
    ...(extraFixtures.get(`${pool.lg}|${code}`) ?? []),
  ].sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey))).slice(0, NEXT_N);

  return `<div class="card followcard">
    <div class="spread" style="align-items:flex-start">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${C.badge(t.code)}
        <a href="${C.link('teams', { code: t.code, league: pool.lg })}"
          style="color:inherit;font-weight:700">${fvEsc(t.en ?? t.code)}</a>
        ${C.compBadge(pool.lg)}
      </div>
      ${followStar(pool.lg, code, { label: true })}
    </div>

    ${cur ? `<div class="row" style="gap:14px;flex-wrap:wrap;margin-top:8px">
      <span class="small">第 <b>${cur.pos}</b> 名</span>
      <span class="small"><b>${cur.pts}</b> 分</span>
      <span class="small dim">${cur.p} 場 ${cur.w}勝 ${cur.d}平 ${cur.l}負・進 ${cur.gf} 失 ${cur.ga}</span>
      ${cur.form?.length ? C.formRun(cur.form) : ''}
    </div>` : '<div class="tiny dim" style="margin-top:8px">本季還沒有積分資料</div>'}

    <div class="section" style="margin-top:12px"><h3 style="margin:0;font-size:14px">接下來</h3>
      <span class="hint">左邊主隊、右邊客隊</span></div>
    ${nextAll.length ? nextAll.map(m => matchLine(m, { code: t.code, name: t.en })).join('')
      : '<div class="tiny dim">賽程上沒有還沒踢的場次。</div>'}

    ${rec.length ? `<div class="section" style="margin-top:12px"><h3 style="margin:0;font-size:14px">最近賽果</h3>
      <span class="hint">左邊主隊、右邊客隊</span></div>
      <div class="row" style="gap:16px;flex-wrap:wrap">${rec.map(f => {
        const home = f.home === code;
        const my = home ? f.fh : f.fa, their = home ? f.fa : f.fh;
        const res = my > their ? 'W' : my < their ? 'L' : 'D';
        /* **比分照主客順序印**(使用者的決定,2026-09-15):主隊隊徽、主隊進球-客隊進球、
           客隊隊徽。原本是「我方比分 + vs / @ + 對手」—— 那要讀者先解讀一個符號,
           而位置本身就講得完。W / L / D 留著:那是**我方的結果**,不是主客符號,
           位置化之後反而更需要它(比分不再是「我方在前」)。 */
        return `<a class="small" href="${C.link('analysis', { id: f.id, league: pool.lg })}"
          title="${fvEsc(`${C.name(f.home)}(主)${f.fh}-${f.fa} ${C.name(f.away)}(客)`)}"
          style="display:inline-flex;align-items:center;gap:5px;text-decoration:none">
          <i class="frm ${res}">${res}</i>${C.badge(f.home)}<span class="mono">${f.fh}-${f.fa}</span>${C.badge(f.away)}</a>`;
      }).join('')}</div>` : ''}

    ${outList === null
      ? `<div class="tiny dim" style="margin-top:12px">${fvEsc(pool.injuryWhy)}</div>`
      : outList.length
        ? `<div class="section" style="margin-top:12px"><h3 style="margin:0;font-size:14px">不能上的人</h3>
            <span class="hint">${outList.length} 人</span></div>
          <div class="tiny">${outList.map(p => `${fvEsc(p.name)}
            <span class="dim">(${fvEsc(p.statusZh ?? p.status)})</span>`).join('、')}</div>`
        : '<div class="tiny dim" style="margin-top:12px">目前沒有傷停或停賽回報。</div>'}

    ${news.length ? `<div class="section" style="margin-top:12px"><h3 style="margin:0;font-size:14px">這支球隊的動態</h3>
        <span class="hint"><a href="${C.link('news', { league: pool.lg })}">全部 →</a></span></div>
      ${news.map(n => `<div class="stat-line"><span class="small">
        <span class="pill tiny">${fvEsc(n.cat)}</span> ${fvEsc(n.title)}</span>
        <span class="tiny dim mono">${C.dateZh(n.date)}</span></div>`).join('')}` : ''}
  </div>`;
}

/* 球隊挑選器:三個聯賽的全部球隊,打勾就關注。 */
function pickerHtml(pools) {
  return pools.map(p => `<div style="margin-top:12px">
    <div class="tiny dim" style="margin-bottom:6px">${C.compBadge(p.lg)} ${fvEsc(C.LEAGUES[p.lg]?.zh ?? p.lg)}
      <span class="dim">(${(p.teams ?? []).length} 隊)</span></div>
    <div class="row" style="gap:6px;flex-wrap:wrap">
      ${(p.teams ?? []).slice().sort((a, b) => String(a.en).localeCompare(String(b.en)))
        .map(t => `<span class="pickteam">${followStar(p.lg, t.code)}
          <span class="small">${C.badge(t.code)} ${fvEsc(t.en ?? t.code)}</span></span>`).join('')}
    </div></div>`).join('');
}

export async function renderFollowTeams(host) {
  host.innerHTML = '<div class="loading">載入資料中…</div>';

  /* 三個聯賽的基本資料。**meta 先拿到才知道要不要去要 players-core** ——
     這一份在這裡只有一個用途:傷停名單(下面的 outList)。所以條件是**有沒有傷停來源**,
     不是「有沒有球員層」:西甲有球員層但傷停欄位全是 null、英冠 2026-09-15 起有球員層但沒有 players-core,
     兩個聯賽照舊條件都會去要一份用不到的檔,英冠那次還是個 404 —— 預期中的 404 會在 console 留一串
     自己造成的錯誤,看起來像出了事。 */
  /* **賽事標籤要先註冊才會是圖示。** `compBadge` 有 logo 就畫真圖、沒有就退回
     色塊 + 縮寫(EFL / PL / UCL / LL)—— 而 logo 在 `competitions.json` 裡,
     沒有 `registerCompetitions` 的話**每一頁都是退回那個縮寫色塊**,
     而總覽與盃賽頁有註冊所以是圖,同一個東西兩頁長得不一樣(使用者 2026-09-15 回報)。
     這一份只有 34 KB,所以跟第一批一起載 —— 晚一步的話第一次繪製會先閃一次色塊。 */
  try {
    const { data } = await C.loadFrom('pl', ['competitions']);
    C.registerCompetitions(data.competitions);
  } catch { /* 註冊不到就退回縮寫色塊,不擋整頁 */ }

  const pools = [];
  for (const lg of FOLLOW_LEAGUES) {
    try {
      const { data } = await C.loadFrom(lg, ['meta', 'teams', 'fixtures', 'news']);
      if (!data.meta || !Array.isArray(data.teams)) continue;
      let players = null;
      if (data.meta.capabilities?.players !== false && data.meta.capabilities?.injuries !== false) {
        const core = await C.loadFrom(lg, ['players-core']).catch(() => ({ data: {} }));
        players = Array.isArray(core.data['players-core']) ? core.data['players-core'] : null;
      }
      const next = {};
      for (const t of data.teams) {
        next[t.code] = nextLeagueMatches(data.fixtures, t.code).map(f => {
          const home = f.home === t.code;
          const p = f.prediction;
          return {
            sortKey: f.kickoff ?? `${f.date ?? '9999-99-99'}T99:99`,
            kickoff: f.kickoff ?? null, date: f.date ?? null, home,
            oppCode: home ? f.away : f.home, oppName: null, oppCrest: null,
            compBadge: C.compBadge(lg),
            link: C.link('analysis', { id: f.id, league: lg }),
            prob: p ? { win: home ? p.home : p.away, draw: p.draw, lose: home ? p.away : p.home } : null,
            noProbWhy: '這一場還沒有模型機率',
          };
        });
      }
      /* 這個聯賽有沒有傷停來源,以及沒有的話原因是什麼。**原因要分得出兩種** ——
         「沒有球員層」與「有球員層但沒有傷停欄位」對讀者的意思不同。 */
      const noPlayers = data.meta.capabilities?.players === false;
      const injurySource = !noPlayers && data.meta.capabilities?.injuries !== false;
      const injuryWhy = noPlayers
        ? `${C.LEAGUES[lg]?.zh ?? lg}沒有球員級的資料源,所以這裡沒有傷停名單 —— 不是還沒抓,是拿不到(Understat 不涵蓋這個聯賽、FPL 只有英超,兩者都實測過)。`
        /* 這一句是**純文字**(它走 esc() 進畫面):不要用 `**強調**` ——
           前端沒有 Markdown 處理器,星號會原樣印出來(CLAUDE.md 那條坑),
           而且 npm test 有一條掃原始碼的守著。 */
        : `${C.LEAGUES[lg]?.zh ?? lg}有球員資料,但沒有傷停來源,所以這裡不列名單。空著不代表全隊都能上,是本站查不到。`;
      pools.push({ lg, meta: data.meta, teams: data.teams, fixtures: data.fixtures,
        news: Array.isArray(data.news) ? data.news : [], players, next, injurySource, injuryWhy });
      C.registerTeams(data.teams);
    } catch { /* 某個聯賽載不到就少那一段,不要整頁掛掉 */ }
  }
  if (!pools.length) { host.innerHTML = '<div class="note warn">三個聯賽的資料都載不到。</div>'; return; }

  /* 盃賽與歐冠的場次晚一步併進來(見檔頭第 1 點)。先給一張空表,拿到再重畫。 */
  let extra = new Map();

  const draw = () => {
    const follows = readFollows().filter(f => FOLLOW_LEAGUES.includes(f.lg));
    const cards = follows.map(f => {
      const pool = pools.find(p => p.lg === f.lg);
      return pool ? teamCard(pool, f.code, extra) : '';
    }).join('');

    host.innerHTML = `
      <div class="card">
        <div class="spread"><b>我的球隊</b>
          <span class="tiny dim">${follows.length ? `關注 ${follows.length} 支` : '還沒有關注任何球隊'}</span></div>
        <div class="tiny dim" style="margin-top:6px">${fvEsc(FOLLOW_STORAGE_NOTE)}</div>
        ${follows.length > SOFT_LIMIT ? `<div class="note warn" style="margin-top:8px">
          你關注了 ${follows.length} 支。<b>關注太多等於沒有關注</b> ——
          積分榜、實時戰況與賽程上的重點標記會佈滿整頁,那正是這個功能想解決的事。
          底下這幾張卡照樣全列,只是提醒一下。</div>` : ''}
      </div>

      ${follows.length ? cards : `<div class="note" style="margin-top:12px">
        還沒有關注任何球隊。<b>在下面打勾</b>,或到任何一支球隊的頁面按標題旁邊的 ☆。
        關注之後:首頁的積分榜會把你的球隊標出來、實時戰況會把你的比賽排到最上面、
        動態可以只看你的球隊、賽程與盃賽的場次會加上 ★。</div>`}

      <div class="section" style="margin-top:22px"><h2>選球隊</h2>
        <span class="hint">三個聯賽共 ${pools.reduce((a, p) => a + (p.teams?.length ?? 0), 0)} 支・點 ☆ 加入、點 ★ 取消</span></div>
      <div class="card">${pickerHtml(pools)}</div>

      <div class="section" style="margin-top:22px"><h2>帶著走</h2>
        <span class="hint">換裝置或換瀏覽器時用</span></div>
      <div class="card">
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button class="btn" type="button" id="fvExport">匯出關注名單</button>
          <label class="btn" style="cursor:pointer">匯入<input type="file" id="fvImport" accept="application/json" hidden></label>
          <button class="btn" type="button" id="fvClear">全部清除</button>
        </div>
        <div class="tiny dim" style="margin-top:8px" id="fvMsg">匯出的是一個小 JSON 檔,
          裡面只有「聯賽 + 隊碼」,沒有任何個人資料。</div>
      </div>`;

    C.startCountdowns();
  };

  draw();
  bindFollowStars(host, draw);

  /* 匯出/匯入/清除。**匯入要驗形狀**:別的檔案丟進來不能讓這一頁壞掉。 */
  host.addEventListener('click', e => {
    const msg = document.getElementById('fvMsg');
    if (e.target.id === 'fvExport') {
      const blob = new Blob([JSON.stringify({ v: 1, teams: readFollows() }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `warroom-follow-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    if (e.target.id === 'fvClear') {
      if (writeFollows([])) draw();
      else if (msg) msg.textContent = '這個瀏覽器不讓本站儲存資料,清不掉。';
    }
  });
  host.addEventListener('change', async e => {
    if (e.target.id !== 'fvImport') return;
    const msg = document.getElementById('fvMsg');
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      const list = (Array.isArray(obj) ? obj : obj?.teams ?? [])
        .filter(t => FOLLOW_LEAGUES.includes(t?.lg) && typeof t?.code === 'string');
      if (!list.length) throw new Error('檔案裡沒有看得懂的關注紀錄');
      if (!writeFollows(list)) throw new Error('這個瀏覽器不讓本站儲存資料');
      draw();
      if (msg) msg.textContent = `匯入了 ${list.length} 支球隊。`;
    } catch (err) {
      if (msg) msg.textContent = `匯入失敗:${err.message}`;
    }
  });

  /* 盃賽與歐冠(晚一步)。拿到而且有東西才重畫 —— 沒有的話畫面維持聯賽那一份,
     不要為了一個空結果再閃一次。 */
  try {
    const { data } = await C.loadFrom('pl', ['cups', 'ucl', 'ucl-elo', 'ucl-teams']);
    const found = new Map();
    const push = (lg, code, row) => {
      const k = `${lg}|${code}`;
      if (!found.has(k)) found.set(k, []);
      found.get(k).push(row);
    };
    /* 英格蘭盃賽:只有英超與英冠的球隊會出現。走整份找,不列舉輪次 ——
       列舉的話以後多一個區塊就會有一批場次靜靜掉隊。 */
    for (const cup of data.cups?.cups ?? []) {
      const season = (cup.seasons ?? []).find(s => s.current);
      for (const r of season?.rounds ?? []) for (const m of r.matches ?? []) {
        if (m.played) continue;
        for (const side of ['home', 'away']) {
          const code = m[side]?.code;
          if (!code) continue;
          const opp = m[side === 'home' ? 'away' : 'home'];
          for (const lg of ['pl', 'en2']) {
            if (!pools.some(p => p.lg === lg && p.teams.some(t => t.code === code))) continue;
            push(lg, code, {
              sortKey: m.kickoff ?? `${String(m.kickoff ?? '').slice(0, 10) || '9999-99-99'}T99:99`,
              kickoff: m.kickoff ?? null, date: String(m.kickoff ?? '').slice(0, 10) || null,
              home: side === 'home', oppCode: opp?.code ?? null, oppName: opp?.name ?? null,
              // 本站沒有隊碼的盃賽對手(第三、四級球隊)在 cups.json 的 crests 查表裡有圖
              oppCrest: opp?.code ? null : (data.cups?.crests?.[opp?.sourceId] ?? null),
              compBadge: C.compBadge(cup.key), link: C.link('cups', { cup: cup.key }),
              prob: null,
              /* 盃賽沒有預測,而且**原因要講得出來** —— 空著的話讀者會以為壞了 */
              noProbWhy: '盃賽沒有本站的勝率預測:對手一半是第三、四級球隊,本站沒有它們的賽果,評不出強度',
            });
          }
        }
      }
    }
    /* 歐冠:兩隊都有跨聯賽評分的場次才有機率(回測通過才有,沒通過就一場都沒有)。 */
    const eloBy = new Map((data['ucl-elo']?.fixtures ?? []).map(f => [f.id, f.p]));
    /* 歐冠對手的隊徽:本站認得的在 `teams`、不認得的(Lille 這種)在 `external`,
       鍵是來源方的 team id。跟總覽頁的 `uclCrest` 同一條 —— 那裡早就做對了。 */
    const uclKnown = new Map((data['ucl-teams']?.teams ?? []).map(t => [t.code, t]));
    const uclExternal = new Map((data['ucl-teams']?.external ?? []).map(t => [t.id, t.crest]));
    const uclCrest = side => (side?.code ? uclKnown.get(side.code)?.crest : uclExternal.get(side?.id)) ?? null;
    const uclSeason = (data.ucl?.seasons ?? []).find(s => s.current);
    /* **走整份**(2026-09-15):淘汰賽的場次在 `rounds[].ties[].legs[]`,
       只讀 leagueMatches 的話二月起每一場淘汰賽都會從「接下來」靜靜掉隊 ——
       本季 rounds 現在是 0,所以今天看不出差別,而那正是它危險的地方。 */
    for (const m of C.uclSeasonMatches(uclSeason)) {
      if (m.played) continue;
      for (const side of ['home', 'away']) {
        const code = m[side]?.code;
        if (!code) continue;
        const opp = m[side === 'home' ? 'away' : 'home'];
        const p = eloBy.get(m.id);
        const home = side === 'home';
        for (const lg of FOLLOW_LEAGUES) {
          if (!pools.some(x => x.lg === lg && x.teams.some(t => t.code === code))) continue;
          push(lg, code, {
            sortKey: m.kickoff ?? '9999-99-99T99:99',
            kickoff: m.kickoff ?? null, date: String(m.kickoff ?? '').slice(0, 10) || null,
            home, oppCode: opp?.code ?? null, oppName: opp?.name ?? null,
            oppCrest: opp?.code ? null : uclCrest(opp),
            compBadge: C.compBadge('ucl'), link: C.link('ucl-match', { id: m.id }),
            prob: Array.isArray(p) ? { win: home ? p[0] : p[2], draw: p[1], lose: home ? p[2] : p[0] } : null,
            noProbWhy: '這一場歐冠沒有勝率:跨聯賽評分只給兩隊都評得出強度的場次',
          });
        }
      }
    }
    if (found.size) { extra = found; draw(); }
  } catch { /* 盃賽/歐冠載不到就只顯示聯賽場次,不擋 */ }
}
