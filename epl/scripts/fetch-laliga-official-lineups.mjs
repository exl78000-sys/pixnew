#!/usr/bin/env node
// 從西甲官網比賽頁快取已完賽正式先發、替補、官方陣型與球員頭像。
// 只處理明確列出的待補場次；成功後永久快取，不在開頁時連線。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEASON = '2026-27';
const BASE = join(ROOT, 'data', 'raw', 'laliga-official');
const STORE_FILE = join(BASE, `${SEASON}-lineups.json`);
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';

// FotMob 目前找不到的兩場，網址來自 LaLiga 官方賽事頁的 slug。
const PAGES = [
  {
    key: 'DEP|ELC',
    url: 'https://www.laliga.com/partido/temporada-2026-2027-laliga-ea-sports-rc-deportivo-elche-cf-1',
  },
  {
    key: 'MAL|DEP',
    url: 'https://www.laliga.com/es-AR/partido/temporada-2026-2027-laliga-ea-sports-malaga-cf-rc-deportivo-2',
  },
];

const emptyStore = () => ({
  version: 1, source: 'laliga.com', season: SEASON, updatedAt: null, matches: {}, attempts: {},
});

async function loadStore() {
  if (!existsSync(STORE_FILE)) return emptyStore();
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, 'utf8'));
    return { ...emptyStore(), ...parsed, matches: parsed.matches ?? {}, attempts: parsed.attempts ?? {} };
  } catch { return emptyStore(); }
}

function nextData(html) {
  const marker = '<script id="__NEXT_DATA__"';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('找不到官方頁 __NEXT_DATA__');
  const bodyStart = html.indexOf('>', start) + 1;
  const bodyEnd = html.indexOf('</script>', bodyStart);
  if (bodyStart <= 0 || bodyEnd < 0) throw new Error('官方頁 __NEXT_DATA__ 不完整');
  return JSON.parse(html.slice(bodyStart, bodyEnd));
}

const formationLabel = value => {
  const digits = String(value ?? '').replace(/[^0-9]/g, '').split('');
  return digits.length >= 2 ? digits.join('-') : null;
};

function playerOf(raw, pos) {
  const person = raw?.person ?? {};
  const photo = raw?.photos?.['003']?.['64x64'] ?? null;
  return {
    providerId: raw?.id ?? null,
    name: person.nickname || person.name || '',
    officialName: person.name || null,
    number: raw?.shirt_number ?? null,
    pos,
    rating: null,
    photo,
    captain: raw?.captain === true,
    source: 'laliga.com',
  };
}

function sideOf(side, formationCode) {
  const formation = formationLabel(formationCode);
  const counts = String(formation ?? '').split('-').map(Number).filter(Number.isFinite);
  const starts = side?.starts ?? [];
  if (!formation || counts.length < 2 || starts.length !== 11) return null;
  const rows = [];
  let offset = 0;
  rows.push([playerOf(starts[offset++], 'G')]);
  for (let i = 0; i < counts.length; i++) {
    const isLast = i === counts.length - 1;
    const pos = isLast ? 'F' : 'M';
    if (i === 0) {
      rows.push(Array.from({ length: counts[i] }, () => playerOf(starts[offset++], 'D')));
    } else {
      rows.push(Array.from({ length: counts[i] }, () => playerOf(starts[offset++], pos)));
    }
  }
  if (rows.flat().length !== 11) return null;
  return {
    team: null,
    formation,
    xi: rows.flat(),
    rows,
    substitutes: (side?.subs ?? []).map(raw => playerOf(raw, '?')),
    source: 'laliga.com',
  };
}

async function main() {
  const store = await loadStore();
  const dryRun = process.argv.includes('--dry-run');
  const pending = PAGES.filter(page => !store.matches[page.key]);
  console.log(`▶ LaLiga 官方 ${SEASON}：永久快取 ${Object.keys(store.matches).length}/${PAGES.length} 場`);
  if (!pending.length || dryRun) {
    pending.forEach(page => console.log(`  · ${page.key} ${page.url}`));
    return;
  }

  for (const page of pending) {
    try {
      const response = await fetch(page.url, { headers: { accept: 'text/html', 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = nextData(await response.text());
      const match = payload.props?.pageProps?.match;
      const data = payload.props?.pageProps?.data;
      const home = sideOf(data?.lineups?.home, match?.home_formation);
      const away = sideOf(data?.lineups?.away, match?.away_formation);
      const valid = match?.status === 'FullTime' && home && away
        && Number.isFinite(match.home_score) && Number.isFinite(match.away_score);
      if (!valid) throw new Error('官方頁缺少完賽比分或兩隊 11 人先發');
      home.team = match.home_team?.nickname ?? match.home_team?.name ?? page.key.split('|')[0];
      away.team = match.away_team?.nickname ?? match.away_team?.name ?? page.key.split('|')[1];
      store.matches[page.key] = {
        matchId: String(match.id), season: SEASON, date: String(match.date).slice(0, 10),
        home: page.key.split('|')[0], away: page.key.split('|')[1],
        score: { home: Number(match.home_score), away: Number(match.away_score) },
        source: 'laliga.com', sourceUrl: page.url, fetchedAt: new Date().toISOString(),
        lineup: { home, away },
        coverage: { formations: true, starters: true, positions: false, layouts: false,
          ratings: false, photos: true, substitutes: true },
      };
      delete store.attempts[page.key];
      console.log(`  ✓ ${page.key}: ${home.formation} / ${away.formation}・11+11 先發・頭像已保存`);
    } catch (error) {
      store.attempts[page.key] = { at: new Date().toISOString(), reason: error.message, sourceUrl: page.url };
      console.log(`  ⚠ ${page.key}: ${error.message}`);
    }
  }
  await mkdir(BASE, { recursive: true });
  store.updatedAt = new Date().toISOString();
  await writeFile(STORE_FILE, JSON.stringify(store, null, 1));
  console.log(`✔ LaLiga 官方快取完成：${Object.keys(store.matches).length}/${PAGES.length} 場`);
  console.log(`  檔案：${STORE_FILE}`);
}

main().catch(error => { console.error(`✗ ${error.message}`); process.exitCode = 1; });
