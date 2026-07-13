using System;

namespace Pixnew.Agents
{
    /// <summary>
    /// 跨平台結果固定的亂數來源。存檔只要保存 State，即可重播角色生成與行動抽選。
    /// </summary>
    public sealed class DeterministicRandom
    {
        private ulong _state;

        public DeterministicRandom(ulong seed)
        {
            _state = seed == 0 ? 0x9E3779B97F4A7C15UL : seed;
        }

        public ulong State => _state;

        public ulong NextUInt64()
        {
            ulong x = _state;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            _state = x;
            return x * 2685821657736338717UL;
        }

        public int Next(int minInclusive, int maxExclusive)
        {
            if (maxExclusive <= minInclusive) throw new ArgumentOutOfRangeException(nameof(maxExclusive));
            return minInclusive + (int)(NextUInt64() % (uint)(maxExclusive - minInclusive));
        }

        public float NextFloat() => (NextUInt64() >> 40) / (float)(1UL << 24);

        public void Shuffle<T>(T[] values)
        {
            if (values == null) throw new ArgumentNullException(nameof(values));
            for (int i = values.Length - 1; i > 0; i--)
            {
                int j = Next(0, i + 1);
                (values[i], values[j]) = (values[j], values[i]);
            }
        }
    }
}
