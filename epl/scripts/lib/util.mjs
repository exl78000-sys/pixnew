export const round = (n, d = 2) => {
  const p = 10 ** d;
  return Math.round((Number(n) || 0) * p) / p;
};
export const sum = (arr, f = x => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
export const mean = (arr, f = x => x) => (arr.length ? sum(arr, f) / arr.length : 0);
export const per90 = (v, minutes) => (minutes > 0 ? (v * 90) / minutes : 0);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 百分位(0~100):v 在 pool 中的位置,pool 已排序與否皆可
export function percentile(v, pool) {
  if (!pool.length) return 50;
  let below = 0, equal = 0;
  for (const p of pool) { if (p < v) below++; else if (p === v) equal++; }
  return round(((below + equal / 2) / pool.length) * 100, 1);
}

export const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;
