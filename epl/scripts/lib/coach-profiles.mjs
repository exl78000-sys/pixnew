/* 教練基本檔案(zh/nat/formation/style)的掛載。
 * 收件匣 → verify-coach-profiles.mjs 核對(含來源網址實測)→ 這裡只讀核對產物。
 * 規則:**只補 null / 空的欄位,不覆蓋**本站既有的人工整理 ——
 * 對照題(阿爾特塔那批)的資料是本站的基準,不能被交付蓋掉。
 * 三個 build 共用同一份(複製會悄悄過期)。 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function loadVerifiedProfiles(ROOT) {
  const vPath = join(ROOT, 'data', 'coach-profiles-verified.json');
  const inboxPath = join(ROOT, 'data', 'manual', 'coach-profiles.json');
  if (!existsSync(vPath) || !existsSync(inboxPath)) return { status: 'absent', published: [] };
  const v = JSON.parse(readFileSync(vPath, 'utf8'));
  const sha = createHash('sha256').update(readFileSync(inboxPath, 'utf8')).digest('hex');
  if (v.inboxSha256 !== sha) return { status: 'stale', published: [] };
  return { status: 'ok', published: v.published ?? [] };
}

export function attachProfiles(ROOT, coachesArr, league) {
  const { status, published } = loadVerifiedProfiles(ROOT);
  if (status === 'stale') {
    console.log('  ⚠ 教練檔案核對結果跟不上收件匣,整批不掛 —— 先跑 npm run profiles:verify');
    return { status, filled: 0 };
  }
  let filled = 0;
  for (const rec of published) {
    if (rec.league !== league) continue;
    const co = coachesArr.find(c => c.team === rec.team);
    if (!co) continue;
    /* 雙教頭的名冊是一筆「甲 & 乙」,交付是兩筆單人 —— 單人的譯名與國籍
       套不上聯名紀錄,只收兩人一致的 formation/style。 */
    const joint = String(co.name ?? '').includes('&');
    let touched = false;
    if (!joint && !co.zh && rec.zh) { co.zh = rec.zh; touched = true; }
    if (!joint && !co.nat && rec.nat) { co.nat = rec.nat; touched = true; }
    if (!co.formation && rec.formation) { co.formation = rec.formation; touched = true; }
    if (!(co.style ?? []).length && (rec.style ?? []).length) { co.style = rec.style; touched = true; }
    if (touched) { co.profileVerified = true; filled++; }
  }
  if (filled) console.log(`  教練基本檔案:補上 ${filled} 位(只補 null,經來源核對)`);
  return { status: 'ok', filled };
}
