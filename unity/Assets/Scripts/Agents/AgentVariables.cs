using System;
using Newtonsoft.Json;

namespace Pixnew.Agents
{
    public enum AgentActivity { Idle, Sleeping, Eating, Showering, Talking, Entertainment, Working }

    /// <summary>會隨模擬時間、行動與事件改變的角色狀態。</summary>
    [Serializable]
    public class AgentVariableState
    {
        [JsonProperty("energy")] public float Energy = 80f;
        [JsonProperty("satiety")] public float Satiety = 70f;
        [JsonProperty("hygiene")] public float Hygiene = 80f;
        [JsonProperty("social")] public float Social = 65f;
        [JsonProperty("fun")] public float Fun = 60f;
        [JsonProperty("stress")] public float Stress = 20f;
        [JsonProperty("mood")] public float Mood = 10f;
        [JsonProperty("last_update_minute")] public long LastUpdateMinute;
        [JsonProperty("last_decision_minute")] public long LastDecisionMinute;
    }

    /// <summary>每 10 模擬分鐘更新需求；每 30 分鐘提供一次行動決策機會。</summary>
    public sealed class AgentVariableSystem
    {
        public const int UpdateIntervalMinutes = 10;
        public const int DecisionIntervalMinutes = 30;

        public void AdvanceTo(AgentVariableState state, PersonalityTraits traits, AgentActivity activity, long targetSimMinute)
        {
            if (state == null) throw new ArgumentNullException(nameof(state));
            if (traits == null) throw new ArgumentNullException(nameof(traits));
            if (targetSimMinute < state.LastUpdateMinute) throw new ArgumentOutOfRangeException(nameof(targetSimMinute));

            while (state.LastUpdateMinute + UpdateIntervalMinutes <= targetSimMinute)
            {
                state.LastUpdateMinute += UpdateIntervalMinutes;
                ApplyInterval(state, traits, activity);
            }
        }

        public bool IsDecisionDue(AgentVariableState state, long simMinute) =>
            simMinute - state.LastDecisionMinute >= DecisionIntervalMinutes;

        public void MarkDecision(AgentVariableState state, long simMinute) => state.LastDecisionMinute = simMinute;

        public void ApplyEvent(AgentVariableState state, float moodDelta, float stressDelta, float socialDelta = 0f)
        {
            state.Mood = Clamp(state.Mood + moodDelta, -100f, 100f);
            state.Stress = Clamp(state.Stress + stressDelta, 0f, 100f);
            state.Social = Clamp(state.Social + socialDelta, 0f, 100f);
        }

        private static void ApplyInterval(AgentVariableState s, PersonalityTraits t, AgentActivity activity)
        {
            s.Satiety -= activity == AgentActivity.Eating ? -9f : 0.8f;
            s.Hygiene -= activity == AgentActivity.Showering ? -12f : 0.25f;
            s.Energy += activity == AgentActivity.Sleeping ? 4f : -0.5f;
            s.Social += activity == AgentActivity.Talking ? 5f : -(0.25f + t.Sociability / 200f);
            s.Fun += activity == AgentActivity.Entertainment ? 5f : -(0.2f + t.NoveltySeeking / 250f);

            if (activity == AgentActivity.Working) s.Stress += 0.8f;
            if (activity is AgentActivity.Sleeping or AgentActivity.Entertainment) s.Stress -= 0.7f;
            if (s.Energy < 25f || s.Satiety < 25f || s.Social < 20f) s.Stress += 0.8f;

            // 短期情緒逐步回到中性；抗壓越高，負面情緒恢復越快。
            float recovery = 0.15f + t.Resilience / 500f;
            s.Mood = MoveTowards(s.Mood, 0f, recovery);

            s.Energy = Clamp(s.Energy, 0f, 100f);
            s.Satiety = Clamp(s.Satiety, 0f, 100f);
            s.Hygiene = Clamp(s.Hygiene, 0f, 100f);
            s.Social = Clamp(s.Social, 0f, 100f);
            s.Fun = Clamp(s.Fun, 0f, 100f);
            s.Stress = Clamp(s.Stress, 0f, 100f);
        }

        private static float Clamp(float value, float min, float max) => Math.Min(max, Math.Max(min, value));
        private static float MoveTowards(float value, float target, float delta) =>
            value < target ? Math.Min(value + delta, target) : Math.Max(value - delta, target);
    }

    /// <summary>未來送進 LlmRouter 的唯讀角色資料；API 不得直接修改模擬狀態。</summary>
    [Serializable]
    public sealed class CharacterContextSnapshot
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("name")] public string Name;
        [JsonProperty("age")] public int Age;
        [JsonProperty("personality")] public string Personality;
        [JsonProperty("speech_style")] public string SpeechStyle;
        [JsonProperty("traits")] public PersonalityTraits Traits;
        [JsonProperty("needs")] public AgentVariableState Needs;
        [JsonProperty("current_action")] public string CurrentAction;
        [JsonProperty("sim_minute")] public long SimMinute;

        public static CharacterContextSnapshot Create(Persona persona, AgentVariableState state, string currentAction, long simMinute)
        {
            if (persona == null) throw new ArgumentNullException(nameof(persona));
            if (state == null) throw new ArgumentNullException(nameof(state));
            return new CharacterContextSnapshot
            {
                Id = persona.Id,
                Name = persona.Name,
                Age = persona.Age,
                Personality = persona.Personality,
                SpeechStyle = persona.SpeechStyle,
                Traits = CopyTraits(persona.Traits),
                Needs = CopyState(state),
                CurrentAction = currentAction ?? "",
                SimMinute = simMinute
            };
        }

        private static PersonalityTraits CopyTraits(PersonalityTraits source) => source == null ? null : new PersonalityTraits
        {
            Sociability = source.Sociability, TrustSpeed = source.TrustSpeed,
            EmotionalExpression = source.EmotionalExpression, Empathy = source.Empathy,
            Orderliness = source.Orderliness, NoveltySeeking = source.NoveltySeeking,
            RomanticInitiative = source.RomanticInitiative, AttachmentNeed = source.AttachmentNeed,
            JealousySensitivity = source.JealousySensitivity, ConflictTendency = source.ConflictTendency,
            Honesty = source.Honesty, Resilience = source.Resilience
        };

        private static AgentVariableState CopyState(AgentVariableState source) => new AgentVariableState
        {
            Energy = source.Energy, Satiety = source.Satiety, Hygiene = source.Hygiene,
            Social = source.Social, Fun = source.Fun, Stress = source.Stress, Mood = source.Mood,
            LastUpdateMinute = source.LastUpdateMinute, LastDecisionMinute = source.LastDecisionMinute
        };
    }
}
