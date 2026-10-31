// 逐場進球明細 → 球隊頁要的四種切面。
//
// 能回答的:這一季對每一隊進了幾球/被進幾球、誰進的、誰助攻、先發還是替補進的。
// 這個逐球資料不能把某一球分成運動戰/角球/任意球,所以不留個人級欄位。
// 球隊整季的進球情境另由 Understat 快取進入 tactics.json,不在這裡重複聚合。
import { round } from './util.mjs';
import { lineupRole } from './lineup-role.mjs';

/* 一支球隊在一個賽季的進球剖面。
   records 已經過 adapter 修正與比分核對,這裡只做彙總,不再驗證。 */
/* fullAppearances:records 是不是「這一隊每一場出場都有一列」(含沒有進球也沒有助攻的那幾場)。
   2026-10-31 之前沒有這個選項,上場分鐘一律從 records 加 —— 而英超的來源(FPL 逐輪鏡像)與早期的 FotMob 人工明細
   **只收有進球或助攻的列**,於是「上場分鐘」其實是「有進球或助攻那幾場的分鐘」:Haaland 2024-25 印 1,574 分 / 18 場,
   每 90 分進球 1.26(那一季他踢的不只那 18 場)。每 90 分被系統性高估,而畫面寫著「分母是上場分鐘」。
   現在只有呼叫端明講是完整出場紀錄時才給分鐘(與每 90 分),其餘一律 null(鐵則一:不是那個意思的數字不印)。 */
export function teamGoals(records, code, { fullAppearances = false } = {}) {
  const mine = records.filter(r => r.team === code);
  const theirs = records.filter(r => r.opp === code);

  // 對手分佈:對每一隊進幾球、被進幾球
  const vs = new Map();
  const bump = (opp, key, n) => {
    if (!n) return;
    if (!vs.has(opp)) vs.set(opp, { f: 0, a: 0 });
    vs.get(opp)[key] += n;
  };
  for (const r of mine) {
    bump(r.opp, 'f', r.g);       // 我方球員進球
    bump(r.opp, 'a', r.og);      // 我方球員的烏龍球 = 對手得分
  }
  for (const r of theirs) {
    bump(r.team, 'a', r.g);      // 對手球員進球
    bump(r.team, 'f', r.og);     // 對手球員的烏龍球 = 我方得分
  }

  /* 進球榜與助攻榜。
     有些來源(逐球事件)只有「誰進的」,沒有上場分鐘、也沒有先發/替補。
     那兩欄要標 null 而不是 0 —— `p.min += null` 會靜靜變成 0,
     畫面上就成了「這名球員上場 0 分鐘卻進了球」;
     `if (r.start)` 則會把 null 判成替補,把整季的球全掛到板凳頭上。
     兩者都是編出來的數字,鐵則一不准。 */
  const hasStart = mine.some(r => r.start != null);
  const hasMin = fullAppearances && mine.some(r => r.min != null);
  const byPlayer = new Map();
  for (const r of mine) {
    if (r.code == null) continue;   // 只有烏龍球的列(沒有可以掛的人)
    if (!byPlayer.has(r.code)) byPlayer.set(r.code, { code: r.code, g: 0, a: 0, startG: 0, subG: 0, min: 0, games: 0 });
    const p = byPlayer.get(r.code);
    p.g += r.g; p.a += r.a; p.min += r.min ?? 0; p.games++;
    if (r.start != null) { if (r.start) p.startG += r.g; else p.subG += r.g; }
  }
  /* 進球榜只列有進球或助攻的人;分鐘與場次是**他這一季替這一隊的全部出場**(fullAppearances 時),
     不是只有進球那幾場 —— 所以先全部加完再篩 */
  for (const [k, p] of byPlayer) if (!p.g && !p.a) byPlayer.delete(k);
  for (const p of byPlayer.values()) {
    if (!hasStart) { p.startG = null; p.subG = null; }
    if (!hasMin) { p.min = null; p.games = fullAppearances ? p.games : null; }
  }

  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  const goalsFor = sum(mine, 'g') + sum(theirs, 'og');
  const goalsAgainst = sum(theirs, 'g') + sum(mine, 'og');

  return {
    for: goalsFor, against: goalsAgainst,
    // 烏龍球分開列 —— 「這隊進了幾球」跟「有幾球是對手送的」是兩件事
    ownFor: sum(theirs, 'og'), ownAgainst: sum(mine, 'og'),
    starterGoals: hasStart ? sum(mine.filter(r => r.start === true), 'g') : null,
    subGoals: hasStart ? sum(mine.filter(r => r.start === false), 'g') : null,
    startKnown: hasStart, minKnown: hasMin,
    assists: sum(mine, 'a'),
    vs: [...vs].map(([opp, x]) => ({ opp, ...x })).sort((a, b) => b.f - a.f || a.a - b.a),
    players: [...byPlayer.values()].sort((a, b) => b.g - a.g || b.a - a.a),
  };
}

/* 全聯盟的替補進球佔比 —— 一支球隊高不高,要有比較基準才知道。 */
export function subShare(records) {
  // 沒有 start 欄位的來源算不出這個比例。回 null,不要回 0 ——
  // 0 的意思是「沒有替補進球」,那是另一件事。
  if (!records.some(r => r.start != null)) return null;
  const g = records.reduce((a, r) => a + r.g, 0);
  const sub = records.filter(r => r.start === false).reduce((a, r) => a + r.g, 0);
  return g ? round(sub / g, 4) : 0;
}

/* 給前端的完整資料集。每一季一份,球隊頁自己挑要看哪一季。 */
/* matchKeys:這一季的逐球明細**涵蓋哪幾場**(主隊|客隊)。
   非記不可,因為明細只收核對通過的場次,而賽程會先一步拿到新的賽果 ——
   兩邊涵蓋的比賽不同時,整季總和本來就不會一樣。
   沒有這份清單的話,「逐隊進失球對回賽果」那條斷言會在每次有新賽果、
   而人工交付的明細還沒跟上時變紅,看起來像資料錯了,其實只是涵蓋範圍不同。
   有了它,核對就限定在同一批比賽上,而且畫面也講得出涵蓋率(鐵則四)。 */
export function buildGoals(bySeason, { nameOf, codes, matchKeys = {}, fullAppearances = {} }) {
  const seasons = {};
  for (const [season, records] of Object.entries(bySeason)) {
    const teams = {};
    const full = fullAppearances[season] === true;
    for (const code of codes) {
      const t = teamGoals(records, code, { fullAppearances: full });
      if (!t.for && !t.against) continue;      // 那一季不在英超的球隊直接跳過
      teams[code] = {
        ...t,
        players: t.players.slice(0, 12).map(p => ({
          ...p,
          name: nameOf(p.code),
          // per-90 的分母是上場分鐘。出場太少的不給這個數字 ——
          // 替補上場 10 分鐘進 1 球換算成每 90 分鐘 9 球,那是誤導不是資訊。
          g90: p.min != null && p.min >= 450 ? round((p.g / p.min) * 90, 2) : null,
          a90: p.min != null && p.min >= 450 ? round((p.a / p.min) * 90, 2) : null,
        })),
      };
    }
    /* 有些來源沒有「先發還是替補」這個欄位(例如逐球事件),那一季就算不出
       替補進球佔比。**不能讓 falsy 的 start 靜靜變成「全部都是替補進的」** ——
       filter(r => !r.start) 會把 null 當成替補,結果 subShare 變成 1、
       starterGoals 變成 0,畫面上就是「這隊 100% 的球都是替補進的」,
       那是編出來的。整季都沒有 start 就一律標 null。 */
    const hasStart = records.some(r => r.start != null);
    const hasMin = full && records.some(r => r.min != null);
    for (const t of Object.values(teams)) {
      if (!hasStart) { t.starterGoals = null; t.subGoals = null; }
    }
    seasons[season] = {
      teams,
      subShare: hasStart ? subShare(records) : null,
      startKnown: hasStart,
      minKnown: hasMin,
      fullAppearances: full,
      goals: records.reduce((a, r) => a + r.g, 0),
      // null = 這一季的來源沒有回報涵蓋哪幾場(往季走 openfootball,整季都有)
      matchKeys: matchKeys[season] ?? null,
    };
  }
  return seasons;
}

/* FotMob 逐場逐人統計 → buildGoals 要的列(2026-10-31,西甲先用)。每一場**每一位上場的人**一列(含沒進球的),
   所以分鐘與先發 / 替補是完整出場紀錄(fullAppearances)。
   每一場先核對:該隊球員進球 + 對手烏龍球 = 比分,對不上的整場不收(跟英冠球員層同一條,lib/season-players.mjs)。
   烏龍球判定只看事件的 ownGoal / 'Own Goal' 旗標。**逐場統計裡事件的 team 是踢進自家門的那一隊**(沒有翻成得分方 ——
   翻轉是 toCanonicalDetail 做的,那是賽後報告那條路),所以 t 的烏龍球得分 = 對手隊名下的烏龍球事件,跟 aggregatePlayers 同一個寫法。
   第一版照「已翻過」寫,西甲兩季 32 場對不回比分,全是烏龍球那一顆記反了。
   matches:loadFotmobMatchStats 的 matches(同一季);回傳 { rows, matchKeys, excluded, ownGoals }。 */
export function goalRowsFromMatchStats(matches) {
  const rows = [], matchKeys = [], excluded = [];
  let ownGoals = 0;
  for (const m of matches) {
    const { home: h, away: a, players, events = [], score } = m;
    const key = `${h}|${a}`;
    if (!players || !Object.values(players).some(l => l?.length)) { excluded.push({ key, reason: '這一場沒有逐人統計' }); continue; }
    if (!score) { excluded.push({ key, reason: '沒有比分' }); continue; }
    const isOwn = e => e.type === 'Goal' && (e.ownGoal || e.detail === 'Own Goal');
    const pg = t => (players[t] ?? []).reduce((s, p) => s + (p.goals?.total ?? 0), 0);
    const og = t => events.filter(e => isOwn(e) && String(e.team) !== String(t)).length;   // t 因為對手的烏龍球得的分
    const got = [pg(h) + og(h), pg(a) + og(a)];
    if (got[0] !== score[0] || got[1] !== score[1]) { excluded.push({ key, reason: `球員進球 ${got.join(':')} 對不回比分 ${score.join(':')}` }); continue; }
    matchKeys.push(key);
    for (const [t, opp] of [[h, a], [a, h]]) {
      /* 先發 / 替補看正式名單(lib/lineup-role.mjs,逐場紀錄的「↑ 替補上場」走同一支) */
      const lu = m.lineups?.[t];
      const startOf = p => lineupRole(lu, p);
      for (const p of players[t] ?? []) {
        if (!(p.minutes > 0)) continue;
        rows.push({ team: t, opp, code: p.providerId != null ? String(p.providerId) : null, name: p.name,
          g: p.goals?.total ?? 0, a: p.goals?.assists ?? 0, og: 0, min: p.minutes, start: startOf(p) });
      }
      /* t 的球員踢進自家門的球:記在 t 的 og(掛不到人 —— code null,teamGoals 只拿它算進失球) */
      const n = og(opp);
      if (n) { rows.push({ team: t, opp, code: null, name: null, g: 0, a: 0, og: n, min: null, start: null }); ownGoals += n; }
    }
  }
  return { rows, matchKeys, excluded, ownGoals };
}

/* FotMob 球員 id → 本站(FPL)的球員代碼(2026-10-31,英超本季進球表改用 FotMob 逐場統計時)。
 *
 * 只用來決定**頭貼與名字跟哪個人走**,所以寧可對不上也不能對錯:先用姓名在同一隊的名冊裡找(全名、再試簡稱),
 * 再拿 FPL 自己的本季累計當獨立核對 —— 進球相等、先發相等、上場分鐘差不超過 `tol`。三個都對才採用,
 * 一個 FotMob id 對到兩個代碼、或兩個 id 對到同一個代碼的都不採用。對不上的人回 null,呼叫端保留 FotMob 的身分
 * (加前綴,FotMob id 與 FPL 代碼都是六、七位數,不加會撞)。
 * 季中轉隊的人 FPL 累計含前東家的,核對一定不過 —— 那是對的結果(拿不準是誰就不認)。
 * tol 10 分鐘是量過的:2026-10-31 本機 456 人 × 隊,差 ≤ 5 分鐘 340 人、≤ 10 分鐘 349 人、≤ 20 分鐘 351 人。 */
/* `pending`:隊碼 → 這一隊已踢完、但 FotMob 還沒有的場數(比賽日 FPL 累計常常快幾場)。兩邊不是同一批時不能要求相等 ——
   那幾場最多讓 FPL 多出:先發 k 場、分鐘 k × (90 + tol)、進球不會變少。k = 0 時就是相等(2026-10-31:比賽日 85 場對 80 場,
   要求相等的話接上的人從 349 掉到 228,掉的全是那幾場還沒進 FotMob 的隊)。 */
export function verifiedCodeMap(rows, roster, { tol = 10, matchOne, nameOf = c => c.name, pending = {} } = {}) {
  const agg = new Map();
  for (const r of rows) {
    if (r.code == null) continue;
    const k = `${r.team}|${r.code}`;
    const a = agg.get(k) ?? { team: r.team, fid: r.code, name: r.name, g: 0, min: 0, starts: 0 };
    a.g += r.g; a.min += r.min ?? 0; if (r.start === true) a.starts++;
    agg.set(k, a);
  }
  const cand = new Map(), why = {};
  for (const [k, a] of agg) {
    const pool = roster.filter(p => p.team === a.team);
    const p = matchOne(pool, a.name) ?? matchOne(pool, a.name, { nameOf });
    const c = p?.current ?? null;
    const lag = pending[a.team] ?? 0;
    const inRange = (fpl, fm, perGame) => fpl - fm >= -tol && fpl - fm <= lag * perGame + tol;
    const fail = !p ? 'nomatch' : !c ? 'nototal'
      : (lag ? (c.goals ?? 0) < a.g : (c.goals ?? 0) !== a.g) ? 'goals'
      : (lag ? !((c.starts ?? 0) >= a.starts && (c.starts ?? 0) <= a.starts + lag) : (c.starts ?? 0) !== a.starts) ? 'starts'
      : !inRange(c.minutes ?? 0, a.min, 90) ? 'minutes' : null;
    if (fail) { why[fail] = (why[fail] ?? 0) + 1; continue; }
    cand.set(k, String(p.code));
  }
  const byCode = new Map();
  for (const [k, code] of cand) byCode.set(code, [...(byCode.get(code) ?? []), k]);
  const out = new Map();
  for (const [code, ks] of byCode) if (ks.length === 1) out.set(ks[0], code); else why.shared = (why.shared ?? 0) + ks.length;
  return { map: out, total: agg.size, why };
}
