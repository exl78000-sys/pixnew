#!/usr/bin/env node
// 探勘:football-data.co.uk 的本季賠率檔到底發布了沒。
// 沙箱連不到外網,由 workflow 在 runner 上跑。用完就可以刪。
const UA = { 'user-agent': 'pl-war-room/1.0 (football analysis side project)' };
const url = code => `https://www.football-data.co.uk/mmz4281/${code}/E0.csv`;

console.log('賽季代碼 → HTTP 狀態 / 位元組 / 最後一場的日期\n');
for (const [season, code] of [['2023-24', '2324'], ['2024-25', '2425'], ['2025-26', '2526'], ['2026-27', '2627']]) {
  try {
    const res = await fetch(url(code), { headers: UA });
    if (!res.ok) { console.log(`  ${season}  ${code}  ✗ HTTP ${res.status}`); continue; }
    const text = await res.text();
    const lines = text.trim().split('\n');
    const head = lines[0].split(',');
    const last = lines.at(-1).split(',');
    const di = head.indexOf('Date'), hi = head.indexOf('HomeTeam'), ai = head.indexOf('AwayTeam');
    // 有沒有 Pinnacle 收盤欄位(我們最想要的那一組)
    const hasPSC = ['PSCH', 'PSCD', 'PSCA'].every(k => head.includes(k));
    console.log(`  ${season}  ${code}  ✔ 200  ${text.length}B  ${lines.length - 1} 場`
      + `  最後:${last[di]} ${last[hi]} vs ${last[ai]}  PSC 收盤欄位:${hasPSC ? '有' : '無'}`);
  } catch (e) { console.log(`  ${season}  ${code}  ✗ ${e.message}`); }
}

// 本季還沒發布的話,有沒有「未來賽程 + 賠率」的檔可用?
console.log('\n未來賽程賠率檔(fixtures.csv):');
for (const u of ['https://www.football-data.co.uk/fixtures.csv', 'https://www.football-data.co.uk/mmz4281/2627/E0.csv']) {
  try {
    const res = await fetch(u, { headers: UA });
    const text = res.ok ? await res.text() : '';
    const lines = text.trim().split('\n');
    const head = (lines[0] ?? '').split(',');
    const e0 = res.ok ? lines.filter(l => l.startsWith('E0,')).length : 0;
    console.log(`  ${u.replace('https://www.football-data.co.uk', '')}  → HTTP ${res.status}`
      + (res.ok ? `  ${lines.length - 1} 列・其中英超 ${e0} 場・欄位含 PSCH:${head.includes('PSCH')}・含 PSH:${head.includes('PSH')}` : ''));
    if (res.ok && e0) console.log('     英超第一列:', lines.find(l => l.startsWith('E0,'))?.slice(0, 160));
  } catch (e) { console.log(`  ${u}  ✗ ${e.message}`); }
}
console.log('\n完成。');
