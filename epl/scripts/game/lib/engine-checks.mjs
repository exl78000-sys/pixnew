/* 引擎不變量。由 test-game.mjs 呼叫,回傳 [label, ok, detail] 陣列。
   引擎是純函式,所以這裡可以真的跑幾百場再看統計,而不是掃原始碼。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runEngineChecks(mod, root) {
  const profile = JSON.parse(readFileSync(join(root, 'web', 'data', 'game', 'pl.json'), 'utf8'));
  const pred = { xgHome: 1.6, xgAway: 1.1 };
  const out = [];
  const play = (seed, setup = {}, ops = null) => {
    const m = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed, setup });
    while (!m.state().finished) { m.tick(); if (ops) ops(m); }
    return m;
  };

  // 1. 錨:沒有任何改動時 λ_game = λ_site(精確)
  const m0 = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed: 1 });
  const l0 = m0.lambdas();
  out.push(['無改動時 λ_game 等於站上的 λ(精確)', l0.home === pred.xgHome && l0.away === pred.xgAway, `${l0.home}/${l0.away}`]);

  // 2. 幾百場的不變量
  const N = 300;
  let goalsH = 0, goalsA = 0, bad = [];
  const mins = [];
  for (let seed = 1; seed <= N; seed++) {
    const m = play(seed);
    const ev = m.events(), s = m.state();
    const goals = ev.filter(e => e.type === 'goal');
    goalsH += s.score[0]; goalsA += s.score[1];
    if (goals.length !== s.score[0] + s.score[1]) bad.push(`seed ${seed}: 進球事件 ${goals.length} ≠ 比分`);
    if (s.home.stats.goals !== s.score[0] || s.away.stats.goals !== s.score[1]) bad.push(`seed ${seed}: 統計進球 ≠ 比分`);
    for (const side of ['home', 'away']) {
      const ss = s[side];
      if (ss.stats.shots < ss.stats.goals || ss.stats.on < ss.stats.goals) bad.push(`seed ${seed}: ${side} 射門/射正 < 進球`);
      if (ss.subsUsed > 5 || ss.windowsUsed > 3) bad.push(`seed ${seed}: ${side} 換人 ${ss.subsUsed} / 窗口 ${ss.windowsUsed}`);
      if (ss.onPitch.length !== 11 - ss.red) bad.push(`seed ${seed}: ${side} 場上 ${ss.onPitch.length} 人、紅牌 ${ss.red}`);
      if (ss.stats.red !== ss.red) bad.push(`seed ${seed}: 紅牌統計不一致`);
    }
    // 射手 / 牌 / 換人:事件當下在場上(重播一次逐分鐘檢查)
    const m2 = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed });
    while (!m2.state().finished) {
      const before = m2.state();
      /* 同一分鐘的事件要**依序**套用:先換人再犯規時,新上場的人拿牌是合法的。 */
      const live = { home: { on: new Set(before.home.onPitch), bench: new Set(before.home.bench) }, away: { on: new Set(before.away.onPitch), bench: new Set(before.away.bench) } };
      const evs = m2.tick();
      for (const e of evs) {
        const side = live[e.side], oppSide = live[e.side === 'home' ? 'away' : 'home'];
        if (!side) continue;
        if (e.type === 'goal' && !e.ownGoal && !side.on.has(e.scorer)) bad.push(`seed ${seed} ${e.min}': 射手不在場上`);
        if (e.type === 'goal' && e.ownGoal && !oppSide.on.has(e.scorer)) bad.push(`seed ${seed} ${e.min}': 烏龍球的人不在對方場上`);
        if (e.type === 'card' && !side.on.has(e.player)) bad.push(`seed ${seed} ${e.min}': 拿牌的人不在場上`);
        if (e.type === 'card' && e.card === 'red') side.on.delete(e.player);
        if (e.type === 'sub') {
          if (!side.on.has(e.off) || !side.bench.has(e.on)) bad.push(`seed ${seed} ${e.min}': 換人不合法`);
          side.on.delete(e.off); side.on.add(e.on); side.bench.delete(e.on);
        }
        if (e.type === 'goal') mins.push(e.min);
      }
    }
  }
  out.push(['300 場:進球事件 = 比分 = 統計;射門 ≥ 進球;換人 ≤ 5 / 窗口 ≤ 3;場上人數 = 11 − 紅牌', bad.length === 0, bad.slice(0, 3).join(' | ')]);
  out.push(['300 場:射手、拿牌、換人的人在事件當下都在場上', !bad.some(b => /在場上|合法/.test(b)), bad.filter(b => /在場上|合法/.test(b)).slice(0, 2).join(' | ')]);
  const mh = goalsH / N, ma = goalsA / N;
  const seH = Math.sqrt(pred.xgHome / N), seA = Math.sqrt(pred.xgAway / N);
  out.push(['300 場平均進球在 λ 的 3 個標準誤內(無改動時抽樣分布 = 站上的 λ)', Math.abs(mh - pred.xgHome) < 3 * seH && Math.abs(ma - pred.xgAway) < 3 * seA, `${mh.toFixed(2)} vs ${pred.xgHome}、${ma.toFixed(2)} vs ${pred.xgAway}`]);
  const late = mins.filter(m => m > 45).length / Math.max(1, mins.length);
  out.push(['進球分鐘不是均勻的(下半場多於上半場,對得回側寫)', late > 0.5, `下半場 ${(late * 100).toFixed(0)}%`]);

  // 3. 決定性
  const e1 = JSON.stringify(play(42).events()), e2 = JSON.stringify(play(42).events());
  out.push(['同種子事件流逐字相同', e1 === e2]);

  // 4. 能力改機率:把 ARS 先發裡 xGI 最高的換成替補席裡最低的 → λ 下降;換陣型不改 λ
  {
    const t = profile.teams.ARS;
    const att = c => t.squad.find(p => p.code === c)?.ability?.att ?? 0;
    const best = [...t.xi].filter(c => t.squad.find(p => p.code === c).pos !== 'GK').sort((a, b) => att(b) - att(a))[0];
    const worst = [...t.bench].filter(c => t.squad.find(p => p.code === c).pos !== 'GK').sort((a, b) => att(a) - att(b))[0];
    const xi = t.xi.map(c => (c === best ? worst : c));
    const m = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed: 1, setup: { home: { xi, bench: t.bench.filter(c => c !== worst).concat(best) } } });
    const l = m.lambdas();
    /* 客隊的 λ 也會動 —— 換掉的人防守能力(Q_def)也不同,那是設計,不是 bug。 */
    out.push(['把先發裡 xGI 最高的換成替補裡最低的 → 主隊 λ 下降', l.home < pred.xgHome, `${l.home.toFixed(3)} < ${pred.xgHome};客隊 ${l.away.toFixed(3)}(隨防守能力變)`]);
    m.setFormation('home', '3-5-2');
    out.push(['改陣型不改 λ(沒有資料支撐陣型係數)', m.lambdas().home === l.home]);
    // 賽中換人:第 60 分換,λ 從那一刻起變
    const m3 = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed: 3, setup: { home: { subs: [] } } });
    while (m3.state().min < 60) m3.tick();
    const before = m3.lambdas().home;
    const r = m3.substitute('home', best, worst);
    out.push(['賽中換人成功並從那一刻起改 λ', r.ok === true && m3.lambdas().home < before, r.error ?? '']);
    const r2 = m3.substitute('home', worst, best);
    out.push(['已下場的人不能再換上來(替補席沒有他)', r2.ok === false]);
  }

  // 5. 紅牌:λ 有效值乘 RED 常數(跟 inPlaySim 同組)
  {
    let found = null;
    for (let seed = 1; seed <= 600 && !found; seed++) {
      const m = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed });
      while (!m.state().finished) {
        const evs = m.tick();
        if (evs.some(e => e.type === 'card' && e.card === 'red')) { found = { m, seed }; break; }
      }
    }
    if (!found) out.push(['600 顆種子裡至少一場紅牌(紅牌率 0.12/場)', false]);
    else {
      const s = found.m.state();
      const side = s.home.red ? s.home : s.away, other = s.home.red ? s.away : s.home;
      const R = found.m.rules;
      out.push(['紅牌後:被罰隊 λ 有效值 = λ × 0.72,對手 × 1.30(與 inPlaySim 同組)',
        Math.abs(side.lambdaEff - Math.round(side.lambda * R.RED_OWN * 100) / 100) <= 0.011 && Math.abs(other.lambdaEff - Math.round(other.lambda * R.RED_OPP * 100) / 100) <= 0.011,
        `seed ${found.seed}:${side.lambda}→${side.lambdaEff}、${other.lambda}→${other.lambdaEff}`]);
      out.push(['紅牌後場上剩 10 人且 Q 不重複扣', side.onPitch.length === 10 && side.ratioAtt === 1]);
    }
  }

  // 6. 控球目標在 [20,80]
  const pt = [...Array(50)].map((_, i) => mod.createMatch({ profile, home: 'SUN', away: 'MCI', pred, seed: i + 1 }).possTarget);
  out.push(['控球目標在 20–80 之間,且弱隊主場對強隊平均低於 50', pt.every(p => p >= 20 && p <= 80) && pt.reduce((a, b) => a + b, 0) / pt.length < 50, `平均 ${(pt.reduce((a, b) => a + b, 0) / pt.length).toFixed(1)}`]);
  return out;
}
