#!/usr/bin/env node
// 只讀探測 SportMonks 的訂閱、賽季與逐場欄位；不寫入 canonical 或正式快取。
// 請求上限硬寫死，避免探測消耗過多額度。
const TOKEN = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_KEY || process.env.SPORTMONKS_API_KEY;
const BASE = 'https://api.sportmonks.com/v3';
const MAX_REQUESTS = 12;
const DELAY = 400;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const line = title => console.log(`\n${'─'.repeat(72)}\n▶ ${title}`);
const keysOf = value => (value && typeof value === 'object' ? Object.keys(value) : []);
const brief = (value, count = 6) => keysOf(value).slice(0, count).map(key => {
  const item = value[key];
  const summary = item === null ? 'null' : Array.isArray(item) ? `[${item.length}]` : typeof item === 'object' ? '{…}' : JSON.stringify(item);
  return `${key}=${String(summary).slice(0, 30)}`;
}).join('  ');
let used = 0;

async function get(path, label = '') {
  if (used >= MAX_REQUESTS) {
    console.log(`  （已達 ${MAX_REQUESTS} 個請求上限，略過 ${path}）`);
    return null;
  }
  if (used) await sleep(DELAY);
  used++;
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(TOKEN)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    const text = await response.text();
    console.log(`  [${used}/${MAX_REQUESTS}] ${BASE}${path}\n      → HTTP ${response.status}・${text.length} 位元組${label ? `（${label}）` : ''}`);
    let json;
    try { json = JSON.parse(text); } catch {
      console.log(`      ✗ 不是 JSON：${text.slice(0, 120)}`);
      return { status: response.status, json: null, error: 'not-json' };
    }
    if (json.message && !json.data) {
      console.log(`      ✗ ${response.status === 403 ? '被拒絕' : '訊息'}：${String(json.message).slice(0, 180)}`);
      return { status: response.status, json, error: json.message };
    }
    return { status: response.status, json, error: null };
  } catch (error) {
    console.log(`  [!] ${BASE}${path}\n      → ${error.message}`);
    return null;
  }
}

const rows = value => Array.isArray(value) ? value : [];
const typeName = row => row?.type?.name || row?.type?.code || String(row?.type_id ?? '');
const unique = values => [...new Set(values.filter(Boolean))];

function inspectFixture(fixture) {
  const lineups = rows(fixture?.lineups);
  const starters = lineups.filter(row => row.type_id === 11 || row.type?.code === 'STARTING_LINEUP');
  const stats = rows(fixture?.statistics);
  const lineupDetails = unique(lineups.flatMap(row => rows(row.details).map(typeName)));
  return {
    id: fixture?.id ?? null,
    name: fixture?.name ?? null,
    startingAt: fixture?.starting_at ?? null,
    state: fixture?.state?.name ?? fixture?.state_id ?? null,
    resultInfo: fixture?.result_info ?? null,
    lineups: lineups.length,
    teamsWithLineups: unique(lineups.map(row => row.team_id)).length,
    starters: starters.length,
    positions: lineups.filter(row => row.position_id != null).length,
    formationFields: lineups.filter(row => row.formation_field).length,
    lineupDetails: lineupDetails.slice(0, 20),
    formations: rows(fixture?.formations).length,
    events: rows(fixture?.events).length,
    statistics: stats.length,
    statisticTypes: unique(stats.map(typeName)).slice(0, 25),
    participantImages: rows(fixture?.participants).filter(row => row.image_path).length,
  };
}

async function main() {
  if (!TOKEN) {
    console.log('⚠ 沒有 SPORTMONKS_TOKEN / SPORTMONKS_KEY / SPORTMONKS_API_KEY，略過探測。');
    console.log('  GitHub: Settings → Secrets and variables → Actions → New repository secret');
    console.log('  本機：export SPORTMONKS_TOKEN=xxxx');
    return;
  }
  const verdict = [];

  line('1. 金鑰、方案與額度');
  for (const path of ['/my/usage', '/my/resources', '/my/enrichments']) {
    const result = await get(path);
    if (result?.json?.data) {
      const data = result.json.data;
      console.log(`      ✔ ${path} 可用，頂層鍵：${keysOf(Array.isArray(data) ? data[0] : data).join(', ')}`);
      console.log(Array.isArray(data) ? `        共 ${data.length} 筆，第一筆：${brief(data[0], 8)}` : `        ${brief(data, 8)}`);
      break;
    }
  }
  if (used) {
    const result = await get('/football/leagues?per_page=1', '順便看 rate_limit');
    if (result?.json?.rate_limit) console.log(`      額度：${JSON.stringify(result.json.rate_limit)}`);
    if (result?.json?.subscription) console.log(`      訂閱：${JSON.stringify(result.json.subscription).slice(0, 400)}`);
  }

  line('2. 訂閱涵蓋哪些聯賽');
  const leaguesResult = await get('/football/leagues?per_page=100');
  const leagues = leaguesResult?.json?.data ?? [];
  const findLeague = pattern => leagues.find(league => pattern.test(String(league.name ?? '')));
  const epl = findLeague(/premier\s*league/i);
  const laliga = findLeague(/la\s*liga|laliga|primera/i);
  if (leagues.length) {
    console.log(`      可存取 ${leagues.length} 個聯賽：`);
    for (const league of leagues) console.log(`        ${String(league.id).padStart(5)}  ${league.name}`);
    console.log(`\n      英超：${epl ? `id ${epl.id}（${epl.name}）✔` : '**不在訂閱裡**'}`);
    console.log(`      西甲：${laliga ? `id ${laliga.id}（${laliga.name}）✔` : '**不在訂閱裡**'}`);
    verdict.push(epl || laliga ? `聯賽：${[epl && '英超', laliga && '西甲'].filter(Boolean).join('與')}可存取` : '聯賽：英超與西甲都不在訂閱裡');
  }

  const target = laliga ?? epl;
  let currentSeason;
  let doneSeason;
  if (target) {
    line(`3. ${target.name} 的賽季涵蓋`);
    const seasonsResult = await get(`/football/seasons?filters=seasonLeagues:${target.id}&per_page=50`);
    const seasons = seasonsResult?.json?.data ?? [];
    const sorted = seasons.slice().sort((a, b) => String(b.name ?? '').localeCompare(String(a.name ?? '')));
    if (sorted.length) {
      for (const season of sorted.slice(0, 5)) console.log(`        ${String(season.id).padStart(6)}  ${season.name}${season.is_current ? '  ← 本季' : ''}${season.finished === false ? '  (進行中)' : ''}`);
      currentSeason = sorted.find(season => season.is_current) ?? sorted[0];
      doneSeason = sorted.find(season => season.id !== currentSeason?.id && season.finished !== false);
      console.log(`      → 本季 season id：${currentSeason?.id ?? '找不到'}；已完結取樣季：${doneSeason?.id ?? '無'}`);
      verdict.push(currentSeason?.is_current ? `賽季：本季 ${currentSeason.name} 拿得到` : `賽季：最新 ${currentSeason?.name ?? '?'}，未確認本季`);
    }
  }

  if (currentSeason) {
    line('4. 已完賽單場深度（lineups / formations / events / statistics）');
    const sourceSeason = doneSeason?.id ?? currentSeason.id;
    const fixturesResult = await get(`/football/fixtures?filters=fixtureSeasons:${sourceSeason}&per_page=1`, doneSeason ? '已完結取樣季' : '本季，可能尚未完賽');
    const fixture = fixturesResult?.json?.data?.[0];
    if (fixture) {
      console.log(`      取樣場次 id ${fixture.id}：${brief(fixture, 8)}`);
      const include = 'lineups;lineups.player;formations;events;statistics;participants';
      const detailResult = await get(`/football/fixtures/${fixture.id}?include=${include}`);
      const detail = detailResult?.json?.data;
      if (detail) {
        const report = inspectFixture(detail);
        console.log(`      ✔ ${JSON.stringify(report)}`);
        const deep = report.lineups > 0 && report.formations > 0;
        verdict.push(deep ? '單場深度：lineups 與 formations 都拿得到' : '單場深度：需檢查取樣場次是否已完賽或方案權限');
      }
    }
  }

  if (target && currentSeason) {
    line('5. Understat 沒有的球員欄位與傷停候選');
    const teamsResult = await get(`/football/teams/seasons/${currentSeason.id}?per_page=1`, '球隊');
    const team = teamsResult?.json?.data?.[0];
    if (team) {
      const squadResult = await get(`/football/squads/teams/${team.id}?include=player`);
      const row = squadResult?.json?.data?.[0];
      if (row) {
        const has = key => key in row || (row.player && key in row.player);
        console.log(`      ✔ 名單欄位：${keysOf(row).join(', ')}`);
        console.log(`        背號 jersey_number：${has('jersey_number') ? '✔' : '✗'}；頭貼 image_path：${has('image_path') ? '✔' : '✗'}`);
        verdict.push(`球員欄位：背號 ${has('jersey_number') ? '✔' : '✗'}、頭貼 ${has('image_path') ? '✔' : '✗'}`);
      }
      let injury = false;
      for (const path of ['/football/sidelined?per_page=1', `/football/sidelined/teams/${team.id}`, `/football/squads/teams/${team.id}?include=player.sidelined`]) {
        const result = await get(path, '傷停候選');
        if (result?.json?.data) { console.log(`      ✔ 傷停候選有資料：${path.split('?')[0]}`); injury = true; break; }
      }
      if (!injury) console.log('      ✗ 傷停候選都沒有資料；不把 404 當成方案拒絕，待查正確端點');
      verdict.push(injury ? '傷停：候選端點有資料' : '傷停：尚未找到可用端點');
    }
  }

  console.log(`\n${'─'.repeat(72)}\n共用掉 ${used} 個請求（上限 ${MAX_REQUESTS}）。`);
  console.log('\n判讀（依這次實測產生）：');
  if (!verdict.length) console.log('  （沒有跑到結論，請看上面哪一步斷掉）');
  for (const item of verdict) console.log(`  · ${item}`);
}

main().catch(error => { console.error(`✗ SportMonks 探測失敗：${error.message}`); process.exitCode = 1; });
