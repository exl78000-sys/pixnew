import * as C from './core.js?v=660e256d';
import { renderKnowledge } from './knowledge-view.js?v=37e3fd4b';
import { renderAllPlayers } from './allplayers-view.js?v=086518a3';
import { renderGame } from './game-view.js?v=a5b3f8a1';

/* 探索(2026-09-03)。足球知識、對戰模擬、球員搜尋收成一頁,三個頁內分頁。
 *
 * 為什麼併:這三個都是**跨聯賽**的東西,而導覽列上原本各佔一格 ——
 * 加上總覽、盃賽、我的預測,跨聯賽那一組就有六格。手機上那一列本來就要橫向捲,
 * 六格等於「看得到的永遠只有一半」。
 *
 * 做法跟歐冠併進盃賽時**完全一樣**:內容抽成 `*-view.js` 的 render 函式,
 * 這一頁只負責分頁與容器;原本的 `knowledge.html` / `duel.html` /
 * `allplayers.html` **保留為轉址**,舊連結與書籤不斷。
 *
 * 兩個實作上的細節:
 *
 * 1. **每個 view 自己拿一個乾淨的容器。** 那三個模組原本是整頁的主人
 *    (`app.innerHTML = ...`),直接讓它們寫進這一頁的 `#app` 會把分頁列也蓋掉。
 *    所以這裡給它們一個內層 div。
 * 2. **換分頁要收掉上一頁的計時器。** 對戰模擬有 rAF 迴圈與 `pageInterval`,
 *    不收的話換到別的分頁它還在背景跑(單檔版的 hash 路由踩過同一個坑:
 *    上一頁的計時器活下來,30 秒後把畫面蓋掉)。
 */

const VIEWS = [
  { key: 'knowledge', zh: '足球知識', render: renderKnowledge },
  /* 模擬遊玩(2026-09-03)取代了對戰模擬;view 鍵留 duel,舊書籤不斷 */
  { key: 'duel', zh: '模擬遊玩', render: renderGame },
  { key: 'allplayers', zh: '球員搜尋', render: renderAllPlayers },
];

const app = document.getElementById('app');

try {
  C.nav();
  const asked = C.qs('view');
  let cur = VIEWS.some(v => v.key === asked) ? asked : VIEWS[0].key;

  app.innerHTML = `
    <div class="filters" id="exploreTabs">
      ${VIEWS.map(v => `<button class="btn${v.key === cur ? ' on' : ''}" type="button"
        data-view="${v.key}">${C.esc(v.zh)}</button>`).join('')}
    </div>
    <div id="exploreBody"><div class="loading">載入資料中…</div></div>`;

  const body = document.getElementById('exploreBody');

  async function show(key) {
    const v = VIEWS.find(x => x.key === key);
    if (!v) return;
    cur = key;
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === key));
    /* 換分頁前先收計時器。對戰模擬的 rAF 與倒數都是 pageInterval 註冊的,
       留著的話它在背景繼續跑 —— 而且下一次進來會再註冊一份。 */
    C.clearPageTimers();
    body.innerHTML = '<div class="loading">載入資料中…</div>';
    /* 網址跟著換,重新整理與分享連結才會回到同一個分頁。
       用 replaceState 不是 pushState —— 上一頁應該回到上一個**頁面**,
       不是在這一頁的三個分頁之間倒退。 */
    const url = new URL(location.href);
    url.searchParams.set('view', key);
    history.replaceState(null, '', url);
    try { await v.render(body); } catch (err) { C.fail(err); }
  }

  document.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => show(b.dataset.view); });
  await show(cur);
} catch (err) { C.fail(err); }
