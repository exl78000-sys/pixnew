#!/usr/bin/env node
/* 英冠教練交付的核對器。收件匣 → 核對 → 產物,build 只讀產物(比照球隊資料與租借)。
 *
 * **協作方自報「verified」不算數**(鐵則五)。這次交付還附了他們自己的核對器與
 * 核對報告 —— 那是他們的自我檢查,本站照樣自己驗。他們另附了一份自己寫的
 * names.mjs,**沒有收**:本站的 lib/names.mjs 有 NFD 分解不掉的字母對照(Đ→Dj)
 * 與 matchOne,收下他們的簡化版就是「複本漂移」那條坑本尊。
 *
 * ── 四道核對(2026-08-29 對第一版交付實測)──
 *
 * 1. **對照組:6 支英超球隊。** 現任教練本站每天跟英超官方核對,手上有標準答案。
 *    名字用本站的 normName 比對,錯一筆整份退回。第一版 6/6 全對。
 *    since 另外跟本站名冊比:差 2~8 天(ARS、AVL)—— 那是「宣布日 vs 就任日」
 *    的常見模糊,而本站自己的日期也不權威,±14 天內記備註不退回。
 * 2. **外電庫比對(獨立來源)。** 教練名 vs data/raw/news-championship.json
 *    (BBC/Guardian,每日累積)。第一版:24 位裡 11 位已在一週外電出現。
 *    **只回報不擋** —— 沒出現的不是反證(一週的 40 則蓋不到每一隊),
 *    這道會隨外電累積越來越有分辨力。
 * 3. **格式與出處**:名冊逐碼對齊、型別、since 格式與不在未來、
 *    有值的欄位必須有 https 出處。
 * 4. **整批退回**:有一項硬傷就整份不採用,不挑著用。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName } from './lib/names.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = join(ROOT, 'data', 'manual', 'championship-coaches-delivery.json');
const OUT = join(ROOT, 'data', 'championship-coaches-verified.json');
const CONTROLS = ['ARS', 'AVL', 'LIV', 'MCI', 'NEW', 'TOT'];
const DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;
const SINCE_TOLERANCE_DAYS = 14;

export function verify(root = ROOT) {
  const raw = readFileSync(join(root, 'data', 'manual', 'championship-coaches-delivery.json'));
  const inbox = JSON.parse(raw);
  const inboxSha = createHash('sha256').update(raw).digest('hex');
  const roster = JSON.parse(readFileSync(join(root, 'data', 'manual', 'teams-championship.json'), 'utf8')).teams;
  const curCodes = JSON.parse(readFileSync(join(root, 'web', 'data', 'leagues', 'en2', 'table.json'), 'utf8'))
    .current.map(r => r.code);

  const problems = [], notes = [];
  const coaches = inbox.coaches ?? [];
  const byCode = new Map();

  // ── 名冊對齊:本季 24 隊 + 6 支對照組,一支不多、一支不少 ──
  const expected = new Set([...curCodes, ...CONTROLS]);
  for (const c of coaches) {
    if (!expected.has(c.code)) problems.push(`不在名單上的隊碼:${c.code}`);
    if (byCode.has(c.code)) problems.push(`重複隊碼:${c.code}`);
    byCode.set(c.code, c);
  }
  for (const code of expected) if (!byCode.has(code)) problems.push(`缺少:${code}`);
  const rosterBy = new Map(roster.map(t => [t.code, t]));
  for (const c of coaches) {
    const t = rosterBy.get(c.code);
    if (t && t.en !== c.en && !CONTROLS.includes(c.code)) problems.push(`${c.code} 的隊名不符名冊:${c.en}`);
  }

  // ── 型別、日期與出處 ──
  const today = new Date().toISOString().slice(0, 10);
  for (const c of coaches) {
    if (c.name !== null && (typeof c.name !== 'string' || !c.name.trim())) problems.push(`${c.code} name 型別錯誤`);
    if (c.since !== null) {
      if (!DATE_RE.test(c.since)) problems.push(`${c.code} since 格式錯誤:${c.since}`);
      else if (c.since > today) problems.push(`${c.code} since 在未來:${c.since}`);
      else if (c.since < '1990-01') problems.push(`${c.code} since 早得離譜:${c.since}`);
    }
    if (c.caretaker !== null && typeof c.caretaker !== 'boolean') problems.push(`${c.code} caretaker 型別錯誤`);
    for (const f of ['name', 'nat', 'since', 'caretaker']) {
      if (c[f] !== null && c[f] !== undefined && !/^https:\/\//.test(c.sources?.[f] ?? '')) {
        problems.push(`${c.code}.${f} 有值但沒有出處`);
      }
    }
  }

  // ── 對照組:名字比官方(退回級)、since 比本站名冊(備註級) ──
  const official = JSON.parse(readFileSync(join(root, 'web', 'data', 'official.json'), 'utf8')).managers ?? {};
  const ourCoaches = JSON.parse(readFileSync(join(root, 'web', 'data', 'coaches.json'), 'utf8')).coaches ?? [];
  let controlOk = 0;
  for (const code of CONTROLS) {
    const c = byCode.get(code);
    const officialName = official[code]?.name ?? null;
    if (!c || !officialName) { notes.push(`對照組 ${code} 少了一邊,無法比`); continue; }
    if (normName(c.name) === normName(officialName)) controlOk++;
    else problems.push(`對照組不符 ${code}:交付「${c.name}」vs 官方「${officialName}」`);
    const ours = ourCoaches.find(x => x.team === code);
    if (c.since && ours?.since && c.since.length === 10) {
      const diff = Math.abs((new Date(c.since) - new Date(ours.since)) / 864e5);
      if (diff > SINCE_TOLERANCE_DAYS) problems.push(`對照組 ${code} 的 since 差 ${diff} 天:${c.since} vs ${ours.since}`);
      else if (diff > 0) notes.push(`${code} since 差 ${diff} 天(${c.since} vs 本站 ${ours.since})—— 宣布日與就任日的模糊,不退回`);
    }
  }

  // ── 外電庫(獨立來源,只回報) ──
  let newsHits = null;
  const newsPath = join(root, 'data', 'raw', 'news-championship.json');
  if (existsSync(newsPath)) {
    const blob = JSON.parse(readFileSync(newsPath, 'utf8')).map(n => `${n.title} ${n.body}`).join(' ');
    const nb = normName(blob);
    const en2 = coaches.filter(c => !CONTROLS.includes(c.code) && c.name);
    const hit = en2.filter(c => normName(c.name).split(/[\s&]+/).filter(w => w.length > 3).some(w => nb.includes(w)));
    newsHits = { checked: en2.length, mentioned: hit.length };
    notes.push(`外電庫比對:${hit.length}/${en2.length} 位教練已在英冠外電出現(累積式訊號,沒出現不是反證)`);
  }

  const accepted = problems.length === 0;
  const report = {
    ranAt: new Date().toISOString(), inboxSha,
    source: inbox.source ?? null, retrievedAt: inbox.retrievedAt ?? null,
    accepted, controls: { total: CONTROLS.length, ok: controlOk }, newsHits, problems, notes,
    // 只發布英冠 24 隊 —— 對照組是核對工具,不進產物(英超的教練有自己的管線)
    coaches: accepted
      ? coaches.filter(c => !CONTROLS.includes(c.code))
          .map(c => ({ team: c.code, name: c.name, nat: c.nat ?? null, since: c.since ?? null,
            caretaker: c.caretaker ?? null, sources: c.sources ?? {} }))
      : [],
  };
  return report;
}

function main() {
  const r = verify();
  console.log(`▶ 英冠教練交付核對(收件匣 sha ${r.inboxSha.slice(0, 12)})`);
  console.log(`  對照組 ${r.controls.ok}/${r.controls.total}${r.newsHits ? `・外電命中 ${r.newsHits.mentioned}/${r.newsHits.checked}` : ''}`);
  for (const n of r.notes) console.log(`  · ${n}`);
  for (const p of r.problems) console.log(`  ✗ ${p}`);
  console.log(r.accepted
    ? `✔ 採用 ${r.coaches.length} 隊 → data/championship-coaches-verified.json`
    : `✗ 有 ${r.problems.length} 項對不上,整份不採用`);
  writeFileSync(OUT, JSON.stringify(r, null, 2));
  if (!r.accepted) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
