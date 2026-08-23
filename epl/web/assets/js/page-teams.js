import * as C from './core.js';

const app = document.getElementById('app');

try {
  const { meta, clubs, teams, players, fixtures, coaches, results } =
    await C.load('meta', 'clubs', 'teams', 'players', 'fixtures', 'coaches', 'results');
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav('teams.html');

  const code = C.qs('code');
  const coachBy = new Map(coaches.coaches.map(c => [c.team, c]));
  code && teams.some(t => t.code === code) ? detail(teams.find(t => t.code === code)) : overview();

  /* ── 列表 ─────────────────────────── */
  function overview() {
    app.innerHTML = `
    <div class="page-head">
      <h1>球隊</h1>
      <p>${meta.currentSeason} 的 20 支球隊。卡片上的期望積分來自 ${meta.model.simulationRuns.toLocaleString()} 次賽季模擬,
         風格標籤則是從上季的每一場比賽與每一位球員的數據推出來的。點進去看完整剖析。</p>
    </div>
    <div class="grid g3">${teams.map(card).join('')}</div>
    ${C.foot(meta)}`;
  }

  function card(t) {
    const s = t.sim, ls = t.lastSeason;
    return `<a class="card" href="teams.html?code=${t.code}" style="text-decoration:none;color:inherit;display:block">
      <div class="row" style="gap:11px">${C.badge(t.code, 'lg')}
        <div><div style="font-weight:800;font-size:16px">${t.zh}</div>
          <div class="tiny dim">${t.venue}</div></div></div>
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

  /* ── 單隊 ─────────────────────────── */
  function detail(t) {
    const ls = t.lastSeason, tac = t.tactics, s = t.sim, co = coachBy.get(t.code);
    const squad = players.filter(p => p.team === t.code);
    const out = squad.filter(p => p.news && p.status !== 'a');
    const seasonGames = results.filter(m => m.season === meta.lastSeason && (m.home === t.code || m.away === t.code));
    const next = fixtures.filter(f => !f.played && (f.home === t.code || f.away === t.code)).slice(0, 6);

    const kpi = (l, v, sub = '') => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${sub}</div></div>`;
    const line = (l, v) => `<div class="stat-line"><span class="small muted">${l}</span><b class="mono">${v}</b></div>`;

    app.innerHTML = `
    <div class="page-head">
      <div class="row" style="gap:14px">${C.badge(t.code, 'lg')}
        <div><h1 style="margin:0">${t.zh}<span class="dim" style="font-size:15px;font-weight:400"> ${t.nickname}</span></h1>
          <p class="small">${t.venue}・${t.city}・可容納 ${t.capacity.toLocaleString()} 人
            ${co?.name ? `・教練 <b>${co.zh}</b>(${co.nat})` : '・教練資料待補'}</p></div></div>
      <div class="row small" style="margin-top:6px"><a href="teams.html">← 回球隊列表</a></div>
    </div>

    <div class="grid g4">
      ${kpi('上季名次', ls ? `第 ${ls.pos} 名` : '升班馬', ls ? `${ls.pts} 分・場均 ${ls.ppg}` : `${meta.lastSeason} 未在英超`)}
      ${kpi('本季期望積分', s?.expectedPoints ?? '—', `期望名次 第 ${s?.expectedPos ?? '—'} 名`)}
      ${kpi('前四機率', `${s?.top4Pct ?? '—'}%`, `奪冠 ${s?.titlePct ?? '—'}%`)}
      ${kpi('降級機率', `${s?.relegationPct ?? '—'}%`, `Elo ${C.fx(t.elo, 0)}`)}
    </div>

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
    </div>` : `<div class="note" style="margin-top:16px">${t.zh} 上季不在英超,所有上季指標從缺;
      模型改用「聯盟後段先驗」估計強度,不確定性標得比較大。</div>`}

    <div class="grid g2" style="margin-top:14px">
      ${tac ? `<div class="card"><h3>戰術風格</h3>
        ${C.radar([{ name: t.zh, color: t.colors[0], values: tac.radar }], { size: 300 })}
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
        ${line('後衛+門將進球佔比', `${tac.setPieces.defenderGoalShare}%`)}
        ${line('使用球員數', tac.squad.used)}
        ${line('前 11 人出場佔比', `${tac.squad.top11Share}%`)}
        ${line('出場加權平均年齡', tac.squad.avgAgeWeighted)}
        ${line('每場黃紅牌加權', tac.discipline.perGame)}
        <div class="tiny dim" style="margin-top:8px">${tac.formation.notes.join('・') || '　'}</div>
      </div>` : ''}
    </div>

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
        <span class="small">第 ${d.event} 輪 ${d.home ? '主' : '客'} ${C.zh(d.opp)}</span>
        <span class="pill ${d.diff >= 4 ? 'bad' : d.diff <= 2 ? 'accent' : 'warn'}">${d.diff}</span></div>`).join('')}
    </div><div class="tiny dim" style="margin-top:8px">前 ${t.schedule.detail.length} 輪平均難度 ${t.schedule.avg}</div></div>` : ''}

    <div class="section"><h2>陣容</h2><span class="hint">${squad.length} 人・數據為上季表現</span></div>
    ${out.length ? `<div class="note" style="margin-bottom:10px">傷停/異動 ${out.length} 人:
      ${out.map(p => `${C.esc(p.name)}(${C.esc(p.statusZh)})`).join('、')}</div>` : ''}
    <div id="squad"></div>

    <div class="section"><h2>近期比賽</h2><span class="hint">${meta.lastSeason} 最後 10 場</span></div>
    <div class="card">${seasonGames.slice(-10).reverse().map(m => {
      const isHome = m.home === t.code;
      const gf = isHome ? m.fh : m.fa, ga = isHome ? m.fa : m.fh;
      const r = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
      return `<div class="stat-line"><span class="small">
        <i class="frm ${r}">${r}</i> ${isHome ? '主' : '客'} vs ${C.zh(isHome ? m.away : m.home)}</span>
        <span class="mono small">${gf} - ${ga} <span class="dim">${C.dateFull(m.date)}</span></span></div>`;
    }).join('')}</div>

    ${next.length ? `<div class="card" style="margin-top:14px"><h3>接下來的對手</h3>
      ${next.map(f => {
        const isHome = f.home === t.code;
        const p = f.prediction;
        const win = isHome ? p.home : p.away;
        return `<a href="fixtures.html?id=${f.id}" style="color:inherit;text-decoration:none">
          <div class="stat-line"><span class="small">${C.dateFull(f.date)} ${isHome ? '主' : '客'} vs ${C.zh(isHome ? f.away : f.home)}</span>
          <span class="mono small">勝率 ${C.pct(win, 0)}</span></div></a>`;
      }).join('')}</div>` : ''}
    ${C.foot(meta)}`;

    document.getElementById('squad').innerHTML = C.table(squad, [
      { key: 'name', label: '球員', value: p => p.name,
        render: p => `${C.esc(p.name)}${p.squadNumber ? ` <span class="dim tiny">#${p.squadNumber}</span>` : ''}${p.status !== 'a' ? ' <span class="pill bad tiny">' + p.statusZh + '</span>' : ''}${p.transferred ? ` <span class="pill tiny">來自 ${C.zh(p.lastTeam)}</span>` : ''}` },
      { key: 'pos', label: '位置', value: p => ['GK', 'DEF', 'MID', 'FWD'].indexOf(p.pos), render: p => p.posZh },
      { key: 'age', label: '年齡', value: p => p.age ?? 0, num: true },
      { key: 'minutes', label: '上季分鐘', value: p => p.last?.minutes ?? 0, num: true, render: p => p.last?.minutes ?? '—' },
      { key: 'goals', label: '進球', value: p => p.last?.goals ?? 0, num: true, render: p => p.last?.goals ?? '—' },
      { key: 'assists', label: '助攻', value: p => p.last?.assists ?? 0, num: true, render: p => p.last?.assists ?? '—' },
      { key: 'xgi90', label: 'xGI/90', value: p => p.last?.xgi90 ?? 0, num: true, render: p => (p.qualified ? p.last.xgi90 : '—') },
      { key: 'defCon90', label: '防守貢獻/90', value: p => p.last?.defCon90 ?? 0, num: true, render: p => (p.qualified ? p.last.defCon90 : '—') },
      { key: 'price', label: '身價', value: p => p.price, num: true, render: p => `£${p.price.toFixed(1)}m` },
    ], { sortKey: 'minutes', desc: true, onRow: p => { location.href = `players.html?code=${p.code}`; } });
  }
} catch (err) { C.fail(err); }
