#!/usr/bin/env node
/* 德甲 / 義甲 / 法甲的球隊資料核對器。**實作跟英冠共用** `lib/team-delivery.mjs`,
 * 這裡只有各聯賽自己的參數。四道核對做什麼、為什麼這樣設計,看那一支的檔頭。
 *
 * ── 這三個聯賽跟英冠最大的差別:沒有對照組 ──
 * 英冠的交付清單裡刻意留了 12 支本站早就有答案的球隊(升降級的英格蘭球隊),
 * 逐欄位比對得上才採用。德義法**本站一筆既有答案都沒有** —— `ucl-teams.json`
 * 只收有本站隊碼的球隊(英超西甲),歐冠那一層也沒有隊色。
 * 所以報告裡 `controlTeams` 是 **null 不是 0**:0 會被讀成「查了 0 支、全過」,
 * 而事實是「這一關做不了」。把關剩下三道,其中**逐欄位出處**變成最重要的一道 ——
 * 交付時每一格都要附網址,沒有出處的那一格不採用。
 *
 * ── 容量區間逐聯賽給,而且寧可寬 ──
 * 英冠第一版把上限寫成 62,000,誤標了 62,500 的倫敦碗 —— **那是規格寫窄了不是資料錯**。
 * 這裡的上下限是照各聯賽最大與最小球場再留餘裕:
 *   德甲 Signal Iduna Park 約 81,000 → 上限 85,000
 *   義甲 San Siro 約 76,000          → 上限 85,000(同一個數字,不是巧合:兩邊都留餘裕)
 *   法甲 Vélodrome 約 67,000         → 上限 85,000
 * 下限一律 5,000:三個聯賽都有升上來的小球場,寫窄了會把真資料誤判成錯。
 *
 *   npm run de1:verify-teams   (也可 it1 / fr1)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTeamDelivery, deliveryLines } from './lib/team-delivery.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];

const LEAGUES = {
  de1: { zh: '德甲', roster: 'teams-bundesliga.json', crests: 'crests-bundesliga.json',
    inbox: 'bundesliga-teams-delivery.json', out: 'bundesliga-teams-verified.json' },
  it1: { zh: '義甲', roster: 'teams-serie-a.json', crests: 'crests-serie-a.json',
    inbox: 'serie-a-teams-delivery.json', out: 'serie-a-teams-verified.json' },
  fr1: { zh: '法甲', roster: 'teams-ligue-1.json', crests: 'crests-ligue-1.json',
    inbox: 'ligue-1-teams-delivery.json', out: 'ligue-1-teams-verified.json' },
};
const CAP_MIN = 5000, CAP_MAX = 85000;

export function verify(key, root = ROOT) {
  const L = LEAGUES[key];
  if (!L) throw new Error(`不支援的聯賽 --league=${key}`);
  const inboxPath = join(root, 'data', 'manual', L.inbox);
  if (!existsSync(inboxPath)) return { missingInbox: L.inbox, zh: L.zh };
  const inboxRaw = readFileSync(inboxPath);
  const roster = JSON.parse(readFileSync(join(root, 'data', 'manual', L.roster), 'utf8')).teams;
  const crestPath = join(root, 'data', 'manual', L.crests);
  const crests = new Map(Object.entries(
    existsSync(crestPath) ? (JSON.parse(readFileSync(crestPath, 'utf8')).crests ?? {}) : {}));
  /* control: null —— 這個聯賽沒有對照組,報告要照實寫 null 不是 0 */
  return { ...verifyTeamDelivery({ inboxRaw, roster, crests, control: null, capMin: CAP_MIN, capMax: CAP_MAX }), zh: L.zh, out: L.out };
}

function main() {
  const keys = arg('league') ? [arg('league')] : Object.keys(LEAGUES);
  for (const key of keys) {
    const r = verify(key);
    if (r.missingInbox) {
      /* 收件匣還沒到不是錯 —— 這支就是為了「交付一到就能核對」而先寫好的。
         但要講清楚在等什麼,不然看起來像壞掉。 */
      console.log(`· ${r.zh}:還沒有收件匣(data/manual/${r.missingInbox}),略過`);
      continue;
    }
    for (const line of deliveryLines(r, r.zh)) console.log(line);
    writeFileSync(join(ROOT, 'data', r.out), JSON.stringify(r, null, 2));
    console.log(`  → data/${r.out}`);
  }
}
if (process.argv[1] && process.argv[1].endsWith('verify-league-teams.mjs')) main();
