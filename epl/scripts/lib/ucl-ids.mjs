/* 歐冠球隊的 football-data id ↔ FotMob id:**用 FotMob 的 matchId 當橋推出來**。
 *
 * 為什麼不比隊名:`ucl-team-ids.json` 那 40 組是 2026-08-28 用「隊名 token 交集」配出來的,
 * 而那種比對會安靜地漏掉整支球隊 —— 實際漏掉的是 **Pafos FC(FotMob)vs Paphos FC
 * (football-data)**:兩邊一個共同 token 都沒有,於是當時在 `unmapped` 寫下
 * 「FotMob 三季檔案裡都沒有這一支」。那句話是假的,它在 2025-26 的交付檔裡有 8 場。
 * (本站記過很多次的那一條:**我數不出來 ≠ 上游沒有**。)
 *
 * 橋是這樣搭的,中間**完全沒有隊名參與**:
 *   · `data/manual/fotmob-ucl-{季}.json` 的 matches[]:matchId → FotMob 的 home.id / away.id
 *   · `data/raw/fotmob-ucl/{季}-game-details.json`:key 是 football-data 的「主|客|日期」,裡面有 matchId
 *   同一個 matchId,主隊對主隊、客隊對客隊 —— id 對 id。
 *
 * 2026-09-22 實測(三季):**396 / 396 場的 matchId 對得上、0 場對不上**,推出 65 組、一對一,
 * 而且拿既有落地的 40 組當對照組 **40 / 40 完全一致**(這是驗這個方法本身,不是驗資料)。
 *
 * 界線:**只有踢過而且逐場詳情抓回來的球隊才推得出來。** 賽季前只有抽籤檔的時候
 * 一組都推不出 —— 那不是失敗,是還沒有證據,呼叫端要分得出這兩種。
 * 一個 fd id 投給兩個 FotMob id(或反過來)一律記成 conflict **不挑一個**:
 * 那代表某一邊的資料有問題,挑一個等於在兩個對不上的答案裡選一個喜歡的。 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* 三季的檔名是固定的兩支,不要另外列一份季別清單 —— 掃目錄長出來的才不會有新的一季靜靜掉隊。 */
export function uclIdSeasons(root) {
  const dir = join(root, 'data', 'raw', 'fotmob-ucl');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(f => /^(\d{4}-\d{2})-game-details\.json$/.exec(f)?.[1])
    .filter(Boolean)
    .filter(s => existsSync(join(root, 'data', 'manual', `fotmob-ucl-${s}.json`)))
    .sort();
}

export function bridgeUclTeamIds(root) {
  const votes = new Map();      // fdId → Map(fotmobId → 票數)
  const names = new Map();      // fotmobId → FotMob 的隊名(只拿來印給人看,不參與判定)
  const seasons = [];
  let matched = 0, unmatchedMid = 0;

  for (const s of uclIdSeasons(root)) {
    const draw = JSON.parse(readFileSync(join(root, 'data', 'manual', `fotmob-ucl-${s}.json`), 'utf8'));
    const det = JSON.parse(readFileSync(join(root, 'data', 'raw', 'fotmob-ucl', `${s}-game-details.json`), 'utf8'));
    for (const t of draw.teams ?? []) if (t?.teamId != null) names.set(t.teamId, t.name ?? null);
    const byMid = new Map((draw.matches ?? []).map(m => [String(m.matchId), m]));
    let ok = 0, miss = 0;
    for (const d of Object.values(det.matches ?? {})) {
      const src = byMid.get(String(d.matchId));
      if (!src) { miss++; continue; }
      ok++;
      for (const [fd, fm] of [[d.home, src.home?.id], [d.away, src.away?.id]]) {
        const k = Number(fd);
        if (!Number.isFinite(k) || fm == null) continue;
        if (!votes.has(k)) votes.set(k, new Map());
        votes.get(k).set(fm, (votes.get(k).get(fm) ?? 0) + 1);
      }
    }
    seasons.push({ season: s, details: Object.keys(det.matches ?? {}).length, matched: ok, unmatched: miss });
    matched += ok; unmatchedMid += miss;
  }

  /* 一個 fd id 投給兩個 FotMob id → 不採用(下面反向也查一次)。 */
  const conflicts = [];
  const pairs = new Map();
  for (const [fd, m] of votes) {
    if (m.size > 1) { conflicts.push({ fdId: fd, votes: [...m.entries()] }); continue; }
    pairs.set(fd, [...m.keys()][0]);
  }
  const back = new Map();
  for (const [fd, fm] of pairs) { if (!back.has(fm)) back.set(fm, []); back.get(fm).push(fd); }
  for (const [fm, fds] of back) {
    if (fds.length < 2) continue;
    conflicts.push({ fotmobId: fm, fdIds: fds });
    for (const fd of fds) pairs.delete(fd);
  }

  const votesOf = new Map([...votes].map(([fd, m]) => [fd, [...m.values()].reduce((a, b) => a + b, 0)]));
  return { pairs, votes: votesOf, names, conflicts, seasons, matched, unmatchedMid };
}
