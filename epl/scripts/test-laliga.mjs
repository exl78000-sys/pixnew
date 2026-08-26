#!/usr/bin/env node
// 西甲資料邊界測試：守住兩季、20 隊、真實球隊風格與「不假裝已有球員資料」。
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fetchCompletedMatchDetails, normaliseMatchDetail } from './lib/adapters/api-football.mjs';
import { enrichPlayers, coverage as sportmonksCoverage, normaliseSportmonksMatch } from './lib/adapters/sportmonks.mjs';
import { buildProviderMatchReport } from './lib/postmatch-report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = season => JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'openfootball-la-liga', `${season}.json`), 'utf8'));
const situations = () => JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'understat-la-liga', '2025-26-team-situations.json'), 'utf8'));
const out = name => JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'es1', `${name}.json`), 'utf8'));
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
};

console.log('\n▶ 西甲球隊數據第二版自我檢查');
const last = raw('2025-26'), current = raw('2026-27');
const understat = situations();
const meta = out('meta'), fixtures = out('fixtures'), teams = out('teams'), official = out('official');
const players = out('players');

check('只納入指定兩季', meta.lastSeason === '2025-26' && meta.currentSeason === '2026-27');
check('2025-26 原始賽程 380 場', last.matches.length === 380, String(last.matches.length));
check('2026-27 原始賽程 380 場', current.matches.length === 380, String(current.matches.length));
check('本季輸出 20 隊', teams.length === 20, String(teams.length));
check('本季 20 隊都有內嵌 PNG 隊徽', teams.every(t => t.crest?.startsWith('data:image/png;base64,')), String(teams.filter(t => t.crest).length));
check('本季輸出 380 場', fixtures.length === 380, String(fixtures.length));
check('未賽場次預測三向機率加總約等於 1', fixtures.filter(f => !f.played).every(f => {
  const p = f.prediction;
  return p && Math.abs(p.home + p.draw + p.away - 1) < 0.002;
}));
check('已完賽場次不拿重擬合機率冒充賽前預測', fixtures.filter(f => f.played).every(f => f.prediction === null));
const officialMatches = Object.entries(official.matches ?? {});
check('逐場正式先發已轉成本站資料格式', official.available === true && officialMatches.length > 0
  && official.sources?.includes('fotmob/enetpulse'));
check('FotMob 正式先發逐場對回比分與兩隊 11 人', officialMatches.every(([key, match]) => {
  const f = fixtures.find(x => `${x.home}|${x.away}` === key);
  return f?.played && f.fh === match.score?.home && f.fa === match.score?.away
    && match.home?.xi?.length === 11 && match.away?.xi?.length === 11
    && match.home?.formation && match.away?.formation;
}));
check('FotMob 站位排數可供球場圖使用', officialMatches.every(([, match]) =>
  match.home.rows?.flat().length === 11 && match.away.rows?.flat().length === 11));
check('西甲官網補齊缺漏場次並保留頭像', official.sources?.includes('laliga.com')
  && ['DEP|ELC', 'MAL|DEP'].every(key => official.matches?.[key]?.source === 'laliga.com')
  && ['DEP|ELC', 'MAL|DEP'].every(key => official.matches[key].home.xi.some(p => p.photo)
    && official.matches[key].away.xi.some(p => p.photo)));
/* 球員資料改由 Understat 提供(API-Football 的 Free 方案不含本季與上季,實測過)。
   這裡守的不再是「關閉」,而是**開了之後不能偷偷造欄位**:
   Understat 沒有背號、頭貼、傷停與防守數據,那就一個都不准出現。 */
const leaders = out('leaders');
const FORBIDDEN = ['price', 'status', 'news', 'defCon90', 'saves90', 'tackles90'];
check('西甲球員資料已接上', meta.capabilities?.players === true && players.length > 0);
check('沒有假造 Understat 給不了的欄位',
  players.every(p => FORBIDDEN.every(k => !(k in p))), FORBIDDEN.join());
check('缺什麼有寫在資料層讓畫面照講', Array.isArray(leaders.missing) && leaders.missing.length > 0);
const smPlayer = enrichPlayers([{ name: 'Pedri', teams: ['Barcelona'] }], {
  season: '2026-27', squads: { BAR: [{ jersey_number: 8, captain: true, player: {
    id: 42, display_name: 'Pedri', image_path: 'https://cdn.example/pedri.png',
    date_of_birth: '2002-11-25', height: 174, weight: 60, nationality_id: 214,
  } }] },
}, { codeOf: name => name === 'Barcelona' ? 'BAR' : null });
check('SportMonks 欄位只從本地快取補入', smPlayer.matched === 1
  && smPlayer.players[0].squadNumber === 8 && smPlayer.players[0].photo?.startsWith('https://')
  && sportmonksCoverage(smPlayer.players).physical === 1);
const smXI = (teamId, prefix) => Array.from({ length: 11 }, (_, i) => ({
  player_id: teamId * 100 + i, team_id: teamId, player_name: `${prefix} ${i + 1}`,
  jersey_number: i + 1, position_id: i === 0 ? 24 : i < 5 ? 26 : i < 8 ? 31 : 37,
  type_id: 11, formation_field: `${i < 1 ? 1 : i < 5 ? 2 : i < 8 ? 3 : 4}:${(i % 4) + 1}`,
  details: [{ type: { code: 'rating' }, data: { value: 7.2 } }, { type: { code: 'minutes-played' }, data: { value: 90 } }],
}));
const smDetail = normaliseSportmonksMatch({
  id: 123, starting_at: '2026-08-20 19:00:00', participants: [
    { id: 1, name: 'Barcelona', meta: { location: 'home' } }, { id: 2, name: 'Athletic Club', meta: { location: 'away' } },
  ], formations: [{ participant_id: 1, formation: '4-3-3' }, { participant_id: 2, formation: '4-2-3-1' }],
  lineups: [...smXI(1, 'BAR'), ...smXI(2, 'ATH')],
  statistics: [{ participant_id: 1, type: { code: 'shots-total' }, data: { value: 12 }, location: 'home' },
    { participant_id: 2, type: { code: 'shots-total' }, data: { value: 8 }, location: 'away' }],
  events: [{ participant_id: 1, type: { code: 'goal' }, minute: 22, player_name: 'BAR 2' }],
}, { codeOf: name => ({ Barcelona: 'BAR', 'Athletic Club': 'ATH' }[name] ?? null),
  fixture: { home: 'BAR', away: 'ATH', season: '2026-27', played: true, fh: 1, fa: 0 },
  teamCodeById: new Map([['1', 'BAR'], ['2', 'ATH']]), season: '2026-27' });
check('SportMonks 賽後資料轉成本站格式', smDetail?.coverage?.lineups === true
  && smDetail.lineups.BAR.xi.length === 11 && smDetail.lineups.ATH.formation === '4-2-3-1'
  && smDetail.coverage.ratings === true && smDetail.events[0].type === 'Goal');
check('每 90 分鐘只在達門檻時給出,不足門檻一律 null',
  players.every(p => (p.minutes >= leaders.minMinutes) === (p.xgi90 !== null)));
check('跨隊球員標記出來,不硬掛到單一球隊',
  players.filter(p => p.teams.length > 1).every(p => p.multiTeam === true));
check('百分位只跟同季同位置達門檻的人比',
  players.every(p => (p.radar == null) || (p.qualified && p.pos && p.peerCount >= 5)));
check('兩季分開存放,不混在一起',
  new Set(players.map(p => p.season)).size === 2);
check('沒有虛構 FPL 賽程難度', fixtures.every(f => f.difficulty === null));
check('Understat 上季 20 隊快取完整', understat.complete && Object.keys(understat.teams ?? {}).length === 20);
check('Understat 20 隊逐場比分全部核對', understat.validation?.allScorelinesReconciled === true);
check('進球情境總量 18/20 通過核對', understat.validation?.situationGoalTotalsReconciled === 18);
check('本季 17 支回歸球隊有上季風格', teams.filter(t => t.tactics).length === 17, String(teams.filter(t => t.tactics).length));
check('三支升班馬不補造上季風格', ['DEP', 'MAL', 'RAC'].every(code => teams.find(t => t.code === code)?.tactics === null));
check('每個風格雷達都有六軸有效百分位', teams.filter(t => t.tactics).every(t =>
  t.tactics.radar?.length === 6 && t.tactics.radar.every(x => Number.isFinite(x.value) && x.value >= 0 && x.value <= 100)));
check('風格資料都有五種進球情境與來源', teams.filter(t => t.tactics).every(t =>
  t.tactics.setPieces?.available && Object.keys(t.tactics.setPieces.breakdown ?? {}).length === 5 && /^https:\/\//.test(t.tactics.sourceUrl)));
const bar = teams.find(t => t.code === 'BAR')?.tactics?.setPieces;
check('Barcelona 情境進球與 xG 可呈現', bar?.goalsReliable === true && Number.isFinite(bar.goals) && Number.isFinite(bar.xG90));
const vil = teams.find(t => t.code === 'VIL')?.tactics?.setPieces;
check('Villarreal 不硬補未核對的情境進球', vil?.goalsReliable === false && vil.goals === null && Number.isFinite(vil.xG90));
check('陣型使用比例合計約 100%', teams.filter(t => t.tactics).every(t => {
  const total = t.tactics.formation.list.reduce((n, x) => n + x.share, 0);
  return total >= 99.5 && total <= 100.5;
}));

// 使用假供應商回應驗證完整賽後資料契約；不連線、不消耗 API 額度。
const home = teams.find(t => t.code === 'BAR'), away = teams.find(t => t.code === 'ATH');
const apiNames = new Map([[home.en, home.code], [away.en, away.code]]);
const lineupPlayers = (prefix, base) => {
  const layout = [['G', 1], ['D', 4], ['M', 3], ['F', 3]];
  let index = 0;
  return layout.flatMap(([pos, count], row) => Array.from({ length: count }, (_, col) => {
    index++;
    return { player: { id: base + index, name: `${prefix} ${index}`, number: index, pos, grid: `${row + 1}:${col + 1}` } };
  }));
};
const homeXI = lineupPlayers('Barcelona Test', 1000), awayXI = lineupPlayers('Athletic Test', 2000);
const playerStats = (team, xi, rating) => ({ team: { name: team.en }, players: xi.map((x, i) => ({
  player: { id: x.player.id, name: x.player.name, photo: `https://example.com/${x.player.id}.png` },
  statistics: [{
    games: { minutes: 90, number: x.player.number, position: x.player.pos, rating: String(rating - i / 100), captain: i === 0, substitute: false },
    shots: { total: i % 3, on: i % 2 }, goals: { total: i === 1 ? 1 : 0, assists: i === 2 ? 1 : 0, saves: i === 0 ? 3 : null },
    passes: { total: 40 + i, key: i % 2, accuracy: '85%' }, tackles: { total: 2, blocks: 1, interceptions: 1 },
    duels: { total: 8, won: 5 }, dribbles: { attempts: 2, success: 1 }, fouls: { drawn: 1, committed: 1 }, cards: { yellow: 0, red: 0 },
  }],
})) });
const fakeRaw = {
  fixture: { id: 999, date: '2026-08-20T19:00:00Z', status: { short: 'FT' } },
  teams: { home: { name: home.en }, away: { name: away.en } }, goals: { home: 2, away: 1 },
  lineups: [
    { team: { name: home.en }, formation: '4-3-3', coach: { name: 'Test Home Coach' }, startXI: homeXI, substitutes: [] },
    { team: { name: away.en }, formation: '4-2-3-1', coach: { name: 'Test Away Coach' }, startXI: awayXI, substitutes: [] },
  ],
  statistics: [
    { team: { name: home.en }, statistics: [{ type: 'Total Shots', value: 15 }, { type: 'Shots on Goal', value: 7 }, { type: 'Ball Possession', value: '58%' }, { type: 'expected_goals', value: '1.82' }] },
    { team: { name: away.en }, statistics: [{ type: 'Total Shots', value: 9 }, { type: 'Shots on Goal', value: 3 }, { type: 'Ball Possession', value: '42%' }, { type: 'expected_goals', value: '0.91' }] },
  ],
  players: [playerStats(home, homeXI, 8.1), playerStats(away, awayXI, 7.2)],
  events: [{ time: { elapsed: 22 }, team: { name: home.en }, player: { id: 1002, name: 'Barcelona Test 2' }, type: 'Goal', detail: 'Normal Goal' }],
};
const codeOf = name => apiNames.get(name) ?? null;
const fakeDetail = normaliseMatchDetail(fakeRaw, { codeOf, season: '2026-27' });
const fakeFixture = { season: '2026-27', home: home.code, away: away.code, played: true, fh: 2, fa: 1, kickoff: fakeDetail.kickoff };
const fakeReport = buildProviderMatchReport({ fixture: fakeFixture, detail: fakeDetail, nameOf: code => teams.find(t => t.code === code)?.en ?? code });
check('賽後正規化保留兩隊正式陣容與格線', fakeDetail?.coverage?.lineups === true && fakeDetail.lineups.BAR.xi.length === 11 && fakeDetail.lineups.ATH.formation === '4-2-3-1');
check('賽後報告含真實 xG、評分、事件與正式陣型', fakeReport?.sides?.BAR?.xG === 1.82 && fakeReport.sides.BAR.best[0].rating === 8.1
  && fakeReport.advanced.events.length === 1 && fakeReport.sides.ATH.shape.label === '4-2-3-1');
check('比分不一致的供應商資料禁止發布', buildProviderMatchReport({ fixture: { ...fakeFixture, fh: 3 }, detail: fakeDetail }) === null);

const tempRoot = await mkdtemp(join(tmpdir(), 'laliga-postmatch-test-'));
let fakeCalls = 0;
const fakeFetch = async () => {
  fakeCalls++;
  return { ok: true, status: 200, json: async () => ({ response: [fakeRaw] }) };
};
const fetchArgs = {
  root: tempRoot, season: '2026-27', codeOf, leagueId: 140,
  storeDir: 'api-football-la-liga', storeFile: '2026-27-match-details.json', requireLineups: true,
  onlyKeys: new Set(['BAR|ATH']), expectedScores: new Map([['BAR|ATH', { home: 2, away: 1 }]]),
  env: { API_FOOTBALL_KEY: 'test-key' }, fetchImpl: fakeFetch,
};
const firstFetch = await fetchCompletedMatchDetails(fetchArgs);
const secondFetch = await fetchCompletedMatchDetails(fetchArgs);
check('一次完整補抓只用完賽清單與批次詳情兩次請求', firstFetch.fetched === 1 && firstFetch.requestsUsed === 2 && fakeCalls === 2);
check('成功場次第二次執行在網路請求前永久略過', secondFetch.fetched === 0 && secondFetch.cached === 1 && fakeCalls === 2);
await rm(tempRoot, { recursive: true, force: true });

/* 「這個方案拿不到此賽季」必須跟「暫時失敗」分得開。
   實測過:這把金鑰是 Free 方案,league=140 的 2025/2026 兩季都回
   {"errors":{"plan":"Free plans do not have access to this season…"}}。
   原本上層只看得到「取得失敗」,於是排程每天照跑、每天回報成功,
   讀者看到的卻是「尚待永久快取」—— 那句話會一直等下去。
   所以這裡釘死三件事:認得出來、寫得進存檔、拿得到之後會自己清掉。 */
const blockedRoot = await mkdtemp(join(tmpdir(), 'laliga-plan-blocked-'));
const planError = async () => ({ ok: true, status: 200, json: async () => ({ errors: { plan: 'Free plans do not have access to this season, try from 2022 to 2024.' } }) });
const blockedArgs = { ...fetchArgs, root: blockedRoot, fetchImpl: planError };
const blockedRun = await fetchCompletedMatchDetails(blockedArgs);
const storeFile = join(blockedRoot, 'data', 'raw', 'api-football-la-liga', '2026-27-match-details.json');
const storedBlocked = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')).blocked : null;
check('方案不含此賽季會被認出來,不會混成一般失敗', blockedRun.blocked?.reason === 'plan');
check('封鎖原因寫進存檔(不落盤的話 build 永遠看不到)', storedBlocked?.reason === 'plan' && /Free plans/.test(storedBlocked.message ?? ''));
check('封鎖時回報的訊息不是「還沒抓到」', /拿不到|不含/.test(blockedRun.error ?? ''));

// 已知被擋住就不要再打同一個註定失敗的請求 —— 那也是從每日額度扣一次
let repeatCalls = 0;
const repeat = await fetchCompletedMatchDetails({ ...blockedArgs, fetchImpl: async () => { repeatCalls++; return planError(); } });
check('同一天已知被擋住就不再連線,不白燒額度', repeat.skippedCall === true && repeatCalls === 0);

// 方案換掉之後要自己復原 —— 不能要求下一個人記得回來手動清一個旗標
let recoverCalls = 0;
const recovered = await fetchCompletedMatchDetails({ ...blockedArgs, force: true, fetchImpl: async () => {
  recoverCalls++;
  return { ok: true, status: 200, json: async () => ({ response: [fakeRaw] }) };
} });
const afterRecover = JSON.parse(readFileSync(storeFile, 'utf8'));
check('拿得到之後封鎖紀錄自動清掉', recovered.fetched === 1 && afterRecover.blocked === undefined && recoverCalls === 2);
await rm(blockedRoot, { recursive: true, force: true });

if (process.exitCode) throw new Error('西甲球隊數據第二版自我檢查失敗');
console.log('  西甲球隊數據第二版全部通過');
