/* 歐冠球隊所屬聯賽的積分榜 —— 只為了歐冠那一頁的「賽前對比」。
 *
 * **這一層做的事只有一件**:把德甲 / 義甲 / 法甲的賽果算成積分榜,
 * 再用**精確的隊名**掛回歐冠的球隊 id。沒有球員、沒有 xG、沒有預測。
 *
 * 三個刻意的決定:
 *
 * 1. **解析與計算都用既有的共用函式**,一行都不自己寫:
 *    openfootball 的比分有兩種格式(`{"score":[0,0]}` 與 `{"score":{"ft":…}}`),
 *    自己數會數錯 —— 那條坑本站踩過,而 adapter 的 readScore 本來就兩種都讀。
 *    積分榜同理走 lib/table.mjs 的 buildTable,所以欄位跟英超西甲**完全一樣**,
 *    前端的對比元件不用為這三個聯賽多寫一條分支。
 *
 * 2. **對照用 football-data 的 `fullName` 精確比對,沒有任何模糊比對。**
 *    實測本季 11 支球隊 11 支精確命中(`FC Internazionale Milano`、
 *    `Racing Club de Lens`、`FC Bayern München` 都一字不差)。
 *    對不上就是沒有對比 —— 模糊比對會靜靜對錯球隊,這個站在盃賽頁踩過兩次。
 *    對不上的隊名會回報出來(`unmatched`),那份清單不是裝飾。
 *
 * 3. **隊名當鍵。** 這三個聯賽沒有本站的隊碼(本站沒有它們的球隊頁),
 *    所以 buildTable 的 code 直接用 openfootball 的隊名。
 *    不要為它們發明一組隊碼 —— 發明了就會有人拿去連結,而連過去是空頁。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadMatches } from './adapters/openfootball.mjs';
import { buildTable } from './table.mjs';

export const UCL_LEAGUES = [
  { key: 'de1', zh: '德甲', en: 'Bundesliga' },
  { key: 'it1', zh: '義甲', en: 'Serie A' },
  { key: 'fr1', zh: '法甲', en: 'Ligue 1' },
];

/* 產物只留對比會用到的欄位。整份 buildTable 的 row 有半場分段、逐場序列、
   最大勝負…那些這一頁用不到,而這份檔要跟 ucl.json 一起下載。 */
const slim = r => ({
  name: r.code, pos: r.pos, p: r.p, w: r.w, d: r.d, l: r.l,
  gf: r.gf, ga: r.ga, gd: r.gd, pts: r.pts, ppg: r.ppg,
  avgGF: r.avgGF, avgGA: r.avgGA, cleanSheets: r.cleanSheets,
  form: r.form ?? null,
  /* p 要留著:場均在 p=0 時是 0,而 0 跟「還沒踢過」是兩件事(前端靠 p 分辨) */
  home: { p: r.home?.p ?? 0, ppg: r.home?.ppg ?? null },
  away: { p: r.away?.p ?? 0, ppg: r.away?.ppg ?? null },
});

/* ucl 產物裡每支球隊帶著 football-data 的 id 與 fullName。
   走整份收一次,不列舉區塊 —— 列舉的話以後多一個區塊就會有一批球隊靜靜掉隊
   (uclTeamAssets 同一個理由)。 */
function uclClubs(ucl) {
  const out = new Map();
  const walk = v => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    if (v.id != null && typeof v.fullName === 'string' && v.fullName) {
      if (!out.has(v.fullName)) out.set(v.fullName, { id: v.id, name: v.name ?? v.fullName, code: v.code ?? null });
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk((ucl?.seasons ?? []).find(s => s.current) ?? null);
  return out;
}

export function uclStandings(root, ucl) {
  const season = (ucl?.seasons ?? []).find(s => s.current)?.label ?? null;
  if (!season) return null;
  const clubs = uclClubs(ucl);

  const leagues = [];
  const byClub = {};          // fullName → { league, row }
  for (const lg of UCL_LEAGUES) {
    const file = join(root, 'data', 'raw', 'openfootball-ucl', lg.key, `${season}.json`);
    if (!existsSync(file)) continue;
    /* codeOf 用恆等函式:隊名就是鍵。tolerant 不開 —— 這裡沒有「不相干的球隊」,
       對照不到就是資料有問題,要吵(adapter 的註解寫得很清楚)。 */
    const matches = loadMatches({
      root, competition: lg.key, season,
      codeOf: name => name,
      rawDir: join('openfootball-ucl', lg.key),
    });
    const names = [...new Set(matches.flatMap(m => [m.home, m.away]))];
    const rows = buildTable(matches, names).map(slim);
    leagues.push({ key: lg.key, zh: lg.zh, en: lg.en, teams: rows.length,
      played: matches.filter(m => m.played).length, total: matches.length });
    for (const r of rows) byClub[r.name] = { league: lg.key, row: r };
  }
  if (!leagues.length) return null;

  /* 掛回歐冠的球隊。**只認精確的 fullName** —— 對不上的照實記下來。 */
  const byTeamId = {};
  const unmatched = [];
  for (const [fullName, club] of clubs) {
    if (club.code) continue;                     // 本站聯賽的球隊走原本那條路
    const hit = byClub[fullName];
    if (hit) byTeamId[String(club.id)] = { league: hit.league, ...hit.row };
    else unmatched.push(club.name);
  }

  return {
    note: '歐冠球隊所屬聯賽的積分榜,只用於歐冠的賽前對比 —— 沒有球員層、沒有預測,球隊也沒有本站的球隊頁。',
    source: 'openfootball',
    season,
    leagues,
    byTeamId,
    matched: Object.keys(byTeamId).length,
    unmatched: unmatched.sort(),
  };
}
