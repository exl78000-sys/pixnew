#!/usr/bin/env node
// 抓球隊隊徽 → 縮圖 → 內嵌成 data URI(data/manual/crests*.json)
// artifact 的 CSP 會擋所有外部資源,所以隊徽必須內嵌;順便讓網站離線也看得到。
// 用法: npm run crests [--width=64] [--force]
//       npm run laliga:crests [-- --width=64] [-- --force] [--include-history]
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeams } from './lib/teams.mjs';
import { competition } from './lib/canonical.mjs';
import { decodePNG, resizeRGBA, encodePNG } from './lib/png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://raw.githubusercontent.com/luukhopman/football-logos/master';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const WIDTH = Number(arg('width') || 64);
const force = process.argv.includes('--force');
const LEAGUE = arg('league') || 'pl';

const PROFILES = {
  pl: {
    teamFile: 'teams.json', outFile: 'crests.json', currentRaw: null, label: '英超',
    folders: [
      'logos/England - Premier League',
      'history/2025-26/England - Premier League',
      'history/2024-25/England - Premier League',
      'history/2023-24/England - Premier League',
    ],
  },
  es1: {
    teamFile: 'teams-la-liga.json', outFile: 'crests-la-liga.json',
    competition: 'esp.1', label: '西甲',
    currentRaw: join(ROOT, 'data', 'raw', 'openfootball-la-liga', '2026-27.json'),
    folders: [
      'logos/Spain - LaLiga',
      'history/2025-26/Spain - LaLiga',
    ],
    // football-logos 沒有西乙目錄；這三隊是名冊裡的歷史球隊，
    // 由 TheSportsDB 的 Spanish La Liga 2（西乙）資料補充，並在本地內嵌。
    historyFallbacks: {
      GIR: {
        name: 'Girona',
        url: 'https://r2.thesportsdb.com/images/media/team/badge/kfu7zu1659897499.png',
      },
      MLL: {
        name: 'Mallorca',
        url: 'https://r2.thesportsdb.com/images/media/team/badge/ssptsx1473503730.png',
      },
      OVI: {
        name: 'Real Oviedo',
        url: 'https://r2.thesportsdb.com/images/media/team/badge/yuwqus1447590681.png',
      },
    },
  },
  /* 德甲(2026-09-15)。football-logos 的資料夾名是**試出來的**,不是猜的:
     `Germany - Bundesliga` 回 200、`Germany - 1. Bundesliga` 與 `Germany - Bundesliga 1` 都 404。
     英冠不需要自己的檔(英格蘭球隊跟英超、盃賽那兩份重疊),德國隊一支都不重疊,所以自己一份。
     歷史目錄放 2025-26:名冊含升降級球隊,降下去的那幾支要去當季的目錄找。 */
  de1: {
    teamFile: 'teams-bundesliga.json', outFile: 'crests-bundesliga.json',
    competition: 'ger.1', label: '德甲',
    currentRaw: join(ROOT, 'data', 'raw', 'openfootball-bundesliga', '2026-27.json'),
    folders: [
      'logos/Germany - Bundesliga',
      'history/2025-26/Germany - Bundesliga',
      'history/2024-25/Germany - Bundesliga',
    ],
  },
  /* 義甲 / 法甲(2026-09-16)。資料夾名一樣是**試出來的**,不是猜的
     (`probe-folders.mjs` 那一輪:`Italy - Serie A` 與 `France - Ligue 1` 回 200;
      `Italy - Serie A TIM` / `Italy - SerieA` / `Italy - Serie-A`、
      `France - Ligue1` / `France - Ligue 1 Uber Eats` / `France - Ligue 1 McDonald's` 全 404)。
     歷史目錄列到 **2023-24**,比德甲多一季 —— 這兩個聯賽的名冊涵蓋四季,
     2023-24 之後降級的那幾支(義甲 Salernitana / Frosinone、法甲 Clermont / Troyes)
     只在那一季的目錄裡。三個歷史目錄都用「那一季真的在的球隊」驗過存在。 */
  it1: {
    teamFile: 'teams-serie-a.json', outFile: 'crests-serie-a.json',
    competition: 'ita.1', label: '義甲',
    currentRaw: join(ROOT, 'data', 'raw', 'openfootball-serie-a', '2026-27.json'),
    folders: [
      'logos/Italy - Serie A',
      'history/2025-26/Italy - Serie A',
      'history/2024-25/Italy - Serie A',
      'history/2023-24/Italy - Serie A',
    ],
  },
  fr1: {
    teamFile: 'teams-ligue-1.json', outFile: 'crests-ligue-1.json',
    competition: 'fra.1', label: '法甲',
    currentRaw: join(ROOT, 'data', 'raw', 'openfootball-ligue-1', '2026-27.json'),
    folders: [
      'logos/France - Ligue 1',
      'history/2025-26/France - Ligue 1',
      'history/2024-25/France - Ligue 1',
      'history/2023-24/France - Ligue 1',
    ],
  },
};
const PROFILE = PROFILES[LEAGUE];
if (!PROFILE) throw new Error(`不支援的聯賽 --league=${LEAGUE}`);
const OUT = join(ROOT, 'data', 'manual', PROFILE.outFile);
const INCLUDE_HISTORY = process.argv.includes('--include-history');

// 該來源依「當季所屬聯賽」放檔案,所以降級球隊要去對應賽季的歷史目錄找
const FOLDERS = PROFILE.folders;

// 檔名跟 openfootball 的隊名不完全一致(有的留 FC 有的不留),所以逐一試候選
const candidates = t => [...new Set([
  t.crestSource,
  t.of,
  t.en,
  ...(t.alias ?? []),
  t.of.replace(/\s+FC$/, ''),
  t.of.replace(/\s+AFC$/, ''),
  t.of.replace(/^AFC\s+/, ''),
].filter(Boolean))];

const url = (folder, name) => `${REPO}/${encodeURI(folder)}/${encodeURIComponent(name)}.png`;

async function findCrest(team) {
  // 歷史球隊優先使用已核對的西乙資料；這樣即使同一隊也出現在西甲歷史資料夾，
  // 仍會把「西乙補充」的來源留下來，方便之後追溯。
  const fallback = PROFILE.historyFallbacks?.[team.code];
  if (fallback && INCLUDE_HISTORY) {
    const res = await fetch(fallback.url, { method: 'GET' });
    if (res.ok) return { buf: Buffer.from(await res.arrayBuffer()), folder: 'TheSportsDB/Spanish La Liga 2', name: fallback.name };
  }
  for (const folder of FOLDERS) {
    for (const name of candidates(team)) {
      const res = await fetch(url(folder, name), { method: 'GET' });
      if (res.ok) return { buf: Buffer.from(await res.arrayBuffer()), folder, name };
    }
  }
  return null;
}

async function main() {
  const T = loadTeams(ROOT, { file: PROFILE.teamFile });
  let selected = T.list;
  // 西甲名冊包含上一季已降級的球隊；一般更新只抓 2026-27 當季 20 隊。
  // --include-history 才會另外補抓名冊中不在本季的歷史球隊。
  if (PROFILE.currentRaw && !INCLUDE_HISTORY) {
    const raw = JSON.parse(await readFile(PROFILE.currentRaw, 'utf8'));
    const currentCodes = new Set();
    for (const m of raw.matches ?? []) {
      for (const name of [m.team1, m.team2]) {
        const code = T.codeOf(name);
        if (!code) throw new Error(`當季隊名無法對照：${name}`);
        currentCodes.add(code);
      }
    }
    selected = T.list.filter(t => currentCodes.has(t.code));
    /* 隊數從**賽事註冊表**來,不要寫死。原本這裡是 `!== 20` 加一句「西甲當季隊數應為 20」——
       西甲跟英超剛好都是 20,所以三年沒事;德甲 18 隊一跑就炸,而錯誤訊息還說是西甲。
       這是「前端把聯賽的事實寫死」那條坑的腳本版:數字一律從資料算。 */
    const want = competition(PROFILE.competition)?.teams ?? null;
    if (want && selected.length !== want) {
      throw new Error(`${PROFILE.label ?? LEAGUE} 當季隊數應為 ${want},實際 ${selected.length}`);
    }
  }
  const existing = !force && existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : { crests: {} };
  const crests = { ...(existing.crests ?? {}) };
  const sources = { ...(existing.sources ?? {}) };

  /* **聯賽名一律從 profile 讀。** 這一行原本是 `LEAGUE === 'es1' ? '西甲' : '英超'` ——
     「不是英超就不是西甲」那條二元式的第 N 次:德甲義甲法甲跑起來全部印「英超球隊」。
     不拋錯、也不影響產物,只是 log 在說謊,而 log 就是這一步唯一的輸出。 */
  const zh = PROFILE.label ?? '英超';
  console.log(`▶ 抓取 ${selected.length} 支${zh}${LEAGUE === 'es1' && INCLUDE_HISTORY ? '／西乙名冊' : ''}球隊的隊徽(縮到寬 ${WIDTH}px)\n`);
  let got = 0, skipped = 0, failed = [];
  let raw = 0, small = 0;

  for (const t of selected) {
    if (crests[t.code] && !force) { skipped++; continue; }
    process.stdout.write(`  ${t.code} ${t.en ?? t.of} … `);
    try {
      const found = await findCrest(t);
      if (!found) { console.log('✗ 找不到'); failed.push(t.code); continue; }
      const img = decodePNG(found.buf);
      const out = encodePNG(resizeRGBA(img, WIDTH));
      crests[t.code] = `data:image/png;base64,${out.toString('base64')}`;
      sources[t.code] = `${found.folder}/${found.name}.png`;
      raw += found.buf.length; small += out.length;
      got++;
      console.log(`${img.width}×${img.height} → ${WIDTH}px・${(out.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
      failed.push(t.code);
    }
  }

  await writeFile(OUT, JSON.stringify({
    _note: `球隊隊徽(自動產生,請勿手改)。執行 npm run ${LEAGUE === 'es1' ? 'laliga:crests' : 'crests'} -- --force 可重抓。`,
    _source: 'https://github.com/luukhopman/football-logos',
    _fallbackSource: LEAGUE === 'es1' ? 'https://www.thesportsdb.com (Spanish La Liga 2 歷史補充)' : undefined,
    _license: '隊徽為各俱樂部商標,此處僅作為分析工具的識別用途。',
    _league: LEAGUE,
    _width: WIDTH,
    _updated: new Date().toISOString().slice(0, 10),
    sources, crests,
  }, null, 1));

  console.log(`\n✔ 完成:新增 ${got}・沿用 ${skipped}・失敗 ${failed.length}${failed.length ? '(' + failed.join(',') + ')' : ''}`);
  if (got) console.log(`  原始 ${(raw / 1024).toFixed(0)} KB → 縮圖後 ${(small / 1024).toFixed(0)} KB`);
  console.log('  請接著跑 npm run build');
  if (failed.length) process.exitCode = 1;
}

main();
