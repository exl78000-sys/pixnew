#!/usr/bin/env node
/* 抓歐冠(UEFA Champions League)的逐場賽果。
 *
 * 來源:football-data.org v4。這個 token 授權 13 個賽事,**CL 在裡面** ——
 * 是 probe-encups 從 /v4/competitions 讀出來的授權清單,不是查文件猜的。
 * (SportMonks 那條路走不通:方案 5/5 滿,而且沒有歐冠。)
 *
 * 哪幾季拿得到,已經實測過(見 data/raw/probes/ucl.json):
 *
 *   season=2024  200・189 場・完賽 189・36 隊   ← 2024-25
 *   season=2025  200・189 場・完賽 189・36 隊   ← 2025-26
 *   season=2026  404 The resource you are looking for does not exist.
 *
 * **2026 的 404 是「還沒建立」,不是「拿不到」。** 2026-27 的聯賽階段
 * 九月中才開打,而 /competitions/CL 回報的 currentSeason 到現在仍是
 * 2025-09-16 ~ 2026-05-30。這兩件事要分開記,否則畫面會把「還沒開打」
 * 寫成「這個方案不給」—— 一個是等,一個是要換方案,結論完全相反。
 * 所以 404 記成 notPublished 並繼續,不讓整支失敗。
 *
 * 這一支**只抓不解讀**。延長賽與 PK 大戰怎麼表示,要看真的回傳長什麼樣;
 * 在沒看到實際資料之前寫轉換邏輯,等於猜。所以原始回傳整份落地,
 * 只在 log 印出 score 的欄位與 duration 的分佈,讓下一輪有依據。
 *
 * 抓取禮貌:免費方案限 10 requests/分鐘,所以單線、間隔 7 秒、
 * 一季一個請求(整季 189 場一次回完,實測過)。快取 12 小時。
 *
 *   npm run ucl            三季(缺的那季會照實記成 notPublished)
 *   npm run ucl -- --force 忽略快取重抓
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'football-data');
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const BASE = 'https://api.football-data.org/v4';
const FORCE = process.argv.includes('--force');
const GAP = 7000;            // 免費方案 10 req/分,留餘裕
const MAX_REQUESTS = 6;
const TTL_HOURS = 12;
const SCHEMA_VERSION = 1;

/* 本站一律用 "2024-25" 這種寫法;football-data.org 的 season 參數是起始年。
   已完賽的兩季不會再變,但仍照樣重抓 —— 供應商事後修正比分是常有的事,
   而且一季只花一個請求,省下來的沒有意義。 */
const SEASONS = [
  { label: '2026-27', season: '2026' },
  { label: '2025-26', season: '2025' },
  { label: '2024-25', season: '2024' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;

async function get(path) {
  if (requests >= MAX_REQUESTS) throw new Error(`已達本次 ${MAX_REQUESTS} 個請求上限`);
  if (requests) await sleep(GAP);
  requests++;
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(30000),
    headers: { 'X-Auth-Token': TOKEN, accept: 'application/json' },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 錯誤頁不一定是 JSON */ }
  return { status: res.status, body, message: body?.message ?? null };
}

const stale = store => {
  if (FORCE || !store?.retrievedAt) return true;
  if (store.schemaVersion !== SCHEMA_VERSION) return true;
  const age = Date.now() - Date.parse(store.retrievedAt);
  return !Number.isFinite(age) || age > TTL_HOURS * 3600000;
};

async function readStore(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

// 寫到暫存再改名:直接寫的話中途被砍會留下半個檔,下次讀進來是壞的 JSON
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, file);
}

/* log 是下一個人唯一看得到的東西,所以這裡印的不是「抓了幾場」,
   而是**寫轉換邏輯之前必須先知道的事**:score 有哪些欄位、
   duration 有哪幾種值、非 REGULAR 的那幾場實際長什麼樣。 */
function describe(matches) {
  const keys = new Set();
  const durations = new Map();
  const stages = new Map();
  for (const m of matches) {
    for (const k of Object.keys(m.score ?? {})) keys.add(k);
    const d = m.score?.duration ?? '(無)';
    durations.set(d, (durations.get(d) ?? 0) + 1);
    stages.set(m.stage, (stages.get(m.stage) ?? 0) + 1);
  }
  const odd = matches.filter(m => m.score?.duration && m.score.duration !== 'REGULAR');
  return {
    scoreKeys: [...keys],
    durations: Object.fromEntries(durations),
    stages: Object.fromEntries(stages),
    // 決賽與延長／PK 的那幾場整份印出來 —— 猜錯這裡不是少一個欄位,是把冠軍講錯
    samples: [...odd.slice(0, 3), ...matches.filter(m => m.stage === 'FINAL')].map(m => ({
      stage: m.stage, matchday: m.matchday, status: m.status,
      home: m.homeTeam?.shortName ?? m.homeTeam?.name,
      away: m.awayTeam?.shortName ?? m.awayTeam?.name,
      score: m.score,
    })),
  };
}

async function main() {
  if (!TOKEN) {
    console.log('⚠ 未設定 FOOTBALL_DATA_TOKEN,略過歐冠抓取。');
    return;
  }
  await mkdir(OUT, { recursive: true });

  for (const s of SEASONS) {
    const file = join(OUT, `ucl-${s.label}.json`);
    const prev = await readStore(file);
    if (!stale(prev)) {
      console.log(`  歐冠 ${s.label}:快取仍新鮮(${prev.retrievedAt}),略過。加 --force 可重抓`);
      continue;
    }

    let r;
    try {
      r = await get(`/competitions/CL/matches?season=${s.season}`);
    } catch (e) {
      console.log(`  ⚠ 歐冠 ${s.label}:${e.message}`);
      continue;
    }

    /* 三種結果的結論完全不同,不要混成一句「取得失敗」:
         403        方案不給這一季 → 要換方案才拿得到
         404        這一季還沒建立 → 會有,只是現在還沒有
         200 + 0 場 賽程還沒公布   → 同上
       畫面要照這個講實話,所以 availability 要存下來。 */
    const matches = Array.isArray(r.body?.matches) ? r.body.matches : [];
    const availability = r.status === 403 ? 'plan-restricted'
      : r.status === 404 ? 'not-published'
      : r.status === 200 && matches.length === 0 ? 'no-fixtures-yet'
      : r.status === 200 ? 'available'
      : `http-${r.status}`;

    if (availability !== 'available') {
      console.log(`  歐冠 ${s.label}:HTTP ${r.status}・${availability}${r.message ? `(${r.message})` : ''}`);
      // 拿不到也要落盤 —— 沒有這一步的話,build 看不到任何線索,
      // 只能在畫面上留一塊空白,而讀者會以為是壞掉
      await writeAtomic(file, {
        source: 'football-data.org', competition: 'CL',
        season: s.label, seasonParam: s.season,
        retrievedAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION,
        availability, status: r.status, message: r.message, matches: [],
      });
      continue;
    }

    const d = describe(matches);
    console.log(`  歐冠 ${s.label}:${matches.length} 場`
      + `(完賽 ${matches.filter(m => m.status === 'FINISHED').length})`
      + `・階段 ${Object.entries(d.stages).map(([k, v]) => `${k}×${v}`).join('、')}`);
    console.log(`    score 欄位:${d.scoreKeys.join('、')}`);
    console.log(`    duration:${JSON.stringify(d.durations)}`);
    for (const x of d.samples) console.log(`    樣本 ${x.stage} ${x.home} vs ${x.away} → ${JSON.stringify(x.score)}`);

    await writeAtomic(file, {
      source: 'football-data.org', competition: 'CL',
      season: s.label, seasonParam: s.season,
      retrievedAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION,
      availability, status: r.status, message: null,
      // 原始回傳整份留著。這一支不解讀 —— 轉換邏輯要等看過真實資料再寫
      matches,
    });
    console.log(`    ✔ 已寫入 ${file}`);
  }
  console.log(`歐冠抓取完成(用了 ${requests}/${MAX_REQUESTS} 個請求)`);
}

main().catch(e => { console.error('歐冠抓取失敗:', e.message); process.exitCode = 1; });
