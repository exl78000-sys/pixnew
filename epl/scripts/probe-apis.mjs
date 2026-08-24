#!/usr/bin/env node
// 探測各個候選免費資料源通不通、回傳什麼。
//
// ⚠ 我在開發沙箱裡跑不了(所有外部端點都被擋),所以這支腳本的用途就是
//    讓「連得到外網的環境」(你的電腦 / GitHub Actions runner)去實測,
//    再把結果貼回來,我才知道哪些真的能接。
//
// 需要金鑰的來源會自動略過,除非你設了對應的環境變數。
// 用法: npm run probe:apis
const KEYS = {
  apiFootball: process.env.API_FOOTBALL_KEY,     // api-sports.io / RapidAPI
  footballData: process.env.FOOTBALL_DATA_TOKEN, // football-data.org
  sportsDb: process.env.SPORTSDB_KEY || '3',     // TheSportsDB 有公開測試鍵 "3"
};

const UA = 'pl-war-room/1.0 (football analysis side project)';

const TARGETS = [
  {
    id: 'pulselive-fixtures',
    what: '英超官網後端:賽程(含 teamlists 可取得官方陣型)',
    url: 'https://footballapi.pulselive.com/football/competitions',
    headers: { Origin: 'https://www.premierleague.com', Referer: 'https://www.premierleague.com/' },
    note: '官網內部 API,非公開文件化,隨時可能改。成功的話是官方陣型最直接的來源。',
    key: null,
  },
  {
    id: 'espn-scoreboard',
    what: 'ESPN 隱藏 API:賽果與陣容',
    url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
    note: '未文件化但長期穩定、免金鑰。回傳含 lineup 與部分 formation。',
    key: null,
  },
  {
    id: 'football-data',
    what: 'football-data.org:賽程/賽果/積分榜(免費含英超與歐冠)',
    url: 'https://api.football-data.org/v4/competitions/PL/matches?season=2026',
    headers: KEYS.footballData ? { 'X-Auth-Token': KEYS.footballData } : null,
    note: '免費方案 10 req/min。需要免費註冊取得 token。',
    key: 'FOOTBALL_DATA_TOKEN',
  },
  {
    id: 'api-football',
    what: 'API-Football:陣容(含 formation)、傷停、轉會、教練',
    url: 'https://v3.football.api-sports.io/status',
    headers: KEYS.apiFootball ? { 'x-apisports-key': KEYS.apiFootball } : null,
    note: '免費 100 req/天。功能最齊,是官方陣型與教練資料的最佳單一來源。',
    key: 'API_FOOTBALL_KEY',
  },
  {
    id: 'thesportsdb',
    what: 'TheSportsDB:球員照片、隊徽、球場圖',
    url: `https://www.thesportsdb.com/api/v1/json/${KEYS.sportsDb}/searchplayers.php?p=Bukayo%20Saka`,
    note: '社群維護,免費。球員照片的授權比英超官方圖寬鬆,可能是頭貼的替代來源。',
    key: null,
  },
  {
    id: 'football-data-couk',
    what: 'football-data.co.uk:歷史賽果 + 博彩賠率 CSV',
    url: 'https://www.football-data.co.uk/mmz4281/2526/E0.csv',
    note: '免金鑰。賠率可當模型的外部基準 —— 贏過市場才是真的準。',
    key: null,
  },
  {
    id: 'understat',
    what: 'Understat:射門層級 xG',
    url: 'https://understat.com/league/EPL',
    note: '沒有正式 API,資料嵌在 HTML 的 JSON 變數裡。要解析,不是乾淨的介面。',
    key: null,
  },
];

const probe = async (t) => {
  if (t.key && !t.headers) return { ...t, status: 'skipped', detail: `未設定 ${t.key},略過` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(t.url, {
      headers: { 'user-agent': UA, accept: 'application/json,text/csv,*/*', ...(t.headers ?? {}) },
      signal: ctrl.signal,
    });
    const body = (await res.text()).slice(0, 400);
    return { ...t, status: res.ok ? 'ok' : `http-${res.status}`, detail: body.replace(/\s+/g, ' ').slice(0, 220) };
  } catch (e) {
    return { ...t, status: 'error', detail: e.name === 'AbortError' ? 'timeout' : String(e.message ?? e) };
  } finally { clearTimeout(timer); }
};

console.log('▶ 探測候選資料源\n');
const results = [];
for (const t of TARGETS) {
  const r = await probe(t);
  results.push(r);
  const mark = r.status === 'ok' ? '✔' : r.status === 'skipped' ? '–' : '✗';
  console.log(`${mark} ${r.id}`);
  console.log(`   ${r.what}`);
  console.log(`   ${r.status}${r.status === 'ok' ? '' : ` —— ${r.detail}`}`);
  if (r.status === 'ok') console.log(`   回傳開頭:${r.detail}`);
  console.log(`   備註:${r.note}\n`);
  await new Promise(r2 => setTimeout(r2, 400));
}

const ok = results.filter(r => r.status === 'ok').map(r => r.id);
const skipped = results.filter(r => r.status === 'skipped').map(r => r.key);
console.log('─'.repeat(60));
console.log(`可用:${ok.length ? ok.join('、') : '(無)'}`);
if (skipped.length) console.log(`需要金鑰才能測:${[...new Set(skipped)].join('、')}`);
console.log('\n把上面整段輸出貼回對話,我就知道哪些能接。');
