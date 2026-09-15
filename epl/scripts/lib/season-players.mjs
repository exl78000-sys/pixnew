/* 逐場球員統計 → 整季球員層(跨賽事共用)。
 *
 * 歐冠本季(2026-09-15)先做出這條路:上游沒有整季球員榜時,拿**逐場**的球員統計自己累加。
 * 英冠同一天接上 —— 它的逐場資料(FotMob 聯賽 id 48)一直都在倉庫裡,只是沒有人去加總。
 * 兩邊**共用這一份**:各寫一份的話,兩個賽事的「進球榜」定義會慢慢走鐘,而畫面上看不出來
 * (CLAUDE.md:跨聯賽的轉換與流程一律共用,不複製)。
 *
 * ── 核心規矩:一場一場對回比分,對不上的整場不計 ──
 * 逐人統計是上游算的,它可能漏人、可能把某球記給別人。唯一能驗的是**加總**:
 * 「該隊球員的進球 + 對手的烏龍球 = 這一場的比分」。對不上就整場不計(不是挑對的那幾個人用),
 * 並把原因記進 `excluded` 讓畫面講得出來 —— 依設計拒收之後要留下紀錄(CLAUDE.md 那條坑)。
 *
 * ── 烏龍球的隊伍語意 ──
 * FotMob 事件的烏龍球 `team` 是**踢進自家球門那個人的隊**,得分算對手。
 * 三聯賽 85 場驗過(見 `matchstats.mjs` 的 `toCanonicalDetail`),英冠 60 場再驗一次:
 * 翻轉 57 場對、不翻 1 場對。所以這裡一律**記給對手**。
 * 注意:傳進來的事件要是**原始的**(還沒過 `toCanonicalDetail`)—— canonical 已經翻過一次,
 * 再翻一次就錯了。呼叫端自己知道手上是哪一種。
 *
 * ── 牌是從事件用「同一場同一隊的姓名」接回球員身上的 ──
 * 逐人統計裡的 cards 永遠是 null(上游的 playerStats 沒有牌),而**牌事件有球員姓名、沒有 id**。
 * 同一場同一隊的名單裡姓名是唯一的(英冠 626 場 0 組重名),所以用 (這一場, 這一隊, 姓名) 當鍵接得回去:
 * 英冠 2409/2410、歐冠 94~96% 配得上。配不上的**全部是總教練**(Ancelotti、Simeone、Julien Stéphan…)
 * —— 教練吃牌本來就不該掛到球員身上,所以那不是 bug(CLAUDE.md:沒有 person 的留著、不要收緊成紅線)。
 * 配不上的筆數記進 `cardsUnmatched` 讓呼叫端印出來,不要靜靜吞掉。
 *
 * ── xG 只算射門圖完整的場次 ──
 * 逐人 xG 是拿逐射門加總出來的,射門圖不完整(進球數對不回比分)的場次少算,
 * 混進去會讓一個人的整季 xG 憑空變小而沒有人發現。所以只加完整的那幾場,
 * 並把 `xgComplete` 場數輸出讓畫面標明。
 */

/* 榜單的定義。**加一榜要同時想「母體是誰」** —— 評分榜要求出賽 ≥ 2 場,
   不然踢了 12 分鐘拿 8.4 的人會排在整季第一(歐冠那一版就是這樣定的,英冠沿用)。 */
const LEADERS = [
  { key: 'goals', zh: '進球', unit: '球' },
  { key: 'goal_assist', zh: '助攻', unit: '次' },
  { key: 'expected_goals', zh: '預期進球 xG', unit: '', dp: 2 },
  { key: 'total_att_assist', zh: '創造機會', unit: '次' },
  { key: 'rating', zh: 'FotMob 評分(逐場平均,出賽 ≥ 2 場)', unit: '', dp: 2, minMatches: 2 },
];

export const PLAYER_STAT_META = {
  mins_played: 'Minutes played', goals: 'Goals', goal_assist: 'Assists',
  rating: 'FotMob rating (average of match ratings)',
  expected_goals: 'Expected goals (xG, sum of shots; complete shotmaps only)',
  expected_assists: 'Expected assists (xA, sum)',
  shots_total: 'Shots (total)', ontarget_total: 'Shots on target (total)',
  total_att_assist: 'Chances created (key passes, total)',
  tackles_total: 'Tackles (total)', interceptions_total: 'Interceptions (total)',
  yellow_card: 'Yellow cards', red_card: 'Red cards', saves_total: 'Saves (total)',
};

const r2 = v => Math.round(v * 100) / 100;

/* rows:一場一筆
     { key, home, away, players: { 隊: [逐人] }, events, shots, score, shotmapComplete, skip }
   `skip` 有值代表這一場連資料都沒有(理由當成 excluded 的原因),不計進 matches。
   `score` 是**主來源**的最終比分([主, 客]);null 代表沒有可信的比分 → 這一場不計。
   teamNames:隊 → 顯示名稱(沒有就印隊本身)。 */
export function aggregatePlayers(rows, { teamNames = {} } = {}) {
  const byPlayer = new Map();
  const excluded = [];
  let matches = 0, reconciled = 0, xgComplete = 0, cardsUnmatched = 0;
  for (const r of rows) {
    if (r.skip) { excluded.push({ key: r.key, reason: r.skip }); continue; }
    matches++;
    const { home: h, away: a, players, events = [], shots = [], score } = r;
    if (!score) { excluded.push({ key: r.key, reason: '主來源沒有比分' }); continue; }
    /* 烏龍球記給**對手**(見檔頭)。判定只看 detail / ownGoal 旗標 —— 上游的烏龍球一律沒有射手,
       但**反過來不成立**:第一版順手把「沒有射手」也當成烏龍球,那會讓一顆上游漏記射手的正常進球
       靜靜記到對手頭上(而且那一場還會「對得回比分」,因為兩邊各差一球互相抵銷)。
       兩個賽事都數過:歐冠 2025-26 與英冠 626 場裡,沒有射手的進球事件**全部**是 Own Goal,
       所以這個條件收緊之後行為不變;真的出現漏記射手的那一天,那一場會對不回比分 → 整場不計並記進
       excluded,而不是把球算給錯的隊(配錯人比配不到糟)。 */
    const playerGoals = t => (players[t] ?? []).reduce((s, p) => s + (p.goals?.total ?? 0), 0);
    const ownGoals = t => events.filter(e => e.type === 'Goal' && (e.ownGoal || e.detail === 'Own Goal') && String(e.team) !== String(t)).length;
    const got = [playerGoals(h) + ownGoals(h), playerGoals(a) + ownGoals(a)];
    if (got[0] !== score[0] || got[1] !== score[1]) { excluded.push({ key: r.key, reason: `球員進球 ${got.join(':')} 對不回比分 ${score.join(':')}` }); continue; }
    reconciled++;
    const shotmapOk = r.shotmapComplete === true;
    if (shotmapOk) xgComplete++;
    /* 牌:事件 → 球員(見檔頭)。先建「這一隊姓名唯一」的索引,同名的兩個人都不掛(配錯人比配不到糟)。 */
    const cardsOf = new Map();
    {
      const idx = new Map();
      for (const [t, list] of Object.entries(players)) {
        const byName = new Map();
        for (const p of list ?? []) byName.set(p.name, byName.has(p.name) ? null : p);
        idx.set(String(t), byName);
      }
      for (const e of events) {
        if (e.type !== 'Card') continue;
        const p = idx.get(String(e.team))?.get(e.player) ?? null;
        if (!p) { cardsUnmatched++; continue; }
        const key = `${e.team}|${p.providerId ?? p.name}`;
        const c = cardsOf.get(key) ?? { yellow: 0, red: 0 };
        /* 只認上游明講的兩種。第三種代碼出現時**不分類**(而不是猜成黃牌)——
           跟進球子代碼同一條規矩;真的出現了,總數會跟這兩個相加對不上,那時再核對放行。 */
        if (e.detail === 'Red Card') c.red++;
        else if (e.detail === 'Yellow Card') c.yellow++;
        cardsOf.set(key, c);
      }
    }
    for (const [t, list] of Object.entries(players)) {
      for (const p of list ?? []) {
        if (!Number.isFinite(p.minutes) || p.minutes <= 0) continue;   // 沒上場的不列
        const id = `${t}|${p.providerId ?? p.name}`;
        const e = byPlayer.get(id) ?? { team: t, providerId: p.providerId ?? null, name: p.name, minutes: 0, matches: 0, ratings: [], s: {}, pos: new Map(), shirt: new Map() };
        const add = (k, v) => { if (Number.isFinite(v)) e.s[k] = (e.s[k] ?? 0) + v; };
        e.name = p.name; e.minutes += p.minutes; e.matches++;
        /* 位置與背號:上游是**逐場**給的,同一個人可能場場不同(而且替補上場那幾場的位置是 '?')。
           取「出現最多次的那一個」,並且 '?' 不算 —— 全部都是 '?' 的人回 null,畫面印「—」。
           不要拿最後一場當答案:那等於讓一次客串決定他整季的位置。 */
        if (p.pos && p.pos !== '?') e.pos.set(p.pos, (e.pos.get(p.pos) ?? 0) + 1);
        if (p.shirt != null) e.shirt.set(p.shirt, (e.shirt.get(p.shirt) ?? 0) + 1);
        if (Number.isFinite(p.rating)) e.ratings.push(p.rating);
        add('goals', p.goals?.total); add('goal_assist', p.goals?.assists);
        add('shots_total', p.shots?.total); add('ontarget_total', p.shots?.on);
        add('total_att_assist', p.passes?.key); add('expected_assists', p.xA);
        add('tackles_total', p.tackles?.total); add('interceptions_total', p.tackles?.interceptions);
        const c = cardsOf.get(`${t}|${p.providerId ?? p.name}`);
        add('yellow_card', p.cards?.yellow ?? c?.yellow); add('red_card', p.cards?.red ?? c?.red);
        add('saves_total', p.goals?.saves);
        if (shotmapOk) {
          const xg = shots.filter(sh => String(sh.team) === String(t) && sh.player === p.name && !sh.ownGoal && Number.isFinite(sh.xg)).reduce((s2, sh) => s2 + sh.xg, 0);
          add('expected_goals', xg);
        }
        byPlayer.set(id, e);
      }
    }
  }
  const players = [...byPlayer.values()].map(e => {
    const stats = { mins_played: e.minutes };
    for (const [k, v] of Object.entries(e.s)) stats[k] = ['expected_goals', 'expected_assists'].includes(k) ? r2(v) : v;
    if (e.ratings.length) stats.rating = r2(e.ratings.reduce((a, b) => a + b, 0) / e.ratings.length);
    const modal = m => [...m.entries()].sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])))[0]?.[0] ?? null;
    return { team: e.team, teamName: teamNames[e.team] ?? String(e.team), providerId: e.providerId, name: e.name,
      pos: modal(e.pos), shirt: modal(e.shirt),
      minutes: e.minutes, matches: e.matches, ratedMatches: e.ratings.length, stats };
  });
  // 排序固定,兩個 build 的輸出才逐位元組相同
  players.sort((a, b) => a.team.localeCompare(b.team) || b.minutes - a.minutes || a.name.localeCompare(b.name));
  return { players, matches, reconciled, xgComplete, excluded, cardsUnmatched };
}

export function leadersFrom(agg, { limit = 12 } = {}) {
  const out = [];
  for (const c of LEADERS) {
    const eligible = agg.players.filter(p => Number.isFinite(p.stats[c.key]) && (!c.minMatches || p.matches >= c.minMatches));
    const rows = eligible.map(p => ({ name: p.name, team: p.teamName, teamId: p.team, value: p.stats[c.key], minutes: p.minutes, matches: p.matches }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)).slice(0, limit);
    if (rows.length) out.push({ key: c.key, zh: c.zh, unit: c.unit, dp: c.dp, rows, pool: eligible.length });
  }
  return out;
}

/* 逐隊名單,跟交付檔那條路同一個形狀(statMeta + teams{隊: [...]}),vault 與畫面共用 */
export function squadsFrom(agg) {
  const teams = {};
  for (const p of agg.players) {
    (teams[p.team] ??= []).push({ name: p.name, countryCode: null, minutes: p.minutes, matches: p.matches, stats: p.stats });
  }
  for (const list of Object.values(teams)) list.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
  /* 鍵的排序:歐冠是 football-data 的數字 id、英冠是隊碼,所以數字比數字、字串比字串 */
  const keys = Object.keys(teams).sort((a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)));
  return { statMeta: { ...PLAYER_STAT_META }, teams: Object.fromEntries(keys.map(k => [k, teams[k]])) };
}
