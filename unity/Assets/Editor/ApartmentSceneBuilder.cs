using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Pixnew.Sim;
using Pixnew.View;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Tilemaps;

namespace Pixnew.EditorTools
{
    /// <summary>
    /// P-03 公寓場景產生器:
    /// 讀 StreamingAssets/content/apartment-layout.json,
    /// 從 Art/Tilesets 圖集切出所需 sprite 與 Tile(存成單一資產),
    /// 建 Grid + Floor/Walls/Furniture 三層 Tilemap 並依佈局上磚,
    /// 存成 Assets/Scenes/Apartment.unity。佈局改了就重跑一次選單。
    /// </summary>
    public static class ApartmentSceneBuilder
    {
        private const string LayoutPath = "Assets/StreamingAssets/content/apartment-layout.json";
        private const string TilesetDir = "Assets/Art/Tilesets";
        private const string TilesAssetPath = "Assets/Art/Tiles/apartment_tiles.asset";
        private const string ScenePath = "Assets/Scenes/Apartment.unity";
        private const int Cell = 32;

        private static ApartmentLayout _layout;
        private static readonly Dictionary<string, Texture2D> Sheets = new();
        private static readonly Dictionary<string, Tile> Tiles = new();
        private static Tile _containerMain;

        [MenuItem("Tools/Pixnew/Build Apartment Scene (P-03)")]
        public static void Build()
        {
            if (!File.Exists(LayoutPath))
            {
                Debug.LogError($"[Builder] 找不到佈局檔 {LayoutPath}");
                return;
            }
            _layout = JsonConvert.DeserializeObject<ApartmentLayout>(File.ReadAllText(LayoutPath));
            Sheets.Clear();
            Tiles.Clear();
            _containerMain = null;

            LoadSheets();
            PrepareTilesAsset();

            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var grid = new GameObject("Grid", typeof(Grid));
            var floor = CreateLayer(grid.transform, "Floor", 0);
            var walls = CreateLayer(grid.transform, "Walls", 10);
            var furniture = CreateLayer(grid.transform, "Furniture", 20);

            PaintFloors(floor);
            PaintWalls(walls);
            PaintFurniture(furniture);

            CreateCamera();

            var root = new GameObject("ApartmentRoot");
            var view = root.AddComponent<ApartmentScene>();
            view.Floor = floor;
            view.Walls = walls;
            view.Furniture = furniture;

            AssetDatabase.SaveAssets();
            if (!Directory.Exists("Assets/Scenes")) Directory.CreateDirectory("Assets/Scenes");
            EditorSceneManager.SaveScene(scene, ScenePath);
            Debug.Log($"[Builder] 公寓場景已產生:{ScenePath}(磚 {Tiles.Count} 種)。開場景按 Play 看 WorldGrid 烘焙結果。");
        }

        // ── 素材載入 ────────────────────────────────

        private static void LoadSheets()
        {
            foreach (var kv in _layout.Sheets)
            {
                string path = $"{TilesetDir}/{kv.Value}.png";
                EnsureImportSettings(path);
                var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
                if (tex == null) Debug.LogError($"[Builder] 找不到圖集 {path}");
                else Sheets[kv.Key] = tex;
            }
        }

        /// <summary>保險:即使 Postprocessor 沒跑過,也強制套像素匯入設定</summary>
        private static void EnsureImportSettings(string path)
        {
            var importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer == null) return;
            bool dirty = importer.spritePixelsPerUnit != Cell ||
                         importer.filterMode != FilterMode.Point ||
                         importer.textureCompression != TextureImporterCompression.Uncompressed ||
                         importer.mipmapEnabled ||
                         importer.maxTextureSize < 8192;
            if (!dirty) return;
            importer.textureType = TextureImporterType.Sprite;
            importer.spritePixelsPerUnit = Cell;
            importer.filterMode = FilterMode.Point;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            importer.mipmapEnabled = false;
            importer.maxTextureSize = 8192;
            importer.SaveAndReimport();
        }

        private static void PrepareTilesAsset()
        {
            string dir = Path.GetDirectoryName(TilesAssetPath)!.Replace('\\', '/');
            if (!AssetDatabase.IsValidFolder(dir)) AssetDatabase.CreateFolder("Assets/Art", "Tiles");
            if (AssetDatabase.LoadAssetAtPath<Object>(TilesAssetPath) != null)
                AssetDatabase.DeleteAsset(TilesAssetPath);
        }

        /// <summary>取(或建)圖集某一格的 Tile;sprite 與 tile 一起存進單一資產檔</summary>
        private static Tile GetTile(string sheetKey, int col, int row)
        {
            string key = $"{sheetKey}_{col}_{row}";
            if (Tiles.TryGetValue(key, out var cached)) return cached;

            var tex = Sheets[sheetKey];
            var rect = new Rect(col * Cell, tex.height - (row + 1) * Cell, Cell, Cell);
            var sprite = Sprite.Create(tex, rect, new Vector2(0.5f, 0.5f), Cell, 0, SpriteMeshType.FullRect);
            sprite.name = "s_" + key;

            var tile = ScriptableObject.CreateInstance<Tile>();
            tile.sprite = sprite;
            tile.colliderType = Tile.ColliderType.None;
            tile.name = key;

            if (_containerMain == null)
            {
                _containerMain = tile;
                AssetDatabase.CreateAsset(tile, TilesAssetPath);
            }
            else
            {
                AssetDatabase.AddObjectToAsset(tile, TilesAssetPath);
            }
            AssetDatabase.AddObjectToAsset(sprite, TilesAssetPath);

            Tiles[key] = tile;
            return tile;
        }

        // ── 上磚 ────────────────────────────────

        private static Tilemap CreateLayer(Transform parent, string name, int sortingOrder)
        {
            var go = new GameObject(name, typeof(Tilemap), typeof(TilemapRenderer));
            go.transform.SetParent(parent, false);
            go.GetComponent<TilemapRenderer>().sortingOrder = sortingOrder;
            return go.GetComponent<Tilemap>();
        }

        /// <summary>JSON 座標(y 向下)→ Tilemap 座標(y 向上)</summary>
        private static Vector3Int Tm(int x, int jsonY) =>
            new(x, _layout.Grid.Height - 1 - jsonY, 0);

        private static void PaintFloorRect(Tilemap map, int[] rect, string floorName)
        {
            var spec = _layout.FloorTiles[floorName];
            int bw = spec.Block[0], bh = spec.Block[1];
            for (int x = rect[0]; x < rect[0] + rect[2]; x++)
                for (int y = rect[1]; y < rect[1] + rect[3]; y++)
                    map.SetTile(Tm(x, y), GetTile(spec.Sheet, spec.Cell[0] + x % bw, spec.Cell[1] + y % bh));
        }

        private static void PaintFloors(Tilemap map)
        {
            foreach (var r in _layout.Rooms) PaintFloorRect(map, r.Rect, r.Floor);
            foreach (var e in _layout.ExtraFloor) PaintFloorRect(map, e.Rect, e.Floor);
        }

        private static void PaintWalls(Tilemap map)
        {
            var hTop = _layout.WallTiles["hTop"];
            var hBottom = _layout.WallTiles["hBottom"];
            var vMid = _layout.WallTiles["vMid"];

            foreach (var run in _layout.Walls)
            {
                if (run.Dir == "h")
                {
                    for (int i = 0; i < run.Len; i++)
                    {
                        int x = run.X + i;
                        if (InGap(run, x)) continue;
                        map.SetTile(Tm(x, run.Y), GetTile("walls", hTop[0], hTop[1]));
                        map.SetTile(Tm(x, run.Y + 1), GetTile("walls", hBottom[0], hBottom[1]));
                    }
                }
                else // v
                {
                    for (int i = 0; i < run.Len; i++)
                    {
                        int y = run.Y + i;
                        if (InGap(run, y)) continue;
                        map.SetTile(Tm(run.X, y), GetTile("walls", vMid[0], vMid[1]));
                    }
                }
            }
        }

        private static bool InGap(WallRunSpec run, int coord)
        {
            if (run.Gaps == null) return false;
            foreach (var g in run.Gaps)
                if (coord >= g[0] && coord < g[0] + g[1]) return true;
            return false;
        }

        private static void PaintFurniture(Tilemap map)
        {
            foreach (var o in _layout.Objects)
            {
                int ax = o.Atlas[0], ay = o.Atlas[1], w = o.Atlas[2], h = o.Atlas[3];
                for (int dx = 0; dx < w; dx++)
                    for (int dy = 0; dy < h; dy++)
                        map.SetTile(Tm(o.Pos[0] + dx, o.Pos[1] + dy), GetTile(o.Sheet, ax + dx, ay + dy));
            }
        }

        // ── 鏡頭 ────────────────────────────────

        private static void CreateCamera()
        {
            var go = new GameObject("Main Camera");
            go.tag = "MainCamera";
            var cam = go.AddComponent<Camera>();
            cam.orthographic = true;
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.08f, 0.08f, 0.12f);
            int w = _layout.Grid.Width, h = _layout.Grid.Height;
            cam.orthographicSize = Mathf.Max(h / 2f, w / 2f / 1.7778f) + 0.5f;
            go.transform.position = new Vector3(w / 2f, h / 2f, -10f);
        }
    }
}
