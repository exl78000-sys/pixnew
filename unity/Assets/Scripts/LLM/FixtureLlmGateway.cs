using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using Pixnew.Core;

namespace Pixnew.LLM
{
    /// <summary>Replays <c>StreamingAssets/fixtures/&lt;kind&gt;.json</c>; never performs network I/O.</summary>
    public sealed class FixtureLlmGateway : ILlmGateway
    {
        private readonly string _fixtureDirectory;
        private const int MaxAttempts = 2;

        public FixtureLlmGateway(string fixtureDirectory) => _fixtureDirectory = fixtureDirectory ?? throw new ArgumentNullException(nameof(fixtureDirectory));

        public async Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken cancellationToken = default)
        {
            Exception lastError = null;
            for (int attempt = 1; attempt <= MaxAttempts; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    string path = Path.Combine(_fixtureDirectory, ToFixtureName(request.Kind));
                    string raw = await Task.Run(() => File.ReadAllText(path), cancellationToken);
                    return LlmJson.Parse(raw, attempt);
                }
                catch (Exception e) when (e is IOException || e is Newtonsoft.Json.JsonException || e is FormatException)
                {
                    lastError = e;
                }
            }
            throw new InvalidOperationException($"Fixture replay failed for {request.Kind} after {MaxAttempts} attempts.", lastError);
        }

        public static string ToFixtureName(LlmKind kind) => kind.ToString().ToLowerInvariant() + ".json";
    }

    /// <summary>Deterministic in-memory gateway for EditMode tests and future agent systems.</summary>
    public sealed class FakeLlmGateway : ILlmGateway
    {
        private readonly Queue<string> _responses;

        public FakeLlmGateway(params string[] responses) => _responses = new Queue<string>(responses ?? Array.Empty<string>());

        public Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken cancellationToken = default)
        {
            Exception lastError = null;
            for (int attempt = 1; attempt <= 2; attempt++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (_responses.Count == 0) throw new InvalidOperationException("FakeLlmGateway has no queued response.", lastError);
                try { return Task.FromResult(LlmJson.Parse(_responses.Dequeue(), attempt)); }
                catch (Exception e) when (e is Newtonsoft.Json.JsonException || e is FormatException) { lastError = e; }
            }
            throw new InvalidOperationException($"Fake LLM response was invalid after 2 attempts for {request.Kind}.", lastError);
        }
    }

    public static class LlmJson
    {
        private static readonly Regex Fence = new Regex(@"^\s*```(?:json)?\s*|\s*```\s*$", RegexOptions.IgnoreCase);

        public static LlmResult Parse(string raw, int attempts = 1)
        {
            if (string.IsNullOrWhiteSpace(raw)) throw new FormatException("LLM response is empty.");
            string json = Fence.Replace(raw, "").Trim();
            JObject document = JObject.Parse(json);
            return new LlmResult(document.ToString(Newtonsoft.Json.Formatting.None), document, attempts);
        }
    }
}
