import * as C from './core.js?v=2e9f0bce';
import { renderModelView } from './model-view.js?v=03e65739';
import { renderKnowledge } from './knowledge-view.js?v=4b6fd0db';

/* 模型驗證與足球知識(model.html,?view=knowledge 是知識)。
 *
 * 2026-11-07 兩頁一度合成一格「說明」、頁內兩個分頁;同一天稍後使用者:「說明兩頁移動到上一層」——
 * 頁內那排分頁是全站唯一排到第三層的地方(頂列 → 聯賽分頁 → 頁內分頁),所以兩頁各自回到聯賽分頁(core.js 的 LEAGUE_TABS:模型、知識)。
 * 網址照舊是同一個 model.html 靠 view 分:knowledge.html 不在各聯賽的 open 清單裡,另開一頁的話五個聯賽要各改一次清單。
 * 這一頁不畫任何分頁,切換是導覽列的連結(換頁);兩個 render 都畫進 #app。舊的 knowledge.html 與
 * explore.html?view=knowledge 都轉到 ?view=knowledge。 */
const app = document.getElementById('app');

try {
  const knowledge = C.qs('view') === 'knowledge';
  /* 分頁標題跟著 view 走:model.html 寫的是「模型驗證」,知識那一頁換掉,不然瀏覽器分頁上兩頁同名 */
  if (knowledge) document.title = document.title.replace('模型驗證', '足球知識');
  C.nav();
  await (knowledge ? renderKnowledge(app) : renderModelView(app));
} catch (err) { C.fail(err); }
