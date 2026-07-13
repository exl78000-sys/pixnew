using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace Pixnew.Sim
{
    /// <summary>
    /// 邏輯世界網格(純 C#,僅用 UnityEngine 數學型別)。
    /// 由 ApartmentScene 在啟動時烘焙:Tilemap 碰撞(Walls + 不可踩 Furniture)+ 佈局 JSON。
    /// 座標系:格為單位,x 向右、y 向下(與 apartment-layout.json 一致)。
    /// A* 尋路於 M1-T2(P-04)加入。
    /// </summary>
    public class WorldGrid
    {
        /// <summary>網格寬(格)</summary>
        public int Width { get; }

        /// <summary>網格高(格)</summary>
        public int Height { get; }

        private readonly bool[,] _walkable;
        private readonly List<(string id, RectInt rect)> _rooms = new();
        private readonly Dictionary<string, ObjectPoint> _objects = new();

        /// <summary>具名物件點位:佔用矩形 + 互動點</summary>
        public readonly struct ObjectPoint
        {
            public ObjectPoint(RectInt rect, Vector2Int usePoint)
            {
                Rect = rect;
                UsePoint = usePoint;
            }

            /// <summary>物件佔用的格矩形</summary>
            public RectInt Rect { get; }

            /// <summary>互動點(相鄰可走格)</summary>
            public Vector2Int UsePoint { get; }
        }

        public WorldGrid(int width, int height)
        {
            Width = width;
            Height = height;
            _walkable = new bool[width, height];
        }

        /// <summary>設定單格可走性(烘焙時由 ApartmentScene 呼叫)</summary>
        public void SetWalkable(int x, int y, bool walkable)
        {
            if (InBounds(x, y)) _walkable[x, y] = walkable;
        }

        /// <summary>登記房間範圍</summary>
        public void AddRoom(string id, RectInt rect) => _rooms.Add((id, rect));

        /// <summary>登記具名物件(床、爐台、門等)</summary>
        public void AddObject(string id, RectInt rect, Vector2Int usePoint) =>
            _objects[id] = new ObjectPoint(rect, usePoint);

        /// <summary>座標是否在網格內</summary>
        public bool InBounds(int x, int y) => x >= 0 && x < Width && y >= 0 && y < Height;

        /// <summary>該格是否可行走</summary>
        public bool IsWalkable(int x, int y) => InBounds(x, y) && _walkable[x, y];

        /// <summary>可行走格總數</summary>
        public int WalkableCount
        {
            get
            {
                int n = 0;
                for (int x = 0; x < Width; x++)
                    for (int y = 0; y < Height; y++)
                        if (_walkable[x, y]) n++;
                return n;
            }
        }

        /// <summary>房間數</summary>
        public int RoomCount => _rooms.Count;

        /// <summary>物件點位數</summary>
        public int ObjectCount => _objects.Count;

        /// <summary>查座標所在房間 id;不在任何房間回傳 null</summary>
        public string RoomAt(Vector2Int pos)
        {
            foreach (var (id, rect) in _rooms)
                if (rect.Contains(pos)) return id;
            return null;
        }

        /// <summary>查具名物件的互動點</summary>
        public bool TryGetUsePoint(string objectId, out Vector2Int usePoint)
        {
            if (_objects.TryGetValue(objectId, out var p))
            {
                usePoint = p.UsePoint;
                return true;
            }
            usePoint = default;
            return false;
        }

        // ── 角色移動(P-04)────────────────────────────

        /// <summary>單一角色的移動狀態</summary>
        public class AgentMotion
        {
            /// <summary>角色 id</summary>
            public string Id;

            /// <summary>目前所在格</summary>
            public Vector2Int Pos;

            /// <summary>上一格(供呈現層插值)</summary>
            public Vector2Int PrevPos;

            /// <summary>剩餘路徑(下一格在最前)</summary>
            public readonly Queue<Vector2Int> Path = new();

            /// <summary>目前目標物件 id(無移動時為 null)</summary>
            public string TargetObject;

            /// <summary>是否正在移動</summary>
            public bool IsMoving => Path.Count > 0;
        }

        private readonly Dictionary<string, AgentMotion> _agents = new();

        /// <summary>角色前進一格時廣播(呈現層據此沿逐格軌跡插值,高速下不抄捷徑穿牆)</summary>
        public event System.Action<AgentMotion> OnAgentStepped;

        /// <summary>所有已註冊角色</summary>
        public IEnumerable<AgentMotion> Agents => _agents.Values;

        /// <summary>所有具名物件 id(隨機遊走測試用)</summary>
        public IEnumerable<string> ObjectIds => _objects.Keys;

        /// <summary>註冊角色於起始格</summary>
        public AgentMotion RegisterAgent(string id, Vector2Int startPos)
        {
            var a = new AgentMotion { Id = id, Pos = startPos, PrevPos = startPos };
            _agents[id] = a;
            return a;
        }

        /// <summary>查角色移動狀態</summary>
        public AgentMotion GetAgent(string id) => _agents.TryGetValue(id, out var a) ? a : null;

        /// <summary>
        /// 指派角色走向具名物件的互動點。
        /// 目的格互斥:若已有他人以同格為目標,改為該格相鄰的可走格。
        /// 回傳是否成功排路。
        /// </summary>
        public bool MoveAgentTo(string agentId, string objectId)
        {
            var agent = GetAgent(agentId);
            if (agent == null || !TryGetUsePoint(objectId, out var target)) return false;

            if (IsTargetTaken(agentId, target))
            {
                if (!TryFindFreeNeighbor(agentId, target, out target)) return false;
            }

            var path = Pathfinder.FindPath(this, agent.Pos, target);
            if (path == null) return false;

            agent.Path.Clear();
            foreach (var p in path) agent.Path.Enqueue(p);
            agent.TargetObject = objectId;
            return true;
        }

        /// <summary>每模擬分鐘呼叫一次:所有移動中角色沿路徑前進一格</summary>
        public void Step()
        {
            foreach (var a in _agents.Values)
            {
                a.PrevPos = a.Pos;
                if (a.Path.Count == 0) continue;
                a.Pos = a.Path.Dequeue();
                if (a.Path.Count == 0) a.TargetObject = null;
                OnAgentStepped?.Invoke(a);
            }
        }

        private bool IsTargetTaken(string exceptAgentId, Vector2Int cell)
        {
            foreach (var a in _agents.Values)
            {
                if (a.Id == exceptAgentId) continue;
                var dest = a.IsMoving ? Last(a.Path) : a.Pos;
                if (dest == cell) return true;
            }
            return false;
        }

        private static Vector2Int Last(Queue<Vector2Int> q)
        {
            Vector2Int last = default;
            foreach (var p in q) last = p;
            return last;
        }

        private bool TryFindFreeNeighbor(string agentId, Vector2Int cell, out Vector2Int found)
        {
            var dirs = new[] { new Vector2Int(1, 0), new Vector2Int(-1, 0), new Vector2Int(0, 1), new Vector2Int(0, -1) };
            foreach (var d in dirs)
            {
                var n = cell + d;
                if (IsWalkable(n.x, n.y) && !IsTargetTaken(agentId, n))
                {
                    found = n;
                    return true;
                }
            }
            found = default;
            return false;
        }

        /// <summary>烘焙結果摘要(P-03 驗收:印到 Console)</summary>
        public string BakeReport()
        {
            var sb = new StringBuilder();
            sb.AppendLine($"[WorldGrid] 烘焙完成:網格 {Width}x{Height},可行走 {WalkableCount} 格,房間 {RoomCount} 間,物件點位 {ObjectCount} 個");
            sb.Append("  房間:");
            foreach (var (id, rect) in _rooms) sb.Append($" {id}({rect.width}x{rect.height})");
            sb.AppendLine();
            sb.Append("  物件:");
            foreach (var kv in _objects) sb.Append($" {kv.Key}→用點({kv.Value.UsePoint.x},{kv.Value.UsePoint.y})");
            return sb.ToString();
        }
    }
}
