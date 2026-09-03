import * as C from './core.js?v=6ce2cd6c';


/* 足球知識頁。
 *
 * 這是全站唯一一頁「大部分內容不是本站算出來的」——
 * 陣型優劣、背號意義、位置分工都是足球共識。所以整頁的規矩只有一條:
 *
 *   **共識歸共識、資料歸資料,而且要一眼分得出來。**
 *
 * 共識層(data/manual/football-knowledge.json)逐條帶來源網址,標成「傳統說法」;
 * 資料層(knowledge.json 的 numbers / formations)是從本站球員與陣型紀錄算的,
 * 標成「本站資料」。兩者擺在一起,對不上的地方就照實講對不上 ——
 * 那反而是這一頁最有價值的部分。
 */
/* 這一頁併進「探索」單頁(2026-09-03)。內容抽成 render 函式,
   由 page-explore.js 以頁內分頁呼叫 —— 跟歐冠併進盃賽時同一個做法
   (`ucl-view.js`)。`app` 由呼叫端給,不再自己抓 #app。 */
export async function renderKnowledge(app) {
  try {
    const { meta, clubs, teams, knowledge } = await C.load('meta', 'clubs', 'teams', 'knowledge');
    C.registerTeams(clubs); C.registerTeams(teams);
    C.nav();
  
    const G = knowledge?.guide;
    if (!G) throw new Error('缺少足球知識資料集');
    const SRC = new Map((G._sources ?? []).map(s => [s.id, s]));
    const POS_ZH = { GK: '門將', DEF: '後衛', MID: '中場', FWD: '前鋒' };
    const POS_ORDER = ['GK', 'DEF', 'MID', 'FWD'];
  
    /* 來源標記。共識層的每一條都要掛得出出處,不然就跟隨口說的一樣。
       顯示用 short(人工給的短名),不要截斷原標題 ——
       截斷會變成「Formations: footba」那種讀不出來的字串。 */
    const cite = ids => (ids ?? []).map(id => {
      const s = SRC.get(id);
      return s ? `<a href="${C.esc(s.url)}" target="_blank" rel="noopener noreferrer"
        class="tiny" title="${C.esc(s.title)}">${C.esc(s.short ?? s.title)}</a>` : '';
    }).filter(Boolean).join('・');
  
    const tradPill = '<span class="pill tiny" title="足球界的傳統說法,不是本站算出來的">傳統說法</span>';
    const dataPill = '<span class="pill accent tiny" title="從本站的球員與比賽資料算出來的">本站資料</span>';
  
    /* ── 陣型 ───────────────────────────
       站位圖用共用的球場元件畫,把每一排的位置名稱當成「球員」餵進去。
       **這是示意站位,不是實測平均位置** —— 本站沒有球員追蹤資料,標題要講清楚。 */
    function formationCard(f, usage) {
      const rows = (f.rows ?? []).map(list => list.map(name => ({ name, role: '' })));
      const used = usage?.rows?.find(r => r.label === f.label) ?? null;
      return `<div class="card">
        <div class="row" style="gap:8px;align-items:center">
          <h3 style="margin:0">${C.esc(f.label)}</h3>
          ${used ? `<span class="pill accent tiny" title="本站資料算出來的實際使用比例">實際 ${(used.share * 100).toFixed(1)}%</span>`
            : '<span class="pill tiny dim" title="本站的紀錄裡沒看到這個陣型">沒出現過</span>'}
        </div>
        <div class="tiny dim" style="margin-top:3px">${C.esc(f.idea)}</div>
        <div style="margin:10px 0">${C.pitch([], { w: 260, officialRows: rows, color: 'var(--accent)' })}</div>
        <div class="small muted" style="display:grid;gap:6px">
          <div><b>優勢</b><div class="tiny">${f.strengths.map(x => `・${C.esc(x)}`).join('<br>')}</div></div>
          <div><b>弱點</b><div class="tiny">${f.weaknesses.map(x => `・${C.esc(x)}`).join('<br>')}</div></div>
        </div>
        ${used ? `<div class="tiny dim" style="margin-top:8px;border-top:1px dashed var(--line);padding-top:6px">
          ${dataPill} ${usage.unit === 'minutes'
            ? `${used.teamCount} 隊用過,合計 ${used.count.toLocaleString()} 分鐘;用最多的是
               ${used.topTeams.map(t => `${C.name(t.code)}(${t.share}%)`).join('、')}。`
            : `${used.count} 份正式名單用了這個陣型。`}</div>` : ''}
        <div class="tiny dim" style="margin-top:6px">${tradPill} 來源:${cite(f.sources)}</div>
      </div>`;
    }
  
    function formationSection() {
      const usage = knowledge.formations;
      // 沒出現過的陣型排在後面,但**不刪掉** —— 「這個聯賽沒人用」本身就是資訊
      const order = f => (usage?.rows?.findIndex(r => r.label === f.label) ?? -1);
      const list = [...G.formations].sort((a, b) => {
        const ia = order(a), ib = order(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      const src = usage?.unit === 'minutes'
        ? `本站資料:${knowledge.formationSeason} 逐場紀錄的實際使用<b>分鐘</b>,母體 ${Math.round(usage.total / 90).toLocaleString()} 場球的時間。`
        : usage
          ? `本站資料:本季 ${usage.total} 份正式名單上的陣型。<b>樣本很小</b>,只能看出誰在用什麼,不能當成整季的比例。`
          : '這個聯賽目前沒有可用的陣型紀錄,所以只有傳統說法那一半。';
      return `
      <div class="section" style="margin-top:20px"><h2>陣型</h2>
        <span class="hint">${G.formations.length} 種常見體系</span></div>
      <div class="note" style="margin-bottom:12px">
        左邊的<b>優勢與弱點是足球共識</b>,不是本站算出來的;右上角的<b>實際使用比例才是本站資料</b>。
        ${src}
        <div class="tiny dim" style="margin-top:6px">球場圖是<b>示意站位</b>,不是球員追蹤資料的平均位置 ——
          本站沒有那種資料,所以圖上不畫跑動路線。</div>
      </div>
      <div class="grid g2">${list.map(f => formationCard(f, usage)).join('')}</div>
      ${formationCaveat()}`;
    }
  
    /* 陣型跟成績的關係。本站有量過(formation.json),結論是很弱 ——
       這一段一定要在陣型區塊之後講,否則整頁讀起來像在推薦某個陣型。 */
    function formationCaveat() {
      return `<div class="note info" style="margin-top:14px">
        <b>不要把「陣型好」跟「成績好」畫上等號。</b>
        本站量過上季各隊的平均人力配置與積分的相關性,最強的一條也只到中等,
        而且方向很可能是<b>反過來的</b>:強隊因為控得住球才敢少放一個後衛,
        不是少放一個後衛才變強。<a href="${C.link('model')}">模型驗證頁</a>有完整的相關係數與說明。
      </div>`;
    }
  
    /* ── 背號 ───────────────────────────
       傳統說法 vs 本站實際分佈。這一段的價值在於**兩邊對不上的地方**。 */
    function numberRow(t) {
      const a = t.actual;
      const bar = a ? POS_ORDER.map(k => {
        const n = a.counts[k];
        if (!n) return '';
        const pct = (n / a.total) * 100;
        /* 四類各一個色。**要用真的存在的 CSS 變數** —— 之前寫 var(--warn),
           那個變數不存在,門將那一格整條沒有顏色,看起來像沒有資料。 */
        const col = { GK: 'var(--draw)', DEF: 'var(--accent)', MID: 'var(--ink-3)', FWD: 'var(--loss)' }[k];
        return `<span title="${POS_ZH[k]} ${n} 人" style="display:inline-block;height:10px;width:${pct}%;background:${col}"></span>`;
      }).join('') : '';
      return `<tr>
        <td class="mono num"><b>${t.n}</b></td>
        <td class="left">${C.esc(t.traditional)}${t.variant ? ' <span class="pill warn tiny" title="不同國家的傳統不一樣">分歧</span>' : ''}
          <div class="tiny dim">${C.esc(t.traditionalEn)}</div></td>
        <td style="min-width:140px">${a ? `<div style="display:flex;border-radius:3px;overflow:hidden">${bar}</div>
          <div class="tiny dim" style="margin-top:3px">${POS_ZH[a.topPos]} ${Math.round(a.topShare * 100)}%・n=${a.total}</div>`
          : '<span class="dim tiny">這個聯賽沒有樣本</span>'}</td>
      </tr>`;
    }
  
    function numberSection() {
      const N = knowledge.numbers;
      const cov = N.coverage;
      return `
      <div class="section" style="margin-top:24px"><h2>背號</h2>
        <span class="hint">傳統意義 vs 本站實際分佈</span></div>
      <div class="card" style="margin-bottom:12px">
        <div class="small muted">${C.esc(G.numberOrigin.zh)}</div>
        <div class="tiny dim" style="margin-top:8px">${tradPill} 來源:${cite(G.numberOrigin.sources)}</div>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th class="num">號碼</th><th class="left">傳統意義 ${tradPill}</th><th>本站 ${meta.currentSeason} 實際分佈 ${dataPill}</th>
      </tr></thead><tbody>${N.tradition.map(numberRow).join('')}</tbody></table></div>
      <div class="tiny dim" style="margin-top:8px">
        顏色:<span style="color:var(--draw)">門將</span>・<span style="color:var(--accent)">後衛</span>・
        <span style="color:var(--ink-3)">中場</span>・<span style="color:var(--loss)">前鋒</span>。
        母體:${cov.players} 名註冊球員裡有 <b>${cov.withNumber}</b> 人有背號、
        其中 <b>${cov.withNumberAndPos}</b> 人同時有位置分類 ——
        這張表用的是後者${cov.droppedNoPos ? `,有 ${cov.droppedNoPos} 人因為上游沒給位置而不列入(不猜)` : ''}。
      </div>
      <div class="note" style="margin-top:12px">
        <b>讀這張表要小心一件事:位置分類是上游給的,而多數來源把邊鋒歸在「中場」。</b>
        所以 7 號與 11 號看起來「不再是前鋒」,有一部分是分類粒度造成的,
        不能直接讀成傳統瓦解。真正能看的是<b>大類有沒有換邊</b> ——
        例如 6 號在兩個聯賽分別落在後衛與中場,那個差異不是分類問題。
      </div>`;
    }
  
    /* ── 位置 ───────────────────────────
       純定義。按場上的線分組,不硬掛本站的球員 ——
       本站的位置分類只有四個粗類(GK/DEF/MID/FWD),挑不出「誰是節拍器」。 */
    function positionSection() {
      const lines = [...new Set(G.positions.map(p => p.line))];
      return `
      <div class="section" style="margin-top:24px"><h2>位置與角色</h2>
        <span class="hint">${G.positions.length} 種說法</span></div>
      <div class="note" style="margin-bottom:12px">
        這一整段<b>全部是共識層</b>,沒有本站的數字。原因很直接:
        本站的球員位置只有<b>門將／後衛／中場／前鋒</b>四個粗類,
        分不出誰是節拍器、誰是工兵型 —— 沒有那個資料就不做,
        不用「傳球多就是節拍器」這種自己編的判準充數。
      </div>
      ${lines.map(line => `
        <div class="section" style="margin-top:12px"><h3 style="margin:0">${C.esc(line)}</h3></div>
        <div class="grid g3">${G.positions.filter(p => p.line === line).map(p => `
          <div class="card">
            <h3 style="margin:0">${C.esc(p.zh)}</h3>
            <div class="tiny dim" style="margin-top:2px">${C.esc(p.en)}</div>
            <div class="small muted" style="margin-top:8px">${C.esc(p.def)}</div>
            <div class="tiny dim" style="margin-top:8px">來源:${cite(p.sources)}</div>
          </div>`).join('')}</div>`).join('')}`;
    }
  
    function sourceSection() {
      return `
      <div class="section" style="margin-top:24px"><h2>共識層的全部來源</h2>
        <span class="hint">${(G._sources ?? []).length} 筆</span></div>
      <div class="card"><div class="small muted" style="display:grid;gap:5px">
        ${(G._sources ?? []).map(s => `<div>・<a href="${C.esc(s.url)}" target="_blank" rel="noopener noreferrer">${C.esc(s.title)}</a></div>`).join('')}
      </div>
      <div class="tiny dim" style="margin-top:10px">${C.esc(G._disclaimer)}
        <br>整理時點 ${C.esc(G._updated)}。這一份是<b>人工整理</b>的,跟本站其他頁面的數字不同 ——
        它不會隨著比賽自動更新,內容有錯就是我整理錯了。</div>
      </div>`;
    }
  
    app.innerHTML = `
    <div class="page-head">
      <h1>足球知識</h1>
      <p>陣型、背號、位置分工。這一頁跟站上其他頁不一樣:<b>大半的內容是足球共識,不是本站算出來的</b>。
         所以每一塊都標著它是哪一種 —— ${tradPill} 是共識並附出處,${dataPill} 是從本站的球員與比賽紀錄算出來的。
         兩邊擺在一起,對不上的地方就照實講。</p>
      ${C.stampRow([
        C.stamp('共識層(人工整理)', { kind: 'season', note: `整理時點 ${G._updated};不隨比賽更新` }),
        C.stamp('對照用的資料', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算' }),
      ])}
    </div>
    ${formationSection()}
    ${numberSection()}
    ${positionSection()}
    ${sourceSection()}
    ${C.foot(meta)}`;
  } catch (err) { C.fail(err); }
}
