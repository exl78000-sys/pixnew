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
      id: `es1:${p.id}`, base: newest.fullName || newest.name, display: newest.name,
      teamCode: (newest.teamCodes || [])[0] ?? null, pos: newest.pos, posZh: newest.posZh,
      squadNumber: newest.squadNumber, age: newest.age, dob: newest.dateOfBirth,
      height: newest.height, weight: newest.weight, captain: null,
      statusZh: null, news: null, price: null,
      // 西甲是一人一季一筆,租借掛在哪一筆都算這個人的,收成一份去重
      loans: [...new Map(p.seasons.flatMap(s => s.loans ?? [])
        .map(l => [l.season + l.direction + l.loanCode, l])).values()],
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
    租借紀錄數: p.loans?.length || null,
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
    body.push(`\n這個名字在本站資料裡不只一筆。**兩份資料源沒有共用的球員 id 可以核對是不是同一人**,`
      + `所以各自成篇、不合併,也不宣稱是同一人:\n`);
    for (const h of p.homonyms) {
      /* 租借紀錄接得上的話,同名這件事就有證據了 ——
         「Brighton → Elche」正好把英超那一則與西甲那一則接起來。
         但這仍然是第三方的說法,不是共用 id,所以是「有紀錄支持」不是「已證實」。 */
      const bridge = (p.loans ?? []).find(l => l.loanCode === h.teamCode || l.parentCode === h.teamCode);
      body.push(`- ${wl(h.file)} —— ${h.leagueZh} / ${h.teamCode ?? '球隊未知'}`
        + (bridge
          ? `。**有一筆${bridge.verdict === 'confirmed' ? '經獨立來源確認' : '核對無矛盾'}的租借紀錄接得起來**`
            + `(${bridge.season} ${bridge.parentClub} → ${bridge.loanClub}),支持是同一人 ——`
            + ` 但那仍是第三方說法,兩邊資料源沒有共用 id,所以不合併。`
          : '') + '\n');
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
    } else {
      body.push(`\n## 賽前預測\n\n`);
      body.push(`本站沒有保存這場的**賽前機率快照**,所以這裡不放預測數字。\n\n`);
      body.push(`資料集裡的 \`prediction\` 是建置時重算的 —— 模型的訓練資料已經包含這場結果,`
        + `拿它當賽前預測會是假的。走查回測(真正的賽前預測)只涵蓋 ${ctx.walkForwardSeason ?? '另一個賽季'}。\n`);
    }

    const rep = ctx.reportFor(f);
    if (rep) {
      body.push(`\n## 賽後報告\n\n`);
      for (const [code, side] of Object.entries(rep.sides ?? {})) {
        const nm = ctx.teamNameOf(code) ?? code;
        body.push(`### ${nm}\n\n`);
        const st = statTable([['實際 xG', 'xG'], ['射門', 'shots'], ['射正', 'shotsOn'],
          ['控球%', 'possession'], ['角球', 'corners'], ['犯規', 'fouls']], side);
        if (st) body.push(st);
        if (side.shape?.label) body.push(`\n陣型:${side.shape.label}\n`);
        if (side.best?.length) {
          body.push(`\n本場最佳:` + side.best.slice(0, 3)
            .map(b => `${b.name}${b.rating != null ? `(${b.rating})` : ''}`).join('、') + '\n');
        }
        body.push('\n');
      }
      if (rep.source) body.push(`> 賽後資料來源:${rep.source}\n`);
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
  const extra = lg.key === 'pl'
    ? arr(load('pl', 'clubs'))
    : arr(read(join(ROOT, 'data', 'manual', 'teams-la-liga.json')).teams);
  for (const c of extra) {
    if (!c?.code || dir.has(c.code)) continue;
    dir.set(c.code, { ...c, rich: false });
  }
  return dir;
}

/* ── 主流程 ──────────────────────────────────────────────── */
const summary = [];
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
for (const { lg, teams } of allPlayers) {
  for (const [code, c] of clubDirectory(lg, teams)) {
    teamFileByCode.set(lg.key + ':' + code, sanitize(c.en || c.of || code));
  }
}

for (const { lg, meta, teams, fixturesRaw, players } of allPlayers) {
  const clubs = clubDirectory(lg, teams);
  const teamNameOf = code => clubs.get(code)?.en ?? null;
  const coaches = load(lg.key, 'coaches');
  const coachList = arr(coaches?.coaches ?? coaches ?? []).filter(c => c?.name);
  const coachBy = new Map(coachList.filter(c => c?.team).map(c => [c.team, c]));
  const tableRaw = load(lg.key, 'table');
  const table = arr(tableRaw?.rows ?? tableRaw?.table ?? tableRaw ?? [])
    .filter(r => r && r.code && r.pos != null);
  const reportsFile = load(lg.key, 'reports');
  const reports = reportsFile?.reports ?? {};
  const goalsFile = load(lg.key, 'goals');
  /* 走查回測的預測**是**賽前預測 —— 訓練資料只到該輪開賽前,
     跟 fixtures.json 那個建置時重算的完全不是同一回事。
     所以這一份可以放心印在已完賽的場次上,而且要講清楚它是哪一種。 */
  const wfPath = join(ROOT, 'data', lg.key === 'pl' ? 'backtest-matches.json' : 'backtest-laliga-matches.json');
  const walkForward = new Map();
  let walkForwardSeason = null;
  if (existsSync(wfPath)) {
    const wf = read(wfPath);
    walkForwardSeason = wf.season;
    for (const m of wf.matches ?? []) walkForward.set(m.season + '|' + m.home + '|' + m.away, m.pred);
  }

  const matchFile = m => sanitize(lg.zh + ' ' + m.season
    + ' R' + String(m.round ?? 0).padStart(2, '0') + ' ' + m.home + '-' + m.away);

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

  const statCols = lg.key === 'pl'
    ? [['出賽分鐘', 'minutes'], ['先發', 'starts'], ['進球', 'goals'], ['助攻', 'assists'],
       ['xG', 'xG'], ['xA', 'xA'], ['黃牌', 'yellow'], ['紅牌', 'red'], ['FPL 分', 'points']]
    : [['出賽', 'games'], ['分鐘', 'minutes'], ['進球', 'goals'], ['助攻', 'assists'],
       ['xG', 'xG'], ['xA', 'xA'], ['射門', 'shots'], ['關鍵傳球', 'keyPasses'],
       ['黃牌', 'yellow'], ['紅牌', 'red']];
  const playerGaps = lg.key === 'pl' ? [] : ['傷停與停賽', '防守數據'];

  const ctx = {
    lg, teamNameOf, playersByTeam, fixturesByTeam, historyByTeam, statCols, playerGaps,
    coachOf: code => coachBy.get(code) ?? null,
    coachFileOf: code => { const c = coachBy.get(code); return c ? coachFileOf(c, lg) : null; },
    reportFor: m => reports[m.season + '|' + m.home + '|' + m.away] ?? null,
    walkForwardFor: m => walkForward.get(m.season + '|' + m.home + '|' + m.away) ?? null,
    walkForwardSeason: walkForwardSeason,
    goalsFor: code => goalsFile?.data?.[meta.lastSeason]?.teams?.[code] ?? null,
    goalsSeason: meta.lastSeason, goalsNote: goalsFile?.note ?? null,
    builtAt: meta.builtAt, currentSeason: meta.currentSeason, lastSeason: meta.lastSeason,
    modelName: meta.model?.name ?? 'Dixon-Coles Poisson + Elo',
    backtestSeasons: lg.key === 'pl' ? '2025-26' : null,
    sources: meta.sources, table,
  };

  const D = lg.dir;
  const leagueNote = renderLeague(ctx, [...clubs.values()], players, matches);
  addNote(D + '/' + lg.zh + '.md', leagueNote.body, leagueNote.links);
  for (const t of clubs.values()) {
    const r = renderTeam(t, ctx);
    addNote(D + '/球隊/' + sanitize(t.en || t.of || t.code) + '.md', r.body, r.links);
  }
  for (const p of players) {
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
    + coachList.length + ' 教練');
}


/* ── 歐冠 ────────────────────────────────────────────────
   跨聯賽的一份資料,所以放在自己的資料夾,不掛在任一個聯賽底下。

   **不另外開歐冠球隊筆記。** 36 隊裡本站認得的只有 8~11 支,
   其餘只有名字。給每一隊開一則筆記的話,認得的那幾支會跟
   英超/西甲的球隊筆記變成兩個同名檔案 —— Obsidian 的連結會指錯。
   所以認得的連回既有筆記,不認得的就印名字,不造一則空殼。

   **不放勝率預測。** 現有模型是用聯賽比賽調的,歐冠有跨聯賽實力比較、
   兩回合制、延長賽、PK 大戰四件它沒見過的事。沒有回測證據就不上(鐵則二)。 */
function uclTeamRef(t, links) {
  if (!t) return '(未知)';
  const file = t.code && t.league ? teamFileByCode.get(t.league + ':' + t.code) : null;
  if (file) { links.push(file); return wl(file); }
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
function buildUcl() {
  const u = load('pl', 'ucl');
  if (!u) return 0;
  uclSource = u.source;
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

    if (s.champion?.team) {
      body.push('\n## 冠軍\n\n**' + uclTeamRef(s.champion.team, links) + '**');
      if (s.champion.runnerUp) body.push(' —— 亞軍 ' + uclTeamRef(s.champion.runnerUp, links));
      if (s.champion.match) body.push('\n\n決賽比分:' + uclScoreLine(s.champion.match));
      body.push('\n');
    }

    if (s.table?.rows?.length) {
      body.push('\n## 聯賽階段名次\n\n');
      if (s.bands) {
        body.push('> 1-' + s.bands.auto.to + ' 直接晉級十六強・'
          + s.bands.playoff.from + '-' + s.bands.playoff.to + ' 附加賽・'
          + s.bands.out.from + '-' + s.bands.out.to + ' 淘汰。'
          + '**名次用官方那一份** —— UEFA 的同分比較有七層,本站只排得到前兩層。\n\n');
      }
      body.push('| # | 球隊 | 場次 | 勝 | 和 | 負 | 進 | 失 | 積分 |\n|---|---|---|---|---|---|---|---|---|\n');
      for (const r of s.table.rows) {
        body.push('| ' + r.position + ' | ' + uclTeamRef(r, links) + ' | ' + r.p + ' | ' + r.w
          + ' | ' + r.d + ' | ' + r.l + ' | ' + r.gf + ' | ' + r.ga + ' | ' + r.pts + ' |\n');
      }
    }

    // 聯賽階段的每一場
    for (const m of s.leagueMatches ?? []) {
      const file = sanitize('歐冠 ' + s.label + ' MD' + String(m.matchday ?? 0).padStart(2, '0')
        + ' ' + (m.home?.name ?? '?') + '-' + (m.away?.name ?? '?'));
      links.push(file);
      addNote(D + '/比賽/' + file + '.md', renderUclMatch(m, s, '聯賽階段').body, renderUclMatch(m, s, '聯賽階段').links);
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
    body.push('- **不做勝率預測**:現有模型沒見過跨聯賽比較、兩回合制、延長賽與 PK(鐵則二)\n');
    body.push('- 來源:' + (s.source ?? u.source) + '・抓取於 ' + (s.retrievedAt ?? u.retrievedAt) + '\n');
    addNote(D + '/賽季/' + sf + '.md', body.join(''), links);
    count++;
  }

  mocBody.push('\n## 資料界線\n\n- 來源:' + u.source + '\n');
  mocBody.push('- **不做勝率預測** —— 見任一賽季筆記的說明\n');
  addNote(D + '/歐冠.md', mocBody.join(''), mocLinks);
  return count + 1;
}

function renderUclMatch(m, s, stageZh, tie) {
  const links = [];
  const body = [];
  const H = m.home?.name ?? '?', A = m.away?.name ?? '?';
  body.push(frontmatter({
    類型: '比賽', 賽事: '歐冠', 賽季: s.label, 階段: stageZh,
    輪次: m.matchday ?? null, 開球: m.kickoff, 主隊: H, 客隊: A,
    已完賽: m.played, 延長賽: m.aet || null,
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
  body.push('\n## 資料界線\n\n- 來源:' + (s.source ?? uclSource ?? 'football-data.org') + '\n');
  body.push('- 不做勝率預測(鐵則二)\n');
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
function buildCups() {
  const c = load('pl', 'cups');
  if (!c) return 0;
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
      if (bits.length) body.push(bits.join('・') + '\n');
      if (s.champion?.name) body.push('\n冠軍:**' + s.champion.name + '**\n');

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
          const r = renderCupMatch(m, cup, s, rd, mergedOf.get(m));
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
    if (cup.missingSeasons?.length) body.push('- 拿不到的賽季:' + cup.missingSeasons.join('、') + '\n');
    body.push('- 對手的聯賽層級**逐季查**(球隊每年升降級),認不出來的就不標\n');
    body.push('- **隊名正規化只去字尾的 FC/AFC** —— 字首的 AFC 是球隊身分的一部分,\n');
    body.push('  去掉的話第九級的 AFC Liverpool 會被對成英超的 Liverpool(踩過兩次)\n');
    addNote(D + '/' + sanitize(cup.zh) + '.md', body.join(''), links);
    count++;
  }
  return count;
}

function renderCupMatch(m, cup, s, rd, mergedStages) {
  const links = [];
  const body = [];
  const H = m.home?.name ?? '?', A = m.away?.name ?? '?';
  body.push(frontmatter({
    類型: '比賽', 賽事: cup.zh, 賽季: s.label, 階段: rd.stage,
    回合: m.leg, 開球: m.kickoff, 主隊: H, 客隊: A, 已完賽: m.played,
    延長賽: m.aet || null, PK: m.pens ? true : null,
    主隊層級: m.home?.tier, 客隊層級: m.away?.tier,
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
  body.push('- 來源:SportMonks・不做勝率預測(盃賽要另一套模型:加時、PK、兩回合)\n');
  return { body: body.join(''), links };
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


/* 跨聯賽的三塊:歐冠、英格蘭盃賽、足球知識。
   都是各自一份資料,不掛在任一個聯賽底下,也各自呼叫一次(不複製轉換邏輯)。 */
summary.push('  歐冠:' + buildUcl() + ' 則');
{ const n = buildCups(); summary.push('  英格蘭盃賽:' + n + ' 則' + (cupsMerged ? '(上游重覆掛在兩個階段的 ' + cupsMerged + ' 場已合併)' : '')); }
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
const generatedDirs = new Set(notes.map(n => n.path.split('/')[0]).filter(d => d.endsWith('.md') === false));
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
  '## 裡面有什麼',
  '',
  ...summary.map(s => '- ' + s.trim()),
  '',
  '球員↔球隊↔比賽↔教練用 `[[連結]]` 互相串起來。歐冠與盃賽的對手,',
  '本站認得的連回球隊筆記、不認得的只印名字 —— 不為了版面對齊造空殼筆記。',
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
