#!/usr/bin/env node
/* 英超場中射門統計(pulselive /stats/match)→ data/raw/pulselive/shots.json。比賽日迴圈每輪呼叫一次。
 * 只打進行中的場次(加完賽後各補一次),單線、間隔 400 ms、每輪最多 12 場。細節與界線見 lib/pulse-shots.mjs。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, PL_HEADERS } from './lib/pulselive.mjs';
import { SHOTS_VERSION, shotsPath, shotsOf, loadShots, wantedShots } from './lib/pulse-shots.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const live = readJson(join(ROOT, 'data', 'raw', 'live.json'));
const official = readJson(join(ROOT, 'data', 'raw', 'pulselive', 'official.json'));
const store = loadShots(ROOT);
const { wanted, skipped, stale } = wantedShots({ live, official, store });
if (stale) { console.log('· 即時快照不夠新(或不存在),略過'); process.exit(0); }
if (!wanted.length) { console.log(`· 沒有要抓的場次${skipped.length ? `(對不上 pulselive id 的:${skipped.join('、')})` : ''}`); process.exit(0); }

let ok = 0, fail = 0;
for (const w of wanted) {
  try {
    await sleep(400);
    const res = await fetch(`${API}/stats/match/${w.fixtureId}`, { headers: PL_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    const home = shotsOf(d, w.homeId), away = shotsOf(d, w.awayId);
    if (!home || !away) throw new Error('沒有統計項');
    store.matches[w.key] = { fixtureId: w.fixtureId, fetchedAt: new Date().toISOString(), final: w.final, home, away };
    ok++;
  } catch (e) { fail++; console.log(`  ✗ ${w.key}:${e.message}`); }
}
if (ok) {
  mkdirSync(dirname(shotsPath(ROOT)), { recursive: true });
  writeFileSync(shotsPath(ROOT), JSON.stringify({ version: SHOTS_VERSION, matches: store.matches }, null, 1) + '\n');
}
console.log(`✔ 射門統計:${ok} 場成功${fail ? `・${fail} 場失敗` : ''}${skipped.length ? `・${skipped.length} 場對不上 pulselive id(${skipped.join('、')})` : ''}`);
