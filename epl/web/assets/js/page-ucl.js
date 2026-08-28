import * as C from './core.js?v=4032db8f';

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

// 本站在**目前這個聯賽**的資料集裡認不認得這個隊碼 —— 認得才端得出隊徽
const registered = code => !!code && C.team(code).en !== code;

function teamCell(t, { align = 'left', strong = false } = {}) {
  if (!t?.name) return '<span class="dim small">待定</span>';
  const label = C.esc(registered(t.code) ? C.name(t.code) : t.name);
  const weight = strong ? 'font-weight:700' : '';
  if (!t.code) return `<span class="small" style="${weight}">${label}</span>`;
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
    { key: 'team', label: '球隊', value: r => C.name(r.code), left: true,
      render: r => teamCell({ name: r.name, code: r.code, league: r.league }) },
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
  ], { sortKey: 'best', desc: true, onRow: r => C.go('teams', { code: r.code, league: r.league ?? undefined }) });
}

// 拿不到的賽季照樣列出來,而且要分得出是哪一種 —— 「還沒建立」與「方案不給」是兩句話
function unavailableNote(season) {
  const why = {
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
  const { meta, clubs, teams, ucl } = await C.load('meta', 'clubs', 'teams', 'ucl');
  C.registerTeams(clubs); C.registerTeams(teams);
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
      <p>歐洲冠軍聯賽的聯賽階段積分榜與淘汰賽結果。跟聯賽不一樣的地方這一頁都照實顯示:
        <b>兩回合的總比分</b>、<b>延長賽</b>、<b>PK 大戰</b>,以及本站兩個聯賽的球隊各自走到了哪一輪。</p>
      ${C.stampRow([
        C.stamp('歐冠賽果', { iso: ucl.retrievedAt, kind: 'daily', note: 'football-data.org' }),
      ])}
    </div>
    <div class="filters" style="align-items:end">
      ${seasons.map(s => `<button class="btn${s.label === label ? ' on' : ''}" data-season="${s.label}"
        >${s.label}${s.availability !== 'available' ? '(尚無資料)' : ''}</button>`).join('')}
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
        ${s.runs.length ? `<div class="section"><h2>本站球隊走到哪一輪</h2>
          <span class="hint">英超與西甲・共 ${s.runs.length} 支・點一列進球隊頁</span></div>
          <div id="runs"></div>` : ''}
        <div class="section"><h2>聯賽階段</h2>
          <span class="hint">36 隊各打 8 場・名次${s.table.order === 'official' ? '取自資料源官方積分榜' : '由本站依賽果排出'}</span></div>
        <div id="tbl"></div>
        ${s.bandBroken ? `<div class="note" style="margin-top:8px;color:var(--loss)">
          ⚠ 三段結局的名次不連續 —— 賽制可能改了,或資料有問題,這張表的分段先不要當定論。</div>`
          : `<div class="tiny dim" style="margin-top:8px">
          第 ${s.bands.auto?.from}–${s.bands.auto?.to} 名直接進十六強・
          第 ${s.bands.playoff?.from}–${s.bands.playoff?.to} 名打附加賽・
          第 ${s.bands.out?.from}–${s.bands.out?.to} 名止步於此。
          <b>這三段不是照名次推的</b>,是看每一隊實際上出現在附加賽還是直接出現在十六強 ——
          推出來之後名次剛好連續,兩季都是。</div>`}
        <div class="section"><h2>淘汰賽</h2>
          <span class="hint">兩回合制・顯示總比分與各回合比分・決賽為單場</span></div>
        ${s.rounds.map(r => `<div style="margin-top:14px">
          <div class="spread"><h3 style="margin:0">${C.esc(r.zh)}</h3>
            <span class="dim tiny">${r.ties.length} 組・${r.played}/${r.total} 場</span></div>
          ${r.ties.map(tieCard).join('')}</div>`).join('')}`;

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
