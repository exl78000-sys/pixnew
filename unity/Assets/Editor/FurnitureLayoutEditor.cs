using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Pixnew.Sim;
using UnityEditor;
using UnityEngine;

namespace Pixnew.EditorTools
{
    /// <summary>
    /// 製作人用的家具拖曳配置器。所有變更仍回寫 apartment-layout.json，
    /// 因此日後重建場景不會洗掉手動配置。
    /// </summary>
    public sealed class FurnitureLayoutEditor : EditorWindow
    {
        private enum EditMode { Furniture, Doors, Partitions, Floors }

        private const string LayoutPath = "Assets/StreamingAssets/content/apartment-layout.json";
        private const string TilesetDir = "Assets/Art/Tilesets";
        private const float SidebarWidth = 270f;
        private const int AtlasCell = 32;

        private sealed class CatalogItem
        {
            public string Label;
            public string Category;
            public string IdPrefix;
            public string Sheet;
            public int[] Atlas;
            public bool Walkable;

            public CatalogItem(string label, string category, string idPrefix, string sheet, int x, int y, int width, int height, bool walkable = false)
            {
                Label = label;
                Category = category;
                IdPrefix = idPrefix;
                Sheet = sheet;
                Atlas = new[] { x, y, width, height };
                Walkable = walkable;
            }
        }

        private static readonly CatalogItem[] FurnitureCatalog =
        {
            new("沙發", "客廳", "sofa", "living", 1, 28, 3, 2),
            new("電視", "客廳", "tv", "bedroom", 9, 12, 2, 2),
            new("客廳地毯", "客廳", "living_rug", "generic", 9, 7, 4, 3, true),
            new("收納櫃", "客廳", "cabinet", "living", 7, 4, 2, 3),
            new("盆栽", "客廳", "plant", "living", 10, 0, 2, 3),
            new("梳妝台", "客廳", "dresser", "living", 2, 5, 2, 2),
            new("軟墊長椅", "客廳", "bench", "living", 2, 8, 2, 1),
            new("壁爐", "客廳", "fireplace", "living", 4, 25, 2, 2),
            new("落地鏡", "客廳", "floor_mirror", "living", 6, 23, 2, 4),
            new("書櫃", "客廳", "bookcase", "living", 10, 24, 2, 3),
            new("白色沙發", "客廳", "sofa_white", "living", 4, 28, 3, 2),
            new("米黃沙發", "客廳", "sofa_yellow", "living", 7, 28, 3, 2),
            new("電視櫃", "客廳", "tv_console", "living", 12, 35, 2, 2),

            new("綠色單人床", "臥室", "bed_green", "bedroom", 8, 21, 2, 3),
            new("黃色單人床", "臥室", "bed_yellow", "bedroom", 10, 21, 2, 3),
            new("藍色單人床", "臥室", "bed_blue", "bedroom", 12, 21, 2, 3),
            new("書桌", "臥室", "desk", "generic", 0, 8, 4, 3),
            new("粉色圓地毯", "臥室", "round_rug_pink", "bedroom", 0, 22, 3, 2, true),
            new("灰色圓地毯", "臥室", "round_rug_gray", "bedroom", 3, 22, 3, 2, true),
            new("紅木衣櫃", "臥室", "wardrobe_red", "bedroom", 12, 0, 4, 3),
            new("淺木衣櫃", "臥室", "wardrobe_light", "bedroom", 12, 3, 4, 3),
            new("休閒圓桌", "臥室", "round_table", "bedroom", 3, 13, 2, 3),
            new("床頭櫃", "臥室", "nightstand", "bedroom", 6, 10, 1, 2),

            new("餐桌", "廚房", "dining_table", "generic", 0, 5, 4, 3),
            new("餐椅", "廚房", "chair", "kitchen", 2, 11, 1, 2),
            new("冰箱", "廚房", "fridge", "kitchen", 0, 1, 2, 3),
            new("爐具", "廚房", "stove", "kitchen", 8, 11, 1, 1),
            new("廚房水槽", "廚房", "kitchen_sink", "kitchen", 8, 7, 2, 1),
            new("流理台", "廚房", "counter", "kitchen", 12, 9, 2, 2),
            new("微波爐", "廚房", "microwave", "kitchen", 9, 6, 1, 1),
            new("雙爐烤箱", "廚房", "double_oven", "kitchen", 8, 11, 2, 2),
            new("方形餐桌", "廚房", "square_table", "kitchen", 4, 16, 2, 2),
            new("廚房長桌", "廚房", "kitchen_long_table", "kitchen", 9, 17, 3, 2),

            new("馬桶", "衛浴", "toilet", "bathroom", 10, 0, 1, 3),
            new("洗手台", "衛浴", "sink", "bathroom", 7, 6, 2, 2),
            new("淋浴設備", "衛浴", "shower", "bathroom", 6, 12, 2, 3),
            new("洗衣機", "衛浴", "washer", "bathroom", 12, 0, 2, 3),
            new("木質浴櫃", "衛浴", "bath_vanity", "bathroom", 0, 8, 2, 2),
            new("衛浴落地鏡", "衛浴", "bath_floor_mirror", "bathroom", 2, 8, 1, 3),
            new("雙門浴櫃", "衛浴", "bath_cabinet", "bathroom", 0, 10, 2, 2),
            new("浴缸", "衛浴", "bathtub", "bathroom", 8, 16, 2, 2),
            new("衛浴地墊", "衛浴", "bath_mat", "bathroom", 9, 20, 2, 2, true)
        };

        private ApartmentLayout _layout;
        private ObjectSpec _selected;
        private DoorSpec _selectedDoor;
        private WallRunSpec _selectedWall;
        private ExtraFloorSpec _selectedFloor;
        private EditMode _editMode;
        private readonly Dictionary<string, Texture2D> _textures = new();
        private Vector2Int _dragOffset;
        private bool _dragging;
        private bool _drawingFloor;
        private Vector2Int _floorDragStart;
        private Vector2Int _floorDragCurrent;
        private string _paintFloor = "living";
        private Vector2 _catalogScroll;
        private int _catalogCategory;
        private WallRunSpec _dragDoorWall;
        private int[] _dragDoorGap;
        private bool _dirty;
        private string _message = "點選家具後拖曳；放開滑鼠即吸附格線。";

        [MenuItem("Tools/Pixnew/Open Furniture Layout Editor")]
        public static void Open()
        {
            var window = GetWindow<FurnitureLayoutEditor>("家具配置器");
            window.minSize = new Vector2(1050f, 720f);
            window.Show();
            window.Focus();
        }

        private void OnEnable() => LoadLayout();

        private void OnGUI()
        {
            DrawToolbar();
            if (_layout == null)
            {
                EditorGUILayout.HelpBox(_message, MessageType.Error);
                return;
            }

            Rect canvasArea = new Rect(8f, 42f, position.width - SidebarWidth - 24f, position.height - 50f);
            Rect sidebar = new Rect(position.width - SidebarWidth - 8f, 42f, SidebarWidth, position.height - 50f);
            DrawCanvas(canvasArea);
            DrawSidebar(sidebar);
            HandleCanvasInput(canvasArea);
        }

        private void DrawToolbar()
        {
            GUILayout.BeginHorizontal(EditorStyles.toolbar);
            if (GUILayout.Button("重新載入 JSON", EditorStyles.toolbarButton, GUILayout.Width(110f)))
                ReloadWithConfirmation();
            GUI.enabled = _layout != null;
            if (GUILayout.Button("儲存 JSON", EditorStyles.toolbarButton, GUILayout.Width(95f)))
                Save(false);
            if (GUILayout.Button("儲存並重建場景", EditorStyles.toolbarButton, GUILayout.Width(140f)))
                Save(true);
            GUI.enabled = true;
            GUILayout.Space(12f);
            bool furnitureMode = GUILayout.Toggle(_editMode == EditMode.Furniture, "家具模式", EditorStyles.toolbarButton, GUILayout.Width(72f));
            bool doorMode = GUILayout.Toggle(_editMode == EditMode.Doors, "門模式", EditorStyles.toolbarButton, GUILayout.Width(72f));
            bool partitionMode = GUILayout.Toggle(_editMode == EditMode.Partitions, "隔間模式", EditorStyles.toolbarButton, GUILayout.Width(72f));
            bool floorMode = GUILayout.Toggle(_editMode == EditMode.Floors, "地板模式", EditorStyles.toolbarButton, GUILayout.Width(72f));
            if (floorMode && _editMode != EditMode.Floors) SetEditMode(EditMode.Floors);
            else if (partitionMode && _editMode != EditMode.Partitions) SetEditMode(EditMode.Partitions);
            else if (doorMode && _editMode != EditMode.Doors) SetEditMode(EditMode.Doors);
            else if (furnitureMode && _editMode != EditMode.Furniture) SetEditMode(EditMode.Furniture);
            GUILayout.Space(12f);
            GUILayout.Label(_dirty ? "● 尚未儲存" : "✓ 已同步", _dirty ? EditorStyles.boldLabel : EditorStyles.miniLabel);
            GUILayout.FlexibleSpace();
            GUILayout.Label(_message, EditorStyles.miniLabel);
            GUILayout.EndHorizontal();
        }

        private void DrawCanvas(Rect area)
        {
            EditorGUI.DrawRect(area, new Color(0.075f, 0.08f, 0.1f));
            float cell = Mathf.Min(area.width / _layout.Grid.Width, area.height / _layout.Grid.Height);
            float mapWidth = _layout.Grid.Width * cell;
            float mapHeight = _layout.Grid.Height * cell;
            Rect map = new Rect(area.x + (area.width - mapWidth) * 0.5f, area.y + (area.height - mapHeight) * 0.5f, mapWidth, mapHeight);
            EditorGUI.DrawRect(map, new Color(0.18f, 0.18f, 0.2f));

            foreach (RoomSpec room in _layout.Rooms)
            {
                Color color = RoomColor(room.Floor);
                EditorGUI.DrawRect(ToRect(map, cell, room.Rect[0], room.Rect[1], room.Rect[2], room.Rect[3]), color);
            }

            foreach (ExtraFloorSpec floor in _layout.ExtraFloor)
                EditorGUI.DrawRect(ToRect(map, cell, floor.Rect[0], floor.Rect[1], floor.Rect[2], floor.Rect[3]), RoomColor(floor.Floor));

            Handles.BeginGUI();
            Handles.color = new Color(1f, 1f, 1f, 0.09f);
            for (int x = 0; x <= _layout.Grid.Width; x++)
                Handles.DrawLine(new Vector3(map.x + x * cell, map.y), new Vector3(map.x + x * cell, map.yMax));
            for (int y = 0; y <= _layout.Grid.Height; y++)
                Handles.DrawLine(new Vector3(map.x, map.y + y * cell), new Vector3(map.xMax, map.y + y * cell));
            Handles.EndGUI();

            foreach (ObjectSpec obj in _layout.Objects)
                DrawFurniture(map, cell, obj);

            if (_editMode == EditMode.Doors)
                foreach (DoorSpec door in _layout.Doors)
                    DrawDoor(map, cell, door);
            else if (_editMode == EditMode.Partitions)
                foreach (WallRunSpec wall in _layout.Walls)
                    if (!IsOuterWall(wall)) DrawPartition(map, cell, wall);

            if (_editMode == EditMode.Floors)
            {
                if (_selectedFloor != null)
                {
                    Rect selectedRect = ToRect(map, cell, _selectedFloor.Rect[0], _selectedFloor.Rect[1], _selectedFloor.Rect[2], _selectedFloor.Rect[3]);
                    Handles.BeginGUI();
                    Handles.DrawSolidRectangleWithOutline(selectedRect, new Color(1f, 0.8f, 0.1f, 0.12f), new Color(1f, 0.85f, 0.15f));
                    Handles.EndGUI();
                }
                if (_drawingFloor)
                {
                    int minX = Mathf.Min(_floorDragStart.x, _floorDragCurrent.x);
                    int minY = Mathf.Min(_floorDragStart.y, _floorDragCurrent.y);
                    int width = Mathf.Abs(_floorDragCurrent.x - _floorDragStart.x) + 1;
                    int height = Mathf.Abs(_floorDragCurrent.y - _floorDragStart.y) + 1;
                    Rect preview = ToRect(map, cell, minX, minY, width, height);
                    Color previewColor = RoomColor(_paintFloor);
                    previewColor.a = 0.72f;
                    EditorGUI.DrawRect(preview, previewColor);
                    Handles.BeginGUI();
                    Handles.DrawSolidRectangleWithOutline(preview, Color.clear, Color.white);
                    Handles.EndGUI();
                }
            }

            if (_editMode == EditMode.Furniture && _selected != null)
            {
                Rect useRect = ToRect(map, cell, _selected.Use[0], _selected.Use[1], 1, 1);
                EditorGUI.DrawRect(useRect, new Color(0.1f, 0.95f, 0.45f, 0.55f));
                GUI.Label(useRect, "●", CenteredMiniStyle());
            }

            _lastMapRect = map;
            _lastCell = cell;
        }

        private void DrawDoor(Rect map, float cell, DoorSpec door)
        {
            int width = 1;
            int height = 1;
            if (TryFindDoorGap(door, out WallRunSpec wall, out int[] gap))
            {
                if (wall.Dir == "h") width = gap[1];
                else height = gap[1];
            }

            Rect rect = ToRect(map, cell, door.Pos[0], door.Pos[1], width, height);
            Color fill = door == _selectedDoor
                ? new Color(1f, 0.35f, 0.75f, 0.72f)
                : new Color(0.1f, 0.85f, 1f, 0.48f);
            EditorGUI.DrawRect(rect, fill);
            Handles.BeginGUI();
            Handles.DrawSolidRectangleWithOutline(rect, Color.clear,
                door == _selectedDoor ? new Color(1f, 0.85f, 0.15f) : new Color(0.2f, 0.95f, 1f));
            Handles.EndGUI();
            if (door == _selectedDoor)
                GUI.Label(new Rect(rect.x, rect.y - 18f, 190f, 18f), door.Id, EditorStyles.whiteBoldLabel);
        }

        private void DrawPartition(Rect map, float cell, WallRunSpec wall)
        {
            int width = wall.Dir == "h" ? wall.Len : 1;
            int height = wall.Dir == "h" ? 2 : wall.Len;
            Rect rect = ToRect(map, cell, wall.X, wall.Y, width, height);
            bool selected = wall == _selectedWall;
            EditorGUI.DrawRect(rect, selected
                ? new Color(1f, 0.35f, 0.65f, 0.58f)
                : new Color(0.65f, 0.25f, 1f, 0.30f));
            Handles.BeginGUI();
            Handles.DrawSolidRectangleWithOutline(rect, Color.clear,
                selected ? new Color(1f, 0.9f, 0.2f) : new Color(0.75f, 0.5f, 1f));
            Handles.EndGUI();

            foreach (int[] gap in wall.Gaps)
            {
                Rect gapRect = wall.Dir == "h"
                    ? ToRect(map, cell, gap[0], wall.Y, gap[1], 2)
                    : ToRect(map, cell, wall.X, gap[0], 1, gap[1]);
                EditorGUI.DrawRect(gapRect, new Color(0.1f, 0.85f, 1f, 0.42f));
            }

            if (selected)
                GUI.Label(new Rect(rect.x, rect.y - 18f, 220f, 18f), WallLabel(wall), EditorStyles.whiteBoldLabel);
        }

        private Rect _lastMapRect;
        private float _lastCell;

        private void DrawFurniture(Rect map, float cell, ObjectSpec obj)
        {
            Rect rect = ToRect(map, cell, obj.Pos[0], obj.Pos[1], obj.FootprintWidth, obj.FootprintHeight);
            Texture2D texture = GetTexture(obj.Sheet);
            if (texture != null)
            {
                Rect uv = new Rect(
                    obj.Atlas[0] * AtlasCell / (float)texture.width,
                    1f - (obj.Atlas[1] + obj.Atlas[3]) * AtlasCell / (float)texture.height,
                    obj.Atlas[2] * AtlasCell / (float)texture.width,
                    obj.Atlas[3] * AtlasCell / (float)texture.height);
                Matrix4x4 previous = GUI.matrix;
                GUIUtility.RotateAroundPivot(obj.NormalizedRotation, rect.center);
                Rect sourceRect = new Rect(
                    rect.center.x - obj.Atlas[2] * cell * 0.5f,
                    rect.center.y - obj.Atlas[3] * cell * 0.5f,
                    obj.Atlas[2] * cell,
                    obj.Atlas[3] * cell);
                GUI.DrawTextureWithTexCoords(sourceRect, texture, uv, true);
                GUI.matrix = previous;
            }
            else
            {
                EditorGUI.DrawRect(rect, new Color(0.65f, 0.35f, 0.25f, 0.8f));
            }

            if (obj == _selected)
            {
                Handles.BeginGUI();
                Handles.DrawSolidRectangleWithOutline(rect, new Color(1f, 0.75f, 0.1f, 0.12f), new Color(1f, 0.75f, 0.1f, 1f));
                Handles.EndGUI();
                GUI.Label(new Rect(rect.x, rect.y - 18f, Mathf.Max(rect.width, 150f), 18f), obj.Id, EditorStyles.whiteBoldLabel);
            }
        }

        private void DrawSidebar(Rect area)
        {
            GUILayout.BeginArea(area, EditorStyles.helpBox);
            if (_editMode == EditMode.Doors)
            {
                DrawDoorSidebar();
                GUILayout.EndArea();
                return;
            }
            if (_editMode == EditMode.Partitions)
            {
                DrawPartitionSidebar();
                GUILayout.EndArea();
                return;
            }
            if (_editMode == EditMode.Floors)
            {
                DrawFloorSidebar();
                GUILayout.EndArea();
                return;
            }

            GUILayout.Label("家具配置", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("左側直接拖曳家具。黃色框是目前家具，綠色格是角色互動點。", MessageType.Info);

            string[] names = _layout.Objects.ConvertAll(x => x.Id).ToArray();
            int index = _selected == null ? -1 : _layout.Objects.IndexOf(_selected);
            int next = EditorGUILayout.Popup("選擇家具", Mathf.Max(0, index), names);
            if (names.Length > 0 && (index < 0 || next != index)) _selected = _layout.Objects[next];

            if (_selected != null)
            {
                EditorGUILayout.Space(8f);
                EditorGUILayout.LabelField("ID", _selected.Id);
                EditorGUILayout.LabelField("貼圖", $"{_selected.Sheet} [{string.Join(",", _selected.Atlas)}]");
                EditorGUILayout.LabelField("方向", $"{_selected.NormalizedRotation}°");

                GUILayout.BeginHorizontal();
                if (GUILayout.Button("↶ 左轉 90°")) RotateSelected(-90);
                if (GUILayout.Button("↷ 右轉 90°")) RotateSelected(90);
                GUILayout.EndHorizontal();

                if (GUILayout.Button("＋ 複製選取家具（新增）")) DuplicateSelected();
                GUI.backgroundColor = new Color(1f, 0.55f, 0.55f);
                if (GUILayout.Button("－ 刪除選取家具")) DeleteSelectedFurniture();
                GUI.backgroundColor = Color.white;
                EditorGUILayout.Space(6f);
                EditorGUI.BeginChangeCheck();
                int x = EditorGUILayout.IntField("家具 X", _selected.Pos[0]);
                int y = EditorGUILayout.IntField("家具 Y", _selected.Pos[1]);
                int useX = EditorGUILayout.IntField("互動點 X", _selected.Use[0]);
                int useY = EditorGUILayout.IntField("互動點 Y", _selected.Use[1]);
                if (EditorGUI.EndChangeCheck())
                {
                    _selected.Pos[0] = Mathf.Clamp(x, 0, _layout.Grid.Width - _selected.FootprintWidth);
                    _selected.Pos[1] = Mathf.Clamp(y, 0, _layout.Grid.Height - _selected.FootprintHeight);
                    _selected.Use[0] = Mathf.Clamp(useX, 0, _layout.Grid.Width - 1);
                    _selected.Use[1] = Mathf.Clamp(useY, 0, _layout.Grid.Height - 1);
                    MarkDirty();
                }

                EditorGUILayout.Space(8f);
                if (GUILayout.Button("互動點移到家具下方"))
                {
                    _selected.Use[0] = Mathf.Clamp(_selected.Pos[0] + _selected.FootprintWidth / 2, 0, _layout.Grid.Width - 1);
                    _selected.Use[1] = Mathf.Clamp(_selected.Pos[1] + _selected.FootprintHeight, 0, _layout.Grid.Height - 1);
                    MarkDirty();
                }
            }

            EditorGUILayout.Space(10f);
            DrawFurnitureCatalog();
            GUILayout.FlexibleSpace();
            EditorGUILayout.HelpBox("儲存並重建後，正式 Apartment 場景才會更新。若擺到牆上或堵住通道，EditMode 可達性測試會指出物件 ID。", MessageType.Warning);
            GUILayout.EndArea();
        }

        private void DrawFurnitureCatalog()
        {
            GUILayout.Label("家具圖庫", EditorStyles.boldLabel);
            string[] categories = { "全部", "客廳", "臥室", "廚房", "衛浴" };
            _catalogCategory = GUILayout.Toolbar(_catalogCategory, categories);

            _catalogScroll = EditorGUILayout.BeginScrollView(_catalogScroll, GUILayout.Height(300f));
            int column = 0;
            GUILayout.BeginHorizontal();
            foreach (CatalogItem item in FurnitureCatalog)
            {
                if (_catalogCategory > 0 && item.Category != categories[_catalogCategory]) continue;

                if (column == 2)
                {
                    GUILayout.EndHorizontal();
                    GUILayout.BeginHorizontal();
                    column = 0;
                }

                Rect buttonRect = GUILayoutUtility.GetRect(112f, 92f, GUILayout.Width(112f), GUILayout.Height(92f));
                if (GUI.Button(buttonRect, GUIContent.none)) AddFurnitureFromCatalog(item);
                DrawCatalogThumbnail(buttonRect, item);
                GUI.Label(new Rect(buttonRect.x + 2f, buttonRect.yMax - 20f, buttonRect.width - 4f, 18f), item.Label, CenteredMiniStyle());
                column++;
            }
            GUILayout.EndHorizontal();
            EditorGUILayout.EndScrollView();
            EditorGUILayout.HelpBox("點縮圖會在地圖中央新增家具，再把它拖到房間內。", MessageType.None);
        }

        private void DrawCatalogThumbnail(Rect buttonRect, CatalogItem item)
        {
            Texture2D texture = GetTexture(item.Sheet);
            if (texture == null) return;
            Rect uv = new Rect(
                item.Atlas[0] * AtlasCell / (float)texture.width,
                1f - (item.Atlas[1] + item.Atlas[3]) * AtlasCell / (float)texture.height,
                item.Atlas[2] * AtlasCell / (float)texture.width,
                item.Atlas[3] * AtlasCell / (float)texture.height);
            float maxWidth = buttonRect.width - 12f;
            float maxHeight = buttonRect.height - 28f;
            float scale = Mathf.Min(maxWidth / item.Atlas[2], maxHeight / item.Atlas[3]);
            Rect imageRect = new Rect(
                buttonRect.center.x - item.Atlas[2] * scale * 0.5f,
                buttonRect.y + 5f,
                item.Atlas[2] * scale,
                item.Atlas[3] * scale);
            GUI.DrawTextureWithTexCoords(imageRect, texture, uv, true);
        }

        private void DrawDoorSidebar()
        {
            GUILayout.Label("門位置配置", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("左側青色／粉紅色區塊是門洞。拖曳時只能沿著原本的牆移動，牆面開口會一起更新。", MessageType.Info);

            string[] names = _layout.Doors.ConvertAll(x => x.Id).ToArray();
            int index = _selectedDoor == null ? -1 : _layout.Doors.IndexOf(_selectedDoor);
            if (names.Length > 0)
            {
                int next = EditorGUILayout.Popup("選擇門", Mathf.Max(0, index), names);
                if (index < 0 || next != index) _selectedDoor = _layout.Doors[next];
            }
            else EditorGUILayout.LabelField("選擇門", "目前沒有門");

            if (_selectedDoor != null)
            {
                EditorGUILayout.Space(8f);
                EditorGUILayout.LabelField("ID", _selectedDoor.Id);
                if (TryFindDoorGap(_selectedDoor, out WallRunSpec wall, out int[] gap))
                {
                    EditorGUILayout.LabelField("所在牆面", wall.Dir == "h" ? "水平牆（左右移動）" : "垂直牆（上下移動）");
                    EditorGUILayout.LabelField("門洞寬度", gap[1] + " 格");
                    EditorGUI.BeginChangeCheck();
                    int axis = wall.Dir == "h"
                        ? EditorGUILayout.IntField("門 X", _selectedDoor.Pos[0])
                        : EditorGUILayout.IntField("門 Y", _selectedDoor.Pos[1]);
                    if (EditorGUI.EndChangeCheck()) MoveDoorAlongWall(_selectedDoor, wall, gap, axis);
                }
                else
                {
                    EditorGUILayout.HelpBox("找不到這扇門對應的牆洞，請先檢查 JSON。", MessageType.Error);
                }

                GUI.backgroundColor = new Color(1f, 0.55f, 0.55f);
                if (GUILayout.Button("－ 刪除選取門")) DeleteSelectedDoor();
                GUI.backgroundColor = Color.white;
            }

            EditorGUILayout.Space(10f);
            List<WallRunSpec> walls = _layout.Walls.FindAll(x => !IsOuterWall(x));
            string[] wallNames = walls.ConvertAll(WallLabel).ToArray();
            int wallIndex = _selectedWall == null ? -1 : walls.IndexOf(_selectedWall);
            if (wallNames.Length > 0)
            {
                int nextWall = EditorGUILayout.Popup("新增門所在牆", Mathf.Max(0, wallIndex), wallNames);
                if (wallIndex < 0 || nextWall != wallIndex) _selectedWall = walls[nextWall];
                if (GUILayout.Button("＋ 在此隔間新增門")) AddDoorToSelectedWall();
            }

            GUILayout.FlexibleSpace();
            EditorGUILayout.HelpBox("門只能在同一面牆上移動；若要改到另一面牆，需先調整房間隔間結構。儲存並重建後場景才會更新。", MessageType.Warning);
        }

        private void DrawPartitionSidebar()
        {
            GUILayout.Label("隔間配置", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("紫色是可移動的室內隔間。水平牆只能上下拖，垂直牆只能左右拖；外牆已鎖定。", MessageType.Info);

            List<WallRunSpec> walls = _layout.Walls.FindAll(x => !IsOuterWall(x));
            string[] names = walls.ConvertAll(WallLabel).ToArray();
            int index = _selectedWall == null ? -1 : walls.IndexOf(_selectedWall);
            int next = EditorGUILayout.Popup("選擇隔間", Mathf.Max(0, index), names);
            if (names.Length > 0 && (index < 0 || next != index)) _selectedWall = walls[next];

            if (_selectedWall != null)
            {
                EditorGUILayout.Space(8f);
                EditorGUILayout.LabelField("方向", _selectedWall.Dir == "h" ? "水平（上下移動）" : "垂直（左右移動）");
                EditorGUILayout.LabelField("長度", _selectedWall.Len + " 格");
                EditorGUILayout.LabelField("門洞", _selectedWall.Gaps.Count + " 個");
                EditorGUI.BeginChangeCheck();
                int axis = _selectedWall.Dir == "h"
                    ? EditorGUILayout.IntField("隔間 Y", _selectedWall.Y)
                    : EditorGUILayout.IntField("隔間 X", _selectedWall.X);
                if (EditorGUI.EndChangeCheck()) MovePartitionTo(_selectedWall, axis);

                if (_selectedWall.Gaps.Count == 0)
                {
                    EditorGUI.BeginChangeCheck();
                    int start = _selectedWall.Dir == "h"
                        ? EditorGUILayout.IntField("起點 X", _selectedWall.X)
                        : EditorGUILayout.IntField("起點 Y", _selectedWall.Y);
                    int length = EditorGUILayout.IntField("牆長度", _selectedWall.Len);
                    if (EditorGUI.EndChangeCheck()) ResizeSelectedWall(start, length);
                }
                else EditorGUILayout.HelpBox("牆上有門時，起點與長度會鎖定；請先移除門。", MessageType.None);

                GUI.backgroundColor = new Color(1f, 0.55f, 0.55f);
                if (GUILayout.Button("－ 刪除選取隔間")) DeleteSelectedWall();
                GUI.backgroundColor = Color.white;
            }

            EditorGUILayout.Space(10f);
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("＋ 水平牆")) AddWall("h");
            if (GUILayout.Button("＋ 垂直牆")) AddWall("v");
            GUILayout.EndHorizontal();

            GUILayout.FlexibleSpace();
            EditorGUILayout.HelpBox("移動隔間會同步房間地板邊界、牆上門洞與門的具名位置。家具不會自動搬家，移牆後請切回家具模式整理，再執行 EditMode 測試。", MessageType.Warning);
        }

        private void DrawFloorSidebar()
        {
            GUILayout.Label("地板配置", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("先選地板材質，再於左側格線按住滑鼠左鍵拖曳。放開後會新增一塊矩形地板覆蓋區。", MessageType.Info);

            var floorNames = new List<string>(_layout.FloorTiles.Keys);
            floorNames.Sort(StringComparer.Ordinal);
            if (floorNames.Count > 0)
            {
                int floorIndex = Mathf.Max(0, floorNames.IndexOf(_paintFloor));
                _paintFloor = floorNames[EditorGUILayout.Popup("地板材質", floorIndex, floorNames.ToArray())];
                Rect sample = GUILayoutUtility.GetRect(1f, 28f, GUILayout.ExpandWidth(true));
                EditorGUI.DrawRect(sample, RoomColor(_paintFloor));
                GUI.Label(sample, _paintFloor, EditorStyles.whiteBoldLabel);
            }

            EditorGUILayout.Space(12f);
            string[] overlays = new string[_layout.ExtraFloor.Count];
            for (int i = 0; i < _layout.ExtraFloor.Count; i++)
            {
                ExtraFloorSpec floor = _layout.ExtraFloor[i];
                overlays[i] = $"#{i + 1} {floor.Floor} ({floor.Rect[0]},{floor.Rect[1]}) {floor.Rect[2]}x{floor.Rect[3]}";
            }
            if (overlays.Length > 0)
            {
                int selectedIndex = _selectedFloor == null ? -1 : _layout.ExtraFloor.IndexOf(_selectedFloor);
                int next = EditorGUILayout.Popup("已鋪區塊", Mathf.Max(0, selectedIndex), overlays);
                if (selectedIndex < 0 || next != selectedIndex) _selectedFloor = _layout.ExtraFloor[next];

                GUI.backgroundColor = new Color(1f, 0.55f, 0.55f);
                if (GUILayout.Button("刪除選取地板區塊")) DeleteSelectedFloor();
                GUI.backgroundColor = Color.white;
            }
            else EditorGUILayout.LabelField("已鋪區塊", "尚無額外地板");

            GUILayout.FlexibleSpace();
            EditorGUILayout.HelpBox("新鋪區塊會覆蓋 rooms 的基礎地板；若重疊，以清單中較後面的區塊為準。完成後按「儲存並重建場景」。", MessageType.Warning);
        }

        private void HandleCanvasInput(Rect area)
        {
            Event e = Event.current;
            if (!area.Contains(e.mousePosition) || _lastCell <= 0f) return;

            int cellX = Mathf.FloorToInt((e.mousePosition.x - _lastMapRect.x) / _lastCell);
            int cellY = Mathf.FloorToInt((e.mousePosition.y - _lastMapRect.y) / _lastCell);
            if (e.type == EventType.MouseDown && e.button == 0)
            {
                if (_editMode == EditMode.Floors)
                {
                    _floorDragStart = new Vector2Int(
                        Mathf.Clamp(cellX, 0, _layout.Grid.Width - 1),
                        Mathf.Clamp(cellY, 0, _layout.Grid.Height - 1));
                    _floorDragCurrent = _floorDragStart;
                    _drawingFloor = true;
                    e.Use();
                    Repaint();
                    return;
                }

                if (_editMode == EditMode.Partitions)
                {
                    for (int i = _layout.Walls.Count - 1; i >= 0; i--)
                    {
                        WallRunSpec wall = _layout.Walls[i];
                        if (IsOuterWall(wall)) continue;
                        int width = wall.Dir == "h" ? wall.Len : 1;
                        int height = wall.Dir == "h" ? 2 : wall.Len;
                        if (cellX < wall.X || cellY < wall.Y ||
                            cellX >= wall.X + width || cellY >= wall.Y + height) continue;
                        _selectedWall = wall;
                        _dragging = true;
                        e.Use();
                        Repaint();
                        return;
                    }
                    return;
                }

                if (_editMode == EditMode.Doors)
                {
                    for (int i = _layout.Doors.Count - 1; i >= 0; i--)
                    {
                        DoorSpec door = _layout.Doors[i];
                        int width = 1;
                        int height = 1;
                        TryFindDoorGap(door, out WallRunSpec wall, out int[] gap);
                        if (wall != null && wall.Dir == "h") width = gap[1];
                        else if (wall != null) height = gap[1];
                        if (cellX < door.Pos[0] || cellY < door.Pos[1] ||
                            cellX >= door.Pos[0] + width || cellY >= door.Pos[1] + height) continue;
                        _selectedDoor = door;
                        _dragDoorWall = wall;
                        _dragDoorGap = gap;
                        _dragOffset = new Vector2Int(cellX - door.Pos[0], cellY - door.Pos[1]);
                        _dragging = wall != null;
                        e.Use();
                        Repaint();
                        return;
                    }
                    return;
                }

                for (int i = _layout.Objects.Count - 1; i >= 0; i--)
                {
                    ObjectSpec obj = _layout.Objects[i];
                    if (cellX < obj.Pos[0] || cellY < obj.Pos[1] ||
                        cellX >= obj.Pos[0] + obj.FootprintWidth || cellY >= obj.Pos[1] + obj.FootprintHeight) continue;
                    _selected = obj;
                    _dragOffset = new Vector2Int(cellX - obj.Pos[0], cellY - obj.Pos[1]);
                    _dragging = true;
                    e.Use();
                    Repaint();
                    return;
                }
            }
            else if (e.type == EventType.MouseDrag && e.button == 0 && _dragging)
            {
                if (_editMode == EditMode.Partitions && _selectedWall != null)
                {
                    MovePartitionTo(_selectedWall, _selectedWall.Dir == "h" ? cellY : cellX);
                    e.Use();
                    return;
                }

                if (_editMode == EditMode.Doors && _selectedDoor != null && _dragDoorWall != null)
                {
                    int axis = _dragDoorWall.Dir == "h" ? cellX - _dragOffset.x : cellY - _dragOffset.y;
                    MoveDoorAlongWall(_selectedDoor, _dragDoorWall, _dragDoorGap, axis);
                    e.Use();
                    return;
                }

                if (_selected == null) return;
                int oldX = _selected.Pos[0];
                int oldY = _selected.Pos[1];
                int nextX = Mathf.Clamp(cellX - _dragOffset.x, 0, _layout.Grid.Width - _selected.FootprintWidth);
                int nextY = Mathf.Clamp(cellY - _dragOffset.y, 0, _layout.Grid.Height - _selected.FootprintHeight);
                int dx = nextX - oldX;
                int dy = nextY - oldY;
                _selected.Pos[0] = nextX;
                _selected.Pos[1] = nextY;
                _selected.Use[0] = Mathf.Clamp(_selected.Use[0] + dx, 0, _layout.Grid.Width - 1);
                _selected.Use[1] = Mathf.Clamp(_selected.Use[1] + dy, 0, _layout.Grid.Height - 1);
                MarkDirty();
                e.Use();
            }
            else if (e.type == EventType.MouseDrag && e.button == 0 && _drawingFloor)
            {
                _floorDragCurrent = new Vector2Int(
                    Mathf.Clamp(cellX, 0, _layout.Grid.Width - 1),
                    Mathf.Clamp(cellY, 0, _layout.Grid.Height - 1));
                e.Use();
                Repaint();
            }
            else if (e.type == EventType.MouseUp && e.button == 0 && _drawingFloor)
            {
                _floorDragCurrent = new Vector2Int(
                    Mathf.Clamp(cellX, 0, _layout.Grid.Width - 1),
                    Mathf.Clamp(cellY, 0, _layout.Grid.Height - 1));
                AddFloorRect();
                _drawingFloor = false;
                e.Use();
            }
            else if (e.type == EventType.MouseUp && e.button == 0 && _dragging)
            {
                _dragging = false;
                _dragDoorWall = null;
                _dragDoorGap = null;
                e.Use();
            }
        }

        private void LoadLayout()
        {
            try
            {
                _layout = JsonConvert.DeserializeObject<ApartmentLayout>(File.ReadAllText(LayoutPath));
                _selected = _layout != null && _layout.Objects.Count > 0 ? _layout.Objects[0] : null;
                _selectedDoor = _layout != null && _layout.Doors.Count > 0 ? _layout.Doors[0] : null;
                _selectedWall = _layout?.Walls.Find(x => !IsOuterWall(x));
                _selectedFloor = _layout != null && _layout.ExtraFloor.Count > 0 ? _layout.ExtraFloor[_layout.ExtraFloor.Count - 1] : null;
                if (_layout != null && !_layout.FloorTiles.ContainsKey(_paintFloor) && _layout.FloorTiles.Count > 0)
                    _paintFloor = new List<string>(_layout.FloorTiles.Keys)[0];
                _textures.Clear();
                _dirty = false;
                _message = $"已載入 {_layout?.Objects.Count ?? 0} 件家具。";
            }
            catch (Exception ex)
            {
                _layout = null;
                _message = "載入失敗：" + ex.Message;
            }
        }

        private void ReloadWithConfirmation()
        {
            if (_dirty && !EditorUtility.DisplayDialog("放棄未儲存變更？", "重新載入會放棄目前拖曳結果。", "重新載入", "取消")) return;
            LoadLayout();
            Repaint();
        }

        private void Save(bool rebuild)
        {
            File.WriteAllText(LayoutPath, JsonConvert.SerializeObject(_layout, Formatting.Indented) + Environment.NewLine, new UTF8Encoding(false));
            AssetDatabase.ImportAsset(LayoutPath, ImportAssetOptions.ForceSynchronousImport);
            _dirty = false;
            _message = rebuild ? "已儲存，正在重建 Apartment 場景。" : "已儲存 apartment-layout.json。";
            if (rebuild) ApartmentSceneBuilder.Build();
            Repaint();
        }

        private Texture2D GetTexture(string sheet)
        {
            if (_textures.TryGetValue(sheet, out Texture2D cached)) return cached;
            if (!_layout.Sheets.TryGetValue(sheet, out string file)) return null;
            Texture2D texture = AssetDatabase.LoadAssetAtPath<Texture2D>($"{TilesetDir}/{file}.png");
            _textures[sheet] = texture;
            return texture;
        }

        private void MarkDirty()
        {
            _dirty = true;
            _message = $"已移動 {_selected?.Id}；尚未儲存。";
            Repaint();
        }

        private void SetEditMode(EditMode mode)
        {
            _editMode = mode;
            _dragging = false;
            _drawingFloor = false;
            _dragDoorWall = null;
            _dragDoorGap = null;
            _message = mode switch
            {
                EditMode.Doors => "門模式：拖曳彩色門洞，會同步移動牆面開口。",
                EditMode.Partitions => "隔間模式：拖曳紫色內牆，會同步房間與門洞。",
                EditMode.Floors => "地板模式：選擇材質後，在格線拖曳要鋪設的矩形範圍。",
                _ => "家具模式：點選家具後拖曳，放開即吸附格線。"
            };
            Repaint();
        }

        private void AddFloorRect()
        {
            int minX = Mathf.Min(_floorDragStart.x, _floorDragCurrent.x);
            int minY = Mathf.Min(_floorDragStart.y, _floorDragCurrent.y);
            int width = Mathf.Abs(_floorDragCurrent.x - _floorDragStart.x) + 1;
            int height = Mathf.Abs(_floorDragCurrent.y - _floorDragStart.y) + 1;
            var floor = new ExtraFloorSpec
            {
                Rect = new[] { minX, minY, width, height },
                Floor = _paintFloor
            };
            _layout.ExtraFloor.Add(floor);
            _selectedFloor = floor;
            _dirty = true;
            _message = $"已鋪設 {_paintFloor} 地板：({minX},{minY}) {width}x{height}，尚未儲存。";
            Repaint();
        }

        private void DeleteSelectedFloor()
        {
            if (_selectedFloor == null) return;
            int index = _layout.ExtraFloor.IndexOf(_selectedFloor);
            _layout.ExtraFloor.Remove(_selectedFloor);
            _selectedFloor = _layout.ExtraFloor.Count == 0
                ? null
                : _layout.ExtraFloor[Mathf.Clamp(index - 1, 0, _layout.ExtraFloor.Count - 1)];
            _dirty = true;
            _message = "已刪除選取的地板區塊，尚未儲存。";
            Repaint();
        }

        private void DeleteSelectedFurniture()
        {
            if (_selected == null) return;
            string id = _selected.Id;
            if (!EditorUtility.DisplayDialog("刪除家具？", $"確定要刪除 {id}？儲存後會從公寓場景移除。", "刪除", "取消")) return;

            int index = _layout.Objects.IndexOf(_selected);
            _layout.Objects.Remove(_selected);
            _selected = _layout.Objects.Count == 0
                ? null
                : _layout.Objects[Mathf.Clamp(index - 1, 0, _layout.Objects.Count - 1)];
            _dirty = true;
            _message = $"已刪除 {id}；尚未儲存。";
            Repaint();
        }

        private bool IsOuterWall(WallRunSpec wall) => wall.Dir == "h"
            ? wall.Y <= 0 || wall.Y >= _layout.Grid.Height - 2
            : wall.X <= 0 || wall.X >= _layout.Grid.Width - 1;

        private string WallLabel(WallRunSpec wall)
        {
            int index = _layout.Walls.IndexOf(wall) + 1;
            string direction = wall.Dir == "h" ? "水平牆" : "垂直牆";
            return $"{direction} #{index} ({wall.X},{wall.Y}) 長{wall.Len}";
        }

        private void AddWall(string direction)
        {
            var wall = new WallRunSpec
            {
                Dir = direction,
                X = direction == "h" ? Mathf.Max(1, _layout.Grid.Width / 2 - 4) : _layout.Grid.Width / 2,
                Y = direction == "h" ? Mathf.Max(1, _layout.Grid.Height / 2 - 1) : Mathf.Max(1, _layout.Grid.Height / 2 - 4),
                Len = 8,
                Gaps = new List<int[]>()
            };
            if (direction == "h") wall.Len = Mathf.Min(wall.Len, _layout.Grid.Width - wall.X);
            else wall.Len = Mathf.Min(wall.Len, _layout.Grid.Height - wall.Y);
            _layout.Walls.Add(wall);
            _selectedWall = wall;
            _dirty = true;
            _message = direction == "h" ? "已新增水平牆；請拖到位置並調整長度。" : "已新增垂直牆；請拖到位置並調整長度。";
            Repaint();
        }

        private void ResizeSelectedWall(int requestedStart, int requestedLength)
        {
            if (_selectedWall == null || _selectedWall.Gaps.Count > 0) return;
            int limit = _selectedWall.Dir == "h" ? _layout.Grid.Width : _layout.Grid.Height;
            int start = Mathf.Clamp(requestedStart, 0, limit - 2);
            int length = Mathf.Clamp(requestedLength, 2, limit - start);
            if (_selectedWall.Dir == "h") _selectedWall.X = start;
            else _selectedWall.Y = start;
            _selectedWall.Len = length;
            _dirty = true;
            _message = "已調整隔間起點與長度；尚未儲存。";
            Repaint();
        }

        private void DeleteSelectedWall()
        {
            if (_selectedWall == null || IsOuterWall(_selectedWall)) return;
            List<DoorSpec> doors = _layout.Doors.FindAll(door =>
                TryFindDoorGap(door, out WallRunSpec owner, out _) && owner == _selectedWall);
            string detail = doors.Count > 0
                ? $"這面牆上有 {doors.Count} 扇門，刪牆時會一併刪除門與門洞。"
                : "牆面所在格會補上相鄰房間的地板。";
            if (!EditorUtility.DisplayDialog("刪除選取隔間？", detail, "刪除", "取消")) return;

            string floor = FindFloorForWall(_selectedWall);
            int[] fillRect = _selectedWall.Dir == "h"
                ? new[] { _selectedWall.X, _selectedWall.Y, _selectedWall.Len, 2 }
                : new[] { _selectedWall.X, _selectedWall.Y, 1, _selectedWall.Len };
            foreach (DoorSpec door in doors) DeleteDoorCore(door);
            _layout.ExtraFloor.Add(new ExtraFloorSpec { Rect = fillRect, Floor = floor });
            _layout.Walls.Remove(_selectedWall);
            _selectedWall = _layout.Walls.Find(x => !IsOuterWall(x));
            _dirty = true;
            _message = $"已刪除隔間{(doors.Count > 0 ? $"及 {doors.Count} 扇門" : string.Empty)}；尚未儲存。";
            Repaint();
        }

        private void AddDoorToSelectedWall()
        {
            if (_selectedWall == null || IsOuterWall(_selectedWall)) return;
            const int gapLength = 2;
            if (_selectedWall.Len < gapLength)
            {
                _message = "隔間長度不足，至少需要 2 格才能加門。";
                Repaint();
                return;
            }

            int wallStart = _selectedWall.Dir == "h" ? _selectedWall.X : _selectedWall.Y;
            int preferred = wallStart + Mathf.Max(0, (_selectedWall.Len - gapLength) / 2);
            int gapStart = -1;
            for (int offset = 0; offset <= _selectedWall.Len - gapLength; offset++)
            {
                int candidate = wallStart + ((preferred - wallStart + offset) % (_selectedWall.Len - gapLength + 1));
                bool overlaps = _selectedWall.Gaps.Exists(gap => IntervalsOverlap(candidate, gapLength, gap[0], gap[1]));
                if (!overlaps) { gapStart = candidate; break; }
            }
            if (gapStart < 0)
            {
                _message = "這面隔間已沒有足夠的連續空間新增 2 格門洞。";
                Repaint();
                return;
            }

            int suffix = 1;
            string id;
            do id = "door_custom_" + suffix++; while (_layout.Doors.Exists(x => x.Id == id));
            var gapSpec = new[] { gapStart, gapLength };
            var door = new DoorSpec
            {
                Id = id,
                Pos = _selectedWall.Dir == "h"
                    ? new[] { gapStart, _selectedWall.Y + 1 }
                    : new[] { _selectedWall.X, gapStart }
            };
            _selectedWall.Gaps.Add(gapSpec);
            _layout.Doors.Add(door);
            _layout.ExtraFloor.Add(new ExtraFloorSpec
            {
                Rect = _selectedWall.Dir == "h"
                    ? new[] { gapStart, _selectedWall.Y, gapLength, 2 }
                    : new[] { _selectedWall.X, gapStart, 1, gapLength },
                Floor = FindFloorForWall(_selectedWall)
            });
            _selectedDoor = door;
            _dirty = true;
            _message = $"已新增 {id} 與門洞；可直接拖曳調整位置。";
            Repaint();
        }

        private void DeleteSelectedDoor()
        {
            if (_selectedDoor == null) return;
            string id = _selectedDoor.Id;
            if (!EditorUtility.DisplayDialog("刪除選取門？", $"將刪除 {id} 與牆上的門洞。", "刪除", "取消")) return;
            DeleteDoorCore(_selectedDoor);
            _selectedDoor = _layout.Doors.Count > 0 ? _layout.Doors[0] : null;
            _dirty = true;
            _message = $"已刪除 {id} 與門洞；尚未儲存。";
            Repaint();
        }

        private void DeleteDoorCore(DoorSpec door)
        {
            if (TryFindDoorGap(door, out WallRunSpec wall, out int[] gap))
            {
                _layout.ExtraFloor.RemoveAll(floor => wall.Dir == "h"
                    ? floor.Rect[0] == gap[0] && floor.Rect[1] == wall.Y && floor.Rect[2] == gap[1]
                    : floor.Rect[0] == wall.X && floor.Rect[1] == gap[0] && floor.Rect[3] == gap[1]);
                wall.Gaps.Remove(gap);
            }
            _layout.Doors.Remove(door);
        }

        private string FindFloorForWall(WallRunSpec wall)
        {
            RoomSpec room = _layout.Rooms.Find(candidate => wall.Dir == "h"
                ? (candidate.Rect[1] + candidate.Rect[3] == wall.Y || candidate.Rect[1] == wall.Y + 2) &&
                  IntervalsOverlap(candidate.Rect[0], candidate.Rect[2], wall.X, wall.Len)
                : (candidate.Rect[0] + candidate.Rect[2] == wall.X || candidate.Rect[0] == wall.X + 1) &&
                  IntervalsOverlap(candidate.Rect[1], candidate.Rect[3], wall.Y, wall.Len));
            if (room != null) return room.Floor;

            int sampleX = wall.X + (wall.Dir == "h" ? wall.Len / 2 : 0);
            int sampleY = wall.Y + (wall.Dir == "v" ? wall.Len / 2 : 0);
            room = _layout.Rooms.Find(candidate =>
                sampleX >= candidate.Rect[0] && sampleX < candidate.Rect[0] + candidate.Rect[2] &&
                sampleY >= candidate.Rect[1] && sampleY < candidate.Rect[1] + candidate.Rect[3]);
            return room?.Floor ?? "hall";
        }

        private void MovePartitionTo(WallRunSpec wall, int requestedAxis)
        {
            int oldAxis = wall.Dir == "h" ? wall.Y : wall.X;
            int maxAxis = wall.Dir == "h" ? _layout.Grid.Height - 3 : _layout.Grid.Width - 2;
            int nextAxis = Mathf.Clamp(requestedAxis, 1, maxAxis);
            int delta = nextAxis - oldAxis;
            if (delta == 0) return;

            List<WallRunSpec> group = _layout.Walls.FindAll(candidate =>
                candidate.Dir == wall.Dir &&
                (candidate.Dir == "h" ? candidate.Y : candidate.X) == oldAxis &&
                IntervalsOverlap(
                    candidate.Dir == "h" ? candidate.X : candidate.Y, candidate.Len,
                    wall.Dir == "h" ? wall.X : wall.Y, wall.Len));

            if (!CanResizeAdjacentRooms(wall.Dir, oldAxis, delta, group))
            {
                _message = "無法再移動：相鄰房間至少必須保留 2 格寬／高。";
                Repaint();
                return;
            }

            foreach (RoomSpec room in _layout.Rooms)
            {
                if (!RoomOverlapsWallSpan(room, wall.Dir, group)) continue;
                if (wall.Dir == "h")
                {
                    if (room.Rect[1] + room.Rect[3] == oldAxis) room.Rect[3] += delta;
                    else if (room.Rect[1] == oldAxis + 2)
                    {
                        room.Rect[1] += delta;
                        room.Rect[3] -= delta;
                    }
                }
                else
                {
                    if (room.Rect[0] + room.Rect[2] == oldAxis) room.Rect[2] += delta;
                    else if (room.Rect[0] == oldAxis + 1)
                    {
                        room.Rect[0] += delta;
                        room.Rect[2] -= delta;
                    }
                }
            }

            foreach (DoorSpec door in _layout.Doors)
            {
                bool onGroup = group.Exists(member => wall.Dir == "h"
                    ? (door.Pos[1] == oldAxis || door.Pos[1] == oldAxis + 1) &&
                      door.Pos[0] >= member.X && door.Pos[0] < member.X + member.Len
                    : door.Pos[0] == oldAxis &&
                      door.Pos[1] >= member.Y && door.Pos[1] < member.Y + member.Len);
                if (!onGroup) continue;
                if (wall.Dir == "h") door.Pos[1] += delta;
                else door.Pos[0] += delta;
            }

            foreach (ExtraFloorSpec floor in _layout.ExtraFloor)
            {
                bool onGroup = group.Exists(member => wall.Dir == "h"
                    ? floor.Rect[1] == oldAxis && IntervalsOverlap(floor.Rect[0], floor.Rect[2], member.X, member.Len)
                    : floor.Rect[0] == oldAxis && IntervalsOverlap(floor.Rect[1], floor.Rect[3], member.Y, member.Len));
                if (!onGroup) continue;
                if (wall.Dir == "h") floor.Rect[1] += delta;
                else floor.Rect[0] += delta;
            }

            foreach (WallRunSpec member in group)
            {
                if (member.Dir == "h") member.Y += delta;
                else member.X += delta;
            }

            _dirty = true;
            int collisions = CountFurnitureIntersections(group);
            _message = collisions > 0
                ? $"隔間已移動，但碰到 {collisions} 件家具；請切回家具模式整理。"
                : "隔間、房間邊界與門洞已同步移動；尚未儲存。";
            Repaint();
        }

        private bool CanResizeAdjacentRooms(string dir, int oldAxis, int delta, List<WallRunSpec> group)
        {
            foreach (RoomSpec room in _layout.Rooms)
            {
                if (!RoomOverlapsWallSpan(room, dir, group)) continue;
                if (dir == "h")
                {
                    if (room.Rect[1] + room.Rect[3] == oldAxis && room.Rect[3] + delta < 2) return false;
                    if (room.Rect[1] == oldAxis + 2 && room.Rect[3] - delta < 2) return false;
                }
                else
                {
                    if (room.Rect[0] + room.Rect[2] == oldAxis && room.Rect[2] + delta < 2) return false;
                    if (room.Rect[0] == oldAxis + 1 && room.Rect[2] - delta < 2) return false;
                }
            }
            return true;
        }

        private static bool RoomOverlapsWallSpan(RoomSpec room, string dir, List<WallRunSpec> group) =>
            group.Exists(member => dir == "h"
                ? IntervalsOverlap(room.Rect[0], room.Rect[2], member.X, member.Len)
                : IntervalsOverlap(room.Rect[1], room.Rect[3], member.Y, member.Len));

        private int CountFurnitureIntersections(List<WallRunSpec> group)
        {
            int count = 0;
            foreach (ObjectSpec obj in _layout.Objects)
            {
                bool hit = group.Exists(wall => wall.Dir == "h"
                    ? RectanglesOverlap(obj.Pos[0], obj.Pos[1], obj.FootprintWidth, obj.FootprintHeight,
                        wall.X, wall.Y, wall.Len, 2)
                    : RectanglesOverlap(obj.Pos[0], obj.Pos[1], obj.FootprintWidth, obj.FootprintHeight,
                        wall.X, wall.Y, 1, wall.Len));
                if (hit) count++;
            }
            return count;
        }

        private static bool IntervalsOverlap(int a, int aLength, int b, int bLength) =>
            a < b + bLength && b < a + aLength;

        private static bool RectanglesOverlap(int ax, int ay, int aw, int ah, int bx, int by, int bw, int bh) =>
            IntervalsOverlap(ax, aw, bx, bw) && IntervalsOverlap(ay, ah, by, bh);

        private bool TryFindDoorGap(DoorSpec door, out WallRunSpec foundWall, out int[] foundGap)
        {
            foreach (WallRunSpec wall in _layout.Walls)
            {
                foreach (int[] gap in wall.Gaps)
                {
                    bool matches = wall.Dir == "h"
                        ? gap[0] == door.Pos[0] && (door.Pos[1] == wall.Y || door.Pos[1] == wall.Y + 1)
                        : gap[0] == door.Pos[1] && door.Pos[0] == wall.X;
                    if (!matches) continue;
                    foundWall = wall;
                    foundGap = gap;
                    return true;
                }
            }

            foundWall = null;
            foundGap = null;
            return false;
        }

        private void MoveDoorAlongWall(DoorSpec door, WallRunSpec wall, int[] gap, int requestedAxis)
        {
            int start = wall.Dir == "h" ? wall.X : wall.Y;
            int next = Mathf.Clamp(requestedAxis, start, start + wall.Len - gap[1]);
            gap[0] = next;
            if (wall.Dir == "h") door.Pos[0] = next;
            else door.Pos[1] = next;
            _dirty = true;
            _message = $"已移動 {door.Id} 並同步牆洞；尚未儲存。";
            Repaint();
        }

        private void RotateSelected(int delta)
        {
            if (_selected == null) return;
            _selected.Rotation = (_selected.NormalizedRotation + delta + 360) % 360;
            _selected.Pos[0] = Mathf.Clamp(_selected.Pos[0], 0, _layout.Grid.Width - _selected.FootprintWidth);
            _selected.Pos[1] = Mathf.Clamp(_selected.Pos[1], 0, _layout.Grid.Height - _selected.FootprintHeight);
            _dirty = true;
            _message = $"已將 {_selected.Id} 旋轉為 {_selected.NormalizedRotation}°；尚未儲存。";
            Repaint();
        }

        private void DuplicateSelected()
        {
            if (_selected == null) return;
            ObjectSpec clone = JsonConvert.DeserializeObject<ObjectSpec>(
                JsonConvert.SerializeObject(_selected));
            string root = _selected.Id + "_copy";
            string candidate = root;
            int suffix = 2;
            while (_layout.Objects.Exists(x => x.Id == candidate)) candidate = root + "_" + suffix++;
            clone.Id = candidate;
            clone.Pos[0] = Mathf.Clamp(clone.Pos[0] + 1, 0, _layout.Grid.Width - clone.FootprintWidth);
            clone.Pos[1] = Mathf.Clamp(clone.Pos[1] + 1, 0, _layout.Grid.Height - clone.FootprintHeight);
            clone.Use[0] = Mathf.Clamp(clone.Use[0] + 1, 0, _layout.Grid.Width - 1);
            clone.Use[1] = Mathf.Clamp(clone.Use[1] + 1, 0, _layout.Grid.Height - 1);
            _layout.Objects.Add(clone);
            _selected = clone;
            _dirty = true;
            _message = $"已新增 {clone.Id}；拖到位置後記得儲存。";
            Repaint();
        }

        private void AddFurnitureFromCatalog(CatalogItem item)
        {
            string candidate = item.IdPrefix + "_custom_1";
            int suffix = 2;
            while (_layout.Objects.Exists(x => x.Id == candidate))
                candidate = item.IdPrefix + "_custom_" + suffix++;

            int width = item.Atlas[2];
            int height = item.Atlas[3];
            int x = Mathf.Clamp(_layout.Grid.Width / 2 - width / 2, 0, _layout.Grid.Width - width);
            int y = Mathf.Clamp(_layout.Grid.Height / 2 - height / 2, 0, _layout.Grid.Height - height);
            var furniture = new ObjectSpec
            {
                Id = candidate,
                Sheet = item.Sheet,
                Atlas = (int[])item.Atlas.Clone(),
                Pos = new[] { x, y },
                Use = new[]
                {
                    Mathf.Clamp(x + width / 2, 0, _layout.Grid.Width - 1),
                    Mathf.Clamp(y + height, 0, _layout.Grid.Height - 1)
                },
                Walkable = item.Walkable
            };
            _layout.Objects.Add(furniture);
            _selected = furniture;
            _dirty = true;
            _message = $"已從圖庫新增 {item.Label}（{candidate}）；請拖到正確位置。";
            Repaint();
        }

        private static Rect ToRect(Rect map, float cell, int x, int y, int width, int height) =>
            new Rect(map.x + x * cell, map.y + y * cell, width * cell, height * cell);

        private static Color RoomColor(string floor) => floor switch
        {
            "bedroom" => new Color(0.30f, 0.25f, 0.20f),
            "bath" => new Color(0.20f, 0.37f, 0.42f),
            "kitchen" => new Color(0.38f, 0.22f, 0.20f),
            "balcony" => new Color(0.28f, 0.31f, 0.32f),
            "hall" => new Color(0.31f, 0.31f, 0.33f),
            _ => new Color(0.42f, 0.34f, 0.18f)
        };

        private static GUIStyle CenteredMiniStyle()
        {
            var style = new GUIStyle(EditorStyles.miniBoldLabel) { alignment = TextAnchor.MiddleCenter };
            style.normal.textColor = Color.white;
            return style;
        }
    }
}
