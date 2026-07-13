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
        private static readonly string[] SpawnObjects =
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
            for (int i = 0; i < visibleCast.Length; i++)
            {
                Persona persona = visibleCast[i];
                string spawnObject = SpawnObjects[i];
                _grid.TryGetUsePoint(spawnObject, out var spawn);
                _grid.RegisterAgent(persona.Id, spawn);
                RoommateView.Create(persona.Id, persona.Name, i + 1, _grid);
            }
            AssignRandomTargets();
        }

        private void OnTick(long simTime)
        {
            _grid.Step();
            if (simTime % 30 == 0) AssignRandomTargets();
        }

        /// <summary>給每位閒著的室友隨機指派一個物件點位</summary>
        private void AssignRandomTargets()
        {
            foreach (var agent in _grid.Agents)
            {
                if (agent.IsMoving) continue;
                string target = _targets[_random.Next(0, _targets.Count)];
                _grid.MoveAgentTo(agent.Id, target);
            }
        }
    }
}
