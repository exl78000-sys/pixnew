/* Adapter:football-data.org 的歐冠 match → 本站 canonical 場次。
 *
 * ══ 這個檔案存在的理由,就是下面這一件事 ══
 *
 * **`score.fullTime` 在 PK 大戰的場次裡不是比分,是累加。**
 *
 * 2025-26 決賽 PSG vs Arsenal 的原始回傳:
 *
 *   { duration: "PENALTY_SHOOTOUT",
 *     fullTime:    { home: 5, away: 4 },     ← 1+0+4 與 1+0+3 的和
 *     regularTime: { home: 1, away: 1 },
 *     extraTime:   { home: 0, away: 0 },
 *     penalties:   { home: 4, away: 3 } }
 *
 * 直接印 fullTime 的話,決賽會顯示成「PSG 5-4 Arsenal」。
 * 實際上那場是 **1-1、PK 4-3**。那不是少一個欄位,是把冠軍講錯。
 *
 * 兩季 6 場非 REGULAR 的比賽逐場驗過:
 * **fullTime === regularTime + extraTime + penalties,6 場全部成立、0 場例外**;
 * 而且 REGULAR 的場次一律沒有 regularTime / extraTime / penalties 這三欄。
 * 所以規則是:
 *
 *   REGULAR            final = fullTime            (就是 90 分鐘比分)
 *   EXTRA_TIME         final = fullTime            (= regular + et,延長後的正確比分)
 *   PENALTY_SHOOTOUT   final = regular + et        ← **不是 fullTime**
 *
 * 沒見過的 duration 一律**不給比分**(final = null)並記進 unknownDurations
 * 由呼叫端報出來。寧可不顯示,也不要顯示一個可能是累加值的數字(鐵則一)。
 */

/* 已經在實際資料裡見過、而且知道語意的 duration。
   兩季 378 場只出現這三種(REGULAR 372、EXTRA_TIME 4、PENALTY_SHOOTOUT 2)。 */
export const KNOWN_DURATIONS = new Set(['REGULAR', 'EXTRA_TIME', 'PENALTY_SHOOTOUT']);

/* 階段。新賽制(2024-25 起)是「聯賽階段 + 附加賽 + 四輪淘汰賽」,
   沒有小組賽 —— 實際資料裡 group 欄位 189 場全是 null,所以不做分組。 */
export const KNOWN_STAGES = new Set([
  'LEAGUE_STAGE', 'PLAYOFFS', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL',
]);

export const STAGE_ZH = {
  LEAGUE_STAGE: '聯賽階段',
  PLAYOFFS: '附加賽',
  LAST_16: '十六強',
  QUARTER_FINALS: '八強',
  SEMI_FINALS: '四強',
  FINAL: '決賽',
};

// 淘汰賽的順序。用來判斷「晉級者有沒有出現在下一輪」這個核對
export const KO_ORDER = ['PLAYOFFS', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'];

const pair = o => (o && Number.isFinite(o.home) && Number.isFinite(o.away) ? [o.home, o.away] : null);
const add = (a, b) => (a && b ? [a[0] + b[0], a[1] + b[1]] : (a ?? b ?? null));

/* 隊名對照。歐冠一季只有 36 支歐洲一線球隊,不是盃賽那種 745 支從第九級打上來的
   母體 —— 所以這裡沿用 loadTeams 的寬鬆比對是安全的(FC Barcelona → BAR、
   Club Atlético de Madrid → ATM 這種靠的就是它)。
   但**多對一要擋下來**:兩支不同的歐冠球隊對到同一個隊碼,一定有一個是錯的,
   寧可兩個都不對應也不要對錯一個(盃賽的 AFC Liverpool 就是這樣差點上線)。 */
/* 兩種來源的欄位名不一樣:football-data 是 homeTeam / awayTeam,
   FotMob 是 home / away。**只認其中一種的話,另一種會安靜地得到「0 隊」** ——
   實際踩到:2026-27 的抽籤表 36 隊全部沒有隊碼,畫面上一個隊徽都沒有、
   本站球隊也沒有排到前面,而沒有任何地方報錯。兩種都收。 */
export function buildUclTeamIndex(matches, sources) {
  const teams = new Map();
  for (const m of matches) for (const t of [m.homeTeam ?? m.home, m.awayTeam ?? m.away]) {
    if (t?.id) teams.set(t.id, t);
  }
  const byId = new Map();
  const claimed = new Map();     // 隊碼 → [球隊 id](多對一代表對錯了,要整組退掉)
  for (const t of teams.values()) {
    /* 哪一個聯賽認得這一隊也要記下來。歐冠是跨聯賽的頁面:
       從英超頁看,皇馬有隊碼但**英超的資料集裡沒有它的隊徽**,
       C.team('RMA') 會退回一個灰方塊寫著 RMA —— 那看起來像壞掉。
       記住聯賽之後,連結可以指到對的那一邊,隊徽則只在認得的那一邊顯示。 */
    let code = null, league = null;
    for (const src of sources) {
      code = src.codeOf(t.name) || src.codeOf(t.shortName) || null;
      if (code) { league = src.league; break; }
    }
    if (!code) continue;
    byId.set(t.id, { code, league });
    if (!claimed.has(code)) claimed.set(code, []);
    claimed.get(code).push(t.id);
  }
  const conflicts = [];
  for (const [code, ids] of claimed) {
    if (ids.length < 2) continue;
    conflicts.push({ code, teams: ids.map(id => teams.get(id)?.name).filter(Boolean) });
    for (const id of ids) byId.delete(id);   // 有衝突就整組不對應
  }
  return { codeOfTeam: id => byId.get(id) ?? null, conflicts, total: teams.size, matched: byId.size };
}

export function normaliseUclMatch(m, codeOfTeam = () => null) {
  const s = m.score ?? {};
  const duration = s.duration ?? null;
  const known = duration !== null && KNOWN_DURATIONS.has(duration);
  const played = m.status === 'FINISHED';

  const ft = pair(s.fullTime);
  const rt = pair(s.regularTime);
  const et = pair(s.extraTime);
  const pens = pair(s.penalties);

  /* 這一場踢完的比分(含延長,不含 PK)。
     PK 場走 regular + et,因為 fullTime 在那裡是含 PK 的累加值。 */
  let final = null;
  if (played && known) {
    if (duration === 'PENALTY_SHOOTOUT') final = add(rt, et) ?? rt;
    else final = ft;
  }

  const side = t => {
    const hit = t?.id ? codeOfTeam(t.id) : null;
    return {
      id: t?.id ?? null,
      name: t?.shortName ?? t?.name ?? null,
      fullName: t?.name ?? null,
      code: hit?.code ?? null,
      // 哪一個聯賽認得它 —— 決定連結指到哪一邊,以及隊徽在哪一邊顯示得出來
      league: hit?.league ?? null,
    };
  };

  return {
    id: m.id,
    kickoff: m.utcDate ?? null,
    stage: m.stage ?? null,
    // 淘汰賽的 matchday 是**第幾回合**(1 或 2);聯賽階段是第幾輪;決賽是 null
    matchday: Number.isFinite(m.matchday) ? m.matchday : null,
    status: m.status ?? null,
    played,
    home: side(m.homeTeam),
    away: side(m.awayTeam),
    final,
    // 90 分鐘結束時的比分。只有打過延長才另外給 —— 沒打延長時它跟 final 一樣,印兩次只是噪音
    ft90: played && known && duration !== 'REGULAR' ? rt : null,
    et: played && known && duration !== 'REGULAR' ? et : null,
    pens: played && known && duration === 'PENALTY_SHOOTOUT' ? pens : null,
    // 未賽是 null,不是 false ——「沒打延長」與「還沒踢」是兩件事
    aet: played && known ? duration !== 'REGULAR' : null,
    halfTime: played ? pair(s.halfTime) : null,
    unknownDuration: played && !known ? (duration ?? '(沒有 duration)') : null,
  };
}

/* 誰贏了這一場。有 PK 就看 PK,否則看 final。
   平手且沒有 PK → null(兩回合制的第一回合本來就可能平手,不要硬判贏家)。 */
export function winnerOfMatch(m) {
  if (!m.played) return null;
  if (m.pens) return m.pens[0] === m.pens[1] ? null : (m.pens[0] > m.pens[1] ? 'home' : 'away');
  if (!m.final || m.final[0] === m.final[1]) return null;
  return m.final[0] > m.final[1] ? 'home' : 'away';
}
