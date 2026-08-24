import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, coaches } = await C.load('meta', 'clubs', 'teams', 'coaches');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const teamBy = new Map(teams.map(t => [t.code, t]));
  const list = [...coaches.coaches].sort((a, b) => (b.seasonRecord?.ppg ?? -1) - (a.seasonRecord?.ppg ?? -1));
  const current = list.filter(c => teamBy.has(c.team));
  const gone = list.filter(c => !teamBy.has(c.team));
  const CONF = { high: ['accent', '長期在任'], medium: ['warn', '需留意異動'], low: ['bad', '可信度低'], unknown: ['bad', '待確認'] };

  const confPill = c => {
    // 官方核對過就別再顯示「需留意異動」—— 那個標籤問的問題已經有答案了
    if (coaches.officialAsOf && c.officialName) {
      return '<span class="pill accent tiny" title="英超官方登記的現任教練">官方確認在任</span>';
    }
    const [cls, label] = CONF[c.confidence] ?? ['', c.confidence];
    return `<span class="pill ${cls} tiny">${label}</span>`;
  };
  const rec = r => (r && r.p ? `${r.p} 場・${r.w}勝${r.d}和${r.l}負・場均 <b>${r.ppg}</b> 分` : '任內無本季比賽紀錄');

  app.innerHTML = `
  <div class="page-head">
    <h1>教練</h1>
    <p>${coaches.officialAsOf
      ? `現任是誰以<b>英超官方</b>為準(每天核對一次);戰術風格與任期起訖仍是人工整理的
         (<span class="mono">data/manual/coaches.json</span>)。戰績兩者都不用手算 ——
         只要任期起訖填對,系統就會用比賽日期切分,算出每位教練任內的真實成績。`
      : `沒有免費又穩定的教練 API,所以這份名冊是人工維護的(<span class="mono">data/manual/coaches.json</span>);
         但戰績不是 —— 只要填好任期起訖,系統就會自動用比賽日期切分,算出每位教練任內的真實成績。`}</p>
    ${C.stampRow([
      coaches.officialAsOf
        ? C.stamp('英超官方現任名單', { iso: coaches.officialAsOf, kind: 'daily', note: 'pulselive・每天核對一次' })
        : null,
      C.stamp('戰術風格與任期', { kind: 'manual', note: '人工整理,夏季異動不會自動更新' }),
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算;GitHub Actions 每 15 分鐘跑一次' }),
    ])}
  </div>

  ${(() => {
    // 接上官方名單後,「可能過期」就不用猜了 —— 直接把不一致的隊伍點名出來
    const mism = current.filter(c => c.officialMismatch);
    if (!coaches.officialAsOf) return '';
    return `<div class="note ${mism.length ? 'warn' : 'ok'}">
      <b>已和英超官方核對過。</b>
      ${mism.length
        ? `<b>${mism.length} 隊在本站上次整理之後換了教練</b>,名字已改用官方的:
           <div style="margin-top:6px">${mism.map(c => `<div class="tiny">
             ${C.name(c.team)}:<b class="accent">${C.esc(c.name)}</b>
             <span class="dim">接替 ${C.esc(c.predecessor?.zh ?? c.predecessor?.name ?? '(空白)')}</span></div>`).join('')}</div>
           <div class="tiny dim" style="margin-top:6px">這幾位的任期、戰績與戰術風格本站還沒整理,
             卡片上只會看到前任的資料並標明是前任 —— 不會拿舊數字充當新教練的履歷。</div>`
        : `20 隊的現任教練都和官方一致。`}
    </div>`;
  })()}

  ${(() => {
    const days = Math.round((Date.now() - new Date(`${coaches.asOf}-01`).getTime()) / 86400000);
    const unsure = current.filter(c => c.confidence !== 'high');
    const unknown = current.filter(c => !c.name);
    const mism = current.filter(c => c.officialMismatch);

    // 接了官方名單之後,「他還在不在任上」已經不用猜了 ——
    // 剩下會過期的是任期起訖、戰術風格與中文譯名,講清楚是這些,不要再嚇人
    if (coaches.officialAsOf) {
      return `<div class="note">
        <b>還有什麼是人工維護、可能過期的。</b>
        現任是誰每天跟官方核對,20 隊都確定了;但下面這些官方沒有提供,仍是人工整理的
        (整理時點 ${coaches.asOf},距今 ${days} 天):
        <div style="margin-top:6px" class="tiny">
          <b>任期起訖</b> —— 戰績是依這個日期切分比賽算出來的,日期不對戰績就會算到別人頭上。<br>
          <b>戰術風格與慣用陣型</b> —— 同一位教練也可能改打法,而且新教練完全沒有(共 ${mism.length} 位)。<br>
          <b>中文譯名</b> —— 沒有譯名的直接顯示英文,不會硬編一個。
        </div>
        <div class="tiny" style="margin-top:8px">
          補上新教練的資料:編輯 <span class="mono">data/manual/coaches.json</span> ——
          把舊教練那筆的 <span class="mono">spells[0].to</span> 填上離任日期,再在最前面加一筆新教練
          (<span class="mono">to: null</span> 代表在任中),然後重跑 <span class="mono">npm run build</span>。
          <b>戰績不用手算</b>,系統會依任期日期自動切分比賽重算。
        </div>
      </div>`;
    }

    // 沒有官方資料時,只能講「過期多久、幾隊沒把握、哪幾隊」,讀者才知道該不該信
    const stale = days > 60;
    return `<div class="note ${stale ? 'warn' : ''}">
      <b>這份名冊已經 ${days} 天沒更新</b>(整理時點 ${coaches.asOf},今天 ${meta.asOf})。
      ${stale ? `這段期間<b>整個夏季轉會窗都過去了</b> —— 換帥通常就發生在這時候,
        所以下面有幾位很可能已經不在任上。` : ''}
      <div style="margin-top:8px">
        20 隊裡 <b>${current.length - unsure.length}</b> 隊標為長期在任、
        <b>${unsure.length}</b> 隊需要查證${unknown.length ? `、<b>${unknown.length}</b> 隊完全沒有資料` : ''}。
        ${unsure.length ? `<div class="tiny dim" style="margin-top:6px">需要查證:${unsure.map(c => C.name(c.team)).join('、')}</div>` : ''}
      </div>
      <div class="tiny" style="margin-top:8px">
        更新方式:編輯 <span class="mono">data/manual/coaches.json</span> —— 換帥時把舊教練那筆的
        <span class="mono">spells[0].to</span> 填上離任日期,再在最前面加一筆新教練
        (<span class="mono">to: null</span> 代表在任中),然後重跑 <span class="mono">npm run build</span>。
        <b>戰績不用手算</b>,系統會依任期日期自動切分比賽重算。
      </div>
    </div>`;
  })()}

  <div class="section"><h2>本季教練席</h2><span class="hint">戰績為 ${meta.lastSeason} 任內實際數字</span></div>
  <div class="grid g2">${current.map(cardHtml).join('')}</div>

  <div class="section"><h2>任內場均勝點排行</h2><span class="hint">含賽季中途接手者,場次少的參考價值低</span></div>
  <div id="rank"></div>

  ${gone.length ? `<div class="section"><h2>已降級球隊的教練</h2><span class="hint">保留供上季戰績對照</span></div>
  <div class="grid g2">${gone.map(cardHtml).join('')}</div>` : ''}
  ${C.foot(meta)}`;

  function cardHtml(c) {
    const t = C.team(c.team);
    const years = c.tenureDays ? (c.tenureDays / 365).toFixed(1) : null;
    return `<div class="card">
      <div class="row" style="gap:11px">
        <a href="${C.link('teams', { code: c.team })}">${C.badge(c.team, 'lg')}</a>
        <div style="flex:1">
          <div class="spread">
            <div style="font-weight:800;font-size:16px">${c.name ? C.esc(c.zh ?? c.name) : '待確認'}
              <span class="dim small" style="font-weight:400">${c.zh && c.name ? C.esc(c.name) : ''}</span></div>
            ${c.officialMismatch ? '<span class="pill accent tiny" title="英超官方登記的現任教練">官方現任</span>' : confPill(c)}
          </div>
          <div class="tiny dim">${t.en}${c.nat ? `・${c.nat}` : ''}${c.since ? `・${c.since} 上任(約 ${years} 年)` : ''}</div>
        </div>
      </div>
      ${c.officialMismatch ? `
        <div class="note" style="margin-top:10px">
          <b>本站還沒有這位教練的資料。</b>名字取自英超官方,但任期、戰績與戰術風格尚未整理 ——
          不會拿前任的數字充當他的履歷。
        </div>
        ${c.predecessor ? `<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">
          <div class="tiny dim" style="margin-bottom:4px">前任 ${C.esc(c.predecessor.zh ?? c.predecessor.name ?? '(空白)')}
            <span class="dim">${c.predecessor.name && c.predecessor.zh ? C.esc(c.predecessor.name) : ''}</span>
            ${c.predecessor.since ? `・${c.predecessor.since} 上任` : ''}</div>
          <div class="stat-line"><span class="small muted">${meta.lastSeason} 任內</span>
            <span class="small">${rec(c.predecessor.seasonRecord)}</span></div>
          <div class="stat-line"><span class="small muted">慣用陣型</span>
            <b class="mono">${c.predecessor.formation ?? '—'}</b></div>
          <div class="tags" style="margin-top:6px">${(c.predecessor.style ?? []).map(x => `<span class="pill">${x}</span>`).join('')}</div>
        </div>` : ''}`
      : c.name ? `
        <div class="stat-line" style="margin-top:10px"><span class="small muted">${meta.lastSeason} 任內</span>
          <span class="small">${rec(c.seasonRecord)}</span></div>
        <div class="stat-line"><span class="small muted">近三季任內</span>
          <span class="small">${rec(c.allRecord)}</span></div>
        <div class="stat-line"><span class="small muted">慣用陣型</span><b class="mono">${c.formation ?? '—'}</b></div>
        <div class="tags" style="margin-top:8px">${c.style.map(s => `<span class="pill">${s}</span>`).join('')}</div>
        ${c.note ? `<div class="small muted" style="margin-top:8px">${C.esc(c.note)}</div>` : ''}
        ${c.predecessors.length ? `<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">
          <div class="tiny dim" style="margin-bottom:4px">同隊前任(${meta.lastSeason} 任內)</div>
          ${c.predecessors.map(p => `<div class="stat-line"><span class="small">${C.esc(p.zh ?? p.name)}
            <span class="dim tiny">${p.from ?? ''} ~ ${p.to ?? ''}</span></span>
            <span class="small mono">${p.seasonRecord.p ? `${p.seasonRecord.p} 場・場均 ${p.seasonRecord.ppg}` : '—'}</span></div>`).join('')}
        </div>` : ''}`
        : `<div class="note" style="margin-top:10px">${C.esc(c.note)}</div>`}
    </div>`;
  }

  const rankRows = current.concat(gone).filter(c => c.seasonRecord?.p);
  document.getElementById('rank').innerHTML = C.table(rankRows, [
    { key: 'coach', label: '教練', value: c => c.zh ?? c.name ?? '', render: c => `${C.esc(c.zh ?? c.name ?? '')} <span class="dim tiny">${C.esc(c.zh ? (c.name ?? '') : '')}</span>` },
    { key: 'team', label: '球隊', value: c => C.name(c.team), render: c => C.teamCell(c.team) },
    { key: 'p', label: '場次', value: c => c.seasonRecord.p, num: true },
    { key: 'w', label: '勝', value: c => c.seasonRecord.w, num: true },
    { key: 'd', label: '和', value: c => c.seasonRecord.d, num: true },
    { key: 'l', label: '負', value: c => c.seasonRecord.l, num: true },
    { key: 'gf', label: '進', value: c => c.seasonRecord.gf, num: true },
    { key: 'ga', label: '失', value: c => c.seasonRecord.ga, num: true },
    { key: 'winPct', label: '勝率', value: c => c.seasonRecord.winPct, num: true, render: c => `${c.seasonRecord.winPct}%` },
    { key: 'ppg', label: '場均勝點', value: c => c.seasonRecord.ppg, num: true, render: c => `<b>${c.seasonRecord.ppg}</b>` },
    { key: 'conf', label: '資料可信度', value: c => c.confidence, sortable: false, render: c => confPill(c) },
  ], { sortKey: 'ppg', desc: true, onRow: c => { C.go('teams', { code: c.team }); } });

} catch (err) { C.fail(err); }
