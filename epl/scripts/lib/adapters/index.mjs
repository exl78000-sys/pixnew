// Adapter 登錄表 —— 要接新的資料源,只要在這裡加一筆。
//
// 每個 adapter 必須匯出:id、label、supports(能力清單),
// 以及對應能力的載入函式:
//   'matches' → loadMatches({ root, competition, season, codeOf }) : CanonicalMatch[]
//   'squads'  → loadSquads({ root, season, codeOf })               : { players, teamById }
//   'live'      → 由 lib/live.mjs 的來源機制處理(場中資料有自己的取捨)
//   'formations'→ loadFormations({ root, season, round, codeOf })  : 官方陣型,拿不到回 null
//
// 需要金鑰的 adapter 要額外匯出 enabled(env),沒金鑰時上層就跳過它,
// 不會因為少一個資料源而讓 build 失敗。
import * as openfootball from './openfootball.mjs';
import * as fplSnapshot from './fpl-snapshot.mjs';
import * as apiFootball from './api-football.mjs';

export const ADAPTERS = {
  [openfootball.id]: openfootball,
  [fplSnapshot.id]: fplSnapshot,
  [apiFootball.id]: apiFootball,
};

export function adapterFor(capability, preferred = null) {
  const list = Object.values(ADAPTERS).filter(a => a.supports.includes(capability));
  if (!list.length) throw new Error(`沒有任何 adapter 支援 ${capability}`);
  if (preferred) {
    const a = list.find(x => x.id === preferred);
    if (!a) throw new Error(`adapter ${preferred} 不支援 ${capability}`);
    return a;
  }
  return list[0];
}

export const loadMatches = opts => adapterFor('matches', opts.adapter).loadMatches(opts);
export const loadSquads = opts => adapterFor('squads', opts.adapter).loadSquads(opts);
