import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_TYPES = new Set(['article', 'broadcast', 'video', 'podcast', 'press-conference']);
const CATEGORIES = new Set(['news', 'legend', 'expert']);
const required = ['id', 'category', 'expert', 'role', 'publisher', 'publishedAt', 'url', 'summary'];
const text = (value, field, key) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`[${key}] 專家觀點缺少 ${field}`);
  return value.trim();
};

/* 真人專家層只有一件事比「有內容」重要:不能把沒有來源的話掛到真人名下。
   因此資料不完整時直接讓 build 失敗;verified=false 可以當草稿保存,但不會送到前端。 */
export function validateExpertOpinions(raw, { validMatchKeys = null } = {}) {
  if (!raw || raw.version !== 1 || !raw.matches || typeof raw.matches !== 'object' || Array.isArray(raw.matches)) {
    throw new Error('data/manual/expert-opinions.json 必須是 version=1 且含 matches 物件');
  }

  const published = {}, ids = new Set(), sourceKeys = new Set();
  const categories = { news: 0, legend: 0, expert: 0 };
  let drafts = 0, opinions = 0;
  for (const [matchKey, rows] of Object.entries(raw.matches)) {
    if (!/^\d{4}-\d{2}\|[A-Z0-9]{2,5}\|[A-Z0-9]{2,5}$/.test(matchKey)) {
      throw new Error(`專家觀點比賽鍵格式錯誤:${matchKey}`);
    }
    if (validMatchKeys && !validMatchKeys.has(matchKey)) throw new Error(`專家觀點找不到對應比賽:${matchKey}`);
    if (!Array.isArray(rows)) throw new Error(`[${matchKey}] 專家觀點必須是陣列`);

    const ready = [];
    for (const source of rows) {
      for (const field of required) text(source?.[field], field, matchKey);
      if (ids.has(source.id)) throw new Error(`專家觀點 id 重複:${source.id}`);
      ids.add(source.id);

      let parsed;
      try { parsed = new URL(source.url); } catch { throw new Error(`[${source.id}] 原始來源網址無效`); }
      if (parsed.protocol !== 'https:') throw new Error(`[${source.id}] 原始來源必須使用 HTTPS`);
      // 同一篇賽後報導常同時包含記者、名宿與兩隊教練的觀點。允許共用原始頁，
      // 但同一場、同一人物、同一頁不能重複發布。
      const sourceKey = `${matchKey}|${source.expert.trim().toLowerCase()}|${parsed.href}`;
      if (sourceKeys.has(sourceKey)) throw new Error(`專家觀點人物與來源重複:${source.expert}・${parsed.href}`);
      sourceKeys.add(sourceKey);

      if (!SOURCE_TYPES.has(source.sourceType)) throw new Error(`[${source.id}] 不支援的 sourceType:${source.sourceType}`);
      if (!CATEGORIES.has(source.category)) throw new Error(`[${source.id}] 不支援的 category:${source.category}`);
      if (Number.isNaN(Date.parse(source.publishedAt))) throw new Error(`[${source.id}] publishedAt 不是有效時間`);
      if (source.reviewedAt && Number.isNaN(Date.parse(source.reviewedAt))) throw new Error(`[${source.id}] reviewedAt 不是有效時間`);
      if (source.summary.length < 20 || source.summary.length > 800) throw new Error(`[${source.id}] 摘要需為 20～800 字`);
      if ('quote' in source) throw new Error(`[${source.id}] 第一版不接受直接引言;請改寫為有來源的摘要`);
      if (source.topics != null && (!Array.isArray(source.topics) || source.topics.some(x => typeof x !== 'string'))) {
        throw new Error(`[${source.id}] topics 必須是字串陣列`);
      }
      if (source.evidence != null && (!Array.isArray(source.evidence) || source.evidence.some(x => typeof x !== 'string'))) {
        throw new Error(`[${source.id}] evidence 必須是字串陣列`);
      }

      if (source.verified !== true) { drafts++; continue; }
      ready.push({
        id: source.id,
        category: source.category,
        expert: source.expert.trim(), role: source.role.trim(), publisher: source.publisher.trim(),
        publishedAt: source.publishedAt, url: parsed.href, sourceType: source.sourceType,
        summary: source.summary.trim(), summaryType: '人工核對摘要',
        topics: (source.topics ?? []).slice(0, 6), evidence: (source.evidence ?? []).slice(0, 6),
        reviewedAt: source.reviewedAt ?? null, verified: true, human: true,
      });
      opinions++;
      categories[source.category]++;
    }
    if (ready.length) published[matchKey] = ready;
  }

  return {
    version: 1,
    updatedAt: raw.updatedAt ?? null,
    mode: 'manual-reviewed',
    note: '只發布有具名專家、原始來源與人工核對摘要的真人觀點;本站 AI／模板分析另區顯示。',
    counts: { matches: Object.keys(published).length, opinions, drafts, categories },
    matches: published,
  };
}

export function loadExpertOpinions(root, options = {}) {
  const path = join(root, 'data', 'manual', 'expert-opinions.json');
  if (!existsSync(path)) return validateExpertOpinions({ version: 1, updatedAt: null, matches: {} }, options);
  return validateExpertOpinions(JSON.parse(readFileSync(path, 'utf8')), options);
}
