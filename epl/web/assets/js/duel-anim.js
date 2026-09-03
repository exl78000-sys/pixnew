/* 對戰模擬的 2D 跑位動畫(FM 式俯視火柴人)。
 *
 * **這整個模組是程序化演出**,界線在頁面上寫死:
 * - 真資料:陣型(官方逐場陣型的最近一場)、名單(本季上場時間前 11 人,
 *   按位置填進陣型格)、隊色、比分與進球時刻(模型抽樣)。
 * - 演出:球員每一步移動、每一次傳球、攻防節奏 —— 本站沒有跑動與逐球
 *   資料源,這些是動畫引擎自己編排的戲。FM 的點會動是因為它有自己的
 *   比賽引擎;我們沒有,所以照實叫它「演出」。
 * - 決定性:所有隨機都走呼叫端給的 rng(種子衍生)—— 同種子重播,
 *   連跑位劇本都一樣。
 *
 * **不引入遊戲引擎是刻意的。** 場上只有 23 個實體、一個 rAF 迴圈,渲染
 * 從來不是瓶頸;引擎給的 sprite 批次、場景樹、物理在這裡一樣都用不到,
 * 卻要付零依賴與單檔版體積的代價。真正決定像不像在踢球的是下面這層
 * 行為模型(跑位、傳球路線、壓迫),那跟用什麼畫圖無關。
 * 還有一個這個專案特有的理由:畫面越像實況,越暗示「這場就是這樣踢的」,
 * 而本站沒有跑位軌跡(追蹤座標)資料 —— 有的是每場跑動量與逐射門位置,不是誰在哪一秒站哪 ——
 * 示意圖比擬真更誠實(鐵則四)。
 */

/* 2026-09-03(模擬遊玩):動畫從「自己編戲」變成「照劇本演」。引擎(game-engine.js)產的事件
 * 由 `perform(e)` 進來:換人(圓點改名)、紅牌(圓點退場)、黃牌(閃一下)、射門不進(演一段推進
 * 再射偏/被撲/被封)、角球(球擺到角旗、主罰者持球)。進球仍走 setState 的 dueSides(排幾顆演幾顆,
 * 那條測試守著)。控球由 `possHome`(引擎抽的目標)決定,沒給才退回 λ 的份額。
 * 誰拿球、往哪跑仍然是演出 —— 這一層只保證畫面跟面板講的是同一件事(場上幾個人、誰在場上)。 */
const FW = 105, FH = 68;          // 球場座標(公尺),畫布再縮放
const PASS_MIN = 0.55, PASS_MAX = 1.15;   // 傳球間隔(秒)
const PASS_SPEED = 17, SHOT_SPEED = 27;   // 球速(公尺/秒)—— 球不再瞬移
const LANE_R = 3.4;               // 「站在傳球路線上」的判定半徑(公尺)
const BOX_X = 16.5;               // 禁區深度,射門區由它推
const BREAK_MAX = 6;              // 快攻演出的上限秒數(超時強制收尾,見下)
const AVOID_R = 4.6;              // 球員進入這個距離才需要繞行(公尺)
const AVOID_MAX = 4.2;            // 避讓只改演出目標,不把球員推到別處(公尺)
const MIN_SEP = 1.6;              // 位置層兜底:兩個人不會比這更近(公尺;圓點半徑約 0.9 m)

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

/* 名單:players-core 依位置分桶、桶內按本季分鐘排,填進陣型格。
   位置正規化(西甲 D/M/F)。人不夠的格子留空名 —— 不發明球員。 */
export function pickXI(corePlayers, rows, season) {
  const norm = p => ({ GK: 'GK', DEF: 'DEF', MID: 'MID', FWD: 'FWD', D: 'DEF', M: 'MID', F: 'FWD' }[p] ?? null);
  const minutesOf = p => p.seasons?.find(s => s.season === season)?.minutes
    ?? p.seasons?.[0]?.minutes ?? 0;
  const pool = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of corePlayers ?? []) {
    const b = norm(p.pos);
    if (b) pool[b].push(p);
  }
  for (const b of Object.values(pool)) b.sort((a, x) => minutesOf(x) - minutesOf(a));
  const need = { GK: 1, DEF: rows[0], FWD: rows[rows.length - 1],
    MID: rows.slice(1, -1).reduce((a, b) => a + b, 0) };
  const xi = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const b of ['GK', 'DEF', 'MID', 'FWD']) {
    xi[b] = pool[b].slice(0, need[b]).map(p => p.name);
    // 桶不夠人就從分鐘最多的其他人補位(照實仍是真名單,只是位置不對口)
    let spare = Object.values(pool).flat().filter(p => !Object.values(xi).flat().includes(p.name));
    while (xi[b].length < need[b] && spare.length) xi[b].push(spare.shift().name);
  }
  return xi;
}

/*
 * 球員彼此接近時沿切線繞行，而不是把人硬推開。這是純幾何的目標偏移:
 * 不讀比分、不讀 λ、也不改 holder 或進球排程，所以避讓只能改畫面路線。
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

/* 測試用的內部狀態出口(唯讀快照,外面改不到東西)。
   這個模組會出的錯是「演出把腳本吞掉」那一類 —— 掃原始碼掃不出來,
   要真的跑一遍再看內部狀態。指向最後一次掛載的那個實例。 */
let probe = () => null;
export const __animProbe = () => probe();

export function mountDuelAnim(canvas, { home, away, homeCode = '', awayCode = '', lambdaHome, lambdaAway, rng, possHome = null }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pad = 26;
  const sx = x => pad + (x / FW) * (W - pad * 2);
  const sy = y => pad + (y / FH) * (H - pad * 2);

  const mkTeam = (side, spec) => {
    const rows = parseFormation(spec.formation);
    const slots = slotsOf(rows);
    const names = spec.xi ?? { GK: [], DEF: [], MID: [], FWD: [] };
    const used = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    return slots.map(s => {
      const idx = used[s.role]++;
      const name = names[s.role]?.[idx] ?? null;
      const shirt = spec.shirts?.[s.role]?.[idx] ?? null;
      const bx = side === 'home' ? s.x : FW - s.x;   // 上半場的基準;下半場鏡射(真足球會換邊)
      return { side, role: s.role, name, shirt, off: false, flash: 0,
        bx0: bx, by: s.y, x: bx, y: s.y,
        ph: rng() * Math.PI * 2, color: spec.color };
    });
  };
  const players = [...mkTeam('home', home), ...mkTeam('away', away)];
  let shareHome = possHome ?? lambdaHome / (lambdaHome + lambdaAway || 1);
  const active = () => players.filter(p => !p.off);   // 被罰下的人不在場上
  let pendingShot = null;            // {side, outcome} 射門不進的演出
  let cornerFlag = null;             // 角球:球在角旗,主罰者持球

  // 戲的狀態
  let st = { min: 0, done: false, hs: 0, as: 0 };
  let half = 1;                      // 下半場換邊(真足球行為)
  let goalsPlayed = 0;
  let pendingGoal = null;            // {side} 進球分鐘到了 → 演一段快攻收尾
  let pendingKickoff = null;         // 進球慶祝結束 → 失球方中圈開球
  const baseX = p => (half === 1 ? p.bx0 : FW - p.bx0);
  const dirOf = side => (side === 'home' ? 1 : -1) * (half === 1 ? 1 : -1);
  const goalX = side => (dirOf(side) === 1 ? FW : 0);        // 這一隊要攻的球門
  const ownGoalX = side => (dirOf(side) === 1 ? 0 : FW);
  let holder = players.find(p => p.side === 'home' && p.role === 'MID') ?? players[0];
  const ball = { x: FW / 2, y: FH / 2, tx: 0, ty: 0, t: 1, from: null, dur: 0.3 };
  let passClock = 0.9, celebrate = 0, push = 0;   // push:控球方整條線往前壓的量
  let simT = 0;                     // 模擬時鐘。抖動不要吃 performance.now(),
                                    // 那是牆上時間,會讓「同種子同劇本」這句話不成立
  let presser = null, runner = null;   // 上搶的人、前插支援的中場(每格重算)
  let breakClock = 0;               // 快攻演出已經演多久

  /* 球有速度了。原本是「t 每秒 +2.6」,等於距離越遠飛越快、近距離瞬移;
     有了飛行時間才談得上「傳球路線上有沒有人」。 */
  function launch(tx, ty, speed) {
    ball.from = { x: ball.x, y: ball.y };
    ball.tx = tx; ball.ty = ty; ball.t = 0;
    ball.dur = Math.max(0.1, Math.hypot(tx - ball.x, ty - ball.y) / speed);
  }

  /* 傳球路線上離球最近的對手,連同「在哪裡被切斷」。
     **誰**攔到、在**哪一點**攔到由路線決定;但「這一球會不會被攔」仍然由
     控球權模型(λ 推出的 share)決定 —— 讓路線去決定機率的話,畫面上的
     控球會跟旁邊那張模型預測打架,而那張表才是有出處的東西。 */
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

  /* 中圈開球:球回中點、開球方中場持球、雙方回基準站位 */
  function kickoff(side) {
    const mids = active().filter(p => p.side === side && p.role === 'MID');
    holder = mids.sort((a, b) => Math.abs(a.by - FH / 2) - Math.abs(b.by - FH / 2))[0]
      ?? players.find(p => p.side === side) ?? players[0];
    ball.from = null; ball.x = FW / 2; ball.y = FH / 2; ball.t = 1;
    push = 0; passClock = 0.9; breakClock = 0;
  }
  kickoff('home');

  function chooseNext() {
    const mates = active().filter(p => p.side === holder.side && p !== holder && p.role !== 'GK');
    const dir = dirOf(holder.side);
    // 前傳偏好:越靠對方球門權重越高;快攻(pendingGoal / pendingShot)時強制找最前面的
    const w = p => Math.max(0.05, 1 + dir * (p.x - holder.x) / 30) * ((pendingGoal || pendingShot) ? (p.role === 'FWD' ? 4 : 1) : 1);
    let tot = mates.reduce((a, p) => a + w(p), 0), r = rng() * tot;
    for (const p of mates) { r -= w(p); if (r <= 0) return p; }
    return mates[mates.length - 1];
  }

  /* 丟球。原本是「對方非門將隨機挑一個」—— 球憑空換邊,看不出為什麼。
     現在球權由**這一球要傳去哪**決定:路線上有人就在那一點被切斷,
     沒有人才退回「最靠近接應點的人把球贏走」。機率完全沒變(見 laneCut)。 */
  function turnover(target) {
    const cut = target ? laneCut(ball, target, holder.side) : null;
    if (cut && cut.d < LANE_R * 2.2) {
      holder = cut.o;
      launch(cut.x, cut.y, PASS_SPEED);
    } else {
      const opp = active().filter(p => p.side !== holder.side && p.role !== 'GK');
      const near = target
        ? opp.reduce((a, b) => (Math.hypot(b.x - target.x, b.y - target.y)
          < Math.hypot(a.x - target.x, a.y - target.y) ? b : a), opp[0])
        : opp[Math.floor(rng() * opp.length)];
      holder = near ?? opp[0];
      launch(holder.x, holder.y, PASS_SPEED);
    }
    push = 0;
  }

  /* 射門:把球送進球門、開慶祝、排失球方開球。抽出來是因為現在有兩個入口 ——
     前鋒跑到禁區線時射,以及快攻演出超時的保底射門(見 BREAK_MAX)。 */
  function shoot() {
    const dir = dirOf(holder.side);
    const scorer = holder.side;
    launch(dir === 1 ? FW - 1 : 1, FH / 2 + (rng() - 0.5) * 6, SHOT_SPEED);
    celebrate = 1.6; goalsPlayed++;
    pendingGoal = null; push = 0; breakClock = 0;
    pendingKickoff = scorer === 'home' ? 'away' : 'home';   // 失球方開球
  }

  /* 射門不進:球往球門飛,結果決定它停在哪 —— 被撲出到門將手上、射偏出底線、被封阻到最近的防守者、
     中柱彈回。演完由防守方(門將或封阻者)持球,不開球。 */
  function shootMiss(outcome) {
    const dir = dirOf(holder.side), side = holder.side, gx = goalX(side);
    const gk = active().find(p => p.side !== side && p.role === 'GK');
    const flash = { side, outcome, t: 1.4 };
    if (outcome === 'blocked') {
      const cut = laneCut(ball, { x: gx, y: FH / 2 }, side);
      holder = cut?.o ?? gk ?? holder;
      launch(cut ? cut.x : gx - dir * 12, cut ? cut.y : FH / 2, SHOT_SPEED);
    } else if (outcome === 'saved') {
      holder = gk ?? holder;
      launch(gx - dir * 3, FH / 2 + (rng() - 0.5) * 5, SHOT_SPEED);
    } else if (outcome === 'post') {
      holder = gk ?? holder;
      launch(gx - dir * 1, FH / 2 + (rng() < 0.5 ? -3.7 : 3.7), SHOT_SPEED);
    } else {
      holder = gk ?? holder;
      launch(gx, FH / 2 + (rng() < 0.5 ? -1 : 1) * (5 + rng() * 6), SHOT_SPEED);
    }
    lastShot = flash; pendingShot = null; push = 0; breakClock = 0;
  }
  let lastShot = null;               // 剛射門的提示(畫面上閃一行字)

  /* 無球跑位。原本除了持球者以外全部待在基準點附近漂 —— 那是站著看,
     不是踢球。這裡按角色分工,全部是幾何,**不影響比分**(進球仍由模型排程)。 */
  function aim(p) {
    if (p === holder) return { x: ball.x, y: ball.y };
    const dir = dirOf(p.side);
    const attacking = p.side === holder.side;
    const bx = baseX(p);
    // 門將:貼自家球門,橫向跟著球移動一點點
    if (p.role === 'GK') return { x: ownGoalX(p.side) + dir * 4.5, y: FH / 2 + (ball.y - FH / 2) * 0.35 };

    if (attacking) {
      // 球推進到對方半場多深(0~1)——整條線往前壓多少由它決定,不是固定值
      const adv = Math.min(1, Math.max(0, (dir * (ball.x - FW / 2)) / (FW / 2) * 0.5 + 0.5));
      const ADV = { DEF: 8, MID: 15, FWD: 24 }[p.role] ?? 10;
      let x = bx + dir * ADV * adv + push * dir * 0.4;
      // 邊路拉寬:離中線遠的人再往邊線站,把場地撐開
      const wide = Math.abs(p.by - FH / 2) > FH / 5;
      const y = p.by + (wide ? Math.sign(p.by - FH / 2) * 4.2 * adv : 0);
      if (p === runner) x += dir * 9;              // 一名中場前插支援
      /* 快攻演出:進球方的前鋒直接跑到禁區線。沒有這一段的話射門門檻永遠
         碰不到 —— 原本前鋒基準 x=53.26、快攻加成上限 18、抖動 2.2,最遠
         73.5,而門檻寫死 78,所以腳本進球一次都演不出來(實測整場 0 次),
         pendingGoal 還會永遠清不掉、把模擬卡在快攻模式。 */
      const rush = pendingGoal ?? pendingShot;
      if (rush && p.side === rush.side && p.role === 'FWD') {
        return { x: goalX(p.side) - dir * (BOX_X - 2), y: FH / 2 + (p.by - FH / 2) * 0.5 };
      }
      // 角球:進攻方湧進禁區,主罰者(持球)留在角旗
      if (cornerFlag && p.side === cornerFlag.side && p.role !== 'GK') {
        return { x: goalX(p.side) - dir * (6 + rng() * 6), y: FH / 2 + (p.by - FH / 2) * 0.35 };
      }
      return { x, y };
    }

    // 上搶:離球最近的那個真的去搶球,不是整隊平移
    if (p === presser) {
      const d = Math.max(1.8, Math.hypot(ball.x - p.x, ball.y - p.y));
      const k = 1.8 / d;
      return { x: ball.x + (p.x - ball.x) * k, y: ball.y + (p.y - ball.y) * k };
    }
    // 防線高度跟著球走:球在自家半場就退,球在對方半場就壓上
    const BACK = { DEF: 15, MID: 7, FWD: -4 }[p.role] ?? 8;
    const line = ball.x - dir * BACK;
    const squeeze = (ball.y - p.by) * 0.22;        // 朝球收縮,壓縮防守寬度
    return { x: bx + (line - bx) * (p.role === 'FWD' ? 0.25 : 0.6), y: p.by + squeeze };
  }

  function step(dt) {
    // 下半場換邊:45 分過後第一次進 step 就鏡射,加一小段停頓當中場
    if (half === 1 && st.min >= 46) { half = 2; celebrate = 1.0; kickoff('away'); return; }
    if (celebrate > 0) {
      celebrate -= dt;
      if (celebrate <= 0 && pendingKickoff) { kickoff(pendingKickoff); pendingKickoff = null; }
      return;
    }
    simT += dt;
    if (pendingGoal || pendingShot) breakClock += dt;
    if (lastShot && (lastShot.t -= dt) <= 0) lastShot = null;
    for (const p of players) if (p.flash > 0) p.flash -= dt;
    passClock -= dt;
    if (passClock <= 0) {
      passClock = PASS_MIN + rng() * (PASS_MAX - PASS_MIN);
      const share = holder.side === 'home' ? shareHome : 1 - shareHome;
      if (cornerFlag) cornerFlag = null;          // 角球開出去之後就是一般傳球
      if (pendingShot && !pendingGoal && holder.side === pendingShot.side) {
        // 射門不進的演出:跟快攻一樣推進,到禁區就射,超時保底
        const toGoal = Math.abs(goalX(holder.side) - holder.x);
        if ((holder.role === 'FWD' && toGoal < BOX_X + 6) || breakClock > BREAK_MAX) { shootMiss(pendingShot.outcome); return; }
        const nxt = chooseNext();
        launch(nxt.x, nxt.y, PASS_SPEED);
        holder = nxt; push = Math.min(18, push + 4);
      } else if (pendingShot && !pendingGoal) {
        turnover(); holder = active().find(p => p.side === pendingShot.side && p.role === 'MID') ?? holder;
      } else if (pendingGoal && holder.side === pendingGoal.side) {
        // 快攻:前鋒推進到射門區就射。門檻用「離球門多遠」,不寫死一個 x
        const toGoal = Math.abs(goalX(holder.side) - holder.x);
        /* 保底:快攻演到 BREAK_MAX 秒還沒射就直接射。腳本進球是模型排的,
           演出不該有辦法把它吞掉 —— 上一版就是被一個碰不到的門檻吞掉的。 */
        if ((holder.role === 'FWD' && toGoal < BOX_X + 6) || breakClock > BREAK_MAX) { shoot(); return; }
        const nxt = chooseNext();
        launch(nxt.x, nxt.y, PASS_SPEED);
        holder = nxt; push = Math.min(18, push + 4);
      } else if (pendingGoal) {
        turnover(); holder = active().find(p => p.side === pendingGoal.side && p.role === 'MID') ?? holder;
      } else if (rng() > share * 0.55 + 0.45) {
        turnover(chooseNext());
      } else {
        const nxt = chooseNext();
        launch(nxt.x, nxt.y, PASS_SPEED);
        holder = nxt; push = Math.min(12, push + (rng() < 0.6 ? 2 : -3));
      }
    }
    ball.t = Math.min(1, ball.t + dt / ball.dur);
    if (ball.from && ball.t < 1) {
      ball.x = ball.from.x + (ball.tx - ball.from.x) * ball.t;
      ball.y = ball.from.y + (ball.ty - ball.from.y) * ball.t;
    } else { ball.from = null; ball.x = holder.x; ball.y = holder.y; }

    /* 每格重算兩個角色:誰上搶(防守方離球最近的非門將)、誰前插
       (控球方離球縱向最近的中場)。 */
    const defSide = holder.side === 'home' ? 'away' : 'home';
    presser = null; runner = null;
    let bestPress = Infinity, bestRun = Infinity;
    for (const p of active()) {
      if (p.role === 'GK') continue;
      if (p.side === defSide) {
        const d = Math.hypot(p.x - ball.x, p.y - ball.y);
        if (d < bestPress) { bestPress = d; presser = p; }
      } else if (p.role === 'MID' && p !== holder) {
        const d = Math.abs(p.by - ball.y);
        if (d < bestRun) { bestRun = d; runner = p; }
      }
    }

    for (const p of active()) {
      const a = aim(p);
      const avoid = avoidanceOf(p, a, active());
      // 抖動只是別讓點看起來焊死;持球者不抖(他要對得上球)
      const jx = p === holder ? 0 : Math.sin(simT * 0.9 + p.ph) * 1.4;
      const jy = p === holder ? 0 : Math.cos(simT * 0.7 + p.ph) * 1.6;
      const k = Math.min(1, dt * (p === holder || p === presser ? 3.2 : 2.2));
      p.x += ((a.x + avoid.x + jx) - p.x) * k;
      p.y += ((a.y + avoid.y + jy) - p.y) * k;
      p.x = Math.max(1, Math.min(FW - 1, p.x));
      p.y = Math.max(1.5, Math.min(FH - 1.5, p.y));
    }
    separate();
  }

  /* 位置層的間距兜底(2026-09-03)。切線繞行只改「目標點」,而每格只走 k≈0.1,兩人目標交叉時還是會穿過去
     (09-02 實測:全場最小間距中位數 0.11 m、5~13% 的畫格有人疊著)。這裡在積分**之後**把太近的兩個人沿連線推開:
     繞行決定路線、這一步保證不重疊,兩者不衝突。持球者不動(他要對得上球),對方被推開全額;
     其餘兩人各推一半。純幾何,不讀比分、不改 holder,所以跟腳本進球無關。跑兩輪就夠 —— 一輪推開的兩人
     可能撞到第三個,第二輪收掉大部分。 */
  function separate() {
    const list = active();
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
    for (const p of list) { p.x = Math.max(1, Math.min(FW - 1, p.x)); p.y = Math.max(1.5, Math.min(FH - 1.5, p.y)); }
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

    for (const p of active()) {
      const r = p.role === 'GK' ? 7 : 8;
      ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), r, 0, 7);
      ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = p === holder ? 18 : 8;
      ctx.fill(); ctx.shadowBlur = 0;
      ctx.lineWidth = p === holder ? 2.4 : 1.2;
      ctx.strokeStyle = p === holder ? '#ffffff' : 'rgba(255,255,255,.55)';
      ctx.stroke();
      // 換人 / 拿牌的提示圈(黃牌黃、換人綠),1.5 秒淡出
      if (p.flash > 0) {
        ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), r + 5, 0, 7);
        ctx.strokeStyle = p.flashColor ?? '#ffd400'; ctx.lineWidth = 2; ctx.globalAlpha = Math.min(1, p.flash); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (p.shirt != null) {
        ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#0b0710';
        ctx.fillText(String(p.shirt), sx(p.x), sy(p.y) + 3);
      }
    }
    if (lastShot) {
      ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,.85)';
      const zh = { saved: '被撲出', blocked: '被封阻', off: '射偏', post: '中柱' }[lastShot.outcome] ?? '射門';
      ctx.fillText(zh, sx(lastShot.side === 'home' ? (dirOf('home') === 1 ? FW - 20 : 20) : (dirOf('away') === 1 ? FW - 20 : 20)), sy(FH / 2) - 30);
    }
    // 持球者名字(有真名才顯示)
    if (holder.name) {
      ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.fillText(holder.name, sx(holder.x), sy(holder.y) - 13);
    }
    // 球
    ctx.beginPath(); ctx.arc(sx(ball.x), sy(ball.y), 4.4, 0, 7);
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
    ctx.fillText(st.done ? 'FT' : `${Math.min(st.min, 90)}${st.min > 90 ? '+' : ''}'`, W / 2, H - 8);
  }

  probe = () => ({
    goalsPlayed, pendingGoal, half, min: st.min,
    inBounds: players.every(p => p.x >= 0 && p.x <= FW && p.y >= 0 && p.y <= FH),
    minSeparation: players.reduce((best, p, i) => players.slice(i + 1)
      .reduce((inner, q) => Math.min(inner, Math.hypot(p.x - q.x, p.y - q.y)), best), Infinity),
  });

  let raf = null, last = performance.now(), alive = true;
  const loop = now => {
    if (!alive) return;
    /* 夾住負值。瀏覽器不會給比 mount 時還早的 rAF 時戳,但無畫布的測試台會
       (它自己從 0 開始餵 now),於是第一格的 dt 變成負的 —— 位置往目標的
       **反方向**跳一下,而跳多遠取決於行程已經跑多久。
       實測:同一個種子,單獨跑 node scripts/test.mjs 全綠、npm test 就紅,
       因為後者讓 test.mjs 晚了幾百毫秒起步。負的 frame delta 本來就沒有意義。 */
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
    if (!st.done) step(dt);
    draw();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    /* 每個比賽分鐘由頁面呼叫:進球數落後於已到分鐘的事件 → 排一段快攻演出 */
    setState({ min, done, dueSides, hs, as, possHome: ph }) {
      st.min = min; st.done = done;
      if (ph != null) shareHome = ph;
      if (hs != null) st.hs = hs;
      if (as != null) st.as = as;
      if (!pendingGoal && Array.isArray(dueSides) && goalsPlayed < dueSides.length) {
        pendingGoal = { side: dueSides[goalsPlayed] };
      }
    },
    /* 引擎的事件 → 演出。進球不走這裡(dueSides 那條路);找不到對應的人就什麼都不做 ——
       演出對不上劇本時寧可不演,不要演錯人。 */
    perform(e) {
      const byName = (side, name) => active().find(p => p.side === side && p.name === name);
      if (e.type === 'sub') {
        const p = byName(e.side, e.offName);
        if (p) { p.name = e.onName; p.shirt = e.onShirt ?? null; p.flash = 1.5; p.flashColor = '#00ff85'; }
      } else if (e.type === 'card' && e.card === 'red') {
        const p = byName(e.side, e.playerName);
        if (p) { p.off = true; if (holder === p) turnover(); }
      } else if (e.type === 'card') {
        const p = byName(e.side, e.playerName);
        if (p) { p.flash = 1.5; p.flashColor = '#ffd400'; }
      } else if (e.type === 'shot' && !pendingGoal && !pendingShot) {
        pendingShot = { side: e.side, outcome: e.outcome }; breakClock = 0;
      } else if (e.type === 'corner' && !pendingGoal && !pendingShot) {
        const side = e.side, dir = dirOf(side);
        const taker = byName(side, e.playerName) ?? active().find(p => p.side === side && p.role === 'MID') ?? holder;
        const y = rng() < 0.5 ? 1 : FH - 1;
        taker.x = goalX(side) - dir * 0.5; taker.y = y;
        holder = taker; ball.from = null; ball.x = taker.x; ball.y = y; ball.t = 1;
        cornerFlag = { side }; passClock = 1.3; push = 14;
      }
    },
    destroy() { alive = false; if (raf) cancelAnimationFrame(raf); },
  };
}
