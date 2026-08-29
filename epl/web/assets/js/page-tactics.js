import * as C from './core.js?v=f5b81714';

const app = document.getElementById('app');

/* ── 兩個聯賽共用的區塊 ─────────────────────────────
   西甲原本整頁另寫一套(meta.edition === 'basic'),補一個區塊要在兩邊各寫一次,
   而且兩邊排版本來就不一樣 —— 那正是「西甲以英超為模板」要解的問題。
   這四塊改成只定義一次、兩邊都呼叫。之後補版面照這個做法,不要再往 basic 分支加。

   每塊都自己判斷資料在不在,缺就整塊不出現 —— 不留空欄位(鐵則三)。 */

const colourOf = code => C.team(code).colors?.[0] ?? '#888';

/* xG 的來源兩個聯賽不一樣:英超是球員層級的期望進球加總,西甲是 Understat 整隊統計。
   所以來源那句話由呼叫端給,不要寫死成其中一種 —— 寫死的話另一個聯賽的出處就是錯的。 */
function quadrantBlock(tactics, sourceNote) {
  const rows = tactics.filter(t => t.attack?.xG90 != null && t.defence?.xGA90 != null);
  if (!rows.length) return '';
  return `
  <div class="section"><h2>攻守四象限</h2><span class="hint">橫軸每場期望進球,縱軸每場期望失球(越上面防守越好)</span></div>
  <div class="card">
    ${C.scatter(rows.map(t => ({
      x: t.attack.xG90, y: t.defence.xGA90, code: t.code, color: colourOf(t.code),
      label: `${C.name(t.code)} xG ${t.attack.xG90} / xGA ${t.defence.xGA90}`,
    })), { xLabel: '每場期望進球 xG(越右攻擊力越強)', yLabel: '每場期望失球 xGA(越上防守越穩)', invertY: true })}
    <div class="tiny dim">右上角 = 攻守俱佳;左下角 = 兩頭落空。${sourceNote}</div>
  </div>`;
}

function resilienceBlock(tactics) {
  const rows = tactics.filter(t => t.resilience?.leadHoldPct != null && t.resilience?.trailRescuePct != null);
  if (!rows.length) return '';
  return `
  <div class="section"><h2>領先之後守不守得住</h2><span class="hint">半場領先 / 落後時的實際收分能力</span></div>
  <div class="card">
    ${C.scatter(rows.map(t => ({
      x: t.resilience.leadHoldPct, y: t.resilience.trailRescuePct, code: t.code, color: colourOf(t.code),
      label: `${C.name(t.code)} 保分 ${t.resilience.leadHoldPct}% / 搶分 ${t.resilience.trailRescuePct}%`,
    })), { xLabel: '半場領先時的保分率 %', yLabel: '半場落後時的搶分率 %' })}
    <div class="tiny dim">右上角是最難纏的球隊:領先守得住、落後還能追。左下角就是俗稱的「玻璃心」。</div>
  </div>`;
}

/* 比賽時段。回傳欄位定義而不是直接塞 DOM,讓兩邊自己決定掛在哪個容器。 */
const tempoColumns = () => [
  { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) },
  { key: 'gf1', label: '上半進', value: t => t.tempo.gf1, num: true },
  { key: 'ga1', label: '上半失', value: t => t.tempo.ga1, num: true },
  { key: 'gd1', label: '上半淨', value: t => t.tempo.gf1 - t.tempo.ga1, num: true, render: t => C.signed(t.tempo.gf1 - t.tempo.ga1, 0) },
  { key: 'gf2', label: '下半進', value: t => t.tempo.gf2, num: true },
  { key: 'ga2', label: '下半失', value: t => t.tempo.ga2, num: true },
  { key: 'gd2', label: '下半淨', value: t => t.tempo.gf2 - t.tempo.ga2, num: true, render: t => C.signed(t.tempo.gf2 - t.tempo.ga2, 0) },
  { key: 'swing', label: '下半場增減', value: t => t.tempo.secondHalfSwing, num: true,
    title: '下半場淨勝球 − 上半場淨勝球,正值代表越踢越強',
    render: t => `<b>${C.signed(t.tempo.secondHalfSwing, 1)}</b>` },
  { key: 'comeback', label: '逆轉', value: t => t.resilience.comeback, num: true },
  { key: 'collapse', label: '被逆轉', value: t => t.resilience.collapse, num: true },
];

/* ── 陣型佔比比較(兩個聯賽共用) ─────────────────────
   固定 A／B／C 三欄,每欄挑一種陣型,列出哪些球隊用它、用了多少比例。

   佔比的**單位兩個聯賽不一樣**:西甲量的是 Understat 的出場分鐘,
   英超量的是官方正式名單的場次。寫死其中一種,另一個聯賽的說明就是假的 ——
   這是抽共用區塊反覆會踩到的坑(程式共用了,文案裡的專屬事實沒跟著抽掉),
   所以 unit 由呼叫端給,而且每張卡的下緣都會把它印出來。

   rows: [{ code, formation, share, detail }] —— 一列是「某隊用某陣型的佔比」
   missing: 沒有資料的球隊代碼,列在footnote 而不是留一片空白(鐵則三) */
function formationCompare(mountId, rows, { unit, missing = [], missingNote = '' }) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  if (!rows.length) {
    mount.innerHTML = `<div class="note">目前沒有可用的陣型佔比資料。${missingNote}</div>`;
    return;
  }
  const groups = [...rows.reduce((m, r) => {
    if (!m.has(r.formation)) m.set(r.formation, []);
    m.get(r.formation).push(r);
    return m;
  }, new Map())].sort((a, b) => {
    const total = list => list.reduce((sum, r) => sum + (r.share ?? 0), 0);
    return total(b[1]) - total(a[1]) || b[1].length - a[1].length;
  });
  const available = groups.map(([name]) => name);
  const pick = available.slice(0, 3);
  const rowsOf = name => (groups.find(([key]) => key === name)?.[1] ?? []);
  const select = (id, label, selected) => `<label class="small" style="display:grid;gap:5px;min-width:170px">
    <span class="muted">${label}</span>
    <select id="${id}">${available.map(name => `<option value="${name}"${name === selected ? ' selected' : ''}>${name}</option>`).join('')}</select></label>`;

  mount.innerHTML = `
    <div class="filters" style="margin-bottom:12px;align-items:end">
      ${select(`${mountId}A`, '陣型 A', pick[0])}
      ${select(`${mountId}B`, '陣型 B', pick[1] ?? pick[0])}
      ${select(`${mountId}C`, '陣型 C', pick[2] ?? pick[0])}
      <span class="dim tiny">從選單切換,即時比較各隊的使用比例(單位:${unit})</span>
    </div>
    <div class="grid g2" id="${mountId}Compare"></div>
    ${missing.length ? `<div class="tiny dim" style="margin-top:10px">
      ${missing.length} 隊還沒有可統計的陣型:${missing.map(c => C.name(c)).join('、')}。${missingNote}</div>` : ''}`;

  const ids = [`${mountId}A`, `${mountId}B`, `${mountId}C`];
  const palette = ['var(--accent)', 'var(--accent-3)', 'var(--accent-2)'];
  const render = () => {
    const cards = ids.map((id, i) => {
      const name = document.getElementById(id).value;
      const list = [...rowsOf(name)].sort((a, b) => b.share - a.share || C.name(a.code).localeCompare(C.name(b.code), 'zh-Hant'));
      return `<div class="card">
        <div class="spread"><h3 style="margin:0"><span class="pill tiny">${String.fromCharCode(65 + i)}</span>
          <span class="mono">${name}</span></h3><span class="dim tiny">${list.length} 隊使用</span></div>
        <div style="display:grid;gap:8px;margin-top:12px">${list.map(r => `
          <a href="${C.link('teams', { code: r.code })}" class="stat-line" style="text-decoration:none;gap:10px">
            <span class="small" style="min-width:130px">${C.badge(r.code)} ${C.name(r.code)}</span>
            <span style="flex:1;display:flex;align-items:center;gap:8px">
              <span style="height:6px;flex:1;background:var(--ink-5);border-radius:4px;overflow:hidden"
                ><i style="display:block;height:100%;width:${Math.min(100, Math.max(0, r.share))}%;background:${palette[i]}"></i></span>
              <b class="mono small" style="min-width:42px;text-align:right">${r.share}%</b>
            </span>
            ${r.detail ? `<span class="dim tiny mono" style="min-width:64px;text-align:right">${r.detail}</span>` : ''}
          </a>`).join('')}</div>
        <div class="tiny dim" style="margin-top:10px">${name} 佔該隊${unit}的比例。</div></div>`;
    }).join('');
    document.getElementById(`${mountId}Compare`).innerHTML = cards;
  };
  ids.forEach(id => { document.getElementById(id).onchange = render; });
  render();
}

const tempoBlock = tactics => tactics.some(t => t.tempo) ? `
  <div class="section"><h2>比賽時段</h2><span class="hint">上半場與下半場的淨勝球差異</span></div>
  <div id="tempo"></div>` : '';

/* 各隊入口。hint 要照實列該聯賽真的有的東西 —— 西甲沒有人員配置與定位球順位,
   照抄英超那句就是承諾了做不到的事。 */
function teamLinksBlock(tactics, hint) {
  if (!tactics.length) return '';
  return `
  <div class="section"><h2>看單一球隊</h2><span class="hint">${hint}</span></div>
  <div class="card">
    <div class="row" style="flex-wrap:wrap;gap:8px">
      ${tactics.map(t => `<a class="pill" href="${C.link('teams', { code: t.code })}"
        style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">
        ${C.badge(t.code)}${C.name(t.code)}
        ${t.formation?.label ? `<span class="dim tiny mono">${t.formation.label}</span>` : ''}</a>`).join('')}
    </div>
  </div>`;
}

// 西甲的逐場官方先發另存於單場分析頁；本頁的整季陣型比例仍只讀 Understat
// getTeamData，絕不把整季比例包裝成單場官方先發。
function renderLaLigaTactics({ meta, teams, tactics }) {
  const formationRows = tactics.flatMap(t => (t.formation?.list ?? []).map(f => ({
    code: t.code, formation: f.name, share: f.share, detail: `${f.minutes} 分`,
  })));
  const primary = tactics.map(t => ({
    code: t.code, formation: t.formation?.primary ?? null,
    matches: t.matches, xG90: t.attack?.xG90 ?? null, xGA90: t.defence?.xGA90 ?? null,
    share: t.formation?.list?.[0]?.share ?? null,
  }));
  C.registerTeams(teams); C.nav();
  app.innerHTML = `
    <div class="page-head">
      <h1>西甲戰術摘要</h1>
      <p>${meta.lastSeason} 完整賽季・資料來自 Understat 整隊統計。這裡顯示實際使用過的陣型比例、攻守 xG 與比賽節奏，供比較參考。</p>
      ${C.stampRow([
        C.stamp(`${meta.lastSeason} 整季`, { kind: 'season', note: '一季固定快取' }),
        C.stamp('Understat 球隊資料', { kind: 'manual', note: '不在開頁時連外請求' }),
      ])}
    </div>
    <div class="note info"><b>資料界線</b>：Understat 提供整隊實際使用陣型的統計；西甲逐場官方先發已在單場分析頁提供，但本頁不把整季比例當成單場先發，也不把官方陣型順序冒充精確球場座標。</div>
    <div class="section"><h2>各隊主要陣型</h2><span class="hint">整季使用分鐘最多的陣型</span></div>
    <div id="primary"></div>
    <div class="section"><h2>陣型佔比比較</h2><span class="hint">固定 A／B／C 三欄比較・佔比量的是整季出場分鐘</span></div>
    <div id="formations"></div>
    ${quadrantBlock(tactics, 'xG 與 xGA 來自 Understat 的整隊整季統計,不是球員層級加總。')}
    <div class="section"><h2>攻守與節奏對比</h2><span class="hint">上一季每場平均</span></div>
    <div id="attack"></div>
    ${resilienceBlock(tactics)}
    ${tempoBlock(tactics)}
    ${teamLinksBlock(tactics, '風格雷達、實際使用陣型與教練都在各隊自己的頁面')}
    <div class="note" style="margin-top:14px"><b>逐場資料</b>：單場分析頁已可查看目前完賽場次的官方先發；官網來源沒有第三方評分與座標時，畫面會保留從缺，不用推估值補上。</div>
    ${C.foot(meta)}`;
  document.getElementById('primary').innerHTML = C.table(primary, [
    { key: 'team', label: '球隊', value: r => C.name(r.code), render: r => C.teamCell(r.code) },
    { key: 'formation', label: '主要陣型', value: r => r.formation ?? '', render: r => r.formation ? `<b class="mono">${r.formation}</b>` : '—' },
    { key: 'share', label: '分鐘占比', value: r => r.share ?? -1, num: true, render: r => r.share == null ? '—' : `${r.share}%` },
    { key: 'matches', label: '整季場次', value: r => r.matches, num: true },
    { key: 'xG90', label: 'xG/場', value: r => r.xG90 ?? -1, num: true, render: r => C.fx(r.xG90, 2) },
    { key: 'xGA90', label: 'xGA/場', value: r => r.xGA90 ?? -1, num: true, render: r => C.fx(r.xGA90, 2) },
  ], { sortKey: 'xG90', desc: true, onRow: r => C.go('teams', { code: r.code }) });
  // 佔比的單位是「整季出場分鐘」—— 跟英超的「正式名單場次」不一樣,所以要講明
  formationCompare('formations', formationRows, { unit: '整季出場分鐘' });
  document.getElementById('attack').innerHTML = C.table(tactics, [
    { key: 'team', label: '球隊', value: r => C.name(r.code), render: r => C.teamCell(r.code) },
    { key: 'xG90', label: 'xG/場', value: r => r.attack?.xG90 ?? -1, num: true, render: r => C.fx(r.attack?.xG90, 2) },
    { key: 'xGA90', label: 'xGA/場', value: r => r.defence?.xGA90 ?? -1, num: true, render: r => C.fx(r.defence?.xGA90, 2) },
    { key: 'ppg', label: '場均勝點', value: r => r.ppg ?? -1, num: true, render: r => C.fx(r.ppg, 2) },
  ], { sortKey: 'xG90', desc: true, onRow: r => C.go('teams', { code: r.code }) });
  const tempoEl = document.getElementById('tempo');
  if (tempoEl) tempoEl.innerHTML = C.table(tactics.filter(t => t.tempo), tempoColumns(),
    { sortKey: 'swing', desc: true, onRow: t => { C.go('teams', { code: t.code }); } });
}

try {
  const { meta, clubs, teams, tactics } =
    await C.load('meta', 'clubs', 'teams', 'tactics');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  if (meta.edition === 'basic') {
    renderLaLigaTactics({ meta, teams, tactics });
  } else {
    const { formation, shapes } = await C.load('formation', 'shapes');
  // 英超官方陣型狀態來自 build 輸出的 meta.official；不能引用西甲
  // renderLaLigaTactics 函式內的區域變數，否則英超頁會直接拋例外。
  const hasTeamFormationOfficial = meta.official?.available === true
    && Number(meta.official?.teamsWithFormation ?? 0) > 0;

  const tacBy = new Map(tactics.map(t => [t.code, t]));

  app.innerHTML = `
  <div class="page-head">
    <h1>戰術分析</h1>
    <p>這一頁不談印象,只談上季 ${meta.lastSeason} 的 380 場比賽留下的痕跡:
       每支球隊實際把人力放在哪裡、機會創造得多好、領先之後守不守得住、進球集中在上半場還是下半場。
       所有指標都能對回原始賽果與球員數據。</p>
    ${C.stampRow([
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
      C.stamp('風格標籤與雷達圖', { kind: 'season', note: '由上季全季統計歸納' }),
    ])}
  </div>

  ${quadrantBlock(tactics, 'xG 來自球員層級的期望進球加總,xGA 取自門將的期望失球。')}

  <div class="section"><h2>人力配置</h2><span class="hint">用出場分鐘反推,平均每場擺出幾名後衛 / 中場 / 前鋒</span></div>
  <div id="shape"></div>
  <div class="note info" style="margin-top:10px">FPL 把邊鋒歸類為中場,所以這裡量的是「人力分佈」而不是轉播圖上的陣型。
    重點看小數:後場接近 5 就是三中衛/五後衛體系,鋒線超過 1.5 就是雙前鋒。</div>

  ${hasTeamFormationOfficial ? `
  <div class="section"><h2>官方陣型佔比</h2>
    <span class="hint">英超官方・${meta.official.matchesWithLineup} 場正式名單・佔比量的是場次</span></div>
  <div id="formations"></div>
  <div class="note ok" style="margin-top:10px">
    <b>這裡的陣型是官方公布的,不是我們算的。</b>
    每場比賽英超官方都會公布兩隊的正式陣型,上面的百分比是「該隊用這個陣型的場次 ÷ 有官方名單的場次」。
    <b>本季才剛開打,多數球隊只有一兩場</b> —— 一場 100% 跟十場 100% 不是同一回事,
    所以每一列右邊都把場次原始數字印出來,別只看長條。
    <div style="margin-top:6px">${C.stamp('英超官方陣型', {
      iso: meta.official.asOf, kind: 'daily',
      note: `pulselive・${meta.official.season ?? ''}・${meta.official.teamsWithFormation} 隊有紀錄`,
    })}</div>
  </div>` : ''}

  <div class="section"><h2>攻守分型</h2>
    <span class="hint">${hasTeamFormationOfficial
      ? '官方只公布一個陣型,有球無球的差別是我們自己推的'
      : '把 FPL 的四個粗類細分成八種角色後推導'}</span></div>
  <div id="shapeTable"></div>
  <div class="note info" style="margin-top:10px">
    <b>${hasTeamFormationOfficial ? '沒有官方資料時,是這樣推出來的。' : '這是怎麼推出來的。'}</b>FPL 只把球員分成門將/後衛/中場/前鋒四類,而且把邊鋒歸為中場 ——
    光看「五名中場」分不出那是三中場加兩邊鋒,還是五個中路球員,那是完全不同的球隊。
    所以這裡先用 per-90 的產出側寫把每個人細分成<b>中衛 / 邊後衛 / 防守中場 / 中場 / 前腰 / 邊鋒 / 中鋒</b>,
    再由各角色的出場分鐘推導常態陣型。
    <div style="margin-top:6px">分得開是因為差距很大:邊鋒每 90 分鐘的威脅值約 30、防守中場約 7;
      中衛的解圍攔截約 8、邊後衛約 3.5 而創造力是中衛的四倍。
      已用 15 位位置明確的球員驗證,全部分類正確。</div>
  </div>
  <div class="note" style="margin-top:10px">
    <b>攻守分型永遠是推論,官方沒有這個東西。</b>
    官方只公布一個陣型,不分有球無球;下面兩欄是我們自己推的,接了官方資料也不會變。
    我們沒有球員追蹤資料,做不到真正的「有球/無球站位」。這裡只用兩條最沒有爭議的規則:
    <b>創造力排在同角色前段的邊後衛,進攻時前壓</b>;<b>防守貢獻排在同角色前段的邊鋒,無球時退回中場線</b>。
    兩條都能從資料驗證,但它推的是傾向,不是實測位置。
    ${Object.values(shapes).filter(s => s.insufficient).length
      ? `另外有 ${Object.values(shapes).filter(s => s.insufficient).length} 支球隊(升班馬)沒有足夠的英超樣本,
         寧可標示資料不足也不編一個陣型出來。` : ''}
  </div>

  <div class="section"><h2>陣型到底有沒有影響</h2>
    <span class="hint">${formation.n} 隊・${meta.lastSeason} 完整賽季</span></div>
  <div class="grid g2">
    <div class="card">
      ${C.scatter(formation.points.map(p => ({
        x: p.mid, y: p.pts, code: p.code, color: colourOf(p.code),
        label: `${C.name(p.code)} 中場 ${p.mid} 人・${p.pts} 分`,
      })), { w: 560, h: 460, xLabel: '平均每場擺出幾名中場', yLabel: '該季聯賽積分', quadrants: false })}
      <div class="tiny dim">每個點是一支球隊。這是五組關係裡<b>最強的一組</b>,但請看右邊為什麼不能就這樣下結論。</div>
    </div>
    <div class="card">
      <h3>五組關係的相關係數</h3>
      <div id="corrTable"></div>
      <div class="tiny dim" style="margin-top:8px">
        r 介於 −1 到 1,絕對值越大關係越強。以 ${formation.n} 隊的樣本量來說,
        <b>|r| 要達到 ${formation.critical} 以上</b>才勉強算得上不是雜訊。
      </div>
    </div>
  </div>
  <div class="note" style="margin-top:10px">
    <b>先講結論:這幾個數字最可能是反過來的因果。</b>
    中場擺得多的隊積分高、前鋒擺得多的隊積分低 —— 但真實世界的順序比較可能是:
    <b>強隊控球多所以中場站得住,弱隊經常落後只好再推一個前鋒上去追分。</b>
    也就是陣型反映了球隊的處境與實力,而不是陣型造就了成績。
    要真的分離出「陣型的效果」,需要同一支球隊在實力相近時換陣型的對照,
    這個平台目前的資料量做不到,所以這裡只呈現相關,不宣稱因果。
  </div>
  <div class="card" style="margin-top:12px">
    <h3>後衛人數幾乎跟成績無關 —— 這件事本身值得說</h3>
    <div class="small muted" style="display:grid;gap:8px">
      <div>後衛平均人數與積分的 r 只有 <b>${formation.pairs.find(p => p.key === 'def-pts')?.r}</b>,
        與期望失球的 r 是 <b>${formation.pairs.find(p => p.key === 'def-xga')?.r}</b> ——
        兩個都遠低於門檻。<b>「三後衛比較穩」「五後衛比較保守」在這份資料裡看不出來。</b></div>
      <div>合理的解釋是:後防人數只是站位的起點,真正決定失球的是防線高度、壓迫強度、
        中場的保護,以及對手的水準 —— 這些都不會顯示在「擺了幾個後衛」這個數字上。</div>
      <div class="dim">注意:這裡的人數是用<b>出場分鐘反推的平均值</b>,不是轉播畫面上的陣型圖。
        FPL 把邊鋒歸類為中場,所以中場人數偏高是正常的。</div>
    </div>
  </div>

  ${resilienceBlock(tactics)}

  ${tempoBlock(tactics)}

  ${/* 這裡原本有一段「各隊風格卡」—— 20 張雷達圖,跟球隊詳情頁的「戰術風格」
       是同一張圖、同一組標籤,而且每張卡本身只是一個連到球隊頁的連結。
       同一份圖畫兩次,改了一邊另一邊就會悄悄過期,所以只留球隊頁那一份,
       這裡改成一排連結,要看誰就點誰。 */ ''}
  ${teamLinksBlock(tactics, '風格雷達、人員配置、定位球順位與教練都在各隊自己的頁面')}
  ${C.foot(meta)}`;

  const ROLE_ZH = { CB: '中衛', FB: '邊後衛', DM: '防中', CM: '中場', AM: '前腰', W: '邊鋒', ST: '中鋒' };
  // 這張表講的是「本季這 20 隊」,所以由 shapes 起頭而不是 tactics ——
  // tactics 來自上季英超,升班馬在裡面沒有資料,用它當來源會把三支升班馬整個漏掉,
  // 而它們正好是最需要官方陣型的隊伍(自己推導不出來)
  /* 官方陣型改用跟西甲同一套 A／B／C 比較版面。
     佔比 = 該隊用這個陣型的場次 ÷ 有官方名單的場次 —— 單位是**場次**,
     跟西甲的**出場分鐘**不同,所以 unit 要照實傳。 */
  if (hasTeamFormationOfficial) {
    const officialRows = Object.entries(shapes).flatMap(([code, sh]) => {
      const o = sh.official;
      if (!o?.games) return [];
      return (o.used ?? []).map(u => ({
        code, formation: u.formation,
        share: Math.round((u.games / o.games) * 1000) / 10,
        detail: `${u.games}/${o.games} 場`,
      }));
    });
    formationCompare('formations', officialRows, {
      unit: '官方名單場次',
      missing: Object.entries(shapes).filter(([, sh]) => !sh.official?.games).map(([code]) => code),
      missingNote: '官方要到開賽前約一小時才公布名單,這些球隊本季還沒有可採計的場次。',
    });
  }

  document.getElementById('shapeTable').innerHTML = C.table(
    Object.entries(shapes).map(([code, s]) => ({ ...(tacBy.get(code) ?? { code }), code, s })), [
      { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) },
      { key: 'base', label: '推導標準陣型', value: t => (t.s?.base?.label ?? ''), sortable: false,
        title: '由角色出場分鐘推導 —— 官方公布的那一個在上面的「官方陣型佔比」',
        render: t => (t.s?.insufficient
          ? '<span class="dim small">資料不足</span>'
          : `<b class="mono">${t.s.base.label}</b><span class="pill tiny" title="由角色出場分鐘推導">推導</span>`) },
      { key: 'att', label: '進攻時', value: t => (t.s?.attacking?.label ?? ''), sortable: false,
        title: '攻守分型一律是推導 —— 官方只公布一個陣型,不分有球無球',
        render: t => (t.s?.insufficient ? '—'
          : `<span class="mono" style="color:var(--accent)">${t.s.attacking.label}</span>${
            t.s.attacking.pushedUp ? `<span class="tiny dim"> 邊後衛前壓 ${t.s.attacking.pushedUp}</span>` : ''}`) },
      { key: 'def', label: '防守時', value: t => (t.s?.defending?.label ?? ''), sortable: false,
        render: t => (t.s?.insufficient ? '—'
          : `<span class="mono" style="color:var(--accent-3)">${t.s.defending.label}</span>${
            t.s.defending.droppedBack ? `<span class="tiny dim"> 邊鋒回收 ${t.s.defending.droppedBack}</span>` : ''}`) },
      { key: 'roles', label: '角色組成', value: () => 0, sortable: false, left: true,
        render: t => (t.s?.insufficient
          ? `<span class="tiny dim">只有 ${t.s.contributors} 名球員有足夠的英超樣本${
              t.s.official ? `,攻守分型待樣本累積(官方陣型已有 ${t.s.official.games} 場)` : ''}</span>`
          : `<span class="tiny dim">${Object.entries(t.s.counts).filter(([, n]) => n > 0)
              .map(([k, n]) => `${n}${ROLE_ZH[k]}`).join('・')}</span>`) },
      { key: 'fpl', label: 'FPL 粗類', value: t => t.formation?.def ?? -1, num: true,
        title: '上季英超出場分鐘反推的四類人力配置。升班馬上季不在英超,所以沒有',
        render: t => (t.formation
          ? `<span class="dim tiny mono">${t.formation.label}</span>`
          : '<span class="dim tiny">升班馬・上季不在英超</span>') },
    ], { sortKey: 'base', desc: false });

  document.getElementById('corrTable').innerHTML = C.table(formation.pairs, [
    { key: 'x', label: '陣型指標', value: p => p.x, left: true },
    { key: 'y', label: '對照的結果', value: p => p.y, left: true },
    { key: 'r', label: 'r', value: p => Math.abs(p.r ?? 0), num: true,
      render: p => `<b style="color:${p.significant ? 'var(--accent)' : 'var(--ink-3)'}">${p.r}</b>` },
    { key: 'sig', label: '達門檻?', value: p => (p.significant ? 1 : 0), sortable: false,
      render: p => (p.significant
        ? `<span class="pill accent tiny">是・${p.strength}</span>`
        : `<span class="pill tiny">否・${p.strength}</span>`) },
  ], { sortKey: 'r', desc: true });

  document.getElementById('shape').innerHTML = C.table(tactics, [
    { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) },
    { key: 'def', label: '後場', value: t => t.formation.def, num: true },
    { key: 'mid', label: '中場', value: t => t.formation.mid, num: true },
    { key: 'fwd', label: '鋒線', value: t => t.formation.fwd, num: true },
    { key: 'shape', label: '體系判讀', value: t => t.formation.shape, sortable: false,
      render: t => `<span class="small">${t.formation.shape}</span>` },
    { key: 'used', label: '使用人數', value: t => t.squad.used, num: true },
    { key: 'top11', label: '主力佔比', value: t => t.squad.top11Share, num: true, render: t => `${t.squad.top11Share}%` },
    { key: 'age', label: '加權年齡', value: t => t.squad.avgAgeWeighted, num: true },
    { key: 'cards', label: '每場牌數', value: t => t.discipline.perGame, num: true },
    { key: 'setp', label: '定位球 xG/場', value: t => t.setPieces.xG90 ?? -1, num: true,
      title: '上一完整賽季非十二碼定位球(角球 + 其他定位球 + 直接任意球)的每場期望進球',
      render: t => t.setPieces.available ? t.setPieces.xG90 : '—' },
    { key: 'spg', label: '定位球進 / 失', value: t => t.setPieces.goals ?? -1, num: true,
      render: t => t.setPieces.available ? `${t.setPieces.goals} / ${t.setPieces.conceded}` : '—' },
    { key: 'corner', label: '角球進球', value: t => t.setPieces.breakdown?.corner?.goals ?? -1, num: true,
      render: t => t.setPieces.breakdown?.corner?.goals ?? '—' },
  ], { sortKey: 'def', desc: true, onRow: t => { C.go('teams', { code: t.code }); } });

  const plTempo = document.getElementById('tempo');
  if (plTempo) plTempo.innerHTML = C.table(tactics, tempoColumns(),
    { sortKey: 'swing', desc: true, onRow: t => { C.go('teams', { code: t.code }); } });

  }
} catch (err) { C.fail(err); }
