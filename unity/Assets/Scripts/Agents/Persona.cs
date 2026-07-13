using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Pixnew.Agents
{
    /// <summary>
    /// 室友人設。可由 StreamingAssets/content/personas/*.json 載入，
    /// 或由 PersonaGenerator 依存檔種子建立。
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
        [JsonProperty("generation_seed")] public ulong GenerationSeed;
        [JsonProperty("birth")] public BirthProfile Birth;
        [JsonProperty("ziwei_seed")] public ZiWeiSeedProfile ZiWeiSeed;
        [JsonProperty("traits")] public PersonalityTraits Traits;
        [JsonProperty("fixed_schedule")] public List<ScheduleItem> FixedSchedule = new();
    }

    [Serializable]
    public class BirthProfile
    {
        [JsonProperty("solar_date")] public string SolarDate;
        [JsonProperty("birth_time")] public string BirthTime;
        [JsonProperty("age_at_start")] public int AgeAtStart;
        [JsonProperty("chart_sex")] public string ChartSex;
        [JsonProperty("western_zodiac")] public string WesternZodiac;
        [JsonProperty("chinese_zodiac")] public string ChineseZodiac;
        [JsonProperty("lunar_year")] public int LunarYear;
        [JsonProperty("lunar_month")] public int LunarMonth;
        [JsonProperty("lunar_day")] public int LunarDay;
        [JsonProperty("is_leap_month")] public bool IsLeapMonth;
        [JsonProperty("shichen_index")] public int ShichenIndex;
        [JsonProperty("shichen")] public string Shichen;
    }

    [Serializable]
    public class ZiWeiSeedProfile
    {
        public const string CurrentRuleVersion = "pixnew-ziwei-seed-v1";

        [JsonProperty("rule_version")] public string RuleVersion = CurrentRuleVersion;
        [JsonProperty("life_palace")] public string LifePalace;
        [JsonProperty("body_palace")] public string BodyPalace;
        [JsonProperty("five_elements_bureau")] public string FiveElementsBureau;
        [JsonProperty("bureau_number")] public int BureauNumber;
    }

    /// <summary>0~100 的初始性格傾向；後續事件只能影響狀態與關係，不直接改寫人格。</summary>
    [Serializable]
    public class PersonalityTraits
    {
        [JsonProperty("sociability")] public int Sociability;
        [JsonProperty("trust_speed")] public int TrustSpeed;
        [JsonProperty("emotional_expression")] public int EmotionalExpression;
        [JsonProperty("empathy")] public int Empathy;
        [JsonProperty("orderliness")] public int Orderliness;
        [JsonProperty("novelty_seeking")] public int NoveltySeeking;
        [JsonProperty("romantic_initiative")] public int RomanticInitiative;
        [JsonProperty("attachment_need")] public int AttachmentNeed;
        [JsonProperty("jealousy_sensitivity")] public int JealousySensitivity;
        [JsonProperty("conflict_tendency")] public int ConflictTendency;
        [JsonProperty("honesty")] public int Honesty;
        [JsonProperty("resilience")] public int Resilience;
    }

    [Serializable]
    public class ScheduleItem
    {
        [JsonProperty("hhmm")] public string Hhmm;      // "0930"
        [JsonProperty("action")] public string Action;  // 繁中動作名,如「做早餐」
        [JsonProperty("object")] public string Object;  // 地圖物件點位 id,如 "stove"
    }
}
