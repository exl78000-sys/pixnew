/* 分享圖卡(2026-11-27,N7)的守門。圖會離開本站,離開之後沒有頁面可以對照 —— 所以:
   圖上的數字一律是呼叫端傳進來的字串(這裡不算任何數字)、沒有的格子不畫、賽前 / 事後的差別要上圖。 */
import { readFileSync } from 'node:fs';
import { matchCardSpec, predictCardSpec, specTexts } from '../web/assets/js/share-card.js';

let fail = 0;
const check = (c, label, detail = '') => { console.log(`  ${c ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`); if (!c) fail++; };
console.log('\n▶ 分享圖卡');

const nums = s => (s.match(/\d+(?:\.\d+)?/g) ?? []);
const inp = { home: 'Arsenal', away: 'Chelsea', sub: '英超 2026-27・第 12 輪・11/29 01:30', played: true, preFrozen: true,
  score: '2 : 1', xg: '1.84 : 0.92', probs: { home: '57%', draw: '24%', away: '19%' } };
const spec = matchCardSpec(inp);
const allowed = new Set(nums(JSON.stringify(inp)));
const extra = specTexts(spec).flatMap(nums).filter(n => !allowed.has(n));
check(!extra.length, '圖上每一個數字都是頁面傳進來的(這裡不算、不四捨五入)', extra.join('、') || '0 個多出來的');
check(spec.bigLabel === '最終比分' && spec.probsLabel.includes('開賽前凍結'), '已賽而有賽前快照:大字是比分、機率標「開賽前凍結」');
check(matchCardSpec({ ...inp, preFrozen: false }).probsLabel.includes('事後擬合'), '沒有賽前快照的已賽場次:機率標事後擬合、不是當時的預測');
check(matchCardSpec({ ...inp, played: false, score: null }).bigLabel === '模型預期進球', '未賽:大字是模型預期進球');
check(matchCardSpec({ ...inp, probs: null }).probs === null, '沒有機率就不畫機率那一塊(不畫「—」佔位)');
check(matchCardSpec({ ...inp, played: false, score: null, xg: null }) === null, '什麼數字都沒有就不給畫');

const p = predictCardSpec({ comp: '英超', n: 12, rows: [['你', '58.3%'], ['模型最看好的那一邊', '50.0%'], ['市場最看好的那一邊', null]] });
check(p.rows.length === 2 && !JSON.stringify(p).includes('市場'), '沒有盤口的那一列整列不畫');
check(predictCardSpec({ comp: '英超', n: 0, rows: [['你', '0.0%']] }) === null, '沒有已完賽的預測就不給畫');

/* 頁面那一側:傳的是頁首同一組 headP 與同一個 C.pct,不是另外算 */
const strip = f => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const an = strip('../web/assets/js/page-analysis.js');
const blk = an.slice(an.indexOf("getElementById('shareCardBtn')"), an.indexOf('shareCard(spec'));
check(/preFrozen: headIsPre/.test(blk) && /C\.pct\(headP\.home, 0\)/.test(blk) && !/postFit/.test(blk),
  '單場頁的圖跟頁首用同一組機率(headP)與同一個賽前 / 事後判斷');
const pv = strip('../web/assets/js/predict-view.js');
check(/predictCardSpec\(/.test(pv) && /C\.pct\(t\.you, 1\)/.test(pv), '我的預測的圖跟成績卡同一個格式(C.pct 一位小數)');

console.log(fail ? `\n✗ 分享圖卡:${fail} 條沒過` : '\n✓ 分享圖卡:全部通過');
process.exit(fail ? 1 : 0);
