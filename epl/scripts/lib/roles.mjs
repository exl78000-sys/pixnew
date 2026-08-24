import { percentile } from './util.mjs';

/* 球員角色分類 —— 把 FPL 的四個粗類細分成球迷實際在講的位置。
 *
 * 為什麼需要:FPL 只分 GK/DEF/MID/FWD,而且把邊鋒歸類為中場。
 * 只靠這四類推不出 4-2-3-1 或 4-3-3,因為「5 名中場」可能是
 * 三中場 + 兩邊鋒,也可能是五個中路球員 —— 那是完全不同的球隊。
 *
 * 怎麼分:用 per-90 的產出側寫。邊鋒與防守中場在資料上差好幾倍,不是勉強分得開:
 *   邊鋒   threat90 ≈ 30、cbi90 ≈ 1
 *   防中   threat90 ≈ 7 、cbi90 ≈ 3.5
 *   中衛   cbi90 ≈ 8  、creativity90 ≈ 4
 *   邊後衛 cbi90 ≈ 3.5、creativity90 ≈ 20
 *
 * 用聯盟內的百分位而不是絕對數字,才不會因為某一季整體數值偏移就全部誤判。
 *
 * ⚠ 這是從「產出」反推「位置」,不是球員追蹤資料。一個很少拿球的邊鋒可能被判成中場。
 *   前端必須標示這是推導值。
 */

export const ROLES = {
  GK: { key: 'GK', zh: '門將', band: 'GK' },
  CB: { key: 'CB', zh: '中衛', band: 'DEF' },
  FB: { key: 'FB', zh: '邊後衛', band: 'DEF' },
  DM: { key: 'DM', zh: '防守中場', band: 'MID' },
  CM: { key: 'CM', zh: '中場', band: 'MID' },
  AM: { key: 'AM', zh: '前腰', band: 'ATT' },
  W: { key: 'W', zh: '邊鋒', band: 'ATT' },
  ST: { key: 'ST', zh: '中鋒', band: 'FWD' },
};

const QUALIFY = 450;   // 出場太少的側寫不可信,直接沿用 FPL 的粗類

/* 建立分類器。pool 是同一季所有球員的指標,用來算百分位。 */
export function buildClassifier(players, pick = p => p.last) {
  const of = (pos, f) => players
    .filter(p => p.pos === pos && pick(p) && pick(p).minutes >= QUALIFY)
    .map(p => f(pick(p)));

  const defCbi = of('DEF', m => m.cbi90);
  const defCrea = of('DEF', m => m.creativity90);
  const midThreat = of('MID', m => m.threat90);
  const midDefCon = of('MID', m => m.defCon90);
  const midXa = of('MID', m => m.xa90);

  return function classify(p, stat = pick(p)) {
    if (p.pos === 'GK') return ROLES.GK;
    if (p.pos === 'FWD') return ROLES.ST;
    if (!stat || stat.minutes < QUALIFY) {
      // 樣本不足:用 FPL 的粗類給一個保守的預設,並標記為低信心
      return p.pos === 'DEF' ? { ...ROLES.CB, lowSample: true } : { ...ROLES.CM, lowSample: true };
    }

    if (p.pos === 'DEF') {
      // 中衛掃蕩多、傳中少;邊後衛反過來。兩個指標一起看比單看一個穩。
      const cbi = percentile(stat.cbi90, defCbi);
      const crea = percentile(stat.creativity90, defCrea);
      return crea - cbi > 15 ? ROLES.FB : ROLES.CB;
    }

    // 中場:先用威脅值切出攻擊型,再用防守貢獻切出防守型,剩下的是中場
    const threat = percentile(stat.threat90, midThreat);
    const defcon = percentile(stat.defCon90, midDefCon);
    const xa = percentile(stat.xa90, midXa);
    if (threat >= 62) {
      // 攻擊型再分。邊鋒的特徵是「自己製造威脅」(切入、射門),前腰是「餵給別人」。
      // 實測:知名邊鋒的 threat90 落在第 90~98 百分位,前腰落在 61~77,分界很乾淨。
      // 助攻取向要往前腰推而不是往邊鋒推 —— 這點我第一版寫反了。
      if (threat >= 85) return ROLES.W;
      return xa >= 70 ? ROLES.AM : (threat >= 78 ? ROLES.W : ROLES.AM);
    }
    if (threat <= 40 && defcon >= 55) return ROLES.DM;
    return ROLES.CM;
  };
}

/* ── 標準陣型 ──────────────────────────
 * 由角色組成推回球迷在講的那種寫法(4-2-3-1 / 4-3-3 / 3-5-2)。
 * 兩條規則決定寫法,兩者都是足球本來的慣例,不是我自己定的:
 *   1. 三中衛時,邊後衛是「翼衛」,算在中場線 —— 所以是 3-5-2 不是 5-3-2。
 *   2. 沒有前腰時,邊鋒與中鋒同一排 —— 所以是 4-3-3 不是 4-3-2-1。
 */
export function standardShape(counts, forceWingBack = null) {
  const c = { CB: 0, FB: 0, DM: 0, CM: 0, AM: 0, W: 0, ST: 0, ...counts };
  // 攻守分型時要沿用基本陣型的判定,否則一名翼衛前壓就會讓「三後衛」變成
  // 「四後衛」—— 進攻時後防線反而變多,那顯然是規則的假象而不是戰術
  const wingBack = forceWingBack ?? (c.CB >= 3 && c.CB + c.FB >= 5);
  const back = wingBack ? c.CB : c.CB + c.FB;
  const mid = c.DM + c.CM + (wingBack ? c.FB : 0);
  const bands = c.AM > 0
    ? [back, mid, c.AM + c.W, c.ST]
    : [back, mid, c.W + c.ST];
  const label = bands.filter((n, i) => n > 0 || i === 0).join('-');
  return {
    label,
    bands,
    wingBack,
    detail: `${c.CB} 中衛・${c.FB} 邊後衛・${c.DM} 防中・${c.CM} 中場・${c.AM} 前腰・${c.W} 邊鋒・${c.ST} 中鋒`,
  };
}

export const countRoles = (xi, classify) => {
  const c = { GK: 0, CB: 0, FB: 0, DM: 0, CM: 0, AM: 0, W: 0, ST: 0 };
  for (const p of xi) c[classify(p).key] = (c[classify(p).key] ?? 0) + 1;
  return c;
};

/* ── 進攻陣型 / 防守陣型 ────────────────
 * 現代球隊有球與無球時的形狀不同:邊後衛內收或前壓、邊鋒回追。
 *
 * ⚠ 這是從「產出集中在哪裡」推論的,不是有球/無球的實際站位資料。
 *   我們沒有球員追蹤,做不到真正的分階段位置。所以規則只取最沒有爭議的兩條:
 *     進攻:創造力排在同位置前段的邊後衛,實質上在進攻時推到前場
 *     防守:防守貢獻排在同位置前段的邊鋒,無球時退回中場線
 *   兩條都能從資料驗證,不是憑印象。
 */
export function phaseShapes(counts, teamPlayers, classify, pools, pick = p => p.last) {
  // 作用在「已經湊成 10 名外場球員」的角色組成上,不是作用在整份陣容名單上 ——
  // 拿 18 個人去數會得到 4-6-7-2 這種不存在的東西。
  const base = { CB: 0, FB: 0, DM: 0, CM: 0, AM: 0, W: 0, ST: 0, ...counts };

  // 這一隊的邊後衛裡,有多少「出場時間」是由創造力偏高的人貢獻的?
  // 用分鐘加權而不是人數,因為板凳上的邊後衛不該跟主力等重。
  const share = (roleKey, metric, pool, cut) => {
    let hot = 0, all = 0;
    for (const p of teamPlayers) {
      const st = pick(p);
      if (!st || st.minutes < QUALIFY) continue;
      if (classify(p, st).key !== roleKey) continue;
      all += st.minutes;
      if (percentile(metric(st), pool) >= cut) hot += st.minutes;
    }
    return all ? hot / all : 0;
  };

  const fbUpShare = share('FB', m => m.creativity90, pools.fbCrea, 55);
  const wDownShare = share('W', m => m.defCon90, pools.wDefCon, 50);
  // 就算兩名邊後衛都是進攻型,後防線也不會少於 2 人 —— 沒有球隊用一個人守
  const backNow = (base.CB >= 3 && base.CB + base.FB >= 5) ? base.CB : base.CB + base.FB;
  const maxUp = Math.max(0, backNow - 2);
  const up = Math.min(base.FB, maxUp, Math.round(base.FB * fbUpShare));
  const down = Math.min(base.W, Math.round(base.W * wDownShare));

  const att = { ...base, FB: base.FB - up, W: base.W + up };
  const def = { ...base, W: base.W - down, CM: base.CM + down };

  const baseShape = standardShape(base);
  const wb = baseShape.wingBack;
  return {
    base: baseShape,
    attacking: { ...standardShape(att, wb), pushedUp: up, share: Math.round(fbUpShare * 100) },
    defending: { ...standardShape(def, wb), droppedBack: down, share: Math.round(wDownShare * 100) },
  };
}

/* phaseShapes 需要的百分位母體 */
export function rolePools(players, classify, pick = p => p.last) {
  const byRole = key => players.filter(p => pick(p) && pick(p).minutes >= QUALIFY
    && classify(p, pick(p)).key === key);
  return {
    fbCrea: byRole('FB').map(p => pick(p).creativity90),
    wDefCon: byRole('W').map(p => pick(p).defCon90),
  };
}

/* ── 由角色層級的出場分鐘推導球隊常態陣型 ──
 * 跟既有的 formationOf 同一個做法,只是把粒度從四類拉到八類。
 * 這樣得到的是「這隊平均每分鐘場上有幾名中衛/邊後衛/防中/邊鋒」,
 * 四捨五入後就是一個真實存在的陣型,而不是在某一份先發名單上數人頭
 * (那會因為那一場的輪換而跑出 4-1-5 這種不存在的東西)。
 */
// 少於這個總分鐘數就不推導 —— 升班馬上季在英冠,可能只有兩三名球員有英超紀錄,
// 用三個人的分鐘去推「這隊平均擺幾個中衛」會得到 0-7-3 這種不存在的陣型。
// 寧可回 null 讓前端顯示「資料不足」,也不要編一個看起來煞有介事的答案。
const MIN_TOTAL_MINUTES = 9000;      // ≈ 10 名球員各打滿 900 分鐘

export function roleFormation(teamPlayers, classify, pick = p => p.last) {
  const mins = { CB: 0, FB: 0, DM: 0, CM: 0, AM: 0, W: 0, ST: 0 };
  let contributors = 0;
  for (const p of teamPlayers) {
    const st = pick(p);
    // 樣本不足的球員會被分類器歸到保守預設(中場),納入統計只會污染結果
    if (!st || st.minutes < QUALIFY || p.pos === 'GK') continue;
    const k = classify(p, st).key;
    if (k in mins) { mins[k] += st.minutes; contributors++; }
  }
  const total = Object.values(mins).reduce((a, b) => a + b, 0);
  if (total < MIN_TOTAL_MINUTES || contributors < 8) {
    return { insufficient: true, totalMinutes: total, contributors, counts: null, shape: null };
  }

  const raw = Object.fromEntries(Object.entries(mins).map(([k, v]) => [k, (v / total) * 10]));
  const counts = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.round(v)]));
  // 湊成剛好 10 名外場球員:差額補在小數離整數最遠的那一項
  let sum = Object.values(counts).reduce((a, b) => a + b, 0);
  let guard = 0;
  while (sum !== 10 && guard++ < 20) {
    const dir = sum < 10 ? 1 : -1;
    const key = Object.keys(counts)
      .filter(k => (dir > 0 ? true : counts[k] > 0))
      .sort((a, b) => Math.abs(raw[b] - counts[b]) - Math.abs(raw[a] - counts[a]))[0];
    if (!key) break;
    counts[key] += dir;
    sum = Object.values(counts).reduce((a, b) => a + b, 0);
  }
  return { counts, raw, shape: standardShape(counts) };
}
