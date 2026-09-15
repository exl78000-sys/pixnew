/* Understat 的整季球員數據 —— 西甲與德甲**共用這一支**。
 *
 * 抽出來的理由跟 `lib/league-matches.mjs`、`lib/backtest-runner.mjs` 同一條
 * (CLAUDE.md:跨聯賽的轉換與流程一律共用,不複製)。這裡特別要緊,因為這支的
 * 每一段程式都是**踩過坑之後長出來的**,複製一份過去等於把那些坑的修補留在原地:
 *   - 端點在參數不對時回 **200 + `{"error":{...}}`**,只看 `res.ok` 會把失敗當成功
 *   - 回的也可能是**空陣列**(英冠那次四種寫法全回 `{"success":true,"players":[]}`)——
 *     「沒拋錯」不等於「拿到了」
 *   - 隊名對不上要**印出來**,靜靜吞掉的話那一隊整季消失而畫面完全正常
 *   - 本季會一直長,所以「檔案在就跳過」只能套用在**已完結的賽季**上
 *
 * 端點形狀(實測,不是憑印象):
 *   POST https://understat.com/main/getPlayersStats/
 *   body: league=<代號>&season=<開季年份>
 * **一個請求回整個聯賽一季的所有球員**。不是逐隊、更不是逐場 ——
 * 使用者要求過不要大量抓取,這個形狀正好符合。
 *
 * **界線**:Understat 是 xG 統計站。沒有背號、沒有頭貼、沒有傷停、沒有出生日期,
 * 也沒有英超那套 FPL 的防守貢獻 / BPS 欄位。用它的聯賽就是沒有這些 ——
 * 前端要據實標示,不要為了跟英超版面對齊而留空欄位或補估計值。
 *
 * **聯賽代號不要憑印象填。** 西甲是 `La_liga`(底線、小寫 l),別的聯賽是什麼寫法
 * 要用 `probe-understat-*.mjs` 在 runner 上實測過再寫進呼叫端。
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTeams } from './teams.mjs';

const URL_ = 'https://understat.com/main/getPlayersStats/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 西甲那一份實際回的欄位。新接一個聯賽時拿它比對 —— 少了哪個要講出來,
   因為下游(build 的累加、球員頁的欄位)是照這一組寫的。 */
export const UNDERSTAT_FIELDS = ['id', 'player_name', 'games', 'time', 'goals', 'xG',
  'assists', 'xA', 'shots', 'key_passes', 'yellow_cards', 'red_cards', 'position',
  'team_title', 'npg', 'npxG', 'xGChain', 'xGBuildup'];

export async function fetchUnderstatSeason(league, season, { retries = 3 } = {}) {
  const body = new URLSearchParams({ league, season: String(season) }).toString();
  let last;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(URL_, {
        method: 'POST', body,
        signal: AbortSignal.timeout(30000),
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          referer: `https://understat.com/league/${league}/${season}`,
          'user-agent': 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)',
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      // 200 + error 物件是這個端點的失敗方式,不是 HTTP 錯誤碼
      if (j?.error) throw new Error(`端點回報 error_code ${j.error.error_code}`);
      const rows = Array.isArray(j) ? j : (j.players ?? j.response?.players ?? null);
      if (!Array.isArray(rows)) throw new Error(`回傳不是球員陣列(頂層鍵:${Object.keys(j ?? {}).join(',') || '無'})`);
      return rows;
    } catch (e) {
      last = e;
      if (attempt < retries) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw last;
}

/* 一個聯賽的整季球員抓取。呼叫端只給參數,流程與所有守門都在這裡。
 *
 * seasons:  [{ label: '2025-26', provider: 2025 }, …],**最後一個視為本季**
 *           (本季會一直長,所以只有它在有檔案時仍然重抓) */
export async function fetchUnderstatPlayers({
  root, league, label, teamFile, dir, seasons, force = false, delay = 1500, note,
}) {
  const T = loadTeams(root, { file: teamFile });
  const outDir = join(root, 'data', 'raw', dir);
  await mkdir(outDir, { recursive: true });
  const file = s => join(outDir, `${s}-players.json`);

  let requests = 0;
  const summary = [];
  for (const { label: season, provider } of seasons) {
    const isCurrent = season === seasons.at(-1).label;
    if (!force && existsSync(file(season)) && !isCurrent) {
      const prev = JSON.parse(await readFile(file(season), 'utf8'));
      console.log(`  · ${season} 已有 ${prev.players?.length ?? 0} 筆,跳過(加 --force 重抓)`);
      continue;
    }
    if (requests) await sleep(delay);
    requests++;
    console.log(`▶ ${label} ${season}(Understat league=${league}&season=${provider})`);
    let rows;
    try {
      rows = await fetchUnderstatSeason(league, provider);
    } catch (e) {
      // 本季開季初可能還沒有資料,那不是錯誤;已完結的賽季抓不到才是問題
      console.log(`  ⚠ 抓不到:${e.message}`);
      continue;
    }
    /* **空陣列不是成功。** 端點對「認得但沒有資料」的聯賽就是回空的
       (英冠那次四種寫法全這樣),寫一份空檔進倉庫會讓下游以為這個聯賽有球員層。 */
    if (!rows.length) {
      console.log('  ⚠ 回了空陣列 —— 端點認得這個代號,但沒有資料。不寫檔。');
      continue;
    }

    /* 隊名要對得上我們的隊碼,對不上的**列出來**不要靜靜吞掉 ——
       CLAUDE.md 記著的坑:被 tolerant 模式吞掉之後整季資料消失,而畫面上看不出來。 */
    const unmatched = new Map();
    const players = rows.map(r => {
      const code = T.codeOf(r.team_title);
      if (!code) unmatched.set(r.team_title, (unmatched.get(r.team_title) ?? 0) + 1);
      return { ...r, code: code ?? null };
    });
    const matched = players.filter(p => p.code).length;
    console.log(`  ${players.length} 名球員・隊名對上 ${matched} 筆`);
    if (unmatched.size) {
      console.log(`  ⚠ 對不上隊名(要補進 data/manual/${teamFile} 的 alias):`);
      for (const [name, n] of [...unmatched].sort((a, b) => b[1] - a[1])) console.log(`      ${name}(${n} 人)`);
    }
    /* 欄位跟西甲那一組比一次。少了什麼就印出來 —— 下游是照那一組寫的,
       靜靜少一欄會變成畫面上一個永遠空白的格子(鐵則三)。 */
    const lack = UNDERSTAT_FIELDS.filter(k => !(k in (rows[0] ?? {})));
    if (lack.length) console.log(`  ⚠ 上游少了這幾個欄位:${lack.join('、')} —— 下游要跟著改,不要留空欄位`);

    await writeFile(file(season), JSON.stringify({
      season, providerSeason: provider,
      source: 'Understat',
      sourceUrl: URL_,
      note: note ?? `POST league=${league}&season=YYYY，整季一個請求。無背號、無頭貼、無傷停、無出生日期。`,
      retrievedAt: new Date().toISOString(),
      count: players.length, matched,
      unmatchedTeams: Object.fromEntries(unmatched),
      players,
    }, null, 2) + '\n');
    console.log(`  ✔ ${file(season)}`);
    summary.push({ season, count: players.length, matched });
  }
  console.log(`\n共用掉 ${requests} 個請求。`);
  return { requests, seasons: summary };
}
