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
  intlStandings, intlLagCost, intlH2H, pairKey, makeVenueModel, venueProbs, venueBacktest, venueGroup, testExpect,
} from './lib/intl.mjs';
import { loadIntlTeamTable, makeIntlResolver, intlFlagPlan, flagDistance, FLAG_SAME } from './lib/intl-teams.mjs';
import { decodePNG } from './lib/png.mjs';
import { imageBytes } from './lib/image-files.mjs';
import { FOTMOB_INTL, INTL_FAMILIES, INTL_LEGEND_ZH, isIntlTbd, normalizeIntlTable, intlGroupZh } from './lib/adapters/fotmob-intl.mjs';
import { fetchIntl, INTL_SCHEMA_VERSION } from './fetch-intl-fotmob.mjs';

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
const TEAMS_PRODUCT = join(ROOT, 'web', 'data', 'intl-teams.json');
const DT = existsSync(TEAMS_PRODUCT) ? JSON.parse(readFileSync(TEAMS_PRODUCT, 'utf8')) : null;

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

    /* 評分落後的代價(2026-09-25 量的):沒大過兩倍標準誤,所以**不做暫定更新** —— 評分必須跟
       「只用 martj42 走一次」逐隊一模一樣。哪天有人把 FotMob 還沒被核對的賽果塞進評分,這條會紅;
       要那樣做,得先讓 lag.passes 變成 true(量出來值得),再改這條。 */
    const lg = D.model.lag;
    check('產物帶著「評分落後的代價」,而且判決跟它自己印的數字一致',
      lg?.affected && lg.all && lg.days > 0 && lg.passes === (lg.affected.cost > 2 * lg.affected.se),
      lg?.affected ? `${lg.days} 天:受影響 ${lg.affected.n} 場 ${lg.affected.cost} ± ${lg.affected.se}` : '—');
    const re = intlLagCost(mj, P, { from: INTL_HOLDOUT.from, minGames: D.model.minGames, days: lg?.days ?? 7 });
    check('落後的代價重算一次對得回產物', re && lg && re.affected.n === lg.affected.n && Math.abs(re.affected.cost - lg.affected.cost) < 1e-4);
    const { rating } = runIntlElo(mj, P);
    const drift = Object.entries(D.teams).filter(([k, t]) => t.rating != null && t.rating !== Math.round(rating.get(k)));
    check('沒有暫定更新:每一隊的評分都等於只用 martj42 算的那一份', lg?.passes || drift.length === 0,
      drift.slice(0, 3).map(([k]) => k).join('、'));
    check('評分截止日就是 martj42 的最後一天', D.model.ratingsAsOf === mj.at(-1)?.date);

    /* 排名只列國際足總會員(2026-09-25):第一版把澤西島排到第 37、北賽普勒斯第 54。
       會員用「踢過世界盃(含資格賽)」認 —— 只有會員能報名,資料本身證明得了。 */
    const members = new Set(mj.filter(m => m.tournament === 'FIFA World Cup' || m.tournament === 'FIFA World Cup qualification').flatMap(m => [m.home, m.away]));
    const notMember = D.ranking.filter(r => !members.has(r.key));
    check('排名只列踢過世界盃(含資格賽)的隊', notMember.length === 0, notMember.slice(0, 5).map(r => r.key).join('、'));
    const nm = D.nonMembers ?? [];
    check('不列排名的非會員都講得出來,而且真的不在排名裡',
      nm.length > 0 && nm.every(x => !members.has(x.key) && !D.ranking.some(r => r.key === x.key) && D.teams[x.key]?.rank == null),
      `${nm.length} 隊`);
    check('非會員分兩種,判準跟它自己印的數字一致(兩年內一半以上對會員踢 = 接得上)',
      nm.every(x => x.linked === (x.n > 0 && x.vsMembers / x.n >= 0.5)));
    /* 回歸:第一版上線時的那幾隊。資料裡有它們才驗(martj42 哪天改名就跳過,不當紅線)。
       **這一條被上一條蘊含**(它們都沒踢過世界盃資格賽),所以它不會單獨紅 —— 留著是因為它把「第一版錯成什麼樣」寫在這裡 */
    const was = ['Jersey', 'Northern Cyprus', 'Isle of Man'].filter(k => rating.has(k));
    check('澤西島、北賽普勒斯、曼島不在排名裡(第一版的 bug)', was.every(k => !D.ranking.some(r => r.key === k)), was.join('、') || '資料裡沒有,略過');
    check('俄羅斯(被禁賽、只踢友誼賽)仍在排名裡 —— 用「兩年內踢過正式賽」當門檻會把它錯排掉',
      !rating.has('Russia') || !(D.teams.Russia) || D.ranking.some(r => r.key === 'Russia') || (D.teams.Russia.games < D.model.minGames));
  }
}

// ── 2b. 中立場的賽前推論(2026-09-25)──────────────────────
/* FotMob 的賽程沒有「是不是中立場」。第一版一律當主場;現在用開賽前 lag 天以前的 martj42 推一個機率 q,
   調參期挑參數、驗收期驗,**建置每次重算、過門檻才用**。這一節守:推論不偷看、主辦國的判斷、
   q = 0 時跟第一版逐位元組相同、產物的每一場重算得回來、賽事對照表的名字真的被 expect 認得。 */
console.log('\n▶ 國家隊:中立場的賽前推論(只看開賽前、驗收過才用)');
{
  const P = params.params;
  const prior = { competitive: 0.1, friendly: 0.3, other: 0.6, finals: 0.8 };
  const V = { N: 5, alpha: 8, W: 40, lag: 7, prior };
  const g = (date, home, away, tournament, neutral) => ({ date, home, away, fh: 1, fa: 0, tournament, neutral });
  const UNL = 'UEFA Nations League';
  // A 最近五場主場(歐國聯)都在中立場;查 2026-02-01 那一場
  const base = [1, 2, 3, 4, 5].map(i => g(`2026-01-0${i}`, 'A', `X${i}`, UNL, true));
  const q0 = makeVenueModel(base, V)({ home: 'A', tournament: UNL, date: '2026-02-01' });
  check('主客場型:主隊最近 N 場同類的主場有幾場在中立場,往先驗收縮', q0.basis === 'team' && q0.n === 5 && q0.k === 5
    && Math.abs(q0.q - (5 + 8 * 0.1) / 13) < 1e-12, JSON.stringify(q0));
  // 開賽前 lag 天之內的比賽不能用(上線時 martj42 還沒收)—— 那一場是非中立場,用了的話 q 會掉
  const late = [...base, g('2026-01-28', 'A', 'Y', UNL, false)];
  const q1 = makeVenueModel(late, V)({ home: 'A', tournament: UNL, date: '2026-02-01' });
  check('不偷看:開賽前 lag 天之內的比賽不影響推論', q1.q === q0.q && q1.n === q0.n, JSON.stringify(q1));
  // 別類的主場不算(友誼賽在中立場踢,不代表資格賽也是)
  const other = [...base, g('2026-01-10', 'A', 'Z', 'Friendly', false)];
  const q2 = makeVenueModel(other, V)({ home: 'A', tournament: UNL, date: '2026-02-01' });
  check('只看同一類的主場', q2.q === q0.q && q2.n === 5);
  const qNew = makeVenueModel(base, V)({ home: 'NEW', tournament: UNL, date: '2026-02-01' });
  check('沒有主場紀錄的隊用這一類的先驗', qNew.n === 0 && qNew.q === 0.1);
  // 主辦型:同一屆(W 天內)已踢的比賽一半以上在中立場 → 有主辦國;主辦國自己踢 q = 0
  const GULF = 'Gulf Cup';
  const ed = [g('2026-03-01', 'H', 'B', GULF, false), g('2026-03-01', 'C', 'D', GULF, true), g('2026-03-02', 'E', 'F', GULF, true), g('2026-03-02', 'B', 'C', GULF, true)];
  const vm = makeVenueModel(ed, V);
  const host = vm({ home: 'H', tournament: GULF, date: '2026-03-12' }), guest = vm({ home: 'D', tournament: GULF, date: '2026-03-12' });
  check('主辦型:主辦國踢主場 q = 0', host.basis === 'host' && host.q === 0, JSON.stringify(host));
  check('主辦型:其他隊照這一屆的中立比例(加一平滑)', guest.basis === 'edition' && Math.abs(guest.q - (3 + 1) / (4 + 2)) < 1e-12, JSON.stringify(guest));
  const early = vm({ home: 'D', tournament: GULF, date: '2026-03-05' });
  check('主辦型:同一屆的比賽還在 lag 天之內 → 用先驗', early.basis === 'prior' && early.q === 0.6);
  // 機率:q = 0 跟第一版**逐位元組**相同、q = 1 就是中立場、中間是兩者加權
  const ps = [[1600, 1500], [1500, 1700], [1500, 1500]].map(([rh, ra]) => ({
    h0: venueProbs(rh, ra, 0, P), old: probsFromE(expectedScore(rh, ra, { neutral: false, homeAdv: P.homeAdv }), P),
    h1: venueProbs(rh, ra, 1, P), neu: probsFromE(expectedScore(rh, ra, { neutral: true, homeAdv: P.homeAdv }), P),
    mid: venueProbs(rh, ra, 0.37, P) }));
  check('q = 0 時勝率跟第一版逐位元組相同', ps.every(x => JSON.stringify(x.h0) === JSON.stringify(x.old)));
  check('q = 1 時就是中立場的算法', ps.every(x => ['home', 'draw', 'away'].every(k => Math.abs(x.h1[k] - x.neu[k]) < 1e-15)));
  check('中間的 q:三個機率加起來是 1,而且主勝落在兩種場地之間', ps.every(x => Math.abs(x.mid.home + x.mid.draw + x.mid.away - 1) < 1e-12
    && x.mid.home <= Math.max(x.old.home, x.neu.home) + 1e-15 && x.mid.home >= Math.min(x.old.home, x.neu.home) - 1e-15));

  // 賽事對照表:推論靠 `tournament` 找同一類與同一屆 —— 名字要是 martj42 真的在用、而且被這個賽事的 expect 認得
  const names = new Set(mj.map(m => m.tournament));
  const badT = FOTMOB_INTL.filter(c => !c.tournament || !testExpect(c.expect, c.tournament) || (mj.length && !names.has(c.tournament)));
  check('每個賽事的 martj42 名字都被自己的 expect 認得、而且資料裡真的有', badT.length === 0, badT.map(c => c.key).join('、'));
  check('分類:國家聯賽與資格賽是主客場型、海灣盃是主辦型、友誼賽自成一類',
    FOTMOB_INTL.every(c => venueGroup(c.tournament) === ({ gulf: 'other', friendly: 'friendly' }[c.key] ?? 'competitive')));

  const VP = params.venue;
  check('參數檔有中立場推論的參數,而且不在網格邊上', VP && VP.lag > 0 && VP.N > 0 && VP.alpha > 0 && Array.isArray(VP.tune?.edges) && VP.tune.edges.length === 0,
    VP ? `N=${VP.N} alpha=${VP.alpha} W=${VP.W} lag=${VP.lag}・邊上 ${(VP.tune?.edges ?? []).join('、') || '無'}` : '沒有 venue');
  check('推論的調參區間跟共用常數一致', VP?.tune?.from === INTL_TUNE.from && VP?.tune?.to === INTL_TUNE.to);
  if (D && VP && mj.length) {
    const vm2 = D.model.venue;
    const re = venueBacktest(mj, P, VP, { from: INTL_HOLDOUT.from, minGames: D.model.minGames });
    check('推論的驗收重算一次對得回產物', vm2?.holdout && re.inferred.n === vm2.holdout.n && Math.abs(re.inferred.gain - vm2.holdout.gain) < 1e-5
      && Math.abs(re.inferred.se - vm2.holdout.se) < 1e-5, re.inferred ? `${re.inferred.n} 場 ${re.inferred.gain.toFixed(5)} ± ${re.inferred.se.toFixed(5)}` : '—');
    check('產物的「推論通過」跟它自己印的改善與標準誤一致', vm2?.passes === intlPasses(vm2?.holdout));
    const withProb = D.fixtures.filter(f => f.prob);
    const off = withProb.filter(f => vm2.passes ? !f.venue : f.venue);
    check('推論通過就每一場都有 venue、沒通過就一場都沒有', off.length === 0, `${off.length} 場不符`);
    // 每一場的勝率重算得回來:同一個推論、同一條評分
    const { rating } = runIntlElo(mj, P);
    const guess = makeVenueModel(mj, VP);
    const TOUR = new Map(FOTMOB_INTL.map(c => [c.key, c.tournament]));
    const r4 = x => Math.round(x * 1e4) / 1e4;
    const wrong = withProb.filter(f => {
      const q = vm2.passes ? guess({ home: f.home.key, tournament: TOUR.get(f.comp), date: (f.kickoff ?? D.builtAt).slice(0, 10) }).q : 0;
      const p = venueProbs(rating.get(f.home.key), rating.get(f.away.key), q, P);
      return [p.home, p.draw, p.away].some((x, i) => r4(x) !== f.prob[i]) || (f.venue && Math.abs(f.venue.q - q) > 5e-4);
    });
    check('每一場給出去的勝率,拿同一個推論重算對得回來', withProb.length > 0 && wrong.length === 0,
      wrong.slice(0, 3).map(f => `${f.home.key}-${f.away.key}`).join('、') || `${withProb.length} 場`);
    const BASES = new Set(['team', 'prior', 'host', 'edition']);
    check('每一場的推論依據都是四種之一、q 在 0~1 之間', withProb.every(f => !f.venue || (BASES.has(f.venue.basis) && f.venue.q >= 0 && f.venue.q <= 1)));
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
    const keys = [...sides.map(t => t.key), ...D.ranking.map(r => r.key), ...(D.nonMembers ?? []).map(r => r.key),
      ...(D.standings ?? []).flatMap(st => st.groups.flatMap(g => g.rows.map(r => r.key)))].filter(Boolean);
    check('畫面會用到的每一隊都在隊伍字典裡(含積分榜與不列排名的非會員)', keys.every(k => D.teams[k]), keys.filter(k => !D.teams[k]).slice(0, 5).join('、'));
  }
}

// ── 5. 產物與頁面的約定 ──────────────────────────────
console.log('\n▶ 國家隊:產物與頁面的約定');
{
  check('產物存在(npm run build 會產生 web/data/intl.json)', Boolean(D));
  if (D) {
    const need = ['builtAt', 'model', 'sources', 'comps', 'families', 'notFetched', 'fixtures', 'results', 'ranking', 'teams', 'unknownNames',
      'standings', 'standingsCounts', 'nonMembers'];
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
  /* 球隊頁的明細(七百 KB)只在點進某一隊時才載 —— 放在頁面最上面一起載的話,每一個打開國家隊頁的人都要多下載一次 */
  const loads = [...page.matchAll(/loadFrom\('pl', \[([^\]]*)\]\)/g)].map(x => x[1]);
  const teamFn = /async function renderTeam\([\s\S]*?\n}\n/.exec(page)?.[0] ?? '';
  check('intl-teams 只在球隊頁載', loads.filter(x => x.includes('intl-teams')).length === 1 && /loadFrom\('pl', \['intl-teams'\]\)/.test(teamFn),
    `${loads.length} 處 loadFrom`);
  check('隊名連到球隊頁(C.link 帶 team)、頁面認得 ?team=', /C\.link\('intl', \{ team: key \}\)/.test(page) && /C\.qs\('team'\)/.test(page));
  check('積分榜的顏色由產物的語氣決定,不用上游的色碼', !/#2AD572|#FF4646|#FFA72F|#FFD908/i.test(page) && /TONE\[/.test(page));
}

// ── 5b. 分組積分榜 ──────────────────────────────────
console.log('\n▶ 國家隊:分組積分榜(本站用賽果算、逐隊跟上游核對)');
{
  /* 形狀照 probe-intl-tables run #45 實際看到的寫:table[0].data.tables[].table.all[],
     一列裡 scoresStr 是「進-失」,ongoing 不是 null 就是進行中的比賽已經被算進去了 */
  const upRow = (id, name, idx, [p, w, d, l], sc, pts, ongoing = null) => ({ name, id, idx, played: p, wins: w, draws: d, losses: l,
    scoresStr: sc, goalConDiff: 0, pts, deduction: null, ongoing });
  const table = rows => [{ data: { composite: true, tables: [{ leagueName: 'B Grp. 1', leagueId: 941122,
    legend: [{ tKey: 'promotion', title: 'Promotion', indices: [0] }, { tKey: 'relegation', title: 'Relegation', indices: [3] }],
    table: { all: rows, home: [], away: [] } }] } }];
  /* 本站的賽果(兩輪,四隊都 3 分):第 1 輪 1 勝 2、3 勝 4(**group 故意寫錯**);第 2 輪 2 勝 3、4 勝 1。
     另有三場不能算:三月的預賽(round 'final')、跟組外球隊踢的、正在踢的。
     四隊同分、淨勝球 2 > 1 > 3 > 4 —— 官方名次故意給 1、2、3、4(跟淨勝球不同),
     「一致的組照上游的名次排」才驗得出來(兩種排法結果一樣的話,排錯了也是綠的)。 */
  const fm = (id, h, a, final, round, group = '1') => ({ id, kickoff: '2026-09-24T19:00:00Z', home: { name: `T${h}`, fmId: String(h) }, away: { name: `T${a}`, fmId: String(a) },
    state: 'FT', final, round, group });
  const matches = [fm('m1', 1, 2, [1, 0], '1'), fm('m2', 3, 4, [3, 0], '1', '7'), fm('m3', 2, 3, [4, 0], '2'), fm('m4', 4, 1, [1, 0], '2'),
    fm('m5', 1, 3, [5, 0], 'final', null), fm('m6', 1, 9, [3, 0], '2'), { ...fm('m7', 2, 4, null, '3'), state: 'LIVE' }];
  const agreeRows = [upRow(1, 'T1', 1, [2, 1, 0, 1], '1-1', 3), upRow(2, 'T2', 2, [2, 1, 0, 1], '4-1', 3),
    upRow(3, 'T3', 3, [2, 1, 0, 1], '3-4', 3), upRow(4, 'T4', 4, [2, 1, 0, 1], '1-3', 3)];
  const g0 = normalizeIntlTable(table(agreeRows));
  check('積分榜的形狀讀得出來(組名、晉級規則、進失球從 scoresStr 拆)', g0?.length === 1 && g0[0].name === 'B Grp. 1' && g0[0].rows[1].gf === 4 && g0[0].rows[1].ga === 1
    && g0[0].legend[1].key === 'relegation' && JSON.stringify(g0[0].legend[1].idx) === '[3]');
  check('沒看過的形狀(單一一張表)不猜,回 null', normalizeIntlTable([{ data: { table: { all: agreeRows } } }]) === null && normalizeIntlTable(null) === null);
  check('組名只翻看過的三種寫法', intlGroupZh('Grp. 2') === '第 2 組' && intlGroupZh('Grp. C') === 'C 組' && intlGroupZh('A Grp. 1') === 'A 級第 1 組'
    && intlGroupZh('Playoff Grp. 1') === 'Playoff Grp. 1');

  const [ok] = intlStandings(g0, matches);
  const by = id => ok.rows.find(r => r.fmId === String(id));
  check('只算分組賽:預賽(round final)、組外與正在踢的都不算,比賽的 group 欄位不看', ok.counted === 4 && by(1).p === 2 && by(1).gf === 1 && by(3).gf === 3 && by(3).ga === 4,
    `算了 ${ok.counted} 場`);
  check('跟上游逐隊一致 → 照上游的名次排(官方的同分規則借上游的)', ok.status === 'ok' && ok.orderBy === 'official'
    && ok.rows.map(r => r.fmId).join() === '1,2,3,4' && ok.rows.every((r, i) => r.pos === i + 1), ok.rows.map(r => r.fmId).join());

  // 上游把正在踢的 2 對 4 算進去了(T2 1-0 領先):場數不一樣 → pending,照本站的數字排,不是錯
  const liveRows = [upRow(1, 'T1', 1, [2, 1, 0, 1], '1-1', 3), upRow(2, 'T2', 2, [3, 2, 0, 1], '5-1', 6, { id: 'm7' }),
    upRow(3, 'T3', 3, [2, 1, 0, 1], '3-4', 3), upRow(4, 'T4', 4, [3, 1, 0, 2], '1-4', 3, { id: 'm7' })];
  const [pend] = intlStandings(normalizeIntlTable(table(liveRows)), matches);
  check('上游算進了正在踢的比賽 → pending,記下那一場,照本站的積分、淨勝球排', pend.status === 'pending' && pend.orderBy === 'computed'
    && JSON.stringify(pend.live) === '["m7"]' && pend.rows.map(r => r.fmId).join() === '2,1,3,4' && pend.rows[0].check === 'pending' && pend.rows[0].pts === 3);

  // 場數一樣,積分卻不一樣 → mismatch(那才是真的有人算錯)
  const badRows = agreeRows.map(r => (r.id === 3 ? { ...r, pts: 4 } : r));
  const [bad] = intlStandings(normalizeIntlTable(table(badRows)), matches);
  check('場數一樣卻對不上 → mismatch,不照上游的名次排', bad.status === 'mismatch' && bad.orderBy === 'computed' && bad.rows.find(r => r.fmId === '3').check === 'mismatch');

  if (D) {
    const groups = (D.standings ?? []).flatMap(st => st.groups);
    const cnt = {};
    for (const g of groups) cnt[g.status] = (cnt[g.status] ?? 0) + 1;
    check('產物的積分榜計數跟逐組判決一致', JSON.stringify(cnt) === JSON.stringify(D.standingsCounts ?? {}), JSON.stringify(cnt));
    check('積分榜只給收進來的賽事', (D.standings ?? []).every(st => D.comps.find(c => c.key === st.comp)?.status === 'ok'));
    check('每一組的名次從 1 排到底;跟上游一致的組沒有附上游的數字、不一致的每一列都附',
      groups.every(g => g.rows.every((r, i) => r.pos === i + 1) && g.rows.every(r => (r.check === 'agree') === !r.up)));
    check('跟上游一致的組照上游的名次(orderBy official),其餘照本站的數字排',
      groups.every(g => (g.status === 'ok') === (g.orderBy === 'official')));
    const unknownLegend = [...new Set(groups.flatMap(g => g.legend).filter(l => !INTL_LEGEND_ZH[l.key]).map(l => l.key))];
    check('晉級規則的代碼都翻過(沒看過的會印英文,但要知道有新的出現)', unknownLegend.length === 0, unknownLegend.join('、'));
    check('一組裡的勝和負加起來是場數、積分是三倍勝加和', groups.every(g => g.rows.every(r => r.w + r.d + r.l === r.p && r.pts === 3 * r.w + r.d && r.gd === r.gf - r.ga)));
  }
}

// ── 5c. 球隊頁的明細 ────────────────────────────────
console.log('\n▶ 國家隊:球隊頁(評分走勢、最近幾場、歷來交手)');
{
  check('產物存在(npm run build 會產生 web/data/intl-teams.json)', Boolean(DT));
  if (D && DT) {
    const keys = Object.keys(D.teams);
    check('字典裡的每一隊都有明細', keys.every(k => DT.teams[k]), keys.filter(k => !DT.teams[k]).slice(0, 5).join('、'));
    /* 「這一場 +12」加起來就是排名上那個分數:最近一場踢完的評分 = 字典裡的評分(共用 eloDelta 的意義) */
    const off = keys.filter(k => DT.teams[k].recent.length && DT.teams[k].recent.at(-1).r !== D.teams[k].rating);
    check('最近一場踢完的評分就是字典裡的評分', off.length === 0, off.slice(0, 3).join('、'));
    const badTrend = keys.filter(k => { const t = DT.teams[k].trend; return t.some((p, i) => p[0] < DT.trendFrom || (i && t[i - 1][0] > p[0])); });
    check('走勢從 trendFrom 起、依日期排好', badTrend.length === 0, badTrend.slice(0, 3).join('、'));
    /* 容差 1.1:賽後評分取整數、變化取一位小數,四捨五入最壞差 0.5 + 0.05 + 0.5。
       同一天踢兩場卻沒累加的那個 bug 差的是一整場的變化(聖克里斯多福及尼維斯 2025-05-25 差 2.6 與 3.2) */
    check('最近幾場每一場的評分變化,首尾相接(同一天踢兩場的也接得上)', keys.every(k => DT.teams[k].recent.every((m, i, a) => i === 0 || Math.abs(a[i - 1].r + m.dr - m.r) <= 1.1)));

    const pairs = D.fixtures.filter(f => f.state !== 'CANCELLED' && f.home.key && f.away.key).map(f => pairKey(f.home.key, f.away.key));
    check('接下來每一組對戰都有交手紀錄的欄位(沒交手過是 null,不是漏掉)', pairs.every(k => k in DT.h2h), pairs.filter(k => !(k in DT.h2h)).slice(0, 3).join('、'));
    const vals = Object.entries(DT.h2h);
    check('交手紀錄的勝和負加起來是交手次數、最近幾次不超過設定', vals.every(([, x]) => !x || (x.w[0] + x.w[1] + x.w[2] === x.n && x.last.length <= DT.h2hLast)));
    const nulls = vals.filter(([, x]) => !x).map(([k]) => k);
    const truly = nulls.filter(k => { const [a, b] = k.split('|'); return mj.some(m => (m.home === a && m.away === b) || (m.home === b && m.away === a)); });
    check('標成「沒交手過」的,martj42 裡真的一場都沒有', truly.length === 0, truly.slice(0, 3).join('、'));
    /* 交手紀錄整份重算一次,逐組比對。第一版只抽一組 —— 抽到勝負對稱的那一組(例如 3 勝 3 負),
       「把勝負寫反」這種 bug 就是綠的 */
    const re = intlH2H(mj, Object.keys(DT.h2h).map(k => k.split('|')), { lastN: DT.h2hLast });
    const diff = Object.keys(DT.h2h).filter(k => JSON.stringify(re.get(k) ?? null) !== JSON.stringify(DT.h2h[k]));
    check('交手紀錄整份重算一次對得回產物', diff.length === 0, diff.slice(0, 3).join('、'));
  }
}

// ── 5d. 國旗 ────────────────────────────────────────
console.log('\n▶ 國家隊:國旗(開源國旗集;屬地用宗主國的旗不掛)');
{
  const table = loadIntlTeamTable(ROOT);
  const R = makeIntlResolver(table, new Set(mj.flatMap(x => [x.home, x.away])));
  /* ICU 會把廢止的舊代碼換成新碼再翻譯(DD → DE),所以反查時 DD 也回「Germany」,而它在字母順序上比 DE 早 ——
     第一版把德國對到 DD、塞爾維亞對到 CS、辛巴威對到 RH。中文名剛好沒事,拿代碼找國旗檔時才現形 */
  const want = { Germany: 'DE', Serbia: 'RS', Zimbabwe: 'ZW', 'Curaçao': 'CW', Vietnam: 'VN', Yemen: 'YE', Vanuatu: 'VU' };
  const got = Object.fromEntries(Object.keys(want).map(k => [k, R.isoOf(k)]));
  check('國碼反查不收廢止的舊代碼(德國是 DE 不是 DD)', Object.entries(want).every(([k, v]) => got[k] === v), JSON.stringify(got));
  check('國旗碼:英格蘭四隊走國旗集的非 ISO 碼、中華台北刻意不給、其餘是國碼小寫',
    R.flagCodeOf('England') === 'gb-eng' && R.flagCodeOf('Wales') === 'gb-wls' && R.flagCodeOf('Northern Ireland') === 'gb-nir'
    && R.flagCodeOf('Taiwan') === null && R.flagCodeOf('Japan') === 'jp' && R.flagCodeOf('Germany') === 'de');
  check('刻意不給的每一隊都寫了理由', Object.entries(table.flag ?? {}).filter(([, v]) => v === null).every(([k]) => table._flagEvidence?.[k]));

  /* 規則用捏造的像素驗:會員照給;非會員跟別的碼看起來同一面(差一點點也算)→ 不給;獨一無二的照給 */
  const img = v => ({ width: 2, height: 1, data: Uint8Array.from([v, v, v, 255, v, v, v, 255]) });
  const PX = { aa: img(10), bb: img(10.5 | 0), cc: img(200), dd: img(11) };   // bb 跟 aa 一樣、dd 跟 aa 差 1(< 門檻)
  PX.dd.data[0] = 11;
  const plan = intlFlagPlan({ keys: ['A', 'B', 'C', 'D', 'E', 'F'], flags: { aa: { img: 'aa' }, bb: { img: 'bb' }, cc: { img: 'cc' }, dd: { img: 'dd' } },
    flagCodeOf: k => ({ A: 'aa', B: 'bb', C: 'cc', D: 'dd', E: null, F: 'ff' })[k], isMember: k => k === 'A', pixelsOf: x => PX[x] });
  check('會員照給;非會員跟別的碼同一面(含差一點點)不給;獨一無二的照給;沒碼、沒圖分開記',
    plan.byKey.A && !plan.byKey.B && plan.byKey.C && !plan.byKey.D && plan.sameAs.map(x => x.key).join() === 'B,D'
    && plan.noCode.join() === 'E' && plan.notFetched.map(x => x.key).join() === 'F', JSON.stringify(Object.keys(plan.byKey)));
  check('「同一面」的門檻落在量過的空隙裡(同一面 0.38 以下、不同國家最近 4.54)', FLAG_SAME > 0.38 && FLAG_SAME < 4.54, String(FLAG_SAME));

  const FP = join(ROOT, 'data', 'manual', 'intl-flags.json');
  const FF = existsSync(FP) ? JSON.parse(readFileSync(FP, 'utf8')) : null;
  check('國旗檔記著出處與授權(開源國旗集、MIT)', FF?.source?.name === 'lipis/flag-icons' && FF.source.license === 'MIT' && /github\.com\/lipis\/flag-icons/.test(FF.source.url));
  const flagsOk = FF && Object.values(FF.flags).every(f => { if (!/^data:image\/png;base64,/.test(f.img)) return false;
    const im = decodePNG(Buffer.from(f.img.split(',')[1], 'base64')); return im.width === FF.size[0] && im.height === FF.size[1]; });
  check('每一面都是內嵌的 PNG、尺寸跟檔案記的一樣', Boolean(flagsOk), FF ? `${Object.keys(FF.flags).length} 面 ${FF.size?.join('×')}` : '沒有國旗檔');

  const FLP = join(ROOT, 'web', 'data', 'intl-flags.json');
  const FL = existsSync(FLP) ? JSON.parse(readFileSync(FLP, 'utf8')) : null;
  check('產物存在(intl-flags.json,國旗另外一份)', Boolean(FL));
  if (D && FL) {
    check('intl.json 不含國旗的圖(總覽頁也載它,不該多下載兩百 KB)', !JSON.stringify(D.teams).includes('data:image/'));
    check('國旗的每一隊都在字典裡、數量跟產物講的一樣', Object.keys(FL.flags).every(k => D.teams[k]) && Object.keys(FL.flags).length === D.flags?.count,
      `${Object.keys(FL.flags).length} / ${D.flags?.count}`);
    const members = new Set(Object.entries(D.teams).filter(([, t]) => t.member).map(([k]) => k));
    check('會員不會因為「同一面旗」被拿掉;被拿掉的那一邊講得出是跟誰', D.flags.sameAs.every(x => !members.has(x.key) && (!x.asKey || members.has(x.asKey))),
      D.flags.sameAs.map(x => `${x.key}=${x.as}`).join('、'));
    check('中華台北不掛國旗(國際賽用的不是國旗),而且產物講了理由', !D.teams.Taiwan || (!FL.flags.Taiwan && D.flags.excluded.some(x => x.key === 'Taiwan' && x.why)));
    /* 掛出去的國旗兩兩不同:兩隊掛同一面旗,讀者分不出誰是誰(屬地那條就是為了這個) */
    // 產物裡每一隊存的直接是圖的路徑字串(不是物件;2026-09-26 起是 assets/img/h/ 的檔,單檔版才是 data URI)
    const pix = Object.fromEntries(Object.entries(FL.flags).map(([k, v]) => [k, decodePNG(imageBytes(v, { webDir: join(ROOT, 'web') }).buf)]));
    const ks = Object.keys(pix), same = [];
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) if (flagDistance(pix[ks[i]], pix[ks[j]]) < FLAG_SAME) same.push(`${ks[i]}=${ks[j]}`);
    check('掛出去的國旗兩兩看起來不一樣', same.length === 0, same.slice(0, 4).join('、'));
  }
  const page = stripComments(readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-intl.js'), 'utf8'));
  check('頁面只用產物裡內嵌的國旗,不從外部網址載', !/flag-icons|raw\.githubusercontent|\.svg['"`]/.test(page) && /FLAGS\[key\]/.test(page));
  const ov = stripComments(readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-overview.js'), 'utf8'));
  /* 總覽頁不為了一張小卡多下載國旗(2026-09-25 的決定)。2026-09-26 起總覽的「即將到來」可以勾國家隊
     (使用者:「國家隊也加進勾選」),勾了那幾列要有國旗 —— 所以這一條從「總覽一個字都不准提國旗」
     改成守原本的意圖:**只有 ensureFlags 會載,而它在沒勾國家隊時直接回去**。
     看到這條紅了不要把總覽的國旗拿掉,那是使用者要的;要擋的是「一打開總覽就載」。 */
  const flagLoads = ov.match(/C\.loadFrom\([^)]*intl-flags[^)]*\)/g) ?? [];
  const ensure = ov.slice(ov.indexOf('const ensureFlags ='), ov.indexOf('const ensureFlags =') + 420);
  check('總覽頁只在勾了國家隊時才載國旗(不為了小卡多下載)', flagLoads.length === 1 && ensure.includes(flagLoads[0])
    && /\|\| !\[\.\.\.shown\]\.some\(k => k\.startsWith\('intl:'\)\)\) return;/.test(ensure),
    `載國旗的地方 ${flagLoads.length} 處`);
  /* 畫面上的字是給讀者看的:「npm run …」那種指令本站其他頁都拿掉了(模型頁、球隊頁),
     國旗那一句第一版寫了「圖還沒抓(npm run intl:flags)」—— 當時沒有新隊所以沒露出來,有新隊那天就會。 */
  check('國家隊頁不對讀者印開發指令', !/npm (run|test)/.test(page));
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
  /* 結構版本要是**現在的** —— 寫死 1 的話,版本升到 2 之後它走的是「舊結構整份重抓」那條路,
     這條就不再守「抓失敗時保留上一份」(2026-09-25 升版時發現) */
  const prevCnl = { schemaVersion: INTL_SCHEMA_VERSION, key: 'cnl', id: 9821, fmName: 'CONCACAF Nations League', season: '2026/2027', availableSeasons: [],
    retrievedAt: '2026-01-01T00:00:00.000Z', proof: null,
    matches: [{ id: '1', kickoff: '2026-10-04T19:00:00Z', home: { name: 'Aruba', shortName: null, fmId: '1' }, away: { name: 'Anguilla', shortName: null, fmId: '2' },
      state: 'NS', final: null, reason: null, reasonLong: null, awarded: false, round: '5', group: '2' }] };
  writeFileSync(join(dir, 'cnl.json'), JSON.stringify(prevCnl));
  /* 結構升版(1 → 2 加了分組積分榜):場次的形狀沒變,上一季的證據要沿用,**不能再多抓一次上一季** */
  const oldProof = { season: '2024/2025', retrievedAt: '2026-01-01T00:00:00.000Z', matches: unl.map(asFm).map(x => ({ id: String(x.id), kickoff: x.status.utcTime,
    home: { name: x.home.name, shortName: null, fmId: '1' }, away: { name: x.away.name, shortName: null, fmId: '2' }, state: 'FT',
    final: x.status.scoreStr.split(' - ').map(Number), reason: 'FT', reasonLong: null, awarded: false, round: '1', group: '1' })) };
  writeFileSync(join(dir, 'unl-c.json'), JSON.stringify({ schemaVersion: 1, key: 'unl-c', id: 9808, fmName: 'UEFA Nations League C', season: '2026/2027',
    availableSeasons: ['2026/2027', '2024/2025'], retrievedAt: '2026-01-01T00:00:00.000Z', matches: [], proof: oldProof }));
  routes.set('id=9808', { ...body('UEFA Nations League C', '2026/2027', [upcoming]),
    table: [{ data: { composite: true, tables: [{ leagueName: 'Grp. 1', leagueId: 1, legend: [], table: { all: [
      { name: 'Netherlands', id: 1, idx: 1, played: 0, wins: 0, draws: 0, losses: 0, scoresStr: '0-0', pts: 0, deduction: null, ongoing: null }] } }] } }] });
  const realFetch = globalThis.fetch;
  let calls = 0;
  const requested = [];
  globalThis.fetch = async url => {
    calls++;
    requested.push(String(url));
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
  const c3 = read('unl-c');
  check('結構升版時上一季的證據沿用、不重抓,分組積分榜一起存下來',
    c3?.schemaVersion === INTL_SCHEMA_VERSION && c3.proof?.matches.length === unl.length && c3.groups?.[0]?.rows?.[0]?.name === 'Netherlands'
    && !requested.some(u => u.includes('id=9808&season')), `證據 ${c3?.proof?.matches.length ?? 0} 場`);
  rmSync(dir, { recursive: true, force: true });
}
