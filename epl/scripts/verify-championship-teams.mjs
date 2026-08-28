#!/usr/bin/env node
/* 英冠球隊資料(隊色、城市、球場、容量、綽號)的核對器。
 *
 * **收件匣 → 核對 → 產物**,build 只讀產物。比照租借那一條:
 * 直接把交付檔寫進名冊等於把核對整個繞過去,而協作方自己說「都檢查過了」不算數
 * (鐵則五。實際踩過:交回來的進球明細自報 0 筆不符,拿獨立來源逐場核對出 39 場)。
 *
 *   收件匣  data/manual/championship-teams-delivery.json
 *   產物    data/championship-teams-verified.json
 *
 * ── 四道核對(2026-08-28 對第一版交付跑過)──
 *
 * 1. **對照題:12 支本站既有球隊**。這 12 支(BUR COV HUL IPS LEE LEI LUT SHU
 *    SOU SUN WHU WOL)的城市/球場/容量/隊色 `data/manual/teams.json` 早就有,
 *    是刻意留在交付清單裡的。對不上就是訊號 —— **整份不採用**,不挑著用
 *    (從兩個對不上的來源裡挑一個喜歡的答案等於沒有核對)。
 *    第一版:12/12 逐欄位完全一致。
 *
 * 2. **隊色 vs 隊徽**(獨立核對)。倉庫裡有 36 隊的隊徽 PNG,抽出主色跟交付的主色比。
 *    **不要求一樣** —— 球衣跟隊徽本來就可能不同,提示詞裡就是這樣寫的。
 *    這一關抓的是「差得離譜」。
 *    **這道檢查對白色球衣的球隊沒有分辨力**:Bolton 的隊徽是深藍加紅、一點白都沒有,
 *    但他們的球衣真的是白衫深藍褲。所以白/黑這種無彩度的主色只回報、不判定。
 *
 * 3. **容量的量級與一致性**。英冠球場落在一萬到六萬多之間;同一座球場(若有共用)
 *    容量必須一致。上限取 63,000 —— 62,500 的倫敦碗(West Ham)是真的,
 *    第一版我把上限寫成 62,000,結果誤標了那一筆,**那是規格寫窄了不是資料錯**。
 *
 * 4. **逐欄位出處**。有值就必須有 `sources[欄位]`,沒有的那一格不採用。
 *    不確定要回 null —— 缺一格畫面上可以標「未取得」,填錯的讀者不會知道。
 *
 *   npm run en2:verify-teams
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './lib/png.mjs';
import { oklch, deltaE } from './lib/colour.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = join(ROOT, 'data', 'manual', 'championship-teams-delivery.json');
const OUT = join(ROOT, 'data', 'championship-teams-verified.json');

const FIELDS = ['colors', 'city', 'venue', 'capacity', 'nickname'];
const CAP_MIN = 10000, CAP_MAX = 63000;
const DELTA_E_LIMIT = 40;

const loose = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/^afc\s+|\s+afc$/g, ' ').replace(/^fc\s+|\s+fc$/g, ' ')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]/g, '');

const hex = (r, g, b) => '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/* 隊徽的主色。量化成 16 階再分箱 —— 不分箱的話同一塊藍會散成上百個相近色,
   誰都排不到前面。透明像素不算(背景不是球隊的顏色)。 */
function crestColours(dataUri, n = 10) {
  const img = decodePNG(Buffer.from(dataUri.split(',')[1], 'base64'));
  const bins = new Map();
  for (let i = 0; i < img.data.length; i += 4) {
    const [r, g, b, a] = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
    if (a < 200) continue;
    const k = `${r >> 4},${g >> 4},${b >> 4}`;
    const e = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b; bins.set(k, e);
  }
  return [...bins.values()].sort((a, b) => b.n - a.n).slice(0, n)
    .map(e => hex(Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)));
}

export function verify(root = ROOT) {
  const inboxRaw = readFileSync(join(root, 'data', 'manual', 'championship-teams-delivery.json'));
  const inbox = JSON.parse(inboxRaw);
  const inboxSha = createHash('sha256').update(inboxRaw).digest('hex');
  const roster = JSON.parse(readFileSync(join(root, 'data', 'manual', 'teams-championship.json'), 'utf8')).teams;
  const pl = JSON.parse(readFileSync(join(root, 'data', 'manual', 'teams.json'), 'utf8')).teams;
  const plBy = new Map(pl.map(t => [t.code, t]));
  const rosterBy = new Map(roster.map(t => [t.code, t]));

  const crests = (() => {
    const map = new Map();
    const own = JSON.parse(readFileSync(join(root, 'data', 'manual', 'crests.json'), 'utf8')).crests ?? {};
    const cupsPath = join(root, 'data', 'manual', 'crests-cups.json');
    const cups = existsSync(cupsPath) ? JSON.parse(readFileSync(cupsPath, 'utf8')) : { crests: {}, sources: {} };
    const byName = new Map(Object.entries(cups.sources ?? {})
      .map(([id, v]) => [loose(v.name), cups.crests?.[id]]).filter(([, v]) => v));
    for (const t of roster) {
      const c = own[t.code] ?? byName.get(loose(t.en)) ?? byName.get(loose(t.of));
      if (c) map.set(t.code, c);
    }
    return map;
  })();

  const problems = [];       // 足以整份退回的
  const notes = [];          // 只回報,不退回
  const teams = [];

  const codes = inbox.teams.map(t => t.code);
  if (new Set(codes).size !== codes.length) problems.push('交付檔裡有重複的隊碼');
  for (const t of inbox.teams) if (!rosterBy.has(t.code)) problems.push(`隊碼不在名冊裡:${t.code} ${t.en}`);
  const missing = roster.filter(t => !codes.includes(t.code));
  if (missing.length) notes.push(`交付沒有涵蓋 ${missing.length} 支:${missing.map(t => t.code).join('、')}`);

  // ── 1. 對照題 ──
  let control = 0;
  for (const t of inbox.teams) {
    const o = plBy.get(t.code);
    if (!o) continue;
    control++;
    const diff = [];
    if (o.city && t.city && o.city !== t.city) diff.push(`城市 ${o.city} ≠ ${t.city}`);
    if (o.venue && t.venue && o.venue !== t.venue) diff.push(`球場 ${o.venue} ≠ ${t.venue}`);
    if (o.capacity && t.capacity && o.capacity !== t.capacity) diff.push(`容量 ${o.capacity} ≠ ${t.capacity}`);
    const a = (o.colors ?? []).map(x => x.toUpperCase()).join(','), b = (t.colors ?? []).map(x => x.toUpperCase()).join(',');
    if (a && b && a !== b) diff.push(`隊色 ${a} ≠ ${b}`);
    if (diff.length) problems.push(`對照題不符 ${t.code}:${diff.join('、')}`);
  }

  // ── 2~4. 逐隊 ──
  const venueCap = new Map();
  for (const t of inbox.teams) {
    const rec = { code: t.code, en: t.en, fields: {}, checks: {} };
    for (const f of FIELDS) {
      const v = t[f];
      if (v == null || (Array.isArray(v) && !v.length)) continue;
      /* 有值就要有出處。沒有出處的那一格不採用 —— 核對時對不上要回得去看。 */
      if (!t.sources?.[f]) { notes.push(`${t.code} 的 ${f} 有值但沒有出處,不採用`); continue; }
      rec.fields[f] = v;
    }

    if (rec.fields.capacity != null) {
      const c = rec.fields.capacity;
      if (!Number.isInteger(c) || c < CAP_MIN || c > CAP_MAX) {
        problems.push(`${t.code} 容量超出合理範圍:${c}(英冠球場約 ${CAP_MIN}~${CAP_MAX})`);
      }
      if (rec.fields.venue) {
        const prev = venueCap.get(rec.fields.venue);
        if (prev && prev.cap !== c) problems.push(`同一座球場容量不一致:${rec.fields.venue} ${prev.code} ${prev.cap} vs ${t.code} ${c}`);
        else venueCap.set(rec.fields.venue, { cap: c, code: t.code });
      }
    }

    const claimed = rec.fields.colors?.[0];
    const crest = crests.get(t.code);
    if (claimed && crest) {
      const top = crestColours(crest);
      const best = Math.min(...top.map(h => deltaE(claimed, h)));
      const achromatic = oklch(claimed).C < 0.05;
      rec.checks.crestDeltaE = Math.round(best);
      /* 白/黑這種無彩度的主色,隊徽比不出來 —— Bolton 的隊徽一點白都沒有,
         但球衣真的是白的。這種只回報,不判定。 */
      rec.checks.crestVerdict = achromatic ? 'not-comparable' : best <= DELTA_E_LIMIT ? 'ok' : 'far';
      if (rec.checks.crestVerdict === 'far') {
        notes.push(`${t.code} 的主色 ${claimed} 跟隊徽差很遠(ΔE ${Math.round(best)}),已保留但請人看一眼`);
      }
    } else if (claimed) {
      rec.checks.crestVerdict = 'no-crest';
    }
    teams.push(rec);
  }

  /* **有一筆被證明錯就整份不採用。** 挑通過的用,等於在兩個對不上的來源裡
     選一個喜歡的答案 —— 進球明細那次的教訓。 */
  const accepted = problems.length === 0;
  const report = {
    ranAt: new Date().toISOString(),
    inboxSha, source: inbox.source ?? null, retrievedAt: inbox.retrievedAt ?? null,
    accepted, controlTeams: control, problems, notes,
    counts: Object.fromEntries(FIELDS.map(f => [f, teams.filter(t => t.fields[f] != null).length])),
    teams: accepted ? teams : [],
  };
  return report;
}

function main() {
  const r = verify();
  console.log(`▶ 英冠球隊資料核對(收件匣 sha ${r.inboxSha.slice(0, 12)})`);
  console.log(`  對照題:${r.controlTeams} 支本站既有球隊`);
  console.log(`  欄位:${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join('・')}`);
  for (const n of r.notes) console.log(`  · ${n}`);
  for (const p of r.problems) console.log(`  ✗ ${p}`);
  console.log(r.accepted
    ? `✔ 採用 ${r.teams.length} 隊 → data/championship-teams-verified.json`
    : `✗ 有 ${r.problems.length} 項對不上,**整份不採用**(不挑著用)`);
  writeFileSync(OUT, JSON.stringify(r, null, 2));
  if (!r.accepted) process.exitCode = 1;
}

/* **不要用 `import.meta.url === \`file://${process.argv[1]}\``。**
   本專案的路徑含中文,import.meta.url 會被百分號編碼(claude%E8%B6%B3%E7%90%83),
   跟原始路徑永遠不相等 —— main() 靜靜不執行,腳本跑完什麼都沒印。
   用 fileURLToPath 解回來再比(fetch-official.mjs 就是這樣寫的)。 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
