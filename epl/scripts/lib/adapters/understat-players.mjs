// Adapter:Understat 球員整季數據 → 本站格式(西甲)
//
// 由 scripts/fetch-laliga-players.mjs 抓好寫成 JSON,這一支只負責讀檔與轉形狀。
// 抓不到就回 null,上層自動退回「沒有球員資料」。
//
// **這個來源有什麼、沒有什麼**(實測,不是憑印象):
//   有:games time goals xG assists xA shots key_passes yellow_cards red_cards
//       position team_title npg npxG xGChain xGBuildup
//   沒有:背號、頭貼、出生日期、身價、傷停、以及英超那套 FPL 的
//       防守貢獻 / BPS / 撲救 / 零封。背號、頭貼、出生日期由 SportMonks
//       本地快取補入；其餘沒有可靠來源的欄位不補造。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const id = 'understat-players';
export const label = 'Understat(球員整季數據)';
export const supports = ['playerSeasonStats'];

const FILE = (root, season) => join(root, 'data', 'raw', 'understat-la-liga', `${season}-players.json`);

/* 位置是空白分隔的 token:GK / D / M / F / S。
   S 不是位置,是「以替補出場過」的標記 —— 有 71 人整季只有 S,
   代表來源沒有給他們場上位置,那就照實說「來源未標位置」,不要猜一個。

   一個人可能有多個位置(D F M S)。沒有逐場位置資料可以判斷主位置,
   所以取**最偏防守**的那一個當分組依據:兼踢中場的後衛,拿去跟後衛比
   比拿去跟中場比合理。這是推論,頁面上要寫明規則。 */
const ORDER = ['GK', 'D', 'M', 'F'];
const POS_ZH = { GK: '門將', D: '後衛', M: '中場', F: '前鋒' };

export function positionOf(raw) {
  const tokens = String(raw ?? '').split(/\s+/).filter(Boolean);
  const played = ORDER.filter(p => tokens.includes(p));
  if (!played.length) return { pos: null, posZh: '來源未標位置', all: [], subOnly: tokens.includes('S') };
  return { pos: played[0], posZh: POS_ZH[played[0]], all: played, subOnly: false };
}

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = n => Math.round(n * 100) / 100;

/* 一季一筆,不是逐場。所以「每 90 分鐘」的分母是整季上場時間。
   門檻沿用英超那套的 450 分鐘:樣本太少的每 90 分鐘數字會大得離譜,
   給了反而誤導。未達門檻的照樣列出總數,只是不給每 90。 */
export const MIN_MINUTES = 450;

export function loadPlayers(root, season) {
  const f = FILE(root, season);
  if (!existsSync(f)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  if (!Array.isArray(raw.players) || !raw.players.length) return null;

  const players = raw.players.map(p => {
    /* 跨隊的人:Understat 把 team_title 寫成 "Levante,Villarreal",
       而數字是**兩隊合計**。這正是專案踩過的那個坑的另一種版本 ——
       season 快照把整季的球記到最後一隊。所以不挑一隊掛上去:
       兩隊都留著並標記,由上層決定要不要放進單隊視圖。 */
    const names = String(p.team_title ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const minutes = num(p.time);
    const per90 = v => (minutes >= MIN_MINUTES ? r2((v * 90) / minutes) : null);
    const goals = num(p.goals), assists = num(p.assists);
    const xG = num(p.xG), xA = num(p.xA);
    const { pos, posZh, all, subOnly } = positionOf(p.position);
    return {
      id: String(p.id),
      name: p.player_name,
      teams: names,
      multiTeam: names.length > 1,
      pos, posZh, posAll: all, posRaw: p.position ?? null, subOnly,
      games: num(p.games), minutes,
      goals, assists, ga: goals + assists,
      npg: num(p.npg),
      xG: r2(xG), xA: r2(xA), xGI: r2(xG + xA), npxG: r2(num(p.npxG)),
      shots: num(p.shots), keyPasses: num(p.key_passes),
      yellow: num(p.yellow_cards), red: num(p.red_cards),
      xGChain: r2(num(p.xGChain)), xGBuildup: r2(num(p.xGBuildup)),
      // 終結超出期望:進球減 xG。用非十二碼的版本 —— 十二碼的 xG 是固定值,
      // 混進來只會反映罰球次數,不反映終結能力。
      finishing: r2(num(p.npg) - num(p.npxG)),
      goals90: per90(goals), assists90: per90(assists), ga90: per90(goals + assists),
      xg90: per90(xG), xa90: per90(xA), xgi90: per90(xG + xA),
      shots90: per90(num(p.shots)), keyPasses90: per90(num(p.key_passes)),
      chain90: per90(num(p.xGChain)), buildup90: per90(num(p.xGBuildup)),
      qualified: minutes >= MIN_MINUTES,
    };
  });

  return {
    season: raw.season, source: raw.source ?? 'Understat',
    retrievedAt: raw.retrievedAt ?? null,
    count: players.length,
    players,
  };
}

/*
 * 將西甲球員資料轉成網站共用的最小球員契約。
 *
 * Understat 與英超 FPL 的粒度不同：西甲是一季一筆彙總，沒有身價、傷停
 * 或防守欄位。因此這裡只補「確實有來源」且各頁面都能理解的欄位，
 * 不用 null 欄位假裝與英超資料完整相同。原始 Understat 欄位全部保留，
 * 讓球員頁仍可按來源專用欄位排序。
 */
export function normalisePlayerForSite(player, { codeOf } = {}) {
  const names = Array.isArray(player?.teams) ? player.teams : [];
  const mappedTeams = names.map(name => codeOf?.(name) ?? name).filter(Boolean);
  const providerTeam = player?.sportmonksTeam ? (codeOf?.(player.sportmonksTeam) ?? player.sportmonksTeam) : null;
  const team = providerTeam ?? mappedTeams.at(-1) ?? null;
  const snapshot = {
    season: player?.season ?? null,
    games: player?.games ?? 0,
    minutes: player?.minutes ?? 0,
    goals: player?.goals ?? 0,
    assists: player?.assists ?? 0,
    ga: player?.ga ?? 0,
    xG: player?.xG ?? 0,
    xA: player?.xA ?? 0,
    xGI: player?.xGI ?? 0,
    xg90: player?.xg90 ?? null,
    xa90: player?.xa90 ?? null,
    xgi90: player?.xgi90 ?? null,
    shots: player?.shots ?? 0,
    keyPasses: player?.keyPasses ?? 0,
    yellow: player?.yellow ?? 0,
    red: player?.red ?? 0,
  };
  return {
    ...player,
    // 英超模板使用 code/fullName/team；西甲保留 id/teams 供來源專用頁使用。
    code: String(player?.id ?? player?.sportmonksId ?? ''),
    fullName: player?.name ?? '',
    team,
    teamCodes: [...new Set(mappedTeams.concat(providerTeam ?? []))],
    stats: snapshot,
    dataSources: {
      performance: player?.source ?? 'Understat',
      identity: player?.sportmonksId ? 'SportMonks' : null,
    },
  };
}

/* 榜單。只做這個來源真的有的項目 ——
   英超版有門將撲救效率與後衛防守貢獻,Understat 沒有那些欄位,就不做,
   也不要拿別的數字硬湊一個看起來像的榜。 */
export const BOARDS = [
  { key: 'scorers', label: '射手榜', unit: '進球', pick: p => p.goals, per90: false },
  { key: 'assisters', label: '助攻榜', unit: '助攻', pick: p => p.assists, per90: false },
  { key: 'contributors', label: '進球參與', unit: '進球+助攻', pick: p => p.ga, per90: false },
  { key: 'xgi', label: '每 90 分鐘期望進球參與', unit: 'xGI/90', pick: p => p.xgi90, per90: true },
  { key: 'creators', label: '創造機會', unit: '關鍵傳球/90', pick: p => p.keyPasses90, per90: true },
  { key: 'finishers', label: '終結超出期望', unit: '非十二碼進球 − npxG', pick: p => p.finishing, per90: false },
  { key: 'chain', label: '參與得分串聯', unit: 'xGChain/90', pick: p => p.chain90, per90: true },
  { key: 'buildup', label: '推進(不含射門與助攻)', unit: 'xGBuildup/90', pick: p => p.buildup90, per90: true },
  /* 年齡不是 Understat 給的,是 SportMonks 的出生日期算出來的,所以只有對上的人才有。
     沒有年齡的人**不進這個榜也不假裝是超齡** —— 頁面要標出涵蓋率,見 leaders.ageCoverage。 */
  { key: 'youth', label: '22 歲以下', unit: '進球+助攻', pick: p => p.ga, per90: false,
    filter: p => p.age != null && p.age <= 22 },
];

export function buildLeaders(players, { top = 10 } = {}) {
  const out = {};
  for (const b of BOARDS) {
    // per90 的榜只收達門檻的人;總數榜不設限,因為「他就是進了那麼多球」
    let pool = b.per90 ? players.filter(p => p.qualified) : players;
    if (b.filter) pool = pool.filter(b.filter);
    out[b.key] = pool
      .map(p => ({ id: p.id, name: p.name, teams: p.teams, multiTeam: p.multiTeam, value: b.pick(p), minutes: p.minutes }))
      .filter(r => r.value != null && r.value !== 0)
      .sort((a, b2) => b2.value - a.value)
      .slice(0, top);
  }
  return out;
}

/* 同位置百分位。只用這個來源有的欄位,而且只跟**同一個聯賽、同一季、
   同位置、達上場門檻**的人比 —— 跨聯賽比較沒有意義,樣本不足的更不能比。
   位置不明的(整季只有 S)不參與,寧可少一張雷達也不要拿錯的母體算。 */
export const RADAR_AXES = [
  { key: 'xg90', label: '射門威脅' },
  { key: 'xa90', label: '創造機會' },
  { key: 'shots90', label: '射門量' },
  { key: 'keyPasses90', label: '關鍵傳球' },
  { key: 'chain90', label: '參與串聯' },
  { key: 'buildup90', label: '推進' },
];

export function attachRadar(players) {
  const byPos = new Map();
  for (const p of players) {
    if (!p.pos || !p.qualified) continue;
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push(p);
  }
  const pct = (sorted, v) => {
    if (!sorted.length) return null;
    const below = sorted.filter(x => x < v).length;
    return Math.round((below / sorted.length) * 1000) / 10;
  };
  const cache = new Map();
  for (const p of players) {
    const peers = p.pos && p.qualified ? byPos.get(p.pos) : null;
    if (!peers || peers.length < 5) { p.radar = null; p.peerCount = peers?.length ?? 0; continue; }
    p.peerCount = peers.length;
    p.radar = RADAR_AXES.map(ax => {
      const ck = `${p.pos}:${ax.key}`;
      if (!cache.has(ck)) cache.set(ck, peers.map(x => x[ax.key] ?? 0).sort((a, b) => a - b));
      return { label: ax.label, value: pct(cache.get(ck), p[ax.key] ?? 0), raw: p[ax.key] ?? 0 };
    });
  }
  return players;
}
