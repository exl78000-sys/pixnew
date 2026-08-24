#!/usr/bin/env node
// 現在該不該進入「比賽日模式」?回傳 JSON 給 workflow 判斷。
//
//   node scripts/live-window.mjs            → 印出 JSON
//   node scripts/live-window.mjs --github   → 同時寫進 $GITHUB_OUTPUT
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

export function liveWindow(now = Date.now()) {
  const fx = join(ROOT, 'web', 'data', 'fixtures.json');
  if (!existsSync(fx)) return { active: false, reason: '找不到賽程資料', sleepSec: 0 };

  const fixtures = JSON.parse(readFileSync(fx, 'utf8'));
  const upcoming = [];
  let liveNow = 0;

  /* 「現在有沒有比賽在踢」優先看剛抓回來的 live.json —— 它有 started/finished
     兩個明確的旗標。fixtures.json 的 played 要等 build 跑完才會變,
     在輪詢迴圈裡用它會慢一拍:比賽踢完了迴圈還在空轉。 */
  const rawLive = join(ROOT, 'data', 'raw', 'live.json');
  let fromFeed = false;
  if (existsSync(rawLive)) {
    try {
      const live = JSON.parse(readFileSync(rawLive, 'utf8'));
      if (!live.demo && Array.isArray(live.fixtures)) {
        liveNow = live.fixtures.filter(f => f.started && !f.finished).length;
        fromFeed = true;
      }
    } catch { /* 檔壞了就退回用開賽時間推 */ }
  }

  for (const f of fixtures) {
    if (!f.kickoff) continue;
    const ko = Date.parse(f.kickoff);
    if (!Number.isFinite(ko)) continue;
    const minsSince = (now - ko) / 60000;
    // 沒有即時資料源時,只能用開賽時間推;已完賽的不算,補賽改期才不會空轉
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

const out = liveWindow();
console.log(JSON.stringify(out));

if (process.argv.includes('--github') && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT,
    `active=${out.active}\nsleep=${out.sleepSec}\nreason=${out.reason}\n`);
}
