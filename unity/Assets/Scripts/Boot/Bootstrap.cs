using Pixnew.Core;
using Pixnew.LLM;
using UnityEngine;

namespace Pixnew.Boot
{
    /// <summary>
    /// M0 開機腳本 —— 專案唯一需要手動掛的元件。
    /// 用法:開任意場景 → 建空物件 → Add Component → Bootstrap → Play。
    /// 功能:模擬時鐘 + 速度控制 + LLM 連線測試 + 花費記帳板(全用 OnGUI,不需佈置場景)。
    /// M1 之後由 ApartmentScene 與正式 UI 取代。
    /// </summary>
    public class Bootstrap : MonoBehaviour
    {
        private GameConfig _config;
        private SimClock _clock;
        private LlmRouter _router;

        private string _llmTestResult = "(尚未測試)";
        private bool _llmTesting;
        private GUIStyle _title, _label, _small;
        private bool _stylesReady;

        private void Awake()
        {
            _config = GameConfig.Load();
            _clock = new SimClock();

            _router = gameObject.AddComponent<LlmRouter>();
            _router.Init(_config);
            _router.Client.OnBudgetExceeded += (_, _) => _clock.SetSpeed(0); // 保險絲:超支即暫停

            _clock.OnNewDay += _ => _router.Client.ResetDailySpend();

            if (Camera.main == null)
            {
                var cam = new GameObject("Main Camera").AddComponent<Camera>();
                cam.tag = "MainCamera";
                cam.orthographic = true;
                cam.backgroundColor = new Color(0.10f, 0.09f, 0.15f);
                cam.clearFlags = CameraClearFlags.SolidColor;
            }
        }

        private void Start()
        {
            TestLlm(); // 開機自動跑一次連線測試(mock 模式即時回應、零成本)
        }

        private void Update()
        {
            _clock.Advance(Time.deltaTime);

            // 鍵盤快捷:空白鍵暫停,1/2/3 = 1x/4x/16x
            if (Input.GetKeyDown(KeyCode.Space)) _clock.SetSpeed(_clock.Speed == 0 ? 1 : 0);
            if (Input.GetKeyDown(KeyCode.Alpha1)) _clock.SetSpeed(1);
            if (Input.GetKeyDown(KeyCode.Alpha2)) _clock.SetSpeed(4);
            if (Input.GetKeyDown(KeyCode.Alpha3)) _clock.SetSpeed(16);
        }

        private void EnsureStyles()
        {
            if (_stylesReady) return;
            _title = new GUIStyle(GUI.skin.label) { fontSize = 40, fontStyle = FontStyle.Bold };
            _title.normal.textColor = new Color(1f, 0.85f, 0.48f);
            _label = new GUIStyle(GUI.skin.label) { fontSize = 20 };
            _label.normal.textColor = Color.white;
            _small = new GUIStyle(GUI.skin.label) { fontSize = 14 };
            _small.normal.textColor = new Color(0.72f, 0.66f, 0.85f);
            _stylesReady = true;
        }

        private void OnGUI()
        {
            EnsureStyles();
            float w = Screen.width;

            GUI.Label(new Rect(0, 60, w, 60), "AI 魚缸公寓", CenterOf(_title));
            GUI.Label(new Rect(0, 115, w, 30), "6 個 AI 室友,劇本沒人寫。", CenterOf(_small));

            // ── 時鐘與速度 ──
            string speedLabel = _clock.Speed == 0 ? "⏸ 暫停" : $"{_clock.Speed}x";
            GUI.Label(new Rect(16, 12, 600, 30), $"第 {_clock.Day} 天  {_clock.Hhmm}  [{speedLabel}]", _label);

            GUILayout.BeginArea(new Rect(16, Screen.height - 56, 400, 44));
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("⏸", GUILayout.Width(56), GUILayout.Height(36))) _clock.SetSpeed(0);
            if (GUILayout.Button("1x", GUILayout.Width(56), GUILayout.Height(36))) _clock.SetSpeed(1);
            if (GUILayout.Button("4x", GUILayout.Width(56), GUILayout.Height(36))) _clock.SetSpeed(4);
            if (GUILayout.Button("16x", GUILayout.Width(56), GUILayout.Height(36))) _clock.SetSpeed(16);
            GUILayout.EndHorizontal();
            GUILayout.EndArea();

            // ── LLM 狀態與連線測試 ──
            var c = _router.Client;
            string mode = _config.IsLive ? "live" : "mock(未設定 API key 或 llmMode=mock)";
            GUI.Label(new Rect(16, 44, w - 32, 24),
                $"LLM 模式:{mode}|tokens in/out:{c.TotalInputTokens}/{c.TotalOutputTokens}|今日花費:${c.TodaySpendUsd:F4}",
                _small);

            GUI.Label(new Rect(16, 68, w - 32, 24), $"LLM 連線測試:{_llmTestResult}", _small);

            if (GUI.Button(new Rect(16, Screen.height - 110, 180, 40), _llmTesting ? "測試中…" : "重測 LLM 連線"))
            {
                TestLlm();
            }
        }

        private void TestLlm()
        {
            if (_llmTesting) return;
            _llmTesting = true;
            _llmTestResult = "呼叫中…";
            _router.Route(
                LlmKind.TalkIntent,
                "你是連線測試。只回傳 JSON。",
                "回傳 {\"talk\":true,\"topic\":\"連線測試成功\"}",
                ok => { _llmTestResult = $"✅ 回應:{ok}"; _llmTesting = false; },
                err => { _llmTestResult = $"❌ {err}"; _llmTesting = false; });
        }

        private GUIStyle CenterOf(GUIStyle baseStyle)
        {
            var s = new GUIStyle(baseStyle) { alignment = TextAnchor.MiddleCenter };
            return s;
        }
    }
}
