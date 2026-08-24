// Adapter:API-Football (api-sports.io) → 官方陣型與教練
//
// 這一支是「怎麼接一個需要金鑰的 API」的範本。要接別家,複製這個檔改三個地方:
//   1. BASE / 端點路徑
//   2. 認證 header 的名稱
//   3. toCanonical() 裡的欄位對應
// 其他(金鑰處理、快取、節流、失敗隔離)都可以照抄。
//
// ⚠ 我沒有實測過:開發沙箱連不到外網。第一次真正執行會在你的電腦或 runner 上。
//    設計上失敗完全無害 —— 抓不到就回 null,上層自動退回既有的角色推導。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'api-football';
export const label = 'API-Football (api-sports.io)';
export const supports = ['formations', 'coaches'];

const BASE = 'https://v3.football.api-sports.io';
const LEAGUE_EPL = 39;          // API-Football 的英超 league id

/* ── 1. 金鑰 ──────────────────────────────────
   只從環境變數讀,而且只在建置階段(Node)用。產物是靜態 JSON,
   金鑰不會、也不可能出現在前端 bundle 裡。
   絕對不要寫死在檔案裡 —— 這個 repo 是公開的。 */
export const enabled = (env = process.env) => Boolean(env.API_FOOTBALL_KEY);

/* ── 2. 額度控制 ──────────────────────────────
   免費方案 100 次/天。目前排程每 15 分鐘一次 = 96 次/天,
   等於每次只剩 1 個請求的預算 —— 不夠。
   所以這裡自己記帳,超過就停,不要把額度燒光導致整天都拿不到資料。 */
const DAILY_BUDGET = Number(process.env.API_FOOTBALL_BUDGET ?? 80);   // 留 20 次緩衝

class Budget {
  constructor(root) { this.file = join(root, 'data', 'cache', 'api-football-budget.json'); this.used = 0; this.day = null; }
  async load() {
    try {
      const j = JSON.parse(await readFile(this.file, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      if (j.day === today) { this.used = j.used; this.day = j.day; }
      else { this.used = 0; this.day = today; }
    } catch { this.day = new Date().toISOString().slice(0, 10); }
    return this;
  }
  left() { return Math.max(0, DAILY_BUDGET - this.used); }
  async spend(n = 1) {
    this.used += n;
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify({ day: this.day, used: this.used }));
  }
}

/* ── 3. 快取 ──────────────────────────────────
   同一場比賽的官方陣容公布後就不會再變,沒必要每次 build 都重抓。
   這也是使用者當初訂的規則:所有人共用後端的快取,不是每個人各自去打 API。 */
const cachePath = (root, key) => join(root, 'data', 'cache', `af-${key}.json`);

async function cached(root, key, ttlMs, produce) {
  const f = cachePath(root, key);
  if (existsSync(f)) {
    try {
      const j = JSON.parse(await readFile(f, 'utf8'));
      if (Date.now() - new Date(j.at).getTime() < ttlMs) return { ...j, fromCache: true };
    } catch { /* 壞掉的快取直接當沒有 */ }
  }
  const data = await produce();
  if (data === null) return null;
  const rec = { at: new Date().toISOString(), data };
  await mkdir(join(f, '..'), { recursive: true });
  await writeFile(f, JSON.stringify(rec));
  return { ...rec, fromCache: false };
}

/* ── 4. 請求 ──────────────────────────────────
   逾時、重試、節流都在這裡。任何失敗都回 null,不丟例外 ——
   資料源掛掉不該讓整個 build 失敗。 */
async function call(path, { env = process.env, budget, fetchImpl = fetch, retries = 2 } = {}) {
  if (!enabled(env)) return null;
  if (budget && budget.left() <= 0) {
    console.warn(`  ⚠ API-Football 今日額度用完(${DAILY_BUDGET}),略過`);
    return null;
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetchImpl(`${BASE}${path}`, {
        headers: { 'x-apisports-key': env.API_FOOTBALL_KEY, accept: 'application/json' },
        signal: ctrl.signal,
      });
      await budget?.spend(1);
      if (res.status === 429) {                       // 被限流:等一下再試
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const j = await res.json();
      // API-Football 即使 HTTP 200 也可能在 errors 裡回錯誤
      if (j.errors && Object.keys(j.errors).length) {
        console.warn(`  ⚠ API-Football 回報錯誤:${JSON.stringify(j.errors).slice(0, 120)}`);
        return null;
      }
      return j.response ?? null;
    } catch {
      if (attempt === retries) return null;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
  return null;
}

/* ── 5. 對應到本站格式 ────────────────────────
   外部欄位一律在這裡轉成本站的形狀,上層永遠不碰供應商的 JSON。
   這就是 Canonical Schema 的意義:換供應商只要改這個函式。 */
const toCanonicalFormation = (row, codeOf) => ({
  team: codeOf(row.team?.name) ?? null,
  formation: row.formation ?? null,          // 例 "4-3-3" —— 這就是我們缺的官方陣型
  xi: (row.startXI ?? []).map(x => ({
    name: x.player?.name ?? '', number: x.player?.number ?? null,
    grid: x.player?.grid ?? null,            // "行:列",官方的實際站位格線
    pos: x.player?.pos ?? null,              // G/D/M/F
  })),
  coach: row.coach?.name ?? null,
  source: id,
});

/* 取某一輪所有比賽的官方陣容。回 null 代表這次拿不到(沒金鑰/額度用完/連不上)。 */
export async function loadFormations({ root, season, round, codeOf, env = process.env, fetchImpl = fetch }) {
  if (!enabled(env)) return null;
  const budget = await new Budget(root).load();

  // 先拿這一輪的 fixture id(官方陣容要用 fixture id 查)
  const fx = await cached(root, `fixtures-${season}-${round}`, 6 * 3600e3, () =>
    call(`/fixtures?league=${LEAGUE_EPL}&season=${season}&round=Regular%20Season%20-%20${round}`,
      { env, budget, fetchImpl }));
  if (!fx?.data?.length) return null;

  const out = {};
  for (const f of fx.data) {
    const fid = f.fixture?.id;
    if (!fid) continue;
    // 陣容公布後就不會再變,快取存 24 小時
    const lu = await cached(root, `lineup-${fid}`, 24 * 3600e3, () =>
      call(`/fixtures/lineups?fixture=${fid}`, { env, budget, fetchImpl }));
    if (!lu?.data?.length) continue;
    for (const side of lu.data) {
      const c = toCanonicalFormation(side, codeOf);
      if (c.team) out[c.team] = c;
    }
    await new Promise(r => setTimeout(r, 300));       // 對免費方案客氣一點
  }
  return { formations: out, budgetLeft: budget.left(), fetchedAt: new Date().toISOString() };
}
