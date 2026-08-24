#!/usr/bin/env node
// 從 Wikidata 查各隊現任總教練,與人工名冊比對後產出「疑似異動」清單。
//
// ⚠ 這個腳本在開發沙箱裡無法驗證(連不到 wikidata.org),第一次真正執行會在
//    GitHub Actions runner 或你自己的電腦上。設計上失敗完全無害:抓不到就
//    印出原因並以 exit 0 結束,不會動到任何既有檔案,也不影響 build。
//
// 為什麼不直接覆寫名冊:名冊裡的 formation / style / note 是針對「那一位教練」
// 寫的戰術描述。換人之後那些描述也失效了,自動改掉名字只會讓錯誤更隱蔽 ——
// 變成「新教練配舊戰術註記」。所以這裡只做比對與標記,改寫留給人。
//
// 用法: npm run coaches:check
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (github.com/exl78000-sys/pixnew; football analysis side project)';
const API = 'https://www.wikidata.org/w/api.php';
const HEAD_COACH = 'P286';          // Wikidata 的「總教練」屬性
const INSTANCE_OF = 'P31';
const FOOTBALL_CLUB = new Set(['Q476028', 'Q15944511']);  // 足球俱樂部 / 協會足球俱樂部

const get = async (params) => {
  const url = `${API}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 90)}`);
  return res.json();
};

// 不寫死 Q 編號 —— 用隊名搜尋,再驗證搜到的確實是足球俱樂部。
// 寫死 20 組 Q 編號我在這個環境無法查證,猜出來的常數比沒有更危險。
async function findClub(name) {
  const s = await get({ action: 'wbsearchentities', language: 'en', type: 'item', limit: '5', search: name });
  for (const hit of s.search ?? []) {
    const e = await get({ action: 'wbgetentities', ids: hit.id, props: 'claims|labels' });
    const ent = e.entities?.[hit.id];
    const types = (ent?.claims?.[INSTANCE_OF] ?? []).map(c => c.mainsnak?.datavalue?.value?.id);
    if (types.some(t => FOOTBALL_CLUB.has(t))) return { id: hit.id, entity: ent };
  }
  return null;
}

async function coachOf(entity) {
  const claims = entity?.claims?.[HEAD_COACH] ?? [];
  // 只取沒有結束日期的那一筆(P582 = 終止時間);有結束日期代表已離任
  const live = claims.filter(c => !(c.qualifiers?.P582));
  const pick = (live.length ? live : claims).at(-1);
  const id = pick?.mainsnak?.datavalue?.value?.id;
  if (!id) return null;
  const e = await get({ action: 'wbgetentities', ids: id, props: 'labels', languages: 'en|zh' });
  const labels = e.entities?.[id]?.labels ?? {};
  return { id, name: labels.en?.value ?? null, zh: labels.zh?.value ?? null };
}

const main = async () => {
  const manual = JSON.parse(await readFile(join(ROOT, 'data', 'manual', 'coaches.json'), 'utf8'));
  const teams = JSON.parse(await readFile(join(ROOT, 'web', 'data', 'teams.json'), 'utf8'));
  const byCode = new Map(teams.map(t => [t.code, t]));
  const rows = manual.coaches.filter(c => byCode.has(c.team));

  console.log(`▶ 查 ${rows.length} 隊的現任總教練(來源:Wikidata)\n`);
  const out = [];
  for (const c of rows) {
    const en = byCode.get(c.team).en;
    try {
      const club = await findClub(`${en} F.C.`) ?? await findClub(en);
      if (!club) { out.push({ team: c.team, en, status: 'club-not-found' }); console.log(`  ? ${en} —— 找不到俱樂部條目`); continue; }
      const coach = await coachOf(club.entity);
      if (!coach) { out.push({ team: c.team, en, status: 'no-coach-claim', wikidata: club.id }); console.log(`  ? ${en} —— 條目裡沒有總教練欄位`); continue; }
      const same = c.name && coach.name && c.name.toLowerCase() === coach.name.toLowerCase();
      out.push({ team: c.team, en, status: same ? 'match' : 'differs', manual: c.name, wikidata: coach.name, wikidataId: club.id });
      console.log(same ? `  ✔ ${en} —— ${coach.name}` : `  ⚠ ${en} —— 名冊「${c.name ?? '無'}」/ Wikidata「${coach.name}」`);
    } catch (e) {
      out.push({ team: c.team, en, status: 'error', error: String(e.message ?? e) });
      console.log(`  ✗ ${en} —— ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 350));   // 對免費 API 客氣一點
  }

  const differs = out.filter(o => o.status === 'differs');
  const failed = out.filter(o => ['error', 'club-not-found'].includes(o.status));
  await mkdir(join(ROOT, 'data', 'raw'), { recursive: true });
  await writeFile(join(ROOT, 'data', 'raw', 'coaches-check.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), source: 'wikidata', results: out }, null, 1));

  console.log(`\n→ 已寫入 data/raw/coaches-check.json`);
  console.log(`   一致 ${out.filter(o => o.status === 'match').length}・不一致 ${differs.length}・查詢失敗 ${failed.length}`);
  if (differs.length) {
    console.log(`\n⚠ 以下幾隊 Wikidata 與名冊不同,請人工查證後更新 data/manual/coaches.json:`);
    for (const d of differs) console.log(`   ${d.en}:${d.manual ?? '(無)'} → ${d.wikidata}`);
    console.log(`\n   注意:Wikidata 由志工維護,也可能落後或被誤改。以官方公告為準。`);
    console.log(`   換人的話,formation / style / note 那幾欄也要一起改 —— 那是寫給前一位教練的。`);
  }
};

main().catch(e => { console.error('查詢失敗(不影響 build):', e.message); });
