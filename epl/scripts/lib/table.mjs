import { round } from './util.mjs';

const blank = () => ({ p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });

function apply(rec, gf, ga) {
  rec.p++; rec.gf += gf; rec.ga += ga;
  if (gf > ga) { rec.w++; rec.pts += 3; }
  else if (gf === ga) { rec.d++; rec.pts += 1; }
  else rec.l++;
}

// 單隊在一段賽程裡的攻守摘要。
// limit 從該隊按日期排序後的第一場開始算,所以 limit:10 就是「開季前 10 場」,
// 不會誤切成整個聯盟最早的 10 場。這份資料只供頁面呈現,不進預測模型。
export function teamRecord(matches, code, { limit = null } = {}) {
  const games = matches
    .filter(m => m.played && m.fh != null && m.fa != null && (m.home === code || m.away === code))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.round ?? 0) - (b.round ?? 0)));
  const selected = limit == null ? games : games.slice(0, limit);
  const rec = { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, cleanSheets: 0 };
  for (const m of selected) {
    const home = m.home === code;
    const gf = home ? m.fh : m.fa;
    const ga = home ? m.fa : m.fh;
    rec.p++;
    rec.gf += gf;
    rec.ga += ga;
    if (gf > ga) rec.w++;
    else if (gf === ga) rec.d++;
    else rec.l++;
    if (ga === 0) rec.cleanSheets++;
  }
  rec.gd = rec.gf - rec.ga;
  rec.winPct = round(rec.p ? (rec.w / rec.p) * 100 : 0, 1);
  rec.avgGF = rec.p ? round(rec.gf / rec.p, 2) : null;
  rec.avgGA = rec.p ? round(rec.ga / rec.p, 2) : null;
  return rec;
}

// 由賽果算出完整的球隊賽季檔案(積分榜 + 主客分段 + 半場行為 + 連續紀錄)
export function buildTable(matches, codes) {
  const rows = new Map();
  for (const c of codes) {
    rows.set(c, {
      code: c, ...blank(),
      home: blank(), away: blank(),
      cleanSheets: 0, failedToScore: 0, btts: 0, over25: 0,
      half: { gf1: 0, ga1: 0, gf2: 0, ga2: 0, htLead: 0, htLeadPts: 0, htTrail: 0, htTrailPts: 0, htLevel: 0, htLevelPts: 0, comeback: 0, collapse: 0, htSample: 0 },
      seq: [], biggestWin: null, biggestLoss: null,
    });
  }
  const played = matches.filter(m => m.played && rows.has(m.home) && rows.has(m.away));

  for (const m of played) {
    for (const side of ['home', 'away']) {
      const isHome = side === 'home';
      const code = isHome ? m.home : m.away;
      const opp = isHome ? m.away : m.home;
      const gf = isHome ? m.fh : m.fa;
      const ga = isHome ? m.fa : m.fh;
      const r = rows.get(code);
      apply(r, gf, ga);
      apply(r[side], gf, ga);
      if (ga === 0) r.cleanSheets++;
      if (gf === 0) r.failedToScore++;
      if (gf > 0 && ga > 0) r.btts++;
      if (gf + ga > 2.5) r.over25++;
      const pts = gf > ga ? 3 : gf === ga ? 1 : 0;
      r.seq.push({ date: m.date, opp, home: isHome, gf, ga, pts, id: m.id });
      const margin = gf - ga;
      if (!r.biggestWin || margin > r.biggestWin.margin) if (margin > 0) r.biggestWin = { margin, gf, ga, opp, home: isHome, date: m.date };
      if (!r.biggestLoss || margin < r.biggestLoss.margin) if (margin < 0) r.biggestLoss = { margin, gf, ga, opp, home: isHome, date: m.date };

      if (m.hh !== null) {
        const h = r.half;
        h.htSample++;
        const hf = isHome ? m.hh : m.ha, ha = isHome ? m.ha : m.hh;
        h.gf1 += hf; h.ga1 += ha;
        h.gf2 += gf - hf; h.ga2 += ga - ha;
        if (hf > ha) { h.htLead++; h.htLeadPts += pts; if (pts === 0) h.collapse++; }
        else if (hf < ha) { h.htTrail++; h.htTrailPts += pts; if (pts === 3) h.comeback++; }
        else { h.htLevel++; h.htLevelPts += pts; }
      }
    }
  }

  for (const r of rows.values()) {
    r.seq.sort((a, b) => (a.date < b.date ? -1 : 1));
    r.gd = r.gf - r.ga;
    r.ppg = round(r.p ? r.pts / r.p : 0, 2);
    r.home.ppg = round(r.home.p ? r.home.pts / r.home.p : 0, 2);
    r.away.ppg = round(r.away.p ? r.away.pts / r.away.p : 0, 2);
    r.homeAwayGap = round(r.home.ppg - r.away.ppg, 2);
    r.form = r.seq.slice(-6).map(x => (x.pts === 3 ? 'W' : x.pts === 1 ? 'D' : 'L'));
    r.streak = currentStreak(r.seq);
    r.longest = longestRuns(r.seq);
    r.avgGF = round(r.p ? r.gf / r.p : 0, 2);
    r.avgGA = round(r.p ? r.ga / r.p : 0, 2);
    r.bttsPct = round(r.p ? (r.btts / r.p) * 100 : 0, 1);
    r.over25Pct = round(r.p ? (r.over25 / r.p) * 100 : 0, 1);
    const h = r.half;
    h.leadHoldPct = h.htLead ? round((h.htLeadPts / (h.htLead * 3)) * 100, 1) : null;
    h.trailRescuePct = h.htTrail ? round((h.htTrailPts / (h.htTrail * 3)) * 100, 1) : null;
    h.secondHalfSwing = round(h.gf2 - h.ga2 - (h.gf1 - h.ga1), 2); // 下半場淨勝球 - 上半場淨勝球
  }

  const table = [...rows.values()].sort(
    (a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.code.localeCompare(b.code)
  );
  table.forEach((r, i) => { r.pos = i + 1; });
  return table;
}

function currentStreak(seq) {
  if (!seq.length) return { type: '-', len: 0 };
  const t = seq.at(-1).pts === 3 ? 'W' : seq.at(-1).pts === 1 ? 'D' : 'L';
  let len = 0;
  for (let i = seq.length - 1; i >= 0; i--) {
    const k = seq[i].pts === 3 ? 'W' : seq[i].pts === 1 ? 'D' : 'L';
    if (k === t) len++; else break;
  }
  return { type: t, len };
}

function longestRuns(seq) {
  const best = { win: 0, unbeaten: 0, winless: 0, cleanSheet: 0, scoring: 0 };
  let win = 0, unb = 0, winless = 0, cs = 0, sc = 0;
  for (const g of seq) {
    win = g.pts === 3 ? win + 1 : 0;
    unb = g.pts > 0 ? unb + 1 : 0;
    winless = g.pts < 3 ? winless + 1 : 0;
    cs = g.ga === 0 ? cs + 1 : 0;
    sc = g.gf > 0 ? sc + 1 : 0;
    best.win = Math.max(best.win, win);
    best.unbeaten = Math.max(best.unbeaten, unb);
    best.winless = Math.max(best.winless, winless);
    best.cleanSheet = Math.max(best.cleanSheet, cs);
    best.scoring = Math.max(best.scoring, sc);
  }
  return best;
}

// 兩隊交手紀錄(跨賽季)
export function headToHead(matches, a, b) {
  const games = matches.filter(m => m.played && ((m.home === a && m.away === b) || (m.home === b && m.away === a)));
  const rec = { games: games.length, aWin: 0, draw: 0, bWin: 0, aGoals: 0, bGoals: 0, list: [] };
  for (const m of games) {
    const aHome = m.home === a;
    const ag = aHome ? m.fh : m.fa, bg = aHome ? m.fa : m.fh;
    rec.aGoals += ag; rec.bGoals += bg;
    if (ag > bg) rec.aWin++; else if (ag === bg) rec.draw++; else rec.bWin++;
    rec.list.push({ season: m.season, date: m.date, home: m.home, away: m.away, fh: m.fh, fa: m.fa });
  }
  rec.list.sort((x, y) => (x.date < y.date ? 1 : -1));
  return rec;
}
