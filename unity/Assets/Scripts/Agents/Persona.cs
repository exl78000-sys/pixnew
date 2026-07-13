using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Pixnew.Agents
{
    /// <summary>
    /// 室友人設。對應 StreamingAssets/content/personas/*.json。
    /// 由製作人撰寫;程式只讀不寫。
    /// </summary>
    [Serializable]
    public class Persona
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("name")] public string Name;
        [JsonProperty("age")] public int Age;
        [JsonProperty("job")] public string Job;
        [JsonProperty("personality")] public string Personality;
        [JsonProperty("speech_style")] public string SpeechStyle;
        [JsonProperty("likes")] public List<string> Likes = new();
        [JsonProperty("dislikes")] public List<string> Dislikes = new();
        [JsonProperty("secret")] public string Secret;
        [JsonProperty("fixed_schedule")] public List<ScheduleItem> FixedSchedule = new();
    }

    [Serializable]
    public class ScheduleItem
    {
        [JsonProperty("hhmm")] public string Hhmm;      // "0930"
        [JsonProperty("action")] public string Action;  // 繁中動作名,如「做早餐」
        [JsonProperty("object")] public string Object;  // 地圖物件點位 id,如 "stove"
    }
}
