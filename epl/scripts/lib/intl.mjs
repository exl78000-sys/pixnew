/* 國家隊:賽果解析、Elo 評分、走查回測與勝率(2026-09-24 起)。
 *
 * ## 資料
 *
 * 歷史賽果來自 **martj42/international_results**(github 上的公開資料集,raw.githubusercontent.com,
 * 沙箱與 runner 都抓得到):1872 年至今的男子國家隊 A 級賽,四萬九千多場。
 *
 * 實測過、會咬人的三件事:
 *   1. **只收已經踢完的比賽**(2026-09-24:0 筆未賽)。賽程與即時比分不能靠它 —— 那一半走 FotMob。
 *   2. **77 列的城市欄是帶引號的 `"Washington, D.C."`**,`split(',')` 會錯欄。一律走 `lib/csv.mjs`。
 *   3. 更名的球隊**全程用現名**(Zaire 的比賽記成 DR Congo),所以評分是連續的;
 *      分裂的不算更名(Yugoslavia、Czechoslovakia、Soviet Union 各自是一支隊)—— 照資料集原樣,不自己併。
 *
 * 比分是**含延長賽、不含 PK 大戰**的最終比分;PK 另在 `shootouts.csv`。Elo 只看比分(PK 勝負不算贏球),
 * 這是 World Football Elo 的慣例。
 *
 * ## 模型(鐵則二:量過才上)
 *
 * 形式照 World Football Elo(eloratings.net)的公開公式:預期分數用 400 分一個數量級的 logistic,
 * 主場加分(**中立場不加**)、進球差加權、K 依賽事分級。**不照抄它的數字**:
 * 主場分、K 的整體倍率、和局曲線三件事是在**調參年份**上掃出來的,
 * 驗收在**另一段年份**上做,參數固定。產物裡的 `model` 每次建置重算,畫面讀那一份。
 *
 * 機率:E = 預期分數(主隊視角),和局 = drawA − drawB × |E − 0.5|(實力越接近越容易和),
 * 主勝 = E − 和局/2、客勝 = 1 − E − 和局/2 —— 這樣 主勝 + 和局/2 = E,跟 Elo 自己的定義一致。
 */
import { parseCSVObjects } from './csv.mjs';

/* 調參與驗收的年份、評分門檻與上線門檻。**調參腳本與建置共用這一份** ——
   兩邊各寫一份的話,驗收區間改了一邊,畫面上印的就不是實際驗收的那一批(backtest-runner 那一課)。
   中間空 2020–2021:疫情年比賽少、很多移到中立場,而且讓兩段之間沒有任何一場重疊。 */
export const INTL_TUNE = { from: '2014-01-01', to: '2019-12-31' };
export const INTL_HOLDOUT = { from: '2022-01-01', to: null };
export const INTL_MIN_GAMES = 20;
/* 上線門檻:改善要大過兩倍的成對標準誤(跟歐冠跨聯賽評分同一條,lib/ucl-elo.mjs 的 passes)。
   每次建置用當下的資料重算,沒過就整批不給勝率 —— 不是「上次過了就一直算數」。 */
export const intlPasses = g => Boolean(g) && g.gain > 2 * g.se;

/* 賽事分級 → K 的基準值(World Football Elo 的慣例分級;整體倍率 kScale 另外掃)。
   **分級是照賽事名寫的規則**,新賽事名出現時落到「其他 30」—— 不會拋錯,但會印出來(unknownTournaments)。 */
const CONTINENTAL_FINALS = new Set([
  'UEFA Euro', 'Copa América', 'African Cup of Nations', 'AFC Asian Cup', 'Gold Cup',
  'CONCACAF Championship', 'Oceania Nations Cup', 'Confederations Cup',
]);
export function tournamentClass(t) {
  if (t === 'FIFA World Cup') return 'worldcup';
  if (CONTINENTAL_FINALS.has(t)) return 'continental';
  if (/qualification|Nations League/i.test(t)) return 'competitive';
  if (t === 'Friendly') return 'friendly';
  return 'other';
}
export const K_BASE = { worldcup: 60, continental: 50, competitive: 40, other: 30, friendly: 20 };

// 進球差加權(World Football Elo 慣例,本站聯賽 Elo 用的也是這一條)
export const gdMultiplier = gd => {
  const a = Math.abs(gd);
  if (a <= 1) return 1;
  if (a === 2) return 1.5;
  return (11 + a) / 8;
};

const START = 1500;

/* results.csv → 比賽。沒有比分的列(資料集目前沒有,但格式允許 NA)不收。 */
export function parseIntlResults(text) {
  const out = [];
  for (const o of parseCSVObjects(text)) {
    const fh = Number(o.home_score), fa = Number(o.away_score);
    if (!o.date || !o.home_team || !o.away_team || o.home_score === '' || o.away_score === ''
      || !Number.isFinite(fh) || !Number.isFinite(fa)) continue;
    out.push({
      date: o.date, home: o.home_team, away: o.away_team, fh, fa,
      tournament: o.tournament, city: o.city, country: o.country, neutral: o.neutral === 'TRUE',
    });
  }
  // 依日期排序(資料集本來就是,但不依賴它);同一天保持原順序
  return out.map((m, i) => ({ m, i })).sort((a, b) => (a.m.date < b.m.date ? -1 : a.m.date > b.m.date ? 1 : a.i - b.i)).map(x => x.m);
}

/* shootouts.csv → `日期|主|客` → { winner, firstShooter }。PK 勝方只當資訊顯示,不進評分。 */
export function parseShootouts(text) {
  const map = new Map();
  for (const o of parseCSVObjects(text)) {
    if (!o.date || !o.home_team || !o.away_team) continue;
    map.set(`${o.date}|${o.home_team}|${o.away_team}`, { winner: o.winner || null, firstShooter: o.first_shooter || null });
  }
  return map;
}

/* 預期分數 → 三個機率。夾在 [0.005, …] 之後重新正規化:強弱懸殊時 E − 和局/2 會變負 ——
   那是和局曲線在極端處的形狀問題,不是真的「負機率」;夾住是為了讓 RPS 與 log loss 有定義。 */
export function probsFromE(E, { drawA, drawB }) {
  const draw = Math.max(0.02, drawA - drawB * Math.abs(E - 0.5));
  const h = Math.max(0.005, E - draw / 2), a = Math.max(0.005, 1 - E - draw / 2);
  const s = h + draw + a;
  return { home: h / s, draw: draw / s, away: a / s };
}

export const expectedScore = (rh, ra, { neutral, homeAdv }) => 1 / (1 + 10 ** (-((rh - ra) + (neutral ? 0 : homeAdv)) / 400));

/* 一場比賽讓主隊的評分變多少(客隊變一樣多、方向相反)。**走查、排名與球隊頁的逐場紀錄共用這一條** ——
   球隊頁要印「這一場 +12」,自己再算一次的話,改了 K 或進球差加權,畫面上的數字就跟排名對不起來。 */
export function eloDelta(m, E, params) {
  const act = m.fh > m.fa ? 1 : m.fh === m.fa ? 0.5 : 0;
  return params.kScale * K_BASE[tournamentClass(m.tournament)] * gdMultiplier(m.fh - m.fa) * (act - E);
}

/* 走查 Elo:**按日期分批** —— 同一天的比賽先全部用當天開始時的評分預測,再一起更新,
   所以同一天的比賽互相看不到對方的結果(那才是「開賽前」)。
   `onDay(date, rows)` 在更新**之前**被叫,rows 是 { m, E, rh, ra, nh, na }。 */
export function runIntlElo(matches, params, { onDay = null, until = null } = {}) {
  const rating = new Map(), games = new Map(), last = new Map();
  const get = t => rating.get(t) ?? START;
  let i = 0;
  while (i < matches.length) {
    const d = matches[i].date;
    if (until && d >= until) break;
    let j = i;
    while (j < matches.length && matches[j].date === d) j++;
    const day = matches.slice(i, j).map(m => {
      const rh = get(m.home), ra = get(m.away);
      return { m, rh, ra, nh: games.get(m.home) ?? 0, na: games.get(m.away) ?? 0,
        E: expectedScore(rh, ra, { neutral: m.neutral, homeAdv: params.homeAdv }) };
    });
    if (onDay) onDay(d, day);
    for (const { m, E } of day) {
      const delta = eloDelta(m, E, params);
      rating.set(m.home, get(m.home) + delta);
      rating.set(m.away, get(m.away) - delta);
      games.set(m.home, (games.get(m.home) ?? 0) + 1);
      games.set(m.away, (games.get(m.away) ?? 0) + 1);
      last.set(m.home, d); last.set(m.away, d);
    }
    i = j;
  }
  return { rating, games, last };
}

export const outcomeOf = m => (m.fh > m.fa ? 0 : m.fh === m.fa ? 1 : 2);
export function rpsOf(p, o) {
  const pv = [p.home, p.draw, p.away];
  let cp = 0, co = 0, s = 0;
  for (let k = 0; k < 2; k++) { cp += pv[k]; co += k === o ? 1 : 0; s += (cp - co) ** 2; }
  return s / 2;
}

/* 走查回測:只評「兩隊在該場之前都至少踢過 minGames 場」的比賽 —— 新隊的評分還是起始值,
   拿它來評分等於在評起始值。**上線時的門檻用同一個數字**(`predictable`),不然回測評的跟畫面給的不是同一批。
   `assumeHome`:把中立場當成主場算(量「賽程不知道是不是中立場」的代價用,見 tune-intl.mjs)。 */
export function backtestIntl(matches, params, { from, to, minGames = 20, filter = null, assumeHome = false } = {}) {
  const rows = [];
  runIntlElo(matches, params, {
    until: to ? nextDay(to) : null,
    onDay: (d, day) => {
      if (d < from || (to && d > to)) return;
      for (const r of day) {
        if (r.nh < minGames || r.na < minGames) continue;
        if (filter && !filter(r.m)) continue;
        const neutral = assumeHome ? false : r.m.neutral;
        const E = expectedScore(r.rh, r.ra, { neutral, homeAdv: params.homeAdv });
        const p = probsFromE(E, params);
        const o = outcomeOf(r.m);
        rows.push({ m: r.m, p, o, rps: rpsOf(p, o), E });
      }
    },
  });
  return rows;
}
const nextDay = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/* 基準線:**驗收這批比賽自己的**主/和/客分佈,中立場與否分開算 —— 它偷看了答案,對基準線有利;
   贏過它才算數(跟歐冠跨聯賽評分那一套同一個標準)。 */
export function frequencyBaseline(rows) {
  const f = { true: [0, 0, 0], false: [0, 0, 0] };
  for (const r of rows) f[r.m.neutral][r.o]++;
  const norm = v => { const s = v[0] + v[1] + v[2] || 1; return { home: v[0] / s, draw: v[1] / s, away: v[2] / s }; };
  const P = { true: norm(f.true), false: norm(f.false) };
  return r => P[r.m.neutral];
}

/* 逐場配對相減的標準誤。正值 = 模型比基準線好。 */
export function pairedGain(rows, baseline) {
  const n = rows.length;
  if (n < 2) return null;
  const d = rows.map(r => rpsOf(baseline(r), r.o) - r.rps);
  const mean = d.reduce((a, x) => a + x, 0) / n;
  const se = Math.sqrt(d.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) / n);
  const avg = f => rows.reduce((a, r) => a + f(r), 0) / n;
  return { n, model: avg(r => r.rps), baseline: avg(r => rpsOf(baseline(r), r.o)), gain: mean, se, z: mean / se };
}

/* 校準:模型說 60% 的,實際是不是 60%。每場貢獻三個點(主勝/和/客勝)。 */
export function calibration(rows, bins = 10) {
  const acc = Array.from({ length: bins }, () => ({ n: 0, p: 0, hit: 0 }));
  for (const r of rows) {
    const probs = [r.p.home, r.p.draw, r.p.away];
    for (let k = 0; k < 3; k++) {
      const b = Math.min(bins - 1, Math.floor(probs[k] * bins));
      acc[b].n++; acc[b].p += probs[k]; acc[b].hit += r.o === k ? 1 : 0;
    }
  }
  return acc.map((b, i) => ({ bin: i, n: b.n, predicted: b.n ? b.p / b.n : null, actual: b.n ? b.hit / b.n : null })).filter(b => b.n);
}

/* ── 兩個來源逐場核對(FotMob 的場次 vs martj42)──────────────────────
   抓取器拿它**證明 id**、建置拿它**核對每一場賽果**,同一份邏輯不寫兩份。

   配對規則:日期 ±1 天(FotMob 給 UTC 開球時間,martj42 給當地日期,跨日的比賽差一天)、
   兩隊用**身分解析後的鍵**完全相同、主客可以對調(中立場的主客順序兩家不一定一樣)。
   結果分六種,**「對不上」跟「不一致」是兩件事**(CLAUDE.md 那條坑):
     agree     兩邊比分一致
     mismatch  兩邊都有這一場、比分不一樣(畫面兩個都印,不挑一個當答案)。評分用的是 martj42 那一份 ——
               評分只從它算;要不要把這種場次排出評分是模型的改動,見補齊規劃(第一版的註解寫「不進評分」,那不是事實)
     awarded   FotMob 是判決比分(AW),martj42 記場上比分 —— 記法不同,不算不一致
     unmatched 兩隊都認得、日期也在 martj42 涵蓋的範圍內,它卻沒有這兩隊前後一天內的對戰 ——
               run #44 實測 19 場**全是 martj42 沒收**:非洲盃資格賽三月那一輪預賽整輪沒有(12 場)、
               幾場友誼賽沒有(同一對球隊隔三天的第二場之類)。不是隊名的問題(隊名對不上的是 noKey)
     notYet    日期晚於 martj42 最新一場:它還沒收錄,**無法核對 ≠ 不一致**
     noKey     有一隊的名字對不上身分,核對不了(隊名要補進對照表) */
const dayShift = (iso, d) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
export function indexByDay(matches) {
  const idx = new Map();
  for (const m of matches) { if (!idx.has(m.date)) idx.set(m.date, []); idx.get(m.date).push(m); }
  return idx;
}
export function crossCheckIntl(fmMatches, mjMatches, keyOf) {
  const idx = indexByDay(mjMatches);
  const lastDate = mjMatches.at(-1)?.date ?? '';
  return fmMatches.filter(f => f.state === 'FT' && Array.isArray(f.final)).map(f => {
    const date = String(f.kickoff ?? '').slice(0, 10);
    const h = keyOf(f.home?.name), a = keyOf(f.away?.name);
    if (!h || !a) return { fm: f, status: 'noKey', date };
    let hit = null;
    for (const d of [date, dayShift(date, -1), dayShift(date, 1)]) {
      for (const m of idx.get(d) ?? []) {
        if (m.home === h && m.away === a) { hit = { m, swapped: false }; break; }
        if (m.home === a && m.away === h) { hit = { m, swapped: true }; break; }
      }
      if (hit) break;
    }
    if (!hit) return { fm: f, status: date > lastDate ? 'notYet' : 'unmatched', date, home: h, away: a };
    const [fh, fa] = f.final;
    const same = hit.swapped ? (hit.m.fh === fa && hit.m.fa === fh) : (hit.m.fh === fh && hit.m.fa === fa);
    return { fm: f, mj: hit.m, swapped: hit.swapped, date, home: h, away: a,
      status: same ? 'agree' : f.awarded ? 'awarded' : 'mismatch' };
  });
}

/* ── 用內容證明 FotMob 的 id ─────────────────────────────────────────
   一個 id 是不是它自稱的那個賽事,**看對上的場次在 martj42 叫什麼**,不看名字
   (德甲那次:奧地利甲也叫 Bundesliga;這次:CONCACAF 也叫 Nations League、女足的 10557 在 allLeagues 沒有 Women's)。
   martj42 只收男子 A 級賽,所以 id 挑到女足、U21、俱樂部賽的話**一場都對不上** —— 這一道本身就很硬。

   三個門檻,每一個都有來歷(probe-fotmob-intl run #43,2026-09-24):
     對上 ≥ 8 場      證明過的賽事裡最小的一個(Nations League D,2024/25)有 12 場;少於 8 場的樣本
                      一兩場撞名就能湊出比例,不算證據
     賽事名符合 ≥ 80%  友誼賽那個 id 對上的 61 場裡,martj42 記成 Friendly 的是 54 場,其餘是 Baltic Cup×4、
                      Diamond Jubilee×2、Tri-Nations Cup×1 —— FotMob 把邀請賽也放進友誼賽,所以友誼賽的
                      expect 收「友誼賽或其他」兩類(見 adapter),其餘賽事是 100%
     比分一致 ≥ 90%    對上的場次裡兩邊比分一致(判決比分算一致:那是記法不同,不是錯)。實測 60/61、47+1/48
   **一場一場的判決都留在產物裡**,門檻只決定整個賽事收不收。 */
export const PROOF_MIN_MATCHED = 8;
export const PROOF_MIN_SHARE = 0.8;
export const PROOF_MIN_AGREE = 0.9;
export const testExpect = (expect, t) => (typeof expect === 'function' ? expect(t) : expect.test(t));
export function proofFromCheck(rows, expect) {
  const hit = rows.filter(r => r.mj);
  const tours = new Map();
  for (const r of hit) tours.set(r.mj.tournament, (tours.get(r.mj.tournament) ?? 0) + 1);
  const expectHits = hit.filter(r => testExpect(expect, r.mj.tournament)).length;
  const agree = hit.filter(r => r.status === 'agree' || r.status === 'awarded').length;
  const share = hit.length ? expectHits / hit.length : 0;
  const agreeShare = hit.length ? agree / hit.length : 0;
  const status = {};
  for (const r of rows) status[r.status] = (status[r.status] ?? 0) + 1;
  const why = hit.length < PROOF_MIN_MATCHED ? `對上 martj42 的已完賽場次只有 ${hit.length} 場(要 ${PROOF_MIN_MATCHED} 場以上才算證據)`
    : share < PROOF_MIN_SHARE ? `對上的 ${hit.length} 場裡只有 ${expectHits} 場是預期的賽事(要 ${PROOF_MIN_SHARE * 100}% 以上)`
    : agreeShare < PROOF_MIN_AGREE ? `對上的 ${hit.length} 場裡比分一致的只有 ${agree} 場(要 ${PROOF_MIN_AGREE * 100}% 以上)`
    : null;
  return {
    ok: !why, why, matched: hit.length, expectHits, agree, status,
    tournaments: [...tours].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ t, n })),
  };
}

/* ── 評分落後的代價(2026-09-25 量的;補齊規劃第 5 項)────────────────────
   評分只從 martj42 算,而它收錄新賽果會晚幾天到幾週 —— 同一個比賽窗裡,第二輪開踢時評分還沒算進第一輪。
   這裡量「晚了 `days` 天」值多少:同一批驗收場次上,拿**開賽前一刻**的評分(正常的走查)
   對**`days` 天前凍結**的評分(那幾天的比賽都還沒算進去),逐場相減 RPS。
   正值 = 落後讓預測變差。分兩個母體報:全部驗收場次,以及「兩隊至少一隊在那幾天裡踢過」的場次
   (其餘場次兩個評分一模一樣,差是 0,攤進去只會把代價稀釋掉)。
   2026-09-25 第一次量:落後一週,全部 +0.0004 ± 0.0002(1.9 SE)、受影響的 60% +0.0006 ± 0.0003 ——
   模型整體對基準線的改善是 0.055,落後吃掉的大約 1%,而且沒有大過兩倍標準誤。
   所以**不**拿還沒被核對的 FotMob 賽果去做暫定更新(那要冒用錯比分的風險,換一個量不出來的好處)。
   數字每次建置重算、畫面讀產物;上面那一行是當時的紀錄,不是現況。 */
export function intlLagCost(matches, params, { from, minGames = INTL_MIN_GAMES, days = 7 } = {}) {
  const before = new Map();   // 隊 → [[比賽日, 那一天開賽前的評分], …]
  const rows = [];
  runIntlElo(matches, params, { onDay: (d, day) => {
    for (const r of day) {
      for (const [t, v] of [[r.m.home, r.rh], [r.m.away, r.ra]]) {
        let h = before.get(t);
        if (!h) before.set(t, (h = []));
        if (h.at(-1)?.[0] !== d) h.push([d, v]);
      }
      if (d >= from && r.nh >= minGames && r.na >= minGames) rows.push({ ...r, d });
    }
  } });
  if (rows.length < 2) return null;
  // c 之前的評分 = 這隊在 c 當天或之後第一個比賽日「開賽前」的評分(中間沒有比賽,評分不會變)。
  // 這一場本身就是這隊的比賽日,所以一定找得到。
  const asOf = (t, c) => {
    const h = before.get(t);
    let lo = 0, hi = h.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (h[mid][0] >= c) hi = mid; else lo = mid + 1; }
    return h[lo];
  };
  const back = d => new Date(Date.parse(`${d}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const all = [], hit = [];
  for (const r of rows) {
    const c = back(r.d);
    const [dh, rh] = asOf(r.m.home, c), [da, ra] = asOf(r.m.away, c);
    const o = outcomeOf(r.m);
    const p0 = probsFromE(r.E, params);
    const pL = probsFromE(expectedScore(rh, ra, { neutral: r.m.neutral, homeAdv: params.homeAdv }), params);
    const diff = rpsOf(pL, o) - rpsOf(p0, o);
    all.push(diff);
    // 那幾天裡有踢過:凍結時查到的比賽日比這一場早
    if (dh < r.d || da < r.d) hit.push(diff);
  }
  const stat = xs => {
    const n = xs.length;
    if (n < 2) return null;
    const m = xs.reduce((a, x) => a + x, 0) / n;
    const se = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1) / n);
    return { n, cost: m, se, z: se ? m / se : null };
  };
  return { days, all: stat(all), affected: stat(hit) };
}

/* ── 中立場的賽前推論(2026-09-25;補齊規劃第 6 項)──────────────────────
   FotMob 的賽程沒有「是不是中立場」這一欄,第一版一律當名單上的主隊在主場。驗收期(2022 起)裡
   真的是中立場的佔 35%,那一批每場 RPS 多付 0.0087(tune-intl 的 neutralUnknown)。
   這裡推一個機率 q(是中立場的機率),**只用開賽前 `lag` 天以前的 martj42**(上線時它比賽程慢):
     - 主辦型(世界盃、洲際決賽圈、區域盃這類「其他」):同一個賽事名最近 W 天已踢的比賽,
       一半以上是中立場 → 這一屆有主辦國。主隊在這一屆踢過非中立場 → 它就是主辦國,q = 0;
       否則 q = 那一屆的中立比例(加一平滑)。同一屆還沒有資料 → 這一類的先驗。
     - 主客場型(資格賽、國家聯賽)與友誼賽:**主隊**最近 N 場「列在主隊」的同類比賽有幾場在中立場,
       往這一類的先驗收縮(alpha 個虛擬場次)。以色列在匈牙利、烏克蘭在波蘭踢「主場」、非洲幾支
       主場不合格的隊在摩洛哥踢 —— 那是隊的習慣,不是賽事的。
   機率怎麼用:兩種場地各算一次三個機率,照 q 加權平均(`venueProbs`)。q = 0 時跟第一版**逐位元組相同**。
   參數(N、alpha、W、lag、各類先驗)在 tune-intl.mjs 用**調參期**挑,驗收期驗;建置每次重算驗收,
   沒過門檻就整批退回一律主場 —— 跟勝率本身同一套規矩。 */
export const venueGroup = t => {
  const c = tournamentClass(t);
  return c === 'friendly' ? 'friendly' : (c === 'worldcup' || c === 'continental') ? 'finals' : c;
};
const daysBefore = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
// 照日期排好的陣列裡,日期 < cutoff 的有幾筆
const countBefore = (arr, cutoff) => {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].date < cutoff) lo = mid + 1; else hi = mid; }
  return lo;
};
export function makeVenueModel(matches, { N, alpha, W, lag, prior }) {
  const homeListed = new Map(), byTour = new Map();
  for (const m of matches) {
    if (!homeListed.has(m.home)) homeListed.set(m.home, []);
    homeListed.get(m.home).push(m);
    if (!byTour.has(m.tournament)) byTour.set(m.tournament, []);
    byTour.get(m.tournament).push(m);
  }
  return ({ home, tournament, date }) => {
    const g = venueGroup(tournament);
    const cut = daysBefore(date, lag);
    const pri = prior[g] ?? 0;
    if (g === 'finals' || g === 'other') {
      const arr = byTour.get(tournament) ?? [];
      const start = daysBefore(date, lag + W);
      const rec = [];
      for (let i = countBefore(arr, cut) - 1; i >= 0 && arr[i].date >= start; i--) rec.push(arr[i]);
      const k = rec.filter(x => x.neutral).length;
      if (rec.length >= 2 && k / rec.length >= 0.5) {
        return rec.some(x => !x.neutral && x.home === home)
          ? { q: 0, basis: 'host', n: rec.length, k }
          : { q: (k + 1) / (rec.length + 2), basis: 'edition', n: rec.length, k };
      }
      return { q: pri, basis: 'prior', n: 0, k: 0 };
    }
    const arr = homeListed.get(home) ?? [];
    let n = 0, k = 0;
    for (let i = countBefore(arr, cut) - 1; i >= 0 && n < N; i--) {
      if (venueGroup(arr[i].tournament) !== g) continue;
      n++; k += arr[i].neutral ? 1 : 0;
    }
    return { q: (k + alpha * pri) / (n + alpha), basis: 'team', n, k };
  };
}
export function venueProbs(rh, ra, q, params) {
  const pH = probsFromE(expectedScore(rh, ra, { neutral: false, homeAdv: params.homeAdv }), params);
  if (!q) return pH;
  const pN = probsFromE(expectedScore(rh, ra, { neutral: true, homeAdv: params.homeAdv }), params);
  return { home: (1 - q) * pH.home + q * pN.home, draw: (1 - q) * pH.draw + q * pN.draw, away: (1 - q) * pH.away + q * pN.away };
}
/* 先驗:某一段期間(調參期)裡每一類有幾成是中立場。**母體跟回測同一批**(兩隊都至少 minGames 場)。 */
export function venuePrior(matches, params, { from, to, minGames = INTL_MIN_GAMES }) {
  const acc = {};
  for (const r of backtestIntl(matches, params, { from, to, minGames })) {
    const g = venueGroup(r.m.tournament);
    acc[g] ??= [0, 0];
    acc[g][0] += r.m.neutral ? 1 : 0; acc[g][1]++;
  }
  return Object.fromEntries(Object.entries(acc).map(([g, [k, n]]) => [g, k / n]));
}
/* 驗收:同一批比賽三種算法逐場比 RPS —— 一律主場(第一版)、推論、拿賽後才知道的中立場欄位當答案。
   gain = 一律主場 − 推論(正值 = 推論比較好),oracle = 一律主場 − 當答案的那一種。
   **「當答案」不是嚴格的上限**:主客場型那一類推論(0~1 之間的機率)反而比二元欄位好一點 ——
   名義主隊在中立場踢,兩段期間都比中立場的預期多拿 0.035~0.050 分(主場分乘 0.25~0.5 的 RPS 最好),
   但那個改善沒有大過標準誤,所以只記成觀察,模型不另外給它參數。 */
export function venueBacktest(matches, params, venue, { from, to, minGames = INTL_MIN_GAMES }) {
  const guess = makeVenueModel(matches, venue);
  const home = [], inferred = [], truth = [], groups = [];
  runIntlElo(matches, params, {
    until: to ? nextDay(to) : null,
    onDay: (d, day) => {
      if (d < from || (to && d > to)) return;
      for (const r of day) {
        if (r.nh < minGames || r.na < minGames) continue;
        const o = outcomeOf(r.m);
        const q = guess({ home: r.m.home, tournament: r.m.tournament, date: r.m.date }).q;
        home.push(rpsOf(venueProbs(r.rh, r.ra, 0, params), o));
        inferred.push(rpsOf(venueProbs(r.rh, r.ra, q, params), o));
        truth.push(rpsOf(venueProbs(r.rh, r.ra, r.m.neutral ? 1 : 0, params), o));
        groups.push(venueGroup(r.m.tournament));
      }
    },
  });
  const diff = (a, b, keep = () => true) => {
    const xs = a.map((x, i) => x - b[i]).filter((_, i) => keep(i));
    const n = xs.length;
    if (n < 2) return null;
    const m = xs.reduce((s, x) => s + x, 0) / n;
    const se = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) / n);
    return { n, gain: m, se, z: se ? m / se : null };
  };
  const byGroup = {};
  for (const g of [...new Set(groups)].sort()) {
    const keep = i => groups[i] === g;
    byGroup[g] = { inferred: diff(home, inferred, keep), oracle: diff(home, truth, keep) };
  }
  return { n: home.length, inferred: diff(home, inferred), oracle: diff(home, truth), byGroup,
    rps: home.length ? inferred.reduce((s, x) => s + x, 0) / home.length : null };
}

/* ── 球隊頁:評分走勢與最近幾場(每一場的評分變化)──────────────────────
   走同一條 runIntlElo 與 eloDelta,畫面上「這一場 +12」加起來就是排名上那個數字。
   `from` 之後的每一場記一個點(走勢圖);`recentN` 是最近幾場的明細。
   場地是**相對這一隊**的:主場 H、客場 A、中立場 N(martj42 的 neutral 欄;它記的是當地的事實,
   跟 FotMob 賽程「不知道是不是中立場」不是同一件事)。 */
export function intlTeamHistory(matches, params, { keys, from, recentN = 12 }) {
  const want = new Set(keys);
  const trend = new Map(), recent = new Map();
  runIntlElo(matches, params, { onDay: (d, day) => {
    /* 同一隊同一天踢兩場(martj42 有 139 組,2000 年後 Fiji 2024-09-02、聖克里斯多福及尼維斯 2025-05-25):
       兩場都用開賽前的評分預測、變化一起加上去(runIntlElo 的定義)。所以「賽後評分」要在同一天裡**依序累加** ——
       第一版每一場都寫「開賽前 + 這一場」,第二場就少了第一場的變化,逐場紀錄跟排名接不起來(npm test 抓到的)。 */
    const dayCur = new Map();
    for (const { m, E, rh, ra } of day) {
      const dr = eloDelta(m, E, params);
      const sides = [
        [m.home, m.away, rh, dr, m.neutral ? 'N' : 'H', m.fh, m.fa],
        [m.away, m.home, ra, -dr, m.neutral ? 'N' : 'A', m.fa, m.fh],
      ];
      for (const [t, opp, r0, delta, venue, gf, ga] of sides) {
        if (!want.has(t)) continue;
        const after = (dayCur.get(t) ?? r0) + delta;
        dayCur.set(t, after);
        if (d >= from) {
          let tr = trend.get(t);
          if (!tr) trend.set(t, (tr = []));
          tr.push([d, Math.round(after)]);
        }
        let rc = recent.get(t);
        if (!rc) recent.set(t, (rc = []));
        rc.push({ d, o: opp, v: venue, s: [gf, ga], t: m.tournament, dr: Math.round(delta * 10) / 10, r: Math.round(after) });
        if (rc.length > recentN) rc.shift();
      }
    }
  } });
  return { trend, recent };
}

/* ── 歷來交手(只當資訊,**不進模型**)──────────────────────────────────
   比分含延長、不含 PK(martj42 的慣例)—— PK 決勝的那一場在這裡是和局。
   鍵是兩隊名字排序後用 | 接起來,`w` 是 [前一隊勝, 和, 後一隊勝]、`g` 是 [前一隊進球, 後一隊進球]。 */
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export function intlH2H(matches, pairs, { lastN = 5 } = {}) {
  const out = new Map(pairs.map(([a, b]) => [pairKey(a, b), null]));
  for (const m of matches) {
    const k = pairKey(m.home, m.away);
    if (!out.has(k)) continue;
    let s = out.get(k);
    const [first] = k.split('|');
    if (!s) out.set(k, (s = { n: 0, w: [0, 0, 0], g: [0, 0], since: m.date, last: [] }));
    const gA = m.home === first ? m.fh : m.fa, gB = m.home === first ? m.fa : m.fh;
    s.n++;
    s.w[gA > gB ? 0 : gA === gB ? 1 : 2]++;
    s.g[0] += gA; s.g[1] += gB;
    s.last.push({ d: m.date, h: m.home, a: m.away, s: [m.fh, m.fa], t: m.tournament, n: m.neutral });
    if (s.last.length > lastN) s.last.shift();
  }
  return out;
}

/* ── 分組積分榜(2026-09-25;形狀是 probe-intl-tables run #45 看過才寫的)────────────
   **積分由本站自己用已完賽的賽果算,上游的表只拿來取分組名單、官方排序與核對。**
   實測過上游的表會把**進行中**的比賽算進去(中北美國聯 A 級那一列 Costa Rica `played: 1`、`3-0`,
   同一列的 `ongoing` 說那場還在踢)—— 照印的話,積分榜會跟本站「還沒完賽」的賽程自相矛盾。

   哪幾場算:**輪次是數字的場次**(分組賽的第幾輪),而且兩隊都在這一組的名單裡。
   不看比賽的 group 欄位:中北美國聯 A、B、C 三級都有「第 1 組」,海灣盃的分組賽根本沒有 group。
   預賽(非洲盃資格賽三月那一輪的 round 是 `final`)與淘汰賽(海灣盃 1/2、final)不算。

   逐隊核對,判決分三種(跟歐冠官方積分榜那一套同一個分法):
     agree     場數一樣,勝和負、進失球、積分也都一樣
     pending   場數不一樣 —— 上游算進了進行中的比賽,或上游還沒更新;**不是錯**,只回報、畫面講
     mismatch  場數一樣卻對不上 —— 那才是真的有人算錯
   整組都 agree 才照上游的名次排(官方的同分規則 —— 相互對戰等 —— 本站沒有實作,借上游的);
   否則照積分、淨勝球、進球排,並在畫面上講「同分的官方排序規則沒有套用」。 */
export function intlStandings(groups, matches) {
  if (!Array.isArray(groups)) return [];
  const leaguePhase = matches.filter(m => m.state === 'FT' && Array.isArray(m.final) && /^\d+$/.test(String(m.round ?? '')));
  return groups.map(g => {
    const ids = new Set(g.rows.map(r => r.fmId).filter(Boolean));
    const acc = new Map([...ids].map(id => [id, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }]));
    const counted = leaguePhase.filter(m => ids.has(m.home?.fmId) && ids.has(m.away?.fmId));
    for (const m of counted) {
      const [fh, fa] = m.final;
      for (const [id, gf, ga] of [[m.home.fmId, fh, fa], [m.away.fmId, fa, fh]]) {
        const a = acc.get(id);
        a.p++; a.gf += gf; a.ga += ga;
        if (gf > ga) { a.w++; a.pts += 3; } else if (gf === ga) { a.d++; a.pts += 1; } else a.l++;
      }
    }
    const rows = g.rows.map(r => {
      const o = acc.get(r.fmId) ?? { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
      const up = { p: r.played, w: r.wins, d: r.draws, l: r.losses, gf: r.gf, ga: r.ga, pts: r.pts };
      const check = up.p !== o.p ? 'pending'
        : (up.w === o.w && up.d === o.d && up.l === o.l && up.gf === o.gf && up.ga === o.ga && up.pts === o.pts) ? 'agree' : 'mismatch';
      return { fmId: r.fmId, name: r.name, upIdx: r.idx, ...o, gd: o.gf - o.ga, up, check,
        deduction: r.deduction ?? null, live: r.live ?? null };
    });
    const status = rows.some(r => r.check === 'mismatch') ? 'mismatch' : rows.some(r => r.check === 'pending') ? 'pending' : 'ok';
    const official = status === 'ok';
    rows.sort(official
      ? (a, b) => (a.upIdx ?? 99) - (b.upIdx ?? 99)
      : (a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || (a.upIdx ?? 99) - (b.upIdx ?? 99));
    rows.forEach((r, i) => { r.pos = i + 1; });
    return { name: g.name, fmId: g.fmId, legend: g.legend ?? [], status, orderBy: official ? 'official' : 'computed',
      counted: counted.length, live: [...new Set(rows.map(r => r.live).filter(Boolean))], rows };
  });
}
