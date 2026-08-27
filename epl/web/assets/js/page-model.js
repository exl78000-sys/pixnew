import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, form } = await C.load('meta', 'clubs', 'teams', 'form');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const bt = meta.model.backtest;
  /* 沒有回測時,這一頁原本只吐一句「執行 npm test 再 npm run build」——
     那是寫給開發者看的,讀者看到只會以為壞了(任務 #44 已經在別的頁修過同樣的問題)。
     改成照實說明:模型參數照樣攤開、為什麼還不能回測講清楚、模型不知道的事照列。
     **沒有回測數字就一個都不給**,不拿重擬合的數字冒充驗證結果。 */
  if (!bt.available) {
    const M = meta.model;
    const row = (k, v) => `<div class="stat-line"><span class="small">${k}</span><b class="mono">${v}</b></div>`;
    app.innerHTML = `
    <div class="page-head">
      <h1>模型驗證</h1>
      <p>這一頁的用途是攤開模型的實測準度。<b>目前這個聯賽還跑不了走查回測</b>,
         所以下面只有模型本身的設定與它的已知限制 —— 準度數字一個都不給,
         因為給了就是假的。</p>
      ${C.stampRow([C.stamp('模型設定', { kind: 'season', note: '每次 build 重算' })])}
    </div>

    <div class="note">${C.esc(bt.note ?? '這個聯賽目前沒有可用的回測結果。')}
      <div style="margin-top:6px" class="tiny dim">走查回測要把整季逐輪重跑,每一輪只用開賽前的資料重新訓練;
        而且調參與驗收必須用<b>不同賽季</b>,否則挑出來的一定是雜訊。手上只有一季完整歷史時,
        這件事在方法上就做不成 —— 不是還沒跑,是還不能跑。</div></div>

    <div class="section" style="margin-top:20px"><h2>模型設定</h2>
      <span class="hint">這些數字每次 build 都會重算</span></div>
    <div class="card">
      ${row('演算法', C.esc(M.type))}
      ${row('主場優勢', `${M.homeAdvantage}× 進球`)}
      ${row('低比分修正 ρ', M.rho)}
      ${row('時間衰減 ξ', M.decayXi)}
      ${row('賽季模擬次數', Number(M.simulationRuns).toLocaleString())}
      ${M.promotedPrior?.length ? row('套用聯盟後段先驗的升班馬', M.promotedPrior.map(c => C.name(c)).join('、')) : ''}
    </div>

    ${form?.tuned ? `<div class="section" style="margin-top:20px"><h2>近況特徵目前不影響機率</h2>
      <span class="hint">係數全為 0</span></div>
    <div class="card"><div class="small muted" style="display:grid;gap:8px">
      <div>近五戰狀況、近五戰進失球、歷來交手淨勝球這三個特徵<b>有算出來,但沒有進模型</b> ——
        係數是 <span class="mono">${C.esc(JSON.stringify(form.tuned))}</span>,
        套用之後 λ 一模一樣。</div>
      <div>它們只在賽前分析頁當資訊顯示,不動任何一個機率數字。
        ${C.esc(form.note ?? '')}</div>
      <div class="dim">要讓它們進模型,得先在<b>另一個賽季</b>驗收出大過標準誤的改善 ——
        跟回測卡在同一個地方:樣本不夠。</div>
    </div></div>` : ''}

    <div class="card" style="margin-top:20px">
      <h2>這個模型不知道的事</h2>
      <div class="small muted" style="display:grid;gap:6px">
        ${(M.caveats ?? []).map(c => `<div>・${C.esc(c)}</div>`).join('')}
        <div>・不含轉會、教練異動、賽程密度、歐戰疲勞、天氣、裁判。</div>
      </div>
    </div>
    ${C.foot(meta)}`;
    throw new Error('skip');
  }

  const M = bt.models;
  const kpi = (l, v, sub) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`;
  const better = ((M.baseline.rps - M.blend.rps) / M.baseline.rps) * 100;

  // 模型 vs 市場:同一批有收盤賠率的比賽
  const mkt = bt.market ?? { available: false };
  const mktBeat = mkt.available ? ((mkt.market.rps - mkt.model.rps) / mkt.market.rps) * 100 : 0;
  const mktRoundsWon = mkt.available ? mkt.byRound.filter(r => r.modelRps <= r.marketRps).length : 0;

  // 逐輪雙線圖:模型與市場的 RPS(都是越低越好)。只在這頁用,放這裡不進 core。
  function vsChart(rows, { w = 1000, h = 320 } = {}) {
    const pad = { l: 58, r: 22, t: 30, b: 46 };
    const vals = rows.flatMap(r => [r.modelRps, r.marketRps]);
    const lo = Math.min(...vals) * 0.9, hi = Math.max(...vals) * 1.08;
    const X = i => pad.l + (i / Math.max(1, rows.length - 1)) * (w - pad.l - pad.r);
    const Y = v => h - pad.b - ((v - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
    const yTicks = 4;
    const grid = [...Array(yTicks + 1)].map((_, i) => {
      const v = lo + (i / yTicks) * (hi - lo);
      return `<line x1="${pad.l}" y1="${Y(v).toFixed(1)}" x2="${w - pad.r}" y2="${Y(v).toFixed(1)}"
          stroke="var(--line-soft)" stroke-width="1"/>
        <text x="${pad.l - 10}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11.5" fill="var(--ink-3)">${v.toFixed(3)}</text>`;
    }).join('');
    const path = (key, color) => {
      const d = rows.map((r, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(r[key]).toFixed(1)}`).join(' ');
      const dots = rows.map((r, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(r[key]).toFixed(1)}" r="3"
        fill="${color}" stroke="var(--panel-solid)" stroke-width="1.2"><title>第 ${r.round} 輪・${key === 'modelRps' ? '模型' : '市場'} RPS ${r[key]}</title></circle>`).join('');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>${dots}`;
    };
    const xLabels = rows.filter((_, i) => i % 5 === 0 || i === rows.length - 1)
      .map(r => `<text x="${X(rows.indexOf(r)).toFixed(1)}" y="${h - pad.b + 20}" text-anchor="middle"
        font-size="11.5" fill="var(--ink-3)">${r.round}</text>`).join('');
    // 圖例(兩個系列一定要有,不能只靠顏色)
    const legend = `
      <line x1="${pad.l}" y1="14" x2="${pad.l + 22}" y2="14" stroke="var(--accent)" stroke-width="2"/>
      <text x="${pad.l + 28}" y="18" font-size="11.5" fill="var(--ink-2)">模型</text>
      <line x1="${pad.l + 76}" y1="14" x2="${pad.l + 98}" y2="14" stroke="var(--draw)" stroke-width="2"/>
      <text x="${pad.l + 104}" y="18" font-size="11.5" fill="var(--ink-2)">市場(收盤盤口)</text>
      <text x="${w - pad.r}" y="18" text-anchor="end" font-size="11.5" fill="var(--ink-3)">RPS 越低越好</text>`;
    return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto" role="img" aria-label="模型與市場逐輪 RPS 對照">
      ${grid}${legend}${path('marketRps', 'var(--draw)')}${path('modelRps', 'var(--accent)')}${xLabels}</svg>`;
  }

  /* ── 測過、但沒有進模型的特徵 ──────────────────────
     這一段存在的理由:一個模型「沒有用到什麼」跟「用了什麼」一樣重要。
     近五戰狀況與交手紀錄是最多人以為理所當然會有用的兩個特徵,
     我們真的接上去量過了,量出來沒用 —— 那就把量的過程和數字攤開來,
     而不是悄悄拿掉,也不是為了看起來厲害硬加進去。 */
  function rejectedSection() {
    const t = form?.tuning;
    if (!t) {
      return `<div class="card" style="margin-top:20px">
        <h2>測過但沒有進模型的特徵</h2>
        <div class="note">尚未跑過特徵驗證。執行 <span class="mono">npm run tune:form</span> 再
          <span class="mono">npm run build</span>,這一段就會出現完整的調參與驗收數字。</div></div>`;
    }
    const H = t.holdout;
    const rows = H.trials.map(r => `<tr>
      <td>${C.esc(r.係數)}</td>
      <td class="mono num">${r.RPS}</td>
      <td class="mono num">${r.對基準 > 0 ? '+' : ''}${r.對基準}</td>
      <td class="mono num">±${r['±標準誤']}</td>
      <td class="mono num">${r['bootstrap p']}</td>
      <td><span class="pill tiny ${Math.abs(r.對基準) > r['±標準誤'] && r.對基準 < 0 ? 'accent' : ''}">
        ${Math.abs(r.對基準) > r['±標準誤'] && r.對基準 < 0 ? '有效' : '在雜訊範圍內'}</span></td></tr>`).join('');

    return `
  <div class="section" style="margin-top:20px"><h2>測過但沒有進模型的特徵</h2>
    <span class="hint">沒有回測證據就不加</span></div>
  <div class="card">
    <div class="small muted" style="display:grid;gap:8px;margin-bottom:14px">
      <div><b>測了什麼:</b>近五戰狀況(相對於自己的長期水準)、近五戰進失球、歷來交手淨勝球。
        這三個是最常被認為「一定有用」的特徵。</div>
      <div><b>怎麼測的:</b>挑係數只用 ${C.esc(t.tuneSeason)}(${t.tuneGames} 場),
        驗收用 ${C.esc(t.holdoutSeason)}(${t.holdoutGames} 場)—— 驗收這批完全沒參與挑選。
        同一批資料又調參又驗收,挑出來的一定是雜訊,那種「改善」不算數。</div>
      <div><b>結論:</b>${t.accepted ? '有特徵通過驗收,已進模型。' : '沒有一個通過。係數維持 0,這三個特徵只在賽前分析頁當資訊顯示,不影響任何一個機率數字。'}</div>
    </div>

    <div class="small muted" style="margin-bottom:6px">驗收賽季 ${C.esc(t.holdoutSeason)}:基準 RPS
      <b class="mono">${H.baselineRps}</b></div>
    <div class="table-wrap"><table><thead><tr>
      <th>係數組合</th><th class="num">RPS</th><th class="num">對基準</th>
      <th class="num">成對標準誤</th><th class="num">bootstrap p</th><th>判定</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <div class="tiny dim" style="margin-top:8px">
      「對基準」是負數才代表變好。要能算數,它的絕對值至少要大過旁邊那個標準誤 ——
      不然只是換一批比賽就會翻盤的隨機波動。
    </div>

    <div class="small muted" style="margin:16px 0 6px">更直接的證據:特徵跟模型殘差的相關性</div>
    <div class="table-wrap"><table><thead><tr>
      <th>特徵</th><th class="num">相關係數 r</th><th class="num">t</th><th>顯著</th>
    </tr></thead><tbody>${t.residuals.map(r => `<tr>
      <td>${C.esc(r.特徵)}</td><td class="mono num">${r.相關係數}</td>
      <td class="mono num">${r.t}</td>
      <td><span class="pill tiny ${r.顯著 === '是' ? 'accent' : ''}">${r.顯著 === '是' ? '顯著' : '不顯著'}</span></td>
      </tr>`).join('')}</tbody></table></div>
    <div class="tiny dim" style="margin-top:8px">
      殘差 = 實際結果 − 模型的期望值,也就是<b>模型還不知道的那一部分</b>。
      如果一個特徵跟殘差沒有相關,代表它帶不進新資訊 —— 係數怎麼調都不會有用。
      這比網格搜尋更能說明「為什麼沒用」:球隊強弱本來就在 Dixon-Coles 的攻守參數與 Elo 裡了,
      近五場扣掉自己的長期水準之後,剩下的多半真的只是運氣。
    </div>
  </div>
  ${situationSection()}`;
  }

  /* 上一季的進球情境(定位球強弱)。跟上面那三個特徵一樣:量過、沒用、照實寫。
     這一段不是附註 —— 它是這個平台的做法本身:提出假說、用不同賽季驗收、
     沒過就留下紀錄,而不是換一個說法把它包裝成有用。 */
  function situationSection() {
    const t = form?.situationTuning;
    if (!t) return '';
    const cov = c => (c.noPrior?.length
      ? `${c.teams} 隊有先驗,${c.noPrior.length} 隊沒有(${c.noPrior.join('、')})`
      : `${c.teams} 隊都有先驗`);
    const rows = (t.holdout?.trials ?? []).map(r => `<tr>
      <td>${C.esc(r.係數)}</td>
      <td class="mono num">${r.bAtk}</td><td class="mono num">${r.bDef}</td>
      <td class="mono num">${r.RPS}</td>
      <td class="mono num">${r.對基準 > 0 ? '+' : ''}${r.對基準}</td>
      <td class="mono num">±${r['±標準誤']}</td>
      <td><span class="pill tiny ${r.對基準 < 0 && Math.abs(r.對基準) > r['±標準誤'] ? 'accent' : ''}">
        ${r.對基準 < 0 && Math.abs(r.對基準) > r['±標準誤'] ? '有效' : '在雜訊範圍內'}</span></td></tr>`).join('');

    return `
  <div class="section" style="margin-top:20px"><h2>上一季的定位球強弱有沒有預測力</h2>
    <span class="hint">${t.accepted ? '通過驗收' : '測過,沒通過'}</span></div>
  <div class="card">
    <div class="small muted" style="display:grid;gap:8px;margin-bottom:14px">
      <div><b>假說:</b>${C.esc(t.hypothesis)}</div>
      <div><b>怎麼定義:</b>定位球 = ${t.deadBall.join(' + ')}。
        <b>十二碼不算</b> —— 罰球次數主要反映被犯規多少與裁判尺度,不是定位球能力。</div>
      <div><b>為什麼用上一季:</b>Understat 給的是整季彙總不是逐場,
        拿本季彙總預測本季比賽就是偷看未來,那個「改善」完全是假的。</div>
      <div><b>怎麼測的:</b>調參 ${C.esc(t.tuneSeason)}(先驗 ${C.esc(t.tunePrior)},${t.tuneGames} 場)、
        驗收 ${C.esc(t.holdoutSeason)}(先驗 ${C.esc(t.holdoutPrior)},${t.holdoutGames} 場)。
        驗收這批完全沒參與挑選。</div>
      <div class="dim">先驗涵蓋:調參 ${cov(t.priorCoverage.tune)};驗收 ${cov(t.priorCoverage.holdout)}。
        沒有先驗的隊特徵給 0(不調整),不猜一個值。
        聯盟平均每場定位球進 ${t.leagueAverage.deadBallFor90} 球 / 失 ${t.leagueAverage.deadBallAgainst90} 球。</div>
    </div>

    <div class="small muted" style="margin-bottom:6px">驗收賽季 ${C.esc(t.holdoutSeason)}:基準 RPS
      <b class="mono">${t.holdout.baselineRps}</b></div>
    <div class="table-wrap"><table><thead><tr>
      <th>係數組合</th><th class="num">bAtk</th><th class="num">bDef</th>
      <th class="num">RPS</th><th class="num">對基準</th><th class="num">±標準誤</th><th>判定</th>
    </tr></thead><tbody>${rows}</tbody></table></div>

    <div class="note" style="margin-top:12px">
      <b>結論:${t.accepted ? '通過,已進模型。' : '沒有一組通過,係數維持 0。'}</b>
      ${t.accepted ? '' : `而且<b>連調參賽季都幾乎挑不出改善</b>(基準 ${t.tuneBaselineRps} → 最佳 ${t.tuneBest.rps})——
      調參是可以盡情挑的,連挑都挑不到東西,代表訊號是真的不存在,
      而不是「有訊號但被雜訊蓋過」。合理的解釋是:定位球得分能力本來就已經
      反映在 Dixon-Coles 的攻守參數裡了,再把它單獨拉出來並沒有多給模型任何資訊。`}
    </div>
  </div>`;
  }

  app.innerHTML = `
  <div class="page-head">
    <h1>模型驗證</h1>
    <p>這個平台沒有付費的進階數據當賣點,所以「預測到底準不準」就是它唯一該被檢驗的地方。
       這一頁把驗證過程完整攤開:方法、數字、以及模型錯得最離譜的那幾場。</p>
    ${C.stampRow([
      C.stamp('走查回測', { iso: bt.ranAt, kind: 'daily', note: '每次 npm test 重跑' }),
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
    ])}
  </div>

  <div class="grid g4">
    ${kpi('RPS', M.blend.rps, `基準線 ${M.baseline.rps}・低 ${better.toFixed(1)}%`)}
    ${kpi('命中率', C.pct(M.blend.hitRate, 1), `基準線 ${C.pct(M.baseline.hitRate, 1)}`)}
    ${kpi('LogLoss', M.blend.logLoss, `基準線 ${M.baseline.logLoss}`)}
    ${kpi('驗證場次', bt.games, `${bt.season} 全季・走查回測`)}
  </div>

  <div class="card" style="margin-top:16px">
    <h2>方法:每一輪都只用開賽前的資料</h2>
    <div class="small muted" style="display:grid;gap:8px">
      <div>回測最容易造假的地方,是不小心讓模型看到未來。這裡的做法是
        <b>重跑 ${bt.season} 整季的每一輪</b>,每一輪都把模型丟掉重練,
        只餵「那一輪開賽之前」已經發生的比賽,再去預測那一輪。</div>
      <div>也就是說,第 1 輪的預測只看得到前幾季;第 20 輪的預測看得到前 19 輪。
        <b>沒有任何一場比賽被用來預測它自己。</b></div>
      <div><b>RPS(Ranked Probability Score)</b>是足球預測的標準指標,越低越好,同時懲罰
        「猜錯」與「過度自信」。基準線是固定機率
        ${C.pct(bt.models.baseline ? (meta.model.backtest.baselineProbs?.home ?? 0.44) : 0.44, 0)} /
        ${C.pct(meta.model.backtest.baselineProbs?.draw ?? 0.25, 0)} /
        ${C.pct(meta.model.backtest.baselineProbs?.away ?? 0.31, 0)} ——
        任何模型至少要贏過它才有存在意義。</div>
      <div class="dim">回測執行時間:${new Date(bt.ranAt).toLocaleString('zh-TW', { hour12: false })}</div>
    </div>
  </div>

  <div class="section"><h2>四種做法的對照</h2><span class="hint">同一批 ${bt.games} 場比賽</span></div>
  <div id="cmp"></div>
  <div class="note info" style="margin-top:10px">
    平台採用的是<b>兩者平均</b>:Poisson 與 Elo 各自預測後取平均。
    三項指標都比單獨使用任一個好,所以這不是憑感覺選的。
  </div>

  ${mkt.available ? `
  <div class="section"><h2>模型 vs 市場</h2>
    <span class="hint">同一批 ${mkt.games} 場有收盤賠率的比賽</span></div>
  <div class="grid g4">
    ${kpi('模型 RPS', mkt.model.rps, mktBeat >= 0 ? `比市場低 ${mktBeat.toFixed(1)}%` : `比市場高 ${(-mktBeat).toFixed(1)}%`)}
    ${kpi('市場 RPS', mkt.market.rps, `${mkt.source ?? '博彩收盤'}・去水錢後`)}
    ${kpi('命中率', C.pct(mkt.model.hitRate, 1), `市場 ${C.pct(mkt.market.hitRate, 1)}`)}
    ${kpi('贏過市場的輪次', `${mktRoundsWon} / ${mkt.byRound.length}`, '該輪 RPS ≤ 市場')}
  </div>
  <div class="card" style="margin-top:14px">
    ${vsChart(mkt.byRound)}
    <div class="tiny dim" style="margin-top:8px">
      每一輪各 10 場,兩條線都是越低越好。市場是全世界資訊最充分的一群人用真金白銀押出來的機率,
      當作模型的天花板來看 —— 貼著它就很強,壓過它要當心是樣本僥倖而非真本事。</div>
  </div>
  <div class="note ${mktBeat >= 3 ? 'warn' : ''}" style="margin-top:10px">
    ${mktBeat >= 3
      ? `<b>模型在這批比賽上壓過了收盤市場(RPS ${mkt.model.rps} vs ${mkt.market.rps})。</b>
         這件事要非常小心地看:能穩定贏過博彩收盤盤口的人極少,在單一賽季上勝出,
         更可能是這批比賽的樣本僥倖、或某個環節不小心讓模型看到了未來,而不是真的找到了市場的破綻。
         正確的態度是存疑,而不是慶祝。`
      : mktBeat <= -3
        ? `<b>市場略勝一籌(RPS ${mkt.market.rps} vs 模型 ${mkt.model.rps}),這完全是意料之中。</b>
           盤口看得到傷停、輪換、轉會、士氣,而這個模型只吃比賽結果與 FPL 統計 —— 看不到那些。
           重點不是「有沒有輸」,是<b>差距有多小</b>:一個只用公開數據的免費模型能貼到這個距離,已經是誠實可用的水準。`
        : `<b>模型和收盤市場旗鼓相當(RPS ${mkt.model.rps} vs ${mkt.market.rps})。</b>
           以一個只吃公開數據、看不到傷停與轉會的免費模型來說,能跟全世界最銳利的盤口打平,
           已經是這個平台最有說服力的一個結果。`}
    <div class="tiny dim" style="margin-top:6px">
      市場機率的算法:取博彩收盤的十進位賠率,倒數得到含水錢的隱含機率,再按比例去掉莊家利潤(overround)使三者加總為 1。
      全程是決定性的算術,沒有一個數字是猜的。資料源 football-data.co.uk,免金鑰。</div>
  </div>` : `
  <div class="section"><h2>模型 vs 市場</h2><span class="hint">尚未載入賠率</span></div>
  <div class="note">
    這一段會拿模型跟<b>博彩收盤盤口</b>比 —— 那是最銳利的外部基準,「贏過市場」才是真的準。
    目前還沒有賠率資料:在連得到外網的環境跑 <span class="mono">npm run odds</span> 再
    <span class="mono">npm test</span> 就會出現。資料源 football-data.co.uk,免金鑰。
  </div>`}

  <div class="section"><h2>校準:說 70% 的時候,是不是真的 70%</h2>
    <span class="hint">比「準不準」更重要的問題</span></div>
  <div class="grid g2">
    <div class="card">
      ${C.calibrationChart(bt.calibration)}
      <div class="tiny dim center" style="margin-top:8px">
        點越大代表該區間的預測次數越多。點落在虛線上 = 完全校準。</div>
    </div>
    <div class="card">
      <h3>怎麼讀這張圖</h3>
      <div class="small muted" style="display:grid;gap:8px">
        <div>一個模型可以「命中率很高」但完全不可信 —— 例如它總是說強隊 95% 會贏。
          校準看的是另一件事:<b>把所有「模型說 30%」的事件收集起來,實際上有沒有大約 30% 發生。</b></div>
        <div>點在虛線<b>上方</b> = 模型太保守(實際比說的更常發生);
          在<b>下方</b> = 模型過度自信。</div>
        <div>樣本少的區間(小點)本來就會晃,不用太在意;
          要看的是<b>大點有沒有貼著線</b>。</div>
      </div>
      <div style="margin-top:12px" id="calTable"></div>
    </div>
  </div>

  <div class="section"><h2>逐輪表現</h2><span class="hint">綠點 = 該輪贏過基準線</span></div>
  <div class="card">
    ${C.roundChart(bt.byRound, { baseline: M.baseline.rps })}
    <div class="tiny dim" style="margin-top:8px">
      單輪只有 10 場,波動本來就大 —— 看的是整體有沒有穩定壓在紅線以下。
      共 ${bt.byRound.filter(r => r.rps <= M.baseline.rps).length} / ${bt.byRound.length} 輪贏過基準線。</div>
  </div>

  <div class="section"><h2>模型錯得最離譜的比賽</h2><span class="hint">誠實面對失準的那幾場</span></div>
  <div id="surprises"></div>
  <div class="note" style="margin-top:10px">
    這幾場不是 bug,是足球。任何機率模型都會有低機率事件發生 ——
    重點是<b>它們發生的頻率要跟模型說的一致</b>,那正是上面校準圖在檢查的事。
  </div>

  ${rejectedSection()}

  <div class="card" style="margin-top:20px">
    <h2>這個模型不知道的事</h2>
    <div class="small muted" style="display:grid;gap:6px">
      ${meta.model.caveats.map(c => `<div>・${C.esc(c)}</div>`).join('')}
      <div>・不含轉會、教練異動、賽程密度、歐戰疲勞、天氣、裁判。</div>
      <div>・盃賽與歐冠需要不同的模型(加時賽、PK、兩回合、跨聯賽比較),目前只做英超。</div>
    </div>
  </div>
  ${C.foot(meta)}`;

  /* 模型對照表 */
  const rows = [
    { name: 'Dixon-Coles Poisson', k: 'poisson' },
    { name: 'Elo 實力評分', k: 'elo' },
    { name: '兩者平均(平台採用)', k: 'blend', use: true },
    { name: '基準線(固定機率)', k: 'baseline', base: true },
  ].map(r => ({ ...r, ...M[r.k] }));

  document.getElementById('cmp').innerHTML = C.table(rows, [
    { key: 'name', label: '做法', value: r => r.name,
      render: r => `${r.use ? '<b>' + r.name + '</b>' : r.base ? `<span class="dim">${r.name}</span>` : r.name}` },
    { key: 'rps', label: 'RPS(越低越好)', value: r => r.rps, num: true,
      render: r => (r.use ? `<b>${r.rps}</b>` : r.rps) },
    { key: 'logLoss', label: 'LogLoss(越低越好)', value: r => r.logLoss, num: true },
    { key: 'hitRate', label: '命中率(越高越好)', value: r => r.hitRate, num: true, render: r => C.pct(r.hitRate, 1) },
    { key: 'vs', label: '相對基準線', value: r => r.rps, sortable: false, num: true,
      render: r => (r.base ? '—' : `<span class="${r.rps < M.baseline.rps ? 'yes' : ''}" style="color:${r.rps < M.baseline.rps ? 'var(--accent)' : 'var(--loss)'}">
        ${r.rps < M.baseline.rps ? '−' : '+'}${(Math.abs(M.baseline.rps - r.rps) / M.baseline.rps * 100).toFixed(1)}%</span>`) },
  ], { sortKey: 'rps', desc: false });

  /* 校準表(圖的替代呈現,也給讀不了圖的人)*/
  document.getElementById('calTable').innerHTML = C.table(bt.calibration.filter(b => b.n > 0), [
    { key: 'bin', label: '預測區間', value: b => b.lo, render: b => `${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%` },
    { key: 'n', label: '次數', value: b => b.n, num: true },
    { key: 'predicted', label: '平均預測', value: b => b.predicted, num: true, render: b => C.pct(b.predicted, 1) },
    { key: 'actual', label: '實際發生', value: b => b.actual, num: true, render: b => C.pct(b.actual, 1) },
    { key: 'gap', label: '差距', value: b => Math.abs(b.actual - b.predicted), num: true,
      render: b => `<span style="color:${Math.abs(b.actual - b.predicted) < 0.05 ? 'var(--accent)' : 'var(--draw)'}">
        ${b.actual >= b.predicted ? '+' : ''}${((b.actual - b.predicted) * 100).toFixed(1)} pt</span>` },
  ], { sortKey: 'bin', desc: false });

  /* 最意外的比賽 */
  const ZH = { home: '主勝', draw: '和局', away: '客勝' };
  document.getElementById('surprises').innerHTML = C.table(bt.surprises, [
    { key: 'date', label: '日期', value: s => s.date, render: s => `<span class="small">${C.dateFull(s.date)}</span>` },
    { key: 'round', label: '輪', value: s => s.round, num: true },
    { key: 'match', label: '比賽', value: s => s.home, sortable: false,
      render: s => `<span class="team-cell">${C.badge(s.home)}<b>${C.name(s.home)}</b>
        <b class="mono">${s.fh}-${s.fa}</b>${C.badge(s.away)}<b>${C.name(s.away)}</b></span>` },
    { key: 'real', label: '結果', value: s => s.real, sortable: false, render: s => ZH[s.real] },
    { key: 'pReal', label: '模型給這結果', value: s => s.pReal, num: true,
      render: s => `<b style="color:var(--loss)">${C.pct(s.pReal, 1)}</b>` },
    { key: 'pred', label: '模型當時的看法', value: s => s.pred.home, sortable: false,
      render: s => C.probBar(s.pred) },
  ], { sortKey: 'pReal', desc: false });

} catch (err) { if (err.message !== 'skip') C.fail(err); }
