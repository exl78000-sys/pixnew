/* 關注球隊(2026-09-14,使用者要求)。全站共用的那一份。

   這個站沒有帳號也沒有後端(GitHub Pages 靜態站),所以「我關注哪幾隊」只能存在
   **這台裝置的這個瀏覽器**。做法與界線都照「我的預測」那一頁既有的那一套:
   localStorage + 匯出/匯入,而且**把「換一台就看不到」寫在畫面上**,
   不要讓人以為它存在雲端(鐵則四)。

   三個設計上的決定,每一個都有理由:

   1. **存的是 (聯賽, 隊碼) 配對,不是隊碼。**
      隊碼跨聯賽會重複 —— Burnley 在英超與英冠都是 `BUR`,Leeds、Ipswich、
      Leicester 這些升降級球隊同理。只存隊碼的話,關注英冠的 Burnley 會在英超頁
      標到另一支球隊上,而畫面看起來完全正常。CLAUDE.md 的陷阱表為了同一件事
      記過兩次(全域 registerTeams 後蓋前、Obsidian 檔名跨聯賽撞)。

   2. **不設硬上限,但超過 SOFT_LIMIT 要在畫面上講。**
      關注 40 支等於沒有關注 —— 所有「重點標記」都亮著就沒有重點。
      但要不要這樣是使用者的事,所以提醒而不是擋(使用者的決定,2026-09-14)。

   3. **這個模組只管「誰被關注」,不管「關注了要顯示什麼」。**
      各頁自己決定怎麼用(標色、置頂、加星)。這裡塞版面的話,
      六個消費端就會各自長出一份不一樣的星號。

   `localStorage` 在無痕視窗、關掉網站資料、或某些嵌入情境會**直接拋例外**
   (不是回 null),所以每一次讀寫都包起來:讀不到當成沒有關注,
   寫不進去要讓呼叫端講得出來 —— 靜靜失敗的話,使用者會以為自己點了但沒反應。 */

const KEY = 'warroom:follow:v1';

/* 關注太多支時畫面要提醒的門檻。8 是「一輪的場數量級」——
   再多的話首頁那張卡與即時置頂就會蓋掉整頁,而那正是這個功能想解決的問題。 */
export const SOFT_LIMIT = 8;

/* 這句話在四個地方用到(我的球隊頁、匯出區、動態的篩選說明、首頁小卡),
   所以收在這裡一份 —— 各頁自己寫的話,改了一邊另外三邊會悄悄過期。 */
export const FOLLOW_STORAGE_NOTE = '關注名單存在你自己的瀏覽器裡,沒有上傳到任何地方 ——'
  + '換一台裝置或清掉網站資料就會不見。要帶著走的話用下面的匯出。';

/* 讀。回的一律是**乾淨的陣列**:壞掉的 JSON、舊形狀、缺欄位的項目全部丟掉。
   前端到處都會 `.filter` 它,回 undefined 或一個物件的話就是整頁載入失敗。 */
export function readFollows() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const obj = JSON.parse(raw);
    const list = Array.isArray(obj) ? obj : (obj?.teams ?? []);
    const seen = new Set();
    const out = [];
    for (const t of list) {
      const lg = typeof t?.lg === 'string' ? t.lg : null;
      const code = typeof t?.code === 'string' ? t.code : null;
      if (!lg || !code) continue;
      const k = `${lg}|${code}`;
      if (seen.has(k)) continue;      // 同一隊被存兩次時只留一筆
      seen.add(k);
      out.push({ lg, code });
    }
    return out;
  } catch { return []; }
}

/* 寫。回傳成功與否 —— 呼叫端要用它決定要不要在畫面上講「存不起來」。 */
export function writeFollows(list) {
  try {
    const teams = (list ?? []).filter(t => t?.lg && t?.code).map(t => ({ lg: t.lg, code: t.code }));
    localStorage.setItem(KEY, JSON.stringify({ v: 1, teams, updatedAt: new Date().toISOString() }));
    return true;
  } catch { return false; }
}

export const isFollowed = (lg, code) => readFollows().some(t => t.lg === lg && t.code === code);

/* 這個聯賽被關注的隊碼。**回 Set 不回陣列** —— 呼叫端幾乎都是
   「這一列要不要標記」,用陣列的話每一列都是一次 O(n) 掃描。 */
export const followedIn = lg => new Set(readFollows().filter(t => t.lg === lg).map(t => t.code));

export const followCount = () => readFollows().length;

/* 不分聯賽的隊碼集合。**只給盃賽用。**
   平常一定要帶聯賽(BUR 在英超與英冠是兩筆),但盃賽裡的 BUR 就是 Burnley 這間俱樂部 ——
   他今年在哪一級跟「這是不是我關注的那支球隊」無關。所以這一支刻意不分聯賽,
   而且**只有盃賽頁用它**:聯賽頁用它的話,關注英冠的 Burnley 會標到英超那一支身上。 */
export const followedAnywhere = () => new Set(readFollows().map(t => t.code));

/* 切換。回 `{ on, saved }`:on 是切換後的狀態,saved 是有沒有真的寫進去。
   兩個都要 —— 寫不進去卻把星星點亮,是騙人。 */
export function toggleFollow(lg, code) {
  const list = readFollows();
  const i = list.findIndex(t => t.lg === lg && t.code === code);
  const on = i < 0;
  if (on) list.push({ lg, code }); else list.splice(i, 1);
  return { on, saved: writeFollows(list) };
}

/* 星號按鈕。**整站只有這一份** —— 六個地方各自畫一顆的話,
   改了樣式或無障礙標籤就要改六次,而漏掉的那個不會有人發現。
   `data-follow` 帶 `聯賽|隊碼`,點擊一律走委派(bindFollowStars)。 */
export function followStar(lg, code, { label = false } = {}) {
  const on = isFollowed(lg, code);
  const title = on ? '已關注,點一下取消' : '加入關注';
  return `<button type="button" class="followstar${on ? ' on' : ''}" data-follow="${lg}|${code}"
    title="${title}" aria-pressed="${on}" aria-label="${title}">${on ? '★' : '☆'}${
    label ? `<span class="tiny">${on ? '已關注' : '關注'}</span>` : ''}</button>`;
}

/* 點擊委派。`root` 底下所有星號共用一個監聽器 —— 表格重畫之後還是有效。
   `onChange(next)` 讓那一頁決定要不要整頁重畫(積分榜要、球隊頁不用)。

   **按鈕自己就地更新**,不等 onChange:有些頁不重畫,不更新的話
   使用者點了看起來沒反應,然後會再點一次(等於又切回去)。 */
export function bindFollowStars(root, onChange) {
  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-follow]');
    if (!btn || !root.contains(btn)) return;
    e.preventDefault();
    const [lg, code] = String(btn.dataset.follow).split('|');
    if (!lg || !code) return;
    const { on, saved } = toggleFollow(lg, code);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    const lab = btn.querySelector('.tiny');
    btn.firstChild.nodeValue = on ? '★' : '☆';
    if (lab) lab.textContent = on ? '已關注' : '關注';
    if (!saved) {
      /* localStorage 寫不進去(無痕視窗、擋掉網站資料)。**要講**,
         不然使用者以為關注成功了,下一頁卻什麼都沒有。 */
      btn.title = '這個瀏覽器不讓本站儲存資料(無痕視窗或封鎖了網站資料),關注記不起來';
      btn.classList.add('warn');
    }
    if (typeof onChange === 'function') onChange(readFollows());
  });
}
