/* 模擬遊玩的 2D 跑位動畫(FM 式俯視火柴人)。
 *
 * **這整個模組是程序化演出**,界線在頁面上寫死:
 * - 真資料:陣型(官方逐場陣型的最近一場)、名單與背號、隊色、逐人最高速度與觸球熱區質心;
 *   還有**回合的劇本**——誰開始、誰碰球、在哪裡怎麼結束——由引擎(game-engine.js)產,
 *   裡面的射門座標與射手抽自該隊的真實射門圖。
 * - 演出:球員每一步移動、傳球的路線、無球跑位 —— 本站沒有追蹤座標(誰在哪一秒站哪),
 *   這些是動畫自己編排的戲。FM 的點會動是因為它有自己的比賽引擎;我們的引擎給的是回合,不是座標。
 * - 決定性:所有隨機都走呼叫端給的 rng(種子衍生)—— 同種子重播,連跑位劇本都一樣。
 *
 * ── 2026-09-15 改成「照劇本演」(使用者用問答定的:畫面當主時鐘、回合制) ──
 * 舊版是動畫自己決定誰傳誰、什麼時候丟球,引擎的事件事後排隊追,演的人不是事件裡的人
 * (射門的是隨便一個前鋒、角球主罰是離角旗最近的人),犯規與牌完全不停球 ——
 * 使用者回報「球場動態跟事件不一樣」就是這個。
 *
 * 現在頁面每次拿一個回合交給 `play(seq)`,這裡把它演完:
 *   停球(上一回合的停球時間,即時或快轉)→ 重新開始(開球 / 球門球 / 界外球 / 任意球 / 角球 / 十二碼 / 門將發球)
 *   → 傳球串(劇本裡的人,依序)→ 結局(射門 / 贏得角球 / 被犯規 / 越位 / 出界 / 被斷球 / 二點球)。
 * **事件在畫面上真的發生時才回報**(`onEvent`):球過線才是進球、哨聲才是犯規、旗子舉起才是越位、
 * 球滾過底線才是角球;頁面的事件流、比分、統計全部由回報的事件累計,不讀引擎的預先結果。
 * 演出不可以吞掉劇本:每一段都有逾時(HOP_TIMEOUT / END_TIMEOUT / WATCHDOG),逾時就把球放到該在的人腳下、
 * 該回報的事件照樣回報 —— 寧可演得粗,不能演錯人或漏掉。
 *
 * 播放節奏由頁面用 `mode` 控制:即時(每一腳都演、停球照秒數等)、正常(每回合只演最後幾腳、停球快轉)、
 * 精華(沒結局的回合一格內跳過)。傳球串被剪短時**不剪接**:留第一腳(重新開始那一腳)與最後幾腳,
 * 中間用一記長傳接起來,球從頭到尾看得見。
 *
 * **不引入遊戲引擎是刻意的。** 場上只有 23 個實體、一個 rAF 迴圈,渲染從來不是瓶頸;
 * 真正決定像不像在踢球的是下面這層行為模型(跑位、傳球路線、壓迫),那跟用什麼畫圖無關。
 * 還有一個這個專案特有的理由:畫面越像實況,越暗示「這場就是這樣踢的」,而本站沒有跑位軌跡資料 ——
 * 示意圖比擬真更誠實(鐵則四)。
 */
const FW = 105, FH = 68;          // 球場座標(公尺),畫布再縮放
const PASS_SPEED = 17, LONG_SPEED = 25, SHOT_SPEED = 27;   // 球速上限(公尺/秒);傳球的初速依距離算,到腳邊剩 ARRIVE_SPEED
/* 球的物理(2026-09-03,使用者要求「球不是一直在腳下」):
   球是獨立物體,有速度、有摩擦;持球者只是「該去控球的人」。停球把球往前推一步、
   被搶時球彈開、射門偏了滾出底線變球門球、傳出邊線變界外球、守方解圍出底線才是角球。
   (2026-09-15 起帶球時球黏在腳下,觸球的起伏只是畫面 —— 真的撥出去再追會讓持球者走走停停,見 holderRoute。)
   摩擦是地面球 FRICTION、空中球 AIR;數值是「看起來像」,不是量測值 —— 這一層全是演出。 */
const FRICTION = 5.5, AIR = 1.2;         // 減速(公尺/秒²)
const LAND_KEEP = 0.35;                 // 空中球落地時留多少速度(落地反彈吸掉能量;數值是「看起來像」)
const ARRIVE_SPEED = 4;                 // 傳球到接球者腳邊時剩多少速度
const CONTROL_R = 1.4;                  // 控到球的距離
const TOUCH_AHEAD = [1.0, 1.8];         // 停球往前推多遠
const GOAL_HALF = 3.66;                 // 球門半寬
const LANE_R = 3.4;               // 「站在傳球路線上」的判定半徑(公尺)
const BOX_X = 16.5;               // 禁區深度,定位球站位由它推
const AVOID_R = 4.6;              // 球員進入這個距離才需要繞行(公尺)
const AVOID_MAX = 4.2;            // 避讓只改演出目標,不把球員推到別處(公尺)
const MIN_SEP = 1.6;              // 位置層兜底:兩個人不會比這更近(公尺;圓點半徑約 0.9 m)
/* 劇本的節拍(秒)。這些是演出的上限,不是資料:
   HOP_TIMEOUT  一腳傳球從踢出到接到最多等多久,逾時就把球放到接球者腳下(接球者被擠開、長傳滾不到都會發生)
   END_TIMEOUT  結局那一段(射門飛進網、解圍出底線、越位旗…)最多等多久
   WATCHDOG     整個回合的上限;超過就收尾,該回報的事件照樣回報 —— 演出不可以吞掉劇本(舊版就被一個碰不到的門檻吞過)
   RESTART_PAUSE 重新開始前的停頓(哨聲);RESTART_MAX 等主罰者走到球邊的上限,逾時直接把他放到球邊
   CELEBRATE    進球後的慶祝;HALF_PAUSE 中場換邊的停頓;KICKOFF_SETUP 開球前讓大家站好的時間 */
const HOP_TIMEOUT = 4.0, END_TIMEOUT = 4.0, WATCHDOG = 40;
const RESTART_PAUSE = 0.6, RESTART_MAX = 3.0;
const CELEBRATE = 2.2, HALF_PAUSE = 1.5, KICKOFF_SETUP = 1.0;
const FF_MAX = 12;                // 停球快轉的上限倍率(再快就是瞬移)
/* 無球時的走位(2026-09-15,使用者回報「球員不自然抖動」)。

   舊版每個非持球員的目標點上疊一個正弦「抖動」(±1.4~1.6 m,原意是別讓圓點焊死),
   加上避讓與間距推擠每格重算、上搶者每格重選 —— 無畫布跑 3 分鐘即時量出來:
   真的站著只有 1.6% 的時間、低速時每人每分鐘航向翻轉 2.9 次、4.2% 的五秒視窗在原地打轉。
   那是抖,不是走。改成三件事:
   1. 目標點用的參考球位置走 EMA(BALL_REF_TAU):盤帶每 0.5~0.9 s 把球撥 2~3 m,整條防線跟著一格一格跳;
      濾過之後線是滑的。持球者與上搶者仍追真球。
   2. 閒置的人**走去一個地方再站著**(WANDER):每 3~5 s 在自己的活動範圍內挑一個點走過去,到了就站著,
      沒有來回。點是一次挑好的,不是每格算 —— 每格算就是舊版那個抖。
   3. 死區有遲滯(IDLE_START / IDLE_STOP):離目標不到這麼近就不動。
   避讓只在真的要走時算;站著的人不側步,重疊由 separate() 兜底。上搶者 / 前插者換人加遲滯。
   跑動量的外部對照(pace.distancePerMin)照舊要對得上,見檔頭 SPEED_WALK 那段的校準表。 */
const BALL_REF_TAU = 1.5;          // 參考球位置的平滑時間常數(秒)
/* 閒置的起步 / 停步門檻是**兩個數**(遲滯):目標飄出 IDLE_START 才起步,走到 IDLE_STOP 內才停。
   只有一個門檻的話,站在門檻邊上的人會被會飄的目標一下拉出去一下放回來 —— 第一版用單一 0.6 m,
   量出來低速航向翻轉反而從 3.4 升到 5.3 次/人/分。 */
const IDLE_START = 1.5, IDLE_STOP = 0.4;
const WANDER_EVERY = [3, 5];       // 幾秒換一個閒置走位點
const WANDER_R = 3.0;              // 閒置走位半徑(m)× spreadK
const PRESS_HYST = 2.0, RUN_HYST = 3.0;   // 上搶者 / 前插者換人的遲滯(m):別人要近這麼多才換
/* 閒置的人被人靠近時**自己讓一步**(REPEL):目標點沿連線推開,近到 MIN_SEP 附近時推開的量會超過
   IDLE_START,他就起步走開。沒有這一層的話,讓開的工作全落在 separate() 的硬推上 —— 量出來每人每分鐘
   被推 34 次、中位 5 cm:走著的人被推一下、下一格又轉回來,畫面上就是一顆在發抖的點。 */
const REPEL_R = 2.8, REPEL_K = 2.5;
/* 讓路(YIELD):走著的人前方 YIELD_R 內(前 ±60°)有人就先停下,等他過去再走 —— 量出來走著被推的主因是
   兩隊中場對走互相擠(攻方壓上、守方提線,目標點穿過彼此),推開再走回去、每格重複。真人會等一步。 */
const YIELD_R = 1.9, YIELD_COS = 0.5;
/* 跑動節奏(2026-09-03,錨在 FotMob 追蹤資料):
   - LEAGUE_DIST_PER_MIN:英超一隊每分鐘跑動距離的聯盟均值,約 110 km / 95 分;球隊的 pace.distancePerMin 除以它
     就是「這隊比平均勤多少」,拿去縮放無球跑動的頻率與幅度。逐人再乘 run.distancePerGame 對隊均的比值。
   - 衝刺:每隊每分鐘的衝刺次數(pace.sprintsPerMin,聯盟約 1.1)決定多常出現爆發跑;速度上限按逐人 topSpeed。
   軌跡仍是演出 —— 資料給的是「量」與「在哪一區」,不是誰在哪一秒站哪。 */
const LEAGUE_DIST_PER_MIN = 1160;
const LEAGUE_SPRINTS_PER_MIN = 1.1;
const RUN_RATE = 0.14;            // 每個攻方非持球員每秒起跑的基準機率(× 節奏 × 個人勤勞度);校準見 SPEED_WALK 那段
const RUN_SECONDS = [2.2, 3.6];   // 一次跑動持續多久(秒)

/* 跑動的運動模型(2026-09-12,使用者回報「動作跑動還不真實」)。

   **舊版不是運動模型**,是「位置每格往目標插值一個固定比例」:
   `p.x += (target - p.x) * k`,k ≈ dt × 2.2。速度因此跟「離目標多遠」成正比 ——
   遠的人瞬移、近的人蠕動,而且**完全沒有速度上限**。
   實測(measure-run,ARS vs MCI 種子 42):尖峰 160 ~ 482 m/s(577 ~ 1735 km/h),
   全隊均速 5.6 ~ 6.1 m/s(20 km/h)而且三種播放速度下都一樣 —— 畫面上每個人整場都在衝刺,
   這就是「跑動不真實」的來源。逐人 topSpeed 當時只當成倍率,沒有真的當上限。

   現在每個人有速度向量 (vx, vy):目標速度朝目標點、大小依狀態(走 / 慢跑 / 跑 / 衝刺),
   **上限是他自己的最高速度**(FotMob 逐人 topSpeed,km/h → m/s);現在的速度每格只能改變
   ACCEL × dt(煞車用 DECEL,比起步快),所以轉向要時間、停下要距離。
   接近目標時用 v² = 2·a·d 收速度,不然會繞著目標點打轉。

   數值來源:人類短跑加速度約 6 ~ 8 m/s²、煞車比起步快;走 / 慢跑 / 跑的速度是常見的
   比賽分段(walk < 2、jog 2 ~ 4、run 4 ~ 5.5、sprint > 5.5 m/s)。
   最高速度是真資料,其餘是「看起來像」——**均速有對照組**:每比賽分鐘的跑動距離要對得回
   `pace.distancePerMin`(見檔尾 calibration 註與 `npm test` 那一節)。 */
const ACCEL = 6.5, DECEL = 9.0;              // 加速 / 煞車上限(m/s²)
const SPEED_WALK = 1.05, SPEED_JOG = 2.5, SPEED_RUN = 5.2;   // 走 / 慢跑 / 跑(m/s)
const TOP_SPEED_KMH = 31.5;                  // 沒有逐人 topSpeed 時的預設(km/h,英超中位數附近)
const ARRIVE_R = 0.35;                       // 離目標這麼近就算到了(m)
const FAR_JOG = 9, FAR_RUN = 17;             // 離目標多遠開始慢跑 / 跑回位(m)
const STRIDE_PER_M = 1.15;                   // 每公尺的步頻相位(畫面上的擺動,不是量測值)
/* 步態的左右擺幅(m)。09-12 版是 0.55 m —— 全速時 ±4.8 px、約 2.9 Hz 的左右晃,那正是看起來在「抖」的東西
   (位置層量不到它,因為它只在 draw 裡加;三個指標都說位置沒抖,畫面卻在抖)。真人跑步重心的橫向擺動只有幾公分,
   縮到 0.12 m(全速時約 1 px):看得出腳步,看不出發抖。 */
const SWAY_M = 0.12;
const PUSH_MAX = 0.55;                       // 間距兜底單格最多推多遠(m)
const SPRINT_MS = 7.0;                       // 衝刺門檻(m/s)= 25.2 km/h,FotMob 的定義
const SPRINT_HOLD = 1.0;                     // 持續這麼久才算一次衝刺(秒)
/* 這四個數字(走 / 慢跑 / 回位門檻)與 RUN_RATE 是**校準出來的**,不是挑好看的。

   對照組三個,全部來自 FotMob 的真資料(ARS,每人每比賽分鐘;即時播放 = 一分鐘 60 秒):
     跑動距離 `pace.distancePerMin / 11` ≈ 114 m、衝刺距離 `sprintDistPerMin / 11` ≈ 2.2 m、
     衝刺次數 `sprintsPerMin / 11` ≈ 0.10 次。
   實測(ARS vs MCI,種子 42 / 7 / 1234 平均,scripts 外的量測腳本見變更紀錄):
     | 參數(走/慢跑/門檻/起跑率) | 跑動 | 衝刺距離 | 衝刺次數 | 走·慢跑·跑·衝的時間佔比 |
     | 1.10 / 2.8 / 8-16 / 0.14 | 130 | 3.0 | — | 63/24/12/1 |
     | 0.85 / 2.4 / 9-16 / 0.10 | 107 | 1.9 | 0.15 | 70/20/9/0 |
     | **0.88 / 2.5 / 9-17 / 0.12** | **113** | **2.5** | **0.12** | **68/22/10/0** |
   最後一組三個對照組都落在真資料附近,而且時間佔比接近真實比賽(走 ~70%、慢跑 ~20%、跑 ~7%、衝刺 ~2%)。

   **2026-09-15 重新校準**(去掉正弦抖動、閒置改成走去一個點再站著之後,跑動量掉到 91~101 m/min):
     | 走 / 起跑率 / 閒置走位 | 跑動 | 走·慢跑·跑·衝 | 站著 | 走著被推 |
     | 0.88 / 0.12 / 每 4~8 s 半徑 2.2 | 101 | 73/18/9/1 | 13% | 16.5 次/人/分 |
     | **1.05 / 0.14 / 每 3~5 s 半徑 3.0** | **106**(npm test 的台子 110) | **72/18/9/1** | **15%** | **5.8** |
   走的速度 1.05 m/s 在真人步行速度範圍(1.0~1.4);站著的比例是新的指標 —— 舊版 1.6%,沒有人真的站過。
   改成照劇本演之後(同一天稍晚)用引擎真的產回合、即時模式跑 3 分鐘再量一次,數字在 `npm test` 那一節印出來。

   **一個誠實界線**:只有「即時」那一檔的絕對值對得上。播放速度壓縮時,
   比賽時鐘比畫面上的足球跑得快 —— 動畫仍然是真人速度,但一個回合只演最後幾腳。
   頁面上要講這件事,不要讓讀者以為壓縮播放時的跑動量也是真的。 */

// 陣型字串 → 各排人數。認不得就退 4-4-2(呼叫端標「推估」)
export function parseFormation(label) {
  const rows = String(label ?? '').split('-').map(Number).filter(n => Number.isFinite(n) && n > 0);
  const sum = rows.reduce((a, b) => a + b, 0);
  return sum === 10 ? rows : [4, 4, 2];
}

// 陣型 → 11 個基準點(home 視角:攻向右邊)。GK 之外各排由後往前均分
export function slotsOf(rows) {
  const out = [{ x: 5, y: FH / 2, role: 'GK' }];
  const xs = rows.map((_, i) => 16 + (i * (34 - 16 * 0.4)) / Math.max(1, rows.length - 1) * 1.35);
  rows.forEach((n, i) => {
    for (let k = 0; k < n; k++) {
      out.push({ x: xs[i], y: (FH * (k + 1)) / (n + 1), role: i === 0 ? 'DEF' : i === rows.length - 1 ? 'FWD' : 'MID' });
    }
  });
  return out;
}

/*
 * 球員彼此接近時沿切線繞行，而不是把人硬推開。這是純幾何的目標偏移:
 * 不讀比分、不讀劇本，也不改 holder，所以避讓只能改畫面路線。
 * pairIndex 讓同一對球員選到同一側的切線，避免兩人互相閃到相反方向。
 */
export function avoidanceOf(player, target, players, pairIndex) {
  const tx = target.x - player.x;
  const ty = target.y - player.y;
  let ax = 0, ay = 0;
  const indexOf = p => {
    const i = players.indexOf(p);
    return i < 0 ? 0 : i;
  };
  const i = pairIndex ?? indexOf(player);
  for (const other of players) {
    if (other === player) continue;
    const dx = other.x - player.x;
    const dy = other.y - player.y;
    const d = Math.hypot(dx, dy);
    if (!Number.isFinite(d) || d >= AVOID_R) continue;
    const closing = tx * dx + ty * dy;
    if (closing <= 0 && d > 2.2) continue;
    const j = indexOf(other);
    const weight = Math.max(0, (AVOID_R - d) / AVOID_R);
    // 對兩人使用同一個世界方向的切線，才能並肩繞過，而非相撞後分開。
    const side = i < j ? 1 : -1;
    ax += (-dy / Math.max(d, 0.001)) * side * weight;
    ay += (dx / Math.max(d, 0.001)) * side * weight;
  }
  const mag = Math.hypot(ax, ay);
  if (!mag) return { x: 0, y: 0 };
  const scale = Math.min(AVOID_MAX, mag * AVOID_MAX);
  return { x: (ax / mag) * scale, y: (ay / mag) * scale };
}

/* 停球類的起點(哨聲之後重新開始);其餘(斷球反擊 / 二點球 / 門將發球)是連續的,球不停。跟引擎同一張表。 */
const STOPPAGES = new Set(['kickoff', 'goalkick', 'throwin', 'freekick', 'corner', 'penalty']);
export const isStoppage = type => STOPPAGES.has(type);

/* 測試用的內部狀態出口(唯讀快照,外面改不到東西)。
   這個模組會出的錯是「演出把腳本吞掉」那一類 —— 掃原始碼掃不出來,
   要真的跑一遍再看內部狀態。指向最後一次掛載的那個實例。 */
let probe = () => null;
export const __animProbe = () => probe();

export function mountDuelAnim(canvas, { home, away, homeCode = '', awayCode = '', rng }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pad = 26;
  const sx = x => pad + (x / FW) * (W - pad * 2);
  const sy = y => pad + (y / FH) * (H - pad * 2);
  const clampPt = (x, y) => ({ x: Math.max(2, Math.min(FW - 2, x)), y: Math.max(2, Math.min(FH - 2, y)) });

  const mkTeam = (side, spec) => {
    const rows = parseFormation(spec.formation);
    const slots = slotsOf(rows);
    const names = spec.xi ?? { GK: [], DEF: [], MID: [], FWD: [] };
    const used = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    const meta = spec.meta ?? {};               // name → { role, heat, run }
    const pace = spec.pace ?? null;
    const paceFactor = pace?.distancePerMin ? Math.max(0.7, Math.min(1.4, pace.distancePerMin / LEAGUE_DIST_PER_MIN)) : 1;
    const teamDist = (() => {
      const ds = Object.values(meta).map(m => m?.run?.distancePerGame).filter(Number.isFinite);
      return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null;
    })();
    return slots.map(s => {
      const idx = used[s.role]++;
      const name = names[s.role]?.[idx] ?? null;
      const shirt = spec.shirts?.[s.role]?.[idx] ?? null;
      const code = spec.codes?.[s.role]?.[idx] ?? null;   // 引擎的球員代碼:劇本用它指名誰碰球
      const m = name ? meta[name] ?? null : null;
      /* 基準點:陣型格與**真實觸球熱區質心**各一半(熱區是兩隊都向右進攻的座標,客隊鏡射 x)。
         全用熱區的話陣型會糊掉(邊後衛的質心常在中場),全用陣型格又跟這個人平常站哪無關 —— 各一半。
         離散度決定他平常活動範圍多大(閒置走位的幅度)。 */
      let bx = side === 'home' ? s.x : FW - s.x;   // 上半場的基準;下半場鏡射(真足球會換邊)
      let by = s.y;
      if (m?.heat && s.role !== 'GK') {
        const hx = side === 'home' ? m.heat.cx : FW - m.heat.cx;
        bx = bx * 0.5 + hx * 0.5; by = by * 0.5 + m.heat.cy * 0.5;
      }
      const spreadK = m?.heat?.spread ? Math.max(0.6, Math.min(1.6, m.heat.spread / 25)) : 1;
      const act = (m?.run?.distancePerGame && teamDist) ? Math.max(0.7, Math.min(1.3, m.run.distancePerGame / teamDist)) : 1;
      const topSpeed = m?.run?.topSpeed ?? null;
      return { side, role: s.role, sub: m?.role ?? null, name, shirt, code, off: false, flash: 0, cardT: 0,
        bx0: bx, by, x: bx, y: by,
        spreadK, act: act * paceFactor, topSpeed, run: null,
        /* dist / vmax 是**量出來的**,不是設定值:跑動量與尖峰速度要能對回 FotMob 的
           `pace.distancePerMin` 與逐人 `run.topSpeed`,不然「節奏錨在真資料」這句話沒有人驗過。 */
        dist: 0, vmax: 0,
        /* 速度分段的時間與距離(<2 走、2~4 慢跑、4~7 跑、>7 衝刺 m/s)。
           分界 7.0 m/s = 25.2 km/h 是 FotMob 的衝刺門檻 —— 用它才對得回 `pace.sprintDistPerMin`
           與 `pace.sprintsPerMin` 這兩個真資料。sprints 數的是「進入衝刺帶幾次」。 */
        bandT: [0, 0, 0, 0], bandD: [0, 0, 0, 0], sprints: 0, sprintT: 0,
        vx: 0, vy: 0, stride: rng() * Math.PI * 2,
        // 他自己的最高速度(m/s)。FotMob 的 topSpeed 是 km/h;沒有資料的用聯盟中位數附近
        vtop: (topSpeed ?? TOP_SPEED_KMH) / 3.6,
        ph: rng() * Math.PI * 2, color: spec.color };
    });
  };
  const paceOf = side => (side === 'home' ? home : away).pace ?? null;
  const zonesOf = side => (side === 'home' ? home : away).zones ?? null;
  /* 三路偏向:該隊右路佔比減左路佔比(0~1),乘 12 m 當攻方整體往那一側偏的量。座標跟熱區同一套(x 鏡射、y 不翻),
     所以「右」在畫面上是 y 大的那一側,兩隊一致。 */
  const flankShift = side => { const z = zonesOf(side); return z ? (z.right - z.left) * 12 : 0; };
  const players = [...mkTeam('home', home), ...mkTeam('away', away)];
  const active = () => players.filter(p => !p.off);   // 被罰下的人不在場上
  const other = side => (side === 'home' ? 'away' : 'home');

  // 戲的狀態
  let st = { min: 0, extra: null, done: false, hs: 0, as: 0 };
  let half = 1;                      // 下半場換邊(真足球行為)
  let goalsPlayed = 0;
  let pendingKickoff = null;         // 進球之後失球方要開球(下一個回合的起點就是它,這裡只記著給站位用)
  const baseX = p => (half === 1 ? p.bx0 : FW - p.bx0);
  const dirOf = side => (side === 'home' ? 1 : -1) * (half === 1 ? 1 : -1);
  const goalX = side => (dirOf(side) === 1 ? FW : 0);        // 這一隊要攻的球門
  const ownGoalX = side => (dirOf(side) === 1 ? 0 : FW);
  let holder = players.find(p => p.side === 'home' && p.role === 'MID') ?? players[0];
  /* held:球在持球者腳下;不然就是自由球(飛行 / 滾動 / 靜止),holder 是要去控它的人。
     lastSide:最後碰球的是哪一隊 —— 出界時決定是界外球 / 球門球 / 角球。
     out:剛出界的紀錄(物理層寫、劇本讀),劇本靠它知道「球真的滾過線了」。 */
  const ball = { x: FW / 2, y: FH / 2, vx: 0, vy: 0, held: true, lastSide: 'home', loft: 0, inNet: false, cut: null, noCatch: false, out: null };
  /* noCatch:這顆球注定要出界(射偏、解圍出底線、傳歪出邊線),出界前誰都不准把它控回來 ——
     不然解圍的人站在球邊,下一格就把球又控住,角球永遠演不出來(實測兩次角球計數 0)。 */
  const counts = { throwIns: 0, goalKicks: 0, corners: 0, tackles: 0 };   // 物理層數到的出界(給測試與畫面)
  let push = 0;                     // 控球方整條線往前壓的量
  const ballRef = { x: FW / 2, y: FH / 2 };   // 目標點用的參考球位置(EMA,見 BALL_REF_TAU)
  let simT = 0;                     // 模擬時鐘。走位不要吃 performance.now(),
                                    // 那是牆上時間,會讓「同種子同劇本」這句話不成立
  let presser = null, runner = null;   // 上搶的人、前插支援的中場(每格重算,有遲滯)
  let setPiece = null;              // 停球期間的站位規則(kickoff / corner / freekick / penalty / goalkick / throwin)
  let caption = null;               // 畫面上的一行字(結局:犯規、越位、被撲出…)
  let script = null;                // 正在演的回合(見 play)
  let paused = false;
  const performed = [];             // 演出紀錄(測試用):誰射門 / 進球 / 傳出越位球,對回事件裡的人
  const timeouts = { hop: 0, end: 0, restart: 0, fetch: 0, watchdog: 0 };   // 逾時補救的次數:演出對不上劇本的量尺
  const timeoutLog = [];            // 逾時當下的距離與球速(前 40 筆),校準用
  const phaseSecs = {};             // 每個階段(含子階段)累計的模擬秒數

  /* 踢球:從球現在的位置朝 (tx,ty) 給一個初速。傳球的初速依距離算,讓球到目標點時剩 ARRIVE_SPEED
     (v0² = v1² + 2·a·d);射門與解圍直接給速度。loft > 0 是空中球(摩擦小、畫大一點)。
     長傳(超過 24 m)自動改成空中球:地面球的初速上限 17 m/s 在 5.5 m/s² 的摩擦下只滾得了 26 m,
     劇本剪短之後一記長傳常常 40~60 m,不吊起來會停在半路。 */
  function kick(tx, ty, { speed = null, loft = 0, by = holder } = {}) {
    const dx = tx - ball.x, dy = ty - ball.y, d = Math.max(0.3, Math.hypot(dx, dy));
    let v = speed, lf = loft;
    if (v == null) {
      if (d > 24) {
        /* 長傳:空中飛 d / v 秒、落地時剩 LAND_KEEP 的速度再滾幾公尺。loft 每秒掉 0.6,所以 loft = 0.6 × 飛行秒數。
           一顆 50 m 的球約 2.2 s 到,跟真的長傳差不多。 */
        v = Math.max(14, Math.min(LONG_SPEED, d / 2.2));
        lf = Math.max(lf, Math.min(1.4, 0.6 * (d / v)));
      } else v = Math.min(PASS_SPEED, Math.sqrt(ARRIVE_SPEED ** 2 + 2 * FRICTION * d));
    }
    ball.vx = (dx / d) * v; ball.vy = (dy / d) * v;
    ball.held = false; ball.loft = lf; ball.cut = null; ball.inNet = false; ball.noCatch = false; ball.out = null;
    if (by) ball.lastSide = by.side;
  }
  const speedOf = () => Math.hypot(ball.vx, ball.vy);
  function placeBall(x, y) {
    ball.x = x; ball.y = y; ball.vx = 0; ball.vy = 0; ball.held = false; ball.loft = 0; ball.inNet = false; ball.cut = null; ball.noCatch = false; ball.out = null;
  }
  /* 把球放到某人腳下(重新開始、逾時補救)。跟 kick 相反:這是「演出對不上就把球送到該在的地方」。 */
  function snapBallTo(p) {
    holder = p;
    ball.x = p.x + dirOf(p.side) * 0.7; ball.y = p.y;
    ball.vx = 0; ball.vy = 0; ball.held = true; ball.loft = 0; ball.inNet = false; ball.cut = null; ball.noCatch = false; ball.out = null; ball.lastSide = p.side;
  }
  /* 傳給隊友:提前量 = 他要跑去的地方(劇本指定的接球點)再往前一點,沒有在跑的人就傳到腳前 */
  function passTo(p, opts = {}) {
    let tx, ty;
    if (p.run && p.run.scripted) {
      const dx = p.run.tx - p.x, dy = p.run.ty - p.y, d = Math.hypot(dx, dy);
      const k = d > 1e-6 ? Math.min(1, 6 / d) : 0;
      tx = p.x + dx * k; ty = p.y + dy * k;
    } else { tx = p.x + dirOf(p.side) * 1.5; ty = p.y; }
    kick(tx, ty, opts);
    holder = p;
  }
  const nearestOf = (side, x, y, exclude = []) => active().filter(p => p.side === side && p.role !== 'GK' && !exclude.includes(p))
    .reduce((a, b) => (Math.hypot(b.x - x, b.y - y) < Math.hypot(a.x - x, a.y - y) ? b : a));
  /* 引擎的座標是「這一隊的進攻座標」(攻向 x = 105);畫面上客隊可能攻向左邊 → 整個轉 180°(x、y 都翻),
     跟引擎換邊時的 flipXY 是同一個轉換,所以兩隊的同一個物理點會落在畫面上同一個地方。 */
  const toAnim = (x, y, side) => (dirOf(side) === 1 ? { x, y } : { x: FW - x, y: FH - y });
  const byCode = (side, code) => (code == null ? null : active().find(p => p.side === side && p.code === code) ?? null);
  /* 劇本裡的人在畫面上找不到(名單沒給代碼、或已被罰下)時退回同隊離球最近的人 —— 寧可演錯位置也不要卡住;
     測試守的「演的人就是事件裡的人」只在名單有代碼時成立。門將類的起點退回門將。 */
  function resolve(side, code, { gk = false } = {}) {
    return byCode(side, code) ?? (gk ? active().find(p => p.side === side && p.role === 'GK') : null) ?? nearestOf(side, ball.x, ball.y);
  }

  /* 傳球路線上離球最近的對手,連同「在哪一點被切斷」。被封阻的射門用它決定是誰擋的。 */
  function laneCut(from, to, side) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len2 = dx * dx + dy * dy || 1;
    let best = null;
    for (const o of active()) {
      if (o.side === side || o.role === 'GK') continue;
      const u = Math.max(0.08, Math.min(0.92, ((o.x - from.x) * dx + (o.y - from.y) * dy) / len2));
      const px = from.x + dx * u, py = from.y + dy * u;
      const d = Math.hypot(o.x - px, o.y - py);
      if (!best || d < best.d) best = { o, d, x: px, y: py };
    }
    return best;
  }

  /* ── 劇本 ───────────────────────────────────────────
     play(seq):引擎的一個回合。opts:
       pre        這個回合開始前(停球期間)要先做的事件:換人、開賽標記 —— 立刻做、立刻回報
       post       回合結束後的標記(中場 / 完場)—— 演完才回報
       deadBefore 上一回合的停球秒數(引擎的),停球期間依 mode 即時或快轉
       mode       { instant, hops, carrySec, fill, deadSec, celebrateSec }:頁面依播放速度給
       onEvent / onNote / onDone */
  function play(seq, { pre = [], post = [], deadBefore = 0, mode = {}, onEvent = () => {}, onNote = () => {}, onDone = () => {} } = {}) {
    const s = seq.side, o = other(s);
    // 下半場換邊:場景切換(鏡射、速度歸零),不是一段跑動 —— 不鏡射的話 22 個人一起橫越球場十秒,還被算成跑動
    let halfSwitch = false;
    if (seq.half === 2 && half === 1) {
      half = 2; halfSwitch = true;
      for (const p of players) { p.x = FW - p.x; p.px = p.x; p.vx = 0; p.vy = 0; p.run = null; p.wander = null; }
      ballRef.x = FW - ballRef.x;
    }
    const S = toAnim(seq.start.x, seq.start.y, s), E = toAnim(seq.end.x, seq.end.y, s);
    script = { seq, s, o, S, E, pre, post, mode, onEvent, onNote, onDone, phase: null, sub: null, t: 0, t0: simT, playT: 0, planned: 1,
      deadBefore, deadSec: 0, ff: 1, emitted: new Set(), halfSwitch, hops: [], hopIdx: 0, actor: null, taker: null, carryTo: null, carrySec: 0.5, carryMax: 2, by: null, afterSec: 0 };
    // 停球期間先做的事:換人(圓點改名)、開賽標記
    for (const e of pre) { if (e.type === 'sub') applySub(e); emit(e); }
    if (mode.instant) { script.phase = 'instant'; return; }   // step() 裡一格內做完
    const taker = resolve(s, seq.start.player, { gk: seq.start.type === 'goalkick' || seq.start.type === 'keeper' });
    script.taker = taker;
    script.cut = mode.cut === true;   // 壓縮播放:太遠的人可以直接放到該在的地方(剪接);即時模式不剪
    const chainP = seq.chain.map(c => byCode(s, c)).filter(Boolean);
    planChain(chainP);
    const stoppage = isStoppage(seq.start.type);
    if (stoppage) {
      placeBall(S.x, S.y); holder = taker; setPiece = seq.start.type;
      pendingKickoff = seq.start.type === 'kickoff' ? s : null;
      if (script.cut) cutTo(taker, S.x - dirOf(s) * 1.2, S.y, 12);
    } else if (seq.start.type === 'loose') {
      /* 二點球:球在物理層停的地方(被封阻彈開、沒控好滾開)就是它;只有球還在別人腳下時才擺到劇本的位置 */
      if (ball.held) placeBall(S.x, S.y);
      holder = taker; setPiece = null;
      if (script.cut) cutTo(taker, ball.x - dirOf(s) * 3, ball.y, 12);
    } else { setPiece = null; holder = taker; if (script.cut && !ball.held) cutTo(taker, ball.x - dirOf(s) * 2, ball.y, 12); }   // 斷球反擊 / 門將發球:球本來就在那個人腳下(上一回合的結局給的);不在就去撿(fetch)
    for (const p of active()) if (p.run?.scripted) p.run = null;
    const deadSec = stoppage ? Math.max(mode.deadSec ?? deadBefore, halfSwitch ? HALF_PAUSE : seq.start.type === 'kickoff' ? KICKOFF_SETUP : 0) : 0;
    script.deadSec = deadSec;
    script.ff = deadSec > 0 ? Math.max(1, Math.min(FF_MAX, deadBefore / deadSec)) : 1;
    if (deadSec > 0) script.phase = 'dead';
    else if (stoppage) script.phase = 'restart';
    else if (ball.held && holder === taker) { script.phase = 'chain'; beginHop(); }
    else script.phase = 'fetch';
    script.t = 0;
  }

  /* 剪接:把人放到 (x, y) 附近 —— 只在他離那裡超過 far 公尺時,而且只有壓縮播放會叫它 */
  function cutTo(p, x, y, far) {
    if (!p || Math.hypot(p.x - x, p.y - y) <= far) return;
    /* 放到附近**沒有人的**一點:直接放在 (x, y) 會疊到別人身上,separate() 一格只推 0.55 m,
       要好幾格才分開 —— 測試量到壅擠畫格與最小間距都紅。先看目標點,再看 2 m 半徑上的八個點,挑離大家最遠的。 */
    let best = null;
    for (let i = -1; i < 8; i++) {
      const c = i < 0 ? clampPt(x, y) : clampPt(x + Math.cos(i * Math.PI / 4) * 2.2, y + Math.sin(i * Math.PI / 4) * 2.2);
      let dmin = Infinity;
      for (const o of active()) if (o !== p) dmin = Math.min(dmin, Math.hypot(o.x - c.x, o.y - c.y));
      if (!best || dmin > best.dmin) best = { c, dmin };
      if (dmin >= MIN_SEP + 0.3) break;
    }
    p.x = best.c.x; p.y = best.c.y; p.vx = 0; p.vy = 0; p.px = p.x; p.py = p.y;
  }
  /* 傳球串 → 要演的幾腳。剪短時**不剪接**:留第一腳(重新開始那一腳)與最後幾腳,中間用一記長傳接起來。
     接球點沿「起點 → 結局點」等分,橫向一半靠自己習慣的縱線,所以推進看起來有方向、又不是一條直線。 */
  function planChain(chainP) {
    const { seq, S, E, mode } = script;
    const keep = mode.hops ?? Infinity;
    let raw = [];
    for (let i = 0; i + 1 < chainP.length; i++) if (chainP[i] !== chainP[i + 1]) raw.push({ from: chainP[i], to: chainP[i + 1] });
    // 越位:最後一腳(傳給越位的人)是結局那一段演的,不算傳球串
    if (seq.end.type === 'offside' && raw.length) raw = raw.slice(0, -1);
    let hops = raw;
    if (raw.length > keep) {
      const last = raw[raw.length - 1];
      if (keep <= 0) hops = [];
      else if (keep === 1) hops = [{ from: raw[0].from, to: last.to }];
      else if (keep === 2) hops = [raw[0], { from: raw[0].to, to: last.to }];
      else { const tail = raw.slice(raw.length - (keep - 2)); hops = [raw[0], { from: raw[0].to, to: tail[0].from }, ...tail]; }
      hops = hops.filter(h => h.from !== h.to);
    }
    const n = hops.length;
    const L = Math.hypot(E.x - S.x, E.y - S.y);
    const fLast = L > 6 ? 1 - 5 / L : 1;   // 最後一腳落在結局點前 5 m
    hops.forEach((h, j) => {
      const f = n === 1 ? fLast : (fLast * (j + 1)) / n;
      const lx = S.x + (E.x - S.x) * f, ly = S.y + (E.y - S.y) * f;
      const pt = clampPt(lx, j === n - 1 ? ly : ly * 0.55 + h.to.by * 0.45);
      h.tx = pt.x; h.ty = pt.y;
    });
    script.hops = hops; script.hopIdx = 0;
    script.actor = chainP.length ? chainP[chainP.length - 1] : null;
    // 演出時間的估計(給時鐘用):每一腳 = 帶球 + 飛行約 1 s;結局約 2 s。即時模式用 fill(引擎的回合秒數)把帶球拉長
    const carry = mode.carrySec ?? (mode.fill != null ? Math.max(0.3, Math.min(6, (mode.fill - n * 1.0 - 2) / Math.max(1, n))) : 0.5);
    script.carrySec = carry;
    script.planned = Math.max(1, n * (carry + 1.0) + 2);
  }

  function applySub(e) {
    const p = byCode(e.side, e.off) ?? active().find(p => p.side === e.side && p.name === e.offName);
    if (!p) return;
    p.name = e.onName; p.shirt = e.onShirt ?? null; p.code = e.on; p.flash = 1.5; p.flashColor = '#00ff85';
  }
  /* 回報事件。每一筆只回報一次;比分板從進球事件讀。 */
  function emit(e) {
    if (!script || script.emitted.has(e)) return;
    script.emitted.add(e);
    if (e.type === 'goal' && e.score) { st.hs = e.score[0]; st.as = e.score[1]; }
    if (e.type === 'card') {
      const p = byCode(e.side, e.player);
      if (p) {
        p.flash = 2.0; p.flashColor = e.card === 'red' ? '#ff3b3b' : '#ffd400'; p.cardT = 2.0; p.cardColor = p.flashColor;
        if (e.card === 'red') { p.off = true; if (holder === p) holder = nearestOf(p.side, ball.x, ball.y); }
      }
    }
    script.onEvent(e);
  }
  function flushEvents() { for (const e of script.seq.events) emit(e); }
  const note = n => script?.onNote({ side: script.s, seq: script.seq.id, ...n });

  /* ── 逐格推進劇本 ── */
  function step(dt) {
    if (!script) { moveAll(dt); return; }
    if (script.phase === 'instant') { finishInstant(); return; }
    const key = script.phase + (script.sub ? ':' + script.sub : '');
    phaseSecs[key] = (phaseSecs[key] ?? 0) + dt;
    switch (script.phase) {
      case 'dead': {
        // 停球:快轉 = 一格裡走 ff 次(每次仍是真 dt,運動模型不用吃大步)
        const n = Math.max(1, Math.round(script.ff));
        for (let i = 0; i < n; i++) moveAll(dt);
        script.t += dt;
        if (script.t >= script.deadSec) { script.phase = 'restart'; script.t = 0; }
        break;
      }
      case 'restart': {
        moveAll(dt); script.t += dt;
        const near = Math.hypot(holder.x - ball.x, holder.y - ball.y) < 1.6;
        if (script.t >= RESTART_PAUSE && (near || script.t > RESTART_MAX)) {
          if (!near) { timeouts.restart++; holder.x = ball.x - dirOf(holder.side) * 0.8; holder.y = ball.y; holder.vx = 0; holder.vy = 0; }
          snapBallTo(holder); setPiece = null;
          takeRestart();
        }
        break;
      }
      case 'fetch': {   // 二點球 / 剛換手的球:指定的人跑去控住它
        moveAll(dt); script.t += dt;
        if (ball.held && holder === script.taker) { script.phase = 'chain'; beginHop(); }
        else if (script.t > HOP_TIMEOUT) { timeouts.fetch++; snapBallTo(script.taker); script.phase = 'chain'; beginHop(); }
        break;
      }
      case 'chain': moveAll(dt); script.t += dt; script.playT += dt; chainStep(); break;
      case 'end': moveAll(dt); script.t += dt; script.playT += dt; endStep(); break;
      case 'after': moveAll(dt); script.t += dt; if (script.t >= script.afterSec) finishSeq(); break;
      default: moveAll(dt);
    }
    // 回合看門狗:不管演到哪,超過 WATCHDOG 秒就收尾(該回報的事件照樣回報)
    if (script && script.phase !== 'after' && script.phase !== 'instant' && simT - script.t0 > Math.max(WATCHDOG, (script.mode.fill ?? 0) + script.deadSec + 25)) {
      timeouts.watchdog++;
      if (script.seq.end.type === 'shot' && script.seq.end.outcome === 'goal') { const gx = goalX(script.s); ball.x = gx + dirOf(script.s) * 1; ball.y = FH / 2; ball.inNet = true; ball.vx = 0; ball.vy = 0; ball.held = false; goalsPlayed++; }
      beginAfter();
    }
  }

  /* 重新開始那一腳:主罰者把球送給第一個接球的人。沒有傳球串(十二碼、直接任意球、一個人的回合)就直接進結局。 */
  /* 接球的人先跑向接球點;壓縮播放時離得太遠就剪接到附近(不然一記長傳落地時他還在 30 m 外,只能等逾時) */
  function readyReceiver(h) {
    if (script.cut) cutTo(h.to, h.tx - dirOf(h.to.side) * 4, h.ty, 15);
    h.to.run = { tx: h.tx, ty: h.ty, t: 99, sprint: false, scripted: true };
  }
  function takeRestart() {
    const { seq, hops } = script;
    const h = hops[0];
    if (!h) { beginEnd(); return; }
    readyReceiver(h);
    const t = seq.start.type;
    if (t === 'throwin') passTo(h.to, { speed: 9, loft: 0.6 });
    else if (t === 'corner') kick(h.tx, h.ty, { loft: 1.0 });
    else passTo(h.to);
    holder = h.to;
    note({ kind: 'restart', type: t, player: script.taker?.name ?? null });
    script.phase = 'chain'; script.sub = 'flight'; script.t = 0;
  }
  function beginHop() {
    const h = script.hops[script.hopIdx];
    if (!h) { beginEnd(); return; }
    script.sub = 'carry'; script.t = 0;
    if (holder !== h.from && ball.held) { /* 傳球串的人跟畫面對不上(被罰下等):讓現在拿球的人代替 */ h.from = holder; }
    readyReceiver(h);
    // 帶球點:朝接球點的方向 4 m(門將不帶球,原地等)
    const ang = Math.atan2(h.ty - holder.y, h.tx - holder.x);
    script.carryTo = holder.role === 'GK' ? { x: holder.x, y: holder.y } : clampPt(holder.x + Math.cos(ang) * 4, holder.y + Math.sin(ang) * 4);
  }
  function chainStep() {
    const h = script.hops[script.hopIdx];
    if (!h) { beginEnd(); return; }
    if (script.sub === 'carry') {
      if (!ball.held) { if (script.t > HOP_TIMEOUT) { timeouts.hop++; snapBallTo(h.from); } return; }
      const d = Math.hypot(script.carryTo.x - holder.x, script.carryTo.y - holder.y);
      if (script.t >= script.carrySec || (d < 1.0 && script.t >= 0.25)) { passTo(h.to); script.sub = 'flight'; script.t = 0; }
    } else if (ball.held && holder === h.to) { h.to.run = null; script.hopIdx++; beginHop(); }
    else if (script.t > HOP_TIMEOUT) {
      timeouts.hop++;
      if (timeoutLog.length < 40) timeoutLog.push({ kind: 'hop', d: Math.round(Math.hypot(ball.x - h.to.x, ball.y - h.to.y) * 10) / 10, v: Math.round(speedOf() * 10) / 10, held: ball.held, holderIsTo: holder === h.to, noCatch: ball.noCatch, out: ball.out?.kind ?? null, loft: Math.round(ball.loft * 10) / 10,
        role: h.to.role, off: h.to.off, sp: Math.round(Math.hypot(h.to.vx, h.to.vy) * 10) / 10, px: Math.round(h.to.x), py: Math.round(h.to.y), bx: Math.round(ball.x), by: Math.round(ball.y), run: h.to.run ? [Math.round(h.to.run.tx), Math.round(h.to.run.ty)] : null, start: script.seq.start.type, hop: script.hopIdx + '/' + script.hops.length });
      h.to.run = null; snapBallTo(h.to); script.hopIdx++; beginHop();
    }
  }

  /* ── 結局 ── */
  function beginEnd() {
    const { seq, s, o, E } = script; const dir = dirOf(s); const end = seq.end;
    script.phase = 'end'; script.sub = 'carry'; script.t = 0;
    const actor = script.actor ?? holder;
    if (holder !== actor || !ball.held) snapBallTo(actor);
    for (const p of active()) if (p.run?.scripted) p.run = null;
    // 壓縮播放:結局的人離結局點太遠就剪接到 6 m 外(不然沒有傳球串的回合要帶球半場)
    if (script.cut && ['shot', 'corner', 'foul', 'out'].includes(end.type)) { cutTo(actor, E.x - dir * 4, E.y, 9); snapBallTo(actor); }
    switch (end.type) {
      case 'shot': script.carryTo = clampPt(E.x, E.y); script.carryMax = script.cut ? 1.8 : 2.5; break;
      case 'corner': script.carryTo = clampPt(E.x - dir * 9, E.y + (E.y < FH / 2 ? 7 : -7)); script.carryMax = 2.0; break;
      case 'foul': script.by = resolve(o, end.by); script.by.run = null; script.carryTo = clampPt(E.x, E.y); script.carryMax = 2.5;
        if (script.cut) cutTo(script.by, E.x + dir * 5, E.y + (rng() - 0.5) * 6, 10); break;
      case 'offside': {
        script.passer = resolve(s, end.passer);
        script.off = resolve(s, end.player);
        if (script.off === script.passer) script.off = nearestOf(s, E.x, E.y, [script.passer]);
        if (holder !== script.passer) snapBallTo(script.passer);
        script.carryTo = clampPt(holder.x + dir * 2, holder.y); script.carryMax = 0.8;
        script.off.run = { tx: E.x, ty: E.y, t: 99, sprint: true, scripted: true };
        break;
      }
      case 'out': script.carryTo = end.kind === 'throwin' ? clampPt(E.x, E.y < FH / 2 ? 4 : FH - 4) : clampPt(E.x - dir * 4, E.y); script.carryMax = 1.5; break;
      case 'loose': script.carryTo = clampPt(holder.x + dir * 2, holder.y); script.carryMax = 0.6; break;
      case 'turnover': script.by = resolve(o, end.by); script.by.run = { tx: E.x, ty: E.y, t: 99, sprint: false, scripted: true }; script.carryTo = clampPt(holder.x + dir * 3, holder.y); script.carryMax = 0.7;
        if (script.cut) cutTo(script.by, E.x + dir * 4, E.y + (rng() - 0.5) * 6, 14); break;
      default: script.carryTo = { x: holder.x, y: holder.y }; script.carryMax = 0.3;
    }
  }
  function endStep() {
    const { seq, s, o, E } = script; const end = seq.end;
    if (script.sub === 'carry') {
      if (end.type === 'foul') {
        const by = script.by;
        const contact = by && Math.hypot(by.x - ball.x, by.y - ball.y) < 1.5 && script.t > 0.3;
        if (contact || script.t > script.carryMax + 1.5) whistleFoul();
        return;
      }
      const d = Math.hypot(script.carryTo.x - holder.x, script.carryTo.y - holder.y);
      if (!ball.held) { if (script.t > HOP_TIMEOUT) snapBallTo(script.actor ?? holder); return; }
      if (d < 1.0 || script.t >= script.carryMax) doEndAction();
      return;
    }
    if (script.sub === 'cards') { if (script.t >= 0.8) { for (const e of script.cards) emit(e); beginAfter(); } return; }
    // sub === 'ball':等球到該到的地方
    switch (end.type) {
      case 'shot': shotResolve(); break;
      case 'corner':
        if (ball.out) { setCaption('角球', ball.x, ball.y); emit(seq.events.find(e => e.type === 'corner')); beginAfter(); }
        else if (script.clearer && !script.cleared && ball.held && holder === script.clearer) clearOut();
        else if (script.t > END_TIMEOUT) { counts.corners++; setCaption('角球', E.x, E.y); beginAfter(); }
        break;
      case 'offside':
        if ((ball.held && holder === script.off) || Math.hypot(ball.x - E.x, ball.y - E.y) < 1.5 || speedOf() < 0.5 || script.t > END_TIMEOUT) {
          const off = script.off; off.run = null;
          ball.vx = 0; ball.vy = 0; ball.held = false; ball.noCatch = false;
          setCaption('越位', ball.x, ball.y);
          emit(seq.events.find(e => e.type === 'offside'));
          beginAfter();
        }
        break;
      case 'out':
        if (ball.out || script.t > END_TIMEOUT) { note({ kind: 'out', out: end.kind, to: seq.next?.side ?? o }); setCaption(end.kind === 'throwin' ? '界外球' : '球門球', ball.x, ball.y); beginAfter(); }
        break;
      case 'loose':
        if (speedOf() < 0.8 || script.t > 2.5) { note({ kind: 'loose' }); beginAfter(); }
        break;
      case 'turnover':
        if ((ball.held && holder === script.by) || script.t > END_TIMEOUT) {
          if (!(ball.held && holder === script.by)) snapBallTo(script.by);
          script.by.run = null; counts.tackles++;
          note({ kind: 'turnover', by: script.by.name, bySide: o });
          beginAfter();
        }
        break;
      default: beginAfter();
    }
  }
  function doEndAction() {
    const { seq, s, o, E } = script; const dir = dirOf(s); const end = seq.end;
    script.sub = 'ball'; script.t = 0;
    switch (end.type) {
      case 'shot': shoot(end); break;
      case 'corner': {
        // 傳中 / 低平球往球門區,守方離那一點最近的人擋下再解圍出底線 → 物理層判成角球
        const gx = goalX(s), tgt = { x: gx - dir * 4, y: FH / 2 + (E.y < FH / 2 ? -3 : 3) };
        script.clearer = nearestOf(o, tgt.x, tgt.y);
        const c = script.clearer;
        kick(c.x + (tgt.x - c.x) * 0.15, c.y + (tgt.y - c.y) * 0.15, { speed: 15, loft: 0.2 });
        holder = c;
        break;
      }
      case 'offside': performed.push({ type: 'pass', code: holder.code }); kick(E.x, E.y, { loft: 0.5 }); holder = script.off; break;
      case 'out':
        if (end.kind === 'throwin') kick(E.x + dir * 2, E.y < FH / 2 ? -2 : FH + 2, { speed: 10 });
        else kick(goalX(s) + dir * 3, Math.max(2, Math.min(FH - 2, E.y)), { speed: 14, loft: 0.4 });
        ball.noCatch = true; holder = nearestOf(o, E.x, E.y);   // 沒人去撿,它自己滾出去
        break;
      case 'loose': kick(E.x, E.y, { speed: 6 + rng() * 3 }); ball.noCatch = true; break;   // 沒控好,球滾開;下一回合有人去撿
      case 'turnover': kick(E.x + dir * 4, E.y); holder = script.by; break;   // 傳向空檔,被劇本指定的那個人截走
      default: break;
    }
  }
  function clearOut() {
    const { s, o, E } = script; const dir = dirOf(s); const c = script.clearer;
    /* 解圍出底線:目標點在底線外、y 留在場內且在球門外側 —— y 放到邊線外的話球會先碰到邊線變界外球(測試抓過) */
    const gx = goalX(s);
    const ty = Math.max(3, Math.min(FH - 3, E.y < FH / 2 ? Math.min(c.y, FH / 2 - GOAL_HALF - 2) : Math.max(c.y, FH / 2 + GOAL_HALF + 2)));
    kick(gx + dir * 3, ty, { loft: 0.4, by: c });
    ball.lastSide = o; ball.noCatch = true; script.cleared = true;
  }
  function whistleFoul() {
    const { seq } = script;
    ball.held = false; ball.vx = 0; ball.vy = 0; ball.loft = 0;   // 球停在犯規點(任意球就在這裡)
    if (script.by) script.by.run = null;
    setCaption(seq.end.penalty ? '犯規・十二碼' : '犯規', ball.x, ball.y);
    counts.tackles++;
    const ev = seq.events.find(e => e.type === 'foul');
    if (ev) emit(ev);
    const cards = seq.events.filter(e => e.type === 'card');
    if (cards.length) { script.sub = 'cards'; script.cards = cards; script.t = 0; } else beginAfter();
  }
  /* 射門:結果是劇本給的(引擎用該射門的 xG 抽的)。演出只負責讓球飛到對的地方:
     進球飛進網、被撲飛向門將、被封打在最近的防守者身上、射偏過底線、中柱反彈。 */
  function shoot(end) {
    const { s, o } = script; const dir = dirOf(s), gx = goalX(s);
    performed.push({ type: end.outcome === 'goal' ? 'goal' : 'shot', code: holder.code, outcome: end.outcome });
    script.shooter = holder;
    const gk = active().find(p => p.side === o && p.role === 'GK');
    if (end.outcome === 'goal') {
      if (end.goal?.ownGoal) {
        // 烏龍球:球打在守方那個人身上再進 —— 那個人是事件裡的人,不是隨便挑的
        const d = resolve(o, end.goal.scorer); script.deflector = d; script.sub2 = 'deflect';
        kick(d.x, d.y, { speed: 18, loft: 0.2 }); ball.noCatch = true; holder = d;
      } else { kick(gx + dir * 2, FH / 2 + (rng() - 0.5) * 5, { speed: SHOT_SPEED, loft: 0.5 }); ball.inNet = true; ball.noCatch = true; holder = gk ?? holder; }
    } else if (end.outcome === 'saved') { kick(gk ? gk.x : gx - dir * 3, gk ? gk.y : FH / 2, { speed: 22, loft: 0.4 }); holder = gk ?? holder; }
    else if (end.outcome === 'blocked') {
      const cut = laneCut(ball, { x: gx, y: FH / 2 }, s);
      script.blocker = cut?.o ?? nearestOf(o, ball.x + dir * 4, ball.y);
      kick(script.blocker.x, script.blocker.y, { speed: 20 }); ball.noCatch = true; holder = script.blocker;
    } else if (end.outcome === 'post') {
      const py = FH / 2 + (rng() < 0.5 ? -GOAL_HALF : GOAL_HALF);
      kick(gx, py, { speed: SHOT_SPEED, loft: 0.3 }); ball.cut = { x: gx - dir * 0.5, y: py, post: true }; ball.noCatch = true; holder = gk ?? holder;
    } else { kick(gx + dir * 3, FH / 2 + (rng() < 0.5 ? -1 : 1) * (GOAL_HALF + 2 + rng() * 8), { speed: SHOT_SPEED, loft: 0.5 }); ball.noCatch = true; holder = gk ?? holder; }
  }
  function shotResolve() {
    const { seq, s, o } = script; const end = seq.end; const dir = dirOf(s), gx = goalX(s);
    const ev = seq.events.find(e => e.type === 'goal' || e.type === 'shot');
    const OUT_ZH = { saved: '被撲出', blocked: '被封阻', off: '射偏', post: '中柱' };
    const done = () => {
      if (end.outcome === 'goal') { goalsPlayed++; pendingKickoff = o; setCaption('進球!', ball.x, ball.y, 2.2); }
      else setCaption(OUT_ZH[end.outcome] ?? '射門', ball.x, ball.y);
      if (ev) emit(ev);
      beginAfter();
    };
    const timeout = script.t > END_TIMEOUT;
    if (timeout && !script.endTimedOut) { script.endTimedOut = true; timeouts.end++; }
    switch (end.outcome) {
      case 'goal':
        if (script.sub2 === 'deflect') {
          const d = script.deflector;
          if (Math.hypot(ball.x - d.x, ball.y - d.y) < 1.4 || script.t > 2) {
            ball.x = d.x + dir * 0.5; ball.y = d.y;
            kick(gx + dir * 2, FH / 2 + (rng() - 0.5) * 4, { speed: 16, loft: 0.2, by: d });
            ball.inNet = true; ball.noCatch = true; holder = active().find(p => p.side === o && p.role === 'GK') ?? holder; script.sub2 = null;
          }
        } else if ((ball.inNet && (dir === 1 ? ball.x >= FW : ball.x <= 0)) || timeout) {
          if (timeout) { ball.x = gx + dir; ball.y = FH / 2; ball.inNet = true; ball.vx = 0; ball.vy = 0; }
          done();
        }
        break;
      case 'saved':
        if ((ball.held && holder?.role === 'GK') || timeout) { if (!ball.held) { const gk = active().find(p => p.side === o && p.role === 'GK'); if (gk) snapBallTo(gk); } done(); }
        break;
      case 'blocked': {
        const b = script.blocker;
        if (b && (Math.hypot(ball.x - b.x, ball.y - b.y) < 1.3 || script.t > 1.5)) {
          // 打在人身上彈開:速度變小、方向往回帶一點隨機
          ball.x = b.x - dir * 0.6; ball.y = b.y;
          ball.vx = -dir * (4 + rng() * 4); ball.vy = (rng() - 0.5) * 8; ball.loft = 0; ball.noCatch = false; ball.held = false; ball.lastSide = o;
          done();
        }
        break;
      }
      case 'post': if (ball.cut === null || timeout) done(); break;   // 物理層碰到門柱點就反彈並清掉 cut
      default: if (ball.out || timeout) done(); break;   // 射偏:滾過底線
    }
  }
  function beginAfter() {
    flushEvents();
    for (const p of active()) if (p.run?.scripted) p.run = null;
    script.carryTo = null; script.by = null;
    script.phase = 'after'; script.t = 0;
    const goal = script.seq.end.type === 'shot' && script.seq.end.outcome === 'goal';
    script.afterSec = goal ? (script.mode.celebrateSec ?? CELEBRATE) : 0;
  }
  function finishSeq() {
    const sc = script;
    for (const e of sc.post) { emit(e); if (e.type === 'full') st.done = true; }
    script = null;
    sc.onDone();
  }
  /* 一格內做完(精華 / 快轉時沒結局的回合):球直接在結局點、該拿球的人去拿,事件一次回報。
     這是刻意的「剪接」—— 只用在頁面說不用演的回合,而且每一筆事件仍然回報。 */
  function finishInstant() {
    const { seq, s, o, E } = script; const end = seq.end;
    for (const p of active()) if (p.run?.scripted) p.run = null;
    setPiece = null;
    if (end.type === 'shot' && end.outcome === 'goal') {
      const gx = goalX(s); placeBall(gx + dirOf(s) * 1, FH / 2); ball.inNet = true; goalsPlayed++; pendingKickoff = o;
      performed.push({ type: 'goal', code: (script.actor ?? holder).code, outcome: 'goal', instant: true });
    } else if (end.type === 'shot') {
      placeBall(E.x, E.y); performed.push({ type: 'shot', code: (script.actor ?? holder).code, outcome: end.outcome, instant: true });
      if (end.outcome === 'saved') { const gk = active().find(p => p.side === o && p.role === 'GK'); if (gk) snapBallTo(gk); }
      else if (end.outcome === 'off') counts.goalKicks++;
    } else {
      placeBall(E.x, E.y);
      if (end.type === 'turnover') { const by = resolve(o, end.by); holder = by; }
      else if (end.type === 'corner') counts.corners++;
      else if (end.type === 'out') { if (end.kind === 'throwin') counts.throwIns++; else counts.goalKicks++; }
      else holder = script.actor ?? holder;
    }
    ballRef.x = ball.x; ballRef.y = ball.y;
    flushEvents();
    const sc = script;
    for (const e of sc.post) { emit(e); if (e.type === 'full') st.done = true; }
    script = null;
    sc.onDone();
  }
  const setCaption = (text, x, y, t = 1.4) => { caption = { text, x, y, t }; };

  /* 演出進度換成引擎秒數(頁面用它印分鐘:畫面當主時鐘)。
     停球期間從上一回合的終點走到這一回合的起點;演球的時候依演出進度在 t0 → t1 之間;演完停在 t1。 */
  function clock() {
    if (!script) return null;
    const { seq } = script;
    switch (script.phase) {
      case 'dead': return seq.t0 - script.deadBefore + Math.min(1, script.t / Math.max(1e-6, script.deadSec)) * script.deadBefore;
      case 'restart': case 'fetch': return seq.t0;
      case 'chain': case 'end': return seq.t0 + Math.min(1, script.playT / script.planned) * seq.dur;
      default: return seq.t1;
    }
  }

  /* ── 無球跑位 ── 按角色分工,全部是幾何,**不影響劇本**。 */
  /* 持球者帶球的路線:劇本給的帶球點(carryTo);沒有劇本時慢慢往前帶。
     球在腳下時他朝一個「要去的地方」走,球黏著他(觸球的起伏只是畫面,見 physics)。 */
  function holderRoute(p) {
    if (script?.carryTo) return script.carryTo;
    const dir = dirOf(p.side);
    return { x: p.x + dir * 5, y: p.y + (p.by - p.y) * 0.5 };
  }
  /* 停球時的站位(定位球)。回傳 null 的人照一般規則站。 */
  function setPieceSpot(p, attacking) {
    const dir = dirOf(p.side);
    const bx = baseX(p);
    if (setPiece === 'kickoff') {
      // 開球:全部回自己半場的基準點
      const x = dir === 1 ? Math.min(bx, FW / 2 - 2) : Math.max(bx, FW / 2 + 2);
      return { x, y: p.by };
    }
    if (setPiece === 'corner') {
      if (attacking) return p.role === 'DEF' && p.ph < Math.PI ? null   // 兩三個後衛留在後面
        : { x: goalX(p.side) - dir * (6 + (p.ph / (2 * Math.PI)) * 6), y: FH / 2 + (p.by - FH / 2) * 0.35 };
      // 守方:在自己禁區裡盯人;前鋒站在禁區邊
      const og = ownGoalX(p.side);
      return p.role === 'FWD' ? { x: og + dir * (BOX_X + 4), y: p.by } : { x: og + dir * (4 + (p.ph / (2 * Math.PI)) * 6), y: FH / 2 + (p.by - FH / 2) * 0.3 };
    }
    if (setPiece === 'penalty') {
      // 十二碼:主罰者與門將以外都站在禁區外
      if (p === holder) return null;
      const og = attacking ? goalX(p.side) : ownGoalX(p.side);
      const d = attacking ? -1 : 1;   // 攻方站在對方禁區外(往自己這邊退),守方站在自己禁區外
      return { x: og + dir * d * (BOX_X + 2 + (p.ph / (2 * Math.PI)) * 3), y: FH / 2 + (p.by - FH / 2) * 0.6 };
    }
    if (setPiece === 'freekick') {
      const gx = attacking ? goalX(p.side) : ownGoalX(p.side);
      const toGoal = Math.abs(gx - ball.x);
      if (toGoal > 32) return null;   // 後場的任意球照一般規則站
      if (attacking) return p.role === 'DEF' ? null : { x: gx - dir * (BOX_X + 1 + (p.ph / (2 * Math.PI)) * 4), y: FH / 2 + (p.by - FH / 2) * 0.7 };
      // 守方:人牆 —— 縱線離球最近的三個非門將站在球與球門連線上、9.15 m 外
      const wall = active().filter(q => q.side === p.side && q.role !== 'GK').sort((a, b) => Math.abs(a.by - ball.y) - Math.abs(b.by - ball.y)).slice(0, 3);
      const i = wall.indexOf(p);
      if (i >= 0) {
        const ang = Math.atan2(FH / 2 - ball.y, gx - ball.x);
        return { x: ball.x + Math.cos(ang) * 9.15 - Math.sin(ang) * (i - 1) * 1.0, y: ball.y + Math.sin(ang) * 9.15 + Math.cos(ang) * (i - 1) * 1.0 };
      }
      return { x: gx + dir * (p.role === 'FWD' ? BOX_X + 6 : BOX_X - 2 + (p.ph / (2 * Math.PI)) * 4), y: FH / 2 + (p.by - FH / 2) * 0.5 };
    }
    if (setPiece === 'goalkick' && attacking) {
      const og = ownGoalX(p.side);
      return { DEF: { x: og + dir * 14, y: FH / 2 + (p.by - FH / 2) * 1.15 }, MID: { x: og + dir * 34, y: p.by }, FWD: { x: og + dir * 52, y: p.by } }[p.role] ?? null;
    }
    return null;
  }

  /* 空中球的落點:loft 每秒掉 0.6,所以還會飛 loft/0.6 秒,空中減速 AIR。
     追球的人要跑去**落點**,不是跑向球 —— 跑向球會在半路迎上一顆 20 m/s 的球(控不住),球飛過他落在身後,
     再回頭要兩秒,一腳傳球四秒都接不到(實測,normal 模式 68 次逾時全是這個)。 */
  function landingOf() {
    const v = speedOf();
    if (!(ball.loft > 0) || v < 8) return { x: ball.x, y: ball.y };
    const T = ball.loft / 0.6, dist = Math.max(0, v * T - 0.5 * AIR * T * T);
    return clampPt(ball.x + (ball.vx / v) * dist, ball.y + (ball.vy / v) * dist);
  }
  function aim(p) {
    if (p === holder) return ball.held ? holderRoute(p) : landingOf();
    const dir = dirOf(p.side);
    const possSide = script?.s ?? holder.side;
    const attacking = p.side === possSide;
    const bx = baseX(p);
    if (p.run?.scripted) return { x: p.run.tx, y: p.run.ty };   // 劇本指定的跑位(接球點 / 越位前插 / 去斷球)
    // 門將:貼自家球門,橫向跟著球移動一點點(參考球位置,不跟著每一次觸球抖)
    if (p.role === 'GK') return { x: ownGoalX(p.side) + dir * 4.5, y: FH / 2 + (ballRef.y - FH / 2) * 0.35 };
    if (setPiece) { const t = setPieceSpot(p, attacking); if (t) return t; }
    if (script?.phase === 'end' && script.seq.end.type === 'foul' && p === script.by) return { x: ball.x, y: ball.y };   // 犯規的人真的去撞

    if (attacking) {
      if (p.run) return { x: p.run.tx, y: p.run.ty };
      // 球推進到對方半場多深(0~1)——整條線往前壓多少由它決定,不是固定值
      const adv = Math.min(1, Math.max(0, (dir * (ballRef.x - FW / 2)) / (FW / 2) * 0.5 + 0.5));
      const ADV = { DEF: 8, MID: 15, FWD: 24 }[p.role] ?? 10;
      let x = bx + dir * ADV * adv + push * dir * 0.4;
      // 邊路拉寬:離中線遠的人再往邊線站,把場地撐開;整體再往該隊慣用的那一側偏(三路進攻佔比)
      const wide = Math.abs(p.by - FH / 2) > FH / 5;
      const y = p.by + (wide ? Math.sign(p.by - FH / 2) * 4.2 * adv : 0) + flankShift(p.side) * adv * (p.role === 'DEF' ? 0.3 : 0.6);
      if (p === runner) x += dir * 9;              // 一名中場前插支援
      return { x, y };
    }

    // 上搶:離球最近的那個真的去搶球,不是整隊平移
    if (p === presser) {
      /* 站在離球 2.2 m(不是 1.8):持球者的球在腳前 0.7 m,1.8 會讓上搶者站到離持球者 1.1 m,
         每一格都被 separate() 推開再走回來(量出來上搶者每分鐘被推 7.5 次)。2.2 > MIN_SEP + 0.5。 */
      const d = Math.max(2.2, Math.hypot(ball.x - p.x, ball.y - p.y));
      const k = 2.2 / d;
      return { x: ball.x + (p.x - ball.x) * k, y: ball.y + (p.y - ball.y) * k };
    }
    // 防線高度跟著球走:球在自家半場就退,球在對方半場就壓上
    const BACK = { DEF: 15, MID: 7, FWD: -4 }[p.role] ?? 8;
    const line = ballRef.x - dir * BACK;
    const squeeze = (ballRef.y - p.by) * 0.22;     // 朝球收縮,壓縮防守寬度
    return { x: bx + (line - bx) * (p.role === 'FWD' ? 0.25 : 0.6), y: p.by + squeeze };
  }

  /* 一格的運動:球的物理、參考球位置、上搶者 / 前插者、無球跑動、逐人的速度模型、間距兜底。
     劇本不在這裡 —— 這裡只讀 holder / setPiece / 各人的 run,所以停球快轉可以把它連叫幾次。 */
  function moveAll(dt) {
    simT += dt;
    for (const p of players) { if (p.flash > 0) p.flash -= dt; if (p.cardT > 0) p.cardT -= dt; }
    if (caption && (caption.t -= dt) <= 0) caption = null;
    physics(dt);

    const kRef = Math.min(1, dt / BALL_REF_TAU);
    ballRef.x += (ball.x - ballRef.x) * kRef; ballRef.y += (ball.y - ballRef.y) * kRef;

    /* 每格重算兩個角色:誰上搶(防守方離球最近的非門將)、誰前插(控球方離球縱向最近的中場)。
       **有遲滯**:別人要比現任近 PRESS_HYST / RUN_HYST 才換人 ——
       沒有遲滯的話兩個差不多近的防守者會輪流當上搶者,兩個人一起抖。
       劇本指定了犯規 / 斷球的人時,上搶者就是他。 */
    const possSide = script?.s ?? holder.side;
    const defSide = other(possSide);
    let bestP = null, bestPress = Infinity, bestR = null, bestRun = Infinity;
    for (const p of active()) {
      if (p.role === 'GK') continue;
      if (p.side === defSide) {
        const d = Math.hypot(p.x - ball.x, p.y - ball.y);
        if (d < bestPress) { bestPress = d; bestP = p; }
      } else if (p.role === 'MID' && p !== holder) {
        const d = Math.abs(p.by - ballRef.y);
        if (d < bestRun) { bestRun = d; bestR = p; }
      }
    }
    const forced = script?.phase === 'end' && script.by && ['foul', 'turnover'].includes(script.seq.end.type) ? script.by : null;
    const keepP = presser && !presser.off && presser.side === defSide && presser.role !== 'GK'
      && Math.hypot(presser.x - ball.x, presser.y - ball.y) <= bestPress + PRESS_HYST;
    presser = forced ?? (keepP ? presser : bestP);
    const keepR = runner && !runner.off && runner.side === possSide && runner !== holder && runner.role === 'MID'
      && Math.abs(runner.by - ballRef.y) <= bestRun + RUN_HYST;
    runner = keepR ? runner : bestR;

    scheduleRuns(dt);
    const list = active();
    for (const p of list) { p.px = p.x; p.py = p.y; }
    for (const p of list) {
      const a = aim(p);
      const busy = p === holder || p === presser || p === runner || !!p.run || p.role === 'GK' || (setPiece != null);
      // 有人靠近就讓一步(只有沒事的人讓;有任務的人由對方讓)
      if (!busy) {
        for (const o of list) {
          if (o === p) continue;
          const ox = p.x - o.x, oy = p.y - o.y, od = Math.hypot(ox, oy);
          if (od < REPEL_R && od > 1e-6) { const k = (REPEL_R - od) * REPEL_K / od; a.x += ox * k; a.y += oy * k; }
        }
      }
      /* 閒置走位:每 WANDER_EVERY 秒在自己的活動範圍內挑一個點,走過去就站著等下一個。
         幅度依熱區離散度(spreadK)。點是一次挑好的,不是每格算。 */
      if (!busy) {
        if (!p.wander || simT >= p.wander.until) {
          const r = WANDER_R * p.spreadK * Math.sqrt(rng()), th = rng() * Math.PI * 2;
          p.wander = { ox: Math.cos(th) * r, oy: Math.sin(th) * r, until: simT + WANDER_EVERY[0] + rng() * (WANDER_EVERY[1] - WANDER_EVERY[0]) };
        }
        a.x += p.wander.ox; a.y += p.wander.oy;
      }
      let dx = a.x - p.x, dy = a.y - p.y, d = Math.hypot(dx, dy);
      // 閒置的人:目標飄出 IDLE_START 才起步、走到 IDLE_STOP 內才停(遲滯);真的要走才算避讓(站著的人不側步)
      if (busy) p.walking = false;
      else if (!p.walking && d > IDLE_START) p.walking = true;
      else if (p.walking && d < IDLE_STOP) p.walking = false;
      const arrive = busy ? ARRIVE_R : (p.walking ? IDLE_STOP : Infinity);
      let yieldNow = false;
      if (d > arrive && !(p === holder && !ball.held)) {
        /* 追自由球的人不繞行:切線偏移會讓他繞著擋在球邊的上搶者打轉,站在球邊 2 m 四秒都控不到球(實測)。
           重疊由 separate() 兜底,而持球者在那裡是不動的那一方。 */
        const avoid = avoidanceOf(p, a, list);
        dx += avoid.x; dy += avoid.y; d = Math.hypot(dx, dy);
        // 沒事的人前方有人就先停下讓路(有任務的人不讓,由對方讓)
        if (!busy && d > 1e-6) {
          for (const o of list) {
            if (o === p) continue;
            const ox = o.x - p.x, oy = o.y - p.y, od = Math.hypot(ox, oy);
            if (od < YIELD_R && od > 1e-6 && (ox * dx + oy * dy) / (od * d) > YIELD_COS) { yieldNow = true; break; }
          }
        }
      }
      /* 目標速度:方向朝目標,大小 = min(這個狀態該跑多快, 煞得住的速度)。
         後面那一項是 v² = 2·a·d —— 少了它會繞著目標點來回過衝(而過衝的距離
         會被算進跑動量,均速就假了)。 */
      let want = d > arrive && !yieldNow ? Math.min(speedCap(p, d), Math.sqrt(2 * DECEL * Math.max(0, d - arrive))) : 0;
      const cur = Math.hypot(p.vx, p.vy);
      /* 要轉彎就先減速。加速度有上限,所以全速(5.2 m/s)的轉彎半徑是 v²/a ≈ 4 m ——
         球停在腳邊 2 m 而人以全速追它的話,他永遠在球外圍繞圈,四秒都控不到(實測:接球者 sp 5.2、離球 2 m 不變)。
         現在的速度跟目標方向夾角越大,目標速度越低(背對目標時剩 15%,煞車後再轉向),半徑就縮到零。 */
      if (cur > 0.5 && want > 0 && d > 1e-3) {
        const cos = (p.vx * dx + p.vy * dy) / (cur * d);
        if (cos < 0.85) want *= Math.max(0.15, cos);
      }
      const wx = d > 1e-3 ? (dx / d) * want : 0, wy = d > 1e-3 ? (dy / d) * want : 0;
      // 速度每格只能改變這麼多 → 起步、煞車、轉向都要時間(舊版是位置直接插值,沒有這一層)
      const ddx = wx - p.vx, ddy = wy - p.vy, dd = Math.hypot(ddx, ddy);
      const rate = (want > cur ? ACCEL : DECEL) * dt;
      if (dd > rate && dd > 1e-6) { p.vx += (ddx / dd) * rate; p.vy += (ddy / dd) * rate; }
      else { p.vx = wx; p.vy = wy; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      // 撞到邊界:那個方向的速度歸零,不要貼著邊線滑
      if (p.x < 1) { p.x = 1; p.vx = Math.max(0, p.vx); }
      if (p.x > FW - 1) { p.x = FW - 1; p.vx = Math.min(0, p.vx); }
      if (p.y < 1.5) { p.y = 1.5; p.vy = Math.max(0, p.vy); }
      if (p.y > FH - 1.5) { p.y = FH - 1.5; p.vy = Math.min(0, p.vy); }
      /* 跑動量就量這裡:**速度積出來的位移**。
         不要在 separate() 之後用前後位置相減 —— 那一步是幾何約束(把疊在一起的人推開),
         推開不是跑步,而它一格可以推 1.6 m,除以 dt 就是 48 m/s,尖峰整個假掉(實測 52.42)。 */
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0.15) p.faceAng = Math.atan2(p.vy, p.vx);   // 朝向在這裡定,畫面與球的黏附都讀它
      p.dist += sp * dt;
      p.vmax = Math.max(p.vmax, sp);
      const band = sp < 2 ? 0 : sp < 4 ? 1 : sp < SPRINT_MS ? 2 : 3;
      p.bandT[band] += dt; p.bandD[band] += sp * dt;
      /* 一次衝刺要**持續** SPRINT_HOLD 秒才算一次 —— FotMob 的 `sprintsPerMin` 數的是持續的衝刺,
         而「每次跨過門檻就算一次」會把加速過程中的瞬間也算進去(實測那樣數出來多 2~5 倍)。
         定義不一樣的兩個數字擺在一起比,得到的結論是假的。 */
      if (band === 3) { const was = p.sprintT; p.sprintT += dt; if (was < SPRINT_HOLD && p.sprintT >= SPRINT_HOLD) p.sprints++; }
      else p.sprintT = 0;
      // 步頻相位跟著**走過的距離**推進,所以走的人幾乎不擺、衝刺的人擺很快(畫面用)
      p.stride += sp * dt * STRIDE_PER_M * Math.PI;
    }
    separate();
  }

  /* 球的物理與出界(2026-09-03)。每格:自由球依速度前進、摩擦減速;持球者到球邊就控住(停球往前推一步)。
     出界:邊線 → 界外球、底線 → 球門球(攻方最後碰)或角球(守方最後碰);這裡只**記下來**(ball.out),
     怎麼接下去由劇本決定 —— 演出不再自己發明下一段。 */
  function physics(dt) {
    if (ball.held && holder) {
      /* 球在腳下,黏著持球者。帶球時的「觸球」是畫面上的起伏(球在前腳與腳下之間來回,相位跟著步頻),
         不再真的把球踢出去再追 —— 那會讓持球者走走停停(見 holderRoute)。 */
      const sp = Math.hypot(holder.vx, holder.vy);
      const ang = holder.faceAng ?? (dirOf(holder.side) === 1 ? 0 : Math.PI);
      const touch = sp > 1.2 ? 0.55 + 0.35 * Math.abs(Math.sin(holder.stride * 0.5)) : 0.7;
      ball.x = holder.x + Math.cos(ang) * touch; ball.y = holder.y + Math.sin(ang) * touch;
      return;
    }
    // 自由球:前進與摩擦
    const v = speedOf();
    if (v > 0) {
      const a = ball.loft > 0 ? AIR : FRICTION;
      const nv = Math.max(0, v - a * dt);
      ball.x += (ball.vx / v) * nv * dt; ball.y += (ball.vy / v) * nv * dt;
      ball.vx = (ball.vx / v) * nv; ball.vy = (ball.vy / v) * nv;
      if (ball.loft > 0) { ball.loft = Math.max(0, ball.loft - dt * 0.6); if (ball.loft === 0) { ball.vx *= LAND_KEEP; ball.vy *= LAND_KEEP; } }   // 落地
    }
    if (ball.noCatch && v <= 0.05) ball.noCatch = false;   // 保險:滾不到界外就讓人撿
    // 中柱:到門柱點就反彈
    if (ball.cut?.post && Math.hypot(ball.x - ball.cut.x, ball.y - ball.cut.y) < 1.2) {
      ball.vx = -ball.vx * 0.35; ball.vy = (rng() - 0.5) * 8; ball.loft = 0; ball.cut = null; ball.noCatch = false;
      return;
    }
    if (ball.inNet) {
      if (ball.x < -1.5 || ball.x > FW + 1.5) { ball.vx = 0; ball.vy = 0; ball.x = Math.max(-1.5, Math.min(FW + 1.5, ball.x)); }
      return;
    }
    // 出界
    if (ball.y < 0 || ball.y > FH) return throwIn();
    if (ball.x < 0 || ball.x > FW) return byline();
    // 控球:該去控球的人到了就控住(門將接球不受速度限制),停球往前推一步
    if (!ball.noCatch && holder && Math.hypot(holder.x - ball.x, holder.y - ball.y) < CONTROL_R && (v < 16 || holder.role === 'GK')) {
      const dir = dirOf(holder.side);
      const ahead = ball.cut?.bounce ? 0 : TOUCH_AHEAD[0] + rng() * (TOUCH_AHEAD[1] - TOUCH_AHEAD[0]);
      ball.x = holder.x + dir * ahead; ball.y = holder.y + (rng() - 0.5) * 0.8;
      ball.vx = 0; ball.vy = 0; ball.held = true; ball.loft = 0; ball.cut = null; ball.lastSide = holder.side;
    }
  }
  function throwIn() {
    const y = ball.y < 0 ? 0.2 : FH - 0.2;
    const x = Math.max(1, Math.min(FW - 1, ball.x));
    ball.x = x; ball.y = y; ball.vx = 0; ball.vy = 0; ball.loft = 0; ball.cut = null; ball.held = false; ball.noCatch = false;
    ball.out = { kind: 'throwin', x, y, to: other(ball.lastSide) };
    counts.throwIns++;
  }
  function byline() {
    const endX = ball.x < 0 ? 0 : FW;
    const defending = ['home', 'away'].find(sd => ownGoalX(sd) === endX);   // 這條底線是誰家的
    ball.vx = 0; ball.vy = 0; ball.loft = 0; ball.cut = null; ball.held = false; ball.noCatch = false;
    ball.x = Math.max(0.3, Math.min(FW - 0.3, ball.x)); ball.y = Math.max(0.3, Math.min(FH - 0.3, ball.y));
    if (ball.lastSide === defending) { counts.corners++; ball.out = { kind: 'corner', to: other(defending) }; }   // 守方最後碰到 → 角球
    else { counts.goalKicks++; ball.out = { kind: 'goalkick', to: defending }; }                                   // 攻方最後碰到 → 球門球
  }

  /* 無球跑動的排程(2026-09-03)。每個攻方非持球員每秒以 RUN_RATE × 節奏 × 個人勤勞度的機率起跑,
     跑動類型按細分角色(FB 套邊、W 內切、CM/AM 前插、ST 拉邊接應、CB 不跑),持續 2~4 秒;
     衝刺的比例由該隊每分鐘衝刺次數決定,衝刺時速度倍率更高。跑完回到一般站位。
     劇本指定的跑位(scripted)不在這裡管,由劇本自己清。 */
  function scheduleRuns(dt) {
    const possSide = script?.s ?? holder.side;
    const pace = paceOf(possSide);
    const sprintsPerMin = pace?.sprintsPerMin ?? LEAGUE_SPRINTS_PER_MIN;
    const sprintShare = Math.max(0.15, Math.min(0.6, sprintsPerMin / LEAGUE_SPRINTS_PER_MIN * 0.3));
    for (const p of active()) {
      if (p.run) {
        if (p.run.scripted) continue;
        p.run.t -= dt;
        if (p.run.t <= 0 || p.side !== possSide) p.run = null;
        continue;
      }
      if (p.side !== possSide || p === holder || p.role === 'GK' || setPiece) continue;
      if (rng() > RUN_RATE * p.act * dt) continue;
      const dir = dirOf(p.side), toEdge = Math.sign(p.y - FH / 2) || 1;
      const role = p.sub ?? p.role;
      let tx, ty;
      if (role === 'FB') { tx = p.x + dir * 18; ty = FH / 2 + toEdge * (FH / 2 - 6); }            // 套邊
      else if (role === 'W') { tx = p.x + dir * 10; ty = FH / 2 + toEdge * 8; }                     // 內切
      else if (role === 'CM' || role === 'AM' || role === 'DM' || p.role === 'MID') { tx = p.x + dir * 14; ty = p.y + (rng() < 0.5 ? -6 : 6); }   // 前插
      else if (role === 'ST' || p.role === 'FWD') { tx = p.x + dir * 4; ty = FH / 2 + toEdge * 14; }   // 拉邊接應
      else continue;                                                                               // CB 不跑
      const sprint = rng() < sprintShare;
      p.run = { tx: Math.max(2, Math.min(FW - 2, tx)), ty: Math.max(2, Math.min(FH - 2, ty)),
        t: RUN_SECONDS[0] + rng() * (RUN_SECONDS[1] - RUN_SECONDS[0]), sprint };
    }
  }

  /* 這個人現在該跑多快(m/s)。上限一律是他自己的最高速度(真資料)。

     為什麼「沒事的時候是走」:真實球員全場均速約 1.9 m/s,大部分時間在走與慢跑 ——
     整場都慢跑的話均速會落在 3 m/s 上下,畫面就是二十二個人一直小跑步(舊版更糟,是一直衝刺)。
     離基準點越遠跑越快(要回位),這也是真的:跑動量大多發生在攻守轉換。 */
  function speedCap(p, d) {
    if (p.role === 'GK') return Math.min(p.vtop, SPEED_JOG);
    if (p.run) return p.run.sprint ? p.vtop : Math.min(p.vtop, SPEED_RUN);
    if (p === holder) return Math.min(p.vtop, ball.held ? SPEED_RUN * 0.8 : SPEED_RUN);   // 帶球比追球慢
    if (p === presser) return Math.min(p.vtop, SPEED_RUN);
    if (p === runner) return Math.min(p.vtop, SPEED_JOG * 1.2);
    if (setPiece) return Math.min(p.vtop, d > FAR_JOG ? SPEED_JOG : SPEED_WALK * 1.3);   // 停球時走去站位
    const idle = SPEED_WALK * (0.75 + 0.5 * p.act);        // 個人勤勞度(逐人場均跑動 / 隊均)
    if (d > FAR_RUN) return Math.min(p.vtop, SPEED_RUN * 0.85);
    if (d > FAR_JOG) return Math.min(p.vtop, SPEED_JOG);
    return idle;
  }

  /* 位置層的間距兜底(2026-09-03)。切線繞行只改「目標點」,兩人目標交叉時還是會穿過去
     (09-02 實測:全場最小間距中位數 0.11 m、5~13% 的畫格有人疊著)。這裡在積分**之後**把太近的兩個人沿連線推開:
     繞行決定路線、這一步保證不重疊,兩者不衝突。持球者不動(他要對得上球),對方被推開全額;
     其餘兩人各推一半。純幾何,不讀比分、不改 holder,所以跟劇本無關。跑兩輪就夠 —— 一輪推開的兩人
     可能撞到第三個,第二輪收掉大部分。 */
  function separate() {
    const list = active();
    for (const p of list) { p.sx0 = p.x; p.sy0 = p.y; }
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const p = list[i], q = list[j];
          let dx = q.x - p.x, dy = q.y - p.y;
          let d = Math.hypot(dx, dy);
          if (d >= MIN_SEP) continue;
          if (d < 1e-6) { dx = 1; dy = 0; d = 1e-6; }   // 完全重合:挑一個方向推開
          const need = (MIN_SEP - d) / d;
          const wp = p === holder ? 0 : q === holder ? 1 : 0.5;
          p.x -= dx * need * wp; p.y -= dy * need * wp;
          q.x += dx * need * (1 - wp); q.y += dy * need * (1 - wp);
        }
      }
    }
    /* 單格的修正量設上限(2026-09-12):一格最多推 PUSH_MAX,沒推完下一格繼續。
       沒有上限的話一格可以推 1.6 m —— 畫面上是一個跳躍(30 fps 下約 13 px),
       而它跟「跑」完全無關。有上限之後看起來是推擠,而且收斂只慢一兩格。 */
    for (const p of list) {
      const mx = p.x - p.sx0, my = p.y - p.sy0, m = Math.hypot(mx, my);
      if (m > PUSH_MAX) { p.x = p.sx0 + (mx / m) * PUSH_MAX; p.y = p.sy0 + (my / m) * PUSH_MAX; }
    }
    for (const p of list) { p.x = Math.max(1, Math.min(FW - 1, p.x)); p.y = Math.max(1.5, Math.min(FH - 1.5, p.y)); }
    /* 夾回邊界之後可能又疊在一起(角旗、底線角落):沿邊界方向錯開,不再往界外推 */
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const p = list[i], q = list[j];
      if (Math.hypot(q.x - p.x, q.y - p.y) >= MIN_SEP * 0.75) continue;
      const onX = p.x <= 1 || p.x >= FW - 1, onY = p.y <= 1.5 || p.y >= FH - 1.5;
      if (onX) q.y = Math.max(1.5, Math.min(FH - 1.5, q.y + (q.y >= p.y ? MIN_SEP : -MIN_SEP)));
      else if (onY) q.x = Math.max(1, Math.min(FW - 1, q.x + (q.x >= p.x ? MIN_SEP : -MIN_SEP)));
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // 球場:深底 + 霓虹線(跟站上的 HUD 調性一致)
    ctx.fillStyle = '#0a1018'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(4,245,255,.35)'; ctx.lineWidth = 1.2;
    const rect = (x, y, w, h) => ctx.strokeRect(sx(x), sy(y), (w / FW) * (W - pad * 2), (h / FH) * (H - pad * 2));
    rect(0, 0, FW, FH); rect(0, FH / 2 - 20.16, 16.5, 40.32); rect(FW - 16.5, FH / 2 - 20.16, 16.5, 40.32);
    ctx.beginPath(); ctx.moveTo(sx(FW / 2), sy(0)); ctx.lineTo(sx(FW / 2), sy(FH)); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx(FW / 2), sy(FH / 2), (9.15 / FW) * (W - pad * 2), 0, 7); ctx.stroke();

    /* 畫人(2026-09-12 改):圓點有**朝向、拖影與步態**。
       一個沒有方向的圓點無論快慢都長一樣,看不出他在跑還是在站。三樣都只讀速度向量,沒有任何新資料:
       - 朝向:身體沿前進方向拉長一點(速度越快越明顯),站著不動時維持上一次的朝向
       - 拖影:跑起來才出現,長度與亮度依速度 —— 一眼看得出誰在衝
       - 步態:垂直前進方向的小幅擺動,相位跟著**走過的距離**推進(見 p.stride)。這是演出,不是量測值 */
    for (const p of active()) {
      const r = p.role === 'GK' ? 7 : 8;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0.15) p.faceAng = Math.atan2(p.vy, p.vx);
      const ang = p.faceAng ?? (p.side === 'home' ? 0 : Math.PI);
      const fast = Math.min(1, sp / SPEED_RUN);
      // 拖影:只有跑起來才畫(慢跑以下不畫,不然整場都是尾巴)
      if (sp > SPEED_JOG) {
        const back = Math.min(0.18, 0.10 + fast * 0.08);
        ctx.beginPath(); ctx.moveTo(sx(p.x - p.vx * back), sy(p.y - p.vy * back)); ctx.lineTo(sx(p.x), sy(p.y));
        ctx.strokeStyle = p.color; ctx.globalAlpha = 0.15 + fast * 0.35; ctx.lineWidth = r * 1.15; ctx.lineCap = 'round';
        ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1.2; ctx.lineCap = 'butt';
      }
      // 步態擺動:垂直前進方向,幅度依速度(公尺)
      const sway = Math.sin(p.stride) * SWAY_M * fast;
      const dx = -Math.sin(ang) * sway, dy = Math.cos(ang) * sway;
      const cx = sx(p.x + dx), cy = sy(p.y + dy);
      ctx.beginPath(); ctx.ellipse(cx, cy, r * (1 + 0.22 * fast), r * (1 - 0.14 * fast), ang, 0, 7);
      ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = p === holder ? 18 : 8;
      ctx.fill(); ctx.shadowBlur = 0;
      ctx.lineWidth = p === holder ? 2.4 : 1.2;
      ctx.strokeStyle = p === holder ? '#ffffff' : 'rgba(255,255,255,.55)';
      ctx.stroke();
      // 換人 / 拿牌的提示圈(黃牌黃、紅牌紅、換人綠),淡出
      if (p.flash > 0) {
        ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, 7);
        ctx.strokeStyle = p.flashColor ?? '#ffd400'; ctx.lineWidth = 2; ctx.globalAlpha = Math.min(1, p.flash); ctx.stroke(); ctx.globalAlpha = 1;
      }
      // 牌:圓點上方一張小卡
      if (p.cardT > 0) { ctx.fillStyle = p.cardColor ?? '#ffd400'; ctx.globalAlpha = Math.min(1, p.cardT); ctx.fillRect(cx - 4, cy - r - 16, 8, 11); ctx.globalAlpha = 1; }
      if (p.shirt != null) {
        ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#0b0710';
        ctx.fillText(String(p.shirt), cx, cy + 3);
      }
    }
    // 結局的一行字(犯規 / 越位 / 被撲出 / 角球…),跟著球的位置
    if (caption) {
      ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillText(caption.text, Math.max(40, Math.min(W - 40, sx(caption.x))), Math.max(46, sy(caption.y) - 22));
    }
    // 持球者名字(有真名才顯示)
    if (holder?.name) {
      ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillText(holder.name, sx(holder.x), sy(holder.y) - 13);
    }
    // 球
    const br = 4.4 + ball.loft * 3;
    if (ball.loft > 0) { ctx.beginPath(); ctx.ellipse(sx(ball.x) + 3, sy(ball.y) + 4 + ball.loft * 6, 4, 2, 0, 0, 7); ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fill(); }
    ctx.beginPath(); ctx.arc(sx(ball.x), sy(ball.y), br, 0, 7);
    ctx.fillStyle = '#fff'; ctx.shadowColor = '#00ff85'; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;

    // 記分板(截圖/錄影時畫面裡要有資訊)。下半場換邊後隊伍色塊跟著換側
    const chipW = 190, chipH = 26, cx0 = W / 2 - chipW / 2;
    ctx.fillStyle = 'rgba(8,10,16,.82)';
    ctx.beginPath(); ctx.roundRect(cx0, 4, chipW, chipH, 7); ctx.fill();
    const leftSide = half === 1 ? 'home' : 'away';
    const [lc, rc] = leftSide === 'home' ? [home.color, away.color] : [away.color, home.color];
    ctx.fillStyle = lc; ctx.fillRect(cx0 + 8, 11, 12, 12);
    ctx.fillStyle = rc; ctx.fillRect(cx0 + chipW - 20, 11, 12, 12);
    ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
    const [ln, rn] = leftSide === 'home' ? [homeCode, awayCode] : [awayCode, homeCode];
    const [ls2, rs2] = leftSide === 'home' ? [st.hs, st.as] : [st.as, st.hs];
    ctx.fillText(`${ln} ${ls2} : ${rs2} ${rn}`, W / 2, 22);
    ctx.font = '11px system-ui'; ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.fillText(st.done ? 'FT' : `${st.min}${st.extra ? `+${st.extra}` : ''}'`, W / 2, H - 8);
  }

  probe = () => ({
    goalsPlayed, half, min: st.min, pendingKickoff,
    script: script ? { id: script.seq.id, phase: script.phase, sub: script.sub } : null,
    running: active().filter(p => p.run).length, sprinting: active().filter(p => p.run?.sprint).length,
    ball: { x: ball.x, y: ball.y, held: ball.held, speed: speedOf(), loft: ball.loft, inNet: ball.inNet }, holderSide: holder?.side ?? null, holderCode: holder?.code ?? null,
    counts: { ...counts }, setPiece, performed: performed.map(x => ({ ...x })), timeouts: { ...timeouts }, phaseSecs: { ...phaseSecs }, timeoutLog: timeoutLog.map(x => ({ ...x })),
    inBounds: players.every(p => p.x >= 0 && p.x <= FW && p.y >= 0 && p.y <= FH),
    motion: { secs: simT, players: players.map(p => ({ role: p.role, off: p.off, dist: p.dist, vmax: p.vmax, act: p.act, topSpeed: p.topSpeed, vtop: p.vtop, bandT: [...p.bandT], bandD: [...p.bandD], sprints: p.sprints, x: p.x, y: p.y, bx: p.bx0, by: p.by,
      // 速度向量與當下的角色(量抖動用:翻轉是自己轉的還是被推的、是誰在翻)
      code: p.code, vx: p.vx, vy: p.vy, busy: p === holder ? 'holder' : p === presser ? 'presser' : p === runner ? 'runner' : p.run ? 'run' : p.walking ? 'walk' : 'idle' })) },
    /* 只算在場上的人:被罰下的圓點留在原地(不畫、不動),別人走過他身上不是重疊(實測 normal 種子 7 量到 0.10 m,就是這個) */
    minSeparation: active().reduce((best, p, i, list) => list.slice(i + 1)
      .reduce((inner, q) => Math.min(inner, Math.hypot(p.x - q.x, p.y - q.y)), best), Infinity),
  });

  let raf = null, last = null, alive = true;
  const loop = now => {
    if (!alive) return;
    /* 第一格只記時間、不推進:mount 到第一格之間的牆上時間會混進 dt,之後每個「rng() > 機率 × dt」的比較都跟著飄,
       同種子在測試台跑兩次結果不同(實測角球演出來的次數不一樣)。從第二格起 dt 完全來自 rAF 的時戳。 */
    if (last == null) { last = now; draw(); raf = requestAnimationFrame(loop); return; }
    /* 夾住負值。瀏覽器不會給比 mount 時還早的 rAF 時戳,但無畫布的測試台會
       (它自己從 0 開始餵 now),於是第一格的 dt 變成負的 —— 位置往目標的
       **反方向**跳一下,而跳多遠取決於行程已經跑多久。
       實測:同一個種子,單獨跑 node scripts/test.mjs 全綠、npm test 就紅,
       因為後者讓 test.mjs 晚了幾百毫秒起步。負的 frame delta 本來就沒有意義。 */
    /* dt 量化到整數毫秒:這個模擬對 dt 的浮點尾數敏感(每格都有「rng() > 機率 × dt」的比較),
       合成時鐘 33.333… 的尾數只要不同,同種子就走出不同的路(實測 4 種起始時戳 3 種軌跡)。
       整數毫秒之後同種子同時鐘一定同劇本;瀏覽器的 rAF 本來就是整數毫秒等級的抖動。 */
    const dt = Math.min(0.05, Math.max(0, Math.round(now - last) / 1000)); last = now;
    if (!st.done && !paused) step(dt);
    draw();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    play,
    clock,
    busy: () => script != null,
    pause(v) { paused = !!v; },
    /* 記分板的分鐘由頁面給(它用引擎的 minuteAt 把 clock() 換成分鐘,規則只有一份) */
    setClock({ min, extra = null } = {}) { st.min = min; st.extra = extra; },
    /* 跳到結果:劇本丟掉、比分板直接寫完場的比分,畫面留著(不然畫布停在跳過前那一格,跟上面的比分對不上) */
    finish({ hs, as }) { script = null; setPiece = null; st.hs = hs; st.as = as; st.done = true; },
    destroy() { alive = false; if (raf) cancelAnimationFrame(raf); },
  };
}
