using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using NUnit.Framework;
using Pixnew.Sim;
using UnityEngine;

namespace Pixnew.Tests
{
    public class ApartmentLayoutTests
    {
        private static ApartmentLayout LoadLayout()
        {
            string path = Path.Combine(
                Application.dataPath,
                "StreamingAssets/content/apartment-layout.json");
            return JsonConvert.DeserializeObject<ApartmentLayout>(File.ReadAllText(path));
        }

        [Test]
        public void ApartmentHasFourBedroomsTwoLivingAreasTwoBathroomsAndTwoBalconies()
        {
            var layout = LoadLayout();

            Assert.AreEqual(4, layout.Rooms.Count(r => r.Id.StartsWith("bedroom_")));
            Assert.AreEqual(2, layout.Rooms.Count(r =>
                r.Id == "living_room" || r.Id == "dining_room"));
            Assert.AreEqual(2, layout.Rooms.Count(r => r.Id.StartsWith("bathroom_")));
            Assert.AreEqual(2, layout.Rooms.Count(r => r.Id.StartsWith("balcony_")));
            CollectionAssert.IsSubsetOf(
                new[] { "bed_1", "bed_2", "bed_3", "bed_4" },
                layout.Objects.Select(o => o.Id).ToArray());
        }

        [Test]
        public void ApartmentIsCompactAndHasLivedInFurnitureDensity()
        {
            var layout = LoadLayout();
            Assert.LessOrEqual(layout.Grid.Height, 32,
                "全屋固定鏡頭在 1080p 下應保持可讀的像素密度。");
            Assert.GreaterOrEqual(layout.Objects.Count, 50,
                "四房公寓至少需要 50 個可見家具／裝飾物，避免功能測試場觀感。");
        }

        [Test]
        public void EveryUsePointAndDoorIsWalkableAndConnected()
        {
            var layout = LoadLayout();
            bool[,] walkable = BakeWalkability(layout);
            ObjectSpec startObject = layout.Objects.Single(o => o.Id == "bed_1");
            var start = new Vector2Int(startObject.Use[0], startObject.Use[1]);
            HashSet<Vector2Int> reachable = FloodFill(walkable, start);

            foreach (var obj in layout.Objects)
            {
                var use = new Vector2Int(obj.Use[0], obj.Use[1]);
                Assert.IsTrue(IsWalkable(walkable, use),
                    $"{obj.Id} use point {use} must be walkable.");
                Assert.IsTrue(reachable.Contains(use),
                    $"{obj.Id} use point {use} must be reachable from bed_1.");
            }

            foreach (var door in layout.Doors)
            {
                var pos = new Vector2Int(door.Pos[0], door.Pos[1]);
                Assert.IsTrue(IsWalkable(walkable, pos),
                    $"{door.Id} at {pos} must be walkable.");
                Assert.IsTrue(reachable.Contains(pos),
                    $"{door.Id} at {pos} must be reachable from bed_1.");
            }
        }

        private static bool[,] BakeWalkability(ApartmentLayout layout)
        {
            var result = new bool[layout.Grid.Width, layout.Grid.Height];
            foreach (var room in layout.Rooms)
                PaintRect(result, room.Rect, true);
            foreach (var floor in layout.ExtraFloor)
                PaintRect(result, floor.Rect, true);

            foreach (var wall in layout.Walls)
            {
                for (int i = 0; i < wall.Len; i++)
                {
                    int coordinate = (wall.Dir == "h" ? wall.X : wall.Y) + i;
                    if (InGap(wall, coordinate)) continue;

                    if (wall.Dir == "h")
                    {
                        Set(result, wall.X + i, wall.Y, false);
                        Set(result, wall.X + i, wall.Y + 1, false);
                    }
                    else
                    {
                        Set(result, wall.X, wall.Y + i, false);
                    }
                }
            }

            foreach (var obj in layout.Objects.Where(o => !o.Walkable))
            {
                for (int x = 0; x < obj.Atlas[2]; x++)
                    for (int y = 0; y < obj.Atlas[3]; y++)
                        Set(result, obj.Pos[0] + x, obj.Pos[1] + y, false);
            }

            return result;
        }

        private static void PaintRect(bool[,] grid, int[] rect, bool value)
        {
            for (int x = rect[0]; x < rect[0] + rect[2]; x++)
                for (int y = rect[1]; y < rect[1] + rect[3]; y++)
                    Set(grid, x, y, value);
        }

        private static void Set(bool[,] grid, int x, int y, bool value)
        {
            if (x >= 0 && y >= 0 && x < grid.GetLength(0) && y < grid.GetLength(1))
                grid[x, y] = value;
        }

        private static bool InGap(WallRunSpec wall, int coordinate)
        {
            return wall.Gaps != null &&
                   wall.Gaps.Any(g => coordinate >= g[0] && coordinate < g[0] + g[1]);
        }

        private static bool IsWalkable(bool[,] grid, Vector2Int point)
        {
            return point.x >= 0 && point.y >= 0 &&
                   point.x < grid.GetLength(0) && point.y < grid.GetLength(1) &&
                   grid[point.x, point.y];
        }

        private static HashSet<Vector2Int> FloodFill(bool[,] grid, Vector2Int start)
        {
            var visited = new HashSet<Vector2Int>();
            if (!IsWalkable(grid, start)) return visited;

            var queue = new Queue<Vector2Int>();
            queue.Enqueue(start);
            visited.Add(start);
            var directions = new[]
            {
                Vector2Int.left, Vector2Int.right, Vector2Int.up, Vector2Int.down
            };

            while (queue.Count > 0)
            {
                Vector2Int current = queue.Dequeue();
                foreach (Vector2Int direction in directions)
                {
                    Vector2Int next = current + direction;
                    if (IsWalkable(grid, next) && visited.Add(next))
                        queue.Enqueue(next);
                }
            }

            return visited;
        }
    }
}
