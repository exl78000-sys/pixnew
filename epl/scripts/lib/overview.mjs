/* 總覽頁的摘要產物 overview.json(2026-09-26,A4)。

   為什麼:總覽要畫六個聯賽的卡片與「即將到來」那張表,以前每個聯賽各載 teams + fixtures + news + live
   四份完整產物 —— 正式站量到解壓後 5.4 MB、6 秒還是一行「載入資料中…」,而這一頁用到的欄位不到 5%:
   賽程只要 id / 輪次 / 日期 / 開球 / 主客 / 已賽(預測、盤口、隊色、難度全用不到),名冊只要隊碼 / 隊名 / 隊徽,
   動態只要前 4 則,即時快照只要比分與分鐘(advanced / sides 每場 64 KB 一個都不要)。
   build 在寫完那幾份之後,從**寫出去的那一份**(不是別的變數)抽這一份,所以跟各自的產物永遠一致。

   欄位清單就是 page-overview.js 讀的那些;要在總覽多畫一個欄位,先來這裡加,不要回頭去載整份。 */

const slimLive = live => (live ? {
  available: !!live.available, demo: !!live.demo, fetchedAt: live.fetchedAt ?? null,
  /* 分鐘的推算(core.js 的 liveMinute)吃 period / clock / minute / kickoff;比分吃 hs / as;
     started / finished 決定畫倒數還是比分。 */
  matches: (live.matches ?? []).map(m => ({
    home: m.home, away: m.away, started: !!m.started, finished: !!m.finished,
    hs: m.hs ?? null, as: m.as ?? null, minute: m.minute ?? null, clock: m.clock ?? null,
    period: m.period ?? null, kickoff: m.kickoff ?? null,
  })),
} : null);

export function overviewFrom({ meta, teams, fixtures, news, live }) {
  if (!meta || !Array.isArray(teams) || !Array.isArray(fixtures)) {
    throw new Error('overviewFrom:meta / teams / fixtures 要先寫出去才抽得出總覽摘要');
  }
  return {
    meta,
    teams: teams.map(t => ({ code: t.code, en: t.en, zh: t.zh ?? null, of: t.of ?? null, crest: t.crest ?? null })),
    fixtures: fixtures.map(f => ({
      id: f.id, round: f.round, date: f.date, kickoff: f.kickoff ?? null,
      home: f.home, away: f.away, played: !!f.played,
    })),
    // 總覽每個聯賽只列前 4 則(page-overview 的 slice(0, 4)),多給只是多下載
    news: (Array.isArray(news) ? news : []).slice(0, 4).map(n => ({
      title: n.title, date: n.date ?? null, link: n.link ?? null, cat: n.cat ?? null,
    })),
    live: slimLive(live),
  };
}
