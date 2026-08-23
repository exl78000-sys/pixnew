import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, coaches } = await C.load('meta', 'clubs', 'teams', 'coaches');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav('coaches.html');

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
    <p>沒有免費又穩定的教練 API,所以這份名冊是人工維護的(<span class="mono">data/manual/coaches.json</span>);
       但戰績不是 —— 只要填好任期起訖,系統就會自動用比賽日期切分,算出每位教練任內的真實成績。</p>
  </div>

  <div class="note">
    <b>資料鮮度提醒</b>:名冊整理時點為 <b>${coaches.asOf}</b>,${meta.currentSeason} 夏季之後的異動不會自動更新。
    請直接編輯 <span class="mono">data/manual/coaches.json</span> 的 <span class="mono">spells[]</span>(from / to 用 ISO 日期),
    再重跑 <span class="mono">npm run build</span>。標示「待確認」的欄位代表整理時無法確認,請務必查證。
  </div>

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
        <a href="teams.html?code=${c.team}">${C.badge(c.team, 'lg')}</a>
        <div style="flex:1">
          <div class="spread">
            <div style="font-weight:800;font-size:16px">${c.name ? C.esc(c.zh) : '待確認'}
              <span class="dim small" style="font-weight:400">${c.name ? C.esc(c.name) : ''}</span></div>
            ${confPill(c)}
          </div>
          <div class="tiny dim">${t.zh}${c.nat ? `・${c.nat}` : ''}${c.since ? `・${c.since} 上任(約 ${years} 年)` : ''}</div>
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
    { key: 'team', label: '球隊', value: c => C.zh(c.team), render: c => C.teamCell(c.team) },
    { key: 'p', label: '場次', value: c => c.seasonRecord.p, num: true },
    { key: 'w', label: '勝', value: c => c.seasonRecord.w, num: true },
    { key: 'd', label: '和', value: c => c.seasonRecord.d, num: true },
    { key: 'l', label: '負', value: c => c.seasonRecord.l, num: true },
    { key: 'gf', label: '進', value: c => c.seasonRecord.gf, num: true },
    { key: 'ga', label: '失', value: c => c.seasonRecord.ga, num: true },
    { key: 'winPct', label: '勝率', value: c => c.seasonRecord.winPct, num: true, render: c => `${c.seasonRecord.winPct}%` },
    { key: 'ppg', label: '場均勝點', value: c => c.seasonRecord.ppg, num: true, render: c => `<b>${c.seasonRecord.ppg}</b>` },
    { key: 'conf', label: '資料可信度', value: c => c.confidence, sortable: false, render: c => confPill(c) },
  ], { sortKey: 'ppg', desc: true, onRow: c => { location.href = `teams.html?code=${c.team}`; } });

} catch (err) { C.fail(err); }
