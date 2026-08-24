import { round, per90, percentile } from './util.mjs';
import { ageOn, POS_ZH, STATUS_ZH } from './adapters/fpl-snapshot.mjs';

const QUALIFY_MINUTES = 600;       // 上季:進入百分位母體的出場門檻
const CURRENT_QUALIFY_RATIO = 0.3; // 本季:至少要打滿球隊已賽時間的三成
const CURRENT_QUALIFY_MIN = 90;    // 本季:且至少 90 分鐘

// 把逐輪的出場紀錄累加成「本季至今」的總計
export function aggregateSeason(rounds) {
  const totals = new Map();
  const teamMatches = new Map();
  for (const r of rounds ?? []) {
    for (const f of r.fixtures) {
      if (!f.started) continue;
      for (const [team, list] of Object.entries(f.lineups)) {
        if (list.length) teamMatches.set(team, (teamMatches.get(team) ?? 0) + 1);
        for (const p of list) {
          if (!p.code) continue;
          let t = totals.get(p.code);
          if (!t) {
            t = { code: p.code, name: p.name, pos: p.pos, team, appearances: 0 };
            for (const k of ['minutes', 'starts', 'goals', 'assists', 'own', 'yellow', 'red', 'saves',
              'conceded', 'cleanSheets', 'xG', 'xA', 'xGC', 'bonus', 'bps', 'influence', 'creativity',
              'threat', 'ict', 'tackles', 'recoveries', 'cbi', 'defCon', 'points']) t[k] = 0;
            totals.set(p.code, t);
          }
          t.team = team;
          t.appearances++;
          for (const k of ['minutes', 'starts', 'goals', 'assists', 'own', 'yellow', 'red', 'saves',
            'conceded', 'cleanSheets', 'xG', 'xA', 'xGC', 'bonus', 'bps', 'influence', 'creativity',
            'threat', 'ict', 'tackles', 'recoveries', 'cbi', 'defCon', 'points']) t[k] += p[k] ?? 0;
        }
      }
    }
  }
  // 每支球隊的出場場次會被主客兩邊各算一次以外的重複,這裡用實際比賽數修正
  for (const [team, n] of teamMatches) teamMatches.set(team, n);
  return { totals, teamMatches };
}

// 各位置的雷達軸:key = 指標,label = 中文,inverse = 越小越好
const RADAR = {
  GK: [
    { key: 'saves90', label: '撲救量' },
    { key: 'csRate', label: '零封率' },
    { key: 'shotStop', label: '撲救效率' },
    { key: 'gc90', label: '失球壓力', inverse: true },
    { key: 'defCon90', label: '防守參與' },
    { key: 'availability', label: '出場穩定' },
  ],
  DEF: [
    { key: 'defCon90', label: '防守貢獻' },
    { key: 'cbi90', label: '解圍攔截' },
    { key: 'tackles90', label: '搶斷' },
    { key: 'xgi90', label: '進攻參與' },
    { key: 'csRate', label: '零封率' },
    { key: 'availability', label: '出場穩定' },
  ],
  MID: [
    { key: 'xa90', label: '創造機會' },
    { key: 'xg90', label: '射門威脅' },
    { key: 'ga90', label: '進球參與' },
    { key: 'defCon90', label: '防守貢獻' },
    { key: 'creativity90', label: '傳球創造' },
    { key: 'availability', label: '出場穩定' },
  ],
  FWD: [
    { key: 'goals90', label: '進球' },
    { key: 'xg90', label: '射門質量' },
    { key: 'finishing', label: '終結效率' },
    { key: 'xa90', label: '助攻創造' },
    { key: 'threat90', label: '禁區威脅' },
    { key: 'availability', label: '出場穩定' },
  ],
};

// 依位置分組建立百分位母體
function buildPools(list, metricsBy, qualifies) {
  const pools = {};
  for (const pos of Object.keys(RADAR)) {
    const group = list.filter(p => p.pos === pos && qualifies(p) && metricsBy.has(p.code));
    pools[pos] = { _n: group.length };
    for (const axis of RADAR[pos]) pools[pos][axis.key] = group.map(p => metricsBy.get(p.code)[axis.key]);
  }
  return pools;
}

function radarFor(pos, met, pools, qualified) {
  return RADAR[pos].map(axis => {
    if (!met) return { label: axis.label, value: null, raw: null };
    let v = percentile(met[axis.key], pools[pos]?.[axis.key] ?? []);
    if (axis.inverse) v = round(100 - v, 1);
    return { label: axis.label, value: qualified ? v : null, raw: met[axis.key] };
  });
}

function metrics(p, seasonMinutes) {
  const m = p.minutes;
  const xGI = p.xGI ?? (p.xG ?? 0) + (p.xA ?? 0);
  return {
    minutes: m, starts: p.starts,
    goals: p.goals, assists: p.assists,
    ga: p.goals + p.assists,
    xG: round(p.xG, 2), xA: round(p.xA, 2), xGI: round(xGI, 2),
    goals90: round(per90(p.goals, m), 2),
    assists90: round(per90(p.assists, m), 2),
    ga90: round(per90(p.goals + p.assists, m), 2),
    xg90: round(per90(p.xG, m), 2),
    xa90: round(per90(p.xA, m), 2),
    xgi90: round(per90(xGI, m), 2),
    finishing: round(p.goals - p.xG, 2),             // 正 = 終結超出預期
    creativity90: round(per90(p.creativity, m), 1),
    threat90: round(per90(p.threat, m), 1),
    ict90: round(per90(p.ict, m), 1),
    defCon90: round(per90(p.defCon, m), 2),
    tackles90: round(per90(p.tackles, m), 2),
    cbi90: round(per90(p.cbi, m), 2),
    recoveries90: round(per90(p.recoveries, m), 2),
    saves90: round(per90(p.saves, m), 2),
    gc90: round(per90(p.goalsConceded, m), 2),
    shotStop: round(p.xGC - p.goalsConceded, 2),      // 正 = 比預期少失球
    csRate: round(m > 0 ? (p.cleanSheets / (m / 90)) * 100 : 0, 1),
    availability: round(seasonMinutes ? (m / seasonMinutes) * 100 : 0, 1),
    cards: p.yellow + p.red * 2,
    points: p.points, ppg: p.ppg, bonus: p.bonus,
  };
}

export function buildPlayers({ current, last, currentTotals, teamMatches, seasonMinutes = 3420, asOf }) {
  const lastByCode = new Map(last.map(p => [p.code, p]));
  const lastMetrics = new Map();
  for (const p of last) lastMetrics.set(p.code, metrics(p, seasonMinutes));

  const pools = buildPools(last, lastMetrics, p => p.minutes >= QUALIFY_MINUTES);

  // ── 本季至今 ──────────────────────────
  const curTotals = currentTotals ?? new Map();
  const curMetrics = new Map();
  const curPossible = new Map();  // code → 該隊至今可能的出場分鐘
  for (const [code, t] of curTotals) {
    const possible = (teamMatches?.get(t.team) ?? 0) * 90;
    curPossible.set(code, possible);
    curMetrics.set(code, metrics(t, possible || t.minutes));
  }
  const curQualifies = t => {
    const possible = curPossible.get(t.code) ?? 0;
    return t.minutes >= Math.max(CURRENT_QUALIFY_MIN, possible * CURRENT_QUALIFY_RATIO);
  };
  const curPools = buildPools([...curTotals.values()], curMetrics, curQualifies);

  const out = current.map(p => {
    const prev = lastByCode.get(p.code);
    const met = prev ? lastMetrics.get(p.code) : null;
    const qualified = !!prev && prev.minutes >= QUALIFY_MINUTES;
    const radar = radarFor(p.pos, met, pools, qualified);

    const curT = curTotals.get(p.code) ?? null;
    const curMet = curT ? curMetrics.get(p.code) : null;
    const qualifiedCurrent = !!curT && curQualifies(curT);
    const radarCurrent = curMet ? radarFor(p.pos, curMet, curPools, qualifiedCurrent) : null;
    return {
      code: p.code, name: p.name, fullName: p.fullName, team: p.team,
      // 上季數據要掛在「上季效力的球隊」,不然轉會球員的成績會被算到新東家頭上
      lastTeam: prev?.team ?? null,
      transferred: !!prev && prev.team !== p.team,
      pos: p.pos, posZh: POS_ZH[p.pos], price: p.price,
      squadNumber: p.squadNumber,
      age: ageOn(p.birthDate, asOf),
      status: p.status, statusZh: STATUS_ZH[p.status] ?? p.status,
      news: p.news, newsAdded: p.newsAdded, chanceNext: p.chanceNext,
      setPieces: {
        pen: p.penOrder, fk: p.fkOrder, corner: p.cornerOrder,
      },
      last: met,
      current: curMet,
      appearances: curT?.appearances ?? 0,
      qualified,
      qualifiedCurrent,
      isNewFace: !prev || prev.minutes === 0,
      radar,
      radarCurrent,
      selectedBy: p.selectedBy,
    };
  });

  const sizes = pl => Object.fromEntries(Object.entries(pl).map(([k, v]) => [k, v._n]));
  return { players: out, poolSizes: sizes(pools), currentPoolSizes: sizes(curPools) };
}

// 各式排行榜(只取上季有實際出場的球員)
export function leaderboards(players, season = 'last') {
  const stat = p => (season === 'current' ? p.current : p.last);
  const isQ = p => (season === 'current' ? p.qualifiedCurrent : p.qualified);
  const teamOf = p => (season === 'current' ? p.team : p.lastTeam ?? p.team);
  const withLast = players.filter(p => stat(p) && stat(p).minutes > 0);
  const q = players.filter(p => isQ(p) && stat(p));
  // 賽季剛開始時,整季的門檻(900 分鐘、4 xG)不可能達到,依已進行的比例縮放
  const maxMin = Math.max(1, ...withLast.map(p => stat(p).minutes));
  const scale = Math.min(1, maxMin / 3420);
  const minMinutes = Math.max(45, Math.round(900 * scale));
  const minXG = Math.max(0.5, round(4 * scale, 1));
  // 排行榜只留必要欄位,詳細資料前端再從 players.json 查(避免整包重複塞一次)
  const slim = (p, value) => ({
    code: p.code, name: p.name, team: p.team, lastTeam: teamOf(p),
    transferred: season === 'last' && p.transferred,
    pos: p.pos, posZh: p.posZh, age: p.age, price: p.price, value,
    minutes: stat(p)?.minutes ?? 0,
  });
  const top = (arr, key, n = 12, dir = -1) =>
    [...arr].sort((a, b) => (dir < 0 ? key(b) - key(a) : key(a) - key(b))).slice(0, n)
      .map(p => slim(p, key(p)));

  return {
    scorers: top(withLast, p => stat(p).goals),
    assisters: top(withLast, p => stat(p).assists),
    xgi: top(q, p => stat(p).xgi90),
    finishers: top(withLast.filter(p => stat(p).xG >= minXG), p => stat(p).finishing),
    creators: top(q, p => stat(p).xa90),
    defenders: top(q.filter(p => p.pos === 'DEF'), p => stat(p).defCon90),
    keepers: top(q.filter(p => p.pos === 'GK'), p => stat(p).shotStop),
    youngGuns: top(q.filter(p => p.age !== null && p.age <= 22), p => stat(p).points),
    workhorses: top(q, p => stat(p).recoveries90),
    value: top(withLast.filter(p => stat(p).minutes >= minMinutes), p => stat(p).points / p.price),
  };
}
