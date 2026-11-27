/* 球隊行事曆(2026-11-27,N6)的守門:捏資料驗格式與規則,有產物的話再驗每一隊都有檔、場數對得回賽程。 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { teamCalendar, icsUid } from './lib/ics.mjs';

let fail = 0;
const check = (c, label, detail = '') => { console.log(`  ${c ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`); if (!c) fail++; };
console.log('\n▶ 球隊行事曆(.ics)');

const team = { code: 'X', en: 'Xtown, United; FC', zh: '某隊' };
const fx = [
  { id: 's-1', season: 'S', round: 2, date: '2026-12-05', kickoff: null, home: 'Y', away: 'X', played: false },
  { id: 's-0', season: 'S', round: 1, date: '2026-11-28', kickoff: '2026-11-28T15:00:00Z', home: 'X', away: 'Y', played: true, fh: 2, fa: 1 },
  { id: 's-9', season: 'S', date: '2027-05-20', kickoff: '2027-05-20T18:00:00Z', home: 'X', away: 'Y', played: false, stage: 'playoff' },
  { id: 's-5', season: 'S', round: 3, date: '2026-12-12', kickoff: null, home: 'Z', away: 'Q', played: false },
];
const args = { lg: 'en2', lgZh: '英冠', team, nameOf: c => (c === 'X' ? team.en : c), fixtures: fx, builtAt: '2026-11-27T10:00:00Z', link: f => `https://e.x/analysis.html?id=${f.id}` };
const ics = teamCalendar(args);
const lines = ics.split('\r\n');
check(ics.endsWith('\r\n') && !/[^\r]\n/.test(ics), '行尾一律 CRLF');
check(lines.every(l => new TextEncoder().encode(l).length <= 75), '每一行(含續行)不超過 75 位元組');
/* 續行一定要以空白開頭,不然行事曆 App 把它當成一個不認得的屬性、整段描述被截掉(折行的負向對照抓到這條缺的) */
check(lines.filter(Boolean).every(l => /^[A-Z][A-Z-]*[:;]/.test(l) || l.startsWith(' ')) && lines.some(l => l.startsWith(' ')),
  '折出來的續行都以空白開頭', `${lines.filter(l => l.startsWith(' ')).length} 行續行`);
check((ics.match(/BEGIN:VEVENT/g) ?? []).length === 3, '只收這一隊的場次');
const unfolded = ics.replace(/\r\n /g, '');
check(/DTSTART;VALUE=DATE:20261205\r\nDTEND;VALUE=DATE:20261206/.test(unfolded) && /SUMMARY:Y vs Xtown\\, United\; FC\(時間待定\)/.test(unfolded),
  '沒有開球時間的寫成全天事件、標時間待定,不編時間;逗號分號有跳脫');
check(/DTSTART:20261128T150000Z\r\nDTEND:20261128T170000Z/.test(unfolded) && /SUMMARY:Xtown\\, United\; FC 2-1 Y/.test(unfolded),
  '有時間的用 UTC、已賽的標題帶比分');
check(icsUid('en2', fx[2]) !== icsUid('en2', { ...fx[2], stage: undefined, date: '2026-11-28' }) && icsUid('en2', fx[2]).includes('2027-05-20'),
  '附加賽的 UID 帶日期,不會跟同一組主客的聯賽場次撞');
const shuffled = teamCalendar({ ...args, fixtures: [...fx].reverse().map((f, i) => ({ ...f, id: `z-${i}` })) });
const uids = s => [...s.matchAll(/UID:(.+)/g)].map(m => m[1]).sort().join();
check(uids(ics) === uids(shuffled), 'UID 跨建置穩定:賽程順序與場次 id 換了也一樣(不然訂閱的人會看到重複的比賽)');
check(!/URL:/.test(teamCalendar({ ...args, link: null })), '沒有站台網址的建置不放連結(不寫猜的網址)');

const ROOT = new URL('../web/data/', import.meta.url).pathname;
const ICS = join(ROOT, 'ics');
if (!existsSync(ICS)) console.log('  · 還沒有 web/data/ics/(沒跑 npm run build),略過產物那一段');
else {
  const dirs = [['pl', ROOT], ...readdirSync(join(ROOT, 'leagues')).sort().map(k => [k, join(ROOT, 'leagues', k)])]
    .filter(([, d]) => existsSync(join(d, 'teams.json')));
  for (const [lg, d] of dirs) {
    const meta = JSON.parse(readFileSync(join(d, 'meta.json'), 'utf8'));
    const teams = JSON.parse(readFileSync(join(d, 'teams.json'), 'utf8'));
    const fixtures = JSON.parse(readFileSync(join(d, 'fixtures.json'), 'utf8')).filter(f => f.season === meta.currentSeason);
    const bad = [];
    for (const t of teams) {
      const p = join(ICS, lg, `${t.code}.ics`);
      if (!existsSync(p)) { bad.push(`${t.code} 沒有檔`); continue; }
      const n = (readFileSync(p, 'utf8').match(/BEGIN:VEVENT/g) ?? []).length;
      const want = fixtures.filter(f => (f.home === t.code || f.away === t.code) && f.date).length;
      if (n !== want) bad.push(`${t.code} ${n} vs ${want}`);
    }
    check(!bad.length, `${lg}:每一隊都有行事曆,場數等於本季賽程`, bad.slice(0, 3).join('、') || `${teams.length} 隊`);
  }
}
console.log(fail ? `\n✗ 球隊行事曆:${fail} 條沒過` : '\n✓ 球隊行事曆:全部通過');
process.exit(fail ? 1 : 0);
