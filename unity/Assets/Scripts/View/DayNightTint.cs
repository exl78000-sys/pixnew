using Pixnew.Boot;
using UnityEngine;

namespace Pixnew.View
{
    /// <summary>
    /// 日夜疊色(P-05):全場景一張半透明色片,顏色隨模擬時刻在關鍵幀間內插。
    /// 深夜偏暗藍、清晨/黃昏偏橘、白天無色。
    /// </summary>
    public class DayNightTint : MonoBehaviour
    {
        // (時刻分, 顏色) 關鍵幀,循環一天;alpha = 疊色強度
        private static readonly (int minute, Color color)[] Keys =
        {
            (0,    new Color(0.05f, 0.08f, 0.25f, 0.50f)), // 00:00 深夜
            (5 * 60,  new Color(0.05f, 0.08f, 0.25f, 0.45f)), // 05:00 夜末
            (6 * 60 + 30, new Color(0.95f, 0.55f, 0.25f, 0.18f)), // 06:30 日出
            (8 * 60,  new Color(1f, 1f, 1f, 0f)),              // 08:00 白天
            (16 * 60 + 30, new Color(1f, 1f, 1f, 0f)),         // 16:30 白天尾
            (18 * 60, new Color(0.95f, 0.45f, 0.2f, 0.22f)),   // 18:00 黃昏
            (19 * 60 + 30, new Color(0.15f, 0.15f, 0.35f, 0.35f)), // 19:30 入夜
            (22 * 60, new Color(0.05f, 0.08f, 0.25f, 0.50f)),  // 22:00 深夜
            (24 * 60, new Color(0.05f, 0.08f, 0.25f, 0.50f))   // 收尾(循環)
        };

        private GameRoot _root;
        private SpriteRenderer _sr;

        /// <summary>建立覆蓋整張地圖的色片</summary>
        public static DayNightTint Create(GameRoot root)
        {
            var go = new GameObject("DayNightTint");
            var tint = go.AddComponent<DayNightTint>();
            tint._root = root;

            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = Sprite.Create(Texture2D.whiteTexture,
                new Rect(0, 0, 4, 4), new Vector2(0.5f, 0.5f), 4f); // 1x1 世界單位的白色 sprite
            sr.sortingOrder = 90; // 蓋過場景與角色,HUD(uGUI)不受影響
            tint._sr = sr;

            var grid = root.Grid;
            int w = grid?.Width ?? 40, h = grid?.Height ?? 30;
            go.transform.position = new Vector3(w / 2f, h / 2f, 0);
            go.transform.localScale = new Vector3(w, h, 1);
            return tint;
        }

        private void Update()
        {
            if (_root?.Clock == null) return;
            int minute = (int)(_root.Clock.SimTime % 1440);
            _sr.color = Evaluate(minute);
        }

        /// <summary>在關鍵幀間線性內插出當下疊色</summary>
        private static Color Evaluate(int minute)
        {
            for (int i = 0; i < Keys.Length - 1; i++)
            {
                var (m0, c0) = Keys[i];
                var (m1, c1) = Keys[i + 1];
                if (minute < m0 || minute > m1) continue;
                float t = m1 == m0 ? 0f : (minute - m0) / (float)(m1 - m0);
                return Color.Lerp(c0, c1, t);
            }
            return Keys[0].color;
        }
    }
}
