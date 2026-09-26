/* 賽季模擬的名額不變量(測試用;2026-09-26)。

   每一個「落在某幾名」的機率,都要等於同一列 posDist 那幾名的加總 —— 兩個是同一次模擬數出來的,
   對不上就是**數錯了名額**。實際被咬到的兩次:
   - 德甲法甲的「降級」一直是「後 3 名」的機率(模擬寫死 `pos >= n - 2`),
     而那兩個聯賽只有後 2 名直接降級、第 16 名打跨聯賽附加賽;資料界線寫的卻是「直接降級」。
   - 英冠的「附加賽區」印的是 top6Pct —— 含直升的前 2 名,標題寫的是「第 3~6 名」。
   兩次都不拋錯、畫面完全正常,只是數字在講另一件事。

   名額是**呼叫端(各聯賽的測試)自己講的**,不從產物讀:那是這個聯賽的事實,
   測試要獨立講一次,產物跟著錯的時候才抓得到。

   posDist 每一格各自四捨五入到 0.1,所以容差隨格數放寬(每格 ±0.05,再加機率本身的 ±0.05)。 */
export function simZoneIssues(sim, { relegated, relegationPlayoff = false, promotion = null, promotionPlayoff = null }) {
  const issues = [];
  if (!Array.isArray(sim) || !sim.length) return ['沒有模擬結果'];
  if (!Number.isInteger(relegated)) return [`測試沒有講這個聯賽直接降級幾名(relegated = ${relegated})`];
  const n = sim.length;
  const sum = (p, from, to) => p.slice(from, to).reduce((a, b) => a + b, 0);   // 第 from+1 ~ to 名
  const near = (a, b, cells) => typeof a === 'number' && Math.abs(a - b) <= 0.05 * cells + 0.05 + 1e-9;
  for (const r of sim) {
    const p = r.posDist;
    if (!Array.isArray(p) || p.length !== n) { issues.push(`${r.code} posDist 長度 ${p?.length} ≠ ${n} 隊`); continue; }
    const bottom = sum(p, n - relegated, n);
    if (!near(r.relegationPct, bottom, relegated)) {
      issues.push(`${r.code} 降級 ${r.relegationPct}% ≠ 落在後 ${relegated} 名的 ${bottom.toFixed(1)}%`);
    }
    if (relegationPlayoff) {
      const at = p[n - relegated - 1];
      if (!near(r.relegationPlayoffPct, at, 1)) issues.push(`${r.code} 降級附加賽 ${r.relegationPlayoffPct}% ≠ 落在第 ${n - relegated} 名的 ${at}%`);
    } else if ('relegationPlayoffPct' in r) {
      issues.push(`${r.code} 這個聯賽沒有降級附加賽,卻有 relegationPlayoffPct`);
    }
    if (promotion) {
      const top = sum(p, 0, promotion);
      if (!near(r.promotionPct, top, promotion)) issues.push(`${r.code} 直升 ${r.promotionPct}% ≠ 落在前 ${promotion} 名的 ${top.toFixed(1)}%`);
    } else if ('promotionPct' in r) {
      issues.push(`${r.code} 這個聯賽沒有直升,卻有 promotionPct`);
    }
    if (promotionPlayoff) {
      const zone = sum(p, promotion, promotionPlayoff);
      if (!near(r.playoffPct, zone, promotionPlayoff - promotion)) {
        issues.push(`${r.code} 附加賽區 ${r.playoffPct}% ≠ 落在第 ${promotion + 1}~${promotionPlayoff} 名的 ${zone.toFixed(1)}%`);
      }
    } else if ('playoffPct' in r) {
      issues.push(`${r.code} 這個聯賽沒有升級附加賽,卻有 playoffPct`);
    }
  }
  /* 每一名一定剛好有一隊,所以「落在後 N 名」的機率全隊加總 = 100 × N。
     逐列對得上而加總對不上的情況不會發生 —— 這一條守的是 posDist 本身沒有漏隊或重複。 */
  const total = k => sim.reduce((a, r) => a + (r[k] ?? 0), 0);
  const tol = 0.05 * n + 0.2;
  const expect = [['relegationPct', 100 * relegated, '降級']];
  if (relegationPlayoff) expect.push(['relegationPlayoffPct', 100, '降級附加賽']);
  if (promotion) expect.push(['promotionPct', 100 * promotion, '直升']);
  if (promotionPlayoff) expect.push(['playoffPct', 100 * (promotionPlayoff - promotion), '附加賽區']);
  for (const [k, want, zh] of expect) {
    const got = total(k);
    if (Math.abs(got - want) > tol) issues.push(`${zh}機率全隊加總 ${got.toFixed(1)}% ≠ ${want}%`);
  }
  return issues;
}
