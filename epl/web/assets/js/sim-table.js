import * as C from './core.js?v=f5b81714';

/* ── 本季預測積分榜(共用模組) ─────────────────────────
   兩個地方在畫同一張表:積分與賽程頁,以及實時戰況頁
   (那一頁本來就有「本季即時積分榜」,現況與預測並排才看得出差距)。

   抽成模組而不是複製 —— 這張表有九個欄位、三根機率條與兩處
   「本季實得 vs 期望積分」的說明,複製一份之後改了一邊,
   另一邊會悄悄變成另一個版本(戰術頁風格卡、賽前分析陣容對照都踩過)。 */
export function mountSimTable(mountId, { sim, teams, table, meta, note = true }) {
  const el = document.getElementById(mountId);
  if (!el) return;
  if (!sim?.length) {
    el.innerHTML = '<div class="note">目前沒有賽季模擬結果。</div>';
    return;
  }
  const curBy = new Map((table?.current ?? []).map(r => [r.code, r]));
  const teamBy = new Map(teams.map(t => [t.code, t]));
  const played = (table?.current ?? []).reduce((a, r) => a + (r.p ?? 0), 0) / 2;

  el.innerHTML = C.table(sim, [
    { key: 'pos', label: '#', value: r => r.expectedPos, render: (r, i) => i + 1, sortable: false, num: true },
    { key: 'team', label: '球隊', value: r => C.name(r.code), render: r => C.teamCell(r.code) },
    { key: 'earned', label: '本季實得', value: r => (curBy.get(r.code)?.pts ?? 0), num: true,
      title: '已經踢完的比賽拿到的分數,這部分不是預測',
      render: r => { const c = curBy.get(r.code);
        return c?.p ? `<b>${c.pts}</b><span class="dim tiny"> / ${c.p} 場</span>` : '<span class="dim">—</span>'; } },
    { key: 'expectedPoints', label: '期望積分', value: r => r.expectedPoints, num: true,
      title: '本季實得 + 剩餘賽程的模擬結果',
      render: r => `<b>${r.expectedPoints}</b>` },
    { key: 'titlePct', label: '奪冠', value: r => r.titlePct, num: true,
      render: r => `${r.titlePct}%${C.bar(r.titlePct, 100)}` },
    /* 「前四」是英超與西甲的界線(歐冠資格)。英冠不是 —— 那裡是**前 2 直升、
       3~6 打附加賽**,第四名跟第五名沒有差別。所以哪個聯賽有 promotionPct
       就換成「直升 / 附加賽區」,沒有的維持原樣。
       用資料裡有沒有這個欄位來判斷,不要在前端寫死聯賽代碼 ——
       寫死的話再加一個聯賽就要回來改這裡,而且會忘。 */
    ...(sim[0]?.promotionPct != null ? [
      { key: 'promotionPct', label: '直升', value: r => r.promotionPct, num: true,
        title: '前 2 名直接升上英超',
        render: r => `${r.promotionPct}%${C.bar(r.promotionPct, 100, 'alt')}` },
      { key: 'top6Pct', label: '附加賽區', value: r => r.top6Pct, num: true,
        title: '第 3~6 名打升級附加賽',
        render: r => `${r.top6Pct}%${C.bar(r.top6Pct, 100, 'alt')}` },
    ] : [
      { key: 'top4Pct', label: '前四', value: r => r.top4Pct, num: true,
        render: r => `${r.top4Pct}%${C.bar(r.top4Pct, 100, 'alt')}` },
    ]),
    { key: 'relegationPct', label: '降級', value: r => r.relegationPct, num: true,
      render: r => `${r.relegationPct}%${C.bar(r.relegationPct, 100, 'hot')}` },
    { key: 'last', label: '上季', value: r => (teamBy.get(r.code)?.lastSeason?.pos ?? 99), num: true,
      render: r => { const t = teamBy.get(r.code);
        return t?.lastSeason ? `第 ${t.lastSeason.pos} 名` : '<span class="pill">升班馬</span>'; } },
    { key: 'elo', label: 'Elo', value: r => teamBy.get(r.code)?.elo ?? 0, num: true,
      render: r => C.fx(teamBy.get(r.code)?.elo, 0) },
  ], { sortKey: 'expectedPoints', desc: true, onRow: r => { C.go('teams', { code: r.code }); } });

  if (!note) return;
  el.insertAdjacentHTML('afterend', `<div class="note info" style="margin-top:10px">
    <b>每踢完一場就會重算。</b>期望積分 =<b>已經拿到的分數</b>+ 剩餘賽程的模擬結果,
    而且已完賽的比分也會回頭修正球隊強度,影響後面每一場的機率。
    ${played ? `目前已計入 ${played} 場真實賽果。` : ''}
    <span class="dim">蒙地卡羅模擬 ${meta.model.simulationRuns.toLocaleString()} 次賽季。</span></div>`);
}
