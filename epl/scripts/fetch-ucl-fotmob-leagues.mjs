#!/usr/bin/env node
/* 抓歐冠球隊所屬聯賽的賽果 —— openfootball 沒有的那十六個(FotMob)。
 *
 * 為什麼要這個:階段 C 的跨聯賽 Elo 涵蓋 25/36 隊,本季 76 場沒有預測。
 * 2026-09-09 探測(`probe:ucl-coverage`,runner 上跑的)證實 FotMob **十六個聯賽全部有**,
 * 缺的 21 支球隊一支都不缺 —— 之前對不上是**譯名不同**,不是資料沒有
 * (`SK Slavia Praha` 在 FotMob 叫 `Slavia Prague`)。
 *
 * **對照走人工表,不用寬鬆比對**(`data/manual/ucl-league-teams.json`)。
 * 探測的隊名清單證實了兩組會對錯人的撞名:希臘 `Olympiacos` vs 賽普勒斯 `Olympiakos Nicosia`、
 * 希臘 `AEK Athens` vs 賽普勒斯 `AEK Larnaca`。自動比對會靜靜挑一個,而畫面上看不出來。
 *
 * 這支自我驗證兩件事,任何一件不過就**不覆蓋既有快取**:
 *   1. **回來的是不是我要的那一季。** FotMob 帶 season 參數在盃賽上實測會回「最新那季」——
 *      不驗就把本季存成上季,而畫面完全正常。看 `details.selectedSeason`。
 *   2. **對照表裡屬於這個聯賽的球隊,是不是每一支都在賽程裡。** 上游改隊名的話
 *      這裡要吵出來 —— 不吵的話那支球隊會靜靜失去評分,而預測少一場沒有人會發現。
 *
 * 請求禮貌:每次最多 20 個(使用者要求不要大量爬)。本季優先、歷史由舊往新補,
 * **已完結的賽季抓過就不再抓**,所以歷史會分幾次部署補齊,穩定後每次 16 個。
 *
 *   npm run ucl:fotmob-leagues
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POOL_START } from './lib/ucl-elo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://www.fotmob.com';
const UA = 'Mozilla/5.0 (compatible; epl-warroom/1.0; +https://github.com/exl78000-sys/pixnew)';
const OUT = join(ROOT, 'data', 'raw', 'fotmob-ucl-leagues');
const MAP = join(ROOT, 'data', 'manual', 'ucl-league-teams.json');
const FORCE = process.argv.includes('--force');
const MAX_REQUESTS = 20;
const TTL_HOURS = 6;

/* 賽季字串。**不是每個聯賽都是秋春制** —— 挪威超與哈薩克超是春秋制(三月開打、
   年底結束),FotMob 的賽季字串是曆年 `2026`,不是 `2026/2027`。
   不分的話那兩個聯賽一份都抓不到,而且只是安靜地少兩個目錄、不報錯。 */
const fotmobSeason = (label, lg) => {
  const y = Number(label.slice(0, 4));
  return lg?.calendarYear ? String(y) : `${y}/${y + 1}`;
};

const seasonsFrom = (start, current) => {
  const y0 = Number(start.slice(0, 4)), y1 = Number(current.slice(0, 4));
  const out = [];
  for (let y = y0; y <= y1; y++) out.push(`${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  return out;
};

const stale = async (file, isCurrent) => {
  if (FORCE || !existsSync(file)) return true;
  if (!isCurrent) return false;              // 已完結的賽季不會再變
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    const age = Date.now() - Date.parse(j.retrievedAt ?? '');
    return !Number.isFinite(age) || age > TTL_HOURS * 3600000;
  } catch { return true; }
};

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

async function main() {
  if (!existsSync(MAP)) { console.log('沒有 data/manual/ucl-league-teams.json,這次不抓。'); return; }
  const map = JSON.parse(await readFile(MAP, 'utf8'));

  const uclPath = join(ROOT, 'web', 'data', 'ucl.json');
  if (!existsSync(uclPath)) { console.log('還沒有 ucl.json(先跑 npm run ucl),這次不抓。'); return; }
  const current = (JSON.parse(await readFile(uclPath, 'utf8')).seasons ?? []).find(s => s.current)?.label;
  if (!current) { console.log('ucl.json 沒有本季,這次不抓。'); return; }

  const seasons = seasonsFrom(POOL_START, current);
  console.log(`歐冠缺的十六個聯賽(FotMob)—— 賽季 ${seasons.join('、')},每次最多 ${MAX_REQUESTS} 個請求`);

  /* 本季優先(那是會變的),歷史由舊往新補 —— 分幾次部署補齊。
     反過來的話,歷史沒補完之前本季一直是舊的,而畫面看不出來。 */
  const jobs = [];
  for (const lg of map.leagues) jobs.push({ lg, season: current, isCurrent: true });
  for (const s of seasons.filter(x => x !== current)) for (const lg of map.leagues) jobs.push({ lg, season: s, isCurrent: false });

  let reqs = 0, wrote = 0, skipped = 0, refused = 0;
  for (const { lg, season, isCurrent } of jobs) {
    const dir = join(OUT, lg.key);
    const file = join(dir, `${season}.json`);
    if (!(await stale(file, isCurrent))) { skipped++; continue; }
    if (reqs >= MAX_REQUESTS) continue;

    await mkdir(dir, { recursive: true });
    const url = `${BASE}/api/data/leagues?id=${lg.fotmobId}&ccode3=${lg.ccode3}&season=${encodeURIComponent(fotmobSeason(season, lg))}`;
    let j;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25000),
        headers: { accept: 'application/json', 'user-agent': UA, referer: `${BASE}/` } });
      reqs++;
      if (!res.ok) { console.log(`  ${lg.zh} ${season}:HTTP ${res.status}`); continue; }
      j = await res.json();
      // API 回 200 加一個 error 物件:只看 res.ok 會把失敗當成功
      if (j?.error) { console.log(`  ${lg.zh} ${season}:200 但帶 error ${String(j.error).slice(0, 60)}`); continue; }
    } catch (e) { reqs++; console.log(`  ⚠ ${lg.zh} ${season}:${e.message}`); continue; }

    /* 驗一:回來的是不是我要的那一季。盃賽上實測過帶 season 會回最新那季 ——
       不驗就把上季存成本季,而且畫面完全正常。 */
    const got = j.details?.selectedSeason ?? null;
    const want = fotmobSeason(season, lg);
    if (got && String(got) !== want) {
      console.log(`  ✗ ${lg.zh} ${season}:要 ${want}、回的是 ${got} —— 不覆蓋既有快取`);
      refused++; continue;
    }

    const all = j.fixtures?.allMatches ?? [];
    if (!all.length) { console.log(`  ⚠ ${lg.zh} ${season}:0 場,不覆蓋既有快取`); refused++; continue; }

    /* 驗二:對照表裡屬於這個聯賽的球隊,每一支都要在賽程裡。
       上游改隊名的話這裡要吵 —— 不吵的話那支球隊靜靜失去評分,
       而畫面上只是少一場預測,沒有人會發現(「對不上人永遠是安靜的」)。
       只在**本季**驗:歷史賽季那支球隊可能還沒升上來或已經降級,那是正常的。 */
    const names = new Set(all.flatMap(m => [m.home?.name, m.away?.name]).filter(Boolean));
    const want2 = map.teams.filter(t => t.league === lg.key);
    const missing = want2.filter(t => !names.has(t.fotmob));
    if (isCurrent && missing.length) {
      console.log(`  ✗ ${lg.zh} ${season}:對照表的 ${missing.map(t => t.fotmob).join('、')} 不在賽程裡`
        + `(上游可能改了隊名)—— 不覆蓋既有快取`);
      refused++; continue;
    }

    const matches = all.map(m => {
      const st = m.status ?? {};
      const sc = /^(\d+)\s*-\s*(\d+)$/.exec(String(st.scoreStr ?? '').trim());
      return { home: m.home?.name ?? null, away: m.away?.name ?? null,
        date: String(st.utcTime ?? '').slice(0, 10), utcTime: st.utcTime ?? null,
        round: Number.isFinite(Number(m.round)) ? Number(m.round) : null,
        finished: st.finished === true, cancelled: st.cancelled === true,
        score: sc ? [Number(sc[1]), Number(sc[2])] : null };
    });
    await writeAtomic(file, { league: lg.key, season, selectedSeason: got,
      source: 'fotmob', retrievedAt: new Date().toISOString(), matches });
    wrote++;
    const done = matches.filter(m => m.finished && m.score).length;
    console.log(`  ✔ ${lg.zh} ${season}:${matches.length} 場・已完賽 ${done}・${names.size} 隊`
      + (isCurrent && want2.length ? `・對照表 ${want2.length} 支全在` : ''));
  }

  const remaining = jobs.length - skipped - wrote - refused;
  console.log(`  發了 ${reqs} 個請求・寫入 ${wrote}・沿用 ${skipped}・拒收 ${refused}`
    + (remaining > 0 ? `・還有 ${remaining} 份沒補(下次部署繼續)` : '・全部補齊'));
}

main().catch(e => { console.error('抓取失敗:', e.message); process.exitCode = 1; });
