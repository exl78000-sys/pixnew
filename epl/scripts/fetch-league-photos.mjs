#!/usr/bin/env node
/* 聯賽球員榜的頭貼(英冠、西甲、德甲、義甲、法甲)。**一個球員一個請求**,所以只抓榜上的人。
 *
 * 2026-10-31 使用者選「只抓榜上的人」(全部球員一輪約 2,000 個請求,那一級要另外問;榜上的人一次約兩百個)。
 * 網址與魔數判準跟歐冠那一支同一份(`lib/fotmob-photo.mjs`,探測 run #40 證明過)。
 *
 * 要抓誰:
 *   - 英冠(逐場累加):榜的列本來就帶 FotMob 的 `pid`;
 *   - 西甲與德義法(Understat):榜的列是 Understat id,要經 players.json 的 `fotmobId` —— 那是 build 用
 *     `attachFotmobIdentity` 掛的,只有 FotMob 逐場跟 Understat 的出場與分鐘對上的那一季才有。對不上的人**不抓**
 *     (拿不準是哪一個 FotMob id 的人,抓下來的臉可能是別人的)。本站已經有頭貼的人(西甲的 SportMonks)不抓。
 *   - 本季與上季的榜都算(球員頁有季別切換)。
 *
 * **它讀的是這一次部署剛 build 出來的聯賽產物**,所以 workflow 裡排在各聯賽 build 之後;抓到的圖寫進
 * `data/manual/league-photos.json`,**下一次部署**的 build 才掛得上去 —— 一次部署的延遲(歐冠那一支同一個理由)。
 * 聯賽產物不回寫進倉庫,所以排在 build 之前的話它讀到的是倉庫裡的舊產物(沒有 fotmobId),一個人都抓不到。
 *
 * 用法:
 *   npm run league:photos                  # 補榜上缺的,最多 150 人
 *   npm run league:photos -- --plan        # 只印要抓幾個人,不發請求(沙箱用)
 *   npm run league:photos -- --limit=10
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pillowReady, toJpeg } from './lib/photo-jpeg.mjs';
import { fetchFotmobPhoto, FOTMOB_PHOTO_URL } from './lib/fotmob-photo.mjs';
import { LEAGUE_PHOTOS, loadLeaguePhotos } from './lib/league-photos.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEAGUES_DIR = join(ROOT, 'web', 'data', 'leagues');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
/* 150:五個聯賽兩季的榜,不重複的人第一次量是 292 人(2026-10-31 本機;實際數每次印在 log)。兩次部署補完,一輪 150 × 1.2 秒 ≈ 3 分鐘 */
const LIMIT = Math.max(1, Number(arg('limit') || 150));
const DELAY_MS = Math.max(1000, Number(arg('delay') || 1200));
const PLAN = process.argv.includes('--plan');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async p => JSON.parse(await readFile(p, 'utf8'));

/* 一個聯賽的榜上有誰 → [{ fid, name, league }]。沒有 FotMob id 的人另計(skipped),印出來 */
async function wantedFor(lg) {
  const dir = join(LEAGUES_DIR, lg);
  if (!existsSync(join(dir, 'leaders.json')) || !existsSync(join(dir, 'players.json'))) return null;
  const leaders = await readJson(join(dir, 'leaders.json'));
  if (!leaders.available && !leaders.source) return null;
  const players = await readJson(join(dir, 'players.json'));
  const out = new Map(); let noId = 0, hasPhoto = 0;
  if (leaders.source === 'match-aggregate') {
    const photo = new Set(players.filter(p => p.photo).map(p => String(p.providerId)));
    for (const boards of Object.values(leaders.boards ?? {})) for (const b of boards ?? []) for (const r of b.rows ?? []) {
      if (r.pid == null) { noId++; continue; }
      if (photo.has(String(r.pid))) { hasPhoto++; continue; }
      out.set(String(r.pid), r.name);
    }
  } else if (leaders.source === 'Understat') {
    const bySeasonId = new Map(players.map(p => [`${p.season}|${p.id}`, p]));
    for (const [slot, season] of [['current', leaders.seasons?.current], ['last', leaders.seasons?.last]]) {
      for (const rows of Object.values(leaders[slot] ?? {})) for (const r of Array.isArray(rows) ? rows : []) {
        const p = bySeasonId.get(`${season}|${r.id}`);
        if (p?.photo && p.photoSource !== 'FotMob') { hasPhoto++; continue; }
        if (!p?.fotmobId) { noId++; continue; }
        out.set(String(p.fotmobId), r.name);
      }
    }
  } else return null;
  return { ids: [...out.entries()], noId, hasPhoto };
}

async function main() {
  const leagues = existsSync(LEAGUES_DIR) ? readdirSync(LEAGUES_DIR).filter(d => existsSync(join(LEAGUES_DIR, d, 'leaders.json'))).sort() : [];
  const all = new Map();
  for (const lg of leagues) {
    const w = await wantedFor(lg);
    if (!w) continue;
    console.log(`  ${lg}:榜上要頭貼的 ${w.ids.length} 人・已有別的來源 ${w.hasPhoto}・沒有對上的 FotMob id ${w.noId} 列(不抓)`);
    for (const [fid, name] of w.ids) if (!all.has(fid)) all.set(fid, `${name}(${lg})`);
  }
  const store = loadLeaguePhotos(ROOT);
  const have = new Set(Object.keys(store.photos));
  const burnt = new Set(Object.entries(store._attempts).filter(([, a]) => (a.hard ?? 0) >= 3).map(([k]) => k));
  const todo = [...all.entries()].filter(([id]) => !have.has(id) && !burnt.has(id));
  console.log(`▶ 聯賽球員榜頭貼:不重複 ${all.size} 人・已有 ${[...all.keys()].filter(id => have.has(id)).length}`
    + `・試過三次拿不到 ${[...all.keys()].filter(id => burnt.has(id)).length}・這一輪要補 ${Math.min(todo.length, LIMIT)}/${todo.length}`);
  if (PLAN || !todo.length) { console.log(PLAN ? '(--plan:不發請求)' : '✔ 沒有要補的'); return; }

  const ready = pillowReady();
  if (!ready.ok) { console.log(`✔ 略過補抓頭貼:${ready.why}(這不是錯誤,既有的頭貼照常使用)`); return; }

  const out = { _note: '聯賽球員榜的頭貼(自動產生,請勿手改)。FotMob 球員 id → 圖;一個球員一個請求,只抓榜上的人。',
    _license: '頭貼版權屬各攝影授權方,此處僅作為分析工具的識別用途。',
    _source: FOTMOB_PHOTO_URL, _format: 'jpeg', ...store, photos: { ...store.photos }, _attempts: { ...store._attempts } };
  let added = 0, failed = 0;
  for (const [id, name] of todo.slice(0, LIMIT)) {
    if (added || failed) await sleep(DELAY_MS);
    const r = await fetchFotmobPhoto(id);
    if (!r.ok) {
      failed++;
      console.log(`  ✗ ${name} ${id}:${r.why}`);
      /* 狀態 0 是連線層的失敗(沙箱的 403 也落在這裡)—— 不計次,免得一個假失敗永久蓋掉一張拿得到的圖 */
      if (r.status >= 400) { const a = out._attempts[id] ??= { hard: 0 }; a.hard++; a.last = r.why; a.at = new Date().toISOString().slice(0, 10); }
      continue;
    }
    const jpeg = toJpeg(r.buf);
    out.photos[id] = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    delete out._attempts[id];
    added++;
  }
  out._updated = new Date().toISOString().slice(0, 10);
  out._count = Object.keys(out.photos).length;
  out.photos = Object.fromEntries(Object.keys(out.photos).sort((a, b) => Number(a) - Number(b)).map(k => [k, out.photos[k]]));
  await writeFile(LEAGUE_PHOTOS(ROOT), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`✔ 新增 ${added}、失敗 ${failed};store 共 ${out._count} 張`);
}

main().catch(e => { console.error('抓取失敗:', e.message); process.exitCode = 1; });
