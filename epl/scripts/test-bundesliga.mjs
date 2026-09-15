#!/usr/bin/env node
/* 德甲資料邊界測試。
 *
 * 這個聯賽是第四個,所以最大的風險**不是模型算錯**,是「照抄別的聯賽照抄得不夠」——
 * 產物少一個欄位,前端三個聯賽共用的那份程式就在畫面上 TypeError,
 * 而 `npm test` 全綠(測試看不到版面)。這一輪實際犯了兩次:
 *   - `meta.model.simulationRuns` 沒寫 → 球隊頁整頁只剩一行字
 *   - `analysis.json` 沒寫 → 首頁 console 印「讀取 analysis 失敗(404)」
 * 所以第 3 節逐欄位跟既有聯賽比,第 7 節把單場分析頁要的每一份檔案釘死。
 *
 * 另外三件德甲**自己特有**的事:
 *   1. 第二來源不是每一季都有(沙箱抓不到 football-data.co.uk)。
 *      有的季要逐場核對、沒有的季要照實講,**不可以讓讀者以為每一季把關一樣嚴**。
 *   2. 德甲的附加賽是「第 16 名 vs 德乙第 3 名」——**跨聯賽**,
 *      所以模擬不可以有 promotionPct 那種聯賽內附加賽的欄位。
 *   3. 球員層是「還沒抓」不是「拿不到」(Understat 有德甲,是沙箱出不去)。
 *      英冠那句「來源就是沒有」抄過來就是說謊。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { simulateSeason } from './lib/simulate.mjs';
import { europeanKickoff } from './lib/league-matches.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEASONS = ['2023-24', '2024-25', '2025-26', '2026-27'];
const OF_DIR = join(ROOT, 'data', 'raw', 'openfootball-bundesliga');
const FD_DIR = join(ROOT, 'data', 'raw', 'football-data-couk-bundesliga');
const ofRaw = s => JSON.parse(readFileSync(join(OF_DIR, `${s}.json`), 'utf8'));
const hasFd = s => existsSync(join(FD_DIR, `${s}.csv`));
const fdRaw = s => readFileSync(join(FD_DIR, `${s}.csv`), 'utf8');
const out = n => JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'de1', `${n}.json`), 'utf8'));
const en2 = n => JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'en2', `${n}.json`), 'utf8'));
/* 球員層要跟**西甲**比,不是英冠:本站有兩種合法的球員層(逐場累加 / Understat 整季彙總),
   德甲走的是後者,前端也是看 leaders.source 分岔的。 */
const es1 = n => JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'leagues', 'es1', `${n}.json`), 'utf8'));
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
};

console.log('\n▶ 德甲自我檢查');

const T = loadTeams(ROOT, { file: 'teams-bundesliga.json' });
const meta = out('meta'), teams = out('teams'), fixtures = out('fixtures');
const table = out('table'), results = out('results'), sim = out('sim');

// ── 1. 名冊與兩份來源的隊名 ─────────────────────────
{
  const codes = T.list.map(t => t.code);
  check('隊碼唯一', new Set(codes).size === codes.length);
  check('openfootball 隊名唯一', new Set(T.list.map(t => t.of)).size === T.list.length);
  /* fd 允許 null(沒觀察到的不准憑印象填),但填了的必須唯一 */
  const fds = T.list.map(t => t.fd).filter(Boolean);
  check('football-data.co.uk 簡稱唯一', new Set(fds).size === fds.length);

  /* 跟英超名冊共用的隊碼必須是**同一支球隊** —— 不同球隊撞同一個碼的話,
     盃賽與歐冠那些跨聯賽的頁面會把兩隊的資料混在一起。 */
  const pl = loadTeams(ROOT);
  const clash = T.list.filter(t => {
    const other = pl.byCode.get(t.code);
    return other && T.looseKey(other.of ?? other.en) !== T.looseKey(t.of);
  });
  check('跟英超共用的隊碼指的是同一支球隊', clash.length === 0, clash.map(t => `${t.code} ${t.of}`).join('、'));

  /* 漏一支球隊 = 那一季少算一批比賽,而畫面上完全看不出來(英冠踩過:14 支靜靜對不上)。 */
  const ofMap = new Map(T.list.map(t => [t.of, t.code]));
  const fdMap = new Map(T.list.filter(t => t.fd).map(t => [t.fd, t.code]));
  const missing = [];
  for (const s of SEASONS) {
    for (const m of ofRaw(s).matches) for (const n of [m.team1, m.team2]) if (!ofMap.has(n)) missing.push(`${s} of:${n}`);
    if (!hasFd(s)) continue;
    const rows = fdRaw(s).trim().split(/\r?\n/);
    const h = rows[0].split(',');
    const [iH, iA] = ['HomeTeam', 'AwayTeam'].map(k => h.indexOf(k));
    for (const l of rows.slice(1)) {
      const c = l.split(',');
      for (const n of [c[iH], c[iA]]) if (n && !fdMap.has(n)) missing.push(`${s} fd:${n}`);
    }
  }
  check('兩份來源的每個隊名都對得上名冊', missing.length === 0, [...new Set(missing)].join('、'));
}

// ── 2. 兩份來源逐場核對(鐵則五)────────────────────
{
  /* 有 D1 的季逐場比比分。**沒有 D1 的季不是失敗** —— 沙箱出不去,
     runner 上跑 `de1:fetch` 才會有。所以這裡只驗「有的那幾季全對」,
     並且要求 meta 把哪幾季有、哪幾季沒有照實記下來。 */
  const ofMap = new Map(T.list.map(t => [t.of, t.code]));
  const fdMap = new Map(T.list.filter(t => t.fd).map(t => [t.fd, t.code]));
  let compared = 0; const bad = [];
  for (const s of SEASONS) {
    if (!hasFd(s)) continue;
    const theirs = new Map();
    const rows = fdRaw(s).trim().split(/\r?\n/);
    const h = rows[0].split(',');
    const idx = k => h.indexOf(k);
    for (const l of rows.slice(1)) {
      const c = l.split(',');
      const [H, A, hg, ag] = [fdMap.get(c[idx('HomeTeam')]), fdMap.get(c[idx('AwayTeam')]), c[idx('FTHG')], c[idx('FTAG')]];
      if (!H || !A || hg === '' || hg == null) continue;
      theirs.set(`${H}|${A}`, [Number(hg), Number(ag)]);
    }
    for (const m of ofRaw(s).matches) {
      const ft = Array.isArray(m.score) ? m.score : m.score?.ft;   // 0:0 收場寫成陣列,兩種都要讀
      if (!ft) continue;
      const key = `${ofMap.get(m.team1)}|${ofMap.get(m.team2)}`;
      const t = theirs.get(key);
      if (!t) continue;
      compared++;
      if (t[0] !== ft[0] || t[1] !== ft[1]) bad.push(`${s} ${key} ${ft.join('-')}≠${t.join('-')}`);
    }
  }
  check('兩個獨立來源的重疊場次比分一致', bad.length === 0 && compared > 0,
    `${compared} 場、不符 ${bad.length}${bad.length ? ':' + bad.slice(0, 3).join('、') : ''}`);

  /* 把關強度不一樣就要講在畫面上(鐵則四)。 */
  const cov = meta.sourceCoverage ?? [];
  check('meta 逐季記下第二來源有沒有', cov.length === SEASONS.length
    && cov.every(c => typeof c.footballData === 'boolean' && c.openfootball === true));
  check('沒有第二來源的季有在資料界線裡講出來',
    cov.every(c => c.footballData) || (meta.boundaries ?? []).some(x => /只有部分賽季|單一來源|還沒抓到/.test(x)));
}

// ── 3. 產物的欄位名要跟既有聯賽一致 ─────────────────
{
  /* 這一節守的正是這一輪犯的錯:漏一個欄位,前端印 undefined 或整頁 TypeError,
     而所有測試都是綠的。**比對對象是英冠** —— 它跟德甲的能力範圍最接近。 */
  const m2 = en2('meta');
  const metaKeys = ['currentSeason', 'lastSeason', 'historySeasons', 'sources', 'model', 'counts', 'competition', 'capabilities'];
  check('meta 的關鍵欄位名跟英冠一致', metaKeys.every(k => k in meta && k in m2),
    metaKeys.filter(k => !(k in meta)).join('、'));
  check('meta.sources 用 name / url(頁尾靠這兩個)',
    meta.sources.every(s => typeof s.name === 'string' && typeof s.url === 'string'));
  check('meta 沒有設 edition(設了會被前端當成西甲)', !('edition' in meta));

  /* 球隊頁的總覽說明直接寫 `meta.model.simulationRuns.toLocaleString()` ——
     少了它整頁 TypeError,畫面只剩一行字。其餘幾個是對戰模擬頁要的。 */
  const modelKeys = ['type', 'caveats', 'backtest', 'sim', 'homeAdvantage', 'rho', 'decayXi', 'simulationRuns'];
  check('meta.model 的欄位名跟英冠一致', modelKeys.every(k => k in meta.model && k in m2.model),
    modelKeys.filter(k => !(k in meta.model)).join('、'));
  check('simulationRuns 是數字(前端會呼叫 toLocaleString)', typeof meta.model.simulationRuns === 'number');
  /* 對戰模擬頁在瀏覽器裡自己算,參數全靠這一包 —— 少一個欄位那一頁就算出別的數字。 */
  check('meta.model.sim 帶 Poisson 與 Elo 兩組參數',
    ['base', 'homeAdv', 'rho', 'maxGoals', 'teams', 'elo'].every(k => k in (meta.model.sim ?? {}))
    && Object.keys(meta.model.sim.teams).length === meta.competition.teams);

  const rep = out('reports');
  check('reports 的形狀跟英冠一致(seasons / count / reports)',
    ['seasons', 'count', 'reports'].every(k => k in rep && k in en2('reports')));

  /* 前端沒有任何 Markdown 處理器,`**強調**` 會原樣印出兩顆星號。
     掃**整份 meta** —— 第一版只掃 caveats,而星號就在 intro 與 boundaries 裡。 */
  const stars = [];
  (function walk(v, path) {
    if (typeof v === 'string') { if (/\*\*[^*]+\*\*/.test(v)) stars.push(path); }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
  })(meta, 'meta');
  check('meta 裡沒有 Markdown 強調(前端不處理 Markdown)', stars.length === 0, stars.join('、'));
}

// ── 4. 球員層:有就要對得起來,沒有就要講對原因 ─────────────
{
  const players = out('players'), leaders = out('leaders');
  const has = players.length > 0;
  if (has) {
    /* 球員層走 Understat,**形狀逐欄位跟西甲一致** —— 前端的球員頁是看
       `leaders.source` 分岔的,自己取形狀的話會變成「有資料但前端讀不到」
       (第一版就是這樣:boards 依賽季分組、source 寫小寫,榜整個畫不出來)。 */
    const l2 = es1('leaders');
    const miss = Object.keys(l2).filter(k => !(k in leaders));
    check('leaders 的欄位跟西甲一致(前端看 source 分岔,形狀不能自己取)', miss.length === 0, miss.join('、'));
    check('leaders.source 是 Understat(大小寫要跟前端的判斷一致)', leaders.source === 'Understat');
    check('boards 是「榜的定義」陣列,不是依賽季分組的物件', Array.isArray(leaders.boards));
    check('上季的榜真的有人', (leaders.last?.scorers ?? []).length > 0,
      `射手榜 ${(leaders.last?.scorers ?? []).length} 人`);

    /* **隊名對照的獨立核對要進產物。** alias 是一對一推出來的,而一對一不是證據
       (租借姓名那條坑付過代價)。這裡守的是「核對做了、而且沒有可疑的隊」。 */
    check('隊名對照的核對結果有進產物', Array.isArray(leaders.nameCheck) && leaders.nameCheck.length > 0,
      `${leaders.nameCheck?.length ?? 0} 筆`);
    const suspicious = (leaders.nameCheck ?? []).filter(x => (x.goalRatio != null && x.goalRatio > 1.02)
      || (x.minutesRatio ?? 1) < 0.85
      || (x.played >= 10 && x.goalRatio != null && x.goalRatio < 0.7));
    check('沒有任何一隊的進球或分鐘對不上(對錯隊的話一定會露出來)', suspicious.length === 0,
      suspicious.map(x => `${x.season} ${x.code} 進球比 ${x.goalRatio}、分鐘比 ${x.minutesRatio}`).join('、'));
    /* 分鐘是最硬的一條:一隊一季最多 11 × 90 × 場數,對錯隊不可能還落在上限附近。 */
    const worstMin = Math.min(...(leaders.nameCheck ?? []).map(x => x.minutesRatio ?? 1));
    check('每一隊的出賽分鐘都接近理論上限(這是隊名對照最硬的證據)', worstMin >= 0.9, `最低 ${worstMin}`);

    /* 有了一部分之後最容易忘記講剩下的沒有 —— 德甲連西甲那層 SportMonks 都沒有。 */
    check('明講這一層沒有背號 / 頭貼 / 傷停', Array.isArray(leaders.missing) && leaders.missing.length >= 3
      && /背號/.test(leaders.missing.join('')) && /傷停/.test(leaders.missing.join('')));
    check('沒有 SportMonks 那一層(德甲沒有身分欄位來源)', Object.keys(leaders.sportmonks ?? {}).length === 0);
    check('年齡全是 null,而且涵蓋率照實寫出來(不是假裝有)',
      players.every(p => p.age == null)
      && Object.values(leaders.ageCoverage ?? {}).every(c => c.known === 0 && c.total > 0));
    /* 前端的來源那一句要從資料判斷 —— 寫死的話德甲會印一個它沒用的來源 */
    check('球員頁的來源文案由資料決定,不寫死 SportMonks', (() => {
      const src = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-players.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return /const hasSm = /.test(src) && !/資料來源 Understat \+ SportMonks/.test(src);
    })());
    check('季中轉隊的人不掛到單一球隊(整季合計掛上去就是編數字)',
      players.filter(p => p.multiTeam).every(p => (p.teams ?? []).length > 1));

    /* **開了球員頁就一定要有 players-core**:跨聯賽搜尋是看 open 有沒有 players
       才去要它的,沒寫就是一個保證 404,而畫面只是「搜尋德甲球員什麼都搜不到」。 */
    const core = out('players-core');
    check('有 players-core(跨聯賽搜尋靠它,開了球員頁卻不寫就是保證 404)',
      Array.isArray(core) && core.length > 0, `${core?.length ?? 0} 筆`);
    /* 聯賽代碼**必須是自己**。原本 coreFromUnderstat 寫死 'es1',德甲照用的話
       每一筆都掛西甲的標籤、點下去跳去西甲找一個不存在的人,而畫面完全正常。 */
    check('players-core 的 league 是 de1,不是沿用西甲的寫死值',
      core.every(r => r.league === 'de1'), [...new Set(core.map(r => r.league))].join(','));
    check('身價與傷停是 null 不是 0(Understat 沒有這兩樣)',
      core.every(r => r.price === null && r.status === null));
  }
  check('球員產物與 meta 說的一致(有就是有、沒有就是沒有)',
    has === (meta.capabilities?.players === true) && has === (meta.players?.available === true)
    && has === (leaders.available === true));
  if (!has) {
    /* **不可以抄英冠那句「來源就是沒有」** —— 德甲是五大聯賽,Understat 有它。
       講成「做不到」等於暗示以後也不會有,而我們知道會有。 */
    const note = meta.players?.note ?? '';
    check('沒有球員層時講的是「還沒抓」而不是「沒有來源」',
      /Understat/.test(note) && /還沒|沙箱|runner/.test(note) && !/不涵蓋德甲|沒有免費/.test(note), note.slice(0, 40));
  }
  /* 缺的東西要 null 不要 0 —— 0 看起來像「量到了,結果是零」。 */
  check('球隊的陣容人數是 null 不是 0', teams.every(t => t.squadSize === null));
  check('隊徽還沒交付時是 null,不放一個灰底佔位圖', teams.every(t => t.crest === null || typeof t.crest === 'string'));
  check('counts.crests 對得回實際有隊徽的隊數',
    meta.counts.crests === teams.filter(t => t.crest).length);
  check('資料界線有講出球員層的狀態', (meta.boundaries ?? []).some(x => /球員/.test(x)));
}

// ── 5. 模擬的分界線要對得上德甲 ───────────────────────
{
  /* 德甲的升降級附加賽是「德甲第 16 名 vs 德乙第 3 名」——**跨聯賽**。
     本站沒有德乙的資料,評不出對手強度(鐵則二),所以不准編一個附加賽機率出來。
     英冠的 promotionPct 是聯賽內四隊互打,語意完全不同,抄過來就是假數字。 */
  check('模擬沒有直升欄位(德甲的附加賽是跨聯賽的)', sim.every(r => !('promotionPct' in r)));
  check('模擬有冠軍 / 前四 / 降級三種機率',
    sim.every(r => ['titlePct', 'top4Pct', 'relegationPct'].every(k => typeof r[k] === 'number')));
  const sumTitle = sim.reduce((a, r) => a + r.titlePct, 0);
  check('奪冠機率加總約 100%', Math.abs(sumTitle - 100) < 1.5, sumTitle.toFixed(1));
  check('資料界線講出德甲的升降級規則(讀者不會自己知道)',
    (meta.boundaries ?? []).some(x => /附加賽/.test(x) && /德乙/.test(x)));
  /* 沒宣告 promotion 的聯賽不可以多出這個欄位 —— 共用的 simulateSeason 要真的靠參數分岔 */
  const plain = simulateSeason({
    model: { attack: { A: 0, B: 0 }, defence: { A: 0, B: 0 }, gamma: 0.2, rho: -0.1, mu: 0 },
    fixtures: [], codes: ['A', 'B'], played: [], runs: 10,
  });
  check('沒宣告 promotion 的聯賽不會多出直升欄位', plain.every(r => !('promotionPct' in r)));
}

// ── 6. 賽程、機率與回測 ────────────────────────────
{
  const comp = meta.competition;
  check('賽程場數等於 18 隊雙循環(306 場)', fixtures.length === comp.teams * (comp.teams - 1),
    `${fixtures.length} 場、${comp.teams} 隊`);
  check('未賽場次的三向機率加總約等於 1',
    fixtures.filter(f => !f.played).every(f => f.prediction
      && Math.abs(f.prediction.home + f.prediction.draw + f.prediction.away - 1) < 0.002));
  check('已完賽場次不拿重擬合機率冒充賽前預測',
    fixtures.filter(f => f.played).every(f => f.prediction === null));
  check('賽果只收已完賽的場次', results.every(m => m.played) && results.length > 0, `${results.length} 場`);
  check('積分榜的隊數對得上名冊', table.current.length === comp.teams && table.last.length === comp.teams);

  const bt = meta.model.backtest;
  if (bt?.available) {
    /* 回測要贏過基準線,而且**驗收季不可以是訓練季**(同一批資料又調又驗,挑出來的是雜訊)。 */
    check('走查回測贏過基準線', bt.rps < bt.baselineRps, `${bt.rps} < ${bt.baselineRps}`);
    check('回測驗收季不等於訓練季', !bt.trainSeasons.includes(bt.season),
      `${bt.trainSeasons.join('+')} → ${bt.season}`);
    /* 母體釘的是「完整一季」這個性質,不是一個會隨資料變的數字 */
    check('回測母體是完整一季', bt.games === comp.teams * (comp.teams - 1), String(bt.games));
    check('回測數字是扁平欄位(前端讀 rps / baselineRps,不是 models 物件)',
      typeof bt.rps === 'number' && typeof bt.baselineRps === 'number' && typeof bt.hitRate === 'number');
  } else {
    check('沒有回測就不給準度數字', bt.available === false && !('rps' in bt));
  }
}

// ── 7. 單場分析頁要的檔案一份都不缺 ───────────────────
{
  /* 單場分析**不在導覽列的 open 清單裡,但它照樣進得來** —— 首頁的
     「接下來的比賽」每一場都連過去。少寫任何一份,讀者就撞上
     「載入失敗…請先執行 npm run build」(給開發者看的訊息,而且理由是錯的)。
     這一輪 analysis.json 就是漏掉的那一份:首頁 console 印 404、#app 只剩 93 個字元。 */
  const need = ['meta', 'clubs', 'teams', 'fixtures', 'table', 'sim', 'form', 'h2h', 'results',
    'news', 'analysis', 'prob-history', 'players', 'leaders', 'coaches', 'goals', 'experts',
    'official', 'live', 'reports', 'tactics', 'lineups', 'shapes'];
  const miss = need.filter(n => !existsSync(join(ROOT, 'web', 'data', 'leagues', 'de1', `${n}.json`)));
  check('前端會讀的資料集一份都不缺', miss.length === 0, miss.join('、'));

  /* **檔案在還不夠,形狀也要對。** 第一版只驗「檔案在」,於是 `goals.seasons` 給了物件
     (既有聯賽是陣列)→ 球隊頁 `(goals?.seasons ?? []).filter` 直接 TypeError、整頁載入失敗,
     而這一節是綠的。逐欄位跟英冠比容器型別(陣列 / 物件 / 純量),
     值是 null 的不算差異 —— null 就是「這個聯賽沒有」。 */
  {
    const kind = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    const bad = [];
    for (const n of need) {
      /* `leaders` 刻意不跟英冠比:**本站有兩種合法的球員層**,英冠是逐場累加
         (`match-aggregate`)、德甲跟西甲是 Understat 整季彙總,兩者形狀本來就不同,
         前端也是看 `leaders.source` 分岔的。德甲那一份改跟**西甲**比,在下一節。 */
      if (n === 'leaders') continue;
      let a, b;
      try { a = en2(n); b = out(n); } catch { continue; }          // 英冠沒有的就不比
      if (kind(a) !== kind(b)) { bad.push(`${n}(整份 ${kind(a)} vs ${kind(b)})`); continue; }
      if (kind(a) !== 'object') continue;
      for (const k of Object.keys(a)) {
        /* assets 是 `npm run build` 最後那一步(stamp-assets)寫的,不是各聯賽的 build ——
           照建置順序它一定會有,但單獨跑 `de1:build` 之後這裡不該紅。
           戳對不對得回檔案內容由 `test.mjs` 專門一節守著。 */
        if (n === 'meta' && k === 'assets') continue;
        if (!(k in b)) { bad.push(`${n}.${k} 缺`); continue; }
        // null 代表「這個聯賽沒有」,不算型別不符;容器型別不同才是
        if (kind(a[k]) === 'null' || kind(b[k]) === 'null') continue;
        if (kind(a[k]) !== kind(b[k])) bad.push(`${n}.${k}(${kind(a[k])} vs ${kind(b[k])})`);
      }
    }
    check('空產物的形狀跟英冠一致(不只是檔案在)', bad.length === 0, bad.slice(0, 6).join('、'));
  }

  /* **live.matches 是陣列,official / experts 的 matches 是物件。**
     同一個名字兩種型別,照著別的檔案抄很容易抄反。 */
  check('live.matches 是陣列(跟英冠同型別)', Array.isArray(out('live').matches));
  /* 既有聯賽的 official 用的是 `matches`(物件),**沒有 seasons 這個鍵** ——
     第一版我照別的產物抄成 seasons,測試綠而形狀是錯的。 */
  check('official.matches 是物件(跟英冠同型別)', out('official').matches && !Array.isArray(out('official').matches));
  check('analysis 有 enabled / pre / post(空的也要有形狀)', (() => {
    const an = out('analysis');
    return typeof an.enabled === 'boolean' && an.pre && an.post && typeof an.counts?.pre === 'number';
  })());
  /* 這幾份沒有內容的一律帶 available:false 與一句為什麼 —— 空殼不解釋等於看起來壞掉 */
  for (const n of ['leaders', 'coaches', 'goals', 'experts', 'official', 'live']) {
    const o = out(n);
    if (o.available === false) check(`${n} 沒有內容時講得出原因`, typeof o.note === 'string' && o.note.length > 5);
  }
}

// ── 8. 開賽時間的時區(Europe/Berlin)──────────────────
{
  /* 德國夏令 CEST(+02:00)、冬令 CET(+01:00)。adapter 的預設固定補 +01:00 ——
     照用的話夏季場次整批晚一小時,而畫面完全正常。 */
  const offsets = new Set(fixtures.filter(f => f.kickoff).map(f => f.kickoff.slice(-6)));
  check('開賽時間只出現柏林的兩種偏移', [...offsets].every(o => o === '+01:00' || o === '+02:00'),
    [...offsets].join('、'));
  const summer = fixtures.filter(f => f.kickoff && /-(0[5-9])-/.test(f.date));
  check('夏季場次用 CEST(+02:00)', summer.length > 0 && summer.every(f => f.kickoff.endsWith('+02:00')),
    `${summer.length} 場、樣本 ${summer[0]?.kickoff ?? '—'}`);

  /* 冬季場次**現在還沒有開球時間** —— 上游是逐月公布的。
     所以直接驗換算函式本身,不去等資料出現(等資料的斷言在它出現那天才第一次跑到)。 */
  const k = europeanKickoff({ summer: '+02:00', winter: '+01:00' });
  check('換算函式:十二月是 CET', k({ date: '2026-12-12', time: '15:30' }).endsWith('+01:00'));
  check('換算函式:七月是 CEST', k({ date: '2027-07-12', time: '15:30' }).endsWith('+02:00'));
  /* 換季當週最容易錯:2027 年 3 月最後一個週日是 28 號 */
  check('換算函式:3/27 還是 CET、3/28 起是 CEST',
    k({ date: '2027-03-27', time: '15:30' }).endsWith('+01:00')
    && k({ date: '2027-03-28', time: '15:30' }).endsWith('+02:00'));
  check('沒有開球時間的場次 kickoff 是 null(不編一個時間出來)',
    fixtures.every(f => f.kickoff === null || typeof f.kickoff === 'string'));
}

// ── 9. 補比分:拒收要留下紀錄 ─────────────────────────
{
  /* 「一場對不上就整份不採用」是對的,但拒收之後產物裡要留得下紀錄 ——
     不然畫面上踢完的比賽還寫「未賽」而沒有人解釋得出為什麼(站上踩過)。 */
  check('拒收紀錄有進產物(空陣列 = 沒有拒收過)',
    Array.isArray(meta.scoreRefusals) && Array.isArray(meta.model.scoreCheck?.refused));
  check('meta.model.scoreCheck 跟 meta.scoreRefusals 是同一份',
    meta.model.scoreCheck.refused.length === meta.scoreRefusals.length);
  if (meta.scoreRefusals.length) {
    check('每一筆拒收都講得出是哪一季、哪個來源、幾場',
      meta.scoreRefusals.every(r => r.season && r.source && typeof r.count === 'number'));
  }
}

// ── 10. 比賽層:逐場統計與賽後報告(FotMob)──────────────
{
  /* raw 由 runner 抓(沙箱連不到 fotmob.com),所以本機可能一場都沒有 ——
     **那不是失敗**。這一節分兩半:沒有資料時守「講的是還沒抓、不是沒有來源」,
     有資料時才逐條驗內容。斷言只能守本站自己算的東西(上游時差不是 bug)。 */
  const rep = out('reports');
  const msPath = join(ROOT, 'web', 'data', 'leagues', 'de1', 'matchstats.json');
  if (!rep.count) {
    check('沒有賽後報告時講的是「還沒抓」而不是「沒有來源」',
      rep.blocked?.reason === 'not-fetched' && !/沒有.*資料源|no-source/.test(JSON.stringify(rep.blocked)),
      rep.blocked?.reason ?? '—');
    check('資料界線也照這樣講(來源在,只是還沒抓)',
      (meta.boundaries ?? []).some(x => /還沒有賽後報告/.test(x) && /還沒抓/.test(x)));
  } else {
    check('德甲有 matchstats.json(FotMob 逐場統計)', existsSync(msPath));
    const ms = JSON.parse(readFileSync(msPath, 'utf8'));
    const byKey = new Map(fixtures.filter(f => f.played).map(f => [`${f.season}|${f.home}|${f.away}`, f]));
    const cur = Object.values(ms.matches).filter(m => byKey.has(m.key));
    check('逐場統計:每一場的比分等於本站賽果', cur.length > 0 && cur.every(m => {
      const f = byKey.get(m.key); return m.score[0] === f.fh && m.score[1] === f.fa;
    }), `${cur.length} 場`);
    check('逐場統計:每場控球率相加 100',
      Object.values(ms.matches).every(m => m.possession.all[0] + m.possession.all[1] === 100));
    check('逐場統計:控球率沒有第二來源,verified 是 false',
      Object.values(ms.teams).every(t => t.verified === false));

    const played = fixtures.filter(f => f.played);
    const withStats = played.filter(f => ms.matches[`${f.season}|${f.home}|${f.away}`]);
    check('賽後報告:有逐場資料的場次每一場都有報告',
      rep.count === withStats.length && withStats.every(f => rep.reports[`${f.season}|${f.home}|${f.away}`]),
      `${rep.count} / ${withStats.length}`);
    check('賽後報告:來源 fotmob、blocked 是 null(不能再說沒有資料源)',
      rep.source === 'fotmob' && rep.blocked === null);
    const all = Object.values(rep.reports);
    check('賽後報告:比分等於賽果、雙方先發 11 人、有正式陣型', all.every(r => {
      const f = byKey.get(`${r.season}|${r.home}|${r.away}`);
      const H = r.sides[r.home], A = r.sides[r.away];
      return f && r.hs === f.fh && r.as === f.fa && H.xi.length === 11 && A.xi.length === 11
        && H.shape.label !== '—' && A.shape.label !== '—';
    }));
    /* 烏龍球沒有射手,不會進 sides.goals;所以是「射手進球 + 烏龍球 = 比分」。
       事件的 team 已在 canonical 翻成得分方(FotMob 的 team 是踢進自家門那一隊)。 */
    const ogOf = (r, side) => (r.advanced?.events ?? []).filter(e => e.ownGoal && e.team === side).length;
    check('賽後報告:射手進球加烏龍球等於比分(兩隊各自)',
      all.every(r => r.sides[r.home].goals + ogOf(r, r.home) === r.hs
        && r.sides[r.away].goals + ogOf(r, r.away) === r.as));
    check('賽後報告:advanced 五種 coverage 齊全、有逐射門與控球', all.every(r => {
      const c = r.advanced.coverage;
      return c.teamStatistics && c.playerStatistics && c.ratings && c.events && c.lineups
        && Array.isArray(r.advanced.shots) && Array.isArray(r.advanced.possession?.all);
    }));
    /* 接上之後那句「本站沒有烏龍球來源可以證明」就過期了 —— 它必須自己消失,
       不能靠人記得回來刪(同一支 build 裡寫死那句話的教訓)。 */
    check('資料界線不再說「還沒抓德甲的逐場事件」(接上之後那句是假的)',
      !(meta.boundaries ?? []).some(x => /還沒抓德甲的逐場事件/.test(x)));
    check('meta.capabilities.lineups 跟著賽後報告走', meta.capabilities.lineups === true);
  }
}

if (process.exitCode) throw new Error('德甲自我檢查失敗');
console.log('  德甲全部通過');
