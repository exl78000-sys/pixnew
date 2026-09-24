#!/usr/bin/env node
/* 從 GitHub Actions 的 job log 還原探測印出來的檔案(DUMP 區塊),逐檔比對位元組數與 sha256。
 *
 *   node scripts/undump-probe-log.mjs <log 檔> <輸出目錄>
 *
 * ── 為什麼要這一支(2026-09-24,國家隊抓取器)──
 * 沙箱連不到 FotMob,而部署那一支(epl-live.yml)在開發分支上跑會連 Pages 一起部署 —— 還沒合併的抓取器
 * 不能那樣驗。所以探測(例如 probe-intl-fetch.mjs)在 runner 上**真跑一次抓取器**、寫暫存目錄,
 * 再把檔案 gzip + base64 印在 log 最後:
 *
 *   DUMP-BEGIN <檔名> <原始位元組數> <sha256> <段數>
 *   DUMP <檔名> <第幾段> <base64>
 *   DUMP-END <檔名>
 *
 * GitHub MCP 的 get_job_logs 回傳太大時會**自動存成本機檔案**(一個 JSON,內容在 `logs_content`)——
 * 這支兩種都吃:那個 JSON,或是純文字的 log(每行前面的時間戳會被剝掉)。
 *
 * **對不上雜湊的檔一律不寫**:log 被截斷(讀的是尾端,段數不夠)或任何一段壞掉,寫出去的就是半份檔案,
 * 而它看起來完全正常。段數不齊的會印出來 —— 那代表要把 tail_lines 再加大重讀一次。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const [logFile, outDir] = process.argv.slice(2);
if (!logFile || !outDir) { console.error('用法:node scripts/undump-probe-log.mjs <log 檔> <輸出目錄>'); process.exit(2); }

let text = readFileSync(logFile, 'utf8');
try { const j = JSON.parse(text); if (typeof j?.logs_content === 'string') text = j.logs_content; } catch { /* 純文字 log */ }
const lines = text.split('\n').map(l => l.replace(/\r$/, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''));

const files = new Map();
for (const l of lines) {
  let m = /^DUMP-BEGIN (\S+) (\d+) ([0-9a-f]{64}) (\d+)$/.exec(l);
  if (m) { files.set(m[1], { len: Number(m[2]), sha: m[3], n: Number(m[4]), chunks: [] }); continue; }
  m = /^DUMP (\S+) (\d+) (\S+)$/.exec(l);
  if (m && files.has(m[1])) files.get(m[1]).chunks[Number(m[2])] = m[3];
}
if (!files.size) { console.error('✗ log 裡沒有 DUMP-BEGIN —— 讀到的可能不是那個探測的尾端'); process.exit(1); }

mkdirSync(outDir, { recursive: true });
let bad = 0;
for (const [name, x] of files) {
  // 檔名來自 log:只收單純的檔名,不讓它寫到輸出目錄以外
  if (basename(name) !== name) { console.log(`✗ ${name}:檔名帶路徑,不寫`); bad++; continue; }
  const have = x.chunks.filter(Boolean).length;
  if (have !== x.n) { console.log(`✗ ${name}:只讀到 ${have}/${x.n} 段(log 被截斷?把 tail_lines 加大重讀)`); bad++; continue; }
  let buf;
  try { buf = gunzipSync(Buffer.from(x.chunks.join(''), 'base64')); } catch (e) { console.log(`✗ ${name}:解不開(${e.message})`); bad++; continue; }
  const sha = createHash('sha256').update(buf).digest('hex');
  if (buf.length !== x.len || sha !== x.sha) { console.log(`✗ ${name}:位元組數 ${buf.length}/${x.len}、sha256 ${sha === x.sha ? '一致' : '不一致'}`); bad++; continue; }
  writeFileSync(join(outDir, name), buf);
  console.log(`✓ ${name}  ${buf.length} bytes  sha256 ${sha.slice(0, 16)}`);
}
console.log(`${files.size} 個檔,${bad} 個沒寫`);
process.exitCode = bad ? 1 : 0;
