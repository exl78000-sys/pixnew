/* 連續時間引擎與畫面之間的轉接層(2026-09-16,階段 3)。
 *
 * 為什麼要有這一層:`game-sim.js` 想的是球與二十二個人,`game-view.js` 想的是
 * 記分板、統計面板、陣容與播報。中間的翻譯放在頁面裡的話,下一支消費端(測試、別的版面)
 * 就會各抄一份 —— 本站在「複製一份轉換過去,改了一邊另一邊會悄悄過期」上付過很多次代價。
 *
 * **時鐘只有一個。** 舊版是「引擎已經算到未來幾秒、畫面追在後面」,所以有兩份狀態
 * (引擎的與 disp 的),統計面板一不小心就會提前洩露還沒演的射門。連續引擎不需要那樣:
 * 畫面每一格推進多少秒,引擎就走多少秒,**事件在被推進出來的那一刻就是「已經發生」**。
 * 所以這一層的 `advance()` 回傳「這一格新長出來的事件」,畫面照收即可。
 *
 * 這一層**不做任何模型上的決定** —— 不改機率、不改 λ、不補事件。它只翻譯。
 */
import { createSim } from './game-sim.js?v=1addf695';

/* 播放速度是**時間倍率**,不是剪接。舊版四檔的差別在「演哪幾段」(cutTo / finishInstant /
   整段跳過),而使用者的原話是「根本沒有在踢球」。現在四檔的差別只有一個:一秒真實時間
   等於幾秒比賽時間。**沒有任何一格被跳過**,所以不會再有「瞬間換位、莫名掉球」。
   倍率挑的是「一場大約多久看完」:96 分鐘的比賽 ÷ 倍率。 */
export const LIVE_SPEEDS = {
  real: { zh: '真實速度(約 96 分鐘)', mult: 1 },
  normal: { zh: '標準(約 12 分鐘)', mult: 8 },
  fast: { zh: '快(約 6 分鐘)', mult: 16 },
  rush: { zh: '極快(約 3 分鐘)', mult: 32 },
};

/* 先發 / 板凳 / 陣型的預設值。搬到這裡是為了讓頁面**完全不必 import 舊引擎** ——
   舊引擎還在倉庫裡(它自己的測試還在跑),但它已經不是這一頁的引擎了。 */
export function defaultSetup(profile, code) {
  const t = profile.teams[code];
  return { xi: [...t.xi], bench: [...t.bench],
    formation: t.formation.latest ?? t.formation.predicted ?? t.formation.options[0] ?? '4-4-2' };
}

export function createLiveMatch({ profile, home, away, pred, seed = 1, setup = {} } = {}) {
  const sim = createSim({ profile, home, away, seed, setup, pred });
  const cal = sim.calibration();
  const squads = {
    home: new Map((profile.teams[home]?.squad ?? []).map(p => [p.code, p])),
    away: new Map((profile.teams[away]?.squad ?? []).map(p => [p.code, p])),
  };
  const codeOf = { home, away };
  let drained = 0;

  /* 新長出來的事件。**每一筆都補上 `team`(隊碼)** —— 畫面用它查隊名 / 隊徽,
     而 side 只有 home / away 兩個字,查不到身分。 */
  function drain() {
    const all = sim.events();
    const fresh = all.slice(drained);
    drained = all.length;
    return fresh.map(e => ({ ...e, team: e.side ? codeOf[e.side] : null }));
  }

  const sideState = sd => {
    const st = sim.state(), c = st.counts;
    const players = st.players.filter(p => p.side === sd);
    return {
      shots: c.shotsBy[sd], on: c.onTargetBy[sd], blocked: c.blockedBy[sd],
      xg: st.xg[sd], corners: c.corners[sd], fouls: c.fouls[sd], offsides: c.offsides[sd],
      yellow: c.cards[sd] - c.reds[sd], red: c.reds[sd], subs: c.subs[sd],
      onPitch: players.map(p => p.code),
      poss: st.poss[sd],
    };
  };

  return {
    /* 推進 `sec` 秒的比賽時間,回傳這一段新長出來的事件(照發生順序)。 */
    advance(sec) { sim.advance(sec); return drain(); },
    /* 給球場繪製用的那一刻(`game-pitch.js` 的 draw 吃這個) */
    pitch: () => sim.state(),
    state() {
      const st = sim.state();
      return {
        finished: st.over, half: st.half, clock: st.clock, added: st.added,
        score: st.score, home: sideState('home'), away: sideState('away'),
        possSec: { ...st.poss }, counts: st.counts,
      };
    },
    /* λ 是**錨**,不是即時估計:它就是站上對這一場的預測,整場不變。
       換人與紅牌在這個引擎裡**是真的少一個人 / 換一個人**,影響從場上長出來,
       不透過改 λ 去模擬 —— 所以這裡不回傳「調整後的 λ」,只回傳錨與紅牌數,
       讓畫面自己決定要不要把紅牌交給即時勝率模型。 */
    lambdas: () => ({ home: cal.home?.lambda ?? null, away: cal.away?.lambda ?? null,
      redHome: sim.state().counts.reds.home, redAway: sim.state().counts.reds.away }),
    calibration: () => cal,
    chains: () => sim.chains(),
    possTarget: () => sim.possTarget(),
    playerOf: (side, code) => squads[side]?.get(code) ?? null,
    benchOf: side => sim.benchOf(side),
    sub: (side, off, on) => sim.substitute(side, off, on),
    setTactics: (side, levels) => sim.setTactics(side, levels),
  };
}
