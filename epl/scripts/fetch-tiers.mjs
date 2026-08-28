#!/usr/bin/env node
/* 抓英格蘭各級聯賽的球隊名單 → data/manual/team-tiers.json。
 *
 * 用途只有一個:盃賽頁要講得出對手是第幾級的球隊。
 * 來源是 openfootball/football.json —— **本站英超賽程本來就是從那裡來的**
 * (見 lib/sources.mjs 的 en.1.json),靜態檔、Public Domain、
 * 沙箱與 runner 都連得到,所以不需要任何 API 額度。
 *
 * 上游目前只發布到:2026-27 的 en.1 / en.2,以及 2025-26 的 en.1~en.4。
 * **拿不到的不補、不猜** —— 英甲英乙的本季名單上游還沒有,
 * 那就用上一季並在畫面上標出賽季(球隊每年升降級,不標就是拿去年講今年)。
 *
 *   npm run tiers
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_SOURCES, tierKey } from './lib/adapters/england-tiers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'manual', 'team-tiers.json');
const BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';

async function main() {
  const seasons = {};
  const got = [];
  const missing = [];
  for (const src of TIER_SOURCES) {
    const url = `${BASE}/${src.season}/${src.file}`;
    let j = null;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { missing.push(`${src.season}/${src.file} HTTP ${r.status}`); continue; }
      j = await r.json();
    } catch (e) { missing.push(`${src.season}/${src.file} ${e.message}`); continue; }

    const names = [...new Set((j.matches ?? []).flatMap(m => [m.team1, m.team2]).filter(Boolean))];
    seasons[src.season] ??= {};
    let added = 0, clashes = [];
    for (const name of names) {
      const k = tierKey(name);
      const prev = seasons[src.season][k];
      /* 同一季同一個 key 出現兩次 = 兩支不同球隊塌成一個名字,
         那是對照表壞掉的訊號,整組退掉而不是挑一個(比照盃賽隊碼的做法)。 */
      if (prev && prev.name !== name) { clashes.push(`${prev.name} / ${name}`); continue; }
      seasons[src.season][k] = { name, zh: src.zh, tier: src.tier };
      added++;
    }
    got.push(`${src.season} ${src.zh} ${added} 隊`);
    if (clashes.length) console.log(`  ⚠ ${src.season} ${src.zh} 有同名衝突,已整組略過:${clashes.join('、')}`);
  }

  if (!got.length) { console.log('⚠ 一份層級名單都沒抓到,不寫檔。'); process.exitCode = 1; return; }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    _note: '英格蘭各級聯賽的球隊名單,給盃賽頁標示對手層級用。key 是正規化過的隊名。'
      + '層級逐季查 —— 球隊每年升降級,不可以拿某一季的層級講另一季。',
    source: 'openfootball/football.json', retrievedAt: new Date().toISOString(),
    unavailable: missing, seasons,
  }, null, 0) + '\n');

  console.log(`✔ 層級名單:${got.join('・')} → ${OUT}`);
  if (missing.length) console.log(`  上游沒有(不補也不猜):${missing.join('、')}`);
}

main().catch(e => { console.error('層級名單抓取失敗:', e.message); process.exitCode = 1; });
