/* 教練前一段任期的逐場風格(B 層)。
 *
 * 資料流:核對過的職涯(coach-careers-verified.json)給「哪一隊、哪段期間」,
 * 逐場統計從本站已有的 football-data 季檔算 —— 交付方只交任期,數據不經他手。
 *
 * 界線(都要跟著資料走到畫面上):
 * - 只算本站有逐場 CSV 的聯賽(E0/E1 2023-24 起、SP1 2024-25 起)。
 *   德甲、沙烏地等沒有的 → 回 null 帶 reason,畫面只列任期事實,不留空數字。
 * - 離任日是 null 的任期不算(不知道切到哪天,算了就是猜)。
 * - 任期比 CSV 涵蓋早的,截到涵蓋起點並標 clipped —— 讀者要知道這不是全任期。
 * - 場均值旁附**同期間該聯賽全隊平均**,沒有比較基準的裸數字讀不出高低。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { teamMatchRows, avg } from './style-trend.mjs';
import { clubKey } from './names.mjs';

/* 聯賽 → 季檔位置。鍵是交付檔的 competition(小寫)。
 *
 * 本站三聯賽走 clubs 登錄表解隊名;**外國聯賽(foreign)走人工對照表**
 * (data/manual/foreign-club-aliases.json,逐一跟 CSV 隊名實對過)——
 * CSV 用縮寫(Ein Frankfurt、M'gladbach),模糊比對就是「對錯隊」那條老坑。
 * country 是護欄:義甲叫 Serie A、巴甲叫 Campeonato Brasileiro Série A,
 * 字串不同所以不會撞;但同名撞上時 country 對不上就拒算。
 * 季檔由 scripts/fetch-tenure-csvs.mjs 一次性回填(歷史檔不會再變,進版控)。 */
const CSV_LEAGUES = {
  'premier league': { dir: 'football-data-couk', div: 'E0', clubsPath: 'web/data/clubs.json', zh: '英超' },
  championship: { dir: 'football-data-couk-championship', div: 'E1', clubsPath: 'web/data/leagues/en2/clubs.json', zh: '英冠' },
  'efl championship': { dir: 'football-data-couk-championship', div: 'E1', clubsPath: 'web/data/leagues/en2/clubs.json', zh: '英冠' },
  'la liga': { dir: 'football-data-couk-la-liga', div: 'SP1', clubsPath: 'web/data/leagues/es1/clubs.json', zh: '西甲' },
  bundesliga: { dir: 'football-data-couk-extra/D1', div: 'D1', zh: '德甲', foreign: true, country: 'Germany' },
  '2. bundesliga': { dir: 'football-data-couk-extra/D2', div: 'D2', zh: '德乙', foreign: true, country: 'Germany' },
  'serie a': { dir: 'football-data-couk-extra/I1', div: 'I1', zh: '義甲', foreign: true, country: 'Italy' },
  'ligue 1': { dir: 'football-data-couk-extra/F1', div: 'F1', zh: '法甲', foreign: true, country: 'France' },
  'primeira liga': { dir: 'football-data-couk-extra/P1', div: 'P1', zh: '葡超', foreign: true, country: 'Portugal' },
  'belgian pro league': { dir: 'football-data-couk-extra/B1', div: 'B1', zh: '比甲', foreign: true, country: 'Belgium' },
  'scottish premiership': { dir: 'football-data-couk-extra/SC0', div: 'SC0', zh: '蘇超', foreign: true, country: 'Scotland' },
  'la liga 2': { dir: 'football-data-couk-extra/SP2', div: 'SP2', zh: '西乙', foreign: true, country: 'Spain' },
  'league one': { dir: 'football-data-couk-extra/E2', div: 'E2', zh: '英甲', foreign: true, country: 'England' },
  'league two': { dir: 'football-data-couk-extra/E3', div: 'E3', zh: '英乙', foreign: true, country: 'England' },
};

const monthFloor = d => (d && /^\d{4}-\d{2}$/.test(d) ? `${d}-01` : d);

/* 核對過的職涯檔。sha 對不上收件匣就回 stale —— build 拿舊核對結果背書新內容
   的那條坑,跟租借同一道守門。 */
export function loadVerifiedCareers(ROOT) {
  const vPath = join(ROOT, 'data', 'coach-careers-verified.json');
  const inboxPath = join(ROOT, 'data', 'manual', 'coach-careers.json');
  if (!existsSync(vPath) || !existsSync(inboxPath)) return { status: 'absent', published: [] };
  const v = JSON.parse(readFileSync(vPath, 'utf8'));
  const sha = createHash('sha256').update(readFileSync(inboxPath, 'utf8')).digest('hex');
  if (v.inboxSha256 !== sha) return { status: 'stale', published: [] };
  return { status: 'ok', published: v.published ?? [] };
}

/* 把核對通過的前任期掛上教練名冊。三個 build 共用同一份 ——
   複製三份的話,改了一邊另外兩邊悄悄過期(CLAUDE.md 的老坑)。 */
export function attachCareers(ROOT, coachesArr, league) {
  const careers = loadVerifiedCareers(ROOT);
  if (careers.status === 'stale') {
    console.log('  ⚠ 職涯核對結果跟不上收件匣,前任期整批不掛 —— 先跑 npm run careers:verify');
    return { status: 'stale', styled: 0, total: 0 };
  }
  let styled = 0, total = 0;
  for (const rec of careers.published) {
    if (rec.league !== league) continue;
    const co = coachesArr.find(c => c.team === rec.team);
    if (!co || !rec.previous?.length) continue;
    const prev = rec.previous[0];   // 最近的一段
    const { style, reason } = tenureStyle(ROOT, prev);
    co.career = {
      verified: true,
      previous: rec.previous.map(p => ({ club: p.club, competition: p.competition, from: p.from, to: p.to })),
      style, styleUnavailable: style ? null : reason,
    };
    total++;
    if (style) styled++;
  }
  if (total) console.log(`  教練前任期:核對通過 ${total} 筆,其中 ${styled} 段算得出逐場風格`);
  return { status: 'ok', styled, total };
}

/* 一段前任期 → 逐場風格。回 { style } 或 { style: null, reason }。 */
export function tenureStyle(ROOT, prev, { minGames = 5 } = {}) {
  const cfg = CSV_LEAGUES[String(prev.competition ?? '').toLowerCase()];
  if (!cfg) return { style: null, reason: `${prev.competition} 沒有本站可用的逐場資料源` };
  if (!prev.to) return { style: null, reason: '離任日未知,無法界定要算哪些比賽' };

  let club, codeOf;
  if (cfg.foreign) {
    // 外國聯賽:country 護欄 + 人工對照表(不模糊比對 —— CSV 用縮寫,對錯隊比對不到糟)
    if (cfg.country && prev.country && prev.country !== cfg.country) {
      return { style: null, reason: `${prev.competition}(${prev.country})與本站對照的 ${cfg.country} 聯賽不同名同姓,拒算` };
    }
    const aliases = JSON.parse(readFileSync(join(ROOT, 'data', 'manual', 'foreign-club-aliases.json'), 'utf8'));
    const csvName = aliases[cfg.div]?.[prev.club];
    if (!csvName) return { style: null, reason: `${prev.club} 還沒有人工對照(foreign-club-aliases.json 的 ${cfg.div})` };
    club = { code: csvName, en: prev.club };
    codeOf = n => n;   // 隊名就當代碼:這裡只要「這一隊 vs 其他全部」,不需要本站隊碼
  } else {
    const clubs = JSON.parse(readFileSync(join(ROOT, cfg.clubsPath), 'utf8'));
    const byName = new Map((clubs.clubs ?? clubs).flatMap(t =>
      [t.en, t.of, t.zh, t.fd, t.fpl, t.understat, ...(t.alias ?? []), ...(t.cupAlias ?? [])]
        .filter(Boolean).map(n => [clubKey(n), t])));
    club = byName.get(clubKey(prev.club));
    if (!club) return { style: null, reason: `${prev.club} 對不到名冊` };
    codeOf = n => byName.get(clubKey(n))?.code ?? null;
  }

  const from = monthFloor(prev.from), to = monthFloor(prev.to);
  const rows = [];
  const leagueRows = [];
  let clipped = false;
  let filesRead = 0, sawClub = false;
  const dir = join(ROOT, 'data', 'raw', cfg.dir);
  // 季檔逐季讀:檔名就是賽季,任期跨到哪季讀到哪季。
  // 比賽只發生在 8 月~隔年 5 月:六月上任、八月開季不算「漏了比賽」。
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)); y++) {
    const playsInSeason = from <= `${y + 1}-05-31` && to >= `${y}-08-01`;
    if (!playsInSeason) continue;
    const p = join(dir, `${y}-${String((y + 1) % 100).padStart(2, '0')}.csv`);
    if (!existsSync(p)) { clipped = true; continue; }   // 任期有比賽的賽季缺季檔 → 截段
    filesRead++;
    const byTeam = teamMatchRows(readFileSync(p, 'utf8'), { codeOf, div: cfg.div });
    for (const [, teamRows] of byTeam) {
      for (const r of teamRows) {
        if (r.date >= from && r.date <= to) leagueRows.push(r);
      }
    }
    const clubRows = byTeam.get(club.code);
    if (clubRows) sawClub = true;
    for (const r of clubRows ?? []) {
      if (r.date >= from && r.date <= to) rows.push(r);
    }
  }
  /* 讀到了季檔、隊卻整季不在裡面 = 對照的隊名有問題(或該隊當季在別的層級)——
     這要跟「涵蓋不足」分開講,不然拼字錯會偽裝成資料缺口。 */
  if (filesRead > 0 && !sawClub) {
    return { style: null, reason: `${club.code} 在 ${cfg.div} 季檔裡找不到(對照拼字或該隊當季不在此聯賽)` };
  }
  if (rows.length < minGames) {
    return { style: null, reason: `任期落在本站季檔涵蓋之外(涵蓋內只有 ${rows.length} 場)` };
  }
  return {
    style: {
      club: club.en, clubCode: club.code, leagueZh: cfg.zh,
      games: rows.length,
      span: { from: rows[0].date, to: rows.at(-1).date },
      clipped,
      perGame: avg(rows),
      leagueAvg: avg(leagueRows),
    },
  };
}
