#!/usr/bin/env node
/* 抓英超(PL)與英冠(ELC)的官方賽程狀態(football-data.org v4,免費層涵蓋),
 * 跟上一次快照 diff 出延期/改期事件,累積在 data/raw/schedule-status.json。
 * 邏輯在 lib/schedule-status.mjs(純函式,測試蓋得到);這裡只做 IO。
 *
 *   npm run schedule:status
 *
 * 免費層 10 req/分;這支每次跑只發 2 個請求。沒 token 就結束碼 0 離開 ——
 * 「這件事現在做不了」不是「這一筆失敗」(缺依賴要開跑前講清楚那條)。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMatches, diffSnapshots } from './lib/schedule-status.mjs';
import { clubKey } from './lib/names.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'schedule-status.json');
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const BASE = 'https://api.football-data.org/v4';

const LEAGUES = [
  { lg: 'pl', code: 'PL', clubs: 'web/data/clubs.json' },
  { lg: 'en2', code: 'ELC', clubs: 'web/data/leagues/en2/clubs.json' },
];

const codeOfFrom = path => {
  const c = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
  const map = new Map((c.clubs ?? c).flatMap(t =>
    [t.en, t.of, t.zh, t.fd, t.fpl, t.understat, ...(t.alias ?? []), ...(t.cupAlias ?? [])]
      .filter(Boolean).map(n => [clubKey(n), t.code])));
  return n => map.get(clubKey(n)) ?? null;
};

async function main() {
  if (!TOKEN) { console.log('沒有 FOOTBALL_DATA_TOKEN,這件事現在做不了 —— 跳過(不算失敗)'); return; }
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { leagues: {}, changes: [] };
  const now = new Date().toISOString();
  const leaguesOut = {};
  const newEvents = [];

  for (const [i, L] of LEAGUES.entries()) {
    if (i) await new Promise(r => setTimeout(r, 7000));
    const res = await fetch(`${BASE}/competitions/${L.code}/matches`, {
      signal: AbortSignal.timeout(30000),
      headers: { 'X-Auth-Token': TOKEN, accept: 'application/json' },
    });
    const body = await res.json().catch(() => null);
    // API 會回 200 + error 物件的那條坑:message 在就是失敗
    if (!res.ok || body?.message) {
      console.log(`  ⚠ ${L.code}:HTTP ${res.status} ${body?.message ?? ''} —— 保留上一次快照`);
      leaguesOut[L.lg] = prev.leagues?.[L.lg] ?? null;
      continue;
    }
    const matches = normalizeMatches(body.matches, codeOfFrom(L.clubs));
    const events = diffSnapshots(prev.leagues?.[L.lg]?.matches, matches)
      .map(e => ({ league: L.lg, ...e, detectedAt: now }));
    newEvents.push(...events);
    leaguesOut[L.lg] = { fetchedAt: now, count: matches.length, matches };
    const flagged = matches.filter(m => ['POSTPONED', 'SUSPENDED', 'CANCELLED'].includes(m.status));
    console.log(`  ${L.code}:${matches.length} 場・目前延期/取消 ${flagged.length} 場・本次新事件 ${events.length} 筆`);
  }

  writeFileSync(OUT, JSON.stringify({
    _note: '官方賽程狀態快照 + 本站自建的改期歷史(供應商不提供歷史,changes 永久累積)。產生:npm run schedule:status。',
    fetchedAt: now,
    leagues: leaguesOut,
    changes: [...(prev.changes ?? []), ...newEvents],
  }, null, 1));
  console.log(`  ✓ schedule-status.json(累積事件 ${(prev.changes ?? []).length + newEvents.length} 筆)`);
}

main().catch(err => { console.error('✗ 賽程狀態抓取失敗:', err.message); process.exitCode = 1; });
