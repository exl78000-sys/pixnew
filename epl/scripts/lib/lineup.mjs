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

/* ── 官方陣型 → 每一排要放哪些角色 ─────────────
 *
 * 為什麼需要這一段:FPL 只有 GK/DEF/MID/FWD 四類,而且把邊鋒歸為中場,
 * 所以直接照 FPL 分線的話,20 隊裡有 13 隊都會變成 4-5-1 —— 那不是球隊真的都這樣踢,
 * 是分類太粗。官方公布的陣型(4-2-3-1 / 3-4-2-1 / 4-1-4-1)才是真的,
 * 配上角色分類器把中場拆成防中/中場/前腰/邊鋒,就能把人放進正確的線上。
 */
export function parseFormation(label) {
  if (!label) return null;
  const n = String(label).split('-').map(Number);
  if (n.length < 2 || n.some(x => !Number.isInteger(x) || x < 1)) return null;
  if (n.reduce((a, b) => a + b, 0) !== 10) return null;   // 門將另計,外場必須剛好 10 人
  return n;
}

// 第 idx 排(0 = 後防線)要哪些角色。回傳長度等於該排人數。
function lineRoles(counts, idx) {
  const total = counts.length, n = counts[idx];
  if (idx === 0) {
    // 後防:3 人全中衛;4 人 = 2 中衛 + 2 邊後衛;5 人 = 3 中衛 + 2 翼衛
    return n <= 3 ? Array(n).fill('CB') : ['FB', ...Array(n - 2).fill('CB'), 'FB'];
  }
  if (idx === total - 1) {
    // 最前線:1~2 人全中鋒;3 人 = 兩邊鋒夾一中鋒
    return n <= 2 ? Array(n).fill('ST') : ['W', ...Array(n - 2).fill('ST'), 'W'];
  }
  const midCount = total - 2, midIdx = idx - 1;
  if (midCount === 1) {
    // 只有一條中場線(4-4-2 / 4-3-3 / 5-4-1):寬的話兩邊放邊鋒
    return n <= 3 ? Array(n).fill('CM') : ['W', ...Array(n - 2).fill('CM'), 'W'];
  }
  if (midIdx === 0) {
    // 較深的那條:三後衛體系的話兩邊是翼衛,否則是防守中場
    if (counts[0] === 3 && n >= 4) return ['FB', ...Array(n - 2).fill('CM'), 'FB'];
    return n <= 2 ? Array(n).fill('DM') : ['DM', ...Array(n - 1).fill('CM')];
  }
  // 較前的那條:1~2 人是前腰;3 人兩邊鋒夾前腰;4 人以上兩邊鋒 + 中場
  if (n <= 2) return Array(n).fill('AM');
  if (n === 3) return ['W', 'AM', 'W'];
  return ['W', ...Array(n - 2).fill('CM'), 'W'];
}

// 找不到該角色時往下退。退到最後就從剩下分數最高的補,並標記 filled。
const FALLBACK = {
  CB: ['CB', 'FB', 'DM'],
  FB: ['FB', 'CB', 'W', 'CM'],
  DM: ['DM', 'CM', 'CB'],
  CM: ['CM', 'DM', 'AM'],
  AM: ['AM', 'CM', 'W'],
  W: ['W', 'AM', 'ST', 'CM'],
  ST: ['ST', 'W', 'AM'],
};

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

const slim = p => ({
  code: p.code, name: p.name, pos: p.pos,
  score: p._score, doubt: !!p.doubt, filled: !!p.filled,
  role: p._role ?? null, roleZh: p._roleZh ?? null,
  starts: p.current?.starts ?? 0, lastStarts: p.last?.starts ?? 0,
  minutes: p.current?.minutes ?? 0, lastMinutes: p.last?.minutes ?? 0,
  status: p.status, statusZh: p.statusZh, news: p.news || '',
});

const unavailableOf = (players, team) => players
  .filter(p => p.team === team && OUT.has(p.status))
  .map(p => ({ name: p.name, pos: p.pos, statusZh: p.statusZh, news: p.news || '' }));

/* 照官方陣型排:每一排要哪些角色已由 lineRoles 決定,這裡負責把人填進去。
   同一個角色有多人時取先發分數最高的;該角色沒人就依 FALLBACK 往下退;
   全退完還是缺就從剩下分數最高的補,並標記 filled 讓前端說明是遞補。 */
function byFormation({ squad, team, counts, formation, formationSource, classify, rounds, players }) {
  const roleOf = p => {
    const r = classify(p, p.last ?? p.current);
    return { key: r.key, zh: r.zh };
  };
  const withRole = squad.map(p => {
    const r = roleOf(p);
    return { ...p, _role: r.key, _roleZh: r.zh };
  });
  const byRole = new Map();
  for (const p of withRole) {
    if (!byRole.has(p._role)) byRole.set(p._role, []);
    byRole.get(p._role).push(p);
  }
  for (const list of byRole.values()) list.sort((a, b) => b._score - a._score);

  const used = new Set();
  const take = want => {
    for (const r of FALLBACK[want] ?? [want]) {
      const hit = (byRole.get(r) ?? []).find(p => !used.has(p.code));
      if (hit) { used.add(hit.code); return hit; }
    }
    return null;
  };
  const fill = () => {
    const rest = withRole.filter(p => !used.has(p.code) && p._role !== 'GK')
      .sort((a, b) => b._score - a._score)[0];
    if (rest) { used.add(rest.code); return { ...rest, filled: true }; }
    return null;
  };

  // 門將先定,再由後往前一排一排填
  const gk = take('GK') ?? (byRole.get('GK') ?? [])[0] ?? null;
  if (gk) used.add(gk.code);
  const rows = counts.map((n, i) => {
    const wants = lineRoles(counts, i);
    return wants.map(w => take(w) ?? fill()).filter(Boolean);
  });

  const xi = [gk, ...rows.flat()].filter(Boolean);
  const bench = withRole.filter(p => !used.has(p.code))
    .sort((a, b) => b._score - a._score).slice(0, 7);

  return {
    team,
    shape: formation,
    shapeSource: formationSource,  // 'official' 或 'derived' —— 前端要能講清楚陣型哪來的
    // 每一排實際有誰 —— 球場圖照這個畫,才不會又被 FPL 粗類拉回 4-5-1
    rows: [[gk].filter(Boolean).map(slim), ...rows.map(r => r.map(slim))],
    xi: xi.map(slim),
    bench: bench.map(slim),
    basis: rounds >= 10 ? 'current' : rounds > 0 ? 'mixed' : 'last',
    rounds,
    unavailable: unavailableOf(players, team),
  };
}

export function projectXI({ players, team, tactics, rounds, formation = null, formationSource = 'derived', classify = null }) {
  const squad = players
    .filter(p => p.team === team && !OUT.has(p.status))
    .map(p => ({ ...p, _score: score(p, rounds), doubt: p.status === DOUBT }));

  // 有官方陣型 + 角色分類器就照官方的排,這是最準的一條路
  const counts = classify ? parseFormation(formation) : null;
  if (counts) return byFormation({ squad, team, counts, formation, formationSource, classify, rounds, players });

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

  return {
    team,
    shape: `${shape.DEF}-${shape.MID}-${shape.FWD}`,
    shapeSource: 'fpl',            // 沒有官方陣型時的退路:FPL 四粗類,會偏向 4-5-1
    rows: null,
    xi: pick.slice(0, 11).map(slim),
    bench: bench.map(slim),
    // 讀者要知道這個推測有多可信:本季樣本越多越可信
    basis: rounds >= 10 ? 'current' : rounds > 0 ? 'mixed' : 'last',
    rounds,
    unavailable: unavailableOf(players, team),
  };
}
