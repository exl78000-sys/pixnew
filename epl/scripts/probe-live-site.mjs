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
 * 唯讀、零快取、**13 個請求**(meta / intl.html / intl.json / intl-teams.json / intl-flags.json /
 * explore.html / game-sim.js / cups.html / ucl.html / page-cups.js / ucl-view.js / ucl-teams.json / ucl.json)。
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

  // ── 國家隊(2026-09-25):合併後第一次部署有沒有真的把那一頁供出來 ─────
  /* 部署 job 綠了只代表上傳成功;頁面、資料與它引用的 JS 三個都要在站上才算上線。
     放在歐冠那一段**前面** —— 歐冠那一段有好幾個 return,放後面的話那邊一出事這邊就沒跑。 */
  const intlPage = await get('intl.html');
  const intlSrc = /["']((?:\.\/)?assets\/js\/page-intl\.js(?:\?v=[0-9a-f]{8})?)["']/.exec(intlPage.text)?.[1];
  console.log(`  intl.html  HTTP ${intlPage.status}  ${intlPage.buf.length} bytes・引用 ${intlSrc ?? '✗ 找不到 page-intl.js'}`);
  const intl = await get('data/intl.json');
  const I = jsonOf(intl);
  console.log(`  data/intl.json  HTTP ${intl.status}  ${intl.buf.length} bytes  sha256:${sha(intl.buf)}`);
  if (I) {
    const fx = I.fixtures ?? [];
    console.log(`  國家隊建置 ${I.builtAt}・評分截止 ${I.model?.ratingsAsOf}・驗收 ${I.model?.holdout?.gain} ± ${I.model?.holdout?.se}`
      + `(${I.model?.passed ? '通過' : '沒通過'})・未賽 ${fx.length}(給勝率 ${fx.filter(f => f.prob).length})`
      + `・賽果 ${(I.results ?? []).length}・核對 ${JSON.stringify(I.checkCounts ?? null)}`);
    /* 2026-09-25 那一批:積分榜、排名只列會員、國旗 —— 欄位不在就是**站上還是上一版**,印「沒有這個欄位」而不是 0
       (0 是一個看起來很像答案的數字) */
    const st = I.standings;
    console.log(`  分組積分榜 ${st ? `${st.length} 個賽事 ${st.reduce((a, c) => a + (c.groups?.length ?? 0), 0)} 組` : '(沒有這個欄位)'}`
      + `・排名 ${(I.ranking ?? []).length} 隊・不列的非會員 ${I.nonMembers ? I.nonMembers.length : '(沒有這個欄位)'}`
      + `・國旗 ${I.flags ? `${I.flags.count} 隊` : '(沒有這個欄位)'}`);
    // 2026-09-25 的中立場推論:過了門檻的話,每一場給勝率的都要帶 venue
    const vn = I.model?.venue;
    const withVenue = fx.filter(f => f.prob && f.venue).length;
    console.log(`  中立場推論 ${vn ? `${vn.passes ? '通過' : '沒通過'}(驗收 ${vn.holdout?.gain} ± ${vn.holdout?.se})・給勝率 ${fx.filter(f => f.prob).length} 場裡帶推論的 ${withVenue} 場`
      + `・機率 40% 以上 ${fx.filter(f => f.venue?.q >= 0.4).length} 場` : '(沒有這個欄位)'}`);
  } else console.log('  ✗ data/intl.json 不是 JSON');
  /* 球隊頁與國旗的明細是另外兩份產物(只有國家隊頁載)。404 就是那一批還沒部署上去 —— 照實講,不當成錯。 */
  for (const [path, count] of [['data/intl-teams.json', j => `${Object.keys(j.teams ?? {}).length} 隊`],
    ['data/intl-flags.json', j => `${Object.keys(j.flags ?? {}).length} 面・${JSON.stringify(j.size ?? null)}`]]) {
    const r = await get(path);
    const j = r.ok ? jsonOf(r) : null;
    console.log(`  ${path}  HTTP ${r.status}  ${r.buf.length} bytes${j ? `・${count(j)}・建置 ${j.builtAt ?? '?'}  sha256:${sha(r.buf)}` : r.ok ? '・✗ 不是 JSON' : '(站上沒有這個檔)'}`);
  }

  // ── 模擬遊玩(2026-09-25,階段 5n):站上的引擎是不是新的那一份 ─────
  /* 兩個請求就夠:資產戳是內容雜湊、一層一層串起來的(explore.html → page-explore → game-view
     → game-live → game-sim),所以 explore.html 引用的戳對上本機那一份,整條鏈就是同一次建置;
     game-sim.js 直接抓(Pages 不看 ?v=),印 sha256 讓本機逐位元組比。
     字面值查的是 5n 的兩個常數 —— 找不到就印 ✗,不印 0(那個檔不可能一處都沒有)。 */
  const explore = await get('explore.html');
  const exploreSrc = /["']((?:\.\/)?assets\/js\/page-explore\.js(?:\?v=[0-9a-f]{8})?)["']/.exec(explore.text)?.[1];
  console.log(`  explore.html  HTTP ${explore.status}  ${explore.buf.length} bytes・引用 ${exploreSrc ?? '✗ 找不到 page-explore.js'}`);
  const sim = await get('assets/js/game-sim.js');
  if (!sim.ok) console.log(`  assets/js/game-sim.js  HTTP ${sim.status} ← ✗ 站上抓不到`);
  else {
    const has = re => re.test(sim.text) ? '✓' : '✗';
    console.log(`  assets/js/game-sim.js  HTTP ${sim.status}  ${sim.buf.length} bytes  sha256:${sha(sim.buf)}`
      + `・PRESS_TRACK = SIM_RUN ${has(/^const PRESS_TRACK = SIM_RUN;/m)}・SHOT_PRESSED = 1 ${has(/^const SHOT_PRESSED = 1;/m)}`);
  }

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
