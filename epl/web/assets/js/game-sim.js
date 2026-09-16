/* 模擬遊玩:連續時間的比賽模擬(2026-09-16,使用者的決定「換掉引擎,改成連續時間模擬」)。
 *
 * 界線跟整個遊戲台一樣,而且沒有任何鬆動:這一支只讀真實管線的產物(web/data/game/*.json),
 * 不寫任何真實資料、不被真實管線 import、不畫在真實的頁面上。
 * 遊戲內的參數照本站的現實資料走,但**遊戲不影響真實參數,也不影響真實比賽**。
 *
 * ── 為什麼不是把 game-engine.js 改一改 ──
 * 舊的是「回合制 + 演出」:引擎先決定一個回合的結局(射門 / 丟球 / 角球),
 * 畫面再想辦法把二十二個人擺成那個結局該有的樣子。那個形狀決定了三件使用者看得出來的事:
 * 演出會被切斷(整段跳過要淡出淡入)、人的動作是被擺出來的、球是照腳本跳到下一個人。
 * 三件都不是調參數能修的,所以換一台。
 *
 * ── 這一支的形狀 ──
 * 固定時步(SIM_DT)的狀態機:每一步只做「每個人依自己的狀態決定想往哪走」+「球照物理飛」,
 * 事件是**長出來的**,沒有人事先決定。畫面要跑多快就呼叫 advance(幾秒),
 * 物理完全不受 rAF 抖動影響 —— 舊的那支對 dt 的浮點尾數敏感到要把 dt 量化成整數毫秒才能重現,
 * 那本身就是「物理綁在畫面上」的症狀。
 *
 * ── 沿用而不重寫的東西 ──
 * 運動核心的常數與三條規則是 duel-anim.js 那邊**量出來**的,CLAUDE.md 上每一條都付過代價:
 *   1. 加速度有上限 → 全速的轉彎半徑 v²/a ≈ 4 m,所以要轉彎就得先減速,不然永遠繞圈
 *   2. 追空中球要追**落點**,不是追球 —— 朝球跑會在半路迎上一顆太快的球,然後看它飛過頭
 *   3. 閒置走位要**兩個門檻**(起步 1.5 m、停步 0.4 m),單一門檻會讓人在門檻邊上被拉來拉去
 * 這三條在這裡照抄,不要因為「新引擎」就重新發明。
 *
 * 階段 1(這一版):連續的運動與球物理、陣型整塊移動、持球 / 逼搶 / 接應 / 追球。
 * 事件(射門、進球、角球、越位、犯規、牌)與 λ 校準是階段 2 —— 這一版刻意不產生比分,
 * 因為**沒校準過的進球數就是編出來的數字**(鐵則一),寧可先沒有。
 */

/* 模組層的 const 一律宣告在最前面 —— const 不會提升,而渲染器在模組執行時就可能被呼叫
   (球員頁那次整張表不見、只有 console 一行 TDZ 錯誤)。 */
const PITCH_W = 105, PITCH_H = 68;                       // 球場(公尺),跟 duel-anim 同一套座標
const SIM_DT = 1 / 60;                         // 固定時步。物理不吃畫面的 dt(見檔頭)
const MAX_STEPS = 600;                         // 一次 advance 最多推幾步,防止分頁切回來時一次補上幾分鐘

/* 運動:duel-anim.js 量出來的那一組,不重新發明 */
const SIM_ACCEL = 6.5, SIM_DECEL = 9.0;                // 加速 / 煞車上限(m/s²)
const SIM_WALK = 1.05, SIM_JOG = 2.5, SIM_RUN = 5.2;
const VMAX_FALLBACK = 8.6;                     // 沒有逐人最高速時用(m/s;約 31 km/h,聯盟中位數量級)
const IDLE_GO = 1.5, IDLE_STOP = 0.4;          // 閒置走位的兩個門檻(見檔頭第 3 條)

/* 球:地面摩擦與空阻沿用 duel-anim */
const BALL_FRICTION = 5.5, BALL_AIR = 1.2, GRAVITY = 9.81;
const BALL_BOUNCE = 0.45;                      // 落地彈跳保留的垂直速度比例
const SIM_CONTROL_R = 1.2;                         // 這麼近才控得到球(公尺)
/* 踢球的人自己不可以馬上把球撿回來。第一版沒有這條,症狀是 90 分鐘 5,861 次傳球對上
   5,881 次「撿到鬆球」—— 球一離腳 0.5 m,下一格才飛 0.33 m,踢的人還在 1.2 m 內,
   於是自己又控到了。結果:98.2% 的時間球在某人腳下、90 分鐘一次出界都沒有、球永遠飛不出去。 */
const KICK_LOCK = 0.45;                        // 踢完之後自己這麼久之內控不到球(秒)
/* 而且球越快越難控 —— 一顆 15 m/s 的球不可能被站在旁邊的人原地黏住。
   門檻不是硬切,是「速度越高,這一格控到的機率越低」。 */
const CONTROL_SPEED = 14;                      // 超過這個速度基本上控不住(m/s)
const CARRY_AHEAD = 0.9;                       // 帶球時球在身前多遠

/* 行為 */
const PRESS_R = 14;                            // 這麼近的防守者才會去逼搶
const SIM_TACKLE_R = 1.3, TACKLE_RATE = 1.1;       // 進到這麼近之後,每秒這個機率把球捅走(乘防守能力)
/* 抄截之後兩件事必須成立,否則整場會退化成中圈的一團(實測第一版:90 分鐘 13,143 次抄截、
   跑動 11 m/分、85% 的時間站著)。原因是球被抄走之後新持球者旁邊就站著剛剛那個人,
   下一格他就變成逼搶者再抄回來,來回幾格一次,球哪裡都去不了,所以沒有人需要跑:
     1. 抄下來的球是**鬆的**,不是直接換人持球 —— 真的抄截本來就會把球捅開
     2. 剛被抄的人要有一小段搶不回來的時間,不然只是換個方向再來一次 */
const TACKLE_COOLDOWN = 1.6;                   // 抄截之後這段時間內不再判抄截(秒)
const TACKLE_POKE = [4, 9];                    // 抄下來的球被捅開的初速(m/s)
const SHIELD = 0.55;                           // 剛接到球的人這段時間內不會被抄(秒)
const BODY_R = 1.05;                           // 兩個人的身體不可以重疊到比這更近(公尺)
/* 逼搶要**保持距離**,不是貼著。第一版讓逼搶者停在一個身體的距離(1.05 m),
   實測最近防守者距離中位數 0.91 m、99.3% 的時間在 2 m 以內 —— 於是持球者永遠在最大壓力下,
   每次決定都選傳球(90 分鐘 7,555 次),球在腳下待不到一秒。
   真的防守是退著守(jockey),進到 2~3 m 盯著,抓到時機才撲。 */
const JOCKEY_R = 2.4;                          // 逼搶者維持的距離(公尺)
const CARRY_SPEED = 0.92;                      // 帶球速度佔自己最高速的比例(真人帶球比空跑慢一點)
/* 射門:階段 1 **只做動作,不產生進球**。
   沒有射門的話進攻沒有終點 —— 實測第一版帶球的人一路推到底線就停在那裡,
   球的 x 分佈兩頭各堆 40%、中場每段只剩 3.6%,整場球在兩條底線之間卡住。
   但「這一腳進不進」是要校準的(鐵則一:沒校準過的進球數就是編出來的),那是階段 2。
   所以這一版射門一律以門將沒收或出界收場,**畫面上不會有比分**。 */
const SHOOT_RANGE = 30;                        // 離球門這麼近才會想射(公尺)
const SHOT_SPEED = [18, 26];
const SIM_GOAL_HALF = 3.66;                    // 球門半寬(公尺)
const GOAL_HEIGHT = 2.44;
/* 射門頻率**綁在球隊自己的真實射門率上**(rates.sf)。
   這是 λ 錨能成立的前提:E[進球] = E[射門] × E[xG] × k,而 k 由 λ 閉式算出來。
   射門是模擬長出來的,但「多久出現一次夠好的機會」要跟真實球隊一致,不然 k 會補在錯的地方。
   SHOT_URGE 是唯一的全域旋鈕,量出來的(見 npm run game:sim):
   調到聯盟平均的球隊剛好射出聯盟平均的次數。 */
const SHOT_URGE = 0.20;   // 量出來的(見下)
/* xG 的**形狀**是遊戲模型(距離與張角),**水準**對回真實資料:
   XG_SCALE 調到模擬的每球平均 xG 等於聯盟真實的每球平均(league_.shotSituations)。
   形狀自己編、水準有出處 —— 兩件事要分開講,不然畫面上的 xG 就是編的。 */
const XG_SCALE = 1.0;                          // build 時不用,createSim 會依聯盟真實值自己算
const FOUL_ON_TACKLE = 0.22;                   // 抄截失敗變成犯規的機率(用 rates.fouls 校準)
const CORNER_SPEED = [12, 17];
const SIM_PASS_SPEED = [9, 22];                    // 傳球初速範圍(m/s),依距離
const SHAPE_BALL_PULL = 0.30;                  // 陣型跟著球平移的比例(FM 式的一整塊移動)
const SHAPE_COMPACT = 0.82;                    // 球在自己半場時陣型壓縮的比例
/* 防守方要有**防線**,不是只有一個逼搶者。第一版沒有這個,症狀很具體:
   前鋒可以一路帶到底線站著沒有人擋(球的 x 分佈兩頭各堆 40%、中場每段 3.5%),
   1,660 次射門 0 次中框 —— 因為射門點在底線旁邊、所有人擠在那裡,球一離腳就被撿回去。
   真正缺的是「站在球與自己球門之間」這件事,它同時決定了畫面像不像足球、以及大家跑不跑得動。 */
const LINE_DROP = 0.72;                        // 防線跟著球往自家門退的比例
const LINE_MIN = 9;                            // 防線最低不會低於自家門前這麼多公尺
const GOALSIDE = 2.6;                          // 盯人時站在對手與自家門之間多遠(公尺)
const MARK_R = 18;                             // 這麼近的對手才盯
/* 越位。**沒有這條規則,足球就不長那個樣子** —— 實測沒有它的時候前鋒一路帶到底線、
   防線跟著退,二十二個人擠在門前:球的 x 分佈兩頭各 21%、每場 70 次球門球、1 次界外球、
   射門 95 次而進球 0.58(射門都被人牆擋掉)。加上越位線,進攻方才會在一條線上等球。
   實作的是**位置上的**越位:進攻球員的陣型目標不會越過倒數第二名防守者(或中線,取靠後的)。 */
const OFFSIDE_MARGIN = 0.8;                    // 貼著線站(公尺)

const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hypot = (x, y) => Math.sqrt(x * x + y * y);

/* 亂數:同種子同結果。跟 game-engine 用同一支(mulberry32),兩台引擎的可重現性才是同一個意思 */
export function simRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* 陣型字串 → 每一列幾個人。"4-3-3" / "4-2-3-1" 都吃得下 */
export function formationRows(spec) {
  const n = String(spec ?? '4-3-3').split('-').map(x => parseInt(x, 10)).filter(x => x > 0);
  return n.length ? n : [4, 3, 3];
}

/* 陣型 → 每個位置在「自己進攻方向」的基準座標(x 往 105 是進攻方向)。
   門將自己一格,其餘逐列平均分配寬度。列的深度照列數均分在 8~62 m 之間 —— 這是版面不是戰術,
   真正的深度由防線高度指令在 shapeOf() 裡調。 */
export function formationSlots(spec) {
  const rows = formationRows(spec);
  const out = [{ role: 'GK', x: 5, y: PITCH_H / 2 }];
  const depth = (i) => 18 + (i / Math.max(1, rows.length - 1)) * 52;   // 18 → 70
  rows.forEach((count, i) => {
    const role = i === 0 ? 'DEF' : i === rows.length - 1 ? 'FWD' : 'MID';
    for (let k = 0; k < count; k++) {
      // 左右對稱分佈,邊路留 7 m 的邊
      const t = count === 1 ? 0.5 : k / (count - 1);
      out.push({ role, x: depth(i), y: 7 + t * (PITCH_H - 14) });
    }
  });
  return out;
}

/* 一個人的運動一步。
   回傳只改 p 自己 —— 決策在外面做完,這裡只負責「他到底能不能那樣動」。 */
function movePlayer(p, dt, want) {
  // want = { x, y, speed } 目標點與想要的速度;沒有目標就煞停
  const sp = hypot(p.vx, p.vy);
  if (!want) {
    const drop = Math.max(0, sp - SIM_DECEL * dt);
    if (sp > 1e-6) { p.vx = p.vx / sp * drop; p.vy = p.vy / sp * drop; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    return;
  }
  const dx = want.x - p.x, dy = want.y - p.y;
  const dist = hypot(dx, dy);
  let target = Math.min(want.speed ?? SIM_RUN, p.vmax);
  /* 靠近目標要收速度:v² = 2ad,不然會衝過頭再回頭,那看起來就是「抖」 */
  if (dist > 1e-6) target = Math.min(target, Math.sqrt(2 * SIM_DECEL * Math.max(0, dist - 0.15)));
  /* 要轉彎就先減速 —— 加速度有上限,全速的轉彎半徑 v²/a ≈ 4 m,比控球距離還大。
     這條是實測出來的:不減速的話接球者會繞著球轉圈,每一腳傳球都逾時(CLAUDE.md)。 */
  if (sp > 0.5 && dist > 1e-6) {
    const cos = (p.vx * dx + p.vy * dy) / (sp * dist);
    target *= cl(0.15 + 0.85 * (cos + 1) / 2, 0.15, 1);
  }
  const ux = dist > 1e-6 ? dx / dist : 0, uy = dist > 1e-6 ? dy / dist : 0;
  const wantVx = ux * target, wantVy = uy * target;
  const ex = wantVx - p.vx, ey = wantVy - p.vy;
  const need = hypot(ex, ey);
  // 煞車比加速快(真人也是)
  const a = (target < sp ? SIM_DECEL : SIM_ACCEL) * dt;
  if (need > a && need > 1e-6) { p.vx += ex / need * a; p.vy += ey / need * a; }
  else { p.vx = wantVx; p.vy = wantVy; }
  const now = hypot(p.vx, p.vy);
  if (now > p.vmax) { p.vx = p.vx / now * p.vmax; p.vy = p.vy / now * p.vmax; }
  p.x = cl(p.x + p.vx * dt, -1, PITCH_W + 1);
  p.y = cl(p.y + p.vy * dt, -1, PITCH_H + 1);
  p.dist += hypot(p.vx, p.vy) * dt;
  p.vtop = Math.max(p.vtop, hypot(p.vx, p.vy));
}

/* 球的一步。回傳「這一步有沒有落地」讓上層決定要不要算彈跳。 */
function moveBall(ball, dt) {
  if (ball.holder) return;
  if (ball.z > 0.01 || ball.vz > 0) {
    ball.vz -= GRAVITY * dt;
    ball.z += ball.vz * dt;
    const sp = hypot(ball.vx, ball.vy);
    if (sp > 1e-6) { const d = Math.min(sp, BALL_AIR * dt); ball.vx -= ball.vx / sp * d; ball.vy -= ball.vy / sp * d; }
    if (ball.z <= 0) { ball.z = 0; ball.vz = -ball.vz * BALL_BOUNCE; if (ball.vz < 0.6) ball.vz = 0; }
  } else {
    const sp = hypot(ball.vx, ball.vy);
    if (sp > 1e-6) { const d = Math.min(sp, BALL_FRICTION * dt); ball.vx -= ball.vx / sp * d; ball.vy -= ball.vy / sp * d; }
    else { ball.vx = 0; ball.vy = 0; }
  }
  ball.x += ball.vx * dt; ball.y += ball.vy * dt;
}

/* 一腳射門的 xG。
 *   d   —— 離球門中心的距離(公尺)
 *   ang —— 從射門點看過去,球門的張角(弧度)—— 角度越小越難進,這是 xG 模型的另一半
 * 形狀是遊戲模型(沒有人給我們逐球的真實 xG 模型),**水準**由呼叫端乘一個對回聯盟真實
 * 每球平均 xG 的係數。形狀與水準要分開:形狀編得出來,水準不准編。
 */
export function shotQuality(d, ang) {
  const byDist = Math.exp(-d / 11.5);
  const byAng = Math.pow(cl(ang / 0.85, 0, 1), 0.7);   // 0.85 rad ≈ 十二碼點看球門的張角
  return cl(byDist * byAng, 0.002, 0.95);
}

/* 從一個點看球門的張角。兩根門柱的夾角 —— 正面比側面大得多,這是「角度」真正的意思。 */
export function goalAngle(x, y, goalX) {
  const a = Math.atan2(PITCH_H / 2 + SIM_GOAL_HALF - y, Math.abs(goalX - x));
  const b = Math.atan2(PITCH_H / 2 - SIM_GOAL_HALF - y, Math.abs(goalX - x));
  return Math.abs(a - b);
}

/* 空中球的落點 —— 追球的人要追這裡,不是追球本身。
   朝球跑會在半路迎上一顆 21 m/s 的球(控不住),球飛過頭落在身後 20 m,回頭要兩秒。
   實測過:normal 模式 68 次逾時全是這個(CLAUDE.md)。 */
export function landingOf(ball) {
  if (ball.holder) return { x: ball.x, y: ball.y, t: 0 };
  if (ball.z <= 0.01 && ball.vz <= 0) {
    // 地滾球:摩擦停下來的地方
    const sp = hypot(ball.vx, ball.vy);
    if (sp < 1e-6) return { x: ball.x, y: ball.y, t: 0 };
    const t = sp / BALL_FRICTION;
    return { x: ball.x + ball.vx * t / 2, y: ball.y + ball.vy * t / 2, t };
  }
  // 空中球:解 z(t)=0
  const t = (ball.vz + Math.sqrt(Math.max(0, ball.vz * ball.vz + 2 * GRAVITY * ball.z))) / GRAVITY;
  return { x: ball.x + ball.vx * t, y: ball.y + ball.vy * t, t };
}

/* 陣型在這一刻該站的位置:一整塊跟著球平移,而且防守時壓縮。
   這是 FM 的 2D 看起來「像一支球隊」的原因 —— 十一個人不是各自找位置,是一塊一起動。
   att 是這一隊的進攻方向(+1 往 x=105,-1 往 x=0)。 */
export function shapeOf(slot, ball, att, opts = {}) {
  const pull = opts.pull ?? SHAPE_BALL_PULL;
  const compact = opts.compact ?? SHAPE_COMPACT;
  // 把 slot 從「自己的進攻座標」轉到球場座標
  const bx = att > 0 ? slot.x : PITCH_W - slot.x;
  const by = att > 0 ? slot.y : PITCH_H - slot.y;
  // 球在自己半場(依 att 判斷)→ 整塊往後壓且收窄
  const own = att > 0 ? ball.x < PITCH_W / 2 : ball.x > PITCH_W / 2;
  const cx = PITCH_W / 2, cy = PITCH_H / 2;
  let x = cx + (bx - cx) * (own ? compact : 1);
  let y = cy + (by - cy) * (own ? compact : 1);
  // 跟著球平移
  x += (ball.x - cx) * pull;
  y += (ball.y - cy) * pull;
  return { x: cl(x, 2, PITCH_W - 2), y: cl(y, 2, PITCH_H - 2) };
}

/* 一場連續時間的模擬。
 *   profile —— web/data/game/{聯賽}.json(本站真實資料建出來的側寫)
 *   home / away —— 隊碼
 *   setup —— { home: { xi, bench, formation }, away: {...} },沒給就用側寫裡的推估先發
 * 回傳的東西只有一種用途:讓畫面把「現在這一刻」畫出來。沒有任何腳本、沒有預先決定的結局。 */
export function createSim({ profile, home, away, seed = 1, setup = {}, pred = null } = {}) {
  const rng = simRng(seed);
  const teamOf = code => profile.teams[code];
  const mkSide = (code, side, att) => {
    const t = teamOf(code);
    const su = setup[side] ?? {};
    const spec = su.formation ?? t.formation ?? '4-3-3';
    const slots = formationSlots(spec);
    const byCode = new Map(t.squad.map(p => [p.code, p]));
    /* 先發:呼叫端給的優先,否則用側寫的推估先發。不足就從名單補 —— 缺人不是這一層該處理的事,
       但**不能靜靜少一個人**(十個人跑來跑去而畫面完全正常是最難發現的那種錯) */
    const want = (su.xi ?? t.xi ?? []).slice();
    const xi = [];
    for (const c of want) if (byCode.has(c) && xi.length < 11) xi.push(c);
    for (const p of t.squad) { if (xi.length >= 11) break; if (!xi.includes(p.code)) xi.push(p.code); }
    const players = xi.map((c, i) => {
      const p = byCode.get(c);
      const slot = slots[Math.min(i, slots.length - 1)];
      return {
        code: c, side, name: p?.name ?? c, role: slot.role, pos: p?.pos ?? slot.role,
        slot, x: att > 0 ? slot.x : PITCH_W - slot.x, y: att > 0 ? slot.y : PITCH_H - slot.y,
        vx: 0, vy: 0,
        // 逐人的真實最高速度當上限(km/h → m/s);沒有的人用聯盟量級的備援值,而且標出來
        vmax: p?.run?.topSpeed ? p.run.topSpeed / 3.6 : VMAX_FALLBACK,
        vmaxReal: !!p?.run?.topSpeed,
        ability: p?.ability ?? {},
        dist: 0, vtop: 0, off: false, going: false,
      };
    });
    return { code: code, side, att, spec, players, gk: players[0] };
  };

  const H = mkSide(home, 'home', +1), A = mkSide(away, 'away', -1);

  /* ── λ 錨(換引擎之後的新形式)──
   * 舊引擎自己決定射門次數,所以 k 閉式算得出來、E[進球] 精確等於 λ。
   * 連續模擬的射門是長出來的,所以錨只能成立在期望值上:
   *     E[進球] = E[射門] × E[xG|射門] × k
   * 三項各自的來源要分得清楚:
   *   E[射門]      —— 球隊自己的真實射門率(rates.sf,乘對手的被射門率),跟舊引擎同一個式子
   *   E[xG|射門]   —— 模擬的 xG 形狀在這個聯賽的平均(xgMean,下面用聯盟真實值對回水準)
   *   k            —— 由 λ 除出來,把兩者的乘積拉回站上的 λ
   * 所以「N 場平均落在 λ 的幾個標準誤內」是這一版的錨,不再是精確相等。這是換引擎的代價。 */
  const L = profile.league_ ?? {};
  const lgSf = L.rates?.sf ?? 12.6;
  /* 聯盟真實的每球平均 xG:用各情境的 xgPerShot 依 share 加權。
     沒有這一份就退回 0.105 並標出來 —— 但英超的產物一直都有。 */
  const realXgPerShot = (() => {
    const ss = L.shotSituations;
    if (!ss) return { v: 0.105, from: '預設值(側寫沒有 shotSituations)' };
    let num = 0, den = 0;
    for (const k of Object.keys(ss)) { const o = ss[k]; if (o?.share && o?.xgPerShot) { num += o.share * o.xgPerShot; den += o.share; } }
    return den > 0 ? { v: num / den, from: 'league_.shotSituations 依 share 加權' } : { v: 0.105, from: '預設值' };
  })();
  /* `rates` 是**分主客的**(`rates.home` / `rates.away`),不是平的。
     第一版寫 `t.rates.sf` —— 永遠是 undefined,於是每支球隊都退回聯盟平均、強弱完全沒進來。
     不拋錯、不報警,只是所有隊一模一樣(實測 expShots 兩邊都是 12.6)。 */
  const ratesOf = (code, where) => teamOf(code)?.rates?.[where] ?? {};
  const expShots = s => {
    const me = ratesOf(s.code, s.side), op = ratesOf(oppOf(s.side).code, s.side === 'home' ? 'away' : 'home');
    const sf = me.sf ?? lgSf, sa = op.sa ?? lgSf;
    return Math.max(1, sf * (sa / lgSf));
  };
  /* 射門機會的頻率乘數:球隊射門率越高,同樣的位置越常扣扳機。
     這樣「強隊射得多」是從球隊自己的真實資料來的,不是我給的偏好。 */
  const urgeOf = s => SHOT_URGE * (expShots(s) / lgSf);
  /* xG 形狀的**水準**校準:在禁區前沿一片常見的射門點上取樣,算出這個形狀的平均值,
     再乘一個係數讓它等於聯盟真實的每球平均 xG。形狀是遊戲模型、水準有出處。
     取樣點是固定網格(不吃亂數),所以這個係數對同一份側寫永遠一樣。 */
  const xgScale = (() => {
    let sum = 0, n = 0;
    for (let d = 6; d <= 30; d += 1.5) for (let off = 0; off <= 20; off += 2.5) {
      const x = PITCH_W - d, y = PITCH_H / 2 + off;
      sum += shotQuality(hypot(PITCH_W - x, PITCH_H / 2 - y), goalAngle(x, y, PITCH_W)); n++;
    }
    return n && sum > 0 ? realXgPerShot.v / (sum / n) : 1;
  })();
  const cal = { home: null, away: null };
  function calibrate(pred) {
    for (const side of ['home', 'away']) {
      const s = sideOf(side);
      const lam = Math.max(0.05, (side === 'home' ? pred?.xgHome : pred?.xgAway) ?? 1.35);
      const es = expShots(s);
      cal[side] = { lambda: lam, expShots: es, k: lam / (es * realXgPerShot.v) };
    }
  }
  const all = () => [...H.players, ...A.players].filter(p => !p.off);
  const sideOf = s => (s === 'home' ? H : A);
  const oppOf = s => (s === 'home' ? A : H);

  const ball = { x: PITCH_W / 2, y: PITCH_H / 2, z: 0, vx: 0, vy: 0, vz: 0, holder: null, shot: null };
  const st = {
    t: 0, half: 1, phase: 'kickoff', deadT: 0, restart: null,
    events: [], possSec: { home: 0, away: 0 }, touches: { home: 0, away: 0 },
    outs: 0, tackles: 0, passes: 0, loose: 0, shots: 0, onTarget: 0, keeperSaves: 0,
    goals: { home: 0, away: 0 }, xg: { home: 0, away: 0 }, willScore: 0, crossedLine: 0, lostShot: 0, lostGoal: 0,
    corners: { home: 0, away: 0 }, throwIns: 0, goalKicks: 0, fouls: { home: 0, away: 0 }, cards: { home: 0, away: 0 },
  };
  let decideIn = 0;      // 持球者下一次做決定還有幾秒

  /* 開球。**只有開賽那一次可以把人直接擺好** —— 進球之後的中圈開球不行:
     那會讓二十二個人瞬移(實測一場 682 次、最大 57 公尺),而「演出被切斷」正是要修的東西。
     進球之後改成放長死球時間,大家**走回去**;開球時球放中圈、由該開的人碰,
     站得還不夠整齊也沒關係 —— 真的比賽也不是所有人都站得剛剛好。 */
  function kickoff(side, { place = false } = {}) {
    if (place) for (const p of all()) {
      const s = sideOf(p.side);
      const pos = shapeOf(p.slot, { x: PITCH_W / 2, y: PITCH_H / 2 }, s.att);
      p.x = pos.x; p.y = pos.y; p.vx = 0; p.vy = 0;
      // 開球時不可以越過中線(規則,而且沒有它畫面一看就不對)
      if (p.side !== side) p.x = s.att > 0 ? Math.min(p.x, PITCH_W / 2 - 1) : Math.max(p.x, PITCH_W / 2 + 1);
    }
    ball.x = PITCH_W / 2; ball.y = PITCH_H / 2; ball.z = 0; ball.vx = 0; ball.vy = 0; ball.vz = 0; ball.shot = null;
    const s = sideOf(side);
    /* 開球的人是**離中圈最近的那個前場球員**,不是固定第幾個 ——
       固定的話他可能在另一個半場,一開球就是一次瞬移。 */
    const taker = pickNearest(s, PITCH_W / 2, PITCH_H / 2, true) ?? s.players[1];
    if (place) { taker.x = PITCH_W / 2 - s.att * 1.2; taker.y = PITCH_H / 2; }
    ball.holder = taker; taker.shield = SHIELD;
    st.phase = 'play'; decideIn = 0.4;
  }

  /* 把球交給某個人(控到球) */
  function giveTo(p) {
    ball.holder = p; ball.vx = 0; ball.vy = 0; ball.vz = 0; ball.z = 0;
    if (ball.shot) { st.lostShot++; if (ball.shot.willScore) st.lostGoal++; }
    ball.shot = null;               // 被人控到就不再是「飛向球門的那一腳」
    st.touches[p.side]++;
    p.shield = SHIELD;            // 剛接到球有一小段時間搶不走(不然抄截會變成來回互抄)
    /* 接到球**立刻**有方向 —— 第一版是等下一次 decide() 才給 intent,而在那之前 want 是 null、
       他會煞停。實測持球者速度中位數 0.11 m/s:球在誰腳下誰就站住,整場看起來沒有人在帶球。 */
    const s0 = sideOf(p.side);
    p.intent = { x: cl(p.x + s0.att * 14, 3, PITCH_W - 3), y: cl(p.y + (rng() - 0.5) * 8, 3, PITCH_H - 3) };
    decideIn = 0.35 + rng() * 0.45;
  }

  /* 踢球:目標點 + 初速 + 仰角。傳球一律踢向接球者的**提前量**(他會跑到哪),不是他現在站的地方 */
  function kick(from, tx, ty, speed, loft = 0) {
    const dx = tx - from.x, dy = ty - from.y, d = Math.max(0.1, hypot(dx, dy));
    ball.holder = null;
    from.kickLock = KICK_LOCK;
    ball.x = from.x + dx / d * 0.5; ball.y = from.y + dy / d * 0.5;
    ball.vx = dx / d * speed; ball.vy = dy / d * speed;
    ball.vz = loft; ball.z = loft > 0 ? 0.1 : 0;
    st.passes++;
  }

  /* 持球者的決定:帶球還是傳球。
     這裡刻意只有兩個選項 —— 射門與其他事件是階段 2,因為**沒校準過的進球數就是編出來的**。 */
  function decide(p) {
    const s = sideOf(p.side), o = oppOf(p.side);
    const goalX = s.att > 0 ? PITCH_W : 0;
    const pressure = o.players.reduce((best, q) => Math.min(best, hypot(q.x - p.x, q.y - p.y)), Infinity);
    /* 傳球對象:算每個隊友的分數 —— 往前、沒被盯、不要太遠。
       分數不是玄學,三項各自有理由:往前才有進展、被盯住傳過去就是送球、太遠成功率低。 */
    let best = null, bestScore = -Infinity;
    for (const m of s.players) {
      if (m === p || m.off) continue;
      const d = hypot(m.x - p.x, m.y - p.y);
      if (d < 3 || d > 45) continue;
      const forward = (m.x - p.x) * s.att;
      const marked = o.players.reduce((b, q) => Math.min(b, hypot(q.x - m.x, q.y - m.y)), Infinity);
      const score = forward * 0.6 + Math.min(marked, 12) * 1.4 - d * 0.25;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    /* 進到射程就可能射門 —— 越近越想射,而且沒人逼的時候更想。
       這一腳的結果不是進球(階段 1),但它讓一次進攻有**終點**,球才會回到中場重新開始。 */
    const dGoal = hypot(goalX - p.x, PITCH_H / 2 - p.y);
    if (dGoal < SHOOT_RANGE) {
      /* 扣不扣扳機看**機會的質量**(距離 + 張角),而頻率綁在球隊自己的真實射門率上。
         被逼得緊就比較不會射 —— 那是位置以外唯一進得來的因素,別的都要有資料才准加。 */
      const ang = goalAngle(p.x, p.y, goalX);
      const q = shotQuality(dGoal, ang);
      const urge = urgeOf(s) * (pressure < 3 ? 0.55 : 1) * (q / 0.08);
      if (rng() < cl(urge, 0, 0.9)) {
        const xg = cl(q * xgScale, 0.01, 0.95);
        const c = cal[p.side];
        const pGoal = cl(xg * (c?.k ?? 1), 0, 0.97);
        // 準度隨距離掉:遠射偏得多。偏差用球門寬度當尺,不是憑空的角度
        const miss = rng() >= pGoal;
        const err = miss
          ? (rng() < 0.5 ? -1 : 1) * (SIM_GOAL_HALF * (0.25 + rng() * 1.3) + dGoal * 0.06)
          : (rng() - 0.5) * 2 * SIM_GOAL_HALF * 0.75;
        const sp = SHOT_SPEED[0] + rng() * (SHOT_SPEED[1] - SHOT_SPEED[0]);
        kick(p, goalX, cl(PITCH_H / 2 + err, PITCH_H / 2 - 14, PITCH_H / 2 + 14), sp, miss && rng() < 0.4 ? 3.5 + rng() * 3 : 0);
        ball.shot = { by: p, side: p.side, xg, willScore: !miss };
        if (!miss) st.willScore++;
        st.shots++; st.xg[p.side] = Math.round((st.xg[p.side] + xg) * 1000) / 1000;
        p.intent = null;
        return { kind: 'shot' };
      }
    }
    // 壓力越大越想傳;沒有壓力就帶球往前
    const wantPass = best && (pressure < 4.5 ? rng() < 0.75 : rng() < 0.25);
    if (wantPass) {
      const d = hypot(best.x - p.x, best.y - p.y);
      const speed = cl(SIM_PASS_SPEED[0] + d * 0.35, SIM_PASS_SPEED[0], SIM_PASS_SPEED[1]);
      const flight = d / speed;
      // 提前量:接球者依他現在的速度會跑到哪
      /* 提前量要**夾在場內**:不夾的話接球者往邊線跑時目標會被推出界,
         實測一場 184 次界外球(真實約 40)。真的球員不會把球傳到線外。 */
      const tx = cl(best.x + best.vx * flight * 0.8, 2, PITCH_W - 2);
      const ty = cl(best.y + best.vy * flight * 0.8, 2, PITCH_H - 2);
      // 遠一點的球挑起來(過中間的人),近的貼地
      kick(p, tx, ty, speed, d > 22 ? 4.5 + rng() * 2 : 0);
      p.intent = null;
      return { kind: 'pass', to: best.code };
    }
    p.intent = { x: cl(p.x + s.att * 12, 3, PITCH_W - 3), y: cl(p.y + (rng() - 0.5) * 10, 3, PITCH_H - 3), goalX };
    return { kind: 'carry' };
  }

  /* 一個固定時步。所有決策都在這裡發生,沒有任何東西是事先寫好的。 */
  function tick(dt) {
    st.t += dt;
    if (st.phase === 'dead') {
      st.deadT -= dt;
      // 死球時大家照樣走回自己的位置(連續,不是淡出重擺)
      for (const p of all()) {
        const s = sideOf(p.side);
        const pos = shapeOf(p.slot, ball, s.att);
        movePlayer(p, dt, near(p, pos) ? null : { ...pos, speed: SIM_JOG });
      }
      if (st.deadT <= 0 && st.restart) {
        const r = st.restart; st.restart = null;
        if (r.kind === 'kickoff') kickoff(r.side);
        else { st.phase = 'play'; ball.x = r.x; ball.y = r.y; giveTo(r.taker); }
      }
      return;
    }

    const holder = ball.holder;
    if (holder) st.possSec[holder.side] += dt;

    // ── 決策 ──
    if (holder) {
      decideIn -= dt;
      if (decideIn <= 0) { decide(holder); decideIn = 0.8 + rng() * 0.9; }
    }

    // ── 每個人要往哪走 ──
    const land = landingOf(ball);
    const chasers = { home: null, away: null };
    if (!holder) {
      // 球是鬆的:兩隊各派離落點最近的人去追(追落點,不是追球)
      for (const side of ['home', 'away']) {
        let best = null, bd = Infinity;
        for (const p of sideOf(side).players) {
          if (p.off || p.role === 'GK') continue;
          const d = hypot(p.x - land.x, p.y - land.y);
          if (d < bd) { bd = d; best = p; }
        }
        chasers[side] = best;
      }
    }
    let presser = null;
    if (holder) {
      const o = oppOf(holder.side);
      let bd = PRESS_R;
      for (const q of o.players) {
        if (q.off || q.role === 'GK') continue;
        const d = hypot(q.x - holder.x, q.y - holder.y);
        if (d < bd) { bd = d; presser = q; }
      }
    }

    for (const p of all()) {
      const s = sideOf(p.side);
      let want = null;
      if (p === holder) {
        const it = p.intent;
        want = it ? { x: it.x, y: it.y, speed: p.vmax * CARRY_SPEED } : null;
      } else if (p === presser) {
        /* 逼搶:瞄準持球者的提前量,但**停在一個身體的距離之外** ——
           讓他跑到持球者身上的話,兩個圓點會疊在一起,而且下一格就抄到球、再下一格被抄回來。 */
        const hx = holder.x + holder.vx * 0.3, hy = holder.y + holder.vy * 0.3;
        const dx = p.x - hx, dy = p.y - hy, d = Math.max(0.01, hypot(dx, dy));
        want = { x: hx + dx / d * JOCKEY_R, y: hy + dy / d * JOCKEY_R, speed: p.vmax };
      } else if (!holder && p === chasers[p.side]) {
        want = { x: land.x, y: land.y, speed: p.vmax };
      } else if (p.role === 'GK') {
        // 門將:站在自己球門與球的連線上,離門線不遠
        const gx = s.att > 0 ? 0 : PITCH_W;
        const dx = ball.x - gx, dy = ball.y - PITCH_H / 2, d = Math.max(1, hypot(dx, dy));
        want = { x: gx + dx / d * 5.5, y: cl(PITCH_H / 2 + dy / d * 5.5, 20, PITCH_H - 20), speed: SIM_JOG };
      } else {
        let pos = shapeOf(p.slot, ball, s.att);
        /* 有球的那一隊:前場的人不越過越位線。這一行是「看起來像足球」的另一半 ——
           沒有它前鋒會站到對方底線,防線跟著退,整場擠在門前。 */
        if (holder && holder.side === p.side && p.role !== 'GK') {
          const line = offsideLine(p.side);
          pos = { x: s.att > 0 ? Math.min(pos.x, line) : Math.max(pos.x, line), y: pos.y };
        }
        /* 沒有球的那一隊:整條隊形退到球的**自家門那一側**,後衛再各自盯一個最近的對手。
           這一段是「看起來像不像足球」的主要來源 —— 沒有它,防守方只是散在自己的格子裡。 */
        if (holder && holder.side !== p.side) {
          const goalX = s.att > 0 ? 0 : PITCH_W;
          // 防線:球往哪邊走,整條線跟著退,但不會退進自家門
          const lineX = goalX + (ball.x - goalX) * (1 - LINE_DROP);
          const behindBall = s.att > 0 ? Math.min(pos.x, Math.max(lineX, LINE_MIN)) : Math.max(pos.x, Math.min(lineX, PITCH_W - LINE_MIN));
          pos = { x: behindBall, y: pos.y };
          if (p.role !== 'FWD') {
            // 盯最近的對手:站在他與自家門之間
            let m = null, md = MARK_R;
            for (const q of oppOf(p.side).players) {
              if (q.off || q === holder || q.role === 'GK') continue;
              const d = hypot(q.x - pos.x, q.y - pos.y);
              if (d < md) { md = d; m = q; }
            }
            if (m) {
              const dx = goalX - m.x, dy = PITCH_H / 2 - m.y, d = Math.max(0.1, hypot(dx, dy));
              pos = { x: cl(m.x + dx / d * GOALSIDE, 2, PITCH_W - 2), y: cl(m.y + dy / d * GOALSIDE, 2, PITCH_H - 2) };
            }
          }
        }
        /* 閒置走位的兩個門檻:離目標 1.5 m 才起步、進到 0.4 m 才停。
           單一門檻那版反而讓翻轉從 3.4 升到 5.3 —— 站在門檻邊上的人被會飄的目標拉來拉去(CLAUDE.md) */
        const d = hypot(pos.x - p.x, pos.y - p.y);
        if (p.going) { if (d < IDLE_STOP) p.going = false; } else if (d > IDLE_GO) p.going = true;
        /* 歸位是**慢跑**,不是衝刺 —— 只有離位置很遠才跑。
           逐位置量出來的證據:第一版 DEF 113 m/分(正好是真實值)、MID 143、FWD 169,
           而距離裡有 17.3% 是衝刺(真實足球不到一成)。差別就在這一行:
           原本超過 12 m 就用跑的,而前鋒的陣型目標會跟著球大幅擺動,於是整場在衝。 */
        want = p.going ? { x: pos.x, y: pos.y, speed: d > 22 ? SIM_RUN : d > 6 ? SIM_JOG : SIM_WALK } : null;
      }
      movePlayer(p, dt, want);
    }

    // ── 球 ──
    /* **要重新讀 ball.holder,不能用這一格開頭抓的那個 local。**
       decide() 在上面可能已經把球踢出去(kick 會把 ball.holder 設成 null),
       而舊的 local 還指著那個人 —— 於是這裡走「帶球」那條路,把球瞬間拉回他腳下、
       速度蓋成他的速度(停著就是 0)。實測的症狀:97 腳射門有 93 腳在飛行中「被人控走」,
       而被控走時的球速是 **0**、位置就在門前 —— 一顆 20 m/s 的球不可能兩公尺內停下來。
       每一腳傳球也一樣被蓋掉,所以整場 3,000 次傳球、球永遠在原地、一球不進。 */
    const carrier = ball.holder;
    if (carrier) {
      // 球跟著帶球的人,放在身前
      const holder = carrier;
      const sp = hypot(holder.vx, holder.vy);
      const ux = sp > 0.2 ? holder.vx / sp : (sideOf(holder.side).att), uy = sp > 0.2 ? holder.vy / sp : 0;
      ball.x = holder.x + ux * CARRY_AHEAD; ball.y = holder.y + uy * CARRY_AHEAD; ball.z = 0;
      ball.vx = holder.vx; ball.vy = holder.vy;
    } else {
      moveBall(ball, dt);
      // 有人控到球?(離球夠近、球夠低、球不會太快)
      const sp = hypot(ball.vx, ball.vy);
      if (ball.z < 0.6) {
        let best = null, bd = SIM_CONTROL_R;
        for (const p of all()) {
          if ((p.kickLock ?? 0) > 0) continue;          // 剛把球踢出去的人不算
          const d = hypot(p.x - ball.x, p.y - ball.y);
          if (d < bd) { bd = d; best = p; }
        }
        // 球越快越控不住:一格的成功機率隨速度掉,不是硬門檻
        if (best) {
          const pCtl = cl(1 - sp / CONTROL_SPEED, 0, 1);
          if (rng() < pCtl) { giveTo(best); st.loose++; }
        }
      }
      /* 越過門線的三種結果:進球 / 角球 / 球門球。哪一種由「最後碰到球的是誰」決定,
         那是足球規則,不是我挑的 —— 攻方最後碰到就是球門球,守方碰到就是角球。 */
      if (ball.x < 0 || ball.x > PITCH_W) {
        const inFrame = Math.abs(ball.y - PITCH_H / 2) < SIM_GOAL_HALF && ball.z < GOAL_HEIGHT;
        const conceding = ball.x < 0 ? 'home' : 'away';     // 這一側的球門是誰的
        const scoring = conceding === 'home' ? 'away' : 'home';
        st.crossedLine++;
        if (inFrame) {
          /* 射正了 —— 進不進在射門那一刻就由 xG × k 決定(willScore),
             這裡只是把它演出來。門將撲救不另外擲一次骰子:那會讓 λ 的錨失效。 */
          st.onTarget++;
          if (ball.shot?.willScore && ball.shot.side === scoring) scoreGoal(scoring, ball.shot.by);
          else { st.keeperSaves++; keeperCollect(conceding); }
        } else if (st.lastTouch === scoring) {
          goalKick(conceding);                               // 攻方碰出底線 → 球門球
        } else {
          corner(scoring === 'home' ? 'away' : 'home', ball.y < PITCH_H / 2 ? 0.5 : PITCH_H - 0.5, ball.x < 0 ? 0.5 : PITCH_W - 0.5);
        }
      } else if (ball.y < 0 || ball.y > PITCH_H) throwIn();
    }

    // ── 抄截 ──
    st.tackleCool = Math.max(0, (st.tackleCool ?? 0) - dt);
    if (ball.holder && presser && st.tackleCool <= 0 && (ball.holder.shield ?? 0) <= 0) {
      const d = hypot(presser.x - ball.holder.x, presser.y - ball.holder.y);
      if (d < SIM_TACKLE_R) {
        const skill = 0.6 + (presser.ability?.tkl ?? 0.2);
        if (rng() < TACKLE_RATE * skill * dt) {
          /* 球被捅開變成鬆球(不是直接換人持球):方向大致是防守者的來向,速度隨機。
             這樣兩邊都要去追,而追球本身就是跑動 —— 這也是「看起來像在踢球」的一大半。 */
          const victim = ball.holder;
          const ang = Math.atan2(victim.y - presser.y, victim.x - presser.x) + (rng() - 0.5) * 1.6;
          const sp = TACKLE_POKE[0] + rng() * (TACKLE_POKE[1] - TACKLE_POKE[0]);
          ball.holder = null; ball.z = 0; ball.vz = 0;
          ball.x = victim.x; ball.y = victim.y;
          ball.vx = Math.cos(ang) * sp; ball.vy = Math.sin(ang) * sp;
          victim.shield = 0; st.tackleCool = TACKLE_COOLDOWN; st.tackles++;
        }
      }
    }
    for (const p of all()) { if (p.shield > 0) p.shield -= dt; if (p.kickLock > 0) p.kickLock -= dt; }
  }

  const near = (p, pos) => hypot(pos.x - p.x, pos.y - p.y) < IDLE_STOP;

  /* 進球。比分、事件、然後由失球方中圈開球 —— 開球本身走 kickoff(),
     所有人都是**走回去**站位的(連續),不是淡出重擺。 */
  function scoreGoal(side, by) {
    st.goals[side]++;
    st.events.push({ t: Math.round(st.t), kind: 'goal', side, by: by?.code ?? null, name: by?.name ?? null, xg: ball.shot?.xg ?? null });
    ball.shot = null;
    /* 進球之後的死球時間放長:真的比賽慶祝加回中圈要幾十秒,而這段時間**畫面上大家是走回去的**。
       這不是「等」,是讓重新站位有時間連續地發生 —— 不然就得瞬移。 */
    st.phase = 'dead'; st.deadT = 22 + rng() * 12;
    st.restart = { kind: 'kickoff', side: side === 'home' ? 'away' : 'home' };
  }

  /* 角球:主罰者跑到角旗,把球傳進禁區 —— 不是把球瞬間放到某個人腳下 */
  function corner(side, cy, cx) {
    const s = sideOf(side);
    const taker = pickNearest(s, cx, cy, true) ?? s.players[1];
    st.corners[side]++;
    deadBall({ kind: 'corner', side, taker, x: cx, y: cy, wait: 2.0 + rng() * 1.5 });
  }
  function goalKick(side) {
    const s = sideOf(side);
    st.goalKicks++;
    deadBall({ kind: 'goalkick', side, taker: s.gk, x: s.att > 0 ? 5.5 : PITCH_W - 5.5, y: PITCH_H / 2, wait: 1.6 + rng() * 1.4 });
  }
  function throwIn() {
    const side = st.lastTouch === 'home' ? 'away' : 'home';
    const x = cl(ball.x, 1, PITCH_W - 1), y = ball.y < PITCH_H / 2 ? 0.4 : PITCH_H - 0.4;
    st.throwIns++;
    deadBall({ kind: 'throwin', side, taker: pickNearest(sideOf(side), x, y, true), x, y, wait: 1.2 + rng() * 1.0 });
  }
  function deadBall({ kind, side, taker, x, y, wait }) {
    const s = sideOf(side);
    ball.holder = null; ball.vx = 0; ball.vy = 0; ball.vz = 0; ball.z = 0; ball.x = x; ball.y = y; ball.shot = null;
    st.phase = 'dead'; st.deadT = wait;
    st.restart = { kind, side, taker: taker ?? s.players[1], x, y };
    st.outs++;
  }
  /* 越位線:對手倒數第二名防守者的 x(含門將),跟中線取靠自己後場的那一個。
     這是規則本身,不是我調的參數。 */
  function offsideLine(side) {
    const s = sideOf(side), o = oppOf(side);
    const xs = o.players.filter(p => !p.off).map(p => p.x).sort((a, b) => (s.att > 0 ? b - a : a - b));
    const second = xs.length >= 2 ? xs[1] : (xs[0] ?? PITCH_W / 2);
    return s.att > 0 ? Math.max(PITCH_W / 2, second) + OFFSIDE_MARGIN : Math.min(PITCH_W / 2, second) - OFFSIDE_MARGIN;
  }

  const pickNearest = (s, x, y, outfieldOnly = false) => {
    let best = null, bd = Infinity;
    for (const p of s.players) { if (p.off || (outfieldOnly && p.role === 'GK')) continue; const d = hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
    return best;
  };

  /* 門將沒收:球回到自己的門將腳下,死球一下再開出去 */
  function keeperCollect(side) {
    const s = sideOf(side);
    deadBall({ kind: 'keeper', side, taker: s.gk, x: cl(s.att > 0 ? 6 : PITCH_W - 6, 1, PITCH_W - 1), y: PITCH_H / 2, wait: 1.8 + rng() * 1.4 });
    st.outs--;   // 門將沒收不是出界,deadBall 裡那一筆要扣回來
  }

  /* 出界 → 死球 → 由對方在邊線 / 底線重新開始。
     這一版不分界外球 / 球門球 / 角球的細節(那跟事件一起在階段 2),但**球權與位置是真的**,
     不是隨便給一個人 —— 隨便給會讓畫面上看起來像「球莫名其妙換邊」。 */


  calibrate(pred);
  kickoff('home', { place: true });   // 開賽那一次才直接擺位

  return {
    /* 畫面要跑多快就給多少秒 —— 物理照固定時步走,所以倍速不會改變結果的物理正確性。
       這是「連續播放」的基礎:不用剪接也能把 90 分鐘壓進十分鐘。 */
    advance(seconds) {
      let left = Math.max(0, seconds), steps = 0;
      while (left > 1e-9 && steps < MAX_STEPS) {
        const dt = Math.min(SIM_DT, left);
        if (ball.holder) st.lastTouch = ball.holder.side;
        tick(dt);
        left -= dt; steps++;
      }
      return steps;
    },
    state: () => ({
      t: st.t, phase: st.phase, half: st.half,
      ball: { x: ball.x, y: ball.y, z: ball.z, vx: ball.vx, vy: ball.vy, holder: ball.holder?.code ?? null, holderSide: ball.holder?.side ?? null },
      players: all().map(p => ({ code: p.code, side: p.side, name: p.name, role: p.role, x: p.x, y: p.y, vx: p.vx, vy: p.vy, vmax: p.vmax, vmaxReal: p.vmaxReal })),
      score: [st.goals.home, st.goals.away], xg: { ...st.xg },
      diag: { willScore: st.willScore, crossedLine: st.crossedLine, lostShot: st.lostShot, lostGoal: st.lostGoal },
      poss: { ...st.possSec },
      counts: { outs: st.outs, tackles: st.tackles, passes: st.passes, loose: st.loose, shots: st.shots, onTarget: st.onTarget,
        keeperSaves: st.keeperSaves, corners: { ...st.corners }, throwIns: st.throwIns, goalKicks: st.goalKicks,
        fouls: { ...st.fouls }, cards: { ...st.cards } },
    }),
    /* 量測用:跑動量、最高速、控球 —— 這幾個要對得回 FotMob 的真實值,不然「像不像在踢球」沒有判準 */
    motion: () => ({
      secs: st.t,
      players: all().map(p => ({ code: p.code, side: p.side, role: p.role, dist: p.dist, vtop: p.vtop, vmax: p.vmax, vmaxReal: p.vmaxReal })),
    }),
    events: () => st.events.map(e => ({ ...e })),
    teams: { home: { code: H.code, spec: H.spec }, away: { code: A.code, spec: A.spec } },
    /* λ 錨的來源要**看得到**:哪一項是真實資料、哪一項是遊戲模型,畫面與測試都讀這裡。
       不給這個的話「E[進球] = λ」就變成一句沒有出處的宣稱。 */
    calibration: () => ({
      xgPerShotReal: Math.round(realXgPerShot.v * 10000) / 10000, xgPerShotFrom: realXgPerShot.from,
      xgScale: Math.round(xgScale * 1000) / 1000,
      home: cal.home && { ...cal.home, k: Math.round(cal.home.k * 1000) / 1000 },
      away: cal.away && { ...cal.away, k: Math.round(cal.away.k * 1000) / 1000 },
    }),
  };
}
