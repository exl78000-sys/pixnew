import * as C from './core.js?v=05fe8eff';

/* 戰術頁 2026-11-07 併進球隊頁(使用者:「球隊跟戰術 整合合一 不是分兩個子頁」)。這一頁保留為轉址 —— 舊連結與書籤不斷。
   內容在 tactics-view.js,由 page-teams.js 畫在球隊總覽的卡片與總表下面;#tactics 讓它捲到戰術的第一段。
   單檔版的網址本身是路由(#teams?…),不能再接一個 #,所以只轉頁不捲。 */
location.replace(C.link('teams') + (C.BUNDLE ? '' : '#tactics'));
