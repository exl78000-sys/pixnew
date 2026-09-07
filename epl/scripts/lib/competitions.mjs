/* 賽事 logo → web/data/competitions.json。
 *
 * 跨聯賽一份,放英超目錄下(總覽、盃賽、探索頁都從 'pl' 載,跟 cups.json 同一個做法)。
 * 來源是 data/manual/competition-logos.json(scripts/fetch-competition-logos.mjs 在 runner 上抓;
 * 沙箱連不到 CDN)。**還沒抓到也要產檔** —— logos 給空的,前端退回色塊;
 * 檔案不在的話頁面會 404,那看起來像壞掉。 */
export async function loadCompetitionLogos(root, { readFile, existsSync, join }) {
  const p = join(root, 'data', 'manual', 'competition-logos.json');
  if (!existsSync(p)) {
    return { source: null, retrievedAt: null, logos: {},
      note: '尚未抓取賽事 logo(runner 跑 npm run competition-logos 之後才有);前端先用色塊。' };
  }
  const raw = JSON.parse(await readFile(p, 'utf8'));
  const logos = {};
  for (const [key, v] of Object.entries(raw.logos ?? {})) {
    // 只收真的是 PNG data URI 的;半套的(有名字沒圖)不給,前端會退回色塊
    if (typeof v?.dataUri === 'string' && v.dataUri.startsWith('data:image/png;base64,')) logos[key] = v.dataUri;
  }
  return {
    source: raw.source ?? null,
    retrievedAt: raw.retrievedAt ?? null,
    width: raw.width ?? null,
    logos,
    names: Object.fromEntries(Object.entries(raw.logos ?? {}).map(([k, v]) => [k, v?.name ?? null])),
    sources: Object.fromEntries(Object.entries(raw.logos ?? {}).map(([k, v]) => [k, v?.source ?? null])),
    failed: raw.failed ?? {},
    note: Object.keys(logos).length
      ? '賽事 logo 來自 football-data.org 的 competition emblem(足總盃、聯賽盃走 FotMob);每一筆的名字都核對過才存。'
      : '尚未抓到任何賽事 logo;前端先用色塊。',
  };
}
