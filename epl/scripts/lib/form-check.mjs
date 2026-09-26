/* 近況(form.json)的形狀與內容(測試用;2026-09-26)。

   英冠與德義法的 build 原本把 `form.teams` 寫成陣列(每隊攤平 + `matches`),而前端(球隊頁的近期比賽、
   單場頁的近況)照隊碼查 `form.teams[code].recent` —— 查不到就走「沒有資料」那條:球隊頁印「尚無近期賽果。」、
   單場頁的近況整塊不見,**而資料明明在**。守三件事:
   一、`teams` 是以隊碼為鍵的物件,本季每一隊都在;
   二、每一隊的 summary 跟 recent 加得起來(場數、勝和負、進失球);
   三、recent 的每一場在 results.json 找得到 —— 同一天、同兩隊、主客方向與比分都對(對照組是另一份程式組的賽果檔)。
      results.json 只收最近兩季,更早的場次不判,數量另外回報(不算通過)。 */
export function formIssues({ form, results, fixtures, currentSeason }) {
  const issues = [];
  let checked = 0, skipped = 0;
  const T = form?.teams;
  if (!T || Array.isArray(T) || typeof T !== 'object') {
    return { issues: [`form.teams 不是以隊碼為鍵的物件(拿到的是${Array.isArray(T) ? '陣列' : typeof T})`], checked, skipped };
  }
  const cur = [...new Set(fixtures.filter(f => f.season === currentSeason).flatMap(f => [f.home, f.away]))];
  const miss = cur.filter(c => !T[c]?.recent);
  if (miss.length) issues.push(`本季 ${miss.length} 隊沒有近況:${miss.slice(0, 5).join('、')}`);
  const seasons = new Set(results.map(m => m.season));
  const byKey = new Map(results.filter(m => m.played).map(m => [`${m.date}|${m.home}|${m.away}`, m]));
  for (const [code, t] of Object.entries(T)) {
    const rec = t.recent ?? [];
    const s = t.summary ?? {};
    const n = res => rec.filter(r => r.res === res).length;
    const sum = k => rec.reduce((acc, r) => acc + (r[k] ?? 0), 0);
    if (s.games !== rec.length || s.w !== n('W') || s.d !== n('D') || s.l !== n('L') || s.gf !== sum('gf') || s.ga !== sum('ga')) {
      issues.push(`${code}:summary 跟 recent 加不起來`);
    }
    for (const r of rec) {
      if (!seasons.has(r.season)) { skipped++; continue; }
      const home = r.venue === 'H';
      const [h, a] = home ? [code, r.opp] : [r.opp, code];
      const m = byKey.get(`${r.date}|${h}|${a}`);
      const res = r.gf > r.ga ? 'W' : r.gf < r.ga ? 'L' : 'D';
      if (!m) issues.push(`${code} ${r.date} ${h}-${a}:results.json 沒有這一場`);
      else if ((home ? [m.fh, m.fa] : [m.fa, m.fh]).join('-') !== `${r.gf}-${r.ga}` || r.res !== res) issues.push(`${code} ${r.date} ${h}-${a}:比分或勝負對不上`);
      else checked++;
    }
  }
  return { issues, checked, skipped };
}
