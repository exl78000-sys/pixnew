import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, tactics, formation, shapes } =
    await C.load('meta', 'clubs', 'teams', 'tactics', 'formation', 'shapes');
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
    ${C.stampRow([
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
      C.stamp('風格標籤與雷達圖', { kind: 'season', note: '由上季全季統計歸納' }),
    ])}
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

  <div class="section"><h2>標準陣型與攻守分型</h2>
    <span class="hint">把 FPL 的四個粗類細分成八種角色後推導</span></div>
  <div id="shapeTable"></div>
  <div class="note info" style="margin-top:10px">
    <b>這是怎麼推出來的。</b>FPL 只把球員分成門將/後衛/中場/前鋒四類,而且把邊鋒歸為中場 ——
    光看「五名中場」分不出那是三中場加兩邊鋒,還是五個中路球員,那是完全不同的球隊。
    所以這裡先用 per-90 的產出側寫把每個人細分成<b>中衛 / 邊後衛 / 防守中場 / 中場 / 前腰 / 邊鋒 / 中鋒</b>,
    再由各角色的出場分鐘推導常態陣型。
    <div style="margin-top:6px">分得開是因為差距很大:邊鋒每 90 分鐘的威脅值約 30、防守中場約 7;
      中衛的解圍攔截約 8、邊後衛約 3.5 而創造力是中衛的四倍。
      已用 15 位位置明確的球員驗證,全部分類正確。</div>
  </div>
  <div class="note" style="margin-top:10px">
    <b>攻守分型是推論,不是實際站位資料。</b>
    我們沒有球員追蹤資料,做不到真正的「有球/無球站位」。這裡只用兩條最沒有爭議的規則:
    <b>創造力排在同角色前段的邊後衛,進攻時前壓</b>;<b>防守貢獻排在同角色前段的邊鋒,無球時退回中場線</b>。
    兩條都能從資料驗證,但它推的是傾向,不是實測位置。
    ${Object.values(shapes).filter(s => s.insufficient).length
      ? `另外有 ${Object.values(shapes).filter(s => s.insufficient).length} 支球隊(升班馬)沒有足夠的英超樣本,
         寧可標示資料不足也不編一個陣型出來。` : ''}
  </div>

  <div class="section"><h2>陣型到底有沒有影響</h2>
    <span class="hint">${formation.n} 隊・${meta.lastSeason} 完整賽季</span></div>
  <div class="grid g2">
    <div class="card">
      ${C.scatter(formation.points.map(p => ({
        x: p.mid, y: p.pts, code: p.code, color: colour(p.code),
        label: `${C.name(p.code)} 中場 ${p.mid} 人・${p.pts} 分`,
      })), { w: 560, h: 460, xLabel: '平均每場擺出幾名中場', yLabel: '該季聯賽積分', quadrants: false })}
      <div class="tiny dim">每個點是一支球隊。這是五組關係裡<b>最強的一組</b>,但請看右邊為什麼不能就這樣下結論。</div>
    </div>
    <div class="card">
      <h3>五組關係的相關係數</h3>
      <div id="corrTable"></div>
      <div class="tiny dim" style="margin-top:8px">
        r 介於 −1 到 1,絕對值越大關係越強。以 ${formation.n} 隊的樣本量來說,
        <b>|r| 要達到 ${formation.critical} 以上</b>才勉強算得上不是雜訊。
      </div>
    </div>
  </div>
  <div class="note" style="margin-top:10px">
    <b>先講結論:這幾個數字最可能是反過來的因果。</b>
    中場擺得多的隊積分高、前鋒擺得多的隊積分低 —— 但真實世界的順序比較可能是:
    <b>強隊控球多所以中場站得住,弱隊經常落後只好再推一個前鋒上去追分。</b>
    也就是陣型反映了球隊的處境與實力,而不是陣型造就了成績。
    要真的分離出「陣型的效果」,需要同一支球隊在實力相近時換陣型的對照,
    這個平台目前的資料量做不到,所以這裡只呈現相關,不宣稱因果。
  </div>
  <div class="card" style="margin-top:12px">
    <h3>後衛人數幾乎跟成績無關 —— 這件事本身值得說</h3>
    <div class="small muted" style="display:grid;gap:8px">
      <div>後衛平均人數與積分的 r 只有 <b>${formation.pairs.find(p => p.key === 'def-pts')?.r}</b>,
        與期望失球的 r 是 <b>${formation.pairs.find(p => p.key === 'def-xga')?.r}</b> ——
        兩個都遠低於門檻。<b>「三後衛比較穩」「五後衛比較保守」在這份資料裡看不出來。</b></div>
      <div>合理的解釋是:後防人數只是站位的起點,真正決定失球的是防線高度、壓迫強度、
        中場的保護,以及對手的水準 —— 這些都不會顯示在「擺了幾個後衛」這個數字上。</div>
      <div class="dim">注意:這裡的人數是用<b>出場分鐘反推的平均值</b>,不是轉播畫面上的陣型圖。
        FPL 把邊鋒歸類為中場,所以中場人數偏高是正常的。</div>
    </div>
  </div>

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

  const ROLE_ZH = { CB: '中衛', FB: '邊後衛', DM: '防中', CM: '中場', AM: '前腰', W: '邊鋒', ST: '中鋒' };
  document.getElementById('shapeTable').innerHTML = C.table(
    tactics.filter(t => shapes[t.code]).map(t => ({ ...t, s: shapes[t.code] })), [
      { key: 'team', label: '球隊', value: t => C.name(t.code), render: t => C.teamCell(t.code) },
      { key: 'base', label: '標準陣型', value: t => (t.s?.base?.label ?? ''), sortable: false,
        render: t => (t.s?.insufficient
          ? '<span class="dim small">資料不足</span>'
          : `<b class="mono">${t.s.base.label}</b>`) },
      { key: 'att', label: '進攻時', value: t => (t.s?.attacking?.label ?? ''), sortable: false,
        render: t => (t.s?.insufficient ? '—'
          : `<span class="mono" style="color:var(--accent)">${t.s.attacking.label}</span>${
            t.s.attacking.pushedUp ? `<span class="tiny dim"> 邊後衛前壓 ${t.s.attacking.pushedUp}</span>` : ''}`) },
      { key: 'def', label: '防守時', value: t => (t.s?.defending?.label ?? ''), sortable: false,
        render: t => (t.s?.insufficient ? '—'
          : `<span class="mono" style="color:var(--accent-3)">${t.s.defending.label}</span>${
            t.s.defending.droppedBack ? `<span class="tiny dim"> 邊鋒回收 ${t.s.defending.droppedBack}</span>` : ''}`) },
      { key: 'roles', label: '角色組成', value: () => 0, sortable: false, left: true,
        render: t => (t.s?.insufficient
          ? `<span class="tiny dim">只有 ${t.s.contributors} 名球員有足夠的英超樣本</span>`
          : `<span class="tiny dim">${Object.entries(t.s.counts).filter(([, n]) => n > 0)
              .map(([k, n]) => `${n}${ROLE_ZH[k]}`).join('・')}</span>`) },
      { key: 'fpl', label: 'FPL 粗類', value: t => t.formation.def, num: true,
        title: '出場分鐘反推的四類人力配置,是上面那張表的原料',
        render: t => `<span class="dim tiny mono">${t.formation.label}</span>` },
    ], { sortKey: 'base', desc: false });

  document.getElementById('corrTable').innerHTML = C.table(formation.pairs, [
    { key: 'x', label: '陣型指標', value: p => p.x, left: true },
    { key: 'y', label: '對照的結果', value: p => p.y, left: true },
    { key: 'r', label: 'r', value: p => Math.abs(p.r ?? 0), num: true,
      render: p => `<b style="color:${p.significant ? 'var(--accent)' : 'var(--ink-3)'}">${p.r}</b>` },
    { key: 'sig', label: '達門檻?', value: p => (p.significant ? 1 : 0), sortable: false,
      render: p => (p.significant
        ? `<span class="pill accent tiny">是・${p.strength}</span>`
        : `<span class="pill tiny">否・${p.strength}</span>`) },
  ], { sortKey: 'r', desc: true });

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
