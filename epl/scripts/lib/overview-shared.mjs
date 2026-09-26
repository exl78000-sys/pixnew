/* 總覽的跨聯賽摘要 overview-shared.json(2026-09-26,A4b)。

   A4 之後總覽剩下的 2 MB 是跨聯賽那幾份整載:ucl.json 675 KB、intl.json 309 KB、cups.json 237 KB
   (英超 teams.json 385 KB 是 B1 的預載腳本抓的,總覽根本沒讀它 —— 那一份在 stamp-assets 改成依頁面預載)。
   這一頁用到的只有各自的一小部分:
   - 盃賽:本季**還沒踢**的場次(即將到來 + 窗外的下一批)、每季的 total(合計場數)、crests 查表、時效與 feed 網址。
     比分覆蓋(core.js 的 applyCupsLive)照 id 對,所以進行中的也留著;踢完的不在這一頁上。
   - 歐冠:每季的 label / availability(「哪幾季完整」那一句)、本季還沒踢的場次、輪次中文(rounds[].zh)。
     淘汰賽的 legs 跟聯賽階段一起收(C.uclSeasonMatches 兩邊都走)。
   - 歐冠球隊:只要隊碼 → 隊徽、外部 id → 隊徽。歐冠勝率:只要 model 的三個數字與未賽場數。
   - 國家隊:賽事表、家族、模型三個數字、隊名對照(只留中文)、還沒踢的場次(intl.json 的 fixtures 本來就只有未賽)。
   - 球會名冊(盃賽身分)**不在這裡**:那是 core.js 的 cupClubs 讀 clubs.json(圖外置後只剩 7 KB),三頁共用同一條路,不抄第二份。

   形狀跟原本的產物**同名同層**(cups.cups[].seasons[].rounds[].matches[]、ucl.seasons[].leagueMatches[]…),
   page-overview.js 讀的那些程式一個字不用改;少的只有它沒讀的欄位。
   一樣從**寫出去的產物**抽:build-overview-shared.mjs 排在 npm run build 的 build-intl 之後,讀 web/data 那幾份。
   要在總覽多畫一個跨聯賽的欄位,先來這裡加。 */

const side = s => (s ? { name: s.name ?? null, code: s.code ?? null, sourceId: s.sourceId ?? null } : null);
const uclSide = s => (s ? { id: s.id ?? null, name: s.name ?? null, code: s.code ?? null } : null);
const intlSide = s => {
  if (!s) return null;
  const o = {};
  for (const k of ['key', 'name', 'tbd', 'label']) if (s[k] != null) o[k] = s[k];
  return o;
};
// 沒踢完的都留(含進行中):總覽只列還沒踢的;踢完的場次這一頁沒有任何地方畫
const pending = m => !m.played || m.state === 'LIVE' || m.status === 'IN_PLAY' || m.status === 'PAUSED';

const cupMatch = m => ({
  id: m.id, stage: m.stage ?? null, kickoff: m.kickoff ?? null, played: !!m.played, state: m.state ?? null,
  liveScore: Array.isArray(m.liveScore) ? m.liveScore : null, home: side(m.home), away: side(m.away),
});
const uclMatch = m => ({
  id: m.id ?? null, kickoff: m.kickoff ?? null, stage: m.stage ?? null, matchday: m.matchday ?? null,
  played: !!m.played, home: uclSide(m.home), away: uclSide(m.away),
});

export function overviewSharedFrom({ cups = null, ucl = null, uclTeams = null, uclElo = null, intl = null }) {
  if (!cups && !ucl && !intl) throw new Error('overviewSharedFrom:cups / ucl / intl 一份都沒有 —— 要排在 build.mjs 與 build-intl 之後');
  return {
    cups: cups ? {
      builtAt: cups.builtAt ?? null, retrievedAt: cups.retrievedAt ?? null, source: cups.source ?? null,
      liveFeed: cups.liveFeed ?? null, crests: cups.crests ?? {},
      cups: (cups.cups ?? []).map(c => ({
        key: c.key, zh: c.zh ?? null, en: c.en ?? null,
        seasons: (c.seasons ?? []).map(s => ({
          label: s.label ?? null, current: !!s.current, total: s.total ?? 0,
          rounds: s.current
            ? (s.rounds ?? []).map(r => ({ stage: r.stage ?? null, matches: (r.matches ?? []).filter(pending).map(cupMatch) }))
              .filter(r => r.matches.length)
            : [],
        })),
      })),
    } : null,
    ucl: ucl ? {
      seasons: (ucl.seasons ?? []).map(s => ({
        label: s.label ?? null, availability: s.availability ?? null, current: !!s.current,
        rounds: (s.rounds ?? []).map(r => ({
          stage: r.stage ?? null, zh: r.zh ?? null,
          ties: s.current ? (r.ties ?? []).map(t => ({ legs: (t.legs ?? []).filter(pending).map(uclMatch) })).filter(t => t.legs.length) : [],
        })),
        leagueMatches: s.current ? (s.leagueMatches ?? []).filter(pending).map(uclMatch) : [],
      })),
    } : null,
    uclTeams: uclTeams ? {
      teams: (uclTeams.teams ?? []).map(t => ({ code: t.code, crest: t.crest ?? null })),
      external: (uclTeams.external ?? []).map(t => ({ id: t.id, crest: t.crest ?? null })),
    } : null,
    uclElo: uclElo ? {
      model: { passes: !!uclElo.model?.passes, improvement: uclElo.model?.improvement ?? null, se: uclElo.model?.se ?? null },
      fixtures: (uclElo.fixtures ?? []).map(f => ({ id: f.id ?? null })),
    } : null,
    intl: intl ? {
      builtAt: intl.builtAt ?? null,
      comps: (intl.comps ?? []).map(c => ({ key: c.key, zh: c.zh ?? null, short: c.short ?? null, family: c.family ?? null, status: c.status ?? null })),
      families: (intl.families ?? []).map(f => ({ key: f.key, zh: f.zh ?? null })),
      model: {
        passed: !!intl.model?.passed,
        holdout: intl.model?.holdout ? { gain: intl.model.holdout.gain ?? null, se: intl.model.holdout.se ?? null } : null,
        ratingsAsOf: intl.model?.ratingsAsOf ?? null,
      },
      teams: Object.fromEntries(Object.entries(intl.teams ?? {}).map(([k, t]) => [k, { zh: t?.zh ?? null }])),
      /* 一場只留總覽會讀的:賽事 / 開球 / 狀態 / 輪次與分組中文 / 兩邊(C.intlSideName 吃 key、沒 key 時吃 name、
         還沒決定的參與者吃 tbd + label)/ 有沒有勝率。400 場是這一份最大的一塊,所以 null 的欄位不寫。 */
      fixtures: (intl.fixtures ?? []).map(f => ({
        comp: f.comp ?? null, kickoff: f.kickoff ?? null, state: f.state ?? null,
        roundZh: f.roundZh ?? null, groupZh: f.groupZh ?? null,
        home: intlSide(f.home), away: intlSide(f.away),
        prob: Array.isArray(f.prob) ? f.prob : null,
      })),
    } : null,
  };
}

/* 摘要跟來源對得上的那幾個數字(build 印、npm test 守) */
export function overviewSharedCounts(o) {
  const cupPending = (o.cups?.cups ?? []).reduce((n, c) => n + (c.seasons ?? []).reduce((m, s) =>
    m + (s.rounds ?? []).reduce((k, r) => k + (r.matches ?? []).length, 0), 0), 0);
  const uclPending = (o.ucl?.seasons ?? []).reduce((n, s) => n + (s.leagueMatches ?? []).length
    + (s.rounds ?? []).reduce((m, r) => m + (r.ties ?? []).reduce((k, t) => k + (t.legs ?? []).length, 0), 0), 0);
  return { cupPending, uclPending, intlFixtures: (o.intl?.fixtures ?? []).length };
}
