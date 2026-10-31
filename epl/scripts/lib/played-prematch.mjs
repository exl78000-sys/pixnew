/* 本季已完賽場次的「賽前預測」—— 走查回測(2026-10-31,使用者:「用回測的賽前預測補,畫面講明是回測」)。
 *
 * 為什麼需要:英冠德義法(西甲大半)已完賽的場次不留賽前預測 —— build 每次都用全部已知賽果重新配適,
 * 已完賽那一場的機率是「看過結果之後」算的,不能冒充賽前預測(build-league 那一行的註解)。所以賽程表的
 * 「模型」欄在這幾個聯賽永遠是空的。
 *
 * 這裡跑跟 `npm run backtests` **同一支** walkForward(lib/backtest.mjs):每一批只用那一批開賽**之前**的賽果配適
 * Poisson + Elo,兩者平均 —— 跟站上未賽場次的模型同一套。它**不是**當時站上顯示的那個數字(本站沒有存),
 * 畫面要講清楚是回測。
 *
 * 一批 = 一個 ISO 週(週一到週日),不是賽程的輪次:改期的比賽輪次小、踢得晚,照輪次分批的話
 * 「第 4 輪之前」會包含一場其實在第 9 輪之後才踢的比賽 —— 偷看未來。照週分批,只拿更早幾週已經踢完的比賽訓練,
 * 同一週裡的比賽彼此不互看。
 *
 * past:上一季(或更早)已完賽的聯賽場次,當訓練的起點;current:本季的場次(含未賽,這裡自己篩)。
 * 回傳 Map:`主|客|日期` → { home, draw, away, xgHome, xgAway }。 */
import { walkForward } from './backtest.mjs';
import { round } from './util.mjs';

const weekIndex = date => {
  const d = new Date(`${String(date).slice(0, 10)}T12:00:00Z`);
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return Math.floor(monday.getTime() / (7 * 86400e3));
};

export const prematchKey = m => `${m.home}|${m.away}|${String(m.date).slice(0, 10)}`;

export function playedPrematch({ past = [], current = [] } = {}) {
  const train = past.filter(m => m.played && !m.stage);
  const played = current.filter(m => m.played && !m.stage && m.date && Number.isFinite(m.fh) && Number.isFinite(m.fa));
  const out = new Map();
  if (!train.length || !played.length) return { byKey: out, games: 0, skipped: played.length };
  const tally = { home: 0, draw: 0, away: 0 };
  for (const m of train) tally[m.fh > m.fa ? 'home' : m.fh === m.fa ? 'draw' : 'away']++;
  const baseline = { home: tally.home / train.length, draw: tally.draw / train.length, away: tally.away / train.length };
  /* round 換成週序號:walkForward 的「之前」是 round 比較小的,換成週就是「更早的週」 */
  const test = played.map(m => ({ ...m, round: weekIndex(m.date) }));
  const wf = walkForward({ past: train, test, baseline });
  for (const r of wf.perMatch) {
    out.set(prematchKey(r), { home: r.pred.home, draw: r.pred.draw, away: r.pred.away, xgHome: r.pred.xgHome, xgAway: r.pred.xgAway });
  }
  const rps = wf.report.models.blend.rps;
  return { byKey: out, games: out.size, skipped: played.length - out.size, rps: rps == null ? null : round(rps, 4) };
}
