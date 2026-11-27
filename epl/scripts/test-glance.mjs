/* 總覽「我的球隊」條(2026-11-27,N5)的守門。
   teamGlance 是純函式(glance.js 沒有 import),捏資料驗規則,再拿每個聯賽的 overview.json 驗性質。 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { teamGlance } from '../web/assets/js/glance.js';

let fail = 0;
const check = (c, label, detail = '') => { console.log(`  ${c ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`); if (!c) fail++; };
console.log('\n▶ 我的球隊條:上一場 / 下一場');

const fx = [
  { id: 'a', date: '2026-10-01', kickoff: '2026-10-01T19:00:00Z', home: 'X', away: 'Y', played: true, fh: 0, fa: 2 },
  { id: 'b', date: '2026-10-08', kickoff: '2026-10-08T19:00:00Z', home: 'Z', away: 'X', played: true, fh: 1, fa: 3, scoreProvisional: true },
  { id: 'c', date: '2026-10-09', kickoff: null, home: 'X', away: 'Z', played: true },          // 已賽沒比分:不算上一場
  { id: 'd', date: '2026-10-20', kickoff: null, home: 'X', away: 'W', played: false },          // 同一天沒時間的排在有時間的後面
  { id: 'e', date: '2026-10-20', kickoff: '2026-10-20T12:00:00Z', home: 'V', away: 'X', played: false },
  { id: 'f', date: '2026-10-15', kickoff: null, home: 'Q', away: 'R', played: false },          // 別隊的
];
const g = teamGlance(fx, 'X');
check(g.last?.id === 'b' && g.last.result === 'W' && g.last.gf === 3 && g.last.ga === 1 && !g.last.home && g.last.provisional,
  '上一場是最近一場有比分的,勝負照自己這一邊算、暫定帶旗標', JSON.stringify(g.last));
check(g.next?.id === 'e' && g.next.opp === 'V' && !g.next.home, '下一場是最早的未賽(同一天有時間的先)', JSON.stringify(g.next));
const g2 = teamGlance(fx.filter(f => f.id !== 'e'), 'X');
check(g2.next?.id === 'd' && g2.next.kickoff === null, '只有日期沒時間的未賽照樣算下一場(數的是還沒踢,不是有開球時間)');
check(teamGlance([], 'X').last === null && teamGlance([], 'X').next === null, '沒有比賽就兩邊都是 null(畫面講「還沒有」,不留空格)');

const ROOT = new URL('../web/data/', import.meta.url).pathname;
const dirs = [['pl', ROOT], ...readdirSync(join(ROOT, 'leagues')).sort().map(k => [k, join(ROOT, 'leagues', k)])]
  .filter(([, d]) => existsSync(join(d, 'overview.json')));
for (const [lg, d] of dirs) {
  const o = JSON.parse(readFileSync(join(d, 'overview.json'), 'utf8'));
  const bad = [];
  for (const t of o.teams) {
    const r = teamGlance(o.fixtures, t.code);
    const unplayed = o.fixtures.filter(f => !f.played && (f.home === t.code || f.away === t.code));
    if (unplayed.length && !r.next) bad.push(`${t.code} 有未賽卻沒有下一場`);
    if (r.last && ![r.last.gf, r.last.ga].every(Number.isInteger)) bad.push(`${t.code} 上一場比分不是整數`);
    if (r.next && o.fixtures.find(f => f.id === r.next.id)?.played) bad.push(`${t.code} 下一場是已賽`);
  }
  check(!bad.length, `${lg}:每一隊的上一場 / 下一場都對得回賽程摘要`, bad.slice(0, 3).join('、') || `${o.teams.length} 隊`);
}

/* 跨聯賽的一頁,身分不准查目前聯賽的名冊(隊碼跨聯賽重複):條上不准用 C.badge / C.name / C.team。 */
const src = readFileSync(new URL('../web/assets/js/my-strip.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check(!/C\.(badge|name|team|teamLink)\(/.test(src), '我的球隊條的隊名與隊徽從那個聯賽自己的名冊查,不走目前聯賽');
check(/teamGlance\(/.test(src), '條上的上一場 / 下一場走 teamGlance(測試驗的就是那一段)');
check(/!r\.saved/.test(src), '存不進瀏覽器時要講出來(toggleFollow 回 saved)');

console.log(fail ? `\n✗ 我的球隊條:${fail} 條沒過` : '\n✓ 我的球隊條:全部通過');
process.exit(fail ? 1 : 0);
