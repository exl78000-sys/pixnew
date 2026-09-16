import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clamp, round } from './util.mjs';

/* 單場比賽的控球鏈事件模擬。
 *
 * 這一支產生的是「敘事」,不是「預測」。
 *
 * 為什麼要分清楚:預測由 poisson.mjs 負責,那一層有走查回測與校準曲線撐著,
 * 是真的對現實負責的。事件引擎沒有那種保證 —— 它只是把一個已經算好的 λ
 * 攤成 90 分鐘裡看起來合理的過程。所以這裡採**配額法**:
 *
 *   1. 先用 λ 抽出本場進球數 n ~ Poisson(λ)
 *   2. 事件鏈自由跑,產生一堆射門機會,每次機會帶一個 xG
 *   3. 把所有機會的 xG 等比縮放,讓 Σ xG 剛好等於 λ
 *   4. 從這些機會裡「依 xG 加權」抽出 n 個當成進球
 *
 * 第 4 步是關鍵:進球不是各自擲骰決定的(那樣總進球數會偏離 λ),
 * 而是先決定有幾球、再決定是哪幾次機會進的。這樣品質高的機會比較容易是
 * 破門的那一次,但總數永遠對得上上層模型。
 *
 * ⚠ 這是模擬,不是實況。前端必須把它跟官方即時比分明確分開 ——
 *   讀者不能把「第 67 分鐘某某內切被放倒」誤認為真的發生過。
 *   同 lineup.mjs / roles.mjs 的立場:推導出來的東西一定要標示。
 */

/* ── 平衡參數 ────────────────────────────────
 * 全部住在 data/event-table.json,程式裡不留硬編碼的數字。
 * 要調平衡改那份 JSON 就好,不必動這支檔案 —— 也因此那份 JSON 必須被檢查:
 * 少一個欄位、型別寫錯、或數字超出合理範圍,都會在載入時就爆,
 * 而不是默默產生幾百場怪比賽再由人去發現。
 *
 * 改完一定要跑 `npm run sim:check` 對三季真實資料重新對帳。
 */
const TABLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'event-table.json');

function loadTable(path = TABLE_PATH) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`讀不到事件表 ${path}:${e.message}`);
  }
  return validateTable(raw, path);
}

/* 每一條檢查都對應一種「手滑就會靜靜壞掉」的情況。
   刻意不做自動修正 —— 把錯的數字改成合理值,只會讓人以為自己調的有生效。 */
export function validateTable(t, where = 'event-table') {
  const bad = msg => { throw new Error(`${where} 不合法:${msg}`); };
  const prob = (obj, key, lo = 0, hi = 1) => {
    const v = obj?.[key];
    if (typeof v !== 'number' || Number.isNaN(v)) bad(`${key} 必須是數字`);
    if (v < lo || v > hi) bad(`${key} = ${v},超出合理範圍 ${lo}~${hi}`);
  };
  const pair = (obj, key) => {
    const v = obj?.[key];
    if (!Array.isArray(v) || v.length !== 2) bad(`clamps.${key} 必須是 [下限, 上限]`);
    if (!(v[0] < v[1])) bad(`clamps.${key} 的下限必須小於上限`);
  };

  for (const k of ['rates', 'gate', 'mix', 'clamps', 'timeline', 'chanceTypes', 'phrases', 'tails']) {
    if (!t?.[k] || typeof t[k] !== 'object') bad(`缺少 ${k} 區段`);
  }

  // 四道關卡是連乘的,任何一關寫成 0 或 1 都會讓整條鏈失去意義
  for (const k of ['buildUp', 'progress', 'finalThird', 'createChance']) prob(t.rates, k, 0.05, 0.95);
  for (const k of ['foulPerChain', 'freeKickShot', 'yellowPerFoul', 'penaltyPerTeam',
    'cornerFromCross', 'cornerFromShot', 'saveShare', 'blockShare', 'wideBase',
    'chainTilt', 'homeChainEdge', 'homePossEdge', 'chainsTempo']) prob(t.rates, k, 0, 1);
  prob(t.rates, 'chains', 40, 600);

  prob(t.gate, 'exponent', 0, 1);
  prob(t.gate, 'floor', 0.2, 1);
  prob(t.gate, 'cap', 1, 2.5);
  prob(t.gate, 'absoluteCap', 0.5, 1);
  if (t.gate.floor >= t.gate.cap) bad('gate.floor 必須小於 gate.cap');

  for (const k of ['crossHigh', 'headerFromHigh', 'cutbackFromLow', 'dribbleGate',
    'oneOnOneFromDribble', 'crossFirstTime', 'flatten', 'priorPct', 'finishingEdge']) prob(t.mix, k, 0, 1);

  for (const k of ['chainShare', 'possShare', 'possession', 'saveP', 'wide', 'finishing']) pair(t.clamps, k);
  prob(t.clamps, 'possessionDepthWeight', 0, 1);

  prob(t.timeline, 'bigChanceXg', 0, 1);
  prob(t.timeline, 'missNoteXg', 0, 1);
  if (!Number.isInteger(t.timeline.cap) || t.timeline.cap < 4) bad('timeline.cap 必須是不小於 4 的整數');

  // 機會類型:xG 必須是機率,而且要有中文名(時間軸會直接顯示)
  const types = Object.entries(t.chanceTypes);
  if (!types.length) bad('chanceTypes 是空的');
  for (const [k, v] of types) {
    if (typeof v?.xg !== 'number' || v.xg <= 0 || v.xg > 1) bad(`chanceTypes.${k}.xg 必須介於 0~1`);
    if (typeof v?.zh !== 'string' || !v.zh) bad(`chanceTypes.${k}.zh 必須是非空字串`);
  }
  // 引擎會直接引用這幾種,少一種就會在半場中間丟 undefined
  for (const k of ['penalty', 'oneOnOne', 'closeRange', 'cutback', 'boxShot', 'header', 'freeKick', 'longShot']) {
    if (!t.chanceTypes[k]) bad(`chanceTypes 缺少 ${k}`);
  }

  /* 播報:每種事件至少要兩種說法。只有一種的話,同一場裡一定會逐字重複 ——
     那正是實測踩過的問題(每 120 場相鄰重複 16 次)。 */
  for (const k of ['goalOpener', 'goalEqualiser', 'goal', 'goalAssisted',
    'bigChance', 'save', 'block', 'off', 'yellow']) {
    const list = t.phrases[k];
    if (!Array.isArray(list) || list.length < 2) bad(`phrases.${k} 至少要有兩種說法`);
    if (list.some(x => typeof x !== 'string' || !x.trim())) bad(`phrases.${k} 含空字串`);
  }
  for (const k of ['save', 'block', 'off']) {
    if (typeof t.tails[k] !== 'string' || !t.tails[k]) bad(`tails.${k} 必須是非空字串`);
  }
  return t;
}

const TABLE = loadTable();

export const RATES = TABLE.rates;
export const CHANCE_TYPES = TABLE.chanceTypes;
const GATE = TABLE.gate;
const MIX = TABLE.mix;
const CL = TABLE.clamps;
const TL = TABLE.timeline;

/* ── 播報模板 ──────────────────────────────────
 * 每個事件三種說法,用 token 代入,全程不過 LLM。
 *
 * 為什麼不讓 LLM 寫:一場要產生數十條播報,乘上每輪十場 —— 慢、貴,
 * 而且會幻覺出不存在的球員。文字這一層本來就該是確定性的。
 * LLM 只在 report/ 那邊寫最後一段人話總結,那裡有 verify.mjs 擋著數字。
 *
 * {p}=動作者 {a}=助攻者 {t}=球隊 {g}=門將
 */
export const PHRASES = TABLE.phrases;

// 接在「錯失大好機會」後面的短尾,不再重複人名
const TAILS = TABLE.tails;

// 時間軸只留看得出戲的事件。全部 500 多條丟上去沒人看,bundle 也會爆。
const BIG_CHANCE_XG = TL.bigChanceXg;
const TIMELINE_CAP = TL.cap;

// ── 控球鏈狀態(對應設計文檔的六個狀態)────────────
export const STATES = {
  buildUp:    '後場出球',
  midfield:   '中場推進',
  finalThird: '前場組織',
  wide:       '邊路傳中',
  through:    '中路直塞',
  chance:     '射門機會',
};

// ── 事件型別(自訂命名,與任何商業遊戲無關)────────
export const EVENT = {
  kickOff:  '開球',
  buildUp:  '後場組織',
  progress: '推進過半場',
  dribble:  '帶球突破',
  cross:    '傳中',
  through:  '直塞',
  shot:     '射門',
  goal:     '進球',
  save:     '門將撲救',
  block:    '封阻',
  off:      '射偏',
  corner:   '角球',
  foul:     '犯規',
  yellow:   '黃牌',
  turnover: '失去球權',
  halfTime: '中場',
  fullTime: '終場',
};

/* ── 隨機源 ────────────────────────────────────
 * xorshift32,跟 simulate.mjs 用的是同一支核心。
 *
 * 但這裡多了一段 seed 混合:xorshift32 對小 seed 的前幾個輸出品質極差
 * (seed=1 時開頭連續吐出接近 0 的值)。而我們會拿來當 seed 的正是
 * fixture 序號這種小整數 —— 不混的話,第一個 Poisson 抽樣會系統性偏 0,
 * 整季的模擬比分會全部偏低。用 murmur3 的 finalizer 打散再空轉幾輪。
 *
 * 站是靜態產生的,同一場重新 build 必須得到同一份事件流,否則讀者每次重整
 * 看到的比賽都不一樣。 */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
  s = ((s ^ (s >>> 16)) >>> 0) || 1;

  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();   // 空轉,丟掉暖機期

  next.int = n => Math.floor(next() * n);
  next.pick = arr => arr[Math.floor(next() * arr.length)];
  next.poisson = l => {                   // Knuth,與 simulate.mjs 相同
    const L = Math.exp(-l);
    let k = 0, p = 1;
    do { k++; p *= next(); } while (p > L);
    return k - 1;
  };
  // Box-Muller,與 simulate.mjs 相同
  next.gauss = () => {
    const u = Math.max(1e-12, next()), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  next.weighted = weights => {
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    let r = next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  };
  return next;
}

/* ── 球員指標 ──────────────────────────────────
 * xi 來自 projectXI,是 slim 過的(只有 code/name/role),沒有 per-90 指標,
 * 所以要拿完整的 players 陣列回查。本季樣本夠就用本季,否則退回上季 ——
 * 跟 lineup.mjs 的 currentWeight 同一個邏輯,門檻沿用 roles.mjs 的 450 分鐘。 */
const QUALIFY = 450;

function statOf(player) {
  if (!player) return null;
  const cur = player.current;
  if (cur && cur.minutes >= QUALIFY) return cur;
  return player.last ?? cur ?? null;
}

/* ── 升班馬先驗 ────────────────────────────────
 *
 * 踩過的最大一個雷,寫清楚免得再犯。
 *
 * 升班馬的球員沒有英超紀錄,原本的寫法是給一組寫死的預設值。實測結果:
 * Hull 先發十一人的 creativity90 與 threat90 **全部是 0.00**。經過 matchup()
 * 正規化之後,對手的相對強度變成約 2.0、他們自己約 0,所有關卡直接頂到
 * 上下限 —— 比賽變成一面倒的假象(NFO vs COV 0-3、MCI vs SUN 5-0),
 * 而且整體場均射門被拉低 17%(20 隊 25.1、把三支升班馬拿掉剩 20.8)。
 *
 * 正確做法跟 poisson.mjs 的 applyPromotedPrior 一致:沒有track record 的
 * 就給**聯盟同位置的後段先驗**,不是給零。這樣升班馬會像一支弱隊,
 * 而不是像一支不存在的隊。
 *
 * 樣本介於中間的(踢了一些但還不夠)按出場時間線性混合 ——
 * 跟 lineup.mjs 的 currentWeight 同一個處理方式。 */
const PRIOR_PCT = MIX.priorPct;
const METRICS = ['creativity90', 'threat90', 'xg90', 'xa90', 'cbi90', 'tackles90', 'shotStop'];

const priorCache = new WeakMap();

function leaguePrior(players) {
  if (priorCache.has(players)) return priorCache.get(players);
  const byRole = new Map();
  for (const p of players) {
    const st = statOf(p);
    if (!st || (st.minutes ?? 0) < QUALIFY) continue;     // 只用樣本足夠的人建立母體
    const role = p.role ?? 'CM';
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(st);
  }
  const pick = (list, k) => {
    const v = list.map(s => s[k]).filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length * PRIOR_PCT)] : 0;
  };
  const out = new Map();
  for (const [role, list] of byRole) {
    out.set(role, Object.fromEntries(METRICS.map(k => [k, pick(list, k)])));
  }
  // 整個聯盟的後段值,當作連該位置都找不到時的最後退路
  const all = [...byRole.values()].flat();
  out.set('*', Object.fromEntries(METRICS.map(k => [k, pick(all, k)])));
  priorCache.set(players, out);
  return out;
}

/* 把先發十一人接上指標。找不到的球員給同位置的聯盟後段先驗,
   不要讓他消失 —— 陣容是 11 人,少一個會讓權重分母錯掉。 */
function attach(xi, players) {
  const byCode = new Map(players.map(p => [String(p.code), p]));
  const prior = leaguePrior(players);

  return xi.map(slim => {
    const role = slim.role ?? (slim.pos === 'GK' ? 'GK' : 'CM');
    const st = statOf(byCode.get(String(slim.code)));
    const pr = prior.get(role) ?? prior.get('*');
    // 樣本權重:打滿門檻就完全用自己的,完全沒踢過就完全用先驗,中間線性混合
    const w = Math.min(1, Math.max(0, (st?.minutes ?? 0) / QUALIFY));
    const v = k => {
      const own = Number.isFinite(st?.[k]) ? st[k] : null;
      const base = pr?.[k] ?? 0;
      return own === null ? base : w * own + (1 - w) * base;
    };
    return {
      code: slim.code,
      name: slim.name,
      role,
      pos: slim.pos,
      // 🟡 代理指標:FPL 沒有傳球成功率與對抗成功率,用 creativity90 / cbi90 頂替。
      //    見設計文檔 2.4 —— 這是已知的精度上限,不是疏漏。
      passing:   v('creativity90'),
      threat:    v('threat90'),
      xg90:      v('xg90'),
      xa90:      v('xa90'),
      cbi:       v('cbi90'),
      tackles:   v('tackles90'),
      shotStop:  v('shotStop'),
      finishing: st?.finishing ?? 0,
      cards:     st?.cards ?? 0,
      lowSample: w < 1,
    };
  });
}

const inRoles = (squad, roles) => squad.filter(p => roles.includes(p.role));
const avg = (arr, f) => (arr.length ? arr.reduce((a, p) => a + f(p), 0) / arr.length : 0);

/* 由先發十一人算出各分區的原始強度。單位各不相同,不能直接互比 —— 正規化在 matchup()。 */
function profile(squad) {
  const back = inRoles(squad, ['CB', 'FB']);
  const mid = inRoles(squad, ['DM', 'CM']);
  const att = inRoles(squad, ['AM', 'W', 'ST']);
  const wide = inRoles(squad, ['W', 'FB']);
  const gk = inRoles(squad, ['GK'])[0] ?? null;

  return {
    build: avg(back, p => p.passing) + avg(mid, p => p.passing) * 0.5,
    midfield: avg(mid, p => p.passing) + avg(mid, p => p.threat) * 0.3,
    attack: avg(att, p => p.threat),
    wideness: avg(wide, p => p.passing),
    press: avg(mid, p => p.tackles) + avg(back, p => p.tackles),
    defence: avg(back, p => p.cbi) + avg(mid, p => p.tackles) * 0.5,
    keeper: gk?.shotStop ?? 1,
    squad, back, mid, att, wide, gk,
  };
}

/* ── 正規化 ────────────────────────────────────
 * 這是第一版最大的錯誤所在,寫下來免得再犯:
 *
 * 原本直接拿 build(creativity90 量級 ~20)去對 press(tackles90 量級 ~2),
 * 算出來永遠是壓倒性勝利,所有關卡形同虛設 —— 射門數暴衝到實際值的五倍。
 *
 * 正確做法是**同指標在兩隊之間互比**:兩隊的 build 互比得到各自的相對值
 * (勢均力敵 = 1.0),兩隊的 press 互比得到各自的相對值,然後才拿
 * 「我的相對進攻」除以「他的相對防守」去調整基準機率。不同單位就不會互相污染。
 */
function matchup(h, a) {
  const pair = (x, y) => { const m = (x + y) / 2 || 1; return [x / m, y / m]; };
  const keys = ['build', 'midfield', 'attack', 'wideness', 'press', 'defence', 'keeper'];
  const rel = { home: {}, away: {} };
  for (const k of keys) {
    const [rh, ra] = pair(h[k], a[k]);
    rel.home[k] = rh; rel.away[k] = ra;
  }
  return rel;
}

/* 基準機率依「我方相對強度 / 對方相對強度」調整。
 *
 * 指數與上下限都是刻意壓過的。四道關卡是連乘的,所以單關放寬一點點,
 * 整條鏈就會放大四次方 —— 上限放到 1.6 倍時,模擬跑出過單隊 59 次射門
 * (英超三季的實際上限是 37 次),射門數的標準差也比真實高出三成。
 * 收到 1.42 之後極端值回到合理範圍,強弱差距仍然看得出來。 */
const gate = (base, mine, theirs) =>
  clamp(base * ((mine / Math.max(0.2, theirs)) ** GATE.exponent),
    base * GATE.floor, Math.min(GATE.absoluteCap, base * GATE.cap));

/* 依角色權重從場上挑一個人做這個動作。
 *
 * 權重要先壓平(FLATTEN=0.4)再用。直接拿指標當權重的話,隊上最強的前鋒會
 * 包辦四成射門 —— 實測 40.4%,而英超頭號射手實際只佔全隊 20~28%。
 * 原因是 xg90 這種指標本身的離散度遠大於真實的射門分配:前鋒的 xg90 可以是
 * 中場的十倍,但他不會射十倍多的門,因為球不是每次都傳得到他腳下。 */
const FLATTEN = MIX.flatten;

function actor(rand, pool, metric, exclude = null) {
  const list = exclude ? pool.filter(p => p.code !== exclude.code) : pool;
  if (!list.length) return null;
  return list[rand.weighted(list.map(p => Math.max(0.02, metric(p)) ** FLATTEN))];
}

/* ── 控球鏈 ────────────────────────────────────
 * 一次進攻從後場出球開始,走到射門、失誤或定位球為止。
 * 回傳這條鏈產生的事件、(若有)最後的射門機會,以及推進到第幾段
 * ——— 推進深度用來算控球率,比直接拿 λ 當控球率誠實得多。 */
function chain(rand, atk, def, rel, side, minute) {
  const events = [];
  const emit = (type, extra = {}) => events.push({ minute, side, type, ...extra });
  const me = rel[side], them = rel[side === 'home' ? 'away' : 'home'];

  // 犯規是獨立事件,不掛在推進成功與否上 —— 掛上去的話關卡一收緊,犯規數就跟著崩。
  if (rand() < RATES.foulPerChain) {
    const fouler = actor(rand, [...def.mid, ...def.back], p => p.tackles + p.cards * 0.2);
    const victim = actor(rand, atk.att.length ? atk.att : atk.mid, p => p.threat);
    emit(EVENT.foul, {
      side: side === 'home' ? 'away' : 'home',
      player: fouler?.name, against: victim?.name,
    });
    if (victim && rand() < RATES.freeKickShot) {
      return { events, depth: 3, chance: { type: 'freeKick', shooter: victim, assist: null } };
    }
    return { events, depth: 2, chance: null };
  }

  // 1. 後場出球
  const bp = actor(rand, atk.back, p => p.passing);
  if (rand() > gate(RATES.buildUp, me.build, them.press)) {
    emit(EVENT.turnover, { player: bp?.name, state: STATES.buildUp, detail: '後場出球被斷' });
    return { events, depth: 1, chance: null };
  }
  emit(EVENT.buildUp, { player: bp?.name, state: STATES.buildUp });

  // 2. 中場推進
  const mp = actor(rand, atk.mid, p => p.passing);
  if (rand() > gate(RATES.progress, me.midfield, them.press)) {
    emit(EVENT.turnover, { player: mp?.name, state: STATES.midfield, detail: '中場被搶下' });
    return { events, depth: 2, chance: null };
  }
  emit(EVENT.progress, { player: mp?.name, state: STATES.midfield });

  // 3. 前場組織
  const ap = actor(rand, atk.att, p => p.threat);
  if (rand() > gate(RATES.finalThird, me.attack, them.defence)) {
    emit(EVENT.turnover, { player: ap?.name, state: STATES.finalThird, detail: '前場組織被化解' });
    return { events, depth: 3, chance: null };
  }

  // 4. 邊路 or 中路 —— 由邊路人員的相對創造力決定
  const goWide = rand() < clamp(RATES.wideBase * me.wideness, ...CL.wide);

  if (goWide) {
    const winger = actor(rand, atk.wide.length ? atk.wide : atk.att, p => p.passing + p.threat);
    // 參數化事件:高度 × 落點 × 邊路 × 是否一腳觸球(見設計文檔發現 1)
    const cross = {
      height: rand() < MIX.crossHigh ? '高球' : '低平球',
      target: rand.pick(['近柱', '遠柱', '中路']),
      flank: rand() < 0.5 ? '左路' : '右路',
      firstTime: rand() < MIX.crossFirstTime,
    };
    emit(EVENT.cross, { player: winger?.name, state: STATES.wide, cross });

    if (rand() > gate(RATES.createChance, me.attack, them.defence)) {
      emit(EVENT.block, { state: STATES.wide, detail: '傳中被解圍' });
      if (rand() < RATES.cornerFromCross) emit(EVENT.corner, { detail: '解圍出底線' });
      return { events, depth: 4, chance: null };
    }
    // 中場也會插上搶點,不是只有前鋒。中場的 xg90 本來就低,不必另外壓權重
    const target = actor(rand, atk.att.concat(atk.mid), p => p.xg90, winger);
    // 高球傳中不是每次都變頭槌 —— 也有把球做下來再射的。
    // 全給頭槌的話,時間軸上四成都是「頭槌」,實際英超頭球射門只佔約 15%。
    const type = cross.height === '高球'
      ? (rand() < MIX.headerFromHigh ? 'header' : 'boxShot')
      : (rand() < MIX.cutbackFromLow ? 'cutback' : 'closeRange');
    return { events, depth: 5, chance: { type, shooter: target ?? winger, assist: winger } };
  }

  // 中路直塞
  const creator = actor(rand, atk.mid.concat(atk.att), p => p.xa90 + p.passing * 0.1);
  emit(EVENT.through, { player: creator?.name, state: STATES.through });

  if (rand() > gate(RATES.createChance, me.attack, them.defence)) {
    emit(EVENT.turnover, { state: STATES.through, detail: '直塞被攔截' });
    return { events, depth: 4, chance: null };
  }

  const runner = actor(rand, atk.att, p => p.threat, creator);
  // 突破成功是單刀或禁區內射門,失敗就退而求其次遠射
  if (rand() < gate(MIX.dribbleGate, me.attack, them.defence)) {
    emit(EVENT.dribble, { player: runner?.name, state: STATES.through, detail: '殺進禁區' });
    const type = rand() < MIX.oneOnOneFromDribble ? 'oneOnOne' : 'boxShot';
    return { events, depth: 5, chance: { type, shooter: runner ?? creator, assist: creator } };
  }
  const shooter = actor(rand, atk.mid.concat(atk.att), p => p.threat, creator);
  return { events, depth: 5, chance: { type: 'longShot', shooter: shooter ?? creator, assist: null } };
}

/* ── 主函式 ────────────────────────────────────
 *
 * lambdaHome / lambdaAway  來自 poisson.mjs 的 predict(),已含近期狀況調整
 * home.xi / away.xi        來自 lineup.mjs 的 projectXI()
 * players                  完整球員資料(web/data/players.json 的來源)
 * seed                     同一場必須永遠給同一個 seed
 */
export function simulateMatch({
  lambdaHome, lambdaAway,
  home, away, players,
  seed = 1, minutes = 90, names = null,
}) {
  const rand = rng(seed);
  const prof = {
    home: profile(attach(home?.xi ?? [], players)),
    away: profile(attach(away?.xi ?? [], players)),
  };
  const rel = matchup(prof.home, prof.away);
  const lam = { home: Math.max(0.05, lambdaHome), away: Math.max(0.05, lambdaAway) };

  // 步驟 1:先決定本場各進幾球。這是唯一跟上層模型對齊的地方。
  const goals = { home: rand.poisson(lam.home), away: rand.poisson(lam.away) };

  /* 步驟 2:跑控球鏈。
   *
   * 這裡要分清楚兩件不同的事,第一版把它們混為一談過:
   *
   *   進攻回合數 = 誰比較常打到前場 → 跟 λ 走
   *   控球率     = 誰比較常拿著球   → 跟後場出球與中場的強度走
   *
   * 一開始我兩個都用 λ,結果等於斷言「進攻強的隊控球一定多」——
   * 反擊型球隊就是反例。後來矯枉過正,兩個都改成控球強度,結果是主隊
   * 完全失去射門優勢(真實 +2.93 次,模擬只剩 +0.68),而且射門與進球的
   * 相關性從真實的 r=0.277 掉到 0.097 —— 因為進球由 λ 配額決定,射門卻跟
   * λ 無關,兩者自然對不上。
   *
   * 現在各走各的:回合數用 λ(主場優勢 γ 本來就在 λ 裡),控球率用強度。
   * 控球少但 λ 高的隊仍然會拿到「機會少、每次 xG 高」的反擊樣貌。 */
  const rawShare = lam.home / (lam.home + lam.away);
  /* λ 的傾斜同時混了兩件事:球隊強弱、以及主場優勢 γ。兩者對「射門數」的
     影響幅度不一樣,直接照 λ 分配會讓隊間差距過寬(實測 1.5 倍)而主場優勢
     反而不足。所以把強弱那一段壓平,主場優勢單獨加回去。 */
  const chainShare = clamp(0.5 + (rawShare - 0.5) * RATES.chainTilt + RATES.homeChainEdge, ...CL.chainShare);
  const ctrl = s => (rel[s].build + rel[s].midfield) / 2;
  const possShare = clamp(
    ctrl('home') / (ctrl('home') + ctrl('away')) + RATES.homePossEdge,
    ...CL.possShare,
  );
  const share = chainShare;
  const raw = [];
  const chances = { home: [], away: [] };
  const depth = { home: 0, away: 0 };

  // 每場的總回合數帶隨機步調。減 σ²/2 讓期望值仍等於 RATES.chains
  //(跟 simulate.mjs 對 lognormal 雜訊的處理同一個道理)
  const tempo = Math.exp(rand.gauss() * RATES.chainsTempo - (RATES.chainsTempo ** 2) / 2);
  const chains = Math.max(40, Math.round(RATES.chains * tempo));

  for (let i = 0; i < chains; i++) {
    const side = rand() < share ? 'home' : 'away';
    const other = side === 'home' ? 'away' : 'home';
    // 回合平均分佈在 90 分鐘。
    // ⚠ 真實比賽的進球分佈是後段偏多,我們沒有校準過那條曲線,所以不假造 ——
    //   寧可均勻,也不要編一個看起來專業的偏斜。要做的話得先回測。
    const minute = Math.min(minutes, 1 + Math.floor((i / chains) * minutes) + rand.int(2));
    const r = chain(rand, prof[side], prof[other], rel, side, minute);
    raw.push(...r.events);
    depth[side] += r.depth;
    if (r.chance?.shooter) chances[side].push({ ...r.chance, minute, side });
  }

  // 十二碼:低機率獨立事件
  for (const side of ['home', 'away']) {
    if (rand() < RATES.penaltyPerTeam) {
      const taker = actor(rand, prof[side].att, p => p.xg90);
      if (taker) {
        chances[side].push({ type: 'penalty', shooter: taker, assist: null, minute: 1 + rand.int(minutes), side });
      }
    }
  }

  // 步驟 3:把每次機會的 xG 縮放到 Σ xG = λ。
  // 這是整支模組的校準約束 —— 事件鏈愛怎麼跑都行,但總量必須回到上層模型。
  for (const side of ['home', 'away']) {
    const list = chances[side];
    /* 一次機會都沒創造出來的場合(極弱的一方碰上極強的一方,偶爾會發生):
       不能直接跳過,否則 Σxg 會是 0 而 λ 還掛在那裡 —— 校準欄位就成了謊報。
       補一次遠射讓 λ 有地方安放。這是罕見的邊界,但錯就是錯。 */
    if (!list.length) {
      const fallback = actor(rand, prof[side].att.concat(prof[side].mid), p => p.threat);
      if (!fallback) continue;
      list.push({ type: 'longShot', shooter: fallback, assist: null, minute: 1 + rand.int(minutes), side });
    }
    for (const c of list) {
      // 射手把握度微調:finishing 是實際進球減 xG 的累積差,量級很小,壓在 ±20% 內
      const edge = clamp(1 + (c.shooter?.finishing ?? 0) * MIX.finishingEdge, ...CL.finishing);
      c.xgRaw = CHANCE_TYPES[c.type].xg * edge;
    }
    const total = list.reduce((a, c) => a + c.xgRaw, 0);
    const k = total > 0 ? lam[side] / total : 0;
    for (const c of list) c.xg = c.xgRaw * k;
  }

  // 步驟 4:依 xG 加權抽出哪幾次機會進了。
  // 不是每次機會各自擲骰 —— 那樣總進球數會漂離 λ。
  for (const side of ['home', 'away']) {
    const list = chances[side];
    const want = Math.min(goals[side], list.length);
    const picked = new Set();
    for (let g = 0; g < want; g++) {
      const idx = rand.weighted(list.map((c, i) => (picked.has(i) ? 0 : Math.max(1e-6, c.xg))));
      picked.add(idx);
    }
    list.forEach((c, i) => { c.scored = picked.has(i); });
    // 抽不滿(機會數少於進球數)時把帳修正回實際進球數,免得比分謊報。極罕見。
    goals[side] = want;
  }

  // 步驟 5:把機會展開成事件
  const shotEvents = [];
  for (const side of ['home', 'away']) {
    const other = side === 'home' ? 'away' : 'home';
    const opp = prof[other];
    for (const c of chances[side]) {
      const base = {
        minute: c.minute, side,
        player: c.shooter?.name, assist: c.assist?.name ?? null,
        chanceType: c.type, chanceZh: CHANCE_TYPES[c.type].zh, xg: round(c.xg, 3),
      };
      shotEvents.push({ ...base, type: EVENT.shot });
      if (c.scored) { shotEvents.push({ ...base, type: EVENT.goal }); continue; }

      // 沒進的去向:門將撲救 / 被封阻 / 射偏。門將越好,撲救佔比越高。
      // 用正規化後的相對值,不是原始 shotStop —— 原始值量級約 1.5,
      // 直接乘上去會把射正率推到五成以上(實際約三成)。與 matchup() 同一個教訓。
      const saveP = clamp(RATES.saveShare * rel[other].keeper, ...CL.saveP);
      const roll = rand();
      const outcome = roll < saveP ? EVENT.save
        : (roll < saveP + RATES.blockShare ? EVENT.block : EVENT.off);
      shotEvents.push({
        minute: c.minute, side, type: outcome,
        player: outcome === EVENT.save ? (opp.gk?.name ?? '門將') : c.shooter?.name,
        // 撲救時 player 是門將,射門的人要另外帶著,時間軸的文案兩個都要用到
        shooter: c.shooter?.name ?? null,
        chanceType: c.type, chanceZh: CHANCE_TYPES[c.type].zh, xg: round(c.xg, 3),
      });
      if (outcome !== EVENT.off && rand() < RATES.cornerFromShot) {
        shotEvents.push({ minute: c.minute, side, type: EVENT.corner });
      }
    }
  }

  // 步驟 6:黃牌
  const cards = raw
    .filter(e => e.type === EVENT.foul && rand() < RATES.yellowPerFoul)
    .map(f => ({ minute: f.minute, side: f.side, type: EVENT.yellow, player: f.player }));

  const events = [
    { minute: 0, type: EVENT.kickOff },
    ...raw, ...shotEvents, ...cards,
    { minute: Math.floor(minutes / 2), type: EVENT.halfTime },
    { minute: minutes, type: EVENT.fullTime },
  ].sort((a, b) => a.minute - b.minute);

  const count = (side, type) => events.filter(e => e.side === side && e.type === type).length;
  const statsOf = side => ({
    shots: chances[side].length,
    onTarget: count(side, EVENT.goal) + count(side, EVENT.save),
    corners: count(side, EVENT.corner),
    fouls: count(side, EVENT.foul),
    yellow: count(side, EVENT.yellow),
    xg: round(chances[side].reduce((a, c) => a + c.xg, 0), 2),
  });

  /* 控球率 = 拿到球的次數(share)為主、推進得多深(depth)為輔。
   *
   * 只用 depth 會複合放大:強隊既拿到比較多回合、每回合又推得比較深,
   * 兩者相乘後跑出過 12% / 89% 這種英超不存在的數字。以 share 為主幹再讓
   * depth 微調,並夾在 28~72% —— 英超單場控球率實際上就沒有出過這個範圍。 */
  const totalDepth = depth.home + depth.away || 1;
  const w = CL.possessionDepthWeight;
  const poss = round(clamp(possShare * (1 - w) + (depth.home / totalDepth) * w, ...CL.possession) * 100, 1);

  const timeline = buildTimeline(rand, events, prof, { home, away }, names);

  return {
    seed,
    score: { home: goals.home, away: goals.away },
    events,
    timeline,
    stats: {
      home: { ...statsOf('home'), possession: poss },
      away: { ...statsOf('away'), possession: round(100 - poss, 1) },
    },
    /* 校準對帳:xg 應該非常接近 lambda(浮點誤差以內)。
       test.mjs 會驗這一條 —— 一旦事件引擎偷偷改動了總量,這裡會先爆。 */
    calibration: {
      lambdaHome: round(lam.home, 3), lambdaAway: round(lam.away, 3),
      xgHome: round(chances.home.reduce((a, c) => a + c.xg, 0), 3),
      xgAway: round(chances.away.reduce((a, c) => a + c.xg, 0), 3),
    },
    // 前端必須顯示的警語。放在資料裡,免得哪天改版漏掉。
    disclaimer: '模擬結果,非實際比賽過程。比分與事件由模型生成,僅供理解賽前預測之用。',
  };
}

/* ── 時間軸 ────────────────────────────────────
 * 完整事件流有 500 多條(每次後場出球、每次被斷都在裡面),那是給賽後報告
 * 與戰術診斷用的原料,不是給人讀的。時間軸只留看得出戲的:
 * 進球、黃牌、十二碼,以及 xG 夠高的未進機會。
 *
 * 也順便控制檔案大小 —— 全部塞進 matchsim.json 的話 bundle 會爆掉。 */
function buildTimeline(rand, events, prof, sides, names) {
  const nameOf = {
    home: names?.home ?? sides.home?.team ?? '主隊',
    away: names?.away ?? sides.away?.team ?? '客隊',
  };
  /* 同一場裡盡量不要出現一字不差的重複句。
     每種事件只有 2~3 種說法,而射門者又集中在少數幾個人,直接隨機挑的話
     實測每場約 0.84 次逐字重複 —— 連著兩條一模一樣,讀起來就像壞掉了。
     先試沒用過的組合,全用過了才允許重複。 */
  const used = new Set();
  const say = (kind, tok) => {
    const list = PHRASES[kind];
    const start = rand.int(list.length);
    let out = '';
    for (let i = 0; i < list.length; i++) {
      out = list[(start + i) % list.length].replace(/\{(\w)\}/g, (_, k) => tok[k] ?? '');
      if (!used.has(out)) break;
    }
    used.add(out);
    return out;
  };

  const out = [];
  const running = { home: 0, away: 0 };
  // 同一個人不重複記名。
  // ⚠ 兩黃一紅本來該是紅牌,但我們沒有模擬少打一人對後續的影響 ——
  //   與其生一張假紅牌讓後面的比賽照常十一人踢,不如就不發第二張。
  const booked = new Set();

  for (const e of events) {
    const side = e.side;
    if (!side) continue;
    const gk = prof[side === 'home' ? 'away' : 'home'].gk?.name ?? '門將';
    const tok = { p: e.shooter ?? e.player ?? '', a: e.assist ?? '', t: nameOf[side], g: gk };

    if (e.type === EVENT.goal) {
      const other = side === 'home' ? 'away' : 'home';
      const kind = e.assist ? 'goalAssisted'
        : (running.home === 0 && running.away === 0) ? 'goalOpener'
        : (running[side] + 1 === running[other]) ? 'goalEqualiser' : 'goal';
      running[side]++;
      out.push({
        minute: e.minute, side, kind: 'goal', priority: 3,
        text: say(kind, tok), score: `${running.home}-${running.away}`,
        player: e.player ?? null, assist: e.assist ?? null,
        xg: e.xg ?? null, chanceZh: e.chanceZh ?? null,
      });
    } else if (e.type === EVENT.yellow) {
      if (!e.player || booked.has(e.player)) continue;
      booked.add(e.player);
      out.push({
        minute: e.minute, side, kind: 'yellow', priority: 2,
        text: say('yellow', tok), player: e.player,
      });
    } else if ([EVENT.save, EVENT.block, EVENT.off].includes(e.type)) {
      if ((e.xg ?? 0) < BIG_CHANCE_XG) continue;      // 小機會不上時間軸
      const kind = e.type === EVENT.save ? 'save' : e.type === EVENT.block ? 'block' : 'off';
      out.push({
        minute: e.minute, side, kind, priority: 1,
        // xG 特別高的未進機會前面加一句「錯失大好機會」,讀者才知道那下有多可惜。
        // 後半用短尾而不是完整句,否則人名會連講兩次。
        text: (e.xg ?? 0) >= TL.missNoteXg ? `${say('bigChance', tok)},${TAILS[kind]}` : say(kind, tok),
        player: e.shooter ?? e.player ?? null,
        xg: e.xg ?? null, chanceZh: e.chanceZh ?? null,
      });
    }
  }

  // 超過上限時砍掉優先度最低的(進球與黃牌永遠留著),再排回時間順序
  if (out.length > TIMELINE_CAP) {
    out.sort((a, b) => b.priority - a.priority || (b.xg ?? 0) - (a.xg ?? 0));
    out.length = TIMELINE_CAP;
  }
  return out.sort((a, b) => a.minute - b.minute).map(({ priority, ...rest }) => rest);
}

/* 跑很多次取平均,檢查事件引擎的產出量級合不合理
   (射門、角球、犯規、進球有沒有落在英超的正常範圍)。給 test.mjs 用。 */
export function sampleMatch(opts, runs = 300) {
  const acc = { shots: 0, onTarget: 0, corners: 0, fouls: 0, goals: 0, xg: 0, possHome: 0 };
  for (let i = 0; i < runs; i++) {
    const r = simulateMatch({ ...opts, seed: (opts.seed ?? 1) + i * 7919 });
    const { home: h, away: a } = r.stats;
    acc.shots += h.shots + a.shots;
    acc.onTarget += h.onTarget + a.onTarget;
    acc.corners += h.corners + a.corners;
    acc.fouls += h.fouls + a.fouls;
    acc.goals += r.score.home + r.score.away;
    acc.xg += h.xg + a.xg;
    acc.possHome += h.possession;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, round(v / runs, 2)]));
}
