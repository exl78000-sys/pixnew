/* 人工整理外電的「收件匣 → 檔案庫」。
 *
 * 為什麼要有這一層:
 *
 *   `data/manual/news-curated.json` 是**協作方每次交付的整份檔案**,
 *   一份只涵蓋一週。直接讀它的話,下一次交付就會把上一次的整批蓋掉 ——
 *   上週的賽報就這樣消失,而且沒有任何地方會報錯。
 *
 *   所以交付檔當**收件匣**(格式不動,協作方照舊產出),
 *   合併進 `data/manual/news-curated-archive.json` 這個**檔案庫**,
 *   依 `id` 去重、記 firstSeen / lastSeen、依日期淘汰過舊的。
 *
 * 三件要守的事:
 *
 * 1. **涵蓋範圍要誠實,包含斷檔。**
 *    檔案庫記每一次交付的 window,合併成連續區間;**中間沒交付的那幾天要講出來**。
 *    不講的話,讀者看到「8/1–8/28」會以為那 28 天都收了,
 *    但實際上可能只有兩個週末有人整理 —— 那是編出來的涵蓋範圍(鐵則一的變形)。
 *
 * 2. **重跑不可以產生變化。**
 *    這個腳本掛在每 10 分鐘一次的排程上。若每次都改 lastSeen,
 *    檔案庫就會每 10 分鐘被提交一次,git log 全是雜訊。
 *    所以:內容真的變了才動 lastSeen,整份沒變就完全不寫檔。
 *
 * 3. **後到的交付可以修正先前的內容,但不可以重複一則。**
 *    同一個 id 再出現 → 更新內容、保留 firstSeen。
 *    這樣協作方發現摘要寫錯時,重送一次就會蓋掉舊的。
 */

const DAY = 86400000;

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
const dayOf = s => String(s ?? '').slice(0, 10);

export const addDays = (iso, n) => {
  const t = Date.parse(`${dayOf(iso)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + n * DAY).toISOString().slice(0, 10);
};

/* 比對「內容有沒有變」用的正規化字串。
   firstSeen / lastSeen 是檔案庫自己加的,不算內容 —— 拿它們去比的話,
   每次跑都會判定成「變了」,第 2 點就守不住。 */
const contentKey = story => {
  const { firstSeen, lastSeen, ...rest } = story;
  const keys = Object.keys(rest).sort();
  return JSON.stringify(keys.map(k => [k, rest[k]]));
};

export const emptyArchive = () => ({
  note: '人工整理外電的檔案庫。由 scripts/merge-curated-news.mjs 從 data/manual/news-curated.json'
    + '(每次交付的收件匣)合併而來,不要手動編輯。',
  updatedAt: null,
  keepDays: null,
  deliveries: [],
  stories: [],
});

/* 交付檔的形狀檢查。壞掉的那幾則報出來,不要整份丟掉 ——
   一則沒有 id 不代表另外十三則也不能收。 */
export function readDelivery(raw) {
  const problems = [];
  const w = raw?.window ?? {};
  if (!isDate(w.from) || !isDate(w.to)) problems.push('window.from / window.to 不是 YYYY-MM-DD');
  const stories = [], bad = [];
  for (const s of raw?.stories ?? []) {
    if (!s?.id) { bad.push('(沒有 id 的項目)'); continue; }
    if (!isDate(s.date)) { bad.push(`${s.id}(date 不是 YYYY-MM-DD)`); continue; }
    stories.push(s);
  }
  if (bad.length) problems.push(`跳過 ${bad.length} 則:${bad.join('、')}`);
  const seen = new Set(), dupes = [];
  for (const s of stories) { if (seen.has(s.id)) dupes.push(s.id); seen.add(s.id); }
  if (dupes.length) problems.push(`交付檔內部 id 重複:${[...new Set(dupes)].join('、')}`);
  // 這則的日期落在宣告的 window 之外 —— 不是錯(可以報導更早的事),但要講
  const outside = isDate(w.from) && isDate(w.to)
    ? stories.filter(s => s.date < w.from || s.date > w.to).map(s => s.id)
    : [];
  return {
    ok: isDate(w.from) && isDate(w.to),
    source: raw?.source ?? null,
    retrievedAt: raw?.retrievedAt ?? null,
    from: w.from ?? null,
    to: w.to ?? null,
    stories,
    problems,
    outside,
  };
}

const deliveryKey = d => [d.source ?? '', d.retrievedAt ?? '', d.from, d.to].join('|');

/* 收件匣 → 檔案庫。回傳新的檔案庫與這次的差異(不就地改參數)。 */
export function mergeDelivery(archive, delivery, { now = new Date().toISOString() } = {}) {
  const seenDay = dayOf(delivery.retrievedAt ?? now) || dayOf(now);
  const byId = new Map((archive.stories ?? []).map(s => [s.id, s]));
  const added = [], updated = [], unchanged = [];

  for (const s of delivery.stories) {
    const old = byId.get(s.id);
    if (!old) {
      byId.set(s.id, { ...s, firstSeen: seenDay, lastSeen: seenDay });
      added.push(s.id);
    } else if (contentKey(old) !== contentKey(s)) {
      // 內容改了 → 用新的,但 firstSeen 是「第一次看到」,不能被後來的交付蓋掉
      byId.set(s.id, { ...s, firstSeen: old.firstSeen ?? seenDay, lastSeen: seenDay });
      updated.push(s.id);
    } else {
      unchanged.push(s.id);
    }
  }

  const key = deliveryKey(delivery);
  const deliveries = (archive.deliveries ?? []).slice();
  const known = deliveries.some(d => deliveryKey(d) === key);
  if (!known) {
    deliveries.push({
      source: delivery.source,
      retrievedAt: delivery.retrievedAt,
      from: delivery.from,
      to: delivery.to,
      stories: delivery.stories.length,
    });
  }

  const stories = [...byId.values()].sort((a, b) =>
    (a.date === b.date ? (a.id < b.id ? -1 : 1) : (a.date < b.date ? 1 : -1)));

  return {
    archive: {
      ...emptyArchive(),
      ...archive,
      note: emptyArchive().note,
      updatedAt: added.length || updated.length || !known ? now : (archive.updatedAt ?? now),
      deliveries: deliveries.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
      stories,
    },
    added, updated, unchanged,
    newDelivery: !known,
    changed: added.length > 0 || updated.length > 0 || !known,
  };
}

/* 淘汰太舊的。
   **交付紀錄要跟著淘汰**,不然涵蓋範圍會宣稱收了一段其實已經被刪掉的日子。
   跨過界線的那一次交付,`from` 要往後夾到界線上 —— 界線之前的那幾則已經不在檔案庫裡了。 */
export function pruneArchive(archive, { asOf, keepDays = 180 } = {}) {
  const cutoff = addDays(asOf ?? new Date().toISOString(), -keepDays);
  if (!cutoff) return { archive, droppedStories: [], droppedDeliveries: 0, cutoff: null };
  const keep = [], droppedStories = [];
  for (const s of archive.stories ?? []) (s.date >= cutoff ? keep : droppedStories).push(s);
  const deliveries = [];
  let droppedDeliveries = 0;
  for (const d of archive.deliveries ?? []) {
    if (d.to < cutoff) { droppedDeliveries++; continue; }
    deliveries.push(d.from < cutoff ? { ...d, from: cutoff, clamped: true } : d);
  }
  return {
    archive: { ...archive, deliveries, stories: keep },
    droppedStories: droppedStories.map(s => s.id),
    droppedDeliveries,
    cutoff,
  };
}

/* 涵蓋範圍:把交付的 window 合成連續區間,並把中間的斷檔算出來。
   相鄰(下一段的 from 就是上一段 to 的隔天)算連續 —— 那中間沒有漏掉任何一天。 */
export function coverageOf(archive) {
  const wins = (archive.deliveries ?? [])
    .filter(d => isDate(d.from) && isDate(d.to) && d.from <= d.to)
    .map(d => ({ from: d.from, to: d.to }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : (a.to < b.to ? -1 : 1)));
  const ranges = [];
  for (const w of wins) {
    const last = ranges[ranges.length - 1];
    if (last && w.from <= addDays(last.to, 1)) { if (w.to > last.to) last.to = w.to; }
    else ranges.push({ ...w });
  }
  const gaps = [];
  for (let i = 1; i < ranges.length; i++) {
    gaps.push({ from: addDays(ranges[i - 1].to, 1), to: addDays(ranges[i].from, -1) });
  }
  const days = ranges.reduce((n, r) =>
    n + Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / DAY) + 1, 0);
  return {
    ranges, gaps, days,
    from: ranges[0]?.from ?? null,
    to: ranges[ranges.length - 1]?.to ?? null,
    deliveries: (archive.deliveries ?? []).length,
    stories: (archive.stories ?? []).length,
    // 保留天數由合併腳本寫進檔案庫。畫面上寫死一個數字的話,
    // 改了 --keep-days 之後畫面就會說謊
    keepDays: archive.keepDays ?? null,
  };
}

/* build 時用的:檔案庫疊上收件匣,同一個 id 以收件匣為準。
   為什麼要疊:合併腳本跟 build 是兩個步驟,新交付落地但還沒合併時,
   只讀檔案庫的話**這一批新的整批看不到**。疊上去就是「最新的一定看得到」。 */
export function overlay(archiveStories, inboxStories) {
  const byId = new Map((archiveStories ?? []).map(s => [s.id, s]));
  for (const s of inboxStories ?? []) {
    if (!s?.id) continue;
    const old = byId.get(s.id);
    byId.set(s.id, old ? { ...s, firstSeen: old.firstSeen ?? null, lastSeen: old.lastSeen ?? null } : s);
  }
  return [...byId.values()].sort((a, b) =>
    (a.date === b.date ? (a.id < b.id ? -1 : 1) : (a.date < b.date ? 1 : -1)));
}

/* 收件匣還沒併進檔案庫時,涵蓋範圍也要把它算進去 ——
   不然畫面會說「收到 8/21」但清單裡已經有 8/28 的新聞。 */
export function coverageWith(archive, delivery) {
  if (!delivery?.ok) return coverageOf(archive);
  const key = deliveryKey(delivery);
  const known = (archive.deliveries ?? []).some(d => deliveryKey(d) === key);
  if (known) return coverageOf(archive);
  return coverageOf({
    ...archive,
    deliveries: [...(archive.deliveries ?? []), {
      source: delivery.source, retrievedAt: delivery.retrievedAt,
      from: delivery.from, to: delivery.to, stories: delivery.stories.length,
    }],
  });
}

/* build 端的單一入口。**英超與西甲共用這一個函式**(CLAUDE.md 的規矩:
   跨聯賽的東西只能有一份定義,複製一份過去的話改了一邊另一邊會悄悄過期)。

   讀檔案庫 → 疊上收件匣 → 比分核對 → 篩這個聯賽,並算出誠實的涵蓋範圍。
   log 用回傳的方式給呼叫端印,函式本身不碰 stdout(這樣測試不用攔輸出)。 */
export async function loadCurated({ root, league, codeOf, fixturesOf, fs }) {
  const { existsSync, readFile, join } = fs;
  const inboxPath = join(root, 'data', 'manual', 'news-curated.json');
  const archivePath = join(root, 'data', 'manual', 'news-curated-archive.json');
  const lines = [];
  const readJson = async p => {
    if (!existsSync(p)) return null;
    try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) {
      lines.push(`⚠ ${p.split('/').pop()} 讀取失敗:${e.message}`);
      return null;
    }
  };

  const archive = (await readJson(archivePath)) ?? emptyArchive();
  const rawInbox = await readJson(inboxPath);
  const delivery = rawInbox ? readDelivery(rawInbox) : null;
  // 收件匣還沒併進檔案庫時也要看得到 —— 合併腳本與 build 是兩個步驟
  const stories = overlay(archive.stories, delivery?.stories ?? []);
  if (!stories.length) return { items: [], coverage: null, lines, rejected: [], unknownStatus: [] };

  const { toFeedItems, forLeague } = await import('./adapters/curated-news.mjs');
  const out = toFeedItems(stories, { codeOf, fixturesOf });
  const items = forLeague(out.items, league);
  const coverage = coverageWith(archive, delivery);

  const v = items.filter(i => i.scoreCheck === 'verified').length;
  const u = items.filter(i => i.scoreCheck === 'unverified').length;
  lines.push(`人工整理外電:${items.length} 則(比分已核對 ${v}・無法核對 ${u}`
    + `・因比分不符退回 ${out.rejected.length})`);
  lines.push(`  檔案庫 ${archive.stories?.length ?? 0} 則、${coverage.deliveries} 次交付,`
    + `涵蓋 ${coverage.from ?? '—'} ~ ${coverage.to ?? '—'} 共 ${coverage.days} 天`
    + (coverage.gaps.length ? `,中間有 ${coverage.gaps.length} 段沒有整理` : ''));
  for (const g of coverage.gaps) lines.push(`  ⚠ 斷檔 ${g.from} ~ ${g.to}`);
  for (const r of out.rejected) lines.push(`⚠ 退回 ${r.id}:${r.detail.join(' / ')}`);
  if (out.unknownStatus.length) lines.push(`⚠ 沒見過的 status:${out.unknownStatus.join('、')}`);

  return { items, coverage, lines, rejected: out.rejected, unknownStatus: out.unknownStatus };
}
