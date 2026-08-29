/* 即時機率的校準量測 —— **只量,不改模型**(鐵則二:改要先有證據,這裡就是在攢證據)。
 *
 * 動機:2026-08-29 實測同一時刻本站對落後方給 54~58% 勝率、Google(Sportradar)給 38%,
 * 差距很大,但單點觀察分不出誰對。這支把 live-history 的勝率曲線對上最終結果,
 * 算出可檢驗的數字,樣本隨每個比賽日自動累積。
 *
 * 方法上的三個決定:
 * - **Brier 分數(三元)**,對照組是「賽前機率凍結不動」—— 即時更新要是連
 *   凍結的賽前機率都贏不了,那它就是在幫倒忙。
 * - **點會同場相關**:一場比賽貢獻幾十個點,它們不是獨立樣本。
 *   所以場數與點數分開報,結論門檻看**場數**(minMatches)。
 * - **第 0 分的賽前錨點與 90+ 的收斂點都不算**:前者不是即時判斷、
 *   後者是抄答案(完賽時勝方機率被寫成 1)。
 *
 * 落後方專表:每個「有一方落後」的時點,取模型給落後方的勝率,對上它最後
 * 有沒有真的贏 —— 直接回答「我們對落後方是不是太樂觀」。
 */
import { round } from './util.mjs';

const BANDS = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75], [76, 89]];
const bandLabel = ([a, b]) => `${a}-${b}`;
const STATES = ['lead', 'level', 'trail'];   // 主隊視角:領先/平手/落後

const outcomeOf = rec => {
  const [, , , , hs, as] = rec.pts.at(-1);
  return hs > as ? 'home' : hs < as ? 'away' : 'draw';
};

export function inplayCalibration(store, { minMatches = 30 } = {}) {
  const done = Object.entries(store?.matches ?? {})
    .filter(([, r]) => r.done && (r.pts?.length ?? 0) >= 3);

  const mkCell = () => ({ n: 0, ms: new Set(), brier: 0, brierPre: 0, nPre: 0 });
  const cells = new Map();   // `${bandIdx}|${state}`
  const overall = mkCell();
  const trailing = BANDS.map(() => ({ n: 0, ms: new Set(), p: 0, won: 0 }));

  for (const [key, rec] of done) {
    const y = outcomeOf(rec);
    const yv = { home: y === 'home' ? 1 : 0, draw: y === 'draw' ? 1 : 0, away: y === 'away' ? 1 : 0 };
    const pre = rec.pts[0]?.[0] === 0 ? rec.pts[0] : null;   // 賽前錨點(比較基準)
    for (const [min, h, d, a, hs, as] of rec.pts) {
      const bi = BANDS.findIndex(([lo, hi]) => min >= lo && min <= hi);
      if (bi < 0) continue;   // 0 分錨點與 90+ 收斂點都不算
      const state = hs > as ? 'lead' : hs < as ? 'trail' : 'level';
      const br = (h - yv.home) ** 2 + (d - yv.draw) ** 2 + (a - yv.away) ** 2;
      const ck = `${bi}|${state}`;
      if (!cells.has(ck)) cells.set(ck, mkCell());
      const cell = cells.get(ck);
      for (const c of [cell, overall]) {
        c.n++; c.ms.add(key); c.brier += br;
        if (pre) {
          c.brierPre += (pre[1] - yv.home) ** 2 + (pre[2] - yv.draw) ** 2 + (pre[3] - yv.away) ** 2;
          c.nPre++;
        }
      }
      if (hs !== as) {
        const trailSide = hs > as ? 'away' : 'home';
        const t = trailing[bi];
        t.n++; t.ms.add(key);
        t.p += trailSide === 'home' ? h : a;
        t.won += y === trailSide ? 1 : 0;
      }
    }
  }

  const cellOut = c => ({
    n: c.n, matches: c.ms.size,
    brier: c.n ? round(c.brier / c.n, 4) : null,
    brierPre: c.nPre ? round(c.brierPre / c.nPre, 4) : null,
  });

  return {
    season: store?.season ?? null,
    matches: done.length,
    points: overall.n,
    minMatches,
    /* 樣本不足時數字照給、但結論欄位明講 —— 前端要把這個字打在畫面上(鐵則四) */
    verdict: done.length >= minMatches ? 'ok' : 'insufficient',
    overall: cellOut(overall),
    cells: BANDS.flatMap((b, bi) => STATES.map(state => {
      const c = cells.get(`${bi}|${state}`);
      return c ? { band: bandLabel(b), state, ...cellOut(c) } : null;
    }).filter(Boolean)),
    trailing: BANDS.map((b, bi) => {
      const t = trailing[bi];
      return t.n ? {
        band: bandLabel(b), n: t.n, matches: t.ms.size,
        avgProb: round(t.p / t.n, 4),          // 模型平均給落後方的勝率
        comebackRate: round(t.won / t.n, 4),   // 實際翻盤比例(同一批時點)
      } : null;
    }).filter(Boolean),
    note: '點與點同場相關,有效樣本看場數。第 0 分錨點與 90+ 收斂點不計入。'
      + '對照組 brierPre 是「賽前機率凍結不動」。每季重新累積(live-history 換季重開)。',
  };
}
