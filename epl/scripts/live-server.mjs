#!/usr/bin/env node
// 即時模式:一個指令同時服務網站,並在背景輪詢官方 API。
// 比賽進行中時,頁面每分鐘會自己更新比分、場上陣容與即時勝率,不用重跑 build。
//
//   npm run live:watch                     預設每 60 秒輪詢一次
//   npm run live:watch -- --interval=30    自訂間隔(秒)
//   npm run live:watch -- --source=mirror  改用 GitHub 鏡像(不會場中更新)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { fetchLive } from './lib/live.mjs';
import { buildMatchReport } from './lib/matchreport.mjs';
import { CURRENT_SEASON } from './lib/sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const PORT = Number(process.env.PORT || 5173);
// 明確綁定所有網路介面，讓同一個區網的裝置可以使用電腦區網 IP 開啟。
const HOST = process.env.HOST || '0.0.0.0';
const INTERVAL = Math.max(15, Number(arg('interval') || 60)) * 1000;
// SportMonks 額度雖足夠，西甲快取與建置較重；本機預設兩分鐘一次即可，
// 並且只在使用者明確以 --laliga 啟動時才會請求。
const LALIGA = process.argv.includes('--laliga');
const LALIGA_INTERVAL = Math.max(120, Number(arg('laliga-interval') || 120)) * 1000;
const SOURCE = arg('source') ?? 'auto';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const T = loadTeams(ROOT);
const readJson = async name => JSON.parse(await readFile(join(WEB, 'data', `${name}.json`), 'utf8'));

let cache = null;          // 目前這一份即時資料(直接餵給前端)
let lastError = null;
let lastPoll = null;
let laligaLastError = null;
let laligaLastPoll = null;

async function poll() {
  try {
    const [fixtures, tactics] = await Promise.all([readJson('fixtures'), readJson('tactics')]);
    const tacticsBy = new Map(tactics.map(t => [t.code, t]));
    const fixtureByKey = new Map(fixtures.map(f => [`${f.home}|${f.away}`, f]));

    const state = await fetchLive({ source: SOURCE, season: CURRENT_SEASON, codeOf: T.codeOf, root: ROOT });
    const matches = state.fixtures.map(f => {
      const fx = fixtureByKey.get(f.key);
      return {
        ...buildMatchReport({
          fixture: f, prediction: fx?.prediction ?? null, tactics: tacticsBy,
          zh: code => T.byCode.get(code)?.en ?? code,
        }),
        fixtureId: fx?.id ?? null,
        round: fx?.round ?? state.round,
        difficulty: fx?.difficulty ?? null,
      };
    }).sort((a, b) => (a.kickoff < b.kickoff ? -1 : 1));

    cache = {
      available: true,
      // 讓前端知道自己是被「即時模式」服務的,不必再多發一個探測請求
      liveMode: true,
      pollIntervalMs: INTERVAL,
      source: state.source, sourceLabel: state.sourceLabel, demo: !!state.demo,
      season: state.season ?? CURRENT_SEASON, round: state.round,
      fetchedAt: state.fetchedAt,
      counts: {
        total: matches.length,
        live: matches.filter(m => m.started && !m.finished).length,
        finished: matches.filter(m => m.finished).length,
        upcoming: matches.filter(m => !m.started).length,
      },
      matches,
    };
    lastError = null;
    lastPoll = new Date().toISOString();
    const c = cache.counts;
    console.log(`  ↻ ${new Date().toLocaleTimeString('zh-TW', { hour12: false })} 第 ${cache.round} 輪:進行中 ${c.live}・已完賽 ${c.finished}・未開賽 ${c.upcoming}`);
  } catch (err) {
    lastError = err.message;
    lastPoll = new Date().toISOString();
    console.warn(`  ✗ ${new Date().toLocaleTimeString('zh-TW', { hour12: false })} 取得失敗:${err.message.split(' —— ')[0]}`);
  }
}

async function runLocal(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`)));
  });
}

async function pollLaLiga() {
  if (!process.env.SPORTMONKS_TOKEN && !process.env.SPORTMONKS_KEY && !process.env.SPORTMONKS_API_KEY) {
    laligaLastError = '未設定 SPORTMONKS_TOKEN';
    console.warn('  ⚠ 西甲本機即時模式未設定 SPORTMONKS_TOKEN，略過輪詢。');
    return;
  }
  try {
    await runLocal('scripts/fetch-laliga-live.mjs', ['--max-requests=2']);
    await runLocal('scripts/build-laliga.mjs', []);
    laligaLastError = null;
    laligaLastPoll = new Date().toISOString();
    console.log(`  ↻ ${new Date().toLocaleTimeString('zh-TW', { hour12: false })} 西甲即時快取已更新`);
  } catch (err) {
    laligaLastError = err.message.split('\n')[0];
    laligaLastPoll = new Date().toISOString();
    console.warn(`  ✗ 西甲即時更新失敗: ${err.message.split('\n')[0]}`);
  }
}

createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);

  // 即時資料改由記憶體提供,不必重跑 build
  if (path === '/data/live.json') {
    const body = cache ?? {
      available: false,
      note: lastError
        ? `即時資料取得失敗:${lastError}`
        : '即時資料還在抓取中,稍候會自動出現。',
    };
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  if (path === '/api/live-status') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      source: SOURCE,
      intervalMs: INTERVAL,
      lastPoll,
      lastError,
      counts: cache?.counts ?? null,
      laliga: {
        source: 'sportmonks',
        intervalMs: LALIGA_INTERVAL,
        lastPoll: laligaLastPoll,
        lastError: laligaLastError,
        enabled: LALIGA,
      },
    }));
    return;
  }

  try {
    const p = path === '/' || path === '' ? '/index.html' : path;
    const full = join(WEB, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(WEB)) { res.writeHead(403).end('forbidden'); return; }
    const s = await stat(full);
    const body = await readFile(s.isDirectory() ? join(full, 'index.html') : full);
    res.writeHead(200, { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('找不到檔案');
  }
}).listen(PORT, HOST, () => {
  console.log(`▶ 戰情室【本機即時模式】→ http://localhost:${PORT}`);
  console.log(`  英超 ${SOURCE}・每 ${INTERVAL / 1000} 秒輪詢；西甲 ${LALIGA ? `SportMonks・每 ${LALIGA_INTERVAL / 1000} 秒輪詢` : '未啟用'}・不會自動推送\n`);
  poll();
  setInterval(poll, INTERVAL);
  if (LALIGA) {
    pollLaLiga();
    setInterval(pollLaLiga, LALIGA_INTERVAL);
  }
});
