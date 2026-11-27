import * as C from './core.js?v=662b4d9f';
import { followedIn } from './follow.js?v=02130043';
import { runSeason, seasonInputs } from './season-sim.js?v=0f616328';

/* 「如果…會怎樣」(2026-11-27,N4;使用者選的)。
   選一隊、自己按它接下來幾場的勝 / 和 / 負,瀏覽器當場用**站上同一套模型**重跑整季,
   看奪冠 / 前四(或直升、附加賽)/ 降級的機率怎麼變。

   三件事讓它講的是實話:
   - **同一份模擬程式**(season-sim.js,建站也跑它)、**同一組強度參數**(meta.model.sim)、
     **同一組名額與亂數種子**(meta.model.simConfig)。所以一場都不指定時,這裡的數字跟「預測」分頁相同(測試守著)。
   - 「原本」那一欄是**這裡自己重跑**的,跟「假設」用同一個種子 —— 兩欄的差只來自你指定的那幾場,不是兩次抽樣的雜訊。
   - 畫面講明這是假設情境:你指定的場次照你按的結果,其餘照模型隨機。它不是本站的預測,也不改任何地方。 */

const WHATIF_NEXT = 6;   // 一次列這一隊接下來幾場。再多的話按鈕一長排,手機上看不完;要看更遠的就先指定前面幾場的結果

export function mountWhatIf(el, { meta, fixtures, table, state = {} }) {
  if (!el) return;
  const lg = C.league();
  const cfg = meta.model?.simConfig, simP = meta.model?.sim;
  if (!cfg || !simP?.teams) {
    el.innerHTML = '<div class="note">這個聯賽的產物還沒帶模擬設定(下一次建置會補上),所以還不能試算。</div>';
    return;
  }
  const base = seasonInputs(meta, fixtures);
  if (!base) {
    el.innerHTML = '<div class="note">這一季已經沒有未賽的聯賽場次,沒有東西可以假設。</div>';
    return;
  }
  const { codes, fixtures: remaining } = base;
  const season = meta.currentSeason;

  /* 狀態由呼叫端保管(聯賽頁的閉包):那一頁每 30 秒整頁重畫,掛在元素上會被清掉;
     重畫不可以把使用者按過的東西清掉、也不要重跑模擬 */
  const st = state;
  st.picks ??= new Map(); st.key ??= '';
  if (!st.team || !codes.includes(st.team)) {
    const mine = [...followedIn(lg)].find(c => codes.includes(c));
    st.team = mine ?? (table?.current?.[0]?.code && codes.includes(table.current[0].code) ? table.current[0].code : codes[0]);
  }

  const zones = zoneDefs(cfg, codes.length);
  const upcoming = () => remaining.filter(f => f.home === st.team || f.away === st.team)
    .sort((a, b) => String(a.kickoff ?? a.date).localeCompare(String(b.kickoff ?? b.date))).slice(0, WHATIF_NEXT);

  const run = () => {
    st.baseline ??= runSeason(base);
    const fixed = new Map([...st.picks].filter(([, v]) => v));
    const key = JSON.stringify([...fixed]);
    if (key !== st.key) { st.result = fixed.size ? runSeason({ ...base, fixed }) : st.baseline; st.key = key; }
  };

  const draw = () => {
    const list = upcoming();
    const teamOpts = codes.map(c => `<option value="${c}"${c === st.team ? ' selected' : ''}>${C.esc(C.name(c))}</option>`).join('');
    const fxRows = list.map(f => {
      const home = f.home === st.team, opp = home ? f.away : f.home, k = `${f.home}|${f.away}`;
      const p = f.prediction;
      /* 按鈕是**這一隊的角度**(贏 / 平 / 輸),存的是主客角度(H / D / A)—— 模擬只認主客 */
      const mapTo = { W: home ? 'H' : 'A', D: 'D', L: home ? 'A' : 'H' };
      const cur = st.picks.get(k) ?? '';
      const pctOf = r => (p ? C.pct(r === 'W' ? (home ? p.home : p.away) : r === 'L' ? (home ? p.away : p.home) : p.draw, 0) : '');
      const btn = (r, label) => {
        const on = cur === mapTo[r];
        /* 選中用全站的 `.on`(實心綠);機率字用半透明而不是 .dim —— .dim 在綠底上看不見 */
        return `<button type="button" class="btn tiny${on ? ' on' : ''}" data-wi-fx="${C.esc(k)}" data-wi-r="${mapTo[r]}"
          aria-pressed="${on}" title="模型賽前給 ${pctOf(r)}">${label}<span style="margin-left:4px;opacity:.65">${pctOf(r)}</span></button>`;
      };
      return `<div class="whatif-fx">
        <div class="whatif-opp"><span class="tiny dim">${C.esc(C.dateFull(String(f.kickoff ?? f.date).slice(0, 10)))}・${home ? '主' : '客'}</span>
          <span>${C.badge(opp)} ${C.esc(C.name(opp))}</span></div>
        <div class="whatif-btns">${btn('W', '贏')}${btn('D', '平')}${btn('L', '輸')}
          ${cur ? `<button type="button" class="btn tiny" data-wi-fx="${C.esc(k)}" data-wi-r="">清除</button>` : ''}</div>
      </div>`;
    }).join('');

    const nPicked = [...st.picks.values()].filter(Boolean).length;
    let res = '';
    if (st.result) {
      const b = new Map(st.baseline.map(r => [r.code, r])), a = new Map(st.result.map(r => [r.code, r]));
      const me0 = b.get(st.team), me1 = a.get(st.team);
      const cell = (z, r0, r1) => {
        const v0 = r0[z.key], v1 = r1[z.key], d = Math.round((v1 - v0) * 10) / 10;
        const cls = Math.abs(d) < 0.5 ? '' : z.good == null ? 'info' : (d > 0) === z.good ? 'accent' : 'bad';
        return `<div class="whatif-zone"><span class="tiny dim">${C.esc(z.label)}</span>
          <b class="mono">${v1.toFixed(1)}%</b>
          <span class="tiny ${cls ? 'pill ' + cls : 'dim'}">${nPicked ? `原本 ${v0.toFixed(1)}%${Math.abs(d) >= 0.1 ? `・${d > 0 ? '+' : ''}${d.toFixed(1)}` : ''}` : '目前的預測'}</span></div>`;
      };
      /* 連帶影響:別隊的任一區機率動了 1 個百分點以上才列(同一個種子,所以小於 1 的多半是重排序的小擾動) */
      const ripple = nPicked ? codes.filter(c => c !== st.team)
        .map(c => ({ c, ds: zones.map(z => ({ z, d: a.get(c)[z.key] - b.get(c)[z.key] })).filter(x => Math.abs(x.d) >= 1) }))
        .filter(x => x.ds.length).sort((x, y) => Math.max(...y.ds.map(t => Math.abs(t.d))) - Math.max(...x.ds.map(t => Math.abs(t.d)))).slice(0, 8) : [];
      res = `<div class="card whatif-result">
        <div class="spread"><h3 style="margin:0">${C.badge(st.team)} ${C.esc(C.name(st.team))}</h3>
          <span class="tiny dim">預期積分 ${me1.expectedPoints}${nPicked ? `(原本 ${me0.expectedPoints})` : ''}・預期名次 ${me1.expectedPos.toFixed(1)}</span></div>
        ${/* 只列這一隊碰得到的區間:前後都是 0.0% 的(強隊的降級、弱隊的奪冠)只是雜訊。全部都是 0 就至少留第一個 */''}
        <div class="whatif-zones">${(() => {
          const live = zones.filter(z => Math.max(me0[z.key], me1[z.key]) >= 0.1);
          return (live.length ? live : zones.slice(0, 1)).map(z => cell(z, me0, me1)).join('');
        })()}</div>
        ${posBar(me1.posDist, zones)}
        ${ripple.length ? `<div class="tiny dim" style="margin-top:10px">連帶影響(別隊動了 1 個百分點以上)</div>
          <div class="whatif-ripple">${ripple.map(x => `<span>${C.badge(x.c)} ${C.esc(C.name(x.c))} ${x.ds.map(t =>
            `<span class="${t.z.good == null ? '' : (t.d > 0) === t.z.good ? 'good-text' : 'bad-text'}">${C.esc(t.z.short)} ${t.d > 0 ? '+' : ''}${t.d.toFixed(1)}</span>`).join(' ')}</span>`).join('')}</div>` : ''}
      </div>`;
    }

    el.innerHTML = `<div class="whatif">
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <label class="small">球隊 <select id="wiTeam">${teamOpts}</select></label>
        <span class="tiny dim">按它接下來 ${list.length} 場的結果(按鈕旁是模型賽前給的機率)</span></div>
      <div class="whatif-list">${fxRows || '<div class="note">這一隊本季沒有未賽的聯賽場次。</div>'}</div>
      ${res}
      <div class="note" style="margin-top:10px">這是<b>假設情境</b>,不是本站的預測:你指定的場次照你按的結果,其餘每一場照本站模型隨機跑
        ${cfg.runs.toLocaleString()} 次整季(跟「預測」分頁同一套模型、同一個亂數種子 —— 一場都不指定時兩邊數字相同)。
        「原本」也是這裡用同一個種子重跑的,所以兩欄的差只來自你指定的那幾場。計算在你的瀏覽器裡做,不會存到任何地方。</div>
    </div>`;

    el.querySelector('#wiTeam').onchange = e => { st.team = e.target.value; st.picks.clear(); compute(); };
    el.querySelectorAll('[data-wi-fx]').forEach(b => {
      b.onclick = () => {
        const k = b.dataset.wiFx, r = b.dataset.wiR;
        if (!r || st.picks.get(k) === r) st.picks.delete(k); else st.picks.set(k, r);
        compute();
      };
    });
  };

  /* 重跑整季在主執行緒上要幾百毫秒:先畫「計算中」讓按鈕有反應,下一格再算 */
  const compute = () => {
    const box = el.querySelector('.whatif-result');
    if (box) box.style.opacity = '0.5';
    setTimeout(() => { run(); draw(); }, 20);
  };
  if (st.result) draw(); else { el.innerHTML = '<div class="note">整季模擬計算中…</div>'; compute(); }
}

/* 每個聯賽要看的區間,從 simConfig 推 —— 不寫死聯賽(英冠是直升 / 附加賽,德法有降級附加賽)。
   good:機率變大是好事(true)、壞事(false)、**看你原本在哪**(null)—— 附加賽對前段班是往下掉、對中段班是往上爬,
   上綠色或紅色都會誤導,所以中性色。 */
export function zoneDefs(cfg, n) {
  const z = [{ key: 'titlePct', label: '奪冠', short: '奪冠', good: true, from: 1, to: 1 }];
  if (cfg.promotion) {
    z.push({ key: 'promotionPct', label: `直升(前 ${cfg.promotion})`, short: '直升', good: true, from: 1, to: cfg.promotion });
    if (cfg.promotionPlayoff) z.push({ key: 'playoffPct', label: `附加賽(第 ${cfg.promotion + 1}~${cfg.promotionPlayoff} 名)`, short: '附加賽', good: null, from: cfg.promotion + 1, to: cfg.promotionPlayoff });
  } else {
    z.push({ key: 'top4Pct', label: '前四', short: '前四', good: true, from: 1, to: 4 });
  }
  if (cfg.relegationPlayoff) z.push({ key: 'relegationPlayoffPct', label: `降級附加賽(第 ${n - cfg.relegated} 名)`, short: '降級附加賽', good: null, from: n - cfg.relegated, to: n - cfg.relegated });
  z.push({ key: 'relegationPct', label: `直接降級(後 ${cfg.relegated})`, short: '降級', good: false, from: n - cfg.relegated + 1, to: n });
  return z;
}

/* 名次分佈:一格一個名次,高度是機率。顏色照區間(冠軍 / 好區 / 降級),不用另外的圖例 —— 下面標名次 */
function posBar(dist, zones) {
  const max = Math.max(...dist, 1);
  const zoneOf = pos => zones.find(z => pos >= z.from && pos <= z.to && z.key !== 'titlePct') ?? null;
  return `<div class="whatif-pos" role="img" aria-label="名次分佈">${dist.map((v, i) => {
    const z = zoneOf(i + 1);
    const cls = i === 0 ? 'top' : z ? (z.good === false ? 'bad' : 'good') : '';
    return `<div class="whatif-pos-col" title="第 ${i + 1} 名 ${v.toFixed(1)}%"><i class="${cls}" style="height:${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%"></i><span>${i + 1}</span></div>`;
  }).join('')}</div>`;
}
