// Canonical Schema —— 供應商中立的正規化格式。
//
// 這個檔案是整個資料層的契約:所有外部資料一律先經 adapter 轉成這裡定義的形狀,
// 之後的分析、模型、AI、前端都只讀這個格式,永遠不直接讀供應商的 JSON/CSV。
//
// 為什麼重要:未來要接歐冠、英國盃賽,或從免費源換到付費源時,
// 你只需要寫一個新的 adapter,上層一行都不用改。
// 反過來說,只要有一個指標偷偷去讀了供應商欄位,這個保證就破了。

/* ── 賽事定義 ──────────────────────────────────
   新增賽事時只要加一筆。type 與旗標會影響模型行為:
   - extraTime / penalties:淘汰賽平手要往下走,勝率不能只算 90 分鐘
   - twoLegged:晉級機率要用兩回合總比分,不是單場
   - crossLeague:對手來自不同聯賽,Elo 需要跨聯賽校準
   - crossTier:對手可能來自不同級別,需要級別先驗
*/
export const COMPETITIONS = {
  'eng.1': {
    code: 'eng.1', name: 'Premier League', zh: '英格蘭超級聯賽', short: '英超',
    country: 'ENG', type: 'league',
    teams: 20, roundsPerSeason: 38,
    extraTime: false, penalties: false, twoLegged: false,
    crossLeague: false, crossTier: false,
  },
  'esp.1': {
    code: 'esp.1', name: 'La Liga', zh: '西班牙足球甲級聯賽', short: '西甲',
    country: 'ESP', type: 'league',
    teams: 20, roundsPerSeason: 38,
    extraTime: false, penalties: false, twoLegged: false,
    crossLeague: false, crossTier: false,
  },
  /* 英冠。附加賽(Playoffs)有延長賽與 PK,但那是季末四隊的事 ——
     聯賽本身沒有,所以這裡照聯賽宣告,附加賽的場次在建站時單獨標 stage 並排除在積分榜外。 */
  'eng.2': {
    code: 'eng.2', name: 'EFL Championship', zh: '英格蘭足球冠軍聯賽', short: '英冠',
    country: 'ENG', type: 'league',
    teams: 24, roundsPerSeason: 46,
    extraTime: false, penalties: false, twoLegged: false,
    crossLeague: false, crossTier: false,
  },
  // 之後要加的(規劃已寫好,尚未實作):
  // 'uefa.cl': { type:'europe', extraTime:true, penalties:true, twoLegged:true, crossLeague:true }
  // 'eng.fa' : { type:'cup',    extraTime:true, penalties:true, twoLegged:false, crossTier:true }
  // 'eng.lc' : { type:'cup',    extraTime:true, penalties:true, twoLegged:false, crossTier:true }
};

export const competition = code => {
  const c = COMPETITIONS[code];
  if (!c) throw new Error(`未定義的賽事:${code}(請在 lib/canonical.mjs 的 COMPETITIONS 補上)`);
  return c;
};

/* ── 比賽 ──────────────────────────────────────
   {
     id          唯一鍵,建議 `${competition}|${season}|${序號}`
     competition 賽事代碼    season 賽季字串
     round       輪次(數字,無則 null)    stage 階段名稱(淘汰賽用,聯賽為 null)
     date        YYYY-MM-DD(當地日期,排序與分組用)
     kickoff     ISO UTC 開球時間(倒數計時一律用這個,沒有才退回 date)
     home / away 隊碼
     played      是否已有結果
     fh / fa     全場比分        hh / ha  半場比分(取不到為 null)
     etH / etA   加時後比分(聯賽恆為 null)
     pensH/pensA PK 比分(同上)
     neutral     中立場地   leg 第幾回合   tieId 兩回合對戰的共同鍵
     source      來自哪個 adapter
   }
*/
export function assertMatch(m, adapterId) {
  const need = ['id', 'competition', 'season', 'date', 'home', 'away'];
  for (const k of need) {
    if (m[k] === undefined || m[k] === null) {
      throw new Error(`[${adapterId}] 比賽缺少必要欄位 ${k}:${JSON.stringify(m).slice(0, 160)}`);
    }
  }
  if (m.played && (typeof m.fh !== 'number' || typeof m.fa !== 'number')) {
    throw new Error(`[${adapterId}] 比賽標記為已完成但沒有比分:${m.id}`);
  }
  if (m.home === m.away) throw new Error(`[${adapterId}] 主客隊相同:${m.id}`);
  return m;
}

export const makeMatch = (adapterId, m) => assertMatch({
  round: null, stage: null, kickoff: null,
  played: false, fh: null, fa: null, hh: null, ha: null,
  etH: null, etA: null, pensH: null, pensA: null,
  neutral: false, leg: null, tieId: null,
  source: adapterId,
  ...m,
}, adapterId);

/* ── 陣容球員(賽季快照)────────────────────────
   code 是跨賽季不變的球員識別;沒有的話用 `${source}:${id}`。
*/
export function assertSquadPlayer(p, adapterId) {
  for (const k of ['code', 'name', 'team', 'pos']) {
    if (!p[k]) throw new Error(`[${adapterId}] 球員缺少必要欄位 ${k}:${JSON.stringify(p).slice(0, 160)}`);
  }
  if (!['GK', 'DEF', 'MID', 'FWD'].includes(p.pos)) {
    throw new Error(`[${adapterId}] 位置不在允許值內:${p.pos}(${p.name})`);
  }
  return p;
}

/* ── 場中狀態 ──────────────────────────────────
   {
     key 'HOME|AWAY'   home / away   kickoff
     started / finished / minutes
     hs / as           目前比分
     lineups           { 隊碼: LivePlayer[] }
   }
   LivePlayer 的欄位由 blankLivePlayer() 定義,adapter 必須全部填(取不到就給 0)。
*/
export const blankLivePlayer = () => ({
  code: null, name: '', pos: '?',
  minutes: 0, starts: 0, goals: 0, assists: 0, own: 0, yellow: 0, red: 0,
  saves: 0, conceded: 0, cleanSheets: 0, xG: 0, xA: 0, xGC: 0, bonus: 0, bps: 0,
  influence: 0, creativity: 0, threat: 0, ict: 0,
  tackles: 0, recoveries: 0, cbi: 0, defCon: 0, points: 0,
});

export function assertLiveFixture(f, adapterId) {
  for (const k of ['key', 'home', 'away']) {
    if (!f[k]) throw new Error(`[${adapterId}] 場中資料缺少 ${k}`);
  }
  if (f.finished && (f.hs === null || f.as === null)) {
    throw new Error(`[${adapterId}] 比賽標記為結束但沒有比分:${f.key}`);
  }
  return f;
}

/* ── 賽季長度 ──────────────────────────────────
   不要在指標裡寫死「38 場」。用實際資料推,盃賽與跨賽季才不會算錯。
*/
export const seasonLength = matches => {
  const perTeam = new Map();
  for (const m of matches) {
    if (!m.played) continue;
    perTeam.set(m.home, (perTeam.get(m.home) ?? 0) + 1);
    perTeam.set(m.away, (perTeam.get(m.away) ?? 0) + 1);
  }
  return perTeam.size ? Math.max(...perTeam.values()) : 0;
};
