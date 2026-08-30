#!/usr/bin/env node
// 從 SportMonks Livescores 取得西甲場中比分，轉成 page-live 使用的 canonical 快照。
// 一次輪詢只打 1 次；若方案不接受 events include，退回核心比分欄位，不繞過限制。
// 沒有 Token 或請求失敗時不會清掉上一份可用快取；API 正常回傳空陣列時則視為
// 「目前沒有場中賽事」並寫入空快照，避免把已結束比賽誤留成進行中。
//
//   npm run laliga:live
//   npm run laliga:live -- --max-requests=2
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { loadMatches } from './lib/adapters/openfootball.mjs';
import { normaliseSportmonksMatch } from './lib/adapters/sportmonks.mjs';
import { buildLiveProviderReport } from './lib/postmatch-report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_KEY || process.env.SPORTMONKS_API_KEY;
const BASE = 'https://api.sportmonks.com/v3';
const LEAGUE_ID = Number(process.env.SPORTMONKS_LALIGA_LEAGUE_ID ?? 564);
const SEASON_ID = Number(process.env.SPORTMONKS_LALIGA_SEASON_ID ?? 27965);
const MAX_REQUESTS = Number(process.argv.find(x => x.startsWith('--max-requests='))?.split('=')[1] ?? 2);
const OUT = join(ROOT, 'data', 'raw', 'sportmonks-la-liga', 'live.json');
const CURRENT_SEASON = '2026-27';

const rows = value => Array.isArray(value) ? value
  : Array.isArray(value?.data) ? value.data
    : Array.isArray(value?.data?.data) ? value.data.data : [];
const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
};
const text = value => String(value ?? '').toLowerCase();

async function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function main() {
  if (!TOKEN) {
    console.log('⚠ 未設定 SPORTMONKS_TOKEN（或 SPORTMONKS_KEY / SPORTMONKS_API_KEY），略過西甲即時同步。');
    return;
  }

  const T = loadTeams(ROOT, { file: 'teams-la-liga.json' });
  const fixtures = loadMatches({ root: ROOT, competition: 'esp.1', season: CURRENT_SEASON,
    codeOf: T.codeOf, rawDir: 'openfootball-la-liga' });
  const fixtureByPair = new Map(fixtures.map(f => [`${f.home}|${f.away}`, f]));
  /* 賽前預測:openfootball 的賽程列沒有這個欄位,從 build 產物借
     (同一個 checkout 裡就有,零額外請求)。沒有預測就沒有場中機率 ——
     實測 inplay/preMatch 整季全空,勝率條、勝率曲線與校準整條斷頭,
     而畫面只是「少一條 bar」,不會報錯。 */
  const predByPair = new Map();
  const siteFx = await readJson(join(ROOT, 'web', 'data', 'leagues', 'es1', 'fixtures.json'));
  for (const f of Array.isArray(siteFx) ? siteFx : []) {
    if (f.prediction) predByPair.set(`${f.home}|${f.away}`, f.prediction);
  }
  const store = await readJson(join(ROOT, 'data', 'raw', 'sportmonks-la-liga', `${CURRENT_SEASON}-squads.json`));
  const providerIdToCode = new Map(Object.entries(store?.teams ?? {}).map(([code, team]) => [String(team.id), code]));

  let requests = 0;
  const request = async includes => {
    if (requests >= MAX_REQUESTS) throw new Error(`已達本次 ${MAX_REQUESTS} 個請求上限`);
    requests++;
    const query = `filters=fixtureLeagues:${LEAGUE_ID}&include=${includes}`;
    const res = await fetch(`${BASE}/football/livescores/inplay?${query}`, {
      signal: AbortSignal.timeout(30000),
      headers: { accept: 'application/json', Authorization: TOKEN },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.errors || body?.message && !body?.data) {
      throw new Error(`HTTP ${res.status}: ${body?.message || JSON.stringify(body?.errors ?? {}).slice(0, 300)}`);
    }
    return rows(body?.data ?? body);
  };

  let providerRows;
  let includeUsed = 'participants;state;scores;events';
  try {
    providerRows = await request(includeUsed);
  } catch (firstError) {
    // Livescore 端點在部分方案只允許三個 include；退回比分必要欄位。
    includeUsed = 'participants;state;scores';
    try { providerRows = await request(includeUsed); }
    catch (secondError) {
      console.log(`⚠ 西甲 SportMonks 即時請求失敗：${firstError.message}；退回也失敗：${secondError.message}`);
      return;
    }
  }

  const matches = [];
  for (const raw of providerRows) {
    const participants = rows(raw.participants);
    const codes = participants.map(p => providerIdToCode.get(String(p.id)) || T.codeOf(p.name) || T.codeOf(p.short_code)).filter(Boolean);
    const unique = [...new Set(codes)];
    if (unique.length !== 2) continue;
    const home = participants.find(p => p.meta?.location === 'home' || p.location === 'home');
    const away = participants.find(p => p.meta?.location === 'away' || p.location === 'away');
    const homeCode = providerIdToCode.get(String(home?.id)) || T.codeOf(home?.name) || unique[0];
    const awayCode = providerIdToCode.get(String(away?.id)) || T.codeOf(away?.name) || unique.find(x => x !== homeCode);
    if (!homeCode || !awayCode || homeCode === awayCode) continue;
    const fixture = fixtureByPair.get(`${homeCode}|${awayCode}`);
    if (!fixture) continue;

    /* 比分只認 CURRENT 型的分數列。原本的正則連 1ST_HALF/2ND_HALF 分段列一起收,
       而 find 撿到哪一列看供應商的排序 —— 實測 LEV|BET 事件已有五顆進球(3:2),
       存下來卻是 1:2。分段列不是累計值(歐冠 et 那條坑的同款),不能混用。 */
    const scores = rows(raw.scores);
    const typeName = s => `${s.type?.developer_name ?? ''} ${s.description ?? ''}`.toUpperCase();
    const currentRows = scores.filter(s => /\bCURRENT\b/.test(typeName(s)));
    const scoreOf = (participant, location, side) => {
      const pool = currentRows.length ? currentRows : scores;
      const row = pool.find(s => String(s.participant_id ?? s.team_id) === String(participant?.id))
        ?? pool.find(s => String(s.score?.participant ?? '').toLowerCase() === location);
      return num(row?.score?.goals ?? row?.goals ?? raw[`${side}_score`]);
    };
    const hs = scoreOf(home, 'home', 'home'), as = scoreOf(away, 'away', 'away');
    /* 分鐘:事件的 minute 是全場分鐘,但**供應商不按時間排**(進球在前、換人居中、
       VAR 墊底)—— .at(-1) 曾撿到 17' 的越位當成現在分鐘。改取所有訊號的最大值:
       事件分鐘(含補時 extra)是「至少踢到這裡」的下界,加上比賽狀態的下限
       (下半場至少 46'、中場 45'),再交給前端的走鐘往前推。 */
    const eventRows = rows(raw.events);
    const evMin = e => {
      const m = num(e.minute ?? e.time?.elapsed ?? e.time);
      const x = num(e.extra);
      return Number.isFinite(m) ? m + (Number.isFinite(x) ? x : 0) : null;
    };
    const eventMinute = Math.max(0, ...eventRows.map(evMin).filter(Number.isFinite));
    const stateName = text(raw.state?.developer_name ?? raw.state?.short_name ?? raw.state?.name ?? raw.state_id);
    const finished = /finished|full.?time|after.?penalty|ft/.test(stateName) || Number(raw.state_id) === 5;
    const stateFloor = /2nd|second/i.test(stateName) ? 46 : /half.?time|ht|break/i.test(stateName) ? 45 : 0;
    /* 第三個訊號:開球時間推算(事件分鐘只到最後一筆事件,實測落後牆鐘十來分)。
       開球時間用供應商同一筆 payload 的 starting_at(UTC、無時區字串,補上 Z 再解;
       實測 "2026-08-29 15:00:00" 對得上真實開球)。本站賽程列只有日期沒有時間
       (openfootball),當備援。分段感知:上半場封頂 45、中場停 45、
       下半場扣 15 分鐘休息封頂 90 —— 補時長度沒有資料,到 90 就停,
       前端走鐘會顯示 90+,不編數字。 */
    const wallEst = (() => {
      const s = String(raw.starting_at ?? '');
      const koRaw = s ? (/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') : (fixture.kickoff ?? '');
      const ko = Date.parse(koRaw);
      if (!Number.isFinite(ko)) return 0;
      const el = (Date.now() - ko) / 60000;
      if (el <= 0 || el > 200) return 0;
      if (/half.?time|ht|break/i.test(stateName)) return 45;
      if (/2nd|second/i.test(stateName)) return Math.min(90, Math.max(46, Math.floor(el - 15)));
      if (/1st|first/i.test(stateName)) return Math.min(45, Math.floor(el));
      return 0;   // 狀態認不得就不用這個訊號,交給另外兩個
    })();
    const minute = Math.max(eventMinute, stateFloor, wallEst, num(raw.minute) ?? 0, num(raw.state?.minute) ?? 0);
    const detail = normaliseSportmonksMatch(raw, {
      codeOf: T.codeOf, fixture: { ...fixture, fh: hs, fa: as },
      teamCodeById: providerIdToCode, season: CURRENT_SEASON,
    });
    if (!detail) continue;
    const report = buildLiveProviderReport({
      fixture: { ...fixture, played: false, started: true, finished, fh: hs, fa: as },
      detail, prediction: fixture.prediction ?? predByPair.get(`${homeCode}|${awayCode}`) ?? null, minute,
      nameOf: code => T.byCode.get(code)?.en ?? code,
    });
    if (report) matches.push(report);
  }

  /* 完賽終值歸檔。即時快照只留最新一份 —— 完賽比分被下一輪覆蓋前沒有任何
     地方留底,而上游賽果(openfootball/SP1)慢的那幾天,這份是本站手上唯一的
     比分(2026-08-30 週末 5 場實際發生)。追記檔只增不減,之後可以當賽果的
     第二核對源(SportMonks × football-data 雙源)。 */
  const FINALS = join(ROOT, 'data', 'raw', 'sportmonks-la-liga', 'finals.json');
  {
    const finals = (await readJson(FINALS)) ?? {
      _note: 'SportMonks 即時端點的完賽終值歸檔(只增不減)。產生:fetch-laliga-live.mjs。用途:即時快照會被覆蓋,這裡留底;可作賽果的第二核對源。',
      matches: {},
    };
    let added = 0;
    for (const m of matches) {
      if (!m.finished || m.hs == null || m.as == null) continue;
      const key = `${m.season}|${m.key}`;
      if (finals.matches[key]) continue;
      finals.matches[key] = { hs: m.hs, as: m.as, kickoff: m.kickoff ?? null,
        minute: m.minute ?? null, recordedAt: new Date().toISOString() };
      added++;
    }
    if (added) {
      await writeFile(FINALS, JSON.stringify(finals, null, 1));
      console.log(`  ✔ 完賽終值歸檔 +${added} 場(累計 ${Object.keys(finals.matches).length})`);
    }
  }

  const previous = await readJson(OUT);
  const signature = list => (list ?? []).map(m => `${m.key}|${m.hs}|${m.as}|${m.minute}|${m.finished}`).sort().join('\n');
  const unchanged = previous?.available === true && signature(previous.matches) === signature(matches);
  const output = {
    available: true, source: 'sportmonks', sourceLabel: 'SportMonks 西甲即時比分', demo: false,
    season: CURRENT_SEASON, fetchedAt: unchanged ? previous.fetchedAt : new Date().toISOString(),
    include: includeUsed, leagueId: LEAGUE_ID,
    counts: {
      total: matches.length,
      live: matches.filter(m => m.started && !m.finished).length,
      finished: matches.filter(m => m.finished).length,
      upcoming: matches.filter(m => !m.started).length,
    },
    matches,
    note: 'SportMonks livescores/inplay；比分與狀態來自即時端點。速度、距離、衝刺不在方案欄位內。',
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(output, null, 2) + '\n');
  console.log(`✔ 西甲 SportMonks 即時快照：${matches.length} 場（進行中 ${output.counts.live}、剛完賽 ${output.counts.finished}、請求 ${requests} 次）`);
}

main().catch(error => { console.error(`✗ 西甲即時同步失敗：${error.message}`); process.exitCode = 1; });
