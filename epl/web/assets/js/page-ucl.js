import * as C from './core.js?v=cef0959b';

const app = document.getElementById('app');

/* 歐冠頁。跟聯賽頁不一樣、而且會影響怎麼寫的四件事:

   1. **這一頁跨聯賽。** 英超與西甲兩邊看到的是同一份 ucl.json(build 與
      build-laliga 呼叫同一個 lib/ucl.mjs)。所以球隊連結要指到**認得它的那個聯賽**,
      隊徽則只有在目前這個聯賽的資料集裡才端得出來 —— 從英超頁看皇馬,
      C.team('RMA') 會退回一個灰方塊寫著 RMA,那看起來像壞掉,所以不畫。

   2. **一季 36 隊,本站只認得其中 8~11 支。** 認不得的只給名字,
      不掛隊徽也不給連結(鐵則三)。涵蓋率直接寫在畫面上。

   3. **沒有預測。** 現有模型是用聯賽比賽調的,沒有在歐冠上驗收過 ——
      跨聯賽實力差距、兩回合制、延長與 PK 都是它沒見過的。沒有回測證據就不上(鐵則二)。

   4. **比分有三層**:90 分鐘、延長後、PK。而且上游的 fullTime 在 PK 場
      是**含 PK 的累加值**,直接印會把 2025-26 決賽寫成「PSG 5-4 Arsenal」
      (實際是 1-1、PK 4-3)。轉換在 adapter 做完了,這一頁只負責把三層都顯示出來。 */

const KO = m => (m.kickoff ? C.kickoffLocal(m.kickoff) : '待定');

/* 本站**兩個聯賽加起來**認不認得這個隊碼。
   以前這裡只看目前這個聯賽,於是同一頁在英超與西甲會長得不一樣:
   Barcelona 在英超頁叫上游給的 `Barça`、沒有隊徽,在西甲頁才是 `FC Barcelona` ——
   而標題寫著「英超與西甲・共 11 支」。現在名字與隊徽走跨聯賽的 ucl-teams.json,
   兩頁一致。**界線沒變**:PSG、Bayern 這些本站真的沒有的,
   照舊只給上游的名字、不畫隊徽(畫一個灰方塊寫代號看起來像壞掉)。 */
const registered = code => !!code && C.team(code).en !== code;

/* 本站認不得的球隊的隊徽,key 是 football-data 的 team id。
   由 mount 時填入(ucl-teams.json 的 external)。
   **有隊徽不等於有球隊頁** —— 這一組只畫圖,不給連結;
   連到一個空頁比不連更糟(鐵則三)。 */
let externalCrest = new Map();

function teamCell(t, { align = 'left', strong = false } = {}) {
  if (!t?.name) return '<span class="dim small">待定</span>';
  const label = C.esc(registered(t.code) ? C.name(t.code) : t.name);
  const weight = strong ? 'font-weight:700' : '';
  if (!t.code) {
    const crest = externalCrest.get(t.id);
    const dir2 = align === 'right' ? 'row-reverse' : 'row';
    if (!crest) return `<span class="small" style="${weight}">${label}</span>`;
    return `<span class="small" style="display:inline-flex;align-items:center;gap:6px;flex-direction:${dir2};${weight}"
      ><img class="crest" src="${crest}" alt="${label}" title="${label}" loading="lazy" width="26" height="26"><span>${label}</span></span>`;
  }
  const dir = align === 'right' ? 'row-reverse' : 'row';
  return `<a class="small" href="${C.link('teams', { code: t.code, league: t.league ?? undefined })}"
    style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;flex-direction:${dir};${weight}"
    >${registered(t.code) ? C.badge(t.code) : ''}<span>${label}</span></a>`;
}

/* 一場比賽的比分。規則:
   未賽 → 開球時間;已賽 → 這一場踢完的比分,再視情況補「延長」與「PK」。
   90 分鐘比分只有打過延長時才另外顯示(沒打延長時它跟最終比分一樣,印兩次只是噪音)。 */
function scoreCell(m) {
  if (!m.played) return `<span class="dim small mono">${KO(m)}</span>`;
  if (!m.final) {
    // adapter 遇到沒見過的 duration 就不給比分 —— 寧可不顯示也不顯示可能是累加值的數字
    return '<span class="pill warn tiny" title="上游的比分類別本站沒核對過">比分待核對</span>';
  }
  const bits = [`<b class="mono" style="font-size:14px">${m.final[0]} - ${m.final[1]}</b>`];
  if (m.aet === true && m.ft90) {
    bits.push(`<span class="pill tiny" title="90 分鐘 ${m.ft90[0]}-${m.ft90[1]},延長賽後 ${m.final[0]}-${m.final[1]}">延長</span>`);
  }
  if (m.pens) bits.push(`<span class="pill accent tiny" title="PK 大戰">PK ${m.pens[0]}-${m.pens[1]}</span>`);
  return `<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">${bits.join('')}</span>`;
}

const legLabel = (m, i, twoLegged) => (twoLegged ? `第 ${i + 1} 回合` : '單場');

/* 一組對決(兩回合,決賽是一場)。
   總比分放最上面 —— 兩回合制看的是總比分,不是任一場的比分。 */
function tieCard(tie) {
  const [A, B] = tie.teams;
  const winA = tie.winner === A.id, winB = tie.winner === B.id;
  const agg = tie.aggregate
    ? `<b class="mono" style="font-size:15px">${tie.aggregate[0]} - ${tie.aggregate[1]}</b>`
    : '<span class="dim small">未完成</span>';
  const marks = [
    tie.twoLegged ? '總比分' : '',
    tie.decidedBy === 'penalties' ? `PK ${tie.pens ? tie.pens.join('-') : ''} 分勝負` : '',
    tie.aet && tie.decidedBy !== 'penalties' ? '延長賽分勝負' : '',
  ].filter(Boolean).join('・');
  const legs = tie.legs.map((m, i) => `
    <div class="stat-line" style="gap:10px;align-items:center">
      <span class="tiny dim" style="min-width:78px">${legLabel(m, i, tie.twoLegged)}</span>
      <span style="flex:1;text-align:right">${teamCell(m.home, { align: 'right' })}</span>
      <span style="min-width:128px;text-align:center">${scoreCell(m)}</span>
      <span style="flex:1">${teamCell(m.away)}</span>
      <span class="tiny dim" style="min-width:96px;text-align:right">${m.played ? KO(m) : ''}</span>
    </div>`).join('');
  return `<div class="card" style="margin-top:10px">
    <div class="spread" style="gap:10px;align-items:center">
      <span style="flex:1;text-align:right">${teamCell(A, { align: 'right', strong: winA })}</span>
      <span style="min-width:96px;text-align:center">${agg}</span>
      <span style="flex:1">${teamCell(B, { strong: winB })}</span>
    </div>
    ${marks ? `<div class="tiny dim center" style="margin-top:4px">${marks}</div>` : ''}
    <div style="display:grid;gap:2px;margin-top:8px">${legs}</div>
  </div>`;
}

function championCard(champ, seasonLabel) {
  if (!champ) return '';
  const m = champ.match;
  /* 比分從**冠軍的角度**寫。直接印 final[0]-final[1] 的話,客隊奪冠會變成
     「某某隊 0-1 擊敗某某隊」—— 讀起來像冠軍輸了。 */
  const line = champ.pens
    ? `${champ.score.join('-')}${champ.aet ? '(延長賽後)' : ''},PK ${champ.pens.join('-')} 擊敗`
    : `${champ.score.join('-')}${champ.aet ? '(延長賽)' : ''} 擊敗`;
  return `<div class="note ok" style="margin-top:12px">
    <b>${seasonLabel} 歐冠冠軍:${C.esc(champ.team.name)}</b>
    ${registered(champ.team.code) ? C.badge(champ.team.code) : ''}
    <div class="small" style="margin-top:4px">決賽・${line} ${C.esc(champ.runnerUp.name)}
      <span class="dim tiny">(該場 ${C.esc(m.home.name)} ${m.final ? m.final.join('-') : ''} ${C.esc(m.away.name)}${
        m.pens ? `,PK ${m.pens.join('-')}` : ''})</span></div>
  </div>`;
}

const OUTCOME = {
  auto: { label: '直接晉級十六強', tone: 'win' },
  playoff: { label: '附加賽', tone: '' },
  out: { label: '止步聯賽階段', tone: 'loss' },
};

function leagueTable(season) {
  const rows = season.table.rows;
  if (!rows.length) return '';
  return C.table(rows, [
    { key: 'position', label: '#', value: r => r.position, num: true },
    { key: 'team', label: '球隊', value: r => r.name, left: true,
      render: r => teamCell({ name: r.name, code: r.code, league: r.league }) },
    { key: 'p', label: '賽', value: r => r.p, num: true },
    { key: 'w', label: '勝', value: r => r.w, num: true },
    { key: 'd', label: '和', value: r => r.d, num: true },
    { key: 'l', label: '負', value: r => r.l, num: true },
    { key: 'gf', label: '進', value: r => r.gf, num: true },
    { key: 'ga', label: '失', value: r => r.ga, num: true },
    { key: 'gd', label: '淨', value: r => r.gd, num: true, render: r => `${r.gd > 0 ? '+' : ''}${r.gd}` },
    { key: 'pts', label: '積分', value: r => r.pts, num: true, render: r => `<b>${r.pts}</b>` },
    { key: 'outcome', label: '結局', value: r => ['auto', 'playoff', 'out'].indexOf(r.outcome), left: true,
      title: '**不是照名次推的**,是看這一隊實際上出現在附加賽還是直接出現在十六強',
      render: r => {
        const o = OUTCOME[r.outcome] ?? { label: '—', tone: '' };
        return `<span class="pill tiny"${o.tone ? ` style="color:var(--${o.tone})"` : ''}>${o.label}</span>`;
      } },
  ], { sortKey: 'position', desc: false });
}

function runsTable(runs) {
  if (!runs.length) return '';
  return C.table(runs, [
    /* 沒有隊碼的球隊 C.name() 會回 undefined,排序就亂掉 —— 用上游給的名字兜底。 */
    { key: 'team', label: '球隊', value: r => (r.code ? C.name(r.code) : r.name), left: true,
      render: r => teamCell({ id: r.id, name: r.name, code: r.code, league: r.league }) },
    { key: 'best', label: '走到哪一輪', value: r => r.bestOrder, num: true,
      render: r => `<span class="mono small">${C.esc(r.best ?? '—')}</span>` },
    { key: 'pos', label: '聯賽階段名次', value: r => r.leaguePos ?? 99, num: true,
      render: r => (r.leaguePos ? `第 ${r.leaguePos} 名` : '<span class="dim">—</span>') },
    { key: 'lrec', label: '聯賽階段戰績', value: r => r.lw * 3 + r.ld, num: true, sortable: false,
      render: r => `<span class="mono small">${r.lw}勝 ${r.ld}和 ${r.ll}負</span>` },
    { key: 'ko', label: '淘汰賽', value: r => r.koWon, num: true, sortable: false,
      title: 'PK 大戰勝出也算勝場 —— 盃賽的晉級就是這樣算的',
      render: r => (r.koPlayed ? `<span class="mono small">${r.koPlayed} 場 ${r.koWon} 勝</span>` : '<span class="dim">—</span>') },
    { key: 'out', label: '出局於', value: r => (r.out ? 1 : 0), left: true, sortable: false,
      render: r => (r.out
        ? `<span class="tiny dim">${C.esc(r.out)}${r.outTo ? ` 輸給 ${C.esc(r.outTo)}` : ''}</span>`
        : '<span class="pill tiny" style="color:var(--win)">奪冠</span>') },
  ], {
    sortKey: 'best',
    desc: true,
    /* 只有本站有球隊頁的才可以點。其餘 25 支只有名字、隊徽與這一列的戰績 ——
       連到一個不存在的球隊頁比不連更糟。 */
    rowClickable: r => !!r.code,
    onRow: r => (r.code ? C.go('teams', { code: r.code, league: r.league ?? undefined }) : undefined),
  });
}

/* 只有抽籤、還沒開賽的那一季。
   **只畫「誰對誰、誰主誰客」** —— 上游那 144 場的開球時間全部是同一個佔位值、
   輪次全是 null,所以日期與輪次我們沒有。沒有的東西不顯示,也不猜(鐵則一)。
   而且這一季只有一個來源,沒得交叉核對,這件事要寫在最前面(鐵則四)。 */
function drawView(season) {
  const d = season.draw;
  /* 本站也有的球隊要看得出來。第一版只掛了一個 data-strong 屬性、沒有樣式,
     而提示文字卻寫著「加粗的是本站也有的球隊」—— 說了沒做到,
     那跟寫錯一樣糟。改成直接套字重與顏色。 */
  const oppList = list => list.map(o => `<span class="pill tiny" style="margin:2px 3px 0 0${
    o.code ? ';font-weight:700;color:var(--accent)' : ''}">${C.esc(o.name)}</span>`).join('');
  const rows = d.rows.map(t => `
    <div class="card" style="margin-top:8px;padding:12px 14px">
      <div class="row" style="gap:8px;align-items:center">
        ${t.code && registered(t.code) ? C.badge(t.code) : ''}
        <b>${C.esc(t.code && registered(t.code) ? C.name(t.code) : t.name)}</b>
        ${t.code ? `<a class="tiny" href="${C.link('teams', { code: t.code, league: t.league ?? undefined })}"
          style="text-decoration:none">本站球隊頁 →</a>` : ''}
      </div>
      <div class="small" style="margin-top:8px;display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:start">
        <span class="muted tiny" style="padding-top:3px">主場</span><span>${oppList(t.home)}</span>
        <span class="muted tiny" style="padding-top:3px">客場</span><span>${oppList(t.away)}</span>
      </div>
    </div>`).join('');
  return `
    <div class="note" style="margin-top:12px">
      <b>${season.label} 已經抽籤,但還沒開賽。</b>
      下面是聯賽階段的 ${d.matches.length} 組對戰(36 隊 × 8 場,各 4 主 4 客)——
      <b>這是抽籤結果,不是賽程</b>:上游目前<b>沒有開球時間、也沒有輪次</b>
      (144 場的時間全部是同一個佔位值),所以這一頁不顯示日期與第幾輪。有了才會補上。
      <div class="tiny dim" style="margin-top:6px">
        ⚠ <b>這一季只有一個資料來源</b>(${C.esc(season.source ?? 'FotMob')}),沒有第二份可以逐場核對 ——
        另外兩季是兩個獨立來源對過的。能做的是結構檢查:
        ${d.check.matches} 場、${d.check.teams} 隊、每隊 ${d.check.homePerTeam.join('/')} 主
        ${d.check.awayPerTeam.join('/')} 客、${d.check.distinctOpponents.join('/')} 個不重複對手、
        重複對戰 ${d.check.repeatedPairs} 組 —— 瑞士制的硬性條件,這幾條都過了。
      </div>
    </div>
    <div class="section"><h2>聯賽階段對戰表</h2>
      <span class="hint">本站認得的球隊排在前面・對手名稱加粗的是本站也有的球隊</span></div>
    ${rows}`;
}

/* 球員榜。FotMob 給的是**統計榜的母體**,不是全體報名名單(檔案自己這樣寫),
   所以每一榜都標母體人數,不要讓讀者以為是完整名單。 */
function leaderBoards(season) {
  if (!season.leaders?.length) return '';
  const fmt = (v, dp) => (dp ? Number(v).toFixed(dp) : v);
  return `
    <div class="section"><h2>球員榜</h2>
      <span class="hint">來源 FotMob・${season.leaderPool} 人母體・已與另一來源逐場核對比分後才採用</span></div>
    <div class="grid g3">
      ${season.leaders.map(b => `<div class="card">
        <div class="spread"><h3 style="margin:0;font-size:15px">${C.esc(b.zh)}</h3>
          <span class="dim tiny">母體 ${b.pool} 人</span></div>
        <div style="display:grid;gap:2px;margin-top:8px">
          ${b.rows.map((r, i) => `<div class="stat-line" style="gap:8px;align-items:center">
            <span class="tiny dim mono" style="min-width:18px">${i + 1}</span>
            <span class="small" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${C.esc(r.name)}</span>
            <span class="tiny dim" style="max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${C.esc(r.team)}</span>
            <b class="mono small">${fmt(r.value, b.dp)}${C.esc(b.unit)}</b>
          </div>`).join('')}
        </div>
      </div>`).join('')}
    </div>`;
}

// 拿不到的賽季照樣列出來,而且要分得出是哪一種 —— 「還沒建立」與「方案不給」是兩句話
function unavailableNote(season) {
  const why = {
    'draw-unsound': `<b>${season.label} 的抽籤資料沒有通過結構檢查。</b>
      瑞士制聯賽階段要求每隊 4 主 4 客、8 個不重複對手 —— 這份對不上,
      所以<b>整份不顯示</b>。顯示一份可能錯的對戰表比不顯示更糟。`,
    'not-published': `<b>${season.label} 的賽程資料源還沒建立。</b>
      歐冠聯賽階段九月中才開打,資料源目前回報的本季仍是上一季 ——
      這是<b>還沒有</b>,不是拿不到。開打後這一頁會自動出現這一季。`,
    'no-fixtures-yet': `<b>${season.label} 的賽程還沒公布。</b>資料源認得這一季,但一場都還沒排定。`,
    'plan-restricted': `<b>${season.label} 不在本站使用的資料源方案裡。</b>
      這不是「還沒抓到」—— 不換方案的話不會有。`,
  }[season.availability] ?? `<b>${season.label} 目前取不到。</b>資料源回報:${C.esc(season.message ?? '(沒有訊息)')}`;
  return `<div class="note" style="margin-top:12px">${why}
    ${season.message ? `<div class="tiny dim" style="margin-top:6px">資料源原文:${C.esc(season.message)}</div>` : ''}</div>`;
}

try {
  const { meta, clubs, teams, ucl, 'ucl-teams': uclTeams } = await C.load('meta', 'clubs', 'teams', 'ucl', 'ucl-teams');
  /* **先登錄跨聯賽那一份,再登錄本聯賽的。** registerTeams 是逐欄位覆蓋,
     順序反過來的話,本聯賽比較完整的那筆(配色、球場、chartColor)
     會被只帶名字與隊徽的那筆蓋掉一部分。 */
  C.registerTeams(uclTeams?.teams ?? []); C.registerTeams(clubs); C.registerTeams(teams);
  externalCrest = new Map((uclTeams?.external ?? []).map(t => [t.id, t.crest]));
  C.nav();

  const seasons = ucl?.seasons ?? [];
  if (!seasons.length) {
    app.innerHTML = `<div class="page-head"><h1>歐冠</h1></div>
      <div class="note">目前沒有歐冠資料。</div>${C.foot(meta)}`;
  } else {
    // 預設看最新一季**有比賽**的那一季 —— 停在一片空白的未來賽季很奇怪
    let label = (seasons.find(s => s.played > 0) ?? seasons[0]).label;

    app.innerHTML = `
    <div class="page-head">
      <h1>歐冠</h1>
      <p>歐洲冠軍聯賽的聯賽階段積分榜、淘汰賽結果與球員榜。跟聯賽不一樣的地方這一頁都照實顯示:
        <b>兩回合的總比分</b>、<b>延長賽</b>、<b>PK 大戰</b>,以及本站兩個聯賽的球隊各自走到了哪一輪。
        已完賽的兩季是<b>兩個獨立來源逐場核對過</b>的;還沒開賽的那一季只呈現<b>抽籤結果</b>,
        因為上游還沒有開球時間與輪次。</p>
      ${C.stampRow([
        C.stamp('歐冠賽果', { iso: ucl.retrievedAt, kind: 'daily',
          note: 'football-data.org(賽果與官方積分榜)+ FotMob(球員榜與 2026-27 抽籤)' }),
      ])}
    </div>
    <div class="filters" style="align-items:end">
      ${seasons.map(s => `<button class="btn${s.label === label ? ' on' : ''}" data-season="${s.label}"
        >${s.label}${{ available: '', 'draw-only': '(已抽籤)' }[s.availability] ?? '(尚無資料)'}</button>`).join('')}
      <span class="dim small" id="count"></span>
    </div>
    <div id="body"></div>
    <div class="note info" style="margin-top:14px">
      <b>這一頁沒有勝率預測,這是刻意的。</b>
      本站的模型是用<b>聯賽</b>比賽調出來的,而歐冠有四件它沒見過的事:跨聯賽的實力比較、
      <b>兩回合制</b>、<b>延長賽</b>與 <b>PK 大戰</b>。沒有在歐冠上跑過走查回測就把聯賽模型套上去,
      出來的機率是編的 —— 那正是本站第二條鐵則在擋的東西。
      <a href="${C.link('model')}">模型驗證頁</a>寫著現有模型驗過什麼、沒驗過什麼。
    </div>
    <div class="note" style="margin-top:10px" id="coverage"></div>
    ${C.foot(meta)}`;

    const render = () => {
      const s = seasons.find(x => x.label === label) ?? seasons[0];
      const body = document.getElementById('body');
      const count = document.getElementById('count');
      const cov = document.getElementById('coverage');

      if (s.availability === 'draw-only') {
        body.innerHTML = drawView(s);
        count.textContent = `${s.total} 組對戰・${s.teams} 隊・尚未開賽`;
        cov.innerHTML = `<b>球隊涵蓋率:${s.teamsKnown} / ${s.teamsTotal} 支有本站資料。</b>
          其餘只有名字,沒有隊徽也點不進去 —— 不替它們編一個身分。`;
        return;
      }
      if (s.availability !== 'available') {
        body.innerHTML = unavailableNote(s);
        count.textContent = '';
        cov.innerHTML = '';
        return;
      }
      count.textContent = `${s.total} 場・完賽 ${s.played}・${s.teams} 隊・延長 ${s.aet}・PK ${s.shootouts}`;
      body.innerHTML = `
        ${championCard(s.champion, s.label)}
        ${s.advancementProblems.length ? `<div class="note" style="margin-top:12px;color:var(--loss)">
          ⚠ 晉級核對沒過:${s.advancementProblems.map(p => C.esc(`${p.stage} ${p.teams.join(' vs ')} —— ${p.issue}`)).join('、')}</div>` : ''}
        ${s.unknownDurations.length ? `<div class="note" style="margin-top:12px;color:var(--loss)">
          ⚠ 上游出現沒核對過的比分類別:${s.unknownDurations.map(C.esc).join('、')} ——
          這些場次的比分<b>不顯示</b>,不猜。</div>` : ''}
        ${s.runs.length ? `<div class="section"><h2>各隊走到哪一輪</h2>
          <span class="hint">${s.runs.length} 支全列出・本站有球隊頁的 ${s.runs.filter(r => r.code).length} 支可以點進去,
          其餘只有這一列的戰績(本站沒有那些聯賽的資料)</span></div>
          <div id="runs"></div>` : ''}
        <div class="section"><h2>淘汰賽</h2>
          <span class="hint">最新的排在最上面(決賽 → 附加賽)・兩回合制顯示總比分與各回合比分・決賽為單場</span></div>
        ${/* rounds 的資料順序維持由早到晚(「晉級者有沒有出現在下一輪」那條核對照它走),
              **只在顯示時倒過來** —— 把資料順序改掉會連帶要改核對邏輯,沒必要。 */''}
        ${[...s.rounds].reverse().map(r => `<div style="margin-top:14px">
          <div class="spread"><h3 style="margin:0">${C.esc(r.zh)}</h3>
            <span class="dim tiny">${r.ties.length} 組・${r.played}/${r.total} 場</span></div>
          ${[...r.ties].reverse().map(tieCard).join('')}</div>`).join('')}
        <div class="section"><h2>聯賽階段</h2>
          <span class="hint">36 隊各打 8 場・名次${s.table.order === 'official' ? '取自資料源官方積分榜' : '由本站依賽果排出'}・這是最早的階段,所以排在淘汰賽下面</span></div>
        <div id="tbl"></div>
        ${s.bandBroken ? `<div class="note" style="margin-top:8px;color:var(--loss)">
          ⚠ 三段結局的名次不連續 —— 賽制可能改了,或資料有問題,這張表的分段先不要當定論。</div>`
          : `<div class="tiny dim" style="margin-top:8px">
          第 ${s.bands.auto?.from}–${s.bands.auto?.to} 名直接進十六強・
          第 ${s.bands.playoff?.from}–${s.bands.playoff?.to} 名打附加賽・
          第 ${s.bands.out?.from}–${s.bands.out?.to} 名止步於此。
          <b>這三段不是照名次推的</b>,是看每一隊實際上出現在附加賽還是直接出現在十六強 ——
          推出來之後名次剛好連續,兩季都是。</div>`}
        ${leaderBoards(s)}`;

      const runsEl = document.getElementById('runs');
      if (runsEl) runsEl.innerHTML = runsTable(s.runs);
      document.getElementById('tbl').innerHTML = leagueTable(s);

      const unknown = s.teamsTotal - s.teamsKnown;
      cov.innerHTML = `
        <b>球隊涵蓋率:${s.teamsKnown} / ${s.teamsTotal} 支有本站資料。</b>
        歐冠有全歐洲的球隊,本站只做英超與西甲 —— 這一季有 ${unknown} 支球隊本站沒有,
        它們照樣出現在賽程與積分榜裡,但<b>只有名字,沒有隊徽也點不進去</b>。
        不替它們編一個隊碼或找一張像的隊徽,那會讓讀者以為本站有它們的資料。
        <div style="margin-top:6px" class="tiny dim">
          另一個聯賽的球隊(例如在英超頁看到的皇馬)有連結、但沒有隊徽 ——
          隊徽是按聯賽打包的,這一頁只端得出目前這個聯賽那一份。點進去會切到對的聯賽。
        </div>
        ${s.crossCheck ? `<div style="margin-top:6px">
          ${s.crossCheck.passed
            ? `<b style="color:var(--win)">✔ 兩個獨立來源逐場核對通過。</b>
               ${C.esc(s.crossCheck.source)} 的同一季資料與本站主來源比對:
               隊名 ${s.crossCheck.teamsMatched}/${s.crossCheck.teamsTotal} 對上、
               <b>${s.crossCheck.aligned}/${s.crossCheck.total} 場的日期與主客完全一致、比分 0 場不符</b>。
               協作方自己回報「檢查全過」不算數,這是拿另一個供應商實際比出來的。`
            : `<b style="color:var(--loss)">⚠ 第二來源核對沒過(${s.crossCheck.problemCount} 處)。</b>
               ${s.crossCheck.problems.slice(0, 3).map(p => C.esc(p.text)).join('、')}
               —— 畫面顯示的是主來源,第二來源的球員榜<b>整份不採用</b>。`}
        </div>` : ''}
        ${s.table.mismatches.length ? `<div style="margin-top:6px;color:var(--loss)">
          ⚠ 本站依賽果算出的積分榜與資料源官方那份對不上:
          ${s.table.mismatches.map(x => C.esc(`${x.team} 的${x.field}(我們 ${x.ours}、官方 ${x.official})`)).join('、')}
          —— 顯示的是官方那份。</div>` : ''}
        ${ucl.teamCodeConflicts?.length ? `<div style="margin-top:6px;color:var(--loss)">
          ⚠ 有隊名對到同一個隊碼,已整組不對應:
          ${ucl.teamCodeConflicts.map(c => C.esc(c.conflicts.map(x => `${x.code}=${x.teams.join('/')}`).join('、'))).join('、')}</div>` : ''}`;
    };

    document.querySelectorAll('[data-season]').forEach(b => {
      b.onclick = () => {
        label = b.dataset.season;
        document.querySelectorAll('[data-season]').forEach(x => x.classList.toggle('on', x === b));
        render();
      };
    });
    render();
  }
} catch (err) { C.fail(err); }
