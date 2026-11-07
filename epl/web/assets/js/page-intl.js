import * as C from './core.js?v=bdef8b54';

/* 國家隊 2026-11-07 併進「盃賽」那一頁的一個分頁(使用者:「國家隊 整合進杯賽」)。這一頁保留為轉址 ——
   舊連結與書籤(含 ?team=Japan 的球隊頁)不斷。內容在 intl-view.js,由 page-cups.js 以頁內分頁載入。 */
location.replace(C.link('cups', { cup: 'intl', team: C.qs('team') }));
