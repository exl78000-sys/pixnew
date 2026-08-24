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
        ? `<b>${mism.length} 隊已經換帥</b>,本站名冊還沒更新 —— 下面這幾隊請以官方那一欄為準:
           <div style="margin-top:6px">${mism.map(c => `<div class="tiny">
             ${C.name(c.team)}:名冊寫 <b>${c.name || '(空白)'}</b>,官方是 <b class="accent">${c.officialName}</b></div>`).join('')}</div>
           <div class="tiny dim" style="margin-top:6px">戰術風格與任期起訖還是舊教練的,先別當成新教練的特徵在讀。</div>`
        : `20 隊的現任教練都和官方一致。`}
    </div>`;
  })()}

  ${(() => {
    // 講「資料可能過期」沒有用,要講「過期多久、幾隊沒把握、哪幾隊」,讀者才知道該不該信
    const days = Math.round((Date.now() - new Date(`${coaches.asOf}-01`).getTime()) / 86400000);
    const unsure = current.filter(c => c.confidence !== 'high');
    const unknown = current.filter(c => !c.name);
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
            <div style="font-weight:800;font-size:16px">${c.name ? C.esc(c.zh) : '待確認'}
              <span class="dim small" style="font-weight:400">${c.name ? C.esc(c.name) : ''}</span></div>
            ${c.officialMismatch ? '<span class="pill bad tiny" title="英超官方登記的現任教練不是這一位">已換帥</span>' : confPill(c)}
          </div>
          ${c.officialMismatch ? `<div class="tiny" style="color:var(--accent);margin-top:2px">
            官方現任:<b>${C.esc(c.officialName)}</b>(下面的戰術與戰績仍屬前任)</div>` : ''}
          <div class="tiny dim">${t.en}${c.nat ? `・${c.nat}` : ''}${c.since ? `・${c.since} 上任(約 ${years} 年)` : ''}</div>
        </div>
      </div>
      ${c.name ? `
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
    { key: 'coach', label: '教練', value: c => c.zh ?? '', render: c => `${C.esc(c.zh)} <span class="dim tiny">${C.esc(c.name ?? '')}</span>` },
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
