using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace Pixnew.EditorTools
{
    /// <summary>
    /// P-04 角色動畫資產產生器:
    /// 從 Art/Characters/premade_character_32_0X.png 切出 idle/walk 四向各 6 幀,
    /// 產生 AnimationClip x8 + AnimatorController(sprite 與 clip 都存進 .controller 檔),
    /// 輸出到 Resources/Characters/roommate_0X.controller 供 RoommateView 載入。
    ///
    /// 圖集結構(LimeZu 32x32 版):上緣 32px 留白,之後每 64px 一段動畫帶,
    /// 幀 32x64;帶 1 = idle 24 幀、帶 2 = walk 24 幀;方向序 右/上/左/下、每向 6 幀。
    /// </summary>
    public static class CharacterAssetBuilder
    {
        private const int FrameW = 32;
        private const int FrameH = 64;
        private const int TopPad = 32;
        private const int IdleBand = 1;
        private const int WalkBand = 2;
        private const int FramesPerDir = 6;
        private static readonly char[] DirOrder = { 'r', 'u', 'l', 'd' };

        [MenuItem("Tools/Pixnew/Build Character Assets (P-04)")]
        public static void Build()
        {
            if (!AssetDatabase.IsValidFolder("Assets/Resources"))
                AssetDatabase.CreateFolder("Assets", "Resources");
            if (!AssetDatabase.IsValidFolder("Assets/Resources/Characters"))
                AssetDatabase.CreateFolder("Assets/Resources", "Characters");

            for (int i = 1; i <= 3; i++) BuildCharacter(i);
            AssetDatabase.SaveAssets();
            Debug.Log("[Builder] 角色動畫資產完成:Resources/Characters/roommate_01~03.controller");
        }

        private static void BuildCharacter(int index)
        {
            string texPath = $"Assets/Art/Characters/premade_character_32_{index:00}.png";
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(texPath);
            if (tex == null)
            {
                Debug.LogError($"[Builder] 找不到角色圖 {texPath}");
                return;
            }

            string ctrlPath = $"Assets/Resources/Characters/roommate_{index:00}.controller";
            if (AssetDatabase.LoadAssetAtPath<Object>(ctrlPath) != null)
                AssetDatabase.DeleteAsset(ctrlPath);

            var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
            var sm = ctrl.layers[0].stateMachine;

            AnimatorState defaultState = null;
            foreach (var (band, prefix, fps) in new[] { (IdleBand, "idle", 5f), (WalkBand, "walk", 10f) })
            {
                for (int dir = 0; dir < 4; dir++)
                {
                    string name = $"{prefix}_{DirOrder[dir]}";
                    var clip = MakeClip(tex, ctrlPath, name, band, dir, fps);
                    var state = sm.AddState(name);
                    state.motion = clip;
                    if (name == "idle_d") defaultState = state;
                }
            }
            if (defaultState != null) sm.defaultState = defaultState;
        }

        /// <summary>切一組 6 幀、綁 SpriteRenderer.m_Sprite 的循環動畫剪輯,連同 sprite 存入 controller 檔</summary>
        private static AnimationClip MakeClip(Texture2D tex, string ctrlPath, string name, int band, int dir, float fps)
        {
            var sprites = new List<Sprite>();
            int bandTop = TopPad + band * FrameH;           // 距圖頂像素
            float rectY = tex.height - bandTop - FrameH;    // 轉為距圖底像素

            for (int f = 0; f < FramesPerDir; f++)
            {
                int frame = dir * FramesPerDir + f;
                var rect = new Rect(frame * FrameW, rectY, FrameW, FrameH);
                var sp = Sprite.Create(tex, rect, new Vector2(0.5f, 0.25f), 32f, 0, SpriteMeshType.FullRect);
                sp.name = $"{name}_{f}";
                AssetDatabase.AddObjectToAsset(sp, ctrlPath);
                sprites.Add(sp);
            }

            var clip = new AnimationClip { name = name, frameRate = fps };
            var binding = new EditorCurveBinding
            {
                type = typeof(SpriteRenderer),
                path = "",
                propertyName = "m_Sprite"
            };
            var keys = new ObjectReferenceKeyframe[sprites.Count];
            for (int f = 0; f < sprites.Count; f++)
                keys[f] = new ObjectReferenceKeyframe { time = f / fps, value = sprites[f] };
            AnimationUtility.SetObjectReferenceCurve(clip, binding, keys);

            var settings = AnimationUtility.GetAnimationClipSettings(clip);
            settings.loopTime = true;
            AnimationUtility.SetAnimationClipSettings(clip, settings);

            AssetDatabase.AddObjectToAsset(clip, ctrlPath);
            return clip;
        }
    }
}
