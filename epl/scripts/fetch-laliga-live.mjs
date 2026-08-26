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

    const scores = rows(raw.scores);
    const currentRows = scores.filter(s => /current|2nd.?half|1st.?half/i.test(`${s.description ?? ''} ${s.type?.developer_name ?? ''}`));
    const scoreOf = (participant, location, side) => {
      const row = currentRows.find(s => String(s.participant_id ?? s.team_id) === String(participant?.id))
        ?? currentRows.find(s => String(s.score?.participant ?? '').toLowerCase() === location)
        ?? scores.find(s => String(s.participant_id ?? s.team_id) === String(participant?.id));
      return num(row?.score?.goals ?? row?.goals ?? raw[`${side}_score`]);
    };
    const hs = scoreOf(home, 'home', 'home'), as = scoreOf(away, 'away', 'away');
    const eventRows = rows(raw.events);
    const eventMinute = eventRows.map(e => num(e.minute ?? e.time?.elapsed ?? e.time)).filter(Number.isFinite).at(-1) ?? 0;
    const stateName = text(raw.state?.developer_name ?? raw.state?.short_name ?? raw.state?.name ?? raw.state_id);
    const finished = /finished|full.?time|after.?penalty|ft/.test(stateName) || Number(raw.state_id) === 5;
    const minute = num(raw.minute ?? raw.state?.minute ?? eventMinute) ?? eventMinute;
    const detail = normaliseSportmonksMatch(raw, {
      codeOf: T.codeOf, fixture: { ...fixture, fh: hs, fa: as },
      teamCodeById: providerIdToCode, season: CURRENT_SEASON,
    });
    if (!detail) continue;
    const report = buildLiveProviderReport({
      fixture: { ...fixture, played: false, started: true, finished, fh: hs, fa: as },
      detail, prediction: fixture.prediction ?? null, minute,
      nameOf: code => T.byCode.get(code)?.en ?? code,
    });
    if (report) matches.push(report);
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
