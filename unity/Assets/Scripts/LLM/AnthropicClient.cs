using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Pixnew.Core;
using UnityEngine;
using UnityEngine.Networking;

namespace Pixnew.LLM
{
    /// <summary>
    /// Anthropic Messages API 的最底層 HTTP 封裝(UnityWebRequest + coroutine)。
    /// 全專案只有 LlmRouter 可以呼叫這個類別。
    /// 職責:送請求、解析回應、token 記帳、每日花費保險絲、重試。
    /// </summary>
    public class AnthropicClient : MonoBehaviour
    {
        public const string ModelHaiku = "claude-haiku-4-5";
        public const string ModelSonnet = "claude-sonnet-5";

        // 每百萬 token 美元單價(2026-07;Sonnet 為優惠價,正式價 $3/$15)
        private static readonly Dictionary<string, (double inPrice, double outPrice)> Pricing = new()
        {
            { ModelHaiku, (1.0, 5.0) },
            { ModelSonnet, (2.0, 10.0) }
        };

        private const string Endpoint = "https://api.anthropic.com/v1/messages";
        private const int MaxRetries = 3;

        private GameConfig _config;

        // ── 記帳 ────────────────────────────────
        public long TotalInputTokens { get; private set; }
        public long TotalOutputTokens { get; private set; }
        public double TodaySpendUsd { get; private set; }
        public bool BudgetExceeded { get; private set; }

        /// <summary>當日花費超標時觸發(模擬層應暫停時鐘)</summary>
        public event Action<double, double> OnBudgetExceeded;

        public void Init(GameConfig config) => _config = config;

        /// <summary>每個模擬日呼叫一次,重置當日花費</summary>
        public void ResetDailySpend()
        {
            TodaySpendUsd = 0;
            BudgetExceeded = false;
        }

        /// <summary>
        /// 呼叫 Messages API,取回第一個 text block。
        /// mock 模式下不會走到這裡(由 LlmRouter 攔截)。
        /// </summary>
        public void Complete(
            string model, string systemPrompt, string userPrompt, int maxTokens,
            Action<string> onSuccess, Action<string> onError)
        {
            if (BudgetExceeded)
            {
                onError?.Invoke("當日 LLM 預算已用盡,呼叫被拒絕");
                return;
            }
            if (!_config.IsLive)
            {
                onError?.Invoke("非 live 模式或缺少 API key");
                return;
            }
            StartCoroutine(CompleteRoutine(model, systemPrompt, userPrompt, maxTokens, onSuccess, onError, 0));
        }

        private IEnumerator CompleteRoutine(
            string model, string systemPrompt, string userPrompt, int maxTokens,
            Action<string> onSuccess, Action<string> onError, int attempt)
        {
            var body = new JObject
            {
                ["model"] = model,
                ["max_tokens"] = maxTokens,
                ["system"] = systemPrompt,
                ["messages"] = new JArray
                {
                    new JObject { ["role"] = "user", ["content"] = userPrompt }
                }
            };

            string responseText;
            long status;
            bool connectionError;
            using (var req = new UnityWebRequest(Endpoint, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body.ToString(Formatting.None)));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.SetRequestHeader("x-api-key", _config.AnthropicApiKey);
                req.SetRequestHeader("anthropic-version", "2023-06-01");
                req.timeout = 60;

                yield return req.SendWebRequest();

                status = req.responseCode;
                connectionError = req.result == UnityWebRequest.Result.ConnectionError;
                responseText = req.downloadHandler.text;
            }

            bool retryable = status == 429 || status >= 500 || connectionError;

            if (status != 200)
            {
                if (retryable && attempt < MaxRetries)
                {
                    float backoff = Mathf.Pow(2, attempt + 1); // 2s, 4s, 8s
                    Debug.LogWarning($"[LLM] HTTP {status},{backoff}s 後重試({attempt + 1}/{MaxRetries})");
                    yield return new WaitForSecondsRealtime(backoff);
                    yield return CompleteRoutine(model, systemPrompt, userPrompt, maxTokens, onSuccess, onError, attempt + 1);
                    yield break;
                }
                onError?.Invoke($"HTTP {status}: {Truncate(responseText, 300)}");
                yield break;
            }

            JObject json;
            try { json = JObject.Parse(responseText); }
            catch (Exception e)
            {
                onError?.Invoke($"回應 JSON 解析失敗:{e.Message}");
                yield break;
            }

            RecordUsage(model, json["usage"]);

            string text = ExtractFirstText(json);
            if (text == null) onError?.Invoke($"回應無 text 內容(stop_reason={json["stop_reason"]})");
            else onSuccess?.Invoke(text);
        }

        private static string ExtractFirstText(JObject json)
        {
            if (json["content"] is not JArray content) return null;
            foreach (var block in content)
                if ((string)block["type"] == "text")
                    return (string)block["text"];
            return null;
        }

        private void RecordUsage(string model, JToken usage)
        {
            if (usage == null) return;
            long inTok = (long?)usage["input_tokens"] ?? 0;
            long outTok = (long?)usage["output_tokens"] ?? 0;
            TotalInputTokens += inTok;
            TotalOutputTokens += outTok;

            if (Pricing.TryGetValue(model, out var p))
                TodaySpendUsd += inTok * p.inPrice / 1e6 + outTok * p.outPrice / 1e6;

            if (!BudgetExceeded && TodaySpendUsd > _config.DailyBudgetUsd)
            {
                BudgetExceeded = true;
                Debug.LogWarning($"[LLM] 當日花費 ${TodaySpendUsd:F2} 超過上限 ${_config.DailyBudgetUsd:F2},保險絲觸發");
                OnBudgetExceeded?.Invoke(TodaySpendUsd, _config.DailyBudgetUsd);
            }
        }

        private static string Truncate(string s, int n) =>
            string.IsNullOrEmpty(s) ? "" : (s.Length <= n ? s : s.Substring(0, n) + "…");
    }
}
