using Pixnew.Core;
using Pixnew.LLM;
using Pixnew.Sim;
using Pixnew.View;
using UnityEngine;

namespace Pixnew.Boot
{
    /// <summary>
    /// 正式遊戲進入點(P-05,取代 Bootstrap):
    /// 組裝 SimClock、GameConfig、LlmRouter,Update 驅動時鐘;
    /// 啟動時建 Hud(uGUI)與日夜疊色。
    /// 由公寓場景產生器掛在 ApartmentRoot 上(與 ApartmentScene 同物件)。
    /// </summary>
    public class GameRoot : MonoBehaviour
    {
        /// <summary>模擬時鐘(全場唯一)</summary>
        public SimClock Clock { get; private set; }

        /// <summary>LLM 路由(全場唯一入口)</summary>
        public LlmRouter Router { get; private set; }

        /// <summary>邏輯網格(由 ApartmentScene 烘焙)</summary>
        public WorldGrid Grid => _scene != null ? _scene.Grid : null;

        private ApartmentScene _scene;

        private void Awake()
        {
            _scene = GetComponent<ApartmentScene>();

            var config = GameConfig.Load();
            Clock = new SimClock();

            Router = gameObject.AddComponent<LlmRouter>();
            Router.Init(config);
            Router.Client.OnBudgetExceeded += (_, _) => Clock.SetSpeed(0); // 保險絲:超支即暫停
            Clock.OnNewDay += _ => Router.Client.ResetDailySpend();
        }

        private void Start()
        {
            Hud.Create(this);
            DayNightTint.Create(this);
        }

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
