/* 歐冠的計算層:把逐場資料整理成畫面要的形狀。
   只做「資料本來就有的整理」—— 分階段、配兩回合、算總比分、排積分榜。
   不推論、不補值、不預測(歐冠沒有經過驗收的模型,理由見下方 build 產出的 note)。 */

import { KO_ORDER, STAGE_ZH, winnerOfMatch, buildUclTeamIndex, normaliseUclMatch as _n } from './adapters/football-data-ucl.mjs';
import { crossCheck, checkDraw, drawIsSane, buildLeaders } from './adapters/fotmob-ucl.mjs';
/* squadsByTeam 要讀落地的 id 對照表。這一支只在 Node 跑,靜態 import 就好 —— 
   檔案其他地方用函式內動態 import 是既有風格,不要為了統一而改動它們。 */
import { readFileSync as readFileSyncFn, existsSync as existsSyncFn } from 'node:fs';
import { join as joinPath } from 'node:path';

const conflictsOf = idx => (idx.conflicts?.length ? true : false);

const key = (a, b) => [a, b].sort((x, y) => x - y).join('-');

/* 聯賽階段積分榜。
   **名次以官方那份為準**(standings 參數),自己算的只拿來對帳 ——
   UEFA 的同分比較有七層,我們排到淨勝球與進球就停了,再往下就是猜,
   而名次直接決定 1-8 / 9-24 / 25-36 三個分界。 */
export function leaguePhaseTable(matches, standings) {
  const T = new Map();
  const row = t => {
    if (!T.has(t.id)) T.set(t.id, { id: t.id, name: t.name, code: t.code, league: t.league, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
    return T.get(t.id);
  };
  for (const m of matches) {
    if (!m.played || !m.final) continue;
    const h = row(m.home), a = row(m.away), [hs, as] = m.final;
    h.p++; a.p++; h.gf += hs; h.ga += as; a.gf += as; a.ga += hs;
    if (hs > as) { h.w++; a.l++; h.pts += 3; } else if (hs < as) { a.w++; h.l++; a.pts += 3; } else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  const derived = [...T.values()].map(r => ({ ...r, gd: r.gf - r.ga }));

  /* 官方那份對得上就用官方的名次,並逐隊核對積分與進失球(鐵則五)。
     對不上的隊列出來讓畫面講出來 —— 靜靜選一個等於自己挑答案。 */
  const mismatches = [];
  let rows, order = 'derived';
  if (Array.isArray(standings) && standings.length) {
    const byId = new Map(derived.map(r => [r.id, r]));
    rows = standings.map(s => {
      const d = byId.get(s.teamId);
      if (d) {
        for (const [k, mine, theirs] of [['積分', d.pts, s.points], ['進球', d.gf, s.goalsFor],
          ['失球', d.ga, s.goalsAgainst], ['場次', d.p, s.playedGames]]) {
          if (mine !== theirs) mismatches.push({ team: s.teamName, field: k, ours: mine, official: theirs });
        }
      }
      return {
        position: s.position, id: s.teamId, name: d?.name ?? s.teamName, code: d?.code ?? null, league: d?.league ?? null,
        p: s.playedGames, w: s.won, d: s.draw, l: s.lost,
        gf: s.goalsFor, ga: s.goalsAgainst, gd: s.goalDifference, pts: s.points,
      };
    });
    order = 'official';
  } else {
    rows = derived
      .sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || String(x.name).localeCompare(String(y.name)))
      .map((r, i) => ({ position: i + 1, ...r }));
  }
  return { rows, order, mismatches };
}

/* 兩回合配對。用「這一輪裡的兩隊組合」當鍵 —— 主客會對調,所以鍵要排序過。
   決賽只有一場,照樣走這條路(單回合的 tie)。 */
export function knockoutRounds(matches) {
  const out = [];
  for (const stage of KO_ORDER) {
    const ms = matches.filter(m => m.stage === stage);
    if (!ms.length) continue;
    const groups = new Map();
    for (const m of ms) {
      const k = key(m.home.id, m.away.id);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const ties = [...groups.values()].map(legs => {
      legs.sort((a, b) => String(a.kickoff ?? '').localeCompare(String(b.kickoff ?? '')));
      /* 總比分以「每一回合踢完的比分」相加。PK 不進總比分 ——
         PK 是總比分打平之後才踢的,加進去等於算兩次。
         (客場進球規則 2021-22 已取消,所以不需要另外處理。) */
      const agg = new Map();
      let allPlayed = true;
      for (const m of legs) {
        if (!m.played || !m.final) { allPlayed = false; continue; }
        agg.set(m.home.id, (agg.get(m.home.id) ?? 0) + m.final[0]);
        agg.set(m.away.id, (agg.get(m.away.id) ?? 0) + m.final[1]);
      }
      const last = legs.at(-1);
      // 兩隊的身分固定用第一回合的主隊當「A」,顯示時才不會兩回合各換一次邊
      const A = legs[0].home, B = legs[0].away;
      let winner = null, decidedBy = null;
      if (allPlayed) {
        const a = agg.get(A.id) ?? 0, b = agg.get(B.id) ?? 0;
        if (a !== b) { winner = a > b ? A.id : B.id; decidedBy = legs.length > 1 ? 'aggregate' : 'match'; }
        else if (last.pens) {
          winner = last.pens[0] > last.pens[1] ? last.home.id : last.away.id;
          decidedBy = 'penalties';
        }
      }
      return {
        stage, teams: [A, B],
        aggregate: allPlayed ? [agg.get(A.id) ?? 0, agg.get(B.id) ?? 0] : null,
        legs, winner, decidedBy,
        // 決賽只有一場,不要在畫面上寫「總比分」
        twoLegged: legs.length > 1,
        aet: legs.some(m => m.aet === true),
        pens: last?.pens ?? null,
      };
    });
    ties.sort((a, b) => String(a.legs[0].kickoff ?? '').localeCompare(String(b.legs[0].kickoff ?? '')));
    out.push({
      stage, zh: STAGE_ZH[stage] ?? stage, ties,
      total: ms.length, played: ms.filter(m => m.played).length,
    });
  }
  return out;
}

/* 晉級者有沒有真的出現在下一輪 —— 這是本層唯一的獨立核對(鐵則五)。
   總比分算錯、PK 判錯、兩回合配錯,任何一種都會讓這條對不上。
   兩季 22 組實測 22/22 通過。 */
export function checkAdvancement(rounds) {
  const problems = [];
  for (let i = 0; i < rounds.length - 1; i++) {
    const next = new Set(rounds[i + 1].ties.flatMap(t => t.teams.map(x => x.id)));
    for (const t of rounds[i].ties) {
      if (t.winner === null) {
        if (rounds[i].played === rounds[i].total) {
          problems.push({ stage: t.stage, teams: t.teams.map(x => x.name), issue: '踢完了卻判不出晉級者' });
        }
        continue;
      }
      if (!next.has(t.winner)) {
        problems.push({
          stage: t.stage, teams: t.teams.map(x => x.name),
          issue: `判定晉級的是 ${t.teams.find(x => x.id === t.winner)?.name},但下一輪沒有這一隊`,
        });
      }
    }
  }
  return problems;
}

/* 冠軍。決賽踢完才有 —— 沒踢完就是 null,不要拿四強領先者充數。 */
export function championOf(rounds) {
  const fin = rounds.find(r => r.stage === 'FINAL');
  const tie = fin?.ties?.[0];
  if (!tie || tie.winner === null) return null;
  const m = tie.legs[0];
  const w = winnerOfMatch(m);
  if (!w) return null;
  return {
    team: m[w], runnerUp: m[w === 'home' ? 'away' : 'home'],
    match: m,
    // 比分從冠軍的角度寫。直接印 final[0]-final[1] 的話,客隊奪冠會顯示成「0-1 擊敗」
    score: m.final ? (w === 'away' ? [m.final[1], m.final[0]] : [...m.final]) : null,
    pens: m.pens ? (w === 'away' ? [m.pens[1], m.pens[0]] : [...m.pens]) : null,
    aet: m.aet === true,
  };
}

/* 本站認得的球隊在這一季走到哪裡。認不得的不進這張表 —— 沒有本站身分,列了也點不進去。 */
/* 把 FotMob 的球員按隊分組,並對回 football-data 的球隊 id。

   FotMob 用自己的 teamId,而歐冠資料(ucl.json)用的是 football-data 的 id ——
   兩邊靠 data/manual/ucl-team-ids.json 接起來,那份是落地的對照表。
   **不在這裡做隊名比對**:模糊比對會靜靜對錯球隊(盃賽頁踩過兩次)。
   對照表沒有的隊就不掛,不猜。

   **單位一律沿用上游宣告的,不自己命名。** 這一點差點出錯:
   我第一版把 total_scoring_att 叫成 `shots`、total_att_assist 叫成 `keyPasses`,
   但交付檔的 playerStatCategories 自己寫著
     total_scoring_att = "Shots per 90"(每 90 分鐘,不是總數)
     total_att_assist  = "Chances created"(總數)
     total_tackle / interception / defensive_contributions 也都是 per 90
   把每 90 分鐘標成總數就是編數字。所以欄位鍵直接用上游的 slug,
   標題也照抄上游的 title 一起輸出(statMeta),畫面照它講 ——
   上游哪天改了單位,我們不會靜靜跟著標錯。 */
const SQUAD_STATS = [
  'mins_played', 'goals', 'goal_assist', 'rating',
  'expected_goals', 'expected_assists',
  'total_scoring_att', 'total_att_assist', 'big_chance_created',
  'total_tackle', 'interception', 'yellow_card',
];

function squadsByTeam(players, categories, root) {
  const idPath = joinPath(root, 'data', 'manual', 'ucl-team-ids.json');
  const fmToFd = new Map();
  if (existsSyncFn(idPath)) {
    for (const t of JSON.parse(readFileSyncFn(idPath, 'utf8')).teams ?? []) {
      fmToFd.set(t.fotmobId, t.fdId);
    }
  }
  const titleOf = new Map((categories ?? []).map(c => [c.slug, c.title]));
  const num = v => (Number.isFinite(v) ? v : null);
  const byFd = new Map();
  for (const p of players) {
    const fd = fmToFd.get(p.teamId);
    if (fd == null) continue;                            // 對照表沒有 → 不掛
    const mins = p.stats?.mins_played?.value ?? null;
    if (!Number.isFinite(mins) || mins <= 0) continue;    // 沒上場的不列
    const stats = {};
    for (const k of SQUAD_STATS) {
      const v = num(p.stats?.[k]?.value);
      if (v !== null) stats[k] = v;
    }
    if (!byFd.has(fd)) byFd.set(fd, []);
    byFd.get(fd).push({
      name: p.name,
      countryCode: p.countryCode ?? null,
      minutes: mins,
      matches: p.stats?.mins_played?.subValue ?? null,
      stats,
    });
  }
  // 排序固定,兩個 build 的輸出才逐位元組相同
  for (const list of byFd.values()) {
    list.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
  }
  return {
    // 欄位名與單位都是上游宣告的,不是本站取的
    statMeta: Object.fromEntries(SQUAD_STATS
      .filter(k => titleOf.has(k))
      .map(k => [k, titleOf.get(k)])),
    teams: Object.fromEntries([...byFd.entries()].sort((a, b) => a[0] - b[0])),
  };
}

export function runsByTeam(matches, rounds, table) {
  /* **按球隊 id 建,不是按本站隊碼。**

     原本是 `if (!code) continue` —— 只算本站兩個聯賽認得的那 8~11 支,
     其餘 25 支在畫面上完全沒有戰績,而那些數字本來就在同一份資料裡。
     2026-08-28 改成涵蓋全部 36 隊;`code` 仍然保留(null 代表本站沒有球隊頁),
     前端照它決定要不要給連結。 */
  const runs = new Map();
  const posOf = new Map((table?.rows ?? []).map(r => [r.id, r.position]).filter(([id]) => id != null));
  const stageOrder = new Map(rounds.map((r, i) => [r.stage, i]));
  for (const m of matches) {
    for (const s of ['home', 'away']) {
      const t = m[s];
      if (!t || t.id == null) continue;
      /* bestOrder 從 -1 起跳,而聯賽階段不在 rounds 裡 ——
         只打聯賽階段就被淘汰的球隊(第 25-36 名)因此會停在 null。
         第一版就是這樣,畫面上 Girona 的「打到哪一輪」是空的,
         看起來像資料缺了,其實他們就是止步於聯賽階段。所以底線設在這裡。 */
      const cur = runs.get(t.id) ?? {
        id: t.id, code: t.code ?? null, league: t.league ?? null, name: t.name,
        leaguePos: posOf.get(t.id) ?? null,
        lp: 0, lw: 0, ld: 0, ll: 0, lgf: 0, lga: 0, koPlayed: 0, koWon: 0,
        best: '聯賽階段', bestOrder: -1, out: null, outTo: null,
      };
      if (m.stage === 'LEAGUE_STAGE') {
        if (m.played && m.final) {
          const [gf, ga] = s === 'home' ? m.final : [m.final[1], m.final[0]];
          cur.lp++; cur.lgf += gf; cur.lga += ga;
          if (gf > ga) cur.lw++; else if (gf < ga) cur.ll++; else cur.ld++;
        }
      } else if (m.played) {
        cur.koPlayed++;
        if (winnerOfMatch(m) === s) cur.koWon++;
      }
      runs.set(t.id, cur);
    }
  }
  // 走到哪一輪,以「有出賽的最後一個階段」為準
  for (const r of rounds) {
    for (const t of r.ties) {
      for (const team of t.teams) {
        if (team?.id == null) continue;
        const cur = runs.get(team.id);
        if (!cur) continue;
        const order = stageOrder.get(r.stage) ?? -1;
        if (order > cur.bestOrder) { cur.bestOrder = order; cur.best = r.zh; }
        if (t.winner !== null && t.winner !== team.id) {
          cur.out = r.zh;
          cur.outTo = t.teams.find(x => x.id !== team.id)?.name ?? null;
        }
      }
    }
  }
  /* 只打了聯賽階段就結束的,出局階段就是聯賽階段 —— 這件事要講出來,
     不然那一格是空的,讀者分不出「止步聯賽階段」與「資料沒抓到」。 */
  for (const r of runs.values()) {
    if (r.bestOrder < 0 && r.lp > 0 && !r.out) r.out = '聯賽階段';
  }
  /* 排序最後用 id 收尾 —— 兩個 build 各跑一次,輸出必須逐位元組相同(有測試守著)。
     只靠前三個鍵的話,同分的球隊順序會依 Map 插入順序而定,那不保證穩定。 */
  return [...runs.values()].sort((a, b) => b.bestOrder - a.bestOrder || b.koWon - a.koWon
    || (a.leaguePos ?? 99) - (b.leaguePos ?? 99) || a.id - b.id);
}

export function summariseSeason(raw, codeOfTeam, normalise) {
  const matches = raw.matches.map(m => normalise(m, codeOfTeam));
  const league = matches.filter(m => m.stage === 'LEAGUE_STAGE');
  const rounds = knockoutRounds(matches);
  const table = leaguePhaseTable(league, raw.standings);

  /* 每一隊聯賽階段的結局:直接進十六強 / 打附加賽 / 淘汰。
     **不用「第 1-8 名就是直接晉級」這條規則去推**,而是看他們實際上出現在哪裡 ——
     規則是我記得的,實際參賽名單是資料自己說的。賽制哪天改了,推的那份會靜靜錯掉。
     推出來之後再回頭檢查名次是不是連續的(1..8 / 9..24 / 25..36),
     不連續就代表有東西不對,畫面要講出來而不是照畫。 */
  const poIds = new Set(matches.filter(m => m.stage === 'PLAYOFFS').flatMap(m => [m.home.id, m.away.id]));
  const r16Ids = new Set(matches.filter(m => m.stage === 'LAST_16').flatMap(m => [m.home.id, m.away.id]));
  for (const r of table.rows) {
    r.outcome = poIds.has(r.id) ? 'playoff' : r16Ids.has(r.id) ? 'auto' : 'out';
  }
  const bandOrder = ['auto', 'playoff', 'out'];
  const bands = {};
  for (const b of bandOrder) {
    const pos = table.rows.filter(r => r.outcome === b).map(r => r.position).sort((x, y) => x - y);
    bands[b] = pos.length ? { from: pos[0], to: pos.at(-1), count: pos.length } : null;
  }
  // 連續性:每一段的名次要剛好是 from..to 之間的每一個,而且三段要接得起來
  const bandBroken = bandOrder.some((b, i) => {
    const v = bands[b];
    if (!v) return table.rows.length > 0 && b !== 'out';
    if (v.to - v.from + 1 !== v.count) return true;
    const prev = bands[bandOrder[i - 1]];
    return i > 0 && prev && v.from !== prev.to + 1;
  }) || (table.rows.length > 0 && bands.auto?.from !== 1);
  const unknownDurations = [...new Set(matches.map(m => m.unknownDuration).filter(Boolean))];
  return {
    label: raw.season,
    availability: raw.availability,
    message: raw.message ?? null,
    total: matches.length,
    played: matches.filter(m => m.played).length,
    teams: new Set(matches.flatMap(m => [m.home.id, m.away.id])).size,
    aet: matches.filter(m => m.aet === true).length,
    shootouts: matches.filter(m => m.pens).length,
    table, rounds, bands, bandBroken,
    leagueRounds: [...new Set(league.map(m => m.matchday).filter(Number.isFinite))].sort((a, b) => a - b),
    leagueMatches: league,
    champion: championOf(rounds),
    runs: runsByTeam(matches, rounds, table),
    advancementProblems: checkAdvancement(rounds),
    unknownDurations,
    unknownStatuses: [...new Set(matches.filter(m => !m.played).map(m => m.status).filter(Boolean))],
  };
}

/* 兩個聯賽的 build 都要產出同一份歐冠資料 —— 歐冠是跨聯賽的,
   英超頁與西甲頁看到的必須是同一份。所以載入與整理收在這裡,
   兩邊各呼叫一次;複製一份過去的話,改了一邊另一邊會悄悄過期。 */
/* 讀 FotMob 人工交付的那一季(如果有)。回傳 null 代表沒有這個檔。 */
async function readFotmob(root, label) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const f = join(root, 'data', 'manual', `fotmob-ucl-${label}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; }
}

/* 只有抽籤、還沒開賽的那一季。
   **只呈現「誰對誰、誰主誰客」** —— 上游的 144 場開球時間全部是同一個佔位值、
   輪次全是 null,所以日期與輪次我們沒有,不顯示也不猜(鐵則一與鐵則三)。 */
function summariseDraw(fm, codeOfTeam, check) {
  const teams = new Map();
  const touch = t => {
    if (!teams.has(t.id)) {
      const hit = codeOfTeam(t.id);
      teams.set(t.id, { id: t.id, name: t.shortName ?? t.name, fullName: t.name,
        code: hit?.code ?? null, league: hit?.league ?? null, home: [], away: [] });
    }
    return teams.get(t.id);
  };
  const matches = fm.matches.map(m => {
    const h = touch(m.home), a = touch(m.away);
    h.home.push({ id: a.id, name: a.name, code: a.code, league: a.league });
    a.away.push({ id: h.id, name: h.name, code: h.code, league: h.league });
    return { home: { id: h.id, name: h.name, code: h.code, league: h.league },
      away: { id: a.id, name: a.name, code: a.code, league: a.league } };
  });
  const rows = [...teams.values()].sort((x, y) =>
    (x.code ? 0 : 1) - (y.code ? 0 : 1) || String(x.name).localeCompare(String(y.name)));
  return { rows, matches, check };
}

export async function loadUclSeasons(root, sources) {
  const { readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const { normaliseUclMatch, buildUclTeamIndex } = await import('./adapters/football-data-ucl.mjs');

  const dir = join(root, 'data', 'raw', 'football-data');
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir)).filter(f => /^ucl-\d{4}-\d{2}\.json$/.test(f)).sort().reverse();
  if (!files.length) return null;

  const seasons = [];
  const conflicts = [];
  let retrievedAt = null;
  for (const f of files) {
    const raw = JSON.parse(await readFile(join(dir, f), 'utf8'));
    if (raw.retrievedAt && (!retrievedAt || raw.retrievedAt > retrievedAt)) retrievedAt = raw.retrievedAt;
    const fm = await readFotmob(root, raw.season);

    if (raw.availability !== 'available') {
      /* 拿不到也要出現在清單裡,而且要分得出是哪一種 ——
         「還沒建立」與「方案不給」對讀者是完全不同的兩句話(鐵則四)。 */
      /* football-data 沒有這一季,但 FotMob 有抽籤結果 ——
         那就把「誰對誰」端出來,而**不是**留一塊空白說「還沒有」。
         但只有這一個來源,沒得核對,所以先跑結構自洽檢查,
         而且畫面上要講明只有一個來源(鐵則四)。 */
      if (fm && Array.isArray(fm.matches) && fm.matches.length) {
        const c = checkDraw(fm.matches);
        const sane = drawIsSane(c);
        const idx = buildUclTeamIndex(fm.matches, sources);
        if (conflictsOf(idx)) conflicts.push({ season: raw.season, conflicts: idx.conflicts });
        const draw = summariseDraw(fm, idx.codeOfTeam, { ...c, sane });
        seasons.push({
          label: raw.season,
          availability: sane ? 'draw-only' : 'draw-unsound',
          message: raw.message ?? null,
          source: fm.source ?? 'FotMob', retrievedAt: fm.retrievedAt ?? null,
          singleSource: true,
          total: fm.matches.length, played: 0, teams: draw.rows.length,
          aet: 0, shootouts: 0,
          teamsKnown: idx.matched, teamsTotal: idx.total,
          table: { rows: [], order: 'none', mismatches: [] },
          rounds: [], leagueRounds: [], leagueMatches: [],
          champion: null, runs: [], advancementProblems: [],
          unknownDurations: [], unknownStatuses: [],
          bands: {}, bandBroken: false,
          draw,
        });
        continue;
      }
      seasons.push({
        label: raw.season, availability: raw.availability, message: raw.message ?? null,
        total: 0, played: 0, teams: 0, aet: 0, shootouts: 0,
        table: { rows: [], order: 'none', mismatches: [] }, rounds: [], leagueRounds: [], leagueMatches: [],
        champion: null, runs: [], advancementProblems: [], unknownDurations: [], unknownStatuses: [],
      });
      continue;
    }
    const idx = buildUclTeamIndex(raw.matches, sources);
    if (idx.conflicts.length) conflicts.push({ season: raw.season, conflicts: idx.conflicts });
    const s = summariseSeason(raw, idx.codeOfTeam, normaliseUclMatch);
    s.teamsKnown = idx.matched;
    s.teamsTotal = idx.total;

    /* **協作方交付的檔案要用獨立來源核對**(鐵則五)。
       這裡的獨立來源就是 football-data.org 那份 —— 完全不同的供應商。
       核對通過才採用 FotMob 的球員榜;沒通過就整份不用,並把問題留在資料裡
       讓畫面講出來,不要靜靜挑一個來顯示。 */
    if (fm && Array.isArray(fm.matches)) {
      const cc = crossCheck(fm.matches, raw.matches);
      s.crossCheck = {
        source: fm.source ?? 'FotMob', retrievedAt: fm.retrievedAt ?? null,
        teamsMatched: cc.teamsMatched, teamsTotal: cc.teamsTotal,
        aligned: cc.aligned, total: cc.total,
        problems: cc.problems.slice(0, 20), problemCount: cc.problems.length,
        passed: cc.problems.length === 0 && cc.aligned === cc.total,
      };
      if (s.crossCheck.passed && Array.isArray(fm.players) && fm.players.length) {
        s.leaders = buildLeaders(fm.players);
        s.leaderPool = fm.players.length;
        /* 逐隊陣容。走的是**同一份、同一道核對**的資料 ——
           球員榜本來就從這 879 人裡挑前幾名,只是以前沒有按隊分過。

           為什麼值得做:36 隊裡本站只認得 8~11 支,其餘 25 支在站上
           除了名字與隊徽之外什麼都沒有 —— 而他們的球員數據一直就在這個檔案裡。 */
        s.squads = squadsByTeam(fm.players, fm.playerStatCategories, root);
      }
    }
    seasons.push(s);
  }
  return {
    source: 'football-data.org',
    competition: 'UEFA Champions League',
    retrievedAt,
    teamCodeConflicts: conflicts,
    seasons,
  };
}

/* 歐冠頁要用的球隊名字與隊徽,**跨聯賽的一份**。
 *
 * 為什麼要獨立一份:歐冠頁兩邊看到的 ucl.json 是同一份(逐位元組相同),
 * 但畫面**不一樣** —— 名字與隊徽是從「目前這個聯賽的 clubs.json」查的,
 * 而兩份 clubs 的隊碼完全沒有交集(英超 27 支、西甲 29 支、重疊 0)。
 * 於是同一支球隊在英超頁叫 `Barça`(上游給的縮寫)、在西甲頁叫 `FC Barcelona`,
 * 隊徽也只有一半畫得出來。標題卻寫著「英超與西甲・共 11 支」——
 * 說了兩個聯賽都算,畫面上卻有一半看起來像外人。
 *
 * 所以把歐冠裡「本站認得的球隊」的名字與隊徽收成一份共用檔,
 * 兩個 build 各產一次、內容逐位元組相同(有測試守著)。
 *
 * **2026-08-28 起多一層:本站沒有的球隊也給隊徽,但仍然不給連結。**
 * 54 支歐冠球隊裡本站只認得 13 支,其餘 41 支原本連隊徽都沒有。
 * 現在 40 支有了(FotMob,人工交付並核對過),掛在 `external` 這一組,
 * key 是 **football-data 的 team id** —— 因為 ucl.json 裡的球隊只有那個 id。
 * fd id ↔ FotMob id 的對照落地在 `data/manual/ucl-team-ids.json`,
 * **不在這裡做隊名比對**:模糊比對會靜靜對錯球隊(盃賽頁踩過兩次)。
 *
 * **界線仍然在**:有隊徽不等於有球隊頁。本站沒有 Bayern 的資料,
 * 所以那一格是「隊徽 + 名字」,不是連結 —— 連到一個空頁比不連更糟(鐵則三)。
 * Paphos FC 是 FotMob 三季檔案裡都沒有的那一支,照舊只有名字。
 */
export async function uclTeamAssets(root, ucl) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const { loadTeams } = await import('./teams.mjs');

  /* 把整份 ucl 走一遍收 code,而不是列舉「走勢表、積分榜、淘汰賽、抽籤」四個地方 ——
     列舉的話,以後多一個區塊就會有一批球隊靜靜地少掉名字與隊徽。 */
  const codes = new Set();
  const walk = v => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    if (typeof v.code === 'string' && v.code) codes.add(v.code);
    for (const x of Object.values(v)) walk(x);
  };
  walk(ucl);

  const sources = [
    { league: 'pl', teams: 'teams.json', crests: 'crests.json' },
    { league: 'es1', teams: 'teams-la-liga.json', crests: 'crests-la-liga.json' },
  ];
  const rows = [];
  for (const src of sources) {
    const T = loadTeams(root, { file: src.teams });
    const cp = join(root, 'data', 'manual', src.crests);
    const crests = existsSync(cp) ? (JSON.parse(await readFile(cp, 'utf8')).crests ?? {}) : {};
    for (const t of T.list) {
      if (!codes.has(t.code)) continue;
      rows.push({
        code: t.code, league: src.league, en: t.en, zh: t.zh,
        colors: t.colors ?? null,
        crest: crests[t.code] ?? null,
      });
    }
  }
  // 排序固定,兩個 build 的輸出才會逐位元組相同
  rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  /* 本站認不得的球隊:只給名字與隊徽,不給連結。
     對照與隊徽各自一份檔案,這裡只負責接起來 —— 接不起來就不給,不猜。 */
  const external = [];
  const idPath = join(root, 'data', 'manual', 'ucl-team-ids.json');
  const crestPath = join(root, 'data', 'manual', 'crests-ucl.json');
  let externalUnmapped = 0;
  if (existsSync(idPath) && existsSync(crestPath)) {
    const map = JSON.parse(await readFile(idPath, 'utf8'));
    const crests = JSON.parse(await readFile(crestPath, 'utf8')).crests ?? {};
    externalUnmapped = (map.unmapped ?? []).length;
    for (const t of map.teams ?? []) {
      const crest = crests[String(t.fotmobId)] ?? null;
      if (!crest) continue;   // 對照有、圖沒抓到 → 當成沒有,不給半套
      external.push({ id: t.fdId, en: t.fdName, crest });
    }
    external.sort((a, b) => a.id - b.id);
  }

  return {
    note: '歐冠頁專用:本站兩個聯賽認得的球隊的名字與隊徽。跨聯賽一份,英超與西甲的內容相同。',
    codesInUcl: codes.size,
    known: rows.length,
    teams: rows,
    /* 認不得的球隊的隊徽,key 是 football-data 的 team id。
       有隊徽不代表有球隊頁 —— 前端只畫圖,不給連結。 */
    externalNote: '本站沒有這些球隊的資料,只有名字與隊徽(FotMob,人工交付並核對過)。有隊徽不等於有球隊頁,所以不給連結。',
    external,
    externalUnmapped,
  };
}
