/* 英超戰情室 —— 點火器 + 看門狗(Cloudflare Worker)
 *
 * 為什麼需要它:GitHub 的 schedule 是 best-effort,實測過去七天
 * 「完全沒有 job 在跑」的空窗中位數 43 分鐘(設定是 15 分鐘)、
 * 只有 5% 在 20 分鐘內接上、38 段超過 45 分鐘、最長一段 44 小時。
 * 長迴圈保護的是「已經進場之後」,保護不了**進場那一刻** ——
 * 2026-08-29 西甲 LEV vs BET 就是這樣整場零覆蓋。
 *
 * 這支做兩件事,都不碰資料:
 *   1. 點火:該進場而沒有 job 在跑 → 叫 GitHub 開比賽日迴圈。
 *   2. 看門狗:比賽正在踢而 feed 不新鮮 → 補派送,過久則告警。
 * 外加一件小的:當天最後一場結束後,補一次完整建置與部署。
 *
 * 三條刻意的設計:
 *
 * - **無狀態**。每次執行都從公開的靜態檔重算,不用 KV
 *   (免費版 KV 每天 1000 次寫入,兩個聯賽的高頻輪詢會擦邊),
 *   掛掉重啟沒有恢復問題。冪等性靠「派送前先查有沒有 job 在跑」。
 * - **窗口故意比工作流程寬**。這裡只是扳機,真正的判斷仍在
 *   `scripts/live-window.mjs`(工作流程第一步就會用它,不該進場的
 *   幾秒內就結束)。所以寧可多扳幾次,也不要漏掉開賽那一刻 ——
 *   兩邊不是同一份邏輯,也**不應該**是:複製那份 Node 判斷過來,
 *   改了一邊另一邊會悄悄過期。
 * - **永遠不擋自己**。任何一步失敗都只記錄、繼續下一個聯賽;
 *   一支會拋例外的看門狗比沒有看門狗更糟。
 */

const LEAGUES = [
  { key: 'pl', zh: '英超', workflow: 'epl-matchday.yml', fixtures: 'data/fixtures.json', meta: 'data/meta.json' },
  { key: 'es1', zh: '西甲', workflow: 'laliga-matchday.yml', fixtures: 'data/leagues/es1/fixtures.json', meta: 'data/leagues/es1/meta.json' },
];
const DEPLOY_WORKFLOW = 'epl-live.yml';

// 分鐘。窗口比工作流程的(開賽前 75 / 後 140)寬,理由見檔頭。
const PRE_MIN = 95;
const POST_MIN = 155;
const LIVE_POST_MIN = 115;    // 「現在應該正在踢」的範圍(看門狗用)
const STALE_MIN = 6;          // feed 超過這麼久沒更新就是不對(迴圈正常 2~3 分鐘一次)
const ALERT_MIN = 15;         // 超過這麼久才告警 —— 6 分鐘可能只是剛好卡在兩次之間
const DEPLOY_AFTER_MIN = 30;  // 當天最後一場結束多久之後補一次部署

const nowMs = () => Date.now();
const mins = ms => ms / 60000;

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
  return res.json();
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      // GitHub 要求帶 UA,少了會 403 —— 而 403 看起來像權限不足,會查錯方向
      'user-agent': 'warroom-ignition-worker',
      ...(init.headers ?? {}),
    },
  });
}

/* 已經有 job 在跑(或排隊中)就不要再派送。這是冪等性的來源 ——
   無狀態設計沒有「我剛剛派過了」的記憶,所以每次都問 GitHub。 */
async function runState(env, workflow) {
  for (const status of ['in_progress', 'queued']) {
    let res;
    try { res = await gh(env, `/actions/workflows/${workflow}/runs?status=${status}&per_page=1`); }
    catch { return 'unknown'; }
    /* **問不到不等於忙**。原本這裡回 true(當成忙),於是 token 過期或被撤銷時
       每一次都「不重複派送」—— 看門狗永遠不動,而且沒有任何地方會講。
       那正是這支 Worker 要消滅的故障形態,自己卻犯了。
       分成三態:不知道就照實說不知道,由呼叫端決定要不要告警。 */
    if (!res.ok) return 'unknown';
    const j = await res.json().catch(() => null);
    if (!j) return 'unknown';
    if ((j.total_count ?? 0) > 0) return 'busy';
  }
  return 'idle';
}

async function dispatch(env, workflow, why, log, dryRun = false) {
  const state = await runState(env, workflow);
  if (state === 'busy') { log.push(`· ${workflow} 已在執行,不重複派送(${why})`); return false; }
  if (state === 'unknown') {
    // 該動而動不了 —— 這種時候一定要吵,不然就是靜靜地什麼都沒做
    log.push(`✗ 問不到 ${workflow} 的執行狀態(token 失效?),沒有派送:${why}`);
    await alert(env, `⚠ 點火器問不到 GitHub 的執行狀態,無法派送 ${workflow}(${why})。請檢查 GITHUB_TOKEN 是否過期或權限被改。`, log);
    return false;
  }
  if (dryRun) { log.push(`· [唯讀模式] 這裡本來會派送 ${workflow}:${why}`); return false; }
  const res = await gh(env, `/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: env.BRANCH }),
  });
  if (res.ok) { log.push(`✔ 派送 ${workflow}:${why}`); return true; }
  /* 派送失敗也要吵。authHealth 只驗得到**讀**的權限(它打的是唯讀端點),
     token 若只給了 Actions: Read,一路到真的要派送才會 403 —— 而那通常
     發生在比賽開打那一刻。同理 422 多半是 BRANCH 指到不存在的分支。 */
  const hint = res.status === 403 ? 'token 沒有 Actions: Write(只給了 Read?)'
    : res.status === 422 ? `分支 ${env.BRANCH} 不存在或不能派送`
    : `HTTP ${res.status}`;
  log.push(`✗ 派送 ${workflow} 失敗:${hint}`);
  await alert(env, `⚠ 點火器派送 ${workflow} 失敗:${hint}(原因:${why})`, log);
  return false;
}

async function alert(env, text, log) {
  if (!env.ALERT_WEBHOOK) { log.push(`⚠ ${text}(未設定 ALERT_WEBHOOK,只記錄)`); return; }
  try {
    // Discord 與 Slack 都吃 { content } / { text },兩個都給,對方忽略不認得的那個
    await fetch(env.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
    });
    log.push(`⚠ 已告警:${text}`);
  } catch (e) { log.push(`✗ 告警送不出去:${e.message}`); }
}

/* 一個聯賽的檢查。回傳這個聯賽的觀察結果(給 /status 用)。 */
async function checkLeague(env, lg, log, dryRun = false) {
  const out = { league: lg.key, zh: lg.zh, window: false, live: 0, feedAgeMin: null, dispatched: false };
  let fixtures;
  try {
    fixtures = await getJson(`${env.SITE}/${lg.fixtures}?t=${nowMs()}`);
  } catch (e) { log.push(`✗ ${lg.zh} 賽程讀不到:${e.message}`); return out; }

  const t = nowMs();
  // kickoff 是 null 的不算 —— 上游逐月才公布開球時間,那些場次判斷不了
  const withKo = (Array.isArray(fixtures) ? fixtures : []).filter(f => !f.played && f.kickoff);
  const inWindow = withKo.filter(f => {
    const d = mins(t - Date.parse(f.kickoff));
    return d >= -PRE_MIN && d <= POST_MIN;
  });
  const shouldBeLive = withKo.filter(f => {
    const d = mins(t - Date.parse(f.kickoff));
    return d >= 0 && d <= LIVE_POST_MIN;
  });
  out.window = inWindow.length > 0;
  out.live = shouldBeLive.length;

  if (inWindow.length) {
    out.dispatched = await dispatch(env, lg.workflow, `${lg.zh} ${inWindow.length} 場在窗口內`, log, dryRun);
  }

  // 看門狗:現在應該有比賽在踢,那 feed 就該是新的
  if (shouldBeLive.length) {
    try {
      const meta = await getJson(`${env.SITE}/${lg.meta}?t=${nowMs()}`);
      const feedUrl = meta.liveFeed;
      if (feedUrl) {
        const feed = await getJson(`${feedUrl}${feedUrl.includes('?') ? '&' : '?'}t=${nowMs()}`);
        const age = feed.fetchedAt ? mins(t - Date.parse(feed.fetchedAt)) : null;
        out.feedAgeMin = age === null ? null : Math.round(age);
        if (age !== null && age > STALE_MIN) {
          log.push(`· ${lg.zh} feed 已 ${Math.round(age)} 分鐘沒更新(應有 ${shouldBeLive.length} 場在踢)`);
          await dispatch(env, lg.workflow, `${lg.zh} feed 過期 ${Math.round(age)} 分`, log, dryRun);
          if (age > ALERT_MIN) {
            await alert(env, `⚽ ${lg.zh}:有 ${shouldBeLive.length} 場在踢,但即時資料已 ${Math.round(age)} 分鐘沒更新。已自動補派送 ${lg.workflow}。`, log);
          }
        }
      }
    } catch (e) { log.push(`✗ ${lg.zh} feed 檢查失敗:${e.message}`); }
  }
  return out;
}

/* 收工部署:當天最後一場結束一段時間後,補一次完整建置與部署。
   判斷完全無狀態 —— 拿「最後一場結束時間」跟「最後一次 epl-live 開跑時間」比。 */
async function closingDeploy(env, results, log, dryRun = false) {
  try {
    const all = [];
    for (const lg of LEAGUES) {
      const fx = await getJson(`${env.SITE}/${lg.fixtures}?t=${nowMs()}`).catch(() => []);
      for (const f of Array.isArray(fx) ? fx : []) if (f.kickoff) all.push(Date.parse(f.kickoff));
    }
    const t = nowMs();
    // 今天已經開球、而且已經踢完的最後一場
    const ended = all.filter(k => Number.isFinite(k) && t - k > LIVE_POST_MIN * 60000
      && mins(t - k) < 24 * 60);
    if (!ended.length) return false;
    const lastEnd = Math.max(...ended) + LIVE_POST_MIN * 60000;
    const since = mins(t - lastEnd);
    if (since < DEPLOY_AFTER_MIN || since > DEPLOY_AFTER_MIN + 30) return false;   // 只在收工後那半小時內做一次

    const res = await gh(env, `/actions/workflows/${DEPLOY_WORKFLOW}/runs?per_page=1`);
    if (!res.ok) return false;
    const j = await res.json();
    const lastRun = j.workflow_runs?.[0]?.run_started_at;
    if (lastRun && Date.parse(lastRun) > lastEnd) return false;   // 收工後已經跑過了
    return await dispatch(env, DEPLOY_WORKFLOW, `當天最後一場結束 ${Math.round(since)} 分鐘,補一次部署`, log, dryRun);
  } catch (e) { log.push(`✗ 收工部署判斷失敗:${e.message}`); return false; }
}

/* token 還活著嗎。**沒有比賽的日子完全碰不到 GitHub API**,
   所以 token 過期會一路潛伏到下一個比賽日才發作 —— 這裡主動戳一下,
   讓 /status 隨時看得出來。一個唯讀請求,幾乎不花額度。 */
async function authHealth(env) {
  try {
    const res = await gh(env, '/actions/workflows?per_page=1');
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status,
      hint: res.status === 401 ? 'token 無效或已撤銷'
        : res.status === 403 ? '權限不足(需要 Actions: Read and write)'
        : res.status === 404 ? 'REPO 名稱不對,或 token 沒有這個 repo 的存取權' : null };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function run(env, { dryRun = false } = {}) {
  const log = [];
  const results = [];
  if (!env.GITHUB_TOKEN || !env.REPO || !env.BRANCH || !env.SITE) {
    log.push('✗ 缺少設定(GITHUB_TOKEN / REPO / BRANCH / SITE),什麼都不做');
    return { at: new Date().toISOString(), log, results };
  }
  const auth = await authHealth(env);
  if (!auth.ok) log.push(`✗ GitHub 認證有問題:${auth.hint ?? auth.error ?? `HTTP ${auth.status}`}`);
  for (const lg of LEAGUES) {
    try { results.push(await checkLeague(env, lg, log, dryRun)); }
    catch (e) { log.push(`✗ ${lg.zh} 檢查整個失敗:${e.message}`); }
  }
  await closingDeploy(env, results, log, dryRun);
  if (!log.length) log.push('· 沒有比賽在窗口內,什麼都不用做');
  return { at: new Date().toISOString(), mode: dryRun ? '唯讀' : '執行', auth, log, results };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env).then(r => console.log(JSON.stringify(r))));
  },
  /* /status 給人看:這支現在認為有沒有比賽、feed 多新、剛才做了什麼。
     沉默故障是這個專案反覆吃虧的地方,所以看門狗自己要看得見。 */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/status') {
      return new Response('warroom ignition worker —— 看 /status', { status: 200 });
    }
    /* workers.dev 的網址是公開的,而這支會真的派送 workflow。
       所以**沒帶正確 key 的一律唯讀** —— 照樣把判斷結果整份回給你看
       (診斷價值不減),但不會觸發任何動作。cron 走的是 scheduled(),
       不經過這裡,永遠是執行模式。 */
    const dryRun = !env.STATUS_KEY || url.searchParams.get('key') !== env.STATUS_KEY;
    const r = await run(env, { dryRun });
    return new Response(JSON.stringify(r, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  },
};
