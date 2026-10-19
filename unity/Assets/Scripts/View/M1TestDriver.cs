using System.Collections.Generic;
using System.Linq;
using Pixnew.Agents;
using Pixnew.Boot;
using Pixnew.Sim;
using UnityEngine;

namespace Pixnew.View
{
    /// <summary>
    /// M1 測試鷹架(P-04;P-07 固定作息接手後移除):
    /// 顯示六位 seed 角色,掛上 GameRoot 的時鐘,每 30 模擬分鐘指派一個可重播的物件點位走過去。
    /// 時鐘驅動、調速、HUD 均由 GameRoot / Hud 負責。
    /// </summary>
    public class M1TestDriver : MonoBehaviour
    {
        private static readonly string[] PreferredSpawnObjects =
            { "bed_1", "bed_2", "bed_3", "bed_4", "sofa", "dining_table" };

        private WorldGrid _grid;
        private List<string> _targets;
        private DeterministicRandom _random;

        private void Start()
        {
            var root = GetComponent<GameRoot>();
            var scene = GetComponent<ApartmentScene>();
            if (root == null || scene?.Grid == null)
            {
                Debug.LogError("[M1TestDriver] 需要與 GameRoot、ApartmentScene 同物件且網格已烘焙");
                enabled = false;
                return;
            }
            _grid = scene.Grid;
            _random = new DeterministicRandom(GameRoot.DefaultWorldSeed ^ 0x4D3154455354UL);
            root.Clock.OnTick += OnTick;

            // 家具點位池(排除門,免得一直站在門口)
            _targets = _grid.ObjectIds.Where(id => !id.StartsWith("door_")).ToList();

            Persona[] visibleCast = root.Cast.Take(6).ToArray();
            List<Vector2Int> spawnPoints = ResolveSpawnPoints(visibleCast.Length);
            if (spawnPoints.Count < visibleCast.Length)
            {
                Debug.LogError($"[M1TestDriver] Need {visibleCast.Length} walkable spawn points, but found {spawnPoints.Count}.");
                enabled = false;
                return;
            }

            for (int i = 0; i < visibleCast.Length; i++)
            {
                Persona persona = visibleCast[i];
                _grid.RegisterAgent(persona.Id, spawnPoints[i]);
                RoommateView.Create(persona.Id, persona.Name, i + 1, _grid);
            }
            AssignRandomTargets();
        }

        private List<Vector2Int> ResolveSpawnPoints(int requiredCount)
        {
            var result = new List<Vector2Int>(requiredCount);
            var occupied = new HashSet<Vector2Int>();
            IEnumerable<string> candidates = PreferredSpawnObjects
                .Concat(_grid.ObjectIds)
                .Distinct();

            foreach (string objectId in candidates)
            {
                if (!_grid.TryGetUsePoint(objectId, out Vector2Int point) ||
                    !_grid.IsWalkable(point.x, point.y) ||
                    !occupied.Add(point))
                    continue;

                result.Add(point);
                if (result.Count == requiredCount) return result;
            }

            for (int y = 0; y < _grid.Height && result.Count < requiredCount; y++)
            for (int x = 0; x < _grid.Width && result.Count < requiredCount; x++)
            {
                var point = new Vector2Int(x, y);
                if (_grid.IsWalkable(x, y) && occupied.Add(point)) result.Add(point);
            }

            return result;
        }

        private void OnTick(long simTime)
        {
            _grid.Step();
            if (simTime % 30 == 0) AssignRandomTargets();
        }

        /// <summary>給每位閒著的室友隨機指派一個物件點位</summary>
        private void AssignRandomTargets()
        {
            if (_targets.Count == 0) return;
            foreach (var agent in _grid.Agents)
            {
                if (agent.IsMoving) continue;
                for (int attempt = 0; attempt < _targets.Count; attempt++)
                {
                    string target = _targets[_random.Next(0, _targets.Count)];
                    if (_grid.MoveAgentTo(agent.Id, target)) break;
                }
            }
        }
    }
}
