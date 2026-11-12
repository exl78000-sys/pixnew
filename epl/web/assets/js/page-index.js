import * as C from './core.js?v=1404e5d4';
import { mountFixtureList } from './fixture-list.js?v=d61c91a9';
import { followedIn, bindFollowStars, followStar } from './follow.js?v=02130043';
import { mountLiveBoard } from './live-board.js?v=cb19647f';
import { renderNewsView } from './news-view.js?v=295a93f8';

const app = document.getElementById('app');

try {
  /* **導覽列與頁首先畫,不等資料**(2026-09-26,B3)。量過正式站:首頁冷載 8 秒才有東西,而導覽列、
     頁首那段話、資料界線、模型說明只要 meta 就畫得出來 —— meta / clubs / teams 三份 HTML 的預載 script
     已經在抓(stamp-assets 注入的那一段)。所以分兩段:先用這三份把整頁的框畫好、要等賽程 / 動態的
     區塊放骨架(骨架上不寫任何數字),第二段資料到了再填那幾塊。 */
  C.nav();
  const { meta, clubs, teams } = await C.load('meta', 'clubs', 'teams');
  C.registerTeams(clubs);
  C.registerTeams(teams);

  const bt = meta.model.backtest ?? { available: false };
  /* 頁首那段話原本是「西甲 or 英超」二選一寫死在這裡(`edition === 'basic'`)。
     加第三個聯賽時它就撞上了:英冠沒有 edition → 走英超那句 → 宣稱一堆本站沒有的東西。
     現在**每個聯賽的文案由自己的 build 寫**(meta.intro),這裡只剩英超那一句 ——
     英超的產物還沒有 intro 欄位,所以留著當預設;哪天補上,這一行也可以拿掉。 */
  const intro = meta.intro
    ?? `把 ${meta.historySeasons?.join('、') ?? '過往賽季'} 的每一場比賽、每一位球員的進階數據跑成模型，做出本季 ${meta.currentSeason} 的積分預測、單場勝負機率、戰術剖析與傷停動態。所有數字都可以往下追到原始資料，沒有一項是拍腦袋填的。`;

  /* 四格數字卡(本季進度 / 模型準度 / 命中率 / 傷停)拿掉了(2026-11-07,跟實時戰況合併成一頁時)——
     進度在下面的開賽倒數與積分榜、準度在頁底「模型是怎麼算的」與模型驗證頁,傷停在動態頁;
     同一頁講兩次的東西,在手機上是整整一個螢幕的高度。 */

  /* ── 你的球隊(2026-09-14)──────────────────
     關注的那幾支收成一張卡,釘在賽程表上方。**積分榜的順序一個字都不動** ——
     那張表的順序就是名次,把關注的搬上去會讓第 14 名出現在第一列(標記在 sim-table 做,只標色)。
     一支都沒關注時整張卡不畫:空卡片比沒有卡片更讓人以為壞了(鐵則三)。 */
  let fixturesAll = null;   // 第二段才有;卡片在那之後才畫
  function myTeamsCard() {
    const mine = followedIn(C.league());
    if (!mine.size || !fixturesAll) return '';
    const rows = teams.filter(t => mine.has(t.code));
    if (!rows.length) return '';
    const nextOf = code => {
      const un = fixturesAll.filter(f => !f.played && (f.home === code || f.away === code));
      if (!un.length) return null;
      // 排序用開球時間,沒有時間的排最後(上游是逐月公布的,不能拿它當篩選條件)
      const key = f => f.kickoff ?? `${f.date ?? '9999-99-99'}T99:99`;
      return un.sort((a, b) => String(key(a)).localeCompare(String(key(b))))[0];
    };
    return `<div class="card" style="margin-top:16px">
      <div class="spread"><h2 style="margin:0">你的球隊</h2>
        <a class="small" href="${C.link('predict', { view: 'teams' })}">我的球隊 →</a></div>
      <div style="display:grid;gap:8px;margin-top:10px">
        ${rows.map(t => {
          const c = t.current, f = nextOf(t.code);
          const home = f ? f.home === t.code : null;
          const opp = f ? (home ? f.away : f.home) : null;
          return `<div class="stat-line">
            <span class="small" style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
              ${followStar(C.league(), t.code)}${C.teamCell(t.code)}
              ${c ? `<span class="dim">第 ${c.pos} 名・${c.pts} 分</span>${C.formRun(c.form)}` : ''}</span>
            <span class="tiny" style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
              ${f ? `<span class="dim">下一場</span><span class="pill tiny">${home ? '主' : '客'}</span>
                    ${C.badge(opp)} ${C.esc(C.name(opp))}
                    ${f.kickoff ? `<span class="cd" data-kickoff="${f.kickoff}"></span>` : '<span class="dim">時間待定</span>'}
                    <a href="${C.link('analysis', { id: f.id })}">分析 →</a>`
                : '<span class="dim">賽程上沒有還沒踢的場次</span>'}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  app.innerHTML = `
  <div class="page-head">
    <h1>${C.LEAGUES[C.league()]?.zh ?? ''}首頁</h1>
    <p>${intro}</p>
    ${C.stampRow([
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算；本機同步後再手動發布' }),
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
      meta.live?.available ? C.stamp('即時比分', { iso: meta.live.fetchedAt, kind: 'live', note: '來源:' + meta.live.sourceLabel }) : null,
    ])}
  </div>

  <div id="myTeams"></div>

  ${/* 比賽現況 + 積分榜(2026-11-07,原實時戰況頁;live-board.js)。
        「接下來的比賽」那張卡拿掉了 —— 它跟開賽倒數講同一件事;動態搬到頁底。 */''}
  <a id="live" aria-hidden="true"></a>
  <div id="liveBoard">${C.skel(4)}</div>

  ${/* 賽程表原本是獨立的一頁。分成兩頁的話,讀者看完積分榜想看下一輪對誰,
        要再點一次而且整頁重載;而兩頁的頁首、時效標籤、模型說明本來就講同一件事,
        等於同一段話維護兩份。合併之後這一頁就是「這個賽季的全部」。 */''}
  <div class="section" id="allFixtures"><h2>完整賽程與預測</h2>
    <span class="hint">點任一場看單場分析・${C.tzName()}</span></div>
  <div id="fixturesBlock">${C.skel(6)}</div>

  ${/* 「目前資料界線」**只有一條路**(2026-09-12)。原本是兩張卡片:西甲那張整段寫死在這裡
        (連 reports.count 都在前端算),其他聯賽讀 meta.boundaries。所以同一塊內容有兩份,
        而且前端得知道「哪個聯賽有什麼」—— 那正是加英冠時撞到的問題(英冠沒有 edition,
        兩張卡片都不出現過)。西甲的每一行已經搬進 build-laliga.mjs 的 meta.boundaries,
        跟英冠同一個做法。這裡只負責畫,一行都不知道是哪個聯賽。 */''}
  ${/* 動態、資料界線、模型說明收進頁底的摺疊(2026-11-07 合併時):
        它們是「想知道才打開」的東西,常駐的話手機上要捲過三張卡才到頁尾 —— 標題留著,一點就開。 */''}
  ${/* 動態(2026-11-07 起是完整的那一份,原本的動態頁併進來;news-view.js):類別、球隊、只看我的球隊照舊,
        一次畫 12 則、「再顯示」往下加。仍然收在摺疊裡 —— 它是想看才打開的東西;news.html 轉址過來時自動打開。 */''}
  <details class="card fold-card" id="news" style="margin-top:20px">
    <summary><h2>動態</h2><span class="hint" id="newsHint">傷停、轉會與外電</span></summary>
    <div id="newsBody" style="margin-top:8px">${'<div class="skel line"></div>'.repeat(4)}</div>
  </details>

  ${meta.boundaries?.length ? `<details class="card fold-card" style="margin-top:12px">
      <summary><h2>目前資料界線</h2><span class="hint">這個聯賽做得到與做不到的</span></summary>
      <div class="small muted" style="display:grid;gap:8px">
        ${meta.boundaries.map(x => `<div${x.startsWith('—') ? ' class="dim"' : ''}>${C.esc(x)}</div>`).join('')}
      </div>
    </details>` : ''}

  ${/* 「上季最終戰績」2026-09-03 搬到球隊頁(使用者要求)——
       它講的是每一隊上季怎麼樣,而首頁已經有本季積分榜與賽程。 */''}
  <details class="card fold-card" style="margin-top:12px">
    <summary><h2>模型是怎麼算的</h2><span class="hint">${bt.available ? `走查回測 RPS ${bt.rps}・命中率 ${C.pct(bt.hitRate, 1)}` : '還沒有走查回測'}</span></summary>
    <div class="small muted" style="display:grid;gap:6px">
      <div><b class="mono">${meta.model.type}</b> — 每支球隊各有進攻強度與防守強度,加上主場優勢
        (${meta.model.homeAdvantage}× 進球)與低比分修正 ρ=${meta.model.rho};
        近期比賽權重較高(時間衰減 ξ=${meta.model.decayXi})。</div>
      ${bt.available ? `<div>回測方式:重跑上季 ${meta.competition?.roundsPerSeason ?? 38} 輪,每一輪都只用「開賽前」的資料建模再預測,避免偷看未來。
        採用值 RPS ${bt.rps} / LogLoss ${bt.logLoss} / 命中率 ${C.pct(bt.hitRate)};
        單獨用 Poisson 是 ${bt.models.poisson.rps}、單獨用 Elo 是 ${bt.models.elo.rps}、
        固定機率基準線是 ${bt.models.baseline.rps} —— 兩者平均最好,所以平台採用平均值。</div>`
        : '<div class="dim">這個聯賽還沒有走查回測結果,所以這一頁不給準度數字 —— 給了就是假的。</div>'}
      ${/* caveats **一律當純文字**。以前這裡直接插入、而模型頁走 esc(),
            兩個渲染路徑對同一份資料的處理不一樣 —— 於是同一句話在一頁是粗體、
            在另一頁印出 <b>。實際結果是兩邊都在印星號(英冠那條寫了 `**強調**`,
            而前端沒有 Markdown 處理器)。統一走 esc(),契約就只有一條:純文字。 */''}
      ${meta.model.caveats.map(c => `<div class="dim">・${C.esc(c)}</div>`).join('')}
    </div>
  </details>
  ${C.foot(meta)}`;

  /* ── 第二段:賽程、動態、往季賽果與報告索引到了,填那幾塊 ────────────
     live / table / sim 是 2026-11-07 跟實時戰況合併時加回來的:比賽現況要即時快照,
     兩張積分榜(目前 / 預測)要 table 與 sim。 */
  /* 第一次畫面讀 live-lite(2026-11-12):整份 live.json 每踢完一場多 41 KB 的 advanced(報告抽屜才用),一輪踢完 678 KB ——
     11-07 把實時戰況併進這一頁時載的是整份,11-08 那一輪踢完首頁就超過 1.5 MB 的資料預算,部署連紅九輪。
     卡片只用比分、分鐘、勝率與進球者,瘦版都有;畫完之後 live-board 照舊走 feed 覆蓋(那一份是整份),抽屜要 advanced 時自己補抓。
     跟單場頁 2026-09-27 的做法同一條。 */
  const { fixtures, news, results, reports, analysis, 'live-lite': live, table, sim } =
    await C.load('fixtures', 'news', 'results', 'reports', 'analysis', 'live-lite', 'table', 'sim');
  fixturesAll = fixtures;

  /* 比賽現況與積分榜(原實時戰況頁):輪詢、先畫再覆蓋、走鐘都在 live-board.js 裡 */
  mountLiveBoard(document.getElementById('liveBoard'), { meta, fixtures, table, sim, teams, analysis, live });

  /* 動態(完整那一份,原動態頁) */
  renderNewsView(document.getElementById('newsBody'), { meta, news });
  {
    const by = {};
    for (const n of news) by[n.cat] = (by[n.cat] ?? 0) + 1;
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, k]) => `${C.esc(c)} ${k}`).join('・');
    document.getElementById('newsHint').innerHTML = news.length ? `共 ${news.length} 則・${top}` : '目前沒有動態';
  }

  document.getElementById('myTeams').innerHTML = myTeamsCard();

  /* ── 賽程表(原 page-fixtures.js)── 篩選器要賽程與往季賽果才組得出來,所以放第二段 */
  const pastSeasons = [...new Set(results.map(m => m.season))].filter(x => x !== meta.currentSeason).sort().reverse();
  const rounds = [...new Set(fixtures.map(f => f.round))].sort((a, b) => a - b);
  const codes = [...new Set(fixtures.flatMap(f => [f.home, f.away]))]
    .sort((a, b) => C.name(a).localeCompare(C.name(b), 'zh-Hant'));
  const nextRoundNo = fixtures.find(f => !f.played && f.date >= meta.asOf)?.round ?? rounds[0];
  document.getElementById('fixturesBlock').innerHTML = `
  <div class="filters">
    <label>賽季</label><select id="fSeason">
      <option value="${meta.currentSeason}">${meta.currentSeason}(本季・預測)</option>
      ${pastSeasons.map(x => `<option value="${x}">${x}(已完賽)</option>`).join('')}</select>
    <label>輪次</label><select id="fRound"><option value="">全部</option>
      ${rounds.map(r => `<option value="${r}" ${r === nextRoundNo ? 'selected' : ''}>第 ${r} 輪</option>`).join('')}</select>
    <label>球隊</label><select id="fTeam"><option value="">全部</option>
      ${codes.map(c => `<option value="${c}">${C.name(c)}</option>`).join('')}</select>
    <label>狀態</label><select id="fState">
      <option value="">全部</option><option value="未賽">未賽</option><option value="已賽">已賽</option></select>
    <span class="dim small" id="fxCount"></span>
  </div>
  <div id="fixtureList"></div>`;

  C.startCountdowns();

  /* 賽程表(共用模組,原 page-fixtures.js) */
  mountFixtureList({ meta, teams, fixtures, results, reports, analysis });

  /* 取消關注時這張卡要跟著變(可能整張消失),所以只重畫這一塊 ——
     整頁重畫會把賽程表的篩選與捲動位置一起丟掉。倒數計時重新起算。 */
  bindFollowStars(document.getElementById('myTeams'), () => {
    document.getElementById('myTeams').innerHTML = myTeamsCard();
    C.startCountdowns();
  });

  /* 上季積分榜搬到球隊頁了(2026-09-03)—— 這裡不再渲染。 */

  /* 從轉址來的(news.html → #news、live.html → #live):頁面是分兩段畫的,瀏覽器自己的錨點捲動發生在第一段,
     那時下面的區塊還是骨架、高度不對 —— 所以第二段畫完再捲一次。動態在摺疊裡,先打開。
     單檔版的錨點是 ?at=(見 core 的 anchorLink)。 */
  const at = C.anchorTarget();
  const target = at && /^[a-z]+$/.test(at) ? document.getElementById(at) : null;
  if (target) {
    if (target.tagName === 'DETAILS') target.open = true;
    /* 比賽現況與積分榜在這之後還會長(隊徽、即時快照覆蓋)—— 捲一次的話,實測動態區被推到視窗上方 900px 外。
       所以版面還在變的頭幾秒,每變一次就再對齊一次;讀者自己動了(捲、點、按鍵)就放手,不跟他搶。 */
    const pin = () => target.scrollIntoView({ block: 'start' });
    pin();
    const ro = new ResizeObserver(pin);
    ro.observe(app);
    const USER = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    const stop = () => { ro.disconnect(); USER.forEach(ev => removeEventListener(ev, stop)); };
    USER.forEach(ev => addEventListener(ev, stop, { passive: true }));
    setTimeout(stop, 4000);
  }

} catch (err) { C.fail(err); }
