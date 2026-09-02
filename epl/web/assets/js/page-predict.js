import * as C from './core.js?v=0';
import { scorePredictions, outcomeOf, pickOf, matchKey, OUTCOMES } from './predict-score.js?v=0';

/* 我的預測(跨聯賽單一頁,掛對戰模擬旁邊)。
 *
 * 一輪一輪自己猜比分與勝負、寫下理由,賽季跑完看自己跟模型、跟市場誰準。
 *
 * 四條界線,每一條都寫在畫面上:
 *
 * 1. **完全不碰模型。** 預測只存在你自己的瀏覽器(localStorage),build 不讀、
 *    產物裡沒有、也不會回饋進任何機率。模型機率是獨立的,這一頁只是拿它當對手。
 * 2. **開賽就鎖。** 開球時間一到,那一場的輸入變唯讀 —— 賽後才填的不是預測,
 *    是回顧。計分那一層還有第二道守門(`isEligible`),匯入別人的檔案也擋得住。
 * 3. **模型與市場的機率在你按下儲存的當下就凍結進紀錄。** 不是事後重算的:
 *    build 的模型擬合含已完賽的比賽,重算等於讓模型看過答案再猜
 *    (這個專案為了同一件事修過一次,見 prediction / postFit)。
 * 4. **比較一律在同一批場次上做。** 市場盤口不是每場都抓得到,所以總表分成
 *    「你 vs 模型」與「你 vs 模型 vs 市場」兩組,各自標明樣本數。
 *
 * 資料放哪:localStorage 是**這台裝置這個瀏覽器**的東西 —— 清掉網站資料就沒了,
 * 換一台也看不到。所以頁面上有匯出/匯入,而且把這件事講清楚,不要讓人以為
 * 它存在雲端。
 */

const app = document.getElementById('app');
const STORE_KEY = 'warroom:predictions:v1';
const HIDE = 'this.style.display="none"';

/* localStorage 在無痕視窗、關閉網站資料、或某些嵌入情境會直接拋例外
   (不是回 null)。整頁不能因此掛掉 —— 讀不到就當成沒有紀錄,寫不進去要講。 */
function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function writeStore(obj) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); return true; }
  catch { return false; }
}

try {
  const lgs = Object.keys(C.LEAGUES);
  const loaded = await Promise.all(lgs.map(async lg => {
    try {
      const { data } = await C.loadFrom(lg, ['meta', 'fixtures', 'teams']);
      if (!Array.isArray(data.fixtures)) return null;
      return {
        lg, zh: C.LEAGUES[lg].zh, meta: data.meta, fixtures: data.fixtures,
        nameBy: new Map((data.teams ?? []).map(t => [t.code, t.zh ?? t.en ?? t.code])),
        crestBy: new Map((data.teams ?? []).map(t => [t.code, t.crest ?? null])),
      };
    } catch { return null; }
  }));
  const pools = loaded.filter(Boolean);
  if (!pools.length) throw new Error('沒有任何聯賽的賽程');
  C.nav();

  let store = readStore();
  let lockTimer = null;
  const state = { lg: pools[0].lg, round: null, tab: 'pick' };
  const cur = () => pools.find(x => x.lg === state.lg);
  const recsOf = lg => (store[lg] ??= {});
  const nameOf = code => cur().nameBy.get(code) ?? code;
  const crest = code => {
    const c = cur().crestBy.get(code);
    return c ? `<img class="crest" src="${c}" alt="" width="22" height="22" onerror='${HIDE}'>` : '';
  };

  /* 預設輪次 = 「還沒踢完的最小輪次」。用最小的而不是「下一場的輪次」——
     有場次提前開踢時,下一場可能屬於更後面的一輪(倒數那條坑的同一個形狀)。 */
  function defaultRound(L) {
    const open = L.fixtures.filter(f => !f.played && f.round != null).map(f => f.round);
    if (open.length) return Math.min(...open);
    const all = L.fixtures.filter(f => f.round != null).map(f => f.round);
    return all.length ? Math.max(...all) : null;
  }
  function roundsOf(L) {
    return [...new Set(L.fixtures.map(f => f.round).filter(r => r != null))].sort((a, b) => a - b);
  }

  const locked = f => {
    const ko = f.kickoff ? Date.parse(f.kickoff) : NaN;
    // 沒有開球時間的場次只能用「已完賽」判斷 —— 上游是逐月公布時間的
    return f.played || (Number.isFinite(ko) && Date.now() >= ko);
  };

  function render() {
    const L = cur();
    if (state.round == null) state.round = defaultRound(L);
    const recs = recsOf(state.lg);
    const scored = scorePredictions(recs, L.fixtures);
    app.innerHTML = `
    <div class="page-head">
      <h1>我的預測</h1>
      <p>一輪一輪自己猜,賽季結束看你跟模型、跟市場誰準。
        <b>預測只存在這台裝置的瀏覽器裡</b>,不上傳、不進本站資料,也<b>不會影響模型機率</b>。</p>
    </div>

    <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${pools.map(p => `<button class="btn ${p.lg === state.lg ? 'accent' : ''}" type="button"
        data-lg="${C.esc(p.lg)}">${C.esc(p.zh)}</button>`).join('')}
    </div>

    <div class="analysis-switch" role="tablist" aria-label="模式">
      <button class="btn analysis-tab ${state.tab === 'pick' ? 'on' : ''}" type="button" data-tab="pick">這一輪</button>
      <button class="btn analysis-tab ${state.tab === 'table' ? 'on' : ''}" type="button" data-tab="table">成績</button>
    </div>

    ${state.tab === 'pick' ? pickPanel(L, recs) : tablePanel(L, scored)}
    ${C.foot(L.meta)}`;
    bind();
  }

  function pickPanel(L, recs) {
    const rounds = roundsOf(L);
    const games = L.fixtures.filter(f => f.round === state.round)
      .sort((a, b) => String(a.kickoff ?? a.date ?? '').localeCompare(String(b.kickoff ?? b.date ?? '')));
    return `
    <div class="row" style="gap:8px;align-items:center;margin:14px 0">
      <label class="small dim">輪次</label>
      <select id="roundSel" class="btn">${rounds.map(r => `<option value="${r}"
        ${r === state.round ? 'selected' : ''}>第 ${r} 輪</option>`).join('')}</select>
      <span class="small dim">${games.filter(f => recs[matchKey(f)]).length} / ${games.length} 場已填</span>
    </div>
    ${(() => {
      /* 這一輪的截止倒數 = **還沒開賽的場次裡最早的那一場**。
         用最早的而不是「第一場」—— 這一輪可能已經踢掉幾場了。
         已經全部開踢就不畫這一行,不要留一個永遠 00:00:00 的倒數。 */
      const open = games.filter(f => !locked(f) && f.kickoff)
        .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
      if (!open.length) return '';
      const undone = open.filter(f => !recs[matchKey(f)]).length;
      return `<div class="note" style="margin-bottom:12px">
        <b>下一場截止還有 ${C.countdown(open[0].kickoff)}</b>
        —— ${C.esc(nameOf(open[0].home))} vs ${C.esc(nameOf(open[0].away))}。
        這一輪還有 <b>${open.length}</b> 場可以填${undone ? `,其中 <b>${undone}</b> 場還沒填` : '(都填過了)'}。
        <div class="tiny dim" style="margin-top:6px">倒數到 0 那一刻該場就鎖住 ——
          這一頁開著也會自己鎖,不用重新整理。</div>
      </div>`;
    })()}
    ${games.map(f => matchRow(f, recs[matchKey(f)])).join('')}
    <div class="note" style="margin-top:14px">
      <b>開球時間一到就鎖。</b>賽後才填的不是預測,所以鎖住的場次不能再改,
      計分也會把「開賽後才存的紀錄」排除掉。沒有公布開球時間的場次以「是否已完賽」判斷。
      <div class="tiny dim" style="margin-top:6px">按下儲存時,會把<b>當下</b>的模型機率與市場盤口一起存進這筆紀錄
        —— 之後不重算,因為賽後重算的模型已經看過結果了。</div>
    </div>`;
  }

  function matchRow(f, rec) {
    const key = matchKey(f);
    const lock = locked(f);
    /* 鎖住的場次顯示**紀錄裡凍結的那一份** —— 那才是你當時比對的對象,
       也是計分用的。已完賽場次的 `f.prediction` 可能是 null(沒有賽前快照),
       顯示成「—」會讓人以為那筆紀錄沒有對手。還能改的場次顯示現在的模型,
       因為你正要拿它來決定怎麼填。 */
    const p = (lock ? rec?.model ?? f.prediction : f.prediction) ?? null;
    const m = (lock ? rec?.market ?? f.market?.probs : f.market?.probs) ?? null;
    const mp = pickOf(p), kp = pickOf(m);
    const zh = { home: '主勝', draw: '和局', away: '客勝' };
    return `<div class="card" data-match="${C.esc(key)}"
      ${f.kickoff ? `data-ko="${C.esc(f.kickoff)}"` : ''} style="margin-bottom:10px">
      <div class="spread" style="align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div class="row" style="gap:7px;align-items:center">
          ${crest(f.home)}<b>${C.esc(nameOf(f.home))}</b>
          <span class="dim">vs</span>${crest(f.away)}<b>${C.esc(nameOf(f.away))}</b>
        </div>
        <span class="small dim">${f.kickoff ? C.kickoffLocal(f.kickoff) : C.dateFull(f.date)}
          ${lock
            ? `<span class="pill tiny warn" data-lockpill>${f.played ? `終場 ${f.fh}:${f.fa}` : '已開賽・鎖定'}</span>`
            : f.kickoff
              ? `<span class="pill tiny" data-deadline>截止 ${C.countdown(f.kickoff)}</span>`
              : '<span class="pill tiny dim">開球時間未定</span>'}</span>
      </div>

      <div class="row small dim" style="gap:14px;margin:8px 0;flex-wrap:wrap">
        <span>模型 ${p ? `${C.pct(p.home, 0)} / ${C.pct(p.draw, 0)} / ${C.pct(p.away, 0)}
          <b class="accent-text">${zh[mp]}</b>` : '—'}</span>
        <span>市場 ${m ? `${C.pct(m.home, 0)} / ${C.pct(m.draw, 0)} / ${C.pct(m.away, 0)}
          <b>${zh[kp]}</b>` : '<span class="dim">尚無盤口</span>'}</span>
      </div>

      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <input class="btn mono" type="number" min="0" max="20" style="width:62px" data-fh
          value="${rec?.fh ?? ''}" ${lock ? 'disabled' : ''} aria-label="主隊進球">
        <span class="dim">:</span>
        <input class="btn mono" type="number" min="0" max="20" style="width:62px" data-fa
          value="${rec?.fa ?? ''}" ${lock ? 'disabled' : ''} aria-label="客隊進球">
        ${OUTCOMES.map(o => `<button class="btn tiny ${rec?.pick === o ? 'accent' : ''}" type="button"
          data-pick="${o}" ${lock ? 'disabled' : ''}>${zh[o]}</button>`).join('')}
        <input class="btn" type="text" data-note placeholder="原因(選填)" style="flex:1;min-width:180px"
          value="${C.esc(rec?.note ?? '')}" ${lock ? 'disabled' : ''}>
        ${lock ? '' : '<button class="btn accent" type="button" data-save>儲存</button>'}
      </div>
      ${rec ? `<div class="tiny dim" style="margin-top:7px">已存於 ${C.kickoffLocal(rec.savedAt)}
        ${rec.market ? '・含當時盤口' : '・當時沒有盤口'}
        ${rec.note ? `<br>理由:${C.esc(rec.note)}` : ''}</div>` : ''}
    </div>`;
  }

  function tablePanel(L, s) {
    const zh = { home: '主勝', draw: '和局', away: '客勝' };
    const line = (label, t) => t ? `<div class="card" style="margin-bottom:10px">
        <div class="spread"><h3>${label}</h3><span class="pill tiny">${t.n} 場</span></div>
        <div class="stat-line"><span class="small"><b>你</b></span><b class="mono accent-text">${C.pct(t.you, 1)}</b></div>
        ${t.model != null ? `<div class="stat-line"><span class="small">模型最看好的那一邊</span><b class="mono">${C.pct(t.model, 1)}</b></div>` : ''}
        ${t.market != null
          ? `<div class="stat-line"><span class="small">市場最看好的那一邊</span><b class="mono">${C.pct(t.market, 1)}</b></div>`
          : '<div class="stat-line"><span class="small dim">市場最看好的那一邊</span><span class="tiny dim">這批比賽沒有盤口,不是 0%</span></div>'}
        <div class="tiny dim" style="margin-top:8px">RPS(越低越好):你 ${C.fx(t.youRps, 4)}
          ${t.modelRps != null ? `・模型 ${C.fx(t.modelRps, 4)}` : ''}${t.marketRps != null ? `・市場 ${C.fx(t.marketRps, 4)}` : ''}
          —— <b>你的預測被當成 100% 押一邊</b>來算(你給的是斷言、它們給的是機率),
          所以這個指標對你不利,看命中率比較公平。</div>
      </div>` : '';
    return `
    <div style="margin-top:14px"></div>
    ${s.vsModel ? '' : '<div class="note">這個聯賽還沒有已完賽的預測。到「這一輪」填幾場,踢完就會出現成績。</div>'}
    ${line('你 vs 模型', s.vsModel)}
    ${s.vsAll && s.vsAll.n !== s.vsModel?.n ? line('你 vs 模型 vs 市場(只算三邊都有的場次)', s.vsAll) : ''}
    ${s.exact ? `<div class="card" style="margin-bottom:10px"><div class="spread"><h3>比分完全猜中</h3>
      <span class="pill tiny">${s.exact.n} 場有填比分</span></div>
      <div class="stat-line"><span class="small">猜中場次</span>
        <b class="mono accent-text">${s.exact.hit} / ${s.exact.n}(${C.pct(s.exact.hit / s.exact.n, 1)})</b></div></div>` : ''}
    ${s.pending ? `<div class="note info">還有 ${s.pending} 場已填但沒踢完,踢完會自動算進去。</div>` : ''}
    ${s.ignored ? `<div class="note warn">有 ${s.ignored} 筆是<b>開賽後才存的</b>,不列入計分 —— 那不是預測。</div>` : ''}

    ${s.rows.filter(r => r.actual).length ? `<div class="section" style="margin-top:18px"><h2>逐場明細</h2>
      <span class="hint">新到舊</span></div>
      <div class="card"><div style="display:grid;gap:8px">
      ${[...s.rows].filter(r => r.actual).reverse().map(r => `<div class="stat-line" style="align-items:flex-start">
        <span class="small" style="flex:1">
          ${C.esc(nameOf(r.fixture.home))} <b class="mono">${r.fixture.fh}:${r.fixture.fa}</b> ${C.esc(nameOf(r.fixture.away))}
          <span class="dim tiny">・第 ${r.fixture.round} 輪</span>
          <br><span class="tiny">你 ${zh[r.rec.pick]}${r.rec.fh != null ? ` ${r.rec.fh}:${r.rec.fa}` : ''}
            <span class="${r.youHit ? 'accent-text' : 'dim'}">${r.youHit ? '✔' : '✘'}</span>
            ・模型 ${r.modelPick ? zh[r.modelPick] : '—'}
            <span class="${r.modelHit ? 'accent-text' : 'dim'}">${r.modelHit ? '✔' : '✘'}</span>
            ${r.marketPick ? `・市場 ${zh[r.marketPick]}
              <span class="${r.marketHit ? 'accent-text' : 'dim'}">${r.marketHit ? '✔' : '✘'}</span>` : '・市場 —'}
            ${r.eligible ? '' : '<span class="pill tiny warn">開賽後才存,不計分</span>'}</span>
          ${r.rec.note ? `<br><span class="tiny dim">理由:${C.esc(r.rec.note)}</span>` : ''}
        </span></div>`).join('')}
      </div></div>` : ''}

    <div class="section" style="margin-top:18px"><h2>備份</h2>
      <span class="hint">換裝置或清瀏覽器資料前記得匯出</span></div>
    <div class="card">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn" type="button" id="exportBtn">匯出 JSON</button>
        <button class="btn" type="button" id="importBtn">匯入 JSON</button>
      </div>
      <textarea id="ioBox" class="btn" style="width:100%;min-height:90px;margin-top:10px;display:none"
        placeholder="把匯出的 JSON 貼在這裡,再按一次「匯入 JSON」"></textarea>
      <div class="tiny dim" style="margin-top:8px"><b>這些預測只存在這台裝置的這個瀏覽器裡。</b>
        清掉網站資料、換瀏覽器或換裝置都看不到 —— 本站沒有帳號、沒有後端,也不會把它們上傳。
        單檔版(warroom.html)是另一個來源,兩邊的紀錄不共用。</div>
    </div>`;
  }

  function bind() {
    app.querySelectorAll('[data-lg]').forEach(b => b.onclick = () => {
      state.lg = b.dataset.lg; state.round = null; render();
    });
    app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; render(); });
    const sel = app.querySelector('#roundSel');
    if (sel) sel.onchange = () => { state.round = Number(sel.value); render(); };

    app.querySelectorAll('[data-match]').forEach(card => {
      const key = card.dataset.match;
      const fh = card.querySelector('[data-fh]'), fa = card.querySelector('[data-fa]');
      const pickBtns = [...card.querySelectorAll('[data-pick]')];
      /* 填了比分就把勝負推導出來 —— 兩個欄位講的是同一件事,
         讓使用者自己保持一致是把矛盾的可能留給他。仍然可以只選勝負不填比分。 */
      const syncPick = () => {
        if (fh.value === '' || fa.value === '') return;
        const o = outcomeOf(Number(fh.value), Number(fa.value));
        pickBtns.forEach(b => b.classList.toggle('accent', b.dataset.pick === o));
      };
      fh?.addEventListener('input', syncPick);
      fa?.addEventListener('input', syncPick);
      pickBtns.forEach(b => b.onclick = () => {
        pickBtns.forEach(x => x.classList.toggle('accent', x === b));
      });
      const saveBtn = card.querySelector('[data-save]');
      if (saveBtn) saveBtn.onclick = () => savePick(key, card);
    });

    /* 倒數與上鎖。**不整頁重畫** —— 重畫會把其他場次還沒按儲存的輸入洗掉,
       而這個掃描每秒都在跑。所以只動剛好越過開球時間的那一張卡。 */
    C.startCountdowns();
    /* render() 每次切分頁、換聯賽、按儲存都會跑一次 —— 不收掉舊的,
       秒數一久就變成十幾個掃描同時在跑(startCountdowns 自己會收,這個不會)。 */
    if (lockTimer) clearInterval(lockTimer);
    lockTimer = C.pageInterval(() => {
      const now = Date.now();
      for (const card of app.querySelectorAll('[data-ko]')) {
        const ko = Date.parse(card.dataset.ko);
        if (!Number.isFinite(ko) || now < ko) continue;
        if (card.dataset.locked === '1') continue;
        card.dataset.locked = '1';
        card.querySelectorAll('input, [data-pick]').forEach(el => { el.disabled = true; });
        card.querySelector('[data-save]')?.remove();
        const dl = card.querySelector('[data-deadline]');
        if (dl) { dl.className = 'pill tiny warn'; dl.textContent = '已開賽・鎖定'; }
      }
    }, 1000);

    const box = app.querySelector('#ioBox');
    const ex = app.querySelector('#exportBtn'), im = app.querySelector('#importBtn');
    if (ex) ex.onclick = () => { box.style.display = 'block'; box.value = JSON.stringify(store, null, 1); box.select(); };
    if (im) im.onclick = () => {
      if (box.style.display === 'none') { box.style.display = 'block'; box.value = ''; box.focus(); return; }
      try {
        const next = JSON.parse(box.value);
        if (!next || typeof next !== 'object') throw new Error('不是物件');
        store = next;
        if (!writeStore(store)) throw new Error('這個瀏覽器不讓本站存資料');
        render();
      } catch (e) { alert(`匯入失敗:${e.message}`); }
    };
  }

  function savePick(key, card) {
    const L = cur();
    const f = L.fixtures.find(x => matchKey(x) === key);
    if (!f || locked(f)) { render(); return; }      // 邊填邊開賽:存之前再確認一次
    const fh = card.querySelector('[data-fh]').value;
    const fa = card.querySelector('[data-fa]').value;
    const marked = card.querySelector('[data-pick].accent');
    const pick = marked?.dataset.pick
      ?? (fh !== '' && fa !== '' ? outcomeOf(Number(fh), Number(fa)) : null);
    if (!pick) { alert('選一個結果(主勝/和局/客勝),或把比分填完。'); return; }
    const P = f.prediction;
    recsOf(state.lg)[key] = {
      fh: fh === '' ? null : Number(fh),
      fa: fa === '' ? null : Number(fa),
      pick,
      note: card.querySelector('[data-note]').value.trim(),
      savedAt: new Date().toISOString(),
      kickoff: f.kickoff ?? null,
      round: f.round ?? null,
      // 凍結當下的兩份機率。只留 1X2 —— 計分要的就是這三個數
      model: P ? { home: P.home, draw: P.draw, away: P.away } : null,
      market: f.market?.probs ? { ...f.market.probs } : null,
    };
    if (!writeStore(store)) alert('存不進去 —— 這個瀏覽器擋掉了本站的資料儲存(無痕視窗?)。');
    render();
  }

  render();
} catch (e) {
  app.innerHTML = `<div class="note warn">載入失敗:${C.esc(e.message)}</div>`;
}
