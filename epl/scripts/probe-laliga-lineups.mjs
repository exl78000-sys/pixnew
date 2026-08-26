#!/usr/bin/env node
// 探測西甲完賽場次是否有可核對的正式先發、陣型與球員評分。
//
//   npm run probe:laliga-lineups
//
// 這支只做可行性確認,不寫資料檔,最多三個請求:
//   1. 找到 FotMob 的 LaLiga 聯賽 ID。
//   2. 讀取 2025/2026 賽季清單,挑一場已完賽場次。
//   3. 讀取該場詳情,檢查正式陣型、先發位置與評分。
//
// FotMob 的 /api/data/* 是網站使用的公開資料端點,不是專案自己的 API。
// 先把回傳結構核對清楚,再決定是否做小批量快取;不要在探測階段逐場抓完整賽季。
const BASE = 'https://www.fotmob.com';
const SEASON = '2025/2026';
const DELAY = 1200;
const MAX_REQUESTS = 3;
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const line = title => console.log(`\n${'─'.repeat(72)}\n▶ ${title}`);
let used = 0;

async function get(path) {
  if (used >= MAX_REQUESTS) {
    console.log(`  (已達 ${MAX_REQUESTS} 個請求上限,略過)`);
    return null;
  }
  if (used) await sleep(DELAY);
  used++;
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        accept: 'application/json',
        referer: `${BASE}/`,
        'user-agent': UA,
      },
    });
    const text = await res.text();
    console.log(`  [${used}/${MAX_REQUESTS}] ${path}\n      → HTTP ${res.status}・${text.length} 位元組`);
    if (!res.ok) return null;
    try { return JSON.parse(text); } catch (err) {
      console.log(`      ✗ JSON 解析失敗:${err.message}`);
      return null;
    }
  } catch (err) {
    console.log(`  [!] ${path}\n      → ${err.message}`);
    return null;
  }
}

function findLaLigaId(directory) {
  const all = [
    ...(directory?.popular ?? []),
    ...(directory?.international ?? []),
    ...(directory?.countries ?? []).flatMap(country => country.leagues ?? []),
  ];
  const hit = all.find(league => /la\s*liga/i.test(league?.name ?? ''));
  return hit?.id ?? null;
}

function firstFinished(fixtures) {
  return (fixtures?.allMatches ?? []).find(match =>
    match?.id && match?.status?.finished && !match?.status?.cancelled);
}

function inspectTeam(team) {
  const starters = Array.isArray(team?.starters) ? team.starters : [];
  const withPosition = starters.filter(player => Number.isFinite(player?.positionId));
  const withLayout = starters.filter(player => player?.horizontalLayout || player?.verticalLayout);
  const withRating = starters.filter(player => Number.isFinite(player?.performance?.rating));
  return {
    name: team?.name ?? '—',
    formation: team?.formation ?? null,
    rating: Number.isFinite(team?.rating) ? team.rating : null,
    starters: starters.length,
    substitutes: Array.isArray(team?.substitutes) ? team.substitutes.length : 0,
    startersWithPosition: withPosition.length,
    startersWithLayout: withLayout.length,
    startersWithRating: withRating.length,
    sample: starters.slice(0, 3).map(player => ({
      name: player.name,
      positionId: player.positionId,
      rating: player.performance?.rating ?? null,
      x: player.horizontalLayout?.x ?? null,
      y: player.horizontalLayout?.y ?? null,
    })),
  };
}

async function main() {
  line('1. FotMob 聯賽索引 —— 找 LaLiga ID');
  const directory = await get('/api/data/allLeagues');
  const leagueId = findLaLigaId(directory);
  if (!leagueId) {
    console.log('  ✗ 找不到 LaLiga。請記錄 HTTP 狀態後再檢查端點是否改版。');
    return;
  }
  console.log(`  ✔ LaLiga leagueId=${leagueId}`);

  line(`2. FotMob 聯賽資料 —— 找 ${SEASON} 的已完賽場次`);
  const season = encodeURIComponent(SEASON);
  const league = await get(`/api/data/leagues?id=${leagueId}&ccode3=ESP&season=${season}`);
  const match = firstFinished(league?.fixtures);
  if (!match) {
    console.log('  ✗ 找不到已完賽場次,不繼續發第三個請求。');
    return;
  }
  console.log(`  ✔ ${match.home?.name ?? '主隊'} ${match.status?.scoreStr ?? ''} ${match.away?.name ?? '客隊'}`);
  console.log(`    matchId=${match.id}・UTC=${match.status?.utcTime ?? '—'}`);

  line('3. FotMob 比賽詳情 —— 核對正式先發、陣型、位置與評分');
  const detail = await get(`/api/data/matchDetails?matchId=${encodeURIComponent(match.id)}`);
  const lineup = detail?.content?.lineup;
  if (!lineup) {
    console.log('  ✗ 回應沒有 content.lineup,不把這個來源接入正式資料。');
    return;
  }
  const home = inspectTeam(lineup.homeTeam);
  const away = inspectTeam(lineup.awayTeam);
  console.log(`  ✔ lineupType=${lineup.lineupType ?? '—'}・source=${lineup.source ?? '—'}`);
  for (const team of [home, away]) {
    console.log(`  · ${team.name}: formation=${team.formation ?? '—'}・先發 ${team.starters} 人` +
      `・替補 ${team.substitutes} 人・位置 ${team.startersWithPosition}/${team.starters}` +
      `・座標 ${team.startersWithLayout}/${team.starters}・評分 ${team.startersWithRating}/${team.starters}`);
    console.log(`    範例:${JSON.stringify(team.sample)}`);
  }
  const complete = [home, away].every(team =>
    team.starters === 11 && team.formation && team.startersWithPosition >= 11 &&
    team.startersWithLayout >= 11 && team.startersWithRating > 0);
  console.log(`\n  結論:${complete
    ? '✔ 來源可進入下一步小批量快取;資料可標示為 FotMob/enetpulse 完賽正式名單。'
    : '⚠ 結構不完整;先保留探測結果,不要把缺欄位當成官方資料。'}`);
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; })
  .finally(() => console.log(`\n${'─'.repeat(72)}\n共用掉 ${used} 個請求(上限 ${MAX_REQUESTS})。`));
