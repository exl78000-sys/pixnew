import * as C from './core.js?v=2e9f0bce';

/* 動態併進聯賽的「比賽」頁了(2026-11-07,使用者:「還有什麼可以合併精簡」→ 選了建議二)。
   這一頁保留為轉址 —— 舊連結與書籤不斷。內容在 news-view.js,由 page-index.js 掛在頁底的「動態」摺疊區,
   anchorLink 帶到那裡並打開它。 */
location.replace(C.anchorLink('index', 'news'));
