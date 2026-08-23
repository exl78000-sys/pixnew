import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCSVObjects, num } from './csv.mjs';

export const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
export const POS_ZH = { GK: '門將', DEF: '後衛', MID: '中場', FWD: '前鋒' };

// 讀取某季的 FPL 快照,並把隊伍 id 換成我們的三碼隊碼
export function loadFpl(root, season, codeOf) {
  const dir = join(root, 'data', 'raw', 'fpl');
  const teamRows = parseCSVObjects(readFileSync(join(dir, `${season}-teams.csv`), 'utf8'));
  const teamById = new Map();
  for (const t of teamRows) {
    const code = codeOf(t.name);
    if (!code) throw new Error(`FPL 隊名無法對照:${t.name}`);
    teamById.set(t.id, { code, strength: num(t.strength), name: t.name, short: t.short_name });
  }

  const rows = parseCSVObjects(readFileSync(join(dir, `${season}-players.csv`), 'utf8'));
  const players = rows.map(r => ({
    code: r.code,                        // 跨季不變的球員代碼
    id: r.id,
    name: r.web_name,
    fullName: `${r.first_name} ${r.second_name}`.trim(),
    team: teamById.get(r.team)?.code ?? null,
    pos: POS[r.element_type] ?? '?',
    price: num(r.now_cost) / 10,
    status: r.status,                    // a=可上場 d=有疑慮 i=傷 s=停賽 u=不可用
    news: r.news || '',
    newsAdded: r.news_added || null,
    chanceNext: r.chance_of_playing_next_round === '' ? null : num(r.chance_of_playing_next_round, null),
    squadNumber: r.squad_number && r.squad_number !== 'None' ? num(r.squad_number) : null,
    birthDate: r.birth_date || null,
    minutes: num(r.minutes), starts: num(r.starts),
    goals: num(r.goals_scored), assists: num(r.assists),
    xG: num(r.expected_goals), xA: num(r.expected_assists), xGI: num(r.expected_goal_involvements),
    xGC: num(r.expected_goals_conceded), goalsConceded: num(r.goals_conceded),
    cleanSheets: num(r.clean_sheets), saves: num(r.saves),
    yellow: num(r.yellow_cards), red: num(r.red_cards), ownGoals: num(r.own_goals),
    pensMissed: num(r.penalties_missed), pensSaved: num(r.penalties_saved),
    bonus: num(r.bonus), bps: num(r.bps),
    influence: num(r.influence), creativity: num(r.creativity), threat: num(r.threat), ict: num(r.ict_index),
    points: num(r.total_points), ppg: num(r.points_per_game),
    selectedBy: num(r.selected_by_percent),
    tackles: num(r.tackles), recoveries: num(r.recoveries),
    cbi: num(r.clearances_blocks_interceptions), defCon: num(r.defensive_contribution),
    penOrder: r.penalties_order ? num(r.penalties_order) : null,
    fkOrder: r.direct_freekicks_order ? num(r.direct_freekicks_order) : null,
    cornerOrder: r.corners_and_indirect_freekicks_order ? num(r.corners_and_indirect_freekicks_order) : null,
  })).filter(p => p.team);

  return { players, teamById };
}

export const ageOn = (birthDate, onDate) => {
  if (!birthDate) return null;
  const b = new Date(birthDate), d = new Date(onDate);
  let a = d.getFullYear() - b.getFullYear();
  const mm = d.getMonth() - b.getMonth();
  if (mm < 0 || (mm === 0 && d.getDate() < b.getDate())) a--;
  return a;
};

export const STATUS_ZH = { a: '可出賽', d: '有疑慮', i: '傷停', s: '禁賽', u: '不可用', n: '未註冊' };
