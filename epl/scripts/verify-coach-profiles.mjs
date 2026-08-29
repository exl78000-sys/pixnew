#!/usr/bin/env node
/* 教練基本檔案交付的核對器。
 * 收件匣 data/manual/coach-profiles.json → 核對 → data/coach-profiles-verified.json。
 *
 * 這一份的核心是**來源真偽**:交付規則寫明「陣型與風格標籤的來源要真的講到
 * 陣型/風格」。網址存不存在是可以實測的 —— data/manual/coach-profiles-urlprobe.json
 * 是逐一探測的結果(2026-08-29 實測:53 個戰術來源 41 個 404)。
 * 給一個不存在的網址當依據 = 編造,該筆定罪;區塊 = 聯賽,照舊整批退。
 * 誠實的 null(formation/style 空、來源是俱樂部官方頁)不定罪 —— 查不到照實說
 * 本來就是規則允許的。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normName } from './lib/names.mjs';
import { samePerson } from './verify-coach-careers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const LEAGUES = ['pl', 'es1', 'en2'];
const dataDir = lg => (lg === 'pl' ? 'web/data' : `web/data/leagues/${lg}`);

export function verifyProfiles(inbox, ctx) {
  const blocks = {};
  for (const lg of LEAGUES) blocks[lg] = { records: 0, convictions: [], labelIssues: [], notes: [] };

  for (const rec of inbox.coaches ?? []) {
    const b = blocks[rec.league];
    if (!b) continue;
    b.records++;
    const tag = `${rec.league}/${rec.team} ${rec.name}`;
    const roster = ctx.rosters[rec.league]?.get(rec.team);
    if (!roster) { b.convictions.push(`${tag}:隊碼不在本站名冊`); continue; }
    const ours = roster.officialName ?? roster.name;
    if (normName(rec.name) !== normName(ours) && !samePerson(rec.name, ours)) {
      b.convictions.push(`${tag}:與官方名冊的現任(${ours})不是同一人`);
      continue;
    }

    /* 來源真偽,分三級(第一版把 403 也定罪,會冤枉 —— 曼城、馬競官網對
       curl 一律 403,瀏覽器開得起來;500 是站方伺服器錯,也不是不存在的證據):
       - 404/410 = 不存在。**有 formation/style 主張、而且沒有任何一個來源活著**
         → 主張沒有依據,定罪。第二來源死但主來源活著 → labelIssue(該修但不誆人)。
       - 403/429/5xx = 無法驗證,記 note,不當證據用。 */
    {
      const statuses = (rec.sources ?? []).map(u => ({ u, s: ctx.urlStatus?.[u] ?? null }));
      const alive = statuses.some(x => x.s === 200);
      const dead = statuses.filter(x => x.s === 404 || x.s === 410);
      const blocked = statuses.filter(x => x.s != null && x.s !== 200 && x.s !== 404 && x.s !== 410);
      const hasClaim = rec.formation || (rec.style ?? []).length;
      if (hasClaim && !alive && dead.length) {
        b.convictions.push(`${tag}:formation/style 的來源沒有一個存在(${dead.map(x => `HTTP ${x.s}`).join('、')}) —— 主張沒有依據`);
      } else {
        for (const x of dead) b.labelIssues.push(`${tag}:來源失聯(HTTP ${x.s}):${x.u}`);
      }
      for (const x of blocked) b.notes.push(`${tag}:來源無法驗證(HTTP ${x.s},站方擋機器人或伺服器錯):${x.u}`);
    }

    if ((rec.style ?? []).length > 3) b.convictions.push(`${tag}:風格標籤超過 3 個`);
    if ((rec.sources ?? []).length !== 2) b.labelIssues.push(`${tag}:來源不是兩個`);
    if ((rec.style ?? []).length && !rec.formation) {
      b.labelIssues.push(`${tag}:有風格標籤卻沒有陣型 —— 不合常理,重交時說明`);
    }

    // 對照題:本站已有完整檔案的,逐欄位比
    const ctrl = ctx.controls?.[rec.league]?.get(rec.team);
    if (ctrl) {
      if (ctrl.zh && rec.zh && ctrl.zh !== rec.zh) {
        b.convictions.push(`${tag}:對照題 zh 不符(本站「${ctrl.zh}」,交付「${rec.zh}」)`);
      }
      if (ctrl.formation && rec.formation && ctrl.formation !== rec.formation) {
        b.labelIssues.push(`${tag}:對照題 formation 不同(本站 ${ctrl.formation},交付 ${rec.formation})—— 陣型會隨賽季變,記著人工判讀`);
      }
    }
  }

  const out = {};
  for (const lg of LEAGUES) {
    const b = blocks[lg];
    out[lg] = {
      verdict: b.convictions.length ? 'rejected' : (b.records ? 'accepted' : 'absent'),
      records: b.records,
      convictions: b.convictions, labelIssues: b.labelIssues, notes: b.notes,
    };
  }
  return out;
}

const main = () => {
  const inboxPath = join(ROOT, 'data', 'manual', 'coach-profiles.json');
  if (!existsSync(inboxPath)) { console.log('沒有收件匣,跳過'); return; }
  const raw = readFileSync(inboxPath, 'utf8');
  const inbox = JSON.parse(raw);

  const ctx = { rosters: {}, controls: {}, urlStatus: {} };
  const probePath = join(ROOT, 'data', 'manual', 'coach-profiles-urlprobe.json');
  if (existsSync(probePath)) ctx.urlStatus = JSON.parse(readFileSync(probePath, 'utf8')).results ?? {};
  for (const lg of LEAGUES) {
    const coaches = read(`${dataDir(lg)}/coaches.json`);
    const arr = coaches.coaches ?? coaches;
    ctx.rosters[lg] = new Map(arr.map(c => [c.team, c]));
    // 對照題 = 本站已有 zh + 風格資料的教練
    ctx.controls[lg] = new Map(arr.filter(c => c.zh && (c.formation || (c.style ?? []).length))
      .map(c => [c.team, c]));
  }

  const blocks = verifyProfiles(inbox, ctx);
  const published = [];
  for (const rec of inbox.coaches ?? []) {
    if (blocks[rec.league]?.verdict === 'accepted') published.push(rec);
  }
  const out = {
    verifiedAt: new Date().toISOString(),
    inboxSha256: createHash('sha256').update(raw).digest('hex'),
    deliveredAt: inbox.deliveredAt ?? null, preparedBy: inbox.preparedBy ?? null,
    blocks, published,
  };
  writeFileSync(join(ROOT, 'data', 'coach-profiles-verified.json'), JSON.stringify(out, null, 1));

  for (const lg of LEAGUES) {
    const b = blocks[lg];
    console.log(`[${lg}] ${b.verdict}・${b.records} 筆`);
    for (const c of b.convictions.slice(0, 8)) console.log(`  ✗ ${c}`);
    if (b.convictions.length > 8) console.log(`  ✗ …另 ${b.convictions.length - 8} 筆定罪`);
    for (const l of b.labelIssues) console.log(`  ~ ${l}`);
  }
  console.log(`發布 ${published.length} 筆`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
