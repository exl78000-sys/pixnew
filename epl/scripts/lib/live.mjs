// 即時比賽資料層 —— 三種來源,正規化成同一個格式。
//
//   fpl-api   官方 FPL API,比賽進行中會逐分鐘更新(需要能連到 fantasy.premierleague.com)
//   mirror    GitHub 上的 FPL 鏡像,每輪賽後更新(任何環境都連得到)
//   replay    重播某一輪真實的歷史比賽,用來驗證與展示(會標記 demo)
//
// 三者輸出同一個 shape,前端不需要知道資料是哪裡來的。
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCSVObjects, num } from './csv.mjs';

const API = 'https://fantasy.premierleague.com/api';
const MIRROR = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';
const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };

const get = async (url, ms = 20000) => {
  const res = await fetch(url, { headers: { 'user-agent': 'epl-warroom/1.0' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res;
};

// 上游偶爾會出現「同一球員同一場」的重複列(已知 vaastav 的 gw csv 有這種情形),
// 不去重的話球隊的出場時間、xG、進球都會被重複計算。
function dedupe(list) {
  const seen = new Set();
  return list.filter(p => {
    const k = p.code ?? p.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const blankPlayer = () => ({
  minutes: 0, starts: 0, goals: 0, assists: 0, own: 0, yellow: 0, red: 0,
  saves: 0, conceded: 0, cleanSheets: 0, xG: 0, xA: 0, xGC: 0, bonus: 0, bps: 0,
  influence: 0, creativity: 0, threat: 0, ict: 0,
  tackles: 0, recoveries: 0, cbi: 0, defCon: 0, points: 0,
});

/* ── 來源 A:官方 API(真正即時) ─────────────────── */
async function fromApi({ codeOf, round }) {
  const boot = await (await get(`${API}/bootstrap-static/`)).json();
  const teamCode = new Map(boot.teams.map(t => [t.id, codeOf(t.name) ?? codeOf(t.short_name)]));
  const elements = new Map(boot.elements.map(e => [e.id, {
    code: String(e.code), name: e.web_name, pos: POS[e.element_type], team: teamCode.get(e.team),
  }]));
  const event = round ?? (boot.events.find(e => e.is_current) ?? boot.events.find(e => e.is_next) ?? boot.events[0]).id;

  const fixtures = await (await get(`${API}/fixtures/?event=${event}`)).json();
  const live = await (await get(`${API}/event/${event}/live/`)).json();

  const statsByElement = new Map(live.elements.map(e => [e.id, e.stats]));
  // explain[] 會標出這名球員的數據屬於哪一場,才能把球員歸到正確的比賽
  const fixtureOfElement = new Map();
  for (const e of live.elements) for (const ex of e.explain ?? []) fixtureOfElement.set(`${e.id}|${ex.fixture}`, ex.fixture);

  const out = fixtures.map(f => {
    const home = teamCode.get(f.team_h), away = teamCode.get(f.team_a);
    const lineups = { [home]: [], [away]: [] };
    for (const [id, meta] of elements) {
      if (meta.team !== home && meta.team !== away) continue;
      if (!fixtureOfElement.has(`${id}|${f.id}`)) continue;
      const s = statsByElement.get(id) ?? {};
      if (!s.minutes) continue;
      lineups[meta.team].push({
        ...blankPlayer(), code: meta.code, name: meta.name, pos: meta.pos,
        minutes: num(s.minutes), starts: num(s.starts), goals: num(s.goals_scored), assists: num(s.assists),
        own: num(s.own_goals), yellow: num(s.yellow_cards), red: num(s.red_cards),
        saves: num(s.saves), conceded: num(s.goals_conceded), cleanSheets: num(s.clean_sheets),
        xG: num(s.expected_goals), xA: num(s.expected_assists), xGC: num(s.expected_goals_conceded),
        bonus: num(s.bonus), bps: num(s.bps),
        influence: num(s.influence), creativity: num(s.creativity), threat: num(s.threat), ict: num(s.ict_index),
        tackles: num(s.tackles), recoveries: num(s.recoveries),
        cbi: num(s.clearances_blocks_interceptions), defCon: num(s.defensive_contribution),
        points: num(s.total_points),
      });
    }
    return {
      key: `${home}|${away}`, home, away,
      kickoff: f.kickoff_time,
      started: !!f.started, finished: !!f.finished_provisional || !!f.finished,
      minutes: num(f.minutes),
      hs: f.team_h_score ?? null, as: f.team_a_score ?? null,
      lineups: { [home]: dedupe(lineups[home]), [away]: dedupe(lineups[away]) },
    };
  });
  return { source: 'fpl-api', sourceLabel: '官方 FPL API(比賽進行中會即時更新)', demo: false, round: event, fixtures: out };
}

/* ── 來源 B/C:GitHub 鏡像與重播 ─────────────────── */
async function fromMirror({ codeOf, season, round, demo, root }) {
  const text = async (url, cacheFile) => {
    if (cacheFile && existsSync(cacheFile)) return readFile(cacheFile, 'utf8');
    return (await get(url, 60000)).text();
  };
  const rawDir = join(root, 'data', 'raw', 'fpl');

  const teams = parseCSVObjects(await text(`${MIRROR}/${season}/teams.csv`, join(rawDir, `${season}-teams.csv`)));
  const teamCode = new Map(teams.map(t => [t.id, codeOf(t.name)]));
  const players = parseCSVObjects(await text(`${MIRROR}/${season}/players_raw.csv`, join(rawDir, `${season}-players.csv`)));
  const codeById = new Map(players.map(p => [p.id, p.code]));

  const fixtures = parseCSVObjects(await text(`${MIRROR}/${season}/fixtures.csv`, join(rawDir, `${season}-fixtures.csv`)));
  const gw = parseCSVObjects(await text(`${MIRROR}/${season}/gws/gw${round}.csv`));

  const byFixture = new Map();
  for (const r of gw) {
    const fid = r.fixture;
    if (!byFixture.has(fid)) byFixture.set(fid, []);
    byFixture.get(fid).push(r);
  }

  const out = [];
  for (const f of fixtures) {
    if (num(f.event) !== Number(round)) continue;
    const home = teamCode.get(f.team_h), away = teamCode.get(f.team_a);
    if (!home || !away) continue;
    const lineups = { [home]: [], [away]: [] };
    for (const r of byFixture.get(f.id) ?? []) {
      if (num(r.minutes) === 0) continue;
      const team = r.was_home === 'True' ? home : away;
      lineups[team].push({
        ...blankPlayer(),
        code: codeById.get(r.element) ?? null, name: r.name, pos: r.position,
        minutes: num(r.minutes), starts: num(r.starts), goals: num(r.goals_scored), assists: num(r.assists),
        own: num(r.own_goals), yellow: num(r.yellow_cards), red: num(r.red_cards),
        saves: num(r.saves), conceded: num(r.goals_conceded), cleanSheets: num(r.clean_sheets),
        xG: num(r.expected_goals), xA: num(r.expected_assists), xGC: num(r.expected_goals_conceded),
        bonus: num(r.bonus), bps: num(r.bps),
        influence: num(r.influence), creativity: num(r.creativity), threat: num(r.threat), ict: num(r.ict_index),
        tackles: num(r.tackles), recoveries: num(r.recoveries),
        cbi: num(r.clearances_blocks_interceptions), defCon: num(r.defensive_contribution),
        points: num(r.total_points),
      });
    }
    out.push({
      key: `${home}|${away}`, home, away,
      kickoff: f.kickoff_time,
      started: f.started === 'True', finished: f.finished === 'True',
      minutes: num(f.minutes),
      hs: f.team_h_score === '' ? null : num(f.team_h_score),
      as: f.team_a_score === '' ? null : num(f.team_a_score),
      lineups: { [home]: dedupe(lineups[home]), [away]: dedupe(lineups[away]) },
    });
  }
  return {
    source: demo ? 'replay' : 'mirror',
    sourceLabel: demo
      ? `重播 ${season} 第 ${round} 輪的真實比賽資料(不是現在進行中的比賽)`
      : 'GitHub 上的 FPL 鏡像(每輪賽後更新,非逐分鐘即時)',
    demo: !!demo, season, round: Number(round), fixtures: out,
  };
}

/* ── 對外入口 ───────────────────────────────────── */
export async function fetchLive({ source = 'auto', season, round = null, replay = null, codeOf, root }) {
  if (replay) {
    const [s, r] = replay.split(':');
    return { ...(await fromMirror({ codeOf, season: s, round: r, demo: true, root })), fetchedAt: new Date().toISOString() };
  }
  const attempts = source === 'auto' ? ['api', 'mirror'] : [source];
  const errors = [];
  for (const a of attempts) {
    try {
      const data = a === 'api'
        ? await fromApi({ codeOf, round })
        : await fromMirror({ codeOf, season, round: round ?? 1, root });
      return { ...data, fetchedAt: new Date().toISOString() };
    } catch (err) {
      errors.push(`${a}: ${err.message}`);
    }
  }
  const e = new Error(`所有來源都失敗 —— ${errors.join(' / ')}`);
  e.attempts = errors;
  throw e;
}
