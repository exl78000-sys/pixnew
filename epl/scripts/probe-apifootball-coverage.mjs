#!/usr/bin/env node
/* API-Football(api-sports v3)涵蓋範圍探測 —— 對應探勘缺口 C/D/E/H。
 *
 * 探勘交付(2026-08-29)說 /injuries、/players、/fixtures/statistics 能補
 * 西甲英冠傷停、英冠球員、教練任期聯賽的逐場統計 —— 但交付引用的聯賽 ID
 * 來自 apifootball.com(**另一家同名服務**),不能照抄;而且本站被
 * 「方案不含此賽季」咬過(CLAUDE.md 的坑),coverage flags 一定要逐季實測。
 *
 * 這支**不猜任何 ID**:先用 /leagues?search= 自己查,再抽樣打實際端點。
 * 請求數約 15,遠低於免費層 100/day。跑法:probe-apis.yml 的 workflow_dispatch,
 * 讀 log。(HTTP 200 + errors 物件 = 失敗,那條坑也在這裡守。)
 */
const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;

async function get(path) {
  if (requests) await sleep(1200);
  requests++;
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(30000),
    headers: { 'x-apisports-key': KEY, accept: 'application/json' },
  });
  const j = await res.json().catch(() => null);
  const errs = j?.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length);
  if (!res.ok || errs) {
    console.log(`  ✗ ${path} → HTTP ${res.status}${errs ? ' errors=' + JSON.stringify(j.errors) : ''}`);
    return null;
  }
  return j;
}

/* 要探的聯賽:名稱 + 國家(用來在 search 結果裡挑對的那一個 —— 同名聯賽很多) */
const TARGETS = [
  { key: 'es1', search: 'La Liga', country: 'Spain', why: 'D 傷停 / H 控球' },
  { key: 'en2', search: 'Championship', country: 'England', why: 'C 球員 / D 傷停' },
  { key: 'swe', search: 'Allsvenskan', country: 'Sweden', why: 'E 教練任期(Hellberg)' },
  { key: 'cro', search: 'HNL', country: 'Croatia', why: 'E 教練任期(Jakirovic)' },
  { key: 'sau', search: 'Pro League', country: 'Saudi-Arabia', why: 'E 教練任期(Jaissle)' },
  { key: 'mex', search: 'Liga MX', country: 'Mexico', why: 'E 教練任期(Anselmi/San José)' },
  { key: 'bra', search: 'Serie A', country: 'Brazil', why: 'E 教練任期(Luís Castro)' },
];

async function main() {
  if (!KEY) { console.log('沒有 API_FOOTBALL_KEY,略過'); return; }

  const found = {};
  for (const t of TARGETS) {
    const j = await get(`/leagues?search=${encodeURIComponent(t.search)}`);
    const hit = (j?.response ?? []).find(r =>
      r.country?.name?.toLowerCase().replace(/-/g, ' ') === t.country.toLowerCase().replace(/-/g, ' ')
      && r.league?.type === 'League');
    if (!hit) { console.log(`  ✗ ${t.key}(${t.search} / ${t.country}):search 找不到`); continue; }
    found[t.key] = hit;
    console.log(`\n[${t.key}] ${hit.league.name} #${hit.league.id}(${hit.country.name})— ${t.why}`);
    // 逐季 coverage flags:2020 起。方案不含的賽季這裡看不出來,要靠下面的抽樣打
    for (const s of (hit.seasons ?? []).filter(s => s.year >= 2020)) {
      const c = s.coverage ?? {};
      console.log(`  ${s.year}${s.current ? '(當季)' : ''}:injuries=${c.injuries} players=${c.players}`
        + ` fixtureStats=${c.fixtures?.statistics_fixtures} events=${c.fixtures?.events} odds=${c.odds}`);
    }
  }

  /* 抽樣實打 —— coverage flag 是宣稱,方案限制只有真的打了才知道 */
  console.log('\n── 抽樣實測(flag 是宣稱,方案限制要打了才知道)──');
  const CUR = 2026;
  if (found.es1) {
    const inj = await get(`/injuries?league=${found.es1.league.id}&season=${CUR}`);
    console.log(`  D 西甲 /injuries ${CUR}:${inj ? inj.results + ' 筆' : '失敗'}`
      + (inj?.response?.[0] ? `・樣本:${inj.response[0].player?.name} / ${inj.response[0].player?.type ?? inj.response[0].player?.reason ?? ''}` : ''));
  }
  if (found.en2) {
    const inj = await get(`/injuries?league=${found.en2.league.id}&season=${CUR}`);
    console.log(`  D 英冠 /injuries ${CUR}:${inj ? inj.results + ' 筆' : '失敗'}`);
    const pl = await get(`/players?league=${found.en2.league.id}&season=${CUR}&page=1`);
    const p0 = pl?.response?.[0];
    console.log(`  C 英冠 /players ${CUR}:${pl ? `${pl.results} 筆/頁・共 ${pl.paging?.total} 頁` : '失敗'}`
      + (p0 ? `・樣本:${p0.player?.name}(${p0.statistics?.[0]?.team?.name})分鐘=${p0.statistics?.[0]?.games?.minutes}` : ''));
  }
  if (found.swe) {
    // E:抽 2024 賽季一場完賽的統計(Hellberg 在 Hammarby 的年份)
    const fx = await get(`/fixtures?league=${found.swe.league.id}&season=2024&last=1`);
    const id = fx?.response?.[0]?.fixture?.id;
    console.log(`  E 瑞典超 /fixtures 2024:${fx ? fx.results + ' 筆' : '失敗'}${id ? '・抽 fixture ' + id : ''}`);
    if (id) {
      const st = await get(`/fixtures/statistics?fixture=${id}`);
      const names = st?.response?.[0]?.statistics?.map(x => x.type) ?? [];
      console.log(`  E 該場 /fixtures/statistics:${st ? st.results + ' 隊' : '失敗'}・欄位:${names.slice(0, 8).join(', ')}`);
    }
  }
  console.log(`\n共 ${requests} 個請求。判讀要點:injuries/players 的 flag 為 true 且抽樣有資料才算能用;`
    + `「HTTP 200 + errors」或 results=0 且 flag=false = 這個方案拿不到,要記錄成驗證過的否定。`);
}

main().catch(e => { console.error('✗', e.message); process.exitCode = 1; });
