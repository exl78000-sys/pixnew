using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Pixnew.Core;
using UnityEngine;

namespace Pixnew.LLM
{
    public enum LlmKind
    {
        ActionDecision,
        TalkIntent,
        DialogueTurn,
        DailyPlan,
        Reflection,
        WeeklyRecap
    }

    /// <summary>
    /// Unity-facing adapter for the pure-C# LLM gateway.  P-06 deliberately
    /// replays checked-in fixtures only; it does not call a provider API.
    /// </summary>
    public class LlmRouter : MonoBehaviour
    {
        private ILlmGateway _gateway;
        private LlmUsageLedger _ledger;
        private AnthropicClient _client;

        public ILlmGateway Gateway => _gateway;
        public LlmUsageLedger Ledger => _ledger;
        /// <summary>Legacy diagnostics only; RouteAsync never delegates to this client in P-06.</summary>
        public AnthropicClient Client => _client;

        public void Init(GameConfig config)
        {
            string fixtureDirectory = Path.Combine(Application.streamingAssetsPath, "fixtures");
            _gateway = new FixtureLlmGateway(fixtureDirectory);
            _ledger = new LlmUsageLedger(Path.Combine(Application.persistentDataPath, "ledger.json"));
            _ledger.Load();
            if (_client == null) _client = GetComponent<AnthropicClient>();
            if (_client == null) _client = gameObject.AddComponent<AnthropicClient>();
            _client.Init(config);

            if (config != null && config.IsLive)
                Debug.LogWarning("[LLM] Live API is deferred by the producer decision; fixture replay remains active.");
        }

        public Task<LlmResult> RouteAsync(LlmKind kind, LlmPrompt prompt, CancellationToken cancellationToken = default)
        {
            if (_gateway == null) throw new InvalidOperationException("LlmRouter.Init must be called before routing.");
            return RouteAndRecordAsync(kind, prompt, cancellationToken);
        }

        public void Route(LlmKind kind, string systemPrompt, string userPrompt, Action<string> onSuccess, Action<string> onError)
        {
            var task = RouteAsync(kind, new LlmPrompt(systemPrompt, userPrompt));
            task.ContinueWith(t =>
            {
                if (t.IsCanceled) { onError?.Invoke("LLM request cancelled."); return; }
                if (t.IsFaulted) { onError?.Invoke(t.Exception.GetBaseException().Message); return; }
                onSuccess?.Invoke(t.Result.Json);
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        private async Task<LlmResult> RouteAndRecordAsync(LlmKind kind, LlmPrompt prompt, CancellationToken cancellationToken)
        {
            LlmResult result = await _gateway.CompleteAsync(new LlmRequest(kind, prompt), cancellationToken);
            _ledger.Record(kind, result.Attempts);
            return result;
        }
    }
}
