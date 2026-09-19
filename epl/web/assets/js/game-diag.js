/* 模擬遊玩:賽後戰術判讀與敘述。
 *
 * 界線(使用者 2026-09-03 與 2026-09-16 的決定):這一支只屬於模擬遊玩。
 * 它讀的是遊戲引擎自己的事件與回合,寫出來的是「這一場模擬裡發生了什麼」——
 * 不是本站的賽後報告、不進真實管線、不出現在單場分析頁。
 * 真實那一面的報告在 scripts/lib/report/,兩邊不共用也不互相 import。
 *
 * 三條規則是從真實報告層搬過來的(那一層的守門員是 lib/report/verify.mjs):
 *
 *   1. 文章裡出現的每一個數字,都要在同一條判讀的 evidence 裡找得到。
 *      `unattested()` 就是這條的檢查器,`test-game.mjs` 逐條驗 —— 模板是純函式,
 *      所以這條在測試時驗一次就夠,不必每次畫面都跑。
 *   2. 回傳空陣列是正常結果,不是失敗。一場平淡的比賽本來就沒什麼好講的,
 *      硬湊一句就是在編。
 *   3. 門檻一律是「兩隊互比」或「這一場的絕對次數」,不拿聯賽平均當尺。
 *      這不只是統計上的講究 —— 拿真實聯賽基準來評價模擬結果,就是把真實那一面
 *      的東西搬進遊戲裡,那正是這條界線要擋的。
 *
 * 座標沿用引擎:105 × 68,攻向 x = 105(十二碼點 (94, 34))。
 */

/* 模組層的常數一律宣告在檔案最前面 —— 渲染器在模組執行時就會被呼叫,
   而 const 不會提升(球員頁踩過:整張表不見,只有 console 一行 TDZ 錯誤)。 */
const THIRD_1 = 35;          // 自家三分之一
const THIRD_2 = 70;          // 中場三分之一
/* **只收可信的那兩類**(2026-09-19,階段 5a)。階段 4z 量過:情境標籤標的是「出身」
   (這次控球從哪裡開始)而不是上游的「波段」,串活得越久越不可信 ——
   `SetPiece` 的串中位 6 秒、`ThrowInSetPiece` 16 秒,兩類的佔比與離門都系統性偏掉;
   `FromCorner` 的串中位 **0 秒**,是唯一對得上真實的一類,`Penalty` 則是精確的。
   所以判讀只認這兩類,而且句子照著寫成「角球與十二碼」—— 不是「定位球」。
   (`FreeKick` 從清單裡拿掉:引擎結構上生不出直接罰球射門,列著只會悄悄過期。) */
const SET_PIECE_SITS = new Set(['FromCorner', 'Penalty']);
const SIDES = ['home', 'away'];
/* 兩隊互比時的「明顯差距」。1.6 倍是從真實報告層那支判讀搬過來的同一個值:
   低於它的差距在單場的樣本裡分不出是踢法還是運氣。 */
const EDGE = 1.6;
/* 數字驗證用的字面值。負號只有在前面不是數字時才算負號,否則 4-4-2 會被讀成 4、−4、−2。 */
const NUM = /(?<![\d.\-])-?\d+(?:\.\d+)?/g;

const round1 = x => Math.round(x * 10) / 10;
const shareOf = (a, b) => (b > 0 ? a / b : 0);
const other = side => (side === 'home' ? 'away' : 'home');
/* **進球不另外算一次射門**(2026-09-19,階段 5a)。連續引擎每一腳射門都先發一筆 `shot`,
   進了才再發 `goal` —— 舊的回合制引擎是「shot 或 goal」二選一,所以這一行原本寫成
   `type === 'shot' || type === 'goal'`。照舊寫法接上連續引擎,**每個進球都被算成兩次射門**:
   實測一場引擎 24 腳,這裡數出 29 腳,而畫面上那一句就寫著「射門 15 比 14」。
   `game-view` 的統計面板早就修好了(它的註解就在講這件事),**而這一份沒跟上** ——
   那是本站記過的「修好一份、忘了另一份複本」。
   烏龍球算在**得分方**(引擎的 goal 事件 side 就是得分方)—— 不過連續引擎還沒有烏龍球。 */
const isShot = e => e.type === 'shot';

/* 一個回合演完(或被略過)之後留下的簡記:丟球在哪個三分之一 —— 事件流沒有位置。
   只留四個欄位,不是整個回合物件:disp 是**顯示**狀態,塞進整個回合等於把引擎算好的未來也帶進去。
   放在這裡而不是 game-view:測試要驗的必須是畫面真的在用的那一支(game-view 在 Node 裡 import 不進來,
   留在那邊的話測試只能自己再拼一份,然後兩份會悄悄分家)。 */
export const chainBrief = seq => ({ side: seq.side, endType: seq.end?.type ?? null, endX: seq.end?.x ?? null, min: seq.min });

/* 一場模擬的逐側計數。
 *   events —— 畫面演過的事件(game-view 的 disp.events,不是引擎的 events():
 *             引擎已經算到未來幾秒,讀它會洩露還沒演的射門)
 *   chains —— 每個回合的簡記 { side, endType, endX },同樣只含演過或略過的回合
 *   poss   —— 兩隊各持球幾秒 */
export function tally({ events = [], chains = [], poss = { home: 0, away: 0 } } = {}) {
  const blank = () => ({
    seqs: 0, possSec: 0, possPct: 0,
    shots: 0, on: 0, off: 0, blocked: 0, gkStops: 0, goals: 0, xg: 0,
    boxShots: 0, longShots: 0, setPieceShots: 0,
    corners: 0, fouls: 0, yellow: 0, red: 0, offsides: 0,
    /* 丟球分三個三分之一。目前只有 lostOwn 有規則在用,另外兩個是同一組分解,
       留著是為了「這三個加起來 = lostTotal」在測試裡對得回去 —— 只數一格的話對不了帳。 */
    lostOwn: 0, lostMid: 0, lostAtt: 0, lostTotal: 0,
    firstGoal: null,
  });
  const t = { home: blank(), away: blank() };
  let seen = 0;   // 事件的先後順序(見下面「誰先進球」)
  const totalPoss = (poss.home ?? 0) + (poss.away ?? 0);
  for (const side of SIDES) {
    t[side].possSec = Math.round(poss[side] ?? 0);
    t[side].possPct = totalPoss > 0 ? Math.round(100 * (poss[side] ?? 0) / totalPoss) : 0;
  }
  for (const e of events) {
    seen++;
    const s = t[e.side];
    if (!s) continue;
    if (e.type === 'goal') {
      s.goals++; s.on++;
      /* `at` 是事件在事件流裡的位置,用來判斷誰先進球 —— **不可以拿 min 比**:
         補時的 min 一律是 90(或 45),所以 90+1 跟 90 用 min 比會平手,先後就看誰寫在前面。
         這跟 CLAUDE.md 那條「官方把補時全部記成第 90 分」是同一個坑,只是這次的上游是自己的引擎。 */
      if (s.firstGoal == null) s.firstGoal = { min: e.min, extra: e.extra ?? null, at: seen };
    }
    if (isShot(e)) {
      s.shots++;
      s.xg = round1(s.xg + (e.xg ?? 0));
      /* 三種下場**不在射門事件上** —— 它們是後來才發生的,各自有自己的事件
         (`goal` / `save` / `block`)。原本這裡讀 `e.outcome`,而連續引擎的射門事件
         根本沒有那個欄位:於是「射正」等於進球數、「被封阻」永遠是 0。
         改成在下面按事件型別數,跟 `game-view` 的統計面板同一條規則。 */
      if (e.inBox != null) { if (e.inBox) s.boxShots++; else s.longShots++; }
      if (SET_PIECE_SITS.has(e.sit)) s.setPieceShots++;
    }
    /* 射正 = 進球 + 被撲出;被封阻**只算場上球員**(門將碰到的球上游記成撲救,
       而引擎把它分成 `gk: true` 的 block 事件 —— 混進來的話本站的封阻會被**虛報將近一倍**
       (30 場實測:場上球員 1.0 腳/場、門將 0.8 腳/場),見階段 5a)。
       偏出在最後用「射門 − 其餘三類」算,四類才會剛好把射門數分完。 */
    if (e.type === 'save') s.on++;
    if (e.type === 'block' && !e.gk) s.blocked++;
    if (e.type === 'block' && e.gk) s.gkStops++;
    if (e.type === 'corner') s.corners++;
    if (e.type === 'foul') s.fouls++;
    if (e.type === 'offside') s.offsides++;
    if (e.type === 'card') { if (e.card === 'yellow') s.yellow++; else s.red++; }
  }
  for (const c of chains) {
    const s = t[c.side];
    if (!s) continue;
    s.seqs++;
    if (c.endType !== 'turnover' || c.endX == null) continue;
    s.lostTotal++;
    if (c.endX < THIRD_1) s.lostOwn++;
    else if (c.endX < THIRD_2) s.lostMid++;
    else s.lostAtt++;
  }
  /* 偏出是**算出來的**,不是另外數的:射門 − 射正 − 被封阻 − 門將擋掉。
     另外數一次就是「同一件事兩個計數器」,而本站已經為那件事付過代價。
     夾在 0 以上是**防禦性**的:事件是照時間順序來的,射門一定先於它的下場,
     所以照理不會是負的 —— 但這是一條減法,而畫面那一側餵進來的是**演過的**那一份,
     寧可夾住也不要在畫面上印一個負數。 */
  for (const side of SIDES) {
    const s = t[side];
    s.off = Math.max(0, s.shots - s.on - s.blocked - s.gkStops);
  }
  return t;
}

/* 每條規則吃(是哪一隊、我方計數、對方計數),回傳一條判讀或 null。
   null 就是「這場沒這回事」—— 那是正常結果。 */
const RULES = [
  /* 進不了禁區,只能遠射。「看起來有在攻、其實沒威脅」的典型長相。 */
  function longRange(side, me) {
    if (me.shots < 8 || me.longShots < 4) return null;
    const share = shareOf(me.longShots, me.shots);
    if (share < 0.35) return null;
    return {
      side, kind: 'long-range',
      text: `進不了禁區:${me.shots} 次射門有 ${me.longShots} 次來自禁區外(${Math.round(share * 100)}%)`,
      evidence: { 射門: me.shots, 禁區外射門: me.longShots, 禁區外佔比: Math.round(share * 100) },
    };
  },

  /* 出球被壓在自家三分之一。用兩隊互比 —— 丟球本來就多,重點是丟在哪裡。
     標題刻意只講**量到的那件事**:第一版寫「出不了後場」,而 seed 4 的 ARS 一邊 3.4 倍
     一邊射門 23 比 5、贏 3-1,那句話讀起來就是假的。丟球多不等於打不出去,
     所以射門還領先時把兩個數字擺進去讓讀者自己判斷(這裡沒有量「丟球有沒有變成對方的機會」,
     不要替它講)。 */
  function pressed(side, me, opp) {
    if (me.lostOwn < 6) return null;
    const mine = shareOf(me.lostOwn, me.seqs);
    const theirs = shareOf(opp.lostOwn, opp.seqs);
    if (theirs <= 0 || mine < theirs * EDGE) return null;
    const ahead = me.shots > opp.shots;
    const evidence = { 進攻回合: me.seqs, 自家三分之一丟球: me.lostOwn, 倍數: round1(mine / theirs) };
    if (ahead) { evidence.我方射門 = me.shots; evidence.對手射門 = opp.shots; }
    return {
      side, kind: 'pressed',
      text: `後場出球常被斷:${me.seqs} 次進攻有 ${me.lostOwn} 次在自家三分之一就丟球,比例是對手的 ${round1(mine / theirs)} 倍`
        + (ahead ? `(不過射門仍是 ${me.shots} 比 ${opp.shots})` : ''),
      evidence,
    };
  },

  /* 靠定位球。門檻是絕對次數加佔比 —— 兩三次的比例毫無資訊。 */
  function setPieces(side, me) {
    if (me.setPieceShots < 4) return null;
    const share = shareOf(me.setPieceShots, me.shots);
    if (share < 0.4) return null;
    return {
      side, kind: 'set-piece',
      text: `威脅集中在角球與十二碼:${me.shots} 次射門有 ${me.setPieceShots} 次是這兩種(${Math.round(share * 100)}%)`,
      evidence: { 射門: me.shots, 角球與十二碼射門: me.setPieceShots, 佔比: Math.round(share * 100) },
    };
  },

  /* 有球沒有威脅。控球多而射門少,是「控得住但打不穿」那種比賽的長相。 */
  function possNoThreat(side, me, opp) {
    if (me.possPct < 55 || me.shots >= opp.shots) return null;
    if (opp.shots - me.shots < 3) return null;
    return {
      side, kind: 'poss-no-threat',
      text: `控得住但打不穿:控球 ${me.possPct}%,射門卻是 ${me.shots} 比 ${opp.shots}`,
      evidence: { 控球百分比: me.possPct, 我方射門: me.shots, 對手射門: opp.shots },
    };
  },

  /* 被完全壓制。一面倒的比賽裡最該講的一句。 */
  function outshot(side, me, opp) {
    if (opp.shots < 12 || me.shots < 1) return null;
    if (opp.shots / me.shots < 2.5) return null;
    return {
      side, kind: 'outshot',
      text: `幾乎沒有進攻:全場 ${me.shots} 次射門對上對手的 ${opp.shots} 次`,
      evidence: { 我方射門: me.shots, 對手射門: opp.shots },
    };
  },

  /* 把握度。xG 與進球的差距 —— 講的是這一場,不是能力。
     門檻 1.5 球:模擬的 xG 是每次射門抽到的那一筆真實射門的 xG,單場波動本來就大。 */
  function finishing(side, me) {
    if (me.shots < 6) return null;
    const gap = round1(me.goals - me.xg);
    if (Math.abs(gap) < 1.5) return null;
    return {
      side, kind: gap > 0 ? 'clinical' : 'wasteful',
      text: gap > 0
        ? `把握度超出機會質量:${me.shots} 次射門的 xG 合計 ${me.xg},進了 ${me.goals} 球`
        : `機會做出來了沒進:${me.shots} 次射門的 xG 合計 ${me.xg},只進 ${me.goals} 球`,
      evidence: { 射門: me.shots, xG: me.xg, 進球: me.goals, 差距: gap },
    };
  },

  /* 紀律。黃牌要夠多、而且要比對手明顯多;紅牌單獨成一條(它一定值得講)。 */
  function discipline(side, me, opp) {
    if (me.red > 0) {
      return {
        side, kind: 'red',
        text: `吃了 ${me.red} 張紅牌,全場犯規 ${me.fouls} 次`,
        evidence: { 紅牌: me.red, 犯規: me.fouls },
      };
    }
    if (me.yellow < 3 || me.yellow < opp.yellow + 2) return null;
    return {
      side, kind: 'discipline',
      text: `犯規累積:${me.fouls} 次犯規吃了 ${me.yellow} 張黃牌,比對手多 ${me.yellow - opp.yellow} 張`,
      evidence: { 犯規: me.fouls, 黃牌: me.yellow, 多出的黃牌: me.yellow - opp.yellow },
    };
  },
];

/* 主入口。回傳的陣列可能是空的 —— 那是正常結果,不是失敗。 */
export function diagnose(t) {
  const out = [];
  for (const side of SIDES) {
    for (const rule of RULES) {
      const found = rule(side, t[side], t[other(side)]);
      if (found) out.push(found);
    }
  }
  return out;
}

/* 使用者把哪幾個指令調離了「本季實際踢法」。
 *
 * 這一段刻意**不**宣稱因果:一場模擬分不出結果是調整造成的還是抽樣造成的,
 * 要證明得跑很多場(而那是另一件事)。所以只陳述調了什麼、以及這一場的結果,
 * 由讀者自己判斷 —— 鐵則四:不確定性要寫在畫面上。 */
export function tacticNotes(tactics = {}, labels = {}) {
  const out = [];
  for (const side of SIDES) {
    const t = tactics[side];
    if (!t?.levels || !t?.defaults) continue;
    const moved = Object.keys(t.levels)
      .filter(k => t.levels[k] !== t.defaults[k])
      .map(k => ({ key: k, zh: labels[k] ?? k, from: t.defaults[k], to: t.levels[k] }));
    if (moved.length) out.push({ side, moved });
  }
  return out;
}

/* 賽後敘述。過去式、只講這一場模擬,而且每個數字都在 evidence 裡。
   回傳 [{ text, evidence }] —— 跟判讀同一個形狀,才能用同一個檢查器驗。 */
export function recap(t, { homeName, awayName, score, diag = [] } = {}) {
  const [hs, as] = score ?? [t.home.goals, t.away.goals];
  const out = [];
  const winner = hs > as ? homeName : as > hs ? awayName : null;
  const lead = t.home.firstGoal && t.away.firstGoal
    ? (t.home.firstGoal.at < t.away.firstGoal.at ? 'home' : 'away')
    : t.home.firstGoal ? 'home' : t.away.firstGoal ? 'away' : null;

  /* 第一段:比分與先進球。沒有進球的話就直說,不硬湊過程。 */
  if (lead) {
    const f = t[lead].firstGoal;
    const first = lead === 'home' ? homeName : awayName;
    const minText = f.extra ? `${f.min}+${f.extra}` : `${f.min}`;
    const tailEv = { 主隊進球: hs, 客隊進球: as, 先進球分鐘: f.min };
    if (f.extra) tailEv.先進球補時 = f.extra;
    out.push({
      text: winner
        ? `這場模擬 ${homeName} ${hs} 比 ${as} ${awayName}。${first} 在第 ${minText} 分鐘先進球,${winner} 拿下比賽。`
        : `這場模擬 ${homeName} ${hs} 比 ${as} ${awayName} 握手言和。${first} 在第 ${minText} 分鐘先進球,但沒能守到最後。`,
      evidence: tailEv,
    });
  } else {
    out.push({
      text: `這場模擬 ${homeName} ${hs} 比 ${as} ${awayName},兩隊都沒有進球。`,
      evidence: { 主隊進球: hs, 客隊進球: as },
    });
  }

  /* 第二段:兩隊的數字對比。這一段不下判斷,只把三組數字擺在一起。 */
  out.push({
    text: `射門 ${t.home.shots} 比 ${t.away.shots}(射正 ${t.home.on} 比 ${t.away.on}),`
      + `xG ${t.home.xg} 比 ${t.away.xg},控球 ${t.home.possPct}% 比 ${t.away.possPct}%。`,
    evidence: {
      主隊射門: t.home.shots, 客隊射門: t.away.shots,
      主隊射正: t.home.on, 客隊射正: t.away.on,
      主隊xG: t.home.xg, 客隊xG: t.away.xg,
      主隊控球: t.home.possPct, 客隊控球: t.away.possPct,
    },
  });

  /* 第三段只在**一條判讀都沒有**時才有 —— 規則二:空結果是正常結果,要講出來。
     有判讀的時候不在這裡重述一遍:畫面上每一條連同它的依據就列在這幾段下面,
     再寫一次只是同一份東西畫兩次(而且會長到讀不下去:seed 31 有五條)。 */
  if (!diag.length) out.push({ text: '兩隊的數字沒有拉開到足以下判斷的程度,這一場沒有特別的戰術判讀。', evidence: {} });
  return out;
}

/* 數字驗證 —— 文章裡的每一個數字都要在 evidence 找得到。
 *
 * 跟真實那一層的差別:那邊守的是 LLM 會編數字,所以擋在發布前;
 * 這邊的文字是純函式產的,同樣的輸入一定得到同樣的輸出,所以驗一次就夠 ——
 * `test-game.mjs` 拿真的模擬結果逐條跑。
 *
 * names 是隊名,掃描前先剝掉:德甲那種名字自己帶數字(Schalke 04、Bayer 04),
 * 不剝的話 04 會被當成一個沒有出處的數字。 */
export function unattested(text, evidence = {}, names = []) {
  const allowed = new Set();
  for (const v of Object.values(evidence)) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) continue;
    const n = Number(v);
    allowed.add(n);
    allowed.add(Math.abs(n));
    for (const d of [0, 1]) allowed.add(Number(n.toFixed(d)));
  }
  let prose = text;
  for (const nm of names) if (nm) prose = prose.split(nm).join('　');
  const bad = [];
  for (const m of prose.matchAll(NUM)) {
    const n = Number(m[0]);
    if (allowed.has(n)) continue;
    const d = (m[0].split('.')[1] ?? '').length;
    if ([...allowed].some(v => Number(v.toFixed(d)) === n)) continue;
    bad.push(m[0]);
  }
  return bad;
}
