/* 租借紀錄 —— 兩個聯賽共用的一份轉換。

   `build.mjs` 與 `build-laliga.mjs` **各呼叫一次同一個函式**。
   複製一份轉換過去的話,改了一邊另一邊會悄悄過期(專案在跨聯賽頁面上踩過)。

   只讀 `data/loans-verified.json`(核對器的產物),**不讀收件匣**
   `data/manual/loans.json` —— 收件匣裡有已知是錯的紀錄,
   直接讀它等於把核對整個繞過去。 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { matchOne } from './names.mjs';

export function loadVerifiedLoans(root) {
  const p = join(root, 'data', 'loans-verified.json');
  if (!existsSync(p)) return { available: false, stale: false, records: [], tally: {}, verifiedAt: null };
  const j = JSON.parse(readFileSync(p, 'utf8'));

  /* 收件匣改過、核對卻沒重跑 —— 這種狀態下 build 會拿舊的核對結果當真,
     畫面上有資料、沒有任何地方報錯。所以這裡主動比對雜湊,
     對不上就回 stale,由呼叫端決定怎麼講(現在是整批不掛,寧可少也不要錯)。 */
  const inbox = join(root, 'data', 'manual', 'loans.json');
  let stale = false, staleReason = null;
  if (existsSync(inbox)) {
    const now = createHash('sha256').update(readFileSync(inbox)).digest('hex');
    if (!j.inboxSha) {
      stale = true;
      staleReason = '核對結果沒有記錄收件匣雜湊(舊版產物),無法確認是不是最新的';
    } else if (j.inboxSha !== now) {
      stale = true;
      staleReason = '收件匣 data/manual/loans.json 改過,但核對沒有重跑';
    }
  }

  return {
    available: true,
    stale,
    staleReason,
    records: j.records ?? [],
    rejected: j.rejected ?? [],
    tally: j.tally ?? {},
    bySeason: j.bySeason ?? {},
    verifiedAt: j.verifiedAt ?? null,
    excluded: j.excluded ?? null,
    sources: j.sources ?? [],
  };
}

/* 把租借紀錄掛到球員身上。

   `side` 決定要掛哪一種:
     'out' —— 這名球員從本聯賽的球隊被租出去(母隊是本聯賽的隊碼)
     'in'  —— 這名球員被租進本聯賽的球隊(目的地是本聯賽的隊碼)
   兩種都掛,因為兩種對讀者的意義不同:前者解釋「他為什麼整季 0 分鐘」,
   後者解釋「他為什麼突然出現在這一隊」。

   回傳 { attached, unmatched } —— unmatched 是配不到球員的紀錄,
   要印出來讓人看到,不能靜靜吞掉(配不到通常代表名字寫法不同,是可以修的)。 */
export function attachLoans(players, loans, { nameOf, codesOf, leagueCodes }) {
  if (!loans.available) return { attached: 0, unmatched: [] };
  /* 核對結果比收件匣舊 —— 整批不掛。
     掛上去的話畫面會有資料,但那是拿舊核對結果背書新的交付內容,
     等於把核對繞過去。寧可少也不要錯。 */
  if (loans.stale) return { attached: 0, unmatched: [], stale: true };
  const inLeague = code => code && leagueCodes.has(code);
  const unmatched = [];
  let attached = 0;

  for (const rec of loans.records) {
    const outward = inLeague(rec.parentCode);
    const inward = inLeague(rec.loanCode);
    if (!outward && !inward) continue;

    /* 配對走共用的 lib/names.mjs。**不要在這裡再寫一份** ——
       複製過的那一版曾經跟核對器分岔,結果 20 筆租借掛到了錯的人身上。 */
    const hit = matchOne(players, rec.player, { nameOf });
    if (!hit) { unmatched.push(rec); continue; }

    hit.loans ??= [];
    hit.loans.push({
      season: rec.season,
      direction: outward ? 'out' : 'in',
      parentClub: rec.parentClub, parentCode: rec.parentCode,
      loanClub: rec.loanClub, loanCode: rec.loanCode,
      date: rec.date, datePrecision: rec.datePrecision,
      /* 核對等級要跟著資料走到畫面上。
         confirmed  有獨立來源正面確認;consistent 只是沒有矛盾。
         兩者對讀者的意義不同,不可以在畫面上混成一句「有租借紀錄」。 */
      verdict: rec.verdict,
      evidence: rec.evidence ?? [],
      source: rec.source ?? null,
    });
    attached++;
  }
  for (const p of players) {
    if (p.loans) p.loans.sort((a, b) => String(a.season).localeCompare(String(b.season)));
  }
  return { attached, unmatched };
}

/* 某一季的 0 出賽是不是租借解釋得掉。

   上游的 0 分不出「在這個聯賽但沒上場」與「當季不在這個聯賽」——
   有一筆核對過的外借紀錄,就能把這個 0 講清楚。
   沒有的話仍然照實說分不出來,不要用「大概是外借」補。 */
export function loanExplaining(player, season) {
  return (player.loans ?? []).find(l => l.season === season && l.direction === 'out') ?? null;
}
