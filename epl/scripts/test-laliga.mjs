#!/usr/bin/env node
// 西甲資料邊界測試：守住兩季、20 隊、真實球隊風格與「不假裝已有球員資料」。
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fetchCompletedMatchDetails, normaliseMatchDetail } from './lib/adapters/api-football.mjs';
import { normalisePlayerForSite } from './lib/adapters/understat-players.mjs';
import { coachesFromSquadStore, enrichPlayers, loadSquadStore, coverage as sportmonksCoverage, normaliseSportmonksMatch } from './lib/adapters/sportmonks.mjs';
import { parseClubSlugs, parseOfficialCoach, parseOfficialCoachPayload } from './fetch-laliga-official-coaches.mjs';
import { officialCoachesFromStore } from './lib/adapters/laliga-official.mjs';
import { verifyTranslation } from './lib/report/translate.mjs';
import { buildLiveProviderReport, buildProviderMatchReport } from './lib/postmatch-report.mjs';
import { backfillScores } from './lib/laliga-matches.mjs';

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
const meta = out('meta'), fixtures = out('fixtures'), teams = out('teams'), official = out('official'), shapes = out('shapes');
const players = out('players');

check('只納入指定兩季', meta.lastSeason === '2025-26' && meta.currentSeason === '2026-27');
check('2025-26 原始賽程 380 場', last.matches.length === 380, String(last.matches.length));
check('2026-27 原始賽程 380 場', current.matches.length === 380, String(current.matches.length));
check('本季輸出 20 隊', teams.length === 20, String(teams.length));
check('本季 20 隊都有內嵌 PNG 隊徽', teams.every(t => t.crest?.startsWith('data:image/png;base64,')), String(teams.filter(t => t.crest).length));
check('球隊頁顯示已核對的 SportMonks 名單人數', teams.filter(t => t.squadSize > 0).length === 20
  && teams.find(t => t.code === 'VIL')?.squadSize > 0);
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
check('正式陣型摘要只來自已核對場次', Object.values(shapes).some(s => s.official?.games > 0)
  && Object.values(shapes).every(s => !s.official || (s.official.formation && s.official.games > 0)));
/* 球員表的比賽統計來自 Understat，SportMonks 只補經核對的身分欄位。
   這裡守的是**開了之後不能偷偷造欄位**：沒有來源的進階欄位不准出現。 */
const leaders = out('leaders');
const FORBIDDEN = ['price', 'status', 'news', 'defCon90', 'saves90', 'tackles90'];
check('西甲球員資料已接上', meta.capabilities?.players === true && players.length > 0);
check('西甲年齡以資料基準日輸出', players.some(p => p.dateOfBirth && Number.isInteger(p.age) && p.age >= 0));
check('西甲球員提供英超模板共用欄位', meta.schema?.version === 2
  && players.every(p => p.code && p.fullName && p.team && Array.isArray(p.teamCodes) && p.stats?.season));
check('西甲球員共用欄位仍保留來源粒度', players.every(p => p.stats?.minutes === p.minutes
  && p.stats?.goals === p.goals && p.stats?.xGI === p.xGI));
check('球員正規化不把未提供欄位塞進契約', (() => {
  const sample = normalisePlayerForSite({ id: '1', name: 'Test', teams: ['Barcelona'], minutes: 90, goals: 1, xGI: 1.2 }, { codeOf: x => x === 'Barcelona' ? 'BAR' : x });
  return sample.code === '1' && sample.team === 'BAR' && !('price' in sample) && !('defCon90' in sample);
})());
check('戰術主要陣型提供共同 label', meta.schema?.tactics?.common?.includes('formation.label')
  && teams.some(t => t.tactics?.formation?.label === t.tactics?.formation?.primary));
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
const smCoachRows = coachesFromSquadStore({ providerSeason: 27965, teams: {
  BAR: { coaches: [{ id: 77, name: 'Test Coach', active: true, from: '2026-07-01' }] },
} });
check('SportMonks 教練身分轉成西甲球隊契約', smCoachRows.length === 1
  && smCoachRows[0].team === 'BAR' && smCoachRows[0].name === 'Test Coach'
  && smCoachRows[0].source === 'SportMonks' && smCoachRows[0].formation === null);
const smHydratedCoach = coachesFromSquadStore({ providerSeason: 27965, teams: {
  BAR: { coaches: [{ id: 77, name: null, active: true, to: '2029-06-30' }] },
} }, { details: { '77': { id: 77, name: 'Hydrated Coach', imagePath: 'https://cdn.example/coach.png' } } });
check('SportMonks coach ID 可由詳情快取補姓名', smHydratedCoach.length === 1
  && smHydratedCoach[0].name === 'Hydrated Coach' && smHydratedCoach[0].imagePath.includes('coach.png'));
check('SportMonks 教練沿用球隊名單請求,不增加 API 請求',
  /teams\/seasons\/\$\{season\.id\}\?include=coaches/.test(readFileSync(join(ROOT, 'scripts', 'fetch-sportmonks.mjs'), 'utf8')));
check('教練詳情只透過 coach ID 去重請求',
  /football\/coaches\/\$\{encodeURIComponent\(id\)\}/.test(readFileSync(join(ROOT, 'scripts', 'fetch-sportmonks.mjs'), 'utf8')));
check('SportMonks fixtures 接受純陣列與 data 包裝回應',
  /const batch = relatedRows\(await get\(`\/football\/fixtures/.test(readFileSync(join(ROOT, 'scripts', 'fetch-sportmonks.mjs'), 'utf8')));
const sportmonksSyncSource = readFileSync(join(ROOT, 'scripts', 'fetch-sportmonks.mjs'), 'utf8');
check('SportMonks Token 走 Authorization Header,不落在 URL',
  /Authorization: TOKEN/.test(sportmonksSyncSource) && !/api_token=\$\{encodeURIComponent\(TOKEN\)\}/.test(sportmonksSyncSource));
check('SportMonks 分頁遵守 per_page 最大 50',
  /fixtures\?filters=fixtureSeasons:\$\{season\.id\}&include=participants&per_page=50/.test(sportmonksSyncSource)
  && /teams\/seasons\/\$\{season\.id\}\?include=coaches&per_page=50/.test(sportmonksSyncSource));
const sportmonksLiveSource = readFileSync(join(ROOT, 'scripts', 'fetch-laliga-live.mjs'), 'utf8');
check('SportMonks 西甲即時端點走 livescores/inplay 且使用 Header Token',
  /football\/livescores\/inplay/.test(sportmonksLiveSource)
  && /Authorization: TOKEN/.test(sportmonksLiveSource)
  && !/api_token=\$\{/.test(sportmonksLiveSource));
check('西甲即時輪詢有 include fallback 與硬上限',
  /participants;state;scores;events/.test(sportmonksLiveSource)
  && /participants;state;scores/.test(sportmonksLiveSource)
  && /MAX_REQUESTS/.test(sportmonksLiveSource));
/* 2026-08-29 實測 LEV|BET 踩到的兩個坑:分數列的正則連 1ST_HALF/2ND_HALF
   分段列一起收(分段不是累計,存成 1:2 而事件已 3:2);事件不按時間排,
   .at(-1) 撿到 17' 的越位當成現在分鐘。 */
check('西甲即時:比分只認 CURRENT 列、分鐘取全部訊號的最大值(不撿最後一筆事件)',
  /\\bCURRENT\\b/.test(sportmonksLiveSource)
  && /Math\.max\(0, \.\.\.eventRows\.map\(evMin\)/.test(sportmonksLiveSource)
  && /Math\.max\(eventMinute, stateFloor/.test(sportmonksLiveSource)
  && !/filter\(Number\.isFinite\)\.at\(-1\)/.test(sportmonksLiveSource));
const officialSample = `<a href="/en-US/clubs/fc-barcelona/squad">Barcelona</a><a href="/en-US/clubs/fc-barcelona/squad">duplicate</a>
  <script type="application/ld+json">${JSON.stringify({
    name: 'FC Barcelona', coach: [
      { '@type': 'Person', name: 'Hansi Flick', jobTitle: 'Coach', image: 'null' },
      { '@type': 'Person', name: 'Marcus Sorg', jobTitle: 'Assistant coach' },
    ],
  })}</script>`;
const parsedOfficial = parseOfficialCoach(officialSample);
check('LaLiga 官方頁只取主教練,不把助理教練當主教練', parsedOfficial?.name === 'Hansi Flick'
  && parsedOfficial.teamName === 'FC Barcelona' && parsedOfficial.imagePath === null);
check('LaLiga 官方 API 只取 current Coach 並保留教練頭像', parseOfficialCoachPayload({ squads: [
  { current: true, role: { name: 'Coach' }, person: { name: 'Hansi Flick', slug: 'hans-dieter-flick' },
    team: { nickname: 'FC Barcelona' }, photos: { '002': { '64x64': 'https://assets.example/coach.jpg' } } },
  { current: true, role: { name: 'Assistant coach' }, person: { name: 'Marcus Sorg' } },
] })?.imagePath.endsWith('coach.jpg'));
check('官方球隊目錄連結去重', parseClubSlugs(officialSample).join('|') === 'fc-barcelona');
const officialRows = officialCoachesFromStore({ season: '2026-27', coaches: [{ team: 'BAR', name: 'Hansi Flick' }, { team: 'ATH', name: 'Ernesto Valverde' }] });
check('官方教練快取轉成可合併資料列', officialRows.length === 2 && officialRows[0].team === 'BAR');
const smCurrentStore = loadSquadStore(ROOT, '2026-27');
check('SportMonks 錯隊名不會把 Deportivo 掛到 Villarreal',
  !smCurrentStore?.teams?.VIL?.name?.toLowerCase().includes('deportivo')
  && (!smCurrentStore?.teams?.DEP || /deportivo/i.test(smCurrentStore.teams.DEP.name ?? '')));
const verifiedScorers = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', 'laliga-goal-overrides.json'), 'utf8'));
check('人工核對射手只收錄能對回最終比分且有來源網址的場次', verifiedScorers.season === '2026-27'
  && Object.values(verifiedScorers.matches ?? {}).every(match => /^https:\/\//.test(match.sourceUrl ?? '')
    && Array.isArray(match.goals) && match.goals.length > 0));
const smXI = (teamId, prefix) => Array.from({ length: 11 }, (_, i) => ({
  player_id: teamId * 100 + i, team_id: teamId, player_name: `${prefix} ${i + 1}`,
  jersey_number: i + 1, position_id: i === 0 ? 24 : i < 5 ? 25 : i < 8 ? 26 : 27,
  type_id: 11, formation_field: `${i < 1 ? 1 : i < 5 ? 2 : i < 8 ? 3 : 4}:${(i % 4) + 1}`,
  details: [
    { type: { code: 'rating' }, data: { value: 7.2 } }, { type: { code: 'minutes-played' }, data: { value: 90 } },
    ...(i === 1 && teamId === 1 ? [{ type: { code: 'goals' }, data: { value: 1 } }, { type: { code: 'goals-conceded' }, data: { value: 3 } }] : []),
  ],
}));
const smDetail = normaliseSportmonksMatch({
  id: 123, starting_at: '2026-08-20 19:00:00', participants: [
    { id: 1, name: 'Barcelona', meta: { location: 'home' } }, { id: 2, name: 'Athletic Club', meta: { location: 'away' } },
  ], formations: [{ participant_id: 1, formation: '4-3-3' }, { participant_id: 2, formation: '4-2-3-1' }],
  lineups: [...smXI(1, 'BAR'), ...smXI(2, 'ATH')],
  statistics: [{ participant_id: 1, type: { code: 'shots-total' }, data: { value: 12 }, location: 'home' },
    { participant_id: 2, type: { code: 'shots-total' }, data: { value: 8 }, location: 'away' }],
  events: [{ participant_id: 1, type: { code: 'goal' }, minute: 22, player_name: 'BAR 2', player_id: 101 }],
}, { codeOf: name => ({ Barcelona: 'BAR', 'Athletic Club': 'ATH' }[name] ?? null),
  fixture: { home: 'BAR', away: 'ATH', season: '2026-27', played: true, fh: 1, fa: 0 },
  teamCodeById: new Map([['1', 'BAR'], ['2', 'ATH']]), season: '2026-27' });
check('SportMonks 賽後資料轉成本站格式', smDetail?.coverage?.lineups === true
  && smDetail.lineups.BAR.xi.length === 11 && smDetail.lineups.ATH.formation === '4-2-3-1'
  && smDetail.coverage.ratings === true && smDetail.events[0].type === 'Goal');
check('SportMonks 位置 ID 與球員進失球統計精確對應', smDetail.lineups.BAR.xi.slice(0, 6).map(p => p.pos).join('|') === 'GK|DEF|DEF|DEF|DEF|MID'
  && smDetail.players.BAR[1].goals.total === 1 && smDetail.players.BAR[1].goals.conceded === 3);
const staleSportmonksDetail = {
  ...smDetail,
  players: Object.fromEntries(Object.entries(smDetail.players).map(([code, list]) => [code, list.map(p => ({
    ...p, pos: 'GK', goals: { ...p.goals, total: code === 'BAR' ? 3 : 0 },
  }))])),
};
const stalePositionMap = new Map(Object.values(smDetail.lineups).flatMap(lineup => lineup.xi.map(p => [String(p.providerId), p.pos])));
const repairedSportmonksReport = buildProviderMatchReport({
  fixture: { home: 'BAR', away: 'ATH', season: '2026-27', played: true, fh: 1, fa: 0 },
  detail: staleSportmonksDetail, positionByProviderId: stalePositionMap,
});
check('完整事件會修復舊快取的錯誤射手與位置', repairedSportmonksReport?.sides.BAR.goals === 1
  && repairedSportmonksReport.sides.BAR.scorers[0]?.name === 'BAR 2'
  && repairedSportmonksReport.sides.BAR.xi.slice(0, 6).map(p => p.pos).join('|') === 'GK|DEF|DEF|DEF|DEF|MID');
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
check('進球方式摘要與五類明細總數一致', teams.filter(t => t.tactics?.setPieces?.goalsReliable).every(t => {
  const sp = t.tactics.setPieces, b = sp.breakdown ?? {};
  const keys = ['openPlay', 'corner', 'otherSetPiece', 'directFreeKick', 'penalty'];
  const total = keys.reduce((n, k) => n + Number(b[k]?.goals ?? 0), 0);
  const nonPenalty = ['corner', 'otherSetPiece', 'directFreeKick'].reduce((n, k) => n + Number(b[k]?.goals ?? 0), 0);
  const againstTotal = keys.reduce((n, k) => n + Number(b[k]?.against?.goals ?? 0), 0);
  const nonPenaltyAgainst = ['corner', 'otherSetPiece', 'directFreeKick'].reduce((n, k) => n + Number(b[k]?.against?.goals ?? 0), 0);
  return total === t.tactics.attack.goals && nonPenalty === sp.goals
    && againstTotal === t.tactics.defence.conceded && nonPenaltyAgainst === sp.conceded;
}));
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
const liveReport = buildLiveProviderReport({
  fixture: { ...fakeFixture, played: false, finished: false, fh: 1, fa: 0 },
  detail: { ...fakeDetail, score: { home: 1, away: 0 }, source: 'sportmonks' },
  prediction: { home: 0.5, draw: 0.25, away: 0.25, xgHome: 1.4, xgAway: 0.8 },
  minute: 63, nameOf: code => teams.find(t => t.code === code)?.en ?? code,
});
check('西甲即時報告沿用 canonical 欄位且保留場中機率', liveReport?.finished === false
  && liveReport.minute === 63 && liveReport.inplay?.home + liveReport.inplay?.draw + liveReport.inplay?.away > 0.99
  && liveReport.advanced.source === 'sportmonks');

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

/* 備援的方案限制不可以升格成「這一季拿不到」。

   踩過:SportMonks 接成主要來源之後,只要還有場次沒發布,build 就照樣把
   API-Football 的 blocked 傳到前端。2026-08-28 的實際狀態是已發布 16/20,
   剛完賽的 4 場(含 RMA vs RSO)頁面卻寫著
   「本站使用的資料源方案不含本賽季…在換成涵蓋本賽季的方案之前都不會出現」——
   而隔壁 16 場的球隊統計、正式陣容、事件與評分全都在。
   「還沒抓到」與「拿不到」對讀者的意義相反,這一條就是守住那條界線。 */
const reportsOut = out('reports');
check('主要來源已發布場次時,缺口不可以被講成「整季拿不到」',
  reportsOut.count === 0 || reportsOut.blocked == null,
  `count=${reportsOut.count} blocked=${reportsOut.blocked ? reportsOut.blocked.reason : 'null'}`);
check('備援補不了缺口仍要照實說,但走的是 backupBlocked',
  reportsOut.pending === 0 || reportsOut.count === 0 || reportsOut.backupBlocked === undefined
  || reportsOut.backupBlocked === null || reportsOut.backupBlocked?.reason === 'plan');
check('有缺口且主要來源可用時,說明講的是「還沒抓到」',
  !(reportsOut.pending > 0 && reportsOut.count > 0) || /還沒|尚未/.test(reportsOut.note ?? ''));
check('blocked 與 backupBlocked 最多只有一個非 null',
  !(reportsOut.blocked && reportsOut.backupBlocked));


/* 外電翻譯的驗證器。這是整個翻譯層唯一的安全機制 —— 模型改了數字、
   加了原文沒有的東西,只有它擋得住。所以要有測試守著。
   守的是「會不會放行不該放行的」,不是「翻得好不好」。 */
console.log('\n▶ 外電翻譯驗證器');
const trSrc = { title: 'Mbappe hat-trick sinks Sociedad 4-1', body: 'Madrid won 4-1 on Wednesday in the 40th minute.' };
check('正常翻譯放行',
  verifyTranslation(trSrc, { title: 'Mbappe 帽子戲法 4-1 擊沉 Sociedad', body: 'Madrid 週三以 4-1 獲勝,第 40 分鐘。' }).ok === true);
check('標題把比分改掉 → 擋下',
  verifyTranslation(trSrc, { title: 'Mbappe 帽子戲法 3-1 擊沉 Sociedad' }).ok === false);
check('標題把數字整個吃掉 → 擋下',
  verifyTranslation(trSrc, { title: 'Mbappe 帽子戲法擊沉 Sociedad' }).ok === false);
check('空標題 → 擋下', verifyTranslation(trSrc, { title: '' }).ok === false);
check('標題暴長(多半是加了原文沒有的東西)→ 擋下',
  verifyTranslation(trSrc, { title: 'Mbappe 帽子戲法 4-1 擊沉 Sociedad,'.repeat(4) }).ok === false);
check('摘要漏掉大部分數字 → 擋下',
  verifyTranslation(trSrc, { title: 'Mbappe 帽子戲法 4-1 擊沉 Sociedad', body: 'Madrid 週三獲勝。' }).ok === false);

/* ── 比分備援來源 ──────────────────────────
   openfootball 的西甲 2024-25 少了最後一輪 10 場,football-data.co.uk 有。
   補進來是對的,但**只有在兩邊重疊的場次逐場一致時才准補** ——
   兩個來源對不上卻挑著用,等於自己選一個喜歡的答案(鐵則五)。
   這一節守的就是那道門:對不上一場就整份不採用。 */
{
  const csv = ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,PSCH,PSCD,PSCA',
    'SP1,24/05/25,Real Madrid,Real Sociedad,2,0,1.5,4,7',
    'SP1,25/05/25,Athletic Club,Barcelona,0,3,3,3.5,2.2',
    'SP1,23/05/25,Real Betis,Valencia,1,1,2,3.3,3.6'].join('\n');
  const codeOf = n => ({ 'Real Madrid': 'RMA', 'Real Sociedad': 'RSO', 'Athletic Club': 'ATH',
    Barcelona: 'BAR', 'Real Betis': 'BET', Valencia: 'VAL' }[n] ?? null);

  const mk = () => ([
    { home: 'RMA', away: 'RSO', played: false, fh: null, fa: null },
    { home: 'ATH', away: 'BAR', played: false, fh: null, fa: null },
    { home: 'BET', away: 'VAL', played: true, fh: 1, fa: 1 },
  ]);

  const ok = mk();
  const r1 = backfillScores(ok, csv, codeOf);
  check('重疊場次一致 → 補上缺的比分', r1.filled === 2 && r1.checked === 1 && r1.mismatches.length === 0);
  check('補進來的標得出來源', ok[0].scoreSource === 'football-data.co.uk' && ok[0].fh === 2 && ok[0].fa === 0);
  check('本來就有比分的不動', ok[2].scoreSource === undefined && ok[2].fh === 1);

  const bad = mk();
  bad[2].fh = 3;   // 我們說 3-1、備援說 1-1
  const r2 = backfillScores(bad, csv, codeOf);
  check('重疊場次對不上 → 整份不採用,一場都不補',
    r2.filled === 0 && r2.mismatches.length === 1 && bad[0].played === false);
  check('對不上時報得出是哪一場、兩邊各是多少',
    r2.mismatches[0].key === 'BET|VAL' && r2.mismatches[0].ours[0] === 3 && r2.mismatches[0].theirs[0] === 1);

  // 產物:2024-25 的訓練場次應該是 380(補完之後),而且畫面要講出補了幾場
  const bt = (() => {
    try { return JSON.parse(readFileSync(join(ROOT, 'data', 'backtest-laliga.json'), 'utf8')); }
    catch { return null; }
  })();
  if (bt?.coverage) {
    const cov = bt.coverage['2024-25'];
    check('產物:2024-25 補完之後是 380 場', !cov || cov.played === 380, JSON.stringify(cov));
  }
  check('產物:模型頁的說明有講出比分來源不同',
    meta.model.caveats.some(c => c.includes('football-data.co.uk')),
    meta.model.caveats.join(' | '));
}

if (process.exitCode) throw new Error('西甲球隊數據第二版自我檢查失敗');
console.log('  西甲球隊數據第二版全部通過');
