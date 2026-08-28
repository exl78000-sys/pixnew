#!/usr/bin/env node
/* 英冠(EFL Championship)的賽果、賽程與逐場統計。
 *
 * 兩個來源,都是靜態檔、免費、不需要 API 額度,而且**彼此獨立** ——
 * 這一點是刻意的:鐵則五要求外部資料要有獨立來源核對,
 * 英冠沒有 FPL、沒有 Understat,能拿來互相驗的就只有這兩份。
 *
 *   openfootball/football.json  en.2.json   賽程 + 賽果 + 半場比分 + 輪次
 *   football-data.co.uk         E1.csv      賽果 + 射門/射正/角球/犯規/牌 + 賠率
 *
 * ── 2026-08-28 實測(四季)──
 *   openfootball  2023-24 / 2024-25 / 2025-26 各 557(552 聯賽 + 5 場升級附加賽)
 *                 2026-27 552(附加賽還沒排)
 *   E1.csv        2023-24 / 2024-25 / 2025-26 各 552,2026-27 24 場
 *
 * 兩邊固定差 5 場,那 5 場是**升級附加賽**(準決賽 4 + 決賽 1),E1 只收聯賽。
 * 不是缺漏,不要當成缺漏去補。
 *
 * **踩過一次:openfootball 的比分有兩種寫法。**
 * 多數是 `{"ft":[2,1],"ht":[1,0]}`,但 0:0 收場的那些寫成 `{"score":[0,0]}`。
 * 只認 `score.ft` 的話,2025-26 會數成「552 場只有 518 場有比分」,
 * 於是以為上游缺了 34 場。adapter 本來就處理得對(兩種格式都讀),
 * 而那 34 場拿 E1 逐場核對過 —— **全部真的是 0:0**。
 * 教訓:「數不出來」跟「上游沒有」是兩件事,先確認自己讀的是不是對的欄位。
 *
 * 賠率的未來場次不在這裡抓:football-data.co.uk 的 fixtures.csv 是**全歐洲一份**,
 * `npm run odds` 早就下載了,英冠(Div=E1)本來就在裡面 —— 重抓一次是白費請求。
 *
 *   npm run en2:fetch
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OF_DIR = join(ROOT, 'data', 'raw', 'openfootball-championship');
const FD_DIR = join(ROOT, 'data', 'raw', 'football-data-couk-championship');
const OF_BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const UA = { 'user-agent': 'war-room/1.0 (football analysis side project)' };

/* 本季與上季是必要的(少了就建不了站)。
   再往前兩季是選配:走查回測要「用前面的季訓練、在後面的季驗收」,
   拿不到就是回測跑不起來 —— 那要照實擋下,不是硬跑出一個數字。 */
const REQUIRED = ['2025-26', '2026-27'];
const OPTIONAL = ['2023-24', '2024-25'];
const SEASONS = [...OPTIONAL, ...REQUIRED];
// football-data.co.uk 的季代碼:2025-26 → 2526
const fdCode = s => s.slice(2, 4) + s.slice(-2);

async function get(url, label) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res;
}

async function main() {
  await mkdir(OF_DIR, { recursive: true });
  await mkdir(FD_DIR, { recursive: true });
  const missing = [];
  const summary = [];

  for (const season of SEASONS) {
    const optional = OPTIONAL.includes(season);
    let ofN = null, fdN = null;

    // ── openfootball ──
    try {
      const json = await (await get(`${OF_BASE}/${season}/en.2.json`, season)).json();
      const n = json.matches?.length ?? 0;
      /* 英冠是 24 隊 × 46 輪 = 552 場。少於 500 代表上游那一季還沒排完,
         當成「沒有」而不是收下一份殘缺的賽程 —— 殘缺的賽程會讓積分榜少算比賽。 */
      if (n < 500) throw new Error(`只有 ${n} 場,賽程還沒排完`);
      await writeFile(join(OF_DIR, `${season}.json`), JSON.stringify(json));
      ofN = n;
    } catch (e) {
      if (!optional) throw new Error(`英冠 ${season} openfootball 抓取失敗:${e.message}`);
      missing.push(`openfootball ${season}(${e.message})`);
    }

    // ── football-data.co.uk ──
    try {
      const text = await (await get(`https://www.football-data.co.uk/mmz4281/${fdCode(season)}/E1.csv`, season)).text();
      const rows = text.trim().split(/\r?\n/);
      const head = rows[0].split(',');
      /* 欄位不齊就不要收 —— 這份的價值在於逐場統計與賠率,
         少了射門那幾欄它就只是第二份賽果,而我們有更好的第一份。 */
      const need = ['Div', 'Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'HS', 'AS', 'HST', 'AST', 'HC', 'AC'];
      const lack = need.filter(k => !head.includes(k));
      if (lack.length) throw new Error(`缺欄位 ${lack.join('、')}`);
      await writeFile(join(FD_DIR, `${season}.csv`), text);
      fdN = rows.length - 1;
    } catch (e) {
      if (!optional) throw new Error(`英冠 ${season} football-data.co.uk 抓取失敗:${e.message}`);
      missing.push(`football-data.co.uk ${season}(${e.message})`);
    }

    if (ofN != null || fdN != null) {
      const gap = ofN != null && fdN != null ? `,兩邊差 ${Math.abs(ofN - fdN)} 場` : '';
      summary.push(`${season}:openfootball ${ofN ?? '—'} / E1 ${fdN ?? '—'}${gap}`);
    }
  }

  for (const s of summary) console.log(`✓ 英冠 ${s}`);
  if (missing.length) {
    console.log(`  ⚠ 選配的季拿不到(不補也不猜):${missing.join('、')}`);
    console.log(`     少了它們,依賴那幾季的走查回測會照實擋下來,不會硬跑出假結果。`);
  }
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exit(1); });
