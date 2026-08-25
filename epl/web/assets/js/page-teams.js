import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, players, fixtures, coaches, goals, h2h, form } =
    await C.load('meta', 'clubs', 'teams', 'players', 'fixtures', 'coaches', 'goals', 'h2h', 'form');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const code = C.qs('code');
  const teamBy = new Map(teams.map(t => [t.code, t]));
  const coachBy = new Map(coaches.coaches.map(c => [c.team, c]));

  /* 教練資料原本自成一頁,現在併進來 —— 教練是球隊的屬性,
     一個人的任期、戰績、慣用陣型放在他帶的那支球隊底下才找得到。
     跨教練的比較(場均勝點排行)留在總覽頁,那裡本來就是「20 隊一起看」。 */
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

  code && teams.some(t => t.code === code) ? detail(teams.find(t => t.code === code)) : overview();

  /* 進球來源。
     能回答:對每一隊進幾球/被進幾球、誰進的、誰助攻、先發還是替補進的。
     FPL 事件不能把「某一球」分成運動戰/角球/任意球;上季球隊層級的
     五種進球情境已另由 Understat 摘要數據提供,放在戰術區。 */
  function goalSection(t) {
    const seasons = (goals?.seasons ?? []).filter(s => goals.data[s]?.teams?.[t.code]);
    if (!seasons.length) return '';
    const id = 'gs' + t.code;
    queueMicrotask(() => renderGoals(t, seasons.at(-1)));
    return `
    <div class="section" style="margin-top:18px"><h2>進球來源</h2>
      <span class="hint">逐場進球與助攻・${seasons.length > 1 ? '可切換賽季' : seasons[0]}</span></div>
    ${seasons.length > 1 ? `<div class="filters" style="margin-bottom:12px">
      <label>賽季</label><select id="${id}">
        ${seasons.map(s => `<option value="${s}" ${s === seasons.at(-1) ? 'selected' : ''}>${s}</option>`).join('')}
      </select></div>` : ''}
    <div id="${id}box"></div>`;
  }

  function renderGoals(t, season) {
    const id = 'gs' + t.code;
    const sel = document.getElementById(id);
    if (sel) sel.onchange = () => renderGoals(t, sel.value);
    const S = goals.data[season];
    const g = S?.teams?.[t.code];
    const box = document.getElementById(id + 'box');
    if (!box || !g) return;

    const col = t.chartColor ?? 'var(--accent)';
    const maxV = Math.max(1, ...g.vs.map(v => Math.max(v.f, v.a)));
    /* 對手用中性灰而不是對手的隊色 —— 19 個對手一起出現時,
       19 種顏色等於沒有顏色,重點反而看不出來。本隊用本隊的色,對手一律灰。

       每條都畫在一條淡軌道上:0 球的話條長是 0,沒有軌道就整列消失,
       讀者會以為那一列缺資料,而不是「這隊一球沒進」。 */
    const bar = (n, colour) => `<span style="flex:1;height:9px;border-radius:3px;background:var(--line-soft);
      position:relative;overflow:hidden">
      <span style="position:absolute;inset:0 auto 0 0;width:${(n / maxV) * 100}%;
        background:${colour};border-radius:3px"></span></span>`;

    const subPct = g.for ? (g.subGoals / (g.starterGoals + g.subGoals || 1)) * 100 : 0;
    const leaguePct = (S.subShare ?? 0) * 100;

    box.innerHTML = `
    <div class="grid g2">
      <div class="card">
        <h3>進球數</h3>
        <div class="grid g3" style="grid-template-columns:repeat(3,1fr);margin-top:4px">
          <div><div class="tiny dim">進球</div><div class="value mono" style="font-size:24px;font-weight:700">${g.for}</div></div>
          <div><div class="tiny dim">失球</div><div class="value mono" style="font-size:24px;font-weight:700">${g.against}</div></div>
          <div><div class="tiny dim">助攻</div><div class="value mono" style="font-size:24px;font-weight:700">${g.assists}</div></div>
        </div>
        <div class="stat-line" style="margin-top:10px"><span class="small muted">先發進球</span>
          <b class="mono">${g.starterGoals}</b></div>
        <div class="stat-line"><span class="small muted">替補進球</span>
          <b class="mono">${g.subGoals} <span class="dim tiny">${C.fx(subPct, 1)}%</span></b></div>
        <div class="tiny dim" style="margin-top:6px">
          全聯盟平均有 ${C.fx(leaguePct, 1)}% 的進球來自替補 ——
          這隊${subPct > leaguePct + 3 ? '<b>比平均更依賴板凳</b>' : subPct < leaguePct - 3 ? '<b>幾乎都靠先發解決</b>' : '跟平均差不多'}。
        </div>
        ${g.ownFor || g.ownAgainst ? `<div class="tiny dim" style="margin-top:6px">
          其中 ${g.ownFor} 球是對手的烏龍球;另有 ${g.ownAgainst} 球是自己人踢進自家門。
          上面的進球榜不含烏龍球(那不算任何人的進球)。</div>` : ''}
      </div>

      <div class="card">
        <h3>對誰進球</h3>
        <div class="tiny dim" style="margin-bottom:8px">
          <span style="display:inline-block;width:9px;height:9px;background:${col};border-radius:2px"></span> 進球
          ・<span style="display:inline-block;width:9px;height:9px;background:var(--ink-3);border-radius:2px"></span> 失球
        </div>
        <div style="display:grid;gap:5px;max-height:340px;overflow-y:auto">
          ${g.vs.map(v => `<div class="row" style="gap:8px;align-items:center;
            padding:3px 0;border-bottom:1px solid var(--line-soft)">
            <span class="small" style="width:78px;flex:none">${C.esc(C.name(v.opp))}</span>
            <span style="flex:1;display:grid;gap:3px">
              <span class="row" style="gap:6px;align-items:center">${bar(v.f, col)}
                <span class="tiny mono" style="width:14px;flex:none;text-align:right">${v.f}</span></span>
              <span class="row" style="gap:6px;align-items:center">${bar(v.a, 'var(--ink-3)')}
                <span class="tiny mono dim" style="width:14px;flex:none;text-align:right">${v.a}</span></span>
            </span></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>誰進的、誰助攻的</h3>
      <div id="${id}tbl"></div>
      <div class="tiny dim" style="margin-top:8px">
        每 90 分鐘的分母是<b>上場分鐘</b>,不是出賽場次。上場不足 450 分鐘的不給這個數字 ——
        替補上場十分鐘進一球換算成每 90 分鐘九球,那是誤導不是資訊。
        <br><b>這張表不把進球方式掛到個別球員。</b>FPL 事件沒有這個 qualifier;
        上季的球隊級運動戰、角球與任意球加總列在下方「上季進球方式」。
      </div>
    </div>`;

    document.getElementById(id + 'tbl').innerHTML = C.table(g.players, [
      { key: 'name', label: '球員', value: p => p.name,
        render: p => `<span class="team-cell">${C.playerPhoto({ code: p.code, name: p.name, team: t.code }, 24)}
          <span>${C.esc(p.name)}</span></span>` },
      { key: 'g', label: '進球', value: p => p.g, num: true, render: p => (p.g ? `<b>${p.g}</b>` : '—') },
      { key: 'a', label: '助攻', value: p => p.a, num: true, render: p => (p.a ? p.a : '—') },
      { key: 'start', label: '先發 / 替補', value: p => p.startG, sortable: false, num: true,
        title: '這名球員的進球中,先發上場與替補上場各幾球',
        render: p => (p.g ? `<span class="mono">${p.startG} <span class="dim">/</span> ${p.subG}</span>` : '—') },
      { key: 'min', label: '上場分鐘', value: p => p.min, num: true },
      { key: 'g90', label: '進球 / 90', value: p => p.g90 ?? -1, num: true, render: p => p.g90 ?? '—' },
      { key: 'a90', label: '助攻 / 90', value: p => p.a90 ?? -1, num: true, render: p => p.a90 ?? '—' },
    ], { sortKey: 'g', desc: true });
  }

  /* 單隊的教練區塊。原本整頁的教練卡就是這一段 ——
     搬過來之後,「誰在帶這支球隊、帶多久、成績如何」跟球隊的其他資料在同一頁,
     不用先猜要去哪一頁找。 */
  function coachCard(c) {
    if (!c) return '';
    const years = c.tenureDays ? (c.tenureDays / 365).toFixed(1) : null;
    const head = `<div class="spread" style="align-items:flex-start">
      <div><h3 style="margin:0">${c.name ? C.esc(c.zh ?? c.name) : '教練待確認'}
        <span class="dim small" style="font-weight:400">${c.zh && c.name ? C.esc(c.name) : ''}</span></h3>
        <div class="tiny dim" style="margin-top:2px">${c.nat ?? ''}${c.since ? `${c.nat ? '・' : ''}${c.since} 上任(約 ${years} 年)` : ''}</div></div>
      ${c.officialMismatch ? '<span class="pill accent tiny" title="英超官方登記的現任教練">官方現任</span>' : confPill(c)}
    </div>`;

    /* 官方說換人了、但本站還沒整理他的資料 —— 這種情況要說清楚,
       絕對不能把前任的戰績掛在新教練名下。 */
    const body = c.officialMismatch
      ? `<div class="note" style="margin-top:10px">
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
          <div class="tags" style="margin-top:6px">${(c.predecessor.style ?? []).map(x => `<span class="pill">${C.esc(x)}</span>`).join('')}</div>
        </div>` : ''}`
      : c.name
        ? `<div class="stat-line" style="margin-top:10px"><span class="small muted">${meta.lastSeason} 任內</span>
            <span class="small">${rec(c.seasonRecord)}</span></div>
          <div class="stat-line"><span class="small muted">近三季任內</span>
            <span class="small">${rec(c.allRecord)}</span></div>
          <div class="stat-line"><span class="small muted">慣用陣型</span><b class="mono">${c.formation ?? '—'}</b></div>
          <div class="tags" style="margin-top:8px">${(c.style ?? []).map(x => `<span class="pill">${C.esc(x)}</span>`).join('')}</div>
          ${c.note ? `<div class="small muted" style="margin-top:8px">${C.esc(c.note)}</div>` : ''}
          ${c.predecessors?.length ? `<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">
            <div class="tiny dim" style="margin-bottom:4px">同隊前任(${meta.lastSeason} 任內)</div>
            ${c.predecessors.map(p => `<div class="stat-line"><span class="small">${C.esc(p.zh ?? p.name)}
              <span class="dim tiny">${p.from ?? ''} ~ ${p.to ?? ''}</span></span>
              <span class="small mono">${p.seasonRecord.p ? `${p.seasonRecord.p} 場・場均 ${p.seasonRecord.ppg}` : '—'}</span></div>`).join('')}
          </div>` : ''}`
        : `<div class="note" style="margin-top:10px">${C.esc(c.note ?? '這支球隊的教練資料尚未整理。')}</div>`;

    return `<div class="section" style="margin-top:18px"><h2>教練</h2>
      <span class="hint">現任由英超官方每天核對・任期與風格為人工整理</span></div>
      <div class="card">${head}${body}</div>`;
  }

  /* ── 列表 ─────────────────────────── */
  function overview() {
    app.innerHTML = `
    <div class="page-head">
      <h1>球隊</h1>
      <p>${meta.currentSeason} 的 20 支球隊。卡片上的期望積分來自 ${meta.model.simulationRuns.toLocaleString()} 次賽季模擬,
         風格標籤則是從上季的每一場比賽與每一位球員的數據推出來的。點進去看完整剖析。</p>
    ${C.stampRow([
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算;GitHub Actions 每 15 分鐘跑一次' }),
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
    ])}
    </div>
    <div class="grid g3">${teams.map(card).join('')}</div>

    ${coachNotes()}
    <div class="section" style="margin-top:20px"><h2>教練席</h2>
      <span class="hint">戰績為 ${meta.lastSeason} 任內實際數字・點一列看該隊詳情</span></div>
    <div id="coachRank"></div>
    ${coachRankNote()}
    ${C.foot(meta)}`;

    renderCoachRank();
  }

  /* 教練資料的誠實層:哪些是官方每天核對的、哪些還是人工整理會過期的。
     這兩段原本在教練頁,不能因為併頁就弄丟 —— 讀者要知道哪個數字能信。 */
  function coachNotes() {
    const cur = coaches.coaches.filter(c => teamBy.has(c.team));
    const mism = cur.filter(c => c.officialMismatch);
    const days = Math.round((Date.now() - new Date(`${coaches.asOf}-01`).getTime()) / 86400000);

    const official = !coaches.officialAsOf ? '' : `<div class="note ${mism.length ? 'warn' : 'ok'}" style="margin-top:16px">
      <b>現任教練是誰,每天跟英超官方核對。</b>
      ${mism.length
        ? `<b>${mism.length} 隊在本站上次整理之後換了教練</b>,名字已改用官方的:
           <div style="margin-top:6px">${mism.map(c => `<div class="tiny">
             ${C.name(c.team)}:<b class="accent">${C.esc(c.name)}</b>
             <span class="dim">接替 ${C.esc(c.predecessor?.zh ?? c.predecessor?.name ?? '(空白)')}</span></div>`).join('')}</div>
           <div class="tiny dim" style="margin-top:6px">這幾位的任期、戰績與戰術風格本站還沒整理,
             球隊頁上只會看到前任的資料並標明是前任 —— 不會拿舊數字充當新教練的履歷。</div>`
        : `${cur.length} 隊的現任教練都和官方一致。`}
    </div>`;

    const manual = coaches.officialAsOf
      ? `<div class="note" style="margin-top:10px">
          <b>官方沒提供、仍是人工維護的部分</b>(整理時點 ${coaches.asOf},距今 ${days} 天):
          <div style="margin-top:6px" class="tiny">
            <b>任期起訖</b> —— 戰績是依這個日期切分比賽算出來的,日期不對戰績就會算到別人頭上。<br>
            <b>戰術風格與慣用陣型</b> —— 同一位教練也可能改打法,而且新教練完全沒有(共 ${mism.length} 位)。<br>
            <b>中文譯名</b> —— 沒有譯名的直接顯示英文,不會硬編一個。
          </div>
          <div class="tiny" style="margin-top:8px">
            補資料:編輯 <span class="mono">data/manual/coaches.json</span> ——
            把舊教練那筆的 <span class="mono">spells[0].to</span> 填上離任日期,再在最前面加一筆新教練
            (<span class="mono">to: null</span> 代表在任中),然後重跑 <span class="mono">npm run build</span>。
            <b>戰績不用手算</b>,系統會依任期日期自動切分比賽重算。
          </div>
        </div>`
      : (() => {
        const unsure = cur.filter(c => c.confidence !== 'high');
        const unknown = cur.filter(c => !c.name);
        const stale = days > 60;
        return `<div class="note ${stale ? 'warn' : ''}" style="margin-top:16px">
          <b>教練名冊已經 ${days} 天沒更新</b>(整理時點 ${coaches.asOf},今天 ${meta.asOf})。
          ${stale ? '這段期間<b>整個夏季轉會窗都過去了</b> —— 換帥通常就發生在這時候,所以有幾位很可能已經不在任上。' : ''}
          <div style="margin-top:8px">${cur.length} 隊裡 <b>${cur.length - unsure.length}</b> 隊標為長期在任、
            <b>${unsure.length}</b> 隊需要查證${unknown.length ? `、<b>${unknown.length}</b> 隊完全沒有資料` : ''}。
            ${unsure.length ? `<div class="tiny dim" style="margin-top:6px">需要查證:${unsure.map(c => C.name(c.team)).join('、')}</div>` : ''}</div>
        </div>`;
      })();

    return official + manual;
  }

  /* 排行只列得出「在這支球隊有任內比賽紀錄」的教練。
     本季有一半以上的球隊是新帥,他們在這裡沒有數字 —— 那是對的
     (不能把前任的成績掛在他頭上),但如果不講,讀者只會看到一張少了一半人的表
     而不知道為什麼。所以直接把缺席的隊伍點名出來。 */
  function coachRankNote() {
    const cur = coaches.coaches.filter(c => teamBy.has(c.team));
    const missing = cur.filter(c => !c.seasonRecord?.p);
    return `<div class="tiny dim" style="margin-top:8px">
      含賽季中途接手者,場次少的參考價值低。每位教練的任期、慣用陣型與風格標籤在各隊的詳情頁。
      ${missing.length ? `<br><b>${cur.length} 隊裡有 ${missing.length} 隊不在表上</b> ——
        他們的教練在 ${meta.lastSeason} 沒有帶過這支球隊(多半是這個夏天才上任),
        本站不會把前任的成績算到他頭上:
        ${missing.map(c => C.name(c.team)).join('、')}。` : ''}
    </div>`;
  }

  function renderCoachRank() {
    const rows = coaches.coaches.filter(c => c.seasonRecord?.p);
    document.getElementById('coachRank').innerHTML = C.table(rows, [
      { key: 'coach', label: '教練', value: c => c.zh ?? c.name ?? '',
        render: c => `${C.esc(c.zh ?? c.name ?? '')} <span class="dim tiny">${C.esc(c.zh ? (c.name ?? '') : '')}</span>` },
      { key: 'team', label: '球隊', value: c => C.name(c.team), render: c => C.teamCell(c.team) },
      { key: 'p', label: '場次', value: c => c.seasonRecord.p, num: true },
      { key: 'w', label: '勝', value: c => c.seasonRecord.w, num: true },
      { key: 'd', label: '和', value: c => c.seasonRecord.d, num: true },
      { key: 'l', label: '負', value: c => c.seasonRecord.l, num: true },
      { key: 'gf', label: '進', value: c => c.seasonRecord.gf, num: true },
      { key: 'ga', label: '失', value: c => c.seasonRecord.ga, num: true },
      { key: 'winPct', label: '勝率', value: c => c.seasonRecord.winPct, num: true, render: c => `${c.seasonRecord.winPct}%` },
      { key: 'ppg', label: '場均勝點', value: c => c.seasonRecord.ppg, num: true, render: c => `<b>${c.seasonRecord.ppg}</b>` },
      { key: 'conf', label: '資料可信度', value: c => c.confidence, sortable: false, render: confPill },
    ], { sortKey: 'ppg', desc: true, onRow: c => { C.go('teams', { code: c.team }); } });
  }

  function card(t) {
    const s = t.sim, ls = t.lastSeason;
    return `<a class="card" href="${C.link('teams', { code: t.code })}" style="text-decoration:none;color:inherit;display:block">
      <div class="row" style="gap:11px">${C.badge(t.code, 'lg')}
        <div><div style="font-weight:800;font-size:16px">${t.en}</div>
          <div class="tiny dim">${t.zh}・${t.venue}</div></div></div>
      <div class="grid g3" style="margin-top:12px;gap:8px">
        <div><div class="tiny dim">上季</div><div class="mono">${ls ? `第 ${ls.pos} 名 · ${ls.pts} 分` : '<span class="pill">升班馬</span>'}</div></div>
        <div><div class="tiny dim">期望積分</div><div class="mono"><b>${s?.expectedPoints ?? '—'}</b></div></div>
        <div><div class="tiny dim">前四 / 降級</div><div class="mono small">${s?.top4Pct ?? '—'}% / ${s?.relegationPct ?? '—'}%</div></div>
      </div>
      ${t.tactics ? `<div class="tags" style="margin-top:10px">${t.tactics.tags.slice(0, 4).map(x => `<span class="pill">${x}</span>`).join('')}</div>` : ''}
      <div class="row tiny dim" style="margin-top:10px;justify-content:space-between">
        <span>${t.coach?.name ? `教練 ${t.coach.zh}` : '教練待補'}</span>
        <span>${t.injuries ? `<span style="color:var(--loss)">傷停 ${t.injuries}</span>` : '無傷停回報'}</span>
      </div></a>`;
  }

  // 近期與交手都是「資訊」,不是模型特徵。兩者做過跨季走查後沒有穩定增益,
  // 所以球隊頁可以完整呈現,但不能讓讀者誤以為它們已經改動上方預測。
  function recentCard(t) {
    const f = form?.teams?.[t.code];
    if (!f) return '<div class="card"><h3>近期比賽</h3><div class="dim small">尚無近期賽果。</div></div>';
    const s = f.summary;
    const runs = f.recent.map(r => `<i class="frm ${r.res}"
      title="${C.esc(`${r.date}・${r.venue === 'H' ? '主' : '客'}場對 ${C.name(r.opp)}・${r.gf}-${r.ga}`)}">${r.res}</i>`).join('');
    return `<div class="card"><h3>近期 ${s.games} 場</h3>
      <div class="row" style="gap:8px;align-items:center;margin-bottom:10px">
        <span class="form-run">${runs}</span>
        <b class="small">${s.w}勝 ${s.d}和 ${s.l}負・勝率 ${s.winPct}%</b>
      </div>
      <div class="grid g3" style="grid-template-columns:repeat(3,1fr);margin-bottom:8px">
        <div><div class="tiny dim">進 / 失</div><b class="mono">${s.gf} / ${s.ga}</b></div>
        <div><div class="tiny dim">場均勝點</div><b class="mono">${C.fx(s.ppg, 2)}</b></div>
        <div><div class="tiny dim">樣本</div><b class="mono">${s.games} 場</b></div>
      </div>
      ${f.recent.map(r => `<div class="stat-line">
        <span class="small"><i class="frm ${r.res}">${r.res}</i> ${r.venue === 'H' ? '主' : '客'} vs ${C.teamLink(r.opp)}</span>
        <span class="mono small">${r.gf}-${r.ga} <span class="dim">${C.dateFull(r.date)}</span></span></div>`).join('')}
      <div class="tiny dim" style="margin-top:8px">跨賽季取最近五場;不影響模型勝率。</div>
    </div>`;
  }

  function h2hCard(t, selected) {
    const opponents = teams.filter(x => x.code !== t.code)
      .sort((a, b) => C.name(a.code).localeCompare(C.name(b.code), 'zh-Hant'));
    return `<div class="card"><div class="spread" style="align-items:center;gap:10px">
      <h3 style="margin:0">面對對手過往</h3>
      <select id="teamH2HOpp" aria-label="選擇交手對手">
        ${opponents.map(o => `<option value="${o.code}" ${o.code === selected ? 'selected' : ''}>${C.esc(C.name(o.code))}</option>`).join('')}
      </select></div>
      <div class="tiny dim" style="margin:6px 0 8px">英超 ${C.esc(meta.h2hSeasons?.[0] ?? '')} 起・不影響模型勝率</div>
      <div id="teamH2HBox"></div>
    </div>`;
  }

  function renderTeamH2H(t) {
    const sel = document.getElementById('teamH2HOpp');
    const box = document.getElementById('teamH2HBox');
    if (!sel || !box) return;
    sel.onchange = () => renderTeamH2H(t);
    const opp = sel.value;
    const key = [t.code, opp].sort().join('|');
    const rec = h2h?.[key];
    if (!rec) {
      box.innerHTML = `<div class="small" style="margin-bottom:8px">對手球隊：${C.teamLink(opp)}</div>
        <div class="dim small">${C.esc(meta.h2hSeasons?.[0] ?? '')} 以來沒有在英超交手過。</div>`;
      return;
    }
    const ownIsA = key.split('|')[0] === t.code;
    const w = ownIsA ? rec.aWin : rec.bWin;
    const l = ownIsA ? rec.bWin : rec.aWin;
    const gf = ownIsA ? rec.aGoals : rec.bGoals;
    const ga = ownIsA ? rec.bGoals : rec.aGoals;
    const winPct = rec.games ? Math.round((w / rec.games) * 1000) / 10 : 0;
    box.innerHTML = `<div class="small" style="margin-bottom:8px">對手球隊：${C.teamLink(opp)}</div>
    <div class="grid g3" style="grid-template-columns:repeat(3,1fr);margin-bottom:8px">
      <div><div class="tiny dim">勝 / 和 / 負</div><b class="mono">${w} / ${rec.draw} / ${l}</b></div>
      <div><div class="tiny dim">進 / 失</div><b class="mono">${gf} / ${ga}</b></div>
      <div><div class="tiny dim">交手勝率</div><b class="mono">${winPct}%</b></div>
    </div>
    ${rec.list.slice(0, 5).map(m => `<div class="stat-line"><span class="small dim mono">${C.dateFull(m.date)}</span>
      <span class="small">${C.teamLink(m.home)} <b class="mono">${m.fh}-${m.fa}</b> ${C.teamLink(m.away)}</span></div>`).join('')}`;
  }

  function seasonHistorySection(t) {
    const seasons = [...(t.history ?? [])].reverse();
    if (!seasons.length) return '';
    const rows = seasons.flatMap(s => [
      { ...s, scope: s.season === meta.currentSeason ? '目前' : '全季' },
      { season: s.season, ...s.first10, scope: `前 10 場${s.first10.p < 10 ? `(${s.first10.p}/10)` : ''}` },
    ]);
    return `<div class="section"><h2>逐季攻守</h2>
      <span class="hint">全季與開季前 10 場並列</span></div>
    <div class="card">${C.table(rows, [
      { key: 'season', label: '賽季', value: r => r.season, left: true,
        render: r => `<b>${r.season}</b>${r.season === meta.currentSeason ? ' <span class="pill accent tiny">進行中</span>' : ''}` },
      { key: 'scope', label: '範圍', value: r => r.scope, left: true },
      { key: 'p', label: '場', value: r => r.p, num: true },
      { key: 'record', label: '勝 / 和 / 負', value: r => r.w, sortable: false, num: true,
        render: r => `${r.w} / ${r.d} / ${r.l}` },
      { key: 'winPct', label: '勝率', value: r => r.winPct, num: true, render: r => `${r.winPct}%` },
      { key: 'gf', label: '進球', value: r => r.gf, num: true },
      { key: 'ga', label: '失球', value: r => r.ga, num: true },
      { key: 'gd', label: '淨勝', value: r => r.gd, num: true, render: r => C.signed(r.gd, 0) },
      { key: 'avgGF', label: '場均進球', value: r => r.avgGF ?? -1, num: true, render: r => r.avgGF ?? '—' },
      { key: 'avgGA', label: '場均失球', value: r => r.avgGA ?? -1, num: true, render: r => r.avgGA ?? '—' },
      { key: 'cleanSheets', label: '零封', value: r => r.cleanSheets, num: true },
    ], { sortKey: null })}
      <div class="tiny dim" style="margin-top:8px">
        防守以失球、場均失球與零封呈現。上一完整賽季的運動戰、角球、其他定位球、
        直接任意球與十二碼進失球,列在下方戰術區。
      </div>
    </div>`;
  }

  function goalSituationCard(tac) {
    if (!tac?.setPieces?.available) return '';
    const sp = tac.setPieces;
    const rows = [
      ['openPlay', '運動戰'], ['corner', '角球'], ['otherSetPiece', '其他定位球'],
      ['directFreeKick', '直接任意球'], ['penalty', '十二碼'],
    ].map(([key, label]) => ({ label, ...sp.breakdown[key] }));
    return `<div class="card" style="margin-top:14px"><div class="spread">
      <h3 style="margin:0">上季進球方式</h3><span class="pill tiny">${meta.lastSeason}</span></div>
      <div class="grid g4" style="margin:12px 0">
        <div><div class="tiny dim">非十二碼定位球</div><b class="mono">${sp.goals} 球</b></div>
        <div><div class="tiny dim">定位球 xG</div><b class="mono">${C.fx(sp.xG, 2)}</b></div>
        <div><div class="tiny dim">定位球失球</div><b class="mono">${sp.conceded}</b></div>
        <div><div class="tiny dim">定位球 xGA</div><b class="mono">${C.fx(sp.xGA, 2)}</b></div>
      </div>
      ${C.table(rows, [
        { key: 'label', label: '情境', value: r => r.label, left: true },
        { key: 'goals', label: '進球', value: r => r.goals, num: true },
        { key: 'xg', label: 'xG', value: r => r.xG, num: true, render: r => C.fx(r.xG, 2) },
        { key: 'shots', label: '射門', value: r => r.shots, num: true },
        { key: 'against', label: '失球', value: r => r.against.goals, num: true },
        { key: 'xga', label: 'xGA', value: r => r.against.xG, num: true, render: r => C.fx(r.against.xG, 2) },
      ], { sortKey: null })}
      <div class="tiny dim" style="margin-top:8px">
        來源: <a href="${C.esc(sp.sourceUrl)}" target="_blank" rel="noopener">Understat</a>。
        「其他定位球」是非角球、非直接任意球的定位球;
        五類進失球已跟聯賽實際比分逐隊核對。
      </div></div>`;
  }

  /* ── 單隊 ─────────────────────────── */
  function detail(t) {
    const ls = t.lastSeason, tac = t.tactics, s = t.sim, co = coachBy.get(t.code);
    const squad = players.filter(p => p.team === t.code);
    const out = squad.filter(p => p.news && p.status !== 'a');
    const next = fixtures.filter(f => !f.played && (f.home === t.code || f.away === t.code)).slice(0, 6);
    const h2hDefault = next[0]
      ? (next[0].home === t.code ? next[0].away : next[0].home)
      : teams.find(x => x.code !== t.code)?.code;

    const kpi = (l, v, sub = '') => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`;
    const line = (l, v) => `<div class="stat-line"><span class="small muted">${l}</span><b class="mono">${v}</b></div>`;

    app.innerHTML = `
    <div class="page-head">
      <div class="row" style="gap:14px">${C.badge(t.code, 'xl')}
        <div><h1 style="margin:0">${t.en}<span class="dim" style="font-size:15px;font-weight:400"> ${t.zh}・${t.nickname}</span></h1>
          <p class="small">${t.venue}・${t.city}・可容納 ${t.capacity.toLocaleString()} 人
            ${co?.name ? `・教練 <b>${co.zh}</b>(${co.nat})` : '・教練資料待補'}</p></div></div>
      <div class="row small" style="margin-top:6px"><a href="${C.link('teams')}">← 回球隊列表</a></div>
    </div>

    <div class="grid g4">
      ${kpi('上季名次', ls ? `第 ${ls.pos} 名` : '升班馬', ls ? `${ls.pts} 分・場均 ${ls.ppg}` : `${meta.lastSeason} 未在英超`)}
      ${kpi('本季期望積分', s?.expectedPoints ?? '—', `期望名次 第 ${s?.expectedPos ?? '—'} 名`)}
      ${kpi('前四機率', `${s?.top4Pct ?? '—'}%`, `奪冠 ${s?.titlePct ?? '—'}%`)}
      ${kpi('降級機率', `${s?.relegationPct ?? '—'}%`, `Elo ${C.fx(t.elo, 0)}`)}
    </div>

    <div class="grid g2" style="margin-top:16px">
      ${recentCard(t)}
      ${h2hCard(t, h2hDefault)}
    </div>

    ${seasonHistorySection(t)}

    ${ls ? `
    <div class="section"><h2>上季戰績剖析</h2><span class="hint">${meta.lastSeason}</span></div>
    <div class="grid g2">
      <div class="card"><h3>基本戰績</h3>
        ${line('勝 / 和 / 負', `${ls.w} / ${ls.d} / ${ls.l}`)}
        ${line('進球 / 失球 / 淨勝', `${ls.gf} / ${ls.ga} / ${C.signed(ls.gd, 0)}`)}
        ${line('主場場均勝點', ls.home.ppg)}
        ${line('客場場均勝點', ls.away.ppg)}
        ${line('主客落差', C.signed(ls.homeAwayGap, 2))}
        ${line('零封場次', ls.cleanSheets)}
        ${line('最長連勝 / 不敗', `${ls.longest.win} / ${ls.longest.unbeaten}`)}
        ${line('雙方進球比例', `${ls.bttsPct}%`)}
        ${line('大於 2.5 球比例', `${ls.over25Pct}%`)}
      </div>
      <div class="card"><h3>半場行為</h3>
        ${line('上半場 進 / 失', `${ls.half.gf1} / ${ls.half.ga1}`)}
        ${line('下半場 進 / 失', `${ls.half.gf2} / ${ls.half.ga2}`)}
        ${line('下半場淨勝球增減', C.signed(ls.half.secondHalfSwing, 1))}
        ${line('半場領先場次', ls.half.htLead)}
        ${line('領先保分率', ls.half.leadHoldPct === null ? '—' : `${ls.half.leadHoldPct}%`)}
        ${line('半場落後場次', ls.half.htTrail)}
        ${line('落後搶分率', ls.half.trailRescuePct === null ? '—' : `${ls.half.trailRescuePct}%`)}
        ${line('逆轉 / 被逆轉', `${ls.half.comeback} / ${ls.half.collapse}`)}
        <div class="tiny dim" style="margin-top:8px">領先保分率 = 半場領先的比賽中,實際拿到的分數佔可能分數的比例。</div>
      </div>
    </div>` : `<div class="note" style="margin-top:16px">${t.en} 上季不在英超,所有上季指標從缺;
      模型改用「聯盟後段先驗」估計強度,不確定性標得比較大。</div>`}

    ${coachCard(co)}

    ${goalSection(t)}

    <div class="grid g2" style="margin-top:14px">
      ${tac ? `<div class="card"><h3>戰術風格</h3>
        ${C.radar([{ name: t.en, color: t.colors[0], values: tac.radar }], { size: 300 })}
        <div class="tags" style="margin-top:8px">${tac.tags.map(x => `<span class="pill accent">${x}</span>`).join('')}</div>
        <div class="tiny dim" style="margin-top:8px">數值為該指標在 20 隊中的百分位。</div>
      </div>
      <div class="card"><h3>人員配置與細節</h3>
        ${line('後場 / 中場 / 鋒線人力', tac.formation.label)}
        ${line('體系判讀', tac.formation.shape)}
        ${line('每場期望進球 xG', tac.attack.xG90)}
        ${line('每場期望失球 xGA', tac.defence.xGA90)}
        ${line('終結超出期望', C.signed(tac.attack.finishing, 1))}
        ${line('門將守住的期望失球', C.signed(tac.defence.overperform, 1))}
        ${tac.setPieces.available ? `
          ${line('非十二碼定位球 進 / 失', `${tac.setPieces.goals} / ${tac.setPieces.conceded}`)}
          ${line('定位球 xG / 場', tac.setPieces.xG90)}
          ${line('定位球 xGA / 場', tac.setPieces.xGA90)}`
          : line('後場球員進球佔比(代理)', `${tac.setPieces.defenderGoalShare}%`)}
        ${line('使用球員數', tac.squad.used)}
        ${line('前 11 人出場佔比', `${tac.squad.top11Share}%`)}
        ${line('出場加權平均年齡', tac.squad.avgAgeWeighted)}
        ${line('每場黃紅牌加權', tac.discipline.perGame)}
        <div class="tiny dim" style="margin-top:8px">${tac.formation.notes.join('・') || '　'}</div>
      </div>` : ''}
    </div>

    ${goalSituationCard(tac)}

    ${tac ? `<div class="card" style="margin-top:14px"><h3>定位球主罰順位</h3>
      <div class="grid g3">
        ${[['pen', '十二碼'], ['fk', '直接自由球'], ['corner', '角球/間接球']].map(([k, l]) => `
          <div><div class="tiny dim">${l}</div>${(tac.setPieces.takers[k] ?? []).length
            ? tac.setPieces.takers[k].map(x => `<div class="small">${x.order}. ${C.esc(x.name)}</div>`).join('')
            : '<div class="small dim">未登錄</div>'}</div>`).join('')}
      </div></div>` : ''}

    ${t.eloHistory?.length ? `<div class="card" style="margin-top:14px"><h3>Elo 實力走勢</h3>
      ${C.sparkline(t.eloHistory.map(h => h.r), { color: t.colors[0] })}
      <div class="tiny dim">最近 ${t.eloHistory.length} 場・目前 ${C.fx(t.elo, 0)}</div></div>` : ''}

    ${t.schedule ? `<div class="section"><h2>開季賽程</h2><span class="hint">FPL 官方難度 1(易)~5(難)</span></div>
    <div class="card"><div class="grid g3">
      ${t.schedule.detail.map(d => `<div class="stat-line">
        <span class="small">第 ${d.event} 輪 ${d.home ? '主' : '客'} ${C.name(d.opp)}</span>
        <span class="pill ${d.diff >= 4 ? 'bad' : d.diff <= 2 ? 'accent' : 'warn'}">${d.diff}</span></div>`).join('')}
    </div><div class="tiny dim" style="margin-top:8px">前 ${t.schedule.detail.length} 輪平均難度 ${t.schedule.avg}</div></div>` : ''}

    <div class="section"><h2>陣容</h2><span class="hint">${squad.length} 人・下表數據為上季 ${meta.lastSeason} 的表現</span></div>
    ${out.length ? `<div class="note" style="margin-bottom:10px">傷停/異動 ${out.length} 人:
      ${out.map(p => `${C.esc(p.name)}(${C.esc(p.statusZh)})`).join('、')}</div>` : ''}
    <div id="squad"></div>

    ${next.length ? `<div class="card" style="margin-top:14px"><h3>接下來的對手</h3>
      ${next.map(f => {
        const isHome = f.home === t.code;
        const p = f.prediction;
        const win = isHome ? p.home : p.away;
        return `<a href="${C.link('fixtures', { id: f.id })}" style="color:inherit;text-decoration:none">
          <div class="stat-line"><span class="small">${C.dateFull(f.date)} ${isHome ? '主' : '客'} vs ${C.name(isHome ? f.away : f.home)}</span>
          <span class="mono small">勝率 ${C.pct(win, 0)}</span></div></a>`;
      }).join('')}</div>` : ''}
    ${C.foot(meta)}`;

    document.getElementById('squad').innerHTML = C.table(squad, [
      { key: 'name', label: '球員', value: p => p.name,
        render: p => `${C.esc(p.name)}${p.squadNumber ? ` <span class="dim tiny">#${p.squadNumber}</span>` : ''}${p.status !== 'a' ? ' <span class="pill bad tiny">' + p.statusZh + '</span>' : ''}${p.transferred ? ` <span class="pill tiny">來自 ${C.name(p.lastTeam)}</span>` : ''}` },
      { key: 'pos', label: '位置', value: p => ['GK', 'DEF', 'MID', 'FWD'].indexOf(p.pos), render: p => p.posZh },
      { key: 'age', label: '年齡', value: p => p.age ?? 0, num: true },
      { key: 'minutes', label: '上季分鐘', value: p => p.last?.minutes ?? 0, num: true, render: p => p.last?.minutes ?? '—' },
      { key: 'goals', label: '上季進球', value: p => p.last?.goals ?? 0, num: true, render: p => p.last?.goals ?? '—' },
      { key: 'assists', label: '上季助攻', value: p => p.last?.assists ?? 0, num: true, render: p => p.last?.assists ?? '—' },
      { key: 'curMin', label: '本季分鐘', value: p => p.current?.minutes ?? 0, num: true,
        render: p => p.current?.minutes ?? '—' },
      { key: 'curGoals', label: '本季進球', value: p => p.current?.goals ?? 0, num: true,
        render: p => p.current?.goals ?? '—' },
      { key: 'xgi90', label: 'xGI/90', value: p => p.last?.xgi90 ?? 0, num: true, render: p => (p.qualified ? p.last.xgi90 : '—') },
      { key: 'defCon90', label: '防守貢獻/90', value: p => p.last?.defCon90 ?? 0, num: true, render: p => (p.qualified ? p.last.defCon90 : '—') },
      { key: 'price', label: '身價', value: p => p.price, num: true, render: p => `£${p.price.toFixed(1)}m` },
    ], { sortKey: 'minutes', desc: true, onRow: p => { C.go('players', { code: p.code }); } });
    renderTeamH2H(t);
  }
} catch (err) { C.fail(err); }
