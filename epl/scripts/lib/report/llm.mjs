/* LLM 接口 —— 有 API key 才啟用,沒有就整層跳過。
 *
 * 設計原則(整個 AI 層的核心):
 *   模型只負責「解讀」,不負責「計算」與「查證」。
 *   所有數字都由 features.mjs 算好放進 facts,模型只能引用,不能自己算、自己記。
 *   產出還要通過 verify.mjs 才會採用,沒通過就退回模板。
 *
 * key 一律從環境變數讀。這個檔案跑在建置階段(Node),產物是靜態 JSON,
 * 所以 key 不會、也不可能出現在前端 bundle 裡。
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export const llmEnabled = (env = process.env) => Boolean(env.ANTHROPIC_API_KEY);

const SYSTEM = `你是足球數據分析的寫手,替一個公開的英超分析網站寫短文。

絕對規則(違反就整篇作廢):
1. 你不會算數。任何數字都必須從 <facts> 逐字抄出來,不准自己加減乘除、不准換算、不准估計。
2. <facts> 沒有的事情就不存在。不准提傷兵、轉會、球迷、天氣、裁判、賠率,也不准引用你記憶中的任何比賽或球員資料。
3. 不准寫「一定」「必勝」之類的斷言,機率就是機率。
4. 用繁體中文,語氣像懂球的人在跟朋友解釋,不要用行銷腔、不要用條列。

你的價值在於「解讀」:把這些數字之間的關係講清楚 —— 哪個數字跟哪個數字矛盾、
哪個數字其實沒有表面上那麼重要、讀者最該注意什麼。不要把 facts 換句話說再唸一次。`;

const userPrompt = bundle => {
  const facts = bundle.facts.map(f => `- ${f.id} | ${f.label} = ${f.text}`).join('\n');
  const ctx = bundle.kind === 'pre'
    ? `這是一場還沒開打的比賽:${bundle.home.en}(主)對 ${bundle.away.en}(客),${bundle.season} 賽季第 ${bundle.round} 輪。`
    : `這是一場已經開打的比賽:${bundle.home.en} 對 ${bundle.away.en}。`;
  const notes = (bundle.engineNotes ?? []).map(n => n.text ?? n);
  const gaps = (bundle.noHistory ?? []).length
    ? `\n\n<data-gaps>\n${bundle.noHistory.join('、')} 沒有上季英超統計(升班馬),相關欄位缺席是正常的,請據實說明,不要編造。\n</data-gaps>` : '';
  const extra = (notes.length ? `\n\n<engine-notes>\n${notes.join('\n')}\n</engine-notes>` : '') + gaps;
  return `${ctx}

<facts>
${facts}
</facts>${extra}

請寫 3 到 5 段,每段 2 到 4 句。只輸出文章本身,不要標題、不要前言、不要 markdown 標記。`;
};

/* 回傳 { ok, text, model, usage } 或 { ok:false, error } */
export async function callLLM(bundle, { env = process.env, fetchImpl = fetch, model = 'claude-sonnet-5', timeoutMs = 40000 } = {}) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'no-api-key' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model, max_tokens: 900, temperature: 0.4,
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt(bundle) }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `http-${res.status}: ${(await res.text()).slice(0, 200)}` };
    const json = await res.json();
    const text = (json.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (!text) return { ok: false, error: 'empty-response' };
    return { ok: true, text, model: json.model ?? model, usage: json.usage ?? null };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
