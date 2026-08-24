/* 數字驗證 —— AI 報告能不能上線的守門員。
 *
 * 規則很簡單:文章裡出現的每一個數字,都必須能在 feature bundle 的 facts 找到對應。
 * 找不到就是模型自己編的,整篇退回,改用模板版本。
 *
 * 這比「叫模型不要亂編」可靠得多,因為它不靠模型自律,是事後可驗證的硬檢查。
 */

// 文章裡合理出現、且不代表任何統計量的數字。
// 只放語意上不可能是數據的:比賽人數、半場、名次序數的中文寫法不在此列(那些必須來自 facts)。
const STRUCTURAL = new Set([90, 45, 11, 0, 1, 2, 3]);

// 負號只有在前面不是數字時才算負號,否則「4-4-2」會被讀成 4、-4、-2
const NUM = /(?<![\d.\-])-?\d+(?:\.\d+)?/g;

// facts 允許的字面值:原始值,加上常見的四捨五入與百分比寫法
function allowedValues(facts) {
  const set = new Set();
  const add = v => {
    if (v === null || v === undefined || Number.isNaN(v)) return;
    set.add(Number(v));
  };
  for (const f of facts) {
    add(f.value);
    if (typeof f.value === 'number') {
      add(Math.abs(f.value));   // 負值的量值也算有據:「比期望少進 4.9 球」來自 finishing = -4.9
      for (const d of [0, 1, 2]) add(Number(f.value.toFixed(d)));
      // 機率寫成百分比
      if (f.value > 0 && f.value < 1) for (const d of [0, 1]) add(Number((f.value * 100).toFixed(d)));
    }
    // text 本身若含數字也放行(例如 "45%" 對應 0.4521)
    for (const m of String(f.text).match(NUM) ?? []) add(Number(m));
  }
  return set;
}

/* 回傳 { ok, unattested: [{ token, context }] } */
export function verifyNumbers(prose, facts) {
  const allowed = allowedValues(facts);
  const unattested = [];
  for (const m of prose.matchAll(NUM)) {
    const token = m[0];
    const n = Number(token);
    if (STRUCTURAL.has(n) || allowed.has(n)) continue;
    // 允許小數位寫少一位:0.75 寫成 0.8
    const d = (token.split('.')[1] ?? '').length;
    if ([...allowed].some(v => Number(v.toFixed(d)) === n)) continue;
    const at = m.index ?? 0;
    unattested.push({ token, context: prose.slice(Math.max(0, at - 14), at + token.length + 14) });
  }
  return { ok: unattested.length === 0, unattested };
}

/* 額外檢查:不准出現真實世界不可能由 bundle 支撐的斷言用語。
   模型很愛加「傷兵」「轉會」「主場氣氛」,但 bundle 裡根本沒有這些資料。 */
const UNSUPPORTED = ['傷兵', '傷停', '轉會', '簽下', '球迷', '氣氛', '天氣', '裁判', '賠率', '盤口'];

export function verifyClaims(prose) {
  const hits = UNSUPPORTED.filter(w => prose.includes(w));
  return { ok: hits.length === 0, hits };
}

export function verify(prose, facts) {
  const n = verifyNumbers(prose, facts);
  const c = verifyClaims(prose);
  return {
    ok: n.ok && c.ok,
    unattested: n.unattested,
    unsupported: c.hits,
    reason: n.ok ? (c.ok ? null : `提到 bundle 沒有的主題:${c.hits.join('、')}`)
      : `未經證實的數字:${n.unattested.map(u => u.token).join('、')}`,
  };
}
