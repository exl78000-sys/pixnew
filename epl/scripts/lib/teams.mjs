import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* 隊名對照要能吃得下同一個來源在不同賽季的寫法差異。
   openfootball 就換過:2018-19 寫 "Manchester United"、2020-21 起寫
   "Manchester United FC";"AFC Bournemouth" 與 "Bournemouth" 也並存過。
   逐年補別名是打地鼠 —— 直接把「FC/AFC 前後綴、標點、大小寫」正規化掉,
   一條規則管所有賽季。 */
const loose = name => String(name ?? '')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/^afc\s+|\s+afc$/g, ' ')
  .replace(/^fc\s+|\s+fc$/g, ' ')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]/g, '');

export function loadTeams(root, { file = 'teams.json' } = {}) {
  const raw = JSON.parse(readFileSync(join(root, 'data', 'manual', file), 'utf8'));
  const byCode = new Map(), byOf = new Map(), byFpl = new Map(), byLoose = new Map();
  for (const t of raw.teams) {
    byCode.set(t.code, t);
    byOf.set(t.of, t);
    byFpl.set(t.fpl, t);
    /* 寬鬆對照是最後一道 —— 精確比對優先,別讓正規化蓋掉刻意設定的別名。
       alias 放「正規化橋不過去的簡稱」:Man Utd 跟 Man United 差的不是
       標點也不是 FC,是省略方式不同,那種只能列出來。 */
    for (const n of [t.of, t.fpl, t.en, ...(t.alias ?? [])]) if (n) byLoose.set(loose(n), t);
  }
  const codeOf = name =>
    (byOf.get(name) || byFpl.get(name) || byCode.get(name) || byLoose.get(loose(name)))?.code ?? null;
  return { list: raw.teams, byCode, byOf, byFpl, codeOf, looseKey: loose, updated: raw._updated };
}
