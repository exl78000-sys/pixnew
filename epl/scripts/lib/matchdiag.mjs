import { round } from './util.mjs';

/* 從模擬的事件流讀出戰術判斷。
 *
 * 這是設計參考文檔裡最值得抄的一條:引擎不只產生事件,還**對自己的事件
 * 做出診斷**。單場頁本來只給一個「主勝 62%」,讀者沒有畫面;有了
 * 「這場模擬裡防線被身後球打穿 4 次」,那個 62% 才有形狀。
 *
 * 三條規則,寫死在這裡免得日後手癢:
 *
 * 1. **文字裡出現的每一個數字都要進 evidence**。不准出現「攻勢受阻」這種沒有
 *    數字撐著的話 —— 那是占卜,不是分析。
 *    這不只是自律:這些判斷會被 report/ 的模板引用,而 verify.mjs 會逐一檢查
 *    文章裡的數字有沒有出處。evidence 漏一個,整篇賽後敘述就過不了驗證。
 *    test.mjs 會機械化地比對 text 裡的數字與 evidence,漏了就爆。
 * 2. **沒事就不要講話**。回傳空陣列是正常結果。每場都硬擠三條判斷,
 *    讀者兩場之後就知道那是罐頭,整個功能的可信度一起賠掉。
 * 3. **門檻用兩隊互比,不用聯盟基準**。基準值會隨引擎參數漂移,
 *    每次調 RATES 都要重算一輪,遲早忘記 —— 同一場裡兩隊互比不會有這問題。
 *    只有「絕對次數」類的判斷(被打穿幾次)才用固定門檻,那種數字本身就看得懂。
 *
 * ⚠ 這些判斷描述的是**模擬出來的那一場**,不是對真實比賽的預測。
 *   前端的用詞必須是「這場模擬裡…」,不能寫成「這隊的弱點是…」。
 */

// 至少要發生這麼多次才值得講,否則是雜訊
const MIN_EVIDENCE = 3;
// 兩隊互比時要差到這個倍數才算「明顯」
const EDGE = 1.6;

const other = side => (side === 'home' ? 'away' : 'home');

/* 把事件流整理成每隊一份的計數。診斷全部建立在這份計數上,
   不要在判斷邏輯裡再去掃一次 events —— 兩邊會漸漸對不上。 */
export function tally(events) {
  const blank = () => ({
    chains: 0, shots: 0,
    lostAtBuildUp: 0, lostAtMidfield: 0, lostAtFinalThird: 0, lostAtThrough: 0,
    crosses: 0, crossesBlocked: 0, crossChances: 0,
    inBehind: 0, longShots: 0, boxChances: 0,
    fouls: 0, yellow: 0, goals: 0, corners: 0,
  });
  const t = { home: blank(), away: blank() };

  for (const e of events) {
    const s = e.side;
    if (!s || !t[s]) continue;
    switch (e.type) {
      case '後場組織': t[s].chains++; break;
      case '失去球權':
        if (e.state === '後場出球') t[s].lostAtBuildUp++;
        else if (e.state === '中場推進') t[s].lostAtMidfield++;
        else if (e.state === '前場組織') t[s].lostAtFinalThird++;
        else if (e.state === '中路直塞') t[s].lostAtThrough++;
        break;
      case '傳中': t[s].crosses++; break;
      case '封阻': if (e.detail === '傳中被解圍') t[s].crossesBlocked++; break;
      case '犯規': t[s].fouls++; break;
      case '黃牌': t[s].yellow++; break;
      case '角球': t[s].corners++; break;
      case '進球': t[s].goals++; break;
      case '射門': {
        t[s].shots++;
        if (e.chanceType === 'oneOnOne') t[s].inBehind++;
        if (e.chanceType === 'longShot') t[s].longShots++;
        if (['header', 'closeRange', 'cutback'].includes(e.chanceType)) t[s].crossChances++;
        if (['boxShot', 'closeRange', 'cutback', 'header', 'oneOnOne'].includes(e.chanceType)) t[s].boxChances++;
        break;
      }
      default: break;
    }
  }
  return t;
}

const pct = (a, b) => (b > 0 ? a / b : 0);

/* 每條規則吃 (side, 我方計數, 對方計數, 我方戰術側寫),
   回傳一條判斷或 null。null 就是「這場沒這回事」。 */
const RULES = [
  /* 防線被身後球打穿。用絕對次數 —— 一場被做出四次單刀,不需要跟誰比也知道不妙。
     若這隊的常態陣型偏高位,再補一句因果,但只有在資料真的顯示高位時才講。 */
  function inBehind(side, me, opp, tac) {
    if (opp.inBehind < 4) return null;
    const high = tac?.formation?.shape === '偏三後衛出球'
      || (tac?.formation?.def != null && tac.formation.def <= 3.7);
    return {
      side, kind: 'defence-line',
      // 帶上陣型時,標籤裡的三個數字也要進 evidence —— 文章引用它們時要過得了 verify
      text: high
        ? `防線被身後球打穿 ${opp.inBehind} 次 —— 這隊後場人力本來就偏少(${tac.formation.label}),壓上後身後的空間是代價`
        : `防線被身後球打穿 ${opp.inBehind} 次`,
      evidence: high
        ? { 對手單刀次數: opp.inBehind, 後場人力: tac.formation.def, 中場人力: tac.formation.mid, 前場人力: tac.formation.fwd }
        : { 對手單刀次數: opp.inBehind },
    };
  },

  /* 邊路吃不吃得開。傳中要夠多才有意義,否則兩三次的比例毫無資訊。 */
  function flanks(side, me, opp) {
    if (me.crosses < 8) return null;
    const mine = pct(me.crossChances, me.crosses);
    const theirs = pct(opp.crossChances, opp.crosses);
    if (theirs > 0 && mine >= theirs * EDGE) {
      // 製造出機會不等於進球。零進球時把話講完,否則「主要出口」讀起來
      // 像在說他們踢得好,跟比分打架。
      const tail = me.goals === 0
        ? ` —— 但一球未進,機會都沒把握住`
        : `,效率是對手的 ${round(mine / theirs, 1)} 倍`;
      return {
        side, kind: 'flank-good',
        text: `邊路是這場的主要出口:${me.crosses} 次傳中換到 ${me.crossChances} 次機會${tail}`,
        evidence: { 傳中: me.crosses, 形成機會: me.crossChances, 進球: me.goals, 效率倍數: round(mine / theirs, 1) },
      };
    }
    if (me.crossesBlocked >= MIN_EVIDENCE && mine > 0 && theirs >= mine * EDGE) {
      return {
        side, kind: 'flank-bad',
        text: `邊路傳中吃不開:${me.crosses} 次傳中有 ${me.crossesBlocked} 次直接被解圍`,
        evidence: { 傳中: me.crosses, 被解圍: me.crossesBlocked },
      };
    }
    return null;
  },

  /* 中場被壓制。兩隊互比,而且要有足夠的回合數當分母。 */
  function midfield(side, me, opp) {
    if (me.chains < 40) return null;
    const mine = pct(me.lostAtMidfield, me.chains);
    const theirs = pct(opp.lostAtMidfield, opp.chains);
    if (theirs <= 0 || mine < theirs * EDGE) return null;
    return {
      side, kind: 'midfield',
      text: `中場過不去:${me.chains} 次進攻有 ${me.lostAtMidfield} 次在中場就被搶下,比例是對手的 ${round(mine / theirs, 1)} 倍`,
      evidence: { 進攻回合: me.chains, 中場丟球: me.lostAtMidfield, 倍數: round(mine / theirs, 1) },
    };
  },

  /* 進不了禁區,只能遠射。這是「看起來有在攻,其實沒威脅」的典型長相。 */
  function longRange(side, me) {
    if (me.shots < 8) return null;
    const share = pct(me.longShots, me.shots);
    if (share < 0.3 || me.longShots < 4) return null;
    return {
      side, kind: 'long-range',
      text: `進不了禁區:${me.shots} 次射門有 ${me.longShots} 次來自禁區外(${round(share * 100, 0)}%)`,
      evidence: { 射門: me.shots, 遠射: me.longShots, 百分比: round(share * 100, 0) },
    };
  },

  /* 守成。這一條是唯一把模擬事件接回**真實統計**的判斷 ——
     模擬裡先領先後被追,而這隊上季的領先守成率確實偏低,兩件事擺在一起
     才有意義。單看模擬只是一場隨機結果,單看統計又跟這場無關。 */
  function leadHeld(side, me, opp, tac, ctx) {
    const hold = tac?.resilience?.leadHoldPct;
    if (hold == null || hold >= 80) return null;
    if (!ctx.ledFirst[side] || me.goals > opp.goals) return null;
    return {
      side, kind: 'lead-held',
      text: `這場模擬裡先取得領先後被追回 —— 這隊上季的領先守成率是 ${hold}%,在聯盟屬於偏低的一端`,
      evidence: { 上季領先守成率: hold },
    };
  },

  /* 被完全壓制。這是一面倒的比賽裡最該講的一句,但原本沒有規則接住它 ——
     NEW 3-2 HUL 射門 17-4,六條規則竟然一條都沒觸發。 */
  function outshot(side, me, opp) {
    if (opp.shots < 12 || me.shots < 1) return null;
    const ratio = opp.shots / me.shots;
    if (ratio < 2.5) return null;
    return {
      side, kind: 'outshot',
      text: `幾乎沒有進攻:全場 ${me.shots} 次射門對上對手的 ${opp.shots} 次`,
      evidence: { 我方射門: me.shots, 對手射門: opp.shots },
    };
  },

  /* 紀律。黃牌要夠多才講,而且要比對手明顯多。 */
  function discipline(side, me, opp) {
    if (me.yellow < 3 || me.yellow < opp.yellow + 2) return null;
    return {
      side, kind: 'discipline',
      text: `犯規累積:${me.fouls} 次犯規吃了 ${me.yellow} 張黃牌,比對手多 ${me.yellow - opp.yellow} 張`,
      evidence: { 犯規: me.fouls, 黃牌: me.yellow, 多出的黃牌: me.yellow - opp.yellow },
    };
  },
];

/* 從時間軸判斷誰先進球、以及是否被追回。
   用 timeline 而不是 events,因為 timeline 已經帶了當下比分。 */
function context(timeline) {
  const ledFirst = { home: false, away: false };
  const first = timeline.find(t => t.kind === 'goal');
  if (first) ledFirst[first.side] = true;
  return { ledFirst };
}

/* 主入口。回傳的陣列可能是空的 —— 那是正常結果,不是失敗。 */
export function diagnose({ events, timeline }, tactics = {}) {
  const t = tally(events);
  const ctx = context(timeline ?? []);
  const out = [];
  for (const side of ['home', 'away']) {
    for (const rule of RULES) {
      const found = rule(side, t[side], t[other(side)], tactics[side] ?? null, ctx);
      if (found) out.push(found);
    }
  }
  return out;
}
