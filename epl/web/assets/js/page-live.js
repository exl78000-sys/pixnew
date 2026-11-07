import * as C from './core.js?v=7e0216d2';

/* 實時戰況併進聯賽頁了(2026-11-07,使用者:「聯賽跟實時戰況如何簡化合併?」→「併成一頁」)。
   這一頁保留為轉址 —— 舊連結與書籤不斷(歐冠併進盃賽頁時同一個做法)。
   內容在 live-board.js,由 page-index.js 掛在「比賽現況」那一區;#live 錨點捲到那裡。 */
location.replace(`${C.link('index')}#live`);
