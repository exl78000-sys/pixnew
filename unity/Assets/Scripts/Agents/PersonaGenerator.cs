using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Pixnew.Agents
{
    /// <summary>
    /// 依存檔種子產生六位 18~23 歲室友。命理資料只作為虛構角色的初始性格種子。
    /// </summary>
    public sealed class PersonaGenerator
    {
        private static readonly string[] Branches = { "子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥" };
        private static readonly string[] ChineseZodiacs = { "鼠", "牛", "虎", "兔", "龍", "蛇", "馬", "羊", "猴", "雞", "狗", "豬" };
        private static readonly string[] FemaleNames = { "林若晴", "陳語安", "許沛寧", "周以柔", "江映彤", "葉可昕", "沈知夏", "方雨澄" };
        private static readonly string[] MaleNames = { "張宇衡", "李承皓", "王子謙", "徐柏言", "高允辰", "何景曜", "杜亦凡", "宋以恆" };
        private static readonly string[] Jobs = { "大學生", "研究助理", "咖啡店店員", "自由插畫接案", "獨立樂團樂手", "影音剪輯助理", "甜點學徒", "遊戲實況主", "服裝設計學生", "健身房櫃檯" };
        private static readonly string[] Likes = { "深夜散步", "手沖咖啡", "老電影", "做甜點", "室內植物", "桌遊", "唱歌", "逛二手店", "拍底片", "整理房間", "追劇", "慢跑" };
        private static readonly string[] Dislikes = { "被催促", "房間太亂", "臨時改約", "冷戰", "早起", "浪費食物", "被偷看手機", "太吵的聚會", "說話不算話", "別人亂動私人物品" };
        private static readonly string[] Secrets = { "其實正在偷偷準備轉學", "曾經對朋友的戀人動過心", "把匿名帳號經營得很有名", "一直假裝不在意家人的期待", "存錢想獨自出國生活", "害怕自己最後會被所有人留下", "曾為了合群說過一個還沒被拆穿的謊", "偷偷寫了一首歌給某個舊朋友" };

        private readonly ChineseLunisolarCalendar _calendar = new();

        public IReadOnlyList<Persona> GenerateSix(ulong worldSeed, DateTime simulationStartDate)
        {
            var random = new DeterministicRandom(worldSeed);
            int[] ages = { 18, 19, 20, 21, 22, 23 };
            string[] chartSexes = { "female", "female", "female", "male", "male", "male" };
            string[] femaleNames = (string[])FemaleNames.Clone();
            string[] maleNames = (string[])MaleNames.Clone();
            random.Shuffle(ages);
            random.Shuffle(chartSexes);
            random.Shuffle(femaleNames);
            random.Shuffle(maleNames);

            int femaleIndex = 0;
            int maleIndex = 0;
            var result = new List<Persona>(6);
            for (int i = 0; i < 6; i++)
            {
                ulong personaSeed = random.NextUInt64();
                var personaRandom = new DeterministicRandom(personaSeed);
                string chartSex = chartSexes[i];
                string name = chartSex == "female" ? femaleNames[femaleIndex++] : maleNames[maleIndex++];
                BirthProfile birth = CreateBirthProfile(personaRandom, ages[i], chartSex, simulationStartDate.Date);
                ZiWeiSeedProfile ziwei = CreateZiWeiSeed(birth);
                PersonalityTraits traits = CreateTraits(personaRandom, birth, ziwei);

                result.Add(new Persona
                {
                    Id = $"roommate_{i + 1:00}",
                    Name = name,
                    Age = ages[i],
                    Job = Pick(personaRandom, Jobs),
                    Personality = DescribePersonality(traits, ziwei),
                    SpeechStyle = DescribeSpeechStyle(traits),
                    Likes = PickDistinct(personaRandom, Likes, 2),
                    Dislikes = PickDistinct(personaRandom, Dislikes, 2),
                    Secret = Pick(personaRandom, Secrets),
                    GenerationSeed = personaSeed,
                    Birth = birth,
                    ZiWeiSeed = ziwei,
                    Traits = traits
                });
            }

            return result;
        }

        private BirthProfile CreateBirthProfile(DeterministicRandom random, int age, string chartSex, DateTime startDate)
        {
            DateTime earliest = startDate.AddYears(-(age + 1)).AddDays(1);
            DateTime latest = startDate.AddYears(-age);
            int days = (latest - earliest).Days + 1;
            DateTime birthday = earliest.AddDays(random.Next(0, days));
            int shichen = random.Next(0, 12);
            int hour = shichen == 0 ? 23 : shichen * 2 - 1;
            int minute = random.Next(15, 46);
            DateTime birthMoment = birthday.AddHours(hour).AddMinutes(minute);

            int lunarYear = _calendar.GetYear(birthMoment);
            int rawLunarMonth = _calendar.GetMonth(birthMoment);
            int leapMonth = _calendar.GetLeapMonth(lunarYear);
            bool isLeap = leapMonth > 0 && rawLunarMonth == leapMonth;
            int lunarMonth = leapMonth > 0 && rawLunarMonth >= leapMonth ? rawLunarMonth - 1 : rawLunarMonth;

            return new BirthProfile
            {
                SolarDate = birthday.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                BirthTime = $"{hour:00}:{minute:00}",
                AgeAtStart = age,
                ChartSex = chartSex,
                WesternZodiac = GetWesternZodiac(birthday.Month, birthday.Day),
                ChineseZodiac = ChineseZodiacs[PositiveMod(lunarYear - 4, 12)],
                LunarYear = lunarYear,
                LunarMonth = lunarMonth,
                LunarDay = _calendar.GetDayOfMonth(birthMoment),
                IsLeapMonth = isLeap,
                ShichenIndex = shichen,
                Shichen = Branches[shichen] + "時"
            };
        }

        private static ZiWeiSeedProfile CreateZiWeiSeed(BirthProfile birth)
        {
            int lifeBranch = PositiveMod(2 + birth.LunarMonth - 1 - birth.ShichenIndex, 12);
            int bodyBranch = PositiveMod(2 + birth.LunarMonth - 1 + birth.ShichenIndex, 12);
            int yearStem = PositiveMod(birth.LunarYear - 4, 10);
            int tigerStem = PositiveMod((yearStem % 5) * 2 + 2, 10);
            int lifeStem = PositiveMod(tigerStem + PositiveMod(lifeBranch - 2, 12), 10);
            string element = GetNaYinElement(lifeStem, lifeBranch);
            int bureau = element switch { "水" => 2, "木" => 3, "金" => 4, "土" => 5, _ => 6 };

            return new ZiWeiSeedProfile
            {
                LifePalace = Branches[lifeBranch],
                BodyPalace = Branches[bodyBranch],
                FiveElementsBureau = element + bureau + "局",
                BureauNumber = bureau
            };
        }

        private static PersonalityTraits CreateTraits(DeterministicRandom random, BirthProfile birth, ZiWeiSeedProfile ziwei)
        {
            int[] values = Enumerable.Range(0, 12).Select(_ => 50 + random.Next(-12, 13)).ToArray();
            ApplyElement(values, WesternElement(birth.WesternZodiac), 5);
            ApplyElement(values, ziwei.FiveElementsBureau.Substring(0, 1), 9);
            int lifeBranch = Array.IndexOf(Branches, ziwei.LifePalace);
            values[0] += lifeBranch is 2 or 3 or 5 or 6 ? 5 : -2;
            values[1] += lifeBranch is 1 or 4 or 7 or 10 ? 5 : 0;
            values[6] += lifeBranch is 3 or 5 or 6 or 9 ? 5 : 0;
            for (int i = 0; i < values.Length; i++) values[i] = Math.Clamp(values[i], 10, 90);

            return new PersonalityTraits
            {
                Sociability = values[0], TrustSpeed = values[1], EmotionalExpression = values[2],
                Empathy = values[3], Orderliness = values[4], NoveltySeeking = values[5],
                RomanticInitiative = values[6], AttachmentNeed = values[7], JealousySensitivity = values[8],
                ConflictTendency = values[9], Honesty = values[10], Resilience = values[11]
            };
        }

        private static void ApplyElement(int[] v, string element, int strength)
        {
            switch (element)
            {
                case "火": v[2] += strength; v[6] += strength; v[9] += strength / 2; break;
                case "水": v[3] += strength; v[7] += strength / 2; v[2] -= strength / 3; break;
                case "木": v[0] += strength / 2; v[3] += strength / 2; v[5] += strength; break;
                case "金": v[4] += strength; v[10] += strength; v[1] -= strength / 3; break;
                case "土": v[1] += strength / 2; v[4] += strength; v[11] += strength; break;
            }
        }

        private static string DescribePersonality(PersonalityTraits t, ZiWeiSeedProfile z)
        {
            var parts = new List<string> { $"命宮{z.LifePalace}、{z.FiveElementsBureau}的性格種子" };
            parts.Add(t.Sociability >= 60 ? "在人群中容易主動開話題" : "熟悉以前傾向先觀察再靠近");
            parts.Add(t.EmotionalExpression >= 60 ? "情緒很難藏住" : "真正的情緒通常留到獨處才處理");
            parts.Add(t.NoveltySeeking >= 60 ? "會被新鮮的人與突發邀約吸引" : "偏好可預期的生活節奏");
            return string.Join("；", parts);
        }

        private static string DescribeSpeechStyle(PersonalityTraits t)
        {
            string pace = t.Sociability >= 60 ? "接話快、會主動追問" : "短句居多、確認安全後才多說";
            string honesty = t.Honesty >= 60 ? "措辭直接但不刻意傷人" : "尷尬時會用玩笑或轉移話題保護自己";
            return pace + "；" + honesty;
        }

        private static string GetWesternZodiac(int month, int day)
        {
            int value = month * 100 + day;
            if (value >= 321 && value <= 419) return "牡羊座";
            if (value >= 420 && value <= 520) return "金牛座";
            if (value >= 521 && value <= 621) return "雙子座";
            if (value >= 622 && value <= 722) return "巨蟹座";
            if (value >= 723 && value <= 822) return "獅子座";
            if (value >= 823 && value <= 922) return "處女座";
            if (value >= 923 && value <= 1023) return "天秤座";
            if (value >= 1024 && value <= 1122) return "天蠍座";
            if (value >= 1123 && value <= 1221) return "射手座";
            if (value >= 1222 || value <= 119) return "摩羯座";
            if (value <= 218) return "水瓶座";
            return "雙魚座";
        }

        private static string WesternElement(string zodiac)
        {
            if (zodiac is "牡羊座" or "獅子座" or "射手座") return "火";
            if (zodiac is "金牛座" or "處女座" or "摩羯座") return "土";
            if (zodiac is "雙子座" or "天秤座" or "水瓶座") return "木";
            return "水";
        }

        private static string GetNaYinElement(int stem, int branch)
        {
            string[] pairs = {
                "金", "火", "木", "土", "金", "火", "水", "土", "金", "木",
                "水", "土", "火", "木", "水", "金", "火", "木", "土", "金",
                "火", "水", "土", "金", "木", "水", "土", "火", "木", "水"
            };
            for (int i = 0; i < 60; i++)
                if (i % 10 == stem && i % 12 == branch) return pairs[i / 2];
            throw new InvalidOperationException("天干地支組合無法形成六十甲子。");
        }

        private static T Pick<T>(DeterministicRandom random, T[] values) => values[random.Next(0, values.Length)];

        private static List<string> PickDistinct(DeterministicRandom random, string[] source, int count)
        {
            string[] values = (string[])source.Clone();
            random.Shuffle(values);
            return values.Take(count).ToList();
        }

        private static int PositiveMod(int value, int modulus) => (value % modulus + modulus) % modulus;
    }
}
