using System;
using System.Linq;
using NUnit.Framework;
using Pixnew.Agents;

namespace Pixnew.Tests
{
    public class PersonaGenerationTests
    {
        private static readonly DateTime StartDate = new(2026, 7, 13);

        [Test]
        public void GenerateSix_IsReproducibleForSameSeed()
        {
            var generator = new PersonaGenerator();
            var first = generator.GenerateSix(741852UL, StartDate);
            var second = generator.GenerateSix(741852UL, StartDate);

            CollectionAssert.AreEqual(first.Select(x => x.Name), second.Select(x => x.Name));
            CollectionAssert.AreEqual(first.Select(x => x.Birth.SolarDate), second.Select(x => x.Birth.SolarDate));
            CollectionAssert.AreEqual(first.Select(x => x.Traits.Sociability), second.Select(x => x.Traits.Sociability));
        }

        [Test]
        public void GenerateSix_ContainsEveryAgeFrom18To23()
        {
            var personas = new PersonaGenerator().GenerateSix(123456UL, StartDate);
            CollectionAssert.AreEqual(new[] { 18, 19, 20, 21, 22, 23 }, personas.Select(x => x.Age).OrderBy(x => x));
        }

        [Test]
        public void GeneratedBirthdays_MatchAgeAtSimulationStart()
        {
            var personas = new PersonaGenerator().GenerateSix(987654UL, StartDate);
            foreach (Persona persona in personas)
            {
                DateTime birthday = DateTime.Parse(persona.Birth.SolarDate);
                int age = StartDate.Year - birthday.Year;
                if (birthday.Date > StartDate.AddYears(-age)) age--;
                Assert.AreEqual(persona.Age, age, persona.Name);
            }
        }

        [Test]
        public void GeneratedProfiles_HaveStableChartSeedAndBoundedTraits()
        {
            var personas = new PersonaGenerator().GenerateSix(13579UL, StartDate);
            foreach (Persona persona in personas)
            {
                Assert.AreEqual(ZiWeiSeedProfile.CurrentRuleVersion, persona.ZiWeiSeed.RuleVersion);
                CollectionAssert.Contains(new[] { 2, 3, 4, 5, 6 }, persona.ZiWeiSeed.BureauNumber);
                Assert.That(persona.Birth.ShichenIndex, Is.InRange(0, 11));
                Assert.That(persona.Traits.Sociability, Is.InRange(10, 90));
                Assert.That(persona.Traits.Resilience, Is.InRange(10, 90));
            }
        }

        [Test]
        public void VariableSystem_UpdatesOnlyOnTenMinuteBoundaries()
        {
            var state = new AgentVariableState();
            var traits = new PersonalityTraits { Sociability = 50, NoveltySeeking = 50, Resilience = 50 };
            var system = new AgentVariableSystem();
            float initialEnergy = state.Energy;

            system.AdvanceTo(state, traits, AgentActivity.Idle, 9);
            Assert.AreEqual(initialEnergy, state.Energy);
            system.AdvanceTo(state, traits, AgentActivity.Idle, 10);
            Assert.Less(state.Energy, initialEnergy);
            Assert.AreEqual(10, state.LastUpdateMinute);
        }

        [Test]
        public void SleepingAndTalkingRestoreRelevantNeeds()
        {
            var traits = new PersonalityTraits { Sociability = 70, NoveltySeeking = 50, Resilience = 50 };
            var system = new AgentVariableSystem();
            var sleeping = new AgentVariableState { Energy = 20f };
            var talking = new AgentVariableState { Social = 20f };

            system.AdvanceTo(sleeping, traits, AgentActivity.Sleeping, 10);
            system.AdvanceTo(talking, traits, AgentActivity.Talking, 10);
            Assert.Greater(sleeping.Energy, 20f);
            Assert.Greater(talking.Social, 20f);
        }

        [Test]
        public void DecisionWindow_IsEveryThirtyMinutes()
        {
            var state = new AgentVariableState();
            var system = new AgentVariableSystem();
            Assert.IsFalse(system.IsDecisionDue(state, 29));
            Assert.IsTrue(system.IsDecisionDue(state, 30));
            system.MarkDecision(state, 30);
            Assert.IsFalse(system.IsDecisionDue(state, 59));
            Assert.IsTrue(system.IsDecisionDue(state, 60));
        }

        [Test]
        public void ApiSnapshot_DoesNotExposeMutableSimulationState()
        {
            Persona persona = new PersonaGenerator().GenerateSix(24680UL, StartDate)[0];
            var state = new AgentVariableState { Energy = 42f };
            CharacterContextSnapshot snapshot = CharacterContextSnapshot.Create(persona, state, "休息", 600);

            snapshot.Needs.Energy = 0f;
            snapshot.Traits.Sociability = 0;
            Assert.AreEqual(42f, state.Energy);
            Assert.AreNotEqual(0, persona.Traits.Sociability);
        }
    }
}
