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
    const raw = store?.teams?.[row.code];
    if (!raw?.validation?.ok) return null;
    const totals = sumRows(Object.values(raw.situations ?? {}));
    const open = raw.situations?.OpenPlay;
    const speeds = raw.profile?.attackSpeed ?? {};
    const zones = raw.profile?.shotZone ?? {};
    const formationRows = Object.values(raw.profile?.formation ?? {});
    const formationMinutes = formationRows.reduce((n, x) => n + Number(x.time ?? 0), 0);
    const formations = formationRows
      .sort((a, b) => b.time - a.time)
      .map(x => ({ name: x.stat, minutes: x.time, share: round((x.time / (formationMinutes || 1)) * 100, 1) }));
    const fast = speeds.Fast ?? { xG: 0, shots: 0 };
    const boxShots = Number(zones.shotPenaltyArea?.shots ?? 0) + Number(zones.shotSixYardBox?.shots ?? 0);
    const setPieces = setPieceProfile(raw, row.p, { takers: { pen: [], fk: [], corner: [] } });
    return {
      code: row.code,
      source: 'Understat', sourceUrl: raw.url?.replace('/getTeamData/', '/team/'), matches: row.p,
      attack: {
        goals: row.gf, goals90: row.avgGF,
        shots: totals.shots, shots90: round(totals.shots / row.p, 2),
        xG: round(totals.xG, 2), xG90: round(totals.xG / row.p, 2),
        finishing: round(row.gf - totals.xG, 1),
        openPlayXG: round(Number(open?.xG ?? 0), 2), openPlayXG90: round(Number(open?.xG ?? 0) / row.p, 2),
        fastXGShare: round(totals.xG ? (Number(fast.xG ?? 0) / totals.xG) * 100 : 0, 1),
        boxShotShare: round(totals.shots ? (boxShots / totals.shots) * 100 : 0, 1),
      },
      defence: {
        conceded: row.ga, conceded90: row.avgGA,
        shots: totals.againstShots, shots90: round(totals.againstShots / row.p, 2),
        xGA: round(totals.xGA, 2), xGA90: round(totals.xGA / row.p, 2),
        overperform: round(totals.xGA - row.ga, 1), cleanSheets: row.cleanSheets,
      },
      setPieces,
      // `label` 是英超模板的共同欄位；`primary` 與 `list` 保留西甲來源語意。
      // Understat 沒有逐場位置座標，因此不填英超專用的 shape/def/mid/fwd。
      formation: { label: formations[0]?.name ?? null, primary: formations[0]?.name ?? null, list: formations, source: 'Understat' },
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
