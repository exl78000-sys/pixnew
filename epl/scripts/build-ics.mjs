/* 逐隊寫行事曆檔(2026-11-27,N6)。掛在 npm run build 裡、各聯賽都建完之後(跟 build-overview-shared 同一個位置的理由)。
   聯賽清單掃 web/data/leagues/(手寫清單的坑踩過五次)。輸出 web/data/ics/{聯賽}/{隊碼}.ics,隊碼只在聯賽裡唯一,
   所以一定要分聯賽目錄(BUR 在英超與英冠都有)。

   站台網址從 GITHUB_REPOSITORY 推(owner/repo → https://owner.github.io/repo/,跟 probe-live-site 同一個推法);
   本機沒有那個變數就不放連結 —— 寫一個猜的網址進讀者的行事曆比不放更糟。 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { teamCalendar } from './lib/ics.mjs';

const ROOT = new URL('../web/data/', import.meta.url).pathname;
const OUT = join(ROOT, 'ics');
const LG_ZH = { pl: '英超', es1: '西甲', en2: '英冠', de1: '德甲', it1: '義甲', fr1: '法甲' };
const repo = process.env.GITHUB_REPOSITORY;
const base = repo ? `https://${repo.split('/')[0]}.github.io/${repo.split('/')[1]}/` : null;

const dirs = [['pl', ROOT], ...readdirSync(join(ROOT, 'leagues')).sort().map(k => [k, join(ROOT, 'leagues', k)])]
  .filter(([, d]) => existsSync(join(d, 'fixtures.json')) && existsSync(join(d, 'teams.json')) && existsSync(join(d, 'meta.json')));
rmSync(OUT, { recursive: true, force: true });   // 整個重寫:降級離開的球隊不能留一份過期的檔
let files = 0;
for (const [lg, d] of dirs) {
  const load = f => JSON.parse(readFileSync(join(d, f), 'utf8'));
  const meta = load('meta.json'), teams = load('teams.json');
  const fixtures = load('fixtures.json').filter(f => f.season === meta.currentSeason);
  const byCode = new Map(teams.map(t => [t.code, t]));
  const lgZh = LG_ZH[lg];
  if (!lgZh) throw new Error(`build-ics:不認得的聯賽 ${lg},先在 LG_ZH 補中文名`);
  const link = base ? f => `${base}analysis.html?id=${encodeURIComponent(f.id)}${lg === 'pl' ? '' : `&league=${lg}`}` : null;
  mkdirSync(join(OUT, lg), { recursive: true });
  for (const t of teams) {
    writeFileSync(join(OUT, lg, `${t.code}.ics`), teamCalendar({ lg, lgZh, team: t, nameOf: c => byCode.get(c)?.en ?? c,
      fixtures, builtAt: meta.builtAt, link }));
    files++;
  }
}
console.log(`✔ 行事曆:${dirs.length} 個聯賽、${files} 隊${base ? '' : '(本機建置:沒有站台網址,事件不放連結)'}`);
