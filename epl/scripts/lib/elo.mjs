import { round } from './util.mjs';

const START = 1500;
const K = 20;
const HOME_ADV = 65;      // 主場優勢(Elo 分)
const CARRY = 0.75;       // 跨季回歸:新賽季保留 75% 的超額評分
const PROMOTED_GAP = 75;  // 新升班隊起始評分 = 當時聯盟平均 - 75

// 進球差加權(World Football Elo 慣例)
const gdMultiplier = gd => {
  const a = Math.abs(gd);
  if (a <= 1) return 1;
  if (a === 2) return 1.5;
  return (11 + a) / 8;
};

export function buildElo(matches) {
  const rating = new Map();
  const history = new Map();
  let lastSeason = null;

  const ensure = code => {
    if (rating.has(code)) return;
    const vals = [...rating.values()];
    const base = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length - PROMOTED_GAP : START;
    rating.set(code, base);
    history.set(code, []);
  };

  for (const m of matches.filter(x => x.played).sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (lastSeason && m.season !== lastSeason) {
      for (const [c, r] of rating) rating.set(c, START + CARRY * (r - START)); // 跨季回歸平均
    }
    lastSeason = m.season;
    ensure(m.home); ensure(m.away);

    const rh = rating.get(m.home), ra = rating.get(m.away);
    const exp = 1 / (1 + 10 ** ((ra - (rh + HOME_ADV)) / 400));
    const actual = m.fh > m.fa ? 1 : m.fh === m.fa ? 0.5 : 0;
    const delta = K * gdMultiplier(m.fh - m.fa) * (actual - exp);
    rating.set(m.home, rh + delta);
    rating.set(m.away, ra - delta);
    history.get(m.home).push({ date: m.date, r: round(rh + delta, 1) });
    history.get(m.away).push({ date: m.date, r: round(ra - delta, 1) });
  }

  const out = new Map();
  for (const [c, r] of rating) out.set(c, { code: c, elo: round(r, 1), history: history.get(c).slice(-60) });
  return out;
}

// 用 Elo 直接給勝負和機率(與 Poisson 互相對照)
/* 這三個常數也輸出給前端(meta.model.sim.elo)—— 對戰模擬要在瀏覽器端
   重現同一條 eloProbs;寫死兩份的話改了一邊另一邊悄悄過期。 */
export const ELO_PARAMS = { homeAdv: HOME_ADV, drawBase: 0.29, drawSlope: 0.22 };

export function eloProbs(rh, ra) {
  const pHomeRaw = 1 / (1 + 10 ** ((ra - (rh + ELO_PARAMS.homeAdv)) / 400));
  // 實力越接近越容易和局
  const draw = ELO_PARAMS.drawBase - ELO_PARAMS.drawSlope * Math.abs(pHomeRaw - 0.5);
  const rest = 1 - draw;
  return { home: round(pHomeRaw * rest, 4), draw: round(draw, 4), away: round((1 - pHomeRaw) * rest, 4) };
}
