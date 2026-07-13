using System.Collections.Generic;
using UnityEngine;

namespace Pixnew.Sim
{
    /// <summary>
    /// A* 尋路(純 C#,四方向,曼哈頓啟發)。
    /// 回傳從起點的「下一格」到終點(含)的路徑;起點=終點回傳空清單;無路回傳 null。
    /// </summary>
    public static class Pathfinder
    {
        private static readonly Vector2Int[] Dirs =
        {
            new(1, 0), new(-1, 0), new(0, 1), new(0, -1)
        };

        /// <summary>在 grid 上找 start→goal 的最短路徑(goal 需可走)</summary>
        public static List<Vector2Int> FindPath(WorldGrid grid, Vector2Int start, Vector2Int goal)
        {
            if (start == goal) return new List<Vector2Int>();
            if (!grid.IsWalkable(goal.x, goal.y)) return null;

            var open = new SortedSet<(int f, int tie, Vector2Int pos)>(
                Comparer<(int f, int tie, Vector2Int pos)>.Create((a, b) =>
                {
                    int c = a.f.CompareTo(b.f);
                    if (c != 0) return c;
                    return a.tie.CompareTo(b.tie);
                }));
            var gScore = new Dictionary<Vector2Int, int>();
            var cameFrom = new Dictionary<Vector2Int, Vector2Int>();
            int tick = 0;

            gScore[start] = 0;
            open.Add((Heuristic(start, goal), tick++, start));

            while (open.Count > 0)
            {
                var (_, _, current) = open.Min;
                open.Remove(open.Min);

                if (current == goal) return Reconstruct(cameFrom, current, start);

                foreach (var d in Dirs)
                {
                    var next = current + d;
                    if (!grid.IsWalkable(next.x, next.y)) continue;

                    int g = gScore[current] + 1;
                    if (gScore.TryGetValue(next, out int old) && g >= old) continue;

                    gScore[next] = g;
                    cameFrom[next] = current;
                    open.Add((g + Heuristic(next, goal), tick++, next));
                }
            }
            return null;
        }

        private static int Heuristic(Vector2Int a, Vector2Int b) =>
            Mathf.Abs(a.x - b.x) + Mathf.Abs(a.y - b.y);

        private static List<Vector2Int> Reconstruct(
            Dictionary<Vector2Int, Vector2Int> cameFrom, Vector2Int current, Vector2Int start)
        {
            var path = new List<Vector2Int>();
            while (current != start)
            {
                path.Add(current);
                current = cameFrom[current];
            }
            path.Reverse();
            return path;
        }
    }
}
