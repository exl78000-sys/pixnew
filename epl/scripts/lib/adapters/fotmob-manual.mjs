/* Adapter:協作方用 FotMob 抓回來的補充資料(人工交付,放在 data/manual/)。
 *
 * 這批資料**不是**由本專案的腳本抓的,是照 docs/FotMob-補資料-提示詞.md
 * 轉交給另一個助手抓回來的。所以接進來之前一定要用**獨立來源**核對 ——
 * 協作方自己回報「檢查全過」不算數(鐵則五)。這個專案踩過:
 * 交回來的進球明細自報 scoreMismatches: 0,拿 openfootball 逐場對比出 39 場不符。
 *
 * 本檔只負責「讀檔 + 轉形狀 + 提供核對用的原始欄位」。
 * **核對本身由 verifyGoals() / verifyCoachRecords() 做,而且要餵我們自己的賽果進去。**
 * 沒過核對的資料一律不進前端。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'fotmob-manual';
export const label = 'FotMob(人工交付的補充資料)';

const FILE = (root, name) => join(root, 'data', 'manual', `fotmob-${name}.json`);

function load(root, name) {
  const f = FILE(root, name);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

/* ── 背號與頭貼 ───────────────────────────────
   只收 matched:true 的。matched:false 帶著 reason,那是「對方查了但沒有」,
   跟「沒查」不一樣 —— 上層可以據此告訴讀者「查過了,上游就是沒有」。 */
export function squadNumbers(root) {
  const raw = load(root, 'squad-numbers');
  if (!raw?.players) return null;
  const hit = new Map(), miss = [];
  for (const p of raw.players) {
    if (p.matched && p.squadNumber != null) hit.set(`${p.team}|${p.query}`, p);
    else miss.push({ team: p.team, query: p.query, reason: p.reason ?? null });
  }
  return { hit, miss, source: raw.source ?? 'FotMob', retrievedAt: raw.retrievedAt ?? null };
}

export function playerPhotos(root) {
  const raw = load(root, 'player-photos');
  if (!raw?.players) return null;
  const hit = new Map(), miss = [];
  for (const p of raw.players) {
    if (p.matched && p.photoUrl) hit.set(`${p.team}|${p.query}`, p);
    else miss.push({ team: p.team, query: p.query, reason: p.reason ?? null });
  }
  return { hit, miss, source: raw.source ?? 'FotMob', retrievedAt: raw.retrievedAt ?? null };
}

/* ── 教練 ─────────────────────────────────────
   注意:這批資料的 since(接任日期)**四十筆全是 null** ——
   對方回報 FotMob 球隊頁沒有這個欄位。所以只拿 seasonRecord,
   不要假裝我們有任期資料。 */
export function coaches(root) {
  const raw = load(root, 'coaches');
  if (!raw?.coaches) return null;
  const byTeam = new Map();
  for (const c of raw.coaches) {
    if (!c.league || !c.team) continue;
    byTeam.set(`${c.league}|${c.team}`, c);
  }
  return {
    byTeam,
    source: raw.source ?? 'FotMob',
    retrievedAt: raw.retrievedAt ?? null,
    withRecord: raw.coaches.filter(c => c.seasonRecord).length,
    withSince: raw.coaches.filter(c => c.since).length,
    total: raw.coaches.length,
  };
}

export function goals(root) {
  const raw = load(root, 'goals-2026-27');
  if (!raw?.leagues) return null;
  return { leagues: raw.leagues, source: raw.source ?? 'FotMob', retrievedAt: raw.retrievedAt ?? null };
}

/* ── 核對 ─────────────────────────────────────
   把我們自己的賽果餵進來逐場比對。**這是整個 adapter 的重點**,
   不是附加檢查 —— 沒過核對的比賽不准進前端。

   ourMatches: [{ home, away, fh, fa }]。
   回傳每一場的判定,以及分類統計:
     matched   比分與逐球加總都對得上 → 可以用
     newer     我們的賽果還沒有這一場(上游比我們新)→ 可以用,但要標明
     mismatch  比分對不上 → **不可以用**
     sumBad    明細加總不等於比分 → **不可以用** */
export function verifyGoals(league, fmGoals, ourMatches) {
  const byKey = new Map(ourMatches.map(m => [`${m.home}|${m.away}`, m]));
  const out = { matched: [], newer: [], mismatch: [], sumBad: [] };
  for (const m of fmGoals?.leagues?.[league]?.matches ?? []) {
    const key = `${m.home}|${m.away}`;
    const h = m.goals.filter(g => g.team === m.home).length;
    const a = m.goals.filter(g => g.team === m.away).length;
    if (h !== m.score?.home || a !== m.score?.away) {
      out.sumBad.push({ key, score: m.score, detail: { h, a } });
      continue;
    }
    const ours = byKey.get(key);
    if (!ours) { out.newer.push({ key, match: m }); continue; }
    if (ours.fh !== m.score.home || ours.fa !== m.score.away) {
      out.mismatch.push({ key, ours: { fh: ours.fh, fa: ours.fa }, theirs: m.score });
      continue;
    }
    out.matched.push({ key, match: m });
  }
  return out;
}

/* 教練戰績核對:用我們自己的賽果重算一次,逐欄位比。
   allowExtra 是「上游比我們新」的那幾場 —— 把它們補進我們的統計再比,
   這樣才分得出「資料錯」與「我們的賽果還沒更新」。 */
export function verifyCoachRecords(league, fmCoaches, ourMatches, extraMatches = []) {
  const rec = new Map();
  const add = (code, gf, ga) => {
    const r = rec.get(code) ?? { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 };
    r.p++; r.gf += gf; r.ga += ga;
    if (gf > ga) r.w++; else if (gf === ga) r.d++; else r.l++;
    rec.set(code, r);
  };
  for (const m of ourMatches) { add(m.home, m.fh, m.fa); add(m.away, m.fa, m.fh); }
  for (const m of extraMatches) {
    add(m.match.home, m.match.score.home, m.match.score.away);
    add(m.match.away, m.match.score.away, m.match.score.home);
  }
  const out = { agree: [], differ: [], noRecord: [], noOurData: [] };
  const KEYS = ['p', 'w', 'd', 'l', 'gf', 'ga'];
  for (const [key, c] of fmCoaches?.byTeam ?? []) {
    if (!key.startsWith(`${league}|`)) continue;
    if (!c.seasonRecord) { out.noRecord.push(c); continue; }
    const mine = rec.get(c.team);
    if (!mine) { out.noOurData.push(c); continue; }
    (KEYS.every(k => mine[k] === c.seasonRecord[k]) ? out.agree : out.differ)
      .push({ coach: c, ours: mine });
  }
  return out;
}

/* ── 逐球 → 本站的逐球員記錄 ─────────────────────
   FotMob 給的是「一顆球一筆」,本站 goals.mjs 吃的是「一位球員一場一筆」。

   **兩個欄位這個來源沒有,所以不做,也不填 0 冒充**:
     min   上場分鐘 → 每 90 分鐘的進球/助攻算不出來
     start 先發或替補 → 「替補進球佔比」算不出來
   goals.mjs 的 subShare()、starterGoals、subGoals 因此對這一季無效,
   上層要把它們標成 null 而不是 0 —— 0 的意思是「沒有替補進球」,
   跟「不知道是先發還是替補」完全是兩件事。

   **烏龍球要翻面。** FotMob 的 team 是**得分方**(實測:Lindelöf 替 AVL
   踢進烏龍球,那一筆的 team 是 BHA)。本站的記錄則是掛在**踢球者自己那一隊**,
   由 goals.mjs 再換算成對手得分。所以這裡要把 og 記到另一隊去 ——
   照抄 team 會讓烏龍球算成得分方自己進的,兩邊各錯一球。 */
export function goalRecords(league, fmGoals, { onlyKeys = null } = {}) {
  const rows = [];
  let ownGoals = 0;
  for (const m of fmGoals?.leagues?.[league]?.matches ?? []) {
    const key = `${m.home}|${m.away}`;
    if (onlyKeys && !onlyKeys.has(key)) continue;
    const byPlayer = new Map();
    const touch = (code, name, team, opp) => {
      const k = `${team}|${code}`;
      if (!byPlayer.has(k)) {
        byPlayer.set(k, { team, opp, code: String(code), name, g: 0, a: 0, og: 0, min: null, start: null });
      }
      return byPlayer.get(k);
    };
    for (const g of m.goals) {
      const scoringSide = g.team;
      const other = scoringSide === m.home ? m.away : m.home;
      if (g.kind === 'own') {
        // 踢進烏龍球的人屬於**失分那一隊**,記在那一隊的 og
        ownGoals++;
        touch(g.scorerId ?? g.scorer, g.scorer, other, scoringSide).og += 1;
        continue;
      }
      touch(g.scorerId ?? g.scorer, g.scorer, scoringSide, other).g += 1;
      if (g.assistId ?? g.assist) {
        touch(g.assistId ?? g.assist, g.assist, scoringSide, other).a += 1;
      }
    }
    rows.push(...byPlayer.values());
  }
  return { rows, ownGoals };
}
