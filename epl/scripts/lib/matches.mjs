import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// openfootball 的比分有兩種格式:
//   {"score":{"ft":[2,1],"ht":[1,0]}}  一般情形
//   {"score":[0,0]}                    部分 0-0 只給陣列(無半場)
function readScore(score) {
  if (!score) return null;
  if (Array.isArray(score)) {
    const ft = score.map(Number);
    // 0-0 收場,半場必然也是 0-0,可安全補上;其餘不臆測
    const ht = ft[0] === 0 && ft[1] === 0 ? [0, 0] : null;
    return { ft, ht };
  }
  if (!score.ft) return null;
  return { ft: score.ft.map(Number), ht: score.ht ? score.ht.map(Number) : null };
}

const roundNo = r => {
  const m = /(\d+)/.exec(r || '');
  return m ? Number(m[1]) : null;
};

export function loadSeason(root, season, codeOf) {
  const raw = JSON.parse(readFileSync(join(root, 'data', 'raw', 'openfootball', `${season}.json`), 'utf8'));
  const out = [];
  raw.matches.forEach((m, i) => {
    const home = codeOf(m.team1), away = codeOf(m.team2);
    if (!home || !away) throw new Error(`隊名無法對照:${m.team1} / ${m.team2}(請補 data/manual/teams.json)`);
    const s = readScore(m.score);
    out.push({
      id: `${season}-${i}`,
      season,
      round: roundNo(m.round),
      date: m.date,
      time: m.time || null,
      home, away,
      played: !!s,
      fh: s ? s.ft[0] : null,
      fa: s ? s.ft[1] : null,
      hh: s?.ht ? s.ht[0] : null,
      ha: s?.ht ? s.ht[1] : null,
    });
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export const result = m => (m.fh > m.fa ? 'W' : m.fh < m.fa ? 'L' : 'D'); // 以主隊視角
export const pointsFor = (m, code) => {
  const isHome = m.home === code;
  const gf = isHome ? m.fh : m.fa, ga = isHome ? m.fa : m.fh;
  return gf > ga ? 3 : gf === ga ? 1 : 0;
};
