import * as C from './core.js?v=dfd16172';

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
 */

const FW = 105, FH = 68;          // 球場座標(公尺),畫布再縮放
const PASS_MIN = 0.55, PASS_MAX = 1.15;   // 傳球間隔(秒)

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

export function mountDuelAnim(canvas, { home, away, homeCode = '', awayCode = '', lambdaHome, lambdaAway, rng }) {
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
      const name = names[s.role]?.[used[s.role]++] ?? null;
      const bx = side === 'home' ? s.x : FW - s.x;   // 上半場的基準;下半場鏡射(真足球會換邊)
      return { side, role: s.role, name,
        bx0: bx, by: s.y, x: bx, y: s.y,
        ph: rng() * Math.PI * 2, color: spec.color };
    });
  };
  const players = [...mkTeam('home', home), ...mkTeam('away', away)];
  const shareHome = lambdaHome / (lambdaHome + lambdaAway || 1);

  // 戲的狀態
  let st = { min: 0, done: false, hs: 0, as: 0 };
  let half = 1;                      // 下半場換邊(真足球行為)
  let goalsPlayed = 0;
  let pendingGoal = null;            // {side} 進球分鐘到了 → 演一段快攻收尾
  let pendingKickoff = null;         // 進球慶祝結束 → 失球方中圈開球
  const baseX = p => (half === 1 ? p.bx0 : FW - p.bx0);
  const dirOf = side => (side === 'home' ? 1 : -1) * (half === 1 ? 1 : -1);
  let holder = players.find(p => p.side === 'home' && p.role === 'MID') ?? players[0];
  const ball = { x: FW / 2, y: FH / 2, tx: 0, ty: 0, t: 1, from: null };
  let passClock = 0.9, celebrate = 0, push = 0;   // push:控球方整條線往前壓的量

  /* 中圈開球:球回中點、開球方中場持球、雙方回基準站位 */
  function kickoff(side) {
    const mids = players.filter(p => p.side === side && p.role === 'MID');
    holder = mids.sort((a, b) => Math.abs(a.by - FH / 2) - Math.abs(b.by - FH / 2))[0]
      ?? players.find(p => p.side === side) ?? players[0];
    ball.from = null; ball.x = FW / 2; ball.y = FH / 2; ball.t = 1;
    push = 0; passClock = 0.9;
  }
  kickoff('home');

  function chooseNext() {
    const mates = players.filter(p => p.side === holder.side && p !== holder && p.role !== 'GK');
    const dir = dirOf(holder.side);
    // 前傳偏好:越靠對方球門權重越高;快攻(pendingGoal)時強制找最前面的
    const w = p => Math.max(0.05, 1 + dir * (p.x - holder.x) / 30) * (pendingGoal ? (p.role === 'FWD' ? 4 : 1) : 1);
    let tot = mates.reduce((a, p) => a + w(p), 0), r = rng() * tot;
    for (const p of mates) { r -= w(p); if (r <= 0) return p; }
    return mates[mates.length - 1];
  }

  function turnover() {
    const opp = players.filter(p => p.side !== holder.side && p.role !== 'GK');
    holder = opp[Math.floor(rng() * opp.length)];
    push = 0;
  }

  function step(dt) {
    // 下半場換邊:45 分過後第一次進 step 就鏡射,加一小段停頓當中場
    if (half === 1 && st.min >= 46) { half = 2; celebrate = 1.0; kickoff('away'); return; }
    if (celebrate > 0) {
      celebrate -= dt;
      if (celebrate <= 0 && pendingKickoff) { kickoff(pendingKickoff); pendingKickoff = null; }
      return;
    }
    passClock -= dt;
    if (passClock <= 0) {
      passClock = PASS_MIN + rng() * (PASS_MAX - PASS_MIN);
      const share = holder.side === 'home' ? shareHome : 1 - shareHome;
      if (pendingGoal && holder.side === pendingGoal.side) {
        // 快攻:前鋒拿球且夠深就射門
        const dir = dirOf(holder.side);
        const deep = dir === 1 ? holder.x > 78 : holder.x < 27;
        if (holder.role === 'FWD' && deep) {
          const scorer = holder.side;
          ball.from = { x: ball.x, y: ball.y };
          ball.tx = dir === 1 ? FW - 1 : 1; ball.ty = FH / 2 + (rng() - 0.5) * 6;
          ball.t = 0; celebrate = 1.6; goalsPlayed++;
          pendingGoal = null; push = 0;
          pendingKickoff = scorer === 'home' ? 'away' : 'home';   // 失球方開球
          return;
        }
        const nxt = chooseNext();
        ball.from = { x: ball.x, y: ball.y }; ball.tx = nxt.x; ball.ty = nxt.y; ball.t = 0;
        holder = nxt; push = Math.min(18, push + 4);
      } else if (pendingGoal) {
        turnover(); holder = players.find(p => p.side === pendingGoal.side && p.role === 'MID') ?? holder;
      } else if (rng() > share * 0.55 + 0.45) {
        turnover();
      } else {
        const nxt = chooseNext();
        ball.from = { x: ball.x, y: ball.y }; ball.tx = nxt.x; ball.ty = nxt.y; ball.t = 0;
        holder = nxt; push = Math.min(12, push + (rng() < 0.6 ? 2 : -3));
      }
    }
    ball.t = Math.min(1, ball.t + dt * 2.6);
    if (ball.from) {
      ball.x = ball.from.x + (ball.tx - ball.from.x) * ball.t;
      ball.y = ball.from.y + (ball.ty - ball.from.y) * ball.t;
    } else { ball.x = holder.x; ball.y = holder.y; }

    const t = performance.now() / 1000;
    for (const p of players) {
      const attacking = p.side === holder.side;
      const dir = dirOf(p.side);
      const shift = attacking ? push * dir : -push * dir * 0.6;
      const jx = Math.sin(t * 0.9 + p.ph) * 2.2, jy = Math.cos(t * 0.7 + p.ph) * 2.6;
      /* 防守方朝球收縮:整條線往球的縱向靠攏(壓縮防守寬度),GK 不參與 */
      const squeeze = (!attacking && p.role !== 'GK') ? (ball.y - p.by) * 0.18 : 0;
      const tx = p === holder ? ball.x : baseX(p) + shift + jx;
      const ty = p === holder ? ball.y : p.by + squeeze + jy;
      p.x += (tx - p.x) * Math.min(1, dt * 2.2);
      p.y += (ty - p.y) * Math.min(1, dt * 2.2);
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

    for (const p of players) {
      const r = p.role === 'GK' ? 7 : 8;
      ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), r, 0, 7);
      ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = p === holder ? 18 : 8;
      ctx.fill(); ctx.shadowBlur = 0;
      ctx.lineWidth = p === holder ? 2.4 : 1.2;
      ctx.strokeStyle = p === holder ? '#ffffff' : 'rgba(255,255,255,.55)';
      ctx.stroke();
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

  let raf = null, last = performance.now(), alive = true;
  const loop = now => {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!st.done) step(dt);
    draw();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    /* 每個比賽分鐘由頁面呼叫:進球數落後於已到分鐘的事件 → 排一段快攻演出 */
    setState({ min, done, dueSides, hs, as }) {
      st.min = min; st.done = done;
      if (hs != null) st.hs = hs;
      if (as != null) st.as = as;
      if (!pendingGoal && Array.isArray(dueSides) && goalsPlayed < dueSides.length) {
        pendingGoal = { side: dueSides[goalsPlayed] };
      }
    },
    destroy() { alive = false; if (raf) cancelAnimationFrame(raf); },
  };
}
