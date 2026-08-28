import * as C from './core.js?v=77b5da80';

const app = document.getElementById('app');

// 盃賽對手的隊徽查表(sourceId → data URI),載入資料後填入
let CUP_CRESTS = {};

/* 盃賽頁。三件事跟聯賽頁不一樣,而且都會影響怎麼寫:

   1. **一百多支球隊,本站只認得英超那 20 支。** 認不得的只給名字,
      不掛隊徽也不給連結 —— 不編一個假的身分(鐵則三)。涵蓋率直接標在畫面上。
   2. **沒有預測。** 盃賽要另一套模型(延長、PK、實力差距極大的對戰),
      現有的 Dixon-Coles 沒有在盃賽上驗收過。沒有回測證據就不上(鐵則二),
      所以這一頁只有賽果,而且要講清楚為什麼沒有預測。
   3. **比分有三層**:90 分鐘、延長後、PK。只顯示最終比分會把
      「1-1 PK 5-4」講成「1-1」—— 那不是少一個欄位,是把冠軍講錯。 */

const KO = m => (m.kickoff ? C.kickoffLocal(m.kickoff) : '待定');

// 認得的球隊給隊徽與連結,認不得的只給名字。這個分岔是整頁最常出現的東西
function teamCell(t, { align = 'left' } = {}) {
  if (!t) return '<span class="dim small">待定</span>';
  const name = C.esc(t.name ?? '');
  /* 本站認不得的球隊:**有隊徽就畫隊徽,但仍然沒有連結**。
     隊徽是那支球隊真實的徽章(上游給的),畫出來不是編身分;
     但本站沒有它的資料,所以點不進去 —— 這兩件事要分開,
     不能因為有圖就假裝我們有這一隊(鐵則三)。 */
  if (!t.code) {
    /* 層級標籤。**退回別季的一定要標出賽季** —— 球隊每年升降級,
       上游本季只發布到英冠,英甲英乙只有上一季的名單。
       不標的話就是拿去年的事實講今年。 */
    const tier = t.tier
      ? `<span class="pill tiny${t.tierNo >= 3 ? ' warn' : ''}" title="${
          t.tierSeason ? `${t.tierSeason} 賽季的層級(上游還沒有本季的英甲/英乙名單)` : '當季層級'}"
          >${t.tier}${t.tierSeason ? `·${t.tierSeason.slice(2)}` : ''}</span>`
      : '';
    // 隊徽在 cups.json 的查表裡(一支球隊一份),不是掛在每一個球隊格上
    const img = CUP_CRESTS[t.sourceId]
      ? `<img class="crest" src="${CUP_CRESTS[t.sourceId]}" alt="${name}" title="${name}" loading="lazy" width="26" height="26">`
      : '';
    if (!img && !tier) return `<span class="small" style="text-align:${align}">${name}</span>`;
    return `<span class="small" style="display:inline-flex;align-items:center;gap:5px;text-align:${align};flex-direction:${
      align === 'right' ? 'row-reverse' : 'row'}">${img}<span>${name}</span>${tier}</span>`;
  }
  return `<a class="small" href="${C.link('teams', { code: t.code })}"
    style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;flex-direction:${align === 'right' ? 'row-reverse' : 'row'}"
    >${C.badge(t.code)}<span>${C.name(t.code)}</span></a>`;
}

/* 比分。規則:
   未賽 → 開球時間;已賽 → 最終比分,再視情況補「延長」與「PK」。
   90 分鐘比分只有在打過延長時才另外顯示 —— 沒打延長時它跟最終比分一樣,
   印兩次只是噪音。 */
function scoreCell(m) {
  if (!m.played) return `<span class="dim small mono">${KO(m)}</span>`;
  const f = m.final ?? [null, null];
  const bits = [`<b class="mono" style="font-size:14px">${f[0]} - ${f[1]}</b>`];
  if (m.aet === true && m.ft90) {
    bits.push(`<span class="pill tiny" title="90 分鐘結束時 ${m.ft90[0]}-${m.ft90[1]},延長賽後 ${f[0]}-${f[1]}">延長</span>`);
  }
  if (m.pens) {
    bits.push(`<span class="pill accent tiny" title="PK 大戰">PK ${m.pens[0]}-${m.pens[1]}</span>`);
  }
  return `<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">${bits.join('')}</span>`;
}

const winner = m => {
  if (!m.played) return null;
  if (m.pens) return m.pens[0] === m.pens[1] ? null : (m.pens[0] > m.pens[1] ? 'home' : 'away');
  if (!m.final || m.final[0] === m.final[1]) return null;
  return m.final[0] > m.final[1] ? 'home' : 'away';
};

function roundCard(round) {
  const rows = round.matches.map(m => {
    const w = winner(m);
    const strong = side => (w === side ? 'font-weight:700' : w ? 'opacity:.62' : '');
    return `<div class="stat-line" style="gap:10px;align-items:center">
      <span style="flex:1;text-align:right;${strong('home')}">${teamCell(m.home, { align: 'right' })}</span>
      <span style="min-width:132px;text-align:center">${scoreCell(m)}</span>
      <span style="flex:1;${strong('away')}">${teamCell(m.away)}</span>
    </div>`;
  }).join('');
  const marks = [
    round.played < round.total ? `${round.played}/${round.total} 場已賽` : `${round.total} 場`,
    round.aet ? `延長 ${round.aet}` : '',
    round.shootouts ? `PK ${round.shootouts}` : '',
  ].filter(Boolean).join('・');
  return `<div class="card" style="margin-top:12px">
    <div class="spread"><h3 style="margin:0">${C.esc(round.stage)}</h3>
      <span class="dim tiny">${marks}</span></div>
    <div style="display:grid;gap:2px;margin-top:10px">${rows}</div>
  </div>`;
}

/* 資格賽的開關。足總盃從第九級打起 —— 2025-26 整季 871 場、745 支球隊,
   英超球隊要到第三輪才進場。預設從「第一個有本站球隊的輪次」開始,
   但**資格賽不刪掉**:那是真實發生過的比賽,只是收起來。
   收起來這件事本身要講出來,不然讀者會以為本站只有半個賽事。 */
/* 預設要顯示哪幾輪。三種情況:
     展開資格賽        → 全部
     本站球隊還沒進場  → **只留最新一輪**(整季都是資格賽,全攤開是 533 場)
     一般              → 從第一個有本站球隊的輪次開始 */
function visibleRounds(season, showQual) {
  if (showQual) return season.rounds;
  if (season.noKnownYet) return season.rounds.slice(-1);
  return season.rounds.slice(season.firstKnownRound > 0 ? season.firstKnownRound : 0);
}

function qualifyingToggle(season) {
  if (!season.qualifyingRounds) return '';
  if (season.noKnownYet) {
    return `<div class="note" style="margin-top:12px">
      <b>這一季本站的球隊還沒進場。</b>足總盃從低級別聯賽一路打上來,英超球隊要到<b>第三輪</b>才加入;
      目前打完的 ${season.qualifyingRounds} 輪(共 ${season.qualifyingMatches} 場)<b>全部是資格賽</b>。
      這些場次<b>有抓到、也沒有刪掉</b>,只是預設只顯示最新一輪 ——
      全部攤開是幾百場第九級的比賽,滑不完也不是讀者要看的。
      <button class="btn tiny" id="toggleQual" style="margin-left:8px">${
        season.__showQual ? '只看最新一輪' : `展開全部 ${season.qualifyingRounds} 輪`}</button>
    </div>`;
  }
  return `<div class="note" style="margin-top:12px">
    <b>前 ${season.qualifyingRounds} 輪是資格賽</b>(共 ${season.qualifyingMatches} 場)——
    足總盃從低級別聯賽一路打上來,英超球隊要到後面的輪次才進場。
    這些場次<b>有抓到、也沒有刪掉</b>,只是預設收起來。
    <button class="btn tiny" id="toggleQual" style="margin-left:8px">${
      season.__showQual ? '收起資格賽' : '展開資格賽'}</button>
  </div>`;
}

function championCard(champ, cupName, seasonLabel) {
  if (!champ) return '';
  const m = champ.match;
  /* 比分要從**冠軍的角度**寫。第一版直接印 final[0]-final[1],
     決賽是「Chelsea 0-1 Manchester City」時就變成
     「Manchester City 擊敗 Chelsea 0-1」—— 讀起來像曼城輸了。
     所以下面把勝方的進球放前面,另外把主客場照實寫出來。 */
  const w = winner(m);
  const score = m.final ? (w === 'away' ? `${m.final[1]}-${m.final[0]}` : `${m.final[0]}-${m.final[1]}`) : '';
  const pens = m.pens ? (w === 'away' ? `${m.pens[1]}-${m.pens[0]}` : `${m.pens[0]}-${m.pens[1]}`) : null;
  return `<div class="note ok" style="margin-top:12px">
    <b>${seasonLabel} ${cupName}冠軍:${C.esc(champ.team?.name ?? '')}</b>
    ${champ.team?.code ? C.badge(champ.team.code) : ''}
    <div class="small" style="margin-top:4px">${C.esc(champ.stage)}・
      ${score} 擊敗 ${C.esc(champ.runnerUp?.name ?? '')}${
        m.aet === true ? '(延長賽)' : ''}${pens ? `,PK ${pens}` : ''}
      <span class="dim tiny">(該場 ${C.esc(m.home?.name ?? '')} ${m.final ? m.final.join('-') : ''} ${C.esc(m.away?.name ?? '')})</span></div>
  </div>`;
}

/* 英超球隊走到哪一輪。認不得的球隊不進這張表 —— 它們沒有本站身分,列了也點不進去。
   「場次」只算**已完賽**的。第一版把已排定但還沒踢的也算進去,
   於是利物浦一場還沒開打的第三輪比賽被顯示成「1 場 0 勝」——
   讀者會以為他們踢過而且沒贏。未賽不是 0 勝,是還沒發生。 */
function runsTable(runs) {
  if (!runs.length) return '';
  const status = r => {
    if (r.out) return `<span class="pill tiny" style="color:var(--loss)">${C.esc(r.out)}出局</span>
      <span class="tiny dim">輸給 ${C.esc(r.outTo ?? '')}</span>`;
    if (r.nextStage) return `<span class="pill accent tiny">晉級 ${C.esc(r.nextStage)}</span>
      <span class="tiny dim">${r.nextKickoff ? C.kickoffLocal(r.nextKickoff) : '時間待定'}
      ${r.nextOpp ? `・對 ${C.esc(r.nextOpp)}` : ''}</span>`;
    return '<span class="dim small">—</span>';
  };
  return C.table(runs, [
    { key: 'team', label: '球隊', value: r => C.name(r.code), render: r => C.teamCell(r.code) },
    { key: 'stage', label: '打到哪一輪', value: r => r.lastPlayedOrder, num: true,
      title: '最後一場**已完賽**比賽所在的輪次',
      render: r => `<span class="mono small">${C.esc(r.lastPlayedStage ?? '尚未出賽')}</span>` },
    { key: 'played', label: '已賽', value: r => r.played, num: true },
    { key: 'wins', label: '勝場', value: r => r.wins, num: true,
      title: 'PK 大戰勝出也算勝場 —— 盃賽的晉級就是這樣算的' },
    { key: 'status', label: '目前狀態', value: r => (r.out ? 0 : r.nextStage ? 2 : 1), sortable: false, left: true,
      render: status },
  ], { sortKey: 'stage', desc: true, onRow: r => C.go('teams', { code: r.code }) });
}

try {
  const { meta, clubs, teams, cups } = await C.load('meta', 'clubs', 'teams', 'cups');
  CUP_CRESTS = cups?.crests ?? {};
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const list = cups?.cups ?? [];
  if (!list.length) {
    app.innerHTML = `<div class="page-head"><h1>英格蘭盃賽</h1></div>
      <div class="note">目前沒有盃賽資料。</div>${C.foot(meta)}`;
  } else {
    let cupKey = list[0].key;
    // 預設看有比賽的那一季 —— 本季開打前所有場次都還沒踢,預設停在空白的一季很奇怪
    const seasonsOf = key => (list.find(c => c.key === key)?.seasons ?? []);
    const defaultSeason = key => {
      const ss = seasonsOf(key);
      return (ss.find(s => s.played > 0) ?? ss[0])?.label ?? null;
    };
    let seasonLabel = defaultSeason(cupKey);
    let showQualifying = false;   // 資格賽預設收起來,但可以打開

    app.innerHTML = `
    <div class="page-head">
      <h1>英格蘭盃賽</h1>
      <p>足總盃與聯賽盃的逐輪賽果。盃賽跟聯賽不一樣的地方這一頁都照實顯示:
         <b>延長賽</b>後的比分、<b>PK 大戰</b>的結果,以及每支英超球隊走到了哪一輪。</p>
      ${C.stampRow([
        C.stamp('盃賽賽果', { iso: cups.retrievedAt, kind: 'daily', note: `SportMonks・${list.map(c => c.zh).join('與')}` }),
      ])}
    </div>
    <div class="filters" style="align-items:end">
      ${list.map(c => `<button class="btn${c.key === cupKey ? ' on' : ''}" data-cup="${c.key}">${c.zh}</button>`).join('')}
      <label class="small" style="display:grid;gap:5px;min-width:150px">
        <span class="muted">賽季</span><select id="season"></select></label>
      <span class="dim small" id="count"></span>
    </div>
    <div id="body"></div>
    <div class="note info" style="margin-top:14px">
      <b>這一頁沒有勝率預測,這是刻意的。</b>
      本站的模型是用聯賽比賽調出來的,而盃賽有三件它沒見過的事:<b>延長賽</b>、
      <b>PK 大戰</b>,以及<b>英超打非聯賽球隊</b>這種實力差距極大的對戰。
      沒有在盃賽上跑過走查回測就把聯賽模型套上去,出來的機率是編的 ——
      那正是本站第二條鐵則在擋的東西。要做就得另外驗收一套,
      <a href="${C.link('model')}">模型驗證頁</a>寫著現有模型驗過什麼、沒驗過什麼。
    </div>
    <div class="note" style="margin-top:10px" id="coverage"></div>
    ${C.foot(meta)}`;

    const render = () => {
      const cup = list.find(c => c.key === cupKey);
      const seasons = cup.seasons ?? [];
      const sel = document.getElementById('season');
      sel.innerHTML = seasons.map(s => `<option value="${s.label}"${s.label === seasonLabel ? ' selected' : ''}
        >${s.label}${s.current ? '(本季)' : ''}</option>`).join('');
      const season = seasons.find(s => s.label === seasonLabel) ?? seasons[0];
      if (!season) {
        document.getElementById('body').innerHTML = '<div class="note">這個盃賽目前沒有可顯示的賽季。</div>';
        document.getElementById('count').textContent = '';
        document.getElementById('coverage').innerHTML = '';
        return;
      }
      document.getElementById('count').textContent =
        `${season.total} 場・已完賽 ${season.played}・延長 ${season.aet}・PK ${season.shootouts}`;
      document.getElementById('body').innerHTML = `
        ${championCard(season.champion, cup.zh, season.label)}
        ${season.runs.length ? `<div class="section"><h2>英超球隊走到哪一輪</h2>
          <span class="hint">只列本站認得的球隊・共 ${season.runs.length} 支</span></div>
          <div id="runs"></div>` : ''}
        ${qualifyingToggle({ ...season, __showQual: showQualifying })}
        <div class="section"><h2>逐輪賽果</h2>
          <span class="hint">最新的排在最上面(決賽 → 第一輪)・輪次順序依開球時間,不是照上游的輪次編號</span></div>
        ${/* **先切再倒。** 資格賽是用「從第幾輪開始」這個索引切掉的;
              先倒過來的話那個索引指的就變成另一頭,會把決賽那幾輪切掉。 */''}
        ${visibleRounds(season, showQualifying).slice().reverse().map(roundCard).join('')}`;
      const runsEl = document.getElementById('runs');
      if (runsEl) runsEl.innerHTML = runsTable(season.runs);
      const qualBtn = document.getElementById('toggleQual');
      if (qualBtn) qualBtn.onclick = () => { showQualifying = !showQualifying; render(); };

      const unknownTeams = season.teamsTotal - season.teamsKnown;
      document.getElementById('coverage').innerHTML = `
        <b>球隊涵蓋率:${season.teamsKnown} / ${season.teamsTotal} 支有本站資料。</b>
        盃賽從低級別聯賽一路打上來,這一季有 ${unknownTeams} 支球隊本站沒有 ——
        它們照樣出現在賽程裡,但<b>只有名字,沒有隊徽也點不進去</b>。
        不替它們編一個隊碼或找一張像的隊徽,那會讓讀者以為本站有它們的資料。
        ${season.unknownDescriptions?.length
          ? `<div style="margin-top:6px;color:var(--loss)">⚠ 上游出現沒見過的比分類別:
             ${season.unknownDescriptions.map(C.esc).join('、')} —— 這些場次的比分可能不完整,已記錄待核對。</div>`
          : ''}`;
    };

    document.querySelectorAll('[data-cup]').forEach(b => {
      b.onclick = () => {
        cupKey = b.dataset.cup;
        seasonLabel = defaultSeason(cupKey);
        document.querySelectorAll('[data-cup]').forEach(x => x.classList.toggle('on', x === b));
        render();
      };
    });
    document.getElementById('season').onchange = e => { seasonLabel = e.target.value; render(); };
    render();
  }
} catch (err) { C.fail(err); }
