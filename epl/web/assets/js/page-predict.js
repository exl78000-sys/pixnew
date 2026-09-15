/* 「我的」(2026-09-14)。兩個頁內分頁:我的球隊、我的預測。
 *
 * 為什麼併成一頁而不是導覽列再加一格:跨聯賽那一組已經有總覽、盃賽、探索、我的預測四格,
 * 手機上那一列本來就要橫向捲(探索頁的檔頭記過同一件事)。而這兩個東西的性質一模一樣 ——
 * **都是存在你自己瀏覽器裡的個人化資料,build 不讀、產物裡沒有、不回饋進任何模型**,
 * 收在同一個「我的」底下語意最順。
 *
 * 做法照探索頁那一套:內容抽成 `*-view.js` 的 render 函式,這一頁只負責分頁與容器。
 * 兩個實作細節都是那一頁踩過的:
 *
 * 1. **每個 view 拿一個內層容器。** 讓它們直接寫 `#app` 會把分頁列也蓋掉。
 * 2. **換分頁先收計時器。** 我的球隊有開賽倒數(`startCountdowns`),不收的話
 *    換到預測分頁它還在背景跑,而且下一次進來會再註冊一份。
 *
 * 網址 `?view=teams|predict`,舊連結(沒帶 view)進來預設停在「我的球隊」——
 * 關注是新功能,而預測要一輪一輪填,先看關注比較合理。 */
import * as C from './core.js?v=f4adf252';
import { renderFollowTeams } from './follow-view.js?v=2d699479';
import { renderPredict } from './predict-view.js?v=8506f1b0';

const VIEWS = [
  { key: 'teams', zh: '我的球隊', render: renderFollowTeams },
  { key: 'predict', zh: '我的預測', render: renderPredict },
];

const app = document.getElementById('app');

try {
  C.nav();
  const asked = C.qs('view');
  let cur = VIEWS.some(v => v.key === asked) ? asked : VIEWS[0].key;

  app.innerHTML = `
    <div class="filters" id="mineTabs">
      ${VIEWS.map(v => `<button class="btn${v.key === cur ? ' on' : ''}" type="button"
        data-mine="${v.key}">${C.esc(v.zh)}</button>`).join('')}
    </div>
    <div id="mineBody"><div class="loading">載入資料中…</div></div>`;

  const body = document.getElementById('mineBody');

  async function show(key) {
    const v = VIEWS.find(x => x.key === key);
    if (!v) return;
    cur = key;
    document.querySelectorAll('[data-mine]').forEach(b => b.classList.toggle('on', b.dataset.mine === key));
    C.clearPageTimers();
    body.innerHTML = '<div class="loading">載入資料中…</div>';
    /* 網址跟著換,重新整理與分享連結才會回到同一個分頁。
       用 replaceState 不是 pushState —— 上一頁應該回到上一個**頁面**,
       不是在這一頁的兩個分頁之間倒退。 */
    try {
      const u = new URL(location.href);
      if (C.BUNDLE) {
        const [p, q] = (location.hash.slice(1) || 'predict').split('?');
        const params = new URLSearchParams(q ?? '');
        params.set('view', key);
        history.replaceState(null, '', `#${p}?${params}`);
      } else {
        u.searchParams.set('view', key);
        history.replaceState(null, '', u);
      }
    } catch { /* 網址寫不進去不影響內容 */ }
    await v.render(body);
  }

  document.getElementById('mineTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-mine]');
    if (b) show(b.dataset.mine);
  });

  await show(cur);
} catch (e) { C.fail(e); }
