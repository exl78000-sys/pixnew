/* 外電標題與摘要的翻譯層 —— 有 API key 才啟用,沒有就整層跳過(顯示原文)。
 *
 * 這一層跟 llm.mjs 的原則一致但更嚴格:**只准翻譯,不准改內容**。
 * 外電是別人寫的事實陳述,我們沒有查證它的能力,也沒有改寫它的立場。
 * 所以:
 *   - 不准摘要、不准擴寫、不准補背景、不准下判斷
 *   - 數字、比分、分鐘數一律照抄
 *   - 人名與隊名保留原文(西班牙文/英文),不音譯 ——
 *     音譯會製造「這是誰」的歧義,而且跟站上其他地方的隊名對不起來
 *   - 翻不出來就回 null,由上層退回原文。**寧可不翻,不要翻錯**
 *
 * 原文一律保留在資料裡並顯示在畫面上,標明是機器翻譯 ——
 * 讀者要能自己對照,這是鐵則四(不確定性要寫在畫面上)。
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export const translateEnabled = (env = process.env) => Boolean(env.ANTHROPIC_API_KEY);

const SYSTEM = `你是新聞翻譯,把足球外電的標題與摘要翻成繁體中文。

絕對規則(違反就整筆作廢):
1. **只翻譯,不改寫。** 不准摘要、不准擴寫、不准補上原文沒有的背景或評論。
   原文說什麼就翻什麼,原文沒說的一個字都不要加。
2. **數字照抄。** 比分、分鐘、輪次、年份、金額一律跟原文一致,不換算、不四捨五入。
3. **人名與球隊名保留原文拼寫**(例如 Mbappé、Real Sociedad、Bernabéu),不要音譯成中文。
   因為這個網站其他地方用的是原文隊名,音譯會對不起來。
4. 不准加入你自己知道的任何資訊。你對這場比賽的記憶一律不算數,只有原文算數。
5. 摘要如果原文是被截斷的(結尾不完整),翻譯也保持截斷,不要幫它補完。

語氣:像新聞標題與導言,簡潔、不用行銷腔、不加感嘆。

輸出格式(嚴格,只輸出這兩行,不要任何其他文字):
標題:<翻譯後的標題>
摘要:<翻譯後的摘要>`;

const userPrompt = ({ title, body }) => `請翻譯以下外電:

<title>
${title}
</title>

<body>
${body ?? ''}
</body>`;

/* 檢查模型有沒有守規矩。守不住就整筆退回原文 —— 這比顯示一個可能被改寫過的
   翻譯安全得多。檢查的是「數字有沒有被動過」:原文出現的數字,譯文要一個不少。 */
export function verifyTranslation(src, out) {
  if (!out?.title) return { ok: false, reason: 'empty-title' };
  // 標題翻譯完不該比原文長太多 —— 長很多通常代表模型加了東西
  if (out.title.length > src.title.length * 2.2 + 20) return { ok: false, reason: 'title-too-long' };
  const nums = t => (String(t ?? '').match(/\d+/g) ?? []);
  const srcNums = nums(src.title), outNums = nums(out.title);
  for (const n of srcNums) {
    if (!outNums.includes(n)) return { ok: false, reason: `title-lost-number:${n}` };
  }
  if (src.body && out.body) {
    const lost = nums(src.body).filter(n => !nums(out.body).includes(n));
    // 摘要較長,允許少數落差(原文可能重複同一個數字),但不能整批不見
    if (lost.length > Math.max(1, nums(src.body).length * 0.3)) {
      return { ok: false, reason: `body-lost-numbers:${lost.slice(0, 4).join(',')}` };
    }
  }
  return { ok: true };
}

function parseOutput(text) {
  const title = text.match(/^\s*標題[:：]\s*(.+)$/m)?.[1]?.trim();
  const body = text.match(/^\s*摘要[:：]\s*([\s\S]+)$/m)?.[1]?.trim();
  return title ? { title, body: body || null } : null;
}

/* 回傳 { ok, title, body, model } 或 { ok:false, error } */
export async function translateItem(item, {
  env = process.env, fetchImpl = fetch, model = 'claude-sonnet-5', timeoutMs = 30000,
} = {}) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'no-api-key' };
  if (!item?.title) return { ok: false, error: 'no-title' };

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
        // temperature 壓到 0:翻譯要的是可重現,不是創意
        model, max_tokens: 700, temperature: 0,
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt(item) }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `http-${res.status}: ${(await res.text()).slice(0, 200)}` };
    const json = await res.json();
    const text = (json.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    const parsed = parseOutput(text);
    if (!parsed) return { ok: false, error: 'unparsable-output' };
    const check = verifyTranslation(item, parsed);
    if (!check.ok) return { ok: false, error: `verify-failed:${check.reason}` };
    return { ok: true, ...parsed, model: json.model ?? model };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
