#!/usr/bin/env node
/* 探測:德甲 / 義甲 / 法甲的球場、城市、容量、教練、隊色,**有沒有免費來源本來就給**(2026-10-09,使用者:「你去找缺少資料」)。
 *
 * 為什麼探測而不是直接填:這幾樣目前等人工交付(鐵則三:不憑記憶填)。FotMob 的球隊頁(`/api/teams?id=`)
 * 可能本來就帶球場、城市、容量、教練與球衣色 —— 「探測失敗 ≠ 資料不存在」,先確認自己試的是不是對的端點,
 * 再決定是接來源還是繼續等交付。逐隊列出**有哪些欄位、值是什麼**,不下結論;結論要看這份輸出再寫。
 *
 * 做法:每個聯賽一個請求拿 FotMob 的隊 id(聯賽 id 54/55/53 是 probe-new-leagues 逐隊證明過的),
 * 每隊一個請求拿球隊頁。對照組:拜仁(德甲 id 的第一支)印完整的欄位路徑,其餘只印摘要。
 * 唯讀、不寫快取、最多 70 個請求(3 + 56 + 緩衝)。
 *   npm run probe:league-venues
 */
const FM = 'https://www.fotmob.com';
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';
const LEAGUES = [{ key: 'de1', zh: '德甲', id: 54, cc: 'GER' }, { key: 'it1', zh: '義甲', id: 55, cc: 'ITA' }, { key: 'fr1', zh: '法甲', id: 53, cc: 'FRA' }];
/* 端點照本站抓取器用的那個:`/api/data/leagues`(第一版寫成 `/api/leagues`,三個聯賽全 404 —— 對照既有抓取器才發現) */
let TEAM_EP = '/api/data/teams?id=';
const MAX = 70; let used = 0;
const get = async url => {
  if (++used > MAX) throw new Error('請求數超過上限');
  const res = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { accept: 'application/json', 'user-agent': UA, referer: `${FM}/` } });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: res.status, j, bytes: text.length };
};
/* 走訪整份,找鍵名含關鍵字的路徑與值(前 N 個)—— 不假設欄位在哪 */
const KEYS = /venue|stadium|city|capacity|coach|manager|color|colour|founded|surface/i;
function find(o, path = '', out = [], depth = 0) {
  if (o == null || depth > 9 || out.length > 40) return out;
  if (Array.isArray(o)) { o.slice(0, 3).forEach((v, i) => find(v, `${path}[${i}]`, out, depth + 1)); return out; }
  if (typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (KEYS.test(k) && (v == null || typeof v !== 'object')) out.push(`${p}=${JSON.stringify(v)}`);
      else find(v, p, out, depth + 1);
    }
  }
  return out;
}
let first = true;
for (const L of LEAGUES) {
  const r = await get(`${FM}/api/data/leagues?id=${L.id}&ccode3=${L.cc}&season=2026%2F2027`);
  const rows = r.j?.table?.[0]?.data?.table?.all ?? r.j?.table?.[0]?.data?.tables?.[0]?.table?.all ?? r.j?.tableData?.table?.all ?? [];
  console.log(`\n▶ ${L.zh}(FotMob ${L.id}):聯賽頁 HTTP ${r.status},${r.bytes} 位元組,球隊 ${rows.length} 支`);
  if (!rows.length) { console.log('  頂層鍵:', Object.keys(r.j ?? {}).join(','), '| table[0].data 鍵:', Object.keys(r.j?.table?.[0]?.data ?? {}).join(','), '| tableData 鍵:', Object.keys(r.j?.tableData ?? {}).join(',')); continue; }
  let have = { venue: 0, city: 0, cap: 0, coach: 0, color: 0 };
  for (const t of rows) {
    let p = await get(`${FM}${TEAM_EP}${t.id}`);
    if (!p.j && TEAM_EP === '/api/data/teams?id=') { TEAM_EP = '/api/teams?id='; p = await get(`${FM}${TEAM_EP}${t.id}`); } // 第一隊不通就換另一個端點,之後沿用
    if (first) console.log(`  球隊頁端點 ${TEAM_EP}(HTTP ${p.status})`);
    if (!p.j) { console.log(`  ${t.name}(${t.id}):HTTP ${p.status}`); continue; }
    const hits = find(p.j);
    if (first) { console.log(`  ── ${t.name} 完整欄位路徑(對照組,只印這一隊)──`); hits.forEach(h => console.log('    ' + h)); first = false; }
    const pick = re => hits.find(h => re.test(h.split('=')[0]));
    const v = pick(/venue.*name|stadium/i), c = pick(/city/i), cap = pick(/capacity/i), co = pick(/coach|manager/i), col = pick(/colou?r/i);
    have.venue += !!v; have.city += !!c; have.cap += !!cap; have.coach += !!co; have.color += !!col;
    console.log(`  ${t.name}(${t.id}) | ${v ?? '—'} | ${c ?? '—'} | ${cap ?? '—'} | ${co ?? '—'} | ${col ?? '—'}`);
  }
  console.log(`  欄位覆蓋(/${rows.length}):球場 ${have.venue}・城市 ${have.city}・容量 ${have.cap}・教練 ${have.coach}・隊色 ${have.color}`);
}
console.log(`\n請求數 ${used}/${MAX}`);
