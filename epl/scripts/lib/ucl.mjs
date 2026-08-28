/* 歐冠的計算層:把逐場資料整理成畫面要的形狀。
   只做「資料本來就有的整理」—— 分階段、配兩回合、算總比分、排積分榜。
   不推論、不補值、不預測(歐冠沒有經過驗收的模型,理由見下方 build 產出的 note)。 */

import { KO_ORDER, STAGE_ZH, winnerOfMatch } from './adapters/football-data-ucl.mjs';

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
export function runsByTeam(matches, rounds, table) {
  const runs = new Map();
  const posOf = new Map((table?.rows ?? []).map(r => [r.code, r.position]).filter(([c]) => c));
  const stageOrder = new Map(rounds.map((r, i) => [r.stage, i]));
  for (const m of matches) {
    for (const s of ['home', 'away']) {
      const t = m[s], code = t.code;
      if (!code) continue;
      /* bestOrder 從 -1 起跳,而聯賽階段不在 rounds 裡 ——
         只打聯賽階段就被淘汰的球隊(第 25-36 名)因此會停在 null。
         第一版就是這樣,畫面上 Girona 的「打到哪一輪」是空的,
         看起來像資料缺了,其實他們就是止步於聯賽階段。所以底線設在這裡。 */
      const cur = runs.get(code) ?? { code, league: t.league, name: t.name, leaguePos: posOf.get(code) ?? null,
        lp: 0, lw: 0, ld: 0, ll: 0, lgf: 0, lga: 0, koPlayed: 0, koWon: 0,
        best: '聯賽階段', bestOrder: -1, out: null, outTo: null };
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
      runs.set(code, cur);
    }
  }
  // 走到哪一輪,以「有出賽的最後一個階段」為準
  for (const r of rounds) {
    for (const t of r.ties) {
      for (const team of t.teams) {
        const code = team.code;
        if (!code) continue;
        const cur = runs.get(code);
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
  return [...runs.values()].sort((a, b) => b.bestOrder - a.bestOrder || b.koWon - a.koWon
    || (a.leaguePos ?? 99) - (b.leaguePos ?? 99));
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
    if (raw.availability !== 'available') {
      /* 拿不到也要出現在清單裡,而且要分得出是哪一種 ——
         「還沒建立」與「方案不給」對讀者是完全不同的兩句話(鐵則四)。 */
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
