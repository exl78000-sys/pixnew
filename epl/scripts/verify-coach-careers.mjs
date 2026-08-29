#!/usr/bin/env node
/* 教練職涯史交付的核對器(B 層)。
 * 收件匣 data/manual/coach-careers.json → 核對 → data/coach-careers-verified.json。
 * build 只讀核對後的產物;直接讀收件匣等於把核對整個繞過去(跟租借同一個規矩)。
 *
 * 判決的證據等級(照 CLAUDE.md 的教訓):
 * - 能定罪的:現任教練跟**聯賽官方名冊**不同人、上任日跟本站核對過的日期差超過
 *   容忍、宣稱的任期跟該隊當季實際所屬聯賽衝突、同一人任期重疊、紀錄自我矛盾。
 * - 不能定罪的:名字寫法變體(Quique = Enrique 的暱稱、Manolo = Manuel)——
 *   姓氏對得上就記 labelIssue,不退回。拿標籤問題當判決依據那條坑踩過。
 * - 區塊 = 聯賽。區塊裡有一筆被定罪,整區塊不採用。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName, clubKey } from './lib/names.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const LEAGUES = ['pl', 'es1', 'en2'];
const dataDir = lg => (lg === 'pl' ? 'web/data' : `web/data/leagues/${lg}`);

/* 「聯賽名 → 本站聯賽代碼」:只認我們真的握有逐季賽果的三個。其他聯賽查不動,
   查不動要記成「無法核對」而不是「不一致」。 */
const COMP_TO_LG = { 'premier league': 'pl', 'la liga': 'es1', championship: 'en2', 'efl championship': 'en2' };


/* 同一人判定。兩個坑逼出來的設計:
 * - 西班牙人名是雙姓:José Mourinho = José Mário Dos Santos **Mourinho** Félix,
 *   拿「最後一個 token」當姓會冤枉人(第一版真的冤枉了四筆)。
 * - 西語暱稱是常態:Quique=Enrique、Manolo=Manuel、Juanfran=Juan Francisco。
 * 規則:先展開暱稱,雙方 token 交集 ≥ 2、或一方是另一方的子集合 → 同一人。
 * 交集為 0 → 不同人(Xabi Alonso vs Calum McFarlane 就是這種)。 */
const NICK = { quique: 'enrique', manolo: 'manuel', juanfran: 'juan francisco', pep: 'josep', xabi: 'xabier' };
const tokensOf = name => new Set(normName(name).split(' ').flatMap(t => (NICK[t] ?? t).split(' ')).filter(Boolean));
export const samePerson = (a, b) => {
  // 雙教頭名冊寫成「甲 & 乙」:拆開來,對得上任何一位就算同一人
  for (const part of String(b).split('&')) {
    const ta = tokensOf(a), tb = tokensOf(part);
    const inter = [...ta].filter(x => tb.has(x)).length;
    if (inter >= 2 || inter === Math.min(ta.size, tb.size)) return true;
  }
  return false;
};

// 任期(from/to,可只有到月)跟賽季 'YYYY-YY' 是否重疊。null 端點當開放區間。
const seasonRange = season => {
  const y = Number(season.slice(0, 4));
  return { start: `${y}-08-01`, end: `${y + 1}-06-30` };
};
const monthFloor = d => (d && /^\d{4}-\d{2}$/.test(d) ? `${d}-01` : d);
const overlaps = (from, to, season) => {
  const { start, end } = seasonRange(season);
  return (monthFloor(from) ?? '0000') <= end && (monthFloor(to) ?? '9999') >= start;
};

export function verifyCareers(inbox, ctx) {
  const blocks = {};
  for (const lg of LEAGUES) blocks[lg] = { records: 0, convictions: [], labelIssues: [], notes: [] };

  const byPerson = new Map();   // 同一人任期重疊要跨紀錄看
  for (const rec of inbox.coaches ?? []) {
    const b = blocks[rec.league];
    if (!b) continue;
    b.records++;
    const roster = ctx.rosters[rec.league]?.get(rec.team);
    const tag = `${rec.league}/${rec.team} ${rec.name}`;

    if (!roster) { b.convictions.push(`${tag}:隊碼不在本站名冊`); continue; }

    /* 現任是誰:對本站的官方核對名冊。同姓不同名寫法 → 變體(labelIssue);
       整個姓都不同 → 交付方宣稱的換帥跟官方名冊衝突,定罪。 */
    const ours = roster.officialName ?? roster.name;
    if (normName(rec.name) !== normName(ours)) {
      if (samePerson(rec.name, ours)) {
        b.labelIssues.push(`${tag}:名字寫法與本站不同(本站「${ours}」),視為同一人`);
      } else {
        b.convictions.push(`${tag}:與官方名冊的現任(${ours})不是同一人`);
        continue;
      }
    }

    /* 上任日:兩邊都有才比。本站的 since 落在每月 1 號的,很可能是月精度寫成日
       (名冊沒有 precision 欄位)—— 那種只比到月,不憑 1 號去定罪。 */
    if (rec.current?.from && roster.since) {
      const a = monthFloor(rec.current.from), o = monthFloor(roster.since);
      const monthOnly = /^\d{4}-\d{2}$/.test(roster.since) || roster.since.endsWith('-01');
      const diff = Math.abs(new Date(a) - new Date(o)) / 86400000;
      const ok = monthOnly ? a.slice(0, 7) === o.slice(0, 7) : diff <= 14;
      if (!ok) b.convictions.push(`${tag}:上任日 ${rec.current.from} 與本站核對過的 ${roster.since} 不符`);
    }

    /* 自我矛盾(啟發式):宣稱現職是第一份總教練工作,note 卻說「第一份」在別隊。
       Lampard 那筆就是這樣:firstHeadCoachJob true,note 寫 Derby 才是第一份。 */
    if (rec.firstHeadCoachJob === true && rec.previous?.length) {
      b.convictions.push(`${tag}:firstHeadCoachJob 為 true 卻附了前任期`);
    }
    if (rec.firstHeadCoachJob === true && /第一份/.test(rec.note ?? '')) {
      /* 只有 note 真的點名另一家俱樂部才算矛盾 —— 「官方稱這是他的第一份工作」
         說的是現職、不點名別隊,不能定罪(第一版冤枉過 Arteta 那筆)。 */
      const noteKey = clubKey(rec.note);
      const named = (ctx.allClubNames ?? []).find(n => noteKey.includes(n) && n !== clubKey(rec.current?.club ?? ''));
      if (named) b.convictions.push(`${tag}:宣稱現職是第一份總教練工作,note 卻把「第一份」指向別隊(${named})`);
    }
    
    // 前任期:聯賽成員資格(只查我們握有賽果的聯賽與賽季)+ 同一人重疊
    const person = normName(rec.name);
    if (!byPerson.has(person)) byPerson.set(person, []);
    for (const p of rec.previous ?? []) {
      byPerson.get(person).push({ tag, from: p.from, to: p.to });
      const plg = COMP_TO_LG[String(p.competition ?? '').toLowerCase()];
      if (!plg) { b.notes.push(`${tag}:${p.club}(${p.competition})不在本站涵蓋的聯賽,無法核對`); continue; }
      const code = ctx.teamCodes[plg]?.get(clubKey(p.club));
      if (!code) {
        /* 對不到宣稱聯賽的名冊,而任期又落在我們**持有賽果的賽季**裡:
           該聯賽的登錄表涵蓋持有賽季出現過的每一隊 —— 不在裡面、卻在
           另一個聯賽的登錄表裡,代表聯賽標錯了(Mowbray 的 WBA 標成英超,
           實際在英冠)。標錯聯賽會讓風格從錯的季檔算,不能放行。 */
        const inHeld = (ctx.seasons[plg] ?? []).some(season => overlaps(p.from, p.to ?? p.from, season));
        const elsewhere = LEAGUES.filter(o => o !== plg && ctx.teamCodes[o]?.get(clubKey(p.club)));
        if (inHeld && elsewhere.length) {
          b.convictions.push(`${tag}:宣稱 ${p.club} 踢 ${p.competition},但該隊在本站持有賽季從未出現在該聯賽(名冊只在 ${elsewhere.join('/')} 找得到)`);
        } else {
          b.notes.push(`${tag}:${p.club} 對不到 ${plg} 名冊,無法核對`);
        }
        continue;
      }
      /* 離任日是 null(開放式)的,只核對**起始**賽季 —— 拿未來賽季的成員資格
         去否定一段不知道何時結束的任期,會冤枉真紀錄(Pereira 的 Wolves 就是)。 */
      const endForCheck = p.to ?? p.from;
      for (const season of ctx.seasons[plg] ?? []) {
        if (!overlaps(p.from, endForCheck, season)) continue;
        if (!ctx.membership[plg].get(season)?.has(code)) {
          b.convictions.push(`${tag}:宣稱 ${season} 帶 ${p.club} 踢 ${p.competition},但該隊當季不在該聯賽`);
        }
      }
      if (!p.to) b.notes.push(`${tag}:${p.club} 離任日為 null,只核對了起始賽季`);
    }
  }

  for (const spells of byPerson.values()) {
    const sorted = [...spells].sort((a, b) => ((monthFloor(a.from) ?? '') < (monthFloor(b.from) ?? '') ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      if (prev.to && cur.from && monthFloor(cur.from) < monthFloor(prev.to)) {
        const lg = cur.tag.split('/')[0];
        blocks[lg]?.convictions.push(`${cur.tag}:任期 ${cur.from} 起,與同一人上一段(至 ${prev.to})重疊`);
      }
    }
  }

  // 控制題:Nuno 的森林任期本站自己有 —— 交付方一筆前任期都沒給就是沒做完
  const nuno = (inbox.coaches ?? []).find(c => c.team === 'WHU' && /nuno/i.test(c.name));
  if (nuno && !(nuno.previous ?? []).length) {
    blocks.en2.notes.push('控制題未過:Nuno 的 Nottingham Forest 任期(2023-12~2025-09,本站有紀錄)沒有交付');
  }

  const out = {};
  for (const lg of LEAGUES) {
    const b = blocks[lg];
    const usable = (inbox.coaches ?? []).filter(c => c.league === lg)
      .reduce((n, c) => n + (c.previous?.length ?? 0), 0);
    out[lg] = {
      verdict: b.convictions.length ? 'rejected' : (usable ? 'accepted' : 'accepted-empty'),
      records: b.records, previousTenures: usable,
      convictions: b.convictions, labelIssues: b.labelIssues, notes: b.notes,
    };
  }
  return out;
}

const main = () => {
  const inboxPath = join(ROOT, 'data', 'manual', 'coach-careers.json');
  if (!existsSync(inboxPath)) { console.log('沒有收件匣(data/manual/coach-careers.json),跳過'); return; }
  const raw = readFileSync(inboxPath, 'utf8');
  const inbox = JSON.parse(raw);

  const ctx = { rosters: {}, teamCodes: {}, seasons: {}, membership: {} };
  for (const lg of LEAGUES) {
    const coaches = read(`${dataDir(lg)}/coaches.json`);
    ctx.rosters[lg] = new Map((coaches.coaches ?? coaches).map(c => [c.team, c]));
    /* 隊名對照用 clubs **登錄表**,不用本季 teams.json —— 教練的前任期常在
       已離開這個聯賽的球隊(West Ham 已降英冠、Leicester 已降英甲),
       本季名冊對不到他們。全名/短名/別名都收(全名與 shortName 都要比那條坑)。 */
    const clubs = read(`${dataDir(lg)}/clubs.json`);
    ctx.teamCodes[lg] = new Map((clubs.clubs ?? clubs).flatMap(t =>
      [t.en, t.of, t.zh, t.fd, t.fpl, t.understat, ...(t.alias ?? []), ...(t.cupAlias ?? [])]
        .filter(Boolean).map(n => [clubKey(n), t.code])));
    const results = read(`${dataDir(lg)}/results.json`);
    const arr = results.results ?? results;
    ctx.seasons[lg] = [...new Set(arr.map(m => m.season))];
    ctx.membership[lg] = new Map();
    for (const m of arr) {
      if (!ctx.membership[lg].has(m.season)) ctx.membership[lg].set(m.season, new Set());
      ctx.membership[lg].get(m.season).add(m.home).add(m.away);
    }
  }

  // 給「第一份工作」矛盾偵測用:全部已知俱樂部名(≥ 4 字,避免短名誤中)
  ctx.allClubNames = [...new Set(LEAGUES.flatMap(lg => [...ctx.teamCodes[lg].keys()]))]
    .filter(n => n.length >= 4);

  const blocks = verifyCareers(inbox, ctx);
  const published = [];   // 只有 accepted 區塊裡有前任期的紀錄才發布
  for (const rec of inbox.coaches ?? []) {
    if (blocks[rec.league]?.verdict === 'accepted' && rec.previous?.length) published.push(rec);
  }
  const out = {
    verifiedAt: new Date().toISOString(),
    inboxSha256: createHash('sha256').update(raw).digest('hex'),
    deliveredAt: inbox.deliveredAt ?? null, preparedBy: inbox.preparedBy ?? null,
    blocks, published,
  };
  writeFileSync(join(ROOT, 'data', 'coach-careers-verified.json'), JSON.stringify(out, null, 1));

  for (const lg of LEAGUES) {
    const b = blocks[lg];
    console.log(`[${lg}] ${b.verdict}・${b.records} 筆・前任期 ${b.previousTenures} 段`);
    for (const c of b.convictions) console.log(`  ✗ ${c}`);
    for (const l of b.labelIssues) console.log(`  ~ ${l}`);
    for (const n of b.notes) console.log(`  · ${n}`);
  }
  console.log(`發布 ${published.length} 筆(只收 accepted 區塊裡有前任期的)`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
