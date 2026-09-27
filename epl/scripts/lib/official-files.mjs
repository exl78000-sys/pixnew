/* 官方逐場資料拆成索引 + 逐場檔(2026-09-27,單場頁的摘要)。

   official.json 原本一場 13.8 KB(兩隊的正式先發 rows / xi / subs、進球、牌與換人的時間軸),英超 50 場 657 KB;
   單場頁只用**那一場**,卻每次整份載。跟賽後報告(match-reports/)同一條路:
   - `official.json` 只留索引:每場的 fixtureId / kickoff / final / clock / score / source + `body: true`,加 managers 那些整份的欄位;
   - 本體一場一檔 `official/{HOME}-{AWAY}.json`(鍵是「主|客」,一季內唯一);
   - 讀回來的 `readOfficialMatches(dir)` 把索引跟本體併回原本的形狀 —— 測試、vault、任何 Node 端讀者走它,形狀不變。
   前端:單場頁先讀索引,那一場有 body 才 loadFrom 那一檔。單檔版(bundle)把本體照 'official/{HOME}-{AWAY}' 的鍵打進去。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { externalizeImages } from './image-files.mjs';

export const OFFICIAL_INDEX_KEYS = ['fixtureId', 'kickoff', 'final', 'clock', 'score', 'source'];
export const officialBodyName = key => `official/${String(key).replace('|', '-')}`;

/* 寫本體、回索引。img 是各 build 的 IMG(externalizeImages 的參數):本體裡可能有頭貼(西甲官網備援那條路),
   跟其他產物一樣圖要外置。不在索引裡的舊本體檔會清掉(隊碼換季會變,留著就是孤兒)。 */
export function writeOfficialFiles({ outDir, official, img }) {
  const dir = join(outDir, 'official');
  mkdirSync(dir, { recursive: true });
  const index = { ...official, matches: {} };
  const keep = new Set();
  let bodies = 0;
  for (const [key, m] of Object.entries(official?.matches ?? {})) {
    if (!m || typeof m !== 'object') continue;
    const slim = {};
    for (const k of OFFICIAL_INDEX_KEYS) if (m[k] !== undefined) slim[k] = m[k];
    slim.body = true;
    index.matches[key] = slim;
    const file = `${String(key).replace('|', '-')}.json`;
    keep.add(file);
    writeFileSync(join(dir, file), JSON.stringify(externalizeImages(m, { ...(img ?? {}), stats: {} })));
    bodies++;
  }
  let pruned = 0;
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && !keep.has(f)) { unlinkSync(join(dir, f)); pruned++; }
  return { index, bodies, pruned };
}

/* 讀回原本的形狀:{ ...索引, matches: { key: 本體 } }。沒有 body 的(舊產物、或還沒拆)照索引原樣。 */
export function readOfficialMatches(dataDir) {
  const p = join(dataDir, 'official.json');
  if (!existsSync(p)) return null;
  const idx = JSON.parse(readFileSync(p, 'utf8'));
  const matches = {};
  const missing = [];
  for (const [key, m] of Object.entries(idx?.matches ?? {})) {
    if (m?.body) {
      const f = join(dataDir, 'official', `${String(key).replace('|', '-')}.json`);
      if (existsSync(f)) { matches[key] = JSON.parse(readFileSync(f, 'utf8')); continue; }
      missing.push(key);
    }
    matches[key] = m;
  }
  return { ...idx, matches, missingBodies: missing };
}

/* 單檔版打包用:本體檔一張一個鍵('official/HOME-AWAY'),跟前端 loadFrom 組出來的名字一致 */
export function officialBodyEntries(dataDir) {
  const dir = join(dataDir, 'official');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => [`official/${f.replace(/\.json$/, '')}`, JSON.parse(readFileSync(join(dir, f), 'utf8'))]);
}
