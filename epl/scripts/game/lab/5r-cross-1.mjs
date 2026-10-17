/* 5r 運動戰傳中 —— **沒有併入正式引擎的實驗補丁**(2026-10-18,補齊規劃 5r)。
   用法(產生一份實驗版引擎,再用 check-sim / check-strength 的 --src 去量):
     node scripts/game/lab/5r-cross-1.mjs web/assets/js/game-sim.js <輸出.js> 0.9 45 8 3.5 9 0.45 1.6 4 0.6
     node scripts/game/lab/5r-cross-2.mjs <輸出.js>
     node scripts/game/lab/5r-cross-3-crossrel.mjs <輸出.js>      (選用:每隊照真實 accurate_crosses)
   參數依序:CROSS_URGE CROSS_ZONE_X CROSS_WIDE CROSS_APEX_OPEN CROSS_AIM_OPEN CROSS_OPEN_HEAD CROSS_CLEAR_SPREAD CROSS_BLOCK_R CROSS_BLOCK_P。
   為什麼沒併:強弱斜率 0.958 → 0.831(每隊照真實傳中率的版本 0.786),角球只從 5.2 到 ~5.9。數字與原因見變更紀錄 2026-10-18。
   補丁是對著 2026-10-18 的 game-sim.js 寫的錨點,引擎改過之後錨點對不上會直接拋錯(不會靜靜套歪)。 */
import { readFileSync, writeFileSync } from 'node:fs';
const [,, src, dst, urge = '0.25', zoneX = '24', wide = '14', apex = '3.5', aim = '5', headP = '0.7', spread = '1.6', blockR = '3', blockP = '0'] = process.argv;
let s = readFileSync(src, 'utf8');
const rep = (o, n) => { if (s.split(o).length !== 2) throw new Error('anchor: ' + o.slice(0, 80)); s = s.replace(o, () => n); };

// 常數
rep(`const CROSS_AIM_ERR = 2.5;`, `/* **運動戰傳中**(2026-10-17,補齊規劃 5r)。在這之前程式裡的「傳中」只有角球開出的那一腳 ——
   邊路球員到了底線不會傳,真實比賽裡最大宗的角球來源(傳中被擋 / 被頂出底線)不存在,角球一場 5.2(真實 11.4)。
   錨:FotMob 2025-26 英超 743 隊-場,每隊每場傳中 18.2、成功率 23.8%(\`accurate_crosses\` 與 \`_pct\` 反推;分不出含不含角球);
   運動戰射門的頭球佔 10.8%、每腳 xG 0.133(側寫 \`shotSituations.RegularPlay.byFoot.header\`)。
   飛行、第一點的空中對抗、頭球攻門**共用角球那一套**;被擋或出底線由幾何決定(折射那一段本來就對所有低空快球有效)。 */
const CROSS_ON = true;
const CROSS_URGE = ${urge};                    // 在傳中區每次持球決定的傳中機率(掃出來的,見上)
const CROSS_ZONE_X = ${zoneX};                  // 離對方底線這麼近才會傳中(公尺)
const CROSS_WIDE = ${wide};                     // 離中線這麼遠(邊路)才會傳中(公尺)
const CROSS_APEX_OPEN = ${apex};                // 運動戰傳中的弧頂(公尺):比角球(CROSS_APEX)低,是一記快的弧線球
const CROSS_AIM_OPEN = ${aim};                  // 運動戰傳中落點的誤差(公尺,每軸 ±一半):在跑動中傳,比角球不準
const CROSS_OPEN_HEAD = ${headP};               // 運動戰傳中在禁區裡被進攻方頂到 → 攻門的機率(角球那一個是 CORNER_HEAD;這一個對「運動戰頭球佔比 10.8%」校準)
const CROSS_CLEAR_SPREAD = ${spread};           // 防守方頂運動戰傳中的方向:來球方向與「遠離自家門」各半,再加這麼寬的隨機(弧度,±一半)
/* 傳中被擋(5r):出腳那一刻,傳中方向上(±60°)CROSS_BLOCK_R 內的防守者有 CROSS_BLOCK_P 的機率擋到。
   彈去哪是幾何:沿「擋的人 → 接觸點」的方向彈開再加隨機 —— 傳中的人多半已經貼近底線,所以常常出底線(角球)。
   **CROSS_BLOCK_P 沒有上游的錨**(倉庫裡沒有「傳中被擋」的資料),是拿每場角球 11.4 反推的 —— 它是一個對總數校準的係數,照實標。 */
const CROSS_BLOCK_R = ${blockR};
const CROSS_BLOCK_P = ${blockP};
const CROSS_AIM_ERR = 2.5;`);

// 頭球的 xG:運動戰那一種用真值
rep(`  const CORNER_HEAD_XG = L.shotSituations?.FromCorner?.byFoot?.header?.xgPerShot ?? CORNER_XG;`,
`  const CORNER_HEAD_XG = L.shotSituations?.FromCorner?.byFoot?.header?.xgPerShot ?? CORNER_XG;
  // 運動戰頭球的每腳 xG(5r):側寫的真值;沒有就用角球頭球那一個(兩者都是「頭球」)
  const OPEN_HEAD_XG = L.shotSituations?.RegularPlay?.byFoot?.header?.xgPerShot ?? CORNER_HEAD_XG;`);

// 計數器
rep(`    shotSit: {}, sitBins: {},`, `    cross: { home: 0, away: 0 }, crossOk: { home: 0, away: 0 }, crossHead: { home: 0, away: 0 }, crossLive: null,
    shotSit: {}, sitBins: {},`);

// decide:射門之後、一般傳球之前
rep(`    const wantPass = best && rng() < cl((pressure < 4.5 ? 0.75 : 0.25) * (s.tempo ?? 1), 0.05, 0.95);`,
`    /* 運動戰傳中(5r):在對方底線附近的邊路,禁區裡有隊友就可能傳中。目標是禁區裡的一個隊友,
       落點帶誤差;飛行與第一點交給角球那一套(\`st.lastKick = 'cross'\`)。 */
    if (CROSS_ON && p.role !== 'GK' && Math.abs(goalX - p.x) < CROSS_ZONE_X && Math.abs(p.y - PITCH_H / 2) > CROSS_WIDE) {
      const tg = s.players.filter(m => m !== p && !m.off && m.role !== 'GK' && inBoxAt(m.x, m.y, goalX));
      if (tg.length && rng() < CROSS_URGE) {
        const m = tg[Math.floor(rng() * tg.length)];
        const tx = cl(m.x + (rng() - 0.5) * CROSS_AIM_OPEN, 2, PITCH_W - 2), ty = cl(m.y + (rng() - 0.5) * CROSS_AIM_OPEN, 4, PITCH_H - 4);
        const d = hypot(tx - p.x, ty - p.y);
        const vz = Math.sqrt(2 * GRAVITY * CROSS_APEX_OPEN), tt = 2 * vz / GRAVITY;
        kick(p, tx, ty, d / tt + BALL_AIR * tt / 2, vz, 'pass');
        st.lastKick = 'cross';
        ball.passTo = null;
        st.cross[p.side]++; st.crossLive = { side: p.side, until: st.t + tt + 0.5 };   // 落地後半秒內控到才算「傳到人」(Opta 的 accurate cross)
        /* 被擋(見 CROSS_BLOCK_P):找傳中方向上最近的防守者 */
        const ux = (tx - p.x) / Math.max(0.1, d), uy = (ty - p.y) / Math.max(0.1, d);
        let blk = null, bd = CROSS_BLOCK_R;
        for (const q of o.players) {
          if (q.off || q.role === 'GK') continue;
          const qx = q.x - p.x, qy = q.y - p.y, qd = hypot(qx, qy);
          if (qd < bd && (qx * ux + qy * uy) > qd * 0.5) { bd = qd; blk = q; }
        }
        if (blk && rng() < CROSS_BLOCK_P) {
          const cxp = p.x + ux * 0.8, cyp = p.y + uy * 0.8;            // 接觸點:出腳後 0.8 m
          const a = Math.atan2(cyp - blk.y, cxp - blk.x) + (rng() - 0.5) * 1.8;
          const sp1 = hypot(ball.vx, ball.vy) * DEFLECT_KEEP * (0.6 + rng() * 0.5);
          ball.x = cxp; ball.y = cyp; ball.vx = Math.cos(a) * sp1; ball.vy = Math.sin(a) * sp1;
          ball.z = 0.5; ball.vz = rng() * 3;
          st.lastTouch = blk.side; st.lastKick = null; st.ballFrom = 'block';
          ball.passSide = null; ball.passTo = null; ball.passer = null;
          st.crossLive = null; st.crossBlock = (st.crossBlock ?? 0) + 1;
          blk.kickLock = KICK_LOCK;
        }
        p.intent = null;
        return { kind: 'cross' };
      }
    }
    const wantPass = best && rng() < cl((pressure < 4.5 ? 0.75 : 0.25) * (s.tempo ?? 1), 0.05, 0.95);`);

// 第一點:認得 cross
rep(`      if (CORNER_XG != null && st.lastKick === 'corner' && ball.passer
          && ball.z < CROSS_HEAD && ball.vz < 0) {
        const att = ball.passer.side;`, `      if (CORNER_XG != null && (st.lastKick === 'corner' || st.lastKick === 'cross') && ball.passer
          && ball.z < CROSS_HEAD && ball.vz < 0) {
        const att = ball.passer.side;
        const open = st.lastKick === 'cross';           // 運動戰傳中(5r):同一套爭頂,記帳分開`);
rep(`          if (who.side === att && inBox && rng() < CORNER_HEAD) { cornerFirst('attHead'); headerAt(who); }
          else {
            cornerFirst(who.side === att ? 'attMiss' : 'defHead');`,
`          if (open) { st.crossDuel = (st.crossDuel ?? 0) + (na && nd ? 1 : 0); if (who.side === att) st.crossOk[att]++; st.crossLive = null; }
          if (who.side === att && inBox && rng() < (open ? CROSS_OPEN_HEAD : CORNER_HEAD)) {
            if (open) { st.crossHead[att]++; headerAt(who, 'RegularPlay'); } else { cornerFirst('attHead'); headerAt(who); }
          }
          else {
            if (!open) cornerFirst(who.side === att ? 'attMiss' : 'defHead');`);

// 防守方頂運動戰傳中的方向:頭球是改變來球的方向,不是重新踢一腳
rep(`            const ang = Math.atan2(PITCH_H / 2 - who.y, (wgx - who.x) * dir) + (rng() - 0.5) * 2.2;`,
`            /* 運動戰傳中被防守方頂到(5r):頭球是**改變**來球的方向,不是重新踢一腳 —— 方向取「來球方向」與
               「原本的解圍方向」的角平分,再加 CROSS_CLEAR_SPREAD 的隨機。從邊路底線飛進來的球被頂到,常常順著來勢
               偏出底線(角球)或邊線(界外球)—— 由幾何決定,不寫機率。角球那一支照舊(它的錨是另一套校準)。 */
            const base = Math.atan2(PITCH_H / 2 - who.y, (wgx - who.x) * dir);
            const ang = open && who.side !== att
              ? (() => { const cx = Math.cos(base) * dir, cy = Math.sin(base);                 // 原本那一腳在球場座標的方向(x 乘 dir)
                  const sp0 = Math.max(0.1, hypot(ball.vx, ball.vy)), ix = ball.vx / sp0, iy = ball.vy / sp0;
                  const a = Math.atan2(cy + iy, cx + ix) + (rng() - 0.5) * CROSS_CLEAR_SPREAD;
                  return Math.atan2(Math.sin(a), Math.cos(a) * dir); })()                    // 轉回下面那兩行用的「乘 dir」座標
              : base + (rng() - 0.5) * 2.2;`);

// 控球:沒有爭頂、落地後先控到的人
rep(`  function giveTo(p, from = null) {
    noteNearBall(p); noteAerial(p);`, `  function giveTo(p, from = null) {
    noteNearBall(p); noteAerial(p);
    if (st.crossLive) { if (p.side === st.crossLive.side && st.t <= st.crossLive.until) st.crossOk[p.side]++; st.crossLive = null; }   // 5r:傳中第一個碰到的是誰`);
rep(`  function deadBall({ kind, side, taker, x, y, wait, spots = null }) {
    const s = sideOf(side);`, `  function deadBall({ kind, side, taker, x, y, wait, spots = null }) {
    const s = sideOf(side);
    st.crossLive = null;                       // 5r:傳中直接出界 / 死球 = 沒有找到人`);

// headerAt 參數化
rep(`  function headerAt(p) {
    const s = sideOf(p.side);
    const goalX = s.att > 0 ? PITCH_W : 0;
    const xg = cl(CORNER_HEAD_XG, 0.01, 0.95);`, `  function headerAt(p, sit = 'FromCorner') {
    const s = sideOf(p.side);
    const goalX = s.att > 0 ? PITCH_W : 0;
    const xg = cl(sit === 'FromCorner' ? CORNER_HEAD_XG : OPEN_HEAD_XG, 0.01, 0.95);`);
rep(`    const land = landingOf(ball);
    const chasers = { home: null, away: null };`, `    /* 運動戰傳中飛行中,追的是**頭球點**(球降到 CROSS_HEAD 的那一點),不是落地點(5r)。
       爭頂在球降到頭球高度那一刻判,而那一點在落地點前 ~6 m(弧頂 3.5 m、25 m 的傳中):追落地點的話,
       兩邊最近的人在爭頂那一刻都離球 ~4 m(實測中位 3.8 / 4.0 m,2.5 m 內 9% / 6%),傳中落在沒有人的地方。
       真人攻的是空中的球。角球不改(它的站位與錨是另一套校準)。 */
    const land = st.lastKick === 'cross' && !holder ? (headPointOf(ball) ?? landingOf(ball)) : landingOf(ball);
    const chasers = { home: null, away: null };`);
rep(`export function landingOf(ball) {`, `/* 球下一次**往下**經過頭球高度(CROSS_HEAD)的位置;已經在那以下、或不會再到那裡就回 null(5r)。 */
function headPointOf(ball) {
  const z = ball.z ?? 0, vz = ball.vz ?? 0, H = CROSS_HEAD;
  const disc = vz * vz + 2 * GRAVITY * (z - H);
  if (disc < 0 || (z <= H && vz <= 0)) return null;
  const t = (vz + Math.sqrt(disc)) / GRAVITY;
  return t > 0 ? { x: ball.x + ball.vx * t, y: ball.y + ball.vy * t, t } : null;
}
export function landingOf(ball) {`);
writeFileSync(dst, s); console.log('ok');
