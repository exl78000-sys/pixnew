#!/usr/bin/env node
/* 英超場中射門統計(pulselive /stats/match → data/raw/pulselive/shots.json → 單場頁「場上數據」)的守門(2026-10-11)。
 * 不連網。固定資料是 probe-apis run 38155860376 在 runner 上印出的真實數字(FUL–CHE、NEW–LIV),
 * 當時跟 FotMob 逐場對過:FUL–CHE 14:18、NEW–LIV 13:27 —— 這裡拿同樣的數字驗「射正 + 射偏 + 被封阻」的算法。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shotsOf, wantedShots, attachShots, SHOTS_VERSION } from './lib/pulse-shots.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const check = (label, ok, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`); if (!ok) fails++; };
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
console.log('\n▶ 英超場中射門統計(pulselive)');

const M = o => ({ M: Object.entries(o).map(([name, value]) => ({ name, value })) });
// FUL–CHE(真實):射正 6:6、射偏 3:5、被封阻 5:7 → FotMob 總射門 14:18
const FUL = M({ ontarget_scoring_att: 6, shot_off_target: 3, blocked_scoring_att: 5, goals: 2 });
const CHE = M({ ontarget_scoring_att: 6, shot_off_target: 5, blocked_scoring_att: 7, goals: 3 });
// NEW–LIV(真實):射正 4:7、射偏 5:4、被封阻 4:16 → FotMob 13:27
const NEW = M({ ontarget_scoring_att: 4, shot_off_target: 5, blocked_scoring_att: 4 });
const LIV = M({ ontarget_scoring_att: 7, shot_off_target: 4, blocked_scoring_att: 16 });
const resp = { data: { 1: FUL, 2: CHE, 3: NEW, 4: LIV } };

{
  const f = shotsOf(resp, 1), c = shotsOf(resp, 2), n = shotsOf(resp, 3), l = shotsOf(resp, 4);
  check('總射門 = 射正 + 射偏 + 被封阻:FUL–CHE 14:18(FotMob 同)', f.total === 14 && c.total === 18, `${f.total}:${c.total}`);
  check('NEW–LIV 13:27(FotMob 同),射正 4:7', n.total === 13 && l.total === 27 && n.on === 4 && l.on === 7, `${n.total}:${l.total}`);
  check('被封阻也進總數(拿掉它 FUL 會變 9)', f.blocked === 5 && f.total - f.blocked === 9);
  const zero = shotsOf({ data: { 9: M({ ontarget_scoring_att: 2 }) } }, 9);
  check('零值的項目上游不給 → 缺 = 0,不是缺資料', zero.total === 2 && zero.off === 0 && zero.blocked === 0);
  check('整份沒有統計項是「沒資料」(null),不是「0 射門」',
    shotsOf({ data: { 9: { M: [] } } }, 9) === null && shotsOf({ data: {} }, 9) === null && shotsOf(null, 9) === null);
  const rep = shotsOf({ data: { 9: M({ ontarget_scoring_att: 2, shot_off_target: 1, total_scoring_att: 7 }) } }, 9);
  check('上游若給了 total_scoring_att 就另存 reported 供對照,畫面用的 total 仍是三項相加', rep.total === 3 && rep.reported === 7);
}

{
  const now = Date.parse('2026-10-11T16:40:00Z');
  const live = { fetchedAt: '2026-10-11T16:38:00Z', fixtures: [
    { home: 'FUL', away: 'CHE', started: true, finished: false },
    { home: 'NEW', away: 'LIV', started: true, finished: true },
    { home: 'ARS', away: 'TOT', started: true, finished: true },
    { home: 'EVE', away: 'WHU', started: false, finished: false },
    { home: 'AVL', away: 'BRE', started: true, finished: false },
  ] };
  const O = (h, a, id) => [`${h}|${a}`, { fixtureId: id, homeId: 1, awayId: 2 }];
  const official = { matches: Object.fromEntries([O('FUL', 'CHE', 10), O('NEW', 'LIV', 11), O('ARS', 'TOT', 12), O('EVE', 'WHU', 13)]) };
  const store = { matches: { 'ARS|TOT': { final: true }, 'NEW|LIV': { final: false } } };
  const w = wantedShots({ live, official, store, now });
  const keys = w.wanted.map(x => x.key);
  check('進行中的要抓;剛完賽而存檔還不是完賽版本的補一次', keys.includes('FUL|CHE') && keys.includes('NEW|LIV') && w.wanted.find(x => x.key === 'NEW|LIV').final === true);
  check('已有完賽版本的不再抓;還沒開賽的不抓', !keys.includes('ARS|TOT') && !keys.includes('EVE|WHU'));
  check('對不上 pulselive id 的跳過並回報(不另外打清單請求)', w.skipped.join() === 'AVL|BRE' && !keys.includes('AVL|BRE'));
  check('即時快照不夠新就一個都不抓', wantedShots({ live: { ...live, fetchedAt: '2026-10-11T16:20:00Z' }, official, store, now }).wanted.length === 0
    && wantedShots({ live: null, official, store, now }).stale === true);
  const many = { fetchedAt: live.fetchedAt, fixtures: Array.from({ length: 20 }, (_, i) => ({ home: `H${i}`, away: `A${i}`, started: true, finished: false })) };
  const offMany = { matches: Object.fromEntries(many.fixtures.map((f, i) => O(f.home, f.away, i))) };
  check('每輪有上限(12)', wantedShots({ live: many, official: offMany, store: { matches: {} }, now }).wanted.length === 12);
}

{
  const mk = () => ({ home: 'FUL', away: 'CHE', sides: { FUL: {}, CHE: {} } });
  const store = { version: SHOTS_VERSION, matches: { 'FUL|CHE': { fetchedAt: 'T', final: false, home: shotsOf(resp, 1), away: shotsOf(resp, 2) } } };
  const r = attachShots(mk(), store);
  check('掛在 sides[隊碼].shots,帶來源與抓取時間', r.sides.FUL.shots.total === 14 && r.sides.CHE.shots.on === 6 && r.shotsMeta.source === 'pulselive' && r.shotsMeta.final === false);
  check('掛上去的只有 total / on / off / blocked(reported 這種診斷欄位不進畫面)', Object.keys(r.sides.FUL.shots).sort().join() === 'blocked,off,on,total');
  /* 丟例外也要記成 ✗(第一版沒包:負向對照把「只有一隊」的檢查拿掉,整支測試當場掛掉、一個 ✗ 都沒印 —— 看起來像沒抓到) */
  const noShots = f => { try { return !f().sides.FUL.shots; } catch { return false; } };
  check('沒有存檔 / 只有一隊 / 鍵不對 → 一個字都不掛', noShots(() => attachShots(mk(), { matches: {} }))
    && noShots(() => attachShots(mk(), { matches: { 'FUL|CHE': { home: shotsOf(resp, 1) } } }))
    && noShots(() => attachShots({ ...mk(), home: 'CHE', away: 'FUL' }, store)));
}

{
  const build = strip(readFileSync(join(ROOT, 'scripts', 'build.mjs'), 'utf8'));
  check('build 兩處(場上報告、賽後報告)都掛,而且重播 / 示範資料不掛', (build.match(/attachShots\(/g) ?? []).length === 2
    && /isCurrentSeason && !liveState\.demo\) attachShots/.test(build) && /isCur && !src\.demo\) attachShots/.test(build));
  const page = strip(readFileSync(join(ROOT, 'web', 'assets', 'js', 'page-analysis.js'), 'utf8'));
  check('單場頁三列(射門 / 射正 / 被封阻)要兩隊都有 shots 才出現,說明講明來源與「場中沒有第二個來源」',
    /H\.shots && A\.shots \? \[/.test(page) && page.includes('英超官方統計') && page.includes('場中的數字沒有第二個來源可以核對'));
  const fetcher = strip(readFileSync(join(ROOT, 'scripts', 'fetch-pulse-shots.mjs'), 'utf8'));
  check('抓取器:單線、有間隔、有逾時、失敗不寫檔', /sleep\(400\)/.test(fetcher) && /AbortSignal\.timeout/.test(fetcher) && /if \(ok\) \{/.test(fetcher) && !/Promise\.all/.test(fetcher));
  const yml = readFileSync(join(ROOT, '..', '.github', 'workflows', 'epl-matchday.yml'), 'utf8');
  check('比賽日迴圈在 official 之後跑 shots:live,失敗不擋迴圈', /npm run official[^\n]*\n(?:\s*#[^\n]*\n)*\s*npm run shots:live[^\n]*\|\| true/.test(yml));
}
console.log(fails ? `\n✗ ${fails} 條失敗` : '');
process.exit(fails ? 1 : 0);
