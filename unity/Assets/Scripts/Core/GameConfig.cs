using System;
using System.IO;
using Newtonsoft.Json;
using UnityEngine;

namespace Pixnew.Core
{
    /// <summary>
    /// 本機設定。從 StreamingAssets/config.json 載入(該檔不進版控)。
    /// 沒有設定檔時以 mock 模式啟動,遊戲仍可運行(不呼叫真實 API)。
    /// </summary>
    [Serializable]
    public class GameConfig
    {
        [JsonProperty("anthropicApiKey")] public string AnthropicApiKey = "";
        [JsonProperty("dailyBudgetUsd")] public double DailyBudgetUsd = 5.0;

        /// <summary>"live" = 真實呼叫 API;"mock" = 回放假資料(零成本)</summary>
        [JsonProperty("llmMode")] public string LlmMode = "mock";

        public bool IsLive => LlmMode == "live" && !string.IsNullOrEmpty(AnthropicApiKey);

        public static GameConfig Load()
        {
            string path = Path.Combine(Application.streamingAssetsPath, "config.json");
            if (!File.Exists(path))
            {
                Debug.LogWarning("[Config] 找不到 StreamingAssets/config.json,以 mock 模式啟動。" +
                                 "請複製 config.example.json 為 config.json 並填入 API key。");
                return new GameConfig();
            }
            try
            {
                var cfg = JsonConvert.DeserializeObject<GameConfig>(File.ReadAllText(path));
                Debug.Log($"[Config] 已載入設定,模式 = {cfg.LlmMode}");
                return cfg ?? new GameConfig();
            }
            catch (Exception e)
            {
                Debug.LogError($"[Config] config.json 解析失敗:{e.Message},以 mock 模式啟動。");
                return new GameConfig();
            }
        }
    }
}
