// 傷停、停賽與拿牌 —— 「缺了多少戰力」。
//
// 先講清楚這一段的定位:**它沒有進預測模型,只是資訊**。
// 原因不是不想接,是接不了 —— 要證明傷停有沒有幫助,必須有「每一輪當下」的
// 傷停快照,才能走查回測。而我們手上的 FPL 名單是一份「現在」的快照,
// 歷史每一輪長什麼樣子沒有留下來。拿現在的傷兵名單去回測過去的比賽,
// 等於偷看未來,測出來的數字再漂亮也是假的。
//
// 所以這裡做兩件事:
//   1. 把「現在缺了多少」算清楚給人看(這是使用者要的資訊)。
//   2. 從今天起每次 build 都存一份快照(snapshot-availability.mjs),
//      累積到夠多輪之後,這個特徵就能跟近期狀況一樣走一次真正的回測。
//
// 「缺了多少戰力」怎麼定義:
//   用缺席球員在**參考賽季**吃掉的上場時間佔全隊的比例。
//   時間是最不會騙人的權重 —— 教練讓誰上場久,誰就是主力,不必自己發明評分。
//   另外再算一個 xGI(期望進球參與)版本,因為後衛缺陣與前鋒缺陣的意義不同。

// FPL 的 status:a=可出賽 d=有疑慮 i=傷停 s=停賽 u=不可用
const OUT = new Set(['i', 's']);
const DOUBT = 'd';
/* status='u' 幾乎都是「已經轉隊/外借走了」,不是傷停。
   把他算進「這場缺了多少戰力」會誤導兩次:一來他根本不在隊上了,
   二來他的位置早就有新援補上。所以離隊的人整個移出母體(分子分母都不算),
   另外用一行說明「上季有多少上場時間隨著離隊一起走了」—— 那才是它真正的意義。 */
const GONE = /join(ed)?|loan|returned|transfer|left|released/i;
const isGone = p => p.status === 'u' && GONE.test(p.news ?? '');

/* 英超累積黃牌停賽門檻:
     5 張黃牌,且在球隊第 19 場聯賽之前 → 停 1 場
    10 張黃牌,且在第 32 場之前          → 停 2 場
    15 張黃牌(整季)                     → 停 3 場
   過了那個場次門檻,該級距就不再適用 —— 所以要知道球隊踢了幾場。 */
const TIERS = [
  { yellow: 5, byMatch: 19, ban: 1 },
  { yellow: 10, byMatch: 32, ban: 2 },
  { yellow: 15, byMatch: 38, ban: 3 },
];

export function cardWatch(yellow, teamMatches) {
  for (const t of TIERS) {
    if (yellow >= t.yellow) continue;          // 這一級已經過了(或已經罰過了)
    if (teamMatches >= t.byMatch) continue;    // 場次門檻過了,這一級不再適用
    return { next: t.yellow, away: t.yellow - yellow, ban: t.ban, byMatch: t.byMatch };
  }
  return null;
}

/* 參考賽季的挑選:本季踢滿三輪之後就用本季(反映現在的輪替),
   還沒踢滿就用上季(本季樣本太少,一個替補踢滿一場就會變成「主力」)。 */
function pickBaseline(squad, teamMatches) {
  const curMin = squad.reduce((a, p) => a + (p.current?.minutes ?? 0), 0);
  return teamMatches >= 3 && curMin >= 11 * 90 * 3 ? 'current' : 'last';
}

export function teamAvailability(squad, { teamMatches = 0, topN = 6 } = {}) {
  const baseline = pickBaseline(squad, teamMatches);
  const statOf = p => p[baseline] ?? null;
  const minutesOf = p => statOf(p)?.minutes ?? 0;
  const threatOf = p => statOf(p)?.xGI ?? 0;

  const gone = squad.filter(isGone);
  const pool = squad.filter(p => !isGone(p));       // 現在還在隊上的人才算母體

  const totalMin = pool.reduce((a, p) => a + minutesOf(p), 0);
  const totalThreat = pool.reduce((a, p) => a + threatOf(p), 0);
  const share = (v, total) => (total > 0 ? v / total : 0);
  // 離隊的人要跟「他離開前所在的那支隊伍」比,所以分母含他自己
  const goneMin = gone.reduce((a, p) => a + minutesOf(p), 0);
  const goneThreat = gone.reduce((a, p) => a + threatOf(p), 0);

  const entry = p => ({
    code: p.code, name: p.name, pos: p.pos, status: p.status, statusZh: p.statusZh,
    news: p.news, chanceNext: p.chanceNext,
    minutes: minutesOf(p),
    minutesShare: share(minutesOf(p), totalMin),
    threatShare: share(threatOf(p), totalThreat),
    // 上季/本季的先發率,用來說明「這是不是主力」而不是我們自己判斷
    startRate: statOf(p)?.startRate ?? null,
  });

  // status='u' 但不是轉隊(FPL 偶爾會這樣標)仍算缺陣 —— 寧可算進來也不要漏掉
  const out = pool.filter(p => OUT.has(p.status) || p.status === 'u').map(entry)
    .sort((a, b) => b.minutesShare - a.minutesShare);
  const doubt = pool.filter(p => p.status === DOUBT).map(entry)
    .sort((a, b) => b.minutesShare - a.minutesShare);

  // 拿牌:黃牌數排序,並標出「再一張就停賽」的人
  const cards = pool.map(p => {
    const st = p.current ?? null;
    const y = st?.yellow ?? 0, r = st?.red ?? 0;
    return { code: p.code, name: p.name, pos: p.pos, yellow: y, red: r, watch: cardWatch(y, teamMatches) };
  }).filter(c => c.yellow > 0 || c.red > 0)
    .sort((a, b) => (b.yellow + b.red * 3) - (a.yellow + a.red * 3));

  const sum = (rows, key) => rows.reduce((a, x) => a + x[key], 0);
  return {
    baseline,                       // 'current' | 'last' —— 前端要標清楚是哪一季的比例
    teamMatches,
    squadSize: pool.length,
    // 沒有參考賽季資料的人(夏天剛簽的新援),他們的缺陣會被低估 —— 要據實標出來
    noBaseline: pool.filter(p => minutesOf(p) === 0).length,
    // 已經離隊的人:不算缺陣,但「戰力換血了多少」本身就是賽前該知道的事
    departed: {
      count: gone.length,
      minutes: share(goneMin, totalMin + goneMin),
      threat: share(goneThreat, totalThreat + goneThreat),
      names: gone.sort((a, b) => minutesOf(b) - minutesOf(a)).slice(0, topN).map(p => p.name),
    },
    out: out.slice(0, topN),
    doubt: doubt.slice(0, topN),
    outCount: out.length,
    doubtCount: doubt.length,
    missing: {
      minutes: sum(out, 'minutesShare'),
      threat: sum(out, 'threatShare'),
      // 有疑慮的人單獨算一份:他們可能上得了,不該跟確定缺陣的混在一起
      doubtMinutes: sum(doubt, 'minutesShare'),
      doubtThreat: sum(doubt, 'threatShare'),
    },
    cards: cards.slice(0, topN),
    cardTotals: {
      yellow: cards.reduce((a, c) => a + c.yellow, 0),
      red: cards.reduce((a, c) => a + c.red, 0),
      onWatch: cards.filter(c => c.watch && c.watch.away === 1).length,
    },
  };
}
