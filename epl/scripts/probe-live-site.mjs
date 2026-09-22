#!/usr/bin/env node
/* 「部署完開站上確認一次」——而**沙箱開不了站台**:出口代理對
 * `exl78000-sys.github.io:443` 的 CONNECT 回 **403**(policy denial,不是暫時性失敗,
 * `$HTTPS_PROXY/__agentproxy/status` 的 recentRelayFailures 裡看得到)。
 * 所以這一支在 runner 上跑,去抓 **GitHub Pages 實際供出來的那幾個檔**,把事實印出來。
 *
 * 為什麼不是「相信本機重建的產物就好」:本站踩過
 * 「產物比 raw 舊一輪」與「回寫清單沒有 web/data,倉庫那份會停在舊版」——
 * **倉庫裡長什麼樣跟站上供什麼是兩件事**,要確認就得去問站台自己。
 *
 * 印三種東西:
 *   一、**這是哪一次建置**(meta.json 的 builtAt 與資產戳)—— 不先確認這個,
 *       底下的數字可能是上一次部署的,而看起來完全正常。
 *   二、**事實**:歐冠外部球隊有幾支帶隊徽、還缺哪幾支,以及本季積分榜那 36 列
 *       **實際上有幾列畫得出隊徽**(逐列照前端的規則算:有隊碼走名冊、沒有就查 external)。
 *   三、**sha256**:讓「本機開瀏覽器看過的那份」與「站上這一份」能逐位元組比對 ——
 *       兩邊雜湊一樣的話,本機那次渲染就是站上這一份的渲染,不必在 runner 上再裝一次瀏覽器。
 *
 * 唯讀、零快取、**7 個請求**(meta / cups.html / ucl.html / page-cups.js / ucl-view.js / ucl-teams.json / ucl.json)。
 * 網址不寫死:從 runner 的 `GITHUB_REPOSITORY` 推(owner/repo → owner.github.io/repo/),
 * 本機測試用 `--base=` 覆寫。
 *
 *   npm run probe:live
 *   npm run probe:live -- --base=http://localhost:5173/
 */
import { createHash } from 'node:crypto';

const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const repo = process.env.GITHUB_REPOSITORY ?? '';
const [owner, name] = repo.split('/');
const BASE = (arg('base') ?? (owner && name ? `https://${owner}.github.io/${name}/` : '')).replace(/\/?$/, '/');
if (!BASE) { console.log('✗ 推不出站台網址(沒有 GITHUB_REPOSITORY,也沒給 --base=)'); process.exit(0); }

const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 16);
let requests = 0;
async function get(path) {
  requests++;
  const url = new URL(path, BASE).href;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { url, status: res.status, ok: res.ok, buf, text: buf.toString('utf8') };
}
const jsonOf = r => { try { return JSON.parse(r.text); } catch { return null; } };

async function main() {
  console.log(`▶ 站台:${BASE}`);

  // ── 一、這是哪一次建置 ────────────────────────────────
  const meta = await get('data/meta.json');
  console.log(`  meta.json  HTTP ${meta.status}  ${meta.buf.length} bytes`);
  const m = jsonOf(meta);
  if (!m) { console.log('  ✗ meta.json 不是 JSON —— 站台可能還沒部署過,後面的都不用看了'); return; }
  console.log(`  建置時間 ${m.builtAt ?? m.generatedAt ?? '(沒有這個欄位)'}・本季 ${m.currentSeason ?? '?'}`);
  console.log(`  資產戳 ${JSON.stringify(m.assets ?? null)}`);

  // ── 二、歐冠那一頁實際供出來的 JS ──────────────────────
  /* `ucl.html` 2026-08-29 起**只是轉址頁**(歐冠併進盃賽單頁,渲染在 ucl-view.js),
     所以要追到真正載 ucl-view 的那一頁。第一版直接讀 ucl.html 的 page-ucl.js,
     拿到一個 275 bytes 的轉址殼 → 解不出路徑 → 抓到 404 → 字面值 0 處 → **印出 ✓**。
     那是本站記過的「0 是一個看起來很像答案的數字」:所以底下每一步解不出來就印 ✗,
     而且字面值 0 處**一律當成失敗**(那個檔不可能一處都沒有)。 */
  const hub = await get('cups.html');
  console.log(`  cups.html(歐冠實際渲染的那一頁)  HTTP ${hub.status}  ${hub.buf.length} bytes`);
  const redirect = await get('ucl.html');
  console.log(`  ucl.html(轉址頁)  HTTP ${redirect.status}  ${redirect.buf.length} bytes`);

  let viewPath = null;
  const pageSrc = /["']((?:\.\/)?assets\/js\/page-cups\.js(?:\?v=[0-9a-f]{8})?)["']/.exec(hub.text)?.[1];
  if (!pageSrc) {
    console.log('  ✗ cups.html 裡找不到 page-cups.js 的引用(載入方式改過?)—— 下面那一條不算數');
  } else {
    const page = await get(pageSrc.replace(/^\.\//, ''));
    console.log(`  ${pageSrc}  HTTP ${page.status}  ${page.buf.length} bytes`);
    const rel = /from '\.\/(ucl-view\.js(?:\?v=[0-9a-f]{8})?)'/.exec(page.text)?.[1];
    if (!rel) console.log('  ✗ page-cups.js 裡找不到 ucl-view.js 的 import');
    else viewPath = 'assets/js/' + rel;
  }

  if (viewPath) {
    const view = await get(viewPath);
    console.log(`  ${viewPath}  HTTP ${view.status}  ${view.buf.length} bytes  sha256:${sha(view.buf)}`);
    if (!view.ok) {
      console.log('  ✗ 站上抓不到這個檔 —— 底下的字面值檢查不算數');
    } else {
      /* 「隊徽有了不等於畫得出來」:沒有隊碼的球隊是拿 t.id 去查 externalCrest 的,
         所以積分榜那一欄的字面值必須帶 id。這一條是 2026-09-22 修的,去站上確認它真的上線了。 */
      const lits = [...view.text.matchAll(/uclTeamCell\(\{([^}]*)\}/g)].map(x => x[1]);
      const withCode = lits.filter(x => /\bcode\s*:/.test(x));
      const noId = withCode.filter(x => !/\bid\s*:/.test(x));
      if (!withCode.length) {
        console.log('  ✗ 站上這一份裡一個「帶 code 的 uclTeamCell 字面值」都沒有 —— 是抓錯檔或寫法變了,不是通過');
      } else {
        console.log(`  站上的 uclTeamCell 物件字面值:帶 code 的 ${withCode.length} 處、其中缺 id 的 ${noId.length} 處`
          + (noId.length ? ` ← ✗ 那一欄不會畫隊徽:${noId.map(x => x.trim().slice(0, 40)).join(' / ')}` : ' ← ✓'));
      }
    }
  }

  // ── 三、歐冠的身分資料,以及「實際畫得出幾列」 ────────────
  const assets = await get('data/ucl-teams.json');
  const A = jsonOf(assets);
  console.log(`  data/ucl-teams.json  HTTP ${assets.status}  ${assets.buf.length} bytes  sha256:${sha(assets.buf)}`);
  if (!A) { console.log('  ✗ 不是 JSON'); return; }
  console.log(`  external ${A.external?.length ?? 0} 支・externalPending ${JSON.stringify(A.externalPending ?? null)}`
    + `・externalUnmapped ${A.externalUnmapped ?? '?'}・本站認得 ${A.teams?.length ?? 0} 支`);

  const ucl = await get('data/ucl.json');
  const U = jsonOf(ucl);
  console.log(`  data/ucl.json  HTTP ${ucl.status}  ${ucl.buf.length} bytes  sha256:${sha(ucl.buf)}`);
  if (!U) { console.log('  ✗ 不是 JSON'); return; }

  /* 逐列照前端的規則算:有隊碼 → 本站名冊(teams 帶 crest);沒有 → external 查 id。
     這就是積分榜那一欄會不會出現 <img> 的條件。 */
  const byCode = new Map((A.teams ?? []).map(t => [t.code, t]));
  const byId = new Map((A.external ?? []).map(t => [t.id, t]));
  for (const s of U.seasons ?? []) {
    const rows = s.table?.rows ?? [];
    if (!rows.length) continue;
    const drawn = rows.filter(r => (r.code ? byCode.get(r.code)?.crest : byId.get(r.id)?.crest));
    const miss = rows.filter(r => !(r.code ? byCode.get(r.code)?.crest : byId.get(r.id)?.crest));
    console.log(`  ${s.label}${s.current ? '(本季)' : ''} 積分榜:${drawn.length} / ${rows.length} 列畫得出隊徽`
      + (miss.length ? ` ← 缺:${miss.map(r => r.name).join('、')}` : ' ← ✓ 一支不缺'));
  }
  console.log(`✔ 這一輪共 ${requests} 個請求(唯讀、不寫快取)`);
}

main().catch(e => { console.log('✗ 探測失敗:', e.name, e.message); });
