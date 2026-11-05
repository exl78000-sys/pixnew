/* 逐場抓取器的「哪幾場已經踢完」要用這一次部署抓到的東西,不是上一次的產物(2026-11-05)。
 *
 * 為什麼:`scripts/game/fetch-fotmob-epl.mjs` 對六個聯賽讀 `web/data/.../results.json` 決定要抓哪幾場。
 * 那份是 build 的產物,而 2026-10-30(D3)之後比賽日迴圈只推 `live-data`、部署的回寫也不含產物 ——
 * 倉庫裡那幾份**停在 10-28**,抓取器從此每次都看到同一批「已完賽」。11-05 量到:FotMob 賽程說踢完、而產物裡
 * 沒有的,pl 10、es1 10、en2 24、de1 9、it1 10、fr1 9 場,而 build 每次都印「本季還沒抓到 N 場」、N 一直長。
 * 那幾場沒有逐場資料,所以沒有賽後報告、逐場統計、球員層(英冠的球員榜是逐場累加的)。
 *
 * 做法:同一個部署開頭就抓好的 FotMob 賽程快取(`data/raw/{fotmobDir}/scores.json`,隊碼已經在抓的時候對好、
 * build 的暫定補比分也讀它)說踢完了、而產物還沒有那一組主客的已完賽紀錄,就補一列給抓取器。
 * (產物的 results.json 只收已完賽的場次,沒有「未賽的那一列」可以標,所以是補列不是改列。)
 * 比分取 FotMob 的,所以抓取器那一道「比分不符」變成同一家的自洽檢查;獨立的核對仍在 build
 * (`loadFotmobMatchStats` 拿本站自己的賽果逐場對,對不上整場退回),那一道沒有被繞過。
 *
 * 撞鍵(英冠的升級附加賽,「主|客」一季兩場):FotMob 那一組主客已完賽不只一場,就分不出哪一場對應本站的哪一個鍵 ——
 * 不補、記在 skipped(寧可晚一次,不可抓錯場;抓錯的話鍵會掛著另一場比賽,而那正是英冠附加賽那條坑)。 */
export function markFinishedFromFixtures(results, scores, { season, today }) {
  const out = { results, marked: [], skipped: [] };
  if (!Array.isArray(results) || !scores || scores.season !== season || !Array.isArray(scores.matches)) return out;
  const fin = new Map();   // 主|客 → FotMob 已完賽的那幾場
  for (const m of scores.matches) {
    if (!m?.finished || m.cancelled || !m.home || !m.away || !Array.isArray(m.score) || m.score.length !== 2) continue;
    if (!m.date || !(String(m.date) <= today)) continue;
    const k = `${m.home}|${m.away}`;
    if (!fin.has(k)) fin.set(k, []);
    fin.get(k).push(m);
  }
  const have = new Set(results.filter(r => r.season === season && r.played).map(r => `${r.home}|${r.away}`));
  const add = [];
  for (const [k, ms] of fin) {
    if (have.has(k)) continue;
    if (ms.length > 1) { out.skipped.push({ key: k, reason: `FotMob 這組主客有 ${ms.length} 場已完賽,分不出是哪一場` }); continue; }
    const [m] = ms;
    add.push({ season, date: m.date, home: m.home, away: m.away, played: true, fh: m.score[0], fa: m.score[1], playedFrom: 'fotmob-fixtures' });
    out.marked.push({ key: k, date: m.date });
  }
  out.results = add.length ? [...results, ...add] : results;
  return out;
}

/* 比賽夜迴圈的「進不進場」也讀上一次的產物(`live-window.mjs` 讀 fixtures.json 的開球時間)。
 * 2026-11-05 量到:倉庫裡那份停在 10-28,而上游是**逐月公布開球時間**的 —— 西甲 11 月 30 場在產物裡**一場都沒有開球時間**
 * (`decideWindow` 沒有 kickoff 的場次直接略過 → 整個週末不會為西甲進場)、義甲 8 場沒有、5 場改了時間,英冠法甲各 2 場改了。
 * 用同一次部署回寫的 FotMob 賽程快取覆蓋開球時間與「踢完了沒」;配對規則跟上面那支相同:一組主客只有一場才配,
 * 帶 pair 的(附加賽)只配同一天。只改開球時間與 played,其餘欄位照產物。 */
export function withFreshKickoffs(fixtures, scores) {
  const out = { fixtures, updated: 0 };
  if (!Array.isArray(fixtures) || !Array.isArray(scores?.matches)) return out;
  const by = new Map();
  for (const m of scores.matches) {
    if (!m?.home || !m?.away || !m.utcTime || m.cancelled) continue;
    const k = `${m.home}|${m.away}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(m);
  }
  out.fixtures = fixtures.map(f => {
    const cands = by.get(`${f.home}|${f.away}`) ?? [];
    const m = f.pair ? cands.find(c => c.date === f.date) : cands.length === 1 ? cands[0] : null;
    if (!m) return f;
    const played = f.played || m.finished === true;
    if (f.kickoff && Date.parse(f.kickoff) === Date.parse(m.utcTime) && played === !!f.played) return f;
    out.updated++;
    return { ...f, kickoff: m.utcTime, played };
  });
  return out;
}
