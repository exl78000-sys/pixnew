import { readFileSync, writeFileSync } from 'node:fs';
const [,, p] = process.argv;
let s = readFileSync(p, 'utf8');
const rep = (o, n) => { if (s.split(o).length !== 2) throw new Error('anchor: ' + o.slice(0, 80)); s = s.replace(o, () => n); };
rep(`  const FOUL_LG = profile.league_?.rates?.fouls ?? null;`, `  const FOUL_LG = profile.league_?.rates?.fouls ?? null;
  /* 傳中的逐隊倍率(5r):這一隊的真實 \`accurate_crosses\` ÷ 聯盟平均(以場數加權,從同一份側寫算 —— 寫死會過期)。
     跟犯規 / 抄截同一個做法:只取方向與幅度,夾在 [0.5, 2](升班馬只有幾場)。側寫沒有就是 1。 */
  const CROSS_LG = (() => {
    let s = 0, n = 0;
    for (const t of Object.values(profile.teams ?? {})) { const x = t.extra?.accurate_crosses; if (x?.mean != null && x.n) { s += x.mean * x.n; n += x.n; } }
    return n ? s / n : null;
  })();`);
rep(`keep, foulRel, tklRel, drbRel, aerRel, relMean,`, `keep, foulRel, tklRel, drbRel, aerRel, relMean,
      crossRel: CROSS_LG && t.extra?.accurate_crosses?.mean != null ? cl(t.extra.accurate_crosses.mean / CROSS_LG, 0.5, 2) : 1,`);
rep(`      if (tg.length && rng() < CROSS_URGE) {`, `      if (tg.length && rng() < cl(CROSS_URGE * (s.crossRel ?? 1), 0, 0.95)) {`);
writeFileSync(p, s); console.log('crossrel ok');
