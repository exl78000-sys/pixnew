// Adapter:openfootball / football.json → Canonical Match
//
// 特性:免費、公共領域、有半場比分,但更新很慢(英超開季兩天後仍是 0/380 有比分),
// 所以定位是「歷史賽果與賽程」,即時比分要靠別的 adapter。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeMatch } from '../canonical.mjs';

export const id = 'openfootball';
export const label = 'openfootball / football.json';
export const supports = ['matches'];

// 比分有兩種格式:{"score":{"ft":[2,1],"ht":[1,0]}} 與 {"score":[0,0]}
function readScore(score) {
  if (!score) return null;
  if (Array.isArray(score)) {
    const ft = score.map(Number);
    // 0-0 收場,半場必然也是 0-0,可安全補上;其餘不臆測
    const ht = ft[0] === 0 && ft[1] === 0 ? [0, 0] : null;
    return { ft, ht };
  }
  if (!score.ft) return null;
  return { ft: score.ft.map(Number), ht: score.ht ? score.ht.map(Number) : null };
}

const roundNo = r => {
  const m = /(\d+)/.exec(r || '');
  return m ? Number(m[1]) : null;
};

/* tolerant:對照不到隊名時跳過那場,而不是整份拋錯。
   只有「歷來交手」那條路徑會開 —— 更早的賽季會有早就降級、現在不在英超的球隊,
   為了顯示交手紀錄去補一整批已經不相干的球隊資料並不划算,
   而那些場次本來就不會出現在任何一組現役球隊的交手紀錄裡。
   進模型的資料一律不開這個開關:那裡少一支球隊就是資料錯了,必須吵。 */
export function loadMatches({ root, competition, season, codeOf, tolerant = false }) {
  const raw = JSON.parse(readFileSync(join(root, 'data', 'raw', 'openfootball', `${season}.json`), 'utf8'));
  const skipped = [];
  const out = raw.matches.map((m, i) => {
    const home = codeOf(m.team1), away = codeOf(m.team2);
    if (!home || !away) {
      if (tolerant) { if (!home) skipped.push(m.team1); if (!away) skipped.push(m.team2); return null; }
      throw new Error(`[${id}] 隊名無法對照:${m.team1} / ${m.team2}(請補 data/manual/teams.json)`);
    }
    const s = readScore(m.score);
    return makeMatch(id, {
      id: `${season}-${i}`,          // 沿用既有格式,避免既有連結失效
      competition, season,
      round: roundNo(m.round),
      date: m.date,
      // openfootball 給的是英國當地時間;有 FPL 的精確 UTC 時就會在 build 覆蓋掉
      kickoff: m.time ? `${m.date}T${m.time}:00+01:00` : null,
      home, away,
      played: !!s,
      fh: s ? s.ft[0] : null,
      fa: s ? s.ft[1] : null,
      hh: s?.ht ? s.ht[0] : null,
      ha: s?.ht ? s.ht[1] : null,
    });
  }).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dropped = raw.matches.length - out.length;

  /* 跳過了誰一定要講出來。
     tolerant 的用意是「已降級、現在不相干的球隊可以略過」,
     但它同樣會吞掉「隊名寫法變了所以對不上」—— 那是真的漏資料。
     這裡把跳過的隊名印出來,由人判斷是哪一種。(實際踩過:openfootball
     2018-19 寫 "Manchester United"、2020-21 起寫 "Manchester United FC",
     曼聯的交手紀錄因此少了兩季,而畫面上完全看不出來。) */
  if (skipped.length) {
    const names = [...new Set(skipped)].sort();
    console.log(`  · ${season} 跳過 ${dropped} 場,對照不到:${names.join('、')}`);
  }
  return out;
}
