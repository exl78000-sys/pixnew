#!/usr/bin/env node
/* Understat 歷史季的球員名冊(2026-10-14,使用者同意:「2024-25 同意」)。

   為什麼:租借核對器(verify-loans.mjs)要拿獨立的逐季名冊確認「這個人當季在租借目的地」。
   本站原本只有 2025-26 / 2026-27 的名冊,交付裡 2024-25 那一季有 130 筆因此「無法核對、不發布」。
   Understat 一個聯賽一季一個請求(五大聯賽 = 5 個),完結的賽季不會再變,**抓過就快取**(current: null)。

   用法:node scripts/fetch-understat-history.mjs [--season=2024-25] [--force] */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchUnderstatPlayers } from './lib/understat-fetch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const season = process.argv.find(a => a.startsWith('--season='))?.split('=')[1] ?? '2024-25';
const provider = Number(season.slice(0, 4));
const LEAGUES = [
  { league: 'EPL', label: '英超', teamFile: 'teams.json', dir: 'understat' },
  { league: 'La_liga', label: '西甲', teamFile: 'teams-la-liga.json', dir: 'understat-la-liga' },
  { league: 'Bundesliga', label: '德甲', teamFile: 'teams-bundesliga.json', dir: 'understat-bundesliga' },
  { league: 'Serie_A', label: '義甲', teamFile: 'teams-serie-a.json', dir: 'understat-serie-a' },
  { league: 'Ligue_1', label: '法甲', teamFile: 'teams-ligue-1.json', dir: 'understat-ligue-1' },
];
for (const L of LEAGUES) {
  await fetchUnderstatPlayers({
    root: ROOT, ...L, seasons: [{ label: season, provider }], current: null,
    force: process.argv.includes('--force'), delay: 1600,
    note: `POST league=${L.league}&season=${provider},整季一個請求。歷史季(租借核對用),抓過就快取。`,
  });
}
