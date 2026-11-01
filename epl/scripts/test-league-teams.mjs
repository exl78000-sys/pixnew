#!/usr/bin/env node
/* 德義法球隊頁(FotMob)→ 收件匣 → 核對器 的守門(2026-10-09)。不連網:抓取器那段用假的 fetch。
 * 固定資料取樣自 2026-10-09 runner 上真跑抓取器的 log(義甲 4 隊,Roma 與 Lazio 共用奧林匹克球場),不是捏造。 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTeamsInbox, pageUrl, SOURCE_NOTE } from './lib/league-teams-inbox.mjs';
import { verifyTeamDelivery } from './lib/team-delivery.mjs';
import { fetchLeagueTeams, pickTeamPage, coachRefetchReason, latestLineupCoaches } from './fetch-league-teams-fotmob.mjs';
import { resolveLineupCoach } from './lib/league-coach.mjs';
import { normName } from './lib/names.mjs';

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
  === JSON.stringify({ color: '#010E80', teamColors: null, venue: 'V', city: 'C', location: ['1', '2'], capacity: 75817, surface: 'Grass', opened: 1926, coachHistory: null, coachHistoryFull: true }));
/* 教練歷任整份存(2026-11-01):截成三筆的話,帶隊超過三筆的教練上任季會被算晚 */
{
  const hist = [{ name: 'Patrick Videira', season: '2026/2027' }, ...Array.from({ length: 5 }, (_, i) => ({ name: `X${i}`, season: `202${i}/202${i + 1}` }))];
  check('pickTeamPage 存整份教練歷任(不截短;現任排在最前也留得住)', pickTeamPage({ overview: { coachHistory: hist } }).coachHistory.length === 6);
}

/* 教練提早重抓:名單上的教練不在快取裡才重抓,抓過之後(快取晚於那一場)不再重抓 */
{
  const page = (at, full, names) => ({ fetchedAt: at, coachHistoryFull: full, coachHistory: names.map(name => ({ name, season: '2026/2027' })) });
  const latest = { coach: 'Alexander Blessin', date: '2026-10-23T18:30:00Z' };
  check('名單教練在快取裡 → 不重抓', coachRefetchReason(page('2026-10-09T00:00:00Z', true, ['Alexander Blessin']), latest) === null);
  check('名單教練不在、快取是那一場之前抓的 → 重抓', /之前抓的/.test(coachRefetchReason(page('2026-10-09T00:00:00Z', true, ['Eugen Polański']), latest) ?? ''));
  check('名單教練不在、快取是截短版 → 重抓', /截短/.test(coachRefetchReason(page('2026-10-30T00:00:00Z', false, ['Eugen Polański']), latest) ?? ''));
  check('名單教練不在、但快取是那一場之後抓的完整版(停賽的代理教練)→ 不再重抓', coachRefetchReason(page('2026-10-30T00:00:00Z', true, ['Vincent Kompany']), { coach: 'Aaron Danks', date: '2026-10-25T13:30:00Z' }) === null);
  check('同一位已經查過一次沒有(coachMissing)→ 不再為他重抓(不然每踢一輪重抓一次)',
    coachRefetchReason({ ...page('2026-11-01T00:00:00Z', true, ['Lukas Kwasniok']), coachMissing: 'Rene Wagner' }, { coach: 'Rene Wagner', date: '2026-11-08T00:00:00Z' }) === null);
  check('coachMissing 是別人時照樣重抓', /之前抓的/.test(coachRefetchReason({ ...page('2026-11-01T00:00:00Z', true, ['Lukas Kwasniok']), coachMissing: 'Rene Wagner' }, { coach: 'Someone Else', date: '2026-11-08T00:00:00Z' }) ?? ''));
  check('重音不算不同人(Rene / René)', coachRefetchReason(page('2026-10-09T00:00:00Z', true, ['René Wagner']), { coach: 'Rene Wagner', date: '2026-10-24T00:00:00Z' }) === null);
  const d = mkdtempSync(join(tmpdir(), 'epl-coach-'));
  writeFileSync(join(d, '2026-27-game-details.json'), JSON.stringify({ matches: {
    'FCB|BMG': { date: '2026-10-17', lineups: { FCB: { coach: 'Vincent Kompany' }, BMG: { coach: 'Alexander Blessin' } } },
    'SVW|FCB': { date: '2026-10-25', lineups: { FCB: { coach: 'Aaron Danks' }, SVW: { coach: null } } },
  } }));
  const lc = latestLineupCoaches(d);
  check('latestLineupCoaches 取每隊最新一場、沒有教練的不算', lc.get('FCB')?.coach === 'Aaron Danks' && lc.get('BMG')?.coach === 'Alexander Blessin' && !lc.has('SVW'));
  check('沒有逐場 raw 時回空的', latestLineupCoaches(join(d, 'nope')).size === 0);
}

/* 現任教練判定(lib/league-coach.mjs):最後一場是代理教練時,只有球隊頁是那之後抓的才退回前一位 */
{
  const same = (a, b) => normName(a) === normName(b);
  const m = (date, coach) => ({ date, lineups: { NAP: { coach } } });
  const ms = [m('2026-10-17', 'Massimiliano Allegri'), m('2026-10-24', 'Massimiliano Allegri'), m('2026-10-28', 'Marco Landucci')];
  const pg = (at, names, season = '2026/2027') => ({ fetchedAt: at, coachHistoryFull: true, coachHistory: names.map(name => ({ name, season })) });
  const r1 = resolveLineupCoach({ ms, code: 'NAP', page: pg('2026-10-30T00:00:00Z', ['Massimiliano Allegri']), curSeason: '2026/2027', same });
  check('代理教練:球隊頁是那之後抓的、本季仍記前一位 → 發布前一位,帶出哪幾場是別人坐鎮',
    r1.name === 'Massimiliano Allegri' && r1.standIn?.dates.join() === '2026-10-28' && r1.standIn.names.join() === 'Marco Landucci' && r1.lastMatch === '2026-10-24');
  const r2 = resolveLineupCoach({ ms, code: 'NAP', page: pg('2026-10-20T00:00:00Z', ['Massimiliano Allegri']), curSeason: '2026/2027', same });
  check('代理教練:球隊頁是那之前抓的 → 不發布(分不出代理還是換帥)', r2.skip && /之前抓的/.test(r2.skip));
  const r3 = resolveLineupCoach({ ms, code: 'NAP', page: pg('2026-10-30T00:00:00Z', ['Massimiliano Allegri'], '2025/2026'), curSeason: '2026/2027', same });
  check('代理教練:前一位的紀錄只到上季 → 不發布', Boolean(r3.skip));
  const r4 = resolveLineupCoach({ ms, code: 'NAP', page: pg('2026-10-30T00:00:00Z', ['Massimiliano Allegri', 'Marco Landucci']), curSeason: '2026/2027', same });
  check('球隊頁也記了最後一場那位 → 他就是現任,不當代理', r4.name === 'Marco Landucci' && r4.standIn === null && !r4.fromStart);
  const r5 = resolveLineupCoach({ ms: ms.slice(0, 2), code: 'NAP', page: pg('2026-10-09T00:00:00Z', ['Massimiliano Allegri']), curSeason: '2026/2027', same });
  check('一般情況:最後一場的教練在紀錄裡 → 發布、沒有代理', r5.name === 'Massimiliano Allegri' && r5.standIn === null && r5.fromStart);
}

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
  /* 接線:TTL 內、但快取比那一隊最新一場名單還舊而且沒有那位教練 → 只重抓那一隊(倉庫裡義甲的逐場 raw 有 INT 的名單才驗) */
  if (latestLineupCoaches(join(ROOT, 'data', 'raw', 'fotmob-serie-a')).has('INT')) {
    const fp = join(dir, 'it1.json'), c = JSON.parse(readFileSync(fp, 'utf8'));
    for (const t of c.teams) if (t.code === 'INT') { t.fetchedAt = '2026-07-01T00:00:00.000Z'; delete t.coachMissing; }   // 舊快取沒有這個欄位
    writeFileSync(fp, JSON.stringify(c));
    const n2 = calls.length;
    await fetchLeagueTeams('it1', { ...quiet, ttlDays: 100000 });
    check('教練紀錄過期的那一隊在 TTL 內也重抓,其餘不動', calls.length - n2 === 2 && calls.at(-1).endsWith('id=8636'), `${calls.length - n2} 個請求`);
    const c2 = JSON.parse(readFileSync(fp, 'utf8')), int2 = c2.teams.find(t => t.code === 'INT');
    check('重抓回來仍然沒有他 → 記成 coachMissing', Boolean(int2.coachMissing));
    int2.fetchedAt = '2026-07-01T00:00:00.000Z';
    writeFileSync(fp, JSON.stringify(c2));
    const n3 = calls.length;
    await fetchLeagueTeams('it1', { ...quiet, ttlDays: 100000 });
    check('記過 coachMissing 的那一隊不再為同一位重抓', calls.length - n3 === 1, `${calls.length - n3} 個請求`);
  }
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
