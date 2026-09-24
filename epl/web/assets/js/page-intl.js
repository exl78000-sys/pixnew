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
   (實時戰況頁那條坑)。 */

const DAY = 86400000;
const STEP_DAYS = 7;
const S = { fam: 'all', ahead: STEP_DAYS, back: STEP_DAYS, rankAll: false };
let D = null;
let COMPS = new Map();

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
function teamHtml(t) {
  if (!t) return '<span class="dim small">待定</span>';
  if (t.tbd) return `<span class="intl-team dim small" title="上一階段還沒踢完,這一格的參與者還沒決定(上游寫作 ${esc(t.name)})"><span>${esc(t.label)}</span></span>`;
  if (!t.key) return `<span class="intl-team small" title="本站還對不上「${esc(t.name)}」的身分,所以沒有它的評分"><span>${esc(t.name)}<span class="dim">*</span></span></span>`;
  const info = D.teams[t.key];
  const zh = info?.zh ?? t.key;
  const tip = [zh !== t.key ? t.key : null,
    info?.rating != null ? `本站 Elo ${info.rating}${info.rank ? `(排名第 ${info.rank})` : ''}` : null].filter(Boolean).join('・');
  return `<span class="intl-team small" title="${esc(tip)}"><span>${esc(zh)}</span></span>`;
}

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
  return `${bar}<div class="tiny dim" style="margin-top:3px" title="評分只算到 ${esc(D.model.ratingsAsOf)}(獨立來源收錄到的最後一天);之後踢的比賽還沒被核對,不拿來改評分。這兩隊之後又踢了:${esc(who)}">評分未含最近 ${lag} 場</div>`;
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
    <span class="leg-home">${teamHtml(f.home)}</span>
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
    <span class="leg-home" style="${strong('home')}">${teamHtml(r.home)}</span>
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
      <span class="leg-home">${teamHtml(f.home)}</span>
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

function rankingBlock() {
  const rows = S.rankAll ? D.ranking : D.ranking.slice(0, 20);
  return `<div class="section"><h2>本站 Elo 排名</h2>
      <span class="hint">不是 FIFA 排名・評分算到 ${esc(D.model.ratingsAsOf)}・${D.ranking.length} 隊</span></div>
    <div class="note" style="margin-bottom:10px">只列<b>兩年內踢過比賽、而且累積 ${D.model.minGames} 場以上</b>的隊 ——
      評分從 1872 年的第一場算起,解散或很久沒踢的隊評分凍在當年,列進來會變成歷史榜。
      分數本身沒有單位,兩隊差 100 分代表中立場上強的那一邊的預期得分是 ${
        Math.round(100 / (1 + 10 ** (-100 / 400)))}%(贏算 1、和算 0.5)。</div>
    <div class="table-wrap"><table>
      <thead><tr><th class="num">名次</th><th class="left">國家隊</th><th class="num">Elo</th><th class="num">場數</th><th class="num">最近一場</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="num">${r.rank}</td>
        <td class="left" title="${esc(r.key)}">${esc(zhOf(r.key))}</td>
        <td class="num">${r.rating}</td><td class="num">${r.games}</td><td class="num">${esc(C.dateFull(r.last))}</td></tr>`).join('')}</tbody>
    </table></div>
    ${D.ranking.length > 20 ? `<div class="row" style="margin-top:10px"><button class="btn" id="rankToggle">${S.rankAll ? '只看前 20' : `看全部 ${D.ranking.length} 隊`}</button></div>` : ''}`;
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
  ${rankingBlock()}
  ${modelBlock()}
  ${boundaryBlock()}

  <footer class="foot wrap" style="padding-left:0;padding-right:0">
    資料建置於 ${esc(D.builtAt.slice(0, 16).replace('T', ' '))} UTC・來源:${D.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.role)}">${esc(s.name)}</a>`).join('、')}。
    勝率僅供分析參考,不構成任何投注建議。
  </footer>`;
  window.scrollTo(0, y);

  for (const b of app.querySelectorAll('[data-fam]')) b.onclick = () => { S.fam = b.dataset.fam; render(); };
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = () => { fn(); render(); }; };
  on('moreAhead', () => { S.ahead += STEP_DAYS; });
  on('moreBack', () => { S.back += STEP_DAYS; });
  on('rankToggle', () => { S.rankAll = !S.rankAll; });
}

try {
  const { data, absent } = await C.loadFrom('pl', ['intl']);
  if (!data.intl) throw new Error(`讀取 ${absent.join('、') || 'intl'} 失敗`);
  D = data.intl;
  COMPS = new Map(D.comps.map(c => [c.key, c]));
  C.nav();
  render();
} catch (err) { C.fail(err); }
