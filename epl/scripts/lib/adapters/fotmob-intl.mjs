/* Adapter:FotMob 聯賽端點的國家隊賽事 → 本站 canonical 國家隊場次。
 *
 * 端點跟英格蘭盃賽同一個(`api/data/leagues?id=…`),場次在 `fixtures.allMatches[]`,
 * 每場 `{ id, home{name,shortName,id}, away{…}, status{utcTime, started, finished, cancelled, scoreStr, reason}, round, roundName, group }`
 * —— 以上是 2026-09-24 探測實測的(probe-fotmob-intl.mjs,run #42 / #43),不是文件。
 *
 * **id 一律證明過才收**(德甲那次:奧地利甲也叫 Bundesliga;這次:CONCACAF 也叫 Nations League、
 * allLeagues 把女足的 10557 叫成「UEFA Nations League A Qualification」)。證明法是**拿已完賽的場次
 * 逐場對 martj42**(日期 ±1 天、兩隊、比分):對上的那幾場在 martj42 叫什麼賽事,就是這個 id 的身分。
 * 本季還沒踢的(Nations League 2026/27)拿**上一季**對。每一筆的證據寫在 `proof` 裡。
 */

import { tournamentClass } from '../intl.mjs';

/* 收哪些賽事。**只收這個窗口有比賽、而且 id 證明過的**(probe-fotmob-intl run #42 / #43,2026-09-24)。
 *
 * `expect` 是證明用的:抓取器會拿一季**已完賽**的場次逐場對 martj42(本季沒踢完就拿上一季),
 * 對上的那幾場在 martj42 叫什麼賽事,要符合這個規則才算這個 id 是它 —— 名字不算數。
 * run #43 的上一季比對:9806 60/60、9807 30/48(差的 18 場是隊名寫法 Ireland/Czechia/Turkiye)、
 * 9808 48/48(比分一致 47,另一場是判決 3-0)、9809 12/12、9821 96/110。
 * 10608 與 329 在 run #43 時本季已完賽的還沒進 martj42,所以**交給抓取器第一次跑時用上一季證明**。
 *
 * 沒收的:各洲世界盃資格賽、歐國盃資格賽、世界盃、歐國盃、美洲盃、非洲盃、亞洲盃、金盃、東協盃、
 * SAFF、阿拉伯盃 —— run #43 全部證明過 id,但這個窗口**一場都沒有**(接下來 45 天 0 場)。
 * 那一季開打時再加進來,不留一個永遠空白的分頁(鐵則三)。 */
export const FOTMOB_INTL = [
  { key: 'unl-a', id: 9806, zh: '歐洲國家聯賽 A 級', short: '歐國聯 A', en: 'UEFA Nations League A', family: 'unl', expect: /^UEFA Nations League$/ },
  { key: 'unl-b', id: 9807, zh: '歐洲國家聯賽 B 級', short: '歐國聯 B', en: 'UEFA Nations League B', family: 'unl', expect: /^UEFA Nations League$/ },
  { key: 'unl-c', id: 9808, zh: '歐洲國家聯賽 C 級', short: '歐國聯 C', en: 'UEFA Nations League C', family: 'unl', expect: /^UEFA Nations League$/ },
  { key: 'unl-d', id: 9809, zh: '歐洲國家聯賽 D 級', short: '歐國聯 D', en: 'UEFA Nations League D', family: 'unl', expect: /^UEFA Nations League$/ },
  { key: 'cnl', id: 9821, zh: '中北美國家聯賽', short: '中北美國聯', en: 'CONCACAF Nations League', family: 'cnl', expect: /^CONCACAF Nations League$/ },
  { key: 'afconq', id: 10608, zh: '非洲國家盃資格賽', short: '非洲盃資格賽', en: 'Africa Cup of Nations Qualification', family: 'afconq', expect: /^African Cup of Nations qualification$/ },
  { key: 'gulf', id: 329, zh: '海灣盃', short: '海灣盃', en: 'Gulf Cup', family: 'gulf', expect: /^Gulf Cup$/ },
  /* 友誼賽的 expect 收「友誼賽或其他」兩類:FotMob 把邀請賽也放在這個 id 底下 —— run #43 對上的 61 場裡
     martj42 記成 Friendly 的 54 場,其餘是 Baltic Cup×4、Diamond Jubilee International Football Tournament×2、
     Tri-Nations Cup×1,在本站的分級都是 other。**不收資格賽與洲際決賽圈**:那兩類出現在這個 id 底下就是 id 錯了。 */
  { key: 'friendly', id: 114, zh: '國際友誼賽', short: '友誼賽', en: 'International Friendlies', family: 'friendly',
    expect: t => tournamentClass(t) === 'friendly' || tournamentClass(t) === 'other' },
];

/* 比分字串 → [主, 客];PK 場的 scoreStr 是平手比分(含延長),PK 勝負不在這個端點 */
const parseScore = s => {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s ?? '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/* 一場比賽 → canonical。**不在這裡查隊碼** —— 身分由 lib/intl-teams.mjs 在建置時解析,
   raw 只存上游給的東西(隊名與 FotMob 的隊 id),換對照表不必重抓。 */
export function normaliseIntlMatch(m) {
  const st = m?.status ?? {};
  const finished = st.finished === true;
  const started = st.started === true;
  const cancelled = st.cancelled === true;
  const reason = st.reason?.short ?? null;
  const final = finished ? parseScore(st.scoreStr) : null;
  const team = t => (t ? { name: t.name ?? null, shortName: t.shortName ?? null, fmId: t.id != null ? String(t.id) : null } : null);
  return {
    id: m?.id != null ? String(m.id) : null,
    kickoff: st.utcTime ?? null,
    home: team(m?.home),
    away: team(m?.away),
    state: cancelled ? 'CANCELLED' : !started ? 'NS' : !finished ? 'LIVE' : 'FT',
    final,
    reason,                        // FT / AET / Pen / AW(照抄,沒見過的由建置印出來)
    /* 未開賽的場次也可能帶 reason(延期、取消)—— 長句照抄,畫面照印,不自己翻 */
    reasonLong: st.reason?.long ?? null,
    /* AW = 判決比分(run #43:Romania 3-0 Kosovo、Malaysia 0-3 Nepal/Vietnam)。martj42 記的是**場上**比分
       (0-0、2-0、4-0),兩家記法不同 —— 不是誰錯,核對時分開算,畫面兩個都講 */
    awarded: reason === 'AW',
    round: m?.round != null ? String(m.round) : null,
    group: m?.group ?? null,
  };
}

/* 積分榜:只留畫面會用到的欄位。`table[].data.table.all[]` 的形狀在第一次真抓時才看得到 ——
   這裡**只保留原樣的最小子集**,不猜欄位名;抓回來之後建置那一步再決定怎麼用。 */
export function compactTable(table) {
  if (!Array.isArray(table)) return null;
  return table.map(t => ({ name: t?.data?.leagueName ?? t?.data?.name ?? null, raw: t?.data ?? null }));
}
