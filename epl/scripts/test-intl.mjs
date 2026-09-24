#!/usr/bin/env node
/* 國家隊的自我檢查(2026-09-24)。
 *
 * 這一塊的風險跟聯賽不一樣,測試守的也就不一樣:
 *   1. **兩個來源,分工不重疊。** 評分只從 martj42 算、畫面上的場次來自 FotMob;兩邊逐場核對的判決
 *      有六種,「待核對」「沒收」「不一致」是三件事 —— 用捏造的場次逐一驗每一種。
 *   2. **id 用內容證明。** 名字靠不住(CONCACAF 也有 Nations League、女足的 id 在 allLeagues 沒有 Women's),
 *      門檻、以及抓取器「帶 season 參數要驗 selectedSeason」那一道,用假的 fetch 驗(不連網)。
 *   3. **勝率要有證據。** 驗收每次建置重算,沒過就整批不給;回測協議(同一天互相看不到、樣本門檻)用捏造的場次驗。
 *   4. **身分只做嚴格比對。** Ireland / Northern Ireland、Congo / DR Congo 是一字之差的不同隊;
 *      還沒決定的參與者(1A、Winner SF 1)不是球隊。
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseIntlResults, runIntlElo, backtestIntl, probsFromE, expectedScore, crossCheckIntl, proofFromCheck,
  frequencyBaseline, pairedGain, PROOF_MIN_MATCHED, INTL_TUNE, INTL_HOLDOUT, intlPasses,
} from './lib/intl.mjs';
import { loadIntlTeamTable, makeIntlResolver } from './lib/intl-teams.mjs';
import { FOTMOB_INTL, INTL_FAMILIES, isIntlTbd } from './lib/adapters/fotmob-intl.mjs';
import { fetchIntl } from './fetch-intl-fotmob.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
};
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CSV = join(ROOT, 'data', 'raw', 'intl', 'results.csv');
const mj = existsSync(CSV) ? parseIntlResults(readFileSync(CSV, 'utf8')) : [];
const params = JSON.parse(readFileSync(join(ROOT, 'data', 'intl-elo-params.json'), 'utf8'));
const PRODUCT = join(ROOT, 'web', 'data', 'intl.json');
const D = existsSync(PRODUCT) ? JSON.parse(readFileSync(PRODUCT, 'utf8')) : null;

// ── 1. 歷史賽果 ───────────────────────────────────
console.log('\n▶ 國家隊:歷史賽果(martj42)');
{
  /* 77 列的城市是帶引號的 "Washington, D.C." —— split(',') 會讓那幾列錯欄(探測草稿第一版就是這樣寫的) */
  const syn = 'date,home_team,away_team,home_score,away_score,tournament,city,country,neutral\n'
    + '2024-06-01,United States,Colombia,1,5,Friendly,"Washington, D.C.",United States,FALSE\n';
  const [r] = parseIntlResults(syn);
  check('帶引號的城市不會讓整列錯欄', r?.city === 'Washington, D.C.' && r?.country === 'United States' && r?.neutral === false && r?.fa === 5,
    JSON.stringify(r));
  check('倉庫裡的 results.csv 解析得出來', mj.length > 40000, `${mj.length} 場`);
  const withComma = mj.filter(m => m.city.includes(','));
  check('真的資料裡也有帶逗號的城市,而且那幾列的國家欄是字不是數字',
    withComma.length > 0 && withComma.every(m => m.country && !/^\d+$/.test(m.country)), `${withComma.length} 列`);
  check('依日期排好', mj.every((m, i) => i === 0 || mj[i - 1].date <= m.date));
  /* raw 是抓取器寫的,**不准手改**:meta.json 記著它抓下來當時的 sha256 */
  const meta = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'intl', 'meta.json'), 'utf8'));
  const sha = createHash('sha256').update(readFileSync(CSV)).digest('hex');
  check('results.csv 的內容跟抓取當時記下的 sha256 一致(沒被手改)', sha === meta.files?.['results.csv']?.sha256);
}

// ── 2. 模型 ───────────────────────────────────────
console.log('\n▶ 國家隊:模型(走查、門檻、參數)');
{
  const P = params.params;
  const day = (date, home, away, fh, fa, extra = {}) => ({ date, home, away, fh, fa, tournament: 'Friendly', neutral: false, ...extra });
  const seen = [];
  runIntlElo([day('2020-01-01', 'A', 'B', 3, 0), day('2020-01-01', 'A', 'C', 3, 0), day('2020-01-02', 'A', 'D', 0, 0)], P,
    { onDay: (d, rows) => seen.push(...rows.map(r => ({ d, rh: r.rh }))) });
  check('同一天的比賽互相看不到結果(第二場開賽前 A 的評分還是起始值)', seen[0].rh === 1500 && seen[1].rh === 1500);
  check('隔天就看得到', seen[2].rh > 1500, `${seen[2].rh.toFixed(1)}`);

  const five = [1, 2, 3, 4, 5].map(i => day(`2021-01-0${i}`, 'A', 'B', 1, 0));
  const rows = backtestIntl(five, P, { from: '2000-01-01', minGames: 3 });
  check('回測只評兩隊都已經踢過門檻場數的比賽', rows.length === 2, `${rows.length} 場`);

  const sums = [0.02, 0.3, 0.5, 0.7, 0.98].map(E => probsFromE(E, P));
  check('三個機率加起來是 1、而且都不是負的', sums.every(p => Math.abs(p.home + p.draw + p.away - 1) < 1e-9 && p.home >= 0 && p.draw >= 0 && p.away >= 0));
  check('實力相同時主客對稱', Math.abs(sums[2].home - sums[2].away) < 1e-12);
  check('中立場不加主場分', expectedScore(1500, 1500, { neutral: true, homeAdv: P.homeAdv }) === 0.5
    && expectedScore(1500, 1500, { neutral: false, homeAdv: P.homeAdv }) > 0.5);

  check('調參與驗收的年份不重疊', INTL_TUNE.to < INTL_HOLDOUT.from, `${INTL_TUNE.to} < ${INTL_HOLDOUT.from}`);
  /* 參數檔是 tune-intl 寫的,那時候的調參區間要跟共用的常數一樣 —— 改了常數沒重跑調參,畫面印的就不是實際的那一段 */
  check('參數檔的調參區間跟共用常數一致', params.tune?.from === INTL_TUNE.from && params.tune?.to === INTL_TUNE.to);
  check('調參結果不在網格邊上(在邊上要往外擴一格再掃)', Array.isArray(params.tune?.edges) && params.tune.edges.length === 0,
    (params.tune?.edges ?? []).join('、'));

  if (D) {
    const h = D.model.holdout;
    check('產物的「通過」跟它自己印的改善與標準誤一致(門檻:兩倍標準誤)', D.model.passed === intlPasses(h), `${h?.gain} ± ${h?.se}`);
    /* 驗收用同一份資料、同一個協議重算一次,數字要對得回產物 —— 畫面印的是實際跑出來的那一份 */
    const hold = backtestIntl(mj, P, { from: INTL_HOLDOUT.from, minGames: D.model.minGames });
    const g = pairedGain(hold, frequencyBaseline(hold));
    check('驗收重算一次對得回產物', g && g.n === h.n && Math.abs(g.gain - h.gain) < 1e-4 && Math.abs(g.se - h.se) < 1e-4,
      g ? `${g.n} 場 ${g.gain.toFixed(4)} ± ${g.se.toFixed(4)}` : '—');
    const withProb = D.fixtures.filter(f => f.prob);
    check('沒通過的話一場都不給勝率', D.model.passed || withProb.length === 0);
    check('給了勝率的場次,兩隊都有評分而且場數夠', withProb.every(f => f.home.key && f.away.key
      && (D.teams[f.home.key]?.games ?? 0) >= D.model.minGames && (D.teams[f.away.key]?.games ?? 0) >= D.model.minGames));
  }
}

// ── 3. 兩個來源逐場核對與 id 證明 ──────────────────────
console.log('\n▶ 國家隊:逐場核對與 id 證明');
{
  const m = (date, home, away, fh, fa) => ({ date, home, away, fh, fa, tournament: 'Friendly', neutral: false });
  const pool = [m('2026-06-01', 'A', 'B', 2, 1), m('2026-06-02', 'C', 'D', 0, 0), m('2026-06-03', 'E', 'F', 1, 1)];
  const known = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const keyOf = n => (known.has(n) ? n : null);
  const fm = (kickoff, home, away, final, awarded = false) => ({ id: kickoff + home, kickoff, home: { name: home }, away: { name: away }, state: 'FT', final, awarded });
  const got = crossCheckIntl([
    fm('2026-06-01T18:00:00Z', 'A', 'B', [2, 1]),
    fm('2026-06-01T18:00:00Z', 'B', 'A', [1, 2]),          // 主客寫反,比分跟著反 → 一致
    fm('2026-06-02T23:30:00Z', 'C', 'D', [1, 0]),          // 跨日(±1 天)還是同一場,比分不同
    fm('2026-06-03T12:00:00Z', 'E', 'F', [3, 0], true),    // 判決比分
    fm('2026-07-01T12:00:00Z', 'G', 'H', [0, 0]),          // 晚於獨立來源的最後一天
    fm('2026-06-02T12:00:00Z', 'G', 'H', [0, 0]),          // 範圍內但它沒收
    fm('2026-06-01T12:00:00Z', 'X', 'A', [0, 0]),          // 隊名對不上
  ], pool, keyOf).map(r => r.status);
  check('六種判決各自分得出來', JSON.stringify(got) === JSON.stringify(['agree', 'agree', 'mismatch', 'awarded', 'notYet', 'unmatched', 'noKey']),
    got.join(','));

  const rows = (n, { bad = 0, dis = 0 } = {}) => Array.from({ length: n }, (_, i) => ({
    status: i < dis ? 'mismatch' : 'agree', mj: { tournament: i >= n - bad ? 'FIFA World Cup' : 'UEFA Nations League' } }));
  const exp = /^UEFA Nations League$/;
  check(`證明:對上不到 ${PROOF_MIN_MATCHED} 場不算證據`, !proofFromCheck(rows(PROOF_MIN_MATCHED - 1), exp).ok);
  check(`證明:對上 ${PROOF_MIN_MATCHED} 場、全是預期的賽事就算`, proofFromCheck(rows(PROOF_MIN_MATCHED), exp).ok);
  check('證明:賽事名對不上的太多就不算(id 可能是別的賽事)', !proofFromCheck(rows(10, { bad: 3 }), exp).ok);
  check('證明:比分不一致的太多就不算', !proofFromCheck(rows(10, { dis: 2 }), exp).ok);

  if (D) {
    const ok = new Set(D.comps.filter(c => c.status === 'ok').map(c => c.key));
    check('收進來的賽事都過了證明門檻', D.comps.filter(c => c.status === 'ok').every(c => c.proof.matched >= PROOF_MIN_MATCHED));
    check('場次只來自收進來的賽事', [...D.fixtures, ...D.results].every(x => ok.has(x.comp)));
    const STATUS = new Set(['agree', 'mismatch', 'awarded', 'notYet', 'unmatched', 'noKey']);
    check('每一場已完賽都有判決', D.results.every(r => STATUS.has(r.check)));
    check('另一個來源的比分只在「不一致 / 判決」時才附', D.results.every(r => Boolean(r.other) === (r.check === 'mismatch' || r.check === 'awarded')));
  }
}

// ── 4. 身分 ───────────────────────────────────────
console.log('\n▶ 國家隊:身分(隊名對照、佔位、中文名)');
{
  const table = loadIntlTeamTable(ROOT);
  const names = new Set(mj.flatMap(x => [x.home, x.away]));
  const R = makeIntlResolver(table, names);
  const aliases = Object.entries(table.aliases ?? {});
  check('每一筆別名都有證據', aliases.every(([k]) => table._evidence?.[k]), aliases.filter(([k]) => !table._evidence?.[k]).map(([k]) => k).join('、'));
  check('每一筆別名都指到獨立來源裡真的有的隊名', aliases.every(([, v]) => names.has(v)), aliases.filter(([, v]) => !names.has(v)).map(([, v]) => v).join('、'));
  check('一字之差的不同隊不會被併(Ireland ≠ Northern Ireland、Congo ≠ DR Congo)',
    R.keyOf('Ireland') === 'Republic of Ireland' && R.keyOf('Northern Ireland') === 'Northern Ireland'
    && R.keyOf('Congo') === 'Congo' && R.keyOf('DR Congo') === 'DR Congo' && R.keyOf('Guinea') === 'Guinea');
  check('不做寬鬆比對(Korea 對不上任何一隊)', R.keyOf('Korea') === null);
  check('還沒決定的參與者認得出來', ['1A', '2B', 'Winner SF 1', 'Manchester City/Norwich City'].every(isIntlTbd)
    && !['Wales', 'Guinea-Bissau', 'Bosnia and Herzegovina'].some(isIntlTbd));
  check('中文名:覆寫優先、其餘走 CLDR', R.zhOf('England') === '英格蘭' && R.zhOf('Taiwan') === '中華台北' && R.zhOf('Netherlands') === '荷蘭',
    `${R.zhOf('England')} / ${R.zhOf('Taiwan')} / ${R.zhOf('Netherlands')}`);

  if (D) {
    const sides = [...D.fixtures, ...D.results].flatMap(x => [x.home, x.away]);
    check('佔位的那一格不給身分', sides.filter(t => t.tbd).every(t => t.key === null && t.label));
    check('佔位的名字不混進「對不上身分」那一份清單', (D.unknownNames ?? []).every(u => !isIntlTbd(u.name)));
    const keys = [...sides.map(t => t.key), ...D.ranking.map(r => r.key)].filter(Boolean);
    check('畫面會用到的每一隊都在隊伍字典裡', keys.every(k => D.teams[k]), keys.filter(k => !D.teams[k]).slice(0, 5).join('、'));
  }
}

// ── 5. 產物與頁面的約定 ──────────────────────────────
console.log('\n▶ 國家隊:產物與頁面的約定');
{
  check('產物存在(npm run build 會產生 web/data/intl.json)', Boolean(D));
  if (D) {
    const need = ['builtAt', 'model', 'sources', 'comps', 'families', 'notFetched', 'fixtures', 'results', 'ranking', 'teams', 'unknownNames'];
    check('頁面讀的欄位都在', need.every(k => k in D), need.filter(k => !(k in D)).join('、'));
    check('未賽依開球時間排好、賽果由新到舊', D.fixtures.every((f, i) => i === 0 || D.fixtures[i - 1].kickoff <= f.kickoff)
      && D.results.every((r, i) => i === 0 || D.results[i - 1].kickoff >= r.kickoff));
    check('勝率加起來是 1', D.fixtures.filter(f => f.prob).every(f => Math.abs(f.prob[0] + f.prob[1] + f.prob[2] - 1) < 0.002));
    const weekAgo = Date.parse(D.builtAt) - 7 * 86400000;
    check('取消的場次只留最近一週的', D.fixtures.filter(f => f.state === 'CANCELLED').every(f => Date.parse(f.kickoff) >= weekAgo));
    check('排名由高到低、每一隊都過場數門檻', D.ranking.every((r, i) => (i === 0 || D.ranking[i - 1].rating >= r.rating) && r.games >= D.model.minGames));
    const famKeys = new Set(INTL_FAMILIES.map(f => f.key));
    const okFams = new Set(D.comps.filter(c => c.status === 'ok').map(c => c.family));
    check('篩選按鈕只給有場次的賽事家族(按下去不會是空的)', D.families.every(f => famKeys.has(f.key) && okFams.has(f.key))
      && [...okFams].every(k => D.families.some(f => f.key === k)));
    check('每一個賽事都在產物裡講了狀態', FOTMOB_INTL.every(c => D.comps.some(x => x.key === c.key)));
  }

  const core = readFileSync(join(ROOT, 'web', 'assets', 'js', 'core.js'), 'utf8');
  const site = /const SITE_PAGES = \[([\s\S]*?)\n\];/.exec(core)?.[1] ?? '';
  check('導覽列跨聯賽那一組有國家隊', /\['intl', '國家隊'\]/.test(site));
  /* 有 open 清單的聯賽要把它列進去 —— 導覽列的 open 過濾對 SITE_PAGES 也生效,
     不列的話從那個聯賽點過去,導覽列上就找不到這一頁(總覽那條註解講過) */
  const opens = [...core.matchAll(/open: \[([^\]]*)\]/g)].map(x => x[1]);
  check('每個有 open 清單的聯賽都開了國家隊', opens.length > 0 && opens.every(o => o.includes("'intl'")), `${opens.length} 份清單`);
  const bundle = readFileSync(join(ROOT, 'scripts', 'bundle.mjs'), 'utf8');
  check('單檔版的頁面清單有國家隊', /const PAGES = \[[^\]]*'intl'/.test(bundle));
  const html = existsSync(join(ROOT, 'web', 'intl.html')) ? readFileSync(join(ROOT, 'web', 'intl.html'), 'utf8') : '';
  check('intl.html 載入 page-intl.js', /assets\/js\/page-intl\.js/.test(html));

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const b = pkg.scripts.build ?? '';
  check('npm run build 會建國家隊,而且排在資產戳之前', b.includes('build-intl.mjs') && b.indexOf('build-intl.mjs') < b.indexOf('stamp-assets.mjs'));

  const live = readFileSync(join(ROOT, '..', '.github', 'workflows', 'epl-live.yml'), 'utf8');
  const iR = live.indexOf('npm run intl:results'), iF = live.indexOf('npm run intl:fetch'), iB = live.indexOf('run: npm run build');
  check('部署工作流先抓 martj42、再抓 FotMob、都在建置之前(抓取器用 martj42 證明 id)', iR > 0 && iR < iF && iF < iB);
  check('兩份國家隊 raw 都在回寫清單裡', /epl\/data\/raw\/intl\//.test(live) && /epl\/data\/raw\/fotmob-intl\//.test(live));

  /* 頁面不寫死「幾個賽事」:賽事數、樣本數、門檻都從產物讀(「只有一個」那句寫死在畫面上是本站的老坑) */
  const page = stripComments(readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-intl.js'), 'utf8'));
  check('頁面沒有寫死賽事數與驗收數字', !/[八8] ?個賽事|4,?661|0\.0551/.test(page));
}

// ── 6. 抓取器的守門(假的 fetch,不連網)────────────────
console.log('\n▶ 國家隊:抓取器的守門(假的 fetch,不連網)');
{
  const dir = mkdtempSync(join(tmpdir(), 'intl-fetch-test-'));
  // 拿獨立來源裡真的有的歐國聯 2024 場次當「上一季」—— 證明那一步對得上
  const unl = mj.filter(x => x.tournament === 'UEFA Nations League' && x.date >= '2024-09-01' && x.date <= '2024-11-30').slice(0, 10);
  const asFm = (x, i) => ({ id: 900000 + i, home: { name: x.home, id: 1 }, away: { name: x.away, id: 2 },
    status: { utcTime: `${x.date}T18:45:00Z`, started: true, finished: true, cancelled: false, scoreStr: `${x.fh} - ${x.fa}`, reason: { short: 'FT' } } });
  const upcoming = { id: 1, home: { name: 'Netherlands', id: 1 }, away: { name: 'Germany', id: 2 },
    status: { utcTime: '2030-01-01T18:45:00Z', started: false, finished: false, cancelled: false } };
  const body = (name, season, matches) => ({ details: { name, selectedSeason: season }, allAvailableSeasons: ['2026/2027', '2024/2025'], fixtures: { allMatches: matches } });
  const routes = new Map([
    ['id=9806', body('UEFA Nations League A', '2026/2027', [upcoming])],
    // 帶 season 要上一季,上游回的卻是本季 —— 盃賽踩過的那一種;不驗的話會把本季存成證據
    ['id=9806&season=2024%2F2025', body('UEFA Nations League A', '2026/2027', unl.map(asFm))],
    ['id=9807', body('UEFA Nations League B', '2026/2027', [upcoming])],
    ['id=9807&season=2024%2F2025', body('UEFA Nations League B', '2024/2025', unl.map(asFm))],
    ['id=114', body("Women's Friendlies", '2026', [upcoming])],
    ['id=329', { error: 'rate limited' }],
  ]);
  /* 上一份快取:抓失敗時要原樣保留。**裡面要有場次** —— 空的快取被洗成空的,比對起來一模一樣,
     這條就守不住「洗掉」那一種 bug(負向對照第一次跑,這裡就是 0 條紅) */
  const prevCnl = { schemaVersion: 1, key: 'cnl', id: 9821, fmName: 'CONCACAF Nations League', season: '2026/2027', availableSeasons: [],
    retrievedAt: '2026-01-01T00:00:00.000Z', proof: null,
    matches: [{ id: '1', kickoff: '2026-10-04T19:00:00Z', home: { name: 'Aruba', shortName: null, fmId: '1' }, away: { name: 'Anguilla', shortName: null, fmId: '2' },
      state: 'NS', final: null, reason: null, reasonLong: null, awarded: false, round: '5', group: '2' }] };
  writeFileSync(join(dir, 'cnl.json'), JSON.stringify(prevCnl));
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const key = String(url).split('?')[1];
    const hit = routes.get(key);
    const text = hit ? JSON.stringify(hit) : 'nope';
    return { ok: Boolean(hit), status: hit ? 200 : 500, text: async () => text };
  };
  try {
    await fetchIntl({ outDir: dir, force: true, gapMs: 0, log: () => {} });
  } finally { globalThis.fetch = realFetch; }
  const read = k => (existsSync(join(dir, `${k}.json`)) ? JSON.parse(readFileSync(join(dir, `${k}.json`), 'utf8')) : null);
  check('上游回錯季(要上一季、回本季)不收成證據', read('unl-a') && read('unl-a').proof === null);
  check('回對季的上一季存成證據', read('unl-b')?.proof?.season === '2024/2025' && read('unl-b').proof.matches.length === unl.length,
    `${read('unl-b')?.proof?.matches.length ?? 0} / ${unl.length} 場`);
  check('details.name 是女足的不收', read('friendly') === null);
  check('回 200 但帶 error 物件的不收', read('gulf') === null);
  check('抓失敗時保留上一份,不洗掉', JSON.stringify(read('cnl')) === JSON.stringify(prevCnl));
  check('請求數在上限之內', calls <= 20, `${calls} 個`);
  rmSync(dir, { recursive: true, force: true });
}
