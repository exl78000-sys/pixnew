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
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
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
  return decideWindow({ now, fixtures, live });
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
