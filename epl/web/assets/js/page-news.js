import * as C from './core.js?v=fe58cbcb';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, news } = await C.load('meta', 'clubs', 'teams', 'news');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const cats = [...new Set(news.map(n => n.cat))];
  /* 一則外電可能講到兩隊(轉會新聞很常見),所以球隊清單與篩選都要看
     teams 陣列;team 只是「標題主詞」那一支,拿它當唯一依據的話,
     用第二支球隊去篩就會篩不到自己明明有提到的新聞。 */
  const teamsOf = n => (n.teams?.length ? n.teams : (n.team ? [n.team] : []));
  const codes = [...new Set(news.flatMap(teamsOf))].sort((a, b) => C.name(a).localeCompare(C.name(b), 'zh-Hant'));
  const CLS = { 傷停: 'bad', 禁賽: 'bad', 轉會: 'info', 賽前: 'info', 賽程: 'warn', 數據: 'accent', 戰術: 'accent', 陣容: '', 外電: 'warn', 西甲外電: 'warn', 賽報: 'accent', 轉會外電: 'info' };

  /* 人工整理的外電有三件事一定要標出來,不然讀者分不出這是什麼(鐵則四):

     一、**它不是機器翻譯。** 中文摘要是人寫的。掛上「機器翻譯」標記等於講一件假的事,
        所以這一類走自己的標記,而且 titleZh / bodyZh 一律不用。
     二、**摘要裡的比分有沒有跟本站賽果對過。** 對過就說對過;
        本站沒有那一輪的資料(例如歐冠附加賽)就說無法核對 ——
        不要讓讀者以為所有數字都驗證過。
     三、**傳聞不是已確認的交易。** 來源檔自己帶 status,那個區別要一路傳到畫面上。 */
  const CHECK = {
    verified: { cls: 'ok', text: '比分已與本站賽果逐場核對' },
    unverified: { cls: 'warn', text: '本站沒有這一輪的資料,比分無法核對' },
    none: null,
  };
  const curatedMarks = n => {
    if (!n.curated) return '';
    const c = CHECK[n.scoreCheck] ?? null;
    return `<div class="tiny dim" style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <span class="pill tiny">人工整理摘要</span>
      ${n.competition === 'ucl' ? '<span class="pill tiny accent">歐冠</span>' : ''}
      ${c ? `<span class="pill tiny ${c.cls}">${c.text}</span>` : ''}
      ${n.statusLabel ? `<span class="pill tiny ${n.statusTone ?? ''}">${C.esc(n.statusLabel)}</span>` : ''}
      <span>中文摘要為人工整理,<b>不是機器翻譯、也不是原文照抄</b>;完整內容以原文為準。</span>
    </div>`;
  };
  /* 人工整理外電是**一次一批交付**的,不是每天都有人整理。
     所以「涵蓋 8/22~9/30」這種寫法會騙人 —— 中間可能只有兩個週末有交付。
     實際收了哪幾段、中間斷在哪裡,兩件都要講(鐵則四)。 */
  const coverageNote = () => {
    const c = meta.curatedNews;
    if (!c || !c.ranges?.length) return '';
    const fmt = r => `${C.dateFull(r.from)} ~ ${C.dateFull(r.to)}`;
    /* 檔案庫是跨聯賽的一份(英超、西甲、歐冠都在裡面),
       這一頁只顯示屬於本聯賽 + 歐冠的那些。
       只印檔案庫總數的話,「共 14 則」旁邊卻只有 5 張卡片 —— 讀者會以為壞了。 */
    const here = news.filter(n => n.curated).length;
    return `<div class="note small" style="margin-top:8px">
      <b>人工整理外電的涵蓋範圍</b>:本頁 ${here} 則(檔案庫累計 ${c.stories} 則,含另一個聯賽的),
      ${c.deliveries} 次整理,累計 ${c.days} 天。
      ${c.ranges.map(fmt).join('、')}。
      ${c.gaps.length
        ? `<b style="color:var(--draw)">中間有 ${c.gaps.length} 段沒有人整理</b>:${c.gaps.map(fmt).join('、')} ——
           那幾天不是沒有新聞,是本站沒有收;不要當成「這段期間沒事發生」。`
        : '這段期間沒有斷檔。'}
      ${c.keepDays ? `舊的保留 ${c.keepDays} 天,之後自動淘汰。` : ''}
    </div>`;
  };

  let cat = '';

  app.innerHTML = `
  <div class="page-head">
    <h1>動態</h1>
    ${/* 開場白講的是「這一頁的東西從哪來」,而每個聯賽的來源不一樣。
          原本是「是不是西甲」的二元式,英冠進來會套用英超那段 ——
          那段宣稱有 FPL 傷停轉會、賽前看點、上季 380 場的戰術敘事,
          **英冠一樣都沒有**,只有外部 RSS。判斷改看資料本身有沒有那種東西。 */''}
    <p>${meta.league === 'es1'
      ? `西甲目前顯示 The Guardian La Liga 與 BBC Sport 關鍵字篩選後的外電；每日台北時間 10:00 快取一次，只保存短摘要與原文連結，不抓全文。${
          news.some(n => n.titleZh)
            ? `標題與摘要為<b>${news.some(n => n.titleZh && !n.translatedByHuman) ? '機器翻譯' : '人工翻譯'}</b>,原文保留在旁邊 —— 翻譯只做語言轉換,不摘要、不補背景,數字與人名隊名照原文。`
            : '目前顯示原文(尚未產生譯文)。'}`
      : meta.capabilities?.players === false
      ? `這一頁<b>只有外部新聞 RSS</b>:${[...new Set(news.map(n => n.source))].join('、')}。
         每日快取一次,只保存標題、短摘要與原文連結,不抓全文,也不做翻譯。
         <b>沒有</b>傷停、轉會、賽前看點與戰術敘事 —— 那些要靠球員級資料,
         而${C.LEAGUES[C.league()]?.zh ?? '這個聯賽'}沒有免費的來源(實測過)。
         來源自己歸錯類的項目會混進來(例如英超的轉會快訊),我們<b>不用關鍵字去殺</b> ——
         那會誤傷真文章。`
      : '三種來源:<b>傷停與轉會</b>來自 FPL 官方欄位(含更新日期,是真的即時資料); <b>賽前看點</b>由預測模型自動生成;<b>數據 / 戰術 / 陣容</b>則是從上季 380 場比賽跑出來的敘事。外部新聞 RSS 可由 <span class="mono">scripts/fetch-news.mjs</span> 更新。'}
      ${news.some(n => n.curated) ? '<br><b>賽報 / 外電 / 轉會外電</b>是<b>人工整理</b>的外電摘要,每一則都帶原文連結;摘要裡引用的比分<b>每次建置都會拿本站賽果重新核對</b>,對不上的整則不出。轉會項目會標明是<b>已確認</b>還是<b>媒體報導</b>。' : ''}</p>
    ${coverageNote()}
    ${C.stampRow([
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算；本機同步後再手動發布' }),
    ])}
  </div>
  <div class="filters">
    <button class="btn on" data-c="">全部</button>
    ${cats.map(c => `<button class="btn" data-c="${c}">${c}</button>`).join('')}
    <select id="fTeam"><option value="">所有球隊</option>${codes.map(c => `<option value="${c}">${C.name(c)}</option>`).join('')}</select>
    <span class="dim small" id="count"></span>
  </div>
  <div id="feed" class="grid" style="gap:10px"></div>
  ${C.foot(meta)}`;

  const render = () => {
    const t = document.getElementById('fTeam').value;
    const rows = news.filter(n => (!cat || n.cat === cat) && (!t || teamsOf(n).includes(t)));
    document.getElementById('count').textContent = `共 ${rows.length} 則`;
    document.getElementById('feed').innerHTML = rows.map(n => `
      <div class="card" style="padding:12px 14px">
        <div class="row" style="gap:8px">
          <span class="pill ${CLS[n.cat] ?? ''}">${n.cat}</span>
          <span class="dim tiny mono">${C.dateFull(n.date)}</span>
          ${n.team ? C.teamCell(n.team) : ''}
        </div>
        <div style="font-weight:700;margin-top:6px">${C.esc(n.titleZh ?? n.title)}</div>
        ${n.titleZh ? `<div class="tiny dim" style="margin-top:2px" lang="en">${C.esc(n.title)}</div>` : ''}
        <div class="small muted" style="margin-top:5px">${C.esc(n.bodyZh ?? n.body)}</div>
        ${/* 機器翻譯一定要標,而且原文要留著讓人自己對照(鐵則四)。
              沒有譯文時整個標記不出現 —— 不要留一個「未翻譯」的空欄位。 */''}
        ${curatedMarks(n)}
        ${n.titleZh ? `<div class="tiny dim" style="margin-top:5px">
          <span class="pill tiny warn">${n.translatedByHuman ? '人工翻譯' : '機器翻譯'}</span>
          只翻譯不改寫,數字與人名隊名保留原文;上方灰字是原文標題,可點下方連結看全文。</div>` : ''}
        ${n.fixtureId ? `<div class="small" style="margin-top:6px"><a href="${C.link('index', { id: n.fixtureId })}">看這場的完整分析 →</a></div>` : ''}
        ${C.safeUrl(n.link) ? `<div class="small" style="margin-top:6px"><a href="${C.esc(C.safeUrl(n.link))}" target="_blank" rel="noopener">${C.esc(n.source ?? '原文')} →</a></div>` : ''}
      </div>`).join('') || '<div class="note">沒有符合條件的動態。</div>';
  };

  document.querySelectorAll('[data-c]').forEach(b => {
    b.onclick = () => {
      cat = b.dataset.c;
      document.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', x === b));
      render();
    };
  });
  document.getElementById('fTeam').onchange = render;
  render();

} catch (err) { C.fail(err); }
