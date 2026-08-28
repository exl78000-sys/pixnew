/* 租借紀錄 —— 兩個聯賽共用的一份轉換。

   `build.mjs` 與 `build-laliga.mjs` **各呼叫一次同一個函式**。
   複製一份轉換過去的話,改了一邊另一邊會悄悄過期(專案在跨聯賽頁面上踩過)。

   只讀 `data/loans-verified.json`(核對器的產物),**不讀收件匣**
   `data/manual/loans.json` —— 收件匣裡有已知是錯的紀錄,
   直接讀它等於把核對整個繞過去。 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function loadVerifiedLoans(root) {
  const p = join(root, 'data', 'loans-verified.json');
  if (!existsSync(p)) return { available: false, records: [], tally: {}, verifiedAt: null };
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return {
    available: true,
    records: j.records ?? [],
    rejected: j.rejected ?? [],
    tally: j.tally ?? {},
    bySeason: j.bySeason ?? {},
    verifiedAt: j.verifiedAt ?? null,
    excluded: j.excluded ?? null,
    sources: j.sources ?? [],
  };
}

/* 姓名配對跟核對器用同一套保守規則:全名精確 → 姓氏唯一 → 姓氏+名字首字母唯一。
   配不出唯一的一律回 null。對錯人比對不到糟得多 ——
   光英超同姓的就有 15 組(Martinez 兩個、Wilson 三個)。 */
function matchOne(candidates, name, nameOf) {
  const k = norm(name);
  const exact = candidates.filter(c => norm(nameOf(c)) === k);
  if (exact.length === 1) return exact[0];
  const parts = k.split(' ');
  const last = parts.at(-1), first = parts[0] ?? '';
  const bySurname = candidates.filter(c => norm(nameOf(c)).split(' ').at(-1) === last);
  if (bySurname.length === 1) return bySurname[0];
  const byInitial = bySurname.filter(c => norm(nameOf(c)).startsWith(first[0] ?? ' '));
  return byInitial.length === 1 ? byInitial[0] : null;
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
  const inLeague = code => code && leagueCodes.has(code);
  const unmatched = [];
  let attached = 0;

  for (const rec of loans.records) {
    const outward = inLeague(rec.parentCode);
    const inward = inLeague(rec.loanCode);
    if (!outward && !inward) continue;

    const hit = matchOne(players, rec.player, nameOf);
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
