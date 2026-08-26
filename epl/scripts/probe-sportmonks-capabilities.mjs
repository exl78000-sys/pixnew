#!/usr/bin/env node
// 只讀探測 SportMonks Token 的方案能力；不把回應原文或 Token 寫入快取。
// 先查 My API，再以本季一場 Fixture 逐項測試 include，讓同步器只請求方案允許的欄位。
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_KEY || process.env.SPORTMONKS_API_KEY;
const BASE = 'https://api.sportmonks.com/v3';
const LEAGUE = process.argv.find(x => x.startsWith('--league='))?.split('=')[1] ?? 'es1';
const CONFIG = LEAGUE === 'pl'
  ? { season: Number(process.env.SPORTMONKS_EPL_SEASON_ID ?? 0), dir: 'sportmonks-epl', league: 'pl' }
  : { season: 27965, dir: 'sportmonks-la-liga', league: 'es1' };
const OUT = join(ROOT, 'data', 'raw', CONFIG.dir, 'capabilities.json');
const MAX_REQUESTS = 12;
const DELAY = 350;
let requests = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeCode = body => body?.errors?.code ?? body?.code ?? body?.errors?.error_code ?? null;
const safeError = (status, body) => ({
  status, available: status === 200,
  errorCode: safeCode(body),
});

async function request(path) {
  if (requests >= MAX_REQUESTS) return { status: null, body: null, skipped: true };
  if (requests) await sleep(DELAY);
  requests++;
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(30000),
      headers: { accept: 'application/json', Authorization: TOKEN },
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 只保留狀態，不落盤回應原文 */ }
    return { status: res.status, body };
  } catch (error) {
    return { status: null, body: null, error: error.name || 'network-error' };
  }
}

async function readStore(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function main() {
  if (!TOKEN) {
    console.log('⚠ 未設定 SPORTMONKS_TOKEN，略過方案能力探測。');
    return;
  }
  await mkdir(dirname(OUT), { recursive: true });
  const my = {};
  for (const endpoint of ['resources', 'leagues', 'usage']) {
    const result = await request(`/my/${endpoint}`);
    my[endpoint] = safeError(result.status, result.body);
    if (result.status === 200) {
      const data = result.body?.data;
      my[endpoint].items = Array.isArray(data) ? data.length : data && typeof data === 'object' ? Object.keys(data).length : 0;
    }
  }

  let fixtureId = null;
  if (CONFIG.season) {
    const list = await request(`/football/fixtures?filters=fixtureSeasons:${CONFIG.season}&include=participants&per_page=1`);
    fixtureId = Array.isArray(list.body?.data) ? list.body.data[0]?.id ?? null : null;
  }

  const includes = ['participants', 'lineups', 'events', 'statistics', 'formations', 'xGFixture'];
  const includeCapabilities = {};
  for (const include of includes) {
    if (fixtureId == null) {
      includeCapabilities[include] = { status: null, available: null, reason: 'no-fixture-sample' };
      continue;
    }
    const result = await request(`/football/fixtures/${fixtureId}?include=${include}`);
    includeCapabilities[include] = safeError(result.status, result.body);
  }

  const out = {
    league: CONFIG.league,
    season: CONFIG.season || null,
    fixtureId,
    source: 'SportMonks',
    sourceUrl: 'https://api.sportmonks.com/v3/my/resources',
    retrievedAt: new Date().toISOString(),
    requests,
    my,
    includes: includeCapabilities,
    note: '只記錄 HTTP 狀態與方案能力；不保存 Token、完整回應或個人資料。200 表示此探測請求可用，403 表示方案未提供。',
  };
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`✔ SportMonks ${CONFIG.league} 方案能力已寫入 ${OUT}（${requests}/${MAX_REQUESTS} 請求）`);
}

main().catch(error => { console.error(`✗ SportMonks 能力探測失敗：${error.message}`); process.exitCode = 1; });
