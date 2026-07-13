using System;

namespace Pixnew.Core
{
    /// <summary>
    /// 模擬時鐘(純 C#,可單元測試)。
    /// 1 tick = 1 模擬分鐘;預設現實 2 秒 = 1 模擬分鐘(1x)。
    /// 由 Bootstrap 的 Update 以真實 deltaTime 驅動。
    /// </summary>
    public class SimClock
    {
        /// <summary>1x 速度下,幾秒現實時間 = 1 模擬分鐘</summary>
        public const float RealSecondsPerSimMinute = 2f;

        /// <summary>自模擬開始累計的模擬分鐘數</summary>
        public long SimTime { get; private set; }

        /// <summary>0 = 暫停,1 / 4 / 16 = 倍速</summary>
        public int Speed { get; private set; } = 1;

        public int Day => (int)(SimTime / 1440) + 1;

        public string Hhmm
        {
            get
            {
                long m = SimTime % 1440;
                return $"{m / 60:00}:{m % 60:00}";
            }
        }

        /// <summary>每過 1 模擬分鐘觸發一次(參數為新的 SimTime)</summary>
        public event Action<long> OnTick;

        /// <summary>跨到新的一天時觸發(參數為新的 Day)</summary>
        public event Action<int> OnNewDay;

        private float _accumulator;

        public SimClock(long startSimTime = 7 * 60) // 預設從第 1 天 07:00 開始
        {
            SimTime = startSimTime;
        }

        public void SetSpeed(int speed)
        {
            if (speed is 0 or 1 or 4 or 16) Speed = speed;
        }

        /// <summary>由遊戲迴圈以真實 deltaTime(秒)呼叫</summary>
        public void Advance(float realDeltaSeconds)
        {
            if (Speed == 0) return;
            _accumulator += realDeltaSeconds * Speed / RealSecondsPerSimMinute;
            while (_accumulator >= 1f)
            {
                _accumulator -= 1f;
                SimTime++;
                OnTick?.Invoke(SimTime);
                if (SimTime % 1440 == 0) OnNewDay?.Invoke(Day);
            }
        }
    }
}
