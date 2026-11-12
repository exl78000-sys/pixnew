import * as C from './core.js?v=1404e5d4';

/* 「足球知識」2026-09-03 併進「探索」單頁,2026-11-07 再搬到「說明」頁(model.html?view=knowledge)。
   這一頁保留為轉址 —— 舊連結與書籤不斷。內容在 knowledge-view.js,由 page-model.js 以頁內分頁載入。 */
location.replace(C.link('model', { view: 'knowledge' }));
