#!/usr/bin/env node
/* 清掉 web/assets/img/h/ 裡沒有任何產物引用的圖檔(2026-09-26,A2 + A3)。

   圖檔是內容雜湊命名的(lib/image-files.mjs):圖換了就是新檔名,舊檔沒有人會再指到它。
   放著不清的話部署上傳物會慢慢長大(每換一次頭貼就多一個孤兒)。
   排在 `npm run build` 的最後一步 —— 那是六個聯賽裡最後跑的 build,所有產物都在了才知道誰還被引用;
   只跑某一個聯賽的 build 時舊檔會留到下一次完整 build,測試只回報不擋。 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneImages } from './lib/image-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = pruneImages(join(ROOT, 'web'));
console.log(`✔ 圖檔清理:${r.referenced} 個被產物引用、留 ${r.kept} 個、清掉 ${r.removed} 個孤兒`);
