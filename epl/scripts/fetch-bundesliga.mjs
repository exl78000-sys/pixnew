#!/usr/bin/env node
/* 德甲(Bundesliga)的兩個來源 → data/raw/
 *
 * 做法一行不改地照英冠那一支(`fetch-championship.mjs`)—— 加聯賽就是加一份參數,
 * 不是再發明一套抓法。兩個來源與它們各自的角色也一樣:
 *
 *   openfootball/football.json  de.1.json   賽程 + 賽果 + 半場比分 + 輪次(主來源)
 *   football-data.co.uk         D1.csv      賽果 + 逐場統計(射門/角球/牌)+ 賠率(獨立來源)
 *
 * 兩份的重疊場次逐場核對走 `lib/league-matches.mjs`(跟西甲、英冠同一份實作):
 * 有一場不符就整份不採用。
 *
 * ── 沙箱抓得到什麼、抓不到什麼(2026-09-15 實測,不是猜的)──
 * 開發沙箱的出口代理只放行 `raw.githubusercontent.com`,所以:
 *   openfootball          ✓ 沙箱抓得到
 *   football-data.co.uk   ✗ 沙箱 403(CONNECT policy denial),**要在 CI runner 上跑**
 * 這不是這支腳本的 bug,所以 D1 抓不到時**不要當成致命錯誤**:
 * 印出來、結束碼照常,讓沒有第二來源的那幾季由 build 照實標示(缺第二來源就不補比分、不做核對)。
 * 倉庫裡 2021-22 ~ 2024-25 的 D1 已經有了(`football-data-couk-extra/D1/`,教練任期那一輪抓的),
 * 這支只補本季與上季,並且**寫到德甲自己的目錄**,不跟那一份混在一起。
 *
 *   npm run de1:fetch
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OF_DIR = join(ROOT, 'data', 'raw', 'openfootball-bundesliga');
const FD_DIR = join(ROOT, 'data', 'raw', 'football-data-couk-bundesliga');
/* 教練任期那一輪抓的舊季(2021-22 ~ 2024-25)就在這裡,格式完全一樣 ——
   再抓一次只是浪費上游的頻寬,所以先看這裡有沒有。 */
const FD_LEGACY = join(ROOT, 'data', 'raw', 'football-data-couk-extra', 'D1');
const OF_BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const UA = { 'user-agent': 'war-room/1.0 (football analysis side project)' };

/* 本季與上季是必要的(少了就建不了站);再往前是走查回測要的訓練季。
   德甲 18 隊 × 34 輪 = 306 場。 */
const REQUIRED = ['2025-26', '2026-27'];
const OPTIONAL = ['2023-24', '2024-25'];
const SEASONS = [...OPTIONAL, ...REQUIRED];
const MIN_MATCHES = 280;          // 306 場排完;少於這個代表上游那一季還沒排完
const fdCode = s => s.slice(2, 4) + s.slice(-2);   // 2025-26 → 2526

async function get(url, label) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res;
}

/* D1 的欄位檢查:這份的價值在逐場統計與賠率,少了射門那幾欄它就只是第二份賽果,
   而我們有更好的第一份(openfootball)。 */
const NEED = ['Div', 'Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'HS', 'AS', 'HST', 'AST', 'HC', 'AC'];
function checkCsv(text) {
  const rows = text.trim().split(/\r?\n/);
  const head = rows[0].split(',');
  const lack = NEED.filter(k => !head.includes(k));
  if (lack.length) throw new Error(`缺欄位 ${lack.join('、')}`);
  return rows.length - 1;
}

async function main() {
  await mkdir(OF_DIR, { recursive: true });
  await mkdir(FD_DIR, { recursive: true });
  const missing = [];
  const summary = [];
  let fdBlocked = 0;

  for (const season of SEASONS) {
    const optional = OPTIONAL.includes(season);
    let ofN = null, fdN = null, fdFrom = '';

    // ── openfootball(主來源)──
    try {
      const json = await (await get(`${OF_BASE}/${season}/de.1.json`, season)).json();
      const n = json.matches?.length ?? 0;
      if (n < MIN_MATCHES) throw new Error(`只有 ${n} 場,賽程還沒排完`);
      await writeFile(join(OF_DIR, `${season}.json`), JSON.stringify(json));
      ofN = n;
    } catch (e) {
      if (!optional) throw new Error(`德甲 ${season} openfootball 抓取失敗:${e.message}`);
      missing.push(`openfootball ${season}(${e.message})`);
    }

    // ── football-data.co.uk(獨立來源)——先看倉庫裡有沒有,再去抓 ──
    const legacy = join(FD_LEGACY, `${season}.csv`);
    if (existsSync(legacy)) {
      try {
        const text = await readFile(legacy, 'utf8');
        fdN = checkCsv(text);
        await writeFile(join(FD_DIR, `${season}.csv`), text);
        fdFrom = '(倉庫既有)';
      } catch (e) { missing.push(`football-data.co.uk ${season} 既有檔不合用(${e.message})`); }
    }
    if (fdN == null) {
      try {
        const text = await (await get(`https://www.football-data.co.uk/mmz4281/${fdCode(season)}/D1.csv`, season)).text();
        fdN = checkCsv(text);
        await writeFile(join(FD_DIR, `${season}.csv`), text);
      } catch (e) {
        /* **沙箱抓不到不是致命錯誤**(見檔頭):結束碼照常,由 build 照實標示沒有第二來源。
           在 runner 上跑時這裡會成功 —— 兩邊跑同一支腳本,差別只有出口。 */
        if (/403|CONNECT|fetch failed|ENOTFOUND|timeout/i.test(e.message)) fdBlocked++;
        missing.push(`football-data.co.uk ${season}(${e.message})`);
      }
    }

    if (ofN != null || fdN != null) {
      const gap = ofN != null && fdN != null ? `,兩邊差 ${Math.abs(ofN - fdN)} 場` : '';
      summary.push(`${season}:openfootball ${ofN ?? '—'} / D1 ${fdN ?? '—'}${fdFrom}${gap}`);
    }
  }

  for (const s of summary) console.log(`✓ 德甲 ${s}`);
  if (missing.length) {
    console.log(`  ⚠ 拿不到的(不補也不猜):${missing.join('、')}`);
    if (fdBlocked) {
      console.log(`     其中 ${fdBlocked} 季是 football-data.co.uk 連不上 —— 開發沙箱的出口代理不放行那個網域(實測 403),`);
      console.log(`     在 CI runner 上跑同一支腳本會成功。沒有第二來源的季,build 不做逐場核對也不補比分,畫面照實講。`);
    }
  }
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exit(1); });
