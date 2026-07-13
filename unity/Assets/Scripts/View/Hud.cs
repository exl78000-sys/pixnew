using Pixnew.Boot;
using UnityEngine;
using UnityEngine.UI;

namespace Pixnew.View
{
    public class Hud : MonoBehaviour
    {
        private GameRoot _root;
        private Text _clockText;
        private Text _llmText;
        private Font _font;

        public static Hud Create(GameRoot root)
        {
            var go = new GameObject("Hud", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            var canvas = go.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            var scaler = go.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1600, 900);
            var hud = go.AddComponent<Hud>();
            hud._root = root;
            hud._font = Resources.Load<Font>("Fonts/Cubic_11");
            hud.BuildUi();
            if (Object.FindFirstObjectByType<UnityEngine.EventSystems.EventSystem>() == null)
                new GameObject("EventSystem", typeof(UnityEngine.EventSystems.EventSystem), typeof(UnityEngine.EventSystems.StandaloneInputModule));
            return hud;
        }

        private void BuildUi()
        {
            _clockText = MakeText("Clock", new Vector2(16, -12), 30, TextAnchor.UpperLeft);
            _llmText = MakeText("Llm", new Vector2(16, -50), 18, TextAnchor.UpperLeft);
            _llmText.color = new Color(0.75f, 0.7f, 0.9f);
            string[] labels = { "Pause", "1x", "4x", "16x" };
            int[] speeds = { 0, 1, 4, 16 };
            for (int i = 0; i < labels.Length; i++)
            {
                int speed = speeds[i];
                MakeButton(labels[i], new Vector2(16 + i * 64, 16), () => _root.Clock.SetSpeed(speed));
            }
        }

        private void Update()
        {
            var clock = _root.Clock;
            string speed = clock.Speed == 0 ? "Paused" : $"{clock.Speed}x";
            _clockText.text = $"Day {clock.Day} {clock.Hhmm} [{speed}]";
            var ledger = _root.Router.Ledger;
            _llmText.text = $"LLM fixture replay {ledger.FixtureCalls} | retries {ledger.Retries}";
        }

        private Text MakeText(string name, Vector2 offset, int size, TextAnchor anchor)
        {
            var go = new GameObject(name, typeof(Text)); go.transform.SetParent(transform, false);
            var rt = (RectTransform)go.transform; rt.anchorMin = rt.anchorMax = new Vector2(0, 1); rt.pivot = new Vector2(0, 1); rt.anchoredPosition = offset; rt.sizeDelta = new Vector2(700, 40);
            var text = go.GetComponent<Text>(); text.font = _font; text.fontSize = size; text.alignment = anchor; text.color = Color.white; return text;
        }

        private void MakeButton(string label, Vector2 offset, UnityEngine.Events.UnityAction onClick)
        {
            var go = new GameObject($"Btn_{label}", typeof(Image), typeof(Button)); go.transform.SetParent(transform, false);
            var rt = (RectTransform)go.transform; rt.anchorMin = rt.anchorMax = Vector2.zero; rt.pivot = Vector2.zero; rt.anchoredPosition = offset; rt.sizeDelta = new Vector2(56, 40);
            go.GetComponent<Image>().color = new Color(0.18f, 0.16f, 0.28f, 0.9f); go.GetComponent<Button>().onClick.AddListener(onClick);
            var textGo = new GameObject("Text", typeof(Text)); textGo.transform.SetParent(go.transform, false);
            var trt = (RectTransform)textGo.transform; trt.anchorMin = Vector2.zero; trt.anchorMax = Vector2.one; trt.sizeDelta = Vector2.zero;
            var text = textGo.GetComponent<Text>(); text.font = _font; text.fontSize = 20; text.alignment = TextAnchor.MiddleCenter; text.color = Color.white; text.text = label;
        }
    }
}
