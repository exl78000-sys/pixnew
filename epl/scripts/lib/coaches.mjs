import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { round } from './util.mjs';

// 用任期區間切分比賽,算出每位教練的實際戰績
export function recordFor(matches, code, from, to) {
  const rec = { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
  for (const m of matches) {
    if (!m.played || (m.home !== code && m.away !== code)) continue;
    if (from && m.date < from) continue;
    if (to && m.date > to) continue;
    const isHome = m.home === code;
    const gf = isHome ? m.fh : m.fa, ga = isHome ? m.fa : m.fh;
    rec.p++; rec.gf += gf; rec.ga += ga;
    if (gf > ga) { rec.w++; rec.pts += 3; }
    else if (gf === ga) { rec.d++; rec.pts += 1; }
    else rec.l++;
  }
  rec.ppg = round(rec.p ? rec.pts / rec.p : 0, 2);
  rec.winPct = round(rec.p ? (rec.w / rec.p) * 100 : 0, 1);
  return rec;
}

export function buildCoaches(root, { allMatches, seasonMatches, season }) {
  const raw = JSON.parse(readFileSync(join(root, 'data', 'manual', 'coaches.json'), 'utf8'));
  const coaches = raw.coaches.map(c => {
    const spells = (c.spells || []).map(s => ({
      name: s.name ?? c.name,
      zh: s.zh ?? c.zh,
      from: s.from ?? null,
      to: s.to ?? null,
      current: !s.to,
      confidence: s.confidence ?? c.confidence,
      seasonRecord: recordFor(seasonMatches, c.team, s.from, s.to),
      allRecord: recordFor(allMatches, c.team, s.from, s.to),
    }));
    const current = spells.find(s => s.current) ?? spells[0] ?? null;
    return {
      team: c.team,
      name: c.name, zh: c.zh, nat: c.nat,
      confidence: c.confidence,
      formation: c.formation, style: c.style ?? [], note: c.note ?? '',
      since: current?.from ?? null,
      tenureDays: current?.from ? Math.floor((Date.now() - new Date(current.from)) / 86400000) : null,
      seasonRecord: current?.seasonRecord ?? null,
      allRecord: current?.allRecord ?? null,
      spells,
      predecessors: spells.filter(s => !s.current),
    };
  });
  return { asOf: raw._asOf, disclaimer: raw._disclaimer, note: raw._note, season, coaches };
}
