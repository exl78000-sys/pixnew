/* 人工交付的球隊資料(隊色、城市、球場、容量、綽號)的核對核心 —— **四個聯賽共用**。
 *
 * 收件匣 → 核對 → 產物,build 只讀產物。協作方自己說「都檢查過了」不算數(鐵則五:
 * 實際踩過 —— 交回來的進球明細自報 0 筆不符,拿獨立來源逐場核對出 39 場)。
 *
 * ── 四道核對 ──
 * 1. **對照題**:這個聯賽有沒有一批「本站早就有答案」的球隊。有就逐欄位比,
 *    對不上整份不採用。**沒有對照組的聯賽要照實回報 `null`,不是 0** ——
 *    0 會被讀成「查了 0 支、全過」,而事實是「這一關做不了」(「0 是一個看起來
 *    很像答案的數字」那條坑的第四次)。
 * 2. **隊色 vs 隊徽**(獨立核對):抽隊徽主色跟交付的主色比 ΔE。
 *    **不要求一樣** —— 球衣跟隊徽本來就可能不同,這一關抓的是「差得離譜」。
 *    無彩度(白/黑)的主色**沒有分辨力**:Bolton 的隊徽一點白都沒有,
 *    而他們的球衣真的是白的。那種只回報、不判定。
 * 3. **容量的量級與一致性**:落在該聯賽的合理區間;同一座球場容量必須一致。
 *    區間**逐聯賽給**,而且寧可寬 —— 英冠第一版把上限寫成 62,000,
 *    誤標了 62,500 的倫敦碗,**那是規格寫窄了不是資料錯**。
 * 4. **逐欄位出處**:有值就必須有 `sources[欄位]`,沒有的那一格不採用。
 *    不確定要回 null —— 缺一格畫面上可以標「未取得」,填錯的讀者不會知道。
 *
 * **有一筆被證明錯就整份不採用**,不挑著用:從兩個對不上的來源裡選一個喜歡的答案
 * 等於沒有核對(進球明細與 Alaves 那兩次的教訓)。
 */
import { createHash } from 'node:crypto';
import { decodePNG } from './png.mjs';
import { oklch, deltaE } from './colour.mjs';

export const TEAM_FIELDS = ['colors', 'city', 'venue', 'capacity', 'nickname'];
const DELTA_E_LIMIT = 40;

const hex = (r, g, b) => '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/* 隊徽的主色。量化成 16 階再分箱 —— 不分箱的話同一塊藍會散成上百個相近色,
   誰都排不到前面。透明像素不算(背景不是球隊的顏色)。 */
export function crestColours(dataUri, n = 10) {
  const img = decodePNG(Buffer.from(String(dataUri).split(',')[1], 'base64'));
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

/**
 * @param inboxRaw 收件匣的原始 bytes(要算 sha,不是 parse 過的物件)
 * @param roster   本站該聯賽的名冊
 * @param control  對照組(Map code → 已知正確的那筆);**這個聯賽沒有就給 null**
 * @param crests   Map code → data URI
 */
export function verifyTeamDelivery({ inboxRaw, roster, control = null, crests = new Map(),
  capMin, capMax }) {
  const inbox = JSON.parse(inboxRaw);
  const inboxSha = createHash('sha256').update(inboxRaw).digest('hex');
  const rosterBy = new Map(roster.map(t => [t.code, t]));

  const problems = [];       // 足以整份退回的
  const notes = [];          // 只回報,不退回
  const teams = [];

  const codes = (inbox.teams ?? []).map(t => t.code);
  if (new Set(codes).size !== codes.length) problems.push('交付檔裡有重複的隊碼');
  for (const t of inbox.teams ?? []) if (!rosterBy.has(t.code)) problems.push(`隊碼不在名冊裡:${t.code} ${t.en}`);
  const missing = roster.filter(t => !codes.includes(t.code));
  if (missing.length) notes.push(`交付沒有涵蓋 ${missing.length} 支:${missing.map(t => t.code).join('、')}`);

  // ── 1. 對照題 ──
  let controlTeams = control ? 0 : null;
  if (control) {
    for (const t of inbox.teams ?? []) {
      const o = control.get(t.code);
      if (!o) continue;
      controlTeams++;
      const diff = [];
      if (o.city && t.city && o.city !== t.city) diff.push(`城市 ${o.city} ≠ ${t.city}`);
      if (o.venue && t.venue && o.venue !== t.venue) diff.push(`球場 ${o.venue} ≠ ${t.venue}`);
      if (o.capacity && t.capacity && o.capacity !== t.capacity) diff.push(`容量 ${o.capacity} ≠ ${t.capacity}`);
      const a = (o.colors ?? []).map(x => x.toUpperCase()).join(',');
      const b = (t.colors ?? []).map(x => x.toUpperCase()).join(',');
      if (a && b && a !== b) diff.push(`隊色 ${a} ≠ ${b}`);
      if (diff.length) problems.push(`對照題不符 ${t.code}:${diff.join('、')}`);
    }
  }

  // ── 2~4. 逐隊 ──
  const venueCap = new Map();
  for (const t of inbox.teams ?? []) {
    const rec = { code: t.code, en: t.en, fields: {}, checks: {} };
    for (const f of TEAM_FIELDS) {
      const v = t[f];
      if (v == null || (Array.isArray(v) && !v.length)) continue;
      /* 有值就要有出處。沒有出處的那一格不採用 —— 核對時對不上要回得去看。 */
      if (!t.sources?.[f]) { notes.push(`${t.code} 的 ${f} 有值但沒有出處,不採用`); continue; }
      rec.fields[f] = v;
    }

    if (rec.fields.capacity != null) {
      const c = rec.fields.capacity;
      if (!Number.isInteger(c) || c < capMin || c > capMax) {
        problems.push(`${t.code} 容量超出合理範圍:${c}(這個聯賽的球場約 ${capMin}~${capMax})`);
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
      rec.checks.crestVerdict = achromatic ? 'not-comparable' : best <= DELTA_E_LIMIT ? 'ok' : 'far';
      if (rec.checks.crestVerdict === 'far') {
        notes.push(`${t.code} 的主色 ${claimed} 跟隊徽差很遠(ΔE ${Math.round(best)}),已保留但請人看一眼`);
      }
    } else if (claimed) {
      rec.checks.crestVerdict = 'no-crest';
    }
    teams.push(rec);
  }

  const accepted = problems.length === 0;
  return {
    ranAt: new Date().toISOString(),
    inboxSha, source: inbox.source ?? null, retrievedAt: inbox.retrievedAt ?? null,
    accepted, controlTeams, problems, notes,
    counts: Object.fromEntries(TEAM_FIELDS.map(f => [f, teams.filter(t => t.fields[f] != null).length])),
    teams: accepted ? teams : [],
  };
}

/* 印出來的那幾行也共用 —— 各寫一份的話,同一個核對在不同聯賽讀起來不一樣。 */
export function deliveryLines(r, zh) {
  const out = [`▶ ${zh}球隊資料核對(收件匣 sha ${r.inboxSha.slice(0, 12)})`];
  out.push(r.controlTeams == null
    /* 沒有對照組要講出來,而且要講出代價 —— 不然讀的人會以為這一關過了 */
    ? '  對照題:**這個聯賽沒有對照組**(本站沒有它的既有答案可比),所以這一關做不了 —— 逐欄位出處是唯一的把關'
    : `  對照題:${r.controlTeams} 支本站既有球隊`);
  out.push(`  欄位:${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join('・')}`);
  /* **把最差的幾個 ΔE 印出來,不要只印超標的那些。**
     這個門檻(40)是刻意寬的 —— 它抓的是「差得離譜」不是「驗證正確」。
     實測過它的鑑別力:拿亮綠 `#00FF00` 當多特蒙德的主色(隊徽是黃黑),
     ΔE 只有 20,照樣判 ok。所以**通過不等於對**,而沒有對照組的聯賽
     (德義法)更要讓人看得到最差的那幾筆,而不是只看到一行「✔ 採用」。 */
  const rated = r.teams.filter(t => t.checks?.crestDeltaE != null && t.checks.crestVerdict !== 'not-comparable')
    .sort((a, b) => b.checks.crestDeltaE - a.checks.crestDeltaE).slice(0, 3);
  if (rated.length) {
    out.push(`  隊色 vs 隊徽,差最多的:${rated.map(t => `${t.code} ΔE ${t.checks.crestDeltaE}`).join('、')}`
      + '(門檻 40 是抓離譜用的,通過不代表對)');
  }
  for (const n of r.notes) out.push(`  · ${n}`);
  for (const p of r.problems) out.push(`  ✗ ${p}`);
  out.push(r.accepted
    ? `✔ 採用 ${r.teams.length} 隊`
    : `✗ 有 ${r.problems.length} 項對不上,**整份不採用**(不挑著用)`);
  return out;
}
