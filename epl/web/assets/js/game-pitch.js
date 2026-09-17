/* 連續時間引擎的球場繪製(2026-09-16,階段 3)。
 *
 * **它只畫「現在這一刻」**,不是播放器:沒有劇本、沒有排隊、沒有剪接 ——
 * 呼叫端每一格把 `sim.state()` 丟進來,這裡就照著畫。時間由呼叫端推進(`sim.advance`)。
 * 舊的 `duel-anim.js` 是反過來的(它拿一整個回合的劇本自己演),兩者不能混用。
 *
 * 為什麼另外寫一支而不是改 duel-anim:那一支的核心是「把事件演出來」——
 * 決定誰在什麼時候跑到哪,而連續引擎裡那件事**已經在引擎裡發生了**。
 * 留著它的話會有兩套運動模型,而畫面上看到的是哪一套沒有人說得準。
 *
 * 畫法上只有三件事是刻意的:
 *  1. **割草的條紋** —— 整片同色的時候眼睛沒有參考點,球員有沒有在移動看不出來。
 *  2. **速度尾巴** —— 只看圓點分不出走路跟衝刺,而「像不像在踢球」正是這件事。
 *  3. **空中球畫影子** —— 沒有影子的話高球跟平地球在 2D 上完全一樣。
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
      g.save();
      g.strokeStyle = '#fff'; g.lineWidth = 3;
      const gx = right ? W : 0;
      g.beginPath(); g.moveTo(gx, (PITCH_B / 2 - 3.66) * sy); g.lineTo(gx, (PITCH_B / 2 + 3.66) * sy); g.stroke();
      g.restore();
    }
  }

  function draw(st) {
    const W = canvas.width, H = canvas.height, sx = W / PITCH_L, sy = H / PITCH_B;
    pitch();
    if (!st) return;
    const r = Math.max(6, Math.round(W / 105));
    for (const p of st.players) {
      const x = p.x * sx, y = p.y * sy, col = COL[p.side];
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 0.5) {
        g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x - p.vx * sx * 0.45, y - p.vy * sy * 0.45); g.stroke();
      }
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = col[0]; g.fill();
      g.lineWidth = 2; g.strokeStyle = col[1]; g.stroke();
      if (p.code === st.ball.holder) {
        g.lineWidth = 2.5; g.strokeStyle = '#ffe36b';
        g.beginPath(); g.arc(x, y, r + 4, 0, Math.PI * 2); g.stroke();
      }
      const n = shirts[p.code];
      if (n != null && r >= 8) {
        g.fillStyle = col[1]; g.font = `700 ${Math.round(r * 1.05)}px system-ui,sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(n), x, y + 0.5);
      }
    }
    const b = st.ball, bx = b.x * sx, by = b.y * sy;
    if (b.z > 0.15) { g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.arc(bx, by, r * 0.45, 0, Math.PI * 2); g.fill(); }
    g.beginPath(); g.arc(bx, by - b.z * 3, r * 0.5 + Math.min(3, b.z * 0.5), 0, Math.PI * 2);
    g.fillStyle = '#fff'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#1b1b1b'; g.stroke();
  }

  draw(null);
  return { draw, colors: () => ({ ...COL }), clashed: () => clashed };
}
