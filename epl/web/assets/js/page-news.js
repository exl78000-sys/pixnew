import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, news } = await C.load('meta', 'clubs', 'teams', 'news');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const cats = [...new Set(news.map(n => n.cat))];
  const codes = [...new Set(news.map(n => n.team).filter(Boolean))].sort((a, b) => C.name(a).localeCompare(C.name(b), 'zh-Hant'));
  const CLS = { 傷停: 'bad', 禁賽: 'bad', 轉會: 'info', 賽前: 'info', 賽程: 'warn', 數據: 'accent', 戰術: 'accent', 陣容: '', 外電: 'warn' };
  let cat = '';

  app.innerHTML = `
  <div class="page-head">
    <h1>動態</h1>
    <p>三種來源:<b>傷停與轉會</b>來自 FPL 官方欄位(含更新日期,是真的即時資料);
       <b>賽前看點</b>由預測模型自動生成;<b>數據 / 戰術 / 陣容</b>則是從上季 380 場比賽跑出來的敘事。
       外部新聞 RSS 可以自行接上(見 <span class="mono">scripts/fetch-news.mjs</span>)。</p>
  </div>
  <div class="filters">
    <button class="btn on" data-c="">全部</button>
    ${cats.map(c => `<button class="btn" data-c="${c}">${c}</button>`).join('')}
    <select id="fTeam"><option value="">所有球隊</option>${codes.map(c => `<option value="${c}">${C.name(c)}</option>`).join('')}</select>
    <span class="dim small" id="count"></span>
  </div>
  <div id="feed" class="grid" style="gap:10px"></div>
  ${C.foot(meta)}`;

  const render = () => {
    const t = document.getElementById('fTeam').value;
    const rows = news.filter(n => (!cat || n.cat === cat) && (!t || n.team === t));
    document.getElementById('count').textContent = `共 ${rows.length} 則`;
    document.getElementById('feed').innerHTML = rows.map(n => `
      <div class="card" style="padding:12px 14px">
        <div class="row" style="gap:8px">
          <span class="pill ${CLS[n.cat] ?? ''}">${n.cat}</span>
          <span class="dim tiny mono">${C.dateFull(n.date)}</span>
          ${n.team ? C.teamCell(n.team) : ''}
        </div>
        <div style="font-weight:700;margin-top:6px">${C.esc(n.title)}</div>
        <div class="small muted" style="margin-top:3px">${C.esc(n.body)}</div>
        ${n.fixtureId ? `<div class="small" style="margin-top:6px"><a href="${C.link('fixtures', { id: n.fixtureId })}">看這場的完整分析 →</a></div>` : ''}
        ${n.link ? `<div class="small" style="margin-top:6px"><a href="${C.esc(n.link)}" target="_blank" rel="noopener">${C.esc(n.source ?? '原文')} →</a></div>` : ''}
      </div>`).join('') || '<div class="note">沒有符合條件的動態。</div>';
  };

  document.querySelectorAll('[data-c]').forEach(b => {
    b.onclick = () => {
      cat = b.dataset.c;
      document.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', x === b));
      render();
    };
  });
  document.getElementById('fTeam').onchange = render;
  render();

} catch (err) { C.fail(err); }
