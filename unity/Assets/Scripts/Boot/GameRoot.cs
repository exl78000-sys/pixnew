using System;
using System.Collections.Generic;
using Pixnew.Agents;
using Pixnew.Core;
using Pixnew.LLM;
using Pixnew.Sim;
using Pixnew.View;
using UnityEngine;

namespace Pixnew.Boot
{
    public class GameRoot : MonoBehaviour
    {
        public const ulong DefaultWorldSeed = 20260713UL;

        public SimClock Clock { get; private set; }
        public LlmRouter Router { get; private set; }
        public IReadOnlyList<Persona> Cast { get; private set; }
        public IReadOnlyDictionary<string, AgentVariableState> CharacterStates => _characterStates;
        public WorldGrid Grid => _scene != null ? _scene.Grid : null;
        private ApartmentScene _scene;
        private readonly Dictionary<string, AgentVariableState> _characterStates = new();
        private readonly AgentVariableSystem _variableSystem = new();

        private void Awake() => EnsureInitialized();

        // Unity 在 Play Mode 中重新編譯腳本時，非序列化的純 C# 狀態會被清空。
        // OnEnable 會在 domain reload 後再次呼叫，讓時鐘、角色變數與 Router 自動復原。
        private void OnEnable() => EnsureInitialized();

        private void EnsureInitialized()
        {
            if (Clock != null && Router != null && Cast != null) return;
            _scene = GetComponent<ApartmentScene>();
            Clock = new SimClock();
            Cast = new PersonaGenerator().GenerateSix(DefaultWorldSeed, new DateTime(2026, 7, 13));
            _characterStates.Clear();
            foreach (Persona persona in Cast)
                _characterStates[persona.Id] = new AgentVariableState
                {
                    LastUpdateMinute = Clock.SimTime,
                    LastDecisionMinute = Clock.SimTime
            };
            Clock.OnTick += UpdateCharacterVariables;
            Router = GetComponent<LlmRouter>();
            if (Router == null) Router = gameObject.AddComponent<LlmRouter>();
            Router.Init(GameConfig.Load());
        }
        private void Start() { Hud.Create(this); DayNightTint.Create(this); }
        private void Update()
        {
            Clock.Advance(Time.deltaTime);
            RoommateView.CellsPerSecond = Clock.Speed / SimClock.RealSecondsPerSimMinute;
            if (Input.GetKeyDown(KeyCode.Space)) Clock.SetSpeed(Clock.Speed == 0 ? 1 : 0);
            if (Input.GetKeyDown(KeyCode.Alpha1)) Clock.SetSpeed(1);
            if (Input.GetKeyDown(KeyCode.Alpha2)) Clock.SetSpeed(4);
            if (Input.GetKeyDown(KeyCode.Alpha3)) Clock.SetSpeed(16);
        }

        public CharacterContextSnapshot BuildCharacterSnapshot(string personaId, string currentAction)
        {
            Persona persona = null;
            foreach (Persona candidate in Cast)
                if (candidate.Id == personaId) { persona = candidate; break; }
            if (persona == null || !_characterStates.TryGetValue(personaId, out AgentVariableState state)) return null;
            return CharacterContextSnapshot.Create(persona, state, currentAction, Clock.SimTime);
        }

        private void UpdateCharacterVariables(long simMinute)
        {
            if (simMinute % AgentVariableSystem.UpdateIntervalMinutes != 0) return;
            foreach (Persona persona in Cast)
                _variableSystem.AdvanceTo(_characterStates[persona.Id], persona.Traits, AgentActivity.Idle, simMinute);
        }
    }
}
