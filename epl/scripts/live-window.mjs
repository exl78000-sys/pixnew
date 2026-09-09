#!/usr/bin/env node
// 現在該不該進入「比賽日模式」?回傳 JSON 給 workflow 判斷。
//
//   node scripts/live-window.mjs                    → 印出 JSON(英超)
//   node scripts/live-window.mjs --league=es1        → 西甲
//   node scripts/live-window.mjs --github            → 同時寫進 $GITHUB_OUTPUT
//
// 為什麼需要這支:GitHub 的 cron 是 best-effort,實測今天 23 次排程的間隔是
// 28~78 分鐘(設定 15 分鐘),平均 46 分鐘 —— 比賽中靠 cron 更新根本來不及。
//
// 解法是換一個機制:cron 只負責「開場」,真正的高頻更新放在 job 內部的迴圈裡。
// GitHub 單一 job 最長可以跑 6 小時,而迴圈裡的 sleep 完全不受排程延遲影響。
// 所以這支的工作是回答:
//   1. 現在有沒有比賽進行中?          → 立刻開始輪詢
//   2. 下一場多久後開賽?              → 還早就不進場;快到了就先睡到開賽前再輪詢
//   3. 都沒有?                        → 直接結束,不浪費(使用者要的「沒比賽就不用頻繁」)
import { readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 開賽前多久就該進場等著 —— 官方名單約賽前一小時公布,提早進場才抓得到
const LEAD_MIN = 75;
// 開賽後多久算「一定踢完了」(90 + 中場 + 傷停 + 緩衝)
const TAIL_MIN = 140;
// 比這個還久才開賽就先不進場,交給下一次 cron
const MAX_WAIT_MIN = 180;
/* 即時資料要多新才能拿來判斷「現在有沒有比賽在踢」。

   **這是 2026-08-29 修的一個會讓整個功能失效的 bug。** 原本只要
   data/raw/live.json 讀得到就信它,而那個檔是**上一次抓的快照** ——
   進場前根本還沒抓,它可能是好幾小時前的。實測:Crystal Palace vs Man City
   開賽 10 分鐘,而 live.json 是 199 分鐘前的第 1 輪(全部 finished),
   於是 liveNow=0、fromFeed=true,依開賽時間判斷那條被整個跳過,
   回報「不進場,下一場還有 979 分鐘」—— **手動觸發也進不去**。

   迴圈裡信 feed 是對的(那裡剛抓完,而且它有 started/finished 兩個明確旗標,
   比 fixtures.json 的 played 快一拍)。差別只在「新不新」,所以用時間分。
   輪詢間隔是 2 分鐘,10 分鐘的門檻夠寬鬆;抓取連續失敗超過這個時間,
   就退回用開賽時間推 —— 那會讓迴圈撐到 TAIL_MIN,比中途退場好。 */
const FEED_FRESH_MIN = 10;

/* 一場比賽的「現在該盯著它」時間窗。抽出來是因為盃賽的抓取器也要問同一個問題 ——
   兩邊各寫一份的話,改了一邊另一邊會悄悄用舊門檻(CLAUDE.md 那條坑)。 */
export const inMatchWindow = (now, kickoffIso) => {
  const ko = Date.parse(kickoffIso ?? '');
  if (!Number.isFinite(ko)) return false;
  return now >= ko - LEAD_MIN * 60000 && now <= ko + TAIL_MIN * 60000;
};

/* 純判斷,不碰檔案 —— 測試看不到 DOM 也讀不到 workflow,
   這一段的邏輯要能被 npm test 直接餵資料驗。 */
export function decideWindow({ now, fixtures, live = null }) {
  const upcoming = [];
  let liveNow = 0;
  let fromFeed = false;

  /* 「現在有沒有比賽在踢」優先看即時資料 —— 它有 started/finished 兩個明確的旗標。
     fixtures.json 的 played 要等 build 跑完才會變,在輪詢迴圈裡用它會慢一拍。
     但**只有在這份資料夠新的時候才算數**(見 FEED_FRESH_MIN 的說明)。 */
  if (live && !live.demo && Array.isArray(live.fixtures)) {
    const age = (now - Date.parse(live.fetchedAt ?? '')) / 60000;
    if (Number.isFinite(age) && age >= 0 && age <= FEED_FRESH_MIN) {
      liveNow = live.fixtures.filter(f => f.started && !f.finished).length;
      fromFeed = true;
    }
  }

  for (const f of fixtures) {
    if (!f.kickoff) continue;
    const ko = Date.parse(f.kickoff);
    if (!Number.isFinite(ko)) continue;
    const minsSince = (now - ko) / 60000;
    // 沒有夠新的即時資料時,只能用開賽時間推;已完賽的不算,補賽改期才不會空轉
    if (!fromFeed && minsSince >= 0 && minsSince <= TAIL_MIN && !f.played) liveNow++;
    else if (minsSince < 0) upcoming.push({ ko, key: `${f.home}|${f.away}`, mins: -minsSince });
  }

  if (liveNow > 0) {
    return {
      active: true, reason: `${liveNow} 場進行中${fromFeed ? '(即時資料源)' : '(依開賽時間推算)'}`,
      liveCount: liveNow, sleepSec: 0,
    };
  }

  upcoming.sort((a, b) => a.ko - b.ko);
  const next = upcoming[0];
  if (!next) return { active: false, reason: '沒有未來的比賽', sleepSec: 0 };

  if (next.mins > MAX_WAIT_MIN) {
    return {
      active: false,
      reason: `下一場還有 ${Math.round(next.mins)} 分鐘(${next.key})`,
      nextKickoff: new Date(next.ko).toISOString(), sleepSec: 0,
    };
  }
  // 快開賽了:先睡到「開賽前 LEAD_MIN 分」再開始輪詢,不要空轉燒時間
  const sleepSec = Math.max(0, Math.round((next.mins - LEAD_MIN) * 60));
  return {
    active: true,
    reason: `下一場 ${Math.round(next.mins)} 分鐘後開賽(${next.key})`,
    nextKickoff: new Date(next.ko).toISOString(),
    liveCount: 0, sleepSec,
  };
}

/* 各聯賽的檔案位置。走註冊表,不要用「是不是某一個」的二元判斷 ——
   那種寫法在只有兩個聯賽時看起來完全正確(CLAUDE.md 那條坑已經出現四次)。
   英冠沒有即時來源,所以不在這裡;真的加了再補一筆。 */
const LEAGUES = {
  pl: { fixtures: ['web', 'data', 'fixtures.json'], live: ['data', 'raw', 'live.json'] },
  es1: {
    fixtures: ['web', 'data', 'leagues', 'es1', 'fixtures.json'],
    live: ['data', 'raw', 'sportmonks-la-liga', 'live.json'],
  },
  /* 英冠(2026-09-04):比分來源是 FotMob 賽程端點,沒有 FPL 形狀的 live.json,進場與否純用開賽時間推 */
  en2: { fixtures: ['web', 'data', 'leagues', 'en2', 'fixtures.json'], live: null },
};

/* 英格蘭盃賽的場次也算「有比賽在踢」(2026-09-08)。

   聯賽盃之夜 16 場、8 支英超球隊,而那些場次**不在英超賽程裡** —— 進場判斷只看 fixtures.json 的話,
   比賽日工作流根本不會進場,盃賽比分要等 12 小時一次的部署才會動。

   **讀的是 raw 不是產物。** `web/data/cups.json` 只在部署時重建、不進版控,倉庫裡那份還停在
   換來源之前(SportMonks 時代的欄位);而比賽日工作流在 checkout 之後、build 之前就要問這個問題,
   拿到的就是那份舊的。`data/raw/fotmob-cups/` 兩條工作流都會回寫,永遠是最新的。

   只收**本站認得的球隊**(有隊碼)的場次:足總盃夏天從第九級打起,一輪好幾百場,
   全收的話整個夏天每天都會進場,違背使用者「沒比賽就不用頻繁」那條。 */
export function cupFixtures(root = ROOT) {
  const dir = join(root, 'data', 'raw', 'fotmob-cups');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const season of raw.seasons ?? []) {
      if (!season.current) continue;
      for (const m of season.matches ?? []) {
        if (!m.kickoff || !(m.home?.code || m.away?.code)) continue;
        out.push({ kickoff: m.kickoff, played: m.played === true,
          // reason 會印 home|away,沒給就變成「undefined|undefined」,log 看不出是哪一場
          home: m.home?.code ?? m.home?.shortName ?? m.home?.name ?? '?',
          away: m.away?.code ?? m.away?.shortName ?? m.away?.name ?? '?' });
      }
    }
  }
  return out;
}

/* 歐冠的場次也算「有比賽在踢」(2026-09-09)。

   跟盃賽同一個理由,而且更明顯:歐冠場次不在任何一個聯賽的 fixtures.json 裡,
   而 `npm run ucl` 原本只掛在 12 小時一次的部署上 —— 2026-09-08 那六場 21:00 踢完,
   raw 最後抓的時間是 16:11(六場都還是 SCHEDULED),下一次抓是隔天 04:09,
   於是盃賽頁的**預設分頁**整整七小時印「已開賽・等待資料」。那晚迴圈其實有進場,
   但它進場是因為聯賽盃 —— 只是進去之後沒有人去抓歐冠。

   讀 raw 的理由跟 cupFixtures 一樣:產物要等 build,而這個判斷跑在 build 之前。
   三季全收沒有壞處 —— 過去賽季的場次 minsSince 早就超過 TAIL_MIN,decideWindow
   兩邊都不會收(既不算進行中,也不進 upcoming),所以不必在這裡寫死「哪一季是本季」。 */
export function uclFixtures(root = ROOT) {
  const dir = join(root, 'data', 'raw', 'football-data');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter(x => x.startsWith('ucl-') && x.endsWith('.json'))) {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (raw.availability !== 'available') continue;
    for (const m of raw.matches ?? []) {
      if (!m.utcDate) continue;
      out.push({ kickoff: m.utcDate, played: m.status === 'FINISHED',
        home: m.homeTeam?.shortName ?? m.homeTeam?.name ?? '?',
        away: m.awayTeam?.shortName ?? m.awayTeam?.name ?? '?' });
    }
  }
  return out;
}

export function liveWindow(now = Date.now(), league = 'pl') {
  const cfg = LEAGUES[league];
  if (!cfg) return { active: false, reason: `不認得的聯賽:${league}`, sleepSec: 0 };
  const fx = join(ROOT, ...cfg.fixtures);
  if (!existsSync(fx)) return { active: false, reason: '找不到賽程資料', sleepSec: 0 };
  const fixtures = JSON.parse(readFileSync(fx, 'utf8'));

  let live = null;
  const rawLive = cfg.live ? join(ROOT, ...cfg.live) : null;
  if (rawLive && existsSync(rawLive)) {
    try { live = JSON.parse(readFileSync(rawLive, 'utf8')); } catch { /* 檔壞了就退回用開賽時間推 */ }
  }
  /* 盃賽與歐冠掛在英超那一條(cups.json 與 ucl.json 都是跨聯賽的一份,放英超目錄)。
     **兩者都只走「用開賽時間推」那一半** —— live feed 是 FPL 的英超專用形狀,它們不在裡面,
     所以 feed 說「現在 0 場在踢」時不能拿它否定這些場次。兩邊任一說要進場就進場。 */
  const byFeed = decideWindow({ now, fixtures, live });
  if (league !== 'pl') return byFeed;
  if (byFeed.active) return byFeed;
  const byFixtures = decideWindow({ now, fixtures: [...fixtures, ...cupFixtures(), ...uclFixtures()], live: null });
  if (byFixtures.active) return byFixtures;
  // 都不進場:回報比較早的那個喚醒時間
  return (byFixtures.sleepSec || Infinity) <= (byFeed.sleepSec || Infinity) ? byFixtures : byFeed;
}

/* 只有被直接執行時才印 —— npm test 要 import decideWindow 來驗,
   沒有這道守衛的話 import 就會在測試輸出裡插一行 JSON。
   **不要用 `import.meta.url === \`file://${process.argv[1]}\``**:
   本專案路徑含中文,import.meta.url 會被百分號編碼,永遠不相等。 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const league = process.argv.find(a => a.startsWith('--league='))?.split('=')[1] ?? 'pl';
  const out = liveWindow(Date.now(), league);
  console.log(JSON.stringify(out));

  if (process.argv.includes('--github') && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `active=${out.active}\nsleep=${out.sleepSec}\nreason=${out.reason}\n`);
  }
}
