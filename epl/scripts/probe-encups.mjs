#!/usr/bin/env node
/* 英格蘭盃賽資料源探測。
   起因:docs 上寫著「英國盃賽不在免費方案裡,不要再找」——
   那句話是對 **football-data.org** 說的,而且沒有人去看 openfootball 自己的
   England 倉庫。這跟 CLAUDE.md 裡「Understat 端點找錯」是同一種錯誤:
   把「某一個來源沒有」當成「這個東西拿不到」。

   所以這支腳本把每一個候選端點實際打一次,把 HTTP 狀態與可解析的場次數寫下來,
   讓「有沒有」是被量出來的,不是憑印象。

   沙箱連得到 raw.githubusercontent.com,所以這支在本機就能跑;
   football-data.org 那段需要 Token,只有 runner 上跑得動。 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'probes', 'en-cups.json');
const OF = 'https://raw.githubusercontent.com/openfootball/england/master';
const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26', '2026-27'];
const CUPS = ['facup', 'eflcup'];
const DELAY = 250;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Football.TXT 的對戰行:「HH:MM  隊伍 v 隊伍  比分」,時間可省略(沿用上一行)
const MATCH_LINE = /^\s{2,}(?:\d{2}:\d{2}\s+)?\S.*\sv\s\S/;

async function get(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const text = res.ok ? await res.text() : null;
    return { status: res.status, text };
  } catch (e) { return { status: null, text: null, error: e.name || 'network-error' }; }
}

async function probeOpenfootball() {
  const out = {};
  for (const season of SEASONS) {
    for (const cup of CUPS) {
      await sleep(DELAY);
      const url = `${OF}/${season}/${cup}.txt`;
      const { status, text, error } = await get(url);
      const key = `${season}/${cup}`;
      if (status !== 200 || !text) { out[key] = { status, error: error ?? null, available: false }; continue; }
      const lines = text.split('\n');
      const matches = lines.filter(l => MATCH_LINE.test(l)).length;
      const rounds = lines.filter(l => /^▪/.test(l)).map(l => l.replace(/^▪\s*/, '').trim());
      out[key] = {
        status, available: true, bytes: text.length,
        title: lines.find(l => l.startsWith('='))?.replace(/^=\s*/, '').trim() ?? null,
        headerMatches: Number(text.match(/#\s*Matches\s+(\d+)/)?.[1] ?? 0) || null,
        parsedMatches: matches,
        rounds: rounds.length, roundNames: rounds,
        // 盃賽特有的兩件事,決定我們要不要另一套模型
        aet: (text.match(/a\.e\.t\./g) ?? []).length,
        shootouts: (text.match(/pen\./g) ?? []).length,
      };
    }
  }
  return out;
}

/* football-data.org:doc 上說盃賽不在免費方案,實際打一次確認。
   /v4/competitions 會回這個 Token 拿得到的全部賽事,一個請求就夠。 */
async function probeFootballData() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return { skipped: 'no-token' };
  try {
    const res = await fetch('https://api.football-data.org/v4/competitions', {
      headers: { 'X-Auth-Token': token }, signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => null);
    const list = Array.isArray(body?.competitions) ? body.competitions : [];
    return {
      status: res.status,
      count: list.length,
      // 只留賽事代碼與名稱,不保存 Token 也不保存完整回應
      competitions: list.map(c => ({ code: c.code, name: c.name, area: c.area?.name ?? null, type: c.type })),
      englishCups: list.filter(c => c.area?.name === 'England' && c.type === 'CUP').map(c => c.code),
    };
  } catch (e) { return { status: null, error: e.name || 'network-error' }; }
}

/* SportMonks:方案實際授權 FA Cup(24)與 Carabao Cup(27)。
   在寫抓取管線之前必須先看清楚三件事,不能憑印象(CLAUDE.md 第四條):

   1. 2025-26 / 2026-27 這兩季的 season id 是多少、在不在方案裡
   2. 輪次名放在哪 —— round 還是 stage?盃賽的「第三輪 / 半準決賽 / 決賽」
      是整個版面的骨架,拿不到就只剩一堆散場比賽
   3. **延長賽與 PK 大戰的比分怎麼表示。** SportMonks 的 scores 是一個陣列,
      每筆帶 description;哪些 description 代表 ET 與 PK 要看實際回傳,
      猜錯的話決賽會顯示成 1-1 而不是「1-1 PK 5-4」——
      那不是少一個欄位,是把冠軍講錯。

   只取樣、不落地正式資料;每個賽季最多 3 場。 */
const SM_BASE = 'https://api.sportmonks.com/v3';
const SM_CUPS = [{ id: 24, name: 'FA Cup' }, { id: 27, name: 'Carabao Cup' }];
const SM_WANT = ['2025/2026', '2026/2027'];
let smRequests = 0;
const SM_MAX = 10;

async function smGet(path, token) {
  if (smRequests >= SM_MAX) return { skipped: 'request-cap' };
  if (smRequests) await sleep(400);
  smRequests++;
  try {
    const res = await fetch(`${SM_BASE}${path}`, {
      signal: AbortSignal.timeout(30000),
      headers: { accept: 'application/json', Authorization: token },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (e) { return { status: null, error: e.name || 'network-error' }; }
}

async function probeSportmonks() {
  const token = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_KEY || process.env.SPORTMONKS_API_KEY;
  if (!token) return { skipped: 'no-token' };
  const out = { cups: {}, requests: 0 };
  for (const cup of SM_CUPS) {
    const r = await smGet(`/football/leagues/${cup.id}?include=seasons`, token);
    const seasons = Array.isArray(r.body?.data?.seasons) ? r.body.data.seasons : [];
    const entry = {
      status: r.status,
      leagueName: r.body?.data?.name ?? null,
      seasons: seasons.map(x => ({ id: x.id, name: x.name, current: x.is_current === true, finished: x.finished })),
    };
    // 只取樣我們要的兩季,而且每季只打一次
    entry.samples = {};
    for (const want of SM_WANT) {
      const season = seasons.find(x => String(x.name) === want);
      if (!season) { entry.samples[want] = { found: false }; continue; }
      const f = await smGet(
        `/football/fixtures?filters=fixtureSeasons:${season.id}&include=participants;scores;round;stage;state&per_page=3&order=starting_at`,
        token);
      const list = Array.isArray(f.body?.data) ? f.body.data : [];
      entry.samples[want] = {
        found: true, seasonId: season.id, status: f.status,
        total: f.body?.pagination?.total ?? null,
        // 只留結構,不搬資料:欄位名、輪次名、比分 description 的種類
        fixtureKeys: list[0] ? Object.keys(list[0]) : null,
        roundNames: [...new Set(list.map(x => x.round?.name).filter(Boolean))],
        stageNames: [...new Set(list.map(x => x.stage?.name).filter(Boolean))],
        stateNames: [...new Set(list.map(x => x.state?.state ?? x.state?.name).filter(Boolean))],
        scoreDescriptions: [...new Set(list.flatMap(x => (x.scores ?? []).map(s => s.description)).filter(Boolean))],
        scoreShape: list[0]?.scores?.[0] ? Object.keys(list[0].scores[0]) : null,
        participantSample: (list[0]?.participants ?? []).map(p => ({
          name: p.name, location: p.meta?.location ?? null,
        })),
        resultInfo: list[0]?.result_info ?? null,
        startingAt: list[0]?.starting_at ?? null,
      };
    }
    out.cups[cup.name] = entry;
  }
  out.requests = smRequests;
  return out;
}

const openfootball = await probeOpenfootball();
const footballData = await probeFootballData();
const sportmonks = await probeSportmonks();
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({
  retrievedAt: new Date().toISOString(),
  question: '英格蘭盃賽(足總盃 / 聯賽盃)的免費資料源,哪一季拿得到、拿得到什麼',
  openfootball, footballData, sportmonks,
}, null, 2) + '\n');

console.log('── openfootball/england ──');
for (const [k, v] of Object.entries(openfootball)) {
  console.log(v.available
    ? `  ✓ ${k.padEnd(18)} ${String(v.parsedMatches).padStart(3)} 場(表頭 ${v.headerMatches})・${v.rounds} 輪・延長 ${v.aet}・PK ${v.shootouts}`
    : `  ✗ ${k.padEnd(18)} HTTP ${v.status ?? v.error}`);
}
console.log('── football-data.org ──');
if (footballData.skipped) console.log(`  (略過:${footballData.skipped})`);
else if (footballData.error) console.log(`  ✗ ${footballData.error}`);
else console.log(`  HTTP ${footballData.status}・${footballData.count} 個賽事・英格蘭盃賽:${footballData.englishCups?.length ? footballData.englishCups.join('、') : '無'}`);
console.log('── SportMonks(方案已授權 FA Cup 24 / Carabao Cup 27)──');
if (sportmonks.skipped) console.log(`  (略過:${sportmonks.skipped})`);
else for (const [name, cup] of Object.entries(sportmonks.cups ?? {})) {
  console.log(`  ${name}(HTTP ${cup.status})・賽季 ${cup.seasons?.length ?? 0} 個`);
  for (const [want, s] of Object.entries(cup.samples ?? {})) {
    if (!s.found) { console.log(`    ✗ ${want} 這一季不在清單裡`); continue; }
    console.log(`    ✓ ${want} season=${s.seasonId}・共 ${s.total} 場`);
    console.log(`        輪次 round=${JSON.stringify(s.roundNames)} stage=${JSON.stringify(s.stageNames)}`);
    console.log(`        比分種類 ${JSON.stringify(s.scoreDescriptions)}`);
    console.log(`        隊伍樣本 ${JSON.stringify(s.participantSample)}`);
  }
}
console.log(`\n✔ 已寫入 ${OUT}`);
