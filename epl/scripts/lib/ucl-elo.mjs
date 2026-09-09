/* 跨聯賽評分與歐冠賽前預測 —— 階段 C(2026-09-09)。
 *
 * ## 為什麼可以做,以及做法為什麼是「沒有新模型」
 *
 * 歐冠的難處是**跨聯賽不可比**:各聯賽自己的 Elo 是一個封閉池,
 * 拜仁的 1650 與 PSV 的 1610 不在同一把尺上。
 *
 * 做法是**單一 Elo 池**:八個聯賽的域內賽果 + 歐冠的跨聯賽賽果按日期
 * 全部餵進**同一個 `buildElo`**。歐冠場次就是把各池接起來的橋
 * (英超↔英冠另外有天然的橋 —— 升降級讓球隊帶著評分換池)。
 * 所以這裡**沒有新模型、沒有新參數**:用的是本站域內預測那一套 Elo,
 * 一個係數都沒有為歐冠調過。
 *
 * ## 量過才做的(鐵則二)
 *
 * 走查回測:每一場只用該場**之前**的比賽算評分,再預測。
 *
 *   首次驗收(2026-09-09,只有 openfootball 那八個聯賽,25/36 隊有評分):
 *     池化 Elo 0.2227 / 基準線 0.2376,改善 0.0149 ± 0.0061(2.4 SE)→ 通過
 *   接上 FotMob 那十六個聯賽之後(34/36 隊):
 *     0.2107 / 0.2371,改善 0.0265 ± 0.0058(4.6 SE),回測樣本 219 → 350 場
 *
 * 基準線用**這批比賽自己的** H/D/A 分佈 —— 那對基準線有利(它偷看了答案),
 * 贏過它才算數。兩季各自看也都贏,不是靠某一季。
 *
 * **上面是當時的量測紀錄,不是現況。** 現況每次 build 都會重算並寫進
 * `web/data/ucl-elo.json` 的 `model`,畫面上顯示的是那一份 ——
 * 不要把這裡的數字當成現在的值,也不要為了對齊而回頭改它們。
 *
 * 涵蓋率提高之後 RPS 反而下降是預期內的:新加的場次含大量「強隊對弱隊」,
 * 比原本那批(只有大聯賽互打)好預測。**這代表原本那個數字偏悲觀,不是模型變好了。**
 *
 * ## 量過而**沒有通過**的兩個修正 —— 不要再加回來
 *
 * 1. **逐聯賽的 Elo 補正。** 動機看起來很硬:診斷顯示葡超被高估 0.34 分/場、
 *    英超被低估 0.34 分/場。但 (a) 帶上標準誤之後只有英超到 2.4 SE,
 *    而測了 7 個聯賽,純靠運氣就有 0.28 的機率至少一個超過 2SE;
 *    (b) 用 2024-25 調、2025-26 驗收,改善只有 0.0009 ± 0.0079 —— 沒通過;
 *    (c) 兩季調出來的補正**互相矛盾**(荷甲 +5 vs −181,相關性 0.39)。
 *    八個參數配一百來場,調出來的是雜訊。
 *
 * 2. **機率銳化**(把實力差乘上 k)。校準表看起來太保守,
 *    但一季調、另一季驗收只有 0.0030 ± 0.0021(1.4 SE),而且 k 本身不穩(1.30 vs 1.85)。
 *
 * 兩個都是「直覺上應該有用」的典型 —— 鐵則二說的就是這種。
 *
 * ## 界線(鐵則三)
 *
 * openfootball 只涵蓋八個聯賽。**另外十六個走 FotMob**(2026-09-09 探測證實全部都有),
 * 對照走人工表 `data/manual/ucl-league-teams.json` —— **不用寬鬆比對**:
 * 探測的隊名清單證實希臘 `Olympiacos` 與賽普勒斯 `Olympiakos Nicosia`、
 * 希臘 `AEK Athens` 與賽普勒斯 `AEK Larnaca` 會撞,自動比對會靜靜挑一個。
 *
 * 這十六個聯賽的球隊身分**帶聯賽前綴**(`fmId`),既有八個維持裸隊名 ——
 * 理由見 `fmId` 那一段。
 *
 * **對不上的仍然不給預測**,不是給一個猜的數字(鐵則三)。
 * 哪些聯賽一份快取都沒有會記在產物的 `pool.missingLeagues`,空陣列才是正常。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMatches } from './adapters/openfootball.mjs';
import { buildElo, eloProbs } from './elo.mjs';
import { round } from './util.mjs';
import { UCL_LEAGUES } from './ucl-standings.mjs';

/* 池子從哪一季起。**量過的**:起始 2021-22 → 回測 RPS 0.2206、2022-23 → 0.2208、
   2023-24 → 0.2227、2024-25 → 0.2300(而且少 10 場,因為球隊還沒有評分)。
   2023-24 是本站三個聯賽的 openfootball 快取共同最早的一季,八個聯賽在這裡對齊;
   再往前只換到 0.002,不值得為它多存四份快取。 */
export const POOL_START = '2023-24';

/* **十六個 FotMob 聯賽的域內賽果目前不進評分池。** 這不是「還沒接」,是量過之後的決定。
 *
 * 2026-09-09 分三次量到的:
 *
 *   八個 openfootball 聯賽          池 9,225 場  25/36 隊  改善 0.0149 ± 0.0061(2.4 SE)通過
 *   + 十六個聯賽的**本季**          池 10,780    34/36     改善 0.0265 ± 0.0058(4.6 SE)通過
 *   + 十六個聯賽的**四季完整歷史**  池 19,972    35/36     改善 0.0063 ± 0.0033(1.9 SE)**沒通過**
 *
 * 也就是說**補上完整歷史反而讓模型變差**(RPS 0.2107 → 0.2306)。原因看得出來:
 * 這些聯賽多半是頂重的(Celtic、Galatasaray、Salzburg、Slavia 在國內幾乎橫掃),
 * 歷史越長,它們靠痛宰國內對手累積的 Elo 越高,而 381 場橋根本不夠把它壓回來 ——
 * 跟階段 C 一開始在葡超/荷甲看到的是同一個病,只是這次有十六個聯賽一起放大。
 *
 * 「逐聯賽補正」已經試過而且**沒有通過**(一季調、另一季驗收只有 0.0009 ± 0.0079,
 * 兩季的參數還互相矛盾),所以沒有經過驗收的修正可以用。
 *
 * **只用本季那一版看起來最好,但那個 4.6 SE 是在「資料剛好補到一半」時量到的**,
 * 不是設計出來的配置 —— 拿它當結論就是挑一個好看的數字,那正是鐵則二在防的事。
 * 所以退回**唯一從頭到尾都通過的配置**:八個聯賽。這些球隊因此沒有評分、
 * 那些場次不給預測(鐵則三),而畫面上講得出為什麼。
 *
 * 要打開的話,先做「限制歷史深度」的正式驗收:一季調、另一季驗收,
 * 而且改善要大過 2 倍成對標準誤。抓下來的快取與人工對照表都留著,隨時可以測。 */
export const FOTMOB_IN_POOL = false;

/* 池子裡的八個聯賽。前三個是本站的聯賽(用它們原本的快取,不重抓),
   後五個是為歐冠抓的。**這份清單不要另外複製一份** —— 後五個直接取 UCL_LEAGUES。 */
export const POOL_LEAGUES = [
  { key: 'pl', zh: '英超', dir: 'openfootball' },
  { key: 'es1', zh: '西甲', dir: 'openfootball-la-liga' },
  { key: 'en2', zh: '英冠', dir: 'openfootball-championship' },
  ...UCL_LEAGUES.map(l => ({ key: l.key, zh: l.zh, dir: join('openfootball-ucl', l.key) })),
];

/* openfootball 沒有的那十六個聯賽走 FotMob,對照表是**人工的**
   (`data/manual/ucl-league-teams.json`)。不用寬鬆比對:探測的隊名清單證實
   希臘 `Olympiacos` 與賽普勒斯 `Olympiakos Nicosia`、希臘 `AEK Athens` 與
   賽普勒斯 `AEK Larnaca` 正規化之後都會撞,自動比對會靜靜挑一個。 */
export function fotmobLeagueMap(root) {
  const p = join(root, 'data', 'manual', 'ucl-league-teams.json');
  if (!existsSync(p)) return { leagues: [], byFullName: new Map() };
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { leagues: j.leagues ?? [], byFullName: new Map((j.teams ?? []).map(t => [t.fullName, t])) };
}

/* 這十六個聯賽的球隊身分**加上聯賽前綴**。
   理由是撞名:探測實際看到 `Olympiacos`(希臘)與 `Olympiakos Nicosia`(賽普勒斯)、
   `Slovan Bratislava`(斯洛伐克)與 `Slovan Liberec`(捷克)。加前綴之後
   兩支不同的球隊不可能共用一個評分,連「正規化之後剛好一樣」的風險都沒有。

   既有八個聯賽維持裸隊名 —— 那是**刻意的**:英超與英冠共用隊名,
   升降級時球隊帶著評分換池,那是我們要的橋。這十六個一國只有一級,沒有那種移動。 */
const fmId = (lgKey, name) => `${lgKey}:${name}`;

const seasonsFrom = (start, current) => {
  const y0 = Number(start.slice(0, 4)), y1 = Number(current.slice(0, 4));
  const out = [];
  for (let y = y0; y <= y1; y++) out.push(`${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  return out;
};

/* 一季裡的**每一場**歐冠比賽。聯賽階段在 `leagueMatches`,
   淘汰賽在 `rounds[].ties[].legs[]` —— 兩個地方。
   **走整份收一次,不列舉區塊**:第一版只讀 leagueMatches,淘汰賽那 45 場/季
   靜靜掉了(橋從 219 掉到 152,回測直接從通過變成不通過,而且不會報錯)。
   `uclClubs` 用同一個理由寫成走訪式的。 */
export function uclSeasonMatches(season) {
  const out = [];
  const seen = new Set();
  const walk = v => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    if (v.home?.fullName && v.away?.fullName && 'final' in v && v.id != null && !seen.has(v.id)) {
      seen.add(v.id); out.push(v);
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(season);
  return out;
}

/* 歐冠比賽轉成池子裡的一場。**比分只讀 `final`** —— 分段欄位不是累計值,
   本站在歐冠決賽上踩過(`et` 是延長賽的增量)。
   PK 收場的場次整場不收:那一場的勝負不是 90 分鐘踢出來的,
   拿去更新 Elo 等於把擲硬幣的結果算進實力。 */
const uclPoolMatch = (m, season) => {
  if (!m.played || !Array.isArray(m.final)) return null;
  if (Array.isArray(m.pens) && m.pens.length) return null;
  const [fh, fa] = m.final;
  if (!Number.isFinite(fh) || !Number.isFinite(fa)) return null;
  return { season, date: (m.kickoff ?? '').slice(0, 10), home: m.home?.fullName, away: m.away?.fullName,
    fh, fa, played: true, comp: 'ucl' };
};

/* 整池的比賽。隊名就是身分 —— 這八個聯賽裡本站只有三個有隊碼,
   而歐冠那一份給的是 football-data 的 fullName,兩邊唯一共通的鍵就是隊名。
   對照**只用精確比對**:模糊比對會靜靜對錯球隊(本站在盃賽頁踩過兩次)。 */
export function poolMatches(root, ucl) {
  const current = (ucl?.seasons ?? []).find(s => s.current)?.label ?? null;
  if (!current) return null;
  const seasons = seasonsFrom(POOL_START, current);

  const matches = [];
  const leagueOf = new Map();
  const perLeague = [];
  for (const lg of POOL_LEAGUES) {
    let got = 0, seen = 0;
    for (const season of seasons) {
      const file = join(root, 'data', 'raw', lg.dir, `${season}.json`);
      if (!existsSync(file)) continue;
      /* 走共用的 adapter:比分有兩種格式(`{"score":[0,0]}` 與 `{"score":{"ft":…}}`),
         自己數會把 0:0 當成「沒有比分」—— 那條坑本站踩過而且把錯的數字寫進三個檔案。 */
      const ms = loadMatches({ root, competition: lg.key, season, codeOf: n => n, rawDir: lg.dir });
      for (const m of ms) {
        leagueOf.set(m.home, lg.key); leagueOf.set(m.away, lg.key); seen += 1;
        if (!m.played || m.fh == null || m.fa == null) continue;
        matches.push({ season, date: m.date, home: m.home, away: m.away, fh: m.fh, fa: m.fa, played: true, comp: lg.key });
        got += 1;
      }
    }
    perLeague.push({ key: lg.key, zh: lg.zh, played: got, total: seen });
  }

  /* openfootball 沒有的那十六個(FotMob)。抓取器自己驗過賽季與對照表,
     這裡只讀落地的快取 —— 沒抓到的聯賽就是沒有,不影響其他聯賽。 */
  const fm = FOTMOB_IN_POOL ? fotmobLeagueMap(root) : { leagues: [], byFullName: fotmobLeagueMap(root).byFullName };
  /* 對照表裡有、卻**一份快取都沒有**的聯賽要報出來。
     不報的話它只是安靜地從 perLeague 消失,而畫面上只是少幾支球隊的預測 ——
     實際踩過:挪威與哈薩克是春秋制,賽季字串不同,第一次抓一份都沒落地而完全沒有跡象。 */
  const fmMissing = [];
  for (const lg of fm.leagues) {
    let got = 0, seen = 0;
    for (const season of seasons) {
      const file = join(root, 'data', 'raw', 'fotmob-ucl-leagues', lg.key, `${season}.json`);
      if (!existsSync(file)) continue;
      let j; try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
      for (const m of (j.matches ?? [])) {
        if (!m.home || !m.away) continue;
        const h = fmId(lg.key, m.home), a = fmId(lg.key, m.away);
        leagueOf.set(h, lg.key); leagueOf.set(a, lg.key); seen += 1;
        if (!m.finished || !Array.isArray(m.score) || m.score.length !== 2) continue;
        matches.push({ season, date: m.date, home: h, away: a, fh: m.score[0], fa: m.score[1], played: true, comp: lg.key });
        got += 1;
      }
    }
    if (seen) perLeague.push({ key: lg.key, zh: lg.zh, played: got, total: seen });
    else fmMissing.push(lg.zh);
  }

  /* 歐冠球隊 → 池子裡的身分。兩條路:
     一、八個 openfootball 聯賽:`fullName` 精確命中隊名(本來就一字不差)。
     二、十六個 FotMob 聯賽:走**人工對照表**,身分帶聯賽前綴。
     兩條都對不上就是沒有評分 —— 不猜(鐵則三)。 */
  const idOf = fullName => {
    if (leagueOf.has(fullName)) return fullName;
    const t = fm.byFullName.get(fullName);
    if (!t) return null;
    const id = fmId(t.league, t.fotmob);
    return leagueOf.has(id) ? id : null;
  };

  // 歐冠:跨聯賽的橋。掛不回聯賽賽果的球隊整場不收(鐵則三)
  let bridges = 0;
  const unrated = new Map();
  for (const s of (ucl?.seasons ?? [])) {
    for (const raw of uclSeasonMatches(s)) {
      const m = uclPoolMatch(raw, s.label);
      if (!m) continue;
      const h = idOf(m.home), a = idOf(m.away);
      if (!h) unrated.set(raw.home?.name ?? m.home, (unrated.get(raw.home?.name ?? m.home) ?? 0) + 1);
      if (!a) unrated.set(raw.away?.name ?? m.away, (unrated.get(raw.away?.name ?? m.away) ?? 0) + 1);
      if (!h || !a) continue;
      matches.push({ ...m, home: h, away: a }); bridges += 1;
    }
  }
  matches.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { matches, leagueOf, perLeague, bridges, seasons, idOf, fmMissing,
    unrated: [...unrated].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n })) };
}

// 排序機率分數。三分類,越低越好 —— 跟本站域內回測同一個指標
export function rps(p, outcome) {
  const o = [0, 0, 0]; o[outcome] = 1;
  let c1 = 0, c2 = 0, s = 0;
  for (let i = 0; i < 2; i++) { c1 += p[i]; c2 += o[i]; s += (c1 - c2) ** 2; }
  return s / 2;
}

// 成對比較的標準誤。改善沒有大過它的兩倍就是雜訊(鐵則二)
export function pairedDiff(a, b) {
  const d = a.map((x, i) => x - b[i]);
  const m = d.reduce((x, y) => x + y, 0) / d.length;
  const v = d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1);
  return { diff: m, se: Math.sqrt(v / d.length) };
}

/* 走查回測:每一場只用該場**之前**的比賽算評分。
   按日期分批重算(一天一次,不是一場一次)—— 同一天的比賽互相看不到對方的結果,
   這是走查該有的樣子,而且省掉 200 次重算。 */
export function backtest(pool) {
  const ucl = pool.matches.filter(m => m.comp === 'ucl');
  const dates = [...new Set(ucl.map(m => m.date))].sort();
  const rows = [];
  for (const d of dates) {
    const before = pool.matches.filter(m => m.date < d);
    if (before.length < 2000) continue;         // 暖機不足不預測
    const elo = buildElo(before);
    for (const m of ucl.filter(x => x.date === d)) {
      const rh = elo.get(m.home)?.elo, ra = elo.get(m.away)?.elo;
      if (rh == null || ra == null) continue;
      const p = eloProbs(rh, ra);
      rows.push({ date: d, season: m.season, p: [p.home, p.draw, p.away],
        o: m.fh > m.fa ? 0 : m.fh === m.fa ? 1 : 2 });
    }
  }
  if (rows.length < 50) return null;            // 樣本太少不給數字,也不給預測

  /* 基準線用**這批比賽自己的** H/D/A 分佈 —— 那對基準線有利(它偷看了答案),
     所以贏過它才算數。用一個外部的固定值會讓改善看起來比實際大。 */
  const cnt = [0, 0, 0];
  for (const r of rows) cnt[r.o] += 1;
  const bp = cnt.map(x => x / rows.length);

  const model = rows.map(r => rps(r.p, r.o));
  const base = rows.map(r => rps(bp, r.o));
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const g = pairedDiff(base, model);

  const perSeason = [...new Set(rows.map(r => r.season))].sort().map(s => {
    const sub = rows.filter(r => r.season === s);
    return { season: s, n: sub.length,
      rps: round(mean(sub.map(r => rps(r.p, r.o))), 4),
      baseline: round(mean(sub.map(r => rps(bp, r.o))), 4) };
  });

  return {
    n: rows.length,
    rps: round(mean(model), 4),
    baseline: round(mean(base), 4),
    baselineRates: bp.map(x => round(x, 3)),
    improvement: round(g.diff, 4),
    se: round(g.se, 4),
    passes: g.diff > 2 * g.se,
    perSeason,
  };
}

export function uclElo(root, ucl) {
  const pool = poolMatches(root, ucl);
  if (!pool) return null;
  const season = (ucl?.seasons ?? []).find(s => s.current);
  if (!season) return null;

  const elo = buildElo(pool.matches);
  const bt = backtest(pool);

  /* 評分掛回歐冠球隊(id 當鍵,跟 ucl-standings 一致)。
     **只認精確的 fullName** —— 對不上就沒有評分,也就沒有預測。 */
  const ratings = {};
  const rated = new Set();
  const seasonMatches = uclSeasonMatches(season);
  for (const m of seasonMatches) {
    for (const side of ['home', 'away']) {
      const c = m[side]; if (!c?.id || ratings[String(c.id)]) continue;
      /* 走跟橋**同一個** idOf —— 各寫一份的話,某個聯賽在橋那邊接得起來、
         在掛評分這邊接不起來,而畫面上只是少幾場預測,不會報錯。 */
      const id = pool.idOf(c.fullName);
      const r = id ? elo.get(id) : null;
      if (!r) continue;
      ratings[String(c.id)] = { elo: round(r.elo, 1), league: pool.leagueOf.get(id) ?? null, name: c.name ?? c.fullName };
      rated.add(String(c.id));
    }
  }

  /* 預測只給**還沒踢而且兩隊都有評分**的場次。
     一隊沒有評分就整場不給 —— 留一個半套的預測比不給更糟(鐵則三)。
     回測沒通過的話一場都不給:沒有證據的預測不是預測。 */
  const fixtures = [];
  let bothRated = 0;
  for (const m of seasonMatches) {
    const h = ratings[String(m.home?.id)], a = ratings[String(m.away?.id)];
    if (h && a) bothRated += 1;
    if (m.played || !h || !a || !bt?.passes) continue;
    const p = eloProbs(h.elo, a.elo);
    fixtures.push({ id: m.id, kickoff: m.kickoff ?? null, matchday: m.matchday ?? null,
      home: m.home.id, away: m.away.id,
      p: [round(p.home, 3), round(p.draw, 3), round(p.away, 3)] });
  }

  const teamsTotal = season.teamsTotal ?? null;
  const total = seasonMatches.length;
  return {
    note: '跨聯賽 Elo:八個聯賽的域內賽果加上歐冠場次餵進同一個評分池,歐冠場次就是把各聯賽接起來的橋。用的是本站域內預測那一套 Elo,沒有為歐冠調過任何係數。',
    source: 'openfootball + football-data.org',
    poolStart: POOL_START,
    seasons: pool.seasons,
    pool: { matches: pool.matches.length, bridges: pool.bridges, teams: elo.size, leagues: pool.perLeague,
      /* 對照表裡有、卻一份快取都沒有的聯賽。空陣列才是正常 —— 有東西代表抓取那邊有問題,
         而症狀只會是「少幾支球隊的預測」,不會報錯。 */
      missingLeagues: pool.fmMissing },
    model: bt,
    ratings,
    fixtures,
    coverage: {
      ratedTeams: rated.size, totalTeams: teamsTotal,
      bothRated, totalMatches: total,
      /* 沒有評分的球隊,**從本季的球隊算起,不是只從已完賽的橋**。
         橋只掃已完賽的場次,所以還沒踢過的球隊不會出現在裡面 ——
         實測 2026-09-09:35/36 隊有評分(還缺 1 隊),而清單卻是空的,
         於是畫面講不出「為什麼這一場沒有預測」。清單是給讀者看的,
         要涵蓋的是**本季所有沒有評分的球隊**,不是「曾經踢過而掛不上的」。 */
      unrated: (() => {
        const seen = new Map();
        for (const m of seasonMatches) for (const side of ['home', 'away']) {
          const c = m[side];
          if (!c?.id || ratings[String(c.id)]) continue;
          seen.set(c.name ?? c.fullName, (seen.get(c.name ?? c.fullName) ?? 0) + 1);
        }
        return [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 30).map(([name, n]) => ({ name, n }));
      })(),
    },
  };
}
