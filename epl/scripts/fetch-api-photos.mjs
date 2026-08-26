#!/usr/bin/env node
// 用 API-Football 補英超官方 CDN 沒有的球員頭貼。
// 只處理缺圖名單；每次與每日都有上限，結果寫回既有 photos.json 快取。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'data', 'manual', 'photo-manifest.json');
const OUT = join(ROOT, 'data', 'manual', 'photos.json');
const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
// API-Football Free 方案目前只開放到 2024；用最後可用賽季查球員檔案，
// 頭貼本身是球員 profile，不會把 2024 的比賽統計混進本季資料。
const SEASON = Number(process.env.API_FOOTBALL_PHOTO_SEASON ?? 2024);
const DAILY_LIMIT = Math.max(1, Number(process.env.API_FOOTBALL_PHOTO_DAILY_LIMIT ?? 10));
const LIMIT = Math.max(1, Number(process.argv.find(x => x.startsWith('--limit='))?.split('=')[1] ?? DAILY_LIMIT));
const DELAY = Math.max(1000, Number(process.env.API_FOOTBALL_PHOTO_DELAY ?? 1200));
const RETRY_FAILED = process.argv.includes('--retry-failed');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = buf => createHash('sha256').update(buf).digest('hex');
const normalise = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = value => new Set(normalise(value).split(/\s+/).filter(Boolean));

const PYTHON = String.raw`
import io, sys
from PIL import Image
raw = sys.stdin.buffer.read()
im = Image.open(io.BytesIO(raw)).convert('RGBA')
if im.width < 20 or im.height < 20:
    raise ValueError(f'image too small: {im.width}x{im.height}')
h = max(1, round(im.height * 96 / im.width))
im = im.resize((96, h), Image.Resampling.LANCZOS)
bg = Image.new('RGB', im.size, '#1a1420')
bg.paste(im, mask=im.getchannel('A'))
out = io.BytesIO()
bg.save(out, 'JPEG', quality=78, optimize=True)
sys.stdout.buffer.write(out.getvalue())
`;

function toJpeg(raw) {
  const run = spawnSync('python3', ['-c', PYTHON], { input: raw, encoding: null, maxBuffer: 5 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Pillow 處理失敗: ${run.stderr.toString().trim()}`);
  return Buffer.from(run.stdout);
}

async function apiSearch(query) {
  const url = `${BASE}/players?league=39&season=${SEASON}&search=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'x-apisports-key': KEY, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors && Object.keys(body.errors).length) {
    throw new Error(String(body.errors?.plan || body.errors?.requests || body.message || `HTTP ${res.status}`).slice(0, 220));
  }
  return Array.isArray(body.response) ? body.response : [];
}

async function fetchImage(url) {
  const res = await fetch(url, { headers: { accept: 'image/*', 'user-agent': 'pixnew-api-photo-cache/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`圖片 HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error(`圖片格式不是 image/* (${type || '未知'})`);
  return Buffer.from(await res.arrayBuffer());
}

function candidateTeamCodes(candidate, T) {
  return [...new Set((candidate?.statistics ?? []).map(x => T.codeOf(x?.team?.name)).filter(Boolean))];
}

function candidateScore(candidate, target, T) {
  const p = candidate?.player ?? {};
  const full = normalise([p.firstname, p.lastname].filter(Boolean).join(' '));
  const apiName = normalise(p.name);
  const targetFull = normalise(target.fullName);
  const targetName = normalise(target.name);
  const targetTokens = tokens(target.fullName || target.name);
  const candidateTokens = tokens([p.firstname, p.lastname, p.name].filter(Boolean).join(' '));
  const common = [...targetTokens].filter(x => candidateTokens.has(x)).length;
  const teams = candidateTeamCodes(candidate, T);
  const sameTeam = teams.includes(target.team);
  let score = common + (sameTeam ? 40 : 0);
  if (full && full === targetFull) score += 100;
  if (apiName && apiName === targetName) score += 80;
  if (teams.length && !sameTeam) score -= 80;
  return { score, sameTeam, teams, full, apiName };
}

function pickCandidate(rows, target, T) {
  const ranked = rows.map(row => ({ row, rank: candidateScore(row, target, T) }))
    .filter(x => x.row?.player?.photo).sort((a, b) => b.rank.score - a.rank.score);
  const best = ranked[0];
  if (!best) return null;
  const exactFull = best.rank.full && best.rank.full === normalise(target.fullName);
  // 有隊伍資訊必須同隊；沒有隊伍資訊只接受完整姓名精確相同。
  if (best.rank.teams.length ? !best.rank.sameTeam : !exactFull) return null;
  return best.row;
}

async function save(store, manifest) {
  store._count = Object.keys(store.photos ?? {}).length;
  store._missing = manifest.players.map(p => p.code).filter(code => !store.photos[code]);
  store._updated = new Date().toISOString().slice(0, 10);
  const tmp = `${OUT}.tmp`;
  await writeFile(tmp, JSON.stringify(store));
  await rename(tmp, OUT);
}

async function main() {
  if (!KEY) { console.log('⚠ 未設定 API_FOOTBALL_KEY，略過 API 頭貼補抓。'); return; }
  if (!existsSync(MANIFEST) || !existsSync(OUT)) throw new Error('缺少 photo-manifest.json 或 photos.json');
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const store = JSON.parse(await readFile(OUT, 'utf8'));
  store.photos ??= {};
  store._apiPhotoAttempts ??= {};
  const T = loadTeams(ROOT);
  const today = new Date().toISOString().slice(0, 10);
  const sameBudget = store._apiPhotoBudget?.date === today
    && Number(store._apiPhotoBudget.season ?? 0) === SEASON;
  const usedToday = sameBudget ? Number(store._apiPhotoBudget.used ?? 0) : 0;
  const remaining = Math.max(0, Math.min(LIMIT, DAILY_LIMIT - usedToday));
  if (!remaining) { console.log(`✔ 今日 API 頭貼額度已用 ${usedToday}/${DAILY_LIMIT}，下次再補。`); return; }
  const missing = manifest.players.filter(p => !store.photos[p.code]
    && (RETRY_FAILED || !store._apiPhotoAttempts[p.code]?.[String(SEASON)])).slice(0, remaining);
  if (!missing.length) { console.log(`✔ 沒有可用 API 頭貼待補（仍缺 ${manifest.players.filter(p => !store.photos[p.code]).length} 人）。`); return; }
  const hashes = new Set(Object.values(store.photos).map(uri => uri.includes(',') ? sha(Buffer.from(uri.split(',')[1], 'base64')) : null).filter(Boolean));
  const record = { source: 'api-football', season: SEASON, attempted: 0, got: 0, date: today };
  let used = usedToday;
  console.log(`▶ API-Football 補抓 ${missing.length} 人（本日 ${used}/${DAILY_LIMIT}，單線 ${DELAY}ms）`);
  for (const [i, target] of missing.entries()) {
    process.stdout.write(`  ${i + 1}/${missing.length} ${target.fullName} … `);
    record.attempted++; used++;
    try {
      const candidate = pickCandidate(await apiSearch(target.name || target.fullName), target, T);
      if (!candidate) throw new Error('沒有通過姓名／隊伍核對的候選人');
      const jpeg = toJpeg(await fetchImage(candidate.player.photo));
      const digest = sha(jpeg);
      if (hashes.has(digest)) throw new Error('重複圖');
      hashes.add(digest);
      store.photos[target.code] = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
      delete store._apiPhotoAttempts[target.code];
      record.got++;
      console.log(`✔ ${candidate.player.name}`);
    } catch (error) {
      store._apiPhotoAttempts[target.code] ??= {};
      store._apiPhotoAttempts[target.code][String(SEASON)] = String(error.message).slice(0, 180);
      console.log(`略過（${String(error.message).slice(0, 100)}）`);
    }
    store._apiPhotoBudget = { date: today, season: SEASON, used };
    await save(store, manifest);
    if (i < missing.length - 1) await sleep(DELAY);
  }
  store._apiPhotoBudget = { date: today, season: SEASON, used };
  store._sources = [...(store._sources ?? []), record];
  await save(store, manifest);
  console.log(`✔ 本批新增 ${record.got}/${record.attempted}・仍缺 ${store._missing.length}`);
}

main().catch(error => { console.error(`✗ ${error.message}`); process.exitCode = 1; });
