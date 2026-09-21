#!/usr/bin/env node
/* 歐冠球員榜的球員照片:**先問「我們本來就抓的那份回應裡有沒有圖」**,再決定要不要一人一個請求。
 *
 * 為什麼要這一支(2026-09-21,使用者選了「先探測」):
 * 榜上想加球員照片,而倉庫裡**一張都沒有** —— 歐冠逐人 raw 的 `photo` 欄位 798 筆全是 null、
 * `data/manual/photos.json` 那 573 張是英超的(鍵是 FPL 的 element id,歐冠球員沒有那個 id)、
 * 西甲那 727 張走 SportMonks(已退訂)。
 *
 * 但 `photo: null` 有兩種可能,而**從沙箱分不出來**:
 *   (甲) 上游這支端點根本不給圖 → 只能一人一個請求去別處抓(抓取禮貌那一條要先問過);
 *   (乙) 上游有給,而本站的轉換器沒有讀它(`fotmob-match.mjs` 的 `fotmobPlayer` 寫死 `photo: null`,
 *        而 `fetch-fotmob-epl.mjs` 存 raw 時也只留 name / shirt / performance 那幾個)。
 * 是 (乙) 的話,照片是**零額外請求** —— 每次部署本來就在打這支端點。
 *
 * 所以這一支**刻意不走本站的轉換器**(那正是要檢驗的東西),直接把上游回應攤開看:
 *   1. 一個先發球員物件的**鍵有哪些**(不印值,值裡有名字);
 *   2. 整份回應裡**看起來像圖片網址**的欄位(值是 http(s) 而且像圖檔,或鍵名含 image/photo/face)。
 *      —— 找的是「值長什麼樣」,不是猜鍵名:上一次找盃賽評分就是只看鍵名而漏掉
 *      (評分在某個 `key` 欄位的**值**裡),連兩次印出「0 人」。
 *   3. 是 (甲) 的話,順手試一次**推測的**球員圖網址(隊徽與聯賽 logo 都走這個形式),
 *      回報 HTTP 狀態與 content-type —— 只試 1 個人,不是 798 個。
 *
 * 硬上限:**3 個請求**(1 次 matchDetails + 最多 2 張圖)。不寫任何快取、不動任何產物。
 *
 *   npm run probe:ucl-photo
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://www.fotmob.com';
const UA = 'pl-war-room/1.0 (football analysis side project)';
const OUT = join(ROOT, 'data', 'raw', 'probes');

const get = async (url, headers = {}) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000),
    headers: { accept: 'application/json', 'user-agent': UA, ...headers } });
  return { status: res.status, ok: res.ok, type: res.headers.get('content-type'), text: await res.text() };
};

/* 倉庫裡挑一場歐冠已完賽的比賽 —— 不另外發請求去找一場。 */
function pickMatch() {
  const p = join(ROOT, 'data', 'raw', 'fotmob-ucl', '2026-27-game-details.json');
  if (!existsSync(p)) return null;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  for (const m of Object.values(d.matches ?? {})) if (m.matchId) return { key: m.key, matchId: m.matchId, date: m.date };
  return null;
}

/* 值長得像圖片網址的欄位。走訪整份回應,記下**路徑**與網址,不記名字之類的值。 */
function findImageFields(node, path = '$', out = [], seen = new Set()) {
  if (out.length >= 40 || node == null) return out;
  if (typeof node === 'string') {
    if (/^https?:\/\//.test(node) && /\.(png|jpe?g|webp|svg)(\?|$)/i.test(node)) {
      const key = path.replace(/\[\d+\]/g, '[]');
      if (!seen.has(key)) { seen.add(key); out.push({ path: key, sample: node.slice(0, 120) }); }
    }
    return out;
  }
  if (typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) findImageFields(v, `${path}.${k}`, out, seen);
  return out;
}

async function main() {
  const fx = pickMatch();
  if (!fx) { console.log('✗ 倉庫裡找不到歐冠逐場快取,無法挑一場來探(不另外發請求去找)'); return; }
  console.log(`▶ 歐冠球員照片探測:用 ${fx.key}(${fx.date},matchId ${fx.matchId})・硬上限 3 個請求`);

  const r = await get(`${BASE}/api/data/matchDetails?matchId=${fx.matchId}`, { referer: `${BASE}/` });
  console.log(`── matchDetails HTTP ${r.status}(${r.type})・${(r.text.length / 1024).toFixed(0)} KB`);
  if (!r.ok) { console.log('✗ 拿不到回應,後面兩題答不了'); return; }
  let raw; try { raw = JSON.parse(r.text); } catch { console.log('✗ 回傳不是 JSON'); return; }

  // 1. 一個先發球員物件的鍵(不印值)
  const side = raw?.content?.lineup?.homeTeam ?? raw?.content?.lineup?.awayTeam;
  const p0 = (side?.starters ?? [])[0];
  console.log(`── 先發球員物件的鍵(${(side?.starters ?? []).length} 人):`);
  console.log('   ' + (p0 ? Object.keys(p0).join(', ') : '(找不到 starters)'));
  if (p0?.performance) console.log('   performance 的鍵:' + Object.keys(p0.performance).join(', '));

  // 2. 整份回應裡像圖片網址的欄位
  const imgs = findImageFields(raw);
  console.log(`── 值看起來像圖片網址的欄位:${imgs.length} 種路徑`);
  for (const x of imgs.slice(0, 20)) console.log(`   ${x.path}  →  ${x.sample}`);
  const playerish = imgs.filter(x => /player|person|face|squad|lineup/i.test(x.path));
  console.log(`   其中路徑含 player/person/face/squad/lineup 的:${playerish.length} 種`
    + (playerish.length ? ` → ${playerish.map(x => x.path).join('、')}` : ''));

  /* 3. 回應裡沒有的話,試一次**推測的**球員圖網址。
        形式跟隊徽 / 聯賽 logo 同一套(那兩個都實測過),但球員這一支**沒有驗過** ——
        所以只試一個人,而且只報狀態與 content-type,不下載整張圖當結論。 */
  if (!playerish.length) {
    const pid = p0?.id ?? p0?.playerId ?? null;
    if (pid == null) console.log('── 推測網址那一題跳過:先發物件裡找不到球員 id');
    else {
      for (const u of [`https://images.fotmob.com/image_resources/playerimages/${pid}.png`,
                       `https://images.fotmob.com/image_resources/playerimages/${pid}_small.png`]) {
        try {
          const ir = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA } });
          const buf = ir.ok ? Buffer.from(await ir.arrayBuffer()) : null;
          console.log(`── 推測網址 ${u}\n   HTTP ${ir.status}(${ir.headers.get('content-type')})`
            + (buf ? `・${(buf.length / 1024).toFixed(1)} KB・PNG 魔數 ${buf[0] === 0x89 && buf[1] === 0x50 ? '是' : '不是'}` : ''));
          if (ir.ok) break;
        } catch (e) { console.log(`── 推測網址 ${u} → ${e.message}`); }
      }
    }
  } else {
    console.log('── 回應裡已經有球員圖網址,所以不試推測的那一支(省一個請求)');
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'ucl-player-photo.json'), JSON.stringify({
    probedAt: new Date().toISOString(), match: fx, status: r.status,
    starterKeys: p0 ? Object.keys(p0) : [], performanceKeys: p0?.performance ? Object.keys(p0.performance) : [],
    imageFields: imgs, playerImageFields: playerish,
  }, null, 2) + '\n');
  console.log('✔ 結論寫到 data/raw/probes/ucl-player-photo.json(不進版控,log 才是判讀的地方)');
}

main().catch(e => { console.error('探測失敗:', e.message); process.exitCode = 1; });
