#!/usr/bin/env node
/* 探測:FotMob 有沒有那 11 支歐冠球隊所屬的聯賽?隊名對不對得上?
 *
 * 為什麼要探:階段 C 的跨聯賽 Elo 現在涵蓋 25/36 隊,本季 76 場沒有預測,
 * 因為那些球隊的聯賽 **openfootball 沒有**(tr/be/at/no/ua/sk/cz/gr/az 全部 404,逐一試過)。
 * 但「openfootball 沒有」不等於「拿不到」—— 這是鐵則三那條坑,本站踩過。
 *
 * **這支只讀不寫。** 不落盤任何快取,只把量到的東西印出來。
 *
 * 要回答的**兩個**問題,第二個才是難的:
 *   1. FotMob 有沒有這些聯賽?(端點通不通)
 *   2. **隊名對不對得上?** football-data 給的是 `FK Shakhtar Donetsk`、`ŠK Slovan Bratislava`
 *      這種正式全名,FotMob 多半寫 `Shakhtar`、`Slovan Bratislava`。對不上的話,
 *      有聯賽也接不起來 —— 而這正是 CLAUDE.md「兩份名單對照只比全名會整隊漏掉」那條。
 *
 * 所以輸出分三層:精確命中、**近似命中(要人看過才算)**、完全沒有。
 * 近似的那一份**不是裝飾** —— 本站兩次對錯球隊都是靠它抓到的(AFC Liverpool、Bournemouth FC)。
 *
 * 請求數:1(allLeagues)+ 每個國家 1 個聯賽 × 1 季 ≤ 17。使用者要求不要大量爬。
 *
 *   npm run probe:ucl-coverage
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (compatible; epl-warroom/1.0; +https://github.com/exl78000-sys/pixnew)';
const BASE = 'https://www.fotmob.com';

/* 要找的國家。每一個都是「歐冠有球隊、而 openfootball 沒有那個聯賽」——
   球隊名字寫在後面只是為了讓 log 看得懂是為誰找的。 */
const WANTED = [
  ['BEL', '比利時', 'Club Brugge / Union SG'], ['NOR', '挪威', 'Bodø/Glimt'],
  ['TUR', '土耳其', 'Galatasaray'],            ['SCO', '蘇格蘭', 'Celtic'],
  ['GRE', '希臘', 'Olympiakos / AEK'],         ['AZE', '亞塞拜然', 'Qarabağ'],
  ['SRB', '塞爾維亞', 'Crvena Zvezda'],        ['CRO', '克羅埃西亞', 'Dinamo Zagreb'],
  ['KAZ', '哈薩克', 'Kairat'],                 ['DEN', '丹麥', 'København'],
  ['CYP', '賽普勒斯', 'Paphos'],               ['AUT', '奧地利', 'Salzburg / Sturm / LASK'],
  ['UKR', '烏克蘭', 'Shakhtar'],               ['SVK', '斯洛伐克', 'Slovan Bratislava'],
  ['CZE', '捷克', 'Slavia / Sparta Praha'],    ['SUI', '瑞士', 'Young Boys'],
];

const get = async url => {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000),
    headers: { accept: 'application/json', 'user-agent': UA, referer: `${BASE}/` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  // API 回 200 加一個 error 物件 —— 只看 res.ok 會把失敗當成功(本站踩過)
  if (j?.error) throw new Error(`200 但帶 error:${String(j.error).slice(0, 80)}`);
  return j;
};

/* 正規化只做到「大小寫、變音符號、標點」為止。
   **不去字首的 AFC、不砍 FC/FK/SK 之外的 token** —— 砍過頭就會對錯球隊,
   本站在盃賽頁踩過兩次。這裡寧可報「近似」讓人看,也不自動採用。 */
const norm = s => String(s ?? '')
  .replace(/[Đ]/g, 'Dj').replace(/[Øø]/g, 'o').replace(/[Łł]/g, 'l').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// 法人形式的字尾/字首前綴:比對時當可選,但**只用來判斷「近似」**,不當精確
const STRIP = /^(fc|fk|sk|sc|ac|as|ss|nk|hnk|pae|pfc|cf|kv|rb)\s+|\s+(fc|fk|sk|sc|ac|cf|kv|sad|ad)$/g;
const loose = s => norm(s).replace(STRIP, '').replace(STRIP, '').trim();

async function main() {
  console.log('探測:FotMob 有沒有那些歐冠球隊的聯賽,以及隊名對不對得上\n');

  // 要對照的名單:ucl-elo.json 記著誰沒有評分,ucl.json 記著他們的 fullName
  const eloPath = join(ROOT, 'web', 'data', 'ucl-elo.json');
  const uclPath = join(ROOT, 'web', 'data', 'ucl.json');
  if (!existsSync(eloPath) || !existsSync(uclPath)) {
    console.log('✗ 需要 web/data/ucl-elo.json 與 ucl.json(先跑 npm run build)');
    return;
  }
  const unrated = JSON.parse(readFileSync(eloPath, 'utf8')).coverage.unrated;
  const ucl = JSON.parse(readFileSync(uclPath, 'utf8'));
  const fullOf = new Map();
  const walk = v => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    if (v.id != null && typeof v.fullName === 'string' && v.fullName) fullOf.set(v.name ?? v.fullName, v.fullName);
    Object.values(v).forEach(walk);
  };
  walk(ucl.seasons ?? []);
  const targets = unrated.map(u => ({ name: u.name, full: fullOf.get(u.name) ?? u.name, n: u.n }));
  console.log(`要找的球隊:${targets.length} 支(牽涉 ${targets.reduce((s, t) => s + t.n, 0)} 場)\n`);

  let reqs = 0;
  console.log('── 一、FotMob 有哪些聯賽 ──');
  let all;
  try { all = await get(`${BASE}/api/data/allLeagues`); reqs++; }
  catch (e) { console.log(`✗ allLeagues 拿不到:${e.message}`); return; }

  /* 不要憑印象斷言這份 JSON 長什麼樣 —— 走整份收「有 id 有 name」的節點,
     順便把 ccode 帶出來。結構變了也還是找得到。 */
  const leagues = [];
  const walkL = (v, cc) => {
    if (Array.isArray(v)) { for (const x of v) walkL(x, cc); return; }
    if (!v || typeof v !== 'object') return;
    const nextCc = v.ccode ?? v.countryCode ?? v.ccode3 ?? cc;
    if (Number.isFinite(v.id) && typeof v.name === 'string' && v.name) leagues.push({ id: v.id, name: v.name, cc: nextCc ?? null });
    for (const x of Object.values(v)) walkL(x, nextCc);
  };
  walkL(all, null);
  console.log(`  allLeagues 收到 ${leagues.length} 筆有 id 的項目`);
  const ccs = [...new Set(leagues.map(l => l.cc).filter(Boolean))];
  console.log(`  出現過的國家代碼 ${ccs.length} 個,樣本:${ccs.slice(0, 12).join(' ')}\n`);

  console.log('── 二、逐國找頂級聯賽,抓一季看隊名 ──');
  const found = new Map();          // 正規化隊名 → { league, raw }
  for (const [cc, zh, who] of WANTED) {
    const cands = leagues.filter(l => String(l.cc).toUpperCase() === cc);
    if (!cands.length) { console.log(`  ${zh}(${cc}):allLeagues 裡找不到這個國家 —— 為了 ${who}`); continue; }
    /* 頂級聯賽挑哪一個:名單裡通常第一個就是。不猜 —— 把候選印出來,
       挑第一個去抓,並且把實際抓到的聯賽名印出來讓人核對。 */
    const pick = cands[0];
    let j;
    try { j = await get(`${BASE}/api/data/leagues?id=${pick.id}&ccode3=${cc}`); reqs++; }
    catch (e) { console.log(`  ${zh}(${cc}):${pick.name} id=${pick.id} → ✗ ${e.message}`); continue; }
    const ms = j.fixtures?.allMatches ?? [];
    const done = ms.filter(m => m.status?.finished === true).length;
    const names = [...new Set(ms.flatMap(m => [m.home?.name, m.away?.name]).filter(Boolean))];
    console.log(`  ${zh}(${cc}):${pick.name} id=${pick.id} → ${ms.length} 場・已完賽 ${done}・${names.length} 隊`
      + (cands.length > 1 ? `(另有 ${cands.length - 1} 個候選:${cands.slice(1, 4).map(c => c.name).join('、')})` : ''));
    for (const n of names) {
      if (!found.has(norm(n))) found.set(norm(n), { league: `${zh}/${pick.name}`, raw: n });
      const l = loose(n);
      if (l && !found.has(`~${l}`)) found.set(`~${l}`, { league: `${zh}/${pick.name}`, raw: n });
    }
  }

  console.log(`\n── 三、對照結果(這一節才是重點)──`);
  const exact = [], near = [], miss = [];
  for (const t of targets) {
    const hitFull = found.get(norm(t.full)), hitName = found.get(norm(t.name));
    if (hitFull || hitName) { exact.push({ t, hit: hitFull ?? hitName, via: hitFull ? 'fullName' : 'name' }); continue; }
    const l1 = found.get(`~${loose(t.full)}`), l2 = found.get(`~${loose(t.name)}`);
    if (l1 || l2) { near.push({ t, hit: l1 ?? l2 }); continue; }
    miss.push(t);
  }
  console.log(`\n精確命中 ${exact.length} 支:`);
  for (const e of exact) console.log(`  ✔ ${e.t.name}(${e.t.n} 場)← ${e.hit.raw}  [${e.hit.league}] via ${e.via}`);
  console.log(`\n近似命中 ${near.length} 支 —— **要人逐筆看過才算數**,不可以自動採用:`);
  for (const e of near) console.log(`  ? ${e.t.full}(${e.t.n} 場)← ${e.hit.raw}  [${e.hit.league}]`);
  console.log(`\n完全找不到 ${miss.length} 支:`);
  for (const t of miss) console.log(`  ✗ ${t.full}(${t.n} 場)`);

  const gain = exact.reduce((s, e) => s + e.t.n, 0), maybe = near.reduce((s, e) => s + e.t.n, 0);
  console.log(`\n── 結論 ──`);
  console.log(`  發了 ${reqs} 個請求`);
  console.log(`  精確命中可救回 ${gain} 場、近似再多 ${maybe} 場(近似要人核過)`);
  console.log(`  完全拿不到 ${miss.reduce((s, t) => s + t.n, 0)} 場`);
}

main().catch(e => { console.error('探測失敗:', e.message); process.exitCode = 1; });
