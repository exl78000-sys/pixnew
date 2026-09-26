/* 總覽的跨聯賽摘要(2026-09-26,A4b)—— 從剛寫出去的 cups / ucl / ucl-teams / ucl-elo / intl / clubs 抽一份
   web/data/overview-shared.json。排在 npm run build 的 build-intl 之後(intl.json 那時才有)、prune-images 之前。
   理由與欄位清單在 lib/overview-shared.mjs。 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overviewSharedFrom, overviewSharedCounts } from './lib/overview-shared.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'web', 'data');

// 沒有那份產物就當 null(國家隊、歐冠勝率本來就是「讀不到就當沒有」);壞掉的 JSON 照樣拋
const readOpt = async f => {
  try { return JSON.parse(await readFile(join(DATA, f), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};

const [cups, ucl, uclTeams, uclElo, intl] = await Promise.all(
  ['cups.json', 'ucl.json', 'ucl-teams.json', 'ucl-elo.json', 'intl.json'].map(readOpt));
const out = overviewSharedFrom({ cups, ucl, uclTeams, uclElo, intl });
const json = JSON.stringify(out);
await writeFile(join(DATA, 'overview-shared.json'), json);
const n = overviewSharedCounts(out);
console.log(`✔ web/data/overview-shared.json(${(json.length / 1024).toFixed(0)} KB;盃賽未賽 ${n.cupPending} 場、歐冠未賽 ${n.uclPending} 場、國家隊 ${n.intlFixtures} 場)`);
