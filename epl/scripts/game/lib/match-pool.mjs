/* 完整模擬的 worker 池(2026-09-26,D1b)。

   為什麼:test-game.mjs 的「賽後判讀」那一節要跑二十幾場完整的連續模擬(ARS vs LIV,不同種子),
   每一場在 Node 裡約 8 秒、彼此完全獨立,原本一場接一場跑 —— 逐區塊計時那一節 411 秒,整支 npm test
   的 91%,而且它在部署 workflow 裡成了關鍵路徑(runner 上 15 分鐘)。
   引擎是決定性的(同種子同一場,結構不變量那一節守著),所以同一個 (種子, 賽前預測, 引擎版本) 的比賽
   只需要跑一次,而且可以丟到別的執行緒去跑:這裡開 os.availableParallelism() 個 worker 分著跑,
   結果以**快照**回來(state / motion / events / chains 四個純資料物件),測試拿到的東西跟原本
   跑完才呼叫 sim.state() 一模一樣 —— 差別只在不能再 advance()(快照沒有引擎)。

   **不能拿它做的事**:要逐格觀察的測試(體能 vmax 逐格不增那一條)仍然自己跑;
   「同種子跑兩次逐字相同」那類測試也不能走快取 —— 走了就是拿同一個物件比自己。 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* 快照包成「像 sim 的東西」:既有的測試寫 sim.state().counts / sim.events() / sim.motion(),
   不用改讀法。advance 一律拋錯 —— 靜靜回 0 的話,誤用快照的測試會在「沒有推進」上綠掉。 */
export const asSim = snap => ({
  state: () => snap.state,
  motion: () => snap.motion,
  events: () => snap.events,
  chains: () => snap.chains,
  advance: () => { throw new Error('這是 worker 池的快照,不能再 advance();要逐格觀察的測試請自己 createSim'); },
});

/* spec:{ seed, pred = null, home = 'ARS', away = 'LIV', minutes = 110, source = null }
   source 給引擎的**原始碼文字**時,worker 從 data: URL 載那一份(對照版實驗用);不給就載 web/assets/js/game-sim.js。
   鍵用內容:同一份原始碼不論傳幾次都是同一把鍵。 */
const keyOf = spec => JSON.stringify({
  seed: spec.seed, pred: spec.pred ?? null, home: spec.home ?? 'ARS', away: spec.away ?? 'LIV',
  minutes: spec.minutes ?? 110,
  source: spec.source == null ? null : createHash('sha1').update(spec.source).digest('hex'),
});

export function createMatchPool({ root, profile, workers = Math.max(1, availableParallelism()) }) {
  const engineUrl = String(new URL('../../../web/assets/js/game-sim.js', import.meta.url));
  const pending = new Map();     // key → { spec, resolve, reject }
  const done = new Map();        // key → Promise<snapshot>
  const queue = [];
  const pool = [];
  let seq = 0;
  let closed = false;

  const spawnWorker = () => {
    const w = new Worker(join(HERE, 'match-worker.mjs'), { workerData: { engineUrl, profile } });
    const entry = { w, busy: null };
    w.on('message', msg => {
      const job = entry.busy;
      entry.busy = null;
      if (job) (msg.error ? job.reject(new Error(`worker 跑 ${job.key} 失敗:${msg.error}`)) : job.resolve(msg.snapshot));
      pump();
      if (!entry.busy) entry.w.unref();   // 沒有下一件就放手,不擋 process 結束
    });
    w.on('error', e => { if (entry.busy) entry.busy.reject(e); entry.busy = null; entry.w.unref(); });
    /* 閒置的 worker unref:池子還活著也不擋 process 結束 —— 測試跑完就直接結束,不必記得 close。
       **有工作時要 ref 回來**,不然主程式在 await 快照的時候事件迴圈沒有東西撐著,會直接退出
       (Node 印「unsettled top-level await」)。第一版就是派工之後立刻 unref,踩到了。 */
    w.unref();
    pool.push(entry);
    return entry;
  };

  const pump = () => {
    for (const entry of pool) {
      if (entry.busy || !queue.length) continue;
      const job = queue.shift();
      entry.busy = job;
      entry.w.ref();
      entry.w.postMessage({ id: ++seq, spec: job.spec });
    }
  };

  const get = spec => {
    if (closed) return Promise.reject(new Error('池子已關'));
    const key = keyOf(spec);
    if (done.has(key)) return done.get(key);
    const p = new Promise((resolve, reject) => {
      queue.push({ key, spec, resolve, reject });
      if (pool.length < workers) spawnWorker();
      pump();
    });
    done.set(key, p);
    pending.set(key, spec);
    return p;
  };

  return {
    /* 先排進去、不等結果:讓 worker 在前面那些不用模擬的斷言跑的時候就開始算。 */
    warm: specs => { for (const s of specs) get(s); },
    get: async spec => asSim(await get(spec)),
    close: async () => { closed = true; await Promise.all(pool.map(e => e.w.terminate())); },
    size: () => pool.length,
  };
}
