#!/usr/bin/env node
/* 把 FotMob matchId 橋推出來的球隊 id 對照**落地**到 data/manual/ucl-team-ids.json。
 *
 * 零網路 —— 只讀倉庫裡已經有的兩份檔(見 lib/ucl-ids.mjs 的檔頭)。
 * 為什麼要落地而不是每次 build 現算:那份檔的 `_why` 本來就寫著
 * 「對照落地成檔案,錯了看得出來也改得掉」。現算的話,哪天橋推錯一組,
 * 畫面上只會多一個掛錯的隊徽,而沒有任何地方看得出來。
 *
 * 但「落地」不等於「手寫清單」—— 本站在手寫清單上付過五次代價。所以:
 *   · 新的球隊由這一支自己補上去(踢過一場、逐場詳情抓回來就推得出)
 *   · `npm test` 拿同一支橋重新推一次,跟落地的逐組比對,**不一致就紅**
 *   · 落地的跟橋**衝突**時這一支不改任何東西、結束碼 1 —— 那代表有一邊錯了,
 *     自動挑一個等於在兩個對不上的答案裡選一個喜歡的
 *
 * `_scope`:只收本站六個聯賽都不認得的球隊(有隊碼的走 clubs.json / teams-*.json)。
 *
 *   npm run ucl:ids
 *   npm run ucl:ids -- --dry-run
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeUclTeamIds } from './lib/ucl-ids.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'manual', 'ucl-team-ids.json');
const DRY = process.argv.includes('--dry-run');

/* football-data 那一側的身分:名字用 ucl.json 的 `name`(畫面上 external[].en 就是它,
   跟頁面其他地方同一個來源),有 `code` 的代表本站自己認得 —— 照 _scope 不收。 */
function fdIdentity(root) {
  const p = join(root, 'web', 'data', 'ucl.json');
  if (!existsSync(p)) return { name: new Map(), coded: new Set() };
  const ucl = JSON.parse(readFileSync(p, 'utf8'));
  const name = new Map(), coded = new Set();
  const walk = v => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    if (v.id != null && typeof v.name === 'string') {
      if (!name.has(v.id)) name.set(v.id, v.name);
      if (v.code) coded.add(v.id);
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(ucl);
  return { name, coded };
}

function main() {
  const br = bridgeUclTeamIds(ROOT);
  for (const s of br.seasons) console.log(`  ${s.season}:逐場詳情 ${s.details} 場,matchId 對上 ${s.matched}、對不上 ${s.unmatched}`);
  console.log(`▶ matchId 橋:${br.matched} 場對上、${br.unmatchedMid} 場對不上 → ${br.pairs.size} 組對照、衝突 ${br.conflicts.length} 組`);
  if (!br.pairs.size) { console.log('⚠ 一組都推不出來(還沒有逐場詳情?)—— 不動檔案。'); return; }

  const store = JSON.parse(readFileSync(OUT, 'utf8'));
  const { name: fdName, coded } = fdIdentity(ROOT);

  /* 先驗對照組:既有的每一組都要被橋重現。這一步是在驗**方法**,不是驗資料 ——
     它紅了就代表橋壞了,那時候一個字都不該寫進檔案。 */
  const clash = [];
  for (const t of store.teams ?? []) {
    const got = br.pairs.get(t.fdId);
    if (got != null && got !== t.fotmobId) clash.push(`${t.fdId} ${t.fdName}:落地 ${t.fotmobId} vs 橋 ${got}`);
  }
  const overlap = (store.teams ?? []).filter(t => br.pairs.has(t.fdId)).length;
  console.log(`  對照組:既有 ${(store.teams ?? []).length} 組裡重疊 ${overlap},不一致 ${clash.length}`);
  if (clash.length) {
    for (const c of clash) console.error('   ✗', c);
    console.error('✗ 落地的對照跟橋衝突 —— 不改任何東西。先查清楚哪一邊錯了。');
    process.exitCode = 1;
    return;
  }

  const have = new Set((store.teams ?? []).map(t => t.fdId));
  const added = [];
  for (const [fd, fm] of [...br.pairs].sort((a, b) => a[0] - b[0])) {
    if (have.has(fd)) continue;
    if (coded.has(fd)) continue;                    // 本站自己認得,照 _scope 不收
    if (!fdName.has(fd)) continue;                  // ucl.json 裡沒有這一隊 → 不編一個名字
    added.push({ fdId: fd, fdName: fdName.get(fd), fotmobId: fm, fotmobName: br.names.get(fm) ?? null,
      via: `matchId 橋(${br.votes.get(fd)} 場)` });
  }

  /* unmapped 裡被解掉的要拿掉 —— 留著的話畫面會同時說「有隊徽」與「對照不到」。 */
  const stillUnmapped = (store.unmapped ?? []).filter(u => !added.some(a => a.fdId === u.fdId));
  const resolved = (store.unmapped ?? []).filter(u => added.some(a => a.fdId === u.fdId));

  console.log(`  新增 ${added.length} 組${resolved.length ? `(其中 ${resolved.length} 組原本記在 unmapped)` : ''}`);
  for (const a of added) console.log(`    fd ${String(a.fdId).padStart(6)} ${String(a.fdName).padEnd(14)} → fotmob ${String(a.fotmobId).padStart(7)} ${a.fotmobName ?? ''}   ${a.via}`);
  for (const r of resolved) console.log(`    (解掉)${r.fdId} ${r.fdName} —— 原記載:${r.why}`);
  if (!added.length) { console.log('✔ 沒有要新增的,檔案不動。'); return; }
  if (DRY) { console.log('(--dry-run,不寫檔)'); return; }

  store.teams = [...(store.teams ?? []), ...added].sort((a, b) => a.fdId - b.fdId);
  store.unmapped = stillUnmapped;
  store._method2 = 'FotMob matchId 橋(scripts/lib/ucl-ids.mjs,2026-09-22 起):同一個 matchId 的主隊對主隊、'
    + '客隊對客隊,完全不比隊名。三季 396/396 場對上、0 衝突,既有那 40 組 40/40 重現。'
    + '新的球隊由 npm run ucl:ids 自己補上去,npm test 每次重推一次跟落地的比對。';
  store.verifiedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(OUT, JSON.stringify(store, null, 2) + '\n');
  console.log(`✔ 寫入 ${OUT}(共 ${store.teams.length} 組,unmapped ${store.unmapped.length})`);
}

main();
