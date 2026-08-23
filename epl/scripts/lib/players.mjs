import { round, per90, percentile } from './util.mjs';
import { ageOn, POS_ZH, STATUS_ZH } from './fpl.mjs';

const QUALIFY_MINUTES = 600; // 進入百分位母體的門檻

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

function metrics(p, seasonMinutes) {
  const m = p.minutes;
  return {
    minutes: m, starts: p.starts,
    goals: p.goals, assists: p.assists,
    ga: p.goals + p.assists,
    xG: round(p.xG, 2), xA: round(p.xA, 2), xGI: round(p.xGI, 2),
    goals90: round(per90(p.goals, m), 2),
    assists90: round(per90(p.assists, m), 2),
    ga90: round(per90(p.goals + p.assists, m), 2),
    xg90: round(per90(p.xG, m), 2),
    xa90: round(per90(p.xA, m), 2),
    xgi90: round(per90(p.xGI, m), 2),
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

export function buildPlayers({ current, last, seasonMinutes = 3420, asOf }) {
  const lastByCode = new Map(last.map(p => [p.code, p]));
  const lastMetrics = new Map();
  for (const p of last) lastMetrics.set(p.code, metrics(p, seasonMinutes));

  // 百分位母體:上季出場達門檻者,依位置分組
  const pools = {};
  for (const pos of Object.keys(RADAR)) {
    const group = last.filter(p => p.pos === pos && p.minutes >= QUALIFY_MINUTES);
    pools[pos] = {};
    for (const axis of RADAR[pos]) {
      pools[pos][axis.key] = group.map(p => lastMetrics.get(p.code)[axis.key]);
    }
    pools[pos]._n = group.length;
  }

  const out = current.map(p => {
    const prev = lastByCode.get(p.code);
    const met = prev ? lastMetrics.get(p.code) : null;
    const qualified = !!prev && prev.minutes >= QUALIFY_MINUTES;
    const radar = RADAR[p.pos].map(axis => {
      if (!met) return { label: axis.label, value: null, raw: null };
      let v = percentile(met[axis.key], pools[p.pos][axis.key] ?? []);
      if (axis.inverse) v = round(100 - v, 1);
      return { label: axis.label, value: qualified ? v : null, raw: met[axis.key] };
    });
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
      qualified,
      isNewFace: !prev || prev.minutes === 0,
      radar,
      selectedBy: p.selectedBy,
    };
  });

  return { players: out, poolSizes: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v._n])) };
}

// 各式排行榜(只取上季有實際出場的球員)
export function leaderboards(players) {
  const withLast = players.filter(p => p.last && p.last.minutes > 0);
  const q = players.filter(p => p.qualified);
  // 排行榜只留必要欄位,詳細資料前端再從 players.json 查(避免整包重複塞一次)
  const slim = (p, value) => ({
    code: p.code, name: p.name, team: p.team, lastTeam: p.lastTeam, transferred: p.transferred,
    pos: p.pos, posZh: p.posZh, age: p.age, price: p.price, value,
    minutes: p.last?.minutes ?? 0,
  });
  const top = (arr, key, n = 12, dir = -1) =>
    [...arr].sort((a, b) => (dir < 0 ? key(b) - key(a) : key(a) - key(b))).slice(0, n)
      .map(p => slim(p, key(p)));

  return {
    scorers: top(withLast, p => p.last.goals),
    assisters: top(withLast, p => p.last.assists),
    xgi: top(q, p => p.last.xgi90),
    finishers: top(withLast.filter(p => p.last.xG >= 4), p => p.last.finishing),
    creators: top(q, p => p.last.xa90),
    defenders: top(q.filter(p => p.pos === 'DEF'), p => p.last.defCon90),
    keepers: top(q.filter(p => p.pos === 'GK'), p => p.last.shotStop),
    youngGuns: top(q.filter(p => p.age !== null && p.age <= 22), p => p.last.points),
    workhorses: top(q, p => p.last.recoveries90),
    value: top(withLast.filter(p => p.last.minutes >= 900), p => p.last.points / p.price),
  };
}
