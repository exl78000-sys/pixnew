#!/usr/bin/env node
/* 英冠資料邊界測試。
 *
 * 這個聯賽的風險跟另外兩個不一樣,測試也就守不一樣的東西:
 *   1. **產物的欄位名要跟另外兩個聯賽一致**。前端是三個聯賽共用的,
 *      自己取名字的代價是畫面上印 undefined 而測試全綠 ——
 *      這一輪實際犯了四次(season / reports / sources / model.note)。
 *   2. **兩份來源要對得起來**。英冠沒有 FPL 也沒有 Understat,
 *      能互相驗的只有 openfootball 與 football-data.co.uk。
 *   3. **附加賽不可以混進聯賽**。它跟聯賽撞「主客組合」這個鍵,
 *      混進去會讓補比分補到錯的場次上(已經踩過)。
 *   4. **不可以假裝有球員資料**。Understat 沒有英冠是實測過的,
 *      畫面要講得出這件事。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillScores } from './lib/league-matches.mjs';
import { loadTeams } from './lib/teams.mjs';
import { simulateSeason } from './lib/simulate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEASONS = ['2023-24', '2024-25', '2025-26', '2026-27'];
const ofRaw = s => JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'openfootball-championship', `${s}.json`), 'utf8'));
const fdRaw = s => readFileSync(join(ROOT, 'data', 'raw', 'football-data-couk-championship', `${s}.csv`), 'utf8');
const out = n => JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'en2', `${n}.json`), 'utf8'));
const es1 = n => JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'es1', `${n}.json`), 'utf8'));
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
};

console.log('\n▶ 英冠自我檢查');

const T = loadTeams(ROOT, { file: 'teams-championship.json' });
const meta = out('meta'), teams = out('teams'), fixtures = out('fixtures');
const table = out('table'), results = out('results'), sim = out('sim');

// ── 1. 名冊與兩份來源 ───────────────────────────────
{
  const codes = T.list.map(t => t.code);
  check('隊碼唯一', new Set(codes).size === codes.length);
  check('openfootball 隊名唯一', new Set(T.list.map(t => t.of)).size === T.list.length);
  check('football-data.co.uk 簡稱唯一', new Set(T.list.map(t => t.fd)).size === T.list.length);

  /* 隊碼跟英超名冊共用的那幾支,必須是**同一支球隊**。
     不同球隊撞同一個碼的話,盃賽與歐冠那些跨聯賽的頁面會把兩隊資料混在一起。 */
  const pl = loadTeams(ROOT);
  const clash = T.list.filter(t => {
    const other = pl.byCode.get(t.code);
    return other && T.looseKey(other.of) !== T.looseKey(t.of);
  });
  check('跟英超共用的隊碼指的是同一支球隊', clash.length === 0,
    clash.map(t => `${t.code} ${t.of}`).join('、'));

  const ofMap = new Map(T.list.map(t => [t.of, t.code]));
  const fdMap = new Map(T.list.map(t => [t.fd, t.code]));
  const missing = [];
  for (const s of SEASONS) {
    for (const m of ofRaw(s).matches) {
      for (const n of [m.team1, m.team2]) if (!ofMap.has(n)) missing.push(`${s} of:${n}`);
    }
    if (!existsSync(join(ROOT, 'data', 'raw', 'football-data-couk-championship', `${s}.csv`))) continue;
    const rows = fdRaw(s).trim().split(/\r?\n/);
    const h = rows[0].split(',');
    const [iH, iA] = ['HomeTeam', 'AwayTeam'].map(k => h.indexOf(k));
    for (const l of rows.slice(1)) {
      const c = l.split(',');
      for (const n of [c[iH], c[iA]]) if (n && !fdMap.has(n)) missing.push(`${s} fd:${n}`);
    }
  }
  /* 漏一支球隊 = 那一季少算一批比賽,而畫面上完全看不出來。 */
  check('兩份來源的每個隊名都對得上名冊', missing.length === 0, [...new Set(missing)].join('、'));
}

// ── 2. 兩份來源逐場核對(鐵則五:外部資料要有獨立來源) ──────
{
  const T2 = loadTeams(ROOT, { file: 'teams-championship.json' });
  const byFd = new Map(T2.list.map(t => [t.fd, t.code]));
  const codeOf = n => byFd.get(n) ?? T2.codeOf(n);
  const ofMap = new Map(T2.list.map(t => [t.of, t.code]));
  const season = '2025-26';
  const ours = ofRaw(season).matches
    .filter(m => /^Matchday/.test(m.round ?? ''))
    .map((m, i) => {
      const ft = Array.isArray(m.score) ? m.score : m.score?.ft;
      return {
        id: i, home: ofMap.get(m.team1), away: ofMap.get(m.team2),
        played: !!ft, fh: ft?.[0] ?? null, fa: ft?.[1] ?? null,
      };
    });
  const r = backfillScores(ours.map(x => ({ ...x })), fdRaw(season), codeOf, { div: 'E1' });
  check(`${season} 兩份來源重疊場次全部一致`, r.mismatches.length === 0 && r.checked >= 500,
    `核對 ${r.checked} 場、不符 ${r.mismatches.length} 場`);

  /* **0-0 不是「沒有比分」。** openfootball 對 0:0 收場寫成 `"score":[0,0]`
     而不是 `{"ft":[0,0]}`,只認 score.ft 的話會數成「缺 34 場」——
     我就這樣誤判過一次,還寫進了註解。這一條守著那個形狀。 */
  const zeros = ofRaw(season).matches.filter(m => Array.isArray(m.score));
  check(`${season} 的 0:0 用陣列形式寫,且都當成已完賽`,
    zeros.length > 0 && zeros.every(m => m.score[0] === 0 && m.score[1] === 0)
    && ours.filter(m => Array.isArray(null) === false && m.played).length === 552,
    `陣列形式 ${zeros.length} 場、已完賽 ${ours.filter(m => m.played).length} / ${ours.length}`);
}

// ── 3. 附加賽不可以混進聯賽 ─────────────────────────
{
  const po = results.filter(m => m.stage);
  check('賽果裡保留了升級附加賽', po.length > 0, `${po.length} 場`);
  const inTable = table.last.reduce((a, r) => a + r.p, 0);
  check('積分榜只算聯賽場次(24 隊 × 46 輪)', inTable === 24 * 46, String(inTable));
  check('積分榜進球總和自洽',
    table.last.reduce((a, r) => a + r.gf, 0) === table.last.reduce((a, r) => a + r.ga, 0));

  /* 附加賽跟聯賽會撞「主客組合」這個鍵 —— 這是實際踩過的 bug:
     每季報 5 場假的「比分不符」,看起來像上游資料衝突。
     這一條直接驗那個守門:混進去就要整份不做,不能靜靜補錯。 */
  const fake = [
    { home: 'AAA', away: 'BBB', played: true, fh: 1, fa: 0 },
    { home: 'AAA', away: 'BBB', played: false, fh: null, fa: null, stage: '升級附加賽' },
  ];
  const csv = 'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG\nE1,01/01/2026,X,Y,1,0\n';
  const r = backfillScores(fake, csv, n => ({ X: 'AAA', Y: 'BBB' }[n] ?? null), { div: 'E1' });
  check('附加賽不參與補比分(不會被當成同一場)', r.duplicateKeys === undefined && r.mismatches.length === 0);
  const bothLeague = [
    { home: 'AAA', away: 'BBB', played: true, fh: 1, fa: 0 },
    { home: 'AAA', away: 'BBB', played: false, fh: null, fa: null },
  ];
  const r2 = backfillScores(bothLeague, csv, n => ({ X: 'AAA', Y: 'BBB' }[n] ?? null), { div: 'E1' });
  check('聯賽裡真的出現重複對戰 → 整份不做', r2.duplicateKeys?.length === 1 && r2.filled === 0);
}

// ── 4. 產物的欄位名要跟另外兩個聯賽一致 ───────────────
{
  /* 這一節守的是這一輪犯了四次的那種錯:自己給產物取欄位名,
     前端讀不到就在畫面上印 undefined,而所有測試都是綠的。 */
  const m2 = es1('meta');
  const metaKeys = ['currentSeason', 'lastSeason', 'historySeasons', 'sources', 'model', 'counts', 'competition'];
  check('meta 的關鍵欄位名跟西甲一致', metaKeys.every(k => k in meta && k in m2),
    metaKeys.filter(k => !(k in meta)).join('、'));
  check('meta.sources 用 name / url(頁尾靠這兩個)',
    meta.sources.every(s => typeof s.name === 'string' && typeof s.url === 'string'));
  check('meta.model 用 caveats 而不是自己取的名字',
    Array.isArray(meta.model.caveats) && typeof meta.model.type === 'string');
  const rep = out('reports');
  check('reports 的形狀跟西甲一致(seasons / count / reports)',
    ['seasons', 'count', 'reports'].every(k => k in rep && k in es1('reports')));
  check('meta 沒有設 edition(設了會被前端當成西甲)', !('edition' in meta));
}

// ── 5. 不可以假裝有球員資料 ─────────────────────────
{
  check('players.json 是空的', out('players').length === 0);
  check('meta 明講這個聯賽沒有球員資料', meta.capabilities?.players === false
    && meta.players?.available === false && /Understat/.test(meta.players?.note ?? ''));
  /* 缺的東西要 null 不要 0 —— 0 看起來像「量到了,結果是零」。 */
  check('球隊的陣容人數是 null 不是 0', teams.every(t => t.squadSize === null));
  check('資料界線有講出「沒有球員級資料源」', (meta.boundaries ?? []).some(x => /球員/.test(x)));
}

// ── 6. 模擬的分界線要對得上這個聯賽 ──────────────────
{
  check('模擬輸出直升機率(英冠前 2 直升)', sim.every(r => typeof r.promotionPct === 'number'));
  check('直升機率不高於前六機率', sim.every(r => r.promotionPct <= r.top6Pct + 0.001));
  const sumTitle = sim.reduce((a, r) => a + r.titlePct, 0);
  check('奪冠機率加總約 100%', Math.abs(sumTitle - 100) < 1.5, sumTitle.toFixed(1));
  /* 沒給 promotion 的聯賽不可以多出這個欄位 —— 多給了前端會以為英超也有直升。 */
  const plain = simulateSeason({
    model: { attack: { A: 0, B: 0 }, defence: { A: 0, B: 0 }, gamma: 0.2, rho: -0.1, mu: 0 },
    fixtures: [], codes: ['A', 'B'], played: [], runs: 10,
  });
  check('沒宣告 promotion 的聯賽不會多出直升欄位', plain.every(r => !('promotionPct' in r)));
}

// ── 7. 隊徽、賠率、回測 ────────────────────────────
{
  check('本季 24 隊都有內嵌 PNG 隊徽',
    teams.every(t => t.crest?.startsWith('data:image/png;base64,')),
    `${teams.filter(t => t.crest).length} / ${teams.length}`);
  check('未賽場次的三向機率加總約等於 1',
    fixtures.filter(f => !f.played).every(f => f.prediction
      && Math.abs(f.prediction.home + f.prediction.draw + f.prediction.away - 1) < 0.002));
  check('已完賽場次不拿重擬合機率冒充賽前預測',
    fixtures.filter(f => f.played).every(f => f.prediction === null));

  const bt = meta.model.backtest;
  if (bt?.available) {
    check('走查回測贏過基準線', bt.rps < bt.baselineRps, `${bt.rps} < ${bt.baselineRps}`);
    check('回測母體是完整一季', bt.games === 552, String(bt.games));
    check('回測驗收季不等於訓練季', !bt.trainSeasons.includes(bt.season),
      `${bt.trainSeasons.join('+')} → ${bt.season}`);
  } else {
    check('沒有回測就不給準度數字', meta.model.backtest.available === false
      && !('rps' in meta.model.backtest));
  }
}

// ── 8. 升降級對帳 ─────────────────────────────────
{
  /* 積分榜是從比分算的,不含英冠常見的扣分處分。對不上時**要講在畫面上**,
     不是靜靜顯示一個跟官方差一名的名次。 */
  const lastCodes = new Set(table.last.map(r => r.code));
  const curCodes = new Set(table.current.map(r => r.code));
  const left = [...lastCodes].filter(c => !curCodes.has(c));
  check('上季離開聯賽的隊數是 6(2 直升 + 1 附加賽 + 3 降級)', left.length === 6, left.join('、'));
  if (meta.tableCaveat) {
    check('對不上時有把差異寫進資料界線',
      (meta.boundaries ?? []).some(x => x.includes('後三名')),
      meta.tableCaveat.note.slice(0, 40));
  }
}

// ── 9. 單場分析頁要的檔案 ──────────────────────────
{
  /* 單場分析**不在導覽列的 open 清單裡,但它照樣進得來** —— 首頁的
     「接下來的比賽」每一場都連過去。少寫任何一份,讀者從首頁點一場比賽
     就會撞上「載入失敗…請先執行 npm run build」(給開發者的訊息,而且理由是錯的)。
     實際壞過一次,所以釘死。 */
  const need = ['tactics', 'experts', 'lineups', 'live', 'shapes', 'official',
    'meta', 'clubs', 'teams', 'fixtures', 'players', 'reports', 'analysis', 'goals', 'h2h', 'form'];
  const miss = need.filter(n => !existsSync(join(ROOT, 'web', 'data', 'leagues', 'en2', `${n}.json`)));
  check('單場分析頁要的資料集一份都不缺', miss.length === 0, miss.join('、'));

  /* **live.matches 是陣列,official / experts 的 matches 是物件。**
     同一個名字兩種型別,照著別的檔案抄很容易抄反 —— 寫成物件的話
     `(live?.matches ?? []).find(...)` 直接拋錯,而測試不會知道。 */
  check('live.matches 是陣列(跟西甲同型別)', Array.isArray(out('live').matches));
  check('official.matches 是物件(跟西甲同型別)',
    out('official').matches && !Array.isArray(out('official').matches));
  check('experts.matches 是物件(跟西甲同型別)',
    out('experts').matches && !Array.isArray(out('experts').matches));
}

// ── 10. 人工交付的球隊資料 ──────────────────────────
{
  /* 收件匣 → 核對器 → 產物,build 只讀產物。直接讀收件匣等於把核對繞過去。 */
  const vPath = join(ROOT, 'data', 'championship-teams-verified.json');
  const inboxPath = join(ROOT, 'data', 'manual', 'championship-teams-delivery.json');
  if (existsSync(vPath) && existsSync(inboxPath)) {
    const v = JSON.parse(readFileSync(vPath, 'utf8'));
    check('球隊資料交付通過核對', v.accepted === true, v.problems.join('、'));
    /* **對照題不是裝飾。** 12 支本站既有球隊的城市/球場/容量/隊色是刻意留在
       交付清單裡的,對不上就是訊號。 */
    check('對照題涵蓋 12 支本站既有球隊', v.controlTeams === 12, String(v.controlTeams));

    const sha = createHash('sha256').update(readFileSync(inboxPath)).digest('hex');
    check('核對結果跟收件匣同步(sha 一致)', v.inboxSha === sha);

    const clubs = out('clubs');
    check('隊色掛到每一支球隊', clubs.every(c => Array.isArray(c.colors) && c.colors.length >= 1),
      `${clubs.filter(c => c.colors?.length).length} / ${clubs.length}`);
    check('球場與容量掛上了', clubs.every(c => c.venue && Number.isInteger(c.capacity)));
    /* 綽號沒有的要維持 null,不可以硬編一個 —— 交付有 4 支回 null。 */
    check('沒有綽號的維持 null,不硬編', clubs.some(c => c.nickname == null));

    /* build 只讀產物:收件匣的內容不可以有任何一格直接進畫面而沒過核對。 */
    const src = readFileSync(join(ROOT, 'scripts', 'build-championship.mjs'), 'utf8');
    check('build 讀的是核對後的產物,不是收件匣',
      /championship-teams-verified\.json/.test(src)
      && !/readFile\([^)]*championship-teams-delivery\.json[^)]*,\s*'utf8'\)/.test(src));
    check('build 會比對收件匣 sha(改過沒重跑核對就整批不掛)',
      /inboxSha !== sha/.test(src));
  }
}

// ── 11. 外電 ──────────────────────────────────────
{
  const news = out('news');
  check('外電有抓到', news.length > 0, `${news.length} 則`);
  check('每一則都有標題、原文連結與來源',
    news.every(n => n.title && n.link && n.source));
  check('分類是「英冠外電」,不是套用別的聯賽',
    news.every(n => n.cat === '英冠外電'),
    [...new Set(news.map(n => n.cat))].join('、'));
  check('meta.counts.news 跟實際筆數一致', meta.counts.news === news.length,
    `${meta.counts.news} vs ${news.length}`);

  /* **來源要實測過內容才收。** Sky 的 11663 看名字像英冠,實際回的是
     「Gallery: New Premier League kits」那種英超內容 —— 跟 feeds.json 裡
     「Sky Sports 英超」曾經指到 Sky News 綜合體育是同一個坑。
     被退掉的來源要留紀錄,否則下一個人會再加一次。 */
  const feeds = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', 'feeds-championship.json'), 'utf8'));
  check('被退掉的來源有留紀錄與理由',
    Object.keys(feeds._rejected ?? {}).length > 0
    && Object.values(feeds._rejected).every(v => /實測/.test(v)));
  check('沒有把被退掉的來源又加回 feeds',
    (feeds.feeds ?? []).every(f => !Object.hasOwn(feeds._rejected ?? {}, f.url)));

  /* fetch-news 原本是「不是 es1 就是 pl」的二元判斷 —— 那種寫法會把
     --league=en2 靜靜當成英超,於是英冠的動態頁長出英超的外電。 */
  const src = readFileSync(join(ROOT, 'scripts', 'fetch-news.mjs'), 'utf8');
  check('fetch-news 走註冊表,不是「是不是某一個」的二元判斷',
    /const LEAGUES = \{/.test(src) && /Object\.hasOwn\(LEAGUES, want\)/.test(src)
    && !/arg\('league'\) === 'es1' \? 'es1' : 'pl'/.test(src));
}

// ── 12. 開賽時間的時區 ─────────────────────────────
{
  /* 英格蘭是 GMT/BST,不是固定 +01:00。冬季場次照抄西歐的偏移會整批早一小時。 */
  const winter = fixtures.filter(f => f.kickoff && /-(12|01|02)-/.test(f.date));
  const summer = fixtures.filter(f => f.kickoff && /-(05|06|07|08)-/.test(f.date));
  check('冬季場次用 GMT(+00:00)', winter.length > 0 && winter.every(f => f.kickoff.endsWith('+00:00')),
    `${winter.length} 場、樣本 ${winter[0]?.kickoff ?? '—'}`);
  check('夏季場次用 BST(+01:00)', summer.length > 0 && summer.every(f => f.kickoff.endsWith('+01:00')),
    `${summer.length} 場、樣本 ${summer[0]?.kickoff ?? '—'}`);
}

if (process.exitCode) throw new Error('英冠自我檢查失敗');
console.log('  英冠全部通過');
