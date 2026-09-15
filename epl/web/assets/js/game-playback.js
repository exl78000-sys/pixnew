/* 模擬遊玩的播放規劃(2026-09-15,使用者回報「一直有球員瞬間換位、莫名掉球、無故進球,根本沒有在踢球」)。

   舊版的「正常 / 快」是**剪接**:每個回合只演最後兩腳、主罰者與接球者離得遠就直接放到該在的地方(cutTo)、
   沒結局的回合一格內跳到終點(instant)。三種剪接在畫面上就是使用者看到的三件事:
   瞬間換位(cutTo)、莫名掉球(球一格跳到結局點、持球的人換成對手)、無故進球(射手被放到射門點 4 m 外再射)。
   剪接省了時間,但它讓畫面上的人**不是在踢球**。

   現在的規則只有一條:**演的段落一律連續、真人速度、不剪接任何人**;要省時間就整段跳過 ——
   畫面淡出、時鐘跳到那一分鐘、跳過的回合的事件照樣進事件流與比分(像轉播的精華)。
   這個模組決定「哪些回合演、哪些回合跳」,純函式、不碰畫面,所以測得到。

   ── 速度 ──
   即時   每個回合都演、停球照引擎的秒數等 —— 一場約 95 分鐘;只有這一檔的跑動量對得上真資料
   正常   演「有戲的回合」(射門 / 進球 / 牌 / 十二碼);它是從斷球 / 二點球 / 門將發球**連續**開始的話,
          連前面那一個回合一起演(球是怎麼丟的、反擊怎麼起的);從停球開始的(角球 / 任意球 / 界外球)前一段不演 ——
          跳段本來就落在停球上,跟轉播切到角球一樣。其餘整段跳過;停球最多演 3 秒,再長就剪到重新開始。
          一場約 8~12 分鐘(使用者要的;每一段都連前一個回合的話量出來 14.7 分)
   快     只演有戲的回合本身,不演前一個 —— 一場約 5 分鐘
   精華   只演進球、牌與十二碼(加前一個回合)
   「演」的定義在四檔裡都一樣(連續、真人速度),差別只在演哪幾段。 */

export const SPEEDS = {
  real: { zh: '即時(1 分鐘 = 1 分鐘)', deadSec: Infinity, context: false, ahead: 1 },
  normal: { zh: '正常(約 10 分鐘)', deadSec: 3.0, context: true, ahead: 14 },
  fast: { zh: '快(約 5 分鐘)', deadSec: 1.5, context: false, ahead: 14 },
  highlights: { zh: '精華(進球與牌)', deadSec: 2.0, context: true, ahead: 14 },
};

const hasEvent = (seq, types) => seq.events.some(e => types.includes(e.type));
const STOPPAGE = new Set(['kickoff', 'goalkick', 'throwin', 'freekick', 'corner', 'penalty']);   // 跟引擎、duel-anim 同一張表
/* 有戲的回合。射門(含被撲 / 中柱 / 封阻 / 射偏)、進球、牌、十二碼;精華只留進球 / 牌 / 十二碼。
   角球、犯規、越位、界外球本身不算 —— 它們在跳過的段落裡照樣進事件流,讀者在事件流看得到。 */
export function notable(seq, speed) {
  if (speed === 'real') return true;
  const pen = seq.start.type === 'penalty' || seq.end?.penalty === true;
  if (speed === 'highlights') return hasEvent(seq, ['goal', 'card']) || pen;
  return hasEvent(seq, ['shot', 'goal', 'card']) || pen;
}

/* 規劃下一步。queue 是引擎已產、畫面還沒處理的回合(連續、照順序)。回傳:
     skip  從 queue 開頭跳過幾個(事件照樣套進顯示狀態,畫面不演)
     play  跳過之後要不要演 queue 的下一個(0 / 1)
     need  要不要再向引擎多拿(找不到有戲的回合、而且看得還不夠遠)
   前一個回合當「戲的來由」只在正常 / 精華(context)、只在有戲的回合是連續開始的(不是停球),而且只在它**緊接在**
   有戲的回合前面 —— queue 本來就連續,所以 skip = k − 1 就是它。找到底都沒有戲的話,留最後一個在 queue 裡等下一輪(它可能是下一段戲的來由),
   其餘跳過;引擎已經完賽就全部跳過。 */
export function planPlayback(queue, { speed = 'normal', finished = false } = {}) {
  const sp = SPEEDS[speed] ?? SPEEDS.normal;
  const k = queue.findIndex(s => notable(s, speed));
  if (k >= 0) {
    const ctx = sp.context && k > 0 && !STOPPAGE.has(queue[k].start.type) ? 1 : 0;
    return { skip: k - ctx, play: 1, need: false };
  }
  if (!finished && queue.length < sp.ahead) return { skip: 0, play: 0, need: true };
  if (finished) return { skip: queue.length, play: 0, need: false };
  return { skip: Math.max(0, queue.length - (sp.context ? 1 : 0)), play: 0, need: true };
}

/* 這個回合怎麼演(交給 duel-anim 的 mode)。每一檔都是連續、真人速度;差別只有停球最多演幾秒、前面有沒有跳過的段落(要淡出淡入)。 */
export function modeFor(seq, { speed = 'normal', deadBefore = 0, jumped = false, label = null } = {}) {
  const sp = SPEEDS[speed] ?? SPEEDS.normal;
  return { fill: seq.dur, deadSec: Math.min(deadBefore, sp.deadSec), jump: jumped ? { label } : null };
}
