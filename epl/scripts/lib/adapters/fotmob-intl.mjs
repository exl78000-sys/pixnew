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
 * 沒收的在下面的 INTL_NOT_FETCHED:這個窗口**一場都沒有**(接下來 45 天 0 場),那一季開打時再加進來,
 * 不留一個永遠空白的分頁(鐵則三)。**不是每一個都證明過** —— 歐國盃(50)與亞洲盃(290)的本季是下一屆
 * (2028 / 2027),一場都還沒踢,內容比對無從做起;第一版註解寫成「全部證明過」,是錯的。
 *
 * `tournament` 是這個賽事在 martj42 裡叫什麼(`expect` 一定要認得它,npm test 守著)。**只給中立場推論用**:
 * 推論要知道這一場屬於哪一類(主辦型 / 主客場型 / 友誼賽)、同一屆在 martj42 裡已經踢了哪幾場(lib/intl.mjs 的
 * makeVenueModel)。友誼賽底下的邀請賽(Baltic Cup 那種)從 FotMob 的賽程分不出來,一律當友誼賽推。 */
export const FOTMOB_INTL = [
  { key: 'unl-a', id: 9806, zh: '歐洲國家聯賽 A 級', short: '歐國聯 A', en: 'UEFA Nations League A', family: 'unl', tournament: 'UEFA Nations League', expect: /^UEFA Nations League$/ },
  { key: 'unl-b', id: 9807, zh: '歐洲國家聯賽 B 級', short: '歐國聯 B', en: 'UEFA Nations League B', family: 'unl', tournament: 'UEFA Nations League', expect: /^UEFA Nations League$/ },
  { key: 'unl-c', id: 9808, zh: '歐洲國家聯賽 C 級', short: '歐國聯 C', en: 'UEFA Nations League C', family: 'unl', tournament: 'UEFA Nations League', expect: /^UEFA Nations League$/ },
  { key: 'unl-d', id: 9809, zh: '歐洲國家聯賽 D 級', short: '歐國聯 D', en: 'UEFA Nations League D', family: 'unl', tournament: 'UEFA Nations League', expect: /^UEFA Nations League$/ },
  { key: 'cnl', id: 9821, zh: '中北美國家聯賽', short: '中北美國聯', en: 'CONCACAF Nations League', family: 'cnl', tournament: 'CONCACAF Nations League', expect: /^CONCACAF Nations League$/ },
  { key: 'afconq', id: 10608, zh: '非洲國家盃資格賽', short: '非洲盃資格賽', en: 'Africa Cup of Nations Qualification', family: 'afconq', tournament: 'African Cup of Nations qualification', expect: /^African Cup of Nations qualification$/ },
  { key: 'gulf', id: 329, zh: '海灣盃', short: '海灣盃', en: 'Gulf Cup', family: 'gulf', tournament: 'Gulf Cup', expect: /^Gulf Cup$/ },
  /* 友誼賽的 expect 收「友誼賽或其他」兩類:FotMob 把邀請賽也放在這個 id 底下 —— run #43 對上的 61 場裡
     martj42 記成 Friendly 的 54 場,其餘是 Baltic Cup×4、Diamond Jubilee International Football Tournament×2、
     Tri-Nations Cup×1,在本站的分級都是 other。**不收資格賽與洲際決賽圈**:那兩類出現在這個 id 底下就是 id 錯了。 */
  { key: 'friendly', id: 114, zh: '國際友誼賽', short: '友誼賽', en: 'International Friendlies', family: 'friendly', tournament: 'Friendly',
    expect: t => tournamentClass(t) === 'friendly' || tournamentClass(t) === 'other' },
];

/* 探測過、這一輪沒收的國家隊賽事(probe-fotmob-intl run #43,2026-09-24 的 log)。
   `proof` 是那一次拿本季最近 80 場已完賽對 martj42 的「對上 / 取樣」;**null = 那一季還沒有已完賽的場次,
   id 沒被內容證明** —— 加進 FOTMOB_INTL 之前抓取器會自己證明(本季不夠就拿上一季)。
   畫面的「資料界線」讀這一份(經產物),前端不另寫一份清單。 */
export const INTL_NOT_FETCHED = {
  checkedAt: '2026-09-24', horizonDays: 45, probeRun: 43,
  comps: [
    { id: 10195, zh: '世界盃資格賽(歐洲區)', proof: '69/80' },
    { id: 10196, zh: '世界盃資格賽(非洲區)', proof: '80/80' },
    { id: 10197, zh: '世界盃資格賽(亞洲區)', proof: '68/80' },
    { id: 10198, zh: '世界盃資格賽(中北美區)', proof: '77/80' },
    { id: 10199, zh: '世界盃資格賽(南美區)', proof: '80/80' },
    { id: 10200, zh: '世界盃資格賽(大洋洲區)', proof: '18/18' },
    { id: 10201, zh: '世界盃洲際附加賽', proof: '4/4' },
    { id: 77, zh: '世界盃', proof: '73/80' },
    { id: 50, zh: '歐國盃', proof: null },
    { id: 10607, zh: '歐國盃資格賽', proof: '9/9' },
    { id: 44, zh: '美洲盃', proof: '29/32' },
    { id: 289, zh: '非洲國家盃', proof: '52/52' },
    { id: 290, zh: '亞洲盃', proof: null },
    { id: 10609, zh: '亞洲盃資格賽', proof: '54/72' },
    { id: 298, zh: '中北美金盃賽', proof: '25/31' },
    { id: 9265, zh: '東協錦標賽', proof: '26/26' },
    { id: 9876, zh: '南亞足協錦標賽', proof: '15/15' },
    { id: 10242, zh: 'FIFA 阿拉伯盃', proof: '26/32' },
    { id: 11156, zh: '阿拉伯盃資格賽', proof: '7/7' },
  ],
};

/* 畫面上的篩選以「賽事家族」為單位:歐國聯四個級別是同一個賽事,拆成四顆按鈕只會讓讀者找不到。
   順序就是畫面上的順序。 */
export const INTL_FAMILIES = [
  { key: 'unl', zh: '歐國聯' },
  { key: 'cnl', zh: '中北美國聯' },
  { key: 'afconq', zh: '非洲盃資格賽' },
  { key: 'gulf', zh: '海灣盃' },
  { key: 'friendly', zh: '友誼賽' },
];

/* **參與者還沒決定的那一格**(2026-09-24 run #44 實測):海灣盃的四強與決賽,上游先把對戰排好,
   參與者寫成 `1A`、`2B`、`Winner SF 1`,**而且各自帶一個隊 id**(1870、1983…)—— 照球隊處理的話,
   它們會被當成三支叫「1A」的國家隊。不編身分(鐵則三,盃賽 `Manchester City/Norwich City` 那條坑的國家隊版):
   建置時看名字認出來,不查身分、不給勝率,畫面講出它代表什麼。
   只認實測見過的兩種寫法加盃賽那一種(斜線串兩隊);沒見過的寫法會落到「隊名對不上身分」那一份清單 —— 看得到,不會被吞掉。 */
export function isIntlTbd(name) {
  const n = String(name ?? '').trim();
  return /^[1-9][A-Z]$/.test(n) || /^(Winner|Loser)\s+\S/i.test(n) || n.includes('/');
}
/* 佔位的中文說法:只翻實測見過、意思沒有歧義的兩種,其餘照印原文加「待定」 */
export function intlTbdLabel(name) {
  const n = String(name ?? '').trim();
  let m = /^([1-9])([A-Z])$/.exec(n);
  if (m) return `${m[2]} 組第 ${m[1]} 名`;
  m = /^Winner SF\s*(\d)$/i.exec(n);
  if (m) return `準決賽 ${m[1]} 的勝者`;
  return `待定(${n})`;
}

/* 輪次的中文。**只翻數字與驗證過的名字** —— 上游的 round 字串在不同賽事意思不同:
   海灣盃的 `final` 是決賽(對戰是 Winner SF 1 v Winner SF 2),非洲盃資格賽的 `final` 卻是**三月的預賽**
   (12 場主客兩回合,Eritrea v Eswatini 那一種;run #44 實測)。照字面翻會把預賽講成決賽。
   沒驗證過的非數字輪次不印,不猜。 */
const ROUND_ZH = { gulf: { '1/2': '準決賽', final: '決賽' } };
export function intlRoundZh(compKey, round) {
  if (round == null) return null;
  if (/^\d+$/.test(String(round))) return `第 ${round} 輪`;
  return ROUND_ZH[compKey]?.[round] ?? null;
}

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

/* ── 分組積分榜(2026-09-25)──────────────────────────────────────────
   第一版在這裡留了一個 compactTable,註解寫「形狀要等第一次真抓才看得到」—— probe-intl-tables(run #45)
   看過之後才寫這一支。八個賽事實測的形狀:

     table[0].data.tables[]            一組一張(七個有分組的賽事全是 composite: true;友誼賽 table 是 null)
       .leagueName                     "Grp. 1" / "Grp. A" / "B Grp. 1"(中北美國聯的 B 級第 1 組)
       .leagueId                       這一組自己的 id
       .legend[]                       晉級規則:tKey、英文 title、顏色、indices = **從 0 起算**的名次
       .table.all[]                    每一列:name、id、played、wins、draws、losses、scoresStr、goalConDiff、pts、idx、
                                       deduction、ongoing(home / away / xg 是主客場與 xG 的拆分,本站不用)

   兩件會咬人的事:
     1. **ongoing 不是 null 的那一列,已經把進行中的比賽算進去了**(Costa Rica `played: 1`、`scoresStr: "3-0"`,
        而 ongoing 說那場 status S)。這裡把它記成 `live`(那一場的 id),建置時積分由本站自己用已完賽的賽果算。
     2. `scoresStr` 是「進-失」,不是比分;淨勝球是 goalConDiff。

   `data.tables` 以外的形狀(單一一張表)這八個賽事一個都沒出現過 —— 不猜,回 null,建置那邊講「上游沒有分組積分榜」。 */
export function normalizeIntlTable(table) {
  const data = Array.isArray(table) ? table[0]?.data : null;
  if (!Array.isArray(data?.tables) || !data.tables.length) return null;
  return data.tables.map(t => ({
    name: t?.leagueName ?? null,
    fmId: t?.leagueId != null ? String(t.leagueId) : null,
    legend: (t?.legend ?? []).map(l => ({ key: l?.tKey ?? null, title: l?.title ?? null,
      idx: Array.isArray(l?.indices) ? l.indices.filter(Number.isInteger) : [] })),
    rows: (t?.table?.all ?? []).map(r => {
      const gfga = parseScore(r?.scoresStr);
      return {
        fmId: r?.id != null ? String(r.id) : null, name: r?.name ?? null, idx: r?.idx ?? null,
        played: r?.played ?? null, wins: r?.wins ?? null, draws: r?.draws ?? null, losses: r?.losses ?? null,
        gf: gfga?.[0] ?? null, ga: gfga?.[1] ?? null, pts: r?.pts ?? null,
        deduction: r?.deduction ?? null,
        live: r?.ongoing ? String(r.ongoing.id ?? 'unknown') : null,
      };
    }),
  }));
}

/* 組名的中文。**只翻看過的三種寫法**,其餘照印上游的字 —— 猜錯組別比印英文糟。 */
export function intlGroupZh(name) {
  const s = String(name ?? '');
  let m = /^Grp\. (\d+)$/.exec(s);
  if (m) return `第 ${m[1]} 組`;
  m = /^Grp\. ([A-Z])$/.exec(s);
  if (m) return `${m[1]} 組`;
  m = /^([A-D]) Grp\. (\d+)$/.exec(s);
  if (m) return `${m[1]} 級第 ${m[2]} 組`;
  return s || null;
}

/* 晉級規則(legend 的 tKey)的中文與語氣。**只收 run #45 看過的八個**:
   沒看過的 tKey 照印上游的英文 title,不翻 —— 「Relegation」翻成「升級」那種錯,畫面完全看不出來。
   tone 是畫面的顏色類別(好 / 中性偏好 / 警告 / 壞),不是上游的色碼。 */
export const INTL_LEGEND_ZH = {
  championship_playoff: { zh: '爭冠淘汰賽', tone: 'good' },
  qualification_next_stage: { zh: '晉級下一階段', tone: 'good' },
  promotion: { zh: '升級', tone: 'good' },
  promotionqual: { zh: '升級附加賽', tone: 'maybe' },
  possible_qualification_next_stage: { zh: '可能晉級下一階段', tone: 'maybe' },
  relegationqual: { zh: '降級附加賽', tone: 'warn' },
  possiblerelegation: { zh: '可能降級', tone: 'warn' },
  relegation: { zh: '降級', tone: 'bad' },
};
