using UnityEditor;
using UnityEngine;

namespace Pixnew.EditorTools
{
    /// <summary>
    /// 像素素材匯入自動設定(P-03):
    /// Art/Tilesets、Art/Characters 底下的貼圖一律
    /// PPU=32、Point 過濾、不壓縮、關 mipmap —— 保證像素銳利、無滲色。
    /// </summary>
    public class PixelImportPostprocessor : AssetPostprocessor
    {
        private const int PixelsPerUnit = 32;

        private void OnPreprocessTexture()
        {
            if (!assetPath.StartsWith("Assets/Art/Tilesets") &&
                !assetPath.StartsWith("Assets/Art/Characters")) return;

            var importer = (TextureImporter)assetImporter;
            importer.textureType = TextureImporterType.Sprite;
            importer.spritePixelsPerUnit = PixelsPerUnit;
            importer.filterMode = FilterMode.Point;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            importer.mipmapEnabled = false;
            importer.maxTextureSize = 8192; // theme_bedroom 高 3424px,預設 2048 會被縮圖
        }
    }
}
