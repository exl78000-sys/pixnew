import { round } from './util.mjs';

/* 預估先發陣容。
 *
 * 這是**推測**,不是官方名單 —— 前端必須標示清楚,不能讓讀者以為我們拿到了內線消息。
 * FPL 只有在開賽後才給真實出場名單,所以賽前只能從「誰最近一直在先發」反推。
 *
 * 排除規則:傷停 / 禁賽 / 不可用一律不排;「有疑慮」保留但標記,因為那種球員
 * 確實常常還是上場,直接剔掉反而更不準。
 */
const OUT = new Set(['i', 's', 'u']);      // 傷停 / 禁賽 / 不可用
const DOUBT = 'd';                          // 有疑慮:仍列入但標記

// 本季樣本太少時要靠上季,但本季一旦累積起來就該以本季為準。
// 用已賽輪數決定權重:第 1 輪幾乎全看上季,第 10 輪之後幾乎全看本季。
const currentWeight = rounds => Math.min(1, rounds / 10);

function score(p, rounds) {
  const w = currentWeight(rounds);
  const cur = p.current, last = p.last;
  // 先發率:先發場次 ÷ 球隊已進行的場次。沒資料就給 0。
  const curRate = cur && rounds > 0 ? Math.min(1, cur.starts / rounds) : 0;
  const lastRate = last && last.minutes > 0 ? Math.min(1, last.starts / 38) : 0;
  // 出場分鐘當次要依據,拉開先發率相同的人
  const curMin = cur ? cur.minutes / Math.max(1, rounds * 90) : 0;
  const lastMin = last ? last.minutes / 3420 : 0;
  const rate = w * curRate + (1 - w) * lastRate;
  const mins = w * curMin + (1 - w) * lastMin;
  return round(rate * 0.75 + mins * 0.25, 4);
}

/* 依球隊常態陣型決定各線人數。tactics 的 formation 是平均值,要湊成整數 11 人。 */
function shapeOf(tac) {
  if (!tac) return { DEF: 4, MID: 4, FWD: 2 };
  const raw = { DEF: tac.formation.def, MID: tac.formation.mid, FWD: tac.formation.fwd };
  const out = { DEF: Math.round(raw.DEF), MID: Math.round(raw.MID), FWD: Math.round(raw.FWD) };
  // 四捨五入後總數不一定是 10(門將另計),差額補在小數部分離整數最遠的那一線
  let total = out.DEF + out.MID + out.FWD;
  let guard = 0;
  while (total !== 10 && guard++ < 12) {
    const dir = total < 10 ? 1 : -1;
    const key = ['DEF', 'MID', 'FWD']
      .filter(k => (dir > 0 ? out[k] < 6 : out[k] > (k === 'DEF' ? 3 : 0)))
      .sort((a, b) => Math.abs(raw[b] - out[b]) - Math.abs(raw[a] - out[a]))[0];
    if (!key) break;
    out[key] += dir;
    total = out.DEF + out.MID + out.FWD;
  }
  return out;
}

export function projectXI({ players, team, tactics, rounds }) {
  const squad = players
    .filter(p => p.team === team && !OUT.has(p.status))
    .map(p => ({ ...p, _score: score(p, rounds), doubt: p.status === DOUBT }));

  const shape = shapeOf(tactics);
  const need = { GK: 1, ...shape };
  const pick = [];
  const pool = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of squad) (pool[p.pos] ?? pool.MID).push(p);
  for (const k of Object.keys(pool)) pool[k].sort((a, b) => b._score - a._score);

  for (const [pos, n] of Object.entries(need)) pick.push(...pool[pos].slice(0, n));

  // 某一線人不夠(例如傷兵太多),就從剩下分數最高的人補滿 11 個,並標明是遞補
  if (pick.length < 11) {
    const used = new Set(pick.map(p => p.code));
    const rest = squad.filter(p => !used.has(p.code)).sort((a, b) => b._score - a._score);
    pick.push(...rest.slice(0, 11 - pick.length).map(p => ({ ...p, filled: true })));
  }

  const ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
  pick.sort((a, b) => ORDER[a.pos] - ORDER[b.pos] || b._score - a._score);

  const bench = squad
    .filter(p => !pick.some(x => x.code === p.code))
    .sort((a, b) => b._score - a._score).slice(0, 7);

  const slim = p => ({
    code: p.code, name: p.name, pos: p.pos,
    score: p._score, doubt: !!p.doubt, filled: !!p.filled,
    starts: p.current?.starts ?? 0, lastStarts: p.last?.starts ?? 0,
    minutes: p.current?.minutes ?? 0, lastMinutes: p.last?.minutes ?? 0,
    status: p.status, statusZh: p.statusZh, news: p.news || '',
  });

  return {
    team,
    shape: `${shape.DEF}-${shape.MID}-${shape.FWD}`,
    xi: pick.slice(0, 11).map(slim),
    bench: bench.map(slim),
    // 讀者要知道這個推測有多可信:本季樣本越多越可信
    basis: rounds >= 10 ? 'current' : rounds > 0 ? 'mixed' : 'last',
    rounds,
    unavailable: players
      .filter(p => p.team === team && OUT.has(p.status))
      .map(p => ({ name: p.name, pos: p.pos, statusZh: p.statusZh, news: p.news || '' })),
  };
}
