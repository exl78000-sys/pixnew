#!/usr/bin/env node
/* 德義法球隊頁(FotMob)→ 收件匣 → 核對器 的守門(2026-10-09)。不連網:抓取器那段用假的 fetch。
 * 固定資料取樣自 2026-10-09 runner 上真跑抓取器的 log(義甲 4 隊,Roma 與 Lazio 共用奧林匹克球場),不是捏造。 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTeamsInbox, pageUrl, SOURCE_NOTE } from './lib/league-teams-inbox.mjs';
import { verifyTeamDelivery } from './lib/team-delivery.mjs';
import { fetchLeagueTeams, pickTeamPage } from './fetch-league-teams-fotmob.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const check = (label, ok, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`); if (!ok) fails++; };
console.log('\n▶ 德義法球隊頁(FotMob)的收件匣與核對');

const roster = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', 'teams-serie-a.json'), 'utf8')).teams;
const row = (code, id, name, venue, city, capacity, color) => ({ code, fotmobId: id, fotmobName: name, fetchedAt: '2026-10-09T12:17:00.000Z', venue, city, capacity, color });
const RAW = { fetchedAt: '2026-10-09T12:17:22Z', season: '2026-27', teams: [
  row('ROM', 8686, 'Roma', 'Stadio Olimpico', 'Roma', 70634, '#96092B'),
  row('INT', 8636, 'Inter', 'Stadio Giuseppe Meazza', 'Milano', 75817, '#010E80'),
  row('LAZ', 8543, 'Lazio', 'Stadio Olimpico', 'Roma', 70634, '#75acd4'),
  row('CAG', 8529, 'Cagliari', 'Unipol Domus', 'Cagliari', 16416, '#B51F2B'),
] };
const inbox = toTeamsInbox(RAW, roster);
const by = new Map(inbox.teams.map(t => [t.code, t]));
check('四隊都進收件匣、隊名取自名冊', inbox.teams.length === 4 && by.get('INT').en === roster.find(t => t.code === 'INT').en);
check('每一格有值就有出處,出處是那一隊自己的 FotMob 頁', inbox.teams.every(t => ['colors', 'city', 'venue', 'capacity'].every(f => t.sources[f] === pageUrl({ fotmobId: RAW.teams.find(r => r.code === t.code).fotmobId, fotmobName: RAW.teams.find(r => r.code === t.code).fotmobName }))));
check('隊色轉大寫、綽號不填(FotMob 不給,不編)', by.get('LAZ').colors[0] === '#75ACD4' && !('nickname' in by.get('LAZ')));
check('來源說明講出「單一來源」「原文名稱」「不一定是球衣主色」', /單一來源/.test(SOURCE_NOTE) && /原文/.test(SOURCE_NOTE) && /不一定是球衣主色/.test(SOURCE_NOTE));

const verify = ib => verifyTeamDelivery({ inboxRaw: Buffer.from(JSON.stringify(ib)), roster, control: null, crests: new Map(), capMin: 5000, capMax: 85000 });
const ok = verify(inbox);
check('核對器放行,而且對照組是 null 不是 0', ok.accepted && ok.controlTeams === null, ok.problems.join(';'));
check('共用球場(羅馬與拉齊奧)容量一致才過;改一邊就整份退回', !verify({ ...inbox, teams: inbox.teams.map(t => (t.code === 'LAZ' ? { ...t, capacity: 70000 } : t)) }).accepted);
check('容量超出區間整份退回', !verify({ ...inbox, teams: inbox.teams.map(t => (t.code === 'CAG' ? { ...t, capacity: 160000 } : t)) }).accepted);

const odd = toTeamsInbox({ teams: [row('XXX', 1, 'Unknown FC', 'Nowhere', 'Nowhere', 9000, '#112233'), row('CAG', 8529, 'Cagliari', null, 'Cagliari', 1.5, 'red')] }, roster);
check('不在名冊的隊不送;缺值與格式不對的欄位不填(不填 null、不猜)',
  odd.teams.length === 1 && !('venue' in odd.teams[0]) && !('capacity' in odd.teams[0]) && !('colors' in odd.teams[0]) && odd.teams[0].city === 'Cagliari');

check('pickTeamPage 只取要用的欄位(容量取 statPairs 的 Capacity)',
  JSON.stringify(pickTeamPage({ details: { teamColor: '#010E80' }, overview: { venue: { widget: { name: 'V', city: 'C', location: ['1', '2'] }, statPairs: [['Surface', 'Grass'], ['Capacity', 75817], ['Opened', 1926]] } } }))
  === JSON.stringify({ color: '#010E80', teamColors: null, venue: 'V', city: 'C', location: ['1', '2'], capacity: 75817, surface: 'Grass', opened: 1926, coachHistory: null }));

/* 抓取器:假的 fetch。TTL 內不重抓;抓失敗逐隊保留上一份;對不上名冊的跳過。 */
const calls = [];
const realFetch = globalThis.fetch;
let failId = null;
globalThis.fetch = async url => {
  calls.push(String(url));
  const ok = j => ({ ok: true, status: 200, json: async () => j });
  if (String(url).includes('/leagues?')) return ok({ table: [{ data: { table: { all: [{ id: 8636, name: 'Inter' }, { id: 9885, name: 'Juventus' }, { id: 1, name: 'Zzz Unknown' }] } } }] });
  if (String(url).endsWith(`id=${failId}`)) return { ok: false, status: 500 };
  return ok({ details: { teamColor: '#010E80' }, overview: { venue: { widget: { name: 'Stadio Giuseppe Meazza', city: 'Milano' }, statPairs: [['Capacity', 75817]] } } });
};
try {
  const dir = mkdtempSync(join(tmpdir(), 'epl-teams-'));
  const quiet = { outDir: dir, log: () => {} };
  await fetchLeagueTeams('it1', { ...quiet, force: true });
  const first = JSON.parse(readFileSync(join(dir, 'it1.json'), 'utf8'));
  check('對不上名冊的隊名跳過、對上的存下來', first.teams.length === 2 && first.teams.some(t => t.code === 'INT' && t.capacity === 75817));
  const n1 = calls.length;
  await fetchLeagueTeams('it1', quiet);
  check('TTL 內不重抓球隊頁(第二次只打聯賽頁 1 個請求)', calls.length - n1 === 1);
  failId = null;
  failId = 8636; // 只有國際米蘭那一頁失敗,尤文圖斯照常
  await fetchLeagueTeams('it1', { ...quiet, force: true });
  const kept = JSON.parse(readFileSync(join(dir, 'it1.json'), 'utf8'));
  check('某一隊的球隊頁抓失敗時逐隊保留上一份(不是整份覆寫、也不是少一隊)', kept.teams.length === 2 && kept.teams.find(t => t.code === 'INT')?.venue === 'Stadio Giuseppe Meazza');
} finally { globalThis.fetch = realFetch; }

/* 倉庫裡有 raw 時(部署回寫之後):整份要能走完收件匣 → 核對,而且被拒不是常態 */
for (const [k, roster_, crests] of [['de1', 'teams-bundesliga.json', 'crests-bundesliga.json'], ['it1', 'teams-serie-a.json', 'crests-serie-a.json'], ['fr1', 'teams-ligue-1.json', 'crests-ligue-1.json']]) {
  const p = join(ROOT, 'data', 'raw', 'fotmob-teams', `${k}.json`);
  if (!existsSync(p)) { console.log(`  · ${k}:倉庫裡還沒有 FotMob 球隊頁的 raw(部署回寫之後才有),略過`); continue; }
  const rs = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', roster_), 'utf8')).teams;
  const cr = new Map(Object.entries(JSON.parse(readFileSync(join(ROOT, 'data', 'manual', crests), 'utf8')).crests ?? {}));
  const r = verifyTeamDelivery({ inboxRaw: Buffer.from(JSON.stringify(toTeamsInbox(JSON.parse(readFileSync(p, 'utf8')), rs))), roster: rs, control: null, crests: cr, capMin: 5000, capMax: 85000 });
  check(`${k}:真實 raw 過核對器`, r.accepted, r.problems.join(';'));
}
console.log(fails ? `\n✗ ${fails} 條失敗` : '\n全部通過');
process.exit(fails ? 1 : 0);
