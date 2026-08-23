// 最小 RFC4180 CSV 解析器(FPL 的 news 欄位含逗號與引號,不能用 split)
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// 轉成物件陣列(第一列為表頭)
export function parseCSVObjects(text) {
  const rows = parseCSV(text).filter(r => r.length > 1);
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
}

export const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
