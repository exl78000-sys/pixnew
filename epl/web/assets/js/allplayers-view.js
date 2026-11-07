import * as C from './core.js?v=e883428c';

/* 跨聯賽球員表(球員頁「全部球員」勾了其他聯賽時畫的那一張)。
   2026-08-30 是獨立的總球員頁(合併單表、隊徽與頭貼),09-03 併進「探索」,11-07 上午併進球員頁的「全部聯賽」,
   11-07 下午再併進球員頁的「全部球員」那一節(使用者:「把全部聯賽球員 整合進 聯賽全部球員搜尋部分 可勾選要搜尋範圍」):
   搜尋範圍由勾選決定,這個模組只負責「給定幾個聯賽與一個搜尋字,畫合併表」。設計決定,都是踩過的坑或明寫的界線:

   1. **聯賽從註冊表長出來,不寫死**(勾選框也是)。
   2. **合併顯示,但互比要標**:分鐘/進球/助攻是同一種事實,可以排序;
      xG/xA 兩邊模型不同(FPL vs Understat),欄位照出、警語常駐 ——
      每一列都掛聯賽籤,讀者知道自己在比什麼。
   3. **整欄都是 null 的欄位不畫**;個別 null 顯示 —、排序沉底(null 不是 0)。
   4. **隊徽與頭貼不走全域登錄** —— 隊碼跨聯賽會撞(BUR),各聯賽自己一張表。
      這一張表現在畫在聯賽頁上,全域登錄是**這個聯賽**的名冊,登錄別的聯賽會蓋掉它。
      頭貼**首屏不揹**:先畫表,背景載完再補畫 —— 搜尋功能不等圖。
   5. **每個聯賽的資料只載一次**(players-core + clubs),搜尋字變了只重畫。
      未勾選聯賽的「另有幾筆符合」也走同一份快取 —— 兩份快取會把同一個檔載兩次。 */

const STAT_COLS = [
  ['minutes', '分鐘'], ['goals', '進球'], ['assists', '助攻'],
  ['xG', 'xG'], ['xA', 'xA'], ['shots', '射門'], ['keyPasses', '關鍵傳球'],
  ['yellow', '黃牌'], ['red', '紅牌'],
];

/* 有球員層的聯賽(沒開球員頁的就沒有 players-core,不去打一個註定 404 的請求) */
export const playerLeagues = () => Object.keys(C.LEAGUES)
  .filter(lg => !C.LEAGUES[lg]?.open || C.LEAGUES[lg].open.includes('players'));

const poolCache = new Map();   // lg → Promise<{ lg, rows, crestBy }>
function pool(lg) {
  if (!poolCache.has(lg)) poolCache.set(lg, (async () => {
    try {
      const { data } = await C.loadFrom(lg, ['players-core', 'clubs']);
      const clubs = (data.clubs?.clubs ?? data.clubs ?? []);
      return { lg, rows: Array.isArray(data['players-core']) ? data['players-core'] : null,
        crestBy: new Map(clubs.map(c => [c.code, c.crest ?? null])) };
    } catch { return { lg, rows: null, crestBy: new Map() }; }
  })());
  return poolCache.get(lg);
}

/* 本季在歐冠的球隊,標在球員列上(使用者要求「例如 英超 西甲 歐冠」)。
   只標**本季**有參賽的 —— ucl-teams 帶每一隊出現在哪幾季;拿三季合起來的名單標,
   會把上季踢過、本季沒進的也標上。沒有歐冠資料就不標,不猜。 */
let uclP = null;
const uclSet = () => (uclP ??= (async () => {
  try {
    const { data } = await C.loadFrom('pl', ['ucl-teams', 'competitions']);
    C.registerCompetitions(data.competitions);   // 賽事欄的圖像:有真圖就用真圖
    const cur = data['ucl-teams']?.currentSeason;
    return new Set((data['ucl-teams']?.teams ?? [])
      .filter(t => cur && (t.seasons ?? []).includes(cur))
      .map(t => `${t.league}|${t.code}`));
  } catch { return new Set(); }   // 跨聯賽那份不在就不標
})());

/* 頭貼:背景懶載入,載完補畫。key 用 lg|code —— code 跨聯賽也可能撞 */
const photoBy = new Map();
const photoDone = new Map();   // lg → Promise
function loadPhotos(lg) {
  if (!photoDone.has(lg)) photoDone.set(lg, (async () => {
    try {
      // 頭貼路徑在 players-list 就有(2026-09-27,A6 第二段)—— 以前為了照片背景載整份 players.json,六個聯賽 5 MB
      const { data } = await C.loadFrom(lg, ['players-list']);
      for (const p of Array.isArray(data['players-list']) ? data['players-list'] : []) {
        if (p.photo && p.code != null) photoBy.set(`${lg}|${p.code}`, p.photo);
      }
    } catch { /* 沒有就沒有,不擋表 */ }
  })());
  return photoDone.get(lg);
}

const matches = (p, ql) => p.name.toLowerCase().includes(ql)
  || (p.fullName ?? '').toLowerCase().includes(ql)
  || (p.team ?? '').toLowerCase() === ql;

/* 未勾選的聯賽裡有幾筆符合(只回數字,畫面講「勾選就會列出來」)。q 至少 2 個字才查 */
export async function otherHits(q, lgs) {
  const ql = (q ?? '').trim().toLowerCase();
  if (ql.length < 2 || !lgs.length) return [];
  const loaded = await Promise.all(lgs.map(pool));
  return loaded.map(x => ({ lg: x.lg, n: (x.rows ?? []).filter(p => matches(p, ql)).length })).filter(x => x.n);
}

let season = null;    // 賽季選擇跨重畫保留(讀者選了上季,打字搜尋時不要被拉回本季)
let token = 0;
let last = null;      // 最近一次的參數:頭貼載完補畫用

/* host:畫在哪裡;lgs:勾選的聯賽(含不含這個聯賽由呼叫端決定);q:搜尋字(不到 2 個字當沒搜尋) */
export async function renderCrossLeague(host, { lgs, q }) {
  const tok = ++token;
  last = { host, lgs, q };
  if (!lgs.length) { host.innerHTML = ''; return; }
  if (lgs.some(lg => !poolCache.has(lg))) host.innerHTML = '<div class="loading">載入勾選的聯賽…</div>';
  const [loaded, inUcl] = await Promise.all([Promise.all(lgs.map(pool)), uclSet()]);
  if (tok !== token || !host.isConnected) return;
  draw(host, loaded, inUcl, q);
  // 頭貼背景補:還沒載過的聯賽載完後,若畫面還是同一次呼叫就重畫一次
  const pending = lgs.filter(lg => !photoDone.has(lg));
  if (pending.length) {
    await Promise.all(pending.map(loadPhotos));
    if (tok === token && last?.host.isConnected) draw(last.host, loaded, inUcl, last.q, true);
  }
}

function draw(host, loaded, inUcl, q, photosReady = loaded.every(x => photoDone.has(x.lg))) {
  const pools = loaded.filter(x => x.rows?.length);
  const missing = loaded.filter(x => !x.rows?.length).map(x => x.lg);
  const all = pools.flatMap(x => x.rows);   // players-core 每列本來就帶 league 欄位
  const seasons = [...new Set(all.flatMap(p => p.seasons.map(s => s.season)))].sort().reverse();
  if (!seasons.includes(season)) season = seasons[0] ?? null;
  const statFor = p => p.seasons.find(s => s.season === season) ?? null;
  const crestOf = (lg, code) => pools.find(x => x.lg === lg)?.crestBy.get(code) ?? null;
  const ql = (q ?? '').trim().length >= 2 ? q.trim().toLowerCase() : '';
  const hit = ql ? all.filter(p => matches(p, ql)) : all;
  const has = key => hit.some(p => statFor(p)?.[key] != null);
  const cols = [
    { key: 'lg', label: '賽事', num: false, left: true, value: p => p.league,
      render: p => `<span class="comp-cell">${C.compBadge(p.league, { label: true })}${
        inUcl.has(`${p.league}|${p.team}`) ? C.compBadge('ucl') : ''}</span>` },
    { key: 'name', label: '球員', num: false, left: true, value: p => p.name,
      render: p => {
        const ph = photoBy.get(`${p.league}|${p.code}`);
        /* 一定要掛 pphoto + data-team:西甲的頭貼是遠端網址,載不到時 core.js 的
           監聽器只認這個 class —— 沒掛的話破圖框就留在畫面上(實測 2026-09-11 掃到)。 */
        return `<span class="team-cell">${ph ? `<img class="pphoto chip" data-team="${C.esc(p.team)}" src="${ph}" alt="" width="24" height="24"
            style="border-radius:50%;object-fit:cover;width:24px;height:24px" loading="lazy">` : ''}
          <span>${C.esc(p.name)}${p.fullName && p.fullName !== p.name
            ? ` <span class="dim tiny">${C.esc(p.fullName)}</span>` : ''}</span></span>`;
      } },
    { key: 'team', label: '隊', num: false, value: p => p.team ?? '',
      render: p => {
        const cr = crestOf(p.league, p.team);
        return `<span class="team-cell">${cr ? `<img class="crest" src="${cr}" alt="" width="20" height="20" loading="lazy">` : ''}
          <span>${C.esc(p.team ?? '—')}</span></span>`;
      } },
    { key: 'pos', label: '位置', num: false, value: p => p.posZh ?? p.pos ?? '',
      render: p => C.esc(p.posZh ?? p.pos ?? '—') },
    ...(hit.some(p => p.age != null) ? [{ key: 'age', label: '年齡', num: true,
      value: p => p.age, render: p => p.age ?? '—' }] : []),
    ...(hit.some(p => p.price != null) ? [{ key: 'price', label: '身價', num: true,
      value: p => p.price, render: p => p.price != null ? `£${p.price}m` : '—' }] : []),
    ...STAT_COLS.filter(([k]) => has(k)).map(([k, label]) => ({
      key: k, label, num: true,
      value: p => statFor(p)?.[k],
      render: p => {
        const v = statFor(p)?.[k];
        return v == null ? '—' : (k === 'xG' || k === 'xA' ? C.fx(v, 2) : v);
      },
    })),
  ];
  /* 未搜尋的預設視圖不能用全池分鐘排序 —— 聯賽輪次不同步時
     (實測西甲多踢一輪、球員 270 分 vs 英超 180),前幾十名會被單一聯賽
     整個填滿,看起來像「只有西甲」。改成各聯賽取前 40、按組內名次交錯,
     首屏每個勾選的聯賽都在;搜尋結果照舊全量。 */
  const shown = ql ? hit : pools.flatMap(x => [...x.rows]
    .sort((a, b) => (statFor(b)?.minutes ?? -1) - (statFor(a)?.minutes ?? -1))
    .slice(0, 40).map((p, i) => ({ p, rank: i })))
    .sort((a, b) => a.rank - b.rank).map(r => r.p);
  const names = pools.map(x => C.LEAGUES[x.lg]?.zh ?? x.lg).join('・');
  host.innerHTML = `
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin:4px 0 8px">
      <span class="small"><b>${C.esc(names)}</b> 合併一張表・${hit.length} 人${ql ? '符合' : '・未搜尋時各聯賽列上場時間前 40 名(交錯排列)'}</span>
      ${seasons.length ? `<label class="small dim">賽季 <select id="xSeason">${seasons.map(s =>
        `<option value="${s}"${s === season ? ' selected' : ''}>${s}</option>`).join('')}</select></label>` : ''}
    </div>
    ${hit.length ? C.table(shown, cols, {
      /* 預設不帶排序鍵 —— 帶了會把交錯順序再排回去,單一聯賽又霸榜;點表頭仍可排 */
      sortKey: null, desc: true, pageSize: 100,
      onRow: p => C.go('players', { code: p.code, league: p.league }),
    }) : '<div class="note">勾選的聯賽裡沒有符合的球員。</div>'}
    <div class="tiny dim" style="margin-top:8px">點任何一列進該聯賽的球員詳情。
      勾了本聯賽以外的聯賽時,表格只放各聯賽共通的欄位;球隊、位置、分鐘篩選與對比模式只在「只勾本聯賽」時出現。
      分鐘、進球、助攻是同一種事實,可跨聯賽排序;<b>xG/xA 各聯賽的模型不同</b>
      (FPL vs Understat),數字並列但不可直接互比 —— 每列的聯賽籤就是提醒。同名不代表同一人。
      ${photosReady ? '' : '頭貼載入中…'}</div>
    ${missing.map(lg => `<div class="note" style="margin-top:10px"><b>${C.esc(C.LEAGUES[lg]?.zh ?? lg)}</b>:${
      C.esc(C.LEAGUES[lg]?.gapNote ?? '這個聯賽還沒有球員資料。')}</div>`).join('')}`;
  const sel = host.querySelector('#xSeason');
  if (sel) sel.onchange = e => { season = e.target.value; draw(host, loaded, inUcl, q, photosReady); };
}
