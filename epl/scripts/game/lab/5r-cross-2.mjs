import { readFileSync, writeFileSync } from 'node:fs';
const [,, p] = process.argv;
let s = readFileSync(p, 'utf8');
const rep = (o, n) => { if (s.split(o).length !== 2) throw new Error('anchor: ' + o.slice(0, 80)); s = s.replace(o, () => n); };
rep(`    ball.shot = { dist: dGoal, head: true, by: p, side: p.side, xg, willScore: !miss, sit: 'FromCorner', assist };
    if (!miss) st.willScore++;
    st.shots++; st.shotsBy[p.side]++;
    st.shotSit.FromCorner = (st.shotSit.FromCorner ?? 0) + 1;
    st.shotHead++;
    st.cornerShot.header = (st.cornerShot.header ?? 0) + 1;
    st.cornerShotBins.header[Math.min(6, Math.floor(dGoal / 5))]++;
    st.cornerShotXg.header += xg;
    noteShotDist('FromCorner', dGoal);`, `    ball.shot = { dist: dGoal, head: true, by: p, side: p.side, xg, willScore: !miss, sit, assist };
    if (!miss) st.willScore++;
    st.shots++; st.shotsBy[p.side]++;
    st.shotSit[sit] = (st.shotSit[sit] ?? 0) + 1;
    st.shotHead++;
    if (sit === 'FromCorner') {                // 角球那幾個帳只記角球(5r 之後頭球也可能是運動戰傳中來的)
      st.cornerShot.header = (st.cornerShot.header ?? 0) + 1;
      st.cornerShotBins.header[Math.min(6, Math.floor(dGoal / 5))]++;
      st.cornerShotXg.header += xg;
    }
    noteShotDist(sit, dGoal);`);
rep(`    emit({ type: 'shot', side: p.side, player: p.code, name: p.name, xg, dist: Math.round(dGoal * 10) / 10, sit: 'FromCorner', inBox: inBoxAt(p.x, p.y, goalX) });`,
    `    emit({ type: 'shot', side: p.side, player: p.code, name: p.name, xg, dist: Math.round(dGoal * 10) / 10, sit, inBox: inBoxAt(p.x, p.y, goalX) });`);
rep(`    noteShotBox(p, 'FromCorner');              // 階段 5h`, `    noteShotBox(p, sit);                       // 階段 5h`);
// counts 出口
rep(`        gkSaves: st.gkSaves ?? 0, gkBeaten: st.gkBeaten ?? 0,`, `        gkSaves: st.gkSaves ?? 0, gkBeaten: st.gkBeaten ?? 0,
        cross: { ...st.cross }, crossOk: { ...st.crossOk }, crossHead: { ...st.crossHead }, crossDuel: st.crossDuel ?? 0, crossBlock: st.crossBlock ?? 0,`);
writeFileSync(p, s); console.log('ok2');
