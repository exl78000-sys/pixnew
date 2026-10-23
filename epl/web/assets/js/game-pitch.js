/* 連續時間引擎的球場繪製(2026-09-16,階段 3)。
 *
 * **它只畫「現在這一刻」**,不是播放器:沒有劇本、沒有排隊、沒有剪接 ——
 * 呼叫端每一格把 `sim.state()` 丟進來,這裡就照著畫。時間由呼叫端推進(`sim.advance`)。
 * 舊的 `duel-anim.js` 是反過來的(它拿一整個回合的劇本自己演;2026-09-25 已移除)。
 *
 * 為什麼另外寫一支而不是改 duel-anim:那一支的核心是「把事件演出來」——
 * 決定誰在什麼時候跑到哪,而連續引擎裡那件事**已經在引擎裡發生了**。
 * 留著它的話會有兩套運動模型,而畫面上看到的是哪一套沒有人說得準。
 *
 * 畫法上刻意的幾件事:
 *  1. **割草的條紋** —— 整片同色的時候眼睛沒有參考點,球員有沒有在移動看不出來。
 *  2. **速度尾巴** —— 只看圓點分不出走路跟衝刺,而「像不像在踢球」正是這件事。
 *  3. **空中球畫影子** —— 沒有影子的話高球跟平地球在 2D 上完全一樣。
 *  4. **事件提示**(2026-10-23,「依照模擬遊玩完善 動畫優化為目標」)—— 射門、撲救、封阻、進球、角球、牌
 *     原本只出現在文字播報,畫面上看不出發生了什麼。`cue(e, st)` 收引擎吐出來的事件,
 *     在**發生的位置**畫一個短暫的提示。提示用**真實時間**計時(不跟比賽倍速),極快模式下也看得到。
 *     它只畫、不改任何狀態 —— 引擎與統計完全不知道有這一層。
 *  5. **門將換色** —— 真實比賽門將穿跟兩隊都不同的球衣;原本門將跟隊友同色,畫面上找不到門將。
 *  6. **球的尾巴** —— 飛行與快速滾動時畫一段漸淡的軌跡,傳球與射門的方向看得出來。
 */

/* 場地尺寸要跟引擎同一組,不然球會畫在線外(引擎是 105 × 68)。 */
const PITCH_L = 105, PITCH_B = 68;
const PITCH_GRASS = '#16321f', PITCH_LINE = 'rgba(255,255,255,.35)';
const PITCH_STRIPES = 7;

/* 兩隊的顏色太接近就換一套。真實足球撞色時客隊換球衣,這裡照做 ——
   不換的話畫面上二十二個紅點,誰是誰完全看不出來(實測 ARS #EF0107 對 LIV #C8102E)。
   距離用加權 RGB:綠色的權重最高,因為人眼對綠最敏感。 */
const rgbOf = h => [1, 3, 5].map(i => parseInt(String(h).slice(i, i + 2), 16) || 0);
export function kitApart(a, b) {
  const [r1, g1, b1] = rgbOf(a), [r2, g2, b2] = rgbOf(b);
  return Math.hypot((r1 - r2) * 0.9, (g1 - g2) * 1.2, (b1 - b2) * 0.7);
}
export const KIT_CLASH = 90;                   // 小於這個就算撞色(ARS vs LIV 量到 40)

/* 門將球衣:從這幾個裡挑「離兩隊主色、也離草地最遠」的,兩個門將再互相錯開。
   草地也要算 —— 綠色門將衣在深綠的草上等於隱形。 */
const GK_KITS = ['#ffd400', '#ff7a00', '#e040fb', '#00e5ff', '#b0bec5', '#7cff4f'];
export function pickKeeperKits(homePrimary, awayPrimary) {
  const score = c => Math.min(kitApart(c, homePrimary), kitApart(c, awayPrimary), kitApart(c, PITCH_GRASS));
  const ranked = [...GK_KITS].sort((a, b) => score(b) - score(a));
  const h = ranked[0];
  const a = ranked.find(c => c !== h && kitApart(c, h) >= KIT_CLASH) ?? ranked[1];
  return { home: h, away: a };
}

/* 背號用黑或白:看底色的亮度(sRGB 的相對亮度近似)。原本用隊伍第二色,淡色底配深色或淡色字時看不清楚。 */
const inkOn = hex => {
  const [r, g, b] = rgbOf(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fff';
};

/* 事件提示的壽命(毫秒,真實時間)。 */
const CUE_MS = { shot: 900, goal: 2200, save: 1100, block: 800, corner: 1300, card: 1600, foul: 800, offside: 1200, penalty: 1600, formation: 1800 };
const CUE_LABEL = { goal: '進球!', save: '撲救', block: '封阻', corner: '角球', foul: '犯規', offside: '越位', penalty: '十二碼' };

export function mountPitch(canvas, opts = {}) {
  const g = canvas.getContext('2d');
  const shirts = opts.shirts ?? {};             // code → 背號
  const home = opts.home ?? ['#00ff85', '#ffffff'];
  let away = opts.away ?? ['#04f5ff', '#0b2b28'];
  let clashed = false;
  if (kitApart(home[0], away[0]) < KIT_CLASH) {
    // 客隊改用自己的第二色;第二色也太近就用一個一定分得開的藍
    away = kitApart(away[1], home[0]) >= KIT_CLASH ? [away[1], '#0b2b28'] : ['#1f6fff', '#0b1730'];
    clashed = true;
  }
  const COL = { home, away };
  const GK = pickKeeperKits(home[0], away[0]);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let cues = [];
  const trail = [];                              // 球最近的位置(畫尾巴用)

  function pitch() {
    const W = canvas.width, H = canvas.height;
    g.fillStyle = PITCH_GRASS; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.028)';
    for (let i = 0; i < PITCH_STRIPES; i += 2) g.fillRect(i * W / PITCH_STRIPES, 0, W / PITCH_STRIPES, H);
    const sx = W / PITCH_L, sy = H / PITCH_B;
    g.strokeStyle = PITCH_LINE; g.lineWidth = 2;
    g.strokeRect(2, 2, W - 4, H - 4);
    g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
    g.beginPath(); g.arc(W / 2, H / 2, 9.15 * sx, 0, Math.PI * 2); g.stroke();
    for (const right of [false, true]) {
      g.strokeRect(right ? W - 16.5 * sx : 0, (PITCH_B / 2 - 20.16) * sy, 16.5 * sx, 40.32 * sy);
      g.strokeRect(right ? W - 5.5 * sx : 0, (PITCH_B / 2 - 9.16) * sy, 5.5 * sx, 18.32 * sy);
      // 十二碼點
      g.fillStyle = PITCH_LINE; g.beginPath(); g.arc(right ? W - 11 * sx : 11 * sx, H / 2, 2, 0, Math.PI * 2); g.fill();
      g.save();
      g.strokeStyle = '#fff'; g.lineWidth = 3;
      const gx = right ? W : 0;
      g.beginPath(); g.moveTo(gx, (PITCH_B / 2 - 3.66) * sy); g.lineTo(gx, (PITCH_B / 2 + 3.66) * sy); g.stroke();
      g.restore();
    }
  }

  /* 事件 → 提示。位置在收到事件的這一刻從狀態裡取(事件發生在這一格之內,誤差不到一格的移動)。 */
  function cue(e, st) {
    if (!e || !CUE_MS[e.type] || !st) return;
    const who = code => st.players?.find(p => p.code === code) ?? null;
    const keeperOf = side => st.players?.find(p => p.side === side && p.role === 'GK') ?? null;
    const other = side => (side === 'home' ? 'away' : 'home');
    const at = { x: st.ball?.x ?? PITCH_L / 2, y: st.ball?.y ?? PITCH_B / 2 };
    const c = { type: e.type, t0: now(), side: e.side ?? null, x: at.x, y: at.y };
    if (e.type === 'shot') {
      const p = who(e.player); if (p) { c.x = p.x; c.y = p.y; }
      // 射門往哪一邊的門:球的速度方向比「主客 + 上下半場」可靠(換邊不用另外算)
      const vx = st.ball?.vx ?? 0;
      c.gx = Math.abs(vx) > 0.5 ? (vx > 0 ? PITCH_L : 0) : (c.x > PITCH_L / 2 ? PITCH_L : 0);
    } else if (e.type === 'save') {
      const k = keeperOf(other(e.side)); if (k) { c.x = k.x; c.y = k.y; }
    } else if (e.type === 'goal') {
      c.gx = at.x > PITCH_L / 2 ? PITCH_L : 0; c.x = c.gx; c.y = PITCH_B / 2;
    } else if (e.type === 'card' || e.type === 'foul' || e.type === 'offside' || e.type === 'penalty') {
      const p = who(e.player); if (p) { c.x = p.x; c.y = p.y; }
      c.card = e.card ?? null;
    } else if (e.type === 'corner') {
      c.x = at.x < PITCH_L / 2 ? 0 : PITCH_L; c.y = at.y < PITCH_B / 2 ? 0 : PITCH_B;
    } else if (e.type === 'formation') {
      c.text = `改踢 ${e.spec}`;
    }
    cues.push(c);
    if (cues.length > 40) cues = cues.slice(-40);
  }

  function drawCues(sx, sy, r, layer) {
    const t = now();
    cues = cues.filter(c => t - c.t0 < CUE_MS[c.type]);
    for (const c of cues) {
      const k = 1 - (t - c.t0) / CUE_MS[c.type];          // 1 → 0
      const x = c.x * sx, y = c.y * sy;
      const col = c.side ? COL[c.side][0] : '#fff';
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, k * 1.4));
      if (layer === 'under') {
        if (c.type === 'shot') {
          g.setLineDash([6, 5]); g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(x, y); g.lineTo(c.gx * sx, (PITCH_B / 2) * sy); g.stroke();
        } else if (c.type === 'goal') {
          const R = (1 - k) * 40 * sx;
          g.strokeStyle = col; g.lineWidth = 4;
          g.beginPath(); g.arc(x, y, Math.max(4, R), 0, Math.PI * 2); g.stroke();
          g.fillStyle = 'rgba(255,255,255,.18)';
          g.fillRect(c.gx === 0 ? 0 : (PITCH_L - 5.5) * sx, (PITCH_B / 2 - 9.16) * sy, 5.5 * sx, 18.32 * sy);
        } else if (c.type === 'save' || c.type === 'block') {
          g.strokeStyle = c.type === 'save' ? '#ffe36b' : '#ff9f43'; g.lineWidth = 3;
          g.beginPath(); g.arc(x, y, r + 4 + (1 - k) * 14, 0, Math.PI * 2); g.stroke();
        }
      } else {
        const label = c.type === 'formation' ? c.text : CUE_LABEL[c.type];
        if (c.type === 'card') {
          // 人頭上一張卡
          g.fillStyle = c.card === 'red' ? '#e53935' : '#ffd600';
          g.fillRect(x - r * 0.45, y - r * 3.1, r * 0.9, r * 1.25);
          g.strokeStyle = '#111'; g.lineWidth = 1; g.strokeRect(x - r * 0.45, y - r * 3.1, r * 0.9, r * 1.25);
        } else if (c.type === 'corner') {
          g.strokeStyle = '#fff'; g.lineWidth = 2;
          const fx = Math.min(Math.max(x, 6), canvas.width - 6), fy = Math.min(Math.max(y, 6), canvas.height - 6);
          g.beginPath(); g.moveTo(fx, fy); g.lineTo(fx, fy - r * 2.4); g.stroke();
          g.fillStyle = col; g.beginPath(); g.moveTo(fx, fy - r * 2.4); g.lineTo(fx + (fx < canvas.width / 2 ? 1 : -1) * r * 1.5, fy - r * 1.9); g.lineTo(fx, fy - r * 1.4); g.fill();
        } else if (c.type === 'foul' || c.type === 'offside') {
          g.strokeStyle = c.type === 'foul' ? '#ff5252' : '#ffd600'; g.lineWidth = 2.5;
          const d = r * 0.8;
          g.beginPath(); g.moveTo(x - d, y - r * 2 - d); g.lineTo(x + d, y - r * 2 + d); g.moveTo(x + d, y - r * 2 - d); g.lineTo(x - d, y - r * 2 + d); g.stroke();
        }
        if (label) {
          const big = c.type === 'goal' || c.type === 'formation';
          g.font = `800 ${Math.round(r * (big ? 2.4 : 1.7))}px system-ui,sans-serif`;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          const lx = c.type === 'goal' ? canvas.width / 2 : c.type === 'formation' ? (c.side === 'away' ? canvas.width * 0.75 : canvas.width * 0.25) : Math.min(Math.max(x, 30), canvas.width - 30);
          const ly = c.type === 'goal' ? canvas.height * 0.3 : c.type === 'formation' ? canvas.height * 0.1 : Math.max(y - r * (c.type === 'card' ? 3.9 : 2.9), 14);
          /* 白字、深色描邊:隊伍顏色的字在深綠草地上讀不到(紅、深藍都是),第一版就是那樣 */
          g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(label, lx, ly);
          g.fillStyle = '#fff'; g.fillText(label, lx, ly);
        }
      }
      g.restore();
    }
  }

  function draw(st) {
    const W = canvas.width, H = canvas.height, sx = W / PITCH_L, sy = H / PITCH_B;
    pitch();
    if (!st) return;
    const r = Math.max(7, Math.round(W / 82));
    drawCues(sx, sy, r, 'under');
    // 球的尾巴(畫在球員下面):沒人持球而且在動才記
    const b = st.ball;
    const moving = !b.holder && Math.hypot(b.vx ?? 0, b.vy ?? 0) > 6;
    if (moving) { trail.push({ x: b.x, y: b.y - (b.z ?? 0) * 3 / sy }); if (trail.length > 10) trail.shift(); } else trail.length = 0;
    if (trail.length > 1) {
      for (let i = 1; i < trail.length; i++) {
        g.strokeStyle = `rgba(255,255,255,${(0.05 + 0.4 * i / trail.length).toFixed(3)})`; g.lineWidth = 1 + 2.5 * i / trail.length;
        g.beginPath(); g.moveTo(trail[i - 1].x * sx, trail[i - 1].y * sy); g.lineTo(trail[i].x * sx, trail[i].y * sy); g.stroke();
      }
    }
    for (const p of st.players) {
      const x = p.x * sx, y = p.y * sy;
      const fill = p.role === 'GK' ? GK[p.side] : COL[p.side][0];
      const edge = p.role === 'GK' ? '#111' : COL[p.side][1];
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0.5) {
        g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x - p.vx * sx * 0.45, y - p.vy * sy * 0.45); g.stroke();
      }
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = fill; g.fill();
      g.lineWidth = 2; g.strokeStyle = edge; g.stroke();
      if (p.code === st.ball.holder) {
        g.lineWidth = 2.5; g.strokeStyle = '#ffe36b';
        g.beginPath(); g.arc(x, y, r + 4, 0, Math.PI * 2); g.stroke();
      }
      const n = shirts[p.code];
      if (n != null && r >= 7) {
        g.fillStyle = inkOn(fill); g.font = `700 ${Math.round(r * 1.05)}px system-ui,sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(n), x, y + 0.5);
      }
    }
    const bx = b.x * sx, by = b.y * sy;
    if (b.z > 0.15) { g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.arc(bx, by, r * 0.5, 0, Math.PI * 2); g.fill(); }
    g.beginPath(); g.arc(bx, by - b.z * 3, r * 0.58 + Math.min(3, b.z * 0.5), 0, Math.PI * 2);
    g.fillStyle = '#fff'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#1b1b1b'; g.stroke();
    drawCues(sx, sy, r, 'over');
  }

  draw(null);
  return { draw, cue, colors: () => ({ ...COL }), keeperColors: () => ({ ...GK }), clashed: () => clashed };
}
