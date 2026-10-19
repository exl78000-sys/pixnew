/* 用 FPL 官方 API 補本季賽果與開球時間(2026-10-19,使用者回報「比賽頁 接下來比賽日期錯誤」)。

   **坑**:過去輪次的比分原本只靠 openfootball,FPL 即時那一份(`live.json`)**只涵蓋當前這一輪**,
   而且補進去的比分不存檔。openfootball 落後超過一輪時,中間那一輪就永遠補不到:
   2026-27 第 6 輪 10/10~12 踢完、FPL 10/13 換到第 7 輪,openfootball 停在第 5 輪(上游自己也沒更新)——
   於是 10/19 首頁「接下來的比賽」最前面還掛著 9 天前的六場,倒數寫「已開賽・等待資料」,
   積分榜少一整輪,模型也少吃 10 場。

   現在 `live.json` 多帶一份 `seasonFixtures`(FPL `/api/fixtures/` 整季,每次 `npm run live` 重抓),
   這裡從**兩份**補:當前輪的 `fixtures` 與整季的 `seasonFixtures`。規矩跟原本一樣 ——
   只補 openfootball 還沒有的(`played` 為 false),不覆寫上游已經有的比分。純函式,方便測。 */

/* 整季 + 當前輪,同一個 key 以當前輪那一份為準(它是比賽日每兩分鐘重抓的,比整季那一份新)。 */
export function liveFixturesOf(liveState) {
  if (!liveState || liveState.demo) return [];
  const byKey = new Map();
  for (const f of liveState.seasonFixtures ?? []) if (f?.key) byKey.set(f.key, f);
  for (const f of liveState.fixtures ?? []) if (f?.key) byKey.set(f.key, f);
  return [...byKey.values()];
}

/* 已完賽、有比分、而本季資料還沒有的 → 補上。回傳補了哪幾場(印出來 —— 補資料是外部事件,不要靜靜改)。 */
export function fillFromLive(curMatches, liveState) {
  const byKey = new Map(curMatches.map(m => [`${m.home}|${m.away}`, m]));
  const filled = [];
  for (const f of liveFixturesOf(liveState)) {
    if (!f.finished || f.hs == null || f.as == null) continue;
    const m = byKey.get(f.key);
    if (!m || m.played) continue;
    Object.assign(m, { played: true, fh: f.hs, fa: f.as, fromLive: true });
    filled.push({ key: f.key, round: m.round, score: `${f.hs}-${f.as}` });
  }
  return filled;
}

/* 開球時間:誰最新就信誰 —— 整季那一份涵蓋所有輪次,所以改期不必等那一輪變成當前輪才修得到。 */
export function liveKickoffs(liveState) {
  const out = new Map();
  for (const f of liveFixturesOf(liveState)) if (f.kickoff) out.set(f.key, f.kickoff);
  return out;
}
