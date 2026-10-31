#!/usr/bin/env node
/* 聯賽球員的頭貼(英冠、西甲、德甲、義甲、法甲)。**一個球員一個請求**,所以每次部署只抓一點。
 *
 * 2026-10-31 使用者先選「只抓榜上的人」(第一次 292 人);同日再同意「每次抓數據抓一點」補其餘的人:
 * 每次部署最多 40 人(一天兩次部署 ≈ 80 個請求),榜上的人永遠排最前,其餘本季先、上場分鐘多的先。
 * 全部約兩千人,大約三四週補完;之後每次只補新出現的人。總請求數沒有變少,只是分散 —— 不在任何一次連續抓幾百張。
 * 網址與魔數判準跟歐冠那一支同一份(`lib/fotmob-photo.mjs`,探測 run #40 證明過)。
 *
 * 要抓誰:
 *   - 英冠(逐場累加):榜的列本來就帶 FotMob 的 `pid`;
 *   - 西甲與德義法(Understat):榜的列是 Understat id,要經 players.json 的 `fotmobId` —— 那是 build 用
 *     `attachFotmobIdentity` 掛的,只有 FotMob 逐場跟 Understat 的出場與分鐘對上的那一季才有。對不上的人**不抓**
 *     (拿不準是哪一個 FotMob id 的人,抓下來的臉可能是別人的)。本站已經有頭貼的人(西甲的 SportMonks)不抓。
 *   - 本季與上季的榜都算(球員頁有季別切換)。
 *   - 榜外的人(2026-10-31 起):players.json 裡每一個有 FotMob id 的人,排在榜上的人後面(photoQueue)。
 *
 * **它讀的是這一次部署剛 build 出來的聯賽產物**,所以 workflow 裡排在各聯賽 build 之後;抓到的圖寫進
 * `data/manual/league-photos.json`,**下一次部署**的 build 才掛得上去 —— 一次部署的延遲(歐冠那一支同一個理由)。
 * 聯賽產物不回寫進倉庫,所以排在 build 之前的話它讀到的是倉庫裡的舊產物(沒有 fotmobId),一個人都抓不到。
 *
 * 用法:
 *   npm run league:photos                  # 補缺的,最多 40 人(榜上的人先)
 *   npm run league:photos -- --plan        # 只印要抓幾個人,不發請求(沙箱用)
 *   npm run league:photos -- --limit=10
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pillowReady, toJpeg } from './lib/photo-jpeg.mjs';
import { fetchFotmobPhoto, FOTMOB_PHOTO_URL } from './lib/fotmob-photo.mjs';
import { LEAGUE_PHOTOS, loadLeaguePhotos } from './lib/league-photos.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEAGUES_DIR = join(ROOT, 'web', 'data', 'leagues');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
/* 40:使用者同意的量(2026-10-31)。40 × 1.2 秒 ≈ 1 分鐘。榜上的 292 人在這之前已用 150 / 輪補完 */
const LIMIT = Math.max(1, Number(arg('limit') || 40));
const DELAY_MS = Math.max(1000, Number(arg('delay') || 1200));
const PLAN = process.argv.includes('--plan');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async p => JSON.parse(await readFile(p, 'utf8'));

/* 一個聯賽要誰的頭貼 → { board: Map(fid → name), rest: [{ fid, name, cur, minutes }], noId, hasPhoto }。
   榜上的人先(畫面最常看到);其餘的人(2026-10-31 使用者同意「每次抓一點」)排在後面,本季先、同一季上場分鐘多的先。
   沒有 FotMob id 的人另計(noId)、不抓:拿不準是哪一個 FotMob id 的人,抓下來的臉可能是別人的。 */
async function wantedFor(lg) {
  const dir = join(LEAGUES_DIR, lg);
  if (!existsSync(join(dir, 'leaders.json')) || !existsSync(join(dir, 'players.json'))) return null;
  const leaders = await readJson(join(dir, 'leaders.json'));
  if (!leaders.available && !leaders.source) return null;
  const players = await readJson(join(dir, 'players.json'));
  const meta = existsSync(join(dir, 'meta.json')) ? await readJson(join(dir, 'meta.json')) : {};
  const current = leaders.seasons?.current ?? meta.currentSeason ?? null;
  const board = new Map(), rest = []; let noId = 0, hasPhoto = 0;
  /* 這個人要不要抓、用哪個 FotMob id:英冠的 providerId 就是 FotMob id;Understat 的聯賽經 build 掛的 fotmobId */
  const fidOf = p => (leaders.source === 'match-aggregate' ? p.providerId : p.fotmobId);
  const ownPhoto = p => p.photo && p.photoSource !== 'FotMob' && leaders.source !== 'match-aggregate';
  if (leaders.source === 'match-aggregate') {
    const photo = new Set(players.filter(p => p.photo).map(p => String(p.providerId)));
    for (const boards of Object.values(leaders.boards ?? {})) for (const b of boards ?? []) for (const r of b.rows ?? []) {
      if (r.pid == null) { noId++; continue; }
      if (photo.has(String(r.pid))) { hasPhoto++; continue; }
      board.set(String(r.pid), r.name);
    }
  } else if (leaders.source === 'Understat') {
    const bySeasonId = new Map(players.map(p => [`${p.season}|${p.id}`, p]));
    for (const [slot, season] of [['current', leaders.seasons?.current], ['last', leaders.seasons?.last]]) {
      for (const rows of Object.values(leaders[slot] ?? {})) for (const r of Array.isArray(rows) ? rows : []) {
        const p = bySeasonId.get(`${season}|${r.id}`);
        if (p && ownPhoto(p)) { hasPhoto++; continue; }
        if (!p?.fotmobId) { noId++; continue; }
        board.set(String(p.fotmobId), r.name);
      }
    }
  } else return null;
  let restNoId = 0;
  for (const p of players) {
    if (ownPhoto(p)) continue;
    const fid = fidOf(p);
    if (fid == null) { restNoId++; continue; }
    if (board.has(String(fid))) continue;
    rest.push({ fid: String(fid), name: p.name, cur: p.season === current, minutes: Number(p.minutes) || 0 });
  }
  return { board, rest, noId, restNoId, hasPhoto };
}

/* 排隊的順序(純函式,npm test 守著):榜上的人 → 本季 → 上場分鐘多的;同一個人只排一次(取最前面的那個位置) */
export function photoQueue(lists) {
  const best = new Map();
  for (const { board, rest } of lists) {
    for (const [fid, name] of board) best.set(fid, { fid, name, key: [0, 0, 0] });
    for (const r of rest) {
      const key = [1, r.cur ? 0 : 1, -r.minutes];
      const old = best.get(r.fid);
      if (!old || cmp(key, old.key) < 0) best.set(r.fid, { fid: r.fid, name: r.name, key });
    }
  }
  return [...best.values()].sort((a, b) => cmp(a.key, b.key) || Number(a.fid) - Number(b.fid));
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

async function main() {
  const leagues = existsSync(LEAGUES_DIR) ? readdirSync(LEAGUES_DIR).filter(d => existsSync(join(LEAGUES_DIR, d, 'leaders.json'))).sort() : [];
  const lists = [];
  for (const lg of leagues) {
    const w = await wantedFor(lg);
    if (!w) continue;
    console.log(`  ${lg}:榜上 ${w.board.size} 人・其餘 ${w.rest.length} 人-季・已有別的來源 ${w.hasPhoto}`
      + `・沒有對上的 FotMob id:榜上 ${w.noId} 列、其餘 ${w.restNoId} 人-季(不抓)`);
    lists.push({ board: new Map([...w.board].map(([fid, name]) => [fid, `${name}(${lg})`])),
      rest: w.rest.map(r => ({ ...r, name: `${r.name}(${lg})` })) });
  }
  const queue = photoQueue(lists);
  const all = new Map(queue.map(q => [q.fid, q.name]));
  const store = loadLeaguePhotos(ROOT);
  const have = new Set(Object.keys(store.photos));
  const burnt = new Set(Object.entries(store._attempts).filter(([, a]) => (a.hard ?? 0) >= 3).map(([k]) => k));
  const todo = queue.filter(q => !have.has(q.fid) && !burnt.has(q.fid)).map(q => [q.fid, q.name]);
  const boardLeft = queue.filter(q => q.key[0] === 0 && !have.has(q.fid) && !burnt.has(q.fid)).length;
  console.log(`▶ 聯賽球員頭貼:不重複 ${all.size} 人(榜上還缺 ${boardLeft})・已有 ${[...all.keys()].filter(id => have.has(id)).length}`
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error('抓取失敗:', e.message); process.exitCode = 1; });
