#!/usr/bin/env node
/* 在 runner 上把**德義法球隊頁抓取器真的跑一次**,寫暫存目錄(不動倉庫),印摘要與可以逐位元組還原的內容
 * (照 probe-intl-fetch.mjs 的做法:DUMP 一定排最後,`undump-probe-log.mjs` 還原並比對 sha256)。
 * 2026-10-09:先把原始欄位(含還沒讀過的 coachHistory / teamColors)拿回倉庫,再寫轉換器。 59 個請求。
 *   npm run probe:league-teams-fetch */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fetchLeagueTeams, LEAGUES } from './fetch-league-teams-fotmob.mjs';

const out = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'fotmob-teams-'));
let req = 0;
for (const k of Object.keys(LEAGUES)) req += (await fetchLeagueTeams(k, { outDir: out, force: true })).requests;
console.log(`請求數 ${req}`);
for (const f of readdirSync(out).sort()) {
  const j = JSON.parse(readFileSync(join(out, f), 'utf8'));
  console.log(`\n▶ ${f}(${j.teams.length} 隊)`);
  const t0 = j.teams[0];
  console.log(`  coachHistory 樣本(${t0.fotmobName}):${JSON.stringify(t0.coachHistory).slice(0, 500)}`);
  console.log(`  teamColors 樣本:${JSON.stringify(t0.teamColors).slice(0, 300)}`);
  for (const t of j.teams) console.log(`  ${t.code} | ${t.venue} | ${t.city} | ${t.capacity} | ${t.color}`);
}
console.log(`\n${'─'.repeat(72)}\n▶ DUMP(gzip + base64;本機還原後比對 sha256)`);
for (const f of readdirSync(out).sort()) {
  const buf = readFileSync(join(out, f));
  const sha = createHash('sha256').update(buf).digest('hex');
  const chunks = gzipSync(buf, { level: 9 }).toString('base64').match(/.{1,3000}/g) ?? [];
  console.log(`DUMP-BEGIN ${f} ${buf.length} ${sha} ${chunks.length}`);
  chunks.forEach((c, i) => console.log(`DUMP ${f} ${i} ${c}`));
  console.log(`DUMP-END ${f}`);
}
console.log('✔ 探測結束(沒有寫倉庫裡的任何檔)');
