#!/usr/bin/env node
/* Obsidian vault 產生器 —— 把本站的資料集攤成互相連結的 Markdown 筆記。

   這是**產物**,不是資料源:重跑就有,不要手動編輯 vault/ 裡產生的檔案
   (改了下一次重跑就沒了)。手寫的筆記放 vault/我的筆記/,產生器永遠不碰那個資料夾。

   三條在這裡特別容易違反的鐵則:

   1. 不准編數字 —— 只搬資料集裡真的有的值。沒有的欄位整個不出現,
      不填 0、不填「—」。空欄位比不做更糟(鐵則三)。
   2. 不拿賽後重建的模型冒充賽前預測 —— 本季已完賽的場次,
      fixtures.json 的 prediction 是**建置時重算**的,而 build.mjs 的
      trainMatches = [...history, ...curPlayed],模型已經看過那場結果。
      所以已完賽場次不輸出預測數字,只說明沒有保存賽前快照。
      未賽場次的預測則是真的賽前預測,照寫。
   3. 同名不等於同一人 —— 見下面 assignFilenames 的註解。 */

import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isShootoutShot } from './lib/matchstats.mjs';
import { readMatchReports, readArchivedReports } from './lib/match-archive.mjs';
import { imageBytes } from './lib/image-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argOf = name => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const OUT = argOf('out') ?? join(ROOT, 'vault');

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const arr = x => (Array.isArray(x) ? x : Object.values(x ?? {}));
/* 英超的資料在 web/data 根目錄,其餘聯賽各自一個子目錄。
   原本非 pl 一律寫死成 'es1' —— 加第三個聯賽時它會安靜地把英冠資料讀成西甲的。 */
const dataDir = lg => (lg === 'pl' ? join(ROOT, 'web', 'data') : join(ROOT, 'web', 'data', 'leagues', lg));
const load = (lg, name) => {
  const p = join(dataDir(lg), `${name}.json`);
  return existsSync(p) ? read(p) : null;
};

const LEAGUES = [
  { key: 'pl', zh: '英超', dir: '英超', wf: 'backtest-matches.json' },
  /* wf 是各聯賽的走查回測逐場檔。**這裡原本是「不是英超就讀西甲的」二元判斷** ——
     加英冠時它不會壞(隊碼跟西甲不重疊,查不到而已),只是英冠自己的 552 筆
     賽前預測永遠掛不上 vault 的比賽筆記。同一個坑的第五處,一律走註冊表。 */
  { key: 'es1', zh: '西甲', dir: '西甲', wf: 'backtest-laliga-matches.json' },
  /* 英冠 2026-09-15 起有球員層(逐場累加,見 build-championship.mjs 檔頭)——
     形狀跟英超 / 西甲都不一樣,所以 collectPlayers 有自己的一支。
     產生器對缺檔本來就是 load() 回 null → 該區塊不寫,所以缺的東西不需要特判。 */
  { key: 'en2', zh: '英冠', dir: '英冠', wf: 'backtest-championship-matches.json' },
  /* 德甲(2026-09-15):目前只有球隊與比賽那一層,**沒有球員檔** ——
     產生器對缺檔本來就是 load() 回 null → 該區塊不寫,所以不需要為它特判,
     筆記裡就只會有球隊與比賽。球員層接上來之後這裡一個字都不用改。 */
  { key: 'de1', zh: '德甲', dir: '德甲', wf: 'backtest-bundesliga-matches.json' },
  /* 義甲 / 法甲(2026-09-15):球員層跟德甲同一條(Understat 整季彙總),所以
     collectPlayers 那一支直接涵蓋,這裡只要多兩列。 */
  { key: 'it1', zh: '義甲', dir: '義甲', wf: 'backtest-serie-a-matches.json' },
  { key: 'fr1', zh: '法甲', dir: '法甲', wf: 'backtest-ligue-1-matches.json' },
];
/* **這份清單是手寫的,而手寫的聯賽清單本站漏過三次。** 這裡不能改成掃
   `web/data/leagues/`:`wf`(走查回測的逐場檔)的檔名沒有可以推出來的規律
   (pl→backtest、es1→laliga、en2→championship、de1→bundesliga…),
   掃目錄只會讓新聯賽拿到一個不存在的檔名、賽前預測靜靜掛不上。
   所以改用**守門**:`npm test` 有一條拿 `web/data/leagues/` 逐個比對,
   少一個就紅 —— 漏掉的代價是那個聯賽整個從 vault 消失,而畫面完全正常。 */

/* ── Markdown / YAML 小工具 ──────────────────────────────────
   Obsidian 的檔名不能有這些字元;`[` `]` `#` `^` `|` 會跟連結與區塊語法打架。 */
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;
const sanitize = s => String(s).replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();

const yamlVal = v => {
  if (v === true || v === false || typeof v === 'number') return String(v);
  const s = String(v);
  // 會被 YAML 讀成別的型別或直接壞掉的,一律加引號
  return /^[\w一-鿿][\w一-鿿 .\-+/()]*$/.test(s) && !/^\d/.test(s)
    ? s : JSON.stringify(s);
};
/* 「有沒有值」只有這一個判斷,所有地方共用。

   空陣列踩過:西甲教練的 style 是 [],原本通過了 v !== '' 的檢查,
   渲染成一列空的「風格註解」—— 鐵則三說的正是這種東西
   (留一個永遠空白的欄位比不做更糟,讀者會以為是壞掉)。
   而且它同時讓「上游沒有給」那份清單漏列風格,兩個地方一起錯。 */
const hasValue = v => {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim() !== '';
};

/* frontmatter 只收真的有值的欄位。
   Dataview 查到一個永遠是空的欄位,跟畫面上留一個空欄位是同一種錯。 */
const frontmatter = obj => {
  const lines = Object.entries(obj)
    .filter(([, v]) => hasValue(v))
    .map(([k, v]) => (Array.isArray(v)
      ? `${k}:\n${v.map(x => `  - ${yamlVal(x)}`).join('\n')}`
      : `${k}: ${yamlVal(v)}`));
  return `---\n${lines.join('\n')}\n---\n`;
};

/* 表格只列有值的欄位。整張表都沒值就回空字串,連標題都不出現。 */
const defTable = rows => {
  const keep = rows.filter(([, v]) => hasValue(v));
  if (!keep.length) return '';
  return `| | |\n|---|---|\n${keep.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n`;
};
const statTable = (cols, row) => {
  const keep = cols.filter(([, key]) => hasValue(row?.[key]));
  if (!keep.length) return '';
  return `| ${keep.map(([label]) => label).join(' | ')} |\n`
    + `|${keep.map(() => '---').join('|')}|\n`
    + `| ${keep.map(([, key]) => row[key]).join(' | ')} |\n`;
};

const pct = v => (v === null || v === undefined ? null : (v * 100).toFixed(1) + '%');
/* 租借紀錄的核對等級。confirmed 與 consistent 對讀者的意義不同,不可以只寫「有紀錄」。 */
const loanConfidence = l => (l.verdict === 'confirmed'
  ? '這一筆有獨立來源正面確認。'
  : '這一筆只通過了「沒有矛盾」的檢查,沒有獨立來源正面確認。');

const notes = [];        // { path, links: [] }
const addNote = (path, body, links = []) => notes.push({ path, body, links });

/* 二進位資產(隊徽/頭貼)。跟筆記走同一條寫檔流程,頂層資料夾 `_資產`
   自動進清理範圍;檔名全域唯一(Obsidian 的 [[嵌入]] 跨資料夾用檔名解析)。 */
const assets = [];
const assetSeen = new Set();
const addAsset = (path, buf) => { if (!assetSeen.has(path)) { assetSeen.add(path); assets.push({ path, buf }); } };
// 產物裡的圖 2026-09-26 起是 assets/img/h/ 的路徑(單檔版才是 data URI);imageBytes 兩種都讀得回位元組
const dataUriBuf = uri => imageBytes(uri, { webDir: join(ROOT, 'web') });
const wl = name => `[[${name}]]`;
/* 射門情境的中文(供應商的代碼)。聯賽的比賽筆記與盃賽/歐冠的賽後報告共用這一張,不各寫一份 */
const SHOT_SIT_ZH = { RegularPlay: '運動戰', FromCorner: '角球', FastBreak: '快攻', FreeKick: '任意球', SetPiece: '定位球', ThrowInSetPiece: '界外球', IndividualPlay: '個人突破', Penalty: '十二碼' };
/* 逐場詳情的讀法與事件中文(renderDetailReport 用;聯賽、盃賽、歐冠共用)。放在這裡是因為主流程就會用到 —— 見 renderDetailReport 上面那段 */
const loadDetail = rel => {
  const p = join(ROOT, 'web', 'data', rel + '.json');
  return existsSync(p) ? read(p) : null;
};
const EVENT_ZH = { Goal: '進球', Card: '牌', subst: '換人', Var: 'VAR' };
const reportCount = { ucl: 0, cup: 0 };   // 併進比賽筆記的賽後報告有幾場(印在摘要與 README)
const boardCount = { ucl: 0, cup: 0 };    // 盃賽與歐冠的球員榜開了幾季(一季一則)
const textOf = v => (v == null ? '' : typeof v === 'object' ? (v.defaultText ?? '') : String(v));

/* ── 球員:兩個聯賽正規化成同一個形狀 ────────────────────────
   一定要走同一個 renderPlayer。各寫一份的話,兩邊的欄位取捨會慢慢分岔,
   而 vault 看起來仍然正常 —— 這是專案在跨聯賽頁面上踩過的同一個坑。 */
function collectPlayers(lg, meta) {
  const raw = arr(load(lg.key, 'players'));
  /* 英冠:一人一季一筆(season + team + providerId),數字是**逐場累加**出來的。
     **一定要有自己的一支** —— 沒有的話會掉進下面西甲那一支,而它用 `p.id` 當鍵,
     英冠沒有那個欄位 → 1,338 筆全部併成一筆 key 為 undefined 的垃圾筆記,而且不會報錯
     (「不是英超就是西甲」那條坑的第六處)。
     跨季用上游的 providerId 串:兩季都出現的 331 人裡 315 人姓名完全相同,
     其餘 16 筆是同一人的拼法或暱稱差異(核對過,不是假設)。 */
  if (lg.key === 'en2') {
    const byId = new Map();
    for (const p of raw) {
      const key = p.providerId ?? `${p.team}|${p.name}`;
      if (!byId.has(key)) byId.set(key, []);
      byId.get(key).push(p);
    }
    return [...byId.entries()].map(([key, rows]) => {
      const newest = rows.slice().sort((a, b) => String(b.season).localeCompare(String(a.season)))[0];
      return {
        id: `en2:${key}`, base: newest.name, display: newest.name, code: null, tracking: null,
        /* 上游的球員 id(FotMob)。球員榜的列帶的就是它(`pid`),榜上的連結靠它對到這則筆記 —— 不比姓名 */
        fotmobId: newest.providerId != null ? String(newest.providerId) : null,
        teamCode: newest.team, pos: newest.pos, posZh: { G: '門將', D: '後衛', M: '中場', F: '前鋒' }[newest.pos] ?? null,
        squadNumber: newest.shirt, age: null, dob: null, height: null, weight: null, captain: null,
        statusZh: null, news: null, price: null, photo: null, loans: [],
        seasons: rows.slice().sort((a, b) => String(a.season).localeCompare(String(b.season))).map(r => ({
          season: r.season, kind: r.season === meta.currentSeason ? '本季至今' : null,
          /* statTable 讀的是扁平的鍵,所以把累加的 stats 攤平成跟另外兩個聯賽同名的欄位。
             **沒有的鍵不要補 0** —— 上游沒記就是沒記(0 會被讀成「量到了,結果是零」)。 */
          stats: { games: r.matches, minutes: r.minutes, goals: r.stats.goals, assists: r.stats.goal_assist,
            xG: r.stats.expected_goals, xA: r.stats.expected_assists, shots: r.stats.shots_total,
            keyPasses: r.stats.total_att_assist, yellow: r.stats.yellow_card, red: r.stats.red_card,
            rating: r.stats.rating },
          teams: [r.teamName].filter(Boolean),
        })),
        sources: { 表現統計: 'FotMob 逐場累加', 身分與背號: 'FotMob 逐場名單' },
      };
    });
  }
  if (lg.key === 'pl') {
    return raw.map(p => ({
      id: `pl:${p.code}`, base: p.fullName || p.name, display: p.name,
      fplCode: String(p.code),   // 球員榜的列帶的是這個(leaders.json 的 code),榜上的連結靠它對 —— 不比姓名
      teamCode: p.team, pos: p.pos, posZh: p.posZh, squadNumber: p.squadNumber,
      age: p.age, dob: p.dateOfBirth, height: p.height, weight: p.weight,
      captain: p.captain || null, statusZh: p.statusZh, news: p.news || null,
      price: p.price, transferred: p.transferred || null, lastTeam: p.lastTeam,
      tracking: p.tracking ?? null,   // 逐人跑動與熱區(FotMob),沒有就 null,renderPlayer 整節不寫
      code: p.code,                   // 逐場紀錄用 code 查 player-logs
      photo: p.photo ?? null,
      loans: p.loans ?? [],
      seasons: [
        { season: meta.lastSeason, kind: '上季', stats: p.last },
        { season: meta.currentSeason, kind: '本季至今', stats: p.current },
      ].filter(s => s.stats && Object.keys(s.stats).length),
      sources: { 表現統計: 'FPL', 身分與背號: 'SportMonks' },
    }));
  }
  /* 西甲的 players.json 是「一人一季一筆」——同一個人跨兩季會出現兩次。
     實測 966 筆裡有 266 組是同一個 Understat id 的跨季重複,去重後 700 人。
     不去重的話會產生兩個同名檔案,而 Obsidian 的 [[連結]] 靠檔名解析,
     會靜靜指到其中一個。 */
  const byId = new Map();
  for (const p of raw) {
    if (!byId.has(p.id)) byId.set(p.id, { ...p, seasons: [] });
    byId.get(p.id).seasons.push(p);
  }
  return [...byId.values()].map(p => {
    const newest = p.seasons.slice().sort((a, b) => String(b.season).localeCompare(String(a.season)))[0];
    return {
      /* 西甲、德甲、義甲、法甲都走這一支(都是 Understat)。前綴原本寫死 'es1:' ——
         德義法的球員 id 也掛著西甲的前綴(「不是英超就是西甲」那條坑);只是目前沒有人拿它查東西,所以沒炸。 */
      id: `${lg.key}:${p.id}`, base: newest.fullName || newest.name, display: newest.name,
      /* Understat 的球員 id **跨聯賽共用**(understat.com/player/{id}):上季在法甲、本季在德甲的人,
         兩個聯賽的資料裡是同一個 id。同名提醒靠它分得出「同一人」與「只是同名」。 */
      understatId: String(p.id),
      code: newest.code ?? String(p.id), tracking: newest.tracking ?? null,   // 逐場紀錄與跑動/熱區/評分(FotMob),跟英超分支一樣
      teamCode: (newest.teamCodes || [])[0] ?? null, pos: newest.pos, posZh: newest.posZh,
      squadNumber: newest.squadNumber, age: newest.age, dob: newest.dateOfBirth,
      height: newest.height, weight: newest.weight, captain: null,
      statusZh: null, news: null, price: null,
      photo: newest.photo ?? null,
      // 西甲是一人一季一筆,租借掛在哪一筆都算這個人的,收成一份去重
      loans: [...new Map(p.seasons.flatMap(s => s.loans ?? [])
        .map(l => [l.season + l.direction + l.loanCode, l])).values()],
      seasons: p.seasons
        .slice().sort((a, b) => String(a.season).localeCompare(String(b.season)))
        .map(s => ({ season: s.season, kind: null, stats: s, teams: s.teams })),
      /* 來源照產物自己宣告的(`dataSources`)。原本寫死「身分與背號:SportMonks」——
         西甲是對的,德義法**沒有**身分來源(Understat 不給背號、頭貼與出生日期),
         於是那三個聯賽的每一則球員筆記都寫著一個它根本沒用的來源(「寫死的不是聯賽名,是資料來源」那條坑)。 */
      sources: { 表現統計: newest.dataSources?.performance ?? 'Understat', 身分與背號: newest.dataSources?.identity ?? null },
    };
  });
}

/* ── 檔名:唯一性是被驗證出來的,不是假設的 ──────────────────
   以 fullName 當檔名會撞名。只有英超西甲時量到 15 組(13 組跨聯賽);六個聯賽之後是幾百組 ——
   **數字由產生器每次算、印在 README**(`homonymStats`),不寫在這裡:這裡原本寫著「13 組」,
   加了四個聯賽之後沒有人回來改。

   撞名的**不合併**,各自成篇、檔名加隊碼區分。是不是同一人看**有沒有共用的球員 id**:
   西甲、德甲、義甲、法甲都走 Understat,而它的球員 id 跨聯賽共用 —— 同一個 id 就是同一人
   (上季在法甲、本季在德甲的轉會球員),不同 id 就是不同人;英超(FPL)與英冠(FotMob)
   跟別人沒有共用 id,無法核對,「看起來是同一人」不是證據(鐵則五)。
   (這一段原本寫「兩份資料源從來沒有同時給出 sportmonksId,0 組可以核對」——
   那是只有英超西甲時的事;德義法接上之後有一百多組是同一個 Understat id,筆記卻還寫著無法核對。) */
const homonymStats = { groups: 0, cross: 0, sameId: 0, diffId: 0 };
function assignFilenames(players) {
  const byBase = new Map();
  for (const p of players) {
    const b = sanitize(p.base);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }
  for (const [b, group] of byBase) {
    for (const p of group) {
      p.file = group.length === 1 ? b : sanitize(`${b} (${p.teamCode ?? p.leagueZh})`);
      if (group.length > 1) p.homonyms = group.filter(x => x !== p);
    }
    if (group.length < 2) continue;
    homonymStats.groups++;
    if (new Set(group.map(p => p.leagueZh)).size > 1) homonymStats.cross++;
    /* 同一個聯賽裡同一個 Understat id 已經被 collectPlayers 併成一人,所以「同 id」只會是跨聯賽的 */
    const u = group.filter(p => p.understatId);
    if (u.length > 1) {
      if (new Set(u.map(p => p.understatId)).size < u.length) homonymStats.sameId++;
      else homonymStats.diffId++;
    }
  }
  /* **隊碼不一定分得開。** 英冠球員層(2026-09-15)接上之後出現第二層撞名:
     同一個人可以同時在英超與英冠的名單裡,而且**隊碼一樣** —— 升班的球隊(例如 Coventry)
     上季在英冠、本季在英超,他在英冠那一份是上季的紀錄、在英超那一份是本季的,兩邊 teamCode 都是 COV。
     實測 52 組。加隊碼之後仍然撞的,再加聯賽(跟球隊筆記同一條慣例);
     **聯賽照 LEAGUES 的順序讓排前面的那一個保持原名** —— 改名會斷掉手寫筆記裡既有的連結。 */
  const byFile = new Map();
  for (const p of players) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  for (const [f, group] of byFile) {
    if (group.length < 2) continue;
    const order = LEAGUES.map(l => l.zh);
    const sorted = group.slice().sort((x, y) => order.indexOf(x.leagueZh) - order.indexOf(y.leagueZh));
    sorted.forEach((p, i) => { if (i > 0) p.file = sanitize(`${f}・${p.leagueZh}`); });
    for (const p of group) p.homonyms = [...new Set([...(p.homonyms ?? []), ...group.filter(x => x !== p)])];
  }
}

function renderPlayer(p, ctx) {
  const teamName = ctx.teamNameOf(p.teamCode);
  const body = [];
  body.push(frontmatter({
    類型: '球員', 聯賽: ctx.lg.zh, 球隊: teamName, 隊碼: p.teamCode,
    位置: p.posZh || p.pos, 背號: p.squadNumber, 年齡: p.age, 出生日期: p.dob,
    身高cm: p.height, 體重kg: p.weight, 隊長: p.captain || null,
    狀態: p.statusZh, FPL身價百萬英鎊: p.price,
    租借紀錄數: p.loans?.length || null,
    表現統計來源: p.sources.表現統計, 身分來源: p.sources.身分與背號,
    /* 跨聯賽共用的身分鍵(西甲、德義法)。同名提醒靠它判「同一人 / 不同人」,放進 frontmatter 讓讀者與測試都查得到 */
    Understat球員id: p.understatId,
    /* 英超與英冠的上游 id(2026-09-26,球員榜那一輪):榜上的連結用 id 對到筆記,測試拿它驗連結指的是同一個人 */
    FPL球員code: p.fplCode, FotMob球員id: p.fotmobId,
    產生時間: ctx.builtAt,
  }));
  body.push(`\n# ${p.base}\n`);
  if (p.photoEmbed) body.push(`\n${p.photoEmbed}\n`);
  if (p.display && p.display !== p.base) body.push(`> 常用稱呼:${p.display}\n`);
  if (p.tracking && (p.tracking.distancePerGame != null || p.tracking.heat || p.tracking.rating)) {
    const tr = p.tracking;
    body.push(`\n## 跑動、熱區與評分(FotMob)\n\n`);
    if (tr.distancePerGame != null) body.push(`- 場均跑動 ${(tr.distancePerGame / 1000).toFixed(1)} km(${tr.games} 場)\n`);
    if (tr.topSpeed != null) body.push(`- 最高速度 ${tr.topSpeed.toFixed(1)} km/h\n`);
    if (tr.rating) body.push(`- FotMob 平均評分 ${tr.rating.avg.toFixed(2)}(${tr.rating.games} 場有評分)\n`);
    if (tr.heat) body.push(`- 觸球質心 (${tr.heat.cx}, ${tr.heat.cy}),離散度 ${tr.heat.spread},${tr.heat.touches} 次觸球 / ${tr.heat.games} 場(座標 105×68,自家球門在左)\n`);
    if (tr.heat?.grid?.length === 24) {
      body.push(`\n6×4 觸球格(左=自家半場):\n\n`);
      for (let r = 0; r < 4; r++) body.push(`| ${tr.heat.grid.slice(r * 6, r * 6 + 6).join(' | ')} |\n${r === 0 ? '|---|---|---|---|---|---|\n' : ''}`);
    }
    body.push(`\n> 不是每場都有追蹤資料,場數另記;本站只搬運不推估。\n`);
  }
  /* links 在下面才宣告(球隊、名單那些),這裡先收進 logOppLinks,宣告 links 時併進去 —— 直接 push 會 TDZ 炸掉(踩到) */
  const logOppLinks = [];
  const logs = p.code != null ? ctx.logsFor?.(p.code) : null;
  if (logs?.length) {
    const v = x => (x == null ? '—' : x);
    body.push(`\n## 逐場紀錄(FotMob,${logs.length} 場)\n\n| 日期 | 對手 | 比分 | 分鐘 | 評分 | 球 | 助 | 射門/正 | 關鍵傳球 | xG | 跑動 km |\n|---|---|---|---|---|---|---|---|---|---|---|\n`);
    for (const r of [...logs].sort((a, b) => b.date.localeCompare(a.date))) {
      const opp = ctx.teamNameOf(r.opp);
      if (opp) logOppLinks.push(opp);
      body.push(`| ${r.date} | ${r.home ? '主' : '客'} ${opp ? wl(opp) : r.opp} | ${r.score} | ${r.min}${r.sub ? '↑' : ''} | ${r.rating == null ? '—' : r.rating.toFixed(1)} | ${v(r.goals)} | ${v(r.assists)} | ${v(r.shots)}/${v(r.shotsOn)} | ${v(r.keyPasses)} | ${r.xg == null ? '—' : r.xg.toFixed(2)} | ${r.distance == null ? '—' : (r.distance / 1000).toFixed(1)} |\n`);
    }
    body.push(`\n> ↑ = 替補上場。xG 是該場逐射門 xG 合計;跑動是追蹤資料,不是每場都有。\n`);
  }

  const links = [...logOppLinks];
  if (teamName) { links.push(teamName); }
  const teamCell = teamName ? wl(teamName)
    : (p.teamCode ? `${p.teamCode} —— 本季不在${ctx.lg.zh},沒有球隊筆記` : null);
  const info = defTable([
    ['球隊', teamCell],
    ['位置', p.posZh || p.pos],
    ['背號', p.squadNumber],
    ['年齡', p.age],
    ['身高 / 體重', p.height && p.weight ? `${p.height} cm / ${p.weight} kg` : null],
    ['狀態', p.statusZh],
    ['傷停消息', p.news],
  ]);
  if (info) body.push(`\n${info}`);

  for (const s of p.seasons) {
    const t = statTable(ctx.statCols, s.stats);
    if (!t) continue;
    body.push(`\n## ${s.season}${s.kind ? `(${s.kind})` : ''}\n\n`);
    /* 一整排 0 會被讀成「他在這個聯賽整季沒上場」,但上游分不出那件事。
       實測英超有 56 人上季 minutes=0 —— 其中包含外借到別的聯賽的人
       (Rashford 上季在巴薩,FPL 一樣記 0)。所以不放那張全 0 的表,
       改成講清楚這個 0 代表什麼、不代表什麼。 */
    const appeared = (s.stats.minutes ?? 0) > 0 || (s.stats.games ?? 0) > 0;
    if (!appeared) {
      /* 有一筆核對過的外借紀錄,這個 0 就講得清楚是哪一種了。
         沒有的話仍然照實說分不出來 —— 不要用「大概是外借」把空白補起來。 */
      const out = (p.loans ?? []).find(l => l.season === s.season && l.direction === 'out');
      if (out) {
        body.push(`${p.sources.表現統計} 沒有這一季的出賽紀錄,**因為他當季外借到 ${out.loanClub}**。\n\n`
          + `> 這個 0 是「當季不在${ctx.lg.zh}」,不是「在${ctx.lg.zh}但沒上場」——\n`
          + `> 上游的 0 本來分不出這兩件事,是租借紀錄補上的。${loanConfidence(out)}\n`);
      } else {
        body.push(`${p.sources.表現統計} 沒有這一季的出賽紀錄。\n\n`
          + `> **這個 0 分不出兩件事**:「在${ctx.lg.zh}但沒上場」與「當季不在${ctx.lg.zh}」。\n`
          + `> 外借到其他聯賽的球員在 ${p.sources.表現統計} 一樣是 0,而本站沒有這一季的租借紀錄可以分辨。\n`);
      }
      continue;
    }
    body.push(t);
    if (s.teams?.length) body.push(`\n所屬:${s.teams.join('、')}\n`);
  }

  if (p.loans?.length) {
    body.push(`\n## 租借紀錄\n\n`);
    body.push(`| 賽季 | 方向 | 母隊 | 租借目的地 | 日期 | 核對 |\n|---|---|---|---|---|---|\n`);
    for (const l of p.loans) {
      body.push(`| ${l.season} | ${l.direction === 'out' ? '租出' : '租入'} | ${l.parentClub} | ${l.loanClub} `
        + `| ${l.date ?? (l.datePrecision ? l.datePrecision + '(只到這個精度)' : '不詳')} `
        + `| ${l.verdict === 'confirmed' ? '獨立來源確認' : '無矛盾'} |\n`);
    }
    /* 核對等級一定要跟數字一起出現。「有獨立來源確認」與「只是沒查到矛盾」
       對讀者的意義差很多,混成一句「有租借紀錄」就等於把不確定性藏起來(鐵則四)。 */
    body.push(`\n> 人工整理的租借資料,由 \`npm run loans:verify\` 拿本站的逐季聯賽成員資格、\n`
      + `> FPL 逐季出賽分鐘與西甲逐季球員核對過。**「獨立來源確認」**是有其他來源正面\n`
      + `> 指出他當季在那一隊;**「無矛盾」**只代表查得動的檢查都沒有衝突,不是同一件事。\n`);
  }

  /* 同名的處理照鐵則四寫在筆記上,不靠讀者自己發現。 */
  if (p.homonyms?.length) {
    body.push(`\n## 同名提醒\n`);
    body.push(`\n這個名字在本站資料裡不只一筆,各自成篇、不合併。是不是同一人,要看兩邊有沒有**共用的球員 id**:\n`);
    for (const h of p.homonyms) {
      /* 西甲、德義法都走 Understat,它的球員 id 跨聯賽共用:同一個 id 就是同一人、不同就是不同人。
         英超(FPL)與英冠(FotMob)跟別人沒有共用 id —— 那一種才是「無法核對」。
         原本這裡一律寫「沒有共用 id」,德義法接上之後就有一百多組其實查得到。 */
      const both = p.understatId && h.understatId;
      /* 租借紀錄接得上的話,同名這件事就有證據了 ——
         「Brighton → Elche」正好把英超那一則與西甲那一則接起來。
         但這仍然是第三方的說法,不是共用 id,所以是「有紀錄支持」不是「已證實」。 */
      const bridge = both ? null : (p.loans ?? []).find(l => l.loanCode === h.teamCode || l.parentCode === h.teamCode);
      body.push(`- ${wl(h.file)} —— ${h.leagueZh} / ${h.teamCode ?? '球隊未知'}`
        + (both && p.understatId === h.understatId
          ? `。**同一人**:兩邊是同一個 Understat 球員 id(${p.understatId}),而 Understat 的 id 跨聯賽共用 ——`
            + ` 兩則是他在不同聯賽的紀錄,只是本站分成兩則筆記。`
          : both
            ? `。**不同人**:Understat 球員 id 不同(${p.understatId} / ${h.understatId}),只是同名。`
            : bridge
              ? `。**有一筆${bridge.verdict === 'confirmed' ? '經獨立來源確認' : '核對無矛盾'}的租借紀錄接得起來**`
                + `(${bridge.season} ${bridge.parentClub} → ${bridge.loanClub}),支持是同一人 ——`
                + ` 但那仍是第三方說法,兩邊資料源沒有共用 id,所以不合併。`
              : '。兩邊的資料源沒有共用的球員 id,**無法核對**是不是同一人,所以不宣稱是。') + '\n');
      links.push(h.file);
    }
  }

  body.push(`\n## 資料界線\n`);
  body.push(p.sources.身分與背號
    ? `\n- 表現統計來自 **${p.sources.表現統計}**,身分與背號來自 **${p.sources.身分與背號}**\n`
    : `\n- 表現統計來自 **${p.sources.表現統計}**;身分與背號:這個聯賽**沒有來源**(不是漏了,見下一行)\n`);
  if (ctx.playerGaps.length) body.push(`- 這個聯賽拿不到:${ctx.playerGaps.join('、')}\n`);
  body.push(`- 建置時間 ${ctx.builtAt};數值全部來自本站資料集,沒有推估值\n`);

  return { body: body.join(''), links };
}

/* ── 球隊 ────────────────────────────────────────────────── */
function renderTeam(t, ctx) {
  const name = t.en;
  const squad = ctx.playersByTeam.get(t.code) ?? [];
  const fixtures = ctx.fixturesByTeam.get(t.code) ?? [];
  const ls = t.lastSeason, cur = t.current;
  const links = [];
  const body = [];

  body.push(frontmatter({
    類型: '球隊', 聯賽: ctx.lg.zh, 隊碼: t.code, 中文名: t.zh, 暱稱: t.nickname,
    城市: t.city, 主場: t.venue, 容量: t.capacity, Elo: t.elo,
    上季名次: ls?.pos, 上季積分: ls?.pts, 本季名次: cur?.pos, 本季積分: cur?.pts,
    名單人數: squad.length || null, 產生時間: ctx.builtAt,
  }));
  body.push(`\n# ${name}${t.zh ? `(${t.zh})` : ''}\n`);
  const ce = ctx.crestEmbed?.(t.code);
  if (ce) body.push(`\n${ce}\n`);

  const info = defTable([
    ['隊碼', t.code], ['城市', t.city], ['主場', t.venue],
    ['容量', t.capacity ? t.capacity.toLocaleString('en-US') : null],
    ['Elo', t.elo], ['聯賽', ctx.lg.zh],
  ]);
  if (info) body.push(`\n${info}`);

  if (!t.rich) {
    /* 名冊裡有、但本季不在這個聯賽的球隊。給筆記是為了讓歷史比賽與球員連得過去,
       但要講明白為什麼沒有賽季數據 —— 不然看起來像資料掉了。 */
    body.push(`\n> **這支球隊本季不在${ctx.lg.zh}。** 只有身分資料與歷史比賽,`
      + `沒有本季或上季的賽季統計 —— 那些資料本站只收目前在這個聯賽的球隊。\n`);
  }

  const coach = ctx.coachOf(t.code);
  if (coach?.name) {
    const cf = ctx.coachFileOf(t.code);
    body.push(`\n## 現任教練\n\n${cf ? wl(cf) : `**${coach.name}**`}`);
    if (coach.source) body.push(` —— 來源:${coach.source}`);
    body.push('\n');
    if (cf) links.push(cf);
  }

  /* 租借往來(球隊視角)。跨聯賽單一份 loans.json,隊碼指俱樂部所以升降級不影響。
     球員名字不加 [[連結]] —— 租借對象常不在本站名單(239 筆配不到),而 Obsidian
     的連結是跨資料夾用檔名解析的,配錯人比連不到糟。等級照鐵則四分開標。 */
  const loans = ctx.loansFor?.(t.code) ?? [];
  if (loans.length) {
    body.push(`\n## 租借往來\n\n| 賽季 | 方向 | 球員 | 對象 | 核對 |\n|---|---|---|---|---|\n`);
    for (const r of [...loans].sort((a, b) => b.season.localeCompare(a.season) || a.player.localeCompare(b.player))) {
      const out = r.parentCode === t.code;
      body.push(`| ${r.season} | ${out ? '外借' : '借入'} | ${r.player} | ${(out ? r.loan : r.parent) ?? '?'} | ${r.verdict === 'confirmed' ? '已確認' : '無矛盾'} |\n`);
    }
    body.push(`\n> 人工交付、經 \`npm run loans:verify\` 逐筆核對後發布。`
      + `「已確認」= 有獨立來源正面確認;「無矛盾」= 查得動的檢查都通過但沒有正面確認 —— 兩者可信度不同。\n`);
  }

  /* 本季的賽季模擬與近況(2026-09-26):只有本季在這個聯賽的球隊有(teams.json / form.json 只收它們) */
  if (t.rich) {
    body.push(renderSim(t.sim, ctx));
    const fr = renderForm(t.code, ctx);
    body.push(fr.text);
    links.push(...fr.links);
  }

  if (ls) {
    body.push(`\n## ${ctx.lastSeason} 全季\n\n`);
    body.push(statTable([['名次', 'pos'], ['場次', 'p'], ['勝', 'w'], ['和', 'd'], ['負', 'l'],
      ['進球', 'gf'], ['失球', 'ga'], ['淨勝', 'gd'], ['積分', 'pts'], ['場均勝點', 'ppg'],
      ['零封', 'cleanSheets']], ls));
    if (ls.home && ls.away) {
      body.push(`\n### 主客場\n\n| | 場次 | 勝 | 和 | 負 | 進 | 失 | 場均勝點 |\n|---|---|---|---|---|---|---|---|\n`);
      body.push(`| 主場 | ${ls.home.p} | ${ls.home.w} | ${ls.home.d} | ${ls.home.l} | ${ls.home.gf} | ${ls.home.ga} | ${ls.home.ppg} |\n`);
      body.push(`| 客場 | ${ls.away.p} | ${ls.away.w} | ${ls.away.d} | ${ls.away.l} | ${ls.away.gf} | ${ls.away.ga} | ${ls.away.ppg} |\n`);
    }
    if (ls.half) {
      const h = ls.half;
      body.push(`\n### 半場行為\n\n| | 進球 | 失球 |\n|---|---|---|\n`);
      body.push(`| 上半場 | ${h.gf1} | ${h.ga1} |\n| 下半場 | ${h.gf2} | ${h.ga2} |\n`);
    }
    if (ls.longest) {
      const L = ls.longest;
      body.push(`\n### 最長連續\n\n`);
      body.push(statTable([['連勝', 'win'], ['不敗', 'unbeaten'], ['不勝', 'winless'],
        ['連續零封', 'cleanSheet'], ['連續進球', 'scoring']], L));
    }
  }

  /* 上季數據風格與本季陣型(2026-09-26):teams.json 的 tactics(戰術頁同一份)與 shapes.json */
  if (t.rich) {
    body.push(renderTactics(t, ctx));
    body.push(renderShape(ctx.shapeFor(t.code), ctx));
  }

  /* 逐場進球明細在發布的資料裡是**球隊層級的整季彙總**,不是逐顆球的紀錄。
     所以放在球隊筆記,不掛到某一場比賽上 —— 掛上去就是我們沒有的資料。 */
  const g = ctx.goalsFor(t.code);
  if (g) {
    body.push(`\n## ${ctx.goalsSeason} 進球明細\n\n`);
    body.push(statTable([['進球', 'for'], ['失球', 'against'], ['助攻', 'assists'],
      ['先發者進球', 'starterGoals'], ['替補進球', 'subGoals'],
      ['己方烏龍', 'ownFor'], ['對手烏龍', 'ownAgainst']], g));
    if (g.vs?.length) {
      body.push(`\n### 對各隊進失球\n\n| 對手 | 進 | 失 |\n|---|---|---|\n`);
      for (const v of g.vs) {
        const nm = ctx.teamNameOf(v.opp);
        if (nm) links.push(nm);
        body.push(`| ${nm ? wl(nm) : v.opp} | ${v.f} | ${v.a} |\n`);
      }
    }
    if (ctx.goalsNote) body.push(`\n> ${ctx.goalsNote}\n`);
  }

  const tms = ctx.teamMatchStatsFor?.(t.code);
  if (tms?.games) {
    const SIT = { RegularPlay: '運動戰', FromCorner: '角球', FastBreak: '快攻', FreeKick: '任意球', SetPiece: '定位球', ThrowInSetPiece: '界外球', IndividualPlay: '個人突破', Penalty: '十二碼' };
    const v = x => (x == null ? '—' : x);
    body.push(`\n## 逐場統計(FotMob,${tms.seasons.join(' + ')},${tms.games} 場)\n\n`);
    body.push(`| | 主場(${tms.home.games}) | 客場(${tms.away.games}) |\n|---|---|---|\n`);
    body.push(`| 控球 % | ${v(tms.home.possession.mean)} ±${v(tms.home.possession.sd)} | ${v(tms.away.possession.mean)} ±${v(tms.away.possession.sd)} |\n`);
    body.push(`| 射門 / 被射門 | ${v(tms.home.shotsFor)} / ${v(tms.home.shotsAgainst)} | ${v(tms.away.shotsFor)} / ${v(tms.away.shotsAgainst)} |\n`);
    body.push(`| xG / xGA | ${v(tms.home.xgFor)} / ${v(tms.home.xgAgainst)} | ${v(tms.away.xgFor)} / ${v(tms.away.xgAgainst)} |\n`);
    body.push(`| 角球 | ${v(tms.home.cornersFor)} | ${v(tms.away.cornersFor)} |\n| 犯規 | ${v(tms.home.foulsFor)} | ${v(tms.away.foulsFor)} |\n`);
    if (tms.physical) {
      const ph = tms.physical;
      body.push(`\n### 跑動與速度(${ph.games} 場有追蹤資料)\n\n| 跑動 / 場 | 衝刺距離 / 場 | 衝刺次數 / 場 |\n|---|---|---|\n| ${(ph.distancePerGame / 1000).toFixed(1)} km | ${ph.sprintDistancePerGame} m | ${ph.sprintsPerGame} |\n`);
      if (ph.players.length) {
        body.push(`\n| 球員 | 場 | 跑動 / 場 | 最高速度 |\n|---|---|---|---|\n`);
        for (const p of ph.players.slice(0, 15)) body.push(`| ${p.shirt ?? ''} ${p.name} | ${p.games} | ${(p.distancePerGame / 1000).toFixed(1)} km | ${p.topSpeed == null ? '—' : p.topSpeed.toFixed(1) + ' km/h'} |\n`);
      }
    }
    const sits = Object.entries(tms.situations ?? {}).sort((a, b) => b[1].shots - a[1].shots);
    if (sits.length) {
      body.push(`\n### 射門情境(${tms.shotSample} 次)\n\n| 情境 | 射門 | 進球 | 份額 | xG/射門 |\n|---|---|---|---|---|\n`);
      for (const [k, x] of sits) body.push(`| ${SIT[k] ?? k} | ${x.shots} | ${x.goals} | ${(x.share * 100).toFixed(0)}% | ${x.xgPerShot} |\n`);
    }
    body.push(`\n> 逐場資料直接取自 FotMob 的球隊統計與 shotmap;± 是各場控球率的標準差。跟「進球明細」與 Understat 的整季分類是不同來源。\n`);
  }

  if (squad.length) {
    body.push(`\n## 名單(${squad.length} 人)\n\n`);
    const byPos = new Map();
    for (const p of squad) {
      const k = p.posZh || p.pos || '未分類';
      if (!byPos.has(k)) byPos.set(k, []);
      byPos.get(k).push(p);
    }
    for (const [pos, list] of byPos) {
      body.push(`**${pos}** —— ${list.map(p => { links.push(p.file); return wl(p.file); }).join(' · ')}\n\n`);
    }
  }

  if (fixtures.length) {
    body.push(`\n## ${ctx.currentSeason} 賽程\n\n`);
    for (const f of fixtures) {
      links.push(f.file);
      const vs = f.home === t.code ? `主場 vs ${ctx.teamNameOf(f.away)}` : `客場 @ ${ctx.teamNameOf(f.home)}`;
      const score = f.played ? ` —— ${f.fh}:${f.fa}` : '';
      body.push(`- ${f.date} 第 ${f.round} 輪 ${vs}${score} → ${wl(f.file)}\n`);
    }
  }

  /* 外電與動態(2026-09-26):提到這一隊的每一則(看產物的 teams / team 標記,不用隊名關鍵字撈 ——
     United / City 會把別隊混進來,站上動態頁同一條規矩)。全部的在聯賽那一則。 */
  const news = ctx.newsFor(t.code);
  if (news.length) {
    body.push(`\n## 外電與動態(${news.length} 則,提到這一隊的)\n\n`);
    for (const n of news) {
      const u = mdUrl(n.link);
      body.push(`- ${n.date}・${n.cat}・${n.titleZh ?? n.title}${n.body ? ` —— ${n.bodyZh ?? n.body}` : ''}${u ? ` [${n.source ?? '原文'}](${u})` : ''}`
        + `${n.curated ? (n.curator?.kind === 'ai' ? '(AI 整理摘要)' : '(人工整理摘要)') : ''}\n`);
    }
    body.push(`\n> 每一則的來源與整理方式見 ${wl(ctx.newsFile)}。\n`);
    links.push(ctx.newsFile);
  }

  const past = ctx.historyByTeam.get(t.code) ?? [];
  if (past.length) {
    body.push(`\n## 歷史比賽(${past.length} 場)\n\n`);
    const bySeason = new Map();
    for (const m of past) {
      if (!bySeason.has(m.season)) bySeason.set(m.season, []);
      bySeason.get(m.season).push(m);
    }
    for (const [season, list] of [...bySeason].sort((a, b) => b[0].localeCompare(a[0]))) {
      body.push(`**${season}**(${list.length} 場)\n\n`);
      for (const m of list) {
        links.push(m.file);
        const opp = m.home === t.code ? ctx.teamNameOf(m.away) : ctx.teamNameOf(m.home);
        const ha = m.home === t.code ? '主' : '客';
        const score = m.played ? `${m.fh}:${m.fa}` : '未賽';
        body.push(`- ${m.date} ${ha} vs ${opp ?? (m.home === t.code ? m.away : m.home)} ${score} → ${wl(m.file)}\n`);
      }
      body.push('\n');
    }
  }

  body.push(`\n## 資料界線\n\n- 聯賽:${ctx.lg.zh}・本季 ${ctx.currentSeason}・上季 ${ctx.lastSeason}\n`);
  body.push(`- 全部數值由本站資料集直接搬運,沒有在這裡重新計算或推估\n`);
  body.push(`- 建置時間 ${ctx.builtAt}\n`);
  return { body: body.join(''), links };
}

/* ── 比賽 ────────────────────────────────────────────────── */
function renderMatch(f, ctx) {
  const H = ctx.teamNameOf(f.home), A = ctx.teamNameOf(f.away);
  const links = [H, A].filter(Boolean);
  const body = [];
  const rep = f.played ? ctx.reportFor(f) : null;
  /* 站上單場頁的其餘幾塊(2026-09-26):本站的分析文章、真人專家觀點、即時勝率的變化。
     都只有本季有(產物只收本季);查法照站上那一頁(analysis 的賽前鍵沒有季、賽後鍵有季)。 */
  const preArt = ctx.preArticleFor(f), postArt = ctx.postArticleFor(f);
  const experts = ctx.expertsFor(f), prob = ctx.probFor(f);
  body.push(frontmatter({
    類型: '比賽', 聯賽: ctx.lg.zh, 賽季: f.season, 輪次: f.round, 日期: f.date,
    開球: f.kickoff, 主隊: f.home, 客隊: f.away, 已完賽: f.played,
    主隊進球: f.played ? f.fh : null, 客隊進球: f.played ? f.fa : null,
    /* 跟盃賽與歐冠同一個欄位:Dataview 查得到哪幾場有賽後報告,測試也靠它對回產物(本季的索引 + 往季的 archive) */
    賽後報告: rep ? true : null,
    賽前分析: preArt ? true : null, 賽後分析: postArt ? true : null,
    專家觀點: experts.length || null, 勝率曲線點數: prob?.pts?.length >= 3 ? prob.pts.length : null,
    產生時間: ctx.builtAt,
  }));
  body.push(`\n# ${ctx.lg.zh} ${f.season} 第 ${f.round} 輪 ${H} vs ${A}\n`);
  body.push(`\n${wl(H)} vs ${wl(A)} —— ${f.date}\n`);

  if (f.played) {
    body.push(`\n## 比分\n\n**${H} ${f.fh} : ${f.fa} ${A}**\n`);
    if (f.hh !== null && f.hh !== undefined) body.push(`\n半場 ${f.hh} : ${f.ha}\n`);

    /* 已完賽的場次只有兩種預測可以印:
       - 走查回測的(訓練資料只到該輪開賽前)—— 這是真的賽前預測,印。
       - fixtures.json 的 prediction —— 建置時重算,模型看過這場結果,不印。 */
    const wf = ctx.walkForwardFor(f);
    if (wf) {
      body.push(`\n## 賽前預測(走查回測)\n\n`);
      body.push(`| 主勝 | 和 | 客勝 |\n|---|---|---|\n`);
      body.push(`| ${(wf.home * 100).toFixed(1)}% | ${(wf.draw * 100).toFixed(1)}% | ${(wf.away * 100).toFixed(1)}% |\n`);
      const ex = statTable([['預期進球(主)', 'xgHome'], ['預期進球(客)', 'xgAway'],
        ['大於 2.5 球', 'over25'], ['兩隊都進球', 'btts']],
        { ...wf, over25: pct(wf.over25), btts: pct(wf.btts) });
      if (ex) body.push(`\n${ex}`);
      body.push(`\n> 這是**走查回測**的預測:訓練資料只到這一輪開賽前,模型沒有看過這場結果。\n`
        + `> 跟 \`fixtures.json\` 裡建置時重算的那一份不是同一個東西。\n`);
    } else if (f.prediction?.snapshot === true) {
      /* **開賽前凍結的快照**:比賽日迴圈在開賽時存下來、之後不覆寫(lib/prob-history.mjs 的 preMatchSnapshots),
         模型當時沒有看過這場結果。2026-09-01 起 build 對已完賽場次的 prediction 只給這一份,沒有就是 null。
         這一段原本一律寫「本站沒有保存這場的賽前機率快照」—— 那句話 9/1 之後對有即時追蹤的場次就不成立了
         (英超本季 50 場裡 40 場有快照),而同一則筆記的勝率變化第 0 分就是這一份。2026-09-26 改。 */
      const p = f.prediction;
      body.push(`\n## 賽前預測(開賽前存下來的快照)\n\n| 主勝 | 和 | 客勝 |\n|---|---|---|\n| ${pct(p.home)} | ${pct(p.draw)} | ${pct(p.away)} |\n`);
      if (Number.isFinite(p.xgHome) && Number.isFinite(p.xgAway)) body.push(`\n預期進球 ${p.xgHome} : ${p.xgAway}\n`);
      body.push(`\n> 比賽日迴圈在開賽時凍結的機率(Poisson 與 Elo 兩個模型的平均),之後不會被覆寫 —— 模型當時沒有看過這場結果。\n`);
    } else {
      body.push(`\n## 賽前預測\n\n`);
      body.push(`本站沒有保存這場的**賽前機率快照**(只有比賽日迴圈即時追蹤過的場次才有),所以這裡不放預測數字。\n\n`);
      body.push(`建置時的模型已經看過這場結果,拿它當賽前預測會是假的。`
        + `走查回測(真正的賽前預測)只涵蓋 ${ctx.walkForwardSeason ?? '另一個賽季'}。\n`);
    }

    body.push(renderProbCurve(prob, H, A));
    body.push(renderArticle(postArt, 'post'));
    body.push(renderExperts(experts, ctx.expertsInfo));

    const ms = ctx.matchStatsFor(f);
    if (rep) body.push(renderLeagueReport(rep, f, ctx, ms));
    if (ms) {
      const SIT = SHOT_SIT_ZH;
      const v = x => (x == null ? '—' : x);
      const hs = ms.teamStats[f.home] ?? {}, as = ms.teamStats[f.away] ?? {};
      body.push(`\n## 逐場統計(FotMob)\n\n`);
      body.push(`| | ${H} | ${A} |\n|---|---|---|\n`);
      body.push(`| 控球 % | ${ms.possession.all[0]} | ${ms.possession.all[1]} |\n`);
      if (ms.possession.h1) body.push(`| 上半場控球 % | ${ms.possession.h1[0]} | ${ms.possession.h1[1]} |\n| 下半場控球 % | ${v(ms.possession.h2?.[0])} | ${v(ms.possession.h2?.[1])} |\n`);
      /* xG 標明是 FotMob 的球隊統計:英超本季的賽後報告走 FPL,它的 xG 是 FPL 逐人加總,兩個數字會不一樣 */
      for (const [label, k] of [['射門', 'shots'], ['射正', 'shotsOn'], ['被封阻', 'blockedShots'], ['xG(FotMob 球隊統計)', 'xG'], ['角球', 'corners'], ['越位', 'offsides'], ['犯規', 'fouls'], ['撲救', 'saves'], ['傳球', 'passes']]) {
        if (hs[k] == null && as[k] == null) continue;
        body.push(`| ${label} | ${v(hs[k])} | ${v(as[k])} |\n`);
      }
      if (ms.physical?.team?.distance?.some(x => x != null)) {
        const km = x => (x == null ? '—' : (x / 1000).toFixed(1) + ' km');
        body.push(`| 跑動距離 | ${km(ms.physical.team.distance[0])} | ${km(ms.physical.team.distance[1])} |\n`);
        body.push(`| 衝刺距離 | ${v(ms.physical.team.sprintDistance?.[0])} m | ${v(ms.physical.team.sprintDistance?.[1])} m |\n`);
        body.push(`| 衝刺次數 | ${v(ms.physical.team.sprints?.[0])} | ${v(ms.physical.team.sprints?.[1])} |\n`);
        const pl = [...(ms.physical.players ?? [])].sort((a, b) => (b.distance ?? 0) - (a.distance ?? 0));
        if (pl.length) {
          body.push(`\n### 逐人跑動(${pl.length} 人)\n\n| 球隊 | 球員 | 跑動 | 最高速度 |\n|---|---|---|---|\n`);
          for (const p of pl) body.push(`| ${p.team} | ${p.shirt ?? ''} ${p.name} | ${km(p.distance)} | ${p.topSpeed == null ? '—' : p.topSpeed.toFixed(1) + ' km/h'} |\n`);
        }
      }
      if (ms.shots.length) {
        body.push(`\n### 射門(${ms.shots.length} 次${ms.shotmapComplete ? '' : ',進球數跟比分對不上,清單不完整'})\n\n| 分鐘 | 球隊 | 球員 | 情境 | xG | 結果 |\n|---|---|---|---|---|---|\n`);
        for (const s of ms.shots) body.push(`| ${s.min}${s.extra ? '+' + s.extra : ''} | ${s.team} | ${s.player ?? ''} | ${SIT[s.situation] ?? s.situation ?? ''} | ${s.xg == null ? '' : s.xg.toFixed(2)} | ${s.type === 'Goal' ? '**進球**' : s.type ?? ''} |\n`);
      }
      if (ms.players) {
        for (const [code, list] of Object.entries(ms.players)) {
          const rated = list.filter(p => p.minutes != null && p.minutes > 0).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
          if (!rated.length) continue;
          body.push(`\n### ${ctx.teamNameOf(code) ?? code} 逐人(${rated.length} 人)\n\n| 球員 | 分鐘 | 評分 | 射門/射正 | 傳球/關鍵 | 對抗勝/總 | 鏟球 | 抄截 |\n|---|---|---|---|---|---|---|---|\n`);
          for (const p of rated) body.push(`| ${p.shirt ?? ''} ${p.name} | ${p.minutes} | ${p.rating == null ? '—' : p.rating.toFixed(2)} | ${v(p.shots?.total)}/${v(p.shots?.on)} | ${v(p.passes?.total)}/${v(p.passes?.key)} | ${v(p.duels?.won)}/${v(p.duels?.total)} | ${v(p.tackles?.total)} | ${v(p.tackles?.interceptions)} |\n`);
        }
      }
      if (ms.events.length) {
        body.push(`\n### 事件\n\n`);
        for (const e of ms.events) body.push(`- ${e.minute}${e.extra ? '+' + e.extra : ''}' ${e.team} ${e.detail}${e.player ? `:${e.player}` : ''}\n`);
      }
      if (ms.momentum?.length) {
        const pts = ms.momentum.filter(x => Array.isArray(x));
        body.push(`\n### 動能(每分鐘,正=${H})\n\n\`${pts.map(([, val]) => val).join(' ')}\`\n`);
      }
      const ver = ctx.matchStatsVerification?.[f.season];
      body.push(`\n> 來源:FotMob matchDetails(比分已對回本站賽果)。`
        + (ver ? `控球率經英超官網後端抽核 ${ver.agree}/${ver.checked} 場在 ±${ver.tolerance} 內。` : '這一季的控球率未經第二來源抽核。')
        + `逐射門 xG 與情境是供應商標記,本站只搬運。\n`);
    }
  } else if (f.prediction) {
    const p = f.prediction;
    body.push(`\n## 模型預測(未賽)\n\n`);
    body.push(`| 主勝 | 和 | 客勝 |\n|---|---|---|\n`);
    body.push(`| ${(p.home * 100).toFixed(1)}% | ${(p.draw * 100).toFixed(1)}% | ${(p.away * 100).toFixed(1)}% |\n`);
    const extra = statTable([['預期進球(主)', 'xgHome'], ['預期進球(客)', 'xgAway'],
      ['大於 2.5 球', 'over25'], ['兩隊都進球', 'btts']],
      { ...p, over25: pct(p.over25), btts: pct(p.btts) });
    if (extra) body.push(`\n${extra}`);
    if (p.topScores?.length) {
      body.push(`\n最可能比分:${p.topScores.slice(0, 3).map(s => `${s.s}(${(s.p * 100).toFixed(1)}%)`).join('、')}\n`);
    }
    body.push(`\n> 模型:${ctx.modelName}。預測僅供分析參考,不構成投注建議。\n`);
  }
  if (!f.played && f.season === ctx.currentSeason) {
    /* 建置當下正在踢的場次:賽程還沒記成完賽,但即時勝率已經有點了(表上會標「比賽還在進行」) */
    body.push(renderProbCurve(prob, H, A));
    body.push(renderArticle(preArt, 'pre'));
    if (ctx.h2hAvailable) {
      const h = renderH2H(ctx.h2hFor(f), f, ctx);
      body.push(h.text);
      links.push(...h.links);
    }
    if (ctx.formFor(f.home) || ctx.formFor(f.away)) {
      body.push(`\n兩隊的近況${ctx.hasAvailability ? '、傷停與拿牌' : ''}見 ${wl(H)}、${wl(A)} 的球隊筆記(截至 ${ctx.formAsOf} 的快照)。\n`);
    }
  }

  body.push(`\n## 資料界線\n\n- 賽程與比分來源見 ${wl(ctx.lg.zh)} 的來源清單\n`);
  body.push(`- 建置時間 ${ctx.builtAt}\n`);
  return { body: body.join(''), links };
}

/* ── 聯賽的賽後報告(本季 + 上季)──────────────────────────
   2026-09-26 起上一季也有(使用者:「上季聯賽的賽後報告…也存進去」):往季是逐場檔
   (`match-reports/{季}/{id}.json`,索引只有 id),`readArchivedReports` 讀回來跟本季同一個形狀。
   原本這一節只印一張只剩「實際 xG」一欄的表(報告的 sides 根本沒有射門、控球那幾個欄位)
   和沒有分數的「本場最佳」—— 報告裡真正的東西一樣都沒進來。

   內容照站上單場頁的報告卡(core.js 的 matchReportCards):戰術解讀、數據對比、實際排出的陣容、本場最佳。
   **球隊統計、逐人評分、事件、射門與動能不在這裡重印**:報告附帶的逐場資料(advanced)幾乎都是 FotMob,
   跟下一節「逐場統計(FotMob)」同一家 —— 2,644 份報告逐場比過,FotMob 那條路的 xG 跟那一節的球隊統計全部相同,
   每一份報告也都有對應的逐場統計(0 份沒有)。印兩次只會讓同一則筆記出現兩張一樣的表。
   例外照印(renderDetailReport,盃賽與歐冠在用的同一支):advanced 不是 FotMob 的(西甲本季前 30 場走 SportMonks),
   或這一場沒有逐場統計。

   **xG 要講清楚是哪一種。** 英超本季走 FPL + 官方名單那條路(報告的 `source` 沒有值),
   它的 xG 是 FPL 的逐人 xG 加總,跟 FotMob 的球隊統計不是同一個算法(100 個隊-場只有 29 個相同)。
   同一則筆記兩個不同的 xG 而沒人講,就是 CLAUDE.md「同一個聯賽兩種 xG 算法」那條坑。 */
const PROVIDER_ZH = { fotmob: 'FotMob', sportmonks: 'SportMonks', 'api-football': 'API-Football' };
function renderLeagueReport(rep, f, ctx, ms) {
  const H = rep.sides?.[f.home], A = rep.sides?.[f.away];
  if (!H || !A) return '';
  const nm = code => ctx.teamNameOf(code) ?? code;
  const v = x => (x == null ? '—' : x);
  const sg = x => (x == null ? '—' : (x > 0 ? '+' : '') + Number(x).toFixed(2));
  const prov = rep.source ? (PROVIDER_ZH[rep.source] ?? rep.source) : null;
  const out = ['\n## 賽後報告\n\n'];
  out.push('> ' + (prov ? `本站從 ${prov} 的完賽資料整理;站上單場頁的賽後分頁是同一份。`
    : '本站從英超官方公布的名單與 FPL 的逐人數據整理;站上單場頁的賽後分頁是同一份。') + '\n');

  const notes = (rep.notes ?? []).map(n => n?.text).filter(Boolean);
  if (notes.length) {
    out.push('\n### 戰術解讀\n\n' + notes.map(t => '- ' + t).join('\n') + '\n\n'
      + '> 這幾句是本站依規則從這一場的數字自動寫的,不是真人觀點。\n');
  }

  /* 數據對比。供應商那條路的 xG 就是下一節那份球隊統計,已經印了 —— 相同就不再印一次 */
  const sameXg = ms && H.xG === ms.teamStats?.[f.home]?.xG && A.xG === ms.teamStats?.[f.away]?.xG;
  const rows = [['進球', rep.hs, rep.as]];
  if ((H.xG != null || A.xG != null) && !sameXg) rows.push([prov ? `期望進球 xG(${prov} 球隊統計)` : '期望進球 xG(FPL 逐人加總)', H.xG, A.xG]);
  if (H.xA != null || A.xA != null) rows.push([prov ? '期望助攻 xA' : '期望助攻 xA(FPL 逐人加總)', H.xA, A.xA]);
  rows.push(['黃牌', H.yellow, A.yellow], ['紅牌', H.red, A.red], ['使用球員', H.used, A.used]);
  if (H.keeper && A.keeper) rows.push(['門將撲救', H.keeper.saves, A.keeper.saves]);
  if (H.keeper?.stopped != null && A.keeper?.stopped != null) rows.push(['門將少失球(xGC − 失球)', sg(H.keeper.stopped), sg(A.keeper.stopped)]);
  out.push(`\n### 數據對比\n\n| | ${nm(f.home)} | ${nm(f.away)} |\n|---|---|---|\n`
    + rows.map(([l, h, a]) => `| ${l} | ${v(h)} | ${v(a)} |`).join('\n') + '\n');
  if (!prov && !sameXg && ms && H.xG != null) {
    out.push('\n> 這裡的 xG 是 FPL 的逐人 xG 加總;下一節「逐場統計」的 xG 是 FotMob 的球隊統計 —— 兩家算法不同,數字不一樣是正常的。\n');
  }

  /* 實際排出的陣容(站上 matchReportCards 的 lineups 卡):陣型的出處分兩種,照站上的講法 */
  const tag = p => [p.goals ? '進球' + (p.goals > 1 ? ' ×' + p.goals : '') : null,
    p.assists ? '助攻' + (p.assists > 1 ? ' ×' + p.assists : '') : null,
    p.red ? '紅牌' : p.yellow ? '黃牌' : null].filter(Boolean).join('、');
  // 位置不明時上游給「?」—— 不印(站上的本場最佳卡也是這樣處理)
  const who = p => [[p.role, p.pos].find(x => x && x !== '?'), p.shirt, p.name].filter(x => x != null && x !== '').join(' ')
    + (p.minutes != null ? ` ${p.minutes}'` : '') + (tag(p) ? `(${tag(p)})` : '');
  const lineup = (code, S) => {
    const sh = S.shape ?? {};
    const label = sh.label && sh.label !== '—' ? sh.label : null;
    const head = `- **${nm(code)}**` + (label ? ` ${label}` : '') + (sh.shapeZh ? `・${sh.shapeZh}` : '')
      + (S.seasonShape?.label && sh.source !== 'official' ? `・上季常態 ${S.seasonShape.label}` : '')
      + (S.coach ? `・教練 ${S.coach}` : '');
    const xi = (S.xi ?? []).map(who);
    const bench = (S.bench ?? []).map(p => `${p.name}(≈${p.onAbout}' 上${tag(p) ? '・' + tag(p) : ''})`);
    return head + (xi.length ? `\n  - 先發:${xi.join('、')}` : '') + (bench.length ? `\n  - 替補上場:${bench.join('、')}` : '');
  };
  const official = H.shape?.source === 'official' || A.shape?.source === 'official';
  out.push('\n### 實際排出的陣容\n\n' + lineup(f.home, H) + '\n' + lineup(f.away, A) + '\n\n> '
    + (official
      ? (prov ? `陣型與先發來自 ${prov} 的完賽名單。` : '陣型與先發是英超官方公布的正式名單。')
      : '陣型是依 FPL 的位置分類統計先發人數 —— 它只分門將/後衛/中場/前鋒四類,三中衛體系可能顯示成「6-3-1」這種數字。')
    + '替補上場的時間由出場分鐘反推(標 ≈),是推估值。\n');

  /* 本場最佳:有供應商逐人評分就用它排前三,沒有才退回 FPL 表現分(站上同一套,兩份分開挑) */
  const d = rep.advanced;
  const rated = d?.coverage?.ratings === true && Object.values(d.players ?? {}).some(l => l?.some(p => p.rating != null));
  if (rated) {
    const src = PROVIDER_ZH[d.source] ?? d.source ?? '供應商';
    const top = code => [...(d.players?.[code] ?? [])].filter(p => p.rating != null && (p.minutes ?? 0) > 0)
      .sort((a, b) => b.rating - a.rating).slice(0, 3).map(p => `${p.name} ${p.rating.toFixed(1)}`).join('、');
    out.push(`\n### 本場最佳(${src} 評分)\n\n- ${nm(f.home)}:${top(f.home) || '—'}\n- ${nm(f.away)}:${top(f.away) || '—'}\n`);
  } else if ([...(H.best ?? []), ...(A.best ?? [])].some(b => b.bps != null)) {
    const bps = S => (S.best ?? []).filter(b => b.bps != null).map(b => `${b.name} ${b.bps}`).join('、');
    out.push(`\n### 本場最佳(FPL 表現分)\n\n- ${nm(f.home)}:${bps(H) || '—'}\n- ${nm(f.away)}:${bps(A) || '—'}\n`);
  }

  /* 報告附帶的逐場資料(advanced)跟下一節是不是同一家:是 FotMob 就不重印;
     不是(西甲本季前 30 場走 SportMonks)就照印 —— 那是另一家供應商對同一場的紀錄,站上賽後分頁畫的就是它,
     丟掉等於少存一份資料,而兩家的數字不一定相同,所以標明是哪一家 */
  const advSrc = d?.source ? (PROVIDER_ZH[d.source] ?? d.source) : null;
  if (d && d.source !== 'fotmob') {
    out.push(renderDetailReport(rep, { heading: `## 逐場詳情(${advSrc ?? '供應商'},賽後報告附帶)`, nameOf: nm,
      caveats: [ms ? `這一份是 ${advSrc ?? '供應商'} 的逐場資料;下一節「逐場統計(FotMob)」是另一家供應商對同一場的紀錄,兩家的數字不一定相同。` : null] }));
  } else if (ms) {
    out.push('\n> 球隊統計、逐人評分、事件、射門與動能在下一節「逐場統計(FotMob)」—— 跟這份報告附帶的是同一家供應商(FotMob)的逐場資料,這裡不重印。\n');
  } else if (d) {
    out.push(renderDetailReport(rep, { heading: '## 逐場詳情(FotMob,賽後報告附帶)', nameOf: nm }));
  }
  return out.join('');
}

/* ── 站上單場頁與球隊頁的其餘幾塊(2026-09-26,使用者:「繼續」)──────────
   補齊規劃「產生器沒有讀的產物」那一串:本站的分析文章(analysis)、真人專家觀點(experts)、
   即時勝率的變化(prob-history)、歷來交手(h2h)、近況與可用人手(form)、賽季模擬(sim)、
   上季數據風格與陣型(tactics / shapes / formation)、外電與動態(news)。
   **標籤與界線照站上那一頁寫** —— 站上講「非真人觀點」「沒有進模型」「這是推論」「不是市場盤口」的地方,
   這裡一句都不能少(鐵則四)。各聯賽有哪幾塊由產物決定(沒有檔或空的就整塊不寫),不按聯賽代碼寫死。 */
const ARTICLE_LABEL = { template: '本站統計模板', llm: '本站 AI 分析' };
/* 分析文章:站上單場頁的「賽前分析 / 賽後分析」。本站依模型與逐場數據寫的,**不是真人觀點**;
   每篇都過了報告層的數字驗證器(對不上就退回模板)。說明照站上:模板「由統計結果自動生成」、AI「AI 撰寫,數字經過驗證」。 */
function renderArticle(art, phase) {
  if (!art?.paragraphs?.length) return '';
  const out = [`\n## ${phase === 'pre' ? '賽前分析' : '賽後分析'}(${ARTICLE_LABEL[art.source] ?? '本站自動分析'}・非真人觀點)\n\n`];
  out.push(`> ${art.source === 'llm' ? 'AI 撰寫,數字經過驗證' : '由統計結果自動生成'}`
    + `${art.verified === false ? ';**這一篇的數字驗證沒有通過**' : ''}。\n`);
  out.push(`\n### ${art.title}\n\n${art.paragraphs.join('\n\n')}\n`);
  if (art.caveat) out.push(`\n> ${art.caveat}\n`);
  if (art.note) out.push(`\n> ${art.note}\n`);
  return out.join('');
}

/* 連結只收 http(s),而且把會把 Markdown 連結提早結束的括號與空白編碼掉 */
const mdUrl = u => (/^https?:\/\//.test(String(u ?? '')) ? String(u).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29') : null);
const cellText = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/* 真人專家觀點(experts.json):具名、有原始連結、人工核對後才發布。順序照站上:新聞 → 名宿 → 專家 */
const EXPERT_CAT = { news: '新聞', legend: '名宿', expert: '專家' };
const EXPERT_ORDER = { news: 0, legend: 1, expert: 2 };
const EXPERT_TYPE = { article: '文章', broadcast: '轉播', video: '影片', podcast: 'Podcast', 'press-conference': '記者會' };
function renderExperts(rows, info) {
  if (!rows?.length) return '';
  const list = [...rows].sort((a, b) => (EXPERT_ORDER[a.category] ?? 9) - (EXPERT_ORDER[b.category] ?? 9));
  const out = [`\n## 新聞/名宿/專家觀點(${list.length} 則,真人)\n\n`];
  out.push(`> 具名來源與原始連結,人工核對後才發布${info?.updatedAt ? `(${info.updatedAt} 更新)` : ''}。`
    + '只摘要原始來源可證實的觀點,不代表本站立場;跟本站的分析文章是兩回事。\n');
  for (const x of list) {
    out.push(`\n### ${x.expert}(${EXPERT_CAT[x.category] ?? '觀點'})\n\n`);
    out.push(`${[x.role, x.publisher ? `**${x.publisher}**` : null, EXPERT_TYPE[x.sourceType] ?? x.sourceType, x.publishedAt].filter(Boolean).join('・')}\n\n`);
    out.push(`${x.summary}\n`);
    if (x.topics?.length) out.push(`\n主題:${x.topics.join('、')}\n`);
    if (x.evidence?.length) out.push(`\n與本站數據對照:${x.evidence.join(';')}\n`);
    const u = mdUrl(x.url);
    if (u) out.push(`\n[原始來源](${u})${x.summaryType ? `・${x.summaryType}` : ''}\n`);
  }
  return out.join('');
}

/* 勝率變化(prob-history.json):本站模型比賽中每 2 分鐘算一次的即時機率,**不是市場盤口**。
   第 0 分那一點是賽前機率(Poisson 與 Elo 的平均);比賽中只用 Poisson —— 有 kick 就另列一行「開球」,
   那一步是換算法不是場上發生了什麼(站上 probCurve 的說明,2026-09-25)。
   表只列開球、比分改變與最後一個點;全部的點收在一個可折疊的 callout 裡,一點不少。 */
const pctOf = x => (x * 100).toFixed(1) + '%';
function renderProbCurve(rec, H, A) {
  const pts = rec?.pts;
  if (!Array.isArray(pts) || pts.length < 3) return '';   // 站上也是三點以上才畫
  const anchored = pts[0][0] === 0;
  const kick = anchored && Array.isArray(rec.kick) && rec.kick.length === 3 && rec.kick.every(Number.isFinite) ? rec.kick : null;
  const score = s => `${s[4]}-${s[5]}`;
  const row = (when, s, what) => `| ${when} | ${score(s)} | ${pctOf(s[1])} | ${pctOf(s[2])} | ${pctOf(s[3])} | ${what} |\n`;
  const out = [`\n## 勝率變化(本站模型的即時機率)\n\n| 時間 | 比分 | ${H} 勝 | 和 | ${A} 勝 | 這一點是 |\n|---|---|---|---|---|---|\n`];
  if (anchored) out.push(row('賽前', pts[0], '賽前機率(Poisson 與 Elo 兩個模型的平均)'));
  else out.push(row(`${pts[0][0]}'`, pts[0], '第一個點(開賽後才開始記錄)'));
  if (kick) {
    const step = Math.max(...[1, 2, 3].map(i => Math.abs(pts[0][i] - kick[i - 1]))) * 100;
    out.push(row('開球', [0, ...kick, 0, 0], `比賽中的模型只用 Poisson;跟上一列差 ${step.toFixed(1)} 個百分點是換算法,不是場上發生了什麼`));
  }
  const last = pts.length - 1;
  for (let k = 1; k < pts.length; k++) {
    const changed = pts[k][4] !== pts[k - 1][4] || pts[k][5] !== pts[k - 1][5];
    if (!changed && k !== last) continue;
    out.push(row(`${pts[k][0]}'`, pts[k], [changed ? '比分改變後的第一個點' : null,
      k === last ? (rec.done ? '最後一個點(完場)' : '最後一個點(建置當下比賽還在進行)') : null].filter(Boolean).join(';')));
  }
  out.push(`\n> 這是**本站模型**的即時機率,不是市場盤口。比賽中約每 2 分鐘一個點(這一場 ${pts.length} 點);`
    + '上表只列開球、比分改變與最後一個點,全部的點在下面。\n');
  out.push(`\n> [!note]- 全部 ${pts.length} 個點\n> | 分鐘 | 比分 | ${H} 勝 | 和 | ${A} 勝 |\n> |---|---|---|---|---|\n`);
  for (const s of pts) out.push(`> | ${s[0]} | ${score(s)} | ${pctOf(s[1])} | ${pctOf(s[2])} | ${pctOf(s[3])} |\n`);
  return out.join('');
}

/* 歷來交手(h2h.json,鍵是排序過的兩隊 —— 站上同一個查法)。只算聯賽,盃賽不在這份資料裡。
   這一聯賽整份 h2h 是空的就整塊不寫:那不代表「沒有交手過」(英冠德義法 2026-09-26 前就是整份空的)。 */
function renderH2H(rec, f, ctx) {
  const links = [];
  const nm = c => ctx.teamNameOf(c) ?? c;
  const since = ctx.h2hSince;
  if (!rec) {
    return { links, text: `\n## 歷來交手\n\n${since ? `${since} 以來` : ''}沒有在${ctx.lg.zh}交手過(多半是剛升上來或剛降下來的球隊)。\n` };
  }
  const homeIsA = [f.home, f.away].sort()[0] === f.home;
  const [hw, aw] = homeIsA ? [rec.aWin, rec.bWin] : [rec.bWin, rec.aWin];
  const [hg, ag] = homeIsA ? [rec.aGoals, rec.bGoals] : [rec.bGoals, rec.aGoals];
  const out = [`\n## 歷來交手(${since ? `${since} 起的` : ''}${ctx.lg.zh}聯賽,${rec.games} 場)\n\n`];
  out.push(`| ${nm(f.home)} 勝 | 和 | ${nm(f.away)} 勝 | 進球 |\n|---|---|---|---|\n| ${hw} | ${rec.draw} | ${aw} | ${hg} : ${ag} |\n\n`);
  for (const m of rec.list ?? []) {
    const file = ctx.matchFileOf(m);
    if (file) links.push(file);
    out.push(`- ${m.date} ${nm(m.home)} ${m.fh}-${m.fa} ${nm(m.away)}${file ? ` → ${wl(file)}` : ''}\n`);
  }
  out.push(`\n> 只算${ctx.lg.zh}聯賽的交手(盃賽不在這份資料裡)。${ctx.formNote ?? ''}\n`);
  return { links, text: out.join('') };
}

/* 賽季模擬(teams.json 的 sim,跟 sim.json 同一份)。欄位看資料有什麼:有直升的聯賽(英冠)不印前四、
   有降級附加賽的(德甲法甲)多一欄 —— 名額照各聯賽的規則(2026-09-26 起模擬真的照著數,見變更紀錄)。 */
const simCols = s => [
  ['期望積分', s.expectedPoints], ['期望名次', s.expectedPos], ['奪冠', `${s.titlePct}%`],
  ...(s.promotionPct != null
    ? [['直升', `${s.promotionPct}%`], ...(s.playoffPct != null ? [['附加賽區', `${s.playoffPct}%`]] : [])]
    : [['前四', `${s.top4Pct}%`]]),
  ['降級', `${s.relegationPct}%`],
  ...(s.relegationPlayoffPct != null ? [['降級附加賽', `${s.relegationPlayoffPct}%`]] : []),
];
function simNote(ctx) {
  return `\n> ${ctx.simRuns ? `${Number(ctx.simRuns).toLocaleString('en-US')} 次` : ''}賽季模擬的平均:`
    + '期望積分 = 已經拿到的分數 + 剩餘賽程的模擬結果;每次 build 重算。'
    + (ctx.zoneRule ? `\n> ${ctx.zoneRule}` : '') + '\n';
}
function renderSim(s, ctx) {
  if (!s) return '';
  const cols = simCols(s);
  const out = [`\n## ${ctx.currentSeason} 賽季模擬\n\n| ${cols.map(c => c[0]).join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n| ${cols.map(c => c[1]).join(' | ')} |\n`];
  const dist = (s.posDist ?? []).map((v, i) => (v >= 0.1 ? `第 ${i + 1} 名 ${v}%` : null)).filter(Boolean);
  if (dist.length) out.push(`\n名次分布(0.1% 以上):${dist.join('・')}\n`);
  out.push(simNote(ctx));
  return out.join('');
}

/* 近況與可用人手(form.json)。**截至 asOf 的快照** —— 近五場與傷停都是會變的東西。
   近況跟交手都跑過走查回測、沒有進模型:說法照產物自己那一句(form.note)。
   可用人手只有英超有(官方 FPL 的傷停欄位);其他聯賽的 availability 是 null,整塊不寫。 */
const RES_ZH = { W: '勝', D: '和', L: '負' };
function renderForm(code, ctx) {
  const t = ctx.formFor(code);
  const links = [];
  if (!t?.recent?.length) return { links, text: '' };
  const s = t.summary ?? {};
  const out = [`\n## 近況(截至 ${ctx.formAsOf})\n\n| 日期 | 主客 | 對手 | 比分 | 結果 |\n|---|---|---|---|---|\n`];
  for (const r of t.recent) {
    const opp = ctx.teamNameOf(r.opp);
    if (opp) links.push(opp);
    out.push(`| ${r.date} | ${r.venue === 'H' ? '主' : '客'} | ${opp ? wl(opp) : r.opp} | ${r.gf}-${r.ga} | ${RES_ZH[r.res] ?? r.res} |\n`);
  }
  out.push(`\n近 ${s.games} 場 ${s.w} 勝 ${s.d} 和 ${s.l} 負・進 ${s.gf} 失 ${s.ga}・場均 ${s.ppg} 分\n`);
  if (ctx.formNote) out.push(`\n> ${ctx.formNote}\n`);
  const a = t.availability;
  if (a) {
    const base = a.baseline === 'current' ? '本季' : '上季';
    const who = p => { const f = ctx.playerFileByFpl(p.code); if (f) links.push(f); return f ? wl(f) : p.name; };
    const share = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
    out.push(`\n### 可用人手(截至 ${ctx.formAsOf},英超官方 FPL)\n\n`);
    out.push(`**確定缺陣**(${a.outCount} 人${a.outCount > a.out.length ? `,列出影響最大的 ${a.out.length} 位` : ''})\n\n`);
    out.push(a.out.length
      ? `| 球員 | 位置 | 狀態 | 佔${base}上場時間 | FPL 原文 |\n|---|---|---|---|---|\n`
        + a.out.map(o => `| ${who(o)} | ${o.pos} | ${o.statusZh} | ${share(o.minutesShare)} | ${cellText(o.news)} |\n`).join('')
      : '沒有確定缺陣的球員。\n');
    if (a.doubt?.length) {
      out.push(`\n**有疑慮**(可能趕不上)\n\n| 球員 | 位置 | 下一場出賽機率 | 佔${base}上場時間 | FPL 原文 |\n|---|---|---|---|---|\n`);
      for (const o of a.doubt) out.push(`| ${who(o)} | ${o.pos} | ${o.chanceNext == null ? '—' : o.chanceNext + '%'} | ${share(o.minutesShare)} | ${cellText(o.news)} |\n`);
    }
    if (a.departed?.count) {
      out.push(`\n**夏天離隊**(不算這場的傷兵):${a.departed.names.join('、')}${a.departed.count > a.departed.names.length ? ` 等 ${a.departed.count} 人` : ''}`
        + ` —— 上季佔 ${share(a.departed.minutes)} 上場時間\n`);
    }
    if (a.cards?.length) {
      out.push(`\n**本季拿牌**\n\n| 球員 | 位置 | 黃牌 | 紅牌 | 停賽門檻 |\n|---|---|---|---|---|\n`);
      for (const c of a.cards) {
        const w = c.watch;
        out.push(`| ${who(c)} | ${c.pos} | ${c.yellow} | ${c.red} | ${w ? `再 ${w.away} 張黃牌停 ${w.ban} 場(第 ${w.byMatch} 場前累積 ${w.next} 張)` : '—'} |\n`);
      }
    }
    out.push(`\n> 缺陣佔比算的是**確定不能上場**的球員佔球隊${base}上場時間的比例`
      + (a.noBaseline ? `;${a.noBaseline} 名球員沒有參考賽季數據(多半是新援),缺陣算不進去,所以會低估` : '')
      + `。目前踢了 ${a.teamMatches} 場。這一段沒有進預測模型。\n`);
  }
  return { links, text: out.join('') };
}

/* 上季數據風格(teams.json 的 tactics,戰術頁與球隊頁同一份)。兩個聯賽的欄位不同(英超有球員級的人力配置、
   西甲有整隊的射門與快攻佔比),所以逐欄位看有沒有值 —— 跟站上 styleBlock 同一組。
   雷達的級分規則跟 core.js 的 radar 同一條:百分位每 10 分一級,10 最高。 */
const levelOf = v => Math.min(10, Math.floor((v ?? 0) / 10) + 1);
const signedFx = (v, d) => (v == null ? null : (v > 0 ? '+' : '') + Number(v).toFixed(d));
const SP_ZH = { openPlay: '運動戰', corner: '角球', otherSetPiece: '其他定位球', directFreeKick: '直接任意球', penalty: '十二碼' };
function renderTactics(t, ctx) {
  const tac = t.tactics;
  if (!tac) return '';
  const a = tac.attack ?? {}, d = tac.defence ?? {}, sp = tac.setPieces ?? {};
  const rows = [
    a.goals90 != null ? ['進球 / xG(每場)', `${a.goals90} / ${a.xG90}`] : ['每場期望進球 xG', a.xG90],
    d.conceded90 != null ? ['失球 / xGA(每場)', `${d.conceded90} / ${d.xGA90}`] : ['每場期望失球 xGA', d.xGA90],
    a.shots90 != null ? ['射門 / 被射門(每場)', `${a.shots90} / ${d.shots90}`] : null,
    ['終結超出期望(進球 − xG)', signedFx(a.finishing, 1)],
    d.overperform != null ? ['門將守住的期望失球', signedFx(d.overperform, 1)] : null,
    a.fastXGShare != null ? ['快速進攻 xG 佔比', `${a.fastXGShare}%`] : null,
    a.boxShotShare != null ? ['禁區內射門佔比', `${a.boxShotShare}%`] : null,
    /* 定位球那三列照站上:進失球在分類對不回總進球時是 null,寫明原因而不是印 null */
    sp.available ? ['非十二碼定位球 進 / 失', sp.goals == null || sp.conceded == null ? '—(分類對不回總進球)' : `${sp.goals} / ${sp.conceded}`] : null,
    sp.available ? ['定位球 xG / 場', sp.xG90] : null,
    sp.available ? ['定位球 xGA / 場', sp.xGA90] : null,
    /* 人力配置只有英超有(def / mid / fwd);西甲的 label 是陣型名稱,跟「主要陣型」同一個值(站上同一個判斷) */
    tac.formation?.def != null && tac.formation?.label ? ['後場 / 中場 / 鋒線人力', tac.formation.label] : null,
    tac.formation?.shape ? ['體系判讀', tac.formation.shape] : null,
    tac.formation?.primary ? ['主要陣型', tac.formation.primary] : null,
    tac.squad ? ['使用球員數', tac.squad.used] : null,
    tac.squad ? ['前 11 人出場佔比', `${tac.squad.top11Share}%`] : null,
    tac.squad ? ['出場加權平均年齡', tac.squad.avgAgeWeighted] : null,
    tac.discipline ? ['每場黃紅牌加權', tac.discipline.perGame] : null,
    tac.resilience?.leadHoldPct != null ? ['領先後拿下', `${tac.resilience.leadHoldPct}%`] : null,
    tac.resilience?.trailRescuePct != null ? ['落後後搶到分', `${tac.resilience.trailRescuePct}%`] : null,
    tac.resilience ? ['逆轉 / 被逆轉', `${tac.resilience.comeback} / ${tac.resilience.collapse}`] : null,
    tac.homePpg != null ? ['主場 / 客場場均積分', `${tac.homePpg} / ${tac.awayPpg}`] : null,
  ].filter(Boolean);
  const out = [`\n## 上季數據風格(${ctx.lastSeason})\n\n${defTable(rows)}`];
  const formations = tac.formation?.list ?? [];
  if (formations.length) out.push(`\n整季陣型佔比(出場分鐘):${formations.map(f => `${f.name} ${f.share}%(${f.minutes} 分)`).join('・')}\n`);
  if (tac.formation?.notes?.length) out.push(`\n${tac.formation.notes.join('・')}\n`);
  if (tac.radar?.length) {
    out.push(`\n### 風格雷達\n\n| 指標 | 級分 | 百分位 | 原始值 |\n|---|---|---|---|\n`);
    for (const r of tac.radar) out.push(`| ${r.label} | ${levelOf(r.value)} | ${r.value} | ${r.raw} |\n`);
    out.push(`\n> 級分 = 該指標在 ${ctx.lastSeason} 全聯盟 ${ctx.tacticsTeams} 隊中的百分位,每 10 分一級(10 最高),不是主觀評分。`
      + '控球與壓迫沒有可靠來源,所以沒有這兩軸。\n');
    const rc = t.radarCoverage;
    if (rc && rc.lastSeasonTotal > 0) {
      if (rc.changed || rc.lastSeasonGames == null) {
        out.push(`> **這是上季全季的風格,而現任教練${rc.coach ? ` ${rc.coach}` : ''} 是之後才上任 —— 它描述的是前任的打法**,參考時要打折。\n`);
      } else if (rc.lastSeasonGames < rc.lastSeasonTotal) {
        out.push(`> 上季 ${rc.lastSeasonTotal} 場中${rc.coach ?? '現任教練'}帶了 ${rc.lastSeasonGames} 場,其餘是前任 —— 雷達是全季混合。\n`);
      }
    }
  }
  if (tac.tags?.length) out.push(`\n標籤:${tac.tags.join('・')}\n`);
  if (sp.available && sp.breakdown) {
    const unreliable = sp.goalsReliable === false;
    out.push(`\n### 進球情境(${sp.source ?? '整季分類'}${sp.matches ? `,${sp.matches} 場` : ''})\n\n`
      + '| 情境 | 射門 | 進球 | xG | 被射門 | 失球 | 被 xG |\n|---|---|---|---|---|---|---|\n');
    for (const [k, v] of Object.entries(sp.breakdown)) {
      const g = x => (unreliable ? '—' : x);
      out.push(`| ${SP_ZH[k] ?? k} | ${v.shots} | ${g(v.goals)} | ${fixed(v.xG, 1)} | ${v.against?.shots ?? '—'} | ${g(v.against?.goals ?? '—')} | ${fixed(v.against?.xG, 1)} |\n`);
    }
    if (unreliable) out.push('\n> 這一隊的進球情境分類加起來對不回整季總進球,所以進球數不印;xG 不受影響。\n');
    const takers = [['十二碼', sp.takers?.pen], ['任意球', sp.takers?.fk], ['角球', sp.takers?.corner]]
      .filter(([, l]) => l?.length).map(([k, l]) => `${k} ${l.map(x => x.name).join(' → ')}`);
    if (takers.length) out.push(`\n主罰順位:${takers.join(';')}\n`);
    if (sp.defenderGoalShare != null) out.push(`\n後衛進球 ${sp.defenderGoals} 球,佔整季進球 ${sp.defenderGoalShare}%\n`);
  }
  out.push('\n> 風格只描述上季表現,不改動本季單場的模型機率。\n');
  return out.join('');
}

/* 陣型(shapes.json):官方公布的正式先發陣型(本季),加上英超有的「攻守分型」—— 那是**推論**,
   官方沒有這個東西(站上戰術頁同一句)。樣本不足的球隊寧可標示資料不足,也不編一個陣型。 */
function renderShape(sh, ctx) {
  if (!sh || (!sh.official && !sh.base && !sh.insufficient)) return '';
  const out = [`\n## 陣型(${ctx.currentSeason})\n\n`];
  const o = sh.official;
  if (o?.formation) {
    out.push(`**官方先發陣型**:最常用 ${o.formation}(${o.games} 場有正式先發)`
      + (o.used?.length > 1 ? `;用過 ${o.used.map(u => `${u.formation} ${u.games} 場`).join('、')}` : '')
      + (o.latest?.formation ? `;最近一場 ${o.latest.formation}(${String(o.latest.kickoff ?? '').slice(0, 10)})` : '') + '\n');
  }
  if (sh.note) out.push(`\n> ${sh.note}\n`);
  if (sh.insufficient) {
    out.push(`\n攻守分型:只有 ${sh.contributors} 名球員有足夠的樣本,不推導(寧可標示資料不足,也不編一個陣型)。\n`);
  } else if (sh.base) {
    out.push('\n| | 陣型 | 角色配置 |\n|---|---|---|\n');
    out.push(`| 標準(推導) | ${sh.base.label} | ${sh.base.detail} |\n`);
    if (sh.attacking) out.push(`| 進攻時 | ${sh.attacking.label} | ${sh.attacking.detail}${sh.attacking.pushedUp ? `・邊後衛前壓 ${sh.attacking.pushedUp}` : ''} |\n`);
    if (sh.defending) out.push(`| 防守時 | ${sh.defending.label} | ${sh.defending.detail}${sh.defending.droppedBack ? `・邊鋒回收 ${sh.defending.droppedBack}` : ''} |\n`);
    out.push('\n> **攻守分型永遠是推論,官方沒有這個東西。** 官方只公布一個陣型,不分有球無球;這裡用兩條規則推:'
      + '創造力排在同角色前段的邊後衛進攻時前壓、防守貢獻排在同角色前段的邊鋒無球時退回中場線 —— 推的是傾向,不是實測位置。\n');
  }
  return out.join('');
}

/* 外電與動態(news.json)。每一則的來源照實標:FPL 官方欄位(傷停、轉會)、本站模型與上季數據的敘事、
   RSS 外電(只存標題、短摘要與原文連結,不抓全文)、人工或 AI 整理的摘要(站上同樣分開標)。
   AI 整理的**不寫成人工整理**(page-news 的規矩);翻譯要標是機器還是人工,原文留著。 */
const NEWS_CHECK = { verified: '比分已與本站賽果逐場核對', unverified: '比分沒有跟本站賽果核對過(本站沒有那個賽事或那一輪的賽果)' };
const newsTeams = n => (n.teams?.length ? n.teams : (n.team ? [n.team] : []));
function newsMarks(n) {
  const marks = [];
  if (n.curated) {
    marks.push(n.curator?.kind === 'ai'
      ? `AI 整理摘要:${n.curator?.method ?? '整理自搜尋結果的摘要與本站抓到的 RSS'};完整內容以原文為準`
      : '人工整理摘要:不是機器翻譯、也不是原文照抄;完整內容以原文為準');
    if (NEWS_CHECK[n.scoreCheck]) marks.push(NEWS_CHECK[n.scoreCheck]);
    if (n.statusLabel) marks.push(n.statusLabel);
  }
  if (n.titleZh) marks.push(`${n.translatedByHuman ? '人工翻譯' : '機器翻譯'}:只翻譯不改寫;原文標題 ${n.title}`);
  return marks;
}

/* 外電與動態的整份筆記(一個聯賽一則)。依日期分節,新的在前;每一則照實標來源與整理方式(newsMarks)。
   **這是快照**:站上的動態只保留最近幾週,舊的會滾出去,所以筆記裡也只有這一次建置時還在的那些。 */
function renderNewsNote(items, ctx) {
  const links = [];
  const dates = items.map(n => n.date).filter(Boolean).sort();
  const body = [frontmatter({ 類型: '外電與動態', 聯賽: ctx.lg.zh, 則數: items.length, 最早: dates[0], 最新: dates.at(-1), 產生時間: ctx.builtAt })];
  body.push(`\n# ${ctx.lg.zh} 外電與動態\n\n`);
  body.push(`${items.length} 則,${dates[0]} ~ ${dates.at(-1)} 的快照(每次建置重抓,舊的會滾出去)。\n\n`);
  body.push('每一則標著類別。來源有四種:**FPL 官方欄位**(傷停、轉會)、**本站模型與上季數據跑出來的敘事**(賽程、數據、戰術、陣容)、'
    + '**RSS 外電**(每天抓一次,只存標題、短摘要與原文連結,不抓全文)、**人工或 AI 整理的外電摘要**(每一則照實標是誰整理的)。'
    + '球隊標記看產物的欄位,不用隊名關鍵字撈 —— 沒有標記的那幾則就是沒有,不猜。\n');
  const byDate = new Map();
  for (const n of [...items].sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
    if (!byDate.has(n.date)) byDate.set(n.date, []);
    byDate.get(n.date).push(n);
  }
  for (const [date, list] of byDate) {
    body.push(`\n## ${date ?? '日期不詳'}\n`);
    for (const n of list) {
      const teams = newsTeams(n).map(c => ctx.teamNameOf(c)).filter(Boolean);
      links.push(...teams);
      body.push(`\n### ${n.titleZh ?? n.title}\n\n`);
      body.push(`**${n.cat}**${teams.length ? '・' + teams.map(wl).join('・') : ''}${n.competitionName ? `・${n.competitionName}` : ''}\n`);
      const text = n.bodyZh ?? n.body;
      if (text) body.push(`\n${text}\n`);
      if (n.raw) body.push(`\nFPL 原文:${n.raw}\n`);
      const marks = newsMarks(n);
      if (marks.length) body.push(`\n> ${marks.join('\n> ')}\n`);
      const fx = n.fixtureId ? ctx.fixtureFileById(n.fixtureId) : null;
      if (fx) { links.push(fx); body.push(`\n這一場:${wl(fx)}\n`); }
      const u = mdUrl(n.link);
      if (u) body.push(`\n[${n.source ?? '原文'}](${u})\n`);
    }
  }
  body.push(`\n## 資料界線\n\n- 建置時間 ${ctx.builtAt}\n- 外電的內容以原文為準;這裡只有標題、短摘要與連結\n`);
  return { body: body.join(''), links };
}

/* ── 聯賽首頁(MOC)─────────────────────────────────────── */
function renderLeague(ctx, teams, players, fixtures) {
  const links = [];
  const body = [];
  body.push(frontmatter({
    類型: '聯賽', 聯賽: ctx.lg.zh, 本季: ctx.currentSeason, 上季: ctx.lastSeason,
    球隊數: teams.length, 球員數: players.length, 場次: fixtures.length,
    產生時間: ctx.builtAt,
  }));
  body.push(`\n# ${ctx.lg.zh}\n`);
  body.push(`\n本季 ${ctx.currentSeason}・${teams.length} 隊・${players.length} 名球員・${fixtures.length} 場賽程\n`);

  const table = ctx.table;
  if (table?.length) {
    body.push(`\n## ${ctx.currentSeason} 積分榜\n\n`);
    body.push(`| # | 球隊 | 場次 | 勝 | 和 | 負 | 進 | 失 | 積分 |\n|---|---|---|---|---|---|---|---|---|\n`);
    for (const r of table) {
      const nm = ctx.teamNameOf(r.code);
      if (nm) links.push(nm);
      body.push(`| ${r.pos} | ${nm ? wl(nm) : r.code} | ${r.p} | ${r.w} | ${r.d} | ${r.l} | ${r.gf} | ${r.ga} | ${r.pts} |\n`);
    }
  }

  /* 賽季模擬(sim.json,站上實時戰況頁的「本季預測積分榜」同一份) */
  const simRows = ctx.simTable ?? [];
  if (simRows.length) {
    const cols = simCols(simRows[0]).map(c => c[0]);
    body.push(`\n## ${ctx.currentSeason} 賽季模擬\n\n| # | 球隊 | ${cols.join(' | ')} |\n|---|---|${cols.map(() => '---').join('|')}|\n`);
    simRows.forEach((r, i) => {
      const nm = ctx.teamNameOf(r.code);
      if (nm) links.push(nm);
      body.push(`| ${i + 1} | ${nm ? wl(nm) : r.code} | ${simCols(r).map(c => c[1]).join(' | ')} |\n`);
    });
    body.push(simNote(ctx));
  }

  body.push(`\n## 球隊\n\n`);
  body.push(teams.map(t => { links.push(t.en); return wl(t.en); }).join(' · ') + '\n');

  if (ctx.boardNotes?.length) {
    body.push(`\n## 球員榜\n\n`);
    for (const b of ctx.boardNotes) { links.push(b.file); body.push(`- ${wl(b.file)} —— ${b.phase}・${b.boards} 張榜\n`); }
  }

  /* 上季數據風格總表(tactics.json,戰術頁那幾張表的來源)。**含上季在、本季已經離開的球隊** ——
     那幾隊的球隊筆記只有身分與歷史比賽(本季不在這個聯賽),上季的風格只在這裡 */
  const tacs = [...(ctx.tacticsAll ?? [])].sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99) || (b.ppg ?? 0) - (a.ppg ?? 0));
  if (tacs.length) {
    body.push(`\n## ${ctx.lastSeason} 數據風格(全聯盟 ${tacs.length} 隊)\n\n`
      + '| 球隊 | 人力 / 主要陣型 | 體系判讀 | xG / 場 | xGA / 場 | 定位球 xG / 場 | 領先後拿下 | 落後後搶到分 | 標籤 |\n'
      + '|---|---|---|---|---|---|---|---|---|\n');
    for (const x of tacs) {
      const nm = ctx.teamNameOf(x.code);
      if (nm) links.push(nm);
      const v = y => (y == null ? '—' : y);
      body.push(`| ${nm ? wl(nm) : x.code} | ${v(x.formation?.def != null ? x.formation.label : x.formation?.primary)} | ${v(x.formation?.shape)} | ${v(x.attack?.xG90)} | ${v(x.defence?.xGA90)}`
        + ` | ${v(x.setPieces?.xG90)} | ${x.resilience?.leadHoldPct == null ? '—' : x.resilience.leadHoldPct + '%'} | ${x.resilience?.trailRescuePct == null ? '—' : x.resilience.trailRescuePct + '%'}`
        + ` | ${(x.tags ?? []).join('・') || '—'} |\n`);
    }
    body.push('\n> 風格只描述上季表現,不改動本季單場的模型機率。各隊的完整側寫(雷達、進球情境、主罰順位)在本季還在這個聯賽的球隊筆記裡。\n');
  }

  /* 陣型與成績(formation.json,只有英超有):相關不是因果,站上戰術頁同一段話 */
  const fm = ctx.formation;
  if (fm?.pairs?.length) {
    body.push(`\n## 陣型與成績(${ctx.lastSeason},${fm.n} 隊)\n\n| 關係 | r | 強度 | 過門檻 |\n|---|---|---|---|\n`);
    for (const x of fm.pairs) body.push(`| ${x.x} vs ${x.y} | ${x.r} | ${x.strength} | ${x.significant ? '是' : '否'} |\n`);
    body.push(`\n> 以 ${fm.n} 隊的樣本量,|r| 要達到 ${fm.critical} 以上才勉強算得上不是雜訊。**就算過了門檻,也最可能是反過來的因果**:`
      + '強隊控球多所以中場站得住,弱隊常落後只好多推一個前鋒追分 —— 陣型反映的是處境與實力,不是陣型造就了成績。'
      + '人數是用出場分鐘反推的平均值(FPL 把邊鋒歸為中場),不是轉播畫面上的陣型圖。\n');
  }

  if (ctx.newsCount) {
    body.push(`\n## 外電與動態\n\n${wl(ctx.newsFile)} —— ${ctx.newsCount} 則(${ctx.newsRange})\n`);
    links.push(ctx.newsFile);
  }

  if (ctx.sources?.length) {
    body.push(`\n## 資料來源\n\n`);
    for (const s of ctx.sources) {
      body.push(`- **${s.name}** —— ${s.use}${s.license ? `(${s.license})` : ''}\n`);
    }
  }
  body.push(`\n## 資料界線\n\n- 建置時間 ${ctx.builtAt}\n`);
  body.push(`- 這一頁與底下所有筆記都是**產物**,由 \`npm run obsidian\` 產生\n`);
  return { body: body.join(''), links };
}

/* ── 教練 ────────────────────────────────────────────────
   兩個聯賽的教練欄位落差很大:英超有任內戰績與慣用陣型,
   西甲上游的 seasonRecord / since / formation 全是 null(文件記過這件事)。
   所以這裡一律「有值才畫」,不為了兩邊長得一樣而補空欄位。 */
function coachFileOf(c, lg) {
  // 同名教練跨聯賽是可能的,檔名帶聯賽比事後補救安全。
  return sanitize(c.name + '(' + lg.zh + ')');
}

function renderCoach(c, ctx) {
  const teamName = ctx.teamNameOf(c.team);
  const links = [];
  const body = [];
  body.push(frontmatter({
    類型: '教練', 聯賽: ctx.lg.zh, 球隊: teamName, 隊碼: c.team,
    國籍: c.nat, 慣用陣型: c.formation, 資料來源: c.source, 產生時間: ctx.builtAt,
  }));
  body.push('\n# ' + c.name + '\n');
  if (c.zh) body.push('\n> 中文名:' + c.zh + '\n');
  if (teamName) links.push(teamName);
  const info = defTable([
    ['球隊', teamName ? wl(teamName) : (c.team ?? null)],
    ['國籍', c.nat], ['慣用陣型', c.formation],
    ['風格註解', Array.isArray(c.style) ? c.style.join('、') : c.style],
    ['接任日期', c.since], ['在任天數', c.tenureDays],
  ]);
  if (info) body.push('\n' + info);

  for (const [label, rec] of [['本季', c.seasonRecord], ['總計', c.allRecord]]) {
    const t = statTable([['場次', 'p'], ['勝', 'w'], ['和', 'd'], ['負', 'l'],
      ['進球', 'gf'], ['失球', 'ga'], ['場均勝點', 'ppg']], rec);
    if (t) body.push('\n## ' + label + '戰績\n\n' + t);
  }

  body.push('\n## 資料界線\n\n');
  if (c.source) body.push('- 姓名來源:' + c.source + '\n');
  /* 上游沒有的東西照實說,不要讓讀者以為是本站漏了。 */
  const missing = [['接任日期', c.since], ['任內戰績', c.seasonRecord ?? c.allRecord],
    ['慣用陣型', c.formation], ['風格', c.style]].filter(([, v]) => !hasValue(v)).map(([k]) => k);
  if (missing.length) body.push('- 上游沒有給:' + missing.join('、') + ' —— 不是本站漏了,是這個來源就沒有\n');
  body.push('- 建置時間 ' + ctx.builtAt + '\n');
  return { body: body.join(''), links };
}


/* ── 球隊名冊:不是只有本季那 20 隊 ──────────────────────────
   歷史比賽會提到已經降級的球隊(英超 clubs.json 27 隊、西甲人工對照 29 隊)。
   只認本季 20 隊的話,那些比賽的球隊會變成沒有連結的純文字,
   而且 85 名西甲球員(MLL / OVI / GIR)也會連不到任何球隊筆記。
   所以名冊取聯集:有完整賽季資料的照常,只有身分的也給一則筆記。 */
function clubDirectory(lg, teams) {
  const dir = new Map(teams.map(t => [t.code, { ...t, rich: true }]));
  /* 每個聯賽讀**自己的** clubs.json(三個 build 都會寫,內容就是該聯賽的名冊)。
     原本非 pl 一律讀死 teams-la-liga.json —— 加英冠時它把西甲那 29 隊
     整批塞進英冠的名冊,vault 裡就出現了「英冠/球隊/FC Barcelona.md」。
     跟 dataDir 那一行是同一類錯:「不是英超」不等於「就是西甲」。 */
  const extra = arr(load(lg.key, 'clubs'));
  for (const c of extra) {
    if (!c?.code || dir.has(c.code)) continue;
    dir.set(c.code, { ...c, rich: false });
  }
  return dir;
}

/* ── 球員榜(2026-09-26,使用者:「上季聯賽的賽後報告跟球員榜也存進去」)──────────
   六個聯賽、盃賽與歐冠都有,一季一則筆記(`{聯賽}/球員榜/`、`英格蘭盃賽/球員榜/`、`歐冠/球員榜/`)。
   產物有三種形狀,照各自明講的 source 分(跟站上 page-players.js 同一個分法,不猜形狀):
     - 英超(FPL):leaders.last / current 是列,榜的標題與格式在 leaders.boards(lib/players.mjs 的 PL_BOARDS)
     - Understat(西甲、德義法):leaders.boards 是定義、leaders.last / current 是列
     - 逐場累加(英冠、盃賽、歐冠本季):每一張榜自己帶列、母體與小數位
   **列的是產物裡的全部** —— 站上英超的榜只畫前 8 名,產物有 12 名,這裡照產物給。
   **球員連結只用 id 對**(英超 FPL code、英冠 FotMob id、Understat id),對不到的只印名字 —— 不比姓名
   (「姓氏唯一就配對會對到完全不同的人」那條坑)。盃賽與歐冠的列只印名字:榜上的 id 是 FotMob 的,
   而本站英超的球員名冊用 FPL 的 id,只連得到一部分的話,連到的跟連不到的讀者分不出是哪一種。 */
const fixed = (v, d) => (v == null ? '—' : Number(v).toFixed(d));
/* 英超那一套的格式:digits 0 原樣印、signed 是正數加 +、suffix 接在後面(跟站上 page-players.js 讀同一份定義) */
const plBoardValue = (b, v) => (v == null ? '—' : (b.signed && v > 0 ? '+' : '') + (b.digits ? fixed(v, b.digits) : String(v)) + (b.suffix ?? ''));
/* Understat 那一套(站上 boardCard 的寫法):每 90 分鐘的、或本身帶小數的,印兩位 */
const understatValue = (b, v) => (v == null ? '—' : b.per90 || String(v).includes('.') ? fixed(v, 2) : String(v));
/* 逐場累加那一套(站上 cupLeaderBoards / renderAggregate):dp 位小數再接單位 */
const aggregateValue = (b, v) => (v == null ? '—' : (b.dp ? fixed(v, b.dp) : String(v)) + (b.unit ?? ''));

function renderBoardNote({ path, fm, title, intro = [], boards, headers, boundary = [] }) {
  const links = [];
  const body = [frontmatter(fm), `\n# ${title}\n`];
  for (const line of intro.filter(Boolean)) body.push('\n' + line + '\n');
  for (const b of boards) {
    body.push(`\n## ${b.title}${b.sub ? `(${b.sub})` : ''}\n\n`);
    if (!b.rows.length) { body.push((b.emptyWhy ?? '這一季這張榜是空的。') + '\n'); continue; }
    const hs = headers(b);
    body.push(`| # | ${hs.join(' | ')} |\n|---|${hs.map(() => '---').join('|')}|\n`);
    b.rows.forEach((r, i) => {
      const cells = r.cells(links);
      body.push(`| ${i + 1} | ${cells.join(' | ')} |\n`);
    });
    if (b.after) body.push('\n' + b.after + '\n');
  }
  body.push('\n## 資料界線\n\n' + boundary.filter(Boolean).map(x => '- ' + x).join('\n') + '\n');
  addNote(path, body.join(''), links);
}

/* 一個聯賽的球員榜 → 各季一則。回傳 [{ season, file, boards }] 給聯賽首頁列連結 */
function buildLeagueBoards(lg, meta, D, { players, teamFile, builtAt }) {
  const L = load(lg.key, 'leaders');
  if (!L) return [];
  const fileById = new Map(players.map(p => [p.id, p.file]));
  const playerCell = (id, name, links) => {
    const f = id != null ? fileById.get(id) : null;
    if (f) { links.push(f); return wl(f); }
    return name ?? '(未知)';
  };
  const teamCell = (code, fallback, links) => {
    const f = code ? teamFile(code) : null;
    if (f) { links.push(f); return wl(f); }
    return fallback ?? code ?? '—';
  };
  const out = [];
  const emit = (season, phase, spec) => {
    if (!spec.boards.some(b => b.rows.length)) return;   // 整季每一張都空:不開空殼筆記(鐵則三),首頁那一行照講
    const file = sanitize(`${lg.zh} 球員榜 ${season}`);
    renderBoardNote({
      path: `${D}/球員榜/${file}.md`,
      fm: { 類型: '球員榜', 聯賽: lg.zh, 賽季: season, 階段: phase, 來源: spec.source, 榜數: spec.boards.length, 產生時間: builtAt },
      title: `${lg.zh} ${season} 球員榜`,
      ...spec,
    });
    out.push({ season, phase, file, boards: spec.boards.length });
  };
  const seasonPhase = season => (season === meta.currentSeason ? '本季至今' : '上季完整賽季');
  const missingLine = L.missing?.length ? '這個聯賽的球員資料**沒有**:' + L.missing.join('、') : null;
  const dropNote = '列的是產物裡的全部名次(站上的榜只畫前幾名);球員連結用上游的 id 對到本站的球員筆記,對不到的只印名字,不比姓名。';

  if (L.source === 'match-aggregate') {
    /* 英冠:逐場逐人統計累加(lib/season-players.mjs)。說明照站上 renderAggregate 的 drawNote */
    for (const season of Object.keys(L.boards ?? {}).sort().reverse()) {
      const Y = L.layer?.[season] ?? {};
      const cc = Y.cardCheck;
      emit(season, seasonPhase(season), {
        source: 'FotMob 逐場累加',
        intro: [
          L.note,
          `${season}:逐場詳情 ${Y.matches ?? 0} 場,其中 **${Y.reconciled ?? 0} 場**的球員進球對得回本站賽果的比分才計入`
            + (Y.excluded?.length ? `,**${Y.excluded.length} 場**對不上整場不計(${Y.excluded.map(e => e.key.split('|').slice(1).join(' vs ') + ':' + e.reason).join(';')})` : '')
            + `;xG 只加射門圖完整的 ${Y.xgComplete ?? 0} 場。`,
          cc ? `牌是從比賽事件用「同一場同一隊的姓名」接回球員身上的,拿 ${cc.source} 逐場比對:${cc.agree}/${cc.compared} 組一致,${cc.withRed} 組差在有紅牌的場次(兩邊對「兩黃變一紅」的記法不同)。` : null,
          Y.cardsUnmatched ? `另有 ${Y.cardsUnmatched} 筆牌事件接不到球員 —— 那是總教練吃牌,本來就不該掛到球員身上。` : null,
        ],
        boards: (L.boards[season] ?? []).map(b => ({
          title: b.zh, sub: `母體 ${b.pool} 人`,
          rows: (b.rows ?? []).map(r => ({ cells: links => [
            playerCell(r.pid != null ? `en2:${r.pid}` : null, r.name, links), teamCell(r.teamId, r.team, links),
            aggregateValue(b, r.value), r.minutes ?? '—', r.matches ?? '—'] })),
        })),
        headers: () => ['球員', '球隊', '數值', '分鐘', '出賽'],
        boundary: [dropNote, missingLine, `建置時間 ${builtAt}`],
      });
    }
    return out;
  }

  if (L.source === 'Understat') {
    /* 西甲、德義法:Understat 整季彙總。球隊那一格用**那一季**的隊碼(players.json 逐季一筆的 teamCodes),
       不用球員筆記上的現隊 —— 上季的榜掛現隊就是把人放錯隊 */
    const raw = arr(load(lg.key, 'players'));
    const rowOf = new Map(raw.map(p => [String(p.id) + '|' + p.season, p]));
    for (const which of ['current', 'last']) {
      const season = L.seasons?.[which];
      if (!season || !L[which]) continue;
      emit(season, which === 'current' ? '本季至今' : '上季完整賽季', {
        source: 'Understat',
        intro: [L.note, `每 90 分鐘的門檻是 ${L.minMinutes} 分鐘 —— 樣本太少的給了會誤導。`],
        boards: (L.boards ?? []).map(b => ({
          title: b.label, sub: b.unit,
          emptyWhy: b.per90 ? `還沒有人踢滿 ${L.minMinutes} 分鐘,每 90 分鐘的數字現在給了會誤導,所以先不給。` : '這一季這張榜是空的(為什麼見資料界線)。',
          rows: (L[which]?.[b.key] ?? []).map(r => ({ cells: links => {
            const me = rowOf.get(String(r.id) + '|' + season);
            const teams = (me?.teams ?? r.teams ?? []).map((n, i) => teamCell(me?.teamCodes?.[i], n, links));
            return [playerCell(`${lg.key}:${r.id}`, r.name, links), teams.join(' / ') + (r.multiTeam ? '(跨隊,數字是兩隊合計)' : ''),
              understatValue(b, r.value), r.minutes ?? '—'];
          } })),
        })),
        headers: b => ['球員', '球隊', b.sub || '數值', '分鐘'],
        boundary: [dropNote, missingLine, `Understat 抓取於 ${L.retrievedAt ?? '—'}`, `建置時間 ${builtAt}`],
      });
    }
    return out;
  }

  /* 英超(FPL):上季的列掛在 lastTeam,本季的掛現隊。lastTeam 是 FPL 上季的**季末快照**(lib/players.mjs:
     `lastTeam: prev?.team`)—— 季中轉隊的人整季的數字都掛在季末那一隊(Semenyo 2025-26 的 17 球掛在曼城,
     而本站 2025-26 的賽後報告裡他替伯恩茅斯踢到 2026-01-07、2026-01-17 起才是曼城)。
     站上原本寫「掛在當時效力的球隊」,那句對季中轉隊的人不成立,一起改了 */
  for (const which of ['current', 'last']) {
    const season = L.seasons?.[which];
    if (!season || !L[which]) continue;
    emit(season, which === 'current' ? '本季至今' : '上季完整賽季', {
      source: 'FPL 官方數據(本站計算)',
      intro: [which === 'current'
        ? `本季 ${season} 至今(${L.currentRounds} 輪)。`
        : `上季 ${season} 完整賽季・球隊是 FPL **季末快照**裡的那一隊 —— 季中轉隊的人,整季的數字都掛在季末那一隊;夏天才轉隊的,旁邊註明現在的球隊。`,
        '每 90 分鐘與比例類的榜只收出場達門檻的球員(門檻與公式在 `lib/players.mjs` 的 leaderboards)。'],
      boards: (L.boards ?? []).map(b => ({
        title: b.label, sub: b.unit,
        emptyWhy: '這一季這張榜在產物裡是空的(站上同一張榜寫「本季尚無資料」)。',
        rows: (L[which]?.[b.key] ?? []).map(r => ({ cells: links => [
          playerCell(`pl:${r.code}`, r.name, links), r.posZh ?? r.pos ?? '—',
          teamCell(which === 'last' ? (r.lastTeam ?? r.team) : r.team, null, links)
            + (which === 'last' && r.transferred && r.team !== r.lastTeam ? `(已轉隊,現效力 ${teamCell(r.team, null, links)})` : ''),
          plBoardValue(b, r.value), r.minutes ?? '—'] })),
      })),
      headers: b => ['球員', '位置', '球隊', b.sub || '數值', '分鐘'],
      boundary: [dropNote, `建置時間 ${builtAt}`],
    });
  }
  return out;
}

/* ── 主流程 ──────────────────────────────────────────────── */
const summary = [];
/* 聯賽賽後報告沒掛上的(索引指到檔案不在、往季撞鍵、日期對不上)—— 印出來,不靜靜略過 */
const reportTrouble = [];
const allPlayers = [];

for (const lg of LEAGUES) {
  const meta = load(lg.key, 'meta');
  if (!meta) { console.log('  ⚠ ' + lg.zh + ' 沒有 meta.json,略過'); continue; }
  const teams = arr(load(lg.key, 'teams'));
  const fixturesRaw = arr(load(lg.key, 'fixtures'));
  const players = collectPlayers(lg, meta);
  for (const p of players) p.leagueZh = lg.zh;
  allPlayers.push({ lg, meta, teams, fixturesRaw, players });
}

// 檔名要在**兩個聯賽都收齊之後**才決定 —— 撞名有 13 組是跨聯賽的。
assignFilenames(allPlayers.flatMap(x => x.players));

// 球隊筆記的檔名要先算好,別的地方(歐冠、盃賽)才連得過去。
const teamFileByCode = new Map();   // lgKey:code → 檔名
{
  /* 同一支球隊會同時出現在兩個聯賽的名冊裡 —— 升降級的球隊本來就該兩邊都在
     (Burnley 有英超的歷史,本季在英冠)。但 **Obsidian 的 [[連結]] 是拿檔名
     跨資料夾解析的**,兩個同名檔案會讓連結指到其中一個,而且不會有任何地方報錯。
     所以第一個聯賽用原名,之後的加聯賽後綴。順序照 LEAGUES ——
     英超在最前面,所以既有的英超筆記檔名不會被改掉(改了會斷掉手寫筆記裡的連結)。 */
  const claimed = new Map();          // 檔名 → 先用掉它的聯賽 key
  for (const { lg, teams } of allPlayers) {
    for (const [code, c] of clubDirectory(lg, teams)) {
      const base = sanitize(c.en || c.of || code);
      const taken = claimed.get(base);
      teamFileByCode.set(lg.key + ':' + code, taken && taken !== lg.key ? base + '(' + lg.zh + ')' : base);
      if (!taken) claimed.set(base, lg.key);
    }
  }
}
/* 一支球隊在哪幾個聯賽有筆記 —— 給筆記裡的「同一支球隊的其他聯賽」那一行用。
   不放這一行的話,讀者站在英超的 Burnley 筆記上,不會知道還有一則英冠的。 */
const teamAlsoIn = new Map();         // lgKey:code → [{ zh, file }]
for (const { lg, teams } of allPlayers) {
  for (const [code] of clubDirectory(lg, teams)) {
    const others = allPlayers
      .filter(x => x.lg.key !== lg.key && teamFileByCode.has(x.lg.key + ':' + code))
      .map(x => ({ zh: x.lg.zh, file: teamFileByCode.get(x.lg.key + ':' + code) }));
    if (others.length) teamAlsoIn.set(lg.key + ':' + code, others);
  }
}

for (const { lg, meta, teams, fixturesRaw, players } of allPlayers) {
  const clubs = clubDirectory(lg, teams);
  const teamNameOf = code => clubs.get(code)?.en ?? null;
  /* 隊徽落成真圖檔(base64 → png),球隊筆記用 [[嵌入]] 顯示 */
  const crestFileOf = new Map();
  for (const t of clubs.values()) {
    const d = dataUriBuf(t.crest);
    if (!d) continue;
    const f = `隊徽 ${lg.key}-${t.code}.${d.ext}`;
    addAsset(`_資產/隊徽/${f}`, d.buf);
    crestFileOf.set(t.code, f);
  }
  const crestEmbed = code => (crestFileOf.has(code) ? `![[${crestFileOf.get(code)}|72]]` : '');
  const coaches = load(lg.key, 'coaches');
  const coachList = arr(coaches?.coaches ?? coaches ?? []).filter(c => c?.name);
  const coachBy = new Map(coachList.filter(c => c?.team).map(c => [c.team, c]));
  const tableRaw = load(lg.key, 'table');
  const table = arr(tableRaw?.rows ?? tableRaw?.table ?? tableRaw ?? [])
    .filter(r => r && r.code && r.pos != null);
  const reportsFile = readMatchReports(dataDir(lg.key));   // 本季:本體是逐場檔(2026-09-26 起),讀回來形狀不變
  /* 上一季(2026-09-26 起進 vault):往季的逐場檔。讀不到 / 撞鍵的由 readArchivedReports 收起來,這裡印出來 */
  const archived = readArchivedReports(dataDir(lg.key));
  const reports = { ...(reportsFile?.reports ?? {}), ...(archived?.reports ?? {}) };
  const repCount = { current: 0, archive: 0 };
  for (const x of [...(reportsFile?.missing ?? []), ...(archived?.missing ?? []), ...(archived?.conflicts ?? [])]) reportTrouble.push(lg.zh + ' ' + x);
  const goalsFile = load(lg.key, 'goals');
  /* 逐場統計(FotMob,2026-09-03):控球、球隊統計、逐射門 xG、事件。英超才有;沒有檔就整段不寫。
     使用者指定 Obsidian vault 是這批資料的「資料庫」,所以比賽筆記與球隊筆記都要寫進去。 */
  const matchStats = load(lg.key, 'matchstats');
  const playerLogs = load(lg.key, 'player-logs');
  /* 走查回測的預測**是**賽前預測 —— 訓練資料只到該輪開賽前,
     跟 fixtures.json 那個建置時重算的完全不是同一回事。
     所以這一份可以放心印在已完賽的場次上,而且要講清楚它是哪一種。 */
  const wfPath = join(ROOT, 'data', lg.wf);
  const walkForward = new Map();
  let walkForwardSeason = null;
  if (existsSync(wfPath)) {
    const wf = read(wfPath);
    walkForwardSeason = wf.season;
    for (const m of wf.matches ?? []) walkForward.set(m.season + '|' + m.home + '|' + m.away, m.pred);
  }

  const matchFile = m => sanitize(lg.zh + ' ' + m.season
    + ' R' + String(m.round ?? 0).padStart(2, '0') + ' ' + m.home + '-' + m.away);
  /* 站上單場頁與球隊頁的其餘幾塊(2026-09-26):缺檔就是 null / 空,對應的區塊整個不寫 */
  const analysis = load(lg.key, 'analysis');
  const expertsFile = load(lg.key, 'experts');
  const probHistory = load(lg.key, 'prob-history');
  const formFile = load(lg.key, 'form');
  const h2hFile = load(lg.key, 'h2h') ?? {};
  const shapesFile = load(lg.key, 'shapes') ?? {};
  const tacticsAll = arr(load(lg.key, 'tactics'));
  const simAll = arr(load(lg.key, 'sim'));
  const formationFile = load(lg.key, 'formation');
  const newsAll = arr(load(lg.key, 'news')).filter(n => n?.title);

  /* 本季賽程 + 歷史賽果。results.json 與 fixtures.json 在本季是重疊的
     (results 只收已完賽),所以用 season|home|away 去重,以 fixtures 為準 ——
     fixtures 那一份帶著預測與開球時間。重複產生的話會是兩則同檔名筆記。 */
  const fixtures = fixturesRaw
    .filter(f => f.season === meta.currentSeason)
    .map(f => ({ ...f, file: matchFile(f), 歷史: false }));
  const seen = new Set(fixtures.map(f => f.season + '|' + f.home + '|' + f.away));
  const history = arr(load(lg.key, 'results'))
    .filter(m => m && m.home && m.away && !seen.has(m.season + '|' + m.home + '|' + m.away))
    .map(m => ({ ...m, file: matchFile(m), 歷史: true }));
  const matches = [...fixtures, ...history];
  /* 「季|主|客」→ 那一場的筆記。英冠的升級附加賽會跟聯賽撞同一個鍵,所以只收聯賽場次(交手紀錄也只算聯賽),
     查的時候再用日期收斂一次 —— 對不上寧可不連,連錯場比沒有連結糟 */
  const matchByKey = new Map();
  for (const m of matches) {
    const k = m.season + '|' + m.home + '|' + m.away;
    if (!m.stage && !matchByKey.has(k)) matchByKey.set(k, m);
  }
  const fixtureById = new Map(fixtures.filter(f => f.id != null).map(f => [String(f.id), f.file]));

  const playersByTeam = new Map();
  for (const p of players) {
    if (!p.teamCode) continue;
    if (!playersByTeam.has(p.teamCode)) playersByTeam.set(p.teamCode, []);
    playersByTeam.get(p.teamCode).push(p);
  }
  const fixturesByTeam = new Map();
  for (const f of fixtures) for (const c of [f.home, f.away]) {
    if (!fixturesByTeam.has(c)) fixturesByTeam.set(c, []);
    fixturesByTeam.get(c).push(f);
  }
  const historyByTeam = new Map();
  for (const m of history) for (const c of [m.home, m.away]) {
    if (!historyByTeam.has(c)) historyByTeam.set(c, []);
    historyByTeam.get(c).push(m);
  }

  /* 欄位照各聯賽真的有的來。**不要用「不是英超就是西甲」的二元式** —— 英冠是第三種
     (逐場累加:多了評分、沒有 FPL 分與先發數)。 */
  const statCols = lg.key === 'pl'
    ? [['出賽分鐘', 'minutes'], ['先發', 'starts'], ['進球', 'goals'], ['助攻', 'assists'],
       ['xG', 'xG'], ['xA', 'xA'], ['黃牌', 'yellow'], ['紅牌', 'red'], ['FPL 分', 'points']]
    : lg.key === 'en2'
      ? [['出賽', 'games'], ['分鐘', 'minutes'], ['進球', 'goals'], ['助攻', 'assists'],
         ['xG', 'xG'], ['xA', 'xA'], ['射門', 'shots'], ['關鍵傳球', 'keyPasses'],
         ['黃牌', 'yellow'], ['紅牌', 'red'], ['評分(逐場平均)', 'rating']]
      : [['出賽', 'games'], ['分鐘', 'minutes'], ['進球', 'goals'], ['助攻', 'assists'],
         ['xG', 'xG'], ['xA', 'xA'], ['射門', 'shots'], ['關鍵傳球', 'keyPasses'],
         ['黃牌', 'yellow'], ['紅牌', 'red']];
  /* Understat 那四個聯賽裡,有沒有身分來源(背號、頭貼、出生日期)看產物宣告的,不看聯賽代碼:
     西甲有 SportMonks,德義法沒有 —— 寫成「不是英超英冠就是 ['傷停與停賽', '防守數據']」的話,
     德義法的筆記會漏講背號與頭貼為什麼是空的。 */
  const noIdentity = players.length > 0 && players.every(p => p.sources?.身分與背號 == null);
  const playerGaps = lg.key === 'pl' ? []
    : lg.key === 'en2' ? ['傷停與停賽', '球員 xG 模型(這裡的 xG 是逐射門加總)', '身價、年齡與頭貼']
      : ['傷停與停賽', '防守數據', ...(noIdentity ? ['背號、頭貼、出生日期與身價(Understat 不給,這個聯賽沒有第二個身分來源)'] : [])];

  const ctx = {
    lg, teamNameOf, playersByTeam, fixturesByTeam, historyByTeam, statCols, playerGaps,
    crestEmbed,
    coachOf: code => coachBy.get(code) ?? null,
    coachFileOf: code => { const c = coachBy.get(code); return c ? coachFileOf(c, lg) : null; },
    reportFor: m => {
      const k = m.season + '|' + m.home + '|' + m.away;
      const r = reports[k];
      if (!r || r.demo) return null;
      /* 鍵是「季|主|客」,再用日期收斂一次(「同一組對戰在不同賽季會重複」那條坑的防線)。
         對不上的不掛、記下來印出來 —— 把某一場的報告掛到另一場上比沒有糟得多(實測 0 場) */
      if (r.date && m.date && r.date !== m.date) { reportTrouble.push(lg.zh + ' 日期對不上 ' + k); return null; }
      repCount[m.season === meta.currentSeason ? 'current' : 'archive']++;
      return r;
    },
    walkForwardFor: m => walkForward.get(m.season + '|' + m.home + '|' + m.away) ?? null,
    walkForwardSeason: walkForwardSeason,
    goalsFor: code => goalsFile?.data?.[meta.lastSeason]?.teams?.[code] ?? null,
    goalsSeason: meta.lastSeason, goalsNote: goalsFile?.note ?? null,
    matchStatsFor: m => matchStats?.matches?.[m.season + '|' + m.home + '|' + m.away] ?? null,
    logsFor: code => playerLogs?.logs?.[String(code)] ?? null,
    teamMatchStatsFor: code => matchStats?.teams?.[code] ?? null,
    matchStatsVerification: matchStats?.verification ?? null,
    /* 租借往來:跨聯賽單一份,掛英超目錄(cups 慣例)—— 三個聯賽的球隊筆記都從這裡讀 */
    loansFor: (() => {
      const all = arr(load('pl', 'loans')?.records ?? []);
      return code => all.filter(r => r.parentCode === code || r.loanCode === code);
    })(),
    builtAt: meta.builtAt, currentSeason: meta.currentSeason, lastSeason: meta.lastSeason,
    modelName: meta.model?.name ?? 'Dixon-Coles Poisson + Elo',
    sources: meta.sources, table,
    /* ── 站上單場頁與球隊頁的其餘幾塊(2026-09-26)。查法照站上:賽前文章的鍵沒有季(只收即將開賽的)、
       賽後文章與專家觀點的鍵有季、勝率曲線的鍵沒有季但檔頭有季、交手的鍵是排序過的兩隊 ── */
    preArticleFor: f => (!f.played && f.season === meta.currentSeason ? analysis?.pre?.[f.home + '|' + f.away] ?? null : null),
    postArticleFor: f => (f.played && f.season === meta.currentSeason ? analysis?.post?.[f.season + '|' + f.home + '|' + f.away] ?? null : null),
    expertsFor: f => arr(expertsFile?.matches?.[f.season + '|' + f.home + '|' + f.away] ?? []),
    expertsInfo: expertsFile ? { updatedAt: expertsFile.updatedAt } : null,
    probFor: f => (probHistory?.season === f.season ? probHistory.matches?.[f.home + '|' + f.away] ?? null : null),
    h2hAvailable: Object.keys(h2hFile).length > 0,
    h2hFor: f => h2hFile[[f.home, f.away].sort().join('|')] ?? null,
    h2hSince: meta.h2hSeasons?.[0] ?? null,
    matchFileOf: m => {
      const x = matchByKey.get(m.season + '|' + m.home + '|' + m.away);
      return x && (!m.date || !x.date || x.date === m.date) ? x.file : null;
    },
    formFor: code => formFile?.teams?.[code] ?? null,
    formAsOf: formFile?.asOf ?? meta.asOf ?? null,
    formNote: formFile?.note ?? null,
    hasAvailability: Object.values(formFile?.teams ?? {}).some(x => x?.availability),
    playerFileByFpl: (() => {
      const by = new Map(players.filter(p => p.fplCode).map(p => [String(p.fplCode), p.file]));
      return code => by.get(String(code)) ?? null;
    })(),
    shapeFor: code => shapesFile?.[code] ?? null,
    tacticsTeams: tacticsAll.length,
    simRuns: meta.model?.simulationRuns ?? null,
    /* 名額的說法照各聯賽自己寫在資料界線裡的那一句(英冠「前 2 直升、3~6 附加賽、後 3 降級」、德義法的升降級規則) */
    zoneRule: (meta.boundaries ?? []).filter(x => /升降級|直升|附加賽/.test(x)).map(x => x.replace(/^[✓—]\s*/, '')).join(' ') || null,
    newsFor: code => newsAll.filter(n => newsTeams(n).includes(code)),
    newsFile: sanitize(lg.zh + ' 外電與動態'),
    fixtureFileById: id => fixtureById.get(String(id)) ?? null,
    simTable: simAll, tacticsAll, formation: formationFile,
    newsCount: newsAll.length,
    newsRange: newsAll.length ? (d => `${d[0]} ~ ${d.at(-1)}`)(newsAll.map(n => n.date).filter(Boolean).sort()) : null,
  };

  const D = lg.dir;
  /* 球員榜先產:聯賽首頁要列它們的連結 */
  ctx.boardNotes = buildLeagueBoards(lg, meta, D, {
    players, teamFile: code => teamFileByCode.get(lg.key + ':' + code) ?? null, builtAt: meta.builtAt,
  });
  const leagueNote = renderLeague(ctx, [...clubs.values()], players, matches);
  addNote(D + '/' + lg.zh + '.md', leagueNote.body, leagueNote.links);
  if (newsAll.length) {
    const nn = renderNewsNote(newsAll, ctx);
    addNote(D + '/' + ctx.newsFile + '.md', nn.body, nn.links);
  }
  for (const t of clubs.values()) {
    const r = renderTeam(t, ctx);
    const also = teamAlsoIn.get(lg.key + ':' + t.code) ?? [];
    const body = also.length
      ? r.body + '\n> 同一支球隊在本站其他聯賽也有筆記(升降級):'
        + also.map(o => '[[' + o.file + '|' + o.zh + ']]').join('、') + '\n'
      : r.body;
    const links = also.length ? [...r.links, ...also.map(o => o.file)] : r.links;
    // 檔名走 teamFileByCode —— 撞名時它已經加了聯賽後綴,這裡不可以自己再算一次
    addNote(D + '/球隊/' + teamFileByCode.get(lg.key + ':' + t.code) + '.md', body, links);
  }
  for (const p of players) {
    /* 頭貼:英超是 base64 → 落成 jpg 檔嵌入;西甲是 SportMonks CDN 外連
       (照實標示離線不顯示);英冠沒有頭貼(逐場資料不帶),photo 是 null → 兩條都不走。 */
    const d = dataUriBuf(p.photo);
    if (d) {
      const f = `頭貼 ${sanitize(p.id)}.${d.ext}`;
      addAsset(`_資產/頭貼/${f}`, d.buf);
      p.photoEmbed = `![[${f}|110]]`;
    } else if (/^https?:/.test(String(p.photo ?? ''))) {
      p.photoEmbed = `![頭貼|110](${p.photo})\n> 頭貼為外部連結(SportMonks CDN),離線時不顯示。`;
    }
    const r = renderPlayer(p, ctx);
    addNote(D + '/球員/' + p.file + '.md', r.body, r.links);
  }
  for (const m of matches) {
    const r = renderMatch(m, ctx);
    addNote(D + '/比賽/' + m.file + '.md', r.body, r.links);
  }
  for (const c of coachList) {
    const r = renderCoach(c, ctx);
    addNote(D + '/教練/' + coachFileOf(c, lg) + '.md', r.body, r.links);
  }
  summary.push('  ' + lg.zh + ':' + clubs.size + ' 隊・' + players.length + ' 球員・'
    + matches.length + ' 場(本季 ' + fixtures.length + '・歷史 ' + history.length + ')・'
    + coachList.length + ' 教練・賽後報告 本季 ' + repCount.current + ' + ' + (archived?.season ?? '上季') + ' ' + repCount.archive + ' 場・球員榜 '
    + (ctx.boardNotes.length ? ctx.boardNotes.map(b => b.season).join('、') : '無'));
}


/* ── 盃賽與歐冠的賽後報告 ─────────────────────────────────
   2026-09-26 加的(使用者:「盃賽跟歐冠的賽後報告也存進去」)。逐場檔是 `toCanonicalDetail` 的形狀
   (`cup-details/{盃}/{季}/{id}.json`、`ucl-details/{季}/{id}.json`),跟聯賽比賽筆記讀的 matchstats 不一樣,
   所以自己一支。做法跟聯賽的賽後報告一樣:**併進那一場的比賽筆記,不另開筆記** —— 它是那則筆記的內容。

   界線照站上單場頁講的(page-cup-match.js、ucl-view.js 的 renderPostMatch):
   - 盃賽的比分核對**不是獨立來源**(賽果本身就是 FotMob),產物的 scoreCheck.note 照印;歐冠跟 football-data.org 核對過
   - xG 是逐射門加總;射門圖不完整的場次沒有 xG
   - PK 大戰的十二碼不算射門 —— 用 lib/matchstats.mjs 的 isShootoutShot,同一條規則不寫第二份
   - 上游這一場沒有的那幾塊(`partial`,足總盃前幾輪的低級別場次常見)講出來,不畫一張空表
   - 上游的 detail / comments 有時候是物件 → 取 defaultText,取不到就整句不印(`[object Object]` 那條坑) */
/* 這一段用到的常數(EVENT_ZH、textOf、loadDetail、reportCount)宣告在檔案前面,跟 SHOT_SIT_ZH 放一起:
   聯賽的比賽筆記在**主流程**裡就會呼叫 renderDetailReport(SportMonks 那 30 場),const 不會提升 ——
   留在這裡就是「模組層的 const 宣告在檔尾 = 暫時死區」那條坑(2026-09-26 實際撞到)。 */
/* heading / nameOf(2026-09-26):聯賽的報告沒有 `names`(sides 用隊碼當鍵),名字由呼叫端給;
   聯賽那一則已經有「## 賽後報告」,所以這一段要換個標題。盃賽與歐冠照舊不傳。 */
function renderDetailReport(rep, { caveats = [], heading = '## 賽後報告(FotMob 逐場詳情)', nameOf = null } = {}) {
  const d = rep?.advanced;
  if (!d) return '';
  const ids = [rep.home, rep.away];
  const nm = id => nameOf?.(id) ?? rep.names?.[id] ?? id;
  const v = x => (x == null ? '—' : x);
  const out = ['\n' + heading + '\n\n'];
  for (const c of caveats.filter(Boolean)) out.push('> ' + c + '\n');
  const miss = (rep.partial ?? []).map(x => x.zh).filter(Boolean);
  if (miss.length) out.push(`> **上游這一場沒有${miss.join('與')}** —— 低級別的場次常見,所以下面沒有那幾塊;球隊統計、事件、射門與正式名單不受影響。\n`);

  // 球隊統計
  const hs = d.teamStats?.[rep.home] ?? {}, as = d.teamStats?.[rep.away] ?? {};
  const rows = [['控球 %', 'possession'], ['射門', 'shots'], ['射正', 'shotsOn'], ['射偏', 'shotsOff'], ['被封阻', 'blockedShots'],
    ['xG', 'xG'], ['角球', 'corners'], ['越位', 'offsides'], ['犯規', 'fouls'], ['撲救', 'saves'], ['傳球', 'passes'],
    ['成功傳球', 'passesAccurate'], ['傳球成功率 %', 'passAccuracy']]
    .filter(([, k]) => hs[k] != null || as[k] != null)
    .map(([l, k]) => `| ${l} | ${v(hs[k])} | ${v(as[k])} |`);
  if (d.possession?.h1) rows.push(`| 上半場控球 % | ${v(d.possession.h1[0])} | ${v(d.possession.h1[1])} |`, `| 下半場控球 % | ${v(d.possession.h2?.[0])} | ${v(d.possession.h2?.[1])} |`);
  const ph = d.physical?.team;
  if (ph?.distance?.some(x => x != null)) {
    const km = x => (x == null ? '—' : (x / 1000).toFixed(1) + ' km');
    rows.push(`| 跑動距離 | ${km(ph.distance[0])} | ${km(ph.distance[1])} |`);
    if (ph.sprintDistance?.some(x => x != null)) rows.push(`| 衝刺距離 | ${v(ph.sprintDistance[0])} m | ${v(ph.sprintDistance[1])} m |`);
    if (ph.sprints?.some(x => x != null)) rows.push(`| 衝刺次數 | ${v(ph.sprints[0])} | ${v(ph.sprints[1])} |`);
  }
  if (rows.length) out.push(`\n### 球隊統計\n\n| | ${nm(rep.home)} | ${nm(rep.away)} |\n|---|---|---|\n${rows.join('\n')}\n`);

  // 陣型、教練、先發
  const lines = ids.map(id => {
    const lu = d.lineups?.[id], sd = rep.sides?.[id];
    const shape = lu?.formation ?? sd?.shape?.label;
    const coach = lu?.coach ?? sd?.coach;
    const xi = (lu?.xi ?? []).map(p => `${p.shirt != null ? p.shirt + ' ' : ''}${p.name}`);
    const subs = (d.players?.[id] ?? []).filter(p => p.substitute && p.minutes > 0).map(p => p.name);
    if (!shape && !coach && !xi.length) return null;
    return `- **${nm(id)}**${shape ? ` ${shape}` : ''}${coach ? `・教練 ${coach}` : ''}`
      + (xi.length ? `\n  - 先發:${xi.join('、')}` : '') + (subs.length ? `\n  - 替補上場:${subs.join('、')}` : '');
  }).filter(Boolean);
  if (lines.length) out.push('\n### 正式名單\n\n' + lines.join('\n') + '\n');

  // 事件
  const ev = (d.events ?? []).map(e => {
    const bits = [`${e.label || (e.minute != null ? e.minute + "'" : '—')}`, e.team ? nm(e.team) : null, EVENT_ZH[e.type] ?? e.type ?? '事件'];
    let s = '- ' + bits.filter(Boolean).join(' ') + (e.player ? `:${e.player}` : '');
    const extra = [e.assist ? `相關球員 ${e.assist}` : null,
      e.ownGoal ? `烏龍球${e.ownGoalBy ? `,${nm(e.ownGoalBy)} 的球員踢進自家球門` : ''}` : textOf(e.detail) || null,
      textOf(e.comments) || null].filter(Boolean);
    return s + (extra.length ? `(${extra.join(';')})` : '');
  });
  out.push('\n### 事件\n\n' + (ev.length ? ev.join('\n') + '\n' : '供應商沒有回傳事件時間軸。\n'));

  // 射門(PK 大戰的十二碼不算)
  const allShots = d.shots ?? [];
  const shots = allShots.filter(s => !isShootoutShot(s, { pens: d.pens === true }));
  if (shots.length) {
    const SIT = SHOT_SIT_ZH;
    out.push(`\n### 射門(${shots.length} 次${d.shotmapComplete === false ? ',進球數跟比分對不上,清單不完整' : ''})\n\n`
      + '| 分鐘 | 球隊 | 球員 | 情境 | xG | 結果 |\n|---|---|---|---|---|---|\n'
      + shots.map(s => `| ${s.min}${s.extra ? '+' + s.extra : ''} | ${nm(s.team)} | ${s.player ?? ''} | ${SIT[s.situation] ?? s.situation ?? ''} `
        + `| ${s.xg == null ? '' : s.xg.toFixed(2)} | ${s.type === 'Goal' ? '**進球**' : s.type ?? ''} |`).join('\n') + '\n');
    if (allShots.length > shots.length) out.push(`\n> PK 大戰的 ${allShots.length - shots.length} 球不算射門、也不算進 xG。\n`);
  }

  // 逐人(有上場分鐘的;整欄都沒有值的欄位不列)
  const COLS = [['位置', p => p.pos], ['分鐘', p => p.minutes], ['評分', p => (p.rating == null ? null : p.rating.toFixed(2))],
    ['進球', p => p.goals?.total], ['助攻', p => p.goals?.assists], ['射門/射正', p => (p.shots?.total == null && p.shots?.on == null ? null : `${v(p.shots?.total)}/${v(p.shots?.on)}`)],
    ['傳球/關鍵', p => (p.passes?.total == null && p.passes?.key == null ? null : `${v(p.passes?.total)}/${v(p.passes?.key)}`)],
    ['對抗勝/總', p => (p.duels?.won == null && p.duels?.total == null ? null : `${v(p.duels?.won)}/${v(p.duels?.total)}`)],
    ['鏟球', p => p.tackles?.total], ['抄截', p => p.tackles?.interceptions], ['撲救', p => p.goals?.saves],
    ['黃/紅', p => (p.cards?.yellow == null && p.cards?.red == null ? null : `${v(p.cards?.yellow)}/${v(p.cards?.red)}`)]];
  for (const id of ids) {
    const list = (d.players?.[id] ?? []).filter(p => p.minutes != null && p.minutes > 0)
      .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
    if (!list.length) continue;
    const cols = COLS.filter(([, f]) => list.some(p => f(p) != null));
    out.push(`\n### ${nm(id)} 逐人(${list.length} 人,依評分排)\n\n| 球員 | ${cols.map(([l]) => l).join(' | ')} |\n|---|${cols.map(() => '---').join('|')}|\n`
      + list.map(p => `| ${p.shirt != null ? p.shirt + ' ' : ''}${p.name}${p.captain ? '(隊長)' : ''} | ${cols.map(([, f]) => v(f(p))).join(' | ')} |`).join('\n') + '\n');
  }

  const mo = (d.momentum ?? []).filter(x => Array.isArray(x) && x.length === 2);
  if (mo.length) out.push(`\n### 動能(每分鐘,正=${nm(rep.home)})\n\n\`${mo.map(([, val]) => val).join(' ')}\`\n\n> 供應商的逐分鐘動能指標,本站只搬運不重算。\n`);
  return out.join('');
}

/* ── 歐冠 ────────────────────────────────────────────────
   跨聯賽的一份資料,所以放在自己的資料夾,不掛在任一個聯賽底下。

   **認得的球隊不另外開歐冠球隊筆記。** 認得的連回各聯賽的球隊筆記,不認得的才在 `歐冠/球隊/` 開一則
   (見下面那段)。給認得的也開一則的話,會跟聯賽那一則變成兩個同名檔案 —— Obsidian 的連結會指錯。

   **勝率照產物給(`ucl-elo.json`,2026-09-09 階段 C 起)。** 這裡原本寫「不放勝率預測」——
   那是階段 C 之前的事;之後站上兩隊都有跨聯賽評分的未賽場次都有賽前勝率,而 vault 還在否認
   (「只有一個」那句寫死在畫面上,第五次,這次在 vault)。所以有沒有、有幾場、驗收多少,一律從產物讀:
   回測沒通過時 fixtures 是空的,那句否定才會印,而那時它是真的。 */
/* 本站兩個聯賽認不得的球隊,在 vault 裡自己有一則筆記(`歐冠/球隊/`)。
   網站那邊只給隊徽不給連結 —— 因為網站沒有這些球隊的頁面可以連。
   vault 不一樣:一則筆記列出他們在歐冠踢過的每一場,是有內容的,所以連得過去。
   **仍然不跟聯賽球隊筆記混在一起**:只有認不得的才在這裡開,認得的連回聯賽那一則,
   否則同一支球隊會有兩個同名檔案,而 Obsidian 的 [[連結]] 會指錯。 */
const uclExternalFile = new Map();   // football-data id → 筆記檔名

function uclTeamRef(t, links) {
  if (!t) return '(未知)';
  const file = t.code && t.league ? teamFileByCode.get(t.league + ':' + t.code) : null;
  if (file) { links.push(file); return wl(file); }
  const ext = uclExternalFile.get(t.id);
  if (ext) { links.push(ext); return wl(ext); }
  return t.name ?? t.fullName ?? '(未知)';
}

/* 比分只能讀 `final`。這裡我自己踩了一次跟 CLAUDE.md 陷阱表同一類的坑:
   我以為 `et` 是「延長賽後的比分」,結果它是**延長賽的增量**。
   2025-26 歐冠決賽 final=[1,1]、ft90=[1,1]、et=[0,0]、pens=[4,3],
   照 et 印會變成「0:0(PK 4:3)」—— 而且半場還印著 0:1,自己跟自己矛盾。

   實測 final === ft90 + et 在歐冠 378 場全部成立;而 ft90 有 372 場是 null,
   所以 final 是唯一可靠的比分欄位。盃賽 1,444 場裡有 2 場上游自己對不起來,
   那兩場照樣印 final,但在筆記上標明「上游的分段欄位加不回總比分」。

   教訓跟文件裡那條一樣:斷言某個欄位是什麼意思之前,先拿全部資料驗一次。 */
const scoreParts = m => {
  if (!m.played || !m.final) return null;
  const s = m.final[0] + ':' + m.final[1];
  if (m.pens) return s + '(PK ' + m.pens[0] + ':' + m.pens[1] + ')';
  if (m.aet) return s + '(延長賽後)';
  return s;
};
/* 分段欄位加不回 final 的場次要標出來,不要挑一個喜歡的答案。 */
const scoreInconsistent = m => {
  if (!m.played || !m.final || !m.ft90) return false;
  const et = m.et ?? [0, 0];
  return m.ft90[0] + et[0] !== m.final[0] || m.ft90[1] + et[1] !== m.final[1];
};
const uclScoreLine = m => scoreParts(m) ?? '未賽';

let uclSource = null;
let uclExternalCount = 0;
/* 跨聯賽評分的賽前勝率(ucl-elo.json)。只有未賽、而且兩隊都有評分的場次才在 fixtures 裡 ——
   已完賽的場次產物本來就不帶(本站沒有保存歐冠的賽前機率快照)。 */
let uclElo = null;
let uclPredById = new Map();
/* 賽後報告的索引(ucl-details.json:football-data 的比賽 id → 賽季、xG…);逐場檔另外讀 */
let uclDetails = null;
/* 歐冠的球員榜(一季一則)。說明照站上 ucl-view.js 的 leaderBoards:逐場累加那一季講涵蓋,
   交付檔那兩季講「已與另一來源逐場核對」。隊伍那一格:列上的 teamId 是 football-data 的 id,
   跟這一季場次兩邊的 id 同一個空間(站上量過),所以走整份收一次再查;往季的列沒有 teamId,只給上游的名字 */
function buildUclBoards(s) {
  if (!s.leaders?.length) return null;
  const sideById = new Map();
  const see = t => { if (t?.id != null) sideById.set(String(t.id), t); };
  for (const m of s.leagueMatches ?? []) { see(m.home); see(m.away); }
  for (const rd of s.rounds ?? []) for (const tie of rd.ties ?? []) for (const leg of tie.legs ?? []) { see(leg.home); see(leg.away); }
  const Y = s.playerLayer;
  const agg = Y?.source === 'match-aggregate';
  const file = sanitize('歐冠 球員榜 ' + s.label);
  renderBoardNote({
    path: '歐冠/球員榜/' + file + '.md',
    fm: { 類型: '球員榜', 賽事: '歐冠', 賽季: s.label, 來源: agg ? 'FotMob 逐場累加' : 'FotMob', 母體: s.leaderPool, 榜數: s.leaders.length, 產生時間: s.retrievedAt },
    title: '歐冠 ' + s.label + ' 球員榜',
    intro: agg
      ? [Y.note, `由本站逐場資料累計(FotMob 逐場詳情,${Y.reconciled}/${Y.matches} 場的球員進球對回 football-data 的比分才計入`
        + `${Y.excluded?.length ? `,${Y.excluded.length} 場對不上不計` : ''};xG 只算射門圖完整的 ${Y.xgComplete} 場)・${s.leaderPool} 人。`]
      : [`來源 FotMob・${s.leaderPool} 人母體・已與另一來源逐場核對比分後才採用。`],
    boards: s.leaders.map(b => ({
      title: b.zh, sub: `母體 ${b.pool} 人`,
      rows: (b.rows ?? []).map(r => ({ cells: links => [r.name ?? '(未知)',
        uclTeamRef(sideById.get(String(r.teamId)) ?? { name: r.team }, links),
        aggregateValue(b, r.value), r.minutes ?? '—', r.matches ?? '—'] })),
    })),
    headers: () => ['球員', '球隊', '數值', '分鐘', '出賽'],
    boundary: [
      'FotMob 給的是**統計榜的母體**,不是全體報名名單 —— 每一張榜都標了母體人數。',
      '列的是產物裡的全部名次。球員只印名字:榜上的 id 是 FotMob 的,而本站英超的球員名冊用 FPL 的 id,只連得到一部分的話,連到的跟連不到的讀者分不出是哪一種。',
      '抓取於 ' + (s.retrievedAt ?? '—'),
    ],
  });
  return file;
}

function buildUcl() {
  const u = load('pl', 'ucl');
  if (!u) return 0;
  uclSource = u.source;
  uclElo = load('pl', 'ucl-elo');
  uclPredById = new Map((uclElo?.fixtures ?? []).map(f => [f.id, f.p]));
  uclDetails = load('pl', 'ucl-details');
  /* 認不得的球隊的隊徽在 ucl-teams.json 的 external(FotMob;身分用 matchId 逐場對照,不比隊名)。
     站上一直有,vault 原本只寫一句「隊徽有」卻沒放圖 —— 現在落成圖檔嵌進球隊筆記。 */
  const uclTeams = load('pl', 'ucl-teams');
  const extCrest = new Map((uclTeams?.external ?? []).map(e => [e.id, e.crest]));

  /* 先走一遍收集認不得的球隊與他們的比賽,筆記檔名要在產生比賽之前就決定好 ——
     比賽筆記裡的 [[連結]] 需要它。 */
  const idPath = join(ROOT, 'data', 'manual', 'ucl-team-ids.json');
  const known = existsSync(idPath)
    ? new Map((read(idPath).teams ?? []).map(t => [t.fdId, t]))
    : new Map();
  const unmapped = existsSync(idPath) ? (read(idPath).unmapped ?? []) : [];
  const externals = new Map();   // fdId → { name, seasons:Set, matches:[] }
  for (const s of u.seasons) {
    const see = t => {
      if (!t || t.id == null || t.code) return;   // 有隊碼的走聯賽筆記
      if (!externals.has(t.id)) externals.set(t.id, { id: t.id, name: t.name ?? t.fullName, seasons: new Set(), matches: [] });
      externals.get(t.id).seasons.add(s.label);
    };
    for (const m of s.leagueMatches ?? []) { see(m.home); see(m.away); }
    for (const rd of s.rounds ?? []) for (const tie of rd.ties ?? []) for (const leg of tie.legs ?? []) { see(leg.home); see(leg.away); }
    for (const r of s.table?.rows ?? []) see(r);
  }
  /* 歐冠的「本站認不得的球隊」筆記,檔名也可能撞上聯賽那一邊 ——
     加德甲時實際撞了:RB Leipzig 在歐冠是外部球隊(那一層的身分來自 football-data,
     還沒接德甲的隊碼),而德甲名冊現在有它 → `德甲/球隊/RB Leipzig.md` 與
     `歐冠/球隊/RB Leipzig.md` 同名,Obsidian 的 [[連結]] 會指到其中一個而不報錯。
     聯賽那一邊先用掉名字(它有完整的球隊頁),歐冠這一邊加後綴。
     **這是暫時的**:等德甲的隊徽交付、把它加進 `loadUclSeasons` 的身分來源之後,
     這些球隊就不再是「外部」,這裡自然不會再撞。 */
  const leagueFiles = new Set(teamFileByCode.values());
  for (const e of externals.values()) {
    const base = sanitize(e.name);
    uclExternalFile.set(e.id, leagueFiles.has(base) ? base + '(歐冠)' : base);
  }
  uclExternalCount = externals.size;

  /* 這些球隊在站上原本只有名字、隊徽與比賽清單。但同一份資料裡本來就有
     他們的聯賽階段戰績(runs)與逐隊球員數據(squads,FotMob,交叉核對通過才有)——
     只是以前只算給本站認得的那 8~11 支。一起掛上去。 */
  for (const s2 of u.seasons) {
    for (const r of s2.runs ?? []) {
      const e = externals.get(r.id);
      if (e) (e.runs ??= []).push({ season: s2.label, ...r });
    }
    const sq = s2.squads?.teams ?? {};
    for (const [fdId, list] of Object.entries(sq)) {
      const e = externals.get(Number(fdId));
      if (e) (e.squads ??= []).push({ season: s2.label, meta: s2.squads.statMeta ?? {}, players: list });
    }
  }
  const D = '歐冠';
  let count = 0;
  const mocLinks = [];
  const mocBody = [];
  mocBody.push(frontmatter({ 類型: '賽事', 名稱: '歐冠', 來源: u.source, 產生時間: u.retrievedAt }));
  mocBody.push('\n# 歐冠\n\n' + (u.competition?.zh ?? 'UEFA Champions League') + '\n');

  for (const s of u.seasons) {
    const sf = sanitize('歐冠 ' + s.label);
    mocLinks.push(sf);
    mocBody.push('\n- ' + wl(sf) + ' —— ' + (s.availability === 'available' ? s.played + ' / ' + s.total + ' 場'
      : s.availability === 'draw-only' ? '只有抽籤結果' : s.availability) + '\n');

    const links = [];
    const body = [];
    body.push(frontmatter({
      類型: '賽季', 賽事: '歐冠', 賽季: s.label, 資料狀態: s.availability,
      場次: s.total, 已完賽: s.played, 隊數: s.teams,
      本站認得的隊數: s.teamsKnown, 單一來源: s.singleSource || null,
      來源: s.source, 產生時間: s.retrievedAt,
    }));
    body.push('\n# 歐冠 ' + s.label + '\n');
    if (s.message) body.push('\n> ' + s.message + '\n');
    const dc = uclDetails?.seasons?.[s.label];
    if (dc) body.push('\n賽後報告 ' + dc.reports + ' / ' + dc.played + ' 場(FotMob 逐場詳情,併在各場的比賽筆記裡)\n');

    if (s.champion?.team) {
      body.push('\n## 冠軍\n\n**' + uclTeamRef(s.champion.team, links) + '**');
      if (s.champion.runnerUp) body.push(' —— 亞軍 ' + uclTeamRef(s.champion.runnerUp, links));
      if (s.champion.match) body.push('\n\n決賽比分:' + uclScoreLine(s.champion.match));
      body.push('\n');
    }

    if (s.table?.rows?.length) {
      body.push('\n## 聯賽階段名次\n\n');
      if (s.bands?.auto && s.bands?.playoff && s.bands?.out) {
        body.push('> 1-' + s.bands.auto.to + ' 直接晉級十六強・'
          + s.bands.playoff.from + '-' + s.bands.playoff.to + ' 附加賽・'
          + s.bands.out.from + '-' + s.bands.out.to + ' 淘汰。'
          + '**名次用官方那一份** —— UEFA 的同分比較有七層,本站只排得到前兩層。\n\n');
      } else {
        body.push('> 尚未從實際淘汰賽參賽名單確認晉級區間，目前不預先判定各隊結局。\n\n');
      }
      body.push('| # | 球隊 | 場次 | 勝 | 和 | 負 | 進 | 失 | 積分 |\n|---|---|---|---|---|---|---|---|---|\n');
      for (const r of s.table.rows) {
        body.push('| ' + r.position + ' | ' + uclTeamRef(r, links) + ' | ' + r.p + ' | ' + r.w
          + ' | ' + r.d + ' | ' + r.l + ' | ' + r.gf + ' | ' + r.ga + ' | ' + r.pts + ' |\n');
      }
    }

    const boardFile = buildUclBoards(s);
    if (boardFile) { boardCount.ucl++; links.push(boardFile); body.push('\n## 球員榜\n\n' + wl(boardFile) + '(' + s.leaders.length + ' 張榜・母體 ' + s.leaderPool + ' 人)\n'); }

    // 聯賽階段的每一場
    for (const m of s.leagueMatches ?? []) {
      const file = sanitize('歐冠 ' + s.label + ' MD' + String(m.matchday ?? 0).padStart(2, '0')
        + ' ' + (m.home?.name ?? '?') + '-' + (m.away?.name ?? '?'));
      links.push(file);
      const r = renderUclMatch(m, s, '聯賽階段');
      addNote(D + '/比賽/' + file + '.md', r.body, r.links);
      for (const side of [m.home, m.away]) {
        if (side && externals.has(side.id)) externals.get(side.id).matches.push({ file, season: s.label, stage: '聯賽階段', m });
      }
      count++;
    }
    // 淘汰賽:每一回合是一則
    for (const rd of s.rounds ?? []) {
      for (const tie of rd.ties ?? []) {
        for (const [i, leg] of (tie.legs ?? []).entries()) {
          const file = sanitize('歐冠 ' + s.label + ' ' + (rd.zh ?? rd.stage)
            + ' ' + (leg.home?.name ?? '?') + '-' + (leg.away?.name ?? '?')
            + ((tie.legs.length > 1) ? ' 第' + (i + 1) + '回合' : ''));
          links.push(file);
          const r = renderUclMatch(leg, s, rd.zh ?? rd.stage, tie);
          addNote(D + '/比賽/' + file + '.md', r.body, r.links);
          for (const side of [leg.home, leg.away]) {
            if (side && externals.has(side.id)) externals.get(side.id).matches.push({ file, season: s.label, stage: rd.zh ?? rd.stage, m: leg });
          }
          count++;
        }
      }
    }

    if (s.draw?.length || s.availability === 'draw-only') {
      body.push('\n## 抽籤結果\n\n');
      body.push('> 這一季只有抽籤結果:上游 144 場的開球時間全是同一個佔位值、輪次全是 null,\n'
        + '> 所以**不顯示開球時間與輪次**,也不猜(鐵則一)。\n');
    }

    body.push('\n## 資料界線\n\n');
    if (s.singleSource) body.push('- **這一季只有一個來源**,沒得交叉核對。結構自洽的條件過了才顯示。\n');
    body.push('- 本站認得 ' + (s.teamsKnown ?? 0) + ' / ' + (s.teamsTotal ?? s.teams ?? 0)
      + ' 支球隊 —— 其餘只給名字,不掛隊徽也不給連結\n');
    body.push('- ' + uclPredLine(s) + '\n');
    body.push('- 來源:' + (s.source ?? u.source) + '・抓取於 ' + (s.retrievedAt ?? u.retrievedAt) + '\n');
    addNote(D + '/賽季/' + sf + '.md', body.join(''), links);
    count++;
  }

  /* 認不得的球隊各一則筆記。內容是「他們在歐冠踢過的每一場」——
     那是真的有東西,不是為了讓連結有地方去而開的空殼(鐵則三)。 */
  const noCrest = new Set(unmapped.map(x => x.fdId));
  for (const e of [...externals.values()].sort((a, b) => a.id - b.id)) {
    const eLinks = [];
    const b = [];
    b.push(frontmatter({
      類型: '球隊', 賽事: '歐冠', 名稱: e.name,
      來源球隊id: e.id, 出現賽季: [...e.seasons].sort(),
      場次: e.matches.length, 產生時間: u.retrievedAt,
    }));
    b.push('\n# ' + e.name + '\n');
    /* 原本寫「那些只收目前在英超與西甲的球隊」—— 加了四個聯賽之後沒有人回來改。聯賽清單從 LEAGUES 讀 */
    const crestUri = extCrest.get(e.id);
    const cd = dataUriBuf(crestUri);
    if (cd) {
      const cf = `隊徽 ucl-${e.id}.${cd.ext}`;
      addAsset(`_資產/隊徽/${cf}`, cd.buf);
      b.push('\n![[' + cf + '|72]]\n');
    }
    b.push('\n> **本站沒有這支球隊的聯賽資料。** 這一則只有歐冠範圍內的東西 ——\n'
      + '> 戰績、歐冠出賽的球員與逐場比賽。他們在自己聯賽的成績、完整名冊、\n'
      + '> 傷停與教練本站都沒有(本站只收' + LEAGUES.map(l => l.zh).join('、') + '的球隊)。\n');
    if (e.runs?.length) {
      b.push('\n## 歐冠戰績\n\n');
      b.push('| 賽季 | 走到哪一輪 | 聯賽階段名次 | 勝 | 和 | 負 | 進 | 失 | 淘汰賽 | 出局於 |\n');
      b.push('|---|---|---|---|---|---|---|---|---|---|\n');
      for (const r of e.runs.slice().sort((a, b2) => b2.season.localeCompare(a.season))) {
        b.push('| ' + r.season + ' | ' + (r.best ?? '—') + ' | '
          + (r.leaguePos ? '第 ' + r.leaguePos + ' 名' : '—') + ' | '
          + r.lw + ' | ' + r.ld + ' | ' + r.ll + ' | ' + r.lgf + ' | ' + r.lga + ' | '
          + (r.koPlayed ? r.koPlayed + ' 場 ' + r.koWon + ' 勝' : '—') + ' | '
          + (r.out ? r.out + (r.outTo ? ' 輸給 ' + r.outTo : '') : r.champion ? '奪冠' : '—') + ' |\n');
      }
      b.push('\n> 淘汰賽的「勝」含 PK 大戰勝出 —— 盃賽的晉級就是這樣算的。\n');
    }

    if (e.squads?.length) {
      for (const sq of e.squads.slice().sort((a, b2) => b2.season.localeCompare(a.season))) {
        b.push('\n## ' + sq.season + " 歐冠出賽的球員(" + sq.players.length + ' 人)\n\n');
        /* **欄位名與單位都照上游宣告的。** 這裡差點出錯:total_scoring_att 是
           「每 90 分鐘射門」不是總射門數,標成總數就是編數字。所以標題直接印
           上游 playerStatCategories 給的 title,不自己取名。 */
        /* 中文欄名要**把單位寫進去**。上游的 title 是排行榜標題
           (goals 的 title 是 "Top scorer"),拿來當欄位名讀起來是錯的;
           但單位不能丟 —— total_scoring_att 是「每 90 分鐘」不是總數。
           所以自己下標題、單位寫在標題裡,並在表格下面附上對回來源欄位的說明。 */
        /* 累計版(本季,沒有交付檔)的鍵不同:射門是總數(shots_total),評分是逐場平均 —— 標題照 meta 的宣告區分 */
        const LABEL = {
          goals: '進球', goal_assist: '助攻', rating: sq.meta.rating && /average/.test(sq.meta.rating) ? 'FotMob 評分(逐場平均)' : 'FotMob 評分',
          expected_goals: 'xG', total_att_assist: '創造機會',
          total_scoring_att: '射門(每 90 分)', shots_total: '射門(總數)', yellow_card: '黃牌',
        };
        const cols = Object.keys(LABEL).filter(k => sq.meta[k]);
        b.push('| 球員 | 出賽 | 分鐘 | ' + cols.map(k => LABEL[k]).join(' | ') + ' |\n');
        b.push('|---|---|---|' + cols.map(() => '---').join('|') + '|\n');
        for (const pl of sq.players) {
          b.push('| ' + pl.name + ' | ' + (pl.matches ?? '—') + ' | ' + pl.minutes + ' | '
            + cols.map(k => (pl.stats[k] ?? '—')).join(' | ') + ' |\n');
        }
        b.push('\n> 數值原封不動來自 FotMob,本站沒有重算任何一格。\n');
        b.push('> 欄位對照(右邊是來源自己宣告的欄位與名稱):\n');
        for (const k of cols) b.push('> ' + LABEL[k] + ' ← ' + k + '「' + sq.meta[k] + '」\n');
        b.push('>\n> **注意單位**:射門那一欄來源宣告的是「Shots per 90」,\n'
          + '> 是每 90 分鐘的平均,不是整季總射門數。\n');
      }
    }

    if (e.matches.length) {
      b.push('\n## 歐冠比賽(' + e.matches.length + ' 場)\n\n');
      const bySeason = new Map();
      for (const x of e.matches) {
        if (!bySeason.has(x.season)) bySeason.set(x.season, []);
        bySeason.get(x.season).push(x);
      }
      for (const [season, list] of [...bySeason].sort((a, b2) => b2[0].localeCompare(a[0]))) {
        b.push('**' + season + '**\n\n');
        for (const x of list) {
          eLinks.push(x.file);
          const opp = x.m.home?.id === e.id ? x.m.away : x.m.home;
          const ha = x.m.home?.id === e.id ? '主' : '客';
          b.push('- ' + x.stage + ' ' + ha + ' vs ' + (opp?.name ?? '?') + ' ' + uclScoreLine(x.m) + ' → ' + wl(x.file) + '\n');
        }
        b.push('\n');
      }
    }
    b.push('\n## 資料界線\n\n');
    /* 「隊徽有(人工交付)」是舊的說法:2026-09-22 起身分改用 FotMob matchId 逐場對照、隊徽每次部署自動補。
       (產物的 externalNote 是寫給網站的 ——「有隊徽不等於有球隊頁,所以不給連結」在 vault 裡是反的,這裡有筆記。)
       對照不到的才講「沒有」,
       而且講清楚是**比對方式**找不到,不是上游沒有(Paphos 那條坑)。 */
    b.push(cd
      ? '- 隊徽:FotMob(球隊身分用同一場比賽的 matchId 主對主、客對客對照,不比隊名 —— `data/manual/ucl-team-ids.json`)\n'
      : noCrest.has(e.id)
        ? '- **沒有隊徽**:本站的對照表對不上這一支(比對方式找不到,不代表上游沒有),而本站不從別處找來源不明的圖補\n'
        : '- **沒有隊徽**:這一次建置的產物裡沒有這一支的圖\n');
    b.push('- 來源:' + u.source + '(賽果)\n');
    /* 檔名走 uclExternalFile —— 撞到聯賽那一邊時它已經加了後綴。
       這裡自己再算一次 sanitize(e.name) 的話,連結指到 A、檔案寫成 B,
       而守門只會說「連結指不到任何筆記」,不會說是誰算錯的。 */
    addNote(D + '/球隊/' + uclExternalFile.get(e.id) + '.md', b.join(''), eLinks);
    mocLinks.push(uclExternalFile.get(e.id));
    count++;
  }

  mocBody.push('\n## 本站沒有聯賽資料的球隊(' + externals.size + ' 支)\n\n');
  mocBody.push([...externals.values()].sort((a, b) => a.id - b.id)
    .map(e => wl(uclExternalFile.get(e.id))).join(' · ') + '\n');

  mocBody.push('\n## 資料界線\n\n- 來源:' + u.source + '\n');
  mocBody.push('- ' + uclPredLine(u.seasons.find(x => x.current) ?? null) + '\n');
  addNote(D + '/歐冠.md', mocBody.join(''), mocLinks);
  return count + 1;
}

/* 歐冠有沒有勝率,一句話。**從產物讀,不寫死** —— 這裡原本三處寫死「不做勝率預測」,
   階段 C(2026-09-09)之後站上有上百場賽前勝率,vault 還在否認。 */
function uclPredLine(s) {
  const md = uclElo?.model;
  if (!s?.current) return '這一季已經踢完。本站沒有保存歐冠的賽前機率快照,所以已完賽的場次不放勝率';
  if (!md) return '**沒有勝率預測**:這一次建置沒有跨聯賽評分的產物';
  if (!md.passes) return `**沒有勝率預測**:跨聯賽評分的走查回測這一次沒有通過門檻(${md.n} 場,改善 ${md.improvement} ± ${md.se}),所以一場都不給(鐵則二)`;
  const unrated = uclElo.coverage?.unrated ?? [];
  return `未賽、而且兩隊都有跨聯賽評分的場次有**賽前勝率**(本季 ${uclPredById.size} 場`
    + (unrated.length ? `;沒有評分、所以那些場次不給的球隊:${unrated.map(x => x.name).join('、')}` : '') + ')。'
    + (uclElo.note ?? '') + `走查回測 ${md.n} 場:RPS ${md.rps}、基準線 ${md.baseline},改善 ${md.improvement} ± ${md.se}。`
    + '兩回合制、延長賽與 PK 大戰模型沒見過;已完賽的場次不放勝率(本站沒有保存賽前的機率快照)';
}

function renderUclMatch(m, s, stageZh, tie) {
  const links = [];
  const body = [];
  const H = m.home?.name ?? '?', A = m.away?.name ?? '?';
  /* 只有未賽的場次才可能有;產物裡已完賽的本來就沒有,這裡再擋一次是因為「賽後重算冒充賽前」是鐵則 */
  const pred = !m.played ? uclPredById.get(m.id) ?? null : null;
  const idx = m.played ? uclDetails?.reports?.[String(m.id)] ?? null : null;
  const rep = idx ? loadDetail(`ucl-details/${idx.season}/${m.id}`) : null;
  const xg = rep && idx?.xG && idx.shotmapComplete !== false ? idx.xG : null;
  body.push(frontmatter({
    /* 淘汰賽的 matchday 是**首 / 次回合**(1 / 2),不是輪次 —— 寫成「輪次: 2」會讓十六強次回合看起來像第 2 輪
       (CLAUDE.md「『這一輪』在淘汰賽裡不是一個數字」)。回合標記只認 1 與 2,其他不標 */
    類型: '比賽', 賽事: '歐冠', 賽季: s.label, 階段: stageZh,
    輪次: stageZh === '聯賽階段' ? m.matchday ?? null : null,
    回合: stageZh !== '聯賽階段' && (m.matchday === 1 || m.matchday === 2) ? m.matchday : null,
    開球: m.kickoff, 主隊: H, 客隊: A,
    已完賽: m.played, 延長賽: m.aet || null,
    主勝率: pred?.[0], 和局率: pred?.[1], 客勝率: pred?.[2],
    /* 比賽 id 放進 frontmatter:Dataview 查得到,測試也靠它把筆記跟逐場檔對起來(檔名是隊名拼的) */
    footballData比賽id: m.id != null ? String(m.id) : null,
    賽後報告: rep ? true : null, 主隊xG: xg?.[0], 客隊xG: xg?.[1],
    產生時間: s.retrievedAt,
  }));
  body.push('\n# 歐冠 ' + s.label + ' ' + stageZh + ' ' + H + ' vs ' + A + '\n');
  body.push('\n' + uclTeamRef(m.home, links) + ' vs ' + uclTeamRef(m.away, links) + '\n');
  if (m.played) {
    body.push('\n## 比分\n\n**' + uclScoreLine(m) + '**\n');
    if (m.halfTime) body.push('\n半場 ' + m.halfTime[0] + ':' + m.halfTime[1] + '\n');
    if (m.pens) {
      body.push('\n> PK 決勝。上面的比分是**正規時間加延長賽**的結果,PK 另計 ——\n'
        + '> 上游原始的 fullTime 是 regularTime + extraTime + penalties 的累加值,\n'
        + '> 直接印會把冠軍講錯(2025-26 決賽會變成 PSG 5-4 Arsenal)。\n');
    }
    if (scoreInconsistent(m)) {
      body.push('\n> **上游的分段欄位加不回總比分**(90 分鐘 + 延長賽 ≠ 總分),\n'
        + '> 所以只顯示總比分,不拆分段。\n');
    }
  }
  /* 只有真的打兩回合才有「總比分」。決賽是單場,印 aggregate 會讓人以為打了兩場。 */
  if (tie?.aggregate && (tie.legs?.length ?? 1) > 1) {
    body.push('\n## 兩回合總比分\n\n' + tie.aggregate[0] + ' : ' + tie.aggregate[1] + '\n');
  }
  if (rep) {
    reportCount.ucl++;
    body.push(renderDetailReport(rep, { caveats: [
      '賽後資料來自 FotMob 的逐場詳情(球隊統計、事件、正式名單、逐人評分、逐射門 xG),比分已跟 football-data.org 的賽果核對。',
      `xG 是${uclDetails?.xgNote ?? '逐射門 xG 加總'}${rep.shotmapComplete === false ? ' —— **這一場射門圖不完整,所以沒有 xG**' : ''}。`,
      '控球率是供應商的數字,歐冠沒有第二來源可抽核。',
    ] }));
  } else if (m.played) {
    /* 索引有、逐場檔讀不到是**產物不完整**(重跑 build),跟「還沒抓到」是兩件事 —— 前者不會自己好 */
    body.push('\n## 賽後報告\n\n這一場沒有賽後報告 —— '
      + (idx ? '產物的索引有這一場,但逐場檔讀不到(產物不完整,要重跑 build)' : '逐場詳情還沒抓到(每次部署會補,一場一個請求)') + '。\n');
  }
  if (pred) {
    const md = uclElo.model;
    body.push('\n## 賽前勝率(跨聯賽 Elo)\n\n| 主勝 | 和 | 客勝 |\n|---|---|---|\n'
      + '| ' + pred.map(x => (x * 100).toFixed(1) + '%').join(' | ') + ' |\n');
    body.push('\n> ' + (uclElo.note ?? '') + '\n'
      + `> 走查回測 ${md.n} 場:RPS ${md.rps}、基準線 ${md.baseline},改善 ${md.improvement} ± ${md.se}。`
      + '**樣本只有兩季多**,而且能回測的都是兩隊都有評分的場次 —— 比整體偏向大聯賽的對戰。\n'
      + '> 勝率僅供分析參考,不構成投注建議。\n');
  }
  body.push('\n## 資料界線\n\n- 來源:' + (s.source ?? uclSource ?? 'football-data.org') + '\n');
  /* 沒有勝率的理由分開講:已完賽(沒有賽前快照)、回測沒過(整批不給)、有一隊沒有評分 —— 三件事不混成一句 */
  const rated = t => t?.id != null && uclElo?.ratings?.[String(t.id)] != null;
  body.push('- ' + (m.played ? '已完賽:本站沒有保存歐冠的賽前機率快照,所以不放勝率'
    : pred ? '勝率來自跨聯賽 Elo(見上);兩回合制、延長賽與 PK 大戰模型沒見過'
      : !uclElo?.model?.passes ? '沒有勝率:跨聯賽評分的走查回測這一次沒有通過門檻,整批不給(鐵則二)'
        : !rated(m.home) || !rated(m.away) ? '沒有勝率:至少一隊沒有跨聯賽評分(它的聯賽本站不收賽果),不拿聯賽模型硬套'
          : '沒有勝率:這一場不在跨聯賽模型的預測清單裡') + '\n');
  return { body: body.join(''), links };
}


/* ── 英格蘭盃賽 ───────────────────────────────────────────
   足總盃從資格賽打起,所以對手大半是本站不認得的低階球隊
   (足總盃 2026-27 有 579 隊)。做法跟歐冠一樣:認得的連回球隊筆記,
   不認得的印名字加聯賽層級,不為了版面對齊造空殼筆記。

   對手的層級來自 data/manual/team-tiers.json,而且**逐季查** ——
   球隊每年升降級,拿某一季的層級講另一季會標錯。 */
function cupTeamRef(t, links) {
  if (!t) return '(未知)';
  const file = t.code ? teamFileByCode.get('pl:' + t.code) : null;
  const tier = t.tier ? '(' + t.tier + ')' : '';
  if (file) { links.push(file); return wl(file) + tier; }
  return (t.name ?? '(未知)') + tier;
}

const cupScoreLine = m => scoreParts(m) ?? '未賽';

let cupsMerged = 0;
/* 盃賽賽後報告的索引(cup-details.json:FotMob 的比賽 id → 盃賽、賽季、xG…;還有拒收與缺漏的理由) */
let cupDetails = null;
/* 盃賽的球員榜(一季一則)。說明照站上 page-cups.js 的 cupLeaderBoards,三件事都要講:
   涵蓋率(低分級的場次供應商常常沒有逐人統計)、比分核對是同一家供應商的一致性檢查、評分榜的門檻 */
function buildCupBoards(cup, s, P) {
  const file = sanitize(cup.zh + ' 球員榜 ' + s.label);
  const cover = P.withPlayers === P.matches
    ? `${P.matches} 場全部有逐人統計`
    : `${P.matches} 場裡 **${P.withPlayers} 場**有逐人統計(缺的 ${P.noPlayerData} 場是供應商沒給,多半是低分級球隊互打)`;
  renderBoardNote({
    path: '英格蘭盃賽/球員榜/' + file + '.md',
    fm: { 類型: '球員榜', 賽事: cup.zh, 賽季: s.label, 來源: 'FotMob 逐場累加', 母體: P.pool, 榜數: P.boards.length, 產生時間: cupDetails?.retrievedAt ?? null },
    title: cup.zh + ' ' + s.label + ' 球員榜',
    intro: [`由逐場詳情的逐人統計累加・${P.pool} 人。**這幾張榜涵蓋哪些比賽**:${cover};其中 **${P.reconciled} 場**的球員進球對得回比分才計入`
      + `${P.mismatched?.length ? `,${P.mismatched.length} 場對不上整場不計` : ''}。xG 只加射門圖完整的 ${P.xgComplete} 場。`],
    boards: P.boards.map(b => ({
      title: b.zh, sub: `母體 ${b.pool} 人`,
      rows: (b.rows ?? []).map(r => ({ cells: links => [r.name ?? '(未知)',
        cupTeamRef(P.teams?.[r.teamId] ?? { name: r.team }, links),
        aggregateValue(b, r.value), r.minutes ?? '—', r.matches ?? '—'] })),
    })),
    headers: () => ['球員', '球隊', '數值', '分鐘', '出賽'],
    boundary: [
      '比分核對用的是**同一家供應商**(盃賽的賽果本身就是 FotMob)—— 它擋得住抓錯場次,擋不住供應商自己記錯,跟聯賽那種兩個獨立來源的核對不是同一回事。互射十二碼不算進球。',
      `評分榜要出賽 ≥ ${P.ratingMin} 場才列:淘汰制底下大部分人只踢一兩場,門檻低會讓踢兩場的人排在整個賽事第一。`,
      P.cardsUnmatched ? `另有 ${P.cardsUnmatched} 筆牌事件接不到球員 —— 那是總教練吃牌。` : null,
      '列的是產物裡的全部名次。球員只印名字:榜上的 id 是 FotMob 的,而本站英超的球員名冊用 FPL 的 id,只連得到一部分的話,連到的跟連不到的讀者分不出是哪一種。',
      '抓取於 ' + (cupDetails?.retrievedAt ?? '—'),
    ],
  });
  return file;
}

function buildCups() {
  const c = load('pl', 'cups');
  if (!c) return 0;
  cupDetails = load('pl', 'cup-details');
  const D = '英格蘭盃賽';
  let count = 0;
  for (const cup of c.cups) {
    const links = [];
    const body = [];
    body.push(frontmatter({
      類型: '賽事', 名稱: cup.zh, 英文名: cup.en, 來源: c.source, 產生時間: cup.retrievedAt,
    }));
    body.push('\n# ' + cup.zh + '\n\n' + (cup.en ?? '') + '\n');

    for (const s of cup.seasons) {
      let seasonMatches = 0;
      body.push('\n## ' + s.label + '\n\n');
      const bits = [];
      if (s.total != null) bits.push(s.played + ' / ' + s.total + ' 場');
      if (s.teamsTotal) bits.push(s.teamsTotal + ' 隊');
      if (s.rounds?.length) bits.push(s.rounds.length + ' 輪');
      /* 賽後報告的涵蓋(產物記的):報告併在各場的比賽筆記裡,這裡講有幾場有 */
      const cov = cupDetails?.cups?.[cup.key]?.seasons?.[s.label];
      if (cov) bits.push('賽後報告 ' + cov.reports + ' / ' + cov.played + ' 場');
      if (bits.length) body.push(bits.join('・') + '\n');
      const P = cupDetails?.players?.[cup.key]?.[s.label];
      if (P?.boards?.length) {
        const bf = buildCupBoards(cup, s, P);
        boardCount.cup++;
        links.push(bf);
        body.push('\n球員榜:' + wl(bf) + '(' + P.boards.length + ' 張榜・' + P.pool + ' 人)\n');
      }
      /* 冠軍的形狀是 { team: { name }, runnerUp, match }(FotMob 那一版);原本讀 `s.champion.name` ——
         改接 FotMob 之後那個欄位就不存在了,於是**冠軍那一行整個不見**,不拋錯(足總盃 2025-26 的 Man City)。
         舊的扁平形狀照樣認 */
      const champ = s.champion?.team?.name ?? s.champion?.name;
      if (champ) {
        const cm = s.champion?.match;
        body.push('\n冠軍:**' + champ + '**' + (s.champion?.runnerUp?.name ? '・亞軍 ' + s.champion.runnerUp.name : '')
          + (cm && scoreParts(cm) ? '・決賽 ' + (cm.home?.name ?? '?') + ' ' + scoreParts(cm) + ' ' + (cm.away?.name ?? '?') : '') + '\n');
      }

      /* 上游會把同一場掛在兩個階段。實測 1,573 場裡只有一組
         (足總盃 2026-27 Aylesbury United vs Flackwell Heath,
         "Extra Preliminary Round" 與 "…Replays" 各一筆),
         而且 id 以外每個欄位都一樣 —— 首戰 2-3 有勝負,不可能有重賽。
         照兩則產生的話,一場比賽在 vault 裡會變成兩場。

         所以只合併「開球時間、比分、完賽狀態全部相同」的那種;
         真正的重賽日期不同,key 本來就不會撞。合併掉的事實寫在筆記上,不靜靜吃掉。 */
      const dupKey = m => [(m.kickoff ?? '').slice(0, 10), m.home?.name, m.away?.name].join('|');
      const groups = new Map();
      for (const rd of s.rounds ?? []) for (const m of rd.matches) {
        const k = dupKey(m);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push({ m, stage: rd.stage });
      }
      const mergedOf = new Map();   // 保留的那一筆 → 被合併掉的階段名
      for (const [k, list] of groups) {
        if (list.length < 2) continue;
        const same = list.every(x => x.m.kickoff === list[0].m.kickoff
          && JSON.stringify(x.m.final) === JSON.stringify(list[0].m.final)
          && x.m.played === list[0].m.played);
        if (!same) continue;   // 內容不同就不合併,留給守門去擋
        mergedOf.set(list[0].m, list.slice(1).map(x => x.stage));
        for (const x of list.slice(1)) x.m.__dropped = true;
        cupsMerged++;
      }

      for (const rd of s.rounds ?? []) {
        const shown = rd.matches.filter(m => !m.__dropped);
        body.push('\n### ' + rd.stage + '(' + shown.length + ' 場)\n\n');
        for (const m of shown) {
          const date = (m.kickoff ?? '').slice(0, 10);
          const file = sanitize(cup.zh + ' ' + s.label + ' ' + date + ' '
            + (m.home?.name ?? '?').slice(0, 26) + '-' + (m.away?.name ?? '?').slice(0, 26));
          links.push(file);
          const r = renderCupMatch(m, cup, s, rd, mergedOf.get(m), c.source);
          addNote(D + '/比賽/' + file + '.md', r.body, r.links);
          count++; seasonMatches++;
          body.push('- ' + date + ' ' + (m.home?.name ?? '?') + ' ' + cupScoreLine(m)
            + ' ' + (m.away?.name ?? '?') + ' → ' + wl(file) + '\n');
        }
      }
      if (s.nearMisses?.length) {
        /* 這份清單不是裝飾 —— 「盃賽寬鬆比對會對錯球隊」靠它抓到過兩次。 */
        body.push('\n> **隊名比對的近似項(' + s.nearMisses.length + ' 筆)**:'
          + '寬鬆比對可能對錯球隊,這份清單是給人看的,不是自動採用的。\n');
      }
      body.push('\n(' + s.label + ' 共產生 ' + seasonMatches + ' 則比賽筆記)\n');
    }

    body.push('\n## 資料界線\n\n');
    body.push('- 來源:' + c.source + '\n');
    /* missingSeasons 是 { label, reason } —— 直接 join 就是「[object Object]」(不拋錯,test-vault 掃到的) */
    if (cup.missingSeasons?.length) {
      body.push('- 拿不到的賽季:' + cup.missingSeasons.map(x => (x?.label ?? x) + (x?.reason ? ':' + x.reason : '')).join('、') + '\n');
    }
    body.push('- 對手的聯賽層級**逐季查**(球隊每年升降級),認不出來的就不標\n');
    body.push('- **隊名正規化只去字尾的 FC/AFC** —— 字首的 AFC 是球隊身分的一部分,\n');
    body.push('  去掉的話第九級的 AFC Liverpool 會被對成英超的 Liverpool(踩過兩次)\n');
    addNote(D + '/' + sanitize(cup.zh) + '.md', body.join(''), links);
    count++;
  }
  return count;
}

function renderCupMatch(m, cup, s, rd, mergedStages, source) {
  const links = [];
  const body = [];
  const H = m.home?.name ?? '?', A = m.away?.name ?? '?';
  const idx = m.played ? cupDetails?.reports?.[String(m.id)] ?? null : null;
  const rep = idx ? loadDetail(`cup-details/${idx.cup}/${idx.season}/${m.id}`) : null;
  const xg = rep && idx?.xG && idx.shotmapComplete !== false ? idx.xG : null;
  body.push(frontmatter({
    類型: '比賽', 賽事: cup.zh, 賽季: s.label, 階段: rd.stage,
    回合: m.leg, 開球: m.kickoff, 主隊: H, 客隊: A, 已完賽: m.played,
    延長賽: m.aet || null, PK: m.pens ? true : null,
    主隊層級: m.home?.tier, 客隊層級: m.away?.tier,
    /* 比賽 id 放進 frontmatter:Dataview 查得到,測試也靠它把筆記跟逐場檔對起來(檔名是隊名拼的) */
    FotMob比賽id: m.id != null ? String(m.id) : null,
    賽後報告: rep ? true : null, 主隊xG: xg?.[0], 客隊xG: xg?.[1],
    產生時間: s.retrievedAt ?? cup.retrievedAt,
  }));
  body.push('\n# ' + cup.zh + ' ' + s.label + ' ' + rd.stage + ' ' + H + ' vs ' + A + '\n');
  body.push('\n' + cupTeamRef(m.home, links) + ' vs ' + cupTeamRef(m.away, links) + '\n');
  if (m.played) {
    body.push('\n## 比分\n\n**' + cupScoreLine(m) + '**\n');
    if (m.ht) body.push('\n半場 ' + m.ht[0] + ':' + m.ht[1] + '\n');
    if (m.resultInfo) body.push('\n' + m.resultInfo + '\n');
    if (scoreInconsistent(m)) {
      body.push('\n> **上游的分段欄位加不回總比分**(90 分鐘 ' + m.ft90.join(':')
        + ' + 延長賽 ' + (m.et ?? [0, 0]).join(':') + ' ≠ ' + m.final.join(':') + ')。\n'
        + '> 兩邊對不起來時本站不挑一個當答案,只顯示總比分並把這件事寫出來。\n');
    }
  }
  if (rep) {
    reportCount.cup++;
    const sc = cupDetails?.scoreCheck;
    body.push(renderDetailReport(rep, { caveats: [
      '賽後資料來自 FotMob 的逐場詳情(球隊統計、事件、正式名單、逐人評分、逐射門 xG)。',
      `xG 是${cupDetails?.xgNote ?? '逐射門 xG 加總'}${rep.shotmapComplete === false ? ' —— **這一場射門圖不完整,所以沒有 xG**' : ''}。`,
      sc?.independent === false ? `**比分核對不是獨立來源**:${sc.note ?? ''}` : '比分已跟獨立來源核對。',
    ] }));
  } else if (m.played) {
    /* 沒有報告要講得出為什麼,分得出三種(站上 page-cup-match 同一套):供應商缺資料、本站拒收、還沒抓到。
       「還沒抓到」會再來,「上游沒有」不會 —— 對讀者的意思完全不同 */
    const inc = (cupDetails?.incomplete ?? []).find(x => String(x.id) === String(m.id));
    const rej = (cupDetails?.rejected ?? []).find(x => String(x.key ?? '').endsWith(`|${m.id}`));
    body.push('\n## 賽後報告\n\n這一場沒有賽後報告 —— '
      + (idx ? '產物的索引有這一場,但逐場檔讀不到(產物不完整,要重跑 build)'
        : inc ? `供應商這一場缺了必要的資料(${inc.reason || (inc.missing ?? []).join('、')})`
          : rej ? `本站沒有收這一場的詳情:${rej.reason ?? '核對沒過'}`
            : '這一場的逐場詳情還沒抓到(每次部署會補,一場一個請求)') + '。\n');
  }
  body.push('\n## 資料界線\n\n');
  if (mergedStages?.length) {
    body.push('- **上游把這一場掛在兩個階段**(' + rd.stage + '、' + mergedStages.join('、') + '),\n'
      + '  開球時間、比分與完賽狀態完全相同,所以合併成一則 —— 不是兩場比賽\n');
  }
  const unknownTier = [m.home, m.away].filter(x => x && !x.tier).map(x => x.name);
  if (unknownTier.length) {
    body.push('- 認不出聯賽層級:' + unknownTier.join('、')
      + ' —— 對照表只涵蓋英格蘭前幾級,認不出來就不標,不猜\n');
  }
  /* 來源原本寫死「SportMonks」—— 盃賽 2026-09-13 起改接 FotMob(SportMonks 已退訂,舊快取只拿來核對),
     每一則盃賽比賽筆記都印著一個早就不是它來源的名字。來源從產物讀。
     沒有勝率的理由照站上那一句:模型是用聯賽調的,沒在國內盃賽上驗收過(對手一半是低級別球隊,本站沒有它們的賽果)。 */
  body.push('- 來源:' + (source ?? '見賽事筆記') + '\n');
  body.push('- 沒有勝率預測:模型是用聯賽調的,沒在國內盃賽上驗收過 —— 對手有一半是本站沒有賽果的低級別球隊,套上去就是編數字\n');
  return { body: body.join(''), links };
}


/* ── 國家隊 ───────────────────────────────────────────────
   2026-09-26 加的(使用者:「目前最新資料要存進 obsidian 資料庫」)—— 國家隊那一頁 9/24 就上線了,
   vault 一直沒有它。資料是英超目錄那三份產物:`intl.json`(賽程、賽果、分組積分榜、排名、模型的驗收)、
   `intl-teams.json`(逐隊的評分走勢、最近幾場、跟接下來對手的交手)與 `intl-flags.json`(國旗)。

   網站怎麼講,這裡就怎麼講(page-intl.js 的檔頭),四件事跟聯賽不一樣:
   1. **兩個來源分工不重疊。** 場次來自 FotMob(八個賽事);評分與勝率只從 martj42 算。
      每一場已完賽的核對判決照抄 ——「待核對」「獨立來源沒收」「不一致」是三件事,不混成一個問號。
   2. **勝率只給未賽、而且模型通過驗收的場次**,連同「評分之後兩隊又踢了幾場」與中立場的推論一起寫 ——
      推論要標成推論(鐵則四)。已完賽的場次產物本來就不帶勝率,這裡也不補。
   3. **時間一律 UTC。** 網站依讀者的時區分天;筆記是靜態的,沒有讀者的時區可用。
   4. **martj42 的賽事名照原文。** 網站把它翻成中文的那張表在前端(page-intl.js 的 TOUR_ZH),
      這裡再抄一份就是兩份會分岔的複本(「修好一份、忘了另一份複本」)。FotMob 那八個賽事的中文名本來就在產物裡。

   檔名:球隊用產物的中文名(CLDR;撞了守門會擋),比賽用「賽事中文名 日期 主-客」,賽事用它的中文名。 */
const INTL_DIR = '國家隊';
let intlCounts = null;
function buildIntl() {
  const I = load('pl', 'intl');
  if (!I) return 0;
  const T = load('pl', 'intl-teams') ?? {};
  const FL = load('pl', 'intl-flags');
  const asOf = I.model?.ratingsAsOf ?? null;
  const teams = I.teams ?? {};
  const comps = new Map((I.comps ?? []).map(c => [c.key, c]));
  const zhOf = k => teams[k]?.zh ?? k;
  const teamFile = new Map(Object.keys(teams).map(k => [k, sanitize(zhOf(k))]));
  const compZh = key => comps.get(key)?.zh ?? key;
  const compFile = key => sanitize(compZh(key));
  const kick = x => Date.parse(x.kickoff);   // 一律 Date.parse,不比字串(時間字串的字典序那條坑)
  const ref = (k, links) => {
    if (k && teamFile.has(k)) { links.push(teamFile.get(k)); return wl(teamFile.get(k)); }
    return k ? zhOf(k) : '(未知)';
  };
  /* 一邊叫什麼:認得的是球隊,還沒決定的(海灣盃四強的 1A)照產物的說法,對不上身分的照上游的名字 */
  const sideName = t => (t?.key ? zhOf(t.key) : t?.tbd ? (t.label ?? t.name) : t?.name ?? '待定');
  const sideRef = (t, links) => (t?.key ? ref(t.key, links)
    : t?.tbd ? `${t.label ?? t.name}(對戰還沒決定)` : `${t?.name ?? '待定'}(本站對不上這一隊的身分)`);
  const matchFile = x => sanitize(`${compZh(x.comp)} ${String(x.kickoff).slice(0, 10)} ${sideName(x.home)}-${sideName(x.away)}`);
  const utc = iso => (iso ? String(iso).slice(0, 16).replace('T', ' ') + ' UTC' : '');
  const pc = x => (x * 100).toFixed(1) + '%';
  const tagsOf = x => [x.roundZh, x.groupZh].filter(Boolean).join('・');
  const okComps = (I.comps ?? []).filter(c => c.status === 'ok').length;

  /* 國旗:跟站上同一份。屬地用宗主國旗的、中華台北,產物那一層已經排掉了,這裡照單全收 */
  const flagFile = new Map();
  for (const [k, uri] of Object.entries(FL?.flags ?? {})) {
    const d = dataUriBuf(uri);
    if (!d) continue;
    const f = `國旗 ${sanitize(k)}.${d.ext}`;
    addAsset(`_資產/國旗/${f}`, d.buf);
    flagFile.set(k, f);
  }
  /* 為什麼沒有國旗:三種原因分開講(站上 flagNote 同一套)。來源資訊在 intl.json 的 flags,國旗檔本身只有圖 */
  const flagWhyNot = k => {
    const excluded = (I.flags?.excluded ?? []).find(x => x.key === k);
    if (excluded) return `刻意不給:${excluded.why}`;
    const same = (I.flags?.sameAs ?? []).find(x => x.key === k);
    if (same) return `國旗集裡這一面就是${same.asKey ? zhOf(same.asKey) : String(same.as).toUpperCase()}的旗 —— 掛上去會讓人以為是那一國,所以不掛`;
    if ((I.flags?.noCode ?? []).includes(k)) return '沒有國碼(大多是非會員的區域隊)';
    return '這一次建置的國旗檔裡沒有這一隊';
  };

  /* 已完賽的核對判決(照站上 checkBadge 的說法;三種「沒對上」是三件不同的事) */
  const CHECK = {
    agree: () => ['已核對', '✓ 兩個獨立來源(FotMob、martj42)的比分一致'],
    mismatch: r => ['不一致', `⚠ 兩個來源記的比分不一樣:martj42 記 ${(r.other ?? []).join('-')}。本站不挑一個當答案,評分用的是 martj42 那一份`],
    awarded: r => ['判決比分', `FotMob 記的是判決比分,martj42 記的是場上比分(${(r.other ?? []).join('-')})—— 記法不同,不算不一致`],
    notYet: () => ['待核對', `martj42 目前收錄到 ${asOf},這一場它還沒收 —— 無法核對,不等於不一致`],
    unmatched: () => ['獨立來源沒收', '兩隊都認得,但 martj42 前後一天內沒有這兩隊的對戰:它沒收這一場'],
  };
  const checkOf = r => (CHECK[r.check] ?? (() => ['隊名未對上', '有一隊的名字本站還對不上身分,核對不了']))(r);
  /* 評分只從 martj42 算:它收了的(一致、判決、不一致都算收了)才進評分 —— 跟站上球隊頁「還沒進評分的賽果」同一個判準 */
  const inRating = r => r.check === 'agree' || r.check === 'awarded' || r.check === 'mismatch';
  const endText = r => (r.reason === 'AET' ? '(延長賽後)'
    : r.reason === 'Pen' ? (r.pensWinner ? `(PK,${zhOf(r.pensWinner)} 勝)` : '(PK,勝方待查)') : '')
    + (r.awarded ? '(判決比分)' : '');

  /* 中立場的推論,一句話(站上 venueText 的說法)。推論要標成推論 */
  const venueText = f => {
    const v = f.venue;
    if (!v) return '當成名單上的主隊在主場算(上游沒有中立場資訊)';
    const home = zhOf(f.home?.key);
    const why = v.basis === 'host' ? '主隊在這一屆踢過主場,是主辦國'
      : v.basis === 'edition' ? `這一屆已收錄的 ${v.n} 場有 ${v.k} 場在中立場`
        : v.basis === 'prior' ? '這一屆還沒有已收錄的比賽,用這一類賽事的平均'
          : v.basis === 'team' ? (v.n ? `${home}最近 ${v.n} 場同類的主場有 ${v.k} 場在中立場,往這一類賽事的平均收縮`
            : `${home}沒有同類的主場紀錄,用這一類賽事的平均`)
            : `依據:${v.basis}`;
    return `中立場的機率 ${Math.round(v.q * 100)}%(**推論**:${why});勝率照這個機率把「主隊在主場」與「中立場」兩種算法加權`;
  };
  /* 評分落後:martj42 還沒收的比賽不進評分,每一場講兩隊之後又踢了幾場,連同量過的代價 */
  const lagText = f => {
    const lags = (f.lag ?? []).map(n => n ?? 0);
    const lag = Math.max(0, ...lags);
    if (!lag) return null;
    const who = [f.home, f.away].map((t, i) => (lags[i] ? `${sideName(t)} ${lags[i]} 場` : null)).filter(Boolean).join('、');
    const lg = I.model?.lag;
    return `**評分未含最近 ${lag} 場**:評分只算到 ${asOf}(martj42 收錄到的最後一天),之後踢的比賽還沒被核對,不拿來改評分。`
      + `這兩隊之後又踢了:${who}。`
      + (lg?.affected ? `量過這件事值多少:評分落後 ${lg.days} 天,受影響的場次每場 RPS 平均多 ${lg.affected.cost} ± ${lg.affected.se}`
        + `(模型整體的改善是 ${I.model.holdout?.gain})。` : '');
  };
  const probShort = f => (f.prob ? `主勝 ${pc(f.prob[0])}・和 ${pc(f.prob[1])}・客勝 ${pc(f.prob[2])}` : (f.why ?? '不給勝率'));
  const stateOf = f => (f.state === 'CANCELLED' ? (f.reason === 'Ab' ? '中止' : '取消') : f.state === 'LIVE' ? '建置時進行中' : '未賽');
  const fixtureLine = (f, links) => {
    const file = matchFile(f);
    links.push(file);
    const st = stateOf(f);
    return `- ${utc(f.kickoff)} ${tagsOf(f) ? tagsOf(f) + ' ' : ''}${sideRef(f.home, links)} vs ${sideRef(f.away, links)}`
      + (st === '未賽' ? '' : `(${st})`) + ` —— ${f.state === 'CANCELLED' ? (f.why ?? '比賽取消') : probShort(f)} → ${wl(file)}`;
  };
  const resultLine = (r, links) => {
    const file = matchFile(r);
    links.push(file);
    return `- ${utc(r.kickoff)} ${tagsOf(r) ? tagsOf(r) + ' ' : ''}${sideRef(r.home, links)} **${r.final[0]} - ${r.final[1]}** `
      + `${sideRef(r.away, links)}${endText(r)}・${checkOf(r)[0]} → ${wl(file)}`;
  };

  /* 歷來交手(從 a 的角度講)。只當資訊,不進模型 */
  const H2H = T.h2h ?? {};
  const h2hLines = (a, b, links) => {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!(k in H2H)) return null;
    const x = H2H[k];
    if (!x) return [`${zhOf(a)}與${ref(b, links)}沒有交手紀錄(martj42 自 1872 年起的男子 A 級賽)。`];
    const first = k.startsWith(`${a}|`);
    const [w, d, l] = first ? x.w : [x.w[2], x.w[1], x.w[0]];
    const [gf, ga] = first ? x.g : [x.g[1], x.g[0]];
    return [
      `${zhOf(a)}對${ref(b, links)}:交手 ${x.n} 次(自 ${String(x.since).slice(0, 4)} 年),${w} 勝 ${d} 和 ${l} 負,進失球 ${gf}:${ga}。最近 ${x.last.length} 次:`,
      '',
      ...[...x.last].reverse().map(m => `- ${m.d} ${zhOf(m.h)} ${m.s[0]} - ${m.s[1]} ${zhOf(m.a)}${m.n ? '(中立場)' : ''} —— ${m.t}`),
      '',
      '比分含延長、不含 PK(PK 決勝的算和局)。**只當資訊,不進模型** —— 評分本來就含了每一場比賽。',
    ];
  };

  /* 分組積分榜。積分是本站用已完賽的賽果算的,上游的表只拿來取名單、官方名次與核對 */
  const groupTable = (g, links, me = null) => {
    const zoneAt = i => (g.legend ?? []).find(l => (l.idx ?? []).includes(i)) ?? null;
    const lines = ['| 名次 | 國家隊 | 賽 | 勝 | 和 | 負 | 進:失 | 淨 | 分 | 區間 |', '|---|---|---|---|---|---|---|---|---|---|'];
    g.rows.forEach((r, i) => {
      const z = zoneAt(i);
      const nm = r.key ? (r.key === me ? `**${zhOf(r.key)}**` : ref(r.key, links)) : `${r.name}(本站對不上身分)`;
      const mark = r.check === 'pending' && r.up ? `(上游算 ${r.up.p} 場 ${r.up.pts} 分${r.live ? ',含正在踢的那一場' : ''})` : '';
      lines.push(`| ${r.pos} | ${nm}${mark} | ${r.p} | ${r.w} | ${r.d} | ${r.l} | ${r.gf}:${r.ga} | ${r.gd > 0 ? '+' : ''}${r.gd} | ${r.pts} | ${z ? (z.zh ?? z.en) : ''} |`);
    });
    let note = '';
    if (g.status === 'ok') {
      if (!g.counted) note = '還沒開踢:名次是上游列的順序(抽籤的順序)。';
    } else {
      const diffs = g.rows.filter(r => r.check !== 'agree' && r.up)
        .map(r => `${r.key ? zhOf(r.key) : r.name} 本站 ${r.p} 場 ${r.pts} 分、上游 ${r.up.p} 場 ${r.up.pts} 分`).join(';');
      note = g.status === 'mismatch'
        ? `⚠ 場數一樣,積分或進失球卻跟上游對不上:${diffs}。本站印的是自己用賽果算的。`
        : `${(g.live ?? []).length ? `上游的積分榜已經算進正在踢的 ${g.live.length} 場,本站只算踢完的` : '上游的積分榜跟本站的賽果不是同一批(其中一邊還沒更新)'}:${diffs}。`
          + '這一組照積分、淨勝球、進球排,同分時官方的排序規則(例如相互對戰)沒有套用。';
    }
    return lines.join('\n') + '\n' + (note ? `\n> ${note}\n` : '') + `\n已完賽 ${g.counted} 場。\n`;
  };

  const matchBoundary = c => '\n## 資料界線\n\n'
    + `- 賽程與賽果:FotMob(${c?.zh ?? '—'},一個賽事一個請求${c?.retrievedAt ? ',抓取於 ' + utc(c.retrievedAt) : ''})\n`
    + `- 評分與勝率:只從 martj42/international_results 算(收錄到 ${asOf})\n`
    + '- 沒有即時比分、陣容、傷停與賽後報告 —— 國家隊的逐場詳情還沒接\n'
    + `- 時間是 UTC・建置於 ${utc(I.builtAt)}\n`;

  let nMatch = 0, nTeam = 0, nComp = 0;
  const m = I.model ?? {};
  const h = m.holdout;

  // ── 比賽:未賽 ──
  for (const f of I.fixtures ?? []) {
    const links = [];
    const c = comps.get(f.comp);
    const H = sideName(f.home), A = sideName(f.away);
    const st = stateOf(f);
    const b = [];
    b.push(frontmatter({
      類型: '比賽', 分類: '國家隊', 賽事: compZh(f.comp), 輪次: f.roundZh, 分組: f.groupZh,
      開球: f.kickoff, 主隊: H, 客隊: A, 已完賽: false, 狀態: st,
      主勝率: f.prob?.[0], 和局率: f.prob?.[1], 客勝率: f.prob?.[2],
      主隊Elo: f.prob ? f.elo?.[0] : null, 客隊Elo: f.prob ? f.elo?.[1] : null,
      中立場機率: f.prob ? f.venue?.q : null,
      產生時間: I.builtAt,
    }));
    b.push(`\n# ${compZh(f.comp)}${tagsOf(f) ? ' ' + tagsOf(f) : ''} ${H} vs ${A}\n`);
    links.push(compFile(f.comp));
    b.push(`\n${sideRef(f.home, links)} vs ${sideRef(f.away, links)} —— ${utc(f.kickoff)}・${wl(compFile(f.comp))}\n`);
    if (f.state === 'CANCELLED') {
      b.push(`\n> **${st}**${f.stoppedAt ? `(中止時 ${f.stoppedAt[0]}-${f.stoppedAt[1]})` : ''}。`
        + (f.reasonLong ? `上游的說法:${f.reasonLong}。` : '') + '\n');
    }
    if (f.state === 'LIVE') {
      b.push(`\n> **建置當下(${utc(I.builtAt)})這一場正在踢。** 國家隊沒有即時比分,賽果等下一次部署(每天兩次)。`
        + '下面的勝率是賽前的。\n');
    }
    if (f.prob) {
      b.push('\n## 賽前勝率\n\n| 主勝 | 和 | 客勝 |\n|---|---|---|\n| ' + f.prob.map(pc).join(' | ') + ' |\n');
      b.push(`\n- 本站 Elo ${f.elo?.[0]} 對 ${f.elo?.[1]}(評分算到 ${asOf})\n`);
      b.push('- ' + venueText(f) + '\n');
      const lt = lagText(f);
      if (lt) b.push('- ' + lt + '\n');
      if (h) {
        b.push(`\n> ${m.method}。參數在 ${m.tune?.from} ~ ${m.tune?.to} 挑、驗收在另一段年份(${h.from} 之後 ${h.n} 場):`
          + `RPS ${h.model} 對基準線 ${h.baseline},改善 ${h.gain} ± ${h.se}(${h.z} 倍標準誤)。\n`
          + '> 沒有放進模型的:先發名單、傷停、總教練、旅途與時差;友誼賽常常大量輪換,那是模型看不到的。'
          + '勝率僅供分析參考,不構成投注建議。\n');
      }
    } else if (f.state !== 'CANCELLED') {
      b.push(`\n## 賽前勝率\n\n不給:${f.why ?? '這一場沒有勝率'}。\n`);
    }
    if (f.home?.key && f.away?.key) {
      const hl = h2hLines(f.home.key, f.away.key, links);
      if (hl) b.push('\n## 歷來交手\n\n' + hl.join('\n') + '\n');
    }
    b.push(matchBoundary(c));
    addNote(INTL_DIR + '/比賽/' + matchFile(f) + '.md', b.join(''), links);
    nMatch++;
  }

  // ── 比賽:賽果 ──
  for (const r of I.results ?? []) {
    const links = [];
    const c = comps.get(r.comp);
    const H = sideName(r.home), A = sideName(r.away);
    const [label, text] = checkOf(r);
    const b = [];
    b.push(frontmatter({
      類型: '比賽', 分類: '國家隊', 賽事: compZh(r.comp), 輪次: r.roundZh, 分組: r.groupZh,
      開球: r.kickoff, 主隊: H, 客隊: A, 已完賽: true,
      主隊進球: r.final[0], 客隊進球: r.final[1],
      結束方式: r.reason === 'AET' ? '延長賽後' : r.reason === 'Pen' ? 'PK' : null,
      PK勝方: r.pensWinner ? zhOf(r.pensWinner) : null, 判決比分: r.awarded || null,
      核對: label, 已進評分: inRating(r),
      產生時間: I.builtAt,
    }));
    b.push(`\n# ${compZh(r.comp)}${tagsOf(r) ? ' ' + tagsOf(r) : ''} ${H} vs ${A}\n`);
    links.push(compFile(r.comp));
    b.push(`\n${sideRef(r.home, links)} vs ${sideRef(r.away, links)} —— ${utc(r.kickoff)}・${wl(compFile(r.comp))}\n`);
    /* 印的是 FotMob 記的比分(產物的 final)。兩個來源記得不一樣的時候要講出這是哪一邊的,不然讀者會以為是定論 */
    b.push(`\n## 比分\n\n**${H} ${r.final[0]} - ${r.final[1]} ${A}**${endText(r)}`
      + (r.check === 'mismatch' || r.check === 'awarded' ? '(FotMob 記的比分,見下面的核對)' : '') + '\n');
    if (r.reason === 'Pen') {
      b.push(r.pensWinner
        ? '\n> PK 勝方來自 martj42 的 shootouts.csv(FotMob 的賽程沒有 PK 比數)。\n'
        : '\n> 上游只說 PK 後結束,勝方要等獨立來源收錄這一場 —— 不拿平手比分猜。\n');
    }
    /* 進不進評分分三種講:已經算進去、還沒(martj42 還沒收到那一天,收了就會算)、不會(它沒收這一場,或隊名對不上) */
    b.push(`\n## 核對\n\n- ${text}\n- ${inRating(r)
      ? `這一場已經算進評分(martj42 收錄到 ${asOf})`
      : r.check === 'notYet'
        ? '這一場**還沒**算進評分 —— 評分只從 martj42 算,它收了這一天之後才會算進去'
        : '這一場**不會**算進評分 —— 評分只從 martj42 算,而它沒有這一場(或這一場的隊名本站對不上)'}\n`);
    b.push('\n## 賽前勝率\n\n國家隊的已完賽場次產物裡不帶勝率 —— 本站沒有保存國家隊的賽前機率快照,'
      + '也不拿賽後的評分重算一個冒充賽前的。\n');
    b.push(matchBoundary(c));
    addNote(INTL_DIR + '/比賽/' + matchFile(r) + '.md', b.join(''), links);
    nMatch++;
  }

  // ── 賽事 ──
  for (const c of I.comps ?? []) {
    const links = [];
    const fx = (I.fixtures ?? []).filter(f => f.comp === c.key).sort((x, y) => kick(x) - kick(y));
    const rs = (I.results ?? []).filter(r => r.comp === c.key).sort((x, y) => kick(y) - kick(x));
    const st = (I.standings ?? []).find(x => x.comp === c.key);
    const b = [];
    b.push(frontmatter({
      類型: '賽事', 分類: '國家隊', 名稱: c.zh, 英文名: c.en, 賽季: c.season, FotMob賽事id: c.id,
      未賽: fx.length, 賽果: rs.length, 產生時間: c.retrievedAt,
    }));
    b.push(`\n# ${c.zh}\n\n${[c.en, c.season].filter(Boolean).join('・')}\n`);
    if (c.status !== 'ok') b.push(`\n> 這個賽事${c.status === 'excluded' ? '**不收**' : '**還沒抓**'}:${c.why ?? ''}\n`);
    if (c.proof) {
      b.push(`\n> 賽事 id 用**內容**證明過:已完賽的場次逐場對 martj42,對上 ${c.proof.matched} 場`
        + (c.proof.proofSeason ? `(含上一季 ${c.proof.proofSeason.season})` : '')
        + `,那邊叫 ${(c.proof.tournaments ?? []).slice(0, 2).map(t => `${t.t}×${t.n}`).join('、')}。名字靠不住(CONCACAF 也有 Nations League)。\n`);
    }
    if (st?.groups?.length) {
      b.push('\n## 分組積分榜\n');
      for (const g of st.groups) b.push(`\n### ${g.zh ?? g.name}\n\n` + groupTable(g, links));
      b.push('\n> 積分由本站用已完賽的賽果算,再逐隊跟上游的表核對;晉級區間是上游(FotMob)的圖例,本站照譯。'
        + '上游會把正在踢的比賽算進積分榜,本站只算踢完的 —— 比賽進行中那幾組會跟上游差一場。\n');
    }
    if (fx.length) b.push(`\n## 接下來的比賽(${fx.length} 場)\n\n` + fx.map(f => fixtureLine(f, links)).join('\n') + '\n');
    if (rs.length) {
      const n = k => rs.filter(r => r.check === k).length;
      b.push(`\n## 賽果(${rs.length} 場)\n\n` + rs.map(r => resultLine(r, links)).join('\n') + '\n');
      b.push(`\n> 核對:兩個來源一致 ${n('agree')}・待核對 ${n('notYet')}・獨立來源沒收 ${n('unmatched')}・不一致 ${n('mismatch')}`
        + (n('awarded') ? `・判決比分 ${n('awarded')}` : '') + '。「待核對」是獨立來源還沒收到那一天,不等於不一致。\n');
    }
    b.push('\n## 資料界線\n\n'
      + `- 賽程與賽果:FotMob(賽事 id ${c.id}${c.retrievedAt ? ',抓取於 ' + utc(c.retrievedAt) : ''})\n`
      + `- 勝率只從 martj42 的歷史賽果算(收錄到 ${asOf});見 ${wl(INTL_DIR)}\n`
      + '- 沒有即時比分:賽程與賽果跟著每天兩次的部署更新\n'
      + '- 時間是 UTC\n');
    links.push(INTL_DIR);
    addNote(INTL_DIR + '/賽事/' + compFile(c.key) + '.md', b.join(''), links);
    nComp++;
  }

  // ── 球隊 ──
  const outc = s => (s[0] > s[1] ? 'W' : s[0] === s[1] ? 'D' : 'L');
  const OUT = { W: '勝', D: '和', L: '負' };
  const VENUE = { H: '主', A: '客', N: '中立' };
  const DAY = 86400000;
  for (const [k, info] of Object.entries(teams)) {
    const links = [];
    const X = T.teams?.[k] ?? {};
    const zh = zhOf(k);
    const nm = (I.nonMembers ?? []).find(x => x.key === k);
    const standing = info.rank ? `排名第 ${info.rank} / ${(I.ranking ?? []).length} 隊`
      : nm ? (nm.linked ? '不是國際足總會員,不列排名(主要跟會員交手,評分可以比)'
        : '不是國際足總會員,不列排名(兩年內只跟非會員踢,評分跟會員比不起來)')
        : '不列排名(兩年內沒踢,或場數不到門檻)';
    const b = [];
    b.push(frontmatter({
      類型: '球隊', 分類: '國家隊', 名稱: zh, 英文名: k, Elo: info.rating, 排名: info.rank,
      國際足總會員: info.member, 場數: info.games, 最近一場: info.last, 評分算到: asOf,
      產生時間: I.builtAt,
    }));
    b.push(`\n# ${zh}\n`);
    if (flagFile.has(k)) b.push(`\n![[${flagFile.get(k)}|48]]\n`);
    b.push(`\n${zh !== k ? k + '・' : ''}${info.rating != null ? `本站 Elo ${info.rating}(${standing})` : standing}`
      + `・累積 ${info.games} 場・最近一場 ${info.last}。\n`
      + `評分只從 martj42 的歷史賽果算,算到 ${asOf} —— **不是 FIFA 排名**。\n`);

    const recent = X.recent ?? [];
    const last10 = recent.slice(-10);
    if (last10.length) {
      const cnt = o => last10.filter(r => outc(r.s) === o).length;
      b.push(`\n**最近 ${last10.length} 場**:${cnt('W')} 勝 ${cnt('D')} 和 ${cnt('L')} 負(martj42 收錄、已算進評分的最近 ${last10.length} 場)\n`);
    }
    /* 過去一年的評分:**評分截止日**往前推一年那一刻的評分,對現在(站上球隊頁同一個定義 ——
       拿「這一隊最後一場」往前推的話,很久沒踢的隊會拿好幾年前的點冒充「一年來」) */
    const tr = X.trend ?? [];
    const yearAgo = asOf ? new Date(Date.parse(`${asOf}T00:00:00Z`) - 365 * DAY).toISOString().slice(0, 10) : null;
    const basePt = yearAgo ? [...tr].reverse().find(p => p[0] <= yearAgo) : null;
    if (basePt && info.rating != null) {
      const yoy = info.rating - basePt[1];
      b.push(`\n**過去一年的評分**:${yoy > 0 ? '+' : ''}${yoy}(${yearAgo} 是 ${basePt[1]} → ${asOf} 是 ${info.rating}・`
        + `這一年踢了 ${tr.filter(p => p[0] > yearAgo).length} 場)\n`);
    }

    const mine = x => x.home?.key === k || x.away?.key === k;
    const upcoming = (I.fixtures ?? []).filter(mine).sort((x, y) => kick(x) - kick(y));
    b.push('\n## 接下來的比賽\n\n' + (upcoming.length
      ? upcoming.map(f => fixtureLine(f, links)).join('\n') + '\n'
      : `建置當下,本站抓的 ${okComps} 個賽事裡這一隊沒有排定的比賽。\n`));

    const groups = (I.standings ?? []).flatMap(st => st.groups.filter(g => g.rows.some(r => r.key === k))
      .map(g => ({ g, comp: st.comp })));
    if (groups.length) {
      b.push('\n## 分組積分榜\n');
      for (const { g, comp } of groups) {
        links.push(compFile(comp));
        b.push(`\n### ${wl(compFile(comp))}・${g.zh ?? g.name}\n\n` + groupTable(g, links, k));
      }
    }

    const res = (I.results ?? []).filter(mine).sort((x, y) => kick(y) - kick(x));
    if (res.length) {
      const pend = res.filter(r => !inRating(r)).length;
      b.push(`\n## 這一窗的賽果(本站抓的賽事,${res.length} 場)\n\n` + res.map(r => resultLine(r, links)).join('\n') + '\n');
      if (pend) b.push(`\n> 其中 ${pend} 場**還沒進評分**:獨立來源(martj42)還沒收或沒收,所以沒有改到上面的評分。\n`);
    }

    const opps = [...new Set(upcoming.filter(f => f.state !== 'CANCELLED')
      .map(f => (f.home?.key === k ? f.away?.key : f.home?.key)).filter(Boolean))];
    const h2h = opps.map(o => h2hLines(k, o, links)).filter(Boolean);
    if (h2h.length) b.push('\n## 歷來交手(跟接下來的對手)\n\n' + h2h.map(x => x.join('\n')).join('\n\n') + '\n');

    if (tr.length > 1) {
      const byYear = new Map();
      for (const [d, r] of tr) {
        const y = d.slice(0, 4);
        byYear.set(y, { last: r, n: (byYear.get(y)?.n ?? 0) + 1 });
      }
      b.push(`\n## 評分走勢(${String(T.trendFrom ?? tr[0][0]).slice(0, 4)} 年起)\n\n`
        + `${tr.length} 場・${tr[0][0]} 是 ${tr[0][1]} → 目前 ${tr.at(-1)[1]}(${tr.at(-1)[1] - tr[0][1] >= 0 ? '+' : ''}${tr.at(-1)[1] - tr[0][1]})\n\n`
        + '| 年 | 那一年最後一場之後的評分 | 那一年的場數 |\n|---|---|---|\n'
        + [...byYear].map(([y, v]) => `| ${y} | ${v.last} | ${v.n} |`).join('\n') + '\n');
    }

    if (recent.length) {
      b.push(`\n## 最近的比賽(評分已經算進去的最近 ${recent.length} 場)\n\n`
        + '| 日期 | 對手 | 場地 | 比分 | 賽事(martj42 原文) | 評分變化 | 賽後評分 |\n|---|---|---|---|---|---|---|\n'
        + [...recent].reverse().map(r => `| ${r.d} | ${ref(r.o, links)} | ${VENUE[r.v] ?? r.v} | ${r.s[0]} - ${r.s[1]} ${OUT[outc(r.s)]} `
          + `| ${r.t} | ${r.dr > 0 ? '+' : ''}${Number(r.dr).toFixed(1)} | ${r.r} |`).join('\n') + '\n'
        + '\n> 評分變化就是這一場讓 Elo 動了多少。比分含延長、不含 PK。\n');
    }

    b.push('\n## 資料界線\n\n'
      + `- 評分、走勢、最近的比賽與交手紀錄:martj42/international_results(收錄到 ${asOf})\n`
      + '- 賽程與這一窗的賽果:FotMob\n'
      + (flagFile.has(k)
        ? `- 國旗:${I.flags?.source?.name ?? '開源國旗集'}(${I.flags?.source?.license ?? ''} 授權,本站縮成 ${(FL?.size ?? I.flags?.size ?? []).join('×')})\n`
        : `- 沒有國旗:${flagWhyNot(k)}\n`)
      + '- 沒有陣容、傷停、總教練與賽後報告\n'
      + `- 時間是 UTC・建置於 ${utc(I.builtAt)}\n`);
    links.push(INTL_DIR);
    addNote(INTL_DIR + '/球隊/' + teamFile.get(k) + '.md', b.join(''), links);
    nTeam++;
  }

  // ── 國家隊首頁(MOC)──
  const links = [];
  const b = [];
  b.push(frontmatter({ 類型: '賽事', 分類: '國家隊', 名稱: '國家隊', 評分算到: asOf, 產生時間: I.builtAt }));
  b.push('\n# 國家隊\n\n男子 A 級國家隊。**兩個來源,分工不重疊**:\n\n');
  for (const s of I.sources ?? []) {
    b.push(`- **[${s.name}](${s.url})** —— ${s.role}`
      + (s.rows ? `(${s.rows.toLocaleString('en-US')} 場,收錄到 ${s.lastDate})` : '') + '\n');
  }
  b.push('\n## 賽事\n\n');
  for (const c of I.comps ?? []) {
    const nf = (I.fixtures ?? []).filter(f => f.comp === c.key).length;
    const nr = (I.results ?? []).filter(r => r.comp === c.key).length;
    links.push(compFile(c.key));
    b.push(`- ${wl(compFile(c.key))} —— 未賽 ${nf}・賽果 ${nr}\n`);
  }
  const rk = I.ranking ?? [];
  if (rk.length) {
    b.push(`\n## 本站 Elo 排名(${rk.length} 隊)\n\n`
      + `> **不是 FIFA 排名。** 只列國際足總會員(用「踢過世界盃或它的資格賽」認)、兩年內踢過比賽、而且累積 ${m.minGames} 場以上的隊 —— `
      + '評分從 1872 年的第一場算起,解散或很久沒踢的隊評分凍在當年,列進來會變成歷史榜。'
      + `分數本身沒有單位:兩隊差 100 分,代表中立場上強的那一邊的預期得分是 ${Math.round(100 / (1 + 10 ** (-100 / 400)))}%(贏算 1、和算 0.5)。\n\n`
      + '| 名次 | 國家隊 | Elo | 場數 | 最近一場 |\n|---|---|---|---|---|\n'
      + rk.map(r => `| ${r.rank} | ${ref(r.key, links)} | ${r.rating} | ${r.games} | ${r.last} |`).join('\n') + '\n');
  }
  const nmList = I.nonMembers ?? [];
  if (nmList.length) {
    const linked = nmList.filter(x => x.linked), alone = nmList.filter(x => !x.linked);
    b.push(`\n### 有評分、但不是會員的 ${nmList.length} 隊(不列排名)\n\n`);
    if (linked.length) b.push(`- **主要跟會員交手**(評分可以比,它們的比賽照常給勝率):${linked.map(x => ref(x.key, links)).join('、')}\n`);
    if (alone.length) b.push(`- **兩年內只跟非會員踢**(評分是在那個小圈子裡累積的,跟會員比不起來):${alone.map(x => ref(x.key, links)).join('、')}\n`);
  }
  if (h) {
    b.push('\n## 勝率怎麼來的\n\n'
      + `${m.method}。主場分、K 的整體倍率與和局曲線在 **${m.tune?.from} ~ ${m.tune?.to}** 的 ${m.tune?.n} 場上挑(試了 ${m.tune?.tried} 組),`
      + `驗收在**另一段年份**(${h.from} 之後)上做,參數固定、同一天的比賽互相看不到結果。\n\n`
      + '| | 場數 | RPS(越低越好) | 基準線 | 改善 |\n|---|---|---|---|---|\n'
      + `| 全部 | ${h.n} | ${h.model} | ${h.baseline} | ${h.gain} ± ${h.se}(${h.z} 倍標準誤) |\n`
      + (h.competitive ? `| 非友誼賽 | ${h.competitive.n} | ${h.competitive.model} | ${h.competitive.baseline} | ${h.competitive.gain} ± ${h.competitive.se} |\n` : '')
      + (h.friendly ? `| 友誼賽 | ${h.friendly.n} | ${h.friendly.model} | ${h.friendly.baseline} | ${h.friendly.gain} ± ${h.friendly.se} |\n` : '')
      + `\n基準線是驗收那一批**自己的**主勝/和局/客勝比例(中立場與否分開算)—— 它偷看了答案,對基準線有利。`
      + `上線門檻:${m.gate}。這一次:${m.passed ? '**通過**,所以未賽的場次給勝率' : '**沒通過**,所以一場都不給勝率'}。\n`);
    if (m.calibration?.length) {
      b.push('\n### 校準:說 60% 的,實際是不是 60%\n\n| 預測區間 | 場次點數 | 平均預測 | 實際發生 |\n|---|---|---|---|\n'
        + m.calibration.map(x => `| ${x.bin * 10}~${x.bin * 10 + 10}% | ${x.n} | ${pc(x.predicted)} | ${pc(x.actual)} |`).join('\n')
        + '\n\n> 驗收那一批的每一場貢獻三個點(主勝、和局、客勝)。\n');
    }
    const v = m.venue, vh = v?.holdout;
    if (vh) {
      b.push(`\n### 中立場是推的\n\n上游的賽程沒有中立場這個欄位。所以用**開賽前 ${v.lag} 天以前**的歷史賽果推一個「是中立場」的機率:`
        + '決賽圈與區域盃這類主辦型賽事,看同一屆已踢的比賽是不是多半在中立場、主隊是不是主辦國;'
        + `主客場型賽事與友誼賽,看主隊最近 ${v.N} 場同類的主場有幾場在中立場,再往這一類賽事的平均收縮。`
        + `參數在 ${v.tune?.from} ~ ${v.tune?.to} 挑的(試了 ${v.tune?.tried} 組),驗收在 ${vh.from} 之後的 ${vh.n} 場:`
        + `對「一律當主場」改善 ${vh.gain} ± ${vh.se}(${vh.z} 倍標準誤)`
        + (vh.oracle ? `;拿賽後才知道的中立場欄位當答案的話是 ${vh.oracle.gain}` : '') + '。'
        + (v.passes ? '這一次通過門檻,所以未賽的勝率用推的 —— 這是**推論**,不是賽事公布的場地。' : '這一次**沒有**通過門檻,所以未賽一律當主場算。') + '\n');
    }
    if (m.lag?.affected) {
      b.push(`\n### 評分會落後\n\nmartj42 收錄新賽果會晚幾天到幾週,那段時間踢的比賽不進評分。拿驗收那一批模擬「評分晚 ${m.lag.days} 天」:`
        + `兩隊至少一隊在那幾天裡踢過的 ${m.lag.affected.n} 場,每場 RPS 平均多 ${m.lag.affected.cost} ± ${m.lag.affected.se}`
        + `(${m.lag.affected.z} 倍標準誤;模型整體的改善是 ${h.gain})。`
        + (m.lag.passes ? '這個代價大過兩倍標準誤。' : '沒有大過兩倍標準誤 —— 所以本站**不**拿還沒被核對的賽果提早更新評分。') + '\n');
    }
    b.push('\n沒有放進模型的:先發名單、傷停、總教練、旅途與時差 —— 本站沒有這些資料,勝率只看兩隊的歷史戰績。\n');
  }
  const cc = I.checkCounts ?? {};
  b.push('\n## 資料界線\n\n'
    + `- **核對**:FotMob 的每一場已完賽都跟 martj42 逐場對 —— 一致 ${cc.agree ?? 0}・待核對 ${cc.notYet ?? 0}・`
    + `獨立來源沒收 ${cc.unmatched ?? 0}・不一致 ${cc.mismatch ?? 0}。「待核對」是它還沒收到那一天,不等於不一致\n`
    + '- **沒有即時比分**:賽程與賽果跟著每天兩次的部署更新,比賽中不會動\n'
    + '- **評分會落後**:獨立來源還沒收的比賽不拿來改評分,所以每一場的勝率旁邊會講兩隊之後又踢了幾場\n'
    + '- **沒有陣容、傷停與賽後報告**:國家隊的逐場詳情還沒接\n'
    + '- **時間一律 UTC**;網站依讀者的時區分天,筆記是靜態的\n'
    + '- **martj42 的賽事名照原文**(Friendly、UEFA Nations League…);FotMob 那幾個賽事的中文名是產物給的\n');
  const nf = I.notFetched;
  if (nf?.comps?.length) {
    b.push(`- **只收有比賽的 ${(I.comps ?? []).length} 個賽事。** 其餘 ${nf.comps.length} 個在 ${nf.checkedAt} 探測時,`
      + `接下來 ${nf.horizonDays} 天一場都沒有,開打時再加進來:`
      + nf.comps.map(c => `${c.zh}(${c.id}${c.proof ? `,id 已證明 ${c.proof}` : ',id 未證明'})`).join('、') + '\n');
  }
  if (I.flags) {
    const f = I.flags;
    b.push(`- **國旗**:${f.source?.name}(${f.source?.license} 授權),${f.count} 隊有。沒有的:`
      + [...(f.excluded ?? []).map(x => `${zhOf(x.key)}刻意不給(${x.why})`),
        (f.sameAs ?? []).length ? `${f.sameAs.map(x => zhOf(x.key)).join('、')}(國旗集裡就是宗主國的旗,掛上去會讓人以為是那一國)` : null,
        (f.noCode ?? []).filter(x => !(f.excluded ?? []).some(e => e.key === x)).length
          ? `${f.noCode.filter(x => !(f.excluded ?? []).some(e => e.key === x)).map(zhOf).join('、')}(沒有國碼)` : null,
      ].filter(Boolean).join(';') + '\n');
  }
  addNote(INTL_DIR + '/' + INTL_DIR + '.md', b.join(''), links);

  intlCounts = { comps: nComp, teams: nTeam, matches: nMatch };
  return nComp + nTeam + nMatch + 1;
}


/* ── 足球知識 ─────────────────────────────────────────────
   全站唯一一頁大半內容不是本站算出來的,所以只有一條規矩:
   **共識歸共識、資料歸資料,而且要一眼分得出來。**

   共識層(data/manual/football-knowledge.json)是人工整理的慣例,逐條帶來源;
   資料層(web/data{,/leagues/es1}/knowledge.json)是從本站球員與陣型紀錄算的。
   兩層在同一則筆記裡也要分成兩節,不混在一起講。 */
function buildKnowledge() {
  const fkPath = join(ROOT, 'data', 'manual', 'football-knowledge.json');
  if (!existsSync(fkPath)) return 0;
  const fk = read(fkPath);
  const D = '足球知識';
  const srcById = new Map((fk._sources ?? []).map(s => [s.id, s]));
  const cite = ids => (ids ?? []).map(id => {
    const s = srcById.get(id);
    return s ? '[' + (s.short ?? s.title) + '](' + s.url + ')' : id;
  }).join('、');

  // 資料層:兩個聯賽各一份,同一則筆記兩邊都列
  const dataLayer = LEAGUES.map(lg => ({ lg, k: load(lg.key, 'knowledge') })).filter(x => x.k);
  let count = 0;
  const mocLinks = [];

  // ── 背號 ──
  for (const n of fk.numbers ?? []) {
    const file = sanitize('背號 ' + n.n);
    mocLinks.push(file);
    const body = [];
    body.push(frontmatter({ 類型: '足球知識', 主題: '背號', 背號: n.n, 傳統位置: n.zh }));
    body.push('\n# 背號 ' + n.n + '\n');
    body.push('\n## 傳統上是誰穿(共識層)\n\n**' + n.zh + '**' + (n.en ? '(' + n.en + ')' : '') + '\n');
    if (n.note) body.push('\n' + n.note + '\n');
    body.push('\n> 這一節是**人工整理的慣例**,不是本站算出來的。來源:' + cite(n.sources) + '\n');

    body.push('\n## 本站資料裡實際是誰在穿(資料層)\n\n');
    let any = false;
    for (const { lg, k } of dataLayer) {
      const row = arr(k.numbers?.rows ?? []).find(r => r.n === n.n);
      if (!row || !row.total) continue;
      any = true;
      const share = row.topShare != null ? (row.topShare * 100).toFixed(0) + '%' : '';
      body.push('- **' + lg.zh + '**:' + row.total + ' 人穿,最多是 ' + row.topPos + ' ' + share
        + '(GK ' + row.counts.GK + '・DEF ' + row.counts.DEF + '・MID ' + row.counts.MID + '・FWD ' + row.counts.FWD + ')\n');
    }
    if (!any) body.push('本站資料裡沒有人穿這個號碼,或母體不足以列出來。\n');
    /* 這段警語不能省:多數來源把邊鋒歸在中場,7 號與 11 號「不再是前鋒」
       有一部分是分類粒度造成的,不是傳統瓦解。 */
    body.push('\n> 位置分類是上游給的,而**多數來源把邊鋒歸在中場** ——\n'
      + '> 所以 7 號、11 號看起來「不再是前鋒」有一部分是分類粒度造成的,不能讀成傳統瓦解。\n'
      + '> 真正能看的是大類有沒有換邊(例如 6 號)。\n');
    addNote(D + '/背號/' + file + '.md', body.join(''), []);
    count++;
  }

  // ── 位置角色 ──
  for (const pos of fk.positions ?? []) {
    const file = sanitize('位置 ' + pos.zh);
    mocLinks.push(file);
    const body = [];
    body.push(frontmatter({ 類型: '足球知識', 主題: '位置角色', 位置: pos.zh, 英文: pos.en, 線: pos.line }));
    body.push('\n# ' + pos.zh + (pos.en ? '(' + pos.en + ')' : '') + '\n');
    const info = defTable([['所在線', pos.line], ['英文', pos.en]]);
    if (info) body.push('\n' + info);
    if (pos.def) body.push('\n' + pos.def + '\n');
    body.push('\n> 這一則是**共識層**,人工整理的定義。來源:' + cite(pos.sources) + '\n');
    /* 刻意不做:位置角色不掛本站球員。本站的球員位置只有 GK/DEF/MID/FWD 四個粗類,
       分不出誰是節拍器、誰是工兵型。 */
    body.push('\n## 為什麼這裡不列本站球員\n\n'
      + '本站的球員位置只有 GK / DEF / MID / FWD 四個粗類,分不出誰是節拍器、誰是工兵型。\n'
      + '用「傳球多就是節拍器」這種自己編的判準充數,會變成整站唯一查不到出處的東西。\n');
    addNote(D + '/位置/' + file + '.md', body.join(''), []);
    count++;
  }

  // ── 陣型 ──
  for (const f of fk.formations ?? []) {
    const file = sanitize('陣型 ' + f.label);
    mocLinks.push(file);
    const body = [];
    body.push(frontmatter({ 類型: '足球知識', 主題: '陣型', 陣型: f.label, 分帶: (f.bands ?? []).join('-') }));
    body.push('\n# ' + f.label + '\n');
    if (f.idea) body.push('\n' + f.idea + '\n');
    if (f.rows?.length) {
      body.push('\n## 站位(示意)\n\n');
      for (const row of f.rows) body.push('- ' + row.join(' · ') + '\n');
      body.push('\n> 圖上是**示意站位**。本站沒有球員追蹤資料,所以不畫跑動箭頭 ——\n'
        + '> 畫了就會變成整站唯一查不到出處的東西。\n');
    }
    if (f.strengths?.length) body.push('\n## 強項\n\n' + f.strengths.map(x => '- ' + x + '\n').join(''));
    if (f.weaknesses?.length) body.push('\n## 弱點\n\n' + f.weaknesses.map(x => '- ' + x + '\n').join(''));
    body.push('\n> 這一則是**共識層**。來源:' + cite(f.sources) + '\n');

    body.push('\n## 本站資料裡的使用情況(資料層)\n\n');
    let any = false;
    for (const { lg, k } of dataLayer) {
      const row = arr(k.formations?.rows ?? []).find(r => (r.label ?? r.name) === f.label);
      if (!row) continue;
      any = true;
      const unit = k.formations?.unit ? '(單位:' + k.formations.unit + ')' : '';
      body.push('- **' + lg.zh + '**:' + (row.count ?? row.n ?? row.total ?? '?') + unit + '\n');
    }
    if (!any) body.push('本站資料裡沒有記錄到這個陣型。\n');
    body.push('\n> **不要把「陣型好」講成「成績好」。** 量過了,相關性最強的一條也只到中等,\n'
      + '> 而且方向很可能是反的(強隊才敢少放一個後衛)。\n');
    addNote(D + '/陣型/' + file + '.md', body.join(''), []);
    count++;
  }

  // ── MOC ──
  const moc = [];
  moc.push(frontmatter({ 類型: '主題', 名稱: '足球知識', 共識層更新: fk._updated }));
  moc.push('\n# 足球知識\n');
  moc.push('\n這一區大半內容**不是本站算出來的**,所以只有一條規矩:\n');
  moc.push('\n> **共識歸共識、資料歸資料,而且要一眼分得出來。**\n');
  moc.push('\n| 層 | 來源 | 性質 |\n|---|---|---|\n');
  moc.push('| 共識層 | `data/manual/football-knowledge.json` | 人工整理,逐條帶來源網址,不隨比賽更新 |\n');
  moc.push('| 資料層 | `web/data{,/leagues/es1}/knowledge.json` | 從本站球員與陣型紀錄算的,每次 build 重算 |\n');
  if (fk._disclaimer) moc.push('\n> ' + fk._disclaimer + '\n');
  moc.push('\n## 背號\n\n' + (fk.numbers ?? []).map(n => wl(sanitize('背號 ' + n.n))).join(' · ') + '\n');
  moc.push('\n## 位置角色\n\n' + (fk.positions ?? []).map(x => wl(sanitize('位置 ' + x.zh))).join(' · ') + '\n');
  moc.push('\n## 陣型\n\n' + (fk.formations ?? []).map(x => wl(sanitize('陣型 ' + x.label))).join(' · ') + '\n');
  moc.push('\n## 來源清單\n\n');
  for (const s of fk._sources ?? []) moc.push('- [' + (s.title ?? s.short) + '](' + s.url + ')\n');
  addNote(D + '/足球知識.md', moc.join(''), mocLinks);
  return count + 1;
}


/* 跨聯賽的四塊:歐冠、英格蘭盃賽、國家隊、足球知識。
   都是各自一份資料,不掛在任一個聯賽底下,也各自呼叫一次(不複製轉換邏輯)。 */
summary.push('  歐冠:' + buildUcl() + ' 則(' + reportCount.ucl + ' 場併了賽後報告・球員榜 ' + boardCount.ucl + ' 季)');
{ const n = buildCups(); summary.push('  英格蘭盃賽:' + n + ' 則(' + reportCount.cup + ' 場併了賽後報告・球員榜 ' + boardCount.cup + ' 季)' + (cupsMerged ? '(上游重覆掛在兩個階段的 ' + cupsMerged + ' 場已合併)' : '')); }
{ const n = buildIntl(); summary.push('  國家隊:' + n + ' 則' + (intlCounts ? '(賽事 ' + intlCounts.comps + '・球隊 ' + intlCounts.teams + '・比賽 ' + intlCounts.matches + ')' : '')); }
summary.push('  足球知識:' + buildKnowledge() + ' 則');

/* ── 驗證:寫進磁碟之前先確認 ────────────────────────────────
   兩件事在 Obsidian 裡都是「靜靜出錯」,不會有任何地方報錯:

   1. 兩個筆記同檔名 —— 後寫的蓋掉先寫的,而且 [[連結]] 只會指到剩下那一個。
   2. [[連結]] 指到不存在的筆記 —— 點下去是空白新檔,看起來像資料漏了。

   所以這兩條在寫檔前就檢查,不通過直接中止。 */
const basenameOf = p => p.slice(p.lastIndexOf('/') + 1, -3);

const byPath = new Map();
const dupPaths = [];
for (const n of notes) {
  if (byPath.has(n.path)) dupPaths.push(n.path);
  byPath.set(n.path, n);
}

/* Obsidian 的 [[X]] 是**跨資料夾**用 basename 解析的,所以唯一性要看 basename,
   不是完整路徑。不同資料夾放兩個同名檔一樣會出事。 */
const byBase = new Map();
for (const n of notes) {
  const b = basenameOf(n.path);
  if (!byBase.has(b)) byBase.set(b, []);
  byBase.get(b).push(n.path);
}
const dupBases = [...byBase.entries()].filter(([, v]) => v.length > 1);

const known = new Set(byBase.keys());
const broken = new Map();
for (const n of notes) {
  for (const l of n.links) {
    if (!known.has(l)) {
      if (!broken.has(l)) broken.set(l, []);
      broken.get(l).push(n.path);
    }
  }
}

let fatal = false;
if (dupPaths.length) {
  console.error(`✗ 有 ${dupPaths.length} 個重複路徑,例如:${dupPaths.slice(0, 5).join(', ')}`);
  fatal = true;
}
if (dupBases.length) {
  console.error(`✗ 有 ${dupBases.length} 組同檔名(Obsidian 的 [[連結]] 會指錯):`);
  for (const [b, paths] of dupBases.slice(0, 10)) console.error(`    ${b} → ${paths.join(' | ')}`);
  fatal = true;
}
if (broken.size) {
  console.error(`✗ 有 ${broken.size} 個連結指不到任何筆記:`);
  for (const [l, from] of [...broken].slice(0, 10)) console.error(`    [[${l}]] ← ${from[0]}${from.length > 1 ? ` 等 ${from.length} 篇` : ''}`);
  fatal = true;
}
if (fatal) { console.error('\n✗ 沒有寫出任何檔案。'); process.exit(1); }

const MINE = '我的筆記';

/* ── 寫檔 ────────────────────────────────────────────────
   只清空自己產生的聯賽資料夾。vault/我的筆記/ 是使用者手寫的,永遠不碰 ——
   產生器把它掃掉的話,那是不可逆的資料遺失,而且重跑也救不回來。 */
mkdirSync(OUT, { recursive: true });
const generatedDirs = new Set([...notes.map(n => n.path), ...assets.map(a => a.path)]
  .map(p => p.split('/')[0]).filter(d => d.endsWith('.md') === false));
if (generatedDirs.has(MINE)) {
  console.error('✗ 產生器想寫進 ' + MINE + '/ —— 那是手寫筆記的資料夾,中止。');
  process.exit(1);
}
for (const d of generatedDirs) {
  const dir = join(OUT, d);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
for (const n of notes) {
  const full = join(OUT, n.path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, n.body);
}
for (const a of assets) {
  const full = join(OUT, a.path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, a.buf);
}

const mineDir = join(OUT, MINE);
if (!existsSync(mineDir)) {
  mkdirSync(mineDir, { recursive: true });
  writeFileSync(join(mineDir, '讀我.md'),
    `# 我的筆記\n\n這個資料夾是**你的**,\`npm run obsidian\` 永遠不會碰它。\n\n`
    + `外面那些聯賽資料夾是產物,每次重跑都會整個重建 —— 在那裡面寫的東西會不見。\n`
    /* `[[球隊名]]` 要包在行內程式碼裡:裸寫的話它就是一個真的連結,在 Obsidian 裡點下去會開出一則空白的「球隊名」
       (壞連結守門只查產生器宣告的連結,看不到內文;test-vault.mjs 掃內文才抓到) */
    + `想對某支球隊或某個球員加自己的想法,在這裡開一則筆記,用 \`[[球隊名]]\` 連過去就好;\n`
    + `Obsidian 的反向連結會讓那則球隊筆記也看得到你寫了什麼。\n`);
}

writeFileSync(join(OUT, 'README.md'), [
  '# 英超戰情室 —— Obsidian vault',
  '',
  '本站資料集的**筆記版**,由 `npm run obsidian` 產生。',
  '',
  '## 哪些能改,哪些不能',
  '',
  '| 資料夾 | 性質 |',
  '|---|---|',
  ...[...generatedDirs].sort().map(d => `| \`${d}/\` | **產物**。每次重跑整個重建 —— 在裡面手寫的東西會不見 |`),
  `| \`${MINE}/\` | **你的**。產生器永遠不碰 |`,
  '',
  '想對某支球隊或某個球員加自己的想法,在 `' + MINE + '/` 開一則筆記,',
  '用 `[[球隊名]]` 連過去 —— Obsidian 的反向連結會讓那則球隊筆記也看得到你寫了什麼。',
  '這樣重跑不會蓋掉你的東西。',
  '',
  '## 重跑',
  '',
  '```bash',
  'cd epl',
  'npm run obsidian',
  '```',
  '',
  '產生前會先檢查兩件事,不通過就中止而且一個檔案都不寫:',
  '',
  '- **沒有兩則筆記同檔名** —— Obsidian 的 `[[連結]]` 是跨資料夾用檔名解析的,',
  '  同名會讓連結靜靜指到其中一個,而且不會有任何地方報錯。',
  '- **每個 `[[連結]]` 都指得到筆記** —— 指不到的話點下去是空白新檔,看起來像資料漏了。',
  '',
  '## 欄位',
  '',
  '每則筆記的 frontmatter 都有 `類型`(球員 / 球隊 / 比賽 / 聯賽 / 賽事…),聯賽的筆記有 `聯賽`、',
  '歐冠 / 盃賽 / 國家隊的有 `賽事`;國家隊的另有 `分類: 國家隊`,**時間一律是 UTC**。',
  '**拿不到的欄位整個不出現** —— 看到空白代表版面壞了,不是資料是空的。',
  '',
  '裝了 Dataview 之後可以這樣查:',
  '',
  '```dataview',
  'TABLE 球隊, 位置, 背號, 年齡',
  'FROM "英超/球員"',
  'WHERE 年齡 <= 21',
  'SORT 年齡 ASC',
  '```',
  '',
  '```dataview',
  'TABLE 上季名次, 上季積分, Elo, 名單人數',
  'FROM "西甲/球隊"',
  'SORT 上季名次 ASC',
  '```',
  '',
  '```dataview',
  'LIST',
  'FROM "英超/比賽"',
  'WHERE 已完賽 = false AND 輪次 = 2',
  '```',
  '',
  '```dataview',
  'TABLE 開球, 主隊, 客隊, 主勝率, 和局率, 客勝率',
  'FROM "國家隊/比賽"',
  'WHERE 已完賽 = false AND 主勝率',
  'SORT 開球 ASC',
  '```',
  '',
  '## 裡面有什麼',
  '',
  ...summary.map(s => '- ' + s.trim()),
  '',
  '球員↔球隊↔比賽↔教練用 `[[連結]]` 互相串起來。歐冠的對手本站認得的連回聯賽的球隊筆記,',
  '認不得的在 `歐冠/球隊/` 各有一則(只有歐冠範圍的戰績、球員與比賽);盃賽的低級別對手只印名字 ——',
  '不為了版面對齊造空殼筆記。國家隊自成一區:賽事 ↔ 球隊 ↔ 比賽互相連結。',
  '',
  '## 這裡不做的事',
  '',
  '**已完賽的場次只放兩種預測:走查回測的,以及開賽前存下來的快照。** 建置時的模型',
  '(`trainMatches = [...history, ...curPlayed]`)已經看過那場結果,拿它當賽前預測是假的,所以不放;',
  '快照是比賽日迴圈在開賽時凍結的(只有即時追蹤過的場次有),之後不覆寫。兩種都沒有的場次照實寫沒有。',
  '未賽場次的預測則是真的賽前預測,照放。',
  '',
  /* 這一段原本寫死「跨聯賽有 13 組同名、0 組可以核對」—— 那是只有英超西甲時量的。
     數字改成這一次產生時算的(homonymStats),判準寫在 assignFilenames 的檔頭。 */
  `**同名球員不合併。** 這一次有 ${homonymStats.groups} 組同名,其中 ${homonymStats.cross} 組跨聯賽。`,
  `西甲、德甲、義甲、法甲的球員來自 Understat,它的球員 id 跨聯賽共用:${homonymStats.sameId} 組是**同一個 id**(確定是同一人,多半是轉會),`,
  `${homonymStats.diffId} 組 id 不同(確定是不同人);其餘的兩邊沒有共用 id(英超用 FPL、英冠用 FotMob),**無法核對**。`,
  '「看起來是同一人」不是證據。三種情況都各自成篇,筆記上的「同名提醒」逐筆寫明是哪一種。',
  '',
  '**沒有出賽紀錄不列一整排 0。** 上游的 0 分不出「在這個聯賽但沒上場」與',
  '「當季不在這個聯賽」(外借到別的聯賽一樣是 0),所以改成把這件事講清楚。',
  '',
  '## 數字的出處',
  '',
  '全部從本站資料集直接搬運,沒有在這一層重新計算或推估。',
  '要追到更上游,看 `epl/web/data/` 與各聯賽首頁筆記的「資料來源」一節。',
  '',
].join('\n'));

console.log(`\n✔ Obsidian vault → ${OUT}`);
summary.forEach(s => console.log(s));
if (reportTrouble.length) console.log(`  ⚠ 聯賽賽後報告沒掛上 ${reportTrouble.length} 筆:${reportTrouble.slice(0, 5).join('、')}${reportTrouble.length > 5 ? '…' : ''}`);
console.log(`  共 ${notes.length} 則筆記・${[...known].length} 個唯一檔名・0 個壞連結`);
console.log(`  手寫筆記放 ${MINE}/(產生器不碰)`);
