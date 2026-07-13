using System.Collections.Generic;
using System.Linq;
using Pixnew.Core;
using Pixnew.Sim;
using UnityEngine;

namespace Pixnew.View
{
    /// <summary>
    /// M1 測試駕駛(P-04 臨時鷹架,P-05 由 GameRoot 取代):
    /// 建 SimClock 驅動 WorldGrid.Step;硬編 3 位測試室友;
    /// 每 30 模擬分鐘隨機指派一個物件點位走過去;
    /// 鍵盤 空白=暫停、1/2/3=1x/4x/16x;左上 OnGUI 顯示時鐘。
    /// </summary>
    public class M1TestDriver : MonoBehaviour
    {
        private static readonly (string id, string name, int charIndex, string spawnObject)[] TestRoommates =
        {
            ("amei", "小美", 1, "bed_1"),
            ("aqiang", "阿強", 2, "bed_2"),
            ("xiaoyu", "小魚", 3, "bed_3")
        };

        private SimClock _clock;
        private WorldGrid _grid;
        private List<string> _targets;
        private GUIStyle _label;

        private void Start()
        {
            var scene = GetComponent<ApartmentScene>();
            if (scene?.Grid == null)
            {
                Debug.LogError("[M1TestDriver] ApartmentScene 尚未烘焙 WorldGrid");
                enabled = false;
                return;
            }
            _grid = scene.Grid;
            _clock = new SimClock();
            _clock.OnTick += OnTick;

            // 家具點位池(排除門,免得一直站在門口)
            _targets = _grid.ObjectIds.Where(id => !id.StartsWith("door_")).ToList();

            foreach (var (id, name, charIndex, spawnObject) in TestRoommates)
            {
                _grid.TryGetUsePoint(spawnObject, out var spawn);
                _grid.RegisterAgent(id, spawn);
                RoommateView.Create(id, name, charIndex, _grid);
            }
            AssignRandomTargets();
        }

        private void Update()
        {
            _clock.Advance(Time.deltaTime);
            RoommateView.CellsPerSecond = _clock.Speed / SimClock.RealSecondsPerSimMinute;

            if (Input.GetKeyDown(KeyCode.Space)) _clock.SetSpeed(_clock.Speed == 0 ? 1 : 0);
            if (Input.GetKeyDown(KeyCode.Alpha1)) _clock.SetSpeed(1);
            if (Input.GetKeyDown(KeyCode.Alpha2)) _clock.SetSpeed(4);
            if (Input.GetKeyDown(KeyCode.Alpha3)) _clock.SetSpeed(16);
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
                string target = _targets[Random.Range(0, _targets.Count)];
                _grid.MoveAgentTo(agent.Id, target);
            }
        }

        private void OnGUI()
        {
            _label ??= new GUIStyle(GUI.skin.label) { fontSize = 20 };
            string speed = _clock.Speed == 0 ? "⏸ 暫停" : $"{_clock.Speed}x";
            GUI.Label(new Rect(16, 10, 700, 28), $"第 {_clock.Day} 天  {_clock.Hhmm}  [{speed}](空白鍵暫停,1/2/3 調速,滾輪縮放)", _label);
        }
    }
}
