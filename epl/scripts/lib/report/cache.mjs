import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/* 以 bundle 的內容雜湊當快取鍵。
 *
 * 這條規則同時解決兩件事:
 * 1. 省錢:資料沒變就不重打 LLM(重跑 build 不會產生任何 API 費用)
 * 2. 一致:同一份數字永遠對應同一篇文字,不會每次 build 都換一套說法
 *
 * 只要 bundle 裡任何一個數字變了,hash 就變,報告自然重寫 —— 不需要手動失效。
 */

// JSON.stringify 的鍵順序會跟著物件建立順序跑,先正規化才能保證雜湊穩定
const canonicalJson = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
};

export function bundleHash(bundle) {
  // provenance.asOf 每天都會變,但它不影響內容,排除掉才不會天天全部重算
  const { provenance, ...rest } = bundle;
  const stable = { ...rest, provenance: { source: provenance.source, model: provenance.model } };
  return createHash('sha256').update(canonicalJson(stable)).digest('hex').slice(0, 16);
}

export class ReportCache {
  constructor(root) {
    this.file = join(root, 'data', 'cache', 'reports.json');
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      for (const [k, val] of Object.entries(raw.entries ?? {})) this.map.set(k, val);
    } catch { /* 沒有快取檔就是第一次跑 */ }
    return this;
  }

  get(hash) {
    const hit = this.map.get(hash);
    if (hit) this.hits++; else this.misses++;
    return hit ?? null;
  }

  set(hash, value) { this.map.set(hash, value); }

  // 只保留這次 build 用得到的鍵,快取檔才不會無限長大
  async save(keep = null) {
    const entries = {};
    for (const [k, val] of this.map) if (!keep || keep.has(k)) entries[k] = val;
    const n = Object.keys(entries).length;
    // 沒有 API key 時快取一定是空的,不必留一個空檔案在版控裡
    if (!n) { await rm(this.file, { force: true }); return 0; }
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeFile(this.file, JSON.stringify({ version: 1, entries }, null, 0));
    return n;
  }
}
