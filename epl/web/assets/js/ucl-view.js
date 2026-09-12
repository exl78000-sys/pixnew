import * as C from './core.js?v=f9001a4c';


/* 歐冠頁。跟聯賽頁不一樣、而且會影響怎麼寫的四件事:

   1. **這一頁跨聯賽。** 英超與西甲兩邊看到的是同一份 ucl.json(build 與
      build-laliga 呼叫同一個 lib/ucl.mjs)。所以球隊連結要指到**認得它的那個聯賽**,
      隊徽則只有在目前這個聯賽的資料集裡才端得出來 —— 從英超頁看皇馬,
      C.team('RMA') 會退回一個灰方塊寫著 RMA,那看起來像壞掉,所以不畫。

   2. **一季 36 隊,本站只認得其中 8~11 支。** 認不得的只給名字,
      不掛隊徽也不給連結(鐵則三)。涵蓋率直接寫在畫面上。

   3. **預測有,但只給有評分的場次(2026-09-09 階段 C)。** 做法是把八個聯賽的賽果
      與歐冠場次餵進**同一個 Elo 池**,歐冠場次就是把各聯賽接起來的橋;走查回測
      219 場 RPS 0.2227、基準線 0.2376(改善 0.0149 ± 0.0061,通過)。
      **兩隊都要有評分才給** —— openfootball 不涵蓋的聯賽(比利時、土耳其、蘇格蘭…)
      那些球隊沒有評分,那些場次一場都不給。詳見 `lib/ucl-elo.mjs` 的檔頭,
      裡面也寫了兩個**量過而沒有通過**的修正,不要再加回來。舊版這裡寫著 ——
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

/* 名字刻意避開 core.js 的 teamCell —— 單檔版會把共用模組攤平到頂層,
   跟 core 的匯出同名就是 SyntaxError(分頁版有模組作用域,看不出來)。
   bundle.mjs 有一條守門擋這種撞名。 */
function uclTeamCell(t, { align = 'left', strong = false } = {}) {
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
  /* 這一列的欄寬本來寫在 inline style 裡(78 / 128 / 96 三個 min-width)。
     那三個加起來 302px,在 375px 的手機上剩不到 40px 給兩個隊名 —— 而隊名有
     自己的最小寬度,擠不下就把整列撐到 475px,**整頁跟著橫向捲動**
     (2026-09-03 實測:盃賽頁 docW 567 vs 視窗 375,45 列都這樣)。
     改用 class,寬度放進 CSS,手機上才有地方覆寫成「兩行」。 */
  const legs = tie.legs.map((m, i) => `
    <div class="stat-line tie-leg">
      <span class="tiny dim leg-when">${legLabel(m, i, tie.twoLegged)}</span>
      <span class="leg-home">${uclTeamCell(m.home, { align: 'right' })}</span>
      <span class="leg-score">${scoreCell(m)}</span>
      <span class="leg-away">${uclTeamCell(m.away)}</span>
      <span class="tiny dim leg-ko">${m.played ? KO(m) : ''}${expandBtn(m)}</span>
    </div>${expandSlot(m)}`).join('');
  return `<div class="card" style="margin-top:10px">
    <div class="spread" style="gap:10px;align-items:center">
      <span style="flex:1;text-align:right">${uclTeamCell(A, { align: 'right', strong: winA })}</span>
      <span style="min-width:96px;text-align:center">${agg}</span>
      <span style="flex:1">${uclTeamCell(B, { strong: winB })}</span>
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

/* 聯賽階段的**賽程**(2026-09-03 加)。
 *
 * 這一季的 144 場一直都在資料裡(`leagueMatches`,開球時間 31 種、matchday 1~8),
 * 但這一頁只畫了一張全 0 的積分榜 —— **抓到了卻沒接上**,跟外電那次一樣。
 * 而頁首還寫著「上游還沒有開球時間與輪次」,那句話現在是假的(已改)。
 *
 * 只畫**一個輪次**:144 場全列出來要捲很久,而讀者要看的是「下一批什麼時候踢」。
 * 預設停在**還沒踢完的最小輪次**(不是「下一場的輪次」—— 有場次提前開踢時,
 * 下一場可能屬於更後面的一輪,倒數那條坑的同一個形狀)。
 */
/* 賽前對比(2026-09-09,使用者要求的階段 A)。

   **只有兩隊都在本站資料裡的場次才有。** 本季 36 隊裡本站認得 10 支,
   144 場聯賽階段比賽裡兩隊都認得的只有 8 場(6%)—— 其餘至少有一隊本站完全沒有資料,
   對比是兩欄的東西,一欄空著就是留一個永遠空白的欄位(鐵則三)。

   **仍然沒有勝率預測。** 這裡放的全部是各自聯賽算出來的原始事實,
   一個模型輸出都沒有(理由見 core.js 的 uclCompareRows)。

   資料**延遲載入**:兩個聯賽的 table.json 各約 100 KB,而整頁只有一兩場用得到 ——
   開頁就抓等於每個讀者都付這筆錢。C.loadFrom 自己有快取,同一頁第二次展開不會再抓。 */
const tableCache = new Map();          // 聯賽 → table.current(以隊碼索引)
/* **不要叫 leagueTable** —— 這個檔下面已經有一個同名的積分榜渲染器,
   兩個 function 宣告會讓後面那個蓋掉前面那個,而且不拋錯:
   賽前對比會拿著聯賽代碼去跑積分榜渲染器。加名字之前先 grep 同名的那條坑。 */
async function standingsOf(lg) {
  if (!tableCache.has(lg)) {
    const { data } = await C.loadFrom(lg, ['table']);
    const rows = data?.table?.current ?? [];
    tableCache.set(lg, new Map(rows.map(r => [r.code, r])));
  }
  return tableCache.get(lg);
}

/* 這一場能不能做對比。條件寫成一個函式是因為畫按鈕與真的去算兩個地方都要問 —— 
   兩邊各寫一份的話,會出現「按鈕在但點了沒東西」。

   **兩種來源都算數**:本站聯賽(英超/西甲,有隊碼、有球隊頁),
   以及只有積分榜的那三個(德甲/義甲/法甲,沒有隊碼也沒有球隊頁)。
   加上後者之後本季從 8 場變成 48 場 —— 那正是做這一步的理由。 */
let standings = null;                                    // ucl-standings.json(呼叫端傳進來)
let model = null;                                        // ucl-elo.json(呼叫端傳進來)

/* 這一場有沒有預測。**兩隊都要有跨聯賽評分**,而且回測要通過 ——
   build 端已經守過一次(沒通過就不產 fixtures),前端再問一次是因為
   「按鈕在但點了沒東西」比沒有按鈕糟。 */
const predOf = m => (model?.fixtures ?? []).find(f => f.id === m?.id) ?? null;
const statsFor = t => {
  if (!t) return null;
  if (registered(t.code) && t.league) return { kind: 'site', league: t.league, code: t.code };
  const row = standings?.byTeamId?.[String(t.id)];
  return row ? { kind: 'table', league: row.league, row } : null;
};
const comparable = m => !m?.played && !!statsFor(m?.home) && !!statsFor(m?.away);

/* 展開鈕的條件是「有東西可看」,**不等於「有對比可看」**。
   階段 C 之後預測涵蓋 116 場、而對比只有 61 場(對比要兩隊都在 ucl-standings 裡,
   那份只涵蓋 openfootball 那五個聯賽)—— 用 comparable 當展開條件的話,
   **55 場有預測卻沒有按鈕**,讀者根本看不到。這是「按鈕在但點了沒東西」的反面:
   東西在但沒有按鈕,而且一樣不會報錯。 */
/* 賽後報告的索引(ucl-details.json,呼叫端傳進來)。逐場報告另外一檔一場,點開才載。 */
let details = null;
const detailOf = m => (m?.id != null ? details?.reports?.[String(m.id)] : null) ?? null;

/* 2026-09-12 第二次踩「東西在但沒有按鈕」:這裡原本是 `!m.played && …`,於是已完賽的場次
   **永遠沒有按鈕** —— 而賽後報告接上之後,18 場的報告就在索引裡,讀者一場都點不開。
   規則只有一條:有東西可看就給鈕。已完賽看有沒有報告,未賽看有沒有對比或預測。 */
const expandable = m => (m?.played ? !!detailOf(m) : (comparable(m) || !!predOf(m)));
const expandKind = m => (m?.played ? 'post' : comparable(m) ? 'compare' : 'pred');
const OPEN_LABEL = { post: '賽後報告', compare: '賽前對比', pred: '賽前勝率' };
const CLOSE_LABEL = { post: '收起報告', compare: '收起對比', pred: '收起' };
const expandKey = m => C.esc(String(m.id ?? `${m.home?.code}|${m.away?.code}`));
/* 展開鈕與展開槽。**兩個地方都要用同一份**(聯賽階段的賽程列、淘汰賽的每一回合),
   各寫一份的話淘汰賽那邊會少掉某一種鈕而且不報錯。 */
const expandBtn = m => (expandable(m)
  ? `<button class="btn tiny" type="button" data-cmp="${expandKey(m)}" data-kind="${expandKind(m)}"
       style="margin-left:6px">${OPEN_LABEL[expandKind(m)]}</button>` : '');
const expandSlot = m => (expandable(m)
  ? `<div class="ucl-cmp" data-cmp-slot="${expandKey(m)}" hidden></div>` : '');
/* 一季的全部場次:聯賽階段 + 淘汰賽每一回合。展開鈕的查表要涵蓋兩邊 ——
   只收 leagueMatches 的話,淘汰賽的鈕會「按鈕在但點了沒東西」。 */
const allMatchesOf = s => [...(s?.leagueMatches ?? []), ...(s?.rounds ?? []).flatMap(r => (r.ties ?? []).flatMap(t => t.legs ?? []))];

/* 對比裡要顯示的隊名與顏色。**本站沒有的球隊沒有 C.name / C.team** ——
   直接叫 C.name(undefined) 會拿到一個看起來像壞掉的東西,所以走上游給的名字,
   顏色退回中性色(不替它們挑一個「看起來像」的隊色,那是編出來的)。 */
const cmpName = t => (registered(t?.code) ? C.name(t.code) : (t?.name ?? '?'));
const cmpColor = t => (registered(t?.code) ? C.team(t.code).chartColor : null);

/* 一隊的本季聯賽數據。本站聯賽要去抓 table.json(延遲載入),
   只有積分榜的那三個已經在 ucl-standings.json 裡,不用再抓。 */
async function rowFor(t) {
  const src = statsFor(t);
  if (!src) return null;
  if (src.kind === 'table') return src.row;
  return (await standingsOf(src.league)).get(src.code) ?? null;
}

/* 勝率預測。**跟上面那張事實表是兩件事**,所以分開放、各自講各自的出處:
   表格是「兩個聯賽各自的原始數字」,這一塊是「同一把尺上的跨聯賽評分」。
   混在一起的話讀者會以為表格裡的名次也是可比的,而那正是這一頁一直在講不可比的東西。

   沒有預測的場次**整塊不印**,不印一句「暫無預測」—— 但本頁下方的說明會講清楚
   哪些球隊沒有評分、為什麼(鐵則三與鐵則四)。 */
function predictionBlock(m) {
  const f = predOf(m);
  if (!f) return '';
  const md = model?.model;
  const [h, d, a] = f.p;
  return `<div class="card" style="margin:2px 0 12px;padding:10px 12px">
      <div class="row small" style="justify-content:space-between;margin-bottom:6px">
        <b>賽前勝率</b>
        <span class="tiny dim">跨聯賽 Elo・回測 ${md ? `${md.n} 場 RPS ${md.rps}(基準 ${md.baseline})` : '—'}</span>
      </div>
      ${C.probBar({ home: h, draw: d, away: a })}
      <div class="row tiny dim" style="justify-content:space-between;margin-top:4px">
        <span>${C.esc(cmpName(m.home))} ${(h * 100).toFixed(0)}%</span>
        <span>和 ${(d * 100).toFixed(0)}%</span>
        <span>${C.esc(cmpName(m.away))} ${(a * 100).toFixed(0)}%</span>
      </div>
      <div class="tiny dim" style="margin-top:8px">把八個聯賽的賽果與歐冠場次餵進<b>同一個評分池</b>算出來的 ——
        歐冠場次就是把各聯賽接起來的橋。用的是本站聯賽預測那一套 Elo,<b>沒有為歐冠調過任何係數</b>。
        ${md ? `走查回測 ${md.n} 場:模型 ${md.rps}、基準線 ${md.baseline},改善 ${md.improvement} ± ${md.se}。` : ''}
        <b>樣本只有兩季多</b>,而且能回測的都是兩隊都有評分的場次 —— 比整體偏向大聯賽的對戰。
        完整的驗證、涵蓋率與界線在<a href="${C.link('model')}">模型驗證頁</a>。</div>
    </div>`;
}

async function renderCompare(slot, m) {
  slot.innerHTML = '<div class="tiny dim">載入兩隊的聯賽數據中…</div>';
  try {
    const [h, a] = await Promise.all([rowFor(m.home), rowFor(m.away)]);
    /* 對比拿不到**不代表沒有預測** —— 兩者的資料來源不同:
       對比要兩隊都在 ucl-standings(只有 openfootball 那五個聯賽),
       預測只要兩隊都有跨聯賽評分。所以這裡不能直接 return,
       不然那 55 場的預測會被這一行吃掉。 */
    if (!h || !a) {
      const only = predictionBlock(m);
      slot.innerHTML = only
        ? `${only}<div class="tiny dim">這兩隊之中至少一隊本站沒有聯賽現況可以並排
             (它們的聯賽只用來辨識球隊、不收域內賽果),所以只有勝率、沒有下面那張對照表。</div>`
        : '<div class="tiny dim">這兩隊本季的聯賽數據還沒產生,暫時做不出對比。</div>';
      return;
    }
    const lgName = c => C.LEAGUES[c]?.zh
      ?? (standings?.leagues ?? []).find(l => l.key === c)?.zh ?? c;
    // 樣本太小要講:球季剛開始時三場的場均進球跟整季不是同一件事(鐵則四)
    const thin = Math.min(h.p ?? 0, a.p ?? 0) < 5;
    slot.innerHTML = `
      <div class="row small dim" style="justify-content:space-between;margin:2px 0 6px">
        <span>${C.esc(cmpName(m.home))}・${C.esc(lgName(statsFor(m.home).league))} ${h.p} 場</span>
        <span>${C.esc(cmpName(m.away))}・${C.esc(lgName(statsFor(m.away).league))} ${a.p} 場</span>
      </div>
      ${predictionBlock(m)}
      ${C.versus(C.uclCompareRows(h, a), {
        home: cmpName(m.home), away: cmpName(m.away),
        colors: { home: cmpColor(m.home), away: cmpColor(m.away) },
      })}
      <div class="note" style="margin-top:10px"><b>上面這張表是兩個聯賽各自的數字,不是同一把尺。</b>
        ${C.esc(lgName(statsFor(m.home).league))}的第 ${h.pos} 名跟${C.esc(lgName(statsFor(m.away).league))}的第 ${a.pos} 名
        不是同一件事,兩邊的對手強度也不同 —— 所以<b>這張表裡一個模型輸出都沒有</b>。
        勝率是另外算的(上面那一塊),用的是把八個聯賽接起來的同一把尺。
        ${thin ? '<br><b>而且樣本很小</b>:兩隊本季各只踢了幾場,場均數字還會大幅變動。' : ''}</div>`;
  } catch (e) {
    slot.innerHTML = `<div class="tiny dim">聯賽數據讀不到(${C.esc(e.message)})。</div>`;
  }
}

/* 賽後報告。逐場報告一檔一場(`ucl-details/{季}/{id}.json`),點開才載 —— 一季 189 場塞成一個檔
   會到 10 MB,每個讀者都要付。報告的 home / away 是 football-data 的 team id 字串(36 隊裡本站只有
   8~11 支有隊碼),所以畫之前先把這兩隊登錄進 C 的隊伍註冊表:名字、隊徽(有的話)、圖上用的顏色。
   **本站沒有的球隊用中性色**,不替它們挑一個「看起來像」的隊色;兩邊各一個中性色是為了射門圖與
   動能圖分得出主客,不是隊色,畫面上講出來。
   卡片全部沿用 core.js 的 matchReportCards(三個聯賽的單場頁同一套),不另畫一份。 */
const NEUTRAL = ['#a8b2c7', '#d9a648'];
function registerSides(m) {
  const entry = (t, i) => {
    const site = registered(t?.code) ? C.team(t.code) : null;
    const crest = site?.crest ?? externalCrest.get(t?.id) ?? null;
    return {
      code: String(t.id), en: cmpName(t), zh: cmpName(t),
      colors: site?.colors ?? [NEUTRAL[i], NEUTRAL[i]],
      chartColor: site?.chartColor ?? site?.colors?.[0] ?? NEUTRAL[i],
      ...(crest ? { crest } : {}),
    };
  };
  C.registerTeams([entry(m.home, 0), entry(m.away, 1)]);
}
const POST_ORDER = ['compare', 'tactics', 'events', 'shotmap', 'momentum', 'lineups', 'teamStats', 'players', 'best'];
async function renderPostMatch(slot, m) {
  const idx = detailOf(m);
  if (!idx) { slot.innerHTML = '<div class="tiny dim">這一場沒有賽後報告。</div>'; return; }
  slot.innerHTML = '<div class="tiny dim">載入賽後報告中…</div>';
  const name = `ucl-details/${idx.season}/${m.id}`;
  try {
    const { data, absent } = await C.loadFrom('pl', [name]);
    const rep = data[name];
    if (!rep) {
      slot.innerHTML = absent.length
        ? '<div class="tiny dim">單檔版沒有打包逐場賽後報告(一季會到 10 MB);分頁版才有。</div>'
        : '<div class="tiny dim">這一場的報告讀不到。</div>';
      return;
    }
    registerSides(m);
    const neutral = !registered(m.home?.code) || !registered(m.away?.code);
    slot.innerHTML = `
      <div class="tiny dim" style="margin:2px 0 8px">賽後資料來自 <b>FotMob 的逐場詳情</b>(球隊統計、事件、正式名單、逐人評分、逐射門 xG),
        比分已跟 football-data.org 的賽果核對。xG 是${C.esc(details?.xgNote ?? '逐射門 xG 加總')}${
          rep.shotmapComplete === false ? ' —— <b>這一場射門圖不完整,所以沒有 xG</b>' : ''}。
        控球率是供應商的數字,歐冠沒有第二來源可抽核。${neutral ? '本站沒有的球隊在球場圖與射門圖上用<b>中性色</b>,不是隊色。' : ''}</div>
      ${C.matchReportCards(rep, { order: POST_ORDER })}`;
  } catch (e) {
    slot.innerHTML = `<div class="tiny dim">賽後報告讀不到(${C.esc(e.message)})。</div>`;
  }
}

/* 讀者選了哪一輪(null = 交給 defaultMatchday)。換賽季時歸零 —— 上一季選的第 7 輪
   套到本季只是誤導。 */
let pickedMatchday = null;

function leagueFixtures(season) {
  const all = season.leagueMatches ?? [];
  if (!all.length) return '';
  const rounds = [...new Set(all.map(m => m.matchday).filter(r => r != null))].sort((a, b) => a - b);
  if (!rounds.length) return '';
  /* 預設輪次交給 core.js 的 defaultMatchday(離現在最近的一輪;進行中優先;平手時有賽果的贏)。
     原本寫的是「還沒踢完的最小輪次」—— 第 1 輪 9/10 踢完,頁面就跳到 10/13 的第 2 輪,
     18 個終場比分從畫面上消失,使用者 9/12 回報「完全看不到比完的比分」。
     而且原本**沒有輪次切換鈕**:不管預設停在哪,別的輪次都看不到。 */
  const cur = (pickedMatchday != null && rounds.includes(pickedMatchday)) ? pickedMatchday
    : (C.defaultMatchday(Date.now(), all) ?? rounds.at(-1));
  const games = all.filter(m => m.matchday === cur)
    .sort((a, b) => String(a.kickoff ?? '').localeCompare(String(b.kickoff ?? '')));
  const playedIn = md => all.filter(m => m.matchday === md && m.played).length;
  const totalIn = md => all.filter(m => m.matchday === md).length;
  const pills = rounds.map(r => `<button class="btn tiny${r === cur ? ' on' : ''}" type="button" data-md="${r}"
      title="第 ${r} 輪・已完賽 ${playedIn(r)} / ${totalIn(r)} 場">第 ${r} 輪${playedIn(r) === totalIn(r) ? ' ✓' : ''}</button>`).join('');
  const undecided = all.filter(m => !m.played).length;

  const row = m => `<div class="stat-line tie-leg">
      <span class="tiny dim leg-when">${m.kickoff ? C.kickoffLocal(m.kickoff) : '時間待定'}</span>
      <span class="leg-home">${uclTeamCell(m.home, { align: 'right' })}</span>
      <span class="leg-score">${m.played && m.final
        ? `<b class="mono">${m.final[0]} : ${m.final[1]}</b>`
        : (m.kickoff ? C.countdown(m.kickoff) : '<span class="dim">vs</span>')}</span>
      <span class="leg-away">${uclTeamCell(m.away)}</span>
      <span class="tiny dim leg-ko">${m.played ? '完場' : ''}${expandBtn(m)}</span>
    </div>${expandSlot(m)}`;

  return `<div class="section" style="margin-top:18px"><h2>聯賽階段賽程</h2>
      <span class="hint">第 ${cur} 輪・${games.length} 場・已完賽 ${playedIn(cur)}${
        rounds.length > 1 ? `(共 ${rounds.length} 輪,本季還有 ${undecided} 場未賽)` : ''}</span></div>
    <div class="filters" style="margin-bottom:10px">${pills}</div>
    <div class="card">${games.map(row).join('')}
      <div class="tiny dim" style="margin-top:10px">一次只列一輪 —— 預設停在<b>離現在最近的那一輪</b>
        (剛踢完的,或即將開踢的;有場次進行中就停在那一輪),其他輪次用上面的按鈕切換。
        ${(() => {
          const n = all.filter(comparable).length;
          const np = (model?.fixtures ?? []).length;
          const unrated = model?.coverage?.unrated ?? [];
          if (!n && !np) return '';
          /* **兩個數字不一樣,要分開講。** 對比要兩隊都在 ucl-standings 裡(只有五個聯賽),
             預測只要兩隊都有跨聯賽評分 —— 所以預測的場次比對比多。
             混成一句的話,讀者會以為某一邊壞了。 */
          return `整季 <b>${np} 場</b>未賽的有<b>勝率預測</b>,
            其中 <b>${n} 場</b>兩隊的聯賽現況本站都有,可以再並排一張對照表
            (那張表是兩個聯賽各自的原始數字,<b>不是同一把尺</b>)。
            ${unrated.length ? `其餘場次<b>不給預測</b>:${C.esc(unrated.map(u => u.name).join('、'))}
              ${unrated.length > 1 ? '這幾隊' : '這一隊'}<b>還沒踢過本季歐冠</b>,而它們所屬的聯賽本站只用來
              辨識球隊、不收域內賽果(收了反而讓模型變差,量過)——
              所以評分只能從歐冠場次累積,一場都還沒踢就還沒有評分。踢過就會有。` : ''}`;
        })()}</div>
    </div>`;
}

function leagueTable(season) {
  const rows = season.table.rows;
  if (!rows.length) return '';
  return C.table(rows, [
    { key: 'position', label: '#', value: r => r.position, num: true },
    { key: 'team', label: '球隊', value: r => r.name, left: true,
      render: r => uclTeamCell({ name: r.name, code: r.code, league: r.league }) },
    { key: 'p', label: '賽', value: r => r.p, num: true },
    { key: 'w', label: '勝', value: r => r.w, num: true },
    { key: 'd', label: '和', value: r => r.d, num: true },
    { key: 'l', label: '負', value: r => r.l, num: true },
    { key: 'gf', label: '進', value: r => r.gf, num: true },
    { key: 'ga', label: '失', value: r => r.ga, num: true },
    { key: 'gd', label: '淨', value: r => r.gd, num: true, render: r => `${r.gd > 0 ? '+' : ''}${r.gd}` },
    { key: 'pts', label: '積分', value: r => r.pts, num: true, render: r => `<b>${r.pts}</b>` },
    { key: 'outcome', label: '結局', value: r => ['auto', 'playoff', 'out'].indexOf(r.outcome), left: true,
      title: '不是照名次推的,是看這一隊實際上出現在附加賽還是直接出現在十六強',
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
      render: r => uclTeamCell({ id: r.id, name: r.name, code: r.code, league: r.league }) },
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
        : r.champion
          ? '<span class="pill tiny" style="color:var(--win)">奪冠</span>'
          : '<span class="dim">—</span>') },
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

/* 歐冠視圖。原本是獨立的 page-ucl.js,2026-08-29 併進「盃賽」單頁
   (歐冠/足總盃/聯賽盃三個頁內分頁)—— 這裡只負責畫進 container,
   nav、page-head 與 foot 由盃賽頁統一管。ucl.html 保留為轉址,舊連結不斷。 */
export function renderUclView(app, { meta, clubs, teams, ucl, uclTeams, uclStandings = null, uclElo = null, uclDetails = null }) {
  standings = uclStandings;
  model = uclElo;
  details = uclDetails;
  /* **先登錄跨聯賽那一份,再登錄本聯賽的。** registerTeams 是逐欄位覆蓋,
     順序反過來的話,本聯賽比較完整的那筆(配色、球場、chartColor)
     會被只帶名字與隊徽的那筆蓋掉一部分。 */
  C.registerTeams(uclTeams?.teams ?? []); C.registerTeams(clubs); C.registerTeams(teams);
  externalCrest = new Map((uclTeams?.external ?? []).map(t => [t.id, t.crest]));

  const seasons = ucl?.seasons ?? [];
  if (!seasons.length) {
    app.innerHTML = `<div class="note">目前沒有歐冠資料。</div>`;
  } else {
    // 預設看最新一季**有比賽**的那一季 —— 停在一片空白的未來賽季很奇怪
    /* 預設停在**本季**(使用者要求)。以前是「第一個有踢過比賽的賽季」——
       本季開打前 played 是 0,就跳到上一季;但本季早就有整份賽程與倒數可看,
       點進來卻先看到去年的冠軍,像是資料沒更新。current 由 lib/ucl.mjs 標在最新一季。 */
    let label = (seasons.find(s => s.current) ?? seasons[0]).label;

    app.innerHTML = `
    <div style="margin-bottom:12px">
      <p class="small muted">歐洲冠軍聯賽的聯賽階段積分榜、淘汰賽結果與球員榜。跟聯賽不一樣的地方這一頁都照實顯示:
        <b>兩回合的總比分</b>、<b>延長賽</b>、<b>PK 大戰</b>,以及本站兩個聯賽的球隊各自走到了哪一輪。
        已完賽的兩季是<b>兩個獨立來源逐場核對過</b>的;進行中的那一季只有一個來源,
        沒得交叉核對。</p>
      ${C.stampRow([
        C.stamp('歐冠賽果', { iso: ucl.retrievedAt, kind: 'daily',
          note: 'football-data.org(賽果與官方積分榜)+ FotMob(球員榜與 2026-27 抽籤)' }),
      ])}
    </div>
    <div class="filters" style="align-items:end">
      ${seasons.map(s => `<button class="btn${s.label === label ? ' on' : ''}" data-season="${s.label}"
        >${s.label}${{ available: '', 'draw-only': '(已抽籤)' }[s.availability] ?? '(尚無資料)'}</button>`).join('')}
      <span class="dim small" id="uclCount"></span>
    </div>
    <div id="uclBody"></div>
    ${/* 這一段以前寫著「這一頁沒有勝率預測,這是刻意的」—— 階段 C(2026-09-09)之後就是假的:
          兩隊都有跨聯賽評分的場次有賽前勝率。「加了一個能力之後要回頭問:有哪一頁還在講我們沒有它」,
          這一頁自己就在講。數字不寫死,全部從產物讀。 */''}
    <div class="note info" style="margin-top:14px">
      <b>勝率只給兩隊都有跨聯賽評分的場次</b>${model?.model ? `(本季 ${(model.fixtures ?? []).length} 場)` : ''},
      用的是把八個聯賽的賽果與歐冠場次餵進同一個評分池的 Elo,走查回測通過才上
      ${model?.model ? `(${model.model.n} 場,改善 ${model.model.improvement} ± ${model.model.se})` : ''}。
      沒有評分的球隊(它們的聯賽本站不收賽果)那些場次<b>一場都不給</b>,不拿聯賽模型硬套 ——
      歐冠的<b>兩回合制</b>、<b>延長賽</b>與 <b>PK 大戰</b>模型也沒見過。
      已完賽的場次點「賽後報告」看球隊統計、事件、名單、逐人評分與射門圖${details?.count ? `(目前 ${details.count} 場)` : ''}。
      <a href="${C.link('model')}">模型驗證頁</a>寫著驗過什麼、沒驗過什麼。
    </div>
    <div class="note" style="margin-top:10px" id="uclCoverage"></div>`;

    /* 目前這一季「可以做對比」的場次,render 時重建。委派監聽只綁一次(見 render 裡的說明)。 */
    let cmpMatches = new Map();
    const bodyEl = app.querySelector('#uclBody');
    /* 輪次切換也走委派(理由同下:換賽季會把 body 整個換掉)。設定之後重畫整個 body ——
       leagueFixtures 讀 pickedMatchday,倒數與展開鈕的查表都在 render 裡重建,不用另外處理。 */
    bodyEl?.addEventListener('click', e => {
      const md = e.target.closest?.('[data-md]');
      if (!md) return;
      pickedMatchday = Number(md.dataset.md);
      render();
    });
    bodyEl?.addEventListener('click', async e => {
      const btn = e.target.closest?.('[data-cmp]');
      if (!btn) return;
      const key = btn.dataset.cmp;
      const slot = bodyEl.querySelector(`[data-cmp-slot="${CSS.escape(key)}"]`);
      const m = cmpMatches.get(key);
      if (!slot || !m) return;
      slot.hidden = !slot.hidden;
      const kind = btn.dataset.kind ?? expandKind(m);
      btn.textContent = slot.hidden ? OPEN_LABEL[kind] : CLOSE_LABEL[kind];
      // 只在第一次展開時才去抓 —— 收起再展開不用重畫
      if (!slot.hidden && !slot.dataset.done) {
        slot.dataset.done = '1';
        await (kind === 'post' ? renderPostMatch(slot, m) : renderCompare(slot, m));
      }
    });

    const render = () => {
      const s = seasons.find(x => x.label === label) ?? seasons[0];
      const body = app.querySelector('#uclBody');
      const count = app.querySelector('#uclCount');
      const cov = app.querySelector('#uclCoverage');

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
      const detSeason = details?.seasons?.[s.label] ?? null;
      count.textContent = `${s.total} 場・完賽 ${s.played}・${s.teams} 隊・延長 ${s.aet}・PK ${s.shootouts}`
        + (detSeason ? `・賽後報告 ${detSeason.reports} 場` : '');
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
        ${leagueFixtures(s)}
        <div class="section"><h2>聯賽階段</h2>
          <span class="hint">36 隊各打 8 場・名次${s.table.order === 'official' ? '取自資料源官方積分榜' : '由本站依賽果排出'}・這是最早的階段,所以排在淘汰賽下面</span></div>
        <div id="tbl"></div>
        ${!s.outcomesKnown ? `<div class="tiny dim" style="margin-top:8px">
          尚未從實際淘汰賽參賽名單確認晉級區間；目前不預先判定各隊結局。</div>`
          : s.bandBroken ? `<div class="note" style="margin-top:8px;color:var(--loss)">
          ⚠ 三段結局的名次不連續 —— 賽制可能改了,或資料有問題,這張表的分段先不要當定論。</div>`
          : `<div class="tiny dim" style="margin-top:8px">
          第 ${s.bands.auto?.from}–${s.bands.auto?.to} 名直接進十六強・
          第 ${s.bands.playoff?.from}–${s.bands.playoff?.to} 名打附加賽・
          第 ${s.bands.out?.from}–${s.bands.out?.to} 名止步於此。
          <b>這三段不是照名次推的</b>,是看每一隊實際上出現在附加賽還是直接出現在十六強 ——
          推出來之後名次剛好連續,兩季都是。</div>`}
        ${leaderBoards(s)}`;

      const runsEl = app.querySelector('#runs');
      if (runsEl) runsEl.innerHTML = runsTable(s.runs);
      app.querySelector('#tbl').innerHTML = leagueTable(s);
      /* 賽程表裡的倒數要走起來。`startCountdowns` 自己會收掉上一個計時器,
         所以換賽季重畫時再叫一次是安全的(不會疊出兩個)。 */
      C.startCountdowns();

      /* 賽前對比的展開鈕。**監聽掛在 #uclBody 這個容器上,不掛在按鈕上** ——
         換賽季會把 body.innerHTML 整個換掉,掛在按鈕上的監聽會跟著沒了,
         而容器本身活著,所以委派只要綁一次(這裡每次 render 都重綁會疊)。
         用 el.hidden 切換,不用 style.display。 */
      /* **條件要跟畫按鈕的那一個一樣**(expandable,不是 comparable)——
         不一樣的話會出現「按鈕在但點了沒東西」,而且不會報錯。 */
      cmpMatches = new Map(allMatchesOf(s).filter(expandable)
        .map(m => [String(m.id ?? `${m.home.code}|${m.away.code}`), m]));

      const unknown = s.teamsTotal - s.teamsKnown;
      cov.innerHTML = `
        <b>球隊涵蓋率:${s.teamsKnown} / ${s.teamsTotal} 支有本站資料。</b>
        歐冠有全歐洲的球隊,而本站有球隊頁的只有英超、西甲與英冠的球隊 —— 這一季有 ${unknown} 支球隊本站沒有,
        它們照樣出現在賽程與積分榜裡,但<b>只有名字,沒有隊徽也點不進去</b>。
        不替它們編一個隊碼或找一張像的隊徽,那會讓讀者以為本站有它們的資料。
        <div style="margin-top:6px" class="tiny dim">
          另一個聯賽的球隊(例如在英超頁看到的皇馬)有連結、但沒有隊徽 ——
          隊徽是按聯賽打包的,這一頁只端得出目前這個聯賽那一份。點進去會切到對的聯賽。
        </div>
        ${/* 賽後報告的涵蓋率(鐵則四):有幾場、缺幾場、為什麼缺,全部從索引讀。
             「還沒抓到」跟「拒收」是兩句不同的話 —— 拒收代表兩個來源的比分對不上,那一場整場不採用。 */''}
        ${detSeason ? `<div style="margin-top:6px">
          <b>賽後報告:${detSeason.reports} / ${detSeason.played} 場已完賽有</b>(FotMob 逐場詳情,比分跟 football-data.org 核對過才收)。
          ${(() => {
            /* 缺的場次分三種,各有各的原因,一句「還沒抓到」會把永遠抓不到的講成還在等:
               rejected(讀取器:兩個來源比分對不上)、incomplete(供應商缺欄位)、attempts(抓取器退回:
               FotMob 標未完賽 / 賽程找不到 / 比分不符,30 分鐘後會再試)。 */
            const mine = list => (list ?? []).filter(r => String(r.key).startsWith(`${s.label}|`));
            const rej = mine(details.rejected), inc = mine(details.incomplete), att = mine(details.attempts);
            const missing = detSeason.played - detSeason.reports;
            if (missing <= 0) return '';
            const parts = [];
            if (rej.length) parts.push(`兩個來源比分對不上而<b>整場不採用</b>的 ${rej.length} 場`);
            if (inc.length) parts.push(`供應商資料不完整的 ${inc.length} 場`);
            if (att.length) parts.push(`抓取器退回的 ${att.length} 場(${C.esc([...new Set(att.map(a => a.reason))].slice(0, 3).join('、'))};退回過的 30 分鐘後再試)`);
            const rest = missing - rej.length - inc.length - att.length;
            if (rest > 0) parts.push(`${rest} 場還沒抓到(每次部署補最多 39 場,比賽日迴圈踢完就補;往季要手動回填)`);
            return `其餘 ${missing} 場:${parts.join('、')}。`;
          })()}
          ${details.retrievedAt ? `<span class="dim tiny">最後抓取 ${C.esc(String(details.retrievedAt).slice(0, 16).replace('T', ' '))} UTC</span>` : ''}
        </div>` : ''}
        ${/* 第二來源分兩種(kind):抽籤檔只核配對(賽季前交付,沒有日期與比分);有比分的檔才逐場核對。
             以前不分,本季整季印著「核對沒過(138 處)」—— 講的是真話,但讀者會以為賽果有問題。 */''}
        ${s.crossCheck ? `<div style="margin-top:6px">
          ${s.crossCheck.kind === 'draw'
            ? (s.crossCheck.passed
              ? `<b style="color:var(--win)">✔ 抽籤對照通過。</b>
                 這一季的第二來源是賽季前的 ${C.esc(s.crossCheck.source)} 抽籤檔,只有「誰對誰、誰主誰客」——
                 沒有日期也沒有比分,所以只核對那一層:隊名 ${s.crossCheck.teamsMatched}/${s.crossCheck.teamsTotal} 對上、
                 <b>${s.crossCheck.aligned}/${s.crossCheck.total} 組對戰與主客方向完全一致</b>。
                 賽果那一層的第二來源是 FotMob 的逐場詳情(上面「賽後報告」那段:比分逐場核對過才收)。`
              : `<b style="color:var(--loss)">⚠ 抽籤對照沒過(${s.crossCheck.problemCount + (s.crossCheck.extra ?? 0)} 處)。</b>
                 ${s.crossCheck.problems.slice(0, 3).map(p => C.esc(p.text)).join('、')}${
                   s.crossCheck.extra ? `、主來源多出 ${s.crossCheck.extra} 組抽籤檔沒有的對戰` : ''}
                 —— 畫面顯示的是主來源(football-data.org)。`)
            : s.crossCheck.passed
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
        ${/* **上游時差要講出來(鐵則四)。** 資料源同一份 payload 裡,比賽結果先更新、
             官方積分榜晚幾小時 —— 比賽夜看這張表會看到「剛贏球的隊還是 0 分」,
             而那不是我們算錯,也不是他們錯,是這一格還沒算進去。
             不講的話讀者只會看到一張自己跟賽果矛盾的表。 */''}
        ${(s.table.pending ?? []).length ? `<div style="margin-top:6px;color:var(--draw)">
          ⚠ <b>資料源的官方積分榜還沒把最新場次算進去</b>(${s.table.pending.length} 隊):
          ${C.esc(s.table.pending.slice(0, 4).map(x => `${x.team}(本站 ${x.ours} 場、官方 ${x.official} 場)`).join('、'))}${
            s.table.pending.length > 4 ? ' 等' : ''}。
          <b>名次與積分顯示的是官方那份</b>,所以剛踢完的比賽還沒反映上去 ——
          上面的賽程區才是最新的賽果。這是資料源自己的時差(比賽結果先更新、積分榜晚幾小時),
          下一次抓取就會補上。</div>` : ''}
        ${ucl.teamCodeConflicts?.length ? `<div style="margin-top:6px;color:var(--loss)">
          ⚠ 有隊名對到同一個隊碼,已整組不對應:
          ${ucl.teamCodeConflicts.map(c => C.esc(c.conflicts.map(x => `${x.code}=${x.teams.join('/')}`).join('、'))).join('、')}</div>` : ''}`;
    };

    app.querySelectorAll('[data-season]').forEach(b => {
      b.onclick = () => {
        label = b.dataset.season;
        pickedMatchday = null;   // 上一季選的輪次不帶到這一季
        app.querySelectorAll('[data-season]').forEach(x => x.classList.toggle('on', x === b));
        render();
      };
    });
    render();
  }
}
