#!/usr/bin/env node
// SportMonks 可行性探測：只讀、最多 3 次請求、不寫任何資料檔。
// 使用 GitHub Actions 的 SPORTMONKS_TOKEN 執行，絕不把 token 印到 log。
const TOKEN = process.env.SPORTMONKS_TOKEN;
const BASE = 'https://api.sportmonks.com/v3/football';
const DATE = '2026-08-24';
const MAX_REQUESTS = 3;
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';
const INCLUDE = [
  'participants', 'scores', 'league', 'season', 'state',
  'lineups.details.type', 'events.type', 'statistics.type',
  'xGFixture', 'formations', 'ballCoordinates',
].join(';');

let used = 0;
const line = title => console.log(`\n${'─'.repeat(72)}\n▶ ${title}`);

async function get(path, params = {}) {
  if (used >= MAX_REQUESTS) return null;
  used++;
  const query = new URLSearchParams({ api_token: TOKEN, ...params });
  const safePath = `${path}?${new URLSearchParams({ ...params }).toString()}`;
  try {
    const response = await fetch(`${BASE}${path}?${query}`, {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* 只顯示狀態,不印回應內容 */ }
    console.log(`  [${used}/${MAX_REQUESTS}] ${safePath} → HTTP ${response.status}・${body.length} 位元組`);
    if (!response.ok || json?.errors) {
      const errors = json?.errors ? Object.keys(json.errors).join(', ') : 'HTTP 錯誤';
      console.log(`      ✗ ${errors}`);
      return null;
    }
    return json;
  } catch (error) {
    console.log(`  [${used}/${MAX_REQUESTS}] ${safePath} → ${error.message}`);
    return null;
  }
}

const rows = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(Boolean))];
const typeName = row => row?.type?.name || row?.type?.code || String(row?.type_id ?? '');

function inspectFixture(fixture) {
  const lineups = rows(fixture?.lineups);
  const starters = lineups.filter(x => x.type_id === 11 || x.type?.code === 'STARTING_LINEUP');
  const teams = unique(lineups.map(x => x.team_id).map(String));
  const stats = rows(fixture?.statistics);
  const expected = rows(fixture?.expected);
  const coordinates = rows(fixture?.ball_coordinates ?? fixture?.ballCoordinates);
  const statNames = unique(stats.map(typeName));
  const lineupDetails = unique(lineups.flatMap(x => rows(x.details).map(typeName)));
  return {
    id: fixture?.id ?? null,
    name: fixture?.name ?? null,
    startingAt: fixture?.starting_at ?? null,
    league: fixture?.league?.name ?? null,
    season: fixture?.season?.name ?? null,
    state: fixture?.state?.name ?? null,
    scores: rows(fixture?.scores).length,
    lineups: lineups.length,
    teamsWithLineups: teams.length,
    starters: starters.length,
    positions: lineups.filter(x => x.position_id != null).length,
    formationFields: lineups.filter(x => x.formation_field).length,
    lineupDetails: lineupDetails.slice(0, 20),
    events: rows(fixture?.events).length,
    statistics: stats.length,
    statisticTypes: statNames.slice(0, 25),
    expected: expected.length,
    ballCoordinates: coordinates.length,
    participantImages: rows(fixture?.participants).filter(x => x.image_path).length,
  };
}

async function main() {
  if (!TOKEN) {
    console.log('– 未設定 SPORTMONKS_TOKEN，略過探測（不會讓 workflow 失敗）。');
    return;
  }
  line(`1. SportMonks 西甲日期賽程（${DATE}）`);
  const dateResponse = await get(`/fixtures/date/${DATE}`, { include: INCLUDE });
  const fixtures = rows(dateResponse?.data);
  console.log(`  找到 ${fixtures.length} 場`);
  const target = fixtures.find(x => /malaga|málaga|deportivo/i.test(x?.name ?? '')) ?? fixtures[0];
  if (!target?.id) {
    console.log('  ⚠ 沒有找到可供詳查的比賽；可能是方案沒有涵蓋 2026-27 或日期資料尚未同步。');
  } else {
    console.log(`  ✔ ${JSON.stringify(inspectFixture(target))}`);
  }

  if (target?.id && used < MAX_REQUESTS) {
    line(`2. SportMonks 比賽詳情（fixture ${target.id}）`);
    const detail = await get(`/fixtures/${target.id}`, { include: INCLUDE });
    const fixture = detail?.data;
    if (fixture) {
      const report = inspectFixture(fixture);
      console.log(`  ✔ ${JSON.stringify(report)}`);
      const capabilities = {
        score: report.scores > 0,
        lineups: report.lineups >= 22 && report.teamsWithLineups >= 2,
        formations: report.formationFields > 0,
        positions: report.positions > 0,
        ratings: report.lineupDetails.some(x => /rating/i.test(x)),
        events: report.events > 0,
        teamStatistics: report.statistics > 0,
        xG: report.expected > 0 || report.statisticTypes.some(x => /expected|xg/i.test(x)),
        ballCoordinates: report.ballCoordinates > 0,
        participantImages: report.participantImages > 0,
      };
      console.log(`  能力摘要：${JSON.stringify(capabilities)}`);
    }
  }

  if (used < MAX_REQUESTS) {
    line('3. SportMonks LaLiga 聯賽索引');
    const leagues = await get('/leagues', { include: 'country;currentSeason', per_page: '100' });
    const hits = rows(leagues?.data).filter(x => /la liga|primera división|primera division/i.test(`${x?.name ?? ''} ${x?.short_code ?? ''}`));
    console.log(`  找到 ${hits.length} 筆可能的西甲聯賽：${JSON.stringify(hits.map(x => ({ id: x.id, name: x.name, country: x.country?.name, season: x.currentSeason?.name })))}`);
  }
  console.log(`\n結論：以上只探測回應結構，沒有寫入 canonical 或正式快取。共用掉 ${used}/${MAX_REQUESTS} 個請求。`);
}

main().catch(error => { console.error(`✗ SportMonks 探測失敗：${error.message}`); process.exitCode = 1; });
