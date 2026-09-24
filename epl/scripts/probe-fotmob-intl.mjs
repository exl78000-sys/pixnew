#!/usr/bin/env node
/* 探測**國家隊比賽**做不做得成:FotMob 的國家隊賽事 id、它們這個窗口有沒有賽程,
 * 以及隊名跟獨立來源(martj42/international_results)對不對得上。
 *
 *   npm run probe:intl
 *
 * ── 為什麼要先問 ──
 * 站上沒有任何國家隊的資料。歷史賽果有一份沙箱就抓得到的獨立來源
 * (github.com/martj42/international_results,raw.githubusercontent.com,1872 年至今四萬九千多場),
 * **但它只收已經踢完的比賽** —— 2026-09-24 實測:0 筆未賽、最新一筆是 2026-08-26。
 * 國際比賽週的**賽程**與**即時比分**只能靠 FotMob,而 FotMob 沙箱連不到,所以要在 runner 上問。
 *
 * 要問的四件事,每一件都要有**證明**,不是「名字看起來像」(德甲那次:奧地利甲也叫 Bundesliga):
 *   1. allLeagues 裡國際賽事那一段有哪些 id、叫什麼(照印,不挑)
 *   2. 候選賽事現在是哪一季、有幾場、**接下來 45 天有幾場**、有沒有積分榜(分組)
 *   3. **用內容證明 id**:已完賽的場次拿去跟 martj42 逐場對(日期 ±1 天 + 兩隊 + 比分)——
 *      id 挑錯的話(CONCACAF 的 Nations League、女足、U21)一場都不會對上
 *   4. 隊名對不上的逐個印出來 —— 那份清單就是要補的 alias 表,不是錯誤報告
 *
 * 唯讀、**最多 16 個請求**(FotMob 14 + martj42 1 + 保留)、不寫任何快取。
 * 掛在 probe-apis.yml 的 latest job **最後一步**(讀結果是抓 log 尾端)。
 */
import { parseCSVObjects } from './lib/csv.mjs';

const FM = 'https://www.fotmob.com';
const MJ = 'https://raw.githubusercontent.com/martj42/international_results/master/results.csv';
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';
const MAX = 16;
const NOW = new Date();
const HORIZON_DAYS = 45;

let used = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = t => console.log(`\n${'─'.repeat(72)}\n▶ ${t}`);

async function get(url, { text = false } = {}) {
  if (used >= MAX) { console.log(`  (已達 ${MAX} 個請求上限,略過 ${url.replace(FM, '')})`); return null; }
  if (used) await sleep(1200);
  used++;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000),
      headers: { accept: text ? 'text/plain' : 'application/json', 'user-agent': UA, referer: `${FM}/` } });
  } catch (e) { console.log(`  [${used}/${MAX}] 連不上:${e.message}`); return null; }
  console.log(`  [${used}/${MAX}] ${url.replace(FM, '').replace(/^https:\/\/raw\.githubusercontent\.com/, 'raw')} → HTTP ${res.status}`);
  if (!res.ok) return null;
  if (text) return res.text();
  let j;
  try { j = await res.json(); } catch { console.log('  ✗ 回的不是 JSON'); return null; }
  // 200 + error 物件是踩過的坑
  if (j?.error) { console.log(`  ✗ 200 但帶 error:${JSON.stringify(j.error).slice(0, 120)}`); return null; }
  return j;
}

/* 國名正規化:大小寫、變音符號、標點、「&」。**不砍 token、不做同義詞** ——
   同義詞(USA / United States、Türkiye / Turkey)正是這支要找出來的清單。 */
const norm = s => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* martj42 的 results.csv:date,home_team,away_team,home_score,away_score,tournament,city,country,neutral。
   **要用真的 CSV 解析**:77 列的城市欄是帶引號的 `"Washington, D.C."`(2026-09-24 實測),
   直接 split(',') 會讓那幾列錯欄 —— 草稿第一版就是這樣寫的,註解還宣稱「全是 9 欄」。 */
function parseMj(text) {
  return parseCSVObjects(text).map(o => ({
    date: o.date, home: o.home_team, away: o.away_team, hs: Number(o.home_score), as: Number(o.away_score),
    t: o.tournament, neutral: o.neutral === 'TRUE',
  })).filter(r => r.date && r.home && r.away);
}

const dayShift = (iso, d) => new Date(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);
const parseScore = s => { const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s ?? '').trim()); return m ? [Number(m[1]), Number(m[2])] : null; };

/* 候選:照名字挑出來「值得問」的那幾個,**但判決靠第 3 節的內容比對**,不靠名字。 */
const WANT = /nations league|friendl|world cup|qualif|^euro\b|european championship|copa am|africa cup|asian cup|gold cup|arab cup|gulf cup|asean|aff /i;
/* 國際賽事那一段也收了歐冠、歐霸、世俱盃這些**俱樂部**賽事,名字會被 world cup / euro 撈到 —— 排掉 */
const NOT = /women|u-?\d{2}\b|youth|olympic|futsal|beach|club|champions league|europa|conference|libertadores|sudamericana|recopa|super ?cup|cup winners/i;
/* 問的順序:這個窗口最可能有比賽的排前面(請求有上限,排後面的可能問不到) */
const PRIORITY = [/nations league/i, /friendl/i, /world cup qual/i, /^world cup$/i, /euro/i];
const prio = name => { const i = PRIORITY.findIndex(re => re.test(name)); return i < 0 ? PRIORITY.length : i; };

async function main() {
  console.log('問的是:國家隊比賽做不做得成(賽程 + 賽果 + 兩個來源對不對得上)。');
  console.log(`基準時間 ${NOW.toISOString()};「接下來」= ${HORIZON_DAYS} 天內。\n`);

  line('0. 獨立來源:martj42/international_results(沙箱也抓得到,這裡再抓一次當比對母體)');
  const mjText = await get(MJ, { text: true });
  const mj = mjText ? parseMj(mjText) : [];
  const mjNames = new Set(mj.flatMap(r => [norm(r.home), norm(r.away)]));
  console.log(`  ${mj.length} 場、${mjNames.size} 個隊名;最新一場 ${mj.at(-1)?.date ?? '—'}`);
  const byDay = new Map();
  for (const r of mj) { const k = r.date; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r); }

  line('1. FotMob allLeagues —— 國際賽事那一段(照印,不挑)');
  const all = await get(`${FM}/api/data/allLeagues`);
  const nodes = [];
  if (all) {
    /* 走整份,記下每個節點落在哪一段(section 名)。國際賽事的 ccode 期望是 INT,
       但**不假設**:section 名與 ccode 一起印出來。 */
    const walk = (v, ctx) => {
      if (Array.isArray(v)) { for (const x of v) walk(x, ctx); return; }
      if (!v || typeof v !== 'object') return;
      const next = { cc: v.ccode ?? v.countryCode ?? ctx.cc, section: (typeof v.name === 'string' && Array.isArray(v.leagues)) ? v.name : ctx.section };
      if (Number.isFinite(v.id) && typeof v.name === 'string' && v.name && !Array.isArray(v.leagues)) nodes.push({ id: v.id, name: v.name, cc: next.cc ?? null, section: next.section ?? null });
      for (const [k, x] of Object.entries(v)) if (k !== 'name') walk(x, next);
    };
    walk(all, { cc: null, section: null });
    console.log(`  頂層鍵:${Object.keys(all).join(', ')}`);
    const intl = nodes.filter(n => n.cc === 'INT' || /international/i.test(n.section ?? ''));
    console.log(`  全部節點 ${nodes.length};ccode=INT 或落在 international 段的 ${intl.length} 個:`);
    for (const n of intl) console.log(`    ${String(n.id).padStart(6)}  ${n.name}  [cc=${n.cc ?? '—'}, section=${n.section ?? '—'}]`);
  } else {
    console.log('  ✗ 拿不到 allLeagues —— 這一輪沒有 id 的答案(不要退回用名字猜)');
  }

  const intl = nodes.filter(n => (n.cc === 'INT' || /international/i.test(n.section ?? '')));
  const cands = [...new Map(intl.filter(n => WANT.test(n.name) && !NOT.test(n.name)).map(n => [n.id, n])).values()]
    .sort((a, b) => prio(a.name) - prio(b.name) || a.id - b.id);
  console.log(`\n  依名字挑出來要細問的 ${cands.length} 個(判決看第 3 節,不看名字):`);
  for (const c of cands) console.log(`    ${c.id} ${c.name}`);

  line(`2. 逐個問現在是哪一季、有幾場、接下來 ${HORIZON_DAYS} 天有幾場`);
  const verdicts = [];
  const unmatchedNames = new Map();
  for (const c of cands.slice(0, 12)) {
    const j = await get(`${FM}/api/data/leagues?id=${c.id}`);
    if (!j) { verdicts.push({ ...c, ok: false, why: '請求失敗' }); continue; }
    const det = j.details ?? {};
    const all = j.fixtures?.allMatches ?? [];
    const seasons = j.allAvailableSeasons ?? det.allAvailableSeasons ?? [];
    const upcoming = all.filter(m => !m.status?.finished && !m.status?.cancelled && m.status?.utcTime
      && Date.parse(m.status.utcTime) >= NOW.getTime() - 3 * 3600000
      && Date.parse(m.status.utcTime) <= NOW.getTime() + HORIZON_DAYS * 86400000);
    const finished = all.filter(m => m.status?.finished);
    const tableKinds = Array.isArray(j.table) ? j.table.map(t => t?.data?.leagueName ?? t?.data?.name ?? '?') : [];
    console.log(`\n  ■ ${c.id} ${det.name ?? c.name}(selectedSeason=${det.selectedSeason ?? '—'};可選季 ${seasons.slice(0, 4).join(' / ') || '—'})`);
    console.log(`    場次 ${all.length}:已完賽 ${finished.length}、接下來 ${HORIZON_DAYS} 天 ${upcoming.length};積分榜 ${Array.isArray(j.table) ? j.table.length + ' 塊' : '無'}${tableKinds.length ? '(' + tableKinds.slice(0, 6).join(' / ') + (tableKinds.length > 6 ? ' …' : '') + ')' : ''}`);
    if (upcoming.length) {
      const ts = upcoming.map(m => m.status.utcTime).sort();
      console.log(`    接下來的範圍 ${ts[0]} → ${ts.at(-1)}`);
      for (const m of upcoming.slice(0, 6)) console.log(`      ${m.status.utcTime}  ${m.home?.name} vs ${m.away?.name}  (round=${m.round ?? '—'} / ${m.roundName ?? '—'})`);
    }
    // 隊物件長什麼樣(只印第一場的鍵,不印整包)
    const any = all[0];
    if (any) console.log(`    隊物件的鍵:${Object.keys(any.home ?? {}).join(', ')};場次的鍵:${Object.keys(any).join(', ')}`);

    /* 3. 內容比對:已完賽的逐場去 martj42 找(日期 ±1 天、兩隊正規化相同、主客可能對調)。
       對上幾場、比分一致幾場、對不上的隊名。 */
    let matched = 0, scoreAgree = 0, swapped = 0;
    const sample = finished.slice(-80);
    for (const m of sample) {
      const d = String(m.status?.utcTime ?? '').slice(0, 10);
      if (!d) continue;
      const H = norm(m.home?.name), A = norm(m.away?.name);
      for (const n of [H, A]) if (n && !mjNames.has(n)) unmatchedNames.set(n, (unmatchedNames.get(n) ?? 0) + 1);
      let hit = null;
      for (const dd of [d, dayShift(d, -1), dayShift(d, 1)]) {
        for (const r of byDay.get(dd) ?? []) {
          if (norm(r.home) === H && norm(r.away) === A) { hit = { r, sw: false }; break; }
          if (norm(r.home) === A && norm(r.away) === H) { hit = { r, sw: true }; break; }
        }
        if (hit) break;
      }
      if (!hit) continue;
      matched++;
      if (hit.sw) swapped++;
      const sc = parseScore(m.status?.scoreStr);
      if (sc && (hit.sw ? (hit.r.hs === sc[1] && hit.r.as === sc[0]) : (hit.r.hs === sc[0] && hit.r.as === sc[1]))) scoreAgree++;
    }
    const tours = new Map();
    // 對上的那幾場在 martj42 叫什麼賽事 —— 這就是 id 的身分證明
    for (const m of sample) {
      const d = String(m.status?.utcTime ?? '').slice(0, 10);
      for (const dd of [d, dayShift(d, -1), dayShift(d, 1)]) for (const r of byDay.get(dd) ?? []) {
        const H = norm(m.home?.name), A = norm(m.away?.name);
        if ((norm(r.home) === H && norm(r.away) === A) || (norm(r.home) === A && norm(r.away) === H)) tours.set(r.t, (tours.get(r.t) ?? 0) + 1);
      }
    }
    console.log(`    跟 martj42 逐場對(最近 ${sample.length} 場已完賽):對上 ${matched}(其中主客對調 ${swapped})、比分一致 ${scoreAgree}`);
    console.log(`    對上的那幾場在 martj42 的賽事名:${[...tours].map(([t, n]) => `${t}×${n}`).join('、') || '—'}`);
    verdicts.push({ ...c, season: det.selectedSeason ?? null, total: all.length, finished: finished.length, upcoming: upcoming.length, matched, scoreAgree, sample: sample.length, tours: [...tours.keys()] });
  }

  line('4. 隊名:FotMob 有、martj42 查不到的(要補的 alias 表,依出現次數)');
  const un = [...unmatchedNames].sort((a, b) => b[1] - a[1]);
  console.log(`  ${un.length} 個:${un.slice(0, 60).map(([n, k]) => `${n}×${k}`).join('、') || '(沒有)'}`);

  line('結論(每一行都要看「對上幾場」,不是看名字)');
  for (const v of verdicts) {
    console.log(`  ${String(v.id).padStart(6)} ${v.name.padEnd(36)} 季 ${v.season ?? '—'}  共 ${v.total ?? 0}、接下來 ${v.upcoming ?? 0}、`
      + `對上 ${v.matched ?? 0}/${v.sample ?? 0}(比分一致 ${v.scoreAgree ?? 0})  martj42 賽事:${(v.tours ?? []).join(' / ') || '—'}${v.ok === false ? '  ✗ ' + v.why : ''}`);
  }
  console.log(`\n  共用 ${used} 個請求(上限 ${MAX})。`);
}

main().catch(e => { console.log(`✗ 探測中斷:${e.stack ?? e.message}`); process.exitCode = 0; });
