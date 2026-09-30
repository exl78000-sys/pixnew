/* 比分機率格 fixture-grids.json(2026-09-30,A9)。

   為什麼:fixtures.json 每場帶一張 6×6 的比分機率格(prediction.grid,踢完的另有 postFit.grid),
   英超 429 KB 裡約 110 KB 是它 —— 而讀它的只有單場頁的比分熱圖。fixtures.json 首頁、球隊頁、實時頁、我的預測都在載,
   所以拆出來:{ 場次 id: { prediction?, postFit? } },只有單場頁載,載完掛回原位(形狀跟以前一樣)。

   **只搬 grid,其餘一個欄位都不動**(勝負機率、最可能比分、大小球…首頁的賽程表都在讀)。
   grid 是 poisson.mjs 輸出的原值,這裡不重算、不改位數(校準層不動)。四份 build 共用這一支;測試守著 fixtures.json 裡沒有 grid。 */
export function splitFixtureGrids(fixtures) {
  const grids = {};
  const slim = (fixtures ?? []).map(f => {
    const pg = f?.prediction?.grid, qg = f?.postFit?.grid;
    if (!pg && !qg) return f;
    if (f.id == null) throw new Error(`splitFixtureGrids:${f.home}-${f.away} 沒有 id,拆出去就對不回來`);
    if (grids[f.id]) throw new Error(`splitFixtureGrids:場次 id 重複 ${f.id}`);
    const out = { ...f };
    const g = {};
    if (pg) { const { grid, ...rest } = f.prediction; out.prediction = rest; g.prediction = pg; }
    if (qg) { const { grid, ...rest } = f.postFit; out.postFit = rest; g.postFit = qg; }
    grids[f.id] = g;
    return out;
  });
  return { fixtures: slim, grids };
}

/* 反過來:把 grid 掛回 fixtures(就地)。單場頁與 Node 端要讀 grid 的都走這一支,不要自己拼。 */
export function attachFixtureGrids(fixtures, grids) {
  for (const f of fixtures ?? []) {
    const g = grids?.[f.id];
    if (!g) continue;
    if (g.prediction && f.prediction) f.prediction.grid = g.prediction;
    if (g.postFit && f.postFit) f.postFit.grid = g.postFit;
  }
  return fixtures;
}
