import * as C from './core.js?v=7c658de6';

/* 「球員搜尋」2026-09-03 併進「探索」、2026-11-07 再併進球員頁的「全部聯賽」。這一頁保留為轉址 —— 舊連結與書籤不斷。
   內容在 allplayers-view.js,由 page-players.js 在 ?scope=all 時載入。 */
location.replace(C.link('players', { scope: 'all' }));
