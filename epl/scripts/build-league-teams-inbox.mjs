#!/usr/bin/env node
/* 把 `data/raw/fotmob-teams/{聯賽}.json` 轉成球隊資料收件匣(`data/manual/{x}-teams-delivery.json`),
 * 之後由 `{聯賽}:verify-teams` 核對、build 只讀核對後的產物。raw 還沒有的聯賽略過(不是錯)。
 * 收件匣是**產物**:每次部署從 raw 重產(位元組穩定,sha 不變就不重核對),不進版控。
 *   node scripts/build-league-teams-inbox.mjs [--league=de1] */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTeamsInbox } from './lib/league-teams-inbox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MAP = {
  de1: { zh: '德甲', roster: 'teams-bundesliga.json', inbox: 'bundesliga-teams-delivery.json' },
  it1: { zh: '義甲', roster: 'teams-serie-a.json', inbox: 'serie-a-teams-delivery.json' },
  fr1: { zh: '法甲', roster: 'teams-ligue-1.json', inbox: 'ligue-1-teams-delivery.json' },
};
const arg = process.argv.find(a => a.startsWith('--league='))?.split('=')[1];
for (const [k, L] of Object.entries(MAP)) {
  if (arg && arg !== k) continue;
  const rawPath = join(ROOT, 'data', 'raw', 'fotmob-teams', `${k}.json`);
  if (!existsSync(rawPath)) { console.log(`· ${L.zh}:還沒有 FotMob 球隊頁的 raw,略過`); continue; }
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  const roster = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', L.roster), 'utf8')).teams;
  const inbox = toTeamsInbox(raw, roster);
  writeFileSync(join(ROOT, 'data', 'manual', L.inbox), JSON.stringify(inbox, null, 2) + '\n');
  console.log(`✔ ${L.zh}:收件匣 ${inbox.teams.length} 隊(來源 ${raw.season},${inbox.retrievedAt})`);
}
