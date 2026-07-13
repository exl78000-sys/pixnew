using Pixnew.Core;

namespace Pixnew.LLM
{
    /// <summary>One prompt template per LlmKind. Templates are deterministic and provider-neutral.</summary>
    public static class LlmPrompts
    {
        public static LlmPrompt Build(LlmKind kind, LlmPromptContext context)
        {
            context ??= new LlmPromptContext();
            return kind switch
            {
                LlmKind.TalkIntent => TalkIntent(context),
                LlmKind.DialogueTurn => DialogueTurn(context),
                _ => Stub(kind, context)
            };
        }

        private static LlmPrompt TalkIntent(LlmPromptContext c) => new LlmPrompt(
            "Return only one JSON object. Decide whether this roommate should start a conversation.",
            $"speaker: {c.Get("speaker")}\ntarget: {c.Get("target")}\ncontext: {c.Get("context")}\nReturn {{\"talk\":true|false,\"topic\":\"short topic\"}}.");

        private static LlmPrompt DialogueTurn(LlmPromptContext c) => new LlmPrompt(
            "Return only one JSON object. Write one brief, in-character roommate dialogue turn.",
            $"speaker: {c.Get("speaker")}\nlistener: {c.Get("listener")}\nscene: {c.Get("context")}\nReturn {{\"speaker\":\"id\",\"text\":\"under 40 Chinese characters\",\"end\":true|false}}.");

        private static LlmPrompt Stub(LlmKind kind, LlmPromptContext c) => new LlmPrompt(
            "Return only one JSON object. This template is intentionally a P-06 stub.",
            $"kind: {kind}\ncontext: {c.Get("context")}\nReturn {{\"status\":\"stub\"}}.");
    }
}
