#!/usr/bin/env node
// 每日低頻取得現任教練公開頭貼。英超官方 staff API 沒有圖片欄位，
// 因此使用 Wikipedia REST 的人物縮圖作補充；西甲先沿用官方圖片，缺圖才查 Wikipedia。
// 只寫本地快取，前端不連外，也不把無圖或消歧頁當成成功。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'coach-photos.json');
const TTL_MS = 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';
const WIKI = 'https://en.wikipedia.org/api/rest_v1/page/summary/';

const empty = () => ({ version: 1, retrievedAt: null, photos: {}, attempts: {} });
async function load() {
  if (!existsSync(OUT)) return empty();
  try { const x = JSON.parse(await readFile(OUT, 'utf8')); return { ...empty(), ...x, photos: x.photos ?? {}, attempts: x.attempts ?? {} }; }
  catch { return empty(); }
}
const keyOf = (league, team) => `${league}:${team}`;
const norm = value => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function namesToFetch() {
  const out = [];
  const seen = new Set();
  const add = (league, team, name, preferred = null, preferredSource = null) => {
    if (!team || !name) return;
    const key = keyOf(league, team);
    if (seen.has(key)) return;
    seen.add(key); out.push({ league, team, name, preferred, preferredSource });
  };
  try {
    const x = JSON.parse(await readFile(join(ROOT, 'data', 'raw', 'pulselive', 'official.json'), 'utf8'));
    for (const [team, manager] of Object.entries(x.managers ?? {})) add('epl', team, manager.name);
  } catch { /* official cache may be unavailable; manual data still covers the build */ }
  try {
    const x = JSON.parse(await readFile(join(ROOT, 'data', 'manual', 'coaches.json'), 'utf8'));
    for (const c of x.coaches ?? []) if (!seen.has(keyOf('epl', c.team))) add('epl', c.team, c.name);
  } catch { /* no manual fallback */ }
  try {
    const x = JSON.parse(await readFile(join(ROOT, 'data', 'raw', 'laliga-official', '2026-27-coaches.json'), 'utf8'));
    for (const c of x.coaches ?? []) add('es1', c.team, c.name, c.imagePath, c.imagePath ? 'LaLiga' : null);
  } catch { /* official cache may be unavailable */ }
  return out;
}

async function wikiPhoto(name) {
  const title = encodeURIComponent(String(name).trim().replace(/\s+/g, '_'));
  const response = await fetch(`${WIKI}${title}`, {
    headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.type !== 'standard' || !payload.thumbnail?.source) throw new Error('沒有可核對的人物縮圖');
  return { imagePath: payload.thumbnail.source, source: 'Wikipedia', sourceUrl: payload.content_urls?.desktop?.page ?? null };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function main() {
  const store = await load();
  const force = process.argv.includes('--force');
  const age = store.retrievedAt ? Date.now() - Date.parse(store.retrievedAt) : Infinity;
  const rows = await namesToFetch();
  const missing = rows.filter(row => !store.photos[keyOf(row.league, row.team)]?.imagePath);
  if (!force && Number.isFinite(age) && age >= 0 && age < TTL_MS && !missing.length) {
    console.log(`▶ 教練頭貼快取仍有效：${Object.keys(store.photos).length} 筆，24 小時內略過`);
    return store;
  }
  const next = { ...store, retrievedAt: new Date().toISOString(), attempts: {} };
  let fetched = 0;
  for (const row of rows) {
    const key = keyOf(row.league, row.team);
    if (!force && store.photos[key]?.imagePath && !row.preferred) continue;
    if (row.preferred && /^https?:\/\//i.test(row.preferred) && !/default-player|placeholder/i.test(row.preferred)) {
      next.photos[key] = { team: row.team, league: row.league, name: row.name, imagePath: row.preferred,
        source: row.preferredSource ?? 'official', sourceUrl: row.preferred };
      fetched++; console.log(`  ✓ ${key}: ${row.name}（${row.preferredSource ?? 'official'}）`); continue;
    }
    try {
      const photo = await wikiPhoto(row.name);
      next.photos[key] = { team: row.team, league: row.league, name: row.name, ...photo };
      fetched++; console.log(`  ✓ ${key}: ${row.name}（Wikipedia）`);
    } catch (error) {
      next.attempts[key] = { name: row.name, at: new Date().toISOString(), reason: error.message };
      console.log(`  ⚠ ${key}: ${row.name}（${error.message}）`);
    }
    await sleep(250);
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(next, null, 1));
  console.log(`✔ 教練頭貼快取完成：${fetched}/${rows.length} 筆`);
  console.log(`  檔案：${OUT}`);
  return next;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => {
  console.error(`✗ ${error.message}`); process.exitCode = 1;
});
