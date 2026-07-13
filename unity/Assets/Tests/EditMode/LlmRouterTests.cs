using System.Collections.Generic;
using System.IO;
using NUnit.Framework;
using Pixnew.Core;
using Pixnew.LLM;

namespace Pixnew.Tests
{
    public class LlmRouterTests
    {
        [Test]
        public async System.Threading.Tasks.Task FixtureGateway_ReplaysTalkIntentAndDialogueTurn()
        {
            string directory = Path.Combine(Path.GetTempPath(), "pixnew-fixture-tests-" + System.Guid.NewGuid());
            Directory.CreateDirectory(directory);
            File.WriteAllText(Path.Combine(directory, "talkintent.json"), "{\"talk\":true,\"topic\":\"tea\"}");
            File.WriteAllText(Path.Combine(directory, "dialogueturn.json"), "{\"speaker\":\"a\",\"text\":\"hi\",\"end\":false}");
            var gateway = new FixtureLlmGateway(directory);
            var intent = await gateway.CompleteAsync(new LlmRequest(LlmKind.TalkIntent, new LlmPrompt("s", "u")));
            var turn = await gateway.CompleteAsync(new LlmRequest(LlmKind.DialogueTurn, new LlmPrompt("s", "u")));
            Assert.That(intent.Json, Does.Contain("\"talk\":true"));
            Assert.That(turn.Json, Does.Contain("\"speaker\":\"a\""));
        }

        [Test]
        public void JsonParser_StripsMarkdownFence()
        {
            var result = LlmJson.Parse("```json\n{\"talk\":false,\"topic\":\"\"}\n```");
            Assert.That(result.Json, Does.Contain("\"talk\":false"));
        }

        [Test]
        public async System.Threading.Tasks.Task FakeGateway_RetriesOnceAfterMalformedJson()
        {
            var gateway = new FakeLlmGateway("not json", "{\"talk\":true,\"topic\":\"tea\"}");
            var result = await gateway.CompleteAsync(new LlmRequest(LlmKind.TalkIntent, new LlmPrompt("s", "u")));
            Assert.AreEqual(2, result.Attempts);
            Assert.That(result.Json, Does.Contain("\"talk\":true"));
        }

        [Test]
        public void PromptTemplates_ProvideTalkAndDialogueContracts()
        {
            var context = new LlmPromptContext(new Dictionary<string, string> { { "speaker", "amei" }, { "target", "bob" } });
            Assert.That(LlmPrompts.Build(LlmKind.TalkIntent, context).User, Does.Contain("talk"));
            Assert.That(LlmPrompts.Build(LlmKind.DialogueTurn, context).User, Does.Contain("speaker"));
        }
    }
}
