#!/usr/bin/env node
/* FotMob 英格蘭盃賽探測(唯讀,不寫任何正式快取)。
 *
 * 為什麼(2026-09-07):SportMonks 退訂之後,足總盃與聯賽盃的賽程/賽果沒有來源 ——
 * `encups` 的快取停在 9/2,聯賽盃第三輪 9/8 就開踢,盃賽頁會一直顯示「未賽」。
 * 站上已經在打 FotMob 的聯賽端點(`fetch-fotmob-scores.mjs`,id 47/87/48 是在用的),
 * 而抓賽事 logo 時實證過 id 132 / 133 的名字就是 FA Cup / EFL Cup。
 *
 * 這支只回答「**盃賽在同一個端點回什麼形狀**」,不憑印象寫 adapter(CLAUDE.md 第四節):
 *   1. 輪次名在哪個欄位(聯賽是數字 round;盃賽要的是 "Round 3" 這種名字)
 *   2. 比分怎麼給、延長賽與 PK 怎麼標、PK 比數有沒有
 *   3. 隊 id 有沒有(隊徽要用 id 掛,不用隊名比對 —— AFC Liverpool 那個坑)
 *   4. 隊徽網址 images.fotmob.com/…/teamlogo/{id}.png 是推測,實際打一次看是不是 PNG
 *   5. 跟倉庫裡 SportMonks 的舊快取逐場對得起來嗎(鐵則五:獨立來源核對,而且是現成的)
 *
 * 抓取禮貌:單線、間隔 800ms、硬上限 9 個請求(端點最多 6 個 + 隊徽最多 3 張)。
 * 沙箱連不到外網 —— 走 probe-apis.yml 的 workflow_dispatch 跑,再讀 log。
 *
 *   npm run probe:fotmob-cups
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (football analysis side project)';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const BASE = 'https://www.fotmob.com/api/data/leagues';
const LOGO = id => `https://images.fotmob.com/image_resources/logo/teamlogo/${id}.png`;
const MAX_REQUESTS = 9;
const CUPS = [
  { key: 'facup', zh: '足總盃', id: 132, expect: /fa cup/i },
  { key: 'eflcup', zh: '聯賽盃', id: 133, expect: /carabao|league cup|efl cup/i },
];
// 本站的賽季寫法 → FotMob 的寫法(跟 fetch-fotmob-scores 同一個換算)
const SEASONS = [{ label: '2026-27', fm: '2026/2027' }, { label: '2025-26', fm: '2025/2026' }];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;
async function get(url, { json = true, headers = {} } = {}) {
  if (requests >= MAX_REQUESTS) throw new Error(`已達本次 ${MAX_REQUESTS} 個請求上限`);
  if (requests) await sleep(800);
  requests++;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers });
  if (!json) return res;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`回傳不是 JSON(${text.length} bytes)`); }
  // 200 加一個 error 物件是踩過的坑
  if (j?.error) throw new Error(`回了 200 但帶 error:${JSON.stringify(j.error).slice(0, 120)}`);
  return j;
}
const apiHeaders = { accept: 'application/json', 'user-agent': UA, referer: 'https://www.fotmob.com/' };

/* ── 形狀描述:不假設任何欄位,把實際有的列出來 ── */
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v);
const keyProfile = (objs) => {
  const seen = new Map();
  for (const o of objs) for (const [k, v] of Object.entries(o ?? {})) {
    const e = seen.get(k) ?? { n: 0, types: new Set() };
    e.n++; e.types.add(typeOf(v)); seen.set(k, e);
  }
  return [...seen].map(([k, e]) => `${k}:${[...e.types].join('|')}${e.n < objs.length ? `(${e.n}/${objs.length})` : ''}`).join('  ');
};
// 原始值的分布:輪次名、狀態文字這種「值本身就是語意」的欄位靠這個看
const distribution = (vals, cap = 40) => {
  const m = new Map();
  for (const v of vals) { const k = JSON.stringify(v ?? null); m.set(k, (m.get(k) ?? 0) + 1); }
  const rows = [...m].sort((a, b) => b[1] - a[1]);
  return `${rows.length} 種:` + rows.slice(0, cap).map(([k, n]) => `${k}×${n}`).join(' ') + (rows.length > cap ? ' …' : '');
};

/* 跨來源的隊名鍵:只做大小寫/重音/標點/字尾 FC 的正規化,**字首的 AFC 不動**
   (字尾的 FC/AFC 是法人形式,字首的 AFC 是球隊身分 —— CLAUDE.md 那條坑)。 */
const nameKey = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/\s+(fc|afc)$/, '').replace(/\s+/g, ' ');

function loadSportmonks(key, label) {
  const p = join(ROOT, 'data', 'raw', 'sportmonks-cups', `${key}.json`);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return raw.seasons?.find(s => s.label === label) ?? null;
}

/* 逐場核對:同一個 UTC 日期(±1 天,時區邊界)+ 兩隊名字鍵相同。
   對上的比比分;對不上的把 FotMob 那邊的名字印出來 —— 命名差異是 adapter 要處理的第一件事。 */
function crossCheck(fmMatches, smSeason) {
  const byDate = new Map();
  for (const m of smSeason.matches) {
    const d = String(m.kickoff ?? '').slice(0, 10);
    if (!d) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(m);
  }
  const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const out = { matched: 0, agree: 0, disagree: [], unmatched: [], fmFinished: 0, stageMap: new Map(), roundNums: new Map(), pens: [], aet: [] };
  for (const f of fmMatches) {
    const st = f.status ?? {};
    const d = String(st.utcTime ?? '').slice(0, 10);
    if (!d || !f.home?.name || !f.away?.name) continue;
    const hk = nameKey(f.home.name), ak = nameKey(f.away.name);
    let hit = null;
    for (const dd of [d, shift(d, -1), shift(d, 1)]) {
      hit = (byDate.get(dd) ?? []).find(m => nameKey(m.home?.name) === hk && nameKey(m.away?.name) === ak);
      if (hit) break;
    }
    if (st.finished === true) out.fmFinished++;
    if (!hit) {
      if (out.unmatched.length < 24) {
        const sameDay = (byDate.get(d) ?? []).map(m => `${m.home?.name} v ${m.away?.name}`);
        out.unmatched.push(`${f.home.name} v ${f.away.name} @${d} ${st.scoreStr ?? ''}  ← SM 同日:${sameDay.slice(0, 3).join(' / ') || '(無)'}`);
      }
      continue;
    }
    out.matched++;
    // 輪次名對照:SM 的 stage → FotMob 這一場的 round / roundName(兩個都記,不知道哪個才是名字)
    const rn = f.roundName ?? null;
    const sk = `${hit.stage} → ${JSON.stringify(rn)}`;
    out.stageMap.set(sk, (out.stageMap.get(sk) ?? 0) + 1);
    if (!out.roundNums.has(rn)) out.roundNums.set(rn, new Map());
    const rm = out.roundNums.get(rn); rm.set(f.round ?? null, (rm.get(f.round ?? null) ?? 0) + 1);
    if (hit.played && st.finished === true) {
      const sc = /^(\d+)\s*-\s*(\d+)$/.exec(String(st.scoreStr ?? '').trim());
      const fm = sc ? [Number(sc[1]), Number(sc[2])] : null;
      const sm = hit.final;
      if (fm && sm && fm[0] === sm[0] && fm[1] === sm[1]) out.agree++;
      else if (out.disagree.length < 16) out.disagree.push(`${f.home.name} v ${f.away.name} @${d}:FotMob ${st.scoreStr} vs SM ${sm?.join('-')}${hit.aet ? ' aet' : ''}${hit.pens ? ` pens ${hit.pens.join('-')}` : ''}`);
      // PK / 延長的場次:FotMob 那邊長什麼樣(這是 adapter 最需要知道的)
      if (hit.pens && out.pens.length < 4) out.pens.push({ sm: `${hit.home.name} ${hit.final?.join('-')} ${hit.away.name} pens ${hit.pens.join('-')}${hit.aet ? ' aet' : ''}`, fm: f });
      else if (hit.aet === true && out.aet.length < 2) out.aet.push({ sm: `${hit.home.name} ${hit.final?.join('-')} ${hit.away.name} aet(90 分 ${hit.ft90?.join('-') ?? '?'})`, fm: f });
    }
  }
  return out;
}

const pick = (arr, pred) => arr.find(pred) ?? null;
const show = (label, obj) => console.log(`    ${label}:${JSON.stringify(obj)}`);

async function probeSeason(cup, season, body, label) {
  console.log(`\n── ${cup.zh}(id ${cup.id})${label} ──`);
  console.log(`  頂層鍵:${Object.keys(body).join(', ')}`);
  const details = body.details ?? {};
  show('details', Object.fromEntries(Object.entries(details).filter(([, v]) => v === null || typeof v !== 'object').slice(0, 16)));
  if (Array.isArray(body.allAvailableSeasons)) console.log(`  allAvailableSeasons:${JSON.stringify(body.allAvailableSeasons.slice(0, 8))}`);
  const name = String(details.name ?? '');
  if (!cup.expect.test(name)) console.log(`  ✗ 名字「${name}」跟預期的 ${cup.zh} 對不上 —— 這個 id 不是這個盃賽`);
  const fixtures = body.fixtures ?? {};
  console.log(`  fixtures 鍵:${Object.keys(fixtures).join(', ') || '(沒有 fixtures)'}`);
  const all = Array.isArray(fixtures.allMatches) ? fixtures.allMatches : [];
  console.log(`  allMatches:${all.length} 場`);
  if (!all.length) {
    // 也許盃賽的場次不在 fixtures.allMatches —— 把其他看起來像比賽清單的陣列列出來
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') console.log(`  ・${k}:array(${v.length}),元素鍵 ${Object.keys(v[0]).slice(0, 12).join(',')}`);
      else if (v && typeof v === 'object') console.log(`  ・${k}:object,鍵 ${Object.keys(v).slice(0, 12).join(',')}`);
    }
    return null;
  }
  console.log(`  比賽欄位:${keyProfile(all)}`);
  console.log(`  status 欄位:${keyProfile(all.map(m => m.status))}`);
  console.log(`  home 欄位:${keyProfile(all.map(m => m.home))}`);
  for (const k of Object.keys(all[0] ?? {})) {
    const vals = all.map(m => m[k]);
    if (vals.every(v => v == null || typeof v !== 'object') && new Set(vals.map(v => JSON.stringify(v ?? null))).size <= 60) {
      console.log(`  ${k} 的分布:${distribution(vals)}`);
    }
  }
  const stVals = k => all.map(m => m.status?.[k]);
  for (const k of ['finished', 'started', 'cancelled', 'awarded', 'ongoing']) if (all.some(m => m.status && k in m.status)) console.log(`  status.${k}:${distribution(stVals(k))}`);
  if (all.some(m => m.status?.reason)) {
    console.log(`  status.reason.short:${distribution(all.map(m => m.status?.reason?.short))}`);
    console.log(`  status.reason.long:${distribution(all.map(m => m.status?.reason?.long))}`);
  }
  for (const k of Object.keys(all[0]?.status ?? {})) {
    if (/pen|aggreg|extra|aet/i.test(k)) console.log(`  status.${k}:${distribution(stVals(k))}`);
  }
  const first = all[0];
  const finished = pick(all, m => m.status?.finished === true);
  const pen = pick(all, m => /pen/i.test(JSON.stringify(m.status ?? {})) && m.status?.finished === true);
  const aet = pick(all, m => /aet|extra/i.test(JSON.stringify(m.status ?? {})) && m.status?.finished === true && m !== pen);
  const notStarted = pick(all, m => m.status?.started !== true && m.status?.finished !== true);
  const placeholder = pick(all, m => /tbc|winner|loser|tbd/i.test(`${m.home?.name} ${m.away?.name}`));
  const odd = pick(all, m => m.status?.cancelled === true || m.status?.awarded === true || /postp|abandon|award/i.test(JSON.stringify(m.status?.reason ?? {})));
  show('第一場', first);
  if (finished) show('一場已完賽', finished);
  if (pen) show('一場 PK', pen);
  if (aet) show('一場延長', aet);
  if (notStarted) show('一場未賽', notStarted);
  if (placeholder) show('一場對手未定', placeholder);
  if (odd) show('一場取消/延期/判決', odd);
  const dates = all.map(m => String(m.status?.utcTime ?? '').slice(0, 10)).filter(Boolean).sort();
  console.log(`  日期範圍:${dates[0]} ~ ${dates.at(-1)}・已完賽 ${all.filter(m => m.status?.finished === true).length}`);
  return all;
}

async function main() {
  console.log(`▶ FotMob 英格蘭盃賽探測(最多 ${MAX_REQUESTS} 個請求)`);
  const logoCandidates = [];
  for (const cup of CUPS) {
    let selected = null;
    // 不帶 season:看預設是哪一季、有哪些季
    let base;
    try { base = await get(`${BASE}?id=${cup.id}&ccode3=GBR`, { headers: apiHeaders }); }
    catch (e) { console.log(`\n── ${cup.zh}(id ${cup.id})──\n  ✗ ${e.message}`); continue; }
    selected = base.details?.selectedSeason ?? base.details?.latestSeason ?? null;
    const baseAll = await probeSeason(cup, null, base, `(不帶 season;selectedSeason=${JSON.stringify(selected)})`);
    const results = { [String(selected)]: baseAll };
    for (const s of SEASONS) {
      let all = results[s.fm];
      if (all === undefined) {
        try {
          const body = await get(`${BASE}?id=${cup.id}&ccode3=GBR&season=${encodeURIComponent(s.fm)}`, { headers: apiHeaders });
          all = await probeSeason(cup, s, body, `(season=${s.fm})`);
        } catch (e) { console.log(`\n── ${cup.zh} season=${s.fm} ──\n  ✗ ${e.message}`); all = null; }
      } else console.log(`\n── ${cup.zh} season=${s.fm}:跟不帶 season 那份相同,不另外請求 ──`);
      if (!all?.length) continue;
      const sm = loadSportmonks(cup.key, s.label);
      if (!sm) { console.log(`  (倉庫沒有 SportMonks ${s.label} 的快取,不核對)`); continue; }
      const cc = crossCheck(all, sm);
      console.log(`  ▷ 跟 SportMonks ${s.label} 快取核對:SM ${sm.matches.length} 場(已賽 ${sm.matches.filter(m => m.played).length})・FotMob ${all.length} 場(已賽 ${cc.fmFinished})`
        + `・對上 ${cc.matched}・比分一致 ${cc.agree}・不一致 ${cc.disagree.length}${cc.disagree.length >= 16 ? '+' : ''}`);
      for (const d of cc.disagree) console.log(`      ✗ ${d}`);
      console.log(`    輪次對照(SM stage → FotMob roundName):`);
      for (const [k, n] of [...cc.stageMap].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`      ${k} ×${n}`);
      console.log(`    每個 roundName 對應的 round 數字:`);
      for (const [rn, m] of cc.roundNums) console.log(`      ${JSON.stringify(rn)}:${[...m].map(([r, n]) => `${r}×${n}`).join(" ")}`);
      if (cc.unmatched.length) { console.log(`    對不上的 FotMob 場次(前 ${cc.unmatched.length}):`); for (const u of cc.unmatched) console.log(`      ${u}`); }
      for (const p of cc.pens) { console.log(`    PK 場在 FotMob 長這樣:SM「${p.sm}」`); console.log(`      ${JSON.stringify(p.fm)}`); }
      for (const p of cc.aet) { console.log(`    延長場在 FotMob 長這樣:SM「${p.sm}」`); console.log(`      ${JSON.stringify(p.fm)}`); }
      // 隊徽候選:一支本站可能認得的(英超級)、兩支低級別的
      const withId = all.filter(m => m.home?.id != null);
      const big = pick(withId, m => /liverpool|arsenal|chelsea|manchester|tottenham/i.test(m.home?.name ?? '') && !/^afc /i.test(m.home?.name ?? ''));
      if (big && !logoCandidates.some(c => c.id === big.home.id)) logoCandidates.push({ id: big.home.id, name: big.home.name });
      const small = withId.filter(m => !/liverpool|arsenal|chelsea|manchester|tottenham|united|city$/i.test(m.home?.name ?? '')).slice(0, 2);
      for (const m of small) if (logoCandidates.length < 3 && !logoCandidates.some(c => c.id === m.home.id)) logoCandidates.push({ id: m.home.id, name: m.home.name });
    }
  }

  console.log(`\n── 隊徽網址(推測 ${LOGO('{id}')})──`);
  for (const c of logoCandidates.slice(0, 3)) {
    try {
      const res = await get(LOGO(c.id), { json: false, headers: { 'user-agent': BROWSER_UA, referer: 'https://www.fotmob.com/' } });
      const buf = Buffer.from(await res.arrayBuffer());
      const png = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50;
      console.log(`  ${c.name}(id ${c.id}):HTTP ${res.status}・${res.headers.get('content-type')}・${buf.length} bytes・${png ? '是 PNG' : '不是 PNG'}`);
    } catch (e) { console.log(`  ${c.name}(id ${c.id}):✗ ${e.message}`); }
  }
  console.log(`\n✔ 探測結束(${requests}/${MAX_REQUESTS} 個請求)`);
}

main().catch(e => { console.error('✗ 探測失敗:', e.message); process.exitCode = 1; });
