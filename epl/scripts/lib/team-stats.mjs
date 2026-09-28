/* 球隊頁的逐場統計彙總 team-stats.json(2026-09-28,A8)。

   為什麼:FotMob 逐場統計的逐隊彙總(控球分布、每場射門與 xG、射門情境)原本掛在 teams.json 每一隊的 matchStats,
   英超 385 KB 裡它佔 213 KB。而 teams.json 首頁、實時頁、戰術、教練、盃賽、我的預測…十幾頁都在載,
   讀 matchStats 的只有球隊頁的**詳情**(帶 ?code=)那一塊。所以拆出來:{ 隊碼: 彙總 },球隊頁詳情才 loadFrom。

   規則照舊:沒有資料(games 為 0 或沒有)的隊**不留鍵**,前端整塊不畫(鐵則三)。
   四份 build 共用這一支;teams.json 從此不帶 matchStats,測試守著。 */
export function teamStatsFrom(fotmobTeams, teams) {
  const out = {};
  for (const t of teams ?? []) {
    const ms = fotmobTeams?.[t.code];
    if (ms?.games) out[t.code] = ms;
  }
  return out;
}
