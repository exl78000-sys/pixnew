using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace Pixnew.EditorTools
{
    /// <summary>Builds six roommate animation controllers from local LimeZu character sheets.</summary>
    public static class CharacterAssetBuilder
    {
        private const int FrameW = 32;
        private const int FrameH = 64;

        // The first band starts 64 px below the sheet header. Bands are already
        // 64 px tall; a half-band offset splices two different poses together.
        private const int TopPad = 64;
        private const int IdleBand = 0;
        private const int WalkBand = 1;
        private const int FramesPerDir = 6;
        private static readonly char[] DirOrder = { 'r', 'u', 'l', 'd' };
        private static readonly int[] SourceCharacterIndices = { 1, 3, 6, 9, 12, 15 };

        [MenuItem("Tools/Pixnew/Build Character Assets (P-04)")]
        public static void Build()
        {
            StageLocalLicensedSheets();
            if (!AssetDatabase.IsValidFolder("Assets/Resources"))
                AssetDatabase.CreateFolder("Assets", "Resources");
            if (!AssetDatabase.IsValidFolder("Assets/Resources/Characters"))
                AssetDatabase.CreateFolder("Assets/Resources", "Characters");

            for (int i = 1; i <= 6; i++)
                BuildCharacter(i);

            AssetDatabase.SaveAssets();
            Debug.Log("[Builder] Character assets rebuilt: roommate_01~06.controller");
        }

        /// <summary>
        /// 從 gitignored 的付費素材原檔挑六位外觀差異明顯的角色到正式匯入目錄。
        /// 目的 PNG 仍受 .gitignore 保護；公開 clone 缺素材時只警告、不破壞編譯。
        /// </summary>
        private static void StageLocalLicensedSheets()
        {
            const string sourceDir = "Assets/Art/Raw~/ModernInteriors/2_Characters/Character_Generator/0_Premade_Characters/32x32";
            const string targetDir = "Assets/Art/Characters";
            if (!Directory.Exists(sourceDir))
            {
                Debug.LogWarning("[Builder] 本機沒有 LimeZu Raw~ 素材，沿用已匯入的角色圖。");
                return;
            }

            Directory.CreateDirectory(targetDir);
            for (int output = 1; output <= SourceCharacterIndices.Length; output++)
            {
                int source = SourceCharacterIndices[output - 1];
                string from = $"{sourceDir}/Premade_Character_32x32_{source:00}.png";
                string to = $"{targetDir}/premade_character_32_{output:00}.png";
                File.Copy(from, to, true);
            }
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        }

        private static void BuildCharacter(int index)
        {
            string texPath = $"Assets/Art/Characters/premade_character_32_{index:00}.png";
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(texPath);
            if (tex == null)
            {
                Debug.LogError($"[Builder] Missing character sheet: {texPath}");
                return;
            }

            string ctrlPath = $"Assets/Resources/Characters/roommate_{index:00}.controller";
            if (AssetDatabase.LoadAssetAtPath<Object>(ctrlPath) != null)
                AssetDatabase.DeleteAsset(ctrlPath);

            var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ctrlPath);
            var stateMachine = ctrl.layers[0].stateMachine;
            AnimatorState defaultState = null;

            foreach (var (band, prefix, fps) in new[]
                     {
                         (IdleBand, "idle", 5f),
                         (WalkBand, "walk", 10f)
                     })
            {
                for (int dir = 0; dir < DirOrder.Length; dir++)
                {
                    string name = $"{prefix}_{DirOrder[dir]}";
                    var clip = MakeClip(tex, ctrlPath, name, band, dir, fps);
                    var state = stateMachine.AddState(name);
                    state.motion = clip;
                    if (name == "idle_d")
                        defaultState = state;
                }
            }

            if (defaultState != null)
                stateMachine.defaultState = defaultState;
        }

        private static AnimationClip MakeClip(
            Texture2D tex,
            string ctrlPath,
            string name,
            int band,
            int dir,
            float fps)
        {
            int bandTop = TopPad + band * FrameH;
            float rectY = tex.height - bandTop - FrameH;
            if (rectY < 0 || FramesPerDir * DirOrder.Length * FrameW > tex.width)
            {
                throw new System.InvalidOperationException(
                    $"Character sheet {tex.name} does not contain the expected animation bands.");
            }

            var sprites = new List<Sprite>();
            for (int frameInDirection = 0; frameInDirection < FramesPerDir; frameInDirection++)
            {
                int frame = dir * FramesPerDir + frameInDirection;
                var rect = new Rect(frame * FrameW, rectY, FrameW, FrameH);
                var sprite = Sprite.Create(
                    tex,
                    rect,
                    new Vector2(0.5f, 0.25f),
                    FrameW,
                    0,
                    SpriteMeshType.FullRect);
                sprite.name = $"{name}_{frameInDirection}";
                AssetDatabase.AddObjectToAsset(sprite, ctrlPath);
                sprites.Add(sprite);
            }

            var clip = new AnimationClip { name = name, frameRate = fps };
            var binding = new EditorCurveBinding
            {
                type = typeof(SpriteRenderer),
                path = "",
                propertyName = "m_Sprite"
            };
            var keys = new ObjectReferenceKeyframe[sprites.Count];
            for (int i = 0; i < sprites.Count; i++)
                keys[i] = new ObjectReferenceKeyframe { time = i / fps, value = sprites[i] };
            AnimationUtility.SetObjectReferenceCurve(clip, binding, keys);

            var settings = AnimationUtility.GetAnimationClipSettings(clip);
            settings.loopTime = true;
            AnimationUtility.SetAnimationClipSettings(clip, settings);
            AssetDatabase.AddObjectToAsset(clip, ctrlPath);
            return clip;
        }
    }
}
