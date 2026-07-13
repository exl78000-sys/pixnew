using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;

namespace Pixnew.LLM
{
    [Serializable]
    public sealed class LlmUsageLedger
    {
        [Serializable] private sealed class Data { public int FixtureCalls; public int Retries; public string UpdatedUtc; }
        private readonly string _path;
        private Data _data = new Data();

        public LlmUsageLedger(string path) => _path = path;
        public int FixtureCalls => _data.FixtureCalls;
        public int Retries => _data.Retries;

        public void Load()
        {
            if (!File.Exists(_path)) return;
            _data = JsonConvert.DeserializeObject<Data>(File.ReadAllText(_path)) ?? new Data();
        }

        public void Record(LlmKind kind, int attempts)
        {
            _data.FixtureCalls++;
            _data.Retries += Math.Max(0, attempts - 1);
            _data.UpdatedUtc = DateTime.UtcNow.ToString("O");
            Directory.CreateDirectory(Path.GetDirectoryName(_path));
            File.WriteAllText(_path, JsonConvert.SerializeObject(_data, Formatting.Indented));
        }
    }
}
