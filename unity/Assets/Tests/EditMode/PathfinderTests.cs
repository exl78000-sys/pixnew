using NUnit.Framework;
using Pixnew.Sim;
using UnityEngine;

namespace Pixnew.Tests
{
    /// <summary>P-04 驗收:A* 三個基本案例(直線、繞牆、無路)</summary>
    public class PathfinderTests
    {
        /// <summary>建一個全可走的 w x h 網格</summary>
        private static WorldGrid OpenGrid(int w, int h)
        {
            var g = new WorldGrid(w, h);
            for (int x = 0; x < w; x++)
                for (int y = 0; y < h; y++)
                    g.SetWalkable(x, y, true);
            return g;
        }

        [Test]
        public void 直線_無障礙時路徑長度等於曼哈頓距離()
        {
            var g = OpenGrid(10, 3);
            var path = Pathfinder.FindPath(g, new Vector2Int(0, 1), new Vector2Int(9, 1));

            Assert.IsNotNull(path);
            Assert.AreEqual(9, path.Count);
            Assert.AreEqual(new Vector2Int(9, 1), path[path.Count - 1]);
            // 每步都是相鄰格且可走
            var prev = new Vector2Int(0, 1);
            foreach (var p in path)
            {
                Assert.AreEqual(1, Mathf.Abs(p.x - prev.x) + Mathf.Abs(p.y - prev.y));
                Assert.IsTrue(g.IsWalkable(p.x, p.y));
                prev = p;
            }
        }

        [Test]
        public void 繞牆_中間有缺口的牆會繞過去()
        {
            var g = OpenGrid(9, 9);
            // 立一道 x=4 的直牆,只在 y=8 留缺口
            for (int y = 0; y < 8; y++) g.SetWalkable(4, y, false);

            var start = new Vector2Int(0, 0);
            var goal = new Vector2Int(8, 0);
            var path = Pathfinder.FindPath(g, start, goal);

            Assert.IsNotNull(path);
            Assert.AreEqual(goal, path[path.Count - 1]);
            // 必然經過缺口 (4,8)
            Assert.IsTrue(path.Contains(new Vector2Int(4, 8)), "路徑應通過牆上唯一缺口");
            // 最短:0,0→4,8→8,0 = 8 + 8 + 8 = 24 步
            Assert.AreEqual(24, path.Count);
        }

        [Test]
        public void 無路_完全封死時回傳null()
        {
            var g = OpenGrid(9, 9);
            // 把目標完全圍死
            g.SetWalkable(7, 8, false);
            g.SetWalkable(7, 7, false);
            g.SetWalkable(8, 7, false);

            var path = Pathfinder.FindPath(g, new Vector2Int(0, 0), new Vector2Int(8, 8));
            Assert.IsNull(path);
        }

        [Test]
        public void 目的格互斥_第二人改走相鄰格()
        {
            var g = OpenGrid(9, 9);
            g.AddObject("stove", new RectInt(4, 4, 1, 1), new Vector2Int(4, 5));
            g.RegisterAgent("a", new Vector2Int(0, 0));
            g.RegisterAgent("b", new Vector2Int(8, 8));

            Assert.IsTrue(g.MoveAgentTo("a", "stove"));
            Assert.IsTrue(g.MoveAgentTo("b", "stove"));

            // 跑到路徑走完
            for (int i = 0; i < 64; i++) g.Step();

            var a = g.GetAgent("a");
            var b = g.GetAgent("b");
            Assert.AreEqual(new Vector2Int(4, 5), a.Pos);
            Assert.AreNotEqual(a.Pos, b.Pos);
            Assert.AreEqual(1, Mathf.Abs(b.Pos.x - 4) + Mathf.Abs(b.Pos.y - 5), "b 應停在互動點相鄰格");
        }
    }
}
