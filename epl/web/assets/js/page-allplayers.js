import * as C from './core.js?v=b87face5';

/* 「球員搜尋」2026-09-03 併進「探索」、2026-11-07 再併進球員頁的「全部聯賽」。這一頁保留為轉址 —— 舊連結與書籤不斷。
   內容在 allplayers-view.js,由球員頁「全部球員」的搜尋範圍勾選呼叫;?scope=all = 全部勾起來。 */
location.replace(C.link('players', { scope: 'all' }));
