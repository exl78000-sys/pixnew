import * as C from './core.js?v=65f83e48';
import { renderModelView } from './model-view.js?v=05ab8729';
import { renderKnowledge } from './knowledge-view.js?v=05f9d606';

/* 說明(2026-11-07,使用者:「還有什麼可以合併精簡」→ 選了建議三):模型驗證與足球知識原本是聯賽分頁上的兩格,
   都是「想知道才來看」的背景資料,合成一格「說明」,頁內兩個分頁。宿主是 model.html(網址不變、舊書籤不斷),
   ?view=knowledge 是足球知識;舊的 knowledge.html 與 explore.html?view=knowledge 都轉到這裡。
   兩個分頁各自是 render 函式(model-view.js / knowledge-view.js),畫進同一個內層容器 —— 直接寫 #app 會把分頁列蓋掉。 */
const VIEWS = [
  { key: 'model', zh: '模型驗證', render: renderModelView },
  { key: 'knowledge', zh: '足球知識', render: renderKnowledge },
];

const app = document.getElementById('app');

/* 網址跟著分頁走(重新整理、分享連結回到同一個分頁);replaceState —— 上一頁應該回到上一個頁面,不是在兩個分頁之間倒退。
   單檔版的 hash 是路由,參數接在 # 後面(盃賽頁 writeComp 同一個寫法)。 */
function writeView(key) {
  try {
    if (C.BUNDLE) {
      const [pg, q] = (location.hash.slice(1) || 'model').split('?');
      const params = new URLSearchParams(q ?? '');
      if (key === VIEWS[0].key) params.delete('view'); else params.set('view', key);
      const qq = params.toString();
      history.replaceState(null, '', `#${pg}${qq ? '?' + qq : ''}`);
    } else {
      const u = new URL(location.href);
      if (key === VIEWS[0].key) u.searchParams.delete('view'); else u.searchParams.set('view', key);
      history.replaceState(null, '', u);
    }
  } catch { /* 網址寫不進去不影響內容 */ }
}

try {
  C.nav();
  const asked = C.qs('view');
  let cur = VIEWS.some(v => v.key === asked) ? asked : VIEWS[0].key;
  app.innerHTML = `
    <div style="margin:4px 0 14px">${C.tabs(VIEWS.map(v => ({ key: v.key, label: v.zh })), cur, { attr: 'data-doc', label: '說明', id: 'docTabs' })}</div>
    <div id="docBody"><div class="loading">載入資料中…</div></div>`;
  const body = document.getElementById('docBody');

  async function show(key) {
    const v = VIEWS.find(x => x.key === key);
    if (!v) return;
    cur = key;
    C.clearPageTimers();
    body.innerHTML = '<div class="loading">載入資料中…</div>';
    writeView(key);
    /* 兩個 render 都會自己 catch(錯誤畫在頁面上),這裡再包一層是給 import 之外的意外 */
    try { await v.render(body); } catch (err) { C.fail(err); }
  }

  document.querySelectorAll('[data-doc]').forEach(b => { b.onclick = () => { if (b.dataset.doc !== cur) show(b.dataset.doc); }; });
  await show(cur);
} catch (err) { C.fail(err); }
