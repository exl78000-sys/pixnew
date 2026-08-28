#!/usr/bin/env node
/* 租借紀錄核對器 —— 人工交付的租借資料一定要用獨立來源核對才能發布(鐵則五)。

   為什麼要有這支:2026-08-28 交付的那一份,2024-25 整批是偽造的 ——
   把 2025-26 的紀錄整批複製、年份 -1。協作方自己不會回報這件事,
   而畫面上看起來完全正常。抓到它靠的是倉庫裡本來就有的三份獨立資料:

   - `web/data{,/leagues/es1}/results.json` —— 逐季的聯賽成員資格
     (Leeds United 2024-25 在英冠,所以「2024-25 英超 / 母隊 Leeds」不可能存在)
   - `data/raw/fpl/{季}-players.csv` —— 逐季出賽分鐘
     (Jack Harrison 2068 分鐘,不可能同一季被外借出英超)
   - `web/data/leagues/es1/players.json` —— 西甲逐季球員
     (Mateo Joseph 的 29 場發生在 2025-26,不是 2024-25)

   輸出 data/loans-verified.json。**build 只讀這一份,不讀收件匣。**

   判定分四級,不是二分:
     confirmed    有獨立來源正面確認球員當季在租借目的地
     consistent   查得動的檢查都沒有矛盾,但沒有正面確認
     contradicted 與獨立資料矛盾 —— 不發布
     unverifiable 沒有任何獨立資料涵蓋得到 —— 不發布
   發布的只有前兩級,而且等級要跟著資料走到畫面上(鐵則四)。 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const arr = x => (Array.isArray(x) ? x : Object.values(x ?? {}));

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/* 隊名比對只去**字尾**的 FC/AFC/CF 這類法人形式。
   字首的 AFC 是球隊身分的一部分 —— 去掉的話 AFC Bournemouth 會被對成別人。
   這條在盃賽頁踩過兩次,規則寫在 CLAUDE.md。 */
const clubKey = s => norm(s).replace(/\b(fc|afc|cf|sad|sd|rcd|ud|cd)$/, '').trim();

// ── 獨立來源 1:逐季聯賽成員資格 ──────────────────────────
function membership() {
  const m = new Map();   // lg|season → Set(code)
  const dirs = [['pl', join(ROOT, 'web', 'data')], ['es1', join(ROOT, 'web', 'data', 'leagues', 'es1')]];
  for (const [lg, dir] of dirs) {
    for (const f of ['results', 'fixtures']) {
      const p = join(dir, `${f}.json`);
      if (!existsSync(p)) continue;
      for (const x of arr(read(p))) {
        if (!x?.season || !x.home || !x.away) continue;
        const k = `${lg}|${x.season}`;
        if (!m.has(k)) m.set(k, new Set());
        m.get(k).add(x.home); m.get(k).add(x.away);
      }
    }
  }
  return m;
}

// ── 隊名 → 隊碼 ──────────────────────────────────────────
function clubIndex() {
  const idx = new Map();
  const add = (lg, code, ...names) => {
    for (const n of names) { const k = clubKey(n); if (k && !idx.has(k)) idx.set(k, { lg, code }); }
  };
  for (const c of arr(read(join(ROOT, 'web', 'data', 'clubs.json')))) add('pl', c.code, c.en, c.of, c.fpl);
  for (const c of arr(read(join(ROOT, 'data', 'manual', 'teams-la-liga.json')).teams)) {
    add('es1', c.code, c.en, c.of, c.understat, ...(c.alias ?? []));
  }
  return idx;
}

/* ── 獨立來源 2:FPL 逐季出賽分鐘 ─────────────────────────

   **這裡有一個我自己踩過的坑。** `data/raw/fpl/{季}-players.csv` 的檔名是賽季,
   但**當季那一份在球季初裝的是上一季的總數** —— 2026-27 的檔案裡 Raya 是 3330 分鐘,
   跟 2025-26 那一份一模一樣,而 2026-27 只踢了 1 輪。
   我第一版拿它當本季分鐘用,結果誣賴了四筆真紀錄(Badiashile 470、Bayindir 540…)。

   所以每一份 CSV 用之前先自我檢查:它的進球總和要等於 goals.json 記的該季總進球。
   2024-25 那一份是 1081 = 1081,對得上,可以用;當季那一份對不上,拒用。
   (CLAUDE.md 早就寫著「players_raw.csv 是季末快照」,我讀漏了那條的言外之意。) */
function fplSeason(season) {
  const p = join(ROOT, 'data', 'raw', 'fpl', `${season}-players.csv`);
  if (!existsSync(p)) return null;
  const Q = '"';
  const split = l => {
    const c = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === Q) { q = !q; continue; }
      if (ch === ',' && !q) { c.push(cur); cur = ''; continue; }
      cur += ch;
    }
    c.push(cur); return c;
  };
  const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  const h = split(lines[0]);
  const iF = h.indexOf('first_name'), iS = h.indexOf('second_name');
  const iW = h.indexOf('web_name'), iM = h.indexOf('minutes');
  const iG = h.indexOf('goals_scored');
  const rows = lines.slice(1).map(l => {
    const c = split(l);
    return {
      full: `${c[iF] ?? ''} ${c[iS] ?? ''}`.trim(), web: c[iW],
      minutes: Number(c[iM]) || 0, goals: Number(c[iG]) || 0,
    };
  });
  // 自我檢查:進球總和對不回 goals.json 的該季總進球就拒用這一份
  const gp = join(ROOT, 'web', 'data', 'goals.json');
  if (!existsSync(gp)) return null;
  const expect = read(gp).data?.[season]?.goals ?? null;
  const got = rows.reduce((s, r) => s + r.goals, 0);
  if (expect == null || got !== expect) {
    console.log(`  ⚠ ${season}-players.csv 拒用:進球總和 ${got} 對不回 goals.json 的 ${expect}`
      + '(當季那一份裝的是上一季的數字)');
    return null;
  }
  return rows;
}

/* 姓名比對。**這裡原本有一個會對錯人的 bug,2026-08-28 修掉。**

   原本寫成「姓氏唯一就回傳」,完全沒有檢查名字 —— 於是:
     Gustavo Nunes → 比到 Matheus Nunes(FPL 唯一姓 Nunes 的人,2861 分鐘)
     Fer López     → 比到 Hugo Bueno López(2359 分鐘)
   然後核對器拿那些分鐘去指控真紀錄是假的。整個專案最常講的一句話就是
   「對錯人比對不到糟得多」,而這支自己犯了。

   現在:全名精確 → 或者姓氏相同**且名字首字母相同**且唯一。
   兩者都不成立就回 null,當成對不到。 */
export function matchPerson(rows, name, nameOf) {
  const k = norm(name);
  const exact = rows.filter(r => norm(nameOf(r)) === k);
  if (exact.length === 1) return exact[0];
  const parts = k.split(' '), last = parts.at(-1), first = parts[0] ?? '';
  if (!first) return null;
  const byBoth = rows.filter(r => {
    const n = norm(nameOf(r));
    return n.split(' ').at(-1) === last && n.startsWith(first[0]);
  });
  return byBoth.length === 1 ? byBoth[0] : null;
}

// ── 獨立來源 3:西甲逐季球員(Understat)─────────────────
function laLigaPlayers() {
  const p = join(ROOT, 'web', 'data', 'leagues', 'es1', 'players.json');
  return existsSync(p) ? arr(read(p)) : [];
}

/* 交付檔內部的年份平移痕跡。2026-08-28 那一份有 14 組
   「同一個球員 + 母隊 + 租借隊,月日完全相同、剛好差整數年」——
   真實轉會不會連續兩年落在同一個日期。這是整批複製的指紋。 */
export function yearShifted(records) {
  const g = new Map();
  for (const r of records) {
    if (!r.date) continue;
    const k = [norm(r.player), clubKey(r.parentClub), clubKey(r.loanClub)].join('|');
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const flagged = new Set();
  for (const list of g.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        if (a.date.slice(5) !== b.date.slice(5)) continue;
        if (Math.abs(Number(b.date.slice(0, 4)) - Number(a.date.slice(0, 4))) >= 1) {
          flagged.add(a); flagged.add(b);
        }
      }
    }
  }
  return flagged;
}

/* 夏窗與冬窗的檢查強度不同。夏窗外借的人整季不該有出賽分鐘;
   冬窗外借的人前半季本來就在踢,拿同一個門檻去卡會把真紀錄誤判成假的。
   門檻不是憑感覺:一季 38 輪,冬窗離隊前最多打完約 20 輪 ≈ 1800 分鐘。 */
/* **沒有日期的時候只能用最寬鬆的門檻。**

   重做版的歷史賽季是 `date: null` + `datePrecision: 'season'` ——
   對方抽不到穩定的交易日期,照實標了(這是對的做法)。
   但這樣就分不出夏窗與冬窗,而夏窗門檻 450 分鐘套在真正的冬窗租借上
   會把真紀錄判成假的:一月才離隊的人前半季本來就踢了一千多分鐘。

   分不出來就用冬窗那個寬門檻 —— 寧可漏掉幾筆該擋的,
   也不要憑一個我們其實沒有的日期去指控真資料。 */
const windowOf = date => {
  if (!date) return null;
  const m = Number(date.slice(5, 7));
  if (m >= 6 && m <= 9) return 'summer';
  if (m === 1 || m === 2) return 'winter';
  return 'other';
};
const MINUTES_CAP = { summer: 450, winter: 1800, other: 1800, unknown: 1800 };

/* 交付檔是從 HTML 表格抽出來的,字串裡會留著沒解碼的 HTML entity:
   `Brighton &amp; Hove Albion`、`Matt O&#039;Riley`(2026-08-28 那份有 44 筆)。
   不只是難看 —— 姓名正規化會把 `&#039;` 變成 `039` 這個 token,
   然後 O'Riley 就永遠配不到本站的球員。

   在**讀進來的邊界**解掉,不手改交付檔:那份是協作方交的東西,
   要保持原樣才對得回他們的來源;要修的是我們這一側的正規化。 */
const HTML_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = v => (typeof v === 'string'
  ? v.replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return HTML_ENTITY[code.toLowerCase()] ?? m;
  })
  : v);

function main() {
  const inbox = read(join(ROOT, 'data', 'manual', 'loans.json'));
  let decoded = 0;
  for (const r of inbox.records ?? []) {
    for (const k of ['player', 'parentClub', 'loanClub']) {
      const v = decodeEntities(r[k]);
      if (v !== r[k]) { r[k] = v; decoded++; }
    }
  }
  if (decoded) console.log(`  · 解掉 ${decoded} 個沒解碼的 HTML entity(交付檔是從 HTML 抽的)`);
  const mem = membership();
  const clubs = clubIndex();
  const es1 = laLigaPlayers();
  const fpl = {
    '2024-25': fplSeason('2024-25'),
    '2025-26': fplSeason('2025-26'),
    '2026-27': fplSeason('2026-27'),
  };
  const shifted = yearShifted(inbox.records);

  const seen = new Set();
  const labelIssues = [];
  const out = [];
  for (const r of inbox.records) {
    const checks = [];
    /* 失敗要分兩種:
       data    —— 跟獨立來源衝突。這種才代表「這一批資料本身有問題」。
       hygiene —— 交付檔自己的衛生問題(重覆列)。刪掉重覆就好,
                  不代表同一批的其他紀錄不可信,所以不列入下面的區塊連坐。 */
    const fail = (msg, kind = 'data') => checks.push({ ok: false, msg, kind });
    const pass = msg => checks.push({ ok: true, msg, positive: true });
    const info = msg => checks.push({ ok: true, msg });

    const dupKey = [r.season, norm(r.player), clubKey(r.parentClub), clubKey(r.loanClub)].join('|');
    if (seen.has(dupKey)) fail('交付檔裡有完全相同的重覆紀錄', 'hygiene');
    seen.add(dupKey);

    if (shifted.has(r)) fail('與另一筆紀錄月日完全相同、剛好差整數年 —— 整批複製的指紋');

    const parent = clubs.get(clubKey(r.parentClub)) ?? null;
    const loanTo = clubs.get(clubKey(r.loanClub)) ?? null;

    /* 檢查一:**母隊**當季在不在那個聯賽。

       只查母隊,不查目的地 —— 租借目的地本來就常常是低一級或國外的球隊
       (2025-26 租到英冠的 Hull City、2026-27 租到英冠的 Leicester 都完全正常)。
       第一版連目的地一起查,一口氣誣賴了 15 筆真紀錄。 */
    /* 2026-08-28 的重做版把 `league` 拆成 `parentLeague` / `loanLeague`,
       這正是我們請對方改的 —— 舊的單一欄位有時是母隊的聯賽、有時是目的地的,
       拿它當索引會誤判。舊格式仍然讀得動(fallback 到 league)。 */
    const LEAGUE_OF = { 'Premier League': 'pl', LaLiga: 'es1' };
    const parentLeague = r.parentLeague !== undefined ? r.parentLeague : r.league;
    /* 母隊的 parentLeague 標錯**不退回這一筆**。

       標錯不代表這筆租借是假的,而且這個欄位下游根本沒有用到
       (lib/loans.mjs 用的是隊碼,不是聯賽名)。為了一個 metadata 標籤退回真紀錄,
       跟前面那兩個誤判是同一種錯。改成記成 labelIssue,收工時一次列出來回報。

       原本用它抓到 Leeds 那批偽造的 —— 但真正定罪的是出賽分鐘與年份平移,
       這一條只是最便宜的偵測器,不該單獨當判決依據。 */
    if (parent && LEAGUE_OF[parentLeague] === parent.lg) {
      const set = mem.get(`${parent.lg}|${r.season}`);
      if (set && !set.has(parent.code)) {
        labelIssues.push({ season: r.season, player: r.player, club: r.parentClub,
          why: `標成${parent.lg === 'pl' ? '英超' : '西甲'},但該隊當季不在那個聯賽` });
      } else if (set) info(`母隊 ${parent.code} 當季確實在該聯賽`);
    }

    // 檢查二:從英超外借出去,當季卻有大量英超出賽分鐘
    if (parent?.lg === 'pl' && loanTo?.lg !== 'pl' && fpl[r.season]) {
      const hit = matchPerson(fpl[r.season], r.player, x => x.full)
        ?? matchPerson(fpl[r.season], r.player, x => x.web);
      const win = windowOf(r.date) ?? (r.datePrecision ? 'unknown' : 'summer');
      if (hit && hit.minutes > MINUTES_CAP[win]) {
        fail(`宣稱${win === 'summer' ? '夏窗' : '該季'}外借出英超,但 FPL ${r.season} 有 ${hit.minutes} 分鐘出賽`
          + (win === 'unknown' ? '(交付檔沒有日期,已用最寬鬆的門檻)' : ''));
      } else if (hit) {
        info(`FPL ${r.season} 出賽 ${hit.minutes} 分鐘,與外借不矛盾`);
      }
    }

    /* 檢查三:租到西甲的人,西甲逐季資料找不找得到他在那一隊。

       **只有在目的地當季真的在西甲時才做。** 原本沒有這個前提,於是:
       Racing Santander / Cádiz / Granada 2025-26 都在西乙,租過去的人本來就
       不會出現在西甲資料裡 —— 而他在原隊留下的西甲出賽紀錄被當成「矛盾」。
       (第一份交付的 Pelayo Fernández → Cádiz 就是被這樣誤判的,我發函退回過,那是錯的。) */
    const loanInLeagueThatSeason = loanTo?.lg === 'es1'
      && (mem.get(`es1|${r.season}`)?.has(loanTo.code) ?? false);
    if (loanInLeagueThatSeason) {
      const sameSeason = es1.filter(p => p.season === r.season);
      if (sameSeason.length) {
        /* 判「矛盾」的門檻比判「確認」高:只有**全名精確對上**才敢說資料錯,
           姓氏推出來的配對只當參考。對錯人比對不到糟得多 —— 英超光同姓的就有 15 組。 */
        const exact = sameSeason.filter(x => norm(x.fullName || x.name) === norm(r.player)
          || norm(x.name) === norm(r.player));
        const hit = exact.length === 1 ? exact[0]
          : matchPerson(sameSeason, r.player, x => x.fullName || x.name);
        if (hit && (hit.teamCodes ?? []).includes(loanTo.code)) {
          pass(`西甲 ${r.season} 逐季資料確認他在 ${loanTo.code}(出賽 ${hit.games ?? '?'} 場)`);
        } else if (exact.length === 1) {
          fail(`西甲 ${r.season} 資料把他放在 ${(hit.teamCodes ?? []).join('/') || '未知'},不是 ${loanTo.code}`);
        } else if (hit) {
          info(`西甲 ${r.season} 有姓氏相近的人在 ${(hit.teamCodes ?? []).join('/')},但全名對不精確,不當證據`);
        }
      }
    }

    // 檢查四:租進英超的人,當季 FPL 名單裡在不在
    if (loanTo?.lg === 'pl' && fpl[r.season]) {
      const hit = matchPerson(fpl[r.season], r.player, x => x.full)
        ?? matchPerson(fpl[r.season], r.player, x => x.web);
      if (hit) pass(`FPL ${r.season} 名單裡找得到他(出賽 ${hit.minutes} 分鐘)`);
    }

    const contradictions = checks.filter(c => !c.ok);
    const positives = checks.filter(c => c.positive);
    const verdict = contradictions.length ? 'contradicted'
      : positives.length ? 'confirmed'
        : checks.length ? 'consistent' : 'unverifiable';

    /* 交付檔自己帶了 verification.status。**不採用** —— 協作方回報「檢查全過」不算數(鐵則五)。
       但記下來,收工時可以比對「對方說 confirmed 的,本站核對結果是什麼」。 */
    out.push({
      ...r, verdict,
      claimedStatus: r.verification?.status ?? null,
      checks: checks.map(c => (c.ok ? '✓ ' : '✗ ') + c.msg),
      dataFail: checks.some(c => !c.ok && c.kind === 'data'),
      parentCode: parent?.code ?? null,
      loanCode: loanTo?.code ?? null,
    });
  }

  /* 同一個(賽季 + 租借目的地)是交付檔的一個區塊。區塊裡只要有紀錄被證明是錯的,
     剩下的就沒有可信度 —— 實測:6 筆「→ Alaves」有 5 筆被 Understat 證明其實在 Getafe,
     而交付檔裡「→ Getafe」的引進是 0 筆,顯然是整批標錯隊。
     這種時候把第 6 筆當「沒有矛盾」發布,等於在兩個對不上的來源裡挑一個喜歡的答案 ——
     進球明細那次的教訓就是整份不用,不是挑通過的用。 */
  const blocks = new Map();
  for (const r of out) {
    const k = `${r.season}|${clubKey(r.loanClub)}`;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k).push(r);
  }
  for (const list of blocks.values()) {
    const bad = list.filter(r => r.verdict === 'contradicted' && r.dataFail);
    if (!bad.length || bad.length === list.length) continue;
    for (const r of list) {
      if (r.verdict === 'consistent') {
        r.verdict = 'block-suspect';
        r.checks.push(`✗ 同一批「${r.season} → ${r.loanClub}」的 ${list.length} 筆裡有 ${bad.length} 筆被證明是錯的,整批不採用`);
      }
    }
  }

  const tally = {};
  for (const r of out) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  const bySeason = {};
  for (const r of out) {
    bySeason[r.season] ??= {};
    bySeason[r.season][r.verdict] = (bySeason[r.season][r.verdict] ?? 0) + 1;
  }

  const published = out.filter(r => r.verdict === 'confirmed' || r.verdict === 'consistent');
  /* 記下這一份是從哪一版收件匣核對出來的。

     沒有它的話會出現這個組合:交付方更新了收件匣,有人只跑 build ——
     build 讀的是舊的核對結果,畫面上照樣有資料,而且**不會有任何地方報錯**。
     這正是本專案最在意的那種靜靜出錯,所以雜湊要存,消費端要比對。 */
  const inboxSha = createHash('sha256')
    .update(readFileSync(join(ROOT, 'data', 'manual', 'loans.json')))
    .digest('hex');

  writeFileSync(join(ROOT, 'data', 'loans-verified.json'), `${JSON.stringify({
    _note: '產物:由 npm run loans:verify 從 data/manual/loans.json 核對後產生。不要手改,重跑就有。build 只讀這一份。',
    verifiedAt: new Date().toISOString(),
    inboxSha,
    sources: inbox.sources,
    excluded: inbox._excluded,
    tally,
    bySeason,
    /* 發布的只有 confirmed 與 consistent,而且等級跟著資料走 ——
       畫面要分得出「有獨立來源確認」與「只是沒有矛盾」。 */
    records: published.map(r => ({
      season: r.season, player: r.player,
      parentClub: r.parentClub, loanClub: r.loanClub,
      parentCode: r.parentCode, loanCode: r.loanCode,
      date: r.date ?? null, datePrecision: r.datePrecision ?? null,
      verdict: r.verdict,
      evidence: r.checks.filter(c => c.startsWith('✓')),
      source: r.source ?? null,
    })),
    /* 聯賽標籤對不上的紀錄照樣發布(標籤下游沒用到),但要列出來讓人看到、回報給交付方。 */
    labelIssues,
    rejected: out.filter(r => r.verdict === 'contradicted' || r.verdict === 'block-suspect').map(r => ({
      season: r.season, player: r.player, parentClub: r.parentClub, loanClub: r.loanClub,
      kind: r.dataFail ? 'data' : 'hygiene',
      why: r.checks.filter(c => c.startsWith('✗')),
    })),
    unverifiable: out.filter(r => r.verdict === 'unverifiable').map(r => ({
      season: r.season, player: r.player, parentClub: r.parentClub, loanClub: r.loanClub,
    })),
  }, null, 2)}\n`);

  console.log(`\n▶ 租借紀錄核對:${out.length} 筆`);
  for (const [s, t] of Object.entries(bySeason).sort()) {
    console.log(`  ${s}  ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join('・')}`);
  }
  console.log(`\n  發布 ${published.length} 筆(confirmed ${tally.confirmed ?? 0}・consistent ${tally.consistent ?? 0})`);
  console.log(`  不發布 ${(tally.contradicted ?? 0) + (tally.unverifiable ?? 0) + (tally['block-suspect'] ?? 0)} 筆`
    + `(矛盾 ${tally.contradicted ?? 0}・同批有錯 ${tally['block-suspect'] ?? 0}・無法核對 ${tally.unverifiable ?? 0})`);
  for (const r of out.filter(x => x.verdict === 'contradicted' || x.verdict === 'block-suspect')) {
    console.log(`    ✗ ${r.season} ${r.player}(${r.parentClub} → ${r.loanClub}):${r.checks.filter(c => c.startsWith('✗')).join(';')}`);
  }
  if (labelIssues.length) {
    console.log(`\n  ⚠ ${labelIssues.length} 筆的母隊聯賽標籤對不上(照樣發布,標籤下游沒用到,但要回報):`);
    for (const x of labelIssues.slice(0, 8)) console.log(`     ${x.season} ${x.player} —— ${x.club} ${x.why}`);
    if (labelIssues.length > 8) console.log(`     …還有 ${labelIssues.length - 8} 筆`);
  }
  console.log('\n→ data/loans-verified.json');
}
/* 直接執行才跑;被 test.mjs import 時只取純函式(matchPerson / yearShifted)。 */
if (process.argv[1] && process.argv[1].endsWith("verify-loans.mjs")) main();
