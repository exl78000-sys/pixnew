#!/usr/bin/env node
/* Obsidian vault 的內容檢查(2026-09-26)。

   產生器自己有兩道守門(同檔名、壞連結),但那兩道只看「形狀」:一則筆記印著過期的宣稱、
   或者少了一整區資料,它都照樣放行。這一輪實際找到的就是這兩種 ——
   - **少了一整區**:國家隊那一頁 9/24 就上線,vault 一直沒有它;
   - **過期的宣稱**:歐冠筆記寫「不做勝率預測」(站上 126 場有賽前勝率)、盃賽筆記寫「來源:SportMonks」
     (9/13 起是 FotMob)、同名球員一律寫「沒有共用 id,無法核對」(德義法接上之後有一百多組是同一個 Understat id)。
   所以這一支**真的把 vault 產一次**,逐則拿筆記跟產物對:筆記裡講的,要跟產物說的是同一件事。

   產到自己的暫存目錄(不動使用者真正在用的那一份,他可能正開著 Obsidian),跑完就刪。 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
};
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const product = (lg, name) => {
  const p = lg === 'pl' ? join(ROOT, 'web', 'data', `${name}.json`) : join(ROOT, 'web', 'data', 'leagues', lg, `${name}.json`);
  return existsSync(p) ? read(p) : null;
};
const arr = x => (Array.isArray(x) ? x : Object.values(x ?? {}));
// 跟產生器同一條檔名規則(那一條是 Obsidian 的限制,不是本站的邏輯)
const sanitize = s => String(s).replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();

const OUT = mkdtempSync(join(tmpdir(), 'epl-vault-check-'));
const gen = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-obsidian.mjs'), `--out=${OUT}`], { encoding: 'utf8' });
/* 找不到回空字串,不回 null —— 少一則筆記要讓**對應的那一條**紅,不是讓整支在 .includes 上炸掉(炸掉的話後面每一條都不會跑) */
const note = rel => { const p = join(OUT, rel); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
const list = rel => (existsSync(join(OUT, rel)) ? readdirSync(join(OUT, rel)).filter(f => f.endsWith('.md')) : []);
/* frontmatter 的單一欄位(產生器寫的是一行一個 key: value,陣列另起縮排 —— 這裡只讀純量) */
const fm = (text, key) => {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text ?? '')?.[1] ?? '';
  const line = head.split('\n').find(l => l.startsWith(key + ': '));
  return line == null ? undefined : line.slice(key.length + 2).replace(/^"(.*)"$/, '$1');
};

console.log('\n▶ Obsidian vault:產生器跑得完');
check('產生器結束碼是 0(兩道守門都過)', gen.status === 0, gen.status === 0 ? '' : (gen.stderr || gen.stdout).slice(-400).replace(/\s*\n\s*/g, ' ⏎ '));

// ── 國家隊 ─────────────────────────────────────────
console.log('\n▶ Obsidian vault:國家隊(intl.json / intl-teams.json / intl-flags.json)');
const I = product('pl', 'intl');
const FL = product('pl', 'intl-flags');
if (!I) {
  console.log('  (沒有 intl.json,這一節略過)');
} else {
  const zhOf = k => I.teams?.[k]?.zh ?? k;
  const sideName = t => (t?.key ? zhOf(t.key) : t?.tbd ? (t.label ?? t.name) : t?.name ?? '待定');
  const compZh = key => (I.comps ?? []).find(c => c.key === key)?.zh ?? key;
  const matchRel = x => `國家隊/比賽/${sanitize(`${compZh(x.comp)} ${String(x.kickoff).slice(0, 10)} ${sideName(x.home)}-${sideName(x.away)}`)}.md`;
  const teamKeys = Object.keys(I.teams ?? {});

  check('有國家隊首頁', note('國家隊/國家隊.md') !== '');
  check('每個賽事一則', list('國家隊/賽事').length === (I.comps ?? []).length, `${list('國家隊/賽事').length} / ${(I.comps ?? []).length}`);
  const teamFiles = new Set(list('國家隊/球隊'));
  const missingTeams = teamKeys.filter(k => !teamFiles.has(sanitize(zhOf(k)) + '.md'));
  check('產物裡的每一隊都有一則球隊筆記(檔名是中文名)', missingTeams.length === 0 && teamFiles.size === teamKeys.length,
    missingTeams.length ? `少了 ${missingTeams.slice(0, 5).join('、')}` : `${teamFiles.size} 隊`);
  const all = [...(I.fixtures ?? []), ...(I.results ?? [])];
  const missingMatches = all.filter(x => note(matchRel(x)) === '');
  check('每一場(未賽 + 賽果)都有一則比賽筆記', missingMatches.length === 0 && list('國家隊/比賽').length === all.length,
    `${list('國家隊/比賽').length} / ${all.length}${missingMatches.length ? `,少了 ${missingMatches.slice(0, 3).map(matchRel).join('、')}` : ''}`);

  /* 勝率只給未賽的場次,而且數字就是產物那一個 —— 已完賽的產物本來就不帶,筆記也不准有(賽後重算冒充賽前是鐵則) */
  const probBad = (I.fixtures ?? []).filter(f => {
    const t = note(matchRel(f));
    return f.prob ? fm(t, '主勝率') !== String(f.prob[0]) || !t.includes('## 賽前勝率') : fm(t, '主勝率') !== undefined;
  });
  check('未賽的勝率就是產物那一個;沒有勝率的場次筆記也沒有', probBad.length === 0, probBad.slice(0, 3).map(matchRel).join('、'));
  const resultWithProb = (I.results ?? []).filter(r => fm(note(matchRel(r)), '主勝率') !== undefined || /\| 主勝 \| 和 \| 客勝 \|/.test(note(matchRel(r)) ?? ''));
  check('已完賽的場次沒有勝率', resultWithProb.length === 0, resultWithProb.slice(0, 3).map(matchRel).join('、'));

  /* 不確定性要寫在筆記上(鐵則四):評分落後、中立場是推論 */
  const lagBad = (I.fixtures ?? []).filter(f => f.prob && Math.max(0, ...(f.lag ?? []).map(n => n ?? 0)) > 0)
    .filter(f => !note(matchRel(f)).includes(`評分未含最近 ${Math.max(0, ...f.lag.map(n => n ?? 0))} 場`));
  check('評分落後的場次講出「評分未含最近 N 場」', lagBad.length === 0, lagBad.slice(0, 3).map(matchRel).join('、'));
  const venueBad = (I.fixtures ?? []).filter(f => f.prob && f.venue && !/中立場的機率 \d+%\(\*\*推論\*\*/.test(note(matchRel(f))));
  check('用了中立場推論的場次標成推論', venueBad.length === 0, venueBad.slice(0, 3).map(matchRel).join('、'));

  /* 核對判決照產物,「待核對」「獨立來源沒收」「不一致」是三件事 */
  const LABEL = { agree: '已核對', mismatch: '不一致', awarded: '判決比分', notYet: '待核對', unmatched: '獨立來源沒收' };
  const checkBad = (I.results ?? []).filter(r => fm(note(matchRel(r)), '核對') !== (LABEL[r.check] ?? '隊名未對上'));
  check('每一場賽果的核對判決照產物', checkBad.length === 0, checkBad.slice(0, 3).map(matchRel).join('、'));
  const mismatchBad = (I.results ?? []).filter(r => r.check === 'mismatch' && !note(matchRel(r)).includes(`martj42 記 ${(r.other ?? []).join('-')}`));
  check('不一致的場次把另一個來源的比分印出來', mismatchBad.length === 0, mismatchBad.slice(0, 3).map(matchRel).join('、'));

  /* 國旗:有的嵌進去而且圖檔在,沒有的講為什麼(屬地用宗主國旗、中華台北在產物那一層就排掉了) */
  const flagKeys = Object.keys(FL?.flags ?? {});
  const flagBad = teamKeys.filter(k => {
    const t = note(`國家隊/球隊/${sanitize(zhOf(k))}.md`) ?? '';
    return flagKeys.includes(k)
      ? !t.includes(`![[國旗 ${sanitize(k)}.png|`) || !existsSync(join(OUT, '_資產', '國旗', `國旗 ${sanitize(k)}.png`))
      : !t.includes('- 沒有國旗:');
  });
  check('有國旗的隊嵌了圖、沒有的講出原因', flagBad.length === 0, flagBad.slice(0, 5).join('、'));
  const sameAs = (I.flags?.sameAs ?? []).map(x => x.key).filter(k => teamKeys.includes(k));
  check('屬地用宗主國旗的那幾隊沒有被掛上國旗', sameAs.every(k => !(note(`國家隊/球隊/${sanitize(zhOf(k))}.md`) ?? '').includes('![[國旗')),
    sameAs.join('、'));

  /* 積分榜跟上游不是同一批的那幾組,要講出差在哪(不然讀者看到一張自己跟賽程矛盾的表) */
  const odd = (I.standings ?? []).flatMap(st => st.groups.filter(g => g.status !== 'ok').map(g => ({ st, g })));
  const oddBad = odd.filter(({ st, g }) => {
    const t = note(`國家隊/賽事/${sanitize(compZh(st.comp))}.md`) ?? '';
    return !t.includes(`### ${g.zh ?? g.name}`) || !/上游的積分榜|跟上游對不上/.test(t);
  });
  check('跟上游不是同一批的分組講出差在哪', oddBad.length === 0, `${odd.length} 組${oddBad.length ? `,沒講的:${oddBad.map(x => x.g.zh).join('、')}` : ''}`);

  const moc = note('國家隊/國家隊.md') ?? '';
  check('首頁的排名列出產物裡的每一隊', (I.ranking ?? []).every(r => moc.includes(`| ${r.rank} | [[${sanitize(zhOf(r.key))}]] | ${r.rating} |`)),
    `${(I.ranking ?? []).length} 隊`);
}

// ── 過期的宣稱 ──────────────────────────────────────
console.log('\n▶ Obsidian vault:筆記裡的宣稱跟得上產物');
{
  const elo = product('pl', 'ucl-elo');
  const ucl = product('pl', 'ucl');
  const predN = elo?.model?.passes ? (elo.fixtures ?? []).length : 0;
  const uclNotes = [...list('歐冠/比賽').map(f => `歐冠/比賽/${f}`), ...list('歐冠/賽季').map(f => `歐冠/賽季/${f}`), '歐冠/歐冠.md'];
  const denies = uclNotes.filter(f => /不做勝率預測/.test(note(f) ?? ''));
  /* 回測沒通過時 fixtures 是空的,那句否定才准出現 —— 那時它是真的 */
  check('歐冠有賽前勝率時,沒有一則歐冠筆記還在說「不做勝率預測」', predN === 0 || denies.length === 0,
    predN ? `本季 ${predN} 場有勝率${denies.length ? `,仍在否認的 ${denies.length} 則,例如 ${denies[0]}` : ''}` : '這一次沒有勝率,否定句是真的');
  if (ucl && elo) {
    const byId = new Map((elo.fixtures ?? []).map(f => [f.id, f.p]));
    const cur = (ucl.seasons ?? []).find(s => s.current);
    const withPred = (cur?.leagueMatches ?? []).filter(m => !m.played && byId.has(m.id));
    const uclRel = m => `歐冠/比賽/${sanitize('歐冠 ' + cur.label + ' MD' + String(m.matchday ?? 0).padStart(2, '0') + ' ' + (m.home?.name ?? '?') + '-' + (m.away?.name ?? '?'))}.md`;
    const bad = withPred.filter(m => fm(note(uclRel(m)), '主勝率') !== String(byId.get(m.id)[0]));
    check('歐冠未賽而且有勝率的每一場,筆記裡的勝率就是產物那一個', bad.length === 0, `${withPred.length} 場${bad.length ? `,對不上 ${bad.length}` : ''}`);
    const playedWithProb = (cur?.leagueMatches ?? []).filter(m => m.played && fm(note(uclRel(m)), '主勝率') !== undefined);
    check('歐冠已完賽的場次沒有勝率', playedWithProb.length === 0, playedWithProb.slice(0, 3).map(uclRel).join('、'));
  }
  const ext = list('歐冠/球隊').filter(f => /只收目前在英超與西甲/.test(note(`歐冠/球隊/${f}`)));
  check('歐冠外部球隊的筆記不再說「本站只收英超與西甲」', ext.length === 0, ext.slice(0, 3).join('、'));

  const cups = product('pl', 'cups');
  const cupNotes = list('英格蘭盃賽/比賽');
  const wrongSrc = cupNotes.filter(f => {
    const t = note(`英格蘭盃賽/比賽/${f}`) ?? '';
    return /來源:SportMonks/.test(t) || (cups?.source && !t.includes(`- 來源:${cups.source}`));
  });
  check('盃賽比賽筆記的來源是產物說的那一個(不是寫死的 SportMonks)', cupNotes.length > 0 && wrongSrc.length === 0,
    `${cupNotes.length} 則・產物說 ${cups?.source}${wrongSrc.length ? `,不對的 ${wrongSrc.length} 則` : ''}`);
  /* 冠軍的形狀換過(FotMob 那一版是 { team: { name } }),讀舊欄位的話那一行整個不見,不拋錯 */
  const champs = (cups?.cups ?? []).flatMap(c => (c.seasons ?? []).map(s => ({ c, s, name: s.champion?.team?.name ?? s.champion?.name })))
    .filter(x => x.name);
  const champBad = champs.filter(x => !note(`英格蘭盃賽/${sanitize(x.c.zh)}.md`).includes(`冠軍:**${x.name}**`));
  check('盃賽每一季的冠軍寫在賽事筆記上', champBad.length === 0,
    `${champs.length} 季有冠軍${champBad.length ? `,沒寫的:${champBad.map(x => `${x.c.zh} ${x.s.label}`).join('、')}` : ''}`);
}

// ── 盃賽與歐冠的賽後報告 ────────────────────────────
console.log('\n▶ Obsidian vault:盃賽與歐冠的賽後報告(cup-details / ucl-details)');
{
  /* 用 frontmatter 的比賽 id 把筆記找回來 —— 檔名是日期與隊名拼的,這裡再拼一次就是抄一份產生器 */
  const byId = new Map();
  for (const f of list('英格蘭盃賽/比賽')) { const t = note(`英格蘭盃賽/比賽/${f}`); const id = fm(t, 'FotMob比賽id'); if (id) byId.set('cup:' + id, t); }
  for (const f of list('歐冠/比賽')) { const t = note(`歐冠/比賽/${f}`); const id = fm(t, 'footballData比賽id'); if (id) byId.set('ucl:' + id, t); }
  const CD = product('pl', 'cup-details'), UD = product('pl', 'ucl-details');
  const reps = [
    ...Object.entries(CD?.reports ?? {}).map(([id, x]) => ({ k: 'cup:' + id, id, idx: x, rel: `cup-details/${x.cup}/${x.season}/${id}` })),
    ...Object.entries(UD?.reports ?? {}).map(([id, x]) => ({ k: 'ucl:' + id, id, idx: x, rel: `ucl-details/${x.season}/${id}` })),
  ];
  const nCup = reps.filter(r => r.k.startsWith('cup:')).length, nUcl = reps.length - nCup;
  /* 要比對**真的報告的標題**:沒有報告的場次也有一節「## 賽後報告」(講為什麼沒有),只找那四個字的話,
     報告整份不見也會過(負向對照 r9 抓到的) */
  const missing = reps.filter(r => !(byId.get(r.k) ?? '').includes('## 賽後報告(FotMob 逐場詳情)'));
  check('產物裡有報告的每一場(盃賽 + 歐冠),比賽筆記裡都有賽後報告', nCup > 0 && nUcl > 0 && missing.length === 0,
    `盃賽 ${nCup}・歐冠 ${nUcl}${missing.length ? `;沒有的 ${missing.length}:${missing.slice(0, 3).map(r => r.k).join('、')}` : ''}`);

  /* xG:射門圖完整才有,數字就是產物那一個 */
  const xgBad = reps.filter(r => {
    const t = byId.get(r.k) ?? '';
    return r.idx.xG && r.idx.shotmapComplete !== false
      ? fm(t, '主隊xG') !== String(r.idx.xG[0]) || fm(t, '客隊xG') !== String(r.idx.xG[1])
      : fm(t, '主隊xG') !== undefined;
  });
  check('報告的 xG 就是產物那一個;射門圖不完整的場次沒有 xG', xgBad.length === 0, xgBad.slice(0, 3).map(r => r.k).join('、'));

  /* PK 大戰的十二碼不算射門:射門表的次數 = 逐場檔扣掉互射(規則是 lib/matchstats.mjs 那一支,不另寫) */
  const { isShootoutShot } = await import('./lib/matchstats.mjs');
  let withShootout = 0;
  const shotBad = reps.filter(r => {
    const rep = read(join(ROOT, 'web', 'data', r.rel + '.json'));
    const all = rep.advanced?.shots ?? [];
    const n = all.filter(s => !isShootoutShot(s, { pens: rep.advanced?.pens === true })).length;
    if (n < all.length) withShootout++;
    const got = /### 射門\((\d+) 次/.exec(byId.get(r.k) ?? '')?.[1];
    return n ? Number(got) !== n : got !== undefined;
  });
  check('射門表的次數 = 逐場檔的射門扣掉 PK 大戰', shotBad.length === 0,
    `有互射的 ${withShootout} 場${shotBad.length ? `;對不上 ${shotBad.length}:${shotBad.slice(0, 3).map(r => r.k).join('、')}` : ''}`);

  /* 盃賽的比分核對是同一家供應商的一致性檢查 —— 產物說不是獨立來源,筆記就要講 */
  const indepBad = CD?.scoreCheck?.independent === false
    ? reps.filter(r => r.k.startsWith('cup:') && !(byId.get(r.k) ?? '').includes('比分核對不是獨立來源')) : [];
  check('盃賽報告講出「比分核對不是獨立來源」', indepBad.length === 0, indepBad.slice(0, 3).map(r => r.k).join('、'));

  /* 上游缺的那幾塊要講出來,不畫空表 */
  const partialBad = reps.filter(r => {
    const rep = read(join(ROOT, 'web', 'data', r.rel + '.json'));
    return (rep.partial ?? []).length && !(byId.get(r.k) ?? '').includes('上游這一場沒有');
  });
  check('上游缺逐人統計的場次講出來', partialBad.length === 0, partialBad.slice(0, 3).map(r => r.k).join('、'));

  /* 被拒收的場次講出產物記的理由(不然讀者看到踢完的比賽沒有報告而筆記不解釋) */
  const rej = (CD?.rejected ?? []).map(x => ({ id: String(x.key ?? '').split('|').pop(), reason: x.reason }));
  const rejBad = rej.filter(x => !(byId.get('cup:' + x.id) ?? '').includes(x.reason));
  check('被拒收的盃賽場次講出產物記的理由', rejBad.length === 0, `${rej.length} 場${rejBad.length ? `,沒講的 ${rejBad.map(x => x.id).join('、')}` : ''}`);
}

// ── 聯賽的賽後報告(本季 + 上季)────────────────────
console.log('\n▶ Obsidian vault:聯賽的賽後報告(本季的索引 + 上季的逐場檔)');
const LEAGUE_DIRS = [['pl', '英超'], ['es1', '西甲'], ['en2', '英冠'], ['de1', '德甲'], ['it1', '義甲'], ['fr1', '法甲']];
const dataDirOf = lg => (lg === 'pl' ? join(ROOT, 'web', 'data') : join(ROOT, 'web', 'data', 'leagues', lg));
{
  /* 產物這一側**不用** lib 的讀法(readArchivedReports)—— 要驗的就是產生器有沒有把它讀對,
     拿同一支去對等於自己對自己。這裡直接從 reports.json 的索引與 archive.ids 走逐場檔。 */
  const want = [];        // { lg, zh, key, rep }
  for (const [lg, zh] of LEAGUE_DIRS) {
    const dir = dataDirOf(lg);
    const idx = existsSync(join(dir, 'reports.json')) ? read(join(dir, 'reports.json')) : null;
    if (!idx) continue;
    for (const [key, id] of Object.entries(idx.index ?? {})) {
      const p = join(dir, 'match-reports', key.split('|')[0], `${id}.json`);
      if (existsSync(p)) want.push({ lg, zh, key, rep: read(p), last: false });
    }
    for (const id of idx.archive?.ids ?? []) {
      const p = join(dir, 'match-reports', idx.archive.season, `${id}.json`);
      if (!existsSync(p)) continue;
      const rep = read(p);
      want.push({ lg, zh, key: `${rep.season}|${rep.home}|${rep.away}`, rep, last: true });
    }
  }
  /* 往季的讀法(lib/match-archive.mjs 的 readArchivedReports)拿捏造的目錄單獨驗:它的規則在真資料裡碰不到
     (目前 0 份撞鍵、0 份缺檔),只驗「真資料讀得出來」的話,撞鍵時挑一個用的寫法也是綠的 */
  {
    const { readArchivedReports } = await import('./lib/match-archive.mjs');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const D = mkdtempSync(join(tmpdir(), 'epl-archive-check-'));
    mkdirSync(join(D, 'match-reports', '2025-26'), { recursive: true });
    writeFileSync(join(D, 'reports.json'), JSON.stringify({ index: {}, archive: { season: '2025-26', count: 5, ids: ['a', 'b', 'c', 'd', 'e'] } }));
    const put = (id, r) => writeFileSync(join(D, 'match-reports', '2025-26', id + '.json'), JSON.stringify(r));
    put('a', { season: '2025-26', home: 'AAA', away: 'BBB', mark: 'a' });
    put('b', { season: '2025-26', home: 'CCC', away: 'DDD', mark: 'b' });   // 跟 c 撞鍵(附加賽那一種)
    put('c', { season: '2025-26', home: 'CCC', away: 'DDD', mark: 'c' });
    put('d', { season: '2024-25', home: 'EEE', away: 'FFF', mark: 'd' });   // 季跟索引宣告的不同
    // e:索引有、檔案沒有
    const got = readArchivedReports(D);
    rmSync(D, { recursive: true, force: true });
    check('往季報告的讀法:撞鍵的兩份都不用、季不對的不用、缺檔的記下來',
      Object.keys(got.reports).join(',') === '2025-26|AAA|BBB' && got.reports['2025-26|AAA|BBB'].mark === 'a'
        && [...got.conflicts].sort().join(',') === 'b,c,d' && got.missing.join(',') === 'e',
      `鍵 ${Object.keys(got.reports).join('、') || '(無)'}・撞鍵/季不對 ${[...got.conflicts].sort().join('、') || '(無)'}・缺檔 ${got.missing.join('、') || '(無)'}`);
  }
  /* 筆記這一側:用 frontmatter 的 賽季 / 主隊 / 客隊 找回來(檔名是輪次拼的,再拼一次就是抄一份產生器) */
  const noteOf = new Map();
  const flagged = [];
  for (const [, zh] of LEAGUE_DIRS) {
    for (const f of list(`${zh}/比賽`)) {
      const t = note(`${zh}/比賽/${f}`);
      const k = `${zh}|${fm(t, '賽季')}|${fm(t, '主隊')}|${fm(t, '客隊')}`;
      noteOf.set(k, t);
      if (fm(t, '賽後報告') === 'true') flagged.push(k);
    }
  }
  const lastN = want.filter(w => w.last).length;
  const miss = want.filter(w => { const t = noteOf.get(`${w.zh}|${w.key}`) ?? ''; return fm(t, '賽後報告') !== 'true' || !t.includes('\n## 賽後報告\n'); });
  check('產物裡的每一份聯賽賽後報告(本季 + 上季)都進了那一場的比賽筆記', lastN > 0 && miss.length === 0,
    `本季 ${want.length - lastN}・上季 ${lastN}${miss.length ? `;沒進的 ${miss.length}:${miss.slice(0, 3).map(w => w.zh + ' ' + w.key).join('、')}` : ''}`);
  const wantKeys = new Set(want.map(w => `${w.zh}|${w.key}`));
  const extra = flagged.filter(k => !wantKeys.has(k));
  check('沒有報告的場次不會標成有報告', extra.length === 0, extra.slice(0, 3).join('、'));

  /* 內容是**那一場的**報告:兩隊的陣型、教練、戰術解讀每一句都在(掛錯場的話這幾樣一定對不上) */
  const contentBad = want.filter(w => {
    const t = noteOf.get(`${w.zh}|${w.key}`) ?? '';
    const sec = t.split('\n## 賽後報告\n')[1]?.split('\n## ')[0] ?? '';
    const S = [w.rep.sides?.[w.rep.home], w.rep.sides?.[w.rep.away]];
    return S.some(s => (s?.shape?.label && s.shape.label !== '—' && !sec.includes(' ' + s.shape.label)) || (s?.coach && !sec.includes('教練 ' + s.coach)))
      || (w.rep.notes ?? []).some(n => n?.text && !sec.includes(n.text));
  });
  check('報告的內容是那一場的:兩隊陣型、教練與戰術解讀每一句都在', contentBad.length === 0,
    contentBad.slice(0, 3).map(w => w.zh + ' ' + w.key).join('、'));

  /* 本場最佳:有評分就是那一場逐人評分的最高分(站上同一套);沒有才是 FPL 表現分 */
  const bestBad = want.filter(w => {
    const d = w.rep.advanced;
    const rated = d?.coverage?.ratings === true && Object.values(d.players ?? {}).some(l => l?.some(p => p.rating != null));
    const sec = (noteOf.get(`${w.zh}|${w.key}`) ?? '').split('### 本場最佳')[1]?.split('\n### ')[0] ?? '';
    if (!rated) return false;
    const top = Math.max(...Object.values(d.players ?? {}).flat().filter(p => p.rating != null && (p.minutes ?? 0) > 0).map(p => p.rating));
    return !sec.includes(' ' + top.toFixed(1));
  });
  check('本場最佳的最高分就是那一場逐人評分的最高分', bestBad.length === 0, bestBad.slice(0, 3).map(w => w.zh + ' ' + w.key).join('、'));

  /* 兩種 xG 要講得出是哪一種:英超本季的報告走 FPL(xG 是逐人加總),跟下一節 FotMob 的球隊統計不同 */
  const fplXg = want.filter(w => !w.rep.source && w.rep.sides?.[w.rep.home]?.xG != null);
  const xgBad = fplXg.filter(w => {
    const t = noteOf.get(`${w.zh}|${w.key}`) ?? '';
    return t.includes('## 逐場統計(FotMob)') && !(t.includes('xG(FotMob 球隊統計)') && (t.includes('期望進球 xG(FPL 逐人加總)') || !t.includes('| 期望進球 xG')));
  });
  check('同一則筆記裡的兩種 xG 標明出處(FPL 逐人加總 / FotMob 球隊統計)', xgBad.length === 0, `FPL 那條路 ${fplXg.length} 場${xgBad.length ? `,沒標的 ${xgBad.length}` : ''}`);
}

// ── 球員榜 ──────────────────────────────────────────
console.log('\n▶ Obsidian vault:球員榜(六個聯賽 + 盃賽 + 歐冠)');
{
  /* 一則榜的筆記拆回「標題 → 表格的列」。列的格子照產生器的表頭順序:# | 球員 | … */
  /* 標題是「榜名(單位或母體)」;榜名自己也可能帶括號(「推進(不含射門與助攻)」),
     所以不剝括號,用「整行等於榜名、或榜名後面緊接著括號」去找 —— 半形全形都認 */
  const boardsOf = text => {
    const parts = (text ?? '').split('\n## ').slice(1).map(part => ({
      head: part.split('\n')[0].trim(), text: part,
      rows: part.split('\n').filter(l => /^\| \d+ \|/.test(l)).map(l => l.split(' | ').map(c => c.replace(/^\| /, '').replace(/ \|$/, ''))),
    }));
    return { get: title => parts.find(x => x.head === title || x.head.startsWith(title + '(') || x.head.startsWith(title + '\uff08')) };
  };
  const num = s => Number(String(s ?? '').replace(/^[+]/, '').replace(/[^\d.\-].*$/, ''));
  /* 格子裡的連結 → 被連到的那一則筆記的上游 id(英超 FPL code、英冠 FotMob id、Understat id) */
  const noteByName = new Map();
  for (const [, zh] of LEAGUE_DIRS) for (const f of list(`${zh}/球員`)) noteByName.set(basename(f, '.md'), note(`${zh}/球員/${f}`));
  const linkIdOf = (cell, key) => { const m = /^\[\[([^\]|]+)\]\]/.exec(cell ?? ''); return m ? fm(noteByName.get(m[1]) ?? '', key) ?? null : undefined; };
  /* 反過來也要驗:本站**有**那個 id 的球員筆記,榜上就一定要連過去 —— 不然「連結整個拿掉」的 bug
     會被下面「名字對得上」那一條放過(格子裡的名字還在) */
  const hasNote = new Map();   // id 欄位 → Set(id)
  for (const t of noteByName.values()) for (const k of ['FPL球員code', 'FotMob球員id', 'Understat球員id']) {
    const v = fm(t, k);
    if (v) { if (!hasNote.has(k)) hasNote.set(k, new Set()); hasNote.get(k).add(v); }
  }

  const problems = [];
  let rowsChecked = 0, linked = 0, notesSeen = 0;
  const expectRows = (label, sec, rows, { idKey = null, idOf = null, playerCol = 1, valueCol }) => {
    if (!sec) { problems.push(`${label}:筆記裡沒有這一張榜`); return; }
    if (sec.rows.length !== rows.length) { problems.push(`${label}:${sec.rows.length} 列,產物 ${rows.length} 列`); return; }
    rows.forEach((r, i) => {
      rowsChecked++;
      const cells = sec.rows[i];
      const cellName = cells[playerCol] ?? '';
      const id = idKey ? linkIdOf(cellName, idKey) : undefined;
      if (id !== undefined) {
        linked++;
        if (id !== String(idOf(r))) problems.push(`${label} 第 ${i + 1} 名:連到的筆記 id ${id},產物 ${idOf(r)}`);
      } else if (idKey && hasNote.get(idKey)?.has(String(idOf(r)))) problems.push(`${label} 第 ${i + 1} 名:本站有 ${r.name} 的筆記(${idKey} ${idOf(r)}),榜上沒有連過去`);
      else if (!cellName.includes(r.name)) problems.push(`${label} 第 ${i + 1} 名:${cellName} ≠ ${r.name}`);
      const got = num(cells[valueCol]);
      if (r.value == null ? cells[valueCol] !== '—' : !(Math.abs(got - r.value) <= 0.051)) problems.push(`${label} 第 ${i + 1} 名:數值 ${cells[valueCol]},產物 ${r.value}`);
    });
  };

  for (const [lg, zh] of LEAGUE_DIRS) {
    const L = product(lg, 'leaders');
    if (!L) continue;
    const moc = note(`${zh}/${zh}.md`);
    const seasons = L.source === 'match-aggregate'
      ? Object.keys(L.boards ?? {}).map(s => ({ season: s, boards: (L.boards[s] ?? []).map(b => ({ title: b.zh, rows: b.rows ?? [] })) }))
      : ['current', 'last'].filter(w => L.seasons?.[w] && L[w]).map(w => ({
        season: L.seasons[w], boards: (L.boards ?? []).map(b => ({ title: b.label, rows: L[w][b.key] ?? [], per90: b.per90 })),
      }));
    for (const { season, boards } of seasons) {
      const rel = `${zh}/球員榜/${sanitize(`${zh} 球員榜 ${season}`)}.md`;
      const t = note(rel);
      if (!boards.some(b => b.rows.length)) { if (t) problems.push(`${rel}:產物每一張都是空的,卻開了一則筆記`); continue; }
      if (!t) { problems.push(`${rel}:沒有這則筆記`); continue; }
      notesSeen++;
      if (!moc.includes(`[[${basename(rel, '.md')}]]`)) problems.push(`${zh} 首頁沒有連到 ${basename(rel, '.md')}`);
      const secs = boardsOf(t);
      for (const b of boards) {
        const sec = secs.get(b.title);
        if (!b.rows.length) {
          if (!sec) problems.push(`${rel}:空的榜「${b.title}」沒有講`);
          else if (b.per90 && !sec.text.includes(`還沒有人踢滿 ${L.minMinutes} 分鐘`)) problems.push(`${rel}:每 90 分鐘的空榜「${b.title}」沒講門檻`);
          continue;
        }
        if (L.source === 'match-aggregate') expectRows(`${rel}・${b.title}`, sec, b.rows, { idKey: 'FotMob球員id', idOf: r => r.pid, valueCol: 3 });
        else if (L.source === 'Understat') expectRows(`${rel}・${b.title}`, sec, b.rows, { idKey: 'Understat球員id', idOf: r => r.id, valueCol: 3 });
        else expectRows(`${rel}・${b.title}`, sec, b.rows, { idKey: 'FPL球員code', idOf: r => r.code, valueCol: 4 });
      }
    }
  }
  /* 英超的榜名由產物給,前端與 vault 讀同一份:前端不准再自己寫一份 */
  const PL = product('pl', 'leaders');
  const pageSrc = readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-players.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('英超球員榜的標題與單位在產物裡(leaders.boards 對得上每一張榜),前端不再自己寫一份',
    (PL?.boards ?? []).length > 0 && JSON.stringify((PL.boards ?? []).map(b => b.key).sort()) === JSON.stringify(Object.keys(PL.last ?? {}).sort())
      && !/'射手榜'/.test(pageSrc) && /leaders\.boards/.test(pageSrc),
    `${(PL?.boards ?? []).length} 張榜定義`);

  const CD = product('pl', 'cup-details');
  const cups = product('pl', 'cups');
  for (const cup of cups?.cups ?? []) {
    for (const s of cup.seasons ?? []) {
      const P = CD?.players?.[cup.key]?.[s.label];
      if (!P?.boards?.length) continue;
      const rel = `英格蘭盃賽/球員榜/${sanitize(`${cup.zh} 球員榜 ${s.label}`)}.md`;
      const t = note(rel);
      if (!t) { problems.push(`${rel}:沒有這則筆記`); continue; }
      notesSeen++;
      if (!note(`英格蘭盃賽/${sanitize(cup.zh)}.md`).includes(`[[${basename(rel, '.md')}]]`)) problems.push(`${cup.zh} 的賽事筆記沒有連到 ${basename(rel, '.md')}`);
      /* 站上那三件事:涵蓋率、同一家供應商的核對、評分榜的門檻 */
      for (const must of [`${P.matches} 場`, `**${P.reconciled} 場**`, `射門圖完整的 ${P.xgComplete} 場`, '同一家供應商', `出賽 ≥ ${P.ratingMin} 場`]) {
        if (!t.includes(must)) problems.push(`${rel}:沒講「${must}」`);
      }
      const secs = boardsOf(t);
      for (const b of P.boards) expectRows(`${rel}・${b.zh}`, secs.get(b.zh), b.rows ?? [], { valueCol: 3 });
    }
  }
  const U = product('pl', 'ucl');
  for (const s of U?.seasons ?? []) {
    if (!s.leaders?.length) continue;
    const rel = `歐冠/球員榜/${sanitize(`歐冠 球員榜 ${s.label}`)}.md`;
    const t = note(rel);
    if (!t) { problems.push(`${rel}:沒有這則筆記`); continue; }
    notesSeen++;
    if (!note(`歐冠/賽季/${sanitize('歐冠 ' + s.label)}.md`).includes(`[[${basename(rel, '.md')}]]`)) problems.push(`歐冠 ${s.label} 的賽季筆記沒有連到 ${basename(rel, '.md')}`);
    if (!t.includes(`${s.leaderPool} 人`)) problems.push(`${rel}:沒講母體 ${s.leaderPool} 人`);
    const Y = s.playerLayer;
    if (Y?.source === 'match-aggregate' && !t.includes(`${Y.reconciled}/${Y.matches} 場`)) problems.push(`${rel}:逐場累加那一季沒講涵蓋`);
    const secs = boardsOf(t);
    for (const b of s.leaders) expectRows(`${rel}・${b.zh}`, secs.get(b.zh), b.rows ?? [], { valueCol: 3 });
  }
  check('每一張球員榜(聯賽 / 盃賽 / 歐冠)的列、名次與數值都跟產物一致,連結指到的是同一個人', notesSeen > 0 && problems.length === 0,
    `${notesSeen} 則・${rowsChecked} 列(${linked} 列有連結)${problems.length ? `;${problems.length} 個問題:${problems.slice(0, 3).join('、')}` : ''}`);
}

// ── 站上單場頁與球隊頁的其餘幾塊(2026-09-26)──────
console.log('\n▶ Obsidian vault:分析文章、專家觀點、勝率變化、交手、近況、模擬、戰術、陣型、外電');
{
  /* 產物這一側各自獨立講一次該長什麼樣(標籤、交手的主隊角度、雷達級分、模擬欄位),不 import 產生器 ——
     拿產生器自己的函式來對,等於自己對自己 */
  const ARTICLE_LABEL = { template: '本站統計模板', llm: '本站 AI 分析' };
  const pct = x => (x * 100).toFixed(1) + '%';
  const teamsOf = n => (n.teams?.length ? n.teams : (n.team ? [n.team] : []));
  const mdUrl = u => String(u).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  const sectionOf = (text, head) => (text.split('\n## ' + head)[1] ?? '').split('\n## ')[0];
  const P = {};   // 類別 → 問題清單
  const bad = (k, msg) => (P[k] ??= []).push(msg);
  const N = {};   // 類別 → 驗了幾筆
  const seen = k => { N[k] = (N[k] ?? 0) + 1; };

  for (const [lg, zh] of LEAGUE_DIRS) {
    const meta = product(lg, 'meta');
    if (!meta) continue;
    const cur = meta.currentSeason;
    const matchNote = new Map(), teamNote = new Map();
    for (const f of list(`${zh}/比賽`)) {
      const t = note(`${zh}/比賽/${f}`);
      matchNote.set(`${fm(t, '賽季')}|${fm(t, '主隊')}|${fm(t, '客隊')}`, t);
    }
    for (const f of list(`${zh}/球隊`)) { const t = note(`${zh}/球隊/${f}`); teamNote.set(fm(t, '隊碼'), t); }
    const fx = product(lg, 'fixtures');
    const fixtures = (fx?.fixtures ?? fx ?? []).filter(f => f.season === cur);
    const teams = arr(product(lg, 'teams'));

    // 分析文章:賽前(未賽、鍵沒有季)與賽後(已賽、鍵有季),每一段逐字在、標籤照來源
    const A = product(lg, 'analysis');
    let preN = 0, postN = 0;
    for (const [key, art] of Object.entries(A?.pre ?? {})) {
      const t = matchNote.get(`${cur}|${key}`) ?? '';
      seen('文章'); preN++;
      const sec = sectionOf(t, `賽前分析(${ARTICLE_LABEL[art.source] ?? '本站自動分析'}・非真人觀點)`);
      if (!sec) { bad('文章', `${zh} ${key}:沒有賽前分析(或標籤不對)`); continue; }
      if (!sec.includes(`### ${art.title}`) || art.paragraphs.some(x => !sec.includes(x)) || (art.caveat && !sec.includes(art.caveat))) bad('文章', `${zh} ${key}:賽前分析的標題、段落或但書不齊`);
    }
    for (const [key, art] of Object.entries(A?.post ?? {})) {
      const t = matchNote.get(key) ?? '';
      seen('文章'); postN++;
      const sec = sectionOf(t, `賽後分析(${ARTICLE_LABEL[art.source] ?? '本站自動分析'}・非真人觀點)`);
      if (!sec) { bad('文章', `${zh} ${key}:沒有賽後分析(或標籤不對)`); continue; }
      if (!sec.includes(`### ${art.title}`) || art.paragraphs.some(x => !sec.includes(x)) || (art.caveat && !sec.includes(art.caveat))) bad('文章', `${zh} ${key}:賽後分析的標題、段落或但書不齊`);
    }
    const flaggedPre = [...matchNote.values()].filter(t => fm(t, '賽前分析') === 'true').length;
    const flaggedPost = [...matchNote.values()].filter(t => fm(t, '賽後分析') === 'true').length;
    if (flaggedPre !== preN || flaggedPost !== postN) bad('文章', `${zh}:標了賽前 / 賽後分析的筆記 ${flaggedPre} / ${flaggedPost} 則,產物 ${preN} / ${postN} 篇`);

    /* 已完賽的賽前預測:有開賽前快照(prediction.snapshot)的印那一份,沒有的照實寫沒有 ——
       原本一律寫「本站沒有保存這場的賽前機率快照」,9/1 之後對有即時追蹤的場次就不成立了 */
    for (const f of fixtures.filter(x => x.played)) {
      const t = matchNote.get(`${cur}|${f.home}|${f.away}`) ?? '';
      seen('快照');
      const snap = f.prediction?.snapshot === true;
      const has = t.includes('## 賽前預測(開賽前存下來的快照)');
      if (snap ? !has || !t.includes(`| ${pct(f.prediction.home)} | ${pct(f.prediction.draw)} | ${pct(f.prediction.away)} |`) || t.includes('沒有保存這場的**賽前機率快照**')
        : has) bad('快照', `${zh} ${f.home}-${f.away}:${snap ? '有開賽前快照卻沒印或數字不對' : '沒有快照卻印了一份'}`);
    }

    // 真人專家觀點:每一則的人、摘要與原文連結都在
    const E = product(lg, 'experts');
    for (const [key, rows] of Object.entries(E?.matches ?? {})) {
      const t = matchNote.get(key) ?? '';
      const sec = sectionOf(t, `新聞/名宿/專家觀點(${rows.length} 則,真人)`);
      for (const x of rows) {
        seen('專家');
        if (!sec.includes(`### ${x.expert}`) || !sec.includes(x.summary) || !sec.includes(`](${mdUrl(x.url)})`)) bad('專家', `${zh} ${key} ${x.expert}:人、摘要或原文連結不在`);
      }
      if (fm(t, '專家觀點') !== String(rows.length)) bad('專家', `${zh} ${key}:frontmatter 的專家觀點數不對`);
    }

    // 勝率變化:每一個點都在全部點的表裡;比分改變的列數對;有 kick 就有「開球」那一列
    const PH = product(lg, 'prob-history');
    /* 只掛在那一季的那一場:勝率曲線的鍵沒有季(檔頭才有),查的時候漏看季的話,上一季同一組對戰也會掛上一條 */
    const recs = Object.values(PH?.matches ?? {}).filter(r => (r.pts ?? []).length >= 3).length;
    const flaggedProb = [...matchNote.values()].filter(t => fm(t, '勝率曲線點數') !== undefined).length;
    if (flaggedProb !== recs) bad('勝率', `${zh}:有勝率曲線的筆記 ${flaggedProb} 則,產物 ${recs} 場`);
    for (const [key, rec] of Object.entries(PH?.matches ?? {})) {
      if ((rec.pts ?? []).length < 3) continue;
      const t = matchNote.get(`${PH.season}|${key}`) ?? '';
      seen('勝率');
      const sec = sectionOf(t, '勝率變化(本站模型的即時機率)');
      if (!sec.includes(`全部 ${rec.pts.length} 個點`) || !sec.includes('不是市場盤口')) { bad('勝率', `${zh} ${key}:沒有勝率變化或點數 / 界線不對`); continue; }
      const missPt = rec.pts.filter(s => !sec.includes(`> | ${s[0]} | ${s[4]}-${s[5]} | ${pct(s[1])} | ${pct(s[2])} | ${pct(s[3])} |`));
      if (missPt.length) bad('勝率', `${zh} ${key}:${missPt.length} 個點不在表裡`);
      const changes = rec.pts.filter((s, i) => i > 0 && (s[4] !== rec.pts[i - 1][4] || s[5] !== rec.pts[i - 1][5])).length;
      if ((sec.match(/比分改變後的第一個點/g) ?? []).length !== changes) bad('勝率', `${zh} ${key}:比分改變 ${changes} 次,表上的列數不同`);
      if (rec.pts[0][0] === 0 && rec.kick && !sec.includes(`| 開球 | 0-0 | ${pct(rec.kick[0])} | ${pct(rec.kick[1])} | ${pct(rec.kick[2])} |`)) bad('勝率', `${zh} ${key}:有開球那一步卻沒有那一列`);
    }

    // 歷來交手:本季未賽的每一場,主隊角度的勝和負與進球、逐場列表的筆數
    const H2 = product(lg, 'h2h') ?? {};
    if (Object.keys(H2).length) {
      for (const f of fixtures.filter(x => !x.played)) {
        const t = matchNote.get(`${cur}|${f.home}|${f.away}`) ?? '';
        const rec = H2[[f.home, f.away].sort().join('|')];
        seen('交手');
        if (!rec) { if (!/## 歷來交手\n\n.*沒有在.*交手過/.test(t)) bad('交手', `${zh} ${f.home}-${f.away}:沒有交手紀錄,卻沒講`); continue; }
        const aIsHome = [f.home, f.away].sort()[0] === f.home;
        const want = aIsHome ? `| ${rec.aWin} | ${rec.draw} | ${rec.bWin} | ${rec.aGoals} : ${rec.bGoals} |` : `| ${rec.bWin} | ${rec.draw} | ${rec.aWin} | ${rec.bGoals} : ${rec.aGoals} |`;
        const sec = sectionOf(t, '歷來交手');
        const lines = (sec.match(/^- \d{4}-\d{2}-\d{2} /gm) ?? []).length;
        if (!sec.includes(want) || lines !== rec.list.length) bad('交手', `${zh} ${f.home}-${f.away}:勝和負(主隊角度)或逐場筆數不對`);
      }
    }

    // 賽季模擬:每一隊的那一列,欄位照資料(有直升不印前四、有降級附加賽多一欄);聯賽首頁有整張表
    const moc = note(`${zh}/${zh}.md`);
    for (const s of arr(product(lg, 'sim'))) {
      seen('模擬');
      const cells = [s.expectedPoints, s.expectedPos, `${s.titlePct}%`,
        ...(s.promotionPct != null ? [`${s.promotionPct}%`, ...(s.playoffPct != null ? [`${s.playoffPct}%`] : [])] : [`${s.top4Pct}%`]),
        `${s.relegationPct}%`, ...(s.relegationPlayoffPct != null ? [`${s.relegationPlayoffPct}%`] : [])].join(' | ');
      const t = teamNote.get(s.code) ?? '';
      const sec = sectionOf(t, `${cur} 賽季模擬`);
      if (!sec.includes(`| ${cells} |`)) bad('模擬', `${zh} ${s.code}:球隊筆記的模擬那一列對不上`);
      if (s.promotionPct != null && /\| 前四 \|/.test(sec)) bad('模擬', `${zh} ${s.code}:有直升的聯賽印了前四`);
      if (s.relegationPlayoffPct != null && !sec.includes('降級附加賽')) bad('模擬', `${zh} ${s.code}:沒有降級附加賽那一欄`);
      if (!moc.includes(` | ${cells} |`)) bad('模擬', `${zh} ${s.code}:聯賽首頁的模擬表沒有這一列`);
    }

    // 近況:近五場逐場、合計那一行;英超另有可用人手與拿牌
    const FO = product(lg, 'form');
    const RES = { W: '勝', D: '和', L: '負' };
    for (const tm of teams) {
      const x = FO?.teams?.[tm.code];
      if (!x?.recent?.length) continue;
      seen('近況');
      const sec = sectionOf(teamNote.get(tm.code) ?? '', `近況(截至 ${FO.asOf})`);
      const miss = x.recent.filter(r => !new RegExp(`\\| ${r.date} \\| ${r.venue === 'H' ? '主' : '客'} \\| [^|]+ \\| ${r.gf}-${r.ga} \\| ${RES[r.res]} \\|`).test(sec));
      const s = x.summary;
      if (miss.length || !sec.includes(`近 ${s.games} 場 ${s.w} 勝 ${s.d} 和 ${s.l} 負・進 ${s.gf} 失 ${s.ga}`)) bad('近況', `${zh} ${tm.code}:近況逐場或合計不對`);
      const a = x.availability;
      if (a) {
        const av = sec.split('### 可用人手')[1] ?? '';
        if (!av || !av.includes(`**確定缺陣**(${a.outCount} 人`) || (a.cards ?? []).some(c => c.watch && !av.includes(`再 ${c.watch.away} 張黃牌停 ${c.watch.ban} 場`))) bad('近況', `${zh} ${tm.code}:可用人手或停賽門檻不對`);
        if (a.out.length + (a.doubt?.length ?? 0) + (a.cards?.length ?? 0) > 0 && (av.match(/^\| (?!球員|---)/gm) ?? []).length !== a.out.length + (a.doubt?.length ?? 0) + (a.cards?.length ?? 0)) bad('近況', `${zh} ${tm.code}:可用人手的列數跟產物不同`);
      }
    }

    // 上季數據風格:雷達的級分(百分位每 10 分一級)與原始值、標籤;人力配置只有有 def 的聯賽印
    for (const tm of teams) {
      const tac = tm.tactics;
      if (!tac) continue;
      seen('風格');
      const sec = sectionOf(teamNote.get(tm.code) ?? '', `上季數據風格(${meta.lastSeason})`);
      const radarBad = (tac.radar ?? []).filter(r => !sec.includes(`| ${r.label} | ${Math.min(10, Math.floor((r.value ?? 0) / 10) + 1)} | ${r.value} | ${r.raw} |`));
      if (!sec || radarBad.length || (tac.tags?.length && !sec.includes(`標籤:${tac.tags.join('・')}`))) bad('風格', `${zh} ${tm.code}:雷達 / 標籤不對`);
      if (tac.formation?.def == null && sec.includes('後場 / 中場 / 鋒線人力')) bad('風格', `${zh} ${tm.code}:沒有人力資料卻印了人力那一列`);
    }

    // 陣型:官方先發陣型;推導的攻守分型要掛「推論」那一句
    const SH = product(lg, 'shapes') ?? {};
    for (const [code, sh] of Object.entries(SH)) {
      if (!teamNote.has(code)) continue;
      seen('陣型');
      const sec = sectionOf(teamNote.get(code), `陣型(${cur})`);
      if (sh.official?.formation && !sec.includes(`**官方先發陣型**:最常用 ${sh.official.formation}(${sh.official.games} 場有正式先發)`)) bad('陣型', `${zh} ${code}:官方先發陣型不對`);
      if (sh.base && !sh.insufficient && (!sec.includes(`| 標準(推導) | ${sh.base.label} |`) || !sec.includes('攻守分型永遠是推論,官方沒有這個東西'))) bad('陣型', `${zh} ${code}:推導的陣型沒有標成推論`);
      if (sh.insufficient && !sec.includes('不推導')) bad('陣型', `${zh} ${code}:樣本不足卻沒講`);
    }

    // 外電與動態:整份筆記有每一則(標題與原文連結);球隊筆記的則數等於提到那一隊的則數;AI 整理的照實標
    const NW = arr(product(lg, 'news')).filter(n => n?.title);
    if (NW.length) {
      const nn = note(`${zh}/${sanitize(zh + ' 外電與動態')}.md`);
      if (!moc.includes(`[[${sanitize(zh + ' 外電與動態')}]]`)) bad('外電', `${zh} 首頁沒有連到外電筆記`);
      for (const n of NW) {
        seen('外電');
        if (!nn.includes(`### ${n.titleZh ?? n.title}`) || (n.link && /^https?:/.test(n.link) && !nn.includes(`](${mdUrl(n.link)})`))) bad('外電', `${zh}:外電筆記少了「${(n.titleZh ?? n.title).slice(0, 20)}」或它的連結`);
        if (n.curated && n.curator?.kind === 'ai' && !nn.includes(`AI 整理摘要:${n.curator.method ?? ''}`)) bad('外電', `${zh}:AI 整理的「${n.title.slice(0, 20)}」沒有照實標`);
      }
      for (const tm of teams) {
        const mine = NW.filter(n => teamsOf(n).includes(tm.code));
        const t = teamNote.get(tm.code) ?? '';
        if (mine.length ? !t.includes(`## 外電與動態(${mine.length} 則,提到這一隊的)`) : t.includes('## 外電與動態(')) bad('外電', `${zh} ${tm.code}:球隊筆記的外電則數不是 ${mine.length}`);
      }
    }

    // 陣型與成績(只有英超有 formation.json):每一組相關係數與「過門檻」照產物
    const FM = product(lg, 'formation');
    if (FM?.pairs?.length) {
      for (const x of FM.pairs) {
        seen('陣型與成績');
        if (!moc.includes(`| ${x.x} vs ${x.y} | ${x.r} | ${x.strength} | ${x.significant ? '是' : '否'} |`)) bad('陣型與成績', `${zh}:${x.x} vs ${x.y} 那一列不對`);
      }
      if (!moc.includes('反過來的因果')) bad('陣型與成績', `${zh}:沒講「相關不是因果」`);
    }

    /* ── 球隊頁其餘四塊(2026-09-27):Elo 走勢、近 N 場風格位移、xG 走勢、開季賽程難度,照 teams.json ── */
    for (const tm of teams) {
      const t = teamNote.get(tm.code) ?? '';
      const eh = arr(tm.eloHistory).filter(x => x && x.date != null && x.r != null);
      if (eh.length) {
        seen('Elo');
        const last = eh[eh.length - 1];
        if (!t.includes(`## Elo 走勢(${eh.length} 個點`) || !t.includes(`| ${last.date} | ${last.r} |`) || !t.includes(`最新 **${last.r}**`)) bad('Elo', `${zh} ${tm.code}:Elo 走勢缺或最後一點不對`);
      }
      const st = tm.styleTrend;
      if (st?.recent?.games) {
        seen('位移');
        const sec = sectionOf(t, `近 ${st.recent.games} 場風格位移`);
        const axesBad = st.recentPct && Array.isArray(st.axes) ? st.axes.filter(a => !sec.includes(`| ${a.label} | ${st.recentPct[a.key] ?? '—'} |`)) : [];
        if (!sec.includes(`| 射門/場 | ${st.recent.sf ?? '—'} | ${st.baseline?.sf ?? '—'} |`) || axesBad.length) bad('位移', `${zh} ${tm.code}:風格位移的射門列或六軸不對`);
      }
      if (tm.xgTrend?.games) {
        seen('xG走勢');
        if (!t.includes(`本季 ${tm.xgTrend.games} 場:場均 xG ${tm.xgTrend.xg}、xGA ${tm.xgTrend.xga}`)) bad('xG走勢', `${zh} ${tm.code}:xG 走勢不對`);
      }
      const sc = tm.schedule;
      if (Array.isArray(sc?.detail) && sc.detail.length) {
        seen('賽程難度');
        const sec = sectionOf(t, '開季賽程難度');
        const rowBad = sc.detail.filter(d => !new RegExp(`\\| ${d.event} \\| [^|]+ \\| ${d.home ? '主' : '客'} \\| ${d.diff} \\|`).test(sec));
        if (rowBad.length || !sec.includes(`平均難度 ${sc.avg}`)) bad('賽程難度', `${zh} ${tm.code}:賽程難度的列或平均不對`);
      }
    }

    /* ── 預估先發(lineups.json,英超):本季未賽、至少一隊有的每一場;名單逐人在、講明不是官方名單 ── */
    const LU = product(lg, 'lineups');
    if (LU && typeof LU === 'object') {
      for (const f of fixtures.filter(x => !x.played)) {
        const lh = LU[f.home], la = LU[f.away];
        if (!lh && !la) continue;
        seen('預估先發');
        const t = matchNote.get(`${cur}|${f.home}|${f.away}`) ?? '';
        const sec = sectionOf(t, '預估先發陣容');
        for (const [lu, code] of [[lh, f.home], [la, f.away]]) {
          if (!lu) continue;
          const nm = teams.find(x => x.code === code)?.en ?? code;
          const names = arr(lu.rows).flat().map(p => p.name);
          if (!sec.includes(`### ${nm}(${lu.shape}`) || names.some(n => !sec.includes(n))) bad('預估先發', `${zh} ${f.home}-${f.away} ${code}:陣型或名單不對`);
        }
        if (!sec.includes('不是官方名單')) bad('預估先發', `${zh} ${f.home}-${f.away}:沒講不是官方名單`);
      }
    }

    /* ── 模型驗證(2026-09-27):一則、數字照 meta.model.backtest、聯賽首頁連過去 ── */
    {
      const bt = meta.model?.backtest;
      const mfile = sanitize(zh + ' 模型驗證');
      const mn = note(`${zh}/${mfile}.md`);
      seen('模型驗證');
      if (!mn) bad('模型驗證', `${zh}:沒有模型驗證筆記`);
      else if (bt?.available) {
        // 沒有場次的區間是 null → 筆記印「—」(不是 0.0%,那是假數字)
        const calBad = (bt.calibration ?? []).filter(c => !mn.includes(`| ${pct(c.lo)}~${pct(c.hi)} | ${c.n} | ${c.predicted == null ? '—' : pct(c.predicted)} | ${c.actual == null ? '—' : pct(c.actual)} |`));
        if (!mn.includes(`| 採用(Poisson 與 Elo 平均) | ${bt.rps} | ${bt.logLoss} | ${pct(bt.hitRate)} |`) || calBad.length) bad('模型驗證', `${zh}:回測數字或校準表不對`);
      } else if (!mn.includes('還沒有走查回測結果')) bad('模型驗證', `${zh}:沒有回測卻沒講`);
      if (!moc.includes(`[[${mfile}]]`)) bad('模型驗證', `${zh}:聯賽首頁沒有連到模型驗證`);
    }
  }
  for (const k of ['文章', '快照', '專家', '勝率', '交手', '模擬', '近況', '風格', '陣型', '外電', '陣型與成績',
    'Elo', '位移', 'xG走勢', '賽程難度', '預估先發', '模型驗證']) {
    check(`${k}:筆記跟產物一致`, (N[k] ?? 0) > 0 && !(P[k]?.length), `驗了 ${N[k] ?? 0} 筆${P[k]?.length ? `;${P[k].length} 個問題:${P[k].slice(0, 3).join('、')}` : ''}`);
  }
}

// ── 上游的物件欄位 ──────────────────────────────────
console.log('\n▶ Obsidian vault:沒有一則筆記印出 [object Object]');
{
  /* FotMob 的 detail / comments 有時是 { defaultText } 物件 —— 直接塞進字串就是這個(網站上踩過 57 列) */
  const bad = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.md') && readFileSync(p, 'utf8').includes('[object Object]')) bad.push(p.slice(OUT.length + 1));
    }
  };
  walk(OUT);
  check('全部筆記裡沒有 [object Object]', bad.length === 0, bad.slice(0, 3).join('、'));
}

// ── 同名球員 ────────────────────────────────────────
console.log('\n▶ Obsidian vault:同名球員照共用 id 判(Understat 的 id 跨聯賽共用)');
{
  /* 從各聯賽的球員筆記收「檔名 → Understat id」,再逐行檢查同名提醒的判決 */
  const LG = ['英超', '西甲', '英冠', '德甲', '義甲', '法甲'];
  const uidOf = new Map();
  const texts = new Map();
  for (const lg of LG) {
    for (const f of list(`${lg}/球員`)) {
      const t = note(`${lg}/球員/${f}`);
      texts.set(basename(f, '.md'), t);
      const uid = fm(t, 'Understat球員id');
      if (uid) uidOf.set(basename(f, '.md'), uid);
    }
  }
  let same = 0, diff = 0, unknown = 0;
  const wrong = [];
  for (const [file, t] of texts) {
    const sec = /## 同名提醒\n([\s\S]*?)(\n## |$)/.exec(t)?.[1];
    if (!sec) continue;
    for (const m of sec.matchAll(/^- \[\[([^\]]+)\]\].*$/gm)) {
      const a = uidOf.get(file), b = uidOf.get(m[1]);
      const want = a && b ? (a === b ? '**同一人**' : '**不同人**') : null;
      if (want === '**同一人**') same++; else if (want) diff++; else unknown++;
      if (want ? !m[0].includes(want) : /\*\*同一人\*\*|\*\*不同人\*\*/.test(m[0])) wrong.push(`${file} → ${m[1]}`);
    }
  }
  check('同名提醒的每一行判決跟兩邊的 Understat id 一致(同 id = 同一人、不同 = 不同人、沒有共用 id 不下判決)',
    wrong.length === 0, `同一人 ${same}・不同人 ${diff}・無法核對 ${unknown} 行${wrong.length ? `;判錯 ${wrong.slice(0, 3).join('、')}` : ''}`);

  /* README 的數字是產生器這一次算的,不是寫死的(原本寫死「13 組、0 組可以核對」) */
  const readme = note('README.md') ?? '';
  const m = /這一次有 (\d+) 組同名,其中 (\d+) 組跨聯賽。[\s\S]*?(\d+) 組是\*\*同一個 id\*\*[\s\S]*?(\d+) 組 id 不同/.exec(readme);
  check('README 的同名數字是算出來的,而且跟筆記裡的判決對得上', !!m && Number(m[3]) > 0 === same > 0 && Number(m[4]) > 0 === diff > 0,
    m ? `${m[1]} 組同名・${m[2]} 跨聯賽・${m[3]} 同一人・${m[4]} 不同人` : 'README 裡找不到那一句');

  /* 德義法沒有身分來源:不准再寫「身分與背號來自 SportMonks」 */
  const deIdentity = ['德甲', '義甲', '法甲'].flatMap(lg => list(`${lg}/球員`).map(f => note(`${lg}/球員/${f}`)))
    .filter(t => /身分與背號來自 \*\*SportMonks\*\*/.test(t) || fm(t, '身分來源') === 'SportMonks');
  check('德義法的球員筆記不再掛著一個沒用到的來源(SportMonks)', deIdentity.length === 0, `${deIdentity.length} 則`);
}

// ── 連結 ────────────────────────────────────────────
console.log('\n▶ Obsidian vault:筆記內文的每一個連結都指得到東西');
{
  /* 產生器的守門只查它自己「宣告」的連結;這裡掃**內文**,包括 ![[嵌入]] 的圖檔 ——
     寫進內文卻沒宣告的連結,守門看不到 */
  const notes = new Set(), assets = new Set(), files = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.md')) { notes.add(basename(p, '.md')); files.push(p); } else assets.add(basename(p));
    }
  };
  walk(OUT);
  const broken = [];
  let n = 0;
  for (const f of files) {
    // 程式碼區塊與行內程式碼裡的 [[ ]] 不是連結(README 在講語法)
    const s = readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of s.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
      n++;
      const target = m[2].split('|')[0].split('#')[0].trim();
      if (m[1] ? !assets.has(target) && !notes.has(target) : !notes.has(target)) broken.push(`${m[0]} ← ${f.slice(OUT.length + 1)}`);
    }
  }
  check('內文的 [[連結]] 與 ![[嵌入]] 全部指得到', n > 0 && broken.length === 0, `${n} 個${broken.length ? `,壞的 ${broken.length}:${broken.slice(0, 3).join('、')}` : ''}`);
}

rmSync(OUT, { recursive: true, force: true });
