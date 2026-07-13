using System.IO;
using UnityEditor;
using UnityEngine;

namespace Pixnew.EditorTools
{
    /// <summary>
    /// Single entry point for interactive or command-line regeneration of all
    /// visual assets that are derived from local licensed source art.
    /// </summary>
    public static class VisualAssetBuildPipeline
    {
        [MenuItem("Tools/Pixnew/Rebuild All Visual Assets")]
        public static void Build()
        {
            CharacterAssetBuilder.Build();
            ApartmentSceneBuilder.Build();
            AssetDatabase.SaveAssets();
            Debug.Log("[Builder] All visual assets rebuilt successfully.");
        }

        /// <summary>Command-line entry point that also renders an off-screen review image.</summary>
        public static void BuildAndCapture()
        {
            Build();
            CaptureValidationSnapshot();
        }

        [MenuItem("Tools/Pixnew/Capture Visual Validation Snapshot")]
        public static void CaptureValidationSnapshot()
        {
            var camera = Camera.main;
            if (camera == null)
                throw new MissingReferenceException("The generated apartment scene has no Main Camera.");

            const int width = 1600;
            const int height = 900;
            var renderTexture = new RenderTexture(width, height, 24);
            var image = new Texture2D(width, height, TextureFormat.RGB24, false);
            RenderTexture previous = RenderTexture.active;

            try
            {
                camera.targetTexture = renderTexture;
                RenderTexture.active = renderTexture;
                camera.Render();
                image.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                image.Apply();

                string outputPath = Path.GetFullPath(
                    Path.Combine(Application.dataPath, "../Logs/visual-validation.png"));
                Directory.CreateDirectory(Path.GetDirectoryName(outputPath));
                File.WriteAllBytes(outputPath, image.EncodeToPNG());
                Debug.Log($"[Builder] Visual validation snapshot: {outputPath}");
            }
            finally
            {
                camera.targetTexture = null;
                RenderTexture.active = previous;
                Object.DestroyImmediate(image);
                Object.DestroyImmediate(renderTexture);
            }
        }
    }
}
