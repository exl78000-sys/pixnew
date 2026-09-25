#!/usr/bin/env node
/* 國家隊:賽程、賽果、評分與勝率 → web/data/intl.json(2026-09-24)
 *
 * 兩個來源,分工不重疊:
 *   martj42/international_results  歷史賽果(只收踢完的)→ **評分池**。評分只從它算。
 *   FotMob(八個賽事)              賽程與這一窗的賽果 → 畫面上的場次。
 * FotMob 的每一場已完賽都跟 martj42 逐場對(lib/intl.mjs 的 crossCheckIntl),判決留在產物裡、畫面照印。
 *
 * 四條界線(每一條都是鐵則的直接後果):
 *   1. **勝率只給驗收過的模型**:每次建置用當下的資料重算一次驗收(參數固定在 data/intl-elo-params.json),
 *      改善沒有大過兩倍成對標準誤就整批不給(`intlPasses`)。
 *   2. **評分只從 martj42 算**,不拿 FotMob 還沒被核對的新賽果去改評分(鐵則五)。martj42 落後的那幾天,
 *      每一場的兩隊「評分之後又踢了幾場」寫進產物(`lag`),畫面講出來 —— 不確定性寫在畫面上(鐵則四)。
 *   3. **不知道是不是中立場**:FotMob 賽程沒有這個欄位,一律當名單上的主隊在主場。代價在調參時量過
 *      (neutralUnknown),照抄進產物讓畫面講。
 *   4. **id 沒證明過的賽事整個不收**(proofFromCheck;抓取器也算一次,但它算的只是要不要多抓上一季 ——
 *      這裡用當下的對照表重算,判決以這裡為準)。
 *
 *   npm run intl:build        (也掛在 npm run build 裡,排在資產戳之前)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseIntlResults, parseShootouts, runIntlElo, backtestIntl, frequencyBaseline, pairedGain, calibration,
  expectedScore, probsFromE, tournamentClass, crossCheckIntl, proofFromCheck,
  INTL_HOLDOUT, INTL_MIN_GAMES, intlPasses,
} from './lib/intl.mjs';
import { loadIntlTeamTable, makeIntlResolver } from './lib/intl-teams.mjs';
import { FOTMOB_INTL, INTL_FAMILIES, INTL_NOT_FETCHED, isIntlTbd, intlTbdLabel, intlRoundZh } from './lib/adapters/fotmob-intl.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'data', 'intl.json');
/* 排名只列「還在踢」的隊:最後一場在評分截止日之前兩年內。解散的隊(蘇聯、南斯拉夫)與
   很久沒踢的隊評分凍在當年,列進來會讓排名看起來像歷史榜。 */
const ACTIVE_DAYS = 730;
/* 取消的場次只留最近一週的:上游整季的取消都留著(友誼賽 2026 有 20 場,三月與六月的),
   全部放進「接下來」那一份只是讓產物變胖,讀者要的是「這一週有哪一場不踢了」。 */
const CANCELLED_KEEP_DAYS = 7;
const iso = t => { const x = Date.parse(t ?? ''); return Number.isFinite(x) ? new Date(x).toISOString() : null; };
/* 組別:字母(非洲盃資格賽 A~L)印「A 組」,數字(歐國聯、中北美國聯)印「第 1 組」 */
const groupZh = g => (g == null || g === '' ? null : /^\d+$/.test(String(g)) ? `第 ${g} 組` : `${g} 組`);

const r1 = x => Math.round(x * 10) / 10;
const r4 = x => Math.round(x * 1e4) / 1e4;
const dayMs = 86400000;

/* 純函式:所有輸入都由呼叫端給,方便 npm test 拿捏造的資料驗每一條分岔。 */
export function assembleIntl({ mj, shootouts = new Map(), mjMeta = null, params, table, raws, builtAt }) {
  const P = params.params;
  const minGames = params.minGames ?? INTL_MIN_GAMES;
  const resolver = makeIntlResolver(table, new Set(mj.flatMap(m => [m.home, m.away])));
  const lastDate = mj.at(-1)?.date ?? null;

  // ── 模型:評分(到 martj42 最後一場)與每次建置重算的驗收 ──
  const { rating, games, last } = runIntlElo(mj, P);
  const hold = backtestIntl(mj, P, { from: INTL_HOLDOUT.from, minGames });
  const sub = f => { const rows = hold.filter(r => f(r.m)); return pairedGain(rows, frequencyBaseline(rows)); };
  const all = pairedGain(hold, frequencyBaseline(hold));
  const pack = g => g && { n: g.n, model: r4(g.model), baseline: r4(g.baseline), gain: r4(g.gain), se: r4(g.se), z: r1(g.z) };
  const passed = intlPasses(all);

  // ── 賽事:讀快取、用當下的對照表重算 id 證明 ──
  const comps = [];
  const matches = [];      // 收進來的賽事本季全部場次(含已完賽),帶 comp
  const unknownNames = new Map();
  for (const comp of FOTMOB_INTL) {
    const raw = raws[comp.key] ?? null;
    const base = { key: comp.key, id: comp.id, zh: comp.zh, short: comp.short, en: comp.en, family: comp.family };
    if (!raw) { comps.push({ ...base, status: 'missing', why: '還沒抓到(抓取器要在 runner 上跑,沙箱連不到 FotMob)' }); continue; }
    const pool = [...raw.matches, ...(raw.proof?.matches ?? [])];
    const proof = proofFromCheck(crossCheckIntl(pool, mj, resolver.keyOf), comp.expect);
    for (const m of pool) for (const t of [m.home, m.away]) {
      if (t?.name && !isIntlTbd(t.name) && !resolver.keyOf(t.name)) {
        const u = unknownNames.get(t.name) ?? { name: t.name, n: 0, comps: new Set() };
        u.n++; u.comps.add(comp.short); unknownNames.set(t.name, u);
      }
    }
    const counts = { total: raw.matches.length };
    for (const m of raw.matches) counts[m.state] = (counts[m.state] ?? 0) + 1;
    comps.push({
      ...base, status: proof.ok ? 'ok' : 'excluded', why: proof.why, fmName: raw.fmName, season: raw.season,
      retrievedAt: raw.retrievedAt, counts,
      proof: { matched: proof.matched, expectHits: proof.expectHits, agree: proof.agree, tournaments: proof.tournaments.slice(0, 5),
        proofSeason: raw.proof ? { season: raw.proof.season, n: raw.proof.matches.length } : null },
    });
    if (!proof.ok) continue;
    for (const m of raw.matches) matches.push({ ...m, kickoff: iso(m.kickoff), comp: comp.key });
  }

  // 同一場比賽不該出現在兩個賽事裡;真的出現就留第一個,並記下來(不靜靜吞掉)
  const seen = new Set();
  const dupes = [];
  const uniq = matches.filter(m => { if (seen.has(m.id)) { dupes.push(m.id); return false; } seen.add(m.id); return true; });

  // ── 已完賽:逐場核對 ──
  const finished = uniq.filter(m => m.state === 'FT' && Array.isArray(m.final));
  const checks = new Map(crossCheckIntl(finished, mj, resolver.keyOf).map(r => [r.fm.id, r]));
  // 評分沒算到的已完賽場次(martj42 還沒收 / 查不到):每一隊幾場
  const lagOf = new Map();
  for (const m of finished) {
    const c = checks.get(m.id);
    if (!c || (c.status !== 'notYet' && c.status !== 'unmatched')) continue;
    for (const k of [c.home, c.away]) if (k) lagOf.set(k, (lagOf.get(k) ?? 0) + 1);
  }
  const side = t => (isIntlTbd(t?.name)
    ? { name: t.name, key: null, tbd: true, label: intlTbdLabel(t.name) }
    : { name: t?.name ?? null, key: resolver.keyOf(t?.name) });
  const labels = m => ({ roundZh: intlRoundZh(m.comp, m.round), groupZh: groupZh(m.group) });
  const results = finished.map(m => {
    const c = checks.get(m.id);
    const out = { id: m.id, comp: m.comp, kickoff: m.kickoff, home: side(m.home), away: side(m.away), ...labels(m),
      final: m.final, reason: m.reason, awarded: m.awarded, check: c?.status ?? 'noKey' };
    if (c?.mj && c.status !== 'agree') {
      // 另一個來源的比分,**轉成 FotMob 的主客方向**,畫面才能並排
      out.other = c.swapped ? [c.mj.fa, c.mj.fh] : [c.mj.fh, c.mj.fa];
    }
    if (m.reason === 'Pen') {
      // PK 勝方:FotMob 的賽程端點沒有;martj42 的 shootouts.csv 有(只在兩邊對上的場次查)
      const s = c?.mj ? shootouts.get(`${c.mj.date}|${c.mj.home}|${c.mj.away}`) : null;
      out.pensWinner = s?.winner ?? null;
    }
    return out;
  }).sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff));

  // ── 未賽:勝率 ──
  const keepFrom = Date.parse(builtAt) - CANCELLED_KEEP_DAYS * dayMs;
  const fixtures = uniq.filter(m => m.state !== 'FT' && !(m.state === 'CANCELLED' && Date.parse(m.kickoff) < keepFrom)).map(m => {
    const h = side(m.home), a = side(m.away);
    const out = { id: m.id, comp: m.comp, kickoff: m.kickoff, home: h, away: a, state: m.state, ...labels(m),
      reason: m.reason, reasonLong: m.reasonLong,
      // 中止的比賽上游會給「中止當下」的比分(友誼賽 Denmark v Ukraine 2-1 Abandoned)—— 照印,標清楚那不是終場
      ...(m.state === 'CANCELLED' && Array.isArray(m.final) ? { stoppedAt: m.final } : {}),
      lag: [h.key ? lagOf.get(h.key) ?? 0 : null, a.key ? lagOf.get(a.key) ?? 0 : null] };
    if (m.state === 'CANCELLED') return { ...out, prob: null, why: m.reason === 'Ab' ? '比賽中止' : '比賽取消' };
    const why = h.tbd || a.tbd ? '對戰組合還沒決定(上一階段還沒踢完)'
      : !passed ? '模型這一次重算的驗收沒有通過門檻(改善要大過兩倍標準誤),整批不給勝率'
      : !h.key || !a.key ? `隊名「${!h.key ? h.name : a.name}」對不上身分,本站沒有它的評分`
      : (games.get(h.key) ?? 0) < minGames || (games.get(a.key) ?? 0) < minGames
        ? `評分樣本不足:${[h, a].filter(t => (games.get(t.key) ?? 0) < minGames).map(t => `${t.key} 只有 ${games.get(t.key) ?? 0} 場`).join('、')}(要 ${minGames} 場,跟回測同一個門檻)`
      : null;
    if (why) return { ...out, prob: null, why };
    const rh = rating.get(h.key), ra = rating.get(a.key);
    const p = probsFromE(expectedScore(rh, ra, { neutral: false, homeAdv: P.homeAdv }), P);
    return { ...out, prob: [r4(p.home), r4(p.draw), r4(p.away)], elo: [Math.round(rh), Math.round(ra)], why: null };
  }).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));

  // ── 評分排名 ──
  const cutoff = lastDate ? new Date(Date.parse(`${lastDate}T00:00:00Z`) - ACTIVE_DAYS * dayMs).toISOString().slice(0, 10) : '';
  const ranking = [...rating].filter(([k]) => (games.get(k) ?? 0) >= minGames && (last.get(k) ?? '') >= cutoff)
    .sort((x, y) => y[1] - x[1]).map(([k, r], i) => ({ rank: i + 1, key: k, rating: Math.round(r), games: games.get(k), last: last.get(k) }));
  const rankOf = new Map(ranking.map(r => [r.key, r.rank]));

  // 畫面會提到的每一隊:中文名、評分與名次(一份字典,場次裡只放鍵)
  const keys = new Set([...ranking.map(r => r.key),
    ...fixtures.flatMap(f => [f.home.key, f.away.key]), ...results.flatMap(r => [r.home.key, r.away.key])].filter(Boolean));
  const teams = {};
  for (const k of [...keys].sort()) {
    teams[k] = { zh: resolver.zhOf(k), rating: rating.has(k) ? Math.round(rating.get(k)) : null,
      games: games.get(k) ?? 0, last: last.get(k) ?? null, rank: rankOf.get(k) ?? null };
  }

  const checkCounts = {};
  for (const r of results) checkCounts[r.check] = (checkCounts[r.check] ?? 0) + 1;
  return {
    builtAt,
    model: {
      method: 'World Football Elo 形式:預期分數用 400 分一個數量級的 logistic、主場加分只給非中立場、進球差加權、K 依賽事分級',
      params: P, minGames, passed, gate: '改善要大過兩倍的成對標準誤',
      tune: params.tune && { from: params.tune.from, to: params.tune.to, n: params.tune.n, rps: params.tune.rps, tried: params.tune.tried, edges: params.tune.edges },
      tunedAt: params.ranAt ?? null,
      holdout: all && { from: INTL_HOLDOUT.from, to: hold.at(-1)?.m.date ?? null, ...pack(all),
        competitive: pack(sub(m => tournamentClass(m.tournament) !== 'friendly')),
        friendly: pack(sub(m => tournamentClass(m.tournament) === 'friendly')) },
      calibration: calibration(hold).map(b => ({ ...b, predicted: r4(b.predicted), actual: r4(b.actual) })),
      neutralUnknown: params.neutralUnknown ?? null,
      ratingsAsOf: lastDate,
    },
    sources: [
      { key: 'martj42', name: 'martj42/international_results', url: 'https://github.com/martj42/international_results',
        role: '歷史賽果:1872 年至今的男子 A 級國際賽,只收踢完的比賽。評分只從它算。',
        lastDate, rows: mjMeta?.files?.['results.csv']?.rows ?? mj.length, retrievedAt: mjMeta?.retrievedAt ?? null },
      { key: 'fotmob', name: 'FotMob', url: 'https://www.fotmob.com', role: '賽程與這一窗的賽果(八個賽事,一個賽事一個請求)' },
      { key: 'cldr', name: 'Unicode CLDR', url: 'https://cldr.unicode.org', role: '國名的中文(標準資料,不是翻譯);足球慣用名不同的由本站覆寫' },
    ],
    comps,
    // 只列有賽事收進來的家族 —— 沒有場次的按鈕按下去是空的(「按鈕在但點了沒東西」)
    families: INTL_FAMILIES.filter(f => comps.some(c => c.family === f.key && c.status === 'ok')),
    notFetched: INTL_NOT_FETCHED,
    fixtures,
    results,
    checkCounts,
    ranking,
    teams,
    unknownNames: [...unknownNames.values()].sort((a, b) => b.n - a.n).map(u => ({ name: u.name, n: u.n, comps: [...u.comps] })),
    dupes,
  };
}

function loadRaws(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const comp = FOTMOB_INTL.find(c => c.key === j.key);
      // 別的 id 的快取(對照表換過 id)不收 —— 那不是這個賽事的資料
      if (comp && j.id === comp.id && Array.isArray(j.matches)) out[j.key] = j;
    } catch { /* 壞檔當沒有,抓取器下一輪會重寫 */ }
  }
  return out;
}

async function main() {
  const mjPath = join(ROOT, 'data', 'raw', 'intl', 'results.csv');
  if (!existsSync(mjPath)) { console.log('  國家隊:沒有 data/raw/intl/results.csv(先跑 npm run intl:results),本次不產出 intl.json'); return; }
  const mj = parseIntlResults(readFileSync(mjPath, 'utf8'));
  const soPath = join(ROOT, 'data', 'raw', 'intl', 'shootouts.csv');
  const shootouts = existsSync(soPath) ? parseShootouts(readFileSync(soPath, 'utf8')) : new Map();
  const metaPath = join(ROOT, 'data', 'raw', 'intl', 'meta.json');
  const mjMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
  const params = JSON.parse(readFileSync(join(ROOT, 'data', 'intl-elo-params.json'), 'utf8'));
  const out = assembleIntl({ mj, shootouts, mjMeta, params, table: loadIntlTeamTable(ROOT),
    raws: loadRaws(join(ROOT, 'data', 'raw', 'fotmob-intl')), builtAt: new Date().toISOString() });

  const h = out.model.holdout;
  console.log(`▶ 國家隊:martj42 ${mj.length} 場(到 ${out.model.ratingsAsOf})・驗收 ${h?.n} 場 改善 ${h?.gain} ± ${h?.se}(${h?.z} SE)→ ${out.model.passed ? '通過,給勝率' : '沒通過,整批不給勝率'}`);
  for (const c of out.comps) {
    console.log(`  ${c.status === 'ok' ? '✓' : c.status === 'excluded' ? '✗' : '·'} ${c.zh}:${c.status === 'missing' ? c.why
      : `季 ${c.season}・${c.counts.total} 場・證明 對上 ${c.proof.matched}${c.proof.proofSeason ? `(含上一季 ${c.proof.proofSeason.season})` : ''}${c.why ? ` —— ${c.why}` : ''}`}`);
  }
  const withProb = out.fixtures.filter(f => f.prob).length;
  console.log(`  未賽 ${out.fixtures.length} 場(給勝率 ${withProb})・已完賽 ${out.results.length} 場(核對 ${JSON.stringify(out.checkCounts)})・排名 ${out.ranking.length} 隊`);
  if (out.unknownNames.length) console.log(`  ⚠ 隊名對不上身分 ${out.unknownNames.length} 個:${out.unknownNames.slice(0, 12).map(u => `${u.name}×${u.n}`).join('、')}`);
  if (out.dupes.length) console.log(`  ⚠ 同一場出現在兩個賽事:${out.dupes.join('、')}(留第一個)`);

  await mkdir(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  await writeFile(tmp, JSON.stringify(out) + '\n');
  await rename(tmp, OUT);
  console.log(`✔ web/data/intl.json(${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(`✗ 國家隊建置失敗:${e.stack ?? e.message}`); process.exitCode = 1; });
}
