#!/usr/bin/env node
/* 賽前缺陣名單(傷停):開賽前 24 小時內,每一場抓一次 FotMob `matchDetails`(2026-10-31,英冠;使用者選「接,用乙」)。
 *
 * 規則在 lib/unavailable.mjs(pickDue / parseUnavailable),這一支只管打請求與寫快取:
 * - 讀 `data/raw/{dir}/scores.json`(同一個部署裡 scores:fetch 剛抓的 FotMob 賽程,帶 matchId 與開賽時間);
 * - 快取 `data/raw/{dir}/unavailable.json`,以 FotMob matchId 為鍵 —— 那個目錄本來就在部署的回寫清單裡,
 *   快取不回寫的話「一場只抓一次」就不成立(每次部署都會當成沒抓過);
 * - 單線、每個請求間隔 1.5 秒、20 秒逾時、一次最多 MAX_PER_RUN 個;
 * - 主客用 FotMob 的 home / away 欄位,並拿隊名對一次名冊 —— 對不上的整場記 ok:false,不掛(配錯隊比沒有糟)。
 *
 *   npm run unavailable:fetch -- --league=en2 [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { pickDue, parseUnavailable } from './lib/unavailable.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'pl-war-room/1.0 (football analysis side project)';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
/* 只有接上的聯賽在這裡。英超有 FPL 的傷停、西甲與德義法還沒決定要不要接 —— 要接的話加一列,不要改成全部 */
const LEAGUES = {
  en2: { dir: 'fotmob-championship', teamFile: 'teams-championship.json' },
};
const key = arg('league') ?? 'en2';
const LG = LEAGUES[key];
if (!LG) { console.error(`✗ ${key} 沒有接賽前缺陣名單`); process.exit(1); }
const dryRun = process.argv.includes('--dry-run');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const dir = join(ROOT, 'data', 'raw', LG.dir);
  const sp = join(dir, 'scores.json'), cp = join(dir, 'unavailable.json');
  if (!existsSync(sp)) { console.log(`· 沒有 ${LG.dir}/scores.json,不知道有哪些場次 —— 這一次不抓`); return; }
  const scores = JSON.parse(readFileSync(sp, 'utf8'));
  const store = existsSync(cp) ? JSON.parse(readFileSync(cp, 'utf8')) : { league: key, matches: {} };
  const due = pickDue({ matches: scores.matches, cache: store.matches });
  console.log(`▶ ${key} 賽前缺陣名單:開賽前 24 小時內還沒抓的 ${due.length} 場${dryRun ? '(--dry-run,不發請求)' : ''}`);
  if (!due.length || dryRun) { for (const m of due) console.log(`  · ${m.home} vs ${m.away} ${m.utcTime}`); return; }
  const T = loadTeams(ROOT, { file: LG.teamFile });
  let n = 0;
  for (const m of due) {
    if (n++) await sleep(1500);
    const prev = store.matches[m.matchId];
    const rec = { matchId: m.matchId, home: m.home, away: m.away, utcTime: m.utcTime, fetchedAt: new Date().toISOString(),
      attempts: (prev?.ok === false ? prev.attempts ?? 1 : 0) + 1 };
    try {
      const res = await fetch(`https://www.fotmob.com/api/data/matchDetails?matchId=${m.matchId}`, { signal: AbortSignal.timeout(20000),
        headers: { accept: 'application/json', 'user-agent': UA, referer: 'https://www.fotmob.com/' } });
      /* HTTP 失敗不記 —— 那是「這一次沒問到」,不是「上游沒有」,下一次部署照樣算沒抓過 */
      if (!res.ok) { console.log(`  ✗ ${m.home} vs ${m.away}:HTTP ${res.status},下一次部署再試`); continue; }
      const raw = await res.json();
      const p = parseUnavailable(raw);
      /* 主客兩道:名單上的隊 id 要等於 general 的主 / 客隊 id,隊名(名單的或 general 的)要對得回這一場的隊碼 */
      const g = raw?.general ?? {};
      const codeOf = (side, gen) => T.codeOf(side?.name) ?? T.codeOf(gen?.name);
      if (p.ok && (String(p.home.id) !== String(g.homeTeam?.id) || String(p.away.id) !== String(g.awayTeam?.id)
        || codeOf(p.home, g.homeTeam) !== m.home || codeOf(p.away, g.awayTeam) !== m.away)) {
        Object.assign(p, { ok: false, reason: `主客對不上(${p.home?.name} / ${p.away?.name})` });
      }
      Object.assign(rec, p.ok
        ? { ok: true, sides: { home: p.home.list, away: p.away.list } }
        : { ok: false, reason: p.reason });
      store.matches[m.matchId] = rec;
      console.log(p.ok
        ? `  ✓ ${m.home} vs ${m.away}:缺陣 ${p.home.list?.length ?? '?'} + ${p.away.list?.length ?? '?'} 人`
        : `  ⚠ ${m.home} vs ${m.away}:${p.reason}(第 ${rec.attempts} 次)`);
    } catch (e) { console.log(`  ✗ ${m.home} vs ${m.away}:${e.message},下一次部署再試`); }
  }
  store.league = key;
  store.updatedAt = new Date().toISOString();
  writeFileSync(cp, JSON.stringify(store));
  console.log(`✔ ${n} 個請求・快取共 ${Object.keys(store.matches).length} 場`);
}
main().catch(e => { console.error('✗', e.message); process.exit(1); });
