#!/usr/bin/env node
/* 即時比分分支(scripts/live-data.mjs)的流程測試(2026-10-30,D3 方案 A)。

   不連網:在暫存目錄開一個 bare 倉庫當遠端,幾個 clone 分別扮演英超迴圈、西甲迴圈與部署,
   把一個比賽夜到下一次部署的順序真的跑一遍。守的是會靜靜出錯的那幾件事:
   - 第一次推(分支還不存在)要建得起來;
   - 兩支迴圈先後推,後推的不可以把先推的那幾個檔蓋掉(路徑不重疊,樹要疊起來);
   - 部署 overlay 拿得到迴圈推上去、還沒併回的檔;
   - 重設之後只剩一則、帶標記、帶 feed;之後的 overlay 只拿標記之後改過的檔;
   - 部署期間迴圈推過的話,重設不可以把它蓋掉(lease)。 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LIVE_BRANCH, ABSORBED_MARK, liveFeedUrl } from './lib/live-branch.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'live-data.mjs');
const T = mkdtempSync(join(tmpdir(), 'live-data-test-'));
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete ENV.RUNNER_TEMP;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tool = (cwd, state, ...args) => execFileSync('node', [SCRIPT, ...args, `--state=${state}`], { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
const put = (cwd, p, s) => { mkdirSync(dirname(join(cwd, p)), { recursive: true }); writeFileSync(join(cwd, p), s); };
const get = (cwd, p) => existsSync(join(cwd, p)) ? readFileSync(join(cwd, p), 'utf8') : null;
const tip = cwd => { sh(cwd, 'fetch', '-q', 'origin', `+refs/heads/${LIVE_BRANCH}:refs/remotes/origin/${LIVE_BRANCH}`); return sh(cwd, 'rev-parse', `origin/${LIVE_BRANCH}`); };
/* 推完之後本機的追蹤分支不會自己跟上,每次都重抓,讀的才是遠端現在那一份 */
const remoteFile = (cwd, p) => { try { tip(cwd); return sh(cwd, 'show', `origin/${LIVE_BRANCH}:${p}`); } catch { return null; } };
const commitAll = (cwd, msg) => { sh(cwd, 'add', '-A'); sh(cwd, 'commit', '-q', '-m', msg); };

let fails = 0;
const ok = (c, name, d = '') => { console.log(`  ${c ? '✓' : '✗'} ${name}${!c && d ? `  (${d})` : ''}`); if (!c) fails++; };

const ORIGIN = join(T, 'origin.git');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', ORIGIN]);
const seed = join(T, 'seed');
execFileSync('git', ['clone', '-q', ORIGIN, seed], { env: ENV, stdio: 'ignore' });
put(seed, 'epl/data/live-history.json', '[1]');
put(seed, 'epl/data/raw/live.json', 'v0');
put(seed, 'epl/data/live-history-la-liga.json', '[a]');
put(seed, 'epl/data/raw/other.json', 'untouched');
commitAll(seed, 'seed'); sh(seed, 'push', '-q', 'origin', 'HEAD:main');
const clone = name => { const d = join(T, name); execFileSync('git', ['clone', '-q', '--depth', '1', `file://${ORIGIN}`, d], { env: ENV, stdio: 'ignore' }); return d; };

console.log('即時比分分支(D3)');
try {
  /* 1. 英超迴圈第一次推:分支還不存在 */
  const A = clone('epl-loop'), sA = join(T, 'sA');
  ok(/還不存在/.test(tool(A, sA, 'overlay', '--commit')), '分支不存在時 overlay 不出錯、什麼都不疊');
  put(A, 'epl/data/raw/live.json', 'v1'); put(A, 'epl/data/live-history.json', '[1,2]'); put(A, 'epl/web/data/live.json', 'feed1');
  commitAll(A, 'loop 1');
  tool(A, sA, 'push', 'epl/data/raw/live.json', 'epl/data/live-history.json', 'epl/web/data/live.json');
  ok(remoteFile(A, 'epl/data/raw/live.json') === 'v1' && remoteFile(A, 'epl/web/data/live.json') === 'feed1', '第一次推建得起分支,而且帶上 feed');
  ok(remoteFile(A, 'epl/data/raw/other.json') === null, '分支上只有推的那幾個路徑,不是整個倉庫');
  ok(sh(A, 'rev-parse', 'origin/main') === sh(join(T, 'seed'), 'rev-parse', 'HEAD'), '預設分支一則都沒有多(迴圈不再推它)');

  /* 2. 西甲迴圈接著推:不可以把英超那幾個檔蓋掉 */
  const B = clone('laliga-loop'), sB = join(T, 'sB');
  tool(B, sB, 'overlay', '--commit');
  ok(get(B, 'epl/data/live-history.json') === '[1,2]', '另一支迴圈開工時疊得到先推上去的累積檔');
  ok(sh(B, 'status', '--porcelain') === '', 'overlay --commit 之後工作樹是乾淨的(「這一輪有沒有變」才是相對於疊上去之後)');
  put(B, 'epl/data/live-history-la-liga.json', '[a,b]'); commitAll(B, 'laliga 1');
  tool(B, sB, 'push', 'epl/data/live-history-la-liga.json');
  ok(remoteFile(B, 'epl/data/live-history-la-liga.json') === '[a,b]' && remoteFile(B, 'epl/data/raw/live.json') === 'v1',
    '後推的疊在先推的上面(兩邊的檔都在)');
  /* 英超迴圈再推一輪:它開工時沒看到西甲那則,推的時候要接在西甲那則後面 */
  put(A, 'epl/data/raw/live.json', 'v2'); commitAll(A, 'loop 2');
  tool(A, sA, 'push', 'epl/data/raw/live.json', 'epl/data/live-history.json', 'epl/web/data/live.json');
  ok(remoteFile(A, 'epl/data/raw/live.json') === 'v2' && remoteFile(A, 'epl/data/live-history-la-liga.json') === '[a,b]',
    '沒看過對方那則的迴圈推上去,也不會把對方的檔蓋掉');
  ok(/不推/.test(tool(A, sA, 'push', 'epl/data/raw/live.json')), '沒有變化就不製造空提交');

  /* 3. 部署:overlay(不提交)→ 回寫預設分支 → 重設 */
  const D = clone('deploy'), sD = join(T, 'sD');
  tool(D, sD, 'overlay');
  ok(get(D, 'epl/data/raw/live.json') === 'v2' && get(D, 'epl/data/live-history-la-liga.json') === '[a,b]', '部署 overlay 拿到兩支迴圈還沒併回的檔');
  put(D, 'epl/data/raw/live.json', 'v3-deploy');                      // 部署自己又抓得更新
  put(D, 'epl/web/data/cups-live.json', 'cupsfeed');                  // 建置產物(不在回寫清單)
  sh(D, 'add', '-f', 'epl/data'); sh(D, 'commit', '-q', '-m', 'writeback'); sh(D, 'push', '-q', 'origin', 'HEAD:main');
  tool(D, sD, 'reset');
  const t3 = tip(D);
  ok(sh(D, 'rev-list', '--count', t3) === '1', '重設之後分支只剩一則');
  ok(new RegExp(`^${ABSORBED_MARK}`).test(sh(D, 'log', '-1', '--format=%s', t3)), '那一則帶「已併回」標記');
  ok(remoteFile(D, 'epl/data/raw/live.json') === 'v3-deploy' && remoteFile(D, 'epl/web/data/cups-live.json') === 'cupsfeed',
    '重設帶的是部署那一份(更新的)與 feed');

  /* 4. 下一個比賽夜:新的 checkout 疊不到任何舊東西,推一則之後只疊那一則改的 */
  const A2 = clone('epl-loop-2'), sA2 = join(T, 'sA2');
  ok(/沒有新東西/.test(tool(A2, sA2, 'overlay', '--commit')), '重設之後 overlay 不疊任何檔(都已經在預設分支上)');
  put(A2, 'epl/data/live-history.json', '[1,2,3]'); commitAll(A2, 'loop next');
  tool(A2, sA2, 'push', 'epl/data/live-history.json');
  const C = clone('check'), sC = join(T, 'sC');
  put(C, 'epl/data/raw/live.json', 'local-newer'); commitAll(C, 'x');
  const out = tool(C, sC, 'overlay');
  ok(/疊上 1 個檔/.test(out) && get(C, 'epl/data/live-history.json') === '[1,2,3]' && get(C, 'epl/data/raw/live.json') === 'local-newer',
    '只疊標記之後改過的檔,不拿分支上較舊的那份蓋掉本機的', out.trim());

  /* 5. 部署期間迴圈推過 → 重設不可以蓋掉它 */
  const D2 = clone('deploy-2'), sD2 = join(T, 'sD2');
  tool(D2, sD2, 'overlay');
  put(A2, 'epl/data/live-history.json', '[1,2,3,4]'); commitAll(A2, 'during deploy');
  tool(A2, sA2, 'push', 'epl/data/live-history.json');
  const before = tip(D2);
  ok(/不重設/.test(tool(D2, sD2, 'reset')) && tip(D2) === before && remoteFile(D2, 'epl/data/live-history.json') === '[1,2,3,4]',
    '部署期間迴圈推過的話不重設,迴圈那則留著');

  /* 6. 前端網址指向這條分支,不是建置的那條 */
  ok(liveFeedUrl('epl/web/data/live.json', { GITHUB_REPOSITORY: 'o/r', GITHUB_REF_NAME: 'main' })
    === `https://raw.githubusercontent.com/o/r/${LIVE_BRANCH}/epl/web/data/live.json`
    && liveFeedUrl('x', {}) === null, 'feed 網址指向即時分支;本機建置是 null');
} finally {
  rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} 條失敗` : '  全部通過');
process.exit(fails ? 1 : 0);
