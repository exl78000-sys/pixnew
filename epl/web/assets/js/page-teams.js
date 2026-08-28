import * as C from './core.js?v=95deb3b8';

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
      return '<span class="pill accent tiny" title="聯賽官方登記的現任教練">官方確認在任</span>';
    }
    /* **沒有任期資料就不准說「長期在任」。** confidence=high 的原意是
       「這個人選我們有把握」,但標籤寫成「長期在任」講的是任期長短 ——
       而西甲的 since / tenureDays 全部是 null,我們根本不知道他帶多久。
       同一頁下面才剛寫「接任日期上游沒有」,上面卻說長期在任,那是自相矛盾。 */
    if (c.confidence === 'high' && c.since == null && c.tenureDays == null) {
      return '<span class="pill accent tiny" title="姓名已與聯賽官方核對;任期長短本站沒有資料">姓名已核對</span>';
    }
    const [cls, label] = CONF[c.confidence] ?? ['', c.confidence];
    return `<span class="pill ${cls} tiny">${label}</span>`;
  };
  const coachAvatar = (c, size = 48) => c?.imagePath
    ? `<img class="coach-avatar coach-photo" src="${C.esc(c.imagePath)}" alt="${C.esc(c.name ?? '教練')}" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="coach-avatar" aria-hidden="true">${C.esc((c?.name ?? '教').slice(0, 1))}</span>`;
  /* 場均勝點:英超那份 seasonRecord 有 ppg,外部交付的本季戰績沒有 ——
     直接印 r.ppg 會變成「場均 undefined 分」。自己算(純算術,不是估計)。 */
  const recPpg = r => (r.ppg ?? Math.round(((r.w * 3 + r.d) / r.p) * 100) / 100);
  const rec = r => (r && r.p ? `${r.p} 場・${r.w}勝${r.d}和${r.l}負・場均 <b>${C.fx(recPpg(r), 2)}</b> 分` : '任內無比賽紀錄');


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
    ${goals.note ? `<div class="tiny dim" style="margin:-4px 0 10px">${C.esc(goals.note)}</div>` : ''}
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

    /* 有些賽季的來源沒有「先發還是替補」(逐球事件就沒有),那一季
       startKnown 是 false、starterGoals/subGoals/subShare 都是 null。
       那整個區塊要**整段換掉**而不是印 null 或 0 —— 印 0 會被讀成
       「這隊沒有替補進球」,那是編出來的。 */
    const startKnown = S.startKnown !== false && g.starterGoals != null;
    const subPct = startKnown && g.for ? (g.subGoals / (g.starterGoals + g.subGoals || 1)) * 100 : 0;
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
        ${startKnown ? `<div class="stat-line" style="margin-top:10px"><span class="small muted">先發進球</span>
          <b class="mono">${g.starterGoals}</b></div>
        <div class="stat-line"><span class="small muted">替補進球</span>
          <b class="mono">${g.subGoals} <span class="dim tiny">${C.fx(subPct, 1)}%</span></b></div>
        <div class="tiny dim" style="margin-top:6px">
          全聯盟平均有 ${C.fx(leaguePct, 1)}% 的進球來自替補 ——
          這隊${subPct > leaguePct + 3 ? '<b>比平均更依賴板凳</b>' : subPct < leaguePct - 3 ? '<b>幾乎都靠先發解決</b>' : '跟平均差不多'}。
        </div>` : `<div class="tiny dim" style="margin-top:10px">
          這一季的來源是逐球事件,<b>沒有「先發還是替補」這個欄位</b>,
          所以先發／替補進球的拆分與全聯盟比較做不了 —— 不給比給一個假的好。</div>`}
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
        ${S.minKnown === false ? `這一季的來源是<b>逐球事件</b>,只記錄「哪一分鐘、誰進的」,
          <b>沒有上場分鐘、也沒有先發或替補</b>。那三欄一律留「—」,
          每 90 分鐘的換算也做不了 —— 補一個 0 進去會被讀成「沒上場卻進了球」。`
        : `每 90 分鐘的分母是<b>上場分鐘</b>,不是出賽場次。上場不足 450 分鐘的不給這個數字 ——
          替補上場十分鐘進一球換算成每 90 分鐘九球,那是誤導不是資訊。`}
        <br><b>這張表不把進球方式掛到個別球員。</b>逐球事件沒有這個 qualifier;
        球隊層級的運動戰、角球與任意球加總來自 Understat,列在戰術區。
      </div>
    </div>`;

    /* 一球未進的球隊(例如剛升上來、首輪就輸的)進球榜是空的。
       只印表頭會看起來像載入失敗,直接說「還沒有進球」比較清楚。 */
    document.getElementById(id + 'tbl').innerHTML = g.players.length
      ? C.table(g.players, [
      { key: 'name', label: '球員', value: p => p.name,
        render: p => `<span class="team-cell">${C.playerPhoto({ code: p.code, name: p.name, team: t.code }, 24)}
          <span>${C.esc(p.name)}</span></span>` },
      { key: 'g', label: '進球', value: p => p.g, num: true, render: p => (p.g ? `<b>${p.g}</b>` : '—') },
      { key: 'a', label: '助攻', value: p => p.a, num: true, render: p => (p.a ? p.a : '—') },
      /* startG / min 是 null 的時候要印「—」而不是 0。
         `0 / 1` 會被讀成「先發沒進、替補進一球」,上場分鐘 0 會被讀成
         「他沒上場卻進了球」—— 兩個都是這個來源根本沒給的東西。 */
      { key: 'start', label: '先發 / 替補', value: p => p.startG ?? -1, sortable: false, num: true,
        title: '這名球員的進球中,先發上場與替補上場各幾球',
        render: p => (p.g && p.startG != null ? `<span class="mono">${p.startG} <span class="dim">/</span> ${p.subG}</span>` : '—') },
      { key: 'min', label: '上場分鐘', value: p => p.min ?? -1, num: true, render: p => p.min ?? '—' },
      { key: 'g90', label: '進球 / 90', value: p => p.g90 ?? -1, num: true, render: p => p.g90 ?? '—' },
      { key: 'a90', label: '助攻 / 90', value: p => p.a90 ?? -1, num: true, render: p => p.a90 ?? '—' },
      ], { sortKey: 'g', desc: true })
      : '<div class="note">這一季還沒有進球,所以進球榜是空的 —— 不是資料缺漏。</div>';
  }

  /* 單隊的教練區塊。原本整頁的教練卡就是這一段 ——
     搬過來之後,「誰在帶這支球隊、帶多久、成績如何」跟球隊的其他資料在同一頁,
     不用先猜要去哪一頁找。 */
  function coachCard(c) {
    if (!c) return '';
    const years = c.tenureDays ? (c.tenureDays / 365).toFixed(1) : null;
    /* 頭像與姓名要包在同一個 row 裡。以前是 spread 的三個直接子元素
       (頭像 / 姓名 / 標籤),姓名那格在沒有第二行說明時(西甲沒有任期)
       會被 space-between 推到正中間,看起來像跟頭像沒關係。 */
    const meta2 = [c.nat, c.since ? `${c.since} 上任(約 ${years} 年)` : null].filter(Boolean).join('・');
    const head = `<div class="spread" style="align-items:flex-start">
      <div class="row" style="gap:10px;align-items:flex-start">${coachAvatar(c, 48)}
        <div><h3 style="margin:0">${c.name ? C.esc(c.zh ?? c.name) : '教練待確認'}
          <span class="dim small" style="font-weight:400">${c.zh && c.name ? C.esc(c.name) : ''}</span></h3>
          ${meta2 ? `<div class="tiny dim" style="margin-top:2px">${C.esc(meta2)}</div>` : ''}</div></div>
      ${c.officialMismatch ? '<span class="pill accent tiny" title="聯賽官方登記的現任教練">官方現任</span>' : confPill(c)}
    </div>`;

    /* 官方說換人了、但本站還沒整理他的資料 —— 這種情況要說清楚,
       絕對不能把前任的戰績掛在新教練名下。 */
    const body = c.officialMismatch
      ? `<div class="note" style="margin-top:10px">
          <b>本站還沒有這位教練的資料。</b>名字取自聯賽官方,但任期、戰績與戰術風格尚未整理 ——
          不會拿前任的數字充當他的履歷。
        </div>
        ${c.predecessor?.name ? `<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">
          <div class="tiny dim" style="margin-bottom:4px">前任 ${C.esc(c.predecessor.zh ?? c.predecessor.name)}
            <span class="dim">${c.predecessor.zh ? C.esc(c.predecessor.name) : ''}</span>
            ${c.predecessor.since ? `・${c.predecessor.since} 上任` : ''}</div>
          ${/* 前任也一樣只列有值的:換帥後接不上的球隊(例如 Hull)前任本來就是空的,
                硬列會印出「前任 待確認 / 任內無比賽紀錄 / 慣用陣型 —」三行空殼。 */''}
          ${c.predecessor.seasonRecord?.p ? `<div class="stat-line"><span class="small muted">${meta.lastSeason} 任內</span>
            <span class="small">${rec(c.predecessor.seasonRecord)}</span></div>` : ''}
          ${c.predecessor.formation ? `<div class="stat-line"><span class="small muted">慣用陣型</span>
            <b class="mono">${C.esc(c.predecessor.formation)}</b></div>` : ''}
          ${(c.predecessor.style ?? []).length ? `<div class="tags" style="margin-top:6px">${c.predecessor.style.map(x => `<span class="pill">${C.esc(x)}</span>`).join('')}</div>` : ''}
        </div>` : ''}`
      : c.name
        ? `${[
            /* **只列真的有值的那幾行。**
               西甲的 seasonRecord / allRecord / formation 全部是 null,
               照英超那份寫死會印出兩行「任內無本季比賽紀錄」加一個「—」——
               看起來像壞掉,實際是我們沒有這些資料(鐵則三)。
               反過來,currentSeasonRecord(本季、外部交付並核對過)兩個聯賽都有,
               但這張卡以前一行都沒顯示。 */
            c.currentSeasonRecord?.p ? [`${c.currentSeasonRecord.season ?? meta.currentSeason} 任內`, rec(c.currentSeasonRecord)] : null,
            c.seasonRecord?.p ? [`${meta.lastSeason} 任內`, rec(c.seasonRecord)] : null,
            c.allRecord?.p ? ['近三季任內', rec(c.allRecord)] : null,
            c.formation ? ['慣用陣型', `<b class="mono">${C.esc(c.formation)}</b>`] : null,
          ].filter(Boolean).map(([l, v], i) => `<div class="stat-line"${i ? '' : ' style="margin-top:10px"'}>
            <span class="small muted">${l}</span><span class="small">${v}</span></div>`).join('')}
          ${(c.style ?? []).length ? `<div class="tags" style="margin-top:8px">${c.style.map(x => `<span class="pill">${C.esc(x)}</span>`).join('')}</div>` : ''}
          ${c.note ? `<div class="small muted" style="margin-top:8px">${C.esc(c.note)}</div>` : ''}
          ${c.predecessors?.length ? `<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">
            <div class="tiny dim" style="margin-bottom:4px">同隊前任(${meta.lastSeason} 任內)</div>
            ${c.predecessors.map(p => `<div class="stat-line"><span class="small">${C.esc(p.zh ?? p.name)}
              <span class="dim tiny">${p.from ?? ''} ~ ${p.to ?? ''}</span></span>
              <span class="small mono">${p.seasonRecord.p ? `${p.seasonRecord.p} 場・場均 ${p.seasonRecord.ppg}` : '—'}</span></div>`).join('')}
          </div>` : ''}`
        : `<div class="note" style="margin-top:10px">${C.esc(c.note ?? '這支球隊的教練資料尚未整理。')}</div>`;

    /* 這句 hint 以前寫死「英超官方」。西甲的來源是 LaLiga 官方,
       而且西甲的任期與風格**根本還沒整理**,照抄過去兩句都是假的。 */
    const hint = [
      coaches.officialAsOf ? `現任由 ${C.esc(coaches.source ?? '聯賽官方')} 核對` : null,
      c.since || c.style?.length ? '任期與風格為人工整理' : '任期與風格尚未整理',
    ].filter(Boolean).join('・');
    return `<div class="section" style="margin-top:18px"><h2>教練</h2>
      <span class="hint">${hint}</span></div>
      <div class="card">${head}${body}</div>`;
  }

  /* ── 陣容 ──────────────────────────
     兩個聯賽的球員資料**契約不同**,不是版面不同:
     英超一位球員一筆、裡面有 last / current 兩個子物件;
     西甲是一位球員一季一筆、統計欄位攤平在最上層,而且要靠隊名反查隊碼。

     所以「挑出這支球隊的球員」是一個 adapter(squadRows),
     「這個聯賽有哪些欄位」是一份欄位表(squadColumns)——
     這兩個本來就該分聯賽;真正共用的是外框、排序、點一列跳球員頁。
     照抄英超那張表過去會多出身價、防守貢獻、傷停三整欄的「—」(鐵則三)。 */
  function squadRows(t) {
    if (meta.edition !== 'basic') return players.filter(p => p.team === t.code);
    return players.filter(p => p.season === meta.lastSeason
      && (p.teams ?? []).some(name => (clubs.concat(teams).find(x =>
        x.code === p.sportmonksTeam || x.en === name || x.understat === name
        || (x.alias ?? []).includes(name))?.code ?? p.sportmonksTeam) === t.code));
  }

  function squadColumns() {
    const nameCell = extra => ({
      key: 'name', label: '球員', value: p => p.name,
      render: p => `${C.esc(p.name)}${p.squadNumber ? ` <span class="dim tiny">#${p.squadNumber}${C.numberSourceMark(p)}</span>` : ''}${extra(p)}`,
    });
    if (meta.edition === 'basic') {
      return [
        nameCell(p => (p.multiTeam ? ' <span class="pill warn tiny" title="上季效力過兩隊,數字是兩隊合計">跨隊</span>' : '')),
        { key: 'pos', label: '位置', value: p => ['GK', 'D', 'M', 'F'].indexOf(p.pos), render: p => p.posZh },
        { key: 'age', label: '年齡', value: p => p.age ?? 0, num: true, render: p => p.age ?? '—' },
        { key: 'games', label: '場次', value: p => p.games ?? 0, num: true },
        { key: 'minutes', label: '分鐘', value: p => p.minutes ?? 0, num: true },
        { key: 'goals', label: '進球', value: p => p.goals ?? 0, num: true },
        { key: 'assists', label: '助攻', value: p => p.assists ?? 0, num: true },
        // 每 90 分鐘的數字只在達門檻時才有值,不足的照實給「—」而不是補 0
        { key: 'xgi90', label: 'xGI/90', value: p => p.xgi90 ?? -1, num: true, render: p => p.xgi90 ?? '—' },
      ];
    }
    return [
      nameCell(p => `${p.status !== 'a' ? ` <span class="pill bad tiny">${p.statusZh}</span>` : ''}${
        p.transferred ? ` <span class="pill tiny">來自 ${C.name(p.lastTeam)}</span>` : ''}`),
      { key: 'pos', label: '位置', value: p => ['GK', 'DEF', 'MID', 'FWD'].indexOf(p.pos), render: p => p.posZh },
      { key: 'age', label: '年齡', value: p => p.age ?? 0, num: true },
      { key: 'minutes', label: '上季分鐘', value: p => p.last?.minutes ?? 0, num: true, render: p => p.last?.minutes ?? '—' },
      { key: 'goals', label: '上季進球', value: p => p.last?.goals ?? 0, num: true, render: p => p.last?.goals ?? '—' },
      { key: 'assists', label: '上季助攻', value: p => p.last?.assists ?? 0, num: true, render: p => p.last?.assists ?? '—' },
      { key: 'curMin', label: '本季分鐘', value: p => p.current?.minutes ?? 0, num: true, render: p => p.current?.minutes ?? '—' },
      { key: 'curGoals', label: '本季進球', value: p => p.current?.goals ?? 0, num: true, render: p => p.current?.goals ?? '—' },
      { key: 'xgi90', label: 'xGI/90', value: p => p.last?.xgi90 ?? 0, num: true, render: p => (p.qualified ? p.last.xgi90 : '—') },
      { key: 'defCon90', label: '防守貢獻/90', value: p => p.last?.defCon90 ?? 0, num: true, render: p => (p.qualified ? p.last.defCon90 : '—') },
      { key: 'price', label: '身價', value: p => p.price, num: true, render: p => `£${p.price.toFixed(1)}m` },
    ];
  }

  function squadSection(t) {
    const rows = squadRows(t);
    if (!rows.length) return '';
    const out = meta.edition === 'basic' ? [] : rows.filter(p => p.news && p.status !== 'a');
    return `<div class="section" style="margin-top:20px"><h2>陣容</h2>
      <span class="hint">${rows.length} 人・數據為 ${meta.lastSeason} 的表現</span></div>
    ${out.length ? `<div class="note" style="margin-bottom:10px">傷停/異動 ${out.length} 人:
      ${out.map(p => `${C.esc(p.name)}(${C.esc(p.statusZh)})`).join('、')}</div>` : ''}
    <div id="squad"></div>`;
  }

  function renderSquad(t) {
    const rows = squadRows(t);
    const el = document.getElementById('squad');
    if (!el || !rows.length) return;
    el.innerHTML = C.table(rows, squadColumns(), {
      sortKey: 'minutes', desc: true,
      onRow: p => { C.go('players', { code: p.code ?? p.id }); },
    });
  }



  /* ── 列表 ─────────────────────────── */
  /* 球隊列表。兩個聯賽共用 —— basicOverview 已經收掉。
     開場那段文字是**內容**不是版面,兩個聯賽本來就該講不同的話
     (英超有球員級數據與傷停,西甲沒有),所以留一個小函式各給各的;
     卡片、教練席、教練資料的誠實層則是同一份。 */
  function overviewIntro() {
    /* **隊數不可以寫死。** 原本兩個分支都寫「20 支球隊」—— 英超西甲剛好都是 20,
       所以三年都沒事;英冠是 24 隊,照抄就會在畫面上印一個假數字。
       數字一律從資料來。 */
    const n = teams.length;
    const runs = meta.model.simulationRuns.toLocaleString();
    /* 沒有球員資料的聯賽(英冠)要自己講一句實話 —— 不能套用下面那句
       「風格標籤來自每一位球員的數據」,那在這裡是不存在的東西。 */
    if (meta.capabilities?.players === false) {
      return `${meta.currentSeason} 的 ${n} 支球隊。卡片上的期望積分來自 ${runs} 次賽季模擬。
        這個聯賽沒有球員級資料源,所以沒有陣容、xG 與風格標籤 ——
        詳情頁有的是戰績、近期表現、主客場差異與歷來交手。`;
    }
    if (meta.edition === 'basic') {
      return `${meta.currentSeason} 的 ${n} 支球隊。除戰績、近期表現與模型模擬外,
        回歸球隊另有 ${meta.lastSeason} 真實 xG、射門、陣型與進球情境;
        球員與教練資料已由可用來源接入,傷停目前沒有可靠來源。`;
    }
    return `${meta.currentSeason} 的 ${n} 支球隊。卡片上的期望積分來自 ${runs} 次賽季模擬,
      風格標籤則是從上季的每一場比賽與每一位球員的數據推出來的。點進去看完整剖析。`;
  }

  function overview() {
    const stamps = [
      C.stamp('賽程、預測、積分榜', { iso: meta.builtAt, kind: 'daily', note: '每次 build 重算' }),
      C.stamp(`${meta.lastSeason} 全季統計`, { kind: 'season', note: '上季已完結,數字不會再變' }),
    ];
    app.innerHTML = `
    <div class="page-head">
      <h1>球隊</h1>
      <p>${overviewIntro()}</p>
      ${C.stampRow(stamps)}
    </div>
    <div class="grid g3">${teams.map(card).join('')}</div>

    ${coachNotes()}
    ${coachRankSection()}
    ${C.foot(meta)}`;
  }

  /* 教練資料的誠實層:哪些是官方每天核對的、哪些還是人工整理會過期的。
     這兩段原本在教練頁,不能因為併頁就弄丟 —— 讀者要知道哪個數字能信。 */
  /* 教練資料的誠實層:哪些是官方每天核對的、哪些還是人工整理會過期的。

     兩個聯賽共用。以前這段寫死「跟**英超**官方核對」,而西甲的來源是 LaLiga 官方 ——
     照抄過去那句話就是假的。來源名稱改成跟著資料走。

     另外拿掉了原本那段「編輯 data/manual/coaches.json、重跑 npm run build」——
     那是寫給開發者的操作說明,出現在讀者頁上只會讓人以為壞了
     (跟模型頁那句「執行 npm test」是同一種問題)。 */
  function coachNotes() {
    const cur = (coaches?.coaches ?? []).filter(c => teamBy.has(c.team));
    if (!cur.length) return '';
    const mism = cur.filter(c => c.officialMismatch);
    /* asOf 兩個聯賽的格式不同:英超是 '2026-05'(年月),西甲是完整 ISO 時間。
       直接 `${asOf}-01` 對西甲會拼出無效日期 → NaN 天,畫面上就是「已經 NaN 天沒更新」。 */
    const asOfIso = /^\d{4}-\d{2}$/.test(String(coaches.asOf ?? '')) ? `${coaches.asOf}-01` : coaches.asOf;
    const parsed = asOfIso ? new Date(asOfIso).getTime() : NaN;
    const days = Number.isFinite(parsed) ? Math.round((Date.now() - parsed) / 86400000) : null;
    const officialName = coaches.source ?? '聯賽官方';

    const official = !coaches.officialAsOf ? '' : `<div class="note ${mism.length ? 'warn' : 'ok'}" style="margin-top:16px">
      <b>現任教練是誰,每次更新都跟${C.esc(officialName)}核對。</b>
      ${mism.length
        ? `<b>${mism.length} 隊在本站上次整理之後換了教練</b>,名字已改用官方的:
           <div style="margin-top:6px">${mism.map(c => `<div class="tiny">
             ${C.name(c.team)}:<b class="accent">${C.esc(c.name)}</b>
             <span class="dim">接替 ${C.esc(c.predecessor?.zh ?? c.predecessor?.name ?? '(空白)')}</span></div>`).join('')}</div>
           <div class="tiny dim" style="margin-top:6px">這幾位的任期、戰績與戰術風格本站還沒整理,
             球隊頁上只會看到前任的資料並標明是前任 —— 不會拿舊數字充當新教練的履歷。</div>`
        : `${cur.length} 隊的現任教練都和官方一致。`}
    </div>`;

    /* 官方只給名字,其餘欄位是人工整理的,會過期 —— 這件事一定要講。
       但「有沒有人工整理過」兩個聯賽不一樣:英超有任期與風格,西甲只有名字。
       所以照實列出「這個聯賽目前有什麼、缺什麼」,不要寫死成英超那份。 */
    const hasTenure = cur.some(c => c.since);
    const hasStyle = cur.some(c => c.style?.length);
    const hasZh = cur.some(c => c.zh);
    const gaps = [
      hasTenure
        ? '<b>任期起訖</b> —— 人工維護;戰績是依這個日期切分比賽算出來的,日期不對戰績就會算到別人頭上。'
        : '<b>任期起訖</b> —— <b>目前完全沒有</b>,上游不提供,所以本站不談任期長短。',
      hasStyle
        ? `<b>戰術風格與慣用陣型</b> —— 人工維護;同一位教練也可能改打法${mism.length ? `,而且新上任的 ${mism.length} 位完全沒有` : ''}。`
        : '<b>戰術風格與慣用陣型</b> —— <b>尚未整理</b>,不以推測填入。',
      hasZh ? '<b>中文譯名</b> —— 沒有譯名的直接顯示英文,不會硬編一個。'
        : '<b>中文譯名</b> —— 尚未整理,一律顯示原文。',
    ];

    const stale = days != null && days > 60 && hasTenure;
    return `${official}
    <div class="note ${stale ? 'warn' : ''}" style="margin-top:10px">
      <b>官方沒提供、需要人工維護的部分</b>${days == null ? '' : `(整理時點 ${C.esc(String(coaches.asOf).slice(0, 10))},距今 ${days} 天)`}:
      <div style="margin-top:6px" class="tiny">${gaps.join('<br>')}</div>
      ${stale ? '<div class="tiny" style="margin-top:8px">這段期間<b>整個夏季轉會窗都過去了</b> —— 換帥通常就發生在這時候,人工維護的欄位要當成可能過期來讀。</div>' : ''}
    </div>`;
  }

  /* ── 教練席 ──────────────────────────
     以前這是兩張表(英超 renderCoachRank / 西甲 renderBasicCoachRank),欄位各寫一份。

     合併時發現一個真的會出錯的地方:**兩邊的 seasonRecord 指的不是同一季。**
     英超的是上季完整 38 場(依人工任期切分算出來),西甲的是本季(FotMob 交付、
     已用本站賽果核對)。直接合併會把「本季 1 場」跟「上季 38 場」排進同一張表。
     所以先在 build 端把欄位名對齊:currentSeasonRecord = 本季、seasonRecord = 上季。

     對齊之後多出一個好處:英超的 currentSeasonRecord 本來就抓回來也核對過了,
     但前端從來沒顯示過。現在兩季都有的聯賽會多一個切換鈕。 */
  /* 這幾個寫成 function 而不是 const 箭頭函式,是因為入口在檔案最上方就呼叫 overview() ——
     const 不會提升(TDZ),整頁會直接掛在「Cannot access before initialization」。
     這個檔案的其他區塊函式也都是 function 宣告,照同一個規矩走。 */
  const SLOTS = [['current', 'currentSeasonRecord'], ['last', 'seasonRecord']];
  function slotRows(key) { return (coaches?.coaches ?? []).filter(c => c[key]?.p); }
  function availableSlots() { return SLOTS.filter(([, key]) => slotRows(key).length >= 2); }
  function seasonLabel(key) {
    return slotRows(key)[0]?.[key]?.season
      ?? (key === 'seasonRecord' ? meta.lastSeason : meta.currentSeason);
  }
  // 場均勝點:上游沒給就自己算(純算術,不是估計)
  const ppgOf = recPpg;   // 教練席與教練卡用同一個算法,不要各寫一份

  let rankSlot = null;

  function coachRankSection() {
    const slots = availableSlots();
    if (!slots.length) return '';
    /* 預設看**場次多的**那一季,不是「本季」。開季第一輪每位教練只有 1 場,
       場均勝點不是 3.00 就是 0.00,那張表排出來沒有任何意義。
       兩季都在選單裡,讀者要看本季隨時可以切。 */
    const games = key => slotRows(key).reduce((a, c) => a + c[key].p, 0);
    rankSlot = [...slots].sort((a, b) => games(b[1]) - games(a[1]))[0][1];
    const rows = slotRows(rankSlot);
    queueMicrotask(() => {
      const sel = document.getElementById('rankSeason');
      if (sel) sel.onchange = () => { rankSlot = sel.value; renderCoachRank(); };
      renderCoachRank();
    });
    return `<div class="section" style="margin-top:20px"><h2>教練席</h2>
      <span class="hint">任內戰績・${rows.length} 位・點一列看該隊詳情</span></div>
    ${slots.length > 1 ? `<div class="filters" style="margin-bottom:12px">
      <label>賽季</label><select id="rankSeason">
        ${slots.map(([, key]) => `<option value="${key}" ${key === rankSlot ? 'selected' : ''}>`
          + `${seasonLabel(key)}(${slotRows(key).reduce((a, c) => a + c[key].p, 0)} 場)</option>`).join('')}
      </select></div>` : ''}
    <div id="coachRank"></div>
    <div id="coachRankNote"></div>`;
  }

  function coachRankNote() {
    const key = rankSlot;
    const season = seasonLabel(key);
    const cur = (coaches?.coaches ?? []).filter(c => teamBy.has(c.team));
    const missing = cur.filter(c => !c[key]?.p);
    /* 本季戰績兩個聯賽都來自同一份外部交付,所以來源說明也共用一個欄位。
       英超的在 currentRecordSource、西甲的在 recordSource —— 名字不同是歷史包袱,
       這裡一起讀,不要因為欄位名不同就少講一邊的出處。 */
    const src = key === 'currentSeasonRecord'
      ? (coaches?.currentRecordSource ?? coaches?.recordSource)
      : null;
    return `<div class="tiny dim" style="margin-top:8px">
      含賽季中途接手者,場次少的參考價值低。
      ${src ? `戰績來自 ${C.esc(src.source ?? '外部來源')},已用本站賽果逐欄位核對(${src.verified ?? '—'} 隊通過),
        對不上的整隊不列。<b>接任日期上游沒有</b>,所以這一季的表不談任期長短。
        ${src.aheadMatches?.length ? `另有 ${src.aheadMatches.length} 場上游已有、本站賽果尚未更新的比賽已計入。` : ''}`
        : '每位教練的任期、慣用陣型與風格標籤在各隊的詳情頁。'}
      ${missing.length ? `<br><b>${cur.length} 隊裡有 ${missing.length} 隊不在表上</b> ——
        他們的教練在 ${season} 沒有帶過這支球隊(多半是剛上任),
        本站不會把前任的成績算到他頭上:
        ${missing.map(c => C.name(c.team)).join('、')}。` : ''}
    </div>`;
  }

  function renderCoachRank() {
    const el = document.getElementById('coachRank');
    const rows = slotRows(rankSlot);
    if (!el || !rows.length) return;
    // 有值才給欄位:西甲的紀錄沒有 winPct,硬給會是一整欄的「—」(鐵則三)
    const rec = c => c[rankSlot];
    const has = k => rows.some(c => rec(c)[k] != null);
    el.innerHTML = C.table(rows, [
      { key: 'coach', label: '教練', value: c => c.zh ?? c.name ?? '',
        render: c => `${C.esc(c.zh ?? c.name ?? '')} <span class="dim tiny">${C.esc(c.zh ? (c.name ?? '') : '')}</span>` },
      { key: 'team', label: '球隊', value: c => C.name(c.team), render: c => C.teamCell(c.team) },
      { key: 'p', label: '場次', value: c => rec(c).p, num: true },
      { key: 'w', label: '勝', value: c => rec(c).w, num: true },
      { key: 'd', label: '和', value: c => rec(c).d, num: true },
      { key: 'l', label: '負', value: c => rec(c).l, num: true },
      { key: 'gf', label: '進', value: c => rec(c).gf, num: true },
      { key: 'ga', label: '失', value: c => rec(c).ga, num: true },
      ...(has('winPct') ? [{ key: 'winPct', label: '勝率', num: true,
        value: c => rec(c).winPct, render: c => `${rec(c).winPct}%` }] : []),
      { key: 'ppg', label: '場均勝點', num: true,
        value: c => ppgOf(rec(c)), render: c => `<b>${C.fx(ppgOf(rec(c)), 2)}</b>` },
      { key: 'conf', label: '資料可信度', value: c => c.confidence, sortable: false, render: confPill },
    ], { sortKey: 'ppg', desc: true, onRow: c => { C.go('teams', { code: c.team }); } });
    const note = document.getElementById('coachRankNote');
    if (note) note.innerHTML = coachRankNote();
  }

  /* 總覽卡片。兩個聯賽共用一份 —— 以前是兩份(card / basicOverview 裡內嵌那段),
     結果同一塊要改兩次,而且慢慢長歪:英超那張有場館與傷停、西甲那張有本季戰績與 Elo,
     兩邊其實都該有。每一格自己判斷資料在不在,缺就不出現。

     **傷停那格特別要小心**:西甲沒有傷停來源。以前 build 給 0、卡片印「無傷停回報」——
     那句話是假的,我們根本沒查過。現在 null(沒有來源)整格不出現,
     0(查過、沒人傷)才印「無傷停回報」。 */
  function card(t) {
    const s = t.sim, ls = t.lastSeason, cur = t.current;
    /* 四個數字排成 2×2,不是一排四欄。卡片只有頁面寬度的三分之一,
       四欄各約 55px —— 「第 1 名 · 85 分」在那個寬度裡會斷成三行,
       上下卡片的數字還會錯位,整片看起來像壞掉。

         上季        期望積分
         本季目前     前四／降級

       次要的數字(場次、上季積分、降級率)壓成同一行的灰字,
       主要那個數字才有份量,不用讀者自己找。 */
    const cells = [
      ['上季', ls ? `第 ${ls.pos} 名<span class="dim"> ${ls.pts} 分</span>` : '<span class="pill">升班馬</span>'],
      ['期望積分', `<b>${s?.expectedPoints ?? '—'}</b>`],
      ['本季目前', cur?.p
        ? `${cur.pts} 分<span class="dim"> ${cur.p} 場</span>`
        : '<span class="dim">尚無完賽</span>'],
      /* 「前四」是歐冠資格的界線,英冠沒有這回事(前 2 直升、3~6 附加賽)。
         有 promotionPct 的聯賽換成「直升 / 降級」—— 判斷看資料有沒有這個欄位,
         不要在前端寫死聯賽代碼。 */
      s?.promotionPct != null
        ? ['直升 / 降級', `${s.promotionPct}%<span class="dim"> / ${s.relegationPct}%</span>`]
        : ['前四 / 降級', s
          ? `${s.top4Pct}%<span class="dim"> / ${s.relegationPct}%</span>`
          : '<span class="dim">—</span>'],
    ];
    const coachName = t.coach?.zh ?? t.coach?.name ?? null;
    return `<a class="card" href="${C.link('teams', { code: t.code })}" style="text-decoration:none;color:inherit;display:block">
      <div class="row" style="gap:11px">${C.badge(t.code, 'lg')}
        <div><div style="font-weight:800;font-size:16px">${C.esc(t.en)}</div>
          <div class="tiny dim">${C.esc(t.zh)}${t.venue ? `・${C.esc(t.venue)}` : ''}</div></div></div>
      <div class="team-card-stats">
        ${cells.map(([l, v]) => `<div><div class="tiny dim">${l}</div><div class="mono">${v}</div></div>`).join('')}
      </div>
      ${t.tactics?.tags?.length
        ? `<div class="tags" style="margin-top:10px">${t.tactics.tags.slice(0, 4).map(x => `<span class="pill">${C.esc(x)}</span>`).join('')}</div>`
        : `<div class="tiny dim" style="margin-top:10px">${ls ? '上季風格資料從缺' : '升班馬・沒有上季風格樣本'}</div>`}
      <div class="row tiny dim" style="margin-top:10px;justify-content:space-between">
        <span>Elo ${C.fx(t.elo, 0)}</span>
        <span>${coachName ? `教練 ${C.esc(coachName)}` : '教練待補'}</span>
        ${t.injuries == null ? '' : `<span>${t.injuries
          ? `<span style="color:var(--loss)">傷停 ${t.injuries}</span>`
          : '無傷停回報'}</span>`}
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
      <div class="row" style="gap:8px;align-items:center;margin-bottom:6px">
        <span class="form-run">${runs}</span>
      </div>
      ${C.statCells([
        { label: '勝', value: s.w, tone: 'win' },
        { label: '和', value: s.d },
        { label: '負', value: s.l, tone: 'loss' },
        { label: '勝率', value: s.winPct, unit: '%' },
        { label: '進球', value: s.gf },
        { label: '失球', value: s.ga },
        { label: '場均勝點', value: C.fx(s.ppg, 2) },
      ], { compact: true })}
      <div style="margin-bottom:8px"></div>
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
      <div class="tiny dim" style="margin:6px 0 8px">${C.esc(meta.competition?.short ?? '聯賽')} ${C.esc(meta.h2hSeasons?.[0] ?? '')} 起・不影響模型勝率</div>
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
        <div class="dim small">${C.esc(meta.h2hSeasons?.[0] ?? '')} 以來沒有在${C.esc(meta.competition?.short ?? '聯賽')}交手過。</div>`;
      return;
    }
    const ownIsA = key.split('|')[0] === t.code;
    const w = ownIsA ? rec.aWin : rec.bWin;
    const l = ownIsA ? rec.bWin : rec.aWin;
    const gf = ownIsA ? rec.aGoals : rec.bGoals;
    const ga = ownIsA ? rec.bGoals : rec.aGoals;
    const winPct = rec.games ? Math.round((w / rec.games) * 1000) / 10 : 0;
    box.innerHTML = `<div class="small" style="margin-bottom:8px">對手球隊：${C.teamLink(opp)}</div>
    ${C.statCells([
      { label: '勝', value: w, tone: 'win' },
      { label: '和', value: rec.draw },
      { label: '負', value: l, tone: 'loss' },
      { label: '勝率', value: winPct, unit: '%' },
      { label: '進球', value: gf },
      { label: '失球', value: ga },
    ], { compact: true })}
    <div style="margin-bottom:8px"></div>
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
      /* 表格裡的勝和負拆成三欄。原本擠成一欄「26 / 7 / 5」——
         在表格中特別難讀:上下列的斜線位置對不齊,而且三個數字都排不了序。 */
      { key: 'w', label: '勝', value: r => r.w, num: true,
        render: r => (r.w ? `<b style="color:var(--win)">${r.w}</b>` : '0') },
      { key: 'd', label: '和', value: r => r.d, num: true },
      { key: 'l', label: '負', value: r => r.l, num: true,
        render: r => (r.l ? `<b style="color:var(--loss)">${r.l}</b>` : '0') },
      { key: 'winPct', label: '勝率', value: r => r.winPct, num: true, render: r => `${r.winPct}%` },
      { key: 'gf', label: '進球', value: r => r.gf, num: true },
      { key: 'ga', label: '失球', value: r => r.ga, num: true },
      { key: 'gd', label: '淨勝', value: r => r.gd, num: true, render: r => C.signed(r.gd, 0) },
      { key: 'avgGF', label: '場均進球', value: r => r.avgGF ?? -1, num: true, render: r => r.avgGF ?? '—' },
      { key: 'avgGA', label: '場均失球', value: r => r.avgGA ?? -1, num: true, render: r => r.avgGA ?? '—' },
      { key: 'cleanSheets', label: '零封', value: r => r.cleanSheets, num: true },
    ], { sortKey: null })}
      <div class="tiny dim" style="margin-top:8px">
        防守以失球、場均失球與零封呈現。${meta.capabilities?.setPieces ? '上一完整賽季的運動戰、角球、其他定位球、直接任意球與十二碼進失球，列在下方數據風格區。' : '目前沒有可靠的進球情境分類，因此不顯示運動戰／角球／任意球拆分。'}
      </div>
    </div>`;
  }

  function goalSituationCard(tac) {
    if (!tac?.setPieces?.available) return '';
    const sp = tac.setPieces;
    const penalty = sp.breakdown?.penalty ?? {};
    const rows = [
      ['openPlay', '運動戰'], ['corner', '角球'], ['otherSetPiece', '其他定位球'],
      ['directFreeKick', '直接任意球'], ['penalty', '十二碼'],
    ].map(([key, label]) => ({ label, ...sp.breakdown[key] }));
    return `<div class="card" style="margin-top:14px"><div class="spread">
      <h3 style="margin:0">上季進球方式</h3><span class="pill tiny">${meta.lastSeason}</span></div>
      <div class="grid g4" style="margin:12px 0">
        <div><div class="tiny dim">全季進球 / 失球</div><b class="mono">${tac.attack.goals ?? '—'} / ${tac.defence.conceded ?? '—'}</b></div>
        <div><div class="tiny dim">非十二碼定位球 進 / 失</div><b class="mono">${sp.goals ?? '—'} / ${sp.conceded ?? '—'}</b></div>
        <div><div class="tiny dim">定位球 xG / xGA（不含十二碼）</div><b class="mono">${C.fx(sp.xG, 2)} / ${C.fx(sp.xGA, 2)}</b></div>
        <div><div class="tiny dim">十二碼 進 / 失</div><b class="mono">${penalty.goals ?? '—'} / ${penalty.against?.goals ?? '—'}</b></div>
      </div>
      <div class="tiny dim" style="margin-bottom:8px">下方五類明細合計就是全季進球／失球；上方「非十二碼定位球」只包含角球、其他定位球與直接任意球，故不會等於運動戰或五類總和。</div>
      ${C.table(rows, [
        { key: 'label', label: '情境', value: r => r.label, left: true },
        { key: 'goals', label: '進球', value: r => r.goals ?? -1, num: true, render: r => r.goals ?? '—' },
        { key: 'xg', label: 'xG', value: r => r.xG, num: true, render: r => C.fx(r.xG, 2) },
        { key: 'shots', label: '射門', value: r => r.shots, num: true },
        { key: 'against', label: '失球', value: r => r.against.goals ?? -1, num: true, render: r => r.against.goals ?? '—' },
        { key: 'xga', label: 'xGA', value: r => r.against.xG, num: true, render: r => C.fx(r.against.xG, 2) },
      ], { sortKey: null })}
      ${sp.goalsReliable === false ? `<div class="note warn" style="margin-top:8px">此隊的供應商情境進球加總與正式比分總進球相差 1，因此進球／失球分類顯示從缺；已逐場核對的射門、xG 與 xGA 仍保留。</div>` : ''}
      <div class="tiny dim" style="margin-top:8px">
        來源: <a href="${C.esc(sp.sourceUrl)}" target="_blank" rel="noopener">Understat</a>。
        「其他定位球」是非角球、非直接任意球的定位球;
        ${sp.goalsReliable === false ? '逐場比分已核對，但情境進球加總未通過總量核對。' : '五類進失球已跟聯賽實際比分逐隊核對。'}
      </div></div>`;
  }

  /* ── 單隊 ─────────────────────────── */
  /* ── 球隊詳情 ──────────────────────────
     以前是兩份(detail / basicDetail),同一塊要改兩次。合併成一份之後,
     每一塊自己判斷資料在不在,缺就整塊不出現 —— 這樣補資料只要寫一次,
     而且新接進來的欄位兩個聯賽會同時亮起來。

     合併後西甲**多拿到**的東西不是版面而是內容:上季的半場行為、最長連勝/不敗、
     主客落差 —— 那些欄位 lastSeason 裡本來就有,只是舊的 basicDetail 沒畫。 */
  const kpiOf = (l, v, sub = '') => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`;
  const lineOf = (l, v) => `<div class="stat-line"><span class="small muted">${l}</span><b class="mono">${v ?? '—'}</b></div>`;

  function detailHead(t, co) {
    /* 場館/城市/容納人數只有英超有。西甲沒有就整段不出現,
       不要留「—・—・可容納 — 人」那種殼。 */
    const venue = [t.venue, t.city, t.capacity ? `可容納 ${t.capacity.toLocaleString()} 人` : null]
      .filter(Boolean).join('・');
    const coachName = co?.zh ?? co?.name ?? null;
    const sub = [venue, coachName ? `教練 <b>${C.esc(coachName)}</b>${co.nat ? `(${C.esc(co.nat)})` : ''}` : '教練資料待補']
      .filter(Boolean).join('・');
    return `<div class="page-head">
      <div class="row" style="gap:14px">${C.badge(t.code, 'xl')}
        <div><h1 style="margin:0">${C.esc(t.en)}<span class="dim" style="font-size:15px;font-weight:400"> ${C.esc(t.zh)}${t.nickname ? `・${C.esc(t.nickname)}` : ''}</span></h1>
          <p class="small">${sub}</p></div></div>
      <div class="row small" style="margin-top:6px"><a href="${C.link('teams')}">← 回球隊列表</a></div>
    </div>`;
  }

  /* KPI 列。第四格原本是「前四 / 降級 → 97.5% / 0%」——
     兩個意思不同的機率被一條斜線串起來,看起來像分數。
     機率拆成獨立一排、每個自己帶標籤,KPI 只留單一數字。 */
  function kpiRow(t) {
    const ls = t.lastSeason, cur = t.current, s = t.sim;
    const probs = s ? C.statCells([
      s.titlePct != null ? { label: '奪冠', value: `${s.titlePct}`, unit: '%', tone: s.titlePct >= 50 ? 'win' : null } : null,
      { label: '前四', value: `${s.top4Pct}`, unit: '%' },
      { label: '降級', value: `${s.relegationPct}`, unit: '%', tone: s.relegationPct >= 20 ? 'loss' : null },
      { label: 'Elo', value: C.fx(t.elo, 0), title: '1500 是起點基準' },
    ]) : '';
    return `<div class="grid g4">
      ${kpiOf('上季名次', ls ? `第 ${ls.pos} 名` : '升班馬',
        ls ? `${ls.pts} 分・場均 ${ls.ppg}` : `${meta.lastSeason} 未在這個聯賽`)}
      ${kpiOf('本季目前', cur?.p ? `${cur.pts} 分` : '尚無完賽',
        cur?.p ? `${cur.p} 場・${cur.w}勝${cur.d}和${cur.l}負` : meta.currentSeason)}
      ${kpiOf('期望積分', s?.expectedPoints ?? '—',
        cur?.pts != null ? `已拿 ${cur.pts} 分 + 剩餘賽程模擬` : '整季模擬結果')}
      ${kpiOf('期望名次', s ? `第 ${s.expectedPos} 名` : '—',
        `${meta.model.simulationRuns.toLocaleString()} 次模擬的平均`)}
    </div>
    ${probs ? `<div class="card" style="margin-top:12px;padding:6px 14px">${probs}</div>` : ''}`;
  }

  /* 上季戰績剖析。lastSeason 的形狀兩個聯賽**完全一樣**(逐欄位比對過),
     所以這一整塊可以原封不動共用 —— 西甲以前只畫了其中八個數字。 */
  function lastSeasonBlock(t) {
    const ls = t.lastSeason;
    if (!ls) {
      return `<div class="note" style="margin-top:16px">${C.esc(t.en)} 上季不在這個聯賽,所有上季指標從缺;
        模型改用「聯盟後段先驗」估計強度,不確定性標得比較大 —— 畫面不補造上季數字。</div>`;
    }
    return `<div class="section"><h2>上季戰績剖析</h2><span class="hint">${meta.lastSeason}</span></div>
    <div class="grid g2">
      <div class="card"><h3>基本戰績</h3>
        ${C.record(ls.w, ls.d, ls.l)}
        ${C.statCells([
          { label: '進球', value: ls.gf },
          { label: '失球', value: ls.ga },
          { label: '淨勝', value: C.signed(ls.gd, 0), tone: ls.gd > 0 ? 'win' : ls.gd < 0 ? 'loss' : null },
          { label: '零封', value: ls.cleanSheets },
        ])}
        <div style="margin-top:10px">
          ${C.statMatrix(['場均勝點'], [['主場', C.fx(ls.home.ppg, 2)], ['客場', C.fx(ls.away.ppg, 2)],
            ['主客落差', C.signed(ls.homeAwayGap, 2)]])}
        </div>
        ${lineOf('最長連勝', ls.longest.win)}
        ${lineOf('最長不敗', ls.longest.unbeaten)}
        ${lineOf('雙方進球比例', `${ls.bttsPct}%`)}
        ${lineOf('大於 2.5 球比例', `${ls.over25Pct}%`)}
      </div>
      <div class="card"><h3>半場行為</h3>
        ${/* 上下半場的進失球本來就是一個 2×2,壓成兩行斜線的話
              「哪個半場進得多」要自己比對兩行的第一個數字。攤成矩陣一眼看得出來。 */''}
        ${C.statMatrix(['進球', '失球', '淨勝'], [
          ['上半場', ls.half.gf1, ls.half.ga1, C.signed(ls.half.gf1 - ls.half.ga1, 0)],
          ['下半場', ls.half.gf2, ls.half.ga2, C.signed(ls.half.gf2 - ls.half.ga2, 0)],
        ])}
        ${lineOf('下半場淨勝球增減', C.signed(ls.half.secondHalfSwing, 1))}
        <div style="margin-top:10px">
          ${C.statMatrix(['場次', '收分率'], [
            ['半場領先', ls.half.htLead, ls.half.leadHoldPct === null ? '—' : `${ls.half.leadHoldPct}%`],
            ['半場落後', ls.half.htTrail, ls.half.trailRescuePct === null ? '—' : `${ls.half.trailRescuePct}%`],
          ])}
        </div>
        ${C.statCells([
          { label: '逆轉', value: ls.half.comeback, tone: 'win' },
          { label: '被逆轉', value: ls.half.collapse, tone: 'loss' },
        ])}
        <div class="tiny dim" style="margin-top:8px">收分率 = 半場領先(或落後)的比賽中,實際拿到的分數佔可能分數的比例。</div>
      </div>
    </div>`;
  }

  /* 戰術風格。兩個聯賽的 tactics **欄位不同**(英超有球員級的人力配置與紀律、
     西甲有整隊的射門與快攻佔比),所以右邊那張卡逐欄位判斷有沒有值。
     雷達與標籤兩邊都有,共用。 */
  function styleBlock(t) {
    const tac = t.tactics;
    if (!tac) return '';
    const a = tac.attack ?? {}, d = tac.defence ?? {}, sp = tac.setPieces ?? {};
    const rows = [
      a.goals90 != null ? ['進球 / xG(每場)', `${a.goals90} / ${a.xG90}`] : ['每場期望進球 xG', a.xG90],
      d.conceded90 != null ? ['失球 / xGA(每場)', `${d.conceded90} / ${d.xGA90}`] : ['每場期望失球 xGA', d.xGA90],
      a.shots90 != null ? ['射門 / 被射門(每場)', `${a.shots90} / ${d.shots90}`] : null,
      ['終結超出期望', C.signed(a.finishing, 1)],
      d.overperform != null ? ['門將守住的期望失球', C.signed(d.overperform, 1)] : null,
      a.fastXGShare != null ? ['快速進攻 xG 佔比', `${a.fastXGShare}%`] : null,
      a.boxShotShare != null ? ['禁區內射門佔比', `${a.boxShotShare}%`] : null,
      sp.available ? ['非十二碼定位球 進 / 失', `${sp.goals} / ${sp.conceded}`] : null,
      sp.available ? ['定位球 xG / 場', sp.xG90] : null,
      sp.available ? ['定位球 xGA / 場', sp.xGA90] : null,
      !sp.available && sp.defenderGoalShare != null ? ['後場球員進球佔比(代理)', `${sp.defenderGoalShare}%`] : null,
      tac.formation?.label ? ['後場 / 中場 / 鋒線人力', tac.formation.label] : null,
      tac.formation?.shape ? ['體系判讀', tac.formation.shape] : null,
      tac.formation?.primary ? ['主要陣型', tac.formation.primary] : null,
      tac.squad ? ['使用球員數', tac.squad.used] : null,
      tac.squad ? ['前 11 人出場佔比', `${tac.squad.top11Share}%`] : null,
      tac.squad ? ['出場加權平均年齡', tac.squad.avgAgeWeighted] : null,
      tac.discipline ? ['每場黃紅牌加權', tac.discipline.perGame] : null,
    ].filter(Boolean);
    const formations = tac.formation?.list?.slice(0, 3) ?? [];
    /* 雷達的軸兩個聯賽不一樣(英超有傳球創造、西甲有快速進攻),
       所以說明也要跟著資料走 —— 寫死其中一種,另一個聯賽的出處就是假的。 */
    const radarNote = meta.edition === 'basic'
      ? `每一軸是 ${meta.lastSeason} 全聯盟 20 隊中的百分位,不是主觀評分。依據為 xG/xGA、運動戰與定位球 xG、
         快速進攻 xG 佔比,以及半場領先保分／落後搶分;目前沒有可靠控球與壓迫資料,因此不畫這兩軸。`
      : '數值為該指標在 20 隊中的百分位。';
    return `<div class="section" style="margin-top:16px"><h2>上季數據風格</h2>
      <span class="hint">${meta.lastSeason}・20 隊百分位</span></div>
    <div class="grid g2">
      <div class="card"><h3>風格雷達</h3>
        ${C.radar([{ name: t.en, color: t.chartColor ?? t.colors[0], values: tac.radar }], { size: 300 })}
        <div class="tags" style="margin-top:8px">${(tac.tags ?? []).map(x => `<span class="pill accent">${C.esc(x)}</span>`).join('')}</div>
        <div class="tiny dim" style="margin-top:8px">${radarNote}</div>
      </div>
      <div class="card"><h3>攻守與陣型</h3>
        ${rows.map(([l, v]) => lineOf(l, v)).join('')}
        ${formations.length ? `<div style="margin-top:8px;border-top:1px dashed var(--line);padding-top:6px">${formations.map(f =>
          `<div class="stat-line"><span class="small">${C.esc(f.name)}</span><span class="mono small">${f.share}% <span class="dim">・${f.minutes} 分</span></span></div>`).join('')}</div>` : ''}
        <div class="tiny dim" style="margin-top:8px">${tac.formation?.notes?.join('・')
          || (formations.length ? '陣型為供應商逐場紀錄的實際使用時間;風格只描述上季表現,不改動本季單場模型機率。' : '　')}</div>
      </div>
    </div>`;
  }

  // 定位球主罰順位:只有英超的來源有順位欄位,沒有就整塊不出現
  function takersBlock(tac) {
    const tk = tac?.setPieces?.takers;
    if (!tk || !Object.values(tk).some(v => v?.length)) return '';
    return `<div class="card" style="margin-top:14px"><h3>定位球主罰順位</h3>
      <div class="grid g3">
        ${[['pen', '十二碼'], ['fk', '直接自由球'], ['corner', '角球/間接球']].map(([k, l]) => `
          <div><div class="tiny dim">${l}</div>${(tk[k] ?? []).length
            ? tk[k].map(x => `<div class="small">${x.order}. ${C.esc(x.name)}</div>`).join('')
            : '<div class="small dim">未登錄</div>'}</div>`).join('')}
      </div></div>`;
  }

  function eloBlock(t) {
    if (!t.eloHistory?.length) return '';
    const first = t.eloHistory[0], last = t.eloHistory.at(-1);
    const move = last.r - first.r;
    return `<div class="card" style="margin-top:14px"><h3>Elo 實力走勢</h3>
      ${C.eloTrend(t.eloHistory, { color: t.colors[0] })}
      <div class="tiny dim">最近 ${t.eloHistory.length} 場・${first.date ? `${C.dateZh(first.date)} 起` : ''}
        目前 ${C.fx(t.elo, 0)}・這段期間 ${move >= 0 ? '+' : ''}${Math.round(move)}
        <span class="dim">(1500 是 Elo 的起點基準,跨季會朝它回歸;把游標移到線上可看單場數值)</span></div></div>`;
  }

  // 開季賽程難度是 FPL 特有的欄位,西甲沒有 → 整塊不出現
  function scheduleBlock(t) {
    if (!t.schedule?.detail?.length) return '';
    return `<div class="section"><h2>開季賽程</h2><span class="hint">FPL 官方難度 1(易)~5(難)</span></div>
    <div class="card"><div class="grid g3">
      ${t.schedule.detail.map(d => `<div class="stat-line">
        <span class="small">第 ${d.event} 輪 ${d.home ? '主' : '客'} ${C.name(d.opp)}</span>
        <span class="pill ${d.diff >= 4 ? 'bad' : d.diff <= 2 ? 'accent' : 'warn'}">${d.diff}</span></div>`).join('')}
    </div><div class="tiny dim" style="margin-top:8px">前 ${t.schedule.detail.length} 輪平均難度 ${t.schedule.avg}</div></div>`;
  }

  /* 接下來的賽程。三件事跟原本不一樣:

     1. **位置**。原本排在最後、在「陣容」那一大塊後面 —— 那一頁往下捲二十幾個區塊
        才看得到「下一場對誰」,等於沒有。現在排在戰績卡下面。
     2. **連結**。原本連 `index.html?id=…`(首頁的速覽抽屜)。那是全站唯一這樣連的地方,
        其他每一處單場連結都是 `analysis` 的完整單場頁。從球隊頁跳回首頁再開抽屜,
        等於把讀者原本在看的球隊頁弄丟了。
     3. **內容**。原本只有日期,沒有開球時間 —— 而讀者問「什麼時候打」時要的正是時間。
        現在有本地時區的開球鐘面、輪次、對手隊徽,最近的一場另外給倒數。

     開球時間可能是 null(上游還沒排定),那種就只顯示日期,不要印一個假的時間。 */
  function nextFixturesBlock(t, next) {
    if (!next.length) return '';
    return `<div class="card" style="margin-top:14px">
      <h3>接下來的賽程</h3>
      <div class="tiny dim" style="margin-bottom:8px">未賽的下 ${next.length} 場・時間已換算為 ${C.tzName()}・點任一場看完整賽前分析</div>
      ${next.map((f, i) => {
        const home = f.home === t.code;
        const opp = home ? f.away : f.home;
        const win = home ? f.prediction?.home : f.prediction?.away;
        return `<a href="${C.link('analysis', { id: f.id })}" style="color:inherit;text-decoration:none">
          <div class="stat-line">
            <span class="row small" style="gap:6px;min-width:0">
              <span class="mono dim">${f.kickoff ? C.kickoffLocal(f.kickoff) : C.dateFull(f.date)}</span>
              <span class="pill tiny">${home ? '主' : '客'}</span>${C.badge(opp)}<b>${C.name(opp)}</b>
              ${f.round != null ? `<span class="tiny dim">第 ${f.round} 輪</span>` : ''}
            </span>
            <span class="mono small">${i === 0 && f.kickoff ? C.countdown(f.kickoff)
              : win == null ? '—' : `勝率 ${C.pct(win, 0)}`}</span>
          </div></a>`;
      }).join('')}</div>`;
  }

  function detail(t) {
    const co = coachBy.get(t.code);
    const next = fixtures.filter(f => !f.played && (f.home === t.code || f.away === t.code))
      .sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 6);
    const h2hDefault = next[0]
      ? (next[0].home === t.code ? next[0].away : next[0].home)
      : teams.find(x => x.code !== t.code)?.code;

    app.innerHTML = `
    ${detailHead(t, co)}
    ${kpiRow(t)}
    <div class="grid g2" style="margin-top:16px">${recentCard(t)}${h2hCard(t, h2hDefault)}</div>
    ${nextFixturesBlock(t, next)}
    ${seasonHistorySection(t)}
    ${lastSeasonBlock(t)}
    ${coachCard(co)}
    ${goalSection(t)}
    ${styleBlock(t)}
    ${goalSituationCard(t.tactics)}
    ${takersBlock(t.tactics)}
    ${eloBlock(t)}
    ${scheduleBlock(t)}
    ${squadSection(t)}
    ${C.foot(meta)}`;

    /* 倒數要會走 —— 不叫這一支的話,數字停在載入當下,
       讀者坐在頁面上看著一個慢慢變錯的時間。核心那支自己會清掉上一個計時器。 */
    C.startCountdowns();
    renderTeamH2H(t);
    renderSquad(t);
  }

  /* 入口放在最後面才呼叫。
     以前寫在檔案開頭,但區塊函式用到的模組級 const/let(SLOTS、rankSlot…)
     那時候還在 TDZ,整頁會掛在「Cannot access before initialization」——
     而畫面上看到的是「載入失敗」,看起來像資料壞了。 */
  if (code && teams.some(t => t.code === code)) {
    const t = teams.find(x => x.code === code);
    detail(t);
  } else {
    overview();
  }
} catch (err) { C.fail(err); }
