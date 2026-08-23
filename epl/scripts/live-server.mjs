#!/usr/bin/env node
// 即時模式:一個指令同時服務網站,並在背景輪詢官方 API。
// 比賽進行中時,頁面每分鐘會自己更新比分、場上陣容與即時勝率,不用重跑 build。
//
//   npm run live:watch                     預設每 60 秒輪詢一次
//   npm run live:watch -- --interval=30    自訂間隔(秒)
//   npm run live:watch -- --source=mirror  改用 GitHub 鏡像(不會場中更新)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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
const INTERVAL = Math.max(15, Number(arg('interval') || 60)) * 1000;
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
    res.end(JSON.stringify({ source: SOURCE, intervalMs: INTERVAL, lastPoll, lastError, counts: cache?.counts ?? null }));
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
}).listen(PORT, () => {
  console.log(`▶ 英超戰情室【即時模式】→ http://localhost:${PORT}`);
  console.log(`  來源 ${SOURCE}・每 ${INTERVAL / 1000} 秒輪詢一次・頁面會自己更新\n`);
  poll();
  setInterval(poll, INTERVAL);
});
