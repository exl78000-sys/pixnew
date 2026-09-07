/* Adapter:FotMob 聯賽端點的盃賽場次 → 本站 canonical 盃賽場次。
 *
 * 形狀跟 SportMonks 那一版一樣(stage / kickoff / home / away / final / pens / aet / played…),
 * 所以 lib/cups.mjs 與前端不用動。SportMonks 2026-09-03 退訂,那一版留著當紀錄(sportmonks-cups.mjs)。
 *
 * 以下每一條都是 2026-09-07 探測實測的(probe-fotmob-cups.mjs,run 34143104759),不是文件或印象:
 *
 * 1. 端點 `leagues?id={132|133}&ccode3=GBR&season=YYYY/YYYY+1`,場次在 `fixtures.allMatches[]`。
 * 2. **只有正賽。** 足總盃從 Round 1 起(2025-26:123 場 = 40+20+32+16+8+4+2+1),聯賽盃從 Round 1 起
 *    (2 場 preliminary 不在)。第九級打起的資格賽**不在來源裡** —— 不是還沒抓,是沒有。畫面要講。
 * 3. 輪次:`round` 是字串("1".."5"、"1/4"、"1/2"、"final"),`roundName` 是數字(1..5)或字串
 *    ("Quarter-Finals" / "Semi-Finals" / "Final")。數字的這裡印成 "Round N";字串照抄,不自己取名。
 * 4. `status`:utcTime / started / finished / cancelled / awarded。未賽的沒有 awarded、scoreStr、reason。
 *    `scoreStr` 是**最終比分(含延長)**,PK 場是平手比分;`reason.short` 只見過 FT / AET / Pen。
 * 5. **PK 比數與誰贏了 PK 不在這個端點。** 第二輪探測看單場詳情(matchDetails);拿得到就掛進 `details`,
 *    拿不到的場次 `pens` / `pensWinner` 都是 null —— 畫面印「PK 大戰(勝方待查)」,不猜。
 * 6. 隊:`id`(字串)/ `name` / `shortName`。隊徽 `images.fotmob.com/image_resources/logo/teamlogo/{id}.png`
 *    實測三張都是 PNG(這裡只記網址,抓圖在 fetch-cup-crests.mjs)。
 * 7. 足總盃 2026-27 上游還沒發布:`allAvailableSeasons` 最新是 2025/2026,帶 `season=2026/2027`
 *    回的仍是 2025/2026 的資料 —— 所以**要驗 `details.selectedSeason` 真的等於要的那季**,
 *    不然會把上季存成本季,而且畫面完全正常(只是全是舊的)。
 *
 * 跟 SportMonks 那版一樣的規矩:隊名只做嚴格比對(AFC Liverpool ≠ Liverpool);沒見過的 reason 不給語意,
 * 原樣收進 unknownReasons 由呼叫端報出來。
 */

/* 盃賽的隊名比對:**只認完全相同的名字**(大小寫與空白正規化)。
 * 寬鬆比對(去掉 AFC/FC)在 20 隊的聯賽裡好用,在幾百隊的盃賽裡會把第九級的 AFC Liverpool
 * 對成 Liverpool —— 實際踩過。loose 會中、exact 不中的名字一律記進 nearMisses 由人核對。 */
const exactKey = name => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function buildCupTeamIndex(teams) {
  const index = new Map();
  for (const t of teams) {
    for (const n of [t.en, t.of, t.fpl, ...(t.alias ?? []), ...(t.cupAlias ?? [])]) {
      if (n) index.set(exactKey(n), t.code);
    }
  }
  return name => index.get(exactKey(name)) ?? null;
}

// reason.short 的白名單:實抓三季只見過這三個。沒見過的不給語意(aet / pens 都留 null),由 log 報出來。
export const KNOWN_REASONS = new Set(['FT', 'AET', 'Pen']);

export const FOTMOB_CUPS = [
  { key: 'facup', id: 132, zh: '足總盃', en: 'FA Cup', expect: /fa cup/i },
  { key: 'eflcup', id: 133, zh: '聯賽盃', en: 'EFL Cup', expect: /carabao|league cup|efl cup/i },
];

// 本站的賽季寫法 "2026-27" → FotMob 的 "2026/2027"(跟 fetch-fotmob-scores 同一個換算)
export const fotmobSeason = label => { const y = Number(String(label).slice(0, 4)); return `${y}/${y + 1}`; };
export const teamLogoUrl = id => `https://images.fotmob.com/image_resources/logo/teamlogo/${id}.png`;

/* 輪次名。數字 → "Round N"(這是格式,不是資料);字串照抄。兩個都沒有 → null,前端會歸到「未分輪」。 */
export function stageOf(m) {
  const rn = m?.roundName;
  if (typeof rn === 'number' && Number.isFinite(rn)) return `Round ${rn}`;
  if (typeof rn === 'string' && rn.trim()) return rn.trim();
  const r = m?.round;
  if (typeof r === 'string' && /^\d+$/.test(r)) return `Round ${r}`;
  return null;
}

const parseScore = s => {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s ?? '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
};

function teamOf(t, codeOf) {
  if (!t || (!t.name && !t.id)) return null;
  const name = t.name ?? null;
  return {
    name,
    shortName: t.shortName ?? null,
    // 本站只認得英超那些;認不得的**只給名字**,不編隊碼(鐵則三)。codeOf 必須是嚴格版。
    code: name ? codeOf(name) : null,
    sourceId: t.id != null ? String(t.id) : null,
    // 只是記「哪裡拿得到」,不等於掛隊徽(抓圖另一步,而且 artifact 的 CSP 擋外站)
    imageUrl: t.id != null ? teamLogoUrl(t.id) : null,
  };
}

/* 一場比賽。`details` 是單場詳情裡拿到的補充(PK 比數等),沒有就 null。 */
export function normaliseFotmobCupMatch(m, { codeOf, details = null }) {
  const st = m?.status ?? {};
  const reason = st.reason?.short ?? null;
  const finished = st.finished === true;
  const started = st.started === true;
  const cancelled = st.cancelled === true;
  const awarded = st.awarded === true;
  const final = finished ? parseScore(st.scoreStr) : null;
  const played = finished && final != null;
  const reasonKnown = reason == null ? null : KNOWN_REASONS.has(reason);
  const unknownReasons = reason != null && !reasonKnown ? [reason] : [];

  /* 延長賽與 PK 只認 reason:AET → 延長;Pen → PK(打沒打延長**不知道**:足總盃規則是延長後 PK、
     聯賽盃是直接 PK,但那是規則不是資料,這裡不推論,aet 給 null);FT → 沒延長。 */
  let aet = null;
  if (played && reasonKnown) {
    if (reason === 'AET') aet = true;
    else if (reason === 'Pen') aet = null;   // 打沒打延長要看詳情(足總盃延長後 PK、聯賽盃直接 PK 是規則,不是資料)
    else aet = false;
  }

  let state;
  if (cancelled) state = 'CANCELLED';
  else if (!started) state = 'NS';
  else if (!finished) state = 'LIVE';
  else if (awarded) state = 'AWARDED';
  else if (reason === 'Pen') state = 'FT_PEN';
  else if (reason === 'AET') state = 'AET';
  else if (reason === 'FT') state = 'FT';
  else state = reason ?? 'FINISHED';

  const base = {
    id: m?.id != null ? String(m.id) : null,
    stage: stageOf(m),
    roundKey: typeof m?.round === 'string' ? m.round : (m?.round != null ? String(m.round) : null),
    kickoff: st.utcTime ?? null,
    home: teamOf(m?.home, codeOf),
    away: teamOf(m?.away, codeOf),
    // 這個端點沒有半場、90 分、延長賽分段比分;不留假值,前端本來就會在沒有時不畫
    ht: null, ft90: null, et: null,
    final, pens: null, pensWinner: null,
    aet,
    // 進行中的比分(比賽日迴圈沒有打這個端點,所以多半看不到;有就照實給)
    liveScore: started && !finished ? parseScore(st.scoreStr) : null,
    state,
    stateKnown: reason == null ? (cancelled || !started || !finished || awarded) : reasonKnown,
    reason,
    awarded,
    played,
    pageUrl: typeof m?.pageUrl === 'string' ? m.pageUrl : null,
    unknownReasons,
  };
  // PK 場的比數、勝方、延長從單場詳情補(withCupDetails 只在 state 是 FT_PEN 時動手)
  return details ? withCupDetails(base, details) : base;
}

/* ── 跟 SportMonks 舊快取逐場核對(鐵則五:獨立來源;而且是現成的,不用再花請求)──
 *
 * 配對:同一個 UTC 日期(±1 天,時區邊界)+ 兩隊都對得上。隊名兩邊寫法不完全一樣
 * (Chelmsford ↔ Chelmsford City、FC Halifax Town ↔ Halifax Town),所以分兩層:
 *   a. 名字鍵完全相同(字尾 FC/AFC 去掉、字首 AFC 不動 —— 那是球隊身分,CLAUDE.md 那條坑)
 *   b. a 不中時,同日 ±1 的候選裡兩隊都是「同一支球隊的不同寫法」(只差 City/Town/FC/United 這種通用字)且唯一
 * 對不上的算「無法核對」(unverified),**不是**「不一致」—— 那兩個結論差很多。
 * 比的是最終比分 —— 這才是紅線(disagree)。「有沒有 PK」只記成 pensMismatch,不擋:
 * 第一次真抓就撞到 SportMonks 的 PK 列會缺 —— Newport County 2-2 Gillingham(足總盃 2025-26 R1)SM 記成
 * 延長後 2-2、沒有 PENALTY_SHOOTOUT 列,而 FotMob 賽程說 Pen、單場詳情有整輪 10 球的 PK(4-3)。
 * 那是舊快取缺資料,不是 FotMob 錯;拿它當紅線會把整季 123 場擋掉(實際發生過:run 34145087061)。
 * 也不比延長:SM 的 ET 分段在聯賽盃有 5 場疑似假的(規則上聯賽盃前幾輪不打延長)。 */
export const nameKey = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/\s+(fc|afc)$/, '').replace(/\s+/g, ' ');
const tokens = s => new Set(nameKey(s).split(' ').filter(Boolean));
/* 第二層配對的規則:一邊的 token 是另一邊的子集,而且多出來的**只能是通用字**(City / Town / FC / United)。
   第一版用「token 重疊 ≥ 0.6」—— AFC Liverpool {afc, liverpool} 對 Liverpool {liverpool} 是 0.67,
   會把第九級的 AFC Liverpool 對成英超的 Liverpool(測試抓到的;這正是盃賽最大的那個坑,連核對器都會犯)。
   AFC 不在通用字裡:字首的 AFC 是球隊身分。Gainsborough Trinity ↔ Gainsborough 這種對不上就算「無法核對」,
   少核對一場比對錯一場好。 */
const GENERIC = new Set(['fc', 'city', 'town', 'united']);
const sameClub = (a, b) => {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const x of small) if (!big.has(x)) return false;
  for (const x of big) if (!small.has(x) && !GENERIC.has(x)) return false;
  return true;
};
const dayOf = iso => String(iso ?? '').slice(0, 10);
const shiftDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function crossCheckWithSportmonks(fmMatches, smMatches) {
  const byDate = new Map();
  for (const m of smMatches ?? []) {
    const d = dayOf(m.kickoff);
    if (!d) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(m);
  }
  const out = { compared: 0, matched: 0, agree: 0, disagree: [], pensMismatch: [], unverified: 0, loose: 0 };
  for (const f of fmMatches ?? []) {
    const d = dayOf(f.kickoff);
    if (!d || !f.home?.name || !f.away?.name) continue;
    out.compared++;
    const pool = [d, shiftDay(d, -1), shiftDay(d, 1)].flatMap(x => byDate.get(x) ?? []);
    const hk = nameKey(f.home.name), ak = nameKey(f.away.name);
    let hit = pool.find(m => nameKey(m.home?.name) === hk && nameKey(m.away?.name) === ak) ?? null;
    if (!hit) {
      // 第二層:兩隊都是「同一支球隊的不同寫法」(sameClub),而且候選只能有一個
      const cands = pool.filter(m => sameClub(f.home.name, m.home?.name) && sameClub(f.away.name, m.away?.name));
      if (cands.length === 1) { hit = cands[0]; out.loose++; }
    }
    if (!hit) { out.unverified++; continue; }
    out.matched++;
    if (!(f.played && hit.played)) continue;   // 一邊還沒踢完就沒有東西可比
    const sameScore = f.final && hit.final && f.final[0] === hit.final[0] && f.final[1] === hit.final[1];
    const smPens = Array.isArray(hit.pens);
    const fmPens = f.reason === 'Pen';
    const row = {
      id: f.id, date: d, home: f.home.name, away: f.away.name,
      fotmob: `${f.final?.join('-') ?? '?'}${fmPens ? ' pens' : ''}`,
      sportmonks: `${hit.final?.join('-') ?? '?'}${smPens ? ` pens ${hit.pens.join('-')}` : ''}`,
    };
    if (!sameScore) { out.disagree.push(row); continue; }
    if (smPens !== fmPens) out.pensMismatch.push(row);   // 記下來給人看,不擋(見上面 Newport 那場)
    out.agree++;
  }
  return out;
}

/* ── 單場詳情(matchDetails)裡的 PK 與延長 ──
 * 2026-09-07 第二輪探測(run 34144192458)拿三場真實比賽驗過的位置:
 *   header.status.reason.penalties        [主, 客] PK 比數(QPR 1-1 Millwall → [0,2],跟 SportMonks 的 0-2 一致)
 *   header.status.whoLostOnPenalties      輸家的**隊名**(字串);沒踢 PK 是 null
 *   header.status.halfs.firstExtraHalfStarted  有打延長就是時間字串,沒打是 ""(聯賽盃第一輪直接 PK 就是 "")
 *   header.teams[0|1]                     主、客;有 id(數字)與 score(最終比分)
 * 事件流裡也有 type "PenaltyShootout" 帶 penaltyScore,但它的 homeScore/awayScore 是連 PK 一起加的(6-5),不要用。
 * 回傳的東西呼叫端要先核對:隊 id 與最終比分得跟賽程端點一樣,不一樣就是抓錯場,不掛。 */
export function parseCupDetail(d) {
  const st = d?.header?.status;
  const teams = Array.isArray(d?.header?.teams) ? d.header.teams : [];
  if (!st || teams.length !== 2) return null;
  const p = st.reason?.penalties;
  const pens = Array.isArray(p) && p.length === 2 && p.every(x => Number.isFinite(Number(x))) ? p.map(Number) : null;
  const lost = typeof st.whoLostOnPenalties === 'string' && st.whoLostOnPenalties.trim() ? st.whoLostOnPenalties.trim() : null;
  let byScore = null;
  if (pens && pens[0] !== pens[1]) byScore = pens[0] > pens[1] ? 'home' : 'away';
  let byLoser = null;
  if (lost) {
    if (lost === teams[0]?.name) byLoser = 'away';
    else if (lost === teams[1]?.name) byLoser = 'home';
  }
  // 兩個訊號都有就要一致;不一致不挑一個當答案(比分分段那條坑的同一個道理)
  const conflict = byScore != null && byLoser != null && byScore !== byLoser;
  const halfs = st.halfs;
  const extraTime = halfs && typeof halfs === 'object' && 'firstExtraHalfStarted' in halfs
    ? String(halfs.firstExtraHalfStarted ?? '').trim() !== ''
    : null;
  const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const score = num(teams[0].score) != null && num(teams[1].score) != null ? [num(teams[0].score), num(teams[1].score)] : null;
  return {
    pens, pensWinner: conflict ? null : (byScore ?? byLoser), conflict, extraTime, score,
    homeId: teams[0].id != null ? String(teams[0].id) : null,
    awayId: teams[1].id != null ? String(teams[1].id) : null,
    reason: st.reason?.short ?? null,
  };
}

/* 把詳情掛到已正規化的場次上。只掛 PK 場(state FT_PEN):比數、勝方、有沒有延長。
   賽程端點重抓時場次會重新正規化,所以這個要能重複套用(純函式,回新物件)。 */
export function withCupDetails(match, details) {
  if (!match || !details || match.state !== 'FT_PEN') return match;
  const pens = Array.isArray(details.pens) && details.pens.length === 2 ? details.pens : null;
  let pensWinner = null;
  if (pens && pens[0] !== pens[1]) pensWinner = pens[0] > pens[1] ? 'home' : 'away';
  else if (details.pensWinner === 'home' || details.pensWinner === 'away') pensWinner = details.pensWinner;
  const aet = typeof details.extraTime === 'boolean' ? details.extraTime : match.aet;
  return { ...match, pens, pensWinner, aet };
}
