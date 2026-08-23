import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, tactics } = await C.load('meta', 'clubs', 'teams', 'tactics');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const tacBy = new Map(tactics.map(t => [t.code, t]));
  const colour = c => C.team(c).colors?.[0] ?? '#888';

  app.innerHTML = `
  <div class="page-head">
    <h1>戰術分析</h1>
    <p>這一頁不談印象,只談上季 ${meta.lastSeason} 的 380 場比賽留下的痕跡:
       每支球隊實際把人力放在哪裡、機會創造得多好、領先之後守不守得住、進球集中在上半場還是下半場。
       所有指標都能對回原始賽果與球員數據。</p>
  </div>

  <div class="section"><h2>攻守四象限</h2><span class="hint">橫軸每場期望進球,縱軸每場期望失球(越上面防守越好)</span></div>
  <div class="card">
    ${C.scatter(tactics.map(t => ({
      x: t.attack.xG90, y: t.defence.xGA90, code: t.code, color: colour(t.code),
      label: `${C.name(t.code)} xG ${t.attack.xG90} / xGA ${t.defence.xGA90}`,
    })), { xLabel: '每場期望進球 xG(越右攻擊力越強)', yLabel: '每場期望失球 xGA(越上防守越穩)', invertY: true })}
    <div class="tiny dim">右上角 = 攻守俱佳;左下角 = 兩頭落空。xG 來自球員層級的期望進球加總,xGA 取自門將的期望失球。</div>
  </div>

  <div class="section"><h2>人力配置</h2><span class="hint">用出場分鐘反推,平均每場擺出幾名後衛 / 中場 / 前鋒</span></div>
  <div id="shape"></div>
  <div class="note info" style="margin-top:10px">FPL 把邊鋒歸類為中場,所以這裡量的是「人力分佈」而不是轉播圖上的陣型。
    重點看小數:後場接近 5 就是三中衛/五後衛體系,鋒線超過 1.5 就是雙前鋒。</div>

  <div class="section"><h2>領先之後守不守得住</h2><span class="hint">半場領先 / 落後時的實際收分能力</span></div>
  <div class="card">
    ${C.scatter(tactics.filter(t => t.resilience.leadHoldPct !== null && t.resilience.trailRescuePct !== null).map(t => ({
      x: t.resilience.leadHoldPct, y: t.resilience.trailRescuePct, code: t.code, color: colour(t.code),
      label: `${C.name(t.code)} 保分 ${t.resilience.leadHoldPct}% / 搶分 ${t.resilience.trailRescuePct}%`,
    })), { xLabel: '半場領先時的保分率 %', yLabel: '半場落後時的搶分率 %' })}
    <div class="tiny dim">右上角是最難纏的球隊:領先守得住、落後還能追。左下角就是俗稱的「玻璃心」。</div>
  </div>

  <div class="section"><h2>比賽時段</h2><span class="hint">上半場與下半場的淨勝球差異</span></div>
  <div id="tempo"></div>

  <div class="section"><h2>各隊風格卡</h2><span class="hint">雷達為 20 隊之中的百分位</span></div>
  <div class="grid g3">${tactics.map(t => `
    <div class="card">
      <a href="${C.link('teams', { code: t.code })}" style="color:inherit;text-decoration:none">
        <div class="row" style="gap:9px">${C.badge(t.code)}<b>${C.name(t.code)}</b>
          <span class="dim tiny" style="margin-left:auto">${t.formation.label}</span></div></a>
      ${C.radar([{ name: C.name(t.code), color: colour(t.code), values: t.radar }], { size: 230 })}
      <div class="tags">${t.tags.slice(0, 5).map(x => `<span class="pill">${x}</span>`).join('')}</div>
    </div>`).join('')}</div>
  ${C.foot(meta)}`;

  document.getElementById('shape').innerHTML = C.table(tactics, [
    { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) },
    { key: 'def', label: '後場', value: t => t.formation.def, num: true },
    { key: 'mid', label: '中場', value: t => t.formation.mid, num: true },
    { key: 'fwd', label: '鋒線', value: t => t.formation.fwd, num: true },
    { key: 'shape', label: '體系判讀', value: t => t.formation.shape, sortable: false,
      render: t => `<span class="small">${t.formation.shape}</span>` },
    { key: 'used', label: '使用人數', value: t => t.squad.used, num: true },
    { key: 'top11', label: '主力佔比', value: t => t.squad.top11Share, num: true, render: t => `${t.squad.top11Share}%` },
    { key: 'age', label: '加權年齡', value: t => t.squad.avgAgeWeighted, num: true },
    { key: 'cards', label: '每場牌數', value: t => t.discipline.perGame, num: true },
    { key: 'setp', label: '後場進球佔比', value: t => t.setPieces.defenderGoalShare, num: true,
      title: '後衛與門將的進球佔全隊比例,常被當成定位球威脅的代理指標',
      render: t => `${t.setPieces.defenderGoalShare}%` },
  ], { sortKey: 'def', desc: true, onRow: t => { C.go('teams', { code: t.code }); } });

  document.getElementById('tempo').innerHTML = C.table(tactics, [
    { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) },
    { key: 'gf1', label: '上半進', value: t => t.tempo.gf1, num: true },
    { key: 'ga1', label: '上半失', value: t => t.tempo.ga1, num: true },
    { key: 'gd1', label: '上半淨', value: t => t.tempo.gf1 - t.tempo.ga1, num: true, render: t => C.signed(t.tempo.gf1 - t.tempo.ga1, 0) },
    { key: 'gf2', label: '下半進', value: t => t.tempo.gf2, num: true },
    { key: 'ga2', label: '下半失', value: t => t.tempo.ga2, num: true },
    { key: 'gd2', label: '下半淨', value: t => t.tempo.gf2 - t.tempo.ga2, num: true, render: t => C.signed(t.tempo.gf2 - t.tempo.ga2, 0) },
    { key: 'swing', label: '下半場增減', value: t => t.tempo.secondHalfSwing, num: true,
      title: '下半場淨勝球 − 上半場淨勝球,正值代表越踢越強',
      render: t => `<b>${C.signed(t.tempo.secondHalfSwing, 1)}</b>` },
    { key: 'comeback', label: '逆轉', value: t => t.resilience.comeback, num: true },
    { key: 'collapse', label: '被逆轉', value: t => t.resilience.collapse, num: true },
  ], { sortKey: 'swing', desc: true, onRow: t => { C.go('teams', { code: t.code }); } });

} catch (err) { C.fail(err); }
