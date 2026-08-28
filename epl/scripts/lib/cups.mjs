/* 盃賽的計算層:把抓回來的逐場資料整理成畫面要的形狀。
   這裡只做「資料本來就有的整理」—— 分輪、排序、算晉級路徑。
   不推論、不補值、不預測(盃賽沒有經過驗收的模型,見 docs/補齊規劃.md)。 */

/* 輪次排序。SportMonks 的 stage 名稱沒有固定的數字順序,
   而且不同盃賽用詞不一樣(Round of 16 / 半準決賽 / Final)。
   **不要維護一張名稱→序號的對照表** —— 上游改個字就會全錯,
   而且錯法是安靜的(決賽排到第一輪去)。
   改成用「該輪最早的開球時間」排 —— 盃賽本來就是照時間一輪一輪打的,
   這個順序是資料自己帶的,不是我們定義的。 */
export function groupByStage(matches) {
  const byStage = new Map();
  for (const m of matches) {
    const key = m.stage ?? '未分輪';
    if (!byStage.has(key)) byStage.set(key, []);
    byStage.get(key).push(m);
  }
  const rounds = [...byStage].map(([stage, list]) => {
    const times = list.map(m => m.kickoff).filter(Boolean).sort();
    return {
      stage,
      firstKickoff: times[0] ?? null,
      lastKickoff: times.at(-1) ?? null,
      matches: list.slice().sort((a, b) => String(a.kickoff ?? '').localeCompare(String(b.kickoff ?? ''))),
      total: list.length,
      played: list.filter(m => m.played).length,
      aet: list.filter(m => m.aet === true).length,
      shootouts: list.filter(m => m.pens).length,
      /* 這一輪有沒有本站認得的球隊。足總盃從第九級一路打上來 ——
         2025-26 整季 871 場、745 支球隊,英超球隊要到第三輪才進場。
         全部平鋪的話,讀者要滑過幾百場沒聽過的球隊才看得到第一場英超比賽。
         所以標記出來,讓畫面預設從「有認得的球隊」那一輪開始。
         **資格賽不刪掉** —— 那是真實發生過的比賽,只是預設收起來。 */
      hasKnown: list.some(m => m.home?.code || m.away?.code),
    };
  });
  // 沒有開球時間的排最後 —— 它們多半是還沒抽籤的場次
  rounds.sort((a, b) => {
    if (!a.firstKickoff) return 1;
    if (!b.firstKickoff) return -1;
    return a.firstKickoff.localeCompare(b.firstKickoff);
  });
  return rounds;
}

/* 誰贏了這一場。順序很重要:
   有 PK 就看 PK,否則看最終比分(已含延長)。平手且沒有 PK → null(還沒分出勝負,
   例如兩回合制的第一回合),不要硬判一個贏家。 */
export function winnerOf(m) {
  if (!m.played) return null;
  if (m.pens) {
    if (m.pens[0] === m.pens[1]) return null;
    return m.pens[0] > m.pens[1] ? 'home' : 'away';
  }
  if (!m.final) return null;
  if (m.final[0] === m.final[1]) return null;
  return m.final[0] > m.final[1] ? 'home' : 'away';
}

/* 每支球隊在這一季走到哪一輪。
   只算「有隊碼的球隊」—— 也就是本站認得的英超球隊;
   認不得的球隊照樣出現在賽程裡,但不進這張表(不編一個假的身分)。 */
export function runsByTeam(rounds) {
  const runs = new Map();
  rounds.forEach((round, order) => {
    for (const m of round.matches) {
      for (const side of ['home', 'away']) {
        const code = m[side]?.code;
        if (!code) continue;
        const cur = runs.get(code) ?? {
          code, played: 0, wins: 0,
          lastPlayedStage: null, lastPlayedOrder: -1,
          out: null, outTo: null, nextStage: null, nextKickoff: null, nextOpp: null,
        };
        const opp = m[side === 'home' ? 'away' : 'home'];

        /* 已賽與未賽要分開算。第一版把兩者混在「場次」裡,結果利物浦
           一場還沒踢的第三輪比賽被顯示成「1 場 0 勝」——
           讀者會以為他們踢過而且沒贏。**未賽不是 0 勝,是還沒發生。** */
        if (!m.played) {
          if (!cur.nextKickoff || String(m.kickoff ?? '') < cur.nextKickoff) {
            cur.nextStage = round.stage;
            cur.nextKickoff = m.kickoff ?? null;
            cur.nextOpp = opp?.name ?? null;
          }
          runs.set(code, cur);
          continue;
        }

        cur.played++;
        const w = winnerOf(m);
        if (w === side) cur.wins++;
        if (order > cur.lastPlayedOrder) { cur.lastPlayedOrder = order; cur.lastPlayedStage = round.stage; }
        // 輸掉就是出局(單場淘汰)。兩回合制這裡會失準,所以只在分得出勝負時記
        if (w && w !== side) { cur.out = round.stage; cur.outTo = opp?.name ?? null; }
        runs.set(code, cur);
      }
    }
  });
  // 走得越遠排越前面;同輪次的看贏了幾場
  return [...runs.values()].sort((a, b) => b.lastPlayedOrder - a.lastPlayedOrder || b.wins - a.wins);
}

export function championOf(rounds) {
  const last = rounds.at(-1);
  if (!last || last.matches.length !== 1) return null;
  const m = last.matches[0];
  const w = winnerOf(m);
  if (!w) return null;
  return { stage: last.stage, team: m[w], runnerUp: m[w === 'home' ? 'away' : 'home'], match: m };
}

export function summariseSeason(season) {
  const rounds = groupByStage(season.matches ?? []);
  /* 第一個有本站球隊的輪次。
     **findIndex 找不到時回的是 -1,不是 0** —— 原本的註解寫「找不到就給 0」,
     而下面的 `firstKnown > 0 ? … : 0` 把 -1 也當成 0,於是
     「整季都還沒有本站球隊」被當成「第一輪就有本站球隊」:
     資格賽既不會被收起來,也不會有說明。實際後果是足總盃 2026-27
     一進盃賽頁就是 **533 場第九級資格賽**攤在眼前,而且沒有任何提示。
     這一季目前確實整季都是資格賽,所以要把整季都算成資格賽。 */
  const firstKnown = rounds.findIndex(r => r.hasKnown);
  const noKnownYet = firstKnown < 0 && rounds.length > 0;
  return {
    firstKnownRound: firstKnown,
    // 本站球隊還沒進場的話,目前打過的每一輪都是資格賽
    noKnownYet,
    qualifyingRounds: noKnownYet ? rounds.length : (firstKnown > 0 ? firstKnown : 0),
    qualifyingMatches: noKnownYet
      ? rounds.reduce((a, r) => a + r.total, 0)
      : (firstKnown > 0 ? rounds.slice(0, firstKnown).reduce((a, r) => a + r.total, 0) : 0),
    label: season.label,
    seasonId: season.seasonId,
    current: season.current === true,
    finished: season.finished ?? null,
    total: (season.matches ?? []).length,
    played: (season.matches ?? []).filter(m => m.played).length,
    aet: (season.matches ?? []).filter(m => m.aet === true).length,
    shootouts: (season.matches ?? []).filter(m => m.pens).length,
    // 涵蓋率要標:一百多支球隊裡本站只認得英超那 20 支
    teamsTotal: new Set((season.matches ?? []).flatMap(m => [m.home?.name, m.away?.name]).filter(Boolean)).size,
    teamsKnown: new Set((season.matches ?? []).flatMap(m => [m.home?.code, m.away?.code]).filter(Boolean)).size,
    rounds,
    runs: runsByTeam(rounds),
    champion: championOf(rounds),
    unknownDescriptions: season.unknownDescriptions ?? [],
    unknownStates: season.unknownStates ?? [],
    nearMisses: season.nearMisses ?? [],
    aetCheck: season.aetCheck ?? null,
  };
}
