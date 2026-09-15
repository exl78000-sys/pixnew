/* 盃賽單場頁(2026-09-13)。足總盃與聯賽盃的賽後報告。

   為什麼是獨立一頁:跟歐冠同一個理由(量過的)—— 一份報告比整份輪次清單還長,
   塞回清單裡展開就是「清單不能用了」。歐冠 9/13 改成單場頁,盃賽照同一條路。

   **報告的卡片不重畫** —— 用 core.js 的 `matchReportCards`(三個聯賽、歐冠、盃賽同一套)。
   自己再畫一份的話,改了 core 這邊會悄悄過期,那是本專案最常見的那種過期。

   這一頁**只有賽後**,沒有賽前勝率 —— 盃賽沒有本站的模型:
   對手一半是第三、四級球隊,本站沒有它們的賽果,評不出強度(鐵則二:沒有回測證據就不給預測)。
   所以不要在這裡長出一個「賽前分析」分頁,那會是憑空的數字。 */
import * as C from './core.js?v=deaac0d6';

const app = document.getElementById('app');

/* 本站認不得的球隊用中性色(跟歐冠同一組)—— 隊色是球隊的身分,編一個出來不行;
   但球場圖與射門圖需要兩種能分辨的顏色,所以用明確中性的兩色並在畫面上講。 */
const NEUTRAL = ['#a8b2c7', '#d9a648'];

const POST_ORDER = ['compare', 'tactics', 'events', 'shotmap', 'momentum', 'lineups', 'teamStats', 'players', 'best'];

/* 報告裡的隊伍身分是 `cupTeamId` 算出來的(隊碼,沒有隊碼就 fm{FotMob id})。
   所以畫面要先把兩邊登錄成「本站認得的隊」:有隊碼的沿用站上的顏色與隊徽,
   沒有的用名字 + 盃賽隊徽查表(cups.json 的 crests)+ 中性色。
   **先登錄再畫頁首** —— 反過來的話隊徽會印成上游的數字 id(歐冠單場頁踩過)。

   **有隊碼的那一邊要查英超目錄的 clubs.json,不是目前聯賽的名冊。**
   第一版寫 `C.team(code)`,而 team() 查不到時回的是**樁**(不是 null):
   站在西甲看一場足總盃,兩支英格蘭球隊都拿到樁的 ['#444','#888'] ——
   隊徽沒有、而且球場圖與射門圖上兩隊是同一個灰,分不出誰是誰。
   所以這裡吃 ident(core.js 的 cupClubs + cups 的 crests),樁一律不採用。 */
function registerSides(rep, ident) {
  const ids = Object.keys(rep.names ?? {});
  C.registerTeams(ids.map((id, i) => {
    const code = rep.codes?.[id] ?? null;
    const side = { code, sourceId: rep.sourceIds?.[id], name: rep.names?.[id] };
    const site = code ? ident.clubs?.get(code) ?? null : null;
    const crest = C.cupCrest(side, ident);
    const name = rep.names?.[id] ?? id;
    return {
      code: id,
      en: code && site?.en ? site.en : name,
      zh: code && site?.zh ? site.zh : name,
      colors: site?.colors ?? [NEUTRAL[i] ?? NEUTRAL[0], NEUTRAL[i] ?? NEUTRAL[0]],
      chartColor: site?.chartColor ?? site?.colors?.[0] ?? NEUTRAL[i] ?? NEUTRAL[0],
      ...(crest ? { crest } : {}),
    };
  }));
}

/* 這一場在賽程裡的原始場次物件(名字、層級、開球時間都在它身上)。
   `cups.json` 的結構是 cups[].seasons[].rounds[].matches[] —— 走整份找,不列舉輪次。 */
function findMatch(cups, id) {
  for (const cup of cups?.cups ?? []) {
    for (const s of cup.seasons ?? []) {
      for (const r of s.rounds ?? []) {
        const hit = (r.matches ?? []).find(m => String(m.id) === String(id));
        if (hit) return { cup, season: s, round: r, match: hit };
      }
    }
  }
  return null;
}

const scoreText = m => (m?.played && Array.isArray(m.final)
  ? `${m.final[0]} <span class="dim">:</span> ${m.final[1]}` : '—');

try {
  const { meta, clubs, teams } = await C.load('meta', 'clubs', 'teams');
  /* 盃賽的產物是**跨聯賽一份**,放在 pl(三個聯賽的盃賽頁都從 pl 載)—— 所以這裡也從 pl 載,
     不是從目前的聯賽。站在西甲看一場聯賽盃,看的是同一份資料。 */
  const { data: shared } = await C.loadFrom('pl', ['cups', 'cup-details', 'competitions']);
  C.registerCompetitions(shared.competitions);
  C.registerTeams(clubs); C.registerTeams(teams);
  C.nav();

  const id = C.qs('id');
  const cups = shared.cups;
  const details = shared['cup-details'];
  const found = findMatch(cups, id);
  const idx = details?.reports?.[String(id)] ?? null;
  const cupKey = found?.cup?.key ?? idx?.cup ?? C.qs('cup');
  const back = `<a class="small dim" href="${C.link('cups', cupKey ? { cup: cupKey } : {})}">← 回盃賽</a>`;

  if (!found && !idx) {
    app.innerHTML = `<div class="page-head">${back}<h1 style="margin-top:6px">找不到這一場</h1></div>
      <div class="note">網址帶的場次 id 不在本站的盃賽資料裡(${C.esc(String(id ?? '(沒有 id)'))})。
        可能是網址改過,或那一季還沒接進來。</div>
      ${C.foot(meta, { sources: cups?.sources ?? null })}`;
  } else {
    const m = found?.match ?? null;
    const cupName = found?.cup?.zh ?? details?.cups?.[cupKey]?.zh ?? '盃賽';
    const seasonLabel = found?.season?.label ?? idx?.season ?? '';
    const stage = found?.round?.stage ?? m?.stage ?? idx?.stage ?? '';
    const when = m?.kickoff ? C.kickoffLocal(m.kickoff) : '時間待定';
    const homeName = m?.home?.name ?? idx?.home ?? '?';
    const awayName = m?.away?.name ?? idx?.away ?? '?';
    /* 延長與 PK 要講出來:盃賽的最終比分是**延長後**的,PK 收場時它是平手比分 ——
       只印一個 0:0 會讓讀者以為沒有人晉級(本站在歐冠 fullTime 那條坑上學過)。 */
    const extra = m?.pens?.length === 2 ? `PK ${m.pens[0]}:${m.pens[1]}`
      : (m?.aet || idx?.aet) ? '延長賽後' : '';

    app.innerHTML = `
    <div class="page-head">
      ${back}
      <h1 style="margin-top:6px">${C.esc(homeName)} <span class="dim">vs</span> ${C.esc(awayName)}</h1>
      <p class="small muted">${C.esc(cupName)}${seasonLabel ? `・${C.esc(seasonLabel)}` : ''}${
        stage ? `・${C.esc(stage)}` : ''}・${when}</p>
    </div>
    <div class="card">
      <div class="scoreline" style="margin:4px 0 10px">
        <div class="side" id="cmHome"></div>
        <div class="sc" style="font-size:22px">${scoreText(m ?? { played: true, final: idx?.score })}</div>
        <div class="side away" id="cmAway"></div>
      </div>
      <div class="center tiny dim">${(m?.played ?? !!idx)
        ? `最終比分${extra ? `(${extra})` : ''}` : '尚未開賽'}</div>
    </div>
    <div id="cupDetail" style="margin-top:16px"></div>
    ${C.foot(meta, { sources: cups?.sources ?? null })}`;

    const slot = document.getElementById('cupDetail');
    if (!idx) {
      /* 為什麼沒有報告要講得出來,分得出三種:依設計拒收、供應商缺資料、還沒抓到。
         「什麼都不留」的話讀者看到踢完的比賽沒有內容而畫面不解釋(cups 撤銷那條坑)。 */
      const inc = (details?.incomplete ?? []).find(x => String(x.id) === String(id));
      /* 讀取器層退回的也要認得出來(鍵是「賽季|比賽 id」)。不認的話那 6 場會被講成
         「還沒抓到」—— 而它們抓到了,是上游沒有控球率所以本站不收。
         「還沒抓到」會再來,「上游沒有」不會,兩種對讀者的意思完全不同。 */
      const rej = (details?.rejected ?? []).find(x => String(x.key ?? '').endsWith(`|${id}`));
      const why = inc ? `供應商這一場缺了必要的資料(${C.esc(inc.reason || (inc.missing ?? []).join('、'))})`
        : rej ? `本站沒有收這一場的詳情:${C.esc(rej.reason ?? '核對沒過')}`
          : (m?.played ?? false) ? '這一場的逐場詳情還沒抓到(每次部署會補,一場一個請求)'
            : '這一場還沒踢完';
      slot.innerHTML = `<div class="note">這一場沒有賽後報告 —— ${why}。</div>`;
    } else {
      slot.innerHTML = '<div class="tiny dim">載入賽後報告中…</div>';
      const name = `cup-details/${idx.cup}/${idx.season}/${id}`;
      const { data, absent } = await C.loadFrom('pl', [name]);
      const rep = data[name];
      if (!rep) {
        slot.innerHTML = absent.length
          ? '<div class="tiny dim">單檔版沒有打包逐場賽後報告(整季會到幾十 MB);分頁版才有。</div>'
          : '<div class="tiny dim">這一場的報告讀不到。</div>';
      } else {
        registerSides(rep, { clubs: await C.cupClubs(), crests: cups?.crests ?? {} });
        const ids = Object.keys(rep.names ?? {});
        const neutral = ids.some(x => !rep.codes?.[x]);
        document.getElementById('cmHome').innerHTML = `${C.badge(ids[0] ?? '')} <b>${C.esc(homeName)}</b>`;
        document.getElementById('cmAway').innerHTML = `${C.badge(ids[1] ?? '')} <b>${C.esc(awayName)}</b>`;
        slot.innerHTML = `
          <div class="tiny dim" style="margin:2px 0 8px">賽後資料來自 <b>FotMob 的逐場詳情</b>(球隊統計、事件、正式名單、逐人評分、逐射門 xG)。
            xG 是${C.esc(details?.xgNote ?? '逐射門 xG 加總')}${
              rep.shotmapComplete === false ? ' —— <b>這一場射門圖不完整,所以沒有 xG</b>' : ''}。
            ${details?.scoreCheck?.independent === false
              ? `<b>比分核對不是獨立來源</b>:${C.esc(details.scoreCheck.note ?? '')}`
              : '比分已跟獨立來源核對。'}
            ${neutral ? '本站沒有資料的球隊在球場圖與射門圖上用<b>中性色</b>,不是隊色。' : ''}
            ${(rep.partial ?? []).length ? `<b>上游這一場沒有${(rep.partial ?? []).map(x => C.esc(x.zh)).join('與')}</b>
              —— 足總盃前幾輪的低級別場次常見,所以下面沒有那幾張卡。球隊統計、射門圖、事件與正式名單不受影響。` : ''}</div>
          ${C.matchReportCards(rep, { order: POST_ORDER })}`;
      }
    }
  }
} catch (e) { C.fail(e); }
