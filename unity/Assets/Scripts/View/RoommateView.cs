using System.Collections.Generic;
using Pixnew.Sim;
using UnityEngine;

namespace Pixnew.View
{
    /// <summary>
    /// 室友的呈現層(P-04):SpriteRenderer + Animator(四向 走路/待機)+ 頭頂名字。
    /// 每幀朝模擬格位置平滑移動,依移動方向切動畫狀態。
    /// 角色動畫資產由 Tools/Pixnew/Build Character Assets 產生於 Resources/Characters/。
    /// </summary>
    public class RoommateView : MonoBehaviour
    {
        /// <summary>格/秒(由駕駛層依模擬速度每幀更新;0 = 暫停)</summary>
        public static float CellsPerSecond = 0.5f;

        private WorldGrid _grid;
        private string _agentId;
        private Animator _animator;
        private string _currentState = "";
        private char _facing = 'd';
        private readonly Queue<Vector3> _waypoints = new();

        /// <summary>建立一位室友(id、顯示名、角色編號 1~3、邏輯網格)</summary>
        public static RoommateView Create(string agentId, string displayName, int charIndex, WorldGrid grid)
        {
            var go = new GameObject($"Roommate_{agentId}");
            var view = go.AddComponent<RoommateView>();
            view._grid = grid;
            view._agentId = agentId;

            var sr = go.AddComponent<SpriteRenderer>();
            sr.sortingOrder = 25;

            view._animator = go.AddComponent<Animator>();
            var ctrl = Resources.Load<RuntimeAnimatorController>($"Characters/roommate_{charIndex:00}");
            if (ctrl == null) Debug.LogError($"[RoommateView] 找不到角色動畫 Characters/roommate_{charIndex:00},請先跑 Tools/Pixnew/Build Character Assets");
            view._animator.runtimeAnimatorController = ctrl;

            // 頭頂名字(Cubic 11)
            var labelGo = new GameObject("Name");
            labelGo.transform.SetParent(go.transform, false);
            labelGo.transform.localPosition = new Vector3(0, 1.35f, 0);
            var tm = labelGo.AddComponent<TextMesh>();
            tm.text = displayName;
            tm.anchor = TextAnchor.LowerCenter;
            tm.alignment = TextAlignment.Center;
            tm.characterSize = 0.08f;
            tm.fontSize = 48;
            tm.color = Color.white;
            var font = Resources.Load<Font>("Fonts/Cubic_11");
            if (font != null)
            {
                tm.font = font;
                labelGo.GetComponent<MeshRenderer>().material = font.material;
            }
            labelGo.GetComponent<MeshRenderer>().sortingOrder = 30;

            var agent = grid.GetAgent(agentId);
            go.transform.position = CellCenter(grid, agent.Pos);

            // 模擬每走一格,把格心加入軌跡佇列 → 高速快轉也沿走廊逐格走,不抄捷徑
            grid.OnAgentStepped += stepped =>
            {
                if (view != null && stepped.Id == agentId)
                    view._waypoints.Enqueue(CellCenter(grid, stepped.Pos));
            };
            return view;
        }

        private void Update()
        {
            if (_waypoints.Count == 0 || CellsPerSecond <= 0f)
            {
                Play($"idle_{_facing}");
                return;
            }

            // 佇列積壓時加速追趕,避免快轉後角色慢半拍
            float speed = CellsPerSecond * Mathf.Max(1f, _waypoints.Count - 1);
            float step = speed * Time.deltaTime;

            Vector3 target = _waypoints.Peek();
            Vector3 delta = target - transform.position;
            float dist = delta.magnitude;

            if (dist <= step)
            {
                transform.position = target;
                _waypoints.Dequeue();
            }
            else
            {
                transform.position += delta / dist * step;
            }

            if (dist > 0.001f)
            {
                _facing = Mathf.Abs(delta.x) >= Mathf.Abs(delta.y)
                    ? (delta.x > 0 ? 'r' : 'l')
                    : (delta.y > 0 ? 'u' : 'd');
            }
            Play($"walk_{_facing}");
        }

        private void Play(string state)
        {
            if (state == _currentState || _animator.runtimeAnimatorController == null) return;
            _animator.Play(state);
            _currentState = state;
        }

        /// <summary>邏輯格(y 向下)→ 世界座標(格中心)</summary>
        private static Vector3 CellCenter(WorldGrid grid, Vector2Int cell) =>
            new(cell.x + 0.5f, grid.Height - 1 - cell.y + 0.5f, 0);
    }
}
