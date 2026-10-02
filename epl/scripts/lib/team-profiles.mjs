/* 球隊側寫(戰術頁的資料):Understat 的**球隊情境統計**(運動戰 / 定位球 / 反擊、攻擊速度、射門區域、陣型使用時間)
   + 本站上季積分表(勝負、半場、主客)。原本寫在 build-laliga.mjs 裡;2026-10-02 德義法也要用,搬到這裡共用 ——
   **同一個量兩個來源**的話,改了一邊另一邊會悄悄過期。西甲的 tactics.json 搬家前後逐位元組相同(比過)。 */
import { percentile, round } from './util.mjs';
import { setPieceProfile } from './tactics.mjs';

export const sumRows = rows => ({
  shots: rows.reduce((n, x) => n + Number(x?.shots ?? 0), 0),
  xG: rows.reduce((n, x) => n + Number(x?.xG ?? 0), 0),
  againstShots: rows.reduce((n, x) => n + Number(x?.against?.shots ?? 0), 0),
  xGA: rows.reduce((n, x) => n + Number(x?.against?.xG ?? 0), 0),
});

export function buildTeamProfiles(tableRows, store) {
  const profiles = tableRows.map(row => {
    const raw0 = store?.teams?.[row.code];
    if (!raw0?.validation?.ok) return null;
    const raw = raw0.source ? raw0 : { ...raw0, source: store.source };
    const totals = sumRows(Object.values(raw.situations ?? {}));
    /* 每場平均的分母用**這份資料實際涵蓋的場數**(2026-10-02,英冠 FotMob 少了兩場聯賽)。Understat 的場數
       核對時就等於積分表的場數,所以西甲照舊是 row.p(輸出逐位元組相同)。拿整季進球去比 xG 的兩項(終結、防守超額)
       在場數不齊時沒有意義 —— 給空值,不硬算。 */
    const n = raw.matches ?? row.p;
    const full = n === row.p;
    const open = raw.situations?.OpenPlay;
    const speeds = raw.profile?.attackSpeed ?? {};
    const zones = raw.profile?.shotZone ?? {};
    const formationRows = Object.values(raw.profile?.formation ?? {});
    const formationMinutes = formationRows.reduce((n, x) => n + Number(x.time ?? 0), 0);
    /* 單位:Understat 是出場分鐘;FotMob 只有每場的先發陣型 → 'starts'(場次)。頁面照單位印標籤。 */
    const starts = raw.profile?.formationUnit === 'starts';
    const formations = formationRows
      .sort((a, b) => b.time - a.time)
      .map(x => (starts
        ? { name: x.stat, starts: x.time, minutes: null, share: round((x.time / (formationMinutes || 1)) * 100, 1) }
        : { name: x.stat, minutes: x.time, share: round((x.time / (formationMinutes || 1)) * 100, 1) }));
    const fast = speeds.Fast ?? { xG: 0, shots: 0 };
    const boxShots = Number(zones.shotPenaltyArea?.shots ?? 0) + Number(zones.shotSixYardBox?.shots ?? 0);
    const setPieces = setPieceProfile(raw, n, { takers: { pen: [], fk: [], corner: [] } });
    return {
      code: row.code,
      source: raw.source ?? 'Understat', sourceUrl: raw.url?.replace('/getTeamData/', '/team/'), matches: row.p,
      ...(full ? {} : { coverage: { matches: n, of: row.p } }),
      attack: {
        goals: row.gf, goals90: row.avgGF,
        shots: totals.shots, shots90: round(totals.shots / n, 2),
        xG: round(totals.xG, 2), xG90: round(totals.xG / n, 2),
        finishing: full ? round(row.gf - totals.xG, 1) : null,
        openPlayXG: round(Number(open?.xG ?? 0), 2), openPlayXG90: round(Number(open?.xG ?? 0) / n, 2),
        fastXGShare: round(totals.xG ? (Number(fast.xG ?? 0) / totals.xG) * 100 : 0, 1),
        boxShotShare: round(totals.shots ? (boxShots / totals.shots) * 100 : 0, 1),
      },
      defence: {
        conceded: row.ga, conceded90: row.avgGA,
        shots: totals.againstShots, shots90: round(totals.againstShots / n, 2),
        xGA: round(totals.xGA, 2), xGA90: round(totals.xGA / n, 2),
        overperform: full ? round(totals.xGA - row.ga, 1) : null, cleanSheets: row.cleanSheets,
      },
      setPieces,
      // `label` 是英超模板的共同欄位；`primary` 與 `list` 保留西甲來源語意。
      // Understat 沒有逐場位置座標，因此不填英超專用的 shape/def/mid/fwd。
      formation: { label: formations[0]?.name ?? null, primary: formations[0]?.name ?? null, list: formations, source: raw.source ?? 'Understat',
        ...(starts ? { unit: 'starts' } : {}) },
      tempo: { ...row.half },
      resilience: {
        leadHoldPct: row.half.leadHoldPct, trailRescuePct: row.half.trailRescuePct,
        comeback: row.half.comeback, collapse: row.half.collapse,
      },
      homeAwayGap: row.homeAwayGap, homePpg: row.home.ppg, awayPpg: row.away.ppg, ppg: row.ppg,
    };
  }).filter(Boolean);

  const resilience = t => ((t.resilience.leadHoldPct ?? 0) + (t.resilience.trailRescuePct ?? 0) * 1.5) / 2;
  const axes = [
    { label: '進攻 xG', get: t => t.attack.xG90 },
    { label: '防守穩固', get: t => t.defence.xGA90, inverse: true },
    { label: '運動戰創造', get: t => t.attack.openPlayXG90 },
    { label: '定位球威脅', get: t => t.setPieces.xG90 },
    { label: '快速進攻', get: t => t.attack.fastXGShare },
    { label: '比賽韌性', get: resilience },
  ];
  const rank = (target, get, desc = true) => [...profiles]
    .sort((a, b) => desc ? get(b) - get(a) : get(a) - get(b))
    .findIndex(x => x.code === target.code) + 1;
  for (const t of profiles) {
    t.radar = axes.map(a => ({
      label: a.label,
      value: a.inverse
        ? round(100 - percentile(a.get(t), profiles.map(a.get)), 1)
        : percentile(a.get(t), profiles.map(a.get)),
      raw: round(a.get(t), 3),
    }));
    t.tags = [];
    if (rank(t, x => x.attack.xG90) <= 5) t.tags.push('xG 火力前段');
    if (rank(t, x => x.defence.xGA90, false) <= 5) t.tags.push('防守數據前段');
    if (rank(t, x => x.attack.openPlayXG90) <= 5) t.tags.push('運動戰創造前段');
    if (rank(t, x => x.setPieces.xG90) <= 5) t.tags.push('定位球強權');
    if (rank(t, x => x.attack.fastXGShare) <= 5) t.tags.push('快速轉換');
    if (rank(t, x => x.attack.boxShotShare) <= 5) t.tags.push('禁區內取向');
    if (t.attack.finishing >= 5) t.tags.push('超額終結');
    if (t.attack.finishing <= -5) t.tags.push('浪費機會');
    if (t.homeAwayGap >= 0.8) t.tags.push('主場龍');
    if ((t.resilience.leadHoldPct ?? 100) <= 65) t.tags.push('守不住領先');
  }
  return profiles;
}


/* ── FotMob 逐場 → Understat 形狀的球隊情境統計(2026-10-02,英冠的戰術頁)──
   Understat 不做英冠(實測過),但 FotMob 的逐場統計每一腳射門都帶情境、xG、是否在禁區、是不是進球,
   每場還有正式名單的陣型。照 Understat 那一份的形狀加總,buildTeamProfiles 一行不用改:
     情境:RegularPlay / FastBreak / IndividualPlay → OpenPlay;FromCorner;SetPiece / ThrowInSetPiece → SetPiece;
           FreeKick → DirectFreekick;Penalty。烏龍球不算任何一方的射門。
     攻擊速度:FastBreak 那一份當 Fast(Understat 的「快速進攻」);射門區域:禁區內的射門數。
     陣型:每場的先發陣型,單位是**場次**(formationUnit 'starts'),不是出場分鐘。
   **只收聯賽場次**(leagueKeys,不含升級附加賽);比分在 loadFotmobMatchStats 已逐場對回本站賽果。
   場數差積分表兩場以內照收(每場平均用實際場數當分母,見 buildTeamProfiles),差更多就不收。 */
const SIT = { RegularPlay: 'OpenPlay', FastBreak: 'OpenPlay', IndividualPlay: 'OpenPlay', FromCorner: 'FromCorner',
  SetPiece: 'SetPiece', ThrowInSetPiece: 'SetPiece', FreeKick: 'DirectFreekick', Penalty: 'Penalty' };
const zero = () => ({ shots: 0, goals: 0, xG: 0, against: { shots: 0, goals: 0, xG: 0 } });
export function fotmobTeamStore({ matches, season, tableRows, leagueKeys, maxMissing = 2 }) {
  const teams = {};
  const byCode = new Map(tableRows.map(r => [r.code, r]));
  for (const row of tableRows) {
    const code = row.code;
    const sit = Object.fromEntries(['OpenPlay', 'FromCorner', 'SetPiece', 'DirectFreekick', 'Penalty'].map(k => [k, zero()]));
    const fast = { shots: 0, xG: 0 }; let box = 0, n = 0; const form = {};
    for (const m of Object.values(matches)) {
      if (m.season !== season || (m.home !== code && m.away !== code)) continue;
      if (leagueKeys && !leagueKeys.has(`${m.season}|${m.home}|${m.away}`)) continue;
      n++;
      const f = m.lineups?.[code]?.formation;
      if (f) form[f] = (form[f] ?? 0) + 1;
      for (const s of m.shots ?? []) {
        if (s.ownGoal) continue;
        const k = SIT[s.situation] ?? 'OpenPlay';
        const mine = s.team === code;
        const o = mine ? sit[k] : sit[k].against;
        o.shots++; o.xG += Number(s.xg ?? 0); if (s.type === 'Goal') o.goals++;
        if (mine && s.situation === 'FastBreak') { fast.shots++; fast.xG += Number(s.xg ?? 0); }
        if (mine && s.inBox) box++;
      }
    }
    if (!n) continue;
    const r4 = v => Math.round(v * 1e4) / 1e4;
    for (const v of Object.values(sit)) { v.xG = r4(v.xG); v.against.xG = r4(v.against.xG); }
    const sum = ks => ks.reduce((a, k) => ({ shots: a.shots + sit[k].shots, goals: a.goals + sit[k].goals, xG: r4(a.xG + sit[k].xG),
      against: { shots: a.against.shots + sit[k].against.shots, goals: a.against.goals + sit[k].against.goals, xG: r4(a.against.xG + sit[k].against.xG) } }), zero());
    const all = sum(Object.keys(sit));
    const full = n === row.p;
    teams[code] = {
      url: null, matches: n, situations: sit,
      nonPenaltySetPiece: sum(['FromCorner', 'SetPiece', 'DirectFreekick']),
      profile: {
        formation: Object.fromEntries(Object.entries(form).map(([k, v]) => [k, { stat: k, time: v }])), formationUnit: 'starts',
        attackSpeed: { Fast: { shots: fast.shots, xG: r4(fast.xG) } },
        shotZone: { shotPenaltyArea: { shots: box }, shotSixYardBox: { shots: 0 } },
      },
      validation: {
        ok: row.p - n <= maxMissing && n > 0, matches: n, expectedMatches: row.p, scorelinesReconciled: true,
        // 進球分類要整季都在才比得了;少場的隊一律當作對不回(進球數不顯示,xG 照用)
        situationGoalsReconciled: full && all.goals === row.gf && all.against.goals === row.ga,
      },
    };
    teams[code].source = 'FotMob';
  }
  const okAll = tableRows.every(r => teams[r.code]?.validation?.ok);
  return { season, source: 'FotMob', complete: okAll, validation: { allScorelinesReconciled: okAll }, teams };
}
