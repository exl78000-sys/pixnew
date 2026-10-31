#!/usr/bin/env node
/* 英超往季的「全部出場」(2026-10-31,使用者:「依推薦」)。
 *
 * 為什麼:球隊頁「誰進的、誰助攻的」往季走 FPL 的逐場明細(`data/raw/fpl/{季}-goals.json`),而那一份是外部協作
 * 從 vaastav 的 merged_gw.csv **篩出有進球或助攻的列**(2025-26:29,757 列篩剩 1,746 列)。於是上場分鐘只有
 * 「有進球那幾場」,每 90 分會被高估(Haaland 2024-25 表上 1,574 分 / 18 場),畫面只好不列分鐘。
 * 同一個檔每一位球員每一場都有一列 —— 這支把**有上場的那些列**全部留下來,build 用它補齊分鐘與先發 / 替補,
 * 來源、球員代碼、助攻的算法都跟進球明細同一份(不換成 FotMob,換了助攻數會變)。
 *
 * 兩個對照都要「同一季」的(CLAUDE.md:FPL 的 element 與 team id 每季重新編號):
 *   - element → 球員代碼:`{季}-players.csv` 的 id → code;
 *   - 對手的 team id → 本站隊碼:倉庫裡沒有 2024-25 的 teams.csv,所以從**已核對過的進球明細**反推 ——
 *     同一個人同一天的那一列,merged_gw 的 opponent_team 就是明細的 opp。要求 20 個 id 各對到恰好一個隊碼、
 *     20 個隊碼兩兩不同,任何一個 id 有兩種說法就整季不寫(拿不準就不做)。
 * 自我核對:進球明細的每一列(代碼 + 日期)都要在這裡找到同一場,而且分鐘與先發完全相同 —— 同一個檔的兩次篩選。
 *
 * 一季一個請求(raw.githubusercontent.com,靜態檔,沙箱與 runner 都抓得到)。往季不會再變,抓過就不必再抓。
 * 用法:node scripts/fetch-fpl-appearances.mjs [--season=2025-26] [--file=本機的 merged_gw.csv]
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSVObjects } from './lib/csv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const SEASONS = arg('season') ? [arg('season')] : ['2024-25', '2025-26'];
const URL = s => `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/${s}/gws/merged_gw.csv`;
export const APPEARANCE_COLS = ['code', 'date', 'opp', 'home', 'round', 'min', 'start'];

/* 純函式(npm test 拿捏造的資料驗):merged_gw 的列 + 同季名冊 + 已核對的進球明細 → 出場列,或拒絕的理由 */
export function extractAppearances(rows, { players, goalRecords }) {
  const codeOf = new Map(players.map(p => [String(p.id), String(p.code)]));
  const date = r => String(r.kickoff_time ?? '').slice(0, 10);
  /* 對手 id → 隊碼:用明細反推 */
  const recBy = new Map(goalRecords.map(r => [`${r.code}|${r.date}`, r]));
  const oppBy = new Map(), conflicts = [];
  for (const r of rows) {
    const rec = recBy.get(`${codeOf.get(String(r.element))}|${date(r)}`);
    if (!rec) continue;
    const id = String(r.opponent_team), old = oppBy.get(id);
    if (old && old !== rec.opp) conflicts.push(`${id}: ${old} / ${rec.opp}`);
    oppBy.set(id, rec.opp);
  }
  const teamIds = new Set(rows.map(r => String(r.opponent_team)));
  const codes = new Set(oppBy.values());
  if (conflicts.length) return { error: `對手 id 有兩種說法:${conflicts.slice(0, 3).join('、')}` };
  if (oppBy.size !== teamIds.size || codes.size !== oppBy.size) return { error: `對手 id 對不齊:${oppBy.size} 個 id 對到 ${codes.size} 個隊碼,檔裡有 ${teamIds.size} 個 id` };
  const out = [];
  let noCode = 0;
  for (const r of rows) {
    const min = Number(r.minutes);
    if (!(min > 0)) continue;
    const code = codeOf.get(String(r.element));
    if (!code) { noCode++; continue; }
    out.push([code, date(r), oppBy.get(String(r.opponent_team)), r.was_home === 'True' || r.was_home === true, Number(r.round), min, Number(r.starts) === 1]);
  }
  if (noCode) return { error: `${noCode} 列查不到球員代碼(名冊不是同一季?)` };
  /* 自我核對:明細的每一列都要在這裡、分鐘與先發相同 */
  const by = new Map(out.map(x => [`${x[0]}|${x[1]}`, x]));
  const bad = goalRecords.filter(g => { const x = by.get(`${g.code}|${g.date}`); return !x || x[5] !== g.min || x[6] !== g.start; });
  if (bad.length) return { error: `${bad.length} 筆進球明細在出場列裡找不到或分鐘 / 先發不同(例:${JSON.stringify(bad[0])})` };
  return { rows: out, teams: oppBy.size, checked: goalRecords.length };
}

async function main() {
  for (const season of SEASONS) {
    const pfile = join(ROOT, 'data', 'raw', 'fpl', `${season}-players.csv`);
    const gfile = join(ROOT, 'data', 'raw', 'fpl', `${season}-goals.json`);
    if (!existsSync(pfile) || !existsSync(gfile)) { console.log(`  ${season}:缺名冊或進球明細,略過`); continue; }
    const text = arg('file') ? readFileSync(arg('file'), 'utf8') : await (async () => {
      const res = await fetch(URL(season), { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${season} HTTP ${res.status}`);
      return res.text();
    })();
    const rows = parseCSVObjects(text);
    const players = parseCSVObjects(readFileSync(pfile, 'utf8'));
    const goalRecords = JSON.parse(readFileSync(gfile, 'utf8')).records;
    const r = extractAppearances(rows, { players, goalRecords });
    if (r.error) { console.log(`✗ ${season}:${r.error} —— 不寫`); process.exitCode = 1; continue; }
    const out = {
      _season: season, _source: URL(season), _generatedAt: new Date().toISOString(),
      _note: '每一位球員每一場有上場的那一列(merged_gw.csv 的 minutes > 0)。欄位見 _cols;對手隊碼由已核對的進球明細反推。',
      _counts: { csvRows: rows.length, appearances: r.rows.length, teams: r.teams, goalRecordsChecked: r.checked },
      _cols: APPEARANCE_COLS, rows: r.rows,
    };
    await writeFile(join(ROOT, 'data', 'raw', 'fpl', `${season}-appearances.json`), `${JSON.stringify(out)}\n`);
    console.log(`✔ ${season}:${rows.length} 列 → 出場 ${r.rows.length} 列・對手 ${r.teams} 隊・進球明細 ${r.checked} 筆全部對上`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error('抓取失敗:', e.message); process.exitCode = 1; });
