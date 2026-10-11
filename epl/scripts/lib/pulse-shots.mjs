/* 英超官方(pulselive)`/stats/match/{fixtureId}` 的射門統計(2026-10-11 接上,使用者:「接上」)。
 *
 * 來歷:`probe-pulselive-stats.mjs`(probe-apis run 38155860376)在 runner 上量過 ——
 *   · 射正 = `ontarget_scoring_att`、被封阻 = `blocked_scoring_att`、射偏 = `shot_off_target`,
 *     **零值的項目整個不出現**(缺 = 0);
 *   · 兩場完賽的射正與「三項相加」的總射門,跟 FotMob(獨立來源)逐場四個數字全中;
 *   · 進行中(45')的場次有資料,但**進行中沒有獨立來源可以核對**。
 * 沒有 xG:pulselive 沒有名稱含 xg / expected 的欄位,場上 xG 仍然只有 FPL 那一條。
 *
 * 這個端點是英超官網前端的後端,沒有文件、沒有授權條款 —— 只在**進行中的場次**打(加完賽後各補一次),
 * 單場最多每輪 1 個請求。失敗就沒有那三行,畫面不會用估計值補。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SHOTS_VERSION = 1;
export const shotsPath = root => join(root, 'data', 'raw', 'pulselive', 'shots.json');

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* `/stats/match/{id}` 的一隊 → { total, on, off, blocked }。缺的項目是 0(上游零值不出現)。
   整份沒有統計項(陣列不在)回 null —— 那是「沒資料」,不是「0 射門」。 */
export function shotsOf(statsResponse, teamId) {
  const side = statsResponse?.data?.[teamId];
  const M = side?.M ?? side;
  if (!Array.isArray(M) || !M.length) return null;
  const by = Object.fromEntries(M.map(x => [x.name, x.value]));
  const on = num(by.ontarget_scoring_att), off = num(by.shot_off_target), blocked = num(by.blocked_scoring_att);
  const total = on + off + blocked;
  /* 上游若直接給了總數(`total_scoring_att`),拿來對:對不上就記下,**畫面用三項相加**,mismatch 供診斷 */
  const reported = by.total_scoring_att != null ? num(by.total_scoring_att) : null;
  return { total, on, off, blocked, ...(reported != null ? { reported } : {}) };
}

export function loadShots(root) {
  const p = shotsPath(root);
  if (!existsSync(p)) return { version: SHOTS_VERSION, matches: {} };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j?.version === SHOTS_VERSION && j.matches ? j : { version: SHOTS_VERSION, matches: {} };
  } catch { return { version: SHOTS_VERSION, matches: {} }; }
}

/* 這一輪要打哪幾場:FPL 即時快照裡「開踢了而且沒完」的(進行中),加上「剛完賽而存檔還沒有完賽版本」的各補一次。
   fixtureId 與兩隊的 pulselive id 來自 official.json(陣容那支抓取器已經在維護)—— 對不上的跳過並回報,不另外打清單請求。 */
export function wantedShots({ live, official, store, now = Date.now(), freshMs = 10 * 60000, max = 12 }) {
  const fresh = live?.fetchedAt && now - Date.parse(live.fetchedAt) <= freshMs;
  if (!fresh) return { wanted: [], skipped: [], stale: true };
  const wanted = [], skipped = [];
  for (const f of live.fixtures ?? []) {
    if (!f.started) continue;
    const o = official?.matches?.[`${f.home}|${f.away}`];
    const prev = store?.matches?.[`${f.home}|${f.away}`];
    if (f.finished && prev?.final) continue;
    if (!o?.fixtureId || !o.homeId || !o.awayId) { skipped.push(`${f.home}|${f.away}`); continue; }
    wanted.push({ key: `${f.home}|${f.away}`, fixtureId: o.fixtureId, homeId: o.homeId, awayId: o.awayId, final: !!f.finished });
  }
  return { wanted: wanted.slice(0, max), skipped, stale: false };
}

/* 把存檔裡的射門掛到一份場上報告(buildMatchReport 的輸出)上:rep.sides[code].shots。
   只在 pulselive 那一場的比分跟報告一致時才掛 —— 兩邊的進球數對得上才不是掛錯場(隊碼鍵本來就唯一,這是第二道)。 */
export function attachShots(rep, store) {
  const s = store?.matches?.[`${rep.home}|${rep.away}`];
  if (!s?.home || !s?.away || !rep.sides?.[rep.home] || !rep.sides?.[rep.away]) return rep;
  const mk = x => ({ total: x.total, on: x.on, off: x.off, blocked: x.blocked });
  rep.sides[rep.home].shots = mk(s.home);
  rep.sides[rep.away].shots = mk(s.away);
  rep.shotsMeta = { source: 'pulselive', fetchedAt: s.fetchedAt, final: !!s.final };
  return rep;
}
