#!/usr/bin/env node
/* 德甲 / 義甲 / 法甲的教練交付核對器。
 *
 * ── 這一支跟英冠那一支最大的不同:獨立來源不一樣,而且**強很多** ──
 * 英冠用的是外電庫(BBC / Guardian)做名字比對 —— 只回報不擋,因為一週的外電
 * 蓋不到每一隊。德義法本站**沒有外電庫**,但有一個更硬的東西:
 * FotMob 的逐場正式名單裡就帶著教練名(`lineups.{隊碼}.coach`),
 * 而那份資料**已經在倉庫裡**(賽後報告用的),核對一個額外請求都不用花。
 *
 * 所以這裡的核對是:**交付的教練 vs 本站逐場資料裡那一隊最後一場的教練**。
 *   對得上   → confirmed(有獨立來源正面確認)
 *   對不上   → 硬傷,整份不採用 —— 那通常代表交付過期了(換帥之後沒更新)
 *   沒有場次 → 無法核對,照實記 unverified,**不是 confirmed**
 * 「無法核對 ≠ 一致」是本站的老規矩,這裡照用。
 *
 * 另外兩件事:
 * - **姓名比對走本站共用的 `lib/names.mjs`**,不自己再寫一份正規化 ——
 *   那條坑(修好一份忘了另一份)本站付過代價,而且協作方附的簡化版一律不收。
 * - **換帥時間點是額外的資訊**:逐場資料看得出教練是什麼時候換的,
 *   跟交付的 `since` 差太多就記備註(±14 天內不擋,「宣布日 vs 就任日」本來就模糊)。
 *
 *   npm run de1:verify-coaches   (也可 it1 / fr1)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName } from './lib/names.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const SINCE_TOLERANCE_DAYS = 14;

const LEAGUES = {
  de1: { zh: '德甲', roster: 'teams-bundesliga.json', fotmob: 'fotmob-bundesliga',
    inbox: 'bundesliga-coaches-delivery.json', out: 'bundesliga-coaches-verified.json' },
  it1: { zh: '義甲', roster: 'teams-serie-a.json', fotmob: 'fotmob-serie-a',
    inbox: 'serie-a-coaches-delivery.json', out: 'serie-a-coaches-verified.json' },
  fr1: { zh: '法甲', roster: 'teams-ligue-1.json', fotmob: 'fotmob-ligue-1',
    inbox: 'ligue-1-coaches-delivery.json', out: 'ligue-1-coaches-verified.json' },
};

/* 逐場資料裡每一隊出現過的教練,依比賽日期排序 —— 換帥看得出來。 */
export function coachesFromMatches(root, fotmobDir, season) {
  const p = join(root, 'data', 'raw', fotmobDir, `${season}-game-details.json`);
  if (!existsSync(p)) return new Map();
  const store = JSON.parse(readFileSync(p, 'utf8'));
  const matches = store.matches ?? store;
  const byTeam = new Map();
  for (const m of Object.values(matches)) {
    for (const [code, side] of Object.entries(m.lineups ?? {})) {
      const name = side?.coach;
      if (!name) continue;
      if (!byTeam.has(code)) byTeam.set(code, []);
      byTeam.get(code).push({ name, date: m.date ?? m.kickoff ?? null });
    }
  }
  for (const list of byTeam.values()) list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return byTeam;
}

export function verify(key, root = ROOT) {
  const L = LEAGUES[key];
  if (!L) throw new Error(`不支援的聯賽 --league=${key}`);
  const inboxPath = join(root, 'data', 'manual', L.inbox);
  if (!existsSync(inboxPath)) return { missingInbox: L.inbox, zh: L.zh };
  const inboxRaw = readFileSync(inboxPath);
  const inbox = JSON.parse(inboxRaw);
  const roster = JSON.parse(readFileSync(join(root, 'data', 'manual', L.roster), 'utf8')).teams;
  const rosterBy = new Map(roster.map(t => [t.code, t]));
  const season = inbox.season ?? '2026-27';
  const seen = coachesFromMatches(root, L.fotmob, season);

  const problems = [], notes = [], coaches = [];
  const codes = (inbox.coaches ?? []).map(c => c.code);
  if (new Set(codes).size !== codes.length) problems.push('交付檔裡有重複的隊碼');

  for (const c of inbox.coaches ?? []) {
    if (!rosterBy.has(c.code)) { problems.push(`隊碼不在名冊裡:${c.code}`); continue; }
    if (!c.name) { problems.push(`${c.code} 沒有教練名`); continue; }
    if (!c.source || !/^https?:\/\//.test(c.source)) {
      notes.push(`${c.code} 沒有 https 出處,不採用`); continue;
    }
    if (c.since && !/^\d{4}-\d{2}-\d{2}$/.test(c.since)) problems.push(`${c.code} 的 since 格式不對:${c.since}`);
    if (c.since && c.since > new Date().toISOString().slice(0, 10)) problems.push(`${c.code} 的 since 在未來:${c.since}`);

    const list = seen.get(c.code) ?? [];
    const rec = { code: c.code, name: c.name, since: c.since ?? null, source: c.source, matches: list.length };
    if (!list.length) {
      /* 本站沒有這一隊的逐場名單 → 查不動。**照實寫 unverified,不是 confirmed** */
      rec.verdict = 'unverified';
      rec.why = '本站還沒有這一隊的逐場正式名單,無法用獨立來源核對';
      notes.push(`${c.code} 無法核對(沒有逐場名單),等級 unverified`);
    } else {
      const latest = list[list.length - 1];
      rec.seenLatest = latest.name; rec.seenLatestDate = latest.date;
      if (normName(latest.name) === normName(c.name)) {
        rec.verdict = 'confirmed';
        /* 換帥時間點:逐場資料裡第一次出現這個名字的日期 */
        const first = list.find(x => normName(x.name) === normName(c.name));
        rec.firstSeen = first?.date ?? null;
        /* **只有「他不是從本季第一場就在」時,這個日期才有意義。**
           本站的逐場資料只涵蓋本季,所以一個 2024 年就上任的教練,
           「第一次看到他」必然是本季開幕戰 —— 拿它跟 since 比會得出 821 天,
           而那個數字什麼都沒說。第一版就是這樣寫的,結果是**每一個久任的教練
           都會產生一則沒有資訊的備註**(「印太多跟沒印一樣」)。
           他若是季中接手,第一場就會晚於開幕戰,那時候 since 才對得起來。 */
        const teamOpener = list[0]?.date ?? null;
        const midSeasonStart = first?.date && teamOpener && first.date > teamOpener;
        rec.tookOverMidSeason = !!midSeasonStart;
        if (c.since && first?.date && midSeasonStart) {
          const gap = Math.abs((Date.parse(first.date) - Date.parse(c.since)) / 86400000);
          rec.sinceGapDays = Math.round(gap);
          /* 逐場資料看得到的是「他執教的第一場」,本來就晚於就任日 ——
             差很多只記備註,不擋(英冠那支對 since 也是 ±14 天的規矩)。 */
          if (gap > SINCE_TOLERANCE_DAYS) {
            notes.push(`${c.code} 季中接手,而 since ${c.since} 跟他第一場執教 ${first.date} 差 ${Math.round(gap)} 天(只回報)`);
          }
        }
      } else {
        /* 對不上通常是交付過期了 —— 換帥之後沒更新。這是硬傷。 */
        rec.verdict = 'conflict';
        problems.push(`${c.code} 交付寫「${c.name}」,而本站 ${latest.date} 的正式名單是「${latest.name}」`);
      }
    }
    coaches.push(rec);
  }

  const missing = roster.filter(t => !codes.includes(t.code));
  if (missing.length) notes.push(`交付沒有涵蓋 ${missing.length} 支:${missing.map(t => t.code).join('、')}`);

  const accepted = problems.length === 0;
  return {
    ranAt: new Date().toISOString(), zh: L.zh, out: L.out, season,
    inboxSha: createHash('sha256').update(inboxRaw).digest('hex'),
    source: inbox.source ?? null, accepted, problems, notes,
    counts: {
      delivered: (inbox.coaches ?? []).length,
      confirmed: coaches.filter(c => c.verdict === 'confirmed').length,
      unverified: coaches.filter(c => c.verdict === 'unverified').length,
      conflict: coaches.filter(c => c.verdict === 'conflict').length,
    },
    coaches: accepted ? coaches : [],
  };
}

function main() {
  const keys = arg('league') ? [arg('league')] : Object.keys(LEAGUES);
  for (const key of keys) {
    const r = verify(key);
    if (r.missingInbox) { console.log(`· ${r.zh}:還沒有收件匣(data/manual/${r.missingInbox}),略過`); continue; }
    console.log(`▶ ${r.zh}教練核對(收件匣 sha ${r.inboxSha.slice(0, 12)})`);
    console.log(`  獨立來源:本站逐場正式名單的教練欄(FotMob,${r.season})`);
    console.log(`  交付 ${r.counts.delivered}・對上 ${r.counts.confirmed}・無法核對 ${r.counts.unverified}・衝突 ${r.counts.conflict}`);
    for (const n of r.notes) console.log(`  · ${n}`);
    for (const p of r.problems) console.log(`  ✗ ${p}`);
    console.log(r.accepted ? `✔ 採用 ${r.coaches.length} 筆 → data/${r.out}`
      : `✗ 有 ${r.problems.length} 項對不上,**整份不採用**(不挑著用)`);
    writeFileSync(join(ROOT, 'data', r.out), JSON.stringify(r, null, 2));
  }
}
if (process.argv[1] && process.argv[1].endsWith('verify-league-coaches.mjs')) main();
