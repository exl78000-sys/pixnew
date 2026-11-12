/* 「我的」那一頁:我的球隊 + 我的預測。
 *
 * 2026-09-14 起是兩個頁內分頁;2026-11-07 合成一頁(使用者:「球隊與預測想辦法合成一頁,選隊伍摺疊起來用勾選」)。
 * 為什麼合得起來:兩者都是存在你自己瀏覽器裡的個人化資料,而且互相有關 —— 關注的球隊會在預測的場次上標 ★。
 * 分成兩個分頁時,那個 ★ 要切過去才看得到;同一頁的話上面勾一支,下面的 ★ 當場就亮。
 * 讓兩段擠得下的是「選球隊」收成摺疊 + 勾選(follow-view.js 的 pickerHtml):原本一百多顆 ☆ 整片攤開,會把預測推到很下面。
 *
 * 兩段各自一個容器(各自的 render 都會整個重寫自己的 host):
 * - 我的球隊在上:關注的球隊卡片是「看」的,預測是要動手填的,看完再往下填。
 * - 球隊那一段重畫時通知預測那一段只切 ★(refreshStars),不重畫 —— 重畫會洗掉還沒按儲存的比分。
 *
 * 舊網址 `?view=predict`(書籤、首頁「你的球隊」卡片連的是 `?view=teams`)照樣有效:
 * predict 捲到預測那一段,teams 或沒帶就停在頁首。 */
import * as C from './core.js?v=1404e5d4';
import { renderFollowTeams } from './follow-view.js?v=a5662c17';
import { renderPredict } from './predict-view.js?v=ef9c8dd6';

const app = document.getElementById('app');

try {
  C.nav();
  app.innerHTML = `
    <section id="mineTeams"><div class="loading">載入資料中…</div></section>
    <section id="minePredict" style="margin-top:28px"><div class="loading">載入資料中…</div></section>`;

  let predictCtl = null;
  /* 兩段並行載:兩邊的資料大半重疊(各聯賽的 meta / teams / fixtures),C.loadFrom 有快取,先到的那一段先畫 */
  const teamsDone = renderFollowTeams(document.getElementById('mineTeams'), {
    onChange: () => predictCtl?.refreshStars(),
  });
  const predictDone = renderPredict(document.getElementById('minePredict')).then(ctl => { predictCtl = ctl; });

  if (C.qs('view') === 'predict') {
    /* 預測那一段在球隊那一段下面,球隊那一段的卡片晚一步才長出來 —— 兩段都畫完再捲,不然捲到的位置會被推走 */
    await Promise.all([teamsDone, predictDone]);
    document.getElementById('minePredict').scrollIntoView({ block: 'start' });
  }
  await Promise.all([teamsDone, predictDone]);
} catch (e) { C.fail(e); }
