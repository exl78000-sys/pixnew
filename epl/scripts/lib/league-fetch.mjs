/* 「兩個獨立來源」的聯賽抓取器 —— 英冠、德甲、義甲、法甲**共用這一份**。
 *
 *   openfootball/football.json  {代碼}.json   賽程 + 賽果 + 半場比分 + 輪次(主來源)
 *   football-data.co.uk         {代碼}.csv    賽果 + 逐場統計(射門/角球/牌)+ 賠率(獨立來源)
 *
 * 兩份的重疊場次逐場核對走 `lib/league-matches.mjs`(跟西甲同一份實作):
 * 有一場不符就整份不採用。那一層在 build,不在這裡 —— 這一支只負責把兩份原樣落地。
 *
 * ── 為什麼抽出來 ──
 * 英冠與德甲各有一份幾乎一樣的抓取器(德甲那份是照英冠改的),再加義甲法甲就是**四份複本**。
 * CLAUDE.md 的規矩:「複製一份轉換過去的話,改了一邊另一邊會悄悄過期」——
 * 而這裡已經有一個現成的例子:德甲那份後來加了「先看倉庫裡有沒有舊季」與
 * 「football-data.co.uk 連不上不算致命」,英冠那份沒有跟上。
 *
 * 四個聯賽的差異全部參數化,沒有一個是寫死的:
 *   ofCode        openfootball 的檔名(en.2 / de.1 / it.1 / fr.1)
 *   fdDiv         football-data.co.uk 的分區代碼(E1 / D1 / I1 / F1)
 *   minMatches    一季排完應該有幾場(英冠 552、德甲 306、義甲 380、法甲 306)——
 *                 **這個數字是聯賽的事實,不可以照抄**:少於它代表上游那一季還沒排完,
 *                 收下一份殘缺的賽程會讓積分榜少算比賽
 *   fdRequired    必要季拿不到第二來源時要不要中止。英冠是 true(它沒有別的核對來源),
 *                 德甲之後是 false —— 沙箱抓不到那個網域,擋下來只會讓本機永遠跑不完,
 *                 而缺第二來源這件事 build 會照實標示
 *   legacyDir     倉庫裡已經有的舊季 CSV(教練任期那一輪抓的),有就不要再去抓一次
 *
 * ── 沙箱抓得到什麼、抓不到什麼(2026-09-15 實測,不是猜的)──
 *   openfootball          ✓ raw.githubusercontent.com,沙箱放行
 *   football-data.co.uk   ✗ 沙箱 403(CONNECT policy denial),**要在 CI runner 上跑**
 * 這不是腳本的 bug,所以 `fdRequired: false` 時抓不到只印出來、結束碼照常。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const OF_BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const UA = { 'user-agent': 'war-room/1.0 (football analysis side project)' };
// football-data.co.uk 的季代碼:2025-26 → 2526
const fdSeasonCode = s => s.slice(2, 4) + s.slice(-2);

async function get(url, label) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return res;
}

/* CSV 的欄位檢查:這份的價值在**逐場統計與賠率**,少了射門那幾欄它就只是第二份賽果,
   而我們已經有更好的第一份(openfootball)。所以欄位不齊就不收。 */
const NEED = ['Div', 'Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG', 'HS', 'AS', 'HST', 'AST', 'HC', 'AC'];
function checkCsv(text) {
  const rows = text.trim().split(/\r?\n/);
  const head = rows[0].split(',');
  const lack = NEED.filter(k => !head.includes(k));
  if (lack.length) throw new Error(`缺欄位 ${lack.join('、')}`);
  return rows.length - 1;
}

export async function fetchLeagueSources({
  root, zh, ofCode, fdDiv, ofDir, fdDir,
  required, optional, minMatches,
  fdRequired = false, legacyDir = null,
}) {
  const OF_DIR = join(root, 'data', 'raw', ofDir);
  const FD_DIR = join(root, 'data', 'raw', fdDir);
  const LEGACY = legacyDir ? join(root, 'data', 'raw', 'football-data-couk-extra', legacyDir) : null;
  await mkdir(OF_DIR, { recursive: true });
  await mkdir(FD_DIR, { recursive: true });

  const missing = [];
  const summary = [];
  let fdBlocked = 0;

  for (const season of [...optional, ...required]) {
    const isOptional = optional.includes(season);
    let ofN = null, fdN = null, fdFrom = '';

    // ── openfootball(主來源)──
    try {
      const json = await (await get(`${OF_BASE}/${season}/${ofCode}.json`, season)).json();
      const n = json.matches?.length ?? 0;
      if (n < minMatches) throw new Error(`只有 ${n} 場,賽程還沒排完`);
      await writeFile(join(OF_DIR, `${season}.json`), JSON.stringify(json));
      ofN = n;
    } catch (e) {
      if (!isOptional) throw new Error(`${zh} ${season} openfootball 抓取失敗:${e.message}`);
      missing.push(`openfootball ${season}(${e.message})`);
    }

    // ── football-data.co.uk(獨立來源)——先看倉庫裡有沒有,再去抓 ──
    if (LEGACY && existsSync(join(LEGACY, `${season}.csv`))) {
      try {
        const text = await readFile(join(LEGACY, `${season}.csv`), 'utf8');
        fdN = checkCsv(text);
        await writeFile(join(FD_DIR, `${season}.csv`), text);
        fdFrom = '(倉庫既有)';
      } catch (e) { missing.push(`football-data.co.uk ${season} 既有檔不合用(${e.message})`); }
    }
    if (fdN == null) {
      try {
        const text = await (await get(`https://www.football-data.co.uk/mmz4281/${fdSeasonCode(season)}/${fdDiv}.csv`, season)).text();
        fdN = checkCsv(text);
        await writeFile(join(FD_DIR, `${season}.csv`), text);
      } catch (e) {
        if (fdRequired && !isOptional) throw new Error(`${zh} ${season} football-data.co.uk 抓取失敗:${e.message}`);
        if (/403|CONNECT|fetch failed|ENOTFOUND|timeout/i.test(e.message)) fdBlocked++;
        missing.push(`football-data.co.uk ${season}(${e.message})`);
      }
    }

    if (ofN != null || fdN != null) {
      const gap = ofN != null && fdN != null ? `,兩邊差 ${Math.abs(ofN - fdN)} 場` : '';
      summary.push(`${season}:openfootball ${ofN ?? '—'} / ${fdDiv} ${fdN ?? '—'}${fdFrom}${gap}`);
    }
  }

  for (const s of summary) console.log(`✓ ${zh} ${s}`);
  if (missing.length) {
    console.log(`  ⚠ 拿不到的(不補也不猜):${missing.join('、')}`);
    if (fdBlocked) {
      console.log(`     其中 ${fdBlocked} 季是 football-data.co.uk 連不上 —— 開發沙箱的出口代理不放行那個網域(實測 403),`);
      console.log(`     在 CI runner 上跑同一支腳本會成功。沒有第二來源的季,build 不做逐場核對也不補比分,畫面照實講。`);
    }
  }
  return { summary, missing, fdBlocked };
}
