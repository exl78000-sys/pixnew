/* FotMob 即時分鐘字串 → 本站的比賽分鐘(西甲、英冠的即時快照共用;兩支 build 原本各寫一份 `minuteOf`)。
 *
 * 字串長什麼樣是**從倉庫的 git 歷史裡量出來的**(比賽夜回寫的 `data/raw/fotmob-* /scores.json`,
 * 2026-09-25 撈到 97 筆,六個聯賽):
 *   - 一般分鐘是 `"63\u200E\u2019\u200E"` —— 數字 + 右單引號(U+2019),前後夾左至右標記(U+200E)。
 *   - **補時是連續數的,上下半場都是**:下半場補時 `93’` `96’`;上半場補時 `49’`
 *     (Marseille–PSG:開球後 45.1 分鐘 `45’`、48.4 分鐘 `49’`、51.7 分鐘 `HT`)。
 *   - 中場休息是 `"HT"`,沒有數字。
 * 原本的寫法是「取開頭的數字,沒有就 0」—— 於是:
 *   - **中場 = 第 0 分**:實時頁與分析頁整個中場印「第 0 分鐘」,還從 0 往上走(liveMinute 從抓取時刻往前推);
 *   - 上半場補時的 `46’`~`49’` 被當成下半場第 46~49 分(時間曲線的剩餘份額少算 7~13%)。
 *
 * `47’` 是上半場補時還是下半場第 47 分,字串本身分不出來 —— 用**開球後過了多久**分:
 * 下半場的第 n 分最早也要在開球後 n + 16 分鐘才出現(中場至少 15 分鐘 + 上半場補時至少 1 分鐘),
 * 上半場補時的第 n 分出現在開球後約 n 分鐘(晚開球幾分鐘就晚幾分鐘)。所以門檻放在 n + 8:
 * 開球延後 7 分鐘以內都判得對,再晚的話退回「當成下半場」—— 也就是原本的行為,不會更糟。
 * 實測:上半場 `49’` 在 48.4 分鐘、下半場 `47’` `48’` `50’` `51’` 在 66.3 ~ 71.5 分鐘。
 *
 * 上半場補時與中場一律當第 45 分(英超那條路的 FPL 分鐘在中場停在 45,prob-history.mjs 記過;上半場補時沒量過),
 * 時間曲線用 S(45) —— 它含上半場補時的進球(佔全場 3.6%),所以中場時剩下的進球會多算約 6%,偏保守。
 *
 * 回傳 { minute, period }:period 只有 `'HT'`(中場)一種,其餘 null。 */
const HT_SLACK = 8;       // 分鐘:見上面「n + 8」那一段
const FIRST_HALF_END = 45;
const FIRST_HALF_MAX = 60; // 上半場補時不會超過 15 分鐘:61’ 以上一定是下半場,抓取時間歪掉也不會被搬回 45

export function fotmobMinute(liveTime, { kickoff = null, fetchedAt = null, finished = false } = {}) {
  if (finished) return { minute: 90, period: null };
  const s = String(liveTime ?? '').replace(/[\u200E\u200F]/g, '').trim();
  if (/^HT$/i.test(s)) return { minute: FIRST_HALF_END, period: 'HT' };
  const m = /^(\d+)/.exec(s);
  if (!m) return { minute: 0, period: null };
  const n = Number(m[1]);
  if (n > FIRST_HALF_END && n <= FIRST_HALF_MAX) {
    const el = (Date.parse(fetchedAt ?? '') - Date.parse(kickoff ?? '')) / 60000;
    if (Number.isFinite(el) && el < n + HT_SLACK) return { minute: FIRST_HALF_END, period: null };
  }
  return { minute: n, period: null };
}
