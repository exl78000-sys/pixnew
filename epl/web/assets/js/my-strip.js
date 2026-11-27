/* 總覽最上面的「我的球隊」條(2026-11-27,N5;使用者選的)。

   兩種狀態:
   - **有關注的球隊**:每支一張小卡 —— 上一場比分(勝 / 和 / 負)、下一場對手與倒數。點卡片進那一隊的球隊頁。
   - **一支都沒有、也沒按過「先不用」**:一張「你支持哪一隊?」小卡,選聯賽、點隊徽就關注(用既有的關注機制)。
     按「先不用」就不再出現(存在這個瀏覽器);之後要加,到「我的球隊」頁或任何球隊頁的 ☆。

   這一條**不多要任何一份產物**:總覽本來就載各聯賽的 overview.json(名冊 + 賽程摘要 + 比分)。
   傷停**刻意不放**:那要每個聯賽多載一份球員檔(英超 players-core 幾百 KB),總覽的第一次繪製會被它拖慢;
   傷停在「我的球隊」頁有,卡片底下那一行連過去。

   **跨聯賽的一頁,球隊身分不能查「目前聯賽」的名冊**(CLAUDE.md:跨聯賽的東西不能有「目前聯賽」這個隱含參數;
   隊碼跨聯賽會重複,BUR 在英超與英冠都是)—— 所以隊名與隊徽一律從**那個聯賽自己的** teams 查,不走 C.badge / C.name。 */
import * as C from './core.js?v=662b4d9f';
import { readFollows, toggleFollow, FOLLOW_STORAGE_NOTE } from './follow.js?v=02130043';
import { teamGlance } from './glance.js?v=31cf66dc';

const DISMISS_KEY = 'warroom:onboard:v1';
const STRIP_MAX = 6;   // 再多就蓋掉「即將到來」;剩下的收成一行連到「我的球隊」

const dismissed = () => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } };
const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, '1'); return true; } catch { return false; } };

function crestOf(t, size = 22) {
  if (t?.crest) return `<img class="crest" src="${C.esc(t.crest)}" alt="" width="${size}" height="${size}" loading="lazy" style="width:${size}px;height:${size}px">`;
  return `<span class="badge" style="background:${C.esc(t?.colors?.[0] ?? '#444')};color:#fff">${C.esc(t?.code ?? '?')}</span>`;
}
const msName = t => t?.en ?? t?.zh ?? t?.code ?? '?';   // 全站目前印英文隊名(要不要全面改中文是 N1,等使用者決定),這裡跟著全站

const RES = { W: '勝', D: '和', L: '負' };   // 顏色走全站的 .frm(近況那一排同一套)

function card(lg, data, code) {
  const byCode = new Map((data.teams ?? []).map(t => [t.code, t]));
  const t = byCode.get(code);
  if (!t) return '';
  const g = teamGlance(data.fixtures, code);
  const opp = c => `${crestOf(byCode.get(c), 16)}<span>${C.esc(msName(byCode.get(c)) )}</span>`;
  const last = g.last
    ? `<div class="ms-line"><span class="tiny dim">上一場</span>
        <span class="frm ${g.last.result}">${RES[g.last.result]}</span>
        <b class="mono">${g.last.gf}-${g.last.ga}</b><span class="tiny dim">${g.last.home ? '主' : '客'}</span>${opp(g.last.opp)}
        ${g.last.provisional ? '<span class="tiny dim">暫定</span>' : ''}</div>`
    : '<div class="ms-line tiny dim">這一季還沒有踢完的比賽</div>';
  const next = g.next
    ? `<div class="ms-line"><span class="tiny dim">下一場</span><span class="tiny dim">${g.next.home ? '主' : '客'}</span>${opp(g.next.opp)}
        <span class="ms-when">${g.next.kickoff ? C.countdown(g.next.kickoff, { seconds: false })
          : `${C.esc(C.dateFull(g.next.date))}・時間待定`}</span></div>`
    : '<div class="ms-line tiny dim">這一季的聯賽賽程踢完了</div>';
  return `<a class="card ms-card" href="${C.link('teams', { code, league: lg })}">
    <div class="ms-head">${crestOf(t, 26)}<b>${C.esc(msName(t))}</b>${C.compBadge(lg)}</div>${last}${next}</a>`;
}

/* leagues:總覽載好的 [{ lg, data: { teams, fixtures } }] */
export function mountMyStrip(el, leagues) {
  if (!el) return;
  const pools = new Map(leagues.filter(x => Array.isArray(x.data?.teams)).map(x => [x.lg, x.data]));
  const follows = readFollows().filter(f => pools.has(f.lg) && pools.get(f.lg).teams.some(t => t.code === f.code));
  if (follows.length) {
    const shown = follows.slice(0, STRIP_MAX);
    el.innerHTML = `<div class="section"><h2>我的球隊</h2>
      <a class="hint" href="${C.link('predict')}">${follows.length > STRIP_MAX ? `另外 ${follows.length - STRIP_MAX} 支、` : ''}傷停與管理 →</a></div>
      <div class="ms-grid">${shown.map(f => card(f.lg, pools.get(f.lg), f.code)).join('')}</div>`;
    C.startCountdowns();
    return;
  }
  if (dismissed()) { el.innerHTML = ''; return; }
  pick(el, pools, leagues);
}

function pick(el, pools, leagues, lg = [...pools.keys()][0]) {
  const data = pools.get(lg);
  const teams = [...(data?.teams ?? [])].sort((a, b) => msName(a).localeCompare(msName(b)));
  el.innerHTML = `<div class="card ms-pick">
    <div class="spread"><h2 style="margin:0">你支持哪一隊?</h2>
      <button class="btn" type="button" data-ms-dismiss>先不用</button></div>
    <div class="small dim" style="margin:6px 0 10px">點隊徽就關注:總覽最上面會一直看到它的上一場與下一場,各頁也會把它標出來。之後要改,到「我的」→「我的球隊」。</div>
    <div class="ms-leagues">${[...pools.keys()].map(k => `<button type="button" class="btn${k === lg ? ' on' : ''}" data-ms-lg="${C.esc(k)}">${C.compBadge(k)} ${C.esc(C.LEAGUES[k]?.zh ?? k)}</button>`).join('')}</div>
    <div class="ms-teams">${teams.map(t => `<button type="button" class="ms-team" data-ms-team="${C.esc(t.code)}" title="${C.esc(t.en ?? t.code)}">
      ${crestOf(t, 32)}<span class="tiny">${C.esc(msName(t))}</span></button>`).join('')}</div>
    <div class="tiny dim" id="msMsg" style="margin-top:8px">${C.esc(FOLLOW_STORAGE_NOTE.split('——')[0])}</div></div>`;
  el.querySelectorAll('[data-ms-lg]').forEach(b => b.addEventListener('click', () => pick(el, pools, leagues, b.dataset.msLg)));
  el.querySelectorAll('[data-ms-team]').forEach(b => b.addEventListener('click', () => {
    const r = toggleFollow(lg, b.dataset.msTeam);
    if (!r.saved) { el.querySelector('#msMsg').textContent = '這個瀏覽器存不了關注名單(無痕視窗或關掉了網站資料),所以沒有記下來。'; return; }
    mountMyStrip(el, leagues);
  }));
  el.querySelector('[data-ms-dismiss]')?.addEventListener('click', () => {
    if (!dismiss()) { el.querySelector('#msMsg').textContent = '這個瀏覽器存不了設定,下次來還會再問一次。'; }
    el.innerHTML = '';
  });
}
