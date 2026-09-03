import * as C from './core.js?v=0';

/* 「球員搜尋」已併進「探索」單頁(2026-09-03)。這一頁保留為轉址 —— 舊連結與書籤不斷。
   內容在 allplayers-view.js,由 page-explore.js 以頁內分頁載入。 */
location.replace(C.link('explore', { view: 'allplayers' }));
