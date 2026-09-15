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
    /* 關掉自動換人(subs: [])—— 換人本來就會改 Q,紅牌前先換過人的話 ratioAtt ≠ 1 是設計,
       不是重複扣。CI 上第一個出紅牌的種子剛好紅牌前換過人,這條就紅了(2026-09-03),
       而本機的第一個種子沒換過,所以本機綠。要驗的是「紅牌本身不動 Q」,就把另一個會動 Q 的東西關掉。 */
    for (let seed = 1; seed <= 600 && !found; seed++) {
      const m = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed, setup: { home: { subs: [] }, away: { subs: [] } } });
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
      out.push(['紅牌後場上人數 = 11 − 紅牌,且 Q 不因紅牌而變(沒換人時 ratio = 1)', side.onPitch.length === 11 - side.red && side.ratioAtt === 1 && side.ratioDef === 1, `seed ${found.seed}:${side.onPitch.length} 人、紅 ${side.red}、ratioAtt ${side.ratioAtt}`]);
    }
  }

  // 7. 回合制(2026-09-15):結局的比例對得回該隊的率、每一筆回合內的事件都掛在回合上、碰球的人都在場上
  {
    const N2 = 200;
    const sum = { home: { shots: 0, corners: 0, fouls: 0, offsides: 0 }, away: { shots: 0, corners: 0, fouls: 0, offsides: 0 } };
    let seqsTot = 0, bip = 0, noSeq = [], notOn = [], lastIsActor = 0, ends = 0;
    for (let seed = 1; seed <= N2; seed++) {
      const m = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed });
      while (!m.state().finished) {
        const q = m.nextSequence();
        if (!q) break;
        seqsTot++; bip += q.dur;
        /* 對「這一回合產生之後」的名單:自動換人在 nextSequence 的開頭做,回合結束時的快照比它舊。
           回合裡被罰下的人(對手犯規那一方不在傳球串裡,所以只有極少數)也算在場上過。 */
        const onAfter = new Set(m.state()[q.side].onPitch);
        for (const c of q.chain) if (!onAfter.has(c) && !q.events.some(e => e.type === 'card' && e.card === 'red' && e.player === c)) notOn.push(`seed ${seed} 回合 ${q.id}: ${c} 不在場上`);
        if (q.end && ['shot', 'corner', 'foul', 'out', 'loose', 'offside'].includes(q.end.type)) { ends++; if (q.chain[q.chain.length - 1] === q.end.player) lastIsActor++; }
        for (const e of q.events) if (e.seq !== q.id) noSeq.push(`seed ${seed}: ${e.type} 掛錯回合`);
      }
      const s = m.state();
      for (const side of ['home', 'away']) { sum[side].shots += s[side].stats.shots; sum[side].corners += s[side].stats.corners; sum[side].fouls += s[side].stats.fouls; sum[side].offsides += s[side].stats.offsides; }
      for (const e of m.events()) if (['shot', 'goal', 'corner', 'foul', 'card', 'offside'].includes(e.type) && e.seq == null) noSeq.push(`seed ${seed}: ${e.type} 沒有 seq`);
    }
    /* 期望值直接從側寫算(不經引擎):射門 = 我方射門率 × 對手被射門率 / 聯盟均;角球同理;犯規 = 對手犯規率與我方被犯規率的平均;越位 = 該隊逐場越位。 */
    const L = profile.league_, A = profile.teams.ARS, V = profile.teams.LIV;
    const exp = {
      home: { shots: A.rates.home.sf * V.rates.away.sa / L.rates.sf, corners: A.rates.home.cf * V.rates.away.ca / L.rates.cf, fouls: (A.rates.home.fouls + V.rates.away.foulsAgainst) / 2, offsides: A.play.home.offsides },   // stats.fouls 是自己犯的:自己的犯規率 + 對手被犯規率(跟引擎 foulsBy 同定義;第一版寫反,兩隊差不多所以沒紅)
      away: { shots: V.rates.away.sf * A.rates.home.sa / L.rates.sf, corners: V.rates.away.cf * A.rates.home.ca / L.rates.cf, fouls: (V.rates.away.fouls + A.rates.home.foulsAgainst) / 2, offsides: V.play.away.offsides },
    };
    const within = (k, tol) => ['home', 'away'].every(sd => Math.abs(sum[sd][k] / N2 - exp[sd][k]) <= Math.max(tol * exp[sd][k], 3 * Math.sqrt(exp[sd][k] / N2)));
    const fmt = k => ['home', 'away'].map(sd => `${(sum[sd][k] / N2).toFixed(2)} vs ${exp[sd][k].toFixed(2)}`).join('、');
    out.push(['回合結局的射門數對回該隊的射門率(200 場均值,差 < 10% 或 3 個標準誤)', within('shots', 0.10), fmt('shots')]);
    out.push(['回合結局的角球數對回角球率', within('corners', 0.12), fmt('corners')]);
    out.push(['回合結局的犯規數對回犯規率', within('fouls', 0.12), fmt('fouls')]);
    out.push(['回合結局的越位數對回越位率', within('offsides', 0.25), fmt('offsides')]);
    out.push(['每隊每場約 100 個回合、球在場上約 57 分鐘(遊戲規則,回合長度由控球目標分配)', Math.abs(seqsTot / N2 - 2 * m0.rules.SEQ_PER_TEAM) < 25 && Math.abs(bip / N2 / 60 - m0.rules.BIP_SEC / 60) < 8, `${(seqsTot / N2).toFixed(0)} 回合・${(bip / N2 / 60).toFixed(1)} 分`]);
    out.push(['回合內的事件都掛在那個回合上(seq),射門 / 角球 / 犯規 / 牌 / 越位一筆都不例外', noSeq.length === 0, noSeq.slice(0, 2).join(' | ')]);
    out.push(['回合裡碰球的人都在場上', notOn.length === 0, notOn.slice(0, 2).join(' | ')]);
    out.push(['結局的人就是傳球串的最後一個(畫面照這個人演)', lastIsActor === ends, `${lastIsActor}/${ends}`]);
  }

  // 8. 戰術指令(階段 B):只改回合的組成,λ 一個都不變;改了方向要對;預設 = 側寫的級
  {
    const runN = (n, setup, home = 'ARS') => {
      const agg = { shots: 0, corners: 0, fouls: 0, offsides: 0, oppOffsides: 0, oppShots: 0, goals: 0, oppGoals: 0, chain: 0, seqs: 0, turnX: 0, turnN: 0 };
      for (let seed = 1; seed <= n; seed++) {
        const m = mod.createMatch({ profile, home, away: 'LIV', pred, seed, setup });
        while (!m.state().finished) { const q = m.nextSequence(); if (!q) break; if (q.side === 'home') { agg.chain += q.chain.length; agg.seqs++; if (q.end.type === 'turnover') { agg.turnX += q.end.x; agg.turnN++; } } }
        const st = m.state();
        agg.shots += st.home.stats.shots; agg.corners += st.home.stats.corners; agg.fouls += st.home.stats.fouls; agg.offsides += st.home.stats.offsides;
        agg.oppOffsides += st.away.stats.offsides; agg.oppShots += st.away.stats.shots; agg.goals += st.score[0]; agg.oppGoals += st.score[1];
      }
      for (const k of Object.keys(agg)) agg[k] /= n;
      agg.chainPerSeq = agg.chain / agg.seqs; agg.turnXMean = agg.turnX / Math.max(1e-9, agg.turnN);
      return agg;
    };
    const N3 = 150;
    const base = runN(N3, {});
    const m0t = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed: 1 });
    const d0 = m0t.tactics();
    out.push(['戰術指令的預設 = 側寫推的那一級(六軸都有,1~5)', mod.TACTIC_KEYS.every(k => d0.home.levels[k] === profile.teams.ARS.style[k].level && d0.home.levels[k] >= 1 && d0.home.levels[k] <= 5 && d0.home.levels[k] === d0.home.defaults[k]), JSON.stringify(d0.home.levels)]);
    const extreme = { home: { tactics: { mentality: 5, pressing: 5, line: 5, width: 5, tempo: 5, directness: 5 } }, away: { tactics: { mentality: 1, pressing: 1, line: 1, width: 1, tempo: 1, directness: 1 } } };
    const mx = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed: 1, setup: extreme });
    out.push(['指令拉到極端,λ 一個都不變(指令不進進球機率)', mx.lambdas().home === pred.xgHome && mx.lambdas().away === pred.xgAway, `${mx.lambdas().home}/${mx.lambdas().away}`]);
    const ex = runN(N3, extreme);
    const seH = Math.sqrt(pred.xgHome / N3), seA = Math.sqrt(pred.xgAway / N3);
    out.push(['指令拉到極端,150 場平均進球仍在 λ 的 3 個標準誤內(射門變多,轉換率跟著調回來)', Math.abs(ex.goals - pred.xgHome) < 3 * seH && Math.abs(ex.oppGoals - pred.xgAway) < 3 * seA, `${ex.goals.toFixed(2)} vs ${pred.xgHome}、${ex.oppGoals.toFixed(2)} vs ${pred.xgAway}`]);
    /* 方向測試要拿**預設在低檔**的隊(SUN:心態 1、壓迫 2、防線 2、節奏 1、直接度 2),全部拉到 5 才有位移。
       第一版拿 ARS(心態與壓迫的預設已經是 5),拉到 5 是 Δ = 0,射門反而因為對手心態拉低而變少 —— 測的不是想測的東西。 */
    /* 第二版(側寫換直接指標之後 SUN 的寬度預設變了,Δ 又是 0):對照組直接指定 —— 全 1 對全 5,Δ 差 4,跟預設在哪無關 */
    const lowAll = { home: { tactics: { mentality: 1, pressing: 1, line: 1, width: 1, tempo: 1, directness: 1 } } };
    const upAll = { home: { tactics: { mentality: 5, pressing: 5, line: 5, width: 5, tempo: 5, directness: 5 } } };
    const baseS = runN(N3, lowAll, 'SUN'), exS = runN(N3, upAll, 'SUN');
    const up = (a, b) => a > b * 1.03;
    const dirs = [
      ['心態進攻 → 射門變多(全 1 對全 5)', up(exS.shots, baseS.shots), `${exS.shots.toFixed(2)} vs ${baseS.shots.toFixed(2)}`],
      ['寬度拉寬 → 角球變多', up(exS.corners, baseS.corners), `${exS.corners.toFixed(2)} vs ${baseS.corners.toFixed(2)}`],
      ['壓迫拉高 → 自己犯規變多', up(exS.fouls, baseS.fouls), `${exS.fouls.toFixed(2)} vs ${baseS.fouls.toFixed(2)}`],
      ['防線拉高 → 對手越位變多', up(exS.oppOffsides, baseS.oppOffsides), `${exS.oppOffsides.toFixed(2)} vs ${baseS.oppOffsides.toFixed(2)}`],
      ['直接 + 快 → 傳球串變短', exS.chainPerSeq < baseS.chainPerSeq * 0.9, `${exS.chainPerSeq.toFixed(2)} vs ${baseS.chainPerSeq.toFixed(2)}`],
      ['壓迫拉高 → 對手被斷球的位置更靠自己後場', (() => {
        /* 對手(LIV)的斷球位置在 LIV 的進攻座標裡;SUN 壓迫高,LIV 應該在更後面(x 更小)丟球。runN 只記主隊的,這裡另外數 */
        const meanX = setup => { let sx = 0, n = 0; for (let seed = 1; seed <= 60; seed++) { const m = mod.createMatch({ profile, home: 'SUN', away: 'LIV', pred, seed, setup }); while (!m.state().finished) { const q = m.nextSequence(); if (!q) break; if (q.side === 'away' && q.end.type === 'turnover' && q.start.type !== 'corner' && q.start.type !== 'freekick') { sx += q.end.x; n++; } } } return sx / n; };
        const a = meanX(lowAll), b = meanX(upAll); return b < a - 3;
      })()],
    ];
    for (const [label, ok, detail] of dirs) out.push([label, ok, detail]);
    // 賽中改:下一個回合起生效,而且回傳現在的級與預設級
    const m3 = mod.createMatch({ profile, home: 'ARS', away: 'LIV', pred, seed: 5 });
    while (m3.state().min < 30) m3.tick();
    const r = m3.setTactics('home', { pressing: 5, bogus: 9, width: 0 });
    out.push(['賽中改指令:只收 1~5 的整數,回傳現在的級與預設', r.levels.pressing === 5 && r.levels.width === d0.home.defaults.width && m3.lambdas().home === pred.xgHome, JSON.stringify(r.levels)]);
  }

  // 6. 控球目標在 [20,80]
  const pt = [...Array(50)].map((_, i) => mod.createMatch({ profile, home: 'SUN', away: 'MCI', pred, seed: i + 1 }).possTarget);
  out.push(['控球目標在 20–80 之間,且弱隊主場對強隊平均低於 50', pt.every(p => p >= 20 && p <= 80) && pt.reduce((a, b) => a + b, 0) / pt.length < 50, `平均 ${(pt.reduce((a, b) => a + b, 0) / pt.length).toFixed(1)}`]);
  return out;
}
