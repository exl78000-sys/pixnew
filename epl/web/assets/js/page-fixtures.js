import * as C from './core.js?v=f8b58afd';

/* 「賽程與預測」已經併進「積分與賽程」(index)。
   這一頁留成轉址殼而不是直接刪掉 —— 站內外都可能已經有指向
   fixtures.html?id=<場次> 的連結(動態頁的「看這場的完整分析」、
   球隊頁的下一場、實時戰況的「看完整賽程」都曾經指到這裡),
   直接刪掉那些連結會變成 404。

   查詢字串原封不動帶過去,所以深連結 ?id= 仍然會開那一場的速覽
   (不再另外接 #allFixtures —— 單檔版本身就是 hash 路由,接第二個 # 會壞掉)。
   實作在 fixture-list.js,兩邊吃的是同一份。 */
location.replace(C.link('index', Object.fromEntries(new URLSearchParams(location.search))));
