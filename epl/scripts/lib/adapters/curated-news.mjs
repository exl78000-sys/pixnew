/* Adapter:人工整理的外電摘要 → 本站動態流的項目。
 *
 * 這一份跟既有的兩種新聞都不一樣,所以要能分得出來(鐵則四):
 *
 *   站內生成   賽前看點、數據、戰術 —— 從本站資料算出來的
 *   RSS 外電   標題與短摘要照抄,有譯文的話標「機器翻譯」
 *   **人工整理** ← 這一份。中文摘要是人寫的,不是機器翻譯,也不是原文照抄
 *
 * 三件要守的事:
 *
 * 1. **摘要裡的比分要拿本站賽果核對,每次 build 都核對。**
 *    交付方自己在檔案裡寫 `verified: true` —— 那是他自己說的,不算數(鐵則五)。
 *    對不上的那一則整則不出,並在 log 報出來;核對得到的才標「比分已核對」。
 *    只核對一次是不夠的:賽果會更新,而這份檔案是靜態的,
 *    兩邊哪天開始不一致,要在下一次 build 就被抓到。
 *
 * 2. **傳聞與已確認交易一定要分開。**
 *    來源檔自己帶 status(reported-saga / mixed-official-and-reported / …),
 *    那個區別必須一路傳到畫面上。把傳聞印成事實就是編數字。
 *
 * 3. **核對不到的不要假裝核對過。**
 *    歐冠附加賽的比分本站沒有那一輪的資料,所以那幾則標「無法核對」,
 *    不是標「已核對」也不是整則丟掉 —— 讀者看得到來源連結,自己能判斷。
 */

// 來源檔的 type → 本站動態流的分類。刻意不併進既有的「轉會」——
// 既有那一類是 FPL 官方欄位算出來的,兩種來源混在同一個標籤下會分不出出處。
const CAT = {
  'match-review': '賽報',
  news: '外電',
  'transfer-news': '轉會外電',
};

/* status → 給讀者看的一句話。**沒見過的 status 不給語意**,
   原樣留著並由呼叫端報出來(比照進球子代碼與比分類別的做法)。 */
export const KNOWN_STATUS = {
  'official-overview': { label: '官方整理', tone: 'ok' },
  'completed-transfer-follow-up': { label: '已完成的交易', tone: 'ok' },
  'reported-saga': { label: '媒體報導,非已完成', tone: 'warn' },
  'reported-targets': { label: '媒體報導的目標,非已完成', tone: 'warn' },
  'mixed-official-and-reported': { label: '官方與傳聞混合,逐條看狀態', tone: 'warn' },
  'club-market-analysis': { label: '球會動向分析', tone: '' },
};

/* 一則摘要裡的比分,拿本站賽果逐場核對。
   回傳 { state, detail }:
     verified    每一場都對得上
     unverified  本站沒有這個賽事/這一輪的資料 → 無法核對(不是錯)
     conflict    對不上 → 這一則不可以出
     none        這一則沒有引用比分 */
export function checkScores(story, { fixturesOf, codeOf }) {
  const games = story.matches ?? [];
  if (!games.length) return { state: 'none', detail: [] };
  const list = fixturesOf(story.competition);
  if (!list) return { state: 'unverified', detail: [`本站沒有${story.competitionName}的賽果可以核對`] };

  /* **同一組對戰在不同賽季會重複出現。**
     第一版直接 find(home===hc && away===ac),於是拿到的是**上一季**那一場 ——
     西甲三則賽報因此全部被判成「比分不符」而退回:
     ESP vs RMA 摘要 1-2、抓到上季的 0-2;BAR vs ATH 摘要 2-0、抓到上季的 4-0。
     看起來像交付的資料錯了,其實是我配到別季的比賽。
     用新聞日期收斂:比賽日要落在報導日前後幾天內。
     收斂不到就是「無法核對」,不是「不一致」—— 那兩件事的結論差很多。 */
  const DAY = 86400000, WINDOW_DAYS = 5;
  const dayOf = x => String(x.date ?? x.kickoff ?? '').slice(0, 10);
  const pick = (hc, ac, when) => {
    const all = list.filter(x => x.home === hc && x.away === ac);
    if (!all.length) return null;
    const t = Date.parse(when);
    if (!Number.isFinite(t)) return all.length === 1 ? all[0] : null;
    const near = all
      .map(x => ({ x, d: Math.abs(Date.parse(dayOf(x)) - t) }))
      .filter(v => Number.isFinite(v.d) && v.d <= WINDOW_DAYS * DAY)
      .sort((p, q) => p.d - q.d);
    return near[0]?.x ?? null;
  };

  const detail = [];
  let conflict = false, checked = 0;
  for (const g of games) {
    const hc = codeOf(g.home), ac = codeOf(g.away);
    if (!hc || !ac) { detail.push(`隊名對不上:${g.home} / ${g.away}`); continue; }
    const m = pick(hc, ac, story.date);
    if (!m) { detail.push(`賽程裡沒有 ${hc} vs ${ac}(報導日期 ${story.date} 前後 ${WINDOW_DAYS} 天內)`); continue; }
    if (!m.played) { detail.push(`${hc} vs ${ac} 本站還沒有賽果`); continue; }
    // 「1-2 aet」這種寫法要把 aet 去掉再比 —— 延長賽後的比分本身還是那兩個數字
    const said = String(g.score ?? '').replace(/\s*aet\s*$/i, '').trim();
    const mine = `${m.fh}-${m.fa}`;
    checked++;
    if (said !== mine) { conflict = true; detail.push(`${hc} vs ${ac}:摘要寫 ${said},本站賽果 ${mine}`); }
  }
  if (conflict) return { state: 'conflict', detail };
  if (checked === games.length) return { state: 'verified', detail: [] };
  return { state: 'unverified', detail };
}

/* 轉成動態流的項目。
   中文寫在 title / body(它本來就是中文),**不用 titleZh / bodyZh** ——
   那兩個欄位在前端會掛上「機器翻譯」標記,而這份不是機器翻譯,
   標錯等於講一件假的事。 */
export function toFeedItems(stories, ctx) {
  const items = [];
  const rejected = [];
  const unknownStatus = new Set();
  for (const s of stories) {
    const check = checkScores(s, ctx);
    if (check.state === 'conflict') {
      rejected.push({ id: s.id, reason: '比分與本站賽果不一致', detail: check.detail });
      continue;
    }
    if (s.status && !KNOWN_STATUS[s.status]) unknownStatus.add(s.status);
    items.push({
      id: `curated-${s.id}`,
      cat: CAT[s.type] ?? '外電',
      date: s.date,
      title: s.title,
      body: s.body,
      source: s.source,
      link: s.link,
      // 這三個欄位是這一類專屬的,前端靠它們把出處講清楚
      curated: true,
      competition: s.competition,
      competitionName: s.competitionName,
      scoreCheck: check.state,
      scoreCheckDetail: check.detail,
      status: s.status ?? null,
      statusLabel: s.status ? (KNOWN_STATUS[s.status]?.label ?? null) : null,
      statusTone: s.status ? (KNOWN_STATUS[s.status]?.tone ?? '') : null,
    });
  }
  return { items, rejected, unknownStatus: [...unknownStatus] };
}

/* 哪些項目要出現在這個聯賽的動態流。
   歐冠是跨聯賽的賽事,兩邊都放 —— 英超與西甲的球隊都在裡面。 */
export const forLeague = (items, league) =>
  items.filter(i => i.competition === league || i.competition === 'ucl');
