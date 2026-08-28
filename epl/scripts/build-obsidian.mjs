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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argOf = name => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const OUT = argOf('out') ?? join(ROOT, 'vault');

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const arr = x => (Array.isArray(x) ? x : Object.values(x ?? {}));
const dataDir = lg => (lg === 'pl' ? join(ROOT, 'web', 'data') : join(ROOT, 'web', 'data', 'leagues', 'es1'));
const load = (lg, name) => {
  const p = join(dataDir(lg), `${name}.json`);
  return existsSync(p) ? read(p) : null;
};

const LEAGUES = [
  { key: 'pl', zh: '英超', dir: '英超' },
  { key: 'es1', zh: '西甲', dir: '西甲' },
];

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
/* frontmatter 只收「真的有值」的欄位。null / undefined / 空字串一律不寫 ——
   Dataview 查到一個永遠是空的欄位,跟畫面上留一個空欄位是同一種錯。 */
const frontmatter = obj => {
  const lines = Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => (Array.isArray(v)
      ? `${k}:\n${v.map(x => `  - ${yamlVal(x)}`).join('\n')}`
      : `${k}: ${yamlVal(v)}`));
  return `---\n${lines.join('\n')}\n---\n`;
};

/* 表格只列有值的欄位。整張表都沒值就回空字串,連標題都不出現。 */
const defTable = rows => {
  const keep = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!keep.length) return '';
  return `| | |\n|---|---|\n${keep.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n`;
};
const statTable = (cols, row) => {
  const keep = cols.filter(([, key]) => row?.[key] !== null && row?.[key] !== undefined);
  if (!keep.length) return '';
  return `| ${keep.map(([label]) => label).join(' | ')} |\n`
    + `|${keep.map(() => '---').join('|')}|\n`
    + `| ${keep.map(([, key]) => row[key]).join(' | ')} |\n`;
};

const notes = [];        // { path, links: [] }
const addNote = (path, body, links = []) => notes.push({ path, body, links });
const wl = name => `[[${name}]]`;

/* ── 球員:兩個聯賽正規化成同一個形狀 ────────────────────────
   一定要走同一個 renderPlayer。各寫一份的話,兩邊的欄位取捨會慢慢分岔,
   而 vault 看起來仍然正常 —— 這是專案在跨聯賽頁面上踩過的同一個坑。 */
function collectPlayers(lg, meta) {
  const raw = arr(load(lg.key, 'players'));
  if (lg.key === 'pl') {
    return raw.map(p => ({
      id: `pl:${p.code}`, base: p.fullName || p.name, display: p.name,
      teamCode: p.team, pos: p.pos, posZh: p.posZh, squadNumber: p.squadNumber,
      age: p.age, dob: p.dateOfBirth, height: p.height, weight: p.weight,
      captain: p.captain || null, statusZh: p.statusZh, news: p.news || null,
      price: p.price, transferred: p.transferred || null, lastTeam: p.lastTeam,
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
      id: `es1:${p.id}`, base: newest.fullName || newest.name, display: newest.name,
      teamCode: (newest.teamCodes || [])[0] ?? null, pos: newest.pos, posZh: newest.posZh,
      squadNumber: newest.squadNumber, age: newest.age, dob: newest.dateOfBirth,
      height: newest.height, weight: newest.weight, captain: null,
      statusZh: null, news: null, price: null,
      seasons: p.seasons
        .slice().sort((a, b) => String(a.season).localeCompare(String(b.season)))
        .map(s => ({ season: s.season, kind: null, stats: s, teams: s.teams })),
      sources: { 表現統計: 'Understat', 身分與背號: 'SportMonks' },
    };
  });
}

/* ── 檔名:唯一性是被驗證出來的,不是假設的 ──────────────────
   實測:以 fullName 當檔名,1,299 個球員裡有 15 組撞名 ——
   13 組是跨聯賽(多半是轉會的同一人)、2 組是西甲內部的不同人。

   跨聯賽那 13 組**不能合併**:兩份資料源在同一個名字上從來沒有同時給出
   sportmonksId,0 組可以核對。「看起來是同一人」不是證據(鐵則五)。
   所以兩邊各自成篇,檔名加隊碼區分,並在筆記上寫明無法核對。 */
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
    表現統計來源: p.sources.表現統計, 身分來源: p.sources.身分與背號,
    產生時間: ctx.builtAt,
  }));
  body.push(`\n# ${p.base}\n`);
  if (p.display && p.display !== p.base) body.push(`> 常用稱呼:${p.display}\n`);

  const links = [];
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
      body.push(`${p.sources.表現統計} 沒有這一季的出賽紀錄。\n\n`
        + `> **這個 0 分不出兩件事**:「在${ctx.lg.zh}但沒上場」與「當季不在${ctx.lg.zh}」。\n`
        + `> 外借到其他聯賽的球員在 ${p.sources.表現統計} 一樣是 0,所以這裡不列那一排 0。\n`);
      continue;
    }
    body.push(t);
    if (s.teams?.length) body.push(`\n所屬:${s.teams.join('、')}\n`);
  }

  /* 同名的處理照鐵則四寫在筆記上,不靠讀者自己發現。 */
  if (p.homonyms?.length) {
    body.push(`\n## 同名提醒\n`);
    body.push(`\n這個名字在本站資料裡不只一筆。**兩份資料源沒有共用的球員 id 可以核對是不是同一人**,`
      + `所以各自成篇、不合併,也不宣稱是同一人:\n`);
    for (const h of p.homonyms) {
      body.push(`- ${wl(h.file)} —— ${h.leagueZh} / ${h.teamCode ?? '球隊未知'}\n`);
      links.push(h.file);
    }
  }

  body.push(`\n## 資料界線\n`);
  body.push(`\n- 表現統計來自 **${p.sources.表現統計}**,身分與背號來自 **${p.sources.身分與背號}**\n`);
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

  const info = defTable([
    ['隊碼', t.code], ['城市', t.city], ['主場', t.venue],
    ['容量', t.capacity ? t.capacity.toLocaleString('en-US') : null],
    ['Elo', t.elo], ['聯賽', ctx.lg.zh],
  ]);
  if (info) body.push(`\n${info}`);

  const coach = ctx.coachOf(t.code);
  if (coach?.name) {
    body.push(`\n## 現任教練\n\n**${coach.name}**`);
    if (coach.source) body.push(` —— 來源:${coach.source}`);
    body.push('\n');
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
  body.push(frontmatter({
    類型: '比賽', 聯賽: ctx.lg.zh, 賽季: f.season, 輪次: f.round, 日期: f.date,
    開球: f.kickoff, 主隊: f.home, 客隊: f.away, 已完賽: f.played,
    主隊進球: f.played ? f.fh : null, 客隊進球: f.played ? f.fa : null,
    產生時間: ctx.builtAt,
  }));
  body.push(`\n# ${ctx.lg.zh} ${f.season} 第 ${f.round} 輪 ${H} vs ${A}\n`);
  body.push(`\n${wl(H)} vs ${wl(A)} —— ${f.date}\n`);

  if (f.played) {
    body.push(`\n## 比分\n\n**${H} ${f.fh} : ${f.fa} ${A}**\n`);
    if (f.hh !== null && f.hh !== undefined) body.push(`\n半場 ${f.hh} : ${f.ha}\n`);
    /* 本季已完賽的場次沒有保存賽前機率快照,而 fixtures.json 的 prediction
       是建置時重算的(模型訓練資料含這場結果)。印出來就是拿賽後重建冒充賽前預測。 */
    body.push(`\n## 賽前預測\n\n`);
    body.push(`本站沒有保存這場的**賽前機率快照**,所以這裡不放預測數字。\n\n`);
    body.push(`資料集裡的 \`prediction\` 是建置時重算的 —— 模型的訓練資料已經包含這場結果,`
      + `拿它當賽前預測會是假的。走查回測(真正的賽前預測)目前只涵蓋 ${ctx.backtestSeasons || '上一季'}。\n`);
  } else if (f.prediction) {
    const p = f.prediction;
    body.push(`\n## 模型預測(未賽)\n\n`);
    body.push(`| 主勝 | 和 | 客勝 |\n|---|---|---|\n`);
    body.push(`| ${(p.home * 100).toFixed(1)}% | ${(p.draw * 100).toFixed(1)}% | ${(p.away * 100).toFixed(1)}% |\n`);
    const extra = statTable([['預期進球(主)', 'xgHome'], ['預期進球(客)', 'xgAway'],
      ['大於 2.5 球', 'over25'], ['兩隊都進球', 'btts']], p);
    if (extra) body.push(`\n${extra}`);
    if (p.topScores?.length) {
      body.push(`\n最可能比分:${p.topScores.slice(0, 3).map(s => `${s.s}(${(s.p * 100).toFixed(1)}%)`).join('、')}\n`);
    }
    body.push(`\n> 模型:${ctx.modelName}。預測僅供分析參考,不構成投注建議。\n`);
  }

  body.push(`\n## 資料界線\n\n- 賽程與比分來源見 ${wl(ctx.lg.zh)} 的來源清單\n`);
  body.push(`- 建置時間 ${ctx.builtAt}\n`);
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

  body.push(`\n## 球隊\n\n`);
  body.push(teams.map(t => { links.push(t.en); return wl(t.en); }).join(' · ') + '\n');

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

/* ── 主流程 ──────────────────────────────────────────────── */
const summary = [];
const allPlayers = [];

for (const lg of LEAGUES) {
  const meta = load(lg.key, 'meta');
  if (!meta) { console.log(`  ⚠ ${lg.zh} 沒有 meta.json,略過`); continue; }
  const teams = arr(load(lg.key, 'teams'));
  const fixturesRaw = arr(load(lg.key, 'fixtures'));
  const players = collectPlayers(lg, meta);
  for (const p of players) p.leagueZh = lg.zh;
  allPlayers.push({ lg, meta, teams, fixturesRaw, players });
}

// 檔名要在**兩個聯賽都收齊之後**才決定 —— 撞名有 13 組是跨聯賽的。
assignFilenames(allPlayers.flatMap(x => x.players));

for (const { lg, meta, teams, fixturesRaw, players } of allPlayers) {
  const teamByCode = new Map(teams.map(t => [t.code, t]));
  const teamNameOf = code => teamByCode.get(code)?.en ?? null;
  const coaches = load(lg.key, 'coaches');
  const coachList = arr(coaches?.coaches ?? coaches ?? []);
  const coachBy = new Map(coachList.filter(c => c?.team).map(c => [c.team, c]));
  const tableRaw = load(lg.key, 'table');
  const table = arr(tableRaw?.rows ?? tableRaw?.table ?? tableRaw ?? [])
    .filter(r => r && r.code && r.pos != null);

  const fixtures = fixturesRaw
    .filter(f => f.season === meta.currentSeason)
    .map(f => ({ ...f, file: sanitize(`${lg.zh} ${f.season} R${String(f.round ?? 0).padStart(2, '0')} ${f.home}-${f.away}`) }));

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

  const statCols = lg.key === 'pl'
    ? [['出賽分鐘', 'minutes'], ['先發', 'starts'], ['進球', 'goals'], ['助攻', 'assists'],
       ['xG', 'xG'], ['xA', 'xA'], ['黃牌', 'yellow'], ['紅牌', 'red'], ['FPL 分', 'points']]
    : [['出賽', 'games'], ['分鐘', 'minutes'], ['進球', 'goals'], ['助攻', 'assists'],
       ['xG', 'xG'], ['xA', 'xA'], ['射門', 'shots'], ['關鍵傳球', 'keyPasses'],
       ['黃牌', 'yellow'], ['紅牌', 'red']];
  const playerGaps = lg.key === 'pl' ? [] : ['傷停與停賽', '防守數據'];

  const ctx = {
    lg, teamNameOf, playersByTeam, fixturesByTeam, statCols, playerGaps,
    coachOf: code => coachBy.get(code) ?? null,
    builtAt: meta.builtAt, currentSeason: meta.currentSeason, lastSeason: meta.lastSeason,
    modelName: meta.model?.name ?? 'Dixon-Coles Poisson + Elo',
    backtestSeasons: lg.key === 'pl' ? '2025-26' : null,
    sources: meta.sources, table,
  };

  const D = lg.dir;
  const leagueNote = renderLeague(ctx, teams, players, fixtures);
  addNote(`${D}/${lg.zh}.md`, leagueNote.body, leagueNote.links);
  for (const t of teams) {
    const r = renderTeam(t, ctx);
    addNote(`${D}/球隊/${sanitize(t.en)}.md`, r.body, r.links);
  }
  for (const p of players) {
    const r = renderPlayer(p, ctx);
    addNote(`${D}/球員/${p.file}.md`, r.body, r.links);
  }
  for (const f of fixtures) {
    const r = renderMatch(f, ctx);
    addNote(`${D}/比賽/${f.file}.md`, r.body, r.links);
  }
  summary.push(`  ${lg.zh}:${teams.length} 隊・${players.length} 球員・${fixtures.length} 場`);
}

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

/* ── 寫檔 ────────────────────────────────────────────────
   只清空自己產生的聯賽資料夾。vault/我的筆記/ 是使用者手寫的,永遠不碰 ——
   產生器把它掃掉的話,那是不可逆的資料遺失,而且重跑也救不回來。 */
const MINE = '我的筆記';
mkdirSync(OUT, { recursive: true });
for (const lg of LEAGUES) {
  const dir = join(OUT, lg.dir);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
for (const n of notes) {
  const full = join(OUT, n.path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, n.body);
}

const mineDir = join(OUT, MINE);
if (!existsSync(mineDir)) {
  mkdirSync(mineDir, { recursive: true });
  writeFileSync(join(mineDir, '讀我.md'),
    `# 我的筆記\n\n這個資料夾是**你的**,\`npm run obsidian\` 永遠不會碰它。\n\n`
    + `外面那些聯賽資料夾是產物,每次重跑都會整個重建 —— 在那裡面寫的東西會不見。\n`
    + `想對某支球隊或某個球員加自己的想法,在這裡開一則筆記,用 [[球隊名]] 連過去就好;\n`
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
  ...LEAGUES.map(l => `| \`${l.dir}/\` | **產物**。每次重跑整個重建 —— 在裡面手寫的東西會不見 |`),
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
  '每則筆記的 frontmatter 都有 `類型`(球員 / 球隊 / 比賽 / 聯賽)與 `聯賽`。',
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
  '## 這裡不做的事',
  '',
  '**已完賽的場次不放預測數字。** 本站沒有保存本季的賽前機率快照,',
  '而資料集裡的 `prediction` 是建置時重算的 —— `build.mjs` 的訓練資料',
  '(`trainMatches = [...history, ...curPlayed]`)已經包含那場結果。',
  '拿它當賽前預測是假的。未賽場次的預測則是真的賽前預測,照放。',
  '',
  '**同名球員不合併。** 跨聯賽有 13 組同名(多半是轉會的同一人),',
  '但兩份資料源在同一個名字上從來沒有同時給出 sportmonksId,0 組可以核對。',
  '「看起來是同一人」不是證據,所以各自成篇並在筆記上寫明無法核對。',
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
console.log(`  共 ${notes.length} 則筆記・${[...known].length} 個唯一檔名・0 個壞連結`);
console.log(`  手寫筆記放 ${MINE}/(產生器不碰)`);
