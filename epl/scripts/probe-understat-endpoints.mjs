#!/usr/bin/env node
/* Understat 的兩個端點從 2026-11-02 起每次部署都失敗(2026-11-05 查到):
 *   - `POST /main/getPlayersStats/`(西甲德義法的整季球員):11-02、11-03 是 fetch failed,11-04 起 HTTP 405
 *   - `GET /getTeamData/{隊}/{年}`(英超西甲逐場球隊 xG、情境統計):回一整頁 HTML(`<!DOCTYPE`)而不是 JSON
 * 最後一次成功是 11-01 18:55 那一次部署。沙箱連不到 understat.com,所以只能在 runner 上問。
 *
 * 這支只問四件事、四個請求、唯讀:
 *   ① getTeamData 回什麼(狀態、content-type、開頭 200 字、有沒有跳轉)
 *   ② getPlayersStats 的 POST 回什麼(狀態、Allow 標頭 —— 405 會說它現在收哪些方法)
 *   ③④ 聯賽頁與球隊頁的 HTML 裡**提到哪些像 API 的路徑**(`/getXxx/`、`/main/xxx`、fetch/ajax 呼叫)——
 *       端點如果換了名字,前端的 JS 會用新名字去打,頁面或它載的腳本裡找得到。
 * 不印任何球員或比賽資料,只印結構。
 *
 *   npm run probe:understat-endpoints */
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';
const head = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

async function ask(label, url, init = {}) {
  console.log(`\n▶ ${label}\n  ${init.method ?? 'GET'} ${url}`);
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(25000), ...init });
    const txt = await res.text();
    console.log(`  HTTP ${res.status}・content-type ${res.headers.get('content-type')}・${txt.length} 字`
      + (res.headers.get('location') ? `・location ${res.headers.get('location')}` : '')
      + (res.headers.get('allow') ? `・allow ${res.headers.get('allow')}` : '')
      + (res.headers.get('server') ? `・server ${res.headers.get('server')}` : '')
      + (res.headers.get('cf-ray') ? '・(Cloudflare)' : ''));
    console.log(`  開頭:${head(txt)}`);
    let isJson = false;
    try { JSON.parse(txt); isJson = true; } catch { /* 不是 JSON */ }
    console.log(`  是 JSON:${isJson ? '是' : '否'}`);
    return txt;
  } catch (e) {
    console.log(`  ✗ ${e.message}${e.cause ? `(${e.cause.code ?? e.cause.message})` : ''}`);
    return null;
  }
}

/* HTML 裡像 API 的路徑:不猜名字,把看得到的都列出來(最多 30 個,去重) */
function apiPaths(html) {
  if (!html) return [];
  const found = new Set();
  for (const re of [/["'`](\/(?:get[A-Z]\w*|main\/\w+|api\/[\w/-]+)[^"'`\s]*)["'`]/g, /\b(get[A-Z]\w+Data)\b/g,
    /<script[^>]+src=["']([^"']+)["']/g, /\bvar\s+(\w+Data)\s*=/g]) {
    for (const m of html.matchAll(re)) { found.add(m[1]); if (found.size >= 30) break; }
  }
  return [...found];
}

await ask('① 球隊逐場資料(英超 2026-27 Arsenal)', 'https://understat.com/getTeamData/Arsenal/2026', {
  headers: { accept: 'application/json, text/javascript, */*; q=0.01', referer: 'https://understat.com/team/Arsenal/2026',
    'user-agent': UA, 'x-requested-with': 'XMLHttpRequest' },
});
await ask('② 整季球員(西甲 2026-27,POST)', 'https://understat.com/main/getPlayersStats/', {
  method: 'POST', body: 'league=La_liga&season=2026',
  headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    referer: 'https://understat.com/league/La_liga/2026', 'user-agent': UA, 'x-requested-with': 'XMLHttpRequest' },
});
const league = await ask('③ 聯賽頁 HTML(西甲 2026-27)', 'https://understat.com/league/La_liga/2026', { headers: { 'user-agent': UA } });
console.log(`  像 API 的路徑:${apiPaths(league).join('、') || '(沒有)'}`);
const team = await ask('④ 球隊頁 HTML(Arsenal 2026-27)', 'https://understat.com/team/Arsenal/2026', { headers: { 'user-agent': UA } });
console.log(`  像 API 的路徑:${apiPaths(team).join('、') || '(沒有)'}`);
console.log('\n共 4 個請求。');
