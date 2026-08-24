import { preMatchBundle, postMatchBundle } from './features.mjs';
import { templateFor, CAVEAT } from './template.mjs';
import { verify } from './verify.mjs';
import { callLLM, llmEnabled } from './llm.mjs';
import { bundleHash, ReportCache } from './cache.mjs';

export { preMatchBundle, postMatchBundle, templateFor, CAVEAT, verify, bundleHash, ReportCache, llmEnabled };

/* 一篇報告的生產流程:
 *
 *   feature bundle ──► 沒有 API key ──────────────────────► 模板版(永遠可用)
 *          │
 *          └► 有 key ──► hash 命中快取? ──是──► 直接用(不花錢)
 *                              │否
 *                              ▼
 *                         LLM 產出 ──► 數字驗證 ──不過──► 退回模板版(記錄原因)
 *                                             │過
 *                                             ▼
 *                                          寫入快取
 *
 * 只有 LLM 的產出進快取,模板版不進。
 * 理由:模板是純函式,同樣的 bundle 一定得到同樣的文字,重算不用錢也不會變;
 * 反而是把它快取起來會出事 —— 改了模板,hash 沒變,舊文字就會一直被端出來。
 *
 * 任何一步失敗都不會讓 build 掛掉,最差就是模板版。
 */
export async function generateReport(bundle, { cache = null, env = process.env, fetchImpl = fetch, model } = {}) {
  const hash = bundleHash(bundle);
  const tpl = templateFor(bundle);
  const fallback = {
    hash, kind: bundle.kind, key: bundle.key,
    title: tpl.title, paragraphs: tpl.paragraphs, caveat: CAVEAT[bundle.kind],
    source: 'template', verified: true, note: null,
  };

  if (!llmEnabled(env)) return { ...fallback, cached: false };

  const cached = cache?.get(hash);
  if (cached) return { ...cached, hash, cached: true };

  const out = await callLLM(bundle, { env, fetchImpl, ...(model ? { model } : {}) });
  if (!out.ok) return { ...fallback, note: `LLM 未產出(${out.error}),已改用模板版`, cached: false };

  const check = verify(out.text, bundle.facts);
  if (!check.ok) {
    return {
      ...fallback, cached: false, rejected: out.text,
      note: `LLM 產出未通過數字驗證(${check.reason}),已改用模板版`,
    };
  }

  const rec = {
    hash, kind: bundle.kind, key: bundle.key,
    title: tpl.title,
    paragraphs: out.text.split(/\n{1,}/).map(s => s.trim()).filter(Boolean),
    caveat: CAVEAT[bundle.kind],
    source: 'llm', model: out.model, verified: true, note: null,
  };
  cache?.set(hash, rec);
  return { ...rec, cached: false };
}
