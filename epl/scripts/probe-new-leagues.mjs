#!/usr/bin/env node
/* 探測**義甲與法甲**能不能照德甲那條路做:Understat 的聯賽代號、FotMob 的聯賽 id,
 * 以及兩邊的隊名跟 openfootball(本站的主來源)對不對得上。
 *
 *   npm run probe:new-leagues
 *
 * ── 為什麼這一支要先跑,不能直接開始寫 build ──
 * 加德甲那一輪付過兩次代價,兩次都在「名字」上:
 *   - Understat 的德甲隊名 26 個裡**只對上 11 個**(上游用短名)。不先問就直接抓,
 *     那 7 隊會整隊消失而畫面完全正常 —— 英冠那次是 14 支。
 *   - FotMob 的 GER 清單裡一堆叫 Bundesliga 的東西,而**奧地利甲也叫 Bundesliga**
 *     (id 38)。照名字挑會挑到它,而它照樣回得出 18 隊與逐場資料,一個錯都不報。
 * 義甲與法甲有同一種陷阱:義大利有 Serie A / Serie B / Serie A Femminile、
 * 法國有 Ligue 1 / Ligue 2 / D1 Féminine,而且**巴西也有 Serie A**。
 *
 * 所以這一支問四件事,而且每一件都要有**證明**,不是「看起來像」:
 *   1. Understat 的聯賽代號(候選逐一試;猜錯不會拋錯,它回 200 + error 或空陣列)
 *   2. FotMob 的聯賽 id(從 allLeagues 找 ccode,再**逐隊比對 openfootball 的名單**)
 *   3. 兩邊的隊名對不對得上 openfootball —— 對不上的逐個印出來,那就是 alias 清單
 *   4. 逐場詳情有沒有賽後報告要的五塊(德甲有不代表義甲法甲有)
 *
 * 對照組:Understat 那一段拿 `La_liga`、FotMob 那一段拿德甲 id 54 當對照。
 * 對照組也失敗代表端點或 runner 出口有問題,**那一輪不能下任何關於新聯賽的結論**
 * —— 這兩個結論差很多。
 *
 * openfootball 走 raw.githubusercontent.com(沙箱也通),另外兩家只有 runner 通,
 * 所以整支掛在 probe-apis.yml 的 latest job **最後一步**(讀結果是抓 log 尾端,
 * 排前面會被後面的步驟擠出視窗)。唯讀、**最多 22 個請求**、不寫任何快取。
 */
const OF = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const FM = 'https://www.fotmob.com';
const US = 'https://understat.com/main/getPlayersStats/';
const UA = 'Mozilla/5.0 (compatible; EPL-Warroom/1.0; local research)';
const MAX = 22;

/* 每個聯賽要問的東西。`ofCode` 是本站主來源的檔名,`season` 是拿來比對的那一季
   —— 挑**上一季**(已完賽、隊名齊全),本季九月只踢了幾輪,名單可能還不全。 */
const LEAGUES = [
  { key: 'it1', zh: '義甲', ofCode: 'it.1', season: '2025-26',
    ccode: 'ITA', usCandidates: ['Serie_A', 'Serie_a', 'serie_a', 'Italian_Serie_A'],
    /* 同名陷阱:巴西也有 Serie A,義大利自己還有 Serie B 與女足 Serie A */
    beware: '巴西也有 Serie A;義大利自己還有 Serie B 與 Serie A Femminile' },
  { key: 'fr1', zh: '法甲', ofCode: 'fr.1', season: '2025-26',
    ccode: 'FRA', usCandidates: ['Ligue_1', 'Ligue_1_Uber_Eats', 'ligue_1', 'French_Ligue_1'],
    beware: '法國還有 Ligue 2 與 D1 Féminine' },
];
const US_CONTROL = 'La_liga';
const FM_CONTROL = { id: 54, zh: '德甲(已知正確,對照組)' };

let used = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const line = t => console.log(`\n${'─'.repeat(72)}\n▶ ${t}`);

/* 隊名正規化:**只做大小寫、變音符號、標點**。不砍 token —— 砍過頭會對錯球隊
   (本站在盃賽頁被寬鬆比對咬過兩次)。這裡只用來「找出哪些對不上」,不用來下結論。 */
const norm = s => String(s ?? '')
  .replace(/[Đ]/g, 'Dj').replace(/[Øø]/g, 'o').replace(/[Łł]/g, 'l').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* 兩個名字算不算同一隊:**共同的有意義 token**。法人形式的字(FC/AC/US/SS…)
   與純數字年份(1909、1913、29、1901)不算 —— 它們到處都是,拿它們當共同點
   會讓 `Bologna FC 1909` 對上 `Genoa CFC`。 */
const NOISE = new Set(['fc', 'ac', 'as', 'us', 'ss', 'ssc', 'afc', 'cfc', 'sco', 'acf', 'rc', 'aj', 'og', 'ogc',
  'calcio', 'club', 'de', 'la', 'le', 'olympique', 'stade', 'racing', 'associazione', 'sport']);
const tokens = s => norm(s).split(' ').filter(t => t && !NOISE.has(t) && !/^\d+$/.test(t));
const sameTeam = (a, b) => {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return false;
  return A.some(t => B.includes(t));
};
/* **這個比對器會漏掉一種,而那正是它要找的東西。** `FC Internazionale Milano` 與
   `Inter`、`Stade Brestois 29` 與 `Brest`、`Olympique Lyonnais` 與 `Lyon`
   一個共同 token 都沒有 —— 它們會落進「對不上」那一份清單裡,而那份清單就是
   **要補的 alias 表**,不是錯誤報告。CLAUDE.md 那條坑(「兩份名單對照只比全名
   會整隊漏掉」)講的就是這件事:漏掉的那一隊會變成整季隊名對不上,
   看起來像資料錯,其實是對照表漏了。
   在沙箱裡拿 12 組試金石驗過:5 組該對上、5 組故意相似的該落選
   (`Bologna FC 1909` vs `Genoa CFC`、`Stade Rennais` vs `Stade de Reims` …)、
   2 組已知要 alias 的確實落在「對不上」裡。**故意相似那一組比正面那組重要** ——
   對錯人比對不到糟得多。 */

async function get(url, opts = {}) {
  if (used >= MAX) { console.log(`  (已達 ${MAX} 個請求上限,略過)`); return null; }
  if (used) await sleep(1200);
  used++;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(25000), ...opts,
      headers: { accept: 'application/json', 'user-agent': UA, ...(opts.headers ?? {}) } });
  } catch (e) { console.log(`  [${used}/${MAX}] 連不上:${e.message}`); return null; }
  console.log(`  [${used}/${MAX}] ${url.replace(FM, '').replace(OF, 'openfootball')} → HTTP ${res.status}`);
  if (!res.ok) return null;
  let j;
  try { j = await res.json(); } catch { console.log('  ✗ 回的不是 JSON'); return null; }
  /* 200 + error 物件是這兩家共同的失敗方式,只看 res.ok 會把失敗當成功。 */
  if (j?.error) { console.log(`  ✗ 200 但帶 error:${JSON.stringify(j.error).slice(0, 120)}`); return null; }
  return j;
}

async function understat(league, season) {
  const body = new URLSearchParams({ league, season: String(season) }).toString();
  const j = await get(US, { method: 'POST', body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      referer: `https://understat.com/league/${league}/${season}`,
      'x-requested-with': 'XMLHttpRequest',
    } });
  if (!j) return null;
  const rows = Array.isArray(j) ? j : (j.players ?? null);
  if (!Array.isArray(rows)) { console.log(`  ✗ 不是球員陣列(頂層鍵:${Object.keys(j ?? {}).join(',') || '無'})`); return null; }
  return rows;
}

async function main() {
  console.log('問的是:義甲與法甲做不做得成完整聯賽(球隊 + 比賽 + 球員三層)。');
  console.log('openfootball 已經在沙箱裡驗過了:義甲四季各 380 場、法甲各 306 場,全部有比分。');
  console.log('這一支只問另外兩家 —— 它們沙箱連不到。\n');

  /* FotMob 的清單一次就夠,兩個聯賽共用。 */
  line('0. 抓 FotMob 的 allLeagues(兩個聯賽共用一次)');
  const all = await get(`${FM}/api/data/allLeagues`);
  const leagues = [];
  if (all) {
    const walk = (v, cc) => {
      if (Array.isArray(v)) { for (const x of v) walk(x, cc); return; }
      if (!v || typeof v !== 'object') return;
      const next = v.ccode ?? v.countryCode ?? v.ccode3 ?? cc;
      if (Number.isFinite(v.id) && typeof v.name === 'string' && v.name) leagues.push({ id: v.id, name: v.name, cc: next ?? null });
      for (const x of Object.values(v)) walk(x, next);
    };
    walk(all, null);
    console.log(`  收到 ${leagues.length} 個聯賽節點`);
  } else {
    console.log('  ✗ 拿不到 allLeagues —— FotMob 那幾節這一輪沒有答案(不要退回用名字猜)');
  }

  const verdict = [];
  for (const L of LEAGUES) {
    console.log(`\n${'═'.repeat(72)}\n█ ${L.zh}(${L.key})　陷阱:${L.beware}\n${'═'.repeat(72)}`);

    // ── openfootball 的名單:這是本站的主來源,兩邊都拿它當標準 ──
    const of = await get(`${OF}/${L.season}/${L.ofCode}.json`);
    const ofNames = [...new Set((of?.matches ?? []).flatMap(m => [m.team1, m.team2]).filter(Boolean))];
    console.log(`  openfootball ${L.season}:${of?.matches?.length ?? 0} 場、${ofNames.length} 隊`);
    if (!ofNames.length) { console.log('  ✗ 主來源都沒有,後面不用問了'); continue; }

    line(`${L.zh} 1. Understat 的聯賽代號(候選逐一試,不是猜一個寫死)`);
    let usSlug = null, usRows = null;
    for (const c of L.usCandidates) {
      const r = await understat(c, 2025);
      /* **空陣列不算成功。** 英冠那次四種寫法全回 `{"success":true,"players":[]}`,
         只看「有沒有拋錯」會把它當成拿到了。 */
      if (r && r.length) { usSlug = c; usRows = r; console.log(`  → ${r.length} 筆`); break; }
      if (r) console.log('     (空陣列 —— 端點認得這個寫法,但沒有資料,不算成功)');
    }
    if (usSlug) {
      console.log(`  ✔ 聯賽代號 "${usSlug}"、${usRows.length} 筆`);
      const keys = Object.keys(usRows[0] ?? {});
      const NEED = ['id', 'player_name', 'games', 'time', 'goals', 'xG', 'assists', 'xA', 'shots',
        'key_passes', 'yellow_cards', 'red_cards', 'position', 'team_title', 'npg', 'npxG', 'xGChain', 'xGBuildup'];
      const lack = NEED.filter(k => !keys.includes(k));
      console.log(lack.length ? `  ⚠ 少了西甲有的欄位:${lack.join('、')}` : '  ✔ 欄位跟西甲那一組一個不少,下游照用');
      /* 隊名對照:對不上的那幾隊會**整隊消失而畫面完全正常**,所以逐個印出來當 alias 清單。 */
      const usTeams = [...new Set(usRows.flatMap(r => String(r.team_title ?? '').split(',').map(s => s.trim())).filter(Boolean))];
      const bad = usTeams.filter(t => !ofNames.some(o => sameTeam(o, t)));
      console.log(`  隊名:上游 ${usTeams.length} 個,對得上 openfootball ${usTeams.length - bad.length} 個`);
      if (bad.length) { console.log('  ⚠ 對不上(這就是要補的 alias,不補就整隊消失):'); for (const t of bad) console.log(`      ${t}`); }
    } else {
      console.log(`  ✗ 候選字串都沒有資料。先跑對照組確認是「${L.zh}沒有」還是「端點不通」:`);
      const ctl = await understat(US_CONTROL, 2025);
      console.log(ctl?.length
        ? `  → 西甲回了 ${ctl.length} 筆,端點是通的 ⇒ 是這幾個寫法不對,要再找別的`
        : `  → 西甲也拿不到 ⇒ 端點或 runner 出口有問題,**這一輪不能下關於${L.zh}的結論**`);
    }

    line(`${L.zh} 2. FotMob 的聯賽 id —— 逐隊比對 openfootball 才算證明`);
    const cand = leagues.filter(x => String(x.cc).toUpperCase() === L.ccode);
    console.log(`  ${L.ccode} 的候選 ${cand.length} 個:`);
    for (const c of cand.slice(0, 12)) console.log(`      id=${String(c.id).padStart(5)}  ${c.name}`);
    let fmId = null, fmNames = [];
    if (cand.length) {
      const pick = cand[0];
      console.log(`\n  先拿 id=${pick.id}(${pick.name})去驗 —— **清單第一個不是答案,下一段才是**`);
      const fx = await get(`${FM}/api/data/leagues?id=${pick.id}&ccode3=${L.ccode}&season=${encodeURIComponent(L.season.slice(0, 4) + '/' + (Number(L.season.slice(0, 4)) + 1))}`);
      const matches = fx?.matches?.allMatches ?? fx?.fixtures?.allMatches ?? [];
      console.log(`  賽程 ${matches.length} 場・聯賽名 ${fx?.details?.name ?? '?'}`
        + `・國家 ${fx?.details?.country ?? '?'}・賽季 ${fx?.details?.selectedSeason ?? '?'}`);
      fmNames = [...new Set(matches.flatMap(m => [m.home?.name, m.away?.name]).filter(Boolean))];
      const bad = fmNames.filter(t => !ofNames.some(o => sameTeam(o, t)));
      console.log(`  隊名 ${fmNames.length} 個,對得上 ${fmNames.length - bad.length} 個`);
      if (bad.length) { console.log('  ⚠ 對不上(全部對不上 = 挑錯聯賽;只有幾個 = 上游用短名):'); for (const t of bad) console.log(`      ${t}`); }
      /* ── 這裡有**兩個不同的問題**,第一版把它們混成一條 ──
           (a) 這個 id 是不是這個聯賽?    (b) alias 表補齊了沒?
         德甲那支寫 `bad.length === 0` 是對的,因為它比的是**本站名冊**(alias 已經在裡面)。
         這一支比的是 openfootball 的全名而且還沒有 alias,所以短名一定對不上 ——
         照抄那個門檻就會把「id 其實是對的」報成「還不能下結論」(第一次跑就是這樣)。

         (a) 的判準是**辨別力**:挑錯聯賽的話幾乎一隊都不會對上(Serie B 沒有 Juventus,
         巴西 Serie A 的 ccode 也不是 ITA)。所以要求隊數吻合 + 大多數對得上 + 國家碼相符,
         而不是「一個都不能漏」。`bad` 全部落在**兩邊剩下的名字一樣多**那種情況時,
         它是短名不是錯聯賽。
         (b) 分開報,而且**明講那只是候選**:一對一是線索不是證據(CLAUDE.md 那條坑),
         真正的核對是接上之後逐隊拿進球與分鐘對帳。 */
      const leftover = ofNames.filter(o => !fmNames.some(t => sameTeam(o, t)));
      const idProven = fmNames.length === ofNames.length
        && bad.length <= Math.floor(fmNames.length * 0.2)
        && String(fx?.details?.country ?? '').toUpperCase() === L.ccode
        && bad.length === leftover.length;
      if (idProven) {
        fmId = pick.id;
        console.log(`\n  ✔ **id 證明了**:${L.zh}的 FotMob id 是 ${pick.id}`
          + `(隊數 ${fmNames.length} = openfootball ${ofNames.length}、對上 ${fmNames.length - bad.length} 隊、國家 ${L.ccode})`);
        if (bad.length) {
          console.log(`  剩下 ${bad.length} 個是上游的短名,**不是挑錯聯賽** —— 兩邊剩下的名字一樣多。候選配對(**只是候選**):`);
          for (const t of bad) {
            const guess = leftover.filter(o => norm(o).includes(norm(t)) || norm(t).includes(norm(o).split(' ')[0]));
            console.log(`      ${t}  →  ${guess.length === 1 ? guess[0] : `(${leftover.join(' / ')} 之一,要人工判)`}`);
          }
          console.log('  一對一**不是證據**:alias 補上之後要逐隊拿進球與分鐘對帳才算數(德甲那輪的做法)。');
        }
      } else {
        console.log(`\n  ✗ 還不能下結論 —— ${fmNames.length !== ofNames.length ? `隊數 ${fmNames.length} ≠ openfootball ${ofNames.length}`
          : bad.length !== leftover.length ? '對不上的數量跟剩下的名字對不起來(可能真的是別的聯賽)'
          : '對不上的比例太高'},不要把這個 id 寫進表裡`);
      }
    }

    if (fmId) {
      line(`${L.zh} 3. 逐場詳情有沒有賽後報告要的五塊(德甲有不代表這裡有)`);
      const fx = await get(`${FM}/api/data/leagues?id=${fmId}&ccode3=${L.ccode}&season=${encodeURIComponent(L.season.slice(0, 4) + '/' + (Number(L.season.slice(0, 4)) + 1))}`);
      const done = (fx?.matches?.allMatches ?? []).filter(m => m.status?.finished && m.id).slice(0, 1);
      for (const m of done) {
        const d = await get(`${FM}/api/data/matchDetails?matchId=${m.id}`);
        if (!d) continue;
        const c = d.content ?? {};
        const has = k => (k in c) && c[k] != null;
        console.log(`  ${m.home?.name} ${m.status?.scoreStr ?? ''} ${m.away?.name}`);
        console.log(`    stats ${has('stats')}・shotmap ${has('shotmap')}・lineup ${has('lineup')}`
          + `・events ${!!(d.header?.events ?? c.matchFacts?.events)}・playerStats ${has('playerStats') || !!c.playerStats}`);
      }
    }
    verdict.push({ zh: L.zh, usSlug, fmId, ofTeams: ofNames.length });
  }

  console.log(`\n${'═'.repeat(72)}\n結論`);
  for (const v of verdict) {
    console.log(`  ${v.zh}:openfootball ${v.ofTeams} 隊`
      + `・Understat ${v.usSlug ? `代號 "${v.usSlug}" ✔` : '✗ 沒問出來'}`
      + `・FotMob ${v.fmId ? `id ${v.fmId} ✔(隊數吻合 + 逐隊比對)` : '✗ 沒證明出來'}`);
  }
  console.log(`\n共用掉 ${used} 個請求。`);
  console.log('**只有兩欄都 ✔ 的聯賽才照德甲那條路做三層;有一欄 ✗ 就只做做得出來的那幾層,');
  console.log('  而且畫面上要分清楚「拿不到」與「還沒抓」—— 那兩句對讀者的意義完全不同。**');
}

main().catch(err => { console.error(`✗ ${err.message}`); process.exitCode = 1; });
