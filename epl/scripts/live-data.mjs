#!/usr/bin/env node
/* 即時比分分支的三個動作(2026-10-30,補齊規劃 D3 方案 A)。

   為什麼有這一支:比賽夜的兩支迴圈原本把比分與整份 web/data 每 2~3 分鐘提交到**預設分支** ——
   一個比賽夜幾十則提交、每則都帶幾 MB 的產物,預設分支的歷史被淹掉、倉庫一直長大,
   而它們跟部署的回寫還要搶同一條分支(rebase 衝突那幾條坑都是這樣來的)。
   現在迴圈推到 `LIVE_BRANCH`(lib/live-branch.mjs),三件事:

     overlay [--commit]   開工時把那條分支上「還沒併回預設分支」的檔疊到工作樹。
                          迴圈與部署都要做:live-history 這種累積檔、歐冠逐場快取,
                          上一個比賽夜推上去而部署還沒併回的那一段,不疊就會丟。
                          --commit:疊完在本機提交一則(不推送),迴圈裡「這一輪有沒有變」的
                          git diff 才是相對於疊上去之後的狀態。
     push <路徑…>         把 HEAD 上這些路徑的版本做成那條分支上的一則提交,一般推送(不 force)。
                          拿的是 HEAD 不是工作樹 —— 迴圈先照舊在本機提交,這裡只搬那幾個路徑;
                          兩支迴圈同時推時,撞了就重抓再做一次(兩支的路徑不重疊)。
     reset                部署把資料併回預設分支之後,把那條分支重設成一則(帶 ABSORBED_MARK)。
                          這就是「每日 squash」:歷史最多留到下一次部署。用 force-with-lease 對著
                          overlay 當時看到的那一則 —— 中間有迴圈推過就不重設,下一次部署再併。

   **為什麼 overlay 只拿「標記之後改過的檔」,不比時間戳**:actions/checkout 是 depth 1,
   在淺複本上 `git log -- 路徑` 對每個路徑都回同一則提交,時間比較沒有意義。
   標記之前的部分在重設那一刻已經等於預設分支(部署剛寫回去),之後預設分支那份只可能更新。

   已知的縫:重設因為 lease 失敗而跳過的那一輪,下一次 overlay 會把「上一次標記之後改過、
   而部署已經併回並可能又抓得更新」的檔也疊回去 —— 最多讓一份快照退回到迴圈最後推的那一版,
   下一次抓取就蓋掉。要撞上它,迴圈得剛好在部署的那幾分鐘裡推。

   參數:--remote=origin(預設)、--state=<檔>(overlay 記下的那一則,reset 要用;
   預設 $RUNNER_TEMP/live-data-tip)、--message=<訊息>(push 用)。 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LIVE_BRANCH, FEED_PATHS, ABSORBED_MARK } from './lib/live-branch.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = k => argv.includes(`--${k}`);
const [cmd, ...rest] = argv.filter(a => !a.startsWith('--'));

const REMOTE = opt('remote', 'origin');
const STATE = opt('state', join(process.env.RUNNER_TEMP ?? tmpdir(), 'live-data-tip'));
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const TRACK = `refs/remotes/${REMOTE}/${LIVE_BRANCH}`;

/* 沒設 user.name 的環境(例如部署那一步之外呼叫)也要做得出提交,不要在 commit-tree 才炸 */
const BOT = { GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
const hasIdent = (() => { try { return !!execFileSync('git', ['config', 'user.name'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return false; } })();
const IDENT = hasIdent ? {} : { ...BOT, GIT_COMMITTER_NAME: BOT.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: BOT.GIT_AUTHOR_EMAIL };

function git(args, { env = {}, input, quiet = false } = {}) {
  return execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...IDENT, ...env }, stdio: ['pipe', 'pipe', quiet ? 'ignore' : 'inherit'],
  }).trim();
}
const tryGit = (args, o) => { try { return { ok: true, out: git(args, { quiet: true, ...o }) }; } catch { return { ok: false, out: '' }; } };
const lines = s => s.split('\n').filter(Boolean);
const chunks = (xs, n = 200) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/* 遠端有沒有這條分支 —— 沒有的話 fetch 會失敗,但那不是錯(第一次跑) */
function fetchTip() {
  const ls = tryGit(['ls-remote', '--heads', REMOTE, LIVE_BRANCH]);
  if (!ls.ok) throw new Error(`問不到 ${REMOTE} 的分支清單`);
  if (!ls.out) return '';
  git(['fetch', '-q', REMOTE, `+refs/heads/${LIVE_BRANCH}:${TRACK}`]);
  return git(['rev-parse', TRACK]);
}

function withIndex(fn) {
  const idx = join(tmpdir(), `live-data-index-${process.pid}-${Date.now()}`);
  try { return fn({ GIT_INDEX_FILE: idx }); } finally { rmSync(idx, { force: true }); }
}

function overlay() {
  const tip = fetchTip();
  writeFileSync(STATE, tip);
  if (!tip) { console.log(`· ${LIVE_BRANCH} 還不存在,沒有東西要疊`); return 0; }
  const base = git(['log', '-1', '--format=%H', `--grep=^${ABSORBED_MARK}`, tip]);
  /* 沒有標記 = 這條分支從建立起還沒被部署併回過 → 全部都要疊 */
  const files = base
    ? lines(git(['diff', '--name-only', '--no-renames', '--diff-filter=AMT', base, tip]))
    : lines(git(['ls-tree', '-r', '--name-only', tip]));
  if (!files.length) { console.log(`· ${LIVE_BRANCH} 自上次併回之後沒有新東西(${tip.slice(0, 8)})`); return 0; }
  for (const c of chunks(files)) git(['checkout', tip, '--', ...c]);
  console.log(`· 從 ${LIVE_BRANCH}(${tip.slice(0, 8)}${base ? `,上次併回 ${base.slice(0, 8)}` : ',從未併回'})疊上 ${files.length} 個檔`);
  if (flag('commit')) {
    for (const c of chunks(files)) git(['add', '-f', '--', ...c]);
    if (tryGit(['diff', '--cached', '--quiet']).ok) return 0;
    git(['commit', '-q', '--no-verify', '-m', `本機:疊上 ${LIVE_BRANCH} ${tip.slice(0, 8)}(不推送)`]);
  }
  return 0;
}

function push(paths) {
  if (!paths.length) { console.error('✗ push 要給路徑'); return 2; }
  const msg = opt('message', `chore: 即時資料 ${new Date().toISOString().slice(11, 16)} UTC`);
  for (let t = 1; t <= 3; t++) {
    let tip;
    try { tip = fetchTip(); } catch (e) { console.log(`  ${e.message},重試 ${t}`); continue; }
    const res = withIndex(env => {
      git(tip ? ['read-tree', tip] : ['read-tree', '--empty'], { env });
      for (const p of paths) git(['rm', '-r', '-f', '--cached', '-q', '--ignore-unmatch', '--', p], { env });
      const entries = paths.map(p => git(['ls-tree', '-r', '--full-tree', 'HEAD', '--', p])).filter(Boolean).join('\n');
      if (entries) git(['update-index', '--index-info'], { env, input: entries + '\n' });
      const tree = git(['write-tree'], { env });
      if (tip && tree === git(['rev-parse', `${tip}^{tree}`])) return 'same';
      return git(['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', msg]);
    });
    if (res === 'same') { console.log(`· ${LIVE_BRANCH} 已經是這一份,不推`); return 0; }
    /* 一般推送:別的迴圈剛推過就會被拒(non-fast-forward),重抓再做一次 */
    if (tryGit(['push', '-q', REMOTE, `${res}:refs/heads/${LIVE_BRANCH}`]).ok) {
      console.log(`· 已推到 ${LIVE_BRANCH}(${res.slice(0, 8)})`); return 0;
    }
    console.log(`  推送 ${LIVE_BRANCH} 被拒,重試 ${t}`);
    execFileSync('sleep', ['3']);
  }
  console.log(`⚠ 三次都推不上 ${LIVE_BRANCH} —— 這一輪的資料留在本機提交裡,下一輪一起推`);
  return 1;
}

function reset() {
  if (!existsSync(STATE)) { console.log(`· 沒有 overlay 記下的 ${LIVE_BRANCH} 狀態,不重設`); return 0; }
  const saved = readFileSync(STATE, 'utf8').trim();
  let cur;
  try { cur = fetchTip(); } catch (e) { console.log(`· ${e.message},不重設`); return 0; }
  if (cur !== saved) {
    console.log(`· ${LIVE_BRANCH} 在部署期間被推過(${saved.slice(0, 8) || '無'} → ${cur.slice(0, 8)}),這次不重設;下一次部署再併`);
    return 0;
  }
  const want = [...new Set([...(saved ? lines(git(['ls-tree', '-r', '--name-only', saved])) : []), ...FEED_PATHS])]
    .filter(p => existsSync(join(ROOT, p)));
  const head = git(['rev-parse', 'HEAD']);
  const commit = withIndex(env => {
    git(['read-tree', '--empty'], { env });
    for (const c of chunks(want)) git(['add', '-f', '--', ...c], { env });
    const tree = git(['write-tree'], { env });
    return git(['commit-tree', tree, '-m', `${ABSORBED_MARK}: 已併入 ${head.slice(0, 12)}(重設成一則)`]);
  });
  /* 只重設 overlay 當時看到的那一則;不存在時 lease 的期望值留空 = 「必須還不存在」 */
  const r = tryGit(['push', '-q', `--force-with-lease=refs/heads/${LIVE_BRANCH}:${saved}`, REMOTE, `${commit}:refs/heads/${LIVE_BRANCH}`]);
  console.log(r.ok
    ? `· ${LIVE_BRANCH} 重設成一則(${commit.slice(0, 8)},${want.length} 個檔)`
    : `· ${LIVE_BRANCH} 重設被拒(迴圈剛推過),下一次部署再併`);
  return 0;
}

const run = { overlay, push: () => push(rest), reset }[cmd];
if (!run) { console.error('用法:live-data.mjs overlay [--commit] | push <路徑…> [--message=…] | reset'); process.exit(2); }
process.exit(run());
