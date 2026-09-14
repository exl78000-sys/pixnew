/* 歐冠單場頁(2026-09-13,使用者:「歐冠沒有賽前賽後完整頁?現在用折疊打開會頁面太長」)。

   為什麼要獨立一頁,而不是繼續在盃賽頁裡展開:量過。聯賽階段一輪 18 場,
   **沒展開的清單就有 5,460px(6.1 個螢幕)**;展開一場 +6,033px —— 一份報告比整份清單還長;
   展開四場是 28,559px(31.7 個螢幕)。那不是「有點長」,是清單不能用了。
   抽屜也不對:報告的卡片(射門圖、動能圖、逐人評分)是整頁寬的內容,
   塞進 680px 的側欄只是換個地方擠。

   這一頁**不重畫任何報告** —— 賽前對比與賽後報告都是 ucl-view.js 既有的那兩個函式,
   盃賽頁與這一頁呼叫同一份(各寫一份的話,改了一邊另一邊會悄悄過期,本專案最常見的那種過期)。
   共用狀態(standings / elo / details / 隊伍註冊)走同一個 initUcl。 */
import * as C from './core.js?v=155f0c5e';
import { initUcl, uclAllMatches, uclExpandable, uclExpandKind, uclRegisterSides, renderUclCompare, renderUclPost } from './ucl-view.js?v=14ed0a89';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams } = await C.load('meta', 'clubs', 'teams');
  const { data: shared } = await C.loadFrom('pl', ['ucl', 'ucl-teams', 'ucl-standings', 'ucl-elo', 'ucl-details', 'competitions']);
  C.registerCompetitions(shared.competitions);
  initUcl({
    clubs, teams, uclTeams: shared['ucl-teams'],
    uclStandings: shared['ucl-standings'], uclElo: shared['ucl-elo'], uclDetails: shared['ucl-details'],
  });
  C.nav();

  const id = C.qs('id');
  const seasons = shared.ucl?.seasons ?? [];
  /* 用 id 在**所有賽季、聯賽階段與淘汰賽**裡找 —— 只找聯賽階段的話,
     淘汰賽的場次會變成「連結在但點進去說找不到」(ucl-view 那條坑的同一個道理)。 */
  let match = null, season = null;
  for (const s of seasons) {
    const hit = uclAllMatches(s).find(m => String(m.id) === String(id));
    if (hit) { match = hit; season = s; break; }
  }

  const back = `<a class="small dim" href="${C.link('cups', { cup: 'ucl' })}">← 回歐冠</a>`;
  if (!match) {
    app.innerHTML = `<div class="page-head">${back}<h1 style="margin-top:6px">找不到這一場</h1></div>
      <div class="note">網址帶的場次 id 不在本站的歐冠資料裡(${C.esc(String(id ?? '(沒有 id)'))})。
        可能是網址改過,或那一季還沒接進來。</div>`;
  } else {
    // 先登錄兩隊(名字、隊徽、顏色),頁首的隊徽才不會印成 football-data 的數字 id
    uclRegisterSides(match);
    const side = t => `${C.badge(String(t?.id ?? t?.code ?? ''))} <b>${C.esc(t?.name ?? '?')}</b>`;
    const sc = match.played && Array.isArray(match.final)
      ? `${match.final[0]} <span class="dim">:</span> ${match.final[1]}` : '—';
    const kind = uclExpandable(match) ? uclExpandKind(match) : null;
    const when = match.kickoff ? C.kickoffLocal(match.kickoff) : '時間待定';
    const stage = match.matchday ? `聯賽階段第 ${match.matchday} 輪` : (match.stage ?? '淘汰賽');

    app.innerHTML = `
    <div class="page-head">
      ${back}
      <h1 style="margin-top:6px">${C.esc(match.home?.name ?? '?')} <span class="dim">vs</span> ${C.esc(match.away?.name ?? '?')}</h1>
      <p class="small muted">${C.esc(season.label)}・${C.esc(stage)}・${when}</p>
    </div>
    <div class="card">
      <div class="scoreline" style="margin:4px 0 10px">
        <div class="side">${side(match.home)}</div>
        <div class="sc" style="font-size:22px">${sc}</div>
        <div class="side away">${side(match.away)}</div>
      </div>
      <div class="center tiny dim">${match.played
        ? `最終比分${match.pens ? `(PK ${match.pens[0]}:${match.pens[1]})` : match.aet ? '(延長賽後)' : ''}`
        : '尚未開賽'}</div>
    </div>
    ${/* 內容由 ucl-view 的兩個函式填,這裡只提供容器 */''}
    <div id="uclDetail" style="margin-top:16px"></div>
    ${kind ? '' : `<div class="note" style="margin-top:16px">這一場目前沒有賽前對比、勝率或賽後報告 ——
      兩隊要在本站的跨聯賽評分裡才有勝率,賽後報告要等逐場詳情抓到。</div>`}
    ${C.foot(meta, { sources: shared.ucl?.sources ?? null })}`;

    const slot = document.getElementById('uclDetail');
    if (kind === 'post') await renderUclPost(slot, match);
    else if (kind) await renderUclCompare(slot, match);
  }
} catch (e) { C.fail(e); }
