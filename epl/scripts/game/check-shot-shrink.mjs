// 射門預算的主客失射要不要往聯盟平均收(2026-10-09):用真實 FotMob 逐場射門回測,不跑引擎。
// 做法:按日期依序,每場用「賽前」的主客 sf / sa(各 n 場)預測兩隊射門(跟引擎的 expShots 同一條式子),
// k = 假想場數,x̂ = (n·x + k·聯盟主客平均) ÷ (n + k);k = 0 是現況(原始主客平均)。看平方誤差與 k = 0 的成對差 ± SE。
// 用法:node scripts/game/check-shot-shrink.mjs(不進 npm test;引用就重跑)
import fs from 'node:fs';
const load=f=>Object.values(JSON.parse(fs.readFileSync(new URL('../../data/raw/fotmob-epl/'+f,import.meta.url),'utf8')).matches).filter(m=>m.teamStats?.[m.home]?.shots!=null&&m.teamStats?.[m.away]?.shots!=null).sort((a,b)=>a.date<b.date?-1:1);
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
function run(games,k,mode){
  const T={}; const get=c=>T[c]??={h:{sf:0,sa:0,n:0},a:{sf:0,sa:0,n:0}};
  let lh={s:0,n:0},la={s:0,n:0}; const errs=[];
  for(const g of games){
    const H=get(g.home),A=get(g.away);
    const lgH=lh.n?lh.s/lh.n:12.5, lgA=la.n?la.s/la.n:10.5, lgAll=(lgH+lgA)/2;
    const sh=(t,v,stat)=>{ // shrunk venue mean of team t
      const o=t[v], lgv=stat==='sf'?(v==='h'?lgH:lgA):(v==='h'?lgA:lgH);
      const allN=t.h.n+t.a.n; let m=lgv;
      if(mode==='team'&&allN){ const all=(t.h[stat]+t.a[stat])/allN; m=all*(lgv/lgAll);} 
      return (o[stat]+k*m)/(o.n+k||1);
    };
    const nmin=Math.min(H.h.n,H.a.n,A.h.n,A.a.n);
    const pH=sh(H,'h','sf')*sh(A,'a','sa')/lgH, pA=sh(A,'a','sf')*sh(H,'h','sa')/lgA;
    const aH=g.teamStats[g.home].shots,aA=g.teamStats[g.away].shots;
    if(nmin>=0&&(H.h.n+A.a.n)>0) errs.push({e:(pH-aH)**2+(pA-aA)**2, small:Math.min(H.h.n,A.a.n)<=4});
    H.h.sf+=aH;H.h.sa+=aA;H.h.n++;A.a.sf+=aA;A.a.sa+=aH;A.a.n++;lh.s+=aH;lh.n++;la.s+=aA;la.n++;
  }
  return errs;
}
for (const f of ['2025-26-game-details.json','2026-27-game-details.json']){
  const G=load(f); console.log('==',f,G.length,'場');
  const base=run(G,0,'league');
  for (const mode of ['league','team']) for (const k of [0,2,4,8]) {
    const r=run(G,k,mode); const d=r.map((x,i)=>x.e-base[i].e);
    const sm=r.map((x,i)=>x.small?x.e-base[i].e:null).filter(v=>v!=null);
    const se=a=>Math.sqrt(a.reduce((s,x)=>s+(x-mean(a))**2,0)/(a.length-1)/a.length);
    console.log(mode.padEnd(7),'k',k,'全部 MSE',mean(r.map(x=>x.e)).toFixed(2),'與 k=0 之差',mean(d).toFixed(3),'±',se(d).toFixed(3),'| 小樣本(n≤4)',sm.length,'場 差',mean(sm).toFixed(3),'±',se(sm).toFixed(3));
  }
}
