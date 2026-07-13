using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using Pixnew.LLM;

namespace Pixnew.Core
{
    /// <summary>Provider-independent, Unity-free seam used by agents and tests.</summary>
    public interface ILlmGateway
    {
        Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken cancellationToken = default);
    }

    public sealed class LlmPrompt
    {
        public LlmPrompt(string system, string user) { System = system ?? ""; User = user ?? ""; }
        public string System { get; }
        public string User { get; }
    }

    public sealed class LlmRequest
    {
        public LlmRequest(LlmKind kind, LlmPrompt prompt) { Kind = kind; Prompt = prompt ?? throw new ArgumentNullException(nameof(prompt)); }
        public LlmKind Kind { get; }
        public LlmPrompt Prompt { get; }
    }

    public sealed class LlmResult
    {
        public LlmResult(string json, JObject document, int attempts) { Json = json; Document = document; Attempts = attempts; }
        public string Json { get; }
        public JObject Document { get; }
        public int Attempts { get; }
    }

    public sealed class LlmPromptContext
    {
        public LlmPromptContext(IDictionary<string, string> values = null) => Values = values ?? new Dictionary<string, string>();
        public IDictionary<string, string> Values { get; }
        public string Get(string key, string fallback = "") => Values.TryGetValue(key, out var value) ? value : fallback;
    }
}
