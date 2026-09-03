#!/usr/bin/env node
/* 模擬遊玩的 build:產 `web/data/game/pl.json`。
 *
 * 獨立管線(使用者 2026-09-03 的決定):只讀真實管線的產物與 raw,只寫 `web/data/game/`。
 * 所以要在 `npm run build` **之後**跑(它讀 build 的產物),而 `stamp-assets` 的戳只管
 * `web/*.html` 與 JS,跟這份資料無關,順序上放在 build 與 stamp 之間或之後都可以;
 * package.json 掛在 `build` 的最後一步之前,讓 `npm run build` 一次到位。
 *
 *   npm run game:build
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameProfile } from './lib/profile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'web', 'data', 'game');

const profile = buildGameProfile(ROOT, { league: 'pl' });
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'pl.json'), JSON.stringify(profile));
const teams = Object.values(profile.teams);
const withXi = teams.filter(t => t.xi.length === 11).length;
const withPoss = teams.filter(t => t.possession.home.n > 0 && t.possession.away.n > 0).length;
console.log(`✔ web/data/game/pl.json:${teams.length} 隊・先發 11 人齊 ${withXi} 隊・控球分布 ${withPoss} 隊`
  + `・射門 ${profile.league_.shotMinutes.n} 次・進球分鐘 ${profile.league_.goalMinutes.n} 顆・換人 ${profile.league_.subs.n} 次`);
