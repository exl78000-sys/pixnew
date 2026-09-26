/* match-pool 的 worker:載引擎、把一場跑到完場、把快照送回去。(2026-09-26,D1b)
   跑法跟 test-game 原本的迴圈一樣:每 1/60 秒推一格、直到 over;差別是 over 每 60 格才查一次 ——
   量過:state() 每格呼叫一次佔一場 30% 的時間,而 advance() 在完場後是 no-op,所以事件流逐字相同。 */
import { parentPort, workerData } from 'node:worker_threads';

const { engineUrl, profile } = workerData;
const engines = new Map();   // 原始碼雜湊 → module;正式版用 engineUrl
const loadEngine = async source => {
  const k = source == null ? '' : source;
  if (!engines.has(k)) {
    engines.set(k, source == null
      ? await import(engineUrl)
      : await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')));
  }
  return engines.get(k);
};

parentPort.on('message', async ({ id, spec }) => {
  try {
    const eng = await loadEngine(spec.source ?? null);
    const opts = { profile, home: spec.home ?? 'ARS', away: spec.away ?? 'LIV', seed: spec.seed };
    if (spec.pred) opts.pred = spec.pred;
    const m = eng.createSim(opts);
    const N = Math.round((spec.minutes ?? 110) * 60 * 60);
    for (let i = 0; i < N; i++) {
      if (i % 60 === 0 && m.state().over) break;
      m.advance(1 / 60);
    }
    parentPort.postMessage({ id, snapshot: { state: m.state(), motion: m.motion(), events: m.events(), chains: m.chains() } });
  } catch (e) {
    parentPort.postMessage({ id, error: e?.stack ?? String(e) });
  }
});
