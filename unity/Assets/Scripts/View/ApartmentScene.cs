using System.IO;
using Newtonsoft.Json;
using Pixnew.Sim;
using UnityEngine;
using UnityEngine.Tilemaps;

namespace Pixnew.View
{
    /// <summary>
    /// 公寓場景管理(P-03):
    /// 啟動時讀 apartment-layout.json + Tilemap 佔用情況,烘焙 WorldGrid 並印出結果;
    /// 鏡頭固定顯示全屋,滾輪 1x/2x 縮放。
    /// 場景由 Editor 選單「Tools/Pixnew/重建公寓場景」產生,本元件已掛好。
    /// </summary>
    public class ApartmentScene : MonoBehaviour
    {
        [Tooltip("地板層")] public Tilemap Floor;
        [Tooltip("牆壁層")] public Tilemap Walls;
        [Tooltip("家具層")] public Tilemap Furniture;

        /// <summary>烘焙完成的邏輯網格(後續 P-04 尋路、P-07 作息使用)</summary>
        public WorldGrid Grid { get; private set; }

        private ApartmentLayout _layout;
        private Camera _cam;
        private float _fitSize;   // 1x:全屋
        private bool _zoomedIn;

        private void Awake()
        {
            _layout = LoadLayout();
            if (_layout == null) return;

            BakeGrid();
            Debug.Log(Grid.BakeReport());
            SetupCamera();
        }

        private static ApartmentLayout LoadLayout()
        {
            string path = Path.Combine(Application.streamingAssetsPath, "content/apartment-layout.json");
            if (!File.Exists(path))
            {
                Debug.LogError($"[ApartmentScene] 找不到佈局檔:{path}");
                return null;
            }
            return JsonConvert.DeserializeObject<ApartmentLayout>(File.ReadAllText(path));
        }

        /// <summary>
        /// 烘焙邏輯網格:有地板且無牆、無(不可踩)家具 = 可行走。
        /// Tilemap 的 y 向上,JSON 的 y 向下,此處統一轉為 JSON 座標系。
        /// </summary>
        private void BakeGrid()
        {
            int w = _layout.Grid.Width, h = _layout.Grid.Height;
            Grid = new WorldGrid(w, h);

            for (int x = 0; x < w; x++)
            {
                for (int y = 0; y < h; y++)
                {
                    var cell = new Vector3Int(x, h - 1 - y, 0); // JSON y → Tilemap y
                    bool walkable = Floor.HasTile(cell) && !Walls.HasTile(cell) && !Furniture.HasTile(cell);
                    Grid.SetWalkable(x, y, walkable);
                }
            }

            // 可踩物件(如地毯)蓋在家具層,但仍算可走 → 依 JSON 回填
            foreach (var o in _layout.Objects)
            {
                if (!o.Walkable) continue;
                for (int dx = 0; dx < o.Atlas[2]; dx++)
                    for (int dy = 0; dy < o.Atlas[3]; dy++)
                    {
                        int x = o.Pos[0] + dx, y = o.Pos[1] + dy;
                        var cell = new Vector3Int(x, h - 1 - y, 0);
                        bool walkable = Floor.HasTile(cell) && !Walls.HasTile(cell);
                        Grid.SetWalkable(x, y, walkable);
                    }
            }

            foreach (var r in _layout.Rooms)
                Grid.AddRoom(r.Id, new RectInt(r.Rect[0], r.Rect[1], r.Rect[2], r.Rect[3]));

            foreach (var o in _layout.Objects)
                Grid.AddObject(o.Id,
                    new RectInt(o.Pos[0], o.Pos[1], o.Atlas[2], o.Atlas[3]),
                    new Vector2Int(o.Use[0], o.Use[1]));

            foreach (var d in _layout.Doors)
                Grid.AddObject(d.Id,
                    new RectInt(d.Pos[0], d.Pos[1], 1, 1),
                    new Vector2Int(d.Pos[0], d.Pos[1]));
        }

        /// <summary>鏡頭正交、置中、大小恰好顯示全屋</summary>
        private void SetupCamera()
        {
            _cam = Camera.main;
            if (_cam == null) return;

            int w = _layout.Grid.Width, h = _layout.Grid.Height;
            float halfByHeight = h / 2f;
            float halfByWidth = w / 2f / _cam.aspect;
            _fitSize = Mathf.Max(halfByHeight, halfByWidth) + 0.5f;

            _cam.orthographic = true;
            _cam.orthographicSize = _fitSize;
            _cam.transform.position = new Vector3(w / 2f, h / 2f, -10f);
        }

        private void Update()
        {
            if (_cam == null) return;

            // 滾輪:上 = 2x,下 = 1x
            float scroll = Input.mouseScrollDelta.y;
            if (scroll > 0.01f) _zoomedIn = true;
            else if (scroll < -0.01f) _zoomedIn = false;
            else return;

            _cam.orthographicSize = _zoomedIn ? _fitSize / 2f : _fitSize;
            if (!_zoomedIn)
                _cam.transform.position = new Vector3(_layout.Grid.Width / 2f, _layout.Grid.Height / 2f, -10f);
        }
    }
}
