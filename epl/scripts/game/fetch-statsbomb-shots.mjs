/* 射手被逼住的真值:StatsBomb 開放資料的射門 freeze frame(2026-09-24,階段 5q)。

   **為什麼要這一份。** 5p 登記「真實世界沒有追蹤座標,所以『射門當下最近的防守者多近』
   沒有真值可以校準」—— 那是本站自己的資料來源沒有(FotMob 的 shotmap 只有射門點),
   不是真實世界沒有:StatsBomb 的事件資料每一腳射門都帶 freeze frame
   (射門那一瞬間場上其他人的座標、是不是隊友、誰是門將)。「我數不出來 ≠ 上游沒有」的又一次。

   **來源與授權。** github.com/statsbomb/open-data,靜態檔(raw.githubusercontent.com,
   本站規矩允許)。授權是**非商業使用、要標明資料來源是 StatsBomb** —— 所以這一支
   **只寫彙整的次數**(分箱計數),不把逐腳的座標存進倉庫;要重算就重跑這一支。
   用到它的地方(`check-sim`、文件)都要寫出處。

   **抽樣。** 2015-16 英超 380 場,依開賽時間排序後每 5 場取 1 場(76 場,約 2,000 腳射門)。
   2015-16 是 StatsBomb 開放資料裡唯一一整季的英超(另一季是 2003-04),比引擎校準用的
   2025-26 早十年 —— 戰術變過,所以它是**形狀**的錨(最近的防守者多近、站在哪一側、
   射手拿到球多久才射),不是水準的錨;封阻率本身拿 FotMob 那一份(兩季、逐顆)對。
   兩份的封阻率先互相對一次(鐵則五):禁區內運動戰腳下 StatsBomb 30.3% 對 FotMob 30.8%。

   **切法跟引擎一樣**:禁區內(StatsBomb 座標 x ≥ 102、18 ≤ y ≤ 62)、排掉十二碼與直接自由球;
   角球(play_pattern = From Corner)/ 其他;頭球 / 腳下。座標是 120 × 80 碼,距離 × 0.9144 換公尺。
   「最近的防守者」**不含門將**(引擎那一側同樣排掉)。
   方位 = 「防守者 − 射手」與「球門中心 − 射手」的夾角:0° 正好擋在射手與球門中間,180° 在射手背後。
   另外記**球真正的飛行線**(射門點 → end_location)上 `LANE_R` 內有沒有外場防守者 ——
   那是 5c 登記「沒有資料可以查」的真實曝光率。

   用法:node scripts/game/fetch-statsbomb-shots.mjs   (約 250 MB 的下載,只留彙整) */
import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = new URL('../..', import.meta.url).pathname;
const BASE = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data';
const COMP = 2, SEASON = 27, EVERY = 5;
const Y = 0.9144;
/* **路上有沒有人**用跟引擎同一個半徑(`DEFLECT_R`,`npm test` 守著兩邊一樣)。
   真值那一側的「飛行線」是射門點 → `end_location`(被封阻的就是封阻點、其餘是球最後到的地方),
   所以這是**真的飛行方向**,不是射手 → 球門中心(5c 那條坑)。5c 登記「真實世界的球道曝光率
   沒有資料可以查」—— 這一條就是那個資料。 */
const LANE_R = 0.75;
const TMP = join(tmpdir(), `statsbomb-${process.pid}.json`);

function getJson(url) {
  execFileSync('curl', ['-sSf', '--retry', '4', '--retry-delay', '2', '-o', TMP, url]);
  const j = JSON.parse(readFileSync(TMP, 'utf8'));
  unlinkSync(TMP);
  return j;
}
const secs = ts => { const [h, m, s] = ts.split(':'); return +h * 3600 + +m * 60 + +s; };
const inBox = (x, y) => x >= 102 && y >= 18 && y <= 62;
function inTri(px, py, ax, ay) {
  const s = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = s(px, py, ax, ay, 120, 36), d2 = s(px, py, 120, 36, 120, 44), d3 = s(px, py, 120, 44, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
/* 分箱的邊界跟引擎那一側(`shotPress`)**逐字相同**,兩邊才可以逐格並排。 */
const PRESS_BINS = {
  near: [1, 2, 3, 5],            // 最近外場防守者(公尺):< 1 / 1~2 / 2~3 / 3~5 / 5+
  ang: [45, 90, 135],            // 最近那個人的方位(度):門側 / 側前 / 側後 / 背後
  cone: [1, 2, 3],               // 射手 → 兩根門柱的三角形裡的外場防守者:0 / 1 / 2 / 3+
  recv: [1, 2, 4, 6],            // 接球到射門(秒):< 1 / 1~2 / 2~4 / 4~6 / 6+
  carry: [5, 10, 20],            // 接球點到射門點的直線距離(公尺):< 5 / 5~10 / 10~20 / 20+
  blockAt: [1, 2, 4],            // 封阻點離射手(公尺):< 1 / 1~2 / 2~4 / 4+
};
const binOf = (edges, v) => { let i = 0; while (i < edges.length && v >= edges[i]) i++; return i; };
const blank = () => ({
  n: 0, blk: 0, first: 0,
  near: Array(5).fill(0), nearBlk: Array(5).fill(0),
  ang: Array(4).fill(0), angBlk: Array(4).fill(0),
  cone: Array(4).fill(0), coneBlk: Array(4).fill(0),
  gs3: 0, gs3Blk: 0,
  recvN: 0, recv: Array(5).fill(0),
  carryN: 0, carry: Array(4).fill(0),
  blockAt: Array(4).fill(0),
  laneN: 0, laneExp: 0, laneExpBlk: 0,
  boxAtt: 0, boxDef: 0,
});

const matches = getJson(`${BASE}/matches/${COMP}/${SEASON}.json`)
  .sort((a, b) => (a.match_date + a.kick_off < b.match_date + b.kick_off ? -1 : 1));
const pick = matches.filter((_, i) => i % EVERY === 0);
const out = { open: { foot: blank(), head: blank() }, corner: { foot: blank(), head: blank() } };
let shotsAll = 0;
for (const [k, m] of pick.entries()) {
  const ev = getJson(`${BASE}/events/${m.match_id}.json`);
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.type?.name !== 'Shot') continue;
    shotsAll++;
    const [x, y] = e.location;
    const ff = e.shot.freeze_frame;
    if (!inBox(x, y) || e.shot.type?.name === 'Penalty' || e.shot.type?.name === 'Free Kick' || !ff) continue;
    const r = out[e.play_pattern?.name === 'From Corner' ? 'corner' : 'open'][e.shot.body_part?.name === 'Head' ? 'head' : 'foot'];
    const blocked = e.shot.outcome?.name === 'Blocked';
    r.n++; if (blocked) r.blk++; if (e.shot.first_time === true) r.first++;
    const gx = 120 - x, gy = 40 - y, L = Math.hypot(gx, gy);
    let near = null, cone = 0, gs3 = false;
    for (const q of ff) {
      if (q.teammate || q.position?.name === 'Goalkeeper') continue;
      const dx = q.location[0] - x, dy = q.location[1] - y, d = Math.hypot(dx, dy) * Y;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * gx + dy * gy) / (Math.max(1e-6, Math.hypot(dx, dy)) * L)))) * 180 / Math.PI;
      if (!near || d < near.d) near = { d, ang };
      if (inTri(q.location[0], q.location[1], x, y)) cone++;
      if (d < 3 && ang < 45) gs3 = true;
    }
    if (near) {
      const b = binOf(PRESS_BINS.near, near.d); r.near[b]++; if (blocked) r.nearBlk[b]++;
      const a = binOf(PRESS_BINS.ang, near.ang); r.ang[a]++; if (blocked) r.angBlk[a]++;
    }
    const c = binOf(PRESS_BINS.cone, cone); r.cone[c]++; if (blocked) r.coneBlk[c]++;
    /* 射門當下禁區裡有幾個人(5h 的 `shotBox`:攻方含射手、守方不含門將)。5h~5p 一路寫「上游沒有錨」,
       freeze frame 就是那個錨。**界線**:freeze frame 是從轉播畫面標的,畫面外的人不在裡面 ——
       禁區就在射手身邊,應該都拍得到,但這是推論,不是驗過的。 */
    r.boxAtt += 1 + ff.filter(q => q.teammate && inBox(q.location[0], q.location[1])).length;
    r.boxDef += ff.filter(q => !q.teammate && q.position?.name !== 'Goalkeeper' && inBox(q.location[0], q.location[1])).length;
    if (gs3) { r.gs3++; if (blocked) r.gs3Blk++; }
    // 同一次控球裡射手自己的最後一次接球:時間與位置
    const t = secs(e.timestamp);
    for (let j = i - 1; j >= 0 && j >= i - 60; j--) {
      const q = ev[j];
      if (q.possession !== e.possession || q.period !== e.period) break;
      if (q.player?.id !== e.player?.id || q.type?.name !== 'Ball Receipt*') continue;
      r.recvN++; r.recv[binOf(PRESS_BINS.recv, t - secs(q.timestamp))]++;
      if (q.location) { r.carryN++; r.carry[binOf(PRESS_BINS.carry, Math.hypot(x - q.location[0], y - q.location[1]) * Y)]++; }
      break;
    }
    if (e.shot.end_location) {
      const [ex, ey] = e.shot.end_location, fx = ex - x, fy = ey - y, FL = Math.hypot(fx, fy);
      if (FL > 0.01) {
        const ux = fx / FL, uy = fy / FL;
        let lane = Infinity;
        for (const q of ff) {
          if (q.teammate || q.position?.name === 'Goalkeeper') continue;
          const a = (q.location[0] - x) * ux + (q.location[1] - y) * uy;
          if (a * Y <= 0.3 || a > FL + 1 / Y) continue;       // 引擎同一條:射手身後 0.3 m 內不算;終點外多給 1 m(封阻點會比擋的人前一點)
          lane = Math.min(lane, Math.abs((q.location[0] - x) * uy - (q.location[1] - y) * ux) * Y);
        }
        r.laneN++; if (lane < LANE_R) { r.laneExp++; if (blocked) r.laneExpBlk++; }
      }
    }
    if (blocked && e.shot.end_location) {
      r.blockAt[binOf(PRESS_BINS.blockAt, Math.hypot(e.shot.end_location[0] - x, e.shot.end_location[1] - y) * Y)]++;
    }
  }
  process.stdout.write(`\r${k + 1} / ${pick.length} 場`);
  execFileSync('sleep', ['0.3']);
}
process.stdout.write('\n');
const file = join(ROOT, 'data', 'raw', 'statsbomb', 'pl-2015-16-shot-pressure.json');
mkdirSync(join(ROOT, 'data', 'raw', 'statsbomb'), { recursive: true });
/* 不寫時間戳:重跑同一個抽樣應該逐位元組相同(上游的開放資料是定版的)。 */
writeFileSync(file, JSON.stringify({
  source: 'StatsBomb Open Data(github.com/statsbomb/open-data)—— 非商業使用,引用時標明資料來源是 StatsBomb',
  competition: 'Premier League 2015/2016', sample: `依開賽時間排序,每 ${EVERY} 場取 1 場(${pick.length} / ${matches.length} 場)`,
  matchIds: pick.map(m => m.match_id), shots: shotsAll,
  cut: '禁區內(x ≥ 102、18 ≤ y ≤ 62)、排掉十二碼與直接自由球、要有 freeze frame;角球 = play_pattern From Corner;距離 × 0.9144 換公尺;最近的防守者不含門將',
  bins: PRESS_BINS, laneR: LANE_R, ...out,
}, null, 1) + '\n');
console.log(`寫入 ${file}:運動戰腳下 ${out.open.foot.n}・運動戰頭球 ${out.open.head.n}・角球腳下 ${out.corner.foot.n}・角球頭球 ${out.corner.head.n}`);
