import * as C from './core.js?v=e7d5f805';

const app = document.getElementById('app');

/* ── 一套版面,每個區塊(以及每個欄位)自己判斷資料在不在 ───────────────
   2026-09-13:這一頁原本是兩套版面。分界線一路退:
   `meta.edition === 'basic'`(是不是西甲)→ `tactics.some(t => t.squad)`(資料是哪一種)
   → 現在沒有分界線了。區塊照資料有沒有出現,缺就整塊不畫(鐵則三:不留永遠空白的欄位)。

   兩套版面的代價不是「多寫一次」,是**看不見的漏掉**:
   西甲的 `shapes.json` 裡 20 隊都有官方先發陣型,而舊的西甲分支從頭到尾沒讀它 ——
   資料在倉庫裡躺著,畫面上一個字都沒有(跟「西甲頭貼本來就有 727 張」同一類)。
   合併之後它自己就出現了,而且以後補區塊只要寫一次。

   **聯賽專屬的事實不寫在這裡。** 頁首那段話、xG 的出處、各隊頁有什麼,
   都由各聯賽的 build 寫進 `meta.tacticsPage`(跟 `intro` / `boundaries` 同一個做法)。
   前端寫死的話,另一個聯賽看到的就是別人的事實。 */

const colourOf = code => C.team(code).colors?.[0] ?? '#888';

/* 排序需要一個數字當哨兵(null 排不動),但**哨兵不可以印在畫面上**。
   `value: x ?? -1` 沒配 render 的話,表格就直接印那個 -1 —— 畫面上出現
   「角球進球 -1」這種不存在的數字,而它看起來完全像一個真數字(鐵則一)。
   實測踩到:西甲 VIL 與 OVI 的進球情境分類對不回整季總進球,產物依設計給 null,
   於是三欄印 -1、一欄印「null / null」(`npm run sweep` 只抓到後者 ——
   它掃的是字面的 null,而 -1 它看不出來)。
   所以凡是用哨兵的欄位都要經過這一層:沒有值就印「—」,並且說得出為什麼。 */
const cell = (v, fmt = x => x, why = '這一隊沒有這個數字') =>
  (v == null ? `<span class="dim" title="${C.esc(why)}">—</span>` : fmt(v));

/* 欄位級的自我判斷:某一欄所有球隊都沒有值就不要那一欄。
   整塊藏起來太粗(西甲有 xG 沒有 squad,兩者在同一張表裡過),
   留著又會是一排「—」—— 那就是鐵則三說的空欄位。 */
const columnsWith = (rows, defs) => defs.filter(([has]) => rows.some(has)).map(([, col]) => col);

/* ── 攻守四象限 ───────────────────────
   xG 的出處兩個聯賽不一樣(英超是球員層級加總,西甲是 Understat 整隊統計),
   所以那句話從 meta 讀 —— 寫死的話其中一個聯賽的出處就是錯的。 */
function quadrantBlock(tactics, xgNote) {
  const rows = tactics.filter(t => t.attack?.xG90 != null && t.defence?.xGA90 != null);
  if (!rows.length) return '';
  return `
  <div class="section"><h2>攻守四象限</h2><span class="hint">橫軸每場期望進球,縱軸每場期望失球(越上面防守越好)</span></div>
  <div class="card">
    ${C.scatter(rows.map(t => ({
      x: t.attack.xG90, y: t.defence.xGA90, code: t.code, color: colourOf(t.code),
      label: `${C.name(t.code)} xG ${t.attack.xG90} / xGA ${t.defence.xGA90}`,
    })), { xLabel: '每場期望進球 xG(越右攻擊力越強)', yLabel: '每場期望失球 xGA(越上防守越穩)', invertY: true })}
    <div class="tiny dim">右上角 = 攻守俱佳;左下角 = 兩頭落空。${xgNote ? C.esc(xgNote) : ''}</div>
  </div>`;
}

/* ── 各隊攻守總表 ─────────────────────
   原本是兩張表(西甲「各隊主要陣型」+「攻守與節奏對比」),而它們有一半的欄位相同。
   併成一張、欄位各自判斷:有主要陣型的聯賽多兩欄,沒有的少兩欄,英超因此也有了
   一張可以按 xG / xGA / 場均勝點排序的表(舊版只有四象限那張圖)。 */
const overviewBlock = tactics => tactics.some(t => t.attack?.xG90 != null || t.ppg != null) ? `
  <div class="section"><h2>各隊攻守總表</h2><span class="hint">點球隊進各自的頁面</span></div>
  <div id="overview"></div>` : '';

function renderOverview(tactics) {
  const el = document.getElementById('overview');
  if (!el) return;
  const cols = columnsWith(tactics, [
    [() => true, { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) }],
    [t => t.formation?.primary, { key: 'primary', label: '主要陣型', value: t => t.formation?.primary ?? '',
      render: t => (t.formation?.primary ? `<b class="mono">${C.esc(t.formation.primary)}</b>` : '—') }],
    [t => t.formation?.list?.[0]?.share != null, { key: 'share', label: '分鐘占比', num: true,
      value: t => t.formation?.list?.[0]?.share ?? -1,
      render: t => (t.formation?.list?.[0]?.share == null ? '—' : `${t.formation.list[0].share}%`) }],
    [t => t.matches != null, { key: 'matches', label: '整季場次', value: t => t.matches ?? -1, num: true,
      render: t => cell(t.matches) }],
    [t => t.attack?.xG90 != null, { key: 'xG90', label: 'xG/場', value: t => t.attack?.xG90 ?? -1, num: true,
      render: t => C.fx(t.attack?.xG90, 2) }],
    [t => t.defence?.xGA90 != null, { key: 'xGA90', label: 'xGA/場', value: t => t.defence?.xGA90 ?? -1, num: true,
      render: t => C.fx(t.defence?.xGA90, 2) }],
    [t => t.ppg != null, { key: 'ppg', label: '場均勝點', value: t => t.ppg ?? -1, num: true, render: t => C.fx(t.ppg, 2) }],
  ]);
  el.innerHTML = C.table(tactics, cols, {
    sortKey: cols.some(c => c.key === 'xG90') ? 'xG90' : 'team', desc: true,
    onRow: t => C.go('teams', { code: t.code }),
  });
}

/* ── 陣型佔比比較 ─────────────────────
   固定 A／B／C 三欄,每欄挑一種陣型,列出哪些球隊用它、用了多少比例。

   **同一頁可以有兩個這種區塊,而且單位不一樣**:官方公布的先發算的是**場次**、
   Understat 的整季陣型算的是**出場分鐘**,而且兩者不是同一季。寫死其中一種,
   另一個的說明就是假的 —— 所以 unit 與掛載點都由呼叫端給,每張卡下緣把單位印出來。

   rows: [{ code, formation, share, detail }] —— 一列是「某隊用某陣型的佔比」
   missing: 沒有資料的球隊代碼,列在 footnote 而不是留一片空白(鐵則三) */
function formationCompare(mountId, rows, { unit, missing = [], missingNote = '' }) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  if (!rows.length) {
    mount.innerHTML = `<div class="note">目前沒有可用的陣型佔比資料。${C.esc(missingNote)}</div>`;
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
    <select id="${id}">${available.map(name => `<option value="${C.esc(name)}"${name === selected ? ' selected' : ''}>${C.esc(name)}</option>`).join('')}</select></label>`;

  mount.innerHTML = `
    <div class="filters" style="margin-bottom:12px;align-items:end">
      ${select(`${mountId}A`, '陣型 A', pick[0])}
      ${select(`${mountId}B`, '陣型 B', pick[1] ?? pick[0])}
      ${select(`${mountId}C`, '陣型 C', pick[2] ?? pick[0])}
      <span class="dim tiny">從選單切換,即時比較各隊的使用比例(單位:${C.esc(unit)})</span>
    </div>
    <div class="grid g2" id="${mountId}Compare"></div>
    ${missing.length ? `<div class="tiny dim" style="margin-top:10px">
      ${missing.length} 隊還沒有可統計的陣型:${missing.map(c => C.name(c)).join('、')}。${C.esc(missingNote)}</div>` : ''}`;

  const ids = [`${mountId}A`, `${mountId}B`, `${mountId}C`];
  const palette = ['var(--accent)', 'var(--accent-3)', 'var(--accent-2)'];
  const render = () => {
    const cards = ids.map((id, i) => {
      const name = document.getElementById(id).value;
      const list = [...rowsOf(name)].sort((a, b) => b.share - a.share || C.name(a.code).localeCompare(C.name(b.code), 'zh-Hant'));
      return `<div class="card">
        <div class="spread"><h3 style="margin:0"><span class="pill tiny">${String.fromCharCode(65 + i)}</span>
          <span class="mono">${C.esc(name)}</span></h3><span class="dim tiny">${list.length} 隊使用</span></div>
        <div style="display:grid;gap:8px;margin-top:12px">${list.map(r => `
          <a href="${C.link('teams', { code: r.code })}" class="stat-line" style="text-decoration:none;gap:10px">
            <span class="small" style="min-width:130px">${C.badge(r.code)} ${C.name(r.code)}</span>
            <span style="flex:1;display:flex;align-items:center;gap:8px">
              <span style="height:6px;flex:1;background:var(--ink-5);border-radius:4px;overflow:hidden"
                ><i style="display:block;height:100%;width:${Math.min(100, Math.max(0, r.share))}%;background:${palette[i]}"></i></span>
              <b class="mono small" style="min-width:42px;text-align:right">${r.share}%</b>
            </span>
            ${r.detail ? `<span class="dim tiny mono" style="min-width:64px;text-align:right">${C.esc(r.detail)}</span>` : ''}
          </a>`).join('')}</div>
        <div class="tiny dim" style="margin-top:10px">${C.esc(name)} 佔該隊${C.esc(unit)}的比例。</div></div>`;
    }).join('');
    document.getElementById(`${mountId}Compare`).innerHTML = cards;
  };
  ids.forEach(id => { document.getElementById(id).onchange = render; });
  render();
}

/* 官方公布的先發陣型(本季,單位=場次)。兩個聯賽都有:英超來自 pulselive,
   西甲來自逐場正式名單自己帶的陣型欄位 —— **都是上游公布的,不是我們推的**。
   判斷一律看 shapes 裡有沒有 official.games,不看 meta 的旗標:
   西甲的 `meta.official.teamFormation` 是 false(講的是官方球隊端點),
   而逐場名單裡的陣型 20 隊都有 —— 拿旗標當分界會把整個區塊藏起來。 */
const officialFormationRows = shapes => Object.entries(shapes ?? {}).flatMap(([code, sh]) => {
  const o = sh?.official;
  if (!o?.games) return [];
  return (o.used ?? []).map(u => ({
    code, formation: u.formation,
    share: Math.round((u.games / o.games) * 1000) / 10,
    detail: `${u.games}/${o.games} 場`,
  }));
});

function officialSection(shapes, meta) {
  if (!officialFormationRows(shapes).length) return '';
  const games = Object.values(shapes).reduce((n, sh) => Math.max(n, sh?.official?.games ?? 0), 0);
  const matches = meta.official?.matchesWithLineup ?? meta.official?.matches ?? null;
  return `
  <div class="section"><h2>官方陣型佔比</h2>
    <span class="hint">${meta.currentSeason} 進行中${matches ? `・${matches} 場正式名單` : ''}・佔比量的是場次</span></div>
  <div id="offFormations"></div>
  <div class="note ok" style="margin-top:10px">
    <b>這裡的陣型是上游公布的,不是我們算的。</b>
    百分比是「該隊用這個陣型的場次 ÷ 它有正式名單的場次」。
    <b>單隊最多也只有 ${games} 場</b> —— 一場 100% 跟十場 100% 不是同一回事,
    所以每一列右邊都把場次原始數字印出來,別只看長條。
    ${meta.official?.source ? `<div style="margin-top:6px">${C.stamp(`正式名單來源:${meta.official.source}`, {
      ...(meta.official.asOf ? { iso: meta.official.asOf } : {}), kind: 'daily',
      note: '開賽前約一小時才公布,所以剛開季的場次數會很少',
    })}</div>` : ''}
  </div>`;
}

/* 整季實際使用的陣型(上季,單位=出場分鐘)。跟上面那一塊是兩件事:
   不同季、不同單位、不同來源 —— 所以是兩個區塊,不是同一個區塊的兩種模式。 */
const minuteFormationRows = tactics => tactics.flatMap(t => (t.formation?.list ?? []).map(f => ({
  code: t.code, formation: f.name, share: f.share, detail: `${f.minutes} 分`,
})));

const minutesSection = (tactics, meta) => minuteFormationRows(tactics).length ? `
  <div class="section"><h2>整季陣型佔比</h2>
    <span class="hint">${meta.lastSeason} 完整賽季・佔比量的是出場分鐘</span></div>
  <div id="minFormations"></div>` : '';

/* ── 人力配置(需要 FPL 反推的 squad)──────
   下面那段說明講的是 FPL 的分類方式,所以它跟著 squad 這份資料走,
   不是跟著聯賽走 —— 哪天別的聯賽也有 FPL 式的逐場位置,同一段話仍然成立。 */
const shapeSection = tactics => tactics.some(t => t.squad && t.formation?.def != null) ? `
  <div class="section"><h2>人力配置</h2><span class="hint">用出場分鐘反推,平均每場擺出幾名後衛 / 中場 / 前鋒</span></div>
  <div id="shape"></div>
  <div class="note info" style="margin-top:10px">FPL 把邊鋒歸類為中場,所以這裡量的是「人力分佈」而不是轉播圖上的陣型。
    重點看小數:後場接近 5 就是三中衛/五後衛體系,鋒線超過 1.5 就是雙前鋒。</div>` : '';

function renderShape(tactics) {
  const el = document.getElementById('shape');
  if (!el) return;
  const rows = tactics.filter(t => t.squad && t.formation?.def != null);
  const cols = columnsWith(rows, [
    [() => true, { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) }],
    [t => t.formation?.def != null, { key: 'def', label: '後場', value: t => t.formation.def, num: true }],
    [t => t.formation?.mid != null, { key: 'mid', label: '中場', value: t => t.formation.mid, num: true }],
    [t => t.formation?.fwd != null, { key: 'fwd', label: '鋒線', value: t => t.formation.fwd, num: true }],
    [t => t.formation?.shape, { key: 'shape', label: '體系判讀', value: t => t.formation.shape, sortable: false,
      render: t => `<span class="small">${C.esc(t.formation.shape)}</span>` }],
    [t => t.squad?.used != null, { key: 'used', label: '使用人數', value: t => t.squad.used, num: true }],
    [t => t.squad?.top11Share != null, { key: 'top11', label: '主力佔比', value: t => t.squad.top11Share, num: true,
      render: t => `${t.squad.top11Share}%` }],
    [t => t.squad?.avgAgeWeighted != null, { key: 'age', label: '加權年齡', value: t => t.squad.avgAgeWeighted, num: true }],
    [t => t.discipline?.perGame != null, { key: 'cards', label: '每場牌數', value: t => t.discipline.perGame, num: true }],
  ]);
  el.innerHTML = C.table(rows, cols, { sortKey: 'def', desc: true, onRow: t => { C.go('teams', { code: t.code }); } });
}

/* 進球數為什麼會是空的:產物在「進球情境分類加起來對不回整季總進球」時
   一律把進球數設成 null(`lib/tactics.mjs` 的 `situation()`),xG 仍然可用。
   那是刻意的,所以畫面要講得出來,不是印一個「—」就算了(鐵則四)。 */
const UNRELIABLE = '這一隊的進球情境分類加起來對不回整季總進球,所以進球數不顯示;xG 不受影響';

/* ── 定位球(兩個聯賽都有,來源都是 Understat)──
   這幾欄原本混在英超的「人力配置」表裡,於是**西甲有同一份資料卻看不到** ——
   自己一塊之後兩邊都有,而且季別與來源講得出來(從 setPieces 自己的欄位讀)。 */
const setPieceSection = tactics => tactics.some(t => t.setPieces?.available) ? (() => {
  const sp = tactics.find(t => t.setPieces?.available).setPieces;
  const unreliable = tactics.filter(t => t.setPieces?.available && t.setPieces.goalsReliable === false).map(t => t.code);
  return `
  <div class="section"><h2>定位球</h2>
    <span class="hint">非十二碼定位球(角球 + 其他定位球 + 直接任意球)${sp.matches ? `・整季 ${sp.matches} 場` : ''}</span></div>
  <div id="setPiece"></div>
  <div class="note info" style="margin-top:10px">
    十二碼另外算,不混進定位球 —— 它是犯規的結果,不是戰術設計。
    ${sp.source ? `資料來自 ${C.esc(sp.source)} 的整隊分類統計(五類相加等於該季總進球,核對過)。` : ''}
    ${unreliable.length ? `<div style="margin-top:6px">${unreliable.length} 隊(${unreliable.map(c => C.name(c)).join('、')})
      的分類加起來<b>對不回</b>整季總進球,所以它們的進球數不顯示 —— xG 不受影響,
      寧可空著也不給一個湊出來的數字。</div>` : ''}
  </div>`;
})() : '';

function renderSetPiece(tactics) {
  const el = document.getElementById('setPiece');
  if (!el) return;
  const rows = tactics.filter(t => t.setPieces?.available);
  const br = (t, key) => t.setPieces.breakdown?.[key]?.goals ?? null;
  const cols = columnsWith(rows, [
    [() => true, { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) }],
    [t => t.setPieces.xG90 != null, { key: 'xg', label: '定位球 xG/場', value: t => t.setPieces.xG90 ?? -1, num: true,
      title: '非十二碼定位球的每場期望進球', render: t => C.fx(t.setPieces.xG90, 3) }],
    [t => t.setPieces.goals != null, { key: 'gf', label: '定位球進 / 失', value: t => t.setPieces.goals ?? -1, num: true,
      render: t => (t.setPieces.goals == null || t.setPieces.conceded == null
        ? cell(null, x => x, UNRELIABLE) : `${t.setPieces.goals} / ${t.setPieces.conceded}`) }],
    [t => t.setPieces.xGA90 != null, { key: 'xga', label: '被定位球 xGA/場', value: t => t.setPieces.xGA90 ?? -1, num: true,
      render: t => C.fx(t.setPieces.xGA90, 3) }],
    [t => br(t, 'corner') != null, { key: 'corner', label: '角球進球',
      value: t => br(t, 'corner') ?? -1, num: true, render: t => cell(br(t, 'corner'), x => x, UNRELIABLE) }],
    [t => br(t, 'otherSetPiece') != null, { key: 'other', label: '其他定位球',
      value: t => br(t, 'otherSetPiece') ?? -1, num: true, render: t => cell(br(t, 'otherSetPiece'), x => x, UNRELIABLE) }],
    [t => br(t, 'directFreeKick') != null, { key: 'fk', label: '直接任意球',
      value: t => br(t, 'directFreeKick') ?? -1, num: true, render: t => cell(br(t, 'directFreeKick'), x => x, UNRELIABLE) }],
    [t => t.setPieces.defenderGoalShare != null, { key: 'dfd', label: '後衛進球佔比', value: t => t.setPieces.defenderGoalShare ?? -1,
      num: true, title: '該隊總進球裡後衛貢獻的比例', render: t => cell(t.setPieces.defenderGoalShare, x => `${x}%`) }],
    /* 主罰順位英超有、西甲的交付檔是空陣列 —— 整欄都沒有人就不要這一欄(鐵則三) */
    [t => t.setPieces.takers?.corner?.length, { key: 'taker', label: '主罰角球', sortable: false, left: true,
      value: t => t.setPieces.takers?.corner?.[0]?.name ?? '',
      render: t => (t.setPieces.takers?.corner?.length
        ? `<span class="small">${C.esc(t.setPieces.takers.corner[0].name)}</span>` : '—') }],
  ]);
  el.innerHTML = C.table(rows, cols, { sortKey: 'xg', desc: true, onRow: t => { C.go('teams', { code: t.code }); } });
}

/* ── 攻守分型(需要角色推導,也就是 shapes 裡的 base / counts)── */
const ROLE_ZH = { CB: '中衛', FB: '邊後衛', DM: '防中', CM: '中場', AM: '前腰', W: '邊鋒', ST: '中鋒' };
const hasRoleShapes = shapes => Object.values(shapes ?? {}).some(s => s?.base || s?.counts);

function shapeTableSection(shapes) {
  if (!hasRoleShapes(shapes)) return '';
  const official = officialFormationRows(shapes).length;
  const short = Object.values(shapes).filter(s => s.insufficient).length;
  return `
  <div class="section"><h2>攻守分型</h2>
    <span class="hint">${official
      ? '官方只公布一個陣型,有球無球的差別是我們自己推的'
      : '把 FPL 的四個粗類細分成八種角色後推導'}</span></div>
  <div id="shapeTable"></div>
  <div class="note info" style="margin-top:10px">
    <b>${official ? '沒有官方資料時,是這樣推出來的。' : '這是怎麼推出來的。'}</b>FPL 只把球員分成門將/後衛/中場/前鋒四類,而且把邊鋒歸為中場 ——
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
    ${short ? `另外有 ${short} 支球隊(升班馬)沒有足夠的樣本,寧可標示資料不足也不編一個陣型出來。` : ''}
  </div>`;
}

function renderShapeTable(shapes, tactics) {
  const el = document.getElementById('shapeTable');
  if (!el) return;
  const tacBy = new Map(tactics.map(t => [t.code, t]));
  /* 這張表講的是「本季這幾隊」,所以由 shapes 起頭而不是 tactics ——
     tactics 來自上季,升班馬在裡面沒有資料,用它當來源會把升班馬整個漏掉,
     而它們正好是最需要官方陣型的隊伍(自己推導不出來)。 */
  const rows = Object.entries(shapes).map(([code, s]) => ({ ...(tacBy.get(code) ?? { code }), code, s }));
  el.innerHTML = C.table(rows, [
    { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) },
    { key: 'base', label: '推導標準陣型', value: t => (t.s?.base?.label ?? ''), sortable: false,
      title: '由角色出場分鐘推導 —— 官方公布的那一個在上面的「官方陣型佔比」',
      render: t => (t.s?.insufficient || !t.s?.base
        ? '<span class="dim small">資料不足</span>'
        : `<b class="mono">${C.esc(t.s.base.label)}</b><span class="pill tiny" title="由角色出場分鐘推導">推導</span>`) },
    { key: 'att', label: '進攻時', value: t => (t.s?.attacking?.label ?? ''), sortable: false,
      title: '攻守分型一律是推導 —— 官方只公布一個陣型,不分有球無球',
      render: t => (t.s?.insufficient || !t.s?.attacking ? '—'
        : `<span class="mono" style="color:var(--accent)">${C.esc(t.s.attacking.label)}</span>${
          t.s.attacking.pushedUp ? `<span class="tiny dim"> 邊後衛前壓 ${t.s.attacking.pushedUp}</span>` : ''}`) },
    { key: 'def', label: '防守時', value: t => (t.s?.defending?.label ?? ''), sortable: false,
      render: t => (t.s?.insufficient || !t.s?.defending ? '—'
        : `<span class="mono" style="color:var(--accent-3)">${C.esc(t.s.defending.label)}</span>${
          t.s.defending.droppedBack ? `<span class="tiny dim"> 邊鋒回收 ${t.s.defending.droppedBack}</span>` : ''}`) },
    { key: 'roles', label: '角色組成', value: () => 0, sortable: false, left: true,
      render: t => (t.s?.insufficient
        ? `<span class="tiny dim">只有 ${t.s.contributors} 名球員有足夠的樣本${
            t.s.official ? `,攻守分型待樣本累積(官方陣型已有 ${t.s.official.games} 場)` : ''}</span>`
        : `<span class="tiny dim">${Object.entries(t.s.counts ?? {}).filter(([, n]) => n > 0)
            .map(([k, n]) => `${n}${ROLE_ZH[k] ?? k}`).join('・')}</span>`) },
    { key: 'fpl', label: 'FPL 粗類', value: t => t.formation?.def ?? -1, num: true,
      title: '上季出場分鐘反推的四類人力配置。升班馬上季不在這個聯賽,所以沒有',
      render: t => (t.formation?.def != null
        ? `<span class="dim tiny mono">${C.esc(t.formation.label)}</span>`
        : '<span class="dim tiny">升班馬・上季不在這個聯賽</span>') },
  ], { sortKey: 'base', desc: false });
}

/* ── 陣型到底有沒有影響(需要 formation.json)── */
function formationEffectSection(formation, meta) {
  if (!formation?.pairs?.length || !formation?.points?.length) return '';
  const pair = key => formation.pairs.find(p => p.key === key)?.r ?? '—';
  return `
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
      <div>後衛平均人數與積分的 r 只有 <b>${pair('def-pts')}</b>,
        與期望失球的 r 是 <b>${pair('def-xga')}</b> ——
        兩個都遠低於門檻。<b>「三後衛比較穩」「五後衛比較保守」在這份資料裡看不出來。</b></div>
      <div>合理的解釋是:後防人數只是站位的起點,真正決定失球的是防線高度、壓迫強度、
        中場的保護,以及對手的水準 —— 這些都不會顯示在「擺了幾個後衛」這個數字上。</div>
      <div class="dim">注意:這裡的人數是用<b>出場分鐘反推的平均值</b>,不是轉播畫面上的陣型圖。
        FPL 把邊鋒歸類為中場,所以中場人數偏高是正常的。</div>
    </div>
  </div>`;
}

function renderCorr(formation) {
  const el = document.getElementById('corrTable');
  if (!el) return;
  el.innerHTML = C.table(formation.pairs, [
    { key: 'x', label: '陣型指標', value: p => p.x, left: true },
    { key: 'y', label: '對照的結果', value: p => p.y, left: true },
    { key: 'r', label: 'r', value: p => Math.abs(p.r ?? 0), num: true,
      render: p => `<b style="color:${p.significant ? 'var(--accent)' : 'var(--ink-3)'}">${p.r}</b>` },
    { key: 'sig', label: '達門檻?', value: p => (p.significant ? 1 : 0), sortable: false,
      render: p => (p.significant
        ? `<span class="pill accent tiny">是・${p.strength}</span>`
        : `<span class="pill tiny">否・${p.strength}</span>`) },
  ], { sortKey: 'r', desc: true });
}

/* ── 領先之後守不守得住 ─────────────── */
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

/* ── 比賽時段 ───────────────────────── */
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

const tempoBlock = tactics => tactics.some(t => t.tempo && t.resilience) ? `
  <div class="section"><h2>比賽時段</h2><span class="hint">上半場與下半場的淨勝球差異</span></div>
  <div id="tempo"></div>` : '';

/* ── 各隊入口 ───────────────────────
   hint 要照實列該聯賽真的有的東西,所以從 meta 讀 ——
   照抄另一個聯賽那句就是承諾了做不到的事。 */
function teamLinksBlock(tactics, hint) {
  if (!tactics.length) return '';
  return `
  <div class="section"><h2>看單一球隊</h2>${hint ? `<span class="hint">${C.esc(hint)}</span>` : ''}</div>
  <div class="card">
    <div class="row" style="flex-wrap:wrap;gap:8px">
      ${tactics.map(t => `<a class="pill" href="${C.link('teams', { code: t.code })}"
        style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">
        ${C.badge(t.code)}${C.name(t.code)}
        ${t.formation?.label ? `<span class="dim tiny mono">${C.esc(t.formation.label)}</span>` : ''}</a>`).join('')}
    </div>
  </div>`;
}

try {
  const { meta, clubs, teams, tactics } = await C.load('meta', 'clubs', 'teams', 'tactics');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const page = meta.tacticsPage ?? {};
  /* 還要讀哪幾份產物由 **build 宣告**(`meta.tacticsPage.datasets`),不是前端猜。
     上一版為了判斷走哪套版面去 fetch `formation` 與 `shapes`,西甲每次進這一頁
     就多打兩個 404(`npm run sweep` 抓到的)。現在寫的人知道自己寫了什麼就列進來;
     沒宣告的聯賽一個請求都不發。 */
  const extra = await C.load(...(page.datasets ?? []));
  const shapes = extra.shapes ?? {};
  const formation = extra.formation ?? null;

  app.innerHTML = `
  <div class="page-head">
    <h1>戰術分析</h1>
    ${page.intro ? `<p>${C.esc(page.intro)}</p>` : ''}
    ${C.stampRow([
      C.stamp(`${meta.lastSeason} 整季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
      officialFormationRows(shapes).length
        ? C.stamp(`${meta.currentSeason} 正式名單陣型`, { kind: 'daily', note: '每場開賽前約一小時公布,逐場累積' })
        : null,
    ])}
  </div>
  ${(page.boundaries ?? []).length ? `<div class="note info"><b>資料界線</b>:
    ${(page.boundaries ?? []).map(b => C.esc(b)).join('<br>')}</div>` : ''}

  ${quadrantBlock(tactics, page.xgNote)}
  ${overviewBlock(tactics)}
  ${officialSection(shapes, meta)}
  ${minutesSection(tactics, meta)}
  ${shapeSection(tactics)}
  ${shapeTableSection(shapes)}
  ${formationEffectSection(formation, meta)}
  ${setPieceSection(tactics)}
  ${resilienceBlock(tactics)}
  ${tempoBlock(tactics)}
  ${/* 這裡原本有一段「各隊風格卡」—— 20 張雷達圖,跟球隊詳情頁的「戰術風格」
       是同一張圖、同一組標籤,而且每張卡本身只是一個連到球隊頁的連結。
       同一份圖畫兩次,改了一邊另一邊就會悄悄過期,所以只留球隊頁那一份。 */ ''}
  ${teamLinksBlock(tactics, page.teamHint)}
  ${C.foot(meta)}`;

  renderOverview(tactics);
  formationCompare('offFormations', officialFormationRows(shapes), {
    unit: '正式名單場次',
    missing: Object.entries(shapes).filter(([, sh]) => !sh?.official?.games).map(([code]) => code),
    missingNote: '正式名單要到開賽前約一小時才公布,這些球隊本季還沒有可採計的場次。',
  });
  formationCompare('minFormations', minuteFormationRows(tactics), { unit: '整季出場分鐘' });
  renderShape(tactics);
  renderShapeTable(shapes, tactics);
  if (formation) renderCorr(formation);
  renderSetPiece(tactics);

  const tempoEl = document.getElementById('tempo');
  if (tempoEl) tempoEl.innerHTML = C.table(tactics.filter(t => t.tempo && t.resilience), tempoColumns(),
    { sortKey: 'swing', desc: true, onRow: t => { C.go('teams', { code: t.code }); } });
} catch (err) { C.fail(err); }
