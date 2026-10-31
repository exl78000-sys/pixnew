#!/usr/bin/env node
/* 英冠的傷停與停賽:FotMob `matchDetails` 有沒有缺陣名單?(2026-10-31,使用者:「繼續完善英冠」)
 *
 * 為什麼要這一支:英冠的「沒有」清單寫著「傷停與停賽」,理由欄寫的是「FotMob 逐場端點有沒有傷停名單**還沒探測過**」——
 * 那是一句誠實的未知,不是一句否定。這一支把它變成已知。
 *
 * 只問一件事,而且**不猜鍵名**(盃賽評分那次只看鍵名,連兩次印出「0 人」):
 *   走訪整份回應,記下**鍵名**像缺陣的欄位(unavailable / injur / suspen / missing / absent / doubt),
 *   每一種路徑印出它的形狀 —— 陣列幾筆、元素物件有哪些鍵、像「類型 / 預計回歸」那種**非個人**的值的樣本。
 *   不印球員姓名(用不到,而且名字不是這一題要答的)。
 *
 * 挑兩場、都從倉庫裡挑(不另外發請求去找):
 *   - 下一場還沒開踢的英冠比賽:缺陣名單是**賽前**的東西,完賽之後上游可能就不給了;
 *   - 最近一場已完賽的:看完賽後還留不留。
 * 只問其中一場的話,「沒有」分不出是「上游不給」還是「這個時間點不給」。
 *
 * 硬上限:**2 個請求**。唯讀,不寫任何快取、不動任何產物。
 *
 *   npm run probe:unavailable
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://www.fotmob.com';
const UA = 'pl-war-room/1.0 (football analysis side project)';
const KEY_RE = /unavail|injur|suspen|missing|absent|doubt/i;

function pickMatches() {
  const p = join(ROOT, 'data', 'raw', 'fotmob-championship', 'scores.json');
  if (!existsSync(p)) return [];
  const ms = (JSON.parse(readFileSync(p, 'utf8')).matches ?? []).filter(m => m.matchId && m.utcTime && !m.cancelled);
  const now = Date.now();
  const upcoming = ms.filter(m => !m.started && Date.parse(m.utcTime) > now).sort((a, b) => a.utcTime.localeCompare(b.utcTime))[0];
  const done = ms.filter(m => m.finished).sort((a, b) => b.utcTime.localeCompare(a.utcTime))[0];
  return [upcoming && { ...upcoming, label: '下一場未賽' }, done && { ...done, label: '最近一場已完賽' }].filter(Boolean);
}

/* 鍵名像缺陣的欄位:記路徑(陣列索引攤平)、型別、陣列長度、元素的鍵,以及元素裡**短字串 / 數字 / 布林**
   且鍵名不像姓名的值 —— 那是「類型 / 預計回歸 / 理由」這種要判讀的東西 */
function findAbsence(node, path = '$', out = new Map()) {
  if (node == null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    const p = `${path}.${k}`.replace(/\[\d+\]/g, '[]');
    if (KEY_RE.test(k)) {
      const e = out.get(p) ?? { path: p, type: Array.isArray(v) ? 'array' : typeof v, hits: 0, lengths: [], keys: new Set(), samples: new Map() };
      e.hits++;
      if (Array.isArray(v)) {
        e.lengths.push(v.length);
        for (const it of v.slice(0, 50)) collectShape(it, '', e);
      } else if (v && typeof v === 'object') collectShape(v, '', e);
      else e.samples.set('(值)', String(v).slice(0, 60));
      out.set(p, e);
    }
    if (Array.isArray(v)) v.forEach(it => findAbsence(it, `${path}.${k}[]`, out));
    else if (v && typeof v === 'object') findAbsence(v, `${path}.${k}`, out);
  }
  return out;
}
function collectShape(obj, prefix, e) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const [k, v] of Object.entries(obj)) {
    const kk = prefix + k;
    e.keys.add(kk);
    if (/name|first|last/i.test(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && !prefix) { collectShape(v, kk + '.', e); continue; }
    if (['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 40) {
      const set = e.samples.get(kk) ?? new Set();
      if (set.size < 6) set.add(String(v));
      e.samples.set(kk, set);
    }
  }
}

async function main() {
  const picks = pickMatches();
  if (!picks.length) { console.log('✗ 倉庫裡找不到英冠的 FotMob 賽程(data/raw/fotmob-championship/scores.json),不另外發請求去找'); return; }
  console.log(`▶ 英冠缺陣名單探測・硬上限 ${picks.length} 個請求`);
  for (const m of picks) {
    console.log(`\n── ${m.label}:${m.home} vs ${m.away}(${m.utcTime},matchId ${m.matchId})`);
    let r;
    try {
      const res = await fetch(`${BASE}/api/data/matchDetails?matchId=${m.matchId}`, { signal: AbortSignal.timeout(30000),
        headers: { accept: 'application/json', 'user-agent': UA, referer: `${BASE}/` } });
      r = { status: res.status, ok: res.ok, text: await res.text() };
    } catch (e) { console.log(`   ✗ ${e.message}`); continue; }
    console.log(`   HTTP ${r.status}・${(r.text.length / 1024).toFixed(0)} KB`);
    if (!r.ok) continue;
    let raw; try { raw = JSON.parse(r.text); } catch { console.log('   ✗ 回傳不是 JSON'); continue; }
    const lu = raw?.content?.lineup;
    console.log(`   content 的鍵:${Object.keys(raw?.content ?? {}).join(', ') || '(沒有 content)'}`);
    console.log(`   content.lineup 的鍵:${lu ? Object.keys(lu).join(', ') : '(沒有 lineup)'}`);
    if (lu?.homeTeam) console.log(`   lineup.homeTeam 的鍵:${Object.keys(lu.homeTeam).join(', ')}`);
    const hits = [...findAbsence(raw).values()];
    console.log(`   鍵名像缺陣的欄位:${hits.length} 種路徑`);
    for (const h of hits.slice(0, 15)) {
      console.log(`   • ${h.path}(${h.type}${h.lengths.length ? `,長度 ${h.lengths.join('/')}` : ''})`);
      if (h.keys.size) console.log(`     元素的鍵:${[...h.keys].join(', ')}`);
      for (const [k, v] of h.samples) console.log(`     ${k} 的值樣本:${v instanceof Set ? [...v].join(' | ') : v}`);
    }
  }
  console.log('\n✔ 唯讀探測結束(沒有寫任何檔)。判讀:兩場都 0 種路徑 → 這支端點不給;只有未賽那場有 → 賽前才有,要在賽前抓');
}

main().catch(e => { console.error('探測失敗:', e.message); process.exitCode = 1; });
