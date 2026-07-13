using Pixnew.Core;
using Pixnew.LLM;
using Pixnew.Sim;
using Pixnew.View;
using UnityEngine;

namespace Pixnew.Boot
{
    public class GameRoot : MonoBehaviour
    {
        public SimClock Clock { get; private set; }
        public LlmRouter Router { get; private set; }
        public WorldGrid Grid => _scene != null ? _scene.Grid : null;
        private ApartmentScene _scene;
        private void Awake()
        {
            _scene = GetComponent<ApartmentScene>();
            Clock = new SimClock();
            Router = gameObject.AddComponent<LlmRouter>();
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
    }
}
