using System;
using Pixnew.Core;
using UnityEngine;

namespace Pixnew.LLM
{
    /// <summary>LLM 呼叫類型 → 決定路由到哪個模型與哪個提示詞模板</summary>
    public enum LlmKind
    {
        ActionDecision, // Haiku:每 30 模擬分的行動決策
        TalkIntent,     // Haiku:相遇時是否交談
        DialogueTurn,   // Sonnet:對話逐輪生成
        DailyPlan,      // Sonnet:每日日程規劃
        Reflection,     // Sonnet:反思
        WeeklyRecap     // Sonnet:週報剪輯
    }

    /// <summary>
    /// 全專案唯一的 LLM 呼叫入口。
    /// 職責:分層路由(Haiku/Sonnet)、mock 模式攔截、之後掛提示詞模板(M1-T4 之後逐步填入)。
    /// </summary>
    public class LlmRouter : MonoBehaviour
    {
        private AnthropicClient _client;
        private GameConfig _config;

        public AnthropicClient Client => _client;

        public void Init(GameConfig config)
        {
            _config = config;
            _client = gameObject.AddComponent<AnthropicClient>();
            _client.Init(config);
        }

        public static string ModelFor(LlmKind kind) => kind switch
        {
            LlmKind.ActionDecision => AnthropicClient.ModelHaiku,
            LlmKind.TalkIntent => AnthropicClient.ModelHaiku,
            _ => AnthropicClient.ModelSonnet
        };

        private static int MaxTokensFor(LlmKind kind) => kind switch
        {
            LlmKind.ActionDecision => 300,
            LlmKind.TalkIntent => 150,
            LlmKind.DialogueTurn => 400,
            LlmKind.DailyPlan => 1500,
            LlmKind.Reflection => 1000,
            LlmKind.WeeklyRecap => 2500,
            _ => 500
        };

        /// <summary>
        /// 路由一次 LLM 呼叫。mock 模式回傳固定假資料(零成本,供測試與 CI)。
        /// </summary>
        public void Route(LlmKind kind, string systemPrompt, string userPrompt,
            Action<string> onSuccess, Action<string> onError)
        {
            if (!_config.IsLive)
            {
                onSuccess?.Invoke(MockResponse(kind));
                return;
            }
            _client.Complete(ModelFor(kind), systemPrompt, userPrompt, MaxTokensFor(kind), onSuccess, onError);
        }

        /// <summary>mock 回應(M1-T4 會改為從 StreamingAssets/fixtures 回放)</summary>
        private static string MockResponse(LlmKind kind) => kind switch
        {
            LlmKind.TalkIntent => "{\"talk\":true,\"topic\":\"昨晚的恐怖片\"}",
            LlmKind.DialogueTurn => "{\"speaker\":\"amei\",\"text\":\"欸,你昨天是不是又偷吃我的布丁?\",\"end\":false}",
            _ => "{\"mock\":true}"
        };
    }
}
