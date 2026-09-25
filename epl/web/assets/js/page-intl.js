import * as C from './core.js?v=6d9662ee';

const app = document.getElementById('app');

/* 國家隊(2026-09-24)。跨聯賽的一頁:資料在英超目錄那一份(`data/intl.json`,由 scripts/build-intl.mjs 產生)。

   四件事跟聯賽頁不一樣,每一件都會影響怎麼寫:

   1. **兩個來源,分工不重疊。** 畫面上的場次來自 FotMob(八個賽事);勝率與排名用的評分只從
      martj42/international_results 算(一份只收踢完的比賽的獨立資料集)。每一場已完賽都拿兩邊逐場對,
      判決照印在那一列 —— 「待核對」「查無對照」「不一致」是三件不同的事,不混成一個問號。
   2. **勝率只給驗收過的模型,而且每次建置重算。** 門檻、樣本數、基準線都從產物讀,這一頁不寫任何數字。
   3. **評分會落後。** martj42 還沒收的比賽不進評分(沒被核對過的比分不拿來改評分)——
      每一場把「評分之後兩隊又踢了幾場」印出來,不確定性寫在畫面上(鐵則四)。
   4. **不知道是不是中立場。** FotMob 賽程沒有這個欄位,一律當名單上的主隊在主場;
      代價是調參時在驗收那一批上量過的,模型那一節照產物印。

   顯示範圍一律用「天」當單位(接下來 7 天、最近 7 天),不用筆數 —— 固定筆數會把同一天的比賽切一半
   (實時戰況頁那條坑)。

   2026-09-25 加了兩樣(使用者:「完善國家隊」):
   - **分組積分榜**。積分是本站用已完賽的賽果算的,上游的表只拿來取名單、官方名次與核對 ——
     上游會把進行中的比賽算進去(實測),照印的話積分榜會跟這一頁「還沒完賽」的賽程打架。
     整組都跟上游一致才照上游的名次排(同分的官方規則借上游的),否則照積分、淨勝球、進球排,並講出來。
   - **球隊頁**(`intl.html?team=Japan`):評分走勢、最近幾場每一場的評分變化、接下來的比賽,
     以及跟那幾個對手的歷來交手。明細另外一份(`intl-teams.json`),點進某一隊才載。 */

const DAY = 86400000;
const STEP_DAYS = 7;
const S = { fam: 'all', ahead: STEP_DAYS, back: STEP_DAYS, rankAll: false, stand: null };
const TEAM = C.qs('team');
let D = null;
let COMPS = new Map();
let FLAGS = {};   // 隊 → 國旗(data URI);intl-flags.json,沒有就是空的(隊名照樣印)

const esc = C.esc;
const localDay = iso => new Date(iso).toLocaleDateString('en-CA');   // YYYY-MM-DD(觀看者時區)
const dayLabel = iso => new Date(iso).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' });
const timeOf = iso => new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
const famOf = key => COMPS.get(key)?.family ?? null;
const inFam = x => S.fam === 'all' || famOf(x.comp) === S.fam;
const zhOf = key => D.teams[key]?.zh ?? key;

/* 一支隊的名字。三種形狀:
     還沒決定的參與者(海灣盃四強的 1A、Winner SF 1)—— 照產物給的說法,不當成球隊
     身分對不上的名字 —— 照印上游的名字、加一個記號,滑過去說明為什麼沒有評分
     一般 —— 中文名(CLDR;查不到就是英文),滑過去看英文名與本站 Elo */
function teamHtml(t, { flagAfter = false } = {}) {
  if (!t) return '<span class="dim small">待定</span>';
  if (t.tbd) return `<span class="intl-team dim small" title="上一階段還沒踢完,這一格的參與者還沒決定(上游寫作 ${esc(t.name)})"><span>${esc(t.label)}</span></span>`;
  if (!t.key) return `<span class="intl-team small" title="本站還對不上「${esc(t.name)}」的身分,所以沒有它的評分"><span>${esc(t.name)}<span class="dim">*</span></span></span>`;
  const info = D.teams[t.key];
  const zh = info?.zh ?? t.key;
  const tip = [zh !== t.key ? t.key : null,
    info?.rating != null ? `本站 Elo ${info.rating}${info.rank ? `(排名第 ${info.rank})` : ''}` : null].filter(Boolean).join('・');
  // 國旗放在靠比分的那一側:主隊在名字後面、客隊在名字前面
  return `<span class="intl-team small" title="${esc(tip)}">${flagAfter ? '' : flagImg(t.key)}${teamLink(t.key, esc(zh))}${flagAfter ? flagImg(t.key) : ''}</span>`;
}
/* 國旗。**只用產物裡內嵌的圖**(不從外部網址載 —— 單檔版與離線都要看得到);沒有國旗的隊不留空格。
   旁邊就是隊名,所以 alt 是空字串(讀螢幕的人不需要聽兩次)。 */
const flagImg = (key, big = false) => (key && FLAGS[key]
  ? `<img class="intl-flag${big ? ' big' : ''}" src="${FLAGS[key]}" alt="" width="${big ? 40 : 20}" height="${big ? 30 : 15}">` : '');
/* 球隊頁的連結。字典裡沒有的隊(不該發生,但產物是外部來的)就只印字,不給一個點下去是空白的連結 */
const teamLink = (key, label) => (key && D.teams[key]
  ? `<a class="intl-link" href="${esc(C.link('intl', { team: key }))}">${label}</a>` : `<span>${label}</span>`);

const compTag = key => {
  const c = COMPS.get(key);
  return c ? `<span class="pill tiny" title="${esc(c.zh)}">${esc(c.short)}</span>` : '';
};
// 輪次與組別各自不准斷行 —— 手機上「第 1 / 輪 第 1 組」這種斷法讀起來像兩件事
const tagsOf = x => [compTag(x.comp), ...[x.roundZh, x.groupZh].filter(Boolean).map(t => `<span class="nowrap">${esc(t)}</span>`)].filter(Boolean).join(' ');

function probCell(f) {
  const lags = (f.lag ?? []).map(n => n ?? 0);
  const lag = Math.max(0, ...lags);
  const tip = `本站 Elo ${f.elo[0]} 對 ${f.elo[1]}・當成名單上的主隊在主場算(上游沒有中立場資訊)`;
  const bar = `<span title="${esc(tip)}">${C.probBar({ home: f.prob[0], draw: f.prob[1], away: f.prob[2] })}</span>`;
  if (!lag) return bar;
  const who = [f.home, f.away].map((t, i) => (lags[i] ? `${zhOf(t.key)} ${lags[i]} 場` : null)).filter(Boolean).join('、');
  const lg = D.model.lag?.affected;
  const cost = lg ? `量過這件事值多少:評分落後 ${D.model.lag.days} 天,受影響的場次每場 RPS 平均多 ${lg.cost} ± ${lg.se}(模型整體的改善是 ${D.model.holdout?.gain})。` : '';
  return `${bar}<div class="tiny dim" style="margin-top:3px" title="評分只算到 ${esc(D.model.ratingsAsOf)}(獨立來源收錄到的最後一天);之後踢的比賽還沒被核對,不拿來改評分。這兩隊之後又踢了:${esc(who)}。${esc(cost)}">評分未含最近 ${lag} 場</div>`;
}

function fixtureRow(f) {
  let mid;
  if (f.state === 'CANCELLED') {
    mid = f.reason === 'Ab'
      ? `<span class="pill tiny warn" title="${esc(f.reasonLong ?? '')}">中止${f.stoppedAt ? `(中止時 ${f.stoppedAt[0]}-${f.stoppedAt[1]})` : ''}</span>`
      : `<span class="pill tiny warn" title="${esc(f.reasonLong ?? '')}">取消</span>`;
  } else if (f.prob) {
    mid = probCell(f);
  } else {
    mid = `<span class="tiny dim" title="${esc(f.why ?? '')}">${f.home.tbd || f.away.tbd ? '對戰未定' : '不給勝率'}</span>`;
  }
  return `<div class="stat-line tie-leg intl-row">
    <span class="leg-when tiny dim mono">${timeOf(f.kickoff)}</span>
    <span class="leg-home">${teamHtml(f.home, { flagAfter: true })}</span>
    <span class="leg-score">${mid}</span>
    <span class="leg-away">${teamHtml(f.away)}</span>
    <span class="leg-ko tiny dim">${tagsOf(f)}</span>
  </div>`;
}

/* 已完賽的核對判決。**「待核對」「查無對照」「不一致」是三件事**:
   第一個是獨立來源還沒收到那一天,第二個是它沒收這一場,第三個才是兩邊真的記得不一樣。 */
function checkBadge(r) {
  const asOf = esc(D.model.ratingsAsOf);
  const other = r.other ? `${r.other[0]}-${r.other[1]}` : '';
  switch (r.check) {
    case 'agree': return '<span class="pill tiny accent" title="兩個獨立來源(FotMob、martj42)的比分一致">✓ 已核對</span>';
    case 'mismatch': return `<span class="pill tiny bad" title="兩個來源記的比分不一樣,本站不挑一個當答案。評分用的是 martj42 那一份">⚠ martj42 記 ${other}</span>`;
    case 'awarded': return `<span class="pill tiny warn" title="FotMob 記的是判決比分,martj42 記的是場上比分 —— 記法不同,不算不一致">判決・場上 ${other}</span>`;
    case 'notYet': return `<span class="pill tiny" title="martj42 目前收錄到 ${asOf},這一場它還沒收 —— 無法核對,不等於不一致">待核對</span>`;
    case 'unmatched': return '<span class="pill tiny" title="兩隊都認得,但 martj42 前後一天內沒有這兩隊的對戰:它沒收這一場(例如非洲盃資格賽三月那一輪預賽整輪都沒有)">獨立來源沒收</span>';
    default: return '<span class="pill tiny" title="有一隊的名字本站還對不上身分,核對不了">隊名未對上</span>';
  }
}

function resultRow(r) {
  const [h, a] = r.final;
  const pensSide = r.pensWinner ? (r.pensWinner === r.home.key ? 'home' : r.pensWinner === r.away.key ? 'away' : null) : null;
  const win = r.reason === 'Pen' ? pensSide : h > a ? 'home' : h < a ? 'away' : null;
  const strong = side => (win === side ? 'font-weight:700' : win ? 'opacity:.62' : '');
  const bits = [`<b class="mono" style="font-size:14px">${h} - ${a}</b>`];
  if (r.reason === 'AET') bits.push('<span class="pill tiny" title="延長賽後的比分">延長</span>');
  if (r.reason === 'Pen') {
    /* PK 勝方:FotMob 的賽程端點只說「PK 後結束」;martj42 的 shootouts.csv 有勝方,
       只在兩邊對上的場次查得到。查不到就寫待查,不拿平手比分猜。 */
    bits.push(pensSide
      ? `<span class="pill accent tiny" title="PK 勝方來自 martj42 的 shootouts.csv(FotMob 的賽程沒有 PK 比數)">PK・${esc(zhOf(r.pensWinner))} 勝</span>`
      : '<span class="pill tiny warn" title="上游只說 PK 後結束,勝方要等獨立來源收錄這一場">PK 勝方待查</span>');
  }
  return `<div class="stat-line tie-leg intl-row">
    <span class="leg-when tiny dim mono">${timeOf(r.kickoff)}</span>
    <span class="leg-home" style="${strong('home')}">${teamHtml(r.home, { flagAfter: true })}</span>
    <span class="leg-score"><span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center">${bits.join('')}</span></span>
    <span class="leg-away" style="${strong('away')}">${teamHtml(r.away)}</span>
    <span class="leg-ko tiny">${checkBadge(r)} ${compTag(r.comp)}</span>
  </div>`;
}

function dayBlocks(items, rowFn, { desc = false } = {}) {
  const days = new Map();
  for (const x of items) {
    const k = localDay(x.kickoff);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(x);
  }
  const keys = [...days.keys()].sort();
  if (desc) keys.reverse();
  return keys.map(k => {
    const xs = days.get(k);
    return `<div class="card" style="margin-top:10px">
      <div class="spread"><h3 style="margin:0;font-size:15px">${dayLabel(xs[0].kickoff)}</h3>
        <span class="tiny dim">${xs.length} 場</span></div>
      <div style="display:grid;gap:2px;margin-top:8px">${xs.map(rowFn).join('')}</div>
    </div>`;
  }).join('');
}

/* 開球時間已過、卻還沒有賽果的場次。**分不出是比分還沒進來還是延期,就兩種都講**
   (「等待賽果」把延賽講成資料落後那條坑),並把「本站的賽程是多久前抓的」給讀者自己判斷。 */
function pendingBlock(now) {
  const xs = D.fixtures.filter(f => f.state !== 'CANCELLED' && Date.parse(f.kickoff) <= now && inFam(f));
  if (!xs.length) return '';
  const rows = xs.map(f => {
    const min = Math.floor((now - Date.parse(f.kickoff)) / 60000);
    const c = COMPS.get(f.comp);
    /* 分鐘是**拿開球時間推的**,不是即時資料 —— 所以不畫即時的紅點(那個點在別頁代表「資料在動」) */
    const status = min < C.MATCH_WINDOW_MIN
      ? `<span class="pill tiny warn" title="依開球時間推算;國家隊沒有即時比分,本站的賽程是 ${esc(C.ageText(c?.retrievedAt))}抓的">開球後 ${min} 分鐘</span>`
      : `<span class="pill tiny warn" title="時間上早該結束,但本站還沒有這一場的賽果:可能是比分還沒進來(賽程是 ${esc(C.ageText(c?.retrievedAt))}抓的),也可能延期了 —— 本站分不出是哪一種">已過 ${Math.round(min / 60)} 小時・還沒有賽果</span>`;
    return `<div class="stat-line tie-leg intl-row">
      <span class="leg-when tiny dim mono">${timeOf(f.kickoff)}</span>
      <span class="leg-home">${teamHtml(f.home, { flagAfter: true })}</span>
      <span class="leg-score">${status}</span>
      <span class="leg-away">${teamHtml(f.away)}</span>
      <span class="leg-ko tiny dim">${tagsOf(f)}</span>
    </div>`;
  }).join('');
  return `<div class="section"><h2>已開賽・等待賽果</h2>
      <span class="hint">國家隊沒有即時比分:賽程與賽果跟著每天兩次的部署更新</span></div>
    <div class="card"><div style="display:grid;gap:2px">${rows}</div></div>`;
}

function upcomingBlock(now) {
  const future = D.fixtures.filter(f => Date.parse(f.kickoff) > now && inFam(f));
  const until = now + S.ahead * DAY;
  const shown = future.filter(f => Date.parse(f.kickoff) <= until);
  const rest = future.length - shown.length;
  const next = future.find(f => Date.parse(f.kickoff) > until);
  const more = rest
    ? `<div class="row" style="margin-top:10px"><button class="btn" id="moreAhead">再往後 ${STEP_DAYS} 天</button>
        <span class="tiny dim">之後還有 ${rest} 場${next ? `(下一場 ${dayLabel(next.kickoff)})` : ''}</span></div>`
    : '';
  const live = shown.filter(f => f.state !== 'CANCELLED');
  const cancelled = shown.length - live.length;
  return `<div class="section"><h2>接下來 ${S.ahead} 天</h2>
      <span class="hint">${live.length} 場${cancelled ? `(另有取消 ${cancelled} 場)` : ''}・給勝率 ${live.filter(f => f.prob).length} 場・
        勝率條:綠 = 名單上的主隊勝、灰 = 和局、紅 = 客隊勝・時間是你所在時區(${esc(C.tzName())})</span></div>
    ${shown.length ? dayBlocks(shown, fixtureRow) : `<div class="note">接下來 ${S.ahead} 天沒有比賽${next ? `,下一場在 ${dayLabel(next.kickoff)}` : ''}。</div>`}
    ${more}`;
}

function resultsBlock(now) {
  const past = D.results.filter(inFam);
  const from = now - S.back * DAY;
  const shown = past.filter(r => Date.parse(r.kickoff) >= from);
  const rest = past.length - shown.length;
  const more = rest
    ? `<div class="row" style="margin-top:10px"><button class="btn" id="moreBack">再往前 ${STEP_DAYS} 天</button>
        <span class="tiny dim">更早還有 ${rest} 場(本季)</span></div>`
    : '';
  const cc = {};
  for (const r of shown) cc[r.check] = (cc[r.check] ?? 0) + 1;
  const summary = [cc.agree ? `兩邊一致 ${cc.agree}` : null, cc.notYet ? `待核對 ${cc.notYet}` : null,
    cc.unmatched ? `獨立來源沒收 ${cc.unmatched}` : null, cc.mismatch ? `不一致 ${cc.mismatch}` : null,
    cc.awarded ? `判決 ${cc.awarded}` : null, cc.noKey ? `隊名未對上 ${cc.noKey}` : null].filter(Boolean).join('・');
  return `<div class="section"><h2>最近 ${S.back} 天賽果</h2>
      <span class="hint">${shown.length} 場${summary ? `・${summary}` : ''}</span></div>
    ${shown.length ? dayBlocks(shown, resultRow, { desc: true }) : `<div class="note">最近 ${S.back} 天沒有賽果。</div>`}
    ${more}`;
}

/* ── 分組積分榜 ─────────────────────────────────────────────────── */
// 晉級區塊的顏色(產物給的是語氣,不是上游的色碼 —— 站上的配色要自己一致)
const TONE = { good: 'var(--win)', maybe: 'var(--accent-3)', warn: 'var(--draw)', bad: 'var(--loss)' };
const nameOf = r => (r.key ? (D.teams[r.key]?.zh ?? r.key) : r.name);

/* 上游跟本站不是同一批的那幾列,一句話講清楚差在哪 */
function groupNote(g) {
  if (g.status === 'ok') return g.counted ? '' : '<div class="tiny dim" style="margin-top:6px">還沒開踢:名次是上游列的順序(抽籤的順序)</div>';
  const diffs = g.rows.filter(r => r.check !== 'agree')
    .map(r => `${esc(nameOf(r))} 本站 ${r.p} 場 ${r.pts} 分、上游 ${r.up.p} 場 ${r.up.pts} 分`).join(';');
  if (g.status === 'mismatch') {
    return `<div class="note" style="margin-top:8px">⚠ 場數一樣,積分或進失球卻跟上游對不上:${diffs}。本站印的是自己用賽果算的。</div>`;
  }
  const why = g.live.length ? `上游的積分榜已經算進正在踢的 ${g.live.length} 場,本站只算踢完的` : '上游的積分榜跟本站的賽果不是同一批(其中一邊還沒更新)';
  return `<div class="tiny dim" style="margin-top:6px">${why}:${diffs}。
    這一組照積分、淨勝球、進球排,同分時官方的排序規則(例如相互對戰)沒有套用。</div>`;
}

function groupCard(g, { me = null, title = null } = {}) {
  const zoneAt = i => g.legend.find(l => l.idx.includes(i)) ?? null;
  const rows = g.rows.map((r, i) => {
    const z = zoneAt(i);
    const mark = r.check === 'pending' ? `<span class="dim" title="上游算的是 ${r.up.p} 場 ${r.up.pts} 分${r.live ? '(含正在踢的那一場)' : ''}">*</span>` : '';
    return `<tr${r.key && r.key === me ? ' class="me"' : ''}>
      <td class="num intl-zone" style="--zone:${z?.tone ? TONE[z.tone] : 'transparent'}"${z ? ` title="${esc(z.zh ?? z.en)}"` : ''}>${r.pos}</td>
      <td class="left">${r.key ? `<span class="intl-team">${flagImg(r.key)}${teamLink(r.key, esc(nameOf(r)))}</span>` : `${esc(r.name)}<span class="dim" title="本站對不上這一隊的身分">*</span>`}${mark}</td>
      <td class="num">${r.p}</td><td class="num">${r.w}</td><td class="num">${r.d}</td><td class="num">${r.l}</td>
      <td class="num mono">${r.gf}:${r.ga}</td><td class="num">${r.gd > 0 ? '+' : ''}${r.gd}</td><td class="num"><b>${r.pts}</b></td></tr>`;
  }).join('');
  return `<div class="card intl-group">
    <div class="spread"><h3 style="margin:0;font-size:15px">${esc(title ?? g.zh ?? g.name)}</h3>
      <span class="tiny dim">已完賽 ${g.counted} 場</span></div>
    <div class="table-wrap" style="margin-top:8px"><table>
      <thead><tr><th class="num">名次</th><th class="left">國家隊</th><th class="num" title="賽">賽</th><th class="num">勝</th><th class="num">和</th><th class="num">負</th>
        <th class="num">進:失</th><th class="num">淨</th><th class="num">分</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${groupNote(g)}
  </div>`;
}

/* 預設看哪一個賽事**由資料決定**:離現在最近的一場(不論踢完沒有)屬於誰;平手取清單上的第一個。
   寫死成「第一個」的話,歐國聯 A 級踢完、非洲那邊正在踢的那幾天,預設畫面是一張沒有動靜的表
   (盃賽頁 defaultCup 那條坑)。 */
function nearestComp(list, now) {
  let best = null, bestGap = Infinity;
  for (const st of list) {
    for (const x of [...D.fixtures, ...D.results]) {
      if (x.comp !== st.comp || x.state === 'CANCELLED') continue;
      const gap = Math.abs(Date.parse(x.kickoff) - now);
      if (gap < bestGap) { bestGap = gap; best = st.comp; }
    }
  }
  return best ?? list[0].comp;
}

function standingsBlock(now) {
  const list = (D.standings ?? []).filter(inFam);
  if (!list.length) return '';
  if (!list.some(x => x.comp === S.stand)) S.stand = nearestComp(list, now);
  const cur = list.find(x => x.comp === S.stand);
  const c = COMPS.get(cur.comp);
  const tabs = list.length > 1
    ? `<div class="filters">${list.map(x => `<button class="btn${x.comp === cur.comp ? ' on' : ''}" data-stand="${esc(x.comp)}">${esc(COMPS.get(x.comp)?.short ?? x.comp)}</button>`).join('')}</div>` : '';
  const legend = new Map();
  for (const g of cur.groups) for (const l of g.legend) if (!legend.has(l.key)) legend.set(l.key, l);
  const n = k => cur.groups.filter(g => g.status === k).length;
  const summary = [n('ok') ? `${n('ok')} 組逐隊跟上游一致` : null,
    n('pending') ? `${n('pending')} 組跟上游不是同一批(見那一組的說明)` : null,
    n('mismatch') ? `<b>${n('mismatch')} 組場數一樣卻對不上</b>` : null].filter(Boolean).join('・');
  return `<div class="section"><h2>分組積分榜</h2>
      <span class="hint">${esc(c?.zh ?? cur.comp)}・積分由本站用已完賽的賽果算,再逐隊跟上游的表核對</span></div>
    ${tabs}
    <div class="intl-groups">${cur.groups.map(g => groupCard(g)).join('')}</div>
    <div class="row" style="margin-top:10px;gap:6px 14px">
      ${[...legend.values()].map(l => `<span class="tiny intl-legend"><span class="sw" style="--zone:${l.tone ? TONE[l.tone] : 'var(--ink-3)'}"></span>${esc(l.zh ?? l.en)}</span>`).join('')}
    </div>
    <div class="tiny dim" style="margin-top:6px">${summary}。晉級規則是上游(FotMob)的圖例,本站照譯;
      上游會把正在踢的比賽算進積分榜,本站只算踢完的 —— 所以比賽進行中那幾組會跟上游差一場。</div>`;
}

function rankingBlock() {
  const rows = S.rankAll ? D.ranking : D.ranking.slice(0, 20);
  return `<div class="section"><h2>本站 Elo 排名</h2>
      <span class="hint">不是 FIFA 排名・評分算到 ${esc(D.model.ratingsAsOf)}・${D.ranking.length} 隊</span></div>
    <div class="note" style="margin-bottom:10px">只列<b>國際足總會員</b>(用「踢過世界盃或它的資格賽」認)、
      <b>兩年內踢過比賽、而且累積 ${D.model.minGames} 場以上</b>的隊 ——
      評分從 1872 年的第一場算起,解散或很久沒踢的隊評分凍在當年,列進來會變成歷史榜。${nonMemberNote()}
      分數本身沒有單位,兩隊差 100 分代表中立場上強的那一邊的預期得分是 ${
        Math.round(100 / (1 + 10 ** (-100 / 400)))}%(贏算 1、和算 0.5)。</div>
    <div class="table-wrap"><table>
      <thead><tr><th class="num">名次</th><th class="left">國家隊</th><th class="num">Elo</th><th class="num">場數</th><th class="num">最近一場</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="num">${r.rank}</td>
        <td class="left" title="${esc(r.key)}"><span class="intl-team">${flagImg(r.key)}${teamLink(r.key, esc(zhOf(r.key)))}</span></td>
        <td class="num">${r.rating}</td><td class="num">${r.games}</td><td class="num">${esc(C.dateFull(r.last))}</td></tr>`).join('')}</tbody>
    </table></div>
    ${D.ranking.length > 20 ? `<div class="row" style="margin-top:10px"><button class="btn" id="rankToggle">${S.rankAll ? '只看前 20' : `看全部 ${D.ranking.length} 隊`}</button></div>` : ''}`;
}

/* 不列排名的非會員,分兩種講(兩種的意思不一樣):評分跟會員接得上的,與只在自己圈子裡互踢的 */
function nonMemberNote() {
  const nm = D.nonMembers ?? [];
  if (!nm.length) return '';
  const names = xs => xs.map(x => esc(zhOf(x.key))).join('、');
  const linked = nm.filter(x => x.linked), alone = nm.filter(x => !x.linked);
  const tours = [...new Set(alone.flatMap(x => x.tours ?? []))].slice(0, 3);
  return `<br>另有 ${nm.length} 隊有評分但不是會員,不列:${linked.length ? `${linked.length} 隊主要跟會員交手(${names(linked)}),
    評分可以比,它們的比賽照常給勝率` : ''}${linked.length && alone.length ? ';' : ''}${alone.length ? `${alone.length} 隊兩年內只跟非會員踢
    (${names(alone)}${tours.length ? `;賽事像是 ${tours.map(esc).join('、')}` : ''}),評分是在那個小圈子裡累積的,跟會員比不起來` : ''}。`;
}

function modelBlock() {
  const m = D.model;
  const h = m.holdout;
  const nu = m.neutralUnknown;
  const f4 = x => Number(x).toFixed(4);   // 0.0030 印成 0.003 會讓兩個數字看起來精度不同
  const g = x => (x ? `${f4(x.gain)} ± ${f4(x.se)}(${x.n} 場)` : '—');
  return `<div class="section"><h2>勝率怎麼來的</h2><span class="hint">每次建置用當下的資料重算驗收</span></div>
    <div class="grid g2">
      <div class="card">
        <p class="small" style="margin-top:0">${esc(m.method)}。主場分、K 的整體倍率與和局曲線是在
          <b>${esc(m.tune?.from)} ~ ${esc(m.tune?.to)}</b> 的 ${m.tune?.n ?? '—'} 場上挑的(試了 ${m.tune?.tried ?? '—'} 組),
          驗收在<b>另一段年份</b>(${esc(h?.from)} 之後)上做,參數固定、同一天的比賽互相看不到結果。</p>
        ${h ? `<div class="grid g3" style="margin:12px 0">
          <div><div class="tiny dim">驗收場數</div><b class="mono">${h.n}</b></div>
          <div><div class="tiny dim">RPS(越低越好)</div><b class="mono">${f4(h.model)}</b> <span class="tiny dim">基準線 ${f4(h.baseline)}</span></div>
          <div><div class="tiny dim">改善</div><b class="mono">${f4(h.gain)} ± ${f4(h.se)}</b> <span class="tiny dim">${h.z} 倍標準誤</span></div>
        </div>
        <p class="small">非友誼賽 ${g(h.competitive)}、友誼賽 ${g(h.friendly)}。基準線是<b>驗收那一批自己的</b>主勝/和局/客勝比例
          (中立場與否分開算)—— 它偷看了答案,對基準線有利。上線門檻:${esc(m.gate)}。這一次:${m.passed
            ? '<b class="accent-text">通過</b>,所以給勝率。'
            : '<b>沒通過</b>,所以這一頁<b>一場都不給</b>勝率。'}</p>` : '<p class="small">這一次沒有驗收結果,所以不給勝率。</p>'}
        <p class="small">${nu ? `<b>不知道是不是中立場。</b>上游的賽程沒有這個欄位,所以一律當名單上的主隊在主場算。
          在驗收那一批上量過代價:中立場佔 ${C.pct(nu.shareOfHoldout)},把它們當主場算,每場 RPS 多 ${nu.rpsCostPerNeutralMatch}、
          攤到整批 ${nu.rpsCostOverall}。盃賽決賽圈(例如海灣盃)大多是中立場,那幾場的主隊被多算了主場優勢。` : ''}</p>
        ${m.lag?.affected ? `<p class="small"><b>評分會落後,量過值多少。</b>martj42 收錄新賽果會晚幾天到幾週,那段時間踢的比賽不進評分。
          拿驗收那一批模擬「評分晚 ${m.lag.days} 天」:兩隊至少一隊在那幾天裡踢過的 ${m.lag.affected.n} 場,每場 RPS 平均多
          ${m.lag.affected.cost} ± ${m.lag.affected.se}(${m.lag.affected.z} 倍標準誤;模型整體的改善是 ${h?.gain ?? '—'})。
          ${m.lag.passes ? '這個代價大過兩倍標準誤。' : '沒有大過兩倍標準誤 —— 所以本站<b>不</b>拿還沒被核對的賽果提早更新評分:換來的好處量不出來,卻要冒用錯比分的風險。'}</p>` : ''}
        <p class="small">沒有放進模型的:先發名單、傷停、總教練、旅途與時差 —— 本站沒有這些資料,
          勝率只看兩隊的歷史戰績。友誼賽常常大量輪換,那是模型看不到的。</p>
      </div>
      <div class="card">
        <h3 style="margin:0 0 6px;font-size:15px">校準:說 60% 的,實際是不是 60%</h3>
        <div class="tiny dim" style="margin-bottom:6px">驗收那一批的每一場貢獻三個點(主勝、和局、客勝),點越大代表那一格的預測越多</div>
        ${C.calibrationChart(m.calibration, { w: 520, h: 520 })}
      </div>
    </div>`;
}

function boundaryBlock() {
  const mj = D.sources.find(s => s.key === 'martj42');
  const compRows = D.comps.map(c => {
    const st = c.status === 'ok' ? '<span class="pill tiny accent">收</span>'
      : c.status === 'excluded' ? `<span class="pill tiny bad" title="${esc(c.why)}">不收</span>` : `<span class="pill tiny" title="${esc(c.why)}">還沒抓</span>`;
    const proof = c.proof ? `對上 ${c.proof.matched} 場${c.proof.proofSeason ? `(含上一季 ${esc(c.proof.proofSeason.season)})` : ''}・${
      esc(c.proof.tournaments.slice(0, 2).map(t => `${t.t}×${t.n}`).join('、'))}` : '—';
    return `<tr><td class="left">${st} ${esc(c.zh)}</td><td class="num">${c.id}</td><td class="left">${esc(c.season ?? '—')}</td>
      <td class="num">${c.counts?.total ?? '—'}</td><td class="left tiny">${proof}</td>
      <td class="left tiny">${c.retrievedAt ? esc(C.ageText(c.retrievedAt)) : '—'}</td></tr>`;
  }).join('');
  const unknown = D.unknownNames ?? [];
  const nf = D.notFetched;
  return `<div class="section"><h2>資料界線</h2><span class="hint">每個數字的出處,以及這一頁做不到什麼</span></div>
    <div class="grid g2">
      <div class="card">
        <h3 style="margin:0 0 8px;font-size:15px">兩個來源</h3>
        <p class="small" style="margin-top:0"><b>歷史賽果:<a href="${esc(mj?.url)}" target="_blank" rel="noopener">${esc(mj?.name)}</a></b>
          —— 1872 年至今的男子 A 級國際賽,${mj?.rows?.toLocaleString() ?? '—'} 場,<b>只收踢完的比賽</b>,目前收錄到 ${esc(mj?.lastDate)}。
          評分與勝率只從它算。</p>
        <p class="small"><b>賽程與這一窗的賽果:FotMob</b> —— 一個賽事一個請求。每個賽事的 id 都用<b>內容</b>證明過:
          已完賽的場次逐場對 martj42,對上的比賽在那邊確實叫這個賽事(名字靠不住:CONCACAF 也有 Nations League)。</p>
        <p class="small">國名的中文走 Unicode CLDR(標準資料,不是翻譯);足球上慣用名不同的由本站覆寫(英格蘭四隊、中華台北)。</p>
        ${flagNote()}
        ${unknown.length ? `<p class="small">本站還對不上身分的隊名(那幾場不給勝率):${unknown.map(u => `${esc(u.name)}×${u.n}`).join('、')}。</p>` : ''}
      </div>
      <div class="card">
        <h3 style="margin:0 0 8px;font-size:15px">這一頁做不到的</h3>
        <ul class="small" style="margin:0;padding-left:18px;display:grid;gap:6px">
          <li><b>沒有即時比分。</b>賽程與賽果跟著每天兩次的部署更新,比賽中不會動。</li>
          ${nf ? `<li><b>只收有比賽的 ${D.comps.length} 個賽事。</b>其餘 ${nf.comps.length} 個國家隊賽事在 ${esc(nf.checkedAt)}
            探測時,接下來 ${nf.horizonDays} 天一場都沒有,開打時再加進來(不留一個永遠空白的分頁)。
            其中 ${nf.comps.filter(c => c.proof).length} 個的 id 已經用內容證明過;${
              nf.comps.filter(c => !c.proof).map(c => esc(c.zh)).join('、') || '—'} 的本季是下一屆、一場都還沒踢,id 還沒證明。
            <details style="margin-top:4px"><summary class="tiny dim">名單</summary>
              <div class="tiny dim" style="margin-top:4px">${nf.comps.map(c => `${esc(c.zh)}(${c.id}${c.proof ? `,對上 ${esc(c.proof)}` : ',未證明'})`).join('、')}</div>
            </details></li>` : ''}
          <li><b>評分會落後。</b>獨立來源還沒收的比賽不拿來改評分,所以每一場的勝率旁邊會講兩隊之後又踢了幾場。</li>
          <li><b>沒有陣容、傷停與賽後報告。</b>國家隊的逐場詳情還沒接。</li>
        </ul>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:12px"><table>
      <thead><tr><th class="left">賽事</th><th class="num">FotMob id</th><th class="left">季</th><th class="num">場次</th><th class="left">id 的證明</th><th class="left">抓取</th></tr></thead>
      <tbody>${compRows}</tbody></table></div>`;
}

/* 國旗從哪來、哪些隊沒有、為什麼(三種原因分開講:沒有國碼、刻意不給、屬地用的是宗主國的旗) */
function flagNote() {
  const f = D.flags;
  if (!f) return '<p class="small"><b>國旗:</b>這一次建置沒有國旗檔,隊名照樣印。</p>';
  const src = D.sources.find(x => x.key === 'flags');
  const names = xs => xs.map(x => esc(zhOf(x.key ?? x))).join('、');
  const excluded = new Set((f.excluded ?? []).map(x => x.key));
  const noCode = f.noCode.filter(k => !excluded.has(k));
  const parts = [
    ...(f.excluded ?? []).map(x => `${esc(zhOf(x.key))}刻意不給:${esc(x.why ?? '')}`),
    f.sameAs.length ? `${f.sameAs.map(x => `${esc(zhOf(x.key))}(國旗集裡就是${esc(x.asKey ? zhOf(x.asKey) : x.as.toUpperCase())}的旗)`).join('、')} —— 掛上去會讓人以為是那一國,所以不掛` : null,
    noCode.length ? `${names(noCode)}沒有國碼(大多是非會員的區域隊)` : null,
    f.notFetched.length ? `${names(f.notFetched)}的圖還沒抓(npm run intl:flags)` : null,
  ].filter(Boolean);
  return `<p class="small"><b>國旗:</b><a href="${esc(src?.url)}" target="_blank" rel="noopener">${esc(src?.name ?? '開源國旗集')}</a>
    (${esc(f.source?.license ?? '')} 授權),本站縮成 ${esc((f.size ?? []).join('×'))} 內嵌。${f.count} 隊有國旗${parts.length ? `;沒有的:${parts.join(';')}` : ''}。</p>`;
}

/* 最近賽果的核對狀態,一句話。**獨立來源還沒收到的那幾天不是「不一致」** ——
   只印「兩個來源一致 0 場」的話,讀者會以為核對全部失敗了。 */
function recentSub(rs) {
  const n = k => rs.filter(r => r.check === k).length;
  const parts = [n('agree') ? `兩個來源一致 ${n('agree')}` : null,
    n('notYet') ? `待核對 ${n('notYet')}(獨立來源收錄到 ${esc(D.model.ratingsAsOf)})` : null,
    n('mismatch') ? `不一致 ${n('mismatch')}` : null].filter(Boolean);
  return parts.join('・') || (rs.length ? '見下方逐場判決' : '這幾天沒有比賽');
}

function render() {
  const now = Date.now();
  const soon = D.fixtures.filter(f => Date.parse(f.kickoff) > now && Date.parse(f.kickoff) <= now + STEP_DAYS * DAY && f.state !== 'CANCELLED');
  const recent = D.results.filter(r => Date.parse(r.kickoff) >= now - STEP_DAYS * DAY);
  const fetched = D.comps.map(c => c.retrievedAt).filter(Boolean).sort().at(0);
  const mj = D.sources.find(s => s.key === 'martj42');
  const h = D.model.holdout;
  const chip = (key, label) => `<button class="btn${S.fam === key ? ' on' : ''}" data-fam="${key}">${esc(label)}</button>`;
  const y = window.scrollY;
  app.innerHTML = `
  <div class="page-head">
    <h1>國家隊</h1>
    <p>${D.comps.filter(c => c.status === 'ok').length} 個賽事的賽程與賽果,加上本站自己算的國家隊 Elo 與勝率。
      勝率只給兩隊都踢過 ${D.model.minGames} 場以上的比賽,評分只從獨立來源的歷史賽果算。</p>
    ${C.stampRow([
      C.stamp('賽程與賽果(FotMob)', { iso: fetched, kind: 'daily', note: `跟著每天兩次的部署更新;${D.comps.filter(c => c.retrievedAt).length} 個賽事裡最舊的那一個` }),
      C.stamp(`歷史賽果(martj42,收錄到 ${mj?.lastDate ?? '—'})`, { iso: mj?.retrievedAt, kind: 'daily', note: '評分只從這一份算' }),
    ])}
  </div>

  <div class="grid g4">
    <div class="kpi"><div class="label">接下來 7 天</div><div class="value">${soon.length}</div>
      <div class="sub">給勝率 ${soon.filter(f => f.prob).length} 場</div></div>
    <div class="kpi"><div class="label">最近 7 天賽果</div><div class="value">${recent.length}</div>
      <div class="sub">${recentSub(recent)}</div></div>
    <div class="kpi"><div class="label">評分截止</div><div class="value" style="font-size:22px">${esc(D.model.ratingsAsOf ?? '—')}</div>
      <div class="sub">之後的比賽還沒進評分</div></div>
    <div class="kpi"><div class="label">驗收改善</div><div class="value" style="font-size:22px">${h ? h.gain : '—'}</div>
      <div class="sub">${h ? `± ${h.se}・${h.n} 場・${D.model.passed ? '通過' : '沒通過'}` : '沒有驗收結果'}</div></div>
  </div>

  <div class="filters">${chip('all', '全部')}${D.families.map(f => chip(f.key, f.zh)).join('')}</div>

  ${pendingBlock(now)}
  ${upcomingBlock(now)}
  ${resultsBlock(now)}
  ${standingsBlock(now)}
  ${rankingBlock()}
  ${modelBlock()}
  ${boundaryBlock()}

  <footer class="foot wrap" style="padding-left:0;padding-right:0">
    資料建置於 ${esc(D.builtAt.slice(0, 16).replace('T', ' '))} UTC・來源:${D.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.role)}">${esc(s.name)}</a>`).join('、')}。
    勝率僅供分析參考,不構成任何投注建議。
  </footer>`;
  window.scrollTo(0, y);

  for (const b of app.querySelectorAll('[data-fam]')) b.onclick = () => { S.fam = b.dataset.fam; render(); };
  for (const b of app.querySelectorAll('[data-stand]')) b.onclick = () => { S.stand = b.dataset.stand; render(); };
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = () => { fn(); render(); }; };
  on('moreAhead', () => { S.ahead += STEP_DAYS; });
  on('moreBack', () => { S.back += STEP_DAYS; });
  on('rankToggle', () => { S.rankAll = !S.rankAll; });
}

/* ── 球隊頁(intl.html?team=Japan)────────────────────────────────────────
   明細在 intl-teams.json(點進來才載)。**每一個數字都來自同一條 Elo** —— 「這一場 +12」加起來
   就是排名上那個分數(build 用 lib/intl.mjs 的 eloDelta,排名與這裡共用)。 */

/* 賽事名的中文(只是顯示;查不到的照印上游的英文,不猜) */
const TOUR_ZH = {
  'Friendly': '友誼賽', 'FIFA World Cup': '世界盃', 'FIFA World Cup qualification': '世界盃資格賽',
  'UEFA Nations League': '歐洲國家聯賽', 'UEFA Euro': '歐洲國家盃', 'UEFA Euro qualification': '歐洲國家盃資格賽',
  'African Cup of Nations': '非洲國家盃', 'African Cup of Nations qualification': '非洲國家盃資格賽',
  'AFC Asian Cup': '亞洲盃', 'AFC Asian Cup qualification': '亞洲盃資格賽', 'Copa América': '美洲盃',
  'Gold Cup': '金盃賽', 'Gold Cup qualification': '金盃賽資格賽', 'CONCACAF Nations League': '中北美國家聯賽',
  'CONCACAF Nations League qualification': '中北美國家聯賽資格賽', 'Gulf Cup': '海灣盃', 'Arab Cup': '阿拉伯盃',
  'Arab Cup qualification': '阿拉伯盃資格賽', 'FIFA Series': 'FIFA 系列賽', 'Oceania Nations Cup': '大洋洲國家盃',
  'ASEAN Championship': '東協錦標賽', 'AFF Championship': '東協錦標賽', 'EAFF Championship': '東亞錦標賽',
  'SAFF Cup': '南亞錦標賽', 'WAFF Championship': '西亞錦標賽', 'COSAFA Cup': '南部非洲國家盃',
  'Confederations Cup': '洲際國家盃', 'Island Games': '島嶼運動會',
};
const tourZh = t => TOUR_ZH[t] ?? t;
// 對手的稱呼:認得的印中文名,還沒決定的(海灣盃四強的 1A)照產物的說法,其餘照上游
const sideLabel = t => (t?.key ? zhOf(t.key) : t?.tbd ? t.label : t?.name ?? '待定');
const VENUE = { H: '主', A: '客', N: '中立' };
const outcome = ([gf, ga]) => (gf > ga ? 'W' : gf === ga ? 'D' : 'L');
const OUT = { W: ['勝', 'win'], D: ['和', 'draw'], L: ['負', 'loss'] };
const outPill = o => `<span class="pill tiny" style="color:var(--${OUT[o][1]});border-color:currentColor">${OUT[o][0]}</span>`;

/* 歷來交手:從這一隊的角度講。**只當資訊,不進模型** —— 評分本來就含了每一場比賽,同一個對手不另外加權 */
function h2hBlock(key, opp, H) {
  const k = key < opp ? `${key}|${opp}` : `${opp}|${key}`;
  if (!(k in H)) return '';
  const x = H[k];
  const oz = esc(zhOf(opp));
  if (!x) return `<div class="small dim">跟${oz}沒有交手紀錄(martj42 自 1872 年起的男子 A 級賽)。</div>`;
  const first = k.startsWith(`${key}|`);
  const [w, d, l] = first ? x.w : [x.w[2], x.w[1], x.w[0]];
  const [gf, ga] = first ? x.g : [x.g[1], x.g[0]];
  const last = [...x.last].reverse().map(m => {
    const mine = m.h === key ? m.s : [m.s[1], m.s[0]];
    return `<div class="stat-line"><span class="tiny dim mono">${esc(C.dateFull(m.d))}</span>
      <span class="small">${esc(zhOf(m.h))} ${m.s[0]} - ${m.s[1]} ${esc(zhOf(m.a))}${m.n ? '<span class="tiny dim">(中立場)</span>' : ''}</span>
      <span class="tiny dim">${esc(tourZh(m.t))}</span>${outPill(outcome(mine))}</div>`;
  }).join('');
  return `<div class="card" style="margin-top:10px">
    <div class="spread"><h3 style="margin:0;font-size:15px"><span class="intl-team">對${flagImg(opp)}${oz}</span></h3><span class="tiny dim">交手 ${x.n} 次・自 ${esc(x.since.slice(0, 4))} 年</span></div>
    ${C.statCells([{ label: '勝', value: w, tone: 'win' }, { label: '和', value: d }, { label: '負', value: l, tone: 'loss' },
      { label: '進:失', value: `${gf}:${ga}` }], { compact: true })}
    <div style="display:grid;gap:2px;margin-top:8px">${last}</div>
    <div class="tiny dim" style="margin-top:6px">最近 ${x.last.length} 次。比分含延長、不含 PK(PK 決勝的算和局)。</div>
  </div>`;
}

async function renderTeam(key) {
  const info = D.teams[key];
  const back = `<a class="small" href="${esc(C.link('intl'))}">← 回國家隊</a>`;
  if (!info) {
    app.innerHTML = `<div class="page-head">${back}<h1>找不到這一隊</h1>
      <p>本站的國家隊資料裡沒有「${esc(key)}」—— 名字要用 martj42 的寫法(例如 Japan、South Korea)。</p></div>`;
    return;
  }
  const { data } = await C.loadFrom('pl', ['intl-teams']);
  const T = data['intl-teams'] ?? null;
  const X = T?.teams?.[key] ?? null;
  const H = T?.h2h ?? {};
  const now = Date.now();
  const zh = info.zh ?? key;
  const nm = (D.nonMembers ?? []).find(x => x.key === key);
  const standing = info.rank ? `排名第 ${info.rank}` : nm ? (nm.linked ? '不是國際足總會員,不列排名(主要跟會員交手,評分可以比)'
    : '不是國際足總會員,不列排名(兩年內只跟非會員踢,評分跟會員比不起來)') : '不列排名(兩年內沒踢,或場數不到門檻)';

  const recent = X?.recent ?? [];
  const last10 = recent.slice(-10);
  const cnt = o => last10.filter(m => outcome(m.s) === o).length;
  /* 過去一年的評分變化:**評分截止日**往前推一年那一刻的評分,對現在。
     第一版拿「這一隊最後一場」往前推,澤西島最後一場在 2025 年、再往前推一年沒有比賽,
     於是拿 2023 年的點跟現在比,卻標成「一年來」。那一刻的評分 = 那一天以前最後一場踢完的評分。 */
  const tr = X?.trend ?? [];
  const asOf = D.model.ratingsAsOf;
  const yearAgo = asOf ? new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * DAY).toISOString().slice(0, 10) : null;
  const basePt = yearAgo ? [...tr].reverse().find(p => p[0] <= yearAgo) : null;
  const yoy = basePt && info.rating != null ? info.rating - basePt[1] : null;
  const playedSince = yearAgo ? tr.filter(p => p[0] > yearAgo).length : 0;

  const mine = x => x.home?.key === key || x.away?.key === key;
  const upcoming = D.fixtures.filter(f => mine(f) && Date.parse(f.kickoff) > now);
  const next = upcoming.find(f => f.state !== 'CANCELLED');
  const opps = [...new Set(upcoming.filter(f => f.state !== 'CANCELLED')
    .map(f => (f.home.key === key ? f.away.key : f.home.key)).filter(Boolean))];
  const unrated = D.results.filter(r => mine(r) && r.check !== 'agree' && r.check !== 'awarded' && r.check !== 'mismatch');
  const groups = (D.standings ?? []).flatMap(st => st.groups.filter(g => g.rows.some(r => r.key === key))
    .map(g => ({ g, title: `${COMPS.get(st.comp)?.zh ?? st.comp}・${g.zh ?? g.name}` })));

  const recentRows = [...recent].reverse().map(m => `<tr>
      <td class="num mono">${esc(C.dateFull(m.d))}</td>
      <td class="left"><span class="intl-team">${flagImg(m.o)}${teamLink(m.o, esc(zhOf(m.o)))}</span></td>
      <td class="num">${VENUE[m.v] ?? m.v}</td>
      <td class="num mono">${m.s[0]} - ${m.s[1]} ${outPill(outcome(m.s))}</td>
      <td class="left small">${esc(tourZh(m.t))}</td>
      <td class="num mono" style="color:var(--${m.dr > 0 ? 'win' : m.dr < 0 ? 'loss' : 'ink-3'})">${m.dr > 0 ? '+' : ''}${m.dr.toFixed(1)}</td>
      <td class="num mono">${m.r}</td></tr>`).join('');

  const y = window.scrollY;
  app.innerHTML = `
  <div class="page-head">
    ${back}
    <h1 class="intl-team">${flagImg(key, true)}${esc(zh)}</h1>
    <p>${zh !== key ? `${esc(key)}・` : ''}本站 Elo ${info.rating ?? '—'}(${standing})・累積 ${info.games} 場・最近一場 ${esc(C.dateFull(info.last))}。
      評分只從 martj42 的歷史賽果算,算到 ${esc(D.model.ratingsAsOf)}。</p>
  </div>

  <div class="grid g4">
    <div class="kpi"><div class="label">本站 Elo</div><div class="value">${info.rating ?? '—'}</div>
      <div class="sub">${info.rank ? `第 ${info.rank} 名(${D.ranking.length} 隊)` : '不列排名'}</div></div>
    <div class="kpi"><div class="label">最近 ${last10.length} 場</div><div class="value" style="font-size:22px">${cnt('W')} 勝 ${cnt('D')} 和 ${cnt('L')} 負</div>
      <div class="sub">martj42 收錄的最近 ${last10.length} 場</div></div>
    <div class="kpi"><div class="label">過去一年的評分</div><div class="value" style="font-size:22px">${yoy == null ? '—' : `${yoy > 0 ? '+' : ''}${yoy}`}</div>
      <div class="sub">${yoy == null ? `走勢只從 ${esc(String(T?.trendFrom ?? '').slice(0, 4))} 年起記,一年前那一刻的評分不在裡面`
        : `${esc(C.dateFull(yearAgo))} 是 ${basePt[1]} → ${esc(C.dateFull(asOf))} 是 ${info.rating}・這一年踢了 ${playedSince} 場`}</div></div>
    <div class="kpi"><div class="label">下一場</div><div class="value" style="font-size:18px">${next ? esc(dayLabel(next.kickoff)) : '—'}</div>
      <div class="sub">${next ? `對${esc(sideLabel(next.home.key === key ? next.away : next.home))}・${esc(COMPS.get(next.comp)?.short ?? '')}` : `本站抓的 ${D.comps.filter(c => c.status === 'ok').length} 個賽事裡沒有`}</div></div>
  </div>

  <div class="section"><h2>接下來的比賽</h2><span class="hint">時間是你所在時區(${esc(C.tzName())})</span></div>
  ${upcoming.length ? dayBlocks(upcoming, fixtureRow) : `<div class="note">本站抓的 ${D.comps.filter(c => c.status === 'ok').length} 個賽事裡,這一隊接下來沒有排定的比賽。</div>`}

  ${opps.length ? `<div class="section"><h2>歷來交手</h2><span class="hint">跟接下來這幾個對手・只當資訊,<b>不進模型</b></span></div>
    ${opps.map(o => h2hBlock(key, o, H)).join('')}` : ''}

  ${groups.length ? `<div class="section"><h2>分組積分榜</h2><span class="hint">積分由本站用已完賽的賽果算</span></div>
    <div class="intl-groups">${groups.map(({ g, title }) => groupCard(g, { me: key, title })).join('')}</div>` : ''}

  ${tr.length > 1 ? `<div class="section"><h2>評分走勢</h2><span class="hint">${esc(T.trendFrom.slice(0, 4))} 年起,每一場踢完之後的評分</span></div>
    <div class="card">${C.eloTrend(tr.map(([d, r]) => ({ date: d, r })))}
      <div class="tiny dim">${tr.length} 場・${esc(C.dateFull(tr[0][0]))} 起・目前 ${tr.at(-1)[1]}・這段期間 ${tr.at(-1)[1] - tr[0][1] >= 0 ? '+' : ''}${tr.at(-1)[1] - tr[0][1]}
        (把游標移到線上可看單場數值)</div></div>` : ''}

  ${recent.length ? `<div class="section"><h2>最近的比賽</h2><span class="hint">評分已經算進去的最近 ${recent.length} 場・評分變化就是這一場讓 Elo 動了多少</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th class="num">日期</th><th class="left">對手</th><th class="num">場地</th><th class="num">比分</th><th class="left">賽事</th><th class="num">評分變化</th><th class="num">賽後評分</th></tr></thead>
      <tbody>${recentRows}</tbody></table></div>` : ''}

  ${unrated.length ? `<div class="section"><h2>還沒進評分的賽果</h2><span class="hint">來自 FotMob・獨立來源還沒收或沒收的場次,所以沒有改到上面的評分</span></div>
    ${dayBlocks(unrated, resultRow, { desc: true })}` : ''}

  <footer class="foot wrap" style="padding-left:0;padding-right:0">
    資料建置於 ${esc(D.builtAt.slice(0, 16).replace('T', ' '))} UTC・評分、走勢與交手紀錄來自 martj42/international_results,賽程來自 FotMob。
    勝率僅供分析參考,不構成任何投注建議。
  </footer>`;
  window.scrollTo(0, y);
}

try {
  const { data, absent } = await C.loadFrom('pl', ['intl', 'intl-flags']);
  if (!data.intl) throw new Error(`讀取 ${absent.join('、') || 'intl'} 失敗`);
  D = data.intl;
  FLAGS = data['intl-flags']?.flags ?? {};
  COMPS = new Map(D.comps.map(c => [c.key, c]));
  C.nav();
  if (TEAM) await renderTeam(TEAM);
  else render();
} catch (err) { C.fail(err); }
