import * as C from './core.js?v=95f7e756';
import { renderKnowledge } from './knowledge-view.js?v=5ef3c8ca';
import { renderAllPlayers } from './allplayers-view.js?v=2f666c99';
/* 模擬遊玩那一支**不在這裡 import**(2026-09-26,B4):game-view → game-live → game-sim,引擎本身 314 KB,
   而知識與球員搜尋兩個分頁根本用不到 —— 原本三個分頁都揹著它(explore.html 的 modulepreload 也一起預載)。
   改成點到那個分頁才 `import()`(見 VIEWS)。stamp-assets 照樣給那個字面路徑戳,但 modulepreload 只收靜態 import;
   單檔版沒有模組檔,bundle.mjs 把那一行 import() 換成攤平後那幾個匯出的 Promise。
   (這段註解刻意不寫那個字面路徑 —— stamp-assets 是用字面替換的,寫了連註解都會被戳。) */

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
  /* 模擬遊玩(2026-09-03)取代了對戰模擬;view 鍵留 duel,舊書籤不斷。
     模組點到才載(B4);載入失敗會走 show() 的 catch,畫面講「載入失敗」而不是空白。 */
  { key: 'duel', zh: '模擬遊玩', render: async body => (await import('./game-view.js?v=e9a86d31')).renderGame(body) },
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
